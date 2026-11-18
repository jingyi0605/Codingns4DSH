import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'

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
        reply(promptId, { stopReason: 'end_turn' })
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
