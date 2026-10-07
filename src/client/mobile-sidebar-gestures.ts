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
  /**
   * 触发手势所需的水平位移占视口宽度的比例（0–1，默认 0.25）。
   *
   * 用比例而不是像素：同一个像素值在 360px 手机与 1024px 平板上的手势占比相差
   * 近三倍，只有比例才能让「灵敏度」设置在各类设备上表达同一件事。
   */
  readonly distanceRatio: number
  /** 起手区域：`avoid` 避开系统边缘热区。 */
  readonly edgeMode: 'avoid' | 'edge'
  /** 方向映射：`swipe-inward` 为右滑开合左栏、左滑开合右栏；`swap` 互换。 */
  readonly mapping: 'swipe-inward' | 'swap'
  /** 当前视口宽度；用于判断右侧热区。 */
  readonly viewportWidth: number
  /** 边缘热区宽度，默认 12px。 */
  readonly edgeZonePx?: number
  /** 方向锁定比（水平位移至少是垂直位移的多少倍），默认 1.5。 */
  readonly directionRatio?: number
  /** 甩动通道的最低整段平均速度（像素/毫秒），默认 0.5，即约 500 像素/秒。 */
  readonly flickMinVelocityPxPerMs?: number
  /** 甩动通道需要的最小水平位移（像素），默认 48。 */
  readonly flickMinDistancePx?: number
}

export interface SidebarGestureDecision {
  readonly action: SidebarGestureAction
  /** 稳定原因码，用于诊断与测试断言。 */
  readonly reason: 'ok' | 'samples' | 'config' | 'edge' | 'threshold' | 'direction' | 'flick'
}

/** 边缘热区只避让最窄的一条，给系统返回手势留空间又不至于让单手起手失效。 */
export const DEFAULT_GESTURE_EDGE_ZONE_PX = 12
export const DEFAULT_GESTURE_DIRECTION_RATIO = 1.5
/**
 * 距离通道门槛：跨过视口宽度的 25% 即触发。
 *
 * 该通道不再做速度二次否决。旧实现要求「距离与末端速度同时达标」，而人手松手前
 * 必然减速，导致正常滑动被速度门槛系统性误杀，用户需要重复滑动。
 */
export const DEFAULT_GESTURE_DISTANCE_RATIO = 0.25
/** 比例设置的合法区间；与共享契约的 15–80 百分比一一对应。 */
export const MIN_GESTURE_DISTANCE_RATIO = 0.15
export const MAX_GESTURE_DISTANCE_RATIO = 0.8
/**
 * 甩动通道：距离不足时的快速甩动逃生通道，任一达标即可触发。
 *
 * 这是 iOS `UISwipeGestureRecognizer`、Android `ViewConfiguration` 与主流手势库
 * （react-swipeable、use-gesture）的通行做法：明确的快速甩动即使位移较短也应当响应。
 */
export const DEFAULT_GESTURE_FLICK_MIN_VELOCITY_PX_PER_MS = 0.5
export const DEFAULT_GESTURE_FLICK_MIN_DISTANCE_PX = 48
/** 与 DSH 窄屏断点保持一致；超过该宽度不安装全局触摸监听。 */
export const DEFAULT_MOBILE_GESTURE_VIEWPORT_MAX_PX = 1024

/**
 * 纯函数：只依据样本与配置给出动作，不读 DOM、不调服务。
 *
 * 判定采用「距离 OR 甩动」双通道：
 * 1. 方向锁先排除纵向滚动意图；
 * 2. 水平位移达到 `视口宽度 × distanceRatio` 直接触发；
 * 3. 位移不足时，若达到 `flickMinDistancePx` 且整段平均速度达到 `flickMinVelocityPxPerMs`，
 *    按快速甩动触发。
 *
 * 速度使用**整段平均速度**而不是末端窗口速度：自然滑动在松手前会减速，用末端速度
 * 判「是否快速甩动」会误杀正常滑动。
 */
export function detectSidebarGesture(samples: readonly TouchSample[], config: SidebarGestureConfig): SidebarGestureDecision {
  const evaluated = evaluateHorizontalGesture(samples, config)
  if (evaluated.direction === null) return { action: 'ignore', reason: evaluated.reason }
  const inward = evaluated.direction > 0 ? 'left' : 'right'
  const action = config.mapping === 'swap' ? (inward === 'left' ? 'right' : 'left') : inward
  return { action, reason: 'ok' }
}

/**
 * 手势判定的唯一实现：返回有效方向或忽略原因。
 *
 * `detectSidebarGesture` 与控制器内的方向探测共用它，保证「能触发」和「能识别物理
 * 方向」永远是同一套条件——否则甩动通道触发的手势会拿不到方向，右栏收起等依赖物理
 * 方向的动作就会静默失效。
 */
