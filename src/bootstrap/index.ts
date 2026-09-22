import {
  assertSupportedDshVersion,
  CODINGNS_DSH_ERROR_CODES,
  CodingNsDshError,
  SUPPORTED_DSH_VERSION,
} from '../shared/index.js'
import type { CodingNsTransportHooks } from '../shared/index.js'

/**
 * DSH 在 Cordis 启动前读取的页面级 Transport 形状。
 *
 * 这里故意只保留浏览器可用字段。真正的 WebRTC、信令和帧复用器由后续
 * 阶段提供，本模块只负责把已经创建好的 Transport 交给 DSH。
 */
export interface CodingNsPreCordisTransport extends CodingNsTransportHooks {
  ownsHost?: boolean
  streamBaseUrl?: string
}

export interface CodingNsBootstrapOptions {
  dshVersion: string
  transport: CodingNsPreCordisTransport
}

export interface CodingNsBootWithTransportOptions extends CodingNsBootstrapOptions {
  boot: () => void | Promise<void>
}

export interface CodingNsTransportRegistration {
  readonly transport: CodingNsPreCordisTransport
  dispose(): void
}

export const CODINGNS_BOOTSTRAP_DSH_VERSION = SUPPORTED_DSH_VERSION

type DshTransportGlobal = typeof globalThis & {
  __DSH_TRANSPORT__?: CodingNsPreCordisTransport
}

/**
 * 在 DSH Client/Cordis 启动前登记唯一 Transport。
 *
 * 普通动态插件不得调用此函数。重复登记直接失败，避免悄悄覆盖 DSH
 * 默认 Connection 或让两个连接 owner 竞争同一个 generation。
 */
export function installPreCordisTransport(
  options: CodingNsBootstrapOptions,
): CodingNsTransportRegistration {
  assertSupportedDshVersion(options.dshVersion)
  const globals = globalThis as DshTransportGlobal
  if (globals.__DSH_TRANSPORT__ !== undefined) {
    throw new CodingNsDshError(
      CODINGNS_DSH_ERROR_CODES.TRANSPORT_NOT_READY,
      'DSH 启动胶水已经登记了 Transport；不允许重复接管 Connection',
    )
  }

  globals.__DSH_TRANSPORT__ = options.transport
  let disposed = false
  return {
    transport: options.transport,
    dispose() {
      if (disposed) return
      disposed = true
      if (globals.__DSH_TRANSPORT__ === options.transport) delete globals.__DSH_TRANSPORT__
    },
  }
}

/**
 * 以一次性启动顺序执行：版本校验 -> 登记 Transport -> 启动 DSH Client。
 * boot 失败时会立即撤销全局 Transport，避免半启动状态污染下一次启动。
 */
export async function bootWithPreCordisTransport(
  options: CodingNsBootWithTransportOptions,
): Promise<CodingNsTransportRegistration> {
  const registration = installPreCordisTransport(options)
  try {
    await options.boot()
    return registration
  } catch (error) {
    registration.dispose()
    throw error
  }
}

export {
  bindDshConnection,
  bindDshConnectionHooks,
  createDshClientTransportHooks,
  createDshGenerationSource,
  createDshGenerationSourceFromHooks,
  installDshTransport,
  SUPPORTED_DSH_CONNECTION_VERSION,
} from './dsh-connection-adapter.js'
export type {
  DshClientTransportHooks,
  DshConnectionAdapter,
  DshConnectionContext,
  DshConnectionHandle,
  DshConnectionRpcFailure,
  DshConnectionRpcResponse,
  DshConnectionRpcResult,
  DshGenerationSource,
  DshTransportLifecycle,
} from './dsh-connection-adapter.js'
