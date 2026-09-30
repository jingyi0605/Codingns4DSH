import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { GitBranchSnapshot, GitChangeItem, GitCommitChangedFile, GitCommitDiff, GitDiff, GitHistoryItem, GitHistoryOrigin, GitHistoryRef, GitHistoryScope, GitStatus } from '../shared/contracts/git.js'
import type { CodingNsClientFeatureModule, CodingNsRpcClient, CodingNsRpcResult } from './features/types.js'
import { buildHistoryGraph, GRAPH_DASH_ARRAY, GRAPH_LANE_WIDTH, GRAPH_ROW_HEIGHT, laneCenterX, laneColor, laneStroke, laneDashed, isUnpushed, segmentStroke } from './git-history-graph.js'
import type { GitGraphLane, GitGraphRow } from './git-history-graph.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { backdropPointerDownHandler, useDismissOnOutsidePointer } from './popup-dismiss.js'
import { debugWarn } from '../shared/debug.js'
import { dshSettingsToastStyle, dshThemeColor } from './theme.js'
import { gitPanelClass, installGitPanelStyles } from './git-panel-styles.js'
import type { SettingsNotice } from './features/types.js'

// 单列 Git 视图需要一个稳定的分段控件；这里保持 React 结构简单，避免引入额外依赖。
function SegmentedControl<Value extends string>({ id, value, options, onChange, label, disabled }: { readonly id: string; readonly value: Value; readonly options: readonly { readonly value: Value; readonly label: string; readonly title?: string; readonly disabled?: boolean }[]; readonly onChange: (next: Value) => void; readonly label: string; readonly disabled?: boolean }): ReactElement {
  const index = Math.max(0, options.findIndex((option) => option.value === value))
  return createElement('div', { role: 'tablist', 'aria-label': label, className: gitPanelClass.segmented, style: { '--dsh-segment-count': options.length, '--dsh-segment-index': index } as CSSProperties },
    createElement('span', { 'aria-hidden': 'true', className: gitPanelClass.segmentedIndicator }),
    ...options.map((option) => createElement('button', {
      key: option.value, type: 'button', role: 'tab', id: `${id}-${option.value}`, 'aria-selected': option.value === value,
      tabIndex: option.value === value ? 0 : -1, disabled: disabled === true || option.disabled === true,
      className: gitPanelClass.segment, title: option.title, onClick: () => onChange(option.value),
    }, option.label)),
  )
}

export const GIT_PROVIDER_ID = 'codingns4dsh/git'
export const GIT_KIND = 'git'
const INITIAL_HISTORY_LIMIT = 50
const HISTORY_PAGE_SIZE = 100
/** 兼容早期调用方使用的面板标识；实际注册已迁移到右侧 Sidebar。 */
export const GIT_PANEL_ID = GIT_PROVIDER_ID

type GitTabProps = {
  readonly sessionId: string
  readonly useTabInfo: UseSidebarRightTabInfo
  readonly rpc: CodingNsRpcClient
  readonly remote?: unknown
}
type GitTabTitleProps = { readonly useTabInfo: UseSidebarRightTabInfo }
type GitServices = { readonly rpc: CodingNsRpcClient; readonly remote?: unknown }
type GitOperation = 'fetch' | 'pull' | 'push' | 'undo' | 'refresh'

function gitOperationLabel(operation: GitOperation): string {
  return operation === 'fetch' ? 'Fetch' : operation === 'pull' ? 'Pull' : operation === 'push' ? 'Push' : operation === 'undo' ? '撤销提交' : '刷新'
}

interface GitSidebarTab {
  readonly id: string
  readonly kind: string
  readonly contentId?: string
}

interface GitSidebarOpenTabs {
  readonly getSnapshot: () => readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[]
  readonly subscribe?: (listener: () => void) => () => void
}

interface GitSidebarRuntime {
  readonly openTabs?: GitSidebarOpenTabs
  readonly tabsIn?: (sessionId: string) => readonly GitSidebarTab[]
  readonly openTabIn?: (sessionId: string, kind: string) => void
  readonly closeIn?: (sessionId: string, tabId: string) => void
  readonly registerCloseHandler?: (kind: string, handler: (sessionId: string, tab: GitSidebarTab) => void) => () => void
}

interface GitPanelCache {
  readonly status: GitStatus
  readonly history: readonly GitHistoryItem[]
  readonly historyTotalCount: number
  readonly branches: GitBranchSnapshot | null
}

interface GitWorkspaceRecoveryProps {
  readonly useSessions: UseSessions
  readonly remote?: unknown
  readonly sidebarRight: GitSidebarRuntime
}

interface GitTreeDirectory {
  readonly kind: 'directory'
  readonly name: string
  readonly path: string
  readonly children: readonly GitTreeNode[]
}

interface GitTreeFile {
  readonly kind: 'file'
  readonly name: string
  readonly path: string
  readonly item: GitChangeItem
}

type GitTreeNode = GitTreeDirectory | GitTreeFile

interface MutableGitTreeDirectory {
  readonly kind: 'directory'
  readonly name: string
  readonly path: string
  readonly children: Map<string, MutableGitTreeDirectory | GitTreeFile>
}

