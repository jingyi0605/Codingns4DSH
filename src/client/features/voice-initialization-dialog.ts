import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import type { AssistantVoiceSettings } from '../../shared/contracts/config.js'
import { ASSISTANT_VOICE_MODEL_CATALOG, findAssistantVoiceModel, type AssistantVoiceModel, type AssistantVoiceModelProgress, type AssistantVoiceModelStatus, type AssistantVoiceModelsSnapshot } from '../../shared/voice-models.js'
import { watchVoiceModelSetupProgress } from '../voice-model-setup-progress.js'
import type { CodingNsClientServices } from './types.js'
import { dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { assistantSettingCheckboxStyle, assistantSettingTextStyle } from '../assistant-settings-styles.js'
import { DEFAULT_VOICE_MODEL_ID } from '../../shared/voice-initialization.js'
import { uiFontSize } from '../font-scale.js'

/** 旧入口继续使用弹窗，与声音页共用同一套模型操作。 */
export function VoiceInitializationDialog({ services, value, onClose }: {
  readonly services: CodingNsClientServices; readonly value: AssistantVoiceSettings; readonly onClose: () => void
}): ReactElement {
  return createElement(VoiceModelManager, { services, value, onClose })
}

/** 识别模型独立展示，不依赖 MOSS 初始化或高级声音设置的展开状态。 */
export function VoiceModelManagerPanel({ services, value, enabled, active }: {
  readonly services: CodingNsClientServices; readonly value: AssistantVoiceSettings
  readonly enabled: boolean; readonly active: boolean
}): ReactElement {
  return createElement(VoiceModelManager, { services, value, enabled, active })
}

/** 选中的卡片与 Host 当前配置分开保存，操作完成后重新读取文件事实。 */
function VoiceModelManager({ services, value, enabled = true, active = true, onClose }: {
  readonly services: CodingNsClientServices; readonly value: AssistantVoiceSettings
  readonly enabled?: boolean; readonly active?: boolean; readonly onClose?: () => void
}): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [modelId, setModelId] = useState(() => findAssistantVoiceModel(value.modelId ?? '')?.id ?? DEFAULT_VOICE_MODEL_ID)
  const [snapshot, setSnapshot] = useState<AssistantVoiceModelsSnapshot | undefined>()
  const [refreshing, setRefreshing] = useState(true)
  const [busy, setBusy] = useState<'setup' | 'verify' | 'repair' | undefined>()
  const [progress, setProgress] = useState<AssistantVoiceModelProgress | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [success, setSuccess] = useState<string | undefined>()
  const mounted = useRef(true)
  const readAbort = useRef<AbortController | undefined>()
  const stopProgress = useRef<(() => void) | undefined>()
  const pending = useRef(false)
  const [settings, setSettings] = useState(() => services.settings.getSnapshot())

  const refresh = useCallback(async (): Promise<void> => {
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    setRefreshing(true)
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/models', {}, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      if (!result.ok) throw new Error(result.error.message)
      setSnapshot(result.value as AssistantVoiceModelsSnapshot)
      setLoadError(undefined)
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setLoadError(errorMessage(cause))
    } finally {
      if (mounted.current && !controller.signal.aborted) setRefreshing(false)
    }
  }, [services.rpc])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; readAbort.current?.abort(); stopProgress.current?.() }
  }, [services.rpc])

  useEffect(() => {
    if (active) void refresh()
    const onFocus = (): void => { if (active) void refresh() }
    window.addEventListener('focus', onFocus)
    const unsubscribe = services.settings.subscribe(() => {
      setSettings(services.settings.getSnapshot())
      if (active || pending.current) void refresh()
    })
    return () => { window.removeEventListener('focus', onFocus); unsubscribe() }
  }, [active, refresh, services.settings])

  // 向导或其他窗口改变当前模型后同步选中项；普通状态刷新保留用户尚未应用的选择。
  useEffect(() => {
    const current = findAssistantVoiceModel((services.configurationDraft ? value.modelId : snapshot?.currentModelId) ?? '')
    if (current !== undefined) setModelId(current.id)
  }, [snapshot?.currentModelId, services.configurationDraft, value.modelId])

  useEffect(() => {
    if (!active || snapshot?.operation == null || busy !== undefined) return undefined
    const timer = setTimeout(() => void refresh(), 1000)
    return () => clearTimeout(timer)
  }, [active, snapshot, busy, refresh])

  useEffect(() => {
    if (onClose === undefined) return undefined
    const onEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !pending.current) onClose() }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [onClose])

  const run = async (kind: 'setup' | 'verify' | 'repair'): Promise<void> => {
    if (!active || !enabled || pending.current || snapshot === undefined || snapshot.operation !== null) return
    if (kind !== 'verify' && (snapshot.runtimeRunning || !settings.writable || settings.status === 'loading')) return
    pending.current = true
    setBusy(kind); setError(undefined); setSuccess(undefined); setProgress(undefined)
    try {
      const request = { modelId, requestId: `voice-model-${Date.now()}-${Math.random().toString(36).slice(2)}`, repair: kind === 'repair' }
      if (kind !== 'verify') stopProgress.current = watchVoiceModelSetupProgress(services.rpc, request, (next) => { if (mounted.current) setProgress(next) })
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, kind === 'verify' ? 'assistant/voice/model/verify' : 'assistant/voice/setup', request)
      if (!mounted.current) return
      if (!result.ok) throw new Error(result.error.message)
      if (kind !== 'verify') {
        // 工作台仅更新资源草稿；独立模型管理仍重读 Host 保存结果。
        if (services.settings.reload !== undefined) await services.settings.reload()
        else await services.settings.load?.()
      }
      if (!mounted.current) return
      setSuccess(t(kind === 'verify' ? 'voice.models.verified' : services.configurationDraft ? 'voice.models.prepared' : 'voice.models.applied'))
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
    finally {
      stopProgress.current?.(); stopProgress.current = undefined; pending.current = false
      if (mounted.current) { setBusy(undefined); await refresh() }
    }
  }
  const choose = (id: string): void => { setModelId(id); setError(undefined); setSuccess(undefined); setProgress(undefined) }
  const manager = createElement(VoiceModelManagerView, { snapshot, modelId, refreshing, busy, progress, error: error ?? loadError, success,
    enabled, writable: settings.writable && settings.status !== 'loading', onSelect: choose, onRefresh: () => void refresh(), onRun: (kind) => void run(kind), ...(onClose === undefined ? {} : { onClose }), t })
  if (onClose === undefined) return createElement('section', {
    'data-codingns-voice-model-manager': true, 'aria-label': t('awb.asr'), 'aria-busy': refreshing || busy !== undefined,
    style: { display: 'grid', minWidth: 0 },
  }, manager)
  return createElement('div', {
    role: 'presentation', onPointerDown: () => { if (!pending.current) onClose() },
    style: { position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: dshThemeColor.overlay, boxSizing: 'border-box' },
  }, createElement('div', {
    role: 'dialog', 'aria-modal': true, 'aria-label': t('voice.setup.title'), 'aria-busy': busy !== undefined,
    onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    style: { display: 'flex', flexDirection: 'column', width: 'min(680px, 100%)', maxHeight: 'min(780px, 100%)', color: dshThemeColor.labelPrimary, background: dshThemeColor.menuBackground, border: `1px solid ${dshThemeColor.border}`, borderRadius: 14, boxShadow: dshThemeColor.prominentShadow, overflow: 'hidden', boxSizing: 'border-box' },
  }, manager))
}

