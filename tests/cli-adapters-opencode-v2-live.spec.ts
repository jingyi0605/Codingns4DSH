import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { OpenCodeDriver } from '../data/build/dist/host/cli-adapters/opencode-driver.js'

/** 显式启用才运行真实 CLI；独立目录、临时端口和本地模型替身，不触碰 DSH 或用户会话。 */
test('OpenCode 2.0.24 真实 CLI 模型、SSE、工具提问、续聊与附件协议冒烟', {
  skip: process.env.CODINGNS_OPENCODE_V2_LIVE !== '1', timeout: 45_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-opencode-v2-live-'))
  const password = randomBytes(24).toString('hex')
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  let upstreamRequests = 0
  const upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    upstreamRequests += 1
    const text = 'OpenCode V2 兼容验证通过'
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: 'chat', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // 让真实 OpenCode 执行一次 question 工具，验证原生表单和工具事件的完整往返。
    const ask = body.tools?.some((tool: any) => tool.function?.name === 'question')
      && !body.messages.some((message: any) => message.role === 'tool')
    const content = ask ? { tool_calls: [{ index: 0, id: 'call_live_question', type: 'function', function: {
      name: 'question', arguments: JSON.stringify({ questions: [{ header: '验证', question: '是否继续协议验证？', options: [{ label: '继续', description: '完成本地测试' }] }] }),
    } }] } : { content: text }
    for (const delta of [{ role: 'assistant', content: '' }, content]) {
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 1, model: 'chat', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    }
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 1, model: 'chat', choices: [{ index: 0, delta: {}, finish_reason: ask ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  let child: ReturnType<typeof spawn> | undefined
  let driver: OpenCodeDriver | undefined
  let logs = ''
  try {
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const upstreamPort = (upstream.address() as { port: number }).port
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const config = join(directory, 'config')
    await mkdir(config)
    await writeFile(join(config, 'opencode.json'), JSON.stringify({
      model: 'local/chat', providers: { local: {
        package: 'aisdk:@ai-sdk/openai-compatible', settings: { apiKey: 'local-test', baseURL: `http://127.0.0.1:${upstreamPort}/v1` },
        models: { chat: { name: '本地协议验证模型', capabilities: { tools: true }, limit: { context: 8192, output: 1024 } } },
      } },
    }))
    child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: join(config, 'opencode.json'), OPENCODE_CONFIG_PROJECT_DISABLE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1',
        XDG_CONFIG_HOME: join(directory, 'xdg-config'), XDG_DATA_HOME: join(directory, 'data'),
        XDG_STATE_HOME: join(directory, 'state'), XDG_CACHE_HOME: join(directory, 'cache'),
      },
    })
    child.stdout?.on('data', (chunk) => { logs = (logs + String(chunk)).slice(-12_000) })
    child.stderr?.on('data', (chunk) => { logs = (logs + String(chunk)).slice(-12_000) })
    const server = `http://127.0.0.1:${port}`
    const fetchAuthenticated: typeof fetch = (url, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set('authorization', authorization)
      return fetch(url, { ...init, headers })
    }
    const deadline = Date.now() + 20_000
    while (true) {
      const response = await fetchAuthenticated(`${server}/api/info`, { signal: AbortSignal.timeout(500) }).catch(() => null)
      if (response?.ok) break
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`OpenCode V2 临时服务未就绪：${logs.replaceAll(password, '[已隐藏]')}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    driver = new OpenCodeDriver({ binaries: [], serverUrls: [server], fetch: fetchAuthenticated })
    const detected = await driver.detect()
    assert.match(detected.version ?? '', /^2\./u)
    // 初始化快照的等待由驱动负责，测试不得额外重试来掩盖首次目录丢失。
    const catalog = await driver.listModels()
    assert.ok(catalog.groups.some((group) => group.models.some((model) => model.id === 'local/chat')))
    const file = join(directory, 'note.txt')
    await writeFile(file, '附件协议检查')
    let providerSessionId: string | undefined
    for (let turn = 0; turn < 2; turn += 1) {
      const events = []
      for await (const event of driver.executeTurn({
        sessionId: 'opencode-v2-live', cwd: directory, messages: [], prompt: '回复验证结果', modelId: 'local/chat',
        ...(providerSessionId ? { providerSessionId } : {}),
        attachments: [{ kind: 'file', path: file }], signal: AbortSignal.timeout(15_000),
      })) {
        events.push(event)
        if (event.type === 'permission-request') await driver.respondPermission('opencode-v2-live', { requestId: event.requestId, approved: true })
        if (event.type === 'question-request') {
          assert.equal(event.questions[0]?.question, '是否继续协议验证？')
          assert.equal(event.callId, 'call_live_question')
          await driver.respondQuestion('opencode-v2-live', { requestId: event.requestId, answers: [{ id: event.questions[0]!.id, selected: ['继续'] }] })
        }
      }
      const binding = events.find((event) => event.type === 'session-binding')
      if (providerSessionId) assert.equal(binding?.providerSessionId, providerSessionId)
      providerSessionId = binding?.providerSessionId
      assert.ok(providerSessionId)
      assert.equal(events.filter((event) => event.type === 'text-delta').map((event) => event.text).join(''), 'OpenCode V2 兼容验证通过')
      assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
      if (turn === 0) {
        assert.ok(events.some((event) => event.type === 'question-request'))
        assert.ok(events.some((event) => event.type === 'tool-event' && event.toolName === 'question' && event.status === 'completed'))
      }
    }
    assert.ok(upstreamRequests >= 2)
    assert.equal((await driver.probeSession({ providerSessionId, cwd: directory })).state, 'available')
  } finally {
    driver?.dispose()
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const force = setTimeout(() => child?.kill('SIGKILL'), 2_000)
      await exited
      clearTimeout(force)
    }
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
