import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { ClientSherpaVoiceAdapter } from '../data/build/dist/client/sherpa-voice-adapter.js'
import { ClientVoiceCapture } from '../data/build/dist/client/voice-capture.js'
import { VoiceStreamDecoder } from '../data/build/dist/shared/voice-stream.js'
import { MossVoiceOutput } from '../src/client/moss-voice-output.js'
import type { CodingNsClientServices } from '../data/build/dist/client/features/types.js'
import type { VoiceRuntimeEvent } from '../data/build/dist/shared/contracts/voice-runtime.js'

test('客户端不用请求流也能开始收音、实时回显，打断后继续上传 Host epoch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let capture: ClientVoiceCapture | undefined
  t.mock.method(ClientVoiceCapture.prototype, 'start', async function () { capture = this })
  t.mock.method(ClientVoiceCapture.prototype, 'stop', async () => undefined)
  const calls: string[] = []
  let epoch = 12
  let resolveAction: ((result: unknown) => void) | undefined
  const services = { rpc: { call: async (_channel, endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'assistant/voice/interrupt') epoch += 1
    if (endpoint === 'assistant/voice/chat/start') return new Promise((resolve) => { resolveAction = resolve })
    return { ok: true, value: { epoch } }
  } } } as unknown as CodingNsClientServices
  let eventController: ReadableStreamDefaultController<Uint8Array> | undefined
  const uploads: Uint8Array[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init?.body instanceof ReadableStream) throw new Error('ReadableStream uploading is not supported')
    if (init.method === 'GET') {
      assert.equal(new URL(url).pathname, '/api/codingns/assistant/voice/events')
      assert.equal(new URL(url).searchParams.get('ownerId'), 'tab-a')
      return new Response(new ReadableStream({ start(controller) { eventController = controller } }))
    }
    assert.equal(new URL(url).searchParams.get('mode'), 'frames')
    uploads.push(init.body as Uint8Array)
    return new Response(null, { status: 204 })
  })
  const adapter = new ClientSherpaVoiceAdapter({ ownerId: 'tab-a', services })
  t.after(async () => { await adapter.stop(); await eventController?.close(); adapter.dispose() })
  const events: VoiceRuntimeEvent[] = []
  adapter.subscribe((event) => events.push(event))
  await adapter.start()
  assert.ok(capture, '不等待无限 POST 结束就能启动麦克风')
  const sendEvent = (event: VoiceRuntimeEvent): void => eventController!.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`))
  sendEvent({ type: 'partial', text: '现在的实时文字', epoch })
  sendEvent({ type: 'final', text: '现在进展怎么样', epoch })
  sendEvent({ type: 'partial', text: '动作尚未完成也继续回显', epoch })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(events.filter((event) => event.type === 'partial').length, 2)
  assert.ok(resolveAction, '动作执行不阻塞下一条 partial')
  const sendCapturedFrame = (sequence: number): void => {
    // 通过实际采集回调验证打断后的代次更新，而不是直接调用适配器绕过闭包。
    const options = (capture as unknown as { options: { onFrame: (frame: unknown) => void } }).options
    options.onFrame({ sequence, bytes: new Uint8Array([1, 2]), sampleRate: 16_000, channels: 1 })
  }
  sendCapturedFrame(1)
  t.mock.timers.tick(60)
  await new Promise<void>((resolve) => setImmediate(resolve))
  await adapter.interrupt()
  sendCapturedFrame(2)
  t.mock.timers.tick(60)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((endpoint) => endpoint === 'assistant/voice/interrupt').length, 1)
  assert.equal(uploads.length, 2)
  assert.deepEqual(uploads.map((bytes) => {
    const pcm = new VoiceStreamDecoder().push(bytes)[1]!.message
    return pcm.type === 'pcm' ? pcm.epoch : undefined
  }), [12, 13])
  resolveAction!({ ok: true, value: {} })
  await adapter.stop()
  assert.equal(adapter.ownerId, undefined)
  assert.equal(calls.filter((endpoint) => endpoint === 'assistant/voice/stop').length, 1)
  assert.equal(calls.some((endpoint) => endpoint.includes('transcribe')), false)
})

test('事件连接断开自动停止采集并释放 Host 租约', async (t) => {
  const calls: string[] = []
  let stopCount = 0
  t.mock.method(ClientVoiceCapture.prototype, 'start', async () => undefined)
  t.mock.method(ClientVoiceCapture.prototype, 'stop', async () => { stopCount += 1 })
  const services = { rpc: { call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: true, value: { epoch: 8 } } } } } as unknown as CodingNsClientServices
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(next) { controller = next } })))
  const adapter = new ClientSherpaVoiceAdapter({ ownerId: 'tab-a', services })
  t.after(() => adapter.dispose())
  const events: VoiceRuntimeEvent[] = []
  adapter.subscribe((event) => events.push(event))
  await adapter.start()
  controller!.close()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(stopCount, 1)
  assert.equal(adapter.ownerId, undefined)
  assert.equal(calls.filter((endpoint) => endpoint === 'assistant/voice/stop').length, 1)
  assert.ok(events.some((event) => event.type === 'error' && !event.recoverable))
})

test('通话启动传独立 ID，静音过滤迟到识别输入，取消静音恢复而不申请新租约', async (t) => {
  t.mock.method(ClientVoiceCapture.prototype, 'start', async () => undefined)
  t.mock.method(ClientVoiceCapture.prototype, 'stop', async () => undefined)
  const muted: boolean[] = []
  t.mock.method(ClientVoiceCapture.prototype, 'setMuted', (value) => { muted.push(value) })
  const calls: { endpoint: string; payload: any }[] = []
  const services = { rpc: { call: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    return { ok: true, value: endpoint === 'assistant/voice/chat/start' ? { state: 'completed', text: '' } : { epoch: 8 } }
  } } } as unknown as CodingNsClientServices
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(next) { controller = next } })))
  const adapter = new ClientSherpaVoiceAdapter({ ownerId: 'tab-a', services })
  t.after(async () => { await adapter.stop(); controller?.close(); adapter.dispose() })
  const events: VoiceRuntimeEvent[] = []; adapter.subscribe((event) => events.push(event))
  const send = (text: string) => controller!.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'final', text, epoch: 8 }) + '\n'))
  await adapter.start()
  assert.equal(typeof calls[0]!.payload.voiceSessionId, 'string')
  adapter.setMicrophoneMuted(true); send('静音前迟到输入')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((call) => call.endpoint === 'assistant/voice/chat/start').length, 0)
  assert.equal(events.filter((event) => event.type === 'final').length, 0)
  adapter.setMicrophoneMuted(false); send('恢复后的输入')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((call) => call.endpoint === 'assistant/voice/chat/start').length, 1)
  assert.equal(calls.filter((call) => call.endpoint === 'assistant/voice/start').length, 1)
  assert.deepEqual(muted.slice(-2), [true, false])
})

test('获取租约后的设备准备失败仍然释放 Host 租约', async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { enumerateDevices: async () => { throw new Error('设备枚举失败') } } } })
  t.after(() => {
    if (originalNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator
    else Object.defineProperty(globalThis, 'navigator', originalNavigator)
  })
  const calls: string[] = []
  const services = { rpc: { call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: true, value: { epoch: 5 } } } } } as unknown as CodingNsClientServices
  const adapter = new ClientSherpaVoiceAdapter({ ownerId: 'tab-a', services })
  t.after(() => adapter.dispose())
  await assert.rejects(() => adapter.start(), /设备枚举失败/u)
  assert.deepEqual(calls, ['assistant/voice/start', 'assistant/voice/stop'])
  assert.equal(adapter.ownerId, undefined)
})

test('启动请求尚未返回时关闭，迟到的 Host 租约也会被释放', async (t) => {
  let resolveLease: ((value: unknown) => void) | undefined
  const calls: string[] = []
  const services = { rpc: { call: async (_channel, endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'assistant/voice/start') return new Promise((resolve) => { resolveLease = resolve })
    return { ok: true, value: {} }
  } } } as unknown as CodingNsClientServices
  const adapter = new ClientSherpaVoiceAdapter({ ownerId: 'tab-a', services })
  t.after(() => adapter.dispose())
  const started = assert.rejects(() => adapter.start(), /取消/u)
  const stopped = adapter.stop()
  resolveLease!({ ok: true, value: { epoch: 15 } })
  await Promise.all([started, stopped])
  assert.deepEqual(calls, ['assistant/voice/start', 'assistant/voice/stop'])
  assert.equal(adapter.ownerId, undefined)
})

test('实际播报每次读取最新音色，过期轮次不发起 MOSS 请求', async (t) => {
  let selectedId = 'moss:Junhao'
  const parameters = { rate: 1.25, volume: 0.5, segmentPauseMs: 150, chunkTokens: 50, seed: 42 }
  const services = { settings: { getSnapshot: () => ({ value: { assistant: { tts: { backend: 'moss-onnx', selectedId, voices: [], parameters } } } }) } } as unknown as CodingNsClientServices
  const requests: [string, string][] = []
  t.mock.method(MossVoiceOutput.prototype, 'speak', async (text, voiceId, started, playback) => {
    assert.deepEqual(playback, parameters)
    requests.push([text, voiceId!]); started?.(); return true
  })
  const adapter = new ClientSherpaVoiceAdapter({ ownerId: 'tab-a', services })
  t.after(() => adapter.dispose())
  const events: VoiceRuntimeEvent[] = []
  adapter.subscribe((event) => events.push(event))
  await adapter.speak('  第一次播报  ', 0)
  selectedId = 'moss:Lingyu'
  await adapter.speak('切换后的播报', 0)
  await adapter.speak('过期播报', -1)
  assert.deepEqual(requests, [['第一次播报', 'moss:Junhao'], ['切换后的播报', 'moss:Lingyu']])
  assert.equal(events.filter((event) => event.type === 'state' && event.state === 'speaking').length, 2)
})

async function conversationFixture(t: TestContext, handler: (endpoint: string, payload: any, signal?: AbortSignal) => Promise<unknown>) {
  t.mock.method(ClientVoiceCapture.prototype, 'start', async () => undefined)
  t.mock.method(ClientVoiceCapture.prototype, 'stop', async () => undefined)
  let controller!: ReadableStreamDefaultController<Uint8Array>
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(next) { controller = next } })))
  const services = { rpc: { call: async (_channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => handler(endpoint, payload, signal) } } as unknown as CodingNsClientServices
  const adapter = new ClientSherpaVoiceAdapter({ ownerId: 'page', services })
  const events: VoiceRuntimeEvent[] = []
  const spoken: string[] = []
  t.mock.method(adapter, 'speak', async (text) => { spoken.push(text) })
  adapter.subscribe((event) => events.push(event))
  await adapter.start()
  t.after(async () => { await adapter.stop(); controller.close(); adapter.dispose() })
  return { adapter, events, spoken, send: (type: 'final' | 'partial', text: string) => controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type, text, epoch: 1 })}\n`)) }
}

