export type PeerHostStatus =
  | 'unknown'
  | 'checking'
  | 'ready'
  | 'unreachable'
  | 'version_mismatch'
  | 'session_required'
  | 'disabled'

export interface PeerHostRecord {
  peerHostId: string
  name: string
  baseUrl: string
  status: PeerHostStatus
  remoteVersion: string | null
  remoteApiCompatibility: string | null
  remoteHostFingerprint: string | null
  lastCheckedAt: string | null
  lastErrorCode: string | null
}

export interface ResourceScopeRef {
  hostId: string
  workspaceId: string
  targetHostId: string | null
  scopeGeneration: number
}

/**
 * 作用域切换时使用的输入，不允许调用方自行伪造 generation。
 * generation 只能由 ResourceScopeManager 分配。
 */
export interface ResourceScopeInput {
  hostId: string
  workspaceId: string
  targetHostId: string | null
}

/** 对外暴露的只读作用域快照。 */
export type ResourceScopeSnapshot = Readonly<ResourceScopeRef>

/** 作用域拥有的清理函数。清理函数必须可重复调用而不会产生副作用。 */
export type ResourceScopeDisposer = () => void | Promise<void>

/** 作用域已经失效时统一抛出的错误。 */
export class ResourceScopeStaleError extends Error {
  readonly code = 'RESOURCE_SCOPE_STALE' as const

  constructor(message = 'Resource scope is stale') {
    super(message)
    this.name = 'ResourceScopeStaleError'
  }
}
