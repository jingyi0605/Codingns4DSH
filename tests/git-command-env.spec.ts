import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createCodingNsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createGitManagementFeature } from '../data/build/dist/host/features/git-management.js'

const execFile = promisify(execFileCallback)

test('Git RPC 在进程带有 GIT_DIR 时仍使用工作区目录', async () => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-command-env-`)
  const previous = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  }
  const table = new CodingNsRpcTable()
  const resources: Array<() => void | Promise<void>> = []
  const feature = createGitManagementFeature()
  feature.start({
    descriptor: feature.descriptor,
    resources: { add(disposer) { resources.push(disposer) } },
    services: { rpc: table, resolveWorkspaceRoot: (workspaceId: string) => workspaceId === 'workspace-env' ? root : null },
  })
  const call = async (endpoint: string, payload: unknown): Promise<unknown> => {
    const result = await createCodingNsRpcHandler(table)(endpoint, payload, new AbortController().signal)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  try {
    await call('git/init', { workspaceId: 'workspace-env' })
    process.env.GIT_DIR = join(root, 'missing.git')
    process.env.GIT_OBJECT_DIRECTORY = join(root, 'missing-objects')
    process.env.GIT_INDEX_FILE = join(root, 'missing.index')
    const status = await call('git/status', { workspaceId: 'workspace-env' }) as { snapshot: { enabled?: boolean } }
    assert.equal(status.snapshot.enabled, true)
    await assert.rejects(
      () => execFile('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
      /GIT_DIR|not a git repository|unable to find/iu,
    )
  } finally {
    if (previous.GIT_DIR === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = previous.GIT_DIR
    if (previous.GIT_OBJECT_DIRECTORY === undefined) delete process.env.GIT_OBJECT_DIRECTORY
    else process.env.GIT_OBJECT_DIRECTORY = previous.GIT_OBJECT_DIRECTORY
    if (previous.GIT_INDEX_FILE === undefined) delete process.env.GIT_INDEX_FILE
    else process.env.GIT_INDEX_FILE = previous.GIT_INDEX_FILE
    for (const dispose of resources.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  }
})
