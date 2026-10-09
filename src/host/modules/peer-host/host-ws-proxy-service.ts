import type { HostScope, PeerHostErrorCode, PeerHostRecord } from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'
import { isPeerHostTransientStatus, PeerHostSessionService } from './peer-host-session.js'
import { PeerHostStore } from './peer-host-store.js'
import { PeerHostConnectorError } from './host-ws-connector.js'
import { peerHostSafeError } from './peer-host-diagnostics.js'

export const PEER_HOST_WS_CLIENT_MESSAGE_TYPES = new Set([
  'workbench.subscribe', 'workbench.refresh', 'fileTree.subscribe', 'fileTree.refresh',
  'git.subscribe', 'git.refresh', 'session.subscribe', 'session.load_older',
  'session.send', 'session.stop', 'session.permission_reply', 'session.answer',
  'terminal.subscribe', 'terminal.input', 'terminal.resize', 'terminal.close',
  'rightTool.subscribe', 'rightTool.refresh', 'rightTool.close',
])

export const PEER_HOST_WS_REMOTE_MESSAGE_TYPES = new Set([
  'system.connected', 'workbench.snapshot', 'workbench.delta', 'fileTree.snapshot',
  'git.snapshot', 'session.subscribed', 'session.backfill', 'session.delta',
  'session.runtime_message', 'session.runtime_status', 'session.activity',
  'session.permission_request', 'session.error', 'terminal.output', 'terminal.status',
  'terminal.exit', 'terminal.error', 'rightTool.snapshot', 'rightTool.delta',
])

const OPEN = 1
const MAX_QUEUE = 128

export interface PeerHostSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message' | 'close' | 'error', listener: (...args: any[]) => void): void
}

export type PeerHostRemoteConnector = (record: PeerHostRecord, accessToken: string, scope: HostScope) => Promise<PeerHostSocket>

export class PeerHostWsProxyError extends Error {
  constructor(readonly code: PeerHostErrorCode, message: string) {
    super(message)
    this.name = 'PeerHostWsProxyError'
  }
}

/** PeerHost WebSocket 双端代理；只转发带完整作用域的白名单消息。 */
export class PeerHostWsProxyService {
  constructor(
    private readonly store: PeerHostStore,
    private readonly sessions: PeerHostSessionService,
    private readonly connectRemote: PeerHostRemoteConnector,
  ) {}

