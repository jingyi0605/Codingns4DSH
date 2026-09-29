import type { PeerHostClientRecord, PeerHostRoute } from '../shared/contracts/peer-host.js'
import { PEER_HOST_OPEN_EVENT } from './peer-host-connection-button.js'
import { fetchLocalIdentity, readRelayLoginIdentity, type LocalIdentity } from './account-bar.js'
import type { CodingNsRpcClient } from './features/types.js'
import { createPeerHostManagementApi, type PeerHostManagementApi, type PeerHostCreateRequest } from './peer-host-management-api.js'

export interface PeerHostManagementPanelController { dispose(): void }

export interface PeerHostManagementPanelOptions {
  readonly document?: Document
  readonly rpc: CodingNsRpcClient
  readonly api?: PeerHostManagementApi
}

/** PeerHost 管理面板；入口来自统一账户菜单，面板只渲染脱敏记录。 */
export function startPeerHostManagementPanel(options: PeerHostManagementPanelOptions): PeerHostManagementPanelController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  if (dom === undefined) return { dispose() {} }
  const api = options.api ?? createPeerHostManagementApi(options.rpc)
  let disposed = false
  let overlay: HTMLElement | null = null
  const open = (): void => {
    if (disposed) return
    if (overlay === null) overlay = createOverlay(dom, api, () => { overlay = null })
    void refreshList(overlay, api)
  }
  dom.defaultView?.addEventListener(PEER_HOST_OPEN_EVENT, open)
  return {
    dispose() {
      if (disposed) return
      disposed = true
      dom.defaultView?.removeEventListener(PEER_HOST_OPEN_EVENT, open)
      overlay?.remove()
      overlay = null
    },
  }
}

function createOverlay(dom: Document, api: PeerHostManagementApi, onClose: () => void): HTMLElement {
  const overlay = dom.createElement('div')
  overlay.setAttribute('data-codingns-peer-host-panel', '')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', '管理其他 DSH Host')
  Object.assign(overlay.style, {
    position: 'fixed', right: '16px', bottom: '56px', zIndex: '9999',
    width: 'min(560px, calc(100vw - 32px))', maxHeight: 'min(760px, calc(100vh - 80px))',
    overflow: 'auto', padding: '16px', border: '1px solid var(--dsw-alias-border-l2, #555)',
    borderRadius: '8px', background: 'var(--dsw-alias-bg-primary, #202124)',
    color: 'var(--dsw-alias-label-primary, #fff)', boxShadow: '0 12px 32px rgba(0,0,0,.28)',
  })
  const header = dom.createElement('header')
  const title = dom.createElement('strong')
  title.textContent = '管理其他 DSH Host'
  const close = actionButton(dom, '关闭', () => { overlay.remove(); onClose() })
  close.setAttribute('aria-label', '关闭 PeerHost 管理')
  Object.assign(close.style, { float: 'right' })
  header.append(title, close)
  const message = dom.createElement('div')
  message.setAttribute('role', 'status')
  message.setAttribute('data-codingns-peer-host-message', '')
  Object.assign(message.style, { clear: 'both', minHeight: '20px', margin: '10px 0', color: 'var(--dsw-alias-label-secondary, #bbb)' })
  const list = dom.createElement('div')
  list.setAttribute('data-codingns-peer-host-list', '')
  const form = createAddForm(dom, api, list, message)
  overlay.append(header, message, form, list)
  dom.body.append(overlay)
  return overlay
}

