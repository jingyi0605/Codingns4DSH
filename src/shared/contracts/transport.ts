import type { CodingNsDshErrorCode } from './errors.js'

/** CodingNS Host RPC 的固定逻辑通道。 */
export const CODINGNS_RPC_CHANNEL = '/codingns'

export interface CodingNsRpcRequest<TPayload = unknown> {
  method: string
  payload: TPayload
  signal?: AbortSignal
}

export interface CodingNsStreamRequest<TPayload = unknown> {
  method: string
  payload: TPayload
  signal?: AbortSignal
}

export interface CodingNsTransportGeneration {
  id: number
  host: { home: string }
}

export interface CodingNsTransport {
  rpc<TResponse = unknown, TPayload = unknown>(request: CodingNsRpcRequest<TPayload>): Promise<TResponse>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  openStream<TChunk = unknown, TPayload = unknown>(request: CodingNsStreamRequest<TPayload>): AsyncIterable<TChunk>
  loadBundle(url: string): Promise<void>
  getGeneration(): CodingNsTransportGeneration | undefined
  onGenerationChange(listener: (generation: CodingNsTransportGeneration | undefined) => void): () => void
  reconnect(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export interface CodingNsTransportHooks {
  rpc?: CodingNsTransport['rpc']
  fetch?: CodingNsTransport['fetch']
  openStream?: CodingNsTransport['openStream']
  loadBundle?: CodingNsTransport['loadBundle']
  generation?: CodingNsTransport['getGeneration']
  onGenerationChange?: CodingNsTransport['onGenerationChange']
  reconnect?: CodingNsTransport['reconnect']
  close?: CodingNsTransport['close']
}

export interface CodingNsTransportErrorShape {
  code: CodingNsDshErrorCode
  message: string
  generationId?: number
}
