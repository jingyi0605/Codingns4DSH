import { randomUUID } from 'node:crypto'
import type { HostScope } from '../../../shared/contracts/peer-host.js'
import { CodingNsRpcError } from '../../rpc-table.js'
import { throwIfPeerHostRequestAborted } from './peer-host-request-errors.js'

interface NativeStream {
  readonly peer: unknown
  readonly releasePeer: () => void
  readonly scope: HostScope
  readonly controller: AbortController
  readonly iterator: AsyncIterator<unknown>
  timer: ReturnType<typeof setTimeout>
  pulling: boolean
}

/** 流句柄拥有独立取消信号；关闭时先打断挂起的 next，再归还迭代器。 */
export class PeerHostNativeStreams {
  private readonly streams = new Map<string, NativeStream>()
  private disposed = false

  constructor(private readonly ttlMs = 600_000) {}

  async open(scope: HostScope, create: (signal: AbortSignal) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>, peer?: unknown): Promise<string> {
    if (this.disposed) throw new Error('PeerHost 原生流注册表已关闭')
    const controller = new AbortController()
    const id = randomUUID()
    const peerSignal = (peer as { signal?: AbortSignal } | undefined)?.signal
    const abortPeer = (): void => {
      controller.abort(peerSignal?.reason)
      void this.close(id, scope, peerSignal?.reason, peer).catch(() => undefined)
    }
    const releasePeer = (): void => peerSignal?.removeEventListener('abort', abortPeer)
    peerSignal?.addEventListener('abort', abortPeer, { once: true })
    try {
      peerSignal?.throwIfAborted()
      const source = await create(controller.signal)
      const iterator = source[Symbol.asyncIterator]()
      if (this.disposed || controller.signal.aborted) {
        controller.abort()
        await iterator.return?.()
        throw new Error('PeerHost 原生流注册表已关闭')
      }
      this.streams.set(id, { scope, peer, releasePeer, controller, iterator, timer: this.expiry(id), pulling: false })
      return id
    } catch (error) {
      releasePeer()
      controller.abort(error)
      throw error
    }
  }

  async next(id: string, scope: HostScope, signal?: AbortSignal, peer?: unknown): Promise<IteratorResult<unknown>> {
    const stream = this.require(id, scope, peer)
    if (stream.pulling) throw new CodingNsRpcError('CODINGNS_RPC_INVALID', 'DSH 原生 Remote 流已有挂起的读取')
    clearTimeout(stream.timer)
    stream.timer = this.expiry(id)
    stream.pulling = true
    const abort = (): void => { void this.close(id, scope, signal?.reason, peer).catch(() => undefined) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      throwIfPeerHostRequestAborted(signal)
      const next = await stream.iterator.next()
      if (next.done) await this.close(id, scope, undefined, peer)
      else if (this.streams.has(id)) {
        clearTimeout(stream.timer)
        stream.timer = this.expiry(id)
      }
      return next
    } catch (error) {
      await this.close(id, scope, undefined, peer)
      throw error
    } finally {
      // 请求完成后立刻解绑；HTTP 响应结束导致的取消不能杀掉后续轮询。
      signal?.removeEventListener('abort', abort)
      stream.pulling = false
    }
  }

  async close(id: string, scope: HostScope, reason?: unknown, peer?: unknown): Promise<void> {
    if (!this.streams.has(id)) return
    const stream = this.require(id, scope, peer)
    this.streams.delete(id)
    stream.releasePeer()
    clearTimeout(stream.timer)
    stream.controller.abort(reason ?? new DOMException('PeerHost 原生流已关闭', 'AbortError'))
    await stream.iterator.return?.()
  }

  dispose(): void {
    this.disposed = true
    for (const [id, stream] of this.streams) void this.close(id, stream.scope, undefined, stream.peer).catch(() => undefined)
  }

  private require(id: string, scope: HostScope, peer?: unknown): NativeStream {
    const stream = this.streams.get(id)
    if (stream === undefined) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', 'DSH 原生 Remote 流已失效')
    if (stream.peer !== peer) throw new CodingNsRpcError('CODINGNS_RPC_SCOPE_MISMATCH', 'DSH stream belongs to another peer')
    if (Object.keys(stream.scope).some(key => stream.scope[key as keyof HostScope] !== scope[key as keyof HostScope])) {
      throw new CodingNsRpcError('CODINGNS_RPC_SCOPE_MISMATCH', 'DSH 原生 Remote 流作用域不匹配')
    }
    return stream
  }

  private expiry(id: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const stream = this.streams.get(id)
      if (stream === undefined) return
      // 正在长轮询的健康会话可以无限等待用户；失联由该次请求的取消信号负责清理。
      if (stream.pulling) stream.timer = this.expiry(id)
      else void this.close(id, stream.scope, undefined, stream.peer).catch(() => undefined)
    }, this.ttlMs)
    timer.unref?.()
    return timer
  }
}
