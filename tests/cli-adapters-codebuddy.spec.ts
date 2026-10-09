import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { PassThrough } from 'node:stream'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodeBuddyCliDriver, CodeBuddyCnCliDriver, WorkBuddyCliDriver, readCodeBuddyHistoryUsage } from '../data/build/dist/host/cli-adapters/codebuddy-driver.js'

function detected() {
  return { status: 0, stdout: 'codebuddy 2.159.0\n  --acp  Start in ACP mode', stderr: '' } as never
}

function fakeAcpSpawn(promptResult: unknown, notification?: unknown) {
  return (() => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdin = {
      write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number; method?: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'workbuddy-session' } })}\n`)
        if (request.method === 'session/prompt') {
          if (notification !== undefined) stdout.write(`${JSON.stringify(notification)}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: promptResult })}\n`)
        }
        return true
      },
    }
    return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
  }) as never
}

interface FakeWorkBuddyHarness {
  readonly socketPath: string
  readonly configRoot: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly endpoint: string
  readonly sidecarCalls: string[]
  readonly httpCalls: string[]
  readonly isPromptClosed: () => boolean
  readonly close: () => Promise<void>
}

async function readHttpJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text) as Record<string, unknown>
}

function writeSse(response: ServerResponse, messages: readonly Record<string, unknown>[], end = true): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
  for (const message of messages) response.write(`data: ${JSON.stringify(message)}\n\n`)
  if (end) response.end()
}

async function createFakeWorkBuddyHarness(holdPrompt: boolean, pidlessSocket = false, emptyEndpoint = false): Promise<FakeWorkBuddyHarness> {
  const sidecarCalls: string[] = []
  const httpCalls: string[] = []
  let promptClosed = false
  let promptResponse: ServerResponse | undefined
  const httpServer = createHttpServer(async (request, response) => {
    try {
      const body = await readHttpJson(request)
      const rpcMethod = typeof body.method === 'string' ? body.method : ''
      httpCalls.push(`${request.method ?? ''} ${request.url ?? ''}${rpcMethod === '' ? '' : ` ${rpcMethod}`}`)
      if (request.url?.endsWith('/connect')) {
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        response.end(JSON.stringify({ connectionId: 'fake-connection', sessionToken: 'fake-token' }))
        return
      }
      if (request.method === 'DELETE') {
        response.writeHead(204)
        response.end()
        return
      }
      const id = body.id as number | string | undefined
      if (rpcMethod === 'initialized') {
        response.writeHead(202)
        response.end()
      } else if (rpcMethod === 'initialize') {
        writeSse(response, [{ jsonrpc: '2.0', id, result: {} }])
      } else if (rpcMethod === 'session/new' || rpcMethod === 'session/load') {
        if (rpcMethod === 'session/load') assert.equal((body.params as { sessionId: string }).sessionId, 'fake-provider-session')
        writeSse(response, [{ jsonrpc: '2.0', id, result: { sessionId: 'fake-provider-session' } }])
      } else if (rpcMethod === 'session/set_model' || rpcMethod === 'session/cancel') {
        writeSse(response, [{ jsonrpc: '2.0', id, result: {} }])
      } else if (rpcMethod === 'session/prompt') {
        promptResponse = response
        response.once('close', () => { promptClosed = true })
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
        response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } })}\n\n`)
        if (!holdPrompt) {
          response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })}\n\n`)
          response.end()
        }
      } else {
        response.writeHead(400)
        response.end()
      }
    } catch (error) {
      response.destroy(error as Error)
    }
  })
  const httpPort = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address()
      if (address === null || typeof address === 'string') reject(new Error('fake HTTP server address unavailable'))
      else resolve(address.port)
    })
  })
  const endpoint = `http://127.0.0.1:${httpPort}/api/v1/acp`
  // macOS sockaddr_un 只有 104 字节；pidless 场景使用 /tmp 保证测试 socket 路径足够短。
  const socketRoot = mkdtempSync(pidlessSocket ? '/tmp/codingns-workbuddy-' : join(tmpdir(), 'codingns-workbuddy-'))
  const configRoot = join(socketRoot, 'config')
  const uidToken = createHash('sha1').update(String(process.getuid?.() ?? 'unknown')).digest('hex').slice(0, 6)
  const configToken = createHash('sha1').update(configRoot).digest('hex').slice(0, 12)
  const runtimeRoot = join(socketRoot, `wb-${uidToken}`, configToken)
  if (pidlessSocket) mkdirSync(runtimeRoot, { recursive: true })
  const socketPath = process.platform === 'win32' && !pidlessSocket
    ? String.raw`\\.\pipe\codingns-workbuddy-${randomUUID()}`
    : pidlessSocket ? join(runtimeRoot, 'sidecar-deadbeef.sock') : join(socketRoot, 'sidecar.sock')
  const sidecarServer = createNetServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim() === '') continue
        const request = JSON.parse(line) as { id?: number | string; method?: string }
        const method = request.method ?? ''
        sidecarCalls.push(method)
        const result = method === 'session.list'
          ? [{ sessionId: '__workbuddy_cli_host__-fake', acpEndpoint: endpoint }]
          : method === 'session.create' ? { acpEndpoint: emptyEndpoint ? '' : endpoint } : {}
        socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    sidecarServer.once('error', reject)
    sidecarServer.listen(socketPath, resolve)
  })
  return {
    socketPath,
    configRoot,
    environment: pidlessSocket ? { TMPDIR: socketRoot } : {},
    endpoint,
    sidecarCalls,
    httpCalls,
    isPromptClosed: () => promptClosed,
    close: async () => {
      promptResponse?.end()
      httpServer.closeAllConnections?.()
      await Promise.all([
        new Promise<void>((resolve) => httpServer.close(() => resolve())),
        new Promise<void>((resolve) => sidecarServer.close(() => resolve())),
      ])
      rmSync(socketRoot, { recursive: true, force: true })
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
}

test('CodeBuddy 与 WorkBuddy 使用不同配置根，WorkBuddy 不回退 PATH', async () => {
  const codebuddy = new CodeBuddyCliDriver({
    binaries: ['fake-codebuddy'],
    environment: { CODEBUDDY_CONFIG_DIR: '/tmp/codebuddy-root' },
    spawnSync: detected,
  })
  assert.equal(codebuddy.configDirectory, '/tmp/codebuddy-root')
  assert.deepEqual(await codebuddy.detect(), { installed: true, version: '2.159.0', command: 'fake-codebuddy' })

  const calls: string[] = []
  const workbuddy = new WorkBuddyCliDriver({
    commandPath: '/tmp/missing-workbuddy-codebuddy',
    spawnSync: ((command: string) => {
      calls.push(command)
      return { status: 127, stdout: '', stderr: '' }
    }) as never,
    platform: 'darwin',
  })
  assert.deepEqual(await workbuddy.detect(), { installed: false, version: null, command: null })
  assert.deepEqual(calls, ['/tmp/missing-workbuddy-codebuddy'])
  assert.equal(workbuddy.supportsToolStepSplitting, true)
})

test('WorkBuddy 默认配置根复用桌面应用的认证目录', () => {
  const driver = new WorkBuddyCliDriver({ commandPath: '/tmp/missing-workbuddy-codebuddy' })
  assert.equal(driver.configDirectory, join(homedir(), '.workbuddy'))
  driver.dispose()
})

test('WorkBuddy 在官方未提供的平台直接判定不可用，不尝试启动', async () => {
  const calls: string[] = []
  const driver = new WorkBuddyCliDriver({
    platform: 'linux',
    commandPath: '/tmp/missing-workbuddy-codebuddy',
    spawnSync: ((command: string) => {
      calls.push(command)
      return { status: 0, stdout: 'codebuddy 2.159.0', stderr: '' }
    }) as never,
  })
  // WorkBuddy 只随桌面应用分发（darwin/win32），Linux 上必须拒绝而不是猜测路径。
  assert.deepEqual(await driver.detect(), { installed: false, version: null, command: null })
  assert.deepEqual(calls, [])
  await assert.rejects(
    async () => { for await (const _event of driver.executeTurn({ sessionId: 'linux-session', messages: [], prompt: '检查' })) void _event },
    /WorkBuddy CLI 未安装/u,
  )
  driver.dispose()
})

test('CodeBuddy 支持 Linux，不受 WorkBuddy 平台限制影响', async () => {
  const driver = new CodeBuddyCliDriver({
    platform: 'linux',
    binaries: ['fake-codebuddy'],
    spawnSync: detected,
  })
  assert.deepEqual(await driver.detect(), { installed: true, version: '2.159.0', command: 'fake-codebuddy' })
  driver.dispose()
})

test('WorkBuddy sidecar 创建独立运行时并消费 HTTP ACP SSE 后回收', async () => {
  const harness = await createFakeWorkBuddyHarness(false)
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    sidecarSocketPath: harness.socketPath,
  })
  const events = []
  try {
    for await (const event of driver.executeTurn({ sessionId: 'sidecar-session', messages: [], prompt: '检查' })) events.push(event)
    for await (const event of driver.executeTurn({ sessionId: 'sidecar-session', providerSessionId: 'fake-provider-session', messages: [], prompt: '继续' })) events.push(event)
  } finally {
    driver.dispose()
    await harness.close()
  }
  assert.deepEqual(harness.sidecarCalls, ['session.create', 'session.kill', 'session.create', 'session.kill'])
  assert.equal(harness.httpCalls.some((value) => value.endsWith(' session/load')), true)
  assert.equal(harness.httpCalls.some((value) => value.endsWith(' initialize')), true)
  assert.equal(harness.httpCalls.some((value) => value.endsWith(' initialized')), true)
  assert.equal(harness.httpCalls.some((value) => value.endsWith(' session/new')), true)
  assert.equal(harness.httpCalls.some((value) => value.endsWith(' session/prompt')), true)
  assert.equal(events[0]?.type, 'session-binding')
  assert.equal(events.some((event) => event.type === 'text-delta' && event.text === 'OK'), true)
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
})

