import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { JsonRpcRequestError } from '../data/build/dist/host/cli-adapters/json-rpc-process.js'
import type { CodingNsAgentEvent } from '../src/shared/contracts/cli-adapter.js'

interface RpcRequest {
  readonly id?: number
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: unknown
}

/** 轮询内存桩的请求记录；驱动的 RPC 写入是异步的，不能只等一个微任务。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise(resolve => setImmediate(resolve))
}

/** 用内存中的 app-server 校验真实驱动请求，不启动进程或调用模型。 */
async function createSteerHarness(segmented: boolean, steerTerminalGraceMs = 20) {
  const sessionId = `codex-steer-${segmented}`
  const threadId = 'steer-thread'
  const turnId = 'steer-turn'
  const calls: RpcRequest[] = []
  const state = { serverTurnId: turnId as string | null, steerTurnId: null as string | null, deferSteer: false, completeOnSteer: false, rejectSteer: false }
  let turnStarts = 0
  const controller = new AbortController()
  let completeTurn!: (completedTurnId?: string) => void
  let emit!: (message: unknown) => void
  let resolveSteer!: () => void
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
    steerTerminalGraceMs,
    spawnSync: (() => ({ status: 0, stdout: 'codex 0.160.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const send = (message: unknown): void => { stdout.write(`${JSON.stringify(message)}\n`) }
      emit = send
      completeTurn = (completedTurnId = state.serverTurnId ?? turnId) => {
        if (state.serverTurnId === completedTurnId) state.serverTurnId = null
        send({ jsonrpc: '2.0', method: 'turn/completed', params: {
          threadId, turn: { id: completedTurnId, status: 'completed' },
        } })
      }
      const write = (data: string): void => {
        const request = JSON.parse(data) as RpcRequest
        calls.push(request)
        if (request.method === 'initialized') return
        if (request.method === 'turn/steer') {
          if (state.completeOnSteer) completeTurn()
          // rejectSteer 模拟拒绝响应先于终态通知到达：服务端已结束回合，通知尚在路上。
          // 错误码与文本取自真实 codex app-server 0.162.0-alpha.17.2 的响应。
          if (state.serverTurnId === null || state.rejectSteer) {
            send({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'no active turn to steer' } })
            return
          }
          // 缺字段和回合失配分别返回协议错误，不能用宽松桩掩盖适配参数错误。
          if (typeof request.params?.expectedTurnId !== 'string') {
            send({ jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'missing field expectedTurnId' } })
            return
          }
          if (request.params.expectedTurnId !== state.serverTurnId) {
            send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'active turn mismatch' } })
            return
          }
          resolveSteer = () => {
            const nextTurnId = state.steerTurnId ?? state.serverTurnId ?? turnId
            state.serverTurnId = nextTurnId
            send({ jsonrpc: '2.0', id: request.id, result: { turnId: nextTurnId } })
          }
          if (!state.deferSteer) resolveSteer()
          return
        }
        if (request.method === 'turn/start') state.serverTurnId = ++turnStarts === 1 ? turnId : `${turnId}-${turnStarts}`
        const result = request.method === 'thread/start' ? { thread: { id: threadId } }
          : request.method === 'turn/start' ? { turn: { id: state.serverTurnId, status: 'inProgress' } } : {}
        send({ jsonrpc: '2.0', id: request.id, result })
        if (request.method === 'turn/start') {
          send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
            threadId, turnId: state.serverTurnId, itemId: 'steer-message', delta: '开始工作',
          } })
        }
      }
      return { stdout, stderr, stdin: { write }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const iterator = driver.executeTurn({
    sessionId, messages: [], prompt: '执行任务', splitToolSteps: segmented, signal: controller.signal,
  })[Symbol.asyncIterator]()
  // 等到正文真正产出，确保 turn/start 已解析，而不只停在 session-binding。
  while (true) {
    const next = await iterator.next()
    assert.equal(next.done, false)
    if (next.value?.type === 'text-delta') break
  }
  const drain = async () => {
    const events = []
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value)
    return events
  }
  return {
    driver, sessionId, threadId, turnId, calls, state,
    resolveSteer: () => resolveSteer(),
    sendTurnText(turnId: string, text: string, itemId = 'steer-message') {
      emit({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
        threadId, turnId, itemId, delta: text,
      } })
    },
    sendNotification(method: string, params: Record<string, unknown>) {
      emit({ jsonrpc: '2.0', method, params })
    },
    /** 模拟 Codex 反向请求（问题、审批）；驱动的回复以同一 id 写回 stdin。 */
    sendServerRequest(id: number, method: string, params: Record<string, unknown>) {
      emit({ jsonrpc: '2.0', id, method, params })
    },
    next() {
      return iterator.next()
    },
    completeTurn(turnId?: string) {
      completeTurn(turnId)
    },
    drain,
    async finish() {
      completeTurn(turnId)
      const events = await drain()
      assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
    },
    async dispose() {
      controller.abort()
      driver.dispose()
      await iterator.return?.()
    },
  }
}