/** 注册 DSH 右侧 Sidebar 的 Git 标签类型，数据按 Workspace 复用。 */
export function registerGitManagementUi(ctx: Context, services: GitServices): () => void {
  const disposers: Array<() => void> = []
  disposers.push(installGitPanelStyles())
  const sidebarRight = ctx.sidebarRight as typeof ctx.sidebarRight & GitSidebarRuntime
  try {
    disposers.push(ctx.sidebarRightTabs.register({
      id: GIT_PROVIDER_ID,
      kind: GIT_KIND,
      multiple: false,
      priority: 'extension',
      title: () => 'Git',
      guide: [{ id: 'git', order: 40, title: () => 'Git', description: () => '查看改动、提交和版本历史', icon: GitPanelIcon }],
    }))
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: GIT_PROVIDER_ID,
      inject: () => ({ rpc: services.rpc, remote: services.remote }),
    }, GitPanel)))
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: GIT_PROVIDER_ID,
    }, GitTabTitle)))
    disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'codingns4dsh-git-workspace-recovery', order: 990,
      inject: () => ({ remote: services.remote, sidebarRight }),
    }, GitWorkspaceRecovery)))
    if (typeof sidebarRight.registerCloseHandler === 'function') {
      disposers.push(sidebarRight.registerCloseHandler(GIT_KIND, (sessionId, tab) => closeGitWorkspaceTabs(sidebarRight, services.remote, sessionId, tab)))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    if (isDuplicateGitRegistration(error)) {
      debugWarn(`codingns4dsh: Git Sidebar 已注册，跳过重复注册: ${GIT_PROVIDER_ID}`)
      return () => {}
    }
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function isDuplicateGitRegistration(error: unknown): boolean {
  return error instanceof Error && /sidebarRight: (?:tab type id|tab kind) .* already registered/u.test(error.message)
}

function GitPanelIcon({ size = 16 }: { readonly size?: number | undefined }): ReactElement {
  return createElement('span', {
    title: 'Git 仓库管理', 'aria-label': 'Git 仓库管理', style: { display: 'inline-flex', width: size, height: size, alignItems: 'center', justifyContent: 'center', color: dshThemeColor.labelSecondary, fontSize: Math.max(12, size - 2), fontWeight: 700 },
  }, '⑂')
}

function GitTabTitle({ useTabInfo }: GitTabTitleProps): ReactElement {
  useTabInfo()
  return createElement('span', { title: 'Git 仓库管理', 'aria-label': 'Git 仓库管理', style: tabTitleStyle }, 'Git')
}

function GitPanel(props: GitTabProps): ReactElement {
  const sessionId = String(props.sessionId)
  const tabInfo = props.useTabInfo()
  const [workspaceId, setWorkspaceId] = useState<string | undefined>()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [history, setHistory] = useState<readonly GitHistoryItem[]>([])
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [subject, setSubject] = useState('')
  const [busy, setBusy] = useState(false)
  const [activeOperation, setActiveOperation] = useState<GitOperation | null>(null)
  const [toast, setToast] = useState<SettingsNotice | null>(null)
  const [diffView, setDiffView] = useState<GitCommitDiff | null>(null)
  const [fileDiff, setFileDiff] = useState<{ readonly path: string; readonly staged: boolean; readonly diff: GitDiff } | null>(null)
  const [singleColumn, setSingleColumn] = useState(false)
  const [activeColumn, setActiveColumn] = useState<'files' | 'history'>('files')
  const [historyScope, setHistoryScope] = useState<GitHistoryScope>('all')
  const [historyTotalCount, setHistoryTotalCount] = useState(0)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const contentGridRef = useRef<HTMLDivElement | null>(null)
  const historyExpanded = useRef(false)
  const gridVisible = status !== null && status.snapshot.enabled !== false

  useEffect(() => {
    if (toast === null) return
    const timer = globalThis.setTimeout(() => setToast(null), 3200)
    return () => globalThis.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const element = contentGridRef.current
    if (element === null) { setSingleColumn(false); return }
    const update = (): void => {
      const tracks = getComputedStyle(element).gridTemplateColumns.split(' ').filter((track) => track !== '')
      setSingleColumn(tracks.length <= 1)
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [gridVisible])

  const notify = (kind: SettingsNotice['kind'], message: string): void => setToast({ kind, message })

  useEffect(() => {
    let disposed = false
    let cleanupTimer: (() => void) | undefined
    setToast(null)
    setWorkspaceId(undefined)
    setStatus(null)
    setHistory([])
    setHistoryTotalCount(0)
    historyExpanded.current = false
    setBranches(null)
    setDiffView(null)
    setFileDiff(null)
    const load = async (resolvedWorkspaceId: string): Promise<void> => {
      const cached = readCache(resolvedWorkspaceId)
      // 已经手动展开历史后，定时刷新只能更新状态和分支，不能用首屏缓存覆盖已加载的分页。
      if (cached !== null && !historyExpanded.current) { setStatus(cached.status); setHistory(cached.history); setHistoryTotalCount(cached.historyTotalCount); setBranches(cached.branches) }
      try {
        const nextStatus = await call<GitStatus>(props.rpc, 'git/status', { workspaceId: resolvedWorkspaceId })
        if (disposed) return
        if (nextStatus.snapshot.enabled === false) {
          setStatus(nextStatus); setHistory([]); setHistoryTotalCount(0); setBranches(null); writeCache(resolvedWorkspaceId, { status: nextStatus, history: [], historyTotalCount: 0, branches: null }); setToast(null)
          return
        }
        const [nextHistory, nextBranches] = await Promise.all([
          historyExpanded.current ? Promise.resolve(null) : call<{ items: readonly GitHistoryItem[]; totalCount: number }>(props.rpc, 'git/history', { workspaceId: resolvedWorkspaceId, limit: INITIAL_HISTORY_LIMIT, offset: 0, scope: historyScope }),
          call<GitBranchSnapshot>(props.rpc, 'git/branches', { workspaceId: resolvedWorkspaceId }),
        ])
        if (disposed) return
        const normalizedBranches = normalizeBranchSnapshot(nextBranches)
        if (nextHistory !== null) { setHistory(nextHistory.items); setHistoryTotalCount(nextHistory.totalCount); writeCache(resolvedWorkspaceId, { status: nextStatus, history: nextHistory.items, historyTotalCount: nextHistory.totalCount, branches: normalizedBranches }) }
        setStatus(nextStatus); setBranches(normalizedBranches)
      } catch (error) {
        if (!disposed) notify('error', error instanceof Error ? error.message : String(error))
      }
    }
    void resolveGitWorkspaceId(props.remote, sessionId).then((resolvedWorkspaceId) => {
      if (disposed) return
      if (resolvedWorkspaceId === undefined) { notify('error', '当前没有可用的工作区'); return }
      rememberGitWorkspaceSession(sessionId, resolvedWorkspaceId)
      writeGitWorkspaceOpen(resolvedWorkspaceId, true)
      setWorkspaceId(resolvedWorkspaceId)
      void load(resolvedWorkspaceId)
      const timer = globalThis.setInterval(() => { void load(resolvedWorkspaceId) }, 5_000)
      cleanupTimer = () => globalThis.clearInterval(timer)
    }).catch((error: unknown) => { if (!disposed) notify('error', error instanceof Error ? error.message : String(error)) })
    return () => { disposed = true; cleanupTimer?.() }
  }, [props.remote, props.rpc, sessionId, historyScope])

  useEffect(() => {
    const close = (): void => {
      if (!tabInfo.tab.signal.aborted) return
      const resolvedWorkspaceId = workspaceBySession.get(sessionId)
      if (resolvedWorkspaceId !== undefined) writeGitWorkspaceOpen(resolvedWorkspaceId, false)
    }
    if (tabInfo.tab.signal.aborted) close()
    else tabInfo.tab.signal.addEventListener('abort', close, { once: true })
    return () => tabInfo.tab.signal.removeEventListener('abort', close)
  }, [sessionId, tabInfo.tab.signal])

  const run = async (action: string, payload: Record<string, unknown>, onSuccess?: (value: unknown) => void, operation?: GitOperation): Promise<void> => {
    if (workspaceId === undefined) { notify('error', '当前没有可用的工作区'); return }
    setBusy(true)
    if (operation !== undefined) {
      setActiveOperation(operation)
      setToast({ kind: 'info', message: `正在${gitOperationLabel(operation)}…` })
    } else {
      setToast(null)
    }
    const targetWorkspaceId = workspaceId
    const preserveExpandedHistory = action === 'git/status' && historyExpanded.current
    if (!preserveExpandedHistory) historyExpanded.current = false
    try {
      const value = await call(props.rpc, action, { workspaceId: targetWorkspaceId, ...payload })
      onSuccess?.(value)
      const nextStatus = await call<GitStatus>(props.rpc, 'git/status', { workspaceId: targetWorkspaceId })
      setStatus(nextStatus)
      if (nextStatus.snapshot.enabled !== false) {
        const [nextHistory, nextBranches] = await Promise.all([
          preserveExpandedHistory ? Promise.resolve(null) : call<{ items: readonly GitHistoryItem[]; totalCount: number }>(props.rpc, 'git/history', { workspaceId: targetWorkspaceId, limit: INITIAL_HISTORY_LIMIT, offset: 0, scope: historyScope }),
          call<GitBranchSnapshot>(props.rpc, 'git/branches', { workspaceId: targetWorkspaceId }),
        ])
        const normalizedBranches = normalizeBranchSnapshot(nextBranches)
        if (nextHistory !== null) { setHistory(nextHistory.items); setHistoryTotalCount(nextHistory.totalCount); writeCache(targetWorkspaceId, { status: nextStatus, history: nextHistory.items, historyTotalCount: nextHistory.totalCount, branches: normalizedBranches }) }
        setBranches(normalizedBranches)
      } else {
        setHistory([]); setHistoryTotalCount(0); setBranches(null); writeCache(targetWorkspaceId, { status: nextStatus, history: [], historyTotalCount: 0, branches: null })
      }
      notify('success', operation === undefined ? '操作已完成' : `${gitOperationLabel(operation)}已完成`)
    }
    catch (error) { notify('error', error instanceof Error ? error.message : String(error)) }
    finally {
      setBusy(false)
      if (operation !== undefined) {
        setActiveOperation(null)
      }
    }
  }

  const commit = (): void => {
    const value = subject.trim()
    if (!value) { notify('error', '请输入提交说明'); return }
    void run('git/commit', { subject: value }, () => setSubject(''))
  }
  const copyCommitHash = (commitHash: string): void => {
    void copyText(commitHash).then((copied) => notify(copied ? 'success' : 'error', copied ? 'Git 版本号已复制' : '当前环境不支持复制'))
  }
  const copyCommitMessage = (value: string): void => {
    void copyText(value).then((copied) => notify(copied ? 'success' : 'error', copied ? '提交信息已复制' : '当前环境不支持复制'))
  }
  const openCommitDiff = (commitHash: string): void => {
    if (workspaceId === undefined) return
    setBusy(true)
    notify('info', '正在读取提交 Diff…')
    void call<GitCommitDiff>(props.rpc, 'git/commit-diff', { workspaceId, commitHash }).then((value) => {
      setDiffView(value)
      setToast(null)
    }).catch((error: unknown) => notify('error', error instanceof Error ? error.message : String(error))).finally(() => setBusy(false))
  }
  const openFileDiff = (path: string, staged: boolean): void => {
    if (workspaceId === undefined) return
    setBusy(true)
    notify('info', '正在读取文件 Diff…')
    void call<GitDiff>(props.rpc, 'git/diff', { workspaceId, path, staged }).then((value) => {
      setFileDiff({ path, staged, diff: value })
      setToast(null)
    }).catch((error: unknown) => notify('error', error instanceof Error ? error.message : String(error))).finally(() => setBusy(false))
  }
  const loadMoreHistory = (): void => {
    if (workspaceId === undefined || historyLoadingMore || history.length >= historyTotalCount) return
    setHistoryLoadingMore(true)
    historyExpanded.current = true
    void call<{ items: readonly GitHistoryItem[]; totalCount: number }>(props.rpc, 'git/history', { workspaceId, limit: HISTORY_PAGE_SIZE, offset: history.length, scope: historyScope }).then((page) => {
      setHistory((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.commitHash === item.commitHash))])
      setHistoryTotalCount(page.totalCount)
    }).catch((error: unknown) => { historyExpanded.current = history.length > INITIAL_HISTORY_LIMIT; notify('error', error instanceof Error ? error.message : String(error)) }).finally(() => setHistoryLoadingMore(false))
  }
  const changes = status?.changes ?? []
  const staged = changes.filter((item) => hasStagedChanges(item))
  const unstaged = changes.filter((item) => hasUnstagedChanges(item))
  const runGitOperation = (action: GitOperation): void => {
    if (action === 'refresh') { void run('git/status', {}, (value) => setStatus(value as GitStatus), action); return }
    void run(`git/${action}`, {}, undefined, action)
  }
  const stageAll = (): void => { void run('git/stage', { targets: unstaged.map((item) => item.path) }) }
  const discardAll = (): void => { void run('git/discard', { targets: changes.map((item) => item.path) }) }
  return createElement('section', { style: panelStyle, 'data-git-management-panel': 'true' },
    // 面板标题已由 Sidebar 标签页渲染，这里不再重复；只保留视图切换与操作菜单。
    createElement('header', { style: headerStyle },
      singleColumn ? createElement('div', { style: columnSwitchStyle },
        createElement(SegmentedControl<'files' | 'history'>, {
          id: 'codingns4dsh-git-view', value: activeColumn, onChange: setActiveColumn, label: '切换文件与版本视图',
          options: [
            { value: 'files', label: '切换文件', title: '切换文件' },
            { value: 'history', label: '切换版本', title: '切换版本' },
          ],
        }),
      ) : null,
      createElement('div', { style: headerActionsStyle },
        createElement(GitOperationsMenu, { busy, activeOperation, hasRemote: Boolean(status?.snapshot.hasRemote || branches?.remote.length), canUndo: history.length > 0, hasMoreVersions: history.length < historyTotalCount, stagedCount: staged.length, unstagedCount: unstaged.length, onStageAll: stageAll, onDiscardAll: discardAll, onLoadMore: loadMoreHistory, onOperation: runGitOperation }),
      ),
    ),
    toast === null ? null : createElement('div', { role: toast.kind === 'error' ? 'alert' : 'status', 'aria-live': 'polite', style: { ...dshSettingsToastStyle, position: 'absolute', top: 8, right: 'auto', left: '50%', transform: 'translateX(-50%)', width: 'min(300px, calc(100% - 24px))', pointerEvents: 'none', borderColor: toast.kind === 'error' ? dshThemeColor.error : toast.kind === 'success' ? dshThemeColor.success : dshThemeColor.border } }, toast.message),
    status === null ? createElement('div', { style: emptyStyle }, '正在读取 Git 状态…') : null,
    status !== null && status.snapshot.enabled === false ? createElement('section', { style: sectionStyle },
      createElement('strong', undefined, '当前目录还没有 Git 仓库'),
      createElement('div', { style: mutedStyle }, '初始化后即可查看改动、提交和版本历史。'),
      createElement('button', { type: 'button', disabled: busy, onClick: () => void run('git/init', {}), className: `${gitPanelClass.button} ${gitPanelClass.buttonPrimary}`, style: primaryButtonStyle }, '初始化 Git'),
    ) : null,
    status !== null ? createElement('div', { style: summaryStyle }, `${staged.length} 个已暂存 · ${unstaged.length} 个未暂存 · ${historyTotalCount} 条提交（${historyScope === 'all' ? '全部分支' : '当前分支'}）`) : null,
    diffView !== null ? createElement(DiffViewer, { diff: diffView, onClose: () => setDiffView(null) }) : null,
    fileDiff !== null ? createElement(FileDiffViewer, { path: fileDiff.path, staged: fileDiff.staged, diff: fileDiff.diff, onClose: () => setFileDiff(null) }) : null,
    status !== null && status.snapshot.enabled !== false ? createElement('div', { ref: contentGridRef, style: contentGridStyle },
      singleColumn && activeColumn !== 'files' ? null : createElement('div', { style: columnStyle },
        createElement('section', { style: commitSectionStyle },
          createElement('div', { style: sectionHeaderStyle },
            createElement('strong', undefined, '提交更改'),
            createElement('span', { style: mutedStyle }, staged.length === 0 ? '暂存区为空' : `${staged.length} 个已暂存`),
          ),
          createElement('div', { style: commitEditorRowStyle },
            createElement('textarea', { value: subject, disabled: busy || workspaceId === undefined, className: gitPanelClass.field, onChange: (event: { currentTarget: { value: string } }) => setSubject(event.currentTarget.value), onKeyDown: (event: { key: string; preventDefault: () => void }) => { if (event.key === 'Enter') event.preventDefault() }, placeholder: '在这里输入提交信息', rows: 1, style: commitSubjectStyle }),
            createElement('button', { type: 'button', disabled: busy || workspaceId === undefined, onClick: () => notify('info', '生成提交信息功能暂未开放'), className: `${gitPanelClass.button} ${gitPanelClass.field}`, style: draftButtonStyle, title: '生成提交信息', 'aria-label': '生成提交信息' }, '✦'),
          ),
          createElement('div', { style: commitActionsStyle },
            createElement('button', { type: 'button', disabled: busy || workspaceId === undefined, onClick: () => void run('git/status', {}, (value) => setStatus(value as GitStatus)), className: `${gitPanelClass.button} ${gitPanelClass.field}`, style: refreshActionStyle }, '刷新'),
            createElement('button', { type: 'button', disabled: busy || workspaceId === undefined || staged.length === 0 || subject.trim().length === 0, onClick: commit, className: `${gitPanelClass.button} ${gitPanelClass.buttonPrimary}`, style: submitActionStyle }, '提交'),
          ),
        ),
        staged.length > 0 ? createElement(ChangeSection, { title: '暂存文件', items: staged, busy, onOpenDiff: openFileDiff, onAction: (action, path) => void run(`git/${action}`, { targets: [path] }), onBatchAction: (action, paths) => void run(`git/${action}`, { targets: paths }), onBulkAction: () => void run('git/unstage', { targets: staged.map((item) => item.path) }) }) : null,
        unstaged.length > 0 ? createElement(ChangeSection, { title: '未提交文件', items: unstaged, busy, onOpenDiff: openFileDiff, onAction: (action, path) => void run(`git/${action}`, { targets: [path] }), onBatchAction: (action, paths) => void run(`git/${action}`, { targets: paths }), onBulkAction: () => void run('git/stage', { targets: unstaged.map((item) => item.path) }) }) : null,
      ),
      singleColumn && activeColumn !== 'history' ? null : createElement('div', { style: columnStyle },
        createElement(HistorySection, { history, totalCount: historyTotalCount, hasMore: history.length < historyTotalCount, loadingMore: historyLoadingMore, onLoadMore: loadMoreHistory, branches, busy, scope: historyScope, hasRemote: Boolean(status?.snapshot.hasRemote || branches?.remote.length), onScopeChange: setHistoryScope, onSwitch: (branchName) => void run('git/switch', { branchName, create: false }, (value) => setBranches(normalizeBranchSnapshot(value as GitBranchSnapshot))), onCopy: copyCommitHash, onCopyMessage: copyCommitMessage, onViewDiff: openCommitDiff, onUndo: () => runGitOperation('undo') }),
      ),
    ) : null,
  )
}

function ChangeSection({ title, items, busy, onOpenDiff, onAction, onBatchAction, onBulkAction }: { readonly title: string; readonly items: readonly GitChangeItem[]; readonly busy: boolean; readonly onOpenDiff: (path: string, staged: boolean) => void; readonly onAction: (action: 'stage' | 'unstage' | 'discard', path: string) => void; readonly onBatchAction: (action: 'stage' | 'unstage' | 'discard', paths: readonly string[]) => void; readonly onBulkAction: () => void }): ReactElement {
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)
  const nodes = buildChangeTree(items)
  const staged = title === '暂存文件'
  const renderNode = (node: GitTreeNode, depth: number): ReactElement => {
    if (node.kind === 'directory') {
      const directoryKey = `dir:${node.path}`
      const directoryTargets = collectTreeTargets(node)
      const isHovered = hoveredPath === directoryKey
      return createElement('details', { key: `dir:${node.path}`, open: true, style: treeDirectoryStyle },
        createElement('summary', { className: gitPanelClass.row, style: { ...treeRowStyle, paddingLeft: 8 + depth * 14 }, onMouseEnter: () => setHoveredPath(directoryKey), onMouseLeave: () => setHoveredPath(null) },
          createElement('span', { style: treeChevronStyle }, '⌄'), createElement('span', { style: folderIconStyle }, '▰'), createElement('span', { style: fileNameStyle, title: node.path }, node.name), createElement('span', { style: mutedStyle }, countTreeFiles(node)),
          isHovered ? createElement('div', { style: rowActionsStyle },
            createElement('button', { type: 'button', disabled: busy, onClick: (event: { stopPropagation: () => void; preventDefault: () => void }) => { event.preventDefault(); event.stopPropagation(); onBatchAction(staged ? 'unstage' : 'stage', directoryTargets) }, className: gitPanelClass.action, style: iconActionStyle, title: staged ? '撤销目录暂存' : '将目录添加到暂存区', 'aria-label': staged ? '撤销目录暂存' : '将目录添加到暂存区' }, staged ? '↶' : '+'),
            !staged ? createElement('button', { type: 'button', disabled: busy, onClick: (event: { stopPropagation: () => void; preventDefault: () => void }) => { event.preventDefault(); event.stopPropagation(); onBatchAction('discard', directoryTargets) }, className: `${gitPanelClass.action} ${gitPanelClass.actionDanger}`, style: iconActionStyle, title: '撤销目录变更', 'aria-label': '撤销目录变更' }, '×') : null,
          ) : null,
        ),
        createElement('div', undefined, ...node.children.map((child) => renderNode(child, depth + 1))),
      )
    }
    const isHovered = hoveredPath === node.path
    return createElement('div', { key: `file:${node.path}`, className: gitPanelClass.row, style: { ...treeRowStyle, paddingLeft: 28 + depth * 14 }, onMouseEnter: () => setHoveredPath(node.path), onMouseLeave: () => setHoveredPath(null), onDoubleClick: () => onOpenDiff(node.path, staged) },
      createElement('span', { style: fileIconStyle }, fileIcon(node.name)),
      createElement('span', { title: node.path, style: fileNameStyle }, node.name),
      createElement('span', { style: fileStatusStyle }, changeStatus(node.item, staged)),
      isHovered ? createElement('div', { style: rowActionsStyle },
        createElement('button', { type: 'button', disabled: busy, onClick: () => onAction(staged ? 'unstage' : 'stage', node.path), className: gitPanelClass.action, style: iconActionStyle, title: staged ? '撤销暂存' : '添加到暂存区', 'aria-label': staged ? '撤销暂存' : '添加到暂存区' }, staged ? '↶' : '+'),
        !staged ? createElement('button', { type: 'button', disabled: busy, onClick: () => onAction('discard', node.path), className: `${gitPanelClass.action} ${gitPanelClass.actionDanger}`, style: iconActionStyle, title: '撤销变更', 'aria-label': '撤销变更' }, '×') : null,
      ) : null,
    )
  }
  return createElement('section', { style: sectionStyle },
    createElement('div', { style: sectionHeaderStyle }, createElement('strong', undefined, `${title} (${items.length})`), createElement('button', { type: 'button', disabled: busy, onClick: onBulkAction, className: gitPanelClass.action, style: iconActionStyle, title: staged ? '取消全部暂存' : '全部添加到暂存区', 'aria-label': staged ? '取消全部暂存' : '全部添加到暂存区' }, staged ? '↶' : '+')),
    createElement('div', { style: treeStyle }, ...nodes.map((node) => renderNode(node, 0))),
  )
}

