import {
  findWorkspaceContainer,
  findWorkspaceHeaders,
  loadWorkspaceRecords,
  resolveWorkspaceId,
  type WorkspaceRecord,
} from './workspace-session-archive-dom.js'

/** 工作区隐藏注入节点的标记，便于重复扫描和停用时完整清理。 */
export const WORKSPACE_SESSION_HIDDEN_ATTRIBUTE = 'data-codingns-hidden-workspace'
export const WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE = 'data-codingns-hidden-workspace-menu'
export const WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE = 'data-codingns-hidden-workspaces'
const WORKSPACE_SESSION_HIDDEN_LIST_STATE_ATTRIBUTE = 'data-codingns-hidden-workspaces-state'
const WORKSPACE_SESSION_HIDDEN_MENU_WORKSPACE_ATTRIBUTE = 'data-codingns-hidden-workspace-id'
export const WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE = 'data-codingns-hidden-workspace-filter'
export const WORKSPACE_SESSION_HIDDEN_FILTER_CHECK_ATTRIBUTE = 'data-codingns-hidden-workspace-filter-check'
const WORKSPACE_SESSION_HIDDEN_FILTER_BOUND_ATTRIBUTE = 'data-codingns-hidden-workspace-filter-bound'

const MENU_ATTRIBUTE = 'aria-haspopup'
const WORKSPACE_MENU_PATTERN = /(?:更多|菜单|选项|more|menu|option)/iu
const WORKSPACE_FILTER_PATTERN = /(?:视图选项|筛选选项|view\s*options|filter\s*options)/iu
type ActiveMenuKind = 'workspace' | 'filter'

export interface WorkspaceSessionVisibilityDomController {
  /** 重新读取工作区并同步侧栏 DOM。 */
  refresh(): void
  /** 设置当前隐藏的工作区 ID，并触发一次扫描。 */
  setHiddenWorkspaceIds(ids: readonly string[]): void
  /** 断开观察器并恢复所有被插件隐藏的节点。 */
  dispose(): void
}

export interface WorkspaceSessionVisibilityDomOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  readonly remote?: unknown
  readonly hiddenWorkspaceIds?: readonly string[]
  /** 持久化由功能模块完成；回调失败时控制器会恢复上一次可见状态。 */
  readonly onHiddenWorkspaceIdsChange?: (ids: readonly string[]) => Promise<void> | void
}

/**
 * 给原生工作区菜单增加隐藏动作，并通过工作区筛选菜单控制恢复列表。
 *
 * DSH 当前版本没有公开工作区可见性 API，因此这里仅隐藏原生 DOM，工作区
 * 本身仍由 DSH Workspace Controller 管理；隐藏 ID 存在 Codingns4DSH 设置中。
 */
