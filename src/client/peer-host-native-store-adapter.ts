import type { Context } from '@deepseek-ai/cordis'
import type { AggregateHostResult, AggregateWorkspaceSummary } from '../shared/contracts/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId, parseVirtualWorkspaceId } from '../shared/contracts/peer-host.js'

/** DSH Workspace 列表快照的最小公开结构；不依赖 DSH 私有实现类型。 */
interface WorkspaceSnapshot {
  readonly items: readonly Record<string, unknown>[]
  readonly archivedSessionIds?: readonly string[]
  readonly pinnedSessionIds?: readonly string[]
  readonly state?: unknown
  readonly phase?: unknown
  readonly error?: unknown
}

interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

interface WorkspaceService {
  list: SnapshotStore<WorkspaceSnapshot>
  insertBefore?: (workspaceId: string, beforeWorkspaceId?: string) => Promise<unknown>
}

interface SessionSummary {
  readonly id: string
  readonly title?: string
  readonly displayTitle: string
  readonly cwd?: string
  readonly parentId?: string
  readonly running: boolean
  readonly retainedBy: Readonly<Record<string, number>>
  readonly blank: boolean
  readonly updatedAt: number
  readonly projectionValues?: Readonly<Record<string, unknown>>
}

interface SessionListSnapshot {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummary>>
  readonly phase: unknown
  readonly projectionsBySession: Readonly<Record<string, unknown>>
}

interface SessionService {
  list: SnapshotStore<SessionListSnapshot>
}

interface PeerHostNativeStoreAdapterOptions {
  readonly context: Context
  readonly aggregate: readonly AggregateHostResult[]
  readonly workspaceOrder?: readonly string[]
  readonly moveWorkspace?: (workspaceId: string, beforeWorkspaceId: string | null) => Promise<readonly string[]>
}

export interface PeerHostNativeStoreAdapter {
  readonly supported: boolean
  readonly reason?: string
  /** 用新聚合快照刷新远端虚拟资源；本地 Store 不会被复制或清空。 */
  setAggregate(aggregate: readonly AggregateHostResult[]): void
  dispose(): void
}

/**
 * 将 PeerHost 摘要接入 DSH 已存在的原生列表 Store。
 *
 * Cordis 禁止跨 Fiber 重新 provide 同名服务，因此这里不注册第二个
 * `workspaces/sessions` 服务，只替换它们公开的 snapshot facade。原生 UI
 * 仍然通过 `ctx.get('workspaces').list` 和 `ctx.get('sessions').list` 读取。
 */
export function installPeerHostNativeStoreAdapter(options: PeerHostNativeStoreAdapterOptions): PeerHostNativeStoreAdapter {
  const workspaces = readService<WorkspaceService>(options.context, 'workspaces')
  const sessions = readService<SessionService>(options.context, 'sessions')
  if (workspaces?.list === undefined || sessions?.list === undefined) {
    return {
      supported: false,
      reason: 'DSH 原生 workspaces.list 或 sessions.list 不可用',
      setAggregate() { /* no-op */ },
      dispose() { /* no-op */ },
    }
  }

  const originalWorkspaceList = workspaces.list
  const originalSessionList = sessions.list
  const originalInsertBefore = workspaces.insertBefore
  const workspaceListeners = new Set<() => void>()
  const sessionListeners = new Set<() => void>()
  let aggregate = options.aggregate
  let workspaceOrder = options.workspaceOrder ?? []
  let version = 0
  let workspaceCache: { version: number; source: WorkspaceSnapshot; value: WorkspaceSnapshot } | undefined
  let sessionCache: { version: number; source: SessionListSnapshot; value: SessionListSnapshot } | undefined

  const notify = (listeners: Set<() => void>): void => {
    for (const listener of listeners) listener()
  }
  const workspaceList: SnapshotStore<WorkspaceSnapshot> = {
    getSnapshot() {
      const source = originalWorkspaceList.getSnapshot()
      if (workspaceCache?.version === version && workspaceCache.source === source) return workspaceCache.value
      const value = mergeWorkspaceSnapshot(source, aggregate, workspaceOrder)
      workspaceCache = { version, source, value }
      return value
    },
    subscribe(listener) {
      workspaceListeners.add(listener)
      return () => {
        workspaceListeners.delete(listener)
      }
    },
  }
  const sessionList: SnapshotStore<SessionListSnapshot> = {
    getSnapshot() {
      const source = originalSessionList.getSnapshot()
      if (sessionCache?.version === version && sessionCache.source === source) return sessionCache.value
      const value = mergeSessionSnapshot(source, aggregate)
      sessionCache = { version, source, value }
      return value
    },
    subscribe(listener) {
      sessionListeners.add(listener)
      return () => {
        sessionListeners.delete(listener)
      }
    },
  }

  workspaces.list = workspaceList
  sessions.list = sessionList
  const moveWorkspace = options.moveWorkspace
  if (typeof originalInsertBefore === 'function' && moveWorkspace !== undefined) {
    workspaces.insertBefore = async (workspaceId, beforeWorkspaceId) => {
      if (parseVirtualWorkspaceId(workspaceId) === null) return originalInsertBefore.call(workspaces, workspaceId, beforeWorkspaceId)
      workspaceOrder = [...await moveWorkspace(workspaceId, beforeWorkspaceId ?? null)]
      version++
      workspaceCache = undefined
      notify(workspaceListeners)
    }
  }

  const unsubscribeWorkspace = originalWorkspaceList.subscribe(() => {
    workspaceCache = undefined
    notify(workspaceListeners)
  })
  const unsubscribeSession = originalSessionList.subscribe(() => {
    sessionCache = undefined
    notify(sessionListeners)
  })

  return {
    supported: true,
    setAggregate(next) {
      aggregate = next
      version++
      workspaceCache = undefined
      sessionCache = undefined
      notify(workspaceListeners)
      notify(sessionListeners)
    },
    dispose() {
      unsubscribeWorkspace()
      unsubscribeSession()
      workspaces.list = originalWorkspaceList
      sessions.list = originalSessionList
      if (workspaces.insertBefore !== originalInsertBefore) {
        if (originalInsertBefore === undefined) delete workspaces.insertBefore
        else workspaces.insertBefore = originalInsertBefore
      }
      workspaceListeners.clear()
      sessionListeners.clear()
    },
  }
}

