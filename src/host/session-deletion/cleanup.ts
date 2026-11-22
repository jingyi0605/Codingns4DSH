import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readProjectionCleanupAdapter,
  readSearchIndexReconcileAdapter,
  readService,
  readSpillCleanupAdapter,
  readWorkspaceCleanupAdapter,
  spillSessionDirName,
  type DshSessionPersistenceLike,
} from '../../dsh-capabilities/host/session-deletion-adapter.js'
import {
  SessionDeletionError,
  type SessionDeletionCleanupItem,
  type SessionDeletionStorageSummary,
} from '../../shared/contracts/session-deletion.js'
import { isEnoent } from './target-locator.js'

export interface CleanupExecutionResult {
  readonly completed: readonly SessionDeletionCleanupItem[]
  readonly pending: readonly SessionDeletionCleanupItem[]
  readonly errors: readonly string[]
}

export function inspectAvailableCleanupPlan(input: {
  readonly sessionId: string
  readonly dshContext: unknown
}): {
  readonly items: readonly SessionDeletionCleanupItem[]
  readonly summary: SessionDeletionStorageSummary
} {
  const { sessionId, dshContext } = input
  const items: SessionDeletionCleanupItem[] = []

  const workspaceRegistry = readWorkspaceCleanupAdapter(dshContext)
  let workspaceDetachedNeeded = false
  if (workspaceRegistry !== undefined) {
    items.push('workspace')
    const workspaces = workspaceRegistry.list()
    workspaceDetachedNeeded = workspaces.some((w) => w.sessionIds.includes(sessionId))
      || (workspaceRegistry.archivedSessionIds?.includes(sessionId) ?? false)
      || (workspaceRegistry.pinnedSessionIds?.includes(sessionId) ?? false)
  }

  const storageDomain = readProjectionCleanupAdapter(dshContext)
  const projectionDomainMounted = storageDomain?.get('session_projcache') !== undefined
  const projectionServicePresent = readService(dshContext, 'sessionProjectionCache') !== undefined
  const projectionCacheEnabled = projectionDomainMounted || projectionServicePresent
  if (projectionCacheEnabled) items.push('projection-cache')

  const spillStore = readSpillCleanupAdapter(dshContext)
  const rawSpillService = readService(dshContext, 'spillStore')
  const spillEnabled = spillStore !== undefined || rawSpillService !== undefined
  if (spillEnabled) items.push('spill')

  const sessionQuery = readSearchIndexReconcileAdapter(dshContext)
  const rawQueryService = readService(dshContext, 'sessionQuery')
  const searchEnabled = sessionQuery !== undefined || rawQueryService !== undefined
  if (searchEnabled) items.push('search-index')

  return {
    items,
    summary: {
      logDirKnown: true,
      workspaceDetachedNeeded,
      projectionCacheEnabled,
      spillEnabled,
      searchEnabled,
    },
  }
}

