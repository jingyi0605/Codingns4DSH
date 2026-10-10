import { createElement, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodingNsLocale } from './locale.js'
import { resolveChevronDownIcon, resolveRefreshIcon, resolveTerminalArrowIcon } from '../dsh-capabilities/client/primitives-adapter.js'

/** 停止子 Agent 分组的专用词典，避免改写 DSH 原生 subagent 词典。 */
export const SUBAGENT_COLLAPSED_LOCALE_NS = 'codingnsSubagentCollapsed' as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    codingnsSubagentCollapsed: SubagentCollapsedKey
  }
}

const zh = {
  'inactive.one': '已停止 {count} 个子 Agent',
  'inactive.other': '已停止 {count} 个子 Agent',
  'inactive.expand': '展开已停止的子 Agent',
  'inactive.collapse': '收起已停止的子 Agent',
  'count.total.one': '{count} 个子 Agent',
  'count.total.other': '{count} 个子 Agent',
  'count.running.one': '{count} 个子 Agent，正在运行',
  'count.running.other': '{count} 个子 Agent，正在运行',
  'activity.running': '正在运行',
  'activity.inactive': '当前未运行',
  'mode.oneShot': '一次性',
  'mode.continuable': '可继续',
  'mode.unknown': '模式未知',
  'branch.collapse': '收起 {label} 的下级子 Agent',
  'branch.expand': '展开 {label} 的下级子 Agent',
  'loading.label': '正在加载子 Agent…',
  'loading.aria': '正在加载子 Agent',
  'load.error': '无法加载子 Agent',
  retry: '重试',
  'diagnostic.corrupt': '会话记录损坏',
  'diagnostic.unsupported': '子 Agent 记录版本不受支持',
  'diagnostic.unavailable': '会话记录暂不可用',
} as const

const en: Record<keyof typeof zh, string> = {
  'inactive.one': '{count} stopped subagent',
  'inactive.other': '{count} stopped subagents',
  'inactive.expand': 'Show stopped subagents',
  'inactive.collapse': 'Hide stopped subagents',
  'count.total.one': '{count} subagent',
  'count.total.other': '{count} subagents',
  'count.running.one': '{count} subagent running',
  'count.running.other': '{count} subagents running',
  'activity.running': 'running',
  'activity.inactive': 'not running',
  'mode.oneShot': 'one-shot',
  'mode.continuable': 'continuable',
  'mode.unknown': 'unknown mode',
  'branch.collapse': 'Collapse {label} descendants',
  'branch.expand': 'Expand {label} descendants',
  'loading.label': 'Loading subagents…',
  'loading.aria': 'Loading subagents',
  'load.error': 'Unable to load subagents',
  retry: 'Retry',
  'diagnostic.corrupt': 'corrupted session record',
  'diagnostic.unsupported': 'unsupported subagent record version',
  'diagnostic.unavailable': 'session record temporarily unavailable',
}

type SubagentCollapsedKey = keyof typeof zh
type SessionIdLike = string

interface ChildEntry {
  readonly kind: 'child'
  readonly id: SessionIdLike
  readonly label?: string
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
  readonly activity: 'running' | 'inactive'
  readonly hasChildren: boolean
}

interface DiagnosticEntry {
  readonly kind: 'diagnostic'
  readonly id: string
  readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
}

type CatalogEntry = ChildEntry | DiagnosticEntry

interface CatalogSnapshot {
  readonly entries: readonly CatalogEntry[]
  readonly state: 'loading' | 'ready' | 'error'
  readonly error?: { readonly message?: string } | null
  readonly parentAvailable?: boolean
}

interface SessionSummaryLike {
  readonly id: SessionIdLike
  readonly origin?: string
  readonly parentId?: SessionIdLike
  readonly running?: boolean
  readonly title?: string
}

interface ProjectionSnapshotLike {
  readonly state?: 'idle' | 'loading' | 'ready' | 'error'
  readonly error?: { readonly message?: string } | null
  readonly values?: {
    readonly subagentCatalog?: readonly Readonly<Record<string, unknown>>[]
  }
}

