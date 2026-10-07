/**
 * 移动端会话交互修正。
 *
 * DSH 的会话行是带 `role="treeitem"` 的普通 div，桌面端依赖浏览器把触摸
 * 转换成 click。iOS 独立窗口在这条链路上会额外触发双击与延迟 click，导致
 * 会话标题的双击重命名被误触发。这里把短触摸明确转换为一次 click，并屏蔽
 * 移动端的双击重命名；输入焦点由独立控制器保护，覆盖宽屏 iPad。
 */

import {
  startMobileRightbarVisibility,
  type MobileRightbarServiceLike,
  type MobileRightbarVisibilityController,
} from './mobile-rightbar-visibility.js'
import {
  startTouchInputFocusGuard,
  type TouchInputFocusWindowLike,
  type TouchInputFocusDocumentLike,
} from './touch-input-focus.js'

export interface MobileSessionInteractionWindowLike extends TouchInputFocusWindowLike {}

export interface MobileSessionInteractionDocumentLike extends TouchInputFocusDocumentLike {}

export interface MobileSessionInteractionOptions {
  readonly window?: MobileSessionInteractionWindowLike
  readonly document?: MobileSessionInteractionDocumentLike
  readonly mobileViewportMaxPx?: number
  /** DSH 右栏服务；移动端只允许手动呼出。 */
  readonly sidebarRight?: MobileSessionInteractionSidebarRightLike | undefined
  readonly MutationObserver?: typeof MutationObserver | undefined
}

export interface MobileSessionInteractionSidebarRightLike extends MobileRightbarServiceLike {}

export interface MobileSessionInteractionController {
  refresh(): boolean
  dispose(): void
}

interface TouchPoint {
  readonly x: number
  readonly y: number
  readonly target: unknown
}

interface TouchRecord {
  readonly point: TouchPoint
  readonly at: number
}

interface ElementLike {
  getAttribute?(name: string): string | null
  closest?(selector: string): ElementLike | null
  click?(): void
}

const DEFAULT_MOBILE_VIEWPORT_MAX_PX = 1024
const TAP_MAX_DURATION_MS = 700
const TAP_MAX_DISTANCE_PX = 12
const NATIVE_CLICK_SUPPRESSION_WINDOW_MS = 900

/** 纯函数：判断触摸是否足够像一次点按。 */
export function isShortMobileTap(start: TouchRecord, end: TouchRecord): boolean {
  const dx = end.point.x - start.point.x
  const dy = end.point.y - start.point.y
  return end.at - start.at <= TAP_MAX_DURATION_MS
    && Math.hypot(dx, dy) <= TAP_MAX_DISTANCE_PX
}

/** 会话手势只在窄屏启用；键盘保护同时覆盖宽屏 iPad，普通桌面不受影响。 */
export function startMobileSessionInteractionDom(
  options: MobileSessionInteractionOptions = {},
): MobileSessionInteractionController {
  const hostWindow = options.window
    ?? (globalThis as unknown as { window?: MobileSessionInteractionWindowLike }).window
  const hostDocument = options.document
    ?? (globalThis as unknown as { document?: MobileSessionInteractionDocumentLike }).document
  const viewportMaxPx = options.mobileViewportMaxPx ?? DEFAULT_MOBILE_VIEWPORT_MAX_PX
  const inputFocus = startTouchInputFocusGuard({ window: hostWindow, document: hostDocument, mobileViewportMaxPx: viewportMaxPx })
  let active = false
  let disposed = false
  let touchStart: TouchRecord | undefined
  let suppressedClick: { readonly row: ElementLike; readonly at: number } | undefined
  let dispatchingSyntheticClick = false
  let rightbarVisibility: MobileRightbarVisibilityController | undefined

  const now = (): number => Date.now()

  const onTouchStart = (event: unknown): void => {
    const point = firstTouch(event)
    if (point === null) return
    const record = { point, at: now() }
    touchStart = record
  }

  const onTouchEnd = (event: unknown): void => {
    const start = touchStart
    touchStart = undefined
    if (start === undefined) return
    const point = endTouch(event, start.point)
    if (point === null) return
    const end = { point, at: now() }
    if (!isShortMobileTap(start, end)) return
    const row = sessionRow(point.target)
    if (row === null || isRowControl(point.target, row)) return
    rightbarVisibility?.reset()
    // 阻止 iOS 在 touchend 后补发延迟 click；马上交给 React 的 onClick。
    preventDefault(event)
    suppressedClick = { row, at: end.at }
    dispatchingSyntheticClick = true
    try { row.click?.() } finally { dispatchingSyntheticClick = false }
  }

  const onClickCapture = (event: unknown): void => {
    if (dispatchingSyntheticClick) return
    const row = sessionRow(eventTarget(event))
    const suppressed = suppressedClick
    suppressedClick = undefined
    if (suppressed !== undefined && now() - suppressed.at <= NATIVE_CLICK_SUPPRESSION_WINDOW_MS
      && row !== null && row === suppressed.row && !isRowControl(eventTarget(event), row)) {
      preventDefault(event)
      stopPropagation(event)
      return
    }
    if (row !== null && !isRowControl(eventTarget(event), row)) rightbarVisibility?.reset()
  }

  const onDoubleClickCapture = (event: unknown): void => {
    const row = sessionRow(eventTarget(event))
    if (row === null || isRowControl(eventTarget(event), row)) return
    // DSH 的标题双击就是重命名入口。移动端保留菜单中的重命名动作，
    // 但不允许连续点按会话记录误开重命名对话框。
    preventDefault(event)
    stopPropagation(event)
  }

  const addListeners = (): void => {
    if (active || hostDocument === undefined) return
    active = true
    const capture = { capture: true, passive: false }
    hostDocument.addEventListener('touchstart', onTouchStart, capture)
    hostDocument.addEventListener('touchend', onTouchEnd, capture)
    hostDocument.addEventListener('click', onClickCapture, capture)
    hostDocument.addEventListener('dblclick', onDoubleClickCapture, capture)
    if (options.sidebarRight !== undefined) {
      rightbarVisibility = startMobileRightbarVisibility({
        sidebarRight: options.sidebarRight,
        document: hostDocument as Document,
        MutationObserver: options.MutationObserver,
      })
    }
  }

  const removeListeners = (): void => {
    if (!active || hostDocument === undefined) return
    active = false
    hostDocument.removeEventListener('touchstart', onTouchStart, true)
    hostDocument.removeEventListener('touchend', onTouchEnd, true)
    hostDocument.removeEventListener('click', onClickCapture, true)
    hostDocument.removeEventListener('dblclick', onDoubleClickCapture, true)
    rightbarVisibility?.dispose()
    rightbarVisibility = undefined
    touchStart = undefined
    suppressedClick = undefined
  }

  const refresh = (): boolean => {
    if (disposed) return false
    const wanted = isMobileTouchViewport(hostWindow, viewportMaxPx)
    const guardsInput = inputFocus.refresh()
    if (wanted) addListeners()
    else removeListeners()
    return active || guardsInput
  }

  const onResize = (): void => { refresh() }
  hostWindow?.addEventListener('resize', onResize)
  refresh()

  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      inputFocus.dispose()
      removeListeners()
      hostWindow?.removeEventListener('resize', onResize)
    },
  }
}