test('语音流式残句实时回显，完成后补播一次，识别事件持续接收', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await conversationFixture(t, async (endpoint, payload) => {
    if (endpoint === 'assistant/voice/chat/start') return { ok: true, value: { requestId: payload.requestId, state: 'running', text: '先检查' } }
    if (endpoint === 'assistant/voice/chat/read') return { ok: true, value: { requestId: payload.requestId, state: 'completed', text: '先检查权限。' } }
    return { ok: true, value: { epoch: 1 } }
  })
  f.send('final', '哪些会话需要我处理？')
  f.send('partial', '继续识别')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(f.events.some((event) => event.type === 'state' && event.state === 'thinking'))
  assert.ok(f.events.some((event) => event.type === 'partial' && event.text === '继续识别'))
  assert.deepEqual(f.spoken, [])
  t.mock.timers.tick(250); await new Promise<void>((resolve) => setImmediate(resolve))
  const replies = f.events.filter((event) => event.type === 'reply')
  assert.deepEqual(replies.map((event) => [event.text, event.final]), [['先检查', false], ['先检查权限。', true]])
  assert.equal(replies[0]!.requestId, replies[1]!.requestId)
  assert.deepEqual(f.spoken, ['先检查权限。'])
})

test('实时语音在模型结束前逐句播报，慢播报不阻塞文字轮询，重复快照不重读', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let polls = 0
  const f = await conversationFixture(t, async (endpoint) => {
    if (endpoint === 'assistant/voice/chat/start') return { ok: true, value: { state: 'running', text: '第一句。第二句。还没' } }
    if (endpoint === 'assistant/voice/chat/read') { polls++; return { ok: true, value: { state: polls === 1 ? 'running' : 'completed', text: polls === 1 ? '第一句。第二句。还没' : '第一句。第二句。还没结束的最后一句' } } }
    return { ok: true, value: { epoch: 1 } }
  })
  let release!: () => void
  // 模拟第一句仍在播放；RPC 必须继续轮询并更新完整文字。
  t.mock.method(f.adapter, 'speak', async (text) => { f.spoken.push(text); if (f.spoken.length === 1) await new Promise<void>((resolve) => { release = resolve }) })
  f.send('final', '你好'); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(f.spoken, ['第一句。'])
  t.mock.timers.tick(250); await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(250); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(polls, 2)
  assert.ok(f.events.some((event) => event.type === 'reply' && event.final))
  release(); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(f.spoken, ['第一句。', '第二句。', '还没结束的最后一句'])
})

