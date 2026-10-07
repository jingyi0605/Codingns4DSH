import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { FeatureRegistry } from '../src/features/index.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createGlobalVoiceRpcFeature } from '../src/host/features/global-voice-rpc.js'
import { createAssistantLlmAdapter } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import { DEFAULT_CODINGNS_SETTINGS, type AssistantSettings, type CodingNsSettings } from '../src/shared/contracts/config.js'
import type { AssistantLifecycleSnapshot } from '../src/shared/contracts/assistant.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import { SherpaVoiceRuntime } from '../src/host/features/sherpa-voice-runtime.js'
import { AssistantVoiceModelManager } from '../src/host/features/voice-model-management.js'
import { memoryAssistantConversationStorage } from './assistant-fixtures.js'
import { ASSISTANT_VOICE_MODEL_CATALOG } from '../src/shared/voice-models.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { DEFAULT_ASSISTANT_PERSONALITY, assistantWorkspaceMatches } from '../src/shared/assistant-lifecycle.js'
import { normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { DEFAULT_ASSISTANT_TTS_SETTINGS, MOSS_BUILTIN_VOICES } from '../src/shared/assistant-tts.js'
import { AssistantTtsService } from '../src/host/features/assistant-tts-service.js'
import type { AssistantAttachmentStore } from '../src/dsh-capabilities/host/assistant-attachment-adapter.js'

async function fixture(t: TestContext, stream?: (options: any) => AsyncGenerator<any>, writable = true, read?: () => Promise<string>, initialAssistant: Partial<AssistantSettings> = {}, attachments?: AssistantAttachmentStore) {
  let settings = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  settings.assistant = { ...settings.assistant, ...initialAssistant }
  const watchers = new Set<() => void>()
  const wire: any[] = []
  const rpc = new CodingNsRpcTable()
  const services = { rpc, dshVersion: '0.2.1-alpha.1', settingsProvider: { writable }, settings: {
    get: () => settings,
    update: async (patch: Partial<CodingNsSettings>) => { settings = { ...settings, ...patch }; watchers.forEach((listener) => listener()) },
    watch: (listener: () => void) => { watchers.add(listener); return () => watchers.delete(listener) },
  }, dshContext: { get(name: string) {
    if (name === 'attachments') return attachments
    if (name === 'llm') return { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'default', name: '默认' }, { id: 'fixed', name: '固定' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
      stream: (options: any) => { wire.push(options); return stream?.(options) ?? (async function* () { yield { type: 'text-delta', index: 0, text: '记住了。' }; yield { type: 'finish', reason: { kind: 'stop' } } })() } }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'api', model: 'default' }) }
    if (name === 'workspaceRegistry') return { list: () => [{ id: 'w1', displayName: '项目一', sessionIds: read === undefined ? [] : ['s1'] }, { id: 'w2', displayName: '项目二', sessionIds: [] }] }
    if (name === 'sessionController' && read !== undefined) return { list: () => ({ items: [{ sessionId: 's1', workspaceId: 'w1', title: '会话一', running: false, blank: false, updatedAt: 1 }] }) }
    if (name === 'sessionQuery') return { listSessions: () => [], ...(read === undefined ? {} : { readSurface: read }) }
    return undefined
  } } } as unknown as CodingNsHostServices
  const storage = memoryAssistantConversationStorage()
  const registry = new FeatureRegistry(services)
  // 生命周期测试替换对话引擎；原生 Agent 工具隔离由 assistant-agent.spec.ts 单独验证。
  registry.register(createGlobalVoiceRpcFeature({ conversationStorage: storage, conversationAdapter: createAssistantLlmAdapter(services.dshContext, '0.2.1-alpha.1') }))
  await registry.reconcile(['globalVoiceRpc'])
  t.after(() => registry.reconcile([]))
  const call = async <T = unknown,>(action: string, payload: unknown = {}): Promise<T> => {
    const target = rpc.resolve(`assistant/${action}`)!
    return await target.handler(target.action, payload) as T
  }
  const configure = (patch: Record<string, unknown> = {}) => call<AssistantLifecycleSnapshot>('lifecycle/configure', { name: '小鱼', managedWorkspaceIds: [], avatarId: 'codingns-default', voiceId: 'moss:Junhao', ...patch })
  return { call, configure, wire, settings: () => settings, update: services.settings!.update.bind(services.settings), storage, services }
}

