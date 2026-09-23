import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {
  CodingNsCliAdapterId,
  CodingNsCliSessionConfig,
  CodingNsCliProviderSessionState,
  CodingNsCliSessionRecord,
  CodingNsCliSessionStatus,
  CodingNsSessionAdapterBinding,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsSettings } from '../../shared/contracts/config.js'

/**
 * 可替换的会话持久化后端。
 *
 * 默认实现写入 DSH 的 CodingNS 设置文档；当 DSH 暴露原生 SessionStore
 * 扩展点后，只需替换这个后端，不需要改 Registry 或驱动。
 */
export interface CodingNsCliSessionPersistence {
  write(records: readonly CodingNsCliSessionRecord[]): Promise<void>
}

export interface CodingNsCliSessionStoreOptions {
  readonly settings?: SettingsScope<CodingNsSettings>
  readonly persistence?: CodingNsCliSessionPersistence
}

export interface CodingNsCliSessionPatch {
  readonly adapterId?: CodingNsCliAdapterId
  readonly modelId?: string
  readonly effortId?: string
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
  readonly title?: string
  readonly cwd?: string
  readonly status?: CodingNsCliSessionStatus
  readonly providerState?: CodingNsCliProviderSessionState
  readonly providerCheckedAt?: string
  readonly providerStateReason?: string
  readonly lastError?: string
}

export interface CodingNsCliProviderStatePatch {
  readonly state: CodingNsCliProviderSessionState
  readonly checkedAt: string
  readonly reason?: string
  readonly rawStoreRef?: string
}

/**
 * Host-only 的外部 Agent 会话索引。
 *
 * 进程句柄、refresh token、原始消息都不进入这里；它只记录下次恢复运行时
 * 所需的 providerSessionId 和给列表页展示的摘要。写入按顺序排队，避免多轮
 * 流式事件同时更新设置时发生后写覆盖先写。
 */
export class CodingNsCliSessionStore {
  private readonly records = new Map<string, CodingNsCliSessionRecord>()
  private readonly settings: SettingsScope<CodingNsSettings> | undefined
  private readonly persistence: CodingNsCliSessionPersistence | undefined
  private writeTail: Promise<void> = Promise.resolve()

  constructor(options: CodingNsCliSessionStoreOptions = {}) {
    this.settings = options.settings
    this.persistence = options.persistence
    for (const record of options.settings?.get().cliSessions ?? []) this.hydrateRecord(record, true)
  }

  /** 将设置变更重新载入内存；非法或不完整记录会被忽略。 */
  sync(records: readonly CodingNsCliSessionRecord[] | undefined): void {
    if (records === undefined) return
    this.records.clear()
    for (const record of records) this.hydrateRecord(record, false)
  }

  get(sessionId: string): CodingNsCliSessionRecord | undefined {
    return this.records.get(sessionId)
  }

  list(options: { readonly includeArchived?: boolean; readonly adapterId?: string } = {}): CodingNsCliSessionRecord[] {
    return [...this.records.values()]
      .filter((record) => options.includeArchived === true || record.status !== 'archived')
      .filter((record) => options.adapterId === undefined || record.adapterId === options.adapterId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => ({ ...record }))
  }

  /** 浏览器会话行只需要这两个字段，Host-only 恢复信息不得跨过 RPC 边界。 */
  adapterBindings(): CodingNsSessionAdapterBinding[] {
    return this.list().map((record) => ({
      sessionId: record.dshSessionId,
      adapterId: record.adapterId,
    }))
  }

  /** 创建或更新记录；返回值是内存中的规范化记录，持久化在后台串行完成。 */
  upsert(sessionId: string, patch: CodingNsCliSessionPatch & CodingNsCliSessionConfig): CodingNsCliSessionRecord {
    const now = new Date().toISOString()
    const previous = this.records.get(sessionId)
    const adapterId = patch.adapterId ?? previous?.adapterId ?? 'dsh'
    const sameAdapter = previous?.adapterId === adapterId
    const base = sameAdapter ? previous : undefined
    const providerSessionId = patch.providerSessionId?.trim()
    // providerSessionId 是 Provider 绑定的身份。即使适配器没变，身份一旦改变，
    // 旧路径和旧探测结果也不能继承，否则会拿旧会话的状态判断新会话。
    const providerIdentityChanged = providerSessionId !== undefined
      && providerSessionId !== base?.providerSessionId
    const providerBase = providerIdentityChanged ? undefined : base
    const record: CodingNsCliSessionRecord = {
      dshSessionId: sessionId,
      adapterId,
      ...(patch.modelId?.trim() ? { modelId: patch.modelId.trim() } : base?.modelId ? { modelId: base.modelId } : {}),
      ...(patch.effortId?.trim() ? { effortId: patch.effortId.trim() } : base?.effortId ? { effortId: base.effortId } : {}),
      ...(providerSessionId ? { providerSessionId } : base?.providerSessionId ? { providerSessionId: base.providerSessionId } : {}),
      ...(patch.rawStoreRef?.trim() ? { rawStoreRef: patch.rawStoreRef.trim() } : providerBase?.rawStoreRef ? { rawStoreRef: providerBase.rawStoreRef } : {}),
      ...(patch.title?.trim() ? { title: patch.title.trim() } : base?.title ? { title: base.title } : {}),
      ...(patch.cwd?.trim() ? { cwd: patch.cwd.trim() } : base?.cwd ? { cwd: base.cwd } : {}),
      ...(patch.lastError?.trim() ? { lastError: patch.lastError.trim() } : {}),
      // archived 是侧栏 tombstone。延迟到达的 turn/end 或驱动 finish 不能把它
      // 重新写回 idle；恢复必须走未来显式的 unarchive 链路。
      status: base?.status === 'archived' ? 'archived' : patch.status ?? base?.status ?? 'idle',
      ...(patch.providerState !== undefined
        ? { providerState: patch.providerState }
        : providerBase?.providerState !== undefined
          ? { providerState: providerBase.providerState }
          : {}),
      ...(patch.providerCheckedAt?.trim()
        ? { providerCheckedAt: patch.providerCheckedAt.trim() }
        : patch.providerState === undefined && providerBase?.providerCheckedAt
          ? { providerCheckedAt: providerBase.providerCheckedAt }
          : {}),
      ...(patch.providerStateReason?.trim()
        ? { providerStateReason: patch.providerStateReason.trim() }
        : patch.providerState === undefined && providerBase?.providerStateReason
          ? { providerStateReason: providerBase.providerStateReason }
          : {}),
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
    }
    this.records.set(sessionId, record)
    this.schedulePersist()
    return { ...record }
  }

