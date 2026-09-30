/**
 * DSH 设置弹窗的移动端布局适配。
 *
 * 设置弹窗由 DSH 通过 portal 直接挂到 body，插件不能把样式写进自己的 React
 * 树。这里依赖唯一稳定的 `[data-shortcut-modal="settings"]` 钩子，再按设置根节点
 * 的稳定语义结构（`nav` 与内容列）注入一份可撤销的样式：窄屏时导航变成只显示
 * 图标的窄轨道，弹窗内容占满整个视口。桌面端不写属性、不注入样式，避免影响
 * DSH 原生布局。
 */

/** DSH 设置弹窗的稳定选择器。 */
export const MOBILE_SETTINGS_MODAL_SELECTOR = '[data-shortcut-modal="settings"]'
/** 插件在设置弹窗上挂载的移动端标记。 */
export const MOBILE_SETTINGS_MODAL_ATTRIBUTE = 'data-codingns-mobile-settings'
/** 插件样式标签的幂等键。 */
export const MOBILE_SETTINGS_MODAL_STYLE_ID = 'codingns4dsh-mobile-settings-style'
/** 默认按移动端处理的最大视口宽度。 */
export const MOBILE_SETTINGS_MODAL_DEFAULT_MAX_PX = 1024

/** 移动端设置适配所需的窗口最小接口，便于在 Node 测试中替换。 */
export interface MobileSettingsModalWindowLike {
  readonly innerWidth?: number | undefined
  addEventListener?(type: string, listener: () => void): void
  removeEventListener?(type: string, listener: () => void): void
}

export interface MobileSettingsModalOptions {
  readonly document?: Document | undefined
  readonly window?: MobileSettingsModalWindowLike | undefined
  readonly MutationObserver?: typeof MutationObserver | undefined
  /** 是否启用本轮适配；缺省为启用。 */
  readonly enabled?: (() => boolean) | undefined
  /** 移动端视口上限；缺省为 1024px。 */
  readonly mobileViewportMaxPx?: (() => number) | number | undefined
}

export interface MobileSettingsModalController {
  /** 重新读取视口并同步当前设置弹窗。 */
  refresh(): void
  /** 断开观察器并撤销插件写入。 */
  dispose(): void
}

/** 纯函数：判断一个视口是否按移动端设置布局处理。 */
export function isMobileSettingsViewport(width: number, maxPx = MOBILE_SETTINGS_MODAL_DEFAULT_MAX_PX): boolean {
  return Number.isFinite(width) && width > 0 && Number.isFinite(maxPx) && maxPx > 0 && width <= maxPx
}

/**
 * 启动设置弹窗移动端适配。
 *
 * React 每次打开设置都会重新创建 portal，因此同时监听 documentElement 的子树变更
 * 与窗口 resize。样式使用强制规则覆盖 DSH 的固定 800px/188px 布局，但只在插件
 * 自己标记的弹窗上生效；dispose 后完全移除标记和 style 标签。
 */
export function startMobileSettingsModalDom(options: MobileSettingsModalOptions = {}): MobileSettingsModalController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const enabled = options.enabled ?? ((): boolean => true)
  const maxPx = (): number => {
    const value = typeof options.mobileViewportMaxPx === 'function'
      ? options.mobileViewportMaxPx()
      : options.mobileViewportMaxPx
    return value ?? MOBILE_SETTINGS_MODAL_DEFAULT_MAX_PX
  }
  let disposed = false
  let queued = false
  let marked = new Set<HTMLElement>()

  const schedule = (): void => {
    if (disposed || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      sync()
    })
  }

  const sync = (): void => {
    if (disposed || dom === undefined) return
    const active = enabled() && isMobileSettingsViewport(readViewportWidth(win), maxPx())
    const panels = active ? findSettingsPanels(dom) : []
    const next = new Set(panels)
    for (const panel of marked) {
      if (!next.has(panel)) panel.removeAttribute(MOBILE_SETTINGS_MODAL_ATTRIBUTE)
    }
    if (active && panels.length > 0) {
      installStyles(dom)
      for (const panel of panels) panel.setAttribute(MOBILE_SETTINGS_MODAL_ATTRIBUTE, 'on')
    } else {
      removeStyles(dom)
    }
    marked = next
  }

  const observer = dom === undefined || Observer === undefined || dom.documentElement === undefined
    ? undefined
    : new Observer(() => schedule())
  if (observer !== undefined && dom?.documentElement !== undefined) {
    observer.observe(dom.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      // 只监听宿主弹窗的稳定钩子，避免观察插件自己的标记造成循环扫描。
      attributeFilter: ['data-shortcut-modal'],
    })
  }
  const onResize = (): void => schedule()
  win?.addEventListener?.('resize', onResize)
  sync()

  return {
    refresh: sync,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      win?.removeEventListener?.('resize', onResize)
      for (const panel of marked) panel.removeAttribute(MOBILE_SETTINGS_MODAL_ATTRIBUTE)
      marked = new Set()
      removeStyles(dom)
    },
  }
}