test('统一保存模型、形象、提示词和播报参数，失败校验不写入任何字段', async (t) => {
  const f = await fixture(t)
  const before = structuredClone(f.settings().assistant)
  await assert.rejects(f.configure({ model: { provider: 'api', model: 'missing' }, configurationPatch: [
    { op: 'set', path: ['appearance', 'floatingEnabled'], value: true },
  ] }), /模型不可用/u)
  assert.deepEqual(f.settings().assistant, before)
  await f.configure({ model: { provider: 'api', model: 'fixed' }, configurationPatch: [
    { op: 'set', path: ['appearance'], value: { ...normalizeAssistantAppearance(), floatingEnabled: true, floatingSize: 72, dialogEnabled: false } },
    { op: 'set', path: ['prompts', 'chat'], value: '保存后的专用提示词' },
    { op: 'set', path: ['tts', 'parameters'], value: { rate: 1.5, volume: .8, segmentPauseMs: 50, chunkTokens: 75, seed: null } },
  ] })
  assert.equal(f.settings().assistant.appearance!.floatingEnabled, true)
  assert.equal(f.settings().assistant.appearance!.dialogEnabled, false)
  assert.equal(f.settings().assistant.tts!.parameters!.rate, 1.5)
  await f.call('conversation/start', { requestId: 'saved-fixed-model', text: '你好' }); await setImmediate()
  assert.equal(f.wire.at(-1).provider, 'api'); assert.equal(f.wire.at(-1).model, 'fixed')
  assert.ok(f.wire.at(-1).system.includes('保存后的专用提示词'))
  const saved = structuredClone(f.settings().assistant)
  await assert.rejects(f.configure({ configurationPatch: [{ op: 'set', path: ['tts', 'parameters', 'rate'], value: 99 }] }))
  assert.deepEqual(f.settings().assistant, saved)
  await assert.rejects(f.configure({ configurationPatch: [{ op: 'set', path: ['model'], value: { provider: 'api', model: 'default' } }] }), /字段无效/u)
  assert.deepEqual(f.settings().assistant, saved)
})

