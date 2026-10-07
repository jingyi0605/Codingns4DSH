import assert from 'node:assert/strict'
import { memoryAssistantConversationStorage } from './assistant-fixtures.js'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createGlobalVoiceRpcFeature } from '../data/build/dist/host/features/global-voice-rpc.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { DEFAULT_ASSISTANT_PROMPTS } from '../data/build/dist/shared/assistant-prompts.js'
import type { AssistantDebugSnapshot } from '../data/build/dist/shared/contracts/assistant.js'
import type { CodingNsHostServices } from '../data/build/dist/host/features/types.js'

async function fixture(t: TestContext, initialRunning = false, unknown = false, remote = false, created = true) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const rows = new Map(['s1', 's2', 'outside', 'archived'].map((id) => [id, { id, running: initialRunning && id.startsWith('s'), updatedAt: 100, body: `材料-${id}-第一轮`, seq: 0 }]))
  let archived = ['archived']
  let members = ['s1', 's2', 'archived']
  let managed = ['w']
  let prompts = { ...DEFAULT_ASSISTANT_PROMPTS }
  let watch!: () => void
  let defaultModel = 'chat'
  let remoteActivity: 'running' | 'idle' | 'unknown' = 'idle'
  let resolving: Promise<void> | undefined
  let listedState: { running?: boolean; completed?: boolean; waiting?: 'question' | null; status?: string } = {}
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const reads: string[] = []
  const wire: { id: string; model: string; signal: AbortSignal; body: string }[] = []
  const holds = new Map<string, Promise<void>>()
  const failures = new Set<string>()
  const rpc = new CodingNsRpcTable()
  const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args)
  const llm = {
    listProviders: () => [{ id: 'api', name: 'API' }],
    listModels: async () => [{ id: 'chat', name: '模型' }, { id: 'alt', name: '其他模型' }],
    resolveModelInfo: async () => { await resolving; return { reasoning: { efforts: [{ id: 'off' }] } } },
    async *stream(options: Record<string, any>) {
      const facts = JSON.parse(options.system.split('<索引事实>\n')[1].split('\n</索引事实>')[0])
      assert.equal(facts.sessions.length, 1)
      const entry = facts.sessions[0]
      assert.equal(rows.get(entry.sessionId)?.running, false, '正在执行的会话绝不能调用索引模型')
      wire.push({ id: entry.sessionId, model: options.model, signal: options.signal, body: entry.summary })
      if (failures.has(entry.sessionId)) throw new Error('测试模型失败')
      await holds.get(entry.sessionId)
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ schemaVersion: 1, sessions: [{
        hostId: entry.hostId, sessionId: entry.sessionId,
        objective: { text: entry.title, evidence: [{ source: 'title', quote: entry.title }] },
        progress: [{ text: '材料已核对', evidence: [{ source: 'summary', quote: entry.summary }] }],
        blockers: [], pendingTasks: [], nextActions: [], openQuestions: [],
      }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const services = {
    rpc, dshVersion: '0.2.1-alpha.1',
    ...(!unknown && !remote ? { nativeSessions: { subscribe(handlers: { onEvent?: (session: unknown, event: unknown) => void; onFlush?: (session: unknown) => void }) {
      listeners.set('session/event', (session, event) => handlers.onEvent?.(session, event))
      listeners.set('session/flush', (session) => handlers.onFlush?.(session))
      return () => { listeners.delete('session/event'); listeners.delete('session/flush') }
    } } } : {}),
    ...(remote ? { assistantGateway: {
      async list() { return { sessions: [{ sessionId: 's1', hostId: 'peer', workspaceId: 'remote', workspaceName: '远端项目', title: '工作-s1', updatedAt: rows.get('s1')!.updatedAt, running: remoteActivity === 'running', completed: false, activity: remoteActivity, waiting: null, summary: null }], archivedSessionIds: [], readSummary: async () => { reads.push('s1'); return rows.get('s1')!.body } } },
    } } : {}),
    settings: { get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, ...(created ? { profile: { name: '测试助理', initialized: true, createdAt: 1 } } : {}), managedWorkspaceIds: managed, prompts } }), watch: (listener: () => void) => { watch = listener; return () => {} } },
    events: { on: (name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener); return () => listeners.delete(name) } },
    dshContext: { get(name: string) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'api', model: defaultModel }) }
      if (name === 'agents') return { get: (id: string) => unknown ? undefined : ({ status: rows.get(id)?.running ? 'running' : 'idle' }) }
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived, list: () => [
        { id: 'w', displayName: '项目', sessionIds: members, archivedSessionIds: archived },
        { id: 'other', displayName: '范围外', sessionIds: ['outside'] },
      ] }
      if (name === 'sessionController') return { list: () => ({ items: [...rows.values()].map((row) => ({ sessionId: row.id, title: `工作-${row.id}`, ...(unknown ? {} : { running: row.running }), ...(row.id === 's1' ? listedState : {}), updatedAt: row.updatedAt, blank: false })) }) }
      if (name === 'sessionQuery') return { readSurface: async (id: string) => { reads.push(id); return rows.get(id)!.body } }
      return undefined
    } },
  } as unknown as CodingNsHostServices
  if (remote) managed = ['remote']
  const registry = new FeatureRegistry(services); registry.register(createGlobalVoiceRpcFeature({ conversationStorage: memoryAssistantConversationStorage() }))
  await registry.reconcile(['globalVoiceRpc']); t.after(() => registry.reconcile([]))
  const call = async (endpoint: string, payload: unknown = {}) => { const entry = rpc.resolve(endpoint)!; return entry.handler(entry.action, payload) }
  const advance = async (ms = 5000) => { t.mock.timers.tick(ms); await setImmediate() }
  const change = (id: string, text: string) => { const row = rows.get(id)!; row.body = text; row.updatedAt++; emit('session/event', { id }, { type: 'user/message', seq: ++row.seq }) }
  const start = (id: string, text: string) => { const row = rows.get(id)!; row.running = true; emit('agent/status', { agent: { session: { id } }, status: 'running' }); change(id, text) }
  const end = (id: string) => { const row = rows.get(id)!; row.running = false; emit('session/event', { id }, { type: 'turn/end', seq: ++row.seq }); emit('agent/status', { agent: { session: { id } }, status: 'idle' }) }
  return { call, advance, emit, wire, reads, rows, change, start, end, failures,
    defaultModel: (model: string) => { defaultModel = model },
    remoteActivity: (activity: typeof remoteActivity) => { remoteActivity = activity },
    listedState: (state: typeof listedState) => { listedState = state },
    holdCapabilities: () => { let release!: () => void; resolving = new Promise((resolve) => { release = resolve }); return () => { resolving = undefined; release() } },
    snapshot: () => call('assistant/debug') as Promise<AssistantDebugSnapshot>,
    hold: (id: string) => { let release!: () => void; holds.set(id, new Promise((resolve) => { release = resolve })); return () => { holds.delete(id); release() } },
    setPrompt: () => { prompts = { ...prompts, index: '用短句提取有证据的结构化事实。' }; watch() },
    scope: (ids: string[]) => { managed = ids; watch() },
    archive: (id: string) => { archived = [...archived, id]; emit('workspace/archive', id) },
    add: (id: string) => { rows.set(id, { id, running: false, updatedAt: 100, body: `材料-${id}-第一轮`, seq: 0 }); members = [...members, id]; emit('workspace/changed') },
  }
}