export function startWorkspaceSessionVisibilityDom(
  options: WorkspaceSessionVisibilityDomOptions = {},
): WorkspaceSessionVisibilityDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const remote = options.remote
  let hiddenWorkspaceIds = new Set(normalizeIds(options.hiddenWorkspaceIds ?? []))
  let workspaces: readonly WorkspaceRecord[] = []
  let disposed = false
  let scanQueued = false
  let loading: Promise<void> | undefined
  let activeMenuWorkspaceId: string | undefined
  let activeMenuKind: ActiveMenuKind | undefined
  let activeFilterTrigger: HTMLElement | undefined
  let suppressFilterTrigger = false
  let menuContextPending = false
  let showHiddenWorkspaces = false
  let menuRescanTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let knownNativeMenus = new Set<HTMLElement>()
  let changeSequence = 0
  const menuWorkspaceIds = new WeakMap<HTMLElement, string>()

  const persist = options.onHiddenWorkspaceIdsChange
  const updateVisibility = (workspaceId: string, hidden: boolean): void => {
    const previous = [...hiddenWorkspaceIds]
    const change = ++changeSequence
    const next = new Set(previous)
    if (hidden) next.add(workspaceId)
    else next.delete(workspaceId)
    const normalized = normalizeIds([...next])
    hiddenWorkspaceIds = new Set(normalized)
    scheduleScan()
    if (persist === undefined) return
    Promise.resolve(persist(normalized)).catch(() => {
      if (change !== changeSequence) return
      hiddenWorkspaceIds = new Set(previous)
      scheduleScan()
    })
  }

  const refreshData = async (): Promise<void> => {
    if (disposed) return
    if (loading !== undefined) {
      await loading
      return
    }
    loading = loadWorkspaceRecords(remote).then((next) => {
      if (disposed) return
      workspaces = next
      scan()
    }).catch(() => undefined).finally(() => {
      loading = undefined
    })
    await loading
  }

  const scan = (): void => {
    if (disposed || dom === undefined) return
    observer?.disconnect()
    try {
      clearHiddenWorkspaceNodes(dom)
      if (!showHiddenWorkspaces) removeVisibilityEntries(dom)
      const headers = findWorkspaceHeaders(dom)
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.workspaceId))
      for (const header of headers) {
        const workspaceId = resolveWorkspaceId(header)
        if (workspaceId === undefined) continue
        workspaceIds.add(workspaceId)
        bindWorkspaceMenuTriggers(header, workspaceId, () => {
          activeMenuWorkspaceId = workspaceId
          activeMenuKind = 'workspace'
          menuContextPending = true
          // 菜单由 DSH 在点击事件后异步挂载到 Portal；在事件队列结束后再扫描，
          // 避免在宿主菜单尚未完成打开时同步改写它的 DOM。
          scheduleScan()
          scheduleMenuRescan()
        })
        if (hiddenWorkspaceIds.has(workspaceId)) markWorkspaceHidden(header, workspaceId)
      }
      bindWorkspaceFilterTriggers(dom, (trigger) => {
        if (suppressFilterTrigger) return
        activeFilterTrigger = trigger
        activeMenuKind = 'filter'
        menuContextPending = true
        scheduleScan()
        scheduleMenuRescan()
      })
      const menus = findWorkspaceMenus(dom)
      knownNativeMenus = new Set(menus)
      if (menus.length > 0) menuContextPending = false
      if (activeMenuKind === 'filter') {
        injectFilterMenuAction(dom, selectFilterMenus(menus, menuWorkspaceIds, activeMenuWorkspaceId), showHiddenWorkspaces, () => {
          showHiddenWorkspaces = !showHiddenWorkspaces
          scheduleScan()
        }, (menu) => closeFilterMenu(activeFilterTrigger, menu, () => {
          suppressFilterTrigger = true
          return () => { suppressFilterTrigger = false }
        }))
      } else {
        injectWorkspaceMenuActions(selectWorkspaceMenus(menus), dom, activeMenuWorkspaceId, workspaceIds, menuWorkspaceIds, (workspaceId) => updateVisibility(workspaceId, true))
      }
      // 点击触发器与 Portal 菜单挂载不是同一个同步阶段。菜单尚未出现时
      // 必须保留上下文，否则后续 MutationObserver 扫描无法判断这是筛选菜单。
      if (menus.length === 0 && !menuContextPending) {
        activeMenuWorkspaceId = undefined
        activeMenuKind = undefined
      }
      if (showHiddenWorkspaces) {
        injectHiddenWorkspaceFooter(dom, headers, workspaces, hiddenWorkspaceIds, (workspaceId) => updateVisibility(workspaceId, false))
      }
    } finally {
      if (!disposed && observer !== undefined && dom.documentElement !== null) {
        observer.observe(dom.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
      }
    }
  }

  const scheduleScan = (mutations: readonly MutationRecord[] = []): void => {
    if (disposed || scanQueued) return
    // 展开恢复列表也使用 aria-expanded；忽略插件自身的属性变化，避免每次
    // 点击列表都被观察器重建成收起状态。
    if (mutations.length > 0 && mutations.every((mutation) => (
      isVisibilityMutation(mutation.target) || isNativeMenuMutation(mutation.target, knownNativeMenus)
    ))) return
    scanQueued = true
    queueMicrotask(() => {
      scanQueued = false
      scan()
    })
  }

  const scheduleMenuRescan = (): void => {
    if (menuRescanTimer !== undefined) globalThis.clearTimeout(menuRescanTimer)
    menuRescanTimer = globalThis.setTimeout(() => {
      menuRescanTimer = undefined
      scheduleScan()
    }, 50)
  }

  const observer = dom === undefined || Observer === undefined
    ? undefined
    : new Observer(scheduleScan)
  if (observer !== undefined && dom !== undefined) {
    observer.observe(dom.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  }

  scan()
  void refreshData()

  return {
    refresh() {
      scheduleScan()
      void refreshData()
    },
    setHiddenWorkspaceIds(ids) {
      changeSequence += 1
      hiddenWorkspaceIds = new Set(normalizeIds(ids))
      scheduleScan()
    },
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      if (menuRescanTimer !== undefined) globalThis.clearTimeout(menuRescanTimer)
      knownNativeMenus = new Set()
      if (dom !== undefined) {
        clearHiddenWorkspaceNodes(dom)
        removeVisibilityEntries(dom)
        removeMenuEntries(dom)
      }
    },
  }
}

