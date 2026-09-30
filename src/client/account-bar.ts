import type { CodingNsAuthSessionSnapshot } from '../shared/contracts/auth.js'
import type { CodingNsSettings } from '../shared/contracts/config.js'
import type { DshHostStatus } from '../shared/contracts/host-status.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'
import { LOGIN_PROTECTION_SESSION_EVENT, readLoginProtectionSession, readLoginProtectionSessionExpiresAt, writeLoginProtectionSession } from './features/login-protection-session.js'
import { dshThemeColor } from './theme.js'
import { attachOutsideDismissal } from './popup-dismiss.js'
import { PEER_HOST_OPEN_EVENT } from './peer-host-connection-button.js'

const SETTINGS_BUTTON_SELECTOR = 'button[aria-label="设置"]'
const ACCOUNT_ATTRIBUTE = 'data-codingns-account-button'
const MENU_ATTRIBUTE = 'data-codingns-account-menu'
const POLL_MS = 5_000
const LOGIN_REFRESH_POLL_MS = 30_000

export interface LocalIdentity { username: string; expiresAt?: number }
type ActiveAccount =
  | { kind: 'codingns'; identity: string }
  | { kind: 'local'; identity: string; scope: 'lan' | 'relay' }

export interface AccountBarController { dispose(): void }