test('WorkBuddy sidecar 创建 runtime 但未返回 ACP 地址时仍回收 runtime', async () => {
  const harness = await createFakeWorkBuddyHarness(false, false, true)
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    sidecarSocketPath: harness.socketPath,
  })
  try {
    await assert.rejects(async () => {
      for await (const _event of driver.executeTurn({ sessionId: 'missing-endpoint-session', messages: [], prompt: '检查' })) {
        // 该分支预期在生成首个事件前失败。
      }
    }, /WorkBuddy sidecar 未返回 ACP 地址/u)
  } finally {
    driver.dispose()
    await harness.close()
  }
  assert.deepEqual(harness.sidecarCalls, ['session.create', 'session.kill'])
})

test('WorkBuddy sidecar 缺少 sidecar.pid 时扫描 UUID 控制 socket', { skip: process.platform === 'win32' }, async () => {
  const harness = await createFakeWorkBuddyHarness(false, true)
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    configRoot: harness.configRoot,
    environment: harness.environment,
    spawnSync: detected,
  })
  const events = []
  try {
    for await (const event of driver.executeTurn({ sessionId: 'pidless-sidecar-session', messages: [], prompt: '检查' })) events.push(event)
  } finally {
    driver.dispose()
    await harness.close()
  }
  assert.deepEqual(harness.sidecarCalls, ['session.create', 'session.kill'])
  assert.equal(events.some((event) => event.type === 'text-delta' && event.text === 'OK'), true)
})

