import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type WorkspaceMcpWebhookEventType =
  | 'session.completed'
  | 'session.failed'
  | 'session.permission_requested'
  | 'session.question_asked'
  | 'webhook.test'

export interface WorkspaceMcpWebhookDestination {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly secret: string
  readonly enabled: boolean
  readonly workspaceIds: readonly string[] | null
  readonly eventTypes: readonly WorkspaceMcpWebhookEventType[]
  readonly includeLastMessage: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WorkspaceMcpWebhookDeliverySnapshot {
  readonly url: string
  readonly secret: string
  readonly includeLastMessage: boolean
}

export type WorkspaceMcpWebhookDeliveryStatus = 'pending' | 'sending' | 'delivered' | 'failed'

export interface WorkspaceMcpWebhookDelivery {
  readonly deliveryId: string
  readonly eventId: string
  readonly dedupeKey: string
  readonly eventType: WorkspaceMcpWebhookEventType
  readonly destinationId: string
  readonly destinationName: string
  readonly destinationSnapshot: WorkspaceMcpWebhookDeliverySnapshot
  readonly status: WorkspaceMcpWebhookDeliveryStatus
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly lastError: string | null
  readonly httpStatus?: number
  readonly body: string
  readonly createdAt: string
  readonly finishedAt: string | null
}

export interface WorkspaceMcpWebhookStoreData {
  readonly version: 1
  readonly destinations: readonly WorkspaceMcpWebhookDestination[]
  readonly deliveries: readonly WorkspaceMcpWebhookDelivery[]
  readonly dedupeKeys: readonly string[]
  readonly diagnostics: {
    readonly droppedFinishedDeliveries: number
    readonly droppedPendingDeliveries: number
  }
}

export type WorkspaceMcpWebhookStoreStatus = 'ok' | 'recovered' | 'degraded'

export interface WorkspaceMcpWebhookStoreSnapshot extends WorkspaceMcpWebhookStoreData {
  readonly store: WorkspaceMcpWebhookStoreStatus
}

export class WorkspaceMcpWebhookStoreError extends Error {
  constructor(readonly code: 'WORKSPACE_MCP_WEBHOOK_LIMIT' | 'WORKSPACE_MCP_WEBHOOK_NOT_FOUND', message: string) {
    super(message)
    this.name = 'WorkspaceMcpWebhookStoreError'
  }
}

const MAX_DESTINATIONS = 20
const MAX_PENDING_DELIVERIES = 1000
const MAX_RECENT_DELIVERIES = 200
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const EVENT_TYPES = new Set<WorkspaceMcpWebhookEventType>([
  'session.completed', 'session.failed', 'session.permission_requested', 'session.question_asked', 'webhook.test',
])

/** Stores webhook secrets and durable deliveries in a private Host-only file. */
export class FileWorkspaceMcpWebhookStore {
  private data: MutableStoreData = emptyStoreData()
  private loadPromise: Promise<void> | undefined
  private status: WorkspaceMcpWebhookStoreStatus = 'ok'
  private corruptBackupCreated = false
  private changeVersion = 0
  private writeScheduled = false
  private persistenceTask: Promise<void> = Promise.resolve()
  private readonly persistenceWaiters: Array<{ version: number; resolve(): void }> = []

  constructor(private readonly filePath = defaultWebhookStorePath(), private readonly now: () => number = Date.now) {}

  async snapshot(): Promise<WorkspaceMcpWebhookStoreSnapshot> {
    await this.ensureLoaded()
    return { ...clone(this.data), store: this.status }
  }

  async createDestination(destination: WorkspaceMcpWebhookDestination): Promise<WorkspaceMcpWebhookDestination> {
    await this.ensureLoaded()
    if (this.data.destinations.length >= MAX_DESTINATIONS) {
      throw new WorkspaceMcpWebhookStoreError('WORKSPACE_MCP_WEBHOOK_LIMIT', 'The webhook destination limit has been reached.')
    }
    this.data.destinations.push(clone(destination))
    this.addDropped(this.prune())
    await this.schedulePersistence()
    return clone(destination)
  }

