import type {
  CodingNsAgentEvent,
  CodingNsAgentQuestionResponse,
  CodingNsCliAdapterDescriptor,
  CodingNsCliAdapterId,
  CodingNsCliModelCatalog,
  CodingNsAgentPermissionResponse,
  CodingNsCliSessionConfig,
  CodingNsCliSessionRecord,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type {
  CodingNsCliDriver,
  CodingNsCliSessionProbeInput,
  CodingNsCliSessionProbeResult,
} from './driver.js'
import { CodingNsCliSessionStore } from './session-store.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'

type CodingNsCliDetection = Pick<CodingNsCliAdapterDescriptor, 'installed' | 'version' | 'command'>

interface TimedCacheEntry<Value> {
  readonly value: Value
  readonly expiresAt: number
}

interface TimedFailure {
  readonly error: unknown
  readonly expiresAt: number
}

const DEFAULT_INSTALLED_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_UNINSTALLED_CACHE_TTL_MS = 30_000
const DEFAULT_MODEL_CACHE_TTL_MS = 10 * 60_000
const DEFAULT_MODEL_RETRY_TTL_MS = 15_000

export class CodingNsCliAdapterRegistry {
  private readonly drivers = new Map<CodingNsCliAdapterId, CodingNsCliDriver>()
  private readonly sessions = new Map<string, CodingNsCliSessionConfig>()
  private readonly enabled = new Map<CodingNsCliAdapterId, boolean>()
  private readonly providerProbeTtlMs: number
  private readonly missingConfirmationDelayMs: number
  private readonly providerProbeTimeoutMs: number
  private readonly providerProbeConcurrency: number
  private readonly probes = new Map<string, Promise<void>>()
  private readonly executingSessions = new Set<string>()
  private readonly archivingSessions = new Set<string>()
  private readonly installedCacheTtlMs: number
  private readonly uninstalledCacheTtlMs: number
  private readonly modelCacheTtlMs: number
  private readonly modelRetryTtlMs: number
  private readonly detectionCache = new Map<CodingNsCliAdapterId, TimedCacheEntry<CodingNsCliDetection>>()
  private readonly detectionRefreshes = new Map<CodingNsCliAdapterId, Promise<CodingNsCliDetection>>()
  private readonly detectionTimers = new Map<CodingNsCliAdapterId, ReturnType<typeof setTimeout>>()
  private readonly modelCache = new Map<CodingNsCliAdapterId, TimedCacheEntry<CodingNsCliModelCatalog>>()
  private readonly modelFailures = new Map<CodingNsCliAdapterId, TimedFailure>()
  private readonly modelRefreshes = new Map<CodingNsCliAdapterId, Promise<CodingNsCliModelCatalog>>()
  private readonly modelTimers = new Map<CodingNsCliAdapterId, ReturnType<typeof setTimeout>>()
  private readonly modelGenerations = new Map<CodingNsCliAdapterId, number>()
  private readonly requestedModelCatalogs = new Set<CodingNsCliAdapterId>()
  private cacheGeneration = 0
  private disposed = false

  constructor(
    drivers: readonly CodingNsCliDriver[],
    enabled: Readonly<Record<string, boolean>> = {},
    options: {
      readonly sessionStore?: CodingNsCliSessionStore
      readonly nativeSessions?: CodingNsNativeSessionBridge
      readonly providerProbeTtlMs?: number
      readonly missingConfirmationDelayMs?: number
      readonly providerProbeTimeoutMs?: number
      readonly providerProbeConcurrency?: number
      readonly installedCacheTtlMs?: number
      readonly uninstalledCacheTtlMs?: number
      readonly modelCacheTtlMs?: number
      readonly modelRetryTtlMs?: number
    } = {},
  ) {
    this.sessionStore = options.sessionStore
    this.nativeSessions = options.nativeSessions
    this.providerProbeTtlMs = options.providerProbeTtlMs ?? 60_000
    this.missingConfirmationDelayMs = options.missingConfirmationDelayMs ?? 2_000
    this.providerProbeTimeoutMs = Math.max(1, options.providerProbeTimeoutMs ?? 10_000)
    this.providerProbeConcurrency = Math.max(1, Math.floor(options.providerProbeConcurrency ?? 4))
    this.installedCacheTtlMs = positiveTtl(options.installedCacheTtlMs, DEFAULT_INSTALLED_CACHE_TTL_MS)
    this.uninstalledCacheTtlMs = positiveTtl(options.uninstalledCacheTtlMs, DEFAULT_UNINSTALLED_CACHE_TTL_MS)
    this.modelCacheTtlMs = positiveTtl(options.modelCacheTtlMs, DEFAULT_MODEL_CACHE_TTL_MS)
    this.modelRetryTtlMs = positiveTtl(options.modelRetryTtlMs, DEFAULT_MODEL_RETRY_TTL_MS)
    for (const driver of drivers) {
      if (this.drivers.has(driver.descriptor.id)) throw new Error(`重复 Agent: ${driver.descriptor.id}`)
      this.drivers.set(driver.descriptor.id, driver)
      this.enabled.set(driver.descriptor.id, enabled[driver.descriptor.id] !== false)
    }
    for (const record of this.sessionStore?.list({ includeArchived: true }) ?? []) {
      const {
        dshSessionId: _dshSessionId,
        title: _title,
        cwd: _cwd,
        status: _status,
        providerState: _providerState,
        providerCheckedAt: _providerCheckedAt,
        providerStateReason: _providerStateReason,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        lastError: _lastError,
        ...config
      } = record
      this.sessions.set(record.dshSessionId, config)
    }
  }

  private readonly sessionStore: CodingNsCliSessionStore | undefined
  private readonly nativeSessions: CodingNsNativeSessionBridge | undefined

  /** Host 启动后预热安装状态；定时器让同步 CLI 探测不阻塞功能模块装配。 */
  warmCatalog(): void {
    for (const driver of this.drivers.values()) this.scheduleDetectionRefresh(driver.descriptor.id, 0)
  }

  async catalog(): Promise<CodingNsCliAdapterDescriptor[]> {
    return Promise.all([...this.drivers.values()].map(async (driver) => {
      const detection = await this.readDetection(driver)
      return { ...driver.descriptor, enabled: this.isEnabled(driver.descriptor.id), ...detection }
    }))
  }

  async models(adapterId: CodingNsCliAdapterId): Promise<CodingNsCliModelCatalog> {
    const driver = this.requireEnabledDriver(adapterId)
    this.requestedModelCatalogs.add(adapterId)
    const cached = this.modelCache.get(adapterId)
    if (cached !== undefined) {
      if (cached.expiresAt <= Date.now()) void this.refreshModels(driver).catch(() => undefined)
      return cached.value
    }
    const failure = this.modelFailures.get(adapterId)
    if (failure !== undefined) {
      if (failure.expiresAt <= Date.now()) void this.refreshModels(driver).catch(() => undefined)
      throw failure.error
    }
    return this.refreshModels(driver)
  }

  setEnabled(adapterId: CodingNsCliAdapterId, enabled: boolean): boolean {
    this.requireDriver(adapterId)
    const previous = this.isEnabled(adapterId)
    this.enabled.set(adapterId, enabled)
    if (previous === enabled) return enabled
    if (!enabled) this.clearTimer(this.modelTimers, adapterId)
    else if (this.requestedModelCatalogs.has(adapterId)) this.scheduleModelRefresh(adapterId, 0)
    return enabled
  }

  applyEnabledSettings(settings: Readonly<Record<string, boolean>> | undefined): void {
    for (const adapterId of this.enabled.keys()) this.setEnabled(adapterId, settings?.[adapterId] !== false)
  }

  isEnabled(adapterId: CodingNsCliAdapterId): boolean {
    return this.enabled.get(adapterId) ?? false
  }

  enabledSnapshot(): Record<string, boolean> {
    return Object.fromEntries(this.enabled.entries())
  }

  setSession(sessionId: string, config: CodingNsCliSessionConfig): CodingNsCliSessionConfig {
    if (sessionId.trim() === '') throw new CodingNsRpcError('CODINGNS_CLI_INVALID_SESSION', 'sessionId 不能为空')
    // dsh 是 DSH 自带的默认 Agent，不对应一个外部驱动，但仍需要作为会话
    // 配置保存值，方便 Client 从外部 CLI 切回默认 Agent。
    if (config.adapterId !== 'dsh') this.requireEnabledDriver(config.adapterId)
    const previous = this.sessions.get(sessionId)
    const sameAdapter = previous?.adapterId === config.adapterId
    const providerSessionId = config.providerSessionId?.trim()
    const providerIdentityChanged = providerSessionId !== undefined
      && providerSessionId !== previous?.providerSessionId
    const normalized = {
      adapterId: config.adapterId,
      ...(config.modelId?.trim() ? { modelId: config.modelId.trim() } : {}),
      ...(config.effortId?.trim() ? { effortId: config.effortId.trim() } : {}),
      ...(providerSessionId ? { providerSessionId } : sameAdapter && previous?.providerSessionId ? { providerSessionId: previous.providerSessionId } : {}),
      ...(config.rawStoreRef?.trim()
        ? { rawStoreRef: config.rawStoreRef.trim() }
        : sameAdapter && !providerIdentityChanged && previous?.rawStoreRef
          ? { rawStoreRef: previous.rawStoreRef }
          : {}),
    }
    this.sessions.set(sessionId, normalized)
    this.sessionStore?.upsert(sessionId, normalized)
    return normalized
  }

  getSession(sessionId: string): CodingNsCliSessionConfig {
    const session = this.sessions.get(sessionId)
    return session !== undefined && (session.adapterId === 'dsh' || this.isEnabled(session.adapterId)) ? session : { adapterId: 'dsh' }
  }

  async *execute(input: CodingNsCliTurnInput & { readonly adapterId: CodingNsCliAdapterId }): AsyncIterable<CodingNsAgentEvent> {
    const driver = this.requireEnabledDriver(input.adapterId)
    if (this.archivingSessions.has(input.sessionId)) {
      throw new CodingNsRpcError('CODINGNS_CLI_INVALID_SESSION', '外部会话正在归档，不能开始新一轮执行')
    }
    if (this.executingSessions.has(input.sessionId)) {
      throw new CodingNsRpcError('CODINGNS_CLI_INVALID_SESSION', '外部会话已有一轮执行正在进行')
    }
    this.executingSessions.add(input.sessionId)
    let current = this.sessions.get(input.sessionId) ?? { adapterId: input.adapterId }
    try {
      const stored = this.sessionStore?.get(input.sessionId)
      if (stored?.status === 'archived') {
        throw new CodingNsRpcError('CODINGNS_CLI_INVALID_SESSION', '外部会话已归档，不能继续执行')
      }
      if (stored !== undefined && (stored.providerSessionId !== undefined || stored.rawStoreRef !== undefined)) {
        await this.refreshProviderState(stored, true)
        if (this.sessionStore?.get(input.sessionId)?.providerState === 'missing') {
          throw new CodingNsRpcError('CODINGNS_CLI_SESSION_MISSING', '外部 Agent 原始会话已删除，无法继续恢复')
        }
      }
      this.sessions.set(input.sessionId, current)
      this.sessionStore?.upsert(input.sessionId, {
        ...current,
        adapterId: input.adapterId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        status: 'active',
        title: input.prompt,
      })
      // Agent Loop 通常已经创建了同名 DSH 原生会话；直接调用 Registry 时才按需补建。
      // 原生服务失败不能阻断外部 Agent，消息仍由现有 llm/stream 链路处理。
      try { await this.nativeSessions?.ensure(input.sessionId, input.cwd) } catch { /* 可选服务降级 */ }
      for await (const event of driver.executeTurn(input)) {
        if (event.type === 'session-binding') {
          const providerIdentityChanged = event.providerSessionId !== current.providerSessionId
          const { rawStoreRef: previousRawStoreRef, ...currentWithoutRawStoreRef } = current
          const next = {
            ...currentWithoutRawStoreRef,
            providerSessionId: event.providerSessionId,
            ...(event.rawStoreRef
              ? { rawStoreRef: event.rawStoreRef }
              : !providerIdentityChanged && previousRawStoreRef
                ? { rawStoreRef: previousRawStoreRef }
                : {}),
          }
          this.sessions.set(input.sessionId, next)
          current = next
          this.sessionStore?.upsert(input.sessionId, {
            ...next,
            status: 'active',
            providerState: 'available',
            providerCheckedAt: new Date().toISOString(),
          })
        }
        if (event.type === 'finish') this.sessionStore?.upsert(input.sessionId, { ...this.sessions.get(input.sessionId) ?? current, status: event.reason === 'error' ? 'error' : 'idle' })
        yield event
      }
    } catch (error) {
      this.sessionStore?.upsert(input.sessionId, {
        ...this.sessions.get(input.sessionId) ?? current,
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      this.executingSessions.delete(input.sessionId)
      try { await this.nativeSessions?.flush(input.sessionId) } catch { /* DSH 自身检查点策略负责重试 */ }
    }
  }

  async listSessions(options: { readonly includeArchived?: boolean; readonly adapterId?: string } = {}): Promise<CodingNsCliSessionRecord[]> {
    const candidates = this.sessionStore?.list(options) ?? []
    await forEachConcurrent(candidates, this.providerProbeConcurrency, (record) => this.refreshProviderState(record, false))
    return (this.sessionStore?.list(options) ?? [])
      .filter((record) => record.adapterId !== 'dsh')
      .map(({ rawStoreRef: _rawStoreRef, ...record }) => record)
  }

  async archiveSession(sessionId: string): Promise<CodingNsCliSessionRecord | undefined> {
    const current = this.sessionStore?.get(sessionId)
    if (current === undefined) return undefined
    if (current.status === 'active' || this.executingSessions.has(sessionId)) {
      throw new CodingNsRpcError('CODINGNS_CLI_INVALID_SESSION', '外部会话正在执行，不能归档')
    }
    if (this.archivingSessions.has(sessionId)) {
      throw new CodingNsRpcError('CODINGNS_CLI_INVALID_SESSION', '外部会话正在归档')
    }
    this.archivingSessions.add(sessionId)
    try {
      // 完整 DSH 中先改变原生侧栏可见性；调用失败时不修改插件索引，避免两边状态分叉。
      if (this.nativeSessions !== undefined) {
        const archived = await this.nativeSessions.archive?.(sessionId) ?? false
        if (!archived) {
          throw new CodingNsRpcError('CODINGNS_CLI_UNAVAILABLE', 'DSH 原生会话归档服务不可用，未修改外部会话索引')
        }
      }
      const record = this.sessionStore?.archive(sessionId)
      if (record === undefined) return undefined
      const { rawStoreRef: _rawStoreRef, ...safe } = record
      return safe
    } finally {
      this.archivingSessions.delete(sessionId)
    }
  }

  async respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): Promise<void> {
    const session = this.requireSession(sessionId)
    const driver = this.requireEnabledDriver(session.adapterId)
    if (driver.respondPermission === undefined) throw new CodingNsRpcError('CODINGNS_CLI_UNSUPPORTED', '当前 Agent 不支持权限回传')
    await driver.respondPermission(sessionId, response)
  }

  async respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): Promise<void> {
    const session = this.requireSession(sessionId)
    const driver = this.requireEnabledDriver(session.adapterId)
    if (driver.respondQuestion === undefined) throw new CodingNsRpcError('CODINGNS_CLI_UNSUPPORTED', '当前 Agent 不支持问题回传')
    await driver.respondQuestion(sessionId, response)
  }

  async steer(sessionId: string, prompt: string, followUp = false): Promise<void> {
    const session = this.requireSession(sessionId)
    const driver = this.requireEnabledDriver(session.adapterId)
    const handler = followUp ? driver.followUp : driver.steer
    if (handler === undefined) throw new CodingNsRpcError('CODINGNS_CLI_UNSUPPORTED', '当前 Agent 不支持运行中消息')
    await handler.call(driver, sessionId, prompt)
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId)
    const driver = this.requireEnabledDriver(session.adapterId)
    if (driver.interrupt === undefined) throw new CodingNsRpcError('CODINGNS_CLI_UNSUPPORTED', '当前 Agent 不支持中断')
    await driver.interrupt(sessionId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.cacheGeneration += 1
    this.clearAllTimers(this.detectionTimers)
    this.clearAllTimers(this.modelTimers)
    this.detectionCache.clear()
    this.modelCache.clear()
    this.modelFailures.clear()
    this.modelGenerations.clear()
    this.requestedModelCatalogs.clear()
    await Promise.all([...this.drivers.values()].map((driver) => driver.dispose?.()))
  }

  private async readDetection(driver: CodingNsCliDriver): Promise<CodingNsCliDetection> {
    const adapterId = driver.descriptor.id
    const cached = this.detectionCache.get(adapterId)
    if (cached !== undefined) {
      if (cached.expiresAt <= Date.now()) void this.refreshDetection(driver)
      return cached.value
    }
    return this.refreshDetection(driver)
  }

  /** 同一适配器只允许一个探测；刷新失败时保留最后一次可用状态。 */
  private refreshDetection(driver: CodingNsCliDriver): Promise<CodingNsCliDetection> {
    const adapterId = driver.descriptor.id
    const running = this.detectionRefreshes.get(adapterId)
    if (running !== undefined) return running
    this.clearTimer(this.detectionTimers, adapterId)
    const generation = this.cacheGeneration
    const previous = this.detectionCache.get(adapterId)
    const refresh = (async () => {
      let detection: CodingNsCliDetection
      let failed = false
      try {
        detection = await driver.detect()
      } catch {
        failed = true
        detection = previous?.value ?? { installed: false, version: null, command: null }
      }
      if (this.disposed || generation !== this.cacheGeneration) return detection

      const ttl = failed
        ? this.uninstalledCacheTtlMs
        : detection.installed
          ? this.installedCacheTtlMs
          : this.uninstalledCacheTtlMs
      this.detectionCache.set(adapterId, { value: detection, expiresAt: Date.now() + ttl })
      this.scheduleDetectionRefresh(adapterId, ttl)

      if (previous !== undefined && detectionFingerprint(previous.value) !== detectionFingerprint(detection)) {
        this.invalidateModelCache(adapterId)
        if (detection.installed && this.requestedModelCatalogs.has(adapterId) && this.isEnabled(adapterId)) {
          this.scheduleModelRefresh(adapterId, 0)
        }
      }
      return detection
    })().finally(() => {
      if (this.detectionRefreshes.get(adapterId) === refresh) this.detectionRefreshes.delete(adapterId)
    })
    this.detectionRefreshes.set(adapterId, refresh)
    return refresh
  }

  /** 模型目录使用 stale-while-revalidate；空结果和失败只缩短重试间隔。 */
  private refreshModels(driver: CodingNsCliDriver): Promise<CodingNsCliModelCatalog> {
    const adapterId = driver.descriptor.id
    const running = this.modelRefreshes.get(adapterId)
    if (running !== undefined) return running
    this.clearTimer(this.modelTimers, adapterId)
    const generation = this.cacheGeneration
    const modelGeneration = this.modelGenerations.get(adapterId) ?? 0
    const previous = this.modelCache.get(adapterId)
    const refresh = (async () => {
      try {
        const catalog = await driver.listModels()
        if (this.disposed || generation !== this.cacheGeneration) return previous?.value ?? catalog
        if (modelGeneration !== (this.modelGenerations.get(adapterId) ?? 0)) return this.refreshModels(driver)

        this.modelFailures.delete(adapterId)
        const hasModels = catalogHasModels(catalog)
        const keepPrevious = !hasModels && previous !== undefined && catalogHasModels(previous.value)
        const value = keepPrevious ? previous.value : catalog
        const ttl = hasModels ? this.modelCacheTtlMs : this.modelRetryTtlMs
        this.modelCache.set(adapterId, { value, expiresAt: Date.now() + ttl })
        this.scheduleModelRefresh(adapterId, ttl)
        return value
      } catch (error) {
        if (this.disposed || generation !== this.cacheGeneration) {
          if (previous !== undefined) return previous.value
          throw error
        }
        if (modelGeneration !== (this.modelGenerations.get(adapterId) ?? 0)) return this.refreshModels(driver)
        if (previous !== undefined) {
          this.modelCache.set(adapterId, { value: previous.value, expiresAt: Date.now() + this.modelRetryTtlMs })
          this.scheduleModelRefresh(adapterId, this.modelRetryTtlMs)
          return previous.value
        }
        this.modelFailures.set(adapterId, { error, expiresAt: Date.now() + this.modelRetryTtlMs })
        this.scheduleModelRefresh(adapterId, this.modelRetryTtlMs)
        throw error
      }
    })().finally(() => {
      if (this.modelRefreshes.get(adapterId) === refresh) this.modelRefreshes.delete(adapterId)
    })
    this.modelRefreshes.set(adapterId, refresh)
    return refresh
  }

  private scheduleDetectionRefresh(adapterId: CodingNsCliAdapterId, delayMs: number): void {
    if (this.disposed) return
    this.clearTimer(this.detectionTimers, adapterId)
    const timer = setTimeout(() => {
      this.detectionTimers.delete(adapterId)
      const driver = this.drivers.get(adapterId)
      if (driver !== undefined && !this.disposed) void this.refreshDetection(driver)
    }, delayMs)
    unrefTimer(timer)
    this.detectionTimers.set(adapterId, timer)
  }

  private scheduleModelRefresh(adapterId: CodingNsCliAdapterId, delayMs: number): void {
    if (this.disposed || !this.isEnabled(adapterId) || !this.requestedModelCatalogs.has(adapterId)) return
    this.clearTimer(this.modelTimers, adapterId)
    const timer = setTimeout(() => {
      this.modelTimers.delete(adapterId)
      const driver = this.drivers.get(adapterId)
      if (driver !== undefined && this.isEnabled(adapterId) && !this.disposed) void this.refreshModels(driver).catch(() => undefined)
    }, delayMs)
    unrefTimer(timer)
    this.modelTimers.set(adapterId, timer)
  }

  private invalidateModelCache(adapterId: CodingNsCliAdapterId): void {
    this.clearTimer(this.modelTimers, adapterId)
    this.modelGenerations.set(adapterId, (this.modelGenerations.get(adapterId) ?? 0) + 1)
    this.modelRefreshes.delete(adapterId)
    this.modelCache.delete(adapterId)
    this.modelFailures.delete(adapterId)
  }

  private clearTimer(
    timers: Map<CodingNsCliAdapterId, ReturnType<typeof setTimeout>>,
    adapterId: CodingNsCliAdapterId,
  ): void {
    const timer = timers.get(adapterId)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(adapterId)
  }

  private clearAllTimers(timers: Map<CodingNsCliAdapterId, ReturnType<typeof setTimeout>>): void {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  private async refreshProviderState(record: CodingNsCliSessionRecord, force: boolean): Promise<void> {
    if (record.status === 'archived') return
    if (!force && record.status === 'active') return
    if (!force && isFreshProviderState(record.providerCheckedAt, this.providerProbeTtlMs)) return
    if (record.providerSessionId === undefined && record.rawStoreRef === undefined) return
    const driver = this.drivers.get(record.adapterId)
    if (driver?.probeSession === undefined) return

    const probeKey = providerProbeKey(record)
    const running = this.probes.get(probeKey)
    if (running !== undefined) return running
    const probe = this.runProviderProbe(record, driver).finally(() => {
      if (this.probes.get(probeKey) === probe) this.probes.delete(probeKey)
    })
    this.probes.set(probeKey, probe)
    return probe
  }

  private async runProviderProbe(record: CodingNsCliSessionRecord, driver: CodingNsCliDriver): Promise<void> {
    const input: CodingNsCliSessionProbeInput = {
      ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
      ...(record.rawStoreRef ? { rawStoreRef: record.rawStoreRef } : {}),
      ...(record.cwd ? { cwd: record.cwd } : {}),
    }
    let result
    try {
      result = await this.probeWithTimeout(driver, input)
      if (result.state === 'missing') {
        await delay(this.missingConfirmationDelayMs)
        result = await this.probeWithTimeout(driver, input)
      }
    } catch (error) {
      result = {
        state: 'unknown' as const,
        reason: `会话探测失败: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    // 探测期间绑定可能已经切换；旧结果不得覆盖新 Provider 会话。
    const current = this.sessionStore?.get(record.dshSessionId)
    if (current === undefined || current.adapterId !== record.adapterId) return
    if (current.providerSessionId !== record.providerSessionId || current.rawStoreRef !== record.rawStoreRef) return
    this.sessionStore?.updateProviderState(record.dshSessionId, {
      state: result.state,
      checkedAt: new Date().toISOString(),
      reason: result.reason,
      ...(result.rawStoreRef ? { rawStoreRef: result.rawStoreRef } : {}),
    })
  }

  private async probeWithTimeout(
    driver: CodingNsCliDriver,
    input: CodingNsCliSessionProbeInput,
  ): Promise<CodingNsCliSessionProbeResult> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<CodingNsCliSessionProbeResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ state: 'unreachable', reason: `Provider 会话探测超过 ${this.providerProbeTimeoutMs}ms` })
      }, this.providerProbeTimeoutMs)
    })
    try {
      return await Promise.race([
        driver.probeSession!({ ...input, signal: controller.signal }),
        timeout,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private requireDriver(adapterId: CodingNsCliAdapterId): CodingNsCliDriver {
    const driver = this.drivers.get(adapterId)
    if (driver === undefined) throw new CodingNsRpcError('CODINGNS_CLI_UNAVAILABLE', `Agent 不可用: ${adapterId}`)
    return driver
  }

  private requireEnabledDriver(adapterId: CodingNsCliAdapterId): CodingNsCliDriver {
    const driver = this.requireDriver(adapterId)
    if (!this.isEnabled(adapterId)) throw new CodingNsRpcError('CODINGNS_CLI_DISABLED', `Agent 已停用: ${adapterId}`)
    return driver
  }

  private requireSession(sessionId: string): CodingNsCliSessionConfig {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.adapterId === 'dsh') throw new CodingNsRpcError('CODINGNS_CLI_INVALID_SESSION', '会话未绑定外部 Agent')
    return session
  }
}

function isFreshProviderState(checkedAt: string | undefined, ttlMs: number): boolean {
  if (checkedAt === undefined || ttlMs <= 0) return false
  const timestamp = Date.parse(checkedAt)
  return Number.isFinite(timestamp) && Date.now() - timestamp < ttlMs
}

function providerProbeKey(record: CodingNsCliSessionRecord): string {
  return JSON.stringify([
    record.dshSessionId,
    record.adapterId,
    record.providerSessionId ?? null,
    record.rawStoreRef ?? null,
  ])
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(concurrency, values.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      await task(values[index]!)
    }
  })
  await Promise.all(workers)
}

function positiveTtl(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback))
}

function detectionFingerprint(detection: CodingNsCliDetection): string {
  return JSON.stringify([detection.installed, detection.command, detection.version])
}

function catalogHasModels(catalog: CodingNsCliModelCatalog): boolean {
  return catalog.groups.some((group) => group.models.length > 0)
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const nodeTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
  nodeTimer.unref?.()
}
