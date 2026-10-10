import type { CodingNsHostServices } from './types.js'
import { assistantWorkspaceMatches, readAssistantProfile } from '../../shared/assistant-lifecycle.js'
import type { AssistantNotificationCapabilities, AssistantNotificationTarget } from '../../shared/assistant-notifications.js'
import { AssistantNotificationCenter, type AssistantNotificationFact } from './assistant-notifications.js'
import { ASSISTANT_AGENT_PREFIX } from '../../dsh-capabilities/host/assistant-agent-adapter.js'
import { getAdapterRegistry } from '../cli-adapters/registry-holder.js'
import type { AssistantPeerNotificationUpdate } from './assistant-peer-notifications.js'
import { parseVirtualWorkspaceId } from '../../shared/contracts/peer-host.js'

/** 可选远端入口由网关实现；每个回调都受创建时的中心代次约束。 */
export interface AssistantNotificationGateway {
  validateNotificationTarget?(target: AssistantNotificationTarget): boolean | Promise<boolean>
}
interface LocalMember { readonly target: AssistantNotificationTarget; readonly workspaceId: string; readonly workspaceLabel: string }
interface TurnBoundary { seq: number; turnId: string; turn?: number }
type RequestFact = Extract<AssistantNotificationFact, { readonly requestId: string; readonly requestKind: 'question' | 'approval' }>
/** 问询工具的规范名；等待用户回答的调用在开放回合内未完成时就是当前提问。 */
const questionTools = new Set(['ask_user_question', 'question'])
/** 会改变开放请求集合的事件类型；到达时触发一次实时重扫，而不是累积状态。 */
const openRequestSignals = new Set(['approval/asked', 'approval/decided', 'tool/call', 'tool/result', 'turn/start', 'turn/end'])
const record = (value: unknown): Record<string, any> | undefined => typeof value === 'object' && value !== null ? value as Record<string, any> : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const integer = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
const readSessionId = (value: unknown): string | undefined => text(record(value)?.id) ?? text(record(value)?.sessionId) ?? text(record(record(value)?.header)?.id)
function optionalService(services: CodingNsHostServices, name: string): any { try { return services.dshContext?.get(name as never) } catch { return undefined } }
function isRequestFact(value: AssistantNotificationFact): value is RequestFact {
  return 'requestId' in value && typeof value.requestId === 'string'
    && (value.requestKind === 'question' || value.requestKind === 'approval')
}

/** DSH 的工作区隐藏功能由设置层保存；启用该功能时才把隐藏工作区排除在当前范围外。 */
function readHiddenWorkspaceIds(services: CodingNsHostServices): ReadonlySet<string> {
  const value = record(services.settings?.get()?.workspaceSessionEnhancement)
  if (value?.showWorkspaceHiding !== true || !Array.isArray(value.hiddenWorkspaceIds)) return new Set()
  return new Set(value.hiddenWorkspaceIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))
}

/** 原生 turn/end 的 completed 是轮次成功；外部模型 stop 经 Agent Loop 转成 completed。
 * 只有已经确认的外部来源可以直接将 stop 解释为成功，未知来源保留能力缺口。 */
export function assistantNotificationTerminal(event: unknown, external = false): 'completed' | 'error' | null {
  const value = record(event); const data = record(value?.data)
  if (value?.type !== 'turn/end') return null
  const kind = record(data?.reason)?.kind
  if (kind === 'completed' || external && kind === 'stop') return 'completed'
  return kind === 'error' ? 'error' : null
}