test('WorkBuddy 没有 sidecar 控制 socket 时返回可操作诊断', async () => {
  const root = mkdtempSync('/tmp/codingns-workbuddy-no-sidecar-')
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    configRoot: join(root, 'config'),
    environment: { TMPDIR: root },
    spawnSync: detected,
  })
  try {
    await assert.rejects(async () => {
      for await (const _event of driver.executeTurn({ sessionId: 'missing-sidecar-session', messages: [], prompt: '检查' })) {
        // 该分支预期在生成首个事件前失败。
      }
    }, /WorkBuddy 桌面运行通道尚未就绪.*打开并登录 WorkBuddy.*发送一条消息后重试.*已认证运行时/u)
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkBuddy sidecar 中断会取消仍在读取的 HTTP ACP prompt body', async () => {
  const harness = await createFakeWorkBuddyHarness(true)
  const controller = new AbortController()
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    sidecarSocketPath: harness.socketPath,
  })
  const stream = driver.executeTurn({ sessionId: 'sidecar-abort-session', messages: [], prompt: '检查', signal: controller.signal })[Symbol.asyncIterator]()
  try {
    assert.equal((await stream.next()).value?.type, 'session-binding')
    assert.equal((await stream.next()).value?.type, 'text-delta')
    controller.abort()
    const result = await Promise.race([
      stream.next().then(() => 'settled', () => 'settled'),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ])
    assert.equal(result, 'settled')
    await waitFor(harness.isPromptClosed)
    assert.equal(harness.isPromptClosed(), true)
  } finally {
    driver.dispose()
    await harness.close()
  }
})

