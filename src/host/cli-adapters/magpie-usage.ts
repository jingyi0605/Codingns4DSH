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
  MagpieQuotaWindow,
  MagpieRouteUsage,
  MagpieSessionUsage,
  MagpieUsageSnapshot,
  MagpieUsageTotals,
} from '../../shared/contracts/subscription.js'
import { commandEnvironment, resolveCommandPath, runAsyncCommand, WINDOWS, withCommandSignal } from './process-utils.js'

const MAGPIE_CATALOG_TTL_MS = 60_000
const MAGPIE_MODEL_METADATA_TTL_MS = 60_000
const MAGPIE_FAILURE_CACHE_TTL_MS = 5_000
const MAX_MAGPIE_MODEL_METADATA_CACHE_ENTRIES = 4
const MAGPIE_MINIMUM_CLI_VERSION = [0, 1, 1295] as const
const MAGPIE_CLI_TIMEOUT_MS = 10_000
const MAGPIE_HTTP_TIMEOUT_MS = 3_000
const MAX_MAGPIE_CLI_OUTPUT_BYTES = 512 * 1024
const MAX_MAGPIE_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MAGPIE_MODELS = 10_000
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
  /** Shared catalog CLI work is cancelled when its owning Host feature stops, not by one RPC caller. */
  readonly lifetimeSignal?: AbortSignal
}

/**
 * Reads Magpie's public local Gateway API only after its CLI confirms that the
 * current Agent model is in that Agent's catalog. No Agent or Magpie config
 * files are opened here; the provider session ID is supplied by the Host.
 */
export class MagpieUsageService {
  private readonly readModels: NonNullable<MagpieUsageServiceOptions['readModels']>
  private readonly readVersion: NonNullable<MagpieUsageServiceOptions['readVersion']>
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly lifetimeSignal: AbortSignal | undefined
  /** Agent CLI verification remains isolated; model metadata below is Gateway-wide and shared. */
  private readonly catalogs = new Map<MagpieAgent, CatalogCacheEntry>()
  private readonly catalogLoads = new Map<MagpieAgent, Promise<MagpieModelCatalog | null>>()
  /** `/v1/models` is Gateway-wide, so adapters with the same model set share one normalized response. */
  private readonly modelMetadata = new Map<string, ModelMetadataCacheEntry>()
  private readonly modelMetadataLoads = new Map<string, Promise<ReadonlyMap<string, MagpieModelMetadata> | null>>()
  private versionCheck: { readonly supported: boolean; readonly checkedAt: number } | undefined
  private versionLoad: Promise<boolean> | undefined

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

    const catalog = await this.loadCatalog(agent, signal)
    const modelId = resolveCatalogModelId(agent, requestedModelId, catalog, requestedModelId)
    if (catalog === null || modelId === null) return null

    const providerSessionId = cleanText(session.providerSessionId)
    // Some drivers may temporarily fall back to the DSH key before their
    // native session ID is known. Never treat that fallback as a Magpie ID.
    const sessionId = providerSessionId !== null && providerSessionId !== cleanText(dshSessionId)
      ? providerSessionId
      : null
    return this.readFromGateway(agent, requestedModelId, catalog.gatewayOrigin, sessionId, signal, includeRoute)
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

