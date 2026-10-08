import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { AssistantIndexAnalysis } from '../data/build/dist/host/features/assistant-index-analysis.js'
import { AssistantIndexJournal } from '../data/build/dist/host/features/assistant-index-journal.js'
import type { AssistantLlmAdapter } from '../data/build/dist/dsh-capabilities/host/assistant-llm-adapter.js'
import { AssistantLlmRequestError } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import { assistantSessionKey } from '../src/host/features/assistant-index-updates.js'
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
  t.mock.method(Math, 'random', () => 0.5)
  let late!: () => void
  const gate = new Promise<void>((resolve) => { late = resolve })
  const signals: AbortSignal[] = []
  const service = new AssistantIndexAnalysis(adapter(async (_model, system, _messages, abort, onText) => {
    const entry = source(system)
    if (entry.sessionId === 's0') { signals.push(abort); await gate; onText('迟到的旧尝试片段') }
    return response(entry)
  }))
  t.after(() => service.dispose())
  service.start(index(4), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate()
  assert.equal(service.read()?.tasks?.filter((task) => task.state === 'completed').length, 3)
  t.mock.timers.tick(90_000); await setImmediate()
  assert.equal(signals[0]?.aborted, true)
  assert.equal(service.read()?.state, 'running')
  t.mock.timers.tick(5_000); await setImmediate()
  assert.equal(signals.length, 2); assert.equal(signals[1]?.aborted, false)
  t.mock.timers.tick(90_000); await setImmediate()
  t.mock.timers.tick(20_000); await setImmediate()
  assert.equal(signals.length, 3)
  t.mock.timers.tick(90_000); await setImmediate()
  assert.equal(service.read()?.state, 'failed')
  assert.equal(service.read()?.tasks?.[0]?.state, 'failed')
  assert.equal(service.read()?.tasks?.[0]?.attempt, 3)
  assert.equal(signals.every((signal) => signal.aborted), true)
  assert.match(service.read()?.tasks?.[0]?.error ?? '', /超过 90 秒/u)
  late(); await setImmediate()
  assert.equal(service.read()?.result?.sessions.length, 3)
  assert.equal(service.read()?.tasks?.[0]?.state, 'failed')
  assert.equal(service.read()?.tasks?.[0]?.text, '', '旧尝试的流式片段也不能覆盖最终状态')
})

