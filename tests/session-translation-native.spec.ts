import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { createSessionTranslationService } from '../data/build/dist/host/features/session-translation-service.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS } from '../data/build/dist/shared/contracts/session-translation.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'
import type { CodingNsSettings } from '../src/shared/contracts/config.js'

type LlmListener = (options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>
type PreStepListener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

interface Harness {
  readonly features: FeatureRegistry
  readonly registry: CodingNsCliAdapterRegistry
  readonly requests: readonly Record<string, unknown>[]
  readonly table: CodingNsRpcTable
  readonly llmListener: LlmListener
  readonly preStepListener: PreStepListener
}

/** DSH 原生会话的会话翻译测试台：只有一个空驱动注册表与最小原生会话替身。 */
function createHarness(options: {
  readonly translation: Record<string, unknown>
  readonly header?: Record<string, unknown>
  readonly sessionId?: string
  readonly translationEnabled?: boolean
  readonly adapterId?: 'dsh' | 'codex'
  readonly executions?: Record<string, unknown>[]
  readonly attachmentPath?: string
  /** 缺省表示会话从未单独设置过开关，此时跟随总开关。 */
  readonly sessionTranslationEnabled?: boolean
}): Harness {
  const table = new CodingNsRpcTable()
  let llmListener: LlmListener | undefined
  let preStepListener: PreStepListener | undefined
  const registry = new CodingNsCliAdapterRegistry(options.adapterId !== 'codex' ? [] : [{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: 'test', command: 'fake-codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) { options.executions?.push(input as unknown as Record<string, unknown>); yield { type: 'finish' as const, reason: 'stop' as const } },
  }])
  const events = {
    on(_name: string, listener: LlmListener) {
      llmListener = listener
      return () => { llmListener = undefined }
    },
  }
  const dshContext = {
    get(name: string) { return name === 'attachments' && options.attachmentPath !== undefined ? { fileHostPath: () => options.attachmentPath } : undefined },
    on(name: string, listener: PreStepListener) {
      if (name === 'agent/pre-step') preStepListener = listener
      return () => undefined
    },
  }
  const nativeSessions = {
    available: true,
    store: undefined,
    controller: undefined,
    get() { return { header: options.header ?? { cwd: '/workspace' } } },
    list() { return [] },
    async ensure() { return null },
    async flush() {},
    appendRequestContext() { return true },
    injectNextStep() { return true },
    subscribe() { return () => {} },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    dshContext: dshContext as never,
    nativeSessions: nativeSessions as never,
    sessionTranslation: options.translation as never,
  })
  features.register(createCliAdaptersFeature({ registry }))
  const requests = (options.translation as { requests?: Record<string, unknown>[] }).requests ?? []
  const sessionId = options.sessionId ?? 'native-session'
  // `translationEnabled` 显式给出时优先；否则用 sessionTranslationEnabled（undefined 表示跟随总开关）。
  const sessionTranslationEnabled = 'translationEnabled' in options ? options.translationEnabled : options.sessionTranslationEnabled
  return {
    features,
    registry,
    requests,
    table,
    get llmListener() {
      assert.notEqual(llmListener, undefined, 'llm/stream 监听器必须已注册')
      return llmListener!
    },
    get preStepListener() {
      assert.notEqual(preStepListener, undefined, 'agent/pre-step 监听器必须已注册')
      return preStepListener!
    },
    async start() {
      await features.start('cliAdapters')
      registry.setSession(sessionId, {
        adapterId: options.adapterId ?? 'dsh',
        ...(sessionTranslationEnabled === undefined ? {} : { translationEnabled: sessionTranslationEnabled }),
      })
    },
  } as Harness & { start(): Promise<void> }
}

