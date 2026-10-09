import type { AggregateHostResult, AggregateWorkspaceSummary, PeerHostSessionRecord, PeerHostSessionTitleProjection } from '../shared/contracts/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../shared/contracts/peer-host.js'
import { publishSessionAdapter } from './session-adapter-cache.js'

/** DSH `workspace/follow` 的 WorkspaceView 最小结构；字段只用于原生侧栏展示与分组。 */
export interface PeerHostVirtualWorkspaceView {
  readonly workspaceId: string
  readonly path: string
  /** 工作区在远端 Host 上的真实路径；`path` 仍是本机侧栏使用的虚拟路径。 */
  readonly workspacePath: string
  readonly title: string
  /** 远程工作区所属的目标 Host；仅虚拟远端工作区设置。 */
  readonly hostId: string
  /** 远程工作区所属 Host 的友好名称。 */
  readonly hostLabel: string
  /** 远程工作区所属 Host 的配置颜色。 */
  readonly hostColor?: string
  readonly availability: AggregateWorkspaceSummary['availability']
  readonly sessionIds: readonly string[]
  /** 归档会话仍是成员（保留槽位），但会被原生归档集合默认隐藏。 */
  readonly archivedSessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** DSH `session/list` 的 SessionSummary 最小结构；标题保留原生投影的来源与序号。 */
export interface PeerHostVirtualSessionSummary {
  readonly agentAvailable: boolean
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  readonly adapterId?: string
  readonly origin?: 'subagent'
  readonly parentSessionId?: string
  readonly projections: PeerHostSessionTitleProjection
}

export interface PeerHostNativeProjection {
  /** 首轮聚合前不能把原生流提前写入的虚拟条目误当成已移除项。 */
  hasAggregate(): boolean
  /** 记录新的聚合快照；返回 true 表示与上一次不同，调用方据此刷新原生数据。 */
  setAggregate(results: readonly AggregateHostResult[], orderedWorkspaceIds?: readonly string[]): boolean
  /** 更新 Host 侧持久化的全局 Workspace 顺序；顺序变化必须触发原生 Store 刷新。 */
  setWorkspaceOrder(orderedWorkspaceIds: readonly string[]): boolean
  /** 当前 Host 侧返回的混合 Workspace 顺序。 */
  workspaceOrder(): readonly string[]
  /** 当前本地 Host 的稳定 ID，用于把原生裸 Workspace ID 映射到虚拟顺序 ID。 */
  localHostId(): string | undefined
  /** 当前全部虚拟工作区（供原生 Workspace Store 合并）。 */
  workspaces(): readonly PeerHostVirtualWorkspaceView[]
  /** 当前全部虚拟会话摘要（供 `session/list` 响应合并）。 */
  sessions(): readonly PeerHostVirtualSessionSummary[]
  /** 订阅聚合变化；原生 Store 的订阅会转发到这里。 */
  subscribe(listener: () => void): () => void
}

/**
 * 为需要稳定显示标识的调用方生成虚拟 URI。
 *
 * DSH 会把 `workspace.path` 的目录前缀关系解释成父子工作区。不同 Host 的真实
 * 路径以及本地工作区之间都可能发生前缀重叠，因此列表层不能继续暴露真实目录。
 * 这里使用不对应本机文件系统的 URI，并把完整虚拟 ID 编码成单一段。Workspace
 * Store 使用这个值保证不同 Host 的同路径工作区仍是并列条目；真正的文件请求会在
 * Host 转发边界按虚拟 Workspace ID还原为目标 Host 的真实路径。
 */
export function createPeerHostWorkspaceDisplayPath(virtualWorkspaceId: string): string {
  return `codingns-peer-host://${encodeURIComponent(virtualWorkspaceId)}`
}

/**
 * 把 PeerHost 聚合摘要投影成 DSH 原生列表可直接消费的虚拟资源。
 *
 * 原生侧栏读的是 `workspaces.list` 与 `session/list` 这两条真实数据通道，因此这里
 * 不复制 DSH 组件、也不注入 DOM。输出只包含虚拟 ID、标题、时间与运行态；远端正文、
 * 凭据与路由信息不会离开本机。本地 Host 的资源由 DSH 自己提供，只投影远端。
 */
export function createPeerHostNativeProjection(): PeerHostNativeProjection {
  let workspaces: readonly PeerHostVirtualWorkspaceView[] = []
  let sessions: readonly PeerHostVirtualSessionSummary[] = []
  let orderedWorkspaceIds: readonly string[] = []
  let localHostId: string | undefined
  let hasAggregate = false
  const listeners = new Set<() => void>()
  return {
    hasAggregate: () => hasAggregate,
    setAggregate(results, nextOrderedWorkspaceIds) {
      const next = projectAggregate(results)
      // 某次摘要失败可能暂时不带本地 Host；保留上一次稳定 ID，避免原生裸 ID
      // 在这一轮被误当成未知项而跳到远端工作区之后。
      const nextLocalHostId = next.localHostId ?? localHostId
      const nextOrder = nextOrderedWorkspaceIds === undefined
        ? orderedWorkspaceIds
        : normalizeWorkspaceOrder(nextOrderedWorkspaceIds)
      const changed = !hasAggregate || !sameWorkspaces(workspaces, next.workspaces)
        || !sameSessions(sessions, next.sessions)
        || !sameIds(orderedWorkspaceIds, nextOrder)
        || localHostId !== nextLocalHostId
      if (!changed) return false
      hasAggregate = true
      // 无变化时保留原引用：下游 Store 快照与 useSyncExternalStore 依赖引用稳定。
      workspaces = next.workspaces
      sessions = next.sessions
      orderedWorkspaceIds = sameIds(orderedWorkspaceIds, nextOrder) ? orderedWorkspaceIds : nextOrder
      localHostId = nextLocalHostId
      for (const listener of [...listeners]) listener()
      return true
    },
    setWorkspaceOrder(nextOrderedWorkspaceIds) {
      const next = normalizeWorkspaceOrder(nextOrderedWorkspaceIds)
      if (sameIds(orderedWorkspaceIds, next)) return false
      orderedWorkspaceIds = next
      for (const listener of [...listeners]) listener()
      return true
    },
    workspaceOrder: () => orderedWorkspaceIds,
    localHostId: () => localHostId,
    workspaces: () => workspaces,
    sessions: () => sessions,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function projectAggregate(results: readonly AggregateHostResult[]): {
  readonly workspaces: readonly PeerHostVirtualWorkspaceView[]
  readonly sessions: readonly PeerHostVirtualSessionSummary[]
  readonly localHostId: string | undefined
} {
  const workspaces: PeerHostVirtualWorkspaceView[] = []
  const sessions: PeerHostVirtualSessionSummary[] = []
  const localHostId = results.find((host) => host.targetHostId === null)?.hostId
  for (const host of results) {
    // 本地 Host 的资源由 DSH 自己提供；只投影远端，避免与原生条目重复。
    if (host.targetHostId === null) continue
    const virtualHostId = host.targetHostId
    for (const workspace of host.workspaces) {
      const projected = projectWorkspace(virtualHostId, workspace, host.hostColor)
      workspaces.push(projected.workspace)
      sessions.push(...projected.sessions)
    }
  }
  return { workspaces, sessions, localHostId }
}

function normalizeWorkspaceOrder(ids: readonly string[]): readonly string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))]
}

