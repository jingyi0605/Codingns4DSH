import type { GlobalVoiceCoordinator } from './global-voice-coordinator.js'
import { encodeVoiceStreamEvent, pcmFrameFromStream, VoiceStreamDecoder, type VoiceStreamOpenMessage } from '../../shared/voice-stream.js'
import type { VoiceRuntimeEvent } from '../../shared/contracts/voice-runtime.js'

export interface AssistantVoiceStreamOptions {
  readonly coordinator: GlobalVoiceCoordinator
}

/**
 * Host 的流式入口只转发 PCM 和运行时事件，不把音频字节塞进 JSON RPC。
 * 浏览器通过同源 HTTPS 访问此路由，因而麦克风权限属于真正打开页面的客户端。
 */
export function createAssistantVoiceStreamHandler(options: AssistantVoiceStreamOptions): (request: Request) => Promise<Response> {
  return async (request) => {
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
      if (closed) {
        disposeEvents?.()
        disposeEvents = undefined
      }
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