  archive(sessionId: string): CodingNsCliSessionRecord | undefined {
    const previous = this.records.get(sessionId)
    if (previous === undefined) return undefined
    const record = { ...previous, status: 'archived' as const, updatedAt: new Date().toISOString() }
    this.records.set(sessionId, record)
    this.schedulePersist()
    return { ...record }
  }

  /** 更新 Provider 存在性，不改变会话活动时间，避免后台检查扰乱侧栏排序。 */
  updateProviderState(sessionId: string, patch: CodingNsCliProviderStatePatch): CodingNsCliSessionRecord | undefined {
    const previous = this.records.get(sessionId)
    if (previous === undefined) return undefined
    const { providerStateReason: _previousReason, ...base } = previous
    const record: CodingNsCliSessionRecord = {
      ...base,
      providerState: patch.state,
      providerCheckedAt: patch.checkedAt,
      ...(patch.reason?.trim() ? { providerStateReason: patch.reason.trim() } : {}),
      ...(patch.rawStoreRef?.trim() ? { rawStoreRef: patch.rawStoreRef.trim() } : {}),
    }
    this.records.set(sessionId, record)
    this.schedulePersist()
    return { ...record }
  }

  async flush(): Promise<void> {
    await this.writeTail
  }

  private hydrateRecord(value: unknown, resetActive: boolean): void {
    if (!isRecord(value)) return
    if (typeof value.dshSessionId !== 'string' || value.dshSessionId.trim() === '') return
    if (typeof value.adapterId !== 'string' || value.adapterId.trim() === '') return
    if (!isStatus(value.status) || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return
    this.records.set(value.dshSessionId, {
      dshSessionId: value.dshSessionId,
      adapterId: value.adapterId,
      ...(stringValue(value.modelId) ? { modelId: stringValue(value.modelId)! } : {}),
      ...(stringValue(value.effortId) ? { effortId: stringValue(value.effortId)! } : {}),
      ...(stringValue(value.providerSessionId) ? { providerSessionId: stringValue(value.providerSessionId)! } : {}),
      ...(stringValue(value.rawStoreRef) ? { rawStoreRef: stringValue(value.rawStoreRef)! } : {}),
      ...(stringValue(value.title) ? { title: stringValue(value.title)! } : {}),
      ...(stringValue(value.cwd) ? { cwd: stringValue(value.cwd)! } : {}),
      ...(stringValue(value.lastError) ? { lastError: stringValue(value.lastError)! } : {}),
      // active 只描述当前 Host 进程中的执行。进程重启后没有仍在运行的 Turn，
      // 必须回到 idle，否则列表刷新会永久跳过该记录的存活探测。
      status: resetActive && value.status === 'active' ? 'idle' : value.status,
      ...(isProviderState(value.providerState) ? { providerState: value.providerState } : {}),
      ...(stringValue(value.providerCheckedAt) ? { providerCheckedAt: stringValue(value.providerCheckedAt)! } : {}),
      ...(stringValue(value.providerStateReason) ? { providerStateReason: stringValue(value.providerStateReason)! } : {}),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    })
  }

  private schedulePersist(): void {
    const snapshot = this.list({ includeArchived: true })
    this.writeTail = this.writeTail
      .catch(() => undefined)
      .then(async () => {
        if (this.persistence !== undefined) await this.persistence.write(snapshot)
        if (this.settings !== undefined) await this.settings.update({ cliSessions: snapshot })
      })
  }
}

function isStatus(value: unknown): value is CodingNsCliSessionStatus {
  return value === 'active' || value === 'idle' || value === 'error' || value === 'archived'
}

function isProviderState(value: unknown): value is CodingNsCliProviderSessionState {
  return value === 'unchecked'
    || value === 'available'
    || value === 'missing'
    || value === 'corrupt'
    || value === 'unreachable'
    || value === 'unknown'
    || value === 'ephemeral'
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
