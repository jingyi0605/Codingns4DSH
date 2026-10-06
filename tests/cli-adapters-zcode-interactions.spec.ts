import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import { readZcodeInteraction, zcodePermissionMode } from '../data/build/dist/host/cli-adapters/zcode-interactions.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'

// 来自 ZCode 3.14.4 实机请求；保留业务 requestId、RPC id、toolCallId 的区别。
const questionRequest = {
  id: 'server-3', method: 'interaction/requestUserInput', params: {
    requestId: 'perm-question', sessionId: 'sess-probe', toolCallId: 'call-question', toolName: 'AskUserQuestion',
    schema: { toolName: 'AskUserQuestion' },
    questions: [{ question: '17 + 25 等于多少？', header: '计算题',
      options: [{ label: '41', value: '41' }, { label: '42', value: '42' }, { label: '43', value: '43' }] }],
  },
}
const permissionRequest = {
  id: 'server-4', method: 'interaction/requestPermission', params: {
    requestId: 'perm-write', sessionId: 'sess-probe', toolCallId: 'call-write', toolName: 'Write',
    input: { file_path: '/workspace/probe.txt', content: 'ZCODE_PERMISSION_PROBE' },
    reason: 'Tool has side effects and requires approval', riskLevel: 'medium',
    options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once', response: { decision: 'allow' } }],
  },
}

