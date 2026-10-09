import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode, PointerEvent } from 'react'
import type { AssistantAvatarModel, AssistantAvatarReaction, AssistantAvatarState } from '../../shared/assistant-avatar.js'
import { clampAssistantAvatarPosition } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices } from '../features/types.js'
import { useCodingNsTranslator } from '../locale.js'
import { AssistantAvatarSlot } from './slot.js'
import { FloatingCallBadge, FloatingCallCaption, floatingCallCaptionLayout } from '../features/assistant-floating-call.js'
import type { FloatingCallInfo } from '../features/assistant-floating-call.js'
import { dshThemeColor } from '../theme.js'
import { assistantNotificationTailStyle, floatingAssistantNotificationLayout } from './notification-bubble.js'

const POSITION_KEY = 'codingns-assistant-avatar-position'
interface Position { readonly x: number; readonly y: number }

/** 容器负责交互，渲染器只画形象；拖动与打开对话互斥。 */
export function FloatingAssistantAvatar({ services, model, state, reaction, size, call, notification, onOpen }: {
  readonly services: CodingNsClientServices; readonly model: AssistantAvatarModel; readonly state: AssistantAvatarState
  readonly size: number; readonly onOpen: () => void
  readonly call?: FloatingCallInfo | undefined
  readonly reaction?: AssistantAvatarReaction
  readonly notification?: ReactNode
}): ReactElement {
  return createElement(FloatingAssistantFrame, { services, width: size, height: size * 208 / 192, positionKey: POSITION_KEY, kind: 'avatar', call, notification, onOpen },
    createElement(AssistantAvatarSlot, { services, model, state, surface: 'floating', size, ...(reaction === undefined ? {} : { reaction }) }))
}