test('缺少助理档案时，已有项目与会话完成通知不会自动读取正文或调用索引模型', async (t) => {
  const f = await fixture(t, false, false, false, false)
  await f.advance()
  f.end('s1')
  await f.advance()
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.wire, [])
})

test('完成后自动增量索引，运行中只记录版本，复用其他会话且不依赖调试窗口', async (t) => {
  const f = await fixture(t)
  await f.advance()
  assert.deepEqual(f.wire.map((item) => item.id), ['s1', 's2'])
  const initial = await f.snapshot(); assert.equal(initial.indexState, 'ready')
  assert.ok(initial.scopeSessions.every((entry) => entry.status === 'completed' && entry.indexState === 'completed'))
  assert.ok(initial.index.analysis?.result?.sessions.every((session) => session.sourceStatus === 'completed'))
  f.wire.length = 0; f.reads.length = 0
  f.start('s1', '材料-s1-第二轮')
  f.emit('session/event', { id: 's1' }, { type: 'step/end', seq: 99 })
  f.emit('session/flush', { id: 's1' })
  await f.advance(1500)
  assert.deepEqual(f.wire, []); assert.deepEqual(f.reads, [])
  await f.call('assistant/index/rebuild'); await setImmediate()
  assert.deepEqual(f.wire, [], '手动更新也不能绕过运行状态')
  const pending = await f.snapshot()
  assert.equal(pending.index.analysis?.tasks?.find((task) => task.sessionId === 's1')?.state, 'deferred')
  assert.equal(pending.scopeSessions[0]!.sourceVersion! > pending.scopeSessions[0]!.indexedVersion!, true)
  assert.equal(pending.scopeSessions[0]?.status, 'running')
  assert.equal(pending.scopeSessions[0]?.indexState, 'waiting')
  f.end('s1'); await f.advance(4999); assert.deepEqual(f.wire, [])
  await f.advance(1)
  assert.deepEqual(f.wire.map((item) => item.id), ['s1'])
  assert.deepEqual(f.reads, ['s1'])
  const updated = await f.snapshot()
  assert.equal(updated.indexState, 'ready')
  assert.equal(updated.index.analysis?.tasks?.find((task) => task.sessionId === 's2')?.reused, true)
  assert.equal(updated.scopeSessions[0]?.sourceVersion, updated.scopeSessions[0]?.indexedVersion)
  assert.equal(updated.scopeSessions[0]?.status, 'completed')
  assert.equal(updated.scopeSessions[0]?.indexState, 'completed')
})

