export const TUNNEL_PROTOCOL_VERSION = 1
/** 单帧默认上限。真实 Relay/Host 可在装配时覆盖，但不能无限制接受远端输入。 */
export const DEFAULT_MAX_TUNNEL_FRAME_BYTES = 1024 * 1024

export type TunnelChannel = 'rpc' | 'fetch' | 'stream' | 'event' | 'control'
export type TunnelFrameKind = 'open' | 'data' | 'close' | 'cancel' | 'window' | 'error'

export interface TunnelFrame {
  version: typeof TUNNEL_PROTOCOL_VERSION
  channel: TunnelChannel
  id: string
  sequence: number
  kind: TunnelFrameKind
  payload?: unknown
}

export interface TunnelFrameCodecOptions {
  maxBytes?: number
}

const channels = new Set<TunnelChannel>(['rpc', 'fetch', 'stream', 'event', 'control'])
const kinds = new Set<TunnelFrameKind>(['open', 'data', 'close', 'cancel', 'window', 'error'])

export function encodeTunnelFrame(frame: TunnelFrame, options?: TunnelFrameCodecOptions): string {
  validateTunnelFrame(frame)
  const encoded = JSON.stringify(frame)
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_TUNNEL_FRAME_BYTES
  validateMaxBytes(maxBytes)
  if (utf8ByteLength(encoded) > maxBytes) throw new Error('Tunnel Frame 超过大小限制')
  return encoded
}

export function decodeTunnelFrame(data: string, options?: TunnelFrameCodecOptions): TunnelFrame {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_TUNNEL_FRAME_BYTES
  validateMaxBytes(maxBytes)
  if (utf8ByteLength(data) > maxBytes) throw new Error('Tunnel Frame 超过大小限制')
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (error) {
    throw new Error('Tunnel Frame 不是有效 JSON', { cause: error })
  }
  validateTunnelFrame(value)
  return value
}

export function validateTunnelFrame(value: unknown): asserts value is TunnelFrame {
  if (!value || typeof value !== 'object') throw new Error('Tunnel Frame 必须是对象')
  const frame = value as Partial<TunnelFrame>
  if (frame.version !== TUNNEL_PROTOCOL_VERSION) throw new Error('Tunnel Frame 版本不兼容')
  if (!channels.has(frame.channel as TunnelChannel)) throw new Error('Tunnel Frame channel 无效')
  if (!kinds.has(frame.kind as TunnelFrameKind)) throw new Error('Tunnel Frame kind 无效')
  if (typeof frame.id !== 'string' || frame.id.length === 0) throw new Error('Tunnel Frame id 无效')
  if (!Number.isSafeInteger(frame.sequence) || (frame.sequence as number) < 0) throw new Error('Tunnel Frame sequence 无效')
}

function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength
  return unescape(encodeURIComponent(value)).length
}

export function tunnelFrameByteLength(value: string): number {
  return utf8ByteLength(value)
}

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Tunnel Frame 大小限制无效')
}