function GitOperationsMenu({ busy, activeOperation, hasRemote, canUndo, hasMoreVersions, stagedCount, unstagedCount, onStageAll, onDiscardAll, onLoadMore, onOperation }: { readonly busy: boolean; readonly activeOperation: GitOperation | null; readonly hasRemote: boolean; readonly canUndo: boolean; readonly hasMoreVersions: boolean; readonly stagedCount: number; readonly unstagedCount: number; readonly onStageAll: () => void; readonly onDiscardAll: () => void; readonly onLoadMore: () => void; readonly onOperation: (action: GitOperation) => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(rootRef, open, () => setOpen(false))
  // 菜单项统一在点击后收起；关闭动作与具体操作解耦，避免每个按钮各写一次。
  const run = (action: () => void): (() => void) => () => { setOpen(false); action() }
  const operationText = activeOperation === null ? null : `${gitOperationLabel(activeOperation)}进行中…`
  const operationBadge = operationText === null ? null : createElement('span', { role: 'status', 'aria-live': 'polite', style: operationStatusStyle }, createElement('span', { className: gitPanelClass.progress, 'aria-hidden': 'true' }, '⟳'), operationText)
  return createElement('div', { ref: rootRef, style: menuStyle },
    operationBadge,
    createElement('button', { type: 'button', disabled: busy, className: gitPanelClass.menuTrigger, style: iconActionStyle, title: 'Git 操作菜单', 'aria-label': 'Git 操作菜单', 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen((value) => !value) }, '⋯'),
    open && createElement('div', { role: 'menu', 'aria-label': 'Git 操作菜单', className: gitPanelClass.menu, style: menuPopupStyle },
      createElement('button', { type: 'button', role: 'menuitem', disabled: busy || unstagedCount === 0, onClick: run(onStageAll), className: gitPanelClass.menuItem, style: menuItemStyle }, '暂存全部'),
      createElement('button', { type: 'button', role: 'menuitem', disabled: busy || stagedCount + unstagedCount === 0, onClick: run(onDiscardAll), className: `${gitPanelClass.menuItem} ${gitPanelClass.menuItemDanger}`, style: menuItemStyle }, '放弃全部改动'),
      createElement('button', { type: 'button', role: 'menuitem', disabled: busy || !hasRemote, onClick: run(() => onOperation('fetch')), className: gitPanelClass.menuItem, style: menuItemStyle }, 'Fetch'),
      createElement('button', { type: 'button', role: 'menuitem', disabled: busy || !hasRemote, 'aria-busy': activeOperation === 'pull', onClick: run(() => onOperation('pull')), className: gitPanelClass.menuItem, style: menuItemStyle }, activeOperation === 'pull' ? '⟳ Pull 进行中…' : 'Pull'),
      // 工作区有未提交改动不影响已提交对象的 Push；Git Push 只发送提交记录。
      createElement('button', { type: 'button', role: 'menuitem', disabled: busy || !hasRemote, 'aria-busy': activeOperation === 'push', onClick: run(() => onOperation('push')), className: gitPanelClass.menuItem, style: menuItemStyle }, activeOperation === 'push' ? '⟳ Push 进行中…' : 'Push'),
      createElement('button', { type: 'button', role: 'menuitem', disabled: busy || !hasMoreVersions, onClick: run(onLoadMore), className: gitPanelClass.menuItem, style: menuItemStyle, title: '查看所有版本' }, '查看更多版本（每次 100 条）'),
      createElement('button', { type: 'button', role: 'menuitem', disabled: busy || !canUndo, onClick: run(() => onOperation('undo')), className: gitPanelClass.menuItem, style: menuItemStyle }, '撤销上次提交'),
      createElement('button', { type: 'button', role: 'menuitem', disabled: busy, onClick: run(() => onOperation('refresh')), className: gitPanelClass.menuItem, style: menuItemStyle }, '刷新'),
    ),
  )
}

interface ParsedDiffLine {
  readonly kind: 'context' | 'add' | 'remove' | 'hunk' | 'meta'
  readonly text: string
  readonly oldLineNo: number | null
  readonly newLineNo: number | null
}

function DiffViewer({ diff, onClose }: { readonly diff: GitCommitDiff; readonly onClose: () => void }): ReactElement {
  const providedFiles = diff.files ?? []
  const files = providedFiles.length > 0 ? providedFiles : parseDiffFiles(diff.content)
  return createElement('div', { style: diffOverlayStyle, onPointerDown: backdropPointerDownHandler(onClose) },
    createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '提交 Diff', style: diffStyle },
      createElement('div', { style: sectionHeaderStyle }, createElement('strong', undefined, `提交 Diff · ${diff.commitHash.slice(0, 8)}`), createElement('button', { type: 'button', onClick: onClose, className: gitPanelClass.action, style: iconActionStyle, title: '关闭 Diff', 'aria-label': '关闭 Diff' }, '×')),
      createElement('div', { style: diffBodyStyle },
        createElement('section', { style: diffFilesSectionStyle },
          createElement('div', { style: diffSectionHeaderStyle }, createElement('strong', undefined, '变更文件'), createElement('span', { style: diffCountStyle }, String(files.length))),
          files.length === 0 ? createElement('div', { style: diffEmptyStyle }, '没有检测到文件变更。') : createElement('div', { style: diffFileListStyle }, ...files.map((file) => createElement('div', { key: `${file.status}:${file.oldPath ?? ''}:${file.path}`, style: diffFileRowStyle }, createElement('span', { style: diffFileStatusStyle, 'data-status': file.status }, diffFileStatusLabel(file.status)), createElement('div', { style: diffFileNameStyle }, createElement('strong', undefined, file.path), file.oldPath ? createElement('span', { style: diffFileOldPathStyle }, `原路径：${file.oldPath}`) : null), file.binary ? createElement('span', { style: diffBinaryStyle }, '二进制') : null))),
        ),
        createElement('section', { style: diffDiffSectionStyle },
          createElement('div', { style: diffSectionHeaderStyle }, createElement('strong', undefined, 'Diff'), diff.truncated ? createElement('span', { style: diffTruncatedStyle }, '内容已截断') : null),
          createElement(DiffLines, { content: diff.content }),
        ),
      ),
    ),
  )
}

