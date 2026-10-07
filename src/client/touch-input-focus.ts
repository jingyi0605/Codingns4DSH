/** 触摸输入组件只接受用户直接点按后的聚焦，iPad 横屏不受窄屏门槛限制。 */
export interface TouchInputFocusWindowLike {
  readonly innerWidth?: number
  readonly navigator?: { readonly userAgent?: string; readonly maxTouchPoints?: number }
  readonly HTMLElement?: { readonly prototype: Pick<HTMLElement, 'focus'> }
  addEventListener(type: string, listener: (event: unknown) => void, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: (event: unknown) => void, options?: boolean | EventListenerOptions): void
}

export interface TouchInputFocusDocumentLike {
  readonly activeElement?: unknown
  addEventListener(type: string, listener: (event: unknown) => void, options?: boolean | AddEventListenerOptions): void
  removeEventListener(type: string, listener: (event: unknown) => void, options?: boolean | EventListenerOptions): void
}

interface InputElementLike {
  readonly tagName?: string
  readonly isContentEditable?: boolean
  readonly disabled?: boolean
  readonly readOnly?: boolean
  readonly control?: unknown
  getAttribute?(name: string): string | null
  closest?(selector: string): InputElementLike | null
  querySelector?(selector: string): InputElementLike | null
  blur?(): void
}

const INPUT_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [data-composer-input="true"]'
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])
const ACTIVATION_MAX_MS = 700
const TAP_MAX_DISTANCE_PX = 12

/** iPadOS 桌面浏览模式使用 Macintosh 标识，需结合多点触摸识别。 */
export function shouldGuardTouchInput(windowLike: Pick<TouchInputFocusWindowLike, 'innerWidth' | 'navigator'> | undefined, maxPx = 1024): boolean {
  const agent = windowLike?.navigator?.userAgent ?? ''
  const points = windowLike?.navigator?.maxTouchPoints
  if (/iPad/u.test(agent) || (/Macintosh/u.test(agent) && (points ?? 0) > 1)) return true
  const width = windowLike?.innerWidth
  return typeof width === 'number' && Number.isFinite(width) && width > 0 && width <= maxPx
    && (typeof points !== 'number' || points > 0)
}

/** 焦点保护独立于会话列表、侧栏及响应式布局，卸载时恢复原生 focus。 */
export function startTouchInputFocusGuard(options: {
  readonly window?: TouchInputFocusWindowLike | undefined
  readonly document?: TouchInputFocusDocumentLike | undefined
  readonly mobileViewportMaxPx?: number | undefined
} = {}): { refresh(): boolean; dispose(): void } {
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window)
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  let active = false
  let disposed = false
  let activation: { readonly input: InputElementLike; readonly at: number; readonly point: { x: number; y: number } | null } | undefined
  let restoreFocus: (() => void) | undefined

  const allowed = (input: InputElementLike): boolean => activation?.input === input
    && Date.now() - activation.at <= ACTIVATION_MAX_MS

  const blurActiveInput = (): void => { editableInput(dom?.activeElement)?.blur?.() }
  const revoke = (): void => { activation = undefined }

  const onActivate = (event: unknown): void => {
    if (!trustedEvent(event)) return
    const target = eventTarget(event)
    const input = tappedInput(target)
    activation = input === null ? undefined : { input, at: Date.now(), point: eventPoint(event) }
    // 保留添加文件、权限和模型按钮的原有点击链路，但按钮不能授予重新聚焦许可。
    if (input === null && closest(target, '[data-composer-card]') === null) blurActiveInput()
  }

  const onMove = (event: unknown): void => {
    const start = activation?.point
    const end = eventPoint(event)
    if (start !== undefined && start !== null && end !== null
      && Math.hypot(end.x - start.x, end.y - start.y) > TAP_MAX_DISTANCE_PX) revoke()
  }

  const onFocusIn = (event: unknown): void => {
    const input = editableInput(eventTarget(event))
    if (input === null || allowed(input)) return
    // 捕获原生 autofocus 或绕过原型包装的聚焦；同步失焦，避免键盘一直保留。
    input.blur?.()
    queueMicrotask(() => {
      // 不能让迟到的失焦任务撤销用户随后对同一输入框的真实点按。
      if (active && editableInput(dom?.activeElement) === input && !allowed(input)) input.blur?.()
    })
  }

  const onFocusOut = (event: unknown): void => {
    const value = event as { relatedTarget?: unknown }
    if (activation?.input === editableInput(eventTarget(event))
      && editableInput(value?.relatedTarget) !== activation?.input) revoke()
  }

  const onBackground = (): void => { revoke(); blurActiveInput() }

  const installFocusGuard = (): void => {
    const prototype = win?.HTMLElement?.prototype
    if (prototype === undefined) return
    const original = prototype.focus
    const guarded: HTMLElement['focus'] = function (this: HTMLElement, ...args): void {
      const input = editableInput(this)
      if (active && this.ownerDocument === dom && input !== null && !allowed(input)) return
      original.apply(this, args)
    }
    // 只包装当前浏览器窗口；在调用原生方法前拒绝，避免先弹出键盘再收回的闪动。
    try { prototype.focus = guarded } catch { return /* 无法包装时仍保留 focusin 保护。 */ }
    restoreFocus = () => { if (prototype.focus === guarded) prototype.focus = original }
  }

  const listeners: readonly [string, (event: unknown) => void][] = [
    ['pointerdown', onActivate], ['mousedown', onActivate], ['touchstart', onActivate], ['click', onActivate],
    ['touchmove', onMove], ['pointermove', onMove], ['pointercancel', revoke], ['touchcancel', revoke],
    ['focusin', onFocusIn], ['focusout', onFocusOut], ['visibilitychange', onBackground],
  ]

  const stop = (): void => {
    if (!active || dom === undefined) return
    active = false
    revoke()
    for (const [type, listener] of listeners) dom.removeEventListener(type, listener, true)
    win?.removeEventListener('blur', onBackground, true)
    restoreFocus?.()
    restoreFocus = undefined
  }

  const refresh = (): boolean => {
    if (disposed) return false
    if (!shouldGuardTouchInput(win, options.mobileViewportMaxPx) || dom === undefined) { stop(); return false }
    if (active) return true
    active = true
    installFocusGuard()
    for (const [type, listener] of listeners) dom.addEventListener(type, listener, { capture: true, passive: true })
    win?.addEventListener('blur', onBackground, true)
    // 页面初次挂载时可能已经存在自动焦点，不能把它当成用户输入意图。
    blurActiveInput()
    return true
  }

  win?.addEventListener('resize', refresh)
  refresh()
  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      stop()
      win?.removeEventListener('resize', refresh)
    },
  }
}