  async updateDestination(id: string, patch: Partial<Omit<WorkspaceMcpWebhookDestination, 'id' | 'createdAt'>>): Promise<WorkspaceMcpWebhookDestination> {
    await this.ensureLoaded()
    const index = this.data.destinations.findIndex((destination) => destination.id === id)
    if (index < 0) throw new WorkspaceMcpWebhookStoreError('WORKSPACE_MCP_WEBHOOK_NOT_FOUND', 'The webhook destination was not found.')
    const current = this.data.destinations[index]!
    const updated = { ...current, ...clone(patch), updatedAt: new Date(this.now()).toISOString() }
    this.data.destinations[index] = updated
    await this.schedulePersistence()
    return clone(updated)
  }

  async removeDestination(id: string): Promise<boolean> {
    await this.ensureLoaded()
    const index = this.data.destinations.findIndex((destination) => destination.id === id)
    if (index < 0) return false
    this.data.destinations.splice(index, 1)
    this.data.deliveries = this.data.deliveries.filter((delivery) =>
      delivery.destinationId !== id || isFinished(delivery.status))
    this.addDropped(this.prune())
    await this.schedulePersistence()
    return true
  }

  async enqueue(delivery: WorkspaceMcpWebhookDelivery): Promise<number> {
    return (await this.enqueueOnce(delivery)).droppedPending
  }

  async enqueueOnce(delivery: WorkspaceMcpWebhookDelivery): Promise<{ readonly queued: boolean; readonly droppedPending: number }> {
    await this.ensureLoaded()
    if (this.data.dedupeKeys.includes(delivery.dedupeKey)) {
      return { queued: false, droppedPending: 0 }
    }
    this.data.dedupeKeys.push(delivery.dedupeKey)
    this.data.deliveries.push(clone(delivery))
    const dropped = this.prune()
    this.addDropped(dropped)
    await this.schedulePersistence()
    return { queued: true, droppedPending: dropped.pending }
  }

  async updateDelivery(
    deliveryId: string,
    patch: Partial<Pick<WorkspaceMcpWebhookDelivery, 'status' | 'attempts' | 'nextAttemptAt' | 'lastError' | 'httpStatus' | 'finishedAt'>>,
  ): Promise<WorkspaceMcpWebhookDelivery> {
    await this.ensureLoaded()
    const index = this.data.deliveries.findIndex((delivery) => delivery.deliveryId === deliveryId)
    if (index < 0) throw new WorkspaceMcpWebhookStoreError('WORKSPACE_MCP_WEBHOOK_NOT_FOUND', 'The webhook delivery was not found.')
    const updated = { ...this.data.deliveries[index]!, ...clone(patch) }
    this.data.deliveries[index] = updated
    this.addDropped(this.prune())
    await this.schedulePersistence()
    return clone(updated)
  }

  async flush(): Promise<WorkspaceMcpWebhookStoreSnapshot> {
    await this.ensureLoaded()
    await this.schedulePersistence()
    return this.snapshot()
  }

  async close(): Promise<void> {
    await this.flush()
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
      if (!isStoreData(parsed)) throw new TypeError('Invalid webhook store data')
    } catch {
      await this.backupCorruptFile()
      this.status = 'recovered'
      this.corruptBackupCreated = true
      return
    }
    try {
      await chmod(dirname(this.filePath), 0o700)
      await chmod(this.filePath, 0o600)
    } catch {
      this.status = 'degraded'
    }
    this.data = {
      ...parsed,
      dedupeKeys: [...new Set([...(parsed.dedupeKeys ?? []), ...parsed.deliveries.map((delivery) => delivery.dedupeKey)])],
      diagnostics: {
        droppedFinishedDeliveries: parsed.diagnostics?.droppedFinishedDeliveries ?? 0,
        droppedPendingDeliveries: parsed.diagnostics?.droppedPendingDeliveries ?? 0,
      },
    }
    const previous = JSON.stringify(this.data)
    this.data.deliveries = this.data.deliveries.map((delivery) => delivery.status === 'sending'
      ? { ...delivery, status: 'pending' }
      : delivery)
    this.addDropped(this.prune())
    if (JSON.stringify(this.data) !== previous) await this.schedulePersistence()
  }

