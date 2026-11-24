import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import { readZcodeInteraction, zcodePermissionMode } from '../data/build/dist/host/cli-adapters/zcode-interactions.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import { createCodingNsNativeSessionBridge } from '../data/build/dist/host/native-session-bridge.js'
import type { JsonRpcMessage } from '../data/build/dist/host/cli-adapters/json-rpc-process.js'

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

function createReplay(request?: JsonRpcMessage, duplicate: 'before' | 'after' | undefined = undefined, toolEvents = false, workflowPolicy = true) {
  const calls: any[] = []
  const responses: any[] = []
  let notify!: (message: any) => void
  let sendId: unknown
  let stopped = false
  const driver = new ZcodeAppServerDriver({ desktopRuntime: null,
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: 'zcode 3.14.4', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let responsesThisTurn = 0
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
          responsesThisTurn += 1
          if (duplicate === 'after' && responsesThisTurn === 1 && !stopped) {
            notify({ ...request, id: 'server-replay' })
          } else if (!stopped && responsesThisTurn === (duplicate ? 2 : 1)) complete()
          return
        }
        if (value.method === 'session/create' || value.method === 'session/resume') {
          reply(value.id, { session: { sessionId: value.method === 'session/resume' ? value.params.sessionId : 'sess-probe' }, settings: { model: {
            available: [{ ref: { providerId: 'deepseek', modelId: 'deepseek-flash' },
              reasoning: { defaultLevel: 'high', levels: [{ value: 'disabled' }, { value: 'high' }] } }],
            current: { providerId: 'other', modelId: 'default' },
          } } })
        } else if (value.method === 'workspace/updateDynamicWorkflowPolicy') {
          if (workflowPolicy) reply(value.id, { enabled: true })
          else notify({ id: value.id, error: { code: -32601, message: 'Method not found' } })
        } else if (value.method === 'session/send') {
          sendId = value.id
          stopped = false
          responsesThisTurn = 0
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

for (const mode of ['manual', 'full-access'] as const) {
  test(`ZCode ${mode} 模式的工作流审批在用户选择后记住当前连接，后续仍受 DSH 审批策略约束`, { timeout: 5_000 }, async () => {
    const workflowRequest = {
      ...permissionRequest,
      params: { ...permissionRequest.params, toolName: 'CreateWorkflow', input: { name: 'probe' } },
    }
    const replay = createReplay(workflowRequest)
    const ctx = new Context()
    let choice = '允许一次'
    let rejectByPolicy = false
    let useOrdinaryApproval = false
    let questions = 0
    let ordinary = 0
    const audits: unknown[] = []
    const bridge = createCodingNsNativeSessionBridge({
      on: ctx.on.bind(ctx),
      get(name: string) {
        if (name === 'agents') return { get: (id: string) => ({ id }) }
        if (name === 'approval') return {
          async request(request: { agent: { id: string } }) {
            const next = async () => { ordinary += 1; return 'allowed-once' }
            const outcome = rejectByPolicy ? 'rejected'
              : await ctx.waterfall(scopeTarget(request.agent, request.agent), 'approval/request', request, next)
            audits.push(outcome)
            return outcome
          },
        }
        if (name === 'userQuestions' && !useOrdinaryApproval) return {
          async ask({ questions: offered }: { questions: Array<{ id: string; options: Array<{ label: string }> }> }) {
            questions += 1
            assert.deepEqual(offered[0].options.map(option => option.label), ['允许一次', '本会话内始终允许', '拒绝'])
            return { answers: [{ id: offered[0].id, selected: [choice] }] }
          },
        }
        return undefined
      },
    } as never)
    async function turn(sessionId: string, nativeApprovalMode: typeof mode | 'auto-review' = mode, cwd = 'D:/fixture') {
      const projector = new CodingNsDshMessageProjector({
        adapterId: 'zcode', sessionId, nativeSessions: bridge,
        respondPermission: response => replay.driver.respondPermission(sessionId, response),
      })
      for await (const event of replay.driver.executeTurn({
        sessionId, cwd, messages: [], prompt: '创建工作流', permission: nativeApprovalMode === 'full-access'
          ? { sandboxMode: 'danger-full-access', approvalPolicy: 'never', nativeApprovalMode }
          : { approvalPolicy: 'ask', nativeApprovalMode },
      })) await projector.push(event)
      return replay.responses.at(-1).result.decision
    }
    try {
      assert.equal(await turn('dsh-a'), 'allow')
      assert.equal(questions, 1)
      choice = '本会话内始终允许'
      assert.equal(await turn('dsh-a'), 'allow')
      assert.equal(questions, 2)
      assert.equal(await turn('dsh-a'), 'allow')
      assert.equal(questions, 2)
      // The permission remains a ZCode connection grant. DSH still audits and can reject each call.
      rejectByPolicy = true
      assert.equal(await turn('dsh-a'), 'deny')
      assert.equal(questions, 2)
      rejectByPolicy = false
      assert.equal(await turn('dsh-a', 'auto-review'), 'allow')
      assert.equal(ordinary, 1)
      choice = '拒绝'
      assert.equal(await turn('dsh-b'), 'deny')
      assert.equal(questions, 3)
      useOrdinaryApproval = true
      assert.equal(await turn('dsh-b'), 'allow')
      assert.equal(ordinary, 2)
      useOrdinaryApproval = false
      assert.equal(await turn('dsh-a', mode, 'D:/other'), 'deny')
      assert.equal(questions, 4)
      assert.deepEqual(audits, ['allowed-once', 'allowed-once', 'allowed-once', 'rejected', 'allowed-once', 'rejected', 'allowed-once', 'rejected'])
    } finally { replay.driver.dispose() }
  })
}

test('ZCode 同一恢复会话逐轮覆盖权限并使用目录默认思考档位', async () => {
  const replay = createReplay()
  try {
    for (const permission of [
      { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
      { sandboxMode: 'read-only', approvalPolicy: 'ask' },
      { nativeApprovalMode: 'auto-review' },
      { nativeApprovalMode: 'manual' },
      { nativeApprovalMode: 'accept-edits' },
      undefined,
    ] as const) {
      for await (const _event of replay.driver.executeTurn({ sessionId: 'same-session', messages: [], prompt: '测试', providerSessionId: 'sess-probe',
        modelId: 'deepseek/deepseek-flash', permission })) { /* 验证真实下发字段。 */ }
    }
    assert.equal(replay.calls.filter((call) => call.method === 'session/resume').length, 1)
    assert.deepEqual(replay.calls.filter((call) => call.method === 'session/setMode').map((call) => call.params.mode), ['yolo', 'plan', 'guarded', 'build', 'edit', 'build'])
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

test('ZCode 新建和恢复会话开启真正的动态 workflow，不能退化成 TodoWrite 清单', async () => {
  for (const providerSessionId of [undefined, 'sess-probe']) {
    const replay = createReplay()
    try {
      for await (const _event of replay.driver.executeTurn({ sessionId: 'workflow-probe', cwd: 'D:/fixture', messages: [], prompt: '使用 workflow 测试串并行', ...(providerSessionId ? { providerSessionId } : {}) })) {}
      const policy = replay.calls.find(call => call.method === 'workspace/updateDynamicWorkflowPolicy')
      assert.equal(policy?.params.enabled, true, 'app-server defaults dynamicWorkflowEnabled=false')
      assert.equal(policy?.params.mode, 'alwaysOn')
      const created = replay.calls.find(call => call.method === (providerSessionId ? 'session/resume' : 'session/create'))
      assert.equal(created.params.dynamicWorkflowEnabled, true)
      assert.equal(created.params.dynamicWorkflowMode, 'alwaysOn')
      assert.match(replay.calls.find(call => call.method === 'session/send').params.content, /CreateWorkflow/u)
      assert.match(replay.calls.find(call => call.method === 'session/send').params.content, /TodoWrite/u)
    } finally { replay.driver.dispose() }
  }
})

test('旧版 ZCode 缺少工作流策略 API 时保留普通对话，不传未知字段或宣称已启用', async () => {
  const replay = createReplay(undefined, undefined, false, false)
  try {
    const events = []
    for await (const event of replay.driver.executeTurn({ sessionId: 'legacy', messages: [], prompt: '普通问题' })) events.push(event)
    assert.equal(events.at(-1)?.type, 'finish')
    const created = replay.calls.find(call => call.method === 'session/create')
    assert.equal(created.params.dynamicWorkflowEnabled, undefined)
    assert.doesNotMatch(replay.calls.find(call => call.method === 'session/send').params.content, /已启用 ZCode 原生动态工作流/u)
  } finally { replay.driver.dispose() }
})
