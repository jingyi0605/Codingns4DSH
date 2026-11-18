// Decision-level lifecycle regression checks; transport is mocked, no external CLI is spawned.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { CodexAppServerDriver as Driver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { JsonRpcProcess as Rpc } from '../data/build/dist/host/cli-adapters/json-rpc-process.js'
// Inspect lifecycle internals without adding a public test-only API.
const CodexAppServerDriver: any = Driver
const JsonRpcProcess: any = Rpc

const originalRequest = JsonRpcProcess.prototype.request
const originalNotify = JsonRpcProcess.prototype.notify
const originalDispose = JsonRpcProcess.prototype.disposeAndWait
let retired: any[]
beforeEach(() => {
  retired = []
  JsonRpcProcess.prototype.request = async function(method, params) {
    if (method === 'thread/resume') return { thread: { id: params.threadId } }
    if (method === 'skills/list') return { data: [] }
    return {}
  }
  JsonRpcProcess.prototype.notify = function() {}
  JsonRpcProcess.prototype.disposeAndWait = async function() {
    retired.push(this)
    this.closed = true
  }
})
afterEach(() => {
  JsonRpcProcess.prototype.request = originalRequest
  JsonRpcProcess.prototype.notify = originalNotify
  JsonRpcProcess.prototype.disposeAndWait = originalDispose
})
const base = { sessionId: 'repair-test', cwd: process.cwd(), messages: [], prompt: '' }
const limited = { sandboxMode: 'workspace-write', approvalPolicy: 'ask' }
const full = { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
function launchConfig(session, key) {
  const args = session.rpc.options.args
  const value = args.find(x => x.startsWith(key + '='))
  assert.equal(args[args.indexOf(value) - 1], '-c')
  return JSON.parse(value.slice(key.length + 1))
}

test('unchanged policy reuses one backend; launch and turn policies agree', async () => {
  const d = new CodexAppServerDriver()
  const first = await d.getSession({ ...base, permission: limited }, 'codex')
  const second = await d.getSession({ ...base, permission: limited }, 'codex')
  assert.equal(first, second)
  assert.equal(launchConfig(first, 'sandbox_mode'), 'workspace-write')
  assert.equal(launchConfig(first, 'approval_policy'), 'on-request')
  assert.equal(retired.length, 0)
})

test('permission upgrade replaces backend, waits for disposal and resumes history', async () => {
  const d = new CodexAppServerDriver()
  const first = await d.getSession({ ...base, permission: limited }, 'codex')
  first.threadId = 'persisted-thread'
  let cleaned = false
  first.pendingQuestions.set('question', () => { cleaned = true; })
  const next = await d.getSession({ ...base, permission: full }, 'codex')
  assert.notEqual(first, next)
  assert.equal(first.rpc.isClosed, true)
  assert.equal(cleaned, true)
  assert.equal(next.resumeThreadId, 'persisted-thread')
  assert.equal(launchConfig(next, 'sandbox_mode'), 'danger-full-access')
  assert.equal(launchConfig(next, 'approval_policy'), 'never')
  assert.equal(d.processes.size, 1)
})

test('permission downgrade and approval-only changes also replace backend', async () => {
  const d = new CodexAppServerDriver()
  const first = await d.getSession({ ...base, permission: full }, 'codex')
  const next = await d.getSession({ ...base, permission: limited }, 'codex')
  const third = await d.getSession({ ...base, permission: { ...limited, approvalPolicy: 'never' } }, 'codex')
  assert.notEqual(first, next)
  assert.notEqual(next, third)
  assert.equal(retired.length, 2)
})

test('skills discovery without permission does not downgrade an existing backend', async () => {
  const d = new CodexAppServerDriver()
  d.cachedBinary = 'codex'
  const first = await d.getSession({ ...base, permission: full }, 'codex')
  assert.deepEqual(await d.listSkills({ sessionId: base.sessionId, cwd: base.cwd }), [])
  assert.equal(d.sessions.get(base.sessionId), first)
  assert.equal(retired.length, 0)
})

test('未指定 permission 时不得静默降级为保守策略：启动不注入 -c 权限对', async () => {
  const d = new CodexAppServerDriver()
  const first = await d.getSession(base, 'codex')
  const args = first.rpc.options.args
  assert.equal(args.some(x => x.startsWith('sandbox_mode=')), false)
  assert.equal(args.some(x => x.startsWith('approval_policy=')), false)
})

test('工作区默认权限变化时重建后端并同步启动覆盖项', async () => {
  const d = new CodexAppServerDriver()
  // 模拟 DSH 工作区实际生效的默认权限由 workspace-write/ask 变为 danger-full-access/never。
  const first = await d.getSession({ ...base, permission: limited }, 'codex')
  const next = await d.getSession({ ...base, permission: full }, 'codex')
  assert.notEqual(first, next)
  assert.equal(first.rpc.isClosed, true)
  assert.equal(launchConfig(next, 'sandbox_mode'), 'danger-full-access')
  assert.equal(launchConfig(next, 'approval_policy'), 'never')
  assert.equal(d.processes.size, 1)
})

test('explicit redetection of a new version and changed binary refresh the backend', async () => {
  let version = '0.169.0'
  const d = new CodexAppServerDriver({ spawnSync: (_cmd, args) => ({ status: 0, stdout: args.includes('--version') ? `codex-cli ${version}` : '{}', stderr: '' }) })
  await d.detect()
  const first = await d.getSession({ ...base, permission: limited }, 'codex')
  version = '0.170.0'
  await d.detect()
  const second = await d.getSession({ ...base, permission: limited }, 'codex')
  const third = await d.getSession({ ...base, permission: limited }, 'other-codex')
  assert.notEqual(first, second)
  assert.notEqual(second, third)
  assert.equal(retired.length, 2)
})

test('完全权限之后未读到权限：重建后端且不静默保留旧权限、不注入保守 -c 对', async () => {
  const d = new CodexAppServerDriver()
  const first = await d.getSession({ ...base, permission: full }, 'codex')
  const next = await d.getSession(base, 'codex')
  assert.notEqual(next, first)
  assert.equal(retired.length, 1)
  const args = next.rpc.options.args
  assert.equal(args.some(x => x.startsWith('sandbox_mode=')), false)
  assert.equal(args.some(x => x.startsWith('approval_policy=')), false)
})

test('changing launch policy during a suspended step stops rather than replays work', async () => {
  const d = new CodexAppServerDriver()
  const first = await d.getSession({ ...base, permission: limited }, 'codex')
  first.threadId = 'persisted-thread'
  let closed = false
  first.segmentedTurn = {
    removeAbortListener() {}, removeNotificationListener() {},
    queue: { close() { closed = true; } },
  }
  await assert.rejects(d.getSession({ ...base, permission: full, resumeSegmentedTurn: true }, 'codex'), /旧回合已停止/)
  assert.equal(closed, true)
  assert.equal(first.rpc.isClosed, true)
  const next = await d.getSession({ ...base, permission: full }, 'codex')
  assert.equal(next.resumeThreadId, 'persisted-thread')
})

test('compaction thread changes and failures retire and remove old processes', async () => {
  const d = new CodexAppServerDriver()
  d.cachedBinary = 'codex'
  const first = await d.getSession({ ...base, permission: limited }, 'codex')
  first.threadId = 'old-thread'
  d.compactThread = async () => { throw new Error('probe failure'); }
  await assert.rejects(d.compact({ ...base, permission: full, providerSessionId: 'new-thread' }), /probe failure/)
  assert.equal(retired.length, 2)
  assert.equal(d.processes.size, 0)
  assert.equal(d.sessions.has(base.sessionId), false)
})

test('manual compaction uses lifecycle checks instead of retaining old permission', async () => {
  const d = new CodexAppServerDriver()
  d.cachedBinary = 'codex'
  const first = await d.getSession({ ...base, permission: limited }, 'codex')
  first.threadId = 'persisted-thread'
  let compacted
  d.compactThread = async session => { compacted = session; }
  await d.compact({ ...base, permission: full, providerSessionId: first.threadId })
  assert.notEqual(compacted, first)
  assert.equal(compacted.threadId, 'persisted-thread')
  assert.equal(launchConfig(compacted, 'sandbox_mode'), 'danger-full-access')
})
