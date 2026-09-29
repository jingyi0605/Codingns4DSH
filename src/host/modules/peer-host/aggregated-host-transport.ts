import type {
  AggregatedHostCapabilitySummary,
  AggregatedHostFetchRequest,
  AggregatedHostGeneration,
  AggregatedHostLocalPluginBaseline,
  AggregatedHostManifestBoundary,
  AggregatedHostRpcRequest,
  AggregatedHostStreamRequest,
  AggregatedHostTransport,
  AggregatedHostWebSocketClient,
  HostScope,
  PeerHostErrorCode,
} from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_HTTP_PROXY_RULES, PeerHostHttpProxyService } from './host-api-proxy-service.js'
import { PeerHostWsProxyService, type PeerHostSocket } from './host-ws-proxy-service.js'
import { isDshNativeRemoteMethod, type DshNativeRemoteMethod } from './peer-host-native-protocol.js'

/** DSH Client 原生数据面允许的 RPC；未知 method 永远不会被转发到目标 Host。 */
export const AGGREGATED_HOST_RPC_ROUTES = Object.freeze({
  'workspace.list': { path: '/api/workspaces', method: 'GET' },
  'session.list': { path: '/api/sessions', method: 'GET' },
  'session.get': { path: '/api/sessions', method: 'GET' },
  'session.send': { path: '/api/sessions', method: 'POST' },
  'session.stop': { path: '/api/sessions', method: 'POST' },
  'session.permission_reply': { path: '/api/sessions', method: 'POST' },
  'session.answer': { path: '/api/sessions', method: 'POST' },
  'fileTree.get': { path: '/api/file-tree', method: 'GET' },
  'file.get': { path: '/api/files', method: 'GET' },
  'file.write': { path: '/api/files', method: 'PUT' },
  'git.get': { path: '/api/git', method: 'GET' },
  'git.mutate': { path: '/api/git', method: 'POST' },
  'terminal.get': { path: '/api/terminal', method: 'GET' },
  'terminal.mutate': { path: '/api/terminal', method: 'POST' },
  'rightTool.get': { path: '/api/right-tools', method: 'GET' },
  'rightTool.mutate': { path: '/api/right-tools', method: 'POST' },
} as const)

type AggregatedRpcMethod = keyof typeof AGGREGATED_HOST_RPC_ROUTES

export interface AggregatedHostLocalHandlers {
  readonly rpc?: (request: AggregatedHostRpcRequest) => Promise<unknown>
  readonly fetch?: (request: AggregatedHostFetchRequest) => Promise<Response>
  readonly openStream?: <TChunk>(request: AggregatedHostStreamRequest) => AsyncIterable<TChunk>
  readonly openWebSocket?: (client: AggregatedHostWebSocketClient, scope: HostScope) => Promise<() => void>
  readonly loadBundle?: (url: string) => Promise<void>
  readonly close?: () => Promise<void> | void
}

export interface AggregatedHostPeerHandlers {
  /** DSH 原生 Remote connector；未注入时禁止把原生方法降级成旧 HTTP RPC。 */
  readonly nativeRpc?: <TResponse>(peerHostId: string, request: AggregatedHostRpcRequest & { readonly method: DshNativeRemoteMethod }) => Promise<TResponse>
  readonly stream?: <TChunk>(peerHostId: string, request: AggregatedHostStreamRequest) => AsyncIterable<TChunk>
  /** DSH 原生 Remote stream connector；workspace/session follow 必须走此入口。 */
  readonly nativeStream?: <TChunk>(peerHostId: string, request: AggregatedHostStreamRequest & { readonly method: DshNativeRemoteMethod }) => AsyncIterable<TChunk>
  readonly reconnect?: (signal?: AbortSignal) => Promise<void>
}

export interface AggregatedHostTransportOptions {
  readonly localHostId: string
  readonly hostHome: string
  readonly localPlugin: AggregatedHostLocalPluginBaseline
  readonly capabilities: readonly AggregatedHostCapabilitySummary[]
  readonly initialGeneration?: number
  readonly now?: () => number
  readonly local?: AggregatedHostLocalHandlers
  readonly peer?: AggregatedHostPeerHandlers
  readonly httpProxy: PeerHostHttpProxyService
  readonly wsProxy: PeerHostWsProxyService
}

