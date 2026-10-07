import type { GlobalVoiceCoordinator } from './global-voice-coordinator.js'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import { ASSISTANT_VOICE_EVENTS_PATH, ASSISTANT_VOICE_STREAM_PATH, encodeVoiceStreamEvent, pcmFrameFromStream, VoiceStreamDecoder, type VoiceStreamOpenMessage } from '../../shared/voice-stream.js'
import type { VoiceRuntimeEvent } from '../../shared/contracts/voice-runtime.js'
import { ASSISTANT_TTS_PATH, ASSISTANT_VOICE_SAMPLE_PATH } from '../../shared/assistant-tts.js'
import { traceVoice, voiceDiagnosticError } from '../../shared/voice-diagnostics.js'
import { setImmediate } from 'node:timers/promises'
import type { AssistantVoiceChat } from './assistant-voice-chat.js'
import type { VoiceStreamChatEvent } from '../../shared/voice-stream.js'

export interface AssistantVoiceStreamOptions {
  readonly coordinator: GlobalVoiceCoordinator
  readonly tts?: (request: Request) => Promise<Response>
  readonly chat?: AssistantVoiceChat
}

/**
 * DSH 的 requestBody 是路由级配置。GET 必须单独登记为 buffered，
 * 否则原生 HTTP 桥会给 GET 附加 ReadableStream 正文，被 Node 拒绝为 400。
 * buffered 只约束请求读取，不影响事件响应持续下发。
 */
export function registerAssistantVoiceStreamRoutes(registry: HostConnectionFetch, handler: (request: Request) => Promise<Response>): () => Promise<void> {
  const disposeUpload = registry.register({ path: ASSISTANT_VOICE_STREAM_PATH, methods: ['POST'], requestBody: 'streaming', fetch: handler })
  const disposeEvents = registry.register({ path: ASSISTANT_VOICE_EVENTS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: handler })
  const disposeTts = registry.register({ path: ASSISTANT_TTS_PATH, methods: ['POST'], requestBody: 'buffered', fetch: handler })
  const disposeSample = registry.register({ path: ASSISTANT_VOICE_SAMPLE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: handler })
  return async () => { try { await disposeSample() } finally { try { await disposeTts() } finally { try { await disposeEvents() } finally { await disposeUpload() } } } }
}

/**
 * Host 的流式入口只转发 PCM 和运行时事件，不把音频字节塞进 JSON RPC。
 * 浏览器通过同源 HTTPS 访问此路由，因而麦克风权限属于真正打开页面的客户端。
 */
