import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spillSessionDirName } from '../src/dsh-capabilities/host/session-deletion-adapter.js'
import { SessionDeletionService } from '../src/host/session-deletion/service.js'
import { deriveJsonlProjectKey, encodeJsonlSegment } from '../src/host/session-deletion/target-locator.js'

const cleanups: string[] = []
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

test('cleans workspace accounting, projection cache, spill files, and reconciles search only after log disappears; retries failed items idempotently', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codingns-sd-clean-'))
  cleanups.push(base)
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  const spillRoot = join(base, 'spill')
  const cwd = join(base, 'project')
  mkdirSync(cwd, { recursive: true })

  const sessionId = 'session-cleanup-target'
  const otherId = 'session-keep'
  const sessionDir = join(root, deriveJsonlProjectKey(cwd), encodeJsonlSegment(sessionId))
  mkdirSync(sessionDir, { recursive: true })
  const logPath = join(sessionDir, 'session.jsonl')
  writeFileSync(logPath, '{"type":"session"}\n')

  // Spill files for target and another session.
  const targetSpillDir = join(spillRoot, spillSessionDirName(sessionId))
  const otherSpillDir = join(spillRoot, spillSessionDirName(otherId))
  mkdirSync(targetSpillDir, { recursive: true })
  mkdirSync(otherSpillDir, { recursive: true })
  writeFileSync(join(targetSpillDir, 'out.txt'), 'target-spill')
  writeFileSync(join(otherSpillDir, 'out.txt'), 'other-spill')

  const callOrder: string[] = []
  let members = [sessionId, otherId]
  let archived = [sessionId]
  let pinned = [sessionId]
  const projCache = new Map<string, unknown>([[sessionId, { rows: {} }], [otherId, { rows: {} }]])
  let searchReconcileShouldFail = true
  let searchIndexedIds = new Set([sessionId, otherId])

  const persistence = {
    root,
    async stat(id: string) {
      if (id === sessionId && existsSync(logPath)) {
        return {
          header: { version: 4, id: sessionId, createdAt: 1000, cwd, isSeeded: false },
          revision: 'rev-1',
          location: { kind: 'jsonl', path: logPath },
        }
      }
      return undefined
    },
    async list() {
      const s = await this.stat(sessionId)
      return s === undefined ? [] : [s]
    },
    async open() { return { async close() {} } },
    async create() { return { async close() {} } },
    async acquireWriteLease() { return { async release() {} } },
  }

  let removedEventId: string | undefined
  const service = new SessionDeletionService({
    dshContext: {
      sessionPersistence: persistence,
      sessions: { get: () => undefined, list: () => [] },
      workspaceRegistry: {
        get archivedSessionIds() { return archived },
        get pinnedSessionIds() { return pinned },
        list: () => [{
          id: 'ws-1',
          path: cwd,
          title: 'Project',
          get sessionIds() { return members },
          async detachSession(id: string) {
            // Verify log is already gone before workspace accounting mutates.
            assert.equal(existsSync(logPath), false)
            callOrder.push(`workspace.detach:${id}`)
            members = members.filter((m) => m !== id)
          },
        }],
        async unarchiveSession(id: string) {
          callOrder.push(`workspace.unarchive:${id}`)
          archived = archived.filter((a) => a !== id)
        },
        async unpinSession(id: string) {
          callOrder.push(`workspace.unpin:${id}`)
          pinned = pinned.filter((p) => p !== id)
        },
      },
      storageDomain: {
        get(name: string) {
          if (name !== 'session_projcache') return undefined
          return {
            table(tableName: string) {
              assert.equal(tableName, 'sessions')
              return {
                get: (key: string) => projCache.get(key),
                has: (key: string) => projCache.has(key),
                async delete(key: string) {
                  callOrder.push(`projcache.delete:${key}`)
                  return projCache.delete(key)
                },
              }
            },
          }
        },
      },
      spillStore: { root: spillRoot },
      sessionQuery: {
        async searchEvents(req: { sessionId: string }) {
          callOrder.push(`search.reconcile:${req.sessionId}`)
          if (searchReconcileShouldFail) throw Object.assign(new Error('SQLite busy'), { code: 'SESSION_QUERY_INDEX_FAILED' })
          if (!existsSync(logPath)) searchIndexedIds.delete(req.sessionId)
          if (!searchIndexedIds.has(req.sessionId)) {
            throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
          }
          return { items: [{ sessionId: req.sessionId }] }
        },
        async searchSessions(req: { sessionFilters?: Array<{ values: string[] }> }) {
          const targetId = req.sessionFilters?.[0]?.values?.[0]
          return { items: targetId !== undefined && searchIndexedIds.has(targetId) ? [{ header: { id: targetId } }] : [] }
        },
      },
    },
    stateDirectory: stateDir,
    emitNativeRemoved: (id) => { removedEventId = id },
  })
  await service.initialize({ replayOnStartup: false })

  const prep = await service.prepare('owner', { sessionId })
  assert.equal(prep.mode, 'immediate')
  const firstCommit = await service.commit('owner', { operationId: prep.operationId!, mode: 'immediate' })

  assert.equal(firstCommit.status, 'cleanup-pending')
  assert.equal(firstCommit.code, 'SESSION_DELETION_CLEANUP_PENDING')
  assert.deepEqual(firstCommit.pendingCleanupItems, ['search-index'])
  assert.deepEqual(firstCommit.completedCleanupItems, ['workspace', 'projection-cache', 'spill'])
  assert.equal(existsSync(logPath), false)
  assert.equal(existsSync(targetSpillDir), false)
  assert.equal(existsSync(otherSpillDir), true)
  assert.equal(projCache.has(sessionId), false)
  assert.equal(projCache.has(otherId), true)
  assert.deepEqual(members, [otherId])
  assert.deepEqual(archived, [])
  assert.deepEqual(pinned, [])

  // Retry ONLY unfinished items (workspace/projcache/spill must NOT re-run).
  callOrder.length = 0
  searchReconcileShouldFail = false
  const retried = await service.status('owner', { operationId: prep.operationId!, retryCleanup: true })
  assert.equal(retried.status, 'deleted')
  assert.deepEqual(retried.pendingCleanupItems, [])
  assert.deepEqual(callOrder, [`search.reconcile:${sessionId}`])
  assert.equal(removedEventId, sessionId)
  service.dispose()
})

