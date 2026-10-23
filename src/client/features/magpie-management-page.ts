import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type {
  MagpieDashboardPeriod,
  MagpieDashboardAvailabilityIssue,
  MagpieDashboardQuota,
  MagpieManagementAvailabilityIssue,
  MagpieManagementSnapshot,
  MagpieAccountManagementUpdate,
  MagpieProviderManagementUpdate,
  MagpieRoutingGroupManagementUpdate,
  MagpieQuotaHistory,
  MagpieUsageDashboard,
  MagpieUsageGroup,
  MagpieUsageMetrics,
  MagpieUsageRequest,
  MagpieUsageRequestPage,
  MagpieUsageSeriesPoint,
  MagpieUsageSession,
} from '../../shared/contracts/magpie-management.js'
import type { CodingNsLocale } from '../locale.js'
import { useCodingNsTranslator } from '../locale.js'
import type { CodingNsRpcClient } from './types.js'
import { callCodingNsRpcResult } from '../rpc-call.js'
import { uiFontSize } from '../font-scale.js'
import { MagpieProviderLogo } from './magpie-provider-logo.js'
import { MagpieGroupsPage, MagpieProvidersPage } from './magpie-management-controls.js'
import { groupQuotaRowsByProvider } from './subscription-quota-groups.js'

/** Top-level native tabs: Overview stands alone; Providers and Routing manage Magpie; Usage hosts its reports. */
type PageTab = 'overview' | 'providers' | 'groups' | 'usage'
type UsageTab = 'quotas' | 'sessions' | 'requests'
type ChartMetric = 'calls' | 'tokens' | 'cost'
export type ModelBreakdownMode = 'aggregate' | 'account'
type MagpiePageProps = {
  readonly rpc: CodingNsRpcClient
  readonly locale: CodingNsLocale
  /**
   * Retained for the global-panel contract: DSH's own sidebar/back affordances return to the
   * conversation, so the page no longer renders its own back button.
   */
  readonly onClose?: () => void
  /** Optional initial tab, used by tests and static previews; the page owns the state after mount. */
  readonly initialPageTab?: PageTab
  readonly initialUsageTab?: UsageTab
}

const PERIODS: readonly { readonly id: MagpieDashboardPeriod; readonly key: string }[] = [
  { id: 'today', key: 'magpie.today' },
  { id: 'week', key: 'magpie.week' },
  { id: 'month', key: 'magpie.month' },
  { id: 'all', key: 'magpie.all' },
]
/** Top-level tab order mirrors native Magpie: Overview, Providers, Routing, Usage. */
const PAGE_TABS: readonly { readonly id: PageTab; readonly label: string; readonly icon: string }[] = [
  { id: 'overview', label: 'magpie.overview', icon: '◫' },
  { id: 'providers', label: 'magpie.management.providers', icon: '◈' },
  { id: 'groups', label: 'magpie.routing', icon: '⇄' },
  { id: 'usage', label: 'magpie.usage', icon: '◷' },
]
/** Native Magpie order inside Usage: Subscriptions, Sessions, Requests. */
const USAGE_TABS: readonly { readonly id: UsageTab; readonly label: string; readonly icon: string }[] = [
  { id: 'quotas', label: 'magpie.quotas', icon: '◉' },
  { id: 'sessions', label: 'magpie.sessions', icon: '◷' },
  { id: 'requests', label: 'magpie.requests', icon: '↗' },
]
const PAGE_SIZE = 50

export function MagpieManagementPage({ rpc, locale, initialPageTab = 'overview', initialUsageTab = 'quotas' }: MagpiePageProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  const [pageTab, setPageTab] = useState<PageTab>(initialPageTab)
  const [usageTab, setUsageTab] = useState<UsageTab>(initialUsageTab)
  const section = pageTab === 'usage' ? usageTab : pageTab
  const selectPageTab = (next: PageTab): void => setPageTab(next)
  const selectUsageTab = (next: UsageTab): void => {
    setPageTab('usage')
    setUsageTab(next)
  }
  const [period, setPeriod] = useState<MagpieDashboardPeriod>('today')
  const [dashboard, setDashboard] = useState<MagpieUsageDashboard | null>(null)
  const [dashboardLoading, setDashboardLoading] = useState(true)
  const [dashboardError, setDashboardError] = useState(false)
  const [dashboardIssue, setDashboardIssue] = useState<MagpieDashboardAvailabilityIssue | null>(null)
  const [chartMetric, setChartMetric] = useState<ChartMetric>('calls')
  const [sessionSearch, setSessionSearch] = useState('')
  const [selectedSession, setSelectedSession] = useState<MagpieUsageSession | null>(null)
  const [requestPage, setRequestPage] = useState<MagpieUsageRequestPage | null>(null)
  const [requestLoading, setRequestLoading] = useState(false)
  const [requestError, setRequestError] = useState(false)
  const [requestOffset, setRequestOffset] = useState(0)
  const [management, setManagement] = useState<MagpieManagementSnapshot | null>(null)
  const [managementLoading, setManagementLoading] = useState(true)
  const [managementIssue, setManagementIssue] = useState<MagpieManagementAvailabilityIssue | null>(null)
  const [managementWriting, setManagementWriting] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const dashboardSequence = useRef(0)
  const requestSequence = useRef(0)
  const managementSequence = useRef(0)

  const loadDashboard = useCallback(async (signal: AbortSignal): Promise<void> => {
    const sequence = dashboardSequence.current + 1
    dashboardSequence.current = sequence
    setDashboardLoading(true)
    setDashboardError(false)
    setDashboardIssue(null)
    try {
      const next = await callMagpieRpc<MagpieUsageDashboard | null>(rpc, 'usage/dashboard', { period }, signal)
      if (signal.aborted || sequence !== dashboardSequence.current) return
      setDashboard(next)
      const issue = next?.availabilityIssue ?? (next === null ? 'host-rpc-outdated' : null)
      setDashboardIssue(issue)
      setDashboardError(issue !== null)
    } catch (error) {
      if (signal.aborted || sequence !== dashboardSequence.current) return
      const issue = magpieDashboardIssueForRpcError(error)
      setDashboardIssue(issue)
      setDashboardError(true)
    } finally {
      if (!signal.aborted && sequence === dashboardSequence.current) setDashboardLoading(false)
    }
  }, [period, rpc])

  useEffect(() => {
    const controller = new AbortController()
    void loadDashboard(controller.signal)
    return () => controller.abort()
  }, [loadDashboard, refreshKey])

  const loadManagement = useCallback(async (signal: AbortSignal): Promise<void> => {
    const sequence = managementSequence.current + 1
    managementSequence.current = sequence
    setManagementLoading(true)
    setManagementIssue(null)
    try {
      const next = await callMagpieRpc<MagpieManagementSnapshot | null>(rpc, 'management/snapshot', {}, signal)
      if (signal.aborted || sequence !== managementSequence.current) return
      setManagement(next)
      setManagementIssue(next?.availabilityIssue ?? (next === null ? 'host-rpc-outdated' : null))
    } catch (error) {
      if (signal.aborted || sequence !== managementSequence.current) return
      setManagementIssue(magpieManagementIssueForRpcError(error))
    } finally {
      if (!signal.aborted && sequence === managementSequence.current) setManagementLoading(false)
    }
  }, [rpc])

  useEffect(() => {
    const controller = new AbortController()
    void loadManagement(controller.signal)
    return () => controller.abort()
  }, [loadManagement, refreshKey])

  const updateProvider = useCallback(async (update: MagpieProviderManagementUpdate): Promise<void> => {
    setManagementWriting(true)
    try {
      const result = await callMagpieRpc<{ readonly snapshot: MagpieManagementSnapshot }>(rpc, 'management/provider/update', update)
      setManagement(result.snapshot)
    } finally {
      setManagementWriting(false)
    }
  }, [rpc])

  const updateGroup = useCallback(async (update: MagpieRoutingGroupManagementUpdate): Promise<void> => {
    setManagementWriting(true)
    try {
      const result = await callMagpieRpc<{ readonly snapshot: MagpieManagementSnapshot }>(rpc, 'management/group/update', update)
      setManagement(result.snapshot)
    } finally {
      setManagementWriting(false)
    }
  }, [rpc])

  const updateAccount = useCallback(async (update: MagpieAccountManagementUpdate): Promise<void> => {
    setManagementWriting(true)
    try {
      const result = await callMagpieRpc<{ readonly snapshot: MagpieManagementSnapshot }>(rpc, 'management/account/update', update)
      setManagement(result.snapshot)
    } finally {
      setManagementWriting(false)
    }
  }, [rpc])

  useEffect(() => {
    if (section !== 'requests') return
    const controller = new AbortController()
    const sequence = requestSequence.current + 1
    requestSequence.current = sequence
    setRequestLoading(true)
    setRequestError(false)
    void callMagpieRpc<MagpieUsageRequestPage | null>(rpc, 'usage/requests', {
      period,
      offset: requestOffset,
      limit: PAGE_SIZE,
      ...(selectedSession === null ? {} : { sessionId: selectedSession.id, sessionAgent: selectedSession.agent }),
    }, controller.signal).then((next) => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setRequestPage(next)
      setRequestError(next === null)
    }).catch(() => {
      if (controller.signal.aborted || sequence !== requestSequence.current) return
      setRequestError(true)
    }).finally(() => {
      if (!controller.signal.aborted && sequence === requestSequence.current) setRequestLoading(false)
    })
    return () => controller.abort()
  }, [period, requestOffset, rpc, section, selectedSession])

  const filteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLocaleLowerCase()
    const sessions = dashboard?.sessions ?? []
    if (query === '') return sessions
    return sessions.filter((session) => session.agent.toLocaleLowerCase().includes(query) || session.id.toLocaleLowerCase().includes(query))
  }, [dashboard?.sessions, sessionSearch])

  const openSession = (session: MagpieUsageSession): void => {
    setSelectedSession(session)
    setRequestOffset(0)
    setRequestPage(null)
    selectUsageTab('requests')
  }

  const clearSession = (): void => {
    setSelectedSession(null)
    setRequestOffset(0)
    setRequestPage(null)
  }

  const style = pageStyle
  const capturedAt = dashboard?.capturedAt ?? management?.capturedAt ?? null
  const usageReports = pageTab === 'usage'
  /** Provider and routing-group settings are not period-scoped, so the period filter is hidden there. */
  const periodScoped = pageTab === 'overview' || pageTab === 'usage'
  return createElement('div', {
    className: 'codingns-magpie-page',
    role: 'region',
    'aria-label': t('magpie.pageTitle'),
    style,
  },
    createElement('style', undefined, MAGPIE_PAGE_CSS),
    createElement('header', { className: 'codingns-magpie-topbar' },
      createElement('div', { className: 'codingns-magpie-topbar-left' },
        periodScoped && createElement('div', { className: 'codingns-magpie-periods', role: 'group', 'aria-label': t('magpie.periodLabel') },
          ...PERIODS.map((entry) => createElement('button', {
            key: entry.id,
            type: 'button',
            className: `codingns-magpie-period${period === entry.id ? ' is-active' : ''}`,
            'aria-pressed': period === entry.id,
            onClick: () => {
              setPeriod(entry.id)
              setRequestOffset(0)
              setRequestPage(null)
            },
          }, t(entry.key))),
        ),
      ),
      createElement('nav', { className: 'codingns-magpie-tabs', 'aria-label': t('magpie.pageTitle') },
        ...PAGE_TABS.map((entry) => createElement('button', {
          key: entry.id,
          type: 'button',
          className: `codingns-magpie-tab${pageTab === entry.id ? ' is-active' : ''}`,
          'aria-current': pageTab === entry.id ? 'page' : undefined,
          onClick: () => selectPageTab(entry.id),
        },
          createElement('span', { className: 'codingns-magpie-tab-icon', 'aria-hidden': true }, entry.icon),
          createElement('span', { className: 'codingns-magpie-tab-label' }, t(entry.label)),
        )),
      ),
      createElement('div', { className: 'codingns-magpie-topbar-right' },
        createElement('button', {
          type: 'button',
          className: 'codingns-magpie-icon-button',
          disabled: dashboardLoading || managementLoading || managementWriting,
          'aria-busy': dashboardLoading || managementLoading,
          onClick: () => setRefreshKey((value) => value + 1),
          'aria-label': t(dashboardLoading || managementLoading ? 'magpie.refreshing' : 'magpie.refresh'),
          title: t(dashboardLoading || managementLoading ? 'magpie.refreshing' : 'magpie.refresh'),
        }, createElement(RefreshIcon, { busy: dashboardLoading || managementLoading })),
      ),
    ),
    usageReports && createElement('div', { className: 'codingns-magpie-toolbar has-tabs' },
      createElement('div', { className: 'codingns-magpie-toolbar-left' },
        createElement('div', { className: 'codingns-magpie-usage-tabs', role: 'group', 'aria-label': t('magpie.usage') },
          ...USAGE_TABS.map((entry) => createElement('button', {
            key: entry.id,
            type: 'button',
            className: `codingns-magpie-usage-tab${usageTab === entry.id ? ' is-active' : ''}`,
            'aria-pressed': usageTab === entry.id,
            onClick: () => selectUsageTab(entry.id),
          }, t(entry.label))),
        ),
      ),
    ),
    createElement('main', { className: 'codingns-magpie-main' },
      section === 'providers' || section === 'groups'
        ? managementIssue !== null && management === null
          ? createElement(EmptyState, { message: t(managementIssueLocaleKey(managementIssue)) })
          : managementLoading && management === null
            ? createElement(EmptyState, { message: t('magpie.management.loading'), loading: true })
            : management?.availabilityIssue !== null && management?.availabilityIssue !== undefined
              ? createElement(EmptyState, { message: t(managementIssueLocaleKey(management.availabilityIssue)) })
              : section === 'providers'
                ? createElement(MagpieProvidersPage, { snapshot: management, t, onUpdate: updateProvider, onAccountUpdate: updateAccount, writing: managementWriting })
                : createElement(MagpieGroupsPage, { snapshot: management, t, onUpdate: updateGroup })
        : dashboardIssue !== null
          ? createElement(EmptyState, { message: t(dashboardIssueLocaleKey(dashboardIssue)) })
          : dashboardLoading && dashboard === null
            ? createElement(EmptyState, { message: t('magpie.loading'), loading: true })
            : dashboardError && dashboard === null
              ? createElement(EmptyState, { message: t('magpie.unavailable') })
              : section === 'overview'
                ? createElement(OverviewPage, { dashboard, loading: dashboardLoading, error: dashboardError, chartMetric, onChartMetricChange: setChartMetric, t, onOpenSession: openSession })
                : section === 'sessions'
                  ? createElement(SessionsPage, { dashboard, sessions: filteredSessions, search: sessionSearch, onSearch: setSessionSearch, onOpenSession: openSession, t })
                  : section === 'requests'
                    ? createElement(RequestsPage, { page: requestPage, loading: requestLoading, error: requestError, selectedSession, offset: requestOffset, onOffsetChange: setRequestOffset, onClearSession: clearSession, t })
                    : createElement(QuotasPage, { dashboard, loading: dashboardLoading, t }),
    ),
  )
}

