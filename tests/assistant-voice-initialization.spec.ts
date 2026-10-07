import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantVoiceInitialization } from '../src/host/features/assistant-voice-initialization.js'
import { DEFAULT_LIGHT_VOICE_MODEL_ID } from '../src/shared/voice-initialization.js'
import { DEFAULT_ASSISTANT_TTS_SETTINGS, MOSS_BUILTIN_VOICES, type AssistantTtsSnapshot } from '../src/shared/assistant-tts.js'
import { ASSISTANT_VOICE_MODEL_CATALOG, type AssistantVoiceModelsSnapshot } from '../src/shared/voice-models.js'

function fixture(existing = false) {
  let modelId: string | null = existing ? ASSISTANT_VOICE_MODEL_CATALOG[0]!.id : null
  let modelReady = existing; let speechReady = false; let fail = false
  let settings = { ...DEFAULT_ASSISTANT_TTS_SETTINGS, selectedId: 'moss:Lingyu', parameters: { ...DEFAULT_ASSISTANT_TTS_SETTINGS.parameters!, rate: 1.25 } }
  const calls: string[] = []
  const readModels = async (): Promise<AssistantVoiceModelsSnapshot> => ({ currentModelId: modelId, runtimeRunning: false, runtimeReady: false, operation: null,
    models: ASSISTANT_VOICE_MODEL_CATALOG.map((model) => ({ modelId: model.id, current: model.id === modelId, state: model.id === modelId && modelReady ? 'downloaded' : 'missing',
      totalBytes: 0, files: [], validation: { state: model.id === modelId && modelReady ? 'passed' : 'unchecked', checkedAt: null, error: null } })) })
  const readTts = async (): Promise<AssistantTtsSnapshot> => ({ settings, voices: MOSS_BUILTIN_VOICES,
    status: { ready: speechReady, busy: false, phase: '', downloadedBytes: 0, totalBytes: null, error: null } })
  const service = new AssistantVoiceInitialization({ readModels, readTts, modelProgress: () => null, active: () => false,
    prepareModel: async (id) => { calls.push(`model:${id}`); modelId = id; modelReady = true },
    prepareTts: async () => { calls.push('speech'); if (fail) throw new Error('网络中断'); speechReady = true },
    selectTts: async (id) => { calls.push(`select:${id}`); settings = { ...settings, selectedId: id, backend: 'moss-onnx' } },
  })
  return { service, calls, settings: () => settings, fail: (value: boolean) => { fail = value } }
}

test('查看向导不下载；点击初始化默认中英双语，保留音色和语速，重复初始化复用资源', async () => {
  const f = fixture()
  assert.equal((await f.service.snapshot()).ready, false); assert.deepEqual(f.calls, [])
  assert.equal((await f.service.initialize(new AbortController().signal)).ready, true)
  assert.deepEqual(f.calls, [`model:${DEFAULT_LIGHT_VOICE_MODEL_ID}`, 'speech', 'select:moss:Lingyu'])
  assert.equal(f.settings().parameters.rate, 1.25)
  await f.service.initialize(new AbortController().signal)
  assert.equal(f.calls.length, 3)
})

test('已有 Large 识别选择继续复用，播报失败后重试不重新准备识别', async () => {
  const f = fixture(true); f.fail(true)
  await assert.rejects(f.service.initialize(new AbortController().signal), /网络中断/u)
  const failed = await f.service.snapshot()
  assert.equal(failed.modelId, ASSISTANT_VOICE_MODEL_CATALOG[0]!.id); assert.equal(failed.recognitionReady, true)
  assert.equal(failed.busy, false); assert.equal(failed.phase, 'failed'); assert.equal(f.settings().backend, 'browser')
  f.fail(false)
  assert.equal((await f.service.initialize(new AbortController().signal)).ready, true)
  assert.deepEqual(f.calls, ['speech', 'speech', 'select:moss:Lingyu'])
})

test('初始化取消不切播报后端，重复请求被拒绝，重置清除向导错误', async () => {
  const f = fixture(); const abort = new AbortController()
  const pending = f.service.initialize(abort.signal)
  await assert.rejects(f.service.initialize(abort.signal), /正在进行/u)
  abort.abort(new Error('助理已重置'))
  await assert.rejects(pending, /重置/u)
  assert.equal(f.settings().backend, 'browser'); assert.equal(f.service.busy, false)
  f.service.reset(); assert.equal((await f.service.snapshot()).error, null)
})
