import type { DshGatewayFeature, DshStreamContext } from '../transport/dsh-gateway.js'
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from '../transport/debug.js'
import WebSocket from 'ws'

/** 远程 DSH Web 资源；正文始终使用二进制，不经 Base64。 */
export interface DshWebAsset {
  readonly contentType: string
  readonly body: Uint8Array
  readonly etag?: string
}

export interface DshWebBoot {
  readonly dshVersion: string
  readonly contentType: string
  readonly html: string
  readonly entry?: string
  readonly styles?: readonly string[]
  readonly scripts?: readonly string[]
  readonly capabilities: readonly string[]
}

export interface DshWebSession {
  readonly sessionId: string
  readonly workspaceId?: string
  readonly dshVersion: string
}

export interface DshWebSocketLike {
  readonly readyState?: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void
}

export interface DshWebRuntimeProvider {
  openSession(input: { readonly workspaceId?: string; readonly sessionId?: string }): Promise<DshWebSession>
  getBoot(session: DshWebSession): Promise<DshWebBoot>
  getAsset(session: DshWebSession, path: string): Promise<DshWebAsset>
  getPluginManifest(session: DshWebSession): Promise<unknown>
  getPluginBundle(session: DshWebSession, pluginId: string, path: string): Promise<DshWebAsset>
  openWebSocket(session: DshWebSession, path: string): Promise<DshWebSocketLike>
  request?(session: DshWebSession, input: { readonly path: string; readonly method?: string; readonly headers?: readonly [string, string][]; readonly body?: string }): Promise<{ readonly status: number; readonly headers: readonly [string, string][]; readonly body: string }>
}

export interface RemoteWebRuntimeFeatureOptions {
  readonly provider: DshWebRuntimeProvider
  readonly maxAssetBytes?: number
  readonly debug?: DshTransportDebugLogger
}

/**
 * 把 Host 自己的 DSH Web 暴露为 DSH Gateway 的 web 频道。
 *
 * 这个模块不接受任意 URL，也不把 Host 凭据传给 Client；具体本地 DSH Web
 * 访问由 provider 完成，便于真实运行时和 Fake 测试分别注入。
 */
