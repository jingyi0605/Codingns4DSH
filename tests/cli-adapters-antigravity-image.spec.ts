import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { setImmediate as nextTick } from 'node:timers/promises'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { resolveNativeApprovalPermission } from '../src/shared/native-approval-modes.js'

/** 8 字节 PNG 签名足够让内容识别判定为 image/png。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-pixels')])

interface RpcRequest { readonly id?: number | string; readonly method?: string; readonly params?: any; readonly result?: any }

interface FakeOptions {
  /** 对指定方法返回 JSON-RPC 错误，用来模拟 ACP 拒绝未知模型。 */
  readonly failures?: Readonly<Record<string, { readonly code: number; readonly message: string }>>
  /** prompt 期间由服务端主动发给客户端的请求，例如权限或提问。 */
  readonly serverRequests?: readonly Record<string, unknown>[]
  /** 为 true 时，收到 authenticate 之前 session/new 与 session/load 返回 ACP 的 auth_required，模拟 agy 记住了错误的登录方式。 */
  readonly authRequired?: boolean
  /** authenticate 请求本身被拒绝，模拟本机没有可复用的登录。 */
  readonly authenticateFailure?: { readonly code: number; readonly message: string }
  readonly sessionId?: string
  readonly sessionState?: Record<string, unknown>
  readonly configuredState?: Record<string, unknown>
  readonly promptUsage?: Record<string, unknown>
  readonly promptUpdates?: readonly Record<string, unknown>[]
  readonly onPrompt?: (request: RpcRequest, env: NodeJS.ProcessEnv) => Promise<void>
  /** session/load 时重放的历史 session/update：前一半在响应之前，后一半在响应之后（与 agy 实测一致，无任何重放标记）。 */
  readonly loadReplay?: readonly Record<string, unknown>[]
  /** 静默窗口之后才到的重放通知（只含工具调用，复用 loadReplay 里出现过的 toolCallId）。 */
  readonly lateReplay?: readonly Record<string, unknown>[]
}

/** 造一个说 ACP 的 agy 子进程，记录所有客户端请求与命令行。 */
function acpDriver(options: FakeOptions = {}, driverOptions: Record<string, unknown> = {}) {
  const calls: string[][] = []
  const requests: RpcRequest[] = []
  const replies = new Map<number | string, RpcRequest>()
  let killed = 0
  let update = (_body: Record<string, unknown>): void => { throw new Error('ACP process has not started') }
  let exit = (): void => { throw new Error('ACP process has not started') }
  const driver = new AntigravityDriver({
    autoUpdater: { check() {}, dispose() {} },
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.5.9', stderr: '' })) as never,
    resolveContextWindow: () => 1_048_576,
    resolveModelId: () => null,
    resolveEffort: () => null,
    ...driverOptions,
    spawn: ((command: string, args: string[], { env }: { env: NodeJS.ProcessEnv }) => {
      calls.push([command, ...args])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      update = (body) => {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: options.sessionId ?? 'agy-acp-session', update: body } })}\n`)
      }
      exit = () => { stdout.end(); stderr.end() }
      let promptId: number | string = 0
      let promptDelayed = false
      let authenticated = false
      let pendingServerRequests = [...(options.serverRequests ?? [])]
      const reply = (id: number | string | undefined, result: unknown): void => {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
      }
      const finishPrompt = (): void => {
        // 重放场景下让 prompt 持续一段时间，迟到的历史通知才会落进 prompt 监听器。
        if (options.loadReplay !== undefined && !promptDelayed) {
          promptDelayed = true
          setTimeout(finishPrompt, 600)
          return
        }
        for (const body of options.promptUpdates ?? []) update(body)
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Red' } })
        reply(promptId, { stopReason: 'end_turn', usage: options.promptUsage })
      }
      const stdin = {
        write(data: string): boolean {
          const request = JSON.parse(data) as RpcRequest
          if (request.method === undefined) {
            // 客户端对服务端请求的回应。
            if (request.id !== undefined) replies.set(request.id, request)
            if (pendingServerRequests.length > 0) {
              const [next, ...rest] = pendingServerRequests
              pendingServerRequests = rest
              stdout.write(`${JSON.stringify(next)}\n`)
            } else finishPrompt()
            return true
          }
          requests.push(request)
          if (request.method === 'authenticate' && options.authenticateFailure === undefined) authenticated = true
          const failure = options.failures?.[`${request.method}:${request.params?.configId ?? ''}`]
            ?? (request.method === 'authenticate' ? options.authenticateFailure : undefined)
            ?? (options.authRequired === true && !authenticated && (request.method === 'session/new' || request.method === 'session/load')
              ? { code: -32000, message: 'Authentication required' } : undefined)
          if (failure !== undefined) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: failure })}\n`)
          } else if (request.method === 'initialize') reply(request.id, {})
          else if (request.method === 'session/load' && options.loadReplay !== undefined) {
            const half = Math.ceil(options.loadReplay.length / 2)
            options.loadReplay.slice(0, half).forEach(update)
            reply(request.id, { sessionId: options.sessionId ?? 'agy-acp-session', ...options.sessionState })
            // 响应之后重放仍在继续，且比紧随其后的 set_config_option 慢。
            setTimeout(() => options.loadReplay!.slice(half).forEach(update), 30)
            // 超出静默窗口才到的重放：只能靠 toolCallId 识别并丢弃。
            if (options.lateReplay !== undefined) setTimeout(() => options.lateReplay!.forEach(update), 450)
          }
          else if (request.method === 'session/new' || request.method === 'session/load') reply(request.id, { sessionId: options.sessionId ?? 'agy-acp-session', ...options.sessionState })
          else if (request.method === 'session/set_config_option') reply(request.id, options.configuredState ?? {})
          else if (request.method === 'session/prompt') {
            promptId = request.id ?? 0
            if (pendingServerRequests.length > 0) {
              const [next, ...rest] = pendingServerRequests
              pendingServerRequests = rest
              stdout.write(`${JSON.stringify(next)}\n`)
            } else if (options.onPrompt !== undefined) {
              void options.onPrompt(request, env).then(finishPrompt, (error: unknown) => {
                stdout.write(`${JSON.stringify({
                  jsonrpc: '2.0', id: request.id,
                  error: { code: -32603, message: String(error) },
                })}\n`)
              })
            } else finishPrompt()
          } else if (request.id !== undefined) reply(request.id, {})
          return true
        },
      }
      return { stdout, stderr, stdin, kill() { killed += 1; stdout.end(); stderr.end(); return true } }
    }) as never,
  } as never)
  return { driver, calls, requests, replies, killed: () => killed, update: (body: Record<string, unknown>) => update(body), exit: () => exit() }
}

