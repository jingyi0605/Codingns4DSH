import type { PeerHostClientRecord } from '../shared/contracts/peer-host.js'
import type { PeerHostManagementApi, PeerHostRemoteWorkspaceCandidate } from './peer-host-management-api.js'
import { resolvePeerHostColor } from './peer-host-color.js'
import { resolveCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'

/**
 * 在 DSH 原生"添加工作区"对话框里追加一个"远程 HOST"标签页。
 *
 * 原生对话框由 `@deepseek-ai/dsh-client-ui-directory-picker-browse` 通过
 * `sidebar.workspaces.directoryFlow`（single 插槽）渲染。single 插槽只能有一个
 * 胜出者，抢占它等于整个替换原生组件——而用户要的是**原生主体保持不变**，只多
 * 一个入口。因此这里不碰插槽，改为在原生对话框的 DOM 上就地追加标签页：
 *
 * - "本机文件夹"标签：原生行为原样保留（面包屑、目录列、新建文件夹、打开）。
 * - "远程 HOST"标签：列出已连接的 PeerHost 与其已登记工作区，选中即登记可见性。
 *
 * 远端分支**绝不**触发原生 `onPicked`：那会在本机按远端路径创建一个不存在的工作区。
 */
export const PEER_HOST_WORKSPACE_TAB_ATTRIBUTE = 'data-codingns-peer-host-workspace-tab'
export const PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE = 'data-codingns-peer-host-workspace-panel'
/**
 * 记录当前标签页的状态属性。
 *
 * 必须与 `PEER_HOST_WORKSPACE_TAB_ATTRIBUTE` 分开：后者是"本插件注入的节点"标记，
 * dispose 会按它删除节点；若把它也写到原生对话框上，停用模块会把 DSH 自己的
 * 对话框从 DOM 里删掉。
 */
export const PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE = 'data-codingns-peer-host-workspace-tab-state'

/** 原生 browse 对话框的专有标记：`editorScope` 只出现在这个组件里。 */
const EDITOR_SCOPE_SELECTOR = '[class*="_editorScope"]'
const DIALOG_SELECTOR = '[role="dialog"]'
const HEADER_SELECTOR = '[class*="_header"]'
const TITLE_SELECTOR = '[class*="_title"]'
const CONTENT_SELECTOR = '[class*="_content"]'
const CRUMB_BAR_SELECTOR = '[class*="_crumbBar"]'
const FOOTER_BAR_SELECTOR = '[class*="_footerBar"]'

/**
 * 注入样式表。
 *
 * 交互态（`:hover`、`:active`、`:focus-visible`、`:disabled`）无法用内联样式表达，
 * 而它们正是"看起来像 DSH 原生控件"的关键；因此这里与 `git-panel-styles.ts`
 * 一致，用带前缀的类名 + 注入样式表，并全部走 DSH 主题令牌。
 *
 * 度量对齐原生 browse 对话框：13px/20px 正文、28px 行高、`.5px` 描边、
 * `--dsw-radius-sm|md`，滚动区 padding 与原生 `.content` 完全一致。
 */
const TAB_STYLE_ID = 'codingns4dsh-peer-host-workspace-tab-style'
const TAB_CLASS = 'codingns4dsh-peer-host'
const TAB_STYLE_TEXT = `
.${TAB_CLASS}-tabs{display:inline-flex;gap:2px;padding:3px;align-self:flex-start;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}
.${TAB_CLASS}-tab{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:26px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer}
.${TAB_CLASS}-tab:hover:not([aria-selected='true']){color:var(--dsw-alias-label-primary)}
.${TAB_CLASS}-tab[aria-selected='true']{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft)}
.${TAB_CLASS}-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.${TAB_CLASS}-panel{display:none;flex-direction:column;gap:12px;flex:1 1 0;min-height:0;box-sizing:border-box;padding:16px 16px 16px 24px;overflow-y:auto;color:var(--dsw-alias-label-primary)}
[${PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE}='remote'] .${TAB_CLASS}-panel{display:flex}
.${TAB_CLASS}-heading{margin:0;font-size:13px;font-weight:510;line-height:20px;color:var(--dsw-alias-label-primary)}
.${TAB_CLASS}-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${TAB_CLASS}-note{margin:0;padding:2px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.${TAB_CLASS}-note[data-kind='error']{color:var(--dsw-alias-state-error-primary)}
.${TAB_CLASS}-note[data-kind='success']{color:var(--dsw-alias-state-success-primary)}
.${TAB_CLASS}-chips{display:flex;flex-wrap:wrap;gap:6px}
.${TAB_CLASS}-chip{--codingns-host-color:var(--dsw-alias-label-secondary);box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;cursor:pointer}
.${TAB_CLASS}-chip:hover:not([aria-pressed='true']){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.${TAB_CLASS}-chip[aria-pressed='true']{border-color:var(--codingns-host-color);color:var(--codingns-host-color);background:color-mix(in srgb,var(--codingns-host-color) 12%,transparent)}
.${TAB_CLASS}-chip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.${TAB_CLASS}-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--codingns-host-color)}
.${TAB_CLASS}-list{display:flex;flex-direction:column;gap:0;margin:0 -8px;padding:0;list-style:none}
.${TAB_CLASS}-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;text-align:left;cursor:pointer}
.${TAB_CLASS}-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.${TAB_CLASS}-row:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.${TAB_CLASS}-row:disabled{opacity:.4;cursor:not-allowed}
.${TAB_CLASS}-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.${TAB_CLASS}-rowIcon{flex:none;color:var(--dsw-alias-label-tertiary)}
.${TAB_CLASS}-rowText{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 0}
.${TAB_CLASS}-rowName{overflow:hidden;font-size:13px;font-weight:500;line-height:20px;text-overflow:ellipsis;white-space:nowrap}
.${TAB_CLASS}-rowMeta{overflow:hidden;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap}
.${TAB_CLASS}-rowCount{flex:none;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.${TAB_CLASS}-sectionTitle{margin:4px 0 0;font-size:13px;font-weight:510;line-height:20px;color:var(--dsw-alias-label-primary)}
.${TAB_CLASS}-tableWrap{flex:none;overflow-x:auto;margin:0 -8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm)}
.${TAB_CLASS}-table{width:100%;min-width:520px;border-collapse:collapse;table-layout:fixed;font-size:12px;line-height:18px}
.${TAB_CLASS}-table th{padding:8px;text-align:left;font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}
.${TAB_CLASS}-table td{padding:9px 8px;border-top:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);vertical-align:top}
.${TAB_CLASS}-table th:nth-child(1),.${TAB_CLASS}-table td:nth-child(1){width:25%}
.${TAB_CLASS}-table th:nth-child(2),.${TAB_CLASS}-table td:nth-child(2){width:13%;white-space:nowrap}
.${TAB_CLASS}-table th:nth-child(3),.${TAB_CLASS}-table td:nth-child(3){width:20%;white-space:nowrap}
.${TAB_CLASS}-table th:nth-child(4),.${TAB_CLASS}-table td:nth-child(4){width:42%}
.${TAB_CLASS}-tableName{display:block;overflow:hidden;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.${TAB_CLASS}-tablePath{display:block;overflow:hidden;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap}
.${TAB_CLASS}-tableEmpty{padding:10px 0;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
[${PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE}='remote'] ${CRUMB_BAR_SELECTOR},
[${PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE}='remote'] ${CONTENT_SELECTOR},
[${PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE}='remote'] ${FOOTER_BAR_SELECTOR}{display:none !important}
[${PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE}='local'] [${PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE}]{display:none !important}
`

type TabKind = 'local' | 'remote'

export interface PeerHostWorkspaceTabController {
  /** 重新扫描并同步标签页；一般不需要手动调用。 */
  refresh(): void
  /** 断开观察器并移除所有注入节点。 */
  dispose(): void
}

export interface PeerHostWorkspaceTabOptions {
  readonly api: PeerHostManagementApi
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  /**
   * 浏览器 locale 服务。
   *
   * 命令式模块没有 React 上下文，只能由功能模块注入；缺省时退回内置中文词典，
   * 仅用于单测或非 Cordis 宿主。
   */
  readonly locale?: CodingNsLocale
  /** 远端工作区登记成功后触发聚合刷新；失败不影响标签页状态。 */
  readonly onWorkspaceAdded?: (peerHostId: string, workspaceId: string) => void | Promise<void>
}

/** 一个已打开对话框的注入状态；对话框关闭后随 DOM 一起丢弃。 */
interface Injection {
  readonly dialog: HTMLElement
  readonly editorScope: HTMLElement
  readonly tabBar: HTMLElement
  readonly panel: HTMLElement
  readonly localTab: HTMLButtonElement
  readonly remoteTab: HTMLButtonElement
  /** 该次注入使用的翻译函数；React 重渲染后仍沿用同一 locale。 */
  readonly t: CodingNsTranslator
  kind: TabKind
  records: readonly PeerHostClientRecord[] | null
  selectedHostId: string | null
  candidates: readonly PeerHostRemoteWorkspaceCandidate[] | null
  /** 当前 Host 聚合后实际进入侧栏的工作区；这是“已添加”表格的权威来源。 */
  addedWorkspaces: readonly WorkspaceTableRow[] | null
  loading: boolean
  message: string | null
  messageKind: 'error' | 'success' | 'info'
  generation: number
}

interface WorkspaceTableRow {
  readonly workspaceId: string
  readonly displayName: string
  readonly path: string
  readonly sessionCount: number
}

/**
 * 启动"远程 HOST"标签页注入。
 *
 * @returns 控制器；dispose 后原生对话框回到完全未改动的状态。
 */
export function startPeerHostWorkspaceTab(options: PeerHostWorkspaceTabOptions): PeerHostWorkspaceTabController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  if (dom === undefined) return { refresh() {}, dispose() {} }
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)

  let disposed = false
  let scanQueued = false
  /** 当前打开的对话框注入；同一时刻原生只会有一个 browse 对话框。 */
  let injection: Injection | null = null

  installStyle(dom)

  const scan = (): void => {
    if (disposed) return
    const scope = dom.querySelector<HTMLElement>(EDITOR_SCOPE_SELECTOR)
    const dialog = scope?.closest<HTMLElement>(DIALOG_SELECTOR) ?? null
    if (scope === null || dialog === null) {
      // 对话框已关闭：注入节点随 DOM 一起消失，这里只丢弃引用。
      injection = null
      return
    }
    // React 重渲染可能整体替换原生子树，此时注入节点会脱离文档；必须重新注入，
    // 只比较 dialog 引用会让标签页在首次导航后永久消失。重新注入时沿用用户已选的
    // Host 与标签，避免每敲一次路径就把标签页弹回"本机文件夹"。
    if (injection?.dialog === dialog
      && injection.tabBar.isConnected
      && injection.panel.isConnected) return
    const previous = injection
    previous?.tabBar.remove()
    previous?.panel.remove()
    injection = inject(dialog, scope, options, previous)
  }

  const scheduleScan = (): void => {
    if (disposed || scanQueued) return
    scanQueued = true
    queueMicrotask(() => {
      scanQueued = false
      scan()
    })
  }

  const observer = Observer === undefined ? undefined : new Observer(scheduleScan)
  if (observer !== undefined && dom.documentElement !== null) {
    observer.observe(dom.documentElement, { childList: true, subtree: true })
  }
  scan()

  return {
    refresh: scheduleScan,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      const dialog = injection?.dialog
      injection?.tabBar.remove()
      injection?.panel.remove()
      injection = null
      // 只清掉状态属性，绝不删除原生对话框本身。
      if (dialog !== undefined) dialog.removeAttribute(PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE)
      dom.querySelector<HTMLElement>(`style[data-plugin-css="${TAB_STYLE_ID}"]`)?.remove()
    },
  }
}