export function OverviewPage({ dashboard, loading, error, chartMetric, onChartMetricChange, t, onOpenSession }: {
  readonly dashboard: MagpieUsageDashboard | null
  readonly loading: boolean
  readonly error: boolean
  readonly chartMetric: ChartMetric
  readonly onChartMetricChange: (value: ChartMetric) => void
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly onOpenSession: (session: MagpieUsageSession) => void
}): ReactElement {
  const [modelBreakdownMode, setModelBreakdownMode] = useState<ModelBreakdownMode>('aggregate')
  const metrics = dashboard?.aggregate
  if (dashboard === null || dashboard.usageStatus === 'unavailable' || metrics == null) {
    return createElement(EmptyState, { message: t(error ? 'magpie.usageUnavailable' : 'magpie.noUsage'), loading })
  }
  const ioTokens = sumNullable(metrics.inputTokens, metrics.outputTokens)
  const stats: readonly { readonly label: string; readonly value: string; readonly detail?: string | undefined }[] = [
    { label: t('magpie.statTokens'), value: formatCompact(ioTokens), detail: `${t('magpie.metricInput')} ${formatCompact(metrics.inputTokens)} · ${t('magpie.metricOutput')} ${formatCompact(metrics.outputTokens)}` },
    { label: t('magpie.metricCacheRead'), value: formatCompact(metrics.cacheReadTokens), detail: `${t('magpie.metricCacheWrite')} ${formatCompact(metrics.cacheWriteTokens)}` },
    { label: t('magpie.metricReasoning'), value: formatCompact(metrics.reasoningTokens), detail: `${t('magpie.statWriteDown')} ${formatCompact(metrics.outputTokens)}` },
    { label: t('magpie.statCalls'), value: formatInteger(metrics.calls), detail: `${formatInteger(metrics.errors)} ${t('magpie.metricErrors')} · ${formatInteger(metrics.retried)} ${t('magpie.metricRetries')}` },
  ]
  return createElement('div', { className: 'codingns-magpie-view' },
    error && createElement(InlineNotice, { message: t('magpie.usageUnavailable') }),
    createElement(StatStrip, { stats }),
    createElement('section', { className: 'codingns-magpie-panel codingns-magpie-barchart-panel' },
      createElement('div', { className: 'codingns-magpie-panel-head' },
        createElement('div', { className: 'codingns-magpie-chart-switch', role: 'group', 'aria-label': t('magpie.timeline') },
          ...(['calls', 'tokens', 'cost'] as const).map((metric) => createElement('button', {
            key: metric,
            type: 'button',
            'aria-pressed': chartMetric === metric,
            className: chartMetric === metric ? 'is-active' : '',
            onClick: () => onChartMetricChange(metric),
          }, metric === 'calls' ? t('magpie.metricCalls') : metric === 'tokens' ? t('magpie.tokens') : t('magpie.metricCost'))),
        ),
      ),
      createElement(BarChart, { points: dashboard.series, metric: chartMetric, label: t(`magpie.chart.${chartMetric}`) }),
    ),
    createElement(ProgressSection, { title: t('magpie.byAgent'), rows: dashboard.agents, t }),
    createElement(ModelProgressSection, { rows: dashboard.models, mode: modelBreakdownMode, onModeChange: setModelBreakdownMode, t }),
    dashboard.sessions.length > 0 && createElement(ProgressSection, {
      title: t('magpie.topSessions'),
      rows: dashboard.sessions.map((session) => ({
        ...session,
        id: `${session.agent}:${session.id}`,
        name: session.dshSessionName ?? session.agent,
        model: session.id,
        provider: null,
        account: null,
      })),
      t,
      onOpen: (row) => {
        const target = dashboard.sessions.find((item) => `${item.agent}:${item.id}` === row.id)
        if (target !== undefined) onOpenSession(target)
      },
    }),
  )
}

export function ModelProgressSection({ rows, mode, onModeChange, t }: {
  readonly rows: readonly MagpieUsageGroup[]
  readonly mode: ModelBreakdownMode
  readonly onModeChange: (mode: ModelBreakdownMode) => void
  readonly t: (key: string, params?: Record<string, string | number>) => string
}): ReactElement {
  const controls = createElement('div', { className: 'codingns-magpie-chart-switch', role: 'group', 'aria-label': t('magpie.modelBreakdown') },
    ...(['aggregate', 'account'] as const).map((value) => createElement('button', {
      key: value,
      type: 'button',
      className: mode === value ? 'is-active' : '',
      'aria-pressed': mode === value,
      onClick: () => onModeChange(value),
    }, value === 'aggregate' ? t('magpie.modelAggregate') : t('magpie.modelPerAccount'))),
  )
  const displayRows = modelBreakdownRows(rows, mode)
  return createElement(ProgressSection, {
    // The two modes have different row identity semantics; remount the list so React cannot
    // retain an account row when returning to the aggregated view.
    key: `model-breakdown-${mode}`,
    title: t('magpie.byModel'),
    rows: displayRows,
    t,
    header: controls,
    ...(mode === 'aggregate' ? { limit: 8 } : {}),
  })
}

export function SessionsPage({ dashboard, sessions, search, onSearch, onOpenSession, t }: {
  readonly dashboard: MagpieUsageDashboard | null
  readonly sessions: readonly MagpieUsageSession[]
  readonly search: string
  readonly onSearch: (value: string) => void
  readonly onOpenSession: (session: MagpieUsageSession) => void
  readonly t: (key: string, params?: Record<string, string | number>) => string
}): ReactElement {
  const [agentFilter, setAgentFilter] = useState<string>('')
  const agentNames = useMemo(() => [...new Set(sessions.map((session) => session.agent))].sort(), [sessions])
  const visible = agentFilter === '' ? sessions : sessions.filter((session) => session.agent === agentFilter)
  const aggregate = sumSessions(visible)
  const metrics = dashboard?.aggregate
  const stats: readonly { readonly label: string; readonly value: string; readonly detail?: string | undefined }[] = [
    { label: t('magpie.statSessions'), value: formatInteger(visible.length), detail: t('magpie.sessionsCount', { count: visible.length }) },
    { label: t('magpie.statTokens'), value: formatCompact(sumNullable(aggregate.inputTokens, aggregate.outputTokens)), detail: `${t('magpie.metricInput')} ${formatCompact(aggregate.inputTokens)} · ${t('magpie.metricOutput')} ${formatCompact(aggregate.outputTokens)}` },
    { label: t('magpie.metricCost'), value: formatValue(aggregate.cost), detail: `${formatInteger(aggregate.unpriced)} ${t('magpie.metricUnpriced')}` },
    { label: t('magpie.metricCacheRead'), value: formatCompact(aggregate.cacheReadTokens), detail: `${t('magpie.metricCacheWrite')} ${formatCompact(aggregate.cacheWriteTokens)}` },
    { label: t('magpie.statReasoning'), value: formatCompact(aggregate.reasoningTokens), detail: t('magpie.statReasoningNote') },
  ]
  return createElement('div', { className: 'codingns-magpie-view' },
    createElement('div', { className: 'codingns-magpie-chiprow', role: 'group', 'aria-label': t('magpie.sessions') },
      createElement('button', { type: 'button', className: `codingns-magpie-chip${agentFilter === '' ? ' is-active' : ''}`, onClick: () => setAgentFilter('') }, t('magpie.all')),
      ...agentNames.map((agent) => createElement('button', { key: agent, type: 'button', className: `codingns-magpie-chip${agentFilter === agent ? ' is-active' : ''}`, onClick: () => setAgentFilter(agent) },
        createElement(MagpieProviderLogo, { identities: [agent], size: 18, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }), agent)),
    ),
    createElement('div', { className: 'codingns-magpie-filterrow' },
      createElement('label', { className: 'codingns-magpie-search codingns-magpie-grow' },
        createElement(SearchIcon),
        createElement('input', { type: 'search', value: search, onChange: (event: { currentTarget: { value: string } }) => onSearch(event.currentTarget.value), placeholder: t('magpie.sessionSearch'), 'aria-label': t('magpie.sessionSearch') }),
      ),
      metrics != null && createElement('span', { className: 'codingns-magpie-filter-summary' }, t('magpie.sessionCountUnknown') === '' ? '' : t('magpie.sessionsCount', { count: dashboard?.sessionCount ?? visible.length })),
    ),
    createElement(StatStrip, { stats }),
    dashboard !== null && dashboard.series.length > 1 && createElement('section', { className: 'codingns-magpie-panel codingns-magpie-barchart-panel' },
      createElement('div', { className: 'codingns-magpie-panel-head' },
        createElement('div', undefined, createElement('h2', undefined, t('magpie.dailyTrend'))),
      ),
      createElement(BarChart, { points: dashboard.series, metric: 'tokens', label: t('magpie.chart.tokens') }),
    ),
    visible.length === 0
      ? createElement(EmptyState, { message: t(search === '' && agentFilter === '' ? 'magpie.noSessions' : 'magpie.noRequests') })
      : createElement('section', { className: 'codingns-magpie-panel codingns-magpie-toplist-panel' },
        createElement('div', { className: 'codingns-magpie-panel-head' }, createElement('h2', undefined, t('magpie.topSessions'))),
        ...visible.slice(0, 40).map((session) => createElement('button', {
          key: `${session.agent}:${session.id}`,
          type: 'button',
          className: 'codingns-magpie-toprow',
          onClick: () => onOpenSession(session),
        },
          createElement(MagpieProviderLogo, { identities: [session.agent], size: 28, className: 'codingns-magpie-provider-logo', fallback: 'none' }),
          createElement('span', { className: 'codingns-magpie-toprow-main' },
            createElement('strong', undefined, session.dshSessionName ?? session.agent),
            session.dshSessionName !== undefined && createElement('small', { title: session.agent }, session.agent),
            createElement('small', { title: session.id }, session.id),
          ),
          createElement('span', { className: 'codingns-magpie-toprow-metrics' },
            createElement('span', undefined, formatCompact(sumNullable(session.inputTokens, session.outputTokens))),
            createElement('span', undefined, formatInteger(session.calls)),
            createElement('span', undefined, formatValue(session.cost)),
          ),
        )),
      ),
  )
}

