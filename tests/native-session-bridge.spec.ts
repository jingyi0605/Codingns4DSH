import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodingNsNativeSessionBridge } from '../data/build/dist/host/native-session-bridge.js'

test('原生会话桥接优先调用 SessionController 并复用已存在会话', async () => {
  const sessions = new Map<string, object>()
  const calls: string[] = []
  const ctx = {
    get(name: string) {
      if (name === 'sessions') return {
        get(id: string) { return sessions.get(id) },
        list() { return [...sessions.values()] },
      }
      if (name === 'sessionController') return {
        async create(input: { sessionId?: string }) {
          calls.push(`controller:${input.sessionId ?? ''}`)
          const id = input.sessionId ?? 'generated'
          sessions.set(id, {})
          return { sessionId: id }
        },
        async list() { return { items: [{ sessionId: 'dsh-1' }] } },
      }
      return undefined
    },
  } as never
  const bridge = createCodingNsNativeSessionBridge(ctx)
  assert.equal(bridge.available, true)
  assert.equal(await bridge.ensure('dsh-1', '/tmp/project'), 'dsh-1')
  assert.deepEqual(calls, ['controller:dsh-1'])
  assert.equal(await bridge.ensure('dsh-1'), 'dsh-1')
  assert.deepEqual(calls, ['controller:dsh-1'])
  assert.equal(bridge.list().length, 1)
  assert.deepEqual(await bridge.listRemote(), [{ sessionId: 'dsh-1' }])
})

test('原生会话桥接通过 get 探测可选服务，不直接读取未注入属性', () => {
  const reads: string[] = []
  const ctx = new Proxy({
    get(name: string) {
      reads.push(name)
      return undefined
    },
  }, {
    get(target, property, receiver) {
      if (property === 'sessions' || property === 'sessionController') {
        throw new Error(`cannot get property ${property} without inject`)
      }
      return Reflect.get(target, property, receiver)
    },
  }) as never

  assert.doesNotThrow(() => createCodingNsNativeSessionBridge(ctx))
  assert.deepEqual(reads, ['sessions', 'sessionController', 'workspaceController'])
})

test('原生事件订阅在 Host 停用时可移除', () => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    get() { return undefined },
    on(name: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  } as never
  const bridge = createCodingNsNativeSessionBridge(ctx)
  const events: unknown[] = []
  const dispose = bridge.subscribe({ onEvent: (_session, event) => events.push(event) })
  listeners.get('session/event')?.('s', { type: 'assistant/message' })
  assert.deepEqual(events, [{ type: 'assistant/message' }])
  dispose()
  assert.equal(listeners.size, 0)
})

test('缺少原生服务时桥接安全降级，不阻断插件', async () => {
  const bridge = createCodingNsNativeSessionBridge({ get() { return undefined } } as never)
  assert.equal(bridge.available, false)
  assert.equal(await bridge.ensure('dsh-1'), null)
  assert.deepEqual(bridge.list(), [])
  await bridge.flush('dsh-1')
  assert.doesNotThrow(() => bridge.subscribe({}))
})

test('只有 SessionStore 时只复用已有会话，不创建短命会话', async () => {
  const sessions = new Map<string, object>()
  let flushed = 0
  const store = {
    get(id: string) { return sessions.get(id) },
    list() { return [...sessions.values()] },
    async flush() { flushed += 1 },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) { return name === 'sessions' ? store : undefined },
  } as never)
  assert.equal(await bridge.ensure('dsh-2'), null)
  sessions.set('dsh-2', { id: 'dsh-2' })
  assert.equal(await bridge.ensure('dsh-2'), 'dsh-2')
  assert.equal(bridge.canInjectNextStep?.('dsh-2'), false)
  await bridge.flush('dsh-2')
  assert.equal(flushed, 1)
})