function projectWorkspace(
  virtualHostId: string,
  workspace: AggregateWorkspaceSummary,
  hostColor: string | null | undefined,
): { readonly workspace: PeerHostVirtualWorkspaceView; readonly sessions: readonly PeerHostVirtualSessionSummary[] } {
  const virtualWorkspaceId = createVirtualWorkspaceId(virtualHostId, workspace.workspaceId)
  const realPath = workspace.path
  // 列表层必须使用虚拟路径，避免不同 Host 的真实目录被 DSH 合并成同一棵树。
  // 会话 cwd 仍保留真实路径；文件请求在 Host 边界再把虚拟根目录还原。
  const displayPath = createPeerHostWorkspaceDisplayPath(virtualWorkspaceId)
  const sessionIds: string[] = []
  const archivedSessionIds: string[] = []
  const sessions: PeerHostVirtualSessionSummary[] = []
  let updatedAt = 0
  const append = (session: PeerHostSessionRecord, archived: boolean): void => {
    const realSessionId = session.scope.sessionId
    if (realSessionId === null) return
    const virtualSessionId = createVirtualSessionId(virtualHostId, realSessionId)
    sessionIds.push(virtualSessionId)
    if (archived) archivedSessionIds.push(virtualSessionId)
    sessions.push(projectSession(virtualSessionId, session, realPath, workspace.availability === 'ready'))
    updatedAt = Math.max(updatedAt, session.updatedAt)
  }
  for (const session of workspace.sessions) append(session, false)
  for (const session of workspace.archivedSessions ?? []) append(session, true)
  // 原生状态目录需要子会话基线；工作区成员列表仍只包含普通与归档会话。
  for (const session of workspace.subagentSessions ?? []) {
    if (session.scope.sessionId === null) continue
    sessions.push(projectSession(createVirtualSessionId(virtualHostId, session.scope.sessionId), session, realPath, workspace.availability === 'ready'))
  }
  return {
    workspace: {
      workspaceId: virtualWorkspaceId,
      path: displayPath,
      workspacePath: realPath,
      // Host 归属不再写进标题文本：侧栏由彩色标签表达，标题保持干净，可搜索、
      // 可重命名，也不会污染 hover 卡片与重命名初值。
      title: workspace.displayName,
      hostId: virtualHostId,
      hostLabel: workspace.hostLabel,
      ...(hostColor === undefined || hostColor === null ? {} : { hostColor }),
      availability: workspace.availability,
      sessionIds,
      archivedSessionIds,
      // 远端未提供 Workspace 创建时间；用纪元时间保证原生 hover 卡片拿到合法日期。
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
    },
    sessions,
  }
}

