import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ZcodeTurnTelemetry } from '../data/build/dist/host/cli-adapters/zcode-telemetry.js'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'

// 实机有两种带 usage 的通知；只有带 stopReason 的模型完成事件应计费。
function event(eventId: string, payload: object, type = 'session.updated', sessionId = 'sess-probe') {
  return { method: 'session/event', params: { sessionId, eventId, type, payload } }
}

test('ZCode 汇总当前回合请求并使用最后一次主请求上下文，忽略网络镜像和重放', () => {
  const telemetry = new ZcodeTurnTelemetry('sess-probe')
  const usage = { inputTokens: 1000, outputTokens: 30, cacheReadTokens: 800, cacheWriteTokens: 50, totalTokens: 1030 }
  telemetry.observe(event('network', { type: 'model_request_completed', usage }))
  const complete = event('main-1', { stopReason: 'tool_use', querySource: 'main_turn', contextWindow: 1_000_000, usage })
  telemetry.observe(complete)
  telemetry.observe(complete)
  telemetry.observe(event('other-session', { stopReason: 'stop', usage }, 'session.updated', 'sess-other'))
  telemetry.observe(event('child', { stopReason: 'stop', querySource: 'subagent', contextWindow: 200_000,
    usage: { inputTokens: 500, outputTokens: 20, cacheReadTokens: 0, totalTokens: 520 } }))
  telemetry.observe(event('main-2', { stopReason: 'stop', querySource: 'main_turn', contextWindow: 1_000_000,
    usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 1100, totalTokens: 1240 } }))
  telemetry.readContextSnapshot({ projection: { contextWindow: 200_000, contextUsed: 99_999 } })
  // 实际请求的 1M 窗口比目录/投影里的 200k 更权威；无需读取快照。
  assert.equal(telemetry.needsContextSnapshot, false)
  const result = telemetry.finish({ inputTokens: 3_000_000, outputTokens: 4000 }, undefined)
  assert.equal(result?.type, 'usage')
  if (result?.type !== 'usage') return
  assert.equal(result.inputTokens, 2700)
  assert.equal(result.outputTokens, 90)
  assert.equal(result.totalTokens, 2790)
  assert.equal(result.cacheReadTokens, 1900)
  assert.equal(result.cacheWriteTokens, 50)
  assert.equal(result.uncachedInputTokens, 750)
  assert.equal(result.contextTokens, 1240)
  assert.equal(result.contextWindow, 1_000_000)
  assert.equal(result.contextUsageRatio, 0.00124)
  assert.equal(result.cacheHitRate, 70.3704)
})

test('ZCode 旧版累计用量只取本轮增量，累计计数重置后从零计费', () => {
  const telemetry = new ZcodeTurnTelemetry('s')
  assert.deepEqual(telemetry.finish({ inputTokens: 150, outputTokens: 25 }, { inputTokens: 100, outputTokens: 20 }),
    { type: 'usage', inputTokens: 50, outputTokens: 5 })
  assert.deepEqual(telemetry.finish({ inputTokens: 30, outputTokens: 4 }, { inputTokens: 100, outputTokens: 20 }),
    { type: 'usage', inputTokens: 30, outputTokens: 4 })
  assert.equal(telemetry.finish({ inputTokens: 200, outputTokens: 5, inputBaselineBySource: { main_turn: 5000 } }, undefined), null,
    '新版 session/usage 的去重输入口径不能冒充真实请求账单')
})

test('ZCode 流式工具输入、参数校验失败和成功重试保留不同调用 ID', async () => {
  const telemetry = new ZcodeTurnTelemetry('sess-probe')
  const calls: any[] = []
  const results: any[] = []
  const projector = new CodingNsDshMessageProjector({ adapterId: 'zcode', sessionId: 'dsh', nativeSessions: {
    appendToolCall: (_session: string, call: any) => { calls.push(call); return { callId: call.callId } },
    appendToolResult: (handle: any, result: any) => { results.push({ ...handle, ...result }); return true },
  } as never })
  for (const callId of ['invalid', 'retry']) {
    const messages = [
      event(`${callId}-start`, { kind: 'tool_input_start', toolCallId: callId, toolName: 'AskUserQuestion' }, 'model.streaming'),
      event(`${callId}-delta`, { kind: 'tool_input_delta', toolCallId: callId, delta: '{"questions":[]}' }, 'model.streaming'),
      event(`${callId}-end`, { kind: 'tool_input_end', toolCallId: callId }, 'model.streaming'),
      event(`${callId}-scheduled`, { kind: 'scheduled', toolCallId: callId, toolName: 'AskUserQuestion', inputOmitted: true }, 'tool.updated'),
      event(`${callId}-result`, callId === 'invalid'
        ? { kind: 'error', toolCallId: callId, error: { type: 'InputValidationError', message: 'options.0.description: Required' } }
        : { kind: 'result', toolCallId: callId, result: { success: true, content: '用户选择了 408' } }, 'tool.updated'),
    ]
    for (const message of messages) { const chunk = telemetry.observe(message); if (chunk !== null) await projector.push(chunk) }
  }
  assert.deepEqual(calls.map((call) => [call.callId, call.name]), [['invalid', 'question'], ['retry', 'question']])
  assert.deepEqual(results.map((result) => [result.callId, result.isError]), [['invalid', true], ['retry', false]])
  assert.match(results[0].error, /description/u)
})

