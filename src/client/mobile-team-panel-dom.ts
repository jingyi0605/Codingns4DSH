import { resolveCodingNsTranslator, type CodingNsLocale } from './locale.js'
import { FISH_LOGO_PATH } from './mobile-sidebar-logo.js'

const PANEL = '[data-team-panel][role="dialog"]'
const MOBILE = 'data-codingns-mobile-team'
const HEADER = 'data-codingns-team-header'

export interface MobileTeamPanelOptions {
  readonly document?: Document
  readonly window?: Pick<Window, 'innerWidth' | 'addEventListener' | 'removeEventListener'>
  readonly MutationObserver?: typeof MutationObserver
  readonly locale?: CodingNsLocale
  readonly mobileViewportMaxPx?: number | (() => number)
}

/** Adapt the native portal while DSH retains roster, task, and dismissal ownership. */
export function startMobileTeamPanelDom(options: MobileTeamPanelOptions = {}): { refresh(): void; dispose(): void } {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window)
  const Observer = options.MutationObserver ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const t = resolveCodingNsTranslator(options.locale)
  const headers = new Map<HTMLElement, HTMLElement>()
  let style: HTMLStyleElement | undefined
  let queued = false
  let disposed = false

  const remove = (panel: HTMLElement, header: HTMLElement): void => {
    header.remove()
    panel.removeAttribute(MOBILE)
    headers.delete(panel)
  }
  const refresh = (): void => {
    if (disposed || !dom) return
    const max = typeof options.mobileViewportMaxPx === 'function' ? options.mobileViewportMaxPx() : options.mobileViewportMaxPx ?? 1024
    const width = win?.innerWidth ?? 0
    const active = Number.isFinite(width) && width > 0 && Number.isFinite(max) && width <= max
    const panels = new Set(active ? dom.querySelectorAll<HTMLElement>(PANEL) : [])
    for (const [panel, header] of headers) if (!panels.has(panel)) remove(panel, header)
    if (!panels.size) {
      style?.remove()
      style = undefined
      return
    }
    if (!style) {
      style = dom.createElement('style')
      style.dataset.plugin = 'codingns4dsh'
      style.dataset.pluginCss = 'codingns4dsh-mobile-team-panel'
      style.textContent = MOBILE_TEAM_PANEL_STYLES
      dom.head.appendChild(style)
    }
    for (const panel of panels) {
      panel.setAttribute(MOBILE, 'on')
      let header = headers.get(panel)
      if (!header) {
        header = createHeader(dom, panel)
        panel.insertBefore(header, panel.firstChild)
        headers.set(panel, header)
      }
      const title = panel.getAttribute('aria-label') || t('mobile.team.title')
      const heading = header.firstElementChild!
      if (heading.textContent !== title) heading.textContent = title
      const button = header.lastElementChild!
      const label = t('mobile.team.close')
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
      if (button.getAttribute('title') !== label) button.setAttribute('title', label)
    }
  }
  const schedule = (): void => {
    if (disposed || queued) return
    queued = true
    queueMicrotask(() => { queued = false; refresh() })
  }
  const observer = dom && Observer ? new Observer(schedule) : undefined
  if (dom?.documentElement) observer?.observe(dom.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-team-panel', 'aria-label'],
  })
  win?.addEventListener('resize', schedule)
  const unsubscribeLocale = options.locale?.subscribe(schedule)
  refresh()
  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      win?.removeEventListener('resize', schedule)
      unsubscribeLocale?.()
      for (const [panel, header] of headers) remove(panel, header)
      style?.remove()
      style = undefined
    },
  }
}

