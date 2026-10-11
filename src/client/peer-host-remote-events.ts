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
  /** 当前 DSH 连接代次已经向原生状态总线投递过的运行态。 */
  readonly sessionStatuses: Map<string, boolean>
  clientId?: string
  prepared: boolean
}

interface PendingSessionStatus {
  readonly scope: HostScope
  readonly sessionId: string
  readonly frames: unknown[]
}

export interface PeerHostRemoteEventsOptions {
  open(scope: HostScope, signal: AbortSignal): AsyncIterable<unknown>
  reply(scope: HostScope, payload: unknown, signal: AbortSignal): Promise<unknown>
  /** 只接入聚合中可见的会话，不能把其他工作区的弹窗带进当前客户端。 */
  accepts(agentId: string, scope: HostScope): boolean
  /** 将远端会话运行态增量同步到 PeerHost 自己的导航投影。 */
  onSessionStatus?: (sessionId: string, running: boolean, scope: HostScope) => void
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
  /** 事件早于聚合摘要到达时暂存，待会话进入可见作用域后重放。 */
  private readonly pendingSessionStatuses = new Map<string, PendingSessionStatus>()
  private sequence = 0
  // 局域网 HTTP 页面不一定开放 randomUUID；这里只需连接内的唯一标识，不用它作认证凭据。
  private readonly instanceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

  constructor(private readonly options: PeerHostRemoteEventsOptions) {}

  setPeers(scopes: readonly HostScope[]): void {
    this.peers.clear()
    for (const scope of scopes) if (scope.targetHostId !== null) this.peers.set(scope.targetHostId, scope)
    for (const [key, pending] of this.pendingSessionStatuses) {
      if (pending.scope.targetHostId === null || !this.peers.has(pending.scope.targetHostId)) this.pendingSessionStatuses.delete(key)
    }
    for (const generation of this.generations) this.sync(generation)
  }

  /** 聚合摘要建立会话作用域后调用，补发此前因作用域未知而暂存的状态事件。 */
  replayPendingSessionStatuses(): void {
    for (const generation of this.generations) {
      if (generation.clientId === undefined || generation.controller.signal.aborted) continue
      this.replayPendingSessionStatusesForGeneration(generation)
    }
  }

  /**
   * 摘要从 running 变为 idle、但事件流没有覆盖到这次变化时，补投递完成边沿。
   * 调用方必须只对确认发生过 true -> false 的会话调用，不能把普通 idle 摘要当未读。
   */
  replayCompletedSessionStatus(sessionId: string, scope: HostScope): void {
    const frame = { type: 'emit', event: 'api-session/status', args: [sessionId, false] }
    let delivered = false
    for (const generation of this.generations) {
      if (generation.clientId === undefined || generation.controller.signal.aborted || !this.options.accepts(sessionId, scope)) continue
      // 强制按一次新的边沿处理，即使本代之前记录过 false；摘要变化已经证明
      // 这不是重复 baseline，而是从运行中完成。
      generation.sessionStatuses.delete(sessionId)
      this.deliverSessionStatus(generation, scope, sessionId, false, frame)
      delivered = true
    }
    // 摘要轮询可能早于原生事件流握手完成；不能因为此时没有消费者就丢掉
    // 完成边沿，交给 ready 后的代次按普通 pending 状态重放。
    if (!delivered) this.rememberPendingSessionStatus(scope, sessionId, frame)
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
      const generation: EventGeneration = {
        controller: new AbortController(),
        queue: new EventQueue(),
        workers: new Map(),
        sessionStatuses: new Map(),
        prepared: false,
      }
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
    this.pendingSessionStatuses.clear()
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
            this.replayPendingSessionStatusesForGeneration(generation)
            // 只有事件流完成首个 ready 握手后才做一次基线校准。
            // 同一条合并事件流内部的重连不能反复触发完整 session/list；增量状态由
            // WebSocket 事件承担。调用方若需要跨 open() 复用基线，应在 prepare() 内自行合并。
            if (!generation.prepared) {
              generation.prepared = true
              try { await this.options.prepare?.() } catch {
                // 基线刷新失败不能撕掉已经 ready 的事件流；后续聚合刷新负责补偿。
              }
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
      if (!Array.isArray(args) || typeof args[0] !== 'string' || typeof args[1] !== 'boolean') return
      if (!this.options.accepts(args[0], scope)) {
        this.rememberPendingSessionStatus(scope, args[0], frame)
        return
      }
      this.deliverSessionStatus(generation, scope, args[0], args[1], frame)
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

  private deliverSessionStatus(generation: EventGeneration, scope: HostScope, sessionId: string, running: boolean, frame: unknown): void {
    // DSH 的 completionUnread 是由 true -> false 的事件边沿计算的，不是
    // session/list 的持久字段。PeerHost 连接可能在目标会话已开始运行后才建立，
    // 这时首个可见事件只有 false；补一帧同 ID 的 true，才能让 DSH 正确生成未读，
    // 随后的真实 false 仍会把最终运行态设为已完成。
    const previous = generation.sessionStatuses.get(sessionId)
    if (!running && previous !== true) {
      generation.queue.push({ ...record(frame), args: [sessionId, true] })
    }
    this.options.onSessionStatus?.(sessionId, running, scope)
    generation.queue.push(frame)
    generation.sessionStatuses.set(sessionId, running)
  }

  private rememberPendingSessionStatus(scope: HostScope, sessionId: string, frame: unknown): void {
    if (scope.targetHostId === null) return
    const key = `${scope.targetHostId}:${sessionId}`
    const pending = this.pendingSessionStatuses.get(key) ?? { scope, sessionId, frames: [] }
    // 保留状态变化序列，而不是只保留最后一个 false；DSH 需要 true → false
    // 才能把已完成的非当前会话标记为未读。
    const previousArgs = record(pending.frames.at(-1))?.args
    const args = record(frame)?.args
    if (Array.isArray(previousArgs) && Array.isArray(args) && previousArgs[1] === args[1]) return
    pending.frames.push(frame)
    if (pending.frames.length > 8) pending.frames.shift()
    this.pendingSessionStatuses.set(key, pending)
  }

  private replayPendingSessionStatusesForGeneration(generation: EventGeneration): void {
    for (const pending of [...this.pendingSessionStatuses.values()]) {
      if (!this.options.accepts(pending.sessionId, pending.scope)) continue
      this.pendingSessionStatuses.delete(`${pending.scope.targetHostId}:${pending.sessionId}`)
      for (const frame of pending.frames) {
        const args = record(frame)?.args
        if (!Array.isArray(args) || typeof args[1] !== 'boolean') continue
        this.deliverSessionStatus(generation, pending.scope, pending.sessionId, args[1], frame)
      }
    }
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
