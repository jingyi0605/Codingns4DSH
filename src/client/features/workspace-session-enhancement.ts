import { DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS, normalizeSidebarGestureSettings, normalizeSubscriptionUsageSettings } from '../../shared/contracts/config.js'
import { parseVirtualSessionId } from '../../shared/contracts/peer-host.js'
import { debugWarn } from '../../shared/debug.js'
import {
  clearSessionAdapters,
  fetchSessionAdapters,
  replaceSessionAdapters,
} from '../session-adapter-cache.js'
import { readNativeWorkspaceSnapshot } from '../native-workspace-store.js'
import { requestPeerHostAggregateRefresh } from '../peer-host-aggregate-refresh.js'
import { startWorkspaceSessionLogoDom, type WorkspaceSessionLogoDomController } from '../workspace-session-logo-dom.js'
import { startWorkspaceSessionArchiveDom, type WorkspaceSessionArchiveDomController } from '../workspace-session-archive-dom.js'
import { startWorkspaceSessionVisibilityDom, type WorkspaceSessionVisibilityDomController } from '../workspace-session-visibility-dom.js'
import { startMobileSidebarGestures, type MobileSidebarGestureController } from '../mobile-sidebar-gestures.js'
import { WorkspaceSessionEnhancementPanel } from './workspace-session-enhancement-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'
import { registerSubscriptionSlot } from '../subscription-slot.js'
import { registerQuickPhraseSlot } from '../quick-phrase-slot.js'
import { startWorkspaceSessionRightbarDom, type WorkspaceSessionRightbarDomController } from '../workspace-session-rightbar-dom.js'

