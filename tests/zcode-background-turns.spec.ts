import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createCodingNsNativeSessionBridge } from '../data/build/dist/host/native-session-bridge.js'
import { externalTurnMessage, readExternalTurn, externalTurnSyncState } from '../data/build/dist/host/cli-adapters/background-turn.js'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZcodeBackgroundReplies, recoverZcodeBackgroundReplies } from '../data/build/dist/host/cli-adapters/zcode-background-recovery.js'

function fixture(options: { workflow?: boolean; segmented?: boolean } = {}) {
  let emit!: (message: any) => void
  const calls: any[] = [], replies: any[] = []
  let seq = 0, userTurn = 0
  const driver = new ZcodeAppServerDriver({ desktopRuntime: null, binaries: ['fixture-zcode'],
    spawnSync: (() => ({ status: 0, stdout: '0.17.1', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      emit = message => stdout.write(JSON.stringify(message) + '\n')
      return { stdout, stderr, stdin: { write(line: string) {
        const r = JSON.parse(line); calls.push(r)
        if (!r.method) { replies.push(r); return }
        let result: any = {}
        if (r.method === 'workspace/updateDynamicWorkflowPolicy') {
          if (!options.workflow) { emit({ id: r.id, error: { code: -32601, message: 'Method not found' } }); return }
          result = { enabled: true }
        }
        if (r.method === 'session/create') result = { session: { sessionId: 'native-parent' } }
        if (r.method === 'session/send') {
          const id = `user-turn-${++userTurn}`
          event(id, 'turn.started')
          event(id, 'model.streaming', { kind: 'text_delta', delta: '已启动' })
          if (options.segmented) {
            event(id, 'part.upserted', { part: { type: 'step-finish', reason: 'tool-calls' } })
            event(id, 'model.streaming', { kind: 'text_delta', delta: '续段完成' })
          }
          event(id, 'turn.completed')
        }
        emit({ id: r.id, result })
      } }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  function event(turnId: string, type: string, payload: any = {}, sessionId = 'native-parent', eventId?: string) {
    emit({ method: 'session/event', params: { sessionId, turnId, eventId: eventId ?? `e${++seq}`, type, payload } })
  }
  const input = { sessionId: 'dsh-parent', prompt: '只读测试', messages: [] }
  const collect = async (extra = {}) => { const events = []; for await (const e of driver.executeTurn({ ...input, ...extra })) events.push(e); return events }
  return { driver, event, collect, calls, replies, emit: (m: any) => emit(m) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('workflow policy is negotiated before creation, and older CLIs keep ordinary turns', async () => {
  for (const workflow of [true, false]) {
    const f = fixture({ workflow })
    try {
      await f.collect()
      const policy = f.calls.findIndex(c => c.method === 'workspace/updateDynamicWorkflowPolicy')
      const create = f.calls.findIndex(c => c.method === 'session/create')
      assert.ok(policy >= 0 && policy < create)
      assert.equal(f.calls[create].params.dynamicWorkflowEnabled, workflow ? true : undefined)
      const content = f.calls.find(c => c.method === 'session/send').params.content
      assert.equal(content.includes('CreateWorkflow'), workflow)
    } finally { f.driver.dispose() }
  }
})

test('a ZCode step boundary retains the transport queue and finishes only after the final response', async () => {
  const f = fixture({ segmented: true })
  try {
    const out = await f.collect({ splitToolSteps: true })
    assert.equal(out.filter(e => e.type === 'step-boundary').length, 1)
    assert.deepEqual(out.filter(e => e.type === 'text-delta').map(e => e.text), ['已启动', '续段完成'])
    assert.equal(out.filter(e => e.type === 'finish').length, 1)
    assert.equal(out.at(-1)?.type, 'finish')
    assert.equal(f.calls.filter(c => c.method === 'session/send').length, 1)
  } finally { f.driver.dispose() }
})

test('foreground closes, native background reply reaches a fresh stream without another send', { timeout: 5000 }, async () => {
  const f = fixture(), ready: any[] = []
  try {
    f.driver.subscribeBackgroundTurns(t => ready.push(t))
    assert.equal((await f.collect()).at(-1)?.type, 'finish')
    f.event('background-1', 'turn.started')
    f.event('background-1', 'model.streaming', { kind: 'text_delta', delta: '工作流完成总结' })
    f.event('background-1', 'turn.completed')
    await tick()
    assert.equal(ready.length, 1)
    assert.equal(ready[0].sessionId, 'dsh-parent')
    const events = await f.collect({ externalTurnId: ready[0].turnId })
    assert.equal(events.filter(e => e.type === 'text-delta').map(e => e.text).join(''), '工作流完成总结')
    assert.equal(events.filter(e => e.type === 'finish').length, 1)
    assert.equal(f.calls.filter(c => c.method === 'session/send').length, 1)
    assert.equal(f.calls.filter(c => c.method === 'session/subscribe').length, 1)
  } finally { f.driver.dispose() }
})

test('deduplicate native events, isolate child sessions and preserve two successive background turns', { timeout: 5000 }, async () => {
  const f = fixture(), ready: any[] = []
  try {
    f.driver.subscribeBackgroundTurns(t => ready.push(t)); await f.collect()
    f.event('child-turn', 'turn.started', {}, 'unrelated-child')
    f.event('child-turn', 'model.streaming', { kind: 'text_delta', delta: '不能显示' }, 'unrelated-child')
    for (const id of ['bg-a', 'bg-b']) {
      f.event(id, 'turn.started')
      f.event(id, 'model.streaming', { kind: 'text_delta', delta: id }, 'native-parent', id + '-text')
      f.event(id, 'model.streaming', { kind: 'text_delta', delta: id }, 'native-parent', id + '-text')
      f.event(id, 'turn.completed')
    }
    await tick(); assert.equal(ready.length, 2)
    for (const r of ready) {
      const out = await f.collect({ externalTurnId: r.turnId })
      assert.equal(out.filter(e => e.type === 'text-delta').length, 1)
    }
    const again = await f.collect({ externalTurnId: ready[0].turnId })
    assert.equal(again.filter(e => e.type === 'text-delta').length, 0)
    assert.equal(f.calls.filter(c => c.method === 'session/send').length, 1)
  } finally { f.driver.dispose() }
})

test('background user question waits and answers over the original native transport', { timeout: 5000 }, async () => {
  const f = fixture(), ready: any[] = []
  try {
    f.driver.subscribeBackgroundTurns(t => ready.push(t)); await f.collect()
    f.event('bg-question', 'turn.started'); await tick()
    f.emit({ id: 'question-rpc', method: 'interaction/requestUserInput', params: {
      sessionId: 'native-parent', requestId: 'bg-question-request', toolCallId: 'bg-call', toolName: 'AskUserQuestion',
      schema: { toolName: 'AskUserQuestion' }, questions: [{ question: '检查完成？', header: '检查', options: [{ label: '完成', value: 'yes' }, { label: '继续', value: 'no' }] }],
    } })
    const events = []
    for await (const e of f.driver.executeTurn({ sessionId: 'dsh-parent', prompt: '', messages: [], externalTurnId: ready[0].turnId })) {
      events.push(e)
      if (e.type === 'question-request') {
        f.driver.respondQuestion('dsh-parent', { requestId: e.requestId, answers: [{ id: 'question-1', selected: ['完成'] }] })
        f.event('bg-question', 'model.streaming', { kind: 'text_delta', delta: '已检查' }); f.event('bg-question', 'turn.completed')
      }
    }
    await tick()
    assert.equal(events.filter(e => e.type === 'question-request').length, 1)
    assert.equal(f.replies.find(r => r.id === 'question-rpc')?.result.action, 'accept')
    assert.equal(f.calls.filter(c => c.method === 'session/send').length, 1)
  } finally { f.driver.dispose() }
})

test('a concurrent user message drains pending automatic output before its own send', { timeout: 5000 }, async () => {
  const f = fixture(), ready: any[] = []
  try {
    f.driver.subscribeBackgroundTurns(t => ready.push(t)); await f.collect()
    f.event('bg-before-user', 'turn.started')
    f.event('bg-before-user', 'model.streaming', { kind: 'text_delta', delta: '后台结果' })
    f.event('bg-before-user', 'turn.completed'); await tick()
    const out = await f.collect()
    assert.deepEqual(out.filter(e => e.type === 'text-delta').map(e => e.text), ['后台结果', '已启动'])
    assert.equal(out.filter(e => e.type === 'finish').length, 1)
    assert.equal((await f.collect({ externalTurnId: ready[0].turnId })).filter(e => e.type === 'text-delta').length, 0)
    assert.equal(f.calls.filter(c => c.method === 'session/send').length, 2)
  } finally { f.driver.dispose() }
})

test('DSH followup marker reaches the real feature routing/projector and never becomes a native prompt', { timeout: 10000 }, async () => {
  const f = fixture(), inbox: any[] = [], events: any[] = []
  let listener: any
  const session = { header: { id: 'dsh-parent', version: 4 }, snapshotEvents: () => events, append: (type: string, data: any) => { const e = { type, data, seq: events.length }; events.push(e); return e } }
  const context = { get(name: string) {
    if (name === 'sessions') return { get: () => session, list: () => [session] }
    if (name === 'agents') return { get: () => ({ followup: (m: any) => inbox.push(m) }) }
    return undefined
  } }
  const native = createCodingNsNativeSessionBridge(context as never)
  const registry = new CodingNsCliAdapterRegistry([f.driver], {}, { nativeSessions: native })
  const features = new FeatureRegistry({ rpc: new CodingNsRpcTable(), nativeSessions: native,
    events: { on(name: string, fn: any) { if (name === 'llm/stream') listener = fn; return () => {} } } } as never)
  features.register(createCliAdaptersFeature({ registry }))
  try {
    await features.start('cliAdapters'); registry.setSession('dsh-parent', { adapterId: 'zcode' })
    const run = async (messages: any[]) => {
      const out: any[] = []
      for await (const c of listener({ sessionId: 'dsh-parent', messages }, async function* () { throw new Error('Unexpected model execution') })) out.push(c)
      return out
    }
    await run([{ role: 'user', content: '只读测试' }])
    f.event('native-completion', 'turn.started')
    f.event('native-completion', 'model.streaming', { kind: 'text_delta', delta: '完成并检查通过' })
    f.event('native-completion', 'turn.completed'); await tick(); await tick()
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].source.kind, 'codingns-external-turn')
    const out = await run([{ role: 'user', content: '只读测试' }, inbox[0]])
    assert.ok(JSON.stringify(out).includes('完成并检查通过'))
    assert.equal(out.filter(c => c.type === 'finish').length, 1)
    assert.equal(f.calls.filter(c => c.method === 'session/send').length, 1)
    // A carrier from an earlier provider cannot run the newly selected model.
    registry.setSession('dsh-parent', { adapterId: 'dsh' })
    assert.equal((await run([inbox[0]])).filter(c => c.type === 'finish').length, 1)
    assert.equal(f.calls.filter(c => c.method === 'session/send').length, 1)
  } finally { await features.disable('cliAdapters'); f.driver.dispose() }
})

test('durable inbox and completed native DSH replies acknowledge the same Provider turn', () => {
  const m = externalTurnMessage({ sessionId: 's', providerSessionId: 'native', turnId: 't' })
  assert.equal(readExternalTurn([m])?.turnId, 't')
  assert.equal(readExternalTurn([m, { role: 'user', source: { kind: 'user' }, content: '新的问题' }]), undefined)
  const key = JSON.stringify(['native', 't'])
  assert.ok(externalTurnSyncState([{ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [m] } }]).pending.has(key))
  const history = [{ type: 'turn/start' }, { type: 'user/message', data: m },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成' }] } } }]
  assert.ok(externalTurnSyncState(history).pending.has(key))
  assert.ok(externalTurnSyncState([...history, { type: 'turn/end', data: { reason: { kind: 'completed' } } }]).delivered.has(key))
  assert.equal(externalTurnSyncState([...history, { type: 'turn/end', data: { reason: { kind: 'cancelled' } } }]).delivered.size, 0)
  assert.ok(externalTurnSyncState([...history, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }]).suppressed.has(key))
})

test('read-only recovery finds completed workflow parent replies and preserves the native database', async () => {
  const root = new URL('../.agent-temp/2026-11-14-workflow-recovery/', import.meta.url)
  mkdirSync(root, { recursive: true })
  const path = join(mkdtempSync(join(fileURLToPath(root), 'db-')), 'fixture.sqlite')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);')
  const insert = db.prepare('INSERT INTO message VALUES(?,?,?,?)')
  insert.run('notice', 'native', 1, JSON.stringify({ role: 'user', metadata: { originMeta: { backgroundSource: 'workflow', workflowNotification: { kind: 'terminal' } } } }))
  insert.run('reply', 'native', 2, JSON.stringify({ role: 'assistant', parentID: 'notice', anchor: { turnId: 'turn-native' }, time: { completed: 3 } }))
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('text', 'native', 'reply', 2, JSON.stringify({ type: 'text', text: '真实完成总结' }))
  insert.run('unfinished', 'native', 4, JSON.stringify({ role: 'assistant', parentID: 'notice', time: {} }))
  db.close()
  const before = readFileSync(path)
  assert.deepEqual(readZcodeBackgroundReplies(path, 'native', 0), [{ turnId: 'turn-native', messageId: 'reply', text: '真实完成总结' }])
  assert.equal(readZcodeBackgroundReplies(path, 'unrelated', 0).length, 0)
  assert.equal((await recoverZcodeBackgroundReplies(path, 'native', 0)).length, 1)
  assert.deepEqual(readFileSync(path), before)
  const home = join(fileURLToPath(root), 'home-' + Date.now())
  mkdirSync(join(home, '.zcode/cli/db'), { recursive: true })
  copyFileSync(path, join(home, '.zcode/cli/db/db.sqlite'))
  const driver = new ZcodeAppServerDriver({ homeDirectory: home, spawn: (() => { throw Error('Recovery must never start a provider') }) as never })
  try {
    const replies = await driver.recoverBackgroundTurns('dsh-recovery', 'native', 0)
    driver.stageRecoveredBackgroundTurn('dsh-recovery', replies[0]!)
    const out = []
    for await (const e of driver.executeTurn({ sessionId: 'dsh-recovery', externalTurnId: 'turn-native', prompt: '', messages: [] })) out.push(e)
    assert.equal(out.find(e => e.type === 'text-snapshot')?.text, '真实完成总结')
    assert.equal(out.at(-1)?.type, 'finish')
  } finally { driver.dispose() }
})

test('automatic completion preserves its launching read-only permission despite a saved next-turn selection', { timeout: 5000 }, async () => {
  const f = fixture(), ready: any[] = []
  try {
    f.driver.subscribeBackgroundTurns(t => ready.push(t))
    await f.collect({ permission: { sandboxMode: 'read-only', approvalPolicy: 'never' } })
    f.event('bg-permission', 'turn.started'); await tick()
    f.emit({ id: 'perm-rpc', method: 'interaction/requestPermission', params: {
      sessionId: 'native-parent', requestId: 'bg-perm', toolCallId: 'perm-call', toolName: 'Write',
      input: { file_path: 'must-not-write', content: 'never' }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once', response: { decision: 'allow' } }],
    } })
    for await (const e of f.driver.executeTurn({ sessionId: 'dsh-parent', externalTurnId: ready[0].turnId, prompt: '', messages: [], permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' } })) {
      if (e.type === 'permission-request') {
        f.driver.respondPermission('dsh-parent', { requestId: e.requestId, approved: true })
        f.event('bg-permission', 'model.streaming', { kind: 'text_delta', delta: '写入未授权' }); f.event('bg-permission', 'turn.completed')
      }
    }
    await tick()
    assert.equal(f.replies.find(r => r.id === 'perm-rpc')?.result.decision, 'deny')
    assert.equal(f.calls.filter(c => c.method === 'session/setMode').at(-1).params.mode, 'plan')
  } finally { f.driver.dispose() }
})

test('cancelling a pending background question closes its native request and stream', { timeout: 5000 }, async () => {
  const f = fixture(), ready: any[] = [], abort = new AbortController()
  try {
    f.driver.subscribeBackgroundTurns(t => ready.push(t)); await f.collect()
    f.event('bg-cancel', 'turn.started'); await tick()
    f.emit({ id: 'cancel-question-rpc', method: 'interaction/requestUserInput', params: {
      sessionId: 'native-parent', requestId: 'cancel-question', toolName: 'AskUserQuestion', schema: { toolName: 'AskUserQuestion' },
      questions: [{ question: '继续？', header: '继续', options: [{ label: '是', value: 'yes' }, { label: '否', value: 'no' }] }],
    } })
    const out = []
    for await (const e of f.driver.executeTurn({ sessionId: 'dsh-parent', externalTurnId: ready[0].turnId, prompt: '', messages: [], signal: abort.signal })) {
      out.push(e)
      if (e.type === 'question-request') abort.abort()
    }
    await tick()
    assert.equal(out.at(-1)?.reason, 'cancel')
    assert.equal(f.replies.find(r => r.id === 'cancel-question-rpc')?.result.action, 'cancel')
    assert.equal(f.calls.filter(c => c.method === 'session/stop').length, 1)
  } finally { f.driver.dispose() }
})
