import assert from 'node:assert/strict'
import test from 'node:test'
import { startMobileSidebarGestures } from '../data/build/dist/client/mobile-sidebar-gestures.js'

const settings = {
  sidebarGestures: true,
  sidebarGestureMapping: 'swipe-inward' as const,
  sidebarGestureEdge: 'avoid' as const,
  sidebarGestureThresholdPx: 64,
}

function touchEvent(x: number, y: number) {
  return {
    touches: [{ clientX: x, clientY: y }],
    cancelable: true,
    timeStamp: x === 120 ? 1 : 17,
    preventDefault() {},
  }
}

test('侧栏手势默认使用触摸 Window 的 navigator 振动', () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const patterns: number[] = []
  const window = {
    innerWidth: 390,
    navigator: {
      vibrate: (pattern: number) => {
        patterns.push(pattern)
        return true
      },
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener)
    },
  }
  const controller = startMobileSidebarGestures({
    ports: { layout: { toggleSidebar() {} } },
    settings: () => settings,
    window,
  })

  for (const listener of listeners.get('touchstart') ?? []) listener(touchEvent(120, 300))
  for (const listener of listeners.get('touchmove') ?? []) listener(touchEvent(330, 300))

  assert.deepEqual(patterns, [10])
  controller.dispose()
})
