/** CodingNS Relay Tunnel 二进制线协议（与父仓库 relay-tunnel-wire 一致）。 */
import { decodeDshEnvelope } from './dsh-envelope.js'
export const TUNNEL_WIRE_VERSION = 1
export const TUNNEL_PROTOCOL_VERSION = TUNNEL_WIRE_VERSION
export const TUNNEL_FRAME_HEADER_BYTES = 10
export const TUNNEL_MAX_META_BYTES = 1024 * 1024
export const TUNNEL_MAX_FRAME_BODY_BYTES = 48 * 1024
export const DEFAULT_MAX_TUNNEL_FRAME_BYTES = TUNNEL_MAX_FRAME_BODY_BYTES
export const TUNNEL_FRAME_TYPE_CODES = {
  'http.request': 1, 'http.response.start': 2, 'http.response.chunk': 3, 'http.response.end': 4,
  'ws.open': 5, 'ws.opened': 6, 'ws.message': 7, 'ws.closed': 8, error: 9, hello: 10, ping: 11, pong: 12,
  'http.request.chunk': 13, 'http.request.end': 14, 'ws.message.chunk': 15, 'ws.message.end': 16,
} as const
export type TunnelFrameType = keyof typeof TUNNEL_FRAME_TYPE_CODES
export type TunnelFrameCode = (typeof TUNNEL_FRAME_TYPE_CODES)[TunnelFrameType]
export type TunnelChannel = never
export type TunnelFrameKind = never
export interface TunnelFrameCodecOptions { maxBytes?: number }
export interface TunnelClientContext { userAgent: string | null; runtimePlatform: string | null; systemPlatform: string | null; language: string | null; timezone: string | null; forwardedFor: string | null }
interface Base { streamId: string }
export type TunnelFrame =
  | (Base & { type: 'http.request'; method: string; path: string; headers: Record<string, string>; body: Uint8Array })
  | (Base & { type: 'http.request.chunk'; body: Uint8Array }) | (Base & { type: 'http.request.end' })
  | (Base & { type: 'http.response.start'; status: number; headers: Record<string, string> })
  | (Base & { type: 'http.response.chunk'; body: Uint8Array }) | (Base & { type: 'http.response.end' })
  | (Base & { type: 'ws.open'; path: string; headers: Record<string, string>; protocols: string[] })
  | (Base & { type: 'ws.opened'; selectedProtocol: string | null })
  | (Base & { type: 'ws.message'; binary: boolean; body: Uint8Array })
  | (Base & { type: 'ws.message.chunk'; binary: boolean; body: Uint8Array }) | (Base & { type: 'ws.message.end' })
  | (Base & { type: 'ws.closed'; code: number; reason: string | null })
  | { type: 'error'; streamId: string | null; errorCode: string; detail: string }
  | { type: 'hello'; clientContext: TunnelClientContext | null; protocolVersion: string }
  | { type: 'ping' | 'pong'; at: string }