function sumSessions(sessions: readonly MagpieUsageSession[]): {
  readonly calls: number | null; readonly errors: number | null; readonly retried: number | null
  readonly inputTokens: number | null; readonly outputTokens: number | null
  readonly cacheReadTokens: number | null; readonly cacheWriteTokens: number | null
  readonly reasoningTokens: number | null; readonly cost: number | null; readonly unpriced: number | null
} {
  const total = { calls: 0, errors: 0, retried: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0, unpriced: 0 }
  let any = false
  for (const session of sessions) {
    any = true
    total.calls += session.calls ?? 0
    total.errors += session.errors ?? 0
    total.retried += session.retried ?? 0
    total.inputTokens += session.inputTokens ?? 0
    total.outputTokens += session.outputTokens ?? 0
    total.cacheReadTokens += session.cacheReadTokens ?? 0
    total.cacheWriteTokens += session.cacheWriteTokens ?? 0
    total.reasoningTokens += session.reasoningTokens ?? 0
    total.cost += session.cost ?? 0
    total.unpriced += session.unpriced ?? 0
  }
  return any ? total : { ...total }
}

export function RequestsPage({ page, loading, error, selectedSession, offset, onOffsetChange, onClearSession, t }: {
  readonly page: MagpieUsageRequestPage | null
  readonly loading: boolean
  readonly error: boolean
  readonly selectedSession: MagpieUsageSession | null
  readonly offset: number
  readonly onOffsetChange: (value: number) => void
  readonly onClearSession: () => void
  readonly t: (key: string, params?: Record<string, string | number>) => string
}): ReactElement {
  const items = page?.items ?? []
  const aggregate = sumRequests(items)
  const stats: readonly { readonly label: string; readonly value: string; readonly detail?: string | undefined }[] = [
    { label: t('magpie.statTokens'), value: formatCompact(sumNullable(aggregate.inputTokens, aggregate.outputTokens)), detail: `${t('magpie.metricInput')} ${formatCompact(aggregate.inputTokens)} · ${t('magpie.metricOutput')} ${formatCompact(aggregate.outputTokens)}` },
    { label: t('magpie.statCalls'), value: formatInteger(page?.total ?? aggregate.calls), detail: `${formatInteger(aggregate.errors)} ${t('magpie.metricErrors')} · ${formatInteger(aggregate.retried)} ${t('magpie.metricRetries')}` },
    { label: t('magpie.metricCost'), value: formatValue(aggregate.cost), detail: `${formatInteger(aggregate.unpriced)} ${t('magpie.metricUnpriced')}` },
    { label: t('magpie.statSpeed'), value: aggregate.decodeTokens === null ? '—' : `${formatValue(aggregate.decodeTokens)} token/s`, detail: aggregate.decodeCount === null ? undefined : `${formatInteger(aggregate.decodeCount)} ${t('magpie.metricDecodeCount')}` },
    { label: t('magpie.statLatency'), value: aggregate.ttftMs === null ? '—' : `${formatValue(aggregate.ttftMs)} ms`, detail: t('magpie.statLatencyNote') },
  ]
  return createElement('div', { className: 'codingns-magpie-view' },
    selectedSession !== null && createElement('div', { className: 'codingns-magpie-selection' },
      createElement('span', { className: 'codingns-magpie-provider-inline' },
        createElement(MagpieProviderLogo, { identities: [selectedSession.agent], size: 20, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }),
        selectedSession.dshSessionName ?? t('magpie.requestFor', { agent: selectedSession.agent, id: selectedSession.id })),
      createElement('button', { type: 'button', className: 'codingns-magpie-text-button', onClick: onClearSession }, t('magpie.clearSession')),
    ),
    error && createElement(InlineNotice, { message: t('magpie.usageUnavailable') }),
    loading && page === null
      ? createElement(EmptyState, { message: t('magpie.loading'), loading: true })
      : page === null || items.length === 0
        ? createElement(EmptyState, { message: t('magpie.noRequests') })
        : createElement('div', undefined,
          createElement(StatStrip, { stats }),
          createElement('section', { className: 'codingns-magpie-panel codingns-magpie-request-panel' },
            createElement('div', { className: 'codingns-magpie-reqlist' },
              ...items.map((request, index) => createElement(NativeRequestCard, { key: `${request.routeId ?? offset + index}:${request.time ?? ''}`, request, t })),
            ),
            createElement('div', { className: 'codingns-magpie-table-scroll' },
              createElement('table', { className: 'codingns-magpie-table codingns-magpie-native-table' },
                createElement('thead', undefined, createElement('tr', undefined,
                  createElement('th', undefined, t('magpie.ncolTime')),
                  createElement('th', undefined, 'AGENT'),
                  createElement('th', undefined, t('magpie.ncolRequested')),
                  createElement('th', undefined, t('magpie.ncolProvider')),
                  createElement('th', undefined, t('magpie.ncolServed')),
                  createElement('th', undefined, t('magpie.ncolInput')),
                  createElement('th', undefined, t('magpie.ncolOutput')),
                  createElement('th', undefined, t('magpie.ncolCost')),
                  createElement('th', undefined, t('magpie.ncolFirstText')),
                  createElement('th', undefined, t('magpie.ncolDuration')),
                  createElement('th', undefined, t('magpie.ncolSpeed')),
                  createElement('th', undefined, t('magpie.ncolStatus')),
                )),
                createElement('tbody', undefined, ...items.map((request, index) => createElement(NativeRequestRow, { key: `${request.routeId ?? offset + index}:${request.time ?? ''}`, request, t }))),
              ),
            ),
            createElement('div', { className: 'codingns-magpie-pagination' },
              createElement('span', undefined, page.total === null ? t('magpie.pageOf', { page: Math.floor(offset / PAGE_SIZE) + 1 }) : `${offset + 1}–${Math.min(offset + items.length, page.total)} / ${formatInteger(page.total)}`),
              createElement('div', undefined,
                createElement('button', { type: 'button', disabled: offset === 0 || loading, onClick: () => onOffsetChange(Math.max(0, offset - PAGE_SIZE)) }, t('magpie.previous')),
                createElement('button', { type: 'button', disabled: !page.hasMore || loading, onClick: () => onOffsetChange(offset + PAGE_SIZE) }, t('magpie.next')),
              ),
            ),
          ),
        ),
  )
}

function sumRequests(items: readonly MagpieUsageRequest[]): {
  readonly calls: number | null; readonly errors: number | null; readonly retried: number | null
  readonly inputTokens: number | null; readonly outputTokens: number | null
  readonly cost: number | null; readonly unpriced: number | null
  readonly ttftMs: number | null; readonly decodeTokens: number | null; readonly decodeCount: number | null
} {
  const total = { calls: 0, errors: 0, retried: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpriced: 0 }
  let ttftSum = 0
  let ttftCount = 0
  let speedSum = 0
  let speedCount = 0
  for (const item of items) {
    total.calls += item.status !== null && /^2/u.test(item.status) ? 1 : 1
    if (item.status !== null && !/^2/u.test(item.status)) total.errors += 1
    total.inputTokens += item.inputTokens ?? 0
    total.outputTokens += item.outputTokens ?? 0
    total.cost += item.cost ?? 0
    if (item.priced === false) total.unpriced += 1
    if (item.firstTextMs !== null) { ttftSum += item.firstTextMs; ttftCount += 1 }
    if (item.durationMs !== null && item.outputTokens !== null && item.durationMs > 0) {
      speedSum += item.outputTokens / (item.durationMs / 1000)
      speedCount += 1
    }
  }
  return {
    calls: total.calls,
    errors: total.errors,
    retried: 0,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cost: total.cost,
    unpriced: total.unpriced,
    ttftMs: ttftCount === 0 ? null : ttftSum / ttftCount,
    decodeTokens: speedCount === 0 ? null : speedSum / speedCount,
    decodeCount: speedCount === 0 ? null : speedCount,
  }
}

function NativeRequestRow({ request, t }: { readonly request: MagpieUsageRequest; readonly t: (key: string, params?: Record<string, string | number>) => string }): ReactElement {
  const speed = request.durationMs !== null && request.outputTokens !== null && request.durationMs > 0
    ? `${formatValue(request.outputTokens / (request.durationMs / 1000))} token/s`
    : '—'
  return createElement('tr', undefined,
    createElement('td', { className: 'codingns-magpie-time-cell' }, formatTimestamp(request.time)),
    createElement('td', undefined, createElement('span', { className: 'codingns-magpie-provider-inline' },
      createElement(MagpieProviderLogo, { identities: [request.agent], size: 18, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }),
      createElement('span', { className: 'codingns-magpie-agent-tag' }, request.agent ?? '—'))),
    createElement('td', undefined, createElement('span', { className: 'codingns-magpie-route-model', title: request.requestedModel ?? '' }, request.requestedModel ?? '—')),
    createElement('td', undefined,
      createElement('span', { className: 'codingns-magpie-provider-inline' },
        createElement(MagpieProviderLogo, { identities: [request.provider], size: 18, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }),
        createElement('span', { className: 'codingns-magpie-provider-name' }, request.provider ?? '—')),
      request.account !== null && createElement('small', { className: 'codingns-magpie-table-secondary' }, request.account),
    ),
    createElement('td', undefined, createElement('span', { className: 'codingns-magpie-route-model' }, request.servedModel ?? '—')),
    createElement('td', undefined, formatCompact(request.inputTokens)),
    createElement('td', undefined, formatCompact(request.outputTokens)),
    createElement('td', { className: 'codingns-magpie-cost-cell' }, formatValue(request.cost)),
    createElement('td', undefined, request.firstTextMs === null ? '—' : `${formatValue(request.firstTextMs)} ms`),
    createElement('td', undefined, request.durationMs === null ? '—' : `${formatValue(request.durationMs / 1000)} s`),
    createElement('td', undefined, speed),
    createElement('td', undefined, createElement('span', { className: `codingns-magpie-status ${request.status !== null && /^2/u.test(request.status) ? 'is-ok' : 'is-warn'}` }, request.status ?? '—')),
  )
}

/** Compact ledger card used below 650px: same fields as the native table, stacked for narrow screens. */
function NativeRequestCard({ request, t }: { readonly request: MagpieUsageRequest; readonly t: (key: string, params?: Record<string, string | number>) => string }): ReactElement {
  const speed = request.durationMs !== null && request.outputTokens !== null && request.durationMs > 0
    ? `${formatValue(request.outputTokens / (request.durationMs / 1000))} token/s`
    : '—'
  const facts = [
    `${t('magpie.ncolInput')} ${formatCompact(request.inputTokens)}`,
    `${t('magpie.ncolOutput')} ${formatCompact(request.outputTokens)}`,
    `${t('magpie.ncolCost')} ${formatValue(request.cost)}`,
    request.firstTextMs === null ? null : `${t('magpie.ncolFirstText')} ${formatValue(request.firstTextMs)} ms`,
    request.durationMs === null ? null : `${t('magpie.ncolDuration')} ${formatValue(request.durationMs / 1000)} s`,
    `${t('magpie.ncolSpeed')} ${speed}`,
  ].filter((item): item is string => item !== null)
  return createElement('article', { className: 'codingns-magpie-reqcard' },
    createElement('div', { className: 'codingns-magpie-reqcard-top' },
      createElement('span', { className: 'codingns-magpie-time-cell' }, formatTimestamp(request.time)),
      createElement('span', { className: 'codingns-magpie-provider-inline' },
        createElement(MagpieProviderLogo, { identities: [request.agent], size: 16, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }),
        createElement('span', { className: 'codingns-magpie-agent-tag' }, request.agent ?? '—'),
      ),
      createElement('span', { className: `codingns-magpie-status ${request.status !== null && /^2/u.test(request.status) ? 'is-ok' : 'is-warn'}` }, request.status ?? '—'),
    ),
    createElement('div', { className: 'codingns-magpie-reqcard-route' },
      createElement('span', { className: 'codingns-magpie-route-model', title: request.requestedModel ?? '' }, request.requestedModel ?? '—'),
      createElement('span', { className: 'codingns-magpie-reqcard-arrow', 'aria-hidden': true }, '→'),
      createElement('span', { className: 'codingns-magpie-route-model' }, request.servedModel ?? '—'),
    ),
    createElement('div', { className: 'codingns-magpie-reqcard-sub' },
      createElement('span', { className: 'codingns-magpie-provider-name' }, request.provider ?? '—'),
      request.account !== null && createElement('span', { className: 'codingns-magpie-table-secondary' }, request.account),
    ),
    createElement('div', { className: 'codingns-magpie-reqcard-facts' }, ...facts.map((fact) => createElement('span', { key: fact }, fact))),
  )
}

