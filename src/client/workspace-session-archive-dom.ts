import { dshThemeColor } from './theme.js'
import { providerVisual } from './provider-icons.js'
import { sessionAdapterId } from './session-adapter-cache.js'
import type { NativeWorkspaceSnapshot } from './native-workspace-store.js'
import { resolveCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'

/** 归档入口和模态框节点使用的标记，便于重复扫描与停用时完整清理。 */
export const WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE = 'data-codingns-session-archive'
export const WORKSPACE_SESSION_ARCHIVE_MODAL_ATTRIBUTE = 'data-codingns-session-archive-modal'
/** 模态框内每个会话行上的 Agent 彩色标签标记。 */
export const WORKSPACE_SESSION_ARCHIVE_AGENT_ATTRIBUTE = 'data-codingns-session-archive-agent'

const MORE_SESSION_PATTERN = /(?:展开|显示|expand|show).*(?:其余|更多|remaining|more).*(?:会话|sessions?)/iu

interface RemoteWorkspaceApi {
  readonly follow?: () => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
  readonly unarchiveSession?: (request: { readonly sessionId: string }) => Promise<unknown> | unknown
}

interface RemoteSessionApi {
  readonly list?: (request: { readonly cursor?: string }) => Promise<unknown>
}

interface CodingNsRemote {
  readonly workspace?: RemoteWorkspaceApi
  readonly session?: RemoteSessionApi
}

export interface ArchivedSessionItem {
  readonly sessionId: string
  readonly title: string
  readonly archivedAt: number
  readonly workspaceId?: string
}

export interface WorkspaceSessionArchiveDomController {
  refresh(): void
  dispose(): void
}

export interface WorkspaceSessionArchiveDomOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  readonly remote?: unknown
  readonly now?: () => number
  /** 会话到 Agent 的映射；默认读取与侧栏 Logo 同源的会话绑定缓存。 */
  readonly adapterIdForSession?: (sessionId: string) => string | undefined
  /**
   * 原生 Workspace 列表快照。
   *
   * 远端虚拟工作区只存在于原生 Store 投影里，`workspace/follow` 首帧只覆盖本机，
   * 因此有原生快照时以它为准。
   */
  readonly readNativeWorkspaceSnapshot?: () => NativeWorkspaceSnapshot | undefined
  /** 会话取消归档成功后的通知；返回的 Promise 会在远端聚合同步完成后兑现。 */
  readonly onSessionUnarchived?: (sessionId: string) => void | Promise<void>
  /** DSH 语言运行时；归档入口、模态框和 Agent 兜底展示名都从它取词。 */
  readonly locale?: CodingNsLocale
}

/** 读取当前 DSH Workspace 的归档会话摘要，独立导出供契约测试和宿主探测使用。 */
export async function loadWorkspaceArchivedSessions(
  remote: unknown,
  now: () => number = Date.now,
): Promise<ReadonlyMap<string, readonly ArchivedSessionItem[]>> {
  return (await loadArchiveSnapshot(normalizeRemote(remote), now)).byWorkspace
}

/**
 * 在原生工作区会话列表的“展开更多会话”按钮前插入归档入口。
 *
 * DSH 0.1.6 的侧栏没有可供插件追加内容的 Slot，因此这里只读 DOM 和 Fiber
 * 身份；真正的归档和取消归档仍交给 DSH Workspace Controller，避免旁路修改存储。
 */
