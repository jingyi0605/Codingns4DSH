import { PEER_HOST_ERROR_CODES, type PeerHostErrorCode } from '../../../shared/contracts/peer-host.js'
import { CodingNsRpcError } from '../../rpc-table.js'
import { peerHostSafeError } from './peer-host-diagnostics.js'

/** 调用方取消与请求超时分开处理：超时仍然属于需要诊断的真实失败。 */
export function isPeerHostRequestCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (errorName(error) === 'TimeoutError' || errorName(signal?.reason) === 'TimeoutError') return false
  return errorName(error) === 'AbortError' || signal?.aborted === true
}

/** 关闭流时允许自定义 reason，但向上传播时始终保留标准 AbortError 语义。 */
export function throwIfPeerHostRequestAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (errorName(signal.reason) === 'TimeoutError' || errorName(signal.reason) === 'AbortError') throw signal.reason
  const error = new Error('PeerHost 请求已取消', { cause: signal.reason })
  error.name = 'AbortError'
  throw error
}

interface PeerHostFailureCause {
  readonly name: string
  readonly code?: string
  readonly errno?: number
  readonly syscall?: string
  readonly cause?: PeerHostFailureCause
  readonly errors?: readonly PeerHostFailureCause[]
}

export interface PeerHostStreamFailureDiagnostics {
  readonly targetHostId: string
  readonly method: string
  readonly phase: 'open' | 'next'
  readonly workspaceId: string
  readonly sessionId: string | null
  readonly elapsedMs: number
  readonly attempts: number
  readonly status: number | null
  readonly cause: PeerHostFailureCause
}

/** 完整 cause 只留在 Host 内存；RPC 日志使用白名单诊断字段，客户端仍收到稳定文案。 */
export class PeerHostNativeStreamError extends CodingNsRpcError {
  readonly diagnostics: PeerHostStreamFailureDiagnostics

  constructor(error: unknown, cause: unknown, context: Omit<PeerHostStreamFailureDiagnostics, 'cause'>) {
    const failure = stableStreamFailure(error)
    super(failure.code, failure.message)
    this.cause = cause
    this.diagnostics = { ...context, cause: summarizeCause(cause) }
  }
}

/** 代理校验等本地稳定错误也要原样归类，不能因为增加诊断而退化成网络故障。 */
function stableStreamFailure(error: unknown): { code: string; message: string } {
  if (error instanceof CodingNsRpcError) return error
  const candidate = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  const code = Object.values(PEER_HOST_ERROR_CODES).includes(candidate as PeerHostErrorCode)
    ? candidate as PeerHostErrorCode : PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE
  return peerHostSafeError(code)
}

/** 不记录任意 message、stack、地址和请求正文，避免异常文本夹带票据或账号。 */
function summarizeCause(error: unknown, depth = 0): PeerHostFailureCause {
  const value = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
  const name = diagnosticIdentifier(value.name) ?? 'UnknownError'
  const code = diagnosticIdentifier(value.code)
  const syscall = diagnosticIdentifier(value.syscall)
  return {
    name,
    ...(code === undefined ? {} : { code }),
    ...(typeof value.errno === 'number' && Number.isFinite(value.errno) ? { errno: value.errno } : {}),
    ...(syscall === undefined ? {} : { syscall }),
    ...(depth < 3 && value.cause !== undefined ? { cause: summarizeCause(value.cause, depth + 1) } : {}),
    ...(depth < 3 && Array.isArray(value.errors) ? { errors: value.errors.slice(0, 4).map(item => summarizeCause(item, depth + 1)) } : {}),
  }
}

function diagnosticIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_/-]{0,127}$/u.test(value) ? value : undefined
}

function errorName(error: unknown): unknown {
  return error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
}
