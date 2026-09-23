import { DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS } from '../../shared/contracts/config.js'
import {
  clearSessionAdapters,
  fetchSessionAdapters,
  replaceSessionAdapters,
} from '../session-adapter-cache.js'
import { startWorkspaceSessionLogoDom, type WorkspaceSessionLogoDomController } from '../workspace-session-logo-dom.js'
import { WorkspaceSessionEnhancementPanel } from './workspace-session-enhancement-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'

/** DSH 0.1.6 原生会话行 Logo 的固定版本兼容模块。 */
export const workspaceSessionEnhancementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'workspaceSessionEnhancement',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: ['cliAdapters'],
    runtime: 'client',
    ui: {
      label: '工作区会话增强',
      description: '在原生工作区会话行显示对应 Agent 的 Logo。',
      order: 35,
      defaultOpen: true,
    },
  },
  start(context) {
    let generation = 0
    let logoDom: WorkspaceSessionLogoDomController | undefined

    const disableLogo = (): void => {
      generation += 1
      logoDom?.dispose()
      logoDom = undefined
      clearSessionAdapters()
    }
    const enableLogo = (): void => {
      if (logoDom !== undefined) return
      const currentGeneration = ++generation
      logoDom = startWorkspaceSessionLogoDom()
      void fetchSessionAdapters(context.services.rpc)
        .then((bindings) => {
          if (generation !== currentGeneration || logoDom === undefined) return
          replaceSessionAdapters(bindings)
          logoDom.refresh()
        })
        .catch(() => undefined)
    }
    const sync = (): void => {
      const showAdapterLogo = context.services.settings.getSnapshot().value?.workspaceSessionEnhancement
        ?.showAdapterLogo ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showAdapterLogo
      if (showAdapterLogo) enableLogo()
      else disableLogo()
    }

    sync()
    const unsubscribe = context.services.settings.subscribe(sync)
    context.resources.add(unsubscribe)
    context.resources.add(disableLogo)
  },
  settingsPanel: WorkspaceSessionEnhancementPanel,
}
