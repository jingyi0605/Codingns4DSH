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

import { vibrateMobile } from './mobile-vibration.js'

export type SidebarGestureAction = 'left' | 'right' | 'ignore'

export interface TouchSample {
  readonly x: number
  readonly y: number
  readonly t: number
}

export interface SidebarGestureConfig {
  /** 触发阈值（像素）。 */
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
}

export interface SidebarGestureDecision {
  readonly action: SidebarGestureAction
  /** 稳定原因码，用于诊断与测试断言。 */
  readonly reason: 'ok' | 'samples' | 'config' | 'edge' | 'threshold' | 'direction'
}

export const DEFAULT_GESTURE_EDGE_ZONE_PX = 24
export const DEFAULT_GESTURE_DIRECTION_RATIO = 1.5
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
  if (Math.abs(dx) < thresholdPx) return { action: 'ignore', reason: 'threshold' }
  const ratio = config.directionRatio ?? DEFAULT_GESTURE_DIRECTION_RATIO
  if (Math.abs(dx) < Math.abs(dy) * ratio) return { action: 'ignore', reason: 'direction' }
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
  /** 读取左栏折叠状态（来自 `data-sidebar-collapsed` 等 DOM 钩子）；缺失时不影响开合。 */
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
  let rightbarHistoryPushed = false

  const onResize = (): void => { refresh() }

  const onTouchStart = (event: unknown): void => {
    const touch = firstTouch(event)
    if (touch === null) return
    if (isEditableTarget(touch.target)) return
    tracking = true
    claimed = false
    samples = [{ x: touch.x, y: touch.y, t: now() }]
  }
  const onTouchMove = (event: unknown): void => {
    if (!tracking) return
    const touch = firstTouch(event)
    if (touch === null) return
    samples.push({ x: touch.x, y: touch.y, t: now() })
    if (!claimed && samples.length <= 24) {
      const decision = detectSidebarGesture(samples, resolveConfig(options))
      if (decision.reason === 'ok') {
        claimed = true
        applyAction(decision.action)
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
    tracking = false
    claimed = false
    samples = []
  }
  const onPopState = (): void => {
    if (!rightbarHistoryPushed) return
    rightbarHistoryPushed = false
    if (options.ports.sidebarRight?.isExpanded() === true) options.ports.sidebarRight.toggleExpanded()
  }

  const applyAction = (action: SidebarGestureAction): void => {
    if (action === 'ignore') return
    // 仅在手势真正触发开合后反馈，避免滚动和方向锁定失败时误振动。
    ;(options.vibrate ?? vibrateMobile)(10)
    if (action === 'left') {
      options.ports.layout?.toggleSidebar()
      return
    }
    const sidebarRight = options.ports.sidebarRight
    if (sidebarRight === undefined) return
    const wasExpanded = sidebarRight.isExpanded() === true
    sidebarRight.toggleExpanded()
    if (!wasExpanded && sidebarRight.isExpanded() === true && hostWindow?.history !== undefined) {
      // 全屏右栏压入一条历史记录：Android 返回手势与 iOS 边缘返回先关右栏。
      try {
        hostWindow.history.pushState({ codingnsRightbar: true }, '')
        rightbarHistoryPushed = true
      } catch {
        rightbarHistoryPushed = false
      }
    }
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

interface TouchPoint {
  readonly x: number
  readonly y: number
  readonly target: unknown
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
  return { x, y, target: (event as { target?: unknown }).target }
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
      'input, textarea, select, [contenteditable="true"], .xterm, .cm-editor',
    ) !== null
  } catch {
    return false
  }
}

function now(): number {
  const performanceLike = (globalThis as unknown as { performance?: { now?: () => number } }).performance
  return typeof performanceLike?.now === 'function' ? performanceLike.now() : Date.now()
}
