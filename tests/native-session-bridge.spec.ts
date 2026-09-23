import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodingNsNativeSessionBridge } from '../dist/host/native-session-bridge.js'

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
  await bridge.flush('dsh-2')
  assert.equal(flushed, 1)
})

test('原生会话桥接把外部工具保存为只读 call/result 事件且不触发执行器', () => {
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
  })
  assert.deepEqual(handle, { sessionId: 'native-tools', turn: 3, step: 2, callId: 'external-1', callSeq: 2 })
  assert.equal(bridge.appendToolResult?.(handle!, { output: 'a.ts', isError: false }), true)
  assert.deepEqual(events.slice(2), [
    {
      type: 'tool/call',
      seq: 2,
      data: { turn: 3, step: 2, callId: 'external-1', name: 'read_directory', arguments: '{"path":"."}' },
    },
    {
      type: 'tool/result',
      seq: 3,
      data: {
        turn: 3,
        step: 2,
        message: {
          id: 'external-1-result-3-2',
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'external-1', content: [{ type: 'text', text: 'a.ts' }] }],
          source: { kind: 'tool', callId: 'external-1' },
        },
      },
      options: { surfaceOp: 'append', sourceEventSeqs: [2] },
    },
  ])
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
      type: 'tool/call',
      seq: 2,
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
      seq: 3,
      data: {
        turn: 3,
        step: 2,
        message: {
          id: 'bash-1-result-3-2',
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'bash-1',
            content: [{ type: 'text', text: '/workspace' }],
          }],
          source: { kind: 'tool', callId: 'bash-1' },
        },
      },
      options: { surfaceOp: 'append', sourceEventSeqs: [2] },
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
