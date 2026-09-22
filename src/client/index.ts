/**
 * DSH Client 入口。
 *
 * 该文件只使用浏览器安全的 TypeScript/JavaScript。Client 侧能力全部以功能模块
 * 形式交给 FeatureRegistry 管理：设置页遍历注册表渲染卡片，设置里的启用开关
 * 驱动模块 start/disable 与资源清理。入口只负责装配与依赖声明。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { FeatureRegistry } from '../features/registry.js'
import {
  CODINGNS_SETTINGS_NAMESPACE,
  enabledFeatureNames,
  type CodingNsSettings,
} from '../shared/contracts/config.js'
import { CLIENT_FEATURES } from './features/index.js'
import type { CodingNsClientFeatureModule, CodingNsClientServices } from './features/types.js'
import { ensureCryptoRandomUUID } from './lan-access.js'
import { CodingNsSettingsSection } from './settings-section.js'

// DSH 在 Client/Cordis 建立前就可能读取 randomUUID，必须在入口加载时修复。
ensureCryptoRandomUUID()

export { ensureCryptoRandomUUID } from './lan-access.js'
export type {
  CryptoRandomUUIDInstallResult,
  LanAccessCrypto,
  LanAccessGlobal,
} from './lan-access.js'
export { CLIENT_FEATURES, settingsModules } from './features/index.js'
export type {
  CodingNsClientFeatureModule,
  CodingNsClientServices,
  CodingNsRpcClient,
  CodingNsRpcResult,
  FeaturePanelProps,
} from './features/index.js'
export { CodingNsSettingsSection } from './settings-section.js'

/** Client Runner 用于等待服务就绪的 Cordis 依赖声明。 */
export const inject = ['slots', 'settingsScope', 'connection'] as const

/**
 * 把 CodingNS 设置页挂载到 DSH 设置左侧导航，并让模块开关驱动启停。
 *
 * 设置页与启停同步共享同一个注册表实例，所以界面上的模块清单就是运行时实际
 * 管理的模块清单，两者不会漂移。
 */
export function apply(ctx?: Context): void {
  if (ctx === undefined) return

  ctx.inject(['slots', 'settingsScope', 'connection'], (settingsCtx) => {
    const settings = settingsCtx.settingsScope.bind<CodingNsSettings>({
      namespace: CODINGNS_SETTINGS_NAMESPACE,
    })
    // Host 与 Client 共用同一个 cordis Context 类型，而 DSH 的 Host 侧声明会把
    // connection 收窄成 Host 句柄；浏览器侧按 ConnectionHandle 收窄回真实形状。
    const connection = settingsCtx.connection as unknown as ConnectionHandle
    const services: CodingNsClientServices = { settings, rpc: connection.rpc }
    const registry = new FeatureRegistry<CodingNsClientServices, CodingNsClientFeatureModule>(services)
    registry.registerMany(CLIENT_FEATURES)
    registry.validate()

    settingsCtx.effect(() => {
      const sync = (): void => {
        void registry
          .reconcile(enabledFeatureNames(registry.descriptors(), settings.getSnapshot().value))
          .catch((error: unknown) => {
            console.error('dsh-codingns: 功能模块状态同步失败', error)
          })
      }
      sync()
      return settings.subscribe(sync)
    }, 'dsh-codingns: 功能模块启停同步')

    settingsCtx.slots.inject('settings.section', () => settingsCtx.slots.register({
      name: 'settings.section',
      id: 'codingns',
      order: 30,
      label: 'CodingNS',
      inject: () => ({ settings, registry, services }),
    }, CodingNsSettingsSection))
  })
}
