import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { AssistantChatCatalog, AssistantChatMessage, AssistantChatModel, AssistantChatRun, AssistantDebugSnapshot, AssistantIndexEvidence, AssistantIndexFact, AssistantSessionAnalysis, AssistantSessionIndexTask, SessionIndexEntry } from '../../shared/contracts/assistant.js'
import { ASSISTANT_PROMPT_MAX_CHARS, DEFAULT_ASSISTANT_PROMPTS, readAssistantPrompts } from '../../shared/assistant-prompts.js'
import { CODINGNS_ASSISTANT_FIELD } from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { readNativeWorkspaceListStore, readNativeWorkspaceSnapshot, type NativeWorkspaceRecord } from '../native-workspace-store.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { dshFieldStyle, dshSettingsButtonStyle, dshSettingsHelpStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import type { CodingNsClientServices } from './types.js'
import { assistantSettingTextStyle } from '../assistant-settings-styles.js'

const TABS = ['scope', 'sessions', 'result', 'records', 'chat'] as const
type DebugTab = typeof TABS[number]

/** 五个步骤各自处理范围、成员、结果、运行记录和 LLM 问答，不依赖语音。 */
export function AssistantDebugDialog({ services, onClose }: { readonly services: CodingNsClientServices; readonly onClose: () => void }): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [tab, setTab] = useState<DebugTab>('scope')
  const [snapshot, setSnapshot] = useState<AssistantDebugSnapshot>()
  const [settings, setSettings] = useState(() => services.settings.getSnapshot())
  const [nativeWorkspaces, setNativeWorkspaces] = useState<readonly NativeWorkspaceRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [catalog, setCatalog] = useState<AssistantChatCatalog>()
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelKey, setModelKey] = useState('')
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [history, setHistory] = useState<readonly AssistantChatMessage[]>([])
  const [run, setRun] = useState<AssistantChatRun>()
  const [starting, setStarting] = useState(false)
  const mounted = useRef(true)
  const request = useRef<AbortController>()
  const activeChatId = useRef<string>()
  const chatting = starting || run?.state === 'running'
  const summarizing = snapshot?.index.analysis?.state === 'running'
  const busy = loading || saving || indexing || chatting || summarizing
  const managedIds = settings.value?.assistant.managedWorkspaceIds ?? []
  const scopeKey = JSON.stringify([...managedIds].sort())
  const workspaces = mergeDebugWorkspaces(snapshot, nativeWorkspaces, managedIds)
  const prompts = readAssistantPrompts(settings.value?.assistant.prompts)

  const call = useCallback(async <T,>(action: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> => {
    const response = await services.rpc.call(CODINGNS_RPC_CHANNEL, action, payload, signal)
    if (!response.ok) throw new Error(response.error.message)
    return response.value as T
  }, [services])
  const refresh = useCallback(async (rebuild = false, model?: AssistantChatModel): Promise<void> => {
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    setLoading(true); setIndexing(rebuild); setError(undefined)
    try {
      if (rebuild) await call('assistant/index/rebuild', model ?? {}, abort.signal)
      const next = await call<AssistantDebugSnapshot>('assistant/debug', {}, abort.signal)
      if (!abort.signal.aborted && mounted.current) setSnapshot(next)
    } catch (cause) { if (!abort.signal.aborted && mounted.current) setError(errorMessage(cause)) }
    finally { if (!abort.signal.aborted && mounted.current) { setLoading(false); setIndexing(false) } }
  }, [call])
  const loadModels = useCallback(async (): Promise<void> => {
    setModelsLoading(true)
    try {
      const next = await call<AssistantChatCatalog>('assistant/chat/models')
      if (!mounted.current) return
      setCatalog(next)
      setModelKey((current) => next.models.some((model) => selectionKey(model) === current) ? current : next.default === null ? '' : selectionKey(next.default))
    } catch (cause) { if (mounted.current) setCatalog({ models: [], default: null, errors: [errorMessage(cause)] }) }
    finally { if (mounted.current) setModelsLoading(false) }
  }, [call])
  useEffect(() => {
    mounted.current = true
    void refresh(); void loadModels()
    return () => {
      mounted.current = false; request.current?.abort()
      if (activeChatId.current !== undefined) void call('assistant/chat/cancel', { requestId: activeChatId.current }).catch(() => undefined)
    }
  }, [refresh, loadModels, call])
  useEffect(() => {
    const model = catalog?.models.find((item) => selectionKey(item) === modelKey)
    if (model === undefined) return
    void call('assistant/index/configure', { provider: model.provider, model: model.model }).catch((cause) => { if (mounted.current) setError(errorMessage(cause)) })
  }, [modelKey, catalog, call])
  useEffect(() => {
    const refreshSettings = (): void => setSettings(services.settings.getSnapshot())
    const refreshWorkspaces = (): void => setNativeWorkspaces(readNativeWorkspaceSnapshot(services.uiContext)?.items ?? [])
    refreshSettings(); refreshWorkspaces()
    const disposeSettings = services.settings.subscribe(refreshSettings)
    const disposeWorkspaces = readNativeWorkspaceListStore(services.uiContext)?.subscribe(refreshWorkspaces)
    return () => { disposeSettings(); disposeWorkspaces?.() }
  }, [services])
  useEffect(() => {
    // 范围或索引版本变化后重开对话，避免把旧范围的正文混入新上下文。
    if (activeChatId.current !== undefined) void call('assistant/chat/cancel', { requestId: activeChatId.current }).catch(() => undefined)
    activeChatId.current = undefined
    setHistory([]); setRun(undefined); setSubmitted('')
  }, [scopeKey, snapshot?.index.generation, modelKey, prompts.chat, call])
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await call<AssistantDebugSnapshot>('assistant/debug')
        if (stopped || !mounted.current) return
        setSnapshot(next)
        timer = setTimeout(() => { void poll() }, next.index.analysis?.state === 'running' ? 600 : 1500)
      } catch (cause) {
        if (!stopped && mounted.current) { setError(errorMessage(cause)); timer = setTimeout(() => { void poll() }, 1500) }
      }
    }
    void poll()
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
  }, [summarizing, snapshot?.index.analysis?.requestId, call])
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopImmediatePropagation(); onClose() } }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [onClose])
  useEffect(() => {
    if (run?.state !== 'running') return
    const id = run.requestId
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await call<AssistantChatRun>('assistant/chat/read', { requestId: id })
        if (stopped || !mounted.current) return
        setRun(next)
        if (next.state === 'completed') {
          activeChatId.current = undefined
          setHistory((previous) => [...previous, { role: 'user', text: submitted }, { role: 'assistant', text: next.text }])
          setSubmitted(''); return
        }
        if (next.state !== 'running') { activeChatId.current = undefined; return }
        timer = setTimeout(() => { void poll() }, 600)
      } catch (cause) {
        if (stopped || !mounted.current) return
        setError(errorMessage(cause))
        setRun((previous) => previous === undefined ? undefined : { ...previous, state: 'failed', error: errorMessage(cause) })
        void call('assistant/chat/cancel', { requestId: id }).catch(() => undefined)
        activeChatId.current = undefined
      }
    }
    void poll()
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
  }, [run?.requestId, run?.state, submitted, call])
  const updateScope = async (workspaceId: string, checked: boolean): Promise<void> => {
    const next = new Set(services.settings.getSnapshot().value?.assistant.managedWorkspaceIds ?? [])
    if (checked) next.add(workspaceId); else next.delete(workspaceId)
    setSaving(true); setError(undefined)
    try {
      const accepted = await services.settings.mutate([{ op: 'set', path: [CODINGNS_ASSISTANT_FIELD, 'managedWorkspaceIds'], value: [...next] }])
      if (!accepted) throw new Error(t('settings.moduleWriteRejected'))
      if (mounted.current) await refresh()
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
    finally { if (mounted.current) setSaving(false) }
  }
  const send = async (): Promise<void> => {
    const model = catalog?.models.find((entry) => selectionKey(entry) === modelKey)
    if (model === undefined || snapshot === undefined || chatting || text.trim() === '') return
    const prompt = text.trim()
    const id = `assistant-chat-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
    activeChatId.current = id
    setStarting(true); setError(undefined); setSubmitted(prompt); setRun(undefined)
    try {
      const next = await call<AssistantChatRun>('assistant/chat/start', { requestId: id, ...model, generation: snapshot.index.generation, messages: [...history.slice(-18), { role: 'user', text: prompt }] })
      if (!mounted.current || activeChatId.current !== id) { void call('assistant/chat/cancel', { requestId: id }).catch(() => undefined); return }
      setRun(next); setText('')
      if (next.state === 'completed') {
        activeChatId.current = undefined
        setHistory((previous) => [...previous, { role: 'user', text: prompt }, { role: 'assistant', text: next.text }])
        setSubmitted('')
      }
    } catch (cause) {
      if (mounted.current) { setError(errorMessage(cause)); setSubmitted(''); activeChatId.current = undefined }
    } finally { if (mounted.current) setStarting(false) }
  }
  const stop = async (): Promise<void> => {
    if (activeChatId.current === undefined) return
    try { const next = await call<AssistantChatRun>('assistant/chat/cancel', { requestId: activeChatId.current }); if (mounted.current) setRun(next) }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
  }
  const savePrompt = async (kind: 'index' | 'chat', value: string): Promise<void> => {
    setSaving(true); setError(undefined)
    try {
      const accepted = await services.settings.mutate([{ op: 'set', path: [CODINGNS_ASSISTANT_FIELD, 'prompts', kind], value }])
      if (!accepted) throw new Error(t('settings.moduleWriteRejected'))
      await refresh()
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); throw cause }
    finally { if (mounted.current) setSaving(false) }
  }
  const stopIndex = async (): Promise<void> => {
    const id = snapshot?.index.analysis?.requestId
    if (id === undefined) return
    try { await call('assistant/index/cancel', { requestId: id }); await refresh() }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
  }

  const button = (label: string, action: () => void, disabled = busy, primary = false): ReactElement => createElement('button', { type: 'button', disabled, onClick: action, style: primary ? dshSettingsPrimaryButtonStyle : dshSettingsButtonStyle }, t(label))
  return createElement('div', { role: 'presentation', onPointerDown: onClose, style: { position: 'fixed', inset: 0, zIndex: 10010, padding: 12, display: 'flex', justifyContent: 'center', alignItems: 'center', background: dshThemeColor.overlay, boxSizing: 'border-box' } },
    createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-label': t('assistant.debug.title'), onPointerDown: (event: { stopPropagation(): void }) => event.stopPropagation(), style: { display: 'flex', flexDirection: 'column', gap: 16, width: 'min(960px, 100%)', maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto', padding: 11, borderRadius: 12, border: `1px solid ${dshThemeColor.border}`, color: dshThemeColor.labelPrimary, background: dshThemeColor.menuBackground, boxSizing: 'border-box' } },
      createElement('strong', { style: { fontSize: 18 } }, t('assistant.debug.title')),
      createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('assistant.debug.stepsDescription')),
      createElement('div', { style: actionsStyle },
        button('assistant.debug.viewRefresh', () => { void refresh() }),
        button('assistant.debug.modelsRefresh', () => { void loadModels() }, busy || modelsLoading),
        button(summarizing ? 'assistant.debug.summarizing' : indexing ? 'assistant.debug.indexing' : 'assistant.debug.build', () => { setTab('result'); void refresh(true, catalog?.models.find((model) => selectionKey(model) === modelKey)) }, busy || managedIds.length === 0 || modelKey === '', true),
        !summarizing ? null : button('assistant.debug.analysisStop', () => { void stopIndex() }, false),
        button('assistant.debug.export', () => { if (snapshot !== undefined) downloadSnapshot(snapshot) }, busy || snapshot === undefined),
        button('assistant.debug.close', onClose, false),
      ),
      createElement('label', { style: { display: 'grid', gap: 8 } }, t('assistant.debug.sharedModel'), createElement('select', { 'aria-label': t('assistant.debug.sharedModel'), value: modelKey, disabled: busy || catalog === undefined, onChange: (event: { currentTarget: { value: string } }) => setModelKey(event.currentTarget.value), style: { ...dshFieldStyle, width: '100%', padding: 8 } }, createElement('option', { value: '', disabled: true }, t(catalog === undefined ? 'assistant.debug.modelsLoading' : 'assistant.debug.chooseModel')), ...(catalog?.models.map((model) => createElement('option', { key: selectionKey(model), value: selectionKey(model) }, model.label)) ?? []))),
      ...(catalog?.errors.map((message, index) => createElement('span', { key: index, role: 'alert' }, message)) ?? []),
      catalog?.models.length === 0 ? createElement('span', { role: 'status' }, t('assistant.debug.modelsEmpty')) : null,
      createElement('div', { role: 'tablist', 'aria-label': t('assistant.debug.steps'), style: actionsStyle }, ...TABS.map((item) => createElement('button', { key: item, id: `assistant-debug-tab-${item}`, type: 'button', role: 'tab', 'aria-selected': tab === item, 'aria-controls': `assistant-debug-panel-${item}`, onClick: () => setTab(item), style: tab === item ? dshSettingsPrimaryButtonStyle : dshSettingsButtonStyle }, t(`assistant.debug.tab.${item}`)))),
      loading || saving ? createElement('div', { role: 'status', style: dshSettingsHelpStyle }, t(indexing ? 'assistant.debug.indexing' : 'assistant.debug.loading')) : null,
      error === undefined ? null : createElement('div', { role: 'alert', style: { color: dshThemeColor.error, overflowWrap: 'anywhere' } }, error),
      createElement('div', { role: 'tabpanel', id: `assistant-debug-panel-${tab}`, 'aria-labelledby': `assistant-debug-tab-${tab}`, style: { display: 'grid', gap: 14, minWidth: 0 } },
        tab !== 'scope' ? null : createElement('section', { style: sectionStyle },
          createElement('strong', null, t('assistant.debug.tab.scope')), createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.rangeHelp')), createElement('span', null, t('assistant.debug.selectedCount', { count: managedIds.length })),
          ...workspaces.map((workspace) => createElement('label', { key: workspace.workspaceId, style: { display: 'flex', alignItems: 'center', gap: 12 } },
            createElement('input', { type: 'checkbox', 'aria-label': workspace.title, checked: managedIds.includes(workspace.workspaceId), disabled: busy || !settings.writable || settings.status === 'loading', onChange: (event: { currentTarget: { checked: boolean } }) => { void updateScope(workspace.workspaceId, event.currentTarget.checked) } }),
            createElement('span', { style: { display: 'grid', gap: 3, minWidth: 0, overflowWrap: 'anywhere' } }, createElement('strong', null, workspace.title), createElement('span', { style: dshSettingsHelpStyle }, workspace.path ?? workspace.workspaceId), workspace.available ? null : createElement('span', null, t('assistant.debug.missingWorkspace'))),
          )), workspaces.length === 0 ? createElement('span', null, t('assistant.noWorkspaces')) : null,
        ),
        tab !== 'sessions' || snapshot === undefined ? null : createElement(AssistantScopeSessionsView, { snapshot, managedIds, t }),
        tab !== 'result' ? null : createElement(AssistantPromptEditor, { kind: 'index', value: prompts.index, disabled: busy || !settings.writable || settings.status !== 'ready', onSave: savePrompt, t }),
        tab !== 'result' || snapshot === undefined ? null : createElement(AssistantDebugSnapshotView, { snapshot, t }),
        tab !== 'records' || snapshot === undefined ? null : createElement(AssistantIndexRecordsView, { snapshot, t }),
        tab !== 'chat' ? null : createElement('section', { style: sectionStyle },
          createElement(AssistantPromptEditor, { kind: 'chat', value: prompts.chat, disabled: busy || !settings.writable || settings.status !== 'ready', onSave: savePrompt, t }),
          createElement('strong', null, t('assistant.debug.tab.chat')), createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.chatHelp')),
          snapshot?.indexState !== 'ready' ? createElement('span', { role: 'status' }, t('assistant.debug.chatNeedsIndex')) : createElement('span', null, t('assistant.debug.chatGeneration', { generation: snapshot.index.generation })),
          createElement('div', { style: actionsStyle }, button('assistant.debug.chatClear', () => { setHistory([]); setRun(undefined); setSubmitted('') }, chatting)),
          createElement(AssistantChatMessagesView, { history, submitted, run, t }),
          createElement('textarea', { 'aria-label': t('assistant.debug.chatInput'), placeholder: t('assistant.debug.chatPlaceholder'), maxLength: 8000, value: text, disabled: busy, onChange: (event: { currentTarget: { value: string } }) => setText(event.currentTarget.value), rows: 3, style: { ...dshFieldStyle, width: '100%', padding: 10, boxSizing: 'border-box', resize: 'vertical' } }),
          createElement('div', { style: actionsStyle }, button(chatting ? 'assistant.debug.chatGenerating' : 'assistant.debug.chatSend', () => { void send() }, busy || modelsLoading || text.trim() === '' || modelKey === '' || snapshot?.indexState !== 'ready', true), !chatting ? null : button('assistant.debug.chatStop', () => { void stop() }, starting)),
        ),
      ),
    ),
  )
}

/** 草稿只在明确保存时写入；保存单个字段，不覆盖另一阶段的提示词。 */
export function AssistantPromptEditor({ kind, value, disabled, onSave, onChange, t }: { readonly kind: 'index' | 'chat'; readonly value: string; readonly disabled: boolean; readonly onSave: (kind: 'index' | 'chat', value: string) => Promise<void>; readonly onChange?: (kind: 'index' | 'chat', value: string) => Promise<void>; readonly t: CodingNsTranslator }): ReactElement {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const change = (text: string): void => { setDraft(text); void onChange?.(kind, text).catch(() => undefined) }
  return createElement('details', { style: sectionStyle },
    createElement('summary', { style: { ...assistantSettingTextStyle, cursor: 'pointer' } }, t(`assistant.debug.prompt.${kind}`)),
    createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.promptHelp')),
    createElement('textarea', { 'aria-label': t(`assistant.debug.prompt.${kind}`), value: draft, disabled, maxLength: ASSISTANT_PROMPT_MAX_CHARS, rows: 5, onChange: (event: { currentTarget: { value: string } }) => change(event.currentTarget.value), style: { ...dshFieldStyle, ...assistantSettingTextStyle, width: '100%', padding: 10, boxSizing: 'border-box', resize: 'vertical' } }),
    createElement('div', { style: actionsStyle },
      onChange === undefined ? createElement('button', { type: 'button', disabled: disabled || draft === value, style: dshSettingsPrimaryButtonStyle, onClick: () => { void onSave(kind, draft.trim() || DEFAULT_ASSISTANT_PROMPTS[kind]).catch(() => undefined) } }, t('assistant.debug.promptSave')) : null,
      createElement('button', { type: 'button', disabled, style: dshSettingsButtonStyle, onClick: () => change(DEFAULT_ASSISTANT_PROMPTS[kind]) }, t('assistant.debug.promptDefault')),
    ),
  )
}

/** 范围成员与正文索引分开显示，空项目也必须出现在范围内。 */
export function AssistantScopeSessionsView({ snapshot, managedIds, t }: { readonly snapshot: AssistantDebugSnapshot; readonly managedIds: readonly string[]; readonly t: CodingNsTranslator }): ReactElement {
  const sessions = snapshot.scopeSessions
  return createElement('section', { style: sectionStyle }, createElement('strong', null, t('assistant.debug.tab.sessions')), createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.sessionStateHelp')), managedIds.length === 0 ? createElement('span', null, t('assistant.debug.scopeEmpty')) : null,
    ...managedIds.map((id) => createElement('div', { key: id, style: { display: 'grid', gap: 8 } },
      createElement('strong', null, t('assistant.debug.projectCount', { name: snapshot.workspaces.find((workspace) => workspace.workspaceId === id)?.name ?? sessions.find((entry) => entry.workspaceId === id)?.workspaceName ?? id, count: sessions.filter((entry) => entry.workspaceId === id).length })),
      ...sessions.filter((entry) => entry.workspaceId === id).map((entry) => sessionCard(entry, t, false)), sessions.some((entry) => entry.workspaceId === id) ? null : createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.projectEmpty')),
    )),
  )
}

/** 结果只展示当前范围的索引及质量统计，底层接口和 JSON 收进折叠区。 */
export function AssistantDebugSnapshotView({ snapshot, t }: { readonly snapshot: AssistantDebugSnapshot; readonly t: CodingNsTranslator }): ReactElement {
  const { index } = snapshot
  const unknown = index.entries.filter((entry) => entry.status === 'unknown' || entry.status === undefined).length
  const read = index.entries.filter((entry) => entry.summary).length
  return createElement('section', { style: sectionStyle },
    createElement('strong', null, t('assistant.debug.tab.result')), createElement('span', { role: 'status' }, t(`assistant.debug.indexState.${snapshot.indexState}`)),
    snapshot.indexedAt === null ? null : createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.indexTime', { time: new Date(snapshot.indexedAt).toLocaleString(), generation: index.generation })),
    snapshot.indexedAt === null ? null : createElement('span', null, t('assistant.debug.quality', { total: index.entries.length, read, empty: index.entries.length - read - index.unreadableCount, unknown, failed: index.unreadableCount })),
    ...snapshot.warnings.map((warning, number) => createElement('span', { key: number, role: 'alert' }, warning)),
    index.analysis === undefined ? null : createElement('div', { style: cardStyle },
      createElement('strong', null, t('assistant.debug.analysisTitle')),
      createElement('span', { role: 'status' }, t(index.analysis.state === 'completed' && index.analysis.tasks?.some((task) => task.state === 'deferred') ? 'assistant.debug.analysisDeferred' : `assistant.debug.analysisState.${index.analysis.state}`)),
      createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.analysisModel', { provider: index.analysis.provider, model: index.analysis.model })),
      index.analysis.tasks === undefined ? null : indexTasksView(index.analysis.tasks, t),
      ...(index.analysis.tasks ?? []).filter((task) => task.text !== '').map((task) => createElement('details', { key: task.requestId }, createElement('summary', null, t('assistant.debug.taskRaw', { name: task.title ?? shortSessionTitle(task.sessionId, t) })), createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, task.text))),
      ...(index.analysis.result?.sessions ?? []).map((session) => structuredSessionCard(session, t)),
      index.analysis.result !== undefined || index.analysis.text === '' ? null : createElement('details', null, createElement('summary', null, t('assistant.debug.modelRaw')), createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, index.analysis.text)),
      index.analysis.error === null ? null : createElement('span', { role: 'alert' }, index.analysis.error),
    ),
    snapshot.indexedAt === null || index.analysis !== undefined ? null : createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 } }, snapshot.summary.speechText),
    snapshot.indexedAt === null ? null : createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.rawEvidence')),
    snapshot.indexedAt === null ? null : createElement('div', { style: { display: 'grid', gap: 8 } }, ...index.entries.map((entry) => sessionCard(entry, t, true))),
    createElement('details', { style: sectionStyle }, createElement('summary', { style: { cursor: 'pointer' } }, t('assistant.debug.technical')),
      ...Object.entries(snapshot.services).map(([name, available]) => createElement('span', { key: name }, t('assistant.debug.serviceState', { service: t(`assistant.debug.service.${name}`), state: t(available ? 'assistant.debug.available' : 'assistant.debug.unavailable') }))),
      createElement('details', null, createElement('summary', null, t('assistant.debug.excludedCount', { count: index.excludedTargets?.length ?? 0 })), ...(index.excludedTargets ?? []).map((entry) => createElement('div', { key: `${entry.hostId}:${entry.sessionId}` }, t('assistant.debug.excludedRow', { name: entry.title ?? shortSessionTitle(entry.sessionId, t), workspace: entry.workspaceName, reason: t(entry.archived ? 'assistant.debug.archived' : 'assistant.debug.outsideScope') })))),
      createElement('details', null, createElement('summary', null, t('assistant.debug.raw')), jsonView(snapshot)),
    ),
  )
}

/** 逐项显示独立任务的进度与思考参数，历史记录复用相同展示。 */
function indexTasksView(tasks: readonly Omit<AssistantSessionIndexTask, 'text'>[], t: CodingNsTranslator): ReactElement {
  const count = (state: AssistantSessionIndexTask['state']): number => tasks.filter((task) => task.state === state).length
  return createElement('div', { style: cardStyle },
    createElement('strong', null, t('assistant.debug.taskProgress', { total: tasks.length, completed: count('completed'), queued: count('queued'), running: count('running'), failed: count('failed') + count('cancelled'), deferred: count('deferred'), reused: tasks.filter((task) => task.reused && task.state === 'completed').length })),
    createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.taskHelp')),
    ...tasks.map((task) => createElement('div', { key: task.requestId, style: { display: 'grid', gap: 3 } },
      createElement('span', null, t('assistant.debug.taskRow', { workspace: task.workspaceName, name: task.title ?? shortSessionTitle(task.sessionId, t), state: t(`assistant.debug.taskState.${task.state}`) })),
      createElement('span', { style: dshSettingsHelpStyle }, t(task.reused ? 'assistant.debug.taskReused' : `assistant.debug.thinking.${task.thinking ?? 'pending'}`)),
      task.error === null ? null : createElement('span', { role: 'alert' }, task.error),
    )),
  )
}

/** 调试时逐会话检查事实、任务与证据；正式对话仍由 LLM 输出简短口语。 */
function structuredSessionCard(session: AssistantSessionAnalysis, t: CodingNsTranslator): ReactElement {
  return createElement('article', { key: JSON.stringify([session.hostId, session.sessionId]), style: cardStyle },
    createElement('strong', null, `${session.workspaceName} / ${session.title ?? shortSessionTitle(session.sessionId, t)}`),
    createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.sourceStatus', { status: t(`assistant.debug.status.${session.sourceStatus}`) })),
    createElement('span', { style: dshSettingsHelpStyle }, t(`assistant.debug.material.${session.material}`)),
    factSection('objective', session.objective === null ? [] : [session.objective], t),
    factSection('progress', session.progress, t), factSection('blockers', session.blockers, t), factSection('pendingTasks', session.pendingTasks, t),
    createElement('div', { style: { display: 'grid', gap: 6 } }, createElement('strong', null, t('assistant.debug.field.nextActions')),
      session.nextActions.length === 0 ? createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.noEvidence')) : null,
      ...session.nextActions.map((action, index) => createElement('div', { key: index, style: cardStyle },
        createElement('span', null, t('assistant.debug.actionTitle', { kind: t(`assistant.debug.actionKind.${action.kind}`), priority: t(`assistant.debug.priority.${action.priority}`), action: action.action })),
        createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.actionReason', { reason: action.reason })), evidenceView(action.evidence, t),
      )),
    ),
    createElement('div', { style: { display: 'grid', gap: 6 } }, createElement('strong', null, t('assistant.debug.field.openQuestions')),
      session.openQuestions.length === 0 ? createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.noQuestions')) : null,
      ...session.openQuestions.map((question, index) => createElement('span', { key: index }, question)),
    ),
  )
}

function factSection(name: string, facts: readonly AssistantIndexFact[], t: CodingNsTranslator): ReactElement {
  return createElement('div', { style: { display: 'grid', gap: 6 } }, createElement('strong', null, t(`assistant.debug.field.${name}`)),
    facts.length === 0 ? createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.noEvidence')) : null,
    ...facts.map((fact, index) => createElement('div', { key: index }, createElement('span', null, fact.text), evidenceView(fact.evidence, t))),
  )
}

function evidenceView(evidence: readonly AssistantIndexEvidence[], t: CodingNsTranslator): ReactElement {
  return createElement('details', null, createElement('summary', null, t('assistant.debug.evidence')),
    ...evidence.map((item, index) => createElement('blockquote', { key: index, style: { margin: '4px 0', whiteSpace: 'pre-wrap' } }, t('assistant.debug.evidenceQuote', { source: t(`assistant.debug.evidenceSource.${item.source}`), quote: item.quote }))),
  )
}

export function AssistantIndexRecordsView({ snapshot, t }: { readonly snapshot: AssistantDebugSnapshot; readonly t: CodingNsTranslator }): ReactElement {
  return createElement('section', { style: sectionStyle }, createElement('strong', null, t('assistant.debug.tab.records')), createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.recordsHelp')), snapshot.records.length === 0 ? createElement('span', null, t('assistant.debug.noRecords')) : null,
    ...snapshot.records.map((record) => createElement('details', { key: record.id, style: cardStyle },
      createElement('summary', { style: { cursor: 'pointer' } }, t('assistant.debug.recordTitle', { time: new Date(record.startedAt).toLocaleString(), trigger: t(`assistant.debug.trigger.${record.trigger}`), state: t(`assistant.debug.recordState.${record.state}`) })),
      createElement('span', null, t('assistant.debug.recordStats', { duration: record.durationMs ?? 0, included: record.included, excluded: record.excluded, failed: record.unreadable })),
      createElement('span', null, t('assistant.debug.recordScope', { names: record.workspaceIds.map((id) => snapshot.workspaces.find((item) => item.workspaceId === id)?.name ?? id).join(' / ') })),
      record.error === null ? null : createElement('span', { role: 'alert' }, record.error), ...record.warnings.map((warning, index) => createElement('span', { key: index }, warning)),
      record.analysis === undefined ? null : createElement('span', null, t('assistant.debug.analysisRecord', { provider: record.analysis.provider, model: record.analysis.model, state: t(`assistant.debug.analysisState.${record.analysis.state}`), duration: (record.analysis.finishedAt ?? snapshot.capturedAt) - record.analysis.startedAt })),
      record.analysis?.error ? createElement('span', { role: 'alert' }, record.analysis.error) : null,
      record.analysis?.tasks === undefined ? null : indexTasksView(record.analysis.tasks, t),
      ...record.sessions.map((session) => createElement('div', { key: session.sessionId }, t('assistant.debug.recordSession', { name: session.title ?? shortSessionTitle(session.sessionId, t), workspace: session.workspaceName, result: t(`assistant.debug.readResult.${session.result}`) }), session.error === null ? null : createElement('span', { role: 'alert' }, session.error))),
    )),
  )
}

export function AssistantChatMessagesView({ history, submitted, run, t }: { readonly history: readonly AssistantChatMessage[]; readonly submitted: string; readonly run: AssistantChatRun | undefined; readonly t: CodingNsTranslator }): ReactElement {
  const pending: readonly AssistantChatMessage[] = submitted === '' ? [] : [{ role: 'user', text: submitted }, { role: 'assistant', text: run?.text || t(run?.state === 'failed' ? 'assistant.debug.chatFailed' : run?.state === 'cancelled' ? 'assistant.debug.chatCancelled' : 'assistant.debug.chatGenerating') }]
  return createElement('div', { role: 'log', 'aria-live': 'polite', style: { display: 'grid', gap: 10, maxHeight: 380, overflowY: 'auto', minHeight: 100 } }, history.length === 0 && submitted === '' ? createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.chatEmpty')) : null,
    ...[...history, ...pending].map((message, index) => createElement('div', { key: index, style: { ...cardStyle, whiteSpace: 'pre-wrap' } }, createElement('strong', null, t(`assistant.debug.chatRole.${message.role}`)), createElement('span', null, message.text))), run?.error ? createElement('span', { role: 'alert' }, run.error) : null,
  )
}

function sessionCard(entry: SessionIndexEntry, t: CodingNsTranslator, indexed: boolean): ReactElement {
  const indexState = entry.indexState === 'waiting' ? entry.waiting !== null ? 'waiting-user' : entry.activity === 'unknown' ? 'waiting-status' : 'waiting' : entry.indexState
  return createElement('details', { key: `${entry.hostId}:${entry.sessionId}`, style: cardStyle }, createElement('summary', { style: { cursor: 'pointer' } }, t('assistant.debug.sessionTitle', { title: entry.title ?? shortSessionTitle(entry.sessionId, t), status: t(`assistant.debug.status.${entry.status ?? 'unknown'}`) }), indexState === undefined ? null : createElement('span', { style: { marginLeft: 12, ...dshSettingsHelpStyle } }, t(`assistant.debug.sessionIndex.${indexState}`))),
    entry.sourceVersion === undefined ? null : createElement('span', { style: dshSettingsHelpStyle }, t(indexed ? 'assistant.debug.sessionMaterialVersion' : 'assistant.debug.sessionVersion', { source: entry.sourceVersion, indexed: entry.indexedVersion ?? 0 })),
    entry.waiting === null ? null : createElement('span', null, t(`assistant.debug.waiting.${entry.waiting}`)), createElement('span', { style: dshSettingsHelpStyle }, `${entry.hostId} / ${entry.sessionId}`), entry.updatedAt === null ? null : createElement('span', { style: dshSettingsHelpStyle }, t('assistant.debug.updated', { time: new Date(entry.updatedAt).toLocaleString() })), !indexed ? null : createElement('span', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, entry.summary || t('assistant.debug.noSummary')),
  )
}

/** 合并 Host、原生和远端元数据，保留已选但不可用的工作区。 */
export function mergeDebugWorkspaces(snapshot: AssistantDebugSnapshot | undefined, native: readonly NativeWorkspaceRecord[], managedIds: readonly string[]): readonly { workspaceId: string; title: string; path?: string; available: boolean }[] {
  const result = new Map<string, { workspaceId: string; title: string; path?: string; available: boolean }>()
  for (const workspace of snapshot?.workspaces ?? []) result.set(workspace.workspaceId, { workspaceId: workspace.workspaceId, title: workspace.name, ...(workspace.path === null ? {} : { path: workspace.path }), available: true })
  for (const workspace of native) result.set(workspace.workspaceId, { ...workspace, available: true })
  for (const entry of [...snapshot?.scopeSessions ?? [], ...snapshot?.index.entries ?? [], ...snapshot?.index.excludedTargets ?? []]) if (!result.has(entry.workspaceId)) result.set(entry.workspaceId, { workspaceId: entry.workspaceId, title: entry.workspaceName, available: true })
  for (const workspaceId of managedIds) if (!result.has(workspaceId)) result.set(workspaceId, { workspaceId, title: workspaceId, available: false })
  return [...result.values()]
}
function selectionKey(model: { readonly provider: string; readonly model: string }): string { return JSON.stringify([model.provider, model.model]) }
function shortSessionTitle(id: string, t: CodingNsTranslator): string { return t('assistant.debug.shortTitle', { id: id.slice(-8) }) }
function jsonView(value: unknown): ReactElement { return createElement('pre', { style: { margin: '8px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, lineHeight: 1.5 } }, JSON.stringify(value, null, 2)) }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value) }
function downloadSnapshot(snapshot: AssistantDebugSnapshot): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `assistant-debug-${new Date(snapshot.capturedAt).toISOString().replace(/[:.]/gu, '-')}.json`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
const actionsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const sectionStyle: CSSProperties = { display: 'grid', gap: 10, minWidth: 0, padding: 14, borderRadius: 8, border: `1px solid ${dshThemeColor.border}` }
const cardStyle: CSSProperties = { display: 'grid', gap: 5, padding: 12, borderRadius: 8, background: dshThemeColor.inputBackground, overflowWrap: 'anywhere' }
