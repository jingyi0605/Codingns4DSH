import type { HostScope } from '../shared/contracts/peer-host.js'

const EVENT_PREFIX = 'codingns-peer-event:'
const INTERACTION_EVENTS = new Set(['approval/request', 'user-questions/request'])

interface EventRoute {
  readonly scope: HostScope
  readonly clientId: string
  readonly eventId: string
  readonly localClientId: string
  readonly signal: AbortSignal
  readonly agentId: string
  readonly pending: Map<string, string>
}

interface EventWorker {
  readonly controller: AbortController
  readonly pending: Map<string, string>
}

interface EventGeneration {
  readonly controller: AbortController
  readonly queue: EventQueue
  readonly workers: Map<string, EventWorker>
  clientId?: string
}

export interface PeerHostRemoteEventsOptions {
  open(scope: HostScope, signal: AbortSignal): AsyncIterable<unknown>
  reply(scope: HostScope, payload: unknown, signal: AbortSignal): Promise<unknown>
  /** 只接入聚合中可见的会话，不能把其他工作区的弹窗带进当前客户端。 */
  accepts(agentId: string, scope: HostScope): boolean
  prepare?(): Promise<void>
  readonly retryMs?: number
}

/**
 * 合并原生事件流，保留本机 ready 与普通事件原样。
 * 每次远端重连重新登记事件身份；结果只按登记表回传，绝不根据当前选择猜 Host。
 */
export class PeerHostRemoteEvents {
  private readonly peers = new Map<string, HostScope>()
  private readonly routes = new Map<string, EventRoute>()
  private readonly generations = new Set<EventGeneration>()
  private sequence = 0
  // 局域网 HTTP 页面不一定开放 randomUUID；这里只需连接内的唯一标识，不用它作认证凭据。
  private readonly instanceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

  constructor(private readonly options: PeerHostRemoteEventsOptions) {}

  setPeers(scopes: readonly HostScope[]): void {
    this.peers.clear()
    for (const scope of scopes) if (scope.targetHostId !== null) this.peers.set(scope.targetHostId, scope)
    for (const generation of this.generations) this.sync(generation)
  }

  ownsResult(payload: unknown): boolean {
    const eventId = record(record(payload)?.args)?.eventId
    return typeof eventId === 'string' && eventId.startsWith(EVENT_PREFIX)
  }

  async reply(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = record(record(payload)?.args)
    const id = typeof args?.eventId === 'string' ? args.eventId : ''
    const route = this.routes.get(id)
    if (route === undefined || args?.clientId !== route.localClientId || route.signal.aborted || !this.options.accepts(route.agentId, route.scope)) {
      throw Object.assign(new Error('远端交互已结束或连接已变更，请等待重新同步'), { code: 'PEER_HOST_EVENT_EXPIRED' })
    }
    const result = await this.options.reply(route.scope, {
      args: { ...args, clientId: route.clientId, eventId: route.eventId },
    }, signal === undefined ? route.signal : AbortSignal.any([route.signal, signal]))
    this.routes.delete(id)
    route.pending.delete(route.eventId)
    return result
  }

  open(local: (signal: AbortSignal) => AsyncIterable<unknown>, signal?: AbortSignal): AsyncIterable<unknown> {
    const self = this
    return (async function* () {
      const generation: EventGeneration = { controller: new AbortController(), queue: new EventQueue(), workers: new Map() }
      const abort = (): void => { generation.controller.abort(); generation.queue.end() }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      self.generations.add(generation)
      const pump = (async () => {
        try {
          for await (const frame of local(generation.controller.signal)) {
            if (generation.controller.signal.aborted) break
            generation.queue.push(frame)
            const value = record(frame)
            if (value?.type === 'ready' && typeof value.clientId === 'string') {
              generation.clientId = value.clientId
              self.sync(generation)
            }
          }
          generation.queue.end()
        } catch (error) {
          generation.queue.end(error)
        }
      })()
      try {
        yield* generation.queue
      } finally {
        signal?.removeEventListener('abort', abort)
        self.generations.delete(generation)
        abort()
        for (const worker of generation.workers.values()) self.stop(generation, worker)
        await pump
      }
    })()
  }

  dispose(): void {
    this.peers.clear()
    for (const generation of this.generations) {
      generation.controller.abort()
      generation.queue.end()
      for (const worker of generation.workers.values()) this.stop(generation, worker)
    }
    this.routes.clear()
  }

  private sync(generation: EventGeneration): void {
    if (generation.clientId === undefined || generation.controller.signal.aborted) return
    for (const [hostId, worker] of generation.workers) {
      if (this.peers.has(hostId)) continue
      this.stop(generation, worker)
      generation.workers.delete(hostId)
    }
    for (const [hostId, scope] of this.peers) {
      if (generation.workers.has(hostId)) continue
      const worker: EventWorker = { controller: new AbortController(), pending: new Map() }
      generation.workers.set(hostId, worker)
      void this.pumpPeer(generation, worker, scope)
    }
  }

