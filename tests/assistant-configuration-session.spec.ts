import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantConfigurationSession } from '../src/client/features/assistant-configuration-session.js'
import { readAssistantDraft, assistantDraftPayload } from '../src/client/features/assistant-workbench.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { DEFAULT_ASSISTANT_TTS_SETTINGS, MOSS_BUILTIN_VOICES } from '../src/shared/assistant-tts.js'
import { normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { getAssistantAvatarManager } from '../src/client/avatar/manager.js'
import { registerGlobalVoiceAdapter } from '../src/client/global-voice-runtime-registry.js'
import type { GlobalVoiceAdapter } from '../src/client/global-voice-runtime-registry.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import { CODINGNS_RPC_CHANNEL } from '../src/shared/contracts/transport.js'

function fixture(prepareOnly = true) {
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  value.assistant.profile = { name: '哆哆', initialized: true, createdAt: 1 }
  value.assistant.appearance = normalizeAssistantAppearance()
  value.assistant.tts = structuredClone(DEFAULT_ASSISTANT_TTS_SETTINGS)
  let snapshot = { value, status: 'ready' as const, writable: true, revision: 1 }, writes = 0
  const requests: { endpoint: string; payload: any }[] = [], devices: string[] = []
  const services = { settings: { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => { writes++; return true } },
    rpc: { async call(_channel: string, endpoint: string, payload: any) {
      requests.push({ endpoint, payload })
      if (endpoint === 'assistant/configuration/capabilities') return { ok: true, value: { prepareOnly } }
      if (endpoint.startsWith('assistant/tts/')) return { ok: true, value: { settings: value.assistant.tts, voices: MOSS_BUILTIN_VOICES, status: { ready: true } } }
      if (endpoint === 'assistant/voice/setup') return { ok: true, value: { voice: { ...value.assistant.voice, initialized: true, modelId: payload.modelId } } }
      return { ok: true, value: [] }
    } }, locale: { bind: () => (key: string) => key, subscribe: () => () => {}, getSnapshot: () => 'zh' },
  } as unknown as CodingNsClientServices
  const release = registerGlobalVoiceAdapter(services, { inputDeviceId: 'old', outputDeviceId: '',
    selectInputDevice: async (id: string) => { devices.push(id) }, selectOutputDevice: async (id: string) => { devices.push(id) },
  } as unknown as GlobalVoiceAdapter)
  const session = new AssistantConfigurationSession(services)
  return { session, services, requests, devices, writes: () => writes, value,
    external: () => { snapshot = { ...snapshot, revision: snapshot.revision + 1 }; session.sync() },
    readonly: () => { snapshot = { ...snapshot, writable: false }; session.sync() },
    dispose: () => { session.dispose(); release() } }
}

test('形象开关、大小与选择只写草稿，取消恢复正式配置', async (t) => {
  const f = fixture(); t.after(f.dispose)
  const manager = getAssistantAvatarManager(f.session.services)
  await manager.configure({ floatingEnabled: true, dialogEnabled: false, floatingSize: 72 })
  await manager.select('codingns-basic-male')
  assert.equal(manager.getSelected().id, 'codingns-basic-male')
  assert.equal(f.value.assistant.appearance!.selectedId, 'codingns-default')
  assert.equal(f.value.assistant.appearance!.floatingEnabled, false)
  assert.equal(f.writes(), 0); assert.equal(f.requests.length, 0)
  assert.equal(f.session.configurationPatch().length, 1)
  f.session.reset()
  assert.equal(manager.getSelected().id, 'codingns-default')
  assert.equal(manager.getAppearance().floatingEnabled, false)
})

test('后台刷新保留模型草稿与显式跟随默认，同时保留未编辑的外部字段', async (t) => {
  const f = fixture(); t.after(f.dispose)
  await f.session.set('assistant.model', { provider: 'api', model: 'fixed' })
  f.value.assistant.model = { provider: 'api', model: 'external' }
  f.value.assistant.managedWorkspaceIds = ['new-project']; f.external()
  const draft = readAssistantDraft(f.session.getSnapshot().value!.assistant)
  assert.deepEqual(assistantDraftPayload(draft).model, { provider: 'api', model: 'fixed' })
  assert.deepEqual(draft.managedWorkspaceIds, ['new-project'])
  await f.session.unset('assistant.model'); f.external()
  assert.equal(assistantDraftPayload(readAssistantDraft(f.session.getSnapshot().value!.assistant)).model, null)
  assert.equal(f.value.assistant.model.model, 'external'); assert.equal(f.writes(), 0)
})

test('跨标签反复编辑同一形象字段后，刷新按最后编辑顺序保留草稿', async (t) => {
  const f = fixture(); t.after(f.dispose)
  await f.session.set('assistant.appearance.selectedId', 'codingns-basic-male')
  await getAssistantAvatarManager(f.session.services).configure({ floatingEnabled: true })
  await f.session.set('assistant.appearance.selectedId', 'codingns-default')
  f.external()
  assert.equal(f.session.getSnapshot().value!.assistant.appearance!.selectedId, 'codingns-default')
  assert.equal(f.session.getSnapshot().value!.assistant.appearance!.floatingEnabled, true)
  assert.equal(f.value.assistant.appearance!.floatingEnabled, false)
})

test('旧 Host 不支持资源草稿时提前拒绝，不能发送会立即启用的旧操作', async (t) => {
  const f = fixture(false); t.after(f.dispose)
  const result = await f.session.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/setup', { modelId: 'test' })
  assert.equal(result.ok, false)
  assert.deepEqual(f.requests.map((request) => request.endpoint), ['assistant/configuration/capabilities'])
  assert.equal(f.value.assistant.voice.initialized, false)
})

test('资源准备期间阻止保存，取消后迟到结果不能恢复草稿，关闭后仍可释放预览', async (t) => {
  const f = fixture(); t.after(f.dispose)
  const originalCall = f.services.rpc.call
  let finish!: (result: any) => void, started!: () => void
  const waiting = new Promise<void>((resolve) => { started = resolve })
  f.services.rpc.call = async (channel, endpoint, payload, signal) => {
    if (endpoint !== 'assistant/voice/setup') return originalCall(channel, endpoint, payload, signal)
    started(); return new Promise((resolve) => { finish = resolve })
  }
  const pending = f.session.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/setup', { modelId: 'test' })
  const rejected = assert.rejects(pending, /abort/iu)
  await waiting; assert.equal(f.session.getSnapshot().preparing, true)
  f.session.reset()
  finish({ ok: true, value: { voice: { ...f.value.assistant.voice, initialized: true, modelId: 'test' } } })
  await rejected
  assert.equal(f.session.getSnapshot().preparing, false)
  assert.equal(f.session.getSnapshot().value!.assistant.voice.initialized, false)
  f.session.dispose()
  await f.session.services.rpc.call(CODINGNS_RPC_CHANNEL, 'avatar/releasePreview', { lease: 'lease' })
  assert.equal(f.requests.at(-1)!.endpoint, 'avatar/releasePreview')
})

test('音色、参数和设备不立即应用，资源准备显式传 prepareOnly', async (t) => {
  const f = fixture(); t.after(f.dispose)
  await f.session.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/tts/select', { id: 'moss:Lingyu', backend: 'browser' })
  await f.session.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/tts/configure', { parameters: { rate: 1.5 } })
  const { getGlobalVoiceAdapter } = await import('../src/client/global-voice-runtime-registry.js')
  await getGlobalVoiceAdapter(f.session.services)!.selectInputDevice('new-mic')
  assert.deepEqual(f.devices, [])
  assert.equal(f.value.assistant.tts!.selectedId, 'moss:Junhao')
  assert.equal(f.session.getSnapshot().value!.assistant.tts!.selectedId, 'moss:Lingyu')
  assert.equal(f.session.getSnapshot().value!.assistant.tts!.parameters!.rate, 1.5)
  assert.ok(!f.requests.some((call) => /select|configure/u.test(call.endpoint)))
  await f.session.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/setup', { modelId: 'test-model' })
  assert.equal(f.requests.at(-1)!.payload.prepareOnly, true)
  assert.equal(f.value.assistant.voice.initialized, false)
  await f.session.commitLocal(new AbortController().signal)
  assert.deepEqual(f.devices, ['new-mic']); assert.equal(f.writes(), 0)
})

test('只读禁止草稿修改，非法路径不能污染原型；首次第三方协议等待统一保存', async (t) => {
  const f = fixture(); t.after(f.dispose)
  await getAssistantAvatarManager(f.session.services).setThirdPartyEnabled(true)
  const catalog = await f.session.services.rpc.call(CODINGNS_RPC_CHANNEL, 'avatar/catalog', {})
  assert.deepEqual(catalog, { ok: true, value: [] }); assert.equal(f.requests.length, 0)
  await assert.rejects(f.session.set('assistant.constructor.prototype.polluted', true), /草稿/u)
  assert.equal(({} as any).polluted, undefined)
  f.readonly(); await assert.rejects(f.session.set('assistant.model', { provider: 'api', model: 'fixed' }), /不可写/u)
})
