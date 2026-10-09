import type { HostScope, PeerHostSessionTitleProjection } from '../../../shared/contracts/peer-host.js'
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
  /** 读取目标 Host 的 CodingNS 私有摘要；失败时只丢失适配器标签，不影响会话导航。 */
  cli?(request: { readonly scope: HostScope; readonly endpoint: 'cli/session/adapter-map'; readonly payload?: unknown; readonly signal?: AbortSignal }): Promise<unknown>
}

interface WorkspaceBaseline {
  readonly items: readonly unknown[]
  readonly archivedSessionIds: readonly string[]
}

export function createPeerHostRemoteSummarySource(input: {
  readonly transport: PeerHostRemoteSummaryTransport
  readonly scope: HostScope
  /**
   * 允许投影到侧栏的远端工作区 ID；缺省表示不过滤（仅测试与显式调用方使用）。
   *
   * 传空数组表示"用户尚未显式添加任何远端工作区"，此时返回空摘要且不访问目标
   * Host——这是默认行为，不是降级，也不应伪装成远端没有工作区。
   */
  readonly visibleWorkspaceIds?: readonly string[]
}): PeerHostWorkspaceSessionSummarySource {
  const visible = input.visibleWorkspaceIds === undefined ? null : new Set(input.visibleWorkspaceIds)
  return {
    capabilityId: 'peer-host.native-workspace-session-summary',
    available: true,
    async load(signal) {
      // 没有可见工作区时不必访问目标 Host：省一次代理往返，也避免把"没有可见
      // 工作区"和"远端不可达"混成同一个错误。
      if (visible !== null && visible.size === 0) return []
      const [baseline, sessions, adapterMap] = await Promise.all([
        readWorkspaceBaseline(input.transport, input.scope, signal),
        // 工作区可见性不依赖会话元数据。目标 DSH 的 session/list 协议或启动时序
        // 异常时仍要保留工作区行，否则一次会话读取失败会把整个远端 Host 变成空列表。
        readSessionList(input.transport, input.scope, signal).catch((error: unknown) => {
          // 协议不支持仍使用成员占位；明确的网络或认证故障要让缓存接管，不能
          // 用占位 ID 覆盖上一次成功获取的会话标题与元数据。
          const code = asRecord(error)?.code
          if (typeof code === 'string' && ['PEER_HOST_PROXY_UNREACHABLE', 'PEER_HOST_UNREACHABLE', 'PEER_HOST_NOT_READY', 'PEER_HOST_SESSION_REQUIRED'].includes(code)) throw error
          if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error
          return []
        }),
        readAdapterMap(input.transport, input.scope, signal),
      ])
      return buildRemoteSummary(baseline, sessions, visible, adapterMap)
    },
  }
}

/** 供"添加工作区"选择器使用的远端工作区候选；不过滤，也不含会话正文。 */
export interface PeerHostRemoteWorkspaceCandidate {
  readonly workspaceId: string
  readonly displayName: string
  readonly path: string
  readonly sessionCount: number
}

/**
 * 读取远端 Host 已登记的全部工作区。
 *
 * 与摘要不同，这里**刻意不做可见性过滤**：选择器必须先看到全部候选，用户才能
 * 决定要显式添加哪些。返回值不含会话正文、标题或凭据。
 */
export async function readPeerHostRemoteWorkspaceCandidates(input: {
  readonly transport: PeerHostRemoteSummaryTransport
  readonly scope: HostScope
  readonly signal?: AbortSignal
}): Promise<readonly PeerHostRemoteWorkspaceCandidate[]> {
  const baseline = await readWorkspaceBaseline(input.transport, input.scope, input.signal)
  return baseline.items.flatMap((raw) => {
    const value = asRecord(raw)
    const workspaceId = readString(value, ['workspaceId', 'id', 'key'])
    if (workspaceId === null) return []
    return [{
      workspaceId,
      displayName: readString(value, ['title', 'displayName', 'name']) ?? workspaceId,
      path: readString(value, ['path']) ?? workspaceId,
      sessionCount: readStringList(value?.sessionIds).length,
    }]
  })
}