interface SessionListStateLike {
  readonly byId?: Readonly<Record<SessionIdLike, SessionSummaryLike>>
  readonly subagentsByParent?: Readonly<Record<SessionIdLike, CatalogSnapshot>>
  readonly projectionsBySession?: Readonly<Record<SessionIdLike, ProjectionSnapshotLike>>
}

interface CatalogInjected {
  readonly openChild: (address: unknown) => void
  readonly refresh: (parentSessionId: SessionIdLike) => void
  readonly setCatalogOpen: (parentSessionId: SessionIdLike, open: boolean) => void
}

/**
 * 合并目录运行态和会话摘要。
 *
 * 目录项来自 DSH 的子 Agent 列表，摘要来自 Session Controller。停止边界
 * 可能先到达其中一条数据流；只要摘要已经明确为 idle，就不能继续把目录项
 * 当成运行中，否则顶部计数和绿色状态点会在回合结束后短暂滞留。
 */
function childActivity(
  entry: ChildEntry,
  summaries: Readonly<Record<SessionIdLike, SessionSummaryLike>>,
): 'running' | 'inactive' {
  return entry.activity === 'running' && summaries[entry.id]?.running !== false
    ? 'running'
    : 'inactive'
}

/** DSH Session Controller 的最小公开动作面，避免依赖内部实现类型。 */
export interface SubagentSessionsActions {
  readonly openChild: (address: unknown) => void
  readonly refresh: (parentSessionId: SessionIdLike) => void | Promise<void>
  readonly setSubagentCatalogOpen: (parentSessionId: SessionIdLike, open: boolean) => void
}

interface DshSessionsService {
  readonly openSubagent?: (address: unknown) => void
  readonly refreshSubagents?: (parentSessionId: SessionIdLike) => void | Promise<void>
  readonly refreshProjections?: (parentSessionId: SessionIdLike) => void | Promise<void>
  readonly setSubagentCatalogOpen?: (parentSessionId: SessionIdLike, open: boolean) => void
}

interface DshWorkspaceService {
  readonly openSession?: (address: unknown) => void
}

/**
 * 统一 DSH 0.2.0 与 0.2.1 的子 Agent 导航动作。
 *
 * 0.2.0 的原生组件直接调用 sessions.openSubagent/refreshSubagents；
 * 0.2.1 将导航提升到 uiWorkspace，并把刷新命名为 refreshProjections。
 * 这里只适配动作，不改变目录数据和会话生命周期。
 */
export function createSubagentSessionsActions(
  rawSessions: unknown,
  rawWorkspace: unknown,
): SubagentSessionsActions | undefined {
  const sessions = rawSessions as DshSessionsService | undefined
  const workspace = rawWorkspace as DshWorkspaceService | undefined
  const openChild = typeof workspace?.openSession === 'function'
    ? (address: unknown): void => { workspace.openSession!(address) }
    : typeof sessions?.openSubagent === 'function'
      ? (address: unknown): void => { sessions.openSubagent!(address) }
      : undefined
  const refresh = typeof sessions?.refreshProjections === 'function'
    ? (parentSessionId: SessionIdLike): void | Promise<void> => sessions.refreshProjections!(parentSessionId)
    : typeof sessions?.refreshSubagents === 'function'
      ? (parentSessionId: SessionIdLike): void | Promise<void> => sessions.refreshSubagents!(parentSessionId)
      : undefined
  if (openChild === undefined || refresh === undefined) return undefined
  const setCatalogOpen = typeof sessions?.setSubagentCatalogOpen === 'function'
    ? (parentSessionId: SessionIdLike, open: boolean): void => { sessions.setSubagentCatalogOpen!(parentSessionId, open) }
    : (): void => undefined
  return { openChild, refresh, setSubagentCatalogOpen: setCatalogOpen }
}

type CollapsedLineageProps = PropsRuntime<'conversation.session.header.lineage'>
  & CatalogInjected
  & PropsLocale<typeof SUBAGENT_COLLAPSED_LOCALE_NS>