export function QuotasPage({ dashboard, loading, t }: { readonly dashboard: MagpieUsageDashboard | null; readonly loading: boolean; readonly t: (key: string, params?: Record<string, string | number>) => string }): ReactElement {
  const quotaUnavailable = dashboard?.quotaStatus !== 'available'
  const quotas = dashboard?.quotas ?? []
  const quotaHistory = dashboard?.quotaHistory ?? []
  return createElement('div', { className: 'codingns-magpie-view' },
    quotaUnavailable
      ? createElement(EmptyState, { message: t(dashboard === null && loading ? 'magpie.loading' : 'magpie.quotaUnavailable'), loading: dashboard === null && loading })
      : quotas.length === 0
        ? createElement(EmptyState, { message: t('magpie.noQuotas') })
        : createElement('div', { className: 'codingns-magpie-quota-grid' }, ...groupQuotaRowsByProvider(quotas).map((group) => createElement(QuotaGroupCard, { key: group.provider, group, t }))),
    createElement('section', { className: 'codingns-magpie-panel codingns-magpie-history-panel' },
      createElement('div', { className: 'codingns-magpie-panel-head' }, createElement('div', undefined,
        createElement('h2', undefined, t('magpie.quotaHistory')),
        createElement('p', undefined, t('magpie.quotaHistoryNote')),
      )),
      quotaHistory.length === 0
        ? createElement('div', { className: 'codingns-magpie-inline-empty' }, t(dashboard === null && loading ? 'magpie.loading' : dashboard?.quotaHistoryStatus === 'available' ? 'magpie.noHistory' : 'magpie.historyUnavailable'))
        : createElement('div', { className: 'codingns-magpie-history-grid' }, ...quotaHistory.map((history) => createElement(QuotaHistoryCard, { key: `${history.provider}:${history.user ?? ''}`, history }))),
    ),
  )
}

function StatStrip({ stats }: { readonly stats: readonly { readonly label: string; readonly value: string; readonly detail?: string | undefined }[] }): ReactElement {
  return createElement('div', { className: 'codingns-magpie-statstrip' },
    ...stats.map((stat) => createElement('div', { key: stat.label, className: 'codingns-magpie-statcell' },
      createElement('span', { className: 'codingns-magpie-statcell-label' }, stat.label),
      createElement('strong', { className: 'codingns-magpie-statcell-value' }, stat.value),
      stat.detail !== undefined && stat.detail !== '' && createElement('small', { className: 'codingns-magpie-statcell-detail' }, stat.detail),
    )),
  )
}

function BarChart({ points, metric, label }: { readonly points: readonly MagpieUsageSeriesPoint[]; readonly metric: ChartMetric; readonly label: string }): ReactElement {
  const values = points.map((point) => metric === 'calls'
    ? point.calls
    : metric === 'tokens' ? sumNullable(point.inputTokens, point.outputTokens) : point.cost)
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (known.length === 0) return createElement('div', { className: 'codingns-magpie-inline-empty' }, '—')
  const max = Math.max(1, ...known)
  const labelEvery = Math.max(1, Math.ceil(points.length / 12))
  return createElement('div', { className: 'codingns-magpie-barchart' },
    createElement('div', { className: 'codingns-magpie-barchart-plot', role: 'img', 'aria-label': label },
      ...points.map((point, index) => {
        const value = values[index] ?? null
        const height = value === null || !Number.isFinite(value) ? 0 : Math.max(2, (value / max) * 100)
        return createElement('div', { key: `${point.time ?? point.label ?? index}`, className: 'codingns-magpie-bar-slot', title: `${point.label ?? point.time ?? ''} ${value === null ? '—' : formatValue(value)}` },
          createElement('span', { className: 'codingns-magpie-bar', style: { height: `${height}%` } },
            value !== null && createElement('span', { className: 'codingns-magpie-bar-cap' }),
          ),
        )
      }),
    ),
    createElement('div', { className: 'codingns-magpie-barchart-axis' },
      ...points.flatMap((point, index) => index % labelEvery === 0
        ? [createElement('span', { key: `${point.time ?? index}`, className: 'codingns-magpie-barchart-tick' }, point.label ?? '')]
        : []),
    ),
    createElement('div', { className: 'codingns-magpie-barchart-peak' }, formatValue(Math.max(...known))),
  )
}

function ProgressSection({ title, rows, t, onOpen, header, limit = 8 }: {
  readonly title: string
  readonly rows: readonly (MagpieUsageGroup & { readonly label?: string })[]
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly onOpen?: (row: MagpieUsageGroup) => void
  readonly header?: ReactElement
  readonly limit?: number
}): ReactElement {
  const sorted = [...rows].sort((left, right) => (right.cost ?? -1) - (left.cost ?? -1) || (right.calls ?? -1) - (left.calls ?? -1))
  const display = limit === undefined ? sorted : sorted.slice(0, limit)
  const hasCost = display.some((row) => row.cost !== null)
  const max = Math.max(1, ...display.map((row) => hasCost ? row.cost ?? 0 : sumNullable(row.inputTokens, row.outputTokens) ?? 0))
  return createElement('section', { className: 'codingns-magpie-panel codingns-magpie-progress-panel' },
    createElement('div', { className: 'codingns-magpie-panel-head' }, createElement('h2', undefined, title), header),
    display.length === 0
      ? createElement('div', { className: 'codingns-magpie-inline-empty' }, '—')
      : createElement('div', { className: 'codingns-magpie-progress-list' }, ...display.map((row) => {
        const label = row.label ?? row.name ?? row.model ?? row.account ?? row.provider ?? row.agent ?? row.id
        const weight = Math.max(0, (hasCost ? row.cost ?? 0 : sumNullable(row.inputTokens, row.outputTokens) ?? 0))
        const body = createElement('div', { className: 'codingns-magpie-progress-row' },
          createElement('div', { className: 'codingns-magpie-progress-head' },
            createElement('span', { className: 'codingns-magpie-provider-inline' },
              createElement(MagpieProviderLogo, { identities: [row.agent, row.provider, row.model, row.id], size: 20, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }),
              createElement('span', { className: 'codingns-magpie-progress-copy' },
                createElement('span', { className: 'codingns-magpie-progress-name', title: label }, label),
                (row.account ?? row.provider) !== null && createElement('small', { className: 'codingns-magpie-progress-context', title: row.account ?? row.provider ?? '' }, row.account ?? row.provider)),
            ),
            createElement('strong', { className: 'codingns-magpie-progress-value' }, hasCost ? formatValue(row.cost) : formatCompact(sumNullable(row.inputTokens, row.outputTokens))),
          ),
          createElement('div', { className: 'codingns-magpie-progress-track' },
            createElement('span', { style: { width: `${Math.max(2, (weight / max) * 100)}%` } }),
          ),
          createElement('small', { className: 'codingns-magpie-progress-meta' },
            `${formatInteger(row.calls)} ${t('magpie.metricCalls')} · ${formatCompact(sumNullable(row.inputTokens, row.outputTokens))} token · ${formatValue(row.cost)}`,
          ),
        )
        return onOpen === undefined
          ? createElement('div', { key: row.id, className: 'codingns-magpie-progress-item' }, body)
          : createElement('button', { key: row.id, type: 'button', className: 'codingns-magpie-progress-item is-button', onClick: () => onOpen(row) }, body)
      })),
  )
}

/**
 * 一个厂商的订阅卡：卡头是厂商本身，卡内按账号分段列出额度。
 *
 * 同一厂商的多个账号（如 WorkBuddy 的 4 个）共用一张卡，避免每个账号各占一张卡导致
 * 同类账号被拆散在网格各处；单账号厂商的读法与改造前一致。
 */
function QuotaGroupCard({ group, t }: {
  readonly group: ReturnType<typeof groupQuotaRowsByProvider<MagpieDashboardQuota>>[number]
  readonly t: (key: string, params?: Record<string, string | number>) => string
}): ReactElement {
  const first = group.accounts[0]!
  // 多账号厂商默认只展开第一个账号：4 个账号全展开会把整页撑成一列长卡片。
  const [expanded, setExpanded] = useState(false)
  const multi = group.accounts.length > 1
  const visible = multi && !expanded ? group.accounts.slice(0, 1) : group.accounts
  const hidden = group.accounts.length - visible.length
  return createElement('article', { className: 'codingns-magpie-panel codingns-magpie-quota-card' },
    createElement('div', { className: 'codingns-magpie-quota-topline' },
      createElement(MagpieProviderLogo, { identities: [group.provider, group.name], logoDataUrl: group.logoDataUrl, size: 52, className: 'codingns-magpie-quota-icon codingns-magpie-provider-logo' }),
      createElement('div', undefined,
        createElement('h2', undefined, group.name || group.provider),
        createElement('p', undefined, first.plan ?? first.kind ?? group.provider),
      ),
      multi && createElement('button', {
        type: 'button',
        className: 'codingns-magpie-quota-count',
        'aria-expanded': expanded,
        onClick: () => setExpanded((value) => !value),
        title: expanded ? t('magpie.quotaShowMainAccount') : t('magpie.quotaShowAllAccounts'),
      },
        expanded
          ? t('magpie.quotaAccounts', { count: group.accounts.length })
          : `${t('magpie.quotaAccounts', { count: group.accounts.length })} · ${t('magpie.quotaRemainingAccounts', { count: hidden })}`,
      ),
    ),
    ...visible.map((quota, index) => createElement(QuotaAccountSection, {
      key: `${group.provider}:${quota.user ?? index}`,
      quota,
      t,
      // 单账号时不重复显示账号段头，保持与改造前一致的读法。
      showHeading: multi,
    })),
  )
}

/** 卡内单个账号：账号行、窗口进度条与每日用量。 */
function QuotaAccountSection({ quota, t, showHeading }: {
  readonly quota: MagpieDashboardQuota
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly showHeading: boolean
}): ReactElement {
  // `daily` 现在带 `since`，按日点位于 `days` 里。
  const dailyValues = quota.daily.days.map((point) => point.used).filter((value): value is number => value !== null)
  return createElement('div', { className: 'codingns-magpie-quota-account-block' },
    showHeading && createElement('div', { className: 'codingns-magpie-quota-account-head' },
      createElement('strong', undefined, quota.alias ?? quota.name),
      quota.user !== null && createElement('span', undefined, t('magpie.account', { account: quota.user })),
      quota.plan !== null && createElement('small', undefined, quota.plan),
    ),
    !showHeading && quota.user !== null && createElement('div', { className: 'codingns-magpie-quota-account' }, t('magpie.account', { account: quota.user })),
    quota.windows.length === 0
      ? createElement('div', { className: 'codingns-magpie-inline-empty' }, t('magpie.noLimit'))
      : quota.windows.map((window) => {
        const used = window.usedPercent ?? (window.remainingPercent === null ? null : 100 - window.remainingPercent)
        return createElement('div', { key: window.name, className: 'codingns-magpie-quota-window' },
          createElement('div', { className: 'codingns-magpie-quota-window-head' },
            createElement('strong', undefined, window.name),
            createElement('span', undefined, window.remainingPercent === null ? window.display ?? '—' : t('magpie.remaining', { percent: Math.round(window.remainingPercent) })),
          ),
          createElement('div', { className: 'codingns-magpie-track quota-track' }, used === null ? null : createElement('span', { style: { width: `${Math.max(0, Math.min(100, used))}%` } })),
          createElement('div', { className: 'codingns-magpie-quota-foot' },
            createElement('span', undefined, window.amount !== null && window.limit !== null ? `${formatValue(window.amount)} / ${formatValue(window.limit)} ${window.unit ?? ''}` : window.display ?? ''),
            window.resetsAt !== null && createElement('span', undefined, t('magpie.resets', { time: formatTimestamp(window.resetsAt) })),
          ),
        )
      }),
    quota.daily.days.length > 1 && createElement('div', { className: 'codingns-magpie-daily-chart' },
      createElement(Sparkline, { values: dailyValues }),
      createElement('small', undefined, t('magpie.dailyUsage')),
    ),
  )
}

function QuotaHistoryCard({ history }: { readonly history: MagpieQuotaHistory }): ReactElement {
  return createElement('div', { className: 'codingns-magpie-history-card' },
    createElement('div', { className: 'codingns-magpie-provider-inline' },
      createElement(MagpieProviderLogo, { identities: [history.provider], size: 22, className: 'codingns-magpie-provider-logo codingns-magpie-provider-logo-compact', fallback: 'none' }),
      createElement('strong', undefined, history.provider)),
    history.user !== null && createElement('small', undefined, history.user),
    ...history.lines.map((line) => createElement('div', { key: line.name, className: 'codingns-magpie-history-line' },
      createElement('div', { className: 'codingns-magpie-history-line-head' }, createElement('span', undefined, line.name), createElement('span', undefined, line.points.at(-1)?.left === null || line.points.at(-1)?.left === undefined ? '—' : formatValue(line.points.at(-1)!.left))),
      createElement(Sparkline, { values: line.points.map((point) => point.left).filter((value): value is number => value !== null) }),
    )),
  )
}

