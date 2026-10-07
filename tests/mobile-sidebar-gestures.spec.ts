import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_GESTURE_DISTANCE_RATIO,
  GESTURE_DIAGNOSTIC_CAPABILITY_MISSING,
  MAX_GESTURE_DISTANCE_RATIO,
  MIN_GESTURE_DISTANCE_RATIO,
  detectSidebarGesture,
  startMobileSidebarGestures,
  type SidebarGestureSettings,
  type TouchSample,
} from '../data/build/dist/client/mobile-sidebar-gestures.js'
import {
  DEFAULT_SIDEBAR_GESTURE_DISTANCE_PERCENT,
  SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS,
} from '../data/build/dist/shared/contracts/config.js'

test('手势比例区间与共享设置契约保持一致', () => {
  // 两处范围一旦各自演化，设置页允许的值就会被判定层当成非法配置而静默失效。
  assert.equal(MIN_GESTURE_DISTANCE_RATIO * 100, SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.min)
  assert.equal(MAX_GESTURE_DISTANCE_RATIO * 100, SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.max)
  // 契约边界值必须都能通过判定层，否则用户能把设置存成永远不触发的状态。
  for (const percent of [SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.min, SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.max]) {
    assert.notEqual(
      detectSidebarGesture(samples([[0, 300], [390, 300]]), {
        distanceRatio: percent / 100,
        edgeMode: 'edge',
        mapping: 'swipe-inward',
        viewportWidth: 390,
      }).reason,
      'config',
      `${percent}% 是契约允许值，不应被判为非法配置`,
    )
  }
  // 默认值必须落在合法区间内，否则开箱配置就会被钳位改写。
  assert.ok(
    DEFAULT_GESTURE_DISTANCE_RATIO * 100 >= SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.min
    && DEFAULT_GESTURE_DISTANCE_RATIO * 100 <= SIDEBAR_GESTURE_DISTANCE_PERCENT_LIMITS.max,
  )
  assert.equal(DEFAULT_GESTURE_DISTANCE_RATIO * 100, DEFAULT_SIDEBAR_GESTURE_DISTANCE_PERCENT)
})

const SETTINGS: SidebarGestureSettings = {
  sidebarGestures: true,
  sidebarGestureMapping: 'swipe-inward',
  sidebarGestureEdge: 'avoid',
  sidebarGestureDistancePercent: 25,
}

function samples(points: readonly [number, number][]): TouchSample[] {
  return points.map(([x, y], index) => ({ x, y, t: index * 16 }))
}

/** 生成带时间戳的轨迹；速度类断言必须自己控制 t，不能依赖 samples() 的固定步长。 */
function trace(points: readonly (readonly [number, number, number])[]): TouchSample[] {
  return points.map(([x, y, t]) => ({ x, y, t }))
}

/**
 * 只走距离通道的慢速轨迹：速度取 0.2px/ms，稳定低于甩动通道的 0.5px/ms 门槛。
 *
 * 这样断言的就纯粹是距离门槛本身。用 samples() 的 16ms 步长会让任何位移都变成
 * 高速甩动，从而经由甩动通道触发，掩盖距离门槛的真实边界。
 */
function slowTrace(fromX: number, dx: number): TouchSample[] {
  return [{ x: fromX, y: 300, t: 0 }, { x: fromX + dx, y: 300, t: Math.round(Math.abs(dx) * 5) }]
}

test('横滑判定：方向、阈值与映射', () => {
  const base = { distanceRatio: 0.25, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth: 390 }
  assert.deepEqual(detectSidebarGesture(samples([[120, 300], [330, 302]]), base), { action: 'left', reason: 'ok' })
  assert.deepEqual(detectSidebarGesture(samples([[280, 300], [60, 305]]), base), { action: 'right', reason: 'ok' })
  assert.deepEqual(detectSidebarGesture(samples([[120, 300], [330, 302]]), { ...base, mapping: 'swap' }), { action: 'right', reason: 'ok' })
  assert.deepEqual(detectSidebarGesture(samples([[120, 300], [150, 300]]), base), { action: 'ignore', reason: 'threshold' })
  assert.deepEqual(detectSidebarGesture(samples([[120, 300]]), base), { action: 'ignore', reason: 'samples' })
  // 比例为 0 会让任何抖动都触发，超过 1 则永远跨不过，都按非法配置处理。
  assert.deepEqual(detectSidebarGesture(samples([[0, 0], [10, 0]]), { ...base, distanceRatio: 0 }), { action: 'ignore', reason: 'config' })
  assert.deepEqual(detectSidebarGesture(samples([[0, 0], [10, 0]]), { ...base, distanceRatio: 1.2 }), { action: 'ignore', reason: 'config' })
})