export function startWorkspaceSessionArchiveDom(
  options: WorkspaceSessionArchiveDomOptions = {},
): WorkspaceSessionArchiveDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const remote = normalizeRemote(options.remote)
  const now = options.now ?? Date.now
  const t = resolveCodingNsTranslator(options.locale)
  // SessionStore 只记录显式选择；没有外部绑定时，DSH Registry 的权威默认值就是 dsh。
  const adapterIdForSession = options.adapterIdForSession
    ?? ((sessionId: string): string => sessionAdapterId(sessionId) ?? 'dsh')
  const readNativeWorkspaceSnapshot = options.readNativeWorkspaceSnapshot
  const onSessionUnarchived = options.onSessionUnarchived
  let disposed = false
  let scanQueued = false
  let loading: Promise<void> | undefined
  let snapshot: ArchiveSnapshot = emptyArchiveSnapshot()

  const refreshData = async (): Promise<void> => {
    if (disposed || remote.workspace?.follow === undefined || remote.session?.list === undefined) return
    if (loading !== undefined) {
      await loading
      return
    }
    loading = loadArchiveSnapshot(remote, now, readNativeWorkspaceSnapshot).then((next) => {
      if (disposed) return
      snapshot = next
      scan()
    }).catch(() => undefined).finally(() => {
      loading = undefined
    })
    await loading
  }

  const scan = (): void => {
    if (disposed || dom === undefined) return
    // 扫描会移除并重建入口；暂时断开观察器，避免自身 DOM 变更触发无限重扫。
    observer?.disconnect()
    try {
      removeArchiveEntries(dom)
      const onlyWorkspaceId = snapshot.workspaceIds.length === 1
        ? snapshot.workspaceIds[0]
        : undefined
      const buttons = findMoreSessionButtons(dom)
      const useWorkspaceOrder = buttons.length === snapshot.workspaceIds.length
      const insertedWorkspaceIds = new Set<string>()
      const expandedByWorkspace = new Map(
        findWorkspaceHeaders(dom).flatMap((header) => {
          const workspaceId = resolveWorkspaceId(header)
          return workspaceId === undefined ? [] : [[workspaceId, header.getAttribute('aria-expanded') !== 'false'] as const]
        }),
      )
      const openModalFor = (workspaceId: string): (() => void) => () => {
        void refreshData().then(() => openArchiveModal(snapshot.byWorkspace.get(workspaceId) ?? [], {
          dom,
          remote,
          adapterIdForSession,
          t,
          onChanged: () => { void refreshData() },
          onSessionUnarchived,
        }))
      }
      for (const [index, button] of buttons.entries()) {
        const workspaceId = resolveWorkspaceId(button)
          ?? onlyWorkspaceId
          ?? (useWorkspaceOrder ? snapshot.workspaceIds[index] : undefined)
        if (workspaceId === undefined) continue
        const items = snapshot.byWorkspace.get(workspaceId) ?? []
        if (insertArchiveEntry(
          button,
          items,
          dom,
          remote,
          workspaceId,
          expandedByWorkspace.get(workspaceId) ?? true,
          openModalFor(workspaceId),
          t,
        )) insertedWorkspaceIds.add(workspaceId)
      }

      // 某些窗口高度下 DSH 不渲染“展开其余会话”按钮。归档入口仍必须
      // 按工作区显示，此时放到该工作区会话列表的最底部。
      for (const header of findWorkspaceHeaders(dom)) {
        const workspaceId = resolveWorkspaceId(header)
        if (workspaceId === undefined || insertedWorkspaceIds.has(workspaceId)) continue
        const items = snapshot.byWorkspace.get(workspaceId) ?? []
        if (insertArchiveEntryAfterHeader(
          header,
          items,
          dom,
          remote,
          workspaceId,
          header.getAttribute('aria-expanded') !== 'false',
          openModalFor(workspaceId),
          t,
        )) insertedWorkspaceIds.add(workspaceId)
      }
    } finally {
      if (!disposed && observer !== undefined && dom.documentElement !== null) {
        observer.observe(dom.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-expanded'],
        })
      }
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
    observer.observe(dom.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded'],
    })
  }

  scan()
  void refreshData()

  return {
    refresh() {
      scheduleScan()
      void refreshData()
    },
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      if (dom !== undefined) {
        removeArchiveEntries(dom)
        closeArchiveModal(dom)
      }
    },
  }
}

interface ArchiveSnapshot {
  readonly byWorkspace: ReadonlyMap<string, readonly ArchivedSessionItem[]>
  readonly workspaceIds: readonly string[]
}

function emptyArchiveSnapshot(): ArchiveSnapshot {
  return { byWorkspace: new Map(), workspaceIds: [] }
}

async function loadArchiveSnapshot(
  remote: CodingNsRemote,
  now: () => number,
  readNativeSnapshot?: () => NativeWorkspaceSnapshot | undefined,
): Promise<ArchiveSnapshot> {
  const [workspaces, sessions] = await Promise.all([
    readWorkspaceRecords(remote.workspace, readNativeSnapshot),
    readSessionList(remote.session),
  ])
  const byId = new Map(sessions.map((item) => [item.sessionId, item]))
  const result = new Map<string, ArchivedSessionItem[]>()
  for (const workspace of workspaces) {
    const items: ArchivedSessionItem[] = []
    for (const sessionId of workspace.archivedSessionIds) {
      const session = byId.get(sessionId)
      if (session === undefined || !belongsToWorkspace(session, workspace, workspaces)) continue
      items.push({
        sessionId,
        title: session.title,
        archivedAt: session.archivedAt > 0 ? session.archivedAt : session.updatedAt > 0 ? session.updatedAt : now(),
        ...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
      })
    }
    items.sort((left, right) => right.archivedAt - left.archivedAt)
    if (items.length > 0) result.set(workspace.workspaceId, items)
  }
  return { byWorkspace: result, workspaceIds: workspaces.map((workspace) => workspace.workspaceId) }
}

