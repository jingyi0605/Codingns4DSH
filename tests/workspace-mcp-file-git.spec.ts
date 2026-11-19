import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorkspaceMcpToolHandlers } from '../src/host/workspace-mcp/tools.ts'
import { startWorkspaceMcpTransport, WORKSPACE_MCP_LARGE_RESPONSE_BYTES } from '../src/host/workspace-mcp/transport.js'

const execFile = promisify(execFileCallback)
const abort = (): AbortSignal => new AbortController().signal

async function handlersFor(root: string) {
  return createWorkspaceMcpToolHandlers({
    dshContext: { get: () => ({ list: () => [{ id: 'ws', sessionIds: [] }], archivedSessionIds: [] }) },
    resolveManagedWorkspaceRoot: () => root,
  } as never)
}

function content(result: unknown): Record<string, any> {
  return (result as { structuredContent: Record<string, any> }).structuredContent
}

test('workspace file tools list bounded trees, read text/base64 and reject unsafe paths or large files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-mcp-files-'))
  const outside = await mkdtemp(join(tmpdir(), 'workspace-mcp-outside-'))
  const handlers = await handlersFor(root)
  try {
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await writeFile(join(root, 'src', 'main.ts'), 'hello')
    await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'deep')
    await writeFile(join(root, 'large.bin'), Buffer.alloc(1_048_577, 1))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))

    const listed = content(await handlers.callTool('workspace_file_list', { workspaceId: 'ws', depth: 2 }, abort()))
    assert.deepEqual(listed.entries.map((entry: { path: string }) => entry.path), ['large.bin', 'src', 'src/main.ts', 'src/nested'])
    const read = content(await handlers.callTool('workspace_file_read', { workspaceId: 'ws', path: 'src/main.ts' }, abort()))
    assert.deepEqual(read, { content: 'hello', size: 5, encoding: 'utf8', truncated: false })
    const base64 = content(await handlers.callTool('workspace_file_read', { workspaceId: 'ws', path: 'src/main.ts', encoding: 'base64' }, abort()))
    assert.equal(base64.content, Buffer.from('hello').toString('base64'))
    assert.equal(content(await handlers.callTool('workspace_file_read', { workspaceId: 'ws', path: '../outside/secret.txt' }, abort())).error.code, 'WORKSPACE_MCP_INVALID_PATH')
    assert.equal(content(await handlers.callTool('workspace_file_read', { workspaceId: 'ws', path: 'escape.txt' }, abort())).error.code, 'WORKSPACE_MCP_INVALID_PATH')
    assert.equal(content(await handlers.callTool('workspace_file_read', { workspaceId: 'ws', path: 'missing.txt' }, abort())).error.code, 'WORKSPACE_MCP_NOT_FOUND')
    assert.equal(content(await handlers.callTool('workspace_file_read', { workspaceId: 'ws', path: 'large.bin' }, abort())).error.code, 'WORKSPACE_MCP_FILE_TOO_LARGE')
  } finally {
    await handlers.dispose()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('workspace Git tools return status, commit history and a bounded diff; reject invalid refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-mcp-git-'))
  const handlers = await handlersFor(root)
  try {
    await execFile('git', ['init', '-b', 'main'], { cwd: root })
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root })
    await execFile('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'before\n')
    await execFile('git', ['add', 'tracked.txt'], { cwd: root })
    await execFile('git', ['commit', '-m', 'Initial commit'], { cwd: root })
    await writeFile(join(root, 'tracked.txt'), 'before\nafter\n')
    const untrackedPath = process.platform === 'win32' ? 'new file.txt' : 'new -> file\n.txt'
    await writeFile(join(root, untrackedPath), 'untracked\n')

    const status = content(await handlers.callTool('workspace_git_status', { workspaceId: 'ws' }, abort()))
    assert.equal(status.branch, 'main')
    assert.deepEqual(status.unstaged, ['tracked.txt'])
    assert.deepEqual(status.untracked, [untrackedPath])
    const log = content(await handlers.callTool('workspace_git_log', { workspaceId: 'ws', limit: 5 }, abort()))
    assert.equal(log.commits.length, 1)
    assert.equal(log.commits[0].message, 'Initial commit')
    const diff = content(await handlers.callTool('workspace_git_diff', { workspaceId: 'ws', path: 'tracked.txt' }, abort()))
    assert.match(diff.diff, /^diff --git /u)
    assert.equal(diff.stats.insertions, 1)
    assert.equal(diff.stats.deletions, 0)
    assert.equal(content(await handlers.callTool('workspace_git_log', { workspaceId: 'ws', branch: 'missing-branch' }, abort())).error.code, 'WORKSPACE_MCP_BRANCH_NOT_FOUND')
    await execFile('git', ['commit', '-am', 'Second commit'], { cwd: root })
    const history = content(await handlers.callTool('workspace_git_log', { workspaceId: 'ws' }, abort()))
    assert.deepEqual(history.commits.map((commit: { message: string }) => commit.message), ['Second commit', 'Initial commit'])
    assert.ok(history.commits.every((commit: { hash: string }) => /^[a-f0-9]{40,64}$/u.test(commit.hash)))
    assert.deepEqual(content(await handlers.callTool('workspace_git_log', { workspaceId: 'ws', branch: 'HEAD~1..HEAD' }, abort())).commits, history.commits.slice(0, 1))
    assert.equal(content(await handlers.callTool('workspace_git_log', { workspaceId: 'ws', branch: '--all' }, abort())).error.code, 'WORKSPACE_MCP_INVALID_REF')
  } finally {
    await handlers.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('MCP HTTP delivers a 1 MiB file in base64', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-mcp-http-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = Buffer.alloc(1024 * 1024, 42)
  await writeFile(join(root, 'image.bin'), data)
  const handlers = await handlersFor(root)
  t.after(() => handlers.dispose())
  const apiKey = randomUUID()
  const transport = await startWorkspaceMcpTransport({ ...handlers, apiKey, maxResponseBytes: WORKSPACE_MCP_LARGE_RESPONSE_BYTES })
  t.after(() => transport.revoke())
  const response = await fetch(transport.url!, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'workspace_file_read', arguments: { workspaceId: 'ws', path: 'image.bin', encoding: 'base64' },
    } }),
  })
  const result = await response.json()
  assert.equal(result.result.structuredContent.size, data.length)
  assert.deepEqual(Buffer.from(result.result.structuredContent.content, 'base64'), data)
})

test('Git tools terminate a command at five seconds', { skip: process.platform === 'win32', timeout: 8_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-mcp-git-timeout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'git'), '#!/bin/sh\nexec /bin/sleep 20\n', { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = root
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath })
  const handlers = await handlersFor(root)
  t.after(() => handlers.dispose())
  const startedAt = Date.now()
  const result = content(await handlers.callTool('workspace_git_status', { workspaceId: 'ws' }, abort()))
  assert.equal(result.error.code, 'WORKSPACE_MCP_GIT_TIMEOUT')
  assert.ok(Date.now() - startedAt >= 4_950)
})

test('Git tools report non-repositories with a structured error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-mcp-not-git-'))
  const handlers = await handlersFor(root)
  try {
    assert.equal(content(await handlers.callTool('workspace_git_status', { workspaceId: 'ws' }, abort())).error.code, 'WORKSPACE_MCP_NOT_A_GIT_REPO')
  } finally {
    await handlers.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
