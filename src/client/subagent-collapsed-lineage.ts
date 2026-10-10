import { createElement, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodingNsLocale } from './locale.js'
import { dshPopupSurfaceStyle, dshThemeColor } from './theme.js'
import { resolveChevronDownIcon, resolveRefreshIcon, resolveTerminalArrowIcon } from '../dsh-capabilities/client/primitives-adapter.js'
import { en, zh } from './locales/subagentCollapsed.js'

/** 停止子 Agent 分组的专用词典，避免改写 DSH 原生 subagent 词典。 */
export const SUBAGENT_COLLAPSED_LOCALE_NS = 'codingnsSubagentCollapsed' as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    codingnsSubagentCollapsed: SubagentCollapsedKey
  }
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
  readonly projectionValues?: {
    readonly tokenUsage?: {
      readonly uncachedInputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens: number
      readonly cacheWriteTokens: number
    }
    readonly subagentTiming?: {
      readonly settledMs: number
      readonly active?: { readonly since: number; readonly through: number }
      readonly lastTurnCompleted?: boolean
    }
  }
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
  readonly openChildAside?: ((address: unknown) => void) | undefined
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
  readonly openChildAside?: ((address: unknown) => void) | undefined
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

interface DshSidebarRightService {
  readonly openResource?: (address: string, options?: Readonly<Record<string, unknown>>) => unknown
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
  rawSidebarRight?: unknown,
): SubagentSessionsActions | undefined {
  const sessions = rawSessions as DshSessionsService | undefined
  const workspace = rawWorkspace as DshWorkspaceService | undefined
  const sidebarRight = rawSidebarRight as DshSidebarRightService | undefined
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
  const openChildAside = typeof sidebarRight?.openResource === 'function'
    ? (address: unknown): void => {
      if (address === null || typeof address !== 'object') return
      const value = address as { parentSessionId?: unknown; childSessionId?: unknown; mode?: unknown }
      if (typeof value.parentSessionId !== 'string' || typeof value.childSessionId !== 'string') return
      const mode = typeof value.mode === 'string' ? value.mode : 'unknown'
      const query = new URLSearchParams({ parent: value.parentSessionId, mode })
      sidebarRight.openResource!(`dsh-resource://subagentchat/session/${encodeURIComponent(value.childSessionId)}?${query.toString()}`, {
        kind: 'subagentchat', preferNewPane: true,
      })
    }
    : undefined
  return { openChild, refresh, setSubagentCatalogOpen: setCatalogOpen, ...(openChildAside === undefined ? {} : { openChildAside }) }
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
    ...dshPopupSurfaceStyle,
    position: 'fixed', zIndex: 1100, boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
    width: 336, maxWidth: 'min(400px, calc(100vw - 32px))', maxHeight: 'min(560px, calc(100vh - 140px))',
    overflow: 'hidden', padding: 3, border: 0, borderRadius: 'var(--dsw-radius-lg)',
  }
}

const catalogMenuBodyStyle: CSSProperties = {
  display: 'flex', flex: 'auto', flexDirection: 'column', minHeight: 0, overflow: 'auto',
}

const rowStyle: CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 6, boxSizing: 'border-box',
  width: '100%', minHeight: 44, padding: '6px 7px 6px 9px', border: 0, borderRadius: 'var(--dsw-radius-lg)',
  background: 'transparent', color: dshThemeColor.labelPrimary, fontSize: 12, lineHeight: '17px',
  textAlign: 'left', cursor: 'pointer', outline: 'none',
}

const buttonStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 40, boxSizing: 'border-box', padding: '0 10px',
  border: 0, borderRadius: 10, background: dshThemeColor.surfaceSubtle,
  color: dshThemeColor.labelSecondary, fontSize: 14, lineHeight: '22px', cursor: 'pointer', textAlign: 'left',
}

