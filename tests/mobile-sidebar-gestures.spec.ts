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

function touchEvent(x: number, y: number, options: { target?: unknown; cancelable?: boolean; path?: readonly unknown[] } = {}): { touches: { clientX: number; clientY: number }[]; target?: unknown; cancelable: boolean; prevented: number; preventDefault(): void; composedPath(): readonly unknown[] } {
  const event = {
    touches: [{ clientX: x, clientY: y }],
    target: options.target,
    cancelable: options.cancelable ?? true,
    prevented: 0,
    preventDefault(): void { event.prevented += 1 },
    composedPath(): readonly unknown[] { return options.path ?? [] },
  }
  return event
}

function createHarness(overrides: Partial<{ settings: SidebarGestureSettings; withPorts: boolean }> = {}) {
  const window = new FakeWindow()
  const document = new FakeDocument()
  const calls: string[] = []
  let expanded = false
  const diagnostics: string[] = []
  const vibrations: number[] = []
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
    vibrate: (pattern) => { vibrations.push(pattern) },
  })
  return { window, document, controller, calls, diagnostics, vibrations, isExpanded: () => expanded }
}

test('手势控制器只通过服务开合侧栏，并在右栏全屏时压入历史记录', () => {
  const harness = createHarness()
  assert.equal(harness.window.listenerCount('touchstart'), 1)
  assert.equal(harness.window.listenerCount('touchmove'), 1)

  harness.window.emit('touchstart', touchEvent(120, 300))
  harness.window.emit('touchmove', touchEvent(200, 304))
  assert.deepEqual(harness.calls, ['left'])
  assert.deepEqual(harness.vibrations, [10])

  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(190, 302))
  // 第一次右滑已经呼出左栏，随后左滑应收回左栏，不能误打开右栏。
  assert.deepEqual(harness.calls, ['left', 'left'])
  assert.deepEqual(harness.vibrations, [10, 10])
  assert.equal(harness.isExpanded(), false)
  assert.deepEqual(harness.window.pushed, [])

  // 左栏收回后再次左滑才打开右栏；返回手势先关右栏，而不是退出会话。
  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(190, 302))
  assert.deepEqual(harness.calls, ['left', 'left', 'right'])
  assert.equal(harness.isExpanded(), true)
  assert.deepEqual(harness.window.pushed, [{ codingnsRightbar: true }])
  harness.window.emit('popstate', {})
  assert.deepEqual(harness.calls, ['left', 'left', 'right', 'right'])
  assert.equal(harness.isExpanded(), false)
})

test('DOM 状态表明左栏已展开时，默认映射的物理左滑关闭左栏', () => {
  const window = new FakeWindow()
  let leftCollapsed = false
  let rightExpanded = false
  const calls: string[] = []
  const controller = startMobileSidebarGestures({
    ports: {
      layout: {
        toggleSidebar: () => {
          leftCollapsed = !leftCollapsed
          calls.push('left')
        },
      },
      sidebarRight: {
        isExpanded: () => rightExpanded,
        toggleExpanded: () => {
          rightExpanded = !rightExpanded
          calls.push('right')
        },
      },
    },
    settings: () => SETTINGS,
    readLeftCollapsed: () => leftCollapsed,
    window,
  })

  window.emit('touchstart', touchEvent(280, 300))
  window.emit('touchmove', touchEvent(190, 302))
  assert.deepEqual(calls, ['left'])
  assert.equal(leftCollapsed, true)
  assert.equal(rightExpanded, false)
  controller.dispose()
})

test('右栏已展开时，反向物理右滑关闭右栏且不再切换左栏', () => {
  const harness = createHarness()

  // 默认映射下物理左滑呼出右栏。
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(190, 302))
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(harness.isExpanded(), true)
  assert.deepEqual(harness.window.pushed, [{ codingnsRightbar: true }])

  // 反向右滑只关闭右栏，不应同时呼出左栏。
  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(120, 300))
  harness.window.emit('touchmove', touchEvent(200, 302))
  assert.deepEqual(harness.calls, ['right', 'right'])
  assert.equal(harness.isExpanded(), false)

  // 主动关闭后，历史回退不能再次调用右栏关闭逻辑。
  harness.window.emit('popstate', {})
  assert.deepEqual(harness.calls, ['right', 'right'])
  assert.equal(harness.isExpanded(), false)
})

test('swap 映射下物理左滑同样关闭已展开的左栏', () => {
  const window = new FakeWindow()
  let leftCollapsed = false
  let rightExpanded = false
  const calls: string[] = []
  const controller = startMobileSidebarGestures({
    ports: {
      layout: {
        toggleSidebar: () => {
          leftCollapsed = !leftCollapsed
          calls.push('left')
        },
      },
      sidebarRight: {
        isExpanded: () => rightExpanded,
        toggleExpanded: () => {
          rightExpanded = !rightExpanded
          calls.push('right')
        },
      },
    },
    settings: () => ({ ...SETTINGS, sidebarGestureMapping: 'swap' }),
    readLeftCollapsed: () => leftCollapsed,
    window,
  })

  window.emit('touchstart', touchEvent(280, 300))
  window.emit('touchmove', touchEvent(190, 302))
  assert.deepEqual(calls, ['left'])
  assert.equal(leftCollapsed, true)
  assert.equal(rightExpanded, false)
  controller.dispose()
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

  // xterm 使用 Shadow DOM，事件 target 可能是终端宿主；宿主的稳定标记也必须跳过。
  const terminalHost = {
    closest: (selector: string) => selector.includes('[data-sidebar-terminal]') ? terminalHost : null,
  }
  harness.window.emit('touchstart', touchEvent(120, 300, { target: terminalHost }))
  harness.window.emit('touchmove', touchEvent(220, 300))
  assert.deepEqual(harness.calls, [])
})

