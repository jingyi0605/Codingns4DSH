import type { CodingNsAuthSessionSnapshot } from '../shared/contracts/auth.js'
import type { CodingNsSettings } from '../shared/contracts/config.js'
import type { DshHostStatus } from '../shared/contracts/host-status.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

const SETTINGS_BUTTON_SELECTOR = 'button[aria-label="设置"]'
const ACCOUNT_ATTRIBUTE = 'data-codingns-account-button'
const MENU_ATTRIBUTE = 'data-codingns-account-menu'
const POLL_MS = 5_000

export interface AccountBarController { dispose(): void }

/** 在 DSH 设置触发器旁挂载统一账户入口，兼容侧栏横排与收起竖排。 */
export function startCodingNsAccountBar(rpc: CodingNsRpcClient, dom?: Document, settings?: SettingsScope<CodingNsSettings>): AccountBarController {
  const currentDocument = dom ?? (typeof document === 'undefined' ? undefined : document)
  if (currentDocument === undefined) return { dispose() {} }
  const root = currentDocument
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let observer: MutationObserver | undefined
  let observeDom = true
  let resizeObserver: ResizeObserver | undefined
  let renderQueued = false
  let rendering = false
  let closeMenuListener: ((event: MouseEvent) => void) | undefined
  let auth: CodingNsAuthSessionSnapshot = loggedOutSnapshot()
  let local: LocalIdentity = { username: '', enabled: false }
  let relayAccessEnabled = false
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
      call<LocalIdentity>('lanAccessDsh/login/get', {}),
      call<DshHostStatus>('host/status', {}),
    ])
    if (nextAuth.status === 'fulfilled') auth = nextAuth.value
    if (nextLocal.status === 'fulfilled') local = nextLocal.value
    relayAccessEnabled = settings?.getSnapshot().value?.modules?.reverseProxy === true
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
    if (!local.enabled && !relayAccessEnabled) {
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
    parent.style.justifyContent = wide ? 'flex-start' : 'flex-end'
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
  const unsubscribeSettings = settings?.subscribe(() => {
    relayAccessEnabled = settings.getSnapshot().value?.modules?.reverseProxy === true
    renderAll()
  })
  timer = setInterval(() => { void refresh() }, POLL_MS)
  void refresh()

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      unsubscribeSettings?.()
      observer?.disconnect()
      resizeObserver?.disconnect()
      if (closeMenuListener !== undefined) {
        root.removeEventListener('click', closeMenuListener, true)
        closeMenuListener = undefined
      }
      root.querySelectorAll<HTMLElement>(`[${MENU_ATTRIBUTE}]`).forEach((node) => node.remove())
      root.querySelectorAll<HTMLElement>(`button[${ACCOUNT_ATTRIBUTE}]`).forEach((node) => node.remove())
    },
  }

  function removeAccountBar(): void {
    if (closeMenuListener !== undefined) {
      root.removeEventListener('click', closeMenuListener, true)
      closeMenuListener = undefined
    }
    root.querySelectorAll<HTMLElement>(`[${MENU_ATTRIBUTE}]`).forEach((node) => node.remove())
    root.querySelectorAll<HTMLElement>(`button[${ACCOUNT_ATTRIBUTE}]`).forEach((node) => node.remove())
  }

  function renderButton(button: HTMLButtonElement): void {
    const identity = auth.account !== null
      ? auth.account.email
      : auth.status === 'authenticated' ? 'CodingNS'
      : local.enabled && local.username ? local.username : '用户'
    button.title = `${identity} · 点击管理登录`
    button.setAttribute('aria-label', `用户：${identity}`)
    const authKind = auth.account !== null || auth.status === 'authenticated' ? 'codingns' : local.enabled ? 'local' : 'unknown'
    button.dataset.codingnsAuth = authKind
    const statusDot = button.querySelector<HTMLElement>('[data-codingns-account-status]')
    if (statusDot !== null) statusDot.style.background = authKind === 'unknown'
      ? 'var(--dsw-alias-label-tertiary, #8b8d91)'
      : 'var(--dsw-alias-state-success-primary, #35b66b)'
  }

  function toggleMenu(button: HTMLButtonElement): void {
    const existing = root.querySelector<HTMLElement>(`[${MENU_ATTRIBUTE}]`)
    if (existing !== null) {
      existing.remove()
      if (closeMenuListener !== undefined) {
        root.removeEventListener('click', closeMenuListener, true)
        closeMenuListener = undefined
      }
      return
    }
    const menu = createMenu(root)
    const rect = button.getBoundingClientRect()
    Object.assign(menu.style, { top: '0px', left: '0px' })
    root.body.appendChild(menu)
    renderMenu(menu)
    positionMenuUpperRight(menu, button)
    const close = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node) && event.target !== button) {
        menu.remove()
        root.removeEventListener('click', close, true)
        if (closeMenuListener === close) closeMenuListener = undefined
      }
    }
    closeMenuListener = close
    queueMicrotask(() => root.addEventListener('click', close, true))
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
    const identity = auth.account !== null
      ? auth.account.email
      : auth.status === 'authenticated' ? 'CodingNS 账号'
      : local.enabled && local.username ? `${local.username}（本地账号）` : '未识别账号'
    const access = relayModeLabel()
    menu.innerHTML = ''
    menu.append(textNode(root, identity, 'strong'))
    menu.append(textNode(root, `访问：${access}${latency === undefined ? '' : ` · ${latency} ms`}`, 'span'))
    if (status !== undefined) {
      menu.append(resourceRow(root, 'CPU', status.cpuPercent))
      menu.append(resourceRow(root, '内存', status.memoryPercent))
      menu.append(textNode(root, `${formatBytes(status.memoryUsedBytes)} / ${formatBytes(status.memoryTotalBytes)}`, 'span'))
    }
    const logout = root.createElement('button')
    logout.type = 'button'
    logout.textContent = busy ? '注销中…' : '注销登录'
    logout.disabled = busy
    Object.assign(logout.style, menuButtonStyle())
    logout.addEventListener('click', () => { void logoutCurrent(menu) })
    menu.append(logout)
  }

  async function logoutCurrent(menu: HTMLElement): Promise<void> {
    busy = true
    renderMenu(menu)
    try {
      // 注销目标由当前访问入口决定；LAN 页面上的 Host 可能仍保留中继站
      // 会话，但不能因为注销本地登录而一并清掉它。
      if (resolveAccountLogoutTarget() === 'relay') await call('auth/logout', {})
      else await fetch('/__codingns/logout', { credentials: 'include', redirect: 'manual' })
      if (typeof location !== 'undefined') location.reload()
    } catch (error) {
      console.error('dsh-codingns: 用户注销失败', error)
      busy = false
      renderMenu(menu)
    }
  }
}

