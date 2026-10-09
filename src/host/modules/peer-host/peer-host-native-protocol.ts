import type {
  VirtualSessionId,
  VirtualWorkspaceId,
} from '../../../shared/contracts/peer-host.js'
import { normalizePeerHostFileLocation } from '../../../shared/peer-host-file-location.js'

/** DSH 0.2.x Workspace/Session Remote 方法；这里只登记原生协议，不登记插件私有 RPC。 */
export const DSH_NATIVE_REMOTE_METHODS = Object.freeze([
  // 交互事件是 Gateway 自有协议；派发层必须走 wireStream / Connection，不能当作业务 Remote。
  '$events',
  '$events/result',
  'userQuestions/answer',
  'userQuestions/attachWait',
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
  // 可继续子会话的输入与停止由 subagents Remote 承载，身份字段仍是 SessionId。
  'subagents/prompt',
  'subagents/interruptByParent',
  // 对话框的 / 命令目录由目标 Host 提供；否则虚拟会话会误读本机命令集合。
  'commands/list',
  'commands/execute',
  'officeToPdf/generation',
  'officeToPdf/render',
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
  /** 目标工作区的真实路径，用于识别远端平台；不能使用代理 Host 的平台。 */
  readonly workspacePath?: string
  resolveWorkspace(id: VirtualWorkspaceId): { readonly workspaceId: string; readonly targetHostId: string | null } | null
  resolveSession(id: VirtualSessionId): { readonly sessionId: string; readonly targetHostId: string | null } | null
  /** 将列表层使用的虚拟 Workspace 路径还原成目标 Host 的真实路径。 */
  resolveWorkspacePath?(path: string): string | null
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
    if (isPathField(key) || (method.startsWith('workspaceFiles/') && key === 'baseFile')) {
      const path = resolver.resolveWorkspacePath?.(value) ?? value
      // 已打开或恢复的旧标签可能绕过资源打开入口，文件读取和变化流也需纠正路径。
      return method.startsWith('workspaceFiles/') ? normalizePeerHostFileLocation(path, resolver.workspacePath).path : path
    }
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
  // 状态通知的 SessionId 位于位置参数，而不是命名字段；不能按普通数组漏掉改写。
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const frame = value as Record<string, unknown>
    if (frame.type === 'emit' && frame.event === 'api-session/status' && Array.isArray(frame.args) && typeof frame.args[0] === 'string') {
      return { ...frame, args: [encodeSession(frame.args[0]), ...frame.args.slice(1)] }
    }
  }
  return rewriteValue(value, (key, current, parentKey) => {
    if (typeof current !== 'string') return current
    if (isWorkspaceField(key)) return encodeWorkspace(current)
    if (isSessionField(key) || key === 'parentSession' || (key === 'id' && (parentKey === 'header' || parentKey === 'subagentCatalog'))) return encodeSession(current)
    return current
  })
}

function rewriteValue(value: unknown, map: (key: string, value: unknown, parentKey?: string) => unknown, key = '', parentKey?: string): unknown {
  // 二进制字段（例如 workspaceFiles/readBytes.data）属于 Remote 结果的一部分，
  // 不能按普通对象展开，否则 Uint8Array 会变成带数字键的对象并在 JSON 边界丢失类型。
  if (value instanceof Uint8Array) return value
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

/** PeerHost 的 JSON RPC 不能直接传输 Uint8Array，使用显式标记保留二进制结果。 */
const NATIVE_BYTES_MARKER = '__codingnsNativeBytes'

export function encodeNativeResponseBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [NATIVE_BYTES_MARKER]: encodeBase64(value) }
  if (Array.isArray(value)) return value.map(encodeNativeResponseBytes)
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) result[key] = encodeNativeResponseBytes(child)
  return result
}

export function decodeNativeResponseBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeNativeResponseBytes)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  if (Object.keys(record).length === 1 && typeof record[NATIVE_BYTES_MARKER] === 'string') {
    return decodeBase64(record[NATIVE_BYTES_MARKER] as string)
  }
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) result[key] = decodeNativeResponseBytes(child)
  return result
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const browserEncoder = (globalThis as { btoa?: (value: string) => string }).btoa
  if (typeof browserEncoder === 'function') return browserEncoder(binary)
  const nodeBuffer = (globalThis as { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer
  if (nodeBuffer !== undefined) return nodeBuffer.from(bytes).toString('base64')
  throw new Error('当前运行时不支持 Base64 编码')
}

function decodeBase64(value: string): Uint8Array {
  const browserDecoder = (globalThis as { atob?: (value: string) => string }).atob
  if (typeof browserDecoder === 'function') {
    const binary = browserDecoder(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  const nodeBuffer = (globalThis as { Buffer?: { from(value: string, encoding: string): { [index: number]: number; length: number } } }).Buffer
  if (nodeBuffer !== undefined) {
    const buffer = nodeBuffer.from(value, 'base64')
    return Uint8Array.from({ length: buffer.length }, (_, index) => buffer[index] ?? 0)
  }
  throw new Error('当前运行时不支持 Base64 解码')
}

function isWorkspaceField(key: string): boolean {
  return key === 'workspaceId' || key === 'beforeWorkspaceId' || key === 'workspaceIds'
}

function isPathField(key: string): boolean {
  return key === 'path' || key === 'workspacePath'
}

function isSessionField(key: string): boolean {
  if (key === 'workspaceFileScopeId') return true
  // CodingNs4DSH 终端 Remote 用 agentId（lookup: agent，codec 为 SessionId）承载会话身份。
  if (key === 'agentId') return true
  return key === 'sessionId'
    || key === 'beforeSessionId'
    || key === 'sessionIds'
    || key === 'archivedSessionIds'
    || key === 'parentSessionId'
    || key === 'childSessionId'
}