for (const segmented of [false, true]) {
  const mode = segmented ? '分段' : '普通'
  test(`Codex ${mode}回合插话携带 expectedTurnId，连续插话复用当前回合且中断协议不变`, { timeout: 5_000 }, async () => {
    const harness = await createSteerHarness(segmented)
    try {
      const { driver, sessionId, threadId, turnId, calls } = harness
      for (const prompt of ['先修复插话', '同时保留中断功能']) {
        await driver.steer(sessionId, prompt)
        assert.deepEqual(calls.at(-1)?.params, {
          threadId, expectedTurnId: turnId, input: [{ type: 'text', text: prompt }],
        })
      }
      assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1)
      await driver.interrupt(sessionId)
      assert.deepEqual(calls.at(-1)?.params, { threadId, turnId })
      await harness.finish()
    } finally { await harness.dispose() }
  })

  test(`Codex ${mode}回合插话切换 turnId 后忽略旧终态并继续投影新回合正文`, { timeout: 5_000 }, async () => {
    const harness = await createSteerHarness(segmented)
    try {
      harness.state.steerTurnId = 'steered-turn'
      await harness.driver.steer(harness.sessionId, '改为新的实现方向')
      // Codex 可能先把旧回合的完成通知推过来；它不能关闭已经切换到新 turnId 的队列。
      harness.completeTurn(harness.turnId)
      harness.sendTurnText('steered-turn', '插话后的新回合正文')
      harness.completeTurn('steered-turn')
      const events = await harness.drain()
      assert.equal(events.some((event) => event.type === 'text-delta' && event.text.includes('插话后的新回合正文')), true)
      assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
    } finally { await harness.dispose() }
  })

  test(`Codex ${mode}回合插话透传回合失配错误，不重试或覆盖本地回合`, { timeout: 5_000 }, async () => {
    const harness = await createSteerHarness(segmented)
    try {
      harness.state.serverTurnId = 'another-turn'
      await assert.rejects(harness.driver.steer(harness.sessionId, '迟到的插话'), (error: unknown) => {
        assert.ok(error instanceof JsonRpcRequestError)
        assert.equal(error.code, -32000)
        assert.equal(error.message, 'active turn mismatch')
        return true
      })
      assert.equal(harness.calls.filter((call) => call.method === 'turn/steer').length, 1)
      harness.state.serverTurnId = harness.turnId
      await harness.driver.steer(harness.sessionId, '继续当前回合')
      await harness.finish()
    } finally { await harness.dispose() }
  })

  test(`Codex ${mode}回合结束后拒绝插话，不再发送 RPC`, { timeout: 5_000 }, async () => {
    const harness = await createSteerHarness(segmented)
    try {
      await harness.finish()
      const count = harness.calls.length
      await assert.rejects(harness.driver.steer(harness.sessionId, '已结束的回合'), /Codex 会话未运行/u)
      assert.equal(harness.calls.length, count)
    } finally { await harness.dispose() }
  })

  test(`Codex ${mode}回合结束后迟到的插话响应不能恢复旧回合`, { timeout: 5_000 }, async () => {
    const harness = await createSteerHarness(segmented)
    try {
      harness.state.deferSteer = true
      const pending = harness.driver.steer(harness.sessionId, '结束前插话')
      await harness.finish()
      harness.resolveSteer()
      await pending
      const count = harness.calls.length
      await assert.rejects(harness.driver.steer(harness.sessionId, '结束后插话'), /Codex 会话未运行/u)
      await harness.driver.interrupt(harness.sessionId)
      assert.equal(harness.calls.length, count)
    } finally { await harness.dispose() }
  })
}