test('CodeBuddy 单一适配器按区域环境自动选择运行配置', async () => {
  const environments: Array<Record<string, string | undefined>> = []
  const spawnSync = ((_command: string, _args: readonly string[], options: { env?: Record<string, string | undefined> }) => {
    environments.push(options.env ?? {})
    return detected()
  }) as never
  const driver = new CodeBuddyCliDriver({
    commandPath: '/tmp/codebuddy',
    configRoot: '/tmp/codebuddy',
    environment: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal', HOME: '/tmp/codebuddy-test-home' },
    spawnSync,
  })

  assert.deepEqual(await driver.detect(), { installed: true, version: '2.159.0', command: '/tmp/codebuddy' })
  assert.equal(driver.descriptor.id, 'codebuddy')
  assert.equal(driver.descriptor.capabilities.includes('usage'), true)
  assert.equal(driver.configDirectory, '/tmp/codebuddy')
  const environment = environments[0]
  assert.equal(environment.CODEBUDDY_INTERNET_ENVIRONMENT, 'internal')
  assert.equal(environment.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT, 'internal')
  assert.equal(environment.CODEBUDDY_CONFIG_DIR, '/tmp/codebuddy')
  assert.equal(environment.CODEBUDDY_CN_CONFIG_DIR, '/tmp/codebuddy')
  driver.dispose()
})

test('CodeBuddy 没有显式区域变量时按认证域名自动选择 CN', async () => {
  const authRoot = mkdtempSync(join(tmpdir(), 'codingns-codebuddy-auth-'))
  const authFile = join(authRoot, 'auth.info')
  writeFileSync(authFile, JSON.stringify({ auth: { domain: 'www.codebuddy.cn' } }), 'utf8')
  const environments: Array<Record<string, string | undefined>> = []
  const driver = new CodeBuddyCliDriver({
    commandPath: '/tmp/codebuddy',
    environment: { HOME: authRoot, CODEBUDDY_AUTH_FILE: authFile },
    spawnSync: ((_command: string, _args: readonly string[], options: { env?: Record<string, string | undefined> }) => {
      environments.push(options.env ?? {})
      return detected()
    }) as never,
  })
  assert.deepEqual(await driver.detect(), { installed: true, version: '2.159.0', command: '/tmp/codebuddy' })
  assert.equal(environments[0]?.CODEBUDDY_INTERNET_ENVIRONMENT, 'internal')
  assert.equal(environments[0]?.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT, 'internal')
  driver.dispose()
  rmSync(authRoot, { recursive: true, force: true })
})

test('WorkBuddy 将 Auto 三档识别为默认模型的思考强度，不混入模型列表', async () => {
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    modelCatalogPaths: ['/tmp/workbuddy-product-config.json'],
    readFileSync: (() => JSON.stringify({
      agents: [{ name: 'cli', models: ['fast-model', 'balanced-model', 'deep-model', 'glm-5.3', 'missing-model'] }],
      models: [
        { id: 'fast-model', name: '快速', descriptionZh: '优先速度', reasoning: { effort: 'medium' } },
        { id: 'balanced-model', name: '均衡', descriptionZh: '兼顾速度和质量', reasoning: { effort: 'medium' } },
        { id: 'deep-model', name: '极致', descriptionZh: '优先深度和准确性', reasoning: { effort: 'medium' } },
        { id: 'glm-5.3', name: 'GLM-5.3', descriptionZh: '复杂任务', reasoning: { supportedEfforts: ['low', 'high', 'max'] } },
        { id: 'hidden-model', name: '隐藏模型' },
      ],
    })) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    {
      id: 'provider-default',
      name: '跟随 WorkBuddy 默认模型',
      efforts: ['fast-model', 'balanced-model', 'deep-model'],
      effortLabels: { 'fast-model': '快速', 'balanced-model': '均衡', 'deep-model': '极致' },
    },
    { id: 'glm-5.3', name: 'GLM-5.3', description: '复杂任务', efforts: ['low', 'high', 'max'] },
  ])
  driver.dispose()
})