test('正式对话 RPC 校验附件上传，创建前不接收，创建后只持久保存原生引用', async (t) => {
  const received: { data: string; name: string }[] = []
  const attachments: AssistantAttachmentStore = {
    async admitPromptContent() { return [] },
    async admitEncodedFile(input) {
      received.push(input)
      const bytes = Buffer.from(input.data, 'base64')
      return { attachmentId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, name: input.name, bytes: bytes.length }
    },
    async *readFileStream() { yield new Uint8Array() },
  }
  const f = await fixture(t, undefined, true, undefined, {}, attachments)
  const file = { name: '问题.txt', mediaType: 'text/plain', data: Buffer.from('实际附件内容').toString('base64') }
  await assert.rejects(f.call('conversation/start', { requestId: 'before-creation', text: '查看附件', attachments: [file] }), /先创建/u)
  assert.equal(received.length, 0)
  await f.configure()
  await assert.rejects(f.call('conversation/start', { requestId: 'path-upload', text: '查看附件', attachments: [{ ...file, name: '../秘密.txt' }] }), /附件无效/u)
  await assert.rejects(f.call('conversation/start', { requestId: 'reference-upload', text: '查看附件', attachments: [{ type: 'file', attachment: { attachmentId: `sha256:${'a'.repeat(64)}` } }] }), /附件无效/u)
  assert.equal(received.length, 0)
  await f.call('conversation/start', { requestId: 'file-upload', text: '查看附件', attachments: [file] }); await setImmediate()
  assert.deepEqual(received, [{ name: file.name, data: file.data }])
  const snapshot = await f.call<AssistantLifecycleSnapshot>('lifecycle/read')
  assert.equal(snapshot.conversation.messages[0]?.attachments?.[0]?.attachment.name, file.name)
  assert.match(snapshot.conversation.messages[0]!.attachments![0]!.attachment.attachmentId, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(JSON.stringify(snapshot).includes(file.data), false)
  assert.equal(f.wire.length, 1)
})

test('四项创建不读取 MOSS 或远端项目目录，旧 MOSS 选择不阻塞浏览器声音初始化', async (t) => {
  t.mock.method(AssistantTtsService.prototype, 'snapshot', async () => assert.fail('首次创建不应检查 MOSS'))
  const f = await fixture(t, undefined, true, undefined, { tts: { ...DEFAULT_ASSISTANT_TTS_SETTINGS, backend: 'moss-onnx', selectedId: 'moss:Lingyu' } })
  ;(f.services as any).assistantGateway = { workspaces: async () => assert.fail('首次创建不应查询远端项目目录') }
  const created = await f.call<AssistantLifecycleSnapshot>('lifecycle/configure', { name: '小鱼', model: null, personality: '耐心的编程伙伴', avatarId: 'codingns-default' })
  assert.equal(created.profile.initialized, true)
  assert.equal(created.profile.personality, '耐心的编程伙伴')
  assert.deepEqual(f.settings().assistant.managedWorkspaceIds, [])
  assert.equal(f.settings().assistant.voice.initialized, false)
  assert.equal(f.settings().assistant.tts!.backend, 'browser')
  assert.equal(f.settings().assistant.tts!.selectedId, 'moss:Lingyu', '输出回退不删除原音色资料')
  await f.call('conversation/start', { requestId: 'fresh', text: '你好' }); await setImmediate()
  assert.equal(f.wire.length, 1)
})

test('标准性格用于首次试聊和缺省创建，修改或清空后按保存值对话，重置可重新预填', async (t) => {
  const f = await fixture(t)
  await f.call('conversation/preview', { requestId: 'default-personality-preview', text: '介绍自己' }); await setImmediate()
  assert.ok(f.wire.at(-1).system.includes(DEFAULT_ASSISTANT_PERSONALITY))
  assert.equal(f.settings().assistant.profile?.personality, undefined, '试聊不提前持久写入默认性格')
  assert.equal((await f.configure()).profile.personality, DEFAULT_ASSISTANT_PERSONALITY)
  const personality = '活泼直接，喜欢用生活中的例子解释复杂问题。'
  assert.equal((await f.configure({ personality })).profile.personality, personality)
  await f.call('conversation/start', { requestId: 'custom-default-personality', text: '你好' }); await setImmediate()
  assert.ok(f.wire.at(-1).system.includes(personality))
  assert.ok(!f.wire.at(-1).system.includes(DEFAULT_ASSISTANT_PERSONALITY))
  await f.configure({ personality: '' })
  assert.equal((await f.configure()).profile.personality, '', '旧客户端缺省字段不恢复用户已清空的性格')
  await f.call('conversation/start', { requestId: 'cleared-personality', text: '继续' }); await setImmediate()
  assert.ok(!f.wire.at(-1).system.includes('助理性格背景：'))
  await f.call('lifecycle/reset')
  assert.equal((await f.configure()).profile.personality, DEFAULT_ASSISTANT_PERSONALITY)
})

test('首次创建拒绝未登记的第三方旧预设，保留原配置并可用内置形象完成创建', async (t) => {
  const avatarId = 'codingns-preset-whale-live2d'
  const f = await fixture(t, undefined, true, undefined, { appearance: normalizeAssistantAppearance({ selectedId: avatarId }) })
  const before = structuredClone(f.settings().assistant)
  await assert.rejects(f.configure({ avatarId }), /形象尚未登记/u)
  assert.deepEqual(f.settings().assistant, before)
  await f.configure()
  assert.equal(f.settings().assistant.appearance!.selectedId, 'codingns-default')
})

test('新用户可用男生基本形象创建，创建后切换女生不改变对话与浏览器声音', async (t) => {
  const f = await fixture(t)
  await f.call('lifecycle/configure', { name: '小蓝', model: null, personality: '可靠的伙伴', avatarId: 'codingns-basic-male' })
  assert.equal(f.settings().assistant.profile!.initialized, true)
  assert.equal(f.settings().assistant.appearance!.selectedId, 'codingns-basic-male')
  assert.equal(f.settings().assistant.tts!.backend, 'browser')
  await f.call('conversation/start', { requestId: 'male-basic', text: '你好' }); await setImmediate()
  const before = await f.call('conversation/read', { requestId: 'male-basic' })
  await f.call('lifecycle/configure', { name: '小蓝', model: null, personality: '可靠的伙伴', avatarId: 'codingns-default' })
  assert.equal(f.settings().assistant.appearance!.selectedId, 'codingns-default')
  assert.deepEqual(await f.call('conversation/read', { requestId: 'male-basic' }), before)
  assert.equal(f.settings().assistant.tts!.backend, 'browser')
})

test('已创建助理可继续保存旧预设，手工登记后的第三方形象可用于首次创建', async (t) => {
  const avatarId = 'codingns-preset-whale-live2d'
  const f = await fixture(t, undefined, true, undefined, { profile: { name: '旧助理', initialized: true, createdAt: 1 },
    appearance: normalizeAssistantAppearance({ selectedId: avatarId }) })
  await f.configure({ avatarId })
  assert.equal(f.settings().assistant.appearance!.selectedId, avatarId)
  const model = (await import('../src/shared/assistant-avatar-legacy.js')).getAssistantAvatarPreset(avatarId)!.model
  const fresh = await fixture(t, undefined, true, undefined, { appearance: normalizeAssistantAppearance({ selectedId: avatarId, models: [model] }) })
  await fresh.configure({ avatarId })
  assert.equal(fresh.settings().assistant.profile!.initialized, true)
  assert.equal(fresh.settings().assistant.appearance!.selectedId, avatarId)
})

test('性格背景持久保存并用于预览、文字和语音，草稿设定不污染正式档案与历史', async (t) => {
  t.mock.method(SherpaVoiceRuntime.prototype, 'start', async function () { (this as any).started = true })
  t.mock.method(SherpaVoiceRuntime.prototype, 'stop', async function () { (this as any).started = false })
  const f = await fixture(t)
  const personality = '温和且直接，曾是图书管理员，喜欢用简洁比喻解释代码。'
  await f.call('conversation/preview', { requestId: 'draft', text: '介绍自己', draft: { personality: '临时的旅行向导', managedWorkspaceIds: [] } }); await setImmediate()
  assert.match(f.wire.at(-1).system, /临时的旅行向导/u)
  assert.equal(f.settings().assistant.profile, undefined)
  assert.equal((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).conversation.messages.length, 0)
  await f.configure({ personality: `  ${personality}  ` })
  assert.equal((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).profile.personality, personality)
  await f.call('conversation/start', { requestId: 'text-personality', text: '你好' }); await setImmediate()
  assert.ok(f.wire.at(-1).system.includes(personality))
  assert.match(f.wire.at(-1).system, /不能作为当前项目的事实来源/u)
  await f.update({ assistant: { ...f.settings().assistant, voice: { ...f.settings().assistant.voice, initialized: true, provider: 'sherpa-onnx', asrEncoder: '/fixture/e', asrDecoder: '/fixture/d', asrJoiner: '/fixture/j', asrTokens: '/fixture/t' } } })
  const lease = await f.call<{ epoch: number }>('voice/start', { ownerId: 'page' })
  await f.call('voice/chat/start', { ownerId: 'page', epoch: lease.epoch, requestId: 'voice-personality', text: '继续' }); await setImmediate()
  assert.ok(f.wire.at(-1).system.includes(personality))
  await f.call('conversation/preview', { requestId: 'changed-draft', text: '介绍自己', draft: { personality: '另一位临时向导' } }); await setImmediate()
  assert.match(f.wire.at(-1).system, /另一位临时向导/u)
  assert.ok(!f.wire.at(-1).system.includes(personality))
  const renamed = await f.configure({ name: '新名字' })
  assert.equal(renamed.profile.personality, personality, '旧客户端不传性格字段时仍保留已保存设定')
  assert.equal(renamed.conversation.messages.length, 4)
  const reset = await f.call<AssistantLifecycleSnapshot>('lifecycle/reset')
  assert.equal(reset.profile.personality, undefined)
})

test('正式配置与预览都拒绝非法或过长性格背景，留空可以创建', async (t) => {
  const f = await fixture(t)
  for (const personality of [null, 123, '长'.repeat(4001)]) {
    await assert.rejects(f.configure({ personality }), /性格背景/u)
    await assert.rejects(f.call('conversation/preview', { requestId: 'invalid-personality', text: '你好', draft: { personality } }), /性格背景/u)
  }
  assert.equal(f.settings().assistant.profile, undefined)
  assert.equal(f.wire.length, 0)
  assert.equal((await f.configure({ personality: '' })).profile.personality, '')
  assert.equal((await f.configure({ personality: '长'.repeat(4000) })).profile.personality!.length, 4000)
})

test('旧项目、语音、浮窗、形象、MOSS 或音色配置均不能跳过首次创建', async (t) => {
  const referenceId = `ref-${'a'.repeat(64)}`
  const cases: [string, Partial<AssistantSettings>][] = [
    ['项目范围', { managedWorkspaceIds: ['w1'] }],
    ['识别模型', { voice: { ...DEFAULT_CODINGNS_SETTINGS.assistant.voice, initialized: true } }],
    ['浮窗', { appearance: { ...normalizeAssistantAppearance(), floatingEnabled: true } }],
    ['非默认形象', { appearance: normalizeAssistantAppearance({ selectedId: 'legacy-avatar', models: [{ id: 'legacy-avatar', name: '旧形象', renderer: 'image', source: '/fixture/avatar.png', spriteVersion: 2 }] }) }],
    ['MOSS 后端', { tts: { ...DEFAULT_ASSISTANT_TTS_SETTINGS, backend: 'moss-onnx' } }],
    ['音色库', { tts: { ...DEFAULT_ASSISTANT_TTS_SETTINGS, voices: [{ ...MOSS_BUILTIN_VOICES[0]!, id: referenceId, reference: referenceId, kind: 'reference' }] } }],
  ]
  for (const [name, assistant] of cases) await t.test(name, async (t) => {
    const f = await fixture(t, undefined, true, undefined, assistant)
    const before = structuredClone(f.settings().assistant)
    const snapshot = await f.call<AssistantLifecycleSnapshot>('lifecycle/read')
    assert.equal(snapshot.profile.initialized, false)
    assert.equal(snapshot.profile.createdAt, null)
    await assert.rejects(f.call('conversation/start', { requestId: 'legacy', text: '你好' }), /先创建/u)
    assert.deepEqual(f.settings().assistant, before, '读取未创建状态不能清理或改写旧配置')
    assert.equal(f.wire.length, 0)
  })
})

test('旧配置完成统一创建后才放行文字和语音，创建保留模型路径、形象及音色库', async (t) => {
  t.mock.method(SherpaVoiceRuntime.prototype, 'start', async function () { (this as any).started = true })
  t.mock.method(SherpaVoiceRuntime.prototype, 'stop', async function () { (this as any).started = false })
  const appearance = normalizeAssistantAppearance({ floatingEnabled: true, selectedId: 'legacy-avatar', models: [{ id: 'legacy-avatar', name: '旧形象', renderer: 'image', source: '/fixture/avatar.png', spriteVersion: 2 }] })
  const voice = { ...DEFAULT_CODINGNS_SETTINGS.assistant.voice, initialized: true, provider: 'sherpa-onnx' as const, asrEncoder: '/fixture/e', asrDecoder: '/fixture/d', asrJoiner: '/fixture/j', asrTokens: '/fixture/t' }
  const referenceId = `ref-${'a'.repeat(64)}`
  const tts = { ...DEFAULT_ASSISTANT_TTS_SETTINGS, selectedId: referenceId, voices: [{ ...MOSS_BUILTIN_VOICES[0]!, id: referenceId, reference: referenceId, kind: 'reference' as const }] }
  const f = await fixture(t, undefined, true, undefined, { managedWorkspaceIds: ['w1'], model: { provider: 'api', model: 'fixed' }, appearance, voice, tts })
  const lease = await f.call<{ epoch: number }>('voice/start', { ownerId: 'page' })
  await assert.rejects(f.call('voice/chat/start', { ownerId: 'page', epoch: lease.epoch, requestId: 'before', text: '你好' }), /先创建/u)
  assert.equal(f.wire.length, 0)
  const created = await f.configure({ managedWorkspaceIds: ['w1'], model: { provider: 'api', model: 'fixed' }, avatarId: appearance.selectedId, voiceId: tts.selectedId, ttsBackend: 'browser' })
  assert.equal(created.profile.initialized, true)
  assert.ok(created.profile.createdAt! > 0)
  assert.deepEqual(f.settings().assistant.voice, voice)
  assert.deepEqual(f.settings().assistant.appearance, appearance)
  assert.deepEqual(f.settings().assistant.tts, tts)
  await f.call('conversation/start', { requestId: 'created-text', text: '你好' }); await setImmediate()
  assert.equal(f.wire.at(-1).model, 'fixed')
  const nextLease = await f.call<{ epoch: number }>('voice/start', { ownerId: 'page' })
  await f.call('voice/chat/start', { ownerId: 'page', epoch: nextLease.epoch, requestId: 'created-voice', text: '继续' }); await setImmediate()
  assert.deepEqual((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).conversation.messages.map((message) => message.source), ['text', 'text', 'voice', 'voice'])
})

test('Host 每次读取当前档案，明确创建状态不因资源配置或启动缓存改变', async (t) => {
  const profile = { name: '已有助理', initialized: true, createdAt: 1 }
  const f = await fixture(t, undefined, true, undefined, { profile })
  assert.deepEqual((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).profile, profile)
  await f.call('conversation/start', { requestId: 'existing', text: '你好' }); await setImmediate()
  for (const next of [{ ...f.settings().assistant, profile: { ...profile, initialized: false } }, { ...f.settings().assistant, profile: undefined }]) {
    await f.update({ assistant: next })
    assert.equal((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).profile.initialized, false)
    await assert.rejects(f.call('conversation/start', { requestId: 'not-created', text: '你好' }), /先创建/u)
  }
  assert.equal(f.wire.length, 1)
})

test('创建校验、草稿预览和配置复用：预览不写正式历史，修改身份保留已有问答', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).profile.initialized, false)
  await assert.rejects(f.call('conversation/start', { requestId: 'before', text: '你好' }), /先创建/u)
  await f.call('conversation/preview', { requestId: 'preview', text: '介绍自己', draft: { name: '草稿鱼', model: { provider: 'api', model: 'fixed' }, managedWorkspaceIds: [] } }); await setImmediate()
  assert.match(f.wire[0].system, /草稿鱼/u)
  assert.equal((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).conversation.messages.length, 0)
  for (const patch of [{ name: '' }, { model: { provider: 'api', model: 'missing' } }, { managedWorkspaceIds: ['unknown'] }, { avatarId: '/file' }, { voiceId: '/file' }]) await assert.rejects(f.configure(patch))
  assert.equal(f.settings().assistant.profile, undefined)
  const created = await f.configure({ model: { provider: 'api', model: 'fixed' } })
  assert.equal(created.profile.initialized, true)
  assert.ok(created.profile.createdAt! > 0)
  await f.call('conversation/start', { requestId: 'text', text: '称呼我阿杰' }); await setImmediate()
  const renamed = await f.configure({ name: '新小鱼', model: { provider: 'api', model: 'fixed' } })
  assert.equal(renamed.conversation.messages.length, 2)
  assert.equal(renamed.profile.createdAt, created.profile.createdAt)
  assert.equal(f.wire.at(-1).model, 'fixed')
  await f.call('conversation/preview', { requestId: 'preview-default', text: '测试默认', draft: { model: null } }); await setImmediate()
  assert.equal(f.wire.at(-1).model, 'default', '预览草稿跟随默认时不沿用已保存的固定模型')
  await f.call('conversation/start', { requestId: 'follow-default', text: '你好' }); await setImmediate()
  assert.equal((await f.configure()).conversation.messages.length, 4)
  assert.equal(f.settings().assistant.model, undefined, '取消固定模型后跟随 Host 默认模型')
})