test('逐句播放期间停止，已经排队的后续句子不会开始播放', async (t) => {
  const f = await conversationFixture(t, async (endpoint) => endpoint === 'assistant/voice/chat/start' ? { ok: true, value: { state: 'completed', text: '第一句。第二句。' } } : { ok: true, value: { epoch: 1 } })
  let release!: () => void
  t.mock.method(f.adapter, 'speak', async (text) => { f.spoken.push(text); await new Promise<void>((resolve) => { release = resolve }) })
  f.send('final', '你好'); await new Promise<void>((resolve) => setImmediate(resolve))
  await f.adapter.stop()
  release(); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(f.spoken, ['第一句。'])
})

test('实际 MOSS 输出入口逐句消费流式回复，沿用当前音色、语速与音量', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const audio: any[] = []
  t.mock.method(MossVoiceOutput.prototype, 'append', async (text, voice, onStart, parameters) => { audio.push({ text, voice, parameters }); onStart?.(); return true })
  const f = await conversationFixture(t, async (endpoint) => endpoint === 'assistant/voice/chat/start'
    ? { ok: true, value: { state: 'running', text: '首句先播放。最后' } }
    : endpoint === 'assistant/voice/chat/read' ? { ok: true, value: { state: 'completed', text: '首句先播放。最后一句' } } : { ok: true, value: { epoch: 1 } })
  ;(f.adapter as any).services.settings = { getSnapshot: () => ({ value: { assistant: { tts: { backend: 'moss-onnx', selectedId: 'moss:Junhao', parameters: { rate: 1.25, volume: 0.7 } } } } }) }
  t.mock.method(f.adapter, 'speak', ClientSherpaVoiceAdapter.prototype.speak)
  f.send('final', '你好'); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(audio.map((item) => item.text), ['首句先播放。'])
  t.mock.timers.tick(250); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(audio.map((item) => item.text), ['首句先播放。', '最后一句'])
  assert.ok(audio.every((item) => item.voice === 'moss:Junhao' && item.parameters.rate === 1.25 && item.parameters.volume === 0.7))
  assert.equal(f.events.filter((event) => event.type === 'state' && event.state === 'speaking').length, 2)
})