function isVisibilityMutation(target: Node): boolean {
  return typeof Element !== 'undefined' && target instanceof Element
    && (target.closest(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`) !== null
      || target.closest(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`) !== null)
}

function isNativeMenuMutation(target: Node, knownMenus: ReadonlySet<HTMLElement>): boolean {
  return typeof Element !== 'undefined'
    && target instanceof Element
    && (target.closest('[role="menu"], [role="listbox"], [data-menu-content], [data-radix-menu-content]') !== null
      || [...knownMenus].some((menu) => menu.contains(target)))
}

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((value) => {
    const normalized = typeof value === 'string' ? value.trim() : ''
    return normalized === '' ? [] : [normalized]
  }))]
}

function bindWorkspaceMenuTriggers(header: HTMLElement, workspaceId: string, rememberWorkspace: () => void): void {
  const elements = [header, ...header.querySelectorAll<HTMLElement>('button,[role="button"]')]
  for (const element of elements) {
    if (element === header || !isWorkspaceMenuTrigger(element)) continue
    if (element.getAttribute('data-codingns-hidden-menu-bound') === workspaceId) continue
    element.setAttribute('data-codingns-hidden-menu-bound', workspaceId)
    element.addEventListener('click', rememberWorkspace)
  }
}

function isWorkspaceMenuTrigger(element: HTMLElement): boolean {
  if (element.getAttribute(MENU_ATTRIBUTE) === 'menu') return true
  const label = `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.title}`.replace(/\s+/gu, ' ')
  return WORKSPACE_MENU_PATTERN.test(label)
}

function bindWorkspaceFilterTriggers(
  dom: Pick<Document, 'querySelectorAll'>,
  rememberFilter: (trigger: HTMLElement) => void,
): void {
  for (const element of dom.querySelectorAll<HTMLElement>('button,[role="button"]')) {
    if (!isWorkspaceFilterTrigger(element)) continue
    if (element.getAttribute(WORKSPACE_SESSION_HIDDEN_FILTER_BOUND_ATTRIBUTE) === 'true') continue
    element.setAttribute(WORKSPACE_SESSION_HIDDEN_FILTER_BOUND_ATTRIBUTE, 'true')
    element.addEventListener('click', () => rememberFilter(element))
  }
}

function isWorkspaceFilterTrigger(element: HTMLElement): boolean {
  const label = `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.title}`.replace(/\s+/gu, ' ')
  return WORKSPACE_FILTER_PATTERN.test(label)
}

function findWorkspaceMenus(dom: Pick<Document, 'querySelectorAll'>): HTMLElement[] {
  const explicit = [...dom.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"], [data-menu-content], [data-radix-menu-content]')]
  if (explicit.length > 0) return explicit
  // 某些 DSH 构建不会给 Portal 菜单设置 role。不能遍历页面所有 div 并对每个
  // 节点读取 textContent，那会在长会话页面上反复遍历整棵消息树，退化为 O(N²)。
  // 从已有菜单项向上聚合少量候选容器，复杂度只和菜单项数量及祖先深度有关。
  const itemSelector = 'button,[role="menuitem"],[role="menuitemcheckbox"]'
  const counts = new Map<HTMLElement, number>()
  for (const item of dom.querySelectorAll<HTMLElement>(itemSelector)) {
    let current = item.parentElement
    for (let depth = 0; depth < 8 && current !== null; depth += 1, current = current.parentElement) {
      counts.set(current, (counts.get(current) ?? 0) + 1)
    }
  }
  const candidates = [...counts.keys()].filter((element) => (
    (counts.get(element) ?? 0) >= 3
      && /(?:分组方式|排序方式|筛选会话|group(?:ing)?|sort|filter)/iu.test(element.textContent ?? '')
  ))
  return candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)))
}

