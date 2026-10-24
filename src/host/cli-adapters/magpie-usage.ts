import { spawnSync } from 'node:child_process'
import type {
  CodingNsCliAdapterId,
  CodingNsCliModel,
  CodingNsCliModelCatalog,
  CodingNsCliServiceTier,
  CodingNsCliSessionConfig,
} from '../../shared/contracts/cli-adapter.js'
import type {
  MagpieQuota,
  MagpieQuotaCheckin,
  MagpieQuotaWindow,
  MagpieRouteUsage,
  MagpieSessionUsage,
  MagpieUsageSnapshot,
  MagpieUsageTotals,
} from '../../shared/contracts/subscription.js'
import type {
  MagpieDashboardPeriod,
  MagpieDashboardAvailabilityIssue,
  MagpieDashboardStreamChunk,
  MagpieDashboardStreamPart,
  MagpieDashboardQuota,
  MagpieQuotaHistory,
  MagpieUsageDashboard,
  MagpieUsageGroup,
  MagpieUsageMetrics,
  MagpieUsageRequest,
  MagpieUsageRequestPage,
  MagpieUsageSeriesPoint,
  MagpieUsageSession,
  MagpieProviderManagementRecord,
} from '../../shared/contracts/magpie-management.js'
import { commandEnvironment, resolveCommandPath, runAsyncCommand, WINDOWS, withCommandSignal } from './process-utils.js'
import { parseMagpieWebProviders } from './magpie-management.js'
import type { MagpieWebService } from './magpie-web.js'

const MAGPIE_CATALOG_TTL_MS = 60_000
const MAGPIE_MODEL_METADATA_TTL_MS = 60_000
const MAGPIE_FAILURE_CACHE_TTL_MS = 5_000
const MAX_MAGPIE_MODEL_METADATA_CACHE_ENTRIES = 4
const MAGPIE_MINIMUM_CLI_VERSION = [0, 1, 1295] as const
const MAGPIE_CLI_TIMEOUT_MS = 10_000
const MAGPIE_HTTP_TIMEOUT_MS = 3_000
const MAGPIE_DASHBOARD_CACHE_TTL_MS = 15_000
const MAGPIE_PROVIDER_CATALOG_TTL_MS = 15_000
const MAX_MAGPIE_CLI_OUTPUT_BYTES = 512 * 1024
const MAX_MAGPIE_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MAGPIE_ICON_FETCHES = 64
const MAX_MAGPIE_MODELS = 10_000
const MAX_MAGPIE_SESSION_SCAN_ROWS = 10_000
const MAX_MAGPIE_SESSION_IDENTITIES = 16
const MAX_MODEL_TOKEN_LIMIT = 1_000_000_000
const MAGPIE_MODEL_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._:/-]*)+'

const MAGPIE_AGENT_BY_ADAPTER: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  'command-code': 'commandcode',
  kimi: 'kimi',
  gemini: 'gemini',
  pi: 'pi',
  opencode: 'opencode',
  grok: 'grok',
  mcode: 'minimax-code',
  zcode: 'zcode',
  codebuddy: 'codebuddy',
  workbuddy: 'workbuddy',
  'cursor-cli': 'cursor',
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
  antigravity: 'agy',
  dsh: 'dsh',
}

// The DSH catalog uses `dsh`, while its gateway requests are recorded under
// the public client identity `codingns4dsh` in Magpie usage and trace data.
const MAGPIE_USAGE_AGENT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  dsh: ['dsh', 'codingns4dsh'],
  // Command Code ACP identifies its client as `codingns4dsh` in Magpie's
  // usage ledger, while its verified model catalog uses `commandcode`.
  commandcode: ['commandcode', 'codingns4dsh'],
}

/** A safe, non-sensitive title associated with a DSH session identity. */
export interface MagpieSessionNameBinding {
  readonly dshSessionId: string
  readonly providerSessionId?: string
  readonly adapterId: CodingNsCliAdapterId
  readonly name?: string
}

/** Magpie's agent IDs are verified from the matching catalog output. */
export type MagpieAgent = string

interface MagpieModelCatalog {
  readonly models: ReadonlySet<string>
  /** Display labels from the exact Magpie CLI rows, keyed by model ID. */
  readonly displayNames: ReadonlyMap<string, string>
  /** Unique normalized CLI labels; duplicate labels are intentionally omitted. */
  readonly names: ReadonlyMap<string, string>
  /** Origin only; requests are restricted to the local loopback gateway. */
  readonly gatewayOrigin: string | null
}

interface CatalogCacheEntry {
  readonly catalog: MagpieModelCatalog | null
  readonly unavailableIssue: Extract<MagpieDashboardAvailabilityIssue, 'cli-unavailable' | 'cli-version-unsupported' | 'model-catalog-unavailable'> | null
  readonly loadedAt: number
}

export interface MagpieModelMetadata {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly contextWindow?: number
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly inputModalities?: readonly string[]
  readonly outputModalities?: readonly string[]
  readonly reasoningSupported?: boolean
  readonly efforts?: readonly string[]
  readonly serviceTiers?: readonly CodingNsCliServiceTier[]
  readonly capabilities?: readonly string[]
  readonly ownedBy?: string
}

interface ModelMetadataCacheEntry {
  readonly origin: string
  readonly catalogFingerprint: string
  readonly models: ReadonlyMap<string, MagpieModelMetadata> | null
  readonly loadedAt: number
}

interface MagpieSessionRouteRecord {
  readonly route: MagpieRouteUsage
  readonly provider: string
  readonly account: string | null
}

export interface MagpieUsageServiceOptions {
  /** Test seam for the bounded `magpie models <agent>` command. */
  readonly readModels?: (agent: MagpieAgent, signal?: AbortSignal) => Promise<string | null>
  readonly readVersion?: (signal?: AbortSignal) => Promise<string | null>
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  /** Shared authenticated Web process for the full management dashboard. */
  readonly webApi?: Pick<MagpieWebService, 'requestJson'> & Partial<Pick<MagpieWebService, 'requestAssetDataUrl'>>
  /** Shared catalog CLI work is cancelled when its owning Host feature stops, not by one RPC caller. */
  readonly lifetimeSignal?: AbortSignal
  /** Records per-part dashboard timings without exposing them to the Client. */
  readonly onDashboardTiming?: (timing: MagpieDashboardTiming) => void
}

export interface MagpieDashboardTiming {
  readonly part: MagpieDashboardStreamPart | 'quota-logos'
  readonly elapsedMs: number
}

export interface MagpieUsageRequestOptions {
  readonly period: MagpieDashboardPeriod
  readonly offset: number
  readonly limit: number
  readonly sessionId?: string
  readonly sessionIds?: readonly string[]
  readonly sessionAgent?: string
}

/** Reads usage from the authenticated local Magpie Web API and exact-matches session identity. */
export class MagpieUsageService {
  private readonly readModels: NonNullable<MagpieUsageServiceOptions['readModels']>
  private readonly readVersion: NonNullable<MagpieUsageServiceOptions['readVersion']>
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly lifetimeSignal: AbortSignal | undefined
  private readonly webApi: MagpieUsageServiceOptions['webApi']
  private readonly onDashboardTiming: ((timing: MagpieDashboardTiming) => void) | undefined
  /** Agent CLI verification remains isolated; model metadata below is Gateway-wide and shared. */
  private readonly catalogs = new Map<MagpieAgent, CatalogCacheEntry>()
  private readonly catalogLoads = new Map<MagpieAgent, Promise<MagpieModelCatalog | null>>()
  /** `/v1/models` is Gateway-wide, so adapters with the same model set share one normalized response. */
  private readonly modelMetadata = new Map<string, ModelMetadataCacheEntry>()
  private readonly modelMetadataLoads = new Map<string, Promise<ReadonlyMap<string, MagpieModelMetadata> | null>>()
  private versionCheck: { readonly supported: boolean; readonly executableAvailable: boolean; readonly checkedAt: number } | undefined
  private versionLoad: Promise<boolean> | undefined
  private readonly dashboardCache = new Map<MagpieDashboardPeriod, { readonly dashboard: MagpieUsageDashboard; readonly loadedAt: number }>()
  private readonly dashboardRefreshes = new Map<MagpieDashboardPeriod, Promise<MagpieUsageDashboard>>()
  private readonly quotaLogoCache = new Map<string, string | null>()
  private providerCatalog: { readonly records: readonly MagpieProviderManagementRecord[]; readonly loadedAt: number } | undefined

  constructor(options: MagpieUsageServiceOptions = {}) {
    this.readModels = options.readModels ?? readMagpieModels
    // An injected catalog reader represents the whole fake CLI boundary in
    // unit tests; tests that exercise version handling inject readVersion too.
    this.readVersion = options.readVersion ?? (options.readModels === undefined
      ? readMagpieVersion
      : async () => 'magpie 0.1.1295')
    this.request = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? MAGPIE_HTTP_TIMEOUT_MS
    this.lifetimeSignal = options.lifetimeSignal
    this.webApi = options.webApi
    this.onDashboardTiming = options.onDashboardTiming
  }

  async read(
    session: Pick<CodingNsCliSessionConfig, 'adapterId' | 'modelId' | 'providerSessionId'>,
    signal?: AbortSignal,
    includeRoute = false,
    dshSessionId?: string,
  ): Promise<MagpieUsageSnapshot | null> {
    signal?.throwIfAborted()
    const agent = magpieAgentForAdapter(session.adapterId)
    const requestedModelId = cleanText(session.modelId)
    if (agent === null || requestedModelId === null) return null

    const providerSessionId = cleanText(session.providerSessionId)
    const nativeSessionId = cleanText(dshSessionId)
    // Native DSH requests use the DSH session ID as their Magpie session
    // identity. Other drivers must never treat that fallback as a provider ID.
    const sessionId = providerSessionId !== null && providerSessionId !== nativeSessionId
      ? providerSessionId
      : agent === 'dsh' ? nativeSessionId : null
    // Command Code's ACP child tags loopback Magpie requests with the DSH
    // session ID injected by the Host, so the ledger key differs from the ACP
    // session ID shown in the panel. Older Hosts without that ID keep the
    // provider ID so the panel still reports the same "no usage" state.
    const magpieSessionId = agent === 'commandcode' ? nativeSessionId ?? sessionId : sessionId
    // During a rolling update the ACP child may still tag requests with its ACP
    // session ID; fall back to it when the DSH-ID ledger row is absent.
    const fallbackSessionId = agent === 'commandcode' && nativeSessionId !== null && sessionId !== null && nativeSessionId !== sessionId
      ? sessionId
      : null
    if (magpieSessionId === null) return null
    return this.readFromWeb(agent, requestedModelId, sessionId, magpieSessionId, fallbackSessionId, signal, includeRoute)
  }

