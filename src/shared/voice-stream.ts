import type { VoicePcmFrame, VoiceRuntimeEvent } from './contracts/voice-runtime.js'

export const ASSISTANT_VOICE_STREAM_PATH = '/api/codingns/assistant/voice/stream'
export const ASSISTANT_VOICE_EVENTS_PATH = '/api/codingns/assistant/voice/events'

/** 浏览器到 Host 的 PCM 流首部。首部和后续帧都使用 UTF-8 JSON 行分隔。 */
export interface VoiceStreamOpenMessage {
  readonly type: 'open'
  readonly ownerId: string
  readonly clientId: string
  readonly sampleRate: number
  readonly channels: 1
  readonly encoding: 'pcm16le'
}

export interface VoiceStreamPcmMessage {
  readonly type: 'pcm'
  readonly sequence: number
  readonly sampleRate: number
  readonly channels: 1
  readonly epoch: number
  readonly byteLength: number
}

export interface VoiceStreamControlMessage {
  readonly type: 'interrupt' | 'close'
  readonly epoch?: number
}

export type VoiceStreamMessage = VoiceStreamOpenMessage | VoiceStreamPcmMessage | VoiceStreamControlMessage

export function encodeVoiceStreamMessage(message: VoiceStreamMessage): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`)
}

export function encodeVoiceStreamOpen(message: Omit<VoiceStreamOpenMessage, 'type'>): Uint8Array {
  return encodeVoiceStreamMessage({ type: 'open', ...message })
}

/**
 * 解析任意 chunk 边界下的二进制 PCM 流。JSON 行后紧跟 byteLength 字节，
 * 所以不会因为网络分片把一个音频帧误当成两个帧。
 */
export class VoiceStreamDecoder {
  private pending = new Uint8Array(0)
  private expectedBytes = 0
  private pendingPcm: VoiceStreamPcmMessage | undefined

  /** 有限 POST 结束时校验尾部，截断的音频帧不能被静默接受。 */
  finish(): void {
    if (this.pending.length !== 0 || this.pendingPcm !== undefined) throw new Error('语音 PCM 流不完整')
  }

  push(chunk: Uint8Array): Array<{ readonly message: VoiceStreamMessage; readonly pcm?: Uint8Array }> {
    if (chunk.length > 0) this.pending = concatBytes(this.pending, chunk) as Uint8Array<ArrayBuffer>
    const output: Array<{ readonly message: VoiceStreamMessage; readonly pcm?: Uint8Array }> = []
    while (true) {
      if (this.pendingPcm !== undefined) {
        if (this.pending.length < this.expectedBytes) break
        const pcm = this.pending.slice(0, this.expectedBytes)
        this.pending = this.pending.slice(this.expectedBytes)
        output.push({ message: this.pendingPcm, pcm })
        this.pendingPcm = undefined
        this.expectedBytes = 0
        continue
      }
      const newline = this.pending.indexOf(10)
      if (newline < 0) break
      const line = new TextDecoder().decode(this.pending.slice(0, newline)).trim()
      this.pending = this.pending.slice(newline + 1)
      if (line === '') continue
      const message = parseVoiceStreamMessage(JSON.parse(line) as unknown)
      if (message.type === 'pcm') {
        this.pendingPcm = message
        this.expectedBytes = message.byteLength
        if (message.byteLength === 0) {
          output.push({ message, pcm: new Uint8Array(0) })
          this.pendingPcm = undefined
        }
      } else output.push({ message })
    }
    return output
  }
}

export function encodeVoiceStreamEvent(event: VoiceRuntimeEvent): string {
  return `${JSON.stringify(serializeVoiceRuntimeEvent(event))}\n`
}

export function parseVoiceStreamMessage(value: unknown): VoiceStreamMessage {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('语音流控制消息无效')
  if (value.type === 'open') {
    if (typeof value.ownerId !== 'string' || typeof value.clientId !== 'string' || !isPositiveInteger(value.sampleRate) || value.channels !== 1 || value.encoding !== 'pcm16le') throw new Error('语音流首部无效')
    return { type: 'open', ownerId: value.ownerId, clientId: value.clientId, sampleRate: value.sampleRate, channels: 1, encoding: 'pcm16le' }
  }
  if (value.type === 'pcm') {
    if (!isNonNegativeInteger(value.sequence) || !isPositiveInteger(value.sampleRate) || value.channels !== 1 || !isNonNegativeInteger(value.epoch) || !isNonNegativeInteger(value.byteLength) || value.byteLength > 1024 * 1024) throw new Error('语音 PCM 帧无效')
    return { type: 'pcm', sequence: value.sequence, sampleRate: value.sampleRate, channels: 1, epoch: value.epoch, byteLength: value.byteLength }
  }
  if (value.type === 'interrupt' || value.type === 'close') return { type: value.type, ...(isNonNegativeInteger(value.epoch) ? { epoch: value.epoch } : {}) }
  throw new Error('未知语音流控制消息')
}

export function pcmFrameFromStream(message: VoiceStreamPcmMessage, pcm: Uint8Array): VoicePcmFrame {
  if (pcm.length !== message.byteLength) throw new Error('语音 PCM 帧长度不匹配')
  return { sequence: message.sequence, bytes: pcm, sampleRate: message.sampleRate, channels: 1 }
}

function serializeVoiceRuntimeEvent(event: VoiceRuntimeEvent): unknown {
  if (event.type !== 'audio') return event
  return { ...event, bytesBase64: encodeBase64(event.bytes), bytes: undefined }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)))
  if (typeof btoa === 'function') return btoa(binary)
  return Buffer.from(bytes).toString('base64')
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isPositiveInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0 }
function isNonNegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 }
