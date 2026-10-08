import type { DshHostSettingsScope } from '../../dsh-capabilities/host/config-forms-adapter.js'
import type {
  CodingNsCliAdapterId,
  CodingNsCliSessionConfig,
  CodingNsCliProviderSessionState,
  CodingNsCliSessionRecord,
  CodingNsCliSessionStatus,
  CodingNsSessionAdapterBinding,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { inspectLegacySessionAdapter, type LegacySessionAdapterEvidence } from './legacy-session-adapter.js'
import { readLegacyImportedSessionRecords } from './legacy-session-settings.js'

/**
 * 可替换的会话持久化后端。
 *
 * 默认实现写入 DSH 的 Codingns4DSH 设置文档；当 DSH 暴露原生 SessionStore
 * 扩展点后，只需替换这个后端，不需要改 Registry 或驱动。
 */
export interface CodingNsCliSessionPersistence {
  write(records: readonly CodingNsCliSessionRecord[]): Promise<void>
}

export interface CodingNsCliSessionStoreOptions {
  readonly settings?: DshHostSettingsScope<CodingNsSettings>
  readonly persistence?: CodingNsCliSessionPersistence
}

export interface CodingNsCliSessionPatch {
  readonly adapterId?: CodingNsCliAdapterId
  readonly modelId?: string
  readonly effortId?: string
  readonly serviceTierId?: string
  readonly providerId?: string
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
  readonly parentSessionId?: string
  readonly origin?: CodingNsCliSessionRecord['origin']
  readonly delegationDepth?: number
  readonly continuationId?: string
  readonly teamId?: string
  readonly teamMemberId?: string
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
  private readonly settings: DshHostSettingsScope<CodingNsSettings> | undefined
  private readonly persistence: CodingNsCliSessionPersistence | undefined
  private readonly legacyImportedRecords: readonly CodingNsCliSessionRecord[]
  private writeTail: Promise<void> = Promise.resolve()
  private persistPending = false
  private persistRunning = false
  private readonly legacyEvidence = new WeakMap<object, LegacySessionAdapterEvidence | undefined>()
  private disposed = false

  constructor(options: CodingNsCliSessionStoreOptions = {}) {
    this.settings = options.settings
    this.persistence = options.persistence
    // DSH 升级时会把旧设置保存为 settings.yaml.imported；先恢复其中的
    // 外部会话索引，再用当前设置覆盖同 ID 记录，保证用户后续修改优先。
    this.legacyImportedRecords = options.settings === undefined ? [] : readLegacyImportedSessionRecords()
    for (const record of this.legacyImportedRecords) this.hydrateRecord(record, true)
    for (const record of options.settings?.get().cliSessions ?? []) this.hydrateRecord(record, true)
  }

  /** 将设置变更重新载入内存；非法或不完整记录会被忽略。 */
  sync(records: readonly CodingNsCliSessionRecord[] | undefined): void {
    if (records === undefined) return
    // 设置 watch 会回送正在落盘的旧快照；不能覆盖这期间刚产生的 Provider 绑定。
    if (this.persistRunning || this.persistPending) return
    if (records.length === this.records.size && records.every((record) => {
      const current = this.records.get(record.dshSessionId)
      return current !== undefined && sameRecord(current, record)
    })) return
    this.records.clear()
    for (const record of this.legacyImportedRecords) this.hydrateRecord(record, false)
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
    return [...this.records.values()].map((record) => ({
      sessionId: record.dshSessionId,
      adapterId: record.adapterId,
    }))
  }

  /**
   * 打开旧 DSH 会话时按需回填；已有索引无需再读取历史。
   *
   * 两遍处理：先按会话自身日志回填，再让 `isSeeded` 分叉子会话继承父会话
   * 已经确认的绑定。父会话可能排在子会话之后，所以继承必须单独走第二遍。
   */
  migrateLegacySessions(sessions: readonly unknown[]): { migrated: number; unresolved: number } {
    let migrated = 0
    let unresolved = 0
    const pendingInheritance: { readonly sessionId: string; readonly parentSessionId: string; readonly cwd?: string }[] = []
    for (const session of sessions) {
      if (!isRecord(session)) continue
      const header = isRecord(session.header) ? session.header : undefined
      const sessionId = stringValue(session.id) ?? stringValue(session.sessionId) ?? stringValue(header?.id)
      if (sessionId !== undefined && this.records.get(sessionId)?.adapterId !== undefined && this.records.get(sessionId)?.adapterId !== 'dsh') continue
      // 同一个已加载旧会话只解析一次；新增来源事件由调用方显式使缓存失效。
      const evidence = this.legacyEvidence.has(session)
        ? this.legacyEvidence.get(session)
        : inspectLegacySessionAdapter(session)
      this.legacyEvidence.set(session, evidence)
      if (evidence === undefined) continue
      // 自身日志没有外部证据、但确实是 fork 子会话：绑定只能来自父会话，
      // 放进第二遍。自身已有外部证据的会话一律按自己的日志处理。
      if (!evidence.external && evidence.adapterId === undefined
        && evidence.seeded && evidence.parentSessionId !== undefined) {
        pendingInheritance.push({
          sessionId: evidence.sessionId,
          parentSessionId: evidence.parentSessionId,
          ...(evidence.cwd === undefined ? {} : { cwd: evidence.cwd }),
        })
        continue
      }
      const existing = this.records.get(evidence.sessionId)
      if (existing !== undefined && existing.adapterId !== 'dsh') continue
      if (evidence.adapterId === undefined) {
        // 有外部证据但适配器不唯一：计入 unresolved，避免静默丢失绑定。
        if (evidence.external) unresolved += 1
        continue
      }
      this.upsert(evidence.sessionId, {
        adapterId: evidence.adapterId,
        ...(evidence.cwd === undefined ? {} : { cwd: evidence.cwd }),
        status: existing?.status ?? 'idle',
      })
      migrated += 1
    }
    for (const pending of pendingInheritance) {
      const existing = this.records.get(pending.sessionId)
      if (existing !== undefined && existing.adapterId !== 'dsh') continue
      const parent = this.records.get(pending.parentSessionId)
      if (parent === undefined || parent.adapterId === 'dsh') continue
      const cwd = pending.cwd ?? parent.cwd
      this.upsert(pending.sessionId, {
        adapterId: parent.adapterId,
        ...(parent.modelId === undefined ? {} : { modelId: parent.modelId }),
        ...(parent.effortId === undefined ? {} : { effortId: parent.effortId }),
        ...(parent.serviceTierId === undefined ? {} : { serviceTierId: parent.serviceTierId }),
        ...(cwd === undefined ? {} : { cwd }),
        status: existing?.status ?? 'idle',
      })
      migrated += 1
    }
    return { migrated, unresolved }
  }

  invalidateLegacySession(session: unknown): void {
    if (isRecord(session)) this.legacyEvidence.delete(session)
  }

  /** 创建或更新记录；返回值是内存中的规范化记录，持久化在后台串行完成。 */
  upsert(sessionId: string, patch: CodingNsCliSessionPatch & CodingNsCliSessionConfig): CodingNsCliSessionRecord {
    const now = new Date().toISOString()
    const previous = this.records.get(sessionId)
    const adapterId = normalizeAdapterId(patch.adapterId ?? previous?.adapterId ?? 'dsh')
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
      ...(patch.serviceTierId?.trim() ? { serviceTierId: patch.serviceTierId.trim() } : base?.serviceTierId ? { serviceTierId: base.serviceTierId } : {}),
      ...(patch.providerId?.trim() ? { providerId: patch.providerId.trim() } : base?.providerId ? { providerId: base.providerId } : {}),
      ...(providerSessionId ? { providerSessionId } : base?.providerSessionId ? { providerSessionId: base.providerSessionId } : {}),
      ...(patch.rawStoreRef?.trim() ? { rawStoreRef: patch.rawStoreRef.trim() } : providerBase?.rawStoreRef ? { rawStoreRef: providerBase.rawStoreRef } : {}),
      ...(stringValue(patch.parentSessionId) ? { parentSessionId: stringValue(patch.parentSessionId)! } : base?.parentSessionId ? { parentSessionId: base.parentSessionId } : {}),
      ...(isSessionOrigin(patch.origin) ? { origin: patch.origin } : base?.origin ? { origin: base.origin } : {}),
      ...(finiteNonNegativeInteger(patch.delegationDepth) ? { delegationDepth: patch.delegationDepth } : base?.delegationDepth === undefined ? {} : { delegationDepth: base.delegationDepth }),
      ...(stringValue(patch.continuationId) ? { continuationId: stringValue(patch.continuationId)! } : base?.continuationId ? { continuationId: base.continuationId } : {}),
      ...(stringValue(patch.teamId) ? { teamId: stringValue(patch.teamId)! } : base?.teamId ? { teamId: base.teamId } : {}),
      ...(stringValue(patch.teamMemberId) ? { teamMemberId: stringValue(patch.teamMemberId)! } : base?.teamMemberId ? { teamMemberId: base.teamMemberId } : {}),
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
    if (base !== undefined && sameRecord(base, record, true)) return { ...base }
    this.records.set(sessionId, record)
    this.schedulePersist()
    return { ...record }
  }

  archive(sessionId: string): CodingNsCliSessionRecord | undefined {
    const previous = this.records.get(sessionId)
    if (previous === undefined) return undefined
    if (previous.status === 'archived') return { ...previous }
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
    if (sameRecord(previous, record)) return { ...previous }
    this.records.set(sessionId, record)
    this.schedulePersist()
    return { ...record }
  }

  async flush(): Promise<void> {
    let tail: Promise<void>
    do { tail = this.writeTail; await tail } while (tail !== this.writeTail)
  }

  /** 停止上下文销毁后的异步设置写入；内存索引仍保留给当前清理流程读取。 */
  dispose(): void {
    this.disposed = true
  }

  private hydrateRecord(value: unknown, resetActive: boolean): void {
    if (!isRecord(value)) return
    if (typeof value.dshSessionId !== 'string' || value.dshSessionId.trim() === '') return
    if (typeof value.adapterId !== 'string' || value.adapterId.trim() === '') return
    if (!isStatus(value.status) || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return
    const origin = isSessionOrigin(value.origin) ? value.origin : undefined
    this.records.set(value.dshSessionId, {
      dshSessionId: value.dshSessionId,
      adapterId: normalizeAdapterId(value.adapterId),
      ...(stringValue(value.modelId) ? { modelId: stringValue(value.modelId)! } : {}),
      ...(stringValue(value.effortId) ? { effortId: stringValue(value.effortId)! } : {}),
      ...(stringValue(value.serviceTierId) ? { serviceTierId: stringValue(value.serviceTierId)! } : {}),
      ...(stringValue(value.providerId) ? { providerId: stringValue(value.providerId)! } : {}),
      ...(stringValue(value.providerSessionId) ? { providerSessionId: stringValue(value.providerSessionId)! } : {}),
      ...(stringValue(value.rawStoreRef) ? { rawStoreRef: stringValue(value.rawStoreRef)! } : {}),
      ...(stringValue(value.parentSessionId) ? { parentSessionId: stringValue(value.parentSessionId)! } : {}),
      ...(origin === undefined ? {} : { origin }),
      ...(finiteNonNegativeInteger(value.delegationDepth) ? { delegationDepth: value.delegationDepth } : {}),
      ...(stringValue(value.continuationId) ? { continuationId: stringValue(value.continuationId)! } : {}),
      ...(stringValue(value.teamId) ? { teamId: stringValue(value.teamId)! } : {}),
      ...(stringValue(value.teamMemberId) ? { teamMemberId: stringValue(value.teamMemberId)! } : {}),
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
    if (this.disposed) return
    this.persistPending = true
    if (this.persistRunning) return
    this.persistRunning = true
    this.writeTail = this.writeTail
      .catch(() => undefined)
      .then(async () => {
        while (this.persistPending && !this.disposed) {
          this.persistPending = false
          // 到真正写入时才生成最新快照，流式事件只占一个待保存位置。
          const snapshot = this.list({ includeArchived: true })
          if (this.persistence !== undefined) await this.persistence.write(snapshot)
          if (this.settings !== undefined) await this.settings.update({ cliSessions: snapshot })
        }
      })
      .catch((error: unknown) => {
        // 会话索引是辅助缓存；设置服务短暂不可用不能杀死 Host 或模型探测任务。
        console.warn('codingns4dsh: 外部会话索引持久化失败', error)
      })
      .finally(() => {
        this.persistRunning = false
        if (this.persistPending && !this.disposed) this.schedulePersist()
      })
  }
}

/** 会话记录仅含标量字段；活动时间不应因为相同数据被重复提交而改变。 */
function sameRecord(left: CodingNsCliSessionRecord, right: CodingNsCliSessionRecord, ignoreUpdatedAt = false): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (ignoreUpdatedAt && key === 'updatedAt') continue
    if (left[key as keyof CodingNsCliSessionRecord] !== right[key as keyof CodingNsCliSessionRecord]) return false
  }
  return true
}

/** 旧版本曾把同一 CLI 的国内 profile 持久化为独立 ID，统一迁移回 codebuddy。 */
function normalizeAdapterId(value: string): string {
  return value === 'codebuddy-cn' ? 'codebuddy' : value
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

function isSessionOrigin(value: unknown): value is CodingNsCliSessionRecord['origin'] {
  return value === 'user' || value === 'subagent' || value === 'plugin'
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
