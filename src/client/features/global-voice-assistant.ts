import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientFeatureModule } from './types.js'
import type { CodingNsClientServices } from './types.js'
import { DEFAULT_ASSISTANT_VOICE_SETTINGS } from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { useCodingNsTranslator } from '../locale.js'
import { AssistantPanel } from './assistant-panel.js'
import { ClientSherpaVoiceAdapter } from '../sherpa-voice-adapter.js'
import { inspectBrowserVoiceSecurity } from '../voice-security.js'
import { getGlobalVoiceAdapter, registerGlobalVoiceAdapter } from '../global-voice-runtime-registry.js'
import { VoiceInitializationDialog } from './voice-initialization-dialog.js'
import { VoiceConversationDialog } from './voice-conversation-dialog.js'

interface VoiceSnapshot {
  readonly active?: boolean
  readonly state?: string
  readonly ownerId?: string | null
  readonly message?: string
}

const GLOBAL_ASSISTANT_BUTTON_SIZE = 38

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
      description: 'Choose the workspaces that the global assistant may read and control.',
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
    const adapter = new ClientSherpaVoiceAdapter({ ownerId: actionOwnerId, services: context.services })
    void context.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/register-client', {
      ownerId: actionOwnerId,
      capabilities: adapter.capabilities,
      secureContext: inspectBrowserVoiceSecurity().secure,
    }).catch(() => undefined)
    const disposeAdapter = registerGlobalVoiceAdapter(context.services, adapter)
    context.resources.add(() => {
      disposeAdapter()
      adapter.dispose()
      void context.services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/unregister-client', { ownerId: actionOwnerId }).catch(() => undefined)
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
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>({ state: 'disabled' })
  const [setupOpen, setSetupOpen] = useState(false)
  const [conversationOpen, setConversationOpen] = useState(false)
  const [conversationPending, setConversationPending] = useState(false)
  const [partialText, setPartialText] = useState('')
  const [transcript, setTranscript] = useState<readonly string[]>([])
  const [settingsValue, setSettingsValue] = useState(() => services.settings.getSnapshot().value)
  const ownerIdRef = useRef<string | undefined>(undefined)
  const eventSequenceRef = useRef(0)
  if (ownerIdRef.current === undefined) ownerIdRef.current = createVoiceLeaseOwnerId()
  const t = useCodingNsTranslator(services.locale)
  const nativeAdapter = getGlobalVoiceAdapter(services)
  const ownerId = nativeAdapter?.configuredOwnerId ?? ownerIdRef.current
  const browserVoiceSecurity = inspectBrowserVoiceSecurity()
  const voiceSettings = settingsValue?.assistant?.voice ?? DEFAULT_ASSISTANT_VOICE_SETTINGS
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
    if (adapter !== undefined) {
      setSnapshot({ state: 'disabled', active: false })
      const unsubscribe = adapter.subscribe((event) => {
        if (event.type === 'state' || event.type === 'wake' || event.type === 'barge-in' || event.type === 'error') {
          void services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/event', { ownerId, event, sequence: ++eventSequenceRef.current }).catch(() => undefined)
        }
        if (event.type === 'partial') setPartialText(event.text)
        else if (event.type === 'final' && event.text.trim() !== '') {
          setTranscript((previous) => [...previous, event.text.trim()])
          setPartialText('')
        }
        if (event.type === 'state') setSnapshot({ state: event.state, active: event.state !== 'disabled', ownerId })
        else if (event.type === 'barge-in') setSnapshot({ state: 'interrupted', active: true, ownerId })
        else if (event.type === 'error') {
          const message = event.code === 'voice_empty_transcript'
            ? t('voice.emptyTranscript')
            : event.code === 'voice_invalid_transcript'
              ? t('voice.invalidTranscript')
              : event.message
          setSnapshot({ state: 'error', active: true, ownerId, message })
          if (!event.recoverable) {
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
      state: 'error',
      active: false,
      ownerId,
      ...(realtimeUnavailableMessage === undefined ? {} : { message: realtimeUnavailableMessage }),
    })
    return undefined
  }, [adapter, ownerId, realtimeUnavailableMessage, services, t])

  useEffect(() => {
    if (adapter === undefined) return undefined
    const timer = setInterval(() => {
      if (adapter.ownerId === undefined) return
      void services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/heartbeat', { ownerId }).catch(() => undefined)
    }, 10_000)
    return () => clearInterval(timer)
  }, [adapter, ownerId, services])

  const startConversation = async (): Promise<void> => {
    if (conversationPending || snapshot.active === true) return
    setConversationPending(true)
    setPartialText('')
    setSnapshot((previous) => ({ ...previous, state: 'loading', active: false, ownerId }))
    try {
      if (adapter === undefined) throw new Error(realtimeUnavailableMessage ?? t('voice.dialog.unavailable'))
      await adapter.start(ownerId)
    } catch (error) {
      setSnapshot({ state: 'error', active: false, ownerId, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setConversationPending(false)
    }
  }

  const stopConversation = async (): Promise<void> => {
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

  const openConversation = (): void => {
    if (needsSetup) {
      setSetupOpen(true)
      return
    }
    setConversationOpen(true)
  }

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
      const label = needsSetup ? t('voice.setup.open') : t('voice.globalAssistant')
      button.setAttribute('aria-label', label)
      button.setAttribute('aria-description', [t('voice.microphoneNotice'), t('voice.audioNotice'), snapshot.message].filter(Boolean).join(' '))
      button.setAttribute('aria-haspopup', 'dialog')
      button.setAttribute('aria-expanded', String(conversationOpen || setupOpen))
      button.setAttribute('data-codingns-voice-state', snapshot.state ?? 'disabled')
      button.title = label
      button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 1.45 5.55L19 9l-5.55 1.45L12 16l-1.45-5.55L5 9l5.55-1.45L12 2Z"/><path d="m5 15 .7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7L5 15Z"/><path d="m19 14 .45 1.55L21 16l-1.55.45L19 18l-.45-1.55L17 16l1.55-.45L19 14Z"/></svg>'
      button.style.cssText = `display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;cursor:pointer;background:var(--ds-color-fill-tertiary,rgba(127,127,127,.12));flex:0 1 ${assistantButtonSize};min-width:${assistantButtonSize};width:${assistantButtonSize};max-width:${assistantButtonSize};height:${assistantButtonSize};aspect-ratio:1 / 1;box-sizing:border-box;white-space:nowrap;margin:0`
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
  }, [adapter, conversationOpen, needsSetup, openConversation, setSetupOpen, setupOpen, snapshot.state, t])

  return createElement('span', { 'data-codingns-global-voice': 'true', ...(setupOpen || conversationOpen ? {} : { 'aria-hidden': 'true' }) },
    setupOpen ? createElement(VoiceInitializationDialog, {
      services,
      value: voiceSettings,
      onClose: () => setSetupOpen(false),
    }) : conversationOpen ? createElement(VoiceConversationDialog, {
      t,
      active: snapshot.active === true,
      pending: conversationPending,
      state: snapshot.state,
      message: snapshot.message,
      partialText,
      transcript,
      realtimeAvailable: adapter !== undefined,
      unavailableMessage: realtimeUnavailableMessage,
      onStart: () => { void startConversation() },
      onStop: () => { void stopConversation() },
      onClose: closeConversation,
      onClear: () => { setTranscript([]); setPartialText('') },
    }) : null,
  )
}

export { GlobalVoiceOverlay }

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
