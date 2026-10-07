import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { AssistantChatCatalog, AssistantChatRun, AssistantConversationSnapshot, AssistantDebugSnapshot, AssistantLifecycleSnapshot } from '../../shared/contracts/assistant.js'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../../shared/contracts/config.js'
import { ASSISTANT_PERSONALITY_MAX_CHARS, readAssistantProfile, readAssistantPersonality } from '../../shared/assistant-lifecycle.js'
import { BUILTIN_ASSISTANT_AVATAR, listAssistantAvatars, normalizeAssistantAppearance, resolveAssistantAvatarState, selectedAssistantAvatar } from '../../shared/assistant-avatar.js'
import { readAssistantTtsSettings, type AssistantTtsSnapshot } from '../../shared/assistant-tts.js'
import { readAssistantPrompts } from '../../shared/assistant-prompts.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { readNativeWorkspaceListStore, readNativeWorkspaceSnapshot, type NativeWorkspaceRecord } from '../native-workspace-store.js'
import { dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshSettingsFieldStyle, dshSettingsHelpStyle, dshThemeColor } from '../theme.js'
import { AssistantAvatarSlot } from '../avatar/slot.js'
import { AssistantAvatarPortrait } from '../avatar/portrait.js'
import { AssistantAvatarPortraitEditor } from '../avatar/portrait-editor.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { AssistantAppearanceEditor } from '../avatar/settings-panel.js'
import { AssistantAvatarPicker, assistantAvatarChoices } from '../avatar/catalog-picker.js'
import type { AssistantAvatarPreviewTargetProps } from '../avatar/catalog-panel.js'
import type { AssistantAvatarCatalogEntry } from '../../shared/assistant-avatar-catalog.js'
import { AssistantVoiceSettings } from './assistant-voice-settings.js'
import { AssistantVoiceInitializationPanel } from './assistant-voice-initialization.js'
import { VoiceModelManagerPanel } from './voice-initialization-dialog.js'
import { AssistantDebugDialog, AssistantPromptEditor } from './assistant-debug-dialog.js'
import { getGlobalVoiceAdapter } from '../global-voice-runtime-registry.js'
import { AssistantConfigurationTabs, type AssistantConfigurationTab } from './assistant-configuration-tabs.js'
import { assistantSettingCheckboxStyle, assistantSettingFieldStyle, assistantSettingTextStyle } from '../assistant-settings-styles.js'
import type { CodingNsClientServices } from './types.js'
import { AssistantComposer, AssistantControlsStyle, AssistantIconButton, AssistantMaintenanceDialog, AssistantStatusBadge, confirmAssistantMaintenance, resolveAssistantWorkbenchStatus } from './assistant-workbench-controls.js'
import type { AssistantMaintenanceConfirmation } from './assistant-workbench-controls.js'
import { readAssistantComposerCommand, validateAssistantFiles, encodeAssistantFiles } from './assistant-composer-input.js'
import { AssistantConfigurationSession } from './assistant-configuration-session.js'
export { AssistantComposer } from './assistant-workbench-controls.js'

export interface AssistantDraft {
  readonly name: string
  readonly modelKey: string
  readonly personality: string
  readonly managedWorkspaceIds: readonly string[]
  readonly avatarId: string
  readonly voiceId: string
  readonly ttsBackend: 'browser' | 'moss-onnx'
}
export interface AssistantWorkbenchProps {
  readonly services: CodingNsClientServices
  readonly initialConfiguration?: boolean
  readonly active: boolean
  readonly pending: boolean
  readonly state?: string | undefined
  readonly message?: string | undefined
  readonly partialText: string
  readonly realtimeAvailable: boolean
  readonly unavailableMessage?: string | undefined
  readonly onStart: () => void | Promise<void>
  readonly onStop: () => void | Promise<void>
  readonly onClose: () => void
}
const emptyConversation = (): AssistantConversationSnapshot => ({ revision: 0, summary: '', messages: [], pendingMessage: null, active: null, compressing: false, error: null })
export function readAssistantDraft(settings: AssistantSettings, mossReady?: boolean): AssistantDraft {
  const tts = readAssistantTtsSettings(settings.tts)
  const profile = readAssistantProfile(settings)
  const appearance = normalizeAssistantAppearance(settings.appearance)
  // 旧预设 ID 只用于已创建助理的兼容，不能在创建时隐式注册或下载外部角色。
  const avatarId = listAssistantAvatars(appearance, profile.initialized).some((model) => model.id === appearance.selectedId)
    ? appearance.selectedId : BUILTIN_ASSISTANT_AVATAR.id
  return { name: profile.name, personality: readAssistantPersonality(profile), modelKey: settings.model === undefined ? '' : JSON.stringify([settings.model.provider, settings.model.model]),
    managedWorkspaceIds: [...settings.managedWorkspaceIds], avatarId, voiceId: tts.selectedId,
    ttsBackend: !profile.initialized || mossReady === false ? 'browser' : tts.backend }
}
export function assistantDraftPayload(draft: AssistantDraft, initializing = false, includeVoice = true): Record<string, unknown> {
  const model = draft.modelKey === '' ? null : JSON.parse(draft.modelKey) as [string, string]
  return { name: draft.name, model: model === null ? null : { provider: model[0], model: model[1] }, personality: draft.personality, avatarId: draft.avatarId,
    ...(initializing ? {} : { managedWorkspaceIds: draft.managedWorkspaceIds,
      ...(includeVoice ? { voiceId: draft.voiceId, ttsBackend: draft.ttsBackend } : {}) }) }
}

