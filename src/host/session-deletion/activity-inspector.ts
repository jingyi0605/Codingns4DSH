import {
  readService,
  type DshSessionHeaderLike,
  type DshSessionPersistenceLike,
  type DshSessionPersistenceSnapshotLike,
} from '../../dsh-capabilities/host/session-deletion-adapter.js'
import type { SessionDeletionReasonCode, SessionDeletionSubagentStatus } from '../../shared/contracts/session-deletion.js'
import type { SessionAdmissionGuard } from './admission-guard.js'

export interface ActivityInspectionResult {
  readonly subagentStatus: SessionDeletionSubagentStatus
  readonly descendantSubagentIds: readonly string[]
  readonly activeReasons: readonly string[]
  readonly blockingReasonCode?: SessionDeletionReasonCode
  readonly blockingMessage?: string
  readonly activityUnverified: boolean
  readonly unverifiedReasons: readonly string[]
}

interface LiveSessionLike {
  readonly id?: string
  readonly header?: DshSessionHeaderLike
}

interface LiveSessionsServiceLike {
  get?(id: string): LiveSessionLike | undefined
  list?(): readonly LiveSessionLike[]
}

interface LiveAgentLike {
  readonly id?: string
  readonly status?: string
  readonly session?: LiveSessionLike
}

interface LiveAgentsServiceLike {
  get?(id: string): LiveAgentLike | undefined
  list?(): readonly LiveAgentLike[]
}

interface JobLike {
  readonly owner?: string
  readonly status?: string
}

interface JobsServiceLike {
  list?(sessionId?: string): readonly JobLike[]
}

interface ScheduleTaskLike {
  readonly status?: string
  readonly target?: { readonly kind?: string; readonly sessionId?: string }
  readonly involvedSessionIds?: readonly string[]
}

interface ScheduleServiceLike {
  list?(request?: { readonly active?: boolean }): Promise<{ readonly items?: readonly ScheduleTaskLike[] }> | { readonly items?: readonly ScheduleTaskLike[] }
}

interface ProjectionCacheLike {
  cachedSnapshot?(header: DshSessionHeaderLike, keys?: readonly string[]): { readonly values?: Record<string, unknown> } | undefined
}