/** DSH 0.1.6 原生会话行增强：Logo 与归档会话入口共用同一生命周期。 */
export const workspaceSessionEnhancementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'workspaceSessionEnhancement',
    version: '0.1.1',
    enabledByDefault: false,
    dependencies: ['cliAdapters'],
    runtime: 'client',
    ui: {
      label: '工作区会话增强',
      description: '在原生工作区会话行显示 Agent Logo、归档入口、工作区隐藏/恢复入口和订阅/用量信息，提供本地快捷会话，并可记忆对话窗口与右侧栏宽度比例。',
      labelKey: 'feature.workspaceSession.label',
      descriptionKey: 'feature.workspaceSession.description',
      order: 35,
      defaultOpen: true,
      legacyFallback: true,
      legacyFallbackKey: 'feature.workspaceSession.legacyFallback',
    },
  },
  start(context) {
    let generation = 0
    let logoDom: WorkspaceSessionLogoDomController | undefined
    let archiveDom: WorkspaceSessionArchiveDomController | undefined
    let visibilityDom: WorkspaceSessionVisibilityDomController | undefined
    let rightbarDom: WorkspaceSessionRightbarDomController | undefined
    let gestureController: MobileSidebarGestureController | undefined
    let adapterRefreshTimer: ReturnType<typeof globalThis.setInterval> | undefined
    let disposeSubscription: (() => void) | undefined
    let disposeQuickPhrases: (() => void) | undefined
    let lastSubscriptionUsageSignature: string | null = null

    const disableLogo = (): void => {
      generation += 1
      logoDom?.dispose()
      logoDom = undefined
      if (adapterRefreshTimer !== undefined) {
        globalThis.clearInterval(adapterRefreshTimer)
        adapterRefreshTimer = undefined
      }
      clearSessionAdapters()
    }
    const enableArchive = (): void => {
      if (archiveDom === undefined) {
        archiveDom = startWorkspaceSessionArchiveDom({
          remote: context.services.remote,
          readNativeWorkspaceSnapshot: () => readNativeWorkspaceSnapshot(context.services.uiContext),
          onSessionUnarchived: async (sessionId) => {
            // 远端虚拟会话的归档状态只存在于聚合投影里，取消归档后同步一次再重读入口。
            if (parseVirtualSessionId(sessionId) === null) return
            await requestPeerHostAggregateRefresh()
          },
        })
      }
    }
    const enableWorkspaceVisibility = (hiddenWorkspaceIds: readonly string[]): void => {
      if (visibilityDom === undefined) {
        visibilityDom = startWorkspaceSessionVisibilityDom({
          remote: context.services.remote,
          hiddenWorkspaceIds,
          onHiddenWorkspaceIdsChange: async (ids) => {
            await context.services.settings.mutate([{
              op: 'set',
              path: ['workspaceSessionEnhancement', 'hiddenWorkspaceIds'],
              value: [...ids],
            }])
          },
        })
        return
      }
      visibilityDom.setHiddenWorkspaceIds(hiddenWorkspaceIds)
    }
    const disableWorkspaceVisibility = (): void => {
      visibilityDom?.dispose()
      visibilityDom = undefined
    }
    const enableRightbarMemory = (): void => {
      if (rightbarDom === undefined) rightbarDom = startWorkspaceSessionRightbarDom()
    }
    const disableRightbarMemory = (): void => {
      rightbarDom?.dispose()
      rightbarDom = undefined
    }
    const enableGestures = (): void => {
      if (gestureController !== undefined) {
        gestureController.refresh()
        return
      }
      gestureController = startMobileSidebarGestures({
        ports: { layout: context.services.layout, sidebarRight: context.services.sidebarRight },
        settings: () => normalizeSidebarGestureSettings(context.services.settings.getSnapshot().value?.workspaceSessionEnhancement),
        onDiagnostic: (code) => debugWarn('codingns4dsh: 侧栏手势不可用', { code }),
      })
    }
    const disableGestures = (): void => {
      gestureController?.dispose()
      gestureController = undefined
    }
    const enableSubscription = (): void => {
      if (disposeSubscription !== undefined || context.services.slots === undefined) return
      // 查询间隔对所有适配器统一生效：slot 内部的自动刷新定时器读取同一份设置。
      disposeSubscription = registerSubscriptionSlot(context.services.slots, context.services.rpc, () => (
        normalizeSubscriptionUsageSettings(context.services.settings.getSnapshot().value?.subscriptionUsage).refreshIntervalMins
      ))
    }
    const disableSubscription = (): void => {
      disposeSubscription?.()
      disposeSubscription = undefined
    }
    const enableQuickPhrases = (): void => {
      if (disposeQuickPhrases !== undefined || context.services.slots === undefined || context.services.locale === undefined) return
      disposeQuickPhrases = registerQuickPhraseSlot(context.services.slots, context.services.settings, context.services.locale)
    }
    const disableQuickPhrases = (): void => {
      disposeQuickPhrases?.()
      disposeQuickPhrases = undefined
    }
    const disposeAll = (): void => {
      disableLogo()
      archiveDom?.dispose()
      archiveDom = undefined
      disableWorkspaceVisibility()
      disableRightbarMemory()
      disableGestures()
      disableSubscription()
      disableQuickPhrases()
    }
    const enableLogo = (): void => {
      if (logoDom !== undefined) return
      const currentGeneration = ++generation
      logoDom = startWorkspaceSessionLogoDom()
      const refreshAdapters = (): void => {
        void fetchSessionAdapters(context.services.rpc)
        .then((bindings) => {
          if (generation !== currentGeneration || logoDom === undefined) return
          replaceSessionAdapters(bindings)
          logoDom.refresh()
          archiveDom?.refresh()
        })
        .catch(() => undefined)
      }
      refreshAdapters()
      // 旧会话在 DSH 中按需加载；加载后 Host 才能识别其适配器。定期拉取
      // 脱敏映射，确保侧栏不会一直停留在首次扫描时的默认 DSH 图标。
      adapterRefreshTimer = globalThis.setInterval(refreshAdapters, 2_000)
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
      const showWorkspaceHiding = workspaceSettings?.showWorkspaceHiding
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showWorkspaceHiding
      const hiddenWorkspaceIds = workspaceSettings?.hiddenWorkspaceIds
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.hiddenWorkspaceIds
      if (showWorkspaceHiding) enableWorkspaceVisibility(hiddenWorkspaceIds)
      else disableWorkspaceVisibility()
      const showAdapterLogo = workspaceSettings?.showAdapterLogo
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showAdapterLogo
      if (showAdapterLogo) enableLogo()
      else disableLogo()
      const showSubscriptionUsage = workspaceSettings?.showSubscriptionUsage
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showSubscriptionUsage
      if (showSubscriptionUsage) enableSubscription()
      else disableSubscription()
      const showQuickPhrases = workspaceSettings?.showQuickPhrases
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showQuickPhrases
      if (showQuickPhrases) enableQuickPhrases()
      else disableQuickPhrases()
      const rememberConversationRightbarRatio = workspaceSettings?.rememberConversationRightbarRatio
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.rememberConversationRightbarRatio
      if (rememberConversationRightbarRatio) enableRightbarMemory()
      else disableRightbarMemory()
      const sidebarGestures = workspaceSettings?.sidebarGestures
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.sidebarGestures
      if (sidebarGestures) enableGestures()
      else disableGestures()
      // 用量查询间隔变更后立即重挂 slot，让新间隔马上生效，而不是等下一次开关切换。
      const subscriptionUsageSignature = JSON.stringify(context.services.settings.getSnapshot().value?.subscriptionUsage ?? null)
      if (lastSubscriptionUsageSignature === null) {
        lastSubscriptionUsageSignature = subscriptionUsageSignature
      } else if (subscriptionUsageSignature !== lastSubscriptionUsageSignature) {
        lastSubscriptionUsageSignature = subscriptionUsageSignature
        if (disposeSubscription !== undefined) {
          disableSubscription()
          if (showSubscriptionUsage) enableSubscription()
        }
      }
    }

    sync()
    const unsubscribe = context.services.settings.subscribe(sync)
    context.resources.add(unsubscribe)
    context.resources.add(disposeAll)
  },
  settingsPanel: WorkspaceSessionEnhancementPanel,
}