/** 注入样式表；用插件自有标记，停用时按标记精确移除。 */
function installStyle(dom: Document): void {
  const existing = dom.querySelector<HTMLStyleElement>(`style[data-plugin-css="${TAB_STYLE_ID}"]`)
  const style = existing ?? dom.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = TAB_STYLE_ID
  // 开发热更新或重新挂载可能保留旧 style 节点，不能仅凭相同标记跳过新 CSS。
  // 复用节点但替换文本，确保修复过的表格布局在已有页面中也能生效。
  style.textContent = TAB_STYLE_TEXT
  if (existing === null) dom.head?.appendChild(style)
}

/** 在原生对话框里建立标签栏与远端面板。 */
function inject(
  dialog: HTMLElement,
  editorScope: HTMLElement,
  options: PeerHostWorkspaceTabOptions,
  previous: Injection | null = null,
): Injection {
  const dom = dialog.ownerDocument
  const header = editorScope.querySelector<HTMLElement>(HEADER_SELECTOR)
  const title = header?.querySelector<HTMLElement>(TITLE_SELECTOR) ?? null
  const t = resolveCodingNsTranslator(options.locale)

  const localTab = tabButton(dom, t('peerHostWorkspace.tabLocal'))
  const remoteTab = tabButton(dom, t('peerHostWorkspace.tabRemote'))
  const tabBar = dom.createElement('div')
  tabBar.setAttribute(PEER_HOST_WORKSPACE_TAB_ATTRIBUTE, '')
  tabBar.setAttribute(PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE, previous?.kind ?? 'local')
  tabBar.setAttribute('role', 'tablist')
  tabBar.setAttribute('aria-label', t('peerHostWorkspace.sourceLabel'))
  tabBar.className = `${TAB_CLASS}-tabs`
  tabBar.append(localTab, remoteTab)

  const panel = dom.createElement('div')
  panel.setAttribute(PEER_HOST_WORKSPACE_PANEL_ATTRIBUTE, '')
  panel.className = `${TAB_CLASS}-panel`

  // 标签栏放在标题之后、面包屑之前，视觉上就是原生对话框的第二行。
  if (header !== null && title !== null) header.insertBefore(tabBar, title.nextSibling)
  else if (header !== null) header.append(tabBar)
  else dialog.append(tabBar)
  editorScope.append(panel)

  const state: Injection = {
    dialog,
    editorScope,
    tabBar,
    panel,
    localTab,
    remoteTab,
    t,
    kind: previous?.kind ?? 'local',
    records: previous?.records ?? null,
    selectedHostId: previous?.selectedHostId ?? null,
    candidates: previous?.candidates ?? null,
    addedWorkspaces: previous?.addedWorkspaces ?? null,
    loading: false,
    message: previous?.message ?? null,
    messageKind: previous?.messageKind ?? 'info',
    generation: 0,
  }

  localTab.addEventListener('click', () => { selectTab(state, 'local') })
  remoteTab.addEventListener('click', () => { selectTab(state, 'remote', options) })
  selectTab(state, state.kind, options)
  return state
}

