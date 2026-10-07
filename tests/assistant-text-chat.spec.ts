import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createAssistantLlmAdapter, type AssistantLlmAdapter } from '../data/build/dist/dsh-capabilities/host/assistant-llm-adapter.js'
import { AssistantTextChat, createAssistantChatSystem } from '../data/build/dist/host/features/assistant-text-chat.js'
import { AssistantIndexJournal } from '../data/build/dist/host/features/assistant-index-journal.js'
import type { AssistantChatRun, AssistantIndexSnapshot, AssistantToolCall } from '../data/build/dist/shared/contracts/assistant.js'
import { createAssistantIndexSystem } from '../data/build/dist/host/features/assistant-prompts.js'
import { DEFAULT_ASSISTANT_PROMPTS } from '../data/build/dist/shared/assistant-prompts.js'
import { assistantMessageTimeline } from '../src/shared/assistant-message-timeline.js'

const model = { provider: 'native', model: 'chat', label: '已配置模型' }
const catalog = { models: [model], default: model, errors: [] }
const index: AssistantIndexSnapshot = {
  generation: 7, scope: { status: 'ready', managedWorkspaceIds: ['w1'] }, unreadableCount: 0,
  entries: [{ sessionId: 's1', title: '登录', workspaceId: 'w1', workspaceName: '项目一', hostId: 'local', running: false, completed: false, status: 'unknown', updatedAt: null, waiting: null, summary: '用户：检查登录；助理：正在检查 token: hidden-value' }],
  excludedTargets: [{ sessionId: 'secret-session', title: '范围外标题', workspaceId: 'w2', workspaceName: '范围外项目', hostId: 'local', archived: false }],
}
const request = (id = 'r1') => ({ requestId: id, ...model, generation: 7, messages: [{ role: 'user', text: '项目在做什么？' }] })

test('索引和对话使用独立的口语化前置提示词，同时保留未知状态与只读事实约束', () => {
  const chat = createAssistantChatSystem(index)
  const summary = createAssistantIndexSystem(index)
  assert.ok(chat.startsWith(DEFAULT_ASSISTANT_PROMPTS.chat))
  assert.ok(summary.startsWith(DEFAULT_ASSISTANT_PROMPTS.index))
  for (const system of [chat, summary]) {
    for (const text of ['口语', '排比', '不执行工具或派发任务', '状态 unknown']) assert.ok(system.includes(text), text)
    assert.ok(!system.includes('范围外标题'))
    assert.ok(!system.includes('hidden-value'))
  }
  assert.ok(chat.includes('表格'))
  assert.ok(summary.includes('只输出一个合法 JSON 对象'))
  assert.ok(createAssistantIndexSystem(index, '仅用两句说明进展。').startsWith('仅用两句说明进展。'))
  assert.throws(() => createAssistantChatSystem(index, 'a'.repeat(8001)), /8000/u)
})

function nativeAdapter(chunks: readonly Record<string, any>[], captured: Record<string, any>[] = [], resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<Record<string, any>>) {
  return createAssistantLlmAdapter({ get(name: string) {
    if (name === 'llm') return {
      listProviders: () => [{ id: 'native', name: '原生 API' }, { id: 'cli', name: '虚拟 CLI' }, { id: 'bad', name: '失败目录' }],
      listModels: async (provider: string) => { if (provider === 'bad') throw new Error('token: hidden-key'); return provider === 'cli' ? [] : [{ id: 'chat', name: '模型' }] },
      ...(resolveModelInfo === undefined ? {} : { resolveModelInfo }),
      async *stream(options: Record<string, any>) { captured.push(options); yield* chunks },
    }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'native', model: 'chat' }) }
    return undefined
  } }, '0.2.1-alpha.1')!
}

test('原生模型目录复用 DSH 默认选择，排除无模型的 CLI 并保留目录失败提示', async () => {
  const selected = await nativeAdapter([]).catalog()
  assert.equal(selected.models.length, 1)
  assert.deepEqual(selected.default, selected.models[0])
  assert.equal(selected.default?.provider, 'native')
  assert.match(selected.errors[0]!, /失败目录/u)
  assert.ok(!JSON.stringify(selected).includes('hidden-key'))
  assert.equal(createAssistantLlmAdapter({}, '0.2.1-alpha.1'), undefined)
  assert.equal(createAssistantLlmAdapter({ llm: { stream() {}, listProviders() {}, listModels() {} } }, '0.2.0-rc.2'), undefined)
})