  /**
   * Mark Magpie models and enrich their public metadata. The marker is
   * transient catalog data used by model-list UIs, not session provenance.
   */
  async enrichModelCatalog(adapterId: CodingNsCliAdapterId, catalog: CodingNsCliModelCatalog | Promise<CodingNsCliModelCatalog>, signal?: AbortSignal): Promise<CodingNsCliModelCatalog> {
    const agent = magpieAgentForAdapter(adapterId)
    const [resolvedCatalog, agentCatalog] = await Promise.all([
      Promise.resolve(catalog),
      agent === null ? Promise.resolve(null) : this.loadCatalog(agent, signal),
    ])
    if (agent === null || agentCatalog === null) return resolvedCatalog
    const hasMatch = resolvedCatalog.groups.some((group) => group.models.some((model) =>
      resolveCatalogModelId(agent, model.id, agentCatalog, model.name) !== null))
    const exposeMissingCodexModels = adapterId === 'codex'
    if (!hasMatch && !exposeMissingCodexModels) return resolvedCatalog
    const metadata = await this.loadModelMetadata(agentCatalog, signal)

    let changed = false
    let groups = resolvedCatalog.groups.map((group) => {
      let groupChanged = false
      const models = group.models.map((model) => {
        const id = resolveCatalogModelId(agent, model.id, agentCatalog, model.name)
        if (id === null) return model
        const record = metadata?.get(id)
        const enriched = record === undefined
          ? model.source === 'magpie' ? model : { ...model, source: 'magpie' as const }
          : mergeMagpieModelMetadata(model, record)
        if (enriched === model) return model
        groupChanged = true
        return enriched
      })
      if (!groupChanged) return group
      changed = true
      return { ...group, models }
    })

    if (exposeMissingCodexModels) {
      const existingModelIds = new Set(groups.flatMap((group) => group.models.map((model) => model.id)))
      const missingModels = [...agentCatalog.models]
        .filter((id) => !existingModelIds.has(id))
        .map((id): CodingNsCliModel => {
          const record = metadata?.get(id)
          const model: CodingNsCliModel = {
            id,
            name: record?.name ?? agentCatalog.displayNames.get(id) ?? id,
            efforts: record?.efforts ?? [],
            source: 'magpie',
          }
          return record === undefined ? model : mergeMagpieModelMetadata(model, record)
        })
      if (missingModels.length > 0) {
        const codexGroupIndex = groups.findIndex((group) => group.id === 'codex')
        const targetIndex = codexGroupIndex >= 0 ? codexGroupIndex : groups.length > 0 ? 0 : -1
        if (targetIndex >= 0) {
          groups = groups.map((group, index) => index === targetIndex
            ? { ...group, models: [...group.models, ...missingModels] }
            : group)
        } else {
          groups = [{ id: 'codex', name: 'Codex', models: missingModels }]
        }
        changed = true
      }
    }
    return changed ? { ...resolvedCatalog, groups } : resolvedCatalog
  }

  /** Return an exact, CLI-confirmed Magpie model record for trusted Host use. */
  async readModelMetadata(adapterId: CodingNsCliAdapterId, modelId: string, signal?: AbortSignal): Promise<MagpieModelMetadata | null> {
    signal?.throwIfAborted()
    const agent = magpieAgentForAdapter(adapterId)
    const requestedModelId = cleanText(modelId)
    if (agent === null || requestedModelId === null) return null
    const catalog = await this.loadCatalog(agent, signal)
    if (catalog === null) return null
    const id = resolveCatalogModelId(agent, requestedModelId, catalog, requestedModelId)
    if (id === null) return null
    const metadata = await this.loadModelMetadata(catalog, signal)
    return metadata?.get(id) ?? null
  }

  /** Read bounded, graph-ready usage and quota data through authenticated Magpie Web. */
  async readDashboard(period: MagpieDashboardPeriod, signal?: AbortSignal): Promise<MagpieUsageDashboard> {
    signal?.throwIfAborted()
    const cached = this.dashboardCache.get(period)
    if (cached !== undefined) {
      if (this.now() - cached.loadedAt >= MAGPIE_DASHBOARD_CACHE_TTL_MS) {
        void this.refreshDashboard(period).catch(() => undefined)
      }
      return cached.dashboard
    }
    return this.refreshDashboard(period, signal)
  }

  /** Stream cumulative dashboard snapshots as each independent Web API part is ready. */
  async *readDashboardStream(period: MagpieDashboardPeriod, signal?: AbortSignal, force = false): AsyncIterable<MagpieDashboardStreamChunk> {
    signal?.throwIfAborted()
    const cached = this.dashboardCache.get(period)
    if (!force && cached !== undefined) {
      const stale = this.now() - cached.loadedAt >= MAGPIE_DASHBOARD_CACHE_TTL_MS
      yield { part: 'cache', dashboard: cached.dashboard, stale }
      if (!stale) return
    }
    let latest: MagpieUsageDashboard | undefined
    for await (const chunk of this.readDashboardNetwork(period, signal)) {
      latest = chunk.dashboard
      yield chunk
    }
    if (latest !== undefined) this.dashboardCache.set(period, { dashboard: latest, loadedAt: this.now() })
  }

  private async refreshDashboard(period: MagpieDashboardPeriod, signal?: AbortSignal): Promise<MagpieUsageDashboard> {
    const pending = this.dashboardRefreshes.get(period)
    if (pending !== undefined) return awaitWithSignal(pending, signal)
    const request = (async (): Promise<MagpieUsageDashboard> => {
      let latest: MagpieUsageDashboard | undefined
      for await (const chunk of this.readDashboardNetwork(period, signal)) latest = chunk.dashboard
      if (latest === undefined) throw new Error('Magpie dashboard returned no snapshot')
      this.dashboardCache.set(period, { dashboard: latest, loadedAt: this.now() })
      return latest
    })().finally(() => {
      if (this.dashboardRefreshes.get(period) === request) this.dashboardRefreshes.delete(period)
    })
    this.dashboardRefreshes.set(period, request)
    return awaitWithSignal(request, signal)
  }

  private async *readDashboardNetwork(period: MagpieDashboardPeriod, signal?: AbortSignal): AsyncIterable<MagpieDashboardStreamChunk> {
    const capturedAt = new Date(this.now()).toISOString()
    let dashboard = emptyMagpieDashboard(period, capturedAt)
    let quotas: readonly MagpieDashboardQuota[] | null = null
    let logoLoad: Promise<readonly MagpieDashboardQuota[]> | undefined
    const results = new Map<MagpieDashboardStreamPart, Promise<{ readonly part: MagpieDashboardStreamPart; readonly value: unknown; readonly ok: boolean }>>([
      ['usage', this.timedDashboardRead('usage', () => this.readWebJson(`/api/usage?period=${magpieWebPeriod(period)}`, signal))],
      ['quotas', this.timedDashboardRead('quotas', () => this.readWebJson('/api/usage/quotas', signal))],
      ['history', this.timedDashboardRead('history', () => this.readWebJson('/api/usage/quotas/history?days=30', signal))],
    ])
    const completed = new Map<MagpieDashboardStreamPart, boolean>()
    while (results.size > 0) {
      const result = await Promise.race(results.values())
      results.delete(result.part)
      const response = asRecord(result.value)
      const partOk = result.ok && response?.ok === true
      const partValue = partOk ? response.value : undefined
      completed.set(result.part, partOk)
      if (result.part === 'usage') {
        const parsed = partOk ? parseMagpieDashboardUsage(partValue) : null
        dashboard = {
          ...dashboard,
          usageStatus: parsed === null ? 'unavailable' : 'available',
          aggregate: parsed?.aggregate ?? null,
          series: parsed?.series ?? [],
          agents: parsed?.agents ?? [],
          providers: parsed?.providers ?? [],
          models: parsed?.models ?? [],
          accounts: parsed?.accounts ?? [],
          sessions: parsed?.sessions ?? [],
          sessionCount: parsed?.sessionCount ?? null,
        }
      } else if (result.part === 'quotas') {
        quotas = partOk ? parseMagpieQuotaCards(partValue) : null
        dashboard = { ...dashboard, quotaStatus: quotas === null ? 'unavailable' : 'available', quotas: quotas ?? [] }
        if (quotas !== null) logoLoad = this.timedDashboardRead('quota-logos', () => this.attachQuotaLogos(quotas!, signal)).then((result) => result.value)
      } else {
        const parsed = partOk ? parseMagpieQuotaHistory(partValue) : null
        dashboard = { ...dashboard, quotaHistoryStatus: parsed === null ? 'unavailable' : 'available', quotaHistory: parsed ?? [] }
      }
      yield { part: result.part, dashboard, stale: false }
    }
    dashboard = { ...dashboard, availabilityIssue: [...completed.values()].every((ok) => !ok) ? 'web-api-unavailable' : null }
    yield { part: 'complete', dashboard, stale: false }
    if (logoLoad !== undefined) {
      dashboard = { ...dashboard, quotas: await logoLoad }
      yield { part: 'logos', dashboard, stale: false }
    }
  }

  private async timedDashboardRead<T>(part: MagpieDashboardStreamPart | 'quota-logos', read: () => Promise<T>): Promise<{ readonly part: MagpieDashboardStreamPart; readonly value: T; readonly ok: boolean }> {
    const started = this.now()
    try {
      return { part: part === 'quota-logos' ? 'logos' : part, value: await read(), ok: true }
    } finally {
      this.onDashboardTiming?.({ part, elapsedMs: Math.max(0, this.now() - started) })
    }
  }

