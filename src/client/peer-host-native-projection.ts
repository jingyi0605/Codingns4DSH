import type { AggregateHostResult, AggregateWorkspaceSummary, PeerHostSessionRecord } from '../shared/contracts/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../shared/contracts/peer-host.js'

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
  readonly projections: { readonly kind: 'cached'; readonly values: { readonly title: string } }
}

export interface PeerHostNativeProjection {
  /** 记录新的聚合快照；返回 true 表示与上一次不同，调用方据此刷新原生数据。 */
  setAggregate(results: readonly AggregateHostResult[]): boolean
  /** 当前全部虚拟工作区（供原生 Workspace Store 合并）。 */
  workspaces(): readonly PeerHostVirtualWorkspaceView[]
  /** 当前全部虚拟会话摘要（供 `session/list` 响应合并）。 */
  sessions(): readonly PeerHostVirtualSessionSummary[]
  /** 订阅聚合变化；原生 Store 的订阅会转发到这里。 */
  subscribe(listener: () => void): () => void
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
  const listeners = new Set<() => void>()
  return {
    setAggregate(results) {
      const next = projectAggregate(results)
      const changed = !sameWorkspaces(workspaces, next.workspaces) || !sameSessions(sessions, next.sessions)
      if (!changed) return false
      // 无变化时保留原引用：下游 Store 快照与 useSyncExternalStore 依赖引用稳定。
      workspaces = next.workspaces
      sessions = next.sessions
      for (const listener of [...listeners]) listener()
      return true
    },
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
} {
  const workspaces: PeerHostVirtualWorkspaceView[] = []
  const sessions: PeerHostVirtualSessionSummary[] = []
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
  return { workspaces, sessions }
}

function projectWorkspace(
  virtualHostId: string,
  workspace: AggregateWorkspaceSummary,
): { readonly workspace: PeerHostVirtualWorkspaceView; readonly sessions: readonly PeerHostVirtualSessionSummary[] } {
  const virtualWorkspaceId = createVirtualWorkspaceId(virtualHostId, workspace.workspaceId)
  // 原生文件面板按工作区 path 解析目录，必须用远端真实根目录而不是 workspaceId，
  // 否则目标端会拿 workspaceId 当文件路径并报 `no entry at "<workspaceId>"`。
  const path = workspace.path
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
    sessions.push(projectSession(virtualSessionId, session, path))
    updatedAt = Math.max(updatedAt, session.updatedAt)
  }
  for (const session of workspace.sessions) append(session, false)
  for (const session of workspace.archivedSessions ?? []) append(session, true)
  return {
    workspace: {
      workspaceId: virtualWorkspaceId,
      path,
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
  return {
    agentAvailable: true,
    sessionId: virtualSessionId,
    updatedAt: session.updatedAt,
    running: session.status === 'running' || session.status === 'active',
    blank: false,
    cwd,
    // DSH 列表行的标题只读投影值：cached 块只填没有原生水位的键，适合跨 Host 摘要。
    projections: { kind: 'cached', values: { title: session.title } },
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
      && session.projections.values.title === candidate.projections.values.title
  })
}
