import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { createQuickAppReorderAnimation } from './reorder-animation.js'

interface Drag<T> {
  pointerId: number
  id: string
  startX: number
  startY: number
  active: boolean
  capture: HTMLElement
  order: readonly T[]
}

function move<T>(items: readonly T[], from: number, to: number): readonly T[] {
  const next = [...items]
  next.splice(to, 0, next.splice(from, 1)[0]!)
  return next
}

/** Keep pointer previews local; only a completed drop persists the new order. */
export function useQuickAppReorder<T extends { id: string }>({ apps, enabled, onReorder }: {
  apps: readonly T[]; enabled: boolean; onReorder: (apps: readonly T[]) => void
}) {
  const grid = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag<T> | null>(null)
  const suppressClick = useRef(false)
  const [preview, setPreview] = useState<{ id: string; order: readonly T[] } | null>(null)
  const [animation] = useState(createQuickAppReorderAnimation)
  const displayed = preview?.order ?? apps
  const orderKey = JSON.stringify(displayed.map(app => app.id))
  useLayoutEffect(() => { if (grid.current) animation.update(grid.current) }, [animation, orderKey, enabled])
  useEffect(() => () => animation.dispose(), [animation])
  const release = () => {
    const current = drag.current
    drag.current = null
    if (current?.capture.hasPointerCapture(current.pointerId)) current.capture.releasePointerCapture(current.pointerId)
  }
  const cancel = () => { release(); setPreview(null) }
  useEffect(() => { cancel(); return release }, [apps, enabled])

  const targetAt = (event: PointerEvent<HTMLDivElement>): string | undefined => {
    const root = grid.current
    if (!root) return undefined
    const bounds = root.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return undefined
    const x = event.clientX - bounds.left + root.scrollLeft
    const y = event.clientY - bounds.top + root.scrollTop
    // Hit-test layout slots, not animated tiles passing under a stationary pointer.
    return [...root.querySelectorAll<HTMLElement>(':scope > [data-quick-app-id]')].find(node =>
      x >= node.offsetLeft && x <= node.offsetLeft + node.offsetWidth && y >= node.offsetTop && y <= node.offsetTop + node.offsetHeight)?.dataset.quickAppId
  }
  const start = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    suppressClick.current = false
    if (!enabled || apps.length < 2 || event.button !== 0 || !event.isPrimary || drag.current) return
    // Capture on the tile first so an ordinary tap still produces its normal click.
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, id, startX: event.clientX, startY: event.clientY,
      active: false, capture: event.currentTarget, order: apps }
  }
  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    const root = grid.current
    if (!enabled || !current || current.pointerId !== event.pointerId || !root) return
    if (!current.active) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return
      current.active = true
      suppressClick.current = true
      // The grid stays mounted when the dragged tile changes position.
      root.setPointerCapture(event.pointerId)
      current.capture = root
    }
    event.preventDefault()
    const bounds = root.getBoundingClientRect()
    if (event.clientY < bounds.top + 24) root.scrollTop -= 12
    else if (event.clientY > bounds.bottom - 24) root.scrollTop += 12
    const target = targetAt(event)
    const from = current.order.findIndex(app => app.id === current.id)
    const to = current.order.findIndex(app => app.id === target)
    if (from >= 0 && to >= 0 && from !== to) current.order = move(current.order, from, to)
    setPreview({ id: current.id, order: current.order })
  }
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const droppedInside = targetAt(event) !== undefined
    cancel()
    if (enabled && current.active && droppedInside && current.order.some((app, index) => app.id !== apps[index]?.id)) onReorder(current.order)
  }
  const keyboardMove = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!enabled || drag.current || !event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const from = apps.findIndex(app => app.id === id)
    const to = from + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)
    if (from >= 0 && to >= 0 && to < apps.length) onReorder(move(apps, from, to))
  }
  return {
    apps: displayed,
    gridProps: {
      ref: grid,
      onPointerMove: movePointer,
      onPointerUp: finish,
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.pointerId === event.pointerId) cancel() },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId === event.pointerId && event.target === drag.current.capture) cancel()
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel() }
      },
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false }
      },
    },
    tileProps: (id: string) => ({
      'data-dragging': preview?.id === id,
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => start(event, id),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => keyboardMove(event, id),
    }),
  }
}
