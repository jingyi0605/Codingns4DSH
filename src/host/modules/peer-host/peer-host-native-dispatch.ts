import type { Context } from '@deepseek-ai/cordis'
import { CodingNsRpcError } from '../../rpc-table.js'

/**
 * 目标 Host 的 DSH 原生 Remote 派发入口。
 *
 * DSH 的线上载荷是 `{ args: { <wire 名>: <值> } }`，由 Gateway 按 descriptor 解码成
 * 位置参数，并解析 lookup/context（例如 `workspaceFileScope`）。直接调用 Controller
 * 方法会把线上载荷原样塞进第一个参数，轻则参数被静默忽略（`session/list`），重则
 * 会话流立刻结束（`session/follow`）。因此这里只经过 DSH 自己的 Gateway。
 */
export interface DshNativeDispatch {
  rpc(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  stream(method: string, payload: unknown, signal?: AbortSignal): Promise<AsyncIterable<unknown>>
}

interface TypertGatewayService {
  readonly invoke?: (request: { readonly namespace: string; readonly method: string; readonly args: Record<string, unknown>; readonly signal?: AbortSignal }) => Promise<unknown>
  readonly stream?: (request: { readonly namespace: string; readonly method: string; readonly args: Record<string, unknown>; readonly signal?: AbortSignal }) => AsyncIterable<unknown>
}

export function resolveDshNativeDispatch(ctx: Context | undefined): DshNativeDispatch | undefined {
  if (ctx === undefined) return undefined
  let gateway: unknown
  try { gateway = ctx.get('typertGateway') } catch { return undefined }
  const service = gateway as TypertGatewayService | undefined
  if (typeof service?.invoke !== 'function' || typeof service.stream !== 'function') return undefined
  const endpoint = (method: string): { namespace: string; method: string } => {
    const separator = method.indexOf('/')
    const namespace = separator > 0 ? method.slice(0, separator) : ''
    const operation = separator > 0 ? method.slice(separator + 1) : ''
    if (namespace === '' || operation === '') throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `无法路由 DSH 原生 Remote: ${method}`)
    return { namespace, method: operation }
  }
  return {
    async rpc(method, payload, signal) {
      const target = endpoint(method)
      return await service.invoke!({ ...target, args: readWireArgs(payload), ...(signal === undefined ? {} : { signal }) })
    },
    async stream(method, payload, signal) {
      const target = endpoint(method)
      return await service.stream!({ ...target, args: readWireArgs(payload), ...(signal === undefined ? {} : { signal }) })
    },
  }
}

/** 解出 DSH Remote 的名字参数；`{args}` 之外的内层调用允许直接给名字参数。 */
export function readWireArgs(payload: unknown): Record<string, unknown> {
  if (payload === undefined) return {}
  const record = asRecord(payload)
  if (record === null) throw new CodingNsRpcError('CODINGNS_RPC_INVALID', 'DSH 原生 Remote 载荷必须是对象')
  if (Object.keys(record).length === 1 && Object.hasOwn(record, 'args')) {
    const args = asRecord(record.args)
    if (args === null) throw new CodingNsRpcError('CODINGNS_RPC_INVALID', 'DSH 原生 Remote 载荷的 args 必须是对象')
    return args
  }
  return record
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
