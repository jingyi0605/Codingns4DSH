import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'

test('公共消息投影层统一处理正文、思考、工具、用量和唯一终态', async () => {
  const calls = []
  const results = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'fake',
    sessionId: 'session-1',
    nativeSessions: {
      appendToolCall(sessionId, call) {
        calls.push({ sessionId, call })
        return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: 3 }
      },
      appendToolResult(handle, result) {
        results.push({ handle, result })
        return true
      },
    },
  })
  const chunks = []
  const events = [
    { type: 'reasoning-snapshot', text: '检查' },
    { type: 'reasoning-snapshot', text: '检查目录' },
    { type: 'text-snapshot', text: '开始' },
    { type: 'tool-event', toolName: 'read_directory', callId: 'read-1', input: '{"path":"."}', status: 'running' },
    { type: 'tool-event', toolName: 'read_directory', callId: 'read-1', output: 'a.ts', outputMode: 'snapshot', status: 'completed' },
    { type: 'text-snapshot', text: '完成' },
    { type: 'usage', inputTokens: 1, outputTokens: 2 },
    { type: 'usage', inputTokens: 3, outputTokens: 4 },
    { type: 'finish', reason: 'stop' },
  ]
  for (const event of events) chunks.push(...await projector.push(event))
  chunks.push(...await projector.push({ type: 'text-delta', text: '终态后不得输出' }))

  assert.deepEqual(chunks, [
    { type: 'reasoning-delta', index: 0, text: '检查' },
    { type: 'reasoning-delta', index: 0, text: '目录' },
    { type: 'text-delta', index: 1, text: '开始' },
    { type: 'text-delta', index: 1, text: '完成' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    call: { callId: 'read-1', name: 'read_directory', arguments: '{"path":"."}' },
  }])
  assert.deepEqual(results[0]?.result, { output: 'a.ts', isError: false })
  assert.equal(results.length, 1)
})

test('用量带上下文窗口时写入 DSH request/context 元数据', async () => {
  const contexts = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'codex',
    modelId: 'gpt-5.3-codex',
    sessionId: 'session-context',
    nativeSessions: {
      appendRequestContext(sessionId, context) {
        contexts.push({ sessionId, context })
        return true
      },
    },
  })

  await projector.push({
    type: 'usage',
    inputTokens: 32000,
    outputTokens: 120,
    cacheReadTokens: 8000,
    contextWindow: 258400,
  })
  await projector.push({ type: 'finish', reason: 'stop' })

  assert.deepEqual(contexts, [{
    sessionId: 'session-context',
    context: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 258400 },
  }])
})

test('公共消息投影层在工具终态到达时立即完成原生组件', async () => {
  const order = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'fake',
    sessionId: 'session-tool-order',
    nativeSessions: {
      appendToolCall(sessionId, call) {
        order.push(`call:${call.callId}`)
        return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: 1 }
      },
      appendToolResult(handle, result) {
        order.push(`result:${handle.callId}:${result.output}`)
        return true
      },
    },
  })

  await projector.push({
    type: 'tool-event',
    toolName: 'edit_file',
    callId: 'edit-1',
    input: '{"path":"a.ts","oldString":"a","newString":"b"}',
    status: 'started',
  })
  await projector.push({
    type: 'tool-event',
    toolName: 'edit_file',
    callId: 'edit-1',
    output: 'Done',
    outputMode: 'snapshot',
    status: 'completed',
  })
  order.push('assistant')
  await projector.push({ type: 'text-delta', text: '修改完成' })

  assert.deepEqual(order, ['call:edit-1', 'result:edit-1:Done', 'assistant'])
})

test('公共消息投影层使用 DSH 原生权限和问题组件并回传统一回答', async () => {
  const approvals = []
  const questions = []
  const permissionResponses = []
  const questionResponses = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'fake',
    sessionId: 'session-interaction',
    nativeSessions: {
      async requestApproval(sessionId, request) {
        approvals.push({ sessionId, request })
        return 'allowed-once'
      },
      async askQuestions(sessionId, request) {
        questions.push({ sessionId, request })
        return { requestId: request.requestId, answers: [{ id: 'framework', selected: ['React'] }] }
      },
    },
    respondPermission(response) { permissionResponses.push(response) },
    respondQuestion(response) { questionResponses.push(response) },
  })

  assert.deepEqual(await projector.push({
    type: 'permission-request',
    requestId: 'permission-1',
    kind: 'write',
    toolName: 'edit',
    callId: 'edit-1',
    detail: '修改文件',
  }), [])
  assert.deepEqual(await projector.push({
    type: 'question-request',
    requestId: 'question-1',
    questions: [{ id: 'framework', question: '选择框架', options: [{ label: 'React' }] }],
  }), [])

  assert.deepEqual(permissionResponses, [{ requestId: 'permission-1', approved: true }])
  assert.deepEqual(questionResponses, [{ requestId: 'question-1', answers: [{ id: 'framework', selected: ['React'] }] }])
  assert.equal(approvals[0]?.request.toolName, 'edit')
  assert.equal(approvals[0]?.request.callId, 'edit-1')
  assert.equal(questions[0]?.request.questions[0]?.question, '选择框架')
})

test('公共消息投影层在原生权限组件缺失时明确拒绝且不伪造正文', async () => {
  const responses = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'fake',
    sessionId: 'session-no-approval',
    respondPermission(response) { responses.push(response) },
  })

  assert.deepEqual(await projector.push({
    type: 'permission-request',
    requestId: 'permission-2',
    kind: 'shell',
  }), [])
  assert.deepEqual(responses, [{
    requestId: 'permission-2',
    approved: false,
    reason: 'DSH 原生权限组件不可用',
  }])
})