/** 展示层保留下载、配置和验证三个维度，避免把选择动作显示成启用成功。 */
export function VoiceModelManagerView({ snapshot, modelId, refreshing, busy, progress, error, success, writable, enabled = true, onSelect, onRefresh, onRun, onClose, t }: {
  readonly snapshot: AssistantVoiceModelsSnapshot | undefined; readonly modelId: string; readonly refreshing: boolean
  readonly busy: 'setup' | 'verify' | 'repair' | undefined; readonly progress: AssistantVoiceModelProgress | undefined
  readonly error: string | undefined; readonly success: string | undefined; readonly writable: boolean
  readonly enabled?: boolean
  readonly onSelect: (id: string) => void; readonly onRefresh: () => void; readonly onRun: (kind: 'setup' | 'verify' | 'repair') => void; readonly onClose?: () => void
  readonly t: CodingNsTranslator
}): ReactElement {
  const current = findAssistantVoiceModel(snapshot?.currentModelId ?? '')
  const selected = snapshot?.models.find((model) => model.modelId === modelId)
  const locked = !enabled || busy !== undefined || snapshot?.operation != null
  const canApply = snapshot !== undefined && !locked && writable && !snapshot.runtimeRunning
  const alreadyUsed = selected?.current === true && selected.validation.state === 'passed' && selected.state === 'downloaded'
  const action = selected?.state === 'partial' ? t('voice.models.completeDownload') : selected?.state === 'downloaded'
    ? alreadyUsed ? t('voice.models.inUse') : t('voice.models.use') : t('voice.models.downloadUse')
  return createElement('div', { style: { display: 'contents' } },
    createElement('div', { style: { padding: onClose === undefined ? '0 0 12px' : '20px 22px 16px', display: 'grid', gap: 6 } },
      createElement('div', { style: { ...rowStyle, flexWrap: 'wrap' } }, createElement('strong', { style: { fontSize: onClose === undefined ? 14 : 19, lineHeight: 1.4 } }, t(onClose === undefined ? 'awb.asr' : 'voice.setup.title')),
        button(t(refreshing ? 'voice.models.refreshing' : 'voice.models.refresh'), refreshing || busy !== undefined, onRefresh)),
      createElement('span', { style: helpStyle }, t('voice.models.description')),
      onClose === undefined ? createElement('span', { style: helpStyle }, t('voice.models.recognitionHint')) : null,
    ),
    createElement('div', { style: { ...(onClose === undefined ? {} : { overflowY: 'auto' }), minHeight: 0,
      padding: onClose === undefined ? '0 0 16px' : '0 22px 18px', display: 'grid', gap: 12 } },
      createElement('div', { style: { ...noticeStyle, display: 'grid', gap: 5 } },
        createElement('span', { style: helpStyle }, t('voice.models.current')),
        createElement('strong', { style: { fontSize: uiFontSize(14), overflowWrap: 'anywhere' } }, snapshot === undefined ? t('voice.models.unknown') : current?.label ?? (snapshot.currentModelId ? t('voice.models.custom') : t('voice.models.none'))),
        snapshot === undefined ? null : createElement('span', { style: helpStyle }, t(snapshot.runtimeRunning ? 'voice.models.running' : snapshot.runtimeReady ? 'voice.models.ready' : 'voice.models.stopped')),
      ),
      snapshot === undefined && error === undefined ? createElement('div', { role: 'status', style: helpStyle }, t('voice.models.loading')) : null,
      createElement('div', { role: 'radiogroup', 'aria-label': t('voice.setup.model'), style: { display: 'grid', gap: 10 } },
        ...ASSISTANT_VOICE_MODEL_CATALOG.map((model) => createElement(VoiceModelCard, { key: model.id, model, status: snapshot?.models.find((status) => status.modelId === model.id), selected: model.id === modelId, disabled: locked || snapshot === undefined, onSelect, t }))),
      busy === undefined ? null : createElement('div', { style: noticeStyle }, createElement(VoiceModelSetupProgress, { progress: busy === 'verify'
        ? { modelId, phase: 'verifying', fileName: null, fileIndex: 0, fileCount: 0, downloadedBytes: 0, totalBytes: null } : progress, t })),
      snapshot?.operation == null || busy !== undefined ? null : createElement('div', { role: 'status', style: noticeStyle }, t('voice.models.otherOperation')),
      snapshot?.runtimeRunning ? createElement('div', { style: helpStyle }, t('voice.models.stopBeforeSwitch')) : null,
      success === undefined ? null : createElement('div', { role: 'status', style: { ...noticeStyle, color: dshThemeColor.success } }, success),
      error === undefined ? null : createElement('div', { role: 'alert', style: { ...noticeStyle, color: dshThemeColor.error, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, error),
      createElement('span', { style: helpStyle }, t('voice.models.localHint')),
    ),
    createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8,
      padding: onClose === undefined ? '14px 0 0' : '14px 22px', borderTop: `1px solid ${dshThemeColor.border}` } },
      onClose === undefined ? null : button(t('voice.models.close'), busy !== undefined, onClose),
      selected?.state === 'missing' || selected === undefined ? null : button(t('voice.models.redownload'), !canApply, () => onRun('repair')),
      button(t('voice.models.verify'), locked || selected?.state !== 'downloaded', () => onRun('verify')),
      button(action, !canApply || alreadyUsed || selected === undefined, () => onRun('setup'), true)),
  )
}

