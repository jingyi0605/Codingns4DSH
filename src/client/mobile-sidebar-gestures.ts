/**
 * 移动端侧栏手势控制器。
 *
 * 判定逻辑抽成纯函数 `detectSidebarGesture`，控制器只负责采样与调用服务：
 * 左栏走 `ctx.layout.toggleSidebar()`，右栏走 `ctx.sidebarRight.toggleExpanded()`。
 * 这里不修改任何 DOM class 或 DSH store，因此侧栏宽度、动画与持久化仍由 DSH 自己维护。
 *
 * 与系统手势的关系：屏幕边缘热区默认让给系统返回手势（`avoid` 模式），手势在
 * 方向锁定失败时立即释放，不 intercept 滚动。
 */

import { vibrateMobile, type MobileVibrationGlobalLike } from './mobile-vibration.js'

export type SidebarGestureAction = 'left' | 'right' | 'ignore'

export interface TouchSample {
  readonly x: number
  readonly y: number
  readonly t: number
}

export interface SidebarGestureConfig {
  /** 兼容设置中的触发阈值（像素）；实际阈值不会低于视口宽度的 50%。 */
  readonly thresholdPx: number
  /** 起手区域：`avoid` 避开系统边缘热区。 */
  readonly edgeMode: 'avoid' | 'edge'
  /** 方向映射：`swipe-inward` 为右滑开合左栏、左滑开合右栏；`swap` 互换。 */
  readonly mapping: 'swipe-inward' | 'swap'
  /** 当前视口宽度；用于判断右侧热区。 */
  readonly viewportWidth: number
  /** 边缘热区宽度，默认 24px。 */
  readonly edgeZonePx?: number
  /** 方向锁定比（水平位移至少是垂直位移的多少倍），默认 1.5。 */
  readonly directionRatio?: number
  /** 最低水平速度（像素/毫秒），默认 0.4，即约 400 像素/秒。 */
  readonly minVelocityPxPerMs?: number
  /** 速度采样窗口（毫秒），默认 120。 */
  readonly velocityWindowMs?: number
}

export interface SidebarGestureDecision {
  readonly action: SidebarGestureAction
  /** 稳定原因码，用于诊断与测试断言。 */
  readonly reason: 'ok' | 'samples' | 'config' | 'edge' | 'threshold' | 'direction' | 'velocity'
}

export const DEFAULT_GESTURE_EDGE_ZONE_PX = 24
export const DEFAULT_GESTURE_DIRECTION_RATIO = 1.5
/** 侧栏全局手势至少跨过半个视口，避免轻微横移误触。 */
export const DEFAULT_GESTURE_DISTANCE_RATIO = 0.5
/** 采用约 400px/s 的最低水平速度，避免缓慢拖动触发开合。 */
export const DEFAULT_GESTURE_MIN_VELOCITY_PX_PER_MS = 0.4
/** 只看最近一小段轨迹，避免停顿稀释释放瞬间的滑动速度。 */
export const DEFAULT_GESTURE_VELOCITY_WINDOW_MS = 120
/** 与 DSH 窄屏断点保持一致；超过该宽度不安装全局触摸监听。 */
export const DEFAULT_MOBILE_GESTURE_VIEWPORT_MAX_PX = 1024