test('多个完成通知合并为一个批次，重复通知、流式片段和范围外会话不新增模型调用', async (t) => {
  const f = await fixture(t); await f.advance()
  const count = (await f.snapshot()).records.length
  f.wire.length = 0
  for (const id of ['s1', 's2']) f.start(id, `材料-${id}-新轮次`)
  f.end('s1'); f.end('s2'); f.emit('api-session/status', 's1', false)
  await f.advance()
  assert.deepEqual(f.wire.map((item) => item.id), ['s1', 's2'])
  assert.equal((await f.snapshot()).records.length, count + 1)
  f.wire.length = 0; f.reads.length = 0
  f.emit('session/event', { id: 's1' }, { type: 'assistant/live-chunk' })
  f.emit('session/event', { id: 's1' }, { type: 'user/message', data: { source: { kind: 'runtime-context' } } })
  f.emit('session/event', { id: 's1' }, { type: 'step/end' })
  f.start('outside', '范围外材料'); f.end('outside')
  f.start('archived', '归档材料'); f.end('archived')
  f.emit('api-session/status', 's1', false); await f.advance(6000)
  assert.deepEqual(f.wire, []); assert.deepEqual(f.reads, [])
})

test('等待5秒期间面板刷新、元数据轮询和重复空闲通知不会不断延后索引', async (t) => {
  const f = await fixture(t); await f.advance(); f.wire.length = 0
  f.add('s3')
  await f.advance(2500)
  await f.snapshot(); await f.snapshot()
  f.emit('api-session/status', 's3', false)
  f.emit('session/flush', { id: 's3' })
  await f.advance(2499); assert.deepEqual(f.wire, [])
  await f.advance(1)
  assert.deepEqual(f.wire.map((entry) => entry.id), ['s3'])
})

test('结束后出现新的有效材料，从最后一次变化重新等待5秒', async (t) => {
  const f = await fixture(t); await f.advance(); f.wire.length = 0
  f.start('s1', '材料-s1-第二轮'); f.end('s1')
  await f.advance(2000)
  const row = f.rows.get('s1')!
  row.body = '材料-s1-第二轮收尾记录'; row.updatedAt++
  f.emit('session/update', 's1')
  await f.snapshot()
  await f.advance(3000); assert.deepEqual(f.wire, [], '原计时到期不能提前索引收尾材料')
  await f.advance(1999); assert.deepEqual(f.wire, [])
  await f.advance(1)
  assert.deepEqual(f.wire.map((entry) => [entry.id, entry.body]), [['s1', '材料-s1-第二轮收尾记录']])
})

