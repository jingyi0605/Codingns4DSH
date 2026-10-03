/**
 * 移动端会话交互修正。
 *
 * DSH 的会话行是带 `role="treeitem"` 的普通 div，桌面端依赖浏览器把触摸
 * 转换成 click。iOS 独立窗口在这条链路上会额外触发双击与延迟 click，导致
 * 会话标题的双击重命名被误触发。这里把短触摸明确转换为一次 click，并屏蔽
 * 移动端的双击重命名；Composer 的焦点则只接受来自用户点按输入框的动作。
 */

export interface MobileSessionInteractionWindowLike {
  readonly innerWidth?: number
  readonly navigator?: { readonly maxTouchPoints?: number }
  addEventListener(type: string, listener: (event: never) => void, options?: unknown): void
  removeEventListener(type: string, listener: (event: never) => void, options?: unknown): void
}

export interface MobileSessionInteractionDocumentLike {
  addEventListener(type: string, listener: (event: never) => void, options?: unknown): void
  removeEventListener(type: string, listener: (event: never) => void, options?: unknown): void
}

export interface MobileSessionInteractionOptions {
  readonly window?: MobileSessionInteractionWindowLike
  readonly document?: MobileSessionInteractionDocumentLike
  readonly mobileViewportMaxPx?: number
}

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
  readonly tagName?: string
  readonly parentElement?: ElementLike | null
  readonly className?: string
  getAttribute?(name: string): string | null
  closest?(selector: string): ElementLike | null
  contains?(node: unknown): boolean
  blur?(): void
  click?(): void
}

const DEFAULT_MOBILE_VIEWPORT_MAX_PX = 1024
const TAP_MAX_DURATION_MS = 700
const TAP_MAX_DISTANCE_PX = 12
const FOCUS_ACTIVATION_WINDOW_MS = 700
const NATIVE_CLICK_SUPPRESSION_WINDOW_MS = 900

/** 纯函数：判断触摸是否足够像一次点按。 */
export function isShortMobileTap(start: TouchRecord, end: TouchRecord): boolean {
  const dx = end.point.x - start.point.x
  const dy = end.point.y - start.point.y
  return end.at - start.at <= TAP_MAX_DURATION_MS
    && Math.hypot(dx, dy) <= TAP_MAX_DISTANCE_PX
}