export interface WorkspaceRecord {
  readonly workspaceId: string
  readonly path?: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
}

interface SessionRecord {
  readonly sessionId: string
  readonly updatedAt: number
  readonly archivedAt: number
  readonly title: string
  readonly cwd?: string
  readonly workspaceId?: string
}

/** 读取 DSH 当前工作区基线；隐藏工作区控制器与归档控制器共用这份解析。 */
export async function loadWorkspaceRecords(remote: unknown): Promise<readonly WorkspaceRecord[]> {
  return readWorkspaceBaseline(normalizeRemote(remote).workspace)
}

/**
 * 读取工作区基线。
 *
 * 有原生 Store 快照时以它为准：远端虚拟工作区与虚拟归档集合只存在于这层投影里，
 * `workspace/follow` 首帧只覆盖本机工作区。两者都不可用时保持空表。
 */
async function readWorkspaceRecords(
  api: RemoteWorkspaceApi | undefined,
  readNativeSnapshot?: () => NativeWorkspaceSnapshot | undefined,
): Promise<WorkspaceRecord[]> {
  const native = readNativeSnapshot?.()
  if (native !== undefined && native.items.length > 0) {
    // 原生归档集合是 Registry 级的一份列表，按工作区分发后由 workspaces 归属过滤。
    return native.items.map((item) => ({ ...item, archivedSessionIds: native.archivedSessionIds }))
  }
  return readWorkspaceBaseline(api)
}

async function readWorkspaceBaseline(api: RemoteWorkspaceApi | undefined): Promise<WorkspaceRecord[]> {
  if (api?.follow === undefined) return []
  const source = await api.follow()
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()
  await iterator.return?.()
  const frame = asRecord(first.value)
  const value = asRecord(frame?.value)
  const records = Array.isArray(value?.items) ? value.items : []
  const globalArchived = readStringArray(value?.archivedSessionIds)
  return records.flatMap((item) => {
    const record = asRecord(item)
    const workspaceId = readString(record?.workspaceId)
    if (workspaceId === undefined) return []
    const path = readString(record?.path)
    const title = readString(record?.title) ?? path ?? workspaceId
    return [{
      workspaceId,
      ...(path === undefined ? {} : { path }),
      title,
      sessionIds: readStringArray(record?.sessionIds),
      archivedSessionIds: globalArchived,
    }]
  })
}

async function readSessionList(api: RemoteSessionApi | undefined): Promise<SessionRecord[]> {
  if (api?.list === undefined) return []
  const result = asRecord(unwrapRemoteValue(await api.list({})))
  const items = Array.isArray(result?.items) ? result.items : []
  return items.flatMap((item) => {
    const record = asRecord(item)
    const sessionId = readString(record?.sessionId)
    if (sessionId === undefined) return []
    const projections = asRecord(record?.projections)
    const values = asRecord(projections?.values)
    const titleValue = values?.title
    const cwd = readString(record?.cwd)
    const workspaceIdValue = readString(record?.workspaceId)
    const archivedAt = typeof record?.archivedAt === 'number' && Number.isFinite(record.archivedAt) ? record.archivedAt : 0
    return [{
      sessionId,
      updatedAt: typeof record?.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
      archivedAt,
      title: typeof titleValue === 'string' && titleValue.trim() ? titleValue.trim() : sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(workspaceIdValue === undefined ? {} : { workspaceId: workspaceIdValue }),
    }]
  })
}

function belongsToWorkspace(session: SessionRecord, workspace: WorkspaceRecord, workspaces: readonly WorkspaceRecord[]): boolean {
  if (workspace.sessionIds.includes(session.sessionId)) return true
  if (session.workspaceId !== undefined) return session.workspaceId === workspace.workspaceId
  if (session.cwd !== undefined && workspace.path !== undefined) return isPathWithin(session.cwd, workspace.path)
  return workspaces.length === 1
}