function DiffLines({ content }: { readonly content: string }): ReactElement {
  const lines = parseDiffLines(content)
  if (lines.length === 0) return createElement('div', { style: diffEmptyStyle }, '当前没有可显示的文本差异。')
  return createElement('div', { style: diffLinesStyle }, ...lines.map((line, index) => createElement('div', { key: `${index}:${line.kind}:${line.text}`, style: diffLineStyle(line.kind) }, createElement('span', { style: diffLineNumberStyle }, line.oldLineNo === null ? '' : String(line.oldLineNo)), createElement('span', { style: diffLineNumberStyle }, line.newLineNo === null ? '' : String(line.newLineNo)), createElement('code', { style: diffCodeStyle }, `${diffLinePrefix(line.kind)}${line.text}`))))
}

function FileDiffViewer({ path, staged, diff, onClose }: { readonly path: string; readonly staged: boolean; readonly diff: GitDiff; readonly onClose: () => void }): ReactElement {
  return createElement('div', { style: diffOverlayStyle, onPointerDown: backdropPointerDownHandler(onClose) },
    createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '文件 Diff', style: diffStyle },
      createElement('div', { style: sectionHeaderStyle },
        createElement('strong', { style: fileDiffTitleStyle, title: path }, `文件 Diff · ${path}`),
        createElement('div', { style: rowActionsStyle },
          createElement('span', { style: diffCountStyle }, staged ? '已暂存' : '未暂存'),
          createElement('button', { type: 'button', onClick: onClose, className: gitPanelClass.action, style: iconActionStyle, title: '关闭 Diff', 'aria-label': '关闭 Diff' }, '×'),
        ),
      ),
      createElement('div', { style: diffBodyStyle },
        createElement('section', { style: diffDiffSectionStyle },
          createElement('div', { style: diffSectionHeaderStyle },
            createElement('strong', undefined, staged ? '暂存区 Diff（相对 HEAD）' : '工作区 Diff'),
            diff.binary ? createElement('span', { style: diffBinaryStyle }, '二进制文件') : null,
            diff.truncated ? createElement('span', { style: diffTruncatedStyle }, '内容已截断') : null,
          ),
          createElement(DiffLines, { content: diff.content }),
        ),
      ),
    ),
  )
}

function parseDiffLines(content: string): readonly ParsedDiffLine[] {
  const lines: ParsedDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const rawLine of content.replace(/\r\n/gu, '\n').split('\n')) {
    if (rawLine.startsWith('diff --git') || rawLine.startsWith('index ') || rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
      lines.push({ kind: 'meta', text: rawLine, oldLineNo: null, newLineNo: null })
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(rawLine)
    if (hunk !== null) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2])
      lines.push({ kind: 'hunk', text: rawLine, oldLineNo: null, newLineNo: null })
      continue
    }
    if (rawLine.startsWith(' ') || rawLine === '') {
      lines.push({ kind: 'context', text: rawLine.slice(1), oldLineNo: oldLine, newLineNo: newLine }); oldLine += 1; newLine += 1; continue
    }
    if (rawLine.startsWith('+')) {
      lines.push({ kind: 'add', text: rawLine.slice(1), oldLineNo: null, newLineNo: newLine }); newLine += 1; continue
    }
    if (rawLine.startsWith('-')) {
      lines.push({ kind: 'remove', text: rawLine.slice(1), oldLineNo: oldLine, newLineNo: null }); oldLine += 1; continue
    }
    lines.push({ kind: 'meta', text: rawLine, oldLineNo: null, newLineNo: null })
  }
  return lines
}

function parseDiffFiles(content: string): readonly GitCommitChangedFile[] {
  const result: GitCommitChangedFile[] = []
  for (const line of content.split(/\r?\n/u)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
    if (match === null) continue
    const path = match[2] ?? match[1] ?? ''
    if (path === '' || result.some((file) => file.path === path)) continue
    result.push({ path, oldPath: match[1] === path ? null : match[1] ?? null, status: 'M', binary: false })
  }
  return result
}

function diffFileStatusLabel(status: string): string { return status === 'A' ? '新增' : status === 'D' ? '删除' : status === 'R' ? '重命名' : status === 'C' ? '复制' : '修改' }
function diffLinePrefix(kind: ParsedDiffLine['kind']): string { return kind === 'add' ? '+' : kind === 'remove' ? '-' : kind === 'context' ? ' ' : '' }
/** Diff 行的配色与 DSH 内置 DiffBlock 完全对齐：同一组状态色 + 行底色 + 左侧 3px 色条。 */
function diffLineStyle(kind: ParsedDiffLine['kind']): CSSProperties {
  if (kind === 'add') return { ...diffLineBaseStyle, color: dshThemeColor.success, background: dshThemeColor.diffAddedBackground, boxShadow: `inset 3px 0 0 ${dshThemeColor.success}` }
  if (kind === 'remove') return { ...diffLineBaseStyle, color: dshThemeColor.error, background: dshThemeColor.diffDeletedBackground, boxShadow: `inset 3px 0 0 ${dshThemeColor.error}` }
  if (kind === 'hunk') return { ...diffLineBaseStyle, color: dshThemeColor.accent, background: dshThemeColor.surfaceSubtle, fontWeight: 600 }
  if (kind === 'meta') return { ...diffLineBaseStyle, color: dshThemeColor.labelTertiary }
  return diffLineBaseStyle
}

