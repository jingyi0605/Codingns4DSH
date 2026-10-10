import type { HostScope, PeerHostWebSocketEndpoint } from '../shared/contracts/peer-host.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'

export interface PeerHostEventSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: any[]) => void): void
}

export interface PeerHostEventSubscription {
  readonly close: () => void
  /**
   * 向当前 PeerHost 作用域发送白名单消息。作用域字段由适配器注入，调用方不能覆盖。
   */
  readonly send: (type: PeerHostClientMessageType, payload?: Readonly<Record<string, unknown>>) => void
  readonly terminalInput: (payload: Readonly<Record<string, unknown>>) => void
  readonly terminalResize: (payload: Readonly<Record<string, unknown>>) => void
  readonly terminalClose: (payload?: Readonly<Record<string, unknown>>) => void
  readonly rightToolSubscribe: (payload: Readonly<Record<string, unknown>>) => void
  readonly rightToolRefresh: (payload?: Readonly<Record<string, unknown>>) => void
  readonly rightToolClose: (payload?: Readonly<Record<string, unknown>>) => void
}

export type PeerHostEventSocketFactory = (scope: HostScope) => Promise<PeerHostEventSocket>

export type PeerHostEventListener = (event: Record<string, unknown>) => void

/** Client 到目标 Host 的 WebSocket 消息白名单。未知类型不会被透传。 */
export type PeerHostClientMessageType =
  | 'workbench.subscribe' | 'workbench.refresh' | 'fileTree.subscribe' | 'fileTree.refresh'
  | 'git.subscribe' | 'git.refresh' | 'session.subscribe' | 'session.load_older'
  | 'session.send' | 'session.stop' | 'session.permission_reply' | 'session.answer'
  | 'terminal.subscribe' | 'terminal.input' | 'terminal.resize' | 'terminal.close'
  | 'rightTool.subscribe' | 'rightTool.refresh' | 'rightTool.close'

export interface PeerHostEventStreamOptions {
  /** 连接关闭后最多重试次数；默认 4 次，避免无限创建计时器。 */
  readonly maxReconnectAttempts?: number
  /** 每次重试等待时间，超出数组长度后使用最后一个值。 */
  readonly reconnectDelaysMs?: readonly number[]
}

/** 根据当前 Host 自有端点生成作用域 WebSocket 工厂；不接受目标 Host URL。 */
export function createPeerHostWebSocketFactory(endpoint: PeerHostWebSocketEndpoint, options: { readonly host?: string; readonly protocol?: 'ws' | 'wss' } = {}): PeerHostEventSocketFactory {
  if (!Number.isSafeInteger(endpoint.port) || endpoint.port < 0 || endpoint.port > 65_535) throw new TypeError('PeerHost WebSocket 端口无效')
  const path = endpoint.path.startsWith('/api/') && !endpoint.path.includes('..') ? endpoint.path : (() => { throw new TypeError('PeerHost WebSocket 路径无效') })()
  return async (scope) => {
    assertPeerScope(scope)
    const host = options.host?.trim() || wildcardHost(endpoint.host) || currentLocationHost()
    if (host === '') throw new Error('无法解析当前 Host WebSocket 地址')
    const protocol = options.protocol ?? currentLocationProtocol()
    const url = new URL(`${protocol}://${host}:${String(endpoint.port)}${path}`)
    url.searchParams.set('hostId', scope.hostId)
    url.searchParams.set('targetHostId', scope.targetHostId!)
    url.searchParams.set('workspaceId', scope.workspaceId)
    if (scope.sessionId !== null) url.searchParams.set('sessionId', scope.sessionId)
    url.searchParams.set('scopeGeneration', String(scope.scopeGeneration))
    const WebSocketCtor = globalThis.WebSocket
    if (typeof WebSocketCtor !== 'function') throw new Error('当前运行时没有 WebSocket')
    return adaptBrowserWebSocket(new WebSocketCtor(url))
  }
}

/** 将浏览器标准 WebSocket 事件适配为 Client 事件流使用的轻量接口。 */
function adaptBrowserWebSocket(socket: WebSocket): PeerHostEventSocket {
  return {
    get readyState() { return socket.readyState },
    send(data: string): void { socket.send(data) },
    close(code?: number, reason?: string): void { socket.close(code, reason) },
    on(event, listener): void {
      if (event === 'message') {
        socket.addEventListener('message', (message) => listener(message.data, typeof message.data !== 'string'))
        return
      }
      socket.addEventListener(event, (...args: unknown[]) => listener(...args))
    },
  }
}

