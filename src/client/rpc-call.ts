import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient, CodingNsRpcResult } from './features/types.js'

const apiRoutes = new WeakMap<CodingNsRpcClient, Set<string>>()

/** 只在路由确实不存在或方法不兼容时回退，普通超时不能重复提交写操作。 */
export async function callCodingNsRpcResult(rpc: CodingNsRpcClient, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<CodingNsRpcResult> {
  if (apiRoutes.get(rpc)?.has(endpoint)) return rpc.call('/api', `codingns/${endpoint}`, payload, signal)
  try { return await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload, signal) }
  catch (error) {
    if (signal?.aborted || !/HTTP (?:404|405)\b/u.test(error instanceof Error ? error.message : String(error))) throw error
    const result = await rpc.call('/api', `codingns/${endpoint}`, payload, signal)
    let routes = apiRoutes.get(rpc)
    if (routes === undefined) { routes = new Set(); apiRoutes.set(rpc, routes) }
    routes.add(endpoint)
    return result
  }
}