/** 一位助理、一份连续对话；配置草稿、资源管理和正式聊天各自有明确的写入边界。 */
export function AssistantWorkbench(props: AssistantWorkbenchProps): ReactElement {
  const { services } = props
  const t = useCodingNsTranslator(services.locale)
  const [settings, setSettings] = useState(() => services.settings.getSnapshot())
  const value = settings.value?.assistant ?? DEFAULT_ASSISTANT_SETTINGS
  const [lifecycle, setLifecycle] = useState<AssistantLifecycleSnapshot>(() => ({ profile: readAssistantProfile(value), conversation: emptyConversation() }))
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<'chat' | 'configuration'>(() => props.initialConfiguration || !lifecycle.profile.initialized ? 'configuration' : 'chat')
  const [configuration] = useState(() => new AssistantConfigurationSession(services))
  const configurationSnapshot = useSyncExternalStore(configuration.subscribe, configuration.getSnapshot, configuration.getSnapshot)
  const configurationValue = configurationSnapshot.value?.assistant ?? DEFAULT_ASSISTANT_SETTINGS
  const draft = { ...readAssistantDraft(configurationValue),
    name: configurationValue.profile?.name ?? readAssistantProfile(configurationValue).name,
    personality: configurationValue.profile?.personality ?? readAssistantPersonality(readAssistantProfile(configurationValue)) }
  const [catalog, setCatalog] = useState<AssistantChatCatalog>()
  const [tts, setTts] = useState<AssistantTtsSnapshot>()
  const [workspaces, setWorkspaces] = useState<readonly NativeWorkspaceRecord[]>([])
  const [indexState, setIndexState] = useState<AssistantDebugSnapshot['indexState']>('not-built')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<readonly File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<AssistantMaintenanceConfirmation>()
  const [configurationTab, setConfigurationTab] = useState<AssistantConfigurationTab>('basic')
  const [visitedTabs, setVisitedTabs] = useState<readonly AssistantConfigurationTab[]>(['basic'])
  const [debugDialog, setDebugDialog] = useState(false)
  const [catalogPreview, setCatalogPreview] = useState<AssistantAvatarCatalogEntry | undefined>()
  const [previewTarget, setPreviewTarget] = useState<HTMLDivElement | null>(null)
  const mounted = useRef(false)
  const abort = useRef<AbortController>()
  const revision = useRef(0)
  const ownedRequests = useRef(new Set<string>())
  const pendingOperation = useRef(false)
  const voiceProps = useRef(props); voiceProps.current = props
  const messagesEnd = useRef<HTMLDivElement>(null)
  const configuring = view === 'configuration' || !lifecycle.profile.initialized
  const initializing = !lifecycle.profile.initialized
  const running = lifecycle.conversation.active?.state === 'running'
  const locked = busy || lifecycle.conversation.compressing || props.pending
  const writable = settings.writable && settings.status === 'ready'

  const call = useCallback(async <T,>(endpoint: string, payload: unknown = {}, signal = abort.current?.signal): Promise<T> => {
    const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }, [services.rpc])
  const refresh = useCallback(async (): Promise<AssistantLifecycleSnapshot> => {
    const current = revision.current
    const next = await call<AssistantLifecycleSnapshot>('assistant/lifecycle/read')
    if (mounted.current && current === revision.current && !pendingOperation.current) { setLifecycle(next); setLoaded(true) }
    return next
  }, [call])
  const cancelRequests = useCallback((): void => {
    for (const requestId of ownedRequests.current) void services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/conversation/cancel', { requestId }).catch(() => undefined)
    ownedRequests.current.clear()
  }, [services.rpc])
  const close = useCallback((): void => { cancelRequests(); void Promise.resolve(voiceProps.current.onStop()).finally(() => voiceProps.current.onClose()) }, [cancelRequests])

  useEffect(() => {
    mounted.current = true; abort.current = new AbortController()
    return () => { mounted.current = false; abort.current?.abort(); cancelRequests() }
  }, [cancelRequests])
  useEffect(() => {
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      let delay = 1500
      try { const next = await refresh(); if (next.conversation.active?.state === 'running' || voiceProps.current.active) delay = 600 }
      catch (cause) { if (!stopped && mounted.current) setError(message(cause)) }
      if (!stopped) timer = setTimeout(() => { void poll() }, delay)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [refresh])
  useEffect(() => {
    const changed = (): void => {
      const next = services.settings.getSnapshot(); setSettings(next)
      configuration.sync()
    }
    changed()
    const dispose = services.settings.subscribe(changed)
    void call<AssistantChatCatalog>('assistant/chat/models').then((next) => { if (mounted.current) setCatalog(next) }).catch((cause) => { if (mounted.current) setError(message(cause)) })
    return dispose
  }, [services.settings, call, configuration])
  useEffect(() => () => configuration.dispose(), [configuration])
  useEffect(() => {
    // 创建前不读取项目目录或 MOSS 可用性；四项身份设置即可开始交流。
    if (initializing) return undefined
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined
    const refreshResources = (): void => {
      void call<AssistantTtsSnapshot>('assistant/tts/catalog').then((next) => {
        if (stopped || !mounted.current) return
        setTts(next)
      }).catch(() => { /* 浏览器 TTS 不依赖 MOSS 目录，资源查询失败仍可创建和交流。 */ })
    }
    const nativeChanged = (): void => setWorkspaces(readNativeWorkspaceSnapshot(services.uiContext)?.items ?? [])
    refreshResources(); nativeChanged()
    const dispose = services.settings.subscribe(refreshResources)
    const disposeNative = readNativeWorkspaceListStore(services.uiContext)?.subscribe(nativeChanged)
    const pollIndex = async (): Promise<void> => {
      try {
        const next = await call<AssistantDebugSnapshot>('assistant/debug')
        if (stopped || !mounted.current) return
        setIndexState(next.indexState)
        setWorkspaces(mergeWorkspaces(readNativeWorkspaceSnapshot(services.uiContext)?.items ?? [], next))
      } catch { /* 状态提示不可用时不阻止普通交流。 */ }
      if (!stopped) timer = setTimeout(() => { void pollIndex() }, 3000)
    }
    void pollIndex()
    return () => { stopped = true; clearTimeout(timer); dispose(); disposeNative?.() }
  }, [initializing, services.settings, services.uiContext, call])
  useEffect(() => { if (props.initialConfiguration) { setView('configuration'); void Promise.resolve(voiceProps.current.onStop()) } }, [props.initialConfiguration])
  useEffect(() => {
    if (debugDialog || confirmation !== undefined) return undefined
    const escape = (event: KeyboardEvent): void => handleAssistantWorkbenchEscape(event, close)
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [debugDialog, confirmation, close])
  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: 'nearest' }) }, [lifecycle.conversation.revision, lifecycle.conversation.active?.text, props.partialText])

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pendingOperation.current) return
    pendingOperation.current = true; revision.current++; setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { pendingOperation.current = false; revision.current++; if (mounted.current) { setBusy(false); void refresh().catch(() => undefined) } }
  }
  const reloadSettings = async (): Promise<void> => { await (services.settings.reload?.() ?? services.settings.load?.()); if (mounted.current) setSettings(services.settings.getSnapshot()) }
  const changeDraft = (patch: Partial<AssistantDraft>): void => {
    const current = configuration.getSnapshot().value?.assistant ?? DEFAULT_ASSISTANT_SETTINGS
    const operations: import('../../dsh-capabilities/settings-store.js').CodingNsSettingsOperation[] = []
    if (patch.name !== undefined || patch.personality !== undefined) operations.push({ op: 'set', path: ['assistant', 'profile'], value: { ...readAssistantProfile(current),
      ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.personality === undefined ? {} : { personality: patch.personality }) } })
    if (patch.modelKey !== undefined) operations.push(patch.modelKey === '' ? { op: 'unset', path: ['assistant', 'model'] }
      : { op: 'set', path: ['assistant', 'model'], value: { provider: JSON.parse(patch.modelKey)[0], model: JSON.parse(patch.modelKey)[1] } })
    if (patch.managedWorkspaceIds !== undefined) operations.push({ op: 'set', path: ['assistant', 'managedWorkspaceIds'], value: [...patch.managedWorkspaceIds] })
    if (patch.avatarId !== undefined) operations.push({ op: 'set', path: ['assistant', 'appearance', 'selectedId'], value: patch.avatarId })
    if (patch.voiceId !== undefined || patch.ttsBackend !== undefined) operations.push({ op: 'set', path: ['assistant', 'tts'], value: { ...readAssistantTtsSettings(current.tts),
      ...(patch.voiceId === undefined ? {} : { selectedId: patch.voiceId }), ...(patch.ttsBackend === undefined ? {} : { backend: patch.ttsBackend }) } })
    void configuration.mutate(operations).catch((cause) => setError(message(cause)))
  }
  const resetConfigurationTabs = (): void => { setConfigurationTab('basic'); setVisitedTabs(['basic']) }
  const chooseConfigurationTab = (tab: AssistantConfigurationTab): void => {
    if (tab === configurationTab) return
    setConfirmation(undefined)
    setVisitedTabs((current) => current.includes(tab) ? current : [...current, tab]); setConfigurationTab(tab)
  }
  const addFiles = (added: readonly File[]): void => {
    try { const next = [...files, ...added]; validateAssistantFiles(next); setFiles(next); setError('') }
    catch (cause) { setError(t(message(cause))) }
  }
  // 标题按钮和斜杠指令共用确认入口，只有模态框确认后才执行清理。
  const requestClear = (): void => { setError(''); setConfirmation('clear') }
  const send = async (): Promise<void> => {
    const input = text.trim()
    if ((!input && files.length === 0) || locked || !loaded || running) return
    if (readAssistantComposerCommand(input) === 'clear') {
      if (files.length > 0) { setError(t('awb.command.attachmentsError')); return }
      requestClear(); return
    }
    await run(async () => {
      await voiceProps.current.onStop()
      const attachments = await encodeAssistantFiles(files)
      if (!mounted.current) return
      const requestId = requestKey(); ownedRequests.current.add(requestId)
      await call<AssistantChatRun>('assistant/conversation/start', { requestId, text: input || t('awb.attachments.prompt'),
        ...(attachments.length === 0 ? {} : { attachments }) })
      if (!mounted.current || !ownedRequests.current.has(requestId)) { void services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/conversation/cancel', { requestId }); return }
      setText(''); setFiles([]); await refresh()
    })
  }
  useEffect(() => {
    const active = lifecycle.conversation.active
    if (active !== null && active.state !== 'running') ownedRequests.current.delete(active.requestId)
  }, [lifecycle.conversation.active?.requestId, lifecycle.conversation.active?.state])

  const save = (): void => { void run(async () => {
    cancelRequests(); await voiceProps.current.onStop()
    // 所有标签页共用草稿，正式配置仅在此处一次提交；模型始终显式传给 Host。
    const savingDraft = readAssistantDraft(configuration.getSnapshot().value!.assistant)
    const next = await call<AssistantLifecycleSnapshot>('assistant/lifecycle/configure', {
      ...assistantDraftPayload(savingDraft, initializing), configurationPatch: configuration.configurationPatch(),
    })
    await configuration.commitLocal(abort.current!.signal)
    if (!mounted.current) return
    setLifecycle(next); await reloadSettings(); configuration.reset(); setView('chat'); resetConfigurationTabs()
  }) }
  const maintain = (action: 'clear' | 'reset'): void => { void run(async () => {
    cancelRequests(); await voiceProps.current.onStop()
    const next = await call<AssistantLifecycleSnapshot>(action === 'reset' ? 'assistant/lifecycle/reset' : `assistant/conversation/${action}`)
    if (!mounted.current) return
    setLifecycle(next); setConfirmation(undefined)
    setText(''); setFiles([])
    if (action === 'reset') { resetConfigurationTabs(); setView('configuration'); configuration.reset() }
    else setNotice(t('awb.cleared'))
    await reloadSettings()
    if (action === 'reset') configuration.reset()
  }) }
  const stopReply = (): void => { void run(async () => {
    await voiceProps.current.onStop()
    const requestId = lifecycle.conversation.active?.requestId
    if (requestId !== undefined) await call('assistant/conversation/cancel', { requestId })
    cancelRequests(); await refresh()
  }) }
  const switchView = (): void => {
    cancelRequests(); void Promise.resolve(voiceProps.current.onStop())
    configuration.reset(); setConfirmation(undefined)
    setView(configuring ? 'chat' : 'configuration'); resetConfigurationTabs()
  }
  const appearance = normalizeAssistantAppearance(value.appearance)
  const previewAppearance = { ...normalizeAssistantAppearance(configurationValue.appearance), selectedId: draft.avatarId }
  const avatarState = resolveAssistantAvatarState(running ? 'thinking' : props.state, props.pending)
  const button = (label: string, onClick: () => void, disabled = locked, primary = false): ReactElement => createElement('button', { type: 'button', disabled, onClick, style: primary ? dshSettingsPrimaryButtonStyle : dshSettingsButtonStyle }, label)
  const noticeText = error || lifecycle.conversation.error || (lifecycle.conversation.active?.state === 'failed' ? lifecycle.conversation.active.error : null) || props.message
  const status = resolveAssistantWorkbenchStatus({ running, working: locked, voiceActive: props.active, voiceState: props.state,
    hasProjects: value.managedWorkspaceIds.length > 0, indexState })
  const configurationPreview = createElement('div', { 'data-codingns-assistant-preview': true, style: { flex: '1 1 290px', minWidth: 0, border: `1px solid ${dshThemeColor.border}`, borderRadius: 18, background: dshThemeColor.surfaceSubtle, padding: '11px 22px', boxSizing: 'border-box', display: 'grid', alignContent: 'start', gap: 11 } },
    createElement('div', { ref: setPreviewTarget, 'data-codingns-avatar-preview-region': true },
    catalogPreview === undefined ? createElement('div', { style: avatarStyle }, createElement(AssistantAvatarSlot, { services: configuration.services, model: selectedAssistantAvatar(previewAppearance), state: avatarState, surface: 'dialog', size: 144, showDiagnostics: false }),
      createElement('strong', { style: { fontSize: 18, overflowWrap: 'anywhere', textAlign: 'center' } }, draft.name.trim() || t('awb.unnamed')),
      createElement('p', { style: { ...help, textAlign: 'center', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, draft.personality.trim() || t('awb.personalityPreview'))) : null))
  const page = (tab: AssistantConfigurationTab): ReactElement => createElement(AssistantConfigurationPage, {
    tab, active: tab === configurationTab, services: configuration.services, value: configurationValue, draft, catalog, appearance: previewAppearance, tts, workspaces, t, disabled: locked || !writable || !loaded,
    onChange: changeDraft, onDebug: () => setDebugDialog(true), onError: setError,
    onReset: () => { setError(''); setConfirmation('reset-first') },
    previewTarget, onPreviewChange: setCatalogPreview,
  })
  return createElement('div', { style: backdrop },
    configuring ? createElement(AssistantControlsStyle) : null,
    createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': t('awb.title'), 'data-codingns-assistant-workbench': configuring ? 'configuration' : 'chat',
      style: { ...dialog, ...(!configuring ? { height: 'min(740px, calc(100dvh - 24px))', minHeight: 0 } : {}) } },
      createElement('header', { style: { ...row, flexShrink: 0, padding: configuring ? 22 : '20px 26px', borderBottom: `1px solid ${dshThemeColor.border}` } },
        createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'grid', gap: 5 } },
          createElement('div', { 'data-codingns-assistant-heading': true, style: { ...row, gap: 8 } },
            createElement('strong', { style: { fontSize: 17, overflowWrap: 'anywhere' } }, initializing ? t('awb.setupTitle') : lifecycle.profile.name),
            initializing ? null : createElement(AssistantStatusBadge, { status, t })),
          initializing ? createElement('span', { style: help }, t('awb.setupSubtitle')) : null),
        !configuring && lifecycle.profile.initialized ? createElement(AssistantIconButton, { icon: 'clear', label: t('awb.clear'), onClick: requestClear, disabled: locked || !loaded }) : null,
        lifecycle.profile.initialized ? createElement(AssistantIconButton, { icon: configuring ? 'chat' : 'settings', label: t(configuring ? 'awb.chat' : 'awb.configure'), onClick: switchView, disabled: locked }) : null,
        createElement(AssistantIconButton, { icon: 'close', label: t('awb.close'), onClick: close, disabled: busy })),
      createElement('div', { 'data-codingns-assistant-scroll': true,
        style: { flex: '1 1 auto', padding: configuring ? '11px 22px' : 'clamp(16px, 3vw, 28px)', overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0, display: 'flex', flexDirection: 'column', gap: configuring ? 11 : 16 } },
        !loaded ? createElement('div', { role: 'status', style: dshSettingsHelpStyle }, t('awb.loading'), ' ', button(t('awb.retry'), () => { void refresh().catch((cause) => setError(message(cause))) })) : null,
        noticeText ? createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 13, overflowWrap: 'anywhere' } }, noticeText) : null,
        notice ? createElement('div', { role: 'status', style: dshSettingsHelpStyle }, notice) : null,
        configuring ? createElement('div', { 'data-codingns-assistant-configuration': true, style: { ...assistantSettingTextStyle, display: 'grid', gap: 11, minWidth: 0 } },
          initializing ? createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 22 } },
            createElement('div', { style: { flex: '1 1 330px', minWidth: 0 } },
              createElement(AssistantConfigurationFields, { draft, catalog, appearance: previewAppearance, initializing, services: configuration.services, t, disabled: locked || !writable || !loaded, onChange: changeDraft })),
            configurationPreview)
            : createElement(AssistantConfigurationTabs, { active: configurationTab, visited: visitedTabs, t, onChange: chooseConfigurationTab,
              panels: { basic: page('basic'), appearance: page('appearance'), voice: page('voice'), more: page('more') }, preview: configurationPreview }))
          : createElement('div', { 'data-codingns-assistant-chat': true, style: { display: 'grid', gap: 16 } },
            !appearance.dialogEnabled ? null : createElement('div', { style: avatarStyle }, createElement(AssistantAvatarSlot, { services, model: selectedAssistantAvatar(appearance), state: avatarState, surface: 'dialog', size: 120 })),
            createElement(AssistantConversationView, { conversation: lifecycle.conversation, name: lifecycle.profile.name, t, services, model: selectedAssistantAvatar(appearance) }),
            props.partialText ? createElement('div', { role: 'status', style: help }, props.partialText) : null,
            createElement('div', { ref: messagesEnd }))),
      // 配置操作位于滚动区之外，统一外边距并让长表单的保存按钮始终可见。
      configuring ? createElement('footer', { 'data-codingns-assistant-configuration-footer': true,
        style: { ...row, flexShrink: 0, justifyContent: initializing ? 'space-between' : 'flex-end', padding: 22,
          borderTop: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.pageBackground } },
        initializing ? createElement('p', { style: { ...help, flex: '1 1 220px' } }, t('awb.setupLater')) : null,
        createElement('div', { style: row },
          initializing ? null : button(t('awb.cancel'), switchView),
          button(t(initializing ? 'awb.createStart' : 'awb.save'), save, locked || configurationSnapshot.preparing || !loaded || !writable || !draft.name.trim() || catalog === undefined || catalog.models.length === 0 || draft.modelKey === '' && catalog.default === null, true)))
        : createElement('footer', { 'data-codingns-assistant-composer-dock': true,
        style: { flexShrink: 0, padding: '12px clamp(16px, 3vw, 28px) 10px', borderTop: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.pageBackground } },
        createElement(AssistantComposer, { t, value: text, disabled: locked || running || !loaded, onChange: setText, onSend: () => { void send() },
          files, onFiles: addFiles, onRemoveFile: (index) => setFiles((current) => current.filter((_, position) => position !== index)),
          running, stopping: busy, onStop: stopReply, voiceActive: props.active,
          voiceDisabled: busy || lifecycle.conversation.compressing || running || !loaded || !props.active && (props.pending || !props.realtimeAvailable),
          onVoice: () => { cancelRequests(); if (props.active) void props.onStop(); else void props.onStart() } }))),
    confirmation === undefined ? null : createElement(AssistantMaintenanceDialog, { key: confirmation, stage: confirmation, t,
      disabled: locked || !loaded || confirmation !== 'clear' && !writable, error,
      onCancel: () => setConfirmation(undefined),
      onConfirm: () => { if (!locked && loaded && (confirmation === 'clear' || writable)) confirmAssistantMaintenance(confirmation, setConfirmation, maintain) } }),
    debugDialog ? createElement(AssistantDebugDialog, { services: configuring ? configuration.services : services, onClose: () => setDebugDialog(false) }) : null)
}

