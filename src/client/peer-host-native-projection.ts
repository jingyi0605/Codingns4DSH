import type { AggregateHostResult, AggregateWorkspaceSummary, PeerHostSessionRecord } from '../shared/contracts/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../shared/contracts/peer-host.js'
import { publishSessionAdapter } from './session-adapter-cache.js'

/** DSH `workspace/follow` 的 WorkspaceView 最小结构；字段只用于原生侧栏展示与分组。 */
export interface PeerHostVirtualWorkspaceView {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  /** 归档会话仍是成员（保留槽位），但会被原生归档集合默认隐藏。 */
  readonly archivedSessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** DSH `session/list` 的 SessionSummary 最小结构；标题走 `cached` 投影块。 */
export interface PeerHostVirtualSessionSummary {
  readonly agentAvailable: boolean
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  readonly adapterId?: string
  readonly projections: { readonly kind: 'cached'; readonly values: { readonly title: string } }
}

export interface PeerHostNativeProjection {
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
 * 为混合工作区生成只用于原生侧栏树归属的稳定路径。
 *
 * DSH 会把 `workspace.path` 的目录前缀关系解释成父子工作区。不同 Host 的真实
 * 路径以及本地工作区之间都可能发生前缀重叠，因此列表层不能继续暴露真实目录。
 * 这里使用不对应本机文件系统的 URI，并把完整虚拟 ID 编码成单一段，保证所有
 * 工作区都是同一层的兄弟节点。文件和会话请求仍使用所属 Host 的真实路径。
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
  const listeners = new Set<() => void>()
  return {
    setAggregate(results, nextOrderedWorkspaceIds) {
      const next = projectAggregate(results)
      // 某次摘要失败可能暂时不带本地 Host；保留上一次稳定 ID，避免原生裸 ID
      // 在这一轮被误当成未知项而跳到远端工作区之后。
      const nextLocalHostId = next.localHostId ?? localHostId
      const nextOrder = nextOrderedWorkspaceIds === undefined
        ? orderedWorkspaceIds
        : normalizeWorkspaceOrder(nextOrderedWorkspaceIds)
      const changed = !sameWorkspaces(workspaces, next.workspaces)
        || !sameSessions(sessions, next.sessions)
        || !sameIds(orderedWorkspaceIds, nextOrder)
        || localHostId !== nextLocalHostId
      if (!changed) return false
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
      const projected = projectWorkspace(virtualHostId, workspace)
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
): { readonly workspace: PeerHostVirtualWorkspaceView; readonly sessions: readonly PeerHostVirtualSessionSummary[] } {
  const virtualWorkspaceId = createVirtualWorkspaceId(virtualHostId, workspace.workspaceId)
  // 真实路径保留给会话摘要和远端请求；Workspace Store 的 path 使用独立显示值，
  // 防止 DSH 把本地与远端目录前缀识别成父子关系。
  const displayPath = createPeerHostWorkspaceDisplayPath(virtualWorkspaceId)
  const realPath = workspace.path
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
    sessions.push(projectSession(virtualSessionId, session, realPath))
    updatedAt = Math.max(updatedAt, session.updatedAt)
  }
  for (const session of workspace.sessions) append(session, false)
  for (const session of workspace.archivedSessions ?? []) append(session, true)
  return {
    workspace: {
      workspaceId: virtualWorkspaceId,
      path: displayPath,
      // Host 归属不再写进标题文本：侧栏由彩色标签表达，标题保持干净，可搜索、
      // 可重命名，也不会污染 hover 卡片与重命名初值。
      title: workspace.displayName,
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
): PeerHostVirtualSessionSummary {
  if (session.adapterId !== undefined) publishSessionAdapter(virtualSessionId, session.adapterId)
  return {
    agentAvailable: true,
    sessionId: virtualSessionId,
    updatedAt: session.updatedAt,
    running: session.status === 'running' || session.status === 'active',
    // 旧缓存摘要没有 blank 时按正式会话兼容；原生远端摘要会提供真实值。
    blank: session.blank === true,
    cwd,
    // DSH 列表行的标题只读投影值：cached 块只填没有原生水位的键，适合跨 Host 摘要。
    projections: { kind: 'cached', values: { title: session.title } },
    ...(session.adapterId === undefined ? {} : { adapterId: session.adapterId }),
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
      && session.updatedAt === candidate.updatedAt
      && session.running === candidate.running
      && session.blank === candidate.blank
      && session.cwd === candidate.cwd
      && session.adapterId === candidate.adapterId
      && session.projections.values.title === candidate.projections.values.title
  })
}
