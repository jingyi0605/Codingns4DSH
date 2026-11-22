import { createHash } from 'node:crypto'

export interface DshWriteLeaseHandle {
  release(): Promise<void>
}

export interface DshPersistenceLocationAdapter {
  readonly persistence: DshSessionPersistenceLike
  readonly root: string
}

export interface DshSessionPersistenceSnapshotLike {
  readonly header: DshSessionHeaderLike
  readonly formatStatus?: 'current' | 'migration-required'
  readonly revision: string
  readonly eventCount?: number
  readonly sizeBytes?: number
  readonly location?: { readonly kind: string; readonly path: string }
}

export interface DshSessionHeaderLike {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

export interface DshSessionPersistenceLike {
  readonly root: string
  readonly compression?: 'zstd' | 'none'
  stat(id: string, options?: { readonly signal?: AbortSignal }): Promise<DshSessionPersistenceSnapshotLike | undefined>
  list(options?: { readonly signal?: AbortSignal }): Promise<readonly DshSessionPersistenceSnapshotLike[]>
  open(id: string, access: 'read' | 'write', options?: { readonly signal?: AbortSignal }): Promise<unknown>
  create(header: unknown, options?: unknown): Promise<unknown>
  hasPendingSession?(id: string): boolean
  acquireWriteLease?(header: DshSessionHeaderLike): Promise<DshWriteLeaseHandle>
}

export interface DshWorkspaceEntityLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  detachSession(sessionId: string): Promise<void>
}

export interface DshWorkspaceRegistryLike {
  readonly archivedSessionIds?: readonly string[]
  readonly pinnedSessionIds?: readonly string[]
  list(): readonly DshWorkspaceEntityLike[]
  unarchiveSession(sessionId: string): Promise<void>
  unpinSession(sessionId: string): Promise<void>
}

export interface DshProjectionCacheTableLike {
  get?(key: string): unknown
  has?(key: string): boolean
  delete(key: string): Promise<boolean>
}

export interface DshStorageDomainFacilityLike {
  get(name: string): { table?(name: string): DshProjectionCacheTableLike | undefined } | undefined
}

export interface DshSpillStoreLike {
  readonly root: string
}

export interface DshSessionQueryLike {
  searchEvents(request: { readonly sessionId: string; readonly query: string }, exec?: { readonly signal?: AbortSignal }): Promise<unknown>
  searchSessions(
    request: {
      readonly query: string
      readonly sessionFilters?: readonly { readonly kind: 'id'; readonly values: readonly string[] }[]
    },
    exec?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly items: readonly unknown[] }>
}

export interface DshImmediateDeletionAdapter extends DshPersistenceLocationAdapter {
  readonly crossProcessLockSupported: boolean
  readonly exclusiveDeploymentVerified: boolean
}

export interface DshRestartReplayAdapter extends DshImmediateDeletionAdapter {}

export function supportsPersistenceLocation(context: unknown): boolean {
  return readPersistenceLocationAdapter(context) !== undefined
}

export function readPersistenceLocationAdapter(context: unknown): DshPersistenceLocationAdapter | undefined {
  const persistence = readService(context, 'sessionPersistence')
  if (!isObject(persistence)) return undefined
  if (
    typeof persistence.root !== 'string'
    || persistence.root.trim() === ''
    || typeof persistence.stat !== 'function'
    || typeof persistence.list !== 'function'
    || typeof persistence.open !== 'function'
    || typeof persistence.create !== 'function'
  ) {
    return undefined
  }
  return {
    persistence: persistence as unknown as DshSessionPersistenceLike,
    root: persistence.root,
  }
}

export function supportsImmediateSessionDeletion(context: unknown): boolean {
  return readImmediateDeletionAdapter(context) !== undefined
}

export function readImmediateDeletionAdapter(context: unknown): DshImmediateDeletionAdapter | undefined {
  const base = readPersistenceLocationAdapter(context)
  if (base === undefined) return undefined
  const crossProcessLockSupported = typeof base.persistence.acquireWriteLease === 'function'
  const exclusiveDeploymentVerified = readExclusiveDeploymentVerified(context)
  if (!crossProcessLockSupported && !exclusiveDeploymentVerified) return undefined
  return {
    ...base,
    crossProcessLockSupported,
    exclusiveDeploymentVerified,
  }
}

export function supportsRestartSessionDeletionReplay(context: unknown): boolean {
  return readRestartReplayAdapter(context) !== undefined
}

export function readRestartReplayAdapter(context: unknown): DshRestartReplayAdapter | undefined {
  return readImmediateDeletionAdapter(context)
}

export function supportsWorkspaceDeletionCleanup(context: unknown): boolean {
  return readWorkspaceCleanupAdapter(context) !== undefined
}

export function readWorkspaceCleanupAdapter(context: unknown): DshWorkspaceRegistryLike | undefined {
  const registry = readService(context, 'workspaceRegistry')
  if (!isObject(registry)) return undefined
  if (
    typeof registry.list !== 'function'
    || typeof registry.unarchiveSession !== 'function'
    || typeof registry.unpinSession !== 'function'
  ) {
    return undefined
  }
  return registry as unknown as DshWorkspaceRegistryLike
}

export function supportsProjectionDeletionCleanup(context: unknown): boolean {
  return readProjectionCleanupAdapter(context) !== undefined
}

export function readProjectionCleanupAdapter(context: unknown): DshStorageDomainFacilityLike | undefined {
  const storageDomain = readService(context, 'storageDomain')
  if (!isObject(storageDomain) || typeof storageDomain.get !== 'function') return undefined
  return storageDomain as unknown as DshStorageDomainFacilityLike
}

export function supportsSpillDeletionCleanup(context: unknown): boolean {
  return readSpillCleanupAdapter(context) !== undefined
}

export function readSpillCleanupAdapter(context: unknown): DshSpillStoreLike | undefined {
  const spillStore = readService(context, 'spillStore')
  if (!isObject(spillStore) || typeof spillStore.root !== 'string' || spillStore.root.trim() === '') return undefined
  return spillStore as unknown as DshSpillStoreLike
}

export function spillSessionDirName(sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return `session-${hash}`
}

export function supportsSearchIndexReconciliation(context: unknown): boolean {
  return readSearchIndexReconcileAdapter(context) !== undefined
}

export function readSearchIndexReconcileAdapter(context: unknown): DshSessionQueryLike | undefined {
  const sessionQuery = readService(context, 'sessionQuery')
  if (!isObject(sessionQuery)) return undefined
  if (typeof sessionQuery.searchEvents !== 'function' || typeof sessionQuery.searchSessions !== 'function') {
    return undefined
  }
  return sessionQuery as unknown as DshSessionQueryLike
}

export function readExclusiveDeploymentVerified(context: unknown): boolean {
  const explicit = readService(context, 'codingnsExclusiveDeployment')
  return explicit === true
}

export function readService(context: unknown, name: string): unknown {
  if (!isObject(context)) return undefined
  const getter = Reflect.get(context, 'get')
  if (typeof getter === 'function') {
    try {
      const value = getter.call(context, name)
      if (value !== undefined) return value
    } catch {
      // Fall through to plain property lookup for test fakes.
    }
  }
  try {
    return Reflect.get(context, name)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
