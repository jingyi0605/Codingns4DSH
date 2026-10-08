import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { DoubaoAppDriver, doubaoMode, doubaoRequest } from '../data/build/dist/host/cli-adapters/doubao-driver.js'
import { DoubaoEventProjector } from '../data/build/dist/host/cli-adapters/doubao-events.js'
import { DoubaoCdp, DoubaoCdpBridge, doubaoBackgroundSocket } from '../data/build/dist/host/cli-adapters/doubao-cdp.js'
import { providerVisual } from '../data/build/dist/client/provider-icons.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'

const event = (name: string, data: unknown) => ({ event: name, data: JSON.stringify(data) })
const ack = (id = '101') => event('SSE_ACK', { ack_client_meta: { conversation_id: id } })
const block = (id: string, text: string, extra = {}) => ({ block_id: id, block_type: 10000, patch_type: 1, content: { text_block: { text } }, ...extra })
const patch = (blocks: unknown[], reply = '301') => event('STREAM_CHUNK', { message_id: reply, patch_op: [{ patch_value: { content_block: blocks } }] })
const end = () => event('SSE_REPLY_END', { end_type: 3 })
const encode = (frame: { event: string; data: string }) => new TextEncoder().encode(`event: ${frame.event}\ndata: ${frame.data}\n\n`)
const input = (extra = {}) => ({ sessionId: 'test', messages: [], prompt: '合成任务', ...extra })