  /** Read one bounded Web API ledger page and exact-match session identities on Host. */
  async readRequestPage(options: MagpieUsageRequestOptions, signal?: AbortSignal): Promise<MagpieUsageRequestPage | null> {
    signal?.throwIfAborted()
    if (!isMagpieDashboardPeriod(options.period)
      || !Number.isSafeInteger(options.offset) || options.offset < 0 || options.offset > 1_000_000
      || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) return null
    const sessionId = options.sessionId === undefined ? null : cleanText(options.sessionId)
    const sessionIds = options.sessionIds === undefined
      ? []
      : options.sessionIds.map(cleanText)
    const sessionAgent = options.sessionAgent === undefined ? null : cleanText(options.sessionAgent)
    if ((options.sessionId !== undefined && sessionId === null)
      || sessionIds.some((value): value is null => value === null)
      || sessionIds.length > MAX_MAGPIE_SESSION_IDENTITIES
      || (options.sessionAgent !== undefined && (sessionAgent === null || !isMagpieAgentId(sessionAgent)))
      || ((sessionId === null) !== (sessionAgent === null))
      || (sessionIds.length > 0 && sessionId === null)) return null
    const requestedSessionIds = sessionId === null
      ? []
      : [...new Set([sessionId, ...sessionIds.filter((value): value is string => value !== null)])]
    if (requestedSessionIds.length > MAX_MAGPIE_SESSION_IDENTITIES) return null

    const readCandidatePage = async (offset: number, limit: number, querySessionId: string | null): Promise<{ readonly rows: readonly unknown[]; readonly total: number | null } | null> => {
      const query = new URLSearchParams({ period: magpieWebPeriod(options.period), limit: String(limit), offset: String(offset) })
      if (querySessionId !== null) query.set('q', querySessionId)
      const response = await this.readWebJson(`/api/usage/requests?${query.toString()}`, signal)
      if (!response.ok) return null
      const root = asRecord(response.value)
      const rows = root?.rows
      if (!Array.isArray(rows) || rows.length > 500) return null
      return { rows, total: safeCount(root?.total) }
    }

    if (sessionId === null) {
      const page = await readCandidatePage(options.offset, options.limit, null)
      if (page === null) return null
      const providerRecords = page.rows.some((row) => routeText(asRecord(row)?.agent) === 'codex')
        ? await this.readProviderCatalog(signal)
        : []
      const items = parseMagpieRequestRows(page.rows, null, null, providerRecords)
      return {
        period: options.period,
        offset: options.offset,
        limit: options.limit,
        total: page.total,
        hasMore: page.total === null ? page.rows.length >= options.limit : options.offset + page.rows.length < page.total,
        sessionId,
        sessionAgent,
        items: items.slice(0, options.limit),
      }
    }

    // Magpie's `q` is a free-text candidate search, not an exact session filter.
    // Fetch candidates from the beginning and apply the exact filter before paging;
    // otherwise unrelated rows can consume the requested page and hide valid rows.
    const candidateLimit = 100
    const requestedEnd = options.offset + options.limit
    const rawRowsByKey = new Map<string, unknown>()
    let fullyScanned = true
    const perIdentityScanLimit = Math.floor(MAX_MAGPIE_SESSION_SCAN_ROWS / requestedSessionIds.length)
    for (const querySessionId of requestedSessionIds) {
      let candidateOffset = 0
      let candidateTotal: number | null = null
      let exhausted = false
      while (!exhausted && candidateOffset < perIdentityScanLimit) {
        const pageLimit = Math.min(candidateLimit, perIdentityScanLimit - candidateOffset)
        const page = await readCandidatePage(candidateOffset, pageLimit, querySessionId)
        if (page === null) return null
        for (const row of page.rows) {
          const key = magpieRequestRowKey(row)
          if (!rawRowsByKey.has(key)) rawRowsByKey.set(key, row)
        }
        candidateTotal = page.total
        const nextOffset = candidateOffset + page.rows.length
        exhausted = page.rows.length === 0
          || nextOffset <= candidateOffset
          || (page.total === null ? page.rows.length < pageLimit : nextOffset >= page.total)
        candidateOffset = nextOffset
        // A single identity keeps the existing paged scan behavior. Aggregated DSH sessions
        // must scan every contributing identity so one provider conversation cannot hide another.
        if (requestedSessionIds.length === 1
          && parseMagpieRequestRows([...rawRowsByKey.values()], sessionId, sessionAgent).length >= requestedEnd) break
      }
      if (!exhausted && (candidateTotal === null || candidateOffset < candidateTotal)) fullyScanned = false
    }
    const rawRows = [...rawRowsByKey.values()]
    const providerRecords = rawRows.some((row) => routeText(asRecord(row)?.agent) === 'codex')
      ? await this.readProviderCatalog(signal)
      : []
    const matching = parseMagpieRequestRows(rawRows, sessionId, sessionAgent, providerRecords, requestedSessionIds)
    const total = fullyScanned ? matching.length : null
    return {
      period: options.period,
      offset: options.offset,
      limit: options.limit,
      total,
      hasMore: !fullyScanned || matching.length > requestedEnd,
      sessionId,
      sessionAgent,
      items: matching.slice(options.offset, requestedEnd),
    }
  }

  private async readFromWeb(
    agent: MagpieAgent,
    modelId: string,
    sessionId: string | null,
    magpieSessionId: string | null,
    fallbackSessionId: string | null,
    signal: AbortSignal | undefined,
    includeRoute: boolean,
  ): Promise<MagpieUsageSnapshot | null> {
    const capturedAt = new Date(this.now()).toISOString()
    const [usageResult, quotaResult] = await Promise.all([
      this.readWebJson('/api/usage?period=today', signal),
      this.readWebJson('/api/usage/quotas', signal),
    ])
    const aggregate = usageResult.ok ? readTotals(usageResult.value) : null
    const primarySession = usageResult.ok && magpieSessionId !== null
      ? readSession(usageResult.value, agent, magpieSessionId)
      : null
    const fallbackSession = primarySession === null && usageResult.ok && fallbackSessionId !== null
      ? readSession(usageResult.value, agent, fallbackSessionId)
      : null
    const sessionUsage = primarySession ?? fallbackSession
    const resolvedSessionId = primarySession !== null ? magpieSessionId : fallbackSession !== null ? fallbackSessionId : magpieSessionId
    if (sessionUsage === null) return null
    const canReadRoute = includeRoute && resolvedSessionId !== null && resolvedSessionId.length <= 128
    const routeHistoryResult = canReadRoute
      ? await this.readWebJson(`/api/usage/requests?period=today&offset=0&limit=100&q=${encodeURIComponent(resolvedSessionId)}`, signal)
      : { ok: false as const }
    const routeRows = routeHistoryResult.ok ? asRecord(routeHistoryResult.value)?.rows : null
    const routeHistoryValid = Array.isArray(routeRows) && routeRows.length <= 500
    const providerRecords = agent === 'codex' && routeHistoryValid
      && routeRows.some((row) => routeText(asRecord(row)?.agent) === 'codex')
      ? await this.readProviderCatalog(signal)
      : []
    const routeHistory = routeHistoryResult.ok && routeHistoryValid && resolvedSessionId !== null
      ? readSessionRouteHistory(routeHistoryResult.value, agent, resolvedSessionId, providerRecords)
      : []
    const route = routeHistory[0]?.route ?? null
    const routeStatus = route !== null
      ? 'available' as const
      : resolvedSessionId === null
        ? 'session-unavailable' as const
        : !includeRoute
          ? 'not-requested' as const
          : !canReadRoute || !routeHistoryValid
            ? 'unavailable' as const
            : 'no-route' as const
    const allQuotas = quotaResult.ok ? parseMagpieQuotas(quotaResult.value) : null
    const routeProviders = [...new Set([
      providerFromRoute(route),
      ...routeHistory.map((record) => record.provider),
    ].filter((provider): provider is string => provider !== null))]
    const upstreamProviders = routeProviders.length > 0
      ? routeProviders
      : [providerFromModelId(modelId, agent)].filter((provider): provider is string => provider !== null)
    const upstreamProvider = upstreamProviders[0] ?? null
    const sessionQuotas = allQuotas === null
      ? []
      : filterSessionQuotas(allQuotas, upstreamProviders, routeHistory)
    const matchingQuotas = markSessionAccounts(sessionQuotas, routeHistory, route)
    const quotas = allQuotas === null ? [] : await this.attachQuotaLogos(matchingQuotas, signal)
    // 同厂商的其它账号单独下发：客户端分组展示，但绝不参与本会话余量。
    const siblingQuotas = allQuotas === null
      ? []
      : await this.attachQuotaLogos(otherProviderAccounts(allQuotas, upstreamProviders, sessionQuotas), signal)

    return {
      agent,
      modelId,
      capturedAt,
      usageStatus: aggregate === null ? 'unavailable' : 'available',
      aggregate,
      sessionId,
      ...(resolvedSessionId === null ? {} : { requestSessionId: resolvedSessionId }),
      session: sessionUsage,
      routeStatus,
      route,
      upstreamProvider,
      upstreamProviders,
      quotaStatus: allQuotas === null ? 'unavailable' : upstreamProviders.length === 0 ? 'provider-unavailable' : 'available',
      quotas,
      ...(siblingQuotas.length === 0 ? {} : { providerAccounts: siblingQuotas }),
    }
  }

  private async attachQuotaLogos<T extends { readonly icon?: string }>(quotas: readonly T[], signal?: AbortSignal): Promise<readonly (T & { readonly logoDataUrl?: string })[]> {
    const requestAssetDataUrl = this.webApi?.requestAssetDataUrl
    if (typeof requestAssetDataUrl !== 'function') return quotas
    const icons = [...new Set(quotas
      .map((quota) => quota.icon)
      .filter((icon): icon is string => icon !== undefined))].slice(0, MAX_MAGPIE_ICON_FETCHES)
    if (icons.length === 0) return quotas
    const logos = new Map<string, string | null>()
    await Promise.all(icons.map(async (icon) => {
      const cached = this.quotaLogoCache.get(icon)
      const logo = cached === undefined ? await this.readMagpieLogoDataUrl(icon, signal) : cached
      if (cached === undefined) this.quotaLogoCache.set(icon, logo)
      logos.set(icon, logo)
    }))
    return quotas.map((quota) => {
      const logoDataUrl = quota.icon === undefined ? null : logos.get(quota.icon) ?? null
      return logoDataUrl === null ? quota : { ...quota, logoDataUrl }
    })
  }

  private async readMagpieLogoDataUrl(icon: string, signal?: AbortSignal): Promise<string | null> {
    const requestAssetDataUrl = this.webApi?.requestAssetDataUrl
    if (typeof requestAssetDataUrl !== 'function') return null
    for (const path of magpieIconAssetPaths(icon)) {
      try {
        const value = await requestAssetDataUrl.call(this.webApi, path, signal === undefined ? {} : { signal })
        if (value !== null && value !== '') return value
      } catch {
        signal?.throwIfAborted()
      }
    }
    return null
  }

  private async loadCatalog(agent: MagpieAgent, signal?: AbortSignal): Promise<MagpieModelCatalog | null> {
    const cached = this.catalogs.get(agent)
    const cacheTtl = cached?.catalog === null ? MAGPIE_FAILURE_CACHE_TTL_MS : MAGPIE_CATALOG_TTL_MS
    if (cached !== undefined && this.now() - cached.loadedAt < cacheTtl) {
      return awaitWithSignal(Promise.resolve(cached.catalog), signal)
    }
    const pending = this.catalogLoads.get(agent)
    if (pending !== undefined) return awaitWithSignal(pending, signal)

    const request = Promise.resolve().then(async () => {
      // These checks are independent. Do not make every cold model-catalog
      // request wait for the version subprocess before starting Magpie's
      // model-list subprocess.
      const supportedRequest = this.supportedCli(this.lifetimeSignal)
      const catalogRequest = this.hasFreshUnsupportedVersion()
        ? Promise.resolve(null)
        : Promise.resolve().then(() => this.readModels(agent, this.lifetimeSignal))
          .then((output) => output === null ? null : parseMagpieModelOutput(output, agent))
          .catch(() => null)
      const [supported, catalog] = await Promise.all([supportedRequest, catalogRequest])
      const result = supported ? catalog : null
      const unavailableIssue = result !== null
        ? null
        : !supported
          ? this.versionCheck?.executableAvailable === true ? 'cli-version-unsupported' : 'cli-unavailable'
          : 'model-catalog-unavailable'
      this.catalogs.set(agent, { catalog: result, unavailableIssue, loadedAt: this.now() })
      return result
    })
      .catch(() => null)
      .finally(() => { if (this.catalogLoads.get(agent) === request) this.catalogLoads.delete(agent) })
    this.catalogLoads.set(agent, request)
    return awaitWithSignal(request, signal)
  }

