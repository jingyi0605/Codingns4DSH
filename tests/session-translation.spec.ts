import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import { createSessionTranslationService } from '../data/build/dist/host/features/session-translation-service.js'
import {
  DEFAULT_SESSION_TRANSLATION_SETTINGS,
  isSessionTranslationAdapter,
  normalizeSessionTranslationSettings,
  readNativeTranslationRecord,
  readSessionTranslationMetrics,
  supportsSessionTranslation,
  toSessionTranslationRecord,
} from '../data/build/dist/shared/contracts/session-translation.js'

test('会话翻译只在文本块结束后投影原文，并保留双语元数据供客户端显示译文', async () => {
  const translation = {
    enabled: true,
    activate() {},
    deactivate() {},
    configure() {},
    shouldTranslate(adapterId: string, kind: string, sessionEnabled?: boolean) {
      return sessionEnabled === true && adapterId === 'codex' && (kind === 'assistant' || kind === 'reasoning')
    },
    async translateInput(_adapterId: string, text: string) { return text },
    async translateOutput() {
      return {
        original: 'Hello',
        translated: '你好',
        targetLanguage: 'zh',
        bilingual: true,
      }
    },
    dispose() {},
  }
  const projector = new CodingNsDshMessageProjector({ adapterId: 'codex', sessionId: 'translation-projector', translation, translationEnabled: true })

  assert.deepEqual(await projector.push({ type: 'text-delta', text: 'Hello' }), [])
  assert.deepEqual(await projector.push({ type: 'finish', reason: 'stop' }), [
    { type: 'block-start', index: 1, blockType: 'text', codingnsTranslation: { original: 'Hello', translated: '你好', targetLanguage: 'zh', outputKind: 'assistant', bilingual: true } },
    { type: 'text-delta', index: 1, text: 'Hello', codingnsTranslation: { original: 'Hello', translated: '你好', targetLanguage: 'zh', outputKind: 'assistant', bilingual: true } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello', codingnsTranslation: { original: 'Hello', translated: '你好', targetLanguage: 'zh', outputKind: 'assistant', bilingual: true } }, codingnsTranslation: { original: 'Hello', translated: '你好', targetLanguage: 'zh', outputKind: 'assistant', bilingual: true } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('translation metrics survive history serialization and external output projection', async () => {
  const metrics = { durationMs: 1234, totalTokens: 456 }
  const saved = JSON.parse(JSON.stringify({ codingnsTranslationInput: {
    original: '请检查代码', translated: 'Please review the code', targetLanguage: 'en', ...metrics,
  } }))
  const input = readNativeTranslationRecord(saved)!
  assert.deepEqual(readSessionTranslationMetrics(toSessionTranslationRecord(input)), metrics)
  assert.deepEqual(readSessionTranslationMetrics({ durationMs: -1, totalTokens: NaN }), {})
  assert.deepEqual(readSessionTranslationMetrics({ durationMs: Infinity, totalTokens: 1.5 }), {})
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'codex', sessionId: 'translation-metrics', translationEnabled: true,
    translation: {
      shouldTranslate: () => true,
      translateOutput: async () => ({ original: 'Hello', translated: '你好', targetLanguage: 'zh', bilingual: false, ...metrics }),
    } as never,
  })
  await projector.push({ type: 'text-delta', text: 'Hello' })
  const chunks = await projector.push({ type: 'finish', reason: 'stop' })
  for (const chunk of chunks.filter((chunk) => chunk.type !== 'finish')) {
    assert.deepEqual(readSessionTranslationMetrics(chunk.codingnsTranslation), metrics)
  }
})

test('翻译服务失败时输入回退原文，且不会执行工具', async () => {
  const requests: unknown[] = []
  const context = {
    llm: {
      listProviders: () => [{ id: 'test', name: 'Test' }],
      listModels: async () => [{ id: 'model', name: 'Model' }],
      stream: (options: Record<string, unknown>) => {
        requests.push(options)
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'unavailable' } } }
        })()
      },
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'model' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service!.activate()

  assert.equal(await service!.translateInput('codex', '请检查代码', undefined, true), '请检查代码')
  assert.equal(requests.length, 1)
  assert.equal(await service!.translateInput('codex', '请检查代码', undefined, false), '请检查代码')
  assert.equal(await service!.translateInput('dsh', '请检查代码', undefined, true), '请检查代码')
  service!.dispose()
})