function isPathWithin(candidate: string, parent: string): boolean {
  const normalizedCandidate = candidate.replaceAll('\\', '/').replace(/\/+$/u, '')
  const normalizedParent = parent.replaceAll('\\', '/').replace(/\/+$/u, '')
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`)
}

function findMoreSessionButtons(dom: Pick<Document, 'querySelectorAll'>): HTMLElement[] {
  return [...dom.querySelectorAll<HTMLElement>('button')].filter(isMoreSessionButton)
}

export function findWorkspaceHeaders(dom: Pick<Document, 'querySelectorAll'>): HTMLElement[] {
  return [...dom.querySelectorAll<HTMLElement>('[role="treeitem"][aria-expanded]')]
}

export function resolveWorkspaceId(element: Element): string | undefined {
  let current: Element | null = element
  for (let depth = 0; depth < 8 && current !== null; depth += 1) {
    for (const key of ['data-workspace-id', 'data-workspaceid', 'data-workspace']) {
      const value = current.getAttribute(key)
      if (value?.trim()) return value.trim()
    }
    const fiberKey = Object.getOwnPropertyNames(current).find((key) => key.startsWith('__reactFiber$'))
    const fiber = fiberKey === undefined ? undefined : (current as unknown as Record<string, unknown>)[fiberKey]
    const id = findWorkspaceIdInFiber(fiber)
    if (id !== undefined) return id
    current = current.parentElement
  }
  return undefined
}

function findWorkspaceIdInFiber(value: unknown): string | undefined {
  let current = value
  for (let depth = 0; depth < 24 && isRecord(current); depth += 1) {
    for (const props of [current.memoizedProps, current.pendingProps]) {
      const id = findWorkspaceIdInProps(props)
      if (id !== undefined) return id
    }
    current = current.return
  }
  return undefined
}

function findWorkspaceIdInProps(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of ['workspaceId', 'workspaceID']) {
    const id = readString(value[key])
    if (id !== undefined) return id
  }
  for (const key of ['workspace', 'group', 'row', 'item', 'value', 'data'] as const) {
    const workspace = asRecord(value[key])
    const id = readString(workspace?.workspaceId) ?? readString(workspace?.workspaceID) ?? readString(workspace?.id)
    if (id !== undefined) return id
  }
  return undefined
}

function insertArchiveEntry(
  moreButton: HTMLElement,
  items: readonly ArchivedSessionItem[],
  dom: Pick<Document, 'body' | 'createElement' | 'querySelector'>,
  remote: CodingNsRemote,
  workspaceId: string,
  expanded: boolean,
  onOpen: () => void,
  t: CodingNsTranslator,
): boolean {
  if (items.length === 0) return false
  const container = findWorkspaceContainer(moreButton, workspaceId)
  if (container === null) return false
  const entry = createArchiveEntry(items, dom, expanded, onOpen, t)
  const anchor = directChildFor(container, moreButton)
  if (anchor === null) return false
  container.insertBefore(entry, anchor)
  return true
}

function insertArchiveEntryAfterHeader(
  header: HTMLElement,
  items: readonly ArchivedSessionItem[],
  dom: Pick<Document, 'body' | 'createElement' | 'querySelector'>,
  remote: CodingNsRemote,
  workspaceId: string,
  expanded: boolean,
  onOpen: () => void,
  t: CodingNsTranslator,
): boolean {
  if (items.length === 0) return false
  const container = findWorkspaceContainer(header, workspaceId)
  if (container === null) return false
  const entry = createArchiveEntry(items, dom, expanded, onOpen, t)
  const moreButton = [...container.querySelectorAll<HTMLElement>('button')].find(isMoreSessionButton)
  if (moreButton !== undefined) {
    const anchor = directChildFor(container, moreButton)
    if (anchor !== null) container.insertBefore(entry, anchor)
    else return false
  } else container.appendChild(entry)
  return true
}

export function findWorkspaceContainer(anchor: HTMLElement, workspaceId: string): HTMLElement | null {
  let current = anchor.parentElement
  let fallback: HTMLElement | null = null
  for (let depth = 0; depth < 8 && current !== null; depth += 1) {
    // 找不到明确的工作区边界时不能继续向上回退到整个侧栏；否则归档入口
    // 会被追加到所有工作区之后，变成截图中的独立底部条目。
    if (containsForeignWorkspaceHeader(current, anchor, workspaceId)) {
      current = current.parentElement
      continue
    }
    fallback = current
    const hasMoreButton = [...current.querySelectorAll<HTMLElement>('button')].some((button) => {
      return isMoreSessionButton(button) && (resolveWorkspaceId(button) === workspaceId || button === anchor)
    })
    const hasSessionRow = [...current.querySelectorAll<HTMLElement>('[role="treeitem"]')].some((row) => {
      return row !== anchor && row.getAttribute('aria-expanded') === null
    })
    if (hasMoreButton || hasSessionRow) return current
    current = current.parentElement
  }
  return fallback
}

function containsForeignWorkspaceHeader(container: HTMLElement, anchor: HTMLElement, workspaceId: string): boolean {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].some((row) => {
    if (row === anchor || row.getAttribute('aria-expanded') === null) return false
    const rowWorkspaceId = resolveWorkspaceId(row)
    // 未能解析的另一个工作区也不能被当成当前工作区的容器处理。
    return rowWorkspaceId === undefined || rowWorkspaceId !== workspaceId
  })
}

function directChildFor(container: HTMLElement, descendant: HTMLElement): HTMLElement | null {
  let current: HTMLElement = descendant
  while (current.parentElement !== null && current.parentElement !== container) {
    current = current.parentElement
  }
  return current.parentElement === container ? current : null
}

function createArchiveEntry(
  items: readonly ArchivedSessionItem[],
  dom: Pick<Document, 'body' | 'createElement' | 'querySelector'>,
  expanded: boolean,
  onOpen: () => void,
  t: CodingNsTranslator,
): HTMLElement {
  const entry = dom.createElement('button')
  entry.type = 'button'
  entry.setAttribute(WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE, '')
  entry.setAttribute('aria-label', t('archive.title'))
  entry.hidden = !expanded
  entry.setAttribute('aria-hidden', expanded ? 'false' : 'true')
  entry.textContent = t('archive.entryCount', { count: items.length })
  Object.assign(entry.style, {
    display: expanded ? 'block' : 'none',
    width: '100%',
    margin: '2px 0',
    padding: '7px 12px 7px 42px',
    border: '0',
    color: 'var(--dsw-alias-label-secondary, GrayText)',
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '12px',
  })
  entry.addEventListener('click', onOpen)
  return entry
}

function isMoreSessionButton(button: Element): boolean {
  const label = `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`.replace(/\s+/gu, ' ')
  if (MORE_SESSION_PATTERN.test(label)) return true
  // React 文本节点可能被拆分或带换行，按三个稳定语义片段兜底识别。
  return /(?:展开|显示|expand|show)/iu.test(label)
    && /(?:其余|更多|remaining|more)/iu.test(label)
    && /(?:会话|sessions?)/iu.test(label)
}

function removeArchiveEntries(dom: Pick<Document, 'querySelectorAll'>): void {
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE}]`)) node.remove()
}