/** 与索引共用现有原生订阅，通知处理独立且不会读取正文或调用模型。 */
export class AssistantNotificationEvents {
  readonly center: AssistantNotificationCenter
  private readonly localHostId = process.env.CODINGNS4DSH_HOST_ID?.trim() || 'local-host'
  private members = new Map<string, LocalMember>()
  private turns = new Map<string, TurnBoundary>()
  private sequences = new Map<string, number>()
  private disposeRemote: (() => void) | undefined
  private disposeProjection: (() => void) | undefined
  private active = false
  private localScopeActive = false
  private disposed = false
  private sourceTimer: ReturnType<typeof setTimeout> | undefined
  private readonly sourceScopes = new Map<string, number>()
  private readonly remoteRequests = new Map<string, Map<string, AssistantNotificationFact>>()
  private readonly remoteEpochs = new Map<string, string>()
  /** 本机当前请求的上一份快照；仅用于把出现/解决转换成来源增量。 */
  private readonly observedRequests = new Map<string, AssistantNotificationFact>()
  private requestSnapshotReady = false
  constructor(private readonly services: CodingNsHostServices, private readonly options: {
    readonly enabled?: () => boolean
    readonly excludedSessionIds?: () => ReadonlySet<string>
    readonly onFact?: (fact: AssistantNotificationFact) => void
  } = {}) {
    this.center = new AssistantNotificationCenter({ validateTarget: (target) => this.validateTarget(target) })
    this.sync()
  }
  sync(): void {
    const settings = this.services.settings?.get()
    const assistant = settings?.assistant
    const enabled = !this.disposed && this.options.enabled?.() !== false && settings?.modules.globalVoiceAssistant === true && assistant !== undefined && readAssistantProfile(assistant).initialized && assistant.appearance?.floatingEnabled === true && assistant.managedWorkspaceIds.length > 0
    const previousGeneration = this.center.generation
    const changed = this.center.configure(enabled, assistant?.managedWorkspaceIds ?? [], assistant?.notifications)
    this.localScopeActive = enabled && assistant?.notifications?.enabled !== false
    this.active = this.localScopeActive || this.sourceScopes.size > 0
    if (!changed) return
    if (previousGeneration === this.center.generation) {
      // 类型开关不会改变范围。保留订阅和连接代次，重新读取当前会话状态。
      this.reconcileCurrentState()
      return
    }
    this.disposeRemote?.(); this.disposeRemote = undefined
    this.disposeProjection?.(); this.disposeProjection = undefined
    // 在途原生请求独立于本机展示配置，精确结束后再释放，远端读者不能被本机开关截断。
    this.members.clear(); this.turns.clear(); this.sequences.clear()
    if (previousGeneration !== this.center.generation) {
      this.remoteRequests.clear(); this.remoteEpochs.clear()
      this.observedRequests.clear(); this.requestSnapshotReady = false
    }
    if (!this.active) return
    this.refreshMembership()
    const generation = this.center.generation
    const projections = optionalService(this.services, 'sessionProjections')
    const disposer = projections?.onChanged?.((session: unknown, key: string, value: unknown) => {
      if (generation === this.center.generation && key === 'userQuestions') this.projection(session, value)
    })
    if (typeof disposer === 'function') this.disposeProjection = disposer
    const recovery = this.recoverySupported
    this.center.setCapabilities({
      hostId: this.localHostId, completed: true, error: true, requests: true, resolve: true, navigation: true, recovery,
      ...(recovery ? {} : { reason: '当前 Host 未提供可读取的会话提问投影；只处理运行期间收到的审批/提问事件' }),
    })
    this.disposeRemote = this.localScopeActive ? this.services.assistantGateway?.subscribeNotifications?.(assistant?.managedWorkspaceIds ?? [], {
      onUpdate: (update) => { if (generation === this.center.generation) this.remoteUpdate(update) },
      onUnavailable: (hostId, connectionGeneration, reason, unsupported) => { if (generation !== this.center.generation) return; this.center.connection(hostId, connectionGeneration, false); if (unsupported) this.center.setCapabilities({ hostId, completed: false, error: false, requests: false, resolve: false, navigation: false, recovery: false, reason }) },
      onRemove: (hostId) => { if (generation === this.center.generation) { this.center.removeHost(hostId); this.remoteRequests.delete(hostId); this.remoteEpochs.delete(hostId) } },
    }) : undefined
  }
  /** 来源租约只覆盖认证请求指定的真实工作区，不创建或索引助理。 */
  sourceScope(workspaceIds: readonly string[]): void {
    if (this.disposed || workspaceIds.length === 0) return
    this.renewSourceScope(workspaceIds)
    this.refreshMembership()
    if (this.disposeProjection !== undefined) return
    const generation = this.center.generation
    const disposer = optionalService(this.services, 'sessionProjections')?.onChanged?.((session: unknown, key: string, value: unknown) => {
      if (generation === this.center.generation && key === 'userQuestions') this.projection(session, value)
    })
    if (typeof disposer === 'function') this.disposeProjection = disposer
  }
  /** 长连接续租只延长来源范围，不重复扫描工作区和会话。 */
  renewSourceScope(workspaceIds: readonly string[]): void {
    if (this.disposed || workspaceIds.length === 0) return
    for (const id of workspaceIds) this.sourceScopes.set(id, Date.now() + 10_000)
    this.scheduleSourceExpiry()
    this.active = true
  }
  recoverSource(workspaceIds: readonly string[]): readonly AssistantNotificationFact[] {
    return this.currentRequestFacts(workspaceIds)
  }
  /** 每次读取都从当前会话状态重新投影，Host 重启不依赖旧内存请求。 */
  readCurrent(): void { this.refreshMembership() }
  /** Host 侧官方恢复通道是会话投影（当前 userQuestions）；投影服务不可用时明确声明仅事件。 */
  get recoverySupported(): boolean { return typeof optionalService(this.services, 'sessionProjections')?.snapshot === 'function' }
  /** 按工作区注册表和当前可见性更新成员；通知读取前也会调用，避免范围使用旧快照。 */
  refreshMembership(): void {
    if (!this.active) return
    const registry = optionalService(this.services, 'workspaceRegistry')
    const list = registry?.list?.()
    const next = new Map<string, LocalMember>()
    const hiddenWorkspaceIds = readHiddenWorkspaceIds(this.services)
    for (const [id, deadline] of this.sourceScopes) if (deadline <= Date.now()) this.sourceScopes.delete(id)
    const managed = [...(this.localScopeActive ? this.services.settings?.get().assistant.managedWorkspaceIds ?? [] : []), ...this.sourceScopes.keys()]
    const archived = new Set<string>(Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : [])
    for (const workspace of Array.isArray(list) ? list : []) {
      const id = text(workspace?.id) ?? text(workspace?.workspaceId)
      if (id === undefined || !managed.some(value => assistantWorkspaceMatches(value, this.localHostId, id, true))) continue
      if (hiddenWorkspaceIds.has(id) || workspace?.hidden === true || workspace?.visible === false) continue
      for (const sessionId of Array.isArray(workspace.archivedSessionIds) ? workspace.archivedSessionIds : []) archived.add(sessionId)
      for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
        const session = typeof sessionId === 'string' ? this.session(sessionId) : undefined
        if (typeof sessionId !== 'string' || archived.has(sessionId) || this.excluded(sessionId) || this.isNonInteractiveSession(session)) continue
        const configured = managed.find((value) => assistantWorkspaceMatches(value, this.localHostId, id, true))!
        next.set(sessionId, { target: { hostId: this.localHostId, workspaceId: configured, sessionId }, workspaceId: id, workspaceLabel: text(workspace.displayName) ?? text(workspace.title) ?? text(workspace.name) ?? id })
      }
    }
    for (const id of this.members.keys()) if (!next.has(id)) { this.center.invalidateSession(this.localHostId, id); this.turns.delete(id); this.sequences.delete(id) }
    const previous = this.members; this.members = next
    for (const [id, member] of next) {
      if (previous.has(id)) continue
      const session = this.session(id)
      let events: readonly unknown[] = []
      try { events = record(session)?.snapshotEvents?.() ?? [] } catch { /* 只有可证明的当前事件才参与通知。 */ }
      const seq = integer(record(events.at(-1))?.seq) ?? -1
      this.sequences.set(id, seq); this.center.baseline(member.target, seq)
    }
    this.reconcileCurrentState()
  }
  sessionEvent(session: unknown, event: unknown): void {
    if (this.disposed) return
    const id = readSessionId(session); const value = record(event); const data = record(value?.data)
    if (id === undefined || value === undefined || data === undefined || this.excluded(id)) return
    const sourceHost = text(record(session)?.hostId) ?? text(record(session)?.header?.hostId)
    if (sourceHost !== undefined && sourceHost !== this.localHostId && sourceHost !== 'local') return
    if (!this.active) return
    // 待办不是事件累积出的状态：这些事件只作为「重新扫描会话事件流」的信号。
    const shouldReconcile = openRequestSignals.has(value.type)
    let member = this.members.get(id)
    // 长连接续租不再周期扫描成员；新会话第一次出现开放请求或回合边界时，
    // 只为这个未知会话补一次注册，避免把整个会话目录变成轮询源。
    if (member === undefined && shouldReconcile) {
      this.refreshMembership()
      member = this.members.get(id)
    }
    if (shouldReconcile) this.reconcileCurrentState()
    if (member === undefined) return
    if (record(session)?.blank === true || record(record(session)?.header)?.placeholder === true) return
    const seq = integer(value.seq)
    if (seq !== undefined) { if (seq <= (this.sequences.get(id) ?? -1)) return; this.sequences.set(id, seq) }
    if (value.type === 'session/title') { this.center.updateTitle(this.localHostId, id, text(data.title) ?? '未命名会话'); return }
    if (value.type === 'turn/start') {
      const turn = integer(data.turn)
      const turnId = text(data.turnId) ?? (turn === undefined ? seq === undefined ? undefined : `start:${seq}` : `turn:${turn}`)
      if (turnId !== undefined) this.turns.set(id, { seq: seq ?? -1, turnId, ...(turn === undefined ? {} : { turn }) })
      return
    }
    const terminal = assistantNotificationTerminal(event, this.isExternal(session))
    if (terminal === null || this.parentId(session) !== undefined) return
    const boundary = this.turns.get(id); const turn = integer(data.turn) ?? boundary?.turn
    const turnId = text(data.turnId) ?? (turn === undefined ? boundary?.turnId : `turn:${turn}`)
    if (turnId === undefined) return
    this.consume({ generation: this.center.generation, target: member.target, workspaceLabel: member.workspaceLabel, sessionTitle: this.title(session), type: terminal === 'error' ? 'turn-failed' : 'turn-completed', turnId,
      ...(turn === undefined ? {} : { turn }), ...(seq === undefined ? {} : { seq }),
      ...(terminal === 'error' ? { errorExcerpt: '执行失败，请查看会话详情' } : {}),
    }, member)
  }
  /** waterfall 调用只是重扫信号；开放请求由读取时的会话事件流扫描决定，这里必须原样委托 next。 */
  observeRequest(_eventName: string, args: readonly unknown[]): unknown {
    const next = args.at(-1)
    // 原生 waterfall 的 next 可能在返回 Promise 前同步写入 approval/asked 或 tool/call。
    // 先调用 next 再重扫，否则只能等下一次读取或租约刷新，通知会平白延迟数秒。
    let result: unknown
    try {
      result = typeof next === 'function' ? next() : undefined
    } finally {
      if (!this.disposed && this.active) this.reconcileCurrentState()
      // 兼容 next 通过一个微任务才落盘的 Host 实现，仍不等待用户答复本身。
      queueMicrotask(() => { if (!this.disposed && this.active) this.reconcileCurrentState() })
    }
    return result
  }
  resolveRequest(_eventName: string, _args: readonly unknown[]): void {
    if (!this.disposed && this.active) this.reconcileCurrentState()
  }
  sessionDisposed(session: unknown): void {
    const id = readSessionId(session)
    if (id === undefined) return
    // 会话销毁后不再有开放请求；下一次读取会按当前成员与事件流重新校正。
    this.reconcileCurrentState()
  }
  dispose(): void { this.disposed = true; this.active = false; clearTimeout(this.sourceTimer); this.disposeRemote?.(); this.disposeProjection?.(); this.members.clear(); this.turns.clear(); this.sequences.clear(); this.sourceScopes.clear(); this.remoteRequests.clear(); this.remoteEpochs.clear(); this.observedRequests.clear(); this.requestSnapshotReady = false; this.center.dispose() }
  /** 最后一个远端读取者离开后撤销来源范围和投影观察，保留共享的原生事件订阅。 */
  private scheduleSourceExpiry(): void {
    clearTimeout(this.sourceTimer)
    const next = Math.min(...this.sourceScopes.values())
    if (!Number.isFinite(next)) return
    this.sourceTimer = setTimeout(() => {
      this.refreshMembership()
      this.active = this.localScopeActive || this.sourceScopes.size > 0
      if (!this.active) { this.disposeProjection?.(); this.disposeProjection = undefined }
      this.scheduleSourceExpiry()
    }, Math.max(1, next - Date.now()))
    this.sourceTimer.unref?.()
  }
  private consume(fact: AssistantNotificationFact, member: LocalMember): void {
    this.center.consume(fact)
    this.options.onFact?.({ ...fact, target: { ...fact.target, workspaceId: member.workspaceId } })
  }
  private reconcileCurrentState(): void {
    const current = this.currentRequestSnapshot()
    this.center.reconcilePending(current.facts, this.localHostId, current.authoritative)
    this.publishRequestDeltas(current.facts)
    // 远端仍由其带 epoch 的 current pending 快照负责；本机配置切换时只重新投影最近一份远端快照。
    for (const requests of this.remoteRequests.values()) for (const fact of requests.values()) {
      const { seq: _oldSequence, ...currentFact } = fact
      this.center.consume({ ...currentFact, generation: this.center.generation })
    }
  }

  /** 把当前请求快照转成一次性的 opened/resolved 增量，供 WebSocket 来源流即时转发。 */
  private publishRequestDeltas(facts: readonly AssistantNotificationFact[]): void {
    const next = new Map<string, AssistantNotificationFact>()
    for (const fact of facts) {
      if (!isRequestFact(fact)) continue
      next.set(this.requestKey(fact), fact)
    }
    if (this.requestSnapshotReady) {
      for (const [key, fact] of next) {
        const previous = this.observedRequests.get(key)
        if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(fact)) this.options.onFact?.(fact)
      }
      for (const [key, previous] of this.observedRequests) {
        if (next.has(key) || !isRequestFact(previous)) continue
        this.options.onFact?.({ ...previous, type: 'request-resolved' })
      }
    }
    this.observedRequests.clear()
    for (const [key, fact] of next) this.observedRequests.set(key, fact)
    this.requestSnapshotReady = true
  }

  private requestKey(fact: RequestFact): string {
    return JSON.stringify([fact.target.hostId, fact.target.actualRequestTarget?.sessionId ?? fact.target.sessionId, fact.requestKind, fact.requestId])
  }
  private currentRequestFacts(workspaceIds?: readonly string[]): readonly AssistantNotificationFact[] {
    const selected = workspaceIds === undefined ? undefined : new Set(workspaceIds)
    return this.currentRequestSnapshot().facts.filter((fact) => selected === undefined || selected.has(fact.target.workspaceId))
  }
  private currentRequestSnapshot(): { readonly facts: readonly AssistantNotificationFact[]; readonly authoritative: readonly string[] } {
    const facts: AssistantNotificationFact[] = []; const seen = new Set<string>(); const authoritative = new Set<string>()
    const add = (member: LocalMember, session: unknown, requestId: string, kind: 'question' | 'approval'): void => {
      const actualId = member.target.sessionId
      const key = JSON.stringify([actualId, kind, requestId])
      if (seen.has(key)) return
      seen.add(key); authoritative.add(`${kind}:${actualId}`)
      facts.push({ generation: this.center.generation, type: 'request-opened', target: member.target, requestId, requestKind: kind,
        workspaceLabel: member.workspaceLabel, sessionTitle: this.title(session ?? this.session(actualId)) })
    }
    for (const member of this.members.values()) {
      const session = this.session(member.target.sessionId)
      // 实时扫描会话自身的开放回合；不保存扫描结果，每次读取重新计算。
      const open = this.scanOpenRequests(session, member.target.sessionId)
      if (open.available) {
        authoritative.add(`approval:${member.target.sessionId}`); authoritative.add(`question:${member.target.sessionId}`)
        for (const requestId of open.approvals) add(member, session, requestId, 'approval')
        for (const requestId of open.questions) add(member, session, requestId, 'question')
      }
      // 定时提问可以跨重启续答，以 DSH 提问投影为准。
      const projection = this.readProjection(session)
      if (!Array.isArray(projection?.active)) continue
      authoritative.add(`question:${member.target.sessionId}`)
      for (const item of projection.active) {
        const requestId = text(item?.callId)
        if (requestId !== undefined) add(member, session, requestId, 'question')
      }
    }
    return { facts, authoritative: [...authoritative] }
  }
  /** 读取时实时扫描会话事件流：只把未闭合回合内的未决审批与未完成问询调用当作当前待办。 */
  private scanOpenRequests(session: unknown, sessionId: string): { readonly available: boolean; readonly approvals: readonly string[]; readonly questions: readonly string[] } {
    const value = record(session)
    if (value === undefined || typeof value.snapshotEvents !== 'function') return { available: false, approvals: [], questions: [] }
    // 没有活跃 Agent 而回合仍未闭合，只可能来自进程崩溃残留；DSH 语义下那不是当前待办。
    // 日志仍是权威：不展示残留，但已处理完的历史记录依然会在读取时被清理。
    const agents = optionalService(this.services, 'agents')
    if (agents !== undefined && typeof agents.get === 'function') {
      try { if (agents.get(sessionId) == null) return { available: true, approvals: [], questions: [] } } catch { /* 不可判定时按事件流处理 */ }
    }
    let events: readonly unknown[] = []
    try { events = value.snapshotEvents() ?? [] } catch { return { available: false, approvals: [], questions: [] } }
    const approvals = new Set<string>(); const questions = new Set<string>()
    const decided = new Set<string>(); const finished = new Set<string>()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const item = record(events[index]); const type = item?.type; const data = record(item?.data)
      if (type === 'turn/start' || type === 'turn/end') break
      if (type === 'approval/decided') { const id = text(data?.id); if (id !== undefined) decided.add(id); continue }
      if (type === 'approval/asked') { const id = text(data?.id); if (id !== undefined && !decided.has(id)) approvals.add(id); continue }
      if (type === 'tool/result') { const id = text(data?.callId) ?? text(record(data?.message)?.toolCallId); if (id !== undefined) finished.add(id); continue }
      if (type === 'tool/call') {
        const id = text(data?.callId); const name = text(data?.name)
        if (id !== undefined && name !== undefined && questionTools.has(name) && !finished.has(id)) questions.add(id)
      }
    }
    return { available: true, approvals: [...approvals], questions: [...questions] }
  }
  private remoteUpdate(update: AssistantPeerNotificationUpdate): void {
    const { hostId, feed, connectionGeneration } = update
    if (this.remoteEpochs.has(hostId) && this.remoteEpochs.get(hostId) !== feed.epoch) { this.center.removeHost(hostId); this.remoteRequests.delete(hostId) }
    this.remoteEpochs.set(hostId, feed.epoch)
    this.center.connection(hostId, connectionGeneration, true)
    this.center.setCapabilities({ hostId, ...feed.capabilities, navigation: true })
    const managed = this.services.settings?.get().assistant.managedWorkspaceIds ?? []
    const next = new Map<string, AssistantNotificationFact>()
    const convert = (value: typeof feed.events[number]): AssistantNotificationFact | undefined => {
      // 未限定 Host 的原始 ID 属于本机，不能因为远端有同名工作区而扩大范围。
      const workspaceId = managed.find(selected => selected !== value.workspaceId && assistantWorkspaceMatches(selected, hostId, value.workspaceId))
      if (workspaceId === undefined) return undefined
      const base = { generation: this.center.generation, target: { hostId, workspaceId, sessionId: value.sessionId, connectionGeneration }, hostLabel: update.hostLabel, workspaceLabel: value.workspaceLabel, sessionTitle: value.sessionTitle, ...(value.seq === undefined ? {} : { seq: value.seq }) }
      if (value.kind === 'completed' || value.kind === 'error') return { ...base, type: value.kind === 'error' ? 'turn-failed' : 'turn-completed', turnId: `${feed.epoch}:${value.logicalId}`, ...(value.errorExcerpt === undefined ? {} : { errorExcerpt: value.errorExcerpt }) }
      if (value.requestId === undefined) return undefined
      const requestKind = value.kind === 'resolved' ? value.requestKind : value.kind
      if (requestKind !== 'question' && requestKind !== 'approval') return undefined
      return { ...base, target: { ...base.target, ...(value.actualRequestSessionId === undefined ? {} : { actualRequestTarget: { hostId, sessionId: value.actualRequestSessionId, requestId: value.requestId } }) }, type: value.kind === 'resolved' ? 'request-resolved' : 'request-opened', requestId: value.requestId, requestKind }
    }
    for (const value of feed.events) { const fact = convert(value); if (fact !== undefined) this.center.consume(fact) }
    for (const value of feed.pending) {
      const fact = convert(value)
      if (fact === undefined || !('requestId' in fact)) continue
      next.set(JSON.stringify([fact.target.actualRequestTarget?.sessionId ?? fact.target.sessionId, fact.requestKind, fact.requestId]), fact); this.center.consume(fact)
    }
    if (feed.capabilities.resolve) for (const [key, previous] of this.remoteRequests.get(hostId) ?? []) {
      if (next.has(key) || !('requestId' in previous)) continue
      // 当前请求快照的缺席是新的结算证明，不能携带旧 asked 序号被去重水位拒绝。
      const { seq: _previousSeq, ...resolved } = previous
      this.center.consume({ ...resolved, generation: this.center.generation, target: { ...previous.target, connectionGeneration }, type: 'request-resolved' })
    }
    this.remoteRequests.set(hostId, next)
  }
  private projection(_session: unknown, value: unknown): void {
    if (!this.active || !Array.isArray(record(value)?.active)) return
    this.reconcileCurrentState()
  }
  private readProjection(session: unknown): any { try { return optionalService(this.services, 'sessionProjections')?.snapshot?.(session, ['userQuestions'])?.values?.userQuestions } catch { return undefined } }
  private session(id: string): unknown { try { return this.services.nativeSessions?.get?.(id) ?? optionalService(this.services, 'sessions')?.get?.(id) } catch { return undefined } }
  private title(session: unknown): string {
    const value = record(session)
    const current = optionalService(this.services, 'sessionTitle')?.get?.(session)
    return text(current?.title) ?? text(value?.title) ?? text(value?.header?.title) ?? '未命名会话'
  }
  private excluded(id: string): boolean { return id.startsWith(ASSISTANT_AGENT_PREFIX) || this.options.excludedSessionIds?.().has(id) === true }
  private isNonInteractiveSession(session: unknown): boolean {
    const value = record(session)
    return value?.blank === true || value?.origin === 'subagent' || record(value?.header)?.origin === 'subagent'
  }
  private parentId(session: unknown): string | undefined { return text(record(session)?.header?.parentSession) ?? text(record(session)?.parentSessionId) }
  private isExternal(session: unknown): boolean {
    const id = readSessionId(session)
    if (id === undefined) return false
    try { const binding = getAdapterRegistry()?.getSession(id); return binding !== undefined && binding.adapterId !== 'dsh' } catch { return false }
  }
  private async validateTarget(target: AssistantNotificationTarget): Promise<boolean> {
    if (target.hostId !== this.localHostId) {
      const gateway = this.services.assistantGateway
      if (gateway === undefined) return false
      const explicit = (gateway as AssistantNotificationGateway).validateNotificationTarget
      if (explicit !== undefined) return await explicit(target)
      const source = await gateway.list(this.services.settings?.get().assistant.managedWorkspaceIds ?? [])
      if (!source.sessions.some(session => session.hostId === target.hostId && session.sessionId === target.sessionId && (session.workspaceId === target.workspaceId || assistantWorkspaceMatches(target.workspaceId, target.hostId, parseVirtualWorkspaceId(session.workspaceId)?.workspaceId ?? session.workspaceId))) || source.archivedSessionIds.includes(target.sessionId)) return false
      return target.requestId === undefined || [...(this.remoteRequests.get(target.hostId)?.values() ?? [])].some(fact => 'requestId' in fact && fact.target.sessionId === target.sessionId && fact.target.actualRequestTarget?.sessionId === target.actualRequestTarget?.sessionId && fact.requestId === target.requestId && fact.requestKind === target.requestKind)
    }
    this.refreshMembership()
    const member = this.members.get(target.sessionId)
    if (member?.target.workspaceId !== target.workspaceId || this.excluded(target.sessionId)) return false
    const session = this.session(target.sessionId)
    // 持久化的受管会话可以重新打开；卸载内存实例并不表示目标被删除。
    if (target.requestId !== undefined && this.session(target.actualRequestTarget?.sessionId ?? target.sessionId) === undefined) return false
    return record(session)?.blank !== true && record(record(session)?.header)?.placeholder !== true
  }
}
