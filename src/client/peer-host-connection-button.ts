import { resolveSettingsAnchor, settingsAnchorContainer } from './settings-anchor.js'
import { resolveCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'

export const PEER_HOST_BUTTON_ATTRIBUTE = 'data-codingns-peer-host-button'
export const PEER_HOST_OPEN_EVENT = 'codingns4dsh:peer-host-open'

export interface PeerHostConnectionButtonController {
  dispose(): void
}

export interface PeerHostConnectionButtonOptions {
  readonly document?: Document
  /**
   * 浏览器 locale 服务。
   *
   * 命令式模块没有 React 上下文，只能由功能模块注入；缺省时退回内置中文词典，
   * 仅用于单测或非 Cordis 宿主。
   */
  readonly locale?: CodingNsLocale
  readonly onOpen?: () => void
}

/** 在现有账户入口旁提供 PeerHost 管理按钮；模块停用时完整移除 DOM。 */
export function startPeerHostConnectionButton(options: PeerHostConnectionButtonOptions = {}): PeerHostConnectionButtonController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  if (dom === undefined) return { dispose() {} }
  const t = resolveCodingNsTranslator(options.locale)
  let disposed = false
  let observer: MutationObserver | undefined
  const scan = (): void => {
    if (disposed) return
    const account = dom.querySelector<HTMLButtonElement>('button[data-codingns-account-button]')
    // 账户入口本身也要靠锚点解析才能挂载（Desktop 下原生齿轮不渲染），因此这里
    // 复用同一套锚点规则，避免两个入口在 Desktop 下一起消失。
    const match = resolveSettingsAnchor((selector) => dom.querySelector<HTMLElement>(selector))
    const anchor = account ?? (match === null ? null : match.node)
    const parent = account?.parentElement ?? (match === null ? null : settingsAnchorContainer(match))
    if (parent === null || parent === undefined) return
    let button = parent.querySelector<HTMLButtonElement>(`button[${PEER_HOST_BUTTON_ATTRIBUTE}]`)
    if (button === null) {
      button = createPeerHostButton(dom, t)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        options.onOpen?.()
        dom.defaultView?.dispatchEvent(new Event(PEER_HOST_OPEN_EVENT))
      })
      parent.insertBefore(button, anchor?.nextSibling ?? null)
    }
  }
  observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(scan)
  observer?.observe(dom.documentElement, { childList: true, subtree: true })
  scan()
  return {
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      dom.querySelectorAll<HTMLElement>(`button[${PEER_HOST_BUTTON_ATTRIBUTE}]`).forEach((node) => node.remove())
    },
  }
}

/**
 * 创建按钮本体。
 *
 * 第二个参数供内部注入翻译函数；缺省退回内置中文词典，保证该导出在单测中仍可单独调用。
 */
export function createPeerHostButton(
  dom: Pick<Document, 'createElement'>,
  t: CodingNsTranslator = resolveCodingNsTranslator(),
): HTMLButtonElement {
  const button = dom.createElement('button')
  button.type = 'button'
  button.setAttribute(PEER_HOST_BUTTON_ATTRIBUTE, '')
  const label = t('peerHostWorkspace.manageHosts')
  button.setAttribute('aria-label', label)
  button.title = label
  button.textContent = 'Host'
  Object.assign(button.style, {
    minWidth: '30px',
    height: '30px',
    padding: '0 6px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))',
    borderRadius: '6px',
    background: 'var(--dsw-alias-button-elevated-fill, #545557)',
    color: 'var(--dsw-alias-label-primary, #fff)',
    cursor: 'pointer',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    fontWeight: '600',
  })
  return button
}