test('原生会话桥接把外部工具保存为只读声明/call/result 事件且不触发执行器', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 3 } },
    { type: 'step/start', seq: 1, data: { turn: 3, step: 2 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown, options?: unknown) {
      const event = { type, seq: events.length, data, ...(options === undefined ? {} : { options }) }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-tools' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  const handle = bridge.appendToolCall?.('native-tools', {
    callId: 'external-1',
    name: 'read_directory',
    arguments: '{"path":"."}',
    adapterId: 'codex',
  })
  assert.deepEqual(handle, { sessionId: 'native-tools', turn: 3, step: 2, callId: 'external-1', callSeq: 3 })
  assert.equal(bridge.appendToolResult?.(handle!, { output: 'a.ts', isError: false }), true)
  assert.deepEqual(events.slice(2), [
    {
      type: 'assistant/message',
      seq: 2,
      data: {
        turn: 3,
        step: 2,
        message: {
          id: 'external-tool-external-1-3-2',
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: 'external-1',
            name: 'read_directory',
            arguments: '{"path":"."}',
          }],
          source: { kind: 'model', plugin: 'codingns4dsh', provider: 'codex', model: 'codex' },
        },
        stream: [],
      },
      options: { surfaceOp: 'append' },
    },
    {
      type: 'tool/call',
      seq: 3,
      data: { turn: 3, step: 2, callId: 'external-1', name: 'read_directory', arguments: '{"path":"."}' },
    },
    {
      type: 'tool/result',
      seq: 4,
      data: {
        turn: 3,
        step: 2,
        message: {
          id: 'external-1-result-3-2',
          role: 'tool',
          toolCallId: 'external-1',
          content: [{ type: 'text', text: 'a.ts' }],
          source: { kind: 'tool', callId: 'external-1' },
        },
      },
      options: { surfaceOp: 'append', sourceEventSeqs: [3] },
    },
  ])

  session.append('assistant/message', {
    turn: 3,
    step: 2,
    message: {
      id: 'final-answer',
      role: 'assistant',
      content: [{ type: 'text', text: '目录已读取。' }],
      source: { kind: 'model', plugin: 'codingns4dsh', provider: 'codingns-external', model: 'external-agent' },
    },
    stream: [],
  }, { surfaceOp: 'append' })
  assert.equal(events.at(-1)?.type, 'assistant/message')
  assert.equal(events.at(-1)?.data?.message?.id, 'final-answer')
})

test('原生会话桥接保存外部 Agent 的 request/context 容量元数据', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendRequestContext?.('native-context', {
    provider: 'codex',
    model: 'gpt-5.3-codex',
    contextWindow: 258400,
  }), true)
  assert.deepEqual(events[2], {
    type: 'request/context',
    seq: 2,
    data: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 258400 },
  })
})

test('原生会话桥接跳过等价 request/context 并保留已有上下文容量', () => {
  const events: Array<Record<string, any>> = [
    { type: 'request/context', seq: 0, data: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 258400 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context-stable' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendRequestContext?.('native-context-stable', {
    provider: 'codex',
    model: 'gpt-5.3-codex',
  }), true)
  assert.equal(bridge.appendRequestContext?.('native-context-stable', {
    provider: 'codex',
    model: 'gpt-5.3-codex',
    contextWindow: 258400,
  }), true)
  assert.equal(events.length, 1)
})

test('原生会话桥接拒绝同一路由的冲突上下文容量', () => {
  const events: Array<Record<string, any>> = [
    { type: 'request/context', seq: 0, data: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 1000000 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context-conflict' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendRequestContext?.('native-context-conflict', {
    provider: 'codex',
    model: 'gpt-5.3-codex',
    contextWindow: 258400,
    confirmed: true,
  }), true)
  assert.equal(events.length, 2)
  assert.equal(events.at(-1)?.data?.contextWindow, 258400)
  assert.equal(bridge.appendRequestContext?.('native-context-conflict', {
    provider: 'codex',
    model: 'gpt-5.3-codex',
    contextWindow: 1000000,
    confirmed: true,
  }), true)
  assert.equal(events.length, 2)
})

test('原生会话桥接允许 catalog 提示修正每个新 step 的 1M 占位值', () => {
  const events: Array<Record<string, any>> = [
    { type: 'request/context', seq: 0, data: { provider: 'codex', model: 'gpt-5.6-sol', contextWindow: 1000000 } },
    {
      type: 'assistant/attempt',
      seq: 1,
      data: { stream: [{ chunk: { type: 'usage', usage: { contextWindow: 258400 } } }] },
    },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context-catalog' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendRequestContext?.('native-context-catalog', {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    contextWindow: 258400,
    confirmed: true,
  }), true)
  events.push({ type: 'request/context', seq: events.length, data: { provider: 'codex', model: 'gpt-5.6-sol', contextWindow: 1000000 } })
  assert.equal(bridge.appendRequestContext?.('native-context-catalog', {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    contextWindow: 258400,
    confirmed: true,
    source: 'catalog',
  }), true)
  assert.equal(events.at(-1)?.data?.contextWindow, 258400)
})

test('原生会话桥接从历史 usage 恢复稳定窗口，纠正尾部遗留的 1M', () => {
  const events: Array<Record<string, any>> = [
    { type: 'request/context', seq: 0, data: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 1000000 } },
    {
      type: 'assistant/attempt',
      seq: 1,
      data: { stream: [{ chunk: { type: 'usage', usage: { contextWindow: 258400 } } }] },
    },
    { type: 'request/context', seq: 2, data: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 1000000 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context-history' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendRequestContext?.('native-context-history', {
    provider: 'codex',
    model: 'gpt-5.3-codex',
    contextWindow: 1000000,
    confirmed: true,
  }), true)
  assert.equal(events.at(-1)?.data?.contextWindow, 258400)
})