/** 纯函数：只依据样本与配置给出动作，不读 DOM、不调服务。 */
export function detectSidebarGesture(samples: readonly TouchSample[], config: SidebarGestureConfig): SidebarGestureDecision {
  const thresholdPx = Number.isFinite(config.thresholdPx) ? config.thresholdPx : Number.NaN
  const viewportWidth = Number.isFinite(config.viewportWidth) ? config.viewportWidth : 0
  if (!Number.isFinite(thresholdPx) || thresholdPx <= 0 || viewportWidth <= 0) return { action: 'ignore', reason: 'config' }
  if (samples.length < 2) return { action: 'ignore', reason: 'samples' }
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const edgeZone = config.edgeZonePx ?? DEFAULT_GESTURE_EDGE_ZONE_PX
  if (config.edgeMode === 'avoid' && (first.x <= edgeZone || first.x >= viewportWidth - edgeZone)) {
    return { action: 'ignore', reason: 'edge' }
  }
  const dx = last.x - first.x
  const dy = last.y - first.y
  const effectiveThresholdPx = resolveEffectiveThresholdPx(thresholdPx, viewportWidth)
  if (Math.abs(dx) < effectiveThresholdPx) return { action: 'ignore', reason: 'threshold' }
  const ratio = config.directionRatio ?? DEFAULT_GESTURE_DIRECTION_RATIO
  if (Math.abs(dx) < Math.abs(dy) * ratio) return { action: 'ignore', reason: 'direction' }
  const minVelocity = config.minVelocityPxPerMs ?? DEFAULT_GESTURE_MIN_VELOCITY_PX_PER_MS
  if (!Number.isFinite(minVelocity) || minVelocity <= 0) return { action: 'ignore', reason: 'config' }
  const velocity = horizontalVelocity(samples, config.velocityWindowMs ?? DEFAULT_GESTURE_VELOCITY_WINDOW_MS)
  if (velocity === undefined || velocity < minVelocity) return { action: 'ignore', reason: 'velocity' }
  const inward = dx > 0 ? 'left' : 'right'
  const action = config.mapping === 'swap' ? (inward === 'left' ? 'right' : 'left') : inward
  return { action, reason: 'ok' }
}

export interface SidebarGestureSettings {
  readonly sidebarGestures: boolean
  readonly sidebarGestureMapping: 'swipe-inward' | 'swap'
  readonly sidebarGestureEdge: 'avoid' | 'edge'
  readonly sidebarGestureThresholdPx: number
}

export interface SidebarGesturePorts {
  /** `ctx.layout`：只用到左栏开合。 */
  readonly layout?: { toggleSidebar(): void } | undefined
  /** `ctx.sidebarRight`：右栏开合与状态。 */
  readonly sidebarRight?: { isExpanded(): boolean; toggleExpanded(): void } | undefined
}

export interface SidebarGestureWindowLike {
  addEventListener(type: string, listener: (event: never) => void, options?: unknown): void
  removeEventListener(type: string, listener: (event: never) => void, options?: unknown): void
  history?: { pushState(data: unknown, title: string): void } | undefined
  innerWidth?: number | undefined
  navigator?: { maxTouchPoints?: number | undefined } | undefined
  ontouchstart?: unknown
}

export interface SidebarGestureDocumentLike {
  addEventListener(type: string, listener: (event: never) => void, options?: unknown): void
  removeEventListener(type: string, listener: (event: never) => void, options?: unknown): void
}

export interface MobileSidebarGestureOptions {
  readonly ports: SidebarGesturePorts
  readonly settings: () => SidebarGestureSettings
  /** 读取左栏折叠状态（来自 `data-sidebar-collapsed` 等 DOM 钩子）；缺失时使用内部兜底状态。 */
  readonly readLeftCollapsed?: (() => boolean | undefined) | undefined
  readonly onDiagnostic?: ((code: string) => void) | undefined
  /** 手势成功后的可选触感反馈；缺省使用浏览器 navigator.vibrate。 */
  readonly vibrate?: ((pattern: number) => boolean | void) | undefined
  readonly window?: SidebarGestureWindowLike | undefined
  readonly document?: SidebarGestureDocumentLike | undefined
  /** 移动端视口上限；缺省与 DSH 窄屏断点一致。 */
  readonly viewportMaxPx?: number | undefined
}

export interface MobileSidebarGestureController {
  dispose(): void
  /** 设置变化后重新评估是否需要监听；返回当前是否处于激活状态。 */
  refresh(): boolean
}

export const GESTURE_DIAGNOSTIC_CAPABILITY_MISSING = 'CODINGNS_GESTURE_CAPABILITY_MISSING'
export const GESTURE_DIAGNOSTIC_NOT_MOBILE = 'CODINGNS_GESTURE_NOT_MOBILE'

