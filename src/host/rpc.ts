import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
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
    () => ctx.connection.rpc.handle(CODINGNS_RPC_CHANNEL, createCodingNsRpcHandler(table)),
    'dsh-codingns: Host RPC',
  )
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
