import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { HostScope } from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'
import { CodingNsRpcError } from '../../rpc-table.js'
import { PeerHostHttpProxyService } from './host-api-proxy-service.js'
import { isPeerHostRequestCancellation, PeerHostNativeStreamError, throwIfPeerHostRequestAborted } from './peer-host-request-errors.js'

const STREAM_RETRY_ATTEMPTS = 3
const STREAM_RETRY_DELAY_MS = 400

type PeerHostProxyRequest = Parameters<PeerHostHttpProxyService['request']>[1]
type PeerHostProxyResponse = Awaited<ReturnType<PeerHostHttpProxyService['request']>>

/**
 * 当前 Host 到目标 Host 的原生 Remote 通道。
 *
 * 目标插件把 `peerHost/nativeLocal` 等动作挂在 `/api/codingns/<endpoint>` fetch
 * 路由上，该入口要求 CodingNS fetch RPC 信封：rpcId 必填、method 必须等于端点名，
 * 内层 payload 才是 `peerHost/<action>` 的参数。这里集中生成请求并解析响应，
 * 避免各处自行拼装出与目标入口不匹配的正文。
 */
export interface PeerHostNativeTransportRequest {
  readonly scope: HostScope
  readonly method: string
  readonly payload?: unknown
  readonly signal?: AbortSignal
}

/** 通过同一 HTTP 白名单读取目标 Host 的 CodingNS 私有 RPC。 */
export interface PeerHostCliTransportRequest {
  readonly scope: HostScope
  readonly endpoint: 'cli/session/adapter-map'
  readonly payload?: unknown
  readonly signal?: AbortSignal
}

export type PeerHostNativeEndpoint = 'peerHost/nativeLocal' | 'peerHost/nativeStreamOpen' | 'peerHost/nativeStreamNext' | 'peerHost/nativeStreamClose'

export function peerHostNativeEnvelope(endpoint: PeerHostNativeEndpoint, payload: unknown): string {
  return JSON.stringify({ rpcId: `peer-host-native-${randomUUID()}`, method: endpoint, payload })
}