test('纵向滑动与贴边起手交回系统手势/滚动', () => {
  const base = { distanceRatio: 0.25, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth: 390 }
  // 斜向但纵向占优：不能抢走列表滚动（水平位移已过阈值，仅靠方向锁定拦下）。
  assert.deepEqual(detectSidebarGesture(samples([[200, 100], [400, 300]]), base), { action: 'ignore', reason: 'direction' })
  // 默认避开边缘热区，避免与 iOS/Android 返回手势打架；热区已收窄到 12px。
  assert.deepEqual(detectSidebarGesture(samples([[8, 300], [200, 300]]), base), { action: 'ignore', reason: 'edge' })
  assert.deepEqual(detectSidebarGesture(samples([[384, 300], [200, 300]]), base), { action: 'ignore', reason: 'edge' })
  // 12px 之外可以正常起手：这是收窄热区要换来的单手操作体验。
  assert.deepEqual(detectSidebarGesture(samples([[14, 300], [220, 300]]), base), { action: 'left', reason: 'ok' })
  // 显式允许贴边时才生效。
  assert.deepEqual(detectSidebarGesture(samples([[8, 300], [220, 300]]), { ...base, edgeMode: 'edge' }), { action: 'left', reason: 'ok' })
})

test('距离通道：跨过设定比例即触发，不再被速度二次否决', () => {
  const base = { distanceRatio: 0.25, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth: 390 }
  // 390px 视口的 25% 门槛为 97.5px；用慢速轨迹隔离出距离门槛本身。
  // 位移已超过甩动下限 48px，因此慢速时走的是甩动通道并因速度不足被拒（flick）。
  assert.deepEqual(detectSidebarGesture(slowTrace(120, 97), base), { action: 'ignore', reason: 'flick' })
  assert.deepEqual(detectSidebarGesture(slowTrace(120, 98), base), { action: 'left', reason: 'ok' })
  // 关键回归：位移达标后即使整段很慢也必须触发。旧实现用「距离 AND 末端速度」
  // 判定，正常滑动松手前会减速，导致用户需要重复滑动。
  assert.deepEqual(detectSidebarGesture(trace([[120, 300, 0], [320, 300, 800]]), base), { action: 'left', reason: 'ok' })
  assert.deepEqual(detectSidebarGesture(trace([[120, 300, 0], [200, 300, 300], [320, 300, 900]]), base), { action: 'left', reason: 'ok' })
  const wide = { ...base, viewportWidth: 1024 }
  // 1024px 视口 25% 门槛为 256px；位移不足时走甩动通道被速度拒绝。
  assert.deepEqual(detectSidebarGesture(slowTrace(200, 255), wide), { action: 'ignore', reason: 'flick' })
  assert.deepEqual(detectSidebarGesture(slowTrace(200, 256), wide), { action: 'left', reason: 'ok' })
})

test('甩动通道：距离不足时快速轻甩同样触发', () => {
  const base = { distanceRatio: 0.25, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth: 390 }
  // 60px 远低于 97.5px 门槛，但 100ms 内完成（平均 0.6px/ms）属于明确的快速甩动。
  assert.deepEqual(detectSidebarGesture(trace([[120, 300, 0], [180, 300, 100]]), base), { action: 'left', reason: 'ok' })
  assert.deepEqual(detectSidebarGesture(trace([[280, 300, 0], [220, 300, 100]]), base), { action: 'right', reason: 'ok' })
  // 同样距离但慢慢拖过去：不触发。
  assert.deepEqual(detectSidebarGesture(trace([[120, 300, 0], [180, 300, 400]]), base), { action: 'ignore', reason: 'flick' })
  // 位移不足甩动下限：可能是抖动或内容拖动，连甩动通道都不进入。
  assert.deepEqual(detectSidebarGesture(trace([[120, 300, 0], [150, 300, 30]]), base), { action: 'ignore', reason: 'threshold' })
  // 甩动通道的速度门槛可用配置覆盖，便于真机调参。
  assert.deepEqual(
    detectSidebarGesture(trace([[120, 300, 0], [180, 300, 300]]), { ...base, flickMinVelocityPxPerMs: 0.1 }),
    { action: 'left', reason: 'ok' },
  )
  assert.deepEqual(
    detectSidebarGesture(trace([[120, 300, 0], [180, 300, 100]]), { ...base, flickMinVelocityPxPerMs: 0 }),
    { action: 'ignore', reason: 'config' },
  )
})

