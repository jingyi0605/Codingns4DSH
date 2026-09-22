/**
 * DSH Host 入口。
 *
 * Host 侧能力全部以功能模块形式交给 FeatureRegistry 管理：依赖顺序、启停和
 * 资源释放由注册表负责，设置里的模块开关通过 watch 驱动 reconcile。入口本身
 * 只负责装配，不承载任何具体业务逻辑，因此新增模块不需要修改这个文件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { FeatureRegistry } from '../features/registry.js'
import { enabledFeatureNames } from '../shared/contracts/config.js'
import { HOST_FEATURES } from './features/index.js'
import type { CodingNsHostServices } from './features/types.js'
import { registerCodingNsRpc } from './rpc.js'
import { CodingNsRpcTable } from './rpc-table.js'
import { registerCodingNsSettings } from './settings.js'

export function apply(ctx?: Context): void {
  if (ctx === undefined) return

  ctx.inject(['settings', 'connection', 'webServer'], (hostCtx) => {
    const webServerPort = (hostCtx as Context & { webServer: { port: number } }).webServer.port
    const settings = registerCodingNsSettings(hostCtx)
    const services: CodingNsHostServices = { rpc: new CodingNsRpcTable(), settings, dshWebPort: webServerPort }
    const registry = new FeatureRegistry<CodingNsHostServices>(services)
    registry.registerMany(HOST_FEATURES)
    registry.validate()

    registerCodingNsRpc(hostCtx, services.rpc)

    hostCtx.effect(() => {
      const sync = (): void => {
        void registry
          .reconcile(enabledFeatureNames(registry.descriptors(), settings.get()))
          .catch((error: unknown) => {
            console.error('dsh-codingns: 功能模块状态同步失败', error)
          })
      }
      sync()
      return settings.watch(sync)
    }, 'dsh-codingns: 功能模块启停同步')
  })
}

export { HOST_FEATURES, createAuthFeature, createLanAccessDshFeature } from './features/index.js'
export type { CodingNsHostServices } from './features/index.js'
export { CodingNsSettingsSchema, registerCodingNsSettings } from './settings.js'
export { createCodingNsRpcHandler, registerCodingNsRpc } from './rpc.js'
export {
  CodingNsRpcError,
  CodingNsRpcTable,
  type CodingNsRpcHandler,
  type CodingNsRpcTarget,
} from './rpc-table.js'

export { CodingNsAuthSession } from './auth-session.js'
export {
  CODINGNS_CONTROL_API_PATHS,
  CodingNsControlApiError,
  HttpCodingNsControlApiClient,
  type CodingNsControlApiClient,
  type CodingNsControlClient,
  type HttpCodingNsControlApiClientOptions,
} from './control-api-client.js'
export {
  InMemoryCodingNsCredentialStore,
  type CodingNsCredentialStore,
  type HostCredentialRecord,
} from './credential-store.js'
export type {
  LoginByEmailResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from './control-api-client.js'
export {
  LanAccessDshError,
  LanAccessDshProxy,
  createLanAccessDshRpcHandler,
  createNodeLanAccessDshRuntime,
  normalizeLanAccessDshConfig,
  type LanAccessDshRuntime,
  type LanAccessDshStream,
} from './lan-access-dsh.js'