test('原生会话桥接在路由切换时不继承其他 Provider 的上下文容量', () => {
  const events: Array<Record<string, any>> = [
    { type: 'request/context', seq: 0, data: { provider: 'glor', model: 'deepseek-v4.1-flash', contextWindow: 1000000 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context-route' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  // 相邻请求可能来自别的主模型（DSH 的通用 1M 占位），跨路由继承会让新
  // 路由显示错误的分母；没有该路由事实时先写无容量事件，交给 Provider usage。
  assert.equal(bridge.appendRequestContext?.('native-context-route', {
    provider: 'opencode',
    model: 'deepseek/deepseek-flash',
  }), true)
  assert.deepEqual(events.at(-1), {
    type: 'request/context',
    seq: 1,
    data: { provider: 'opencode', model: 'deepseek/deepseek-flash' },
  })
})

test('已确认容量不被新 step 的占位值改写，Provider usage 可随时写回', () => {
  const events: Array<Record<string, any>> = [
    { type: 'request/context', seq: 0, data: { provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 1000000 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context-reassert' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendRequestContext?.('native-context-reassert', {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    contextWindow: 258400,
    confirmed: true,
  }), true)
  assert.equal(events.at(-1)?.data?.contextWindow, 258400)
  // DSH 每个新 step 会先写入一次通用占位值（这里是 1M 的旧污染形态）
  events.push({ type: 'request/context', seq: events.length, data: { provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 1000000 } })
  // 真实用法到达时必须能把分母写回已确认容量，不能因“已确认保护”被丢弃
  assert.equal(bridge.appendRequestContext?.('native-context-reassert', {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    contextWindow: 258400,
    confirmed: true,
  }), true)
  assert.equal(events.at(-1)?.data?.contextWindow, 258400)
  // 迟到的错误值仍然不能覆盖已确认容量
  assert.equal(bridge.appendRequestContext?.('native-context-reassert', {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    contextWindow: 1000000,
    confirmed: true,
  }), true)
  assert.equal(events.at(-1)?.data?.contextWindow, 258400)
})

test('跨路由回访与进程重启后从该路由首个 usage 恢复容量', () => {
  const events: Array<Record<string, any>> = [
    { type: 'request/context', seq: 0, data: { provider: 'glor', model: 'deepseek-v4.1-flash', contextWindow: 1000000 } },
    { type: 'assistant/attempt', seq: 1, data: { stream: [{ chunk: { type: 'usage', usage: { contextWindow: 1000000 } } }] } },
    { type: 'request/context', seq: 2, data: { provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 258400 } },
    { type: 'assistant/attempt', seq: 3, data: { stream: [{ chunk: { type: 'usage', usage: { contextWindow: 258400 } } }] } },
    { type: 'request/context', seq: 4, data: { provider: 'glor', model: 'deepseek-v4.1-flash', contextWindow: 1000000 } },
    // 修复前的历史遗留：跨路由继承把 codex 分母污染回通用 1M
    { type: 'request/context', seq: 5, data: { provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 1000000 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context-routeinfo' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  // Registry 新一轮只提供适配器身份：按路由归属的首个 usage 恢复 258400，
  // 不受其他 Provider 的 usage 与尾部污染值影响（进程重启后同样成立）。
  assert.equal(bridge.appendRequestContext?.('native-context-routeinfo', {
    provider: 'codex',
    model: 'gpt-6.1-sol',
  }), true)
  assert.equal(events.at(-1)?.data?.contextWindow, 258400)
})

test('catalog 提示与已确认容量冲突时不写入', () => {
  const events: Array<Record<string, any>> = [
    { type: 'request/context', seq: 0, data: { provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 1000000 } },
    { type: 'assistant/attempt', seq: 1, data: { stream: [{ chunk: { type: 'usage', usage: { contextWindow: 258400 } } }] } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-context-catalog-stale' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendRequestContext?.('native-context-catalog-stale', {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    contextWindow: 258400,
    confirmed: true,
  }), true)
  events.push({ type: 'request/context', seq: events.length, data: { provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 1000000 } })
  // 模型表更新滞后的 catalog 提示：不得覆盖已确认的 Provider 事实
  assert.equal(bridge.appendRequestContext?.('native-context-catalog-stale', {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    contextWindow: 500000,
    confirmed: true,
    source: 'catalog',
  }), true)
  assert.equal(events.at(-1)?.data?.contextWindow, 258400)
})

test('usage 样本以已确认容量为准，不被未确认的占位值改写', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'request/context', seq: 2, data: { provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 1000000 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-usage-trust' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  // 没有已确认容量时，未验证的占位值不能反过来覆盖 Provider 的真实 usage
  assert.equal(bridge.appendUsageSample?.('native-usage-trust', {
    inputTokens: 120,
    outputTokens: 8,
    contextWindow: 258400,
    contextTokens: 9120,
  }), true)
  assert.equal(events.at(-1)?.data?.stream?.[0]?.chunk?.usage?.contextWindow, 258400)
})

test('迟到错误值的 usage 样本仍以已确认容量落盘', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'request/context', seq: 2, data: { provider: 'codex', model: 'gpt-6.1-sol', contextWindow: 1000000 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-usage-late' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendRequestContext?.('native-usage-late', {
    provider: 'codex',
    model: 'gpt-6.1-sol',
    contextWindow: 258400,
    confirmed: true,
  }), true)
  assert.equal(bridge.appendUsageSample?.('native-usage-late', {
    inputTokens: 120,
    outputTokens: 8,
    contextWindow: 1000000,
    contextTokens: 9120,
  }), true)
  const usage = events.at(-1)?.data?.stream?.[0]?.chunk?.usage
  assert.equal(usage?.contextWindow, 258400)
  assert.equal(usage?.contextUsageRatio, Number(Math.min(1, 9120 / 258400).toFixed(6)))
})

test('原生会话桥接把即时 usage 写入非 surface assistant/attempt', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-usage-sample' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendUsageSample?.('native-usage-sample', {
    inputTokens: 120,
    outputTokens: 8,
    cacheReadTokens: 9000,
    contextWindow: 1000000,
    contextTokens: 9120,
  }), true)
  assert.deepEqual(events.at(-1), {
    type: 'assistant/attempt',
    seq: 2,
    data: {
      turn: 1,
      step: 1,
      stream: [{
        type: 'chunk',
        time: events.at(-1)?.data?.stream?.[0]?.time,
        chunk: {
          type: 'usage',
          usage: {
            inputTokens: 120,
            outputTokens: 8,
            cacheReadTokens: 9000,
            contextWindow: 1000000,
            contextTokens: 9120,
          },
        },
      }],
    },
  })
})