test('recursively deletes parent with nested subagent descendants in post-order while preserving forks and still blocking isolated child deletion', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codingns-sd-sub-'))
  cleanups.push(base)
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  const cwd = join(base, 'project')
  mkdirSync(cwd, { recursive: true })

  const parentDir = join(root, deriveJsonlProjectKey(cwd), encodeJsonlSegment('parent-1'))
  const childDir = join(root, deriveJsonlProjectKey(cwd), encodeJsonlSegment('child-1'))
  const grandchildDir = join(root, deriveJsonlProjectKey(cwd), encodeJsonlSegment('grandchild-1'))
  const forkDir = join(root, deriveJsonlProjectKey(cwd), encodeJsonlSegment('fork-1'))
  mkdirSync(parentDir, { recursive: true })
  mkdirSync(childDir, { recursive: true })
  mkdirSync(grandchildDir, { recursive: true })
  mkdirSync(forkDir, { recursive: true })
  const parentLog = join(parentDir, 'session.jsonl')
  const childLog = join(childDir, 'session.jsonl')
  const grandchildLog = join(grandchildDir, 'session.jsonl')
  const forkLog = join(forkDir, 'session.jsonl')
  writeFileSync(parentLog, '{}\n')
  writeFileSync(childLog, '{}\n')
  writeFileSync(grandchildLog, '{}\n')
  writeFileSync(forkLog, '{}\n')

  const parentHeader = { version: 4, id: 'parent-1', createdAt: 1000, cwd, isSeeded: false }
  const childHeader = { version: 4, id: 'child-1', createdAt: 1100, cwd, parentSession: 'parent-1', origin: 'subagent' as const, isSeeded: true }
  const grandchildHeader = { version: 4, id: 'grandchild-1', createdAt: 1200, cwd, parentSession: 'child-1', origin: 'subagent' as const, isSeeded: true }
  const forkHeader = { version: 4, id: 'fork-1', createdAt: 1300, cwd, parentSession: 'parent-1', isSeeded: true }

  const headers = new Map([
    ['parent-1', { header: parentHeader, log: parentLog }],
    ['child-1', { header: childHeader, log: childLog }],
    ['grandchild-1', { header: grandchildHeader, log: grandchildLog }],
    ['fork-1', { header: forkHeader, log: forkLog }],
  ])

  const detached: string[] = []
  const deletedProj: string[] = []
  const removedEvents: string[] = []
  const liveSessions = new Map<string, unknown>()
  const wsMembers = new Set(['parent-1', 'child-1', 'grandchild-1', 'fork-1'])

  const service = new SessionDeletionService({
    dshContext: {
      sessionPersistence: {
        root,
        async stat(id: string) {
          const entry = headers.get(id)
          if (entry === undefined || !existsSync(entry.log)) return undefined
          return { header: entry.header, revision: `rev-${id}`, location: { kind: 'jsonl', path: entry.log } }
        },
        async list() {
          const all = []
          for (const [id, entry] of headers) {
            if (existsSync(entry.log)) {
              all.push({ header: entry.header, revision: `rev-${id}`, location: { kind: 'jsonl', path: entry.log } })
            }
          }
          return all
        },
        async open() { return { async close() {} } },
        async create() { return { async close() {} } },
        async acquireWriteLease() { return { async release() {} } },
      },
      sessions: {
        get: (id: string) => liveSessions.get(id),
        list: () => [...liveSessions.values()],
      },
      workspaceRegistry: {
        list: () => [{
          id: 'ws-1',
          sessionIds: [...wsMembers],
          async detachSession(id: string) {
            detached.push(id)
            wsMembers.delete(id)
          },
        }],
        async unarchiveSession() {},
        async unpinSession() {},
      },
      storageDomain: {
        get(domain: string) {
          if (domain !== 'session_projcache') return undefined
          return { table: () => ({ delete(id: string) { deletedProj.push(id) } }) }
        },
      },
    },
    stateDirectory: stateDir,
    emitNativeRemoved: (id) => { removedEvents.push(id) },
  })
  await service.initialize({ replayOnStartup: false })

  // Direct deletion of child while parent still exists remains blocked.
  const prepChild = await service.prepare('owner', { sessionId: 'child-1' })
  assert.equal(prepChild.mode, 'unsupported')
  assert.equal(prepChild.reasonCode, 'SESSION_DELETION_SUBAGENT_WITH_PARENT')
  assert.equal(prepChild.operationId, undefined)

  // If a child subagent is held by runtime activity, the parent tree switches to restart-required.
  liveSessions.set('grandchild-1', { id: 'grandchild-1', header: grandchildHeader })
  const prepBusyTree = await service.prepare('owner', { sessionId: 'parent-1' })
  assert.equal(prepBusyTree.mode, 'restart-required')
  assert.equal(prepBusyTree.subagentCount, 2)
  assert.ok(prepBusyTree.activeReasons.includes('live-session'))

  // When all nodes are idle, parent deletion removes grandchild -> child -> parent immediately while preserving fork-1.
  liveSessions.clear()
  const prepParent = await service.prepare('owner', { sessionId: 'parent-1' })
  assert.equal(prepParent.mode, 'immediate')
  assert.equal(prepParent.subagentStatus, 'has-children')
  assert.equal(prepParent.subagentCount, 2)
  assert.ok(prepParent.operationId)

  const committed = await service.commit('owner', { operationId: prepParent.operationId!, mode: 'immediate' })
  assert.equal(committed.status, 'deleted')
  assert.equal(existsSync(grandchildDir), false)
  assert.equal(existsSync(childDir), false)
  assert.equal(existsSync(parentDir), false)
  assert.equal(existsSync(forkDir), true, 'independent non-subagent fork must stay intact')
  assert.deepEqual(detached, ['grandchild-1', 'child-1', 'parent-1'])
  assert.deepEqual(deletedProj, ['grandchild-1', 'child-1', 'parent-1'])
  assert.ok(removedEvents.includes('grandchild-1'))
  assert.ok(removedEvents.includes('child-1'))
  assert.ok(removedEvents.includes('parent-1'))
  service.dispose()
})