/**
 * 模态框渲染所需的最小 DOM 面：真实 Document 与测试假实现都满足。
 *
 * `createElementNS` 在部分测试假实现里缺失，取消归档图标据此退回字符占位。
 */
type ArchiveModalDom = Pick<Document, 'body' | 'createElement' | 'querySelector'>
  & Partial<Pick<Document, 'createElementNS'>>

/** 归档模态框的渲染上下文；工作区入口与行创建共用同一份依赖。 */
interface ArchiveModalContext {
  readonly dom: ArchiveModalDom
  readonly remote: CodingNsRemote
  readonly adapterIdForSession: (sessionId: string) => string | undefined
  readonly t: CodingNsTranslator
  readonly onChanged: () => void
  readonly onSessionUnarchived: ((sessionId: string) => void | Promise<void>) | undefined
}

function openArchiveModal(
  items: readonly ArchivedSessionItem[],
  context: ArchiveModalContext,
): void {
  const { dom } = context
  closeArchiveModal(dom)
  if (dom.body === null || dom.body === undefined) return
  const t = context.t
  const overlay = dom.createElement('div')
  overlay.setAttribute(WORKSPACE_SESSION_ARCHIVE_MODAL_ATTRIBUTE, '')
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '9999', display: 'flex', alignItems: 'center', justifyContent: 'center',
    // 窄屏用视口比例收紧留白，给会话行留出「标签 + 归档时间」同排所需的宽度。
    padding: 'min(24px, 4vw)', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45))',
  })
  const surface = dom.createElement('section')
  surface.setAttribute('role', 'dialog')
  surface.setAttribute('aria-modal', 'true')
  surface.setAttribute('aria-label', t('archive.title'))
  Object.assign(surface.style, {
    width: 'min(860px, 100%)', maxHeight: 'min(720px, 90vh)', overflow: 'auto', boxSizing: 'border-box',
    padding: 'min(28px, 5vw) min(32px, 4vw)', borderRadius: '16px', color: dshThemeColor.labelPrimary,
    background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.prominentShadow,
  })
  const header = dom.createElement('div')
  Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginBottom: '18px' })
  const title = dom.createElement('h2')
  title.textContent = t('archive.title')
  Object.assign(title.style, { margin: '0', fontSize: '22px', fontWeight: '600' })
  const close = dom.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', t('archive.close'))
  close.textContent = '×'
  Object.assign(close.style, { border: '0', background: 'transparent', color: 'inherit', fontSize: '30px', lineHeight: '1', cursor: 'pointer' })
  header.append(title, close)
  const search = dom.createElement('input')
  search.type = 'search'
  search.placeholder = t('archive.searchPlaceholder')
  search.setAttribute('aria-label', t('archive.searchPlaceholder'))
  Object.assign(search.style, { width: '100%', boxSizing: 'border-box', padding: '11px 14px', marginBottom: '16px', border: '1px solid var(--dsw-alias-border-l2, #d9d9d9)', borderRadius: '8px', color: 'inherit', background: 'var(--dsw-specific-input-major, Canvas)', font: 'inherit' })
  const list = dom.createElement('div')
  Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '4px' })
  const render = (): void => {
    list.replaceChildren()
    const keyword = search.value.trim().toLocaleLowerCase()
    const filtered = items.filter((item) => item.title.toLocaleLowerCase().includes(keyword))
    for (const item of filtered) list.appendChild(createArchiveRow(item, context))
    if (filtered.length === 0) {
      const empty = dom.createElement('p')
      empty.textContent = t('archive.empty')
      Object.assign(empty.style, { margin: '20px 0', color: 'var(--dsw-alias-label-secondary, GrayText)', textAlign: 'center' })
      list.appendChild(empty)
    }
  }
  close.addEventListener('click', () => closeArchiveModal(dom))
  // 与插件其它弹层一致：按下遮罩即关闭，点在面板内部不关闭。
  overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) closeArchiveModal(dom) })
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeArchiveModal(dom)
  })
  search.addEventListener('input', render)
  surface.append(header, search, list)
  overlay.appendChild(surface)
  dom.body.appendChild(overlay)
  render()
  search.focus()
}

