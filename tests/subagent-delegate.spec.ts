import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { delegateCapability, dispatchDelegateSubagent } from '../data/build/dist/host/cli-adapters/delegate-dispatch.js'
import { setNativeSubagents } from '../data/build/dist/host/cli-adapters/native-subagent-holder.js'
import { setAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry-holder.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { DELEGATE_COMMAND_NAME, delegateAdapterOptions, extractDelegateTask } from '../data/build/dist/client/delegate-plan.js'

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

test('委派适配器选项只保留已安装且已启用的外部 Agent', () => {
  const options = delegateAdapterOptions([
    { id: 'dsh', name: 'DeepSeek Harness', installed: true, enabled: true, version: null, command: null },
    { id: 'codex', name: 'Codex', installed: true, enabled: true, version: '1.2.3', command: '/codex' },
    { id: 'kimi', name: 'Kimi', installed: true, enabled: false, version: '1.0.0', command: '/kimi' },
    { id: 'pi', name: 'Pi', installed: false, enabled: true, version: null, command: null },
  ])
  assert.deepEqual(options, [{ id: 'codex', label: 'Codex', detail: '1.2.3' }])
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
    assert.deepEqual(result, { ok: true, adapterId: 'codex', childSessionId: 'child-99' })
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
  const agents = { get: (id: string) => (id === 'parent' ? { id: 'agent-parent', session: { header: { id: 'parent' } } } : undefined) }
  try {
    const results = await Promise.all([
      dispatchDelegateSubagent({ sessionId: 'parent', adapterId: 'codex', prompt: '任务 A' }, { agents, nativeSessions: SESSIONS as never }),
      dispatchDelegateSubagent({ sessionId: 'parent', adapterId: 'gemini', prompt: '任务 B' }, { agents, nativeSessions: SESSIONS as never }),
    ])
    assert.ok(results.every((item) => item.ok), JSON.stringify(results))
    assert.equal(started.length, 2)
    assert.equal(gate.released, true)
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('/委派 命令已注册进 Client bundle，并走 Host 的委派 RPC 边界', async () => {
  const bundle = await readFile(join(root, 'data/build/dist/client/bundle.js'), 'utf8')
  // 菜单行与 popupSelect 选项：命令名必须与 Host 侧常量一致。
  assert.match(bundle, /DELEGATE_COMMAND_NAME = "delegate"/u)
  assert.match(bundle, /kind: "popupSelect"/u)
  assert.match(bundle, /callCliRpc\(options\.rpc, "delegate\/capability"/u)
  assert.match(bundle, /callCliRpc\(options\.rpc, "delegate"/u)

  const commandSource = await readFile(join(root, 'src/client/delegate-command.ts'), 'utf8')
  // 服务缺失必须降级为“不注册”，不能让整个 Client 因为可选能力而失败。
  assert.match(commandSource, /readCommandUi\(ctx\)/u)
  assert.match(commandSource, /commandUi\.register/u)

  const hostSource = await readFile(join(root, 'src/host/cli-adapters/feature.ts'), 'utf8')
  assert.match(hostSource, /case 'delegate\/capability'/u)
  assert.match(hostSource, /case 'delegate':/u)
})

test('任务留空时回退到会话最近一条人类消息，并跳过插件注入的上下文', async () => {
  const started: Array<Record<string, any>> = []
  const service = {
    registerProvider: () => () => undefined,
    startContinuable: async (spec: Record<string, any>) => {
      started.push(spec)
      return { childId: 'child-1', messageId: 'm1' }
    },
  }
  // 事件流里混入 compaction 检查点与 step 继续提示：都不是用户需求，必须跳过。
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '请分析当前项目的模块划分' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '插件注入的压缩检查点' }], source: { kind: 'compact-checkpoint', compactionId: 'c1' } } },
    { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '插件注入的继续提示' }], source: { kind: 'plugin', plugin: 'codingns4dsh', form: 'notice' } } },
  ]
  const sessions = { available: true, get: (id: string) => (id === 'parent' ? { snapshotEvents: () => events } : undefined), subscribe: () => () => undefined, list: () => [] }
  const registry = registryWith(['codex'])
  setNativeSubagents(service as never)
  setAdapterRegistry(registry)
  const agents = { get: (id: string) => (id === 'parent' ? { id: 'agent-parent', session: { header: { id: 'parent' } } } : undefined) }
  try {
    const result = await dispatchDelegateSubagent(
      { sessionId: 'parent', adapterId: 'codex', prompt: '' },
      { agents, nativeSessions: sessions as never },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(started[0]!.request.prompt, [{ type: 'text', text: '请分析当前项目的模块划分' }])
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})

test('同一会话把同一任务连续委派给多个外部 Agent，各自得到独立子会话', async () => {
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
  const agents = { get: (id: string) => (id === 'parent' ? { id: 'agent-parent', session: { header: { id: 'parent' } } } : undefined) }
  try {
    const results = []
    for (const adapterId of ['codex', 'gemini', 'claude-code']) {
      results.push(await dispatchDelegateSubagent({ sessionId: 'parent', adapterId, prompt: '审计当前模块' }, { agents, nativeSessions: SESSIONS as never }))
    }
    assert.ok(results.every((item) => item.ok), JSON.stringify(results))
    assert.deepEqual(results.map((item) => item.adapterId), ['codex', 'gemini', 'claude-code'])
    assert.equal(new Set(results.map((item) => item.childSessionId)).size, 3)
    assert.deepEqual(started.map((spec) => spec.provider), [
      'codingns-external-codex',
      'codingns-external-gemini',
      'codingns-external-claude-code',
    ])
  } finally {
    setNativeSubagents(undefined)
    setAdapterRegistry(undefined)
  }
})