/** 启动移动端会话交互修正；桌面视口不注册任何全局监听。 */
export function startMobileSessionInteractionDom(
  options: MobileSessionInteractionOptions = {},
): MobileSessionInteractionController {
  const hostWindow = options.window
    ?? (globalThis as unknown as { window?: MobileSessionInteractionWindowLike }).window
  const hostDocument = options.document
    ?? (globalThis as unknown as { document?: MobileSessionInteractionDocumentLike }).document
  const viewportMaxPx = options.mobileViewportMaxPx ?? DEFAULT_MOBILE_VIEWPORT_MAX_PX
  let active = false
  let disposed = false
  let touchStart: TouchRecord | undefined
  let userActivation: { readonly target: ElementLike; readonly at: number } | undefined
  let suppressedClick: { readonly row: ElementLike; readonly at: number } | undefined
  let dispatchingSyntheticClick = false

  const now = (): number => Date.now()

  const blurComposer = (): void => {
    const activeElement = (hostDocument as unknown as { activeElement?: unknown } | undefined)?.activeElement
    const element = asElement(activeElement)
    if (element === null || !isComposerInputTarget(element)) return
    try { element.blur?.() } catch { /* 浏览器焦点已被销毁时忽略。 */ }
  }

  const onPointerDown = (event: unknown): void => {
    const target = asElement(eventTarget(event))
    if (target === null) return
    userActivation = { target, at: now() }
    // Composer 内的按钮（添加文件、权限、模型和发送）由 DSH 自己维护焦点。
    // 捕获阶段提前 blur 会破坏移动端按钮的 click/菜单切换链路。
    if (!isComposerInteractionTarget(target)) blurComposer()
  }

  const onFocusIn = (event: unknown): void => {
    const target = asElement(eventTarget(event))
    if (target === null || !isComposerInputTarget(target)) return
    const activation = userActivation
    const allowed = activation !== undefined
      && now() - activation.at <= FOCUS_ACTIVATION_WINDOW_MS
      && activationInsideComposer(activation.target, target)
    if (allowed) return
    // React/Lexical 可能在会话切换完成后的微任务中再次 focus；同步 blur 后再补
    // 一次微任务，确保 Android WebView 和 iOS Web App 都不会留下软键盘。
    blurElementLater(target)
  }

  const onTouchStart = (event: unknown): void => {
    const point = firstTouch(event)
    if (point === null) return
    const record = { point, at: now() }
    touchStart = record
    const target = asElement(point.target)
    userActivation = { target: target ?? emptyElement(), at: record.at }
    if (target === null || !isComposerInteractionTarget(target)) blurComposer()
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
    // 阻止 iOS 在 touchend 后补发延迟 click；马上交给 React 的 onClick。
    preventDefault(event)
    suppressedClick = { row, at: end.at }
    dispatchingSyntheticClick = true
    try { row.click?.() } finally { dispatchingSyntheticClick = false }
  }

  const onClickCapture = (event: unknown): void => {
    if (dispatchingSyntheticClick) return
    const suppressed = suppressedClick
    if (suppressed === undefined || now() - suppressed.at > NATIVE_CLICK_SUPPRESSION_WINDOW_MS) {
      suppressedClick = undefined
      return
    }
    const row = sessionRow(eventTarget(event))
    if (row !== null && row === suppressed.row) {
      preventDefault(event)
      stopPropagation(event)
    }
    suppressedClick = undefined
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
    hostDocument.addEventListener('pointerdown', onPointerDown as (event: never) => void, capture)
    hostDocument.addEventListener('mousedown', onPointerDown as (event: never) => void, capture)
    hostDocument.addEventListener('touchstart', onTouchStart as (event: never) => void, capture)
    hostDocument.addEventListener('touchend', onTouchEnd as (event: never) => void, capture)
    hostDocument.addEventListener('focusin', onFocusIn as (event: never) => void, capture)
    hostDocument.addEventListener('click', onClickCapture as (event: never) => void, capture)
    hostDocument.addEventListener('dblclick', onDoubleClickCapture as (event: never) => void, capture)
  }

  const removeListeners = (): void => {
    if (!active || hostDocument === undefined) return
    active = false
    hostDocument.removeEventListener('pointerdown', onPointerDown as (event: never) => void, true)
    hostDocument.removeEventListener('mousedown', onPointerDown as (event: never) => void, true)
    hostDocument.removeEventListener('touchstart', onTouchStart as (event: never) => void, true)
    hostDocument.removeEventListener('touchend', onTouchEnd as (event: never) => void, true)
    hostDocument.removeEventListener('focusin', onFocusIn as (event: never) => void, true)
    hostDocument.removeEventListener('click', onClickCapture as (event: never) => void, true)
    hostDocument.removeEventListener('dblclick', onDoubleClickCapture as (event: never) => void, true)
    touchStart = undefined
    userActivation = undefined
    suppressedClick = undefined
  }

  const refresh = (): boolean => {
    if (disposed) return false
    const wanted = isMobileTouchViewport(hostWindow, viewportMaxPx)
    if (wanted) addListeners()
    else removeListeners()
    return active
  }

  const onResize = (): void => { refresh() }
  hostWindow?.addEventListener('resize', onResize as (event: never) => void)
  refresh()

  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      removeListeners()
      hostWindow?.removeEventListener('resize', onResize as (event: never) => void)
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

function isComposerInputTarget(target: ElementLike): boolean {
  try {
    return target.closest?.('[data-composer-input="true"]') !== null
  } catch {
    return false
  }
}

/** Composer 内所有控件都应保留 DSH 自己的点击与焦点语义。 */
function isComposerInteractionTarget(target: ElementLike): boolean {
  try {
    return isComposerInputTarget(target) || target.closest?.('[data-composer-card]') !== null
  } catch {
    return false
  }
}

function activationInsideComposer(activation: ElementLike, target: ElementLike): boolean {
  if (activation === target) return true
  try {
    if (target.contains?.(activation) === true) return true
    const activationSurface = activation.closest?.('[data-composer-card]')
    const targetSurface = target.closest?.('[data-composer-card]')
    if (activationSurface !== null && activationSurface === targetSurface) return true
    return activation.closest?.('[data-composer-input="true"]') === target.closest?.('[data-composer-input="true"]')
  } catch {
    return false
  }
}

function asElement(value: unknown): ElementLike | null {
  return typeof value === 'object' && value !== null ? value as ElementLike : null
}

function emptyElement(): ElementLike {
  return { closest: () => null }
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

function blurElementLater(element: ElementLike): void {
  try { element.blur?.() } catch { /* 忽略失效的焦点节点。 */ }
  const schedule = typeof queueMicrotask === 'function' ? queueMicrotask : (callback: () => void) => { setTimeout(callback, 0) }
  schedule(() => {
    try { if (isComposerInputTarget(element)) element.blur?.() } catch { /* 节点已卸载。 */ }
  })
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