test('文字和语音共用连续历史：停止语音保留记录，范围变更只隔离模型上下文，重置清空派生数据', async (t) => {
  t.mock.method(SherpaVoiceRuntime.prototype, 'start', async function () { (this as any).started = true })
  t.mock.method(SherpaVoiceRuntime.prototype, 'stop', async function () { (this as any).started = false })
  const f = await fixture(t)
  await f.configure()
  await f.call('conversation/start', { requestId: 'text', text: '称呼我阿杰' }); await setImmediate()
  await f.update({ assistant: { ...f.settings().assistant, voice: { ...f.settings().assistant.voice, initialized: true, provider: 'sherpa-onnx', asrEncoder: '/fixture/e', asrDecoder: '/fixture/d', asrJoiner: '/fixture/j', asrTokens: '/fixture/t' } } })
  const lease = await f.call<{ epoch: number }>('voice/start', { ownerId: 'page' })
  await f.call('voice/chat/start', { ownerId: 'page', epoch: lease.epoch, requestId: 'voice', text: '我叫什么' }); await setImmediate()
  assert.equal(f.wire.at(-1).messages.length, 3)
  assert.deepEqual((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).conversation.messages.map((message) => message.source), ['text', 'text', 'voice', 'voice'])
  await f.call('voice/stop', { ownerId: 'page' })
  const changed = await f.configure({ managedWorkspaceIds: ['w1'] })
  assert.equal(changed.conversation.messages.length, 4)
  await f.call('conversation/start', { requestId: 'new-scope', text: '当前项目怎样' }); await setImmediate()
  assert.equal(f.wire.at(-1).messages.length, 1)
  assert.match(f.wire.at(-1).system, /没有提供有效的项目索引/u)
  const reset = await f.call<AssistantLifecycleSnapshot>('lifecycle/reset')
  assert.equal(reset.profile.initialized, false)
  assert.deepEqual(reset.conversation.messages, [])
  assert.deepEqual(f.settings().assistant.managedWorkspaceIds, [])
  assert.equal(f.settings().assistant.voice.initialized, false)
  assert.equal((await f.call<any>('debug')).records.length, 0)
  await assert.rejects(f.call('conversation/start', { requestId: 'after-reset', text: '你好' }), /先创建/u)
})