function HistorySection({ history, totalCount, hasMore, loadingMore, onLoadMore, branches, busy, scope, hasRemote, onScopeChange, onSwitch, onCopy, onCopyMessage, onViewDiff, onUndo }: { readonly history: readonly GitHistoryItem[]; readonly totalCount: number; readonly hasMore: boolean; readonly loadingMore: boolean; readonly onLoadMore: () => void; readonly branches: GitBranchSnapshot | null; readonly busy: boolean; readonly scope: GitHistoryScope; readonly hasRemote: boolean; readonly onScopeChange: (scope: GitHistoryScope) => void; readonly onSwitch: (branchName: string) => void; readonly onCopy: (commitHash: string) => void; readonly onCopyMessage: (message: string) => void; readonly onViewDiff: (commitHash: string) => void; readonly onUndo: () => void }): ReactElement {
  const graph = buildHistoryGraph(history)
  const graphWidth = graph.laneCount * GRAPH_LANE_WIDTH
  const rows: ReactElement[] = []
  for (const group of groupHistoryByDate(history)) {
    const firstIndex = group.items[0]?.index ?? 0
    rows.push(createElement('div', { key: `date:${group.key}`, style: historyDateHeaderStyle },
      createElement(GitGraphRails, { lanes: graph.rows[firstIndex]?.top ?? [], width: graphWidth, minHeight: 16 }),
      createElement('time', { dateTime: group.key, style: historyDateHeaderTextStyle }, group.label),
    ))
    for (const { item, index, timeLabel } of group.items) {
      rows.push(createElement(HistoryGraphRow, {
        key: item.commitHash, item, timeLabel, row: graph.rows[index] ?? EMPTY_GRAPH_ROW, width: graphWidth,
        busy, hasRemote, isHead: hasHeadRef(item), onCopy, onCopyMessage, onViewDiff, onUndo,
      }))
    }
  }
  return createElement('section', { style: sectionStyle },
    createElement('div', { style: sectionHeaderStyle },
      createElement('strong', { title: '提交图：彩色实线＝泳道（分支拓扑），蓝色虚线＝尚未推送到远程的提交；鼠标悬浮节点可看该提交的归属与分支' }, `Git 版本 (${totalCount})`),
      createElement('div', { style: historyHeaderActionsStyle },
        createElement('select', {
          value: scope, disabled: busy, className: gitPanelClass.select, style: scopeSelectStyle, title: '版本范围：只列当前分支，或列出全部本地分支与远程跟踪分支', 'aria-label': '版本范围',
          onChange: (event: { currentTarget: { value: string } }) => onScopeChange(event.currentTarget.value === 'all' ? 'all' : 'head'),
        },
        createElement('option', { value: 'head' }, '当前分支'),
        createElement('option', { value: 'all' }, '全部分支'),
        ),
        branches === null ? null : createElement('select', { value: branches.currentBranch, disabled: busy, className: gitPanelClass.select, style: branchSelectStyle, title: '切换分支', 'aria-label': '切换分支', onChange: (event: { currentTarget: { value: string } }) => onSwitch(event.currentTarget.value) }, ...branches.local.map((branch) => createElement('option', { key: branch.name, value: branch.name }, branch.name))),
      ),
    ),
    history.length === 0
      ? createElement('div', { style: mutedStyle }, '暂无提交')
      // 行间不能留间距：每行的竖线只画到行底，一旦行与行之间有缝隙，泳道就会断成一段一段。
      : createElement('div', { style: historyListStyle }, ...rows),
    hasMore ? createElement('button', { type: 'button', disabled: busy || loadingMore, onClick: onLoadMore, className: `${gitPanelClass.button} ${gitPanelClass.field}`, style: loadMoreButtonStyle }, loadingMore ? '正在加载…' : '查看更多版本（每次 100 条）') : null,
  )
}

const EMPTY_GRAPH_ROW: GitGraphRow = { lane: 0, color: 0, through: [], merges: [], branches: [], top: [], bottom: [] }

function HistoryGraphRow({ item, timeLabel, row, width, busy, hasRemote, isHead, onCopy, onCopyMessage, onViewDiff, onUndo }: { readonly item: GitHistoryItem; readonly timeLabel: string; readonly row: GitGraphRow; readonly width: number; readonly busy: boolean; readonly hasRemote: boolean; readonly isHead: boolean; readonly onCopy: (commitHash: string) => void; readonly onCopyMessage: (message: string) => void; readonly onViewDiff: (commitHash: string) => void; readonly onUndo: () => void }): ReactElement {
  const refs = sortHistoryRefs(item.refs ?? [])
  const nodeTitle = describeCommitNode(item, refs, hasRemote)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useDismissOnOutsidePointer(menuRef, menuOpen, () => setMenuOpen(false))
  const runMenu = (action: () => void): (() => void) => () => { setMenuOpen(false); action() }
  return createElement('div', { className: gitPanelClass.row, style: historyRowStyle },
    createElement('div', { style: { ...graphGutterStyle, width }, 'aria-hidden': 'true' },
      createElement(GitGraphTrack, { row, width, head: isHead, title: nodeTitle }),
      refs.length === 0 ? null : createElement(GitGraphRails, { lanes: row.bottom, width, fill: true }),
    ),
    createElement('div', { style: historyRowBodyStyle },
      createElement('div', { style: historyRowMainStyle },
        createElement('code', { style: hashStyle }, item.commitHash.slice(0, 8)),
        createElement('span', { style: fileNameStyle, title: item.subject }, item.subject),
        createElement('time', {
          style: historyTimeStyle, dateTime: item.authoredAt,
          title: item.authorName === '' ? item.authoredAt : `${item.authoredAt} · 作者 ${item.authorName}`,
        }, timeLabel),
        createElement('div', { ref: menuRef, style: menuStyle },
          createElement('button', { type: 'button', className: gitPanelClass.menuTrigger, style: iconActionStyle, title: '版本操作菜单', 'aria-label': '版本操作菜单', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, onClick: () => setMenuOpen((value) => !value) }, '⋯'),
          menuOpen && createElement('div', { role: 'menu', 'aria-label': '版本操作菜单', className: gitPanelClass.menu, style: menuPopupStyle },
            createElement('button', { type: 'button', role: 'menuitem', onClick: runMenu(() => onViewDiff(item.commitHash)), className: gitPanelClass.menuItem, style: menuItemStyle }, '查看更改文件与 Diff'),
            createElement('button', { type: 'button', role: 'menuitem', onClick: runMenu(() => onCopy(item.commitHash)), className: gitPanelClass.menuItem, style: menuItemStyle }, '复制 Commit Hash'),
            createElement('button', { type: 'button', role: 'menuitem', onClick: runMenu(() => onCopyMessage(buildCommitMessageText(item.subject, item.body))), className: gitPanelClass.menuItem, style: menuItemStyle }, '复制提交信息'),
            createElement('button', { type: 'button', role: 'menuitem', onClick: runMenu(() => onCopy(item.commitHash)), className: gitPanelClass.menuItem, style: menuItemStyle }, '复制 Git 版本号'),
            isHead ? createElement('button', { type: 'button', role: 'menuitem', disabled: busy, onClick: runMenu(onUndo), className: `${gitPanelClass.menuItem} ${gitPanelClass.menuItemDanger}`, style: menuItemStyle }, '撤销上次提交') : null,
          ),
        ),
      ),
      refs.length === 0 ? null : createElement('div', { style: historyRefListStyle }, ...refs.map((ref) => createElement('span', { key: `${ref.kind}:${ref.name}`, title: refTitle(ref), className: gitPanelClass.ref, style: historyRefPillStyle(ref.kind, ref.remoteName) }, `${refGlyph(ref.kind)} ${ref.name}`))),
    ),
  )
}

/** 标签顺序对齐 VS Code：当前分支 → 本地分支 → 远程分支 → 标签，同一提交的多个引用顺序稳定。 */
function sortHistoryRefs(refs: readonly GitHistoryRef[]): readonly GitHistoryRef[] {
  const rank = (kind: GitHistoryRef['kind']): number => kind === 'head' ? 0 : kind === 'local' ? 1 : kind === 'remote' ? 2 : 3
  return [...refs].sort((left, right) => rank(left.kind) - rank(right.kind) || left.name.localeCompare(right.name))
}

/** 未推送的线段画虚线：颜色说明「是谁的提交」，线型说明「还没进任何远程」。 */
function dashProps(origin: GitHistoryOrigin | undefined): { readonly strokeDasharray?: string } {
  return isUnpushed(origin) ? { strokeDasharray: GRAPH_DASH_ARRAY } : {}
}

/** 提交节点与它这一行的连线；坐标按 GRAPH_ROW_HEIGHT 计算，与主行高度严格对齐。 */
function GitGraphTrack({ row, width, head, title }: { readonly row: GitGraphRow; readonly width: number; readonly head: boolean; readonly title: string | null }): ReactElement {
  const mid = GRAPH_ROW_HEIGHT / 2
  const nodeX = laneCenterX(row.lane)
  // 节点保持泳道色：颜色负责拓扑，蓝虚线负责「未推送」，两者不互相覆盖。
  const color = laneColor(row.color)
  const children: ReactElement[] = []
  if (row.top.some((lane) => lane.lane === row.lane)) {
    children.push(createElement('line', { key: 'node-in', x1: nodeX, y1: 0, x2: nodeX, y2: mid, stroke: segmentStroke(row.incomingOrigin, row.color), strokeWidth: 1.5, ...dashProps(row.incomingOrigin) }))
  }
  for (const lane of row.through) {
    const x = laneCenterX(lane.lane)
    children.push(createElement('line', { key: `through:${lane.lane}`, x1: x, y1: 0, x2: x, y2: GRAPH_ROW_HEIGHT, stroke: laneStroke(lane), strokeWidth: 1.5, ...dashProps(lane.origin) }))
  }
  for (const merge of row.merges) {
    const x = laneCenterX(merge.lane)
    children.push(createElement('path', { key: `merge:${merge.lane}`, d: `M ${x} 0 C ${x} 5 ${nodeX} ${mid - 5} ${nodeX} ${mid}`, fill: 'none', stroke: laneStroke(merge), strokeWidth: 1.5, strokeLinecap: 'round', ...dashProps(merge.origin) }))
  }
  for (const branch of row.branches) {
    const x = laneCenterX(branch.lane)
    if (branch.lane === row.lane) children.push(createElement('line', { key: `branch:${branch.lane}`, x1: x, y1: mid, x2: x, y2: GRAPH_ROW_HEIGHT, stroke: laneStroke(branch), strokeWidth: 1.5, ...dashProps(branch.origin) }))
    else children.push(createElement('path', { key: `branch:${branch.lane}`, d: `M ${nodeX} ${mid} C ${nodeX} ${mid + 5} ${x} ${GRAPH_ROW_HEIGHT - 5} ${x} ${GRAPH_ROW_HEIGHT}`, fill: 'none', stroke: laneStroke(branch), strokeWidth: 1.5, strokeLinecap: 'round', ...dashProps(branch.origin) }))
  }
  // 与 VS Code 一致：普通提交是实心圆点，当前提交（HEAD）是带外环的靶心，一眼可辨。
  const nodeTitle = title === null ? undefined : createElement('title', { key: 'node-title' }, title)
  if (head) {
    children.push(createElement('circle', { key: 'head-ring', cx: nodeX, cy: mid, r: 6, fill: 'none', stroke: color, strokeWidth: 1.5 }))
    children.push(createElement('circle', { key: 'node', cx: nodeX, cy: mid, r: 3, fill: color, stroke: dshThemeColor.menuBackground, strokeWidth: 1.5 }, nodeTitle))
  } else {
    children.push(createElement('circle', { key: 'node', cx: nodeX, cy: mid, r: 3.6, fill: color, stroke: dshThemeColor.menuBackground, strokeWidth: 1.5 }, nodeTitle))
  }
  return createElement('svg', { width, height: GRAPH_ROW_HEIGHT, viewBox: `0 0 ${width} ${GRAPH_ROW_HEIGHT}`, 'aria-hidden': 'true', style: graphTrackStyle }, ...children)
}

