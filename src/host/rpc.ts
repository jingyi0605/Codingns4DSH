import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { SettingsPathOp, SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CODINGNS_SETTINGS_NAMESPACE, type CodingNsSettings } from '../shared/contracts/config.js'
import { CodingNsRpcError, type CodingNsRpcHandler, type CodingNsRpcTable } from './rpc-table.js'

/**
 * 创建 CodingNS Host RPC 主处理器。
 *
 * 它只做一次 `namespace/action` 前缀解析，具体动作由各功能模块在启动时登记的
 * 命名空间处理器实现；新增模块不需要修改这个文件。这是浏览器表单与 Host 能力
 * 之间的唯一边界：密码只在一次 RPC 请求中经过 Host，refresh token 只进入 Host
 * 凭据存储。
 */
export function createCodingNsRpcHandler(table: CodingNsRpcTable): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    const target = table.resolve(endpoint)
    if (target === null) {
      return failure('CODINGNS_RPC_NOT_FOUND', `未知 CodingNS RPC: ${endpoint}`)
    }
    try {
      return success(await target.handler(target.action, payload, { signal }))
    } catch (error) {
      return failure(errorCode(error), error instanceof Error ? error.message : String(error))
    }
  }
}

/** 在当前 Connection 上挂载 CodingNS RPC 主处理器；注销由调用方的 effect 负责。 */
export function registerCodingNsRpc(ctx: Context, table: CodingNsRpcTable, settingsProvider?: SettingsProvider): void {
  // 连接服务的 rpc.handle 内部会把路由注册延迟到另一个 effect；该 effect 的 owner
  // 不携带本插件的 webServer 注入，在部分 DSH 版本中会直接失败。因此这里捕获已经
  // 注入的服务实例，挂载同协议的前缀路由，避免把 RPC 请求落到 SPA fallback。
  const webServer = (ctx as Context & { webServer: WebServerLike }).webServer
  const connection = ctx.connection
  ctx.effect(
    () => {
      const unregisterSettings = settingsProvider === undefined
        ? undefined
        : table.register('settings', createCodingNsSettingsRpcHandler(settingsProvider))
      const handler = createCodingNsRpcHandler(table)
      const unregisterChannel = webServer.register({
        kind: 'prefix',
        path: '/codingns',
        handler: (request: IncomingMessage, response: ServerResponse) => handleChannelRequest(request, response, connection, handler),
      })
      // 保留旧的精确 Fetch 路由，兼容早期 H5/桌面载体直接访问 `/api/codingns/*`
      // 的调用方。两条入口共享同一个 handler，不复制任何业务逻辑。
      const disposeFetch = CODINGNS_RPC_ENDPOINTS.map((endpoint) => ctx.connection.fetch.register({
        path: `/api/codingns/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => handleFetchRpc(request, endpoint, handler),
      }))
      return async (): Promise<void> => {
        for (const dispose of disposeFetch.reverse()) await dispose()
        unregisterChannel()
        unregisterSettings?.()
      }
    },
    'dsh-codingns: Host RPC',
  )
}

async function handleChannelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  connection: Context['connection'],
  handler: ConnectionRpcHandler,
): Promise<void> {
  const abortController = new AbortController()
  request.once('close', () => abortController.abort())
  const rejection = connection.requestRejection({ headers: request.headers })
  if (rejection !== undefined) {
    response.statusCode = rejection
    response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }
  const endpoint = endpointFromChannelUrl(request.url)
  if (request.method !== 'POST' || endpoint === undefined) {
    response.statusCode = 404
    response.end('not found')
    return
  }
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    response.statusCode = 415
    response.end('content type must be application/json')
    return
  }
  let body: unknown
  try {
    body = JSON.parse(await readRequestBody(request)) as unknown
  } catch {
    response.statusCode = 400
    response.end('body is not JSON')
    return
  }
  if (!isRecord(body) || body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') {
    writeRpcResponse(response, typeof (body as { rpcId?: unknown } | null)?.rpcId === 'string' ? (body as { rpcId: string }).rpcId : 'invalid-request', {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} },
    })
    return
  }
  if (body.method !== endpoint) {
    writeRpcResponse(response, body.rpcId, {
      ok: false,
      error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
    })
    return
  }
  try {
    writeRpcResponse(response, body.rpcId, await handler(endpoint, body.payload, abortController.signal))
  } catch (error) {
    response.statusCode = 500
    response.end(`handler failure: ${String(error)}`)
  }
}

interface WebServerLike {
  register(route: { kind: 'prefix'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void
}

function endpointFromChannelUrl(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) return undefined
  const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname
  if (!pathname.startsWith('/codingns/')) return undefined
  const endpoint = pathname.slice('/codingns/'.length)
  if (endpoint === '' || endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_$.-]+$/u.test(segment))) return undefined
  return endpoint
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > 4 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeRpcResponse(response: ServerResponse, rpcId: string, result: ConnectionRpcResult<unknown>): void {
  const body = JSON.stringify({ type: 'server-response', rpcId, result })
  response.statusCode = 200
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(body)
}

const CODINGNS_RPC_ENDPOINTS = [
  'auth/snapshot', 'auth/login', 'auth/logout', 'auth/devices', 'auth/bind', 'auth/unbind', 'auth/signalingTicket', 'auth/dsh/device/list', 'auth/dsh/device/start', 'auth/dsh/device/stop', 'auth/dsh/device/status', 'auth/dsh/relayTicket',
  'host/status',
  'settings/get', 'settings/set',
  'terminal/status',
  'terminalProcess/profile/list', 'terminalProcess/profile/create', 'terminalProcess/profile/delete',
  'terminalProcess/launch', 'terminalProcess/runtime/list', 'terminalProcess/runtime/get', 'terminalProcess/runtime/stop',
  'debug/config/get', 'debug/config/save', 'debug/config/update', 'debug/config/delete', 'debug/profile/list', 'debug/profile/launch',
  'debug/runtime/get', 'debug/runtime/list', 'debug/runtime/stop',
  'debug/port/check', 'debug/port/terminate', 'debug/port/kill', 'debug/proxy/get', 'debug/proxy/enable', 'debug/proxy/disable',
  'lanAccessDsh/addresses', 'lanAccessDsh/detect', 'lanAccessDsh/get', 'lanAccessDsh/settings/get', 'lanAccessDsh/settings/set', 'lanAccessDsh/login/get', 'lanAccessDsh/login/set', 'lanAccessDsh/login/session/open', 'lanAccessDsh/start', 'lanAccessDsh/stop',
  'cli/catalog', 'cli/models', 'cli/adapter/set', 'cli/session/get', 'cli/session/set', 'cli/session/list', 'cli/session/adapter-map', 'cli/session/archive', 'cli/session/steer', 'cli/session/follow-up', 'cli/session/interrupt', 'cli/subscription',
] as const

/** 创建远程设置处理器；只允许 CodingNS 自己的 namespace 和路径编辑。 */
export function createCodingNsSettingsRpcHandler(provider: SettingsProvider): CodingNsRpcHandler {
  return async (action, payload) => {
    if (action === 'get') return readCodingNsSettings(provider)
    if (action === 'set') {
      if (!provider.writable) throw new CodingNsRpcError('CODINGNS_SETTINGS_READ_ONLY', 'Host 设置提供器当前只读')
      const input = parseSettingsMutation(payload)
      await provider.mutate(CODINGNS_SETTINGS_NAMESPACE, input.ops, input.expectedRevision)
      return readCodingNsSettings(provider)
    }
    throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 CodingNS RPC: settings/${action}`)
  }
}

function readCodingNsSettings(provider: SettingsProvider): { value: CodingNsSettings; revision: number } {
  const descriptor = provider.describe({ redactSecrets: true }).find((item) => item.ns === CODINGNS_SETTINGS_NAMESPACE)
  if (descriptor === undefined) throw new CodingNsRpcError('CODINGNS_SETTINGS_UNAVAILABLE', 'CodingNS 设置尚未注册')
  const value = provider.get(CODINGNS_SETTINGS_NAMESPACE) as CodingNsSettings
  // cliSessions 是 Host-only 索引，包含 providerSessionId/rawStoreRef，不能通过设置 RPC
  // 暴露给浏览器。外部会话列表必须走 cli/session/list，由 Host 按需返回摘要。
  const { cliSessions: _cliSessions, ...clientValue } = value
  return { value: clientValue, revision: descriptor.revision }
}

function parseSettingsMutation(value: unknown): { ops: SettingsPathOp[]; expectedRevision?: number } {
  if (!isRecord(value) || !Array.isArray(value.ops) || value.ops.length === 0 || value.ops.length > 8) {
    throw new TypeError('settings/set 参数必须包含 1 到 8 个 ops')
  }
  const expectedRevisionValue = value.expectedRevision
  if (expectedRevisionValue !== undefined && (typeof expectedRevisionValue !== 'number' || !Number.isInteger(expectedRevisionValue) || expectedRevisionValue < 0)) {
    throw new TypeError('expectedRevision 必须是非负整数')
  }
  const ops = value.ops.map(parseSettingsOp)
  return expectedRevisionValue === undefined ? { ops } : { ops, expectedRevision: expectedRevisionValue }
}

function parseSettingsOp(value: unknown): SettingsPathOp {
  if (!isRecord(value) || (value.op !== 'set' && value.op !== 'unset') || !Array.isArray(value.path)) {
    throw new TypeError('设置操作必须是 { op, path, value? }')
  }
  const path = value.path
  if (path.length === 0 || path.length > 3 || path.some((part) => typeof part !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(part))) {
    throw new TypeError('设置路径非法')
  }
  if (!isAllowedSettingsPath(path)) throw new CodingNsRpcError('CODINGNS_SETTINGS_FIELD_FORBIDDEN', `禁止修改设置字段: ${path.join('.')}`)
  if (value.op === 'unset') return { op: 'unset', path }
  if (!('value' in value)) throw new TypeError('set 操作缺少 value')
  return { op: 'set', path, value: value.value }
}

function isAllowedSettingsPath(path: readonly string[]): boolean {
  if (path.length === 1) return ['controlBaseUrl', 'controlBaseUrls', 'terminalEnhancement', 'workspaceSessionEnhancement'].includes(path[0] ?? '')
  if (path[0] === 'modules') return path.length === 2 && ['lanAccess', 'reverseProxy', 'cliAdapters', 'terminalEnhancement', 'workspaceSessionEnhancement', 'debug'].includes(path[1] ?? '')
  if (path[0] === 'workspaceSessionEnhancement') {
    return path.length === 2 && ['showAdapterLogo', 'showArchivedSessions', 'showSubscriptionUsage'].includes(path[1] ?? '')
  }
  return path[0] === 'lanAccessDsh' && path.length === 2 && ['autoStart', 'listenHost', 'listenPort', 'dshPort'].includes(path[1] ?? '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function handleFetchRpc(
  request: Request,
  endpoint: string,
  handler: ConnectionRpcHandler,
): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  if (!body || typeof body !== 'object') return new Response('invalid RPC envelope', { status: 400 })
  const envelope = body as { rpcId?: unknown; method?: unknown; payload?: unknown }
  const method = envelope.method
  if (typeof envelope.rpcId !== 'string' || (method !== endpoint && method !== `codingns/${endpoint}`)) {
    return new Response('invalid RPC envelope', { status: 400 })
  }
  const result = await handler(endpoint, envelope.payload, request.signal)
  return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
}

function success(value: unknown): ConnectionRpcResult<unknown> {
  return { ok: true, value }
}

function failure(code: string, message: string): ConnectionRpcResult<unknown> {
  return { ok: false, error: { code, message, details: {} } }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string') return error.errorCode
  if (error instanceof Error && error.name) return error.name
  return 'CODINGNS_RPC_FAILED'
}