/** 具备可审计请求记录的翻译服务替身。 */
function createTranslation(options: {
  readonly inputLanguage?: string
  readonly outputLanguage?: string
  readonly nativeEnabled?: boolean
  readonly bilingual?: boolean
  readonly translateInput?: (text: string) => string
  readonly translateOutput?: (text: string, kind: string) => Record<string, unknown> | null
} = {}) {
  const requests: Record<string, unknown>[] = []
  const inputLanguage = options.inputLanguage ?? 'en'
  const outputLanguage = options.outputLanguage ?? 'zh'
  return {
    requests,
    enabled: true,
    inputLanguage,
    outputLanguage,
    nativeEnabled: options.nativeEnabled ?? true,
    bilingual: options.bilingual ?? false,
    activate() {},
    deactivate() {},
    configure() {},
    shouldTranslate(adapterId: string, kind: string, sessionEnabled?: boolean) {
      return sessionEnabled === true && adapterId === 'dsh' && (kind === 'assistant' || kind === 'reasoning')
    },
    async translateInput(_adapterId: string, text: string, _signal?: AbortSignal, sessionEnabled?: boolean) {
      requests.push({ kind: 'input', text, sessionEnabled })
      return options.translateInput === undefined ? text : options.translateInput(text)
    },
    async translateInputDetailed(adapterId: string, text: string, signal?: AbortSignal, sessionEnabled?: boolean) {
      requests.push({ kind: 'input', adapterId, text, sessionEnabled })
      const translated = options.translateInput === undefined ? text : options.translateInput(text)
      return {
        translated,
        sourceLanguage: 'zh',
        model: { provider: 'deepseek', model: 'deepseek-chat' },
        ...(translated === text ? { alreadyTargetLanguage: true } : {}),
      }
    },
    async translateOutput(adapterId: string, kind: string, text: string, _signal?: AbortSignal, sessionEnabled?: boolean) {
      requests.push({ kind: 'output', adapterId, outputKind: kind, text, sessionEnabled })
      if (options.translateOutput !== undefined) return options.translateOutput(text, kind)
      return {
        original: text,
        translated: `[${outputLanguage}]${text}`,
        sourceLanguage: 'en',
        targetLanguage: outputLanguage,
        bilingual: options.bilingual ?? false,
        model: { provider: 'deepseek', model: 'deepseek-chat' },
      }
    },
    dispose() {},
  }
}

test('file-only native submissions localize notices without sending file identity to the translation model', async () => {
  const path = '/tmp/中文 目录/报告 (最终).zip'
  for (const language of ['en', 'fr', 'de', 'ja', 'zh']) {
    const translation = createTranslation({ inputLanguage: language })
    const harness = createHarness({ translation, attachmentPath: path }) as Harness & { start(): Promise<void> }
    await harness.start()
    try {
      const file = { type: 'file', attachment: { attachmentId: 'sha256:file', name: '报告 (最终).zip' } }
      const message = { role: 'user', source: { kind: 'user' }, content: [file] }
      const decision = await harness.preStepListener({ agent: { id: 'native-session' }, messages: [message] }, async () => ({ kind: 'enter', messages: [message] })) as any
      const content = decision.messages[0].content
      assert.equal(content.some((part: any) => part.type === 'file'), false, 'DSH must not append a second English-only file notice')
      assert.deepEqual(message.content, [file], 'the original submission is unchanged')
      const text = content.find((part: any) => part.type === 'text').text
      assert.ok(text.includes(path))
      assert.ok(text.includes('报告 (最终).zip'))
      if (language !== 'zh') assert.doesNotMatch(text, /附件文件|请使用工具读取/u)
      assert.match(decision.messages[0].source.codingnsTranslationInput.original, /附件文件/u)
      assert.equal(translation.requests.length, 0, 'fixed attachment prose does not need an LLM request')
    } finally { await harness.features.disable('cliAdapters') }
  }
})

test('pre-step preserves downstream instructions inserted before the human message and translates their prose', async () => {
  const translation = createTranslation({ translateInput: text => text.replaceAll('中文描述', 'Translated description') })
  const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
  await harness.start()
  try {
    const user = { id: 'user', role: 'user', source: { kind: 'user' }, content: '中文描述' }
    const catalog = { id: 'catalog', role: 'user', source: { kind: 'skill-catalog', entries: [{ name: 'skill', description: '中文描述' }] }, content: '中文描述' }
    const instructions = { id: 'instructions', role: 'user', source: { kind: 'agent-instructions' }, content: '中文描述' }
    const decision = await harness.preStepListener({ agent: { id: 'native-session' }, messages: [user] }, async () => ({ kind: 'enter', messages: [instructions, user, catalog] })) as any
    assert.deepEqual(decision.messages.map((message: any) => message.id), ['instructions', 'user', 'catalog'])
    assert.equal(decision.messages[0].content, 'Translated description')
    assert.equal(decision.messages[0].source.kind, 'agent-instructions')
    assert.equal(decision.messages[1].source.codingnsTranslationInput.translated, 'Translated description')
    assert.equal(decision.messages[2].content, 'Translated description')
    assert.equal(instructions.content, '中文描述')
    assert.equal(catalog.content, '中文描述')
  } finally { await harness.features.disable('cliAdapters') }
})

