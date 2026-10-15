import { nativeDispatchPeer } from './connection-peer-adapter.js'

interface GatewayRequest {
  readonly namespace: string
  readonly method: string
  readonly args: Record<string, unknown>
  readonly signal?: AbortSignal
  readonly peer?: unknown
}

export interface NativeGateway {
  invoke(request: GatewayRequest): Promise<unknown>
  stream(request: GatewayRequest): AsyncIterable<unknown>
  readonly wireStream?: { open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> }
}

/** Explicit peers work on both Gateway generations; legacy hosts may omit one. */
export function nativePeerRequest(connection: unknown, caller?: unknown): { peer?: unknown } {
  const peer = nativeDispatchPeer(connection, caller)
  return peer === undefined ? {} : { peer }
}

export function nativeSharedFetch(connection: unknown, request: Request, caller?: unknown): Promise<Response> {
  const service = connection as { createSharedFetchHandler(channel: '/api'): { fetch(request: Request, peer?: unknown): Promise<Response> } }
  return service.createSharedFetchHandler('/api').fetch(request, nativeDispatchPeer(connection, caller))
}