/**
 * 菜单 Portal 在关闭时可能短暂保留旧节点。先过滤不可见节点，再按菜单内容
 * 区分筛选菜单和工作区操作菜单，避免旧筛选菜单抢走当前工作区菜单的注入目标。
 */
function selectFilterMenus(
  menus: readonly HTMLElement[],
  menuWorkspaceIds: WeakMap<HTMLElement, string>,
  activeWorkspaceId: string | undefined,
): HTMLElement[] {
  const visible = menus.filter(isVisibleMenu)
  const candidates = (visible.length > 0 ? visible : menus).filter(isWorkspaceFilterMenu)
  if (candidates.length > 0) return [candidates[candidates.length - 1]]
  const fallback = (visible.length > 0 ? visible : menus).filter((menu) => (
    menuWorkspaceIds.get(menu) === undefined
      && (activeWorkspaceId === undefined || resolveWorkspaceId(menu) !== activeWorkspaceId)
      && menu.querySelector(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`) === null
  ))
  return fallback.length > 0 ? [fallback[fallback.length - 1]] : []
}

function selectWorkspaceMenus(menus: readonly HTMLElement[]): HTMLElement[] {
  const visible = menus.filter(isVisibleMenu)
  const candidates = (visible.length > 0 ? visible : menus).filter((menu) => !isWorkspaceFilterMenu(menu))
  const available = candidates.length > 0 ? candidates : (visible.length > 0 ? visible : menus)
  return available.length > 0 ? [available[available.length - 1]] : []
}

function isVisibleMenu(menu: HTMLElement): boolean {
  if (menu.hasAttribute('hidden') || menu.getAttribute('aria-hidden') === 'true' || menu.getAttribute('data-state') === 'closed') return false
  const style = menu.style
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function isWorkspaceFilterMenu(element: HTMLElement): boolean {
  return /(?:分组方式|排序方式|筛选会话|group(?:ing)?|sort(?:ing)?|filter(?:\s+sessions?)?)/iu.test(element.textContent ?? '')
}

function injectWorkspaceMenuActions(
  menus: readonly HTMLElement[],
  dom: Pick<Document, 'querySelectorAll' | 'createElement'>,
  activeWorkspaceId: string | undefined,
  workspaceIds: ReadonlySet<string>,
  menuWorkspaceIds: WeakMap<HTMLElement, string>,
  onHide: (workspaceId: string) => void,
): void {
  for (const menu of menus) {
    for (const stale of menu.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE}]`)) stale.remove()
    const workspaceId = activeWorkspaceId ?? resolveWorkspaceId(menu) ?? menuWorkspaceIds.get(menu)
    if (workspaceId === undefined) continue
    if (!workspaceIds.has(workspaceId)) continue
    menuWorkspaceIds.set(menu, workspaceId)
    const existing = menu.querySelector<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`)
    if (existing?.getAttribute(WORKSPACE_SESSION_HIDDEN_MENU_WORKSPACE_ATTRIBUTE) === workspaceId) continue
    existing?.remove()
    const action = dom.createElement('button')
    action.type = 'button'
    action.setAttribute('role', 'menuitem')
    action.setAttribute(WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE, '')
    action.setAttribute(WORKSPACE_SESSION_HIDDEN_MENU_WORKSPACE_ATTRIBUTE, workspaceId)
    action.setAttribute('aria-label', '隐藏工作区')
    applyNativeMenuItemStyle(action, menu)
    action.textContent = '隐藏工作区'
    const actionIcon = createHiddenIcon(dom)
    action.insertBefore(actionIcon, action.firstChild)
    action.addEventListener('click', () => {
      // 先让 DSH 完成原生菜单的 click 处理，再修改工作区 DOM；同步扫描会
      // 与宿主 React 菜单的提交阶段竞争，表现为点击后整个页面卡住。
      globalThis.setTimeout(() => {
        onHide(workspaceId)
      }, 0)
    })
    menu.appendChild(action)
  }
}

function injectFilterMenuAction(
  dom: Pick<Document, 'querySelectorAll' | 'createElement'>,
  menus: readonly HTMLElement[],
  checked: boolean,
  onChange: () => void,
  onClose: (menu: HTMLElement) => void,
): void {
  // 没有可读文本时，Portal 最近追加的菜单就是当前视图菜单；避免把选项
  // 错注入到页面中其他仍然存在的菜单。
  const menu = menus.find(isWorkspaceFilterMenu) ?? menus[menus.length - 1]
  if (menu === undefined) return
  for (const stale of menu.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`)) stale.remove()
  const existing = menu.querySelector<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE}]`)
  if (existing !== null) {
    existing.setAttribute('aria-checked', String(checked))
    updateFilterMenuCheckmark(dom, existing, checked)
    return
  }
  const action = dom.createElement('button')
  action.type = 'button'
  // DSH 菜单只会把 role=menuitem 视为可选择并在点击后正确收起；
  // aria-checked 仍保留筛选项的选中语义。
  action.setAttribute('role', 'menuitem')
  action.setAttribute('aria-checked', String(checked))
  action.setAttribute(WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE, '')
  action.setAttribute('aria-label', '显示隐藏的工作区')
  applyNativeMenuItemStyle(action, menu)
  action.textContent = '显示隐藏的工作区'
  const actionIcon = createHiddenIcon(dom)
  action.insertBefore(actionIcon, action.firstChild)
  updateFilterMenuCheckmark(dom, action, checked)
  action.addEventListener('click', () => {
    globalThis.setTimeout(() => {
      onChange()
      // Portal 菜单由 DSH React 持有，不能直接 remove()，否则 React 后续
      // 卸载时会对同一节点再次 removeChild 并抛出 NotFoundError。
      onClose(menu)
    }, 0)
  })
  menu.appendChild(action)
}

function closeFilterMenu(
  trigger: HTMLElement | undefined,
  menu: HTMLElement,
  suppressTrigger: () => () => void,
): void {
  if (trigger === undefined || !isDomNodeConnected(menu) || typeof trigger.click !== 'function') return
  const release = suppressTrigger()
  try {
    trigger.click()
  } finally {
    release()
  }
}

function isDomNodeConnected(node: HTMLElement): boolean {
  return node.parentElement !== null || node.isConnected === true
}

function updateFilterMenuCheckmark(
  dom: Pick<Document, 'createElement'>,
  action: HTMLElement,
  checked: boolean,
): void {
  const existing = action.querySelector<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_FILTER_CHECK_ATTRIBUTE}]`)
  if (!checked) {
    existing?.remove()
    return
  }
  if (existing !== null) return
  const check = createCheckIcon(dom)
  check.setAttribute(WORKSPACE_SESSION_HIDDEN_FILTER_CHECK_ATTRIBUTE, '')
  action.appendChild(check)
}