export interface PeerHostProxyResponse {
  readonly status: number
  readonly headers: readonly [string, string][]
  readonly body: string
  /** 二进制响应通过 Host RPC 的 Base64 字段传递；文本响应仍使用 body。 */
  readonly bodyBase64?: string
}

export interface PeerHostScopedClient {
  request(scope: HostScope, path: string, options?: { readonly method?: string; readonly body?: string; readonly signal?: AbortSignal }): Promise<PeerHostProxyResponse>
  loadSessionHistory(scope: HostScope, cursor?: string): Promise<PeerHostProxyResponse>
  sendMessage(scope: HostScope, body: string): Promise<PeerHostProxyResponse>
  stopSession(scope: HostScope): Promise<PeerHostProxyResponse>
  replyPermission(scope: HostScope, body: string): Promise<PeerHostProxyResponse>
  answerQuestion(scope: HostScope, body: string): Promise<PeerHostProxyResponse>
  readFile(scope: HostScope, path: string): Promise<PeerHostProxyResponse>
  writeFile(scope: HostScope, body: string): Promise<PeerHostProxyResponse>
  gitStatus(scope: HostScope): Promise<PeerHostProxyResponse>
  terminal(scope: HostScope, action: 'create' | 'input' | 'resize' | 'close', body?: string): Promise<PeerHostProxyResponse>
  rightTool(scope: HostScope, action: 'open' | 'refresh' | 'close', body?: string): Promise<PeerHostProxyResponse>
  /**
   * 接入已经完成 Host 侧升级握手的事件流。
   *
   * 插件自有网关端点由 `peerHost/wsEndpoint` 提供；调用方必须显式提供
   * socketFactory，避免在适配器内部猜测当前 Host 地址。
   */
  openEventStream(scope: HostScope, socketFactory: PeerHostEventSocketFactory, listener: PeerHostEventListener, options?: PeerHostEventStreamOptions): Promise<PeerHostEventSubscription>
}