test('实际 MOSS 对话在首个逗号短语开始生成，流结束后等待整轮音频播放', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const generated: string[] = []
  let release!: () => void; let finishing = 0
  t.mock.method(MossVoiceOutput.prototype, 'append', async (text, _voice, onStart) => { generated.push(text); onStart?.(); return true })
  t.mock.method(MossVoiceOutput.prototype, 'finish', async () => { finishing++; await new Promise<void>((resolve) => { release = resolve }); return true })
  const f = await conversationFixture(t, async (endpoint) => endpoint === 'assistant/voice/chat/start'
    ? { ok: true, value: { state: 'running', text: '好，那你慢慢看，我会在' } }
    : endpoint === 'assistant/voice/chat/read' ? { ok: true, value: { state: 'completed', text: '好，那你慢慢看，我会在旁边等着。' } } : { ok: true, value: { epoch: 1 } })
  ;(f.adapter as any).services.settings = { getSnapshot: () => ({ value: { assistant: { tts: { backend: 'moss-onnx' } } } }) }
  t.mock.method(f.adapter, 'speak', ClientSherpaVoiceAdapter.prototype.speak)
  f.send('final', '我慢慢看'); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(generated, ['好，那你慢慢看，'])
  assert.equal(finishing, 0, '模型运行中就开始合成')
  const statesBeforeCompletion = f.events.length
  t.mock.timers.tick(250); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(generated, ['好，那你慢慢看，', '我会在旁边等着。'])
  assert.equal(finishing, 1)
  assert.equal(f.events.slice(statesBeforeCompletion).some((event) => event.type === 'state' && event.state === 'listening'), false)
  release(); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(f.events.at(-1)?.type === 'state' && (f.events.at(-1) as any).state === 'listening')
})