test('原生会话桥接把 Codex 压缩活动写成标准 compaction 生命周期', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: '旧问题' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: '旧回答' }], source: { kind: 'model', provider: 'codex', model: 'gpt-5.3-codex' } }, stream: [] }, surfaceOp: 'append' },
  ]
  const session = {
    surface: { nodes: [2, 3] },
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown, options?: unknown) {
      const event = { type, seq: events.length, data, ...(options === undefined ? {} : { options }) }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-compaction' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendCompactionEvent?.('native-compaction', { type: 'context-compaction', phase: 'start', compactionId: 'compact-1', provider: 'codex', model: 'gpt-5.3-codex' }), true)
  assert.equal(bridge.appendCompactionEvent?.('native-compaction', { type: 'context-compaction', phase: 'summary', compactionId: 'compact-1', summary: '保留任务目标。', provider: 'codex', model: 'gpt-5.3-codex', shadowedTokenCount: 200 }), true)
  assert.equal(bridge.appendCompactionEvent?.('native-compaction', { type: 'context-compaction', phase: 'end', compactionId: 'compact-1' }), true)
  assert.deepEqual(events.slice(4).map((event) => event.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  assert.deepEqual(events[5]?.data, {
    compactionId: 'compact-1',
    summary: [{ type: 'text', text: '保留任务目标。' }],
    shadowedRange: { start: 2, end: 3 },
    shadowedSeqs: [2, 3],
    shadowedTokenCount: 200,
    provider: 'codex',
    model: 'gpt-5.3-codex',
  })
  assert.deepEqual(events[6]?.options, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3] })
  assert.deepEqual(events[6]?.data?.source, { kind: 'plugin', plugin: 'compact' })
})

