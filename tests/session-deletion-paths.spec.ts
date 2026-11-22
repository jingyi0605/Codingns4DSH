import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionDeletionService } from '../src/host/session-deletion/service.js'
import { deriveJsonlProjectKey, encodeJsonlSegment } from '../src/host/session-deletion/target-locator.js'

const cleanups: string[] = []
test.after(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

test('deletes all log generations inside target directory while keeping workspace, shared attachments, and independent forks intact', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codingns-sd-paths-'))
  cleanups.push(base)
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  const workspaceDir = join(base, 'user-workspace')
  const attachmentsDir = join(base, 'attachments')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(attachmentsDir, { recursive: true })

  const workspaceFile = join(workspaceDir, 'README.md')
  const sharedAttachment = join(attachmentsDir, 'image.png')
  writeFileSync(workspaceFile, '# keep me\n')
  writeFileSync(sharedAttachment, 'png-bytes')

  const projKey = deriveJsonlProjectKey(workspaceDir)
  const targetDir = join(root, projKey, encodeJsonlSegment('session-target'))
  const forkDir = join(root, projKey, encodeJsonlSegment('session-fork'))
  mkdirSync(targetDir, { recursive: true })
  mkdirSync(forkDir, { recursive: true })

  const v0Log = join(targetDir, 'session.jsonl')
  const v4Log = join(targetDir, 'session.v4.jsonl.zstd')
  const lockFile = join(targetDir, 'session.lock')
  writeFileSync(v0Log, '{"type":"session"}\n')
  writeFileSync(v4Log, 'zstd-bytes')
  writeFileSync(lockFile, '')

  const forkLog = join(forkDir, 'session.v4.jsonl.zstd')
  writeFileSync(forkLog, 'fork-bytes')

  const targetHeader = { version: 4, id: 'session-target', createdAt: 1000, cwd: workspaceDir, isSeeded: false }
  const forkHeader = { version: 4, id: 'session-fork', createdAt: 2000, cwd: workspaceDir, parentSession: 'session-target', isSeeded: true }

  const persistence = {
    root,
    async stat(id: string) {
      if (id === 'session-target' && existsSync(v4Log)) {
        return { header: targetHeader, revision: 'rev-t', location: { kind: 'jsonl', path: v4Log } }
      }
      if (id === 'session-fork' && existsSync(forkLog)) {
        return { header: forkHeader, revision: 'rev-f', location: { kind: 'jsonl', path: forkLog } }
      }
      return undefined
    },
    async list() {
      return [
        ...(await this.stat('session-target') ? [(await this.stat('session-target'))!] : []),
        ...(await this.stat('session-fork') ? [(await this.stat('session-fork'))!] : []),
      ]
    },
    async open() { return { async close() {} } },
    async create() { return { async close() {} } },
    async acquireWriteLease() { return { async release() {} } },
  }

  const service = new SessionDeletionService({
    dshContext: { sessionPersistence: persistence, sessions: { get: () => undefined, list: () => [] } },
    stateDirectory: stateDir,
  })
  await service.initialize({ replayOnStartup: false })

  const prep = await service.prepare('owner', { sessionId: 'session-target' })
  assert.equal(prep.mode, 'immediate')
  const commit = await service.commit('owner', { operationId: prep.operationId!, mode: 'immediate' })
  assert.equal(commit.status, 'deleted')

  assert.equal(existsSync(targetDir), false)
  assert.equal(existsSync(v0Log), false)
  assert.equal(existsSync(v4Log), false)
  assert.equal(existsSync(workspaceFile), true)
  assert.equal(existsSync(sharedAttachment), true)
  assert.equal(existsSync(forkLog), true)
  service.dispose()
})

test('rejects symlinks, duplicate locations, and wrong root locations cleanly', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codingns-sd-unsafe-'))
  cleanups.push(base)
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  const cwd = join(base, 'project')
  const outside = join(base, 'outside')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(outside, { recursive: true })

  const projDir = join(root, deriveJsonlProjectKey(cwd))
  mkdirSync(projDir, { recursive: true })

  // 1. Symlinked session directory must be rejected.
  const symlinkSessionDir = join(projDir, encodeJsonlSegment('session-symlink'))
  symlinkSync(outside, symlinkSessionDir)
  const symlinkLog = join(symlinkSessionDir, 'session.jsonl')
  writeFileSync(symlinkLog, '{}\n')

  // 2. Duplicate session directory in another project directory must be rejected.
  const dupSessionId = 'session-dup'
  const realDupDir = join(projDir, encodeJsonlSegment(dupSessionId))
  const otherDupDir = join(root, '_no-cwd', encodeJsonlSegment(dupSessionId))
  mkdirSync(realDupDir, { recursive: true })
  mkdirSync(otherDupDir, { recursive: true })
  const dupLog = join(realDupDir, 'session.jsonl')
  writeFileSync(dupLog, '{}\n')
  writeFileSync(join(otherDupDir, 'session.jsonl'), '{}\n')

  // 3. Location pointing directly to persistence root must be rejected.
  const wrongLocLog = join(root, 'session.jsonl')
  writeFileSync(wrongLocLog, '{}\n')

  const persistence = {
    root,
    async stat(id: string) {
      if (id === 'session-symlink') {
        return {
          header: { version: 4, id, createdAt: 1000, cwd, isSeeded: false },
          revision: 'rev-s',
          location: { kind: 'jsonl', path: symlinkLog },
        }
      }
      if (id === dupSessionId) {
        return {
          header: { version: 4, id, createdAt: 1000, cwd, isSeeded: false },
          revision: 'rev-d',
          location: { kind: 'jsonl', path: dupLog },
        }
      }
      if (id === 'session-wrong-root') {
        return {
          header: { version: 4, id, createdAt: 1000, cwd, isSeeded: false },
          revision: 'rev-w',
          location: { kind: 'jsonl', path: wrongLocLog },
        }
      }
      return undefined
    },
    async list() { return [] },
    async open() { return { async close() {} } },
    async create() { return { async close() {} } },
    async acquireWriteLease() { return { async release() {} } },
  }

  const service = new SessionDeletionService({
    dshContext: { sessionPersistence: persistence, sessions: { get: () => undefined, list: () => [] } },
    stateDirectory: stateDir,
  })
  await service.initialize({ replayOnStartup: false })

  await assert.rejects(
    () => service.prepare('owner', { sessionId: 'session-symlink' }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_PATH_UNSAFE',
  )
  await assert.rejects(
    () => service.prepare('owner', { sessionId: dupSessionId }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_DUPLICATE_LOCATION',
  )
  await assert.rejects(
    () => service.prepare('owner', { sessionId: 'session-wrong-root' }),
    (err: { code?: string }) => err.code === 'SESSION_DELETION_PATH_UNSAFE',
  )

  assert.equal(existsSync(outside), true)
  assert.equal(existsSync(dupLog), true)
  service.dispose()
})
