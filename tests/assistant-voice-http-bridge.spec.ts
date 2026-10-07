import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createAssistantVoiceStreamHandler, registerAssistantVoiceStreamRoutes } from '../data/build/dist/host/features/assistant-voice-stream.js'
import { GlobalVoiceCoordinator } from '../data/build/dist/host/features/global-voice-coordinator.js'
import { ASSISTANT_VOICE_EVENTS_PATH, ASSISTANT_VOICE_STREAM_PATH, encodeVoiceStreamMessage, encodeVoiceStreamOpen } from '../data/build/dist/shared/voice-stream.js'
import { ASSISTANT_TTS_PATH, ASSISTANT_VOICE_SAMPLE_PATH } from '../src/shared/assistant-tts.js'
import type { VoicePcmFrame, VoiceRuntimeListener } from '../data/build/dist/shared/contracts/voice-runtime.js'

/**
 * 使用已安装 DSH 包的实际 HTTP 桥，而不是复制其 Request 转换逻辑。
 * 上游没有公开导出 bridge；在内存为发布包的完整区域补一个测试导出。
 * 不修改依赖、不生成构建产物，也不监听任何端口。
 */
async function loadNativeBridge(): Promise<(request: PassThrough, response: MemoryResponse, handler: unknown) => Promise<void>> {
  const source = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-connection')), 'utf8')
  const start = source.indexOf('//#region lib/types/http-bridge.js')
  const end = source.indexOf('//#endregion', start)
  assert.ok(start >= 0 && end > start, 'DSH 发布包 HTTP 桥区域发生变化，需要重新核对契约')
  const code = `import { Readable } from 'node:stream';\n${source.slice(start, end)}\nexport { bridge };`
  const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  return module.bridge
}

class MemoryResponse extends Writable {
  status = 0
  headers: Record<string, string> = {}
  chunks: string[] = []
  writeHead(status: number, headers: Record<string, string> = {}): this { this.status = status; this.headers = headers; return this }
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error) => void): void {
    this.chunks.push(chunk.toString())
    this.emit('chunk', chunk)
    callback()
  }
}

function request(path: string, method = 'GET', bytes?: Uint8Array): PassThrough {
  const input = Object.assign(new PassThrough(), { url: path, method, headers: { host: '127.0.0.1' } })
  input.end(bytes)
  return input
}

function connection(): HostConnectionService {
  // 测试从已认证的 HTTP 桥入口开始；租约校验仍由真实语音处理器负责。
  return new HostConnectionService(new Context(), [], { isAuthenticated: () => true } as never)
}

test('复现原生桥给 GET 附加流式正文时的 400 根因', async (t) => {
  const native = connection()
  t.after(() => native.operator.dispose())
  let entered = false
  const dispose = native.fetch.register({ path: ASSISTANT_VOICE_STREAM_PATH, methods: ['GET', 'POST'], requestBody: 'streaming', fetch: async () => { entered = true; return new Response('不应进入') } })
  t.after(() => dispose())
  const bridge = await loadNativeBridge()
  await assert.rejects(() => bridge(request(ASSISTANT_VOICE_STREAM_PATH), new MemoryResponse(), native.createSharedFetchHandler('/api')), /GET\/HEAD.*body/u)
  assert.equal(entered, false, '错误发生在 Node Request 创建阶段，语音处理器尚未进入')
})

