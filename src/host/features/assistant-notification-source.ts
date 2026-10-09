import { randomUUID } from 'node:crypto'
import {
  readAssistantNotificationFact, readAssistantNotificationFeedRequest,
  type AssistantNotificationFact, type AssistantNotificationFeed, type AssistantNotificationFeedCapabilities,
} from '../../shared/assistant-notification-feed.js'

interface JournalEntry { readonly revision: number; readonly fact: AssistantNotificationFact }
export interface AssistantNotificationSourceOptions {
  readonly now?: () => number
  readonly epoch?: string
  readonly capacity?: number
  readonly capabilities?: () => AssistantNotificationFeedCapabilities
  /** 只允许查询当前原生请求状态；不能用历史文本代替。 */
  readonly recover?: (workspaceIds: readonly string[]) => readonly AssistantNotificationFact[]
}

/** 每个 Host 一个有界事实日志；无远端消费者时不收集终态，不扫描历史。 */
export class AssistantNotificationSource {
  private readonly epoch: string
  private readonly now: () => number
  private readonly capacity: number
  private readonly leases = new Map<string, number>()
  private readonly events: JournalEntry[] = []
  // 没有 recover 的通用来源仍保留协议级兜底；全局助理来源始终提供 recover，读取时不使用这张缓存。
  private readonly fallbackPending = new Map<string, AssistantNotificationFact>()
  private revision = 0
  private disposed = false

  constructor(private readonly options: AssistantNotificationSourceOptions = {}) {
    this.epoch = options.epoch ?? randomUUID()
    this.now = options.now ?? Date.now
    this.capacity = Math.max(1, Math.min(512, options.capacity ?? 512))
  }

  append(value: AssistantNotificationFact): void {
    if (this.disposed) return
    this.expire()
    const fact = readAssistantNotificationFact(value)
    if (fact === null) return
    if (this.options.recover === undefined) {
      const key = JSON.stringify([fact.workspaceId, fact.actualRequestSessionId ?? fact.sessionId, fact.requestKind ?? fact.kind, fact.requestId])
      if (fact.kind === 'question' || fact.kind === 'approval') this.fallbackPending.set(key, fact)
      if (fact.kind === 'resolved') this.fallbackPending.delete(key)
    }
    // 全局助理的当前待办由 recover 在每次读取时提供；事件日志只负责增量终态和导航事实。
    if (!this.leases.has(fact.workspaceId)) return
    this.events.push({ revision: ++this.revision, fact })
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
  }

  read(value: unknown): AssistantNotificationFeed {
    if (this.disposed) throw new Error('通知来源已关闭')
    const request = readAssistantNotificationFeedRequest(value)
    this.expire()
    for (const workspaceId of request.workspaceIds) this.leases.set(workspaceId, this.now() + 10_000)
    const selected = new Set(request.workspaceIds)
    const recovery = this.options.recover?.(request.workspaceIds)
    const currentPending = recovery === undefined
      ? [...this.fallbackPending.values()].filter((fact) => selected.has(fact.workspaceId))
      : recovery.map(readAssistantNotificationFact).filter((fact): fact is AssistantNotificationFact => fact !== null && selected.has(fact.workspaceId) && (fact.kind === 'question' || fact.kind === 'approval'))
    const oldest = this.events[0]?.revision ?? this.revision + 1
    const gap = request.epoch === this.epoch && request.revision !== undefined && request.revision < oldest - 1
    const baseline = request.epoch !== this.epoch || request.revision === undefined || request.revision > this.revision || gap
    return {
      protocol: 1, epoch: this.epoch, revision: this.revision, baseline, gap,
      events: baseline ? [] : this.events.filter(entry => entry.revision > request.revision! && selected.has(entry.fact.workspaceId)).map(entry => entry.fact),
      pending: currentPending,
      capabilities: this.options.capabilities?.() ?? { completed: true, error: true, requests: true, resolve: true, recovery: this.options.recover !== undefined },
    }
  }

  dispose(): void {
    this.disposed = true
    this.leases.clear(); this.events.length = 0; this.fallbackPending.clear()
  }

  private expire(): void {
    for (const [workspaceId, until] of this.leases) {
      if (until > this.now()) continue
      this.leases.delete(workspaceId)
    }
  }
}