test('材料未变只推进索引版本，模型或索引提示词改变才全量更新空闲会话', async (t) => {
  const f = await fixture(t); await f.advance(); f.wire.length = 0
  const body = f.rows.get('s1')!.body
  f.start('s1', body); f.end('s1'); await f.advance()
  assert.deepEqual(f.wire, [])
  assert.equal((await f.snapshot()).indexState, 'ready')
  await f.call('assistant/index/configure', { provider: 'api', model: 'alt' }); await f.advance()
  assert.deepEqual(f.wire.map((item) => [item.id, item.model]), [['s1', 'alt'], ['s2', 'alt']])
  f.wire.length = 0; f.start('s1', '材料-s1-第三轮'); f.setPrompt(); await f.advance()
  assert.deepEqual(f.wire.map((item) => item.id), ['s2'], '配置变化也必须等待运行会话结束')
  f.wire.length = 0; f.end('s1'); await f.advance()
  assert.deepEqual(f.wire.map((item) => item.id), ['s1'])
})

test('索引时会话再次运行只中止该项，迟到结果不能写入，新轮完成后再更新', async (t) => {
  const f = await fixture(t); await f.advance(); f.wire.length = 0
  const release = f.hold('s1')
  f.start('s1', '材料-s1-第二轮'); f.end('s1'); await f.advance()
  assert.equal(f.wire.length, 1)
  const oldSignal = f.wire[0]!.signal
  f.start('s1', '材料-s1-第三轮')
  assert.equal(oldSignal.aborted, true)
  release(); await setImmediate(); await f.advance(600)
  assert.equal(f.wire.length, 1)
  f.end('s1'); await f.advance()
  assert.equal(f.wire.length, 2)
  const done = await f.snapshot(); assert.equal(done.indexState, 'ready')
  assert.equal(done.index.analysis?.result?.sessions.find((session) => session.sessionId === 's1')?.progress[0]?.evidence[0]?.quote, '材料-s1-第三轮')
})

test('失败项不自动重试循环，成功项仍复用；手动重试只请求失败会话', async (t) => {
  const f = await fixture(t); f.failures.add('s1'); await f.advance()
  assert.equal((await f.snapshot()).indexState, 'incomplete')
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'failed')
  assert.equal((await f.snapshot()).scopeSessions[1]?.indexState, 'completed')
  const count = f.wire.length; await f.advance(20_000)
  assert.equal(f.wire.length, count)
  f.wire.length = 0
  f.start('s2', '材料-s2-新轮次'); f.end('s2'); await f.advance()
  assert.deepEqual(f.wire.map((item) => item.id), ['s2'], '其他会话更新不能自动重试未变化的失败项')
  assert.equal((await f.snapshot()).indexState, 'incomplete')
  f.failures.clear(); f.wire.length = 0
  await f.call('assistant/index/rebuild'); await setImmediate()
  assert.deepEqual(f.wire.map((item) => item.id), ['s1'])
  assert.equal((await f.snapshot()).indexState, 'ready')
})

test('初始正在运行的会话必须等待，新增与归档只调整对应成员', async (t) => {
  const f = await fixture(t, true); await f.advance()
  assert.deepEqual(f.wire, []); assert.deepEqual(f.reads, [])
  f.end('s1'); f.end('s2'); await f.advance()
  assert.equal((await f.snapshot()).indexState, 'ready')
  f.wire.length = 0; f.reads.length = 0
  f.add('s3'); await f.advance()
  assert.deepEqual(f.wire.map((item) => item.id), ['s3'])
  f.wire.length = 0; f.reads.length = 0
  f.archive('s1'); await f.advance()
  const removed = await f.snapshot(); assert.equal(removed.indexState, 'ready')
  assert.deepEqual(removed.index.entries.map((entry) => entry.sessionId), ['s2', 's3'])
  assert.deepEqual(f.wire, []); assert.deepEqual(f.reads, [])
})

test('未知状态不猜测完成，flush 也不放行，明确完成通知才启动索引', async (t) => {
  const f = await fixture(t, false, true); await f.advance()
  assert.deepEqual(f.wire, []); assert.deepEqual(f.reads, [])
  assert.equal((await f.snapshot()).scopeSessions[0]?.status, 'unknown')
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'waiting')
  f.emit('session/flush', { id: 's1' }); await f.advance()
  assert.deepEqual(f.wire, [])
  f.emit('session/complete', 's1'); await f.advance()
  assert.deepEqual(f.wire.map((entry) => entry.id), ['s1'])
  assert.equal((await f.snapshot()).scopeSessions[0]?.status, 'completed')
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'completed')
  assert.equal((await f.snapshot()).index.analysis?.tasks?.find((task) => task.sessionId === 's2')?.state, 'deferred')
})