function isMobileTouchViewport(windowLike: MobileSessionInteractionWindowLike | undefined, maxPx: number): boolean {
  const width = windowLike?.innerWidth
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > maxPx) return false
  const touchPoints = windowLike?.navigator?.maxTouchPoints
  return typeof touchPoints !== 'number' || touchPoints > 0
}

function sessionRow(target: unknown): ElementLike | null {
  const element = asElement(target)
  if (element === null || typeof element.closest !== 'function') return null
  try {
    const row = element.closest('[role="treeitem"][aria-selected]')
    const expanded = row?.getAttribute?.('aria-expanded')
    if (row === null || (expanded !== null && expanded !== undefined)) return null
    return row
  } catch {
    return null
  }
}

function isRowControl(target: unknown, row: ElementLike): boolean {
  const element = asElement(target)
  if (element === null || typeof element.closest !== 'function') return false
  try {
    const control = element.closest('button, a, input, textarea, select, [contenteditable="true"]')
    return control !== null && control !== row
  } catch {
    return false
  }
}

function asElement(value: unknown): ElementLike | null {
  return typeof value === 'object' && value !== null ? value as ElementLike : null
}

function eventTarget(event: unknown): unknown {
  return typeof event === 'object' && event !== null ? (event as { target?: unknown }).target : undefined
}

function firstTouch(event: unknown): TouchPoint | null {
  if (typeof event !== 'object' || event === null) return null
  const list = (event as { touches?: unknown }).touches
  const first = typeof list === 'object' && list !== null ? (list as { 0?: unknown })[0] : undefined
  return readTouch(first, eventTarget(event))
}

function endTouch(event: unknown, fallbackTarget: unknown): TouchPoint | null {
  if (typeof event !== 'object' || event === null) return null
  const list = (event as { changedTouches?: unknown }).changedTouches
  const first = typeof list === 'object' && list !== null ? (list as { 0?: unknown })[0] : undefined
  return readTouch(first, eventTarget(event) ?? fallbackTarget)
}

function readTouch(value: unknown, target: unknown): TouchPoint | null {
  if (typeof value !== 'object' || value === null) return null
  const x = (value as { clientX?: unknown }).clientX
  const y = (value as { clientY?: unknown }).clientY
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
    ? { x, y, target }
    : null
}

function preventDefault(event: unknown): void {
  const method = typeof event === 'object' && event !== null ? (event as { preventDefault?: unknown }).preventDefault : undefined
  if (typeof method === 'function') (method as () => void).call(event)
}

function stopPropagation(event: unknown): void {
  if (typeof event !== 'object' || event === null) return
  const value = event as { stopPropagation?: unknown; stopImmediatePropagation?: unknown }
  if (typeof value.stopImmediatePropagation === 'function') (value.stopImmediatePropagation as () => void).call(event)
  else if (typeof value.stopPropagation === 'function') (value.stopPropagation as () => void).call(event)
}
