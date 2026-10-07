import type { VoicePcmFrame } from '../shared/contracts/voice-runtime.js'
import { encodeVoiceStreamMessage, encodeVoiceStreamOpen } from '../shared/voice-stream.js'
import { voiceDiagnosticId, voiceDiagnosticError, type VoiceDiagnosticTrace } from '../shared/voice-diagnostics.js'

interface VoiceStreamUploaderOptions {
  readonly url: string
  readonly ownerId: string
  readonly clientId: string
  readonly onError: (error: Error) => void
  readonly trace?: VoiceDiagnosticTrace
}

interface PendingVoiceFrame {
  readonly frame: VoicePcmFrame
  readonly epoch: number
}

const UPLOAD_INTERVAL_MS = 60
const MAX_PENDING_AUDIO_MS = 5000
const MAX_PENDING_PCM_BYTES = 16_000 * 2 * MAX_PENDING_AUDIO_MS / 1000

/**
 * 持续采集的 PCM 用有限长度的二进制 POST 顺序发送。
 * 不依赖浏览器的请求流上传，也不等待用户说完一句话才交给识别器。
 */
export class VoiceStreamUploader {
  private readonly options: VoiceStreamUploaderOptions
  private readonly abort = new AbortController()
  private pending: PendingVoiceFrame[] = []
  private pendingBytes = 0
  private pendingAudioMs = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private sending = false
  private closed = false
  private pendingAt = 0
  private lastPressureAt = 0
  private inFlight: { diagnosticId: string; startedAt: number } | undefined

  constructor(options: VoiceStreamUploaderOptions) { this.options = options }

  enqueue(frame: VoicePcmFrame, epoch: number): void {
    if (this.closed || frame.bytes.length === 0) return
    if (this.pending.length === 0) this.pendingAt = performance.now()
    const audioMs = frame.bytes.length / 2 / frame.sampleRate * 1000
    // 用真实 PCM 时长限制积压；JSON 小帧首部不能占用音频的容错预算。
    if (this.pendingBytes + frame.bytes.length > MAX_PENDING_PCM_BYTES || this.pendingAudioMs + audioMs > MAX_PENDING_AUDIO_MS) {
      this.fail(new Error('语音音频积压超过 5 秒，Host 或连接处理过慢，请稍后重新开始实时对话'), 'upload_backlog')
      return
    }
    this.pending.push({ frame: { ...frame, bytes: frame.bytes.slice() }, epoch })
    this.pendingBytes += frame.bytes.length; this.pendingAudioMs += audioMs
    const now = performance.now()
    if (this.pendingAudioMs >= 1000 && now - this.lastPressureAt >= 1000) {
      this.lastPressureAt = now
      this.options.trace?.('client.upload.pressure', this.pressureFields())
    }
    this.schedule()
  }

  /** 打断后清掉尚未发出的旧 epoch；已经在途的帧由 Host 丢弃。 */
  clearPending(): void { this.pending = []; this.pendingBytes = 0; this.pendingAudioMs = 0 }

  close(): void {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.clearPending()
    this.abort.abort()
  }

  private schedule(): void {
    if (this.closed || this.sending || this.timer !== undefined || this.pending.length === 0) return
    // 在途请求结束时，已经等待够 60 ms 的音频立即发送，不再多等一轮。
    const delay = Math.max(0, UPLOAD_INTERVAL_MS - (performance.now() - this.pendingAt))
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, delay)
  }

  private async flush(): Promise<void> {
    if (this.closed || this.sending || this.pending.length === 0) return
    const open = encodeVoiceStreamOpen({ ownerId: this.options.ownerId, clientId: this.options.clientId, sampleRate: 16_000, channels: 1, encoding: 'pcm16le' })
    const parts = this.encodePendingFrames()
    const headerBytes = parts.reduce((size, part) => size + part.length, 0) - this.pendingBytes
    const body = new Uint8Array(open.length + this.pendingBytes + headerBytes)
    const started = performance.now()
    const diagnosticId = voiceDiagnosticId()
    const fields = { diagnosticId, clientId: this.options.clientId, epoch: this.pending[0]!.epoch, firstSequence: this.pending[0]!.frame.sequence, lastSequence: this.pending.at(-1)!.frame.sequence, frames: parts.length / 2, count: this.pending.length, bytes: body.length, pcmBytes: this.pendingBytes, headerBytes, audioMs: this.pendingAudioMs, waitMs: started - this.pendingAt }
    if (body.length > 256 * 1024) { this.fail(new Error('语音上传批次超过 Host 限制，请重新开始实时对话'), 'upload_batch_limit'); return }
    body.set(open)
    let offset = open.length
    for (const bytes of parts) { body.set(bytes, offset); offset += bytes.length }
    this.clearPending()
    this.sending = true
    this.inFlight = { diagnosticId, startedAt: started }
    this.options.trace?.('client.upload.start', fields)
    const timeout = setTimeout(() => this.fail(new Error('语音上传超过 5 秒未返回，Host 或连接没有及时响应，请稍后重新开始实时对话'), 'upload_timeout'), 5_000)
    try {
      const response = await globalThis.fetch(this.options.url, {
        method: 'POST', body, signal: this.abort.signal, credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream', 'x-codingns-voice-diagnostic-id': diagnosticId },
      })
      this.options.trace?.('client.upload.batch', { ...fields, status: response.status, durationMs: performance.now() - started, pendingBytes: this.pendingBytes })
      if (!response.ok) throw await createVoiceHttpError(response, '语音上传失败')
    } catch (error) {
      if (!this.closed) this.fail(error instanceof Error ? error : new Error(String(error)), 'upload_transport_error')
    } finally {
      clearTimeout(timeout)
      this.sending = false
      this.inFlight = undefined
      this.schedule()
    }
  }

  /** 同代次、同采样率的连续 PCM 合并到约 40 ms，保留全部样本与顺序。 */
  private encodePendingFrames(): Uint8Array[] {
    const parts: Uint8Array[] = []
    let index = 0
    while (index < this.pending.length) {
      const first = this.pending[index]!
      const grouped: Uint8Array[] = [first.frame.bytes]
      let bytes = first.frame.bytes.length
      let sequence = first.frame.sequence
      index++
      while (index < this.pending.length) {
        const next = this.pending[index]!
        if (next.epoch !== first.epoch || next.frame.sampleRate !== first.frame.sampleRate || next.frame.sequence !== sequence + 1 || bytes + next.frame.bytes.length > first.frame.sampleRate * 2 * 0.04) break
        grouped.push(next.frame.bytes); bytes += next.frame.bytes.length; sequence = next.frame.sequence; index++
      }
      const pcm = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of grouped) { pcm.set(chunk, offset); offset += chunk.length }
      parts.push(encodeVoiceStreamMessage({ type: 'pcm', sequence, sampleRate: first.frame.sampleRate, channels: 1, epoch: first.epoch, byteLength: pcm.length }), pcm)
    }
    return parts
  }

  private pressureFields() {
    return { clientId: this.options.clientId, pendingBytes: this.pendingBytes, pendingAudioMs: this.pendingAudioMs, pending: this.pending.length, diagnosticId: this.inFlight?.diagnosticId, inFlightMs: this.inFlight === undefined ? 0 : performance.now() - this.inFlight.startedAt }
  }

  private fail(error: Error, code: string): void {
    if (this.closed) return
    this.options.trace?.('client.upload.error', { ...this.pressureFields(), code, errorName: voiceDiagnosticError(error) })
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