test('原生 turn/end 独立证明本轮结束，不依赖额外 Agent 空闲通知', async (t) => {
  const f = await fixture(t, false, true); await f.advance()
  f.change('s1', '材料-s1-只有原生轮次事件')
  assert.equal((await f.snapshot()).scopeSessions[0]?.status, 'running')
  assert.deepEqual(f.wire, [])
  f.emit('session/event', { id: 's1' }, { type: 'turn/end', seq: 2 })
  const ended = await f.snapshot()
  assert.equal(ended.scopeSessions[0]?.status, 'completed')
  assert.equal(ended.scopeSessions[0]?.indexState, 'pending')
  await f.advance()
  assert.deepEqual(f.wire.map((entry) => entry.id), ['s1'])
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'completed')
})

test('会话状态通知支持明确 completed，并同步结果页的等待状态清除', async (t) => {
  const f = await fixture(t, false, true); await f.advance()
  f.emit('session/status', { sessionId: 's1', status: 'running' })
  f.emit('user-questions/request', { sessionId: 's1' })
  await f.call('assistant/index/rebuild')
  const waiting = await f.snapshot()
  assert.equal(waiting.scopeSessions[0]?.status, 'waiting')
  assert.equal(waiting.index.entries[0]?.status, 'waiting')
  f.emit('user-questions/resolved', { sessionId: 's1' })
  f.emit('session/status', 's1', 'completed')
  const ended = await f.snapshot()
  assert.equal(ended.scopeSessions[0]?.status, 'completed')
  assert.equal(ended.index.entries[0]?.status, 'completed')
  assert.equal(ended.index.entries[0]?.waiting, null)
  await f.advance()
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'completed')
})

test('元数据中的等待解除也会推进版本，旧等待索引能自动更新', async (t) => {
  const f = await fixture(t)
  f.listedState({ waiting: 'question' }); await f.advance()
  const waiting = await f.snapshot()
  assert.equal(waiting.scopeSessions[0]?.status, 'waiting')
  assert.equal(waiting.scopeSessions[0]?.indexState, 'waiting')
  f.listedState({ waiting: null })
  const resolved = await f.snapshot()
  assert.equal(resolved.scopeSessions[0]?.status, 'completed')
  assert.ok(resolved.scopeSessions[0]!.sourceVersion! > waiting.scopeSessions[0]!.sourceVersion!)
  await f.advance(5000); await f.advance()
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'completed')
})

test('状态名称必须完整匹配，incomplete 和 inactive 不冒充完成或运行', async (t) => {
  const f = await fixture(t, false, true)
  for (const status of ['incomplete', 'inactive']) {
    f.listedState({ status })
    assert.equal((await f.snapshot()).scopeSessions[0]?.status, 'unknown')
  }
  f.listedState({ status: 'idle' })
  assert.equal((await f.snapshot()).scopeSessions[0]?.status, 'completed')
})

test('实时 Agent 状态覆盖滞后列表，结果页同步运行状态但保留正文原版本', async (t) => {
  const f = await fixture(t); await f.advance()
  const original = await f.snapshot()
  f.listedState({ running: false, completed: true })
  f.start('s1', '材料-s1-新执行轮次')
  const active = await f.snapshot()
  assert.equal(active.scopeSessions[0]?.status, 'running')
  assert.equal(active.index.entries[0]?.status, 'running')
  assert.equal(active.index.entries[0]?.completed, false)
  assert.equal(active.index.entries[0]?.indexState, 'waiting')
  assert.equal(active.index.analysis?.result?.sessions.find((session) => session.sessionId === 's1')?.sourceStatus, 'running')
  assert.equal(active.index.entries[0]?.sourceVersion, original.index.entries[0]?.sourceVersion)
  assert.ok(active.scopeSessions[0]!.sourceVersion! > active.index.entries[0]!.sourceVersion!)
  f.listedState({ running: true, completed: false }); f.end('s1')
  const ended = await f.snapshot()
  assert.equal(ended.scopeSessions[0]?.status, 'completed')
  assert.equal(ended.scopeSessions[0]?.indexState, 'stale')
  await f.advance()
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'completed')
})