/** 启动手势控制器；未启用或没有任何可用端口时不注册任何监听。 */
export function startMobileSidebarGestures(options: MobileSidebarGestureOptions): MobileSidebarGestureController {
  const hostWindow = options.window ?? (globalThis as unknown as { window?: SidebarGestureWindowLike }).window
  const hostDocument = options.document ?? (globalThis as unknown as { document?: SidebarGestureDocumentLike }).document
  let active = false
  let samples: TouchSample[] = []
  let tracking = false
  let claimed = false
  let rightbarTouch = false
  let scrollableTouch = false
  let rightbarHistoryPushed = false
  // 只有宿主没有提供左栏 DOM 状态时才使用这个乐观状态，保证测试环境和
  // 尚未完成 DOM 挂载的 WebView 仍能连续完成“打开后左滑关闭”。
  let leftCollapsedFallback: boolean | undefined

  const onResize = (): void => { refresh() }

  const onTouchStart = (event: unknown): void => {
    if (touchCount(event) !== 1) {
      resetTracking()
      return
    }
    const touch = firstTouch(event)
    if (touch === null) return
    // 横向滚动容器优先接收触摸。右栏里的代码块、长文本和表格经常需要
    // 左右拖动；如果这里继续记录样本，window 的全局监听会把右滑误判为
    // “收起右栏”，浏览器也会因为后续 preventDefault 而丢掉原生滚动。
    if (isEditableTouch(touch)) {
      tracking = false
      claimed = false
      rightbarTouch = false
      scrollableTouch = false
      samples = []
      return
    }
    tracking = true
    claimed = false
    scrollableTouch = hasHorizontalScrollableTarget(touch)
    // 横向滚动能力是内容优先级的稳定信号；消息中的表格、代码块和长文本都应
    // 保留左右拖动，不应因为右栏当前未展开就被全局侧栏手势抢走。
    rightbarTouch = isExpandedRightbar() && (isRightbarTarget(touch) || scrollableTouch)
    samples = [{ x: touch.x, y: touch.y, t: eventTime(event) }]
  }
  const onTouchMove = (event: unknown): void => {
    if (!tracking) return
    if (touchCount(event) > 1) {
      resetTracking()
      return
    }
    const touch = firstTouch(event)
    if (touch === null) return
    // 某些 WebView 在 touchstart 时只暴露宿主节点，直到 touchmove 才能从
    // composedPath() 看到真正的滚动节点；这里再次检查，避免已经开始采样后
    // 仍被全局侧栏手势抢走。
    if (isEditableTouch(touch)) {
      tracking = false
      claimed = false
      rightbarTouch = false
      scrollableTouch = false
      samples = []
      return
    }
    samples.push({ x: touch.x, y: touch.y, t: eventTime(event) })
    // 事件目标在部分 WebView 中会在 touchmove 才暴露真实宿主；右栏归属和横向
    // 滚动祖先都要同步补探测，避免 Shadow DOM 或消息表格漏掉让位判断。
    rightbarTouch ||= isExpandedRightbar() && isRightbarTarget(touch)
    scrollableTouch ||= hasHorizontalScrollableTarget(touch)
    const config = resolveConfig(options)
    const horizontalDirection = detectHorizontalDirection(samples, config)
    const shouldYieldToContent = horizontalDirection !== null
      && (scrollableTouch || (rightbarTouch && horizontalDirection < 0))
    if (shouldYieldToContent) {
      // 可横向滚动内容无论当前是否处于滚动边界都优先接收手势，避免消息表格、
      // 代码块在边界处的拖动被误判为侧栏开合；右栏非滚动面板的左滑仍交给面板。
      tracking = false
      claimed = false
      rightbarTouch = false
      scrollableTouch = false
      samples = []
      return
    }
    if (!claimed) {
      const decision = detectSidebarGesture(samples, resolveConfig(options))
      if (decision.reason === 'ok') {
        const handled = applyAction(decision.action, horizontalDirection ?? undefined)
        if (!handled) {
          // 右栏展开时的物理左滑没有侧栏动作，释放本次触摸，避免既阻止
          // 原生内容交互又在后续 move 中重复判定。
          tracking = false
          samples = []
          return
        }
        claimed = true
        preventDefault(event)
        return
      }
      if (decision.reason === 'direction') {
        // 纵向意图明确：立刻释放，避免影响列表滚动。
        tracking = false
        samples = []
        return
      }
    }
    if (claimed) preventDefault(event)
  }
  const onTouchEnd = (): void => {
    resetTracking()
  }
  const onPopState = (): void => {
    if (!rightbarHistoryPushed) return
    rightbarHistoryPushed = false
    if (options.ports.sidebarRight?.isExpanded() === true) options.ports.sidebarRight.toggleExpanded()
  }

  const applyAction = (action: SidebarGestureAction, physicalDirection?: -1 | 1): boolean => {
    if (action === 'ignore') return false
    const sidebarRight = options.ports.sidebarRight
    if (sidebarRight?.isExpanded() === true) {
      if (physicalDirection === 1) {
        triggerVibration(10)
        sidebarRight.toggleExpanded()
        rightbarHistoryPushed = false
        return true
      }
      // 右栏打开时，物理左滑只交给内部内容，不再触发任何收起动作。
      return false
    }
    // 仅在手势真正触发开合后反馈，避免滚动和方向锁定失败时误振动。
    triggerVibration(10)
    if (action === 'left') {
      toggleLeftSidebar()
      return true
    }
    // 默认映射下物理左滑会得到 `right` 动作。左栏已经展开时，用户的意图
    // 是收回刚刚呼出的左栏，而不是再打开右栏；优先关闭左栏才能保持手势
    // 的方向直觉。`swap` 映射下物理左滑本身已经映射为 `left`，同样由上方
    // 分支处理。
    if (readLeftCollapsed() === false && options.ports.layout !== undefined) {
      toggleLeftSidebar()
      return true
    }
    if (sidebarRight === undefined) return false
    const wasExpanded = sidebarRight.isExpanded() === true
    sidebarRight.toggleExpanded()
    if (wasExpanded) {
      // 同方向再次触发也可能关闭右栏，保持历史状态与实际面板一致。
      rightbarHistoryPushed = false
      return true
    }
    if (!wasExpanded && sidebarRight.isExpanded() === true && hostWindow?.history !== undefined) {
      // 全屏右栏压入一条历史记录：Android 返回手势与 iOS 边缘返回先关右栏。
      try {
        hostWindow.history.pushState({ codingnsRightbar: true }, '')
        rightbarHistoryPushed = true
      } catch {
        rightbarHistoryPushed = false
      }
    }
    return true
  }

  const readLeftCollapsed = (): boolean | undefined => {
    const reported = options.readLeftCollapsed?.()
    return reported ?? leftCollapsedFallback
  }

  const isExpandedRightbar = (): boolean => {
    try {
      return options.ports.sidebarRight?.isExpanded() === true
    } catch {
      return false
    }
  }

  /**
   * 将振动调用绑定到实际接收触摸事件的 Window。
   *
   * DSH 的客户端代码由模块加载器注入执行，模块里的 `globalThis` 在部分
   * Android WebView 中不一定就是承载触摸事件的页面 Window。直接使用它会
   * 让 `navigator.vibrate()` 静默降级；优先从 hostWindow 读取 navigator，
   * 才能保证手势和振动属于同一个浏览器上下文。
   */
  const triggerVibration = (pattern: number): void => {
    if (options.vibrate !== undefined) {
      try {
        options.vibrate(pattern)
      } catch {
        // 可选触感能力失败时不能影响侧栏开合。
      }
      return
    }
    const pageGlobal = hostWindow as unknown as MobileVibrationGlobalLike | undefined
    if (typeof pageGlobal?.navigator?.vibrate === 'function') {
      vibrateMobile(pattern, pageGlobal)
      return
    }
    // 测试环境或宿主窗口没有 navigator 时仍保留全局环境的兼容回退。
    vibrateMobile(pattern)
  }

  const toggleLeftSidebar = (): void => {
    const reported = options.readLeftCollapsed?.()
    const before = reported ?? leftCollapsedFallback
    options.ports.layout?.toggleSidebar()
    // DOM 状态是宿主的唯一事实来源；只有它缺失时才更新本地兜底值。首次
    // 触发左栏切换按“由收起态呼出”处理，后续手势即可得到稳定的开合语义。
    if (reported === undefined) leftCollapsedFallback = before === undefined ? false : !before
  }

  const resetTracking = (): void => {
    tracking = false
    claimed = false
    rightbarTouch = false
    scrollableTouch = false
    samples = []
  }

  const attach = (): void => {
    if (active) return
    active = true
    hostWindow?.addEventListener('touchstart', onTouchStart as (event: never) => void, { passive: true })
    hostWindow?.addEventListener('touchmove', onTouchMove as (event: never) => void, { passive: false })
    hostWindow?.addEventListener('touchend', onTouchEnd as (event: never) => void, { passive: true })
    hostWindow?.addEventListener('touchcancel', onTouchEnd as (event: never) => void, { passive: true })
    hostWindow?.addEventListener('popstate', onPopState as (event: never) => void)
  }
  const detach = (): void => {
    if (!active) return
    active = false
    hostWindow?.removeEventListener('touchstart', onTouchStart as (event: never) => void)
    hostWindow?.removeEventListener('touchmove', onTouchMove as (event: never) => void)
    hostWindow?.removeEventListener('touchend', onTouchEnd as (event: never) => void)
    hostWindow?.removeEventListener('touchcancel', onTouchEnd as (event: never) => void)
    hostWindow?.removeEventListener('popstate', onPopState as (event: never) => void)
    onTouchEnd()
  }

  const refresh = (): boolean => {
    const settings = options.settings()
    const hasLayout = options.ports.layout !== undefined
    const hasRight = options.ports.sidebarRight !== undefined
    const hasAnyPort = hasLayout || hasRight
    const wanted = settings.sidebarGestures && hasAnyPort && isMobileTouchViewport(
      hostWindow,
      options.viewportMaxPx ?? DEFAULT_MOBILE_GESTURE_VIEWPORT_MAX_PX,
    )
    if (settings.sidebarGestures && hasAnyPort && !wanted) {
      options.onDiagnostic?.(GESTURE_DIAGNOSTIC_NOT_MOBILE)
    }
    if (settings.sidebarGestures && !hasAnyPort) {
      // 用户打开了手势但布局服务整体不可用：不挂监听，并留下可解释诊断。
      options.onDiagnostic?.(GESTURE_DIAGNOSTIC_CAPABILITY_MISSING)
    }
    if (wanted && !active) {
      if (!hasLayout || !hasRight) options.onDiagnostic?.(GESTURE_DIAGNOSTIC_CAPABILITY_MISSING)
      attach()
    } else if (!wanted && active) detach()
    return active
  }

  if (hostDocument === undefined && hostWindow === undefined) options.onDiagnostic?.(GESTURE_DIAGNOSTIC_CAPABILITY_MISSING)
  hostWindow?.addEventListener('resize', onResize as (event: never) => void)
  refresh()
  return {
    dispose() {
      detach()
      hostWindow?.removeEventListener('resize', onResize as (event: never) => void)
    },
    refresh,
  }
}

