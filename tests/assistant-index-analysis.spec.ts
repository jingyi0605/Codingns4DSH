import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { AssistantIndexAnalysis } from '../data/build/dist/host/features/assistant-index-analysis.js'
import { AssistantIndexJournal } from '../data/build/dist/host/features/assistant-index-journal.js'
import type { AssistantLlmAdapter } from '../data/build/dist/dsh-capabilities/host/assistant-llm-adapter.js'
import type { AssistantIndexSnapshot, SessionIndexEntry } from '../data/build/dist/shared/contracts/assistant.js'
import { DEFAULT_ASSISTANT_PROMPTS } from '../data/build/dist/shared/assistant-prompts.js'

const model = { provider: 'api', model: 'chat', label: '模型' }
const index = (count: number): AssistantIndexSnapshot => ({
  generation: 7, scope: { status: 'ready', managedWorkspaceIds: ['w'] }, unreadableCount: 0,
  entries: Array.from({ length: count }, (_, number) => ({ hostId: 'local', sessionId: `s${number}`, title: `工作${number}`, workspaceId: 'w', workspaceName: '项目', running: false, completed: false, status: 'unknown', updatedAt: null, waiting: null, summary: `独立材料${number}` })),
})
const source = (system: string): SessionIndexEntry => {
  const facts = JSON.parse(system.split('<索引事实>\n')[1]!.split('\n</索引事实>')[0]!)
  assert.equal(facts.sessions.length, 1)
  assert.equal(facts.analysis, undefined)
  return facts.sessions[0]
}
const response = (entry: SessionIndexEntry): string => JSON.stringify({ schemaVersion: 1, sessions: [{
  hostId: entry.hostId, sessionId: entry.sessionId, objective: { text: entry.title, evidence: [{ source: 'title', quote: entry.title }] },
  progress: [{ text: '来源摘录已记录', evidence: [{ source: 'summary', quote: entry.summary }] }], blockers: [], pendingTasks: [], nextActions: [], openQuestions: ['这次工作的验证结果是什么？'],
}] })
const adapter = (reply: AssistantLlmAdapter['reply']): AssistantLlmAdapter => ({ catalog: async () => ({ models: [model], default: model, errors: [] }), indexOptions: async () => ({ maxTokens: 8192, reasoningEffort: 'off', thinking: 'disabled' }), reply })

