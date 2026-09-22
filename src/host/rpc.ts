import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { CodingNsRpcTable } from './rpc-table.js'

/**
 * 创建 CodingNS Host RPC 主处理器。
 *
 * 它只做一次 `namespace/action` 前缀解析，具体动作由各功能模块在启动时登记的
 * 命名空间处理器实现；新增模块不需要修改这个文件。这是浏览器表单与 Host 能力
 * 之间的唯一边界：密码只在一次 RPC 请求中经过 Host，refresh token 只进入 Host
 * 凭据存储。
 */
export function createCodingNsRpcHandler(table: CodingNsRpcTable): ConnectionRpcHandler {
  return async (endpoint, payload) => {
    const target = table.resolve(endpoint)
    if (target === null) {
      return failure('CODINGNS_RPC_NOT_FOUND', `未知 CodingNS RPC: ${endpoint}`)
    }
    try {
      return success(await target.handler(target.action, payload))
    } catch (error) {
      return failure(errorCode(error), error instanceof Error ? error.message : String(error))
    }
  }
}

/** 在当前 Connection 上挂载 CodingNS RPC 主处理器；注销由调用方的 effect 负责。 */
export function registerCodingNsRpc(ctx: Context, table: CodingNsRpcTable): void {
  ctx.effect(
    () => {
      const handler = createCodingNsRpcHandler(table)
      // DSH Web 已经占用 /api 拦截器，且部分启动器不允许插件增加自定义前缀。
      // 直接注册精确 Fetch 路由，避免抢占共享路由或注册自定义 Web 前缀。
      const disposeFetch = CODINGNS_RPC_ENDPOINTS.map((endpoint) => ctx.connection.fetch.register({
        path: `/api/codingns/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => handleFetchRpc(request, endpoint, handler),
      }))
      return async (): Promise<void> => {
        for (const dispose of disposeFetch.reverse()) await dispose()
      }
    },
    'dsh-codingns: Host RPC',
  )
}

const CODINGNS_RPC_ENDPOINTS = [
  'auth/snapshot', 'auth/login', 'auth/logout', 'auth/devices', 'auth/bind', 'auth/unbind',
  'lanAccessDsh/addresses', 'lanAccessDsh/detect', 'lanAccessDsh/get', 'lanAccessDsh/settings/get', 'lanAccessDsh/settings/set', 'lanAccessDsh/start', 'lanAccessDsh/stop',
] as const

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
