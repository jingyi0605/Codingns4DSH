import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DshSessionHeaderLike } from '../../dsh-capabilities/host/session-deletion-adapter.js'
import type {
  SessionDeletionCleanupItem,
  SessionDeletionMode,
  SessionDeletionReasonCode,
  SessionDeletionStatusResult,
} from '../../shared/contracts/session-deletion.js'

export interface SessionIdentityEvidence {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly version: number
  readonly isSeeded: boolean
  readonly parentSession?: string
  readonly origin?: 'subagent'
}

export type PersistedDeletionPhase =
  | 'queued'
  | 'committing'
  | 'log-removed'
  | 'cleanup-pending'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface CascadeDeletionTarget {
  readonly sessionId: string
  readonly identity: SessionIdentityEvidence
  readonly sessionDir: string
  readonly stagingDir: string
  readonly pendingCleanupItems: readonly SessionDeletionCleanupItem[]
  readonly completedCleanupItems: readonly SessionDeletionCleanupItem[]
}

export interface PersistedDeletionRecord {
  readonly operationId: string
  readonly sessionId: string
  readonly callerKey: string
  readonly mode: Exclude<SessionDeletionMode, 'unsupported'>
  readonly phase: PersistedDeletionPhase
  readonly identity: SessionIdentityEvidence
  readonly backend: {
    readonly kind: 'jsonl'
    readonly root: string
    readonly rootDev: string
    readonly rootIno: string
  }
  readonly paths: {
    readonly sessionDir: string
    readonly stagingDir: string
  }
  readonly requestedAt: number
  readonly updatedAt: number
  readonly pendingCleanupItems: readonly SessionDeletionCleanupItem[]
  readonly completedCleanupItems: readonly SessionDeletionCleanupItem[]
  readonly cascadeTargets?: readonly CascadeDeletionTarget[]
  readonly archivedForDeletion?: boolean
  readonly lastErrorCode?: SessionDeletionReasonCode
  readonly lastErrorMessage?: string
}

export interface CascadePrepareTarget {
  readonly sessionId: string
  readonly identity: SessionIdentityEvidence
  readonly revision: string
  readonly expectedCleanupItems: readonly SessionDeletionCleanupItem[]
}

export interface PrepareTokenRecord {
  readonly operationId: string
  readonly callerKey: string
  readonly sessionId: string
  readonly mode: Exclude<SessionDeletionMode, 'unsupported'>
  readonly identity: SessionIdentityEvidence
  readonly revision: string
  readonly instanceId: symbol
  readonly expiresAt: number
  readonly expectedCleanupItems: readonly SessionDeletionCleanupItem[]
  readonly cascadeTargets?: readonly CascadePrepareTarget[]
  consumed: boolean
}

export function buildIdentityEvidence(header: DshSessionHeaderLike): SessionIdentityEvidence {
  return {
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    version: header.version,
    isSeeded: header.isSeeded,
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
  }
}

export function isSameSessionLifecycle(
  expected: SessionIdentityEvidence,
  actual: DshSessionHeaderLike,
): boolean {
  return expected.id === actual.id
    && expected.createdAt === actual.createdAt
    && expected.cwd === actual.cwd
    && expected.isSeeded === actual.isSeeded
    && expected.parentSession === actual.parentSession
    && expected.origin === actual.origin
    && actual.version >= expected.version
}

export function toStatusResult(record: PersistedDeletionRecord): SessionDeletionStatusResult {
  const status = mapPersistedPhase(record.phase)
  return {
    operationId: record.operationId,
    sessionId: record.sessionId,
    status,
    mode: record.mode,
    ...(record.archivedForDeletion === true ? { archived: true } : {}),
    ...(record.lastErrorCode === undefined ? {} : { code: record.lastErrorCode }),
    ...(record.lastErrorMessage === undefined ? {} : { message: record.lastErrorMessage }),
    cancellable: record.phase === 'queued',
    retryableCleanup: record.phase === 'cleanup-pending',
    pendingCleanupItems: [...record.pendingCleanupItems],
    completedCleanupItems: [...record.completedCleanupItems],
    updatedAt: record.updatedAt,
  }
}

