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
}

/** 用内存中的 app-server 校验真实驱动请求，不启动进程或调用模型。 */
async function createSteerHarness(segmented: boolean) {
  const sessionId = `codex-steer-${segmented}`
  const threadId = 'steer-thread'
  const turnId = 'steer-turn'
  const calls: RpcRequest[] = []
  const state = { serverTurnId: turnId as string | null, steerTurnId: null as string | null, deferSteer: false }
  const controller = new AbortController()
  let completeTurn!: (completedTurnId?: string) => void
  let emit!: (message: unknown) => void
  let resolveSteer!: () => void
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'],
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
        const result = request.method === 'thread/start' ? { thread: { id: threadId } }
          : request.method === 'turn/start' ? { turn: { id: turnId, status: 'inProgress' } } : {}
        send({ jsonrpc: '2.0', id: request.id, result })
        if (request.method === 'turn/start') {
          send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: {
            threadId, turnId, itemId: 'steer-message', delta: '开始工作',
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

test('Codex 未启动的会话拒绝插话', async () => {
  const driver = new CodexAppServerDriver()
  try { await assert.rejects(driver.steer('missing-session', '插话'), /Codex 会话未运行/u) }
  finally { driver.dispose() }
})