test('携带摘要的压缩 end 事件仍会闭合 compaction 事务', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: '旧问题' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: '旧回答' }], source: { kind: 'model', provider: 'codex', model: 'gpt-5.3-codex' } }, stream: [] }, surfaceOp: 'append' },
  ]
  const session = {
    surface: { nodes: [2, 3] },
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown, options?: unknown) {
      const event = { type, seq: events.length, data, ...(options === undefined ? {} : { options }) }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-compaction-end' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendCompactionEvent?.('native-compaction-end', { type: 'context-compaction', phase: 'start', compactionId: 'compact-end', provider: 'codex', model: 'gpt-5.3-codex' }), true)
  // 旧版 Codex 只在完成信号里携带摘要：end 必须在写 summary 与检查点之后继续写 compaction/end，
  // 否则会话日志会残留未闭合 compaction，历史加载时报 "turn/end crosses an open compaction"。
  assert.equal(bridge.appendCompactionEvent?.('native-compaction-end', { type: 'context-compaction', phase: 'end', compactionId: 'compact-end', summary: '保留任务目标。' }), true)
  assert.deepEqual(events.slice(4).map((event) => event.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  assert.deepEqual(events.at(-1)?.data, { compactionId: 'compact-end', turn: 1 })
})

test('已关闭 turn 的未闭合压缩不会挂住新 turn 的压缩事务', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: '旧问题' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: '旧回答' }], source: { kind: 'model', provider: 'codex', model: 'gpt-5.3-codex' } }, stream: [] }, surfaceOp: 'append' },
  ]
  const session = {
    surface: { nodes: [2, 3] },
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown, options?: unknown) {
      const event = { type, seq: events.length, data, ...(options === undefined ? {} : { options }) }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-compaction-stale' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendCompactionEvent?.('native-compaction-stale', { type: 'context-compaction', phase: 'start', compactionId: 'compact-stale', provider: 'codex', model: 'gpt-5.3-codex' }), true)
  events.push({ type: 'step/end', seq: events.length, data: { turn: 1, step: 1 } })
  events.push({ type: 'turn/end', seq: events.length, data: { turn: 1 } })
  events.push({ type: 'turn/start', seq: events.length, data: { turn: 2 } })
  events.push({ type: 'step/start', seq: events.length, data: { turn: 2, step: 1 } })
  // turn 1 的压缩没有完成就结束了：事务无法在事后补救，但不能把新 turn 的压缩
  // 挂到已经关闭的旧 turn 上，否则后续 end 会写进错误的 turn。
  assert.equal(bridge.appendCompactionEvent?.('native-compaction-stale', { type: 'context-compaction', phase: 'start', compactionId: 'compact-fresh', provider: 'codex', model: 'gpt-5.3-codex' }), true)
  assert.deepEqual(events.filter((event) => event.type === 'compaction/start').at(-1)?.data, { compactionId: 'compact-fresh', turn: 2 })
  assert.equal(bridge.appendCompactionEvent?.('native-compaction-stale', { type: 'context-compaction', phase: 'end', compactionId: 'compact-fresh' }), true)
  assert.deepEqual(events.at(-1)?.data, { compactionId: 'compact-fresh', turn: 2, error: 'Provider 未返回可投影的压缩摘要。' })
})

test('Session V4 的压缩检查点改用生产者自持的 compact-checkpoint 标识', () => {
  const events: Array<Record<string, any>> = [
    { type: 'session', version: 4, seq: 0 },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 3, data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: '旧问题' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 4, data: { turn: 1, step: 1, message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: '旧回答' }], source: { kind: 'model', provider: 'codex', model: 'gpt-5.3-codex' } }, stream: [] }, surfaceOp: 'append' },
  ]
  const session = {
    surface: { nodes: [3, 4] },
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown, options?: unknown) {
      const event = { type, seq: events.length, data, ...(options === undefined ? {} : { options }) }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'v4-compaction' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendCompactionEvent?.('v4-compaction', { type: 'context-compaction', phase: 'start', compactionId: 'compact-v4', provider: 'codex', model: 'gpt-5.3-codex' }), true)
  assert.equal(bridge.appendCompactionEvent?.('v4-compaction', { type: 'context-compaction', phase: 'summary', compactionId: 'compact-v4', summary: '保留任务目标。', provider: 'codex', model: 'gpt-5.3-codex', shadowedTokenCount: 200 }), true)
  assert.deepEqual(events.slice(5).map((event) => event.type), ['compaction/start', 'compaction/summary', 'user/message'])
  assert.deepEqual(events[7]?.data?.source, { kind: 'compact-checkpoint', compactionId: 'compact-v4' })
  assert.deepEqual(events[7]?.data?.content, [{ type: 'text', text: '保留任务目标。' }])
  assert.deepEqual(events[7]?.options, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [3, 4] })
})

test('原生会话桥接把失败结果写成带 isError 的 V4 tool-role 消息', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown, options?: unknown) {
      const event = { type, seq: events.length, data, ...(options === undefined ? {} : { options }) }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'failed-tool' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)
  const handle = bridge.appendToolCall?.('failed-tool', { callId: 'failed-1', name: 'bash', arguments: '{}', adapterId: 'codex' })
  assert.equal(bridge.appendToolResult?.(handle!, { output: 'permission denied', isError: true, error: 'permission denied' }), true)
  assert.deepEqual(events.at(-1)?.data, {
    turn: 1,
    step: 1,
    message: {
      id: 'failed-1-result-1-1',
      role: 'tool',
      toolCallId: 'failed-1',
      content: [{ type: 'text', text: 'permission denied' }],
      source: { kind: 'tool', callId: 'failed-1' },
      isError: true,
    },
    error: { name: 'ExternalToolError', code: 'EXTERNAL_TOOL_FAILED', reason: 'permission denied' },
  })
})

