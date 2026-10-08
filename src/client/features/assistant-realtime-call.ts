import { createElement, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { AssistantToolCall, AssistantVoiceSession } from '../../shared/contracts/assistant.js'
import { voiceSessionDuration, voiceSessionMessageCount } from '../../shared/assistant-voice-sessions.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { resolveAssistantAvatarState } from '../../shared/assistant-avatar.js'
import type { CodingNsTranslator } from '../locale.js'
import { getGlobalVoiceAdapter } from '../global-voice-runtime-registry.js'
import { dshSettingsButtonStyle, dshSettingsFieldStyle, dshThemeColor } from '../theme.js'
import { AssistantAvatarSlot } from '../avatar/slot.js'
import type { CodingNsClientServices } from './types.js'
import { AssistantConversationMessageView, AssistantMessageContentView } from './assistant-conversation-message.js'
import { AssistantRecordChevron, AssistantRecordStyle } from './assistant-record-style.js'

interface RealtimeCallProps {
  readonly services: CodingNsClientServices; readonly name: string; readonly model: AssistantAvatarModel
  readonly t: CodingNsTranslator; readonly session?: AssistantVoiceSession | undefined
  readonly pending: boolean; readonly state?: string | undefined
  readonly minimized?: boolean | undefined; readonly startedAt?: number | undefined; readonly onMinimize?: (() => void) | undefined
  readonly userText: string; readonly assistantText: string; readonly onHangup: () => void | Promise<void>
  readonly toolCalls?: readonly AssistantToolCall[] | undefined
}

/** 通话页只控制当前 Client 的采集和播放设备，不重新初始化模型或申请第二份租约。 */
export function AssistantRealtimeCall(props: RealtimeCallProps): ReactElement {
  const adapter = getGlobalVoiceAdapter(props.services)
  const [microphoneMuted, setMicrophoneMuted] = useState(adapter?.isMicrophoneMuted ?? false)
  const [speakerMuted, setSpeakerMuted] = useState(adapter?.isSpeakerMuted ?? false)
  const [speakersOpen, setSpeakersOpen] = useState(false)
  const [devices, setDevices] = useState<readonly { deviceId: string; label: string }[]>([])
  const [outputId, setOutputId] = useState(adapter?.outputDeviceId ?? '')
  const [devicePending, setDevicePending] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  const startedAt = useRef(Date.now())
  const menuId = useId()
  useEffect(() => {
    if (props.minimized) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [props.minimized])
  useEffect(() => {
    if (!speakersOpen || !adapter?.outputDeviceSupported) return undefined
    let active = true
    void adapter.enumerateOutputDevices().then((items) => { if (active) setDevices(items) }).catch((cause) => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [adapter, speakersOpen])
  const duration = voiceSessionDuration(props.startedAt === undefined ? props.session ?? { startedAt: startedAt.current, endedAt: null }
    : { startedAt: props.startedAt, endedAt: null }, now)
  const menu = !speakersOpen ? null : createElement('div', { id: menuId, role: 'group', 'aria-label': props.t('awb.call.speakerSettings'),
    style: { display: 'grid', gap: 12, position: 'absolute', bottom: 86, left: '50%', transform: 'translateX(-50%)', zIndex: 2,
      width: 'min(300px, calc(100vw - 80px))', padding: 16, boxSizing: 'border-box', borderRadius: 14,
      border: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.prominentShadow },
    onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setSpeakersOpen(false) } } },
    createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 9, fontSize: 13 } },
      createElement('input', { type: 'checkbox', checked: !speakerMuted, disabled: adapter?.setSpeakerMuted === undefined,
        onChange: () => { const muted = !speakerMuted; adapter?.setSpeakerMuted?.(muted); setSpeakerMuted(muted) } }), props.t('awb.call.playSound')),
    createElement('label', { style: { display: 'grid', gap: 6, fontSize: 12 } }, props.t('awb.call.outputDevice'),
      createElement('select', { value: adapter?.outputDeviceSupported ? outputId : '', disabled: !adapter?.outputDeviceSupported || devicePending,
        style: { ...dshSettingsFieldStyle, width: '100%', minWidth: 0 }, onChange: (event: { currentTarget: { value: string } }) => {
          const id = event.currentTarget.value; setDevicePending(true); setError('')
          void adapter?.selectOutputDevice(id).then(() => setOutputId(id)).catch((cause) => setError(String(cause))).finally(() => setDevicePending(false))
        } }, createElement('option', { value: '' }, props.t('awb.call.defaultSpeaker')),
        adapter?.outputDeviceSupported && outputId && !devices.some((device) => device.deviceId === outputId) ? createElement('option', { value: outputId }, props.t('awb.call.speaker')) : null,
        ...devices.filter((device) => device.deviceId !== '').map((device) => createElement('option', { key: device.deviceId, value: device.deviceId }, device.label || props.t('awb.call.speaker'))))),
    error ? createElement('div', { role: 'alert', style: { fontSize: 12, color: dshThemeColor.error, overflowWrap: 'anywhere' } }, error) : null)
  return createElement(AssistantRealtimeCallView, { ...props, duration, microphoneMuted, speakerMuted,
    microphoneAvailable: adapter?.setMicrophoneMuted !== undefined,
    // 隐藏窗口时卸载动画形象，避免与悬浮形象同时消耗渲染资源；音频运行时不受影响。
    avatar: props.minimized ? null : createElement(AssistantAvatarSlot, { services: props.services, model: props.model, state: resolveAssistantAvatarState(props.state, props.pending), surface: 'dialog', size: 256, showDiagnostics: false }),
    onMicrophone: () => { const muted = !microphoneMuted; adapter?.setMicrophoneMuted?.(muted); setMicrophoneMuted(muted) },
    onSpeaker: () => setSpeakersOpen((open) => !open), speakersOpen, menuId, menu })
}