test('横向滚动容器优先接收右滑，不收起右栏', () => {
  const harness = createHarness()
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(190, 300))
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(harness.isExpanded(), true)
  harness.window.emit('touchend', { touches: [] })

  const rightbarRoot = {
    closest: (selector: string) => selector === '[data-sidebar-right-session]' ? rightbarRoot : null,
    parentElement: null,
  }
  const scrollable = {
    scrollWidth: 720,
    clientWidth: 320,
    scrollLeft: 200,
    style: { overflowX: 'auto' },
    parentElement: rightbarRoot,
  }
  const text = { parentElement: scrollable, closest: () => null }

  harness.window.emit('touchstart', touchEvent(120, 300, { target: text }))
  const move = touchEvent(220, 300, { target: text })
  harness.window.emit('touchmove', move)

  assert.deepEqual(harness.calls, ['right'])
  assert.equal(harness.isExpanded(), true)
  assert.equal(move.prevented, 0)

  // Shadow DOM 重定向后，event.target 可能只有宿主；composedPath 仍应找到滚动祖先。
  const shadowHost = { closest: () => null }
  harness.window.emit('touchstart', touchEvent(120, 300, { target: shadowHost, path: [text, scrollable] }))
  const shadowMove = touchEvent(220, 300, { target: shadowHost, path: [text, scrollable] })
  harness.window.emit('touchmove', shadowMove)
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(shadowMove.prevented, 0)

  // 左滑不负责收起右栏，即使布局尺寸尚未更新也必须交给内部内容。
  const pendingLayout = { scrollWidth: 320, clientWidth: 320, style: { overflowX: 'auto' }, parentElement: null }
  const pendingTarget = { parentElement: pendingLayout, closest: () => null }
  harness.window.emit('touchstart', touchEvent(220, 300, { target: pendingTarget }))
  const pendingMove = touchEvent(120, 300, { target: pendingTarget })
  harness.window.emit('touchmove', pendingMove)
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(pendingMove.prevented, 0)

  // 右栏宿主本身没有暴露滚动尺寸时，左滑仍不能调用任何收起服务。
  const rightbarPanel = {
    closest: (selector: string) => selector === '[data-sidebar-right-session]' ? rightbarPanel : null,
  }
  harness.window.emit('touchstart', touchEvent(220, 300, { target: rightbarPanel }))
  const rightbarMove = touchEvent(120, 300, { target: rightbarPanel })
  harness.window.emit('touchmove', rightbarMove)
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(rightbarMove.prevented, 0)

  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(120, 300, { target: rightbarPanel }))
  const closeMove = touchEvent(220, 300, { target: rightbarPanel })
  harness.window.emit('touchmove', closeMove)
  assert.deepEqual(harness.calls, ['right', 'right'])
  assert.equal(harness.isExpanded(), false)
})

test('聊天区域的横向滚动祖先不吞掉左右侧栏唤起手势', () => {
  const harness = createHarness()
  const chatScroller = {
    scrollWidth: 720,
    clientWidth: 320,
    scrollLeft: 200,
    style: { overflowX: 'auto' },
    parentElement: null,
  }
  const chatTarget = { parentElement: chatScroller, closest: () => null }

  // 右栏未展开时，即使聊天内容自身可以横向滚动，左右唤起仍由全局手势负责。
  harness.window.emit('touchstart', touchEvent(120, 300, { target: chatTarget }))
  harness.window.emit('touchmove', touchEvent(220, 300, { target: chatTarget }))
  assert.deepEqual(harness.calls, ['left'])
  harness.window.emit('touchend', { touches: [] })

  harness.window.emit('touchstart', touchEvent(280, 300, { target: chatTarget }))
  harness.window.emit('touchmove', touchEvent(190, 300, { target: chatTarget }))
  assert.deepEqual(harness.calls, ['left', 'left'])
})

test('关闭开关或缺少端口时不注册监听，并给出可解释诊断', () => {
  const disabled = createHarness({ settings: { ...SETTINGS, sidebarGestures: false } })
  assert.equal(disabled.window.listenerCount('touchstart'), 0)
  assert.equal(disabled.controller.refresh(), false)

  const noPorts = createHarness({ withPorts: false })
  assert.equal(noPorts.window.listenerCount('touchstart'), 0)
  assert.deepEqual(noPorts.diagnostics, [GESTURE_DIAGNOSTIC_CAPABILITY_MISSING])
})

test('桌面视口不注册全局触摸监听，缩放到窄屏后自动启用', () => {
  const window = new FakeWindow()
  window.innerWidth = 1440
  let expanded = false
  const controller = startMobileSidebarGestures({
    ports: {
      layout: { toggleSidebar: () => undefined },
      sidebarRight: { isExpanded: () => expanded, toggleExpanded: () => { expanded = !expanded } },
    },
    settings: () => SETTINGS,
    window,
  })
  assert.equal(window.listenerCount('touchstart'), 0)
  window.innerWidth = 390
  window.emit('resize', {})
  assert.equal(window.listenerCount('touchstart'), 1)
  controller.dispose()
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