interface LocalIdentity { enabled: boolean; username: string }

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
  Object.assign(menu.style, { position: 'fixed', zIndex: '10000', width: '260px', display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary, CanvasText)', background: 'var(--dsw-specific-menu, Canvas)', border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)', borderRadius: '8px', boxShadow: 'var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.25))', fontSize: '12px' })
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
function isRemoteContext(): boolean { return (globalThis as { __DSH_CODINGNS_REMOTE_WEB_CONTEXT__?: unknown }).__DSH_CODINGNS_REMOTE_WEB_CONTEXT__ === true }
function resolveAccountLogoutTarget(): 'local' | 'relay' {
  if (isRemoteContext()) return 'relay'
  if (typeof location !== 'undefined' && location.hostname.replace(/\.$/u, '').toLowerCase() === 'dsh.codingns.com') return 'relay'
  return 'local'
}
function relayModeLabel(): string {
  const state = globalThis as { __DSH_CODINGNS_RELAY_MODE__?: 'direct' | 'relay' }
  if (state.__DSH_CODINGNS_RELAY_MODE__ === 'relay') return '中转'
  if (state.__DSH_CODINGNS_RELAY_MODE__ === 'direct') return '直连'
  return isRemoteContext() ? '中转' : '直连'
}
function loggedOutSnapshot(): CodingNsAuthSessionSnapshot { return { status: 'logged_out', account: null, currentDevice: null, binding: null, expiresAt: null, errorCode: null } }