/** 切换标签：本地标签完全交还原生渲染，远端标签隐藏原生区域并显示面板。 */
function selectTab(state: Injection, kind: TabKind, options?: PeerHostWorkspaceTabOptions): void {
  state.kind = kind
  state.tabBar.setAttribute(PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE, kind)
  state.dialog.setAttribute(PEER_HOST_WORKSPACE_TAB_STATE_ATTRIBUTE, kind)
  if (kind === 'remote' && state.records === null && options !== undefined) {
    void loadRecords(state, options)
  }
  render(state, options ?? null)
}

function render(state: Injection, options: PeerHostWorkspaceTabOptions | null): void {
  const active = state.kind === 'remote'
  // 选中态只由 aria-selected 表达，视觉全部交给注入样式表；内联样式无法写 :hover。
  state.localTab.setAttribute('aria-selected', String(!active))
  state.remoteTab.setAttribute('aria-selected', String(active))
  state.panel.style.display = active ? 'flex' : 'none'
  if (!active) return

  const dom = state.dialog.ownerDocument
  const t = state.t
  state.panel.textContent = ''

  const heading = dom.createElement('strong')
  heading.textContent = t('peerHostWorkspace.heading')
  heading.className = `${TAB_CLASS}-heading`
  const hint = dom.createElement('small')
  hint.textContent = t('peerHostWorkspace.hint')
  hint.className = `${TAB_CLASS}-hint`
  state.panel.append(heading, hint)

  if (state.records === null) {
    state.panel.append(note(dom, t('peerHostWorkspace.loadingHosts'), 'info'))
    return
  }
  if (state.records.length === 0) {
    // 读取失败时必须先给出真实错误；否则用户看到的是"没有 Host"，
    // 会把网络故障误判成配置为空。
    if (state.message !== null) state.panel.append(note(dom, state.message, state.messageKind))
    else state.panel.append(note(dom, t('peerHostWorkspace.noHosts'), 'info'))
    return
  }

  // 列出全部未禁用的 Host，**不过滤状态**：只显示 ready 会让"需要登录""无法连接"
  // 的 Host 凭空消失，用户会以为配置丢了。
  const hostRow = dom.createElement('div')
  hostRow.className = `${TAB_CLASS}-chips`
  for (const record of state.records) {
    const active = record.id === state.selectedHostId
    const button = dom.createElement('button')
    button.type = 'button'
    button.className = `${TAB_CLASS}-chip`
    button.setAttribute('data-codingns-peer-host-tab-host', record.id)
    button.setAttribute('data-codingns-peer-host-tab-status', record.status)
    button.setAttribute('aria-pressed', String(active))
    const color = resolvePeerHostColor(record.color, record.displayName)
    // 颜色通过自定义属性下传，由样式表消费；避免内联写死 border/background。
    button.style.setProperty('--codingns-host-color', color)

    const dot = dom.createElement('span')
    dot.className = `${TAB_CLASS}-dot`
    dot.setAttribute('aria-hidden', 'true')
    const label = dom.createElement('span')
    label.textContent = record.displayName
    button.append(dot, label)
    // 非就绪状态作为独立徽标追加，不把状态混进 Host 名称里。
    if (record.status !== 'ready') {
      const badge = dom.createElement('span')
      badge.className = `${TAB_CLASS}-rowMeta`
      badge.textContent = statusText(t, record.status)
      button.append(badge)
    }
    button.addEventListener('click', () => {
      if (options === null || state.selectedHostId === record.id) return
      state.selectedHostId = record.id
      state.candidates = null
      state.addedWorkspaces = null
      state.message = null
      render(state, options)
      // 未就绪的 Host 不发注定失败的代理请求，由面板给出可操作原因。
      if (record.status === 'ready') void loadCandidates(state, options)
    })
    hostRow.append(button)
  }
  state.panel.append(hostRow)

  if (state.selectedHostId === null) return

  const selected = state.records.find((record) => record.id === state.selectedHostId) ?? null
  // 未就绪的 Host 先给出可操作原因，不去发一个注定失败的代理请求。
  if (selected !== null && selected.status !== 'ready') {
    state.panel.append(note(dom, notReadyHint(t, selected), 'error'))
    return
  }
  if (state.candidates === null) {
    state.panel.append(note(dom, t('peerHostWorkspace.loadingWorkspaces'), 'info'))
    return
  }
  // 候选列表和已添加摘要是两条独立读取链路。候选暂时为空时，只要聚合已经拿到
  // 已添加工作区，仍然必须把表格渲染出来，不能用空候选列表遮掉真实侧栏数据。
  if (state.candidates.length === 0 && (state.addedWorkspaces === null || state.addedWorkspaces.length === 0)) {
    // 同上：候选读取失败不能伪装成"该 Host 没有工作区"。
    if (state.message !== null) state.panel.append(note(dom, state.message, state.messageKind))
    else state.panel.append(note(dom, t('peerHostWorkspace.noWorkspaces'), 'info'))
    return
  }

  // 聚合摘要是已添加工作区的权威来源；visibleWorkspaceIds 只作为旧数据或聚合暂时
  // 不可用时的兼容回退，避免仅凭 ID 字符串匹配导致表格空白。
  const addedIds = new Set(selected?.visibleWorkspaceIds ?? [])
  const addedCandidates: readonly WorkspaceTableRow[] = state.addedWorkspaces === null
    ? state.candidates.filter((candidate) => addedIds.has(candidate.workspaceId))
    : state.addedWorkspaces
  const addedWorkspaceIds = new Set(addedCandidates.map((candidate) => candidate.workspaceId))
  const availableCandidates = state.candidates.filter((candidate) => !addedWorkspaceIds.has(candidate.workspaceId) && !addedIds.has(candidate.workspaceId))

  const addedHeading = dom.createElement('strong')
  addedHeading.className = `${TAB_CLASS}-sectionTitle`
  addedHeading.textContent = t('peerHostWorkspace.addedHeading')
  state.panel.append(addedHeading)
  if (addedCandidates.length === 0) {
    const empty = dom.createElement('p')
    empty.className = `${TAB_CLASS}-tableEmpty`
    empty.textContent = t('peerHostWorkspace.noAddedWorkspaces')
    state.panel.append(empty)
  } else {
    state.panel.append(createWorkspaceTable(dom, t, selected?.displayName ?? '', addedCandidates))
  }

  if (availableCandidates.length > 0) {
    const availableHeading = dom.createElement('strong')
    availableHeading.className = `${TAB_CLASS}-sectionTitle`
    availableHeading.textContent = t('peerHostWorkspace.availableHeading')
    state.panel.append(availableHeading)
  }
  const list = dom.createElement('div')
  list.className = `${TAB_CLASS}-list`
  list.setAttribute('role', 'list')
  for (const candidate of availableCandidates) {
    const row = dom.createElement('button')
    row.type = 'button'
    row.className = `${TAB_CLASS}-row`
    row.setAttribute('role', 'listitem')
    row.setAttribute('data-codingns-peer-host-tab-candidate', candidate.workspaceId)
    row.disabled = state.loading
    row.title = candidate.path

    // 与原生目录行一致：前置文件夹图标 + 主标题 + 次级路径信息。
    row.append(createFolderIcon(dom))

    const text = dom.createElement('span')
    text.className = `${TAB_CLASS}-rowText`
    const name = dom.createElement('span')
    name.className = `${TAB_CLASS}-rowName`
    name.textContent = candidate.displayName
    const meta = dom.createElement('span')
    meta.className = `${TAB_CLASS}-rowMeta`
    meta.textContent = candidate.path
    text.append(name, meta)

    const count = dom.createElement('span')
    count.className = `${TAB_CLASS}-rowCount`
    count.textContent = candidate.sessionCount === 0
      ? t('peerHostWorkspace.noSessions')
      : t('peerHostWorkspace.sessionCount', { count: candidate.sessionCount })

    row.append(text, count)
    row.addEventListener('click', () => {
      if (options === null) return
      void addWorkspace(state, options, candidate.workspaceId)
    })
    list.append(row)
  }
  if (availableCandidates.length > 0) state.panel.append(list)

  if (state.message !== null) state.panel.append(note(dom, state.message, state.messageKind))
}

