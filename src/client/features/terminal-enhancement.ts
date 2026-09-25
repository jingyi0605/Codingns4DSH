import type { CodingNsClientFeatureModule } from './types.js'
import { TerminalEnhancementPanel } from './terminal-enhancement-panel.js'

/** “终端强化”只切换 backend；插件 controller 与 Sidebar UI 始终存在。 */
export const terminalEnhancementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'terminalEnhancement',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    activation: 'restart',
    ui: {
      label: '终端强化',
      description: '配置持久终端的默认 shell 与插件终端外观。启用和禁用均需重启 DSH。',
      labelKey: 'feature.terminal.label',
      descriptionKey: 'feature.terminal.description',
      order: 40,
      defaultOpen: true,
      legacyFallback: true,
    },
  },
  start: () => undefined,
  settingsPanel: TerminalEnhancementPanel,
}