test('native translation retains image payloads and unresolved file references', async () => {
  const translation = createTranslation({ translateInput: () => 'Read the attachments.' })
  const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
  await harness.start()
  try {
    const image = { type: 'image', attachment: { attachmentId: 'sha256:image', mediaType: 'image/png' } }
    const file = { type: 'file', attachment: { attachmentId: 'sha256:unresolved', name: '未知.txt' } }
    const user = { role: 'user', source: { kind: 'user' }, content: [image, file, { type: 'text', text: '读取附件' }] }
    const decision = await harness.preStepListener({ agent: { id: 'native-session' }, messages: [user] }, async () => ({ kind: 'enter', messages: [user] })) as any
    assert.deepEqual(decision.messages[0].content, [image, file, { type: 'text', text: 'Read the attachments.' }])
  } finally { await harness.features.disable('cliAdapters') }
})

test('external dispatch forwards the input language to late attachment formatters', async () => {
  const translation = createTranslation({ inputLanguage: 'fr' })
  const executions: Record<string, unknown>[] = []
  const harness = createHarness({ translation, adapterId: 'codex', translationEnabled: true, executions, attachmentPath: '/tmp/中文 文件.txt' }) as Harness & { start(): Promise<void> }
  await harness.start()
  try {
    const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: { attachmentId: 'sha256:file', name: '中文 文件.txt' } }] }
    for await (const _chunk of harness.llmListener({ sessionId: 'native-session', messages: [user] }, async function* () {})) { /* Inspect the captured driver input. */ }
    assert.equal(executions[0].translationLanguage, 'fr')
    assert.match(String(executions[0].prompt), /Fichier joint/u)
    assert.match(String(executions[0].prompt), /\/tmp\/中文 文件.txt/u)
  } finally { await harness.features.disable('cliAdapters') }
})

test('real Cordis middleware translates catalogs produced by previously registered after-next listeners', async () => {
  const ctx = new Context()
  const translation = createTranslation({ translateInput: text => text.replaceAll('中文描述', 'Translated description') })
  const catalog = { id: 'catalog', role: 'user', source: { kind: 'skill-catalog' }, content: '中文描述' }
  ctx.on('agent/pre-step' as never, (async (_payload: unknown, next: () => Promise<any>) => {
    const decision = await next()
    return { ...decision, messages: [...decision.messages, catalog] }
  }) as never)
  const registry = new CodingNsCliAdapterRegistry([])
  const features = new FeatureRegistry({ rpc: new CodingNsRpcTable(), dshContext: ctx as never, sessionTranslation: translation as never })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  try {
    registry.setSession('native-session', { adapterId: 'dsh', translationEnabled: true })
    const decision = await ctx.waterfall('agent/pre-step' as never, { agent: { id: 'native-session' }, messages: [] }, async () => ({ kind: 'enter', messages: [] })) as any
    assert.equal(decision.messages[0].content, 'Translated description')
    assert.equal(decision.messages[0].source.kind, 'skill-catalog')
  } finally { await features.disable('cliAdapters') }
})

test('DSH 原生会话在 pre-step 翻译请求，并把原文留在元数据里', async () => {
  const translation = createTranslation({ inputLanguage: 'en', translateInput: () => 'Please review this code' })
  const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
  await harness.start()

  const original = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查这段代码' }] }
  const decision = await harness.preStepListener({
    agent: { id: 'native-session' },
    messages: [original],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [original] })) as { kind: string; messages: readonly any[] }

  assert.equal(decision.kind, 'enter')
  // 发给 Provider 的正文是译文；DSH 会把它写入 user/message。
  assert.equal(decision.messages[0]?.content?.[0]?.text, 'Please review this code')
  const record = decision.messages[0]?.source?.codingnsTranslationInput
  assert.equal(record?.original, '请检查这段代码')
  assert.equal(record?.translated, 'Please review this code')
  assert.equal(record?.targetLanguage, 'en')
  assert.equal(record?.sourceLanguage, 'zh')
  // 原生消息必须保留用户身份，否则客户端不会渲染成用户气泡。
  assert.equal(decision.messages[0]?.source?.kind, 'user')
  await harness.features.disable('cliAdapters')
})

test('DSH 原生会话开关关闭时不改写 pre-step 消息', async () => {
  const translation = createTranslation({ translateInput: () => 'Please review this code' })
  const harness = createHarness({ translation, translationEnabled: false }) as Harness & { start(): Promise<void> }
  await harness.start()

  const original = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查这段代码' }] }
  const decision = await harness.preStepListener({
    agent: { id: 'native-session' },
    messages: [original],
  }, async () => ({ kind: 'enter', messages: [original] })) as { messages: readonly any[] }

  assert.equal(decision.messages[0]?.content?.[0]?.text, '请检查这段代码')
  assert.equal(decision.messages[0]?.source?.codingnsTranslationInput, undefined)
  assert.deepEqual(harness.requests, [])
  await harness.features.disable('cliAdapters')
})