test('WorkBuddy 展示官方基础倍率，保留模型和档位 ID', async (t) => {
  const product = {
    agents: [{ name: 'cli', models: ['priced', 'free', 'missing', 'invalid'] }],
    models: [
      { id: 'priced', name: 'Priced', credits: 'x0.79', descriptionZh: '模型介绍' },
      { id: 'free', name: 'Free', credits: 'x0.00' },
      { id: 'missing', name: 'Missing' },
      { id: 'invalid', name: 'Invalid', credits: 'x-1' },
      { id: 'fast-model', name: '快速', credits: 'x0.21' },
      { id: 'balanced-model', name: '均衡', credits: 'x0.65' },
      { id: 'deep-model', name: '极致', credits: 'x1.20' },
    ],
  }
  const options = {
    platform: 'darwin' as const,
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected, modelCatalogPaths: ['/tmp/workbuddy-pricing.info'],
    readFileSync: (() => JSON.stringify([{ data: product }])) as never,
  }
  const driver = new WorkBuddyCliDriver(options)
  const codebuddy = new CodeBuddyCliDriver(options)
  t.after(() => { driver.dispose(); codebuddy.dispose() })
  const models = (await driver.listModels()).groups[0]!.models
  assert.deepEqual(models[0]?.effortLabels, {
    'fast-model': '快速 · 0.21×', 'balanced-model': '均衡 · 0.65×', 'deep-model': '极致 · 1.20×',
  })
  assert.deepEqual(models.slice(1), [
    { id: 'priced', name: 'Priced · 0.79×', description: '模型介绍', efforts: [] },
    { id: 'free', name: 'Free · 0.00×', efforts: [] },
    { id: 'missing', name: 'Missing', efforts: [] },
    { id: 'invalid', name: 'Invalid', efforts: [] },
  ])
  const other = (await codebuddy.listModels()).groups[0]!.models.find((model) => model.id === 'priced')
  assert.equal(other?.name, 'Priced')
  assert.equal(other?.description, '模型介绍')
})

test('WorkBuddy 解包 local_storage 的 data envelope 后读取当前模型目录', async () => {
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    modelCatalogPaths: ['/tmp/workbuddy-local-storage.info'],
    readFileSync: (() => JSON.stringify([{
      userId: 'test-user',
      data: {
        agents: [{ name: 'cli', models: ['fast-model', 'balanced-model', 'deep-model', 'glm-5.3'] }],
        models: [
          { id: 'fast-model', name: '快速' },
          { id: 'balanced-model', name: '均衡' },
          { id: 'deep-model', name: '极致' },
          { id: 'glm-5.3', name: 'GLM-5.3', reasoning: { supportedEfforts: ['low', 'high', 'max'] } },
        ],
      },
    }])) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    {
      id: 'provider-default',
      name: '跟随 WorkBuddy 默认模型',
      efforts: ['fast-model', 'balanced-model', 'deep-model'],
      effortLabels: { 'fast-model': '快速', 'balanced-model': '均衡', 'deep-model': '极致' },
    },
    { id: 'glm-5.3', name: 'GLM-5.3', efforts: ['low', 'high', 'max'] },
  ])
  driver.dispose()
})

