import type { Context } from '@deepseek-ai/cordis'
// 仅启用 DSH Connection 的 Cordis Context 增强；RPC 结果契约仍使用本文件的内部类型。
import type {} from '@deepseek-ai/dsh-client-connection'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CODINGNS_SETTINGS_NAMESPACE, isCodingNsSettingsEntryId, type CodingNsSettings } from '../shared/contracts/config.js'
import { debugInfo, debugWarn } from '../shared/debug.js'
import { CodingNsRpcError, type CodingNsRpcHandler, type CodingNsRpcTable } from './rpc-table.js'
import type { DshHostSettingsProvider } from '../dsh-capabilities/host/config-forms-adapter.js'
import type { CodingNsSettingsOperation } from '../dsh-capabilities/settings-store.js'

/** 0.2 Connection handler 的 Peer 参数；旧版 handler 仍可通过可选参数调用。 */
/** CodingNS 自有的 Connection RPC 结果契约，避免绑定 DSH 具体导出名称。 */
type CodingNsConnectionRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T; readonly attachments?: readonly CodingNsConnectionRpcAttachment[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

interface CodingNsConnectionRpcAttachment {
  readonly path: readonly (string | number)[]
  readonly bytes: Uint8Array
}

type CodingNsConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer?: unknown,
) => Promise<CodingNsConnectionRpcResult<unknown>>

function invokeConnectionRpcHandler(
  handler: CodingNsConnectionRpcHandler,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: unknown,
): Promise<CodingNsConnectionRpcResult<unknown>> {
  return handler(endpoint, payload, signal, peer)
}

/**
 * 创建 Codingns4DSH Host RPC 主处理器。
 *
 * 它只做一次 `namespace/action` 前缀解析，具体动作由各功能模块在启动时登记的
 * 命名空间处理器实现；新增模块不需要修改这个文件。这是浏览器表单与 Host 能力
 * 之间的唯一边界：密码只在一次 RPC 请求中经过 Host，refresh token 只进入 Host
 * 凭据存储。
 */
export function createCodingNsRpcHandler(table: CodingNsRpcTable): CodingNsConnectionRpcHandler {
  // `peer` 是 DSH 0.2 Connection 注入的调用方作用域；0.1 carrier 没有该参数，
  // 因此保留可选形态，让同一处理器可被旧版 HTTP 回退入口复用。
  return async (endpoint, payload, signal, peer?: unknown) => {
    debugInfo('codingns4dsh: host rpc request', { endpoint })
    const target = table.resolve(endpoint)
    if (target === null) {
      debugWarn('codingns4dsh: host rpc endpoint not found', { endpoint })
      return failure('CODINGNS_RPC_NOT_FOUND', `未知 Codingns4DSH RPC: ${endpoint}`)
    }
    try {
      const value = await target.handler(target.action, payload, { signal, peer })
      debugInfo('codingns4dsh: host rpc success', { endpoint })
      return success(value)
    } catch (error) {
      const code = errorCode(error)
      const details = { endpoint, code, error }
      if (code === 'CODINGNS_RPC_UNAUTHENTICATED') {
        // 未登录是正常的业务状态，不能把它伪装成 Host 故障；RPC 仍返回失败，
        // 让客户端根据稳定错误码决定是否等待登录。
        console.warn('codingns4dsh: host rpc request rejected', details)
      } else {
        console.error('codingns4dsh: host rpc handler failed', details)
      }
      return failure(code, error instanceof Error ? error.message : String(error))
    }
  }
}

