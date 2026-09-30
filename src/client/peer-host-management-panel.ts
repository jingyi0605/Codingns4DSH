import type { PeerHostClientRecord, PeerHostRoute } from '../shared/contracts/peer-host.js'
import type { DshHostStatus } from '../shared/contracts/host-status.js'
import { PEER_HOST_OPEN_EVENT } from './peer-host-connection-button.js'
import { fetchLocalIdentity, readRelayLoginIdentity, type LocalIdentity } from './account-bar.js'
import type { CodingNsRpcClient } from './features/types.js'
import { createPeerHostManagementApi, type PeerHostManagementApi, type PeerHostCreateRequest } from './peer-host-management-api.js'
import { dshThemeColor } from './theme.js'

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
    position: 'fixed', inset: '0', zIndex: '9999', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 'max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))',
    boxSizing: 'border-box', background: dshThemeColor.overlay,
  })
  const dialog = dom.createElement('section')
  Object.assign(dialog.style, {
    width: 'min(980px, 100%)', maxHeight: '100%', overflow: 'auto', boxSizing: 'border-box',
    padding: '22px 24px 24px', border: `1px solid ${dshThemeColor.border}`, borderRadius: '10px',
    background: dshThemeColor.menuBackground, color: dshThemeColor.labelPrimary, boxShadow: dshThemeColor.prominentShadow,
  })
  const header = dom.createElement('header')
  Object.assign(header.style, { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', paddingBottom: '14px', borderBottom: `1px solid ${dshThemeColor.border}` })
  const heading = dom.createElement('div')
  Object.assign(heading.style, { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '0' })
  const title = dom.createElement('strong')
  title.textContent = '管理其他 DSH Host'
  Object.assign(title.style, { fontSize: '18px', lineHeight: '1.35' })
  const subtitle = dom.createElement('span')
  subtitle.textContent = '连接并管理已登记的其他工作主机'
  Object.assign(subtitle.style, { color: dshThemeColor.labelSecondary, fontSize: '12px', lineHeight: '1.5' })
  heading.append(title, subtitle)
  const close = actionButton(dom, '', () => { overlay.remove(); onClose() })
  close.setAttribute('aria-label', '关闭 PeerHost 管理')
  close.title = '关闭'
  close.append(createHeaderIcon(dom, 'close'))
  styleHeaderIconButton(close, 'close')
  const addToggle = actionButton(dom, '', () => {
    addToggle.setAttribute('aria-expanded', 'true')
    openAddDialog(dom, overlay, api, () => addToggle.setAttribute('aria-expanded', 'false'))
  })
  addToggle.setAttribute('aria-label', '添加 Host')
  addToggle.title = '添加 Host'
  addToggle.setAttribute('aria-expanded', 'false')
  addToggle.append(createHeaderIcon(dom, 'plus'))
  styleHeaderIconButton(addToggle, 'add')
  const headerActions = dom.createElement('div')
  Object.assign(headerActions.style, { display: 'flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' })
  headerActions.append(addToggle, close)
  header.append(heading, headerActions)
  const listSection = dom.createElement('section')
  Object.assign(listSection.style, { padding: '14px 0 18px', borderBottom: `1px solid ${dshThemeColor.border}` })
  const listHeading = dom.createElement('div')
  Object.assign(listHeading.style, { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 10px', marginBottom: '10px' })
  const listTitle = dom.createElement('strong')
  listTitle.textContent = '已登记的 Host'
  const listHint = dom.createElement('span')
  listHint.textContent = '管理连接、资源和访问状态'
  Object.assign(listHint.style, { color: dshThemeColor.labelSecondary, fontSize: '11px', lineHeight: '1.4' })
  listHeading.append(listTitle, listHint)
  const list = dom.createElement('div')
  list.setAttribute('data-codingns-peer-host-list', '')
  Object.assign(list.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 300px))',
    justifyContent: 'start',
    gap: '12px',
    width: '100%',
    maxWidth: '936px',
  })
  listSection.append(listHeading, list)
  dialog.append(header, listSection)
  overlay.append(dialog)
  overlay.addEventListener('click', (event) => { if (event.target === overlay) { overlay.remove(); onClose() } })
  dom.body.append(overlay)
  return overlay
}

