import type {
  CodingNsRpcRequest,
  CodingNsStreamRequest,
  CodingNsTransport,
  CodingNsTransportGeneration,
  CodingNsTransportHooks,
} from '../shared/index.js'
import type { CodingNsCarrier } from './carrier.js'
import { DshTunnelMultiplexer } from './multiplexer.js'
import type { TunnelFlowControl } from './multiplexer.js'
import type { DshHostScope } from './dsh-envelope.js'
import type { DshSession } from './dsh-session.js'
import type { DshTransportDebugLogger } from './debug.js'

export interface DshCodingNsTransportOptions {
  carrier: CodingNsCarrier
  generation: CodingNsTransportGeneration
  ownsHost?: boolean
  streamBaseUrl?: string
  reconnect?: (signal?: AbortSignal) => Promise<void | CodingNsTransportGeneration>
  flowControl?: TunnelFlowControl
  hostScope?: DshHostScope
  session?: DshSession
  requireSessionReady?: boolean
  debug?: DshTransportDebugLogger
}

/** 将 Tunnel Multiplexer 映射为 DSH ClientTransportHooks。 */
export class DshCodingNsTransport implements CodingNsTransport {
  private readonly listeners = new Set<(generation: CodingNsTransportGeneration | undefined) => void>()
  private readonly multiplexer: DshTunnelMultiplexer
  private generation: CodingNsTransportGeneration | undefined

  constructor(private readonly options: DshCodingNsTransportOptions) {
    this.generation = options.generation
    this.multiplexer = new DshTunnelMultiplexer(options.carrier, {
      idPrefix: `g${options.generation.id}`,
      generation: String(options.generation.id),
      ...(options.hostScope ? { hostScope: options.hostScope } : {}),
      ...(options.session ? { session: options.session } : {}),
      ...(options.requireSessionReady === undefined ? {} : { requireSessionReady: options.requireSessionReady }),
      ...(options.flowControl ? { flowControl: options.flowControl } : {}),
      ...(options.debug ? { debug: options.debug } : {}),
    })
  }

  rpc<TResponse = unknown, TPayload = unknown>(request: CodingNsRpcRequest<TPayload>): Promise<TResponse> {
    return this.multiplexer.request<TResponse>('rpc', request, request.signal)
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const result = await this.multiplexer.request<{ status: number; headers: [string, string][]; body: string }>('fetch', {
      input: String(input),
      init: init ? { method: init.method, headers: [...new Headers(init.headers).entries()], body: typeof init.body === 'string' ? init.body : undefined } : undefined,
    }, init?.signal ?? undefined)
    return new Response(result.body, { status: result.status, headers: result.headers })
  }

  /** 向 Host 的 Remote Web Runtime 发送带明确 operation 的请求。 */
  webRequest<TResponse = unknown, TPayload = unknown>(operation: string, payload: TPayload, signal?: AbortSignal): Promise<TResponse> {
    return this.multiplexer.requestOperation<TResponse>('web', operation, payload, signal)
  }

  /** 打开一个由 Remote Web Runtime 管理的 Web 流。 */
  openWebStream<TChunk = unknown, TPayload = unknown>(operation: string, payload: TPayload, signal?: AbortSignal): AsyncIterable<TChunk> {
    return this.multiplexer.openStreamOperation<TChunk>('web', operation, payload, signal)
  }

  openWebStreamWithId<TChunk = unknown, TPayload = unknown>(operation: string, payload: TPayload, signal?: AbortSignal): { streamId: string; stream: AsyncIterable<TChunk> } {
    return this.multiplexer.openStreamOperationWithId<TChunk>('web', operation, payload, signal)
  }

  sendWebStream(streamId: string, type: string, body?: Uint8Array, meta: Record<string, unknown> = {}): void {
    this.multiplexer.sendStreamMessage(streamId, 'web', type, meta, body)
  }

  closeWebStream(streamId: string): void {
    this.multiplexer.closeStream(streamId, 'web')
  }

  openStream<TChunk = unknown, TPayload = unknown>(request: CodingNsStreamRequest<TPayload>): AsyncIterable<TChunk> {
    return this.multiplexer.openStream<TChunk>(request, request.signal)
  }

  loadBundle(url: string): Promise<void> {
    return this.multiplexer.request('control', { method: 'loadBundle', url }).then(() => undefined)
  }

  getGeneration(): CodingNsTransportGeneration | undefined { return this.generation }

  onGenerationChange(listener: (generation: CodingNsTransportGeneration | undefined) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async reconnect(signal?: AbortSignal): Promise<void> {
    if (!this.options.reconnect) throw new Error('未配置 Transport reconnect')
    const nextGeneration = await this.options.reconnect(signal)
    if (nextGeneration) this.updateGeneration(nextGeneration)
  }

  /** 由启动胶水在建立新物理连接后提交新 generation。旧请求会立即失效。 */
  updateGeneration(generation: CodingNsTransportGeneration): void {
    const previous = this.generation
    if (previous?.id === generation.id) return
    this.multiplexer.rotateGeneration(`g${generation.id}`)
    this.generation = generation
    for (const listener of [...this.listeners]) listener(generation)
  }

  close(): Promise<void> {
    this.multiplexer.close()
    const previous = this.generation
    this.generation = undefined
    if (previous) for (const listener of [...this.listeners]) listener(undefined)
    return this.options.carrier.close()
  }

  /** 给 pre-Cordis 启动胶水使用，不直接安装 DSH Connection。 */
  asTransportHooks(): CodingNsTransportHooks & { ownsHost?: boolean; streamBaseUrl?: string } {
    // DSH 0.1.6-alpha.2 的 ClientTransportHooks.rpc 是 ClientConnectionRpc
    // 对象，不是插件内部的 `rpc(request)` 函数。具体适配在 dsh-connection-adapter
    // 中完成；这里仅保留旧的内部 hooks 形状，避免把未确认的线路协议写进核心传输。
    const hooks: CodingNsTransportHooks & { ownsHost?: boolean; streamBaseUrl?: string } = {
      rpc: this.rpc.bind(this),
      fetch: this.fetch.bind(this),
      openStream: this.openStream.bind(this),
      loadBundle: this.loadBundle.bind(this),
      generation: this.getGeneration.bind(this),
      onGenerationChange: this.onGenerationChange.bind(this),
      reconnect: this.reconnect.bind(this),
      close: this.close.bind(this),
    }
    if (this.options.ownsHost !== undefined) hooks.ownsHost = this.options.ownsHost
    if (this.options.streamBaseUrl !== undefined) hooks.streamBaseUrl = this.options.streamBaseUrl
    return hooks
  }
}