function createAddForm(dom: Document, api: PeerHostManagementApi, list: HTMLElement, message: HTMLElement): HTMLElement {
  const form = dom.createElement('form')
  form.setAttribute('data-codingns-peer-host-add-form', '')
  const title = dom.createElement('strong')
  title.textContent = '添加 PeerHost'
  const name = input(dom, '名称', 'text', 'data-codingns-peer-host-name')
  const routeKind = dom.createElement('select')
  routeKind.required = true
  for (const option of [['lan', '局域网'], ['relay', '中转（当前不可用）']] as const) {
    const item = dom.createElement('option')
    item.value = option[0]
    item.textContent = option[1]
    item.setAttribute('data-codingns-peer-host-route-option', option[0])
    routeKind.append(item)
  }
  const routeKindLabel = dom.createElement('label')
  routeKindLabel.textContent = '连接方式'
  routeKindLabel.append(routeKind)
  const url = input(dom, 'Host 地址', 'url', 'data-codingns-peer-host-url')
  const deviceId = input(dom, '中转设备标识', 'text', 'data-codingns-peer-host-device-id')
  const relayEntryId = input(dom, '中转绑定标识', 'text', 'data-codingns-peer-host-relay-entry-id')
  const transportVersion = input(dom, '中转协议版本', 'text', 'data-codingns-peer-host-transport-version')
  const username = input(dom, '目标 Host 用户名', 'text', 'data-codingns-peer-host-username')
  const password = input(dom, '目标 Host 密码', 'password', 'data-codingns-peer-host-password')
  password.input.autocomplete = 'current-password'
  const identity = dom.createElement('small')
  identity.setAttribute('data-codingns-peer-host-identity', '')
  identity.textContent = '正在识别当前登录账号…'
  const routeFields = dom.createElement('div')
  routeFields.append(url.wrapper, deviceId.wrapper, relayEntryId.wrapper, transportVersion.wrapper)
  const updateRouteFields = (): void => {
    const relay = routeKind.value === 'relay'
    url.wrapper.hidden = relay
    deviceId.wrapper.hidden = !relay
    relayEntryId.wrapper.hidden = !relay
    transportVersion.wrapper.hidden = !relay
    url.input.required = !relay
    deviceId.input.required = relay
    relayEntryId.input.required = relay
    transportVersion.input.required = relay
    if (relay) message.textContent = '当前 Host 后端尚未启用中转 PeerHost 路由，不能创建看似可用的中转连接。'
    else if (message.textContent?.includes('中转 PeerHost')) message.textContent = ''
  }
  routeKind.addEventListener('change', updateRouteFields)
  updateRouteFields()
  const submit = actionButton(dom, '添加并登录', () => undefined)
  submit.type = 'submit'
  form.append(title, name.wrapper, routeKindLabel, identity, routeFields, username.wrapper, password.wrapper, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (routeKind.value === 'relay') {
      message.textContent = '中转 PeerHost 当前不可用，请改用局域网地址。'
      return
    }
    const route: PeerHostRoute = { kind: 'lan', baseUrl: url.input.value.trim(), normalizedOrigin: '' }
    const request: PeerHostCreateRequest = { displayName: name.input.value.trim(), route }
    submit.disabled = true
    submit.textContent = '添加中…'
    void api.create(request)
      .then(async (record) => {
        const account = { username: username.input.value.trim(), password: password.input.value }
        if (account.username === '' || account.password === '') return record
        await api.login({ peerHostId: record.id, ...account })
        return record
      })
      .then(() => refreshList(list.parentElement!, api))
      .then(() => { message.textContent = 'PeerHost 已添加并完成登录' })
      .catch((error) => { message.textContent = error instanceof Error ? error.message : String(error) })
      .finally(() => { submit.disabled = false; submit.textContent = '添加并登录' })
  })
  void hydrateIdentity(dom, routeKind, username.input, identity, message).then(updateRouteFields)
  return form
}

async function hydrateIdentity(dom: Document, routeKind: HTMLSelectElement, username: HTMLInputElement, identity: HTMLElement, message: HTMLElement): Promise<void> {
  let local: LocalIdentity | null = null
  try { local = await fetchLocalIdentity(dom) } catch { local = null }
  const relay = readRelayLoginIdentity()
  if (local !== null) {
    username.value = local.username
    identity.textContent = `自动识别：本地保护账号（${local.username}）；密码仅在本次登录时提交`
    routeKind.value = 'lan'
    return
  }
  if (relay !== null) {
    username.value = relay.username
    identity.textContent = `自动识别：中转账号（${relay.username}）；当前中转 PeerHost 路由不可用`
    routeKind.value = 'relay'
    message.textContent = '已识别中转账号，但当前 Host 后端尚未启用中转 PeerHost 路由。'
    return
  }
  identity.textContent = '未识别登录账号；请手动填写目标 Host 用户名和密码'
}

async function refreshList(overlay: HTMLElement, api: PeerHostManagementApi): Promise<void> {
  const list = overlay.querySelector<HTMLElement>('[data-codingns-peer-host-list]')
  if (list === null) return
  list.textContent = '正在读取 PeerHost...'
  try {
    const records = await api.list()
    list.textContent = ''
    for (const record of records) list.append(renderRecord(overlay.ownerDocument, api, record, list))
  } catch (error) {
    list.textContent = error instanceof Error ? error.message : String(error)
  }
}

function renderRecord(dom: Document, api: PeerHostManagementApi, record: PeerHostClientRecord, list: HTMLElement): HTMLElement {
  const row = dom.createElement('article')
  row.setAttribute('data-peer-host-id', record.id)
  Object.assign(row.style, { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))' })
  const title = dom.createElement('strong')
  title.textContent = `${record.displayName} · ${record.route.kind === 'lan' ? '局域网' : '中转'} · ${record.status}`
  const detail = dom.createElement('div')
  detail.textContent = `DSH ${record.dshVersion ?? '未知'} · 插件 ${record.pluginVersion ?? '未知'} · fingerprint ${redactFingerprint(record.fingerprint)}${record.lastErrorCode === null ? '' : ` · ${record.lastErrorCode}`}`
  const actions = dom.createElement('div')
  actions.append(
    actionButton(dom, '编辑', () => openEditForm(dom, api, record, row, list)),
    actionButton(dom, '检查', () => run(() => api.check(record.id))),
    actionButton(dom, '重连', () => run(() => api.reconnect(record.id))),
    actionButton(dom, '登录', () => openLoginForm(dom, api, record.id, row, list)),
    actionButton(dom, '退出', () => run(() => api.logout(record.id))),
    actionButton(dom, '删除', () => {
      if (dom.defaultView?.confirm(`确认删除 PeerHost“${record.displayName}”？`) !== true) return
      run(() => api.remove(record.id))
    }),
  )
  row.append(title, detail, actions)
  return row

  function run(operation: () => Promise<unknown>): void {
    void operation().then(() => refreshList(list.parentElement!, api)).catch((error) => { detail.textContent = error instanceof Error ? error.message : String(error) })
  }
}

