import { createElement, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsHelpStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'

export interface VoiceConversationDialogProps {
  readonly t: CodingNsTranslator
  readonly active: boolean
  readonly pending: boolean
  readonly state?: string | undefined
  readonly message?: string | undefined
  readonly partialText: string
  readonly transcript: readonly string[]
  readonly realtimeAvailable: boolean
  readonly unavailableMessage?: string | undefined
  readonly onStart: () => void
  readonly onStop: () => void
  readonly onClose: () => void
  readonly onClear: () => void
}

/** 全局语音助理独立对话窗口；打开窗口不会自动申请麦克风。 */
export function VoiceConversationDialog({
  t,
  active,
  pending,
  state,
  message,
  partialText,
  transcript,
  realtimeAvailable,
  unavailableMessage,
  onStart,
  onStop,
  onClose,
  onClear,
}: VoiceConversationDialogProps): ReactElement {
  const status = statusLabel(t, state, active)
  const canStart = !active && !pending
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = transcriptRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [partialText, transcript.length])
  return createElement('div', {
    role: 'presentation',
    onPointerDown: () => { if (!pending) onClose() },
    style: {
      position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: dshThemeColor.overlay, boxSizing: 'border-box',
    },
  },
    createElement('div', {
      role: 'dialog',
      'aria-modal': true,
      'aria-label': t('voice.dialog.title'),
      onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      style: {
        display: 'flex', flexDirection: 'column', gap: 14, width: 'min(620px, 100%)', maxHeight: 'min(700px, 100%)',
        overflowY: 'auto', padding: 24, color: dshThemeColor.labelPrimary, background: dshThemeColor.menuBackground,
        border: `1px solid ${dshThemeColor.border}`, borderRadius: 12, boxShadow: dshThemeColor.prominentShadow,
        boxSizing: 'border-box',
      },
    },
      createElement('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 } },
        createElement('div', { style: { display: 'grid', gap: 6, minWidth: 0 } },
          createElement('strong', { style: { fontSize: 18, lineHeight: 1.4 } }, t('voice.dialog.title')),
          createElement('span', { style: dshSettingsHelpStyle }, t('voice.dialog.description')),
        ),
        createElement('span', { role: 'status', style: { flex: '0 0 auto', color: active ? dshThemeColor.success : dshThemeColor.labelSecondary, fontSize: 12 } }, status),
      ),
      createElement('div', { style: { padding: '10px 12px', borderRadius: 8, background: dshThemeColor.surfaceSubtle, color: dshThemeColor.labelSecondary, fontSize: 12, lineHeight: 1.5 } },
        realtimeAvailable ? t('voice.dialog.realtimeHint') : unavailableMessage ?? t('voice.dialog.unavailable'),
      ),
      createElement('div', {
        'aria-live': 'polite',
        ref: transcriptRef,
        style: {
          display: 'flex', flexDirection: 'column', gap: 8, minHeight: 180, maxHeight: 340, overflowY: 'auto',
          padding: 14, border: `1px solid ${dshThemeColor.border}`, borderRadius: 8, background: dshThemeColor.inputBackground,
          boxSizing: 'border-box',
        },
      },
        createElement('div', { style: { color: dshThemeColor.labelTertiary, fontSize: 12, fontWeight: 600 } }, t('voice.dialog.liveText')),
        transcript.length === 0 && partialText === ''
          ? createElement('div', { style: { color: dshThemeColor.labelTertiary, fontSize: 14, lineHeight: 1.6 } }, t('voice.dialog.empty'))
          : null,
        ...transcript.map((text, index) => createElement('div', { key: `${index}-${text}`, style: { color: dshThemeColor.labelPrimary, fontSize: 15, lineHeight: 1.65 } }, text)),
        partialText === '' ? null : createElement('div', { style: { color: dshThemeColor.accent, fontSize: 15, lineHeight: 1.65 } }, partialText),
      ),
      message === undefined || message === '' || state !== 'error'
        ? null
        : createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 13, lineHeight: 1.5 } }, message),
      createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 3 } },
        createElement('button', { type: 'button', disabled: transcript.length === 0 && partialText === '', onClick: onClear, style: dshSettingsButtonStyle }, t('voice.dialog.clear')),
        createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          createElement('button', { type: 'button', disabled: pending, onClick: onClose, style: dshSettingsButtonStyle }, t('voice.dialog.close')),
          active
            ? createElement('button', { type: 'button', onClick: onStop, style: dshSettingsButtonStyle }, t('voice.dialog.stop'))
            : createElement('button', { type: 'button', disabled: !canStart || !realtimeAvailable, onClick: onStart, style: dshSettingsPrimaryButtonStyle }, t('voice.dialog.start')),
        ),
      ),
    ),
  )
}

function statusLabel(t: CodingNsTranslator, state: string | undefined, active: boolean): string {
  if (state === 'loading') return t('voice.dialog.status.loading')
  if (state === 'listening') return t('voice.dialog.status.listening')
  if (state === 'recording') return t('voice.dialog.status.recording')
  if (state === 'error') return t('voice.dialog.status.error')
  return active ? t('voice.dialog.status.active') : t('voice.dialog.status.idle')
}
