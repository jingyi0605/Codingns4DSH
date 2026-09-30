import type {
  VirtualSessionId,
  VirtualWorkspaceId,
} from '../../../shared/contracts/peer-host.js'

/** DSH 0.2.x Workspace/Session Remote 方法；这里只登记原生协议，不登记插件私有 RPC。 */
export const DSH_NATIVE_REMOTE_METHODS = Object.freeze([
  'workspace/archiveSession',
  'workspace/create',
  'workspace/delete',
  'workspace/follow',
  'workspace/initializeDefault',
  'workspace/insertBefore',
  'workspace/insertSessionBefore',
  'workspace/pinSession',
  'workspace/rename',
  'workspace/unarchiveSession',
  'workspace/unpinSession',
  'session/attachment',
  'session/cancel',
  'session/canOpenWorkspacePath',
  'session/control',
  'session/create',
  'session/follow',
  'session/fork',
  'session/initializeDefaultModel',
  'session/list',
  'session/modelCatalog',
  'session/openWorkspacePath',
  'session/page',
  'session/projections',
  'session/prompt',
  'session/rename',
  'session/search',
  'session/selectModel',
  'session/updateQueue',
  'session/workspacePathApplications',
  'workspaceFiles/changes',
  'workspaceFiles/list',
  'workspaceFiles/read',
  'workspaceFiles/readBytes',
  'workspaceFiles/stat',
  'terminal/close',
  'terminal/create',
  'terminal/environment',
  'terminal/follow',
  'terminal/list',
  'terminal/rename',
  'terminal/resize',
  'terminal/retain',
  'terminal/shells',
  'terminal/write',
  // CodingNs4DSH 自带终端控制器：右侧终端面板实际调用它（会话身份在 agentId 线参上）。
  'codingnsTerminal/close',
  'codingnsTerminal/create',
  'codingnsTerminal/environment',
  'codingnsTerminal/follow',
  'codingnsTerminal/list',
  'codingnsTerminal/rename',
  'codingnsTerminal/resize',
  'codingnsTerminal/retain',
  'codingnsTerminal/shells',
  'codingnsTerminal/write',
  'fileReferences/list',
  'skills/list',
] as const)

export type DshNativeRemoteMethod = typeof DSH_NATIVE_REMOTE_METHODS[number]

const NATIVE_METHOD_SET = new Set<string>(DSH_NATIVE_REMOTE_METHODS)

export function isDshNativeRemoteMethod(value: string): value is DshNativeRemoteMethod {
  return NATIVE_METHOD_SET.has(value)
}

export type VirtualIdResolver = {
  resolveWorkspace(id: VirtualWorkspaceId): { readonly workspaceId: string; readonly targetHostId: string | null } | null
  resolveSession(id: VirtualSessionId): { readonly sessionId: string; readonly targetHostId: string | null } | null
}

/**
 * 将 DSH 原生请求中的虚拟资源 ID 改回目标 Host 的真实 ID。
 * 只改写 DSH 已知的资源字段，requestId、attachmentId 和任意正文不会被误改。
 */
export function rewriteNativeRequestIds(
  method: DshNativeRemoteMethod,
  payload: unknown,
  resolver: VirtualIdResolver,
): unknown {
  if (payload === undefined) return payload
  return rewriteValue(payload, (key, value) => {
    if (typeof value !== 'string') return value
    if (isWorkspaceField(key)) {
      return resolver.resolveWorkspace(value)?.workspaceId ?? value
    }
    if (isSessionField(key)) {
      return resolver.resolveSession(value)?.sessionId ?? value
    }
    return value
  })
}

/** 将目标 Host 返回的原生结果/事件重新编码为当前 DSH 可见的虚拟 ID。 */
export function rewriteNativeResponseIds(
  value: unknown,
  encodeWorkspace: (id: string) => VirtualWorkspaceId,
  encodeSession: (id: string) => VirtualSessionId,
): unknown {
  return rewriteValue(value, (key, current, parentKey) => {
    if (typeof current !== 'string') return current
    if (isWorkspaceField(key)) return encodeWorkspace(current)
    if (isSessionField(key) || key === 'parentSession' || (key === 'id' && parentKey === 'header')) return encodeSession(current)
    return current
  })
}

function rewriteValue(value: unknown, map: (key: string, value: unknown, parentKey?: string) => unknown, key = '', parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, map, key, parentKey))
  if (typeof value !== 'object' || value === null) return map(key, value)
  const result: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const mapped = map(childKey, childValue, key)
    result[childKey] = mapped === childValue
      ? rewriteValue(childValue, map, childKey, key)
      : mapped
  }
  return result
}

function isWorkspaceField(key: string): boolean {
  return key === 'workspaceId' || key === 'beforeWorkspaceId' || key === 'workspaceIds'
}

function isSessionField(key: string): boolean {
  if (key === 'workspaceFileScopeId') return true
  // CodingNs4DSH 终端 Remote 用 agentId（lookup: agent，codec 为 SessionId）承载会话身份。
  if (key === 'agentId') return true
  return key === 'sessionId' || key === 'beforeSessionId' || key === 'sessionIds' || key === 'parentSessionId' || key === 'childSessionId'
}