/** 正式消息以 Host 快照为准，语音识别与流式回复在同一消息流里显示。 */
export function AssistantConversationView({ conversation, name, t, services, model }: {
  readonly conversation: AssistantConversationSnapshot; readonly name: string; readonly t: CodingNsTranslator
  readonly services?: CodingNsClientServices; readonly model?: AssistantAvatarModel
}): ReactElement {
  const messages = [...conversation.messages, ...(conversation.pendingMessage === null ? [] : [conversation.pendingMessage])]
  const active = conversation.active
  const streaming = active !== null && active.state !== 'cancelled' && active.text !== '' && !messages.some((message) => message.id === `${active.requestId}-assistant`)
  const heading = (role: 'user' | 'assistant'): ReactElement => createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 } },
    role !== 'assistant' || services === undefined || model === undefined ? null : createElement(AssistantAvatarPortrait, { services, model }),
    createElement('small', { style: { color: dshThemeColor.labelSecondary } }, role === 'user' ? t('voice.dialog.user') : name))
  return createElement('div', { 'data-codingns-assistant-messages': true, style: { display: 'grid', gap: 12 } },
    conversation.summary ? createElement('details', null, createElement('summary', { style: help }, t('awb.summary')), createElement('p', { style: { ...help, whiteSpace: 'pre-wrap' } }, conversation.summary)) : null,
    messages.length === 0 && !streaming ? createElement('p', { style: { ...help, textAlign: 'center', padding: '20px 0' } }, t('awb.empty')) : null,
    ...messages.map((message) => createElement('article', { key: message.id, 'data-codingns-assistant-message': message.role, style: messageStyle(message.role) },
      heading(message.role), message.text,
      message.attachments?.length ? createElement('div', { 'data-codingns-assistant-message-attachments': true, style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
        ...message.attachments.map((item) => createElement('span', { key: item.attachment.attachmentId, title: item.attachment.name,
          style: { fontSize: 12, padding: '3px 8px', borderRadius: 8, border: `1px solid ${dshThemeColor.border}` } }, item.attachment.name || t('awb.attachments.unnamed')))) : null)),
    !streaming ? null : createElement('article', { role: 'status', 'data-codingns-assistant-message': 'assistant', style: messageStyle('assistant') }, heading('assistant'), active.text))
}