  private async backupCorruptFile(): Promise<void> {
    const base = `${this.filePath}.corrupt-${this.now()}`
    for (let suffix = 0; ; suffix += 1) {
      const target = suffix === 0 ? `${base}-${randomUUID()}` : `${base}-${suffix}-${randomUUID()}`
      try {
        await rename(this.filePath, target)
        try {
          await chmod(dirname(target), 0o700)
          await chmod(target, 0o600)
        } catch {
          this.status = 'degraded'
        }
        return
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
      }
    }
  }

  private prune(): { readonly finished: number; readonly pending: number } {
    const cutoff = this.now() - DELIVERY_RETENTION_MS
    const retained = this.data.deliveries.filter((delivery) => !isFinished(delivery.status)
      || (delivery.finishedAt !== null && Date.parse(delivery.finishedAt) >= cutoff))
    const expiredFinished = this.data.deliveries.length - retained.length
    this.data.deliveries = retained

    const finished = this.data.deliveries.filter((delivery) => isFinished(delivery.status))
      .sort((left, right) => Date.parse(left.finishedAt ?? left.createdAt) - Date.parse(right.finishedAt ?? right.createdAt))
    const removeFinished = Math.max(0, finished.length - MAX_RECENT_DELIVERIES)
    if (removeFinished > 0) {
      const oldIds = new Set(finished.slice(0, removeFinished).map((delivery) => delivery.deliveryId))
      this.data.deliveries = this.data.deliveries.filter((delivery) => !oldIds.has(delivery.deliveryId))
    }

    const pending = this.data.deliveries.filter((delivery) => !isFinished(delivery.status))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    const dropped = Math.max(0, pending.length - MAX_PENDING_DELIVERIES)
    if (dropped > 0) {
      const oldIds = new Set(pending.slice(0, dropped).map((delivery) => delivery.deliveryId))
      this.data.deliveries = this.data.deliveries.filter((delivery) => !oldIds.has(delivery.deliveryId))
    }
    return { finished: expiredFinished + removeFinished, pending: dropped }
  }

  private addDropped(dropped: { readonly finished: number; readonly pending: number }): void {
    this.data.diagnostics.droppedFinishedDeliveries += dropped.finished
    this.data.diagnostics.droppedPendingDeliveries += dropped.pending
  }

  private schedulePersistence(): Promise<void> {
    const version = ++this.changeVersion
    const completion = new Promise<void>((resolve) => this.persistenceWaiters.push({ version, resolve }))
    if (!this.writeScheduled) {
      this.writeScheduled = true
      queueMicrotask(() => {
        this.writeScheduled = false
        const task = this.persistenceTask.then(() => this.persistCurrent())
        this.persistenceTask = task.catch(() => undefined)
      })
    }
    return completion
  }

  private async persistCurrent(): Promise<void> {
    const targetVersion = this.changeVersion
    const text = `${JSON.stringify(this.data, null, 2)}\n`
    try {
      const directory = dirname(this.filePath)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporary, this.filePath)
      } finally {
        try { await unlink(temporary) } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error }
      }
      if (!this.corruptBackupCreated) this.status = 'ok'
    } catch {
      this.status = 'degraded'
    } finally {
      for (let index = this.persistenceWaiters.length - 1; index >= 0; index -= 1) {
        if (this.persistenceWaiters[index]!.version <= targetVersion) {
          this.persistenceWaiters[index]!.resolve()
          this.persistenceWaiters.splice(index, 1)
        }
      }
    }
  }
}

