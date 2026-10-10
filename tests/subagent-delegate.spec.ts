import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { delegateCapability, dispatchDelegateSubagent } from '../data/build/dist/host/cli-adapters/delegate-dispatch.js'
import { getMaxNativeSubagentsPerParent, setMaxNativeSubagentsPerParent } from '../data/build/dist/host/cli-adapters/native-subagent-dispatch.js'
import { setNativeSubagents } from '../data/build/dist/host/cli-adapters/native-subagent-holder.js'
import { normalizeSubagentBridgeSettings, SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS } from '../data/build/dist/shared/contracts/config.js'
import { setAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry-holder.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { DELEGATE_COMMAND_NAME, delegateAdapterOptions, extractDelegateTask } from '../data/build/dist/client/delegate-plan.js'
import { appendDelegateCarrier, parseDelegationCarriers } from '../data/build/dist/client/delegate-plan.js'
import { rewriteDelegationMessages } from '../data/build/dist/host/cli-adapters/delegation-mention-rewrite.js'
import { externalTeamProvider } from '../data/build/dist/host/cli-adapters/native-team-subagent.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 可用的原生会话桥接替身；委派是异步的，不需要真实事件流。 */
const SESSIONS = { available: true, get: () => undefined, subscribe: () => () => undefined, list: () => [] }

function registryWith(adapterIds: readonly string[]): CodingNsCliAdapterRegistry {
  const registry = new CodingNsCliAdapterRegistry(adapterIds.map((id) => ({
    descriptor: { id, name: id, protocol: 'command', capabilities: [] },
    detect: async () => ({ installed: true, version: '1.0.0', command: `/fake/${id}` }),
    listModels: async () => ({ groups: [], currentModel: null, currentEffort: null }),
    executeTurn: async function* () { /* 委派不经过普通轮次 */ },
  })) as never)
  for (const id of adapterIds) registry.setSession(`session-${id}`, { adapterId: id })
  return registry
}

test('委派适配器选项包含内置 dsh，并过滤未安装或已停用适配器', () => {
  const options = delegateAdapterOptions([
    { id: 'dsh', name: 'DeepSeek Harness', installed: true, enabled: true, version: null, command: null },
    { id: 'codex', name: 'Codex', installed: true, enabled: true, version: '1.2.3', command: '/codex' },
    { id: 'kimi', name: 'Kimi', installed: true, enabled: false, version: '1.0.0', command: '/kimi' },
    { id: 'pi', name: 'Pi', installed: false, enabled: true, version: null, command: null },
  ])
  assert.deepEqual(options, [
    { id: 'dsh', label: 'DeepSeek Harness' },
    { id: 'codex', label: 'Codex', detail: '1.2.3' },
  ])
})

test('委派任务从草稿里取令牌之后的内容，行内斜杠不当作委派', () => {
  assert.equal(DELEGATE_COMMAND_NAME, 'delegate')
  assert.equal(extractDelegateTask('/委派 分析当前项目'), '分析当前项目')
  assert.equal(extractDelegateTask('/delegate 分析当前项目'), '分析当前项目')
  // 适配器名/ID 写在任务前时也要剥掉，避免把选择结果重复送进提示词。
  assert.equal(extractDelegateTask('/委派 codex 分析当前项目', 'codex', 'Codex'), '分析当前项目')
  assert.equal(extractDelegateTask('/委派 Codex 分析当前项目', 'codex', 'Codex'), '分析当前项目')
  assert.equal(extractDelegateTask('/委派 codex', 'codex', 'Codex'), '')
  assert.equal(extractDelegateTask('/委派'), '')
  assert.equal(extractDelegateTask('请看 /委派 的用法'), '')
  // 其它命令的草稿不能被当成委派任务。
  assert.equal(extractDelegateTask('/model deepseek'), '')
  assert.equal(extractDelegateTask('/compact'), '')
  assert.equal(extractDelegateTask(''), '')
})

test('carrier 只携带稳定 adapterId，Host 改写后移除 mention 并保留任务', () => {
  const draft = appendDelegateCarrier('请实现并运行测试', 'command-code', 'Command Code')
  const parsed = parseDelegationCarriers(draft)
  assert.deepEqual(parsed.carriers, [{ version: 1, adapterId: 'command-code', label: 'Command Code' }])
  assert.equal(parsed.text, '请实现并运行测试')
  const rewritten = rewriteDelegationMessages([{ role: 'user', content: draft }], [{
    id: 'command-code', name: 'Command Code', installed: true, enabled: true, version: '1', command: 'command-code', capabilities: ['stream'],
  }])
  assert.equal(rewritten.kind, 'rewritten')
  if (rewritten.kind === 'rewritten') {
    assert.match(rewritten.value.instruction, /command-code/u)
    assert.match(rewritten.value.instruction, /请实现并运行测试/u)
    assert.doesNotMatch(String(rewritten.value.messages[0]!.content), /codingns:delegate/u)
  }
})

test('carrier v2 携带用户明确选择的模型并在 Host 改写授权中保留', () => {
  const draft = appendDelegateCarrier('请使用指定模型完成任务', 'command-code', 'Command Code', 'deepseek/deepseek-v4.1-flash')
  const parsed = parseDelegationCarriers(draft)
  assert.deepEqual(parsed.carriers, [{ version: 2, adapterId: 'command-code', label: 'Command Code', modelId: 'deepseek/deepseek-v4.1-flash' }])
  const rewritten = rewriteDelegationMessages([{ role: 'user', content: draft }], [{
    id: 'command-code', name: 'Command Code', installed: true, enabled: true, version: '1', command: 'command-code', capabilities: ['stream'],
  }])
  assert.equal(rewritten.kind, 'rewritten')
  if (rewritten.kind === 'rewritten') {
    assert.equal(rewritten.value.targets[0]?.modelId, 'deepseek/deepseek-v4.1-flash')
    assert.match(rewritten.value.instruction, /模型：deepseek\/deepseek-v4\.1-flash/u)
  }
})

test('Host 拒绝损坏 carrier、停用目标和空任务，不读取历史消息', () => {
  const catalog = [{ id: 'codex', name: 'Codex', installed: true, enabled: false, version: '1', command: 'codex' }]
  const unavailable = rewriteDelegationMessages([{ role: 'user', content: '@Codex<!--codingns:delegate:v1:codex:Codex-->' }], catalog)
  assert.equal(unavailable.kind, 'error')
  if (unavailable.kind === 'error') assert.equal(unavailable.error.code, 'DELEGATE_TARGET_UNAVAILABLE')
  const invalid = rewriteDelegationMessages([{ role: 'user', content: '<!--codingns:delegate:v9:codex:Codex-->任务' }], catalog)
  assert.equal(invalid.kind, 'error')
  if (invalid.kind === 'error') assert.equal(invalid.error.code, 'DELEGATE_CARRIER_INVALID')
})

test('委派能力在缺少原生可续子代理或会话桥接时给出可读诊断', () => {
  setNativeSubagents(undefined)
  const missingNative = delegateCapability({ nativeSessions: SESSIONS as never })
  assert.equal(missingNative.supported, false)
  assert.equal(missingNative.code, 'CODINGNS_DELEGATE_UNAVAILABLE')
  assert.match(missingNative.message, /可续子代理/u)

  setNativeSubagents({ registerProvider: () => () => undefined, startContinuable: async () => ({ childId: 'c', messageId: 'm' }) } as never)
  try {
    const missingSessions = delegateCapability({})
    assert.equal(missingSessions.supported, false)
    assert.match(missingSessions.message, /原生会话桥接/u)

    const ready = delegateCapability({ nativeSessions: SESSIONS as never })
    assert.equal(ready.supported, true)
    assert.equal(ready.code, 'CODINGNS_DELEGATE_READY')
  } finally {
    setNativeSubagents(undefined)
  }
})

test('委派异步派发：立刻返回子会话 ID，不等待子代理首轮结果', async () => {
  const started: Array<Record<string, any>> = []
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async (spec: Record<string, any>) => {
      started.push(spec)
      return { childId: 'child-99', messageId: 'm1' }
    },
  }
  const registry = registryWith(['codex'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  try {
    const result = await dispatchDelegateSubagent(
      { sessionId: 'session-codex', adapterId: 'codex', prompt: '分析当前项目' },
      {
        agents: { get: (id: string) => (id === 'session-codex' ? { id: 'agent-1', session: { header: { id: 'session-codex' } } } : undefined) },
        nativeSessions: SESSIONS as never,
      },
    )
    assert.deepEqual(result, { ok: true, adapterId: 'codex', childSessionId: 'child-99', completed: false, status: 'running' })
    assert.equal(started.length, 1)
    // Provider 名必须与原生 Subagent 注册名一致，否则 startContinuable 找不到实现。
    assert.equal(started[0]!.provider, 'codingns-external-codex')
    assert.deepEqual(started[0]!.request.prompt, [{ type: 'text', text: '分析当前项目' }])
    assert.equal(started[0]!.request.parent.id, 'agent-1')
    assert.equal(started[0]!.label, '分析当前项目')
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('内置 dsh 委派使用 spawn Provider 并下发用户选择的模型', async () => {
  const started: Array<Record<string, any>> = []
  setNativeSubagents({
    registerProvider: () => () => undefined,
    startContinuable: async (spec: Record<string, any>) => { started.push(spec); return { childId: 'child-dsh', messageId: 'm-dsh' } },
  } as never)
  // dsh 没有外部 CLI Registry driver，派发不能依赖 registry.catalog()。
  setAdapterRegistry(registryWith(['codex']))
  try {
    const result = await dispatchDelegateSubagent(
      { sessionId: 'parent-dsh', adapterId: 'dsh', modelId: 'deepseek-chat', prompt: '执行 DSH 子任务' },
      { agents: { get: (id: string) => (id === 'parent-dsh' ? { id: 'agent-dsh', session: { header: { id: 'parent-dsh' } } } : undefined) }, nativeSessions: SESSIONS as never },
    )
    assert.equal(result.ok, true)
    assert.equal(externalTeamProvider('dsh'), 'spawn')
    assert.equal(started[0]?.provider, 'spawn')
    assert.deepEqual(started[0]?.request?.agentOptions, { model: 'deepseek-chat' })
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('委派拒绝未支持/未安装的适配器、空任务与找不到的父会话', async () => {
  const service = { registerProvider: () => () => undefined, startContinuable: async () => ({ childId: 'child', messageId: 'm' }) }
  const registry = registryWith(['codex'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const agents = { get: (id: string) => (id === 'session-codex' ? { id: 'agent-1', session: { header: { id: 'session-codex' } } } : undefined) }
  try {
    const unsupported = await dispatchDelegateSubagent({ sessionId: 'session-codex', adapterId: 'not-an-agent', prompt: '任务' }, { agents, nativeSessions: SESSIONS as never })
    assert.equal(unsupported.ok, false)
    assert.match(unsupported.error ?? '', /不支持的外部 Agent/u)

    const empty = await dispatchDelegateSubagent({ sessionId: 'session-codex', adapterId: 'codex', prompt: '   ' }, { agents, nativeSessions: SESSIONS as never })
    assert.equal(empty.ok, false)
    assert.match(empty.error ?? '', /任务描述不能为空/u)
    const missingAgent = await dispatchDelegateSubagent({ sessionId: 'session-unknown', adapterId: 'codex', prompt: '任务' }, { agents, nativeSessions: SESSIONS as never })
    assert.equal(missingAgent.ok, false)
    assert.match(missingAgent.error ?? '', /找不到会话对应的 DSH Agent/u)

    // 目录里存在但未安装的适配器不能靠请求参数绕过。
    const notInstalled = await dispatchDelegateSubagent({ sessionId: 'session-codex', adapterId: 'kimi', prompt: '任务' }, { agents, nativeSessions: SESSIONS as never })
    assert.equal(notInstalled.ok, false)
    assert.match(notInstalled.error ?? '', /未安装或未启用/u)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('同一父会话可向不同适配器并行委派，同一适配器按队列串行创建', async () => {
  const order: string[] = []
  const perAdapterInFlight = new Map<string, number>()
  let maxInFlight = 0
  let seq = 0
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async (spec: Record<string, any>) => {
      const adapterId = String(spec.provider).replace('codingns-external-', '')
      const current = (perAdapterInFlight.get(adapterId) ?? 0) + 1
      perAdapterInFlight.set(adapterId, current)
      maxInFlight = Math.max(maxInFlight, current)
      order.push(adapterId)
      await new Promise((resolve) => setTimeout(resolve, 5))
      perAdapterInFlight.set(adapterId, current - 1)
      seq += 1
      return { childId: `child-${seq}`, messageId: `m${seq}` }
    },
  }
  const registry = registryWith(['codex', 'gemini'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const agents = { get: (id: string) => (id === 'parent' ? { id: 'agent-parent', session: { header: { id: 'parent' } } } : undefined) }
  try {
    const results = await Promise.all([
      dispatchDelegateSubagent({ sessionId: 'parent', adapterId: 'codex', prompt: '任务 A' }, { agents, nativeSessions: SESSIONS as never }),
      dispatchDelegateSubagent({ sessionId: 'parent', adapterId: 'gemini', prompt: '任务 B' }, { agents, nativeSessions: SESSIONS as never }),
      dispatchDelegateSubagent({ sessionId: 'parent', adapterId: 'codex', prompt: '任务 C' }, { agents, nativeSessions: SESSIONS as never }),
    ])
    assert.ok(results.every((item) => item.ok), JSON.stringify(results))
    assert.equal(order.length, 3)
    // 同一适配器（codex）的两条必须排队串行，不能同时创建。
    assert.equal(maxInFlight, 1, `同一适配器的创建必须串行，实际最大并发 ${maxInFlight}`)
    assert.equal(new Set(results.map((item) => item.childSessionId)).size, 3)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('不同适配器的委派可以真正并行创建，不被单飞守卫拒绝', async () => {
  const gate = { released: false }
  const started: string[] = []
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async (spec: Record<string, any>) => {
      started.push(String(spec.provider))
      // 第一个创建挂起，等待第二个创建也进入后一起放行：只有真正并行才不会超时。
      if (started.length === 1) await new Promise((resolve) => setTimeout(resolve, 30))
      gate.released = true
      return { childId: `child-${started.length}`, messageId: 'm' }
    },
  }
  const registry = registryWith(['codex', 'gemini'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const agents = { get: (id: string) => (id === 'parent-parallel' ? { id: 'agent-parent-parallel', session: { header: { id: 'parent-parallel' } } } : undefined) }
  try {
    const results = await Promise.all([
      dispatchDelegateSubagent({ sessionId: 'parent-parallel', adapterId: 'codex', prompt: '任务 A' }, { agents, nativeSessions: SESSIONS as never }),
      dispatchDelegateSubagent({ sessionId: 'parent-parallel', adapterId: 'gemini', prompt: '任务 B' }, { agents, nativeSessions: SESSIONS as never }),
    ])
    assert.ok(results.every((item) => item.ok), JSON.stringify(results))
    assert.equal(started.length, 2)
    assert.equal(gate.released, true)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('/委派 命令已打入 Client 入口或分块，并由选择动作写入 carrier', async () => {
  const directory = join(root, 'data/build/dist/client')
  // 委派模块按需加载，检查入口及浏览器分块；排除 tsc 产物和源码映射，避免误判漏打包。
  // 入口必须显式读取，缺失时直接失败，不能仅凭遗留分块通过检查。
  const files = ['bundle.js', ...(await readdir(directory)).filter((name) => /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u.test(name)).sort()]
  const bundle = (await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))).join('\n')
  // 菜单行与 popupSelect 选项：命令名必须与 Host 侧常量一致。
  // 只输出缺失的标记，避免断言失败时把数 MB 的完整产物打印到终端。
  for (const pattern of [
    /DELEGATE_COMMAND_NAME = "delegate"/u,
    /kind: "popupSelect"/u,
    /callCliRpc\(options\.rpc, "delegate\/capability"/u,
    /codingns:delegate:v1/u,
  ]) {
    assert.ok(pattern.test(bundle), `Client 入口及分块缺少委派标记：${pattern}`)
  }

  const commandSource = await readFile(join(root, 'src/client/delegate-command.ts'), 'utf8')
  // 服务缺失必须降级为“不注册”，不能让整个 Client 因为可选能力而失败。
  assert.match(commandSource, /readCommandUi\(ctx\)/u)
  assert.match(commandSource, /commandUi\.register/u)
  assert.match(commandSource, /setDraft/u)
  // `#` 快捷入口必须独立于可选的 inputTriggers 服务；移动端服务晚加载时仍要能弹出适配器列表。
  assert.match(commandSource, /const disposeHashShortcut = registerDelegateHashShortcut\(ctx, options\)/u)
  assert.match(commandSource, /inputTriggers !== undefined && typeof inputTriggers\.registerSource === 'function'/u)
  // codingns-delegate 只保留 ReferenceChip 的内部 codec，不再向 `@` 菜单提供候选项。
  assert.match(commandSource, /registerDelegateReferenceCodec\(ctx, options\)/u)
  assert.match(commandSource, /showGroupTitle: false/u)
  assert.match(commandSource, /async candidates\(\)\s*\{\s*return \[\]/u)
  assert.match(commandSource, /input\.caretSpan\?\.\(\)/u)
  assert.doesNotMatch(commandSource, /callCliRpc<[^>]+>\(options\.rpc, 'delegate'/u)
  // 选择 Agent 只是编辑当前草稿；单轮提交后才会真正委派，不能留下“继续输入后提交”的持久提示。
  assert.doesNotMatch(commandSource, /notify\('info', t\('delegate\.selected'/u)

  const hostSource = await readFile(join(root, 'src/host/cli-adapters/feature.ts'), 'utf8')
  assert.match(hostSource, /case 'delegate\/capability'/u)
  assert.match(hostSource, /case 'delegate':/u)
})

test('Skill 目录直接注册到斜杠菜单，并按输入文本筛选后写入显式 mention', async () => {
  const source = await readFile(join(root, 'src/client/skill-command.ts'), 'utf8')
  assert.match(source, /trigger: '\/'/u)
  assert.match(source, /registerSkillInputTriggerSource/u)
  assert.match(source, /request\.query\.trim\(\)\.toLocaleLowerCase\(\)/u)
  assert.match(source, /skill\.name, skill\.displayName, skill\.description/u)
  assert.match(source, /showGroupTitle: false/u)
  assert.match(source, /description: skill\.description/u)
  assert.match(source, /warm\(session\)/u)
  assert.match(source, /source: SKILL_INPUT_SOURCE/u)
  assert.match(source, /clipboardText: `\/\$\{name\}`/u)
  assert.match(source, /async serialize\(ref\)/u)
  // 原生 inputTriggers 优先；只有目录成功返回后才撤销 commandUi 兜底，避免空目录时两条入口同时消失。
  assert.match(source, /ctx\.inject\(\['inputTriggers'\]/u)
  assert.match(source, /kind: 'popupSelect'/u)
  assert.match(source, /state\.disposeFallback\?\.\(\)/u)
  assert.match(source, /state\.catalogReady/u)
  assert.match(source, /!catalog\.some\(\(skill\) => skill\.enabled\)/u)
  assert.match(source, /onCatalogReady\(catalog\)/u)

  const workspaceSource = await readFile(join(root, 'src/client/features/workspace-session-enhancement.ts'), 'utf8')
  assert.match(workspaceSource, /showSkillQuickReference/u)
  assert.match(workspaceSource, /registerSkillCommand/u)
  assert.match(workspaceSource, /startSkillReferenceDom/u)
})

test('任务留空时直接拒绝，不读取会话历史', async () => {
  const started: Array<Record<string, any>> = []
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async (spec: Record<string, any>) => {
      started.push(spec)
      return { childId: 'child-1', messageId: 'm1' }
    },
  }
  // 即使事件流里有真实用户消息，空任务也不能偷偷回退到历史。
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '请分析当前项目的模块划分' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '插件注入的压缩检查点' }], source: { kind: 'compact-checkpoint', compactionId: 'c1' } } },
    { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '插件注入的继续提示' }], source: { kind: 'plugin', plugin: 'codingns4dsh', form: 'notice' } } },
  ]
  const sessions = { available: true, get: (id: string) => (id === 'parent-fallback' ? { snapshotEvents: () => events } : undefined), subscribe: () => () => undefined, list: () => [] }
  const registry = registryWith(['codex'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const agents = { get: (id: string) => (id === 'parent-fallback' ? { id: 'agent-parent-fallback', session: { header: { id: 'parent-fallback' } } } : undefined) }
  try {
    const result = await dispatchDelegateSubagent(
      { sessionId: 'parent-fallback', adapterId: 'codex', prompt: '' },
      { agents, nativeSessions: sessions as never },
    )
    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /任务描述不能为空/u)
    assert.equal(started.length, 0)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('同一会话把同一任务重复委派给多个外部 Agent 时按目标去重', async () => {
  const started: Array<Record<string, any>> = []
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async (spec: Record<string, any>) => {
      started.push(spec)
      return { childId: `child-${started.length}`, messageId: `m${started.length}` }
    },
  }
  const registry = registryWith(['codex', 'gemini', 'claude-code'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const agents = { get: (id: string) => (id === 'parent-multi' ? { id: 'agent-parent-multi', session: { header: { id: 'parent-multi' } } } : undefined) }
  try {
    const results = []
    for (const adapterId of ['codex', 'gemini', 'claude-code']) {
      results.push(await dispatchDelegateSubagent({ sessionId: 'parent-multi', adapterId, prompt: '审计当前模块' }, { agents, nativeSessions: SESSIONS as never }))
    }
    assert.equal(results[0]!.ok, true, JSON.stringify(results))
    assert.equal(results[1]!.ok, false, JSON.stringify(results))
    assert.equal(results[2]!.ok, false, JSON.stringify(results))
    assert.match(results[1]!.error ?? '', /相同目标/u)
    assert.equal(started.length, 1)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('同一父会话的并发子代理上限缺省为 8，超过上限的任务直接返回并发错误', async () => {
  let started = 0
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async () => { started += 1; return { childId: `child-limit-${started}`, messageId: `m${started}` } },
  }
  const registry = registryWith(['codex'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const agents = { get: (id: string) => (id === 'parent-limit' ? { id: 'agent-parent-limit', session: { header: { id: 'parent-limit' } } } : undefined) }
  try {
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => dispatchDelegateSubagent(
      { sessionId: 'parent-limit', adapterId: 'codex', prompt: `处理目标${index}.md` },
      { agents, nativeSessions: SESSIONS as never },
    )))
    assert.equal(started, 8)
    assert.equal(results.filter((item) => item.ok).length, 8)
    assert.match(results.find((item) => !item.ok)?.error ?? '', /最多同时运行 8 个/u)
  } finally {
    setMaxNativeSubagentsPerParent(undefined)
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('并发子代理上限可由设置调高，且非法值回落到缺省值', async () => {
  let started = 0
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async () => { started += 1; return { childId: `child-cfg-${started}`, messageId: `m${started}` } },
  }
  const registry = registryWith(['codex'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const agents = { get: (id: string) => (id === 'parent-cfg' ? { id: 'agent-parent-cfg', session: { header: { id: 'parent-cfg' } } } : undefined) }
  const dispatch = (index: number) => dispatchDelegateSubagent(
    { sessionId: 'parent-cfg', adapterId: 'codex', prompt: `处理配置目标${index}.md` },
    { agents, nativeSessions: SESSIONS as never },
  )
  try {
    // 调高到 12：过去硬编码的 5 会拒绝第 6 个，这里必须全部放行。
    setMaxNativeSubagentsPerParent(12)
    const raised = await Promise.all([1, 2, 3, 4, 5, 6].map((index) => dispatch(index)))
    assert.equal(started, 6)
    assert.equal(raised.filter((item) => item.ok).length, 6)
    // 非法值（0 / NaN / 负数）不能把派发彻底锁死，必须回落到缺省值。
    for (const invalid of [0, -1, Number.NaN]) {
      setMaxNativeSubagentsPerParent(invalid)
      assert.equal(getMaxNativeSubagentsPerParent(), 8)
    }
  } finally {
    setMaxNativeSubagentsPerParent(undefined)
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('子代理托管设置归一化：并发上限按上下限收敛并带缺省值', () => {
  // 缺省值与 DSH 自身的 maxActiveSubagents 对齐。
  assert.equal(normalizeSubagentBridgeSettings(undefined).maxConcurrentSubagents, 8)
  assert.equal(normalizeSubagentBridgeSettings({ enabled: true }).maxConcurrentSubagents, 8)
  assert.equal(normalizeSubagentBridgeSettings({ maxConcurrentSubagents: 12 }).maxConcurrentSubagents, 12)
  // 越界值收敛到上下限，非数值回落到缺省值。
  assert.equal(normalizeSubagentBridgeSettings({ maxConcurrentSubagents: 999 }).maxConcurrentSubagents, SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS.max)
  assert.equal(normalizeSubagentBridgeSettings({ maxConcurrentSubagents: 0 }).maxConcurrentSubagents, SUBAGENT_BRIDGE_MAX_CONCURRENT_LIMITS.min)
  assert.equal(normalizeSubagentBridgeSettings({ maxConcurrentSubagents: 'many' }).maxConcurrentSubagents, 8)
  // 关闭状态不受并发数影响。
  assert.equal(normalizeSubagentBridgeSettings({ enabled: false, maxConcurrentSubagents: 3 }).enabled, false)
})
