/** DSH 多路复用层使用的 Host 作用域。 */
export interface DshHostScope {
  hostId: string
  hostLabel?: string
  workspaceId?: string
  sessionId?: string
  kind: 'local' | 'remote'
}

export type DshChannel =
  | 'session'
  | 'rpc'
  | 'adapter'
  | 'pty'
  | 'task'
  | 'file'
  | 'port'
  | 'peerhost'
  | 'plugin'
  | 'web'

export interface DshEnvelopeFlags {
  endOfStream?: boolean
  cancelled?: boolean
  binary?: boolean
}

/** DSH 业务层的统一消息格式。body 永远是原始二进制，不在这里做 Base64。 */
export interface DshEnvelope {
  version: 1
  messageId: string
  streamId: string
  channel: DshChannel
  type: string
  sequence: number
  generation: string
  hostScope: DshHostScope
  flags?: DshEnvelopeFlags
  meta: Record<string, unknown>
  body?: Uint8Array
}

export interface DshEnvelopeCodecOptions {
  maxBytes?: number
  maxMetaBytes?: number
}

export const DSH_ENVELOPE_VERSION = 1 as const
export const DSH_ENVELOPE_PROTOCOL = 'dsh-transport-v1'
// Web 插件聚合 bundle 可能达到数 MiB；物理 DataChannel 已负责 64 KiB 分片，
// Envelope 层只限制单条逻辑消息，和 Host 资源上限保持 16 MiB 一致。
export const DEFAULT_MAX_DSH_ENVELOPE_BYTES = 16 * 1024 * 1024
export const DEFAULT_MAX_DSH_META_BYTES = 64 * 1024

const MAGIC = new Uint8Array([0x44, 0x53, 0x48, 0x01])
const channels = new Set<DshChannel>(['session', 'rpc', 'adapter', 'pty', 'task', 'file', 'port', 'peerhost', 'plugin', 'web'])

/** 编码为 `DSH1 | 4 字节 JSON 头长度 | JSON 头 | 原始 body`。 */
export function encodeDshEnvelope(envelope: DshEnvelope, options: DshEnvelopeCodecOptions = {}): Uint8Array {
  validateDshEnvelope(envelope)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DSH_ENVELOPE_BYTES
  const maxMetaBytes = options.maxMetaBytes ?? DEFAULT_MAX_DSH_META_BYTES
  validateLimit(maxBytes, 'Envelope')
  validateLimit(maxMetaBytes, 'Envelope meta')
  const body = envelope.body ?? new Uint8Array()
  const header: Omit<DshEnvelope, 'body'> & { bodyLength: number } = { ...envelope, bodyLength: body.byteLength }
  delete (header as { body?: Uint8Array }).body
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  if (headerBytes.byteLength > maxMetaBytes) throw new Error('DSH Envelope meta 超过大小限制')
  const result = new Uint8Array(MAGIC.byteLength + 4 + headerBytes.byteLength + body.byteLength)
  result.set(MAGIC, 0)
  new DataView(result.buffer).setUint32(MAGIC.byteLength, headerBytes.byteLength)
  result.set(headerBytes, MAGIC.byteLength + 4)
  result.set(body, MAGIC.byteLength + 4 + headerBytes.byteLength)
  if (result.byteLength > maxBytes) throw new Error('DSH Envelope 超过大小限制')
  return result
}

export function decodeDshEnvelope(data: Uint8Array, options: DshEnvelopeCodecOptions = {}): DshEnvelope {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DSH_ENVELOPE_BYTES
  const maxMetaBytes = options.maxMetaBytes ?? DEFAULT_MAX_DSH_META_BYTES
  validateLimit(maxBytes, 'Envelope')
  validateLimit(maxMetaBytes, 'Envelope meta')
  if (!(data instanceof Uint8Array)) throw new Error('DSH Envelope 必须是 Uint8Array')
  if (data.byteLength > maxBytes) throw new Error('DSH Envelope 超过大小限制')
  if (data.byteLength < MAGIC.byteLength + 4 || !MAGIC.every((value, index) => data[index] === value)) {
    throw new Error('DSH Envelope magic 无效')
  }
  const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(MAGIC.byteLength)
  if (headerLength > maxMetaBytes || MAGIC.byteLength + 4 + headerLength > data.byteLength) {
    throw new Error('DSH Envelope 头部长度无效')
  }
  let header: unknown
  try {
    header = JSON.parse(new TextDecoder().decode(data.subarray(MAGIC.byteLength + 4, MAGIC.byteLength + 4 + headerLength)))
  } catch (error) {
    throw new Error('DSH Envelope 头部不是有效 JSON', { cause: error })
  }
  if (!header || typeof header !== 'object') throw new Error('DSH Envelope 头部无效')
  const value = header as Record<string, unknown>
  const bodyLength = value.bodyLength
  if (typeof bodyLength !== 'number' || !Number.isSafeInteger(bodyLength) || bodyLength < 0 || MAGIC.byteLength + 4 + headerLength + bodyLength !== data.byteLength) {
    throw new Error('DSH Envelope body 长度无效')
  }
  delete value.bodyLength
  validateDshEnvelope(value)
  const body = data.subarray(MAGIC.byteLength + 4 + headerLength)
  return body.byteLength === 0 ? value as DshEnvelope : { ...value as DshEnvelope, body: body.slice() }
}

export function validateDshEnvelope(value: unknown): asserts value is DshEnvelope {
  if (!value || typeof value !== 'object') throw new Error('DSH Envelope 必须是对象')
  const envelope = value as Partial<DshEnvelope>
  if (envelope.version !== DSH_ENVELOPE_VERSION) throw new Error('DSH Envelope 版本不兼容')
  if (typeof envelope.messageId !== 'string' || envelope.messageId.length === 0) throw new Error('DSH Envelope messageId 无效')
  if (typeof envelope.streamId !== 'string' || envelope.streamId.length === 0) throw new Error('DSH Envelope streamId 无效')
  if (!channels.has(envelope.channel as DshChannel)) throw new Error('DSH Envelope channel 无效')
  if (typeof envelope.type !== 'string' || envelope.type.length === 0) throw new Error('DSH Envelope type 无效')
  if (!Number.isSafeInteger(envelope.sequence) || (envelope.sequence as number) < 0) throw new Error('DSH Envelope sequence 无效')
  if (typeof envelope.generation !== 'string' || envelope.generation.length === 0) throw new Error('DSH Envelope generation 无效')
  validateHostScope(envelope.hostScope)
  if (!envelope.meta || typeof envelope.meta !== 'object' || Array.isArray(envelope.meta)) throw new Error('DSH Envelope meta 无效')
  if (envelope.body !== undefined && !(envelope.body instanceof Uint8Array)) throw new Error('DSH Envelope body 必须是 Uint8Array')
}

function validateHostScope(scope: unknown): asserts scope is DshHostScope {
  if (!scope || typeof scope !== 'object') throw new Error('DSH Envelope hostScope 无效')
  const value = scope as Partial<DshHostScope>
  if (typeof value.hostId !== 'string' || value.hostId.length === 0) throw new Error('DSH Envelope hostScope.hostId 无效')
  if (value.kind !== 'local' && value.kind !== 'remote') throw new Error('DSH Envelope hostScope.kind 无效')
  for (const key of ['hostLabel', 'workspaceId', 'sessionId'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`DSH Envelope hostScope.${key} 无效`)
  }
}

function validateLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 大小限制无效`)
}