test('原生会话桥接按当前 step 顺序保存外部工具 call/result 事件', () => {
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 3 } },
    { type: 'step/start', seq: 1, data: { turn: 3, step: 2 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown, options?: unknown) {
      const event = { type, seq: events.length, data, ...(options === undefined ? {} : { options }) }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'sessions'
        ? { get(id: string) { return id === 'native-tools' ? session : undefined }, list() { return [session] } }
        : undefined
    },
  } as never)

  assert.equal(bridge.appendExternalToolEvent?.('native-tools', {
    phase: 'start',
    callId: 'bash-1',
    name: 'bash',
    arguments: '{"command":"pwd"}',
    status: 'running',
  }), true)
  assert.equal(bridge.appendExternalToolEvent?.('native-tools', {
    phase: 'update',
    callId: 'bash-1',
    name: 'bash',
    arguments: '{"command":"pwd"}',
    status: 'completed',
    output: '/workspace',
  }), true)
  assert.deepEqual(events.slice(2), [
    {
      type: 'assistant/message',
      seq: 2,
      data: {
        turn: 3,
        step: 2,
        message: {
          id: 'external-tool-bash-1-3-2',
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: 'bash-1',
            name: 'bash',
            arguments: '{"command":"pwd"}',
          }],
          source: { kind: 'model', plugin: 'codingns4dsh', provider: 'codingns-external', model: 'external-agent' },
        },
        stream: [],
      },
      options: { surfaceOp: 'append' },
    },
    {
      type: 'tool/call',
      seq: 3,
      data: {
        turn: 3,
        step: 2,
        callId: 'bash-1',
        name: 'bash',
        arguments: '{"command":"pwd"}',
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      data: {
        turn: 3,
        step: 2,
        message: {
          id: 'bash-1-result-3-2',
          role: 'tool',
          toolCallId: 'bash-1',
          content: [{ type: 'text', text: '/workspace' }],
          source: { kind: 'tool', callId: 'bash-1' },
        },
      },
      options: { surfaceOp: 'append', sourceEventSeqs: [3] },
    },
  ])
})

test('原生会话桥接通过 DSH approval 和 userQuestions 服务完成交互', async () => {
  const agent = { id: 'interactive-session' }
  const approvalRequests = []
  const questionRequests = []
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      if (name === 'agents') return { get(id: string) { return id === agent.id ? agent : undefined } }
      if (name === 'approval') return {
        async request(request: unknown) {
          approvalRequests.push(request)
          return 'allowed-once'
        },
      }
      if (name === 'userQuestions') return {
        async ask(request: unknown) {
          questionRequests.push(request)
          return { answers: [{ id: 'language', selected: ['TypeScript'] }] }
        },
      }
      return undefined
    },
  } as never)

  assert.equal(await bridge.requestApproval?.('interactive-session', {
    requestId: 'permission-1',
    toolName: 'edit',
    callId: 'edit-1',
    reason: '修改文件',
  }), 'allowed-once')
  assert.deepEqual(await bridge.askQuestions?.('interactive-session', {
    requestId: 'question-1',
    questions: [{ id: 'language', question: '选择语言' }],
  }), {
    requestId: 'question-1',
    answers: [{ id: 'language', selected: ['TypeScript'] }],
  })
  assert.deepEqual(approvalRequests, [{ agent, toolName: 'edit', callId: 'edit-1', reason: '修改文件' }])
  assert.deepEqual(questionRequests, [{ agent, questions: [{ id: 'language', question: '选择语言' }] }])
})

test('原生会话桥接使用 Agent.inject 把外部工具推进下一个合法 step', () => {
  const messages: unknown[] = []
  const agent = { id: 'step-session', inject(message: unknown) { messages.push(message) } }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'agents' ? { get(id: string) { return id === agent.id ? agent : undefined } } : undefined
    },
  } as never)

  assert.equal(bridge.canInjectNextStep?.('step-session'), true)
  assert.equal(bridge.injectNextStep?.('step-session', '工具一已完成'), true)
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], {
    id: (messages[0] as { id: string }).id,
    role: 'user',
    content: [{ type: 'text', text: '工具一已完成' }],
    source: { kind: 'plugin', plugin: 'codingns4dsh', form: 'notice', summary: '工具一已完成' },
  })
  assert.equal(bridge.injectNextStep?.('missing'), false)
  assert.equal(bridge.canInjectNextStep?.('missing'), false)
})

