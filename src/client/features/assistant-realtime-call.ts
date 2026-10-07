import { createElement, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { AssistantVoiceSession } from '../../shared/contracts/assistant.js'
import { voiceSessionDuration, voiceSessionMessageCount } from '../../shared/assistant-voice-sessions.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { resolveAssistantAvatarState } from '../../shared/assistant-avatar.js'
import type { CodingNsTranslator } from '../locale.js'
import { getGlobalVoiceAdapter } from '../global-voice-runtime-registry.js'
import { dshSettingsButtonStyle, dshSettingsFieldStyle, dshThemeColor } from '../theme.js'
import { AssistantAvatarSlot } from '../avatar/slot.js'
import type { CodingNsClientServices } from './types.js'
import { AssistantConversationMessageView } from './assistant-conversation-message.js'

interface RealtimeCallProps {
  readonly services: CodingNsClientServices; readonly name: string; readonly model: AssistantAvatarModel
  readonly t: CodingNsTranslator; readonly session?: AssistantVoiceSession | undefined
  readonly pending: boolean; readonly state?: string | undefined
  readonly userText: string; readonly assistantText: string; readonly onHangup: () => void | Promise<void>
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
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    if (!speakersOpen || !adapter?.outputDeviceSupported) return undefined
    let active = true
    void adapter.enumerateOutputDevices().then((items) => { if (active) setDevices(items) }).catch((cause) => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [adapter, speakersOpen])
  const duration = voiceSessionDuration(props.session ?? { startedAt: startedAt.current, endedAt: null }, now)
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
    avatar: createElement(AssistantAvatarSlot, { services: props.services, model: props.model, state: resolveAssistantAvatarState(props.state, props.pending), surface: 'dialog', size: 256, showDiagnostics: false }),
    onMicrophone: () => { const muted = !microphoneMuted; adapter?.setMicrophoneMuted?.(muted); setMicrophoneMuted(muted) },
    onSpeaker: () => setSpeakersOpen((open) => !open), speakersOpen, menuId, menu })
}