/** 停止分组是列表内的辅助折叠条，尺寸与 DSH 原生触发器保持一致。 */
const inactiveGroupButtonStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', minHeight: 32, boxSizing: 'border-box',
  padding: '3px 7px', border: 0, borderRadius: 'var(--dsw-radius-sm)', background: dshThemeColor.surfaceSubtle,
  color: dshThemeColor.labelSecondary, fontSize: 12, lineHeight: '18px', cursor: 'pointer', textAlign: 'left',
}

const clickareaStyle: CSSProperties = {
  display: 'flex', flex: 1, alignSelf: 'stretch', alignItems: 'flex-start', gap: 6, minWidth: 0,
  boxSizing: 'border-box', margin: '-6px -7px', padding: '6px 7px', borderRadius: 'var(--dsw-radius-lg)',
}

const rowActivitySlotStyle: CSSProperties = {
  display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: 14, height: 17,
}

const contentStyle: CSSProperties = { display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 }
const ellipsisStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const metricsStyle: CSSProperties = {
  display: 'grid', flex: 'none', gridTemplateRows: '17px 15px', color: dshThemeColor.labelTertiary,
  fontSize: 10, lineHeight: '15px', fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap',
}
const sidebarButtonStyle: CSSProperties = {
  display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
  margin: '4px 0', padding: 6, border: 0, borderRadius: 'var(--dsw-radius-sm)', background: 'transparent',
  color: dshThemeColor.labelTertiary, cursor: 'pointer',
}

function formatTokens(value: number, t: TranslateNS<typeof SUBAGENT_COLLAPSED_LOCALE_NS>): string {
  const scaled = (next: number): string => next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10)
  if (value < 1e3) return String(value)
  if (value < 1e6) return t('subagentCollapsed.tokens.thousand', { value: scaled(value / 1e3) })
  return t('subagentCollapsed.tokens.million', { value: scaled(value / 1e6) })
}

function tokenTotal(usage: {
  readonly uncachedInputTokens?: unknown
  readonly outputTokens?: unknown
  readonly cacheReadTokens?: unknown
  readonly cacheWriteTokens?: unknown
} | undefined): number | undefined {
  if (usage === undefined) return undefined
  const values = usage as { uncachedInputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown }
  const buckets = [values.uncachedInputTokens, values.outputTokens, values.cacheReadTokens, values.cacheWriteTokens]
  if (buckets.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return undefined
  return buckets.reduce<number>((sum, value) => sum + (value as number), 0)
}

function activityDuration(summary: SessionSummaryLike | undefined, activity: ChildEntry['activity'], now: number): number | undefined {
  const timing = summary?.projectionValues?.subagentTiming
  if (timing === undefined || typeof timing.settledMs !== 'number') return undefined
  if (timing.active === undefined) return timing.settledMs
  const end = activity === 'running' ? now : timing.active.through
  return timing.settledMs + Math.max(0, end - timing.active.since)
}

function splitDuration(ms: number): { seconds: number; minutes: number; hours: number; days: number; totalMinutes: number; totalHours: number } {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1e3)
  const totalMinutes = Math.floor(totalSeconds / 60)
  const totalHours = Math.floor(totalMinutes / 60)
  return { seconds: totalSeconds % 60, minutes: totalMinutes % 60, hours: totalHours % 24, days: Math.floor(totalHours / 24), totalMinutes, totalHours }
}

function formatDuration(ms: number, t: TranslateNS<typeof SUBAGENT_COLLAPSED_LOCALE_NS>): string {
  const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms)
  if (days >= 365) {
    const years = Math.floor(days / 365)
    const months = Math.floor((days % 365) / 30)
    return months === 0 ? t('subagentCollapsed.duration.years', { years }) : t('subagentCollapsed.duration.yearsMonths', { years, months })
  }
  if (days >= 30) {
    const months = Math.floor(days / 30)
    const remainingDays = days % 30
    return remainingDays === 0 ? t('subagentCollapsed.duration.months', { months }) : t('subagentCollapsed.duration.monthsDays', { months, days: remainingDays })
  }
  if (days > 0) return hours === 0 ? t('subagentCollapsed.duration.days', { days }) : t('subagentCollapsed.duration.daysHours', { days, hours })
  if (totalHours > 0) return t('subagentCollapsed.duration.hours', { hours: totalHours, minutes: String(minutes).padStart(2, '0'), seconds: String(seconds).padStart(2, '0') })
  if (totalMinutes > 0) return t('subagentCollapsed.duration.minutes', { minutes: totalMinutes, seconds: String(seconds).padStart(2, '0') })
  return t('subagentCollapsed.duration.seconds', { seconds })
}

