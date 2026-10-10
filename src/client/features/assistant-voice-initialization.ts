import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AssistantVoiceInitializationSnapshot } from '../../shared/voice-initialization.js'
import { DEFAULT_ASSISTANT_TTS_SETTINGS, MOSS_BUILTIN_VOICES } from '../../shared/assistant-tts.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { MossVoiceOutput } from '../moss-voice-output.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshSettingsHelpStyle, dshThemeColor } from '../theme.js'
import type { CodingNsClientServices } from './types.js'
import { AssistantVoiceSettingsGroup } from './assistant-voice-settings-group.js'
import { uiFontSize } from '../font-scale.js'

/** 打开面板只检查缓存，用户点击启用后才安装；首次不展示技术参数或要求填写字段。 */
export function AssistantVoiceInitializationPanel({ services, enabled, active, inputSettings, outputSettings }: {
  readonly services: CodingNsClientServices; readonly enabled: boolean; readonly active: boolean
  readonly inputSettings: (active: boolean) => ReactNode; readonly outputSettings: (active: boolean) => ReactNode
}): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [snapshot, setSnapshot] = useState<AssistantVoiceInitializationSnapshot>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [writable, setWritable] = useState(() => services.settings.getSnapshot().writable)
  const mounted = useRef(false); const submitting = useRef(false); const reading = useRef(false)
  const revision = useRef(0); const abort = useRef<AbortController>()
  const player = useRef<MossVoiceOutput>()
  if (player.current === undefined) player.current = new MossVoiceOutput()
  const refresh = useCallback(async (): Promise<void> => {
    if (reading.current) return
    reading.current = true
    const current = revision.current
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/initialization', {}, abort.current?.signal)
      if (!result.ok) throw new Error(result.error.message)
      if (mounted.current && current === revision.current) { setSnapshot(result.value as AssistantVoiceInitializationSnapshot); setError('') }
    } catch (cause) { if (mounted.current && current === revision.current) setError(message(cause)) }
    finally { reading.current = false }
  }, [services.rpc])
  useEffect(() => {
    mounted.current = true; abort.current = new AbortController()
    const dispose = services.settings.subscribe(() => { setWritable(services.settings.getSnapshot().writable); void refresh() })
    return () => { mounted.current = false; revision.current++; abort.current?.abort(); player.current?.dispose(); dispose() }
  }, [services.settings, refresh])
  useEffect(() => {
    if (!active && !pending && !snapshot?.busy) return undefined
    void refresh()
    const timer = setInterval(() => { void refresh() }, pending || snapshot?.busy ? 1000 : 5000)
    return () => clearInterval(timer)
  }, [active, pending, snapshot?.busy, refresh])
  useEffect(() => { if (!active || !enabled) { player.current?.cancel(); setSpeaking(false) } }, [active, enabled])

  const initialize = async (): Promise<void> => {
    if (submitting.current || !enabled || !writable || snapshot === undefined || snapshot.busy) return
    submitting.current = true; revision.current++; setPending(true); setError(''); player.current?.cancel(); setSpeaking(false)
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/initialize', {}, abort.current?.signal)
      if (!result.ok) throw new Error(result.error.message)
      revision.current++
      if (mounted.current) setSnapshot(result.value as AssistantVoiceInitializationSnapshot)
      // 配置窗口保留待保存的模型与后端；独立入口重读 Host 保存结果。
      if (services.settings.reload !== undefined) await services.settings.reload()
      else await services.settings.load?.()
    } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { submitting.current = false; if (mounted.current) setPending(false) }
  }
  const listen = async (): Promise<void> => {
    if (speaking) { player.current?.cancel(); setSpeaking(false); return }
    if (!enabled || !writable || !snapshot?.ready) return
    setSpeaking(true); setError('')
    try { await player.current!.speak(t('tts.defaultText'), snapshot.tts.settings.selectedId, undefined, snapshot.tts.settings.parameters) }
    catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { if (mounted.current) setSpeaking(false) }
  }
  return createElement('div', { style: { display: 'grid', gap: 18 } },
    createElement(AssistantVoiceInitializationView, { snapshot, pending, error, disabled: !enabled || !writable, speaking, draft: services.configurationDraft === true, t,
      onInitialize: () => { void initialize() }, onListen: () => { void listen() }, onRefresh: () => { void refresh() } }),
    createElement(AssistantVoiceSettingsGroup, { kind: 'input', hint: snapshot?.modelLabel ?? t('voice.settings.inputDescription'),
      active, disabled: !enabled || !writable || pending || snapshot?.busy === true, t, renderContent: inputSettings }),
    createElement(AssistantVoiceSettingsGroup, { kind: 'output', hint: snapshot?.tts.settings.backend === 'browser' ? t('tts.browser')
      : snapshot?.tts.voices.find((voice) => voice.id === snapshot.tts.settings.selectedId)?.name ?? t('voice.settings.outputDescription'),
      active, disabled: !enabled || !writable || pending || snapshot?.busy === true, t, renderContent: outputSettings }))
}