test('WorkBuddy 从全局模型目录补齐不在 cli agent 中的 Auto 三档', async () => {
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    modelCatalogPaths: ['/tmp/workbuddy-current-shape.info'],
    readFileSync: (() => JSON.stringify([{
      userId: 'test-user',
      data: {
        agents: [{ name: 'cli', models: ['auto', 'hy4-preview-f', 'glm-5.3'] }],
        models: [
          { id: 'auto', name: 'Auto', reasoning: { effort: 'high', summary: 'auto' } },
          { id: 'fast-model', name: '快速', reasoning: { effort: 'medium', summary: 'auto' } },
          { id: 'balanced-model', name: '均衡', reasoning: { effort: 'medium', summary: 'auto' } },
          { id: 'deep-model', name: '极致', reasoning: { effort: 'medium', summary: 'auto' } },
          { id: 'hy4-preview-f', name: 'Hy4 preview', reasoning: { supportedEfforts: ['high'] } },
          { id: 'glm-5.3', name: 'GLM-5.3', reasoning: { supportedEfforts: ['low', 'high', 'max'] } },
        ],
      },
    }])) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    {
      id: 'provider-default',
      name: '跟随 WorkBuddy 默认模型',
      efforts: ['fast-model', 'balanced-model', 'deep-model'],
      effortLabels: { 'fast-model': '快速', 'balanced-model': '均衡', 'deep-model': '极致' },
    },
    { id: 'hy4-preview-f', name: 'Hy4 preview', efforts: ['high'] },
    { id: 'glm-5.3', name: 'GLM-5.3', efforts: ['low', 'high', 'max'] },
  ])
  driver.dispose()
})

test('CodeBuddy 模型目录读取主 Agent 模型并保留默认入口', async () => {
  const driver = new CodeBuddyCliDriver({
    commandPath: '/tmp/codebuddy',
    spawnSync: detected,
    modelCatalogPaths: ['/tmp/codebuddy-product.json'],
    readFileSync: (() => JSON.stringify({
      agents: [
        { name: 'craft', models: ['default', 'deepseek-v4-flash'] },
        { name: 'agent', models: ['hy3'] },
        { name: 'CodeCompletion', models: ['internal-completion'] },
      ],
      models: [
        { id: 'default', name: '默认模型' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoning: { effort: 'high' } },
        { id: 'hy3', name: 'Hy3', reasoning: { supportedEfforts: ['low', 'high'] } },
        { id: 'internal-completion', name: '内部补全模型' },
      ],
    })) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'provider-default', name: '跟随 CodeBuddy 默认模型', efforts: [] },
    { id: 'default', name: '默认模型', efforts: [] },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', efforts: ['high'] },
    { id: 'hy3', name: 'Hy3', efforts: ['low', 'high'] },
  ])
  driver.dispose()
})

test('CodeBuddy 与 WorkBuddy 的静态目录明确标记为回退目录', async () => {
  const readFailure = (() => { throw new Error('product catalog unavailable') }) as never
  const codeBuddy = new CodeBuddyCliDriver({
    commandPath: '/tmp/codebuddy',
    spawnSync: detected,
    readFileSync: readFailure,
  })
  const workBuddy = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    readFileSync: readFailure,
    useSidecar: false,
  })

  try {
    const [codeBuddyCatalog, workBuddyCatalog] = await Promise.all([codeBuddy.listModels(), workBuddy.listModels()])
    assert.equal(codeBuddyCatalog.fallback, true)
    assert.equal(workBuddyCatalog.fallback, true)
    assert.deepEqual(codeBuddyCatalog.groups[0]?.models.map((model) => model.id), ['provider-default'])
    assert.deepEqual(workBuddyCatalog.groups[0]?.models.map((model) => model.id), ['provider-default'])
  } finally {
    codeBuddy.dispose()
    workBuddy.dispose()
  }
})