function formatExactDuration(ms: number, t: TranslateNS<typeof SUBAGENT_COLLAPSED_LOCALE_NS>): string {
  const { seconds, minutes, hours, days } = splitDuration(ms)
  return days === 0 ? formatDuration(ms, t) : t('subagentCollapsed.duration.exactDays', {
    days, hours: String(hours).padStart(2, '0'), minutes: String(minutes).padStart(2, '0'), seconds: String(seconds).padStart(2, '0'),
  })
}

function menuPosition(trigger: HTMLButtonElement): CSSProperties {
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(336, window.innerWidth - 32)
  return { top: rect.bottom + 5, left: Math.min(Math.max(16, rect.left), window.innerWidth - width - 16) }
}

/** DSH 原生 switcher 的上下双箭头图标。 */
function subagentSwitcherIcon(): ReactElement {
  return createElement('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true },
    createElement('path', { d: 'M5.99951 12.7L8.95546 14.9478C9.40011 15.2859 9.62244 15.455 9.87526 15.488C9.95774 15.4988 10.0413 15.4988 10.1238 15.488C10.3766 15.455 10.599 15.2859 11.0436 14.9478L13.9995 12.7', stroke: 'currentColor', strokeWidth: 1.5 }),
    createElement('path', { d: 'M13.9995 7.7417L11.0436 5.49387C10.5989 5.15574 10.3766 4.98668 10.1238 4.95362C10.0413 4.94283 9.95775 4.94283 9.87527 4.95362C9.62245 4.98668 9.40012 5.15574 8.95547 5.49387L5.99952 7.7417', stroke: 'currentColor', strokeWidth: 1.5 }),
  )
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

/**
 * 判断打开目录时是否需要补拉父会话投影。
 *
 * 顶部计数可以先由会话摘要提供，目录投影却可能仍为空；用摘要计数作为
 * 下限可以覆盖这种短暂不一致，也能覆盖关闭目录后投影被清理的情况。
 */
export function shouldRefreshSubagentCatalog(
  catalog: Pick<CatalogSnapshot, 'entries' | 'state'> | undefined,
  totalCount: number,
): boolean {
  const childCount = catalog?.entries.reduce((count, entry) => count + (entry.kind === 'child' ? 1 : 0), 0) ?? 0
  return catalog === undefined || catalog.state !== 'ready' || childCount < totalCount
}

function diagnosticText(entry: DiagnosticEntry, t: TranslateNS<typeof SUBAGENT_COLLAPSED_LOCALE_NS>): string {
  return t(`subagentCollapsed.diagnostic.${entry.reason}`)
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
  readonly openChildAside?: ((address: unknown) => void) | undefined
  readonly t: TranslateNS<typeof SUBAGENT_COLLAPSED_LOCALE_NS>
}

function CatalogRows(props: CatalogRowsProps): ReactElement {
  const [now, setNow] = useState(() => Date.now())
  const partitioned = partitionSubagentEntries(props.catalog.entries, props.summaries)
  const hasRunning = partitioned.running.length > 0
  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasRunning])
  const showInactive = props.inactiveOpen.has(props.parentSessionId)
  const reserveDisclosure = props.catalog.entries.some((entry) => {
    if (entry.kind !== 'child') return false
    const childCatalog = props.catalogs[entry.id]
    return entry.hasChildren && !(childCatalog?.state === 'ready' && childCatalog.entries.length === 0)
  })
  const renderEntry = (entry: ChildEntry): ReactElement => {
    const childCatalog = props.catalogs[entry.id]
    const knownLeaf = !entry.hasChildren || childCatalog?.state === 'ready' && childCatalog.entries.length === 0
    const expanded = props.expanded.has(entry.id)
    const summary = props.summaries[entry.id]
    const activity = childActivity(entry, props.summaries)
    const label = entry.label ?? entry.id
    const modeLabel = entry.mode === 'one-shot'
      ? props.t('subagentCollapsed.mode.oneShot')
      : entry.mode === 'continuable' ? props.t('subagentCollapsed.mode.continuable') : props.t('subagentCollapsed.mode.unknown')
    const secondary = [summary?.title, modeLabel, activity === 'running' ? props.t('subagentCollapsed.activity.running') : props.t('subagentCollapsed.activity.inactive')]
      .filter((value): value is string => value !== undefined && value !== '')
      .join(' · ')
    const totalTokens = tokenTotal(summary?.projectionValues?.tokenUsage)
    const durationMs = activityDuration(summary, activity, now)
    const tokenMetric = totalTokens === undefined ? undefined : props.t('subagentCollapsed.tokens.total', { value: formatTokens(totalTokens, props.t) })
    const durationMetric = durationMs === undefined ? undefined : {
      compact: formatDuration(durationMs, props.t),
      exact: formatExactDuration(durationMs, props.t),
    }
    const metrics = [tokenMetric, durationMetric?.exact].filter((value): value is string => value !== undefined && value !== '').join(' · ')
    const openChild = (): void => {
      props.openChild({ parentSessionId: props.parentSessionId, childSessionId: entry.id, mode: entry.mode })
      props.closeCatalog()
    }
    const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); openChild()
      } else if (event.key === 'ArrowRight' && !knownLeaf && !expanded) {
        event.preventDefault(); event.stopPropagation(); props.toggleBranch(entry.id)
      } else if (event.key === 'ArrowLeft' && expanded) {
        event.preventDefault(); event.stopPropagation(); props.toggleBranch(entry.id)
      }
    }
    const openAside = (event: MouseEvent<HTMLButtonElement>): void => {
      event.preventDefault(); event.stopPropagation()
      props.openChildAside?.({ parentSessionId: props.parentSessionId, childSessionId: entry.id, mode: entry.mode })
      props.closeCatalog()
    }
    const disclosure = knownLeaf
      ? reserveDisclosure ? createElement('span', { key: 'disclosure-space', style: { flex: 'none', width: 14, height: 17 } }) : null
      : createElement('button', {
        key: 'disclosure', type: 'button', tabIndex: -1,
        'aria-label': props.t(expanded ? 'subagentCollapsed.branch.collapse' : 'subagentCollapsed.branch.expand', { label }),
        onClick: (event: MouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); props.toggleBranch(entry.id) },
        style: { display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: 14, height: 17, padding: 0, border: 0, borderRadius: 0, background: 'transparent', color: dshThemeColor.labelTertiary, cursor: 'pointer', transition: 'transform .12s', transform: expanded ? 'rotate(90deg)' : undefined },
      }, createElement(resolveTerminalArrowIcon('right'), { size: 12 }))
    const asideAnchor = props.currentSessionId === entry.id || props.openChildAside === undefined ? null : createElement('button', {
      type: 'button', 'aria-label': props.t('subagentCollapsed.open.sidebar.aria', { label }),
      onClick: openAside, onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => { event.stopPropagation() },
      onMouseEnter: (event: MouseEvent<HTMLButtonElement>) => { event.currentTarget.style.background = dshThemeColor.surfaceSubtle; event.currentTarget.style.color = dshThemeColor.labelPrimary },
      onMouseLeave: (event: MouseEvent<HTMLButtonElement>) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = dshThemeColor.labelTertiary },
      style: sidebarButtonStyle,
    }, createElement(resolveTerminalArrowIcon('right'), { size: 12 }))
    const asideButton = asideAnchor === null ? null : createElement(Tooltip, { label: props.t('subagentCollapsed.open.sidebar'), side: 'bottom', align: 'end', children: asideAnchor })
    const clickarea = createElement('div', { key: 'clickarea', 'data-subagent-clickarea': 'true', style: clickareaStyle },
      createElement('span', { style: rowActivitySlotStyle }, createElement(StateDot, { state: activity === 'running' ? 'ongoing' : 'idle' })),
      createElement('span', { style: contentStyle },
        createElement('span', { style: { ...ellipsisStyle, color: 'inherit', fontWeight: entry.id === props.currentSessionId ? 600 : 400 } }, label),
        createElement('span', { style: { ...ellipsisStyle, color: dshThemeColor.labelTertiary, fontSize: 10, lineHeight: '15px' } }, secondary),
      ),
      metrics === '' ? null : createElement('span', { style: metricsStyle },
        tokenMetric === undefined ? null : createElement('span', { style: { gridRow: 1, lineHeight: '17px' } }, tokenMetric),
        durationMetric === undefined ? null : createElement('span', { style: { gridRow: 2 }, title: props.t('subagentCollapsed.duration.exactTitle', { duration: durationMetric.exact }) }, durationMetric.compact),
      ),
      asideButton,
    )
    const row = createElement('div', {
      key: entry.id, role: 'treeitem', tabIndex: 0, 'aria-level': props.level, 'aria-current': entry.id === props.currentSessionId || undefined,
      'aria-label': [label, secondary, metrics].filter((value) => value !== '').join(' '),
      ...knownLeaf ? {} : { 'aria-expanded': expanded }, style: rowStyle,
      onMouseEnter: (event: MouseEvent<HTMLDivElement>) => { const area = event.currentTarget.querySelector<HTMLElement>('[data-subagent-clickarea]'); if (area !== null) area.style.background = dshThemeColor.surfaceSubtle },
      onMouseLeave: (event: MouseEvent<HTMLDivElement>) => { const area = event.currentTarget.querySelector<HTMLElement>('[data-subagent-clickarea]'); if (area !== null) area.style.background = 'transparent' },
      onClick: openChild, onKeyDown: handleKey,
    }, disclosure, clickarea)
    if (knownLeaf || !expanded) return createElement('div', { key: `${entry.id}-node`, style: { position: 'relative', minWidth: 0 } }, row)
    const childLoading = childCatalog === undefined || (childCatalog.state === 'loading' && childCatalog.entries.length === 0)
    const children = childCatalog === undefined
      ? createElement('div', { style: { color: dshThemeColor.labelTertiary, padding: '8px 10px', fontSize: 11, lineHeight: '16px' } }, props.t('subagentCollapsed.loading.label'))
      : createElement(CatalogRows, { ...props, parentSessionId: entry.id, catalog: childCatalog, level: props.level + 1 })
    return createElement('div', { key: `${entry.id}-node`, style: { position: 'relative', minWidth: 0 } }, row, createElement('div', { role: 'group', 'aria-busy': childLoading || undefined, style: { marginLeft: 16, paddingLeft: 3, borderLeft: '0.5px solid var(--dsw-alias-border-l2)' } }, children))
  }

  const diagnostics = partitioned.diagnostics.map((entry) => createElement('div', { key: `diagnostic-${entry.id}`, role: 'treeitem', 'aria-disabled': true, 'aria-level': props.level, style: { ...rowStyle, color: dshThemeColor.labelTertiary, cursor: 'not-allowed' } }, createElement('span', { style: rowActivitySlotStyle }, createElement(StateDot, { state: 'error' })), createElement('span', { style: contentStyle }, createElement('span', { style: ellipsisStyle }, entry.id), createElement('span', { style: { ...ellipsisStyle, fontSize: 10, lineHeight: '15px' } }, diagnosticText(entry, props.t)))))
  const inactiveLabel = props.t(partitioned.inactive.length === 1 ? 'subagentCollapsed.inactive.one' : 'subagentCollapsed.inactive.other', { count: partitioned.inactive.length })
  return createElement(Fragment, null,
    props.catalog.state === 'loading' && props.catalog.entries.length === 0 ? createElement('div', { style: { color: dshThemeColor.labelTertiary, padding: '8px 10px', fontSize: 11, lineHeight: '16px' } }, props.t('subagentCollapsed.loading.label')) : null,
    props.catalog.state === 'error' ? createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, color: 'var(--dsw-alias-state-error-primary)', padding: '8px 10px', fontSize: 11, lineHeight: '16px' } }, createElement('span', null, props.catalog.error?.message ?? props.t('subagentCollapsed.load.error')), createElement('button', { type: 'button', onClick: () => props.refresh(props.parentSessionId), style: { ...buttonStyle, width: 'auto', minHeight: 28, padding: '3px 5px', background: 'transparent', fontSize: 11 } }, createElement(resolveRefreshIcon()), props.t('subagentCollapsed.retry'))) : null,
    ...diagnostics,
    ...partitioned.running.map(renderEntry),
    partitioned.inactive.length > 0 ? createElement('div', { key: `${props.parentSessionId}-inactive`, style: { marginTop: props.catalog.entries.length > partitioned.inactive.length ? 2 : 0 } }, createElement('button', { type: 'button', 'aria-expanded': showInactive, 'aria-label': props.t(showInactive ? 'subagentCollapsed.inactive.collapse' : 'subagentCollapsed.inactive.expand'), onClick: () => props.toggleInactive(props.parentSessionId), style: inactiveGroupButtonStyle }, createElement(showInactive ? resolveChevronDownIcon() : resolveTerminalArrowIcon('right'), { size: 14 }), inactiveLabel), showInactive ? createElement('div', { role: 'group', style: { marginTop: 1 } }, ...partitioned.inactive.map(renderEntry)) : null) : null,
  )
}