function createHeader(dom: Document, panel: HTMLElement): HTMLElement {
  const header = dom.createElement('div')
  header.setAttribute(HEADER, '')
  const button = dom.createElement('button')
  button.type = 'button'
  const svg = dom.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 32 24')
  svg.setAttribute('width', '32')
  svg.setAttribute('height', '24')
  svg.setAttribute('aria-hidden', 'true')
  const logo = dom.createElementNS('http://www.w3.org/2000/svg', 'path')
  logo.setAttribute('d', FISH_LOGO_PATH)
  logo.setAttribute('transform', 'translate(1 2)')
  logo.setAttribute('fill', 'currentColor')
  const close = dom.createElementNS('http://www.w3.org/2000/svg', 'path')
  close.setAttribute('d', 'M25 17l6 6m0-6l-6 6')
  close.setAttribute('stroke', 'currentColor')
  close.setAttribute('stroke-width', '2')
  close.setAttribute('stroke-linecap', 'round')
  svg.append(logo, close)
  button.appendChild(svg)
  button.addEventListener('click', event => {
    event.stopPropagation()
    // DSH's Escape handler closes React state and restores focus to its trigger.
    const Keyboard = dom.defaultView?.KeyboardEvent
    if (!Keyboard) return
    button.focus({ preventScroll: true })
    panel.dispatchEvent(new Keyboard('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  header.append(dom.createElement('strong'), button)
  return header
}

const SCOPE = `[${MOBILE}="on"]`
const MOBILE_TEAM_PANEL_STYLES = `
${SCOPE} {
  box-sizing:border-box!important;
  top:max(8px, env(safe-area-inset-top, 0px))!important;
  left:max(8px, env(safe-area-inset-left, 0px))!important;
  right:max(8px, env(safe-area-inset-right, 0px))!important;
  bottom:auto!important; width:auto!important; max-width:none!important;
  height:calc(100vh - 16px)!important;
  height:calc(100dvh - max(8px, env(safe-area-inset-top, 0px)) - max(8px, env(safe-area-inset-bottom, 0px)))!important;
  max-height:none!important; padding:0!important; visibility:visible!important; overflow:hidden!important;
}
${SCOPE}>[${HEADER}] {
  flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:6px 8px 6px 16px;
  border-bottom:1px solid var(--dsw-alias-border-l2, #ddd); color:var(--dsw-alias-label-primary, CanvasText);
}
${SCOPE}>[${HEADER}] strong { min-width:0; font-size:15px; overflow-wrap:anywhere; }
${SCOPE}>[${HEADER}] button {
  display:inline-flex; align-items:center; justify-content:center; flex:0 0 44px; width:44px; height:44px;
  padding:0; border:0; border-radius:10px; color:var(--dsw-alias-label-primary, CanvasText); background:transparent;
  cursor:pointer; touch-action:manipulation; -webkit-tap-highlight-color:transparent;
}
${SCOPE}>[${HEADER}] button:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
${SCOPE}>[${HEADER}] button:focus-visible { outline:2px solid var(--dsw-focus-ring-color, #1677ff); outline-offset:-2px; }
${SCOPE}>[${HEADER}] svg { display:block; pointer-events:none; }
${SCOPE}>div:not([${HEADER}]) {
  flex:1 1 auto!important; min-height:0!important; min-width:0; padding:0 12px 12px!important;
  overflow-y:auto!important; overscroll-behavior:contain; scrollbar-gutter:auto!important; -webkit-overflow-scrolling:touch;
}
${SCOPE} section:first-of-type>div { grid-template-columns:repeat(auto-fit, minmax(min(150px, 100%), 1fr))!important; }
${SCOPE} section:first-of-type button { min-height:64px; padding:10px!important; touch-action:manipulation; }
${SCOPE} section:first-of-type button>span:last-child>span { flex-wrap:wrap; }
${SCOPE} section:first-of-type button>span:last-child>span>span:first-child { white-space:normal!important; overflow-wrap:anywhere; }
${SCOPE} article { min-width:0; padding:12px!important; }
${SCOPE} article>div:first-child { align-items:flex-start!important; }
${SCOPE} article>div:first-child strong { flex:1; min-width:0; font-size:14px!important; line-height:1.45; overflow-wrap:anywhere; }
${SCOPE} article>div:first-child>span { flex:0 0 auto; white-space:nowrap; }
${SCOPE} article p { font-size:13px!important; line-height:1.55!important; overflow-wrap:anywhere; }
${SCOPE} article>div:last-child { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; }
${SCOPE} article>div:last-child>span { min-width:0; max-width:100%; margin-right:0!important; overflow-wrap:anywhere; }
${SCOPE} article>div:last-child>button { float:none!important; order:1; min-height:36px; margin-left:auto!important; padding:6px!important; touch-action:manipulation; }
`