  private async loadModelMetadata(catalog: MagpieModelCatalog, signal?: AbortSignal): Promise<ReadonlyMap<string, MagpieModelMetadata> | null> {
    signal?.throwIfAborted()
    if (catalog.gatewayOrigin === null) return null
    const catalogFingerprint = [...catalog.models].sort().join('\u0000')
    const loadKey = `${catalog.gatewayOrigin}\u0000${catalogFingerprint}`
    const cached = this.modelMetadata.get(loadKey)
    if (cached !== undefined
      && cached.origin === catalog.gatewayOrigin
      && cached.catalogFingerprint === catalogFingerprint
      && this.now() - cached.loadedAt < (cached.models === null ? MAGPIE_FAILURE_CACHE_TTL_MS : MAGPIE_MODEL_METADATA_TTL_MS)) {
      return awaitWithSignal(Promise.resolve(cached.models), signal)
    }

    const pending = this.modelMetadataLoads.get(loadKey)
    if (pending !== undefined) return awaitWithSignal(pending, signal)

    const request = this.readGatewayJson(catalog.gatewayOrigin, '/v1/models', this.lifetimeSignal)
      .then((response) => response.ok ? parseMagpieModelMetadata(response.value) : null)
      .then((models) => {
        this.modelMetadata.delete(loadKey)
        this.modelMetadata.set(loadKey, {
          origin: catalog.gatewayOrigin!,
          catalogFingerprint,
          models,
          loadedAt: this.now(),
        })
        while (this.modelMetadata.size > MAX_MAGPIE_MODEL_METADATA_CACHE_ENTRIES) {
          const oldest = this.modelMetadata.keys().next().value as string | undefined
          if (oldest === undefined) break
          this.modelMetadata.delete(oldest)
        }
        return models
      })
      .catch(() => null)
      .finally(() => { if (this.modelMetadataLoads.get(loadKey) === request) this.modelMetadataLoads.delete(loadKey) })
    this.modelMetadataLoads.set(loadKey, request)
    return awaitWithSignal(request, signal)
  }

  private async supportedCli(signal?: AbortSignal): Promise<boolean> {
    if (this.versionCheck !== undefined && this.now() - this.versionCheck.checkedAt < MAGPIE_CATALOG_TTL_MS) {
      return awaitWithSignal(Promise.resolve(this.versionCheck.supported), signal)
    }
    if (this.versionLoad !== undefined) return awaitWithSignal(this.versionLoad, signal)
    const load = this.readVersion(this.lifetimeSignal)
      .then((value) => {
        const supported = parseMagpieCliVersion(value)
        this.versionCheck = { supported, executableAvailable: value !== null, checkedAt: this.now() }
        return supported
      })
      .catch(() => {
        this.versionCheck = { supported: false, executableAvailable: false, checkedAt: this.now() }
        return false
      })
      .finally(() => { if (this.versionLoad === load) this.versionLoad = undefined })
    this.versionLoad = load
    return awaitWithSignal(load, signal)
  }

  private hasFreshUnsupportedVersion(): boolean {
    return this.versionCheck !== undefined
      && !this.versionCheck.supported
      && this.now() - this.versionCheck.checkedAt < MAGPIE_CATALOG_TTL_MS
  }

  private async readGatewayJson(origin: string, path: string, signal?: AbortSignal): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
    const abort = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined ? abort : AbortSignal.any([signal, abort])
    try {
      const response = await this.request(new URL(path, origin), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer magpie' },
        redirect: 'error',
        cache: 'no-store',
        signal: requestSignal,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return { ok: false }
      }
      const value = await readBoundedJson(response)
      if (value === null) await response.body?.cancel().catch(() => undefined)
      return value === null ? { ok: false } : { ok: true, value }
    } catch {
      return { ok: false }
    }
  }

  private async readWebJson(path: string, signal?: AbortSignal): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
    if (this.webApi === undefined) return { ok: false }
    try {
      return { ok: true, value: await this.webApi.requestJson(path, signal === undefined ? {} : { signal }) }
    } catch {
      signal?.throwIfAborted()
      return { ok: false }
    }
  }

  /** Provider management data is the canonical source when a usage row mislabels its upstream. */
  private async readProviderCatalog(signal?: AbortSignal): Promise<readonly MagpieProviderManagementRecord[]> {
    const cached = this.providerCatalog
    if (cached !== undefined && this.now() - cached.loadedAt < MAGPIE_PROVIDER_CATALOG_TTL_MS) return cached.records
    const response = await this.readWebJson('/api/providers', signal)
    const parsed = response.ok ? parseMagpieWebProviders(response.value) : null
    const records = parsed?.records ?? []
    if (parsed !== null) this.providerCatalog = { records, loadedAt: this.now() }
    return records
  }
}

function awaitWithSignal<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return task
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(error) },
    )
  })
}

/** Strict parser for the human-readable Magpie catalog; unknown formats fail closed. */
export function parseMagpieModelOutput(output: string, agent: MagpieAgent): MagpieModelCatalog | null {
  if (!isMagpieAgentId(agent) || Buffer.byteLength(output, 'utf8') > MAX_MAGPIE_CLI_OUTPUT_BYTES) return null
  const models = new Set<string>()
  const displayNames = new Map<string, string>()
  const nameCandidates = new Map<string, string[]>()
  const gatewayUrls: string[] = []
  const lines = output.split(/\r?\n/u)
  const expectedFooter = `${agent} is shown every provider's models`
  const hasExpectedAgentFooter = lines.some((line) => {
    const footer = line.trim()
    return footer === expectedFooter || footer.startsWith(`${expectedFooter} ·`)
  })
  for (const line of lines) {
    const text = line.trim()
    const columns = text.split(/\s{2,}/u)
    const model = columns[0]
    const label = columns[1]?.trim()
    if (model !== undefined
      && new RegExp(`^${MAGPIE_MODEL_ID_PATTERN}$`, 'u').test(model)
      && model.length <= 512 && models.size < 10_000) {
      models.add(model)
      const displayName = label === undefined || !safeMetadataText(label, 200)
        ? null
        : label.trim().replace(/\s+/gu, ' ')
      if (displayName !== null && !displayNames.has(model)) displayNames.set(model, displayName)
      const name = displayName === null ? null : normalizeMagpieModelName(displayName)
      if (name !== null) {
        const candidates = nameCandidates.get(name) ?? []
        if (!candidates.includes(model)) candidates.push(model)
        nameCandidates.set(name, candidates)
      }
    }
    const url = text.match(/https?:\/\/[^\s]+/u)?.[0]?.replace(/[),.;]+$/u, '')
    if (url !== undefined && gatewayUrls.length < 4) gatewayUrls.push(url)
  }
  if (!hasExpectedAgentFooter || models.size === 0 || gatewayUrls.length !== 1) return null
  const origins = [...new Set(gatewayUrls.map(normalizeLoopbackGatewayOrigin).filter((origin): origin is string => origin !== null))]
  if (origins.length !== 1) return null
  const names = new Map<string, string>()
  for (const [name, candidates] of nameCandidates) {
    if (candidates.length === 1) names.set(name, candidates[0]!)
  }
  return { models, displayNames, names, gatewayOrigin: origins[0]! }
}

/** Parse a bounded OpenAI-compatible `/v1/models` response into a safe allowlist. */
export function parseMagpieModelMetadata(value: unknown): ReadonlyMap<string, MagpieModelMetadata> | null {
  const root = asRecord(value)
  const rows = Array.isArray(value) ? value : Array.isArray(root?.data) ? root.data : null
  if (rows === null || rows.length === 0 || rows.length > MAX_MAGPIE_MODELS) return null
  const models = new Map<string, MagpieModelMetadata>()
  for (const row of rows) {
    const record = asRecord(row)
    const id = cleanModelId(record?.id)
    if (record === null || id === null || models.has(id)) return null
    const modalities = asRecord(record.modalities)
    const reasoningLevels = readReasoningLevels(record)
    const serviceTiers = readMagpieServiceTiers(record.service_tiers)
    const capabilities = readStringList(record.capabilities, 64, 128)
    const metadata: MagpieModelMetadata = {
      id,
      ...optionalText(record.display_name ?? record.magpie_label ?? record.name, 200, 'name'),
      ...optionalText(record.description, 2_000, 'description'),
      ...optionalPositiveLimit(record.context_window ?? record.context_length, 'contextWindow'),
      ...optionalPositiveLimit(record.max_input_tokens, 'maxInputTokens'),
      ...optionalPositiveLimit(record.max_output_tokens ?? record.max_completion_tokens, 'maxOutputTokens'),
      ...optionalStringList(modalities?.input ?? record.input_modalities, 16, 64, 'inputModalities'),
      ...optionalStringList(modalities?.output ?? record.output_modalities, 16, 64, 'outputModalities'),
      ...(typeof record.reasoning === 'boolean' ? { reasoningSupported: record.reasoning } : {}),
      ...(reasoningLevels === undefined ? {} : { efforts: reasoningLevels }),
      ...(serviceTiers === undefined ? {} : { serviceTiers }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...optionalText(record.owned_by, 200, 'ownedBy'),
    }
    if (metadata.reasoningSupported === false && metadata.efforts === undefined) {
      models.set(id, { ...metadata, efforts: [] })
    } else {
      models.set(id, metadata)
    }
  }
  return models
}

function mergeMagpieModelMetadata(model: CodingNsCliModel, metadata: MagpieModelMetadata): CodingNsCliModel {
  return {
    ...model,
    source: 'magpie',
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
    ...(metadata.maxInputTokens === undefined ? {} : { maxInputTokens: metadata.maxInputTokens }),
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    ...(metadata.inputModalities === undefined ? {} : { inputModalities: metadata.inputModalities }),
    ...(metadata.outputModalities === undefined ? {} : { outputModalities: metadata.outputModalities }),
    ...(metadata.reasoningSupported === undefined ? {} : { reasoningSupported: metadata.reasoningSupported }),
    ...(metadata.reasoningSupported === false ? { efforts: [] } : metadata.efforts === undefined ? {} : { efforts: metadata.efforts }),
    ...(metadata.serviceTiers === undefined ? {} : { serviceTiers: metadata.serviceTiers }),
    ...(metadata.capabilities === undefined ? {} : { capabilities: metadata.capabilities }),
    ...(metadata.ownedBy === undefined ? {} : { ownedBy: metadata.ownedBy }),
  }
}

function readReasoningLevels(record: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['reasoning_levels', 'supported_reasoning_levels']) {
    if (!(key in record)) continue
    const value = record[key]
    if (!Array.isArray(value)) return undefined
    const levels = value.flatMap((item) => {
      const level = typeof item === 'string'
        ? item
        : asRecord(item)?.effort ?? asRecord(item)?.reasoning_effort ?? asRecord(item)?.id
      return typeof level === 'string' && isSafeModelToken(level, 64) ? [level.trim()] : []
    })
    return [...new Set(levels)]
  }
  return undefined
}