test('Codex 分段续流收到真实用户插话时调用 turn/steer 并保留插话后的正文', { timeout: 5_000 }, async () => {
  const harness = await createSteerHarness(true)
  let resumedIterator: AsyncIterator<CodingNsAgentEvent> | undefined
  try {
    harness.sendNotification('item/completed', {
      threadId: harness.threadId,
      turnId: harness.turnId,
      item: { id: 'command-1', type: 'commandExecution', status: 'completed', command: 'pwd', aggregated_output: '/workspace' },
    })
    harness.sendTurnText(harness.turnId, '工具后的下一条助手消息', 'next-message')
    assert.equal((await harness.next()).value?.type, 'tool-event')
    assert.equal((await harness.next()).value?.type, 'step-boundary')

    harness.state.steerTurnId = 'steered-turn'
    const second = harness.driver.executeTurn({
      sessionId: harness.sessionId,
      messages: [{ role: 'user', source: { kind: 'user' }, content: '改成新的实现方向' }],
      prompt: '改成新的实现方向',
      splitToolSteps: true,
      resumeSegmentedTurn: true,
    })
    resumedIterator = second[Symbol.asyncIterator]()

    const resumedText = await resumedIterator.next()
    assert.equal(resumedText.done, false)
    assert.equal(resumedText.value?.type, 'text-delta')
    assert.equal(harness.calls.filter((call) => call.method === 'turn/steer').length, 1)
    assert.deepEqual(harness.calls.at(-1)?.params, {
      threadId: harness.threadId,
      expectedTurnId: harness.turnId,
      input: [{ type: 'text', text: '改成新的实现方向' }],
    })

    harness.sendTurnText('steered-turn', '插话后的新方向正文')
    harness.completeTurn('steered-turn')
    const events = []
    for (let next = await resumedIterator.next(); !next.done; next = await resumedIterator.next()) events.push(next.value)
    assert.equal(events.some((event) => event.type === 'text-delta' && event.text.includes('插话后的新方向正文')), true)
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
  } finally {
    await resumedIterator?.return?.()
    await harness.dispose()
  }
})

type SteerHarness = Awaited<ReturnType<typeof createSteerHarness>>

/** 让分段回合在工具完成后挂起，并在队列里留下一段尚未交给 DSH 的旧正文。 */
async function suspendAfterTool(harness: SteerHarness, bufferedText: string): Promise<void> {
  harness.sendNotification('item/completed', {
    threadId: harness.threadId, turnId: harness.turnId,
    item: { id: 'command-1', type: 'commandExecution', status: 'completed', command: 'pwd', aggregated_output: '/workspace' },
  })
  harness.sendTurnText(harness.turnId, bufferedText, 'next-message')
  assert.equal((await harness.next()).value?.type, 'tool-event')
  assert.equal((await harness.next()).value?.type, 'step-boundary')
}

/** 以 DSH 续段方式提交一条真实用户插话。 */
function resumeWithInterjection(harness: SteerHarness, prompt: string): AsyncIterator<CodingNsAgentEvent> {
  return harness.driver.executeTurn({
    sessionId: harness.sessionId,
    messages: [{ role: 'user', source: { kind: 'user' }, content: prompt }],
    prompt, splitToolSteps: true, resumeSegmentedTurn: true,
  })[Symbol.asyncIterator]()
}

async function collect(iterator: AsyncIterator<CodingNsAgentEvent>, events: CodingNsAgentEvent[] = []): Promise<CodingNsAgentEvent[]> {
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value)
  return events
}