test('距离通道与甩动通道是 OR 关系，两侧任一达标即触发', () => {
  const base = { distanceRatio: 0.25, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth: 390 }
  // 只满足距离（慢速长滑）
  assert.equal(detectSidebarGesture(trace([[60, 300, 0], [260, 300, 900]]), base).reason, 'ok')
  // 只满足甩动（快速短甩）
  assert.equal(detectSidebarGesture(trace([[160, 300, 0], [215, 300, 90]]), base).reason, 'ok')
  // 两者都不满足
  assert.equal(detectSidebarGesture(trace([[160, 300, 0], [190, 300, 500]]), base).reason, 'threshold')
})

test('起手阶段的轻微纵向漂移不会提前终止手势', () => {
  const base = { distanceRatio: 0.25, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth: 390 }
  // 真实手指起手常有几像素纵向漂移。位移还小的时候必须保持跟踪（返回 threshold），
  // 不能返回 direction 让控制器释放跟踪——那正是「需要滑两次」的直接原因。
  assert.equal(detectSidebarGesture(trace([[120, 300, 0], [125, 308, 16]]), base).reason, 'threshold')
  assert.equal(detectSidebarGesture(trace([[120, 300, 0], [126, 312, 16], [130, 314, 32]]), base).reason, 'threshold')
  // 运动量足够且纵向占优时，才判定为滚动意图并释放。
  assert.equal(detectSidebarGesture(trace([[120, 300, 0], [130, 400, 100]]), base).reason, 'direction')
  // 纵向漂移但横向仍占优：继续判定并最终触发。
  assert.equal(detectSidebarGesture(trace([[120, 300, 0], [180, 308, 80], [260, 310, 160]]), base).reason, 'ok')
})

