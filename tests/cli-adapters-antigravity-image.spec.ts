import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PassThrough } from 'node:stream'
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
  readonly sessionId?: string
  readonly sessionState?: Record<string, unknown>
  readonly configuredState?: Record<string, unknown>
  readonly promptUsage?: Record<string, unknown>
}

/** 造一个说 ACP 的 agy 子进程，记录所有客户端请求与命令行。 */
function acpDriver(options: FakeOptions = {}, driverOptions: Record<string, unknown> = {}) {
  const calls: string[][] = []
  const requests: RpcRequest[] = []
  const replies = new Map<number | string, RpcRequest>()
  let killed = 0
  const driver = new AntigravityDriver({
    autoUpdater: { check() {}, dispose() {} },
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.5.9', stderr: '' })) as never,
    resolveContextWindow: () => 1_048_576,
    resolveModelId: () => null,
    resolveEffort: () => null,
    ...driverOptions,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let promptId: number | string = 0
      let pendingServerRequests = [...(options.serverRequests ?? [])]
      const reply = (id: number | string | undefined, result: unknown): void => {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
      }
      const finishPrompt = (): void => {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Red' } } } })}\n`)
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
          const failure = options.failures?.[`${request.method}:${request.params?.configId ?? ''}`]
          if (failure !== undefined) {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: failure })}\n`)
          } else if (request.method === 'initialize') reply(request.id, {})
          else if (request.method === 'session/new' || request.method === 'session/load') reply(request.id, { sessionId: options.sessionId ?? 'agy-acp-session', ...options.sessionState })
          else if (request.method === 'session/set_config_option') reply(request.id, options.configuredState ?? {})
          else if (request.method === 'session/prompt') {
            promptId = request.id ?? 0
            if (pendingServerRequests.length > 0) {
              const [next, ...rest] = pendingServerRequests
              pendingServerRequests = rest
              stdout.write(`${JSON.stringify(next)}\n`)
            } else finishPrompt()
          } else if (request.id !== undefined) reply(request.id, {})
          return true
        },
      }
      return { stdout, stderr, stdin, kill() { killed += 1; stdout.end(); stderr.end(); return true } }
    }) as never,
  } as never)
  return { driver, calls, requests, replies, killed: () => killed }
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