/** 只画竖直贯穿线：日期分隔行与分支标签行用它延续泳道，避免提交图被行高切断。 */
function GitGraphRails({ lanes, width, minHeight, fill = false }: { readonly lanes: readonly GitGraphLane[]; readonly width: number; readonly minHeight?: number; readonly fill?: boolean }): ReactElement {
  return createElement('div', { style: { ...graphRailsStyle, width, ...(minHeight === undefined ? {} : { minHeight }), ...(fill ? { flex: '1 1 auto' } : {}) }, 'aria-hidden': 'true' },
    ...lanes.map((lane) => createElement('span', { key: lane.lane, style: graphRailStyle(lane.lane, laneStroke(lane), laneDashed(lane)) })),
  )
}

function hasHeadRef(item: GitHistoryItem): boolean {
  return (item.refs ?? []).some((ref) => ref.kind === 'head')
}

function refGlyph(kind: GitHistoryRef['kind']): string {
  return kind === 'head' ? '●' : kind === 'remote' ? '☁' : kind === 'tag' ? '⚑' : '⑂'
}

function refTitle(ref: GitHistoryRef): string {
  const kind = ref.kind === 'head' ? '当前分支' : ref.kind === 'remote' ? '远程分支' : ref.kind === 'tag' ? '标签' : '本地分支'
  return `${kind}：${ref.name}`
}

/** 归属不单独显示文字，只作为节点 tooltip：颜色与虚实已经表达了归属，说明放在悬浮提示里。 */
function describeCommitOrigin(origin: GitHistoryOrigin | undefined, hasRemote: boolean): string | null {
  if (origin === undefined) return null
  if (origin === 'local') return hasRemote ? '本地提交：只在本地分支上，尚未推送到远程（蓝色虚线）' : '本地提交：只在本地分支上（当前仓库没有远程，蓝色虚线）'
  if (origin === 'synced') return '已同步：当前分支与远程跟踪分支都包含该提交（彩色实线）'
  if (origin === 'remote') return '远程提交：只有远程跟踪分支包含该提交，本地还没有（可先 Fetch/Pull）'
  return '其他分支：只有其他本地分支包含该提交，当前分支与远程都没有（蓝色虚线）'
}

/** 悬浮节点时显示：短哈希、归属状态、该提交上的分支与标签名称。 */
function describeCommitNode(item: GitHistoryItem, refs: readonly GitHistoryRef[], hasRemote: boolean): string {
  const status = describeCommitOrigin(item.origin, hasRemote) ?? '归属未知：Host 未返回提交归属（按泳道配色）'
  const parts = [`${item.commitHash.slice(0, 8)} ${item.subject}`, status]
  if (refs.length > 0) parts.push(`分支与标签：${refs.map((ref) => refTitle(ref)).join('；')}`)
  if (item.authorName !== '') parts.push(`作者：${item.authorName}`)
  return parts.join('\n')
}

function buildChangeTree(items: readonly GitChangeItem[]): readonly GitTreeNode[] {
  const root = new Map<string, MutableGitTreeDirectory | GitTreeFile>()
  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let current = root
    let parentPath = ''
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!
      parentPath = parentPath ? `${parentPath}/${name}` : name
      const existing = current.get(name)
      if (existing?.kind === 'directory') current = existing.children
      else {
        const directory: MutableGitTreeDirectory = { kind: 'directory', name, path: parentPath, children: new Map() }
        current.set(name, directory)
        current = directory.children
      }
    }
    const fileName = parts.at(-1)!
    current.set(fileName, { kind: 'file', name: fileName, path: item.path, item })
  }
  return finalizeChangeTree(root)
}

function finalizeChangeTree(nodes: Map<string, MutableGitTreeDirectory | GitTreeFile>): readonly GitTreeNode[] {
  return [...nodes.values()].map((node) => node.kind === 'directory' ? { kind: 'directory' as const, name: node.name, path: node.path, children: finalizeChangeTree(node.children) } : node).sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1)
}

function collectTreeTargets(node: GitTreeNode): readonly string[] {
  if (node.kind === 'file') return [node.path]
  return node.children.flatMap((child) => collectTreeTargets(child))
}

function countTreeFiles(node: GitTreeNode): number { return node.kind === 'file' ? 1 : node.children.reduce((total, child) => total + countTreeFiles(child), 0) }
function hasStagedChanges(item: GitChangeItem): boolean { return item.staged || item.stagedStatus !== null }
function hasUnstagedChanges(item: GitChangeItem): boolean { return !item.staged || item.worktreeStatus !== null }
function changeStatus(item: GitChangeItem, staged: boolean): string { return staged ? item.stagedStatus ?? item.status : item.worktreeStatus ?? item.status }
function fileIcon(name: string): string { return name.endsWith('/') ? '▰' : name.includes('.') ? '·' : '□' }

interface GitWorkspaceApi { readonly follow?: () => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>> }
interface GitSessionApi { readonly list?: (request: { readonly cursor?: string }) => Promise<unknown> }
interface GitRemote { readonly workspace?: GitWorkspaceApi; readonly session?: GitSessionApi }

const GIT_WORKSPACE_OPEN_PREFIX = 'codingns4dsh.git.open.'
const GIT_WORKSPACE_STATE_EVENT = 'codingns4dsh-git-workspace-state'
const workspaceBySession = new Map<string, string>()
const closingWorkspaces = new Set<string>()

function GitWorkspaceRecovery({ useSessions, remote, sidebarRight }: GitWorkspaceRecoveryProps): ReactElement | null {
  const sessionsSnapshot = useSessions((value: unknown) => value)
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const openTabs = readGitOpenTabs(sidebarRight)
  const openTabSnapshot = useSyncExternalStore(
    openTabs?.subscribe ?? noSubscribe,
    openTabs?.getSnapshot ?? noOpenTabs,
    openTabs?.getSnapshot ?? noOpenTabs,
  )
  const sessionIds = [...new Set([...readSessionIds(sessionsSnapshot), ...openTabSnapshot.map((tab) => String(tab.sessionId))].filter(Boolean))]
  useEffect(() => {
    if (typeof window === 'undefined') return
    const refresh = (): void => setWorkspaceRevision((value) => value + 1)
    window.addEventListener(GIT_WORKSPACE_STATE_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener(GIT_WORKSPACE_STATE_EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [])
  useEffect(() => {
    if (typeof sidebarRight.openTabIn !== 'function') return
    let disposed = false
    const recover = async (): Promise<void> => {
      const workspaceItems = await readWorkspaceItems((remote as GitRemote | undefined)?.workspace)
      const allSessionIds = [...new Set([...sessionIds, ...workspaceItems.flatMap((item) => item.sessionIds)])]
      for (const sessionId of allSessionIds) {
        const workspaceId = await resolveGitWorkspaceId(remote, sessionId).catch(() => undefined)
        if (disposed || workspaceId === undefined) continue
        rememberGitWorkspaceSession(sessionId, workspaceId)
        const existing = readGitTabs(sidebarRight, sessionId, openTabSnapshot)
        const openState = readGitWorkspaceOpen(workspaceId)
        if (openState === false) {
          for (const tab of existing) if (tab.kind === GIT_KIND) sidebarRight.closeIn?.(sessionId, tab.id)
          continue
        }
        if (openState !== true) continue
        if (existing.some((tab) => tab.kind === GIT_KIND)) continue
        sidebarRight.openTabIn?.(sessionId, GIT_KIND)
      }
    }
    void recover()
    return () => { disposed = true }
  }, [openTabSnapshot, remote, sessionIds.join('|'), sidebarRight, workspaceRevision])
  return null
}

function closeGitWorkspaceTabs(sidebar: GitSidebarRuntime, remote: unknown, sessionId: string, tab: GitSidebarTab): void {
  const knownWorkspaceId = workspaceBySession.get(sessionId)
  if (knownWorkspaceId !== undefined) {
    closeKnownGitWorkspaceTabs(sidebar, knownWorkspaceId, sessionId, tab.id)
    return
  }
  void resolveGitWorkspaceId(remote, sessionId).then((workspaceId) => {
    if (workspaceId === undefined) return
    rememberGitWorkspaceSession(sessionId, workspaceId)
    closeKnownGitWorkspaceTabs(sidebar, workspaceId, sessionId, tab.id)
  }).catch(() => undefined)
}

function closeKnownGitWorkspaceTabs(sidebar: GitSidebarRuntime, workspaceId: string, currentSessionId: string, currentTabId: string): void {
  writeGitWorkspaceOpen(workspaceId, false)
  if (closingWorkspaces.has(workspaceId)) return
  closingWorkspaces.add(workspaceId)
  try {
    for (const entry of readGitOpenTabs(sidebar)?.getSnapshot() ?? []) {
      if (entry.kind !== GIT_KIND || entry.sessionId === currentSessionId && entry.tabId === currentTabId) continue
      if (workspaceBySession.get(String(entry.sessionId)) !== workspaceId) continue
      sidebar.closeIn?.(String(entry.sessionId), String(entry.tabId))
    }
  } finally {
    closingWorkspaces.delete(workspaceId)
  }
}

function rememberGitWorkspaceSession(sessionId: string, workspaceId: string): void {
  const normalizedSessionId = sessionId.trim()
  const normalizedWorkspaceId = workspaceId.trim()
  if (normalizedSessionId !== '' && normalizedWorkspaceId !== '') workspaceBySession.set(normalizedSessionId, normalizedWorkspaceId)
}

function gitWorkspaceOpenKey(workspaceId: string): string { return `${GIT_WORKSPACE_OPEN_PREFIX}${workspaceId}` }
function readGitWorkspaceOpen(workspaceId: string): boolean | undefined {
  try {
    const value = localStorage.getItem(gitWorkspaceOpenKey(workspaceId))
    return value === null ? undefined : value === '1'
  } catch { return undefined }
}
function writeGitWorkspaceOpen(workspaceId: string, open: boolean): void {
  try {
    localStorage.setItem(gitWorkspaceOpenKey(workspaceId), open ? '1' : '0')
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(GIT_WORKSPACE_STATE_EVENT))
  } catch { /* 浏览器禁用存储时仅失去跨会话恢复。 */ }
}

function readGitOpenTabs(sidebar: GitSidebarRuntime): GitSidebarOpenTabs | undefined {
  try { return sidebar.openTabs } catch { return undefined }
}
function readGitTabs(sidebar: GitSidebarRuntime, sessionId: string, snapshot: readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[]): readonly GitSidebarTab[] {
  try {
    if (typeof sidebar.tabsIn === 'function') return sidebar.tabsIn(sessionId)
  } catch { /* 旧版没有已装配的 Session store，回退到全局索引。 */ }
  return snapshot.filter((tab) => String(tab.sessionId) === sessionId).map((tab) => ({ id: String(tab.tabId), kind: tab.kind }))
}
function readSessionIds(value: unknown): readonly string[] {
  const record = asRecord(value)
  if (record === undefined) return []
  const result = new Set<string>()
  const byId = asRecord(record.byId)
  if (byId !== undefined) for (const sessionId of Object.keys(byId)) if (sessionId.trim() !== '') result.add(sessionId)
  for (const key of ['sessionId', 'currentSessionId', 'selectedSessionId']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') result.add(candidate)
  }
  for (const key of ['items', 'sessions']) {
    const items = record[key]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const itemRecord = asRecord(item)
      const candidate = itemRecord?.sessionId ?? itemRecord?.id
      if (typeof candidate === 'string' && candidate.trim() !== '') result.add(candidate)
    }
  }
  return [...result]
}
function noSubscribe(): () => void { return () => undefined }
const EMPTY_GIT_OPEN_TABS: readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[] = []
function noOpenTabs(): readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[] { return EMPTY_GIT_OPEN_TABS }

export async function resolveGitWorkspaceId(remote: unknown, sessionId: string): Promise<string | undefined> {
  const api = remote as GitRemote | undefined
  const workspaces = await readWorkspaceItems(api?.workspace)
  const direct = workspaces.find((item) => item.sessionIds.includes(sessionId))
  if (direct !== undefined) return direct.workspaceId

  const session = await readCurrentSession(api?.session, sessionId)
  if (session?.workspaceId !== undefined) return session.workspaceId
  const sessionCwd = session?.cwd
  if (sessionCwd !== undefined) {
    const byPath = workspaces
      .filter((item) => item.path !== undefined && isPathWithin(sessionCwd, item.path))
      .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0]
    if (byPath !== undefined) return byPath.workspaceId
  }
  if (workspaces.length === 1) return workspaces[0]?.workspaceId
  return undefined
}

