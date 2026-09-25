import type { FeatureRegistry } from '../../features/registry.js'
import type { FeatureUiDescriptor } from '../../shared/contracts/feature.js'
import { lanAccessFeature } from './lan-access.js'
import { reverseProxyFeature } from './reverse-proxy.js'
import { loginProtectionFeature } from './login-protection.js'
import { cliAdaptersFeature } from './cli-adapters.js'
import { terminalEnhancementFeature } from './terminal-enhancement.js'
import { workspaceSessionEnhancementFeature } from './workspace-session-enhancement.js'
import { debugFeature } from './debug.js'
import type { CodingNsClientFeatureModule, CodingNsClientServices } from './types.js'

/** Client 侧功能模块清单：新增模块在这里登记一行，不需要改动设置页和入口。 */
export const CLIENT_FEATURES: readonly CodingNsClientFeatureModule[] = [
  lanAccessFeature,
  loginProtectionFeature,
  reverseProxyFeature,
  cliAdaptersFeature,
  workspaceSessionEnhancementFeature,
  terminalEnhancementFeature,
  debugFeature,
]

/** 设置页要显示的一个模块及其界面描述。 */
export interface CodingNsSettingsModule {
  readonly module: CodingNsClientFeatureModule
  readonly ui: FeatureUiDescriptor
}

/**
 * 汇总需要在设置页显示的模块，按 ui.order 升序。
 *
 * 归属 Host 的模块由 Host 侧配置承载，这里跳过；没有 ui 描述的模块不显示。
 */
export function settingsModules(
  registry: FeatureRegistry<CodingNsClientServices, CodingNsClientFeatureModule>,
): readonly CodingNsSettingsModule[] {
  const entries: CodingNsSettingsModule[] = []
  for (const module of registry.modules()) {
    if (module.descriptor.runtime === 'host') continue
    const ui = module.descriptor.ui
    if (ui === undefined) continue
    entries.push({ module, ui })
  }
  entries.sort((left, right) => (left.ui.order ?? 0) - (right.ui.order ?? 0))
  return entries
}

export { lanAccessFeature, loginProtectionFeature, reverseProxyFeature, cliAdaptersFeature, workspaceSessionEnhancementFeature, terminalEnhancementFeature, debugFeature }
export { startBrowserRelayConnection } from './reverse-proxy.js'
export { LanAccessPanel } from './lan-access-panel.js'
export { LoginProtectionPanel } from './login-protection-panel.js'
export { ReverseProxyPanel } from './reverse-proxy-panel.js'
export { CliAdaptersPanel } from './cli-adapters.js'
export { TerminalEnhancementPanel } from './terminal-enhancement-panel.js'
export { WorkspaceSessionEnhancementPanel } from './workspace-session-enhancement-panel.js'
export type {
  CodingNsClientFeatureModule,
  CodingNsClientServices,
  CodingNsRpcClient,
  CodingNsRpcResult,
  FeaturePanelProps,
} from './types.js'