/** 在 DSH 设置触发器旁挂载统一账户入口，兼容侧栏横排与收起竖排。 */
export function startCodingNsAccountBar(rpc: CodingNsRpcClient, dom?: Document, settingsStore?: CodingNsSettingsStore<CodingNsSettings>): AccountBarController {
  const currentDocument = dom ?? (typeof document === 'undefined' ? undefined : document)
  if (currentDocument === undefined) return { dispose() {} }
  const root = currentDocument
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let loginRefreshTimer: ReturnType<typeof setInterval> | undefined
  let loginRefreshInFlight = false
  let observer: MutationObserver | undefined
  let observeDom = true
  let resizeObserver: ResizeObserver | undefined
  let renderQueued = false
  let rendering = false
  let closeMenuDismiss: (() => void) | undefined
  let auth: CodingNsAuthSessionSnapshot = loggedOutSnapshot()
  let local: LocalIdentity | null = null
  let localSessionExpiresAt: number | null = null
  let localRelay: LocalIdentity | null = readRelayLoginIdentity()
  let status: DshHostStatus | undefined
  let latency: number | undefined
  let busy = false

  const call = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    let response
    try {
      response = await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/HTTP (?:404|405)\b/u.test(message)) throw error
      response = await rpc.call('/api', `codingns/${endpoint}`, payload)
    }
    if (!response.ok) throw new Error(response.error.message)
    return response.value as T
  }

  const refresh = async (): Promise<void> => {
    if (disposed) return
    const started = performance.now()
    const [nextAuth, nextLocal, nextStatus] = await Promise.allSettled([
      call<CodingNsAuthSessionSnapshot>('auth/snapshot', {}),
      fetchLocalIdentity(root),
      call<DshHostStatus>('host/status', {}),
    ])
    if (nextAuth.status === 'fulfilled') auth = nextAuth.value
    local = nextLocal.status === 'fulfilled' ? nextLocal.value : null
    localSessionExpiresAt = local?.expiresAt ?? null
    localRelay = readRelayLoginIdentity()
    if (nextStatus.status === 'fulfilled') {
      status = nextStatus.value
      latency = Math.max(0, Math.round(performance.now() - started))
    }
    renderAll()
    const menu = root.querySelector<HTMLElement>(`[${MENU_ATTRIBUTE}]`)
    const button = root.querySelector<HTMLButtonElement>(`button[${ACCOUNT_ATTRIBUTE}]`)
    if (menu !== null) {
      renderMenu(menu)
      if (button !== null) positionMenuUpperRight(menu, button)
    }
  }

  const scan = (): void => {
    if (disposed) return
    if (!isAccountAuthenticated()) {
      removeAccountBar()
      observeDom = true
      return
    }
    const settings = root.querySelector<HTMLElement>(SETTINGS_BUTTON_SELECTOR)
    if (settings === null) {
      observeDom = true
      return
    }
    const parent = settings.parentElement
    if (parent === null) {
      observeDom = true
      return
    }
    let button = parent.querySelector<HTMLButtonElement>(`button[${ACCOUNT_ATTRIBUTE}]`)
    if (button === null) {
      button = createAccountButton(root)
      parent.insertBefore(button, settings)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        toggleMenu(button!)
      })
    }
    observeDom = false
    observer?.disconnect()
    parent.dataset.codingnsAccountRow = 'true'
    Object.assign(parent.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      width: '100%',
      boxSizing: 'border-box',
    })
    updateAccountLayout(parent, settings, button)
    resizeObserver?.disconnect()
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver ??= new ResizeObserver(() => {
        if (!disposed) updateAccountLayout(parent, settings, button)
      })
      resizeObserver.observe(parent)
    }
    renderButton(button)
  }

  const updateAccountLayout = (parent: HTMLElement, settings: HTMLElement, button: HTMLButtonElement): void => {
    const wide = isWide(parent, settings)
    const mode = wide ? 'wide' : 'rail'
    if (button.dataset.codingnsWide === mode) return
    button.dataset.codingnsWide = mode
    parent.style.flexDirection = wide ? 'row' : 'column'
    parent.style.justifyContent = 'flex-end'
    button.style.marginLeft = wide ? 'auto' : '0'
    button.style.order = wide ? '2' : '1'
    settings.style.order = wide ? '1' : '2'
  }

  const renderAll = (): void => {
    if (disposed || rendering) return
    rendering = true
    observer?.disconnect()
    try {
      scan()
      const button = root.querySelector<HTMLButtonElement>(`button[${ACCOUNT_ATTRIBUTE}]`)
      if (button !== null) renderButton(button)
    } finally {
      rendering = false
      if (!disposed && observeDom) observer?.observe(root.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
    }
  }

  const observerCallback = (): void => {
    if (disposed || rendering || renderQueued) return
    const settings = root.querySelector<HTMLElement>(SETTINGS_BUTTON_SELECTOR)
    const button = root.querySelector<HTMLButtonElement>(`button[${ACCOUNT_ATTRIBUTE}]`)
    if (settings !== null && button !== null && settings.parentElement === button.parentElement) return
    renderQueued = true
    queueMicrotask(() => {
      renderQueued = false
      renderAll()
    })
  }
  observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(observerCallback)
  observer?.observe(root.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  // PeerHost 开关变化会改变账户入口是否存在，因此必须和设置存储订阅同一轮重绘。
  const unsubscribeSettings = settingsStore?.subscribe(() => renderAll())
  const onLoginProtectionSessionChanged = (): void => {
    localRelay = readRelayLoginIdentity()
    renderAll()
  }
  root.defaultView?.addEventListener(LOGIN_PROTECTION_SESSION_EVENT, onLoginProtectionSessionChanged)
  timer = setInterval(() => { void refresh() }, POLL_MS)
  loginRefreshTimer = setInterval(() => { void refreshLoginProtection() }, LOGIN_REFRESH_POLL_MS)
  void refresh().then(() => refreshLoginProtection())

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      if (loginRefreshTimer !== undefined) clearInterval(loginRefreshTimer)
      observer?.disconnect()
      resizeObserver?.disconnect()
      unsubscribeSettings?.()
      root.defaultView?.removeEventListener(LOGIN_PROTECTION_SESSION_EVENT, onLoginProtectionSessionChanged)
      closeMenu()
      root.querySelectorAll<HTMLElement>(`button[${ACCOUNT_ATTRIBUTE}]`).forEach((node) => node.remove())
    },
  }

  /** 在票据临近过期时续签，避免每次轮询都无意义地旋转 token。 */
  async function refreshLoginProtection(): Promise<void> {
    if (disposed || loginRefreshInFlight) return
    const relayToken = readLoginProtectionSession()
    const relayExpiresAt = readLoginProtectionSessionExpiresAt()
    const shouldRefreshRelay = relayToken !== undefined && relayExpiresAt !== null && relayExpiresAt - Date.now() <= 120_000
    const shouldRefreshLan = local !== null && (localSessionExpiresAt === null || localSessionExpiresAt - Date.now() <= 120_000)
    if (!shouldRefreshRelay && !shouldRefreshLan) return
    loginRefreshInFlight = true
    try {
      if (shouldRefreshLan) {
        const response = await (root.defaultView?.fetch.bind(root.defaultView) ?? fetch)('/__codingns/session/refresh', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) local = null
        else {
          const value = await response.json() as { expiresAt?: unknown }
          localSessionExpiresAt = typeof value.expiresAt === 'number' ? value.expiresAt : null
        }
      }
      if (shouldRefreshRelay && relayToken !== undefined) {
        const value = await call<{ token: string; expiresAt: string }>('lanAccessDsh/login/session/refresh', { token: relayToken, scope: 'relay' })
        if (typeof value.token === 'string' && value.token !== '') writeLoginProtectionSession(value.token)
      }
    } catch (error) {
      // 网络短暂失败时保留旧会话，下一轮仍会在旧票据到期前重试。
      console.warn('codingns4dsh: 登录保护会话刷新失败', error)
    } finally {
      loginRefreshInFlight = false
    }
  }

  function removeAccountBar(): void {
    closeMenu()
    root.querySelectorAll<HTMLElement>(`button[${ACCOUNT_ATTRIBUTE}]`).forEach((node) => node.remove())
  }

  function renderButton(button: HTMLButtonElement): void {
    const account = activeAccount()
    const identity = account?.identity ?? '用户'
    button.title = `${identity} · 点击管理登录`
    button.setAttribute('aria-label', `用户：${identity}`)
    button.dataset.codingnsAuth = account?.kind ?? 'unknown'
    const statusDot = button.querySelector<HTMLElement>('[data-codingns-account-status]')
    if (statusDot !== null) statusDot.style.background = 'var(--dsw-alias-state-success-primary, #35b66b)'
  }

  function activeAccount(): ActiveAccount | null {
    const remote = isRemoteContext()
    if (isLoopbackPage() && !remote && !peerHostModuleEnabled()) return null
    if (local !== null) return { kind: 'local', identity: local.username, scope: 'lan' }
    if (!remote) return null
    if (auth.status === 'authenticated' && auth.account !== null) {
      return { kind: 'codingns', identity: auth.account.email }
    }
    if (localRelay !== null) return { kind: 'local', identity: localRelay.username, scope: 'relay' }
    return null
  }

  function isAccountAuthenticated(): boolean {
    return activeAccount() !== null || shouldShowPeerHostEntry()
  }

  function shouldShowPeerHostEntry(): boolean {
    return peerHostModuleEnabled() && (isLoopbackPage() || isDesktopPage())
  }

  function peerHostModuleEnabled(): boolean {
    return settingsStore?.getSnapshot().value?.modules.peerHost === true
  }

  function isLoopbackPage(): boolean {
    const hostname = root.defaultView?.location.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '') ?? ''
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '::ffff:127.0.0.1'
  }

  function isDesktopPage(): boolean {
    return root.defaultView?.location.protocol.toLowerCase() === 'dsh-app:'
  }

  /** 关闭账户菜单并注销外部点击监听；菜单与监听始终成对回收。 */
  function closeMenu(): void {
    root.querySelectorAll<HTMLElement>(`[${MENU_ATTRIBUTE}]`).forEach((node) => node.remove())
    closeMenuDismiss?.()
    closeMenuDismiss = undefined
  }

  function toggleMenu(button: HTMLButtonElement): void {
    const existing = root.querySelector<HTMLElement>(`[${MENU_ATTRIBUTE}]`)
    if (existing !== null) {
      closeMenu()
      return
    }
    const menu = createMenu(root)
    const rect = button.getBoundingClientRect()
    Object.assign(menu.style, { top: '0px', left: '0px' })
    root.body.appendChild(menu)
    renderMenu(menu)
    positionMenuUpperRight(menu, button)
    // 触发按钮算内部：它自己的 click 负责开合，pointerdown 不重复关闭。
    // 菜单创建发生在 pointerdown 之后，因此不需要再延迟注册。
    closeMenuDismiss = attachOutsideDismissal(root, () => [menu, button], closeMenu)
  }

  function positionMenuUpperRight(menu: HTMLElement, button: HTMLButtonElement): void {
    const buttonRect = button.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const viewportWidth = root.documentElement.clientWidth || root.defaultView?.innerWidth || menuRect.width + 16
    const viewportHeight = root.documentElement.clientHeight || root.defaultView?.innerHeight || menuRect.height + 16
    const gap = 8
    const preferredLeft = buttonRect.right + gap
    const left = preferredLeft + menuRect.width <= viewportWidth - gap
      ? preferredLeft
      : Math.max(gap, buttonRect.right - menuRect.width)
    const top = Math.max(gap, buttonRect.top - menuRect.height - gap)
    Object.assign(menu.style, {
      top: `${Math.round(Math.min(top, Math.max(gap, viewportHeight - menuRect.height - gap)))}px`,
      left: `${Math.round(left)}px`,
      right: 'auto',
      bottom: 'auto',
    })
  }

  function renderMenu(menu: HTMLElement): void {
    const account = activeAccount()
    const identity = account?.kind === 'codingns' ? account.identity
      : account !== null ? `${account.identity}（本地账号）`
      : '未识别账号'
    const access = relayModeLabel()
    menu.innerHTML = ''
    menu.append(textNode(root, identity, 'strong'))
    menu.append(textNode(root, `访问：${access}${latency === undefined ? '' : ` · ${latency} ms`}`, 'span'))
    if (status !== undefined) {
      menu.append(resourceRow(root, 'CPU', status.cpuPercent))
      menu.append(resourceRow(root, '内存', status.memoryPercent))
      menu.append(textNode(root, `${formatBytes(status.memoryUsedBytes)} / ${formatBytes(status.memoryTotalBytes)}`, 'span'))
    }
    const peerHost = root.createElement('button')
    peerHost.type = 'button'
    peerHost.textContent = '管理 PeerHost'
    peerHost.title = '连接和管理其他 DSH Host'
    Object.assign(peerHost.style, menuButtonStyle())
    peerHost.addEventListener('click', () => {
      root.defaultView?.dispatchEvent(new Event(PEER_HOST_OPEN_EVENT))
      closeMenu()
    })
    menu.append(peerHost)
    if (account !== null) {
      const logout = root.createElement('button')
      logout.type = 'button'
      logout.textContent = busy ? '注销中…' : '注销登录'
      logout.disabled = busy
      Object.assign(logout.style, menuButtonStyle())
      logout.addEventListener('click', () => { void logoutCurrent(menu) })
      menu.append(logout)
    }
  }

  async function logoutCurrent(menu: HTMLElement): Promise<void> {
    busy = true
    renderMenu(menu)
    try {
      const account = activeAccount()
      if (account?.kind === 'codingns') {
        if (!isRemoteContext() || typeof window === 'undefined' || window.parent === window) {
          throw new Error('Codingns Connect 账号只能从远程访问页面注销')
        }
        // srcdoc 沙箱中的 location.origin 可能为 "null"；父页面会按 iframe 窗口校验来源。
        window.parent.postMessage({ kind: 'codingns4dsh:remote-logout' }, '*')
        return
      } else if (account?.scope === 'relay') writeLoginProtectionSession(undefined)
      else if (account?.scope === 'lan') await fetch('/__codingns/logout', { credentials: 'include', redirect: 'manual' })
      else throw new Error('当前页面没有可注销的账号会话')
      if (typeof location !== 'undefined') location.reload()
    } catch (error) {
      console.error('codingns4dsh: 用户注销失败', error)
      busy = false
      renderMenu(menu)
    }
  }
}

