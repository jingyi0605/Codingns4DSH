import { DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS } from '../../shared/contracts/config.js'
import {
  clearSessionAdapters,
  fetchSessionAdapters,
  replaceSessionAdapters,
} from '../session-adapter-cache.js'
import { startWorkspaceSessionLogoDom, type WorkspaceSessionLogoDomController } from '../workspace-session-logo-dom.js'
import { startWorkspaceSessionArchiveDom, type WorkspaceSessionArchiveDomController } from '../workspace-session-archive-dom.js'
import { WorkspaceSessionEnhancementPanel } from './workspace-session-enhancement-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'
import { registerSubscriptionSlot } from '../subscription-slot.js'

/** DSH 0.1.6 原生会话行增强：Logo 与归档会话入口共用同一生命周期。 */
export const workspaceSessionEnhancementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'workspaceSessionEnhancement',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: ['cliAdapters'],
    runtime: 'client',
    ui: {
      label: '工作区会话增强',
      description: '在原生工作区会话行显示 Agent Logo、归档入口和订阅/用量信息。',
      labelKey: 'feature.workspaceSession.label',
      descriptionKey: 'feature.workspaceSession.description',
      order: 35,
      defaultOpen: true,
    },
  },
  start(context) {
    let generation = 0
    let logoDom: WorkspaceSessionLogoDomController | undefined
    let archiveDom: WorkspaceSessionArchiveDomController | undefined
    let disposeSubscription: (() => void) | undefined

    const disableLogo = (): void => {
      generation += 1
      logoDom?.dispose()
      logoDom = undefined
      clearSessionAdapters()
    }
    const enableArchive = (): void => {
      if (archiveDom === undefined) archiveDom = startWorkspaceSessionArchiveDom({ remote: context.services.remote })
    }
    const enableSubscription = (): void => {
      if (disposeSubscription !== undefined || context.services.slots === undefined) return
      disposeSubscription = registerSubscriptionSlot(context.services.slots, context.services.rpc)
    }
    const disableSubscription = (): void => {
      disposeSubscription?.()
      disposeSubscription = undefined
    }
    const disposeAll = (): void => {
      disableLogo()
      archiveDom?.dispose()
      archiveDom = undefined
      disableSubscription()
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
          archiveDom?.refresh()
        })
        .catch(() => undefined)
    }
    const sync = (): void => {
      const workspaceSettings = context.services.settings.getSnapshot().value?.workspaceSessionEnhancement
      const showArchivedSessions = workspaceSettings?.showArchivedSessions
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showArchivedSessions
      if (showArchivedSessions) enableArchive()
      else {
        archiveDom?.dispose()
        archiveDom = undefined
      }
      const showAdapterLogo = workspaceSettings?.showAdapterLogo
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showAdapterLogo
      if (showAdapterLogo) enableLogo()
      else disableLogo()
      const showSubscriptionUsage = workspaceSettings?.showSubscriptionUsage
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showSubscriptionUsage
      if (showSubscriptionUsage) enableSubscription()
      else disableSubscription()
    }

    sync()
    const unsubscribe = context.services.settings.subscribe(sync)
    context.resources.add(unsubscribe)
    context.resources.add(disposeAll)
  },
  settingsPanel: WorkspaceSessionEnhancementPanel,
}
