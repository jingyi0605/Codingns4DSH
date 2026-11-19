import { WorkspaceMcpHandlerError } from './file-handler.js'
import { MCP_MESSAGE_PREFIX } from './message-queue-handler.js'

export const DEFAULT_HISTORY_LIMIT = 20
export const MAX_HISTORY_LIMIT = 100
export const DEFAULT_SEARCH_LIMIT = 10
/** DSH returns at most this many sessions per search, so a larger limit could never be filled. */
export const MAX_SEARCH_LIMIT = 20
export const MAX_SEARCH_QUERY_LENGTH = 256

const MESSAGE_TEXT_BYTES = 8 * 1024
const RESPONSE_TEXT_BYTES = 256 * 1024
const SNIPPET_BYTES = 1024
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export type SessionHistoryReader = (request: { readonly sessionId: string; readonly beforeSeq?: number; readonly maxMessages: number }, signal: AbortSignal) => Promise<unknown>
export type SessionSearcher = (query: string, signal: AbortSignal) => Promise<unknown>

interface HistoryMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time?: number
  readonly truncated?: true
  readonly sourceKind?: string
  readonly agentId?: string
}

/**
 * Reads one page of a session's visible conversation, newest page first.
 * The caller has already proven that the session belongs to a managed workspace.
 */
export async function readSessionHistory(
  read: SessionHistoryReader,
  request: {
    readonly sessionId: string
    readonly workspaceId: string
    readonly limit: number
    readonly cursor?: number
    /** Resolves the Agent that sent a message by its MCP receipt ID. */
    readonly agentOf?: (messageId: string) => Promise<string | undefined>
  },
  signal: AbortSignal,
): Promise<unknown> {
  let response: unknown
  try {
    response = await read({ sessionId: request.sessionId, ...(request.cursor === undefined ? {} : { beforeSeq: request.cursor }), maxMessages: request.limit }, signal)
  } catch {
    if (signal.aborted) throw signal.reason
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_SESSION_HISTORY_UNAVAILABLE', 'DSH could not read the session history.')
  }
  const page = asRecord(response)
  if (!Array.isArray(page?.records)) throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_SESSION_HISTORY_UNAVAILABLE', 'DSH did not return session history.')

  const seen = new Set<number>()
  let lowestSeq: number | undefined
  let omitted = 0
  const found: Array<HistoryMessage & { readonly rpcId?: string }> = []
  for (const raw of page.records) {
    const event = asRecord(asRecord(raw)?.event)
    const seq = event?.seq
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seen.has(seq)) continue
    seen.add(seq)
    lowestSeq = lowestSeq === undefined ? seq : Math.min(lowestSeq, seq)
    const role = event?.type === 'user/message' ? 'user' : event?.type === 'assistant/message' ? 'assistant' : undefined
    if (role === undefined) continue
    const data = asRecord(event?.data)
    const message = asRecord(data?.message) ?? data
    const text = readMessageText(message?.content)
    if (text === '') { omitted += 1; continue }
    const clipped = truncateUtf8(text, MESSAGE_TEXT_BYTES)
    const source = asRecord(message?.source)
    const sourceKind = typeof source?.kind === 'string' && source.kind.length <= 64 ? source.kind : undefined
    const rpcId = typeof source?.rpcId === 'string' && source.rpcId.startsWith(MCP_MESSAGE_PREFIX) && source.rpcId.length <= 256 ? source.rpcId : undefined
    found.push({
      seq, role, text: clipped.text,
      ...(typeof event?.time === 'number' && Number.isFinite(event.time) ? { time: event.time } : {}),
      ...(clipped.truncated ? { truncated: true as const } : {}),
      ...(sourceKind === undefined ? {} : { sourceKind }),
      ...(rpcId === undefined ? {} : { rpcId }),
    })
  }
  found.sort((left, right) => left.seq - right.seq)

  // Keep the newest messages inside the response budget; older ones stay reachable through the cursor.
  // The newest message is always returned, even when it alone fills the budget.
  let firstVisible = found.length
  let bytes = 0
  while (firstVisible > 0) {
    const size = Buffer.byteLength(found[firstVisible - 1]!.text)
    if (bytes + size > RESPONSE_TEXT_BYTES && firstVisible < found.length) break
    bytes += size
    firstVisible -= 1
  }
  const dropped = firstVisible
  const visible = found.slice(firstVisible)

  const messages: HistoryMessage[] = await Promise.all(visible.map(async ({ rpcId, ...message }) => {
    if (rpcId === undefined || request.agentOf === undefined) return message
    try {
      const agentId = await request.agentOf(rpcId)
      return agentId === undefined ? message : { ...message, agentId }
    } catch { return message }
  }))

  const hasMore = dropped > 0 || page.hasMore === true
  const nextCursor = dropped > 0 ? visible[0]?.seq : (page.hasMore === true ? lowestSeq : undefined)
  return {
    sessionId: request.sessionId,
    workspaceId: request.workspaceId,
    messages,
    limit: request.limit,
    hasMore: hasMore && nextCursor !== undefined,
    ...(hasMore && nextCursor !== undefined ? { nextCursor } : {}),
    ...(omitted > 0 ? { omittedWithoutText: omitted } : {}),
  }
}