function readMagpieServiceTiers(value: unknown): readonly CodingNsCliServiceTier[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 32) return undefined
  const tiers = value.flatMap((item) => {
    const record = asRecord(item)
    if (record === null) return []
    const id = typeof record.id === 'string' && isSafeModelToken(record.id, 64) ? record.id.trim() : ''
    if (id === '') return []
    const name = typeof record.name === 'string' && safeMetadataText(record.name, 128) ? record.name.trim() : id
    const description = typeof record.description === 'string' && safeMetadataText(record.description, 512) ? record.description.trim() : undefined
    return [{ id, name, ...(description === undefined ? {} : { description }) }]
  })
  return tiers
}

function optionalText<Key extends string>(value: unknown, maxLength: number, key: Key): Partial<Record<Key, string>> {
  return typeof value === 'string' && safeMetadataText(value, maxLength) ? { [key]: value.trim() } as Record<Key, string> : {}
}

function optionalPositiveLimit<Key extends string>(value: unknown, key: Key): Partial<Record<Key, number>> {
  const parsed = positiveModelTokenLimit(value)
  return parsed === undefined ? {} : { [key]: parsed } as Record<Key, number>
}

function optionalStringList<Key extends string>(value: unknown, maxItems: number, maxLength: number, key: Key): Partial<Record<Key, readonly string[]>> {
  const parsed = readStringList(value, maxItems, maxLength)
  return parsed === undefined ? {} : { [key]: parsed } as Record<Key, readonly string[]>
}

function readStringList(value: unknown, maxItems: number, maxLength: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined
  const items = value.flatMap((item) => typeof item === 'string' && isSafeModelToken(item, maxLength) ? [item.trim()] : [])
  return [...new Set(items)]
}

function cleanModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id.length <= 512 && new RegExp(`^${MAGPIE_MODEL_ID_PATTERN}$`, 'u').test(id) ? id : null
}

function positiveModelTokenLimit(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_MODEL_TOKEN_LIMIT
    ? value
    : undefined
}

function safeMetadataText(value: string, maxLength: number): boolean {
  const text = value.trim()
  return text !== '' && text.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(text)
}

function isSafeModelToken(value: string, maxLength: number): boolean {
  const text = value.trim()
  return text !== '' && text.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)
}

/** Fail closed until the human-readable catalog format is known to match. */
export function parseMagpieCliVersion(output: string | null): boolean {
  if (output === null || Buffer.byteLength(output, 'utf8') > 256) return false
  const match = output.trim().match(/^magpie\s+(\d+)\.(\d+)\.(\d+)$/u)
  if (match === null) return false
  const version = match.slice(1).map(Number)
  for (let index = 0; index < MAGPIE_MINIMUM_CLI_VERSION.length; index += 1) {
    if (version[index] !== MAGPIE_MINIMUM_CLI_VERSION[index]) {
      return version[index]! > MAGPIE_MINIMUM_CLI_VERSION[index]!
    }
  }
  return true
}

async function readMagpieModels(agent: MagpieAgent, signal?: AbortSignal): Promise<string | null> {
  const result = await runMagpieCommand(['models', agent], signal)
  return result?.status === 0 ? result.stdout : null
}

async function readMagpieVersion(signal?: AbortSignal): Promise<string | null> {
  const result = await runMagpieCommand(['--version'], signal)
  return result?.status === 0 ? result.stdout : null
}

async function runMagpieCommand(args: readonly string[], signal?: AbortSignal): Promise<{ readonly status: number | null; readonly stdout: string } | null> {
  const command = await resolveCommandPath('magpie')
  if (command === null) return null
  const environment = commandEnvironment(command)
  // An inherited flag must not silently hide account-backed catalog entries;
  // this integration reads the complete Magpie catalog but never writes it.
  delete environment.MAGPIE_NO_ACCOUNTS
  const run = (): Promise<{ readonly status: number | null; readonly stdout: string }> => runAsyncCommand(spawnSync, command, args, {
    timeout: MAGPIE_CLI_TIMEOUT_MS,
    maxBuffer: MAX_MAGPIE_CLI_OUTPUT_BYTES,
    shell: WINDOWS && /\.(?:cmd|bat)$/iu.test(command),
    env: {
      ...environment,
      // Account-backed providers are part of Magpie's model catalog. Filtering
      // them out makes the CLI catalog disagree with /v1/models and hides valid
      // models such as the WorkBuddy-backed Auto entries.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  }).then((result) => ({
    status: result.status,
    stdout: Buffer.byteLength(result.stdout, 'utf8') <= MAX_MAGPIE_CLI_OUTPUT_BYTES ? result.stdout : '',
  }))
  try {
    return signal === undefined ? await run() : await withCommandSignal(signal, run)
  } catch {
    return null
  }
}

/**
 * Magpie IDs normally match adapter IDs. Keep naming differences explicit;
 * it is used for exact Agent identity matching in Magpie usage records.
 */
export function magpieAgentForAdapter(adapterId: CodingNsCliAdapterId): MagpieAgent | null {
  const agent = MAGPIE_AGENT_BY_ADAPTER[adapterId]
  return agent !== undefined && isMagpieAgentId(agent) ? agent : null
}

/** Return the exact Magpie Agent identities accepted for one adapter. */
export function magpieUsageAgentAliases(adapterId: CodingNsCliAdapterId): readonly string[] {
  const agent = magpieAgentForAdapter(adapterId)
  return agent === null ? [] : MAGPIE_USAGE_AGENT_ALIASES[agent] ?? [agent]
}

/**
 * Enrich dashboard session rows only after an exact `(Agent, session ID)` match.
 * Provider session IDs and DSH IDs are both candidates because Command Code and
 * native DSH use different identities across Magpie versions.
 */
export function attachMagpieSessionNames(
  dashboard: MagpieUsageDashboard,
  bindings: readonly MagpieSessionNameBinding[],
): MagpieUsageDashboard {
  if (!Array.isArray(dashboard.sessions)) return dashboard
  const owners = new Map<string, MagpieSessionOwner>()
  const ambiguous = new Set<string>()
  const ownerByGroup = new Map<string, MagpieSessionOwner>()
  for (const binding of bindings) {
    const dshSessionId = cleanText(binding.dshSessionId)
    const name = cleanSessionName(binding.name)
    if (dshSessionId === null) continue
    // Magpie versions may record either the provider conversation ID or the
    // DSH ID; both exact identities represent the same DSH session.
    const providerSessionId = cleanText(binding.providerSessionId)
    const ids = new Set([dshSessionId, providerSessionId].filter((value): value is string => value !== null))
    const groupKey = `dsh\u0000${dshSessionId}`
    const owner: MagpieSessionOwner = ownerByGroup.get(groupKey) ?? {
      groupKey,
      dshSessionId,
      agent: magpieAgentForAdapter(binding.adapterId) ?? binding.adapterId,
      name,
      ids: [...new Set(ids)],
    }
    if (ownerByGroup.has(groupKey)) {
      ownerByGroup.set(groupKey, {
        ...owner,
        name: owner.name === null || name === null || owner.name === name ? owner.name ?? name : null,
        ids: [...new Set([...owner.ids, ...ids])],
      })
    } else {
      ownerByGroup.set(groupKey, owner)
    }
    const currentOwner = ownerByGroup.get(groupKey)!
    for (const agent of magpieUsageAgentAliases(binding.adapterId)) {
      for (const id of ids) {
        const key = `${agent}\u0000${id}`
        if (ambiguous.has(key)) continue
        const previous = owners.get(key)
        if (previous !== undefined && previous.groupKey !== groupKey) {
          owners.delete(key)
          ambiguous.add(key)
        } else {
          owners.set(key, currentOwner)
        }
      }
    }
  }
  for (const [key, owner] of owners) {
    const currentOwner = ownerByGroup.get(owner.groupKey)
    if (currentOwner !== undefined) owners.set(key, currentOwner)
  }
  const grouped = new Map<string, { session: MagpieUsageSession; ids: Set<string> }>()
  for (const row of dashboard.sessions) {
    const aliasKey = `${row.agent}\u0000${row.id}`
    const owner = ambiguous.has(aliasKey) ? undefined : owners.get(aliasKey)
    const groupKey = owner?.groupKey ?? `raw\u0000${row.agent}\u0000${row.id}`
    const current = grouped.get(groupKey)
    if (current === undefined) {
      const ids = new Set(owner?.ids ?? [row.id])
      ids.add(row.id)
      const session: MagpieUsageSession = owner === undefined
        ? row
        : {
            ...row,
            id: owner.dshSessionId,
            agent: owner.agent,
            ...(owner.name === null ? {} : { dshSessionName: owner.name }),
            sessionIds: [...ids],
          }
      grouped.set(groupKey, { session, ids })
      continue
    }
    for (const id of owner?.ids ?? [row.id]) current.ids.add(id)
    current.ids.add(row.id)
    current.session = mergeMagpieUsageSessions(current.session, row, owner)
  }
  const sessions = [...grouped.values()].map(({ session, ids }) => {
    if (ids.size <= 1 && session.sessionIds === undefined) return session
    return { ...session, sessionIds: [...ids] }
  })
  if (sessions.length === dashboard.sessions.length && sessions.every((session, index) => session === dashboard.sessions[index])) return dashboard
  return { ...dashboard, sessions }
}

interface MagpieSessionOwner {
  readonly groupKey: string
  readonly dshSessionId: string
  readonly agent: string
  readonly name: string | null
  readonly ids: readonly string[]
}

function mergeMagpieUsageSessions(
  current: MagpieUsageSession,
  row: MagpieUsageSession,
  owner: MagpieSessionOwner | undefined,
): MagpieUsageSession {
  return {
    ...current,
    id: owner?.dshSessionId ?? current.id,
    agent: owner?.agent ?? current.agent,
    calls: sumMagpieUsageMetric(current.calls, row.calls),
    errors: sumMagpieUsageMetric(current.errors, row.errors),
    retried: sumMagpieUsageMetric(current.retried, row.retried),
    inputTokens: sumMagpieUsageMetric(current.inputTokens, row.inputTokens),
    outputTokens: sumMagpieUsageMetric(current.outputTokens, row.outputTokens),
    cacheReadTokens: sumMagpieUsageMetric(current.cacheReadTokens, row.cacheReadTokens),
    cacheWriteTokens: sumMagpieUsageMetric(current.cacheWriteTokens, row.cacheWriteTokens),
    reasoningTokens: sumMagpieUsageMetric(current.reasoningTokens, row.reasoningTokens),
    cost: sumMagpieUsageMetric(current.cost, row.cost),
    unpriced: sumMagpieUsageMetric(current.unpriced, row.unpriced),
    credits: sumMagpieUsageMetric(current.credits, row.credits),
    credited: sumMagpieUsageMetric(current.credited, row.credited),
    timed: sumMagpieUsageMetric(current.timed, row.timed),
    ttftMs: sumMagpieUsageMetric(current.ttftMs, row.ttftMs),
    decodeMs: sumMagpieUsageMetric(current.decodeMs, row.decodeMs),
    decodeTokens: sumMagpieUsageMetric(current.decodeTokens, row.decodeTokens),
    decodeCount: sumMagpieUsageMetric(current.decodeCount, row.decodeCount),
    ...(current.dshSessionName === undefined && owner?.name !== null && owner?.name !== undefined
      ? { dshSessionName: owner.name }
      : {}),
  }
}

