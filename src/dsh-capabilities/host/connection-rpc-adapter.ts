import { CodingNsRpcError, type CodingNsRpcTable } from '../../host/rpc-table.js'

/** 统一的内部 RPC 上下文；0.1.7 的 PeerScope 在边界层映射到 peer。 */
export interface CodingNsRpcContext {
  readonly signal?: AbortSignal
  readonly peer?: { readonly id?: string; readonly scope?: unknown }
}

export interface CodingNsRpcDispatchResult {
  readonly ok: true
  readonly value: unknown
}

/**
 * 手写 HTTP、旧 Connection handler 和新 Peer-aware handler 共用的分发入口。
 * 客户端不能通过 payload 自报 peer，peer 只来自宿主传入的 context。
 */
export async function dispatchCodingNsRpc(
  table: CodingNsRpcTable,
  endpoint: string,
  payload: unknown,
  context: CodingNsRpcContext = {},
): Promise<CodingNsRpcDispatchResult> {
  const target = table.resolve(endpoint)
  if (target === null) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 CodingNS RPC: ${endpoint}`)
  const value = await target.handler(target.action, payload, context)
  return { ok: true, value }
}