/** 纯展示层可独立渲染明暗主题与移动端，不需要真实音频设备。 */
export function AssistantRealtimeCallView({ name, t, state, pending, duration, minimized = false, microphoneMuted, speakerMuted, microphoneAvailable = true,
  userText, assistantText, toolCalls, avatar, onMicrophone, onSpeaker, onHangup, onMinimize, speakersOpen = false, menuId, menu }: {
  readonly name: string; readonly t: CodingNsTranslator; readonly state?: string | undefined; readonly pending: boolean; readonly duration: string
  readonly minimized?: boolean | undefined
  readonly microphoneMuted: boolean; readonly speakerMuted: boolean; readonly microphoneAvailable?: boolean
  readonly userText: string; readonly assistantText: string; readonly avatar: ReactNode
  readonly toolCalls?: readonly AssistantToolCall[] | undefined
  readonly onMicrophone: () => void; readonly onSpeaker: () => void; readonly onHangup: () => void | Promise<void>
  readonly onMinimize?: (() => void) | undefined
  readonly speakersOpen?: boolean; readonly menuId?: string | undefined; readonly menu?: ReactNode
}): ReactElement {
  const captions = useRef<HTMLDivElement>(null)
  const followCaptions = useRef(true)
  const toolState = toolCalls?.map((call) => `${call.id}:${call.state}`).join('|')
  // 默认跟随流式追加；用户向上回看时保留位置，不再把前文强制滚走。
  useEffect(() => {
    if (minimized) return
    const element = captions.current
    if (assistantText === '') followCaptions.current = true
    if (element !== null && followCaptions.current) element.scrollTop = element.scrollHeight
  }, [userText, assistantText, toolState, minimized])
  const status = pending ? state === 'disabled' ? 'ending' : 'connecting' : microphoneMuted ? 'muted' : state === 'speaking' ? 'speaking' : state === 'thinking' ? 'thinking' : 'listening'
  const control = (kind: 'speaker' | 'microphone' | 'hangup', label: string, action: () => void, pressed?: boolean): ReactElement => createElement('div', { style: { display: 'grid', justifyItems: 'center', gap: 8 } },
    createElement('button', { type: 'button', 'aria-label': label, title: label, 'aria-pressed': pressed,
      ...(kind === 'speaker' ? { 'aria-expanded': speakersOpen, 'aria-controls': menuId } : {}), disabled: kind === 'microphone' && (pending || !microphoneAvailable),
      onClick: action, style: { ...dshSettingsButtonStyle, display: 'grid', placeItems: 'center', width: 58, height: 58, padding: 0, borderRadius: '50%',
        ...(kind === 'hangup' ? { background: '#e64949', color: '#fff', borderColor: '#e64949' } : pressed ? { background: dshThemeColor.labelPrimary, color: dshThemeColor.pageBackground } : {}) } },
      createElement(CallIcon, { kind, muted: pressed === true })),
    createElement('span', { style: { fontSize: 12, color: dshThemeColor.labelSecondary } }, kind === 'microphone' ? t(microphoneMuted ? 'awb.call.unmute' : 'awb.call.microphone') : t(`awb.call.${kind}`)))
  return createElement('div', { 'data-codingns-realtime-call': true, style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, textAlign: 'center', padding: 11, gap: 10 } },
    createElement('style', null, '.codingns-call-halo{position:absolute;inset:10%;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-button-info-fill,#1677ff) 14%,transparent),transparent 70%);animation:codingns-call-breathe 3s ease-in-out infinite}.codingns-call-caption{overflow-wrap:anywhere;white-space:pre-wrap}[data-codingns-call-avatar] img{height:auto!important;max-height:32dvh;object-fit:contain}[data-codingns-call-avatar] canvas,[data-codingns-call-avatar] video{max-width:100%;max-height:32dvh;object-fit:contain}@keyframes codingns-call-breathe{50%{transform:scale(1.12);opacity:.6}}@media(prefers-reduced-motion:reduce){.codingns-call-halo{animation:none}}'),
    createElement('div', { style: { position: 'relative', paddingInline: onMinimize ? 44 : 0, minHeight: 40, display: 'grid', gap: 4 } },
      createElement('strong', { style: { fontSize: 18, overflowWrap: 'anywhere' } }, name),
      createElement('span', { style: { fontSize: 12, color: dshThemeColor.labelTertiary, fontVariantNumeric: 'tabular-nums' } }, t('awb.call.title'), ' · ', duration),
      onMinimize ? createElement('button', { type: 'button', 'aria-label': t('awb.call.minimize'), title: t('awb.call.minimize'), onClick: onMinimize,
        style: { ...dshSettingsButtonStyle, position: 'absolute', right: 0, top: 0, width: 40, height: 40, display: 'grid', placeItems: 'center', padding: 0, borderRadius: 12 } },
        createElement('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true }, createElement('path', { d: 'M5 15h14M9 6l3 3 3-3' }))) : null),
    createElement('div', { style: { display: 'grid', placeItems: 'center', flex: '1 1 auto', minHeight: 'min(160px, 24dvh)', position: 'relative' } },
      createElement('div', { className: 'codingns-call-halo', 'aria-hidden': true }), createElement('div', { 'data-codingns-call-avatar': true, style: { position: 'relative', width: 'min(256px, 32dvh, 100%)', maxWidth: '100%', maxHeight: '32dvh', overflow: 'hidden', display: 'grid', placeItems: 'center' } }, avatar)),
    createElement('div', { role: 'status', style: { fontSize: 13, color: dshThemeColor.labelSecondary } }, t(`awb.call.${status}`)),
    createElement('div', { ref: captions, 'data-codingns-call-captions': true, 'aria-label': t('awb.call.caption'), tabIndex: 0,
      onScroll: (event: { currentTarget: HTMLDivElement }) => { const element = event.currentTarget; followCaptions.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24 },
      style: { minHeight: 90, maxHeight: 'min(280px, 35dvh)', overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 } },
      userText && !microphoneMuted ? createElement('p', { className: 'codingns-call-caption', style: { margin: 0, flexShrink: 0, fontSize: 13, lineHeight: 1.6, color: dshThemeColor.labelTertiary } }, userText) : null,
      createElement('div', { 'aria-live': 'polite', style: { flexShrink: 0, display: 'grid', gap: 8, fontSize: 16, lineHeight: 1.65, color: assistantText ? dshThemeColor.labelPrimary : dshThemeColor.labelTertiary } },
        assistantText || toolCalls?.length ? createElement(AssistantMessageContentView, { text: assistantText, calls: toolCalls, t }) : !userText ? t('awb.call.waiting') : '')),
    createElement('div', { style: { display: 'flex', justifyContent: 'center', gap: 'clamp(20px, 6vw, 44px)', padding: '12px 0 4px', position: 'relative' } }, menu,
      control('speaker', t('awb.call.speakerSettings'), onSpeaker, speakerMuted),
      control('microphone', t(microphoneMuted ? 'awb.call.unmute' : 'awb.call.microphone'), onMicrophone, microphoneMuted),
      control('hangup', t('awb.call.hangup'), () => { void onHangup() })))
}

function CallIcon({ kind, muted = false, size = 24 }: { readonly kind: 'speaker' | 'microphone' | 'hangup'; readonly muted?: boolean; readonly size?: number }): ReactElement {
  const path = kind === 'speaker' ? 'M11 5 6 9H3v6h3l5 4V5Zm4 3a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14' : kind === 'microphone'
    ? 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5Zm-3 5v1a6 6 0 0 0 12 0v-1M12 17v4m-4 0h8'
    : 'M3 14v3h4v-3l2-1a15 15 0 0 1 6 0l2 1v3h4v-3c-2-5-16-5-18 0Z'
  return createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    createElement('path', { d: path }), muted ? createElement('path', { d: 'M3 3 21 21' }) : null)
}

interface VoiceSessionDisplayProps {
  readonly session: AssistantVoiceSession; readonly t: CodingNsTranslator; readonly name: string
  readonly services?: CodingNsClientServices | undefined; readonly model?: AssistantAvatarModel | undefined
}

export function AssistantVoiceSessionCard({ session, t, name, services, model }: VoiceSessionDisplayProps): ReactElement {
  const [open, setOpen] = useState(false)
  const startedAt = new Date(session.startedAt)
  return createElement('div', { 'data-codingns-voice-session-card': session.id },
    createElement(AssistantRecordStyle),
    createElement('button', { type: 'button', className: 'codingns-assistant-record-button', 'aria-haspopup': 'dialog', onClick: () => setOpen(true),
      style: { ...dshSettingsButtonStyle, textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px', borderRadius: 10, background: dshThemeColor.surfaceSubtle, minWidth: 0 } },
      createElement('span', { style: { display: 'grid', placeItems: 'center', width: 32, height: 32, borderRadius: 9, flexShrink: 0,
        background: `color-mix(in srgb, ${dshThemeColor.accent} 9%, transparent)`, color: dshThemeColor.accent } }, createElement(CallIcon, { kind: 'speaker', size: 18 })),
      createElement('span', { style: { flex: '1 1 auto', display: 'grid', gap: 3, minWidth: 0 } },
        createElement('strong', { style: { fontSize: 13, fontWeight: 600 } }, t('awb.call.record')),
        createElement('span', { style: { fontSize: 11, color: dshThemeColor.labelSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          t('awb.call.count', { count: voiceSessionMessageCount(session) }), ' · ',
          createElement('time', { dateTime: Number.isNaN(startedAt.valueOf()) ? undefined : startedAt.toISOString(), title: startedAt.toLocaleString() },
            startedAt.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })))),
      createElement('span', { title: t('awb.call.duration'), 'aria-label': `${t('awb.call.duration')} ${voiceSessionDuration(session)}`,
        style: { padding: '3px 7px', borderRadius: 6, background: dshThemeColor.cardBackground, color: dshThemeColor.labelSecondary,
          fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0 } }, voiceSessionDuration(session)),
      createElement(AssistantRecordChevron)),
    open ? createElement(VoiceSessionModal, { session, t, name, services, model, onClose: () => setOpen(false) }) : null)
}

function VoiceSessionModal({ onClose, ...props }: VoiceSessionDisplayProps & { readonly onClose: () => void }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return createElement('dialog', { ref: dialog, className: 'codingns-assistant-voice-dialog', 'aria-labelledby': titleId, onCancel: (event: { preventDefault(): void; stopPropagation(): void }) => { event.preventDefault(); event.stopPropagation(); onClose() },
    onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } },
    style: { width: 'min(680px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 24px)', boxSizing: 'border-box', padding: 11, borderRadius: 12, border: `1px solid ${dshThemeColor.border}`,
      background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary, boxShadow: dshThemeColor.prominentShadow, overflow: 'hidden' } },
    createElement(AssistantRecordStyle),
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexShrink: 0 } },
      createElement('strong', { id: titleId, style: { flex: 1, fontSize: 14 } }, props.t('awb.call.details')),
      createElement('button', { type: 'button', className: 'codingns-assistant-record-button', autoFocus: true, onClick: onClose,
        title: props.t('awb.close'), 'aria-label': props.t('awb.close'),
        style: { ...dshSettingsButtonStyle, width: 32, height: 32, minHeight: 32, padding: 0, border: 0, borderRadius: 8,
          display: 'grid', placeItems: 'center', flexShrink: 0, color: dshThemeColor.labelSecondary } },
        createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
          strokeLinecap: 'round', 'aria-hidden': true }, createElement('path', { d: 'm6 6 12 12M6 18 18 6' })))),
    // 标题与关闭按钮留在滚动区外；记录容器可收缩，长对话只在内部滚动。
    createElement('div', { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin' } },
      createElement(AssistantVoiceSessionDetailsView, props)))
}