test('重置撤销迟到的模型回复和识别模型初始化，不允许旧任务恢复配置', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(t, async function* () { await gate; yield { type: 'text-delta', index: 0, text: '迟到回复' }; yield { type: 'finish', reason: { kind: 'stop' } } })
  await f.configure()
  await f.call('conversation/start', { requestId: 'late', text: '等等' })
  let modelRelease!: () => void; let modelStarted!: () => void
  const began = new Promise<void>((resolve) => { modelStarted = resolve })
  t.mock.method(AssistantVoiceModelManager.prototype, 'prepare', async () => { modelStarted(); await new Promise<void>((resolve) => { modelRelease = resolve }); return {} as any })
  const setup = f.call('voice/setup', { modelId: ASSISTANT_VOICE_MODEL_CATALOG[0]!.id, requestId: 'setup' })
  // 模型目录校验由被替换的 prepare 负责，此处只验证撤销顺序。
  const setupCheck = assert.rejects(setup, /重置|abort/u)
  await began
  const resetting = f.call<AssistantLifecycleSnapshot>('lifecycle/reset')
  await setImmediate(); modelRelease(); release()
  await setupCheck
  const reset = await resetting; await setImmediate()
  assert.equal(reset.profile.initialized, false)
  assert.equal(f.settings().assistant.voice.initialized, false)
  assert.deepEqual((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).conversation.messages, [])
})

