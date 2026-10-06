import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { GitChangeItem, GitDiff, GitStatus } from '../shared/contracts/git.js'
import type { SessionChangedFiles } from '../shared/contracts/file-management.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCodingNsRpc } from './settings-bridge.js'
import { resolveGitWorkspaceId } from './git-management.js'
import { notifyGitWorkspaceChanged, subscribeGitWorkspaceChanged } from './git-workspace-events.js'
import { backdropPointerDownHandler } from './popup-dismiss.js'
import { resolveCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from './locale.js'

export const SESSION_CHANGED_FILES_VIEW_ID = 'codingns4dsh/session-changed-files'

interface SessionChangedFilesViewRegistration {
  readonly dispose: () => void
}

interface SessionChangedFilesViewProps {
  readonly sessionId: string
  readonly rpc: CodingNsRpcClient
  readonly remote?: unknown
  readonly reportCount?: (sessionId: string, count: number) => void
  /** 由 Slot inject 注入的 Codingns4DSH 词典翻译函数。 */
  readonly t: CodingNsTranslator
}

interface SessionChangedFilesCounterProps {
  readonly sessionId: string
  readonly rpc: CodingNsRpcClient
  readonly remote?: unknown
  readonly reportCount: (sessionId: string, count: number) => void
}

interface DirectoryNode {
  readonly kind: 'directory'
  readonly name: string
  readonly path: string
  readonly children: readonly TreeNode[]
}

interface FileNode {
  readonly kind: 'file'
  readonly name: string
  readonly change: GitChangeItem
}

type TreeNode = DirectoryNode | FileNode
interface MutableDirectory {
  kind: 'directory'
  name: string
  path: string
  children: Map<string, MutableDirectory | FileNode>
}

/** 后台轮询只负责兜底发现外部文件变化，不能和页面交互争夺刷新节奏。 */
const SESSION_CHANGED_FILES_BACKGROUND_REFRESH_MS = 30_000

/** 会话“修改文件”视图；数据只通过插件 RPC 和现有 Git RPC 读取。 */
export function SessionChangedFilesView(props: SessionChangedFilesViewProps): ReactElement {
  const t = props.t
  const compactLayout = useCompactLayout()
  const [workspaceId, setWorkspaceId] = useState<string>()
  const [changes, setChanges] = useState<readonly GitChangeItem[]>([])
  const [selectedPath, setSelectedPath] = useState<string>()
  const [diff, setDiff] = useState<GitDiff>()
  const [diffLoading, setDiffLoading] = useState(false)
  const [mobileDiffOpen, setMobileDiffOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [hoveredPath, setHoveredPath] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const requestGeneration = useRef(0)
  const inFlightLoad = useRef<Promise<void>>()

  const load = (foreground = false): Promise<void> => {
    // 同一轮请求尚未结束时，后续的定时器和本地通知只复用它，避免旧响应交错覆盖新状态。
    if (inFlightLoad.current !== undefined) return inFlightLoad.current
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    if (foreground) {
      setLoading(true)
      setError(undefined)
    }
    const task = (async (): Promise<void> => {
      try {
        const resolved = await resolveGitWorkspaceId(props.remote, props.sessionId)
        if (resolved === undefined) throw new Error('当前会话没有可用的工作区')
        const [sessionFiles, status] = await Promise.all([
          call<SessionChangedFiles>(props.rpc, 'fileManagement/session-changes', { sessionId: props.sessionId, workspaceId: resolved }),
          call<GitStatus>(props.rpc, 'git/status', { workspaceId: resolved }),
        ])
        if (generation !== requestGeneration.current) return
        const next = selectSessionChangedFiles(sessionFiles, status)
        setWorkspaceId((current) => current === resolved ? current : resolved)
        setChanges((current) => mergeChangedFiles(current, next))
        props.reportCount?.(props.sessionId, next.length)
        setSelectedPath((current) => current !== undefined && next.some((item) => item.path === current) ? current : next[0]?.path)
        setError(undefined)
      } catch (cause) {
        if (generation !== requestGeneration.current) return
        // 后台失败时保留上一次成功快照，避免网络抖动把列表闪成空白；首屏失败仍显示错误态。
        if (foreground) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setChanges([])
          setWorkspaceId(undefined)
          props.reportCount?.(props.sessionId, 0)
        } else {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (generation === requestGeneration.current && foreground) setLoading(false)
      }
    })()
    const tracked = task.finally(() => {
      if (inFlightLoad.current === tracked) inFlightLoad.current = undefined
    })
    inFlightLoad.current = tracked
    return tracked
  }

  useEffect(() => {
    setDiff(undefined)
    setDiffLoading(false)
    setMobileDiffOpen(false)
    setCollapsed(new Set())
    setWorkspaceId(undefined)
    void load(true)
    const timer = globalThis.setInterval(() => { void load() }, SESSION_CHANGED_FILES_BACKGROUND_REFRESH_MS)
    return () => {
      requestGeneration.current += 1
      inFlightLoad.current = undefined
      globalThis.clearInterval(timer)
    }
  }, [props.rpc, props.sessionId, props.remote])

  useEffect(() => {
    if (workspaceId === undefined) return
    return subscribeGitWorkspaceChanged(workspaceId, () => { void load() })
  }, [props.remote, props.rpc, props.sessionId, workspaceId])

  useEffect(() => {
    if (workspaceId === undefined || selectedPath === undefined) {
      setDiff(undefined)
      setDiffLoading(false)
      return
    }
    const selected = changes.find((item) => item.path === selectedPath)
    if (selected === undefined) {
      setDiff(undefined)
      setDiffLoading(false)
      return
    }
    let cancelled = false
    setDiff(undefined)
    setDiffLoading(true)
    void call<GitDiff>(props.rpc, 'git/diff', { workspaceId, path: selected.path, staged: selected.staged })
      .then((value) => { if (!cancelled) setDiff(value) })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (!cancelled) setDiffLoading(false) })
    return () => { cancelled = true }
  }, [changes, props.rpc, selectedPath, workspaceId])

  useEffect(() => {
    if (!compactLayout) setMobileDiffOpen(false)
    if (selectedPath === undefined || !changes.some((item) => item.path === selectedPath)) setMobileDiffOpen(false)
  }, [changes, compactLayout, selectedPath])

  const tree = useMemo(() => buildTree(changes), [changes])
  const unstaged = changes.filter((item) => !item.staged)
  const stageTargets = async (targets: readonly string[], action: 'stage' | 'unstage' | 'discard'): Promise<void> => {
    if (workspaceId === undefined || targets.length === 0) return
    setBusy(true)
    try {
      await call<GitStatus>(props.rpc, `git/${action}`, { workspaceId, targets })
      notifyGitWorkspaceChanged(workspaceId)
      await load(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const hasChanges = changes.length > 0
  const selectedChange = selectedPath === undefined ? undefined : changes.find((item) => item.path === selectedPath)
  const selectPath = (path: string): void => {
    setSelectedPath(path)
    if (compactLayout) setMobileDiffOpen(true)
  }
  const viewRootStyle: CSSProperties = { ...rootStyle, padding: compactLayout ? '0 16px' : rootStyle.padding }
  const viewToolbarStyle: CSSProperties = {
    ...toolbarStyle,
    padding: compactLayout ? '10px 0' : toolbarStyle.padding,
    borderBottom: hasChanges ? toolbarStyle.borderBottom : 'none',
  }
  const viewContentStyle: CSSProperties = { ...contentStyle, gridTemplateColumns: compactLayout ? '1fr' : contentStyle.gridTemplateColumns }
  const viewTreePaneStyle: CSSProperties = {
    ...treePaneStyle,
    borderRight: compactLayout || !hasChanges ? 'none' : treePaneStyle.borderRight,
    borderBottom: compactLayout && hasChanges ? treePaneStyle.borderRight : 'none',
  }

  return createElement('div', { style: viewRootStyle },
    createElement('div', { style: viewToolbarStyle },
      createElement('strong', { style: { fontSize: 15 } }, t('sessionFiles.title')),
      createElement('span', { style: countStyle }, t('sessionFiles.count', { count: changes.length })),
      createElement('span', { style: { flex: 1 } }),
      createElement('button', { type: 'button', disabled: loading || busy, onClick: () => void load(true), style: toolbarRefreshButtonStyle, title: t('sessionFiles.refresh'), 'aria-label': t('sessionFiles.refresh') },
        createElement(RefreshIcon)),
      createElement('button', { type: 'button', disabled: busy || unstaged.length === 0, onClick: () => void stageTargets(unstaged.map((item) => item.path), 'stage'), style: toolbarStageButtonStyle, title: t('sessionFiles.stageAll'), 'aria-label': t('sessionFiles.stageAll') },
        createElement(StageIcon)),
    ),
    error === undefined ? null : createElement('div', { role: 'alert', style: errorStyle }, error),
    createElement('div', { style: viewContentStyle },
      createElement('div', { style: viewTreePaneStyle },
        loading ? createElement('div', { style: emptyStyle }, t('sessionFiles.loading'))
          : changes.length === 0 ? createElement('div', { style: emptyStyle }, t('sessionFiles.empty'))
            : tree.map((node) => renderNode(node, 0, collapsed, hoveredPath, selectedPath, toggle, selectPath, setHoveredPath, stageTargets, t)),
      ),
      !compactLayout && hasChanges ? createElement('div', { style: diffPaneStyle },
        selectedPath === undefined ? createElement('div', { style: emptyStyle }, t('sessionFiles.selectFile'))
          : diffLoading ? createElement('div', { style: emptyStyle }, t('sessionFiles.loadingDiff'))
            : diff?.content ? createElement('pre', { style: diffStyle }, renderDiff(diff.content))
            : createElement('div', { style: emptyStyle }, t('sessionFiles.noDiff')),
      ) : null,
    ),
    compactLayout && mobileDiffOpen && selectedPath !== undefined ? createElement('div', {
      style: mobileDiffOverlayStyle,
      onPointerDown: backdropPointerDownHandler(() => setMobileDiffOpen(false)),
    }, createElement('section', {
      role: 'dialog',
      'aria-modal': true,
      'aria-label': selectedChange?.path ?? t('sessionFiles.title'),
      style: mobileDiffModalStyle,
    },
    createElement('header', { style: mobileDiffHeaderStyle },
      createElement('strong', { style: mobileDiffTitleStyle, title: selectedChange?.path }, selectedChange?.path ?? t('sessionFiles.title')),
      createElement('button', { type: 'button', onClick: () => setMobileDiffOpen(false), style: mobileDiffCloseStyle, title: t('sessionFiles.close'), 'aria-label': t('sessionFiles.close') }, '×'),
    ),
    createElement('div', { style: mobileDiffBodyStyle },
      diffLoading ? createElement('div', { style: emptyStyle }, t('sessionFiles.loadingDiff'))
        : diff?.content ? createElement('pre', { style: diffStyle }, renderDiff(diff.content))
          : createElement('div', { style: emptyStyle }, t('sessionFiles.noDiff')),
    ),
    )) : null,
  )
}

/** 注册 DSH 原生 conversation.view Slot；标签由 DSH 根据 Slot 的 id/label 自动投影。 */
export function registerSessionChangedFilesView(
  ctx: unknown,
  rpc: CodingNsRpcClient,
  remote?: unknown,
  locale?: CodingNsLocale,
): (() => void) | undefined {
  const runtime = globalThis as typeof globalThis & {
    __CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__?: SessionChangedFilesViewRegistration
  }
  // DSH 热重启可能先保留旧 Context 的 Slot；复用旧注册避免 id 冲突。
  if (runtime.__CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__ !== undefined) return undefined
  const value = asRecord(ctx)
  const slots = value?.slots as SessionChangedFilesSlotRegistry | undefined
  if (typeof slots?.inject !== 'function' || typeof slots.register !== 'function') return undefined
  // 同进程内换 Context 重建时，旧 Slot 账本可能仍然登记着同一个 id；先读账本再决定
  // 是否注册，避免依赖宿主异常文案（0.2.0 起错误只描述 list/keyed/single 单元格冲突）。
  if (isSlotIdRegistered(slots, 'conversation.view', SESSION_CHANGED_FILES_VIEW_ID)) return undefined
  if (isSlotIdRegistered(slots, 'conversation.session.header.actions', `${SESSION_CHANGED_FILES_VIEW_ID}/counter`)) return undefined
  const t = resolveCodingNsTranslator(locale)
  let disposeSlot: (() => void) | undefined
  let disposeCounterSlot: (() => void) | undefined
  let disposed = false
  let labelSessionId: string | undefined
  let labelCount = 0
  const reportCount = (sessionId: string, count: number): void => {
    if (disposed || (labelSessionId === sessionId && labelCount === count)) return
    labelSessionId = sessionId
    labelCount = count
    // DSH 标签的 label 是字符串快照；重新登记同一个 Slot 触发标签列表刷新。
    const previous = disposeSlot
    disposeSlot = undefined
    previous?.()
    try {
      disposeSlot = registerSlot()
    } catch (error) {
      console.warn('codingns4dsh: 修改文件标签数量刷新失败', error)
    }
  }
  function registerSlot(): () => void {
    return slots!.inject!('conversation.view', () => {
      // 必须通过 SlotRegistry 实例调用 register，保留其 Cordis 调用上下文。
      return slots!.register!({
        name: 'conversation.view',
        id: SESSION_CHANGED_FILES_VIEW_ID,
        order: 100,
        label: () => t('sessionFiles.tabLabel', { count: labelCount }),
        inject: () => ({ rpc, remote, reportCount, t }),
      }, SessionChangedFilesView)
    })
  }
  function registerCounterSlot(): () => void {
    return slots!.inject!('conversation.session.header.actions', () => slots!.register!({
      name: 'conversation.session.header.actions',
      id: `${SESSION_CHANGED_FILES_VIEW_ID}/counter`,
      order: 1000,
      inject: () => ({ rpc, remote, reportCount }),
    }, SessionChangedFilesCounter))
  }
  try {
    disposeSlot = registerSlot()
    disposeCounterSlot = registerCounterSlot()
  } catch (error) {
    disposeSlot?.()
    disposeCounterSlot?.()
    throw error
  }
  const dispose = (): void => {
    disposed = true
    disposeSlot?.()
    disposeCounterSlot?.()
    if (runtime.__CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__?.dispose === dispose) {
      delete runtime.__CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__
    }
  }
  runtime.__CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__ = { dispose }
  return dispose
}

interface SessionChangedFilesSlotRegistry {
  inject?: (key: string, callback: () => unknown) => (() => void)
  register?: (options: unknown, component: unknown) => () => void
  /**
   * SlotRegistry 的账本读取接口。
   *
   * 只在版本提供时使用：缺失时退化为直接注册，由全局注册标记兜底。
   */
  entries?: (key: string) => readonly { readonly options?: { readonly id?: string } }[]
}

/** 按账本中的稳定 id 判断某个 Slot 是否已经登记，不再解析宿主异常文案。 */
function isSlotIdRegistered(
  slots: SessionChangedFilesSlotRegistry,
  name: string,
  id: string,
): boolean {
  const entries = slots.entries?.(name)
  return Array.isArray(entries) && entries.some((entry) => entry.options?.id === id)
}

function SessionChangedFilesCounter(props: SessionChangedFilesCounterProps): null {
  useEffect(() => {
    let disposed = false
    let generation = 0
    let hasSuccessfulLoad = false
    let subscribedWorkspaceId: string | undefined
    let inFlight: Promise<void> | undefined
    let disposeWorkspaceSubscription: (() => void) | undefined
    const updateWorkspaceSubscription = (workspaceId: string | undefined): void => {
      if (subscribedWorkspaceId === workspaceId) return
      disposeWorkspaceSubscription?.()
      subscribedWorkspaceId = workspaceId
      disposeWorkspaceSubscription = workspaceId === undefined
        ? undefined
        : subscribeGitWorkspaceChanged(workspaceId, () => { void load() })
    }
    const load = (): Promise<void> => {
      if (inFlight !== undefined) return inFlight
      const currentGeneration = ++generation
      const task = (async (): Promise<void> => {
        try {
          const workspaceId = await resolveGitWorkspaceId(props.remote, props.sessionId)
          if (workspaceId === undefined) throw new Error('当前会话没有可用的工作区')
          const [sessionFiles, status] = await Promise.all([
            call<SessionChangedFiles>(props.rpc, 'fileManagement/session-changes', { sessionId: props.sessionId, workspaceId }),
            call<GitStatus>(props.rpc, 'git/status', { workspaceId }),
          ])
          if (disposed || currentGeneration !== generation) return
          updateWorkspaceSubscription(workspaceId)
          const count = selectSessionChangedFiles(sessionFiles, status).length
          hasSuccessfulLoad = true
          props.reportCount(props.sessionId, count)
        } catch {
          // 计数器只在首轮失败时归零，后台短暂失败不能让标题反复跳回 0。
          if (!disposed && currentGeneration === generation && !hasSuccessfulLoad) props.reportCount(props.sessionId, 0)
        }
      })()
      const tracked = task.finally(() => { if (inFlight === tracked) inFlight = undefined })
      inFlight = tracked
      return tracked
    }
    void load()
    const timer = globalThis.setInterval(() => { void load() }, SESSION_CHANGED_FILES_BACKGROUND_REFRESH_MS)
    return () => {
      disposed = true
      generation += 1
      inFlight = undefined
      globalThis.clearInterval(timer)
      disposeWorkspaceSubscription?.()
    }
  }, [props.remote, props.rpc, props.reportCount, props.sessionId])
  return null
}

function renderDiff(content: string): readonly ReactElement[] {
  const lines = content.split('\n')
  return lines.map((line, index) => createElement('span', {
    key: index,
    style: diffLineStyle(line),
  }, `${line}${index < lines.length - 1 ? '\n' : ''}`))
}

/** 只替换真正变化的行对象，后台刷新时保持未变化文件的引用和交互状态。 */
function mergeChangedFiles(current: readonly GitChangeItem[], next: readonly GitChangeItem[]): readonly GitChangeItem[] {
  if (current.length === next.length && current.every((item, index) => sameChange(item, next[index]))) return current
  const previous = new Map(current.map((item) => [item.path, item] as const))
  return next.map((item) => {
    const old = previous.get(item.path)
    return old !== undefined && sameChange(old, item) ? old : item
  })
}

function sameChange(left: GitChangeItem | undefined, right: GitChangeItem | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.path === right.path
    && left.status === right.status
    && left.staged === right.staged
    && left.oldPath === right.oldPath
    && left.binary === right.binary
    && left.stagedStatus === right.stagedStatus
    && left.worktreeStatus === right.worktreeStatus
}

/** 只显示当前 Git 状态中仍属于本会话触及范围的文件。 */
export function selectSessionChangedFiles(sessionFiles: SessionChangedFiles, status: GitStatus): readonly GitChangeItem[] {
  const touched = new Set(sessionFiles.paths.map(normalizePath))
  return status.changes.filter((item) => touched.has(normalizePath(item.path)) || item.oldPath !== null && touched.has(normalizePath(item.oldPath)))
}

function RefreshIcon(): ReactElement {
  return createElement('svg', { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
    createElement('path', { d: 'M16 8.5A6.2 6.2 0 1 0 16.1 12', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
    createElement('path', { d: 'M16 4.5v4h-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

function StageIcon(): ReactElement {
  return createElement('svg', { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
    createElement('path', { d: 'M4 13.5v2h12v-2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    createElement('path', { d: 'M10 14V4.5m0 0L6.8 7.7M10 4.5l3.2 3.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  )
}

function diffLineStyle(line: string): CSSProperties {
  if (line.startsWith('+++') || line.startsWith('---')) return diffHeaderLineStyle
  if (line.startsWith('+')) return diffAddedLineStyle
  if (line.startsWith('-')) return diffRemovedLineStyle
  if (line.startsWith('@@')) return diffHunkLineStyle
  return diffContextLineStyle
}

function renderNode(
  node: TreeNode,
  depth: number,
  collapsed: ReadonlySet<string>,
  hoveredPath: string | undefined,
  selectedPath: string | undefined,
  toggle: (path: string) => void,
  select: (path: string) => void,
  hover: (path: string | undefined) => void,
  stageTargets: (targets: readonly string[], action: 'stage' | 'unstage' | 'discard') => Promise<void>,
  t: CodingNsTranslator,
): ReactElement {
  if (node.kind === 'directory') {
    const expanded = !collapsed.has(node.path)
    const files = flattenFiles(node)
    return createElement('div', { key: `directory:${node.path}` },
      createElement('div', { style: rowStyle(depth), onMouseEnter: () => hover(node.path), onMouseLeave: () => hover(undefined) },
        createElement('button', { type: 'button', onClick: () => toggle(node.path), style: treeButtonStyle },
          createElement('span', { style: treeChevronStyle }, expanded ? '⌄' : '›'),
          createElement('span', { style: folderIconStyle }, '▰'),
          createElement('span', { style: fileNameStyle, title: node.path }, node.name),
          createElement('span', { style: mutedCountStyle }, String(files.length)),
        ),
        hoveredPath === node.path ? createElement('button', { type: 'button', title: t('sessionFiles.stageDirectory'), disabled: files.every((item) => item.staged), onClick: () => void stageTargets(files.filter((item) => !item.staged).map((item) => item.path), 'stage'), style: iconButtonStyle }, '+') : null,
      ),
      expanded ? createElement('div', null, node.children.map((child) => renderNode(child, depth + 1, collapsed, hoveredPath, selectedPath, toggle, select, hover, stageTargets, t))) : null,
    )
  }
  const item = node.change
  const isHovered = hoveredPath === item.path
  return createElement('div', { key: `file:${item.path}`, style: { ...rowStyle(depth), ...(selectedPath === item.path ? selectedRowStyle : {}) }, onMouseEnter: () => hover(item.path), onMouseLeave: () => hover(undefined) },
    createElement('button', { type: 'button', onClick: () => select(item.path), style: fileButtonStyle },
      createElement('span', { style: fileIconStyle }, fileIcon(node.name)),
      createElement('span', { style: fileNameStyle, title: item.path }, node.name),
      createElement('span', { style: statusStyle }, item.status),
    ),
    isHovered ? createElement('span', { style: actionsStyle },
      createElement('button', { type: 'button', title: item.staged ? t('sessionFiles.unstage') : t('sessionFiles.stage'), onClick: () => void stageTargets([item.path], item.staged ? 'unstage' : 'stage'), style: iconButtonStyle }, item.staged ? '↶' : '+'),
      createElement('button', { type: 'button', title: t('sessionFiles.discard'), disabled: item.staged, onClick: () => void stageTargets([item.path], 'discard'), style: dangerButtonStyle }, '×'),
    ) : null,
  )
}

function buildTree(changes: readonly GitChangeItem[]): readonly TreeNode[] {
  const root = new Map<string, MutableDirectory | FileNode>()
  for (const change of changes) {
    const parts = normalizePath(change.path).split('/').filter(Boolean)
    let entries = root
    let currentPath = ''
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const key = index === parts.length - 1 ? `file:${currentPath}` : `directory:${currentPath}`
      if (index === parts.length - 1) entries.set(key, { kind: 'file', name: part, change })
      else {
        const existing = entries.get(key)
        const directory: MutableDirectory = existing?.kind === 'directory'
          ? existing
          : { kind: 'directory', name: part, path: currentPath, children: new Map() }
        entries.set(key, directory)
        entries = directory.children
      }
    })
  }
  return sortNodes(finalizeTree([...root.values()]))
}

function finalizeTree(nodes: readonly (MutableDirectory | FileNode)[]): TreeNode[] {
  return nodes.map((node) => node.kind === 'directory'
    ? { kind: 'directory', name: node.name, path: node.path, children: finalizeTree([...node.children.values()]) }
    : node)
}

function sortNodes(nodes: readonly TreeNode[]): readonly TreeNode[] {
  return [...nodes].sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name, 'zh-CN') : left.kind === 'directory' ? -1 : 1).map((node) => node.kind === 'directory' ? { ...node, children: sortNodes(node.children) } : node)
}

function flattenFiles(node: DirectoryNode): readonly GitChangeItem[] {
  return node.children.flatMap((child) => child.kind === 'directory' ? flattenFiles(child) : [child.change])
}

function normalizePath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '') }
function fileIcon(name: string): string { return name.includes('.') ? '·' : '□' }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined }
async function call<T>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> { return await callCodingNsRpc<T>(rpc, endpoint, payload) }

function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches === true)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 700px)')
    const update = (): void => setCompact(media.matches)
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return compact
}

const rootStyle: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', height: 'auto', minHeight: '100%', overflow: 'visible', padding: '0 64px', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary,inherit)', background: 'var(--dsw-alias-bg-base,transparent)', fontSize: 13 }
const toolbarStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', maxWidth: 1280, boxSizing: 'border-box', padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l3,#ddd)', flex: '0 0 auto' }
const countStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary,#777)' }
const contentStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '3.5fr 6.5fr', width: '100%', maxWidth: 1280, flex: '0 0 auto', minHeight: 0 }
const treePaneStyle: CSSProperties = { padding: '8px 0', borderRight: '1px solid var(--dsw-alias-border-l3,#ddd)' }
const diffPaneStyle: CSSProperties = { minWidth: 0, background: 'var(--dsw-alias-bg-layer-1,transparent)' }
const rowStyle = (depth: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 7, minHeight: 28, padding: `0 8px 0 ${8 + depth * 14}px`, fontSize: 12 })
const treeButtonStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0, minHeight: 28, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left', padding: 0, fontWeight: 600 }
const fileButtonStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left', flex: 1, minWidth: 0, padding: 0 }
const selectedRowStyle: CSSProperties = { background: 'var(--dsw-alias-interactive-bg-selected,rgba(80,120,200,.16))' }
const fileIconStyle: CSSProperties = { width: 12, color: 'var(--dsw-alias-label-tertiary,#777)', fontSize: 12, textAlign: 'center', flex: '0 0 12px' }
const treeChevronStyle: CSSProperties = { width: 12, color: 'var(--dsw-alias-label-tertiary,#777)', fontSize: 12, flex: '0 0 12px' }
const folderIconStyle: CSSProperties = { color: 'var(--dsw-alias-state-business-primary,#356ae6)', fontSize: 11, flex: '0 0 auto' }
const fileNameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }
const statusStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary,#777)', flex: '0 0 auto', fontWeight: 700 }
const mutedCountStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary,#777)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }
const actionsStyle: CSSProperties = { display: 'inline-flex', gap: 2, flex: '0 0 auto' }
const iconButtonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, border: 0, borderRadius: 4, padding: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary,#777)', cursor: 'pointer', fontSize: 16 }
const dangerButtonStyle: CSSProperties = { ...iconButtonStyle, color: 'var(--dsw-alias-state-danger,#c43d3d)' }
const toolbarIconButtonStyle: CSSProperties = { ...iconButtonStyle, width: 36, height: 36, border: '1px solid var(--dsw-alias-border-l2,#ccc)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))', boxShadow: '0 1px 2px rgba(0,0,0,.12)', fontSize: 18 }
const toolbarRefreshButtonStyle: CSSProperties = { ...toolbarIconButtonStyle, color: 'var(--dsw-alias-state-business-primary,#356ae6)' }
const toolbarStageButtonStyle: CSSProperties = { ...toolbarIconButtonStyle, color: 'var(--dsw-alias-state-success,#18864b)' }
const emptyStyle: CSSProperties = { padding: 24, color: 'var(--dsw-alias-label-tertiary,#777)', textAlign: 'center' }
const errorStyle: CSSProperties = { padding: '8px 16px', color: 'var(--dsw-alias-state-danger,#c43d3d)', borderBottom: '1px solid var(--dsw-alias-border-l3,#ddd)' }
const diffStyle: CSSProperties = { margin: 0, padding: 16, minHeight: '100%', overflow: 'visible', whiteSpace: 'pre-wrap', wordBreak: 'break-word', font: '12px/1.55 var(--dsw-font-mono,ui-monospace,monospace)' }
const mobileDiffOverlayStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'stretch', justifyContent: 'center', padding: 10, boxSizing: 'border-box', background: 'rgba(0,0,0,.48)' }
const mobileDiffModalStyle: CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 720, maxHeight: '100%', minHeight: 0, overflow: 'hidden', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1,#fff)', boxShadow: '0 12px 40px rgba(0,0,0,.3)' }
const mobileDiffHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 46, padding: '0 12px', borderBottom: '1px solid var(--dsw-alias-border-l3,#ddd)', flex: '0 0 auto' }
const mobileDiffTitleStyle: CSSProperties = { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }
const mobileDiffCloseStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, border: 0, borderRadius: 6, padding: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary,#777)', cursor: 'pointer', fontSize: 22, lineHeight: 1 }
const mobileDiffBodyStyle: CSSProperties = { minHeight: 0, overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1,transparent)' }
const diffHeaderLineStyle: CSSProperties = { display: 'block', color: 'var(--dsw-alias-label-tertiary,#777)' }
const diffHunkLineStyle: CSSProperties = { display: 'block', color: 'var(--dsw-alias-state-business-primary,#356ae6)', background: 'rgba(53,106,230,.08)' }
const diffAddedLineStyle: CSSProperties = { display: 'block', color: '#137333', background: 'rgba(34,197,94,.12)' }
const diffRemovedLineStyle: CSSProperties = { display: 'block', color: '#b42318', background: 'rgba(220,38,38,.12)' }
const diffContextLineStyle: CSSProperties = { display: 'block' }
