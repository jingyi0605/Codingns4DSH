import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AssistantTtsService } from '../src/host/features/assistant-tts-service.js'
import { MossTtsWorker } from '../src/host/features/moss-tts-worker.js'
import { ASSISTANT_TTS_PATH, ASSISTANT_VOICE_SAMPLE_PATH, MOSS_CODEC_REVISION, MOSS_TTS_REVISION } from '../src/shared/assistant-tts.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'

async function fixture(t: any, ready = true, options: NonNullable<ConstructorParameters<typeof AssistantTtsService>[1]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-tts-test-'))
  let value: any = { assistant: { managedWorkspaceIds: [], voice: {} } }
  const services = { settings: { get: () => value, update: async (patch: any) => { value = { ...value, ...patch } } } } as unknown as CodingNsHostServices
  const service = new AssistantTtsService(services, { ...options, directory })
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }) })
  if (ready) {
    const files = [join('venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      ...['browser_poc_manifest.json', 'tts_browser_onnx_meta.json', 'tokenizer.model', 'moss_tts_prefill.onnx', 'moss_tts_decode_step.onnx', 'moss_tts_local_fixed_sampled_frame.onnx', 'moss_tts_global_shared.data', 'moss_tts_local_shared.data'].map((name) => join('MOSS-TTS-Nano-100M-ONNX', name)),
      ...['codec_browser_onnx_meta.json', 'moss_audio_tokenizer_encode.onnx', 'moss_audio_tokenizer_encode.data', 'moss_audio_tokenizer_decode_step.onnx', 'moss_audio_tokenizer_decode_shared.data'].map((name) => join('MOSS-Audio-Tokenizer-Nano-ONNX', name))]
    for (const file of files) { const path = join(directory, file); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'fixture') }
    await writeFile(join(directory, 'ready.json'), JSON.stringify({ tts: MOSS_TTS_REVISION, codec: MOSS_CODEC_REVISION }))
  }
  return { service, directory, value: () => value }
}
function request(payload: unknown, signal?: AbortSignal): Request {
  return new Request(`https://example.test${ASSISTANT_TTS_PATH}`, { method: 'POST', body: JSON.stringify(payload), ...(signal === undefined ? {} : { signal }) })
}

test('通话预热不阻塞首句，同一租约复用安装验证，试听与新通话重新检查', async (t) => {
  const { service } = await fixture(t, true, { isVoiceActive: () => true })
  await service.handle('tts/select', { id: 'moss:Junhao', backend: 'moss-onnx' })
  const installed = (service as any).isInstalled.bind(service)
  let validations = 0; let warmups = 0; let release!: () => void
  const workers = new Set<MossTtsWorker>()
  let warmSignal: AbortSignal | undefined
  t.mock.method(service as any, 'isInstalled', async () => { validations++; return installed() })
  t.mock.method(MossTtsWorker.prototype, 'prepare', async function (this: MossTtsWorker, signal) { workers.add(this); warmups++; warmSignal = signal; await new Promise<void>((resolve) => { release = resolve }) })
  t.mock.method(MossTtsWorker.prototype, 'request', async function (this: MossTtsWorker, _action, _payload, audio) { workers.add(this); audio!({ bytes: new Uint8Array([0, 0]), sampleRate: 48000 }); return {} })
  service.beginVoiceSession('page')
  service.beginVoiceSession('page')
  await (await service.http(request({ text: '第一句', ownerId: 'page' }))).text()
  await (await service.http(request({ text: '第二句', ownerId: 'page' }))).text()
  assert.equal(warmups, 1); assert.equal(validations, 1, '预热尚未结算也不阻塞首句，逐句不重复检查磁盘')
  assert.equal(workers.size, 1, '异步脚本定位期间预热与首句必须共享同一个 Worker 实例')
  release(); await new Promise<void>((resolve) => setImmediate(resolve))
  await (await service.http(request({ text: '独立试听' }))).text()
  await (await service.http(request({ text: '其他页面', ownerId: 'other' }))).text()
  assert.equal(validations, 3)
  service.endVoiceSession()
  assert.equal(warmSignal?.aborted, true)
  service.beginVoiceSession('new-page')
  await (await service.http(request({ text: '下一次通话', ownerId: 'new-page' }))).text()
  assert.equal(validations, 4); assert.equal(warmups, 2)
  release()
})