function createReplay(request?: typeof questionRequest | typeof permissionRequest, duplicate: 'before' | 'after' | undefined = undefined, toolEvents = false) {
  const calls: any[] = []
  const responses: any[] = []
  let notify!: (message: any) => void
  let sendId: unknown
  let stopped = false
  const driver = new ZcodeAppServerDriver({
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: 'zcode 3.14.4', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      notify = (message) => stdout.write(`${JSON.stringify(message)}\n`)
      const reply = (id: unknown, result = {}) => notify({ id, result })
      const complete = () => {
        reply(sendId)
        if (toolEvents) notify({ method: 'session/event', params: { type: 'tool.updated', payload: {
          kind: 'result', toolCallId: 'call-question', result: { success: true, content: '用户回答 42' },
        } } })
        notify({ method: 'session/event', params: { type: 'model.streaming', payload: { kind: 'text_delta', delta: '42，答案正确' } } })
        notify({ method: 'state.updated', params: { patch: { status: 'idle' } } })
      }
      return { stdout, stderr, stdin: { write(line: string) {
        const value = JSON.parse(line)
        assert.equal(value.jsonrpc, undefined, 'ZCode 必须使用裸信封')
        calls.push(value)
        if (value.method === undefined) {
          responses.push(value)
          if (duplicate === 'after' && responses.length === 1 && !stopped) {
            notify({ ...request, id: 'server-replay' })
          } else if (!stopped && responses.length === (duplicate ? 2 : 1)) complete()
          return
        }
        if (value.method === 'session/create' || value.method === 'session/resume') {
          reply(value.id, { session: { sessionId: 'sess-probe' }, settings: { model: {
            available: [{ ref: { providerId: 'deepseek', modelId: 'deepseek-flash' },
              reasoning: { defaultLevel: 'high', levels: [{ value: 'disabled' }, { value: 'high' }] } }],
            current: { providerId: 'other', modelId: 'default' },
          } } })
        } else if (value.method === 'session/send') {
          sendId = value.id
          stopped = false
          notify({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })
          // 故意把 send 响应延后到交互应答，验证不会双向死锁。
          if (request === undefined) complete()
          else {
            if (toolEvents) {
              for (const payload of [
                { kind: 'tool_input_start', toolCallId: 'call-question', toolName: 'AskUserQuestion' },
                { kind: 'tool_input_delta', toolCallId: 'call-question', delta: JSON.stringify({ questions: questionRequest.params.questions }) },
                { kind: 'tool_input_end', toolCallId: 'call-question' },
              ]) notify({ method: 'session/event', params: { type: 'model.streaming', payload } })
            }
            notify(request)
            if (duplicate === 'before') notify({ ...request, id: 'server-replay' })
          }
        } else if (value.method === 'session/stop') {
          stopped = true
          reply(value.id)
        } else reply(value.id)
      } }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  return { driver, calls, responses, notify: (message: any) => notify(message) }
}

test('ZCode 权限模式覆盖只读、工作区审批、工作区免审批、全权限和缺省', () => {
  const base = { sessionId: 's', messages: [], prompt: '' }
  for (const [sandboxMode, approvalPolicy, mode] of [
    ['read-only', 'never', 'plan'], ['read-only', 'ask', 'plan'],
    ['workspace-write', 'ask', 'build'], ['workspace-write', 'never', 'edit'],
    ['danger-full-access', 'ask', 'build'], ['danger-full-access', 'never', 'yolo'],
  ] as const) assert.equal(zcodePermissionMode({ ...base, permission: { sandboxMode, approvalPolicy } }), mode)
  assert.equal(zcodePermissionMode(base), 'build')
  assert.equal(zcodePermissionMode({ ...base, permission: { approvalPolicy: 'never' } }), 'build')
  assert.equal(zcodePermissionMode({ ...base, plan: true, permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' } }), 'plan')
})

test('ZCode 多选和自由文本按原始问题正文及 option.value 回传', () => {
  const interaction = readZcodeInteraction({ ...questionRequest, params: { ...questionRequest.params, questions: [
    { question: ' 选择语言 ', header: '语言', multiSelect: true, options: [{ label: '中文', value: 'zh' }, { label: '英文', value: 'en' }] },
    { question: '补充要求', header: '要求', options: [{ label: '默认', value: 'default' }] },
  ] } })
  assert.ok(interaction)
  assert.equal(interaction.event.type, 'question-request')
  assert.deepEqual(interaction.questionResponse({ requestId: 'perm-question', answers: [
    { id: 'question-2', selected: [], custom: '保留兼容性' },
    { id: 'question-1', selected: ['中文', '英文'], custom: '附加要求' },
  ] }), { action: 'accept', content: { answers: { ' 选择语言 ': ['zh', 'en', '附加要求'], '补充要求': ['保留兼容性'] } } })
  assert.deepEqual(interaction.questionResponse({ requestId: 'perm-question', answers: [] }), { action: 'cancel' })
  assert.equal(readZcodeInteraction({ ...questionRequest, id: undefined }), null)
})

test('ZCode 计划批准走审批入口并携带完整计划', () => {
  const interaction = readZcodeInteraction({ ...questionRequest, params: { ...questionRequest.params,
    schema: { interaction: 'plan_approval' }, input: { plan: '1. 修改源码\n2. 检查兼容性' },
  } })
  assert.ok(interaction)
  assert.equal(interaction.event.type, 'permission-request')
  assert.equal((interaction.event as any).detail, '1. 修改源码\n2. 检查兼容性')
  assert.deepEqual(interaction.permissionResponse({ requestId: 'perm-question', approved: true }), { action: 'accept', content: { answer: 'approve' } })
  assert.deepEqual(interaction.permissionResponse({ requestId: 'perm-question', approved: false, reason: '修改方案' }), { action: 'decline', reason: '修改方案' })
})

for (const duplicate of [undefined, 'before', 'after'] as const) {
  test(`ZCode 原生问题闭环：${duplicate ?? '单次'}，send 应答前可回答且重复请求只显示一次`, { timeout: 5_000 }, async () => {
    const replay = createReplay(questionRequest, duplicate)
    let count = 0
    const projector = new CodingNsDshMessageProjector({
      adapterId: 'zcode', sessionId: 'dsh-probe',
      nativeSessions: { available: true, askQuestions: async (_sessionId: string, request: any) => {
        count++
        assert.equal(request.questions[0].question, '17 + 25 等于多少？')
        return { requestId: request.requestId, answers: [{ id: 'question-1', selected: ['42'] }] }
      } } as never,
      respondQuestion: (response) => replay.driver.respondQuestion('dsh-probe', response),
    })
    try {
      const events = []
      for await (const event of replay.driver.executeTurn({ sessionId: 'dsh-probe', messages: [], prompt: '计算题' })) {
        events.push(event)
        await projector.push(event)
      }
      assert.equal(count, 1)
      assert.equal(events.at(-1)?.type, 'finish')
      assert.deepEqual(replay.responses.map((response) => response.result), Array(duplicate ? 2 : 1).fill({ action: 'accept', content: { answers: { '17 + 25 等于多少？': ['42'] } } }))
      assert.equal((events.find((event) => event.type === 'question-request') as any).callId, 'call-question')
    } finally { replay.driver.dispose() }
  })
}

for (const approved of [true, false]) {
  test(`ZCode 原生审批回传 ${approved ? 'allow' : 'deny'}，保留命令与调用标识`, { timeout: 5_000 }, async () => {
    const replay = createReplay(permissionRequest)
    const projector = new CodingNsDshMessageProjector({
      adapterId: 'zcode', sessionId: 'dsh-probe',
      nativeSessions: { available: true, requestApproval: async (_sessionId: string, request: any) => {
        assert.equal(request.callId, 'call-write')
        assert.match(request.reason, /probe.txt/u)
        return approved ? 'allowed-once' : 'denied'
      } } as never,
      respondPermission: (response) => replay.driver.respondPermission('dsh-probe', response),
    })
    try {
      for await (const event of replay.driver.executeTurn({ sessionId: 'dsh-probe', messages: [], prompt: '写文件' })) await projector.push(event)
      assert.equal(replay.responses[0].result.decision, approved ? 'allow' : 'deny')
      assert.equal(replay.responses[0].result.permissionUpdates, undefined, '单次批准不得改写项目永久权限')
    } finally { replay.driver.dispose() }
  })
}

test('ZCode 同一恢复会话逐轮覆盖权限并使用目录默认思考档位', async () => {
  const replay = createReplay()
  try {
    for (const permission of [
      { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
      { sandboxMode: 'read-only', approvalPolicy: 'ask' },
      undefined,
    ] as const) {
      for await (const _event of replay.driver.executeTurn({ sessionId: 'same-session', messages: [], prompt: '测试', providerSessionId: 'persisted-session',
        modelId: 'deepseek/deepseek-flash', permission })) { /* 验证真实下发字段。 */ }
    }
    assert.equal(replay.calls.filter((call) => call.method === 'session/resume').length, 1)
    assert.deepEqual(replay.calls.filter((call) => call.method === 'session/setMode').map((call) => call.params.mode), ['yolo', 'plan', 'build'])
    assert.equal(replay.calls.find((call) => call.method === 'session/setModel').params.model.options.reasoningLevel, 'high')
  } finally { replay.driver.dispose() }
})

test('ZCode 取消等待中的问题立即结束并回传 cancel，不能向其他会话应答', { timeout: 5_000 }, async () => {
  const replay = createReplay(questionRequest)
  const controller = new AbortController()
  const events = []
  try {
    for await (const event of replay.driver.executeTurn({ sessionId: 'cancel-session', messages: [], prompt: '计算题', signal: controller.signal })) {
      events.push(event)
      if (event.type !== 'question-request') continue
      assert.throws(() => replay.driver.respondQuestion('other-session', { requestId: event.requestId, answers: [] }), /问题请求不存在/u)
      controller.abort()
    }
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'cancel' })
    assert.deepEqual(replay.responses[0].result, { action: 'cancel' })
    assert.throws(() => replay.driver.respondQuestion('cancel-session', { requestId: 'perm-question', answers: [] }), /问题请求不存在/u)
  } finally { replay.driver.dispose() }
})

test('ZCode 只读会话拒绝权限提升，即使上层误给出批准', { timeout: 5_000 }, async () => {
  const replay = createReplay(permissionRequest)
  try {
    for await (const event of replay.driver.executeTurn({ sessionId: 'read-only', messages: [], prompt: '测试', permission: { sandboxMode: 'read-only', approvalPolicy: 'ask' } })) {
      if (event.type === 'permission-request') replay.driver.respondPermission('read-only', { requestId: event.requestId, approved: true })
    }
    assert.equal(replay.responses[0].result.decision, 'deny')
  } finally { replay.driver.dispose() }
})

test('ZCode 原生工具流、问题请求和结果只投影一张问题卡片', async () => {
  const replay = createReplay(questionRequest, undefined, true)
  const calls: any[] = []; const results: any[] = []
  const projector = new CodingNsDshMessageProjector({ adapterId: 'zcode', sessionId: 'dsh', nativeSessions: {
    askQuestions: async (_id: string, request: any) => ({ requestId: request.requestId, answers: [{ id: 'question-1', selected: ['42'] }] }),
    appendToolCall: (_id: string, call: any) => { calls.push(call); return { callId: call.callId } },
    appendToolResult: (handle: any, result: any) => { results.push({ ...handle, ...result }); return true },
  } as never, respondQuestion: (response) => replay.driver.respondQuestion('dsh', response) })
  try {
    for await (const event of replay.driver.executeTurn({ sessionId: 'dsh', messages: [], prompt: '测试' })) await projector.push(event)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].name, 'question')
    assert.equal(calls[0].callId, 'call-question')
    assert.equal(results.length, 1)
    assert.match(results[0].output, /42/u)
  } finally { replay.driver.dispose() }
})