function applyNativeMenuItemStyle(action: HTMLElement, menu: HTMLElement): void {
  const reference = menu.querySelector<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], button')
  if (reference !== null && reference.className !== '') {
    action.className = reference.className
    return
  }
  Object.assign(action.style, menuItemStyle)
}

function injectHiddenWorkspaceFooter(
  dom: Pick<Document, 'body' | 'querySelectorAll' | 'createElement'>,
  headers: readonly HTMLElement[],
  workspaces: readonly WorkspaceRecord[],
  hiddenWorkspaceIds: ReadonlySet<string>,
  onRestore: (workspaceId: string) => void,
): void {
  const recordsById = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  for (const header of headers) {
    const workspaceId = resolveWorkspaceId(header)
    if (workspaceId !== undefined && !recordsById.has(workspaceId)) {
      recordsById.set(workspaceId, { workspaceId, title: workspaceId, sessionIds: [], archivedSessionIds: [] })
    }
  }
  // 新近隐藏的工作区排在前面，恢复入口更符合用户刚刚完成的操作顺序。
  const hidden = [...hiddenWorkspaceIds].reverse().flatMap((workspaceId) => {
    const workspace = recordsById.get(workspaceId)
    return workspace === undefined ? [] : [workspace]
  })
  const host = findWorkspaceListContainer(dom, headers)
  const existing = dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`)[0] ?? null
  if (hidden.length === 0 || host === null) {
    existing?.remove()
    return
  }
  const state = hidden.map((workspace) => `${workspace.workspaceId}\u0000${workspace.title}\u0000${workspace.path ?? ''}`).join('\u0001')
  if (existing !== null
    && existing.parentElement === host
    && existing.getAttribute(WORKSPACE_SESSION_HIDDEN_LIST_STATE_ATTRIBUTE) === state) return
  existing?.remove()
  const entry = dom.createElement('div')
  entry.setAttribute(WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE, '')
  entry.setAttribute(WORKSPACE_SESSION_HIDDEN_LIST_STATE_ATTRIBUTE, state)
  Object.assign(entry.style, footerStyle)
  const toggle = dom.createElement('button')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.setAttribute('aria-label', `隐藏的工作区 ${hidden.length}`)
  Object.assign(toggle.style, menuItemStyle)
  toggle.textContent = `隐藏的工作区 ${hidden.length}`
  const toggleIcon = createHiddenIcon(dom)
  toggle.insertBefore(toggleIcon, toggle.firstChild)
  const list = dom.createElement('div')
  list.hidden = true
  Object.assign(list.style, { display: 'none', flexDirection: 'column', gap: '2px', marginTop: '2px' })
  for (const workspace of hidden) {
    const restore = dom.createElement('button')
    restore.type = 'button'
    restore.setAttribute('role', 'menuitem')
    restore.setAttribute('aria-label', `恢复工作区 ${workspace.title}`)
    restore.textContent = workspace.title
    restore.title = workspace.path ?? workspace.workspaceId
    Object.assign(restore.style, menuItemStyle, { paddingLeft: '28px' })
    restore.addEventListener('click', () => onRestore(workspace.workspaceId))
    list.appendChild(restore)
  }
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true'
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true')
    list.hidden = expanded
    list.style.display = expanded ? 'none' : 'flex'
  })
  entry.append(toggle, list)
  host.appendChild(entry)
}

function createHiddenIcon(dom: Pick<Document, 'createElement'>): Node {
  const createElementNS = (dom as Document).createElementNS
  if (typeof createElementNS === 'function') {
    const icon = createElementNS.call(dom, 'http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
    icon.setAttribute('width', '16')
    icon.setAttribute('height', '16')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.8')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    icon.setAttribute('aria-hidden', 'true')
    const path = createElementNS.call(dom, 'http://www.w3.org/2000/svg', 'path') as SVGPathElement
    path.setAttribute('d', 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.7 10.7 0 0 1 12 4c5 0 9 4 10 8-.4 1.5-1.2 2.8-2.2 3.9M6.1 6.1C4.5 7.2 3.3 8.8 2 12c1 4 5 8 10 8 1 0 2-.2 2.9-.5')
    icon.append(path)
    Object.assign(icon.style, hiddenIconStyle)
    return icon
  }
  const icon = dom.createElement('span')
  icon.textContent = '⊘'
  icon.setAttribute('aria-hidden', 'true')
  Object.assign(icon.style, hiddenIconStyle)
  return icon
}

function createCheckIcon(dom: Pick<Document, 'createElement'>): Element {
  const createElementNS = (dom as Document).createElementNS
  if (typeof createElementNS === 'function') {
    const icon = createElementNS.call(dom, 'http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
    icon.setAttribute('width', '16')
    icon.setAttribute('height', '16')
    icon.setAttribute('viewBox', '0 0 16 16')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.5')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    icon.setAttribute('aria-hidden', 'true')
    const path = createElementNS.call(dom, 'http://www.w3.org/2000/svg', 'path') as SVGPathElement
    path.setAttribute('d', 'm3 8 3 3 7-7')
    icon.append(path)
    Object.assign(icon.style, checkIconStyle)
    return icon
  }
  const icon = dom.createElement('span')
  icon.textContent = '✓'
  icon.setAttribute('aria-hidden', 'true')
  Object.assign(icon.style, checkIconStyle)
  return icon
}

function markWorkspaceHidden(header: HTMLElement, workspaceId: string): void {
  const container = narrowWorkspaceContainer(header, workspaceId)
  if (container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE)) return
  container.setAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE, workspaceId)
  container.dataset.codingnsHiddenDisplay = container.style.display
  container.dataset.codingnsHiddenValue = container.hidden ? 'true' : 'false'
  container.hidden = true
  container.style.display = 'none'
}

function narrowWorkspaceContainer(header: HTMLElement, workspaceId: string): HTMLElement {
  const candidate = findWorkspaceContainer(header, workspaceId)
  if (candidate === null) return header
  const nestedHeaders = candidate.querySelectorAll('[role="treeitem"][aria-expanded]').length
  const isBroadContainer = candidate.tagName === 'BODY'
    || candidate.tagName === 'HTML'
    || candidate.getAttribute('role') === 'tree'
    || nestedHeaders > 1
  return isBroadContainer ? closestWorkspaceContainer(header) : candidate
}

function closestWorkspaceContainer(header: HTMLElement): HTMLElement {
  const parent = header.parentElement
  if (parent === null
    || parent.tagName === 'BODY'
    || parent.tagName === 'HTML'
    || parent.getAttribute('role') === 'tree'
    || parent.querySelectorAll('[role="treeitem"][aria-expanded]').length > 1) return header
  return parent
}

function clearHiddenWorkspaceNodes(dom: Pick<Document, 'querySelectorAll'>): void {
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_ATTRIBUTE}]`)) {
    const display = node.dataset.codingnsHiddenDisplay ?? ''
    const hidden = node.dataset.codingnsHiddenValue === 'true'
    node.hidden = hidden
    node.style.display = display
    delete node.dataset.codingnsHiddenDisplay
    delete node.dataset.codingnsHiddenValue
    node.removeAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE)
  }
}