const COMPLETION_TIMING = { 'before-resume': '续段前', 'during-steer': '插话请求期间' } as const
for (const completion of ['before-resume', 'during-steer'] as const) {
  test(`Codex 分段回合在${COMPLETION_TIMING[completion]}结束时，用新回合执行插话并保留旧输出`, { timeout: 5_000 }, async () => {
    const harness = await createSteerHarness(true)
    let resumed: AsyncIterator<CodingNsAgentEvent> | undefined
    try {
      await suspendAfterTool(harness, 'buffered old output')
      if (completion === 'before-resume') harness.completeTurn()
      else harness.state.completeOnSteer = true
      const prompt = '只让 .gitignore 忽略 agents.md'
      resumed = resumeWithInterjection(harness, prompt)
      const events: CodingNsAgentEvent[] = []
      while (true) {
        const next = await resumed.next()
        assert.equal(next.done, false)
        events.push(next.value!)
        if (next.value?.type === 'text-delta' && next.value.text === '开始工作') break
      }
      const starts = harness.calls.filter(call => call.method === 'turn/start')
      assert.equal(starts.length, 2)
      assert.deepEqual(starts[1]?.params?.input, [{ type: 'text', text: prompt }])
      assert.equal(harness.calls.filter(call => call.method === 'turn/steer').length, completion === 'before-resume' ? 0 : 1)
      assert.equal(events.some(event => event.type === 'text-delta' && event.text === 'buffered old output'), true)
      assert.equal(events.some(event => event.type === 'finish' || event.type === 'step-boundary'), false)
      harness.completeTurn()
      await collect(resumed, events)
      assert.deepEqual(events.filter(event => event.type === 'finish'), [{ type: 'finish', reason: 'stop' }])
    } finally {
      await resumed?.return?.()
      await harness.dispose()
    }
  })
}

test('Codex 插话被拒绝但终态通知始终未到时，超时后仍用新回合执行插话', { timeout: 5_000 }, async () => {
  const harness = await createSteerHarness(true)
  let resumed: AsyncIterator<CodingNsAgentEvent> | undefined
  try {
    await suspendAfterTool(harness, '旧回合剩余正文')
    harness.state.rejectSteer = true
    resumed = resumeWithInterjection(harness, '改用新方案')
    const events: CodingNsAgentEvent[] = []
    while (true) {
      const next = await resumed.next()
      assert.equal(next.done, false)
      events.push(next.value!)
      if (next.value?.type === 'text-delta' && next.value.text === '开始工作') break
    }
    assert.equal(harness.calls.filter(call => call.method === 'turn/steer').length, 1)
    const starts = harness.calls.filter(call => call.method === 'turn/start')
    assert.equal(starts.length, 2)
    assert.deepEqual(starts[1]?.params?.input, [{ type: 'text', text: '改用新方案' }])
    assert.equal(events.some(event => event.type === 'text-delta' && event.text === '旧回合剩余正文'), true)
    harness.completeTurn()
    await collect(resumed, events)
    assert.deepEqual(events.filter(event => event.type === 'finish'), [{ type: 'finish', reason: 'stop' }])
  } finally {
    await resumed?.return?.()
    await harness.dispose()
  }
})

test('Codex 插话被拒绝后迟到的 interrupted 终态不会被当成正常结束', { timeout: 5_000 }, async () => {
  // 宽限期远大于测试时长：迟到的终态必须在超时兜底之前被读取，而不是被关闭的队列丢弃。
  const harness = await createSteerHarness(true, 60_000)
  let resumed: AsyncIterator<CodingNsAgentEvent> | undefined
  try {
    await suspendAfterTool(harness, '旧回合剩余正文')
    harness.state.rejectSteer = true
    resumed = resumeWithInterjection(harness, '改用新方案')
    const pending = collect(resumed)
    await waitFor(() => harness.calls.some(call => call.method === 'turn/steer'))
    harness.sendNotification('turn/completed', {
      threadId: harness.threadId, turn: { id: harness.turnId, status: 'interrupted' },
    })
    const events = await pending
    assert.equal(harness.calls.filter(call => call.method === 'turn/start').length, 1)
    assert.equal(events.some(event => event.type === 'text-delta' && event.text === '旧回合剩余正文'), true)
    assert.deepEqual(events.filter(event => event.type === 'finish'), [{ type: 'finish', reason: 'cancel' }])
  } finally {
    await resumed?.return?.()
    await harness.dispose()
  }
})

