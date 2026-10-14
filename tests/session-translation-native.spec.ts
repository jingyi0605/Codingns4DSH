import assert from 'node:assert/strict'
import test from 'node:test'
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
  readonly llmListener: LlmListener
  readonly preStepListener: PreStepListener
}

/** DSH 原生会话的会话翻译测试台：只有一个空驱动注册表与最小原生会话替身。 */
function createHarness(options: {
  readonly translation: Record<string, unknown>
  readonly header?: Record<string, unknown>
  readonly sessionId?: string
  readonly translationEnabled?: boolean
  /** 缺省表示会话从未单独设置过开关，此时跟随总开关。 */
  readonly sessionTranslationEnabled?: boolean
}): Harness {
  const table = new CodingNsRpcTable()
  let llmListener: LlmListener | undefined
  let preStepListener: PreStepListener | undefined
  const registry = new CodingNsCliAdapterRegistry([])
  const events = {
    on(_name: string, listener: LlmListener) {
      llmListener = listener
      return () => { llmListener = undefined }
    },
  }
  const dshContext = {
    get() { return undefined },
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
        adapterId: 'dsh',
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

test('DSH 原生会话输出翻译在块结束时替换正文并挂上记录', async () => {
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
  assert.equal(reasoning.text, '[zh]Checking code')
  assert.equal(reasoning.codingnsTranslation.original, 'Checking code')
  assert.equal(reasoning.codingnsTranslation.translated, '[zh]Checking code')
  assert.equal(reasoning.codingnsTranslation.outputKind, 'reasoning')
  const text = chunks[4]
  assert.equal(text.text, '[zh]Hello')
  assert.equal(text.codingnsTranslation.outputKind, 'assistant')
  // 可见正文必须与记录里的译文完全一致，客户端靠它匹配翻译入口。
  assert.equal(chunks[5].block.text, text.codingnsTranslation.translated)
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
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
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
          yield { type: 'text-delta', text: requests.length === 1 ? 'Conversation test' : '用户正在测试对话。' }
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
    assert.equal(original.content[0].text, '对话测试')
    const output: any[] = []
    for await (const chunk of harness.llmListener(Object.freeze({ sessionId: 'native-session', provider: 'native', model: 'translator', messages: decision.messages }), async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'The user is testing the conversation.' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user is testing the conversation.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })) output.push(chunk)
    assert.equal(requests.length, 2, '会话开启必须同时执行输入和输出翻译')
    assert.equal(output.find((chunk) => chunk.type === 'reasoning-delta')?.text, '用户正在测试对话。')
    assert.equal(output.find((chunk) => chunk.type === 'block-end')?.block.codingnsTranslation.original, 'The user is testing the conversation.')
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