function defaultWebhookStorePath(): string {
  const configured = process.env.CODINGNS4DSH_STATE_DIR?.trim()
  const stateDirectory = configured || join(homedir(), '.config', 'codingns4dsh')
  return join(stateDirectory, 'workspace-mcp-webhooks.json')
}

function emptyStoreData(): MutableStoreData {
  return { version: 1, destinations: [], deliveries: [], dedupeKeys: [], diagnostics: { droppedFinishedDeliveries: 0, droppedPendingDeliveries: 0 } }
}

function isStoreData(value: unknown): value is MutableStoreData {
  const row = asRecord(value)
  if (row?.version !== 1 || !Array.isArray(row.destinations) || !row.destinations.every(isDestination)) return false
  if (!Array.isArray(row.deliveries) || !row.deliveries.every(isDelivery)) return false
  if (row.dedupeKeys !== undefined && (!Array.isArray(row.dedupeKeys) || !row.dedupeKeys.every((key) => typeof key === 'string'))) return false
  const diagnostics = asRecord(row.diagnostics)
  return diagnostics === null || diagnostics === undefined
    || (diagnostics.droppedFinishedDeliveries === undefined
      || Number.isSafeInteger(diagnostics.droppedFinishedDeliveries) && Number(diagnostics.droppedFinishedDeliveries) >= 0)
      && (diagnostics.droppedPendingDeliveries === undefined
        || Number.isSafeInteger(diagnostics.droppedPendingDeliveries) && Number(diagnostics.droppedPendingDeliveries) >= 0)
}

function isDestination(value: unknown): value is WorkspaceMcpWebhookDestination {
  const row = asRecord(value)
  return row !== null
    && typeof row.id === 'string' && typeof row.name === 'string'
    && typeof row.url === 'string' && typeof row.secret === 'string'
    && typeof row.enabled === 'boolean'
    && (row.workspaceIds === null || Array.isArray(row.workspaceIds) && row.workspaceIds.every((id) => typeof id === 'string'))
    && Array.isArray(row.eventTypes) && row.eventTypes.every((type) => typeof type === 'string' && EVENT_TYPES.has(type as WorkspaceMcpWebhookEventType))
    && typeof row.includeLastMessage === 'boolean'
    && typeof row.createdAt === 'string' && typeof row.updatedAt === 'string'
}

function isDelivery(value: unknown): value is WorkspaceMcpWebhookDelivery {
  const row = asRecord(value)
  const snapshot = asRecord(row?.destinationSnapshot)
  return row !== null
    && typeof row.deliveryId === 'string' && typeof row.eventId === 'string'
    && typeof row.dedupeKey === 'string'
    && typeof row.eventType === 'string' && EVENT_TYPES.has(row.eventType as WorkspaceMcpWebhookEventType)
    && typeof row.destinationId === 'string' && typeof row.destinationName === 'string'
    && snapshot !== null && typeof snapshot.url === 'string' && typeof snapshot.secret === 'string'
    && typeof snapshot.includeLastMessage === 'boolean'
    && ['pending', 'sending', 'delivered', 'failed'].includes(String(row.status))
    && Number.isSafeInteger(row.attempts) && Number(row.attempts) >= 0
    && Number.isFinite(row.nextAttemptAt)
    && (row.lastError === null || typeof row.lastError === 'string')
    && typeof row.body === 'string' && typeof row.createdAt === 'string'
    && (row.finishedAt === null || typeof row.finishedAt === 'string')
}

function isFinished(status: WorkspaceMcpWebhookDeliveryStatus): boolean {
  return status === 'delivered' || status === 'failed'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}

type MutableStoreData = {
  version: 1
  destinations: WorkspaceMcpWebhookDestination[]
  deliveries: WorkspaceMcpWebhookDelivery[]
  dedupeKeys: string[]
  diagnostics: { droppedFinishedDeliveries: number; droppedPendingDeliveries: number }
}