/** 没有开启悬浮形象时，以同一套拖动和字幕容器提供轻量通话球。 */
export function FloatingVoiceCall({ services, call, onOpen }: {
  readonly services: CodingNsClientServices; readonly call: FloatingCallInfo; readonly onOpen: () => void
}): ReactElement {
  return createElement(FloatingAssistantFrame, { services, width: 76, height: 84, positionKey: 'codingns-voice-call-position', kind: 'call', call, onOpen },
    createElement('div', { style: { width: 60, height: 60, margin: '0 auto', display: 'grid', placeItems: 'center', borderRadius: '50%',
      border: `1px solid ${dshThemeColor.border}`, background: dshThemeColor.menuBackground, color: dshThemeColor.labelPrimary, boxShadow: dshThemeColor.prominentShadow } },
      createElement('svg', { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true },
        createElement('path', { d: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5Zm-3 5v1a6 6 0 0 0 12 0v-1M12 17v4m-4 0h8' }))))
}

function FloatingAssistantFrame({ services, width: size, height, positionKey, kind, call, notification, onOpen, children }: {
  readonly services: CodingNsClientServices; readonly width: number; readonly height: number; readonly positionKey: string
  readonly kind: 'avatar' | 'call'; readonly call?: FloatingCallInfo | undefined; readonly onOpen: () => void; readonly children?: ReactNode
  readonly notification?: ReactNode
}): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [position, setPosition] = useState<Position>(() => readPosition(size, height, positionKey))
  const [viewport, setViewport] = useState(() => ({ width: typeof window === 'undefined' ? 1024 : window.innerWidth, height: typeof window === 'undefined' ? 768 : window.innerHeight }))
  const drag = useRef<{ readonly id: number; readonly startX: number; readonly startY: number; readonly position: Position; moved: boolean } | undefined>()
  const latestPosition = useRef(position)
  const suppressClick = useRef(false)
  latestPosition.current = position
  const clamp = (x: number, y: number): Position => clampAssistantAvatarPosition(x, y, size, height, window.innerWidth, window.innerHeight)
  useEffect(() => {
    const refresh = (): void => {
      setViewport({ width: window.innerWidth, height: window.innerHeight })
      setPosition((current) => clampAssistantAvatarPosition(current.x, current.y, size, height, window.innerWidth, window.innerHeight))
    }
    refresh()
    window.addEventListener('resize', refresh)
    return () => window.removeEventListener('resize', refresh)
  }, [size, height])
  const down = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    suppressClick.current = false
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, position: latestPosition.current, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === undefined || current.id !== event.pointerId) return
    const dx = event.clientX - current.startX
    const dy = event.clientY - current.startY
    if (Math.hypot(dx, dy) >= 6) current.moved = true
    if (current.moved) setPosition(clamp(current.position.x + dx, current.position.y + dy))
  }
  const up = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (current === undefined || current.id !== event.pointerId) return
    drag.current = undefined
    current.moved ||= Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 6
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    suppressClick.current = current.moved
    if (!current.moved) return
    const next = clamp(current.position.x + event.clientX - current.startX, current.position.y + event.clientY - current.startY)
    setPosition(next)
    try { localStorage.setItem(positionKey, JSON.stringify(next)) } catch { /* 存储受限只影响位置记忆。 */ }
  }
  const captionLayout = floatingCallCaptionLayout(position.x, position.y, size, height, viewport.width, viewport.height)
  const notificationLayout = notification === undefined ? undefined : floatingAssistantNotificationLayout(position.x, position.y, size, height, viewport.width, viewport.height, call ? captionLayout.above : undefined)
  const notificationStyle = notificationLayout === undefined ? undefined : {
    position: 'absolute' as const, ...notificationLayout,
    ...assistantNotificationTailStyle(size / 2, Number(notificationLayout.left ?? 0), Number(notificationLayout.width ?? size)),
  }
  return createElement('div', { ...(kind === 'avatar' ? { 'data-codingns-floating-avatar': true } : { 'data-codingns-floating-call': true }),
    style: { position: 'fixed', left: position.x, top: position.y, width: size, height, maxWidth: '100vw', zIndex: 9000, pointerEvents: 'none' } },
    createElement('div', { role: 'button', tabIndex: 0, 'aria-haspopup': 'dialog', 'aria-expanded': false,
      'aria-label': t(call ? 'awb.call.restore' : 'avatar.openAssistant'), title: t('avatar.dragHint'),
      onPointerDown: down, onPointerMove: move, onPointerUp: up,
      onClick: () => { if (!suppressClick.current) onOpen(); suppressClick.current = false },
      onPointerCancel: () => { drag.current = undefined; suppressClick.current = true }, onLostPointerCapture: () => { drag.current = undefined },
      onKeyDown: (event: { readonly key: string; preventDefault(): void }) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } },
      style: { position: 'relative', width: size, height,
        cursor: 'grab', touchAction: 'none', userSelect: 'none', pointerEvents: 'auto', background: 'transparent' } },
      children, call ? createElement(FloatingCallBadge, { call, t }) : null),
    call ? createElement(FloatingCallCaption, { call, t, ...captionLayout, onOpen }) : null,
    notification && notificationStyle ? createElement('div', { 'data-codingns-floating-notification-region': true,
      style: { ...notificationStyle, pointerEvents: 'auto', overflow: 'visible', overscrollBehavior: 'contain', touchAction: 'pan-y', userSelect: 'text' } }, notification) : null)
}

function readPosition(width: number, height: number, positionKey: string): Position {
  if (typeof window === 'undefined') return { x: 0, y: 0 }
  let position: Position = { x: window.innerWidth - width - 24, y: window.innerHeight - height - 24 }
  try {
    const saved = JSON.parse(localStorage.getItem(positionKey) ?? 'null') as Position | null
    if (saved !== null && typeof saved.x === 'number' && typeof saved.y === 'number') position = saved
  } catch { /* 无效位置按默认角落显示。 */ }
  return clampAssistantAvatarPosition(position.x, position.y, width, height, window.innerWidth, window.innerHeight)
}
