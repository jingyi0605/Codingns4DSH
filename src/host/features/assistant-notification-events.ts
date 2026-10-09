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
interface LiveRequest { readonly target: AssistantNotificationTarget; readonly kind: 'question' | 'approval'; readonly id: string }
interface TurnBoundary { seq: number; turnId: string; turn?: number }
const questionEvents = new Set(['user-questions/request', 'user_questions/request', 'user-question/request'])
const resolveEvents = new Set(['approval/resolve', 'approval/resolved', 'approval/decided', 'user-questions/resolve', 'user-questions/resolved', 'user-question/resolve', 'user-question/answered'])
const record = (value: unknown): Record<string, any> | undefined => typeof value === 'object' && value !== null ? value as Record<string, any> : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const integer = (value: unknown): number | undefined => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
const readSessionId = (value: unknown): string | undefined => text(record(value)?.id) ?? text(record(value)?.sessionId) ?? text(record(record(value)?.header)?.id)
function optionalService(services: CodingNsHostServices, name: string): any { try { return services.dshContext?.get(name as never) } catch { return undefined } }

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
  private requests = new Map<string, LiveRequest>()
  private identities = new WeakMap<object, string>()
  private requestSequence = 0
  private disposeRemote: (() => void) | undefined
  private disposeProjection: (() => void) | undefined
  private active = false
  private localScopeActive = false
  private disposed = false
  private sourceTimer: ReturnType<typeof setTimeout> | undefined
  private readonly sourceScopes = new Map<string, number>()
  private readonly remoteRequests = new Map<string, Map<string, AssistantNotificationFact>>()
  private readonly remoteEpochs = new Map<string, string>()
  constructor(private readonly services: CodingNsHostServices, private readonly options: {
    readonly enabled?: () => boolean
    readonly excludedSessionIds?: () => ReadonlySet<string>
    /** 子请求必须有当前原生父子交互投影的证据，缺省不制造无法回答的提醒。 */
    readonly canNavigateChildRequest?: (parent: string, child: string) => boolean
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
      // 类型开关不会改变范围。保留订阅和连接代次，仅恢复重新允许展示的真实待办。
      this.restoreCurrentRequests()
      return
    }
    this.disposeRemote?.(); this.disposeRemote = undefined
    this.disposeProjection?.(); this.disposeProjection = undefined
    // 在途原生请求独立于本机展示配置，精确结束后再释放，远端读者不能被本机开关截断。
    this.members.clear(); this.turns.clear(); this.sequences.clear()
    if (previousGeneration !== this.center.generation) { this.remoteRequests.clear(); this.remoteEpochs.clear() }
    if (!this.active) return
    this.refreshMembership()
    const generation = this.center.generation
    const projections = optionalService(this.services, 'sessionProjections')
    const disposer = projections?.onChanged?.((session: unknown, key: string, value: unknown) => {
      if (generation === this.center.generation && key === 'userQuestions') this.projection(session, value)
    })
    if (typeof disposer === 'function') this.disposeProjection = disposer
    this.center.setCapabilities({ hostId: this.localHostId, completed: true, error: true, requests: true, resolve: true, navigation: true, recovery: false, reason: '阻塞式问题与审批没有公共当前请求注册表；仅恢复当前 userQuestions.active 定时问题投影；未提供可验证的父子交互投影时不展示子请求' })
    this.disposeRemote = this.localScopeActive ? this.services.assistantGateway?.subscribeNotifications?.(assistant?.managedWorkspaceIds ?? [], {
      onUpdate: (update) => { if (generation === this.center.generation) this.remoteUpdate(update) },
      onUnavailable: (hostId, connectionGeneration, reason, unsupported) => { if (generation !== this.center.generation) return; this.center.connection(hostId, connectionGeneration, false); if (unsupported) this.center.setCapabilities({ hostId, completed: false, error: false, requests: false, resolve: false, navigation: false, recovery: false, reason }) },
      onRemove: (hostId) => { if (generation === this.center.generation) { this.center.removeHost(hostId); this.remoteRequests.delete(hostId); this.remoteEpochs.delete(hostId) } },
    }) : undefined
  }
  /** 来源租约只覆盖认证请求指定的真实工作区，不创建或索引助理。 */
  sourceScope(workspaceIds: readonly string[]): void {
    if (this.disposed || workspaceIds.length === 0) return
    for (const id of workspaceIds) this.sourceScopes.set(id, Date.now() + 10_000)
    this.scheduleSourceExpiry()
    this.active = true; this.refreshMembership()
    if (this.disposeProjection !== undefined) return
    const generation = this.center.generation
    const disposer = optionalService(this.services, 'sessionProjections')?.onChanged?.((session: unknown, key: string, value: unknown) => {
      if (generation === this.center.generation && key === 'userQuestions') this.projection(session, value)
    })
    if (typeof disposer === 'function') this.disposeProjection = disposer
  }
  recoverSource(workspaceIds: readonly string[]): readonly AssistantNotificationFact[] {
    const scope = new Set(workspaceIds)
    return [...this.requests.values()].flatMap((request): AssistantNotificationFact[] => {
      const member = this.members.get(request.target.sessionId)
      if (member === undefined || !scope.has(member.workspaceId)) return []
      return [{ generation: this.center.generation, type: 'request-opened', target: { ...request.target, workspaceId: member.workspaceId }, requestId: request.id, requestKind: request.kind, workspaceLabel: member.workspaceLabel, sessionTitle: this.title(this.session(request.target.sessionId)) }]
    })
  }
  /** 仅在工作区注册变化时更新成员；read RPC 只读取中心内存。 */
  refreshMembership(): void {
    if (!this.active) return
    const registry = optionalService(this.services, 'workspaceRegistry')
    const list = registry?.list?.()
    const next = new Map<string, LocalMember>()
    for (const [id, deadline] of this.sourceScopes) if (deadline <= Date.now()) this.sourceScopes.delete(id)
    const managed = [...(this.localScopeActive ? this.services.settings?.get().assistant.managedWorkspaceIds ?? [] : []), ...this.sourceScopes.keys()]
    const archived = new Set<string>(Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : [])
    for (const workspace of Array.isArray(list) ? list : []) {
      const id = text(workspace?.id) ?? text(workspace?.workspaceId)
      if (id === undefined || !managed.some(value => assistantWorkspaceMatches(value, this.localHostId, id, true))) continue
      for (const sessionId of Array.isArray(workspace.archivedSessionIds) ? workspace.archivedSessionIds : []) archived.add(sessionId)
      for (const sessionId of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
        if (typeof sessionId !== 'string' || archived.has(sessionId) || this.excluded(sessionId)) continue
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
      this.projection(session, this.readProjection(session))
    }
    // 重新开启只恢复仍在原生调用中等待的请求；终态从新基线开始，不回放关闭期间历史。
    for (const live of [...this.requests.values()]) {
      const actualId = live.target.actualRequestTarget?.sessionId ?? live.target.sessionId
      const session = this.session(actualId) ?? { id: actualId }
      const member = this.requestMember(session)
      if (member !== undefined && !previous.has(member.target.sessionId)) this.request('request-opened', member, session, actualId, live.id, live.kind)
    }
  }
  sessionEvent(session: unknown, event: unknown): void {
    if (this.disposed) return
    const id = readSessionId(session); const value = record(event); const data = record(value?.data)
    if (id === undefined || value === undefined || data === undefined || this.excluded(id)) return
    const sourceHost = text(record(session)?.hostId) ?? text(record(session)?.header?.hostId)
    if (sourceHost !== undefined && sourceHost !== this.localHostId && sourceHost !== 'local') return
    const requestEvent = value.type === 'approval/asked' || value.type === 'approval/decided'
    if (!this.active && !requestEvent) return
    const replyEvent = value.type === 'user/message' && record(data.message?.source)?.kind === 'user-question-reply'
    const member = requestEvent || replyEvent ? this.requestMember(session) : this.members.get(id)
    if (record(session)?.blank === true || record(record(session)?.header)?.placeholder === true) return
    if (member === undefined) {
      // 无展示范围时只记真实根会话审批身份；首次认证来源读取才校验工作区归属。
      const requestId = text(data.id)
      if (requestEvent && requestId !== undefined && this.parentId(session) === undefined) this.request(value.type === 'approval/asked' ? 'request-opened' : 'request-resolved', undefined, session, id, requestId, 'approval')
      return
    }
    const seq = integer(value.seq)
    if (seq !== undefined) { if (seq <= (this.sequences.get(id) ?? -1)) return; this.sequences.set(id, seq) }
    if (value.type === 'session/title') { this.center.updateTitle(this.localHostId, id, text(data.title) ?? '未命名会话'); return }
    if (value.type === 'turn/start') {
      const turn = integer(data.turn)
      const turnId = text(data.turnId) ?? (turn === undefined ? seq === undefined ? undefined : `start:${seq}` : `turn:${turn}`)
      if (turnId !== undefined) this.turns.set(id, { seq: seq ?? -1, turnId, ...(turn === undefined ? {} : { turn }) })
      return
    }
    if (requestEvent) {
      const requestId = text(data.id)
      if (requestId === undefined) return
      this.request(value.type === 'approval/asked' ? 'request-opened' : 'request-resolved', member, session, id, requestId, 'approval', seq)
      return
    }
    if (value.type === 'user/message' && record(data.message?.source)?.kind === 'user-question-reply') {
      const requestId = text(data.message.source.callId)
      if (requestId !== undefined) this.request('request-resolved', member, session, id, requestId, 'question', seq)
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
  /** 观察实际 waterfall 调用并原样委托 next，finally 只结束该调用自己的提醒。 */
  observeRequest(eventName: string, args: readonly unknown[]): unknown {
    const request = record(args[0]); const next = args.at(-1)
    const agentSession = request?.agent?.session
    const id = readSessionId(agentSession) ?? text(request?.sessionId) ?? text(request?.agentId)
    const kind = questionEvents.has(eventName) ? 'question' : eventName === 'approval/request' || eventName === 'approval/asked' ? 'approval' : undefined
    if (this.disposed || request === undefined || id === undefined || kind === undefined || this.excluded(id)) return typeof next === 'function' ? next() : undefined
    if (request.signal instanceof AbortSignal && request.signal.aborted || kind === 'question' && (!Array.isArray(request.questions) || request.questions.length === 0)) return typeof next === 'function' ? next() : undefined
    const session = agentSession ?? this.session(id) ?? { id }
    const member = this.requestMember(session)
    // approval/request 本身没有请求 ID；真实服务用 approval/asked.data.id 和 decided 配对。
    const explicit = text(request.requestId) ?? text(request.id) ?? text(request.wait?.callId)
    if (member === undefined && this.parentId(session) !== undefined || kind === 'approval' && explicit === undefined) return typeof next === 'function' ? next() : undefined
    let requestId = explicit ?? this.identities.get(request)
    if (requestId === undefined && typeof next === 'function') { requestId = `question-source-${++this.requestSequence}`; this.identities.set(request, requestId) }
    if (requestId === undefined) return typeof next === 'function' ? next() : undefined
    this.request('request-opened', member, session, id, requestId, kind)
    const finish = (): void => {
      if (this.disposed) return
      // 定时提问的前台等待超时会继续接受续答；它不是请求取消。
      if (kind === 'question' && request.wait?.timed === true && record(request.signal?.reason)?.code === 'ASK_TIMED_OUT') return
      const projection = this.readProjection(session)
      if (kind === 'question' && Array.isArray(projection?.active) && projection.active.some((item: any) => item.callId === requestId)) return
      this.request('request-resolved', this.requestMember(session), session, id, requestId!, kind)
    }
    const signal = request.signal instanceof AbortSignal ? request.signal : undefined
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
    if (typeof next !== 'function') return undefined
    try { return Promise.resolve(next()).finally(() => { signal?.removeEventListener('abort', finish); finish() }) }
    catch (error) { signal?.removeEventListener('abort', finish); finish(); throw error }
  }
  resolveRequest(eventName: string, args: readonly unknown[]): void {
    if (this.disposed || !resolveEvents.has(eventName)) return
    const value = record(args[0]); const id = readSessionId(value?.agent?.session) ?? text(value?.sessionId) ?? text(value?.agentId)
    const requestId = text(value?.requestId) ?? text(value?.id) ?? text(value?.callId)
    if (id === undefined || requestId === undefined) return
    const session = value?.agent?.session ?? this.session(id) ?? { id }; const member = this.requestMember(session)
    if (member !== undefined || this.parentId(session) === undefined) this.request('request-resolved', member, session, id, requestId, eventName.startsWith('approval/') ? 'approval' : 'question')
  }
  sessionDisposed(session: unknown): void {
    const id = readSessionId(session)
    if (id === undefined) return
    for (const live of [...this.requests.values()]) {
      if ((live.target.actualRequestTarget?.sessionId ?? live.target.sessionId) !== id) continue
      const member = this.members.get(live.target.sessionId)
      this.request('request-resolved', member, session, id, live.id, live.kind)
    }
  }
  dispose(): void { this.disposed = true; this.active = false; clearTimeout(this.sourceTimer); this.disposeRemote?.(); this.disposeProjection?.(); this.requests.clear(); this.members.clear(); this.turns.clear(); this.sequences.clear(); this.sourceScopes.clear(); this.remoteRequests.clear(); this.remoteEpochs.clear(); this.center.dispose() }
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
  private request(type: 'request-opened' | 'request-resolved', member: LocalMember | undefined, session: unknown, actualId: string, requestId: string, requestKind: 'question' | 'approval', seq?: number): void {
    const key = JSON.stringify([actualId, requestKind, requestId])
    const target = member === undefined ? this.requests.get(key)?.target ?? { hostId: this.localHostId, workspaceId: '', sessionId: actualId } : member.target.sessionId === actualId ? member.target : { ...member.target, actualRequestTarget: { hostId: this.localHostId, sessionId: actualId, requestId } }
    if (type === 'request-opened') this.requests.set(key, { target, id: requestId, kind: requestKind })
    else this.requests.delete(key)
    if (member === undefined) return
    this.consume({ generation: this.center.generation, type, target, requestId, requestKind, workspaceLabel: member.workspaceLabel, sessionTitle: this.title(this.session(member.target.sessionId) ?? session), ...(seq === undefined ? {} : { seq }) }, member)
  }
  /** 配置不制造新的来源事实；当前请求可以重新展示，历史终态不能补弹。 */
  private restoreCurrentRequests(): void {
    for (const live of this.requests.values()) {
      const actualId = live.target.actualRequestTarget?.sessionId ?? live.target.sessionId
      const member = this.requestMember(this.session(actualId) ?? { id: actualId })
      if (!member) continue
      this.center.consume({ generation: this.center.generation, type: 'request-opened', target: { ...live.target, workspaceId: member.target.workspaceId },
        requestId: live.id, requestKind: live.kind, workspaceLabel: member.workspaceLabel, sessionTitle: this.title(this.session(member.target.sessionId)) })
    }
    for (const requests of this.remoteRequests.values()) for (const fact of requests.values()) {
      const { seq: _oldSequence, ...current } = fact
      this.center.consume({ ...current, generation: this.center.generation })
    }
  }
  private consume(fact: AssistantNotificationFact, member: LocalMember): void {
    this.center.consume(fact)
    this.options.onFact?.({ ...fact, target: { ...fact.target, workspaceId: member.workspaceId } })
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
  private projection(session: unknown, value: unknown): void {
    const id = readSessionId(session); const projection = record(value)
    if (!this.active || id === undefined || !Array.isArray(projection?.active)) return
    const member = this.requestMember(session)
    if (member === undefined) return
    const active = new Set<string>()
    for (const pending of projection.active) {
      const callId = text(pending?.callId)
      if (callId === undefined) continue
      active.add(callId)
      this.request('request-opened', member, session, id, callId, 'question')
    }
    for (const live of [...this.requests.values()]) if (live.kind === 'question' && (live.target.actualRequestTarget?.sessionId ?? live.target.sessionId) === id && !live.id.startsWith('question-source-') && !active.has(live.id)) this.request('request-resolved', member, session, id, live.id, 'question')
  }
  private readProjection(session: unknown): any { try { return optionalService(this.services, 'sessionProjections')?.snapshot?.(session, ['userQuestions'])?.values?.userQuestions } catch { return undefined } }
  private session(id: string): unknown { try { return this.services.nativeSessions?.get?.(id) ?? optionalService(this.services, 'sessions')?.get?.(id) } catch { return undefined } }
  private title(session: unknown): string {
    const value = record(session)
    const current = optionalService(this.services, 'sessionTitle')?.get?.(session)
    return text(current?.title) ?? text(value?.title) ?? text(value?.header?.title) ?? '未命名会话'
  }
  private excluded(id: string): boolean { return id.startsWith(ASSISTANT_AGENT_PREFIX) || this.options.excludedSessionIds?.().has(id) === true }
  private parentId(session: unknown): string | undefined { return text(record(session)?.header?.parentSession) ?? text(record(session)?.parentSessionId) }
  private requestMember(session: unknown): LocalMember | undefined {
    const id = readSessionId(session)
    return this.parentId(session) === undefined ? id === undefined ? undefined : this.members.get(id) : this.parentMember(session)
  }
  private parentMember(session: unknown): LocalMember | undefined {
    const child = readSessionId(session); let parent = this.parentId(session); const visited = new Set<string>()
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent); const member = this.members.get(parent)
      const ancestor = this.session(parent)
      if (member !== undefined && this.parentId(ancestor) === undefined) return child !== undefined && this.options.canNavigateChildRequest?.(parent, child) === true ? member : undefined
      parent = this.parentId(ancestor)
    }
    return undefined
  }
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
    if (target.requestId !== undefined && target.requestKind !== undefined && !this.requests.has(JSON.stringify([target.actualRequestTarget?.sessionId ?? target.sessionId, target.requestKind, target.requestId]))) return false
    const session = this.session(target.sessionId)
    // 持久化的受管会话可以重新打开；卸载内存实例并不表示目标被删除。
    if (target.requestId !== undefined && this.session(target.actualRequestTarget?.sessionId ?? target.sessionId) === undefined) return false
    return record(session)?.blank !== true && record(record(session)?.header)?.placeholder !== true
  }
}
