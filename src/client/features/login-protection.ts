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
      label: '登录保护',
      description: '统一账号保护访问',
      labelKey: 'feature.loginProtection.label',
      descriptionKey: 'feature.loginProtection.description',
      order: 15,
      alwaysEnabled: true,
      defaultOpen: true,
    },
  },
  start: () => undefined,
  settingsPanel: LoginProtectionPanel,
}
