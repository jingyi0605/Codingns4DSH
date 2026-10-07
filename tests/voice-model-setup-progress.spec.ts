import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoiceModelSetupProgress, VoiceModelManagerView } from '../data/build/dist/client/features/voice-initialization-dialog.js'
import { watchVoiceModelSetupProgress } from '../data/build/dist/client/voice-model-setup-progress.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import { ASSISTANT_VOICE_MODEL_CATALOG, type AssistantVoiceModelProgress, type AssistantVoiceModelsSnapshot } from '../data/build/dist/shared/voice-models.js'
import type { CodingNsRpcResult } from '../data/build/dist/client/features/types.js'

const progress: AssistantVoiceModelProgress = {
  modelId: 'model-a', phase: 'downloading', fileName: 'encoder.int8.onnx', fileIndex: 1,
  fileCount: 4, downloadedBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024,
}
const render = (value: AssistantVoiceModelProgress | undefined) => renderToStaticMarkup(createElement(VoiceModelSetupProgress, { progress: value, t: resolveCodingNsTranslator() }))
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('下载界面显示文件进度、序号、文件名和真实下载量', () => {
  const markup = render(progress)
  assert.match(markup, /<progress[^>]*value="50"/u)
  for (const text of ['正在下载文件（1/4）', '当前文件：50%', 'encoder.int8.onnx', '1.0 MB / 2.0 MB', '当前文件下载进度']) assert.ok(markup.includes(text), text)
})

test('未知大小使用不定进度条，下载完成后明确显示仍在初始化', () => {
  const unknown = render({ ...progress, totalBytes: null })
  assert.match(unknown, /<progress/u)
  assert.doesNotMatch(unknown, /<progress[^>]*value=/u)
  assert.ok(unknown.includes('已下载 1.0 MB'))
  assert.ok(!unknown.includes('50%'))
  const initializing = render({ ...progress, phase: 'initializing', fileName: null })
  assert.ok(initializing.includes('模型已下载，正在初始化'))
  assert.match(initializing, /<progress[^>]*value="100"/u)
  assert.ok(!initializing.includes('初始化完成'))
  const checking = render(undefined)
  assert.ok(checking.includes('正在检查本地模型文件'))
  assert.doesNotMatch(checking, /<progress[^>]*value=/u)
  const verifying = render({ ...progress, phase: 'verifying' })
  assert.ok(verifying.includes('正在加载模型并验证识别能力'))
  assert.doesNotMatch(verifying, /<progress[^>]*value=/u)
  assert.ok(!verifying.includes('验证通过'))
})

function modelsFixture(): AssistantVoiceModelsSnapshot {
  return {
    currentModelId: ASSISTANT_VOICE_MODEL_CATALOG[0]!.id,
    runtimeRunning: false, runtimeReady: false, operation: null,
    models: ASSISTANT_VOICE_MODEL_CATALOG.map((model, index) => ({
      modelId: model.id, current: index === 0, state: 'downloaded', totalBytes: 12,
      files: model.files.map((file) => ({ name: file.name, path: `/fixture/${model.id}/${file.name}`, present: true, bytes: 3, partialBytes: 0 })),
      validation: { state: index === 0 ? 'passed' : 'unchecked', checkedAt: index === 0 ? Date.now() : null, error: null },
    })),
  }
}
function renderManager(snapshot: AssistantVoiceModelsSnapshot | undefined, index = 0, embedded = false, enabled = true) {
  return renderToStaticMarkup(createElement(VoiceModelManagerView, {
    snapshot, modelId: ASSISTANT_VOICE_MODEL_CATALOG[index]!.id, refreshing: false, busy: undefined,
    progress: undefined, error: undefined, success: undefined, writable: true,
    onSelect() {}, onRefresh() {}, onRun() {}, ...(embedded ? {} : { onClose() {} }), enabled, t: resolveCodingNsTranslator(),
  }))
}
function buttons(markup: string) {
  return new Map([...markup.matchAll(/<button([^>]*)>([^<]*)<\/button>/gu)].map((match) => [match[2]!, match[1]!.includes('disabled')]))
}

test('模型管理卡片区分下载、当前使用和验证状态，选择其他模型不会显示已启用', () => {
  const fixture = modelsFixture()
  const markup = renderManager(fixture, 1)
  for (const text of ['语音模型管理', '已下载', '当前使用', '验证通过', '尚未验证', '文件详情与保存位置', '4/4 个文件']) assert.ok(markup.includes(text), text)
  assert.ok(!markup.includes('<select'))
  assert.equal((markup.match(/type="radio"/gu) ?? []).length, ASSISTANT_VOICE_MODEL_CATALOG.length)
  assert.equal(buttons(markup).get('验证并使用'), false)
  assert.equal(buttons(markup).get('验证可用性'), false)
  assert.equal(buttons(renderManager(fixture)).get('当前使用'), true)
  // 使用既有模型构造缺失文件，不依赖其他会话新增的目录条目。
  const partial = { ...fixture, models: fixture.models.map((model, index) => index !== 1 ? model : {
    ...model, state: 'partial' as const, totalBytes: 6,
    files: model.files.map((file, fileIndex) => ({ ...file, present: fileIndex < 2, bytes: fileIndex < 2 ? 3 : 0 })),
  }) }
  const partialMarkup = renderManager(partial, 1)
  for (const text of ['文件不完整', '2/4 个文件']) assert.ok(partialMarkup.includes(text), text)
  assert.equal(buttons(partialMarkup).get('补全下载并使用'), false)
  assert.equal(buttons(partialMarkup).get('验证可用性'), true)
})

