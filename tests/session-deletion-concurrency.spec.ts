import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionDeletionService } from '../src/host/session-deletion/service.js'
import { deriveJsonlProjectKey, encodeJsonlSegment } from '../src/host/session-deletion/target-locator.js'

const cleanups: string[] = []
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

function createSessionDir(root: string, cwd: string, id: string): string {
  const dir = join(root, deriveJsonlProjectKey(cwd), encodeJsonlSegment(id))
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'session.jsonl')
  writeFileSync(log, `${JSON.stringify({ type: 'session', version: 4, id, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0 })}\n`)
  return log
}

test('admission guard waits for in-flight open/create, blocks new admissions & forks, and restores only its own wrapper', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codingns-sd-conc-'))
  cleanups.push(base)
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  const cwd = join(base, 'project')
  mkdirSync(cwd, { recursive: true })
  const logA = createSessionDir(root, cwd, 'session-a')
  const logB = createSessionDir(root, cwd, 'session-b')

  let releaseInFlightOpen!: () => void
  const inFlightGate = new Promise<void>((resolve) => { releaseInFlightOpen = resolve })
  const openLog: string[] = []

  const baseOpen = async (id: string, access: string) => {
    openLog.push(`base:${id}:${access}`)
    if (id === 'session-a') await inFlightGate
    return { async close() {} }
  }
  const repairWrapper = async function (this: unknown, id: string, access: string) {
    openLog.push(`repair:${id}`)
    return baseOpen(id, access)
  }
  const persistence = {
    root,
    async stat(id: string) {
      const target = id === 'session-a' ? logA : id === 'session-b' ? logB : undefined
      if (target === undefined) return undefined
      try {
        const { statSync } = await import('node:fs')
        statSync(target)
        return {
          header: { version: 4, id, createdAt: 1000, cwd, isSeeded: false },
          revision: `rev-${id}`,
          location: { kind: 'jsonl', path: target },
        }
      } catch {
        return undefined
      }
    },
    async list() {
      const items = []
      for (const id of ['session-a', 'session-b']) {
        const s = await this.stat(id)
        if (s !== undefined) items.push(s)
      }
      return items
    },
    open: repairWrapper,
    async create(header: { id: string }) {
      return { id: header.id, async close() {} }
    },
    async acquireWriteLease() {
      return { async release() {} }
    },
  }

  const dshContext = {
    sessionPersistence: persistence,
    sessions: { get: () => undefined, list: () => [] },
  }

  const service = new SessionDeletionService({
    dshContext,
    stateDirectory: stateDir,
    reservationTimeoutMs: 500,
  })
  await service.initialize({ replayOnStartup: false })

  // Install an outer wrapper AFTER sessionDeletion to verify uninstall preserves layers.
  const installedGuardOpen = persistence.open
  const outerWrapper = async function (this: unknown, id: string, access: string) {
    openLog.push(`outer:${id}`)
    return installedGuardOpen.call(this, id, access)
  }
  persistence.open = outerWrapper

  // Start an in-flight read open on session-a BEFORE prepare/commit.
  const prepA = await service.prepare('owner', { sessionId: 'session-a' })
  const prepB = await service.prepare('owner', { sessionId: 'session-b' })
  assert.equal(prepA.mode, 'immediate')
  assert.equal(prepB.mode, 'immediate')

  const inFlightPromise = persistence.open('session-a', 'read')
  const commitAPromise = service.commit('owner', { operationId: prepA.operationId!, mode: 'immediate' })

  // While session-a is reserved, deleting session-b must still proceed independently!
  const commitB = await service.commit('owner', { operationId: prepB.operationId!, mode: 'immediate' })
  assert.equal(commitB.status, 'deleted')

  // New open/create/fork for session-a must be rejected while reserved.
  await assert.rejects(
    () => persistence.open('session-a', 'read'),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_BUSY',
  )
  await assert.rejects(
    () => persistence.create({ id: 'child-of-a', parentSession: 'session-a' }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_BUSY',
  )

  releaseInFlightOpen()
  await inFlightPromise
  const commitA = await commitAPromise
  assert.equal(commitA.status, 'deleted')

  // Dispose guard while outerWrapper is still mounted: outerWrapper -> pass-through -> repairWrapper!
  service.dispose()
  openLog.length = 0
  await persistence.open('session-c', 'read')
  assert.deepEqual(openLog, ['outer:session-c', 'repair:session-c', 'base:session-c:read'])
})

