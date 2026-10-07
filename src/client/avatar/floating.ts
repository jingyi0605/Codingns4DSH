import { createElement, useEffect, useRef, useState } from 'react'
import type { ReactElement, PointerEvent } from 'react'
import type { AssistantAvatarModel, AssistantAvatarState } from '../../shared/assistant-avatar.js'
import { clampAssistantAvatarPosition } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices } from '../features/types.js'
import { useCodingNsTranslator } from '../locale.js'
import { AssistantAvatarSlot } from './slot.js'

const POSITION_KEY = 'codingns-assistant-avatar-position'
interface Position { readonly x: number; readonly y: number }

/** 容器负责交互，渲染器只画形象；拖动与打开对话互斥。 */
export function FloatingAssistantAvatar({ services, model, state, size, onOpen }: {
  readonly services: CodingNsClientServices; readonly model: AssistantAvatarModel; readonly state: AssistantAvatarState
  readonly size: number; readonly onOpen: () => void
}): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const height = size * 208 / 192
  const [position, setPosition] = useState<Position>(() => readPosition(size, height))
  const drag = useRef<{ readonly id: number; readonly startX: number; readonly startY: number; readonly position: Position; moved: boolean } | undefined>()
  const latestPosition = useRef(position)
  const suppressClick = useRef(false)
  latestPosition.current = position
  const clamp = (x: number, y: number): Position => clampAssistantAvatarPosition(x, y, size, height, window.innerWidth, window.innerHeight)
  useEffect(() => {
    const refresh = (): void => setPosition((current) => clampAssistantAvatarPosition(current.x, current.y, size, height, window.innerWidth, window.innerHeight))
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
    try { localStorage.setItem(POSITION_KEY, JSON.stringify(next)) } catch { /* 存储受限只影响位置记忆。 */ }
  }
  return createElement('div', { role: 'button', tabIndex: 0, 'aria-haspopup': 'dialog',
    'aria-label': t('avatar.openAssistant'), title: t('avatar.dragHint'), 'data-codingns-floating-avatar': true,
    onPointerDown: down, onPointerMove: move, onPointerUp: up,
    onClick: () => { if (!suppressClick.current) onOpen(); suppressClick.current = false },
    onPointerCancel: () => { drag.current = undefined; suppressClick.current = true }, onLostPointerCapture: () => { drag.current = undefined },
    onKeyDown: (event: { readonly key: string; preventDefault(): void }) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } },
    style: { position: 'fixed', left: position.x, top: position.y, width: size, maxWidth: '100vw', zIndex: 9000,
      cursor: 'grab', touchAction: 'none', userSelect: 'none', pointerEvents: 'auto', background: 'transparent' } },
    createElement(AssistantAvatarSlot, { services, model, state, surface: 'floating', size }))
}

function readPosition(width: number, height: number): Position {
  if (typeof window === 'undefined') return { x: 0, y: 0 }
  let position: Position = { x: window.innerWidth - width - 24, y: window.innerHeight - height - 24 }
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? 'null') as Position | null
    if (saved !== null && typeof saved.x === 'number' && typeof saved.y === 'number') position = saved
  } catch { /* 无效位置按默认角落显示。 */ }
  return clampAssistantAvatarPosition(position.x, position.y, width, height, window.innerWidth, window.innerHeight)
}