async function collect(driver: AntigravityDriver, input: Record<string, unknown>): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-agy-image', messages: [], prompt: '看图', ...input } as never)) chunks.push(chunk)
  return chunks
}

function withAttachments<T>(run: (paths: { readonly image: string; readonly note: string; readonly dir: string }) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agy-image-spec-'))
  const image = join(dir, 'shot.png')
  const note = join(dir, 'notes.md')
  writeFileSync(image, PNG)
  writeFileSync(note, '# notes')
  return run({ image, note, dir }).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('Antigravity 图片回合走 ACP 内联 image 块，不再只传 @路径', async () => {
  await withAttachments(async ({ image }) => {
    const { driver, calls, requests } = acpDriver()
    const chunks = await collect(driver, {
      modelId: 'gemini-4-hydrogen',
      effortId: 'high',
      permission: { nativeApprovalMode: 'read-only' },
      attachments: [{ kind: 'image', path: image, name: 'shot.png' }],
    })

    assert.deepEqual(calls[0]?.slice(1), ['acp'], 'stream-json 只接受 text 内容块，图片必须走 ACP');
    assert.deepEqual(requests.map(({ method, params }) => ({ method, configId: params?.configId, value: params?.value, modeId: params?.modeId })), [
      { method: 'initialize', configId: undefined, value: undefined, modeId: undefined },
      { method: 'initialized', configId: undefined, value: undefined, modeId: undefined },
      { method: 'session/new', configId: undefined, value: undefined, modeId: undefined },
      { method: 'session/set_config_option', configId: 'model', value: 'gemini-4-hydrogen', modeId: undefined },
      { method: 'session/set_config_option', configId: 'thought_level', value: 'high', modeId: undefined },
      { method: 'session/set_mode', configId: undefined, value: undefined, modeId: 'plan' },
      { method: 'session/prompt', configId: undefined, value: undefined, modeId: undefined },
    ])
    const prompt = requests.find((request) => request.method === 'session/prompt')!.params.prompt
    assert.deepEqual(prompt, [
      { type: 'text', text: '看图' },
      { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
    ])
    assert.equal(JSON.stringify(prompt).includes('@'), false, '图片不应再以 @路径 形式出现在文本里')
    assert.deepEqual(chunks.filter((chunk) => chunk.type === 'session-binding'), [{ type: 'session-binding', providerSessionId: 'agy-acp-session' }])
    assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'Red'), true)
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.equal(chunks.at(-1)?.reason, 'stop')
  })
})

test('Antigravity 图片回合恢复会话用 session/load，并在回合结束后关闭 ACP 进程', async () => {
  await withAttachments(async ({ image }) => {
    const { driver, requests, killed } = acpDriver({ sessionId: 'agy-existing-conversation' })
    await collect(driver, {
      modelId: 'gemini-4-hydrogen',
      providerSessionId: 'agy-existing-conversation',
      attachments: [{ kind: 'image', path: image }],
    })
    const load = requests.find((request) => request.method === 'session/load')
    assert.equal(load?.params.sessionId, 'agy-existing-conversation')
    assert.equal(requests.some((request) => request.method === 'session/new'), false)
    assert.equal(killed(), 1, 'Agy ACP 带完整 Language Server，不能为图片回合留下常驻进程')
  })
})

const backgroundCommand = {
  sessionUpdate: 'tool_call', toolCallId: 'background-command', name: 'run_command', kind: 'execute', status: 'in_progress',
  rawInput: { CommandLine: 'Start-Sleep -Seconds 15', WaitMsBeforeAsync: 1000 },
}
const completedCommand = {
  ...backgroundCommand, sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'Command exited with code 0.',
}
const acpPermission = { permission: { nativeApprovalMode: 'manual' } }