type CollapsedCatalogActionProps = PropsRuntime<'conversation.session.header.actions'>
  & CatalogInjected
  & PropsLocale<typeof SUBAGENT_COLLAPSED_LOCALE_NS>

/** 将目录项分成诊断、运行中和停止三组；目录本身不会被过滤或删除。 */
export function partitionSubagentEntries(
  entries: readonly CatalogEntry[],
  summaries: Readonly<Record<SessionIdLike, SessionSummaryLike>> = {},
): {
  readonly diagnostics: readonly DiagnosticEntry[]
  readonly running: readonly ChildEntry[]
  readonly inactive: readonly ChildEntry[]
} {
  const diagnostics: DiagnosticEntry[] = []
  const running: ChildEntry[] = []
  const inactive: ChildEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'diagnostic') diagnostics.push(entry)
    else if (childActivity(entry, summaries) === 'running') running.push(entry)
    else inactive.push(entry)
  }
  return { diagnostics, running, inactive }
}

function catalogStyle(): CSSProperties {
  return {
    position: 'fixed', zIndex: 100, boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
    width: 336, maxWidth: 'min(400px, calc(100vw - 32px))', maxHeight: 'min(560px, calc(100vh - 140px))',
    padding: 4, overflow: 'auto', borderRadius: 20, background: 'var(--dsw-specific-menu)',
    boxShadow: 'var(--dsw-elevation-prominent)',
  }
}

const rowStyle: CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 8, boxSizing: 'border-box',
  width: '100%', minHeight: 50, padding: '7px 8px 7px 11px', border: 0, borderRadius: 8,
  background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: '18px',
  textAlign: 'left', cursor: 'pointer', outline: 'none',
}

const buttonStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', minHeight: 36, padding: '6px 10px',
  border: 0, borderRadius: 8, background: 'var(--dsw-alias-interactive-bg-hover)',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer', textAlign: 'left',
}

function menuPosition(trigger: HTMLButtonElement): CSSProperties {
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(336, window.innerWidth - 32)
  return { top: rect.bottom + 5, left: Math.min(Math.max(16, rect.left), window.innerWidth - width - 16) }
}

function normalizeMode(value: unknown): ChildEntry['mode'] {
  return value === 'one-shot' || value === 'continuable' || value === 'unknown' ? value : 'unknown'
}

function statusRunning(statuses: unknown, id: SessionIdLike): boolean | undefined {
  if (statuses instanceof Map) {
    const status = statuses.get(id) as { readonly running?: unknown } | undefined
    return typeof status?.running === 'boolean' ? status.running : undefined
  }
  if (statuses !== null && typeof statuses === 'object') {
    const status = (statuses as Record<string, unknown>)[id] as { readonly running?: unknown } | undefined
    return typeof status?.running === 'boolean' ? status.running : undefined
  }
  return undefined
}

/**
 * 将 DSH 0.2.0 的 subagentsByParent 和 0.2.1 的 projectionsBySession
 * 统一为本组件的目录快照。这样覆盖层只依赖公开投影，不读取会话日志。
 */
function normalizeCatalogs(
  state: SessionListStateLike,
  statuses: unknown,
): Readonly<Record<SessionIdLike, CatalogSnapshot>> {
  if (state.subagentsByParent !== undefined) return state.subagentsByParent
  const projections = state.projectionsBySession ?? {}
  const summaries = state.byId ?? {}
  const result: Record<SessionIdLike, CatalogSnapshot> = {}
  for (const [parentId, projection] of Object.entries(projections)) {
    const rawEntries = projection.values?.subagentCatalog ?? []
    const entries: ChildEntry[] = rawEntries.flatMap((raw) => {
      const id = typeof raw.id === 'string' ? raw.id : undefined
      if (id === undefined) return []
      const running = statusRunning(statuses, id) ?? summaries[id]?.running === true
      const childProjection = projections[id]
      const childCatalog = childProjection?.values?.subagentCatalog
      return [{
        kind: 'child' as const,
        id,
        ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        mode: normalizeMode(raw.mode),
        activity: running ? 'running' as const : 'inactive' as const,
        // 未加载的子投影保留分支入口；ready + 空数组才确认是叶子。
        hasChildren: childProjection === undefined
          || childProjection.state === 'loading'
          || childProjection.state === 'idle' && childCatalog === undefined
          || (childCatalog?.length ?? 0) > 0,
      }]
    })
    const projectionState = projection.state ?? 'loading'
    result[parentId] = {
      entries,
      state: projectionState === 'idle'
        ? projection.values?.subagentCatalog === undefined ? 'loading' : 'ready'
        : projectionState,
      ...(projection.error === undefined ? {} : { error: projection.error }),
    }
  }
  return result
}

