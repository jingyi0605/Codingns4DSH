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
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '检查' },
    { type: 'reasoning-delta', index: 0, text: '目录' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '开始' },
    { type: 'text-delta', index: 1, text: '完成' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '检查目录' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: '开始完成' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(calls, [{
    sessionId: 'session-1',
    call: { callId: 'read-1', name: 'read_directory', arguments: '{"path":"."}', adapterId: 'fake' },
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
    context: { provider: 'codex', model: 'gpt-5.3-codex', contextWindow: 258400, confirmed: true },
  }])
})

test('Codex 压缩活动通过公共投影器写入原生消息组件而不进入文本流', async () => {
  const events = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'codex',
    modelId: 'gpt-5.3-codex',
    sessionId: 'session-compaction',
    nativeSessions: {
      appendCompactionEvent(sessionId, event) {
        events.push({ sessionId, event })
        return true
      },
    },
  })

  assert.deepEqual(await projector.push({ type: 'context-compaction', phase: 'start', compactionId: 'compact-1' }), [])
  assert.deepEqual(await projector.push({ type: 'context-compaction', phase: 'summary', compactionId: 'compact-1', summary: '保留任务目标和已完成修改。' }), [])
  assert.deepEqual(await projector.push({ type: 'context-compaction', phase: 'end', compactionId: 'compact-1' }), [])
  assert.deepEqual(events, [
    { sessionId: 'session-compaction', event: { type: 'context-compaction', phase: 'start', compactionId: 'compact-1', provider: 'codex', model: 'gpt-5.3-codex' } },
    { sessionId: 'session-compaction', event: { type: 'context-compaction', phase: 'summary', compactionId: 'compact-1', summary: '保留任务目标和已完成修改。', provider: 'codex', model: 'gpt-5.3-codex' } },
    { sessionId: 'session-compaction', event: { type: 'context-compaction', phase: 'end', compactionId: 'compact-1', provider: 'codex', model: 'gpt-5.3-codex' } },
  ])
})

