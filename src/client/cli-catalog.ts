import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliModel,
  CodingNsCliModelCatalog,
  CodingNsCliSessionRecord,
} from '../shared/contracts/cli-adapter.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'

/** Client 侧访问 Host CLI 命名空间的统一入口。 */
export async function callCliRpc<T>(rpc: CodingNsRpcClient, action: string, payload: unknown): Promise<T> {
  let response
  try {
    response = await rpc.call(CODINGNS_RPC_CHANNEL, `cli/${action}`, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/HTTP (?:404|405)\b/u.test(message)) throw error
    response = await rpc.call('/api', `codingns/cli/${action}`, payload)
  }
  if (!response.ok) throw new Error(response.error.message)
  return response.value as T
}

export function adapterCatalogWithDsh(catalog: readonly CodingNsCliAdapterDescriptor[]): CodingNsCliAdapterDescriptor[] {
  return [{ id: 'dsh', name: 'DeepSeek Harness', installed: true, enabled: true, version: null, command: null }, ...catalog]
}

export function firstModel(catalog: CodingNsCliModelCatalog): CodingNsCliModel | undefined {
  for (const group of catalog.groups) {
    const model = group.models[0]
    if (model !== undefined) return model
  }
  return undefined
}

export function findModel(catalog: CodingNsCliModelCatalog, modelId: string | undefined): CodingNsCliModel | undefined {
  if (modelId === undefined) return undefined
  for (const group of catalog.groups) {
    const model = group.models.find((item) => item.id === modelId)
    if (model !== undefined) return model
  }
  return undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读取 Host 持久化的外部会话索引；兼容数组和带 items/sessions 的响应包装。 */
export async function listCliSessions(
  rpc: CodingNsRpcClient,
  options: { readonly includeArchived?: boolean; readonly adapterId?: string } = {},
): Promise<readonly CodingNsCliSessionRecord[]> {
  const value = await callCliRpc<unknown>(rpc, 'session/list', options)
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : isRecord(value) && Array.isArray(value.sessions)
        ? value.sessions
        : []
  return rows.filter(isCliSessionRecord).map(redactCliSessionRecord)
}

/** 把已存在的 DSH 会话恢复到原生会话页面；插件不接管消息列表。 */
export async function restoreCliSession(
  rpc: CodingNsRpcClient,
  record: CodingNsCliSessionRecord,
): Promise<void> {
  await callCliRpc(rpc, 'session/set', {
    sessionId: record.dshSessionId,
    adapterId: record.adapterId,
    ...(record.modelId ? { modelId: record.modelId } : {}),
    ...(record.effortId ? { effortId: record.effortId } : {}),
    ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
  })
  navigateToDshSession(record.dshSessionId)
}

/** 通过 Host 同步归档 DSH 原生会话和 CodingNS 外部会话索引。 */
export async function archiveCliSession(
  rpc: CodingNsRpcClient,
  sessionId: string,
): Promise<void> {
  await callCliRpc(rpc, 'session/archive', { sessionId })
}

/**
 * 使用 DSH 当前的会话路由，而不是在插件中复制会话消息组件。
 * 旧版 DSH 使用 `/sessions/:id`，新版 workspace 页面使用同一路径的 workspace 前缀，
 * 因此保留当前 workspace 段并只替换 session id。
 */
export function navigateToDshSession(sessionId: string): void {
  if (typeof window === 'undefined' || sessionId.trim() === '') return
  const encoded = encodeURIComponent(sessionId.trim())
  const pathname = window.location.pathname
  const nextPath = /^(\/workspaces\/[^/]+\/sessions\/)[^/]+(?:\/.*)?$/u.test(pathname)
    ? pathname.replace(/^(\/workspaces\/[^/]+\/sessions\/)[^/]+(?:\/.*)?$/u, `$1${encoded}`)
    : /^\/sessions\/[^/]+(?:\/.*)?$/u.test(pathname)
      ? pathname.replace(/^\/sessions\/[^/]+(?:\/.*)?$/u, `/sessions/${encoded}`)
      : `/sessions/${encoded}`
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === `${nextPath}${window.location.search}${window.location.hash}`) return
  window.history.pushState({}, '', nextPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function isCliSessionRecord(value: unknown): value is CodingNsCliSessionRecord {
  if (!isRecord(value)) return false
  return typeof value.dshSessionId === 'string'
    && value.dshSessionId.trim() !== ''
    && typeof value.adapterId === 'string'
    && value.adapterId.trim() !== ''
    && (value.status === 'active' || value.status === 'idle' || value.status === 'error' || value.status === 'archived')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
}

/** 双重防护：即使旧 Host 错误返回 rawStoreRef，浏览器也不会把它留在状态中。 */
function redactCliSessionRecord(record: CodingNsCliSessionRecord): CodingNsCliSessionRecord {
  const { rawStoreRef: _rawStoreRef, ...safe } = record
  return safe
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