export async function inspectSessionActivityAndLineage(input: {
  readonly sessionId: string
  readonly header: DshSessionHeaderLike
  readonly persistence: DshSessionPersistenceLike
  readonly dshContext: unknown
  readonly admissionGuard: SessionAdmissionGuard
  readonly signal?: AbortSignal
}): Promise<ActivityInspectionResult> {
  const { sessionId, header, persistence, dshContext, admissionGuard, signal } = input
  const activeReasons: string[] = []
  const unverifiedReasons: string[] = []

  const sessions = readService(dshContext, 'sessions') as LiveSessionsServiceLike | undefined
  const agents = readService(dshContext, 'agents') as LiveAgentsServiceLike | undefined
  const projectionCache = readService(dshContext, 'sessionProjectionCache') as ProjectionCacheLike | undefined

  // 1. Subagent & lineage checks: refuse deleting a child subagent while its parent still lives,
  // and collect all local descendant subagent sessions for recursive parent deletion.
  if (header.origin === 'subagent') {
    let parentExists = false
    if (typeof header.parentSession === 'string' && header.parentSession !== '') {
      if (typeof sessions?.get === 'function' && sessions.get(header.parentSession) !== undefined) {
        parentExists = true
      } else if (await persistence.stat(header.parentSession, signal === undefined ? undefined : { signal }) !== undefined) {
        parentExists = true
      }
    }
    if (parentExists) {
      return {
        subagentStatus: 'is-subagent-with-parent',
        descendantSubagentIds: [],
        activeReasons,
        blockingReasonCode: 'SESSION_DELETION_SUBAGENT_WITH_PARENT',
        blockingMessage: 'Subagent sessions whose parent session still exists cannot be deleted independently',
        activityUnverified: false,
        unverifiedReasons,
      }
    }
  }

  const persistedSnapshots = await persistence.list(signal === undefined ? undefined : { signal })
  const descendantSubagentIds = await collectLocalDescendantSubagents({
    rootSessionId: sessionId,
    rootHeader: header,
    persistedSnapshots,
    persistence,
    sessions,
    agents,
    projectionCache,
    signal,
  })
  const subagentStatus: SessionDeletionSubagentStatus = header.origin === 'subagent'
    ? 'orphan-subagent'
    : descendantSubagentIds.length > 0
      ? 'has-children'
      : 'none'

  // 2. Runtime activity & ownership checks across root + all descendant subagents (fail-closed).
  const allTargetIds = [...descendantSubagentIds, sessionId]
  const schedule = readService(dshContext, 'schedule') as ScheduleServiceLike | undefined
  let activeScheduleItems: readonly ScheduleTaskLike[] | undefined
  if (schedule !== undefined && typeof schedule.list === 'function') {
    try {
      const listed = await schedule.list({ active: true })
      activeScheduleItems = Array.isArray(listed?.items) ? listed.items : []
    } catch {
      unverifiedReasons.push('schedule-inspection-failed')
    }
  }

  for (const targetId of allTargetIds) {
    if (typeof sessions?.get !== 'function') {
      if (!unverifiedReasons.includes('sessions-service-unavailable')) {
        unverifiedReasons.push('sessions-service-unavailable')
      }
    } else if (sessions.get(targetId) !== undefined && !activeReasons.includes('live-session')) {
      activeReasons.push('live-session')
    }

    if (typeof agents?.get === 'function') {
      const agent = agents.get(targetId)
      if (agent !== undefined) {
        const reason = agent.status === 'running' ? 'turn' : 'live-agent'
        if (!activeReasons.includes(reason)) activeReasons.push(reason)
      }
    }

    if (
      (persistence.hasPendingSession?.(targetId) === true
        || admissionGuard.hasActiveWriter(targetId)
        || admissionGuard.hasInFlightAdmission(targetId))
      && !activeReasons.includes('live-writer')
    ) {
      activeReasons.push('live-writer')
    }

    const waterfall = readService(dshContext, 'waterfall')
    if (typeof waterfall === 'function') {
      try {
        const activities = await (waterfall as (name: string, req: { sessionId: string }, fallback: () => Promise<unknown[]>) => Promise<unknown[]>)
          .call(dshContext, 'workspace/session-activity', { sessionId: targetId }, () => Promise.resolve([]))
        if (Array.isArray(activities)) {
          for (const item of activities) {
            if (isObject(item) && typeof item.kind === 'string' && !activeReasons.includes(item.kind)) {
              activeReasons.push(item.kind)
            }
          }
        }
      } catch {
        if (!unverifiedReasons.includes('session-activity-waterfall-failed')) {
          unverifiedReasons.push('session-activity-waterfall-failed')
        }
      }
    }

    const jobs = (readService(dshContext, 'jobs') ?? readService(dshContext, 'jobRegistry')) as JobsServiceLike | undefined
    if (jobs !== undefined && typeof jobs.list === 'function') {
      try {
        const listed = jobs.list(targetId)
        if (Array.isArray(listed) && listed.some((job) => job.owner === targetId && (job.status === 'running' || job.status === 'stopping'))) {
          if (!activeReasons.includes('job')) activeReasons.push('job')
        }
      } catch {
        if (!unverifiedReasons.includes('jobs-inspection-failed')) {
          unverifiedReasons.push('jobs-inspection-failed')
        }
      }
    }

    if (activeScheduleItems !== undefined) {
      const hasTask = activeScheduleItems.some((task) =>
        task.status === 'active'
        && (
          (task.target?.kind === 'session' && task.target.sessionId === targetId)
          || (Array.isArray(task.involvedSessionIds) && task.involvedSessionIds.includes(targetId))
        ),
      )
      if (hasTask && !activeReasons.includes('schedule')) activeReasons.push('schedule')
    }
  }

  const activityUnverified = unverifiedReasons.length > 0
  const blockingReasonCode = activeReasons.length > 0
    ? mapActivityToReasonCode(activeReasons[0]!)
    : activityUnverified
      ? 'SESSION_DELETION_ACTIVITY_UNVERIFIED'
      : undefined
  const blockingMessage = activeReasons.length > 0
    ? `Session "${sessionId}" is currently held by runtime activity (${activeReasons.join(', ')})`
    : activityUnverified
      ? `Unable to verify runtime activity for session "${sessionId}" (${unverifiedReasons.join(', ')})`
      : undefined

  return {
    subagentStatus,
    descendantSubagentIds,
    activeReasons,
    ...(blockingReasonCode === undefined ? {} : { blockingReasonCode }),
    ...(blockingMessage === undefined ? {} : { blockingMessage }),
    activityUnverified,
    unverifiedReasons,
  }
}

