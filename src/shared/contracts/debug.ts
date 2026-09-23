/** Spec003 调试运行模式。`pty` 复用现有终端启动器，`process` 由 Spec003 自己管理。 */
export type DebugRuntimeMode = 'process' | 'pty'

/** 调试运行实例的生命周期状态。 */
export type DebugRuntimeState =
  | 'PREPARING'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'EXITED'
  | 'FAILED'
  | 'LOST'

/** 端口发现结果的归属等级。 */
export type DebugProcessOwnership = 'managed' | 'agent_terminal' | 'discovered'

/** 端口在调试面板中的状态。 */
export type DebugPortState =
  | 'UNCONFIGURED'
  | 'AVAILABLE'
  | 'LEASED'
  | 'LISTENING_OWNED'
  | 'OCCUPIED_EXTERNAL'
  | 'MISMATCH'

/** 框架分析的准入等级。 */
export type DebugCompatibilityLevel = 'supported' | 'conditional' | 'unsupported' | 'unknown'

/** 启动计划状态。 */
export type DebugPlanState = 'draft' | 'ready' | 'blocked' | 'expired' | 'consumed'

/** AI 兜底补丁状态。 */
export type DebugAiFallbackState = 'PENDING' | 'APPLIED' | 'REJECTED' | 'ROLLED_BACK' | 'KEPT' | 'CONFLICT'

/** 调试代理支持的协议。 */
export type DebugProxyProtocol = 'http' | 'sse' | 'websocket'

/** 阶段 0 冻结的调试 RPC 名称；具体实现由后续阶段登记。 */
export const DEBUG_RPC_ENDPOINTS = [
  'debug/snapshot',
  'debug/profile/list',
  'debug/profile/create',
  'debug/profile/update',
  'debug/profile/delete',
  'debug/profile/clone',
  'debug/analysis/get',
  'debug/analysis/refresh',
  'debug/analysis/matrix',
  'debug/plan/create',
  'debug/plan/discard',
  'debug/runtime/start',
  'debug/runtime/get',
  'debug/runtime/list',
  'debug/runtime/stop',
  'debug/runtime/restart',
  'debug/process/inspect-port',
  'debug/process/terminate-candidate',
  'debug/log/read',
  'debug/log/follow',
  'debug/ai/preview',
  'debug/ai/apply',
  'debug/ai/reject',
  'debug/ai/rollback',
  'debug/ai/keep',
  'debug/proxy/get',
  'debug/proxy/enable',
  'debug/proxy/disable',
  'debug/settings/get',
  'debug/settings/set',
] as const

export type DebugRpcEndpoint = typeof DEBUG_RPC_ENDPOINTS[number]

/** 调试领域稳定错误码。错误码先冻结，后续 Host 实现不得用自由文本替代。 */
export const DEBUG_ERROR_CODES = {
  INVALID_REQUEST: 'DEBUG_INVALID_REQUEST',
  WORKSPACE_REQUIRED: 'DEBUG_WORKSPACE_REQUIRED',
  WORKSPACE_SESSION_MISMATCH: 'DEBUG_WORKSPACE_SESSION_MISMATCH',
  GENERATION_STALE: 'DEBUG_GENERATION_STALE',
  REVISION_CONFLICT: 'DEBUG_REVISION_CONFLICT',
  PROFILE_NOT_FOUND: 'DEBUG_PROFILE_NOT_FOUND',
  PROCESS_INSTANCE_NOT_FOUND: 'DEBUG_PROCESS_INSTANCE_NOT_FOUND',
  PROCESS_IDENTITY_MISMATCH: 'DEBUG_PROCESS_IDENTITY_MISMATCH',
  PORT_LEASE_CONFLICT: 'DEBUG_PORT_LEASE_CONFLICT',
  RUNTIME_NOT_FOUND: 'DEBUG_RUNTIME_NOT_FOUND',
  PROXY_ROUTE_NOT_FOUND: 'DEBUG_PROXY_ROUTE_NOT_FOUND',
  DSH_HOST_API_UNAVAILABLE: 'DEBUG_DSH_HOST_API_UNAVAILABLE',
} as const

export type DebugErrorCode = typeof DEBUG_ERROR_CODES[keyof typeof DEBUG_ERROR_CODES]