function mergeWorkspaceSnapshot(source: WorkspaceSnapshot, aggregate: readonly AggregateHostResult[], workspaceOrder: readonly string[]): WorkspaceSnapshot {
  const remote = aggregate
    .filter((host) => host.targetHostId !== null)
    .flatMap((host) => host.workspaces.map((workspace) => toWorkspaceView(host, workspace)))
  const localIds = new Set(source.items.map((item) => readString(item, 'workspaceId')))
  const items = [...source.items, ...remote.filter((item) => !localIds.has(readString(item, 'workspaceId')))]
  const rank = new Map(workspaceOrder.map((id, index) => [id, index]))
  if (rank.size > 0) items.sort((left, right) => (rank.get(readString(left, 'workspaceId')) ?? Number.MAX_SAFE_INTEGER) - (rank.get(readString(right, 'workspaceId')) ?? Number.MAX_SAFE_INTEGER))
  return { ...source, items }
}

function mergeSessionSnapshot(source: SessionListSnapshot, aggregate: readonly AggregateHostResult[]): SessionListSnapshot {
  const byId: Record<string, SessionSummary> = { ...source.byId }
  const ids = [...source.ids]
  for (const host of aggregate) {
    if (host.targetHostId === null) continue
    const virtualHostId = host.targetHostId
    for (const workspace of host.workspaces) {
      for (const session of workspace.sessions) {
        const id = createVirtualSessionId(virtualHostId, session.scope.sessionId ?? session.scope.workspaceId)
        if (byId[id] !== undefined) continue
        byId[id] = {
          id,
          title: session.title,
          displayTitle: `${session.title} (${workspace.hostLabel})`,
          running: session.status === 'running' || session.status === 'active',
          retainedBy: {},
          blank: false,
          updatedAt: session.updatedAt,
          projectionValues: {},
        }
        ids.push(id)
      }
    }
  }
  return { ...source, ids, byId }
}

function toWorkspaceView(host: AggregateHostResult, workspace: AggregateWorkspaceSummary): Record<string, unknown> {
  const virtualHostId = host.targetHostId ?? host.hostId
  const workspaceId = createVirtualWorkspaceId(virtualHostId, workspace.workspaceId)
  return {
    workspaceId,
    path: workspace.workspaceId,
    title: `${workspace.displayName} (${workspace.hostLabel})`,
    sessionIds: workspace.sessions.flatMap((session) => session.scope.sessionId === null ? [] : [createVirtualSessionId(virtualHostId, session.scope.sessionId)]),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(Math.max(0, ...workspace.sessions.map((session) => session.updatedAt))).toISOString(),
    codingnsPeerHost: host.hostId,
    codingnsPeerHostLabel: workspace.hostLabel,
    codingnsAvailability: workspace.availability,
  }
}

function readService<T>(context: Context, name: string): T | undefined {
  try {
    return context.get(name) as T | undefined
  } catch {
    return undefined
  }
}

function readString(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] as string : ''
}
