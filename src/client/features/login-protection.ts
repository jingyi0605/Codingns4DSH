import { LoginProtectionPanel } from './login-protection-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'

/** 独立的本地账号登录保护模块，位于局域网和中继访问模块之间。 */
export const loginProtectionFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'loginProtection',
    version: '0.2.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: 'Login protection',
      description: 'Protect LAN and relay DSH Web access with one local account; loopback access is always allowed.',
      labelKey: 'feature.loginProtection.label',
      descriptionKey: 'feature.loginProtection.description',
      order: 15,
      alwaysEnabled: true,
      defaultOpen: false,
    },
  },
  start: () => undefined,
  settingsPanel: LoginProtectionPanel,
}
