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
    nativeReplacement: {
      dshFeature: '@deepseek-ai/dsh-experimental-terminal-bundle',
      since: '0.2.2-alpha.2',
      coverage: 'full',
      note: 'DSH now bundles the native terminal surface and its settings path.',
    },
    ui: {
      label: 'Terminal enhancements',
      description: 'Configure the default shell and terminal appearance. Enabling or disabling requires a DSH restart.',
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