export class AggregatedHostTransportError extends Error {
  constructor(readonly code: PeerHostErrorCode, message: string) {
    super(message)
    this.name = 'AggregatedHostTransportError'
  }
}

/**
 * Host 侧 Aggregated Transport 路由器。
 *
 * 它只接受 HostScope 和固定 method/path，目标 Host 的 route、token 和 WebSocket
 * 连接始终由 Host 代理服务解析；普通插件的 `ctx.connection` 不会被修改。
 */
export class AggregatedHostTransportService implements AggregatedHostTransport {
  readonly kind = 'aggregated-host' as const
  readonly localPlugin: AggregatedHostLocalPluginBaseline
  private readonly listeners = new Set<(generation: AggregatedHostGeneration | undefined) => void>()
  private readonly capabilities: readonly AggregatedHostCapabilitySummary[]
  private readonly now: () => number
  private readonly localHostId: string
  private readonly hostHome: string
  private readonly local: AggregatedHostLocalHandlers
  private readonly peer: AggregatedHostPeerHandlers
  private readonly httpProxy: PeerHostHttpProxyService
  private readonly wsProxy: PeerHostWsProxyService
  private readonly disposers = new Set<() => void>()
  private generation: AggregatedHostGeneration | undefined
  private closed = false

  constructor(options: AggregatedHostTransportOptions) {
    this.localHostId = requiredText(options.localHostId, 'localHostId')
    this.hostHome = requiredText(options.hostHome, 'hostHome')
    this.localPlugin = validateLocalPlugin(options.localPlugin)
    this.capabilities = Object.freeze([...options.capabilities])
    this.now = options.now ?? Date.now
    this.local = options.local ?? {}
    this.peer = options.peer ?? {}
    this.httpProxy = options.httpProxy
    this.wsProxy = options.wsProxy
    const initialGeneration = options.initialGeneration ?? 0
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 0) throw new TypeError('Aggregated Host 初始 generation 无效')
    this.generation = this.createGeneration(initialGeneration)
  }

  getCapabilities(): readonly AggregatedHostCapabilitySummary[] {
    return this.capabilities
  }

  async rpc<TResponse = unknown>(request: AggregatedHostRpcRequest): Promise<TResponse> {
    this.ensureOpen()
    validateScope(request.scope, this.localHostId)
    if (isDshNativeRemoteMethod(request.method)) {
      if (request.scope.targetHostId === null) {
        if (this.local.rpc === undefined) throw unsupported('当前 Host 未提供 DSH 原生 Remote RPC')
        return await this.local.rpc(request) as TResponse
      }
      if (this.peer.nativeRpc === undefined) throw unsupported(`DSH 原生 Remote 尚未装配: ${request.method}`)
      return await this.peer.nativeRpc(request.scope.targetHostId, request as AggregatedHostRpcRequest & { readonly method: DshNativeRemoteMethod })
    }
    const route = readRpcRoute(request.method)
    if (request.scope.targetHostId === null) {
      if (this.local.rpc === undefined) throw unsupported('当前 Host 未提供 Aggregated RPC')
      return await this.local.rpc(request) as TResponse
    }
    const body = request.payload === undefined ? undefined : JSON.stringify(request.payload)
    const path = route.method === 'GET' ? appendRpcQuery(route.path, request.payload) : route.path
    const response = await this.httpProxy.request(request.scope.targetHostId, {
      scope: request.scope,
      path,
      method: route.method,
      ...(body === undefined ? {} : { body }),
    })
    return parseRpcResponse<TResponse>(response, request.method)
  }

  async fetch(request: AggregatedHostFetchRequest): Promise<Response> {
    this.ensureOpen()
    validateScope(request.scope, this.localHostId)
    const path = requiredPath(request.path)
    validateFetchRule(path, request.method ?? 'GET')
    if (request.scope.targetHostId === null) {
      if (this.local.fetch === undefined) throw unsupported('当前 Host 未提供 Aggregated fetch')
      return this.local.fetch({ ...request, path })
    }
    const response = await this.httpProxy.request(request.scope.targetHostId, {
      scope: request.scope,
      path,
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
    })
    return new Response(response.body, { status: response.status, headers: new Headers(Object.fromEntries(response.headers)) })
  }

  openStream<TChunk = unknown>(request: AggregatedHostStreamRequest): AsyncIterable<TChunk> {
    try {
      this.ensureOpen()
      validateScope(request.scope, this.localHostId)
      if (isDshNativeRemoteMethod(request.method)) {
        if (request.scope.targetHostId === null) {
          if (this.local.openStream === undefined) throw unsupported('当前 Host 未提供 DSH 原生 Remote stream')
          return this.local.openStream<TChunk>(request)
        }
        if (this.peer.nativeStream === undefined) throw unsupported(`DSH 原生 Remote stream 尚未装配: ${request.method}`)
        return this.peer.nativeStream<TChunk>(request.scope.targetHostId, request as AggregatedHostStreamRequest & { readonly method: DshNativeRemoteMethod })
      }
      if (request.scope.targetHostId === null) {
        if (this.local.openStream === undefined) throw unsupported('当前 Host 未提供 Aggregated stream')
        return this.local.openStream<TChunk>(request)
      }
      if (this.peer.stream === undefined) throw unsupported('目标 Host 暂不支持 Aggregated stream')
      if (!isAllowedRpcMethod(request.method)) throw unsupported('Aggregated stream method 未加入白名单')
      return this.peer.stream<TChunk>(request.scope.targetHostId, request)
    } catch (error) {
      return throwingStream(error)
    }
  }

  async openWebSocket(client: AggregatedHostWebSocketClient, scope: HostScope): Promise<() => void> {
    this.ensureOpen()
    validateScope(scope, this.localHostId)
    let dispose: () => void
    if (scope.targetHostId === null) {
      if (this.local.openWebSocket === undefined) throw unsupported('当前 Host 未提供 Aggregated WebSocket')
      dispose = await this.local.openWebSocket(client, scope)
    } else {
      dispose = await this.wsProxy.open(scope.targetHostId, client as PeerHostSocket, scope)
    }
    let active = true
    const cleanup = (): void => {
      if (!active) return
      active = false
      this.disposers.delete(cleanup)
      dispose()
    }
    this.disposers.add(cleanup)
    return cleanup
  }

  getGeneration(): AggregatedHostGeneration | undefined {
    return this.generation
  }

  onGenerationChange(listener: (generation: AggregatedHostGeneration | undefined) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async reconnect(signal?: AbortSignal): Promise<void> {
    this.ensureOpen()
    if (this.peer.reconnect === undefined) throw unsupported('Aggregated Host 未提供 reconnect')
    await this.peer.reconnect(signal)
    const previousId = this.generation?.id ?? -1
    this.publishGeneration(this.createGeneration(previousId + 1))
  }

  readManifest(): AggregatedHostManifestBoundary {
    return {
      source: 'local',
      plugin: this.localPlugin,
      remoteManifest: 'forbidden',
      remoteBundle: 'forbidden',
    }
  }

  async loadBundle(url: string): Promise<void> {
    if (typeof url !== 'string' || url.trim() === '' || isAbsoluteUrl(url)) {
      throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.AGGREGATED_BUNDLE_FORBIDDEN, 'Aggregated Host 不允许加载远端 Bundle')
    }
    if (this.local.loadBundle === undefined) throw unsupported('当前 Host 未提供本地 Bundle loader')
    await this.local.loadBundle(url)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const dispose of [...this.disposers]) dispose()
    this.disposers.clear()
    await this.local.close?.()
    const previous = this.generation
    this.generation = undefined
    if (previous !== undefined) for (const listener of [...this.listeners]) listener(undefined)
    this.listeners.clear()
  }

  private createGeneration(id: number): AggregatedHostGeneration {
    return { id, host: { home: this.hostHome }, connectedAt: this.now() }
  }

  private publishGeneration(generation: AggregatedHostGeneration): void {
    this.generation = generation
    for (const listener of [...this.listeners]) listener(generation)
  }

  private ensureOpen(): void {
    if (this.closed) throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.STALE_GENERATION, 'Aggregated Host Transport 已关闭')
  }
}

