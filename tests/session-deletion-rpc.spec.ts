import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createSessionDeletionFeature } from '../src/host/features/session-deletion.js'
import { FeatureResourceScopeImpl } from '../src/features/registry.js'
import { deriveJsonlProjectKey, encodeJsonlSegment } from '../src/host/session-deletion/target-locator.js'
import { SessionDeletionService } from '../src/host/session-deletion/service.js'
import { createVirtualSessionId } from '../src/shared/contracts/peer-host.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'

const cleanups: string[] = []
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

function makeTempFixture(sessionId = 'session-1', options: { withLiveSession?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'codingns-sd-rpc-'))
  cleanups.push(base)
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  const cwd = join(base, 'project')
  mkdirSync(cwd, { recursive: true })
  const sessionDir = join(root, deriveJsonlProjectKey(cwd), encodeJsonlSegment(sessionId))
  mkdirSync(sessionDir, { recursive: true })
  const logPath = join(sessionDir, 'session.jsonl')
  writeFileSync(logPath, `${JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0 })}\n`)

  const liveSessions = new Map<string, unknown>()
  if (options.withLiveSession) liveSessions.set(sessionId, { id: sessionId, header: { id: sessionId, version: 4, createdAt: 1000, cwd, isSeeded: false } })

  const header = { version: 4, id: sessionId, createdAt: 1000, cwd, isSeeded: false }
  const persistence = {
    root,
    async stat(id: string) {
      if (id !== sessionId) return undefined
      try {
        const { statSync } = await import('node:fs')
        statSync(logPath)
        return { header, revision: 'rev-1', location: { kind: 'jsonl', path: logPath } }
      } catch {
        return undefined
      }
    },
    async list() {
      const s = await this.stat(sessionId)
      return s === undefined ? [] : [s]
    },
    async open() { return { async close() {} } },
    async create() { return { async close() {} } },
    async acquireWriteLease() { return { async release() {} } },
  }

  const connection = {
    browserPeer: { principal: { kind: 'owner', id: 'owner-1' } },
  }
  const dshContext = {
    connection,
    sessionPersistence: persistence,
    sessions: {
      get: (id: string) => liveSessions.get(id),
      list: () => [...liveSessions.values()],
    },
  }
  return { base, root, stateDir, dshContext, connection, liveSessions }
}

