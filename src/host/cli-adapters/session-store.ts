import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {
  CodingNsCliAdapterId,
  CodingNsCliSessionConfig,
  CodingNsCliSessionRecord,
  CodingNsCliSessionStatus,
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
  readonly lastError?: string
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
    for (const record of options.settings?.get().cliSessions ?? []) this.hydrateRecord(record)
  }

  /** 将设置变更重新载入内存；非法或不完整记录会被忽略。 */
  sync(records: readonly CodingNsCliSessionRecord[] | undefined): void {
    if (records === undefined) return
    this.records.clear()
    for (const record of records) this.hydrateRecord(record)
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

  /** 创建或更新记录；返回值是内存中的规范化记录，持久化在后台串行完成。 */
  upsert(sessionId: string, patch: CodingNsCliSessionPatch & CodingNsCliSessionConfig): CodingNsCliSessionRecord {
    const now = new Date().toISOString()
    const previous = this.records.get(sessionId)
    const adapterId = patch.adapterId ?? previous?.adapterId ?? 'dsh'
    const sameAdapter = previous?.adapterId === adapterId
    const base = sameAdapter ? previous : undefined
    const record: CodingNsCliSessionRecord = {
      dshSessionId: sessionId,
      adapterId,
      ...(patch.modelId?.trim() ? { modelId: patch.modelId.trim() } : base?.modelId ? { modelId: base.modelId } : {}),
      ...(patch.effortId?.trim() ? { effortId: patch.effortId.trim() } : base?.effortId ? { effortId: base.effortId } : {}),
      ...(patch.providerSessionId?.trim() ? { providerSessionId: patch.providerSessionId.trim() } : base?.providerSessionId ? { providerSessionId: base.providerSessionId } : {}),
      ...(patch.rawStoreRef?.trim() ? { rawStoreRef: patch.rawStoreRef.trim() } : base?.rawStoreRef ? { rawStoreRef: base.rawStoreRef } : {}),
      ...(patch.title?.trim() ? { title: patch.title.trim() } : base?.title ? { title: base.title } : {}),
      ...(patch.cwd?.trim() ? { cwd: patch.cwd.trim() } : base?.cwd ? { cwd: base.cwd } : {}),
      ...(patch.lastError?.trim() ? { lastError: patch.lastError.trim() } : {}),
      status: patch.status ?? base?.status ?? 'idle',
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

  async flush(): Promise<void> {
    await this.writeTail
  }

  private hydrateRecord(value: unknown): void {
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
      status: value.status,
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
