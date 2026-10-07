import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AssistantAgentAdapter, createAssistantAgentAdapter, ASSISTANT_AGENT_PREFIX } from '../src/dsh-capabilities/host/assistant-agent-adapter.js'
import { createAssistantLlmAdapter } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createAssistantChatSystem } from '../src/host/features/assistant-prompts.js'
import type { AssistantLlmAdapter } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import type { AssistantManagementTool } from '../src/host/features/assistant-management-tools.js'

const model = { provider: 'api', model: 'fast', label: 'Fast' }
const llm: AssistantLlmAdapter = { catalog: async () => ({ models: [model], default: model, errors: [] }), assistantOptions: async () => ({ maxTokens: 1024, reasoningEffort: 'off' }), reply: async () => assert.fail('正式对话不得直接调用 LLM') }

function fixture(drive: (scope: any, message: any) => Promise<void>, inherited: readonly string[] = []) {
  const created: any[] = []
  let disposed = 0; let cancelled = 0
  const registry = { async create(options: any) {
    const listeners = new Map<string, (...args: any[]) => any>()
    const sections: any[] = []; const registered: AssistantManagementTool[] = []; const events: any[] = []
    const scope: any = { options, listeners, sections, registered, events, mode: '', filter: undefined, guard: undefined,
      tools: { schemas: () => inherited.map((name) => ({ name })), presentAs(mode: string) { scope.mode = mode }, restrict(filter: unknown) { scope.filter = filter }, register(tool: AssistantManagementTool) { registered.push(tool) }, guard(guard: unknown) { scope.guard = guard } },
      systemPrompt: { suppressRuntimeContext() { scope.suppressed = true }, section(section: unknown) { sections.push(section) } },
      on(name: string, listener: (...args: any[]) => any) { listeners.set(name, listener) },
      async step() { await listeners.get('agent/pre-step')!({}, async () => ({ kind: 'enter' })); return listeners.get('agent/request')!({}, async () => ({ provider: 'other', model: 'slow', reasoningEffort: 'high', maxTokens: 9999 })) },
      frame(frame: unknown) { listeners.get('agent/assistant-stream')!({ frame }) },
      output(text: string, attemptId = 'attempt') { scope.frame({ type: 'start', attemptId }); scope.frame({ type: 'chunk', attemptId, chunk: { type: 'text-delta', index: 0, text } }); scope.frame({ type: 'chunk', attemptId, chunk: { type: 'finish', reason: { kind: 'stop' } } }) },
    }
    let idle = Promise.resolve()
    const agent = { id: options.sessionId, session: { append(type: string, data: unknown) { events.push({ type, data }) } }, cancel() { cancelled++ },
      followup(message: any) { idle = drive(scope, message).catch((error) => { listeners.get('agent/error')!({ error }) }) }, whenIdle: () => idle }
    await options.setup(scope, agent)
    created.push(scope)
    return { agent, async dispose() { disposed++; await idle } }
  } }
  const adapter = new AssistantAgentAdapter(registry, llm, [], '/virtual/assistant', async () => {})
  return { adapter, registry, created, disposed: () => disposed, cancelled: () => cancelled }
}