/** 纯展示层可独立渲染明暗主题与移动端，不需要真实音频设备。 */
export function AssistantRealtimeCallView({ name, t, state, pending, duration, microphoneMuted, speakerMuted, microphoneAvailable = true,
  userText, assistantText, avatar, onMicrophone, onSpeaker, onHangup, speakersOpen = false, menuId, menu }: {
  readonly name: string; readonly t: CodingNsTranslator; readonly state?: string | undefined; readonly pending: boolean; readonly duration: string
  readonly microphoneMuted: boolean; readonly speakerMuted: boolean; readonly microphoneAvailable?: boolean
  readonly userText: string; readonly assistantText: string; readonly avatar: ReactNode
  readonly onMicrophone: () => void; readonly onSpeaker: () => void; readonly onHangup: () => void | Promise<void>
  readonly speakersOpen?: boolean; readonly menuId?: string | undefined; readonly menu?: ReactNode
}): ReactElement {
  const userCaption = useRef<HTMLParagraphElement>(null)
  const assistantCaption = useRef<HTMLParagraphElement>(null)
  // 保留完整流式文本，滚动到最新一行；长回复不会一直停在开头。
  useEffect(() => { for (const ref of [userCaption, assistantCaption]) if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [userText, assistantText])
  const status = pending ? state === 'disabled' ? 'ending' : 'connecting' : microphoneMuted ? 'muted' : state === 'speaking' ? 'speaking' : state === 'thinking' ? 'thinking' : 'listening'
  const control = (kind: 'speaker' | 'microphone' | 'hangup', label: string, action: () => void, pressed?: boolean): ReactElement => createElement('div', { style: { display: 'grid', justifyItems: 'center', gap: 8 } },
    createElement('button', { type: 'button', 'aria-label': label, title: label, 'aria-pressed': pressed,
      ...(kind === 'speaker' ? { 'aria-expanded': speakersOpen, 'aria-controls': menuId } : {}), disabled: kind === 'microphone' && (pending || !microphoneAvailable),
      onClick: action, style: { ...dshSettingsButtonStyle, display: 'grid', placeItems: 'center', width: 58, height: 58, padding: 0, borderRadius: '50%',
        ...(kind === 'hangup' ? { background: '#e64949', color: '#fff', borderColor: '#e64949' } : pressed ? { background: dshThemeColor.labelPrimary, color: dshThemeColor.pageBackground } : {}) } },
      createElement(CallIcon, { kind, muted: pressed === true })),
    createElement('span', { style: { fontSize: 12, color: dshThemeColor.labelSecondary } }, kind === 'microphone' ? t(microphoneMuted ? 'awb.call.unmute' : 'awb.call.microphone') : t(`awb.call.${kind}`)))
  return createElement('div', { 'data-codingns-realtime-call': true, style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, textAlign: 'center', padding: '16px clamp(16px, 4vw, 32px)', gap: 10 } },
    createElement('style', null, '.codingns-call-halo{position:absolute;inset:10%;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-button-info-fill,#1677ff) 14%,transparent),transparent 70%);animation:codingns-call-breathe 3s ease-in-out infinite}.codingns-call-caption{overflow-y:auto;overflow-wrap:anywhere;scrollbar-width:none;white-space:pre-wrap}[data-codingns-call-avatar] img{height:auto!important;max-height:32dvh;object-fit:contain}[data-codingns-call-avatar] canvas,[data-codingns-call-avatar] video{max-width:100%;max-height:32dvh;object-fit:contain}@keyframes codingns-call-breathe{50%{transform:scale(1.12);opacity:.6}}@media(prefers-reduced-motion:reduce){.codingns-call-halo{animation:none}}'),
    createElement('div', { style: { display: 'grid', gap: 4 } }, createElement('strong', { style: { fontSize: 18 } }, name),
      createElement('span', { style: { fontSize: 12, color: dshThemeColor.labelTertiary, fontVariantNumeric: 'tabular-nums' } }, t('awb.call.title'), ' · ', duration)),
    createElement('div', { style: { display: 'grid', placeItems: 'center', flex: '1 1 auto', minHeight: 'min(160px, 24dvh)', position: 'relative' } },
      createElement('div', { className: 'codingns-call-halo', 'aria-hidden': true }), createElement('div', { 'data-codingns-call-avatar': true, style: { position: 'relative', width: 'min(256px, 32dvh, 100%)', maxWidth: '100%', maxHeight: '32dvh', overflow: 'hidden', display: 'grid', placeItems: 'center' } }, avatar)),
    createElement('div', { role: 'status', style: { fontSize: 13, color: dshThemeColor.labelSecondary } }, t(`awb.call.${status}`)),
    createElement('div', { 'data-codingns-call-captions': true, 'aria-label': t('awb.call.caption'), style: { minHeight: 90, display: 'grid', alignContent: 'end', gap: 8 } },
      userText && !microphoneMuted ? createElement('p', { ref: userCaption, className: 'codingns-call-caption', style: { margin: 0, maxHeight: '1.6em', fontSize: 13, lineHeight: 1.6, color: dshThemeColor.labelTertiary } }, userText) : null,
      createElement('p', { ref: assistantCaption, className: 'codingns-call-caption', 'aria-live': 'polite', style: { margin: 0, maxHeight: '3.3em', fontSize: 16, lineHeight: 1.65, color: assistantText ? dshThemeColor.labelPrimary : dshThemeColor.labelTertiary } }, assistantText || (!userText ? t('awb.call.waiting') : ''))),
    createElement('div', { style: { display: 'flex', justifyContent: 'center', gap: 'clamp(20px, 6vw, 44px)', padding: '12px 0 4px', position: 'relative' } }, menu,
      control('speaker', t('awb.call.speakerSettings'), onSpeaker, speakerMuted),
      control('microphone', t(microphoneMuted ? 'awb.call.unmute' : 'awb.call.microphone'), onMicrophone, microphoneMuted),
      control('hangup', t('awb.call.hangup'), () => { void onHangup() })))
}

