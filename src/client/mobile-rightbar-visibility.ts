/** 移动端右栏显示权只属于用户，标签恢复与会话持久化不能自行展开面板。 */
export const MOBILE_RIGHTBAR_MANUAL_OPEN_EVENT = 'codingns4dsh-mobile-rightbar-manual-open'
export const MOBILE_RIGHTBAR_VISIBILITY_ATTRIBUTE = 'data-codingns-mobile-rightbar'
const STYLE_ID = 'codingns4dsh-mobile-rightbar-visibility'

export interface MobileRightbarServiceLike {
  isExpanded(): boolean
  toggleExpanded(): void
  readonly mounted?: {
    readonly getSnapshot?: () => unknown
    readonly subscribe: (listener: () => void) => () => void
  }
}

export interface MobileRightbarVisibilityController {
  /** 会话发生变化时撤销上一次手动呼出的许可。 */
  reset(): void
  dispose(): void
}

/** 手势确认右栏呼出后、修改宿主状态前通知显示控制器。 */
export function notifyMobileRightbarManualOpen(documentLike: { dispatchEvent?(event: Event): boolean } | undefined): void {
  documentLike?.dispatchEvent?.(new Event(MOBILE_RIGHTBAR_MANUAL_OPEN_EVENT))
}

/** 由会话交互控制器按移动触摸视口启停，不轮询、不接管宿主标签和持久化数据。 */
export function startMobileRightbarVisibility(options: {
  readonly sidebarRight: MobileRightbarServiceLike
  readonly document?: Document | undefined
  readonly MutationObserver?: typeof MutationObserver | undefined
}): MobileRightbarVisibilityController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const sidebarRight = options.sidebarRight
  let disposed = false
  let requested = false
  let opened = false
  let collapsing = false
  const readSession = (): unknown => sidebarRight.mounted?.getSnapshot !== undefined
    ? sidebarRight.mounted.getSnapshot()
    : dom?.querySelector('[data-sidebar-right-session]:not([data-sidebar-right-panel]):not([hidden])')?.getAttribute('data-sidebar-right-session')
  let session = readSession()

  // 在宿主首次绘制前挡住自动恢复的面板，防止异步收起前闪现全屏右栏。
  // 只隐藏右栏面板；列宽与实际展开状态仍交给宿主服务同步。
  const style = dom?.createElement?.('style')
  if (style !== undefined) {
    style.id = STYLE_ID
    style.textContent = `html[${MOBILE_RIGHTBAR_VISIBILITY_ATTRIBUTE}="blocked"] [data-sidebar-right-panel] { visibility: hidden !important; pointer-events: none !important; }`
    dom?.head?.appendChild(style)
  }

  const setVisibility = (): void => {
    dom?.documentElement?.setAttribute(MOBILE_RIGHTBAR_VISIBILITY_ATTRIBUTE, requested ? 'allowed' : 'blocked')
  }

  const block = (): void => {
    requested = false
    opened = false
    setVisibility()
  }

  const reconcile = (): void => {
    if (disposed || collapsing) return
    try {
      const current = readSession()
      if (current !== session) {
        session = current
        block()
      }
      const expanded = sidebarRight.isExpanded()
      if (requested) {
        if (expanded) opened = true
        // 呼出尚未提交时保留许可；手动关闭后撤销，后续后台恢复不能再次打开。
        else if (opened) reset()
        return
      }
      if (!expanded) return
      collapsing = true
      sidebarRight.toggleExpanded()
    } catch {
      // 会话 Store 尚未被宿主接管时，保持视觉关闭，等待下一次挂载或 DOM 提交。
    } finally {
      collapsing = false
    }
  }

  const reset = (): void => {
    if (disposed) return
    session = readSession()
    block()
    reconcile()
  }

  const allowOpen = (): void => {
    if (disposed) return
    session = readSession()
    requested = true
    opened = sidebarRight.isExpanded()
    setVisibility()
    // 三种手动入口都同步提交宿主 Store；失败或被模态窗口拦截的请求不能
    // 留下永久许可，让下一次后台标签恢复误用它。
    queueMicrotask(() => {
      if (disposed || !requested) return
      opened = sidebarRight.isExpanded()
      if (!opened) block()
    })
  }

  const onClick = (event: Event): void => {
    if (event.isTrusted === false) return
    const target = event.target as Element | null
    if (target?.closest?.('[data-sidebar-right-expand]')) allowOpen()
    // 原生关闭按钮直接写 Store，不经过服务；先撤销许可，再由原生 click 收起。
    if (target?.closest?.('[data-sidebar-right-toggle]')) block()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isTrusted === false || event.repeat) return
    const shortcut = dom?.querySelector('[data-sidebar-right-expand], [data-sidebar-right-toggle]')?.getAttribute('aria-keyshortcuts')
    if (shortcut?.split(/\s+/u).some((keys) => matchesShortcut(event, keys))) allowOpen()
  }

  dom?.addEventListener('click', onClick, true)
  dom?.addEventListener('keydown', onKeyDown, true)
  dom?.addEventListener(MOBILE_RIGHTBAR_MANUAL_OPEN_EVENT, allowOpen)
  const observer = dom?.documentElement === undefined || Observer === undefined ? undefined : new Observer(reconcile)
  observer?.observe(dom!.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    // 持久化恢复、标签恢复和原生关闭都通过这些钩子触发；不观察插件自己的属性。
    attributeFilter: ['data-sidebar-right-open', 'data-sidebar-right-session', 'hidden', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
  })
  let unsubscribe: (() => void) | undefined
  try { unsubscribe = sidebarRight.mounted?.subscribe(reset) } catch { /* 可选会话通知不可用时仍按 DOM 提交校正。 */ }
  reset()

  return {
    reset,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      observer?.disconnect()
      dom?.removeEventListener('click', onClick, true)
      dom?.removeEventListener('keydown', onKeyDown, true)
      dom?.removeEventListener(MOBILE_RIGHTBAR_MANUAL_OPEN_EVENT, allowOpen)
      dom?.documentElement?.removeAttribute(MOBILE_RIGHTBAR_VISIBILITY_ATTRIBUTE)
      style?.remove()
    },
  }
}

/** 按宿主公开的无障碍快捷键匹配，保留用户自定义键位，不硬编码平台默认值。 */
function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+')
  const key = parts.pop()
  return key === event.key?.toLowerCase()
    && event.ctrlKey === parts.includes('control')
    && event.metaKey === parts.includes('meta')
    && event.altKey === parts.includes('alt')
    && event.shiftKey === parts.includes('shift')
}
