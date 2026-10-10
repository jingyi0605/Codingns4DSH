import { randomInt, randomUUID } from 'node:crypto'
import {
  assistantNotificationText, normalizeAssistantNotificationSettings,
  type AssistantNotification, type AssistantNotificationAckRequest, type AssistantNotificationAckResult,
  type AssistantNotificationCapabilities, type AssistantNotificationKind, type AssistantNotificationReadRequest,
  type AssistantNotificationSettings, type AssistantNotificationSnapshot, type AssistantNotificationTarget,
  type AssistantNotificationTargetRequest,
} from '../../shared/assistant-notifications.js'
import { CodingNsRpcError } from '../rpc-table.js'

interface NotificationFactSource {
  readonly generation: number
  readonly target: AssistantNotificationTarget
  readonly hostLabel?: string
  readonly workspaceLabel?: string
  readonly sessionTitle?: string
  readonly seq?: number
}
/** 入口只接受来源已经证实的事实，不解释运行态摘要。 */
export type AssistantNotificationFact = NotificationFactSource & (
  | { readonly type: 'turn-completed' | 'turn-failed'; readonly turnId: string; readonly turn?: number; readonly errorExcerpt?: string }
  | { readonly type: 'request-opened' | 'request-resolved'; readonly requestId: string; readonly requestKind: 'question' | 'approval' }
)
interface NoticeRecord {
  notice: AssistantNotification
  target: AssistantNotificationTarget
  logicalKey: string
}
interface SessionWatermark { seq: number; turn?: number; turnId?: string; failed: boolean; noticeId?: string }
export interface AssistantNotificationCenterOptions {
  readonly now?: () => number
  /** 范围、目标存在和请求有效性在导航时再次复核。 */
  readonly validateTarget?: (target: AssistantNotificationTarget) => boolean | Promise<boolean>
}
const pending = (notice: AssistantNotification): boolean => (notice.kind === 'question' || notice.kind === 'approval') && notice.lifecycle === 'active'
const priority = (notice: AssistantNotification): number => ({ approval: 3, question: 3, error: 2, completed: 1 })[notice.kind]
const sessionKey = (target: Pick<AssistantNotificationTarget, 'hostId' | 'sessionId'>): string => JSON.stringify([target.hostId, target.sessionId])

/** 单一事实所有者；历史容量不影响当前请求和会话去重水位。 */
export class AssistantNotificationCenter {
  private records = new Map<string, NoticeRecord>()
  private watermarks = new Map<string, SessionWatermark>()
  private capabilities = new Map<string, AssistantNotificationCapabilities>()
  private connections = new Map<string, { generation: number; ready: boolean }>()
  private settings: AssistantNotificationSettings = normalizeAssistantNotificationSettings(undefined)
  private managed = new Set<string>()
  private enabled = false
  private scopeKey = ''
  private disposed = false
  // Host 重建不能重用上一生命周期的代次，否则相同修订号会让客户端保留旧分页。
  private currentGeneration = randomInt(1, 2 ** 40)
  private currentRevision = 0
  private readonly revisionListeners = new Set<(revision: number) => void>()
  private readonly now: () => number
  constructor(private readonly options: AssistantNotificationCenterOptions = {}) { this.now = options.now ?? Date.now }
  get generation(): number { return this.currentGeneration }
  get revision(): number { return this.currentRevision }

  /** 供通知长连接监听修订变化；监听器异常不能影响通知事实所有者。 */
  subscribeRevision(listener: (revision: number) => void): () => void {
    this.revisionListeners.add(listener)
    return () => this.revisionListeners.delete(listener)
  }