test('pre-step holds a failed user message until retry, direct send, or cancellation is resolved through RPC', async () => {
  for (const choice of ['retry', 'send', 'cancel'] as const) {
    let attempts = 0
    const translation = { ...createTranslation(), async translateInputDetailed(_adapter: string, text: string) {
      attempts++
      return attempts === 1 ? { translated: text, failed: true } : { translated: 'Please review this code' }
    } }
    const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
    await harness.start()
    const rpc = async (action: string, payload: unknown): Promise<any> => {
      const target = harness.table.resolve(`cli/translation/${action}`)!
      return target.handler(target.action, payload)
    }
    const original = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查这段代码' }, { type: 'image', attachment: { attachmentId: 'image' } }] }
    let entered = false
    const pending = harness.preStepListener({ agent: { id: 'native-session' }, messages: [original] }, async () => {
      entered = true
      return { kind: 'enter', messages: [original] }
    }) as Promise<any>
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(entered, false, 'the agent must not receive a failed translation automatically')
      const [request] = await rpc('pending', { sessionId: 'native-session' })
      assert.ok(request)
      await rpc('resolve', { sessionId: 'native-session', id: request.id, choice })
      const result = await pending
      if (choice === 'cancel') {
        assert.equal(result.kind, 'reject')
        assert.equal(entered, false)
      } else {
        assert.equal(result.kind, 'enter')
        assert.equal(entered, true)
        assert.equal(result.messages[0].source.codingnsTranslationInput.original, '请检查这段代码')
        if (choice === 'send') assert.deepEqual(result.messages[0].content, original.content)
        else assert.equal(result.messages[0].content[0].text, 'Please review this code')
      }
      assert.equal(attempts, choice === 'retry' ? 2 : 1)
    } finally { await harness.features.disable('cliAdapters') }
  }
})

test('external agents receive only the chosen input and do not translate it a second time', async () => {
  for (const choice of ['retry', 'send', 'cancel'] as const) {
    let attempts = 0
    const executions: Record<string, unknown>[] = []
    const translation = { ...createTranslation(), async translateInputDetailed(_adapter: string, text: string) {
      return ++attempts === 1 ? { translated: text, failed: true } : { translated: 'Review the code' }
    } }
    const harness = createHarness({ translation, adapterId: 'codex', translationEnabled: true, executions }) as Harness & { start(): Promise<void> }
    await harness.start()
    try {
      const original = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '检查代码' }] }
      const pending = harness.preStepListener({ agent: { id: 'native-session' }, messages: [original] }, async () => ({ kind: 'enter', messages: [original] })) as Promise<any>
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(executions.length, 0)
      const poll = harness.table.resolve('cli/translation/pending')!
      const [request] = await poll.handler(poll.action, { sessionId: 'native-session' }) as any[]
      const resolve = harness.table.resolve('cli/translation/resolve')!
      await resolve.handler(resolve.action, { sessionId: 'native-session', id: request.id, choice })
      const decision = await pending
      if (choice === 'cancel') assert.equal(decision.kind, 'reject')
      else {
        assert.deepEqual(decision.messages[0].content, original.content, 'external history retains the original')
        for await (const _chunk of harness.llmListener({ sessionId: 'native-session', messages: decision.messages }, async function* () {})) {}
        assert.equal(executions.length, 1)
        assert.equal(executions[0]!.prompt, choice === 'retry' ? 'Review the code' : '检查代码')
      }
      assert.equal(attempts, choice === 'retry' ? 2 : 1)
    } finally { await harness.features.disable('cliAdapters') }
  }
})

test('原生会话没有单独设置时跟随总开关，显式关闭时覆盖总开关', async () => {
  // 总开关打开、会话没有单独设置：翻译生效。
  const following = createTranslation({ translateInput: () => 'Please review this code' })
  const followingHarness = createHarness({ translation: following, sessionTranslationEnabled: undefined }) as Harness & { start(): Promise<void> }
  await followingHarness.start()
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查这段代码' }] }
  const followed = await followingHarness.preStepListener({
    agent: { id: 'native-session' },
    messages: [message],
  }, async () => ({ kind: 'enter', messages: [message] })) as { messages: readonly any[] }
  assert.equal(followed.messages[0]?.content?.[0]?.text, 'Please review this code')
  await followingHarness.features.disable('cliAdapters')

  // 总开关打开、会话显式关闭：会话级开关优先。
  const overridden = createTranslation({ translateInput: () => 'Please review this code' })
  const overriddenHarness = createHarness({ translation: overridden, translationEnabled: false }) as Harness & { start(): Promise<void> }
  await overriddenHarness.start()
  const kept = await overriddenHarness.preStepListener({
    agent: { id: 'native-session' },
    messages: [message],
  }, async () => ({ kind: 'enter', messages: [message] })) as { messages: readonly any[] }
  assert.equal(kept.messages[0]?.content?.[0]?.text, '请检查这段代码')
  assert.deepEqual(overridden.requests, [])
  await overriddenHarness.features.disable('cliAdapters')
})