function parentSessionIdOf(state: SessionListStateLike, sessionId: SessionIdLike): SessionIdLike | undefined {
  const summary = state.byId?.[sessionId]
  if (summary?.origin === 'subagent' && summary.parentId !== undefined) return summary.parentId
  for (const [parentId, catalog] of Object.entries(state.subagentsByParent ?? {})) {
    if (catalog.entries.some((entry) => entry.kind === 'child' && entry.id === sessionId)) return parentId
  }
  for (const [parentId, projection] of Object.entries(state.projectionsBySession ?? {})) {
    if (projection.values?.subagentCatalog?.some((entry) => entry.id === sessionId)) return parentId
  }
  return undefined
}

function sessionStats(
  root: SessionIdLike,
  summaries: Readonly<Record<SessionIdLike, SessionSummaryLike>>,
  catalogs: Readonly<Record<SessionIdLike, CatalogSnapshot>>,
): { count: number; runningCount: number } {
  // DSH 原生触发器统计当前父会话的直接子项；递归目录只在展开分支后显示，
  // 不能把孙级 Agent 混入顶部的“个数”和停止分组。
  const catalogEntries = catalogs[root]?.entries ?? []
  const catalogChildren = catalogEntries.flatMap((entry) => entry.kind === 'child' ? [entry.id] : [])
  const summaryChildren = Object.values(summaries).filter((summary) => summary.parentId === root).map((summary) => summary.id)
  const childIds = new Set([...summaryChildren, ...catalogChildren])
  let runningCount = 0
  for (const id of childIds) {
    const catalogEntry = catalogEntries.find((entry): entry is ChildEntry => entry.kind === 'child' && entry.id === id)
    if (catalogEntry !== undefined
      ? childActivity(catalogEntry, summaries) === 'running'
      : summaries[id]?.running === true) runningCount += 1
  }
  return { count: childIds.size, runningCount }
}

function diagnosticText(entry: DiagnosticEntry, t: TranslateNS<typeof SUBAGENT_COLLAPSED_LOCALE_NS>): string {
  return t(`diagnostic.${entry.reason}`)
}

interface CatalogRowsProps {
  readonly parentSessionId: SessionIdLike
  readonly currentSessionId?: SessionIdLike
  readonly catalog: CatalogSnapshot
  readonly catalogs: Readonly<Record<SessionIdLike, CatalogSnapshot>>
  readonly summaries: Readonly<Record<SessionIdLike, SessionSummaryLike>>
  readonly expanded: ReadonlySet<SessionIdLike>
  readonly inactiveOpen: ReadonlySet<SessionIdLike>
  readonly level: number
  readonly openChild: (address: unknown) => void
  readonly refresh: (parentSessionId: SessionIdLike) => void
  readonly toggleBranch: (childSessionId: SessionIdLike) => void
  readonly toggleInactive: (parentSessionId: SessionIdLike) => void
  readonly closeCatalog: () => void
  readonly t: TranslateNS<typeof SUBAGENT_COLLAPSED_LOCALE_NS>
}