test('Antigravity ACP 保留后台命令结果和后续正文，最后只发送一个终态', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { driver, requests, update, killed } = acpDriver({ promptUpdates: [backgroundCommand] })
  const turn = collect(driver, acpPermission)
  try {
    await nextTick()
    assert.equal(killed(), 0)
    update(completedCommand)
    await nextTick()
    context.mock.timers.tick(25_000)
    await nextTick()
    assert.equal(killed(), 0)

    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Background output' } })
    await nextTick()
    context.mock.timers.tick(9_000)
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' arrived' } })
    await nextTick()
    context.mock.timers.tick(1_000)
    await nextTick()
    assert.equal(killed(), 0)
    context.mock.timers.tick(9_000)

    const relevant = (await turn).filter(({ type }) => type === 'text-delta' || type === 'tool-event' || type === 'finish')
    assert.deepEqual(relevant.map(({ type, text, status, reason }) => [type, text ?? status ?? reason]), [
      ['tool-event', 'running'], ['text-delta', 'Red'], ['tool-event', 'completed'],
      ['text-delta', 'Background output'], ['text-delta', ' arrived'], ['finish', 'stop'],
    ])
    assert.equal(killed(), 1)
    assert.equal(requests.filter(({ method }) => method === 'session/prompt').length, 1)
  } finally {
    driver.dispose()
    await turn
  }
})

test('Antigravity ACP 等待后台命令时能取消或处理进程退出', async () => {
  for (const reason of ['cancel', 'error'] as const) {
    const controller = new AbortController()
    const { driver, requests, exit, killed } = acpDriver({ promptUpdates: [backgroundCommand] })
    const turn = collect(driver, { ...acpPermission, signal: controller.signal })
    try {
      await nextTick()
      assert.equal(killed(), 0)
      if (reason === 'cancel') controller.abort()
      else exit()
      const chunks = await turn
      assert.deepEqual(chunks.filter(({ type }) => type === 'finish').map(chunk => chunk.reason), [reason])
      if (reason === 'cancel') {
        assert.equal(requests.some(({ method }) => method === 'session/cancel'), true)
        assert.equal(killed(), 1)
      }
    } finally {
      controller.abort()
      driver.dispose()
      await turn
    }
  }
})

test('Antigravity ACP 不等待守护命令或已经结束的命令', async () => {
  for (const promptUpdates of [
    [{ ...backgroundCommand, rawInput: { ...backgroundCommand.rawInput, IsDaemon: true } }],
    [backgroundCommand, completedCommand],
  ]) {
    const { driver, killed } = acpDriver({ promptUpdates })
    const controller = new AbortController()
    const turn = collect(driver, { ...acpPermission, signal: controller.signal })
    try {
      await nextTick()
      assert.equal(killed(), 1)
      assert.equal((await turn).at(-1)?.reason, 'stop')
    } finally {
      controller.abort()
      driver.dispose()
      await turn
    }
  }
})

test('Antigravity session/load 重放的历史不会进入本回合，避免旧消息出现在最新消息下面', async () => {
  await withAttachments(async ({ image }) => {
    const replayTool = (id: string, path: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, name: 'read_file', args: { Path: path }, status: 'completed', kind: 'read', title: path, rawInput: { Path: path }, rawOutput: 'old' })
    const { driver } = acpDriver({
      sessionId: 'agy-existing-conversation',
      loadReplay: [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old user prompt' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'old reasoning' } },
        replayTool('call_old_1', '/old/one.md'),
        replayTool('call_old_2', '/old/two.md'),
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } },
        replayTool('call_old_3', '/old/three.md'),
      ],
      lateReplay: [replayTool('call_old_3', '/old/three.md')],
    })
    const chunks = await collect(driver, {
      modelId: 'gemini-4-hydrogen',
      providerSessionId: 'agy-existing-conversation',
      attachments: [{ kind: 'image', path: image }],
    })
    const serialized = JSON.stringify(chunks)
    for (const stale of ['call_old_1', 'call_old_2', 'call_old_3', 'old user prompt', 'old reasoning', 'old answer', '/old/']) {
      assert.equal(serialized.includes(stale), false, `重放的历史 ${stale} 不能进入本回合`)
    }
    assert.equal(serialized.includes('Red'), true, '本回合真实输出必须保留')
  })
})

test('Antigravity 新建会话不等待重放静默窗口', async () => {
  await withAttachments(async ({ image }) => {
    const { driver } = acpDriver()
    const started = Date.now()
    await collect(driver, { modelId: 'gemini-4-hydrogen', attachments: [{ kind: 'image', path: image }] })
    assert.ok(Date.now() - started < 250, 'session/new 没有历史可重放，不应额外等待')
  })
})