export function createRemoteWebRuntimeFeature(options: RemoteWebRuntimeFeatureOptions): DshGatewayFeature {
  const maxAssetBytes = options.maxAssetBytes ?? 16 * 1024 * 1024
  const debug = options.debug ?? createDshTransportDebugLogger({ side: 'host', component: 'remote-web' })
  const sessions = new Map<string, DshWebSession>()
  // 显式关闭的 session 不能被 WebSocket 惰性恢复；generation 重建造成的
  // 内存丢失则仍允许按原 ID恢复，避免旧 iframe 必须重新加载整个页面。
  const closedSessions = new Set<string>()
  const sockets = new Map<string, DshWebSocketLike>()
  const socketCleanups = new Map<string, () => void>()

  const closeStream = (streamId: string): void => {
    socketCleanups.get(streamId)?.()
    socketCleanups.delete(streamId)
    const socket = sockets.get(streamId)
    sockets.delete(streamId)
    try { socket?.close(1000, 'DSH Web stream closed') } catch { /* 关闭路径尽力而为 */ }
  }

  const feature: DshGatewayFeature = {
    channel: 'web',
    canHandle: (envelope) => typeof envelope.meta.operation === 'string' && envelope.meta.operation.startsWith('web.'),
    handleStream: async (context) => {
      const operation = readOperation(context)
      debug.log('web.request.start', { operation, streamId: context.envelope.streamId, bodyBytes: context.envelope.body?.byteLength ?? 0 })
      if (operation === 'web.ws.open') {
        try {
          await openWebSocketStream(context)
        } catch (error) {
          debug.log('web.websocket.open.outer.error', {
            operation,
            streamId: context.envelope.streamId,
            error: error instanceof Error ? error.message : String(error),
          })
          context.send('stream.error', { errorCode: error instanceof RemoteWebRuntimeError ? error.code : 'WEB_SOCKET_OPEN_FAILED', detail: error instanceof Error ? error.message : 'DSH WebSocket 打开失败', retryable: true })
          context.close()
        }
        return
      }
      const request = readJson(context)
      try {
        switch (operation) {
          case 'web.session.open': {
            const session = await options.provider.openSession(readOptionalRecord(request))
            sessions.set(session.sessionId, session)
            closedSessions.delete(session.sessionId)
            debug.log('web.session.opened', { operation, streamId: context.envelope.streamId, sessionId: session.sessionId })
            context.send('web.session.response', { encoding: 'json' }, encodeJson(session))
            break
          }
          case 'web.session.close': {
            const session = requireSession(sessions, request)
            debug.log('web.session.close', { operation, streamId: context.envelope.streamId, sessionId: session.sessionId })
            sessions.delete(session.sessionId)
            closedSessions.add(session.sessionId)
            context.send('web.session.close.response', { encoding: 'json' }, encodeJson({ closed: true }))
            break
          }
          case 'web.boot.get': {
            const session = requireSession(sessions, request)
            debug.log('web.boot.start', { operation, streamId: context.envelope.streamId, sessionId: session.sessionId })
            const boot = await options.provider.getBoot(session)
            debug.log('web.boot.done', { operation, streamId: context.envelope.streamId, sessionId: session.sessionId, htmlBytes: boot.html.length })
            context.send('web.boot.response', { encoding: 'json' }, encodeJson(boot))
            break
          }
          case 'web.asset.get': {
            const session = requireSession(sessions, request)
            const path = readPath(request)
            debug.log('web.asset.start', { operation, streamId: context.envelope.streamId, sessionId: session.sessionId, path })
            const asset = await options.provider.getAsset(session, path)
            assertAssetSize(asset, maxAssetBytes)
            debug.log('web.asset.done', { operation, streamId: context.envelope.streamId, sessionId: session.sessionId, path, bytes: asset.body.byteLength })
            context.send('web.asset.response', { contentType: asset.contentType, ...(asset.etag ? { etag: asset.etag } : {}) }, asset.body)
            break
          }
          case 'web.plugin.manifest': {
            const session = requireSession(sessions, request)
            context.send('web.plugin.manifest.response', { encoding: 'json' }, encodeJson(await options.provider.getPluginManifest(session)))
            break
          }
          case 'web.plugin.bundle': {
            const session = requireSession(sessions, request)
            const record = readRecord(request)
            const pluginId = readRequiredString(record.pluginId, 'pluginId')
            const path = readRequiredString(record.path, 'path')
            const asset = await options.provider.getPluginBundle(session, pluginId, path)
            assertAssetSize(asset, maxAssetBytes)
            context.send('web.plugin.bundle.response', { contentType: asset.contentType, ...(asset.etag ? { etag: asset.etag } : {}) }, asset.body)
            break
          }
          case 'web.request': {
            const session = requireSession(sessions, request)
            if (!options.provider.request) throw new RemoteWebRuntimeError('WEB_REQUEST_UNSUPPORTED', 'Host 未提供 DSH Web HTTP 请求能力')
            const record = readRecord(request)
            const path = readPath(record)
            const result = await options.provider.request(session, {
              path,
              ...(typeof record.method === 'string' ? { method: record.method } : {}),
              ...(Array.isArray(record.headers) ? { headers: readHeaders(record.headers) } : {}),
              ...(typeof record.body === 'string' ? { body: record.body } : {}),
            })
            context.send('web.request.response', { encoding: 'json' }, encodeJson(result))
            break
          }
          case 'web.debug': {
            const record = readRecord(request)
            debug.log('web.client.debug', {
              streamId: context.envelope.streamId,
              event: typeof record.event === 'string' ? record.event : 'unknown',
              fields: isRecord(record.fields) ? record.fields : {},
            })
            context.send('web.debug.response', { encoding: 'json' }, encodeJson({ ok: true }))
            break
          }
          default:
            throw new RemoteWebRuntimeError('WEB_OPERATION_UNSUPPORTED', `不支持的 DSH Web operation: ${operation}`)
        }
      } catch (error) {
        debug.log('web.request.error', { operation, streamId: context.envelope.streamId, error: error instanceof Error ? error.message : String(error) })
        context.send('stream.error', { errorCode: error instanceof RemoteWebRuntimeError ? error.code : 'WEB_RUNTIME_FAILED', detail: error instanceof Error ? error.message : 'DSH Web Runtime 失败', retryable: false })
      } finally {
        if (operation !== 'web.ws.open') {
          context.close()
        }
      }
    },
    handleMessage: async (context, envelope) => {
      if (envelope.type === 'web.ws.data') {
        const socket = sockets.get(envelope.streamId)
        if (!socket) throw new RemoteWebRuntimeError('WEB_SOCKET_NOT_FOUND', 'DSH WebSocket 流不存在')
        const body = envelope.body ?? new Uint8Array()
        // Remote mux 是 JSON 文本协议。DataChannel/DSH Envelope 的 body
        // 始终是二进制，但必须依据 encoding 恢复为本地 WebSocket 文本帧，
        // 否则 DSH Web 会以 1003 (text messages required) 立即关闭连接。
        const payload = envelope.meta.encoding === 'text'
          ? new TextDecoder('utf-8', { fatal: true }).decode(body)
          : body
        socket.send(payload)
        debug.log('web.ws.data', {
          streamId: envelope.streamId,
          bytes: body.byteLength,
          encoding: envelope.meta.encoding === 'text' ? 'text' : 'binary',
          ...(typeof payload === 'string' ? { preview: payload.slice(0, 240) } : {}),
        })
        return
      }
      if (envelope.type === 'stream.cancel' || envelope.type === 'stream.close' || envelope.type === 'web.ws.close') {
        closeStream(envelope.streamId)
      }
    },
  }

  return feature

  async function openWebSocketStream(context: DshStreamContext): Promise<void> {
    const request = readRecord(readJson(context))
    // Host 重启或 generation 恢复后，旧 iframe 可能仍持有上一个 sessionId。
    // 该 session 只代表本地 DSH Web 的短期句柄，不是认证凭据；在当前已认证
    // Tunnel 内按原 ID 惰性恢复，避免浏览器必须先销毁整个 iframe 才能重连。
    const session = await ensureWebSession(sessions, closedSessions, options.provider, request)
    const path = readPath(request)
    debug.log('web.websocket.open.start', {
      streamId: context.envelope.streamId,
      sessionId: session.sessionId,
      path,
    })
    let socket: DshWebSocketLike
    try {
      socket = await options.provider.openWebSocket(session, path)
      debug.log('web.websocket.factory.done', {
        streamId: context.envelope.streamId,
        sessionId: session.sessionId,
        path,
        readyState: socket.readyState,
      })
      await waitForWebSocketOpen(socket)
    } catch (error) {
      debug.log('web.websocket.open.error', {
        streamId: context.envelope.streamId,
        sessionId: session.sessionId,
        path,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : typeof error,
      })
      context.send('stream.error', { errorCode: 'WEB_SOCKET_OPEN_FAILED', detail: error instanceof Error ? error.message : 'DSH WebSocket 打开失败', retryable: true })
      context.close()
      return
    }
    sockets.set(context.envelope.streamId, socket)
    const cleanup = (): void => {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      socket.removeEventListener('error', onError)
    }
    const onMessage = (event: Event): void => {
      const value = (event as MessageEvent<unknown>).data
      // Node ws 在收到文本帧时，部分版本的 EventTarget 适配会暴露 Buffer。
      // /api/remote.mux 是 JSON 文本协议，必须在 Host 侧恢复 encoding=text，
      // 否则 H5 Bridge 会把 JSON 当 ArrayBuffer，$events 首帧无法解析并立即关闭。
      if (path === '/api/remote.mux') {
        const text = decodeTextWebSocketValue(value)
        if (text !== undefined) {
          debug.log('web.websocket.message', {
            streamId: context.envelope.streamId,
            bytes: new TextEncoder().encode(text).byteLength,
            encoding: 'text',
            preview: text.slice(0, 240),
          })
          context.send('web.ws.data', { encoding: 'text' }, new TextEncoder().encode(text))
          return
        }
      }
      const body = toBytes(value)
      if (body) {
        debug.log('web.websocket.message', { streamId: context.envelope.streamId, bytes: body.byteLength, encoding: 'binary' })
        context.send('web.ws.data', { binary: true }, body)
      } else if (typeof value === 'string') {
        debug.log('web.websocket.message', { streamId: context.envelope.streamId, bytes: new TextEncoder().encode(value).byteLength, encoding: 'text', preview: value.slice(0, 240) })
        context.send('web.ws.data', { encoding: 'text' }, new TextEncoder().encode(value))
      }
    }
    const onClose = (event: Event): void => {
      const close = event as Event & { readonly code?: number; readonly reason?: string }
      debug.log('web.websocket.close', { streamId: context.envelope.streamId, code: close.code, reason: close.reason })
      closeStream(context.envelope.streamId)
      context.close()
    }
    const onError = (event: Event): void => {
      const error = event as Event & { readonly error?: unknown; readonly message?: unknown }
      debug.log('web.websocket.error', {
        streamId: context.envelope.streamId,
        sessionId: session.sessionId,
        path,
        detail: typeof error.message === 'string' ? error.message : error.error instanceof Error ? error.error.message : 'DSH WebSocket 连接失败',
      })
      context.send('stream.error', { errorCode: 'WEB_SOCKET_FAILED', detail: 'DSH WebSocket 连接失败', retryable: true }); closeStream(context.envelope.streamId); context.close()
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    socket.addEventListener('error', onError)
    socketCleanups.set(context.envelope.streamId, cleanup)
    context.send('web.ws.open.response', { encoding: 'json' }, encodeJson({ opened: true }))
    await new Promise<void>((resolve) => {
      const finish = (): void => { cleanup(); resolve() }
      socket.addEventListener('close', finish)
      socket.addEventListener('error', finish)
    })
  }
}

export interface LocalDshWebRuntimeProviderOptions {
  readonly port: number
  readonly dshVersion: string
  /** DSH 官方 Web 认证入口；首次请求只用于换取 HttpOnly Cookie。 */
  readonly authenticatedUrl?: string
  readonly fetcher?: typeof fetch
  readonly websocketFactory?: (url: string, options?: { readonly headers?: Readonly<Record<string, string>> }) => DshWebSocketLike
  readonly bootPath?: string
  readonly pluginManifestPath?: string
  readonly allowedPathPrefixes?: readonly string[]
}

/** 访问本机 DSH Web 的默认 provider；只允许 loopback 和明确的资源路径。 */
export function createLocalDshWebRuntimeProvider(options: LocalDshWebRuntimeProviderOptions): DshWebRuntimeProvider {
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) throw new TypeError('DSH Web 端口无效')
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  const debug = createDshTransportDebugLogger({ side: 'host', component: 'web-provider' })
  const baseUrl = `http://127.0.0.1:${options.port}`
  // `/codingns` 是插件自己的 DSH Connection RPC 通道；它与 `/api`
  // 一样只在本机 Host 内部转发，不能因为 Web Provider 的资源白名单而被
  // 当成未知路径拒绝。实际权限仍由 Connection 的浏览器认证和 RPC handler
  // 共同校验，远端页面不能借此访问任意本机地址。
  const allowed = options.allowedPathPrefixes ?? ['/', '/assets/', '/plugins/', '/api/', '/codingns/']
  const sessions = new Map<string, DshWebSession>()
  let sessionCookie: string | undefined

  const fetchLocal = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    // Cookie 只允许由 Host 侧认证交换产生，不能让远端页面伪造或覆盖。
    if (sessionCookie !== undefined) headers.set('cookie', sessionCookie)
    else headers.delete('cookie')
    return fetcher(`${baseUrl}${path}`, { ...init, headers })
  }

  const ensureAuthenticated = async (): Promise<void> => {
    if (sessionCookie !== undefined || options.authenticatedUrl === undefined) return
    debug.log('web.auth.start', { authenticatedUrlConfigured: true })
    const response = await fetcher(options.authenticatedUrl, { redirect: 'manual' })
    const setCookie = getSetCookie(response.headers)
    if (setCookie !== undefined) sessionCookie = setCookie
    if (response.status !== 303 || sessionCookie === undefined) {
      debug.log('web.auth.error', { status: response.status, hasCookie: sessionCookie !== undefined })
      throw new Error(`DSH Web 认证交换失败 (${response.status})`)
    }
    debug.log('web.auth.done', { status: response.status, hasCookie: true })
  }

  return {
    async openSession(input) {
      const session: DshWebSession = { sessionId: input.sessionId?.trim() || `web_${cryptoRandomId()}`, dshVersion: options.dshVersion, ...(input.workspaceId?.trim() ? { workspaceId: input.workspaceId.trim() } : {}) }
      sessions.set(session.sessionId, session)
      return session
    },
    async getBoot(session) {
      ensureSession(sessions, session)
      debug.log('web.provider.boot', { sessionId: session.sessionId, authenticated: sessionCookie !== undefined, path: normalizePath(options.bootPath ?? '/') })
      await ensureAuthenticated()
      const response = await fetchLocal(normalizePath(options.bootPath ?? '/'))
      debug.log('web.provider.boot.response', { sessionId: session.sessionId, status: response.status })
      if (!response.ok) throw new Error(`读取 DSH Web boot 失败 (${response.status})`)
      return { dshVersion: options.dshVersion, contentType: response.headers.get('content-type') ?? 'text/html; charset=utf-8', html: await response.text(), capabilities: ['boot', 'asset', 'websocket', 'plugin'] }
    },
    async getAsset(session, path) {
      ensureSession(sessions, session)
      const normalized = normalizePath(path)
      if (!allowed.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) throw new Error('DSH Web 资源路径不在白名单内')
      await ensureAuthenticated()
      const response = await fetchLocal(normalized)
      debug.log('web.provider.asset.response', { sessionId: session.sessionId, path: normalized, status: response.status })
      const asset = await readAsset(response)
      // 只对插件聚合脚本做轻量标记检查，确认远程 H5 拿到的是当前工作区
      // 构建，而不是 DSH Web 进程缓存的旧 bundle。
      if (normalized.startsWith('/plugins/??')) {
        const source = new TextDecoder().decode(asset.body)
        debug.log('web.provider.asset.marker', {
          sessionId: session.sessionId,
          path: normalized,
          bytes: asset.body.byteLength,
          hasRemoteTransportBinding: source.includes('remote.connection.binding.detected') || source.includes('__DSH_TRANSPORT__'),
        })
      }
      return asset
    },
    async getPluginManifest(session) {
      ensureSession(sessions, session)
      await ensureAuthenticated()
      const response = await fetchLocal(normalizePath(options.pluginManifestPath ?? '/api/plugins/manifest'))
      if (response.status === 404) return []
      if (!response.ok) throw new Error(`读取 DSH 插件清单失败 (${response.status})`)
      return await response.json() as unknown
    },
    async getPluginBundle(session, _pluginId, path) { return this.getAsset(session, path) },
    async request(session, input) {
      ensureSession(sessions, session)
      const path = normalizePath(input.path)
      if (!allowed.some((prefix) => path === prefix || path.startsWith(prefix))) throw new Error('DSH Web 请求路径不在白名单内')
      const init: RequestInit = { method: input.method ?? 'GET' }
      if (input.headers !== undefined) init.headers = Object.fromEntries(input.headers)
      if (input.body !== undefined) init.body = input.body
      await ensureAuthenticated()
      const response = await fetchLocal(path, init)
      debug.log('web.provider.request.response', { sessionId: session.sessionId, path, method: input.method ?? 'GET', status: response.status })
      return { status: response.status, headers: [...response.headers.entries()], body: await response.text() }
    },
    async openWebSocket(session, path) {
      ensureSession(sessions, session)
      const normalized = normalizePath(path)
      if (!allowed.some((prefix) => normalized === prefix || normalized.startsWith(prefix))) throw new Error('DSH WebSocket 路径不在白名单内')
      await ensureAuthenticated()
      debug.log('web.provider.websocket.start', {
        sessionId: session.sessionId,
        path: normalized,
        url: `${baseUrl.replace(/^http:/u, 'ws:')}${normalized}`,
        hasCookie: sessionCookie !== undefined,
      })
      // Node 的 WHATWG WebSocket 不支持自定义 Cookie 头；DSH Web 的本地连接
      // 必须复用 Host 刚交换得到的认证 Cookie，因此使用 ws 提供的 Node 客户端。
      const factory = options.websocketFactory ?? ((url: string, init?: { readonly headers?: Readonly<Record<string, string>> }) => {
        return new WebSocket(url, init === undefined ? undefined : { headers: init.headers }) as unknown as DshWebSocketLike
      })
      try {
        const socket = factory(`${baseUrl.replace(/^http:/u, 'ws:')}${normalized}`, {
          headers: {
            ...(sessionCookie === undefined ? {} : { cookie: sessionCookie }),
            // DSH Remote mux 按客户端约定校验 Origin；Node ws 不会自动带浏览器 Origin。
            origin: baseUrl,
          },
        })
        debug.log('web.provider.websocket.created', { sessionId: session.sessionId, path: normalized, readyState: socket.readyState })
        return socket
      } catch (error) {
        debug.log('web.provider.websocket.error', { sessionId: session.sessionId, path: normalized, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    },
  }
}

function getSetCookie(headers: Headers): string | undefined {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() ?? (headers.get('set-cookie') === null ? [] : [headers.get('set-cookie')!])
  for (const value of values) {
    const match = /^([^=;\s]+=[^;]*)/u.exec(value)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

class RemoteWebRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = code }
}

function readOperation(context: DshStreamContext): string {
  const operation = context.envelope.meta.operation
  if (typeof operation !== 'string' || !operation.startsWith('web.')) throw new RemoteWebRuntimeError('WEB_OPERATION_INVALID', 'DSH Web operation 无效')
  return operation
}

function readJson(context: DshStreamContext): unknown {
  if (!context.envelope.body || context.envelope.meta.encoding !== 'json') return {}
  try { return JSON.parse(new TextDecoder().decode(context.envelope.body)) as unknown } catch { throw new RemoteWebRuntimeError('MESSAGE_INVALID', 'DSH Web 请求不是有效 JSON') }
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteWebRuntimeError('MESSAGE_INVALID', 'DSH Web 请求必须是对象')
  return value as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readOptionalRecord(value: unknown): { workspaceId?: string; sessionId?: string } {
  const record = readRecord(value)
  const result: { workspaceId?: string; sessionId?: string } = {}
  if (typeof record.workspaceId === 'string' && record.workspaceId.trim()) result.workspaceId = record.workspaceId.trim()
  if (typeof record.sessionId === 'string' && record.sessionId.trim()) result.sessionId = record.sessionId.trim()
  return result
}

function requireSession(sessions: ReadonlyMap<string, DshWebSession>, value: unknown): DshWebSession {
  const record = readRecord(value)
  const sessionId = readRequiredString(record.sessionId, 'sessionId')
  const session = sessions.get(sessionId)
  if (!session) throw new RemoteWebRuntimeError('WEB_SESSION_NOT_FOUND', 'DSH Web Session 不存在')
  return session
}

async function ensureWebSession(
  sessions: Map<string, DshWebSession>,
  closedSessions: ReadonlySet<string>,
  provider: DshWebRuntimeProvider,
  value: unknown,
): Promise<DshWebSession> {
  const record = readRecord(value)
  const sessionId = readRequiredString(record.sessionId, 'sessionId')
  if (closedSessions.has(sessionId)) throw new RemoteWebRuntimeError('WEB_SESSION_NOT_FOUND', 'DSH Web Session 不存在')
  const current = sessions.get(sessionId)
  if (current !== undefined) return current
  const workspaceId = typeof record.workspaceId === 'string' && record.workspaceId.trim()
    ? record.workspaceId.trim()
    : undefined
  const session = await provider.openSession({ sessionId, ...(workspaceId === undefined ? {} : { workspaceId }) })
  if (session.sessionId !== sessionId) throw new RemoteWebRuntimeError('WEB_SESSION_INVALID', 'DSH Web Session ID 不一致')
  sessions.set(session.sessionId, session)
  return session
}

function readPath(value: unknown): string {
  return normalizePath(readRequiredString(readRecord(value).path, 'path'))
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new RemoteWebRuntimeError('MESSAGE_INVALID', `${name} 不能为空`)
  return value.trim()
}

function readHeaders(value: unknown[]): readonly [string, string][] {
  return value.map((item) => {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') throw new RemoteWebRuntimeError('MESSAGE_INVALID', 'DSH Web headers 无效')
    return [item[0], item[1]] as [string, string]
  })
}

function encodeJson(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value ?? null)) }

function assertAssetSize(asset: DshWebAsset, maxBytes: number): void {
  if (!(asset.body instanceof Uint8Array) || asset.body.byteLength > maxBytes) throw new RemoteWebRuntimeError('WEB_ASSET_TOO_LARGE', 'DSH Web 资源超过大小上限')
}

async function readAsset(response: Response): Promise<DshWebAsset> {
  if (!response.ok) throw new Error(`读取 DSH Web 资源失败 (${response.status})`)
  return { contentType: response.headers.get('content-type') ?? 'application/octet-stream', body: new Uint8Array(await response.arrayBuffer()), ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) }
}

function ensureSession(sessions: ReadonlyMap<string, DshWebSession>, session: DshWebSession): void {
  if (sessions.get(session.sessionId) !== session) throw new Error('DSH Web Session 已失效')
}

function normalizePath(value: string): string {
  if (!value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => part === '..')) throw new Error('DSH Web 路径无效')
  return value
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  return null
}

function decodeTextWebSocketValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const bytes = toBytes(value)
  if (!bytes) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    JSON.parse(text)
    return text
  } catch {
    return undefined
  }
}

function cryptoRandomId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? Math.random().toString(36).slice(2)
}

function waitForWebSocketOpen(socket: DshWebSocketLike, timeoutMs = 15_000): Promise<void> {
  if (socket.readyState === undefined || socket.readyState === 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待 DSH WebSocket open 超时')) }, timeoutMs)
    const onOpen = (): void => { cleanup(); resolve() }
    const onError = (): void => { cleanup(); reject(new Error('DSH WebSocket 打开失败')) }
    const onClose = (): void => { cleanup(); reject(new Error('DSH WebSocket 在 open 前关闭')) }
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
}