test('丢失 Markdown 原文标记后携带字段与原文反馈重试，成功项不重复调用', async (t) => {
  const base = index(2)
  const snapshot = { ...base, entries: [{ ...base.entries[0]!, summary: '用户：**问题从未真正渲染给你看**，因此没有作答。token: private-key' }, base.entries[1]!] }
  const counts = new Map<string, number>()
  const service = new AssistantIndexAnalysis(adapter(async (_model, system, messages) => {
    const entry = source(system)
    const count = (counts.get(entry.sessionId) ?? 0) + 1; counts.set(entry.sessionId, count)
    const raw = JSON.parse(response(entry))
    raw.sessions[0].progress[0].evidence[0].quote = entry.sessionId === 's0' ? '问题从未真正渲染给你看**，因此没有作答' : entry.summary
    if (entry.sessionId === 's0' && count === 1) raw.sessions[0].progress[0].evidence[0].quote = '问题从未真正渲染给你看，因此没有作答'
    if (entry.sessionId === 's0' && count === 2) {
      assert.match(messages[1]!.text, /\$\.sessions\[0\]\.progress\[0\]\.evidence\[0\]\.quote/u)
      assert.ok(messages[1]!.text.includes('**问题从未真正渲染给你看**'))
      assert.ok(!messages[1]!.text.includes('private-key'), '诊断片段也必须脱敏')
    }
    return JSON.stringify(raw)
  }))
  t.after(() => service.dispose())
  service.start(snapshot, {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate()
  assert.equal(service.read()?.state, 'completed')
  assert.equal(counts.get('s0'), 2); assert.equal(counts.get('s1'), 1)
  assert.equal(service.read()?.tasks?.[0]?.attempt, 2)
  assert.equal(service.read()?.tasks?.[0]?.error, null)
})

test('校验失败最多三次调用，自动新批次不重置预算，手动重试或新版本可重新尝试', async (t) => {
  const base = index(1)
  const snapshot = { ...base, entries: [{ ...base.entries[0]!, sourceVersion: 1 }] }
  let calls = 0; let valid = false
  const service = new AssistantIndexAnalysis(adapter(async (_model, system, _messages, _signal, onText) => {
    calls++; const text = valid ? response(source(system)) : '{}'; onText(text); return text
  }))
  t.after(() => service.dispose())
  const start = (next = snapshot, manual = false) => service.start(next, {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {}, undefined, undefined, manual)
  start(); await setImmediate()
  assert.equal(calls, 3); assert.equal(service.read()?.state, 'failed')
  assert.equal(service.read()?.tasks?.[0]?.text, '{}', '终态保留最后一次未通过校验的输出')
  start({ ...snapshot, generation: 8 }); await setImmediate()
  assert.equal(calls, 3); assert.equal(service.read()?.tasks?.[0]?.reused, true)
  assert.equal(service.read()?.tasks?.[0]?.attempt, 3)
  start({ ...snapshot, generation: 9, entries: [{ ...snapshot.entries[0]!, sourceVersion: 2 }] }); await setImmediate()
  assert.equal(calls, 6, '新来源版本有独立预算')
  valid = true
  start(undefined, true); await setImmediate()
  assert.equal(calls, 7); assert.equal(service.read()?.state, 'completed')
  assert.equal(service.read()?.tasks?.[0]?.attempt, 1)
})

test('格式纠正期间忽略上一尝试迟到的片段，成功结果只属于当前请求', async (t) => {
  let calls = 0; let oldText!: (text: string) => void; let oldSignal!: AbortSignal
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const service = new AssistantIndexAnalysis(adapter(async (_model, system, _messages, signal, onText) => {
    calls++
    if (calls === 1) { oldText = onText; oldSignal = signal; onText('{}'); return '{}' }
    onText('当前尝试的片段')
    await gate
    return response(source(system))
  }))
  t.after(() => service.dispose())
  service.start(index(1), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate()
  assert.equal(calls, 2); assert.equal(oldSignal.aborted, true)
  oldText('旧尝试的迟到片段')
  assert.equal(service.read()?.tasks?.[0]?.text, '当前尝试的片段')
  release(); await setImmediate()
  assert.equal(service.read()?.state, 'completed')
  assert.equal(service.read()?.tasks?.[0]?.text, '')
})

test('原生网络错误与请求失败均执行有限退避，第二次成功后停止重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.method(Math, 'random', () => 0.5)
  const failures = [
    new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
    Object.assign(new Error('原生传输故障'), { failure: { message: '原生传输故障', code: 'TRANSPORT' } }),
    new AssistantLlmRequestError({ message: '空回复', code: 'EMPTY_RESPONSE' }),
    new AssistantLlmRequestError({ message: '请求超时', code: 'UNKNOWN', status: 408 }),
  ]
  for (const failure of failures) {
    let calls = 0
    const service = new AssistantIndexAnalysis(adapter(async (_model, system) => {
      if (++calls === 1) throw failure
      return response(source(system))
    }))
    service.start(index(1), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
    await setImmediate()
    assert.equal(calls, 1)
    t.mock.timers.tick(5_000); await setImmediate()
    assert.equal(calls, 2); assert.equal(service.read()?.state, 'completed')
    t.mock.timers.tick(20_000); await setImmediate()
    assert.equal(calls, 2)
    service.dispose()
  }
})

test('限流尊重服务端等待，服务器故障退避重试，总调用不超过三次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); t.mock.method(Math, 'random', () => 0.5)
  const counts = new Map<string, number>()
  const service = new AssistantIndexAnalysis(adapter(async (_model, system) => {
    const entry = source(system)
    const count = (counts.get(entry.sessionId) ?? 0) + 1; counts.set(entry.sessionId, count)
    if (entry.sessionId === 's0' && count < 3) throw new AssistantLlmRequestError({ message: '临时故障', code: count === 1 ? 'RATE_LIMIT' : 'SERVER', status: count === 1 ? 429 : 503, ...(count === 1 ? { providerRetryAfterMs: 12_000 } : {}) })
    return response(entry)
  }))
  t.after(() => service.dispose())
  service.start(index(2), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
  await setImmediate()
  assert.equal(service.read()?.tasks?.[1]?.state, 'completed')
  assert.ok(service.read()?.tasks?.[0]?.nextRetryAt)
  t.mock.timers.tick(11_999); await setImmediate(); assert.equal(counts.get('s0'), 1)
  t.mock.timers.tick(1); await setImmediate(); assert.equal(counts.get('s0'), 2)
  t.mock.timers.tick(19_999); await setImmediate(); assert.equal(counts.get('s0'), 2)
  t.mock.timers.tick(1); await setImmediate()
  assert.equal(counts.get('s0'), 3); assert.equal(counts.get('s1'), 1)
  assert.equal(service.read()?.state, 'completed'); assert.equal(service.read()?.tasks?.[0]?.nextRetryAt, null)
})

test('账户、参数、未知错误和过长 Retry-After 不自动重试，不按错误正文猜测', async (t) => {
  const failures = [
    ...[400, 401, 402, 403, 404, 413, 422].map((status) => new AssistantLlmRequestError({ message: 'timeout 503 SERVER', code: 'SERVER', status })),
    ...['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED'].map((code) => new AssistantLlmRequestError({ message: '服务器故障', code })),
    new AssistantLlmRequestError({ message: '限流', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 61_000 }),
    new Error('timeout 429 网络错误'),
  ]
  for (const error of failures) {
    let calls = 0
    const service = new AssistantIndexAnalysis(adapter(async () => { calls++; throw error }))
    service.start(index(1), {}, DEFAULT_ASSISTANT_PROMPTS.index, () => true, () => {})
    await setImmediate()
    assert.equal(calls, 1); assert.equal(service.read()?.state, 'failed')
    service.dispose()
  }
})

test('等待重试时停止或来源开始运行立即取消等待，不再调用旧版本', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const operation of ['cancel', 'defer', 'scope'] as const) {
    let calls = 0; let current = true
    const service = new AssistantIndexAnalysis(adapter(async () => { calls++; throw new AssistantLlmRequestError({ message: '服务器故障', code: 'SERVER', status: 503 }) }))
    const snapshot = index(1)
    const run = service.start(snapshot, {}, DEFAULT_ASSISTANT_PROMPTS.index, () => current, () => {})
    await setImmediate()
    if (operation === 'cancel') service.cancel(run.requestId)
    if (operation === 'defer') service.deferSession(assistantSessionKey(snapshot.entries[0]!))
    if (operation === 'scope') current = false
    t.mock.timers.tick(25_000); await setImmediate()
    assert.equal(calls, 1)
    assert.equal(service.read()?.tasks?.[0]?.state, operation === 'defer' ? 'deferred' : 'cancelled')
    assert.equal(service.read()?.tasks?.[0]?.nextRetryAt, null)
    service.dispose()
  }
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
