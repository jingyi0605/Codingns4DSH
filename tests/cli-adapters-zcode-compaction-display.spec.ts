import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'

/**
 * 插件侧压缩的界面呈现。
 *
 * DSH 支持回合之外的 null-turn 压缩。维护事件回调实时投影完整生命周期，
 * 下一回合不再重放；没有回调的旧调用方继续使用缓存兼容路径。
 */
function createDriver() {
  const calls: string[] = []
  let contextUsed = 500_000
  const sessionId = 'sess-compact-display'
  const driver = new ZcodeAppServerDriver({
    desktopRuntime: null,
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: '3.18.2', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const reply = (id: unknown, result: object) => stdout.write(`${JSON.stringify({ id, result })}\n`)
      const notify = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
      return {
        stdout, stderr, kill() { stdout.end(); stderr.end(); return true },
        stdin: { write(line: string) {
          const request = JSON.parse(line)
          calls.push(request.method)
          if (request.method === 'session/create') {
            reply(request.id, { session: { sessionId }, projection: { contextWindow: 1_000_000 } })
            return
          }
          if (request.method === 'session/resume') { reply(request.id, { session: { sessionId } }); return }
          if (request.method === 'session/read') {
            reply(request.id, { snapshot: { projection: { contextWindow: 1_000_000, contextUsed } } })
            return
          }
          if (request.method === 'session/compact') { contextUsed = 5_000; reply(request.id, {}); return }
          if (request.method === 'session/usage') { reply(request.id, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }); return }
          if (request.method !== 'session/send') { reply(request.id, {}); return }
          reply(request.id, {})
          notify({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })
          notify({ method: 'session/event', params: { sessionId, eventId: 'e1', type: 'session.updated',
            payload: { querySource: 'main_turn', stopReason: 'stop', contextWindow: 1_000_000,
              usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } } })
          notify({ method: 'state.updated', params: { patch: { status: 'idle', sessionId } } })
        } },
      }
    }) as never,
  })
  return { driver, calls }
}

test('回合之外完成的压缩立即投影成原生节点，下一回合不重复', { timeout: 20_000 }, async () => {
  const fixture = createDriver()
  try {
    // 先做一次原生压缩（等价于插件侧自动压缩或手动 /compact 调用的入口）。
    const compaction: any[] = []
    await fixture.driver.compact({ sessionId: 'dsh', providerSessionId: 'sess-compact-display', cwd: process.cwd(), onCompactionEvent: event => { compaction.push(event) } })
    assert.ok(fixture.calls.includes('session/compact'), `未调用原生压缩；${fixture.calls.join(',')}`)
    assert.deepEqual(compaction.map(event => event.phase), ['start', 'summary', 'end'])

    const events: any[] = []
    for await (const event of fixture.driver.executeTurn({ sessionId: 'dsh', messages: [], prompt: '继续', cwd: process.cwd() })) {
      events.push(event)
    }
    assert.equal(events.some(event => event.type === 'context-compaction'), false, '已实时投影的压缩不能在下一回合重复出现')
    const ids = new Set(compaction.map(event => event.compactionId))
    assert.equal(ids.size, 1, '三个事件必须共用 compactionId，否则 DSH 会留下未闭合的 compaction')
    assert.equal(compaction[1].shadowedTokenCount, 500_000, '检查点应带上压缩前的真实规模')
  } finally { fixture.driver.dispose() }
})

