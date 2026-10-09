import { createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { AssistantChatCatalog, AssistantChatRun, AssistantConversationSnapshot, AssistantDebugSnapshot, AssistantLifecycleSnapshot } from '../../shared/contracts/assistant.js'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../../shared/contracts/config.js'
import { readAssistantProfile, readAssistantPersonality } from '../../shared/assistant-lifecycle.js'
import { BUILTIN_ASSISTANT_AVATAR, listAssistantAvatars, normalizeAssistantAppearance, resolveAssistantAvatarState, selectedAssistantAvatar } from '../../shared/assistant-avatar.js'
import { readAssistantTtsSettings, type AssistantTtsSnapshot } from '../../shared/assistant-tts.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { readNativeWorkspaceListStore, readNativeWorkspaceSnapshot, type NativeWorkspaceRecord } from '../native-workspace-store.js'
import { dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshSettingsHelpStyle, dshThemeColor } from '../theme.js'
import { AssistantAvatarSlot } from '../avatar/slot.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarCatalogEntry } from '../../shared/assistant-avatar-catalog.js'
import { AssistantConfigurationTabs, type AssistantConfigurationTab } from './assistant-configuration-tabs.js'
import { assistantSettingTextStyle } from '../assistant-settings-styles.js'
import type { CodingNsClientServices } from './types.js'
import { AssistantComposer, AssistantControlsStyle, AssistantIconButton, AssistantMaintenanceDialog, AssistantStatusBadge, confirmAssistantMaintenance, resolveAssistantWorkbenchStatus } from './assistant-workbench-controls.js'
import type { AssistantMaintenanceConfirmation } from './assistant-workbench-controls.js'
import { readAssistantComposerCommand, validateAssistantFiles, encodeAssistantFiles } from './assistant-composer-input.js'
import { AssistantConfigurationSession } from './assistant-configuration-session.js'
import { AssistantRealtimeCall, AssistantVoiceSessionCard } from './assistant-realtime-call.js'
import { AssistantConversationMessageView } from './assistant-conversation-message.js'
import { assistantConversationTimeline } from '../../shared/assistant-voice-sessions.js'
import { AssistantConfigurationFields, AssistantConfigurationPage } from './assistant-configuration-loader.js'
import { AssistantLoadedView, createAssistantViewLoader } from './assistant-view-loader.js'
import { assistantDisplayScope, getAssistantDisplayStore, type AssistantStatusSnapshot } from './assistant-display-store.js'
export { AssistantComposer } from './assistant-workbench-controls.js'

const debugLoader = createAssistantViewLoader(async () => (await import('./assistant-debug-workbench.js')).AssistantDebugDialog)

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
  readonly minimized?: boolean
  readonly callStartedAt?: number | undefined
  readonly active: boolean
  readonly pending: boolean
  readonly state?: string | undefined
  readonly message?: string | undefined
  readonly partialText: string
  readonly liveUserText?: string
  readonly liveAssistantText?: string
  readonly realtimeAvailable: boolean
  readonly unavailableMessage?: string | undefined
  readonly onStart: () => void | Promise<void>
  readonly onStop: () => void | Promise<void>
  readonly onClose: () => void
  readonly onMinimize?: (() => void) | undefined
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
  const scope = assistantDisplayScope(value.managedWorkspaceIds)
  const display = useMemo(() => getAssistantDisplayStore(services.rpc, scope), [services.rpc, scope])
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
  const [indexState, setIndexState] = useState<AssistantDebugSnapshot['indexState']>()
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
  const calling = !configuring && (props.active || props.pending)
  const running = lifecycle.conversation.active?.state === 'running'
  const locked = busy || lifecycle.conversation.compressing || props.pending
  const writable = settings.writable && settings.status === 'ready'

  const call = useCallback(async <T,>(endpoint: string, payload: unknown = {}, signal = abort.current?.signal): Promise<T> => {
    const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }, [services.rpc])
  const refresh = useCallback(async (): Promise<AssistantLifecycleSnapshot | undefined> => {
    const current = revision.current
    const next = await display.lifecycle.refresh({ afterPending: true })
    if (next && mounted.current && current === revision.current && !pendingOperation.current) { setLifecycle(next); setLoaded(true) }
    return next
  }, [display])
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
    if (props.minimized) return
    const changed = (): void => {
      const snapshot = display.lifecycle.getSnapshot()
      if (snapshot.error) setError(message(snapshot.error))
      else if (snapshot.value && !pendingOperation.current) { setLifecycle(snapshot.value); setLoaded(true) }
    }
    changed()
    return display.lifecycle.subscribe(changed)
  }, [display, props.minimized])
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
    let stopped = false
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
    const changed = (): void => {
      const snapshot = display.status.getSnapshot()
      const next = snapshot.value
      if (next && !snapshot.error) {
        setIndexState(next.indexState)
        setWorkspaces(mergeWorkspaces(readNativeWorkspaceSnapshot(services.uiContext)?.items ?? [], next))
      } else {
        // 查询失败只失效状态证明，保留普通交流及索引后台任务。
        setIndexState(undefined)
      }
    }
    changed()
    const disposeStatus = props.minimized ? undefined : display.status.subscribe(changed)
    return () => { stopped = true; disposeStatus?.(); dispose(); disposeNative?.() }
  }, [initializing, services.settings, services.uiContext, call, display, props.minimized])
  useEffect(() => { if (props.initialConfiguration) { setView('configuration'); void Promise.resolve(voiceProps.current.onStop()) } }, [props.initialConfiguration])
  useEffect(() => {
    if (props.minimized || debugDialog || confirmation !== undefined) return undefined
    const escape = (event: KeyboardEvent): void => handleAssistantWorkbenchEscape(event, close)
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [props.minimized, debugDialog, confirmation, close])
  const toolState = lifecycle.conversation.active?.toolCalls?.map((call) => `${call.id}:${call.state}`).join('|')
  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: 'nearest' }) }, [lifecycle.conversation.revision, lifecycle.conversation.active?.text, toolState, props.partialText])

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
  useEffect(() => { if (!props.minimized && !props.active && !props.pending) void display.lifecycle.refresh() }, [props.active, props.pending, props.minimized, display])

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
  const configurationPreview = createElement('div', { 'data-codingns-assistant-preview': true, style: { flex: '1 1 290px', minWidth: 0, border: `1px solid ${dshThemeColor.border}`, borderRadius: 18, background: dshThemeColor.surfaceSubtle, padding: 11, boxSizing: 'border-box', display: 'grid', alignContent: 'start', gap: 11 } },
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
  // 收起只隐藏呈现；保留工作台、设备状态与通话记录订阅，不触发挂断或卸载。
  return createElement('div', { 'data-codingns-workbench-minimized': props.minimized === true, hidden: props.minimized,
    style: { ...backdrop, ...(props.minimized ? { display: 'none' } : {}) } },
    configuring ? createElement(AssistantControlsStyle) : null,
    createElement('section', { role: 'dialog', 'aria-modal': !props.minimized, 'aria-label': t('awb.title'), 'data-codingns-assistant-workbench': configuring ? 'configuration' : 'chat',
      style: { ...dialog, ...(!configuring ? { height: 'min(740px, calc(100dvh - 24px))', minHeight: 0 } : {}) } },
      calling ? null : createElement('header', { style: { ...row, flexShrink: 0, padding: 11, borderBottom: `1px solid ${dshThemeColor.border}` } },
        createElement('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'grid', gap: 5 } },
          createElement('div', { 'data-codingns-assistant-heading': true, style: { ...row, gap: 8 } },
            createElement('strong', { style: { fontSize: 17, overflowWrap: 'anywhere' } }, initializing ? t('awb.setupTitle') : lifecycle.profile.name),
            initializing ? null : createElement(AssistantStatusBadge, { status, t })),
          initializing ? createElement('span', { style: help }, t('awb.setupSubtitle')) : null),
        !configuring && lifecycle.profile.initialized ? createElement(AssistantIconButton, { icon: 'clear', label: t('awb.clear'), onClick: requestClear, disabled: locked || !loaded }) : null,
        lifecycle.profile.initialized ? createElement(AssistantIconButton, { icon: configuring ? 'chat' : 'settings', label: t(configuring ? 'awb.chat' : 'awb.configure'), onClick: switchView, disabled: locked }) : null,
        createElement(AssistantIconButton, { icon: 'close', label: t('awb.close'), onClick: close, disabled: busy })),
      createElement('div', { 'data-codingns-assistant-scroll': true,
        // 通话页自带统一内边距，外层不重复叠加；其余页面共用 11px 留白。
        style: { flex: '1 1 auto', padding: calling ? 0 : 11, overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0, display: 'flex', flexDirection: 'column', gap: configuring ? 11 : 16 } },
        !loaded ? createElement('div', { role: 'status', style: dshSettingsHelpStyle }, t('awb.loading'), ' ', button(t('awb.retry'), () => { void refresh().catch((cause) => setError(message(cause))) })) : null,
        noticeText ? createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 13, overflowWrap: 'anywhere' } }, noticeText) : null,
        notice ? createElement('div', { role: 'status', style: dshSettingsHelpStyle }, notice) : null,
        calling ? createElement(AssistantRealtimeCall, { services, name: lifecycle.profile.name, model: selectedAssistantAvatar(appearance), t,
          minimized: props.minimized, startedAt: props.callStartedAt, onMinimize: props.onMinimize,
          session: lifecycle.conversation.voiceSessions?.find((session) => session.endedAt === null), pending: props.pending, state: props.state,
          userText: props.partialText || props.liveUserText || '', assistantText: props.liveAssistantText || '',
          toolCalls: lifecycle.conversation.pendingMessage?.source === 'voice' ? lifecycle.conversation.active?.toolCalls
            : lifecycle.conversation.voiceSessions?.find((session) => session.endedAt === null)?.messages.at(-1)?.toolCalls,
          onHangup: async () => { try { await props.onStop(); await refresh() } catch (cause) { setError(message(cause)) } } })
          : configuring ? createElement('div', { 'data-codingns-assistant-configuration': true, style: { ...assistantSettingTextStyle, display: 'grid', gap: 11, minWidth: 0 } },
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
      calling ? null : configuring ? createElement('footer', { 'data-codingns-assistant-configuration-footer': true,
        style: { ...row, flexShrink: 0, justifyContent: initializing ? 'space-between' : 'flex-end', padding: 11,
          borderTop: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.pageBackground } },
        initializing ? createElement('p', { style: { ...help, flex: '1 1 220px' } }, t('awb.setupLater')) : null,
        createElement('div', { style: row },
          initializing ? null : button(t('awb.cancel'), switchView),
          button(t(initializing ? 'awb.createStart' : 'awb.save'), save, locked || configurationSnapshot.preparing || !loaded || !writable || !draft.name.trim() || catalog === undefined || catalog.models.length === 0 || draft.modelKey === '' && catalog.default === null, true)))
        : createElement('footer', { 'data-codingns-assistant-composer-dock': true,
        style: { flexShrink: 0, padding: 11, borderTop: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.pageBackground } },
        createElement(AssistantComposer, { t, value: text, disabled: locked || running || !loaded, onChange: setText, onSend: () => { void send() },
          files, onFiles: addFiles, onRemoveFile: (index) => setFiles((current) => current.filter((_, position) => position !== index)),
          running, stopping: busy, onStop: stopReply, voiceActive: props.active,
          voiceDisabled: busy || lifecycle.conversation.compressing || running || !loaded || !props.active && (props.pending || !props.realtimeAvailable),
          onVoice: () => { cancelRequests(); if (props.active) void props.onStop(); else void props.onStart() } }))),
    confirmation === undefined ? null : createElement(AssistantMaintenanceDialog, { key: confirmation, stage: confirmation, t,
      disabled: locked || !loaded || confirmation !== 'clear' && !writable, error,
      onCancel: () => setConfirmation(undefined),
      onConfirm: () => { if (!locked && loaded && (confirmation === 'clear' || writable)) confirmAssistantMaintenance(confirmation, setConfirmation, maintain) } }),
    debugDialog ? createElement(AssistantLoadedView<Parameters<typeof import('./assistant-debug-workbench.js')['AssistantDebugDialog']>[0]>, {
      loader: debugLoader, t, overlay: true, onClose: () => setDebugDialog(false),
      viewProps: { services: configuring ? configuration.services : services, displayRpc: services.rpc, onClose: () => setDebugDialog(false) } }) : null)
}

