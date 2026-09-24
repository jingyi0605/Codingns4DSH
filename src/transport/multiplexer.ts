import type { CodingNsCarrier } from './carrier.js'
import { decodeDshEnvelope, encodeDshEnvelope, type DshChannel, type DshEnvelope, type DshHostScope } from './dsh-envelope.js'
import type { DshSession } from './dsh-session.js'

interface PendingUnary { resolve(value: unknown): void; reject(error: Error): void; accepted: boolean }
interface PendingStream<T> {
  queue: T[]
  queuedBytes: number
  waiters: Array<{ resolve(result: IteratorResult<T>): void; reject(error: Error): void }>
  closed: boolean
  error?: Error
  removeAbort: (() => void) | undefined
}

export interface TunnelFlowControl {
  maxFrameBytes?: number
  maxQueueBytes?: number
  canSend?(bytes: number, frame: DshEnvelope): boolean
  onSend?(bytes: number, frame: DshEnvelope): void
  onReceive?(bytes: number, frame: DshEnvelope): void
}
export interface DshTunnelMultiplexerOptions {
  idPrefix?: string
  generation?: string
  hostScope?: DshHostScope
  session?: DshSession
  requireSessionReady?: boolean
  flowControl?: TunnelFlowControl
}
const DEFAULT_SCOPE: DshHostScope = { hostId: 'unknown', kind: 'remote' }

/** DSH Envelope 层多路复用器；逻辑 API 保持 rpc/openStream，物理线路只发送二进制 Envelope。 */
export class DshTunnelMultiplexer {
  private readonly pending = new Map<string, PendingUnary>()
  private readonly streams = new Map<string, PendingStream<unknown>>()
  private sequence = 0
  private nextId = 0
  private disposed = false
  private readonly unsubscribe: () => void
  private idPrefix: string
  private readonly flowControl: TunnelFlowControl | undefined
  private generation: string
  private readonly hostScope: DshHostScope
  private readonly session: DshSession | undefined
  private readonly requireSessionReady: boolean

  constructor(private readonly carrier: CodingNsCarrier, options: DshTunnelMultiplexerOptions = {}) {
    this.idPrefix = options.idPrefix ?? 'g0'
    this.flowControl = options.flowControl
    this.generation = options.generation ?? this.idPrefix.replace(/^g/u, '')
    this.hostScope = options.hostScope ?? DEFAULT_SCOPE
    this.session = options.session
    this.requireSessionReady = options.requireSessionReady ?? options.session !== undefined
    this.unsubscribe = carrier.subscribe((data) => this.receive(data as unknown as Uint8Array))
  }

  request<T>(channel: 'rpc' | 'fetch' | 'control', payload: unknown, signal?: AbortSignal): Promise<T> {
    return this.requestOperation<T>(channel, channel === 'fetch' ? 'web.request' : 'rpc.request', payload, signal)
  }

