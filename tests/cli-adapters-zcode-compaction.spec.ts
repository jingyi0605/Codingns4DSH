import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { ZcodeAppServerDriver, ZcodeCompactionTimeoutError } from '../data/build/dist/host/cli-adapters/zcode-driver.js'

interface FakeRequest { readonly id?: number; readonly method: string; readonly params?: Record<string, any> }

function fakeAppServer(onRequest: (request: FakeRequest, reply: (result: unknown) => void, notify: (message: object) => void) => void) {
  const calls: FakeRequest[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const notify = (message: object) => stdout.write(`${JSON.stringify(message)}\n`)
  return {
    calls,
    child: {
      stdout,
      stderr,
      kill() { stdout.end(); stderr.end(); return true },
      stdin: { write(line: string) {
        const request = JSON.parse(line) as FakeRequest
        calls.push(request)
        if (request.id === undefined) return
        onRequest(request, result => notify({ id: request.id, result }), notify)
      } },
    },
  }
}

function createDriver(onRequest: (request: FakeRequest, reply: (result: unknown) => void, notify: (message: object) => void) => void, options: { compactionTimeoutMs?: number } = {}) {
  const server = fakeAppServer(onRequest)
  const driver = new ZcodeAppServerDriver({
    desktopRuntime: null,
    binaries: ['fake-zcode'],
    ...options,
    spawnSync: (() => ({ status: 0, stdout: '3.18.2', stderr: '' })) as never,
    spawn: (() => server.child) as never,
  })
  return { driver, calls: server.calls }
}

const signal = () => new AbortController().signal

test('ZCode 压缩走原生 session/compact，不再退回 DSH 摘要', async () => {
  let reads = 0
  const { driver, calls } = createDriver((request, reply) => {
    if (request.method === 'session/resume') {
      reply({ session: { sessionId: request.params?.sessionId } })
      return
    }
    if (request.method === 'session/read') {
      reads += 1
      reply({ snapshot: { projection: { contextWindow: 200_000, contextUsed: reads === 1 ? 180_000 : 20_000 } } })
      return
    }
    if (request.method === 'session/compact') {
      reply({ compact: { state: 'completed' } })
      return
    }
    reply({})
  })
  try {
    const result = await driver.compact({ sessionId: 'dsh-session', providerSessionId: 'sess-native', cwd: process.cwd(), signal: signal() })
    assert.deepEqual(result, { compacted: true })
    const compact = calls.find(call => call.method === 'session/compact')
    assert.ok(compact !== undefined, '没有调用 session/compact')
    assert.equal(compact.params?.sessionId, 'sess-native')
    assert.equal(typeof compact.params?.inputId, 'string')
    // 复用已有原生会话，不能新建会话覆盖用户历史。
    assert.equal(calls.some(call => call.method === 'session/create'), false)
  } finally {
    driver.dispose()
  }
})

test('ZCode 压缩被异步受理时等到原生完成信号再返回', async () => {
  let reads = 0
  const { driver } = createDriver((request, reply, notify) => {
    if (request.method === 'session/resume') return reply({ session: { sessionId: request.params?.sessionId } })
    if (request.method === 'session/read') {
      reads += 1
      reply({ snapshot: { projection: { contextWindow: 200_000, contextUsed: reads === 1 ? 180_000 : 15_000 } } })
      return
    }
    if (request.method === 'session/compact') {
      reply({ compact: { state: 'accepted' } })
      setTimeout(() => notify({ method: 'state.updated', params: { sessionId: 'sess-native', reason: 'session_compacted', patch: { status: 'idle' } } }), 30)
      return
    }
    reply({})
  })
  try {
    const startedAt = Date.now()
    const result = await driver.compact({ sessionId: 'dsh-session', providerSessionId: 'sess-native', cwd: process.cwd(), signal: signal() })
    assert.deepEqual(result, { compacted: true })
    assert.ok(Date.now() - startedAt >= 25, '没有等待原生压缩完成')
  } finally {
    driver.dispose()
  }
})

test('ZCode 压缩超时抛出可识别的超时错误，而不是通用失败', async () => {
  const keepAlive = setInterval(() => {}, 1000)
  const { driver } = createDriver((request, reply) => {
    if (request.method === 'session/resume') return reply({ session: { sessionId: request.params?.sessionId } })
    if (request.method === 'session/read') return reply({ snapshot: { projection: { contextWindow: 200_000, contextUsed: 180_000 } } })
    // session/compact 永不响应，模拟 Provider 卡住。
  }, { compactionTimeoutMs: 60 })
  try {
    await assert.rejects(
      driver.compact({ sessionId: 'dsh-session', providerSessionId: 'sess-native', cwd: process.cwd(), signal: signal() }),
      (error: unknown) => {
        assert.ok(error instanceof ZcodeCompactionTimeoutError)
        assert.equal((error as ZcodeCompactionTimeoutError).code, 'CODINGNS_COMPACTION_TIMEOUT')
        return true
      },
    )
  } finally {
    clearInterval(keepAlive)
    driver.dispose()
  }
})

for (const reason of ['session_compact_failed', 'session_compact_cancelled']) {
  test(`ZCode 异步压缩终态 ${reason} 不得显示成功`, async () => {
    const events: any[] = []
    const { driver } = createDriver((request, reply, notify) => {
      if (request.method === 'session/resume') return reply({ session: { sessionId: 'native' } })
      if (request.method === 'session/compact') {
        // The terminal notification may be delivered before the start acknowledgement.
        notify({ method: 'state.updated', params: { sessionId: 'native', reason, patch: { status: 'idle' } } })
        return reply({ compact: { state: 'accepted' } })
      }
      reply({})
    })
    try {
      await assert.rejects(driver.compact({ sessionId: 's', providerSessionId: 'native', onCompactionEvent: event => { events.push(event) } }), new RegExp(reason))
      assert.deepEqual(events.map(e => e.phase), ['start', 'end'])
      assert.match(events[1].error, new RegExp(reason))
    } finally { driver.dispose() }
  })
}

test('ZCode 压缩读取原生 compact_summary，完整保留正文而非通用状态说明', async () => {
  const summary = `Summary:\n${'合成验收内容，保留旧口令和任务约束。\n'.repeat(180)}`
  const events: any[] = []
  let completed = false
  const { driver, calls } = createDriver((request, reply, notify) => {
    if (request.method === 'session/resume') return reply({ session: { sessionId: 'native' } })
    if (request.method === 'session/read') return reply({ projection: { contextUsed: 180_000 }, messages: completed ? [
      { info: { messageId: 'older', semantics: { kind: 'compact_summary' }, time: { created: 1 } }, parts: [{ type: 'text', text: '旧摘要' }] },
      // Shape observed from native session/read: info.semantics + parts, not role/content.
      { info: { messageId: 'current', role: 'user', semantics: { kind: 'compact_summary' }, time: { created: Date.now() } },
        parts: [{ type: 'text', text: summary }, { type: 'compaction', auto: false }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Compacted' }] },
    ] : [] })
    if (request.method === 'session/compact') {
      completed = true
      notify({ method: 'state.updated', params: { sessionId: 'native', reason: 'session_compacted' } })
      return reply({ compact: { state: 'accepted' } })
    }
    reply({})
  })
  try {
    await driver.compact({ sessionId: 's', providerSessionId: 'native', onCompactionEvent: event => { events.push(event) } })
    assert.equal(events.find(event => event.phase === 'summary')?.summary, summary)
    assert.equal(events.find(event => event.phase === 'summary')?.shadowedTokenCount, 180_000)
    assert.ok(calls.some(call => call.method === 'session/read' && call.params?.messageLimit > 1))
    assert.deepEqual(events.map(event => event.phase), ['start', 'summary', 'end'])
  } finally { driver.dispose() }
})

for (const snapshot of [null, { snapshot: { messages: [
  { info: { semantics: { kind: 'compact_summary' }, time: { created: 1 } }, parts: [{ type: 'text', text: '过期摘要' }] },
  { info: { semantics: { kind: 'user_input' }, time: { created: Date.now() } }, parts: [{ type: 'text', text: '不是摘要' }] },
] } }]) {
  test(`ZCode 摘要${snapshot === null ? '读取失败' : '缺少本次记录'}不使用旧正文或误报压缩失败`, async () => {
    const events: any[] = []
    const { driver } = createDriver((request, reply) => {
      if (request.method === 'session/resume') return reply({ session: { sessionId: 'native' } })
      if (request.method === 'session/compact') return reply({ compact: { state: 'completed' } })
      reply(snapshot)
    })
    try {
      assert.deepEqual(await driver.compact({ sessionId: 's', providerSessionId: 'native', onCompactionEvent: event => { events.push(event) } }), { compacted: true })
      assert.equal(events.find(event => event.phase === 'summary')?.summary, undefined)
      assert.deepEqual(events.map(event => event.phase), ['start', 'summary', 'end'])
    } finally { driver.dispose() }
  })
}