/** 正式消息以 Host 快照为准，语音识别与流式回复在同一消息流里显示。 */
export function AssistantConversationView({ conversation, name, t, services, model }: {
  readonly conversation: AssistantConversationSnapshot; readonly name: string; readonly t: CodingNsTranslator
  readonly services?: CodingNsClientServices; readonly model?: AssistantAvatarModel
}): ReactElement {
  const messages = [...conversation.messages, ...(conversation.pendingMessage === null ? [] : [conversation.pendingMessage])]
  const timeline = assistantConversationTimeline(conversation)
  const active = conversation.active
  // 模型先调用工具时也展示本轮，不能等到出现第一段正文才显示搜索过程。
  const streaming = active !== null && active.state !== 'cancelled' && (active.text !== '' || Boolean(active.toolCalls?.length)) && !messages.some((message) => message.id === `${active.requestId}-assistant`)
  return createElement('div', { 'data-codingns-assistant-messages': true, style: { display: 'grid', gap: 12 } },
    conversation.summary ? createElement('details', null, createElement('summary', { style: help }, t('awb.summary')), createElement('p', { style: { ...help, whiteSpace: 'pre-wrap' } }, conversation.summary)) : null,
    timeline.length === 0 && !streaming ? createElement('p', { style: { ...help, textAlign: 'center', padding: '20px 0' } }, t('awb.empty')) : null,
    ...timeline.map((item) => {
      if (item.kind === 'voice') return createElement(AssistantVoiceSessionCard, { key: item.session.id, session: item.session, t, name, services, model })
      const message = item.message
      return createElement(AssistantConversationMessageView, { key: message.id, message, name, t, services, model })
    }),
    !streaming ? null : createElement(AssistantConversationMessageView, { key: `${active.requestId}-assistant`, streaming: true,
      message: { role: 'assistant', text: active.text, ...(active.toolCalls === undefined ? {} : { toolCalls: active.toolCalls }) }, name, t, services, model }))
}