interface FormDialogParts {
  readonly overlay: HTMLElement
  readonly body: HTMLElement
  readonly message: HTMLElement
  readonly close: () => void
}

function createFormDialog(dom: Document, parent: HTMLElement, titleText: string, onClose: () => void): FormDialogParts {
  const formOverlay = dom.createElement('div')
  formOverlay.setAttribute('data-codingns-peer-host-form-dialog', '')
  formOverlay.setAttribute('role', 'dialog')
  formOverlay.setAttribute('aria-modal', 'true')
  formOverlay.setAttribute('aria-label', titleText)
  Object.assign(formOverlay.style, {
    position: 'fixed', inset: '0', zIndex: '10000', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 'max(16px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(16px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))',
    boxSizing: 'border-box', background: dshThemeColor.overlay,
  })
  const dialog = dom.createElement('section')
  Object.assign(dialog.style, {
    width: 'min(480px, 100%)', maxHeight: '100%', overflow: 'auto', boxSizing: 'border-box',
    padding: '20px 22px 22px', border: `1px solid ${dshThemeColor.border}`, borderRadius: '10px',
    background: dshThemeColor.menuBackground, color: dshThemeColor.labelPrimary, boxShadow: dshThemeColor.prominentShadow,
  })
  const header = dom.createElement('header')
  Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', paddingBottom: '12px', borderBottom: `1px solid ${dshThemeColor.border}` })
  const title = dom.createElement('strong')
  title.textContent = titleText
  Object.assign(title.style, { fontSize: '16px', lineHeight: '1.35' })
  const closeButton = actionButton(dom, '', closeDialog)
  closeButton.setAttribute('aria-label', `关闭${titleText}`)
  closeButton.title = '关闭'
  closeButton.append(createHeaderIcon(dom, 'close'))
  styleHeaderIconButton(closeButton, 'close')
  header.append(title, closeButton)
  const message = dom.createElement('div')
  message.setAttribute('role', 'status')
  message.setAttribute('data-codingns-peer-host-message', '')
  message.hidden = true
  Object.assign(message.style, { margin: '12px 0 4px', color: dshThemeColor.labelSecondary, fontSize: '12px', lineHeight: '1.5' })
  const body = dom.createElement('div')
  Object.assign(body.style, { display: 'flex', flexDirection: 'column', gap: '8px' })
  dialog.append(header, message, body)
  formOverlay.append(dialog)
  formOverlay.addEventListener('click', (event) => { if (event.target === formOverlay) closeDialog() })
  parent.append(formOverlay)
  let closed = false
  function closeDialog(): void {
    if (closed) return
    closed = true
    formOverlay.remove()
    onClose()
  }
  return { overlay: formOverlay, body, message, close: closeDialog }
}

function openAddDialog(dom: Document, parent: HTMLElement, api: PeerHostManagementApi, onClose: () => void): void {
  const modal = createFormDialog(dom, parent, '添加 Host', onClose)
  modal.body.append(createAddForm(dom, api, parent, modal.message))
}