test('DSH 原生会话的子代理与助理会话不参与翻译', async () => {
  const subagent = createTranslation({ translateInput: () => 'translated' })
  const subagentHarness = createHarness({
    translation: subagent,
    header: { cwd: '/workspace', origin: 'subagent' },
    sessionId: 'subagent-session',
  }) as Harness & { start(): Promise<void> }
  await subagentHarness.start()
  const subagentMessage = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查这段代码' }] }
  const subagentDecision = await subagentHarness.preStepListener({
    agent: { id: 'subagent-session' },
    messages: [subagentMessage],
  }, async () => ({ kind: 'enter', messages: [subagentMessage] })) as { messages: readonly any[] }
  assert.equal(subagentDecision.messages[0]?.content?.[0]?.text, '请检查这段代码')
  assert.deepEqual(subagent.requests, [])
  await subagentHarness.features.disable('cliAdapters')

  const assistant = createTranslation({ translateInput: () => 'translated' })
  const assistantHarness = createHarness({
    translation: assistant,
    sessionId: 'codingns-assistant-abc',
  }) as Harness & { start(): Promise<void> }
  await assistantHarness.start()
  const assistantMessage = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我总结' }] }
  const assistantDecision = await assistantHarness.preStepListener({
    agent: { id: 'codingns-assistant-abc' },
    messages: [assistantMessage],
  }, async () => ({ kind: 'enter', messages: [assistantMessage] })) as { messages: readonly any[] }
  assert.equal(assistantDecision.messages[0]?.content?.[0]?.text, '帮我总结')
  assert.deepEqual(assistant.requests, [])
  await assistantHarness.features.disable('cliAdapters')
})

test('disabled user translation preserves native and external submissions without translation metadata', async () => {
  for (const adapterId of ['dsh', 'codex']) {
    const translation = { ...createTranslation(), inputEnabled: false }
    const executions: any[] = []
    const harness = createHarness({ translation, adapterId, translationEnabled: true, executions, attachmentPath: '/tmp/中文 文件.txt' })
    await harness.start()
    try {
      const original = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查代码' }] }
      const decision = await harness.preStepListener({ agent: { id: 'native-session' }, messages: [original], turn: 1, step: 1 },
        async () => ({ kind: 'enter', messages: [original] })) as any
      assert.deepEqual(decision.messages, [original])
      if (adapterId === 'codex') {
        for await (const _chunk of harness.llmListener({ sessionId: 'native-session', messages: [original] }, async function* () {})) { /* Drain the provider stream. */ }
        assert.equal(executions[0].prompt, '请检查代码')
        assert.equal(executions[0].translationLanguage, undefined)
      }
      assert.deepEqual(translation.requests, [])
    } finally { await harness.features.disable('cliAdapters') }
  }
})

test('disabled native output categories stream unchanged while the other category is translated', async () => {
  for (const disabledKind of ['reasoning', 'assistant']) {
    const translation = createTranslation()
    translation.shouldTranslate = (_adapter, kind) => kind !== disabledKind
    const harness = createHarness({ translation })
    await harness.start()
    try {
      const chunks: any[] = []
      const originals: any[] = []
      for await (const chunk of harness.llmListener({ sessionId: 'native-session', messages: [] }, async function* () {
        for (const [index, kind] of ['reasoning', 'text'].entries()) {
          for (const text of ['Hello', ' world']) {
            const delta = { type: `${kind}-delta`, index, text }
            if ((kind === 'text' ? 'assistant' : kind) === disabledKind) originals.push(delta)
            yield delta
          }
          yield { type: 'block-end', index, block: { type: kind, text: 'Hello world' } }
        }
      })) chunks.push(chunk)
      const disabledIndex = disabledKind === 'reasoning' ? 0 : 1
      assert.deepEqual(chunks.filter(chunk => chunk.index === disabledIndex && chunk.type.endsWith('-delta')), originals)
      assert.ok(chunks.filter(chunk => chunk.index === disabledIndex).every(chunk => chunk.codingnsTranslation === undefined))
      assert.equal(translation.requests.length, 1)
      assert.equal(translation.requests[0]!.outputKind, disabledKind === 'reasoning' ? 'assistant' : 'reasoning')
    } finally { await harness.features.disable('cliAdapters') }
  }
})

