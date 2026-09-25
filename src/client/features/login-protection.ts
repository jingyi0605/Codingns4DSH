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
      description: '为局域网和中继访问设置统一的本地账号验证，本机回环地址始终放行。',
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