test('CodeBuddy 自动识别 CN 后优先读取官方 product.internal.json 模型目录', async () => {
  const reads: string[] = []
  const driver = new CodeBuddyCnCliDriver({
    commandPath: '/opt/homebrew/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy',
    spawnSync: detected,
    environment: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' },
    readFileSync: ((path: string) => {
      reads.push(path)
      if (path.endsWith('/product.internal.json')) {
        return JSON.stringify({
          agents: [{ name: 'cli', models: ['hy4-preview', 'glm-5.3'] }],
          models: [
            { id: 'hy4-preview', name: '混元 4.0' },
            { id: 'glm-5.3', name: 'GLM-5.3' },
          ],
        })
      }
      throw new Error('missing catalog')
    }) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models.map((model) => model.id), ['provider-default', 'hy4-preview', 'glm-5.3'])
  assert.equal(reads.some((path) => path.endsWith('/product.internal.json')), true)
  driver.dispose()
})

test('WorkBuddy 选择 Auto 思考强度时下发对应的真实模型 ID', async () => {
  const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        write(data: string): boolean {
          const request = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown> }
          requests.push(request)
          if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'workbuddy-session' } })}\n`)
          if (request.method === 'session/set_model') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          if (request.method === 'session/prompt') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
          }
          return true
        },
      }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-session', messages: [], prompt: '检查', modelId: 'provider-default', effortId: 'balanced-model' })) chunks.push(chunk)
  assert.equal(requests.find((request) => request.method === 'session/set_model')?.params?.modelId, 'balanced-model')
  assert.equal(chunks.at(-1)?.type, 'finish')
  driver.dispose()
})

test('CodeBuddy 的 buddycn 桌面 CLI 不被误判为 ACP CLI', async () => {
  const driver = new CodeBuddyCnCliDriver({
    commandPath: '/Users/jackson/.codebuddy/bin/buddycn',
    spawnSync: ((command: string, args: readonly string[]) => {
      if (args.includes('--help')) return { status: 0, stdout: 'Usage: buddycn [options]', stderr: '' }
      return { status: 0, stdout: '1.106.1', stderr: '' }
    }) as never,
  })
  assert.deepEqual(await driver.detect(), { installed: false, version: null, command: null })
  assert.equal(driver.discoveryError, 'CodeBuddy CLI 不支持 ACP 协议')
})

test('官方 CodeBuddy CLI 缺少 esbuild 时返回可解释诊断', async () => {
  const driver = new CodeBuddyCliDriver({
    commandPath: '/opt/homebrew/bin/codebuddy',
    spawnSync: ((_command: string, args: readonly string[]) => {
      if (args.includes('--version')) return { status: 0, stdout: '2.161.1\n', stderr: '' }
      return { status: 1, stdout: '', stderr: "Error: Cannot find module 'esbuild'" }
    }) as never,
  })
  assert.deepEqual(await driver.detect(), { installed: false, version: null, command: null })
  assert.equal(driver.discoveryError, 'CodeBuddy CLI 启动失败：缺少依赖 esbuild，请重新安装 CLI')
})

test('CodeBuddy ACP 将会话、正文、思考和工具事件收敛到公共流', async () => {
  const driver = new CodeBuddyCliDriver({
    binaries: ['fake-codebuddy'],
    spawnSync: detected,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        write(data: string): boolean {
          const request = JSON.parse(data) as { id?: number; method?: string }
          if (request.method === 'session/new') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'codebuddy-session' } })}\n`)
          }
          if (request.method === 'session/prompt') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', text: '检查' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'bash', status: 'running', rawInput: { command: 'pwd' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'bash', status: 'completed', rawOutput: '/work' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'usage_update', used: 1200, size: 8000, cost: { amount: 0.25, currency: '' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成后' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
          }
          if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return true
        },
      }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  assert.equal(driver.supportsToolStepSplitting, true)
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-session', messages: [], prompt: '检查' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'codebuddy-session' },
    { type: 'text-delta', text: '完成', messageId: 'assistant-codebuddy-dsh-session-0' },
    { type: 'reasoning-delta', text: '检查', messageId: 'assistant-codebuddy-dsh-session-0' },
    { type: 'tool-event', toolName: 'bash', callId: 'call-1', input: '{"command":"pwd"}', status: 'running' },
    { type: 'tool-event', toolName: 'bash', callId: 'call-1', output: '/work', outputMode: 'snapshot', status: 'completed' },
    { type: 'usage', inputTokens: 0, outputTokens: 0, contextWindow: 8000, contextTokens: 1200, contextUsageRatio: 0.15 },
    { type: 'text-delta', text: '完成后', messageId: 'assistant-codebuddy-dsh-session-1' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.equal(driver.descriptor.capabilities.includes('permission'), true)
  assert.equal(driver.descriptor.capabilities.includes('questions'), true)
  assert.equal(driver.descriptor.capabilities.includes('usage'), true)
  driver.dispose()
})