test('active writer, close failure, wait timeout, and missing cross-process exclusion prevent deletion', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codingns-sd-busy-'))
  cleanups.push(base)
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  const cwd = join(base, 'project')
  mkdirSync(cwd, { recursive: true })
  const log = createSessionDir(root, cwd, 'session-busy')

  let blockForever = true
  const persistence = {
    root,
    async stat(id: string) {
      if (id !== 'session-busy') return undefined
      return {
        header: { version: 4, id, createdAt: 1000, cwd, isSeeded: false },
        revision: 'rev-1',
        location: { kind: 'jsonl', path: log },
      }
    },
    async list() { return [(await this.stat('session-busy'))!] },
    async open(_id: string, access: string) {
      if (access === 'read' && blockForever) {
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return {
        async close() {
          throw new Error('close failed')
        },
      }
    },
    async create() { return { async close() {} } },
    async acquireWriteLease() { return { async release() {} } },
  }

  const service = new SessionDeletionService({
    dshContext: { sessionPersistence: persistence, sessions: { get: () => undefined, list: () => [] } },
    stateDirectory: stateDir,
    reservationTimeoutMs: 40,
  })
  await service.initialize({ replayOnStartup: false })

  // 1. Timeout waiting for in-flight open -> busy, never proceeds past timeout.
  const prepTimeout = await service.prepare('owner', { sessionId: 'session-busy' })
  const slowOpen = persistence.open('session-busy', 'read')
  const timeoutCommit = await service.commit('owner', { operationId: prepTimeout.operationId!, mode: 'immediate' })
  assert.equal(timeoutCommit.status, 'busy')
  await slowOpen

  // 2. Active writer whose close() failed remains tracked and blocks immediate deletion.
  blockForever = false
  const writerHandle = await persistence.open('session-busy', 'write')
  await assert.rejects(() => writerHandle.close())
  const prepWriter = await service.prepare('owner', { sessionId: 'session-busy' })
  assert.equal(prepWriter.mode, 'restart-required')
  assert.ok(prepWriter.activeReasons.includes('live-writer'))

  // 3. Cross-process write lease contention rejects immediate deletion.
  const contestedService = new SessionDeletionService({
    dshContext: {
      sessionPersistence: {
        ...persistence,
        async acquireWriteLease() {
          const error = new Error('already owned')
          error.name = 'SessionAlreadyOwnedError'
          throw error
        },
      },
      sessions: { get: () => undefined, list: () => [] },
    },
    stateDirectory: stateDir,
  })
  await contestedService.initialize({ replayOnStartup: false })
  const prepContested = await contestedService.prepare('owner', { sessionId: 'session-busy' })
  const commitContested = await contestedService.commit('owner', { operationId: prepContested.operationId!, mode: 'immediate' })
  assert.equal(commitContested.status, 'busy')
  assert.equal(commitContested.code, 'SESSION_DELETION_ACTIVE_WRITER')

  // 4. Persistence without acquireWriteLease and without explicit exclusive deployment disables immediate deletion.
  const noLockService = new SessionDeletionService({
    dshContext: {
      sessionPersistence: {
        root: persistence.root,
        stat: persistence.stat.bind(persistence),
        list: persistence.list.bind(persistence),
        open: async () => ({ async close() {} }),
        create: async () => ({ async close() {} }),
      },
      sessions: { get: () => undefined, list: () => [] },
    },
    stateDirectory: stateDir,
  })
  await noLockService.initialize({ replayOnStartup: false })
  const prepNoLock = await noLockService.prepare('owner', { sessionId: 'session-busy' })
  assert.equal(prepNoLock.mode, 'unsupported')
  assert.equal(prepNoLock.reasonCode, 'SESSION_DELETION_EXCLUSION_UNAVAILABLE')

  service.dispose()
  contestedService.dispose()
  noLockService.dispose()
})