/** 渲染已添加工作区的只读信息表；添加动作仍由下方候选列表负责。 */
function createWorkspaceTable(
  dom: Document,
  t: CodingNsTranslator,
  hostName: string,
  candidates: readonly WorkspaceTableRow[],
): HTMLElement {
  const wrapper = dom.createElement('div')
  wrapper.className = `${TAB_CLASS}-tableWrap`
  const table = dom.createElement('table')
  table.className = `${TAB_CLASS}-table`
  table.setAttribute('aria-label', t('peerHostWorkspace.addedHeading'))
  const head = dom.createElement('thead')
  const headerRow = dom.createElement('tr')
  for (const label of [
    t('peerHostWorkspace.columnWorkspace'),
    t('peerHostWorkspace.columnSessions'),
    t('peerHostWorkspace.columnHost'),
    t('peerHostWorkspace.columnPath'),
  ]) {
    const cell = dom.createElement('th')
    cell.setAttribute('scope', 'col')
    cell.textContent = label
    headerRow.append(cell)
  }
  head.append(headerRow)
  const body = dom.createElement('tbody')
  for (const candidate of candidates) {
    const row = dom.createElement('tr')
    row.setAttribute('data-codingns-peer-host-tab-added-workspace', candidate.workspaceId)
    const name = dom.createElement('td')
    const nameText = dom.createElement('span')
    nameText.className = `${TAB_CLASS}-tableName`
    nameText.textContent = candidate.displayName
    name.append(nameText)
    const sessions = dom.createElement('td')
    sessions.textContent = candidate.sessionCount === 0
      ? t('peerHostWorkspace.noSessions')
      : t('peerHostWorkspace.sessionCount', { count: candidate.sessionCount })
    const host = dom.createElement('td')
    host.textContent = hostName
    const path = dom.createElement('td')
    path.title = candidate.path
    const pathText = dom.createElement('span')
    pathText.className = `${TAB_CLASS}-tablePath`
    pathText.textContent = candidate.path
    path.append(pathText)
    row.append(name, sessions, host, path)
    body.append(row)
  }
  table.append(head, body)
  wrapper.append(table)
  return wrapper
}

