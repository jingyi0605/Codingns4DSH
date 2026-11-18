// Decision-level lifecycle regression checks; transport is mocked, no external CLI is spawned.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
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

test('turns replace the backend when the runtime environment changes or is removed', async () => {
  const driver = new CodexAppServerDriver()
  const first = await driver.getSession({ ...base, runtimeEnv: { CODINGNS_TEST_CREDENTIAL: 'old' } }, 'codex')
  const rotated = await driver.getSession({ ...base, runtimeEnv: { CODINGNS_TEST_CREDENTIAL: 'new' } }, 'codex')
  const cleared = await driver.getSession(base, 'codex')
  assert.notEqual(rotated, first)
  assert.notEqual(cleared, rotated)
  assert.deepEqual(retired, [first.rpc, rotated.rpc])
  assert.equal(rotated.rpc.options.env.CODINGNS_TEST_CREDENTIAL, 'new')
  assert.equal(cleared.rpc.options.env.CODINGNS_TEST_CREDENTIAL, undefined)
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

function createHandshakeHarness() {
  JsonRpcProcess.prototype.request = originalRequest
  JsonRpcProcess.prototype.notify = originalNotify
  JsonRpcProcess.prototype.disposeAndWait = originalDispose
  const firstInitialize = Promise.withResolvers<(error?: string) => void>()
  const backends: { calls: string[]; closed: boolean; answer?: unknown }[] = []
  const driver = new Driver({
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const backend: typeof backends[number] = { calls: [], closed: false }
      backends.push(backend)
      const send = (message: object) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
      const turn = { threadId: 'handshake-thread', turnId: 'handshake-turn' }
      const stdin = { write(data: string) {
        const { id, method, result } = JSON.parse(data)
        if (method !== undefined) backend.calls.push(method)
        if (method === 'initialize' && backends.length === 1) {
          firstInitialize.resolve((error) => send(error === undefined
            ? { id, result: {} }
            : { id, error: { code: -32600, message: error } }))
        } else if (method === 'thread/start') {
          send({ id, result: { thread: { id: turn.threadId } } })
        } else if (method === 'turn/start') {
          send({ id, result: { turn: { id: turn.turnId, status: 'inProgress' } } })
          send({ id: 'question', method: 'item/tool/requestUserInput', params: {
            ...turn, itemId: 'question-item', questions: [{ id: 'continue', question: 'Continue?', options: [{ label: 'Yes' }] }],
          } })
        } else if (id === 'question' && method === undefined) {
          backend.answer = result
          send({ method: 'turn/completed', params: { ...turn, turn: { id: turn.turnId, status: 'completed' } } })
        } else if (id !== undefined) {
          send({ id, result: method === 'skills/list' ? { data: [] } : {} })
        }
      } }
      return { stdout, stderr, stdin, kill() { backend.closed = true; stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  return { driver, backends, firstInitialize: firstInitialize.promise }
}

test('a rejected Codex handshake closes the backend and a retry can answer a reverse request', { timeout: 5_000 }, async () => {
  const { driver, backends, firstInitialize } = createHandshakeHarness()
  const turn = { ...base, permission: limited } as const
  try {
    const failed = driver.executeTurn(turn)[Symbol.asyncIterator]().next()
    const rejection = assert.rejects(failed, /handshake rejected/)
    const reply = await firstInitialize
    reply('handshake rejected')
    await rejection
    assert.equal(backends[0]?.closed, true)

    const events = []
    for await (const event of driver.executeTurn(turn)) {
      events.push(event)
      if (event.type === 'question-request') {
        driver.respondQuestion(base.sessionId, { requestId: event.requestId, answers: [{ id: 'continue', selected: ['Yes'] }] })
      }
    }
    assert.deepEqual(backends.map(backend => backend.calls), [['initialize'], ['initialize', 'initialized', 'thread/start', 'turn/start']])
    assert.deepEqual(backends[1]?.answer, { answers: { continue: { answers: ['Yes'] } } })
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
  } finally { driver.dispose() }
})

test('concurrent Codex skills queries wait for the same handshake', { timeout: 5_000 }, async () => {
  const { driver, backends, firstInitialize } = createHandshakeHarness()
  const input = { sessionId: base.sessionId, cwd: base.cwd }
  let results: Promise<unknown> | undefined
  try {
    const first = driver.listSkills(input)
    const reply = await firstInitialize
    const second = driver.listSkills(input)
    results = Promise.all([first, second])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(backends.map(backend => backend.calls), [['initialize']])
    reply()
    assert.deepEqual(await results, [[], []])
    assert.deepEqual(backends.map(backend => backend.calls), [['initialize', 'initialized', 'skills/list', 'skills/list']])
  } finally {
    driver.dispose()
    await results?.catch(() => undefined)
  }
})

test('cancelling a Codex handshake closes the backend and permits another handshake', { timeout: 5_000 }, async () => {
  const { driver, backends, firstInitialize } = createHandshakeHarness()
  const input = { sessionId: base.sessionId, cwd: base.cwd }
  const controller = new AbortController()
  try {
    const rejection = assert.rejects(driver.listSkills({ ...input, signal: controller.signal }), /请求已取消/)
    await firstInitialize
    controller.abort()
    await rejection
    assert.equal(backends[0]?.closed, true)
    assert.deepEqual(await driver.listSkills(input), [])
    assert.deepEqual(backends.map(backend => backend.calls), [['initialize', '$/cancelRequest'], ['initialize', 'initialized', 'skills/list']])
  } finally { driver.dispose() }
})