/** 在当前 Connection 上挂载 Codingns4DSH RPC 主处理器；注销由调用方的 effect 负责。 */
export function registerCodingNsRpc(ctx: Context, table: CodingNsRpcTable, settingsProvider?: DshHostSettingsProvider): void {
  // 连接服务的 rpc.handle 内部会把路由注册延迟到另一个 effect；该 effect 的 owner
  // 不携带本插件的 webServer 注入，在部分 DSH 版本中会直接失败。因此这里捕获已经
  // 注入的服务实例，挂载同协议的前缀路由，避免把 RPC 请求落到 SPA fallback。
  const webServer = (ctx as Context & { webServer: WebServerLike }).webServer
  const connection = ctx.connection
  debugInfo('codingns4dsh: host rpc registration begin', {
    hasConnectionRpc: typeof (connection as typeof connection & { rpc?: { handle?: unknown } }).rpc?.handle === 'function',
    endpointCount: CODINGNS_RPC_ENDPOINTS.length,
  })
  ctx.effect(
    () => {
      const unregisterSettings = settingsProvider === undefined
        ? undefined
        : table.register('settings', createCodingNsSettingsRpcHandler(settingsProvider))
      const handler = createCodingNsRpcHandler(table)
      // DSH 0.1.7 的 connection.rpc.handle() 会在当前插件 Fiber 中再次读取
      // webServer；该 Fiber 没有 webServer 注入时会直接抛错。这里使用当前
      // Host 已明确注入的 webServer 注册插件自有前缀，避免 Host RPC 装配中断。
      const unregisterChannel = webServer.register({
        kind: 'prefix',
        path: '/codingns',
        handler: (request: IncomingMessage, response: ServerResponse) => handleChannelRequest(request, response, connection, handler),
      })
      debugInfo('codingns4dsh: host rpc channel registered', {
        transport: 'webServer.prefix',
        channel: '/codingns',
      })
      // 保留旧的精确 Fetch 路由，兼容早期 H5/桌面载体直接访问 `/api/codingns/*`
      // 的调用方。两条入口共享同一个 handler，不复制任何业务逻辑。
      const disposeFetch = CODINGNS_RPC_ENDPOINTS.map((endpoint) => ctx.connection.fetch.register({
        path: `/api/codingns/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => handleFetchRpc(request, endpoint, connection, handler),
      }))
      debugInfo('codingns4dsh: host rpc fetch routes registered', {
        prefix: '/api/codingns/',
        count: disposeFetch.length,
        endpoints: CODINGNS_RPC_ENDPOINTS,
      })
      return async (): Promise<void> => {
        for (const dispose of disposeFetch.reverse()) await dispose()
        await unregisterChannel()
        unregisterSettings?.()
        debugInfo('codingns4dsh: host rpc channel disposed')
      }
    },
    'codingns4dsh: Host RPC',
  )
}

async function handleChannelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  connection: Context['connection'],
  handler: CodingNsConnectionRpcHandler,
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
    const peer = (connection as Context['connection'] & { readonly operator?: unknown }).operator
    writeRpcResponse(response, body.rpcId, await invokeConnectionRpcHandler(handler, endpoint, body.payload, abortController.signal, peer))
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

function writeRpcResponse(response: ServerResponse, rpcId: string, result: CodingNsConnectionRpcResult<unknown>): void {
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
  'git/status', 'git/init', 'git/diff', 'git/stage', 'git/unstage', 'git/discard', 'git/commit', 'git/commit-diff', 'git/history', 'git/branches', 'git/switch', 'git/fetch', 'git/pull', 'git/push', 'git/undo',
  'fileManagement/session-changes', 'fileManagement/read', 'fileManagement/download', 'fileManagement/write', 'fileManagement/create-file', 'fileManagement/create-directory', 'fileManagement/rename', 'fileManagement/copy', 'fileManagement/move', 'fileManagement/delete', 'fileManagement/git-ignore',
  'lanAccessDsh/addresses', 'lanAccessDsh/detect', 'lanAccessDsh/get', 'lanAccessDsh/settings/get', 'lanAccessDsh/settings/set', 'lanAccessDsh/login/get', 'lanAccessDsh/login/set', 'lanAccessDsh/login/session/open', 'lanAccessDsh/login/session/refresh', 'lanAccessDsh/start', 'lanAccessDsh/stop',
  'peerHost/list', 'peerHost/diagnostics', 'peerHost/create', 'peerHost/update', 'peerHost/remove', 'peerHost/enable', 'peerHost/disable', 'peerHost/check', 'peerHost/reconnect', 'peerHost/login', 'peerHost/logout', 'peerHost/status', 'peerHost/request', 'peerHost/wsEndpoint', 'peerHost/aggregate', 'peerHost/workspaceOrder', 'peerHost/native', 'peerHost/nativeLocal', 'peerHost/nativeStream', 'peerHost/nativeStreamOpen', 'peerHost/nativeStreamNext', 'peerHost/nativeStreamClose',
  'cli/catalog', 'cli/models', 'cli/adapter/set', 'cli/session/get', 'cli/session/set', 'cli/session/list', 'cli/session/adapter-map', 'cli/session/archive', 'cli/session/steer', 'cli/session/follow-up', 'cli/session/interrupt', 'cli/subscription', 'cli/team/status', 'cli/team/members', 'cli/team/tasks', 'cli/team/task', 'cli/team/spawn', 'cli/team/message', 'cli/team/task/create', 'cli/team/task/update', 'cli/team/wait', 'cli/team/interrupt',
] as const

/** 创建远程设置处理器；只允许 Codingns4DSH 自己的 namespace 和路径编辑。 */
export function createCodingNsSettingsRpcHandler(provider: DshHostSettingsProvider): CodingNsRpcHandler {
  return async (action, payload) => {
    if (action === 'get') return readCodingNsSettings(provider)
    if (action === 'set') {
      if (!provider.writable) throw new CodingNsRpcError('CODINGNS_SETTINGS_READ_ONLY', 'Host 设置提供器当前只读')
      const input = parseSettingsMutation(payload)
      if (typeof provider.mutate === 'function') {
        await provider.mutate(resolveCodingNsSettingsNamespace(provider), input.ops, input.expectedRevision)
      } else if (typeof provider.update === 'function') {
        await provider.update(resolveCodingNsSettingsNamespace(provider), operationsToPatch(input.ops), input.expectedRevision)
      } else {
        throw new CodingNsRpcError('CODINGNS_SETTINGS_UNAVAILABLE', 'Codingns4DSH 设置提供器不支持写入')
      }
      return readCodingNsSettings(provider)
    }
    throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 Codingns4DSH RPC: settings/${action}`)
  }
}

function readCodingNsSettings(provider: DshHostSettingsProvider): { value: CodingNsSettings; revision: number } {
  const descriptor = findCodingNsSettingsDescriptor(provider)
  if (descriptor === undefined) throw new CodingNsRpcError('CODINGNS_SETTINGS_UNAVAILABLE', 'Codingns4DSH 设置尚未注册')
  // 0.1.7 的 ConfigForm namespace 由 Bundle entry id 决定。包名改为 scoped 后，
  // descriptor.ns 可能是 `@jingyi0605/codingns4dsh`，不能继续固定读取旧的 `codingns`。
  const providerValue = typeof provider.get === 'function'
    ? provider.get(descriptor.ns) as CodingNsSettings | undefined
    : undefined
  const value = providerValue ?? descriptor.value as CodingNsSettings
  // cliSessions 是 Host-only 索引，包含 providerSessionId/rawStoreRef，不能通过设置 RPC
  // 暴露给浏览器。外部会话列表必须走 cli/session/list，由 Host 按需返回摘要。
  const { cliSessions: _cliSessions, ...clientValue } = value
  return { value: clientValue, revision: descriptor.revision }
}

function findCodingNsSettingsDescriptor(provider: Pick<DshHostSettingsProvider, 'describe'>) {
  return provider.describe({ redactSecrets: true }).find((item) => isCodingNsSettingsEntryId(item.ns))
}

function resolveCodingNsSettingsNamespace(provider: Pick<DshHostSettingsProvider, 'describe'>): string {
  return findCodingNsSettingsDescriptor(provider)?.ns ?? CODINGNS_SETTINGS_NAMESPACE
}

function parseSettingsMutation(value: unknown): { ops: CodingNsSettingsOperation[]; expectedRevision?: number } {
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

function parseSettingsOp(value: unknown): CodingNsSettingsOperation {
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

/** 兼容仅暴露 update 的旧设置提供器；0.2 SettingsForms 优先走 mutate。 */
function operationsToPatch(operations: readonly CodingNsSettingsOperation[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const operation of operations) {
    if (operation.path.length !== 1) throw new TypeError('设置提供器 update 回退只支持一级字段')
    if (operation.op === 'set') patch[operation.path[0]!] = operation.value
  }
  return patch
}

function isAllowedSettingsPath(path: readonly string[]): boolean {
  if (path.length === 1) return ['controlBaseUrl', 'controlBaseUrls', 'terminalEnhancement', 'workspaceSessionEnhancement', 'fileManagement', 'mobileAccess', 'subscriptionUsage'].includes(path[0] ?? '')
  if (path[0] === 'modules') return path.length === 2 && ['lanAccess', 'reverseProxy', 'cliAdapters', 'terminalEnhancement', 'workspaceSessionEnhancement', 'debug', 'gitManagement', 'fileManagement', 'mobileAccess', 'peerHost'].includes(path[1] ?? '')
  if (path[0] === 'workspaceSessionEnhancement') {
    return path.length === 2 && [
      'showAdapterLogo', 'showArchivedSessions', 'showWorkspaceHiding', 'hiddenWorkspaceIds',
      'showSubscriptionUsage', 'showQuickPhrases', 'rememberConversationRightbarRatio',
      'quickPhrases', 'quickPhrasesSeeded',
      // 手势设置由「工作区会话增强」面板写入；非回环页面没有本地设置镜像，
      // 写入必须经过这里，缺项会让手机上的手势开关直接被拒绝。
      'sidebarGestures', 'sidebarGestureMapping', 'sidebarGestureEdge', 'sidebarGestureThresholdPx',
    ].includes(path[1] ?? '')
  }
  if (path[0] === 'mobileAccess') {
    return path.length === 2 && ['hideSidebarOnMobile', 'mobileViewportMaxPx'].includes(path[1] ?? '')
  }
  if (path[0] === 'subscriptionUsage') {
    return path.length === 2 && ['timeoutSecs', 'refreshIntervalMins'].includes(path[1] ?? '')
  }
  if (path[0] === 'fileManagement') {
    return path.length === 2 && ['menuEnhancement', 'fileEditor', 'sessionChangedFiles'].includes(path[1] ?? '')
  }
  // 局域网入口的 PWA 资产设置由「移动端访问增强」卡片写入：非回环页面没有本地设置镜像，
  // 必须在这里放行 `lanAccessDsh.pwa`，否则手机上的开关会被直接拒绝。
  return path[0] === 'lanAccessDsh' && path.length === 2 && ['autoStart', 'listenHost', 'listenPort', 'dshPort', 'pwa'].includes(path[1] ?? '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function handleFetchRpc(
  request: Request,
  endpoint: string,
  connection: Context['connection'],
  handler: CodingNsConnectionRpcHandler,
): Promise<Response> {
  debugInfo('codingns4dsh: host fetch rpc request', {
    endpoint,
    method: request.method,
    path: new URL(request.url).pathname,
  })
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
  const peer = (connection as Context['connection'] & { readonly operator?: unknown }).operator
  const result = await invokeConnectionRpcHandler(handler, endpoint, envelope.payload, request.signal, peer)
  debugInfo('codingns4dsh: host fetch rpc response', { endpoint, ok: result.ok })
  return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
}

function success(value: unknown): CodingNsConnectionRpcResult<unknown> {
  return { ok: true, value }
}

function failure(code: string, message: string): CodingNsConnectionRpcResult<unknown> {
  return { ok: false, error: { code, message, details: {} } }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string') return error.errorCode
  if (error instanceof Error && error.name) return error.name
  return 'CODINGNS_RPC_FAILED'
}