  private async readFromGateway(agent: MagpieAgent, modelId: string, gatewayOrigin: string | null, sessionId: string | null, signal: AbortSignal | undefined, includeRoute: boolean): Promise<MagpieUsageSnapshot> {
    const capturedAt = new Date(this.now()).toISOString()
    if (gatewayOrigin === null) return unavailableMagpieSnapshot(agent, modelId, sessionId, this.now(), capturedAt)
    const [usageResult, quotaResult] = await Promise.all([
      this.readGatewayJson(gatewayOrigin, '/v1/magpie/usage?period=today', signal),
      this.readGatewayJson(gatewayOrigin, '/v1/magpie/quotas', signal),
    ])
    const aggregate = usageResult.ok ? readTotals(usageResult.value) : null
    const sessionUsage = usageResult.ok && sessionId !== null
      ? readSession(usageResult.value, agent, sessionId)
      : null
    // A providerSessionId is not enough to prove that Magpie knows this Agent
    // session. Require the exact Agent + ID pair in Magpie's own usage result
    // before asking the route endpoint, and then verify its echoed identity.
    const canReadRoute = includeRoute && sessionId !== null && sessionId.length <= 128 && sessionUsage !== null
    const routeResultPromise = canReadRoute
      ? this.readGatewayJson(gatewayOrigin, `/v1/magpie/route?session=${encodeURIComponent(sessionId)}`, signal)
      : Promise.resolve({ ok: false as const })
    const routeHistoryResultPromise = canReadRoute
      ? this.readGatewayJson(gatewayOrigin, `/v1/magpie/usage/requests?period=today&q=${encodeURIComponent(sessionId)}&limit=100`, signal)
      : Promise.resolve({ ok: false as const })
    const [routeResult, routeHistoryResult] = await Promise.all([routeResultPromise, routeHistoryResultPromise])
    const routeRead = sessionId === null
      ? { status: 'session-unavailable' as const, route: null }
      : !includeRoute
        ? { status: 'not-requested' as const, route: null }
        : !canReadRoute
          ? { status: 'unavailable' as const, route: null }
        : !routeResult.ok
          ? { status: 'unavailable' as const, route: null }
          : readRoute(routeResult.value, sessionId)
    const routeHistory = routeHistoryResult.ok && sessionId !== null && sessionUsage !== null
      ? readSessionRouteHistory(routeHistoryResult.value, agent, sessionId)
      : []
    const route = routeRead.route === null
      ? routeHistory[0]?.route ?? null
      : enrichRouteWithHistory(routeRead.route, routeHistory)
    const routeStatus = route !== null
      ? 'available' as const
      : routeRead.status
    const allQuotas = quotaResult.ok ? parseMagpieQuotas(quotaResult.value) : null
    const routeProviders = [...new Set([
      providerFromRoute(route),
      ...routeHistory.map((record) => record.provider),
    ].filter((provider): provider is string => provider !== null))]
    const upstreamProviders = routeProviders.length > 0
      ? routeProviders
      : [providerFromModelId(modelId, agent)].filter((provider): provider is string => provider !== null)
    const upstreamProvider = upstreamProviders[0] ?? null
    const quotas = allQuotas === null
      ? []
      : filterSessionQuotas(allQuotas, upstreamProviders, routeHistory)

    return {
      agent,
      modelId,
      capturedAt,
      usageStatus: aggregate === null ? 'unavailable' : 'available',
      aggregate,
      sessionId,
      session: sessionUsage,
      routeStatus,
      route,
      upstreamProvider,
      upstreamProviders,
      quotaStatus: allQuotas === null ? 'unavailable' : upstreamProviders.length === 0 ? 'provider-unavailable' : 'available',
      quotas,
    }
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
      this.catalogs.set(agent, { catalog: result, loadedAt: this.now() })
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
      .then((value) => parseMagpieCliVersion(value))
      .then((supported) => {
        this.versionCheck = { supported, checkedAt: this.now() }
        return supported
      })
      .catch(() => {
        this.versionCheck = { supported: false, checkedAt: this.now() }
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
}

function unavailableMagpieSnapshot(agent: string, modelId: string, sessionId: string | null, now: number, capturedAt = new Date(now).toISOString()): MagpieUsageSnapshot {
  return {
    agent,
    modelId,
    capturedAt,
    usageStatus: 'unavailable',
    aggregate: null,
    sessionId,
    session: null,
    routeStatus: sessionId === null ? 'session-unavailable' : 'unavailable',
    route: null,
    upstreamProvider: providerFromModelId(modelId, agent),
    quotaStatus: 'unavailable',
    quotas: [],
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
 * every result is still checked against Magpie's own catalog output before
 * any Gateway request is made.
 */
export function magpieAgentForAdapter(adapterId: CodingNsCliAdapterId): MagpieAgent | null {
  const agent = MAGPIE_AGENT_BY_ADAPTER[adapterId]
  return agent !== undefined && isMagpieAgentId(agent) ? agent : null
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

function readRoute(value: unknown, expectedSessionId: string): { readonly status: 'available' | 'no-route' | 'unavailable'; readonly route: MagpieRouteUsage | null } {
  const envelope = asRecord(value)
  if (envelope === null || cleanText(envelope.session) !== expectedSessionId || !('route' in envelope)) return { status: 'unavailable', route: null }
  if (envelope.route === null) return { status: 'no-route', route: null }
  const record = asRecord(envelope.route)
  if (record === null) return { status: 'unavailable', route: null }
  const tries = Array.isArray(record.tries)
    ? record.tries.slice(0, 20).flatMap((item) => {
        const attempt = asRecord(item)
        if (attempt === null) return []
        const model = routeText(attempt.model)
        const provider = routeText(attempt.provider)
        return [{
          model: model !== null && provider !== null && !model.includes('/') ? `${provider}/${model}` : model ?? provider,
          failed: routeText(attempt.fail) !== null,
        }]
      })
    : []
  return {
    status: 'available',
    route: {
      asked: routeText(record.asked),
      group: routeText(record.group),
      rule: readRule(record.rule),
      model: routeText(record.model),
      effort: routeText(record.effort),
      tries,
      done: typeof record.done === 'boolean' ? record.done : null,
      status: routeStatusText(record.status),
      served: routeText(record.served),
      routeId: safeRouteId(record.id),
      time: routeText(record.time),
      providerAccount: routeText(record.providerAccount),
    },
  }
}

/** Read the durable request ledger when Magpie's short in-memory trace has expired. */
function readSessionRouteHistory(value: unknown, agent: MagpieAgent, sessionId: string): readonly MagpieSessionRouteRecord[] {
  const rows = asRecord(value)?.rows
  if (!Array.isArray(rows) || rows.length > 500) return []
  const usageAgents = MAGPIE_USAGE_AGENT_ALIASES[agent] ?? [agent]
  return rows.slice(0, 100).flatMap((item) => {
    const record = asRecord(item)
    const rowAgent = cleanText(record?.agent)
    const session = cleanText(record?.session)
    const nativeSession = cleanText(record?.native_session)
    const provider = routeText(record?.provider)
    if (record === null || rowAgent === null || !usageAgents.includes(rowAgent)
      || (session !== sessionId && nativeSession !== sessionId) || provider === null) return []

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

function enrichRouteWithHistory(route: MagpieRouteUsage, history: readonly MagpieSessionRouteRecord[]): MagpieRouteUsage {
  if (route.routeId === undefined || route.routeId === null) return route
  const record = history.find((item) => item.route.routeId === route.routeId)
  if (record === undefined) return route
  return {
    ...route,
    time: route.time ?? record.route.time ?? null,
    providerAccount: route.providerAccount ?? record.account,
  }
}

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
    return candidates.filter((quota) => quota.user !== null && accounts.has(quota.user))
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
      kind: routeText(record.kind),
      user: routeText(record.user),
      plan: routeText(record.plan),
      alias: routeText(record.alias),
      balance: routeText(record.balance),
      readAt: routeText(record.readAt),
      windows,
    })
  }
  return quotas
}

function readQuotaWindow(record: Record<string, unknown>, name: string): MagpieQuotaWindow {
  return {
    name,
    usedPercent: safePercent(record.used),
    remainingPercent: safePercent(record.remaining),
    resetsAt: routeText(record.resetsAt),
    display: routeText(record.display),
    amount: safeDecimal(record.amount),
    limit: safeDecimal(record.limit),
    unit: routeText(record.unit),
    holdsWhy: routeText(record.holdsWhy),
  }
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
