import type { HostScope } from '../../../shared/contracts/peer-host.js'
import type { AggregateSessionSource, AggregateWorkspaceSource, PeerHostWorkspaceSessionSummarySource } from './peer-host-aggregate-service.js'

/**
 * 通过 PeerHost 原生 Remote 通道读取目标 Host 的 workspace/session 摘要。
 *
 * DSH 没有 workspace 列表的 REST 或 Remote 方法：`workspace/follow` 的首帧
 * baseline 就是完整的工作区投影（含每个工作区的 sessionIds），会话元数据
 * 则由 `session/list` 提供。代理层不能凭空假设 `/api/workspaces` 之类的路径。
 */
export interface PeerHostRemoteSummaryTransport {
  rpc(request: { readonly scope: HostScope; readonly method: 'session/list'; readonly payload?: unknown; readonly signal?: AbortSignal }): Promise<unknown>
  stream(request: { readonly scope: HostScope; readonly method: 'workspace/follow'; readonly payload?: unknown; readonly signal?: AbortSignal }): AsyncIterable<unknown>
}

interface WorkspaceBaseline {
  readonly items: readonly unknown[]
  readonly archivedSessionIds: readonly string[]
}

export function createPeerHostRemoteSummarySource(input: {
  readonly transport: PeerHostRemoteSummaryTransport
  readonly scope: HostScope
}): PeerHostWorkspaceSessionSummarySource {
  return {
    capabilityId: 'peer-host.native-workspace-session-summary',
    available: true,
    async load(signal) {
      const [baseline, sessions] = await Promise.all([
        readWorkspaceBaseline(input.transport, input.scope, signal),
        readSessionList(input.transport, input.scope, signal),
      ])
      return buildRemoteSummary(baseline, sessions)
    },
  }
}

async function readWorkspaceBaseline(transport: PeerHostRemoteSummaryTransport, scope: HostScope, signal: AbortSignal | undefined): Promise<WorkspaceBaseline> {
  // baseline 之后是长期增量流；摘要只需要首帧，取值后立即 return 关闭流。
  for await (const frame of transport.stream({ scope, method: 'workspace/follow', ...(signal === undefined ? {} : { signal }) })) {
    const frameRecord = asRecord(frame)
    if (frameRecord?.type !== undefined && frameRecord.type !== 'baseline') continue
    const value = asRecord(frameRecord?.value)
    if (value === null) continue
    return {
      items: Array.isArray(value.items) ? value.items : [],
      archivedSessionIds: readStringList(value.archivedSessionIds),
    }
  }
  return { items: [], archivedSessionIds: [] }
}

async function readSessionList(transport: PeerHostRemoteSummaryTransport, scope: HostScope, signal: AbortSignal | undefined): Promise<readonly Record<string, unknown>[]> {
  // DSH Remote 的线上载荷按 descriptor 的 wire 名组织；session/list 的参数 wire 是 `_request`。
  const value = asRecord(await transport.rpc({ scope, method: 'session/list', payload: { args: { _request: {} } }, ...(signal === undefined ? {} : { signal }) }))
  if (value === null || !Array.isArray(value.items)) return []
  return value.items.flatMap((item) => {
    const record = asRecord(item)
    return record === null ? [] : [record]
  })
}

function buildRemoteSummary(baseline: WorkspaceBaseline, sessions: readonly Record<string, unknown>[]): readonly AggregateWorkspaceSource[] {
  const sessionsById = new Map<string, Record<string, unknown>>()
  for (const session of sessions) {
    const sessionId = readString(session, ['sessionId', 'id', 'key'])
    if (sessionId !== null && !sessionsById.has(sessionId)) sessionsById.set(sessionId, session)
  }
  const archived = new Set(baseline.archivedSessionIds)
  return baseline.items.flatMap((raw) => {
    const value = asRecord(raw)
    const workspaceId = readString(value, ['workspaceId', 'id', 'key'])
    if (workspaceId === null) return []
    const visible: AggregateSessionSource[] = []
    const archivedSessions: AggregateSessionSource[] = []
    for (const sessionId of readStringList(value?.sessionIds)) {
      const session = sessionsById.get(sessionId) ?? null
      // 子代理会话在可见与归档两侧都不出现在宿主侧栏。
      if (readString(session, ['origin']) === 'subagent') continue
      const entry: AggregateSessionSource = {
        sessionId,
        title: readSessionTitle(session, sessionId),
        status: session?.running === true ? 'running' : 'idle',
        updatedAt: readTime(session),
      }
      if (archived.has(sessionId)) archivedSessions.push(entry)
      else visible.push(entry)
    }
    return [{
      workspaceId,
      displayName: readString(value, ['title', 'displayName', 'name']) ?? workspaceId,
      // 原生文件面板按工作区路径解析，远端摘要必须携带真实路径而不是 workspaceId。
      path: readString(value, ['path']) ?? workspaceId,
      sessions: visible,
      ...(archivedSessions.length === 0 ? {} : { archivedSessions }),
    }]
  })
}

function readSessionTitle(session: Record<string, unknown> | null, sessionId: string): string {
  // session/list 把持久标题放在 projections.values.title；没有投影时退回目录名。
  const projected = readString(asRecord(asRecord(session?.projections)?.values), ['title'])
  if (projected !== null) return projected
  const cwd = readString(session, ['cwd'])
  if (cwd === null) return sessionId
  const name = directoryName(cwd)
  return name === '' ? sessionId : name
}

function directoryName(path: string): string {
  const segments = path.split(/[\\/]+/u).filter((segment) => segment !== '')
  return segments.at(-1) ?? ''
}

function readStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => typeof item === 'string' && item.trim() !== '' ? [item.trim()] : [])
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readString(value: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (value === null) return null
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

function readTime(value: Record<string, unknown> | null): number {
  if (value === null) return 0
  const candidate = value.updatedAt
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0
}