test('native blocks keep their streaming mode when translation settings change mid-block', async () => {
  for (const initiallyEnabled of [true, false]) {
    let enabled = initiallyEnabled
    const translation = createTranslation({ translateOutput: text => enabled ? { original: text, translated: `[zh]${text}`, targetLanguage: 'zh', bilingual: false } : null })
    translation.shouldTranslate = () => enabled
    const harness = createHarness({ translation })
    await harness.start()
    try {
      const chunks: any[] = []
      for await (const chunk of harness.llmListener({ sessionId: 'native-session', messages: [] }, async function* () {
        yield { type: 'text-delta', index: 1, text: 'Hello' }
        enabled = !enabled
        yield { type: 'text-delta', index: 1, text: ' world' }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world' } }
      })) chunks.push(chunk)
      assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'Hello world')
      assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block, { type: 'text', text: 'Hello world' })
    } finally { await harness.features.disable('cliAdapters') }
  }
})

test('DSH 原生会话输出保留原文并挂上客户端译文记录', async () => {
  const translation = createTranslation({ outputLanguage: 'zh' })
  const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
  await harness.start()

  const chunks: any[] = []
  for await (const chunk of harness.llmListener({ sessionId: 'native-session', messages: [] }, async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'Check' }
    yield { type: 'reasoning-delta', index: 0, text: 'ing code' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Checking code' } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'text-delta', index: 1, text: 'Hello' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) chunks.push(chunk)

  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'block-start', 'reasoning-delta', 'block-end',
    'block-start', 'text-delta', 'block-end',
    'finish',
  ])
  const reasoning = chunks[1]
  assert.equal(reasoning.text, 'Checking code')
  assert.equal(reasoning.codingnsTranslation.original, 'Checking code')
  assert.equal(reasoning.codingnsTranslation.translated, '[zh]Checking code')
  assert.equal(reasoning.codingnsTranslation.outputKind, 'reasoning')
  const text = chunks[4]
  assert.equal(text.text, 'Hello')
  assert.equal(text.codingnsTranslation.outputKind, 'assistant')
  // DSH history keeps the provider text; the client renders the translated field.
  assert.equal(chunks[5].block.text, 'Hello')
  assert.equal(chunks[5].block.codingnsTranslation.original, text.codingnsTranslation.original)
  assert.equal(chunks[5].block.codingnsTranslation.translated, text.codingnsTranslation.translated)
  await harness.features.disable('cliAdapters')
})