async function loadRecords(state: Injection, options: PeerHostWorkspaceTabOptions): Promise<void> {
  const generation = ++state.generation
  try {
    const records = await options.api.list()
    if (state.generation !== generation) return
    state.records = records.filter((record) => record.status !== 'disabled')
  } catch (error) {
    if (state.generation !== generation) return
    state.records = []
    state.message = message(error)
    state.messageKind = 'error'
  }
  render(state, options)
}

async function loadCandidates(state: Injection, options: PeerHostWorkspaceTabOptions): Promise<void> {
  const hostId = state.selectedHostId
  if (hostId === null) return
  const generation = ++state.generation
  try {
    const [candidateResult, aggregateResult] = await Promise.allSettled([
      options.api.workspaceCandidates(hostId),
      options.api.aggregate(),
    ])
    if (state.generation !== generation || state.selectedHostId !== hostId) return
    if (candidateResult.status === 'rejected') throw candidateResult.reason
    state.candidates = candidateResult.value
    const aggregateHost = aggregateResult.status === 'fulfilled'
      ? aggregateResult.value.find((result) => result.targetHostId === hostId)
      : undefined
    // 聚合请求可能因远端认证/网络抖动暂时没有该 Host，不能把“没有结果”写成
    // 权威空列表，否则 visibleWorkspaceIds 与候选工作区都在时仍会显示空表。
    // 只有明确 ready 的摘要才覆盖兼容回退；新添加的行随后由 addWorkspace 即时补入。
    state.addedWorkspaces = aggregateHost?.availability === 'ready'
      ? aggregateHost.workspaces.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        displayName: workspace.displayName,
        path: workspace.path,
        sessionCount: workspace.sessions.length + (workspace.archivedSessions?.length ?? 0),
      }))
      : null
  } catch (error) {
    if (state.generation !== generation || state.selectedHostId !== hostId) return
    state.candidates = []
    state.addedWorkspaces = []
    state.message = message(error)
    state.messageKind = 'error'
  }
  render(state, options)
}

