import { randomUUID } from 'node:crypto'
import type { HostScope, PeerHostErrorCode, PeerHostRecord } from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'
import { isPeerHostTransientStatus, PeerHostSessionError, PeerHostSessionService } from './peer-host-session.js'
import { PeerHostStore } from './peer-host-store.js'
import { peerHostSafeError } from './peer-host-diagnostics.js'
import { isPeerHostHttpRoute } from '../../../shared/peer-host-http-routes.js'
import { isPeerHostRequestCancellation, throwIfPeerHostRequestAborted } from './peer-host-request-errors.js'
// 保持已有导入入口兼容；路由表由发送端与目标端共同维护。
export { PEER_HOST_HTTP_PROXY_RULES } from '../../../shared/peer-host-http-routes.js'

const MAX_PROXY_BODY_BYTES = 4 * 1024 * 1024
const ALLOWED_QUERY = new Set(['workspaceId', 'sessionId', 'scopeGeneration', 'cursor', 'path', 'toolId'])
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization'])
const ALLOWED_CLIENT_HEADERS = new Set(['accept', 'content-type', 'if-match', 'if-none-match', 'range'])
const AUTH_CHECK_PATH = '/api/codingns/host/status'

export class PeerHostProxyError extends Error {
  constructor(readonly code: PeerHostErrorCode, message: string) {
    super(message)
    this.name = 'PeerHostProxyError'
  }
}

/** 当前 Host 到目标 Host 的 HTTP 正向代理。 */
export class PeerHostHttpProxyService {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly store: PeerHostStore,
    private readonly sessions: PeerHostSessionService,
    options: { readonly fetchImpl?: typeof fetch } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async handle(peerHostId: string, request: Request, onFailure?: (error: unknown) => void): Promise<Response> {
    try {
      throwIfPeerHostRequestAborted(request.signal)
      // 握手状态可能滞后于已经建立的数据面连接；让真实代理请求重新验证目标，
      // 失败时仍由响应错误和上层缓存恢复逻辑判定为断线。
      const record = await this.requireReady(peerHostId, true)
      const scope = readScope(request.headers, peerHostId)
      const targetPath = parseProxyPath(request.url)
      validateQuery(targetPath)
      validateRule(request.method, targetPath.pathname)
      const body = await readBody(request)
      let accessToken = await this.sessions.getAccessToken(peerHostId, true)
      const targetUrl = buildTargetUrl(record, targetPath)
      const send = (token: string) => {
        throwIfPeerHostRequestAborted(request.signal)
        return this.fetchImpl(targetUrl, {
          method: request.method,
          headers: buildForwardHeaders(request.headers, token),
          signal: request.signal,
          ...(body === undefined ? {} : { body }),
        })
      }
      let response = await send(accessToken)
      if (response.status === 401) {
        await response.body?.cancel()
        await this.assertTokenRejected(record, targetPath.pathname, accessToken, request.signal)
        accessToken = await this.sessions.recoverAccessToken(peerHostId, accessToken, true)
        // 仅在明确收到 401 且票据恢复后重放一次；网络错误不重放，避免重复执行业务。
        response = await send(accessToken)
        if (response.status === 401) {
          await response.body?.cancel()
          await this.assertTokenRejected(record, targetPath.pathname, accessToken, request.signal)
          throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.SESSION_REQUIRED, '目标 Host 登录态已失效')
        }
      }
      return await forwardResponse(response, scope)
    } catch (error) {
      // 取消必须继续向上传播，不能被包装成 502 后触发重试或故障日志。
      if (isPeerHostRequestCancellation(error, request.signal)) {
        throwIfPeerHostRequestAborted(request.signal)
        throw error
      }
      onFailure?.(error)
      return errorResponse(error)
    }
  }

  /**
   * 旧版目标未放行插件 RPC 时也返回 401，不能据此清理整台 Host 的登录态。
   * 用固定只读状态接口验证同一票据；检查本身失败时保留凭据并报告检查错误。
   */
  private async assertTokenRejected(record: PeerHostRecord, path: string, accessToken: string, signal: AbortSignal): Promise<void> {
    if (path === AUTH_CHECK_PATH) return
    const response = await this.fetchImpl(buildTargetUrl(record, new URL(AUTH_CHECK_PATH, 'http://peer-host.invalid')), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ rpcId: `peer-host-auth-check-${randomUUID()}`, method: 'host/status', payload: {} }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401) return
      throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE, '目标 Host 登录检查失败')
    }
    const value = await response.json().catch(() => null) as { result?: { ok?: unknown } } | null
    if (typeof value?.result?.ok !== 'boolean') throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, '目标 Host 登录检查响应无效')
    throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_ACCESS_DENIED, '目标 Host 登录有效，但接口访问被拒绝')
  }

  /** 将 RPC 的结构化请求转换为同一条 HTTP 白名单代理；不接受绝对 URL。 */
  async request(peerHostId: string, input: {
    readonly scope: HostScope
    readonly path: string
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal?: AbortSignal
    /** Host 内部的诊断回调；底层异常不得进入返回给客户端的代理响应。 */
    readonly onFailure?: (error: unknown) => void
  }): Promise<{ readonly status: number; readonly headers: readonly [string, string][]; readonly body: string }> {
    const path = typeof input.path === 'string' ? input.path : ''
    if (!path.startsWith('/api/') || path.includes('://')) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'PeerHost 代理路径必须是固定 API 路径')
    const method = (input.method ?? 'GET').toUpperCase()
    const body = input.body === undefined ? undefined : String(input.body)
    if (body !== undefined && new TextEncoder().encode(body).byteLength > MAX_PROXY_BODY_BYTES) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'PeerHost 代理请求体过大')
    const headers = new Headers({
      'x-codingns-host-id': input.scope.hostId,
      'x-codingns-target-host-id': input.scope.targetHostId ?? '',
      'x-codingns-workspace-id': input.scope.workspaceId,
      'x-codingns-scope-generation': String(input.scope.scopeGeneration),
      ...(input.scope.sessionId === null ? {} : { 'x-codingns-session-id': input.scope.sessionId }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    })
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (ALLOWED_CLIENT_HEADERS.has(name.toLowerCase())) headers.set(name, value)
    }
    const response = await this.handle(peerHostId, new Request(new URL(path, 'http://peer-host.invalid'), {
      method, headers, ...(body === undefined ? {} : { body }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }), input.onFailure)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (response.body !== null && !contentType.includes('json') && !contentType.startsWith('text/')) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, '目标 Host 返回了不支持的响应类型')
    return { status: response.status, headers: [...response.headers.entries()], body: await response.text() }
  }

  private async requireReady(peerHostId: string, allowTransientStatus = false): Promise<PeerHostRecord> {
    const record = await this.store.get(peerHostId)
    if (record === null) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.NOT_FOUND, 'PeerHost 不存在')
    const allowed = record.status === 'ready' || record.status === 'session_required' || allowTransientStatus && isPeerHostTransientStatus(record.status)
    if (!allowed) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.NOT_READY, 'PeerHost 尚未准备好代理')
    if (record.route.kind !== 'lan') throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE, '中转 PeerHost 暂不可用')
    return record
  }
}

