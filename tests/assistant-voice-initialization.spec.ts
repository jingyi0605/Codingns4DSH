import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantVoiceInitialization } from '../src/host/features/assistant-voice-initialization.js'
import { AssistantVoiceInitializationView } from '../src/client/features/assistant-voice-initialization.js'
import { AssistantVoiceSettingsGroupView } from '../src/client/features/assistant-voice-settings-group.js'
import { DEFAULT_LIGHT_VOICE_MODEL_ID } from '../src/shared/voice-initialization.js'
import { DEFAULT_ASSISTANT_TTS_SETTINGS, MOSS_BUILTIN_VOICES, type AssistantTtsSnapshot } from '../src/shared/assistant-tts.js'
import { ASSISTANT_VOICE_MODEL_CATALOG, type AssistantVoiceModelsSnapshot } from '../src/shared/voice-models.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'

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

test('首次向导无必填输入，真实未知总量使用不定进度，失败可重试，完成可试听', async () => {
  const f = fixture()
  const props = { pending: false, error: '', disabled: false, speaking: false, t: resolveCodingNsTranslator(), onInitialize() {}, onListen() {}, onRefresh() {} }
  const first = renderToStaticMarkup(createElement(AssistantVoiceInitializationView, { ...props, snapshot: await f.service.snapshot() }))
  assert.ok(first.includes('启用语音')); assert.ok(first.includes('Lingyu')); assert.ok(!first.includes('<input')); assert.ok(!first.includes('<select'))
  const preparing = renderToStaticMarkup(createElement(AssistantVoiceInitializationView, { ...props, snapshot: { ...await f.service.snapshot(), busy: true,
    progress: { label: 'downloading', downloadedBytes: 500, totalBytes: null } } }))
  assert.match(preparing, /<progress[^>]*>/u); assert.ok(!preparing.match(/<progress[^>]*value=/u)); assert.ok(preparing.includes('disabled=""'))
  f.fail(true); await assert.rejects(f.service.initialize(new AbortController().signal))
  const failed = renderToStaticMarkup(createElement(AssistantVoiceInitializationView, { ...props, snapshot: await f.service.snapshot() }))
  assert.ok(failed.includes('重试配置')); assert.ok(failed.includes('网络中断'))
  f.fail(false); await f.service.initialize(new AbortController().signal)
  const completed = renderToStaticMarkup(createElement(AssistantVoiceInitializationView, { ...props, snapshot: await f.service.snapshot() }))
  assert.ok(completed.includes('语音已就绪')); assert.ok(completed.includes('试听声音')); assert.ok(!completed.includes('启用语音'))
})

test('输入输出独立折叠，收起保留草稿但停用试听，初始化时锁定内部设置', () => {
  const t = resolveCodingNsTranslator()
  const activations: boolean[] = []; const changes: boolean[] = []
  const props = { kind: 'output' as const, hint: 'Junhao', active: true, disabled: false, t,
    renderContent: (active: boolean) => { activations.push(active); return createElement('input', { defaultValue: '保留的试听草稿' }) },
    onToggle: (expanded: boolean) => changes.push(expanded) }
  for (const expanded of [false, true, false]) {
    const markup = renderToStaticMarkup(createElement(AssistantVoiceSettingsGroupView, { ...props, expanded }))
    assert.ok(markup.includes('保留的试听草稿'), '折叠只隐藏，不卸载草稿控件')
    assert.equal(/<details[^>]*open=""/u.test(markup), expanded)
    assert.ok(markup.includes('语音输出')); assert.ok(markup.includes('Junhao'))
  }
  assert.deepEqual(activations, [false, true, false])
  renderToStaticMarkup(createElement(AssistantVoiceSettingsGroupView, { ...props, active: false, expanded: true }))
  assert.equal(activations.at(-1), false, '切到其他标签后停止试听')
  const locked = renderToStaticMarkup(createElement(AssistantVoiceSettingsGroupView, { ...props, disabled: true, expanded: true }))
  assert.match(locked, /<fieldset[^>]*disabled=""/u)
  const group = AssistantVoiceSettingsGroupView({ ...props, expanded: false })
  group.props.onToggle({ currentTarget: { open: true } }); group.props.onToggle({ currentTarget: { open: false } })
  assert.deepEqual(changes, [true, false], '原生鼠标及键盘折叠事件同步活动状态')
})
