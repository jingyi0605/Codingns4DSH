import { providerVisual, type ProviderVisual } from './provider-icons.js'
import { sessionAdapterId, subscribeSessionAdapters } from './session-adapter-cache.js'
import { resolveDshSessionId } from './workspace-session-fiber.js'

export const WORKSPACE_SESSION_ROW_SELECTOR = '[role="treeitem"]'
export const WORKSPACE_SESSION_LOGO_ATTRIBUTE = 'data-codingns-session-logo'

export interface WorkspaceSessionLogoDomController {
  /** 映射变化或测试场景可显式触发一次扫描。 */
  refresh(): void
  /** 断开观察器并移除当前文档中的所有插件节点。 */
  dispose(): void
}

export interface WorkspaceSessionLogoDomOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  readonly adapterIdForSession?: (sessionId: string) => string | undefined
  readonly visualForAdapter?: (adapterId: string | undefined) => ProviderVisual
}

/**
 * 为 DSH 0.1.6-alpha.2 会话行安装兼容注入器。
 *
 * 该版本没有 leading Slot，也没有把 sessionId 写进 DOM。这里仅读取 React
 * Fiber 上 `node.id`/`result.id` 两个已验证字段；任何不匹配都直接跳过。
 */
export function startWorkspaceSessionLogoDom(
  options: WorkspaceSessionLogoDomOptions = {},
): WorkspaceSessionLogoDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  // SessionStore 只记录显式选择；没有外部绑定时，DSH Registry 的权威默认值就是 dsh。
  const adapterIdForSession = options.adapterIdForSession
    ?? ((sessionId: string): string => sessionAdapterId(sessionId) ?? 'dsh')
  const visualForAdapter = options.visualForAdapter ?? providerVisual
  let disposed = false
  let scanQueued = false

  const scan = (): void => {
    if (disposed || dom === undefined) return
    for (const row of dom.querySelectorAll<HTMLElement>(WORKSPACE_SESSION_ROW_SELECTOR)) {
      const sessionId = resolveDshSessionId(row)
      if (sessionId === undefined) continue
      upsertSessionLogo(row, sessionId, visualForAdapter(adapterIdForSession(sessionId)), dom)
    }
  }

  const scheduleScan = (): void => {
    if (disposed || scanQueued) return
    scanQueued = true
    queueMicrotask(() => {
      scanQueued = false
      scan()
    })
  }

  const observer = dom === undefined || Observer === undefined
    ? undefined
    : new Observer(scheduleScan)
  if (observer !== undefined && dom !== undefined) {
    observer.observe(dom.documentElement, { childList: true, subtree: true })
  }
  const unsubscribe = subscribeSessionAdapters(scheduleScan)
  scan()

  return {
    refresh: scheduleScan,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      unsubscribe()
      if (dom !== undefined) removeWorkspaceSessionLogos(dom)
    },
  }
}

/** 移除当前文档中全部由本模块插入的节点。 */
export function removeWorkspaceSessionLogos(dom: Pick<Document, 'querySelectorAll'>): void {
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_LOGO_ATTRIBUTE}]`)) node.remove()
}

function upsertSessionLogo(
  row: HTMLElement,
  sessionId: string,
  visual: ProviderVisual,
  dom: Pick<Document, 'createElement'>,
): void {
  const existing = row.querySelector<HTMLElement>(`[${WORKSPACE_SESSION_LOGO_ATTRIBUTE}]`)
  const adapterKey = visual.adapterId ?? ''
  if (existing?.dataset.codingnsSessionId === sessionId
    && existing.dataset.codingnsAdapterId === adapterKey) return

  existing?.remove()
  const logo = createLogoElement(dom, sessionId, visual)
  const parent = row.tagName === 'BUTTON' && row.firstElementChild !== null
    ? row.firstElementChild
    : row
  parent.insertBefore(logo, parent.firstChild)
}

function createLogoElement(
  dom: Pick<Document, 'createElement'>,
  sessionId: string,
  visual: ProviderVisual,
): HTMLElement {
  const container = dom.createElement('span')
  container.setAttribute(WORKSPACE_SESSION_LOGO_ATTRIBUTE, '')
  container.dataset.codingnsSessionId = sessionId
  container.dataset.codingnsAdapterId = visual.adapterId ?? ''
  container.title = visual.displayName
  container.setAttribute('aria-hidden', 'true')
  Object.assign(container.style, {
    width: '16px',
    height: '16px',
    flex: '0 0 16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: '4px',
    pointerEvents: 'none',
    overflow: 'hidden',
  })

  if (visual.iconUrl !== undefined) {
    const image = dom.createElement('img')
    image.src = visual.iconUrl
    image.alt = ''
    image.setAttribute('aria-hidden', 'true')
    Object.assign(image.style, {
      width: '16px',
      height: '16px',
      display: 'block',
      objectFit: 'contain',
    })
    container.appendChild(image)
    return container
  }

  container.textContent = '?'
  Object.assign(container.style, {
    boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2, currentColor)',
    borderRadius: '4px',
    color: 'var(--dsw-alias-label-tertiary, currentColor)',
    fontSize: '10px',
    fontWeight: '600',
    lineHeight: '14px',
  })
  return container
}

export { resolveDshSessionId } from './workspace-session-fiber.js'
