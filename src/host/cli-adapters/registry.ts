import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliAdapterId,
  CodingNsCliModelCatalog,
  CodingNsCliPermissionResponse,
  CodingNsCliSessionConfig,
  CodingNsCliSessionRecord,
  CodingNsCliStreamChunk,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsCliDriver } from './driver.js'
import { CodingNsCliSessionStore } from './session-store.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'

export class CodingNsCliAdapterRegistry {
  private readonly drivers = new Map<CodingNsCliAdapterId, CodingNsCliDriver>()
  private readonly sessions = new Map<string, CodingNsCliSessionConfig>()
  private readonly enabled = new Map<CodingNsCliAdapterId, boolean>()

  constructor(
    drivers: readonly CodingNsCliDriver[],
    enabled: Readonly<Record<string, boolean>> = {},
    options: { readonly sessionStore?: CodingNsCliSessionStore; readonly nativeSessions?: CodingNsNativeSessionBridge } = {},
  ) {
    this.sessionStore = options.sessionStore
    this.nativeSessions = options.nativeSessions
    for (const driver of drivers) {
      if (this.drivers.has(driver.descriptor.id)) throw new Error(`重复 Agent: ${driver.descriptor.id}`)
      this.drivers.set(driver.descriptor.id, driver)
      this.enabled.set(driver.descriptor.id, enabled[driver.descriptor.id] !== false)
    }
    for (const record of this.sessionStore?.list({ includeArchived: true }) ?? []) {
      const { dshSessionId: _dshSessionId, title: _title, cwd: _cwd, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, lastError: _lastError, ...config } = record
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
    const normalized = {
      adapterId: config.adapterId,
      ...(config.modelId?.trim() ? { modelId: config.modelId.trim() } : {}),
      ...(config.effortId?.trim() ? { effortId: config.effortId.trim() } : {}),
      ...(config.providerSessionId?.trim() ? { providerSessionId: config.providerSessionId.trim() } : sameAdapter && previous?.providerSessionId ? { providerSessionId: previous.providerSessionId } : {}),
      ...(config.rawStoreRef?.trim() ? { rawStoreRef: config.rawStoreRef.trim() } : sameAdapter && previous?.rawStoreRef ? { rawStoreRef: previous.rawStoreRef } : {}),
    }
    this.sessions.set(sessionId, normalized)
    this.sessionStore?.upsert(sessionId, normalized)
    return normalized
  }

  getSession(sessionId: string): CodingNsCliSessionConfig {
    const session = this.sessions.get(sessionId)
    return session !== undefined && (session.adapterId === 'dsh' || this.isEnabled(session.adapterId)) ? session : { adapterId: 'dsh' }
  }

  async *execute(input: CodingNsCliTurnInput & { readonly adapterId: CodingNsCliAdapterId }): AsyncIterable<CodingNsCliStreamChunk> {
    const driver = this.requireEnabledDriver(input.adapterId)
    const current = this.sessions.get(input.sessionId) ?? { adapterId: input.adapterId }
    this.sessions.set(input.sessionId, current)
    this.sessionStore?.upsert(input.sessionId, {
      ...current,
      adapterId: input.adapterId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      status: 'active',
      title: input.prompt,
    })
    try {
      // Agent Loop 通常已经创建了同名 DSH 原生会话；直接调用 Registry 时才按需补建。
      // 原生服务失败不能阻断外部 Agent，消息仍由现有 llm/stream 链路处理。
      try { await this.nativeSessions?.ensure(input.sessionId, input.cwd) } catch { /* 可选服务降级 */ }
      for await (const chunk of driver.executeTurn(input)) {
        if (chunk.type === 'session-binding') {
          const next = {
            ...current,
            providerSessionId: chunk.providerSessionId,
            ...(chunk.rawStoreRef ? { rawStoreRef: chunk.rawStoreRef } : {}),
          }
          this.sessions.set(input.sessionId, next)
          this.sessionStore?.upsert(input.sessionId, { ...next, status: 'active' })
        }
        if (chunk.type === 'finish') this.sessionStore?.upsert(input.sessionId, { ...this.sessions.get(input.sessionId) ?? current, status: chunk.reason === 'error' ? 'error' : 'idle' })
        yield chunk
      }
    } catch (error) {
      this.sessionStore?.upsert(input.sessionId, {
        ...this.sessions.get(input.sessionId) ?? current,
        status: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      try { await this.nativeSessions?.flush(input.sessionId) } catch { /* DSH 自身检查点策略负责重试 */ }
    }
  }

  listSessions(options: { readonly includeArchived?: boolean; readonly adapterId?: string } = {}): CodingNsCliSessionRecord[] {
    return (this.sessionStore?.list(options) ?? [])
      .filter((record) => record.adapterId !== 'dsh')
      .map(({ rawStoreRef: _rawStoreRef, ...record }) => record)
  }

  archiveSession(sessionId: string): CodingNsCliSessionRecord | undefined {
    const record = this.sessionStore?.archive(sessionId)
    if (record === undefined) return undefined
    const { rawStoreRef: _rawStoreRef, ...safe } = record
    return safe
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
