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
  /** 只允许查询当前原生请求注册；不能用历史文本代替。 */
  readonly recover?: (workspaceIds: readonly string[]) => readonly AssistantNotificationFact[]
}

/** 每个 Host 一个有界事实日志；无远端消费者时不收集终态，不扫描历史。 */
export class AssistantNotificationSource {
  private readonly epoch: string
  private readonly now: () => number
  private readonly capacity: number
  private readonly leases = new Map<string, number>()
  private readonly events: JournalEntry[] = []
  private readonly pending = new Map<string, AssistantNotificationFact>()
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
    const key = JSON.stringify([fact.workspaceId, fact.actualRequestSessionId ?? fact.sessionId, fact.requestKind ?? fact.kind, fact.requestId])
    if (fact.kind === 'question' || fact.kind === 'approval') this.pending.set(key, fact)
    if (fact.kind === 'resolved') this.pending.delete(key)
    // 已观察到的原生在途请求就是当前注册事实；即使远端尚未订阅，也保留到精确结束。
    // 只有终态和增量历史依赖读取租约，不能因消费者断线丢掉仍未处理的问题。
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
    if (recovery !== undefined) {
      for (const [key, fact] of this.pending) if (selected.has(fact.workspaceId)) this.pending.delete(key)
      for (const value of recovery) {
        const fact = readAssistantNotificationFact(value)
        if (fact === null || !selected.has(fact.workspaceId) || (fact.kind !== 'question' && fact.kind !== 'approval')) continue
        this.pending.set(JSON.stringify([fact.workspaceId, fact.actualRequestSessionId ?? fact.sessionId, fact.requestKind ?? fact.kind, fact.requestId]), fact)
      }
    }
    const oldest = this.events[0]?.revision ?? this.revision + 1
    const gap = request.epoch === this.epoch && request.revision !== undefined && request.revision < oldest - 1
    const baseline = request.epoch !== this.epoch || request.revision === undefined || request.revision > this.revision || gap
    return {
      protocol: 1, epoch: this.epoch, revision: this.revision, baseline, gap,
      events: baseline ? [] : this.events.filter(entry => entry.revision > request.revision! && selected.has(entry.fact.workspaceId)).map(entry => entry.fact),
      pending: [...this.pending.values()].filter(fact => selected.has(fact.workspaceId)),
      capabilities: this.options.capabilities?.() ?? { completed: true, error: true, requests: true, resolve: true, recovery: this.options.recover !== undefined },
    }
  }

  dispose(): void {
    this.disposed = true
    this.leases.clear(); this.events.length = 0; this.pending.clear()
  }

  private expire(): void {
    for (const [workspaceId, until] of this.leases) {
      if (until > this.now()) continue
      this.leases.delete(workspaceId)
    }
  }
}