function createArchiveRow(
  item: ArchivedSessionItem,
  context: ArchiveModalContext,
): HTMLElement {
  const { dom, adapterIdForSession, t } = context
  const row = dom.createElement('div')
  Object.assign(row.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 0', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))' })
  const content = dom.createElement('div')
  Object.assign(content.style, { minWidth: '0', flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '4px' })
  // 移动端窄屏下第一行只保留标题，独占整行以避免被标签与时间挤压截断。
  const name = dom.createElement('strong')
  name.textContent = item.title
  name.title = item.title
  Object.assign(name.style, { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '15px' })
  // 第二行放类型标签与归档时间，强制同排：标签不收缩、时间不折行，
  // 极端窄屏只截断时间尾部，不允许整行换行。
  const meta = dom.createElement('div')
  Object.assign(meta.style, { minWidth: '0', display: 'flex', alignItems: 'center', gap: '8px' })
  const time = dom.createElement('span')
  time.textContent = formatArchiveTime(item.archivedAt)
  Object.assign(time.style, { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary, GrayText)', fontSize: '13px' })
  meta.append(createAgentBadge(adapterIdForSession(item.sessionId), dom, t), time)
  content.append(name, meta)
  const restore = createRestoreButton(item, row, context)
  row.append(content, restore)
  return row
}

/**
 * 行尾的取消归档按钮：图标按钮，不再占用一整行宽度。
 *
 * 图形沿用 DSH 原生归档行的 `IconUnarchiveOutlineRegular`，让插件模态框与原生
 * 界面语言一致；文字只保留在 `aria-label` 与 `title` 里。
 */