export async function executeDerivedCleanup(input: {
  readonly sessionId: string
  readonly items: readonly SessionDeletionCleanupItem[]
  readonly persistence: DshSessionPersistenceLike
  readonly dshContext: unknown
  readonly onSessionRemoved?: (sessionId: string) => Promise<void> | void
  readonly onWorkspaceDetached?: () => void
  readonly signal?: AbortSignal
}): Promise<CleanupExecutionResult> {
  const { sessionId, items, persistence, dshContext, onSessionRemoved, onWorkspaceDetached, signal } = input

  // Verify the log is genuinely gone and no replacement session with the same ID exists.
  const currentStat = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
  if (currentStat !== undefined || persistence.hasPendingSession?.(sessionId) === true) {
    throw new SessionDeletionError(
      'SESSION_DELETION_TARGET_CHANGED',
      `Refusing cleanup because session "${sessionId}" is present again in persistence`,
    )
  }
  const sessions = readService(dshContext, 'sessions') as { get?(id: string): unknown } | undefined
  if (typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined) {
    throw new SessionDeletionError(
      'SESSION_DELETION_TARGET_CHANGED',
      `Refusing cleanup because a live session "${sessionId}" exists`,
    )
  }

  const completed: SessionDeletionCleanupItem[] = []
  const pending: SessionDeletionCleanupItem[] = []
  const errors: string[] = []

  for (const item of items) {
    try {
      await runCleanupItem(item, sessionId, dshContext, signal)
      completed.push(item)
      if (item === 'workspace') onWorkspaceDetached?.()
    } catch (error) {
      pending.push(item)
      errors.push(`${item}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (onSessionRemoved !== undefined) {
    await onSessionRemoved(sessionId)
  }

  return { completed, pending, errors }
}

async function runCleanupItem(
  item: SessionDeletionCleanupItem,
  sessionId: string,
  dshContext: unknown,
  signal?: AbortSignal,
): Promise<void> {
  switch (item) {
    case 'workspace':
      await cleanupWorkspaceRegistry(sessionId, dshContext)
      return
    case 'projection-cache':
      await cleanupProjectionCache(sessionId, dshContext)
      return
    case 'spill':
      await cleanupSessionSpill(sessionId, dshContext)
      return
    case 'search-index':
      await reconcileSearchIndex(sessionId, dshContext, signal)
      return
  }
}

async function cleanupWorkspaceRegistry(sessionId: string, dshContext: unknown): Promise<void> {
  const registry = readWorkspaceCleanupAdapter(dshContext)
  if (registry === undefined) {
    if (readService(dshContext, 'workspaceRegistry') === undefined) return
    throw new Error('workspaceRegistry does not support required cleanup methods')
  }
  for (const workspace of registry.list()) {
    await workspace.detachSession(sessionId)
  }
  await registry.unarchiveSession(sessionId)
  await registry.unpinSession(sessionId)

  // Verify accounting is clear after mutations.
  const remainingMember = registry.list().some((workspace) => workspace.sessionIds.includes(sessionId))
  const remainingArchived = registry.archivedSessionIds?.includes(sessionId) ?? false
  const remainingPinned = registry.pinnedSessionIds?.includes(sessionId) ?? false
  if (remainingMember || remainingArchived || remainingPinned) {
    throw new Error(`workspace registry still retains references to session "${sessionId}"`)
  }
}

async function cleanupProjectionCache(sessionId: string, dshContext: unknown): Promise<void> {
  const storageDomain = readProjectionCleanupAdapter(dshContext)
  const cacheServicePresent = readService(dshContext, 'sessionProjectionCache') !== undefined
  if (storageDomain === undefined) {
    if (!cacheServicePresent) return
    throw new Error('storageDomain is unavailable to clean session_projcache')
  }
  const domain = storageDomain.get('session_projcache')
  if (domain === undefined) {
    if (!cacheServicePresent) return
    throw new Error('session_projcache domain is not mounted')
  }
  const table = domain.table?.('sessions')
  if (table === undefined || typeof table.delete !== 'function') {
    throw new Error('session_projcache sessions table is missing delete()')
  }
  await table.delete(sessionId)
  if (table.has?.(sessionId) === true || table.get?.(sessionId) !== undefined) {
    throw new Error(`session_projcache still contains entry for "${sessionId}"`)
  }
}

async function cleanupSessionSpill(sessionId: string, dshContext: unknown): Promise<void> {
  const spillStore = readSpillCleanupAdapter(dshContext)
  if (spillStore === undefined) {
    if (readService(dshContext, 'spillStore') === undefined) return
    throw new Error('spillStore does not expose a verifiable local root')
  }
  let rootStat
  try {
    rootStat = await lstat(spillStore.root)
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('spill root is not a real directory')
  }
  const realSpillRoot = await realpath(spillStore.root)
  const sessionSpillDir = join(realSpillRoot, spillSessionDirName(sessionId))
  let dirStat
  try {
    dirStat = await lstat(sessionSpillDir)
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('session spill directory is unsafe or not a directory')
  }
  const realDir = await realpath(sessionSpillDir)
  if (realDir !== sessionSpillDir) {
    throw new Error('session spill directory resolved through an unexpected alias')
  }
  const entries = await readdir(realDir, { withFileTypes: true })
  for (const entry of entries) {
    const entryStat = await lstat(join(realDir, entry.name))
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
      throw new Error(`unexpected spill entry "${entry.name}" inside session spill directory`)
    }
  }
  await rm(realDir, { recursive: true, force: true })
  try {
    await lstat(realDir)
    throw new Error('session spill directory still exists after removal')
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
}

async function reconcileSearchIndex(
  sessionId: string,
  dshContext: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const sessionQuery = readSearchIndexReconcileAdapter(dshContext)
  if (sessionQuery === undefined) {
    if (readService(dshContext, 'sessionQuery') === undefined) return
    throw new Error('sessionQuery does not expose search reconciliation methods')
  }
  const exec = signal === undefined ? undefined : { signal }
  let eventFound = false
  try {
    await sessionQuery.searchEvents({ sessionId, query: 'a' }, exec)
    eventFound = true
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'SESSION_QUERY_SEARCH_DISABLED') return
    if (code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
  }
  if (eventFound) {
    throw new Error(`search index still resolves session "${sessionId}"`)
  }
  const verifyPage = await sessionQuery.searchSessions(
    { query: 'a', sessionFilters: [{ kind: 'id', values: [sessionId] }] },
    exec,
  )
  if (Array.isArray(verifyPage?.items) && verifyPage.items.length > 0) {
    throw new Error(`searchSessions still returns hits for "${sessionId}"`)
  }
}