/** 文件详情按需展开，模型下载状态与最近验证结果始终可见。 */
export function VoiceModelCard({ model, status, selected, disabled, onSelect, t }: {
  readonly model: AssistantVoiceModel; readonly status: AssistantVoiceModelStatus | undefined; readonly selected: boolean
  readonly disabled: boolean; readonly onSelect: (id: string) => void; readonly t: CodingNsTranslator
}): ReactElement {
  const state = status === undefined ? t('voice.models.unknown') : t(status.state === 'downloaded' ? 'voice.models.downloaded' : status.state === 'partial' ? 'voice.models.partial' : 'voice.models.missing')
  const validation = status?.validation.state === 'passed' ? t('voice.models.passed') : status?.validation.state === 'failed' ? t('voice.models.failed') : t('voice.models.unchecked')
  return createElement('div', { style: { border: `1px solid ${selected ? dshThemeColor.accent : dshThemeColor.border}`, borderRadius: 9, padding: '12px 14px', background: selected ? dshThemeColor.surfaceSubtle : dshThemeColor.menuBackground, display: 'grid', gap: 8 } },
    createElement('label', { style: { ...assistantSettingCheckboxStyle, cursor: disabled ? 'default' : 'pointer' } },
      createElement('input', { type: 'radio', name: 'voice-model', value: model.id, checked: selected, disabled, onChange: () => onSelect(model.id), style: { margin: '3px 0 0', accentColor: dshThemeColor.accent, flexShrink: 0 } }),
      createElement('span', { style: { display: 'grid', gap: 5, minWidth: 0, flex: 1 } },
        createElement('span', { style: { ...assistantSettingTextStyle, overflowWrap: 'anywhere' } }, model.label),
        createElement('span', { style: helpStyle }, model.description),
        createElement('span', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          badge(state, status?.state === 'downloaded' ? dshThemeColor.success : dshThemeColor.labelSecondary),
          status?.current ? badge(t('voice.models.inUse'), dshThemeColor.accent) : null,
          status?.state === 'downloaded' ? badge(validation, status.validation.state === 'passed' ? dshThemeColor.success : status.validation.state === 'failed' ? dshThemeColor.error : dshThemeColor.labelSecondary) : null))),
    status === undefined ? null : createElement('div', { style: { paddingLeft: 23, display: 'grid', gap: 6 } },
      createElement('span', { style: helpStyle }, t('voice.models.fileCount', { count: status.files.filter((file) => file.present).length, total: status.files.length, size: formatDownloadSize(status.totalBytes) })),
      status.validation.checkedAt === null ? null : createElement('span', { style: helpStyle }, t('voice.models.checkedAt', { time: new Date(status.validation.checkedAt).toLocaleString() })),
      status.validation.error === null ? null : createElement('span', { style: { ...helpStyle, color: dshThemeColor.error, overflowWrap: 'anywhere' } }, status.validation.error),
      createElement('details', null, createElement('summary', { style: { ...helpStyle, cursor: 'pointer' } }, t('voice.models.fileDetails')),
        createElement('div', { style: { display: 'grid', gap: 9, marginTop: 9 } }, ...status.files.map((file) => createElement('div', { key: file.name, style: { display: 'grid', gap: 2 } },
          createElement('span', { style: { ...rowStyle, fontSize: uiFontSize(12) } }, createElement('span', { style: { overflowWrap: 'anywhere' } }, file.name),
            createElement('span', { style: { flexShrink: 0, color: file.present ? dshThemeColor.labelSecondary : dshThemeColor.error } }, file.present ? formatDownloadSize(file.bytes) : file.partialBytes > 0 ? t('voice.models.partialSize', { size: formatDownloadSize(file.partialBytes) }) : t('voice.models.fileMissing'))),
          createElement('span', { style: { ...helpStyle, fontSize: uiFontSize(11), overflowWrap: 'anywhere', fontFamily: dshThemeColor.codeFont } }, file.path)))))))
}