async function collectLocalDescendantSubagents(input: {
  readonly rootSessionId: string
  readonly rootHeader: DshSessionHeaderLike
  readonly persistedSnapshots: readonly DshSessionPersistenceSnapshotLike[]
  readonly persistence: DshSessionPersistenceLike
  readonly sessions: LiveSessionsServiceLike | undefined
  readonly agents: LiveAgentsServiceLike | undefined
  readonly projectionCache: ProjectionCacheLike | undefined
  readonly signal: AbortSignal | undefined
}): Promise<string[]> {
  const {
    rootSessionId,
    rootHeader,
    persistedSnapshots,
    persistence,
    sessions,
    agents,
    projectionCache,
    signal,
  } = input

  const headersById = new Map<string, DshSessionHeaderLike>([[rootSessionId, rootHeader]])
  const childrenByParent = new Map<string, Set<string>>()
  const addEdge = (parentId: string, childId: string): void => {
    if (parentId === '' || childId === '' || parentId === childId) return
    let set = childrenByParent.get(parentId)
    if (set === undefined) {
      set = new Set<string>()
      childrenByParent.set(parentId, set)
    }
    set.add(childId)
  }

  for (const entry of persistedSnapshots) {
    headersById.set(entry.header.id, entry.header)
    if (entry.header.origin === 'subagent' && typeof entry.header.parentSession === 'string') {
      addEdge(entry.header.parentSession, entry.header.id)
    }
  }

  if (typeof sessions?.list === 'function') {
    for (const entry of sessions.list()) {
      if (entry.id !== undefined && entry.header !== undefined) {
        headersById.set(entry.id, entry.header)
        if (entry.header.origin === 'subagent' && typeof entry.header.parentSession === 'string') {
          addEdge(entry.header.parentSession, entry.id)
        }
      }
    }
  }

  if (typeof agents?.list === 'function') {
    for (const agent of agents.list()) {
      const header = agent.session?.header
      if (agent.id !== undefined && header !== undefined) {
        headersById.set(agent.id, header)
        if (header.origin === 'subagent' && typeof header.parentSession === 'string') {
          addEdge(header.parentSession, agent.id)
        }
      }
    }
  }

  const visited = new Set<string>([rootSessionId])
  const postOrder: string[] = []

  const visitChildren = async (nodeId: string): Promise<void> => {
    let header = headersById.get(nodeId)
    if (header === undefined) {
      const stat = await persistence.stat(nodeId, signal === undefined ? undefined : { signal })
      if (stat !== undefined) {
        header = stat.header
        headersById.set(nodeId, header)
      }
    }
    if (header !== undefined && typeof projectionCache?.cachedSnapshot === 'function') {
      try {
        const snap = projectionCache.cachedSnapshot(header, ['subagentCatalog'])
        const catalog = snap?.values?.subagentCatalog
        if (Array.isArray(catalog)) {
          for (const item of catalog) {
            if (!isObject(item) || item.mode === 'external' || typeof item.id !== 'string' || item.id === '') continue
            const childId = item.id
            if (headersById.has(childId) || sessions?.get?.(childId) !== undefined || agents?.get?.(childId) !== undefined) {
              addEdge(nodeId, childId)
            } else {
              const childStat = await persistence.stat(childId, signal === undefined ? undefined : { signal })
              if (childStat !== undefined) {
                headersById.set(childId, childStat.header)
                addEdge(nodeId, childId)
              }
            }
          }
        }
      } catch {
        // Projection cache is optional; persisted snapshots and live registries already cover active trees.
      }
    }

    const children = [...(childrenByParent.get(nodeId) ?? [])]
    for (const childId of children) {
      if (visited.has(childId)) continue
      visited.add(childId)
      await visitChildren(childId)
      postOrder.push(childId)
    }
  }

  await visitChildren(rootSessionId)
  return postOrder
}

function mapActivityToReasonCode(kind: string): SessionDeletionReasonCode {
  switch (kind) {
    case 'turn': return 'SESSION_DELETION_ACTIVE_TURN'
    case 'subagent': return 'SESSION_DELETION_ACTIVE_SUBAGENT'
    case 'job': return 'SESSION_DELETION_ACTIVE_JOB'
    case 'schedule': return 'SESSION_DELETION_ACTIVE_SCHEDULE'
    case 'live-writer': return 'SESSION_DELETION_ACTIVE_WRITER'
    default: return 'SESSION_DELETION_LIVE_SESSION_HELD'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