export async function fetchLocalIdentity(dom: Document): Promise<LocalIdentity | null> {
  // Desktop 使用 dsh-app://app，不提供网页侧的本地身份路由。
  // 只有局域网/中转 HTTP 页面才需要查询这个端点；其它协议直接视为未登录，
  // 避免在 Desktop 控制台制造无意义的 404。
  const protocol = dom.defaultView?.location.protocol
  if (protocol !== 'http:' && protocol !== 'https:') return null
  const response = await (dom.defaultView?.fetch.bind(dom.defaultView) ?? fetch)('/__codingns/session', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null
  const value = await response.json() as { authenticated?: unknown; username?: unknown; expiresAt?: unknown }
  return value.authenticated === true && typeof value.username === 'string'
    ? { username: value.username, ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}) }
    : null
}

export function readRelayLoginIdentity(): LocalIdentity | null {
  const token = readLoginProtectionSession()
  if (token === undefined) return null
  try {
    const encoded = token.split('.', 1)[0]
    if (encoded === undefined) return null
    const padded = encoded.replace(/-/gu, '+').replace(/_/gu, '/')
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { username?: unknown; scope?: unknown; expiresAt?: unknown }
    if (payload.scope !== 'relay' || typeof payload.username !== 'string' || typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) return null
    return { username: payload.username }
  } catch {
    return null
  }
}