function sumMagpieUsageMetric(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0)
}

function isMagpieAgentId(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9][a-z0-9-]*$/u.test(value)
}

function normalizeLoopbackGatewayOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'http:'
      || (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]' && hostname !== '::1')
      || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
      || url.pathname.replace(/\/$/u, '') !== '/v1') return null
    return url.origin
  } catch {
    return null
  }
}

async function readBoundedJson(response: Response): Promise<unknown | null> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_MAGPIE_RESPONSE_BYTES) return null
  const reader = response.body?.getReader()
  if (reader === undefined) return null
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MAGPIE_RESPONSE_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

function readTotals(value: unknown): MagpieUsageTotals | null {
  const record = asRecord(value)
  if (record === null) return null
  const calls = safeCount(record.calls)
  const errors = safeCount(record.errors)
  const inputTokens = safeCount(record.input)
  const outputTokens = safeCount(record.output)
  const cacheReadTokens = safeCount(record.cache_read)
  const cacheWriteTokens = safeCount(record.cache_write)
  const costUsd = safeCost(record.cost)
  if ([calls, errors, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd].every((item) => item === null)) return null
  return { calls, errors, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }
}

function readSession(value: unknown, agent: MagpieAgent, sessionId: string): MagpieSessionUsage | null {
  const sessions = asRecord(value)?.sessions
  if (!Array.isArray(sessions)) return null
  const usageAgents = MAGPIE_USAGE_AGENT_ALIASES[agent] ?? [agent]
  const row = sessions.find((item) => {
    const record = asRecord(item)
    const usageAgent = cleanText(record?.agent)
    return cleanText(record?.id) === sessionId && usageAgent !== null && usageAgents.includes(usageAgent)
  })
  const record = asRecord(row)
  const totals = readTotals(record)
  const usageAgent = cleanText(record?.agent)
  return record !== null && usageAgent !== null && totals !== null ? { id: sessionId, agent: usageAgent, ...totals } : null
}

/** Read the durable request ledger when Magpie's short in-memory trace has expired. */
function readSessionRouteHistory(
  value: unknown,
  agent: MagpieAgent,
  sessionId: string,
  providerRecords: readonly MagpieProviderManagementRecord[] = [],
): readonly MagpieSessionRouteRecord[] {
  const rows = asRecord(value)?.rows
  if (!Array.isArray(rows) || rows.length > 500) return []
  const usageAgents = MAGPIE_USAGE_AGENT_ALIASES[agent] ?? [agent]
  return rows.slice(0, 100).flatMap((item) => {
    const record = asRecord(item)
    const rowAgent = cleanText(record?.agent)
    const session = cleanText(record?.session)
    const nativeSession = cleanText(record?.native_session)
    if (record === null || rowAgent === null || !usageAgents.includes(rowAgent)
      || (session !== sessionId && nativeSession !== sessionId)) return []
    const provider = normalizeMagpieRequestProvider(record, providerRecords)
    if (provider === null) return []

    const requested = routeText(record.req)
    const model = routeText(record.model)
    const served = routeText(record.served)
    const status = routeStatusText(record.status)
    const rowModel = model === null
      ? null
      : model.startsWith(`${provider}/`) ? model : `${provider}/${model}`
    const group = routeText(record.group) ?? (requested?.startsWith('group/') ? requested.slice('group/'.length) : null)
    const route: MagpieRouteUsage = {
      asked: requested,
      group,
      rule: readRule(record.rule),
      model: rowModel,
      effort: routeText(record.effort),
      tries: [],
      done: true,
      status,
      served,
      routeId: safeRouteId(record.route_id),
      time: routeText(record.t),
      providerAccount: routeText(record.providerAccount),
    }
    return [{ route, provider, account: routeText(record.providerAccount) }]
  }).sort((left, right) => routeTime(right.route.time) - routeTime(left.route.time))
}

function routeTime(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

/**
 * 选出本会话确实使用过的上游账号配额。
 *
 * 归属必须严格：请求历史里没有出现的账号不能算作本会话的配额。
 *
 * - 账号维度能对上：只留命中的账号。
 * - 上游不提供账号名（Codex 这类量贩账号没有 `user`），无从按账号筛选：保留该厂商
 *   全部候选。过去这里返回空数组，`quotaStatus` 仍是 `available`，界面就只剩下
 *   "上游没有报告配额窗口"的空态 —— 明明识别出了 `glorinfo-api-platform`，却看不到
 *   它的额度。
 * - 有账号记录但一条都不匹配：返回空，宁可显示"没有可用配额"也不能把别的账号的额度
 *   说成本会话的。
 */
function filterSessionQuotas(
  quotas: readonly MagpieQuota[],
  providers: readonly string[],
  history: readonly MagpieSessionRouteRecord[],
): readonly MagpieQuota[] {
  return providers.flatMap((provider) => {
    const candidates = quotas.filter((quota) => quota.provider === provider)
    const accounts = new Set(history
      .filter((record) => record.provider === provider && record.account !== null)
      .map((record) => record.account!))
    if (accounts.size === 0) return candidates
    const matched = candidates.filter((quota) => quota.user !== null && accounts.has(quota.user))
    return matched.length > 0 ? matched : candidates.filter((quota) => quota.user === null)
  })
}

/**
 * 与本会话同一厂商、但本会话没用过的其它账号。
 *
 * 单独返回而不是并进 `quotas`：客户端用它们做"同厂商账号分组"的补充展示，
 * 但这些账号的额度绝不参与本会话余量判断。顺序沿用上游。
 */
function otherProviderAccounts(
  quotas: readonly MagpieQuota[],
  providers: readonly string[],
  sessionQuotas: readonly MagpieQuota[],
): readonly MagpieQuota[] {
  const claimed = new Set(sessionQuotas.map((quota) => `${quota.provider}\u0000${quota.user ?? ''}`))
  return providers.flatMap((provider) => quotas
    .filter((quota) => quota.provider === provider)
    .filter((quota) => quota.user !== null && !claimed.has(`${quota.provider}\u0000${quota.user}`)))
}

/**
 * 标记本会话实际使用过的账号。
 *
 * 只有能追溯到会话请求记录的账号才标 `active`；route 的账号字段优先于请求历史，
 * 因为它来自 Magpie 对这一次请求的精确归属。
 *
 * 账号名比对必须同时限定厂商：不同厂商的账号名会重名（WorkBuddy 与 WorkBuddy AI 都有
 * `zj59122704501@gmail.com`），只比名字会把别的厂商的账号标成本会话正在使用。
 * 无法确认时保持未标记，客户端据此显示"未知活动账号"，而不是随便挑一个账号当"正在使用"。
 */
function markSessionAccounts(
  quotas: readonly MagpieQuota[],
  history: readonly MagpieSessionRouteRecord[],
  route: MagpieRouteUsage | null,
): readonly MagpieQuota[] {
  const used = new Set(history
    .filter((record) => record.account !== null)
    .map((record) => `${record.provider}\u0000${record.account!}`))
  const routedProvider = providerFromRoute(route)
  const routedAccount = route?.providerAccount ?? null
  const routedKey = routedAccount === null || routedProvider === null ? null : `${routedProvider}\u0000${routedAccount}`
  if (used.size === 0 && routedKey === null) return quotas
  // 每个厂商只承认一个活动账号：精确路由优先，其次是首个命中的历史账号。
  const claimed = new Set<string>()
  return quotas.map((quota) => {
    if (quota.user === null) return quota
    const key = `${quota.provider}\u0000${quota.user}`
    if (claimed.has(key)) return quota
    if (key !== routedKey && !used.has(key)) return quota
    claimed.add(key)
    return { ...quota, active: true }
  })
}

function safeRouteId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Parse the bounded `/v1/magpie/quotas` envelope without exposing raw provider records. */
export function parseMagpieQuotas(value: unknown): readonly MagpieQuota[] | null {
  const root = asRecord(value)
  const rows = Array.isArray(value) ? value : Array.isArray(root?.data) ? root.data : null
  if (rows === null || rows.length > 512) return null
  const quotas: MagpieQuota[] = []
  for (const row of rows) {
    const record = asRecord(row)
    const provider = routeText(record?.provider)
    const name = routeText(record?.name)
    if (record === null || provider === null || name === null) return null
    const windowsValue = record.windows
    if (!Array.isArray(windowsValue) || windowsValue.length > 64) return null
    const windows = windowsValue.flatMap((item) => {
      const window = asRecord(item)
      const windowName = routeText(window?.name)
      return window === null || windowName === null ? [] : [readQuotaWindow(window, windowName)]
    })
    if (windows.length !== windowsValue.length) return null
    quotas.push({
      provider,
      name,
      ...optionalQuotaIcon(record.icon),
      kind: routeText(record.kind),
      user: routeText(record.user),
      plan: routeText(record.plan),
      alias: routeText(record.alias),
      balance: routeText(record.balance),
      readAt: routeText(record.readAt),
      windows,
      ...sessionQuotaDaily(record),
      ...readQuotaAccountMeta(record),
    })
  }
  return quotas
}

/** Normalize the live aggregate and per-dimension usage response. */
export function parseMagpieDashboardUsage(value: unknown): {
  readonly aggregate: MagpieUsageMetrics
  readonly series: readonly MagpieUsageSeriesPoint[]
  readonly agents: readonly MagpieUsageGroup[]
  readonly providers: readonly MagpieUsageGroup[]
  readonly models: readonly MagpieUsageGroup[]
  readonly accounts: readonly MagpieUsageGroup[]
  readonly sessions: readonly MagpieUsageSession[]
  readonly sessionCount: number | null
} | null {
  const root = asRecord(value)
  if (root === null) return null
  const hasMetrics = ['calls', 'errors', 'input', 'output', 'cache_read', 'cache_write', 'cost'].some((key) => key in root)
  if (!hasMetrics && !Array.isArray(root.series) && !Array.isArray(root.sessions)) return null
  const series = readMagpieSeries(root.series)
  const agents = readMagpieUsageGroups(root.agents, 'agent')
  const providers = readMagpieUsageGroups(root.providerKeys ?? root.providers, 'provider')
  const models = readMagpieUsageGroups(root.models, 'model')
  const accounts = readMagpieUsageGroups(root.accounts, 'account')
  const sessions = readMagpieUsageSessions(root.sessions)
  if (series === null || agents === null || providers === null || models === null || accounts === null || sessions === null) return null
  return {
    aggregate: readMagpieUsageMetrics(root),
    series,
    agents,
    providers,
    models,
    accounts,
    sessions,
    sessionCount: safeCount(root.sessionCount),
  }
}

/** Normalize quota cards while preserving nullable values and bounded history. */
export function parseMagpieQuotaCards(value: unknown): readonly MagpieDashboardQuota[] | null {
  const root = asRecord(value)
  const rows = Array.isArray(value) ? value : Array.isArray(root?.data) ? root.data : null
  if (rows === null || rows.length > 512) return null
  const quotas: MagpieDashboardQuota[] = []
  for (const row of rows) {
    const record = asRecord(row)
    const provider = routeText(record?.provider)
    const name = routeText(record?.name)
    if (record === null || provider === null || name === null
      || !Array.isArray(record.windows) || record.windows.length > 64) return null
    const windows = record.windows.flatMap((item) => {
      const window = asRecord(item)
      const windowName = routeText(window?.name)
      if (window === null || windowName === null) return []
      return [{
        name: windowName,
        usedPercent: quotaUsedPercent(window),
        remainingPercent: quotaRemainingPercent(window),
        resetsAt: routeText(window.resetsAt),
        display: routeText(window.display),
        amount: safeDecimal(window.amount),
        limit: safeDecimal(window.limit),
        unit: routeText(window.unit),
        holdsWhy: routeText(window.holdsWhy),
        runsOutAt: routeText(window.runsOutAt),
        runsOut: safeDecimal(window.runsOut),
      }]
    })
    if (windows.length !== record.windows.length) return null
    const dailyRecord = record.daily === undefined ? null : asRecord(record.daily)
    const dailyPoints = dailyRecord === null ? [] : dailyRecord.days
    if (dailyRecord !== null && (!Array.isArray(dailyPoints) || dailyPoints.length > 366)) return null
    const days: { readonly day: string; readonly used: number | null }[] = (Array.isArray(dailyPoints) ? dailyPoints : []).flatMap((item) => {
      const point = asRecord(item)
      const day = routeText(point?.day)
      if (point === null || day === null) return []
      const used = safeDecimal(point.used)
      return [{ day, used }]
    })
    if (days.length !== (Array.isArray(dailyPoints) ? dailyPoints.length : 0)) return null
    quotas.push({
      provider,
      name,
      ...optionalQuotaIcon(record.icon),
      kind: routeText(record.kind),
      user: routeText(record.user),
      plan: routeText(record.plan),
      alias: routeText(record.alias),
      balance: routeText(record.balance),
      readAt: routeText(record.readAt),
      windows,
      daily: { since: routeText(dailyRecord?.since), days },
      ...readQuotaAccountMeta(record),
    })
  }
  return quotas
}

export function parseMagpieQuotaHistory(value: unknown): readonly MagpieQuotaHistory[] | null {
  const root = asRecord(value)
  const rows = Array.isArray(value) ? value : Array.isArray(root?.data) ? root.data : null
  if (rows === null || rows.length > 512) return null
  const history: MagpieQuotaHistory[] = []
  for (const row of rows) {
    const record = asRecord(row)
    const provider = routeText(record?.provider)
    if (record === null || provider === null || !Array.isArray(record.lines) || record.lines.length > 64) return null
    const lines = record.lines.flatMap((item) => {
      const line = asRecord(item)
      const name = routeText(line?.name)
      if (line === null || name === null || !Array.isArray(line.points) || line.points.length > 2_000) return []
      const points = line.points.flatMap((pointValue) => {
        const point = asRecord(pointValue)
        const at = routeText(point?.at)
        return point === null || at === null ? [] : [{
          at,
          left: safeDecimal(point.left),
          start: routeText(point.start),
          resetsAt: routeText(point.resetsAt),
        }]
      })
      if (points.length !== line.points.length) return []
      return [{ name, points }]
    })
    if (lines.length !== record.lines.length) return null
    history.push({ provider, user: routeText(record.user), lines })
  }
  return history
}

function readMagpieUsageMetrics(record: Record<string, unknown>): MagpieUsageMetrics {
  return {
    calls: safeCount(record.calls),
    errors: safeCount(record.errors),
    retried: safeCount(record.retried),
    inputTokens: safeCount(record.input),
    outputTokens: safeCount(record.output),
    cacheReadTokens: safeCount(record.cache_read),
    cacheWriteTokens: safeCount(record.cache_write),
    reasoningTokens: safeCount(record.reasoning),
    cost: safeDecimal(record.cost),
    unpriced: safeDecimal(record.unpriced),
    credits: safeDecimal(record.credits),
    credited: safeDecimal(record.credited),
    timed: safeCount(record.timed),
    ttftMs: safeDecimal(record.ttft_ms),
    decodeMs: safeDecimal(record.decode_ms),
    decodeTokens: safeCount(record.decode_out),
    decodeCount: safeCount(record.decode_n),
  }
}

function readMagpieSeries(value: unknown): readonly MagpieUsageSeriesPoint[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2_000) return null
  return value.flatMap((item) => {
    const record = asRecord(item)
    return record === null ? [] : [{
      time: routeText(record.time),
      label: routeText(record.label),
      ...readMagpieUsageMetrics(record),
    }]
  })
}