async function addWorkspace(state: Injection, options: PeerHostWorkspaceTabOptions, workspaceId: string): Promise<void> {
  const hostId = state.selectedHostId
  if (hostId === null) return
  state.loading = true
  state.message = null
  render(state, options)
  try {
    const updated = await options.api.setWorkspaceVisibility(hostId, workspaceId, true)
    if (updated !== undefined) {
      state.records = state.records?.map((record) => record.id === hostId ? updated : record) ?? state.records
    }
    const added = state.candidates?.find((candidate) => candidate.workspaceId === workspaceId)
    if (added !== undefined) {
      // 聚合降级时表格由可见 ID 与候选列表构成；添加新行也必须保留这些已有行。
      const visibleIds = new Set(state.records?.find((record) => record.id === hostId)?.visibleWorkspaceIds ?? [])
      const current = state.addedWorkspaces
        ?? state.candidates?.filter((candidate) => visibleIds.has(candidate.workspaceId))
        ?? []
      if (!current.some((workspace) => workspace.workspaceId === added.workspaceId)) {
        state.addedWorkspaces = [...current, added]
      }
    }
    state.message = state.t('peerHostWorkspace.added')
    state.messageKind = 'success'
    await options.onWorkspaceAdded?.(hostId, workspaceId)
  } catch (error) {
    state.message = message(error)
    state.messageKind = 'error'
  } finally {
    state.loading = false
    render(state, options)
  }
}