function CatalogRows(props: CatalogRowsProps): ReactElement {
  const partitioned = partitionSubagentEntries(props.catalog.entries, props.summaries)
  const showInactive = props.inactiveOpen.has(props.parentSessionId)
  const renderEntry = (entry: ChildEntry): ReactElement => {
    const childCatalog = props.catalogs[entry.id]
    const knownLeaf = !entry.hasChildren
    const expanded = props.expanded.has(entry.id)
    const summary = props.summaries[entry.id]
    const activity = childActivity(entry, props.summaries)
    const label = entry.label ?? entry.id
    const modeLabel = entry.mode === 'one-shot'
      ? props.t('mode.oneShot')
      : entry.mode === 'continuable' ? props.t('mode.continuable') : props.t('mode.unknown')
    const secondary = [summary?.title, modeLabel, activity === 'running' ? props.t('activity.running') : props.t('activity.inactive')]
      .filter((value): value is string => value !== undefined && value !== '')
      .join(' · ')
    const openChild = (): void => {
      props.openChild({ parentSessionId: props.parentSessionId, childSessionId: entry.id, mode: entry.mode })
      props.closeCatalog()
    }
    const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); openChild()
      } else if (event.key === 'ArrowRight' && !knownLeaf && !expanded) {
        event.preventDefault(); props.toggleBranch(entry.id)
      } else if (event.key === 'ArrowLeft' && expanded) {
        event.preventDefault(); props.toggleBranch(entry.id)
      }
    }
    const rowChildren: ReactNode[] = []
    if (knownLeaf) rowChildren.push(createElement('span', { key: 'space', style: { flex: 'none', width: 14, height: 18 } }))
    else rowChildren.push(createElement('button', {
      key: 'disclosure', type: 'button', tabIndex: -1, 'aria-label': props.t(expanded ? 'branch.collapse' : 'branch.expand', { label }),
      onClick: (event: MouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); props.toggleBranch(entry.id) },
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: 14, height: 18, padding: 0, border: 0, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', transform: expanded ? 'rotate(90deg)' : undefined },
    }, createElement(resolveTerminalArrowIcon('right'))))
    rowChildren.push(createElement('div', { key: 'content', style: { display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 } },
      createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'inherit' } }, label),
      createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 } }, secondary),
    ))
    const row = createElement('div', {
      key: entry.id, role: 'treeitem', tabIndex: 0, 'aria-level': props.level, 'aria-current': entry.id === props.currentSessionId || undefined,
      ...knownLeaf ? {} : { 'aria-expanded': expanded }, style: rowStyle, onClick: openChild, onKeyDown: handleKey,
    // stopped/inactive follows the requested grey idle indicator; DSH 原生的
    // `done` 点是绿色完成态，不能拿它继续表达“当前正在运行”。
    }, createElement(StateDot, { state: activity === 'running' ? 'ongoing' : 'idle' }), ...rowChildren)
    if (knownLeaf || !expanded) return createElement('div', { key: `${entry.id}-node`, style: { position: 'relative', minWidth: 0 } }, row)
    const childLoading = childCatalog === undefined || (childCatalog.state === 'loading' && childCatalog.entries.length === 0)
    const children = childCatalog === undefined
      ? createElement('div', { role: 'treeitem', 'aria-disabled': true, 'aria-level': props.level + 1, style: { ...rowStyle, color: 'var(--dsw-alias-label-dimmed)', cursor: 'default' } }, createElement('span', { style: { flex: 'none', width: 14 } }), createElement(StateDot, { state: 'idle' }), createElement('span', null, props.t('loading.label')))
      : createElement(CatalogRows, { ...props, parentSessionId: entry.id, catalog: childCatalog, level: props.level + 1 })
    return createElement('div', { key: `${entry.id}-node`, style: { position: 'relative', minWidth: 0 } }, row, createElement('div', { role: 'group', 'aria-busy': childLoading || undefined, style: { paddingLeft: 18 } }, children))
  }

  const diagnostics = partitioned.diagnostics.map((entry) => createElement('div', { key: `diagnostic-${entry.id}`, role: 'treeitem', 'aria-disabled': true, 'aria-level': props.level, style: { ...rowStyle, color: 'var(--dsw-alias-label-dimmed)', cursor: 'not-allowed' } }, createElement(StateDot, { state: 'error' }), createElement('span', { style: { display: 'flex', flexDirection: 'column' } }, createElement('span', null, entry.id), createElement('span', { style: { fontSize: 12 } }, diagnosticText(entry, props.t)))))
  const inactiveLabel = props.t(partitioned.inactive.length === 1 ? 'inactive.one' : 'inactive.other', { count: partitioned.inactive.length })
  return createElement(Fragment, null,
    props.catalog.state === 'loading' && props.catalog.entries.length === 0 ? createElement('div', { role: 'treeitem', 'aria-disabled': true, 'aria-level': props.level, style: { ...rowStyle, color: 'var(--dsw-alias-label-dimmed)', cursor: 'default' } }, createElement(StateDot, { state: 'idle' }), createElement('span', null, props.t('loading.label'))) : null,
    props.catalog.state === 'error' ? createElement('div', { style: { padding: 10, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, createElement('span', null, props.catalog.error?.message ?? props.t('load.error')), createElement('button', { type: 'button', onClick: () => props.refresh(props.parentSessionId), style: { ...buttonStyle, width: 'auto', marginTop: 6 } }, createElement(resolveRefreshIcon()), props.t('retry'))) : null,
    ...diagnostics,
    ...partitioned.running.map(renderEntry),
    partitioned.inactive.length > 0 ? createElement('div', { key: `${props.parentSessionId}-inactive`, style: { marginTop: partitioned.running.length > 0 ? 4 : 0 } }, createElement('button', { type: 'button', 'aria-expanded': showInactive, 'aria-label': props.t(showInactive ? 'inactive.collapse' : 'inactive.expand'), onClick: () => props.toggleInactive(props.parentSessionId), style: buttonStyle }, createElement(showInactive ? resolveChevronDownIcon() : resolveTerminalArrowIcon('right')), inactiveLabel), showInactive ? createElement('div', { role: 'group', style: { marginTop: 2 } }, ...partitioned.inactive.map(renderEntry)) : null) : null,
  )
}

interface CatalogDropdownProps extends CatalogInjected {
  readonly rootSessionId: SessionIdLike
  readonly currentSessionId?: SessionIdLike
  readonly displayTitle?: string
  readonly openTitle?: () => void
  readonly variant: 'count' | 'switcher'
  readonly separator?: boolean
  readonly useSessions: CollapsedLineageProps['useSessions']
  readonly useSessionStatus?: CollapsedLineageProps['useSessionStatus']
  readonly t: TranslateNS<typeof SUBAGENT_COLLAPSED_LOCALE_NS>
}

function CatalogDropdown(props: CatalogDropdownProps): ReactElement | null {
  const sessionState = props.useSessions((value) => value) as unknown as SessionListStateLike
  const summaries = sessionState.byId ?? {}
  const statuses = props.useSessionStatus?.((value) => value)
  const catalogs = useMemo(() => normalizeCatalogs(sessionState, statuses), [sessionState, statuses])
  const catalog = catalogs[props.rootSessionId]
  const stats = useMemo(() => sessionStats(props.rootSessionId, summaries, catalogs), [props.rootSessionId, summaries, catalogs])
  const directEntries = catalog?.entries.filter((entry): entry is ChildEntry => entry.kind === 'child') ?? []
  // 目录可能先于会话摘要到达；触发器不能在这段窗口显示为 0 个。
  const totalCount = Math.max(stats.count, directEntries.length)
  const runningCount = stats.runningCount
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<SessionIdLike>>(new Set())
  const [inactiveOpen, setInactiveOpen] = useState<ReadonlySet<SessionIdLike>>(new Set())
  const [position, setPosition] = useState<CSSProperties>()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const setCatalogOpenRef = useRef(props.setCatalogOpen)
  setCatalogOpenRef.current = props.setCatalogOpen
  const visible = props.variant === 'switcher' || catalog?.state === 'error' || (catalog?.entries.length ?? 0) > 0 || totalCount > 0

  const close = (): void => {
    setOpen(false); setPosition(undefined); setExpanded(new Set()); setInactiveOpen(new Set()); props.setCatalogOpen(props.rootSessionId, false)
  }
  const toggle = (): void => {
    if (open) { close(); return }
    const trigger = triggerRef.current
    if (trigger === null) return
    setPosition(menuPosition(trigger)); setOpen(true); props.setCatalogOpen(props.rootSessionId, true)
  }
  const toggleBranch = (childSessionId: SessionIdLike): void => {
    if (expanded.has(childSessionId)) {
      setExpanded(current => new Set([...current].filter(id => id !== childSessionId)))
      props.setCatalogOpen(childSessionId, false)
    } else {
      setExpanded(current => new Set(current).add(childSessionId))
      props.setCatalogOpen(childSessionId, true)
      // 0.2.1 不再有 setSubagentCatalogOpen 的拉取副作用；显式刷新保证
      // 展开分支时仍能得到完整的子目录，旧版则由 Session Controller 去重。
      props.refresh(childSessionId)
    }
  }
  const toggleInactive = (parentSessionId: SessionIdLike): void => {
    setInactiveOpen(current => {
      const next = new Set(current)
      if (next.has(parentSessionId)) next.delete(parentSessionId)
      else next.add(parentSessionId)
      return next
    })
  }
  useEffect(() => {
    if (!open) return
    const listener = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', listener)
    return () => { document.removeEventListener('pointerdown', listener) }
  }, [open])
  useEffect(() => () => { setCatalogOpenRef.current(props.rootSessionId, false) }, [props.rootSessionId])
  useEffect(() => { if (!visible && open) close() }, [visible, open])
  if (!visible) return null

  const currentEntry = props.currentSessionId === undefined ? undefined : catalog?.entries.find(entry => entry.kind === 'child' && entry.id === props.currentSessionId)
  const title = currentEntry?.kind === 'child' ? currentEntry.label ?? currentEntry.id : props.displayTitle
  const totalKey = totalCount === 1 ? 'count.total.one' : 'count.total.other'
  const runningKey = runningCount === 1 ? 'count.running.one' : 'count.running.other'
  const triggerLabel = props.variant === 'switcher'
    ? title ?? ''
    : props.t(runningCount > 0 ? runningKey : totalKey, { count: runningCount > 0 ? runningCount : totalCount })
  const button = createElement('button', {
    ref: triggerRef, type: 'button', 'aria-haspopup': 'tree', 'aria-expanded': open, 'aria-label': triggerLabel,
    onClick: props.variant === 'switcher' && props.openTitle !== undefined ? props.openTitle : toggle,
    style: { display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 28, padding: '3px 2px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, cursor: 'pointer' },
  }, props.variant === 'count' && runningCount > 0 ? createElement(StateDot, { state: 'ongoing' }) : null, createElement('span', { style: { minWidth: 0, maxWidth: 244, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, triggerLabel), createElement('span', { style: { display: 'inline-flex', transform: open ? 'rotate(180deg)' : undefined } }, createElement(resolveChevronDownIcon())))
  return createElement('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0 } },
    props.separator ? createElement('span', { style: { color: 'var(--dsw-alias-label-caption)', fontSize: 14 } }, '/') : null,
    button,
    open ? createElement('div', { ref: menuRef, role: 'tree', 'aria-label': props.t('count.total.other', { count: totalCount }), style: { ...catalogStyle(), ...position } }, createElement(CatalogRows, { parentSessionId: props.rootSessionId, ...(props.currentSessionId === undefined ? {} : { currentSessionId: props.currentSessionId }), catalog: catalog ?? { entries: [], state: 'loading' }, catalogs, summaries, expanded, inactiveOpen, level: 1, openChild: props.openChild, refresh: props.refresh, toggleBranch, toggleInactive, closeCatalog: close, t: props.t })) : null,
  )
}

/** DSH 原生 lineage 的兼容投影：仅替换停止项的默认展示策略。 */
export function CollapsedSubagentLineage(props: CollapsedLineageProps): ReactElement {
  const state = props.useSessions((value) => value) as unknown as SessionListStateLike
  const parentId = parentSessionIdOf(state, props.lineageSessionId)
  const shared = { useSessions: props.useSessions, useSessionStatus: props.useSessionStatus, openChild: props.openChild, refresh: props.refresh, setCatalogOpen: props.setCatalogOpen, t: props.t }
  if (parentId === undefined) return createElement(CatalogDropdown, { ...shared, rootSessionId: props.lineageSessionId, variant: 'count', separator: true })
  return createElement(Fragment, null,
    createElement(CatalogDropdown, { ...shared, rootSessionId: parentId, currentSessionId: props.lineageSessionId, variant: 'switcher', displayTitle: props.displayTitle, ...(props.openTitle === undefined ? {} : { openTitle: props.openTitle }) }),
    props.openTitle === undefined ? createElement(CatalogDropdown, { ...shared, rootSessionId: parentId, variant: 'count' }) : null,
  )
}

/** DSH 0.2.1 根会话把计数入口放进 header.actions；这里必须覆盖这个 Slot。 */
export function CollapsedSubagentCatalogAction(props: CollapsedCatalogActionProps): ReactElement {
  const state = props.useSessions((value) => value) as unknown as SessionListStateLike
  if (state.byId?.[props.sessionId]?.origin === 'subagent') return createElement(Fragment, null)
  return createElement(CatalogDropdown, {
    useSessions: props.useSessions,
    useSessionStatus: props.useSessionStatus,
    openChild: props.openChild,
    refresh: props.refresh,
    setCatalogOpen: props.setCatalogOpen,
    t: props.t,
    rootSessionId: props.sessionId,
    variant: 'count',
  })
}

/** 在 DSH 两个子 Agent Header Slot 的更低优先级登记兼容投影；原生组件仍保留作回退。 */
export function registerCollapsedSubagentLineage(
  slots: SlotRegistry | undefined,
  locale: CodingNsLocale,
  sessions: SubagentSessionsActions | undefined,
): () => void {
  if (slots === undefined || sessions === undefined) return () => undefined
  const disposeLocale = locale.register(SUBAGENT_COLLAPSED_LOCALE_NS, { zh, en })
  const disposeInjection = slots.inject('conversation.session.header.lineage', () => slots.register({
    name: 'conversation.session.header.lineage',
    priority: -1,
    locale: SUBAGENT_COLLAPSED_LOCALE_NS,
    inject: () => ({
      openChild: (address: unknown) => { sessions.openChild(address) },
      refresh: (sessionId: SessionIdLike) => { void sessions.refresh(sessionId) },
      setCatalogOpen: (sessionId: SessionIdLike, open: boolean) => { sessions.setSubagentCatalogOpen(sessionId, open) },
    }),
  }, CollapsedSubagentLineage as never))
  // 0.2.1 的根会话计数入口位于 keyed list Slot；同样用更低优先级
  // shadow 原生 id，避免只覆盖子会话面包屑而漏掉用户实际点击的入口。
  const disposeActionInjection = slots.inject('conversation.session.header.actions', () => slots.register({
    name: 'conversation.session.header.actions',
    id: 'subagent-catalog',
    order: -30,
    priority: -1,
    locale: SUBAGENT_COLLAPSED_LOCALE_NS,
    inject: () => ({
      openChild: (address: unknown) => { sessions.openChild(address) },
      refresh: (sessionId: SessionIdLike) => { void sessions.refresh(sessionId) },
      setCatalogOpen: (sessionId: SessionIdLike, open: boolean) => { sessions.setSubagentCatalogOpen(sessionId, open) },
    }),
  }, CollapsedSubagentCatalogAction as never))
  return () => { disposeActionInjection(); disposeInjection(); disposeLocale() }
}
