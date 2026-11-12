import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { createSessionCompactionAdapter, supportsSessionCompaction } from '../data/build/dist/dsh-capabilities/host/session-compaction-adapter.js'
import { hostBrowserText } from '../data/build/dist/host/browser-text.js'

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() {
      this.killed = true
      this.stdin.end(); this.stdout.end(); this.stderr.end()
      this.emit('close', 0)
      return true
    },
  })
}

function codexFixture() {
  const child = childProcess()
  const requests: { id?: number; method: string; params?: Record<string, unknown> }[] = []
  const acknowledged = Promise.withResolvers<void>()
  const write = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`)
  child.stdin.on('data', data => {
    const request = JSON.parse(String(data))
    requests.push(request)
    if (request.id === undefined) return
    if (request.method === 'turn/start') {
      write({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'existing-thread', turnId: 'next-turn', delta: 'Continued.' } })
      write({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'next-turn', status: 'completed' } } })
      return
    }
    write({ jsonrpc: '2.0', id: request.id, result: request.method === 'thread/resume' ? { thread: { id: request.params.threadId } } : {} })
    if (request.method === 'thread/compact/start') acknowledged.resolve()
  })
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex.exe'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => child) as never,
  })
  const notify = (method: string, params: Record<string, unknown>) => write({ jsonrpc: '2.0', method, params })
  const finish = (status = 'completed', threadId = 'existing-thread') => {
    notify('item/started', { threadId, turnId: 'maintenance', item: { id: 'compact-item', type: 'contextCompaction' } })
    notify('item/completed', { threadId, turnId: 'maintenance', item: { id: 'compact-item', type: 'contextCompaction' } })
    notify('turn/completed', { threadId, turn: { id: 'maintenance', status } })
  }
  return { driver, child, requests, acknowledged, notify, finish }
}

test('Codex manual compaction resumes the exact thread, waits for completion and never starts a user turn', async () => {
  const f = codexFixture()
  let settled = false
  try {
    const operation = f.driver.compact({ sessionId: 'dsh-session', providerSessionId: 'existing-thread', cwd: process.cwd() })
      .then(result => { settled = true; return result })
    await f.acknowledged.promise
    f.finish('completed', 'another-thread')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    assert.deepEqual(f.requests.find(r => r.method === 'thread/compact/start')?.params, { threadId: 'existing-thread' })
    assert.equal(f.requests.some(r => r.method === 'thread/start' || r.method === 'turn/start'), false)
    f.finish()
    assert.deepEqual(await operation, { compacted: true })
    // A second manual command reuses the same live provider thread.
    const again = f.driver.compact({ sessionId: 'dsh-session', providerSessionId: 'existing-thread', cwd: process.cwd() })
    await new Promise(resolve => setImmediate(resolve))
    f.finish()
    await again
    assert.equal(f.requests.filter(r => r.method === 'thread/resume').length, 1)
    const nextTurn = await Array.fromAsync(f.driver.executeTurn({
      sessionId: 'dsh-session', providerSessionId: 'existing-thread', cwd: process.cwd(), messages: [], prompt: 'Continue',
    }))
    assert.equal(f.requests.find(r => r.method === 'turn/start')?.params?.threadId, 'existing-thread')
    assert.equal(f.requests.filter(r => r.method === 'thread/resume').length, 1)
    assert.equal(nextTurn.some(event => event.type === 'context-compaction'), false)
    assert.equal(nextTurn.find(event => event.type === 'session-binding')?.providerSessionId, 'existing-thread')
    assert.equal(nextTurn.find(event => event.type === 'text-delta')?.text, 'Continued.')
    assert.equal(nextTurn.at(-1)?.type, 'finish')
  } finally { f.driver.dispose() }
})

test('Codex manual compaction propagates native failure and cancellation after the start acknowledgement', async () => {
  for (const mode of ['failure', 'abort', 'exit'] as const) {
    const f = codexFixture()
    const abort = new AbortController()
    try {
      const operation = f.driver.compact({ sessionId: mode, providerSessionId: 'existing-thread', signal: abort.signal })
      const rejected = assert.rejects(operation)
      await f.acknowledged.promise
      if (mode === 'failure') f.finish('failed')
      if (mode === 'abort') abort.abort(new Error('cancelled by user'))
      if (mode === 'exit') f.child.kill()
      await rejected
      if (mode === 'abort') assert.equal(f.child.killed, true)
    } finally { f.driver.dispose() }
  }
})

function claudeFixture(records: readonly Record<string, unknown>[] | null) {
  let child = childProcess()
  const inputs: Record<string, unknown>[] = []
  const args: string[][] = []
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude.exe'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.206', stderr: '' })) as never,
    spawn: ((_command: string, parameters: string[]) => {
      args.push(parameters)
      if (child.killed) child = childProcess()
      const current = child
      current.stdin.on('data', data => {
        const input = JSON.parse(String(data))
        inputs.push(input)
        if (input.type !== 'user' || records === null) return
        queueMicrotask(() => {
          for (const record of records) current.stdout.write(`${JSON.stringify({ session_id: 'claude-thread', ...record })}\n`)
        })
      })
      return current
    }) as never,
  })
  return { driver, get child() { return child }, inputs, args }
}

test('Claude manual compaction sends /compact to --resume and requires the native compact boundary', async () => {
  for (const compacted of [true, false]) {
    const f = claudeFixture([
      { type: 'system', subtype: 'init' },
      ...(compacted ? [{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1842 } }] : []),
      { type: 'result', subtype: 'success', is_error: false, result: compacted ? 'Compacted.' : 'Not enough messages to compact.' },
    ])
    try {
      const result = await f.driver.compact({ sessionId: 'dsh-session', providerSessionId: 'claude-thread', cwd: process.cwd() })
      assert.equal(result.compacted, compacted)
      assert.match(result.message!, compacted ? /Compacted/ : /Not enough messages/)
      const parameters = f.args[0]!
      assert.equal(parameters[parameters.indexOf('--resume') + 1], 'claude-thread')
      assert.equal(parameters[parameters.indexOf('--tools') + 1], '')
      assert.deepEqual(f.inputs.find(input => input.type === 'user')?.message, { role: 'user', content: [{ type: 'text', text: '/compact' }] })
      assert.equal(f.child.killed, true)
      const nextTurn = await Array.fromAsync(f.driver.executeTurn({ sessionId: 'dsh-session', providerSessionId: 'claude-thread', messages: [], prompt: 'Continue' }))
      assert.equal(f.args[1]![f.args[1]!.indexOf('--resume') + 1], 'claude-thread')
      assert.equal(f.args[1]!.includes('--tools'), false)
      assert.deepEqual(f.inputs.filter(input => input.type === 'user').at(-1)?.message, { role: 'user', content: [{ type: 'text', text: 'Continue' }] })
      assert.equal(nextTurn.find(event => event.type === 'finish')?.reason, 'stop')
    } finally { f.driver.dispose() }
  }
})

test('Claude manual compaction rejects provider errors, missing terminal results and wrong session bindings', async () => {
  for (const mode of ['error', 'exit', 'mismatch'] as const) {
    const f = claudeFixture(mode === 'error'
      ? [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'compaction failed' }]
      : mode === 'mismatch' ? [{ type: 'system', subtype: 'init', session_id: 'wrong-thread' }] : null)
    try {
      const operation = f.driver.compact({ sessionId: mode, providerSessionId: 'claude-thread' })
      const rejected = assert.rejects(operation)
      if (mode === 'exit') {
        await new Promise(resolve => setImmediate(resolve))
        f.child.kill()
      }
      await rejected
      assert.equal(f.child.killed, true)
    } finally { f.driver.dispose() }
  }
})

test('Claude compaction cancellation kills the process and releases its maintenance state', async () => {
  const f = claudeFixture(null)
  const abort = new AbortController()
  try {
    const operation = f.driver.compact({ sessionId: 'cancelled', providerSessionId: 'claude-thread', signal: abort.signal })
    const rejected = assert.rejects(operation)
    await new Promise(resolve => setImmediate(resolve))
    abort.abort()
    await rejected
    assert.equal(f.child.killed, true)
    await assert.rejects(f.driver.compact({ sessionId: 'fresh', signal: AbortSignal.abort() }))
  } finally { f.driver.dispose() }
})

test('Registry compaction isolates sessions, rejects concurrent turns, and aborts on unload', async () => {
  const started = Promise.withResolvers<void>()
  let calls = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
    async compact(input) {
      calls++
      if (input.sessionId === 'second') return { compacted: true }
      assert.equal(input.providerSessionId, 'provider-first')
      started.resolve()
      return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }))
    },
  }])
  registry.setSession('first', { adapterId: 'codex', providerSessionId: 'provider-first' })
  registry.setSession('second', { adapterId: 'codex', providerSessionId: 'provider-second' })
  registry.setSession('empty', { adapterId: 'codex' })
  const pending = registry.compact('first', process.cwd(), new AbortController().signal)
  const rejected = assert.rejects(pending)
  await started.promise
  await assert.rejects(registry.compact('first', undefined, new AbortController().signal), /busy/)
  await assert.rejects(registry.execute({ sessionId: 'first', adapterId: 'codex', messages: [], prompt: 'hello' }).next())
  await assert.rejects(registry.compact('empty', undefined, new AbortController().signal), /conversation/)
  assert.deepEqual(await registry.compact('second', undefined, new AbortController().signal), { compacted: true })
  assert.equal(calls, 2)
  await registry.dispose()
  await rejected
})

function commandFixture() {
  type Result = { kind: 'success' | 'error'; text?: string }
  interface FixtureAgent {
    id: string
    busy: boolean
    session: { header: { cwd: string } }
    ctx: { inject(names: string[], apply: (scope: unknown) => void): { dispose(): void } }
    runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>
  }
  type Definition = { name: string; description: string; handler: (input: { agent: FixtureAgent; rawInput: string; signal: AbortSignal }) => Result | Promise<Result> }
  const events = new EventEmitter()
  const scoped = new Map<string, Definition>()
  const agents: FixtureAgent[] = []
  let nativeCalls = 0
  const native: Definition = { name: 'compact', description: 'Compact older conversation history', handler: () => { nativeCalls++; return { kind: 'success', text: 'native DSH' } } }
  const commands = { find: (agent: FixtureAgent) => scoped.get(agent.id) ?? native, register: () => () => undefined }
  const context = {
    get: (name: string) => name === 'commands' ? commands : name === 'agents' ? { list: () => agents } : undefined,
    on(name: string, listener: (payload: { agent: FixtureAgent }) => void) { events.on(name, listener); return () => events.off(name, listener) },
  }
  const create = (id: string) => {
    const agent = {
      id, busy: false, session: { header: { cwd: `/workspace/${id}` } },
      runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>) {
        if (this.busy) throw new Error('busy')
        this.busy = true
        return job(new AbortController().signal).finally(() => { this.busy = false })
      },
      ctx: { inject(_names: string[], apply: (scope: unknown) => void) {
        apply({ get: () => ({ register(definition: Definition) { scoped.set(id, definition); events.emit('commands/change'); return () => scoped.delete(id) } }) })
        return { dispose: () => { scoped.delete(id) } }
      } },
    }
    agents.push(agent)
    events.emit('agent/created', { agent })
    return agent
  }
  const run = (agent: FixtureAgent, rawInput = '', signal = new AbortController().signal) => commands.find(agent).handler({ agent, rawInput, signal })
  return { context, create, run, events, nativeCalls: () => nativeCalls }
}

test('DSH /compact uses scoped native maintenance, preserves DSH fallback and unregisters on unload', async () => {
  const f = commandFixture()
  const dsh = f.create('dsh')
  const codex = f.create('codex')
  const calls: unknown[] = []
  assert.equal(supportsSessionCompaction(f.context), true)
  const dispose = createSessionCompactionAdapter(f.context).install({
    supports: id => id !== 'dsh',
    async compact(id, cwd) { calls.push([id, cwd]); return { kind: 'success', text: 'compacted' } },
    error: kind => ({ kind: 'error', text: kind }),
  })
  assert.equal((await f.run(dsh)).text, 'native DSH')
  assert.equal((await f.run(codex)).text, 'compacted')
  assert.deepEqual(calls, [['codex', '/workspace/codex']])
  assert.equal((await f.run(codex, ' unexpected')).text, 'usage')
  codex.busy = true
  assert.equal((await f.run(codex)).text, 'busy')
  codex.busy = false
  assert.equal((await f.run(codex, '', AbortSignal.abort())).text, 'cancelled')
  const claude = f.create('claude-code')
  assert.equal((await f.run(claude)).text, 'compacted')
  await dispose()
  assert.equal((await f.run(codex)).text, 'native DSH')
  assert.equal(f.nativeCalls(), 2)
  assert.equal(f.events.listenerCount('agent/created'), 0)
})

test('DSH command unload cancels maintenance and reports failure without invoking native DSH summarization', async () => {
  const f = commandFixture()
  const codex = f.create('codex')
  const started = Promise.withResolvers<void>()
  const dispose = createSessionCompactionAdapter(f.context).install({
    supports: () => true,
    async compact(_id, _cwd, signal) {
      started.resolve()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
    error: kind => ({ kind: 'error', text: kind }),
  })
  const operation = f.run(codex)
  await started.promise
  await dispose()
  assert.equal((await operation).text, 'cancelled')
  assert.equal(codex.busy, false)
  assert.equal(f.nativeCalls(), 0)
  assert.match(hostBrowserText('zh', 'compact.completed', { agent: 'Codex' }), /原生上下文已压缩/)
  assert.match(hostBrowserText('en', 'compact.completed', { agent: 'Codex' }), /native context compacted/)
})