/** 已下载的字节进度与模型验证、配置阶段分别显示。 */
export function VoiceModelSetupProgress({ progress, t }: { readonly progress: AssistantVoiceModelProgress | undefined; readonly t: CodingNsTranslator }): ReactElement {
  const downloading = progress?.phase === 'downloading'
  const downloaded = progress?.phase === 'initializing' || progress?.phase === 'completed'
  const percent = downloaded ? 100 : downloading && progress.totalBytes !== null && progress.totalBytes > 0 ? Math.min(100, Math.floor(progress.downloadedBytes / progress.totalBytes * 100)) : undefined
  const label = downloading ? t('voice.setup.downloadFile', { index: progress.fileIndex, count: progress.fileCount }) : progress?.phase === 'verifying' ? t('voice.models.verifying')
    : progress?.phase === 'initializing' ? t('voice.setup.initializing') : progress?.phase === 'completed' ? t('voice.setup.completed') : t('voice.setup.checking')
  const bytes = downloading ? progress.totalBytes === null ? t('voice.setup.downloadedSize', { size: formatDownloadSize(progress.downloadedBytes) }) : `${formatDownloadSize(progress.downloadedBytes)} / ${formatDownloadSize(progress.totalBytes)}` : undefined
  return createElement('div', { role: 'status', 'aria-live': 'polite', style: { display: 'grid', gap: 7, color: dshThemeColor.labelSecondary, fontSize: uiFontSize(13), lineHeight: 1.5 } },
    createElement('div', { style: rowStyle }, createElement('span', null, label), percent === undefined ? null : createElement('span', { style: { flexShrink: 0, fontVariantNumeric: 'tabular-nums' } }, downloading ? t('voice.setup.filePercent', { percent }) : '100%')),
    createElement('progress', { max: 100, ...(percent === undefined ? {} : { value: percent }), 'aria-label': downloading ? t('voice.setup.fileProgress') : label, style: { display: 'block', width: '100%', height: 10, accentColor: dshThemeColor.accent } }),
    downloading ? createElement('span', { style: { overflowWrap: 'anywhere' } }, progress.fileName) : null,
    bytes === undefined ? null : createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, bytes))
}

function formatDownloadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function button(label: string, disabled: boolean, onClick: () => void, primary = false): ReactElement {
  return createElement('button', { type: 'button', disabled, onClick, style: {
    ...(primary ? dshSettingsPrimaryButtonStyle : dshSettingsButtonStyle), whiteSpace: 'nowrap', flexShrink: 0,
    ...(disabled ? { opacity: 0.5, cursor: 'default' } : {}),
  } }, label)
}
function badge(label: string, color: string): ReactElement { return createElement('span', { style: { padding: '2px 7px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 5, fontSize: uiFontSize(11), lineHeight: 1.4, color } }, label) }
const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }
const helpStyle: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), lineHeight: 1.55 }
const noticeStyle: CSSProperties = { padding: '11px 13px', borderRadius: 8, background: dshThemeColor.surfaceSubtle, fontSize: uiFontSize(13), lineHeight: 1.55 }
