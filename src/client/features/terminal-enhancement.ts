import type { CodingNsClientFeatureModule } from './types.js'
import { TerminalEnhancementPanel } from './terminal-enhancement-panel.js'

/** “终端增强”只切换 backend；插件 controller 与 Sidebar UI 始终存在。 */
export const terminalEnhancementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'terminalEnhancement',
    version: '0.1.1',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    activation: 'restart',
    ui: {
      label: '终端增强',
      description: '配置终端与默认 Shell',
      labelKey: 'feature.terminal.label',
      descriptionKey: 'feature.terminal.description',
      order: 40,
      defaultOpen: false,
      legacyFallback: true,
    },
  },
  start: () => undefined,
  settingsPanel: TerminalEnhancementPanel,
}