export { AggregatedHostTransportService as PeerHostAggregatedTransport }

function readRpcRoute(method: string): (typeof AGGREGATED_HOST_RPC_ROUTES)[AggregatedRpcMethod] {
  if (!isAllowedRpcMethod(method)) throw unsupported(`Aggregated RPC 未加入白名单: ${String(method)}`)
  return AGGREGATED_HOST_RPC_ROUTES[method]
}

function isAllowedRpcMethod(method: string): method is AggregatedRpcMethod {
  return typeof method === 'string' && Object.prototype.hasOwnProperty.call(AGGREGATED_HOST_RPC_ROUTES, method)
}

function parseRpcResponse<T>(response: { readonly status: number; readonly body: string }, method: string): T {
  let value: unknown
  try { value = response.body === '' ? undefined : JSON.parse(response.body) } catch { throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, `Aggregated RPC ${method} 响应不是 JSON`) }
  if (response.status < 200 || response.status >= 300) {
    const code = readErrorCode(value) ?? (response.status === 401 ? PEER_HOST_ERROR_CODES.SESSION_REQUIRED : PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE)
    throw new AggregatedHostTransportError(code, `Aggregated RPC ${method} 请求失败`)
  }
  return value as T
}

function readErrorCode(value: unknown): PeerHostErrorCode | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const error = (value as { readonly error?: unknown }).error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && Object.values(PEER_HOST_ERROR_CODES).includes(code as PeerHostErrorCode) ? code as PeerHostErrorCode : null
}

