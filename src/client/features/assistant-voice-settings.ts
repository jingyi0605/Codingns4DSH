import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ASSISTANT_TTS_PARAMETER_LIMITS, ASSISTANT_VOICE_SITES, DEFAULT_ASSISTANT_TTS_PARAMETERS, MOSS_BUILTIN_VOICES, readAssistantTtsParameters, validateAssistantTtsParameters, type AssistantTtsParameters, type AssistantTtsSnapshot, type AssistantTtsVoice } from '../../shared/assistant-tts.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'
import { MossVoiceOutput } from '../moss-voice-output.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsFieldStyle, dshSettingsHelpStyle, dshThemeColor } from '../theme.js'
import type { CodingNsClientServices } from './types.js'
import { assistantSettingFieldStyle, assistantSettingTextStyle } from '../assistant-settings-styles.js'

/** 设置页和对话窗口共用独立音色编辑器，不与形象包或识别模型混合。 */
export function AssistantVoiceSettings({ services, enabled = true, active = true, embedded = false }: {
  readonly services: CodingNsClientServices; readonly enabled?: boolean; readonly active?: boolean; readonly embedded?: boolean
}): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [snapshot, setSnapshot] = useState<AssistantTtsSnapshot | undefined>()
  const [selectedId, setSelectedId] = useState('moss:Junhao')
  const [parameters, setParameters] = useState<AssistantTtsParameters>({ ...DEFAULT_ASSISTANT_TTS_PARAMETERS })
  const [siteId, setSiteId] = useState<string>('kyutai')
  const [source, setSource] = useState('')
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('unknown')
  const [gender, setGender] = useState('unknown')
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState('')
  const [writable, setWritable] = useState(() => services.settings.getSnapshot().writable)
  const alive = useRef(false)
  const pending = useRef(false)
  const reading = useRef(false)
  const abort = useRef<AbortController | undefined>()
  const player = useRef<MossVoiceOutput | undefined>()
  if (player.current === undefined) player.current = new MossVoiceOutput()
  useEffect(() => {
    // 折叠时保留导入和参数草稿，但停止合成试听。
    if (!active) player.current?.cancel()
  }, [active])
  const voices = snapshot?.voices ?? MOSS_BUILTIN_VOICES
  const selected = voices.find((voice) => voice.id === selectedId) ?? voices[0]!
  const site = ASSISTANT_VOICE_SITES.find((site) => site.id === siteId) ?? ASSISTANT_VOICE_SITES[0]!
  const disabled = !enabled || !writable || busy !== undefined || snapshot?.status.busy === true
  const ready = snapshot?.status.ready === true
  const backend = snapshot?.settings.backend ?? services.settings.getSnapshot().value?.assistant?.tts?.backend ?? 'browser'
  const moss = backend === 'moss-onnx'

  const refresh = useCallback(async (): Promise<void> => {
    if (reading.current) return
    reading.current = true
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/tts/catalog', {}, abort.current?.signal)
      if (!result.ok) throw new Error(result.error.message)
      if (alive.current) setSnapshot(result.value as AssistantTtsSnapshot)
    } catch (error) { if (alive.current) setError(message(error)) }
    finally { reading.current = false }
  }, [services.rpc])

  useEffect(() => {
    alive.current = true; abort.current = new AbortController()
    void refresh()
    const changed = (): void => { setWritable(services.settings.getSnapshot().writable); void refresh() }
    const dispose = services.settings.subscribe(changed)
    window.addEventListener('focus', changed)
    return () => { alive.current = false; abort.current?.abort(); player.current?.dispose(); dispose(); window.removeEventListener('focus', changed) }
  }, [refresh, services.settings])
  useEffect(() => { if (snapshot !== undefined) setSelectedId(snapshot.settings.selectedId) }, [snapshot?.settings.selectedId])
  useEffect(() => {
    if (snapshot !== undefined) setParameters(services.configurationDraft ? { ...DEFAULT_ASSISTANT_TTS_PARAMETERS, ...snapshot.settings.parameters } : readAssistantTtsParameters(snapshot.settings.parameters))
  }, [snapshot?.settings.parameters?.rate, snapshot?.settings.parameters?.volume, snapshot?.settings.parameters?.segmentPauseMs, snapshot?.settings.parameters?.chunkTokens, snapshot?.settings.parameters?.seed])
  useEffect(() => {
    if (busy !== 'setup' && snapshot?.status.busy !== true) return undefined
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => clearInterval(timer)
  }, [busy, snapshot?.status.busy, refresh])
  useEffect(() => { if (!enabled || !moss) player.current?.cancel() }, [enabled, moss])

  const run = async (action: string, value: Record<string, unknown>): Promise<void> => {
    if (pending.current || disabled) return
    pending.current = true; setBusy(action); setError(''); player.current?.cancel()
    try {
      const result = await services.rpc.call(CODINGNS_RPC_CHANNEL, `assistant/tts/${action}`, value, abort.current?.signal)
      if (!result.ok) throw new Error(result.error.message)
      if (alive.current) { setSnapshot(result.value as AssistantTtsSnapshot); if (action === 'import') { setSource(''); setName('') } }
      // 配置窗口重读时保留内存草稿；独立设置入口仍读取 Host 保存结果。
      if (services.settings.reload !== undefined) await services.settings.reload()
      else await services.settings.load?.()
    } catch (error) { if (alive.current) setError(message(error)) }
    finally { pending.current = false; if (alive.current) { setBusy(undefined); await refresh() } }
  }

  const preview = async (): Promise<void> => {
    if (pending.current || disabled || !active || !moss || !ready) return
    pending.current = true; setBusy('preview'); setError('')
    // 固定试听文本留在词典中，不再要求用户填写；使用当前音色和未保存的播报参数。
    try { await player.current!.speak(t('tts.defaultText'), selected.id, undefined, validateAssistantTtsParameters(parameters)) }
    catch (error) { if (alive.current) setError(message(error)) }
    finally { pending.current = false; if (alive.current) setBusy(undefined) }
  }
  const button = (label: string, action: () => void, locked = false): ReactElement => createElement('button', { type: 'button', disabled: disabled || locked, style: dshSettingsButtonStyle, onClick: action }, label)
  const field = (label: string, content: ReactElement): ReactElement => createElement('label', { style: assistantSettingFieldStyle }, createElement('span', null, label), content)
  const input = (value: string, change: (value: string) => void, maxLength = 2048): ReactElement => createElement('input', { value, disabled, maxLength, style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => change(event.currentTarget.value) })
  const options = (value: string, change: (value: string) => void, values: readonly string[]): ReactElement => createElement('select', { value, disabled, style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => change(event.currentTarget.value) },
    ...values.map((item) => createElement('option', { key: item, value: item }, t(`tts.${item}`))))
  const number = (key: keyof AssistantTtsParameters, scale = 1, slider = false): ReactElement => {
    const limits = ASSISTANT_TTS_PARAMETER_LIMITS[key]
    const value = parameters[key]
    const change = (event: { currentTarget: { value: string } }): void => {
      const raw = event.currentTarget.value
      const next = { ...parameters, [key]: raw === '' ? key === 'seed' ? null : Number.NaN : Number(raw) / scale }
      setParameters(next)
      if (services.configurationDraft) void services.settings.mutate([{ op: 'set', path: ['assistant', 'tts', 'parameters'], value: next }]).catch((cause) => setError(message(cause)))
    }
    const props = { disabled, min: limits.min * scale, max: limits.max * scale, step: limits.step * scale, onChange: change }
    return field(t(`tts.${key}`), createElement('div', { style: { display: 'grid', gridTemplateColumns: slider ? 'minmax(0, 1fr) 90px' : '1fr', gap: 10, alignItems: 'center' } },
      slider ? createElement('input', { ...props, type: 'range', 'aria-label': t(`tts.${key}`), value: value === null || !Number.isFinite(value) ? DEFAULT_ASSISTANT_TTS_PARAMETERS[key]! * scale : Number((value * scale).toFixed(4)) }) : null,
      createElement('input', { ...props, type: 'number', value: value === null || !Number.isFinite(value) ? '' : Number((value * scale).toFixed(4)),
        placeholder: key === 'seed' ? t('tts.autoSeed') : undefined, 'aria-label': t(`tts.${key}`), style: dshSettingsFieldStyle, 'data-codingns-tts-parameter': key })))
  }
  return createElement('section', { 'aria-label': t('tts.title'), 'data-codingns-voice-settings': true, style: { ...assistantSettingTextStyle, display: 'grid', gap: 12,
    ...(embedded ? {} : { borderTop: `1px solid ${dshThemeColor.border}`, paddingTop: 14 }) } },
    createElement('strong', null, t('tts.title')),
    moss ? createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('tts.description')) : null,
    field(t('tts.backend'), createElement('select', { value: backend, disabled: disabled || snapshot === undefined, style: dshSettingsFieldStyle,
      onChange: (event: { currentTarget: { value: string } }) => { void run('select', { id: selectedId, backend: event.currentTarget.value }) } },
      createElement('option', { value: 'browser' }, t('tts.browser')), createElement('option', { value: 'moss-onnx', disabled: !ready }, t('tts.moss')))),
    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, button(t(services.configurationDraft ? 'tts.prepare' : 'tts.setup'), () => { void run('setup', {}) }),
      moss ? button(t('tts.refresh'), () => { void refresh() }) : null),
    !moss && !snapshot?.status.busy && busy !== 'setup' ? null : createElement('div', { role: 'status', style: dshSettingsHelpStyle },
      snapshot?.status.busy ? snapshot.status.phase : busy === 'setup' ? t('tts.busy') : ready ? t('tts.ready') : t('tts.notReady')),
    snapshot?.status.busy ? createElement('progress', { max: snapshot.status.totalBytes ?? undefined, value: snapshot.status.totalBytes === null ? undefined : snapshot.status.downloadedBytes, style: { width: '100%' }, 'aria-label': snapshot.status.phase }) : null,
    moss ? createElement('div', { 'data-codingns-moss-voices': true, style: { display: 'grid', gap: 12 } },
      field(t('tts.selected'), createElement('select', { value: selectedId, disabled, style: dshSettingsFieldStyle, 'data-codingns-voice-list': true,
        onChange: (event: { currentTarget: { value: string } }) => {
          const id = event.currentTarget.value
          player.current?.cancel(); setSelectedId(id)
          if (services.configurationDraft) void services.settings.mutate([{ op: 'set', path: ['assistant', 'tts', 'selectedId'], value: id }]).catch((cause) => setError(message(cause)))
        } },
        ...voices.map((voice) => createElement('option', { key: voice.id, value: voice.id }, voiceLabel(voice, t))))),
      createElement('div', { style: { ...dshSettingsHelpStyle, overflowWrap: 'anywhere' } }, t('tts.license', { license: selected.license }), ' · ',
        createElement('a', { href: selected.source, target: '_blank', rel: 'noopener noreferrer' }, t('tts.sourceLink'))),
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        services.configurationDraft ? null : button(t('tts.apply'), () => { void run('select', { id: selectedId }) }, !ready),
        button(t('tts.preview'), () => { void preview() }, !ready),
        busy !== 'preview' ? null : createElement('button', { type: 'button', style: dshSettingsButtonStyle, onClick: () => player.current?.cancel() }, t('tts.stop')),
        selected.kind !== 'reference' ? null : button(t('tts.remove'), () => { void run('remove', { id: selected.id }) }))) : null,
    createElement('div', { 'data-codingns-tts-controls': true, style: { display: 'grid', gap: 12 } },
      createElement('strong', null, t('tts.playbackSettings')),
      number('rate', 1, true), number('volume', 100, true),
      moss ? createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('tts.rateHint')) : null,
      moss ? createElement('details', null, createElement('summary', { style: { cursor: 'pointer' } }, t('tts.advanced')),
        createElement('div', { style: { display: 'grid', gap: 12, marginTop: 12 } },
          createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('tts.advancedHint')),
          number('segmentPauseMs'), number('chunkTokens'), number('seed'),
          createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('tts.seedHint')))) : null,
      moss ? createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('tts.parametersHint')) : null,
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        services.configurationDraft ? null : button(t('tts.saveParameters'), () => { void run('configure', { parameters }) }, snapshot === undefined),
        button(t(services.configurationDraft ? 'tts.resetDraftParameters' : 'tts.resetParameters'), () => {
          // 浏览器模式只恢复可见的语速和音量，保留隐藏的 MOSS 高级参数。
          const next = moss ? { ...DEFAULT_ASSISTANT_TTS_PARAMETERS } : { ...parameters, rate: DEFAULT_ASSISTANT_TTS_PARAMETERS.rate, volume: DEFAULT_ASSISTANT_TTS_PARAMETERS.volume }
          setParameters(next)
          if (services.configurationDraft) void services.settings.mutate([{ op: 'set', path: ['assistant', 'tts', 'parameters'], value: next }]).catch((cause) => setError(message(cause)))
          else void run('configure', { parameters: next }) }, snapshot === undefined))),
    moss ? createElement('details', { 'data-codingns-voice-import': true }, createElement('summary', { style: { cursor: 'pointer' } }, t(services.configurationDraft ? 'tts.importDraft' : 'tts.import')),
      createElement('div', { style: { display: 'grid', gap: 12, marginTop: 12 } },
        field(t('tts.site'), createElement('select', { value: siteId, disabled, style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => setSiteId(event.currentTarget.value) },
          ...ASSISTANT_VOICE_SITES.map((site) => createElement('option', { key: site.id, value: site.id }, site.name)))),
        createElement('a', { href: site.url, target: '_blank', rel: 'noopener noreferrer', 'aria-disabled': !enabled, onClick: (event: { preventDefault: () => void }) => { if (!enabled) event.preventDefault() }, style: { ...dshSettingsButtonStyle, justifySelf: 'start', textDecoration: 'none' } }, t('tts.openSite')),
        createElement('a', { href: siteId === 'aishell' ? 'https://huggingface.co/datasets/AISHELL/AISHELL-3/tree/main/train/wav' : 'https://huggingface.co/kyutai/tts-voices/tree/main/voice-donations', target: '_blank', rel: 'noopener noreferrer', 'aria-disabled': !enabled,
          onClick: (event: { preventDefault: () => void }) => { if (!enabled) event.preventDefault() } }, t('tts.openRecordings')),
        createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t(siteId === 'aishell' ? 'tts.aishellHint' : 'tts.kyutaiHint')),
        field(t('tts.source'), input(source, setSource)), field(t('tts.name'), input(name, setName, 80)),
        field(t('tts.language'), options(language, setLanguage, ['unknown', 'zh', 'en', 'ja', 'fr'])),
        field(t('tts.gender'), options(gender, setGender, ['unknown', 'male', 'female'])),
        createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('tts.sourceHint')),
        button(t(services.configurationDraft ? 'tts.importDraft' : 'tts.import'), () => { const reference = siteId === 'aishell' && !source.includes(':') ? `aishell:${source}` : source; void run('import', { source: reference, name, language, gender }) }, !ready || source.trim() === ''))) : null,
    error || snapshot?.status.error ? createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 13, overflowWrap: 'anywhere' } }, error || snapshot?.status.error) : null)
}

export function voiceLabel(voice: AssistantTtsVoice, t: CodingNsTranslator): string {
  const language = ['zh', 'en', 'ja', 'fr', 'unknown'].includes(voice.language) ? t(`tts.${voice.language}`) : voice.language
  return `${voice.name} · ${language} · ${t(`tts.${voice.gender}`)}`
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
