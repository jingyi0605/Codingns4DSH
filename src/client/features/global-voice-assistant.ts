import { callCodingNsRpcResult } from '../rpc-call.js'
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientFeatureModule } from './types.js'
import type { CodingNsClientServices } from './types.js'
import { DEFAULT_ASSISTANT_SETTINGS, DEFAULT_ASSISTANT_VOICE_SETTINGS } from '../../shared/contracts/config.js'
import { readAssistantProfile } from '../../shared/assistant-lifecycle.js'
import { useCodingNsTranslator } from '../locale.js'
import { AssistantPanel } from './assistant-panel.js'
import { ClientSherpaVoiceAdapter } from '../sherpa-voice-adapter.js'
import { inspectBrowserVoiceSecurity } from '../voice-security.js'
import { getGlobalVoiceAdapter, registerGlobalVoiceAdapter } from '../global-voice-runtime-registry.js'
import type { AssistantWorkbenchProps } from './assistant-workbench.js'
import { AssistantLoadedView, createAssistantViewLoader } from './assistant-view-loader.js'
import { ASSISTANT_WORKBENCH_OPEN_EVENT } from './assistant-workbench-entry.js'
import { normalizeAssistantAppearance, resolveAssistantAvatarState, selectedAssistantAvatar } from '../../shared/assistant-avatar.js'
import { FloatingAssistantAvatar, FloatingVoiceCall } from '../avatar/floating.js'
import { fillAssistantAvatarButton, useAssistantAvatarPortrait } from '../avatar/portrait.js'
import { useDesktopAssistant } from '../avatar/desktop-bridge.js'
import { AssistantNotificationBubble } from '../avatar/notification-bubble.js'
import { AssistantNotificationStore } from './assistant-notification-store.js'
import { assistantNotificationText, normalizeAssistantNotificationSettings } from '../../shared/assistant-notifications.js'
import type { AssistantNotification, AssistantNotificationSnapshot } from '../../shared/assistant-notifications.js'
import type { AssistantAvatarReaction } from '../../shared/assistant-avatar.js'
import { readDesktopAssistantNotificationSnapshot, type DesktopAssistantNotification } from '../../shared/desktop-assistant.js'
import { openAssistantNotificationSession } from '../../dsh-capabilities/client/assistant-session-navigation-adapter.js'

interface VoiceSnapshot {
  readonly active?: boolean
  readonly state?: string
  readonly ownerId?: string | null
  readonly message?: string
}

const GLOBAL_ASSISTANT_BUTTON_SIZE = 38
const workbenchLoader = createAssistantViewLoader(async () => (await import('./assistant-workbench.js')).AssistantWorkbench)
const notificationStores = new WeakMap<CodingNsClientServices, AssistantNotificationStore>()

/** 根级服务供网页和原生动作共用，通知变化不另建语音或形象实例。 */
function getNotificationStore(services: CodingNsClientServices): AssistantNotificationStore {
  let store = notificationStores.get(services)
  if (store === undefined) {
    store = new AssistantNotificationStore(services.rpc, (target, signal) => openAssistantNotificationSession(services, target, signal))
    notificationStores.set(services, store)
  }
  return store
}

/** Client 根级语音入口；使用 shell.overlay，绝不绑定当前 session。 */
export const globalVoiceAssistantFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'globalVoiceAssistant',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: 'Global smart assistant (Testing)',
      description: 'Choose the workspaces that the global assistant may read and control. After enabling this module, fully quit and restart DSH Desktop.',
      labelKey: 'feature.assistant.label',
      descriptionKey: 'feature.assistant.description',
      order: 30,
      defaultOpen: false,
    },
  },
  start(context) {
    const ui = context.services.uiContext
    if (ui === undefined) return
    const actionOwnerId = createVoiceLeaseOwnerId()
    const notifications = getNotificationStore(context.services)
    context.resources.add(() => { notifications.dispose(); notificationStores.delete(context.services) })
    const adapter = new ClientSherpaVoiceAdapter({ ownerId: actionOwnerId, services: context.services })
    void callCodingNsRpcResult(context.services.rpc, 'assistant/voice/register-client', {
      ownerId: actionOwnerId,
      capabilities: adapter.capabilities,
      secureContext: inspectBrowserVoiceSecurity().secure,
    }).catch(() => undefined)
    const disposeAdapter = registerGlobalVoiceAdapter(context.services, adapter)
    context.resources.add(() => {
      disposeAdapter()
      adapter.dispose()
      void callCodingNsRpcResult(context.services.rpc, 'assistant/voice/unregister-client', { ownerId: actionOwnerId }).catch(() => undefined)
    })
    const disposer = ui.slots.inject('shell.overlay', () => ui.slots.register({
      name: 'shell.overlay',
      id: 'codingns4dsh-global-voice-assistant',
      order: 40,
      inject: () => ({ services: context.services }),
    }, GlobalVoiceOverlay))
    context.resources.add(disposer)
  },
  settingsPanel: AssistantPanel,
}