export function AssistantConfigurationFields({ draft, catalog, appearance, initializing = false, includeAvatar = true, services, t, disabled, onChange }: {
  readonly draft: AssistantDraft; readonly catalog: AssistantChatCatalog | undefined
  readonly appearance: ReturnType<typeof normalizeAssistantAppearance>; readonly t: CodingNsTranslator
  readonly initializing?: boolean
  readonly includeAvatar?: boolean
  readonly services?: CodingNsClientServices
  readonly disabled: boolean; readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  const models = catalog?.models ?? []; const avatars = listAssistantAvatars(appearance, !initializing)
  const avatar = avatars.find((model) => model.id === draft.avatarId)
  const avatarChoices = assistantAvatarChoices(appearance, [], t, !initializing)
  const input = (label: string, node: ReactElement): ReactElement => createElement('label', { style: field }, createElement('span', null, label), node)
  const select = (label: string, value: string, change: (value: string) => void, options: ReactElement[]): ReactElement => input(label, createElement('select', { value, disabled, style: identityFieldStyle, onChange: (event: { currentTarget: { value: string } }) => change(event.currentTarget.value) }, ...options))
  const missing = (id: string): ReactElement => createElement('option', { key: id, value: id }, t('awb.unavailableSelection', { id }))
  return createElement('div', { 'data-codingns-assistant-identity': true, style: { display: 'grid', gap: 11 } },
    // 名称与头像始终左右排列，裁剪面板和本地保存说明跨两列展开。
    createElement('div', { 'data-codingns-assistant-identity-row': true, style: { display: 'grid', alignItems: 'start',
      gridTemplateColumns: services === undefined || avatar === undefined ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 176px)', columnGap: 16, rowGap: 8, minWidth: 0 } },
      input(t('awb.name'), createElement('input', { value: draft.name, maxLength: 80, disabled, placeholder: t('awb.namePlaceholder'), style: identityFieldStyle, onChange: (event: { currentTarget: { value: string } }) => onChange({ name: event.currentTarget.value }) })),
      services === undefined || avatar === undefined ? null : createElement(AssistantAvatarPortraitEditor, { services, model: avatar, disabled, t })),
    select(t('awb.model'), draft.modelKey, (modelKey) => onChange({ modelKey }), [createElement('option', { key: '', value: '' }, t('awb.defaultModel')),
      ...(draft.modelKey && !models.some((model) => JSON.stringify([model.provider, model.model]) === draft.modelKey) ? [missing(draft.modelKey)] : []),
      ...models.map((model) => createElement('option', { key: JSON.stringify([model.provider, model.model]), value: JSON.stringify([model.provider, model.model]) }, `${model.label} · ${model.provider}`))]),
    catalog?.models.length === 0 ? createElement('p', { style: help }, t('awb.noModel'), ...catalog.errors.map((error) => createElement('span', { key: error, style: { display: 'block' } }, error))) : null,
    input(t('awb.personality'), createElement('textarea', { value: draft.personality, maxLength: ASSISTANT_PERSONALITY_MAX_CHARS, rows: 4, disabled, placeholder: t('awb.personalityPlaceholder'),
      style: { ...identityFieldStyle, minHeight: 96, maxHeight: 200, resize: 'vertical', lineHeight: 1.65 }, onChange: (event: { currentTarget: { value: string } }) => onChange({ personality: event.currentTarget.value }) })),
    !includeAvatar ? null : createElement('div', { style: { display: 'grid', gap: 8 } },
      createElement(AssistantAvatarPicker, { label: t('awb.avatar'), value: draft.avatarId, disabled, t,
        choices: avatarChoices.some((choice) => choice.id === draft.avatarId) ? avatarChoices
          : [{ id: draft.avatarId, label: t('awb.unavailableSelection', { id: draft.avatarId }), thirdParty: false, disabled: true }, ...avatarChoices],
        onChoose: (choice) => { if (avatars.some((avatar) => avatar.id === choice.id)) onChange({ avatarId: choice.id }) } }),
      createElement('p', { style: help }, t('avatar.externalHint')),
      avatar?.renderer !== 'live2d' ? null : createElement('p', { style: help }, t('avatar.live2dDependencyHint'))))
}

/** 内层菜单先消费 Escape，外层窗口只处理尚未消费的关闭按键。 */
export function handleAssistantWorkbenchEscape(event: KeyboardEvent, onClose: () => void): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.stopImmediatePropagation(); onClose()
}

/** 创建后的各页只装配自己的字段；页面切换不持有或重置父级草稿。 */
export function AssistantConfigurationPage({ tab, active = true, services, value, draft, catalog, appearance, tts, workspaces, t, disabled, onChange, onDebug, onError, onReset, ...previewProps }: {
  readonly tab: AssistantConfigurationTab; readonly services: CodingNsClientServices; readonly value: AssistantSettings
  readonly active?: boolean
  readonly draft: AssistantDraft; readonly catalog: AssistantChatCatalog | undefined
  readonly appearance: ReturnType<typeof normalizeAssistantAppearance>; readonly tts: AssistantTtsSnapshot | undefined
  readonly workspaces: readonly NativeWorkspaceRecord[]; readonly t: CodingNsTranslator; readonly disabled: boolean
  readonly onChange: (patch: Partial<AssistantDraft>) => void
  readonly onDebug: () => void; readonly onError: (error: string) => void
  readonly onReset?: () => void
} & Omit<AssistantAvatarPreviewTargetProps, 'active'>): ReactElement {
  switch (tab) {
    case 'basic': return createElement(AssistantConfigurationFields, { draft, catalog, appearance, includeAvatar: false, services, t, disabled, onChange })
    case 'appearance': return createElement('div', { style: { display: 'grid', gap: 11 } },
      createElement(AssistantAppearanceEditor, { services, enabled: !disabled, active, ...previewProps }))
    case 'voice': return createElement('div', { style: { display: 'grid', gap: 11 } },
      createElement(AssistantVoiceInitializationPanel, { services, enabled: !disabled, active,
        inputSettings: (groupActive) => createElement('div', { style: { display: 'grid', gap: 11 } },
          createElement(AssistantAudioDevice, { services, direction: 'input', active: groupActive, disabled, t, onError }),
          createElement(VoiceModelManagerPanel, { services, value: value.voice, enabled: !disabled, active: groupActive })),
        outputSettings: (groupActive) => createElement('div', { style: { display: 'grid', gap: 11 } },
          createElement(AssistantAudioDevice, { services, direction: 'output', active: groupActive, disabled, t, onError }),
          createElement(AssistantVoiceSettings, { services, enabled: !disabled, active: groupActive, embedded: true })) }))
    case 'more': return createElement('div', { style: { display: 'grid', gap: 11 } },
      createElement(AssistantWorkspaceFields, { draft, workspaces, t, disabled, onChange }),
      createElement(AssistantAdvancedSettings, { services, value, disabled, t, onDebug, onError }),
      createElement('div', { style: { paddingTop: 16, borderTop: `1px solid ${dshThemeColor.border}` } },
        createElement('button', { type: 'button', 'data-codingns-assistant-reset': true, disabled: disabled || onReset === undefined,
          style: { ...dshSettingsButtonStyle, color: dshThemeColor.error }, onClick: onReset }, t('awb.reset'))))
  }
}

/** 兼容原能力表单入口；实际配置页分别装配项目字段与声音字段。 */
export function AssistantCapabilityFields({ draft, tts, workspaces, t, disabled, onChange }: {
  readonly draft: AssistantDraft; readonly tts: AssistantTtsSnapshot | undefined; readonly workspaces: readonly NativeWorkspaceRecord[]; readonly t: CodingNsTranslator
  readonly disabled: boolean; readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  return createElement('div', { style: { display: 'grid', gap: 18 } },
    AssistantWorkspaceFields({ draft, workspaces, t, disabled, onChange }), AssistantVoiceFields({ draft, tts, t, disabled, onChange }))
}

/** 项目范围放到更多设置，保留暂不可用项目以避免编辑时丢失原有选择。 */
export function AssistantWorkspaceFields({ draft, workspaces, t, disabled, onChange }: {
  readonly draft: AssistantDraft; readonly workspaces: readonly NativeWorkspaceRecord[]; readonly t: CodingNsTranslator
  readonly disabled: boolean; readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  const knownWorkspaces = new Set(workspaces.map((workspace) => workspace.workspaceId))
  return createElement('fieldset', { 'data-codingns-assistant-projects': true, style: { border: 0, padding: 0, margin: 0, minWidth: 0 }, disabled },
    createElement('legend', { style: { fontSize: 14, fontWeight: 600, padding: 0, marginBottom: 8 } }, t('awb.workspaces')),
    createElement('p', { style: help }, t('awb.scopeHint')),
    createElement('div', { style: { display: 'grid', gap: 8, maxHeight: 180, overflowY: 'auto', marginTop: 8 } },
      ...[...workspaces, ...draft.managedWorkspaceIds.filter((id) => !knownWorkspaces.has(id)).map((workspaceId) => ({ workspaceId, title: t('awb.offlineWorkspace', { id: workspaceId }) }))].map((workspace) => createElement('label', { key: workspace.workspaceId, style: assistantSettingCheckboxStyle },
        createElement('input', { type: 'checkbox', checked: draft.managedWorkspaceIds.includes(workspace.workspaceId), onChange: (event: { currentTarget: { checked: boolean } }) => onChange({ managedWorkspaceIds: event.currentTarget.checked ? [...draft.managedWorkspaceIds, workspace.workspaceId] : draft.managedWorkspaceIds.filter((id) => id !== workspace.workspaceId) }) }), workspace.title))))
}

/** 没有安装 MOSS 时只有浏览器声音可选，不因标签拆分而放宽可用性校验。 */
export function AssistantVoiceFields({ draft, tts, t, disabled, onChange }: {
  readonly draft: AssistantDraft; readonly tts: AssistantTtsSnapshot | undefined; readonly t: CodingNsTranslator
  readonly disabled: boolean; readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  const mossReady = tts?.status.ready === true
  const voices = mossReady ? tts.voices : []
  return createElement('div', { 'data-codingns-assistant-voice-selection': true, style: { display: 'grid', gap: 10 } },
    createElement('label', { style: field }, createElement('span', null, t('awb.voice')),
      createElement('select', { value: draft.ttsBackend === 'browser' || !mossReady ? 'browser' : draft.voiceId, disabled, style: identityFieldStyle,
        onChange: (event: { currentTarget: { value: string } }) => { const voice = event.currentTarget.value; if (voice === 'browser') onChange({ ttsBackend: 'browser' }); else if (mossReady && voices.some((item) => item.id === voice)) onChange({ ttsBackend: 'moss-onnx', voiceId: voice }) } },
        createElement('option', { value: 'browser' }, t('awb.browserVoice')), ...voices.map((voice) => createElement('option', { key: voice.id, value: voice.id }, voice.name)))),
    mossReady ? null : createElement('p', { style: help }, t('awb.mossSetupHint')))
}
function AssistantAdvancedSettings({ services, value, disabled, t, onDebug, onError }: { readonly services: CodingNsClientServices; readonly value: AssistantSettings; readonly disabled: boolean; readonly t: CodingNsTranslator; readonly onDebug: () => void; readonly onError: (error: string) => void }): ReactElement {
  const defaults = readAssistantPrompts(value.prompts)
  const prompts = services.configurationDraft ? { ...defaults, ...value.prompts } : defaults
  const savePrompt = async (kind: 'index' | 'chat', text: string): Promise<void> => {
    // 提示词是单字段绝对值，不依赖旧快照计算；后台索引变化不应阻止保存。
    try { if (!await services.settings.mutate([{ op: 'set', path: ['assistant', 'prompts', kind], value: text }])) throw new Error(t('settings.moduleWriteRejected')) }
    catch (cause) { onError(message(cause)); throw cause }
  }
  return createElement('div', { style: { display: 'grid', gap: 14, marginTop: 14 } },
    createElement('p', { style: help }, t('awb.moreHint')),
    ...(['index', 'chat'] as const).map((kind) => createElement(AssistantPromptEditor, { key: kind, kind, value: prompts[kind], disabled, onSave: savePrompt,
      ...(services.configurationDraft ? { onChange: savePrompt } : {}), t })),
    createElement('button', { type: 'button', disabled, style: dshSettingsButtonStyle, onClick: onDebug }, t('assistant.debug.open')))
}

/** 设备按输入、输出分组枚举，折叠时保留选择但停止设备查询。 */
function AssistantAudioDevice({ services, direction, active, disabled, t, onError }: {
  readonly services: CodingNsClientServices; readonly direction: 'input' | 'output'; readonly active: boolean
  readonly disabled: boolean; readonly t: CodingNsTranslator; readonly onError: (error: string) => void
}): ReactElement | null {
  const adapter = getGlobalVoiceAdapter(services)
  const output = direction === 'output'
  const [devices, setDevices] = useState<readonly { deviceId: string; label: string }[]>([])
  const [selectedId, setSelectedId] = useState((output ? adapter?.outputDeviceId : adapter?.inputDeviceId) ?? '')
  useEffect(() => {
    if (!active || (output && !adapter?.outputDeviceSupported)) return undefined
    let stopped = false
    const refresh = (): void => { void (output ? adapter?.enumerateOutputDevices() : adapter?.enumerateInputDevices())?.then((devices) => { if (!stopped) setDevices(devices) }).catch(() => undefined) }
    refresh(); globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => { stopped = true; globalThis.navigator?.mediaDevices?.removeEventListener?.('devicechange', refresh) }
  }, [active, adapter, output])
  if (output && !adapter?.outputDeviceSupported) return null
  return createElement('label', { style: field }, t(output ? 'voice.outputDevice' : 'voice.inputDevice'),
    createElement('select', { disabled, value: selectedId, style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => {
      const id = event.currentTarget.value
      void (output ? adapter?.selectOutputDevice(id) : adapter?.selectInputDevice(id))?.then(() => setSelectedId(id)).catch((cause) => onError(message(cause)))
    } }, createElement('option', { value: '' }, t(output ? 'voice.defaultOutput' : 'voice.defaultMicrophone')), ...devices.map((device) => createElement('option', { key: device.deviceId, value: device.deviceId }, device.label || t(output ? 'voice.unnamedOutput' : 'voice.unnamedMicrophone')))))
}

function mergeWorkspaces(native: readonly NativeWorkspaceRecord[], debug: AssistantDebugSnapshot): readonly NativeWorkspaceRecord[] {
  return [...native, ...debug.workspaces.filter((workspace) => !native.some((item) => item.workspaceId === workspace.workspaceId)).map((workspace) => ({ workspaceId: workspace.workspaceId, title: workspace.name, sessionIds: [] }))]
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function requestKey(): string { return `assistant-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}` }
const row: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }
const help: CSSProperties = { ...dshSettingsHelpStyle, margin: 0 }
const field: CSSProperties = assistantSettingFieldStyle
const identityFieldStyle: CSSProperties = { ...dshSettingsFieldStyle, borderRadius: 8 }
const avatarStyle: CSSProperties = { display: 'grid', gap: 8, justifyItems: 'center' }
const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 10000, background: dshThemeColor.overlay, backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, boxSizing: 'border-box' }
const dialog: CSSProperties = { display: 'flex', flexDirection: 'column', width: 'min(940px, 100%)', maxHeight: 'calc(100dvh - 24px)', minHeight: 300, background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary, border: `1px solid ${dshThemeColor.border}`, borderRadius: 20, boxShadow: '0 24px 80px rgba(0,0,0,.24)', overflow: 'hidden' }
const messageStyle = (role: 'user' | 'assistant'): CSSProperties => ({ padding: '11px 14px', borderRadius: 10, background: role === 'user' ? dshThemeColor.surfaceSubtle : 'transparent', justifySelf: role === 'user' ? 'end' : 'stretch', maxWidth: '100%', boxSizing: 'border-box', fontSize: 14, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })
