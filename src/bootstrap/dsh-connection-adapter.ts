import {
  assertSupportedDshVersion,
  SUPPORTED_DSH_VERSION,
  type CodingNsTransportGeneration,
} from '../shared/index.js'
import type { CodingNsTransportHooks, CodingNsTransport } from '../shared/index.js'
import { DshCodingNsTransport } from '../transport/dsh-transport.js'
import {
  installPreCordisTransport,
  type CodingNsTransportRegistration,
} from './index.js'

/** DSH 0.1.6-alpha.2 的 ClientConnectionRpc 结果形状。 */
export interface DshConnectionRpcResult<T = unknown> {
  readonly ok: true
  readonly value: T
}

export interface DshConnectionRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

export type DshConnectionRpcResponse<T = unknown> =
  | DshConnectionRpcResult<T>
  | { readonly ok: false; readonly error: DshConnectionRpcFailure }

/** 从 DSH 0.1.6-alpha.2 ClientTransportHooks 提取的最小运行时接口。 */
export interface DshClientTransportHooks {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<DshConnectionRpcResponse>
    open?(channel: string, endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
  }
  fetch?: (input: URL, init: RequestInit) => Promise<Response>
  openStream?: (endpoint: string, payload: unknown, signal: AbortSignal) => AsyncIterable<unknown>
  loadBundle?: (url: string) => Promise<void>
  ownsHost?: boolean
  streamBaseUrl?: string
}

export interface DshGenerationSource {
  (signal: AbortSignal, ready: (host: { home: string }) => void): Promise<void>
}

export interface DshConnectionHandle {
  registerGenerationSource(source: DshGenerationSource): () => void
  start(sinks: {
    onReconnectRequested?: () => void
    onConnected?: (host: { home: string }) => void
    onStateChange?: (state: 'connected' | 'connecting' | 'disconnected') => void
  }): { stop(): void }
}

export interface DshConnectionContext {
  connection: DshConnectionHandle
  effect(dispose: () => void | Promise<void>, name?: string): unknown
}

export interface DshConnectionAdapter {
  readonly hooks: DshClientTransportHooks
  readonly generationSource: DshGenerationSource
  readonly dispose: () => Promise<void>
}

export interface DshTransportLifecycle {
  generation?: () => CodingNsTransportGeneration | undefined
  onGenerationChange?: (listener: (generation: CodingNsTransportGeneration | undefined) => void) => () => void
  reconnect?: (signal?: AbortSignal) => Promise<void>
  close?: () => Promise<void>
}

/**
 * 将插件内部 Transport 映射为 DSH 的 ClientTransportHooks。
 *
 * DSH 的 rpc 以 channel/endpoint 分离路由；插件帧协议暂时只有一个 method
 * 字段，因此适配层保留完整路由在 payload 中，避免丢失 DSH 的绝对 channel。
 */
export function createDshClientTransportHooks(transport: CodingNsTransport): DshClientTransportHooks {
  const rpc = {
    async call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<DshConnectionRpcResponse> {
      try {
        const request = {
          method: endpoint,
          payload: { channel, payload },
          ...(signal === undefined ? {} : { signal }),
        }
        const value = await transport.rpc(request)
        return { ok: true, value }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'transport',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
        }
      }
    },
    open(channel: string, endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown> {
      return transport.openStream({ method: endpoint, payload: { channel, payload }, signal })
    },
  }

  const hooks: DshClientTransportHooks = {
    rpc,
    fetch: (input, init) => transport.fetch(input, init),
    openStream: (endpoint, payload, signal) => transport.openStream({ method: endpoint, payload, signal }),
    loadBundle: (url) => transport.loadBundle(url),
    generation: transport.getGeneration.bind(transport),
    onGenerationChange: transport.onGenerationChange.bind(transport),
    reconnect: transport.reconnect.bind(transport),
    close: transport.close.bind(transport),
  } as DshClientTransportHooks & CodingNsTransportHooks

  const generation = transport.getGeneration()
  if (generation?.host.home) hooks.ownsHost = true
  return hooks
}

/**
 * 将插件 generation 转换为 DSH ConnectionGenerationSource。
 * 每个 source 只负责一个 generation；generation 失效后 promise 结束，
 * 由 DSH ConnectionController 统一触发下一次 reconnect。
 */
export function createDshGenerationSource(transport: CodingNsTransport): DshGenerationSource {
  return (signal, ready) => new Promise<void>((resolve) => {
    let published: CodingNsTransportGeneration | undefined
    let settled = false
    const cleanup = transport.onGenerationChange((generation) => {
      if (settled) return
      if (published === undefined && generation !== undefined) {
        published = generation
        ready({ home: generation.host.home })
        return
      }
      if (published !== undefined && (generation === undefined || generation.id !== published.id)) finish()
    })
    const abort = () => finish()
    signal.addEventListener('abort', abort, { once: true })

    const current = transport.getGeneration()
    if (current !== undefined) {
      published = current
      ready({ home: current.host.home })
    }

    function finish() {
      if (settled) return
      settled = true
      cleanup()
      signal.removeEventListener('abort', abort)
      resolve()
    }
  })
}

/** 从全局 hooks 读取 generation，供 Client entry 不持有 Node/Host 对象。 */
export function createDshGenerationSourceFromHooks(
  hooks: DshTransportLifecycle,
): DshGenerationSource {
  return (signal, ready) => new Promise<void>((resolve) => {
    if (!hooks.generation || !hooks.onGenerationChange) {
      resolve()
      return
    }
    let published: CodingNsTransportGeneration | undefined
    let settled = false
    const cleanup = hooks.onGenerationChange((generation) => {
      if (settled) return
      if (published === undefined && generation !== undefined) {
        published = generation
        ready({ home: generation.host.home })
      } else if (published !== undefined && (generation === undefined || generation.id !== published.id)) {
        finish()
      }
    })
    const abort = () => finish()
    signal.addEventListener('abort', abort, { once: true })
    const current = hooks.generation()
    if (current !== undefined) {
      published = current
      ready({ home: current.host.home })
    }
    function finish() {
      if (settled) return
      settled = true
      cleanup()
      signal.removeEventListener('abort', abort)
      resolve()
    }
  })
}

/**
 * 将已安装的 DSH Connection service 绑定到 CodingNS Transport。
 * 该函数只依赖 DSH 公开的 registerGenerationSource/start/stop，不覆盖默认 Connection。
 */
export function bindDshConnection(
  ctx: DshConnectionContext,
  transport: DshCodingNsTransport,
): () => Promise<void> {
  return bindDshConnectionHooks(ctx, {
    generation: transport.getGeneration.bind(transport),
    onGenerationChange: transport.onGenerationChange.bind(transport),
    reconnect: transport.reconnect.bind(transport),
    close: transport.close.bind(transport),
  })
}

/** 将全局 hooks 的 generation/reconnect/close 生命周期接入 DSH Connection。 */
export function bindDshConnectionHooks(
  ctx: DshConnectionContext,
  hooks: DshTransportLifecycle,
): () => Promise<void> {
  const source = createDshGenerationSourceFromHooks(hooks)
  const unregister = ctx.connection.registerGenerationSource(source)
  const loop = ctx.connection.start({
    onReconnectRequested: () => { void hooks.reconnect?.() },
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    unregister()
    loop.stop()
    await hooks.close?.()
  }
}

/**
 * pre-Cordis 启动胶水：登记正确的 DSH hooks，并返回 Connection 绑定函数。
 * 版本检查严格锁定 0.1.6-alpha.2，避免未经验证的 generation 契约静默漂移。
 */
export function installDshTransport(options: {
  dshVersion: string
  transport: DshCodingNsTransport
}): CodingNsTransportRegistration & { hooks: DshClientTransportHooks } {
  assertSupportedDshVersion(options.dshVersion)
  const hooks = createDshClientTransportHooks(options.transport)
  const registration = installPreCordisTransport({
    dshVersion: options.dshVersion,
    transport: hooks as unknown as CodingNsTransportHooks,
  })
  return { ...registration, hooks }
}

export const SUPPORTED_DSH_CONNECTION_VERSION = SUPPORTED_DSH_VERSION