function tabButton(dom: Document, label: string): HTMLButtonElement {
  const button = dom.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.className = `${TAB_CLASS}-tab`
  button.setAttribute('role', 'tab')
  return button
}

function note(dom: Document, text: string, kind: 'error' | 'success' | 'info'): HTMLElement {
  const element = dom.createElement('div')
  element.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  element.setAttribute('data-kind', kind)
  element.className = `${TAB_CLASS}-note`
  element.textContent = text
  return element
}

/** 与原生目录行同款的前置文件夹图标；无 SVG 能力时退化为空占位。 */
function createFolderIcon(dom: Document): Element {
  const createElementNS = dom.createElementNS
  if (typeof createElementNS !== 'function') {
    const fallback = dom.createElement('span')
    fallback.setAttribute('aria-hidden', 'true')
    return fallback
  }
  const svg = createElementNS.call(dom, 'http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `${TAB_CLASS}-rowIcon`)
  const path = createElementNS.call(dom, 'http://www.w3.org/2000/svg', 'path') as SVGPathElement
  path.setAttribute('d', 'M1.75 3.5c0-.69.56-1.25 1.25-1.25h3.1c.33 0 .65.13.88.37l.9.9h4.37c.69 0 1.25.56 1.25 1.25v7.5c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25v-8.77Z')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.2')
  svg.append(path)
  return svg
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Host 状态到词条的完整映射。
 *
 * 用 `Record<状态, 键>` 保证状态联合新增取值时编译器立刻报错，而不是静默回退成状态码；
 * 措辞与管理工作面板保持同一套。
 */
const STATUS_KEYS: Record<PeerHostClientRecord['status'], string> = {
  configured: 'peerHostWorkspace.statusConfigured',
  checking: 'peerHostWorkspace.statusChecking',
  ready: 'peerHostWorkspace.statusReady',
  plugin_missing: 'peerHostWorkspace.statusPluginMissing',
  version_mismatch: 'peerHostWorkspace.statusVersionMismatch',
  identity_changed: 'peerHostWorkspace.statusIdentityChanged',
  session_required: 'peerHostWorkspace.statusSessionRequired',
  unreachable: 'peerHostWorkspace.statusUnreachable',
  reconnecting: 'peerHostWorkspace.statusReconnecting',
  disabled: 'peerHostWorkspace.statusDisabled',
}

/** Host 状态标签。 */
function statusText(t: CodingNsTranslator, status: PeerHostClientRecord['status']): string {
  return t(STATUS_KEYS[status])
}

/** 未就绪 Host 的可操作提示：告诉用户该去做什么，而不是只说"不能用"。 */
function notReadyHint(t: CodingNsTranslator, record: PeerHostClientRecord): string {
  const host = record.displayName
  switch (record.status) {
    case 'session_required':
      return t('peerHostWorkspace.hintSessionRequired', { host })
    case 'unreachable':
    case 'reconnecting':
      return t('peerHostWorkspace.hintUnreachable', { host })
    case 'version_mismatch':
      return t('peerHostWorkspace.hintVersionMismatch', { host })
    case 'plugin_missing':
      return t('peerHostWorkspace.hintPluginMissing', { host })
    case 'identity_changed':
      return t('peerHostWorkspace.hintIdentityChanged', { host })
    default:
      return t('peerHostWorkspace.hintNotReady', { host, status: statusText(t, record.status) })
  }
}