function CallIcon({ kind, muted = false }: { readonly kind: 'speaker' | 'microphone' | 'hangup'; readonly muted?: boolean }): ReactElement {
  const path = kind === 'speaker' ? 'M11 5 6 9H3v6h3l5 4V5Zm4 3a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14' : kind === 'microphone'
    ? 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5Zm-3 5v1a6 6 0 0 0 12 0v-1M12 17v4m-4 0h8'
    : 'M3 14v3h4v-3l2-1a15 15 0 0 1 6 0l2 1v3h4v-3c-2-5-16-5-18 0Z'
  return createElement('svg', { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    createElement('path', { d: path }), muted ? createElement('path', { d: 'M3 3 21 21' }) : null)
}

interface VoiceSessionDisplayProps {
  readonly session: AssistantVoiceSession; readonly t: CodingNsTranslator; readonly name: string
  readonly services?: CodingNsClientServices | undefined; readonly model?: AssistantAvatarModel | undefined
}

export function AssistantVoiceSessionCard({ session, t, name, services, model }: VoiceSessionDisplayProps): ReactElement {
  const [open, setOpen] = useState(false)
  return createElement('div', { 'data-codingns-voice-session-card': session.id },
    createElement('button', { type: 'button', 'aria-haspopup': 'dialog', onClick: () => setOpen(true), style: { ...dshSettingsButtonStyle, textAlign: 'left', width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: 16, borderRadius: 16 } },
      createElement(CallIcon, { kind: 'speaker' }), createElement('span', { style: { flex: 1, display: 'grid', gap: 5 } },
        createElement('strong', { style: { fontSize: 14 } }, t('awb.call.record')),
        createElement('span', { style: { fontSize: 12, color: dshThemeColor.labelSecondary } }, t('awb.call.count', { count: voiceSessionMessageCount(session) }), ' · ', voiceSessionDuration(session))),
      createElement('span', { 'aria-hidden': true, style: { fontSize: 20, color: dshThemeColor.labelTertiary } }, '›')),
    open ? createElement(VoiceSessionModal, { session, t, name, services, model, onClose: () => setOpen(false) }) : null)
}

function VoiceSessionModal({ onClose, ...props }: VoiceSessionDisplayProps & { readonly onClose: () => void }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  return createElement('dialog', { ref: dialog, 'aria-label': props.t('awb.call.details'), onCancel: (event: { preventDefault(): void; stopPropagation(): void }) => { event.preventDefault(); event.stopPropagation(); onClose() },
    onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } },
    style: { width: 'min(680px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)', boxSizing: 'border-box', padding: 24, borderRadius: 18, border: `1px solid ${dshThemeColor.border}`,
      background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary, overflowY: 'auto' } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 } }, createElement('strong', { style: { flex: 1 } }, props.t('awb.call.details')),
      createElement('button', { type: 'button', autoFocus: true, onClick: onClose, style: dshSettingsButtonStyle }, props.t('awb.close'))),
    createElement(AssistantVoiceSessionDetailsView, props))
}

export function AssistantVoiceSessionDetailsView({ session, t, name, services, model }: VoiceSessionDisplayProps): ReactElement {
  const calls = session.messages.flatMap((message) => message.toolCalls ?? [])
  const date = (value: number | null): string => value === null ? '—' : new Date(value).toLocaleString()
  const block: CSSProperties = { padding: 14, borderRadius: 12, background: dshThemeColor.surfaceSubtle, fontSize: 13, minWidth: 0 }
  return createElement('div', { style: { display: 'grid', gap: 16 } },
    createElement('div', { style: { ...block, display: 'grid', gap: 6, color: dshThemeColor.labelSecondary } },
      createElement('span', null, t('awb.call.count', { count: voiceSessionMessageCount(session) }), ' · ', t('awb.call.duration'), ' ', voiceSessionDuration(session)),
      createElement('span', null, t('awb.call.startedAt'), ' ', date(session.startedAt)), createElement('span', null, t('awb.call.endedAt'), ' ', date(session.endedAt))),
    session.messages.length === 0 ? createElement('p', null, t('awb.call.noMessages')) : null,
    ...session.messages.map((message) => createElement(AssistantConversationMessageView, { key: message.id, message, name, t, services, model,
      side: message.role === 'user' ? 'right' : 'left' })),
    createElement('strong', { style: { fontSize: 14 } }, t('awb.call.tools')),
    calls.length === 0 ? createElement('p', { style: { fontSize: 13, color: dshThemeColor.labelTertiary, margin: 0 } }, t('awb.call.noTools')) : null,
    ...calls.map((call) => createElement('article', { key: call.id, style: block },
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, marginBottom: 6 } },
        createElement('strong', null, t(call.kind === 'web-search' ? 'awb.call.webSearch' : call.kind === 'attachment' ? 'awb.call.attachment' : 'awb.call.workspace')),
        createElement('span', { style: { color: call.state === 'failed' ? dshThemeColor.error : dshThemeColor.labelSecondary } }, t(`awb.call.tool.${call.state}`))),
      createElement('div', { style: { fontSize: 12, color: dshThemeColor.labelSecondary, overflowWrap: 'anywhere' } }, call.name, ' · ', date(call.startedAt)),
      createElement('details', { style: { marginTop: 10 } }, createElement('summary', null, t('awb.call.toolDetails')),
        ...[[t('awb.call.arguments'), call.arguments], [t('awb.call.result'), call.result]].map(([label, value]) => createElement('div', { key: label, style: { marginTop: 8 } },
          createElement('small', null, label), createElement('pre', { style: { margin: '4px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', fontSize: 12 } }, value)))))))
}