interface CatalogDropdownProps extends CatalogInjected {
  readonly rootSessionId: SessionIdLike
  readonly currentSessionId?: SessionIdLike
  readonly displayTitle?: string
  readonly openTitle?: () => void
  readonly variant: 'count' | 'switcher'
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
  const [triggerInteractive, setTriggerInteractive] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout>>()
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout>>()
  const pinnedRef = useRef(false)
  const setCatalogOpenRef = useRef(props.setCatalogOpen)
  setCatalogOpenRef.current = props.setCatalogOpen
  const visible = props.variant === 'switcher' || catalog?.state === 'error' || (catalog?.entries.length ?? 0) > 0 || totalCount > 0

  const cancelHoverOpen = (): void => {
    if (hoverOpenTimer.current === undefined) return
    clearTimeout(hoverOpenTimer.current)
    hoverOpenTimer.current = undefined
  }
  const cancelHoverClose = (): void => {
    if (hoverCloseTimer.current === undefined) return
    clearTimeout(hoverCloseTimer.current)
    hoverCloseTimer.current = undefined
  }
  const changeOpen = (next: boolean, restoreFocus = false): void => {
    cancelHoverOpen(); cancelHoverClose()
    if (next) {
      const trigger = triggerRef.current
      if (trigger === null) return
      setOpen(true); setPosition(menuPosition(trigger)); props.setCatalogOpen(props.rootSessionId, true)
      // 计数可能来自 Session 摘要，而目录投影仍未加载（尤其是关闭后再次打开时）。
      // 0.2.1 的 setSubagentCatalogOpen 没有拉取副作用，必须在打开入口主动刷新父会话，
      // 否则弹层会显示为空目录，已停止的子智能体也无法重新出现。
      if (shouldRefreshSubagentCatalog(catalog, totalCount)) props.refresh(props.rootSessionId)
    } else {
      pinnedRef.current = false
      const closing = new Set(expanded)
      setOpen(false); setPosition(undefined); setExpanded(new Set()); setInactiveOpen(new Set())
      for (const sessionId of closing) props.setCatalogOpen(sessionId, false)
      props.setCatalogOpen(props.rootSessionId, false)
    }
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }
  const scheduleHoverOpen = (): void => {
    cancelHoverOpen(); cancelHoverClose()
    if (open) return
    hoverOpenTimer.current = setTimeout(() => { hoverOpenTimer.current = undefined; changeOpen(true) }, 150)
  }
  const scheduleHoverClose = (): void => {
    cancelHoverOpen(); cancelHoverClose()
    if (pinnedRef.current) return
    hoverCloseTimer.current = setTimeout(() => { hoverCloseTimer.current = undefined; changeOpen(false) }, 120)
  }
  const close = (): void => { changeOpen(false) }
  const handleTriggerClick = (): void => {
    cancelHoverOpen(); cancelHoverClose()
    if (props.variant === 'switcher' && props.openTitle !== undefined) {
      if (open) changeOpen(false)
      props.openTitle()
      return
    }
    pinnedRef.current = true
    if (!open) changeOpen(true)
  }
  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown') return
    event.preventDefault()
    if (!open) changeOpen(true)
    queueMicrotask(() => { menuRef.current?.querySelector<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])')?.focus() })
  }
  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = menuRef.current === null
      ? []
      : Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])'))
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault(); close(); triggerRef.current?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault(); items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault(); items[items.length - 1]?.focus()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault(); items[(index + 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); items[(index < 0 ? items.length : index - 1 + items.length) % items.length]?.focus()
    }
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
  useEffect(() => {
    if (!open) return
    const placeMenu = (): void => {
      const trigger = triggerRef.current
      if (trigger !== null) setPosition(menuPosition(trigger))
    }
    window.addEventListener('resize', placeMenu)
    document.addEventListener('scroll', placeMenu, true)
    return () => { window.removeEventListener('resize', placeMenu); document.removeEventListener('scroll', placeMenu, true) }
  }, [open])
  useEffect(() => () => { cancelHoverOpen(); cancelHoverClose() }, [])
  useEffect(() => () => { setCatalogOpenRef.current(props.rootSessionId, false) }, [props.rootSessionId])
  useEffect(() => { if (!visible && open) close() }, [visible, open])
  if (!visible) return null

  const currentEntry = props.currentSessionId === undefined ? undefined : catalog?.entries.find(entry => entry.kind === 'child' && entry.id === props.currentSessionId)
  const title = currentEntry?.kind === 'child' ? currentEntry.label ?? currentEntry.id : props.displayTitle
  const totalKey = totalCount === 1 ? 'subagentCollapsed.count.total.one' : 'subagentCollapsed.count.total.other'
  const runningKey = runningCount === 1 ? 'subagentCollapsed.count.running.one' : 'subagentCollapsed.count.running.other'
  const triggerText = props.variant === 'switcher'
    ? title ?? ''
    : props.t(totalKey, { count: totalCount })
  const triggerAriaLabel = props.variant === 'switcher'
    ? props.t('subagentCollapsed.switcher.aria', { title: triggerText })
    : props.t(runningCount > 0 ? runningKey : totalKey, { count: runningCount > 0 ? runningCount : totalCount })
  const ancestorSwitcher = props.variant === 'switcher' && props.openTitle !== undefined
  const triggerColor = props.variant === 'switcher'
    ? ancestorSwitcher ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-primary)'
    : triggerInteractive ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)'
  const button = createElement('button', {
    ref: triggerRef, type: 'button', 'aria-haspopup': 'tree', 'aria-expanded': open,
    'aria-label': triggerAriaLabel,
    onMouseEnter: () => { setTriggerInteractive(true); scheduleHoverOpen() }, onMouseLeave: () => { setTriggerInteractive(false); scheduleHoverClose() }, onFocus: () => setTriggerInteractive(true), onBlur: () => setTriggerInteractive(false),
    onClick: handleTriggerClick, onKeyDown: handleTriggerKeyDown,
    style: { display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 28, maxWidth: props.variant === 'switcher' ? 244 : undefined, padding: '3px 2px', border: 0, borderRadius: 'var(--dsw-radius-sm)', background: 'transparent', color: triggerColor, fontSize: 12, lineHeight: '18px', fontWeight: props.variant === 'switcher' && !ancestorSwitcher ? 500 : undefined, cursor: 'pointer', outline: 'none' },
  }, props.variant === 'count' && runningCount > 0 ? createElement(StateDot, { state: 'ongoing' }) : null, createElement('span', { style: { flex: 1, minWidth: 0, maxWidth: 244, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, triggerText), props.variant === 'switcher' ? subagentSwitcherIcon() : createElement('span', { style: { display: 'inline-flex', transition: 'transform .12s', transform: open ? 'rotate(180deg)' : undefined } }, createElement(resolveChevronDownIcon())))
  const menu = open ? createElement('div', { ref: menuRef, role: 'presentation', onMouseEnter: cancelHoverClose, onMouseLeave: scheduleHoverClose, onKeyDown: navigate, style: { ...catalogStyle(), ...position } }, createElement('div', { role: 'tree', 'aria-label': props.t('subagentCollapsed.tree.aria'), style: catalogMenuBodyStyle }, createElement(CatalogRows, { parentSessionId: props.rootSessionId, ...(props.currentSessionId === undefined ? {} : { currentSessionId: props.currentSessionId }), catalog: catalog ?? { entries: [], state: 'loading' }, catalogs, summaries, expanded, inactiveOpen, level: 1, openChild: props.openChild, openChildAside: props.openChildAside, refresh: props.refresh, toggleBranch, toggleInactive, closeCatalog: close, t: props.t }))) : null
  const renderedMenu = menu === null ? null : typeof document === 'undefined' ? menu : createPortal(menu, document.body)
  return createElement('div', { ref: rootRef, onMouseLeave: scheduleHoverClose, style: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 10, minWidth: 0, marginLeft: props.variant === 'switcher' ? 6 : undefined } },
    button,
    renderedMenu,
  )
}