test('会话完成与索引运行、停止分别同步，停止后不能显示索引完成', async (t) => {
  const f = await fixture(t)
  const initial = await f.snapshot()
  assert.equal(initial.scopeSessions[0]?.status, 'completed')
  assert.equal(initial.scopeSessions[0]?.indexState, 'pending')
  const release = f.hold('s1'); t.after(release)
  await f.advance()
  const active = await f.snapshot()
  assert.equal(active.scopeSessions[0]?.status, 'completed')
  assert.equal(active.scopeSessions[0]?.indexState, 'running')
  assert.equal(active.scopeSessions[1]?.indexState, 'completed')
  await f.call('assistant/index/cancel', { requestId: active.index.analysis!.requestId })
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'cancelled')
  release(); await setImmediate()
  assert.equal((await f.snapshot()).scopeSessions[0]?.indexState, 'cancelled')
})

test('调整受管工作区只索引新增成员，保留共同成员的材料和模型结果', async (t) => {
  const f = await fixture(t); await f.advance(); f.wire.length = 0; f.reads.length = 0
  f.scope(['w', 'other']); await f.advance()
  assert.deepEqual(f.wire.map((entry) => entry.id), ['outside'])
  assert.deepEqual(f.reads, ['outside'])
  f.wire.length = 0; f.reads.length = 0
  f.scope(['w']); await f.advance()
  const snapshot = await f.snapshot()
  assert.equal(snapshot.indexState, 'ready')
  assert.deepEqual(snapshot.index.entries.map((entry) => entry.sessionId), ['s1', 's2'])
  assert.deepEqual(f.wire, []); assert.deepEqual(f.reads, [])
})

test('未显式选择索引模型时，DSH 默认模型变化自动全量更新', async (t) => {
  const f = await fixture(t); await f.advance(); f.wire.length = 0
  f.defaultModel('alt'); await f.advance(5000); await f.advance()
  assert.deepEqual(f.wire.map((entry) => entry.model), ['alt', 'alt'])
})

test('远端元数据轮询发现变化，请求前复核可拦截能力读取期间的新轮次', async (t) => {
  const f = await fixture(t, false, false, true); await f.advance()
  assert.equal(f.wire.length, 1); f.wire.length = 0
  f.rows.get('s1')!.body = '材料-s1-远端第二轮'; f.rows.get('s1')!.updatedAt++
  const release = f.holdCapabilities()
  await f.advance(5000); await f.advance()
  f.remoteActivity('running'); f.rows.get('s1')!.running = true
  release(); await setImmediate()
  assert.deepEqual(f.wire, [], '完成确认过期时不能发送真实模型请求')
  f.remoteActivity('idle'); f.rows.get('s1')!.running = false
  await f.advance(5000); await f.advance()
  assert.equal(f.wire.length, 1)
  assert.equal((await f.snapshot()).indexState, 'ready')
})

test('远端失去执行状态证明时不把历史 idle 当作当前完成，恢复证明后才更新', async (t) => {
  const f = await fixture(t, false, false, true); await f.advance(); f.wire.length = 0
  f.remoteActivity('unknown'); f.rows.get('s1')!.updatedAt++; f.rows.get('s1')!.body = '材料-s1-状态未知期间'
  await f.advance(5000); await f.advance()
  assert.deepEqual(f.wire, [])
  f.remoteActivity('idle'); await f.advance(5000); await f.advance()
  assert.equal(f.wire.length, 1)
})

test('远端执行状态失去证明时，即使材料版本未变也不能继续显示索引就绪', async (t) => {
  const f = await fixture(t, false, false, true); await f.advance()
  assert.equal((await f.snapshot()).indexState, 'ready')
  f.remoteActivity('unknown')
  const unknown = await f.snapshot()
  assert.equal(unknown.scopeSessions[0]?.status, 'unknown')
  assert.equal(unknown.scopeSessions[0]?.indexState, 'waiting')
  assert.equal(unknown.indexState, 'incomplete')
  await assert.rejects(f.call('assistant/chat/start'), /索引/u)
  f.remoteActivity('idle')
  assert.equal((await f.snapshot()).indexState, 'ready')
})