test('ZCode 驱动两轮用量不串账，原生上下文进入 DSH，会话不查询全局统计', async () => {
  const calls: any[] = []
  let turn = 0
  const driver = new ZcodeAppServerDriver({ binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: '3.14.4', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const notify = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
      return { stdout, stderr, kill() { stdout.end(); stderr.end(); return true }, stdin: { write(line: string) {
        const request = JSON.parse(line); calls.push(request)
        notify({ id: request.id, result: request.method === 'session/create' ? { session: { sessionId: 'sess-probe' } }
          : request.method === 'session/usage' ? { inputTokens: turn * 5000, outputTokens: turn * 10, inputBaselineBySource: { main_turn: 5000 } } : {} })
        if (request.method !== 'session/send') return
        turn++
        notify({ method: 'state.updated', params: { patch: { status: 'running' } } })
        notify(event(`complete-${turn}`, { querySource: 'main_turn', stopReason: 'stop', contextWindow: 1_000_000,
          usage: { inputTokens: 5000 + turn, outputTokens: 10, cacheReadTokens: 4500, totalTokens: 5010 + turn } }))
        notify({ method: 'state.updated', params: { patch: { status: 'idle' } } })
      } } }
    }) as never })
  const contexts: any[] = []; const samples: any[] = []
  try {
    for (let index = 1; index <= 2; index++) {
      const projector = new CodingNsDshMessageProjector({ adapterId: 'zcode', sessionId: 'dsh', modelId: 'deepseek/deepseek-flash',
        nativeSessions: { appendRequestContext: (_id: string, context: any) => contexts.push(context),
          appendUsageSample: (_id: string, sample: any) => samples.push(sample) } as never })
      for await (const chunk of driver.executeTurn({ sessionId: 'dsh', messages: [], prompt: '测试提问' })) await projector.push(chunk)
    }
    assert.equal(calls.filter((call) => call.method === 'session/create').length, 1)
    assert.equal(calls.some((call) => call.method.includes('usage/stats')), false)
    assert.match(calls.find((call) => call.method === 'session/send').params.content, /label、description/u)
    assert.deepEqual(samples.map((sample) => sample.inputTokens), [501, 502])
    assert.deepEqual(samples.map((sample) => sample.contextTokens), [5011, 5012])
    assert.ok(contexts.every((context) => context.contextWindow === 1_000_000 && context.confirmed))
  } finally { driver.dispose() }
})

test('ZCode 用量读取超时不杀死常驻 CLI，下一轮仍可执行', { timeout: 5000 }, async () => {
  let spawnCount = 0; let usageCalls = 0; let turn = 0
  // 真进程会保持事件循环；内存模拟需要一个句柄等待驱动的 unref 超时。
  const keepAlive = setInterval(() => {}, 1000)
  const driver = new ZcodeAppServerDriver({ binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: '3.14.4', stderr: '' })) as never,
    spawn: (() => {
      spawnCount++
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const notify = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
      return { stdout, stderr, kill() { stdout.end(); stderr.end(); return true }, stdin: { write(line: string) {
        const request = JSON.parse(line)
        if (request.method === 'session/usage' && ++usageCalls === 1) return
        notify({ id: request.id, result: request.method === 'session/create' ? { session: { sessionId: 'sess-probe' } } : {} })
        if (request.method !== 'session/send') return
        turn++
        notify({ method: 'state.updated', params: { patch: { status: 'running' } } })
        notify(event(`complete-${turn}`, { querySource: 'main_turn', stopReason: 'stop', contextWindow: 1_000_000,
          usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } }))
        notify({ method: 'state.updated', params: { patch: { status: 'idle' } } })
      } } }
    }) as never })
  try {
    for (let index = 0; index < 2; index++) {
      const chunks = []
      for await (const chunk of driver.executeTurn({ sessionId: 'dsh', messages: [], prompt: '测试' })) chunks.push(chunk)
      assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'stop' })
      assert.equal(chunks.find((chunk) => chunk.type === 'usage')?.totalTokens, 60)
    }
    assert.equal(spawnCount, 1)
  } finally { clearInterval(keepAlive); driver.dispose() }
})
