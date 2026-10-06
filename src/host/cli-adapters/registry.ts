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
  CodingNsCliTeamDiagnostic,
  CodingNsCliSessionUsage,
  CodingNsCliSkillDescriptor,
  CodingNsCliSkillListInput,
} from '../../shared/contracts/cli-adapter.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { debugInfo } from '../../shared/debug.js'
import type {
  CodingNsCliDriver,
  CodingNsCliSessionProbeInput,
  CodingNsCliSessionProbeResult,
} from './driver.js'
import { CodingNsCliSessionStore } from './session-store.js'
import { readLegacyImportedAdapterPreferences } from './legacy-session-settings.js'
import { knownAntigravityContextWindow, knownCodexContextWindow, knownCommandCodeContextWindow } from './model-catalog.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import type { CodingNsSettings, CodingNsCliAdapterPreference } from '../../shared/contracts/config.js'
import type { DshHostSettingsScope } from '../../dsh-capabilities/host/config-forms-adapter.js'
import type {
  CommandCodeHistoryDelta,
  CommandCodeHistoryDirection,
  CommandCodeHistoryPage,
  CommandCodeSessionDiscovery,
  CommandCodeSessionSummary,
  CommandCodeContextUsage,
  CommandCodeForkResult,
  CommandCodeSessionStats,
  CommandCodeResumeSessionResult,
  CommandCodeSendMessageResult,
  CommandCodeStartSessionResult,
} from './command-code-history.js'