test('只读 Host 拒绝创建和完整重置', async (t) => {
  const f = await fixture(t, undefined, false)
  await assert.rejects(f.configure(), /不可写/u)
  await assert.rejects(f.call('lifecycle/reset'), /不可写/u)
})

test('创建前安装资源不会提前创建，取消先于启动到达也不会启动正式或预览模型', async (t) => {
  const f = await fixture(t)
  await f.update({ assistant: { ...f.settings().assistant, voice: { ...f.settings().assistant.voice, initialized: true } } })
  assert.equal((await f.call<AssistantLifecycleSnapshot>('lifecycle/read')).profile.initialized, false)
  await assert.rejects(f.call('conversation/start', { requestId: 'before', text: '你好' }), /先创建/u)
  await f.configure()
  await f.call('conversation/cancel', { requestId: 'revoked' })
  await assert.rejects(f.call('conversation/start', { requestId: 'revoked', text: '不会启动' }), /取消/u)
  await f.call('conversation/cancel', { requestId: 'preview-revoked', preview: true })
  await assert.rejects(f.call('conversation/preview', { requestId: 'preview-revoked', text: '不会启动' }), /取消/u)
  assert.equal(f.wire.length, 0)
})

test('生命周期压缩和清理是真实持久操作，配置和模型文件路径保留', async (t) => {
  const f = await fixture(t)
  await f.configure()
  await f.update({ assistant: { ...f.settings().assistant, voice: { ...f.settings().assistant.voice, asrEncoder: '/fixture/encoder' } } })
  for (let i = 0; i < 5; i++) { await f.call('conversation/start', { requestId: `m${i}`, text: `问题${i}` }); await setImmediate() }
  const compressed = await f.call<AssistantLifecycleSnapshot>('conversation/compress')
  assert.equal(compressed.conversation.messages.length, 6)
  assert.equal(compressed.conversation.summary, '记住了。')
  const cleared = await f.call<AssistantLifecycleSnapshot>('conversation/clear')
  assert.deepEqual(cleared.conversation.messages, [])
  assert.equal(cleared.profile.name, '小鱼')
  assert.equal(cleared.profile.initialized, true)
  assert.equal(f.settings().assistant.voice.asrEncoder, '/fixture/encoder')
  assert.equal((await f.storage.read() as any).summary, '')
})

