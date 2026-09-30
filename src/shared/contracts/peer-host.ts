/** PeerHost 目标路由；短期 relay ticket 永远不属于持久配置。 */
export type PeerHostRoute =
  | {
      readonly kind: 'lan'
      readonly baseUrl: string
      readonly normalizedOrigin: string
    }
  | {
      readonly kind: 'relay'
      readonly deviceId: string
      readonly relayEntryId: string
      readonly transportVersion: string
    }

export type PeerHostStatus =
  | 'configured'
  | 'checking'
  | 'ready'
  | 'plugin_missing'
  | 'version_mismatch'
  | 'identity_changed'
  | 'session_required'
  | 'unreachable'
  | 'reconnecting'
  | 'disabled'

/** Host 侧保存的 PeerHost 配置与脱敏握手状态。凭据不在此 DTO 中。 */
export interface PeerHostRecord {
  readonly id: string
  readonly ownerUserId: string
  readonly displayName: string
  readonly route: PeerHostRoute
  readonly status: PeerHostStatus
  readonly pluginId: string | null
  readonly pluginVersion: string | null
  readonly dshVersion: string | null
  /** 远端操作系统主机名；旧记录没有此字段时保持缺省。 */
  readonly hostname?: string | null
  /** 远端 DSH 配置文件名；只返回名称，不返回本地路径。 */
  readonly configProfile?: string | null
  readonly apiCompatibility: string | null
  readonly fingerprint: string | null
  readonly lastCheckedAt: number | null
  readonly lastErrorCode: PeerHostErrorCode | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** Client 管理面板可见的 PeerHost 摘要；路由详情和所有凭据只留在 Host。 */
export type PeerHostClientRoute =
  | { readonly kind: 'lan' }
  | { readonly kind: 'relay' }

export type PeerHostClientRecord = Omit<PeerHostRecord, 'route'> & {
  readonly route: PeerHostClientRoute
}

/** Client 可见的 PeerHost 诊断快照；不包含完整路由、凭据或正文。 */
export interface PeerHostDiagnosticSnapshot {
  readonly peerHostId: string
  readonly routeKind: 'lan' | 'relay'
  readonly status: PeerHostStatus
  readonly lastErrorCode: PeerHostErrorCode | null
  readonly lastCheckedAt: number | null
  readonly fingerprint: string | null
}

/** 当前 Host 插件自有 WebSocket 入口；不包含任何目标 Host 地址或凭据。 */
export interface PeerHostWebSocketEndpoint {
  readonly host: string
  readonly port: number
  readonly path: string
}

/** 所有跨 Host 资源共用的完整作用域。 */
export interface HostScope {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly workspaceId: string
  readonly sessionId: string | null
  readonly scopeGeneration: number
}

/** 会话摘要只用于聚合导航，不包含历史消息或工具内容。 */
export interface PeerHostSessionRecord {
  readonly scope: HostScope
  readonly title: string
  readonly status: string
  readonly updatedAt: number
}

/** 当前 Host 和 PeerHost 统一使用的工作区摘要。 */
export interface AggregateWorkspaceSummary {
  readonly key: string
  readonly hostId: string
  readonly targetHostId: string | null
  readonly workspaceId: string
  readonly displayName: string
  /** 工作区在所属 Host 上的真实路径；原生文件面板等按路径解析，不能用 workspaceId 代替。 */
  readonly path: string
  readonly hostLabel: string
  readonly availability: 'ready' | 'checking' | 'unreachable' | 'unsupported'
  readonly sessions: readonly PeerHostSessionRecord[]
  /**
   * 已归档会话。远端侧栏默认隐藏这些行，但归档入口、归档集合与取消归档路由
   * 仍需要它们；子代理会话在可见与归档两侧都不出现。
   */
  readonly archivedSessions?: readonly PeerHostSessionRecord[]
}

export interface AggregateHostResult {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly hostLabel: string
  readonly availability: 'ready' | 'checking' | 'unreachable' | 'unsupported'
  readonly errorCode: PeerHostErrorCode | null
  /** 摘要能力不可用时保留可诊断原因，禁止以空工作区伪装成功。 */
  readonly diagnostic?: string
  readonly workspaces: readonly AggregateWorkspaceSummary[]
}

/** Aggregated Host 只允许本地插件基线；远端不得提供 Manifest、Bundle 或 UI Slot。 */
export interface AggregatedHostLocalPluginBaseline {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly manifestSource: 'local'
  readonly bundleSource: 'local'
  readonly uiSource: 'local'
  readonly allowRemoteManifest: false
  readonly allowRemoteBundle: false
}

/** 目标 Host 的执行能力摘要；不包含 token、路由地址或插件正文。 */
export interface AggregatedHostCapabilitySummary {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly hostLabel: string
  readonly status: 'ready' | 'checking' | 'unreachable' | 'unsupported'
  readonly dshVersion: string | null
  readonly apiCompatibility: string | null
  readonly capabilities: readonly string[]
  readonly diagnostic?: string
}

/** Client 读取的 Manifest 只代表当前 Host 的本地插件基线。 */
export interface AggregatedHostManifestBoundary {
  readonly source: 'local'
  readonly plugin: AggregatedHostLocalPluginBaseline
  readonly remoteManifest: 'forbidden'
  readonly remoteBundle: 'forbidden'
}

/** Aggregated Transport 的物理连接 generation；作用域 generation 仍由 HostScope 管理。 */
export interface AggregatedHostGeneration {
  readonly id: number
  readonly host: { readonly home: string }
  readonly connectedAt: number
}

export interface AggregatedHostRpcRequest {
  readonly scope: HostScope
  readonly method: string
  readonly payload?: unknown
  readonly signal?: AbortSignal
}

export interface AggregatedHostFetchRequest {
  readonly scope: HostScope
  readonly path: string
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly signal?: AbortSignal
}

export interface AggregatedHostStreamRequest {
  readonly scope: HostScope
  readonly method: string
  readonly payload?: unknown
  readonly signal?: AbortSignal
}

/** Client 侧只提交自己的 Socket；目标连接和 token 由 Host 侧代理服务持有。 */
export interface AggregatedHostWebSocketClient {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message' | 'close' | 'error', listener: (...args: any[]) => void): void
}

/** Aggregated Host 的内部稳定 Transport；不替换普通插件 ctx.connection。 */
export interface AggregatedHostTransport {
  readonly kind: 'aggregated-host'
  readonly localPlugin: AggregatedHostLocalPluginBaseline
  getCapabilities(): readonly AggregatedHostCapabilitySummary[]
  rpc<TResponse = unknown>(request: AggregatedHostRpcRequest): Promise<TResponse>
  fetch(request: AggregatedHostFetchRequest): Promise<Response>
  openStream<TChunk = unknown>(request: AggregatedHostStreamRequest): AsyncIterable<TChunk>
  openWebSocket(client: AggregatedHostWebSocketClient, scope: HostScope): Promise<() => void>
  getGeneration(): AggregatedHostGeneration | undefined
  onGenerationChange(listener: (generation: AggregatedHostGeneration | undefined) => void): () => void
  reconnect(signal?: AbortSignal): Promise<void>
  readManifest(): AggregatedHostManifestBoundary
  loadBundle(url: string): Promise<void>
  close(): Promise<void>
}

/**
 * 聚合 Host 对外暴露的资源命名空间。
 *
 * 远端 Host 的 workspace/session id 只在各自 Host 内唯一，不能直接交给
 * 本地 DSH Store。聚合层使用版本化、可逆的虚拟 ID，避免不同 Host 的同名
 * 资源碰撞，同时保留真实 ID 供路由层转发。
 */
export type VirtualWorkspaceId = string
export type VirtualSessionId = string

export interface VirtualWorkspaceRef {
  readonly virtualWorkspaceId: VirtualWorkspaceId
  readonly hostId: string
  readonly targetHostId: string | null
  readonly workspaceId: string
}

export interface VirtualSessionRef {
  readonly virtualSessionId: VirtualSessionId
  readonly hostId: string
  readonly targetHostId: string | null
  readonly workspaceId: string
  readonly sessionId: string
}

/** 混合 Workspace 顺序的持久化内容，只保存虚拟 ID，不复制 Host 数据。 */
export interface AggregateWorkspaceOrder {
  readonly version: 1
  readonly orderedWorkspaceIds: readonly VirtualWorkspaceId[]
}

export const VIRTUAL_RESOURCE_ID_PREFIX = 'codingns:peer-host:v1'

export function createVirtualWorkspaceId(hostId: string, workspaceId: string): VirtualWorkspaceId {
  return createVirtualResourceId('workspace', hostId, workspaceId)
}

export function createVirtualSessionId(hostId: string, sessionId: string): VirtualSessionId {
  return createVirtualResourceId('session', hostId, sessionId)
}

export function parseVirtualWorkspaceId(value: string): VirtualWorkspaceRef | null {
  const parsed = parseVirtualResourceId(value, 'workspace')
  if (parsed === null) return null
  return { virtualWorkspaceId: value, hostId: parsed.hostId, targetHostId: parsed.hostId === 'local' ? null : parsed.hostId, workspaceId: parsed.resourceId }
}

export function parseVirtualSessionId(value: string): { readonly hostId: string; readonly sessionId: string } | null {
  const parsed = parseVirtualResourceId(value, 'session')
  return parsed === null ? null : { hostId: parsed.hostId, sessionId: parsed.resourceId }
}

function createVirtualResourceId(kind: 'workspace' | 'session', hostId: string, resourceId: string): string {
  const host = requiredResourcePart(hostId, 'hostId')
  const resource = requiredResourcePart(resourceId, kind === 'workspace' ? 'workspaceId' : 'sessionId')
  return `${VIRTUAL_RESOURCE_ID_PREFIX}:${kind}:${encodeURIComponent(host)}:${encodeURIComponent(resource)}`
}

function parseVirtualResourceId(value: string, kind: 'workspace' | 'session'): { readonly hostId: string; readonly resourceId: string } | null {
  if (typeof value !== 'string') return null
  const prefix = `${VIRTUAL_RESOURCE_ID_PREFIX}:${kind}:`
  if (!value.startsWith(prefix)) return null
  const parts = value.slice(prefix.length).split(':')
  if (parts.length !== 2 || parts.some((part) => part === '')) return null
  try {
    const hostId = decodeURIComponent(parts[0]!)
    const resourceId = decodeURIComponent(parts[1]!)
    return hostId && resourceId ? { hostId, resourceId } : null
  } catch {
    return null
  }
}

function requiredResourcePart(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} 不能为空`)
  return value
}

export const PEER_HOST_ERROR_CODES = {
  NOT_FOUND: 'PEER_HOST_NOT_FOUND',
  NOT_READY: 'PEER_HOST_NOT_READY',
  SESSION_REQUIRED: 'PEER_HOST_SESSION_REQUIRED',
  PROXY_PATH_NOT_ALLOWED: 'PEER_HOST_PROXY_PATH_NOT_ALLOWED',
  SCOPE_MISMATCH: 'PEER_HOST_SCOPE_MISMATCH',
  PROXY_UNREACHABLE: 'PEER_HOST_PROXY_UNREACHABLE',
  RESPONSE_INVALID: 'PEER_HOST_RESPONSE_INVALID',
  TOOL_UNSUPPORTED: 'PEER_HOST_TOOL_UNSUPPORTED',
  INVALID_ROUTE: 'PEER_HOST_INVALID_ROUTE',
  DUPLICATE: 'PEER_HOST_DUPLICATE',
  PLUGIN_MISSING: 'PEER_HOST_PLUGIN_MISSING',
  VERSION_MISMATCH: 'PEER_HOST_VERSION_MISMATCH',
  IDENTITY_CHANGED: 'PEER_HOST_IDENTITY_CHANGED',
  UNREACHABLE: 'PEER_HOST_UNREACHABLE',
  RELAY_UNAVAILABLE: 'PEER_HOST_RELAY_UNAVAILABLE',
  AGGREGATE_UNAVAILABLE: 'PEER_HOST_AGGREGATE_UNAVAILABLE',
  STALE_GENERATION: 'PEER_HOST_STALE_GENERATION',
  AGGREGATED_TRANSPORT_UNSUPPORTED: 'PEER_HOST_AGGREGATED_TRANSPORT_UNSUPPORTED',
  AGGREGATED_MANIFEST_FORBIDDEN: 'PEER_HOST_AGGREGATED_MANIFEST_FORBIDDEN',
  AGGREGATED_BUNDLE_FORBIDDEN: 'PEER_HOST_AGGREGATED_BUNDLE_FORBIDDEN',
} as const

export type PeerHostErrorCode = typeof PEER_HOST_ERROR_CODES[keyof typeof PEER_HOST_ERROR_CODES]

/** 可安全返回 Client 的结构化错误，不携带凭据、完整 URL 或内容数据。 */
export interface PeerHostErrorShape {
  readonly code: PeerHostErrorCode
  readonly peerHostId?: string
  readonly message: string
}

/** 作用域管理器仍使用的兼容引用；新跨 Host 代码应优先使用 HostScope。 */
export interface ResourceScopeRef {
  hostId: string
  workspaceId: string
  targetHostId: string | null
  scopeGeneration: number
  sessionId?: string | null
}

export interface ResourceScopeInput {
  hostId: string
  workspaceId: string
  targetHostId: string | null
  sessionId?: string | null
}

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