/** 只在窄屏或明确存在触摸点的设备上启用，避免桌面触摸屏误抢滚动。 */
function isMobileTouchViewport(windowLike: SidebarGestureWindowLike | undefined, maxPx: number): boolean {
  const width = windowLike?.innerWidth
    ?? (globalThis as unknown as { innerWidth?: number }).innerWidth
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return false
  if (!Number.isFinite(maxPx) || maxPx <= 0 || width > maxPx) return false
  const maxTouchPoints = windowLike?.navigator?.maxTouchPoints
  if (typeof maxTouchPoints === 'number' && Number.isFinite(maxTouchPoints)) return maxTouchPoints > 0
  // 某些 WebView 不暴露 maxTouchPoints；窄屏 fallback 保证 Android WebView 能工作。
  return true
}

function resolveConfig(options: MobileSidebarGestureOptions): SidebarGestureConfig {
  const settings = options.settings()
  const viewportWidth = typeof options.window?.innerWidth === 'number' && options.window.innerWidth > 0
    ? options.window.innerWidth
    : typeof (globalThis as unknown as { innerWidth?: unknown }).innerWidth === 'number'
      ? (globalThis as unknown as { innerWidth: number }).innerWidth
      : 0
  return {
    thresholdPx: settings.sidebarGestureThresholdPx,
    edgeMode: settings.sidebarGestureEdge,
    mapping: settings.sidebarGestureMapping,
    viewportWidth,
  }
}