test('压缩回合不被当成后台回合：不插工作流卡片，也不把压缩标记当助手回复', { timeout: 20_000 }, async () => {
  const sessionId = 'sess-compaction-not-bg'
  const driver = new ZcodeAppServerDriver({
    desktopRuntime: null,
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: '3.18.2', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const reply = (id: unknown, result: object) => stdout.write(`${JSON.stringify({ id, result })}\n`)
      const notify = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
      return {
        stdout, stderr, kill() { stdout.end(); stderr.end(); return true },
        stdin: { write(line: string) {
          const request = JSON.parse(line)
          if (request.method === 'session/create') { reply(request.id, { session: { sessionId } }); return }
          if (request.method === 'session/resume') { reply(request.id, { session: { sessionId } }); return }
          if (request.method === 'session/read') {
            reply(request.id, { snapshot: { projection: { contextWindow: 1_000_000, contextUsed: 100_000 } } })
            return
          }
          if (request.method === 'session/compact') {
            // 压缩在 ZCode 侧是一个真实回合：先发回合启动与正文，再受理压缩。
            notify({ method: 'state.updated', params: { turnId: 'turn-compact', patch: { status: 'running' } } })
            notify({ method: 'session/event', params: { sessionId, turnId: 'turn-compact', eventId: 'c1', type: 'turn.started', payload: {} } })
            notify({ method: 'session/event', params: { sessionId, turnId: 'turn-compact', eventId: 'c2', type: 'session.updated',
              payload: { kind: 'text_delta', delta: 'Compacted', assistantMessageId: 'msg-compact' } } })
            setTimeout(() => {
              reply(request.id, {})
              notify({ method: 'state.updated', params: { turnId: 'turn-compact', patch: { status: 'idle', sessionId } } })
            }, 40)
            return
          }
          if (request.method !== 'session/send') { reply(request.id, {}); return }
          reply(request.id, {})
          notify({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })
          notify({ method: 'session/event', params: { sessionId, eventId: 'e1', type: 'session.updated',
            payload: { querySource: 'main_turn', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } } })
          notify({ method: 'state.updated', params: { patch: { status: 'idle', sessionId } } })
        } },
      }
    }) as never,
  })
  const backgroundTurns: unknown[] = []
  const unsubscribe = driver.subscribeBackgroundTurns(turn => { backgroundTurns.push(turn) })
  try {
    await driver.compact({ sessionId: 'dsh', providerSessionId: sessionId, cwd: process.cwd() })
    assert.deepEqual(backgroundTurns, [],
      '压缩回合被当成后台回合：会插一条「工作流执行结果」通知，界面上多出工作流卡片')

    // 压缩调用返回后，该回合的收尾通知也要继续挡掉，不能混进用户回合。
    const events: any[] = []
    for await (const event of driver.executeTurn({ sessionId: 'dsh', messages: [], prompt: '继续', cwd: process.cwd() })) {
      events.push(event)
    }
    const leaked = events.filter(event => event.type === 'text-delta' && String(event.text).includes('Compacted'))
    assert.deepEqual(leaked, [], `压缩标记泄漏成助手回复：${JSON.stringify(leaked)}`)
  } finally {
    unsubscribe()
    driver.dispose()
  }
})

test('压缩失败时不投影压缩节点，避免留下半截事务', { timeout: 20_000 }, async () => {
  const driver = new ZcodeAppServerDriver({
    desktopRuntime: null,
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: '3.18.2', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const reply = (id: unknown, result: object) => stdout.write(`${JSON.stringify({ id, result })}\n`)
      const notify = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
      return {
        stdout, stderr, kill() { stdout.end(); stderr.end(); return true },
        stdin: { write(line: string) {
          const request = JSON.parse(line)
          if (request.method === 'session/create') { reply(request.id, { session: { sessionId: 'sess-fail' } }); return }
          if (request.method === 'session/compact') {
            stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32000, message: 'compact failed' } })}\n`)
            return
          }
          if (request.method !== 'session/send') { reply(request.id, {}); return }
          reply(request.id, {})
          notify({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })
          notify({ method: 'session/event', params: { sessionId: 'sess-fail', eventId: 'e1', type: 'session.updated',
            payload: { querySource: 'main_turn', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } } })
          notify({ method: 'state.updated', params: { patch: { status: 'idle', sessionId: 'sess-fail' } } })
        } },
      }
    }) as never,
  })
  try {
    await assert.rejects(() => driver.compact({ sessionId: 'dsh', providerSessionId: 'sess-fail', cwd: process.cwd() }))
    const events: any[] = []
    for await (const event of driver.executeTurn({ sessionId: 'dsh', messages: [], prompt: '继续', cwd: process.cwd() })) {
      events.push(event)
    }
    assert.equal(events.some(event => event.type === 'context-compaction'), false,
      '压缩失败不能投影压缩节点，否则 start 没有配对的 end')
  } finally { driver.dispose() }
})