function GlobalVoiceOverlay({ services }: { readonly services: CodingNsClientServices }): ReactElement {
  const notifications = getNotificationStore(services)
  const [notificationSnapshot, setNotificationSnapshot] = useState(notifications.getSnapshot)
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>({ state: 'disabled' })
  const [conversationOpen, setConversationOpen] = useState(false)
  const [callMinimized, setCallMinimized] = useState(false)
  const [callStartedAt, setCallStartedAt] = useState<number>()
  const [initialConfiguration, setInitialConfiguration] = useState(false)
  const [conversationPending, setConversationPending] = useState(false)
  const [partialText, setPartialText] = useState('')
  const [liveUserText, setLiveUserText] = useState('')
  const [liveAssistantText, setLiveAssistantText] = useState('')
  const [settingsValue, setSettingsValue] = useState(() => services.settings.getSnapshot().value)
  const ownerIdRef = useRef<string | undefined>(undefined)
  const eventSequenceRef = useRef(0)
  if (ownerIdRef.current === undefined) ownerIdRef.current = createVoiceLeaseOwnerId()
  const t = useCodingNsTranslator(services.locale)
  const nativeAdapter = getGlobalVoiceAdapter(services)
  const ownerId = nativeAdapter?.configuredOwnerId ?? ownerIdRef.current
  const browserVoiceSecurity = inspectBrowserVoiceSecurity()
  const voiceSettings = settingsValue?.assistant?.voice ?? DEFAULT_ASSISTANT_VOICE_SETTINGS
  const appearance = normalizeAssistantAppearance(settingsValue?.assistant?.appearance)
  // 悬浮入口属于已创建助理；初始化表单里的形象预览仍可使用。
  const minimized = callMinimized && (snapshot.active === true || conversationPending)
  const floatingEnabled = readAssistantProfile(settingsValue?.assistant ?? DEFAULT_ASSISTANT_SETTINGS).initialized && appearance.floatingEnabled
  // 页面形象避让工作台，原生形象只受用户开关控制，前台和打开对话时均常驻。
  const floatingVisible = floatingEnabled && (!conversationOpen || minimized)
  const notificationSettings = normalizeAssistantNotificationSettings(settingsValue?.assistant?.notifications)
  const notificationsEnabled = floatingEnabled && notificationSettings.enabled
  const notificationKey = JSON.stringify([notificationsEnabled, notificationSettings,
    settingsValue?.assistant?.profile, settingsValue?.assistant?.managedWorkspaceIds])
  const avatarModel = selectedAssistantAvatar(appearance)
  const portrait = useAssistantAvatarPortrait(services, avatarModel)
  const portraitRef = useRef(portrait)
  portraitRef.current = portrait
  const avatarState = resolveAssistantAvatarState(snapshot.state, conversationPending)
  const needsSetup = !isVoiceSettingsReady(voiceSettings)
  // 全局助理只使用 Sherpa-ONNX 流式模式；运行时不可用时明确显示错误。
  const adapter = nativeAdapter?.capabilities.realtime === true
    && browserVoiceSecurity.secure
    && !needsSetup
    && voiceSettings.provider === 'sherpa-onnx'
    ? nativeAdapter
    : undefined
  const realtimeUnavailableMessage = !browserVoiceSecurity.secure
    ? t('voice.secureContextRequired')
    : nativeAdapter?.capabilities.realtime !== true
      ? t('voice.dialog.unavailable')
      : voiceSettings.provider !== 'sherpa-onnx'
        ? t('voice.dialog.unavailable')
        : undefined

  useEffect(() => {
    const refresh = (): void => setSettingsValue(services.settings.getSnapshot().value)
    refresh()
    return services.settings.subscribe(refresh)
  }, [services.settings])

  useEffect(() => {
    const update = (): void => setNotificationSnapshot(notifications.getSnapshot())
    const release = notifications.subscribe(update)
    update()
    return () => {
      release()
      // Slot 卸载也撤销读取与在途动作；不能只依赖整个插件销毁时释放。
      notifications.configure(false, 'overlay-detached')
    }
  }, [notifications])
  useEffect(() => { notifications.configure(notificationsEnabled, notificationKey) }, [notifications, notificationsEnabled, notificationKey])
  const presentNotice = useCallback((noticeId: string, generation: number, kind?: AssistantNotification['kind']): void => {
    void notifications.acknowledge(noticeId, generation, 'presented', kind).catch(() => undefined)
  }, [notifications])
  const dismissNotice = useCallback((noticeId: string, generation: number, connectionGeneration?: number): void => {
    void notifications.acknowledge(noticeId, generation, 'dismiss', undefined, connectionGeneration).catch(() => undefined)
  }, [notifications])
  const openNotice = useCallback((noticeId: string, generation: number, connectionGeneration?: number): void => {
    void notifications.open(noticeId, generation, connectionGeneration).catch(() => undefined)
  }, [notifications])
  const pageNotices = useCallback((cursor?: string): void => { void notifications.page(cursor) }, [notifications])

  useEffect(() => {
    if (adapter !== undefined) {
      setSnapshot({ state: 'disabled', active: false })
      const unsubscribe = adapter.subscribe((event) => {
        if (event.type === 'state' || event.type === 'wake' || event.type === 'barge-in' || event.type === 'error') {
          void callCodingNsRpcResult(services.rpc, 'assistant/voice/event', { ownerId, event, sequence: ++eventSequenceRef.current }).catch(() => undefined)
        }
        if (event.type === 'partial') setPartialText(event.text)
        else if (event.type === 'final' && event.text.trim() !== '') {
          setPartialText(''); setLiveUserText(event.text); setLiveAssistantText('')
        }
        else if (event.type === 'reply') setLiveAssistantText(event.text)
        if (event.type === 'state') {
          // 致命错误后的 stop 会再发 disabled，恢复窗口仍需保留错误原因。
          setSnapshot((previous) => ({ state: event.state, active: event.state !== 'disabled', ownerId,
            ...(event.state === 'disabled' && previous.message !== undefined ? { message: previous.message } : {}) }))
          if (event.state === 'disabled') setCallMinimized(false)
        }
        else if (event.type === 'barge-in') setSnapshot({ state: 'interrupted', active: true, ownerId })
        else if (event.type === 'error') {
          const message = event.code === 'voice_empty_transcript'
            ? t('voice.emptyTranscript')
            : event.code === 'voice_invalid_transcript'
              ? t('voice.invalidTranscript')
              : event.message
          setSnapshot({ state: 'error', active: adapter.ownerId !== undefined, ownerId, message })
          if (!event.recoverable) {
            setCallMinimized(false)
            void adapter.stop().catch(() => undefined)
          }
        }
      })
      const onPageHide = (): void => {
        void adapter.stop().catch(() => undefined)
      }
      if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)
      return () => {
        unsubscribe()
        if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
        void adapter.stop().catch(() => undefined)
      }
    }
    setSnapshot({
      state: 'disabled',
      active: false,
      ownerId,
    })
    return undefined
  }, [adapter, ownerId, realtimeUnavailableMessage, services, t])

  useEffect(() => {
    if (adapter === undefined) return undefined
    let pending = false
    const lifetime = new AbortController()
    const timer = setInterval(() => {
      if (adapter.ownerId === undefined || pending) return
      pending = true
      // 通话租约在页面隐藏时仍需续签，但慢请求只能保留一条。
      void callCodingNsRpcResult(services.rpc, 'assistant/voice/heartbeat', { ownerId }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(8_000)]))
        .catch(() => undefined).finally(() => { pending = false })
    }, 10_000)
    return () => { clearInterval(timer); lifetime.abort() }
  }, [adapter, ownerId, services])

  const startConversation = async (): Promise<void> => {
    if (conversationPending || snapshot.active === true) return
    setCallMinimized(false)
    setCallStartedAt(Date.now())
    setConversationPending(true)
    setPartialText('')
    setLiveUserText(''); setLiveAssistantText('')
    setSnapshot((previous) => ({ ...previous, state: 'loading', active: false, ownerId }))
    try {
      if (adapter === undefined) throw new Error(realtimeUnavailableMessage ?? t('voice.dialog.unavailable'))
      await adapter.start(ownerId)
    } catch (error) {
      setCallMinimized(false)
      setSnapshot({ state: 'error', active: false, ownerId, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setConversationPending(false)
    }
  }

  const stopConversation = async (): Promise<void> => {
    setCallMinimized(false)
    if (!conversationPending && snapshot.active !== true) return
    setConversationPending(true)
    try {
      if (adapter !== undefined) await adapter.stop()
      setPartialText('')
    } catch (error) {
      setSnapshot({ state: 'error', active: false, ownerId, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setConversationPending(false)
    }
  }

  const closeConversation = (): void => {
    if (snapshot.active === true) {
      void stopConversation().finally(() => setConversationOpen(false))
      return
    }
    setConversationOpen(false)
  }

  const openConversation = useCallback((): void => {
    setCallMinimized(false)
    setInitialConfiguration(false)
    setConversationOpen(true)
  }, [])

  useEffect(() => {
    const open = (event: Event): void => {
      setCallMinimized(false)
      setInitialConfiguration((event as CustomEvent<{ configuration?: boolean }>).detail?.configuration === true)
      setConversationOpen(true)
    }
    window.addEventListener(ASSISTANT_WORKBENCH_OPEN_EVENT, open)
    return () => window.removeEventListener(ASSISTANT_WORKBENCH_OPEN_EVENT, open)
  }, [])

  useEffect(() => {
    const doc = typeof document === 'undefined' ? undefined : document
    if (doc === undefined) return undefined
    const assistantButtonSize = `${GLOBAL_ASSISTANT_BUTTON_SIZE}px`
    let mountedNative: HTMLButtonElement | undefined
    let mountedRow: HTMLElement | undefined
    let mountedParent: HTMLElement | undefined
    let mountedNextSibling: ChildNode | null | undefined
    let mountedNativeInlineStyle: {
      flex: string
      minWidth: string
      width: string
      maxWidth: string
      boxSizing: string
      whiteSpace: string
      margin: string
    } | undefined
    const mount = (): void => {
      const buttons = [...doc.querySelectorAll<HTMLButtonElement>('button')]
      const native = buttons.find((candidate) => {
        const classes = typeof candidate.className === 'string' ? candidate.className.split(/\s+/u) : []
        return classes.some((name) => name.endsWith('_newSession'))
      }) ?? buttons.find((candidate) => {
        const aria = candidate.getAttribute('aria-label') ?? ''
        return /新建会话|新建对话|new session|new conversation/iu.test(aria)
      })
      if (native === undefined || native.parentElement === null || native.parentElement.querySelector('[data-codingns-global-voice-button]') !== null) return
      const button = doc.createElement('button')
      button.type = 'button'
      button.setAttribute('data-codingns-global-voice-button', 'true')
      const label = t('awb.open')
      button.setAttribute('aria-label', label)
      button.setAttribute('aria-description', [t('voice.microphoneNotice'), t('voice.audioNotice'), snapshot.message].filter(Boolean).join(' '))
      button.setAttribute('aria-haspopup', 'dialog')
      button.setAttribute('aria-expanded', String(conversationOpen && !minimized))
      button.setAttribute('data-codingns-voice-state', snapshot.state ?? 'disabled')
      button.title = label
      button.style.cssText = `display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;cursor:pointer;background:var(--ds-color-fill-tertiary,rgba(127,127,127,.12));flex:0 1 ${assistantButtonSize};min-width:${assistantButtonSize};width:${assistantButtonSize};max-width:${assistantButtonSize};height:${assistantButtonSize};aspect-ratio:1 / 1;box-sizing:border-box;white-space:nowrap;margin:0`
      fillAssistantAvatarButton(button, portraitRef.current)
      button.addEventListener('click', openConversation)
      const parent = native.parentElement
      const row = doc.createElement('div')
      row.setAttribute('data-codingns-global-voice-row', 'true')
      row.style.cssText = 'display:flex;flex:0 1 auto;flex-flow:row nowrap;align-items:center;gap:4px;min-width:0;width:calc(100% - 4px);max-width:100%;box-sizing:border-box;overflow:hidden;margin:0 2px 12px'
      mountedNative = native
      mountedRow = row
      mountedParent = parent
      mountedNextSibling = native.nextSibling
      mountedNativeInlineStyle = {
        flex: native.style.flex,
        minWidth: native.style.minWidth,
        width: native.style.width,
        maxWidth: native.style.maxWidth,
        boxSizing: native.style.boxSizing,
        whiteSpace: native.style.whiteSpace,
        margin: native.style.margin,
      }
      parent.insertBefore(row, native)
      row.append(native, button)
      native.style.flex = '1 1 auto'
      native.style.minWidth = '0'
      native.style.width = 'auto'
      native.style.maxWidth = '100%'
      native.style.boxSizing = 'border-box'
      native.style.whiteSpace = 'nowrap'
      native.style.margin = '0'
      button.style.flex = `0 1 ${assistantButtonSize}`
      button.style.width = assistantButtonSize
      button.style.minWidth = assistantButtonSize
      button.style.maxWidth = assistantButtonSize
      button.style.height = assistantButtonSize
    }
    mount()
    const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(mount)
    observer?.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true })
    return () => {
      observer?.disconnect()
      if (mountedNative !== undefined && mountedNativeInlineStyle !== undefined) {
        mountedNative.style.flex = mountedNativeInlineStyle.flex
        mountedNative.style.minWidth = mountedNativeInlineStyle.minWidth
        mountedNative.style.width = mountedNativeInlineStyle.width
        mountedNative.style.maxWidth = mountedNativeInlineStyle.maxWidth
        mountedNative.style.boxSizing = mountedNativeInlineStyle.boxSizing
        mountedNative.style.whiteSpace = mountedNativeInlineStyle.whiteSpace
        mountedNative.style.margin = mountedNativeInlineStyle.margin
      }
      if (mountedNative !== undefined && mountedParent !== undefined && mountedParent.isConnected) {
        if (mountedNextSibling !== null && mountedNextSibling !== undefined && mountedNextSibling.parentNode === mountedParent) mountedParent.insertBefore(mountedNative, mountedNextSibling)
        else mountedParent.appendChild(mountedNative)
      }
      mountedRow?.remove()
      doc.querySelectorAll('[data-codingns-global-voice-button]').forEach((node) => node.remove())
    }
  }, [adapter, conversationOpen, minimized, needsSetup, openConversation, snapshot.state, t])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.querySelectorAll<HTMLButtonElement>('[data-codingns-global-voice-button]').forEach((button) => fillAssistantAvatarButton(button, portrait))
  }, [portrait.url, portrait.generated])

  const floatingCall = minimized ? {
    startedAt: callStartedAt ?? Date.now(), state: snapshot.state, pending: conversationPending,
    microphoneMuted: adapter?.isMicrophoneMuted ?? false, speakerMuted: adapter?.isSpeakerMuted ?? false,
    userText: partialText || liveUserText, assistantText: liveAssistantText,
  } : undefined
  // 语音六种动作保留原事实所有者，情绪只由当前通知提供，可随时撤销。
  const noticeFrame = notificationsEnabled ? notificationSnapshot.frame : undefined
  const reaction = assistantNotificationReaction(noticeFrame)
  const desktopNotification = desktopAssistantNotification(noticeFrame,
    notificationSnapshot.errorNoticeId === noticeFrame?.primary?.noticeId ? notificationSnapshot.error : undefined)
  const desktopNotificationSnapshot = readDesktopAssistantNotificationSnapshot(noticeFrame)
  const desktopAvatar = useDesktopAssistant(services.rpc, { visible: floatingEnabled, state: avatarState,
    label: t('avatar.openAssistant'), caption: floatingCall ? [floatingCall.userText, floatingCall.assistantText].filter(Boolean).join('\n').slice(-8000) : '',
    autoClose: notificationSettings.autoClose,
    autoCloseSeconds: notificationSettings.autoCloseSeconds,
    ...(reaction === undefined ? {} : { reaction }), ...(desktopNotification === undefined ? {} : { notification: desktopNotification }),
    ...(desktopNotificationSnapshot === undefined ? {} : { notificationSnapshot: desktopNotificationSnapshot }) }, openConversation, {
      onNoticePresented: (event) => notifications.acknowledge(event.noticeId, event.noticeGeneration, 'presented', event.noticeKind, event.connectionGeneration),
      onNoticeAction: async (event) => {
        // 原生由 Host 直接同步，可能先于网页收到新帧；刷新后仍按点击帧的连接身份导航。
        await notifications.refresh(true)
        return event.action === 'open' ? notifications.open(event.noticeId, event.noticeGeneration,
          event.connectionGeneration)
          : notifications.acknowledge(event.noticeId, event.noticeGeneration, 'dismiss', undefined, event.connectionGeneration)
      },
    })
  const nativeFloating = floatingEnabled && desktopAvatar.native
  const notification = noticeFrame === undefined ? (notificationsEnabled && notificationSnapshot.error ? createElement('div', {
    role: 'alert', style: { padding: 12, background: 'var(--dsw-alias-background-secondary)', borderRadius: 12, overflowWrap: 'anywhere' },
  }, notificationSnapshot.error) : undefined) : createElement(AssistantNotificationBubble, {
    frame: noticeFrame, t, error: notificationSnapshot.error, autoClose: notificationSettings.autoClose, autoCloseSeconds: notificationSettings.autoCloseSeconds,
    onPresented: presentNotice, onDismiss: dismissNotice, onOpen: openNotice, onPage: pageNotices,
  })
  return createElement('div', { 'data-codingns-global-voice': 'true', ...(conversationOpen || floatingVisible ? {} : { 'aria-hidden': 'true' }) },
    floatingVisible && !nativeFloating
      ? createElement(FloatingAssistantAvatar, { services, model: avatarModel, state: avatarState, size: appearance.floatingSize, call: floatingCall, onOpen: openConversation,
        ...(reaction === undefined ? {} : { reaction }), notification })
      : floatingCall && !nativeFloating ? createElement(FloatingVoiceCall, { services, call: floatingCall, onOpen: openConversation }) : null,
    floatingEnabled && desktopAvatar.error ? createElement('div', { role: 'status', title: desktopAvatar.error, 'data-codingns-desktop-avatar-fallback': true,
      style: { position: 'fixed', right: 12, bottom: 8, zIndex: 9000, maxWidth: 'min(480px, calc(100vw - 24px))', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #777)', pointerEvents: 'auto' } },
      createElement('details', null, createElement('summary', { style: { cursor: 'pointer' } }, t('avatar.desktopFallback')),
        createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 120, overflowY: 'auto' } }, desktopAvatar.error))) : null,
    conversationOpen ? createElement(AssistantLoadedView<AssistantWorkbenchProps>, { loader: workbenchLoader, t, overlay: true, onClose: closeConversation, viewProps: {
      services,
      initialConfiguration,
      minimized,
      callStartedAt,
      active: snapshot.active === true,
      pending: conversationPending,
      state: snapshot.state,
      message: snapshot.message,
      partialText,
      liveUserText,
      liveAssistantText,
      realtimeAvailable: adapter !== undefined,
      unavailableMessage: realtimeUnavailableMessage,
      onStart: startConversation,
      onStop: stopConversation,
      onMinimize: () => setCallMinimized(true),
      onClose: closeConversation,
    } }) : null,
  )
}