interface CommandCodeHistoryDriver {
  detectSessions(workspacePath: string): Promise<readonly CommandCodeSessionSummary[]>
  detectSessionsDetailed(workspacePath: string): Promise<CommandCodeSessionDiscovery>
  readSessionHistory(providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, direction?: CommandCodeHistoryDirection): Promise<CommandCodeHistoryPage>
  readSessionHistoryDelta(providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, direction?: CommandCodeHistoryDirection): Promise<CommandCodeHistoryDelta>
  readSessionTitle(providerSessionId: string, rawStoreRef: string): Promise<string>
  renameSessionTitle(providerSessionId: string, rawStoreRef: string, title: string): Promise<string>
  updateSessionArchiveState(providerSessionId: string, rawStoreRef: string, isArchived: boolean): Promise<{ readonly rawStoreRef: string; readonly isArchived: boolean }>
  deleteSession(providerSessionId: string, rawStoreRef: string): Promise<void>
  readContextUsage(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeContextUsage | null>
  readSessionStats(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeSessionStats | null>
  forkSession(providerSessionId: string, workspacePath: string, options: { readonly rawStoreRef: string; readonly sourceType: 'session' | 'message'; readonly sourceMessageId?: string | null }): Promise<CommandCodeForkResult>
  startSession(workspacePath: string, options?: { readonly initialPrompt?: string }): Promise<CommandCodeStartSessionResult>
  resumeSession(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeResumeSessionResult>
  sendMessage(providerSessionId: string, rawStoreRef: string, content: string): Promise<CommandCodeSendMessageResult>
}

type CodingNsCliDetection = Pick<CodingNsCliAdapterDescriptor, 'installed' | 'version' | 'command'> & {
  readonly diagnostic?: string
}

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
  private readonly lastUsages = new Map<string, CodingNsCliSessionUsage>()
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
  /**
   * 上次构建目录时驱动声明的 Provider 配置指纹。
   *
   * 与安装探测指纹不同：用户在外部工具里切换供应商或登录状态时，CLI 可执行文件
   * 完全没变，`detectionFingerprint` 因此不变，长 TTL 的目录缓存会把旧的账号判定
   * 一直沿用下去——界面就会长期缺少依赖该判定的控件（Codex 官方订阅的 Fast 档位
   * 开关正是如此）。这里按驱动声明的指纹在每次读取目录时校验，配置一变立即失效。
   */
  private readonly catalogFingerprints = new Map<CodingNsCliAdapterId, string>()
  /**
   * 已切到下一个 DSH step、但仍在继续产出 Provider 流的运行。
   *
   * 通用切分由 Registry 持有活迭代器；驱动自行分段的适配器（Codex、Command Code）
   * 把进程和段状态留在驱动内，这里只登记续段意图，用 null 迭代器区分两者。
   */
  private readonly segmentedTurns = new Map<string, {
    readonly adapterId: CodingNsCliAdapterId
    readonly iterator: AsyncIterator<CodingNsAgentEvent> | null
  }>()
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
      /** 适配器级最近模型选择的持久化设置。 */
      readonly settings?: DshHostSettingsScope<CodingNsSettings>
    } = {},
  ) {
    this.sessionStore = options.sessionStore
    this.nativeSessions = options.nativeSessions
    this.settings = options.settings
    this.providerProbeTtlMs = options.providerProbeTtlMs ?? 60_000
    this.missingConfirmationDelayMs = options.missingConfirmationDelayMs ?? 2_000
    this.providerProbeTimeoutMs = Math.max(1, options.providerProbeTimeoutMs ?? 10_000)
    this.providerProbeConcurrency = Math.max(1, Math.floor(options.providerProbeConcurrency ?? 4))
    this.installedCacheTtlMs = positiveTtl(options.installedCacheTtlMs, DEFAULT_INSTALLED_CACHE_TTL_MS)
    this.uninstalledCacheTtlMs = positiveTtl(options.uninstalledCacheTtlMs, DEFAULT_UNINSTALLED_CACHE_TTL_MS)
    this.modelCacheTtlMs = positiveTtl(options.modelCacheTtlMs, DEFAULT_MODEL_CACHE_TTL_MS)
    this.modelRetryTtlMs = positiveTtl(options.modelRetryTtlMs, DEFAULT_MODEL_RETRY_TTL_MS)
    const configuredPreferences = options.settings?.get().agentAdapterPreferences
    const legacyPreferences = options.settings === undefined ? {} : readLegacyImportedAdapterPreferences()
    const mergedPreferences = mergePreferenceRecords(legacyPreferences, configuredPreferences)
    this.syncPreferences(mergedPreferences)
    // DSH 0.1.7 不会把旧 `codingns` 设置段自动映射到 scoped Config entry。
    // 先用旧值恢复当前进程，再把缺失值写入新配置，后续重启即可走正常路径。
    if (options.settings !== undefined && hasMissingPreferences(configuredPreferences, legacyPreferences)) {
      this.persistPreferences()
    }
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
  private readonly settings: DshHostSettingsScope<CodingNsSettings> | undefined
  private readonly preferences = new Map<CodingNsCliAdapterId, { modelId?: string; effortId?: string; serviceTierId?: string }>()
  /** 设置服务更新必须按选择顺序落盘；并发 update 会让旧快照覆盖新模型/档位。 */
  private preferenceWriteTail: Promise<void> = Promise.resolve()

  /**
   * Host 启动后预热安装状态，并按驱动声明后台预热模型目录。
   *
   * 模型探测可能启动完整外部服务，必须留在后台；只有调用方显式请求
   * `models()` 时才等待结果。未声明预热的驱动保持原有按需加载，避免启动时
   * 同时拉起所有外部 CLI。
   */
  warmCatalog(): void {
    for (const driver of this.drivers.values()) {
      const adapterId = driver.descriptor.id
      this.scheduleDetectionRefresh(adapterId, 0)
      if (driver.warmModelCatalog !== true || !this.isEnabled(adapterId)) continue
      this.requestedModelCatalogs.add(adapterId)
      // 定时器把第一次 detect 也移出当前调用栈；某些 CLI 的版本探测仍是同步
      // 子进程调用，不能让 warmCatalog() 本身承担这段启动时间。
      const timer = setTimeout(() => {
        if (!this.disposed) void this.warmModelCatalog(driver).catch(() => undefined)
      }, 0)
      unrefTimer(timer)
    }
  }

  /** 等安装探测完成后再刷新模型，避免为同一个 CLI 启动两次检测进程。 */
  private async warmModelCatalog(driver: CodingNsCliDriver): Promise<void> {
    if (this.disposed) return
    const detection = await this.readDetection(driver)
    if (this.disposed || !this.isEnabled(driver.descriptor.id) || !detection.installed) return
    await this.refreshModels(driver)
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
    // Provider 配置（供应商、登录方式、默认档位）变化时必须先作废目录，否则
    // 账号级判定会跟着 10 分钟 TTL 一起被沿用，界面上的档位开关等控件长期缺失。
    if (this.invalidateOnCatalogFingerprintChange(adapterId, driver)) {
      return this.refreshModels(driver)
    }
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

  /** 读取当前外部会话绑定 Agent 的 Skill 目录；不把路径或文件内容暴露给 Client。 */
  async listSkills(sessionId: string, options: Omit<CodingNsCliSkillListInput, 'sessionId'> = {}): Promise<readonly CodingNsCliSkillDescriptor[]> {
    const session = this.getSession(sessionId)
    // DSH 原生 Skill 由 DSH 自己的 `skills/list` Remote 提供；外部目录 RPC
    // 对它以及旧 Client 误请求的适配器统一视为空目录，避免能力探测刷错误日志。
    if (session.adapterId === 'dsh') return []
    const driver = this.requireEnabledDriver(session.adapterId)
    if (!driver.descriptor.capabilities?.includes('skills') || typeof driver.listSkills !== 'function') return []
    const storedCwd = this.sessionStore?.get(sessionId)?.cwd
    const cwd = options.cwd ?? storedCwd
    return driver.listSkills({
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      ...(options.forceReload === true ? { forceReload: true } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
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

  /** 返回当前启用的外部 Provider 路由，供 DSH 虚拟 Provider 注册使用。 */
  enabledAdapterIds(): readonly CodingNsCliAdapterId[] {
    return [...this.drivers.keys()].filter((adapterId) => this.isEnabled(adapterId))
  }

  enabledSnapshot(): Record<string, boolean> {
    return Object.fromEntries(this.enabled.entries())
  }

  /**
   * DSH 0.2 的 Team 必须由原生 TeamService 创建 continuable child、mailbox
   * 和 task board。当前外部 CLI 仍是独立进程，不能伪装成原生成员；统一返回
   * 可诊断结果，避免 Client 把普通 CLI 会话误显示成 Team 成员。
   */
  teamDiagnostic(): CodingNsCliTeamDiagnostic {
    return {
      supported: false,
      code: 'DSH_TEAM_NATIVE_UNAVAILABLE',
      message: '当前插件仅提供外部 CLI 会话适配器，尚未接入 DSH 0.2 原生 Agent Team 生命周期。',
    }
  }

  setSession(sessionId: string, config: CodingNsCliSessionConfig): CodingNsCliSessionConfig {
    if (sessionId.trim() === '') throw new CodingNsRpcError('CODINGNS_CLI_INVALID_SESSION', 'sessionId 不能为空')
    // dsh 是 DSH 自带的默认 Agent，不对应一个外部驱动，但仍需要作为会话
    // 配置保存值，方便 Client 从外部 CLI 切回默认 Agent。
    if (config.adapterId !== 'dsh') this.requireEnabledDriver(config.adapterId)
    const previous = this.sessions.get(sessionId)
    const sameAdapter = previous?.adapterId === config.adapterId
    if (previous !== undefined && !sameAdapter) this.lastUsages.delete(sessionId)
    const remembered = this.preferences.get(config.adapterId) ?? this.findRememberedPreference(config.adapterId)
    const providerSessionId = config.providerSessionId?.trim()
    const providerIdentityChanged = providerSessionId !== undefined
      && providerSessionId !== previous?.providerSessionId
    const normalized = {
      adapterId: config.adapterId,
      ...(config.modelId?.trim()
        ? { modelId: config.modelId.trim() }
        : sameAdapter && previous?.modelId
          ? { modelId: previous.modelId }
          : remembered?.modelId
            ? { modelId: remembered.modelId }
            : {}),
      ...(config.effortId?.trim()
        ? { effortId: config.effortId.trim() }
        : sameAdapter && previous?.effortId
          ? { effortId: previous.effortId }
          : remembered?.effortId
            ? { effortId: remembered.effortId }
            : {}),
      // 服务档位是“显式选择”而不是“可回退的最近值”：`default` 表示标准速度，
      // 与 undefined（Host 没有该选择）语义不同，必须原样保留，不能被记忆值覆盖。
      ...(config.serviceTierId?.trim()
        ? { serviceTierId: config.serviceTierId.trim() }
        : sameAdapter && previous?.serviceTierId
          ? { serviceTierId: previous.serviceTierId }
          : remembered?.serviceTierId
            ? { serviceTierId: remembered.serviceTierId }
            : {}),
      ...(config.providerId?.trim()
        ? { providerId: config.providerId.trim() }
        : sameAdapter && previous?.providerId
          ? { providerId: previous.providerId }
          : {}),
      ...(providerSessionId ? { providerSessionId } : sameAdapter && previous?.providerSessionId ? { providerSessionId: previous.providerSessionId } : {}),
      ...(config.rawStoreRef?.trim()
        ? { rawStoreRef: config.rawStoreRef.trim() }
        : sameAdapter && !providerIdentityChanged && previous?.rawStoreRef
          ? { rawStoreRef: previous.rawStoreRef }
          : {}),
      ...(config.parentSessionId?.trim()
        ? { parentSessionId: config.parentSessionId.trim() }
        : sameAdapter && previous?.parentSessionId ? { parentSessionId: previous.parentSessionId } : {}),
      ...(config.origin === 'user' || config.origin === 'subagent' || config.origin === 'plugin'
        ? { origin: config.origin }
        : sameAdapter && previous?.origin ? { origin: previous.origin } : {}),
      ...(config.delegationDepth !== undefined && Number.isSafeInteger(config.delegationDepth) && config.delegationDepth >= 0
        ? { delegationDepth: config.delegationDepth }
        : sameAdapter && previous?.delegationDepth !== undefined ? { delegationDepth: previous.delegationDepth } : {}),
      ...(config.continuationId?.trim()
        ? { continuationId: config.continuationId.trim() }
        : sameAdapter && previous?.continuationId ? { continuationId: previous.continuationId } : {}),
      ...(config.teamId?.trim()
        ? { teamId: config.teamId.trim() }
        : sameAdapter && previous?.teamId ? { teamId: previous.teamId } : {}),
      ...(config.teamMemberId?.trim()
        ? { teamMemberId: config.teamMemberId.trim() }
        : sameAdapter && previous?.teamMemberId ? { teamMemberId: previous.teamMemberId } : {}),
    }
    this.sessions.set(sessionId, normalized)
    this.sessionStore?.upsert(sessionId, normalized)
    this.rememberPreference(config.adapterId, normalized)
    return normalized
  }

  /** 设置服务变更后重新载入适配器级默认选择。 */
  syncPreferences(value: Readonly<Record<string, CodingNsCliAdapterPreference>> | undefined): void {
    if (value === undefined) return
    // 0.1.7 ConfigForms 在 entry 重新描述的瞬间可能只返回默认空字典；
    // 不能让这次短暂快照抹掉当前进程已经恢复的选择。
    if (Object.keys(value).length === 0 && this.preferences.size > 0) return
    this.preferences.clear()
    for (const [rawAdapterId, preference] of Object.entries(value)) {
      const adapterId = rawAdapterId === 'codebuddy-cn' ? 'codebuddy' : rawAdapterId
      const modelId = preference?.modelId?.trim()
      const effortId = preference?.effortId?.trim()
      const serviceTierId = preference?.serviceTierId?.trim()
      if (modelId === undefined && effortId === undefined && serviceTierId === undefined) continue
      this.preferences.set(adapterId, {
        ...(modelId ? { modelId } : {}),
        ...(effortId ? { effortId } : {}),
        ...(serviceTierId ? { serviceTierId } : {}),
      })
    }
  }

  private findRememberedPreference(adapterId: CodingNsCliAdapterId): { modelId?: string; effortId?: string; serviceTierId?: string } | undefined {
    const records = this.sessionStore?.list({ includeArchived: true, adapterId }) ?? []
    for (const record of records) {
      if (record.modelId !== undefined || record.effortId !== undefined || record.serviceTierId !== undefined) {
        const preference = {
          ...(record.modelId ? { modelId: record.modelId } : {}),
          ...(record.effortId ? { effortId: record.effortId } : {}),
          ...(record.serviceTierId ? { serviceTierId: record.serviceTierId } : {}),
        }
        this.preferences.set(adapterId, preference)
        return preference
      }
    }
    return undefined
  }

  private rememberPreference(adapterId: CodingNsCliAdapterId, config: CodingNsCliSessionConfig): void {
    const previous = this.preferences.get(adapterId)
    const modelId = config.modelId?.trim() || previous?.modelId
    const effortId = config.effortId?.trim() || previous?.effortId
    const serviceTierId = config.serviceTierId?.trim() || previous?.serviceTierId
    if (modelId === undefined && effortId === undefined && serviceTierId === undefined) return
    if (previous?.modelId === modelId && previous?.effortId === effortId && previous?.serviceTierId === serviceTierId) return
    const preference = {
      ...(modelId ? { modelId } : {}),
      ...(effortId ? { effortId } : {}),
      ...(serviceTierId ? { serviceTierId } : {}),
    }
    this.preferences.set(adapterId, preference)
    this.persistPreferences()
  }

  private persistPreferences(): void {
    if (this.settings === undefined) return
    const snapshot = preferenceSnapshot(this.preferences)
    this.preferenceWriteTail = this.preferenceWriteTail
      .catch(() => undefined)
      .then(() => this.settings!.update({ agentAdapterPreferences: snapshot }))
      .catch(() => undefined)
  }

  /**
   * 会话索引。迁移 fork 子会话的继承绑定需要在 Registry 外部补写记录，
   * 因此这里暴露只读引用，避免调用方自己再建一份索引。
   */
  get sessionRecords(): CodingNsCliSessionStore | undefined {
    return this.sessionStore
  }

  getSession(sessionId: string): CodingNsCliSessionConfig {
    const session = this.sessions.get(sessionId)
    if (session !== undefined && (session.adapterId === 'dsh' || this.isEnabled(session.adapterId))) {
      if (session.adapterId === 'dsh') return mergeDshNativeSelection(session, this.nativeSessions?.get(sessionId))
      // Provider 绑定可能在 llm/stream 的 session-binding 事件中先写入持久化索引，
      // 而旧的内存配置仍被页面复用；补齐缺失字段，避免续接时重新开空会话。
      return { ...mergeStoredSessionFields(session, this.sessionStore?.get(sessionId)), ...lastUsageField(this.lastUsages.get(sessionId)) }
    }
    // 迁移可能在 Registry 构造之后才完成（用户点击打开旧会话、或 fork 子会话
    // 刚被加载）。此时必须读取 SessionStore，否则子会话会被当成 DSH 主会话，
    // 用户看到的仍是“默认 DSH Agent”。
    const stored = this.sessionStore?.get(sessionId)
    if (stored !== undefined && stored.adapterId !== 'dsh' && this.isEnabled(stored.adapterId)) {
      const config: CodingNsCliSessionConfig = {
        adapterId: stored.adapterId,
        ...(stored.modelId === undefined ? {} : { modelId: stored.modelId }),
        ...(stored.effortId === undefined ? {} : { effortId: stored.effortId }),
        ...(stored.serviceTierId === undefined ? {} : { serviceTierId: stored.serviceTierId }),
        ...(stored.providerId === undefined ? {} : { providerId: stored.providerId }),
        ...(stored.providerSessionId === undefined ? {} : { providerSessionId: stored.providerSessionId }),
        ...(stored.rawStoreRef === undefined ? {} : { rawStoreRef: stored.rawStoreRef }),
        ...(stored.parentSessionId === undefined ? {} : { parentSessionId: stored.parentSessionId }),
      }
      this.sessions.set(sessionId, config)
      return { ...config, ...lastUsageField(this.lastUsages.get(sessionId)) }
    }
    const remembered = this.preferences.get('dsh') ?? this.findRememberedPreference('dsh')
    return mergeDshNativeSelection({
      adapterId: 'dsh',
      ...(remembered?.modelId ? { modelId: remembered.modelId } : {}),
      ...(remembered?.effortId ? { effortId: remembered.effortId } : {}),
      ...(remembered?.serviceTierId ? { serviceTierId: remembered.serviceTierId } : {}),
    }, this.nativeSessions?.get(sessionId))
  }

  /** 只有已验证能维护连续事件流的驱动，Host 才把工具边界映射到 DSH step。 */
  supportsSegmentedTurns(adapterId: CodingNsCliAdapterId): boolean {
    return this.drivers.get(adapterId)?.supportsSegmentedTurns === true
  }

  /** Qoder 等 ACP 驱动由 Registry 挂起同一个迭代器完成通用工具分步。 */
  supportsToolStepSplitting(adapterId: CodingNsCliAdapterId): boolean {
    return this.drivers.get(adapterId)?.supportsToolStepSplitting === true
  }

  /** 供原生 Subagent Provider 执行首轮；不创建普通外部会话索引。 */
  async *runSubagentTurn(input: CodingNsCliTurnInput & { readonly adapterId: CodingNsCliAdapterId }): AsyncIterable<CodingNsAgentEvent> {
    const driver = this.requireEnabledDriver(input.adapterId)
    yield* driver.executeTurn(input)
  }

  /** 子会话 Provider 绑定完成后立即落盘，确保冷恢复不会丢失适配器身份。 */
  async flushSessionBindings(): Promise<void> {
    await this.sessionStore?.flush()
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
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.adapterId !== input.adapterId) this.lastUsages.delete(input.sessionId)
    let current = {
      ...(previous ?? { adapterId: input.adapterId }),
      ...(input.modelId?.trim() ? { modelId: input.modelId.trim() } : {}),
      ...(input.effortId?.trim() ? { effortId: input.effortId.trim() } : {}),
      ...(input.serviceTierId?.trim() ? { serviceTierId: input.serviceTierId.trim() } : {}),
      // 续接请求自身带有 Provider 身份时必须写回当前内存配置；否则首轮
      // 恰好发生在页面恢复/迁移窗口内，会在下一轮丢失 --resume 所需的 ID。
      ...(input.providerSessionId?.trim() ? { providerSessionId: input.providerSessionId.trim() } : {}),
      ...(input.rawStoreRef?.trim() ? { rawStoreRef: input.rawStoreRef.trim() } : {}),
    }
    // 除了 Client 的 session/set，Host 内部和未来的调用方也可能直接执行一轮。
    // 最近使用应由真实执行参数更新，不能依赖某个 UI 一定先发 RPC。
    this.rememberPreference(input.adapterId, input)
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
      const suspended = this.segmentedTurns.get(input.sessionId)
      const resumingSegmentedTurn = suspended?.adapterId === input.adapterId
      // 驱动自行分段时，续段必须由 Host 显式声明；驱动不能靠猜输入形状决定是否
      // 复用旧进程，否则注入失败后的新用户消息会被拼进上一次运行。
      const resumingDriverTurn = resumingSegmentedTurn && suspended !== undefined && suspended.iterator === null
      if (resumingDriverTurn) this.segmentedTurns.delete(input.sessionId)
      this.sessions.set(input.sessionId, current)
      this.sessionStore?.upsert(input.sessionId, {
        ...current,
        adapterId: input.adapterId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        status: 'active',
        ...(resumingSegmentedTurn ? {} : { title: input.prompt }),
      })
      // Agent Loop 通常已经创建了同名 DSH 原生会话；直接调用 Registry 时才按需补建。
      // 原生服务失败不能阻断外部 Agent，消息仍由现有 llm/stream 链路处理。
      try { await this.nativeSessions?.ensure(input.sessionId, input.cwd) } catch { /* 可选服务降级 */ }
      // 每轮都写入稳定的适配器身份。旧日志只有通用 codingns-external 标记，
      // 这条 request/context 是升级后自动迁移时唯一可靠的回填依据。
      try {
        const contextWindow = input.adapterId === 'codex'
          ? knownCodexContextWindow(input.modelId)
          : input.adapterId === 'command-code'
            ? knownCommandCodeContextWindow(input.modelId)
            : input.adapterId === 'antigravity'
              ? knownAntigravityContextWindow(input.modelId)
              : undefined
        this.nativeSessions?.appendRequestContext?.(input.sessionId, {
          provider: input.adapterId,
          model: input.modelId ?? input.adapterId,
          ...(contextWindow === undefined ? {} : { contextWindow, confirmed: true, source: 'catalog' as const }),
        })
      } catch { /* 原生历史写入失败不应阻断外部 Agent */ }
      if (suspended !== undefined && suspended.adapterId !== input.adapterId) {
        this.segmentedTurns.delete(input.sessionId)
        if (suspended.iterator !== null) await closeAgentIterator(suspended.iterator)
        try { this.drivers.get(suspended.adapterId)?.discardSegmentedTurn?.(input.sessionId) } catch { /* 切换适配器不能被旧驱动清理失败阻断 */ }
      }
      // 通用切分要在复用时立刻撤销登记，否则耗尽后的旧迭代器会被下一条用户消息再次消费。
      let iterator: AsyncIterator<CodingNsAgentEvent>
      if (resumingSegmentedTurn && suspended !== undefined && suspended.iterator !== null) {
        this.segmentedTurns.delete(input.sessionId)
        iterator = suspended.iterator
      } else {
        iterator = driver.executeTurn({ ...input, ...(resumingDriverTurn ? { resumeSegmentedTurn: true } : {}) })[Symbol.asyncIterator]()
      }
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        const event = next.value
        if (event.type === 'usage') this.lastUsages.set(input.sessionId, usageSnapshot(event))
        if (event.type === 'session-binding') {
          const providerIdentityChanged = event.providerSessionId !== current.providerSessionId
          const { rawStoreRef: previousRawStoreRef, ...currentWithoutRawStoreRef } = current
          const nextConfig = {
            ...currentWithoutRawStoreRef,
            providerSessionId: event.providerSessionId,
            ...(event.rawStoreRef
              ? { rawStoreRef: event.rawStoreRef }
              : !providerIdentityChanged && previousRawStoreRef
                ? { rawStoreRef: previousRawStoreRef }
                : {}),
          }
          this.sessions.set(input.sessionId, nextConfig)
          current = nextConfig
          this.sessionStore?.upsert(input.sessionId, {
            ...nextConfig,
            status: 'active',
            providerState: 'available',
            providerCheckedAt: new Date().toISOString(),
          })
        }
        if (event.type === 'finish') {
          this.segmentedTurns.delete(input.sessionId)
          this.sessionStore?.upsert(input.sessionId, { ...this.sessions.get(input.sessionId) ?? current, status: event.reason === 'error' ? 'error' : 'idle' })
        }
        // Codex 等驱动已经把同一个 Provider turn 切成了多个段。边界本身
        // 直接交给 Feature，不能再次按工具完成事件切一遍。
        if (event.type === 'step-boundary') {
          await closeAgentIterator(iterator)
          // 驱动自己持有 Provider 进程与段状态：这里只登记续段意图，下一次
          // llm/stream 再显式要求驱动恢复；注入失败时 discardSegmentedTurn
          // 会同时丢弃 Registry 意图和驱动内的进程。
          this.segmentedTurns.set(input.sessionId, { adapterId: input.adapterId, iterator: null })
          yield event
          return
        }
        if (input.splitToolSteps
          && driver.supportsSegmentedTurns !== true
          && event.type === 'tool-event'
          && (event.status === 'completed' || event.status === 'failed')) {
          // 先保存迭代器再 yield。即使调用方在工具事件后提前关闭流，
          // 下一次 DSH step 仍能从同一个 Provider 进程继续读取正文。
          this.segmentedTurns.set(input.sessionId, { adapterId: input.adapterId, iterator })
          yield event
          yield { type: 'step-boundary' }
          return
        }
        yield event
      }
      this.segmentedTurns.delete(input.sessionId)
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

  /** 读取 Provider 原生会话；当前只对实现了 Command Code History 的驱动开放。 */
  async listProviderSessions(adapterId: string, workspacePath: string): Promise<readonly CommandCodeSessionSummary[]> {
    return this.requireHistoryDriver(adapterId).detectSessions(workspacePath)
  }

  async listProviderSessionsDetailed(adapterId: string, workspacePath: string): Promise<CommandCodeSessionDiscovery> {
    return this.requireHistoryDriver(adapterId).detectSessionsDetailed(workspacePath)
  }

  async readProviderHistory(adapterId: string, providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, direction: CommandCodeHistoryDirection = 'forward'): Promise<CommandCodeHistoryPage> {
    return this.requireHistoryDriver(adapterId).readSessionHistory(providerSessionId, rawStoreRef, cursor, limit, direction)
  }

  async readProviderHistoryDelta(adapterId: string, providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, direction: CommandCodeHistoryDirection = 'forward'): Promise<CommandCodeHistoryDelta> {
    return this.requireHistoryDriver(adapterId).readSessionHistoryDelta(providerSessionId, rawStoreRef, cursor, limit, direction)
  }

  async readProviderSessionTitle(adapterId: string, providerSessionId: string, rawStoreRef: string): Promise<string> {
    return this.requireHistoryDriver(adapterId).readSessionTitle(providerSessionId, rawStoreRef)
  }

  async renameProviderSessionTitle(adapterId: string, providerSessionId: string, rawStoreRef: string, title: string): Promise<string> {
    return this.requireHistoryDriver(adapterId).renameSessionTitle(providerSessionId, rawStoreRef, title)
  }

  async updateProviderSessionArchive(adapterId: string, providerSessionId: string, rawStoreRef: string, isArchived: boolean): Promise<{ readonly rawStoreRef: string; readonly isArchived: boolean }> {
    return this.requireHistoryDriver(adapterId).updateSessionArchiveState(providerSessionId, rawStoreRef, isArchived)
  }

  async deleteProviderSession(adapterId: string, providerSessionId: string, rawStoreRef: string): Promise<void> {
    return this.requireHistoryDriver(adapterId).deleteSession(providerSessionId, rawStoreRef)
  }

  async readProviderContextUsage(adapterId: string, providerSessionId: string, rawStoreRef: string): Promise<CommandCodeContextUsage | null> {
    return this.requireHistoryDriver(adapterId).readContextUsage(providerSessionId, rawStoreRef)
  }

  async readProviderSessionStats(adapterId: string, providerSessionId: string, rawStoreRef: string): Promise<CommandCodeSessionStats | null> {
    return this.requireHistoryDriver(adapterId).readSessionStats(providerSessionId, rawStoreRef)
  }

  async forkProviderSession(adapterId: string, providerSessionId: string, workspacePath: string, options: { readonly rawStoreRef: string; readonly sourceType: 'session' | 'message'; readonly sourceMessageId?: string | null }): Promise<CommandCodeForkResult> {
    return this.requireHistoryDriver(adapterId).forkSession(providerSessionId, workspacePath, options)
  }

  async startProviderSession(adapterId: string, workspacePath: string, options: { readonly initialPrompt?: string } = {}): Promise<CommandCodeStartSessionResult> {
    return this.requireHistoryDriver(adapterId).startSession(workspacePath, options)
  }

  async resumeProviderSession(adapterId: string, providerSessionId: string, rawStoreRef: string): Promise<CommandCodeResumeSessionResult> {
    return this.requireHistoryDriver(adapterId).resumeSession(providerSessionId, rawStoreRef)
  }

  async sendProviderMessage(adapterId: string, providerSessionId: string, rawStoreRef: string, content: string): Promise<CommandCodeSendMessageResult> {
    return this.requireHistoryDriver(adapterId).sendMessage(providerSessionId, rawStoreRef, content)
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
    let providerArchived = false
    try {
      const historyDriver = this.drivers.get(current.adapterId) as (CodingNsCliDriver & Partial<CommandCodeHistoryDriver>) | undefined
      if (current.providerSessionId !== undefined && current.rawStoreRef !== undefined && typeof historyDriver?.updateSessionArchiveState === 'function') {
        await historyDriver.updateSessionArchiveState(current.providerSessionId, current.rawStoreRef, true)
        providerArchived = true
      }
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
    } catch (error) {
      // Provider 元数据先写是为了避免 DSH 已归档而 Provider 仍显示活动；原生归档
      // 失败时尽力回滚文件标记，不能让两套索引长期分叉。
      if (providerArchived && current.providerSessionId !== undefined && current.rawStoreRef !== undefined) {
        const historyDriver = this.drivers.get(current.adapterId) as (CodingNsCliDriver & Partial<CommandCodeHistoryDriver>) | undefined
        const rollback = historyDriver?.updateSessionArchiveState?.(current.providerSessionId, current.rawStoreRef, false)
        await rollback?.catch(() => undefined)
      }
      throw error
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

  /** 丢弃等待下一步的 Provider 流，避免取消后的旧正文进入新回合。 */
  discardSegmentedTurn(sessionId: string): void {
    const suspended = this.segmentedTurns.get(sessionId)
    if (suspended === undefined) return
    this.segmentedTurns.delete(sessionId)
    if (suspended.iterator !== null) void closeAgentIterator(suspended.iterator)
    // 驱动自行分段时进程留在驱动内，必须显式通知它结束悬挂的 Provider 运行。
    try { this.drivers.get(suspended.adapterId)?.discardSegmentedTurn?.(sessionId) } catch { /* 取消流程不能被清理失败阻断 */ }
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
    this.catalogFingerprints.clear()
    this.requestedModelCatalogs.clear()
    await Promise.all([...this.segmentedTurns.values()].map(({ iterator }) => iterator === null ? Promise.resolve() : closeAgentIterator(iterator)))
    this.segmentedTurns.clear()
    this.lastUsages.clear()
    await Promise.all([...this.drivers.values()].map((driver) => driver.dispose?.()))
    await this.preferenceWriteTail
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
        const detected = await driver.detect()
        const getDiagnostic = driver.getDiscoveryDiagnostic
        const diagnostic = getDiagnostic === undefined ? undefined : getDiagnostic.call(driver)
        detection = diagnostic === undefined ? detected : { ...detected, diagnostic }
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
        // 指纹必须在探测开始前捕获：若在 listModels() 返回后再读，探测期间发生的
        // 第二次供应商切换会被记成“已应用”，而目录其实来自切换前的配置，之后
        // 指纹比对会一直命中，旧判定又被锁进缓存。
        const probeFingerprint = readCatalogFingerprint(driver)
        const catalog = await driver.listModels()
        if (this.disposed || generation !== this.cacheGeneration) return previous?.value ?? catalog
        if (modelGeneration !== (this.modelGenerations.get(adapterId) ?? 0)) return this.refreshModels(driver)

        this.modelFailures.delete(adapterId)
        const hasModels = catalogHasModels(catalog)
        const keepPrevious = !hasModels && previous !== undefined && catalogHasModels(previous.value)
        const value = keepPrevious ? previous.value : catalog
        // 指纹与目录一起落库：只有真正代表这份目录的配置才会在下次比对时命中。
        if (probeFingerprint !== undefined) this.catalogFingerprints.set(adapterId, probeFingerprint)
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

  /**
   * 比对驱动的 Provider 配置指纹，变化时立即作废该适配器的目录缓存。
   *
   * 返回 true 表示调用方必须等待一次全新探测，不能复用任何旧值——包括
   * stale-while-revalidate 的旧值：账号判定从「第三方」变成「官方订阅」时，
   * 继续先回旧值会让界面在本次渲染里仍然缺少依赖该判定的控件。
   *
   * 驱动没有声明 `catalogFingerprint` 或当前读不到配置（返回 undefined）时保持
   * 原行为，不把「无法判断」当成「已变化」，避免目录退化成每次都重新探测。
   */
  private invalidateOnCatalogFingerprintChange(adapterId: CodingNsCliAdapterId, driver: CodingNsCliDriver): boolean {
    const fingerprint = readCatalogFingerprint(driver)
    if (fingerprint === undefined) return false
    // 指纹在目录构建成功时写入，因此这里的旧值一定对应缓存里的那份目录。
    const previous = this.catalogFingerprints.get(adapterId)
    if (previous === undefined || previous === fingerprint) return false
    debugInfo('codingns4dsh: cli catalog fingerprint changed', { adapterId })
    this.invalidateModelCache(adapterId)
    return true
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

  private requireHistoryDriver(adapterId: string): CommandCodeHistoryDriver {
    const driver = this.requireEnabledDriver(adapterId) as CodingNsCliDriver & Partial<CommandCodeHistoryDriver>
    if (typeof driver.detectSessions !== 'function'
      || typeof driver.detectSessionsDetailed !== 'function'
      || typeof driver.readSessionHistory !== 'function'
      || typeof driver.readSessionHistoryDelta !== 'function'
      || typeof driver.readSessionTitle !== 'function'
      || typeof driver.renameSessionTitle !== 'function'
      || typeof driver.updateSessionArchiveState !== 'function'
      || typeof driver.deleteSession !== 'function'
      || typeof driver.readContextUsage !== 'function'
      || typeof driver.readSessionStats !== 'function'
      || typeof driver.forkSession !== 'function'
      || typeof driver.startSession !== 'function'
      || typeof driver.resumeSession !== 'function'
      || typeof driver.sendMessage !== 'function') {
      throw new CodingNsRpcError('CODINGNS_CLI_UNSUPPORTED', `Agent 不支持 Provider History: ${adapterId}`)
    }
    return driver as CommandCodeHistoryDriver
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

async function closeAgentIterator(iterator: AsyncIterator<CodingNsAgentEvent>): Promise<void> {
  try { await iterator.return?.() } catch { /* 驱动清理失败不能阻断 Registry 释放 */ }
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
  return JSON.stringify([detection.installed, detection.command, detection.version, detection.diagnostic])
}

/**
 * 读取驱动的 Provider 配置指纹。
 *
 * 驱动未声明该方法、抛错或返回空白时一律视为「无法判断」，调用方不得据此失效
 * 缓存——指纹只是让配置变化立刻生效的加速手段，不能成为目录可用的前提。
 */
function readCatalogFingerprint(driver: CodingNsCliDriver): string | undefined {
  const read = driver.catalogFingerprint
  if (read === undefined) return undefined
  try {
    const value = read.call(driver)
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  } catch {
    return undefined
  }
}

function catalogHasModels(catalog: CodingNsCliModelCatalog): boolean {
  return catalog.fallback !== true && catalog.groups.some((group) => group.models.length > 0)
}

function mergePreferenceRecords(
  legacy: Readonly<Record<string, CodingNsCliAdapterPreference>>,
  configured: Readonly<Record<string, CodingNsCliAdapterPreference>> | undefined,
): Readonly<Record<string, CodingNsCliAdapterPreference>> {
  const merged: Record<string, CodingNsCliAdapterPreference> = {}
  for (const [adapterId, preference] of Object.entries(legacy)) {
    const normalized = normalizePreference(preference)
    if (normalized !== undefined) merged[adapterId] = normalized
  }
  for (const [adapterId, preference] of Object.entries(configured ?? {})) {
    const normalized = normalizePreference(preference)
    if (normalized === undefined) continue
    merged[adapterId] = { ...merged[adapterId], ...normalized }
  }
  return merged
}

function normalizePreference(value: CodingNsCliAdapterPreference | undefined): CodingNsCliAdapterPreference | undefined {
  if (value === undefined) return undefined
  const modelId = value.modelId?.trim()
  const effortId = value.effortId?.trim()
  const serviceTierId = value.serviceTierId?.trim()
  if (modelId === undefined && effortId === undefined && serviceTierId === undefined) return undefined
  return {
    ...(modelId ? { modelId } : {}),
    ...(effortId ? { effortId } : {}),
    ...(serviceTierId ? { serviceTierId } : {}),
  }
}

function hasMissingPreferences(
  configured: Readonly<Record<string, CodingNsCliAdapterPreference>> | undefined,
  legacy: Readonly<Record<string, CodingNsCliAdapterPreference>>,
): boolean {
  for (const [adapterId, legacyPreference] of Object.entries(legacy)) {
    const current = configured?.[adapterId]
    if (legacyPreference.modelId !== undefined && !hasText(current?.modelId)) return true
    if (legacyPreference.effortId !== undefined && !hasText(current?.effortId)) return true
    if (legacyPreference.serviceTierId !== undefined && !hasText(current?.serviceTierId)) return true
  }
  return false
}

function hasText(value: string | undefined): boolean {
  return value?.trim() !== '' && value !== undefined
}

function preferenceSnapshot(
  preferences: ReadonlyMap<string, CodingNsCliAdapterPreference>,
): Record<string, CodingNsCliAdapterPreference> {
  return Object.fromEntries([...preferences.entries()].map(([adapterId, preference]) => [adapterId, { ...preference }]))
}

/** 从 DSH 原生会话快照补齐当前模型提供商，供订阅分流使用。 */
function mergeDshNativeSelection(
  config: CodingNsCliSessionConfig,
  session: unknown,
): CodingNsCliSessionConfig {
  if (config.adapterId !== 'dsh' || config.providerId !== undefined && config.modelId !== undefined) return config
  const root = asRecord(session)
  const rows = asRecord(root?.record)?.rows
  const selectionRow = asRecord(asRecord(rows)?.modelSelection)
  const selection = asRecord(root?.modelSelection) ?? selectionRow
  const value = asRecord(selection?.val) ?? selection
  const lastUsed = asRecord(value?.lastUsed)
  const next = asRecord(value?.next)
  const candidate = lastUsed ?? next
  if (candidate === null) return config
  const providerId = stringValue(candidate.provider)
  const modelId = stringValue(candidate.model)
  const effortId = stringValue(candidate.reasoningEffort)
  return {
    ...config,
    ...(config.providerId === undefined && providerId !== undefined ? { providerId } : {}),
    ...(config.modelId === undefined && modelId !== undefined ? { modelId } : {}),
    ...(config.effortId === undefined && effortId !== undefined ? { effortId } : {}),
  }
}

/** 以内存配置为主、用持久化记录补齐 Provider 续接所需的身份字段。 */
function mergeStoredSessionFields(
  config: CodingNsCliSessionConfig,
  stored: CodingNsCliSessionRecord | undefined,
): CodingNsCliSessionConfig {
  if (stored === undefined || stored.adapterId !== config.adapterId) return config
  return {
    ...config,
    ...(config.providerSessionId === undefined && stored.providerSessionId !== undefined ? { providerSessionId: stored.providerSessionId } : {}),
    ...(config.rawStoreRef === undefined && stored.rawStoreRef !== undefined ? { rawStoreRef: stored.rawStoreRef } : {}),
    ...(config.modelId === undefined && stored.modelId !== undefined ? { modelId: stored.modelId } : {}),
    ...(config.effortId === undefined && stored.effortId !== undefined ? { effortId: stored.effortId } : {}),
    ...(config.serviceTierId === undefined && stored.serviceTierId !== undefined ? { serviceTierId: stored.serviceTierId } : {}),
  }
}

function usageSnapshot(event: Extract<CodingNsAgentEvent, { type: 'usage' }>): CodingNsCliSessionUsage {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
    ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
    ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
    ...(event.contextUsageRatio === undefined ? {} : { contextUsageRatio: event.contextUsageRatio }),
    ...(event.providerCredits === undefined ? {} : { providerCredits: event.providerCredits }),
    capturedAt: Date.now(),
  }
}

function lastUsageField(usage: CodingNsCliSessionUsage | undefined): { readonly lastUsage?: CodingNsCliSessionUsage } {
  return usage === undefined ? {} : { lastUsage: usage }
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const nodeTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
  nodeTimer.unref?.()
}