test('独立 buffered GET 经原生 HTTP 桥返回 200，PCM 上传与实时事件能同时工作', { timeout: 3_000 }, async (t) => {
  const native = connection()
  t.after(() => native.operator.dispose())
  const listeners = new Set<VoiceRuntimeListener>()
  const coordinator = new GlobalVoiceCoordinator({ adapter: {
    capabilities: { realtime: true, streamingInput: true, streamingOutput: false, wakeWord: false, bargeIn: false, speechToText: true, textToSpeech: false },
    start() {}, stop() {}, interrupt() {},
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    sendPcm(_frame: VoicePcmFrame, epoch: number) { for (const listener of listeners) listener({ type: 'partial', text: '真实 HTTP 桥回显', epoch }) },
  } })
  t.after(() => coordinator.dispose())
  const lease = await coordinator.start('tab-a')
  const dispose = registerAssistantVoiceStreamRoutes(native.fetch, createAssistantVoiceStreamHandler({ coordinator }))
  t.after(() => dispose())
  const api = native.createSharedFetchHandler('/api')
  const bridge = await loadNativeBridge()
  const output = new MemoryResponse()
  const firstChunk = once(output, 'chunk')
  const done = bridge(request(`${ASSISTANT_VOICE_EVENTS_PATH}?ownerId=tab-a`), output, api)
  await Promise.race([firstChunk, done.then(() => { throw new Error('事件连接在首次回显前结束') })])
  assert.equal(output.status, 200)
  assert.equal(output.headers['x-accel-buffering'], 'no')
  const open = encodeVoiceStreamOpen({ ownerId: 'tab-a', clientId: 'client-a', sampleRate: 16_000, channels: 1, encoding: 'pcm16le' })
  const frame = encodeVoiceStreamMessage({ type: 'pcm', sequence: 1, sampleRate: 16_000, channels: 1, epoch: lease.epoch, byteLength: 2 })
  const body = Buffer.concat([open, frame, new Uint8Array([1, 2])])
  const uploadOutput = new MemoryResponse()
  const partial = once(output, 'chunk')
  await bridge(request(`${ASSISTANT_VOICE_STREAM_PATH}?mode=frames`, 'POST', body), uploadOutput, api)
  await partial
  assert.equal(uploadOutput.status, 204)
  assert.match(output.chunks.join(''), /真实 HTTP 桥回显/u)
  const denied = new MemoryResponse()
  await bridge(request(`${ASSISTANT_VOICE_EVENTS_PATH}?ownerId=tab-b`), denied, api)
  assert.equal(denied.status, 403, '拆分路由不能绕过租约保护')
  await coordinator.stop('tab-a')
  await done
  assert.equal(output.writableEnded, true)
})

test('TTS 正文与参考试听经原生桥传递，试听不需要实时麦克风租约', async (t) => {
  const native = connection()
  t.after(() => native.operator.dispose())
  const coordinator = new GlobalVoiceCoordinator({ adapter: {
    capabilities: { realtime: false, streamingInput: false, streamingOutput: false, wakeWord: false, bargeIn: false, speechToText: false, textToSpeech: false },
    start() { throw new Error('试听不应启动实时识别') }, stop() {}, interrupt() {}, subscribe() { return () => undefined },
  } })
  t.after(() => coordinator.dispose())
  const calls: string[] = []
  const dispose = registerAssistantVoiceStreamRoutes(native.fetch, createAssistantVoiceStreamHandler({ coordinator, tts: async (input) => {
    const url = new URL(input.url)
    calls.push(`${input.method} ${url.pathname}`)
    if (url.pathname === ASSISTANT_VOICE_SAMPLE_PATH) {
      assert.equal(url.searchParams.get('id'), 'moss:Junhao')
      assert.equal(input.body, null, 'GET 试听不能被原生桥附加正文')
      return new Response('RIFF-reference', { headers: { 'content-type': 'audio/wav' } })
    }
    assert.deepEqual(await input.json(), { text: '你好', voiceId: 'moss:Junhao' })
    const bytes = new TextEncoder()
    return new Response(new ReadableStream({ start(output) {
      output.enqueue(bytes.encode('{"type":"audio","sampleRate":48000,"data":"AAA="}\n'))
      output.enqueue(bytes.encode('{"type":"done"}\n'))
      output.close()
    } }), { headers: { 'content-type': 'application/x-ndjson', 'x-accel-buffering': 'no' } })
  } }))
  t.after(() => dispose())
  const bridge = await loadNativeBridge()
  const api = native.createSharedFetchHandler('/api')
  const output = new MemoryResponse()
  await bridge(request(ASSISTANT_TTS_PATH, 'POST', Buffer.from(JSON.stringify({ text: '你好', voiceId: 'moss:Junhao' }))), output, api)
  assert.equal(output.status, 200)
  assert.equal(output.headers['x-accel-buffering'], 'no')
  assert.deepEqual(output.chunks.join('').trim().split('\n').map((line) => JSON.parse(line)), [
    { type: 'audio', sampleRate: 48000, data: 'AAA=' }, { type: 'done' },
  ])
  const sample = new MemoryResponse()
  await bridge(request(`${ASSISTANT_VOICE_SAMPLE_PATH}?id=moss%3AJunhao`), sample, api)
  assert.equal(sample.status, 200)
  assert.equal(sample.headers['content-type'], 'audio/wav')
  assert.equal(sample.chunks.join(''), 'RIFF-reference')
  assert.equal(coordinator.snapshot().active, false)
  assert.deepEqual(calls, [`POST ${ASSISTANT_TTS_PATH}`, `GET ${ASSISTANT_VOICE_SAMPLE_PATH}`])
})