test('RPC enforces local owner authorization and rejects non-owner, non-local, virtual, and invalid IDs', async () => {
  const fixture = makeTempFixture('session-auth')
  const rpc = new CodingNsRpcTable()
  const resources = new FeatureResourceScopeImpl()
  const feature = createSessionDeletionFeature({
    stateDirectory: fixture.stateDir,
    replayOnStartup: false,
    enforceSettingsToggle: false,
  })
  await feature.start({
    descriptor: feature.descriptor,
    resources,
    services: { rpc, dshContext: fixture.dshContext, dshVersion: '0.2.3-alpha.1' },
  })
  const target = rpc.resolve('sessionDeletion/prepare')!

  const ownerPeer = { principal: { kind: 'owner', id: 'owner-1' } }
  const guestPeer = { principal: { kind: 'guest', id: 'guest-1' } }

  await assert.rejects(
    () => target.handler(target.action, { sessionId: 'session-auth' }, { peer: guestPeer, localRequest: true }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_FORBIDDEN',
  )
  await assert.rejects(
    () => target.handler(target.action, { sessionId: 'session-auth' }, { peer: ownerPeer, localRequest: false }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_LOCAL_OWNER_REQUIRED',
  )
  await assert.rejects(
    () => target.handler(target.action, { sessionId: createVirtualSessionId('peer-1', 'session-auth') }, { peer: ownerPeer, localRequest: true }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_VIRTUAL_SESSION_UNSUPPORTED',
  )
  await assert.rejects(
    () => target.handler(target.action, { sessionId: '../bad' }, { peer: ownerPeer, localRequest: true }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_INVALID_SESSION_ID',
  )

  const ok = await target.handler(target.action, { sessionId: 'session-auth' }, { peer: ownerPeer, localRequest: true }) as { mode: string }
  assert.equal(ok.mode, 'immediate')
  await resources.dispose()
})

test('tokens reject cross-caller, cross-instance, expired, and duplicate commits', async () => {
  const fixture = makeTempFixture('session-token')
  let clock = 10_000
  const service = new SessionDeletionService({
    dshContext: fixture.dshContext,
    stateDirectory: fixture.stateDir,
    now: () => clock,
    tokenTtlMs: 1_000,
  })
  await service.initialize({ replayOnStartup: false })

  const prep = await service.prepare('principal:owner-1', { sessionId: 'session-token' })
  assert.equal(prep.mode, 'immediate')
  assert.ok(prep.operationId)

  await assert.rejects(
    () => service.commit('principal:owner-2', { operationId: prep.operationId!, mode: 'immediate' }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_FORBIDDEN',
  )

  clock = 20_000
  await assert.rejects(
    () => service.commit('principal:owner-1', { operationId: prep.operationId!, mode: 'immediate' }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_TOKEN_EXPIRED',
  )

  const prep2 = await service.prepare('principal:owner-1', { sessionId: 'session-token' })
  const service2 = new SessionDeletionService({ dshContext: fixture.dshContext, stateDirectory: fixture.stateDir })
  await service2.initialize({ replayOnStartup: false })
  await assert.rejects(
    () => service2.commit('principal:owner-1', { operationId: prep2.operationId!, mode: 'immediate' }),
    (err: { code?: string }) =>
      err.code === 'SESSION_DELETION_TOKEN_INVALID' || err.code === 'SESSION_DELETION_TOKEN_MISMATCH',
  )

  const committed = await service.commit('principal:owner-1', { operationId: prep2.operationId!, mode: 'immediate' })
  assert.equal(committed.status, 'deleted')

  // Network retry with same operationId after deletion must NOT re-execute or fail unexpectedly.
  const retry = await service.commit('principal:owner-1', { operationId: prep2.operationId!, mode: 'immediate' })
  assert.equal(retry.status, 'deleted')

  const status = await service.status('principal:owner-1', { operationId: prep2.operationId! })
  assert.equal(status.status, 'deleted')
  service.dispose()
  service2.dispose()
})

test('restart-required queuing moves session to archive and unarchives only when queued-by-deletion is cancelled', async () => {
  const fixture = makeTempFixture('session-queue', { withLiveSession: true })
  const archivedSet = new Set<string>()
  ;(fixture.dshContext as Record<string, unknown>).workspaceRegistry = {
    list: () => [],
    get archivedSessionIds() { return [...archivedSet] },
    async archiveSession(id: string) { archivedSet.add(id) },
    async unarchiveSession(id: string) { archivedSet.delete(id) },
    async unpinSession() {},
  }
  const service = new SessionDeletionService({
    dshContext: fixture.dshContext,
    stateDirectory: fixture.stateDir,
  })
  await service.initialize({ replayOnStartup: false })

  const prep = await service.prepare('principal:owner-1', { sessionId: 'session-queue' })
  assert.equal(prep.mode, 'restart-required')
  assert.ok(prep.operationId)

  const queued = await service.commit('principal:owner-1', { operationId: prep.operationId!, mode: 'restart-required' })
  assert.equal(queued.status, 'queued')
  assert.equal(queued.archived, true)
  assert.equal(archivedSet.has('session-queue'), true)

  // Second prepare on same session must be blocked and expose existingOperation instead of issuing a new token.
  const secondPrep = await service.prepare('principal:owner-1', { sessionId: 'session-queue' })
  assert.equal(secondPrep.mode, 'unsupported')
  assert.equal(secondPrep.reasonCode, 'SESSION_DELETION_ALREADY_PENDING')
  assert.equal(secondPrep.operationId, undefined)
  assert.equal(secondPrep.existingOperation?.status, 'queued')
  assert.equal(secondPrep.existingOperation?.cancellable, true)
  assert.equal(secondPrep.existingOperation?.archived, true)

  // Status query & active list from fresh service instance after disconnect/reload.
  const reconnected = new SessionDeletionService({ dshContext: fixture.dshContext, stateDirectory: fixture.stateDir })
  const listedOwner = await reconnected.list('principal:owner-1')
  assert.equal(listedOwner.length, 1)
  assert.equal(listedOwner[0]?.sessionId, 'session-queue')
  assert.equal(listedOwner[0]?.archived, true)
  assert.equal((await reconnected.list('principal:owner-2')).length, 0)
  const queried = await reconnected.status('principal:owner-1', { sessionId: 'session-queue' })
  assert.equal(queried.status, 'queued')
  assert.equal(queried.cancellable, true)

  // Cancel works while queued and unarchives because deletion moved it into archive.
  const cancelled = await reconnected.cancel('principal:owner-1', { operationId: prep.operationId! })
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.unarchived, true)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(archivedSet.has('session-queue'), false)
  assert.equal((await reconnected.list('principal:owner-1')).length, 0)

  // If user had already archived the session manually beforehand, cancelling deletion preserves archive state.
  archivedSet.add('session-queue')
  const prepPreArchived = await service.prepare('principal:owner-1', { sessionId: 'session-queue' })
  const queuedPreArchived = await service.commit('principal:owner-1', { operationId: prepPreArchived.operationId!, mode: 'restart-required' })
  assert.equal(queuedPreArchived.status, 'queued')
  assert.equal(queuedPreArchived.archived, undefined)
  const cancelledPreArchived = await service.cancel('principal:owner-1', { operationId: prepPreArchived.operationId! })
  assert.equal(cancelledPreArchived.cancelled, true)
  assert.equal(cancelledPreArchived.unarchived, undefined)
  assert.equal(archivedSet.has('session-queue'), true)

  const cancelAgain = await reconnected.cancel('principal:owner-1', { operationId: prep.operationId! })
  assert.equal(cancelAgain.cancelled, false)

  // Active turn/subagent activity blocking plain archiveSession falls back to { stopActivity: true }.
  const fixtureActive = makeTempFixture('session-queue-active', { withLiveSession: true })
  const activeArchivedSet = new Set<string>()
  const archiveCalls: Array<{ id: string; stopActivity?: boolean }> = []
  ;(fixtureActive.dshContext as Record<string, unknown>).workspaceRegistry = {
    list: () => [],
    get archivedSessionIds() { return [...activeArchivedSet] },
    async archiveSession(id: string, opts?: { readonly stopActivity?: boolean }) {
      archiveCalls.push({ id, ...(opts?.stopActivity !== undefined ? { stopActivity: opts.stopActivity } : {}) })
      if (opts?.stopActivity !== true) {
        const err = new Error('Active work prevents archiving')
        err.name = 'WorkspaceActiveSessionError'
        throw err
      }
      activeArchivedSet.add(id)
    },
    async unarchiveSession(id: string) { activeArchivedSet.delete(id) },
    async unpinSession() {},
  }
  const activeService = new SessionDeletionService({
    dshContext: fixtureActive.dshContext,
    stateDirectory: fixtureActive.stateDir,
  })
  await activeService.initialize({ replayOnStartup: false })
  const activePrep = await activeService.prepare('principal:owner-1', { sessionId: 'session-queue-active' })
  assert.equal(activePrep.mode, 'restart-required')
  const activeQueued = await activeService.commit('principal:owner-1', { operationId: activePrep.operationId!, mode: 'restart-required' })
  assert.equal(activeQueued.status, 'queued')
  assert.equal(activeQueued.archived, true)
  assert.equal(activeArchivedSet.has('session-queue-active'), true)
  assert.deepEqual(archiveCalls, [
    { id: 'session-queue-active' },
    { id: 'session-queue-active', stopActivity: true },
  ])
  const idempotentQueued = await activeService.commit('principal:owner-1', { operationId: activePrep.operationId!, mode: 'restart-required' })
  assert.equal(idempotentQueued.status, 'queued')
  assert.equal(idempotentQueued.archived, true)
  activeService.dispose()
  assert.equal(cancelAgain.code, 'SESSION_DELETION_NOT_CANCELLABLE')

  // Verify feature toggle disabled blocks prepare by default.
  const rpc = new CodingNsRpcTable()
  const resources = new FeatureResourceScopeImpl()
  const feature = createSessionDeletionFeature({ stateDirectory: fixture.stateDir, replayOnStartup: false })
  await feature.start({
    descriptor: feature.descriptor,
    resources,
    services: {
      rpc,
      dshContext: fixture.dshContext,
      dshVersion: '0.2.3-alpha.1',
      settings: {
        get: () => structuredClone(DEFAULT_CODINGNS_SETTINGS),
        update: async () => undefined,
        watch: () => () => undefined,
      },
    },
  })
  const prepDisabled = rpc.resolve('sessionDeletion/prepare')!
  await assert.rejects(
    () => prepDisabled.handler(prepDisabled.action, { sessionId: 'session-queue' }, {
      peer: { principal: { kind: 'owner', id: 'owner-1' } },
      localRequest: true,
    }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_FEATURE_DISABLED',
  )
  await resources.dispose()
  service.dispose()
})

test('background immediate commit returns deleting immediately, blocks duplicate prepares, and completes asynchronously', async () => {
  const fixture = makeTempFixture('session-bg-rpc')
  let releaseQuery!: () => void
  const queryBlocked = new Promise<void>((resolve) => { releaseQuery = resolve })
  let nativeRemoved: string | undefined
  ;(fixture.dshContext as Record<string, unknown>).workspaceRegistry = {
    list: () => [],
    async unarchiveSession() {},
    async unpinSession() {},
  }
  ;(fixture.dshContext as Record<string, unknown>).sessionQuery = {
    async searchEvents() {
      await queryBlocked
      const err = new Error('not found') as Error & { code?: string }
      err.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
      throw err
    },
    async searchSessions() { return { items: [] } },
  }

  const service = new SessionDeletionService({
    dshContext: fixture.dshContext,
    stateDirectory: fixture.stateDir,
    emitNativeRemoved: (id) => { nativeRemoved = id },
  })
  await service.initialize({ replayOnStartup: false })

  const prep = await service.prepare('principal:owner-1', { sessionId: 'session-bg-rpc' })
  assert.equal(prep.mode, 'immediate')

  const started = await service.commit('principal:owner-1', {
    operationId: prep.operationId!,
    mode: 'immediate',
    background: true,
  })
  assert.equal(started.status, 'deleting')

  // While slow search reconcile runs in background, list/status show deleting and duplicate prepare is refused.
  const activeList = await service.list('principal:owner-1')
  assert.equal(activeList.some((item) => item.operationId === prep.operationId && item.status === 'deleting'), true)

  const midStatus = await service.status('principal:owner-1', { operationId: prep.operationId! })
  assert.equal(midStatus.status, 'deleting')

  const dupPrep = await service.prepare('principal:owner-1', { sessionId: 'session-bg-rpc' })
  assert.equal(dupPrep.mode, 'unsupported')
  assert.equal(dupPrep.reasonCode, 'SESSION_DELETION_ALREADY_PENDING')

  // Allow slow FTS reconcile to finish and poll until background operation settles.
  releaseQuery()
  let finalStatus = await service.status('principal:owner-1', { operationId: prep.operationId! })
  for (let i = 0; i < 40 && finalStatus.status === 'deleting'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15))
    finalStatus = await service.status('principal:owner-1', { operationId: prep.operationId! })
  }
  assert.equal(finalStatus.status, 'deleted')
  assert.equal(nativeRemoved, 'session-bg-rpc')
  service.dispose()
})