test('Agent.inject 尚未创建新 step 时不把后续工具追加到旧 step', () => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const events: Array<Record<string, any>> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  const session = {
    snapshotEvents() { return [...events] },
    append(type: string, data: unknown) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const agent = { id: 'step-race', inject() {} }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      if (name === 'sessions') return { get(id: string) { return id === agent.id ? session : undefined }, list() { return [session] } }
      if (name === 'agents') return { get(id: string) { return id === agent.id ? agent : undefined } }
      return undefined
    },
    on(name: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  } as never)
  const dispose = bridge.subscribe({ onEvent() {} })

  assert.equal(bridge.injectNextStep?.(agent.id), true)
  assert.equal(bridge.appendToolCall?.(agent.id, { callId: 'next-call', name: 'bash', arguments: '{}' }), null)

  events.push({ type: 'step/start', seq: events.length, data: { turn: 1, step: 2 } })
  listeners.get('session/event')?.(session, events.at(-1))
  const handle = bridge.appendToolCall?.(agent.id, { callId: 'next-call', name: 'bash', arguments: '{}' })
  assert.deepEqual(handle, { sessionId: agent.id, turn: 1, step: 2, callId: 'next-call', callSeq: 4 })
  assert.equal(events.filter((event) => event.type === 'tool/call').length, 1)
  assert.equal((events.find((event) => event.type === 'tool/call')?.data as { step: number }).step, 2)
  dispose()
})

test('DSH 0.1.7 使用 model-selection source 注入下一个 step', () => {
  const messages: unknown[] = []
  const agent = { id: 'modern-step-session', inject(message: unknown) { messages.push(message) } }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      return name === 'agents' ? { get(id: string) { return id === agent.id ? agent : undefined } } : undefined
    },
  } as never, '0.1.7-rc.2')

  assert.equal(bridge.injectNextStep?.('modern-step-session', '工具已完成'), true)
  assert.deepEqual((messages[0] as { source: unknown }).source, {
    kind: 'model-selection',
    form: 'notice',
    summary: '工具已完成',
  })
})

test('注入消息的 source 语法跟随会话 generation 而不是运行时版本号', () => {
  const messages: Array<{ session: string; source: unknown }> = []
  const sessions: Record<string, unknown> = {
    'v4-step': { snapshotEvents() { return [{ type: 'session', version: 4, seq: 0 }] }, append() { return undefined } },
    'v3-step': { snapshotEvents() { return [{ type: 'session', version: 3, seq: 0 }] }, append() { return undefined } },
  }
  const agents: Record<string, unknown> = {}
  for (const id of Object.keys(sessions)) {
    agents[id] = { inject(message: unknown) { messages.push({ session: id, source: (message as { source: unknown }).source }) } }
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      if (name === 'sessions') return { get(id: string) { return sessions[id] }, list() { return Object.values(sessions) } }
      if (name === 'agents') return { get(id: string) { return agents[id] } }
      return undefined
    },
  } as never, '0.2.0-rc.1')

  assert.equal(bridge.injectNextStep?.('v4-step', '工具已完成'), true)
  assert.equal(bridge.injectNextStep?.('v3-step', '工具已完成'), true)
  assert.deepEqual(messages[0]?.source, { kind: 'model-selection', form: 'notice', summary: '工具已完成' })
  assert.deepEqual(messages[1]?.source, { kind: 'plugin', plugin: 'codingns4dsh', form: 'notice', summary: '工具已完成' })
})

test('真实 Session header 的 v4 generation 优先于过期运行时版本', () => {
  const messages: unknown[] = []
  const session = {
    // DSH v4 的版本在 Session.header，不会出现在 snapshotEvents() 中。
    header: { version: 4 },
    snapshotEvents() { return [{ type: 'permission/preset', seq: 0 }] },
    append() { return undefined },
  }
  const agent = { inject(message: unknown) { messages.push(message) } }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      if (name === 'sessions') return { get(id: string) { return id === 'header-v4' ? session : undefined }, list() { return [session] } }
      if (name === 'agents') return { get(id: string) { return id === 'header-v4' ? agent : undefined } }
      return undefined
    },
  } as never, '0.1.6-alpha.2')

  assert.equal(bridge.formatVersion?.('header-v4'), 4)
  assert.equal(bridge.injectNextStep?.('header-v4', '工具已完成'), true)
  assert.deepEqual((messages[0] as { source: unknown }).source, {
    kind: 'model-selection',
    form: 'notice',
    summary: '工具已完成',
  })
})

