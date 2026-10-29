import type { FeatureModule } from '../../shared/contracts/feature.js'
import { createAuthFeature } from './auth.js'
import { createLanAccessDshFeature } from './lan-access-dsh.js'
import { createTerminalStatusFeature } from './terminal-status.js'
import { createCliAdaptersFeature } from '../cli-adapters/feature.js'
import { createTerminalProcessFeature } from './terminal-process.js'
import { createDebugFeature } from './debug.js'
import { createHostStatusFeature } from './host-status.js'
import { createGitManagementFeature } from './git-management.js'
import { createFileManagementFeature } from './file-management.js'
import { createQuickAppsFeature } from './quick-apps.js'
import { createPeerHostFeature } from './peer-host.js'
import { createSessionTitleOptimizationFeature } from './session-title-optimization.js'
import { createSessionTranslationFeature } from './session-translation.js'
import { createPluginUpdateFeature } from './plugin-update.js'
import { createWorkspaceMcpHostFeature } from './workspace-mcp.js'
import type { CodingNsHostServices } from './types.js'

export interface HostFeatureOptions {
  readonly terminalStatus?: Parameters<typeof createTerminalStatusFeature>[0]
}

/** 生产启动可把实际 controller 模式注入状态模块，避免向设置页报告默认占位值。 */
export function createHostFeatures(options: HostFeatureOptions = {}): readonly FeatureModule<CodingNsHostServices>[] {
  return [
    createAuthFeature(),
    createLanAccessDshFeature(),
    createTerminalStatusFeature(options.terminalStatus),
    createSessionTranslationFeature(),
    createCliAdaptersFeature(),
    createSessionTitleOptimizationFeature(),
    createTerminalProcessFeature(),
    createDebugFeature(),
    createHostStatusFeature(),
    createPluginUpdateFeature(),
    createWorkspaceMcpHostFeature(),
    createGitManagementFeature(),
    createFileManagementFeature(),
    createQuickAppsFeature(),
    createPeerHostFeature(),
  ]
}

/** Host 侧功能模块清单：新增模块在这里登记一行，不需要改动入口或 RPC 分发。 */
export const HOST_FEATURES: readonly FeatureModule<CodingNsHostServices>[] = createHostFeatures()

export { createAuthFeature } from './auth.js'
export { createLanAccessDshFeature } from './lan-access-dsh.js'
export { createTerminalStatusFeature } from './terminal-status.js'
export { createCliAdaptersFeature } from '../cli-adapters/feature.js'
export { createSessionTitleOptimizationFeature } from './session-title-optimization.js'
export { createSessionTranslationFeature } from './session-translation.js'
export { createTerminalProcessFeature } from './terminal-process.js'
export { createDebugFeature } from './debug.js'
export { createHostStatusFeature } from './host-status.js'
export { createWorkspaceMcpHostFeature } from './workspace-mcp.js'
export { createGitManagementFeature } from './git-management.js'
export { createFileManagementFeature } from './file-management.js'
export { createPeerHostFeature, toPeerHostClientRecord } from './peer-host.js'
export type { CodingNsHostServices } from './types.js'
