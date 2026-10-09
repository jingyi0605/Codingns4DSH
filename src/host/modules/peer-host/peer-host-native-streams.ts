import { randomUUID } from 'node:crypto'
import type { HostScope } from '../../../shared/contracts/peer-host.js'
import { CodingNsRpcError } from '../../rpc-table.js'

interface NativeStream {
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

  async open(scope: HostScope, create: (signal: AbortSignal) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>): Promise<string> {
    if (this.disposed) throw new Error('PeerHost 原生流注册表已关闭')
    const controller = new AbortController()
    try {
      const source = await create(controller.signal)
      const iterator = source[Symbol.asyncIterator]()
      if (this.disposed) {
        controller.abort()
        await iterator.return?.()
        throw new Error('PeerHost 原生流注册表已关闭')
      }
      const id = randomUUID()
      this.streams.set(id, { scope, controller, iterator, timer: this.expiry(id), pulling: false })
      return id
    } catch (error) {
      controller.abort(error)
      throw error
    }
  }

  async next(id: string, scope: HostScope, signal?: AbortSignal): Promise<IteratorResult<unknown>> {
    const stream = this.require(id, scope)
    if (stream.pulling) throw new CodingNsRpcError('CODINGNS_RPC_INVALID', 'DSH 原生 Remote 流已有挂起的读取')
    clearTimeout(stream.timer)
    stream.timer = this.expiry(id)
    stream.pulling = true
    const abort = (): void => { void this.close(id, scope).catch(() => undefined) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      signal?.throwIfAborted()
      const next = await stream.iterator.next()
      if (next.done) await this.close(id, scope)
      else if (this.streams.has(id)) {
        clearTimeout(stream.timer)
        stream.timer = this.expiry(id)
      }
      return next
    } catch (error) {
      await this.close(id, scope)
      throw error
    } finally {
      // 请求完成后立刻解绑；HTTP 响应结束导致的取消不能杀掉后续轮询。
      signal?.removeEventListener('abort', abort)
      stream.pulling = false
    }
  }

  async close(id: string, scope: HostScope): Promise<void> {
    if (!this.streams.has(id)) return
    const stream = this.require(id, scope)
    this.streams.delete(id)
    clearTimeout(stream.timer)
    stream.controller.abort(new Error('PeerHost 原生流已关闭'))
    await stream.iterator.return?.()
  }

  dispose(): void {
    this.disposed = true
    for (const [id, stream] of this.streams) void this.close(id, stream.scope).catch(() => undefined)
  }

  private require(id: string, scope: HostScope): NativeStream {
    const stream = this.streams.get(id)
    if (stream === undefined) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', 'DSH 原生 Remote 流已失效')
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
      else void this.close(id, stream.scope).catch(() => undefined)
    }, this.ttlMs)
    timer.unref?.()
    return timer
  }
}