/** 纯展示层覆盖未配置、准备中、失败与完成四态，重试仍只有一个入口。 */
export function AssistantVoiceInitializationView({ snapshot, pending, error, disabled, speaking, draft = false, t, onInitialize, onListen, onRefresh }: {
  readonly snapshot: AssistantVoiceInitializationSnapshot | undefined; readonly pending: boolean; readonly error: string
  readonly disabled: boolean; readonly speaking: boolean; readonly t: CodingNsTranslator
  readonly draft?: boolean
  readonly onInitialize: () => void; readonly onListen: () => void; readonly onRefresh: () => void
}): ReactElement {
  const busy = pending || snapshot?.busy === true
  const ready = snapshot?.ready === true
  const failure = error || snapshot?.error
  const voice = snapshot?.tts.voices.find((voice) => voice.id === snapshot.tts.settings.selectedId)
  const label = busy ? t(snapshot?.phase === 'speech' || snapshot?.tts.status.busy ? 'tts.wizardSpeech' : 'tts.wizardRecognition')
    : ready ? t(draft ? 'tts.wizardDraftReady' : 'tts.wizardReady') : snapshot === undefined ? t('tts.wizardChecking') : t('tts.wizardDescription')
  const progress = snapshot?.progress
  const value = busy && progress?.totalBytes != null && progress.totalBytes > 0 ? Math.min(progress.downloadedBytes, progress.totalBytes) : undefined
  return createElement('section', { 'data-codingns-voice-initialization': ready ? 'ready' : busy ? 'preparing' : failure ? 'failed' : 'initial',
    'aria-label': t('tts.wizardTitle'), style: { display: 'grid', gap: 12, padding: 18, borderRadius: 12,
      border: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.surfaceSubtle } },
    createElement('strong', null, t(ready ? 'tts.wizardReady' : 'tts.wizardTitle')),
    createElement('p', { role: 'status', 'aria-live': 'polite', style: { ...dshSettingsHelpStyle, margin: 0 } }, label),
    ready ? null : createElement('div', { style: { display: 'grid', gap: 5, fontSize: uiFontSize(13), overflowWrap: 'anywhere' } },
      createElement('span', null, t('tts.wizardModel', { model: snapshot?.modelId === 'custom' ? t('voice.models.custom') : snapshot?.modelLabel ?? t('tts.wizardDefault') })),
      createElement('span', null, t('tts.wizardVoice', { voice: voice?.name ?? MOSS_BUILTIN_VOICES.find((item) => item.id === DEFAULT_ASSISTANT_TTS_SETTINGS.selectedId)?.name ?? 'Yuewen' }))),
    busy ? createElement('div', { style: { display: 'grid', gap: 6 } },
      createElement('progress', { max: progress?.totalBytes ?? 1, ...(value === undefined ? {} : { value }), 'aria-label': label, style: { width: '100%' } }),
      snapshot?.phase !== 'speech' || progress === null || progress === undefined ? null : createElement('small', { style: dshSettingsHelpStyle }, progress.label)) : null,
    ready ? null : createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('tts.wizardHint')),
    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      createElement('button', { type: 'button', disabled: disabled || busy || snapshot === undefined,
        onClick: ready ? onListen : onInitialize, style: dshSettingsPrimaryButtonStyle },
      t(ready ? speaking ? 'tts.stop' : 'tts.wizardListen' : busy ? 'tts.wizardPreparing' : failure ? 'tts.wizardRetry' : draft ? 'tts.wizardPrepareResources' : 'tts.wizardEnable')),
      snapshot !== undefined && !failure ? null : createElement('button', { type: 'button', disabled: busy, onClick: onRefresh, style: dshSettingsButtonStyle }, t('tts.refresh'))),
    failure ? createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: uiFontSize(13), overflowWrap: 'anywhere' } }, failure) : null)
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