function readMagpieUsageGroups(value: unknown, dimension: 'agent' | 'provider' | 'model' | 'account'): readonly MagpieUsageGroup[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2_000) return null
  const idKeys: Readonly<Record<typeof dimension, readonly string[]>> = {
    agent: ['id', 'agent'],
    provider: ['provider', 'id'],
    model: ['model', 'id'],
    account: ['account', 'id'],
  }
  const groups = value.flatMap((item) => {
    const record = asRecord(item)
    if (record === null) return []
    const id = firstRouteText(record, idKeys[dimension])
    if (id === null) return []
    return [{
      id,
      name: routeText(record.name),
      provider: routeText(record.provider),
      model: routeText(record.model),
      account: routeText(record.account),
      agent: routeText(record.agent ?? record.id),
      ...readMagpieUsageMetrics(record),
    }]
  })
  if (dimension !== 'provider') return groups
  const byProvider = new Map<string, MagpieUsageGroup>()
  for (const group of groups) {
    const current = byProvider.get(group.id)
    if (current === undefined) {
      byProvider.set(group.id, group)
      continue
    }
    byProvider.set(group.id, {
      ...current,
      calls: sumNullable(current.calls, group.calls),
      errors: sumNullable(current.errors, group.errors),
      retried: sumNullable(current.retried, group.retried),
      inputTokens: sumNullable(current.inputTokens, group.inputTokens),
      outputTokens: sumNullable(current.outputTokens, group.outputTokens),
      cacheReadTokens: sumNullable(current.cacheReadTokens, group.cacheReadTokens),
      cacheWriteTokens: sumNullable(current.cacheWriteTokens, group.cacheWriteTokens),
      reasoningTokens: sumNullable(current.reasoningTokens, group.reasoningTokens),
      cost: sumNullable(current.cost, group.cost),
      unpriced: sumNullable(current.unpriced, group.unpriced),
      credits: sumNullable(current.credits, group.credits),
      credited: sumNullable(current.credited, group.credited),
      timed: sumNullable(current.timed, group.timed),
      ttftMs: null,
      decodeMs: null,
      decodeTokens: sumNullable(current.decodeTokens, group.decodeTokens),
      decodeCount: sumNullable(current.decodeCount, group.decodeCount),
    })
  }
  return [...byProvider.values()]
}

function readMagpieUsageSessions(value: unknown): readonly MagpieUsageSession[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2_000) return null
  return value.flatMap((item) => {
    const record = asRecord(item)
    const id = cleanText(record?.id)
    const agent = cleanText(record?.agent)
    return record === null || id === null || agent === null ? [] : [{ id, agent, ...readMagpieUsageMetrics(record) }]
  })
}

function parseMagpieRequestRows(
  rows: readonly unknown[],
  sessionId: string | null,
  sessionAgent: string | null,
  providerRecords: readonly MagpieProviderManagementRecord[] = [],
  sessionIds: readonly string[] = sessionId === null ? [] : [sessionId],
): readonly MagpieUsageRequest[] {
  const acceptedAgents = sessionAgent === null ? null : MAGPIE_USAGE_AGENT_ALIASES[sessionAgent] ?? [sessionAgent]
  const acceptedSessionIds = new Set(sessionIds)
  return rows.flatMap((row) => {
    const record = asRecord(row)
    if (record === null) return []
    const candidateSession = cleanText(record.session)
    const nativeSession = cleanText(record.native_session)
    const agent = cleanText(record.agent)
    if (sessionId !== null
      && (!acceptedSessionIds.has(candidateSession ?? '') && !acceptedSessionIds.has(nativeSession ?? '')
        || agent === null || acceptedAgents === null || !acceptedAgents.includes(agent))) return []
    const item = parseMagpieRequest(record, providerRecords)
    return item === null ? [] : [sessionId === null ? item : { ...item, sessionId }]
  })
}

function magpieRequestRowKey(value: unknown): string {
  const record = asRecord(value)
  const routeId = safeRouteId(record?.route_id)
  return routeId === null ? JSON.stringify(record) : `route:${routeId}`
}

function parseMagpieRequest(record: Record<string, unknown>, providerRecords: readonly MagpieProviderManagementRecord[] = []): MagpieUsageRequest | null {
  const agent = routeText(record.agent)
  const provider = normalizeMagpieRequestProvider(record, providerRecords)
  const requestedModel = routeText(record.req)
  const servedModel = routeText(record.served)
  const group = requestedModel?.startsWith('group/') === true ? requestedModel.slice('group/'.length) : null
  return {
    routeId: safeRouteId(record.route_id),
    time: routeText(record.t),
    agent,
    provider,
    account: normalizeMagpieRequestAccount(record, provider, providerRecords),
    requestedModel,
    servedModel,
    group,
    effort: routeText(record.effort),
    inputTokens: safeCount(record.in),
    outputTokens: safeCount(record.out),
    cacheReadTokens: safeCount(record.cache_read),
    cacheWriteTokens: safeCount(record.cache_write),
    reasoningTokens: safeCount(record.reasoning),
    cost: safeDecimal(record.cost),
    priced: typeof record.priced === 'boolean' ? record.priced : null,
    status: routeStatusText(record.status),
    durationMs: safeDecimal(record.ms),
    ttftMs: safeDecimal(record.ttft_ms),
    firstTextMs: safeDecimal(record.first_text_ms),
    firstReasoningMs: safeDecimal(record.first_reasoning_ms),
    flowMs: safeDecimal(record.flow_ms),
    sessionId: cleanText(record.session) ?? cleanText(record.native_session),
  }
}

/** Session-filtered rows can omit the account label; use only the matching provider's safe catalog label. */
function normalizeMagpieRequestAccount(
  record: Record<string, unknown>,
  provider: string | null,
  providerRecords: readonly MagpieProviderManagementRecord[],
): string | null {
  const account = routeText(record.providerAccount)
  if (account !== null || provider === null) return account
  const matches = providerRecords.filter((item) => item.id === provider)
  return matches.length === 1 ? matches[0]!.account : null
}

