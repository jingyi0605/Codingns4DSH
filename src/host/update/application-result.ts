import type { PluginActivationState, PluginPackageState, PluginUpdateApplication } from '../../shared/contracts/plugin-update.js'

export function derivePluginUpdateApplication(
  targetVersion: string, packageState: PluginPackageState, host: PluginActivationState, client: PluginActivationState,
): PluginUpdateApplication {
  if (packageState === 'rolled-back' || host.state === 'failed' || client.state === 'failed') return 'failed'
  if (packageState !== 'installed') return 'activation-unknown'
  if (host.state === 'restart-required' || client.state === 'restart-required' || host.state === 'unsupported' || client.state === 'unsupported') return 'restart-required'
  if (host.state === 'active' && host.version === targetVersion && client.state === 'active' && client.version === targetVersion) {
    return 'applied-without-desktop-restart'
  }
  return 'activation-unknown'
}
