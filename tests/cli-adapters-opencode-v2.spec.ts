import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeDriver } from '../data/build/dist/host/cli-adapters/opencode-driver.js'

const cwd = '/workspace/中文 目录'
const model = { id: 'alias/review', modelID: 'upstream-model', providerID: 'custom', name: '代码模型', enabled: true, variants: [{ id: 'none' }, { id: 'deep' }], limit: { context: 200 } }
const provider = { id: 'custom', name: '自定义提供商', activation: 'enabled' }
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status })
const envelope = (data: unknown): Response => json({ data })

/** 使用官方 2.0.24 的 data 信封和 session.* 事件；只在 prompt 到达后投递业务事件。 */
function harness(options: {
  events?: Array<{ type: string; data: Record<string, unknown> }>
  promptError?: string
  hold?: boolean
  skills?: unknown[]
  models?: unknown[]
  sessionDirectory?: string
} = {}) {
  const requests: Array<{ path: string; query: URLSearchParams; body: any; headers: Headers }> = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let ended = false
  let ready = false
  let sessionCount = 0
  const emit = (type: string, data: Record<string, unknown> = {}): void => {
    if (!ended) controller?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'evt_test', type, data })}\n\n`))
  }
  const fetch = async (raw: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(raw)
    const path = url.pathname
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, query: url.searchParams, body, headers: new Headers(init.headers) })
    if (path === '/api/info') return json({ version: '2.0.24', pid: 123, urls: [], paths: { tmp: '/tmp' } })
    if (path === '/api/model') return envelope(options.models ?? [model])
    if (path === '/api/provider') return envelope([provider, { id: 'disabled', name: '已禁用', activation: 'disabled' }])
    if (path === '/api/model/default') return envelope(model)
    if (path === '/api/skill') return envelope(options.skills ?? [])
    if (path === '/api/session' && init.method === 'POST') return envelope({ id: `ses_${++sessionCount}` })
    if (/^\/api\/session\/ses_[^/]+$/u.test(path)) return envelope({ id: path.split('/').pop(), location: { directory: options.sessionDirectory ?? cwd } })
    if (path.endsWith('/model') && init.method === 'POST') return envelope({})
    if (path.endsWith('/reply')) return new Response(null, { status: 204 })
    if (path.endsWith('/interrupt')) { emit('session.execution.interrupted', { sessionID: 'ses_1', reason: 'user' }); return json({ interrupted: true }) }
    if (path.endsWith('/prompt')) {
      assert.equal(ready, true, '发送 prompt 前必须完成 SSE 握手')
      if (options.promptError) return json({ message: options.promptError }, 400)
      for (const event of options.events ?? []) emit(event.type, event.data)
      if (!options.hold) { controller?.close(); ended = true }
      return envelope({ id: 'msg_input', sessionID: 'ses_1' })
    }
    if (path === '/api/event') {
      const stream = new ReadableStream<Uint8Array>({ start(value) {
        controller = value
        ended = false
        ready = true
        emit('server.connected')
        init.signal?.addEventListener('abort', () => {
          if (!ended) { value.error(init.signal?.reason); ended = true }
        }, { once: true })
      }, cancel() { ended = true } })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    return json({}, 404)
  }
  const driver = new OpenCodeDriver({ fetch, serverUrls: ['http://opencode.test'], binaries: [] })
  return { driver, requests, emit }
}

const input = { sessionId: 'dsh-session', cwd, messages: [], prompt: '检查代码', modelId: 'custom/alias/review', effortId: 'deep' }
const done = { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } }

test('OpenCode V2 识别真实协议，读取扁平模型目录、别名、默认模型和原生 variants', async () => {
  const { driver, requests } = harness({ models: [model, { ...model, id: 'off', enabled: false }, { ...model, providerID: 'disabled' }] })
  assert.deepEqual(await driver.detect(), { installed: true, version: '2.0.24', command: 'http://opencode.test' })
  assert.deepEqual(await driver.listModels(), {
    groups: [{ id: 'custom', name: '自定义提供商', models: [{ id: 'custom/alias/review', name: '代码模型', efforts: ['none', 'deep'] }] }],
    currentModel: 'custom/alias/review', currentEffort: null,
  })
  assert.equal(requests.some((request) => request.path === '/config/providers'), false)
  driver.dispose()
})

test('OpenCode V2 目录 HTTP 错误不得被吞成空列表，200 HTML 不能误识别成 V1', async () => {
  const driver = new OpenCodeDriver({ binaries: [], serverUrls: ['http://opencode.test'], fetch: async (url: string) => {
    if (url.endsWith('/api/info')) return json({ version: '2.0.24' })
    return json({ message: 'Provider 配置无效' }, 500)
  } })
  await assert.rejects(driver.listModels(), /Provider 配置无效/u)
  const htmlDriver = new OpenCodeDriver({ binaries: [], serverUrls: ['http://opencode.test'], fetch: async () => new Response('<html>OpenCode</html>') })
  assert.equal((await htmlDriver.detect()).installed, false)
  driver.dispose()
  htmlDriver.dispose()
})

test('OpenCode V2 目录等待 Provider 初始化快照收敛，不缓存首次空列表', async () => {
  let reads = 0
  const driver = new OpenCodeDriver({ binaries: [], serverUrls: ['http://opencode.test'], fetch: async (url: string) => {
    if (url.endsWith('/api/info')) return json({ version: '2.0.24' })
    if (url.endsWith('/api/model')) return envelope(++reads < 3 ? [] : [model])
    if (url.endsWith('/api/provider')) return envelope([provider])
    return envelope(model)
  } })
  assert.equal((await driver.listModels()).groups[0]?.models[0]?.id, 'custom/alias/review')
  assert.equal(reads, 4)
  driver.dispose()
})

test('OpenCode V2 非空的内置模型快照也要等待配置模型和默认选择收敛', async () => {
  let reads = 0
  const initial = { ...model, id: 'free', providerID: 'builtin' }
  const driver = new OpenCodeDriver({ binaries: [], serverUrls: ['http://opencode.test'], fetch: async (url: string) => {
    if (url.endsWith('/api/info')) return json({ version: '2.0.24' })
    if (url.endsWith('/api/model')) return envelope(++reads === 1 ? [initial] : [model])
    if (url.endsWith('/api/provider')) return envelope([provider, { id: 'builtin', name: '内置' }])
    return envelope(reads === 1 ? initial : model)
  } })
  const catalog = await driver.listModels()
  assert.equal(catalog.currentModel, 'custom/alias/review')
  assert.deepEqual(catalog.groups.map((group) => group.id), ['custom'])
  driver.dispose()
})

test('OpenCode V2 原生 service 登记提供认证，拒绝复用 PID 不匹配的旧登记', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-opencode-service-'))
  try {
    const serviceFile = join(directory, 'service.json')
    await writeFile(serviceFile, JSON.stringify({ url: 'http://127.0.0.1:4199', pid: 123, password: 'service-secret', version: '2.0.24' }))
    const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
      assert.equal(new Headers(init.headers).get('authorization'), `Basic ${Buffer.from('opencode:service-secret').toString('base64')}`)
      if (url.endsWith('/api/info')) return json({ version: '2.0.24', pid: 123 })
      if (url.endsWith('/api/model')) return envelope([model])
      if (url.endsWith('/api/provider')) return envelope([provider])
      return envelope(model)
    }
    const driver = new OpenCodeDriver({ binaries: [], serverUrls: [], serviceFile, fetch })
    assert.equal((await driver.detect()).command, 'http://127.0.0.1:4199')
    assert.equal((await driver.listModels()).groups.length, 1)
    driver.dispose()
    const stale = new OpenCodeDriver({ binaries: [], serverUrls: [], serviceFile, fetch: async () => json({ version: '2.0.24', pid: 456 }) })
    assert.equal((await stale.detect()).installed, false)
    stale.dispose()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('OpenCode V2 托管服务显式传入认证密码，目录请求使用认证头', async () => {
  let spawned = false
  let password: string | undefined
  let killed = false
  const driver = new OpenCodeDriver({
    binaries: ['opencode'], serverUrls: [],
    spawnSync: (() => ({ status: 0, stdout: 'opencode v2.0.24', stderr: '' })) as never,
    spawn: ((_command: string, _args: string[], options: any) => {
      spawned = true
      password = options.env.OPENCODE_PASSWORD
      assert.equal(password, options.env.OPENCODE_SERVER_PASSWORD)
      return { stdout: new PassThrough(), stderr: new PassThrough(), kill() { killed = true; return true } }
    }) as never,
    fetch: async (url: string, init: RequestInit = {}) => {
      assert.equal(spawned, true)
      assert.equal(new Headers(init.headers).get('authorization'), `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`)
      if (url.endsWith('/api/info')) return json({ version: '2.0.24' })
      if (url.endsWith('/api/model')) return envelope([model])
      if (url.endsWith('/api/provider')) return envelope([provider])
      return envelope(model)
    },
  })
  assert.equal((await driver.listModels()).groups.length, 1)
  assert.ok(password && password.length > 20)
  driver.dispose()
  assert.equal(killed, true)
})

test('OpenCode V2 文本快照去重，工具步骤不提前结束回合，严格隔离其他会话', async () => {
  const data = { sessionID: 'ses_1', assistantMessageID: 'msg_assistant', ordinal: 0 }
  const tool = { ...data, id: 'call_1' }
  const { driver, requests } = harness({ events: [
    { type: 'session.text.delta', data: { ...data, sessionID: 'ses_other', delta: '不能出现' } },
    { type: 'session.execution.succeeded', data: { sessionID: 'ses_other' } },
    { type: 'session.reasoning.delta', data: { ...data, delta: '思考' } },
    { type: 'session.reasoning.ended', data: { ...data, text: '思考完成' } },
    { type: 'session.text.delta', data: { ...data, delta: '检查' } },
    { type: 'session.text.ended', data: { ...data, text: '检查代码' } },
    { type: 'session.tool.input.started', data: { ...tool, name: 'bash' } },
    { type: 'session.tool.called', data: { ...tool, input: { command: 'pwd' }, executed: false } },
    { type: 'session.tool.success', data: { ...tool, content: [{ type: 'text', text: cwd }], executed: false } },
    { type: 'session.step.ended', data: { ...data, finish: 'tool-calls', tokens: { input: 100, output: 5, reasoning: 2, cache: { read: 40, write: 5 } } } },
    { type: 'session.text.ended', data: { ...data, assistantMessageID: 'msg_final', text: '最终结果' } }, done,
  ] })
  const events = []
  for await (const event of driver.executeTurn(input)) events.push(event)
  assert.deepEqual(events.filter((event) => event.type === 'text-delta').map((event) => event.text), ['检查', '代码', '最终结果'])
  assert.deepEqual(events.filter((event) => event.type === 'reasoning-delta').map((event) => event.text), ['思考', '完成'])
  assert.equal(events.filter((event) => event.type === 'finish').length, 1)
  assert.equal(events.at(-1)?.type, 'finish')
  assert.deepEqual(events.find((event) => event.type === 'tool-event' && event.status === 'completed'), {
    type: 'tool-event', toolName: 'bash', callId: 'call_1', status: 'completed', input: '{"command":"pwd"}', output: cwd, outputMode: 'snapshot',
  })
  const usage = events.find((event) => event.type === 'usage')
  assert.equal(usage?.contextTokens, 145)
  assert.equal(usage?.contextWindow, 200)
  assert.equal(usage?.uncachedInputTokens, 100)
  assert.deepEqual(requests.find((request) => request.path === '/api/session')?.body, {
    title: input.sessionId, model: { id: 'alias/review', providerID: 'custom', variant: 'deep' }, location: { directory: cwd },
  })
  assert.deepEqual(requests.find((request) => request.path.endsWith('/prompt'))?.body, { text: input.prompt })
  assert.equal(requests.find((request) => request.path === '/api/model')?.query.get('location[directory]'), cwd)
  driver.dispose()
})

test('OpenCode V2 续聊先切模型，目录变更后创建新会话', async () => {
  const mock = harness({ events: [done] })
  for await (const _ of mock.driver.executeTurn({ ...input, providerSessionId: 'ses_1' })) { /* 读取完整回合。 */ }
  assert.equal(mock.requests.some((request) => request.path === '/api/session'), false)
  const switchIndex = mock.requests.findIndex((request) => request.path === '/api/session/ses_1/model')
  const promptIndex = mock.requests.findIndex((request) => request.path.endsWith('/prompt'))
  assert.ok(switchIndex >= 0 && switchIndex < promptIndex)
  assert.deepEqual(mock.requests[switchIndex]?.body, { model: { id: 'alias/review', providerID: 'custom', variant: 'deep' } })
  const moved = harness({ events: [done], sessionDirectory: '/another/workspace' })
  for await (const _ of moved.driver.executeTurn({ ...input, providerSessionId: 'ses_old' })) { /* 目录不同应新建。 */ }
  assert.equal(moved.requests.some((request) => request.path === '/api/session'), true)
  mock.driver.dispose()
  moved.driver.dispose()
})

test('OpenCode V2 权限和表单回复保留 session 路由、option.value 与字段类型', async () => {
  const { driver, requests } = harness({ events: [
    { type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_1', action: 'edit', resources: ['src/*'] } },
    { type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_1', title: '配置', fields: [
      { key: 'mode', type: 'string', title: '选择模式', options: [{ label: '快速', value: 'fast' }] },
      { key: 'checks', type: 'multiselect', title: '选择检查', options: [{ label: '类型', value: 'types' }] },
      { key: 'enabled', type: 'boolean', title: '启用' }, { key: 'count', type: 'integer', title: '数量' },
    ] } } }, done,
  ] })
  for await (const event of driver.executeTurn(input)) {
    if (event.type === 'permission-request') await driver.respondPermission(input.sessionId, { requestId: event.requestId, approved: false, reason: '取消操作' })
    if (event.type === 'question-request') await driver.respondQuestion(input.sessionId, { requestId: event.requestId, answers: [
      { id: 'mode', selected: ['快速'] }, { id: 'checks', selected: ['类型'] }, { id: 'enabled', selected: ['是'] }, { id: 'count', selected: [], custom: '3' },
    ] })
  }
  assert.deepEqual(requests.find((request) => request.path.endsWith('/permission/per_1/reply'))?.body, { decision: 'reject', message: '取消操作' })
  assert.deepEqual(requests.find((request) => request.path.endsWith('/form/frm_1/reply'))?.body, { answer: { mode: 'fast', checks: ['types'], enabled: true, count: 3 } })
  await assert.rejects(driver.respondQuestion(input.sessionId, { requestId: 'frm_1', answers: [] }), /请求已结束/u)
  driver.dispose()
})

test('OpenCode V2 原生 Skill 引用和附件使用 prompt.skills/files，不误调用同名 command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-opencode-v2-'))
  try {
    const path = join(directory, 'note.txt')
    await writeFile(path, '附件内容')
    const { driver, requests } = harness({ skills: [{ id: 'team/review', name: 'review', description: '审查', path: '/secret/skill', content: '隐藏内容' }], events: [done] })
    assert.deepEqual(await driver.listSkills({ sessionId: input.sessionId, cwd }), [{ id: 'team/review', name: 'review', description: '审查', enabled: true }])
    for await (const _ of driver.executeTurn({ ...input, prompt: '/review 检查改动', attachments: [{ kind: 'file', path, name: 'note.txt' }] })) { /* 收集请求即可验证原生字段。 */ }
    assert.deepEqual(requests.find((request) => request.path.endsWith('/prompt'))?.body, {
      text: '检查改动', skills: [{ id: 'team/review' }], files: [{ uri: `data:text/plain;base64,${Buffer.from('附件内容').toString('base64')}`, name: 'note.txt' }],
    })
    driver.dispose()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('OpenCode V2 prompt 失败立即结束长连接等待并保留真实错误', { timeout: 2_000 }, async () => {
  const { driver } = harness({ promptError: '模型凭据已失效', hold: true })
  await assert.rejects(async () => { for await (const _ of driver.executeTurn(input)) {} }, /模型凭据已失效/u)
  driver.dispose()
})

test('OpenCode V2 断流不能报告成功，执行失败保留终态详情', async () => {
  const disconnected = harness()
  await assert.rejects(async () => { for await (const _ of disconnected.driver.executeTurn(input)) {} }, /结束前断开/u)
  const failed = harness({ events: [{ type: 'session.execution.failed', data: { sessionID: 'ses_1', error: { type: 'api', message: '上游限流' } } }] })
  const events = []
  for await (const event of failed.driver.executeTurn(input)) events.push(event)
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'error', failure: { message: '上游限流' } })
  disconnected.driver.dispose()
  failed.driver.dispose()
})

test('OpenCode V2 取消只请求会话 interrupt，返回 cancel', { timeout: 2_000 }, async () => {
  const { driver, requests } = harness({ hold: true, events: [{ type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: '开始' } }] })
  const controller = new AbortController()
  const events = []
  for await (const event of driver.executeTurn({ ...input, signal: controller.signal })) {
    events.push(event)
    if (event.type === 'text-delta') controller.abort()
  }
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'cancel' })
  assert.equal(requests.filter((request) => request.path.endsWith('/interrupt')).length, 1)
  driver.dispose()
})
