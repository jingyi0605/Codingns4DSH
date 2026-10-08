import type { PeerHostDiagnosticSnapshot, PeerHostErrorCode, PeerHostRecord } from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'
export type { PeerHostDiagnosticSnapshot } from '../../../shared/contracts/peer-host.js'

export interface PeerHostDiagnosticSink {
  readonly enabled?: boolean
  emit(event: string, snapshot: PeerHostDiagnosticSnapshot): void
}

const DEFAULT_MESSAGES: Readonly<Record<PeerHostErrorCode, string>> = {
  [PEER_HOST_ERROR_CODES.NOT_FOUND]: 'PeerHost 不存在',
  [PEER_HOST_ERROR_CODES.NOT_READY]: 'PeerHost 尚未准备好',
  [PEER_HOST_ERROR_CODES.SESSION_REQUIRED]: '目标 Host 登录态已失效',
  [PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED]: 'PeerHost 代理路径或方法不受支持',
  [PEER_HOST_ERROR_CODES.PROXY_ACCESS_DENIED]: '目标 Host 登录有效，但拒绝访问此接口；请检查目标插件版本及接口权限',
  [PEER_HOST_ERROR_CODES.SCOPE_MISMATCH]: 'PeerHost 作用域不匹配',
  [PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE]: '目标 Host 代理不可达',
  [PEER_HOST_ERROR_CODES.RESPONSE_INVALID]: '目标 Host 响应无效',
  [PEER_HOST_ERROR_CODES.TOOL_UNSUPPORTED]: '目标 Host 工具不受支持',
  [PEER_HOST_ERROR_CODES.INVALID_ROUTE]: 'PeerHost 路由无效',
  [PEER_HOST_ERROR_CODES.DUPLICATE]: 'PeerHost 路由已存在',
  [PEER_HOST_ERROR_CODES.PLUGIN_MISSING]: '目标 Host 未安装兼容插件',
  [PEER_HOST_ERROR_CODES.VERSION_MISMATCH]: '目标 Host 版本不兼容',
  [PEER_HOST_ERROR_CODES.IDENTITY_CHANGED]: '目标 Host 身份已变化',
  [PEER_HOST_ERROR_CODES.UNREACHABLE]: '目标 Host 不可达',
  [PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE]: '中转 PeerHost 暂不可用',
  [PEER_HOST_ERROR_CODES.STALE_GENERATION]: 'PeerHost 作用域已过期',
  [PEER_HOST_ERROR_CODES.AGGREGATE_UNAVAILABLE]: 'PeerHost 摘要暂不可用',
  [PEER_HOST_ERROR_CODES.AGGREGATED_TRANSPORT_UNSUPPORTED]: 'Aggregated Host Transport 不受当前 DSH 版本支持',
  [PEER_HOST_ERROR_CODES.AGGREGATED_MANIFEST_FORBIDDEN]: 'Aggregated Host 禁止加载远端 Manifest',
  [PEER_HOST_ERROR_CODES.AGGREGATED_BUNDLE_FORBIDDEN]: 'Aggregated Host 禁止加载远端 Bundle',
}

/** 将内部错误转换成稳定错误码和固定文案，禁止回显底层异常正文。 */
export function peerHostSafeError(code: PeerHostErrorCode): Error & { readonly code: PeerHostErrorCode } {
  const error = new Error(DEFAULT_MESSAGES[code] ?? 'PeerHost 请求失败') as Error & { readonly code: PeerHostErrorCode }
  Object.defineProperty(error, 'code', { value: code, enumerable: true })
  return error
}

/** 对外诊断字段只保留脱敏 fingerprint；完整地址、ticket 和凭据永远不进入快照。 */
export function toPeerHostDiagnosticSnapshot(record: PeerHostRecord): PeerHostDiagnosticSnapshot {
  return {
    peerHostId: record.id,
    routeKind: record.route.kind,
    status: record.status,
    lastErrorCode: record.lastErrorCode,
    lastCheckedAt: record.lastCheckedAt,
    fingerprint: redactFingerprint(record.fingerprint),
  }
}

export function redactFingerprint(value: string | null): string | null {
  if (value === null || value.length <= 12) return value
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

/** 默认关闭；即使开启，也只向 sink 发送已验证的诊断快照。 */
export function createPeerHostDiagnosticSink(options: { readonly enabled?: boolean; readonly sink?: (event: string, snapshot: PeerHostDiagnosticSnapshot) => void } = {}): PeerHostDiagnosticSink {
  return {
    enabled: options.enabled ?? false,
    emit(event, snapshot) {
      if (!(options.enabled ?? false)) return
      options.sink?.(event, snapshot)
    },
  }
}
