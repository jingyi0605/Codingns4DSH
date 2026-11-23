import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'

/**
 * 原生会话残留回合的场景：DSH 重启后内存标记为空，但 ZCode 进程里上一轮还在跑，
 * 于是 session/send 被 -32010 拒绝。驱动应停掉残留回合后原样重发，而不是让每一轮都失败。
 */
function createDriver(options: { refuseTimes: number, sessionId?: string, refuseAfterStop?: boolean }) {
  const calls: { method: string, params: any }[] = []
  const sessionId = options.sessionId ?? 'sess-orphan'
  let refused = 0
  let stopped = false
  const driver = new ZcodeAppServerDriver({
    desktopRuntime: null,
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: '3.18.2', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const reply = (id: unknown, result: object) => stdout.write(`${JSON.stringify({ id, result })}\n`)
      const fail = (id: unknown, code: number, message: string) => stdout.write(`${JSON.stringify({ id, error: { code, message } })}\n`)
      const notify = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
      return {
        stdout, stderr, kill() { stdout.end(); stderr.end(); return true },
        stdin: { write(line: string) {
          const request = JSON.parse(line)
          calls.push({ method: request.method, params: request.params })
          if (request.method === 'session/create') {
            reply(request.id, { session: { sessionId }, projection: { contextWindow: 1_000_000 } })
            return
          }
          if (request.method === 'session/stop') { stopped = true; reply(request.id, {}); return }
          if (request.method === 'session/subscribe' || request.method === 'session/setMode'
            || request.method === 'workspace/updateDynamicWorkflowPolicy') { reply(request.id, {}); return }
          if (request.method === 'session/usage') { reply(request.id, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }); return }
          if (request.method === 'session/read') {
            reply(request.id, { snapshot: { projection: { contextWindow: 1_000_000, contextUsed: 1_000 } } })
            return
          }
          if (request.method !== 'session/send') { reply(request.id, {}); return }
          // 前 N 次发送按「已有回合在跑」拒绝，模拟残留回合；停止之后放行。
          // refuseAfterStop 用于模拟「停不掉」的原生会话（停止后仍然拒绝）。
          if ((!stopped || options.refuseAfterStop === true) && refused < options.refuseTimes) {
            refused += 1
            fail(request.id, -32010, 'a turn is already running')
            return
          }
          reply(request.id, {})
          notify({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })
          notify({ method: 'session/event', params: { sessionId, eventId: 'e1', type: 'session.updated',
            payload: { querySource: 'main_turn', stopReason: 'stop',
              usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } } })
          notify({ method: 'state.updated', params: { patch: { status: 'idle', sessionId } } })
        } },
      }
    }) as never,
  })
  return { driver, calls }
}

test('ZCode 原生残留回合导致「已有回合在跑」时，驱动停掉残留并重发本轮', { timeout: 15_000 }, async () => {
  const replay = createDriver({ refuseTimes: 1 })
  try {
    const events: any[] = []
    for await (const event of replay.driver.executeTurn({ sessionId: 'dsh-orphan', messages: [], prompt: '继续', cwd: process.cwd() })) {
      events.push(event)
    }
    const methods = replay.calls.map(call => call.method)
    assert.ok(methods.includes('session/stop'), `未停掉残留回合；methods=${methods.join(',')}`)
    assert.equal(methods.filter(m => m === 'session/send').length, 2, '应重发一次本轮提示词')
    // 重发用的必须是同一条提示词，而不是插话内容。
    const sends = replay.calls.filter(call => call.method === 'session/send')
    assert.equal(sends[0].params.content, sends[1].params.content)
    const finish = events.at(-1)
    assert.equal(finish?.type, 'finish')
    assert.equal(finish?.reason, 'stop', `重发后本轮应正常结束，实际 ${JSON.stringify(finish)}`)
  } finally { replay.driver.dispose() }
})

test('ZCode 重发后仍被拒时抛回原始错误，不无限重试', { timeout: 15_000 }, async () => {
  // 停止之后原生会话仍然拒绝发送：恢复只能尝试一次，随后必须把错误交回上层。
  const replay = createDriver({ refuseTimes: 99, refuseAfterStop: true })
  try {
    const events: any[] = []
    let thrown: unknown = null
    try {
      for await (const event of replay.driver.executeTurn({ sessionId: 'dsh-orphan', messages: [], prompt: '继续', cwd: process.cwd() })) {
        events.push(event)
      }
    } catch (error) { thrown = error }
    const methods = replay.calls.map(call => call.method)
    assert.ok(methods.includes('session/stop'), '恢复路径应先尝试停止')
    assert.ok(thrown !== null, '停不掉时必须把错误抛给上层，而不是静默卡住')
    assert.match(String((thrown as Error)?.message ?? thrown), /already running|运行/u)
  } finally { replay.driver.dispose() }
})