function readScope(headers: Headers, peerHostId: string): HostScope {
  const hostId = headers.get('x-codingns-host-id')?.trim() ?? ''
  const targetHostId = headers.get('x-codingns-target-host-id')?.trim() ?? ''
  const workspaceId = headers.get('x-codingns-workspace-id')?.trim() ?? ''
  const sessionHeader = headers.get('x-codingns-session-id')
  const generation = Number(headers.get('x-codingns-scope-generation'))
  if (!hostId || targetHostId !== peerHostId || !workspaceId || !Number.isSafeInteger(generation) || generation < 0) {
    throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost 请求作用域不匹配')
  }
  return { hostId, targetHostId, workspaceId, sessionId: sessionHeader?.trim() || null, scopeGeneration: generation }
}

function parseProxyPath(rawUrl: string): URL {
  const url = new URL(rawUrl)
  if (!url.pathname.startsWith('/api/')) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'PeerHost 代理路径不在 API 范围内')
  return url
}

function validateQuery(url: URL): void {
  for (const key of url.searchParams.keys()) if (!ALLOWED_QUERY.has(key)) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'PeerHost 代理查询参数未加入白名单')
}

function validateRule(method: string, pathname: string): void {
  if (!isPeerHostHttpRoute(method, pathname)) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'PeerHost 代理路径或方法未加入白名单')
}

async function readBody(request: Request): Promise<string | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BODY_BYTES) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'PeerHost 代理请求体过大')
  const body = await request.text()
  if (new TextEncoder().encode(body).byteLength > MAX_PROXY_BODY_BYTES) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED, 'PeerHost 代理请求体过大')
  return body
}

function buildTargetUrl(record: PeerHostRecord, source: URL): string {
  if (record.route.kind !== 'lan') throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE, '中转 PeerHost 暂不可用')
  return new URL(`${source.pathname}${source.search}`, record.route.normalizedOrigin).toString()
}

function buildForwardHeaders(source: Headers, accessToken: string): Headers {
  const headers = new Headers()
  source.forEach((value, name) => {
    const normalized = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized.startsWith('x-codingns-')) return
    if (normalized === 'content-length') return
    headers.set(name, value)
  })
  headers.set('authorization', `Bearer ${accessToken}`)
  return headers
}

async function forwardResponse(response: Response, scope: HostScope): Promise<Response> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (response.body !== null && !contentType.includes('json') && !contentType.startsWith('text/')) throw new PeerHostProxyError(PEER_HOST_ERROR_CODES.RESPONSE_INVALID, '目标 Host 返回了不支持的响应类型')
  const headers = new Headers()
  response.headers.forEach((value, name) => { if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.set(name, value) })
  headers.set('x-codingns-scope-generation', String(scope.scopeGeneration))
  return new Response(response.body, { status: response.status, headers })
}

function errorResponse(error: unknown): Response {
  const code = resolveErrorCode(error)
  const message = peerHostSafeError(code).message
  const status = code === PEER_HOST_ERROR_CODES.SCOPE_MISMATCH || code === PEER_HOST_ERROR_CODES.PROXY_PATH_NOT_ALLOWED ? 400 : code === PEER_HOST_ERROR_CODES.NOT_FOUND ? 404 : code === PEER_HOST_ERROR_CODES.SESSION_REQUIRED ? 401 : code === PEER_HOST_ERROR_CODES.PROXY_ACCESS_DENIED ? 403 : 502
  return Response.json({ error: { code, message } }, { status })
}

/**
 * 只有本模块和会话层的稳定错误码可以直传；其它异常统一收敛为代理不可达。
 * 否则目标登录态失效会被伪装成网络故障，管理面板拿不到可操作的诊断。
 */
function resolveErrorCode(error: unknown): PeerHostErrorCode {
  if (error instanceof PeerHostProxyError || error instanceof PeerHostSessionError) return error.code
  return PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE
}
