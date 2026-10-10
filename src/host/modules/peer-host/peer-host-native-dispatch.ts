import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { CodingNsRpcError } from '../../rpc-table.js'

/**
 * DSH Web 会先开放 Connection，再异步激活部分 Host Service。
 * PeerHost 的首批列表/订阅请求可能撞在这个窗口内，因此只对明确的
 * `gateway/service-unavailable` 做有限退避；业务错误必须立即透传。
 */
// DSH 的 Connection 就绪超时默认是 15 秒；语音模型、会话恢复和插件组合
// 可能让 Controller 在这个窗口末端才出现。派发层必须覆盖同一量级的等待，
// 否则首批并发请求会在 Controller 刚好激活前全部失败。
const SERVICE_UNAVAILABLE_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200, 6400, 10000] as const
const GATEWAY_SERVICE_UNAVAILABLE = 'gateway/service-unavailable'

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
  readonly wireStream?: { open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: undefined, signal: AbortSignal): Promise<AsyncIterable<unknown>> }
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
      if (method === '$events/result') return dispatchEventResult(ctx, payload, signal)
      const target = endpoint(method)
      const args = readWireArgs(payload)
      return await invokeWithServiceReadinessRetry(
        () => service.invoke!({ ...target, args, ...(signal === undefined ? {} : { signal }) }),
        signal,
      )
    },
    async stream(method, payload, signal) {
      if (method === '$events') {
        if (service.wireStream === undefined) throw new CodingNsRpcError('CODINGNS_RPC_UNSUPPORTED', '当前 Host 未提供 DSH 原生事件通道')
        const stream = await service.wireStream.open(method, payload, (async function* () {})(), undefined, signal ?? new AbortController().signal)
        return interactionEvents(stream)
      }
      const target = endpoint(method)
      const args = readWireArgs(payload)
      return await invokeWithServiceReadinessRetry(
        () => Promise.resolve(service.stream!({ ...target, args, ...(signal === undefined ? {} : { signal }) })),
        signal,
      )
    },
  }
}

/** 目标 Host 的账号、设置和插件通知不属于会话交互，不能随 PeerHost 转发到其他客户端。 */
async function* interactionEvents(stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const frame of stream) {
    // 会话运行态由 DSH 通过 `api-session/status` 的 emit 帧广播；客户端在
    // session/list 只做基线读取，丢掉这类增量后，已结束会话会一直显示运行中，
    // 新启动会话也不会进入运行态。其它 emit 仍属于目标 Host 的全局通知，必须过滤。
    if (asRecord(frame)?.type !== 'emit' || isSessionStatusFrame(frame)) yield frame
  }
}

function isSessionStatusFrame(value: unknown): boolean {
  const frame = asRecord(value)
  return frame?.event === 'api-session/status'
    && Array.isArray(frame.args)
    && typeof frame.args[0] === 'string'
    && typeof frame.args[1] === 'boolean'
}

/** 事件结果由 Connection 的 Gateway 拦截器接收；不访问私有方法，也不发起本机网络请求。 */
async function dispatchEventResult(ctx: Context, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  const connection = ctx.get('connection') as unknown as {
    createSharedFetchHandler?: (channel: '/api') => { fetch(request: Request): Promise<Response> }
  } | undefined
  if (typeof connection?.createSharedFetchHandler !== 'function') throw new CodingNsRpcError('CODINGNS_RPC_UNSUPPORTED', '当前 Host 未提供 DSH 事件结果入口')
  const response = await connection.createSharedFetchHandler('/api').fetch(new Request('http://peer-host.internal/api/$events/result', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: '$events/result', payload }),
    ...(signal === undefined ? {} : { signal }),
  }))
  const envelope = asRecord(await response.json())
  const result = asRecord(envelope?.result)
  if (response.ok && result?.ok === true) return result.value
  const error = asRecord(result?.error)
  throw new CodingNsRpcError(typeof error?.code === 'string' ? error.code : 'CODINGNS_RPC_REMOTE_FAILED', typeof error?.message === 'string' ? error.message : 'DSH 事件结果提交失败')
}

async function invokeWithServiceReadinessRetry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const waitMs = SERVICE_UNAVAILABLE_RETRY_DELAYS_MS[attempt]
      if (waitMs === undefined || !isGatewayServiceUnavailable(error) || signal?.aborted === true) throw error
      await waitForRetry(waitMs, signal)
    }
  }
}

function isGatewayServiceUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === GATEWAY_SERVICE_UNAVAILABLE
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error('DSH 原生 Remote 请求已取消'))
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason ?? new Error('DSH 原生 Remote 请求已取消'))
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) abort()
  })
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