export async function callPeerNativeRpc(httpProxy: PeerHostHttpProxyService, peerHostId: string, request: PeerHostNativeTransportRequest): Promise<unknown> {
  const response = await httpProxy.request(peerHostId, {
    scope: request.scope,
    path: '/api/codingns/peerHost/nativeLocal',
    method: 'POST',
    body: peerHostNativeEnvelope('peerHost/nativeLocal', { method: request.method, payload: request.payload, scope: request.scope }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  return readNativeRpcEnvelope(response.body)
}

export async function callPeerCliRpc(httpProxy: PeerHostHttpProxyService, peerHostId: string, request: PeerHostCliTransportRequest): Promise<unknown> {
  const response = await httpProxy.request(peerHostId, {
    scope: request.scope,
    path: `/api/codingns/${request.endpoint}`,
    method: 'POST',
    body: JSON.stringify({ rpcId: `peer-host-cli-${randomUUID()}`, method: request.endpoint, payload: request.payload ?? {} }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  return readNativeRpcEnvelope(response.body)
}

export function openPeerNativeStream(httpProxy: PeerHostHttpProxyService, peerHostId: string, request: PeerHostNativeTransportRequest): AsyncIterable<unknown> {
  return (async function* () {
    const opened = await requestPeerHostStream(httpProxy, peerHostId, {
      scope: request.scope,
      path: '/api/codingns/peerHost/nativeStreamOpen',
      method: 'POST',
      body: peerHostNativeEnvelope('peerHost/nativeStreamOpen', { method: request.method, payload: request.payload, scope: request.scope }),
    }, request, 'open')
    const streamId = requiredString(record(opened).streamId, 'streamId')
    try {
      while (!(request.signal?.aborted ?? false)) {
        const next = await requestPeerHostStream(httpProxy, peerHostId, {
          scope: request.scope,
          path: '/api/codingns/peerHost/nativeStreamNext',
          method: 'POST',
          body: peerHostNativeEnvelope('peerHost/nativeStreamNext', { streamId, scope: request.scope }),
        }, request, 'next')
        const value = record(next)
        if (value.done === true) return
        yield value.value
      }
      throwIfPeerHostRequestAborted(request.signal)
    } finally {
      await httpProxy.request(peerHostId, {
        scope: request.scope,
        path: '/api/codingns/peerHost/nativeStreamClose',
        method: 'POST',
        body: peerHostNativeEnvelope('peerHost/nativeStreamClose', { streamId, scope: request.scope }),
        // 关闭请求有独立时限，不能沿用已取消的订阅信号。
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined)
    }
  })()
}

/**
 * 目标 Host 自身重启时其 LAN 入口会短暂不可达，代理以 502 与连接级错误码返回。
 * 流通道只有读语义，这类明确的连接级失败可以有限重试；业务错误（例如会话不存在）直接返回。
 */
async function requestPeerHostStream(httpProxy: PeerHostHttpProxyService, peerHostId: string, request: PeerHostProxyRequest, subscription: PeerHostNativeTransportRequest, phase: 'open' | 'next'): Promise<unknown> {
  const startedAt = performance.now()
  let attempts = 0
  let status: number | null = null
  let cause: unknown
  try {
    for (;;) {
      throwIfPeerHostRequestAborted(subscription.signal)
      cause = undefined
      status = null
      attempts += 1
      const response = await httpProxy.request(peerHostId, {
        ...request,
        ...(subscription.signal === undefined ? {} : { signal: subscription.signal }),
        onFailure: error => { cause = error },
      })
      status = response.status
      throwIfPeerHostRequestAborted(subscription.signal)
      if (attempts >= STREAM_RETRY_ATTEMPTS || !isProxyUnreachable(response)) return readNativeRpcEnvelope(response.body)
      await delay(STREAM_RETRY_DELAY_MS * attempts, undefined, { signal: subscription.signal })
    }
  } catch (error) {
    if (isPeerHostRequestCancellation(error, subscription.signal)) {
      throwIfPeerHostRequestAborted(subscription.signal)
      throw error
    }
    const failureCause = subscription.signal?.aborted ? subscription.signal.reason : cause ?? error
    throw new PeerHostNativeStreamError(error, failureCause, {
      targetHostId: peerHostId, method: subscription.method, phase,
      workspaceId: request.scope.workspaceId, sessionId: request.scope.sessionId,
      elapsedMs: Math.round(performance.now() - startedAt), attempts, status,
    })
  }
}

function isProxyUnreachable(response: PeerHostProxyResponse): boolean {
  if (response.status !== 502) return false
  let value: unknown
  try { value = JSON.parse(response.body) } catch { return false }
  const error = asRecord(asRecord(value)?.error)
  return error?.code === PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE
}

export function readNativeRpcEnvelope(body: string): unknown {
  let value: unknown
  try { value = JSON.parse(body) } catch { throw new CodingNsRpcError('CODINGNS_RPC_RESPONSE_INVALID', 'PeerHost 原生 Remote 返回不是 JSON') }
  const envelope = record(value)
  if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
    const proxyError = asRecord(envelope.error)
    throw new CodingNsRpcError(
      typeof proxyError?.code === 'string' ? proxyError.code : 'CODINGNS_RPC_RESPONSE_INVALID',
      typeof proxyError?.message === 'string' ? proxyError.message : 'PeerHost 原生 Remote 响应格式无效',
    )
  }
  const result = record(envelope.result)
  if (result.ok === true) return result.value
  const error = asRecord(result.error)
  throw new CodingNsRpcError(typeof error?.code === 'string' ? error.code : 'CODINGNS_RPC_REMOTE_FAILED', typeof error?.message === 'string' ? error.message : 'PeerHost 原生 Remote 调用失败')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('PeerHost 原生 Remote 参数必须是对象')
  return value as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 不能为空`)
  return value.trim()
}