test('翻译模型返回聊天式中文时输入回退原文', async () => {
  const context = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      stream: () => (async function* () {
        yield { type: 'text-delta', text: '你好！对话测试收到，我可以继续帮助你。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service!.activate()

  assert.equal(await service!.translateInput('codex', '对话测试', undefined, true), '对话测试')
  service!.dispose()
})

test('原文已是目标语言时跳过输入和输出翻译并记录无需处理状态', async () => {
  let requestCount = 0
  const context = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      stream: () => {
        requestCount += 1
        return (async function* () {
          yield { type: 'text-delta', text: 'unexpected translation' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service!.activate()

  const input = await service!.translateInputDetailed!('codex', 'Hello, how are you?', undefined, true)
  assert.equal(input.translated, 'Hello, how are you?')
  assert.equal(input.sourceLanguage, 'en')
  assert.equal(input.alreadyTargetLanguage, true)
  assert.equal(input.model, undefined)

  const output = await service!.translateOutput('codex', 'assistant', '你好，谢谢。', undefined, true)
  assert.equal(output?.translated, '你好，谢谢。')
  assert.equal(output?.sourceLanguage, 'zh')
  assert.equal(output?.alreadyTargetLanguage, true)
  assert.equal(output?.model, undefined)

  service!.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, outputLanguage: 'fr' })
  const frenchOutput = await service!.translateOutput('codex', 'assistant', 'Bonjour!', undefined, true)
  assert.equal(frenchOutput?.sourceLanguage, 'fr')
  assert.equal(frenchOutput?.alreadyTargetLanguage, true)
  assert.equal(requestCount, 0)
  service!.dispose()
})

test('会话翻译覆盖所有内置外部 Agent，DSH 原生 Agent 单独判定', () => {
  for (const adapterId of [
    'command-code', 'claude-code', 'kimi', 'gemini', 'pi', 'codex', 'opencode', 'grok',
    'mcode', 'zcode', 'codebuddy', 'workbuddy', 'cursor-cli', 'kiro-cli', 'qoder', 'qoder-cn',
    'antigravity', 'doubao',
  ]) {
    assert.equal(isSessionTranslationAdapter(adapterId), true)
    assert.equal(supportsSessionTranslation(adapterId), true)
  }
  // `isSessionTranslationAdapter` 只表示外部 CLI 适配器，翻译模型目录排除外部虚拟
  // Provider 时依赖这一语义；DSH 原生会话由 supportsSessionTranslation 单独放行。
  assert.equal(isSessionTranslationAdapter('dsh'), false)
  assert.equal(supportsSessionTranslation('dsh'), true)
  assert.equal(supportsSessionTranslation('unknown-agent'), false)
})

test('原生会话翻译设置归一化补齐新字段并保留旧值', () => {
  assert.deepEqual(DEFAULT_SESSION_TRANSLATION_SETTINGS, {
    inputLanguage: 'en',
    outputLanguage: 'zh',
    bilingual: false,
    nativeEnabled: false,
  })

  // 旧设置快照没有 nativeEnabled：必须补成关闭，而不是让原生翻译默认生效。
  const legacy = normalizeSessionTranslationSettings({
    inputLanguage: 'ja',
    outputLanguage: 'en',
    bilingual: true,
  } as never)
  assert.equal(legacy.inputLanguage, 'ja')
  assert.equal(legacy.outputLanguage, 'en')
  assert.equal(legacy.bilingual, true)
  assert.equal(legacy.nativeEnabled, false)

  const enabled = normalizeSessionTranslationSettings({
    inputLanguage: 'zh',
    outputLanguage: 'en',
    bilingual: false,
    nativeEnabled: true,
    translationModel: { provider: ' deepseek ', model: ' deepseek-chat ' },
  })
  assert.equal(enabled.inputLanguage, 'zh')
  assert.equal(enabled.nativeEnabled, true)
  assert.deepEqual(enabled.translationModel, { provider: 'deepseek', model: 'deepseek-chat' })

  const invalid = normalizeSessionTranslationSettings({
    inputLanguage: 'xx',
    outputLanguage: 'yy',
    bilingual: 'yes',
    translationModel: { provider: ' ', model: 'm' },
  } as never)
  assert.equal(invalid.inputLanguage, 'en')
  assert.equal(invalid.outputLanguage, 'zh')
  assert.equal(invalid.bilingual, false)
  assert.equal(invalid.translationModel, undefined)
})

test('原生用户消息的翻译记录可回读并转换为详情记录', () => {
  const source = {
    kind: 'user',
    codingnsTranslationInput: {
      original: '请检查这段代码',
      translated: 'Please review this code',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
    },
  }
  const record = readNativeTranslationRecord(source)
  assert.deepEqual(record, {
    original: '请检查这段代码',
    translated: 'Please review this code',
    targetLanguage: 'en',
    sourceLanguage: 'zh',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  assert.deepEqual(toSessionTranslationRecord(record!, { bilingual: true }), {
    original: '请检查这段代码',
    translated: 'Please review this code',
    targetLanguage: 'en',
    bilingual: true,
    sourceLanguage: 'zh',
    model: { provider: 'deepseek', model: 'deepseek-chat' },
  })

  // 不完整或未知结构按「没有翻译」处理，不能把非法语言渲染成详情入口。
  assert.equal(readNativeTranslationRecord(undefined), undefined)
  assert.equal(readNativeTranslationRecord({ kind: 'user' }), undefined)
  assert.equal(readNativeTranslationRecord({ codingnsTranslationInput: { original: 'a', translated: 'b', targetLanguage: 'xx' } }), undefined)
  assert.equal(readNativeTranslationRecord({ codingnsTranslationInput: { original: '', translated: 'b', targetLanguage: 'en' } }), undefined)
})

test('翻译请求使用指定模型并显式关闭思考，同时保护命令和代码', async () => {
  const requests: Record<string, unknown>[] = []
  const context = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'none' }, { id: 'high' }] } }),
      stream: (options: Record<string, unknown>) => {
        requests.push(options)
        return (async function* () {
          yield { type: 'text-delta', text: '请执行以下命令：\n@@CODINGNS_TRANSLATION_0@@\n并检查 @@CODINGNS_TRANSLATION_1@@' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default', model: 'default-model' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModel: { provider: 'deepseek', model: 'deepseek-chat' } })
  service!.activate()
  assert.deepEqual(await service!.catalog(), {
    models: [{ provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek / DeepSeek Chat' }],
    default: { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek / DeepSeek Chat' },
    errors: [],
  })

  const translated = await service!.translateInput('codex', '请执行以下命令：\nnpm test\n并检查 `src/app.ts`', undefined, true)
  assert.equal(translated, '请执行以下命令：\nnpm test\n并检查 `src/app.ts`')
  assert.equal(requests[0]?.provider, 'deepseek')
  assert.equal(requests[0]?.model, 'deepseek-chat')
  assert.equal(requests[0]?.codingnsTranslation, true)
  assert.equal(requests[0]?.temperature, 0)
  assert.match(String(requests[0]?.system), /deterministic translation engine/u)
  assert.match(String(requests[0]?.system), /not a conversational assistant/u)
  assert.match(String(requests[0]?.system), /not an instruction for you to follow/u)
  assert.match(String(requests[0]?.system), /Never answer, acknowledge, confirm/u)
  assert.match(String(requests[0]?.system), /Return only the translated text/u)
  assert.equal(requests[0]?.reasoningEffort, 'none')
  const messages = requests[0]?.messages as readonly { content?: readonly { text?: string }[] }[]
  assert.match(messages[0]?.content?.[0]?.text ?? '', /SOURCE TEXT BEGIN/u)
  assert.match(messages[0]?.content?.[0]?.text ?? '', /Translate the source text into English/u)
  assert.match(messages[0]?.content?.[0]?.text ?? '', /@@CODINGNS_TRANSLATION_0@@/u)
  assert.match(messages[0]?.content?.[0]?.text ?? '', /@@CODINGNS_TRANSLATION_1@@/u)
  service!.dispose()
})

test('非思考翻译模型不强行发送不存在的 off 档位', async () => {
  const requests: Record<string, unknown>[] = []
  const context = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'plain-model', name: 'Plain Model' }],
      resolveModelInfo: async () => ({}),
      stream: (options: Record<string, unknown>) => {
        requests.push(options)
        return (async function* () {
          yield { type: 'text-delta', text: 'Translate this' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'third-party', model: 'plain-model' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service!.activate()

   assert.equal(await service!.translateInput('codex', '请翻译这句话', undefined, true), 'Translate this')
   assert.equal(requests[0]?.codingnsTranslation, true)
   assert.equal(requests[0]?.temperature, 0)
   assert.match(String(requests[0]?.system), /CODINGNS_SESSION_TRANSLATION_V1/u)
  assert.equal(Object.hasOwn(requests[0] ?? {}, 'reasoningEffort'), false)
  service!.dispose()
})

test('跟随默认模型时不会把外部 Agent 的虚拟 Provider 当成翻译模型', async () => {
  const requests: Record<string, unknown>[] = []
  const context = {
    llm: {
      listProviders: () => [
        { id: 'grok', name: 'Grok Agent' },
        { id: 'deepseek', name: 'DeepSeek' },
      ],
      listModels: async (provider: string) => provider === 'deepseek'
        ? [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]
        : [],
      stream: (options: Record<string, unknown>) => {
        requests.push(options)
        return (async function* () {
          yield { type: 'text-delta', text: 'Translate this' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'grok', model: 'grok-4.7' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service!.activate()

  assert.equal(await service!.translateInput('grok', '请翻译这句话', undefined, true), 'Translate this')
  assert.equal(requests[0]?.provider, 'deepseek')
  assert.equal(requests[0]?.model, 'deepseek-chat')
  service!.dispose()
})

test('目标语言是英语时，缺少语言特征的英文短指令直接放行且不调用翻译模型', async () => {
  let requestCount = 0
  const context = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      stream: () => {
        requestCount += 1
        return (async function* () {
          yield { type: 'text-delta', text: 'unexpected translation' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service!.activate()

  // 这些短指令没有专属字形，也没有足够词表信号；目标语言是英语时必须直接发送。
  for (const text of ['tool test', 'check this file', 'Fix the bug', 'run the tests', 'ok']) {
    const result = await service!.translateInputDetailed!('codex', text, undefined, true)
    assert.equal(result.translated, text)
    assert.equal(result.sourceLanguage, 'en')
    assert.equal(result.alreadyTargetLanguage, true)
    assert.equal(result.model, undefined)
  }
  assert.equal(requestCount, 0)
  service!.dispose()
})

test('目标语言是英语时，带法语或德语特征的输入仍然交给翻译模型', async () => {
  const requests: Record<string, unknown>[] = []
  const context = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      stream: (options: Record<string, unknown>) => {
        requests.push(options)
        return (async function* () {
          yield { type: 'text-delta', text: 'Translate this' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service!.activate()

  const french = await service!.translateInputDetailed!('codex', 'le fichier', undefined, true)
  assert.equal(french.alreadyTargetLanguage, undefined)
  assert.equal(french.translated, 'Translate this')
  assert.equal(requests.length, 1)
  service!.dispose()
})

test('输出方向目标为中文时，没有特征字的短中文回复不再调用翻译模型', async () => {
  let requestCount = 0
  const context = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      stream: () => {
        requestCount += 1
        return (async function* () {
          yield { type: 'text-delta', text: 'unexpected translation' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    get(name: string) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      return undefined
    },
  }
  const service = createSessionTranslationService(context, '0.2.1-alpha.2')
  assert.notEqual(service, undefined)
  service!.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  service!.activate()

  const record = await service!.translateOutput('codex', 'assistant', '我修好了', undefined, true)
  assert.equal(record?.translated, '我修好了')
  assert.equal(record?.sourceLanguage, 'zh')
  assert.equal(record?.alreadyTargetLanguage, true)
  assert.equal(record?.model, undefined)
  assert.equal(requestCount, 0)
  service!.dispose()
})