test('推理失败使通话安装缓存失效，下一句重新验证；浏览器后端不预热', async (t) => {
  const { service } = await fixture(t, true, { isVoiceActive: () => true })
  let warmups = 0; let validations = 0
  t.mock.method(MossTtsWorker.prototype, 'prepare', async () => { warmups++ })
  service.beginVoiceSession('browser')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(warmups, 0)
  await service.handle('tts/select', { id: 'moss:Junhao', backend: 'moss-onnx' })
  const installed = (service as any).isInstalled.bind(service)
  t.mock.method(service as any, 'isInstalled', async () => { validations++; return installed() })
  let failed = false
  t.mock.method(MossTtsWorker.prototype, 'request', async (_action, _payload, audio) => {
    if (!failed) { failed = true; throw new Error('模型读取失败') }
    audio!({ bytes: new Uint8Array([0, 0]), sampleRate: 48000 }); return {}
  })
  service.beginVoiceSession('page')
  assert.match(await (await service.http(request({ text: '失败句', ownerId: 'page' }))).text(), /模型读取失败/u)
  await (await service.http(request({ text: '重试句', ownerId: 'page' }))).text()
  assert.equal(validations, 2)
})

test('配置窗口导入只准备音色缓存，待保存的音色返回给草稿，正式后端和选择不变', async (t) => {
  const { service, value } = await fixture(t)
  t.mock.method(globalThis, 'fetch', async () => new Response('RIFF0000WAVEfixture'))
  t.mock.method(MossTtsWorker.prototype, 'request', async (_action, payload: any) => { await writeFile(payload.codesPath, '[[1,2,3]]'); return { duration: 5 } })
  const prepared = await service.handle('tts/import', { source: 'aishell:SSB00050001', prepareOnly: true }) as any
  assert.equal(prepared.settings.voices.length, 1)
  assert.equal(prepared.settings.selectedId, prepared.settings.voices[0].id)
  assert.equal(prepared.settings.backend, 'moss-onnx')
  assert.equal(value().assistant.tts, undefined)
  assert.equal((await service.snapshot()).settings.backend, 'browser')
})

