import type { CodingNsCarrier } from './carrier.js'
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelChannel,
  type TunnelFrame,
  DEFAULT_MAX_TUNNEL_FRAME_BYTES,
  tunnelFrameByteLength,
} from './frame.js'

interface PendingUnary {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface PendingStream<T> {
  queue: T[]
  waiters: Array<{ resolve(result: IteratorResult<T>): void; reject(error: Error): void }>
  closed: boolean
  error?: Error
  removeAbort: (() => void) | undefined
}

/**
 * 流控由上层注入。阶段 4 只定义边界，不假设 DataChannel 的具体背压实现。
 * `canSend` 返回 false 时本次操作失败，调用方可以在外层排队后重试。
 */
export interface TunnelFlowControl {
  maxFrameBytes?: number
  canSend?(bytes: number, frame: TunnelFrame): boolean
  onSend?(bytes: number, frame: TunnelFrame): void
  onReceive?(bytes: number, frame: TunnelFrame): void
}

export interface DshTunnelMultiplexerOptions {
  idPrefix?: string
  flowControl?: TunnelFlowControl
}

export class DshTunnelMultiplexer {
  private readonly pending = new Map<string, PendingUnary>()
  private readonly streams = new Map<string, PendingStream<unknown>>()
  private sequence = 0
  private nextId = 0
  private disposed = false
  private readonly unsubscribe: () => void
  private idPrefix: string
  private readonly flowControl: TunnelFlowControl | undefined

  constructor(private readonly carrier: CodingNsCarrier, options: DshTunnelMultiplexerOptions = {}) {
    this.idPrefix = options.idPrefix ?? 'g0'
    this.flowControl = options.flowControl
    this.unsubscribe = carrier.subscribe((data) => this.receive(data))
  }

  request<T>(channel: Exclude<TunnelChannel, 'event'>, payload: unknown, signal?: AbortSignal): Promise<T> {
    this.ensureOpen()
    const id = `${this.idPrefix}_req_${this.nextRequestId()}`
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return
        if (!this.disposed && this.carrier.state === 'open') {
          try { this.send({ channel, id, sequence: this.nextSequence(), kind: 'cancel', payload: { reason: signal?.reason } }) } catch { /* 取消本身不应覆盖原始错误 */ }
        }
        reject(signal?.reason instanceof Error ? signal.reason : new Error('请求已取消'))
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort)
          resolve(value as T)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        },
      })
      try {
        this.send({ channel, id, sequence: this.nextSequence(), kind: 'open', payload })
      } catch (error) {
        this.pending.delete(id)
        signal?.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  openStream<T>(payload: unknown, signal?: AbortSignal): AsyncIterable<T> {
    this.ensureOpen()
    if (signal?.aborted) return this.closedStream() as AsyncIterable<T>
    const id = `${this.idPrefix}_stream_${this.nextRequestId()}`
    const state: PendingStream<unknown> = { queue: [], waiters: [], closed: false, removeAbort: undefined }
    this.streams.set(id, state)
    const cancel = () => {
      if (state.closed) return
      state.closed = true
      if (!this.disposed && this.carrier.state === 'open') {
        try { this.send({ channel: 'stream', id, sequence: this.nextSequence(), kind: 'cancel' }) } catch { /* 关闭路径尽力而为 */ }
      }
      this.finishStream(id, state)
    }
    if (signal) {
      signal.addEventListener('abort', cancel, { once: true })
      state.removeAbort = () => signal.removeEventListener('abort', cancel)
    }
    try {
      this.send({ channel: 'stream', id, sequence: this.nextSequence(), kind: 'open', payload })
    } catch (error) {
      state.error = error instanceof Error ? error : new Error(String(error))
      this.finishStream(id, state)
    }
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<T>> => {
          if (state.error) throw state.error
          if (state.queue.length > 0) return { done: false, value: state.queue.shift() as T }
          if (state.closed) return { done: true, value: undefined }
          return new Promise((resolve, reject) => state.waiters.push({
            resolve: (result) => resolve({ done: result.done === true, value: result.value as T }),
            reject,
          }))
        },
        return: async () => { cancel(); return { done: true, value: undefined } },
      }),
    }
  }

  close(error = new Error('Transport 已关闭')): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const [id, stream] of this.streams) {
      stream.error = error
      this.finishStream(id, stream)
    }
  }

  /** 使当前 generation 的请求全部失效，但保留 mux 供新 generation 使用。 */
  invalidate(error = new Error('Transport generation 已过期')): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const [id, stream] of this.streams) {
      stream.error = error
      this.finishStream(id, stream)
    }
  }

  rotateGeneration(idPrefix: string, error = new Error('Transport generation 已过期')): void {
    this.invalidate(error)
    this.idPrefix = idPrefix
  }

  private receive(data: string): void {
    let frame: TunnelFrame
    try { frame = decodeTunnelFrame(data) } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.flowControl?.onReceive?.(tunnelFrameByteLength(data), frame)
    if (frame.channel === 'stream') return this.receiveStream(frame)
    const pending = this.pending.get(frame.id)
    if (!pending) return
    if (frame.kind === 'data' || frame.kind === 'close') {
      this.pending.delete(frame.id)
      pending.resolve(frame.payload)
    } else if (frame.kind === 'error') {
      this.pending.delete(frame.id)
      const message = typeof frame.payload === 'string' ? frame.payload : '远端请求失败'
      pending.reject(new Error(message))
    }
  }

  private receiveStream(frame: TunnelFrame): void {
    const state = this.streams.get(frame.id)
    if (!state) return
    if (frame.kind === 'data') {
      if (state.waiters.length > 0) state.waiters.shift()?.resolve({ done: false, value: frame.payload })
      else state.queue.push(frame.payload)
    } else if (frame.kind === 'error') {
      state.error = new Error(typeof frame.payload === 'string' ? frame.payload : '远端流失败')
      this.finishStream(frame.id, state)
    } else if (frame.kind === 'close') {
      this.finishStream(frame.id, state)
    }
  }

  private finishStream(id: string, state: PendingStream<unknown>): void {
    state.closed = true
    state.removeAbort?.()
    state.removeAbort = undefined
    this.streams.delete(id)
    for (const waiter of state.waiters.splice(0)) {
      if (state.error) waiter.reject(state.error)
      else waiter.resolve({ done: true, value: undefined })
    }
  }

  private send(input: Omit<TunnelFrame, 'version'>): void {
    const frame = { version: TUNNEL_PROTOCOL_VERSION, ...input } satisfies TunnelFrame
    const encoded = encodeTunnelFrame(frame, { maxBytes: this.flowControl?.maxFrameBytes ?? DEFAULT_MAX_TUNNEL_FRAME_BYTES })
    if (this.flowControl?.canSend && !this.flowControl.canSend(tunnelFrameByteLength(encoded), frame)) throw new Error('Transport 背压窗口不足')
    this.carrier.send(encoded)
    this.flowControl?.onSend?.(tunnelFrameByteLength(encoded), frame)
  }

  private nextSequence(): number {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Tunnel Frame sequence 已耗尽')
    return ++this.sequence
  }

  private nextRequestId(): number {
    if (this.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('Transport request id 已耗尽')
    return ++this.nextId
  }

  private closedStream(error?: Error): AsyncIterable<never> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => error ? Promise.reject(error) : ({ done: true, value: undefined }) }) }
  }

  private ensureOpen(): void {
    if (this.disposed || this.carrier.state !== 'open') throw new Error('Transport 尚未 ready')
  }
}
