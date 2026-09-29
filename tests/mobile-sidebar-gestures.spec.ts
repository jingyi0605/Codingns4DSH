import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GESTURE_DIAGNOSTIC_CAPABILITY_MISSING,
  detectSidebarGesture,
  startMobileSidebarGestures,
  type SidebarGestureSettings,
  type TouchSample,
} from '../data/build/dist/client/mobile-sidebar-gestures.js'

const SETTINGS: SidebarGestureSettings = {
  sidebarGestures: true,
  sidebarGestureMapping: 'swipe-inward',
  sidebarGestureEdge: 'avoid',
  sidebarGestureThresholdPx: 64,
}

function samples(points: readonly [number, number][]): TouchSample[] {
  return points.map(([x, y], index) => ({ x, y, t: index * 16 }))
}

test('横滑判定：方向、阈值与映射', () => {
  const base = { thresholdPx: 64, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth: 390 }
  assert.deepEqual(detectSidebarGesture(samples([[120, 300], [200, 302]]), base), { action: 'left', reason: 'ok' })
  assert.deepEqual(detectSidebarGesture(samples([[280, 300], [190, 305]]), base), { action: 'right', reason: 'ok' })
  assert.deepEqual(detectSidebarGesture(samples([[120, 300], [200, 302]]), { ...base, mapping: 'swap' }), { action: 'right', reason: 'ok' })
  assert.deepEqual(detectSidebarGesture(samples([[120, 300], [150, 300]]), base), { action: 'ignore', reason: 'threshold' })
  assert.deepEqual(detectSidebarGesture(samples([[120, 300]]), base), { action: 'ignore', reason: 'samples' })
  assert.deepEqual(detectSidebarGesture(samples([[0, 0], [10, 0]]), { ...base, thresholdPx: 0 }), { action: 'ignore', reason: 'config' })
})

test('纵向滑动与贴边起手交回系统手势/滚动', () => {
  const base = { thresholdPx: 64, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth: 390 }
  // 斜向但纵向占优：不能抢走列表滚动（水平位移已过阈值，仅靠方向锁定拦下）。
  assert.deepEqual(detectSidebarGesture(samples([[200, 100], [280, 300]]), base), { action: 'ignore', reason: 'direction' })
  // 默认避开边缘热区，避免与 iOS/Android 返回手势打架。
  assert.deepEqual(detectSidebarGesture(samples([[8, 300], [200, 300]]), base), { action: 'ignore', reason: 'edge' })
  assert.deepEqual(detectSidebarGesture(samples([[388, 300], [200, 300]]), base), { action: 'ignore', reason: 'edge' })
  // 显式允许贴边时才生效。
  assert.deepEqual(detectSidebarGesture(samples([[8, 300], [200, 300]]), { ...base, edgeMode: 'edge' }), { action: 'left', reason: 'ok' })
})

class FakeWindow {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  readonly pushed: unknown[] = []
  readonly history = { pushState: (data: unknown): void => { this.pushed.push(data) } }
  innerWidth = 390

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

class FakeDocument {
  readonly listeners = new Map<string, Set<(event: unknown) => void>>()
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
}

function touchEvent(x: number, y: number, options: { target?: unknown; cancelable?: boolean } = {}): { touches: { clientX: number; clientY: number }[]; target?: unknown; cancelable: boolean; prevented: number; preventDefault(): void } {
  const event = {
    touches: [{ clientX: x, clientY: y }],
    target: options.target,
    cancelable: options.cancelable ?? true,
    prevented: 0,
    preventDefault(): void { event.prevented += 1 },
  }
  return event
}

function createHarness(overrides: Partial<{ settings: SidebarGestureSettings; withPorts: boolean }> = {}) {
  const window = new FakeWindow()
  const document = new FakeDocument()
  const calls: string[] = []
  let expanded = false
  const diagnostics: string[] = []
  const portSettings = overrides.settings ?? SETTINGS
  const controller = startMobileSidebarGestures({
    ports: overrides.withPorts === false
      ? {}
      : {
          layout: { toggleSidebar: () => calls.push('left') },
          sidebarRight: {
            isExpanded: () => expanded,
            toggleExpanded: () => { expanded = !expanded; calls.push('right') },
          },
        },
    settings: () => portSettings,
    window,
    document,
    onDiagnostic: (code) => diagnostics.push(code),
  })
  return { window, document, controller, calls, diagnostics, isExpanded: () => expanded }
}

test('手势控制器只通过服务开合侧栏，并在右栏全屏时压入历史记录', () => {
  const harness = createHarness()
  assert.equal(harness.window.listenerCount('touchstart'), 1)
  assert.equal(harness.window.listenerCount('touchmove'), 1)

  harness.window.emit('touchstart', touchEvent(120, 300))
  harness.window.emit('touchmove', touchEvent(200, 304))
  assert.deepEqual(harness.calls, ['left'])

  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(190, 302))
  assert.deepEqual(harness.calls, ['left', 'right'])
  assert.equal(harness.isExpanded(), true)
  assert.deepEqual(harness.window.pushed, [{ codingnsRightbar: true }])

  // 返回手势先关右栏，而不是退出会话。
  harness.window.emit('popstate', {})
  assert.deepEqual(harness.calls, ['left', 'right', 'right'])
  assert.equal(harness.isExpanded(), false)
})

test('方向锁定后不再触发，且输入框内的触摸被忽略', () => {
  const harness = createHarness()
  harness.window.emit('touchstart', touchEvent(120, 300))
  harness.window.emit('touchmove', touchEvent(140, 420))
  harness.window.emit('touchmove', touchEvent(260, 430))
  assert.deepEqual(harness.calls, [])

  const editable = { closest: () => ({}) }
  harness.window.emit('touchstart', touchEvent(120, 300, { target: editable }))
  harness.window.emit('touchmove', touchEvent(220, 300))
  assert.deepEqual(harness.calls, [])
})

test('关闭开关或缺少端口时不注册监听，并给出可解释诊断', () => {
  const disabled = createHarness({ settings: { ...SETTINGS, sidebarGestures: false } })
  assert.equal(disabled.window.listenerCount('touchstart'), 0)
  assert.equal(disabled.controller.refresh(), false)

  const noPorts = createHarness({ withPorts: false })
  assert.equal(noPorts.window.listenerCount('touchstart'), 0)
  assert.deepEqual(noPorts.diagnostics, [GESTURE_DIAGNOSTIC_CAPABILITY_MISSING])
})

test('dispose 之后不再响应触摸，refresh 可以重新激活', () => {
  const harness = createHarness()
  harness.controller.dispose()
  assert.equal(harness.window.listenerCount('touchstart'), 0)
  harness.window.emit('touchstart', touchEvent(120, 300))
  harness.window.emit('touchmove', touchEvent(220, 300))
  assert.deepEqual(harness.calls, [])

  let enabled = false
  const window = new FakeWindow()
  const controller = startMobileSidebarGestures({
    ports: { layout: { toggleSidebar: () => harness.calls.push('left') } },
    settings: () => ({ ...SETTINGS, sidebarGestures: enabled }),
    window,
  })
  assert.equal(window.listenerCount('touchstart'), 0)
  enabled = true
  assert.equal(controller.refresh(), true)
  assert.equal(window.listenerCount('touchstart'), 1)
})
