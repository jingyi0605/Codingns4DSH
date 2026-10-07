import { createElement, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { voiceSessionDuration } from '../../shared/assistant-voice-sessions.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshThemeColor } from '../theme.js'

export interface FloatingCallInfo {
  readonly startedAt: number
  readonly state?: string | undefined
  readonly pending: boolean
  readonly microphoneMuted: boolean
  readonly speakerMuted: boolean
  readonly userText: string
  readonly assistantText: string
}

/** 发声提示只取实际播放状态；文字先到、扬声器静音时都不能伪装成正在发声。 */
export function floatingCallStatus(call: FloatingCallInfo): string {
  if (call.pending) return call.state === 'disabled' ? 'ending' : 'connecting'
  if (call.state === 'error') return 'error'
  if (call.state === 'speaking') return call.speakerMuted ? 'silent' : 'speaking'
  if (call.state === 'thinking') return 'thinking'
  return call.microphoneMuted ? 'muted' : 'listening'
}

export function FloatingCallBadge({ call, t }: { readonly call: FloatingCallInfo; readonly t: CodingNsTranslator }): ReactElement {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const status = floatingCallStatus(call)
  const speaking = status === 'speaking'
  return createElement('div', { 'data-codingns-floating-call-status': status,
    'aria-label': `${t(`awb.call.${status}`)} · ${t('awb.call.duration')} ${voiceSessionDuration({ startedAt: call.startedAt, endedAt: null }, now)}`,
    title: t(`awb.call.${status}`), style: { position: 'absolute', bottom: 0, left: 0, right: 0, margin: '0 auto', width: 'fit-content', maxWidth: '100%',
      boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '4px 7px', borderRadius: 12,
      background: dshThemeColor.menuBackground, color: dshThemeColor.labelPrimary, border: `1px solid ${dshThemeColor.border}`, boxShadow: dshThemeColor.prominentShadow,
      fontSize: 11, lineHeight: 1.3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
    createElement('style', null, '.codingns-floating-call-dot{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:#32a66a}.codingns-floating-call-dot[data-speaking=true]{animation:codingns-call-dot-pulse .8s ease-in-out infinite}@keyframes codingns-call-dot-pulse{50%{opacity:.4;transform:scale(.7)}}@media(prefers-reduced-motion:reduce){.codingns-floating-call-dot{animation:none!important}}'),
    createElement('span', { className: 'codingns-floating-call-dot', 'data-speaking': speaking, 'aria-hidden': true }),
    createElement('span', null, voiceSessionDuration({ startedAt: call.startedAt, endedAt: null }, now)),
    speaking ? createElement('svg', { width: 12, height: 12, viewBox: '0 0 16 16', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
      createElement('path', { d: 'M2 6v4M6 3v10M10 5v6M14 6v4' })) : null)
}

/** 气泡在拖动容器之外接收滚动与选中文字，避免字幕操作意外拖走助手。 */
export function FloatingCallCaption({ call, t, style, above, arrowLeft, onOpen }: {
  readonly call: FloatingCallInfo; readonly t: CodingNsTranslator; readonly style: CSSProperties; readonly above: boolean; readonly arrowLeft: number; readonly onOpen: () => void
}): ReactElement {
  const captions = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    if (call.assistantText === '') follow.current = true
    if (captions.current !== null && follow.current) captions.current.scrollTop = captions.current.scrollHeight
  }, [call.userText, call.assistantText])
  const status = floatingCallStatus(call)
  return createElement('div', { 'data-codingns-floating-call-caption': true, style: { position: 'absolute', ...style, pointerEvents: 'auto',
    display: 'flex', flexDirection: 'column', borderRadius: 14, border: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.menuBackground,
    color: dshThemeColor.labelPrimary, boxShadow: dshThemeColor.prominentShadow, boxSizing: 'border-box', textAlign: 'left' } },
    createElement('span', { 'aria-hidden': true, style: { position: 'absolute', left: arrowLeft - 4, ...(above ? { bottom: -5 } : { top: -5 }), width: 8, height: 8,
      transform: 'rotate(45deg)', background: dshThemeColor.menuBackground, borderRight: above ? `1px solid ${dshThemeColor.border}` : undefined,
      borderBottom: above ? `1px solid ${dshThemeColor.border}` : undefined, borderLeft: above ? undefined : `1px solid ${dshThemeColor.border}`,
      borderTop: above ? undefined : `1px solid ${dshThemeColor.border}` } }),
    createElement('button', { type: 'button', onClick: onOpen, title: t('awb.call.restore'), 'aria-label': t('awb.call.restore'),
      style: { display: 'flex', justifyContent: 'space-between', gap: 8, flexShrink: 0, minHeight: 32, width: '100%', border: 0, borderRadius: '14px 14px 0 0', padding: '8px 12px',
        background: 'transparent', color: dshThemeColor.labelSecondary, font: 'inherit', fontSize: 11, cursor: 'pointer', textAlign: 'left' } },
      createElement('span', null, t(`awb.call.${status}`)), createElement('span', { 'aria-hidden': true }, '↗')),
    createElement('div', { ref: captions, tabIndex: 0, 'aria-label': t('awb.call.caption'),
      onScroll: (event: { currentTarget: HTMLDivElement }) => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24 },
      style: { minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin', padding: '0 12px 10px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        fontSize: 13, lineHeight: 1.6, touchAction: 'pan-y', userSelect: 'text' } },
      call.userText && !call.microphoneMuted ? createElement('p', { style: { margin: '0 0 6px', color: dshThemeColor.labelTertiary, fontSize: 12 } }, call.userText) : null,
      createElement('p', { 'aria-live': 'polite', style: { margin: 0 } }, call.assistantText || (!call.userText ? t('awb.call.waiting') : ''))))
}

/** 给气泡保留视口边距，并选择悬浮组件上方或下方较宽裕的一侧。 */
export function floatingCallCaptionLayout(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number): {
  readonly above: boolean; readonly arrowLeft: number; readonly style: CSSProperties
} {
  const captionWidth = Math.min(320, Math.max(0, viewportWidth - 24))
  const left = Math.max(12, Math.min(x + (width - captionWidth) / 2, viewportWidth - captionWidth - 12)) - x
  const spaceAbove = Math.max(0, y - 22)
  const spaceBelow = Math.max(0, viewportHeight - y - height - 22)
  const above = spaceAbove >= spaceBelow
  const space = above ? spaceAbove : spaceBelow
  // 极矮横屏允许气泡覆盖形象的一部分，优先保证字幕和恢复入口仍在屏幕内。
  const maxHeight = Math.min(180, Math.max(48, space), Math.max(0, viewportHeight - 24))
  const placement = space < 48
    ? { top: Math.max(12, Math.min(y + height + 10, viewportHeight - maxHeight - 12)) - y }
    : above ? { bottom: height + 10 } : { top: height + 10 }
  return { above, arrowLeft: Math.max(16, Math.min(width / 2 - left, captionWidth - 16)),
    style: { left, width: captionWidth, maxHeight, ...placement } }
}