function evaluateHorizontalGesture(
  samples: readonly TouchSample[],
  config: SidebarGestureConfig,
): { readonly direction: -1 | 1 | null; readonly reason: SidebarGestureDecision['reason'] } {
  const distanceRatio = Number.isFinite(config.distanceRatio) ? config.distanceRatio : Number.NaN
  const viewportWidth = Number.isFinite(config.viewportWidth) ? config.viewportWidth : 0
  // 比例必须落在合法区间：0 会让任何抖动都触发，超过 1 则永远无法跨过。
  if (!Number.isFinite(distanceRatio) || distanceRatio <= 0 || distanceRatio > 1 || viewportWidth <= 0) {
    return { direction: null, reason: 'config' }
  }
  if (samples.length < 2) return { direction: null, reason: 'samples' }
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const edgeZone = config.edgeZonePx ?? DEFAULT_GESTURE_EDGE_ZONE_PX
  if (config.edgeMode === 'avoid' && (first.x <= edgeZone || first.x >= viewportWidth - edgeZone)) {
    return { direction: null, reason: 'edge' }
  }
  const dx = last.x - first.x
  const dy = last.y - first.y
  const distance = Math.abs(dx)
  const vertical = Math.abs(dy)
  const ratio = config.directionRatio ?? DEFAULT_GESTURE_DIRECTION_RATIO
  const flickMinDistance = config.flickMinDistancePx ?? DEFAULT_GESTURE_FLICK_MIN_DISTANCE_PX
  if (!Number.isFinite(flickMinDistance) || flickMinDistance < 0) return { direction: null, reason: 'config' }
  const distanceThresholdPx = resolveDistanceThresholdPx(distanceRatio, viewportWidth)
  const verticalDominant = distance < vertical * ratio

  // 距离通道：横向位移达标即触发，不再做速度二次否决。
  if (distance >= distanceThresholdPx) {
    if (verticalDominant) return { direction: null, reason: 'direction' }
    return { direction: dx > 0 ? 1 : -1, reason: 'ok' }
  }

  // 横向未达标。纵向占优时是否放弃，取决于运动量是否足够做出可靠判断。
  // 起手阶段位移很小，轻微纵向漂移不代表滚动意图；此时必须保持跟踪，
  // 否则一次正常横滑会被提前判死，用户就得再滑一次。
  if (verticalDominant) {
    const movement = Math.max(distance, vertical)
    if (movement < flickMinDistance) return { direction: null, reason: 'threshold' }
    return { direction: null, reason: 'direction' }
  }

  // 甩动通道：横向意图明确但位移不足，快速甩动同样应当响应。
  const flickMinVelocity = config.flickMinVelocityPxPerMs ?? DEFAULT_GESTURE_FLICK_MIN_VELOCITY_PX_PER_MS
  if (!Number.isFinite(flickMinVelocity) || flickMinVelocity <= 0) return { direction: null, reason: 'config' }
  if (distance < flickMinDistance) return { direction: null, reason: 'threshold' }
  const velocity = averageHorizontalVelocity(samples)
  if (velocity === undefined || velocity < flickMinVelocity) return { direction: null, reason: 'flick' }
  return { direction: dx > 0 ? 1 : -1, reason: 'ok' }
}

export interface SidebarGestureSettings {
  readonly sidebarGestures: boolean
  readonly sidebarGestureMapping: 'swipe-inward' | 'swap'
  readonly sidebarGestureEdge: 'avoid' | 'edge'
  /** 触发手势所需的水平位移占视口宽度的百分比（15–80）。 */
  readonly sidebarGestureDistancePercent: number
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
  /** 在右栏手动呼出前授予显示许可，必须早于宿主状态提交。 */
  readonly onRightbarOpen?: (() => void) | undefined
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
    // 输入控件、终端和右栏标签条始终交给原生交互；标签条即使尚未溢出，也
    // 不应把滑动解释为收起右栏。代码块、长文本和表格等横向滚动内容经常需要
    // 左右拖动；如果这里继续记录样本，window 的全局监听会把右滑误判为
    // “收起右栏”，浏览器也会因为后续 preventDefault 而丢掉原生滚动。
    if (isNativeInteractionTouch(touch)) {
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
    if (isNativeInteractionTouch(touch)) {
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
    if (!wasExpanded) options.onRightbarOpen?.()
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
    distanceRatio: settings.sidebarGestureDistancePercent / 100,
    edgeMode: settings.sidebarGestureEdge,
    mapping: settings.sidebarGestureMapping,
    viewportWidth,
  }
}

/** 把视口比例换算成像素门槛；这是判定距离的唯一入口。 */
function resolveDistanceThresholdPx(distanceRatio: number, viewportWidth: number): number {
  return viewportWidth * distanceRatio
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

function isNativeInteractionTouch(touch: TouchPoint): boolean {
  const targets = [touch.target, ...touch.path]
  return targets.some((target) => isNativeInteractionTarget(target))
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
  const evaluated = evaluateHorizontalGesture(samples, config)
  return evaluated.direction
}

/** 整段平均水平速度（像素/毫秒）；反向回滑按 0 处理，避免折返被当成甩动。 */
function averageHorizontalVelocity(samples: readonly TouchSample[]): number | undefined {
  if (samples.length < 2) return undefined
  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const elapsed = last.t - first.t
  if (!(elapsed > 0)) return undefined
  const dx = last.x - first.x
  if (dx === 0) return 0
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

/** 输入控件、终端与右栏标签条内部的触摸交给原生交互。 */
function isNativeInteractionTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false
  const closest = (target as { closest?: unknown }).closest
  if (typeof closest !== 'function') return false
  try {
    return (closest as (selector: string) => unknown).call(
      target,
      'input, textarea, select, [contenteditable="true"], [data-sidebar-terminal], .xterm, .cm-editor, [data-sidebar-right-panel] [data-dockkit-strip]',
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
