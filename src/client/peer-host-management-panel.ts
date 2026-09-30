import type { PeerHostClientRecord, PeerHostRoute } from '../shared/contracts/peer-host.js'
import { PEER_HOST_COLOR_PRESETS, normalizePeerHostColor } from '../shared/contracts/peer-host.js'
import type { DshHostStatus } from '../shared/contracts/host-status.js'
import { PEER_HOST_OPEN_EVENT } from './peer-host-connection-button.js'
import { fetchLocalIdentity, readRelayLoginIdentity, type LocalIdentity } from './account-bar.js'
import type { CodingNsRpcClient } from './features/types.js'
import { createPeerHostManagementApi, type PeerHostManagementApi } from './peer-host-management-api.js'
import { resolvePeerHostColor } from './peer-host-color.js'
import { resolveCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'
import { dshThemeColor } from './theme.js'

export interface PeerHostManagementPanelController { dispose(): void }

export interface PeerHostManagementPanelOptions {
  readonly document?: Document
  readonly rpc: CodingNsRpcClient
  readonly api?: PeerHostManagementApi
  /** DSH 语言运行时；缺省退回内置中文词典，仅供单测与非 Cordis 宿主使用。 */
  readonly locale?: CodingNsLocale
}

/** PeerHost 管理面板；入口来自统一账户菜单，面板只渲染脱敏记录。 */
export function startPeerHostManagementPanel(options: PeerHostManagementPanelOptions): PeerHostManagementPanelController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  if (dom === undefined) return { dispose() {} }
  const t = resolveCodingNsTranslator(options.locale)
  const api = options.api ?? createPeerHostManagementApi(options.rpc)
  let disposed = false
  let overlay: HTMLElement | null = null
  const open = (): void => {
    if (disposed) return
    if (overlay === null) overlay = createOverlay(dom, api, t, () => { overlay = null })
    void refreshList(overlay, api, t)
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

function createOverlay(dom: Document, api: PeerHostManagementApi, t: CodingNsTranslator, onClose: () => void): HTMLElement {
  const overlay = dom.createElement('div')
  overlay.setAttribute('data-codingns-peer-host-panel', '')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', t('peerHost.panelTitle'))
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
  title.textContent = t('peerHost.panelTitle')
  Object.assign(title.style, { fontSize: '18px', lineHeight: '1.35' })
  const subtitle = dom.createElement('span')
  subtitle.textContent = t('peerHost.panelSubtitle')
  Object.assign(subtitle.style, { color: dshThemeColor.labelSecondary, fontSize: '12px', lineHeight: '1.5' })
  heading.append(title, subtitle)
  const close = actionButton(dom, '', () => { overlay.remove(); onClose() })
  close.setAttribute('aria-label', t('peerHost.closePanel'))
  close.title = t('peerHost.close')
  close.append(createHeaderIcon(dom, 'close'))
  styleHeaderIconButton(close, 'close')
  const addToggle = actionButton(dom, '', () => {
    addToggle.setAttribute('aria-expanded', 'true')
    openAddDialog(dom, overlay, api, t, () => addToggle.setAttribute('aria-expanded', 'false'))
  })
  addToggle.setAttribute('aria-label', t('peerHost.addHost'))
  addToggle.title = t('peerHost.addHost')
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
  listTitle.textContent = t('peerHost.registeredHosts')
  const listHint = dom.createElement('span')
  listHint.textContent = t('peerHost.listHint')
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

function createFormDialog(dom: Document, parent: HTMLElement, titleText: string, t: CodingNsTranslator, onClose: () => void): FormDialogParts {
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
  closeButton.setAttribute('aria-label', t('peerHost.closeDialogTitle', { title: titleText }))
  closeButton.title = t('peerHost.close')
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

function openAddDialog(dom: Document, parent: HTMLElement, api: PeerHostManagementApi, t: CodingNsTranslator, onClose: () => void): void {
  const modal = createFormDialog(dom, parent, t('peerHost.addHost'), t, onClose)
  // 表单必须拿到 close：添加成功后要自动关闭对话框，否则用户会以为没生效而重复提交。
  modal.body.append(createAddForm(dom, api, parent, modal.message, modal.close, t))
}

function createAddForm(dom: Document, api: PeerHostManagementApi, panel: HTMLElement, message: HTMLElement, close: () => void, t: CodingNsTranslator): HTMLElement {
  const form = dom.createElement('form')
  form.setAttribute('data-codingns-peer-host-add-form', '')
  Object.assign(form.style, { display: 'flex', flexDirection: 'column', gap: '8px' })
  const name = input(dom, t('peerHost.nameOptional'), 'text', 'data-codingns-peer-host-name')
  name.input.required = false
  const url = input(dom, t('peerHost.hostUrl'), 'url', 'data-codingns-peer-host-url')
  const username = input(dom, t('peerHost.targetUsername'), 'text', 'data-codingns-peer-host-username')
  const password = input(dom, t('peerHost.targetPassword'), 'password', 'data-codingns-peer-host-password')
  password.input.autocomplete = 'current-password'
  const identity = dom.createElement('small')
  identity.setAttribute('data-codingns-peer-host-identity', '')
  identity.textContent = t('peerHost.identifyingAccount')
  const identityNote = dom.createElement('small')
  identityNote.textContent = t('peerHost.loginNote')
  Object.assign(identityNote.style, { color: dshThemeColor.labelSecondary, fontSize: '11px', lineHeight: '1.5' })
  const submit = actionButton(dom, t('peerHost.addAndLogin'), () => undefined)
  submit.type = 'submit'
  Object.assign(submit.style, { alignSelf: 'flex-start', marginTop: '4px', padding: '0 14px', background: dshThemeColor.accent, borderColor: dshThemeColor.accent, color: dshThemeColor.primaryForeground })
  form.append(name.wrapper, url.wrapper, identity, identityNote, username.wrapper, password.wrapper, submit)
  // 首次提交创建记录；若握手或登录失败后重试，必须走 update 而不是再次 create：
  // 重复 create 会撞 PEER_HOST_DUPLICATE，而重新 create 又会在用户改了地址时留下孤儿记录。
  let createdId: string | null = null
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const displayName = name.input.value.trim()
    const route: PeerHostRoute = { kind: 'lan', baseUrl: url.input.value.trim(), normalizedOrigin: '' }
    submit.disabled = true
    submit.textContent = createdId === null ? t('peerHost.adding') : t('peerHost.retrying')
    const ensureRecord = createdId === null
      ? api.create({ displayName, route }).then((record) => {
        createdId = record.id
        return record.id
      })
      // 重试时把用户可能修正过的名称与地址写回同一条记录。
      : api.update({
        peerHostId: createdId,
        ...(displayName === '' ? {} : { displayName }),
        route,
      }).then(() => createdId!)
    void ensureRecord
      .then(async (peerHostId) => {
        // 登录依赖握手状态 ready，顺序必须是创建/更新 -> 握手检查 -> 登录。
        const checked = await api.check(peerHostId)
        const account = { username: username.input.value.trim(), password: password.input.value }
        if (checked.status !== 'ready') return { record: checked, ready: false }
        if (account.username === '' || account.password === '') return { record: checked, ready: true }
        await api.login({ peerHostId, ...account })
        return { record: checked, ready: true }
      })
      .then(async ({ record, ready }) => {
        await refreshList(panel, api, t)
        if (ready) {
          // 添加并连接成功：自动关闭对话框，由外层列表展示新记录。
          close()
          return
        }
        // 握手未通过时保留对话框，让用户看到原因并就地修正后重试。
        setMessage(t('peerHost.handshakeFailed', { status: statusLabel(record.status, t) }))
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => { submit.disabled = false; submit.textContent = t('peerHost.addAndLogin') })
  })
  void hydrateIdentity(dom, username.input, identity, t)
  return form

  function setMessage(text: string): void {
    message.textContent = text
    message.hidden = text === ''
  }
}

async function hydrateIdentity(dom: Document, username: HTMLInputElement, identity: HTMLElement, t: CodingNsTranslator): Promise<void> {
  let local: LocalIdentity | null = null
  try { local = await fetchLocalIdentity(dom) } catch { local = null }
  const relay = readRelayLoginIdentity()
  if (local !== null) {
    username.value = local.username
    identity.textContent = t('peerHost.identityLocal', { username: local.username })
    return
  }
  if (relay !== null) {
    username.value = relay.username
    identity.textContent = t('peerHost.identityRelay', { username: relay.username })
    return
  }
  identity.textContent = t('peerHost.identityUnknown')
}

async function refreshList(overlay: HTMLElement, api: PeerHostManagementApi, t: CodingNsTranslator): Promise<void> {
  const list = overlay.querySelector<HTMLElement>('[data-codingns-peer-host-list]')
  if (list === null) return
  list.textContent = t('peerHost.readingList')
  try {
    const records = await api.list()
    list.textContent = ''
    if (records.length === 0) {
      const empty = list.ownerDocument.createElement('p')
      empty.textContent = t('peerHost.emptyList')
      Object.assign(empty.style, { margin: '6px 0 0', color: dshThemeColor.labelSecondary, fontSize: '12px' })
      list.append(empty)
      return
    }
    const cards = await Promise.all(records.map(async (record) => ({
      record,
      // 未握手或未登录的记录不能通过代理读取远端资源，避免把业务错误当成 RPC 格式错误。
      status: record.status === 'ready' ? await api.status(record.id).catch(() => null) : null,
    })))
    for (const card of cards) list.append(renderRecord(overlay.ownerDocument, api, card.record, list, card.status, overlay, t))
  } catch (error) {
    list.textContent = error instanceof Error ? error.message : String(error)
  }
}

function renderRecord(dom: Document, api: PeerHostManagementApi, record: PeerHostClientRecord, list: HTMLElement, hostStatus: DshHostStatus | null, panel: HTMLElement, t: CodingNsTranslator): HTMLElement {
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
  const swatch = dom.createElement('span')
  swatch.setAttribute('data-codingns-peer-host-swatch', '')
  swatch.title = record.color === null || record.color === undefined ? t('peerHost.colorDefaultHint') : t('peerHost.colorLabel', { color: record.color })
  Object.assign(swatch.style, {
    flex: '0 0 auto', width: '10px', height: '10px', borderRadius: '999px',
    background: peerHostColor(record), border: `1px solid ${dshThemeColor.border}`,
  })
  const title = dom.createElement('strong')
  title.textContent = record.displayName
  Object.assign(title.style, { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px', lineHeight: '1.3' })
  const status = dom.createElement('span')
  status.textContent = statusLabel(record.status, t)
  Object.assign(status.style, { flex: '0 0 auto', padding: '2px 6px', borderRadius: '999px', color: record.status === 'ready' ? dshThemeColor.success : dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle, fontSize: '10px', lineHeight: '1.2' })
  titleRow.append(swatch, title, status)
  const hostname = dom.createElement('div')
  hostname.textContent = t('peerHost.hostnameValue', { hostname: record.hostname ?? t('peerHost.notReported') })
  Object.assign(hostname.style, { color: dshThemeColor.labelSecondary, fontSize: '11px', lineHeight: '1.35', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  const metadata = dom.createElement('div')
  Object.assign(metadata.style, { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px', padding: '4px 0', borderTop: `1px solid ${dshThemeColor.border}`, borderBottom: `1px solid ${dshThemeColor.border}` })
  metadata.append(
    metaItem(dom, t('peerHost.dshVersion'), record.dshVersion ?? t('peerHost.unknown')),
    metaItem(dom, t('peerHost.visibleWorkspaces'), String((record.visibleWorkspaceIds ?? []).length)),
  )
  const resources = dom.createElement('div')
  Object.assign(resources.style, { display: 'flex', flexDirection: 'column', gap: '4px' })
  resources.append(resourceMeter(dom, 'CPU', hostStatus === null ? null : hostStatus.cpuPercent, hostStatus === null ? null : `${Math.round(hostStatus.cpuPercent)}%`, t('peerHost.noSample')))
  resources.append(resourceMeter(dom, t('peerHost.memory'), hostStatus === null ? null : hostStatus.memoryPercent, hostStatus === null ? null : `${formatBytes(hostStatus.memoryUsedBytes)} / ${formatBytes(hostStatus.memoryTotalBytes)}`, t('peerHost.noSample')))
  const actions = dom.createElement('div')
  // 只保留四个动作：登录/退出登录已并入"编辑"的一次性保存，不再是独立步骤。
  Object.assign(actions.style, { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '4px', marginTop: 'auto' })
  actions.append(
    actionButton(dom, t('peerHost.edit'), () => openEditForm(dom, api, record, panel, t)),
    actionButton(dom, t('peerHost.test'), () => run(() => api.check(record.id))),
    actionButton(dom, record.status === 'disabled' ? t('peerHost.enable') : t('peerHost.disable'), () => run(() => record.status === 'disabled' ? api.enable(record.id) : api.disable(record.id))),
    actionButton(dom, t('peerHost.delete'), () => {
      if (dom.defaultView?.confirm(t('peerHost.confirmDelete', { name: record.displayName })) !== true) return
      run(() => api.remove(record.id))
    }),
  )
  for (const button of actions.querySelectorAll('button')) {
    Object.assign(button.style, { width: '100%', minWidth: '0', minHeight: '26px', padding: '0 4px', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
  }
  row.append(titleRow, hostname, metadata, resources, actions)
  return row

  function run(operation: () => Promise<unknown>): void {
    void operation().then(() => refreshList(panel, api, t)).catch((error) => { hostname.textContent = error instanceof Error ? error.message : String(error) })
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

function resourceMeter(dom: Document, label: string, percent: number | null, value: string | null, emptyText: string): HTMLElement {
  const item = dom.createElement('div')
  const header = dom.createElement('div')
  Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', gap: '8px', color: dshThemeColor.labelSecondary, fontSize: '10px', lineHeight: '1.2' })
  const name = dom.createElement('span')
  name.textContent = label
  const amount = dom.createElement('span')
  amount.textContent = value ?? emptyText
  header.append(name, amount)
  const track = dom.createElement('div')
  Object.assign(track.style, { height: '4px', marginTop: '2px', overflow: 'hidden', borderRadius: '999px', background: dshThemeColor.surfaceSubtle })
  const fill = dom.createElement('div')
  Object.assign(fill.style, { width: `${Math.min(100, Math.max(0, percent ?? 0))}%`, height: '100%', borderRadius: 'inherit', background: percent === null ? dshThemeColor.labelTertiary : dshThemeColor.accent })
  track.append(fill)
  item.append(header, track)
  return item
}

function openEditForm(dom: Document, api: PeerHostManagementApi, record: PeerHostClientRecord, panel: HTMLElement, t: CodingNsTranslator): void {
  const modal = createFormDialog(dom, panel, t('peerHost.editHost'), t, () => undefined)
  const form = dom.createElement('form')
  form.setAttribute('data-codingns-peer-host-edit', '')
  Object.assign(form.style, { display: 'flex', flexDirection: 'column', gap: '8px' })
  const name = input(dom, t('peerHost.name'), 'text', 'data-codingns-peer-host-name')
  name.input.value = record.displayName
  const url = input(dom, t('peerHost.hostUrlOptional'), 'url', 'data-codingns-peer-host-url')
  url.input.required = false
  if (record.route.kind === 'lan' && record.route.baseUrl !== undefined) url.input.value = record.route.baseUrl
  const username = input(dom, t('peerHost.targetUsernameOptional'), 'text', 'data-codingns-peer-host-username')
  username.input.required = false
  username.input.autocomplete = 'username'
  const password = input(dom, t('peerHost.targetPasswordOptional'), 'password', 'data-codingns-peer-host-password')
  password.input.required = false
  password.input.autocomplete = 'current-password'
  const colorField = colorInput(dom, record.color ?? null, t)
  const credentialNote = dom.createElement('small')
  credentialNote.setAttribute('data-codingns-peer-host-credential-note', '')
  Object.assign(credentialNote.style, { color: dshThemeColor.labelSecondary, fontSize: '11px', lineHeight: '1.5' })
  credentialNote.textContent = t('peerHost.passwordKeepNote')
  const submit = actionButton(dom, t('peerHost.saveAndConnect'), () => undefined)
  submit.type = 'submit'
  const note = dom.createElement('small')
  note.textContent = record.route.kind === 'lan' ? t('peerHost.urlBackfilledNote') : t('peerHost.relayRouteNote')
  form.append(name.wrapper, ...(record.route.kind === 'lan' ? [url.wrapper] : []), colorField.wrapper, username.wrapper, password.wrapper, credentialNote, note, submit)
  modal.body.append(form)
  void hydrateCredentialState(dom, api, record.id, credentialNote, t)
  void hydrateEditUsername(dom, username.input)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!name.input.value.trim()) return
    const route = record.route.kind === 'lan'
      ? (url.input.value.trim() === '' ? undefined : { kind: 'lan' as const, baseUrl: url.input.value.trim(), normalizedOrigin: '' })
      : undefined
    // 密码是一次性更新凭据的开关：密码留空时忽略用户名建议并保留原登录态。
    const account = username.input.value.trim()
    const secret = password.input.value
    if (secret !== '' && account === '') {
      credentialNote.textContent = t('peerHost.passwordRequiresUsername')
      return
    }
    submit.disabled = true
    submit.textContent = t('peerHost.saving')
    void api.update({
      peerHostId: record.id,
      displayName: name.input.value.trim(),
      color: colorField.value(),
      ...(route === undefined ? {} : { route }),
      ...(secret === '' ? {} : { username: account, password: secret }),
    })
      .then(() => refreshList(panel, api, t))
      .then(() => modal.close())
      .catch((error) => { credentialNote.textContent = error instanceof Error ? error.message : String(error) })
      .finally(() => { submit.disabled = false; submit.textContent = t('peerHost.saveAndConnect') })
  })
}

/** 显示该 PeerHost 是否已保存凭据；已保存时用户名不再回填（Host 不回传）。 */
async function hydrateCredentialState(dom: Document, api: PeerHostManagementApi, peerHostId: string, note: HTMLElement, t: CodingNsTranslator): Promise<void> {
  try {
    const status = await api.credentialStatus(peerHostId)
    if (!status.hasSavedCredential) return
    note.textContent = t('peerHost.credentialSavedNote')
  } catch {
    // 凭据状态只是提示信息，读取失败不影响编辑与保存。
  }
}

/** 编辑表单里的用户名建议；只填用户名，密码必须由用户自己输入。 */
async function hydrateEditUsername(dom: Document, username: HTMLInputElement): Promise<void> {
  let local: LocalIdentity | null = null
  try { local = await fetchLocalIdentity(dom) } catch { local = null }
  const value = local ?? readRelayLoginIdentity()
  if (value === null || username.value !== '') return
  username.value = value.username
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

/**
 * 工作区标签配色选择器。
 *
 * 提供一组预设色加一个原生取色器，并允许"默认"（清除自定义色，回到按名称推导）。
 * 返回值始终是 `#rrggbb` 或 null，Host 侧还会再校验一次。
 */
function colorInput(dom: Document, initial: string | null, t: CodingNsTranslator): { wrapper: HTMLElement; value: () => string | null } {
  const wrapper = dom.createElement('div')
  Object.assign(wrapper.style, { display: 'flex', flexDirection: 'column', gap: '5px', margin: '5px 0', color: dshThemeColor.labelSecondary, fontSize: '12px', lineHeight: '1.4' })
  const label = dom.createElement('span')
  label.textContent = t('peerHost.colorSection')
  const row = dom.createElement('div')
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' })

  const picker = dom.createElement('input')
  picker.type = 'color'
  picker.setAttribute('data-codingns-peer-host-color', '')
  picker.value = resolvePeerHostColor(initial, '')
  Object.assign(picker.style, { width: '36px', height: '30px', padding: '0', border: `1px solid ${dshThemeColor.border}`, borderRadius: '6px', background: dshThemeColor.inputBackground, cursor: 'pointer' })

  const presetRow = dom.createElement('div')
  Object.assign(presetRow.style, { display: 'flex', alignItems: 'center', gap: '4px' })
  let selected: string | null = normalizePeerHostColor(initial)
  const presetButtons: HTMLButtonElement[] = []
  for (const preset of PEER_HOST_COLOR_PRESETS) {
    const button = actionButton(dom, '', () => {
      selected = preset
      picker.value = preset
      syncPresets()
    })
    button.setAttribute('data-codingns-peer-host-color-preset', preset)
    button.setAttribute('aria-label', t('peerHost.usePresetColor', { color: preset }))
    button.title = preset
    Object.assign(button.style, { width: '18px', minWidth: '18px', height: '18px', minHeight: '18px', padding: '0', borderRadius: '999px', background: preset, border: `1px solid ${dshThemeColor.border}` })
    presetButtons.push(button)
    presetRow.append(button)
  }
  const reset = actionButton(dom, t('peerHost.colorReset'), () => {
    selected = null
    syncPresets()
  })
  reset.setAttribute('data-codingns-peer-host-color-reset', '')
  Object.assign(reset.style, { minHeight: '24px', padding: '0 8px', fontSize: '11px' })

  picker.addEventListener('input', () => {
    selected = normalizePeerHostColor(picker.value)
    syncPresets()
  })
  row.append(picker, presetRow, reset)
  wrapper.append(label, row)
  syncPresets()
  return { wrapper, value: () => selected }

  function syncPresets(): void {
    for (const button of presetButtons) {
      const preset = button.getAttribute('data-codingns-peer-host-color-preset')
      const active = selected !== null && selected === preset
      button.style.outline = active ? `2px solid ${dshThemeColor.labelPrimary}` : 'none'
      button.style.outlineOffset = '1px'
    }
    reset.style.borderColor = selected === null ? dshThemeColor.accent : dshThemeColor.border
  }
}

function statusLabel(status: PeerHostClientRecord['status'], t: CodingNsTranslator): string {
  const keys: Partial<Record<PeerHostClientRecord['status'], string>> = {
    configured: 'peerHost.statusConfigured', checking: 'peerHost.statusChecking', ready: 'peerHost.statusReady',
    plugin_missing: 'peerHost.statusPluginMissing', version_mismatch: 'peerHost.statusVersionMismatch',
    identity_changed: 'peerHost.statusIdentityChanged', session_required: 'peerHost.statusSessionRequired',
    unreachable: 'peerHost.statusUnreachable', reconnecting: 'peerHost.statusReconnecting', disabled: 'peerHost.statusDisabled',
  }
  const key = keys[status]
  return key === undefined ? status : t(key)
}

/** 卡片色点用的最终颜色：显式配置优先，否则按名称推导。 */
function peerHostColor(record: PeerHostClientRecord): string {
  return resolvePeerHostColor(record.color, record.displayName)
}

function formatBytes(value: number): string {
  if (value < 1024 ** 3) return `${Math.round(value / 1024 ** 2)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}