  /** 先切换代次，旧订阅或异步导航便不能重新写入已移除的范围。 */
  configure(enabled: boolean, managedWorkspaceIds: readonly string[], settings?: unknown): boolean {
    const normalized = normalizeAssistantNotificationSettings(settings)
    const key = JSON.stringify([enabled, normalized.enabled, [...new Set(managedWorkspaceIds)].sort()])
    if (this.scopeKey === key) {
      if (JSON.stringify(this.settings) === JSON.stringify(normalized)) return false
      this.settings = normalized
      // 单类型设置只清理对应记录，保留其他待办的身份、已读、收起及首展计时。
      for (const item of [...this.records.values()]) if (!normalized[item.notice.kind]) this.remove(item)
      this.bumpRevision()
      return true
    }
    this.scopeKey = key; this.currentGeneration++
    this.records.clear(); this.watermarks.clear(); this.connections.clear(); this.capabilities.clear()
    this.settings = normalized; this.managed = new Set(managedWorkspaceIds)
    this.enabled = enabled && normalized.enabled && !this.disposed
    // 先清理旧代次，再广播新 revision；流订阅者拿到的首个新快照必须是空的当前范围。
    this.bumpRevision()
    return true
  }
  baseline(target: AssistantNotificationTarget, seq: number, turn?: number): void {
    if (!Number.isSafeInteger(seq) || seq < -1) return
    const previous = this.watermarks.get(sessionKey(target))
    if (previous !== undefined) { previous.seq = Math.max(previous.seq, seq); return }
    this.watermarks.set(sessionKey(target), { seq, ...(turn === undefined ? {} : { turn }), failed: false })
  }
  setCapabilities(value: AssistantNotificationCapabilities): void {
    const next = { ...value, ...(value.reason === undefined ? {} : { reason: assistantNotificationText(value.reason) }) }
    if (JSON.stringify(this.capabilities.get(value.hostId)) === JSON.stringify(next)) return
    this.capabilities.set(value.hostId, next); this.bumpRevision()
  }
  /** 断线只撤销操作能力；重连不改变逻辑请求身份或展示计时。 */
  connection(hostId: string, connectionGeneration: number, ready: boolean): void {
    const previous = this.connections.get(hostId)
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0 || previous !== undefined && connectionGeneration < previous.generation) return
    if (previous?.generation === connectionGeneration && previous.ready === ready) return
    this.connections.set(hostId, { generation: connectionGeneration, ready })
    for (const item of this.records.values()) {
      if (item.target.hostId !== hostId) continue
      item.target = { ...item.target, connectionGeneration }
      item.notice = { ...item.notice, connectionGeneration, availability: ready ? 'ready' : 'disconnected' }
    }
    this.bumpRevision()
  }

  /** 用当前会话快照校正待处理请求；快照是事实来源，记录只保存展示身份和已读状态。 */
  reconcilePending(facts: readonly AssistantNotificationFact[], hostId: string, authoritative: readonly string[]): void {
    if (!this.enabled) return
    const active = new Set<string>()
    for (const fact of facts) {
      if (fact.type !== 'request-opened' || fact.target.hostId !== hostId) continue
      active.add(this.logicalKey(fact))
      this.consume(fact)
    }
    const available = new Set(authoritative)
    for (const item of [...this.records.values()]) {
      if (!pending(item.notice) || item.target.hostId !== hostId) continue
      const actualSessionId = item.target.actualRequestTarget?.sessionId ?? item.target.sessionId
      if (!available.has(`${item.notice.kind}:${actualSessionId}`) || active.has(item.logicalKey)) continue
      this.remove(item); this.bumpRevision()
    }
  }
  removeHost(hostId: string): void {
    for (const item of [...this.records.values()]) if (item.target.hostId === hostId) this.remove(item)
    for (const key of this.watermarks.keys()) if (JSON.parse(key)[0] === hostId) this.watermarks.delete(key)
    this.connections.delete(hostId); this.capabilities.delete(hostId); this.bumpRevision()
  }
  invalidateSession(hostId: string, sessionId: string): void {
    for (const item of [...this.records.values()]) if (item.target.hostId === hostId && item.target.sessionId === sessionId || item.target.actualRequestTarget?.hostId === hostId && item.target.actualRequestTarget.sessionId === sessionId) this.remove(item)
    this.watermarks.delete(JSON.stringify([hostId, sessionId])); this.bumpRevision()
  }
  updateTitle(hostId: string, sessionId: string, title: string): void {
    const safe = assistantNotificationText(title, 240, '未命名会话')
    for (const item of this.records.values()) {
      if (item.target.hostId !== hostId || item.target.sessionId !== sessionId || item.notice.sessionTitle === safe) continue
      item.notice = { ...item.notice, sessionTitle: safe }; this.bumpRevision()
    }
  }
  consume(fact: AssistantNotificationFact): void {
    if (!this.enabled || fact.generation !== this.currentGeneration || !this.managed.has(fact.target.workspaceId)) return
    const connection = this.connections.get(fact.target.hostId)
    if (fact.target.connectionGeneration !== undefined && connection !== undefined && (!connection.ready || connection.generation !== fact.target.connectionGeneration)) return
    const request = 'requestId' in fact
    const kind: AssistantNotificationKind = request ? fact.requestKind : fact.type === 'turn-failed' ? 'error' : 'completed'
    const key = this.logicalKey(fact)
    if (request && fact.seq !== undefined) {
      const sk = fact.target.actualRequestTarget === undefined ? sessionKey(fact.target) : sessionKey(fact.target.actualRequestTarget)
      const previous = this.watermarks.get(sk)
      if (previous !== undefined && fact.seq <= previous.seq) return
      this.watermarks.set(sk, { ...previous, seq: fact.seq, failed: previous?.failed ?? false })
    }
    if (request && fact.type === 'request-resolved') {
      const item = [...this.records.values()].find((candidate) => candidate.logicalKey === key)
      if (item !== undefined && item.notice.lifecycle === 'active') {
        item.notice = { ...item.notice, lifecycle: 'resolved', presentation: 'collapsed' }; this.trim(); this.bumpRevision()
      }
      return
    }
    let item: NoticeRecord | undefined
    if (request) {
      if (!this.settings[kind]) return
      item = [...this.records.values()].find((candidate) => candidate.logicalKey === key)
    } else {
      const sk = sessionKey(fact.target)
      const previous = this.watermarks.get(sk)
      // 同轮错误允许升级既有完成通知；淘汰历史绝不能重新接受旧序列。
      const sameTurn = previous?.turnId === fact.turnId
      if (previous !== undefined && (fact.seq !== undefined && fact.seq <= previous.seq || fact.turn !== undefined && previous.turn !== undefined && fact.turn < previous.turn)) return
      if (sameTurn && (previous!.failed || fact.type === 'turn-completed')) { if (fact.seq !== undefined) previous!.seq = fact.seq; return }
      item = sameTurn && previous?.noticeId !== undefined ? this.records.get(previous.noticeId) : undefined
      this.watermarks.set(sk, { seq: fact.seq ?? previous?.seq ?? -1, ...(fact.turn === undefined ? {} : { turn: fact.turn }), turnId: fact.turnId, failed: fact.type === 'turn-failed' })
      if (!this.settings[kind]) {
        // 关闭错误提示也不能保留同轮已被失败事实推翻的完成提示。
        if (item !== undefined) { this.remove(item); this.bumpRevision() }
        return
      }
    }
    const title = assistantNotificationText(fact.sessionTitle, 240, '未命名会话')
    const template = { completed: '本轮已完成', error: '本轮执行出错', question: '有问题需要你回答', approval: '有权限请求需要你确认' }[kind]
    const target = request ? { ...fact.target, requestId: fact.requestId, requestKind: fact.requestKind } : { ...fact.target }
    if (item !== undefined && request) {
      if (item.notice.lifecycle !== 'active') return
      const notice = { ...item.notice, sessionTitle: title, text: template, availability: 'ready' as const, ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }) }
      if (JSON.stringify(item.target) !== JSON.stringify(target) || JSON.stringify(item.notice) !== JSON.stringify(notice)) { item.target = target; item.notice = notice; this.bumpRevision() }
      return
    }
    const notice: AssistantNotification = {
      noticeId: item?.notice.noticeId ?? randomUUID(), kind, hostLabel: assistantNotificationText(fact.hostLabel, 160, '本机'),
      workspaceLabel: assistantNotificationText(fact.workspaceLabel, 160, '工作区'), sessionTitle: title, text: template,
      createdAt: this.now(), read: false, presentation: 'queued', lifecycle: 'active', availability: 'ready',
      ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }),
      ...(fact.type === 'turn-failed' && fact.errorExcerpt !== undefined ? { errorExcerpt: assistantNotificationText(fact.errorExcerpt) } : {}),
    }
    this.records.set(notice.noticeId, { notice, target, logicalKey: key })
    if (!request) this.watermarks.get(sessionKey(fact.target))!.noticeId = notice.noticeId
    this.trim(); this.bumpRevision()
  }
  read(input: AssistantNotificationReadRequest = {}): AssistantNotificationSnapshot {
    this.expire()
    if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0)) throw new TypeError('通知修订号无效')
    const limit = input.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('通知分页大小必须为 1 到 50')
    let offset = 0; let reset = false
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string' || input.cursor.length > 160 || !/^\d+:\d+:\d+$/u.test(input.cursor)) throw new TypeError('通知游标无效')
      const [generation, revision, index] = input.cursor.split(':').map(Number)
      if (![generation, revision, index].every(value => Number.isSafeInteger(value) && value! >= 0)) throw new TypeError('通知游标无效')
      if (generation !== this.currentGeneration || revision !== this.currentRevision) reset = true
      else offset = index!
    }
    const values = [...this.records.values()].map((item) => item.notice)
    const all = [...values].sort((a, b) => b.createdAt - a.createdAt || b.noticeId.localeCompare(a.noticeId))
    // 同毫秒内的多个请求仍按输入顺序展示，随机通知 ID 不能决定队列顺序。
    const candidates = values.filter((notice) => notice.lifecycle === 'active' && notice.presentation !== 'collapsed' && notice.availability === 'ready')
      .sort((a, b) => priority(b) - priority(a) || a.createdAt - b.createdAt)
    const next = offset + limit
    const snapshot: AssistantNotificationSnapshot = { generation: this.currentGeneration, revision: this.currentRevision, serverNow: this.now(), primary: candidates[0] === undefined ? null : { ...candidates[0] }, items: all.slice(offset, next).map((item) => ({ ...item })), unreadCount: all.filter((item) => !item.read).length, pendingCount: all.filter(pending).length, cursor: next < all.length ? `${this.currentGeneration}:${this.currentRevision}:${next}` : null, capabilities: [...this.capabilities.values()].map((item) => ({ ...item })), ...(reset ? { reset: true } : {}) }
    return input.cursor === undefined && input.revision === this.currentRevision ? { ...snapshot, items: [], unchanged: true } : snapshot
  }
  ack(input: AssistantNotificationAckRequest): AssistantNotificationAckResult {
    this.expire()
    if (!['presented', 'read', 'dismiss'].includes(input.action)) throw new TypeError('通知确认动作无效')
    if (input.kind !== undefined && !['completed', 'error', 'question', 'approval'].includes(input.kind)) throw new TypeError('通知确认类型无效')
    const item = this.lookup(input)
    // 浏览器和伴随窗口都可能在失败事实到达前发出了完成帧确认。
    if (input.connectionGeneration !== undefined && (!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 0)) throw new TypeError('远端连接代次无效')
    if (input.connectionGeneration !== undefined && input.connectionGeneration !== item.target.connectionGeneration) throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_STALE_CONNECTION', '远端连接已变化，请重新读取通知')
    if (input.action === 'presented' && input.kind !== undefined && input.kind !== item.notice.kind) return { generation: this.currentGeneration, revision: this.currentRevision, notification: { ...item.notice } }
    let next = item.notice
    if (input.action === 'presented' && next.presentation === 'queued') {
      const now = this.now()
      // 完成提示固定 10 秒自动收起；错误、提问与审批的自动关闭跟随助理通知设置（autoClose）。
      next = { ...next, presentation: 'shown', presentedAt: next.presentedAt ?? now, ...(next.kind === 'completed' ? { deadline: next.deadline ?? now + 10_000 } : {}) }
    }
    if (input.action === 'read' && !next.read) next = { ...next, read: true, ...(!pending(next) ? { presentation: 'collapsed' as const } : {}) }
    if (input.action === 'dismiss' && next.presentation !== 'collapsed') next = { ...next, presentation: 'collapsed' }
    if (next !== item.notice) { item.notice = next; this.bumpRevision() }
    return { generation: this.currentGeneration, revision: this.currentRevision, notification: { ...item.notice } }
  }
  async target(input: AssistantNotificationTargetRequest): Promise<AssistantNotificationTarget> {
    if (input.connectionGeneration !== undefined && (!Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration < 0)) throw new TypeError('远端连接代次无效')
    const item = this.lookup(input)
    const expectedConnection = item.target.connectionGeneration
    if (item.notice.availability !== 'ready') throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_DISCONNECTED', '目标 Host 暂时不可达')
    if (item.target.connectionGeneration !== undefined && input.connectionGeneration !== item.target.connectionGeneration) throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_STALE_CONNECTION', '远端连接已变化，请重新读取通知')
    if ((item.notice.kind === 'question' || item.notice.kind === 'approval') && item.notice.lifecycle !== 'active') throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_EXPIRED', '请求已经处理或失效')
    const valid = await this.options.validateTarget?.(item.target) ?? true
    // 复核异步查询期间发生的范围或连接变化。
    const current = this.lookup(input)
    if (!valid || current !== item || current.notice.availability !== 'ready' || current.target.connectionGeneration !== expectedConnection || input.connectionGeneration !== current.target.connectionGeneration) throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_EXPIRED', '通知目标已失效')
    return { ...item.target, ...(item.target.actualRequestTarget === undefined ? {} : { actualRequestTarget: { ...item.target.actualRequestTarget } }) }
  }
  dispose(): void { this.disposed = true; this.enabled = false; this.currentGeneration++; this.records.clear(); this.watermarks.clear(); this.connections.clear(); this.capabilities.clear(); this.bumpRevision(); this.revisionListeners.clear() }
  private lookup(input: { noticeId: string; generation: number }): NoticeRecord {
    if (!Number.isSafeInteger(input.generation) || input.generation !== this.currentGeneration) throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_STALE_GENERATION', '通知代次已变化')
    if (typeof input.noticeId !== 'string' || input.noticeId.length === 0 || input.noticeId.length > 160) throw new TypeError('通知 ID 无效')
    const item = this.records.get(input.noticeId)
    if (item === undefined || !this.enabled || !this.managed.has(item.target.workspaceId)) throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_EXPIRED', '通知已失效')
    return item
  }
  private expire(): void {
    for (const item of this.records.values()) if (item.notice.deadline !== undefined && item.notice.deadline <= this.now() && item.notice.presentation !== 'collapsed') { item.notice = { ...item.notice, presentation: 'collapsed' }; this.bumpRevision() }
  }
  private bumpRevision(): void {
    this.currentRevision++
    for (const listener of this.revisionListeners) {
      try { listener(this.currentRevision) } catch { /* 长连接观察者失败不能阻断通知写入。 */ }
    }
  }
  private remove(item: NoticeRecord): void { this.records.delete(item.notice.noticeId) }
  private logicalKey(fact: AssistantNotificationFact): string {
    return 'requestId' in fact
      ? JSON.stringify([fact.target.hostId, fact.target.actualRequestTarget?.sessionId ?? fact.target.sessionId, fact.requestKind, fact.requestId])
      : JSON.stringify([fact.target.hostId, fact.target.sessionId, 'turn', fact.turnId])
  }
  private trim(): void {
    const history = [...this.records.values()].filter((item) => !pending(item.notice)).sort((a, b) => a.notice.createdAt - b.notice.createdAt)
    for (const item of history.slice(0, Math.max(0, history.length - 100))) this.remove(item)
  }
}
