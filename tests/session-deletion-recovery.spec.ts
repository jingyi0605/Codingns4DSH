import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileSessionDeletionStore, type PersistedDeletionRecord } from '../src/host/session-deletion/store.js'
import { SessionDeletionService } from '../src/host/session-deletion/service.js'
import { deriveJsonlProjectKey, encodeJsonlSegment } from '../src/host/session-deletion/target-locator.js'

const cleanups: string[] = []
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

function setupEnv(prefix: string) {
  const base = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(base)
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  const stagingRoot = join(stateDir, 'session-deletion-staging')
  const cwd = join(base, 'project')
  mkdirSync(root, { recursive: true })
  mkdirSync(stagingRoot, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const realRoot = realpathSync(root)
  const rootStat = lstatSync(root)
  return { base, root, realRoot, rootStat, stateDir, stagingRoot, cwd }
}

test('startup replay handles queued with legal append, crash after move, crash after staging clear, and replacement safety', async () => {
  const env = setupEnv('codingns-sd-rec-')
  const store = new FileSessionDeletionStore(env.stateDir)

  // Case 1: queued session with legal append (revision changed, createdAt/cwd unchanged) -> safely deleted on startup.
  const id1 = 'session-legal-append'
  const dir1 = join(env.realRoot, deriveJsonlProjectKey(env.cwd), encodeJsonlSegment(id1))
  mkdirSync(dir1, { recursive: true })
  const log1 = join(dir1, 'session.jsonl')
  writeFileSync(log1, '{"type":"session"}\n{"type":"user/message"}\n')
  await store.writeRecord({
    operationId: 'op-rec-1',
    sessionId: id1,
    callerKey: 'owner',
    mode: 'restart-required',
    phase: 'queued',
    identity: { id: id1, createdAt: 1000, cwd: env.cwd, version: 4, isSeeded: false },
    backend: { kind: 'jsonl', root: env.realRoot, rootDev: String(env.rootStat.dev), rootIno: String(env.rootStat.ino) },
    paths: { sessionDir: dir1, stagingDir: join(env.stagingRoot, 'op-rec-1') },
    requestedAt: 100,
    updatedAt: 100,
    pendingCleanupItems: ['workspace'],
    completedCleanupItems: [],
  })

  // Case 2: crashed after move to staging (committing -> original gone, staging still exists) -> completes staging removal & cleanup.
  const id2 = 'session-moved-crash'
  const dir2 = join(env.realRoot, deriveJsonlProjectKey(env.cwd), encodeJsonlSegment(id2))
  const staging2 = join(env.stagingRoot, 'op-rec-2')
  mkdirSync(staging2, { recursive: true })
  writeFileSync(join(staging2, 'session.jsonl'), '{}\n')
  await store.writeRecord({
    operationId: 'op-rec-2',
    sessionId: id2,
    callerKey: 'owner',
    mode: 'immediate',
    phase: 'committing',
    identity: { id: id2, createdAt: 2000, cwd: env.cwd, version: 4, isSeeded: false },
    backend: { kind: 'jsonl', root: env.realRoot, rootDev: String(env.rootStat.dev), rootIno: String(env.rootStat.ino) },
    paths: { sessionDir: dir2, stagingDir: staging2 },
    requestedAt: 100,
    updatedAt: 100,
    pendingCleanupItems: ['workspace'],
    completedCleanupItems: [],
  })

  // Case 3: replacement session reusing same ID after original log-removed -> must NOT delete replacement session or clean its workspace!
  const id3 = 'session-replaced'
  const dir3 = join(env.realRoot, deriveJsonlProjectKey(env.cwd), encodeJsonlSegment(id3))
  mkdirSync(dir3, { recursive: true })
  const log3 = join(dir3, 'session.jsonl')
  writeFileSync(log3, '{"type":"session"}\n')
  await store.writeRecord({
    operationId: 'op-rec-3',
    sessionId: id3,
    callerKey: 'owner',
    mode: 'immediate',
    phase: 'cleanup-pending',
    identity: { id: id3, createdAt: 3000, cwd: env.cwd, version: 4, isSeeded: false },
    backend: { kind: 'jsonl', root: env.realRoot, rootDev: String(env.rootStat.dev), rootIno: String(env.rootStat.ino) },
    paths: { sessionDir: dir3, stagingDir: join(env.stagingRoot, 'op-rec-3') },
    requestedAt: 100,
    updatedAt: 100,
    pendingCleanupItems: ['workspace'],
    completedCleanupItems: [],
  })

  // Case 4: cancelled intent -> never triggers deletion.
  const id4 = 'session-cancelled'
  const dir4 = join(env.realRoot, deriveJsonlProjectKey(env.cwd), encodeJsonlSegment(id4))
  mkdirSync(dir4, { recursive: true })
  const log4 = join(dir4, 'session.jsonl')
  writeFileSync(log4, '{}\n')
  await store.writeRecord({
    operationId: 'op-rec-4',
    sessionId: id4,
    callerKey: 'owner',
    mode: 'restart-required',
    phase: 'cancelled',
    identity: { id: id4, createdAt: 4000, cwd: env.cwd, version: 4, isSeeded: false },
    backend: { kind: 'jsonl', root: env.realRoot, rootDev: String(env.rootStat.dev), rootIno: String(env.rootStat.ino) },
    paths: { sessionDir: dir4, stagingDir: join(env.stagingRoot, 'op-rec-4') },
    requestedAt: 100,
    updatedAt: 100,
    pendingCleanupItems: ['workspace'],
    completedCleanupItems: [],
  })

  const detachedIds: string[] = []
  const workspaceMembers = new Set([id1, id2, id3, id4])
  const persistence = {
    root: env.root,
    async stat(id: string) {
      if (id === id1 && existsSync(log1)) {
        return { header: { version: 4, id: id1, createdAt: 1000, cwd: env.cwd, isSeeded: false }, revision: 'rev-appended', location: { kind: 'jsonl', path: log1 } }
      }
      if (id === id3 && existsSync(log3)) {
        // Replacement session has a newer createdAt (9999 !== 3000).
        return { header: { version: 4, id: id3, createdAt: 9999, cwd: env.cwd, isSeeded: false }, revision: 'rev-new', location: { kind: 'jsonl', path: log3 } }
      }
      if (id === id4 && existsSync(log4)) {
        return { header: { version: 4, id: id4, createdAt: 4000, cwd: env.cwd, isSeeded: false }, revision: 'rev-4', location: { kind: 'jsonl', path: log4 } }
      }
      return undefined
    },
    async list() {
      const items = []
      for (const id of [id1, id2, id3, id4]) {
        const s = await this.stat(id)
        if (s !== undefined) items.push(s)
      }
      return items
    },
    async open() { return { async close() {} } },
    async create() { return { async close() {} } },
    async acquireWriteLease() { return { async release() {} } },
  }

  const service = new SessionDeletionService({
    dshContext: {
      sessionPersistence: persistence,
      sessions: { get: () => undefined, list: () => [] },
      workspaceRegistry: {
        archivedSessionIds: [],
        pinnedSessionIds: [],
        list: () => [{
          id: 'ws-1',
          path: env.cwd,
          title: 'Project',
          get sessionIds() { return [...workspaceMembers] },
          async detachSession(id: string) {
            detachedIds.push(id)
            workspaceMembers.delete(id)
          },
        }],
        async unarchiveSession() {},
        async unpinSession() {},
      },
    },
    stateDirectory: env.stateDir,
  })
  await service.initialize({ replayOnStartup: true })

  assert.equal(existsSync(dir1), false)
  assert.equal(existsSync(staging2), false)
  assert.equal(existsSync(log3), true)
  assert.equal(existsSync(log4), true)

  assert.equal(detachedIds.includes(id1), true)
  assert.equal(detachedIds.includes(id2), true)
  assert.equal(detachedIds.includes(id3), false)
  assert.equal(detachedIds.includes(id4), false)

  assert.equal((await store.readRecord('op-rec-1'))?.phase, 'completed')
  assert.equal((await store.readRecord('op-rec-2'))?.phase, 'completed')
  assert.equal((await store.readRecord('op-rec-3'))?.phase, 'failed')
  assert.equal((await store.readRecord('op-rec-4'))?.phase, 'cancelled')
  service.dispose()
})

test('queued record with replaced session identity at startup refuses deletion and marks failed', async () => {
  const env = setupEnv('codingns-sd-rec-rep-')
  const store = new FileSessionDeletionStore(env.stateDir)
  const id = 'session-reused'
  const dir = join(env.realRoot, deriveJsonlProjectKey(env.cwd), encodeJsonlSegment(id))
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, '{}\n')

  await store.writeRecord({
    operationId: 'op-reused',
    sessionId: id,
    callerKey: 'owner',
    mode: 'restart-required',
    phase: 'queued',
    identity: { id, createdAt: 1000, cwd: env.cwd, version: 4, isSeeded: false },
    backend: { kind: 'jsonl', root: env.realRoot, rootDev: String(env.rootStat.dev), rootIno: String(env.rootStat.ino) },
    paths: { sessionDir: dir, stagingDir: join(env.stagingRoot, 'op-reused') },
    requestedAt: 100,
    updatedAt: 100,
    pendingCleanupItems: [],
    completedCleanupItems: [],
  })

  const service = new SessionDeletionService({
    dshContext: {
      sessionPersistence: {
        root: env.root,
        async stat() {
          return {
            header: { version: 4, id, createdAt: 5555, cwd: env.cwd, isSeeded: false },
            revision: 'rev-new',
            location: { kind: 'jsonl', path: log },
          }
        },
        async list() { return [] },
        async open() { return { async close() {} } },
        async create() { return { async close() {} } },
        async acquireWriteLease() { return { async release() {} } },
      },
      sessions: { get: () => undefined, list: () => [] },
    },
    stateDirectory: env.stateDir,
  })
  await service.initialize({ replayOnStartup: true })

  assert.equal(existsSync(log), true)
  const updated = await store.readRecord('op-reused') as PersistedDeletionRecord
  assert.equal(updated.phase, 'failed')
  assert.equal(updated.lastErrorCode, 'SESSION_DELETION_TARGET_CHANGED')
  service.dispose()
})