  private async pumpPeer(generation: EventGeneration, worker: EventWorker, scope: HostScope): Promise<void> {
    const signal = AbortSignal.any([generation.controller.signal, worker.controller.signal])
    let attempt = 0
    while (!signal.aborted) {
      const connection = new AbortController()
      const connectionSignal = AbortSignal.any([signal, connection.signal])
      try {
        let clientId: string | undefined
        for await (const raw of this.options.open(scope, connectionSignal)) {
          if (signal.aborted) break
          const frame = record(raw)
          if (clientId === undefined) {
            if (frame?.type !== 'ready' || typeof frame.clientId !== 'string') throw new Error('远端事件流缺少 ready 帧')
            clientId = frame.clientId
            attempt = 0
            // 只有事件流已经完成 ready 握手后才做一次基线校准。
            // 连接失败、握手失败或旧版 Host 不支持事件流时，不能先触发完整 session/list。
            try { await this.options.prepare?.() } catch {
              // 基线刷新失败不能撕掉已经 ready 的事件流；下一次有效事件或重连再校准。
            }
            continue
          }
          await this.deliver(generation, worker, scope, clientId, frame, connectionSignal)
        }
      } catch {
        // 单个 Host 断线或旧版不支持交互协议，只重连该 Host，不终止本机事件流。
      } finally {
        connection.abort()
        this.cancelPending(generation, worker)
      }
      if (!signal.aborted) await waitForRetry(Math.min(30_000, (this.options.retryMs ?? 1000) * 2 ** Math.min(attempt++, 5)), signal)
    }
  }

  private async deliver(generation: EventGeneration, worker: EventWorker, scope: HostScope, clientId: string, frame: Record<string, unknown> | null, signal: AbortSignal): Promise<void> {
    // 原生子智能体列表从统一状态事件读取运行态，不能仅依赖已打开会话的 follow 流。
    if (frame?.type === 'emit' && frame.event === 'api-session/status') {
      const args = frame.args
      if (Array.isArray(args) && typeof args[0] === 'string' && typeof args[1] === 'boolean' && this.options.accepts(args[0], scope)) {
        generation.queue.push(frame)
      }
      return
    }
    if (frame?.type === 'cancel' && typeof frame.eventId === 'string') {
      const id = worker.pending.get(frame.eventId)
      if (id !== undefined) this.cancel(generation, worker, frame.eventId, id)
      return
    }
    // Host 全局设置、插件和账号通知不属于远端会话，不混入本机事件总线。
    if (frame?.type !== 'waterfall' || typeof frame.eventId !== 'string' || typeof frame.agentId !== 'string') return
    if (!INTERACTION_EVENTS.has(String(frame.event)) || !this.options.accepts(frame.agentId, scope)) {
      await this.options.reply(scope, { args: { clientId, eventId: frame.eventId, outcome: { kind: 'next' } } }, signal)
      return
    }
    if (worker.pending.has(frame.eventId)) return
    const id = `${EVENT_PREFIX}${this.instanceId}:${++this.sequence}`
    worker.pending.set(frame.eventId, id)
    this.routes.set(id, { scope, clientId, eventId: frame.eventId, localClientId: generation.clientId!, signal, agentId: frame.agentId, pending: worker.pending })
    generation.queue.push({ ...frame, eventId: id })
  }

  private cancel(generation: EventGeneration, worker: EventWorker, eventId: string, id: string): void {
    worker.pending.delete(eventId)
    this.routes.delete(id)
    generation.queue.push({ type: 'cancel', eventId: id })
  }

  private cancelPending(generation: EventGeneration, worker: EventWorker): void {
    for (const [eventId, id] of worker.pending) this.cancel(generation, worker, eventId, id)
  }

  private stop(generation: EventGeneration, worker: EventWorker): void {
    worker.controller.abort()
    this.cancelPending(generation, worker)
  }
}

/** 单消费者队列；先排出已收到的事件和取消通知，再报告源结束。 */
class EventQueue implements AsyncIterable<unknown> {
  private readonly values: unknown[] = []
  private wake: (() => void) | undefined
  private ended = false
  private error: unknown

  push(value: unknown): void {
    if (this.ended) return
    this.values.push(value)
    this.wake?.()
  }

  end(error?: unknown): void {
    this.ended = true
    this.error = error
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (!this.ended || this.values.length > 0) {
      if (this.values.length > 0) yield this.values.shift()
      else await new Promise<void>(resolve => { this.wake = resolve })
    }
    if (this.error !== undefined) throw this.error
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
