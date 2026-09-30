import type { AggregateHostResult } from '../shared/contracts/peer-host.js'
import { createVirtualWorkspaceId, parseVirtualWorkspaceId } from '../shared/contracts/peer-host.js'
import { resolvePeerHostColor } from './peer-host-color.js'

/**
 * 在工作区名称后注入彩色 Host 标签。
 *
 * DSH 的工作区行（`ProjectRowItem`）内部没有任何插槽，标题是纯文本，因此只能走
 * DOM 注入——这也是仓库里 `workspace-session-archive-dom` 已经在用的做法。注入点
 * 必须是 `projectText` 容器内、`title` 之后的兄弟节点：`title` 带
 * `overflow:hidden` + `text-overflow:ellipsis`，插进它内部会被直接裁掉。
 *
 * 标签是纯展示：`pointer-events:none` + `aria-hidden`，避免抢走行的点击，也避免
 * 被移动端横滑手势的 `preventDefault` 吞掉。
 */
export const PEER_HOST_WORKSPACE_TAG_ATTRIBUTE = 'data-codingns-peer-host-tag'

/** 工作区行：DSH 只给工作区行加 `aria-expanded`，会话行只有 `aria-selected`。 */
const WORKSPACE_ROW_SELECTOR = '[role="treeitem"][aria-expanded]'

/** 标签需要插入的标题容器；找不到时跳过该行，不做兜底猜测。 */
const TITLE_CONTAINER_SELECTOR = '[class*="_projectText"]'

/**
 * Host 标签的最大宽度（像素）。
 *
 * Host 名与工作区名在同一行竞争空间：不给标签设上限时，长 Host 名会把工作区名压到
 * 几乎不可读。超过上限的部分由 `text-overflow: ellipsis` 截断。
 */
export const PEER_HOST_TAG_MAX_WIDTH_PX = 50

export interface PeerHostWorkspaceTagController {
  /** 用新的聚合快照刷新标签；同一工作区只保留一个标签。 */
  setAggregate(results: readonly AggregateHostResult[]): void
  /** 断开观察器并移除所有注入节点。 */
  dispose(): void
}

export interface PeerHostWorkspaceTagOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
}

interface HostTagStyle {
  readonly label: string
  readonly color: string
}

/**
 * 启动工作区 Host 标签注入。
 *
 * 只有远端（`targetHostId !== null`）工作区才加标签：本机工作区不需要用颜色区分
 * 自己，给每个本地工作区都加一个标签只会制造噪音。
 */