/** Client 侧远端资源适配器；每一次请求都从 HostScope 生成，不保存目标凭据。 */
export function createPeerHostScopedClient(rpc: CodingNsRpcClient): PeerHostScopedClient {
  const request = async (scope: HostScope, path: string, options: { readonly method?: string; readonly body?: string; readonly signal?: AbortSignal } = {}): Promise<PeerHostProxyResponse> => {
    options.signal?.throwIfAborted()
    assertPeerScope(scope)
    if (!path.startsWith('/api/') || path.includes('://')) throw new TypeError('PeerHost 代理路径必须是固定 API 路径')
    const payload = {
      peerHostId: scope.targetHostId,
      scope,
      path,
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.body === undefined ? {} : { body: options.body }),
    }
    let result
    try {
      result = await rpc.call(CODINGNS_RPC_CHANNEL, 'peerHost/request', payload, options.signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/HTTP (?:404|405)\b/u.test(message)) throw error
      options.signal?.throwIfAborted()
      result = await rpc.call('/api', 'codingns/peerHost/request', payload, options.signal)
    }
    options.signal?.throwIfAborted()
    if (!result.ok) throw new Error(result.error.message)
    return result.value as PeerHostProxyResponse
  }
  return {
    request,
    loadSessionHistory: (scope, cursor) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/history${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`),
    sendMessage: (scope, body) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/messages`, { method: 'POST', body }),
    stopSession: (scope) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/stop`, { method: 'POST', body: '{}' }),
    replyPermission: (scope, body) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/permission`, { method: 'POST', body }),
    answerQuestion: (scope, body) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/answer`, { method: 'POST', body }),
    readFile: (scope, path) => request(scope, `/api/files?path=${encodeURIComponent(path)}`),
    writeFile: (scope, body) => request(scope, '/api/files', { method: 'PUT', body }),
    gitStatus: (scope) => request(scope, '/api/git/status'),
    terminal: (scope, action, body) => request(scope, `/api/terminal/${action}`, { method: 'POST', ...(body === undefined ? {} : { body }) }),
    rightTool: (scope, action, body) => request(scope, `/api/right-tools/${action}`, { method: 'POST', ...(body === undefined ? {} : { body }) }),
    openEventStream: (scope, socketFactory, listener, options) => openEventStream(scope, socketFactory, listener, options),
  }
}

const OPEN = 1
const CLOSED = 3
const SOCKET_OPEN_TIMEOUT_MS = 15_000
const PEER_HOST_EVENT_TYPES = new Set([
  'peerHost.error',
  'system.connected', 'workbench.snapshot', 'workbench.delta', 'fileTree.snapshot',
  'git.snapshot', 'session.subscribed', 'session.backfill', 'session.delta',
  'session.runtime_message', 'session.runtime_status', 'session.activity',
  'session.permission_request', 'session.error', 'terminal.output', 'terminal.status',
  'terminal.exit', 'terminal.error', 'rightTool.snapshot', 'rightTool.delta',
])

async function openEventStream(scope: HostScope, socketFactory: PeerHostEventSocketFactory, listener: PeerHostEventListener, options: PeerHostEventStreamOptions = {}): Promise<PeerHostEventSubscription> {
  assertPeerScope(scope)
  const maxReconnectAttempts = normalizeReconnectAttempts(options.maxReconnectAttempts)
  const reconnectDelaysMs = normalizeReconnectDelays(options.reconnectDelaysMs)
  const initialSocket = await socketFactory(scope)
  try {
    await waitForSocketOpen(initialSocket)
  } catch (error) {
    closeSocket(initialSocket, 1011, 'PeerHost WebSocket open failed')
    throw error
  }
  let socket = initialSocket
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempt = 0
  let connecting = false
  let pendingSocket: PeerHostEventSocket | undefined
  const replayableSubscriptions = new Map<PeerHostClientMessageType, Readonly<Record<string, unknown>>>()

  const close = (): void => {
    if (closed) return
    closed = true
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    closeSocket(socket, 1000, 'PeerHost scope disposed')
    if (pendingSocket !== undefined && pendingSocket !== socket) closeSocket(pendingSocket, 1000, 'PeerHost scope disposed')
  }

  const send = (type: PeerHostClientMessageType, payload: Readonly<Record<string, unknown>> = {}): void => {
    if (!PEER_HOST_CLIENT_MESSAGE_TYPES.has(type)) throw new Error('PeerHost WebSocket 消息未加入白名单')
    assertMessagePayload(payload)
    if (closed || socket.readyState !== OPEN) throw new Error('PeerHost WebSocket 尚未连接')
    socket.send(JSON.stringify({ type, ...scope, ...payload }))
    if (PEER_HOST_REPLAYABLE_MESSAGE_TYPES.has(type)) replayableSubscriptions.set(type, { ...payload })
  }
  const terminalInput = (payload: Readonly<Record<string, unknown>>): void => { send('terminal.input', payload) }
  const terminalResize = (payload: Readonly<Record<string, unknown>>): void => { send('terminal.resize', payload) }
  const terminalClose = (payload: Readonly<Record<string, unknown>> = {}): void => { send('terminal.close', payload) }
  const rightToolSubscribe = (payload: Readonly<Record<string, unknown>>): void => { send('rightTool.subscribe', payload) }
  const rightToolRefresh = (payload: Readonly<Record<string, unknown>> = {}): void => { send('rightTool.refresh', payload) }
  const rightToolClose = (payload: Readonly<Record<string, unknown>> = {}): void => { send('rightTool.close', payload) }

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== undefined || reconnectAttempt >= maxReconnectAttempts) return
    const delay = reconnectDelaysMs[Math.min(reconnectAttempt, reconnectDelaysMs.length - 1)]!
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void reconnect()
    }, delay)
  }
  const attach = (next: PeerHostEventSocket): void => {
    socket = next
    const current = next
    current.on('message', (data: unknown, isBinary?: boolean) => {
      if (closed || isBinary === true || typeof data !== 'string') return
      const event = parseScopedEvent(data, scope)
      if (event !== null) listener(event)
    })
    current.on('close', () => {
      if (!closed && socket === current) scheduleReconnect()
    })
    current.on('error', () => {
      if (closed || socket !== current) return
      if (current.readyState === OPEN) current.close(1011, 'PeerHost WebSocket connection error')
      else scheduleReconnect()
    })
    replaySubscriptions(current)
  }
  const reconnect = async (): Promise<void> => {
    if (closed || connecting) return
    connecting = true
    try {
      const next = await socketFactory(scope)
      pendingSocket = next
      await waitForSocketOpen(next)
      pendingSocket = undefined
      if (closed) {
        closeSocket(next, 1000, 'PeerHost scope disposed')
        return
      }
      reconnectAttempt = 0
      attach(next)
    } catch {
      pendingSocket = undefined
      scheduleReconnect()
    } finally {
      connecting = false
    }
  }
  attach(socket)
  return { close, send, terminalInput, terminalResize, terminalClose, rightToolSubscribe, rightToolRefresh, rightToolClose }

  function replaySubscriptions(current: PeerHostEventSocket): void {
    if (current.readyState !== OPEN) return
    for (const [type, payload] of replayableSubscriptions) {
      current.send(JSON.stringify({ type, ...scope, ...payload }))
    }
  }
}

async function waitForSocketOpen(socket: PeerHostEventSocket): Promise<void> {
  if (socket.readyState === OPEN) return
  if (socket.readyState === CLOSED) throw new Error('PeerHost WebSocket 在打开前关闭')
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const timer = setTimeout(() => finish(new Error('PeerHost WebSocket 打开超时')), SOCKET_OPEN_TIMEOUT_MS)
    socket.on('open', () => finish())
    socket.on('close', () => finish(new Error('PeerHost WebSocket 在打开前关闭')))
    socket.on('error', () => finish(new Error('PeerHost WebSocket 打开失败')))
  })
}

function closeSocket(socket: PeerHostEventSocket, code: number, reason: string): void {
  if (socket.readyState !== CLOSED) socket.close(code, reason)
}

const PEER_HOST_CLIENT_MESSAGE_TYPES = new Set<PeerHostClientMessageType>([
  'workbench.subscribe', 'workbench.refresh', 'fileTree.subscribe', 'fileTree.refresh',
  'git.subscribe', 'git.refresh', 'session.subscribe', 'session.load_older',
  'session.send', 'session.stop', 'session.permission_reply', 'session.answer',
  'terminal.subscribe', 'terminal.input', 'terminal.resize', 'terminal.close',
  'rightTool.subscribe', 'rightTool.refresh', 'rightTool.close',
])

/** 这些消息描述可重建的订阅，重连后可以安全重放；命令和输入绝不能重放。 */
const PEER_HOST_REPLAYABLE_MESSAGE_TYPES = new Set<PeerHostClientMessageType>([
  'workbench.subscribe', 'fileTree.subscribe', 'git.subscribe', 'session.subscribe', 'terminal.subscribe', 'rightTool.subscribe',
])

function parseScopedEvent(raw: string, expected: HostScope): Record<string, unknown> | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string' || !PEER_HOST_EVENT_TYPES.has(event.type)) return null
  if (requiresSession(event.type) && (typeof event.sessionId !== 'string' || event.sessionId.trim() === '')) return null
  if (event.hostId !== expected.hostId || event.targetHostId !== expected.targetHostId || event.workspaceId !== expected.workspaceId || event.scopeGeneration !== expected.scopeGeneration) return null
  const eventSessionId = typeof event.sessionId === 'string' && event.sessionId.trim() !== '' ? event.sessionId : null
  if (eventSessionId !== expected.sessionId) return null
  return event
}

function requiresSession(type: string): boolean {
  return type.startsWith('session.')
}

function assertMessagePayload(payload: Readonly<Record<string, unknown>>): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('PeerHost WebSocket 消息参数必须是对象')
  for (const key of ['type', 'hostId', 'targetHostId', 'workspaceId', 'sessionId', 'scopeGeneration']) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) throw new TypeError('PeerHost WebSocket 消息不得覆盖作用域字段')
  }
}

function normalizeReconnectAttempts(value: number | undefined): number {
  if (value === undefined) return 4
  if (!Number.isSafeInteger(value) || value < 0 || value > 8) throw new TypeError('PeerHost WebSocket 重连次数无效')
  return value
}

function normalizeReconnectDelays(value: readonly number[] | undefined): readonly number[] {
  const delays = value === undefined ? [100, 250, 500, 1000] : [...value]
  if (delays.length === 0 || delays.some((item) => !Number.isSafeInteger(item) || item < 0 || item > 30_000)) throw new TypeError('PeerHost WebSocket 重连等待时间无效')
  return delays
}

function requireSession(scope: HostScope): HostScope {
  assertPeerScope(scope)
  if (scope.sessionId === null || scope.sessionId.trim() === '') throw new TypeError('会话操作必须包含 sessionId')
  return scope
}

function assertPeerScope(scope: HostScope): void {
  if (scope.targetHostId === null || scope.targetHostId.trim() === '') throw new TypeError('PeerHost 作用域必须包含 targetHostId')
  if (scope.hostId.trim() === '' || scope.workspaceId.trim() === '' || !Number.isSafeInteger(scope.scopeGeneration) || scope.scopeGeneration < 0) throw new TypeError('PeerHost 作用域无效')
}

function wildcardHost(value: string): string {
  const host = value.trim()
  return host === '0.0.0.0' || host === '::' || host === '[::]' ? '' : host
}

function currentLocationHost(): string {
  const location = (globalThis as { location?: { hostname?: string } }).location
  return location?.hostname?.trim() ?? ''
}

function currentLocationProtocol(): 'ws' | 'wss' {
  const location = (globalThis as { location?: { protocol?: string } }).location
  return location?.protocol === 'https:' ? 'wss' : 'ws'
}