export function createAssistantVoiceStreamHandler(options: AssistantVoiceStreamOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === ASSISTANT_TTS_PATH || url.pathname === ASSISTANT_VOICE_SAMPLE_PATH) {
      return options.tts?.(request) ?? Response.json({ error: 'Host TTS 未启用' }, { status: 503 })
    }
    // 新客户端把上传和事件下行拆开，避免依赖 fetch 请求流及其半双工限制。
    if (request.method.toUpperCase() === 'GET') return createVoiceEventResponse(request, options.coordinator, url.searchParams.get('ownerId') ?? '', options.chat)
    if (request.method.toUpperCase() === 'POST' && url.searchParams.get('mode') === 'frames') return receiveVoiceFrames(request, options.coordinator)
    // 保留旧客户端的流路由；新客户端不再使用无限长度的 POST 正文。
    if (request.method.toUpperCase() !== 'POST' || request.body === null) return Response.json({ error: '语音流必须使用 POST 流式正文' }, { status: 400 })
    const decoder = new VoiceStreamDecoder()
    const encoder = new TextEncoder()
    let opened: VoiceStreamOpenMessage | undefined
    let closed = false
    let disposeEvents: (() => void) | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const send = (event: VoiceRuntimeEvent): void => {
      if (closed || controller === undefined) return
      try { controller.enqueue(encoder.encode(encodeVoiceStreamEvent(event))) } catch { closed = true }
    }
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController
        void consume()
      },
      cancel() {
        closed = true
        disposeEvents?.()
        disposeEvents = undefined
      },
    })
    async function consume(): Promise<void> {
      const reader = request.body?.getReader()
      if (reader === undefined) return finish()
      try {
        while (!closed) {
          const next = await reader.read()
          if (next.done) break
          for (const item of decoder.push(next.value)) {
            if (item.message.type === 'open') {
              if (opened !== undefined) throw new Error('语音流重复打开')
              opened = item.message
              options.coordinator.assertOwner(opened.ownerId)
              disposeEvents = options.coordinator.subscribeRuntimeEvent((event) => send(event))
              continue
            }
            if (opened === undefined) throw new Error('语音流缺少首部')
            if (item.message.type === 'pcm') {
              if (item.pcm === undefined) throw new Error('语音流 PCM 缺少正文')
              // 控制面 interrupt 会递增 Host epoch；旧页面/旧设备已经在途的帧必须直接丢弃。
              if (item.message.epoch !== options.coordinator.snapshot().epoch) continue
              await options.coordinator.sendPcm(opened.ownerId, pcmFrameFromStream(item.message, item.pcm))
            } else if (item.message.type === 'interrupt') {
              await options.coordinator.interrupt(opened.ownerId)
            } else if (item.message.type === 'close') {
              closed = true
              break
            }
          }
        }
      } catch (error) {
        send({ type: 'error', code: 'voice_stream_failed', message: error instanceof Error ? error.message : String(error), recoverable: false, epoch: options.coordinator.snapshot().epoch })
      } finally {
        finish()
      }
    }
    function finish(): void {
      disposeEvents?.()
      disposeEvents = undefined
      closed = true
      try { controller?.close() } catch { /* 客户端已经取消响应 */ }
    }
    request.signal.addEventListener('abort', () => finish(), { once: true })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // 反向代理默认可能缓冲响应；关闭后，partial/final 才能及时到达手机端。
        'x-accel-buffering': 'no',
      },
    })
  }
}