function removeVisibilityEntries(dom: Pick<Document, 'querySelectorAll'>): void {
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`)) node.remove()
}

function removeMenuEntries(dom: Pick<Document, 'querySelectorAll'>): void {
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`)) node.remove()
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_FILTER_ATTRIBUTE}]`)) node.remove()
}

function findWorkspaceListContainer(
  dom: Pick<Document, 'body' | 'querySelectorAll'>,
  headers: readonly HTMLElement[],
): HTMLElement | null {
  const first = headers[0]
  if (first !== undefined) {
    let current: HTMLElement | null = first.parentElement
    // 只有一个工作区时，header 的直接父节点往往就是该工作区容器；
    // 再向上一层才能把恢复入口放到工作区列表本身，而不是隐藏容器内。
    if (headers.length === 1 && current?.getAttribute('role') !== 'tree') current = current?.parentElement ?? null
    for (let depth = 0; depth < 10 && current !== null; depth += 1) {
      if (current.getAttribute('role') === 'tree') return current
      if (headers.every((header) => current?.contains(header))) return current
      current = current.parentElement
    }
  }
  return dom.body ?? null
}

const menuItemStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  width: '100%',
  minHeight: '36px',
  boxSizing: 'border-box',
  padding: '6px 10px',
  border: '0',
  borderRadius: '6px',
  color: 'inherit',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '14px',
  fontWeight: '400',
  lineHeight: '20px',
}

const hiddenIconStyle = {
  display: 'inline-flex',
  width: '16px',
  height: '16px',
  flex: '0 0 16px',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'currentColor',
  fontSize: '16px',
  lineHeight: '16px',
}

const checkIconStyle = {
  display: 'inline-flex',
  width: '16px',
  height: '16px',
  flex: '0 0 16px',
  marginLeft: 'auto',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'currentColor',
}

const footerStyle = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  boxSizing: 'border-box',
  marginTop: '4px',
  paddingTop: '4px',
  borderTop: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.18))',
}