test('35个会话各自独立请求、材料、预算与状态，有界并发不受文本聊天30轮容量影响', async (t) => {
  const seen: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let active = 0; let maxActive = 0
  const service = new AssistantIndexAnalysis(adapter(async (_model, system, _messages, _signal, onText, options) => {
    active += 1; maxActive = Math.max(maxActive, active)
    const entry = source(system); seen.push(entry.sessionId)
    assert.equal(options?.maxTokens, 8192)
    assert.equal(options?.reasoningEffort, 'off')
    onText('{"schemaVersion":1,')
    await gate
    active -= 1
    return response(entry)
  }))
  t.after(() => service.dispose())
  service.start(index(35), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate()
  assert.deepEqual(seen, ['s0', 's1'])
  assert.equal(service.read()?.tasks?.filter((task) => task.state === 'queued').length, 33)
  assert.equal(service.read()?.tasks?.filter((task) => task.state === 'running').length, 2)
  assert.equal(service.read()?.result, undefined)
  release(); await setImmediate()
  const done = service.read()!
  assert.equal(done.state, 'completed')
  assert.equal(maxActive, 2)
  assert.equal(new Set(seen).size, 35)
  assert.equal(done.result?.sessions.length, 35)
  assert.equal(done.tasks?.every((task) => task.state === 'completed' && task.thinking === 'disabled'), true)
  assert.equal(new Set(done.tasks?.map((task) => task.requestId)).size, 35)
})

test('单个会话达到输出上限不阻断其他会话，原文和成功结果分别保留，记录排除正文', async (t) => {
  const snapshot = index(3)
  const journal = new AssistantIndexJournal()
  journal.complete(journal.begin('manual', ['w']), snapshot, [], new Map())
  const service = new AssistantIndexAnalysis(adapter(async (_model, system) => {
    const entry = source(system)
    if (entry.sessionId === 's1') throw new Error('LLM 回复达到长度上限 token: private-key')
    return response(entry)
  }))
  t.after(() => service.dispose())
  service.start(snapshot, {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, (run) => journal.updateAnalysis(run))
  await setImmediate()
  const done = service.read()!
  assert.equal(done.state, 'failed')
  assert.deepEqual(done.tasks?.map((task) => task.state), ['completed', 'failed', 'completed'])
  assert.deepEqual(done.result?.sessions.map((session) => session.sessionId), ['s0', 's2'])
  assert.ok(!done.error?.includes('private-key'))
  assert.equal(snapshot.entries[1]?.summary, '独立材料1')
  const record = journal.snapshot().records[0]!.analysis!
  assert.equal(record.tasks?.[1]?.state, 'failed')
  assert.ok(!JSON.stringify(record).includes('来源摘录已记录'))
  assert.ok(!JSON.stringify(record).includes('独立材料'))
})

test('单项90秒超时独立结算，忽略取消的模型也不会挂住队列或覆盖迟到结果', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let late!: () => void
  const gate = new Promise<void>((resolve) => { late = resolve })
  let signal!: AbortSignal
  const service = new AssistantIndexAnalysis(adapter(async (_model, system, _messages, abort) => {
    const entry = source(system)
    if (entry.sessionId === 's0') { signal = abort; await gate }
    return response(entry)
  }))
  t.after(() => service.dispose())
  service.start(index(4), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate()
  assert.equal(service.read()?.tasks?.filter((task) => task.state === 'completed').length, 3)
  t.mock.timers.tick(90_000); await setImmediate()
  assert.equal(signal.aborted, true)
  assert.equal(service.read()?.state, 'failed')
  assert.equal(service.read()?.tasks?.[0]?.state, 'cancelled')
  assert.match(service.read()?.tasks?.[0]?.error ?? '', /超过 90 秒/u)
  late(); await setImmediate()
  assert.equal(service.read()?.result?.sessions.length, 3)
  assert.equal(service.read()?.tasks?.[0]?.state, 'cancelled')
})

test('停止批次取消正在执行与排队任务，成功项保留，晚到与旧范围结果不污染下一代', async (t) => {
  const seen: string[] = []
  const signals: AbortSignal[] = []
  let late!: () => void
  const gate = new Promise<void>((resolve) => { late = resolve })
  const service = new AssistantIndexAnalysis(adapter(async (_model, system, _messages, signal) => {
    const entry = source(system); seen.push(entry.sessionId); signals.push(signal)
    if (entry.sessionId !== 's0') await gate
    return response(entry)
  }))
  t.after(() => service.dispose())
  const run = service.start(index(5), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate()
  const cancelled = service.cancel(run.requestId)
  assert.equal(cancelled.state, 'cancelled')
  assert.deepEqual(cancelled.tasks?.map((task) => task.state), ['completed', 'cancelled', 'cancelled', 'cancelled', 'cancelled'])
  assert.equal(cancelled.result?.sessions.length, 1)
  assert.equal(signals.slice(1).every((signal) => signal.aborted), true)
  const next = { ...index(1), generation: 8 }
  service.start(next, {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate()
  late(); await setImmediate()
  assert.equal(service.read()?.generation, 8)
  assert.equal(service.read()?.result?.sessions.length, 1)
  assert.equal(seen.includes('s3'), false)
  assert.equal(seen.includes('s4'), false)
})

test('目录读取期间停止或来源变化，迟到目录不得启动任何会话请求', async (t) => {
  for (const mode of ['cancel', 'scope'] as const) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let current = true; let calls = 0
    const service = new AssistantIndexAnalysis({
      async catalog() { await gate; return { models: [model], default: model, errors: [] } },
      async reply() { calls++; return '' },
    })
    t.after(() => service.dispose())
    const run = service.start(index(2), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => current, () => {})
    await setImmediate()
    if (mode === 'cancel') service.cancel(run.requestId)
    else current = false
    release(); await setImmediate()
    assert.equal(calls, 0)
    assert.equal(service.read()?.state, 'cancelled')
    assert.equal(service.read()?.tasks?.every((task) => task.state === 'cancelled'), true)
  }
})

test('能力解析期间范围变化必须在实际模型请求前复核', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let current = true; let calls = 0
  const service = new AssistantIndexAnalysis({
    ...adapter(async () => { calls++; return '' }),
    async indexOptions() { await gate; return { maxTokens: 8192, thinking: 'provider-default' } },
  })
  t.after(() => service.dispose())
  service.start(index(3), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => current, () => {})
  await setImmediate(); current = false; release(); await setImmediate()
  assert.equal(calls, 0)
  assert.equal(service.read()?.state, 'cancelled')
  assert.equal(service.read()?.tasks?.every((task) => task.state === 'cancelled'), true)
})

test('模型目录超过90秒会结算所有排队任务，迟到目录不重开批次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const service = new AssistantIndexAnalysis({
    async catalog() { await gate; return { models: [model], default: model, errors: [] } },
    async reply() { calls++; return '' },
  })
  t.after(() => service.dispose())
  service.start(index(2), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate(); t.mock.timers.tick(90_000); await setImmediate()
  assert.equal(service.read()?.state, 'failed')
  assert.equal(service.read()?.tasks?.every((task) => task.state === 'failed'), true)
  assert.match(service.read()?.error ?? '', /模型目录读取超过 90 秒/u)
  release(); await setImmediate()
  assert.equal(calls, 0)
  assert.equal(service.read()?.state, 'failed')
})