function createAccountButton(dom: Document): HTMLButtonElement {
  const button = dom.createElement('button')
  button.type = 'button'
  button.setAttribute(ACCOUNT_ATTRIBUTE, '')
  Object.assign(button.style, { position: 'relative', width: '30px', height: '30px', padding: 0, border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))', borderRadius: '50%', background: 'var(--dsw-alias-button-elevated-fill, #545557)', color: 'var(--dsw-alias-label-primary, #fff)', cursor: 'pointer', flex: '0 0 30px', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', transition: 'background 140ms ease, border-color 140ms ease, transform 140ms ease', boxShadow: 'var(--dsw-elevation-l1, 0 1px 2px rgba(0,0,0,.12))' })
  button.addEventListener('mouseenter', () => {
    button.style.background = 'var(--dsw-alias-button-elevated-hover, var(--dsw-alias-interactive-bg-hover, #66686c))'
    button.style.borderColor = 'var(--dsw-alias-brand-primary, var(--dsw-alias-border-l2, rgba(255,255,255,.28)))'
    button.style.transform = 'translateY(-1px)'
  })
  button.addEventListener('mouseleave', () => {
    button.style.background = 'var(--dsw-alias-button-elevated-fill, #545557)'
    button.style.borderColor = 'var(--dsw-alias-border-l2, rgba(255,255,255,.16))'
    button.style.transform = 'translateY(0)'
  })
  button.addEventListener('focus', () => { button.style.outline = '2px solid var(--dsw-alias-brand-primary, #4aa3ff)'; button.style.outlineOffset = '2px' })
  button.addEventListener('blur', () => { button.style.outline = 'none' })
  button.append(createAccountIcon(dom))
  const status = dom.createElement('span')
  status.setAttribute('data-codingns-account-status', '')
  status.setAttribute('aria-hidden', 'true')
  Object.assign(status.style, { position: 'absolute', right: '0px', bottom: '0px', width: '7px', height: '7px', border: '2px solid var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-primary, #202124))', borderRadius: '50%', background: 'var(--dsw-alias-label-tertiary, #8b8d91)', boxSizing: 'border-box' })
  button.append(status)
  return button
}

function createAccountIcon(dom: Document): SVGSVGElement {
  const svg = dom.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '17')
  svg.setAttribute('height', '17')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.pointerEvents = 'none'
  svg.style.overflow = 'visible'
  const badge = dom.createElementNS('http://www.w3.org/2000/svg', 'circle')
  badge.setAttribute('cx', '12')
  badge.setAttribute('cy', '12')
  badge.setAttribute('r', '9.25')
  badge.setAttribute('fill', 'var(--dsw-alias-brand-primary, #4aa3ff)')
  badge.setAttribute('fill-opacity', '.2')
  const ring = dom.createElementNS('http://www.w3.org/2000/svg', 'circle')
  ring.setAttribute('cx', '12')
  ring.setAttribute('cy', '12')
  ring.setAttribute('r', '9.25')
  ring.setAttribute('stroke', 'var(--dsw-alias-brand-primary, #4aa3ff)')
  ring.setAttribute('stroke-opacity', '.65')
  ring.setAttribute('stroke-width', '1')
  const head = dom.createElementNS('http://www.w3.org/2000/svg', 'circle')
  head.setAttribute('cx', '12')
  head.setAttribute('cy', '8')
  head.setAttribute('r', '3.25')
  head.setAttribute('fill', 'currentColor')
  const shoulders = dom.createElementNS('http://www.w3.org/2000/svg', 'path')
  shoulders.setAttribute('d', 'M5.2 19.2c.6-3.5 3.1-5.4 6.8-5.4s6.2 1.9 6.8 5.4v.55H5.2z')
  shoulders.setAttribute('fill', 'currentColor')
  svg.append(badge, ring, head, shoulders)
  return svg
}