/** 所有调试 RPC 都必须携带的作用域。generation 由当前连接/资源作用域产生。 */
export interface DebugRpcScope {
  readonly sessionId: string
  readonly workspaceId: string
  readonly generation: number
}

/** 需要乐观并发控制的调试写请求。两个版本字段最多提供一个。 */
export interface DebugMutationScope extends DebugRpcScope {
  readonly recordId: string
  readonly expectedRevision?: number
  readonly expectedUpdatedAt?: string
}

/** PTY 启动请求只携带意图，不携带绝对路径、PID 或端口目标。 */
export interface DebugPtyLaunchRequest extends DebugRpcScope {
  readonly profileId: string
  readonly cols: number
  readonly rows: number
}

/** 调试面板保存的运行实例摘要。完整进程身份只留在 Host。 */
export interface DebugProcessInstance {
  readonly id: string
  readonly workspaceId: string
  readonly profileId: string
  readonly runtimeMode: DebugRuntimeMode
  readonly state: DebugRuntimeState
  readonly ownership: 'managed'
  readonly terminalId: string | null
  readonly pid: number | null
  readonly processFingerprint: string | null
  readonly startedAt: string | null
  readonly stoppedAt: string | null
  readonly exitCode: number | null
}

/** 规范化并校验调试 RPC 作用域。禁止把 Client 的任意对象直接传入业务层。 */
export function parseDebugRpcScope(value: unknown): DebugRpcScope {
  if (!isRecord(value)) throw new TypeError('调试 RPC 作用域必须是对象')
  const sessionId = nonEmptyString(value.sessionId, 'sessionId')
  const workspaceId = nonEmptyString(value.workspaceId, 'workspaceId')
  const generation = nonNegativeInteger(value.generation, 'generation')
  return { sessionId, workspaceId, generation }
}

/** 规范化并校验带记录 ID 的调试写请求。 */
export function parseDebugMutationScope(value: unknown): DebugMutationScope {
  if (!isRecord(value)) throw new TypeError('调试写请求必须是对象')
  rejectUnknownFields(value, ['sessionId', 'workspaceId', 'generation', 'recordId', 'expectedRevision', 'expectedUpdatedAt'], '调试写请求')
  const scope = parseDebugRpcScope(value)
  const recordId = nonEmptyString(value.recordId, 'recordId')
  const expectedRevision = value.expectedRevision
  const expectedUpdatedAt = value.expectedUpdatedAt
  if (expectedRevision !== undefined && expectedUpdatedAt !== undefined) {
    throw new TypeError('expectedRevision 和 expectedUpdatedAt 只能提供一个')
  }
  if (expectedRevision !== undefined) nonNegativeInteger(expectedRevision, 'expectedRevision')
  if (expectedUpdatedAt !== undefined) nonEmptyString(expectedUpdatedAt, 'expectedUpdatedAt')
  return {
    ...scope,
    recordId,
    ...(expectedRevision === undefined ? {} : { expectedRevision: nonNegativeInteger(expectedRevision, 'expectedRevision') }),
    ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: nonEmptyString(expectedUpdatedAt, 'expectedUpdatedAt') }),
  }
}

/** 校验 PTY 调用参数，避免把终端尺寸或路径类字段直接信任到 Host。 */
export function parseDebugPtyLaunchRequest(value: unknown): DebugPtyLaunchRequest {
  if (!isRecord(value)) throw new TypeError('PTY 启动请求必须是对象')
  rejectUnknownFields(value, ['sessionId', 'workspaceId', 'generation', 'profileId', 'cols', 'rows'], 'PTY 启动请求')
  const scope = parseDebugRpcScope(value)
  const profileId = nonEmptyString(value.profileId, 'profileId')
  const cols = positiveInteger(value.cols, 'cols')
  const rows = positiveInteger(value.rows, 'rows')
  if (cols > 500 || rows > 200) throw new RangeError('PTY 尺寸超出允许范围')
  return { ...scope, profileId, cols, rows }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedFields = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedFields.has(key))
  if (unknown !== undefined) throw new TypeError(`${label}包含未知字段: ${unknown}`)
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new TypeError(`${field} 必须是非空字符串`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} 必须是非负整数`)
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} 必须是正整数`)
  }
  return value
}