test('真正调用原生流式 LLM，按 v4 构造多轮消息，文字块结束不重复追加正文', async () => {
  const captured: Record<string, any>[] = []
  const adapter = nativeAdapter([
    { type: 'reasoning-delta', index: 0, text: '内部思考' },
    { type: 'text-delta', index: 1, text: '正在' },
    { type: 'text-delta', index: 1, text: '检查登录。' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '正在检查登录。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ], captured)
  const partials: string[] = []
  const text = await adapter.reply(model, createAssistantChatSystem(index), [{ role: 'user', text: '进展？' }, { role: 'assistant', text: '检查中' }, { role: 'user', text: '依据是什么？' }], new AbortController().signal, (value) => partials.push(value))
  assert.equal(text, '正在检查登录。')
  assert.deepEqual(partials, ['正在', '正在检查登录。'])
  assert.equal(captured.length, 1)
  const wire = captured[0]!
  assert.equal(wire.provider, 'native')
  assert.deepEqual(wire.messages[0], { role: 'user', content: [{ type: 'text', text: '进展？' }] })
  assert.match(wire.messages[1].id, /^[0-9a-f-]{36}$/u)
  assert.deepEqual(wire.messages[1].source, { kind: 'model', provider: 'native', model: 'chat' })
  assert.ok(wire.system.includes('项目一'))
  assert.ok(wire.system.includes('unknown'))
  for (const excluded of ['secret-session', '范围外标题', 'hidden-value', '内部思考']) assert.ok(!wire.system.includes(excluded))
  for (const key of ['tools', 'sessionId', 'purpose', 'apiKey']) assert.equal(key in wire, false)
  assert.equal(wire.maxTokens, 2048)
  assert.equal('reasoningEffort' in wire, false)
})

test('索引按原生模型能力关闭思考，支持 off/none，未知能力不发送不支持的档位', async () => {
  const chunks = [{ type: 'text-delta', index: 0, text: '测试正文' }, { type: 'finish', reason: { kind: 'stop' } }]
  for (const effort of ['off', 'none', 'high', undefined]) {
    const captured: Record<string, any>[] = []
    const signal = new AbortController().signal
    const adapter = nativeAdapter(chunks, captured, async (provider, id, received) => {
      assert.equal(provider, model.provider); assert.equal(id, model.model); assert.equal(received, signal)
      return effort === undefined ? {} : { reasoning: { efforts: [{ id: effort }] } }
    })
    const limits = await adapter.indexOptions!(model, signal)
    const disabled = effort === 'off' || effort === 'none'
    assert.equal(limits.thinking, disabled ? 'disabled' : 'provider-default')
    await adapter.reply(model, '索引', [], signal, () => {}, limits)
    assert.equal(captured[0]!.maxTokens, 8192)
    assert.equal(captured[0]!.reasoningEffort, disabled ? effort : undefined)
    assert.equal('reasoningEffort' in captured[0]!, disabled)
    assert.equal('thinking' in captured[0]!, false)
  }
  assert.deepEqual(await nativeAdapter([]).indexOptions!(model, new AbortController().signal), { maxTokens: 8192, thinking: 'provider-default' })
})

test('能力解析错误明确失败，取消后的能力查询和回复不得进入原生服务', async () => {
  const adapter = nativeAdapter([], [], async () => { throw new Error('模型能力读取失败') })
  await assert.rejects(adapter.indexOptions!(model, new AbortController().signal), /模型能力读取失败/u)
  let queries = 0
  const captured: Record<string, any>[] = []
  const cancelled = nativeAdapter([], captured, async () => { queries++; return {} })
  const abort = new AbortController(); abort.abort(new Error('索引已取消'))
  await assert.rejects(cancelled.indexOptions!(model, abort.signal), /索引已取消/u)
  await assert.rejects(cancelled.reply(model, '', [], abort.signal, () => {}), /索引已取消/u)
  assert.equal(queries, 0)
  assert.equal(captured.length, 0)
})

test('原生 finish 错误、断流、空回复和工具请求不能被伪装成成功问答', async () => {
  const cases = [
    { chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: '模型鉴权失败' } } }], error: /模型鉴权失败/u },
    { chunks: [{ type: 'text-delta', index: 0, text: '半句' }], error: /完整文字回复/u },
    { chunks: [{ type: 'finish', reason: { kind: 'stop' } }], error: /完整文字回复/u },
    { chunks: [{ type: 'tool-call-delta', index: 0, name: 'dispatch' }], error: /不能执行工具/u },
    { chunks: [{ type: 'text-delta', index: 0, text: '未完成' }, { type: 'finish', reason: { kind: 'max-tokens' } }], error: /长度上限/u },
  ]
  for (const item of cases) await assert.rejects(nativeAdapter(item.chunks).reply(model, '只读问答', [{ role: 'user', text: '测试' }], new AbortController().signal, () => {}), item.error)
  const blocks = [{ type: 'block-end', index: 0, block: { type: 'text', text: '完整正文' } }, { type: 'finish', reason: { kind: 'stop' } }]
  assert.equal(await nativeAdapter(blocks).reply(model, '', [], new AbortController().signal, () => {}), '完整正文')
})