export { GlobalVoiceOverlay }

/** 原生只接收安全展示字段与不透明 ID，完整 Host/会话目标始终留在认证接口内。 */
export function desktopAssistantNotification(frame: AssistantNotificationSnapshot | undefined, error?: string): DesktopAssistantNotification | undefined {
  const notice = frame?.primary
  if (notice === undefined || notice === null || frame === undefined) return undefined
  return { noticeId: notice.noticeId, generation: frame.generation, kind: notice.kind, hostLabel: notice.hostLabel,
    workspaceLabel: notice.workspaceLabel, sessionTitle: notice.sessionTitle,
    text: error === undefined ? notice.text : assistantNotificationText([notice.text, error].join(' ')), availability: notice.availability }
}

export function assistantNotificationReaction(frame: AssistantNotificationSnapshot | undefined): AssistantAvatarReaction | undefined {
  const kind = frame?.primary?.kind
  return kind === undefined ? undefined : ({ completed: 'success', error: 'concerned', question: 'question', approval: 'approval' } as const)[kind]
}

function createVoiceLeaseOwnerId(): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === 'function') return `codingns4dsh:global-voice:${randomUUID.call(globalThis.crypto)}`
  } catch {
    // 某些旧浏览器暴露 crypto 但禁用 randomUUID，继续使用随机后缀。
  }
  return `codingns4dsh:global-voice:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function isVoiceSettingsReady(settings: typeof DEFAULT_ASSISTANT_VOICE_SETTINGS): boolean {
  if (!settings.initialized || settings.provider !== 'sherpa-onnx') return false
  return settings.asrEncoder.trim() !== ''
    && settings.asrDecoder.trim() !== ''
    && settings.asrJoiner.trim() !== ''
    && settings.asrTokens.trim() !== ''
}