/**
 * Magpie's usage ledger can retain a stale provider id after an Agent provider
 * is renamed. Reconcile only Codex rows against the read-only provider catalog;
 * arbitrary provider ids must remain untouched when the evidence is ambiguous.
 */
function normalizeMagpieRequestProvider(
  record: Record<string, unknown>,
  providerRecords: readonly MagpieProviderManagementRecord[],
): string | null {
  const provider = routeText(record.provider)
  if (provider === null || routeText(record.agent)?.toLocaleLowerCase() !== 'codex') return provider
  const codexProviders = providerRecords.filter((item) => item.accountAgent?.toLocaleLowerCase() === 'codex')
  if (codexProviders.length === 0) return provider
  const modelValues = [record.model, record.served, record.req]
    .map(routeText)
    .filter((value): value is string => value !== null)
  const matches = codexProviders.filter((candidate) => candidate.models.some((model) =>
    modelValues.some((value) => magpieModelMatchesProvider(value, model.id, candidate.id))))
  if (matches.length === 1) return matches[0]!.id
  return codexProviders.length === 1 ? codexProviders[0]!.id : provider
}

function magpieModelMatchesProvider(value: string, modelId: string, providerId: string): boolean {
  if (value === modelId) return true
  const prefix = `${providerId}/`
  return modelId.startsWith(prefix) && value === modelId.slice(prefix.length)
}

function firstRouteText(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = routeText(record[key])
    if (value !== null) return value
  }
  return null
}

function sumNullable(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0)
}

function isMagpieDashboardPeriod(value: unknown): value is MagpieDashboardPeriod {
  return value === 'today' || value === 'week' || value === 'month' || value === 'all'
}

function magpieWebPeriod(period: MagpieDashboardPeriod): 'today' | '7d' | '30d' | 'all' {
  switch (period) {
    case 'today': return 'today'
    case 'week': return '7d'
    case 'month': return '30d'
    case 'all': return 'all'
  }
}

function emptyMagpieDashboard(period: MagpieDashboardPeriod, capturedAt: string): MagpieUsageDashboard {
  return {
    period,
    capturedAt,
    availabilityIssue: null,
    usageStatus: 'unavailable',
    aggregate: null,
    series: [],
    agents: [],
    providers: [],
    models: [],
    accounts: [],
    sessions: [],
    sessionCount: null,
    quotaStatus: 'unavailable',
    quotas: [],
    quotaHistoryStatus: 'unavailable',
    quotaHistory: [],
  }
}

/**
 * 窗口使用的百分比。
 *
 * Magpie 的 `used` 始终是 0–100 的百分比（见其 `auth.usage` 契约），但 `remaining`
 * 不一定：同一份数据里既有 `remaining: 96` 这种百分比，也有 `remaining: 86.57`
 * 配 `amount: 322.25 / limit: 2400` 这种"剩余量"。凡是带 `limit`（或 `amount`）的窗口，
 * `remaining` 一律按数量解释，不能直接当成 0–100 的百分比，否则 WorkBuddy 的
 * `322 / 2400` 会被读成"剩余 86.57%"，和 `display` 里的数量对不上。
 */
function quotaUsedPercent(record: Record<string, unknown>): number | null {
  return safePercent(record.used)
}

function quotaRemainingPercent(record: Record<string, unknown>): number | null {
  const counted = safeDecimal(record.limit) !== null || safeDecimal(record.amount) !== null
  if (counted) {
    const used = quotaUsedPercent(record)
    return used === null ? null : 100 - used
  }
  return safePercent(record.remaining)
}

function readQuotaWindow(record: Record<string, unknown>, name: string): MagpieQuotaWindow {
  return {
    name,
    usedPercent: quotaUsedPercent(record),
    remainingPercent: quotaRemainingPercent(record),
    resetsAt: routeText(record.resetsAt),
    display: routeText(record.display),
    amount: safeDecimal(record.amount),
    limit: safeDecimal(record.limit),
    unit: routeText(record.unit),
    holdsWhy: routeText(record.holdsWhy),
    startsAt: routeText(record.startsAt),
    runsOut: safeDecimal(record.runsOut),
    runsOutAt: routeText(record.runsOutAt),
  }
}

/**
 * Read the daily check-in result of providers that have one (WorkBuddy, Trae, MiniMax).
 *
 * `outcome` stays an upstream string: the client only localizes the outcomes it knows, so a
 * new vendor state never gets presented as a successful check-in.
 */
function readQuotaCheckin(value: unknown): MagpieQuotaCheckin | null {
  const record = asRecord(value)
  if (record === null) return null
  const checkin: MagpieQuotaCheckin = {
    day: routeText(record.day),
    at: routeText(record.at),
    outcome: routeText(record.outcome),
    credit: safeDecimal(record.credit),
    streak: safeCount(record.streak),
  }
  return Object.values(checkin).every((item) => item === null) ? null : checkin
}

function readQuotaDaily(value: unknown): MagpieQuota['daily'] {
  const record = asRecord(value)
  if (record === null) return undefined
  const points = record.days
  if (!Array.isArray(points) || points.length > 366) return undefined
  const days = points.flatMap((item) => {
    const point = asRecord(item)
    const day = routeText(point?.day)
    return point === null || day === null ? [] : [{ day, used: safeDecimal(point.used) }]
  })
  if (days.length !== points.length) return undefined
  return { since: routeText(record.since), days }
}

/**
 * Read a provider's remaining reset cards without exposing the vendor's raw record.
 *
 * `count` 缺失与 0 不同：上游在 0 张时会省略整个对象，因此这里只在对象存在时才返回，
 * 客户端把缺失显示为"未知"而不是"没有可用重置卡"。
 */
function readQuotaResets(value: unknown): NonNullable<MagpieQuota['resets']> | null {
  const record = asRecord(value)
  if (record === null) return null
  const eachPoints = record.each
  const each = Array.isArray(eachPoints)
    ? eachPoints.flatMap((item) => {
        const point = asRecord(item)
        if (point === null) return []
        return [{ window: routeText(point.window), until: routeText(point.until) }]
      }).slice(0, 64)
    : []
  return {
    count: safeCount(record.count),
    until: routeText(record.until),
    each,
    byWindow: record.byWindow === true,
    fiveHour: safeCount(record.fiveHour),
    weekly: safeCount(record.weekly),
  }
}

/** 会话级配额卡只带上 `daily`；上游缺字段时整个属性不出现。 */
function sessionQuotaDaily(record: Record<string, unknown>): { readonly daily?: NonNullable<MagpieQuota['daily']> } {
  const daily = readQuotaDaily(record.daily)
  return daily === undefined ? {} : { daily }
}

/**
 * 两个解析器共用的账号级字段。
 *
 * 单独声明而不是直接复用 `Partial<MagpieQuota>`：仪表盘的 `daily` 是带 `since` 的对象，
 * 会话级是同一结构，但用 `Partial` 会把两边的 `daily` 合并成联合类型，导致赋值处无法收敛。
 */
type QuotaAccountMeta = Pick<MagpieQuota, 'active' | 'checkin' | 'checkins' | 'error' | 'until' | 'renew' | 'resets' | 'credits'>

/**
 * Read the account-level fields shared by both quota parsers.
 *
 * `/api/usage/quotas` (session popover) and the dashboard read the same rows; keeping these
 * fields in one place stops the two views drifting apart. Absent values stay `undefined` so
 * older Magpie builds keep working.
 */
function readQuotaAccountMeta(record: Record<string, unknown>): QuotaAccountMeta {
  const checkin = readQuotaCheckin(record.checkin)
  const resets = readQuotaResets(record.resets)
  return {
    ...(typeof record.active === 'boolean' ? { active: record.active } : {}),
    ...(checkin === null ? {} : { checkin }),
    ...(record.checkins === true ? { checkins: true } : {}),
    error: routeText(record.error),
    until: routeText(record.until),
    renew: routeText(record.renew),
    ...(resets === null ? {} : { resets }),
    credits: routeText(record.credits),
  }
}

function optionalQuotaIcon(value: unknown): { readonly icon?: string } {
  const icon = routeText(value)
  if (icon === null) return {}
  if (/^file:[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(icon)) return { icon }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(icon) ? { icon } : {}
}

function magpieIconAssetPaths(icon: string): readonly string[] {
  if (/^file:[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(icon)) {
    return [`/api/icons/${encodeURIComponent(icon.slice('file:'.length))}`]
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(icon)) return []
  return [`/icons/${icon}.svg`, `/icons/${icon}.png`]
}

function providerFromRoute(route: MagpieRouteUsage | null): string | null {
  if (route === null) return null
  const models = [route.model, route.served, ...route.tries.map((attempt) => attempt.model)]
  for (const model of models) {
    const provider = providerFromModel(model)
    if (provider !== null) return provider
  }
  return null
}

function providerFromModelId(modelId: string, agent: MagpieAgent): string | null {
  const normalized = stripMagpieProviderPrefix(agent, modelId)
  return providerFromModel(normalized)
}

function providerFromModel(value: string | null): string | null {
  if (value === null) return null
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  const provider = value.slice(0, slash)
  return provider === 'group' || provider === 'auto'
    ? null
    : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(provider) ? provider : null
}

function readRule(value: unknown): string | null {
  const text = routeText(value)
  if (text !== null) return text
  const record = asRecord(value)
  return routeText(record?.name) ?? routeText(record?.id)
}

function routeStatusText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return String(value)
  const text = routeText(value)
  return text !== null && /^[A-Za-z0-9_-]{1,32}$/u.test(text) ? text : null
}

function routeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240)
  return text === '' ? null : text
}

function safePercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

function safeDecimal(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' || text.length > 512 || /[\u0000-\u001f\u007f]/u.test(text) ? null : text
}

function cleanSessionName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240)
  return text === '' ? null : text
}

/** Pi and Command Code store Magpie selections with a local `magpie/` provider prefix. */
function resolveCatalogModelId(agent: MagpieAgent, requestedModelId: string, catalog: MagpieModelCatalog | null, modelName?: string): string | null {
  if (catalog === null) return null
  const catalogModelId = catalogModelIdForRequested(agent, requestedModelId)
  if (catalogModelId !== null && catalog.models.has(catalogModelId)) return catalogModelId
  const normalizedName = normalizeMagpieModelName(modelName)
  return normalizedName === null ? null : catalog.names.get(normalizedName) ?? null
}

function catalogModelIdForRequested(agent: MagpieAgent, requestedModelId: string): string | null {
  const normalized = stripMagpieProviderPrefix(agent, requestedModelId)
  // Claude appends this context-window marker to model IDs returned by its
  // initialize protocol; Magpie's verified catalog keeps the canonical ID.
  return agent === 'claude' ? normalized.replace(/\[1m\]$/u, '') : normalized
}

function stripMagpieProviderPrefix(agent: MagpieAgent, modelId: string): string {
  return (agent === 'commandcode' || agent === 'pi') && modelId.startsWith('magpie/')
    ? modelId.slice('magpie/'.length)
    : modelId
}

function normalizeMagpieModelName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
  return name === '' || name.length > 200 ? null : name
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safeCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