test('轮询在模型完成前读取实时文字，重复请求不重复调用，完成后可继续多轮', async (t) => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const calls: unknown[] = []
  const chat = new AssistantTextChat({ async catalog() { return catalog }, async reply(selected, system, messages, signal, onText) {
    calls.push({ selected, system, messages }); onText('部分正文'); await gate; signal.throwIfAborted(); return '完整回复'
  } })
  t.after(() => chat.dispose())
  const first = await chat.start(request(), index)
  assert.equal(first.state, 'running')
  assert.equal(chat.read('r1').text, '部分正文')
  await chat.start(request(), index)
  assert.equal(calls.length, 1)
  finish(); await setImmediate()
  assert.equal(chat.read('r1').state, 'completed')
  assert.equal(chat.read('r1').text, '完整回复')
  await chat.start({ ...request('r2'), messages: [{ role: 'user', text: '进展' }, { role: 'assistant', text: '完整回复' }, { role: 'user', text: '继续解释' }] }, index)
  await setImmediate()
  assert.equal(calls.length, 2)
  assert.equal(chat.read('r2').state, 'completed')
})

test('过期索引、无效模型和无效历史在调用 LLM 前被拒绝', async (t) => {
  let calls = 0
  const chat = new AssistantTextChat({ async catalog() { return catalog }, async reply() { calls++; return '不应调用' } })
  t.after(() => chat.dispose())
  for (const invalid of [{ ...request(), generation: 6 }, { ...request(), model: 'unknown' }, { ...request(), messages: [{ role: 'assistant', text: '伪造' }] }, { ...request(), messages: [{ role: 'user', text: 'a'.repeat(8001) }] }]) await assert.rejects(chat.start(invalid, index))
  await assert.rejects(chat.start(request(), { ...index, scope: { status: 'empty', reason: 'no-managed-workspaces', message: '尚未选择任何工作区' } }))
  await assert.rejects(chat.start(request(), index, () => false), /范围或版本已变化/u)
  assert.equal(calls, 0)
  await assert.rejects(new AssistantTextChat(undefined).start(request(), index), /没有可用/u)
})

test('无正文时工具开始、完成和失败立即推送，更新同一调用保持顺序，取消屏蔽迟到事件', async (t) => {
  let report!: (call: AssistantToolCall) => void
  let finish!: (text: string) => void
  const chat = new AssistantTextChat({ async catalog() { return catalog }, async reply(_model, _system, _messages, _signal, _onText, _options, onTool) {
    report = onTool!
    return new Promise<string>((resolve) => { finish = resolve })
  } })
  t.after(() => chat.dispose())
  const updates: AssistantChatRun[] = []
  chat.subscribe((run) => updates.push(run))
  await chat.start(request(), index)
  const search: AssistantToolCall = { id: 'search', name: 'web_search', kind: 'web-search', state: 'running', startedAt: 1, finishedAt: null, arguments: '{"queries":["北京天气"]}', result: '' }
  report(search)
  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.text, '')
  assert.equal(updates[0]!.toolCalls![0]!.state, 'running')
  report({ ...search, id: 'workspace', name: 'assistant_list_workspaces', kind: 'workspace' })
  report({ ...search, state: 'completed', finishedAt: 2, result: '天气来源' })
  assert.equal(updates.length, 3, '工具事件不等待正文或模型结算')
  assert.deepEqual(updates[2]!.toolCalls!.map((call) => call.id), ['search', 'workspace'])
  assert.equal(updates[0]!.toolCalls![0]!.state, 'running', '旧快照不能被新状态改写')
  report({ ...search, id: 'failed', state: 'failed', finishedAt: 3, result: '提供商不可用' })
  assert.equal(updates[3]!.toolCalls![2]!.state, 'failed')
  chat.cancel('r1')
  const count = updates.length
  report({ ...search, state: 'completed', result: '迟到结果' })
  assert.equal(updates.length, count)
  finish('迟到正文'); await setImmediate()
  assert.equal(chat.read('r1').text, '')
  assert.equal(chat.read('r1').state, 'cancelled')
})