/** 只模拟 App 内 HTTP 边界，Driver、SSE framing 和投影器均使用正式实现。 */
class FakeBridge {
  created = 0
  reads = 0
  closed = false
  requests: any[] = []
  stops: unknown[] = []
  controller: ReadableStreamDefaultController<Uint8Array> | undefined
  historyInfo: any
  frames: ReturnType<typeof event>[]
  readonly id: string
  readonly keepOpen: boolean
  constructor(id = '101', keepOpen = false) {
    this.id = id
    this.keepOpen = keepOpen
    this.historyInfo = { id, section: '201', index: 2, found: true, busy: false }
    this.frames = [ack(id), patch([block('b', '答复')]), end()]
  }
  async create() { this.created++; return { id: this.id, section: '201', index: 0 } }
  async history() { this.reads++; return this.historyInfo }
  async stop(id: string, reply: string) { this.stops.push({ id, reply }) }
  async cancel() { try { this.controller?.close() } catch { /* 流已结束。 */ } }
  async close() { this.closed = true; await this.cancel() }
  async download(): Promise<Response> { throw new Error('此用例不应下载文件') }
  fetch: typeof fetch = async (_url, init) => {
    this.requests.push(JSON.parse(String(init?.body)))
    return new Response(new ReadableStream<Uint8Array>({ start: (controller) => {
      this.controller = controller
      for (const frame of this.frames) controller.enqueue(encode(frame))
      if (!this.keepOpen) controller.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  }
}
function fakeApp(bridges: FakeBridge[]) {
  const launches: boolean[] = []
  return { launches, async detect() { return { installed: true, version: 'test', command: 'fake-app' } },
    async connect(launch: boolean) { launches.push(launch); const next = bridges.shift(); assert.ok(next); return next } }
}
async function collect(driver: DoubaoAppDriver, value = input()) {
  const events = []
  for await (const event of driver.executeTurn(value)) events.push(event)
  return events
}

test('豆包只允许唯一后台目标和同端口回环 WebSocket', () => {
  const target = { url: 'doubao://doubao-background/', webSocketDebuggerUrl: 'ws://127.0.0.1:9225/devtools/page/a' }
  assert.equal(doubaoBackgroundSocket([target], 9225), target.webSocketDebuggerUrl)
  for (const targets of [[], [target, target], [{ ...target, url: 'doubao://doubao-chat/chat/1' }],
    [{ ...target, webSocketDebuggerUrl: 'ws://example.com:9225/devtools/page/a' }],
    [{ ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/a' }]]) assert.throws(() => doubaoBackgroundSocket(targets, 9225))
})

test('模式参数只覆盖真实产品档位，工作模式带任务参数，特殊输入明确拒绝', () => {
  for (const [modelId, mode] of [['doubao-fast', 0], ['doubao-expert', 3], ['doubao-work', 4]] as const) {
    assert.equal(doubaoMode(input({ modelId })), mode)
    const request: any = doubaoRequest({ id: '101', section: '201', index: 2 }, '合成任务', mode)
    assert.equal(request.client_meta.conversation_id, '101')
    assert.equal(request.option.need_create_conversation, false)
    assert.equal(request.option.need_deep_think, mode)
    assert.equal(Boolean(request.option.general_task_param), mode === 4)
    assert.equal(request.client_meta.bot_id, undefined)
    assert.equal(request.ext.fp, undefined)
  }
  for (const options of [{ attachments: [{ kind: 'file', path: '/test.txt' }] }, { plan: true }, { forkSession: true },
    { skillPaths: ['/skill'] }, { effortId: 'high' }, { modelId: 'guessed-model' }, { enableAskUserQuestion: true }]) {
    assert.throws(() => doubaoMode(input(options)))
  }
})

test('豆包接受界面显式清空档位的 default，仍拒绝非默认档位与环境注入', () => {
  for (const value of [undefined, '', ' ', 'default', ' default ']) {
    assert.equal(doubaoMode(input({ modelId: 'doubao-fast', effortId: value, serviceTierId: value })), 0)
    assert.equal(doubaoMode(input({ modelId: 'doubao-expert', effortId: value, serviceTierId: value })), 3)
    assert.equal(doubaoMode(input({ modelId: 'doubao-work', effortId: value, serviceTierId: value })), 4)
  }
  assert.throws(() => doubaoMode(input({ effortId: 'high' })), /思考强度/u)
  assert.throws(() => doubaoMode(input({ serviceTierId: 'priority' })), /服务档位/u)
  assert.throws(() => doubaoMode(input({ runtimeEnv: { PRIVATE_TEST_VALUE: '不能出现在错误或请求里' } })), /环境注入/u)
})

test('新建豆包会话经 session/set 和 llm/stream 携默认档位正常发送三个产品模式', async () => {
  const bridges = ['101', '102', '103'].map((id) => new FakeBridge(id))
  const driver = new DoubaoAppDriver(fakeApp([...bridges]))
  const registry = new CodingNsCliAdapterRegistry([driver])
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<any>) | undefined
  const features = new FeatureRegistry({ rpc: table, events: {
    on(name: string, next: typeof listener) {
      if (name === 'llm/stream') listener = next
      return () => { if (name === 'llm/stream') listener = undefined }
    },
  } })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  try {
    const models = ['doubao-fast', 'doubao-expert', 'doubao-work']
    for (const [index, modelId] of models.entries()) {
      const sessionId = `doubao-ui-default-${index}`
      // 与选择器切换模型时的 payload 一致：default 必须经过 Host 保存和转发。
      const config = await table.resolve('cli/session/set')!.handler('session/set', {
        sessionId, adapterId: 'doubao', modelId, effortId: 'default', serviceTierId: 'default',
      }) as { effortId: string; serviceTierId: string }
      assert.equal(config.effortId, 'default'); assert.equal(config.serviceTierId, 'default')
      const chunks = []
      for await (const chunk of listener!({ sessionId, messages: [{ role: 'user', content: '合成界面任务' }] }, async function* () {})) chunks.push(chunk)
      assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === '答复'))
      assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
      assert.equal(bridges[index]!.requests[0].option.need_deep_think, [0, 3, 4][index])
      assert.doesNotMatch(JSON.stringify(bridges[index]!.requests[0]), /effortId|serviceTierId|runtimeEnv/u)
      assert.equal(bridges[index]!.created, 1)
    }
  } finally { await features.disable('cliAdapters') }
})

test('同一个豆包会话经 Host 完成首轮后能连续续聊，结束即释放内部流', async () => {
  const bridges = [new FakeBridge(), new FakeBridge(), new FakeBridge()]
  const registry = new CodingNsCliAdapterRegistry([new DoubaoAppDriver(fakeApp([...bridges]))])
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<any>) | undefined
  const features = new FeatureRegistry({ rpc: table, events: {
    on(name: string, next: typeof listener) {
      if (name === 'llm/stream') listener = next
      return () => { if (name === 'llm/stream') listener = undefined }
    },
  } })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  const sessionId = 'doubao-host-three-turns'
  try {
    await table.resolve('cli/session/set')!.handler('session/set', {
      sessionId, adapterId: 'doubao', modelId: 'doubao-fast', effortId: 'default',
    })
    for (const [index, bridge] of bridges.entries()) {
      const chunks = []
      for await (const chunk of listener!({ sessionId, messages: [{ role: 'user', content: `第 ${index + 1} 轮` }] }, async function* () {})) {
        chunks.push(chunk)
        // 与 DSH 的调用习惯一致：收到 finish 后不再读取 next()。
        if (chunk.type === 'finish') break
      }
      assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
      assert.equal(bridge.created, index === 0 ? 1 : 0)
      assert.equal(bridge.reads, index === 0 ? 0 : 1)
      assert.equal(bridge.requests[0].client_meta.conversation_id, '101')
      assert.equal(registry.getSession(sessionId).providerSessionId, '101')
    }
    assert.ok(bridges.every((bridge) => bridge.closed), '每轮结束时必须关闭对应后台桥')
  } finally { await features.disable('cliAdapters') }
})

test('首块、思考父子关系、增量、替换、删除及用户回显正确投影', () => {
  const p = new DoubaoEventProjector('101')
  assert.deepEqual(p.accept(ack()), [])
  assert.deepEqual(p.accept(event('FULL_MSG_NOTIFY', { content: '用户输入' })), [])
  p.accept(patch([{ block_id: 'think', block_type: 10040 }]))
  assert.deepEqual(p.accept(patch([block('reason', '推理', { parent_id: 'think' })])), [{ type: 'reasoning-delta', text: '推理' }])
  assert.deepEqual(p.accept(event('CHUNK_DELTA', { text: '过程' })), [{ type: 'reasoning-delta', text: '过程' }])
  assert.deepEqual(p.accept(event('STREAM_MSG_NOTIFY', { content: { content_block: [block('answer', '开头')] } })), [{ type: 'text-delta', text: '开头' }])
  assert.deepEqual(p.accept(patch([block('answer', '替换', { patch_type: 2 })])), [{ type: 'text-snapshot', text: '替换' }])
  assert.deepEqual(p.accept(patch([{ block_id: 'answer', patch_type: 3 }])), [{ type: 'text-snapshot', text: '' }])
  assert.equal(p.replyId, '301')
  assert.throws(() => new DoubaoEventProjector('other').accept(ack()), /ACK/u)
  assert.throws(() => new DoubaoEventProjector('101').accept(patch([block('a', '错误')])), /未确认/u)
})

test('工具事件只观察云端执行，不泄露文件签名 URL、路径和原始内容', () => {
  const p = new DoubaoEventProjector('101'); p.accept(ack())
  const tools = p.accept(patch([{ block_id: 'file', block_type: 10020, is_finish: true,
    content: { file_block: { name: 'report.txt', url: 'https://secret.invalid/?token=SECRET', uri: '/private/SECRET' } } }]))
  assert.equal(tools[0]?.type, 'tool-event')
  assert.equal((tools[0] as any).status, 'completed')
  assert.match((tools[0] as any).output, /report.txt/u)
  assert.doesNotMatch(JSON.stringify(tools), /SECRET/u)
  assert.deepEqual(p.accept(patch([{ block_id: 'file', block_type: 10020, is_finish: true }])), [])
})

test('新建和续聊绑定真实 ID，探测只读，目录不启动 App', async () => {
  const first = new FakeBridge(); const resumed = new FakeBridge(); const probe = new FakeBridge()
  const app = fakeApp([first, resumed, probe]); const d = new DoubaoAppDriver(app)
  assert.equal((await d.listModels()).fallback, true)
  assert.deepEqual(app.launches, [])
  const result = await collect(d)
  assert.deepEqual(result[0], { type: 'session-binding', providerSessionId: '101' })
  assert.deepEqual(result.at(-1), { type: 'finish', reason: 'stop' })
  assert.equal(first.created, 1); assert.equal(first.closed, true)
  const resumedResult = await collect(d, input({ providerSessionId: '101' }))
  assert.deepEqual(resumedResult.at(-1), { type: 'finish', reason: 'stop' })
  assert.equal(resumed.created, 0); assert.equal(resumed.reads, 1)
  assert.equal(resumed.requests[0].client_meta.last_message_index, 2)
  assert.equal((await d.probeSession({ providerSessionId: '101' })).state, 'available')
  assert.deepEqual(app.launches, [true, true, false]); assert.equal(probe.requests.length, 0)
  assert.equal(providerVisual('doubao').displayName, '豆包 App')
  assert.ok(!d.descriptor.capabilities.includes('usage' as never))
})

test('未知历史和 ACK 错配不会静默改绑或重发', async () => {
  const probe = new FakeBridge(); probe.historyInfo.found = false
  const bad = new FakeBridge(); bad.frames = [ack('999'), patch([block('b', '不可投影')]), end()]
  const d = new DoubaoAppDriver(fakeApp([probe, bad]))
  assert.equal((await d.probeSession({ providerSessionId: '101' })).state, 'unknown')
  const result = await collect(d)
  assert.equal(result.at(-1)?.type, 'finish'); assert.equal((result.at(-1) as any).reason, 'error')
  assert.equal(result.filter((value) => value.type === 'text-delta').length, 0)
  assert.equal(bad.requests.length, 1); assert.equal(bad.created, 1); assert.equal(bad.closed, true)
})

test('同一回合并发拒绝，指定会话取消不影响另一个流', async () => {
  const a = new FakeBridge('101', true); a.frames.pop()
  const b = new FakeBridge('102', true); b.frames.pop()
  const d = new DoubaoAppDriver(fakeApp([a, b]))
  const ia = d.executeTurn(input({ sessionId: 'a' }))[Symbol.asyncIterator]()
  const ib = d.executeTurn(input({ sessionId: 'b' }))[Symbol.asyncIterator]()
  await ia.next(); await ib.next()
  await assert.rejects(collect(d, input({ sessionId: 'a' })), /已有运行/u)
  await ia.next(); await ib.next()
  await d.interrupt('a')
  assert.deepEqual((await ia.next()).value, { type: 'finish', reason: 'cancel' })
  assert.deepEqual(a.stops, [{ id: '101', reply: '301' }]); assert.deepEqual(b.stops, [])
  b.controller!.enqueue(encode(end())); b.controller!.close()
  assert.deepEqual((await ib.next()).value, { type: 'finish', reason: 'stop' })
  await ia.return?.(); await ib.return?.()
  assert.equal(a.closed, true); assert.equal(b.closed, true)
})

test('ACK 前取消等待本轮 reply ID，空流和工作中止不会谎报成功', async () => {
  const early = new FakeBridge('101', true); early.frames = [ack()]
  const d = new DoubaoAppDriver(fakeApp([early]))
  const iterator = d.executeTurn(input())[Symbol.asyncIterator]()
  await iterator.next()
  const next = iterator.next()
  await new Promise((resolve) => setImmediate(resolve))
  await d.interrupt('test')
  assert.deepEqual(early.stops, [])
  early.controller!.enqueue(encode(patch([block('b', '开始')])))
  await next
  assert.deepEqual((await iterator.next()).value, { type: 'finish', reason: 'cancel' })
  assert.deepEqual(early.stops, [{ id: '101', reply: '301' }])
  await iterator.return?.()
  const empty = new FakeBridge(); empty.frames = []
  const emptyResult = await collect(new DoubaoAppDriver(fakeApp([empty])))
  assert.equal((emptyResult.at(-1) as any).reason, 'error')
  const work = new FakeBridge('102', true)
  const wd = new DoubaoAppDriver(fakeApp([work]))
  const wi = wd.executeTurn(input({ modelId: 'doubao-work' }))[Symbol.asyncIterator]()
  await wi.next(); await wi.next()
  const workEnd = wi.next()
  // 已收到阶段结束事件但连接未关闭，仍必须能响应停止接收的请求。
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(wd.interrupt('test'), /云端工具可能继续/u)
  assert.equal((await workEnd).value.reason, 'error')
  assert.deepEqual(work.stops, [])
  await wi.return?.()
})

test('CDP 请求超时和断线都会结算 pending，不暴露原生错误堆栈', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    if (message.method === 'close') socket.close()
    if (message.method === 'Runtime.evaluate') socket.send(JSON.stringify({ id: message.id, result: { exceptionDetails: { exception: { description: 'SECRET_TOKEN_DO_NOT_EXPOSE' } } } }))
  }))
  const cdp = await DoubaoCdp.connect(`ws://127.0.0.1:${port}`, 50)
  try {
    await assert.rejects(cdp.evaluate('x'), (error: Error) => !error.message.includes('SECRET_TOKEN'))
    await assert.rejects(cdp.request('timeout', {}), /超时/u)
    await assert.rejects(cdp.request('close', {}), /已关闭/u)
  } finally { cdp.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('CDP fetch 桥按需读取字节，关闭只释放本轮运行，不关闭浏览器', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening')
  const calls: string[] = []; let reads = 0
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const request = JSON.parse(String(raw)); const expression = request.params.expression as string; calls.push(expression)
    let value: unknown
    if (expression.includes('].start(')) value = { status: 200, mime: 'text/event-stream' }
    else if (expression.includes('].read(')) value = reads++ === 0 ? Array.from(new TextEncoder().encode('验证通过')) : null
    socket.send(JSON.stringify({ id: request.id, result: { result: { value } } }))
  }))
  const port = (server.address() as { port: number }).port
  const bridge = await DoubaoCdpBridge.open(`ws://127.0.0.1:${port}`)
  try {
    const response = await bridge.fetch('https://www.doubao.com/chat/completion', { method: 'POST', body: '{}' })
    assert.equal(reads, 0)
    assert.equal(await response.text(), '验证通过'); assert.equal(reads, 2)
  } finally { await bridge.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  assert.ok(calls.some((value) => value.includes('].dispose(')))
  assert.ok(!calls.some((value) => value.includes('Browser.close') || value.includes('Target.closeTarget')))
})
