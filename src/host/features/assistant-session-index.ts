import {
  filterAssistantSessions,
  type AssistantScope,
  type AssistantScopeSession,
} from './assistant-scope.js'
import type { AssistantExcludedTarget, AssistantIndexSnapshot, AssistantWaitingKind, SessionIndexEntry } from '../../shared/contracts/assistant.js'

export interface AssistantSessionSourceRecord extends AssistantScopeSession {
  readonly workspaceName: string
  readonly hostId: string
  readonly running: boolean
  readonly completed: boolean
  readonly error?: boolean
  readonly updatedAt: number | null
  readonly waiting: AssistantWaitingKind | null
  readonly title?: string | null
  /** 可选的语义标题事件，必须取最后一条。 */
  readonly titleEvents?: readonly (string | null | undefined)[]
  readonly summary?: string | null
  readonly activity?: 'running' | 'idle' | 'unknown'
  readonly sourceVersion?: number
  readonly indexedVersion?: number
}

export interface AssistantSessionIndexBuildOptions {
  readonly sessions: readonly AssistantSessionSourceRecord[]
  readonly scope: AssistantScope
  readonly archivedSessionIds: ReadonlySet<string> | readonly string[]
  readonly generation?: number
  /** 只对过滤后的会话调用；实现方应使用 readSurface 等语义读取。 */
  readonly readSummary?: (session: AssistantSessionSourceRecord) => string | null | Promise<string | null>
  /** 只对过滤后的会话调用；用于补充 SessionSummary 未提供的审批/提问状态。 */
  readonly readWaiting?: (session: AssistantSessionSourceRecord) => AssistantWaitingKind | null | Promise<AssistantWaitingKind | null>
}

export interface AssistantSessionIndexSnapshot extends AssistantIndexSnapshot {
}

/** 负责范围/归档快照变化时立即重建索引；不修改历史记录。 */
export class AssistantSessionIndexController {
  private archivedSessionIds: readonly string[]
  private generation = 0
  private snapshotValue: AssistantSessionIndexSnapshot | null = null

  constructor(
    private readonly sessions: readonly AssistantSessionSourceRecord[],
    private scope: AssistantScope,
    archivedSessionIds: readonly string[] = [],
  ) {
    this.archivedSessionIds = [...archivedSessionIds]
  }

  async refresh(): Promise<AssistantSessionIndexSnapshot> {
    this.snapshotValue = await buildAssistantSessionIndex({
      sessions: this.sessions,
      scope: this.scope,
      archivedSessionIds: this.archivedSessionIds,
      generation: ++this.generation,
    })
    return this.snapshotValue
  }

  async setScope(scope: AssistantScope): Promise<AssistantSessionIndexSnapshot> {
    this.scope = scope
    return this.refresh()
  }

  async setArchivedSessionIds(ids: readonly string[]): Promise<AssistantSessionIndexSnapshot> {
    this.archivedSessionIds = [...ids]
    return this.refresh()
  }

  snapshot(): AssistantSessionIndexSnapshot | null {
    return this.snapshotValue
  }
}

export async function buildAssistantSessionIndex(
  options: AssistantSessionIndexBuildOptions,
): Promise<AssistantSessionIndexSnapshot> {
  const filtered = filterAssistantSessions(options.sessions, options.scope, options.archivedSessionIds)
  const includedIds = new Set(filtered.sessions.map((session) => session.sessionId))
  const archivedIds = options.archivedSessionIds instanceof Set ? options.archivedSessionIds : new Set(options.archivedSessionIds)
  const excludedTargets: AssistantExcludedTarget[] = options.sessions
    .filter((session) => !includedIds.has(session.sessionId))
    .map((session) => ({
      sessionId: session.sessionId,
      title: lastSessionTitle(session.titleEvents) ?? session.title ?? null,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      hostId: session.hostId,
      archived: archivedIds.has(session.sessionId),
    }))
  let unreadableCount = 0
  const entries: SessionIndexEntry[] = []
  for (const session of filtered.sessions) {
    let summary = session.summary ?? null
    let waiting = session.waiting
    if (options.readSummary !== undefined) {
      try {
        summary = await options.readSummary(session)
      } catch {
        unreadableCount += 1
        summary = null
      }
    }
    if (options.readWaiting !== undefined) {
      try {
        // 读取器返回 null 就是权威的“当前没有等待”，用于清除旧快照状态。
        waiting = await options.readWaiting(session)
      } catch {
        // 单个会话的等待状态读取失败不应阻断其他会话索引。
      }
    }
    entries.push({
      sessionId: session.sessionId,
      title: lastSessionTitle(session.titleEvents) ?? session.title ?? null,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      hostId: session.hostId,
      ...resolveAssistantSessionState({ ...session, waiting }),
      ...(session.error === undefined ? {} : { error: session.error }),
      updatedAt: session.updatedAt,
      waiting,
      summary,
      ...(session.sourceVersion === undefined ? {} : { sourceVersion: session.sourceVersion }),
      ...(session.indexedVersion === undefined ? {} : { indexedVersion: session.indexedVersion }),
    })
  }
  return { generation: options.generation ?? 0, entries, excludedTargets, scope: filtered.state, unreadableCount }
}

/** 统一事实映射：明确 idle 表示本轮结束，明确 unknown 不能被默认布尔值覆盖。 */
export function resolveAssistantSessionState(session: Pick<SessionIndexEntry, 'activity' | 'running' | 'completed' | 'error' | 'waiting'>): Pick<SessionIndexEntry, 'activity' | 'running' | 'completed' | 'status'> {
  const activity = session.activity ?? (session.running ? 'running' : session.completed || session.error === true ? 'idle' : 'unknown')
  const running = activity === 'running'
  const completed = activity === 'idle' && session.error !== true && session.waiting === null
  const status = session.waiting !== null ? 'waiting' : session.error === true ? 'error' : running ? 'running' : completed ? 'completed' : 'unknown'
  return { activity, running, completed, status }
}

/** 最后一条有效 session/title 事件胜出；暂态空值不覆盖已有标题。 */
export function lastSessionTitle(events: readonly (string | null | undefined)[] | undefined): string | null {
  if (events === undefined) return null
  let title: string | null = null
  for (const value of events) {
    if (typeof value === 'string' && value.trim() !== '') title = value
  }
  return title
}