/**
 * Searches session content and keeps only sessions inside managed workspaces.
 * DSH applies its own result cap before this filter runs, so `hasMore` can be true
 * even when fewer results than `limit` are returned; a narrower query helps.
 */
export async function searchSessions(
  search: SessionSearcher,
  request: {
    readonly query: string
    readonly limit: number
    readonly workspaceId?: string
    /** Returns the owning managed workspace, or undefined for any session outside the managed scope. */
    readonly workspaceOf: (sessionId: string) => string | undefined
  },
  signal: AbortSignal,
): Promise<unknown> {
  let response: unknown
  try { response = await search(request.query, signal) } catch (error) {
    if (signal.aborted) throw signal.reason
    // DSH's Web deployment ships with full-text search off. Say so, because retrying cannot help.
    // Only this recognised condition is described; other failure text is never forwarded.
    if (isSearchNotEnabled(error)) {
      throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_SESSION_SEARCH_DISABLED', 'Session search is not enabled in this DSH deployment. The Host owner must turn on the session-query index (openAt: first-search or startup); retrying will not help.')
    }
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_SESSION_SEARCH_UNAVAILABLE', 'DSH could not search sessions.')
  }
  const value = asRecord(response)
  if (!Array.isArray(value?.items)) throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_SESSION_SEARCH_UNAVAILABLE', 'DSH did not return search results.')
  const seen = new Set<string>()
  const results: Array<{ sessionId: string; workspaceId: string; snippet: string }> = []
  for (const raw of value.items) {
    const item = asRecord(raw)
    const sessionId = typeof item?.sessionId === 'string' ? item.sessionId.trim() : ''
    if (!SESSION_ID.test(sessionId) || seen.has(sessionId)) continue
    seen.add(sessionId)
    const workspaceId = request.workspaceOf(sessionId)
    if (workspaceId === undefined || (request.workspaceId !== undefined && workspaceId !== request.workspaceId)) continue
    results.push({ sessionId, workspaceId, snippet: truncateUtf8(typeof item?.snippet === 'string' ? item.snippet : '', SNIPPET_BYTES).text })
  }
  return {
    results: results.slice(0, request.limit),
    limit: request.limit,
    hasMore: results.length > request.limit || value.hasMore === true,
  }
}

/** True when DSH reports search as configured off (`openAt: never`) or the query service is not mounted. */
function isSearchNotEnabled(error: unknown): boolean {
  const record = asRecord(error)
  if (record?.code === 'SESSION_QUERY_SEARCH_DISABLED') return true
  const message = error instanceof Error ? error.message : typeof record?.message === 'string' ? record.message : ''
  return message.includes('session search is disabled') || message.includes('session search is unavailable: this deployment does not mount')
}

function readMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    const row = asRecord(block)
    return row?.type === 'text' && typeof row.text === 'string' ? [row.text] : []
  }).join('')
}

function truncateUtf8(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  let out = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char)
    if (bytes + size > maxBytes) break
    out += char
    bytes += size
  }
  return { text: out, truncated: true }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