function projectSession(
  virtualSessionId: string,
  session: PeerHostSessionRecord,
  cwd: string,
  available: boolean,
): PeerHostVirtualSessionSummary {
  if (session.adapterId !== undefined) publishSessionAdapter(virtualSessionId, session.adapterId)
  return {
    agentAvailable: available,
    sessionId: virtualSessionId,
    updatedAt: session.updatedAt,
    running: available && (session.status === 'running' || session.status === 'active'),
    // 旧缓存摘要没有 blank 时按正式会话兼容；原生远端摘要会提供真实值。
    blank: session.blank === true,
    cwd,
    // 新建会话的原生 baseline 可能已登记带序号的空标题；把后续标题降级为 cached
    // 会被 DSH 永久忽略。保留远端原生序号，让列表与实时流按同一规则合并。
    // 旧版摘要没有原生投影时仍只提供缓存提示，不能伪造时间戳序号抢占实时值。
    projections: session.titleProjection ?? { kind: 'cached', asOfSeq: 0, values: { title: session.title } },
    ...(session.adapterId === undefined ? {} : { adapterId: session.adapterId }),
    ...(session.origin === undefined ? {} : { origin: session.origin }),
    ...(session.parentSessionId === undefined ? {} : {
      parentSessionId: createVirtualSessionId(session.scope.targetHostId ?? session.scope.hostId, session.parentSessionId),
    }),
  }
}

function sameWorkspaces(previous: readonly PeerHostVirtualWorkspaceView[], next: readonly PeerHostVirtualWorkspaceView[]): boolean {
  if (previous.length !== next.length) return false
  return previous.every((workspace, index) => {
    const candidate = next[index]
    return candidate !== undefined && sameWorkspace(workspace, candidate)
  })
}

function sameWorkspace(left: PeerHostVirtualWorkspaceView, right: PeerHostVirtualWorkspaceView): boolean {
  return left.workspaceId === right.workspaceId
    && left.title === right.title
    && left.path === right.path
    && left.workspacePath === right.workspacePath
    && left.hostId === right.hostId
    && left.hostLabel === right.hostLabel
    && left.hostColor === right.hostColor
    && left.availability === right.availability
    && left.updatedAt === right.updatedAt
    && sameIds(left.sessionIds, right.sessionIds)
    && sameIds(left.archivedSessionIds, right.archivedSessionIds)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function sameSessions(previous: readonly PeerHostVirtualSessionSummary[], next: readonly PeerHostVirtualSessionSummary[]): boolean {
  if (previous.length !== next.length) return false
  return previous.every((session, index) => {
    const candidate = next[index]
    return candidate !== undefined
      && session.sessionId === candidate.sessionId
      && session.agentAvailable === candidate.agentAvailable
      && session.updatedAt === candidate.updatedAt
      && session.running === candidate.running
      && session.blank === candidate.blank
      && session.cwd === candidate.cwd
      && session.adapterId === candidate.adapterId
      && session.origin === candidate.origin
      && session.parentSessionId === candidate.parentSessionId
      && session.projections.kind === candidate.projections.kind
      && session.projections.asOfSeq === candidate.projections.asOfSeq
      && session.projections.values.title === candidate.projections.values.title
  })
}