function editableInput(value: unknown): InputElementLike | null {
  const element = asElement(value)
  if (element === null) return null
  // 子文本节点归一到同一个编辑根节点，按钮与不可编辑片段保持原有焦点语义。
  if (closest(element, 'button, a, [contenteditable="false"]') !== null) return null
  const input = closest(element, INPUT_SELECTOR)
  if (input !== null) return isEditable(input) ? input : null
  return isEditable(element) ? element : null
}

function isEditable(element: InputElementLike): boolean {
  if (element.disabled || element.readOnly) return false
  const tag = element.tagName?.toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has(element.getAttribute?.('type')?.toLowerCase() ?? 'text')
  const value = element.getAttribute?.('contenteditable')
  if (value === 'false') return false
  return element.isContentEditable === true || value === '' || value === 'true' || value === 'plaintext-only'
    || element.getAttribute?.('data-composer-input') === 'true'
}

function tappedInput(value: unknown): InputElementLike | null {
  // 编辑器内部的不可编辑按钮不能借用外层 contenteditable 的输入授权。
  if (closest(value, 'button, a, [contenteditable="false"]') !== null) return null
  const input = editableInput(value)
  if (input !== null) return input
  const labelInput = asElement(closest(value, 'label')?.control)
  if (labelInput !== null && isEditable(labelInput)) return labelInput
  // xterm 的文字输入代理是隐藏 textarea；只有直接点按终端文字面板才允许聚焦它。
  const terminal = closest(closest(value, '.xterm-screen'), '.xterm')
  return terminal?.querySelector?.('textarea.xterm-helper-textarea') ?? null
}

function closest(value: unknown, selector: string): InputElementLike | null {
  return asElement(value)?.closest?.(selector) ?? null
}

function asElement(value: unknown): InputElementLike | null {
  return typeof value === 'object' && value !== null ? value as InputElementLike : null
}

function eventTarget(event: unknown): unknown {
  const value = event as { target?: unknown; composedPath?: () => unknown[] }
  return value?.composedPath?.()[0] ?? value?.target
}

function trustedEvent(event: unknown): boolean {
  return typeof event === 'object' && event !== null && (event as { isTrusted?: unknown }).isTrusted === true
}

function eventPoint(event: unknown): { x: number; y: number } | null {
  const value = event as { touches?: { 0?: { clientX?: number; clientY?: number } }; clientX?: number; clientY?: number }
  const point = value?.touches?.[0] ?? value
  return typeof point?.clientX === 'number' && typeof point?.clientY === 'number'
    ? { x: point.clientX, y: point.clientY } : null
}