export function startPeerHostWorkspaceTag(options: PeerHostWorkspaceTagOptions = {}): PeerHostWorkspaceTagController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  if (dom === undefined) return { setAggregate() {}, dispose() {} }
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)

  let disposed = false
  let scanQueued = false
  /** 虚拟工作区 ID -> 标签样式；聚合变化时整体替换。 */
  let tags = new Map<string, HostTagStyle>()

  const scan = (): void => {
    if (disposed) return
    for (const row of dom.querySelectorAll<HTMLElement>(WORKSPACE_ROW_SELECTOR)) {
      const virtualWorkspaceId = resolveWorkspaceIdFromRow(row)
      const tag = virtualWorkspaceId === undefined ? undefined : tags.get(virtualWorkspaceId)
      if (tag === undefined || virtualWorkspaceId === undefined) {
        row.querySelector<HTMLElement>(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`)?.remove()
        continue
      }
      upsertTag(row, virtualWorkspaceId, tag, dom)
    }
    // 聚合里已经没有的工作区标签可能在折叠/重建过程中残留，统一清理一次。
    for (const node of dom.querySelectorAll<HTMLElement>(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`)) {
      const workspaceId = node.dataset.codingnsPeerHostWorkspace
      if (workspaceId === undefined || !tags.has(workspaceId)) node.remove()
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

  const observer = Observer === undefined ? undefined : new Observer(scheduleScan)
  if (observer !== undefined && dom.documentElement !== null) {
    observer.observe(dom.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  }
  scan()

  return {
    setAggregate(results) {
      if (disposed) return
      const next = new Map<string, HostTagStyle>()
      for (const host of results) {
        if (host.targetHostId === null) continue
        const color = resolvePeerHostColor(host.hostColor, host.hostLabel)
        for (const workspace of host.workspaces) {
          // 键必须是原生列表真正持有的虚拟 ID，否则 data-row-key 反查永远落空。
          next.set(createVirtualWorkspaceId(host.targetHostId, workspace.workspaceId), { label: host.hostLabel, color })
        }
      }
      tags = next
      scheduleScan()
    },
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      dom.querySelectorAll<HTMLElement>(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`).forEach((node) => node.remove())
    },
  }
}

/**
 * 从工作区行反查虚拟工作区 ID。
 *
 * `data-row-key="workspace:<id>"` 是稳定且零成本的路径；React fiber 只作为兜底，
 * 因为爬 fiber 在长列表下开销明显。
 */
export function resolveWorkspaceIdFromRow(row: HTMLElement): string | undefined {
  const rowKey = row.getAttribute('data-row-key')
  if (rowKey !== null && rowKey.startsWith('workspace:')) {
    const value = rowKey.slice('workspace:'.length).trim()
    if (value !== '') return value
  }
  return readWorkspaceIdFromFiber(row)
}

function readWorkspaceIdFromFiber(row: HTMLElement): string | undefined {
  const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith('__reactFiber$'))
  if (fiberKey === undefined) return undefined
  let current: unknown = (row as unknown as Record<string, unknown>)[fiberKey]
  for (let depth = 0; depth < 24 && isRecord(current); depth += 1) {
    for (const props of [current.memoizedProps, current.pendingProps]) {
      const found = readWorkspaceIdFromProps(props)
      if (found !== undefined) return found
    }
    current = current.return
  }
  return undefined
}

function readWorkspaceIdFromProps(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of ['workspaceId', 'workspaceID']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  for (const key of ['workspace', 'group', 'row', 'item', 'value', 'data']) {
    const nested = value[key]
    if (!isRecord(nested)) continue
    const candidate = nested.workspaceId ?? nested.id
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * 注入或更新标签；内容与配色都没变时不碰 DOM，避免触发无意义的 MutationObserver 回调。
 *
 * 标签必须作为 `projectText` 的**兄弟节点**插进行内：`projectText` 是
 * `flex-direction: column` 的容器，把标签 append 进去会让它掉到工作区名称的第二行
 * （用户实测到的"挤压"）。行本身是 `display:flex; align-items:center`，插成兄弟后
 * 标签与名称同行；`projectText` 带 `flex:1`，标签又是 `flex:none`，因此标签稳定停在
 * 列表最右侧，名称过长时由原生 `text-overflow:ellipsis` 截断，而不是把标签挤走。
 */
function upsertTag(row: HTMLElement, virtualWorkspaceId: string, tag: HostTagStyle, dom: Document): void {
  const existing = row.querySelector<HTMLElement>(`[${PEER_HOST_WORKSPACE_TAG_ATTRIBUTE}]`)
  if (existing !== null
    && existing.textContent === tag.label
    && existing.dataset.codingnsPeerHostColor === tag.color
    && existing.dataset.codingnsPeerHostWorkspace === virtualWorkspaceId) return

  const container = row.querySelector<HTMLElement>(TITLE_CONTAINER_SELECTOR)
  const host = container?.parentElement ?? null
  if (container === null || host === null) return
  existing?.remove()

  const element = dom.createElement('span')
  element.setAttribute(PEER_HOST_WORKSPACE_TAG_ATTRIBUTE, '')
  element.setAttribute('aria-hidden', 'true')
  element.dataset.codingnsPeerHostColor = tag.color
  element.dataset.codingnsPeerHostWorkspace = virtualWorkspaceId
  element.textContent = tag.label
  Object.assign(element.style, {
    // flex:none + margin-left:auto：标签不被压缩，并稳定贴住行尾。
    flex: 'none',
    marginLeft: 'auto',
    alignSelf: 'center',
    // Host 名与工作区名冲突时截断 Host 名；上限 50px（含内边距），超出显示省略号。
    boxSizing: 'border-box',
    maxWidth: `${PEER_HOST_TAG_MAX_WIDTH_PX}px`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '1px 6px',
    borderRadius: '999px',
    fontSize: '10px',
    lineHeight: '1.5',
    pointerEvents: 'none',
    color: tag.color,
    background: `color-mix(in srgb, ${tag.color} 16%, transparent)`,
  })
  // 插为行的最后一个子节点：`rowActions` 只在 hover 时显示（`display:none` 不占位），
  // 放在它之前会让标签在 hover 时被操作按钮向左顶开；放最后才能稳定贴住最右侧。
  host.append(element)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断某个虚拟工作区 ID 是否属于远端；供投影与测试复用。 */
export function isRemoteVirtualWorkspace(virtualWorkspaceId: string): boolean {
  const parsed = parseVirtualWorkspaceId(virtualWorkspaceId)
  return parsed !== null && parsed.targetHostId !== null
}