  requestOperation<T>(channel: 'rpc' | 'fetch' | 'control' | 'web', operation: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    this.ensureOpen()
    const id = `${this.idPrefix}_req_${this.nextRequestId()}`
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return
        if (!this.disposed && this.carrier.state === 'open') {
          try { this.send({ streamId: id, channel: mapChannel(channel), type: 'stream.cancel', meta: { reason: String(signal?.reason ?? 'cancelled') } }) } catch { /* 取消尽力而为 */ }
        }
        reject(signal?.reason instanceof Error ? signal.reason : new Error('请求已取消'))
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
          resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value as T) },
          reject: (error) => { signal?.removeEventListener('abort', abort); reject(error) },
          accepted: false,
      })
      try {
        this.send({
          streamId: id,
          channel: mapChannel(channel),
          type: 'stream.open',
          meta: { operation, encoding: 'json' },
          body: encodeJson(payload),
        })
      } catch (error) {
        this.pending.delete(id)
        signal?.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  openStream<T>(payload: unknown, signal?: AbortSignal): AsyncIterable<T> {
    return this.openStreamOperation<T>('rpc', 'rpc.stream', payload, signal)
  }

  openStreamOperation<T>(channel: 'rpc' | 'web', operation: string, payload: unknown, signal?: AbortSignal): AsyncIterable<T> {
    return this.openStreamOperationWithId<T>(channel, operation, payload, signal).stream
  }

  openStreamOperationWithId<T>(channel: 'rpc' | 'web', operation: string, payload: unknown, signal?: AbortSignal): { streamId: string; stream: AsyncIterable<T> } {
    this.ensureOpen()
    if (signal?.aborted) return { streamId: '', stream: this.closedStream() }
    const id = `${this.idPrefix}_stream_${this.nextRequestId()}`
    const state: PendingStream<unknown> = { queue: [], queuedBytes: 0, waiters: [], closed: false, removeAbort: undefined }
    this.streams.set(id, state)
    const cancel = () => {
      if (state.closed) return
      state.closed = true
      if (!this.disposed && this.carrier.state === 'open') {
        try { this.send({ streamId: id, channel, type: 'stream.cancel', meta: {} }) } catch { /* 关闭路径尽力而为 */ }
      }
      this.finishStream(id, state)
    }
    if (signal) { signal.addEventListener('abort', cancel, { once: true }); state.removeAbort = () => signal.removeEventListener('abort', cancel) }
    try { this.send({ streamId: id, channel, type: 'stream.open', meta: { operation, encoding: 'json' }, body: encodeJson(payload) }) } catch (error) {
      state.error = error instanceof Error ? error : new Error(String(error)); this.finishStream(id, state)
    }
    const stream: AsyncIterable<T> = { [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<T>> => {
        if (state.error) throw state.error
        if (state.queue.length > 0) { state.queuedBytes = 0; return { done: false, value: state.queue.shift() as T } }
        if (state.closed) return { done: true, value: undefined }
        return new Promise((resolve, reject) => state.waiters.push({ resolve: (result) => resolve({ done: result.done === true, value: result.value as T }), reject }))
      },
      return: async (): Promise<IteratorResult<T>> => { cancel(); return { done: true, value: undefined as never } },
    }) }
    return { streamId: id, stream }
  }

  sendStreamMessage(streamId: string, channel: 'rpc' | 'web', type: string, meta: Record<string, unknown> = {}, body?: Uint8Array): void {
    this.ensureOpen()
    this.send({ streamId, channel, type, meta, ...(body === undefined ? {} : { body }) })
  }

  closeStream(streamId: string, channel: 'rpc' | 'web' = 'web'): void {
    if (this.disposed || this.carrier.state !== 'open') return
    try { this.sendStreamMessage(streamId, channel, 'stream.cancel', {}) } catch { /* 关闭路径尽力而为 */ }
  }

  close(error = new Error('Transport 已关闭')): void {
    if (this.disposed) return
    this.disposed = true; this.unsubscribe()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const [id, stream] of this.streams) { stream.error = error; this.finishStream(id, stream) }
  }
  invalidate(error = new Error('Transport generation 已过期')): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const [id, stream] of this.streams) { stream.error = error; this.finishStream(id, stream) }
  }
  rotateGeneration(idPrefix: string, error = new Error('Transport generation 已过期')): void {
    this.invalidate(error)
    this.idPrefix = idPrefix
    this.generation = idPrefix.replace(/^g/u, '')
  }

  private receive(data: Uint8Array | string): void {
    let envelope: DshEnvelope
    try {
      if (typeof data === 'string') {
        const legacy = JSON.parse(data) as { id: string; channel: string; kind: string; sequence: number; payload?: unknown }
        envelope = legacyEnvelope(legacy)
      } else {
        const options = this.flowControl?.maxFrameBytes === undefined ? {} : { maxBytes: this.flowControl.maxFrameBytes }
        envelope = decodeDshEnvelope(data, options)
      }
    } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); return }
    if (envelope.generation !== this.generation || envelope.hostScope.hostId !== this.hostScope.hostId || envelope.hostScope.kind !== this.hostScope.kind) return
    this.flowControl?.onReceive?.(typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength, envelope)
    const state = this.streams.get(envelope.streamId)
    const pending = this.pending.get(envelope.streamId)
    if (state) return this.receiveStream(envelope, state)
    if (!pending) return
    if (envelope.type === 'stream.accepted') { pending.accepted = true; return }
    if (envelope.type.endsWith('.response')) { this.pending.delete(envelope.streamId); pending.resolve(decodePayload(envelope)) }
    else if (envelope.type === 'stream.close') { this.pending.delete(envelope.streamId); pending.resolve(decodePayload(envelope)) }
    else if (envelope.type === 'stream.error' || envelope.type.endsWith('.error')) { this.pending.delete(envelope.streamId); pending.reject(new Error(typeof envelope.meta.detail === 'string' ? envelope.meta.detail : '远端请求失败')) }
  }
  private receiveStream(envelope: DshEnvelope, state: PendingStream<unknown>): void {
    if (envelope.type === 'stream.accepted') return
    if (envelope.type === 'stream.error' || envelope.type.endsWith('.error')) { state.error = new Error(typeof envelope.meta.detail === 'string' ? envelope.meta.detail : '远端流失败'); this.finishStream(envelope.streamId, state); return }
    if (envelope.type === 'stream.close' || envelope.flags?.endOfStream) { this.finishStream(envelope.streamId, state); return }
    if (envelope.type === 'stream.window') return
    const value = decodePayload(envelope); state.queuedBytes += envelope.body?.byteLength ?? 0
    if (state.queuedBytes > (this.flowControl?.maxQueueBytes ?? 4 * 1024 * 1024)) { state.error = new Error('Transport 队列超过上限'); this.finishStream(envelope.streamId, state); return }
    if (state.waiters.length > 0) state.waiters.shift()?.resolve({ done: false, value }); else state.queue.push(value)
  }
  private finishStream(id: string, state: PendingStream<unknown>): void {
    state.closed = true; state.removeAbort?.(); state.removeAbort = undefined; this.streams.delete(id)
    for (const waiter of state.waiters.splice(0)) state.error ? waiter.reject(state.error) : waiter.resolve({ done: true, value: undefined })
  }
  private send(input: { streamId: string; channel: DshChannel; type: string; meta?: Record<string, unknown>; body?: Uint8Array; flags?: DshEnvelope['flags'] }): void {
    const envelope: DshEnvelope = { version: 1, messageId: `${this.idPrefix}_m_${this.nextSequence()}`, streamId: input.streamId, channel: input.channel, type: input.type, sequence: this.nextSequence(), generation: this.generation, hostScope: this.hostScope, meta: input.meta ?? {}, ...(input.body === undefined ? {} : { body: input.body }), ...(input.flags === undefined ? {} : { flags: input.flags }) }
    const encoded = encodeDshEnvelope(envelope, this.flowControl?.maxFrameBytes === undefined ? {} : { maxBytes: this.flowControl.maxFrameBytes })
    if (this.flowControl?.canSend && !this.flowControl.canSend(encoded.byteLength, envelope)) throw new Error('Transport 背压窗口不足')
    const pending = this.carrier.send(encoded)
    if (pending && typeof (pending as Promise<void>).catch === 'function') {
      void (pending as Promise<void>).catch((error) => this.close(error instanceof Error ? error : new Error(String(error))))
    }
    this.flowControl?.onSend?.(encoded.byteLength, envelope)
  }
  private nextSequence(): number { if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('DSH Envelope sequence 已耗尽'); return ++this.sequence }
  private nextRequestId(): number { if (this.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('Transport request id 已耗尽'); return ++this.nextId }
  private closedStream(error?: Error): AsyncIterable<never> { return { [Symbol.asyncIterator]: () => ({ next: async () => error ? Promise.reject(error) : ({ done: true, value: undefined }) }) } }
  private ensureOpen(): void { if (this.disposed || this.carrier.state !== 'open') throw new Error('Transport 尚未 ready'); if (this.requireSessionReady && !this.session?.ready) throw new Error('SESSION_NOT_READY') }
}
function mapChannel(channel: 'rpc' | 'fetch' | 'control' | 'web'): DshChannel { return channel === 'fetch' || channel === 'web' ? 'web' : channel === 'control' ? 'session' : 'rpc' }
function encodeJson(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value === undefined ? null : value)) }
function decodePayload(envelope: DshEnvelope): unknown {
  if (envelope.meta.encoding === 'json' && envelope.body) {
    try { return JSON.parse(new TextDecoder().decode(envelope.body)) as unknown } catch { return envelope.body }
  }
  return envelope.body ?? envelope.meta.payload
}

function legacyEnvelope(value: { id: string; channel: string; kind: string; sequence: number; payload?: unknown }): DshEnvelope {
  if (typeof value.id !== 'string' || typeof value.kind !== 'string' || !Number.isSafeInteger(value.sequence)) throw new Error('Tunnel Frame 无效')
  const channel: DshChannel = value.channel === 'fetch' ? 'web' : value.channel === 'control' ? 'session' : 'rpc'
  return {
    version: 1,
    messageId: value.id,
    streamId: value.id,
    channel,
    type: `${value.channel}.${value.kind}`,
    sequence: value.sequence,
    generation: '1',
    hostScope: { hostId: 'unknown', kind: 'remote' },
    meta: { encoding: 'json', ...(value.payload === undefined ? {} : { payload: value.payload }) },
    ...(value.payload === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(value.payload)) }),
  }
}
