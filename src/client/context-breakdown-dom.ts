/**
 * DSH 上下文面板（ContextMeter）的构成明细隐藏器。
 *
 * 面板同时展示两组不同来源的数字：百分比与 `~已用 / 窗口` 来自 Provider 上报的
 * 真实用量，而「系统 / 工具 / 消息」三行明细与分段条来自 token-meter 对本地表面
 * 的启发式估算。外部 Agent（codex 等）自己组装请求，它的系统提示、工具定义和
 * 对话历史都不经过本地表面，两组数字因此天然对不上；`contextBreakdown` 投影又
 * 是按定义全局注册的，无法只对某个会话关闭。这里在浏览器侧按会话隐藏构成部分，
 * 只保留百分比与总量。
 *
 * 依赖的 DSH 0.2.0-rc.1 对话 DOM 契约（任何一条不成立都只是不生效，不影响其他
 * 功能，也不会误改宿主界面）：
 * - 对话根节点带 `data-conversation-session`；
 * - 面板触发器是 `button[aria-haspopup="dialog"]`，展开时 `aria-expanded="true"`；
 * - 面板经 portal 直挂 `document.body`，`role="dialog"`，直接子节点依次是 header、
 *   分段条 div 与可选的明细 dl（`div > dt + dd` 结构）。
 */

import { sessionAdapterId, subscribeSessionAdapters } from './session-adapter-cache.js'

/** 命中会话的上下文面板会被打上该属性，插件样式据此隐藏构成部分。 */
export const CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE = 'data-codingns-context-breakdown-hidden'
/** 插件样式标签的幂等键。 */
export const CONTEXT_BREAKDOWN_STYLE_ID = 'codingns4dsh-context-breakdown-style'
/** 对话根节点上承载当前会话 id 的 DSH 属性。 */
export const CONTEXT_BREAKDOWN_CONVERSATION_ATTRIBUTE = 'data-conversation-session'
/** 默认隐藏构成明细的适配器：它们自己组装请求，启发式估算与真实上下文不同源。 */
export const DEFAULT_CONTEXT_BREAKDOWN_HIDDEN_ADAPTERS: readonly string[] = ['codex', 'qoder', 'qoder-cn']
/** 适配器未知时请求刷新映射的最小间隔，避免面板长时间停留时反复查询。 */
const ADAPTER_REFRESH_INTERVAL_MS = 5_000
const CONTEXT_BREAKDOWN_STYLE_TEXT = `[${CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE}]>dl{display:none!important}`
  + `[${CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE}]>div:nth-of-type(2){display:none!important}`

export interface ContextBreakdownDomController {
  /** 显式触发一次重扫，例如适配器映射由外部刷新后。 */
  refresh(): void
  /** 断开观察器、取消订阅并移除本轮标记。 */
  dispose(): void
}

export interface ContextBreakdownDomOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  /** 会话到适配器的解析；默认读取 Host 映射缓存。 */
  readonly adapterIdForSession?: (sessionId: string) => string | undefined
  /** 需要隐藏构成明细的适配器，默认是能报告真实上下文的外部适配器。 */
  readonly hiddenAdapterIds?: readonly string[]
  /** 会话适配器未知时按需刷新映射；缺省则只依赖已有缓存。 */
  readonly refreshAdapters?: () => void | Promise<void>
  readonly adapterRefreshIntervalMs?: number
  /** 时钟注入点，仅用于测试节流。 */
  readonly now?: () => number
}

/**
 * 为上下文面板安装构成明细隐藏器。
 *
 * 打开面板时才需要判定所属会话，因此只观察 `body` 的直接子节点（portal 插入），
 * 不跟踪面板内部重渲染；隐藏通过面板属性加插件样式实现，React 复用面板节点时
 * 属性仍然有效。
 */