test('Antigravity 图片回合：全放行用进程参数，普通文件保留 @路径 并授权其目录', async () => {
  await withAttachments(async ({ image, note, dir }) => {
    const { driver, calls, requests } = acpDriver()
    await collect(driver, {
      modelId: 'gemini-4-hydrogen',
      permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
      attachments: [{ kind: 'image', path: image }, { kind: 'file', path: note, name: 'notes.md' }],
    })
    assert.deepEqual(calls[0]?.slice(1), ['acp', '--dangerously-skip-permissions', '--add-dir', dir])
    assert.equal(requests.some((request) => request.method === 'session/set_mode'), false)
    const prompt = requests.find((request) => request.method === 'session/prompt')!.params.prompt as Array<Record<string, unknown>>
    assert.equal(prompt.filter((block) => block.type === 'image').length, 1)
    assert.equal(prompt.filter((block) => block.type === 'resource_link').length, 0, '普通文件仍按 stream-json 的 @路径 方式引用')
    assert.match(String(prompt[0]?.text), new RegExp(note.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  })
})

test('Antigravity 图片回合：Claude 不下发思考档位，provider-default 读取设置里的模型和档位', async () => {
  await withAttachments(async ({ image }) => {
    const claude = acpDriver()
    await collect(claude.driver, { modelId: 'claude-sonnet-5-5', effortId: 'high', attachments: [{ kind: 'image', path: image }] })
    assert.deepEqual(claude.requests.filter((request) => request.method === 'session/set_config_option').map((request) => request.params.configId), ['model'])

    const defaults = acpDriver({}, { resolveModelId: () => 'gemini-4-hydrogen', resolveEffort: () => 'high' })
    await collect(defaults.driver, { modelId: 'provider-default', attachments: [{ kind: 'image', path: image }] })
    assert.deepEqual(defaults.requests.filter((request) => request.method === 'session/set_config_option').map(({ params }) => [params.configId, params.value]), [
      ['model', 'gemini-4-hydrogen'],
      ['thought_level', 'high'],
    ])
  })
})

test('Antigravity 用内置 Gemini ID 建立和恢复 ACP 会话，把图片转到指定 Magpie 模型', async (t) => {
  const modelId = 'magpie/agy-cli/gemini-4-neon'
  const apiKey = 'fixture-agy-key'
  const received: Array<{ path: string | undefined; key: string | string[] | undefined; session: string | string[] | undefined; body: unknown }> = []
  const gateway = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString('utf8'))
    received.push({ path: req.url, key: req.headers['x-goog-api-key'], session: req.headers['x-magpie-session'], body })
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {}\n\n')
  })
  gateway.listen(0, '127.0.0.1')
  await once(gateway, 'listening')
  t.after(() => { gateway.closeAllConnections(); gateway.close() })
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`
  const stdout = [`model=${modelId}`, `GEMINI_API_KEY=${apiKey}`, `GOOGLE_GEMINI_BASE_URL=${gatewayUrl}`].join('\n')
  const { driver, requests } = acpDriver({
    configuredState: { configOptions: [{ id: 'model', currentValue: 'gemini-4-neon' }] },
    async onPrompt(request, env) {
      const [text, image] = request.params.prompt
      const body = { contents: [{ role: 'user', parts: [{ text: text.text }, { inlineData: { mimeType: image.mimeType, data: image.data } }] }] }
      const response = await fetch(`${env.GOOGLE_GEMINI_BASE_URL}/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse`, {
        method: 'POST', headers: { 'x-goog-api-key': env.GOOGLE_API_KEY!, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      assert.equal(env.GEMINI_API_KEY, apiKey)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'data: {}\n\n')
    },
  }, {
    magpieCommand: () => 'fixture-magpie',
    spawnSync: (command: string) => ({ status: 0, stdout: command === 'fixture-magpie' ? stdout : 'agy 1.5.14', stderr: '' }),
    readRequestSamples: () => null,
  })
  t.after(() => driver.dispose())
  await withAttachments(async ({ image }) => {
    const permission = resolveNativeApprovalPermission({ adapterId: 'antigravity', nativeApprovalMode: 'manual' }, undefined)
    const turn = {
      permission, attachments: [{ kind: 'image', path: image }],
      runtimeEnv: { GEMINI_API_KEY: 'inherited-key', GOOGLE_API_KEY: 'inherited-key', GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:1' },
    }
    assert.equal((await collect(driver, { ...turn, modelId })).at(-1)?.reason, 'stop')
    assert.equal((await collect(driver, { ...turn, modelId: 'provider-default', providerSessionId: 'agy-acp-session' })).at(-1)?.reason, 'stop')
  })
  const methods = ['initialize', 'initialized', 'authenticate', 'session/new', 'session/set_config_option', 'session/set_mode', 'session/prompt']
  assert.deepEqual(requests.map(({ method }) => method), [...methods, ...methods.map(method => method === 'session/new' ? 'session/load' : method)])
  assert.deepEqual(requests.filter(({ method }) => method === 'authenticate').map(({ params }) => params.methodId), ['gemini-api-key', 'gemini-api-key'])
  assert.deepEqual(requests.filter(({ method }) => method === 'session/set_config_option').map(({ params }) => params.value), ['gemini-4-neon', 'gemini-4-neon'])
  assert.deepEqual(requests.filter(({ method }) => method === 'session/set_mode').map(({ params }) => params.modeId), ['default', 'default'])
  const expected = {
    path: '/v1beta/models/agy-cli/gemini-4-neon:streamGenerateContent?alt=sse',
    key: apiKey, session: 'dsh-agy-image',
    body: { contents: [{ role: 'user', parts: [{ text: '看图' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] }] },
  }
  assert.deepEqual(received, [expected, expected])
})

test('Antigravity 的其他 Magpie 模型在人工审批或有图片时仍由 ACP 校验', async () => {
  const modelId = 'magpie/auto/deepseek-v4.1-flash-1017'
  const settings = '/tmp/magpie-agy-settings.json'
  const stdout = [`model=${modelId}`, `settings=${settings}`, 'GEMINI_API_KEY=fixture', 'GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:1'].join('\n')
  await withAttachments(async ({ image }) => {
    for (const nativeApprovalMode of ['manual', 'full-access'] as const) {
      const { driver, calls, requests } = acpDriver({
        failures: { 'session/set_config_option:model': { code: -32602, message: 'Unknown model ID' } },
      }, {
        magpieCommand: () => 'fixture-magpie',
        spawnSync: (command: string) => ({ status: 0, stdout: command === 'fixture-magpie' ? stdout : 'agy 1.5.14', stderr: '' }),
      })
      const permission = resolveNativeApprovalPermission({ adapterId: 'antigravity', nativeApprovalMode }, undefined)
      try {
        await assert.rejects(collect(driver, {
          modelId, permission,
          ...(nativeApprovalMode === 'full-access' ? { attachments: [{ kind: 'image', path: image }] } : {}),
        }), /Unknown model ID/u)
        assert.deepEqual(calls[0]?.slice(1, 4), ['--settings', settings, 'acp'])
        assert.equal(requests.some(({ method }) => method === 'authenticate' || method === 'session/prompt'), false)
        assert.equal(requests.find(({ method }) => method === 'session/set_config_option')?.params.value, modelId)
      } finally { driver.dispose() }
    }
  })
})

test('Antigravity 图片回合：无法确认选定模型时明确报错，图片和提示词均未发送', async () => {
  await withAttachments(async ({ image }) => {
    const failures = { 'session/set_config_option:model': { code: -32602, message: 'Unknown model ID' } }
    const custom = 'magpie/antigravity-bridge/gemini-4-hydrogen'
    const otherModel = { models: { currentModelId: 'other', availableModels: [{ modelId: custom, name: custom }] } }
    for (const [modelId, options] of [
      ['nope', { failures }],
      [custom, { failures }],
      [custom, { failures, sessionState: otherModel }],
      [custom, { configuredState: otherModel }],
    ] as const) {
      const { driver, requests } = acpDriver(options)
      await assert.rejects(collect(driver, { modelId, attachments: [{ kind: 'image', path: image }] }), (error: Error) => error.message.includes(modelId))
      assert.equal(requests.filter(request => request.method === 'session/prompt').length, 0)
    }
  })
})

test('Antigravity 图片回合：ACP 拒绝设置时，新建或恢复的会话确认 Magpie 当前模型后可以发送', async () => {
  await withAttachments(async ({ image }) => {
    const modelId = 'magpie/antigravity-bridge/gemini-4-hydrogen'
    const failures = { 'session/set_config_option:model': { code: -32602, message: 'Unknown model ID' } }
    for (const [providerSessionId, sessionState] of [
      [undefined, { configOptions: [{ id: 'model', currentValue: modelId }] }],
      ['agy-acp-session', { models: { currentModelId: modelId } }],
    ] as const) {
      const { driver, requests } = acpDriver({ failures, sessionState })
      const chunks = await collect(driver, { modelId, providerSessionId, attachments: [{ kind: 'image', path: image }] })
      assert.equal(chunks.at(-1)?.reason, 'stop')
      assert.equal(requests.filter(request => request.method === 'session/prompt').length, 1)
    }
  })
})

test('Antigravity 图片回合：权限请求自动拒绝、提问直接取消，不会挂起等待 DSH', async () => {
  await withAttachments(async ({ image }) => {
    const { driver, replies } = acpDriver({
      serverRequests: [
        { jsonrpc: '2.0', id: 91, method: 'session/request_permission', params: {
          options: [{ optionId: 'allow-1', kind: 'allow_once' }, { optionId: 'reject-1', kind: 'reject_once' }],
          toolCall: { kind: 'execute', toolCallId: 'tool-1', title: 'run_command' },
        } },
        { jsonrpc: '2.0', id: 92, method: 'elicitation/create', params: { mode: 'form', message: '选一个' } },
      ],
    })
    const chunks = await collect(driver, { modelId: 'gemini-4-hydrogen', attachments: [{ kind: 'image', path: image }] })
    assert.deepEqual(replies.get(91)?.result, { outcome: { outcome: 'selected', optionId: 'reject-1' } })
    assert.deepEqual(replies.get(92)?.result, { action: 'cancel' })
    assert.equal(chunks.some((chunk) => chunk.type === 'permission-request' || chunk.type === 'question-request'), false)
    assert.equal(chunks.at(-1)?.reason, 'stop')
  })
})

test('Antigravity forwards the actual agy form and returns its choice and optional free text', async () => {
  const { driver, replies } = acpDriver({ serverRequests: [{ jsonrpc: '2.0', id: 42, method: 'elicitation/create', params: {
    mode: 'form', message: 'The agent has a question.', requestedSchema: { type: 'object', properties: {
      q1: { type: 'string', title: 'Pick a color', oneOf: [{ const: '2', title: 'Blue' }] }, q1_other: { type: 'string', title: 'Other' },
    } },
  } }] })
  try {
    for await (const event of driver.executeTurn({ sessionId: 'questions', messages: [], prompt: 'Test', permission: { nativeApprovalMode: 'manual' } })) {
      if (event.type !== 'question-request') continue
      assert.deepEqual(event.questions.map(question => question.question), ['Pick a color'])
      driver.respondQuestion('questions', { requestId: event.requestId, answers: [{ id: 'q1', selected: ['Blue'], custom: 'Sky blue' }] })
    }
    assert.deepEqual(replies.get(42)?.result, { action: 'accept', content: { q1: '2', q1_other: 'Sky blue' } })
  } finally { driver.dispose() }
})

const commandApproval = {
  jsonrpc: '2.0', id: 91, method: 'session/request_permission', params: {
    sessionId: 'agy-acp-session',
    options: [
      { optionId: 'approve-always', kind: 'allow_always' }, { optionId: 'deny-always', kind: 'reject_always' },
      { optionId: 'approve-this-command', kind: 'allow_once' }, { optionId: 'deny-this-command', kind: 'reject_once' },
    ],
    toolCall: { kind: 'execute', toolCallId: 'tool-1', title: 'run_command', rawInput: { CommandLine: 'Write-Output approval-probe' } },
  },
}

for (const [mode, modeId, decision, optionId] of [
  ['manual', 'default', 'allowed-once', 'approve-this-command'],
  ['accept-edits', 'accept-edits', 'rejected', 'deny-this-command'],
  ['read-only', 'plan', 'cancelled', undefined],
] as const) {
  test(`Antigravity text ${mode} returns DSH approval decision ${decision} through ACP`, { timeout: 5_000 }, async () => {
    const { driver, calls, requests, replies, killed } = acpDriver({ serverRequests: [commandApproval] })
    const sessionId = 'agy-dsh-approval'
    const registry = new CodingNsCliAdapterRegistry([driver], {})
    const controller = new AbortController()
    const config = { adapterId: 'antigravity', nativeApprovalMode: mode } as const
    const permission = resolveNativeApprovalPermission(config, { sandboxMode: 'danger-full-access', approvalPolicy: 'never' })!
    registry.setSession(sessionId, config)
    const projector = new CodingNsDshMessageProjector({
      adapterId: 'antigravity', sessionId, permission, signal: controller.signal,
      nativeSessions: { async requestApproval(seenSessionId, request) {
        assert.equal(seenSessionId, sessionId)
        assert.equal(replies.size, 0)
        assert.equal(request.reason, 'Write-Output approval-probe')
        assert.equal(request.callId, 'tool-1')
        if (decision === 'cancelled') controller.abort()
        return decision
      } },
      respondPermission: response => registry.respondPermission(sessionId, response),
    })
    try {
      const events = []
      for await (const event of registry.execute({ adapterId: 'antigravity', sessionId, messages: [], prompt: 'Test approval', permission, signal: controller.signal, providerSessionId: 'agy-acp-session' })) {
        events.push(event)
        await projector.push(event)
      }
      assert.deepEqual(calls.map(args => args.slice(1)), [['acp']])
      assert.equal(requests.find(request => request.method === 'session/set_mode')?.params.modeId, modeId)
      assert.equal(requests.find(request => request.method === 'session/load')?.params.sessionId, 'agy-acp-session')
      assert.equal(requests.filter(request => request.method === 'session/prompt').length, 1)
      assert.deepEqual(replies.get(91)?.result, { outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } })
      assert.deepEqual(events.filter(event => event.type === 'finish').map(event => event.reason), [decision === 'cancelled' ? 'cancel' : 'stop'])
      assert.equal(killed(), 1)
    } finally { registry.dispose() }
  })
}

test('Antigravity does not select a permanent grant when ACP has no one-time approval option', { timeout: 5_000 }, async () => {
  const request = { ...commandApproval, params: { ...commandApproval.params, options: commandApproval.params.options.slice(0, 2) } }
  const { driver, replies } = acpDriver({ serverRequests: [request] })
  try {
    for await (const event of driver.executeTurn({ sessionId: 'agy-no-once', messages: [], prompt: 'Test approval', permission: { nativeApprovalMode: 'manual', approvalPolicy: 'ask' } })) {
      if (event.type === 'permission-request') driver.respondPermission('agy-no-once', { requestId: event.requestId, approved: true })
    }
    assert.deepEqual(replies.get(91)?.result, { outcome: { outcome: 'cancelled' } })
  } finally { driver.dispose() }
})

test('Antigravity reports why DSH rejected a command when the session disables prompts', { timeout: 5_000 }, async () => {
  const { driver, replies, killed } = acpDriver({ serverRequests: [commandApproval] })
  const sessionId = 'agy-dsh-approval-disabled'
  const registry = new CodingNsCliAdapterRegistry([driver], {})
  const config = { adapterId: 'antigravity', nativeApprovalMode: 'manual' } as const
  const permission = resolveNativeApprovalPermission(config, { approvalPolicy: 'never' })!
  registry.setSession(sessionId, config)
  let approvalCount = 0
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'antigravity', sessionId, permission,
    nativeSessions: { async requestApproval() { approvalCount += 1; return 'policy-rejected' } },
    respondPermission: response => registry.respondPermission(sessionId, response),
  })
  try {
    const chunks = []
    for await (const event of registry.execute({ ...config, sessionId, messages: [], prompt: 'Test approval', permission })) {
      chunks.push(...await projector.push(event))
      if (projector.isFinished) break
    }
    assert.equal(approvalCount, 1)
    assert.deepEqual(replies.get(91)?.result, { outcome: { outcome: 'selected', optionId: 'deny-this-command' } })
    assert.match(JSON.stringify(chunks), /DSH 已自动拒绝 agy 的工具请求.*选择 agy 模式/u)
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'finish').map(chunk => (chunk.reason as { kind: string }).kind), ['error'])
    assert.equal(killed(), 1)
  } finally { registry.dispose() }
})

test('Antigravity stops before sending the prompt when ACP rejects auto mode', async () => {
  const { driver, requests } = acpDriver({ failures: { 'session/set_mode:': { code: -32602, message: 'Auto mode unavailable' } } })
  try {
    await assert.rejects(collect(driver, { permission: { nativeApprovalMode: 'auto-review', approvalPolicy: 'ask' } }), { code: 'AGY_AUTO_MODE_UNAVAILABLE' })
    assert.equal(requests.some(request => request.method === 'session/prompt'), false)
  } finally { driver.dispose() }
})

test('Antigravity ACP counts uncached input separately from cache reads', async () => {
  const { driver } = acpDriver({ promptUsage: { inputTokens: 2_372, outputTokens: 141, cachedReadTokens: 7_053, totalTokens: 9_566 } })
  try {
    const events = await collect(driver, { permission: { nativeApprovalMode: 'manual', approvalPolicy: 'ask' } })
    const usage = events.find(event => event.type === 'usage')
    assert.equal(usage.uncachedInputTokens, 2_372)
    assert.equal(usage.cacheReadTokens, 7_053)
    assert.equal(usage.totalTokens, 9_566)
    assert.equal(usage.cacheHitRate, 74.8329)
  } finally { driver.dispose() }
})

test('Antigravity 没有图片附件时继续走 stream-json，不启动 ACP', async () => {
  await withAttachments(async ({ note }) => {
    const calls: string[][] = []
    const driver = new AntigravityDriver({
      autoUpdater: { check() {}, dispose() {} },
      binaries: ['fake-agy'],
      spawnSync: (() => ({ status: 0, stdout: 'agy 1.5.9', stderr: '' })) as never,
      resolveContextWindow: () => undefined,
      resolveModelId: () => null,
      spawn: ((command: string, args: string[]) => {
        calls.push([command, ...args])
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const stdin = {
          end(): void {
            queueMicrotask(() => {
              stdout.write(`${JSON.stringify({ event: 'result', result: { conversation_id: 'agy-stream', status: 'SUCCESS', response: 'OK' } })}\n`)
              stdout.end(); stderr.end()
            })
          },
        }
        return { stdout, stderr, stdin, kill() { return true } }
      }) as never,
    })
    await collect(driver, { modelId: 'gemini-4-hydrogen', attachments: [{ kind: 'file', path: note, name: 'notes.md' }] })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.includes('acp'), false)
    assert.deepEqual(calls[0]?.slice(1, 5), ['--input-format', 'stream-json', '--output-format', 'stream-json'])
  })
})

test('Antigravity 图片回合：DSH 附件存储的无后缀对象按内容识别 MIME', async () => {
  await withAttachments(async ({ dir }) => {
    // DSH 附件库用内容哈希当文件名，没有后缀；声明的 MIME 也可能是错的。
    const path = join(dir, '42e1a977e447f19b9123260c4f17cbb8572bd4ca7847328eb12d7cf0e051c294')
    writeFileSync(path, PNG)
    const { driver, requests } = acpDriver()
    await collect(driver, { modelId: 'gemini-4-hydrogen', attachments: [{ kind: 'image', path, name: 'wrong.jpg', mimeType: 'image/jpeg' }] })
    const prompt = requests.find((request) => request.method === 'session/prompt')!.params.prompt as Array<Record<string, unknown>>
    assert.deepEqual(prompt.at(-1), { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' })
  })
})

test('Antigravity 完全访问自动放行 ACP 审批，不再弹出审批面板', { timeout: 5_000 }, async () => {
  const { driver, calls, replies } = acpDriver({ serverRequests: [commandApproval] })
  const config = { adapterId: 'antigravity', nativeApprovalMode: 'full-access' } as const
  const permission = resolveNativeApprovalPermission(config, undefined)!
  try {
    const chunks = await collect(driver, { sessionId: 'agy-full-access', prompt: 'Test approval', permission, providerSessionId: 'agy-acp-session' })
    assert.ok(calls[0]?.includes('--dangerously-skip-permissions'))
    assert.deepEqual(replies.get(91)?.result, { outcome: { outcome: 'selected', optionId: 'approve-this-command' } })
    assert.equal(chunks.some(chunk => chunk.type === 'permission-request'), false)
    assert.equal(chunks.at(-1)?.reason, 'stop')
  } finally { driver.dispose() }
})

test('Antigravity ACP 回合结算前把新增模型调用的耗时和上下文交给 DSH', { timeout: 5_000 }, async () => {
  const reads: (number | 'latest')[] = []
  const { driver } = acpDriver({}, {
    readRequestSamples: (_id: string, after: number | 'latest') => {
      reads.push(after)
      if (after === 'latest') return { samples: [{ stepIndex: 4, startedAt: 100, completedAt: 900, outputTokens: 40, contextTokens: 3_000 }], lastStepIndex: 4 }
      return after === 4
        ? { samples: [{ stepIndex: 5, startedAt: 1_000, completedAt: 3_000, outputTokens: 200, contextTokens: 5_000 }], lastStepIndex: 5 }
        : { samples: [], lastStepIndex: after }
    },
  })
  try {
    const chunks = await collect(driver, {
      sessionId: 'agy-performance', permission: { nativeApprovalMode: 'manual', approvalPolicy: 'ask' }, providerSessionId: 'agy-acp-session',
    })
    const observations = chunks.filter(chunk => chunk.type === 'usage-observation')
    // 续聊：回合一开始先给出上一次调用的上下文量（不带耗时），圆环不必等到回合结束。
    assert.deepEqual(observations.shift(), {
      type: 'usage-observation',
      contextTokens: 3_000, contextWindow: 1_048_576, contextUsageRatio: Number((3_000 / 1_048_576).toFixed(6)),
    })
    assert.ok(chunks.findIndex(chunk => chunk.type === 'usage-observation') > chunks.findIndex(chunk => chunk.type === 'text-delta'))
    assert.deepEqual(observations, [{
      type: 'usage-observation',
      requestPerformance: { adapterId: 'antigravity', id: 'agy-acp-session:5', samples: [
        { id: 'agy-acp-session:5', startedAt: 1_000, firstTokenAt: 1_000, completedAt: 3_000, outputTokens: 200 },
      ] },
      contextTokens: 5_000, contextWindow: 1_048_576, contextUsageRatio: Number((5_000 / 1_048_576).toFixed(6)),
    }])
    assert.equal(reads[0], 'latest')
    assert.ok(chunks.indexOf(observations[0]) < chunks.findIndex(chunk => chunk.type === 'finish'))
  } finally { driver.dispose() }
})

const nativeAuthTurn = (image: string, extra: Record<string, unknown> = {}) => ({
  modelId: 'gemini-4-hydrogen',
  permission: { nativeApprovalMode: 'read-only' },
  attachments: [{ kind: 'image', path: image }],
  ...extra,
})

test('Antigravity 原生回合静默登录被拒时，补一次 oauth-personal 认证后重试 session/new', async () => {
  await withAttachments(async ({ image }) => {
    const { driver, requests } = acpDriver({ authRequired: true })
    try {
      const chunks = await collect(driver, nativeAuthTurn(image))
      assert.deepEqual(requests.map(({ method }) => method), [
        'initialize', 'initialized', 'session/new', 'authenticate', 'session/new',
        'session/set_config_option', 'session/set_mode', 'session/prompt',
      ])
      assert.deepEqual(requests.filter(({ method }) => method === 'authenticate').map(({ params }) => params.methodId), ['oauth-personal'])
      assert.equal(chunks.at(-1)?.reason, 'stop')
    } finally { driver.dispose() }
  })
})

test('Antigravity 原生回合恢复会话时静默登录被拒，同样认证后重试 session/load', async () => {
  await withAttachments(async ({ image }) => {
    const { driver, requests } = acpDriver({ authRequired: true, sessionId: 'agy-existing-conversation' })
    try {
      const chunks = await collect(driver, nativeAuthTurn(image, { providerSessionId: 'agy-existing-conversation' }))
      assert.deepEqual(requests.map(({ method }) => method).slice(0, 5), ['initialize', 'initialized', 'session/load', 'authenticate', 'session/load'])
      assert.equal(requests.filter(({ method }) => method === 'session/new').length, 0)
      assert.equal(chunks.at(-1)?.reason, 'stop')
    } finally { driver.dispose() }
  })
})

test('Antigravity 原生回合静默登录正常时不发 authenticate，避免改动用户已有的登录方式', async () => {
  await withAttachments(async ({ image }) => {
    const { driver, requests } = acpDriver()
    try {
      await collect(driver, nativeAuthTurn(image))
      assert.equal(requests.some(({ method }) => method === 'authenticate'), false)
    } finally { driver.dispose() }
  })
})

test('Antigravity 补发的认证也失败时，提示重新登录且不发送 prompt', async () => {
  await withAttachments(async ({ image }) => {
    const { driver, requests } = acpDriver({ authRequired: true, authenticateFailure: { code: -32000, message: 'No stored credentials' } })
    try {
      await assert.rejects(collect(driver, nativeAuthTurn(image)), /登录已失效.*agy.*No stored credentials/u)
      assert.equal(requests.filter(({ method }) => method === 'authenticate').length, 1)
      assert.equal(requests.filter(({ method }) => method === 'session/new').length, 1)
      assert.equal(requests.some(({ method }) => method === 'session/prompt'), false)
    } finally { driver.dispose() }
  })
})

test('Antigravity 的非认证错误不触发补认证，原样抛出', async () => {
  await withAttachments(async ({ image }) => {
    const { driver, requests } = acpDriver({ failures: { 'session/new:': { code: -32603, message: 'workspace unavailable' } } })
    try {
      await assert.rejects(collect(driver, nativeAuthTurn(image)), /workspace unavailable/u)
      assert.equal(requests.some(({ method }) => method === 'authenticate'), false)
    } finally { driver.dispose() }
  })
})

test('Antigravity 的 Magpie 回合认证被拒时不改用本机 Google 登录', async () => {
  const modelId = 'magpie/auto/deepseek-v4.1-flash-1017'
  const stdout = [`model=${modelId}`, 'settings=/tmp/magpie-agy-settings.json', 'GEMINI_API_KEY=fixture', 'GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:1'].join('\n')
  const { driver, requests } = acpDriver({ authRequired: true }, {
    magpieCommand: () => 'fixture-magpie',
    spawnSync: (command: string) => ({ status: 0, stdout: command === 'fixture-magpie' ? stdout : 'agy 1.5.14', stderr: '' }),
  })
  try {
    const permission = resolveNativeApprovalPermission({ adapterId: 'antigravity', nativeApprovalMode: 'manual' }, undefined)
    await assert.rejects(collect(driver, { modelId, permission }), /Authentication required/u)
    assert.equal(requests.some(({ method }) => method === 'authenticate'), false)
  } finally { driver.dispose() }
})