test('0.2 世代运行时版本判定为 modern，缺会话头时仍写入 producer-owned 来源', () => {
  // 0.2.x 的判据依赖 `minor > 1` 子句（0.2.0-rc.2 与 0.2.1-alpha.1 的 minor 都是 2，
  // 不是 1）。一旦该子句被写漏，0.2 世代会被误判为旧版。
  //
  // 注意会话必须**不带可识别的 generation**：`usesProducerOwnedSource` 优先按
  // 会话头判定（format 4 → true、format 3 → false），只有会话头缺失时才回退到
  // 运行时版本推断。若夹具写成 `version: 4`，这条用例会被短路成恒真、失去意义。
  for (const dshVersion of ['0.2.0-rc.2', '0.2.1-alpha.1']) {
    const messages: unknown[] = []
    const session = {
      snapshotEvents() { return [{ type: 'permission/preset', seq: 0 }] },
      append() { return undefined },
    }
    const agent = { inject(message: unknown) { messages.push(message) } }
    const bridge = createCodingNsNativeSessionBridge({
      get(name: string) {
        if (name === 'sessions') return { get() { return session }, list() { return [session] } }
        if (name === 'agents') return { get() { return agent } }
        return undefined
      },
    } as never, dshVersion)

    assert.equal(bridge.injectNextStep?.('modern', '工具已完成'), true, dshVersion)
    // 旧版推断会写成 `kind: 'plugin'`；v4 的准入会拒绝该形状。
    assert.deepEqual((messages[0] as { source: unknown }).source, {
      kind: 'model-selection',
      form: 'notice',
      summary: '工具已完成',
    }, dshVersion)
  }
})

test('next-step 注入失败时返回 false 且不吞掉原因，便于定位子会话停摆', () => {
  // 子代理会话注入失败后 DSH 不会发起第二次 llm/stream，子会话会停在当前 step
  // 并以 error 结算；这里固定「失败必须返回 false 且不抛异常」的契约。
  const failing = createCodingNsNativeSessionBridge({
    get(name: string) {
      if (name === 'agents') return { get() { return { inject() { throw new Error('format v4 message requires a producer-owned source kind') } } } }
      if (name === 'sessions') return { get() { return { snapshotEvents() { return [{ type: 'session', version: 4, seq: 0 }] }, append() { return undefined } } }, list() { return [] } }
      return undefined
    },
  } as never, '0.2.0-rc.2')
  // 注入被拒不能把异常抛回 llm/stream：那会污染整轮投影，掩盖真实原因。
  assert.equal(failing.injectNextStep?.('v4-reject', '工具已完成'), false)

  // Agent 不存在时同样必须安静失败，而不是抛错中断外部 Agent。
  const missing = createCodingNsNativeSessionBridge({ get() { return undefined } } as never)
  assert.equal(missing.injectNextStep?.('missing-agent'), false)
})

test('原生会话桥接通过 WorkspaceController 同步侧栏归档状态', async () => {
  const calls: string[] = []
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      if (name !== 'workspaceController') return undefined
      return {
        archiveSession(input: { sessionId: string }) { calls.push(`archive:${input.sessionId}`) },
        unarchiveSession(input: { sessionId: string }) { calls.push(`unarchive:${input.sessionId}`) },
      }
    },
  } as never)

  assert.equal(bridge.available, true)
  assert.equal(await bridge.archive?.('dsh-1'), true)
  assert.equal(await bridge.unarchive?.('dsh-1'), true)
  assert.deepEqual(calls, ['archive:dsh-1', 'unarchive:dsh-1'])
})

test('归档时重新发现晚于插件装载的 WorkspaceController', async () => {
  const calls: string[] = []
  let workspaceController: { archiveSession(input: { sessionId: string }): void } | undefined
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) { return name === 'workspaceController' ? workspaceController : undefined },
  } as never)
  assert.equal(bridge.available, false)
  assert.equal(await bridge.archive?.('dsh-late'), false)

  workspaceController = {
    archiveSession(input) { calls.push(input.sessionId) },
  }
  assert.equal(bridge.available, true)
  assert.equal(await bridge.archive?.('dsh-late'), true)
  assert.deepEqual(calls, ['dsh-late'])
})

test('Session V4 generation 可被识别，未来 generation 不被旧投影器追加事件', () => {
  const events: Array<Record<string, unknown>> = [
    { type: 'session', version: 4, seq: 0 },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  const futureEvents: Array<Record<string, unknown>> = [
    { type: 'session', version: 5, seq: 0 },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
  ]
  const createSession = (rows: Array<Record<string, unknown>>) => ({
    snapshotEvents() { return rows },
    append(type: string, data: unknown) {
      rows.push({ type, seq: rows.length, data })
      return rows.at(-1)
    },
  })
  const v4 = createSession(events)
  const future = createSession(futureEvents)
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      if (name !== 'sessions') return undefined
      return {
        get(id: string) { return id === 'v4' ? v4 : id === 'v5' ? future : undefined },
        list() { return [v4, future] },
      }
    },
  } as never)
  assert.equal(bridge.formatVersion?.('v4'), 4)
  assert.equal(bridge.formatVersion?.('v5'), 'unsupported')
  assert.notEqual(bridge.appendToolCall?.('v4', { callId: 'v4-call', name: 'read', arguments: '{}' }), null)
  assert.equal(bridge.appendToolCall?.('v5', { callId: 'v5-call', name: 'read', arguments: '{}' }), null)
  assert.equal(futureEvents.length, 2)
})