function createRestoreButton(
  item: ArchivedSessionItem,
  row: HTMLElement,
  context: ArchiveModalContext,
): HTMLButtonElement {
  const { dom, remote, t, onChanged, onSessionUnarchived } = context
  const unarchive = remote.workspace?.unarchiveSession
  const canUnarchive = typeof unarchive === 'function'
  const label = canUnarchive ? t('archive.restore') : t('archive.restoreUnsupported')
  const restore = dom.createElement('button')
  restore.type = 'button'
  restore.disabled = !canUnarchive
  restore.setAttribute('aria-label', label)
  restore.title = canUnarchive ? t('archive.restore') : t('archive.restoreUnsupportedTitle')
  Object.assign(restore.style, {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    padding: '0',
    border: '0',
    borderRadius: '8px',
    color: 'var(--dsw-alias-label-secondary, GrayText)',
    background: 'transparent',
    cursor: canUnarchive ? 'pointer' : 'not-allowed',
    opacity: canUnarchive ? '1' : '0.55',
    font: 'inherit',
  })
  restore.append(createUnarchiveIcon(dom))
  // 内联 style 表达不了 :hover，与插件其它自绘按钮一致用监听器补齐交互态。
  if (canUnarchive) {
    restore.addEventListener('mouseenter', () => {
      restore.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08))'
    })
    restore.addEventListener('mouseleave', () => {
      restore.style.background = 'transparent'
    })
  }
  restore.addEventListener('click', async () => {
    if (!canUnarchive || unarchive === undefined) return
    restore.disabled = true
    restore.style.opacity = '0.55'
    restore.setAttribute('aria-label', t('archive.processing'))
    try {
      await unarchive({ sessionId: item.sessionId })
      row.remove()
      await onSessionUnarchived?.(item.sessionId)
      onChanged()
    } catch {
      restore.disabled = false
      restore.style.opacity = '1'
      restore.setAttribute('aria-label', label)
    }
  })
  return restore
}

/**
 * DSH 官方“取消归档”图标几何。
 *
 * 取值自 `@deepseek-ai/dsh-client-ui-primitives` 的 `IconUnarchiveOutlineRegular`
 * （DSH 0.2.0-rc.2，20×20 viewBox）。不 import primitives 的原因与
 * `mobile-sidebar-logo.ts` 相同：本模块是纯 DOM 控制器，要在没有 React 的 Node
 * 测试里直接运行；内联同一份路径才能保持与原生归档行的视觉一致。
 */
const UNARCHIVE_ICON_VIEWBOX = '0 0 20 20'
const UNARCHIVE_ICON_BOX_PATH = 'M15.8659 2.05975C17.2603 2.05995 18.3913 3.19096 18.3914 4.58527V5.4874C18.3914 6.02747 18.2192 6.52672 17.9303 6.93735C17.9336 6.96524 17.9388 6.99318 17.9388 7.02195V12.8884C17.9388 13.6345 17.9395 14.2379 17.8996 14.7254C17.8642 15.1593 17.7936 15.5499 17.6373 15.9141L17.5654 16.0685C17.278 16.6328 16.8405 17.1046 16.3038 17.434L16.0679 17.5661C15.66 17.7739 15.2196 17.8598 14.7237 17.9003C14.2362 17.9401 13.6327 17.9405 12.8867 17.9405H7.11122C6.36511 17.9405 5.76171 17.9401 5.27418 17.9003C4.84051 17.8649 4.44949 17.7952 4.08545 17.6391L3.93104 17.5661C3.36673 17.2785 2.89392 16.8414 2.56465 16.3044L2.43245 16.0685C2.22473 15.6608 2.13878 15.2211 2.09825 14.7254C2.05841 14.2379 2.05912 13.6345 2.05912 12.8884V7.02195C2.05912 6.99284 2.06422 6.96449 2.06758 6.93629C1.77931 6.52592 1.60858 6.02687 1.60858 5.4874V4.58527C1.60876 3.19084 2.73962 2.05975 4.1341 2.05975H15.8659ZM16.4984 7.92936C16.296 7.98169 16.0847 8.01288 15.8659 8.01291H4.1341C3.91478 8.01291 3.70246 7.98194 3.49955 7.92936V12.8884C3.49955 13.6582 3.50053 14.1927 3.53445 14.608C3.56769 15.0146 3.62923 15.244 3.71635 15.415L3.7925 15.5514C3.98339 15.8627 4.25749 16.1165 4.58464 16.2833L4.72529 16.3435C4.88095 16.3993 5.08638 16.4402 5.39158 16.4651C5.80685 16.4991 6.34138 16.5001 7.11122 16.5001H12.8867C13.6564 16.5001 14.1911 16.499 14.6063 16.4651C15.0128 16.432 15.2423 16.3703 15.4133 16.2833L15.5508 16.2061C15.8618 16.0152 16.116 15.7419 16.2827 15.415L16.3429 15.2732C16.3985 15.1177 16.4396 14.9128 16.4645 14.608C16.4985 14.1927 16.4984 13.6583 16.4984 12.8884V7.92936ZM4.1341 3.50019C3.53511 3.50019 3.0492 3.98631 3.04902 4.58527V5.4874C3.04902 6.08649 3.535 6.57248 4.1341 6.57248H15.8659C16.4648 6.57228 16.951 6.08638 16.951 5.4874V4.58527C16.9509 3.98644 16.4647 3.50038 15.8659 3.50019H4.1341Z'
const UNARCHIVE_ICON_ARROW_PATH = 'M10 14.1V10.1M7.85 12.05L10 9.9L12.15 12.05'