function mapPersistedPhase(phase: PersistedDeletionPhase): SessionDeletionStatusResult['status'] {
  switch (phase) {
    case 'queued': return 'queued'
    case 'committing':
    case 'log-removed': return 'deleting'
    case 'cleanup-pending': return 'cleanup-pending'
    case 'completed': return 'deleted'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
  }
}

export class FileSessionDeletionStore {
  private readonly opsDir: string

  constructor(private readonly stateDir: string) {
    this.opsDir = join(stateDir, 'session-deletion', 'ops')
  }

  async writeRecord(record: PersistedDeletionRecord): Promise<void> {
    await mkdir(this.opsDir, { recursive: true, mode: 0o700 })
    const filePath = this.recordPath(record.operationId)
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    const payload = `${JSON.stringify(record)}\n`
    const handle = await open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmpPath, filePath)
    await syncDirBestEffort(this.opsDir)
  }

  async readRecord(operationId: string): Promise<PersistedDeletionRecord | undefined> {
    try {
      const raw = await readFile(this.recordPath(operationId), 'utf8')
      return parsePersistedRecord(JSON.parse(raw))
    } catch (error) {
      if (isEnoent(error)) return undefined
      throw error
    }
  }

  async listRecords(): Promise<PersistedDeletionRecord[]> {
    let entries
    try {
      entries = await readdir(this.opsDir, { withFileTypes: true })
    } catch (error) {
      if (isEnoent(error)) return []
      throw error
    }
    const records: PersistedDeletionRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.opsDir, entry.name), 'utf8')
        const parsed = parsePersistedRecord(JSON.parse(raw))
        if (parsed !== undefined) records.push(parsed)
      } catch (error) {
        if (!isEnoent(error)) throw error
      }
    }
    records.sort((left, right) => right.updatedAt - left.updatedAt)
    return records
  }

  async findLatestBySessionId(sessionId: string): Promise<PersistedDeletionRecord | undefined> {
    const all = await this.listRecords()
    return all.find((record) => record.sessionId === sessionId)
  }

  async findActiveBySessionId(sessionId: string): Promise<PersistedDeletionRecord | undefined> {
    const all = await this.listRecords()
    return all.find((record) => record.sessionId === sessionId && isActivePersistedPhase(record.phase))
  }

  async deleteRecord(operationId: string): Promise<void> {
    await rm(this.recordPath(operationId), { force: true })
  }

  private recordPath(operationId: string): string {
    const safeId = operationId.replace(/[^A-Za-z0-9._-]/gu, '_')
    return join(this.opsDir, `${safeId}.json`)
  }
}

export function isActivePersistedPhase(phase: PersistedDeletionPhase): boolean {
  return phase === 'queued' || phase === 'committing' || phase === 'log-removed' || phase === 'cleanup-pending'
}

export class PrepareTokenRegistry {
  private readonly tokens = new Map<string, PrepareTokenRecord>()

  issue(record: PrepareTokenRecord): void {
    this.pruneExpired(Date.now())
    this.tokens.set(record.operationId, record)
  }

  get(operationId: string): PrepareTokenRecord | undefined {
    return this.tokens.get(operationId)
  }

  pruneExpired(now: number): void {
    for (const [id, token] of this.tokens) {
      if (token.expiresAt <= now || token.consumed) {
        if (token.expiresAt <= now) this.tokens.delete(id)
      }
    }
  }
}

function parsePersistedRecord(value: unknown): PersistedDeletionRecord | undefined {
  if (!isObject(value)) return undefined
  if (
    typeof value.operationId !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.callerKey !== 'string'
    || (value.mode !== 'immediate' && value.mode !== 'restart-required')
    || typeof value.phase !== 'string'
    || !isObject(value.identity)
    || !isObject(value.backend)
    || !isObject(value.paths)
    || typeof value.requestedAt !== 'number'
    || typeof value.updatedAt !== 'number'
    || !Array.isArray(value.pendingCleanupItems)
    || !Array.isArray(value.completedCleanupItems)
  ) {
    return undefined
  }
  return value as unknown as PersistedDeletionRecord
}

async function syncDirBestEffort(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync may be unsupported on some virtual filesystems.
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