function openLoginForm(dom: Document, api: PeerHostManagementApi, peerHostId: string, row: HTMLElement, list: HTMLElement): void {
  row.querySelector<HTMLElement>('[data-codingns-peer-host-credentials]')?.remove()
  const form = dom.createElement('form')
  form.setAttribute('data-codingns-peer-host-credentials', '')
  const username = input(dom, '目标 Host 用户名', 'text', 'data-codingns-peer-host-username')
  const password = input(dom, '目标 Host 密码', 'password', 'data-codingns-peer-host-password')
  const identity = dom.createElement('small')
  identity.textContent = '正在识别当前登录账号…'
  const submit = actionButton(dom, '提交登录', () => undefined)
  submit.type = 'submit'
  form.append(identity, username.wrapper, password.wrapper, submit)
  row.append(form)
  void hydrateLoginIdentity(dom, username.input, identity)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!username.input.value.trim() || !password.input.value) return
    submit.disabled = true
    submit.textContent = '登录中…'
    void api.login({ peerHostId, username: username.input.value.trim(), password: password.input.value })
      .then(() => refreshList(list.parentElement!, api))
      .catch((error) => { identity.textContent = error instanceof Error ? error.message : String(error) })
      .finally(() => { submit.disabled = false; submit.textContent = '提交登录' })
  })
}

async function hydrateLoginIdentity(dom: Document, username: HTMLInputElement, identity: HTMLElement): Promise<void> {
  let local: LocalIdentity | null = null
  try { local = await fetchLocalIdentity(dom) } catch { local = null }
  const relay = readRelayLoginIdentity()
  const value = local ?? relay
  if (value === null) {
    identity.textContent = '未识别登录账号；密码不会被保存到浏览器'
    return
  }
  username.value = value.username
  identity.textContent = `自动识别：${local !== null ? '本地保护账号' : '中转账号'}（${value.username}）；密码不会被保存到浏览器`
}

function openEditForm(dom: Document, api: PeerHostManagementApi, record: PeerHostClientRecord, row: HTMLElement, list: HTMLElement): void {
  row.querySelector<HTMLElement>('[data-codingns-peer-host-edit]')?.remove()
  const form = dom.createElement('form')
  form.setAttribute('data-codingns-peer-host-edit', '')
  const name = input(dom, '名称', 'text', 'data-codingns-peer-host-name')
  name.input.value = record.displayName
  const url = input(dom, 'Host 地址（重新输入）', 'url', 'data-codingns-peer-host-url')
  const submit = actionButton(dom, '保存', () => undefined)
  submit.type = 'submit'
  const note = dom.createElement('small')
  note.textContent = record.route.kind === 'lan' ? '出于隐私保护，已保存地址不会回传到客户端，请重新输入。' : '中转路由由 Host 侧保存，当前不可在客户端修改。'
  form.append(name.wrapper, ...(record.route.kind === 'lan' ? [url.wrapper] : []), note, submit)
  row.append(form)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!name.input.value.trim()) return
    const route = record.route.kind === 'lan'
      ? { kind: 'lan' as const, baseUrl: url.input.value.trim(), normalizedOrigin: '' }
      : undefined
    if (record.route.kind === 'lan' && !url.input.value.trim()) return
    submit.disabled = true
    void api.update({ peerHostId: record.id, displayName: name.input.value.trim(), ...(route === undefined ? {} : { route }) })
      .then(() => refreshList(list.parentElement!, api))
      .catch((error) => { note.textContent = error instanceof Error ? error.message : String(error) })
      .finally(() => { submit.disabled = false })
  })
}

function actionButton(dom: Document, label: string, action: () => void): HTMLButtonElement {
  const button = dom.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', action)
  Object.assign(button.style, { margin: '2px 4px 2px 0', minHeight: '28px', padding: '0 8px', border: '1px solid var(--dsw-alias-border-l2, #777)', borderRadius: '6px', color: 'inherit', background: 'transparent', cursor: 'pointer' })
  return button
}

function input(dom: Document, label: string, type: string, attribute?: string): { wrapper: HTMLElement; input: HTMLInputElement } {
  const wrapper = dom.createElement('label')
  wrapper.textContent = label
  const control = dom.createElement('input')
  control.type = type
  control.required = true
  if (attribute !== undefined) control.setAttribute(attribute, '')
  Object.assign(wrapper.style, { display: 'flex', flexDirection: 'column', gap: '3px', margin: '6px 0' })
  Object.assign(control.style, { minHeight: '28px', boxSizing: 'border-box', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2, #777)', borderRadius: '4px', padding: '3px 6px' })
  wrapper.append(control)
  return { wrapper, input: control }
}

function redactFingerprint(value: string | null): string {
  if (value === null || value.length <= 12) return value ?? '未知'
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}