test('按工具首次开始时定位正文，后续状态不移动位置，完成 trim 不改变事件顺序', async (t) => {
  const first = '先搜索。\n'; const second = '再核对。\n'; const last = '最终回答。'
  const call: AssistantToolCall = { id: 'search', name: 'web_search', kind: 'web-search', state: 'running', startedAt: 1, finishedAt: null, arguments: '{}', result: '' }
  const chat = new AssistantTextChat({ async catalog() { return catalog }, async reply(_model, _system, _messages, _signal, onText, _options, onTool) {
    onText('  \n' + first); onTool!(call)
    onText('  \n' + first + second); onTool!({ ...call, id: 'next' })
    onTool!({ ...call, state: 'completed', finishedAt: 2, result: '搜索结果' })
    onText('  \n' + first + second + last + '  \n')
    return first + second + last
  } })
  t.after(() => chat.dispose())
  const updates: AssistantChatRun[] = []
  chat.subscribe((run) => updates.push(run))
  await chat.start(request(), index)
  const completed = await chat.wait('r1')
  assert.equal(updates[1]!.toolCalls![0]!.textOffset, ('  \n' + first).length)
  assert.equal(updates[4]!.toolCalls![0]!.textOffset, updates[1]!.toolCalls![0]!.textOffset)
  assert.deepEqual(completed.toolCalls!.map((tool) => tool.textOffset), [first.length, (first + second).length])
  assert.deepEqual(assistantMessageTimeline(completed.text, completed.toolCalls).map((part) => part.kind === 'text' ? part.text : part.call.id), [first, 'search', second, 'next', last])
})

test('异步读取模型期间范围变化或模块释放，不得随后启动模型', async () => {
  let resolveCatalog!: (value: typeof catalog) => void
  let calls = 0
  const adapter: AssistantLlmAdapter = { catalog: () => new Promise((resolve) => { resolveCatalog = resolve }), async reply() { calls++; return '不应调用' } }
  const chat = new AssistantTextChat(adapter)
  const pending = chat.start(request(), index)
  chat.dispose(); resolveCatalog(catalog)
  await assert.rejects(pending, /范围或版本已变化/u)
  assert.equal(calls, 0)
})

test('取消会中止模型信号；模型错误显示为失败并清理凭据', async (t) => {
  const chat = new AssistantTextChat({ async catalog() { return catalog }, reply(_selected, _system, _messages, signal) {
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  } })
  t.after(() => chat.dispose())
  await chat.start(request(), index)
  assert.equal(chat.cancel('r1').state, 'cancelled')
  await setImmediate()
  assert.equal(chat.read('r1').state, 'cancelled')
  const failing = new AssistantTextChat({ async catalog() { return catalog }, async reply() { throw new Error('模型服务失败 token: hidden-key') } })
  t.after(() => failing.dispose())
  await failing.start(request(), index); await setImmediate()
  assert.equal(failing.read('r1').state, 'failed')
  assert.match(failing.read('r1').error!, /模型服务失败/u)
  assert.ok(!failing.read('r1').error!.includes('hidden-key'))
})

test('索引材料只含范围内事实且有大小上限；运行记录有界并保留失败证据', () => {
  const system = createAssistantChatSystem(index)
  const facts = JSON.parse(system.split('<索引事实>\n')[1]!.split('\n</索引事实>')[0]!)
  assert.equal(facts.sessions[0].summary, '用户：检查登录；助理：正在检查 已隐藏敏感字段')
  assert.throws(() => createAssistantChatSystem({ ...index, entries: [{ ...index.entries[0]!, summary: 'a'.repeat(120001) }] }), /缩小索引范围/u)
  const journal = new AssistantIndexJournal()
  for (let number = 0; number < 35; number++) {
    const id = journal.begin('manual', ['w1'])
    if (number === 34) journal.fail(id, new Error('索引失败 token: private-key'))
    else journal.complete(id, { ...index, generation: number }, [], new Map())
  }
  const state = journal.snapshot()
  assert.equal(state.records.length, 30)
  assert.equal(state.records[0]?.state, 'failed')
  assert.ok(!JSON.stringify(state.records).includes('private-key'))
  assert.ok(!JSON.stringify(state.records).includes('hidden-value'))
  assert.equal(state.index?.generation, 33)
  assert.ok(state.indexedAt !== null)
})

test('模型超过 90 秒未完成时中止信号并保留明确的超时状态', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal!: AbortSignal
  const chat = new AssistantTextChat({ async catalog() { return catalog }, reply(_model, _system, _messages, abort) {
    signal = abort
    // 即使供应商没有响应中止，轮询也必须能看见终止状态。
    return new Promise<string>(() => {})
  } })
  t.after(() => chat.dispose())
  await chat.start(request(), index)
  t.mock.timers.tick(90_000)
  assert.equal(signal.aborted, true)
  assert.equal(chat.read('r1').state, 'cancelled')
  assert.match(chat.read('r1').error!, /超过 90 秒/u)
})
