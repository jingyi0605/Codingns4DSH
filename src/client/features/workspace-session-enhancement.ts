import { DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS, normalizeSubscriptionUsageSettings } from '../../shared/contracts/config.js'
import { parseVirtualSessionId } from '../../shared/contracts/peer-host.js'
import {
  clearSessionAdapters,
  fetchSessionAdapters,
  replaceSessionAdapters,
} from '../session-adapter-cache.js'
import { readNativeWorkspaceListStore, readNativeWorkspaceSnapshot } from '../native-workspace-store.js'
import { requestPeerHostAggregateRefresh } from '../peer-host-aggregate-refresh.js'
import { startWorkspaceSessionLogoDom, type WorkspaceSessionLogoDomController } from '../workspace-session-logo-dom.js'
import { startWorkspaceSessionArchiveDom, type WorkspaceSessionArchiveDomController } from '../workspace-session-archive-dom.js'
import { startWorkspaceSessionVisibilityDom, type WorkspaceSessionVisibilityDomController } from '../workspace-session-visibility-dom.js'
import { WorkspaceSessionEnhancementPanel } from './workspace-session-enhancement-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'
import { registerSubscriptionSlot } from '../subscription-slot.js'
import { registerQuickPhraseSlot } from '../quick-phrase-slot.js'
import { startWorkspaceSessionRightbarDom, type WorkspaceSessionRightbarDomController } from '../workspace-session-rightbar-dom.js'
import { resolveCodingNsTranslator } from '../locale.js'
import { registerSkillCommand } from '../skill-command.js'
import { startSkillReferenceDom, type SkillReferenceDomController } from '../skill-reference-dom.js'

/** descriptor 的 label/description 只是词典缺失时的兜底，取内置中文词典。 */
const fallbackT = resolveCodingNsTranslator()

/** DSH 0.1.6 原生会话行增强：Logo 与归档会话入口共用同一生命周期。 */
export const workspaceSessionEnhancementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'workspaceSessionEnhancement',
    version: '0.1.1',
    enabledByDefault: false,
    dependencies: ['cliAdapters'],
    runtime: 'client',
    ui: {
      label: fallbackT('feature.workspaceSession.label'),
      description: fallbackT('feature.workspaceSession.description'),
      labelKey: 'feature.workspaceSession.label',
      descriptionKey: 'feature.workspaceSession.description',
      order: 35,
      defaultOpen: false,
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
    let disposeAdapterRefresh: (() => void) | undefined
    let disposeSubscription: (() => void) | undefined
    let disposeQuickPhrases: (() => void) | undefined
    let disposeSkillCommand: (() => void) | undefined
    let skillReferenceDom: SkillReferenceDomController | undefined
    let lastSubscriptionUsageSignature: string | null = null

    const disableLogo = (): void => {
      generation += 1
      logoDom?.dispose()
      logoDom = undefined
      disposeAdapterRefresh?.()
      disposeAdapterRefresh = undefined
      clearSessionAdapters()
    }
    const enableArchive = (): void => {
      if (archiveDom === undefined) {
        archiveDom = startWorkspaceSessionArchiveDom({
          remote: context.services.remote,
          readNativeWorkspaceSnapshot: () => readNativeWorkspaceSnapshot(context.services.uiContext),
          locale: context.services.locale,
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
          locale: context.services.locale,
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
    const enableSkillQuickReference = (): void => {
      if (skillReferenceDom === undefined) skillReferenceDom = startSkillReferenceDom()
      if (disposeSkillCommand !== undefined || context.services.uiContext === undefined) return
      disposeSkillCommand = registerSkillCommand(context.services.uiContext, {
        rpc: context.services.rpc,
        locale: context.services.locale,
      })
    }
    const disableSkillQuickReference = (): void => {
      disposeSkillCommand?.()
      disposeSkillCommand = undefined
      skillReferenceDom?.dispose()
      skillReferenceDom = undefined
    }
    const disposeAll = (): void => {
      disableLogo()
      archiveDom?.dispose()
      archiveDom = undefined
      disableWorkspaceVisibility()
      disableRightbarMemory()
      disableSubscription()
      disableQuickPhrases()
      disableSkillQuickReference()
    }
    const enableLogo = (): void => {
      if (logoDom !== undefined) return
      const currentGeneration = ++generation
      logoDom = startWorkspaceSessionLogoDom({ locale: context.services.locale })
      let refreshing = false
      let dirty = false
      const refreshAdapters = (): void => {
        if (refreshing) { dirty = true; return }
        refreshing = true
        void fetchSessionAdapters(context.services.rpc)
        .then((bindings) => {
          if (generation !== currentGeneration || logoDom === undefined) return
          replaceSessionAdapters(bindings)
          logoDom.refresh()
          archiveDom?.refresh()
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false
          if (dirty && generation === currentGeneration) { dirty = false; refreshAdapters() }
        })
      }
      refreshAdapters()
      // 工作区成员变化、切换会话和页面恢复时重读轻量索引，移除两秒定时扫描。
      const store = readNativeWorkspaceListStore(context.services.uiContext)
      let membership = ''
      const removeStore = store?.subscribe(() => {
        const snapshot = readNativeWorkspaceSnapshot(context.services.uiContext)
        const next = JSON.stringify(snapshot?.items.map((item) => [item.workspaceId, item.sessionIds]))
        if (next === membership) return
        membership = next ?? ''
        refreshAdapters()
      })
      globalThis.addEventListener?.('popstate', refreshAdapters)
      globalThis.addEventListener?.('focus', refreshAdapters)
      disposeAdapterRefresh = () => {
        removeStore?.()
        globalThis.removeEventListener?.('popstate', refreshAdapters)
        globalThis.removeEventListener?.('focus', refreshAdapters)
      }
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
      const showSkillQuickReference = workspaceSettings?.showSkillQuickReference
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.showSkillQuickReference
      if (showSkillQuickReference) enableSkillQuickReference()
      else disableSkillQuickReference()
      const rememberConversationRightbarRatio = workspaceSettings?.rememberConversationRightbarRatio
        ?? DEFAULT_WORKSPACE_SESSION_ENHANCEMENT_SETTINGS.rememberConversationRightbarRatio
      if (rememberConversationRightbarRatio) enableRightbarMemory()
      else disableRightbarMemory()
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