function createAddForm(dom: Document, api: PeerHostManagementApi, panel: HTMLElement, message: HTMLElement): HTMLElement {
  const form = dom.createElement('form')
  form.setAttribute('data-codingns-peer-host-add-form', '')
  Object.assign(form.style, { display: 'flex', flexDirection: 'column', gap: '8px' })
  const name = input(dom, '名称（可选）', 'text', 'data-codingns-peer-host-name')
  name.input.required = false
  const url = input(dom, 'Host 地址', 'url', 'data-codingns-peer-host-url')
  const username = input(dom, '目标 Host 用户名', 'text', 'data-codingns-peer-host-username')
  const password = input(dom, '目标 Host 密码', 'password', 'data-codingns-peer-host-password')
  password.input.autocomplete = 'current-password'
  const identity = dom.createElement('small')
  identity.setAttribute('data-codingns-peer-host-identity', '')
  identity.textContent = '正在识别当前登录账号…'
  const identityNote = dom.createElement('small')
  identityNote.textContent = '登录信息只用于目标 Host 会话；密码不会保存到浏览器。'
  Object.assign(identityNote.style, { color: dshThemeColor.labelSecondary, fontSize: '11px', lineHeight: '1.5' })
  const submit = actionButton(dom, '添加并登录', () => undefined)
  submit.type = 'submit'
  Object.assign(submit.style, { alignSelf: 'flex-start', marginTop: '4px', padding: '0 14px', background: dshThemeColor.accent, borderColor: dshThemeColor.accent, color: dshThemeColor.primaryForeground })
  form.append(name.wrapper, url.wrapper, identity, identityNote, username.wrapper, password.wrapper, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const route: PeerHostRoute = { kind: 'lan', baseUrl: url.input.value.trim(), normalizedOrigin: '' }
    const request: PeerHostCreateRequest = { displayName: name.input.value.trim(), route }
    submit.disabled = true
    submit.textContent = '添加中…'
    void api.create(request)
      .then(async (record) => {
        // 登录依赖握手状态 ready，顺序必须是创建 -> 握手检查 -> 登录。
        const checked = await api.check(record.id)
        const account = { username: username.input.value.trim(), password: password.input.value }
        if (checked.status !== 'ready' || account.username === '' || account.password === '') return { record: checked, loggedIn: false }
        await api.login({ peerHostId: checked.id, ...account })
        return { record: checked, loggedIn: true }
      })
      .then(async ({ record, loggedIn }) => {
        await refreshList(panel, api)
        setMessage(loggedIn ? 'PeerHost 已添加并完成登录' : `PeerHost 已添加，但握手状态为“${statusLabel(record.status)}”`)
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => { submit.disabled = false; submit.textContent = '添加并登录' })
  })
  void hydrateIdentity(dom, username.input, identity)
  return form

  function setMessage(text: string): void {
    message.textContent = text
    message.hidden = text === ''
  }
}

async function hydrateIdentity(dom: Document, username: HTMLInputElement, identity: HTMLElement): Promise<void> {
  let local: LocalIdentity | null = null
  try { local = await fetchLocalIdentity(dom) } catch { local = null }
  const relay = readRelayLoginIdentity()
  if (local !== null) {
    username.value = local.username
    identity.textContent = `已读取当前页面账号“${local.username}”作为用户名建议；这不会自动登录远程 Host`
    return
  }
  if (relay !== null) {
    username.value = relay.username
    identity.textContent = `已读取当前中转账号“${relay.username}”作为用户名建议；仍需目标 Host 自己的密码`
    return
  }
  identity.textContent = '未识别当前页面账号；请填写目标 Host 的用户名和密码'
}

async function refreshList(overlay: HTMLElement, api: PeerHostManagementApi): Promise<void> {
  const list = overlay.querySelector<HTMLElement>('[data-codingns-peer-host-list]')
  if (list === null) return
  list.textContent = '正在读取 PeerHost...'
  try {
    const records = await api.list()
    list.textContent = ''
    if (records.length === 0) {
      const empty = list.ownerDocument.createElement('p')
      empty.textContent = '尚未添加其他 Host。点击右上角“+”添加。'
      Object.assign(empty.style, { margin: '6px 0 0', color: dshThemeColor.labelSecondary, fontSize: '12px' })
      list.append(empty)
      return
    }
    const cards = await Promise.all(records.map(async (record) => ({
      record,
      // 未握手或未登录的记录不能通过代理读取远端资源，避免把业务错误当成 RPC 格式错误。
      status: record.status === 'ready' ? await api.status(record.id).catch(() => null) : null,
    })))
    for (const card of cards) list.append(renderRecord(overlay.ownerDocument, api, card.record, list, card.status, overlay))
  } catch (error) {
    list.textContent = error instanceof Error ? error.message : String(error)
  }
}

