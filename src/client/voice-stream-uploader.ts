import type { VoicePcmFrame } from '../shared/contracts/voice-runtime.js'
import { encodeVoiceStreamMessage, encodeVoiceStreamOpen } from '../shared/voice-stream.js'

interface VoiceStreamUploaderOptions {
  readonly url: string
  readonly ownerId: string
  readonly clientId: string
  readonly onError: (error: Error) => void
}

/**
 * 持续采集的 PCM 用有限长度的二进制 POST 顺序发送。
 * 不依赖浏览器的请求流上传，也不等待用户说完一句话才交给识别器。
 */
export class VoiceStreamUploader {
  private readonly options: VoiceStreamUploaderOptions
  private readonly abort = new AbortController()
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private sending = false
  private closed = false

  constructor(options: VoiceStreamUploaderOptions) { this.options = options }

  enqueue(frame: VoicePcmFrame, epoch: number): void {
    if (this.closed) return
    const header = encodeVoiceStreamMessage({ type: 'pcm', sequence: frame.sequence, sampleRate: frame.sampleRate, channels: 1, epoch, byteLength: frame.bytes.byteLength })
    // 16 kHz 单声道 PCM 每秒约 32 KiB；网络跟不上时停止，避免无限积压旧音频。
    if (this.pendingBytes + header.length + frame.bytes.length > 128 * 1024) {
      this.fail(new Error('语音上传积压过多，请检查网络后重新开始实时对话'))
      return
    }
    this.pending.push(header, frame.bytes.slice())
    this.pendingBytes += header.length + frame.bytes.length
    this.schedule()
  }

  /** 打断后清掉尚未发出的旧 epoch；已经在途的帧由 Host 丢弃。 */
  clearPending(): void { this.pending = []; this.pendingBytes = 0 }

  close(): void {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.clearPending()
    this.abort.abort()
  }

  private schedule(): void {
    if (this.closed || this.sending || this.timer !== undefined || this.pending.length === 0) return
    // 合并 AudioWorklet 的小帧，每 60 ms 提交一次，减少 HTTP 请求开销。
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 60)
  }

  private async flush(): Promise<void> {
    if (this.closed || this.sending || this.pending.length === 0) return
    const open = encodeVoiceStreamOpen({ ownerId: this.options.ownerId, clientId: this.options.clientId, sampleRate: 16_000, channels: 1, encoding: 'pcm16le' })
    const body = new Uint8Array(open.length + this.pendingBytes)
    body.set(open)
    let offset = open.length
    for (const bytes of this.pending) { body.set(bytes, offset); offset += bytes.length }
    this.clearPending()
    this.sending = true
    const timeout = setTimeout(() => this.fail(new Error('语音上传超时，请检查网络后重新开始实时对话')), 5_000)
    try {
      const response = await globalThis.fetch(this.options.url, {
        method: 'POST', body, signal: this.abort.signal, credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
      })
      if (!response.ok) throw await createVoiceHttpError(response, '语音上传失败')
    } catch (error) {
      if (!this.closed) this.fail(error instanceof Error ? error : new Error(String(error)))
    } finally {
      clearTimeout(timeout)
      this.sending = false
      this.schedule()
    }
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.close()
    this.options.onError(error)
  }
}

/** 保留 Host 的结构化错误；空正文的外层 400 仍显示原始状态码。 */
export async function createVoiceHttpError(response: Response, message: string): Promise<Error> {
  const value: unknown = await response.json().catch(() => undefined)
  const detail = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
    ? value.error.slice(0, 500)
    : ''
  return new Error(`${message}（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`)
}