test('运行中的语音允许独立验证但禁止切换；状态未知和其他页面操作时禁止写操作', () => {
  const fixture = modelsFixture()
  const active = buttons(renderManager({ ...fixture, runtimeRunning: true }, 1))
  assert.equal(active.get('验证可用性'), false)
  assert.equal(active.get('验证并使用'), true)
  assert.equal(active.get('重新下载'), true)
  const pending = buttons(renderManager({ ...fixture, operation: { modelId: fixture.models[0]!.modelId, kind: 'repair' } }, 1))
  assert.equal(pending.get('验证并使用'), true)
  assert.equal(pending.get('验证可用性'), true)
  assert.equal(pending.get('关闭'), false)
  const unloaded = renderManager(undefined)
  assert.ok(unloaded.includes('状态待查询'))
  assert.ok(!unloaded.includes('未下载'))
  assert.equal(buttons(unloaded).get('下载并使用'), true)
})

test('内嵌识别设置保留完整管理能力，父页锁定时禁止验证、应用和选择', () => {
  const snapshot = modelsFixture()
  const markup = renderManager(snapshot, 1, true)
  for (const text of ['语音识别模型', '将麦克风语音转换为文字', '当前模型', '中文轻量实时模型']) assert.ok(markup.includes(text), text)
  assert.equal(buttons(markup).get('验证并使用'), false)
  assert.equal(buttons(markup).get('验证可用性'), false)
  assert.equal(buttons(markup).has('关闭'), false)
  assert.ok(!markup.includes('overflow-y:auto'), '内嵌面板使用工作台的正文滚动，不增加嵌套滚动区')
  const locked = renderManager(snapshot, 1, true, false)
  for (const action of ['重新下载', '验证可用性', '验证并使用']) assert.equal(buttons(locked).get(action), true, action)
  assert.equal((locked.match(/type="radio"[^>]*disabled=""/gu) ?? []).length, ASSISTANT_VOICE_MODEL_CATALOG.length)
  assert.equal(buttons(locked).get('刷新状态'), false, '锁定写操作仍允许读取状态')
})

test('进度查询带请求标识且不并发积压，停止后忽略在途响应并取消查询', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let finish!: (result: CodingNsRpcResult) => void
  let signal: AbortSignal | undefined
  const seen: AssistantVoiceModelProgress[] = []
  const stop = watchVoiceModelSetupProgress({ call: async (channel, endpoint, payload, requestSignal) => {
    calls += 1
    assert.equal(channel, '/codingns')
    assert.equal(endpoint, 'assistant/voice/setup-progress')
    assert.deepEqual(payload, { modelId: 'model-a', requestId: 'request-a' })
    signal = requestSignal
    return new Promise((resolve) => { finish = resolve })
  } }, { modelId: 'model-a', requestId: 'request-a' }, (value) => seen.push(value))
  t.after(stop)
  t.mock.timers.tick(3000)
  assert.equal(calls, 1)
  finish({ ok: true, value: progress })
  await flush()
  assert.deepEqual(seen, [progress])
  t.mock.timers.tick(300)
  assert.equal(calls, 2)
  stop()
  assert.equal(signal?.aborted, true)
  finish({ ok: true, value: { ...progress, downloadedBytes: 2 * 1024 * 1024 } })
  await flush()
  t.mock.timers.tick(3000)
  assert.equal(calls, 2)
  assert.deepEqual(seen, [progress])
})

test('暂无状态、其他模型和暂时查询失败都能继续刷新进度', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const seen: AssistantVoiceModelProgress[] = []
  const stop = watchVoiceModelSetupProgress({ call: async () => {
    calls += 1
    if (calls === 1) return { ok: true, value: null }
    if (calls === 2) return { ok: true, value: { ...progress, modelId: 'other' } }
    if (calls === 3) throw new Error('网络暂时不可用')
    if (calls === 4) return { ok: false, error: { code: 'UNAVAILABLE', message: '暂时不可用' } }
    return { ok: true, value: progress }
  } }, { modelId: 'model-a', requestId: 'request-a' }, (value) => seen.push(value))
  t.after(stop)
  await flush()
  for (let index = 0; index < 4; index += 1) { t.mock.timers.tick(300); await flush() }
  assert.equal(calls, 5)
  assert.deepEqual(seen, [progress])
  stop()
  t.mock.timers.tick(3000)
  assert.equal(calls, 5)
})