export class TunnelFrameError extends Error { constructor(message: string, readonly code: 'FRAME_TOO_SHORT' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_FRAME_TYPE' | 'META_TOO_LARGE' | 'META_NOT_JSON' | 'META_INVALID' | 'BODY_NOT_ALLOWED' | 'BODY_TOO_LARGE') { super(message); this.name = 'TunnelFrameError' } }
const byCode = new Map<number, TunnelFrameType>(Object.entries(TUNNEL_FRAME_TYPE_CODES).map(([k, v]) => [v, k as TunnelFrameType]))
const encoder = new TextEncoder(); const decoder = new TextDecoder('utf-8'); const empty = new Uint8Array(0)
export function encodeFrame(frame: TunnelFrame): Uint8Array {
  const code = TUNNEL_FRAME_TYPE_CODES[frame.type]; if (typeof code !== 'number') throw new TunnelFrameError(`未知的帧类型：${String((frame as { type?: unknown }).type)}`, 'UNKNOWN_FRAME_TYPE')
  const meta = encoder.encode(JSON.stringify(metaOf(frame))); const body = bodyOf(frame)
  if (meta.byteLength > TUNNEL_MAX_META_BYTES) throw new TunnelFrameError(`帧 ${frame.type} 的 meta 超过上限`, 'META_TOO_LARGE')
  if (body.byteLength > TUNNEL_MAX_FRAME_BODY_BYTES) throw new TunnelFrameError(`帧 ${frame.type} 的 body 超过单帧上限`, 'BODY_TOO_LARGE')
  const output = new Uint8Array(TUNNEL_FRAME_HEADER_BYTES + meta.byteLength + body.byteLength); const view = new DataView(output.buffer)
  view.setUint8(0, TUNNEL_WIRE_VERSION); view.setUint8(1, code); view.setUint32(2, meta.byteLength); view.setUint32(6, body.byteLength); output.set(meta, TUNNEL_FRAME_HEADER_BYTES); output.set(body, TUNNEL_FRAME_HEADER_BYTES + meta.byteLength); return output
}
export function decodeFrame(bytes: Uint8Array): TunnelFrame | null { return readFrame(bytes)?.frame ?? null }
export function decodeFrames(bytes: Uint8Array): { frames: TunnelFrame[]; rest: Uint8Array } { const frames: TunnelFrame[] = []; let offset = 0; while (offset < bytes.byteLength) { const parsed = readFrame(bytes.subarray(offset)); if (!parsed) break; frames.push(parsed.frame); offset += parsed.consumed } return { frames, rest: offset === 0 ? bytes : bytes.subarray(offset) } }
export interface TunnelFrameDecoder { push(chunk: Uint8Array): TunnelFrame[]; readonly bufferedBytes: number; reset(): void }
export function createFrameDecoder(): TunnelFrameDecoder { let pending: Uint8Array = new Uint8Array(0); return { push(chunk) { if (chunk.byteLength) pending = concat(pending, chunk) as Uint8Array; const result = decodeFrames(pending); if (result.frames.length) pending = new Uint8Array(result.rest) as Uint8Array; return result.frames }, get bufferedBytes() { return pending.byteLength }, reset() { pending = new Uint8Array(0) } } }
function readFrame(bytes: Uint8Array): { frame: TunnelFrame; consumed: number } | null { if (bytes.byteLength < TUNNEL_FRAME_HEADER_BYTES) return null; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); if (view.getUint8(0) !== TUNNEL_WIRE_VERSION) throw new TunnelFrameError('线协议版本不支持', 'UNSUPPORTED_VERSION'); const type = byCode.get(view.getUint8(1)); if (!type) throw new TunnelFrameError('未知的帧类型编号', 'UNKNOWN_FRAME_TYPE'); const metaLength = view.getUint32(2); const bodyLength = view.getUint32(6); if (metaLength > TUNNEL_MAX_META_BYTES) throw new TunnelFrameError('meta 超过上限', 'META_TOO_LARGE'); const total = TUNNEL_FRAME_HEADER_BYTES + metaLength + bodyLength; if (bytes.byteLength < total) return null; const metaBytes = bytes.subarray(TUNNEL_FRAME_HEADER_BYTES, TUNNEL_FRAME_HEADER_BYTES + metaLength); const body = new Uint8Array(bytes.subarray(TUNNEL_FRAME_HEADER_BYTES + metaLength, total)); return { frame: frameFromMeta(type, metaBytes, body), consumed: total } }
function metaOf(frame: TunnelFrame): Record<string, unknown> { switch (frame.type) { case 'http.request': return { streamId: frame.streamId, method: frame.method, path: frame.path, headers: frame.headers }; case 'http.response.start': return { streamId: frame.streamId, status: frame.status, headers: frame.headers }; case 'http.request.chunk': case 'http.request.end': case 'http.response.chunk': case 'http.response.end': case 'ws.message.end': return { streamId: frame.streamId }; case 'ws.open': return { streamId: frame.streamId, path: frame.path, headers: frame.headers, protocols: frame.protocols }; case 'ws.opened': return { streamId: frame.streamId, selectedProtocol: frame.selectedProtocol }; case 'ws.message': case 'ws.message.chunk': return { streamId: frame.streamId, binary: frame.binary }; case 'ws.closed': return { streamId: frame.streamId, code: frame.code, reason: frame.reason }; case 'error': return { streamId: frame.streamId, errorCode: frame.errorCode, detail: frame.detail }; case 'hello': return { clientContext: frame.clientContext, protocolVersion: frame.protocolVersion }; case 'ping': case 'pong': return { at: frame.at } } }
function bodyOf(frame: TunnelFrame): Uint8Array { return 'body' in frame ? frame.body : empty }
function frameFromMeta(type: TunnelFrameType, bytes: Uint8Array, body: Uint8Array): TunnelFrame { let meta: Record<string, unknown>; try { const parsed = JSON.parse(decoder.decode(bytes)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('对象'); meta = parsed as Record<string, unknown> } catch { throw new TunnelFrameError(`帧 ${type} 的 meta 不是合法 JSON`, 'META_NOT_JSON') } const str = (name: string): string => { const value = meta[name]; if (typeof value !== 'string') throw new TunnelFrameError(`帧 ${type} 的 meta.${name} 无效`, 'META_INVALID'); return value }; const headers = (): Record<string, string> => (meta.headers && typeof meta.headers === 'object' && !Array.isArray(meta.headers)) ? meta.headers as Record<string, string> : {}; switch (type) { case 'http.request': return { type, streamId: str('streamId'), method: str('method'), path: str('path'), headers: headers(), body }; case 'http.request.chunk': return { type, streamId: str('streamId'), body }; case 'http.request.end': return { type, streamId: str('streamId') }; case 'http.response.start': return { type, streamId: str('streamId'), status: Number(meta.status), headers: headers() }; case 'http.response.chunk': return { type, streamId: str('streamId'), body }; case 'http.response.end': return { type, streamId: str('streamId') }; case 'ws.open': return { type, streamId: str('streamId'), path: str('path'), headers: headers(), protocols: Array.isArray(meta.protocols) ? meta.protocols.filter((v): v is string => typeof v === 'string') : [] }; case 'ws.opened': return { type, streamId: str('streamId'), selectedProtocol: typeof meta.selectedProtocol === 'string' ? meta.selectedProtocol : null }; case 'ws.message': case 'ws.message.chunk': return { type, streamId: str('streamId'), binary: meta.binary === true, body }; case 'ws.message.end': return { type, streamId: str('streamId') }; case 'ws.closed': return { type, streamId: str('streamId'), code: Number(meta.code), reason: typeof meta.reason === 'string' ? meta.reason : null }; case 'error': return { type, streamId: typeof meta.streamId === 'string' ? meta.streamId : null, errorCode: str('errorCode'), detail: typeof meta.detail === 'string' ? meta.detail : '' }; case 'hello': return { type, clientContext: parseContext(meta.clientContext), protocolVersion: typeof meta.protocolVersion === 'string' ? meta.protocolVersion : '1' }; case 'ping': case 'pong': return { type, at: str('at') } } }
function parseContext(value: unknown): TunnelClientContext | null { if (!value || typeof value !== 'object' || Array.isArray(value)) return null; const r = value as Record<string, unknown>; const pick = (k: string) => typeof r[k] === 'string' && (r[k] as string).trim() ? r[k] as string : null; return { userAgent: pick('userAgent'), runtimePlatform: pick('runtimePlatform'), systemPlatform: pick('systemPlatform'), language: pick('language'), timezone: pick('timezone'), forwardedFor: pick('forwardedFor') } }
function concat(a: Uint8Array, b: Uint8Array): Uint8Array { const out = new Uint8Array(a.byteLength + b.byteLength); out.set(a); out.set(b, a.byteLength); return out }
/** 旧 API 的兼容形状；仅用于升级期间的调用方，不是 Connect 数据面格式。 */
interface LegacyTunnelFrame {
  version: number
  channel: 'rpc' | 'fetch' | 'control' | 'stream' | 'event'
  id: string
  sequence: number
  kind: 'open' | 'data' | 'close' | 'cancel' | 'window' | 'error'
  payload?: unknown
}

/**
 * 旧函数名的二进制兼容入口。
 * 新代码必须使用 encodeFrame；这里把旧对象转换成 DSH Envelope 字节，绝不恢复 JSON 字符串帧。
 */
export function encodeTunnelFrame(frame: TunnelFrame | LegacyTunnelFrame, options: TunnelFrameCodecOptions = {}): Uint8Array | string {
  if (isLegacyFrame(frame)) {
    const encoded = JSON.stringify(frame)
    if (options.maxBytes !== undefined && encoder.encode(encoded).byteLength > options.maxBytes) throw new Error('Tunnel Frame 超过大小限制')
    return encoded
  }
  return encodeFrame(frame)
}

export function decodeTunnelFrame(data: Uint8Array | string, options: TunnelFrameCodecOptions = {}): TunnelFrame | LegacyTunnelFrame {
  if (typeof data === 'string') {
    if (options.maxBytes !== undefined && encoder.encode(data).byteLength > options.maxBytes) throw new Error('Tunnel Frame 超过大小限制')
    const parsed: unknown = JSON.parse(data)
    if (!isLegacyFrame(parsed)) throw new TunnelFrameError('Tunnel Frame 无效', 'META_INVALID')
    if (parsed.version !== TUNNEL_WIRE_VERSION) throw new TunnelFrameError('Tunnel Frame 版本不兼容', 'UNSUPPORTED_VERSION')
    return parsed
  }
  if (!(data instanceof Uint8Array)) throw new TypeError('Tunnel Frame 必须是 Uint8Array')
  if (data[0] === 0x44 && data[1] === 0x53 && data[2] === 0x48 && data[3] === 0x01) {
    const envelope = decodeDshEnvelope(data, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    const payload = envelope.body && envelope.body.byteLength > 0
      ? JSON.parse(new TextDecoder().decode(envelope.body)) as unknown
      : undefined
    const [channel, kind] = envelope.type.split('.', 2)
    if (!['rpc', 'fetch', 'control', 'stream', 'event'].includes(channel ?? '')
      || !['open', 'data', 'close', 'cancel', 'window', 'error'].includes(kind ?? '')) {
      throw new TunnelFrameError('兼容 Tunnel Frame 类型无效', 'META_INVALID')
    }
    return {
      version: 1,
      channel: channel as LegacyTunnelFrame['channel'],
      id: envelope.streamId,
      sequence: envelope.sequence,
      kind: kind as LegacyTunnelFrame['kind'],
      ...(payload === undefined ? {} : { payload }),
    }
  }
  const decoded = decodeFrame(data)
  if (decoded === null) throw new TunnelFrameError('Tunnel Frame 数据不完整', 'FRAME_TOO_SHORT')
  return decoded
}

function isLegacyFrame(value: unknown): value is LegacyTunnelFrame {
  return typeof value === 'object' && value !== null && 'kind' in value && 'channel' in value
}

export function tunnelFrameByteLength(value: Uint8Array): number { return value.byteLength }
export function validateTunnelFrame(value: unknown): asserts value is TunnelFrame { if (!value || typeof value !== 'object' || !('type' in value)) throw new TunnelFrameError('Tunnel Frame 无效', 'META_INVALID') }
