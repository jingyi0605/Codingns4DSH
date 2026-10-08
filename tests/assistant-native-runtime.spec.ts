import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { AssistantAgentAdapter } from '../src/dsh-capabilities/host/assistant-agent-adapter.js'
import { createAssistantLlmAdapter } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import { createAssistantManagementTools } from '../src/host/features/assistant-management-tools.js'
import { AssistantDispatcher } from '../src/host/features/assistant-dispatch.js'
import { createAssistantScope } from '../src/host/features/assistant-scope.js'
import { configureAssistantSettings } from '../src/host/features/assistant-lifecycle-settings.js'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/contracts/config.js'
import type { AssistantToolCall } from '../src/shared/contracts/assistant.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'

// 只加载 Stage0 核心库到独立内存 Context，不加载启动器、Profile、持久化或服务器。
const runtime = process.env.CODINGNS_STAGE0_RUNTIME_DIR || join(homedir(), '.local/share/codingns/deepseek-harness/0.2.1-alpha.1/node_modules/@deepseek-ai')
const available = existsSync(join(runtime, 'dsh-agent-loop/lib/index.js'))
// 读取实际加载的版本，避免用 alpha.1 标签测试 rc.2，从而绕过待验证的版本路由。
const runtimeVersion = available ? JSON.parse(readFileSync(join(runtime, 'dsh-agent-loop/package.json'), 'utf8')).version as string : ''
const load = (name: string) => import(pathToFileURL(join(runtime, name, 'lib/index.js')).href)

test('已安装 DSH 原生工具校验器接受所有管理工具契约', { skip: !available }, async () => {
  const native = await load('dsh-tools')
  const tools = createAssistantManagementTools({ dispatcher: new AssistantDispatcher(() => {}), snapshot: async () => ({ scope: createAssistantScope([]), entries: [], archivedSessionIds: [], indexGeneration: 0, workspaces: [] }), read: async () => null })
  for (const tool of tools) {
    native.assertObjectJsonSchema(tool.parameters)
    native.assertSupportedJsonSchema(tool.output.schema)
  }
})