test('DSH 原生会话输出翻译失败或流中断时补发原文', async () => {
  const failing = createTranslation({ translateOutput: () => { throw new Error('translation unavailable') } })
  const failingHarness = createHarness({ translation: failing }) as Harness & { start(): Promise<void> }
  await failingHarness.start()
  const failingChunks: any[] = []
  for await (const chunk of failingHarness.llmListener({ sessionId: 'native-session', messages: [] }, async function* () {
    yield { type: 'text-delta', index: 1, text: 'Hello' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) failingChunks.push(chunk)
  assert.deepEqual(failingChunks, [
    { type: 'text-delta', index: 1, text: 'Hello', codingnsTranslation: failingChunks[0].codingnsTranslation },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello', codingnsTranslation: failingChunks[0].codingnsTranslation }, codingnsTranslation: failingChunks[0].codingnsTranslation },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(failingChunks[0].codingnsTranslation.failed, true)
  assert.equal(failingChunks[0].codingnsTranslation.original, 'Hello')
  assert.equal(failingChunks[0].codingnsTranslation.outputKind, 'assistant')
  await failingHarness.features.disable('cliAdapters')

  const interrupted = createTranslation()
  const interruptedHarness = createHarness({ translation: interrupted }) as Harness & { start(): Promise<void> }
  await interruptedHarness.start()
  const interruptedChunks: any[] = []
  let streamError: unknown
  try {
    for await (const chunk of interruptedHarness.llmListener({ sessionId: 'native-session', messages: [] }, async function* () {
      yield { type: 'text-delta', index: 1, text: 'Partial answer' }
      throw new Error('provider stream failed')
    })) interruptedChunks.push(chunk)
  } catch (error) {
    streamError = error
  }
  // 已经生成的内容必须先补发原文，再把原始错误交给 DSH。
  assert.deepEqual(interruptedChunks, [
    { type: 'text-delta', index: 1, text: 'Partial answer' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Partial answer' } },
  ])
  assert.equal((streamError as Error)?.message, 'provider stream failed')
  await interruptedHarness.features.disable('cliAdapters')
})

test('DSH 原生会话默认关闭且会话未单独开启时逐块直通', async () => {
  const translation = createTranslation({ nativeEnabled: false })
  const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
  await harness.start()
  const passthrough: any[] = []
  for await (const chunk of harness.llmListener({ sessionId: 'native-session', messages: [] }, async function* () {
    yield { type: 'text-delta', index: 1, text: 'Hello' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) passthrough.push(chunk)
  assert.deepEqual(passthrough, [
    { type: 'text-delta', index: 1, text: 'Hello' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(harness.requests, [])
  await harness.features.disable('cliAdapters')
})

test('原生会话显式开启时，输入和输出均覆盖默认关闭，并调用真实翻译服务', async () => {
  const requests: Record<string, unknown>[] = []
  const translation = createSessionTranslationService({
    llm: {
      listProviders: () => [{ id: 'native', name: 'Native' }],
      listModels: async () => [{ id: 'translator', name: 'Translator' }],
      stream: (options: Record<string, unknown>) => {
        requests.push(options)
        return (async function* () {
          yield { type: 'text-delta', text: JSON.stringify({ translation: requests.length === 1 ? 'Conversation test' : '用户正在测试对话。' }) }
          yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 5 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name: string) {
      return name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'native', model: 'translator' }) } : undefined
    },
  }, '0.2.1-alpha.2')!
  translation.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, nativeEnabled: false })
  translation.activate()
  const harness = createHarness({ translation: translation as never, translationEnabled: true }) as Harness & { start(): Promise<void> }
  await harness.start()
  try {
    // 会话附件中的用户正文与 source.kind；模拟 DSH 对消息及请求边界的冻结。
    const original = Object.freeze({ role: 'user', source: Object.freeze({ kind: 'user' }), content: Object.freeze([{ type: 'text', text: '对话测试' }]) })
    const decision = await harness.preStepListener({ agent: { id: 'native-session' }, messages: [original] }, async () => ({ kind: 'enter', messages: [original] })) as { messages: readonly any[] }
    assert.equal(decision.messages[0].content[0].text, 'Conversation test')
    assert.equal(decision.messages[0].source.codingnsTranslationInput.original, '对话测试')
    assert.equal(decision.messages[0].source.codingnsTranslationInput.totalTokens, 35)
    assert.ok(decision.messages[0].source.codingnsTranslationInput.durationMs >= 0)
    assert.equal(original.content[0].text, '对话测试')
    const output: any[] = []
    for await (const chunk of harness.llmListener(Object.freeze({ sessionId: 'native-session', provider: 'native', model: 'translator', messages: decision.messages }), async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'The user is testing the conversation.' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user is testing the conversation.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })) output.push(chunk)
    assert.equal(requests.length, 2, '会话开启必须同时执行输入和输出翻译')
    assert.equal(output.find((chunk) => chunk.type === 'reasoning-delta')?.text, 'The user is testing the conversation.')
    assert.equal(output.find((chunk) => chunk.type === 'block-end')?.block.codingnsTranslation.original, 'The user is testing the conversation.')
    assert.equal(output.find((chunk) => chunk.type === 'block-end')?.block.codingnsTranslation.translated, '用户正在测试对话。')
    assert.equal(output.find((chunk) => chunk.type === 'block-end')?.block.codingnsTranslation.totalTokens, 35)
    assert.ok(output.find((chunk) => chunk.type === 'block-end')?.block.codingnsTranslation.durationMs >= 0)
  } finally { await harness.features.disable('cliAdapters'); translation.dispose() }
})

test('DSH 原生会话输出翻译不改写工具调用与 usage', async () => {
  const translation = createTranslation()
  const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
  await harness.start()
  const chunks: any[] = []
  for await (const chunk of harness.llmListener({ sessionId: 'native-session', messages: [] }, async function* () {
    yield { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'read_file', argumentsDelta: '{"path":"a.ts"}' }
    yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) chunks.push(chunk)
  assert.equal(chunks[0].type, 'tool-call-delta')
  assert.equal(chunks[1].type, 'block-end')
  assert.equal(chunks[1].block.type, 'tool-call')
  assert.equal(chunks[1].codingnsTranslation, undefined)
  assert.equal(chunks[2].type, 'usage')
  assert.equal(chunks[3].type, 'finish')
  assert.deepEqual(harness.requests, [])
  await harness.features.disable('cliAdapters')
})

test('DSH 原生会话翻译请求自身旁路翻译', async () => {
  const translation = createTranslation()
  const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
  await harness.start()
  const chunks: any[] = []
  for await (const chunk of harness.llmListener({
    sessionId: 'native-session',
    codingnsTranslation: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'translate this' }] }],
  }, async function* () {
    yield { type: 'text-delta', index: 1, text: 'translated' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'text-delta', index: 1, text: 'translated' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(harness.requests, [])
  await harness.features.disable('cliAdapters')
})

test('DSH 原生会话的标题与压缩请求不翻译', async () => {
  const translation = createTranslation()
  const harness = createHarness({ translation }) as Harness & { start(): Promise<void> }
  await harness.start()
  for (const purpose of ['session-title', 'compaction']) {
    const chunks: any[] = []
    for await (const chunk of harness.llmListener({ sessionId: 'native-session', purpose, messages: [] }, async function* () {
      yield { type: 'text-delta', index: 1, text: 'Title' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })) chunks.push(chunk)
    assert.deepEqual(chunks, [
      { type: 'text-delta', index: 1, text: 'Title' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  }
  assert.deepEqual(harness.requests, [])
  await harness.features.disable('cliAdapters')
})

test('原生会话翻译开关按适配器偏好持久化并可回读', async () => {
  const table = new CodingNsRpcTable()
  const updates: unknown[] = []
  let saved = CodingNsSettingsSchema({} as never) as CodingNsSettings
  const watchers = new Set<(next: CodingNsSettings, previous: CodingNsSettings) => void>()
  const settings = {
    get: () => saved,
    async update(patch: Partial<CodingNsSettings>) {
      updates.push(patch)
      const previous = saved
      saved = CodingNsSettingsSchema({ ...saved, ...patch } as never) as CodingNsSettings
      for (const listener of watchers) listener(saved, previous)
    },
    watch(listener: (next: CodingNsSettings, previous: CodingNsSettings) => void) {
      watchers.add(listener)
      return () => { watchers.delete(listener) }
    },
  }
  // 注册表必须与功能模块共用同一个设置作用域，否则适配器偏好写不进设置。
  const registry = new CodingNsCliAdapterRegistry([], {}, { settings })
  const features = new FeatureRegistry({
    rpc: table,
    events: { on() { return () => undefined } },
    settings,
  } as never)
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')

  const setSession = table.resolve('cli/session/set')
  await setSession!.handler('session/set', { sessionId: 'native-preference', adapterId: 'dsh', translationEnabled: true })
  const read = await table.resolve('cli/session/get')!.handler('session/get', { sessionId: 'native-preference' }) as { translationEnabled?: boolean }
  assert.equal(read.translationEnabled, true)
  const fresh = await table.resolve('cli/session/get')!.handler('session/get', { sessionId: 'native-next-session' }) as { translationEnabled?: boolean }
  assert.equal(fresh.translationEnabled, true, '新建原生会话应继承最近开启值')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const restarted = new CodingNsCliAdapterRegistry([], {}, { settings })
  try {
    assert.equal(restarted.getSession('native-after-restart').translationEnabled, true, '设置经 schema 落盘并重新加载后仍继承开启值')
  } finally { await restarted.dispose() }
  // 偏好必须写回设置，否则重启后原生会话的翻译开关会丢失。
  // 只筛出 dsh 条目：宿主上遗留的其他适配器偏好也会随快照一起写回。
  const dshWrites = updates
    .map((patch) => (patch as { agentAdapterPreferences?: Record<string, unknown> }).agentAdapterPreferences?.dsh)
    .filter((value) => value !== undefined)
  assert.deepEqual(dshWrites, [{ translationEnabled: true }])

  await setSession!.handler('session/set', { sessionId: 'native-preference', adapterId: 'dsh', translationEnabled: false })
  const disabled = await table.resolve('cli/session/get')!.handler('session/get', { sessionId: 'native-preference' }) as { translationEnabled?: boolean }
  assert.equal(disabled.translationEnabled, false)
  const nextDisabled = await table.resolve('cli/session/get')!.handler('session/get', { sessionId: 'native-next-disabled' }) as { translationEnabled?: boolean }
  assert.equal(nextDisabled.translationEnabled, false, '显式关闭也应成为后续会话默认值')
  await features.disable('cliAdapters')
})