  async open(peerHostId: string, client: PeerHostSocket, scope: HostScope): Promise<() => void> {
    // 连接状态是缓存值；已有握手失效时仍允许实时数据面自行验证目标。
    const record = await this.requireReady(peerHostId, true)
    assertScopeTarget(scope, peerHostId)
    const accessToken = await this.sessions.getAccessToken(peerHostId, true)
    let remote: PeerHostSocket
    try {
      remote = await this.connectRemote(record, accessToken, scope)
    } catch (error) {
      if (error instanceof PeerHostConnectorError && error.code === PEER_HOST_ERROR_CODES.SESSION_REQUIRED) {
        await this.sessions.invalidate(peerHostId)
        throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SESSION_REQUIRED, '目标 Host 登录态已失效')
      }
      if (error instanceof PeerHostConnectorError) throw new PeerHostWsProxyError(error.code, peerHostSafeError(error.code).message)
      throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE, '目标 Host 代理连接失败')
    }
    let closed = false
    const remoteQueue: string[] = []
    const clientQueue: string[] = []
    const closeBoth = (code = 1000, reason = 'peer host proxy closed'): void => {
      if (closed) return
      closed = true
      if (client.readyState === OPEN) client.close(code, reason)
      if (remote.readyState === OPEN) remote.close(code, reason)
    }
    const sendClientError = (code: PeerHostErrorCode, message: string): void => {
      if (client.readyState === OPEN) client.send(JSON.stringify({ type: 'peerHost.error', ...scope, error_code: code, message }))
    }
    const forward = (socket: PeerHostSocket, raw: string, queue: string[]): void => {
      if (socket.readyState !== OPEN) {
        if (queue.length >= MAX_QUEUE) {
          queue.shift()
          sendClientError(PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE, 'PeerHost 实时消息队列已满')
        }
        queue.push(raw)
        return
      }
      socket.send(raw)
    }
    const flush = (): void => {
      while (remoteQueue.length > 0 && remote.readyState === OPEN) remote.send(remoteQueue.shift()!)
      while (clientQueue.length > 0 && client.readyState === OPEN) client.send(clientQueue.shift()!)
    }

    client.on('message', (data: unknown, isBinary?: boolean) => {
      if (isBinary === true || typeof data !== 'string') {
        sendClientError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'PeerHost WebSocket 不支持二进制消息')
        return
      }
      const parsed = parseScopedMessage(data, scope, PEER_HOST_WS_CLIENT_MESSAGE_TYPES)
      if (parsed.error !== null) {
        sendClientError(parsed.error.code, parsed.error.message)
        return
      }
      forward(remote, data, remoteQueue)
    })
    remote.on('message', (data: unknown, isBinary?: boolean) => {
      if (isBinary === true || typeof data !== 'string') {
        sendClientError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, 'PeerHost 目标消息格式无效')
        return
      }
      const parsed = parseScopedMessage(data, scope, PEER_HOST_WS_REMOTE_MESSAGE_TYPES)
      if (parsed.error !== null) {
        sendClientError(parsed.error.code, parsed.error.message)
        return
      }
      forward(client, data, clientQueue)
    })
    client.on('close', () => closeBoth())
    remote.on('close', () => closeBoth(1011, 'target peer host closed'))
    client.on('error', () => closeBoth(1011, 'client socket failed'))
    remote.on('error', () => closeBoth(1011, 'target peer host failed'))
    flush()
    return () => closeBoth()
  }

  private async requireReady(peerHostId: string, allowTransientStatus = false): Promise<PeerHostRecord> {
    const record = await this.store.get(peerHostId)
    if (record === null) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.NOT_FOUND, 'PeerHost 不存在')
    const allowed = record.status === 'ready' || allowTransientStatus && isPeerHostTransientStatus(record.status)
    if (!allowed) throw new PeerHostWsProxyError(record.status === 'session_required' ? PEER_HOST_ERROR_CODES.SESSION_REQUIRED : PEER_HOST_ERROR_CODES.NOT_READY, 'PeerHost 尚未准备好实时代理')
    if (record.route.kind !== 'lan') throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE, '中转 PeerHost 暂不可用')
    return record
  }
}

function assertScopeTarget(scope: HostScope, peerHostId: string): void {
  if (!scope.hostId || scope.targetHostId !== peerHostId || !scope.workspaceId || !Number.isSafeInteger(scope.scopeGeneration) || scope.scopeGeneration < 0) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 作用域不匹配')
}

function parseScopedMessage(raw: string, expected: HostScope, allowed: ReadonlySet<string>): { error: PeerHostWsProxyError | null } {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { error: new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, 'PeerHost WebSocket 消息不是 JSON') } }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, 'PeerHost WebSocket 消息格式无效') }
  const message = value as Record<string, unknown>
  if (typeof message.type !== 'string' || !allowed.has(message.type)) return { error: new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.TOOL_UNSUPPORTED, 'PeerHost WebSocket 消息未加入白名单') }
  if (requiresSession(message.type) && (typeof message.sessionId !== 'string' || message.sessionId.trim() === '')) return { error: new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost 会话消息缺少 sessionId') }
  const messageSessionId = typeof message.sessionId === 'string' && message.sessionId.trim() !== '' ? message.sessionId : null
  if (message.hostId !== expected.hostId || message.targetHostId !== expected.targetHostId || message.workspaceId !== expected.workspaceId || message.scopeGeneration !== expected.scopeGeneration || messageSessionId !== expected.sessionId) return { error: new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 消息作用域不匹配') }
  return { error: null }
}

function requiresSession(type: string): boolean {
  return type.startsWith('session.')
}