function renderRecord(dom: Document, api: PeerHostManagementApi, record: PeerHostClientRecord, list: HTMLElement, hostStatus: DshHostStatus | null, panel: HTMLElement): HTMLElement {
  const row = dom.createElement('article')
  row.setAttribute('data-peer-host-id', record.id)
  Object.assign(row.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    width: '300px',
    height: '220px',
    minWidth: '0',
    boxSizing: 'border-box',
    overflow: 'hidden',
    position: 'relative',
    padding: '10px',
    border: `1px solid ${dshThemeColor.border}`,
    borderRadius: '8px',
    background: dshThemeColor.cardBackground,
    boxShadow: dshThemeColor.subtleShadow,
  })
  const titleRow = dom.createElement('div')
  Object.assign(titleRow.style, { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0', minHeight: '20px' })
  const title = dom.createElement('strong')
  title.textContent = record.displayName
  Object.assign(title.style, { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px', lineHeight: '1.3' })
  const status = dom.createElement('span')
  status.textContent = statusLabel(record.status)
  Object.assign(status.style, { flex: '0 0 auto', padding: '2px 6px', borderRadius: '999px', color: record.status === 'ready' ? dshThemeColor.success : dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle, fontSize: '10px', lineHeight: '1.2' })
  titleRow.append(title, status)
  const hostname = dom.createElement('div')
  hostname.textContent = `主机名：${record.hostname ?? '未上报'}`
  Object.assign(hostname.style, { color: dshThemeColor.labelSecondary, fontSize: '11px', lineHeight: '1.35', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  const metadata = dom.createElement('div')
  Object.assign(metadata.style, { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px', padding: '4px 0', borderTop: `1px solid ${dshThemeColor.border}`, borderBottom: `1px solid ${dshThemeColor.border}` })
  metadata.append(metaItem(dom, 'DSH 版本', record.dshVersion ?? '未知'), metaItem(dom, '配置文件', record.configProfile ?? '默认配置'))
  const resources = dom.createElement('div')
  Object.assign(resources.style, { display: 'flex', flexDirection: 'column', gap: '4px' })
  resources.append(resourceMeter(dom, 'CPU', hostStatus === null ? null : hostStatus.cpuPercent, hostStatus === null ? null : `${Math.round(hostStatus.cpuPercent)}%`))
  resources.append(resourceMeter(dom, '内存', hostStatus === null ? null : hostStatus.memoryPercent, hostStatus === null ? null : `${formatBytes(hostStatus.memoryUsedBytes)} / ${formatBytes(hostStatus.memoryTotalBytes)}`))
  const actions = dom.createElement('div')
  Object.assign(actions.style, { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '4px', marginTop: 'auto' })
  actions.append(
    actionButton(dom, '编辑', () => openEditForm(dom, api, record, panel)),
    actionButton(dom, '测试', () => run(() => api.check(record.id))),
    actionButton(dom, record.status === 'disabled' ? '启用' : '禁用', () => run(() => record.status === 'disabled' ? api.enable(record.id) : api.disable(record.id))),
    actionButton(dom, '登录', () => openLoginForm(dom, api, record.id, row, list)),
    actionButton(dom, '退出登录', () => run(() => api.logout(record.id))),
    actionButton(dom, '删除', () => {
      if (dom.defaultView?.confirm(`确认删除 PeerHost“${record.displayName}”？`) !== true) return
      run(() => api.remove(record.id))
    }),
  )
  for (const button of actions.querySelectorAll('button')) {
    Object.assign(button.style, { width: '100%', minWidth: '0', minHeight: '26px', padding: '0 4px', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
  }
  row.append(titleRow, hostname, metadata, resources, actions)
  return row

  function run(operation: () => Promise<unknown>): void {
    void operation().then(() => refreshList(panel, api)).catch((error) => { hostname.textContent = error instanceof Error ? error.message : String(error) })
  }
}

function metaItem(dom: Document, label: string, value: string): HTMLElement {
  const item = dom.createElement('div')
  Object.assign(item.style, { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' })
  const key = dom.createElement('span')
  key.textContent = label
  Object.assign(key.style, { color: dshThemeColor.labelTertiary, fontSize: '10px' })
  const content = dom.createElement('span')
  content.textContent = value
  Object.assign(content.style, { color: dshThemeColor.labelPrimary, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  item.append(key, content)
  return item
}

function resourceMeter(dom: Document, label: string, percent: number | null, value: string | null): HTMLElement {
  const item = dom.createElement('div')
  const header = dom.createElement('div')
  Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', gap: '8px', color: dshThemeColor.labelSecondary, fontSize: '10px', lineHeight: '1.2' })
  const name = dom.createElement('span')
  name.textContent = label
  const amount = dom.createElement('span')
  amount.textContent = value ?? '暂无采样'
  header.append(name, amount)
  const track = dom.createElement('div')
  Object.assign(track.style, { height: '4px', marginTop: '2px', overflow: 'hidden', borderRadius: '999px', background: dshThemeColor.surfaceSubtle })
  const fill = dom.createElement('div')
  Object.assign(fill.style, { width: `${Math.min(100, Math.max(0, percent ?? 0))}%`, height: '100%', borderRadius: 'inherit', background: percent === null ? dshThemeColor.labelTertiary : dshThemeColor.accent })
  track.append(fill)
  item.append(header, track)
  return item
}

function openLoginForm(dom: Document, api: PeerHostManagementApi, peerHostId: string, row: HTMLElement, list: HTMLElement): void {
  row.querySelector<HTMLElement>('[data-codingns-peer-host-credentials]')?.remove()
  const form = dom.createElement('form')
  form.setAttribute('data-codingns-peer-host-credentials', '')
  Object.assign(form.style, {
    position: 'absolute', inset: '0', zIndex: '1', display: 'flex', flexDirection: 'column', gap: '4px',
    boxSizing: 'border-box', overflow: 'auto', padding: '10px', background: dshThemeColor.cardBackground,
  })
  const username = input(dom, '目标 Host 用户名', 'text', 'data-codingns-peer-host-username')
  const password = input(dom, '目标 Host 密码', 'password', 'data-codingns-peer-host-password')
  const identity = dom.createElement('small')
  identity.setAttribute('data-codingns-peer-host-identity', '')
  Object.assign(identity.style, { color: dshThemeColor.labelSecondary, fontSize: '11px', lineHeight: '1.5' })
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
    void api.check(peerHostId)
      .then(async (record) => {
        if (record.status !== 'ready') throw new Error(`PeerHost 当前状态为“${statusLabel(record.status)}”`)
        return api.login({ peerHostId, username: username.input.value.trim(), password: password.input.value })
      })
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
    identity.textContent = '未识别当前页面账号；请填写目标 Host 的用户名和密码'
    return
  }
  username.value = value.username
  identity.textContent = `已读取当前页面账号“${value.username}”作为用户名建议；这不会自动登录远程 Host`
}

function openEditForm(dom: Document, api: PeerHostManagementApi, record: PeerHostClientRecord, panel: HTMLElement): void {
  const modal = createFormDialog(dom, panel, '编辑 Host', () => undefined)
  const form = dom.createElement('form')
  form.setAttribute('data-codingns-peer-host-edit', '')
  Object.assign(form.style, { display: 'flex', flexDirection: 'column', gap: '8px' })
  const name = input(dom, '名称', 'text', 'data-codingns-peer-host-name')
  name.input.value = record.displayName
  const url = input(dom, 'Host 地址（重新输入）', 'url', 'data-codingns-peer-host-url')
  const submit = actionButton(dom, '保存', () => undefined)
  submit.type = 'submit'
  const note = dom.createElement('small')
  note.textContent = record.route.kind === 'lan' ? '出于隐私保护，已保存地址不会回传到客户端，请重新输入。' : '中转路由由 Host 侧保存，当前不可在客户端修改。'
  form.append(name.wrapper, ...(record.route.kind === 'lan' ? [url.wrapper] : []), note, submit)
  modal.body.append(form)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!name.input.value.trim()) return
    const route = record.route.kind === 'lan'
      ? { kind: 'lan' as const, baseUrl: url.input.value.trim(), normalizedOrigin: '' }
      : undefined
    if (record.route.kind === 'lan' && !url.input.value.trim()) return
    submit.disabled = true
    void api.update({ peerHostId: record.id, displayName: name.input.value.trim(), ...(route === undefined ? {} : { route }) })
      .then(() => refreshList(panel, api))
      .then(() => modal.close())
      .catch((error) => { note.textContent = error instanceof Error ? error.message : String(error) })
      .finally(() => { submit.disabled = false })
  })
}

function actionButton(dom: Document, label: string, action: () => void): HTMLButtonElement {
  const button = dom.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', action)
  Object.assign(button.style, { minHeight: '30px', padding: '0 10px', border: `1px solid ${dshThemeColor.border}`, borderRadius: '6px', color: dshThemeColor.labelPrimary, background: dshThemeColor.buttonBackground, cursor: 'pointer', fontSize: '12px' })
  return button
}

function styleHeaderIconButton(button: HTMLButtonElement, kind: 'add' | 'close'): void {
  Object.assign(button.style, {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    minWidth: '34px',
    height: '34px',
    minHeight: '34px',
    padding: '0',
    border: `1px solid ${dshThemeColor.menuBorder}`,
    borderRadius: '8px',
    color: dshThemeColor.labelSecondary,
    background: dshThemeColor.buttonBackground,
    boxShadow: dshThemeColor.subtleShadow,
    fontSize: kind === 'add' ? '21px' : '22px',
    fontWeight: '500',
    lineHeight: '1',
    fontFamily: 'inherit',
    outline: 'none',
    cursor: 'pointer',
    transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
  })
  button.addEventListener('mouseenter', () => {
    button.style.background = dshThemeColor.hoverBackground
    button.style.color = dshThemeColor.labelPrimary
  })
  button.addEventListener('mouseleave', () => {
    button.style.background = dshThemeColor.buttonBackground
    button.style.color = dshThemeColor.labelSecondary
  })
}

function createHeaderIcon(dom: Document, kind: 'plus' | 'close'): Element {
  const createElementNS = dom.createElementNS
  if (typeof createElementNS !== 'function') {
    const fallback = dom.createElement('span')
    fallback.textContent = kind === 'plus' ? '+' : '×'
    fallback.setAttribute('aria-hidden', 'true')
    return fallback
  }
  const svg = createElementNS.call(dom, 'http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  svg.style.pointerEvents = 'none'
  const path = createElementNS.call(dom, 'http://www.w3.org/2000/svg', 'path') as SVGPathElement
  path.setAttribute('d', kind === 'plus' ? 'M12 5v14M5 12h14' : 'M6 6l12 12M18 6 6 18')
  svg.append(path)
  return svg
}

function input(dom: Document, label: string, type: string, attribute?: string): { wrapper: HTMLElement; input: HTMLInputElement } {
  const wrapper = dom.createElement('label')
  wrapper.textContent = label
  const control = dom.createElement('input')
  control.type = type
  control.required = true
  if (attribute !== undefined) control.setAttribute(attribute, '')
  Object.assign(wrapper.style, { display: 'flex', flexDirection: 'column', gap: '5px', margin: '5px 0', color: dshThemeColor.labelSecondary, fontSize: '12px', lineHeight: '1.4' })
  Object.assign(control.style, { minHeight: '36px', boxSizing: 'border-box', color: dshThemeColor.labelPrimary, background: dshThemeColor.inputBackground, border: `1px solid ${dshThemeColor.border}`, borderRadius: '6px', padding: '7px 9px', fontSize: '13px' })
  wrapper.append(control)
  return { wrapper, input: control }
}

function statusLabel(status: PeerHostClientRecord['status']): string {
  const labels: Partial<Record<PeerHostClientRecord['status'], string>> = {
    configured: '待测试', checking: '测试中', ready: '已连接', plugin_missing: '插件缺失',
    version_mismatch: '版本不匹配', identity_changed: '身份已变化', session_required: '需要登录',
    unreachable: '无法连接', reconnecting: '重连中', disabled: '已禁用',
  }
  return labels[status] ?? status
}

function formatBytes(value: number): string {
  if (value < 1024 ** 3) return `${Math.round(value / 1024 ** 2)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}
