/**
 * 移动端右栏标签条优先使用浏览器原生横向滚动。
 *
 * 上游标签条、标签容器及标签的 touch-action 均为 none，且标签 pointerdown
 * 会捕获指针并启动拖拽。这里只在窄屏触摸视口放开 pan-x，并在捕获阶段拦截
 * 标签容器内的触摸 pointerdown；不取消默认动作，原生滚动、惯性和点击仍可用。
 */

export const MOBILE_RIGHTBAR_TABS_ATTRIBUTE = 'data-codingns-mobile-rightbar-tabs'
export const MOBILE_RIGHTBAR_TABS_STYLE_ID = 'codingns4dsh-mobile-rightbar-tabs'
const TAB_RUN_SELECTOR = '[data-sidebar-right-panel] [data-dockkit-strip-tabs]'

export interface MobileRightbarTabsWindowLike {
  readonly innerWidth?: number | undefined
  readonly navigator?: { readonly maxTouchPoints?: number | undefined } | undefined
  addEventListener?(type: string, listener: () => void): void
  removeEventListener?(type: string, listener: () => void): void
}

export interface MobileRightbarTabsOptions {
  readonly document?: Document | undefined
  readonly window?: MobileRightbarTabsWindowLike | undefined
  readonly mobileViewportMaxPx?: number | (() => number) | undefined
}

export interface MobileRightbarTabsController {
  refresh(): boolean
  dispose(): void
}

/** 全局选择器与事件委派自动覆盖宿主重建的标签条，无需逐个绑定或观察 DOM。 */
export function startMobileRightbarTabsDom(options: MobileRightbarTabsOptions = {}): MobileRightbarTabsController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window)
  let active = false
  let disposed = false
  let style: HTMLStyleElement | undefined

  const onPointerDown = (event: PointerEvent): void => {
    if (!active || event.pointerType !== 'touch') return
    const target = event.target as Element | null
    if (!target?.closest?.(TAB_RUN_SELECTOR)) return
    // 只阻止事件进入上游拖拽链路，不 preventDefault，否则浏览器连滚动和点击
    // 都会一起取消。鼠标与手写笔继续使用上游拖拽，右栏尾部按钮也不受影响。
    event.stopPropagation()
  }

  const deactivate = (): void => {
    if (!active) return
    active = false
    dom?.removeEventListener('pointerdown', onPointerDown, true)
    dom?.documentElement.removeAttribute(MOBILE_RIGHTBAR_TABS_ATTRIBUTE)
    style?.remove()
    style = undefined
  }

  const refresh = (): boolean => {
    if (disposed) return false
    const width = win?.innerWidth ?? 0
    const maxPx = typeof options.mobileViewportMaxPx === 'function'
      ? options.mobileViewportMaxPx()
      : options.mobileViewportMaxPx ?? 1024
    const touchPoints = win?.navigator?.maxTouchPoints
    const wanted = dom?.documentElement !== undefined
      && Number.isFinite(width) && width > 0 && width <= maxPx
      && (typeof touchPoints !== 'number' || touchPoints > 0)
    if (!wanted) {
      deactivate()
      return false
    }
    if (active) return true
    active = true
    style = dom.createElement('style')
    style.id = MOBILE_RIGHTBAR_TABS_STYLE_ID
    style.textContent = mobileTabStyles()
    dom.head.appendChild(style)
    dom.documentElement.setAttribute(MOBILE_RIGHTBAR_TABS_ATTRIBUTE, 'on')
    dom.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    return true
  }

  const onResize = (): void => { refresh() }
  win?.addEventListener?.('resize', onResize)
  refresh()
  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      deactivate()
      win?.removeEventListener?.('resize', onResize)
    },
  }
}

function mobileTabStyles(): string {
  const scope = `html[${MOBILE_RIGHTBAR_TABS_ATTRIBUTE}="on"] [data-sidebar-right-panel]`
  return `
${scope} [data-dockkit-strip],
${scope} [data-dockkit-strip-tabs],
${scope} [data-dockkit-tab] {
  touch-action: pan-x !important;
}
${scope} [data-dockkit-strip-tabs] {
  overflow-x: auto !important;
  overflow-y: hidden !important;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}
`
}