function resolveEffectiveThresholdPx(thresholdPx: number, viewportWidth: number): number {
  return Math.max(thresholdPx, viewportWidth * DEFAULT_GESTURE_DISTANCE_RATIO)
}

interface TouchPoint {
  readonly x: number
  readonly y: number
  readonly target: unknown
  readonly path: readonly unknown[]
}

function firstTouch(event: unknown): TouchPoint | null {
  if (typeof event !== 'object' || event === null) return null
  const list = (event as { touches?: unknown }).touches
  if (typeof list !== 'object' || list === null) return null
  const first = (list as { 0?: unknown })[0]
  if (typeof first !== 'object' || first === null) return null
  const x = (first as { clientX?: unknown }).clientX
  const y = (first as { clientY?: unknown }).clientY
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y, target: (event as { target?: unknown }).target, path: composedPathOf(event) }
}

function touchCount(event: unknown): number {
  if (typeof event !== 'object' || event === null) return 0
  const list = (event as { touches?: unknown }).touches
  if (typeof list !== 'object' || list === null) return 0
  const length = (list as { length?: unknown }).length
  return typeof length === 'number' && Number.isFinite(length) ? length : 0
}

function isEditableTouch(touch: TouchPoint): boolean {
  const targets = [touch.target, ...touch.path]
  return targets.some((target) => isEditableTarget(target))
}

