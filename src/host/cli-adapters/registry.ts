import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliAdapterId,
  CodingNsCliModelCatalog,
  CodingNsCliSessionConfig,
  CodingNsCliStreamChunk,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsCliDriver } from './driver.js'

export class CodingNsCliAdapterRegistry {
  private readonly drivers = new Map<CodingNsCliAdapterId, CodingNsCliDriver>()
  private readonly sessions = new Map<string, CodingNsCliSessionConfig>()
  private readonly enabled = new Map<CodingNsCliAdapterId, boolean>()

  constructor(drivers: readonly CodingNsCliDriver[], enabled: Readonly<Record<string, boolean>> = {}) {
    for (const driver of drivers) {
      if (this.drivers.has(driver.descriptor.id)) throw new Error(`重复 Agent: ${driver.descriptor.id}`)
      this.drivers.set(driver.descriptor.id, driver)
      this.enabled.set(driver.descriptor.id, enabled[driver.descriptor.id] !== false)
    }
  }

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
    const normalized = {
      adapterId: config.adapterId,
      ...(config.modelId?.trim() ? { modelId: config.modelId.trim() } : {}),
      ...(config.effortId?.trim() ? { effortId: config.effortId.trim() } : {}),
    }
    this.sessions.set(sessionId, normalized)
    return normalized
  }

  getSession(sessionId: string): CodingNsCliSessionConfig {
    const session = this.sessions.get(sessionId)
    return session !== undefined && (session.adapterId === 'dsh' || this.isEnabled(session.adapterId)) ? session : { adapterId: 'dsh' }
  }

  async *execute(input: CodingNsCliTurnInput & { readonly adapterId: CodingNsCliAdapterId }): AsyncIterable<CodingNsCliStreamChunk> {
    yield* this.requireEnabledDriver(input.adapterId).executeTurn(input)
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
}