test('初始化在下载模型前检查推理依赖，失败不切换后端，修复后可重试并完成图验证', async (t) => {
  const phases: string[] = []
  let dependencyFailure = true
  let downloads = 0
  const { service, directory, value } = await fixture(t, false, {
    preparePython: async (directory, signal) => {
      signal.throwIfAborted(); phases.push('python')
      const python = join(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      await mkdir(join(python, '..'), { recursive: true }); await writeFile(python, 'fixture')
      return python
    },
    runEnvironmentProcess: async (_command, args, signal) => {
      signal.throwIfAborted()
      const phase = args.includes('ensurepip') ? 'ensurepip' : args.includes('pip') ? 'pip' : 'dependencies'
      phases.push(phase)
      if (phase === 'dependencies' && dependencyFailure) throw new Error('DLL load failed：缺少依赖模块')
    },
  })
  t.mock.method(globalThis, 'fetch', async () => { downloads++; phases.push('download'); return new Response('fixture') })
  t.mock.method(MossTtsWorker.prototype, 'request', async (action) => { assert.equal(action, 'probe'); phases.push('model-probe'); return {} })
  await service.handle('tts/configure', { parameters: { rate: 1.25 } })
  const previous = JSON.stringify(value())
  await assert.rejects(service.handle('tts/setup', {}), /缺少依赖模块/u)
  assert.deepEqual(phases, ['python', 'ensurepip', 'pip', 'dependencies'])
  assert.equal(downloads, 0); assert.equal(JSON.stringify(value()), previous)
  assert.equal((await service.snapshot()).status.ready, false)
  assert.ok(!(await readdir(directory)).includes('ready.json'))
  dependencyFailure = false; phases.length = 0
  const result = await service.handle('tts/setup', {}) as any
  assert.deepEqual(phases.slice(0, 4), ['python', 'ensurepip', 'pip', 'dependencies'])
  assert.equal(downloads, 13); assert.equal(phases.at(-1), 'model-probe')
  assert.equal(result.status.ready, true); assert.equal(result.status.busy, false)
  assert.equal(value().assistant.tts.backend, 'moss-onnx'); assert.equal(value().assistant.tts.parameters.rate, 1.25)
})

test('重新初始化等待旧工作进程关闭后再操作环境和模型，避免 Windows 文件锁竞争', async (t) => {
  let prepares = 0
  const { service, directory } = await fixture(t, true, {
    preparePython: async () => { prepares++; throw new Error('预期停止：仅验证初始化时序') },
  })
  t.mock.method(MossTtsWorker.prototype, 'request', async () => ({}))
  await (await service.http(request({ text: '创建旧工作进程' }))).text()
  let began!: () => void; let release!: () => void
  const closing = new Promise<void>((resolve) => { began = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const dispose = MossTtsWorker.prototype.dispose
  t.mock.method(MossTtsWorker.prototype, 'dispose', async function (this: MossTtsWorker) {
    began(); await gate; await dispose.call(this)
  })
  const setup = service.handle('tts/setup', {})
  const rejected = assert.rejects(setup, /预期停止/u)
  try {
    await closing
    assert.equal(prepares, 0)
    // 模型与就绪标记在旧进程仍持有句柄期间保持原样。
    assert.ok((await readdir(directory)).includes('ready.json'))
  } finally { release() }
  await rejected
  assert.equal(prepares, 1)
})

test('初始化前仍有完整预设，应用 MOSS 被拒绝且旧后端不变', async (t) => {
  const { service, value } = await fixture(t, false)
  const snapshot = await service.snapshot()
  assert.equal(snapshot.voices.length, 18); assert.equal(snapshot.status.ready, false)
  await assert.rejects(service.handle('tts/select', { id: 'moss:Lingyu' }), /初始化/u)
  assert.equal(value().assistant.tts, undefined)
  await service.handle('tts/select', { id: 'moss:Lingyu', backend: 'browser' })
  assert.equal(value().assistant.tts.backend, 'browser')
  assert.equal((await service.http(request({ text: '你好' }))).status, 400)
})

test('完整重置撤销正在编码的导入，等待旧操作结算后恢复服务并保留已有模型素材', async (t) => {
  const { service, directory, value } = await fixture(t)
  let started!: () => void; let release!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.mock.method(globalThis, 'fetch', async () => new Response('RIFF0000WAVEfixture'))
  t.mock.method(MossTtsWorker.prototype, 'request', async (_action, payload: any) => {
    started(); await gate; await writeFile(payload.codesPath, '[[1,2,3]]'); return { duration: 5 }
  })
  const importing = service.handle('tts/import', { source: 'aishell:SSB00050001' })
  const rejected = assert.rejects(importing, /重置/u)
  await began
  const resetting = service.cancelPending()
  release(); await rejected; await resetting
  assert.equal(value().assistant.tts, undefined)
  assert.ok((await readdir(directory)).includes('ready.json'))
  assert.equal((await service.snapshot()).status.ready, true)
  await service.handle('tts/select', { id: 'moss:Lingyu', backend: 'browser' })
  assert.equal(value().assistant.tts.backend, 'browser')
})

test('成功导入缓存录音和编码，并立即应用；失败重导入保留旧缓存和设置', async (t) => {
  const { service, directory, value } = await fixture(t)
  t.mock.method(globalThis, 'fetch', async () => new Response('RIFF0000WAVEfixture', { headers: { 'content-length': '19' } }))
  let fail = false
  t.mock.method(MossTtsWorker.prototype, 'request', async (_action, payload: any) => {
    if (fail) throw new Error('invalid audio fixture')
    await writeFile(payload.codesPath, '[[1,2,3]]'); return { duration: 5 }
  })
  await service.handle('tts/import', { source: 'aishell:SSB00050001', name: '普通话女声', gender: 'female' })
  const voice = value().assistant.tts.voices[0]
  assert.equal(voice.language, 'zh'); assert.equal(voice.gender, 'female'); assert.equal(voice.license, 'Apache-2.0')
  assert.equal(value().assistant.tts.selectedId, voice.id); assert.equal(value().assistant.tts.backend, 'moss-onnx')
  const previous = await readFile(join(directory, `${voice.id}.audio`))
  const settings = JSON.stringify(value())
  fail = true
  await assert.rejects(service.handle('tts/import', { source: voice.source, name: '不应保存' }), /invalid audio/u)
  assert.deepEqual(await readFile(join(directory, `${voice.id}.audio`)), previous)
  assert.equal(JSON.stringify(value()), settings)
  assert.equal((await readdir(directory)).some((name) => /\.part$|\.[a-f0-9-]{36}\.audio$/u.test(name)), false)
  const sample = await service.http(new Request(`https://example.test${ASSISTANT_VOICE_SAMPLE_PATH}?id=${voice.id}`))
  assert.equal(sample.status, 200); assert.equal(sample.headers.get('content-type'), 'audio/wav')
  await service.handle('tts/remove', { id: voice.id })
  assert.equal(value().assistant.tts.selectedId, 'moss:Junhao'); assert.equal(value().assistant.tts.voices.length, 0)
})

test('超大录音、下载不完整和未知音色不修改配置', async (t) => {
  const { service, value } = await fixture(t)
  t.mock.method(globalThis, 'fetch', async () => new Response('sample', { headers: { 'content-length': String(9 * 1024 * 1024) } }))
  await assert.rejects(service.handle('tts/import', { source: 'voice-donations/0a67.wav' }), /大小限制/u)
  assert.equal(value().assistant.tts, undefined)
  t.mock.method(globalThis, 'fetch', async () => new Response('sample', { headers: { 'content-length': '100' } }))
  await assert.rejects(service.handle('tts/import', { source: 'voice-donations/0a67.wav' }), /不完整/u)
  await assert.rejects(service.handle('tts/select', { id: 'unknown' }), /不存在/u)
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>not audio</html>'))
  await assert.rejects(service.handle('tts/import', { source: 'voice-donations/0a67.wav' }), /不能导入网页/u)
  assert.equal(value().assistant.tts, undefined)
})

test('TTS 下行传入真正选择的音色；错误不会伪造完成，取消能终止任务', async (t) => {
  const { service } = await fixture(t)
  await service.handle('tts/select', { id: 'moss:Lingyu' })
  let received: any
  t.mock.method(MossTtsWorker.prototype, 'request', async (_action, payload: any, audio: any) => {
    received = payload; audio({ bytes: new Uint8Array([0, 0, 1, 0]), sampleRate: 48_000 }); return {}
  })
  const response = await service.http(request({ text: '你好' }))
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(received.voice, 'Lingyu'); assert.equal(received.text, '你好')
  assert.deepEqual(events.map((event) => event.type), ['audio', 'done'])
  t.mock.method(MossTtsWorker.prototype, 'request', async () => { throw new Error('真实模型错误') })
  const error = await service.http(request({ text: '你好' }))
  assert.match(await error.text(), /真实模型错误/u)
  let aborted = false
  t.mock.method(MossTtsWorker.prototype, 'request', async (_action, _payload, _audio, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')) }, { once: true })
  }))
  const controller = new AbortController()
  const pending = await service.http(request({ text: '你好' }, controller.signal))
  controller.abort()
  assert.equal(await pending.text(), ''); assert.equal(aborted, true)
})

test('Host 首块音频在推理结束前送达客户端，不等待整段 PCM', async (t) => {
  const { service } = await fixture(t)
  let release!: () => void; let completed = false
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.mock.method(MossTtsWorker.prototype, 'request', async (_action, _payload, audio) => {
    audio!({ bytes: new Uint8Array([0, 0, 1, 0]), sampleRate: 48000 })
    await gate
    completed = true
    return {}
  })
  try {
    const response = await service.http(request({ text: '先开始播放。' }))
    const reader = response.body!.getReader()
    const first = await reader.read()
    assert.equal(JSON.parse(new TextDecoder().decode(first.value)).type, 'audio')
    assert.equal(completed, false)
    release()
    assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'done')
    assert.equal((await reader.read()).done, true)
    reader.releaseLock()
  } finally { release() }
})

test('全部官方预设可由参考编码还原试听，不依赖公开录音网址', async (t) => {
  const { service } = await fixture(t)
  const voices = (await service.snapshot()).voices
  const references: string[] = []
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('内置试听不应访问录音网站') })
  t.mock.method(MossTtsWorker.prototype, 'request', async (action, payload: any) => {
    assert.equal(action, 'reference'); references.push(payload.voice)
    await writeFile(payload.audioPath, 'RIFF0000WAVEfixture'); return {}
  })
  for (const voice of voices) {
    const response = await service.http(new Request(`https://example.test${ASSISTANT_VOICE_SAMPLE_PATH}?id=${voice.id}`))
    assert.equal(response.status, 200, voice.id)
  }
  assert.equal(references.length, 18)
  assert.ok(references.includes('Arisa')); assert.ok(references.includes('Trump'))
})