test('CodeBuddy ACP 权限请求进入统一事件并回传原始 request id', async () => {
  let promptId = 0
  let reply: Record<string, unknown> | undefined
  const driver = new CodeBuddyCliDriver({
    binaries: ['fake-codebuddy'],
    spawnSync: detected,
    useSidecar: false,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number | string; method?: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'codebuddy-permission' } })}\n`)
        else if (request.method === 'session/prompt') {
          promptId = request.id ?? 0
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'permission-rpc', method: 'session/request_permission', params: { options: [{ optionId: 'allow-custom', kind: 'allow_once' }, { optionId: 'deny-custom', kind: 'reject_once' }], toolCall: { title: '运行命令', toolCallId: 'call-1' }, detail: '需要执行命令' } })}\n`)
        } else if (request.id === 'permission-rpc') {
          reply = request as unknown as Record<string, unknown>
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })}\n`)
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'codebuddy-permission-dsh', messages: [], prompt: '执行' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('codebuddy-permission-dsh', { requestId: chunk.requestId, approved: true })
  }
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'codebuddy-permission' },
    { type: 'permission-request', requestId: 'permission-rpc', kind: '运行命令', toolName: '运行命令', callId: 'call-1', detail: '需要执行命令' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 'permission-rpc', result: { outcome: { outcome: 'selected', optionId: 'allow-custom' } } })
  driver.dispose()
})

test('CodeBuddy JSONL 用量补偿正确拆分 Token、缓存和上下文', () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-codebuddy-usage-'))
  const path = join(root, 'session.jsonl')
  writeFileSync(path, [
    JSON.stringify({ type: 'message', role: 'user', message: { content: '检查' } }),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      providerData: {
        rawUsage: {
          prompt_tokens: 33194,
          completion_tokens: 21,
          total_tokens: 33215,
          prompt_cache_hit_tokens: 9728,
          prompt_cache_miss_tokens: 23466,
        },
      },
      message: { usage: { input_tokens: 33194, output_tokens: 21, total_tokens: 33215, cache_read_input_tokens: 9728 } },
    }),
  ].join('\n'), 'utf8')
  try {
    assert.deepEqual(readCodeBuddyHistoryUsage(path), {
      type: 'usage',
      inputTokens: 33194,
      outputTokens: 21,
      cacheReadTokens: 9728,
      cacheWriteTokens: 23466,
      uncachedInputTokens: 0,
      totalTokens: 33215,
      cacheHitRate: 29.3065,
      contextTokens: 33194,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('WorkBuddy refusal 透传 ACP 错误而不是结束空 assistant', async () => {
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    spawn: fakeAcpSpawn({
      stopReason: 'refusal',
      _meta: {
        'codebuddy.ai/errorMessage': JSON.stringify({ error: { message: '模型服务失败' }, data: { category: 'model_service' } }),
      },
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'refusal-session', messages: [], prompt: '检查' })) chunks.push(chunk)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'error', failure: { message: '模型服务失败', code: 'model_service' } })
  driver.dispose()
})

test('WorkBuddy 空 prompt 响应生成明确错误终态', async () => {
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    spawn: fakeAcpSpawn({}),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'empty-session', messages: [], prompt: '检查' })) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  assert.equal(finish?.reason, 'error')
  assert.match(finish?.failure?.message ?? '', /CODINGNS_PROVIDER_EMPTY_RESPONSE/u)
  driver.dispose()
})

test('WorkBuddy 通知先结束但 prompt 响应为空时仍报告空响应错误', async () => {
  const driver = new WorkBuddyCliDriver({
    platform: 'darwin',
    commandPath: '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
    spawnSync: detected,
    spawn: fakeAcpSpawn({}, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'turn_completed' } },
    }),
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'notification-empty-session', messages: [], prompt: '检查' })) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(chunks.at(-1)?.reason, 'error')
  assert.match(chunks.at(-1)?.failure?.message ?? '', /CODINGNS_PROVIDER_EMPTY_RESPONSE/u)
  driver.dispose()
})