function Sparkline({ values }: { readonly values: readonly number[] }): ReactElement {
  const max = Math.max(1, ...values)
  const points = values.map((value, index) => `${values.length <= 1 ? 50 : 2 + (index * 96) / (values.length - 1)},${32 - (Math.max(0, value) / max) * 28}`).join(' ')
  return createElement('svg', { className: 'codingns-magpie-sparkline', viewBox: '0 0 100 36', preserveAspectRatio: 'none', 'aria-hidden': true },
    createElement('polyline', { points, fill: 'none' }),
  )
}


function EmptyState({ message, loading = false }: { readonly message: string; readonly loading?: boolean }): ReactElement {
  return createElement('div', { className: `codingns-magpie-empty${loading ? ' is-loading' : ''}`, role: loading ? 'status' : 'note' },
    createElement('span', { className: 'codingns-magpie-empty-mark', 'aria-hidden': true }, loading ? createElement('span', { className: 'codingns-magpie-spinner' }) : '∅'),
    createElement('span', undefined, message),
  )
}

function InlineNotice({ message }: { readonly message: string }): ReactElement {
  return createElement('div', { className: 'codingns-magpie-notice', role: 'status' }, createElement('span', undefined, 'i'), message)
}



/** 刷新图标沿用 DSH 的 1.6 描边简约样式；加载时整体旋转，静默重绘状态下保持静止。 */
function RefreshIcon({ busy = false }: { readonly busy?: boolean }): ReactElement {
  return createElement('svg', {
    className: `codingns-magpie-refresh-icon${busy ? ' is-spinning' : ''}`,
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
    createElement('path', { d: 'M20 11a8 8 0 1 0-2.3 5.6' }), createElement('path', { d: 'M20 4.5V11h-6.5' }),
  )
}


function SearchIcon(): ReactElement {
  return createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true },
    createElement('circle', { cx: 10.8, cy: 10.8, r: 6.8 }), createElement('path', { d: 'm16 16 4.4 4.4' }),
  )
}

export async function callMagpieRpc<T>(rpc: CodingNsRpcClient, action: 'usage/dashboard' | 'usage/requests' | 'management/snapshot' | 'management/provider/update' | 'management/group/update' | 'management/account/update', payload: unknown, signal?: AbortSignal): Promise<T> {
  const result = await callCodingNsRpcResult(rpc, `magpie/${action}`, payload, signal)
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.value as T
}

export function magpieDashboardIssueForRpcError(error: unknown): MagpieDashboardAvailabilityIssue {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''
  if (code === 'CODINGNS_RPC_NOT_FOUND') return 'host-rpc-outdated'
  if (code === 'CODINGNS_MAGPIE_DISABLED') return 'feature-disabled'
  return 'host-request-failed'
}

export function magpieManagementIssueForRpcError(error: unknown): MagpieManagementAvailabilityIssue {
  const record = error !== null && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message : ''
  if (code === 'CODINGNS_RPC_NOT_FOUND'
    || (code === 'Error' && /^Unknown Magpie RPC: management\/(?:snapshot|provider\/update|group\/update|account\/update)$/u.test(message))) {
    return 'host-rpc-outdated'
  }
  if (code === 'CODINGNS_MAGPIE_DISABLED') return 'feature-disabled'
  return 'host-request-failed'
}

function dashboardIssueLocaleKey(issue: MagpieDashboardAvailabilityIssue): string {
  switch (issue) {
    case 'web-api-unavailable': return 'magpie.webApiUnavailable'
    case 'cli-unavailable': return 'magpie.cliUnavailable'
    case 'cli-version-unsupported': return 'magpie.cliVersionUnsupported'
    case 'model-catalog-unavailable': return 'magpie.catalogUnavailable'
    case 'host-rpc-outdated': return 'magpie.hostRpcOutdated'
    case 'feature-disabled': return 'magpie.featureDisabled'
    case 'host-request-failed': return 'magpie.hostRequestFailed'
  }
}

function managementIssueLocaleKey(issue: MagpieManagementAvailabilityIssue): string {
  switch (issue) {
    case 'web-api-unavailable': return 'magpie.webApiUnavailable'
    case 'cli-unavailable': return 'magpie.cliUnavailable'
    case 'cli-version-unsupported': return 'magpie.management.cliVersionUnsupported'
    case 'providers-unavailable': return 'magpie.management.providersUnavailable'
    case 'groups-unavailable': return 'magpie.management.groupsUnavailable'
    case 'accounts-unavailable': return 'magpie.management.accountsUnavailable'
    case 'host-rpc-outdated': return 'magpie.hostRpcOutdated'
    case 'feature-disabled': return 'magpie.featureDisabled'
    case 'host-request-failed': return 'magpie.hostRequestFailed'
  }
}

function sumNullable(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0)
}

/** Collapse raw model rows while retaining an identity only when it is unambiguous. */
export function aggregateModelUsageRows(rows: readonly MagpieUsageGroup[]): readonly MagpieUsageGroup[] {
  const grouped = new Map<string, MagpieUsageGroup>()
  const nameKeys = new Map<string, string>()
  for (const row of rows) {
    const modelKey = modelUsageKey(row)
    if (modelKey === '') continue
    const nameKey = modelUsageNameKey(row)
    // Some Magpie versions qualify the model ID differently for each account. When the
    // account rows share a provider and display name, the display name is the stable model
    // identity and must win over that account-specific ID.
    const groupKey = nameKey === null ? modelKey : nameKeys.get(nameKey) ?? modelKey
    if (nameKey !== null) nameKeys.set(nameKey, groupKey)
    const current = grouped.get(groupKey)
    if (current === undefined) {
      grouped.set(groupKey, { ...row, id: `model:${groupKey}`, account: null })
      continue
    }
    grouped.set(groupKey, {
      ...current,
      name: current.name ?? row.name,
      provider: mergeIdentity(current.provider, row.provider),
      model: current.model ?? row.model,
      agent: mergeIdentity(current.agent, row.agent),
      calls: sumNullable(current.calls, row.calls),
      errors: sumNullable(current.errors, row.errors),
      retried: sumNullable(current.retried, row.retried),
      inputTokens: sumNullable(current.inputTokens, row.inputTokens),
      outputTokens: sumNullable(current.outputTokens, row.outputTokens),
      cacheReadTokens: sumNullable(current.cacheReadTokens, row.cacheReadTokens),
      cacheWriteTokens: sumNullable(current.cacheWriteTokens, row.cacheWriteTokens),
      reasoningTokens: sumNullable(current.reasoningTokens, row.reasoningTokens),
      cost: sumNullable(current.cost, row.cost),
      unpriced: sumNullable(current.unpriced, row.unpriced),
      credits: sumNullable(current.credits, row.credits),
      credited: sumNullable(current.credited, row.credited),
      timed: sumNullable(current.timed, row.timed),
      ttftMs: sumNullable(current.ttftMs, row.ttftMs),
      decodeMs: sumNullable(current.decodeMs, row.decodeMs),
      decodeTokens: sumNullable(current.decodeTokens, row.decodeTokens),
      decodeCount: sumNullable(current.decodeCount, row.decodeCount),
    })
  }
  return [...grouped.values()]
}

/** Return rows with unique React identities so duplicate Magpie IDs cannot leak across modes. */
export function modelBreakdownRows(rows: readonly MagpieUsageGroup[], mode: ModelBreakdownMode): readonly MagpieUsageGroup[] {
  if (mode === 'aggregate') return aggregateModelUsageRows(rows)
  const seen = new Map<string, number>()
  return rows.map((row, index) => {
    const baseId = row.id.trim() || `row-${index}`
    const occurrence = seen.get(baseId) ?? 0
    seen.set(baseId, occurrence + 1)
    return occurrence === 0 ? row : { ...row, id: `${baseId}#${occurrence}` }
  })
}

function modelUsageKey(row: MagpieUsageGroup): string {
  return (row.model ?? row.name ?? row.id).trim().toLocaleLowerCase()
}

function modelUsageNameKey(row: MagpieUsageGroup): string | null {
  if (row.account === null) return null
  const name = row.name?.trim().toLocaleLowerCase() ?? ''
  const provider = row.provider?.trim().toLocaleLowerCase() ?? ''
  return name === '' ? null : `${provider}\u0000${name}`
}

function mergeIdentity(left: string | null, right: string | null): string | null {
  if (left === null) return right
  if (right === null || left === right) return left
  return null
}

function formatInteger(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function formatCompact(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatValue(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 100 ? 1 : 4 }).format(value)
}

function formatTimestamp(value: string | null): string {
  if (value === null) return '—'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed)
}

const pageStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0, boxSizing: 'border-box',
  paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
  color: 'var(--dsw-alias-label-primary,CanvasText)', background: 'var(--mp-surface)',
  border: 0, borderRadius: 0, boxShadow: 'none', overflow: 'hidden',
}