test('比例设置直接决定各视口门槛，不再被硬下限吞掉', () => {
  const at = (viewportWidth: number, distanceRatio: number) => ({ distanceRatio, edgeMode: 'avoid' as const, mapping: 'swipe-inward' as const, viewportWidth })
  // 同一比例在 360px 与 1024px 上换算出的像素门槛严格成比例：这正是改用比例的目的。
  // 用慢速轨迹隔离距离门槛，避免甩动通道提前触发。
  for (const [viewportWidth, expectedPx] of [[360, 90], [390, 98], [430, 108], [1024, 256]] as const) {
    assert.deepEqual(
      detectSidebarGesture(slowTrace(100, expectedPx - 1), at(viewportWidth, 0.25)),
      { action: 'ignore', reason: 'flick' },
      `${viewportWidth}px 视口位移不足 ${expectedPx}px 不应触发`,
    )
    assert.deepEqual(
      detectSidebarGesture(slowTrace(100, expectedPx), at(viewportWidth, 0.25)),
      { action: 'left', reason: 'ok' },
      `${viewportWidth}px 视口位移达到 ${expectedPx}px 应触发`,
    )
  }
  // 调低比例让手势更灵敏：15% 在 390px 上只需 58.5px。
  assert.deepEqual(detectSidebarGesture(slowTrace(100, 58), at(390, 0.15)), { action: 'ignore', reason: 'flick' })
  assert.deepEqual(detectSidebarGesture(slowTrace(100, 59), at(390, 0.15)), { action: 'left', reason: 'ok' })
  // 调高比例让手势更严格：80% 在 390px 上需要 312px。
  assert.deepEqual(detectSidebarGesture(slowTrace(40, 311), at(390, 0.8)), { action: 'ignore', reason: 'flick' })
  assert.deepEqual(detectSidebarGesture(slowTrace(40, 312), at(390, 0.8)), { action: 'left', reason: 'ok' })
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

let syntheticTouchTime = 0

function touchEvent(x: number, y: number, options: { target?: unknown; cancelable?: boolean; path?: readonly unknown[]; timeStamp?: number; touches?: readonly [number, number][] } = {}): { touches: { clientX: number; clientY: number }[]; target?: unknown; cancelable: boolean; prevented: number; timeStamp: number; preventDefault(): void; composedPath(): readonly unknown[] } {
  const points = options.touches ?? [[x, y] as [number, number]]
  const event = {
    touches: points.map(([clientX, clientY]) => ({ clientX, clientY })),
    target: options.target,
    cancelable: options.cancelable ?? true,
    timeStamp: options.timeStamp ?? (syntheticTouchTime += 16),
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
  harness.window.emit('touchmove', touchEvent(330, 304))
  assert.deepEqual(harness.calls, ['left'])
  assert.deepEqual(harness.vibrations, [10])

  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(60, 302))
  // 第一次右滑已经呼出左栏，随后左滑应收回左栏，不能误打开右栏。
  assert.deepEqual(harness.calls, ['left', 'left'])
  assert.deepEqual(harness.vibrations, [10, 10])
  assert.equal(harness.isExpanded(), false)
  assert.deepEqual(harness.window.pushed, [])

  // 左栏收回后再次左滑才打开右栏；返回手势先关右栏，而不是退出会话。
  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(60, 302))
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
  window.emit('touchmove', touchEvent(60, 302))
  assert.deepEqual(calls, ['left'])
  assert.equal(leftCollapsed, true)
  assert.equal(rightExpanded, false)
  controller.dispose()
})

test('右栏已展开时，反向物理右滑关闭右栏且不再切换左栏', () => {
  const harness = createHarness()

  // 默认映射下物理左滑呼出右栏。
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(60, 302))
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(harness.isExpanded(), true)
  assert.deepEqual(harness.window.pushed, [{ codingnsRightbar: true }])

  // 反向右滑只关闭右栏，不应同时呼出左栏。
  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(120, 300))
  harness.window.emit('touchmove', touchEvent(330, 302))
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
  window.emit('touchmove', touchEvent(60, 302))
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

  // 捏合或多指滑动不参与侧栏手势，避免缩放过程中误触发开合。
  harness.window.emit('touchstart', touchEvent(120, 300, { touches: [[120, 300], [140, 300]] }))
  harness.window.emit('touchmove', touchEvent(330, 300))
  assert.deepEqual(harness.calls, [])
})

test('横向滚动容器优先接收右滑，不收起右栏', () => {
  const harness = createHarness()
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(60, 300))
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
  const move = touchEvent(330, 300, { target: text })
  harness.window.emit('touchmove', move)

  assert.deepEqual(harness.calls, ['right'])
  assert.equal(harness.isExpanded(), true)
  assert.equal(move.prevented, 0)

  // Shadow DOM 重定向后，event.target 可能只有宿主；composedPath 仍应找到滚动祖先。
  const shadowHost = { closest: () => null }
  harness.window.emit('touchstart', touchEvent(120, 300, { target: shadowHost, path: [text, scrollable] }))
  const shadowMove = touchEvent(330, 300, { target: shadowHost, path: [text, scrollable] })
  harness.window.emit('touchmove', shadowMove)
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(shadowMove.prevented, 0)

  // 左滑不负责收起右栏，即使布局尺寸尚未更新也必须交给内部内容。
  const pendingLayout = { scrollWidth: 320, clientWidth: 320, style: { overflowX: 'auto' }, parentElement: null }
  const pendingTarget = { parentElement: pendingLayout, closest: () => null }
  harness.window.emit('touchstart', touchEvent(300, 300, { target: pendingTarget }))
  const pendingMove = touchEvent(60, 300, { target: pendingTarget })
  harness.window.emit('touchmove', pendingMove)
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(pendingMove.prevented, 0)

  // 右栏宿主本身没有暴露滚动尺寸时，左滑仍不能调用任何收起服务。
  const rightbarPanel = {
    closest: (selector: string) => selector === '[data-sidebar-right-session]' ? rightbarPanel : null,
  }
  harness.window.emit('touchstart', touchEvent(300, 300, { target: rightbarPanel }))
  const rightbarMove = touchEvent(60, 300, { target: rightbarPanel })
  harness.window.emit('touchmove', rightbarMove)
  assert.deepEqual(harness.calls, ['right'])
  assert.equal(rightbarMove.prevented, 0)

  harness.window.emit('touchend', { touches: [] })
  harness.window.emit('touchstart', touchEvent(120, 300, { target: rightbarPanel }))
  const closeMove = touchEvent(330, 300, { target: rightbarPanel })
  harness.window.emit('touchmove', closeMove)
  assert.deepEqual(harness.calls, ['right', 'right'])
  assert.equal(harness.isExpanded(), false)
})