test('播报参数可在初始化前保存，音色切换保留参数，非法写入保持旧设置', async (t) => {
  const { service, value } = await fixture(t, false)
  const parameters = { rate: 1.25, volume: 0.5, chunkTokens: 45, segmentPauseMs: 350, seed: 0 }
  await service.handle('tts/configure', { parameters })
  assert.deepEqual(value().assistant.tts.parameters, parameters)
  assert.equal(value().assistant.tts.backend, 'browser')
  await service.handle('tts/select', { id: 'moss:Lingyu', backend: 'browser' })
  assert.deepEqual(value().assistant.tts.parameters, parameters)
  const previous = JSON.stringify(value())
  await assert.rejects(service.handle('tts/configure', { parameters: { rate: 5 } }), /播报参数/u)
  assert.equal(JSON.stringify(value()), previous)
})

test('保存值参与实际生成，临时试听覆盖不改配置，无效参数不进入工作进程', async (t) => {
  const { service, value } = await fixture(t)
  await service.handle('tts/configure', { parameters: { chunkTokens: 45, segmentPauseMs: 350, seed: 42 } })
  const previous = JSON.stringify(value()); const calls: any[] = []
  t.mock.method(MossTtsWorker.prototype, 'request', async (_action, payload, audio) => {
    calls.push(payload); audio!({ bytes: new Uint8Array([0, 0]), sampleRate: 48000 }); return {}
  })
  await (await service.http(request({ text: '默认播报' }))).text()
  await (await service.http(request({ text: '试听调整', parameters: { seed: 0, segmentPauseMs: 100 } }))).text()
  assert.deepEqual(calls.map((item) => item.parameters), [
    { chunkTokens: 45, segmentPauseMs: 350, seed: 42 }, { chunkTokens: 45, segmentPauseMs: 100, seed: 0 },
  ])
  assert.equal(JSON.stringify(value()), previous)
  for (const parameters of [{ rate: 100 }, { seed: -1 }, { temperature: 0.8 }]) {
    const response = await service.http(request({ text: '无效参数', parameters }))
    assert.equal(response.status, 400)
  }
  assert.equal(calls.length, 2)
})