test('Codex 已结束回合遗留的问题与审批会被回绝，不阻塞插话的新回合', { timeout: 5_000 }, async () => {
  const harness = await createSteerHarness(true)
  let resumed: AsyncIterator<CodingNsAgentEvent> | undefined
  try {
    await suspendAfterTool(harness, '旧回合剩余正文')
    harness.sendServerRequest(901, 'item/commandExecution/requestApproval', {
      threadId: harness.threadId, turnId: harness.turnId, itemId: 'stale-command', command: 'rm -rf build',
    })
    harness.sendServerRequest(902, 'item/tool/requestUserInput', {
      threadId: harness.threadId, turnId: harness.turnId, itemId: 'stale-question',
      questions: [{ id: 'choice', question: '继续吗？', options: [{ label: '是' }, { label: '否' }] }],
    })
    harness.completeTurn()
    resumed = resumeWithInterjection(harness, '改用新方案')
    const events: CodingNsAgentEvent[] = []
    while (true) {
      const next = await resumed.next()
      assert.equal(next.done, false)
      events.push(next.value!)
      if (next.value?.type === 'text-delta' && next.value.text === '开始工作') break
    }
    assert.equal(events.some(event => event.type === 'question-request' || event.type === 'permission-request'), false)
    await waitFor(() => harness.calls.some(call => call.id === 902 && call.method === undefined))
    assert.deepEqual(harness.calls.find(call => call.id === 901 && call.method === undefined)?.result, { decision: 'decline' })
    assert.deepEqual(harness.calls.find(call => call.id === 902 && call.method === undefined)?.result, { answers: {} })
    assert.equal(harness.calls.filter(call => call.method === 'turn/start').length, 2)
    harness.completeTurn()
    await collect(resumed, events)
    assert.deepEqual(events.filter(event => event.type === 'finish'), [{ type: 'finish', reason: 'stop' }])
  } finally {
    await resumed?.return?.()
    await harness.dispose()
  }
})

test('Codex 未启动的会话拒绝插话', async () => {
  const driver = new CodexAppServerDriver()
  try { await assert.rejects(driver.steer('missing-session', '插话'), /Codex 会话未运行/u) }
  finally { driver.dispose() }
})

test('Codex 已接受的插话随终态一起返回时不会被重复提交', { timeout: 5_000 }, async () => {
  const harness = await createSteerHarness(true)
  let resumed: AsyncIterator<CodingNsAgentEvent> | undefined
  try {
    await suspendAfterTool(harness, 'buffered output')
    harness.state.deferSteer = true
    resumed = resumeWithInterjection(harness, 'follow up')
    const pending = resumed.next()
    await waitFor(() => harness.calls.some(call => call.method === 'turn/steer'))
    harness.resolveSteer()
    harness.completeTurn()
    const first = await pending
    assert.equal(first.done, false)
    const events = await collect(resumed, [first.value!])
    assert.equal(harness.calls.filter(call => call.method === 'turn/start').length, 1)
    assert.equal(harness.calls.filter(call => call.method === 'turn/steer').length, 1)
    assert.deepEqual(events.filter(event => event?.type === 'finish'), [{ type: 'finish', reason: 'stop' }])
  } finally { await resumed?.return?.(); await harness.dispose() }
})

for (const status of ['failed', 'interrupted']) {
  test(`Codex 挂起回合已 ${status} 时不会为插话重新开启回合`, { timeout: 5_000 }, async () => {
    const harness = await createSteerHarness(true)
    try {
      harness.sendNotification('turn/completed', {
        threadId: harness.threadId, turn: { id: harness.turnId, status },
      })
      const events = []
      for await (const event of harness.driver.executeTurn({
        sessionId: harness.sessionId, messages: [{ role: 'user', content: 'follow up' }],
        prompt: 'follow up', splitToolSteps: true, resumeSegmentedTurn: true,
      })) events.push(event)
      assert.equal(harness.calls.filter(call => call.method === 'turn/start').length, 1)
      assert.equal(harness.calls.some(call => call.method === 'turn/steer'), false)
      assert.equal(events.at(-1)?.type, 'finish')
      assert.equal(events.at(-1)?.reason, status === 'failed' ? 'error' : 'cancel')
    } finally { await harness.dispose() }
  })
}