/** 读取窗口宽度；没有浏览器窗口时返回 0，确保适配默认不生效。 */
function readViewportWidth(win: MobileSettingsModalWindowLike | undefined): number {
  const width = win?.innerWidth
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) return width
  const fallback = (globalThis as unknown as { readonly innerWidth?: unknown }).innerWidth
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0 ? fallback : 0
}

function findSettingsPanels(dom: Document): HTMLElement[] {
  return Array.from(dom.querySelectorAll<HTMLElement>(MOBILE_SETTINGS_MODAL_SELECTOR))
}

function installStyles(dom: Document): void {
  if (dom.head === undefined || dom.head === null) return
  const existing = Array.from(dom.head.children).some((child) => (
    child.tagName === 'STYLE' && (child as HTMLElement).dataset.pluginCss === MOBILE_SETTINGS_MODAL_STYLE_ID
  ))
  if (existing) return
  const style = dom.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = MOBILE_SETTINGS_MODAL_STYLE_ID
  style.textContent = MOBILE_SETTINGS_MODAL_STYLE_TEXT
  dom.head.appendChild(style)
}

function removeStyles(dom: Document | undefined): void {
  if (dom?.head === undefined || dom.head === null) return
  for (const child of Array.from(dom.head.children)) {
    if (child.tagName !== 'STYLE') continue
    if ((child as HTMLElement).dataset.pluginCss !== MOBILE_SETTINGS_MODAL_STYLE_ID) continue
    child.remove()
  }
}

/**
 * 只依赖设置根节点的语义结构，不依赖 DSH 的 CSS module 哈希类名。
 * `nav` 第一列保留按钮和图标，文字使用视觉隐藏保留可访问名称；右侧内容列
 * 继续由 DSH 自己的 flex 规则伸展到剩余空间。
 */
const MOBILE_SETTINGS_MODAL_STYLE_TEXT = [
  `[${MOBILE_SETTINGS_MODAL_ATTRIBUTE}="on"]{box-sizing:border-box!important;width:100vw!important;max-width:none!important;height:100%!important;max-height:none!important;border-radius:0!important}`,
  `[${MOBILE_SETTINGS_MODAL_ATTRIBUTE}="on"]>nav{box-sizing:border-box!important;flex:0 0 60px!important;width:60px!important;min-width:60px!important;gap:12px!important;padding:16px 8px 0!important}`,
  `[${MOBILE_SETTINGS_MODAL_ATTRIBUTE}="on"]>nav>:first-child{box-sizing:border-box!important;width:44px!important;height:24px!important;padding:0!important;overflow:hidden!important;font-size:0!important;line-height:0!important;text-indent:-9999px!important}`,
  `[${MOBILE_SETTINGS_MODAL_ATTRIBUTE}="on"]>nav>:last-child{box-sizing:border-box!important;align-items:center!important;gap:4px!important}`,
  `[${MOBILE_SETTINGS_MODAL_ATTRIBUTE}="on"]>nav>:last-child>button{box-sizing:border-box!important;justify-content:center!important;width:44px!important;height:44px!important;padding:9px!important;gap:0!important}`,
  `[${MOBILE_SETTINGS_MODAL_ATTRIBUTE}="on"]>nav>:last-child>button>span{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}`,
  `[${MOBILE_SETTINGS_MODAL_ATTRIBUTE}="on"]>div{box-sizing:border-box!important;min-width:0!important;flex:1 1 auto!important;width:auto!important}`,
  `[${MOBILE_SETTINGS_MODAL_ATTRIBUTE}="on"]>div>div:last-child{box-sizing:border-box!important;min-width:0!important;width:100%!important;padding-left:8px!important;padding-right:8px!important}`,
].join('')