/** 每个上传批次只转发音频，识别器和租约始终由协调器持有。 */
async function receiveVoiceFrames(request: Request, coordinator: GlobalVoiceCoordinator): Promise<Response> {
  const started = performance.now()
  const diagnosticId = request.headers.get('x-codingns-voice-diagnostic-id') ?? undefined
  traceVoice('host.upload.received', { diagnosticId })
  if (request.body === null) return Response.json({ error: '语音帧缺少正文' }, { status: 400 })
  const reader = request.body.getReader()
  const decoder = new VoiceStreamDecoder()
  const items: ReturnType<VoiceStreamDecoder['push']> = []
  let byteLength = 0
  let fields = {}
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      byteLength += next.value.length
      if (byteLength > 256 * 1024) return Response.json({ error: '语音上传批次过大' }, { status: 413 })
      items.push(...decoder.push(next.value))
    }
    decoder.finish()
    const open = items[0]?.message
    if (open?.type !== 'open' || items.slice(1).some((item) => item.message.type !== 'pcm')) throw new Error('语音上传批次必须由一个首部和 PCM 帧组成')
    try { coordinator.assertOwner(open.ownerId) } catch { return Response.json({ error: '当前页面没有全局语音租约' }, { status: 403 }) }
    const bodyReadMs = performance.now() - started
    let stale = 0
    fields = { ownerId: open.ownerId, clientId: open.clientId, diagnosticId }
    let yieldedAt = performance.now()
    for (const item of items.slice(1)) {
      if (item.message.type !== 'pcm' || item.pcm === undefined) throw new Error('语音 PCM 缺少正文')
      if (item.message.epoch !== coordinator.snapshot().epoch) { stale++; continue }
      await coordinator.sendPcm(open.ownerId, pcmFrameFromStream(item.message, item.pcm))
      // await 同步识别器只会切换微任务；积压批次要主动让 HTTP、RPC 和租约计时器运行。
      if (performance.now() - yieldedAt >= 10) { await setImmediate(); yieldedAt = performance.now() }
    }
    traceVoice('host.upload.batch', { ...fields, bytes: byteLength, frames: items.length - 1, stale, transportMs: bodyReadMs, processMs: performance.now() - started - bodyReadMs, durationMs: performance.now() - started })
    return new Response(null, { status: 204 })
  } catch (error) {
    traceVoice('host.upload.error', { ...fields, bytes: byteLength, durationMs: performance.now() - started, errorName: voiceDiagnosticError(error) })
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** GET 只承载即时事件，下行不再被尚未结束的音频上传阻塞。 */
function createVoiceEventResponse(request: Request, coordinator: GlobalVoiceCoordinator, ownerId: string, chat?: AssistantVoiceChat): Response {
  try { coordinator.assertOwner(ownerId) } catch { return Response.json({ error: '当前页面没有全局语音租约' }, { status: 403 }) }
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  let disposeEvents: (() => void) | undefined
  let disposeState: (() => void) | undefined
  let disposeChat: (() => void) | undefined
  let pendingChat: VoiceStreamChatEvent | undefined
  let lastState = ''
  let keepAlive: ReturnType<typeof setInterval> | undefined
  const send = (event: VoiceRuntimeEvent | VoiceStreamChatEvent): void => {
    if (closed) return
    // 网络下行背压时只保留最新累计文字，完整前缀仍在快照中，不逐 token 堆积。
    if (event.type === 'chat' && (controller?.desiredSize ?? 0) <= 0) { pendingChat = event; return }
    if (event.type !== 'partial') traceVoice('host.voice.event', { ownerId, epoch: event.epoch, state: event.type, textLength: 'text' in event ? event.text.length : undefined })
    try { controller?.enqueue(encoder.encode(encodeVoiceStreamEvent(event))) } catch { finish() }
  }
  const finish = (): void => {
    if (closed) return
    closed = true
    pendingChat = undefined
    disposeEvents?.()
    disposeState?.()
    disposeChat?.()
    if (keepAlive !== undefined) clearInterval(keepAlive)
    request.signal.removeEventListener('abort', finish)
    try { controller?.close() } catch { /* 浏览器已取消读取 */ }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController
      disposeEvents = coordinator.subscribeRuntimeEvent((event) => { if (event.type !== 'state') send(event) })
      disposeChat = chat?.subscribe(ownerId, (run, epoch) => {
        const lease = coordinator.snapshot()
        if (lease.active && lease.ownerId === ownerId && lease.epoch === epoch) {
          // 工具明细已经保存在通话记录中，不随每个文字增量重复传输。
          const { toolCalls: _toolCalls, ...snapshot } = run
          send({ type: 'chat', epoch, run: snapshot })
        }
      })
      // subscribe 会立即发出当前状态，让代理及时返回响应，并同步 Host epoch。
      disposeState = coordinator.subscribe((snapshot) => {
        const stateKey = `${snapshot.state}:${snapshot.epoch}:${snapshot.active}:${snapshot.ownerId}`
        // Client 会经 RPC 回报状态；相同快照不能再次发回，避免状态回声循环。
        if (stateKey !== lastState) send({ type: 'state', state: snapshot.state, epoch: snapshot.epoch })
        lastState = stateKey
        if (!snapshot.active || snapshot.ownerId !== ownerId) finish()
      })
      request.signal.addEventListener('abort', finish, { once: true })
      // 静音时没有 partial；空行维持反向代理连接，Client 会直接忽略。
      keepAlive = setInterval(() => {
        try { controller?.enqueue(encoder.encode('\n')) } catch { finish() }
      }, 10_000)
      ;(keepAlive as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
      if (request.signal.aborted) finish()
    },
    pull() {
      const latest = pendingChat
      pendingChat = undefined
      if (latest !== undefined) send(latest)
    },
    cancel: finish,
  })
  return new Response(stream, { headers: {
    ...(chat === undefined ? {} : { 'x-codingns-voice-chat-stream': '1' }),
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no',
  } })
}