test('重置期间正在读取的旧索引不会重新登记结果或恢复派生记录', { timeout: 5000 }, async (t) => {
  let began!: () => void; let release!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(t, undefined, true, async () => { began(); await gate; return '旧项目材料' })
  t.after(() => release())
  await f.configure({ managedWorkspaceIds: ['w1'] })
  const building = f.call('index/rebuild')
  await started
  await f.call('lifecycle/reset')
  release(); await building; await setImmediate()
  const debug = await f.call<any>('debug')
  assert.deepEqual(debug.records, [])
  assert.equal(debug.indexState, 'not-built')
  assert.deepEqual(debug.index.entries, [])
})

test('统一项目选择接受原生虚拟工作区和已登记的远端工作区，索引保留原生 Host 归属', async (t) => {
  const f = await fixture(t, undefined, true, async () => '项目材料')
  const local = createVirtualWorkspaceId('local', 'w1')
  const remote = createVirtualWorkspaceId('peer-1', 'remote-project')
  ;(f.services as any).assistantGateway = {
    workspaces: async () => [{ workspaceId: remote, name: '远端项目', path: null }],
    list: async (ids: string[]) => ({ sessions: ids.includes(remote) ? [{ sessionId: 'remote-session', workspaceId: remote, workspaceName: '远端项目', hostId: 'peer-1', running: false, completed: true, waiting: null, title: '远端会话' }] : [], archivedSessionIds: [] }),
    dispatch: async () => assert.fail('配置或索引不能自动派发任务'),
  }
  await f.configure({ managedWorkspaceIds: [local, remote] })
  const index = await f.call<any>('index/rebuild')
  assert.deepEqual(index.entries.map((entry: any) => [entry.workspaceId, entry.hostId]), [[local, 'local-host'], [remote, 'peer-1']])
  assert.ok((await f.call<any>('debug')).workspaces.some((workspace: any) => workspace.workspaceId === remote))
  assert.equal(assistantWorkspaceMatches(createVirtualWorkspaceId('peer-2', 'remote-project'), 'peer-1', 'remote-project'), false)
  assert.equal(assistantWorkspaceMatches(createVirtualWorkspaceId('local', 'remote-project'), 'peer-1', 'remote-project'), false)
  assert.equal(assistantWorkspaceMatches('peer-1:remote-project', 'peer-1', 'remote-project'), true)
})