function validateScope(scope: HostScope, localHostId: string): void {
  if (scope.hostId !== localHostId || scope.workspaceId.trim() === '' || !Number.isSafeInteger(scope.scopeGeneration) || scope.scopeGeneration < 0) {
    throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'Aggregated Host 作用域不匹配')
  }
  if (scope.targetHostId !== null && scope.targetHostId.trim() === '') throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'Aggregated Host 目标 Host 无效')
  if (scope.sessionId !== null && scope.sessionId.trim() === '') throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'Aggregated Host 会话作用域无效')
}

function requiredPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('://') || path.includes('..')) throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'Aggregated fetch 路径未加入白名单')
  return path
}

function validateFetchRule(path: string, method: string): void {
  const url = new URL(path, 'http://aggregated-host.invalid')
  const allowedQuery = new Set(['workspaceId', 'sessionId', 'scopeGeneration', 'cursor', 'path', 'toolId'])
  for (const key of url.searchParams.keys()) if (!allowedQuery.has(key)) throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'Aggregated fetch 查询参数未加入白名单')
  const rule = PEER_HOST_HTTP_PROXY_RULES.find((candidate) => url.pathname === candidate.prefix || url.pathname.startsWith(`${candidate.prefix}/`))
  if (rule === undefined || !(rule.methods as readonly string[]).includes(method.toUpperCase())) throw new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'Aggregated fetch 路径或方法未加入白名单')
}

function appendRpcQuery(path: string, payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return path
  const query = new URLSearchParams()
  for (const key of ['workspaceId', 'sessionId', 'cursor', 'path', 'toolId']) {
    const value = (payload as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim() !== '') query.set(key, value)
  }
  const encoded = query.toString()
  return encoded === '' ? path : `${path}?${encoded}`
}

function requiredText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} 不能为空`)
  return value.trim()
}

function validateLocalPlugin(value: AggregatedHostLocalPluginBaseline): AggregatedHostLocalPluginBaseline {
  if (value.manifestSource !== 'local' || value.bundleSource !== 'local' || value.uiSource !== 'local' || value.allowRemoteManifest !== false || value.allowRemoteBundle !== false) throw new TypeError('Aggregated Host 必须使用本地插件基线')
  return Object.freeze({ ...value })
}

function unsupported(message: string): AggregatedHostTransportError {
  return new AggregatedHostTransportError(PEER_HOST_ERROR_CODES.AGGREGATED_TRANSPORT_UNSUPPORTED, message)
}

function isAbsoluteUrl(value: string): boolean {
  try { return new URL(value).protocol !== '' } catch { return false }
}

async function* throwingStream(error: unknown): AsyncIterable<never> {
  throw error
}