async function readWorkspaceBaseline(transport: PeerHostRemoteSummaryTransport, scope: HostScope, signal: AbortSignal | undefined): Promise<WorkspaceBaseline> {
  // baseline 之后是长期增量流；摘要只需要首帧，取值后立即 return 关闭流。
  for await (const frame of transport.stream({ scope, method: 'workspace/follow', ...(signal === undefined ? {} : { signal }) })) {
    const frameRecord = asRecord(frame)
    if (frameRecord?.type !== undefined && frameRecord.type !== 'baseline') continue
    const value = asRecord(frameRecord?.value)
    if (value === null) continue
    if (!Array.isArray(value.items)) throw new Error('远端工作区 baseline 缺少 items')
    return {
      items: value.items,
      archivedSessionIds: readStringList(value.archivedSessionIds),
    }
  }
  // 流在 baseline 前断开不代表远端没有工作区，否则会用假空列表覆盖断线缓存。
  throw new Error('远端工作区流在 baseline 前结束')
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

function buildRemoteSummary(
  baseline: WorkspaceBaseline,
  sessions: readonly Record<string, unknown>[],
  visibleWorkspaceIds: ReadonlySet<string> | null,
  adapterMap: ReadonlyMap<string, string>,
): readonly AggregateWorkspaceSource[] {
  const sessionsById = new Map<string, Record<string, unknown>>()
  for (const session of sessions) {
    const sessionId = readString(session, ['sessionId', 'id', 'key'])
    if (sessionId !== null && !sessionsById.has(sessionId)) sessionsById.set(sessionId, session)
  }
  const archived = new Set(baseline.archivedSessionIds)
  // 子会话通常不在 workspace.sessionIds 中，用原生父会话关系补全后代。
  const childrenByParent = new Map<string, string[]>()
  for (const [sessionId, session] of sessionsById) {
    if (session.origin !== 'subagent') continue
    const parentId = readString(session, ['parentSessionId'])
    if (parentId === null) continue
    const children = childrenByParent.get(parentId) ?? []
    children.push(sessionId)
    childrenByParent.set(parentId, children)
  }
  return baseline.items.flatMap((raw) => {
    const value = asRecord(raw)
    const workspaceId = readString(value, ['workspaceId', 'id', 'key'])
    if (workspaceId === null) return []
    // 默认只投影用户显式添加的远端工作区；未在集合内的远端工作区不进入导航。
    if (visibleWorkspaceIds !== null && !visibleWorkspaceIds.has(workspaceId)) return []
    const visible: AggregateSessionSource[] = []
    const archivedSessions: AggregateSessionSource[] = []
    const subagentSessions: AggregateSessionSource[] = []
    for (const sessionId of collectWorkspaceSessionIds(readStringList(value?.sessionIds), childrenByParent)) {
      const session = sessionsById.get(sessionId) ?? null
      const entry = toRemoteSessionSource(sessionId, session, adapterMap)
      if (session?.origin === 'subagent') subagentSessions.push(entry)
      else if (archived.has(sessionId)) archivedSessions.push(entry)
      else visible.push(entry)
    }
    return [{
      workspaceId,
      displayName: readString(value, ['title', 'displayName', 'name']) ?? workspaceId,
      // 原生文件面板按工作区路径解析，远端摘要必须携带真实路径而不是 workspaceId。
      path: readString(value, ['path']) ?? workspaceId,
      sessions: visible,
      ...(archivedSessions.length === 0 ? {} : { archivedSessions }),
      ...(subagentSessions.length === 0 ? {} : { subagentSessions }),
    }]
  })
}

/** 原生行只摘取摘要元数据，普通会话与子会话共用同一个投影入口。 */
function toRemoteSessionSource(sessionId: string, session: Record<string, unknown> | null, adapterMap: ReadonlyMap<string, string>): AggregateSessionSource {
  const titleProjection = readSessionTitleProjection(session)
  const adapterId = readString(session, ['adapterId']) ?? adapterMap.get(sessionId)
  const parentSessionId = readString(session, ['parentSessionId'])
  return {
    sessionId,
    blank: session?.blank === true,
    title: readSessionTitle(session, sessionId),
    ...(titleProjection === undefined ? {} : { titleProjection }),
    status: readRemoteSessionStatus(session),
    activity: readRemoteSessionActivity(session),
    updatedAt: readTime(session),
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(session?.origin === 'subagent' ? { origin: 'subagent' } : {}),
    ...(parentSessionId === null ? {} : { parentSessionId }),
  }
}

/** 按父子索引遍历可见工作区的后代；Set 同时防止异常循环与重复成员。 */
function collectWorkspaceSessionIds(roots: readonly string[], childrenByParent: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const ids = new Set(roots)
  for (const id of ids) for (const child of childrenByParent.get(id) ?? []) ids.add(child)
  return [...ids]
}

function readRemoteSessionStatus(session: Record<string, unknown> | null): string {
  if (session === null) return 'idle'
  const explicit = readString(session, ['status', 'state'])
  if (explicit !== null) return explicit
  if (session.error === true || session.failed === true) return 'error'
  if (session.completed === true || session.done === true) return 'completed'
  if (session.running === true || session.active === true) return 'running'
  return 'idle'
}

/** 导航可以保留默认 idle，自动索引必须有明确的空闲证明。 */
function readRemoteSessionActivity(session: Record<string, unknown> | null): 'running' | 'idle' | 'unknown' {
  if (session === null) return 'unknown'
  const status = readString(session, ['status', 'state'])
  if (session.running === true || session.active === true || status !== null && /running|active|working|queued/u.test(status)) return 'running'
  if (session.running === false || session.completed === true || session.done === true || status !== null && /idle|completed|complete|done|success|error|failed/u.test(status)) return 'idle'
  return 'unknown'
}

async function readAdapterMap(
  transport: PeerHostRemoteSummaryTransport,
  scope: HostScope,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, string>> {
  if (transport.cli === undefined) return new Map()
  try {
    const value = await transport.cli({ scope, endpoint: 'cli/session/adapter-map', payload: {}, ...(signal === undefined ? {} : { signal }) })
    const envelope = asRecord(value)
    const rows = envelope?.ok === true ? envelope.value : value
    if (!Array.isArray(rows)) return new Map()
    const result = new Map<string, string>()
    for (const row of rows) {
      const record = asRecord(row)
      const sessionId = readString(record, ['sessionId'])
      const adapterId = readString(record, ['adapterId'])
      if (sessionId !== null && adapterId !== null) result.set(sessionId, adapterId)
    }
    return result
  } catch {
    return new Map()
  }
}

/**
 * session/list 的实时投影与 session/follow 使用同一序号空间，必须保留其来源。
 * 只摘取 title，不能把摘要接口扩展成会话内容通道；null 也是真实投影值。
 */
function readSessionTitleProjection(session: Record<string, unknown> | null): PeerHostSessionTitleProjection | undefined {
  const block = asRecord(session?.projections)
  const title = asRecord(block?.values)?.title
  if (block?.kind !== 'cached' && block?.kind !== 'sequenced') return undefined
  if (typeof block.asOfSeq !== 'number' || !Number.isSafeInteger(block.asOfSeq)) return undefined
  if (typeof title !== 'string' && title !== null) return undefined
  return { kind: block.kind, asOfSeq: block.asOfSeq, values: { title } }
}

function readSessionTitle(session: Record<string, unknown> | null, sessionId: string): string {
  // 空白会话的标题由 DSH 原生 UI 显示为“新会话”，不能用 cwd 伪造正式标题。
  if (session?.blank === true) return ''
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