async function readWorkspaceItems(api: GitWorkspaceApi | undefined): Promise<readonly WorkspaceItem[]> {
  if (api?.follow === undefined) return []
  const source = await api.follow()
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()
  await iterator.return?.()
  const unwrapped = asRecord(unwrapRemoteValue(first.value))
  const value = Array.isArray(unwrapped?.items) ? unwrapped : asRecord(unwrapped?.value)
  const items = Array.isArray(value?.items) ? value.items : []
  return items.flatMap((item) => {
    const record = asRecord(item)
    const workspaceId = record?.workspaceId
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') return []
    const rawSessionIds = record?.sessionIds
    const sessionIds = Array.isArray(rawSessionIds)
      ? rawSessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string')
      : []
    const path = typeof record?.path === 'string' && record.path.trim() !== '' ? record.path : undefined
    return [{ workspaceId, sessionIds, ...(path === undefined ? {} : { path }) }]
  })
}

interface WorkspaceItem { readonly workspaceId: string; readonly path?: string; readonly sessionIds: readonly string[] }
interface SessionItem { readonly workspaceId?: string; readonly cwd?: string }
async function readCurrentSession(api: GitSessionApi | undefined, sessionId: string): Promise<SessionItem | undefined> {
  if (api?.list === undefined) return undefined
  const result = asRecord(unwrapRemoteValue(await api.list({})))
  const items = Array.isArray(result?.items) ? result.items : []
  const session = asRecord(items.find((item) => asRecord(item)?.sessionId === sessionId))
  if (session === undefined) return undefined
  const workspaceId = typeof session.workspaceId === 'string' && session.workspaceId.trim() !== '' ? session.workspaceId : undefined
  const cwd = typeof session.cwd === 'string' && session.cwd.trim() !== '' ? session.cwd : undefined
  return workspaceId === undefined && cwd === undefined ? {} : { ...(workspaceId === undefined ? {} : { workspaceId }), ...(cwd === undefined ? {} : { cwd }) }
}
function isPathWithin(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizePath(candidate)
  const normalizedParent = normalizePath(parent)
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`)
}
function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+/u, '/')
  const withoutTrailingSlash = normalized.replace(/\/+$/u, '')
  const result = withoutTrailingSlash || '/'
  return /^[A-Za-z]:\//u.test(result) ? result.toLowerCase() : result
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined }
function unwrapRemoteValue(value: unknown): unknown {
  const record = asRecord(value)
  if (record === undefined || typeof record.ok !== 'boolean') return value
  return record.ok ? record.value : undefined
}
function cacheKey(workspaceId: string): string { return `codingns4dsh.git.${workspaceId}` }
function readCache(workspaceId: string): GitPanelCache | null { try { const value = JSON.parse(localStorage.getItem(cacheKey(workspaceId)) ?? 'null') as { status?: GitStatus; history?: readonly GitHistoryItem[]; historyTotalCount?: number; branches?: GitBranchSnapshot | null } | null; if (!value?.status || typeof value.historyTotalCount !== 'number') return null; return { status: value.status, history: value.history ?? [], historyTotalCount: value.historyTotalCount, branches: normalizeBranchSnapshot(value.branches ?? null) } } catch { return null } }
function writeCache(workspaceId: string, value: GitPanelCache): void { try { localStorage.setItem(cacheKey(workspaceId), JSON.stringify(value)) } catch { /* 浏览器禁用存储时仅失去缓存 */ } }
function normalizeBranchSnapshot(value: GitBranchSnapshot | null): GitBranchSnapshot | null {
  if (value === null) return null
  const normalize = (item: GitBranchSnapshot['local'][number], fallbackRemote: boolean): GitBranchSnapshot['local'][number] | null => {
    const rawName = typeof item.name === 'string' ? item.name.trim() : ''
    if (rawName === '') return null
    const fields = rawName.split(/%x1f/iu)
    const name = (fields[0] ?? '').trim()
    if (name === '') return null
    const upstream = (fields[2] ?? item.upstream ?? '').trim()
    return { name, current: item.current || fields[1] === '*', upstream: upstream || null, remote: item.remote || fallbackRemote || name.startsWith('refs/remotes/') }
  }
  const local = value.local.flatMap((item) => {
    const normalized = normalize(item, false)
    return normalized?.remote === true ? [] : normalized === null ? [] : [normalized]
  })
  const remote = value.remote.flatMap((item) => {
    const normalized = normalize(item, true)
    return normalized === null ? [] : [normalized]
  })
  const currentFields = value.currentBranch.split(/%x1f/iu)
  const currentBranch = (currentFields[0] ?? value.currentBranch).trim() || 'HEAD'
  return { currentBranch, local, remote }
}
async function call<T = unknown>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> { let result: CodingNsRpcResult; try { result = await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload) } catch (error) { if (!/HTTP (?:404|405)\b/u.test(error instanceof Error ? error.message : String(error))) throw error; result = await rpc.call('/api', `codingns/${endpoint}`, payload) } if (!result.ok) throw new Error(result.error.message); return result.value as T }
async function copyText(value: string): Promise<boolean> { try { if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return false; await navigator.clipboard.writeText(value); return true } catch { return false } }
interface GitHistoryGroup {
  readonly key: string
  readonly label: string
  readonly items: readonly { readonly item: GitHistoryItem; readonly index: number; readonly timeLabel: string }[]
}

function groupHistoryByDate(history: readonly GitHistoryItem[]): readonly GitHistoryGroup[] {
  const groups: Array<{ readonly key: string; readonly label: string; readonly items: Array<{ readonly item: GitHistoryItem; readonly index: number; readonly timeLabel: string }> }> = []
  for (const [index, item] of history.entries()) {
    const timestamp = formatHistoryTimestamp(item.authoredAt)
    const current = groups.at(-1)
    if (current?.key === timestamp.key) {
      current.items.push({ item, index, timeLabel: timestamp.timeLabel })
      continue
    }
    groups.push({ key: timestamp.key, label: timestamp.dateLabel, items: [{ item, index, timeLabel: timestamp.timeLabel }] })
  }
  return groups
}

function formatHistoryTimestamp(value: string): { readonly key: string; readonly dateLabel: string; readonly timeLabel: string } {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return { key: 'unknown', dateLabel: '未知日期', timeLabel: '未知时间' }
  const parts = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp)
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return { key: `${get('year')}-${get('month')}-${get('day')}`, dateLabel: `${get('month')}月${get('day')}日`, timeLabel: `${get('hour')}:${get('minute')}` }
}
function buildCommitMessageText(subject: string, body: string): string { const normalizedSubject = subject.trim(); const normalizedBody = body.trim(); return normalizedBody ? `${normalizedSubject}\n\n${normalizedBody}` : normalizedSubject }

const REMOTE_REF_PALETTE = ['#8b5cf6', '#ef4444', '#10b981', '#f59e0b', '#06b6d4', '#ec4899'] as const

function resolveRemotePaletteIndex(remoteName: string | null): number {
  if (remoteName === null) return 0
  let hash = 0
  for (const character of remoteName) hash = (hash * 33 + character.charCodeAt(0)) >>> 0
  return hash % REMOTE_REF_PALETTE.length
}

/**
 * 分支标签的配色按「在哪」分色，而不是按名称：当前分支＝品牌蓝，本地分支＝绿，
 * 远程分支＝按远程名散列到固定调色板，标签＝琥珀。色相拉开后，一眼就能区分本地与远程。
 */
function historyRefPillStyle(kind: GitHistoryRef['kind'], remoteName: string | null): CSSProperties {
  if (kind === 'remote') {
    const color = REMOTE_REF_PALETTE[resolveRemotePaletteIndex(remoteName)]!
    return { ...historyRefPillBaseStyle, border: `.5px solid color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 14%, transparent)`, color }
  }
  if (kind === 'tag') return { ...historyRefPillBaseStyle, border: '.5px solid color-mix(in srgb, #d98324 42%, transparent)', background: 'color-mix(in srgb, #d98324 15%, transparent)', color: '#b26a12' }
  // 本地分支用绿色，与远程调色板中的绿区分开：本地分支恒为绿，远程绿只出现在同名远程上。
  if (kind === 'local') return { ...historyRefPillBaseStyle, border: '.5px solid color-mix(in srgb, #10b981 40%, transparent)', background: 'color-mix(in srgb, #10b981 14%, transparent)', color: '#0f8a63' }
  return { ...historyRefPillBaseStyle, border: '.5px solid color-mix(in srgb, #4f9cff 42%, transparent)', background: 'color-mix(in srgb, #4f9cff 16%, transparent)', color: '#2b74d8' }
}

function graphRailStyle(lane: number, stroke: string, dashed = false): CSSProperties {
  const background = dashed ? `repeating-linear-gradient(to bottom, ${stroke} 0 3px, transparent 3px 6px)` : stroke
  return { position: 'absolute', top: 0, bottom: 0, left: laneCenterX(lane) - 0.75, width: 1.5, borderRadius: dashed ? 0 : 1, background }
}

// 面板根节点不再铺底色：DSH 右侧栏的其它面板都是透明的，继承 Sidebar 表面色才不会出现色块接缝。
const panelStyle: CSSProperties = { position: 'relative', userSelect: 'none', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12, minHeight: '100%', padding: '12px 14px 20px', overflow: 'auto', color: dshThemeColor.labelPrimary }
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 28 }
const tabTitleStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', minWidth: 0, color: dshThemeColor.labelPrimary, fontSize: 12 }
const headerActionsStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 }
// SegmentedControl 自带 indicator 与键盘走查，这里只负责在单列布局下占位与对齐。
const columnSwitchStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', minWidth: 0 }
const summaryStyle: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: 12 }
const contentGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start', gap: 12 }
const columnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }
// 卡片用 layer-1：与 DSH 内置卡片同层，暗色下只比侧栏表面亮一档。
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: `.5px solid ${dshThemeColor.menuBorder}`, borderRadius: 8, background: dshThemeColor.cardBackground }
const sectionHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24, fontSize: 12 }
const treeStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1 }
const treeDirectoryStyle: CSSProperties = { minWidth: 0 }
const treeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minHeight: 28, paddingLeft: 4, paddingRight: 2, borderRadius: 4, fontSize: 12 }
const treeChevronStyle: CSSProperties = { width: 12, color: dshThemeColor.labelTertiary, fontSize: 12 }
const folderIconStyle: CSSProperties = { color: dshThemeColor.accent, fontSize: 11 }
const fileIconStyle: CSSProperties = { width: 12, color: dshThemeColor.labelTertiary, fontSize: 12, textAlign: 'center' }
const fileNameStyle: CSSProperties = { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const fileStatusStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontFamily: dshThemeColor.codeFont, fontSize: 11 }
const historyListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 }
const historyRowStyle: CSSProperties = { display: 'flex', alignItems: 'stretch', minWidth: 0, fontSize: 12 }
const historyRowBodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: '1 1 auto' }
const historyRowMainStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, minHeight: 28, paddingLeft: 4, paddingRight: 2, borderRadius: 4 }
const graphGutterStyle: CSSProperties = { display: 'flex', flexDirection: 'column', flex: '0 0 auto', alignSelf: 'stretch', marginRight: 6 }
const graphTrackStyle: CSSProperties = { display: 'block', flex: '0 0 auto', overflow: 'visible' }
const graphRailsStyle: CSSProperties = { position: 'relative', flex: '0 0 auto', alignSelf: 'stretch', minHeight: 0 }
const historyHeaderActionsStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }
const historyRefListStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '4px 6px', paddingLeft: 2 }
// 尺寸对齐 DSH Pill：20px 高、11px 字号；颜色仍按来源区分，颜色是唯一的语义载体。
const historyRefPillBaseStyle: CSSProperties = { justifyContent: 'center', height: 20, padding: '0 8px', fontSize: 11, lineHeight: '17px' }
const historyDateHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'stretch', color: dshThemeColor.labelSecondary, fontSize: 11, fontWeight: 600 }
const historyDateHeaderTextStyle: CSSProperties = { display: 'block', minWidth: 0, paddingTop: 8 }
const hashStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontFamily: dshThemeColor.codeFont, fontSize: 11 }
const rowActionsStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 2, flex: '0 0 auto' }
const mutedStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const historyTimeStyle: CSSProperties = { ...mutedStyle, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }
const emptyStyle: CSSProperties = { padding: 16, color: dshThemeColor.labelSecondary, fontSize: 12 }
const diffOverlayStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box', background: dshThemeColor.overlay }
const diffStyle: CSSProperties = { ...sectionStyle, width: 'min(1000px, 100%)', maxHeight: 'min(88vh, 760px)', overflow: 'hidden', background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.prominentShadow }
const diffBodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'auto', paddingRight: 2 }
const diffFilesSectionStyle: CSSProperties = { ...sectionStyle, gap: 6, padding: 10, background: dshThemeColor.pageBackground }
const diffDiffSectionStyle: CSSProperties = { ...sectionStyle, gap: 6, padding: 10, background: dshThemeColor.pageBackground }
const diffSectionHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24, fontSize: 12 }
const diffCountStyle: CSSProperties = { minWidth: 20, padding: '2px 6px', borderRadius: 999, color: dshThemeColor.labelSecondary, background: dshThemeColor.surfaceSubtle, fontSize: 11, textAlign: 'center' }
const diffFileListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const diffFileRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, padding: '4px 6px', borderRadius: 4, background: dshThemeColor.surfaceSubtle, fontSize: 12 }
const diffFileStatusStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 42, flex: '0 0 auto', color: dshThemeColor.accent, fontSize: 11, fontWeight: 700 }
const diffFileNameStyle: CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, overflow: 'hidden' }
const diffFileOldPathStyle: CSSProperties = { overflow: 'hidden', color: dshThemeColor.labelTertiary, textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }
const diffBinaryStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const fileDiffTitleStyle: CSSProperties = { ...fileNameStyle, fontSize: 12 }
const diffTruncatedStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const diffEmptyStyle: CSSProperties = { padding: 10, color: dshThemeColor.labelTertiary, fontSize: 12 }
const diffLinesStyle: CSSProperties = { overflow: 'auto', border: `.5px solid ${dshThemeColor.menuBorder}`, borderRadius: 8, background: dshThemeColor.pageBackground, fontFamily: dshThemeColor.codeFont, fontSize: 12 }
const diffLineBaseStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '42px 42px minmax(0, 1fr)', minHeight: 21, alignItems: 'stretch', padding: '0 8px', whiteSpace: 'pre', overflowWrap: 'normal', lineHeight: 1.5 }
const diffLineNumberStyle: CSSProperties = { paddingRight: 8, color: dshThemeColor.labelTertiary, borderRight: `.5px solid ${dshThemeColor.menuBorder}`, textAlign: 'right', userSelect: 'none' }
const diffCodeStyle: CSSProperties = { minWidth: 0, paddingLeft: 10, color: 'inherit', font: 'inherit', overflow: 'visible' }
const commitSectionStyle: CSSProperties = { ...sectionStyle, gap: 10 }
/** 提交框与「生成提交信息」按钮同高，输入面沿用面板的表单风格（边框 + 输入底色 + 8px 圆角）。 */
const commitEditorRowStyle: CSSProperties = { display: 'flex', alignItems: 'stretch', gap: 8, minWidth: 0 }
const commitSubjectStyle: CSSProperties = { width: '100%', minHeight: 34, boxSizing: 'border-box', resize: 'none', padding: '7px 10px', borderRadius: 8, font: 'inherit', fontSize: 12, lineHeight: '16px' }
const draftButtonStyle: CSSProperties = { width: 34, flex: '0 0 auto', padding: 0, borderRadius: 8, fontSize: 16, lineHeight: 1 }
const commitActionsStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }
const refreshActionStyle: CSSProperties = { minHeight: 32, padding: '6px 12px', borderRadius: 8, fontSize: 12, lineHeight: '16px' }
// 主按钮沿用 DSH 品牌填充与前景色，暗色下自动变成浅底深字，与内置主按钮一致。
const submitActionStyle: CSSProperties = { ...refreshActionStyle }
const primaryButtonStyle: CSSProperties = { minHeight: 30, padding: '5px 12px', borderRadius: 8, fontSize: 12 }
const branchSelectStyle: CSSProperties = { maxWidth: 150, borderRadius: 8, padding: '3px 5px', fontSize: 11 }
const scopeSelectStyle: CSSProperties = { ...branchSelectStyle, maxWidth: 92 }
const loadMoreButtonStyle: CSSProperties = { minHeight: 30, borderRadius: 8, padding: '4px 9px', fontSize: 12 }
const menuStyle: CSSProperties = { position: 'relative', flex: '0 0 auto' }
const operationStatusStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, color: dshThemeColor.labelSecondary, fontSize: 11, whiteSpace: 'nowrap' }
const menuPopupStyle: CSSProperties = { position: 'absolute', right: 0, zIndex: 2, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 120, padding: 4 }
const iconActionStyle: CSSProperties = { width: 28, height: 28 }
const menuItemStyle: CSSProperties = { padding: '6px 8px' }

export const gitManagementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'gitManagement', version: '0.1.0', enabledByDefault: true, dependencies: [], runtime: 'client',
    ui: { label: 'Git 仓库管理', description: '在右侧 Sidebar 标签页查看提交、暂存文件、未提交文件和 Git 版本历史。', order: 40, defaultOpen: false },
  },
  start(context) {
    const uiContext = context.services.uiContext
    if (uiContext === undefined) throw new Error('Git 管理模块缺少 DSH UI 上下文')
    context.resources.add(registerGitManagementUi(uiContext, { rpc: context.services.rpc, remote: context.services.remote }))
  },
}