function hasHorizontalScrollableTarget(touch: TouchPoint): boolean {
  const targets = [touch.target, ...touch.path]
  return targets.some((target) => isHorizontalScrollableTarget(target))
}

function isRightbarTarget(touch: TouchPoint): boolean {
  const visited = new Set<object>()
  for (const target of [touch.target, ...touch.path]) {
    let current: unknown = target
    for (let depth = 0; depth < 64 && isObjectLike(current); depth += 1) {
      if (visited.has(current)) break
      visited.add(current)
      const closest = (current as { closest?: unknown }).closest
      if (typeof closest === 'function') {
        try {
          if ((closest as (selector: string) => unknown).call(current, '[data-sidebar-right-session]') !== null) return true
        } catch {
          // 事件路径中的 Window、Document 或 ShadowRoot 可能没有可用的 closest。
        }
      }
      current = parentElementOf(current)
    }
  }
  return false
}

function detectHorizontalDirection(samples: readonly TouchSample[], config: SidebarGestureConfig): -1 | 1 | null {
  if (samples.length < 2) return null
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const dx = last.x - first.x
  const dy = last.y - first.y
  const thresholdPx = Number.isFinite(config.thresholdPx) ? config.thresholdPx : Number.NaN
  const ratio = config.directionRatio ?? DEFAULT_GESTURE_DIRECTION_RATIO
  if (!(Number.isFinite(thresholdPx)
    && thresholdPx > 0
    && Math.abs(dx) >= resolveEffectiveThresholdPx(thresholdPx, config.viewportWidth)
    && Math.abs(dx) >= Math.abs(dy) * ratio)) return null
  return dx > 0 ? 1 : -1
}

/** 计算最近速度窗口内的水平速度；反向回滑不算作有效速度。 */
function horizontalVelocity(samples: readonly TouchSample[], windowMs: number): number | undefined {
  if (samples.length < 2 || !Number.isFinite(windowMs) || windowMs <= 0) return undefined
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const totalDx = last.x - first.x
  if (totalDx === 0) return 0

  let baseline = first
  for (const sample of samples) {
    const elapsed = last.t - sample.t
    if (elapsed > 0 && elapsed <= windowMs) {
      baseline = sample
      break
    }
  }
  const elapsed = last.t - baseline.t
  if (!(elapsed > 0)) return undefined
  const dx = last.x - baseline.x
  if (dx === 0 || Math.sign(dx) !== Math.sign(totalDx)) return 0
  return Math.abs(dx) / elapsed
}

function composedPathOf(event: object): readonly unknown[] {
  const method = (event as { composedPath?: unknown }).composedPath
  if (typeof method !== 'function') return []
  try {
    const path = (method as () => unknown).call(event)
    return Array.isArray(path) ? path : []
  } catch {
    return []
  }
}