test('真实原生 Agent Loop 执行管理工具并续跑短答，其他根 Agent 保留自己的工具和思考参数', { skip: !available, timeout: 10000 }, async () => {
  const [cordis, sessions, projections, agents, llms, prompts, tools, loop] = await Promise.all(['cordis', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop'].map(load))
  const ctx = new cordis.Context()
  new projections.SessionProjectionRegistry(ctx)
  new sessions.SessionStore(ctx)
  new agents.AgentRegistry(ctx)
  new llms.LlmRuntime(ctx)
  new prompts.SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new tools.ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 10 })
  new loop.AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 10 } })
  const requests: any[] = []
  let release!: () => void
  const endGate = new Promise<void>((resolve) => { release = resolve })
  class Model extends llms.LlmAdapter {
    async listModels(provider: string) { return [{ provider, id: 'fast', name: 'Fast' }, { provider, id: 'fixed', name: 'Fixed' }] }
    async resolveModel(provider: string, id: string) { return { provider, id, name: 'Fast', reasoning: { efforts: [{ id: 'off', name: '关闭' }, { id: 'high', name: '高' }] } } }
    async *stream(options: any) {
      requests.push(options)
      if (requests.length === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'query', name: 'assistant_list_workspaces', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: '目前管理项目一。' }
        if (requests.length === 2) await endGate
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '目前管理项目一。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  // 同一原生目录覆盖第三方 API 与官方提供商，避免把“能看到一个假模型”当完整验证。
  ctx.llm.registerAdapter(['api', 'deepseek'], new Model())
  ctx.tools.register({ name: 'forbidden_execution', description: '普通会话工具', parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: {}, render: () => [] }, execute: async () => assert.fail('助理不得执行普通会话工具') })
  let queried = 0
  const management = createAssistantManagementTools({ dispatcher: new AssistantDispatcher(() => assert.fail('纯查询不得派发')), snapshot: async () => { queried++; return { scope: createAssistantScope(['w1']), entries: [], archivedSessionIds: [], indexGeneration: 0, workspaces: [{ workspaceId: 'w1', name: '项目一', path: null }] } }, read: async () => null })
  assert.equal(createDshCapabilityRegistry(runtimeVersion, 'host', ctx).getProfile(ctx).capabilities.get('assistant.agent')?.status, 'ready')
  const llm = createAssistantLlmAdapter(ctx, runtimeVersion)!
  assert.ok(llm, `${runtimeVersion} 应可读取原生 LLM`)
  const adapter = new AssistantAgentAdapter(ctx.agents, llm, management, '/virtual/assistant', async () => {})
  let other: any
  try {
    other = await ctx.agents.create({ sessionId: 'ordinary-root', agentOptions: { provider: 'api', model: 'fast', reasoningEffort: 'high' } })
    const catalog = await llm.catalog()
    assert.deepEqual(new Set(catalog.models.map((model) => model.provider)), new Set(['api', 'deepseek']))
    const saved = configureAssistantSettings(DEFAULT_ASSISTANT_SETTINGS, { name: '哆哆', model: { provider: 'api', model: 'fixed' }, avatarId: 'codingns-default' }, catalog, [])
    const partial: string[] = []
    const audit: AssistantToolCall[] = []
    let received!: () => void; let completed = false
    const firstText = new Promise<void>((resolve) => { received = resolve })
    const answering = adapter.reply({ ...saved.model!, label: 'Fixed' }, '只管理工作区，不执行代码，简短回答。', [{ role: 'user', text: '有哪些项目？' }], new AbortController().signal,
      (text) => { partial.push(text); received() }, undefined, (call) => audit.push(call)).then((text) => { completed = true; return text })
    await firstText
    assert.deepEqual(partial, ['目前管理项目一。'], '真实原生 Agent 在 finish 和 whenIdle 前已经转发文字')
    assert.equal(completed, false)
    release()
    assert.equal(await answering, '目前管理项目一。')
    assert.equal(queried, 1)
    assert.deepEqual(audit.map((call) => call.state), ['running', 'completed'])
    assert.equal(audit[1]!.kind, 'workspace'); assert.equal(audit[1]!.id, 'query')
    assert.match(audit[1]!.result, /项目一/)
    assert.equal(requests.length, 2, '原生工具结果驱动下一步模型调用')
    assert.ok(requests.every((request) => request.provider === 'api' && request.model === 'fixed'), '已保存模型进入真实 DSH Agent Loop 的模型请求和工具续跑')
    assert.ok(requests.every((request) => request.reasoningEffort === 'off' && request.maxTokens === 1024))
    assert.ok(requests.every((request) => request.tools.every((tool: any) => tool.name.startsWith('assistant_'))))
    assert.ok(ctx.tools.schemas().some((tool: any) => tool.name === 'forbidden_execution'))
    assert.equal(other.agent.options.reasoningEffort, 'high')
    const assistant = ctx.agents.get([...adapter.sessionIds][0])
    assert.ok(assistant)
    // 即使模型猜到隐藏工具名，原生执行流水线也会拒绝。
    const denied = await ctx.tools.execute({ callId: 'denied', rootCallId: 'denied', name: 'forbidden_execution', arguments: {}, agent: assistant, signal: new AbortController().signal })
    assert.ok(denied.isError || denied.type === 'error' || denied.error, JSON.stringify(denied))
    other.agent.followup({ id: 'ordinary-question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '普通会话继续' }] })
    await other.agent.whenIdle()
    assert.equal(requests[2].reasoningEffort, 'high')
    assert.equal(requests[2].model, 'fast', '普通 Agent 的模型不受助理保存影响')
    assert.ok(requests[2].tools.some((tool: any) => tool.name === 'forbidden_execution'))
    assert.equal(audit.length, 2, '其他 Agent 和白名单外的执行不混入本次通话')
  } finally { release(); await adapter.dispose(); await other?.dispose(); await ctx.fiber.dispose() }
})

test('真实搜索服务在全局注册及 Web 预设隔离下都能驱动助理续跑，失败可见且不影响其他会话', { skip: !available, timeout: 20000 }, async (t) => {
  for (const inheritedSearch of [true, false]) await t.test(inheritedSearch ? '继承全局搜索工具' : '全局工具关闭，只在助理中注册搜索', async () => {
  const [cordis, sessions, projections, agents, llms, prompts, tools, loop, web, webTools] = await Promise.all([
    'cordis', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop', 'dsh-web', 'dsh-tool-web',
  ].map(load))
  const ctx = new cordis.Context()
  new projections.SessionProjectionRegistry(ctx)
  new sessions.SessionStore(ctx)
  new agents.AgentRegistry(ctx)
  new llms.LlmRuntime(ctx)
  new prompts.SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new tools.ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 10 })
  new loop.AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 10 } })
  new web.WebRuntime(ctx, {})
  let queries = 0; let unavailable = false
  // 真实搜索工具与 WebRuntime 使用内存提供商，不发送网络请求或读取用户凭据。
  ctx.web.registerSearchProvider({ id: 'memory-search', available: () => true, async search(request: any, signal: AbortSignal) {
    queries++
    assert.equal(request.query, '北京天气')
    assert.ok(signal instanceof AbortSignal)
    if (unavailable) throw new Error('搜索提供商暂时不可用')
    return { sources: [{ url: 'https://example.com/weather', title: '天气来源', snippet: '北京今天晴，25度。' }], truncated: false }
  } })
  if (inheritedSearch) webTools.apply(ctx, webTools.Config({}))
  for (const name of ['bash', 'write', 'agent_subagent', 'mcp_private_tool']) ctx.tools.register({ name, description: '普通会话工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: {}, render: () => [] }, execute: async () => assert.fail(`助理不得执行 ${name}`) })
  const requests: any[] = []
  class Model extends llms.LlmAdapter {
    async listModels() { return [{ id: 'fast', name: 'Fast' }] }
    async resolveModel(provider: string, id: string) { return { provider, id, name: 'Fast', reasoning: { efforts: [{ id: 'off', name: '关闭' }, { id: 'high', name: '高' }] } } }
    async *stream(options: any) {
      requests.push(options)
      if ([1, 3].includes(requests.length)) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `search-${requests.length}`, name: 'web_search', arguments: '{"queries":["北京天气"]}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = unavailable ? '搜索暂时不可用，无法确认天气。' : '据天气来源，北京今天晴，25度。'
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['api'], new Model())
  const management = createAssistantManagementTools({ dispatcher: new AssistantDispatcher(() => assert.fail('天气查询不得派发会话任务')),
    snapshot: async () => ({ scope: createAssistantScope([]), entries: [], archivedSessionIds: [], indexGeneration: 0, workspaces: [] }), read: async () => null })
  const adapter = new AssistantAgentAdapter(ctx.agents, createAssistantLlmAdapter(ctx, runtimeVersion), management, '/virtual/assistant', async () => {})
  let other: any
  try {
    const question = { role: 'user' as const, text: '北京天气怎么样？' }
    const audit: AssistantToolCall[] = []
    const observe = (call: AssistantToolCall) => audit.push(call)
    const answer = await adapter.reply({ provider: 'api', model: 'fast', label: 'Fast' }, '简短回答。', [question], new AbortController().signal, () => {}, undefined, observe)
    assert.equal(queries, 1)
    assert.equal(requests.length, 2)
    assert.match(JSON.stringify(requests[1].messages), /北京今天晴，25度/)
    assert.match(JSON.stringify(requests[1].messages), /https:\/\/example.com\/weather/)
    assert.match(answer, /25度/)
    assert.deepEqual(audit.map((call) => call.state), ['running', 'completed'])
    assert.equal(audit[1]!.kind, 'web-search'); assert.match(audit[1]!.result, /example.com\/weather/)
    assert.ok(requests.every((request) => request.reasoningEffort === 'off'))
    assert.ok(requests.every((request) => request.tools.length === 5 && request.tools.some((tool: any) => tool.name === 'web_search') && request.tools.every((tool: any) => tool.name === 'web_search' || tool.name.startsWith('assistant_'))))
    assert.equal(requests[0].system, undefined, '原生 Agent Loop 把系统提示词投影到消息历史，不使用单次 LLM 的 system 参数')
    assert.match(JSON.stringify(requests[0].messages.filter((message: any) => message.role === 'system')), /DSH 原生 AgentLoop/)
    const assistant = ctx.agents.get([...adapter.sessionIds][0])
    for (const name of ['web_fetch', 'bash', 'write', 'agent_subagent', 'mcp_private_tool']) {
      const result = await ctx.tools.execute({ callId: `denied-${name}`, rootCallId: `denied-${name}`, name,
        arguments: name === 'web_fetch' ? { url: 'https://example.com/' } : {}, agent: assistant, signal: new AbortController().signal })
      assert.ok(result.isError || result.type === 'error' || result.error, name)
    }
    unavailable = true
    await adapter.reply({ provider: 'api', model: 'fast', label: 'Fast' }, '简短回答。', [question, { role: 'assistant', text: answer }, question], new AbortController().signal, () => {}, undefined, observe)
    assert.equal(queries, 2)
    assert.equal(requests.length, 4)
    assert.match(JSON.stringify(requests[3].messages), /搜索提供商暂时不可用/)
    assert.deepEqual(audit.map((call) => call.state), ['running', 'completed', 'running', 'failed'])
    assert.match(audit[3]!.result, /搜索提供商暂时不可用/)
    other = await ctx.agents.create({ sessionId: 'ordinary-search-root', agentOptions: { provider: 'api', model: 'fast', reasoningEffort: 'high' } })
    other.agent.followup({ id: 'other-question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '普通会话' }] })
    await other.agent.whenIdle()
    assert.equal(requests[4].reasoningEffort, 'high')
    assert.equal(requests[4].tools.some((tool: any) => tool.name === 'web_fetch'), inheritedSearch)
    assert.equal(requests[4].tools.some((tool: any) => tool.name === 'web_search'), inheritedSearch, '助理局部搜索不能泄露到普通根 Agent')
    assert.equal(ctx.tools.schemas().some((tool: any) => tool.name === 'web_search'), inheritedSearch)
    assert.ok(requests[4].tools.some((tool: any) => tool.name === 'bash'))
  } finally { await adapter.dispose(); await other?.dispose(); await ctx.fiber.dispose() }
  })
})