export function startContextBreakdownDom(
  options: ContextBreakdownDomOptions = {},
): ContextBreakdownDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const adapterIdForSession = options.adapterIdForSession ?? sessionAdapterId
  const hiddenAdapterIds = new Set(options.hiddenAdapterIds ?? DEFAULT_CONTEXT_BREAKDOWN_HIDDEN_ADAPTERS)
  const refreshAdapters = options.refreshAdapters
  const adapterRefreshIntervalMs = options.adapterRefreshIntervalMs ?? ADAPTER_REFRESH_INTERVAL_MS
  const now = options.now ?? ((): number => Date.now())
  let disposed = false
  let scanQueued = false
  let lastAdapterRefresh = Number.NEGATIVE_INFINITY

  const scan = (): void => {
    if (disposed || dom === undefined) return
    const sessionId = openContextMeterSessionId(dom)
    const adapterId = sessionId === undefined ? undefined : adapterIdForSession(sessionId)
    const hideComposition = adapterId !== undefined && hiddenAdapterIds.has(adapterId)
    for (const panel of contextMeterPanels(dom)) {
      if (hideComposition) panel.setAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE, '')
      else panel.removeAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE)
    }
    if (sessionId !== undefined && adapterId === undefined) scheduleAdapterRefresh()
  }

  const scheduleScan = (): void => {
    if (disposed || scanQueued) return
    scanQueued = true
    queueMicrotask(() => {
      scanQueued = false
      scan()
    })
  }

  const scheduleAdapterRefresh = (): void => {
    if (disposed || refreshAdapters === undefined) return
    const timestamp = now()
    if (timestamp - lastAdapterRefresh < adapterRefreshIntervalMs) return
    lastAdapterRefresh = timestamp
    void (async () => {
      try {
        await refreshAdapters()
      } catch {
        // 映射刷新失败时保持现状；下一次打开面板仍会按缓存判定。
      }
      if (!disposed) scheduleScan()
    })()
  }

  installContextBreakdownStyles(dom)
  const observer = dom === undefined || Observer === undefined ? undefined : new Observer(scheduleScan)
  const observeTarget = dom?.body ?? dom?.documentElement
  if (observer !== undefined && observeTarget !== undefined && observeTarget !== null) {
    observer.observe(observeTarget, { childList: true })
  }
  const unsubscribe = subscribeSessionAdapters(scheduleScan)
  scheduleScan()

  return {
    refresh: scheduleScan,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      unsubscribe()
      if (dom === undefined) return
      for (const panel of contextMeterPanels(dom)) panel.removeAttribute(CONTEXT_BREAKDOWN_HIDDEN_ATTRIBUTE)
    },
  }
}

/** 返回当前展开着上下文面板的会话 id；没有展开的面板时返回 undefined。 */
function openContextMeterSessionId(dom: Document): string | undefined {
  for (const conversation of Array.from(dom.querySelectorAll(`[${CONTEXT_BREAKDOWN_CONVERSATION_ATTRIBUTE}]`))) {
    const sessionId = conversation.getAttribute(CONTEXT_BREAKDOWN_CONVERSATION_ATTRIBUTE)?.trim()
    if (sessionId === undefined || sessionId === '') continue
    for (const button of Array.from(conversation.querySelectorAll('button'))) {
      if (button.getAttribute('aria-haspopup') === 'dialog'
        && button.getAttribute('aria-expanded') === 'true') return sessionId
    }
  }
  return undefined
}

/** 找出挂在 body 下、带构成明细的上下文面板。 */
function contextMeterPanels(dom: Document): Element[] {
  const body = dom.body
  if (body === undefined || body === null) return []
  const panels: Element[] = []
  for (const child of Array.from(body.children)) {
    if (child.getAttribute('role') !== 'dialog') continue
    if (!hasCompositionDetails(child)) continue
    panels.push(child)
  }
  return panels
}

/** 面板的明细是 `dl > div > dt + dd`；普通 `dl` 不会包一层 div。 */
function hasCompositionDetails(panel: Element): boolean {
  for (const child of Array.from(panel.children)) {
    if (child.tagName !== 'DL') continue
    for (const row of Array.from(child.children)) {
      if (row.tagName !== 'DIV') continue
      if (row.querySelector('dt') !== null && row.querySelector('dd') !== null) return true
    }
  }
  return false
}

/** 按 quick-phrase 的既有模式幂等注入插件样式。 */
function installContextBreakdownStyles(dom: Document | undefined): void {
  if (dom === undefined || dom.head === undefined || dom.head === null) return
  const existing = Array.from(dom.head.children).some((child) => (
    child.tagName === 'STYLE' && (child as HTMLElement).dataset.pluginCss === CONTEXT_BREAKDOWN_STYLE_ID
  ))
  if (existing) return
  const style = dom.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = CONTEXT_BREAKDOWN_STYLE_ID
  style.textContent = CONTEXT_BREAKDOWN_STYLE_TEXT
  dom.head.appendChild(style)
}