/** 内层菜单先消费 Escape，外层窗口只处理尚未消费的关闭按键。 */
export function handleAssistantWorkbenchEscape(event: KeyboardEvent, onClose: () => void): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  event.stopImmediatePropagation(); onClose()
}

function mergeWorkspaces(native: readonly NativeWorkspaceRecord[], debug: Pick<AssistantStatusSnapshot, 'workspaces'>): readonly NativeWorkspaceRecord[] {
  return [...native, ...debug.workspaces.filter((workspace) => !native.some((item) => item.workspaceId === workspace.workspaceId)).map((workspace) => ({ workspaceId: workspace.workspaceId, title: workspace.name, sessionIds: [] }))]
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function requestKey(): string { return `assistant-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}` }
const row: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }
const help: CSSProperties = { ...dshSettingsHelpStyle, margin: 0 }
const avatarStyle: CSSProperties = { display: 'grid', gap: 8, justifyItems: 'center' }
// 工作台外层统一保留 24px 安全边距；内部滚动区、页脚和组件间距保持原值。
const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 10000, background: dshThemeColor.overlay, backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box' }
const dialog: CSSProperties = { display: 'flex', flexDirection: 'column', width: 'min(940px, 100%)', maxHeight: 'calc(100dvh - 48px)', minHeight: 300, background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary, border: `1px solid ${dshThemeColor.border}`, borderRadius: 20, boxShadow: '0 24px 80px rgba(0,0,0,.24)', overflow: 'hidden' }
