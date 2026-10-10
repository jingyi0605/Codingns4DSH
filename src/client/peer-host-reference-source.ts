import type { Context } from '@deepseek-ai/cordis'
import { parseVirtualSessionId, parseVirtualWorkspaceId } from '../shared/contracts/peer-host.js'
import type { PeerHostVirtualSessionSummary } from './peer-host-native-projection.js'
import { formatSessionReferenceMention } from '../shared/session-reference.js'

const PEER_HOST_REFERENCE_SOURCE = 'codingns-peer-host-reference'
const PEER_HOST_SESSION_SECTION = '对话'

interface InputTriggerCandidate {
  readonly name: string
  readonly description?: string
  readonly icon?: 'session'
  readonly section?: string
  readonly value?: string
}

interface InputTriggerSource {
  readonly trigger: '@'
  readonly name: string
  readonly showGroupTitle?: boolean
  candidates(session: { readonly sessionId: string }, request: { readonly query: string; readonly signal: AbortSignal }): Promise<readonly InputTriggerCandidate[]>
  onPick(pick: { readonly candidate: { readonly name: string; readonly label?: string; readonly value?: string } }): { readonly insert: {
    readonly source: 'reference'
    readonly ref: string
    readonly label: string
    readonly appearance: 'session'
    readonly clipboardText: string
  } }
  readonly codec: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
}

interface InputTriggersService {
  registerSource(source: InputTriggerSource): () => void
}

interface SessionsService {
  binding(id: string): unknown
}

interface SessionReferenceResolver {
  candidates(sessionId: string, query: string, signal: AbortSignal): Promise<unknown>
}

interface UiWorkspaceService {
  readonly selection?: {
    getSnapshot(): unknown
  }
}

interface PeerHostReferenceProjection {
  hasAggregate(): boolean
  sessions(): readonly PeerHostVirtualSessionSummary[]
}

/**
 * 注册远程会话引用兜底源。
 *
 * DSH 官方 `ui-reference` 在 `sessions.using()` 或目标 Host 的
 * `sessionReferenceResolver` 失败时会把来源标记为 failed，并且不再显示任何
 * 会话项。PeerHost 已经拥有完整的远程 Session 摘要，这里只在远程虚拟会话上
 * 兜底；官方候选正常返回时不重复渲染，目标 Host 不支持该 Remote 时仍可引用。
 */
export function registerPeerHostReferenceSource(
  ctx: Context,
  projection: PeerHostReferenceProjection,
): () => void {
  let inputTriggers: InputTriggersService | undefined
  let sessions: SessionsService | undefined
  let resolver: SessionReferenceResolver | undefined
  let uiWorkspace: UiWorkspaceService | undefined
  try {
    inputTriggers = ctx.get('inputTriggers') as InputTriggersService
    sessions = ctx.get('sessions') as SessionsService
  } catch {
    return () => undefined
  }
  try {
    resolver = ctx.get('remote.sessionReferenceResolver') as SessionReferenceResolver
  } catch {
    // 旧版 DSH 没有该 Remote 时直接使用本机已聚合的远程摘要。
    resolver = undefined
  }
  try {
    uiWorkspace = ctx.get('uiWorkspace') as UiWorkspaceService
  } catch {
    // 旧版 DSH 没有原生导航服务时仍可依赖虚拟 SessionId 判断 Host。
    uiWorkspace = undefined
  }
  if (typeof inputTriggers?.registerSource !== 'function') return () => undefined

  const source: InputTriggerSource = {
    trigger: '@',
    name: PEER_HOST_REFERENCE_SOURCE,
    showGroupTitle: false,
    async candidates(session, request) {
      const current = parseVirtualSessionId(session.sessionId)
      const currentHostId = current?.hostId ?? readSelectedRemoteHost(uiWorkspace, session.sessionId)
      if (currentHostId === undefined || !projection.hasAggregate()) return []
      request.signal.throwIfAborted()
      let remoteResult: readonly RemoteReferenceCandidate[] | undefined
      let resolverFailed = false
      // 只有虚拟 ID 能被页面 Transport 直接路由；旧导航保留真实 ID 时直接
      // 使用投影摘要，避免把请求错误地发给本机 Host。
      if (current !== null && typeof resolver?.candidates === 'function') {
        try {
          remoteResult = await readRemoteCandidates(resolver.candidates(session.sessionId, request.query, request.signal))
        } catch {
          resolverFailed = true
        }
      } else {
        resolverFailed = true
      }
      request.signal.throwIfAborted()
      // 官方来源与这里都会调用同一个 Resolver；只有确实拿到非空候选时才让
      // 官方来源负责渲染。空数组和 `{ ok: false }` 都不能阻止摘要兜底，否则
      // 现有会话会被“请求成功但没有候选”的结果静默吞掉。
      if (current !== null && !resolverFailed && remoteResult !== undefined && remoteResult.length > 0 && sessions?.binding(session.sessionId) !== undefined) return []
      if (!resolverFailed && remoteResult !== undefined && remoteResult.length > 0) {
        return remoteResult
          .filter((candidate) => candidate.sessionId !== session.sessionId)
          .map(remoteCandidate)
      }
      return projection.sessions()
        .filter((item) => parseVirtualSessionId(item.sessionId)?.hostId === currentHostId)
        .filter((item) => !isCurrentSession(item.sessionId, session.sessionId))
        .map((item) => projectionCandidate(item, request.query))
        .filter((item): item is InputTriggerCandidate => item !== undefined)
    },
    onPick(pick) {
      const ref = pick.candidate.value ?? pick.candidate.name
      const label = pick.candidate.label?.trim() || pick.candidate.name
      return { insert: { source: 'reference', ref, label, appearance: 'session', clipboardText: ref } }
    },
    codec: {
      clipboardText: (ref) => ref,
      serialize: async (ref) => ref,
    },
  }
  return inputTriggers.registerSource(source)
}

function isCurrentSession(projectedSessionId: string, currentSessionId: string): boolean {
  if (projectedSessionId === currentSessionId) return true
  return parseVirtualSessionId(projectedSessionId)?.sessionId === currentSessionId
}

interface RemoteReferenceCandidate {
  readonly sessionId: string
  readonly mention: string
  readonly label: string
  readonly displayTitle?: string
  readonly cwd?: string
  readonly createdAt?: number
  readonly sameWorkspace?: boolean
}

async function readRemoteCandidates(value: Promise<unknown>): Promise<readonly RemoteReferenceCandidate[]> {
  const result = await value
  if (Array.isArray(result)) return result.flatMap(asRemoteCandidate)
  const record = asRecord(result)
  if (record?.ok === true && Array.isArray(record.value)) return record.value.flatMap(asRemoteCandidate)
  const nested = asRecord(record?.ok === true ? record.value : undefined)
  if (Array.isArray(nested?.candidates)) return nested.candidates.flatMap(asRemoteCandidate)
  if (Array.isArray(record?.candidates)) return record.candidates.flatMap(asRemoteCandidate)
  return []
}

function asRemoteCandidate(value: unknown): RemoteReferenceCandidate[] {
  const record = asRecord(value)
  if (record === null || typeof record.sessionId !== 'string' || typeof record.mention !== 'string' || typeof record.label !== 'string') return []
  return [{
    sessionId: record.sessionId,
    mention: record.mention,
    label: record.label,
    ...(typeof record.displayTitle === 'string' ? { displayTitle: record.displayTitle } : {}),
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    ...(typeof record.createdAt === 'number' ? { createdAt: record.createdAt } : {}),
    ...(typeof record.sameWorkspace === 'boolean' ? { sameWorkspace: record.sameWorkspace } : {}),
  }]
}

function remoteCandidate(candidate: RemoteReferenceCandidate): InputTriggerCandidate {
  const label = candidate.displayTitle?.trim() || candidate.label.trim() || candidate.sessionId
  return {
    name: label,
    ...(candidate.cwd === undefined ? {} : { description: candidate.cwd }),
    icon: 'session',
    section: PEER_HOST_SESSION_SECTION,
    value: candidate.mention,
  }
}

function projectionCandidate(session: PeerHostVirtualSessionSummary, query: string): InputTriggerCandidate | undefined {
  const title = session.projections.values.title?.trim() || (session.blank ? '新会话' : session.sessionId)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searchable = `${title}\n${session.cwd ?? ''}\n${session.sessionId}`.toLocaleLowerCase()
  if (normalizedQuery !== '' && !searchable.includes(normalizedQuery)) return undefined
  return {
    name: title,
    ...(session.cwd === undefined ? {} : { description: session.cwd }),
    icon: 'session',
    section: PEER_HOST_SESSION_SECTION,
    value: formatSessionReferenceMention(title, session.sessionId),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readSelectedRemoteHost(service: UiWorkspaceService | undefined, sessionId: string): string | undefined {
  const selection = service?.selection?.getSnapshot()
  const record = asRecord(selection)
  if (record === null) return undefined
  const selectedSessionId = typeof record.sessionId === 'string'
    ? record.sessionId
    : asRecord(record.subagentAddress)?.parentSessionId
  if (selectedSessionId !== undefined && selectedSessionId !== sessionId) return undefined
  const workspaceId = record.workspaceId
  if (typeof workspaceId !== 'string') return undefined
  return parseVirtualWorkspaceId(workspaceId)?.targetHostId ?? undefined
}