export function AssistantVoiceSessionDetailsView({ session, t, name, services, model }: VoiceSessionDisplayProps): ReactElement {
  const date = (value: number | null): string => value === null ? '—' : new Date(value).toLocaleString()
  const statistic: CSSProperties = { display: 'inline-flex', alignItems: 'center', padding: '2px 7px', borderRadius: 5,
    background: dshThemeColor.cardBackground, color: dshThemeColor.labelPrimary, fontSize: 11, fontVariantNumeric: 'tabular-nums' }
  return createElement('div', { style: { display: 'grid', gap: 8, minWidth: 0 } },
    createElement('div', { style: { padding: '10px 12px', borderRadius: 9, background: dshThemeColor.surfaceSubtle,
      display: 'grid', gap: 8, color: dshThemeColor.labelSecondary, fontSize: 11, lineHeight: 1.5, minWidth: 0 } },
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        createElement('span', { style: statistic }, t('awb.call.count', { count: voiceSessionMessageCount(session) })),
        createElement('span', { style: statistic }, t('awb.call.duration'), ' ', voiceSessionDuration(session))),
      createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '4px 16px', minWidth: 0 } },
        ...([[t('awb.call.startedAt'), session.startedAt], [t('awb.call.endedAt'), session.endedAt]] as const).map(([label, value]) =>
          createElement('span', { key: label, style: { overflowWrap: 'anywhere' } }, label, ' ',
            createElement('span', { style: { color: dshThemeColor.labelPrimary, fontVariantNumeric: 'tabular-nums' } }, date(value)))))),
    session.messages.length === 0 ? createElement('p', { style: { margin: '8px 0', fontSize: 13, color: dshThemeColor.labelSecondary } }, t('awb.call.noMessages')) : null,
    ...session.messages.map((message) => createElement(AssistantConversationMessageView, { key: message.id, message, name, t, services, model,
      side: message.role === 'user' ? 'right' : 'left' })))
}