test('同一 epoch 的新话语替换旧生成，迟到旧回复不会显示、播报或覆盖当前状态', async (t) => {
  let release!: (value: unknown) => void
  const signals: AbortSignal[] = []
  const payloads: any[] = []
  const cancelled: string[] = []
  const f = await conversationFixture(t, async (endpoint, payload, signal) => {
    if (endpoint === 'assistant/voice/chat/start') {
      signals.push(signal!); payloads.push(payload)
      if (payloads.length === 1) return new Promise((resolve) => { release = resolve })
      return { ok: true, value: { state: 'completed', text: '新问题的回复。' } }
    }
    if (endpoint === 'assistant/voice/chat/cancel') cancelled.push(payload.requestId)
    return { ok: true, value: { epoch: 1 } }
  })
  f.send('final', '旧问题'); await new Promise<void>((resolve) => setImmediate(resolve))
  f.send('final', '新问题'); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(signals[0]!.aborted, true)
  assert.ok(cancelled.includes(payloads[0].requestId))
  assert.equal(payloads[1].sequence > payloads[0].sequence, true)
  release({ ok: true, value: { state: 'completed', text: '迟到旧回复。' } }); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(f.spoken, ['新问题的回复。'])
  assert.ok(!f.events.some((event) => event.type === 'reply' && event.text === '迟到旧回复。'))
  assert.ok(!f.events.some((event) => event.type === 'error'))
})

test('清空同步 Host 历史，新话语等待清空完成；停止取消未完成生成', async (t) => {
  let releaseOld!: (value: unknown) => void
  let releaseStop!: (value: unknown) => void
  let releaseClear!: () => void
  const clearing = new Promise<void>((resolve) => { releaseClear = resolve })
  const starts: any[] = []
  const f = await conversationFixture(t, async (endpoint, payload) => {
    if (endpoint === 'assistant/voice/chat/clear') { await clearing; return { ok: true, value: { cleared: true } } }
    if (endpoint === 'assistant/voice/chat/start') {
      starts.push(payload)
      if (starts.length === 1) return new Promise((resolve) => { releaseOld = resolve })
      if (starts.length === 3) return new Promise((resolve) => { releaseStop = resolve })
      return { ok: true, value: { state: 'completed', text: '清空后的回复。' } }
    }
    return { ok: true, value: { epoch: 1 } }
  })
  f.send('final', '清空前'); await new Promise<void>((resolve) => setImmediate(resolve))
  const cleared = f.adapter.clearConversation()
  f.send('final', '清空后'); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(starts.length, 1)
  releaseClear(); await cleared; await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(starts.length, 2)
  releaseOld({ ok: true, value: { state: 'completed', text: '清空前迟到的回复。' } }); await new Promise<void>((resolve) => setImmediate(resolve))
  f.send('final', '停止前'); await new Promise<void>((resolve) => setImmediate(resolve))
  await f.adapter.stop()
  releaseStop({ ok: true, value: { state: 'completed', text: '停止后迟到的回复。' } }); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(f.spoken, ['清空后的回复。'])
  assert.ok(!f.events.some((event) => event.type === 'reply' && event.text.includes('迟到')))
})

test('索引或 LLM 不可用时明确显示错误，保持收音且不回退关键词或转写服务', async (t) => {
  const calls: string[] = []
  const f = await conversationFixture(t, async (endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'assistant/voice/chat/start') return { ok: false, error: { message: '结构化索引未生成，请等待自动更新' } }
    return { ok: true, value: { epoch: 1 } }
  })
  f.send('final', '进展？'); await new Promise<void>((resolve) => setImmediate(resolve))
  f.send('partial', '仍能继续识别'); await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(f.events.some((event) => event.type === 'error' && event.message.includes('结构化索引')))
  assert.ok(f.events.some((event) => event.type === 'partial' && event.text === '仍能继续识别'))
  assert.equal(f.adapter.ownerId, 'page')
  assert.deepEqual(f.spoken, [])
  assert.equal(calls.some((endpoint) => endpoint.includes('transcribe') || endpoint === 'assistant/voice/text' || endpoint === 'assistant/turn'), false)
  assert.ok(calls.includes('assistant/voice/chat/cancel'))
})

test('旧浏览器播报也应用语速与音量，MOSS 专用参数保持独立', async (t) => {
  const saved = new Map(['speechSynthesis', 'SpeechSynthesisUtterance'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const spoken: any[] = []
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: class { readonly text: string; constructor(text: string) { this.text = text } } })
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: { cancel() {}, speak(utterance: any) { spoken.push(utterance); queueMicrotask(() => utterance.onend()) } } })
  const services = { settings: { getSnapshot: () => ({ value: { assistant: { tts: { backend: 'browser', parameters: { rate: 1.4, volume: 0.3, seed: 42 } } } } }) } } as unknown as CodingNsClientServices
  const adapter = new ClientSherpaVoiceAdapter({ ownerId: 'tab-a', services })
  t.after(() => adapter.dispose())
  await adapter.speak('浏览器兼容播报', 0)
  assert.equal(spoken[0].rate, 1.4); assert.equal(spoken[0].volume, 0.3)
})
