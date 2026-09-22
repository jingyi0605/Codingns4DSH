import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliAdapterId,
  CodingNsCliModelCatalog,
  CodingNsCliPermissionResponse,
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
import { CodingNsCliStreamNormalizer, type CodingNsNormalizedCliStreamChunk } from './stream-normalizer.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'

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
    } = {},
  ) {
    this.sessionStore = options.sessionStore
    this.nativeSessions = options.nativeSessions
    this.providerProbeTtlMs = options.providerProbeTtlMs ?? 60_000
    this.missingConfirmationDelayMs = options.missingConfirmationDelayMs ?? 2_000
    this.providerProbeTimeoutMs = Math.max(1, options.providerProbeTimeoutMs ?? 10_000)
    this.providerProbeConcurrency = Math.max(1, Math.floor(options.providerProbeConcurrency ?? 4))
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

  async catalog(): Promise<CodingNsCliAdapterDescriptor[]> {
    return Promise.all([...this.drivers.values()].map(async (driver) => {
      try { return { ...driver.descriptor, enabled: this.isEnabled(driver.descriptor.id), ...(await driver.detect()) } }
      catch { return { ...driver.descriptor, enabled: this.isEnabled(driver.descriptor.id), installed: false, version: null, command: null } }
    }))
  }

  async models(adapterId: CodingNsCliAdapterId): Promise<CodingNsCliModelCatalog> {
    return this.requireEnabledDriver(adapterId).listModels()
  }

  setEnabled(adapterId: CodingNsCliAdapterId, enabled: boolean): boolean {
    this.requireDriver(adapterId)
    this.enabled.set(adapterId, enabled)
    return enabled
  }

  applyEnabledSettings(settings: Readonly<Record<string, boolean>> | undefined): void {
    for (const adapterId of this.enabled.keys()) this.enabled.set(adapterId, settings?.[adapterId] !== false)
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

  async *execute(input: CodingNsCliTurnInput & { readonly adapterId: CodingNsCliAdapterId }): AsyncIterable<CodingNsNormalizedCliStreamChunk> {
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
      const normalizer = new CodingNsCliStreamNormalizer()
      // Agent Loop 通常已经创建了同名 DSH 原生会话；直接调用 Registry 时才按需补建。
      // 原生服务失败不能阻断外部 Agent，消息仍由现有 llm/stream 链路处理。
      try { await this.nativeSessions?.ensure(input.sessionId, input.cwd) } catch { /* 可选服务降级 */ }
      for await (const rawChunk of driver.executeTurn(input)) {
        for (const chunk of normalizer.push(rawChunk)) {
          if (chunk.type === 'session-binding') {
            const providerIdentityChanged = chunk.providerSessionId !== current.providerSessionId
            const { rawStoreRef: previousRawStoreRef, ...currentWithoutRawStoreRef } = current
            const next = {
              ...currentWithoutRawStoreRef,
              providerSessionId: chunk.providerSessionId,
              ...(chunk.rawStoreRef
                ? { rawStoreRef: chunk.rawStoreRef }
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
          if (chunk.type === 'finish') this.sessionStore?.upsert(input.sessionId, { ...this.sessions.get(input.sessionId) ?? current, status: chunk.reason === 'error' ? 'error' : 'idle' })
          yield chunk
        }
      }
      for (const chunk of normalizer.flush()) yield chunk
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

  async respondPermission(sessionId: string, response: CodingNsCliPermissionResponse): Promise<void> {
    const session = this.requireSession(sessionId)
    const driver = this.requireEnabledDriver(session.adapterId)
    if (driver.respondPermission === undefined) throw new CodingNsRpcError('CODINGNS_CLI_UNSUPPORTED', '当前 Agent 不支持权限回传')
    await driver.respondPermission(sessionId, response)
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

  async dispose(): Promise<void> { await Promise.all([...this.drivers.values()].map((driver) => driver.dispose?.())) }

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