const MAGPIE_PAGE_CSS = `
.codingns-magpie-page{--mp-accent:var(--dsw-alias-state-business-primary,#4176e6);--mp-chart:var(--mp-accent);--mp-ink:var(--dsw-alias-label-primary,CanvasText);--mp-muted:var(--dsw-alias-label-tertiary,GrayText);--mp-caption:var(--dsw-alias-label-caption,GrayText);--mp-line:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--mp-line-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.12));--mp-card:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,transparent));--mp-layer:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06)));--mp-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));--mp-surface:var(--dsw-alias-bg-base,Canvas);--mp-radius:var(--dsw-radius-lg,12px);display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;font:inherit;color:var(--mp-ink);background:var(--mp-surface)}
.codingns-magpie-page *{box-sizing:border-box}
.codingns-magpie-topbar{flex:0 0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:12px;min-height:56px;padding:var(--mp-topbar-pad-y) calc(var(--mp-topbar-pad-x) + var(--mp-leading-inset));border-bottom:.5px solid var(--mp-line-strong);background:var(--mp-surface)}
.codingns-magpie-topbar-left{display:flex;align-items:center;justify-self:start;min-width:0;max-width:100%}
.codingns-magpie-topbar-right{display:flex;align-items:center;justify-self:end;gap:8px;min-width:0}
.codingns-magpie-icon-button{display:grid;place-items:center;flex:0 0 auto;width:30px;height:30px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--mp-muted);cursor:pointer;transition:background .15s,color .15s}
.codingns-magpie-icon-button:hover{background:var(--mp-hover);color:var(--mp-ink)}
.codingns-magpie-icon-button:active{background:var(--mp-layer)}
.codingns-magpie-icon-button:focus-visible{outline:2px solid color-mix(in srgb,var(--mp-accent) 55%,transparent);outline-offset:1px}
.codingns-magpie-icon-button:disabled{opacity:.5;cursor:default;background:transparent;color:var(--mp-muted)}
.codingns-magpie-refresh-icon{display:block;flex:0 0 auto;transition:transform .2s}
.codingns-magpie-refresh-icon.is-spinning{animation:magpie-spin .9s linear infinite}
@media(prefers-reduced-motion:reduce){.codingns-magpie-refresh-icon.is-spinning{animation:none}}
.codingns-magpie-tabs{display:flex;align-items:center;justify-content:center;gap:2px;justify-self:center;min-width:0;overflow-x:auto;scrollbar-width:none}
.codingns-magpie-tabs::-webkit-scrollbar{display:none}
.codingns-magpie-tab{position:relative;display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;min-height:42px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--mp-muted);font:inherit;font-size:${uiFontSize(13)};white-space:nowrap;cursor:pointer;transition:color .16s,background .16s}
.codingns-magpie-tab:hover{color:var(--mp-ink);background:var(--mp-hover)}
.codingns-magpie-tab.is-active{background:transparent;color:var(--mp-ink);font-weight:600;box-shadow:none}
.codingns-magpie-tab.is-active:after{content:'';position:absolute;left:10px;right:10px;bottom:0;height:2px;border-radius:2px;background:var(--mp-accent)}
.codingns-magpie-tab-icon{display:grid;place-items:center;width:15px;font-size:${uiFontSize(13)};line-height:1;opacity:.85}
.codingns-magpie-toolbar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:46px;padding:0 20px;border-bottom:.5px solid var(--mp-line);background:var(--mp-surface)}
.codingns-magpie-toolbar-left{display:flex;align-items:center;gap:12px;min-width:0}
.codingns-magpie-periods{flex-direction:row;overflow:auto;display:flex;align-items:center;gap:2px;min-width:0;padding:2px;border-radius:999px;background:var(--mp-layer);scrollbar-width:none}
.codingns-magpie-periods::-webkit-scrollbar{display:none}
.codingns-magpie-period{flex:0 0 auto;min-height:26px;padding:0 12px;border:0;border-radius:999px;background:transparent;color:var(--mp-muted);font:inherit;font-size:${uiFontSize(13)};white-space:nowrap;cursor:pointer;transition:background .16s,color .16s}
.codingns-magpie-period:hover{color:var(--mp-ink)}
.codingns-magpie-period.is-active{background:var(--mp-surface);color:var(--mp-ink);font-weight:600;box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.12))}
.codingns-magpie-live-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#3f9d6b);box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-success-primary,#3f9d6b) 12%,transparent)}
.codingns-magpie-main{flex:1 1 0;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;background:var(--mp-surface)}
.codingns-magpie-view{max-width:1320px;margin:0 auto;padding:18px clamp(16px,2.4vw,28px) 40px}
.codingns-magpie-view-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:0 0 19px}
.codingns-magpie-view-heading h1{margin:5px 0 0;font-size:${uiFontSize(27)};line-height:1.1;letter-spacing:-.045em}
.codingns-magpie-panel{min-width:0;border:.5px solid var(--mp-line);border-radius:var(--mp-radius);background:var(--mp-card)}
.codingns-magpie-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px}
.codingns-magpie-panel-head h2{margin:0;font-size:${uiFontSize(14)};font-weight:600}.codingns-magpie-panel-head p{margin:4px 0 0;color:var(--mp-muted);font-size:${uiFontSize(13)};line-height:1.5}
.codingns-magpie-chart-switch{display:flex;flex-wrap:wrap;gap:2px;padding:2px;border:0;border-radius:999px;background:var(--mp-layer)}
.codingns-magpie-chart-switch button{border:0;border-radius:999px;padding:5px 10px;background:transparent;color:var(--mp-muted);font:inherit;font-size:${uiFontSize(12)};cursor:pointer}.codingns-magpie-chart-switch button.is-active{background:var(--mp-surface);color:var(--mp-ink);font-weight:600;box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.12))}
.codingns-magpie-track{height:4px;margin:7px 0 5px;border-radius:99px;background:var(--mp-hover);overflow:hidden}.codingns-magpie-track span{display:block;height:100%;min-width:2px;border-radius:inherit;background:linear-gradient(90deg,var(--mp-accent),color-mix(in srgb,var(--mp-accent) 55%,transparent));transition:width .35s ease}
.codingns-magpie-text-button{border:0;background:transparent;color:var(--dsw-alias-link,var(--mp-accent));font:inherit;font-size:${uiFontSize(13)};font-weight:600;cursor:pointer}.codingns-magpie-text-button:hover{text-decoration:underline}
.codingns-magpie-search{display:flex;align-items:center;gap:9px;max-width:420px;margin:0 0 14px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:10px;color:var(--mp-muted);background:var(--mp-card)}.codingns-magpie-search input{width:100%;border:0;outline:0;background:transparent;color:var(--mp-ink);font:inherit;font-size:${uiFontSize(13)}}
.codingns-magpie-request-panel{overflow:hidden}.codingns-magpie-table-scroll{overflow:auto;overscroll-behavior-inline:contain}.codingns-magpie-table{width:100%;min-width:880px;border-collapse:collapse}.codingns-magpie-table th{padding:9px 12px;border-bottom:.5px solid var(--mp-line);color:var(--mp-caption);font-size:${uiFontSize(13)};font-weight:600;text-align:left;white-space:nowrap}.codingns-magpie-table td{max-width:250px;padding:10px 12px;border-bottom:.5px solid var(--mp-line);font-size:${uiFontSize(13)};vertical-align:middle}.codingns-magpie-table tbody tr:last-child td{border-bottom:0}.codingns-magpie-table tbody tr:hover{background:var(--mp-card)}
.codingns-magpie-time-cell{white-space:nowrap;color:var(--mp-muted)}.codingns-magpie-provider-name,.codingns-magpie-route-model{display:block;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:620}.codingns-magpie-table-secondary{display:block;max-width:220px;margin-top:3px;overflow:hidden;color:var(--mp-caption);font-size:${uiFontSize(12)};text-overflow:ellipsis;white-space:nowrap}.codingns-magpie-cost-cell{font-variant-numeric:tabular-nums}
.codingns-magpie-status{display:inline-block;padding:2px 7px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 12%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#a06a2c));font-size:${uiFontSize(12)};font-variant-numeric:tabular-nums}.codingns-magpie-status.is-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3f9d6b) 12%,transparent);color:var(--dsw-alias-state-success-primary,#3f9d6b)}
.codingns-magpie-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-top:.5px solid var(--mp-line);color:var(--mp-muted);font-size:${uiFontSize(13)}}.codingns-magpie-pagination div{display:flex;gap:6px}.codingns-magpie-pagination button{min-height:28px;padding:0 10px;border:.5px solid var(--mp-line-strong);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--mp-ink);font:inherit;font-size:${uiFontSize(13)};cursor:pointer}.codingns-magpie-pagination button:disabled{opacity:.4;cursor:not-allowed}
.codingns-magpie-quota-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:13px}.codingns-magpie-quota-card{padding:17px}.codingns-magpie-quota-topline{display:flex;align-items:center;gap:10px;margin-bottom:13px}.codingns-magpie-quota-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--mp-layer);color:var(--mp-accent);font-weight:700}.codingns-magpie-quota-topline h2{margin:0;font-size:${uiFontSize(14)};font-weight:600}.codingns-magpie-quota-topline p{margin:3px 0 0;color:var(--mp-caption);font-size:${uiFontSize(13)}}.codingns-magpie-quota-account{margin:-5px 0 11px;color:var(--mp-muted);font-size:${uiFontSize(13)}}.codingns-magpie-quota-count{margin-left:auto;flex:none;min-height:26px;padding:0 9px;border:1px solid var(--mp-line);border-radius:999px;background:transparent;color:var(--mp-muted);font-size:${uiFontSize(12)};cursor:pointer;white-space:nowrap}.codingns-magpie-quota-count:hover{color:var(--mp-fg);border-color:var(--mp-accent)}.codingns-magpie-quota-count:focus-visible{outline:none;box-shadow:0 0 0 2px var(--mp-accent)}.codingns-magpie-quota-account-block + .codingns-magpie-quota-account-block{margin-top:12px;padding-top:11px;border-top:1px solid var(--mp-line)}.codingns-magpie-quota-account-head{display:flex;align-items:baseline;gap:8px;min-width:0;margin-bottom:9px;font-size:${uiFontSize(13)}}.codingns-magpie-quota-account-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.codingns-magpie-quota-account-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mp-muted);font-size:${uiFontSize(12)}}.codingns-magpie-quota-account-head small{margin-left:auto;flex:none;color:var(--mp-caption);font-size:${uiFontSize(12)}}
.codingns-magpie-quota-window{padding:11px 0;border-top:.5px solid var(--mp-line)}.codingns-magpie-quota-window-head,.codingns-magpie-quota-foot,.codingns-magpie-history-line-head{display:flex;align-items:center;justify-content:space-between;gap:9px}.codingns-magpie-quota-window-head{font-size:${uiFontSize(13)};font-weight:500}.codingns-magpie-quota-window-head span{color:var(--mp-muted);font-variant-numeric:tabular-nums}.quota-track{height:6px}.quota-track span{background:linear-gradient(90deg,var(--mp-accent),color-mix(in srgb,var(--mp-accent) 55%,transparent))}.codingns-magpie-quota-foot{color:var(--mp-caption);font-size:${uiFontSize(12)}}
.codingns-magpie-daily-chart{display:grid;grid-template-columns:1fr auto;align-items:center;gap:9px;margin-top:4px;padding-top:10px;border-top:.5px solid var(--mp-line);color:var(--mp-muted);font-size:${uiFontSize(12)}}.codingns-magpie-sparkline{width:100%;height:30px;overflow:visible}.codingns-magpie-sparkline polyline{stroke:var(--mp-accent);stroke-width:2;vector-effect:non-scaling-stroke}
.codingns-magpie-history-panel{padding:17px;margin-top:14px}.codingns-magpie-history-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.codingns-magpie-history-card{padding:12px;border:1px solid var(--mp-line);border-radius:9px;background:var(--mp-card)}.codingns-magpie-history-card>strong,.codingns-magpie-history-card>small{display:block}.codingns-magpie-history-card>strong{font-size:${uiFontSize(13)};font-weight:600}.codingns-magpie-history-card>small{margin-top:3px;color:var(--mp-caption);font-size:${uiFontSize(12)}}.codingns-magpie-history-line{margin-top:10px}.codingns-magpie-history-line-head{font-size:${uiFontSize(12)}}.codingns-magpie-history-line-head span:last-child{font-variant-numeric:tabular-nums;font-weight:650}
.codingns-magpie-management-grid{display:grid;grid-template-columns:minmax(190px,260px) minmax(0,1fr);align-items:start;gap:12px}.codingns-magpie-management-list{max-height:calc(100vh - 190px);overflow:auto;padding:5px}.codingns-magpie-management-row{width:100%;display:flex;align-items:center;justify-content:space-between;gap:9px;min-height:48px;padding:8px 10px;border:0;border-bottom:.5px solid var(--mp-line);background:transparent;color:var(--mp-ink);font:inherit;text-align:left;cursor:pointer}.codingns-magpie-management-row:last-child{border-bottom:0}.codingns-magpie-management-row:hover,.codingns-magpie-management-row.is-active{background:var(--mp-hover)}.codingns-magpie-management-row.is-active{box-shadow:inset 2px 0 var(--mp-accent)}.codingns-magpie-management-row-main{display:flex;flex-direction:column;gap:3px;min-width:0}.codingns-magpie-management-row-main strong,.codingns-magpie-management-row-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.codingns-magpie-management-row-main strong{font-size:${uiFontSize(13)};font-weight:600}.codingns-magpie-management-row-main small{color:var(--mp-caption);font-size:${uiFontSize(12)}}.codingns-magpie-state{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;padding:3px 7px;border-radius:999px;background:var(--mp-layer);color:var(--mp-muted);font-size:${uiFontSize(11)};font-weight:700}.codingns-magpie-state:before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}.codingns-magpie-state.is-on{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3f9d6b) 12%,transparent);color:var(--mp-accent)}.codingns-magpie-state.is-off{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 12%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#a06a2c))}.codingns-magpie-management-editor{padding:17px}.codingns-magpie-management-statusline{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:-2px 0 13px;color:var(--mp-muted);font-size:${uiFontSize(13)}}.codingns-magpie-management-note{margin-bottom:13px;padding:9px 11px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 26%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 8%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#a06a2c));font-size:${uiFontSize(12)};line-height:1.5}.codingns-magpie-field{display:flex;flex:1 1 150px;flex-direction:column;gap:6px;min-width:0;margin:0 0 12px;color:var(--mp-muted);font-size:${uiFontSize(13)};font-weight:500}.codingns-magpie-field small{font-size:${uiFontSize(11)};font-weight:400;line-height:1.4}.codingns-magpie-field input,.codingns-magpie-field select,.codingns-magpie-field textarea{width:100%;min-width:0;box-sizing:border-box;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-sm,8px);background:var(--mp-card);color:var(--mp-ink);font:inherit;font-size:${uiFontSize(13)};outline:none}.codingns-magpie-field textarea{resize:vertical;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.codingns-magpie-field-row{display:flex;gap:9px;align-items:stretch}.codingns-magpie-management-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:7px;margin-top:10px}.codingns-magpie-management-actions button{min-height:32px;padding:0 12px;border:.5px solid var(--mp-line-strong);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--mp-ink);font:inherit;font-size:${uiFontSize(13)};cursor:pointer}.codingns-magpie-management-actions button.is-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--mp-accent));color:var(--dsw-alias-label-primary-foreground,#fff)}.codingns-magpie-management-actions button:disabled{opacity:.45;cursor:not-allowed}.codingns-magpie-confirm{display:grid;gap:7px;margin:12px 0;padding:11px;border:1px solid rgba(59,126,98,.24);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3f9d6b) 8%,transparent);font-size:${uiFontSize(11)}}.codingns-magpie-confirm>span{overflow-wrap:anywhere;color:var(--mp-muted);line-height:1.5}.codingns-magpie-management-message{margin-top:10px;color:var(--mp-accent);font-size:${uiFontSize(11)}}.codingns-magpie-management-account-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.codingns-magpie-management-account{padding:16px}.codingns-magpie-management-balance{margin:8px 0;color:var(--mp-ink);font-size:${uiFontSize(14)};font-weight:700}.codingns-magpie-management-window{padding:10px 0;border-top:1px solid var(--mp-line)}.codingns-magpie-management-window>small,.codingns-magpie-management-readat{display:block;margin-top:5px;color:var(--mp-muted);font-size:${uiFontSize(11)}}.codingns-magpie-management-members{display:flex;flex-wrap:wrap;gap:5px;margin:-2px 0 13px}.codingns-magpie-member-chip{max-width:100%;overflow:hidden;padding:4px 7px;border:1px solid var(--mp-line);border-radius:6px;background:var(--mp-card);color:var(--mp-ink);font-size:${uiFontSize(11)};text-overflow:ellipsis;white-space:nowrap}.codingns-magpie-member-chip.is-muted{opacity:.55}.codingns-magpie-management-policy{flex:0 0 auto;color:var(--mp-muted);font-size:${uiFontSize(11)}}.codingns-magpie-checkbox{display:flex;align-items:center;gap:8px;margin:2px 0 12px;color:var(--mp-ink);font-size:${uiFontSize(11)}}.codingns-magpie-checkbox input{accent-color:var(--mp-accent)}.codingns-magpie-management-empty{display:flex;min-height:150px;align-items:center;justify-content:center;padding:24px;color:var(--mp-muted);font-size:${uiFontSize(13)};text-align:center}.codingns-magpie-model-editor{display:grid;gap:4px;padding:8px;border:1px solid var(--mp-line);border-radius:8px;background:var(--mp-card)}.codingns-magpie-model-actions{display:flex;gap:6px;flex-wrap:wrap}.codingns-magpie-model-actions button,.codingns-magpie-group-model-actions button{min-height:28px;padding:0 8px;border:1px solid var(--mp-line);border-radius:6px;background:transparent;color:var(--mp-ink);font:inherit;font-size:${uiFontSize(11)};cursor:pointer}.codingns-magpie-model-actions button:disabled,.codingns-magpie-group-model-actions button:disabled{opacity:.45;cursor:not-allowed}.codingns-magpie-model-option{display:flex;align-items:center;gap:9px;min-width:0;min-height:40px;padding:6px 9px;border:.5px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--mp-ink);font-weight:400}.codingns-magpie-model-option:hover{border-color:var(--mp-line-strong);background:var(--mp-hover)}.codingns-magpie-model-option input,.codingns-magpie-group-model-check input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--mp-accent)}.codingns-magpie-model-option-copy{display:flex;flex:1 1 auto;min-width:0;overflow:hidden;flex-direction:column;gap:3px}.codingns-magpie-model-name{display:block;min-width:0;overflow:hidden;color:var(--mp-ink);font-size:${uiFontSize(13)};font-weight:600;line-height:1.3;text-overflow:ellipsis;white-space:nowrap}.codingns-magpie-model-meta{display:flex;align-items:center;min-width:0;gap:7px;color:var(--mp-caption);font-size:${uiFontSize(12)};line-height:1.25}.codingns-magpie-model-provider,.codingns-magpie-model-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.codingns-magpie-model-provider{font-weight:650}.codingns-magpie-model-id{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--mp-muted)}.codingns-magpie-group-model-editor{display:grid;gap:6px;padding:10px;border:1px solid var(--mp-line);border-radius:9px;background:var(--mp-card)}.codingns-magpie-group-model-option{display:flex;align-items:center;gap:8px;min-width:0;min-height:45px;padding:6px 8px;border:1px solid transparent;border-radius:7px;background:var(--mp-surface);color:var(--mp-ink);transition:border-color .15s,background .15s,box-shadow .15s}.codingns-magpie-group-model-option:hover{border-color:color-mix(in srgb,var(--mp-accent) 48%,transparent);background:color-mix(in srgb,var(--mp-accent) 5%,transparent)}.codingns-magpie-group-model-option.is-selected{cursor:grab;border-color:color-mix(in srgb,var(--mp-accent) 32%,transparent);background:color-mix(in srgb,var(--mp-accent) 5%,transparent);box-shadow:inset 2px 0 var(--mp-accent)}.codingns-magpie-group-model-option.is-dragging{opacity:.55;box-shadow:inset 2px 0 var(--mp-accent),0 5px 14px rgba(30,70,50,.12)}.codingns-magpie-group-model-check{display:flex;align-items:center;flex:1 1 auto;gap:8px;min-width:0;cursor:pointer}.codingns-magpie-group-model-actions{display:flex;align-items:center;flex:0 0 auto;gap:4px}.codingns-magpie-group-model-actions button{display:grid;place-items:center;width:26px;height:26px;min-height:26px;padding:0;border-radius:6px;font-size:${uiFontSize(13)};line-height:1}.codingns-magpie-group-model-order{display:grid;place-items:center;flex:0 0 20px;width:20px;height:20px;border-radius:5px;background:var(--mp-card);color:var(--mp-muted);font-size:${uiFontSize(11)};font-variant-numeric:tabular-nums}.codingns-magpie-group-model-add{display:flex;align-items:center;gap:8px;margin-top:3px;padding-top:8px;border-top:.5px solid var(--mp-line);color:var(--mp-muted)}.codingns-magpie-group-model-add-icon{display:grid;place-items:center;flex:0 0 20px;width:20px;height:20px;border:1px dashed var(--mp-line);border-radius:5px;color:var(--mp-accent);font-size:${uiFontSize(16)};line-height:1}.codingns-magpie-group-model-add select{flex:1 1 auto;min-width:0;min-height:32px;padding:5px 8px;border:1px solid var(--mp-line);border-radius:7px;background:var(--mp-surface);color:var(--mp-ink);font:inherit;font-size:${uiFontSize(11)}}.codingns-magpie-management-empty{display:flex;min-height:150px;align-items:center;justify-content:center;padding:24px;color:var(--mp-muted);font-size:${uiFontSize(13)};text-align:center}
.codingns-magpie-empty{min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px;padding:24px;color:var(--mp-muted);font-size:${uiFontSize(13)};text-align:center}.codingns-magpie-empty-mark{display:grid;place-items:center;width:38px;height:38px;border:.5px solid var(--mp-line);border-radius:12px;color:var(--mp-muted);font-size:${uiFontSize(18)}}.codingns-magpie-spinner{width:16px;height:16px;border:2px solid var(--mp-line);border-top-color:var(--mp-accent);border-radius:50%;animation:magpie-spin .8s linear infinite}.codingns-magpie-inline-empty{padding:18px;color:var(--mp-muted);font-size:${uiFontSize(12)}}.codingns-magpie-notice{display:flex;align-items:center;gap:8px;margin:-5px 0 12px;padding:9px 11px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 26%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 10%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#a06a2c));font-size:${uiFontSize(13)}}.codingns-magpie-notice span{display:grid;place-items:center;width:17px;height:17px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 15%,transparent);font-weight:700}
.codingns-magpie-usage-tabs{display:flex;align-items:center;gap:2px;min-width:0;padding:2px;border-radius:999px;background:var(--mp-layer);overflow-x:auto;scrollbar-width:none}
.codingns-magpie-usage-tabs::-webkit-scrollbar{display:none}
.codingns-magpie-usage-tab{flex:0 0 auto;min-height:26px;padding:0 13px;border:0;border-radius:999px;background:transparent;color:var(--mp-muted);font:inherit;font-size:${uiFontSize(13)};white-space:nowrap;cursor:pointer;transition:background .16s,color .16s}
.codingns-magpie-usage-tab:hover{color:var(--mp-ink)}
.codingns-magpie-usage-tab.is-active{background:var(--mp-surface);color:var(--mp-ink);font-weight:600;box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.12))}
.codingns-magpie-statstrip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border:.5px solid var(--mp-line);border-radius:var(--mp-radius);background:var(--mp-card);margin-bottom:14px;overflow:hidden}
.codingns-magpie-statcell{display:flex;flex-direction:column;gap:5px;min-width:0;padding:15px 18px;border-left:.5px solid var(--mp-line)}
.codingns-magpie-statcell:first-child{border-left:0}
.codingns-magpie-statcell-label{color:var(--mp-muted);font-size:${uiFontSize(13)}}
.codingns-magpie-statcell-value{font-size:${uiFontSize(22)};line-height:1.1;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums;color:var(--mp-ink)}
.codingns-magpie-statcell-detail{color:var(--mp-caption);font-size:${uiFontSize(13)};line-height:1.4}
.codingns-magpie-barchart-panel{padding:16px 18px 14px;margin-bottom:14px}
.codingns-magpie-barchart{position:relative;display:flex;flex-direction:column;gap:8px}
.codingns-magpie-barchart-plot{display:flex;align-items:flex-end;gap:2px;height:170px;padding:8px 0 0;border-bottom:.5px solid var(--mp-line)}
.codingns-magpie-bar-slot{flex:1 1 0;display:flex;align-items:flex-end;justify-content:center;height:100%;min-width:2px}
.codingns-magpie-bar{display:block;width:100%;max-width:26px;min-height:2px;border-radius:2px 2px 0 0;background:color-mix(in srgb,var(--mp-accent) 32%,transparent);transition:height .3s ease}
.codingns-magpie-bar-cap{display:block;width:100%;height:4px;border-radius:2px 2px 0 0;background:var(--mp-accent)}
.codingns-magpie-barchart-axis{display:flex;justify-content:space-between;gap:4px;color:var(--mp-caption);font-size:${uiFontSize(12)}}
.codingns-magpie-barchart-tick{flex:0 0 auto;white-space:nowrap}
.codingns-magpie-barchart-peak{position:absolute;top:0;left:0;padding:0 4px;border-radius:4px;background:var(--mp-surface);color:var(--mp-caption);font-size:${uiFontSize(12)}}
.codingns-magpie-progress-panel{padding:16px 18px 8px;margin-bottom:14px}
.codingns-magpie-progress-list{display:flex;flex-direction:column}
.codingns-magpie-progress-item{display:block;width:100%;padding:11px 0;border:0;border-top:.5px solid var(--mp-line);background:transparent;color:var(--mp-ink);font:inherit;text-align:left}
.codingns-magpie-progress-item.is-button{cursor:pointer;border-radius:8px;padding-left:6px;padding-right:6px;transition:background .14s}
.codingns-magpie-progress-item.is-button:hover{background:var(--mp-hover)}
.codingns-magpie-progress-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.codingns-magpie-progress-copy{display:flex;flex:1 1 auto;min-width:0;overflow:hidden;flex-direction:column;gap:1px}.codingns-magpie-progress-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:${uiFontSize(13)}}
.codingns-magpie-progress-context{min-width:0;overflow:hidden;color:var(--mp-caption);font-size:${uiFontSize(11)};text-overflow:ellipsis;white-space:nowrap}
.codingns-magpie-progress-value{flex:0 0 auto;font-size:${uiFontSize(13)};font-weight:600;font-variant-numeric:tabular-nums}
.codingns-magpie-progress-track{height:4px;border-radius:99px;background:var(--mp-hover);overflow:hidden}
.codingns-magpie-progress-track span{display:block;height:100%;min-width:2px;border-radius:inherit;background:linear-gradient(90deg,var(--mp-chart,var(--mp-accent)),color-mix(in srgb,var(--mp-chart,var(--mp-accent)),transparent 45%))}
.codingns-magpie-progress-meta{display:block;margin-top:5px;color:var(--mp-caption);font-size:${uiFontSize(12)}}
.codingns-magpie-chiprow{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.codingns-magpie-chip{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;min-height:28px;padding:0 12px;border:.5px solid var(--mp-line-strong);border-radius:999px;background:transparent;color:var(--mp-muted);font:inherit;font-size:${uiFontSize(13)};cursor:pointer;transition:background .14s,color .14s,border-color .14s}
.codingns-magpie-chip:hover{color:var(--mp-ink)}
.codingns-magpie-chip.is-active{background:var(--dsw-alias-button-primary-fill,var(--mp-accent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.codingns-magpie-filterrow{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.codingns-magpie-grow{flex:1 1 auto;max-width:none;margin:0}
.codingns-magpie-provider-logo{display:grid;flex:0 0 auto;place-items:center;box-sizing:border-box;object-fit:contain;padding:3px;border-radius:10px;background:var(--mp-layer);color:var(--mp-accent);font-size:${uiFontSize(12)};font-weight:750}
.codingns-magpie-provider-logo-compact{border-radius:7px;padding:2px}
.codingns-magpie-provider-inline{display:inline-flex;align-items:center;gap:7px;min-width:0}
.codingns-magpie-provider-heading{display:flex;align-items:center;gap:10px}
.codingns-magpie-filter-summary{color:var(--mp-muted);font-size:${uiFontSize(12)};white-space:nowrap}
.codingns-magpie-toplist-panel{padding:16px 18px 8px}
.codingns-magpie-toprow{display:flex;align-items:center;gap:12px;width:100%;padding:10px 6px;border:0;border-top:.5px solid var(--mp-line);background:transparent;color:var(--mp-ink);font:inherit;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-sm,8px);transition:background .14s}
.codingns-magpie-toprow:hover{background:var(--mp-hover)}
.codingns-magpie-toprow-main{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-width:0}
.codingns-magpie-toprow-main strong{font-size:${uiFontSize(13)}}
.codingns-magpie-toprow-main small{overflow:hidden;color:var(--mp-caption);font-size:${uiFontSize(12)};text-overflow:ellipsis;white-space:nowrap}
.codingns-magpie-toprow-metrics{display:flex;flex:0 0 auto;gap:16px;font-size:${uiFontSize(13)};font-variant-numeric:tabular-nums;color:var(--mp-muted)}
.codingns-magpie-selection{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;padding:9px 12px;border:.5px solid var(--mp-line);border-radius:10px;background:var(--mp-card);color:var(--mp-ink);font-size:${uiFontSize(13)}}
.codingns-magpie-agent-tag{display:inline-block;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:620}
.codingns-magpie-native-table{min-width:1240px}
.codingns-magpie-native-table th{font-size:${uiFontSize(13)};letter-spacing:.01em}
.codingns-magpie-native-table td{max-width:none;font-size:${uiFontSize(13)};white-space:nowrap}
@keyframes magpie-rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}@keyframes magpie-spin{to{transform:rotate(360deg)}}
@media(max-width:900px){.codingns-magpie-topbar{--mp-topbar-pad-x:14px;--mp-topbar-pad-y:9px;grid-template-columns:minmax(0,1fr) auto;row-gap:8px;min-height:58px}.codingns-magpie-topbar-left{grid-column:1;grid-row:2;margin-left:calc(-1 * var(--mp-leading-inset))}.codingns-magpie-tabs{grid-column:1;grid-row:1;justify-self:start;flex-wrap:wrap;row-gap:2px;overflow:visible}.codingns-magpie-topbar-right{grid-column:2;grid-row:1}}
@media(max-width:650px){.codingns-magpie-topbar{--mp-topbar-pad-x:12px;--mp-topbar-pad-y:8px;min-height:56px;gap:8px}.codingns-magpie-tab{min-height:32px;padding:0 9px;font-size:${uiFontSize(12)}}.codingns-magpie-tab-icon{display:none}.codingns-magpie-toolbar{min-height:44px;padding:0 12px;gap:8px}.codingns-magpie-periods{flex-direction:row;overflow:auto;max-width:100%}.codingns-magpie-period{min-height:28px;padding:0 9px}.codingns-magpie-barchart-panel,.codingns-magpie-progress-panel,.codingns-magpie-toplist-panel,.codingns-magpie-history-panel,.codingns-magpie-quota-card,.codingns-magpie-management-editor{padding:13px}.codingns-magpie-toprow-metrics{gap:10px}.codingns-magpie-chip{min-height:32px}.codingns-magpie-quota-grid,.codingns-magpie-history-grid,.codingns-magpie-management-account-grid{grid-template-columns:1fr}.codingns-magpie-management-grid{grid-template-columns:minmax(0,1fr);gap:8px}.codingns-magpie-management-list{display:flex;max-height:none;gap:4px;overflow:auto;padding:4px}.codingns-magpie-management-row{flex:0 0 auto;width:auto;max-width:220px;min-height:42px;border:1px solid var(--mp-line);border-radius:8px}.codingns-magpie-management-row.is-active{box-shadow:inset 0 -2px var(--mp-accent)}.codingns-magpie-management-row-main{max-width:145px}.codingns-magpie-field-row{flex-wrap:wrap;gap:0}.codingns-magpie-chart-switch{align-self:flex-start}.codingns-magpie-page .codingns-magpie-table{min-width:900px}}
@media(prefers-reduced-motion:reduce){.codingns-magpie-page *{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
.codingns-magpie-group-model-add{position:relative;display:block;margin-top:3px;padding-top:8px;border-top:1px solid var(--mp-line);color:var(--mp-muted)}
.codingns-magpie-group-model-add-button{display:inline-flex;align-items:center;gap:8px;min-height:30px;padding:4px 10px;border:.5px solid var(--mp-line-strong);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--mp-ink);font:inherit;font-size:${uiFontSize(12)};cursor:pointer}
.codingns-magpie-group-model-add-button:hover{border-color:color-mix(in srgb,var(--mp-accent) 50%,transparent);background:color-mix(in srgb,var(--mp-accent) 6%,transparent)}
.codingns-magpie-group-model-add-button[aria-expanded=true]{border-color:var(--mp-accent);color:var(--mp-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mp-accent) 10%,transparent)}
.codingns-magpie-group-model-add-icon{display:grid;place-items:center;flex:0 0 18px;width:18px;height:18px;border:1px dashed currentColor;border-radius:5px;color:var(--mp-accent);font-size:${uiFontSize(15)};line-height:1}
.codingns-magpie-group-model-picker{position:absolute;z-index:5;top:calc(100% + 8px);left:0;width:min(520px,calc(100vw - 36px));max-width:100%;box-sizing:border-box;overflow:hidden;border:1px solid var(--mp-line);border-radius:10px;background:var(--mp-surface);box-shadow:var(--dsw-elevation-prominent,0 12px 28px rgba(0,0,0,.18))}
.codingns-magpie-group-model-picker-search{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--mp-line);color:var(--mp-muted);background:var(--mp-card)}
.codingns-magpie-group-model-picker-search>span{font-size:${uiFontSize(15)};line-height:1}
.codingns-magpie-group-model-picker-search input{width:100%;min-width:0;padding:4px 0;border:0;outline:0;background:transparent;color:var(--mp-ink);font:inherit;font-size:${uiFontSize(12)}}
.codingns-magpie-group-model-picker-list{max-height:min(380px,50vh);overflow:auto;padding:4px 5px 7px}
.codingns-magpie-group-model-picker-group{padding:0 0 5px}
.codingns-magpie-group-model-picker-heading{margin:0;padding:8px 8px 5px;border-bottom:1px solid var(--mp-line);color:var(--mp-muted);font-size:${uiFontSize(11)};font-weight:750;letter-spacing:.06em;text-transform:uppercase}
.codingns-magpie-group-model-picker-option{display:flex;align-items:center;gap:9px;width:100%;min-width:0;min-height:43px;margin-top:2px;padding:6px 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--mp-ink);font:inherit;text-align:left;cursor:pointer}
.codingns-magpie-group-model-picker-option:hover,.codingns-magpie-group-model-picker-option[aria-selected=true]{border-color:var(--mp-line-strong);background:var(--mp-hover)}
.codingns-magpie-group-model-picker-option .codingns-magpie-model-option-copy{gap:2px}
.codingns-magpie-group-model-picker-option .codingns-magpie-model-name{font-size:${uiFontSize(11)}}
.codingns-magpie-group-model-picker-option .codingns-magpie-model-meta{font-size:${uiFontSize(11)}}
.codingns-magpie-group-model-picker-mark{display:grid;place-items:center;flex:0 0 24px;width:24px;height:24px;border-radius:7px;background:color-mix(in srgb,var(--mp-accent) 10%,transparent);color:var(--mp-accent);font-size:${uiFontSize(11)};font-weight:750}
/* -- Mobile layout --
   With the sidebar hidden DSH keeps only a floating logo button at the top-left, so the
   page stops indenting by the whole clearance width: the page fills the viewport, only the
   header's first row is pushed past the button, and the body, toolbar, and tables start at
   the left edge. This section must come after every default rule so it overrides the
   desktop paddings above. */
.codingns-magpie-page{--mp-topbar-pad-x:16px;--mp-topbar-pad-y:0px;--mp-leading-inset:0px;padding-left:var(--dsh-frame-leading-clearance,0px)}
.codingns-magpie-topbar{padding-right:var(--mp-topbar-pad-x);padding-left:calc(var(--mp-topbar-pad-x) + var(--mp-leading-inset))}
html[data-codingns-mobile-sidebar="on"] .codingns-magpie-page{padding-left:0;--mp-leading-inset:max(0px,calc(var(--dsh-frame-leading-clearance,0px) - 20px))}
@media(max-width:900px){.codingns-magpie-topbar{--mp-topbar-pad-x:14px;--mp-topbar-pad-y:9px}.codingns-magpie-topbar-left{margin-left:calc(-1 * var(--mp-leading-inset))}}
@media(max-width:650px){.codingns-magpie-topbar{--mp-topbar-pad-x:12px;--mp-topbar-pad-y:8px}.codingns-magpie-icon-button{width:36px;height:36px}.codingns-magpie-toolbar:not(.has-tabs){display:none}.codingns-magpie-view{padding:14px 12px 30px}.codingns-magpie-statstrip{grid-template-columns:repeat(2,minmax(0,1fr))}.codingns-magpie-statcell{padding:13px;border-left:0}.codingns-magpie-statcell:nth-child(2n){border-left:.5px solid var(--mp-line)}.codingns-magpie-statcell:nth-child(n+3){border-top:.5px solid var(--mp-line)}.codingns-magpie-statcell:last-child:nth-child(odd){grid-column:1/-1}.codingns-magpie-statcell-value{font-size:${uiFontSize(22)}}.codingns-magpie-barchart-plot{height:132px}.codingns-magpie-barchart-axis{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:0;overflow:hidden;font-size:${uiFontSize(9)}}.codingns-magpie-barchart-tick{overflow:hidden;text-overflow:clip}}
.codingns-magpie-reqlist{display:none}
.codingns-magpie-reqcard{display:flex;flex-direction:column;gap:5px;padding:11px 14px;border-top:.5px solid var(--mp-line)}
.codingns-magpie-reqcard:first-child{border-top:0}
.codingns-magpie-reqcard-top{display:flex;align-items:center;gap:8px;min-width:0}
.codingns-magpie-reqcard-top .codingns-magpie-time-cell{flex:0 0 auto;font-size:${uiFontSize(12)}}
.codingns-magpie-reqcard-top .codingns-magpie-provider-inline{flex:1 1 auto;min-width:0}
.codingns-magpie-reqcard-route{display:flex;align-items:center;gap:6px;min-width:0;font-size:${uiFontSize(12)}}
.codingns-magpie-reqcard-arrow{flex:0 0 auto;color:var(--mp-caption)}
.codingns-magpie-reqcard-route .codingns-magpie-route-model{flex:0 1 auto;max-width:47%}
.codingns-magpie-reqcard-sub{display:flex;align-items:center;gap:6px;min-width:0;font-size:${uiFontSize(11)};color:var(--mp-caption)}
.codingns-magpie-reqcard-sub .codingns-magpie-provider-name{max-width:62%;font-weight:500;color:var(--mp-muted)}
.codingns-magpie-reqcard-sub .codingns-magpie-table-secondary{margin-top:0}
.codingns-magpie-reqcard-facts{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:${uiFontSize(11)};color:var(--mp-muted);font-variant-numeric:tabular-nums}

@media(max-width:650px){
.codingns-magpie-view{padding:12px 12px 26px}
.codingns-magpie-tab{min-height:38px;padding:0 10px}
.codingns-magpie-toolbar{min-height:40px}
.codingns-magpie-statcell-label{font-size:${uiFontSize(11)}}
.codingns-magpie-statcell-value{font-size:${uiFontSize(19)}}
.codingns-magpie-statcell-detail{font-size:${uiFontSize(11)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.codingns-magpie-barchart-plot{height:118px}
.codingns-magpie-barchart-panel,.codingns-magpie-progress-panel,.codingns-magpie-toplist-panel,.codingns-magpie-history-panel,.codingns-magpie-quota-card,.codingns-magpie-management-editor{padding:12px}
.codingns-magpie-panel-head{margin-bottom:10px}
.codingns-magpie-progress-item{padding:9px 0}
.codingns-magpie-toprow{padding:8px 4px}
.codingns-magpie-chip{min-height:28px;padding:0 10px}
.codingns-magpie-quota-icon{width:28px;height:28px;border-radius:8px;font-size:${uiFontSize(12)}}
.codingns-magpie-quota-topline{gap:8px;margin-bottom:9px}
.codingns-magpie-quota-card{padding:11px 12px}
.codingns-magpie-quota-topline h2{font-size:${uiFontSize(13)}}
.codingns-magpie-quota-topline p{font-size:${uiFontSize(11)}}
.codingns-magpie-quota-account{font-size:${uiFontSize(12)};margin:-3px 0 7px}
.codingns-magpie-quota-window{padding:8px 0}
.codingns-magpie-daily-chart{margin-top:2px;padding-top:6px}
.codingns-magpie-pagination{padding:8px 10px}
.codingns-magpie-selection{padding:8px 10px}
}

@media(max-width:900px){
.codingns-magpie-table-scroll{display:none}
.codingns-magpie-reqlist{display:block}
.codingns-magpie-statstrip{display:flex;flex-wrap:wrap;gap:.5px;background:var(--mp-line)}
.codingns-magpie-statcell,.codingns-magpie-statcell:nth-child(2n),.codingns-magpie-statcell:nth-child(n+3){flex:1 1 calc(33.333% - .5px);border:0;background:var(--mp-card)}
.codingns-magpie-statcell:last-child:nth-child(odd){grid-column:auto}
}

`