/** DSH 原生 lineage 的兼容投影：保持原生树结构，仅增加停止项折叠投影。 */
export function CollapsedSubagentLineage(props: CollapsedLineageProps): ReactElement {
  const state = props.useSessions((value) => value) as unknown as SessionListStateLike
  const parentId = parentSessionIdOf(state, props.lineageSessionId)
  const shared = { useSessions: props.useSessions, useSessionStatus: props.useSessionStatus, openChild: props.openChild, openChildAside: props.openChildAside, refresh: props.refresh, setCatalogOpen: props.setCatalogOpen, t: props.t }
  // DSH 0.2.0+ 已把根会话的目录计数迁移到 header.actions。lineage 只负责
  // 子会话的面包屑；根会话在这里返回空，避免同一个目录出现两个入口。
  if (parentId === undefined) return createElement(Fragment, null)
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
    openChildAside: props.openChildAside,
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
      openChildAside: sessions.openChildAside === undefined ? undefined : (address: unknown) => { sessions.openChildAside!(address) },
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
      openChildAside: sessions.openChildAside === undefined ? undefined : (address: unknown) => { sessions.openChildAside!(address) },
      refresh: (sessionId: SessionIdLike) => { void sessions.refresh(sessionId) },
      setCatalogOpen: (sessionId: SessionIdLike, open: boolean) => { sessions.setSubagentCatalogOpen(sessionId, open) },
    }),
  }, CollapsedSubagentCatalogAction as never))
  return () => { disposeActionInjection(); disposeInjection(); disposeLocale() }
}