/** 内联取消归档 SVG；`createElementNS` 不可用时退回字符占位。 */
function createUnarchiveIcon(dom: ArchiveModalDom): Element {
  const createElementNS = dom.createElementNS?.bind(dom)
  if (createElementNS === undefined) {
    const fallback = dom.createElement('span')
    fallback.textContent = '↩'
    fallback.setAttribute('aria-hidden', 'true')
    return fallback
  }
  const svg = createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', UNARCHIVE_ICON_VIEWBOX)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.display = 'block'
  svg.style.pointerEvents = 'none'
  const box = createElementNS('http://www.w3.org/2000/svg', 'path')
  box.setAttribute('fill-rule', 'evenodd')
  box.setAttribute('clip-rule', 'evenodd')
  box.setAttribute('fill', 'currentColor')
  box.setAttribute('d', UNARCHIVE_ICON_BOX_PATH)
  const arrow = createElementNS('http://www.w3.org/2000/svg', 'path')
  arrow.setAttribute('d', UNARCHIVE_ICON_ARROW_PATH)
  arrow.setAttribute('stroke', 'currentColor')
  arrow.setAttribute('stroke-width', '1')
  arrow.setAttribute('stroke-linecap', 'round')
  arrow.setAttribute('stroke-linejoin', 'round')
  svg.append(box, arrow)
  return svg
}

function createAgentBadge(
  adapterId: string | undefined,
  dom: Pick<Document, 'createElement'>,
  t: CodingNsTranslator,
): HTMLElement {
  const visual = providerVisual(adapterId, t)
  const badge = dom.createElement('span')
  badge.setAttribute(WORKSPACE_SESSION_ARCHIVE_AGENT_ATTRIBUTE, visual.adapterId ?? '')
  badge.textContent = visual.displayName
  Object.assign(badge.style, {
    flex: '0 0 auto',
    padding: '1px 8px',
    borderRadius: '999px',
    // 与插件其它徽章一致：实心文字色 + 同色低透明度底，深浅主题下都可读。
    color: visual.color,
    background: `color-mix(in srgb, ${visual.color} 14%, transparent)`,
    fontSize: '11px',
    fontWeight: '600',
    lineHeight: '18px',
    whiteSpace: 'nowrap',
  })
  return badge
}

function formatArchiveTime(timestamp: number): string {
  const value = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function closeArchiveModal(dom: Pick<Document, 'querySelector'>): void {
  dom.querySelector<HTMLElement>(`[${WORKSPACE_SESSION_ARCHIVE_MODAL_ATTRIBUTE}]`)?.remove()
}

function normalizeRemote(value: unknown): CodingNsRemote {
  if (!isRecord(value)) return {}
  // DSH Client Remote 通常按 namespace 暴露；兼容部分宿主直接使用 service 名称。
  const workspace = asRecord(readRemoteProperty(value, 'workspace'))
    ?? asRecord(readRemoteProperty(value, 'workspaceController'))
  const session = asRecord(readRemoteProperty(value, 'session'))
    ?? asRecord(readRemoteProperty(value, 'sessionController'))
  return {
    ...(workspace ? { workspace: workspace as unknown as RemoteWorkspaceApi } : {}),
    ...(session ? { session: session as unknown as RemoteSessionApi } : {}),
  }
}

/** Cordis Remote 是受注入约束的代理，读取未声明的可选 namespace 会抛异常。 */
function readRemoteProperty(value: Record<string, any>, key: string): unknown {
  try {
    return value[key]
  } catch {
    return undefined
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => { const result = readString(item); return result === undefined ? [] : [result] }) : []
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return isRecord(value) ? value : undefined
}

/** DSH Remote 的直接调用返回 RemoteResult；测试桩和旧宿主可能直接返回 value。 */
function unwrapRemoteValue(value: unknown): unknown {
  const record = asRecord(value)
  if (record === undefined || typeof record.ok !== 'boolean') return value
  return record.ok ? record.value : undefined
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