test('只在助理根 Agent 设置 off、只读沙箱和原生管理工具，连续问答复用实例', async () => {
  const f = fixture(async (scope, message) => {
    assert.deepEqual(await scope.step(), { provider: 'api', model: 'fast', reasoningEffort: 'off', maxTokens: 1024 })
    assert.equal(message.role, 'user')
    scope.output('先核对权限。')
  })
  const ordinary = { model: 'slow', reasoningEffort: 'high', tools: ['bash', 'write', 'agent_subagent', 'run_code'] }
  const original = structuredClone(ordinary)
  const history: any[] = [{ role: 'user', text: '怎样处理？' }]
  await f.adapter.reply(model, '只管理会话', history, new AbortController().signal, () => {})
  history.push({ role: 'assistant', text: '先核对权限。' }, { role: 'user', text: '它是什么？' })
  await f.adapter.reply(model, '新的有效索引', history, new AbortController().signal, () => {})
  assert.equal(f.created.length, 1)
  const scope = f.created[0]
  assert.ok(scope.options.sessionId.startsWith(ASSISTANT_AGENT_PREFIX))
  assert.equal('parentAgent' in scope.options, false)
  assert.equal(scope.options.meta.cwd, '/virtual/assistant')
  assert.deepEqual(scope.events, [{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
  assert.deepEqual(scope.filter, { allow: [] })
  assert.equal(scope.mode, 'native')
  assert.equal(scope.suppressed, true)
  assert.equal(scope.sections[0].complete, true)
  assert.deepEqual(ordinary, original)
  for (const name of ordinary.tools) assert.equal(typeof scope.guard({ name }), 'string', name)
  await f.adapter.dispose()
})

test('仅继承原生联网搜索，运行身份按真实目录与工具注入，其他全局和后来注册的工具均屏蔽', async () => {
  const f = fixture(async (scope) => {
    await scope.step()
    assert.deepEqual(scope.filter, { allow: ['web_search'] })
    assert.equal(scope.guard({ name: 'web_search' }), undefined)
    for (const name of ['web_fetch', 'bash', 'agent_subagent', 'run_code', 'mcp_search', 'later_registered']) assert.equal(typeof scope.guard({ name }), 'string')
    const surface = ['web_search', 'web_fetch', 'bash', 'later_registered'].map((name) => ({ name }))
    const assembly = await scope.listeners.get('system-prompt/assemble')({}, {}, async () => ({ tools: surface }))
    assert.deepEqual(assembly.tools, [{ name: 'web_search' }])
    const prompt = scope.sections[0].text()
    const facts = JSON.parse(prompt.split('<助理运行事实>\n')[1].split('\n</助理运行事实>')[0])
    assert.equal(facts.runtime, 'DSH 原生 AgentLoop')
    assert.equal(facts.workingDirectory, '/virtual/assistant')
    assert.equal(facts.sessionId, scope.options.sessionId)
    assert.equal(facts.model.reasoningEffort, 'off')
    assert.deepEqual(facts.tools, ['web_search'])
    assert.match(facts.webSearch, /实际调用结果/)
    assert.ok(!Number.isNaN(Date.parse(facts.currentTimeUtc)))
    scope.output('我运行于 DSH，可以查公开信息。')
  }, ['web_search', 'web_fetch', 'bash', 'agent_subagent', 'mcp_search'])
  await f.adapter.reply(model, '本轮系统提示词', [{ role: 'user', text: '你能做什么？' }], new AbortController().signal, () => {})
  await f.adapter.dispose()
})

test('Host 没有注册搜索时保持管理问答可用，不把搜索权限或提供商凭据伪装成已就绪', async () => {
  const f = fixture(async (scope) => {
    await scope.step()
    assert.deepEqual(scope.filter, { allow: [] })
    assert.equal(typeof scope.guard({ name: 'web_search' }), 'string')
    assert.match(scope.sections[0].text(), /当前 Host 未注册联网搜索工具/)
    scope.output('当前没有可用的搜索工具。')
  }, ['web_fetch', 'bash'])
  await f.adapter.reply(model, '提示词', [{ role: 'user', text: '今天的新闻？' }], new AbortController().signal, () => {})
  await f.adapter.dispose()
})

test('超过九轮仍复用原生 Agent，自动压缩保留宿主的驱动与上下文，不按轮数重建', async () => {
  const f = fixture(async (scope) => { await scope.step(); scope.output('回答') })
  const history: any[] = []
  for (let round = 0; round < 15; round++) {
    const messages = [...history.slice(-18), { role: 'user', text: `问题 ${round}` }]
    const answer = await f.adapter.reply(model, '系统提示词', messages, new AbortController().signal, () => {})
    history.push(messages.at(-1), { role: 'assistant', text: answer })
  }
  assert.equal(f.created.length, 1); assert.equal(f.disposed(), 0)
  await f.adapter.dispose()
})

test('已保存模型传入原生助理 Agent 创建和实际请求，切换后重建实例并保留历史', async () => {
  const { configureAssistantSettings } = await import('../src/host/features/assistant-lifecycle-settings.js')
  const { DEFAULT_ASSISTANT_SETTINGS } = await import('../src/shared/contracts/config.js')
  const fixed = { provider: 'api', model: 'fixed', label: 'Fixed' }
  const catalog = { models: [model, fixed], default: model, errors: [] }
  const saved = configureAssistantSettings(DEFAULT_ASSISTANT_SETTINGS, { name: '哆哆', model: fixed, avatarId: 'codingns-default' }, catalog, [])
  const requests: any[] = []
  const f = fixture(async (scope) => { requests.push(await scope.step()); scope.output('回答') })
  try {
    await f.adapter.reply(model, '提示词', [{ role: 'user', text: '旧问题' }], new AbortController().signal, () => {})
    await f.adapter.reply({ ...saved.model!, label: 'Fixed' }, '提示词', [{ role: 'user', text: '旧问题' }, { role: 'assistant', text: '回答' }, { role: 'user', text: '新问题' }], new AbortController().signal, () => {})
    assert.equal(f.created.length, 2)
    assert.equal(f.created[1].options.agentOptions.provider, saved.model!.provider)
    assert.equal(f.created[1].options.agentOptions.model, saved.model!.model)
    assert.equal(requests.at(-1).model, 'fixed')
    assert.equal(f.disposed(), 1)
    assert.ok(f.created[1].sections[0].text().includes('旧问题'))
  } finally { await f.adapter.dispose() }
})

test('图片和文件引用进入原生 Agent 消息，文本附件工具仅能读取本助理已收到的文件', async () => {
  const image = { type: 'image' as const, attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: '图.png', bytes: 1, mediaType: 'image/png', width: 1, height: 1 } }
  const file = { type: 'file' as const, attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, name: '记录.txt', bytes: 6 } }
  const store = { async admitPromptContent() { return [] }, async admitEncodedFile() { return file.attachment }, async *readFileStream(ref: any) {
    assert.equal(ref.attachmentId, file.attachment.attachmentId); yield new TextEncoder().encode('记录')
  } }
  const f = fixture(async (scope, message) => {
    assert.deepEqual(message.content, [{ type: 'text', text: '分析附件' }, image, file])
    const tool = scope.registered.find((tool: AssistantManagementTool) => tool.name === 'assistant_read_attachment')
    assert.equal(scope.guard({ name: tool.name }), undefined)
    const context = { callId: 'file-read', signal: new AbortController().signal }
    await assert.rejects(tool.execute({ attachmentId: '/etc/passwd' }, context), /可读范围/)
    assert.deepEqual(await tool.execute({ attachmentId: file.attachment.attachmentId }, context), { name: '记录.txt', text: '记录', truncated: false })
    scope.output('附件已读取。')
  })
  const adapter = new AssistantAgentAdapter(f.registry, llm, [], '/virtual/assistant', async () => {}, store)
  await adapter.reply(model, '系统提示词', [{ role: 'user', text: '分析附件', attachments: [image, file] }], new AbortController().signal, () => {})
  await adapter.dispose()
})

test('管理 Agent 在一轮内多次查询工具，思考和工具块不进入流式文字', async () => {
  let calls = 0; let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tool: AssistantManagementTool = { name: 'assistant_list_sessions', description: '查询', parameters: {}, output: { schema: {}, render: () => [] }, execute: async () => { calls++; return { title: '权限验证', waiting: 'approval' } } }
  const f = fixture(async (scope) => {
    for (let step = 0; step < 2; step++) {
      await scope.step()
      assert.equal(scope.guard({ name: tool.name }), undefined)
      await scope.registered[0].execute({}, { callId: `q${step}`, signal: new AbortController().signal })
    }
    const assembly = await scope.listeners.get('system-prompt/assemble')({}, {}, async () => ({ tools: [{ name: tool.name }, { name: 'bash' }, { name: 'run_code' }, { name: 'extra-local' }] }))
    assert.deepEqual(assembly.tools, [{ name: tool.name }])
    scope.frame({ type: 'start', attemptId: 'a' })
    scope.frame({ type: 'chunk', attemptId: 'a', chunk: { type: 'reasoning-delta', index: 0, text: '不要播报推理' } })
    scope.frame({ type: 'chunk', attemptId: 'a', chunk: { type: 'tool-call-delta', index: 1, text: '不要播报参数' } })
    scope.frame({ type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', index: 2, text: '权限验证需要你审批。' } })
    await gate
    scope.frame({ type: 'chunk', attemptId: 'a', chunk: { type: 'text-delta', index: 2, text: '通过后再复测。' } })
    scope.frame({ type: 'chunk', attemptId: 'a', chunk: { type: 'finish', reason: { kind: 'stop' } } })
  })
  const adapter = new AssistantAgentAdapter(f.registry, llm, [tool], '/virtual/assistant', async () => {})
  const partial: string[] = []
  const result = adapter.reply(model, '系统提示词', [{ role: 'user', text: '哪些需要我处理？' }], new AbortController().signal, (text) => partial.push(text))
  await setImmediate()
  assert.deepEqual(partial, ['权限验证需要你审批。'], '模型完整结束前已经提供完整句子')
  release()
  assert.equal(await result, '权限验证需要你审批。通过后再复测。')
  assert.equal(calls, 2)
  await adapter.dispose()
})

test('取消后迟到的原生输出被丢弃，失败轮次重建且历史来自共享记录', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let round = 0
  const f = fixture(async (scope) => {
    await scope.step()
    if (++round === 1) await gate
    scope.output('新结果。')
  })
  const abort = new AbortController()
  const partial: string[] = []
  const task = f.adapter.reply(model, '提示词', [{ role: 'user', text: '旧问题' }], abort.signal, (text) => partial.push(text))
  await setImmediate()
  abort.abort(); release()
  await assert.rejects(task)
  assert.deepEqual(partial, [])
  assert.equal(f.cancelled(), 1)
  await f.adapter.reply(model, '提示词', [{ role: 'user', text: '新问题' }], new AbortController().signal, () => {})
  assert.equal(f.created.length, 2)
  await f.adapter.dispose()
})

test('无限工具循环达到八步时退出，不制造子 Agent 或切回直接 LLM', async () => {
  const f = fixture(async (scope) => { for (let step = 0; step < 20; step++) await scope.step() })
  await assert.rejects(f.adapter.reply(model, '提示词', [{ role: 'user', text: '检查' }], new AbortController().signal, () => {}), /步骤.*上限/)
  assert.equal(f.disposed(), 1)
  await f.adapter.dispose()
})

test('能力版本与结构缺失可解释，旧 Host 不开放新的 Agent 能力', async () => {
  const context = { agents: { create() {} }, tools: { register() {}, restrict() {}, guard() {}, presentAs() {} }, systemPrompt: { section() {}, suppressRuntimeContext() {} }, on() {} }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2']) assert.equal(createDshCapabilityRegistry(version, 'host', context).getProfile(context).capabilities.get('assistant.agent')?.status, 'unavailable')
  assert.equal(createDshCapabilityRegistry('0.2.1-alpha.1', 'host', context).getProfile(context).capabilities.get('assistant.agent')?.status, 'ready')
  const adapter = createAssistantAgentAdapter({}, '0.2.1-alpha.1', llm, [])
  await assert.rejects(adapter.reply(model, '', [{ role: 'user', text: '你好' }], new AbortController().signal, () => {}), /不支持受限助理 Agent/)
  await adapter.dispose()
})

test('只使用模型宣告的 off／none，不支持关闭思考时拒绝，不改 Host 默认', async () => {
  for (const effort of ['off', 'none', 'high', undefined]) {
    const runtime = { listProviders: () => [], listModels: async () => [], stream: async function* () {}, resolveModelInfo: async () => effort === undefined ? {} : ({ reasoning: { efforts: [{ id: effort }] } }) }
    const adapter = createAssistantLlmAdapter({ get: (name: string) => name === 'llm' ? runtime : undefined }, '0.2.1-alpha.1')!
    if (effort === 'high') await assert.rejects(adapter.assistantOptions!(model, new AbortController().signal), /不支持关闭思考/)
    else assert.deepEqual(await adapter.assistantOptions!(model, new AbortController().signal), { maxTokens: 1024, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  }
  const prompt = createAssistantChatSystem({ generation: 0, scope: { status: 'empty', reason: 'no-managed-workspaces', message: '尚未选择任何工作区' }, entries: [], unreadableCount: 0 }, undefined, true)
  assert.match(prompt, /不得创建子 Agent/)
  assert.match(prompt, /100字/)
  assert.ok(!prompt.includes('本轮只读，不执行工具'))
})