function createMenu(dom: Document): HTMLElement {
  const menu = dom.createElement('div')
  menu.setAttribute(MENU_ATTRIBUTE, '')
  Object.assign(menu.style, { position: 'fixed', zIndex: '10000', width: '260px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', boxSizing: 'border-box', color: dshThemeColor.labelPrimary, background: dshThemeColor.menuBackground, border: `1px solid ${dshThemeColor.border}`, borderRadius: '8px', boxShadow: dshThemeColor.prominentShadow, fontSize: '12px' })
  return menu
}

function menuButtonStyle(): Record<string, string> { return { marginTop: '4px', minHeight: '30px', border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)', borderRadius: '6px', color: 'inherit', background: 'transparent', cursor: 'pointer' } }
function textNode(dom: Document, value: string, tag: 'strong' | 'span'): HTMLElement { const node = dom.createElement(tag); node.textContent = value; return node }
function resourceRow(dom: Document, label: string, value: number): HTMLElement {
  const row = dom.createElement('div')
  Object.assign(row.style, { display: 'flex', flexDirection: 'column', gap: '3px' })
  const header = dom.createElement('div')
  Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', gap: '8px' })
  const name = dom.createElement('span')
  name.textContent = label
  const amount = dom.createElement('span')
  amount.textContent = formatPercent(value)
  Object.assign(amount.style, { fontVariantNumeric: 'tabular-nums' })
  header.append(name, amount)
  const track = dom.createElement('div')
  Object.assign(track.style, { height: '4px', overflow: 'hidden', borderRadius: '999px', background: 'var(--dsw-alias-bg-tertiary, rgba(127,127,127,.18))' })
  const fill = dom.createElement('div')
  Object.assign(fill.style, { width: `${Math.min(100, Math.max(0, value))}%`, height: '100%', borderRadius: 'inherit', background: 'var(--dsw-alias-brand-primary, var(--dsw-alias-button-info-fill, #1677ff))', transition: 'width 180ms ease' })
  track.append(fill)
  row.append(header, track)
  return row
}
function isWide(parent: HTMLElement, settings: HTMLElement): boolean { return parent.clientWidth > 96 || getComputedStyle(settings).display !== 'none' && settings.getBoundingClientRect().width > 70 }
function formatPercent(value: number): string { return `${Math.round(value)}%` }
function formatBytes(value: number): string { if (value < 1024 ** 3) return `${Math.round(value / 1024 ** 2)} MB`; return `${(value / 1024 ** 3).toFixed(1)} GB` }
function isRemoteContext(): boolean { return (globalThis as { __CODINGNS4DSH_REMOTE_WEB_CONTEXT__?: unknown }).__CODINGNS4DSH_REMOTE_WEB_CONTEXT__ === true }
function relayModeLabel(): string {
  const state = globalThis as { __CODINGNS4DSH_RELAY_MODE__?: 'direct' | 'relay' }
  if (state.__CODINGNS4DSH_RELAY_MODE__ === 'relay') return '中转'
  if (state.__CODINGNS4DSH_RELAY_MODE__ === 'direct') return '直连'
  return isRemoteContext() ? '中转' : '直连'
}
function loggedOutSnapshot(): CodingNsAuthSessionSnapshot { return { status: 'logged_out', account: null, currentDevice: null, binding: null, expiresAt: null, errorCode: null } }