test('消息区域的横向滚动祖先优先接收手势，不触发侧栏', () => {
  const harness = createHarness()
  const chatScroller = {
    scrollWidth: 720,
    clientWidth: 320,
    scrollLeft: 200,
    style: { overflowX: 'auto' },
    parentElement: null,
  }
  const chatTarget = { parentElement: chatScroller, closest: () => null }

  // 模拟消息中的表格或代码块包装器：右栏未展开时也必须由内容接收右滑。
  harness.window.emit('touchstart', touchEvent(120, 300, { target: chatTarget }))
  harness.window.emit('touchmove', touchEvent(330, 300, { target: chatTarget }))
  assert.deepEqual(harness.calls, [])
  harness.window.emit('touchend', { touches: [] })

  // 即使内容已经位于左边界，左滑也不能回退成侧栏开合，避免边界拖动误触。
  chatScroller.scrollLeft = 0
  harness.window.emit('touchstart', touchEvent(280, 300, { target: chatTarget }))
  harness.window.emit('touchmove', touchEvent(60, 300, { target: chatTarget }))
  assert.deepEqual(harness.calls, [])
})

test('右栏标签条即使没有溢出也保留双向横滑，不触发侧栏开合', () => {
  const harness = createHarness()
  harness.window.emit('touchstart', touchEvent(280, 300))
  harness.window.emit('touchmove', touchEvent(60, 300))
  assert.deepEqual(harness.calls, ['right'])
  harness.window.emit('touchend', {})

  const strip = {
    // 这里故意没有滚动宽度：标签条始终由原生交互接管，与是否溢出无关。
    closest: (selector: string) => selector.includes('[data-sidebar-right-panel] [data-dockkit-strip]') ? strip : null,
  }
  for (const [start, end] of [[120, 330], [280, 60]]) {
    harness.window.emit('touchstart', touchEvent(start!, 300, { target: strip }))
    const move = touchEvent(end!, 300, { target: strip })
    harness.window.emit('touchmove', move)
    assert.equal(move.prevented, 0)
    assert.deepEqual(harness.calls, ['right'])
    harness.window.emit('touchend', {})
  }
  assert.equal(harness.isExpanded(), true)
  harness.controller.dispose()
})

test('标签条在 composedPath 或后续 move 中出现时同样让位原生滚动', () => {
  const harness = createHarness()
  const strip = {
    closest: (selector: string) => selector.includes('[data-sidebar-right-panel] [data-dockkit-strip]') ? strip : null,
  }
  const shadowHost = { closest: () => null }
  harness.window.emit('touchstart', touchEvent(120, 300, { target: shadowHost, path: [strip] }))
  const shadowMove = touchEvent(330, 300, { target: shadowHost, path: [strip] })
  harness.window.emit('touchmove', shadowMove)
  assert.equal(shadowMove.prevented, 0)
  assert.deepEqual(harness.calls, [])
  harness.window.emit('touchend', {})

  harness.window.emit('touchstart', touchEvent(280, 300, { target: shadowHost }))
  const lateMove = touchEvent(60, 300, { target: strip })
  harness.window.emit('touchmove', lateMove)
  assert.equal(lateMove.prevented, 0)
  assert.deepEqual(harness.calls, [])
  harness.controller.dispose()
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