test('Provider 把缓存折叠进 inputTokens 时 DSH usage 只保留未缓存输入', async () => {
  const samples = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'codex',
    modelId: 'gpt-5.3-codex',
    sessionId: 'session-usage-buckets',
    nativeSessions: {
      appendUsageSample(sessionId, usage) { samples.push({ sessionId, usage }); return true },
    },
  })

  // Codex app-server / Command Code 的口径：inputTokens 已包含缓存读取。
  assert.deepEqual(await projector.push({
    type: 'usage',
    inputTokens: 182936,
    outputTokens: 126,
    cacheReadTokens: 182016,
    cacheWriteTokens: 0,
    uncachedInputTokens: 920,
    totalTokens: 183062,
    cacheHitRate: 99.4971,
    contextWindow: 258400,
    contextTokens: 182936,
    contextUsageRatio: 0.707957,
  }), [])
  const finish = await projector.push({ type: 'finish', reason: 'stop' })

  // DSH TokenUsage 只接受 inputTokens/outputTokens/缓存桶/totalTokens，且 inputTokens 只含未缓存输入。
  assert.deepEqual(finish, [
    {
      type: 'usage',
      usage: {
        inputTokens: 920,
        outputTokens: 126,
        cacheReadTokens: 182016,
        cacheWriteTokens: 0,
        totalTokens: 183062,
      },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  // DSH token-meter 的计费输入 = 未缓存 + 缓存读写，必须等于 Provider 的完整输入。
  const billedInput = 920 + 182016 + 0
  assert.equal(billedInput, 182936)
  assert.equal(Number((182016 / billedInput * 100).toFixed(4)), 99.4971)

  // 非 surface 采样写入 DSH 会话记录，同样使用互斥桶口径。
  assert.deepEqual(samples, [{
    sessionId: 'session-usage-buckets',
    usage: {
      inputTokens: 920,
      outputTokens: 126,
      cacheReadTokens: 182016,
      cacheWriteTokens: 0,
      totalTokens: 183062,
      cacheHitRate: 99.4971,
      contextWindow: 258400,
      contextTokens: 182936,
      contextUsageRatio: 0.707957,
    },
  }])
})

test('Provider usage 到达时先写入非 surface 采样，ContextMeter 不等待 finish', async () => {
  const samples = []
  const contexts = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'opencode',
    modelId: 'deepseek/deepseek-flash',
    sessionId: 'session-usage-sample',
    nativeSessions: {
      appendUsageSample(sessionId, usage) { samples.push({ sessionId, usage }); return true },
      appendRequestContext(sessionId, context) { contexts.push({ sessionId, context }); return true },
    },
  })

  assert.deepEqual(await projector.push({
    type: 'usage',
    inputTokens: 120,
    outputTokens: 8,
    cacheReadTokens: 9000,
    contextWindow: 1000000,
    contextTokens: 9120,
  }), [])
  assert.deepEqual(samples, [{
    sessionId: 'session-usage-sample',
    usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 9000, contextWindow: 1000000, contextTokens: 9120 },
  }])
  assert.deepEqual(contexts, [{
    sessionId: 'session-usage-sample',
    context: { provider: 'opencode', model: 'deepseek/deepseek-flash', contextWindow: 1000000, confirmed: true },
  }])

  const finish = await projector.push({ type: 'finish', reason: 'stop' })
  assert.deepEqual(finish.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('Qoder token 桶为空时用真实 contextTokens 建立 ContextMeter 占用', async () => {
  const samples = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'qoder-cn',
    modelId: 'qwen3.8-flash',
    sessionId: 'session-qoder-context',
    nativeSessions: {
      appendUsageSample(sessionId, usage) { samples.push({ sessionId, usage }); return true },
    },
  })

  assert.deepEqual(await projector.push({
    type: 'usage',
    inputTokens: 0,
    outputTokens: 0,
    contextWindow: 200000,
    contextTokens: 23508,
    contextUsageRatio: 0.11754,
  }), [])
  assert.deepEqual(samples, [{
    sessionId: 'session-qoder-context',
    usage: {
      inputTokens: 23508,
      outputTokens: 0,
      contextWindow: 200000,
      contextTokens: 23508,
      contextUsageRatio: 0.11754,
    },
  }])

  // 正式 assistant usage 仍保持 Qoder 上游返回的 0，不把上下文占用伪装成计费 token。
  assert.deepEqual(await projector.push({ type: 'finish', reason: 'stop' }), [
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
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

test('Codex assistant item 切换时封口旧正文并分配新的 DSH block', async () => {
  const projector = new CodingNsDshMessageProjector({ adapterId: 'codex', sessionId: 'session-boundary' })
  const chunks = []
  chunks.push(...await projector.push({ type: 'text-delta', text: '工具前', messageId: 'message-1' }))
  chunks.push(...await projector.push({ type: 'text-delta', text: '工具后', messageId: 'message-2' }))

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '工具前' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '工具前' } },
    { type: 'block-start', index: 2, blockType: 'text' },
    { type: 'text-delta', index: 2, text: '工具后' },
  ])
})

test('工具 step 边界不伪造空白 assistant 文本', async () => {
  const projector = new CodingNsDshMessageProjector({ adapterId: 'codex', sessionId: 'step-boundary' })
  assert.deepEqual(await projector.push({ type: 'step-boundary' }), [])
})

test('消息 block 切换后执行失败仍写入当前正文 block', async () => {
  const projector = new CodingNsDshMessageProjector({ adapterId: 'codex', sessionId: 'session-failure-boundary' })
  await projector.push({ type: 'text-delta', text: '工具前', messageId: 'message-1' })
  await projector.push({ type: 'text-delta', text: '工具后', messageId: 'message-2' })
  const chunks = await projector.fail('执行失败')
  assert.equal(chunks[0]?.type, 'text-delta')
  assert.equal(chunks[0]?.index, 2)
  assert.equal(chunks.at(-2)?.type, 'block-end')
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('Provider 没有任何有效事件时 complete 不得伪装成 stop', async () => {
  const projector = new CodingNsDshMessageProjector({ adapterId: 'codex', sessionId: 'session-empty' })
  const chunks = await projector.complete()
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && String(chunk.text).includes('CODINGNS_PROVIDER_EMPTY_RESPONSE')), true)
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: 'CODINGNS_PROVIDER_EMPTY_RESPONSE: Provider 未返回任何有效事件。',
        code: 'PROVIDER_ERROR',
      },
    },
  })
})

test('Provider 终态携带真实失败详情时投影到 DSH finish', async () => {
  const projector = new CodingNsDshMessageProjector({ adapterId: 'codex', sessionId: 'session-real-failure' })
  const chunks = await projector.push({
    type: 'finish',
    reason: 'error',
    failure: { message: '上游返回 401：API key 无效', code: 'AUTH_FAILED' },
  })
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'error', failure: { message: '上游返回 401：API key 无效', code: 'AUTH_FAILED' } },
  })
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