function preventDefault(event: unknown): void {
  try {
    const cancelable = (event as { cancelable?: unknown }).cancelable
    const method = (event as { preventDefault?: unknown }).preventDefault
    if (cancelable !== false && typeof method === 'function') (method as () => void).call(event)
  } catch {
    // 事件可能已被浏览器标记为不可取消；忽略即可，不影响手势结果。
  }
}

/** 输入框、可选文本与终端内部的触摸不参与手势。 */
function isEditableTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false
  const closest = (target as { closest?: unknown }).closest
  if (typeof closest !== 'function') return false
  try {
    return (closest as (selector: string) => unknown).call(
      target,
      'input, textarea, select, [contenteditable="true"], [data-sidebar-terminal], .xterm, .cm-editor',
    ) !== null
  } catch {
    return false
  }
}

/**
 * 判断触摸点是否位于可横向滚动的元素或其后代中。消息里的表格、代码块和长文本
 * 包装器都依赖这个判断获得全局侧栏手势让位。
 *
 * 必须同时具备横向滚动样式和实际的 `scrollWidth > clientWidth`。只设置
 * `overflow: auto` 的聊天纵向列表不能因此抢走左右侧栏唤起手势。
 */
export function isHorizontalScrollableTarget(target: unknown): boolean {
  let current: unknown = target
  const visited = new Set<object>()
  for (let depth = 0; depth < 32 && isObjectLike(current); depth += 1) {
    if (visited.has(current)) return false
    visited.add(current)
    if (isHorizontalScrollableElement(current)) return true
    current = parentElementOf(current)
  }
  return false
}

function isHorizontalScrollableElement(element: object): boolean {
  const scrollWidth = finiteNumber((element as { scrollWidth?: unknown }).scrollWidth)
  const clientWidth = finiteNumber((element as { clientWidth?: unknown }).clientWidth)
  const overflowX = readOverflowX(element)
  const canScrollX = overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay'
  if (!canScrollX) return false
  return scrollWidth !== undefined && clientWidth !== undefined && scrollWidth > clientWidth + 1
}

function readOverflowX(element: object): string | undefined {
  const style = (element as { style?: { overflow?: unknown; overflowX?: unknown } }).style
  const inline = typeof style?.overflowX === 'string' && style.overflowX.trim() !== ''
    ? style.overflowX
    : typeof style?.overflow === 'string' && style.overflow.trim() !== ''
      ? style.overflow
      : undefined
  if (inline !== undefined) return normalizeOverflowValue(inline)
  const ownerDocument = (element as { ownerDocument?: unknown }).ownerDocument
  const view = isObjectLike(ownerDocument)
    ? (ownerDocument as { defaultView?: unknown }).defaultView
    : undefined
  const getComputedStyle = isObjectLike(view)
    ? (view as { getComputedStyle?: unknown }).getComputedStyle
    : undefined
  if (typeof getComputedStyle !== 'function') return undefined
  try {
    const computed = (getComputedStyle as (element: object) => { overflowX?: unknown }).call(view, element)
    return typeof computed?.overflowX === 'string' ? normalizeOverflowValue(computed.overflowX) : undefined
  } catch {
    return undefined
  }
}

function normalizeOverflowValue(value: string): string {
  return value.trim().toLowerCase().split(/\s+/u)[0] ?? ''
}

function parentElementOf(value: object): unknown {
  const parentElement = (value as { parentElement?: unknown }).parentElement
  if (isObjectLike(parentElement)) return parentElement
  const parentNode = (value as { parentNode?: unknown }).parentNode
  return isObjectLike(parentNode) ? parentNode : undefined
}

function isObjectLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function now(): number {
  const performanceLike = (globalThis as unknown as { performance?: { now?: () => number } }).performance
  return typeof performanceLike?.now === 'function' ? performanceLike.now() : Date.now()
}

function eventTime(event: unknown): number {
  if (typeof event === 'object' && event !== null) {
    const timeStamp = (event as { timeStamp?: unknown }).timeStamp
    if (typeof timeStamp === 'number' && Number.isFinite(timeStamp)) return timeStamp
  }
  return now()
}
