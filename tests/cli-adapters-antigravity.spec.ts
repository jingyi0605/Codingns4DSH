import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'

/**
 * 造一个只回放固定 NDJSON 的 agy 子进程；每次调用消费一组输出行。
 *
 * 关闭上下文窗口解析，保证断言只针对线协议投影，不依赖本机 AGY 设置文件。
 */
function scriptedDriver(
  turns: readonly (readonly Record<string, unknown>[])[],
  options: { readonly contextWindow?: number; readonly modelId?: string | null } = {},
) {
  const calls: string[][] = []
  const inputs: string[] = []
  let index = 0
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.17', stderr: '' })) as never,
    resolveContextWindow: options.contextWindow === undefined ? () => undefined : () => options.contextWindow,
    // 默认按 Gemini 口径（input_tokens 含缓存）；Claude 口径由用例显式指定。
    resolveModelId: () => options.modelId ?? null,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const lines = turns[Math.min(index, turns.length - 1)] ?? []
      index += 1
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let emitted = false
      const stdin = {
        end(value?: string): void {
          if (value !== undefined) inputs.push(value)
          if (emitted) return
          emitted = true
          queueMicrotask(() => {
            for (const line of lines) stdout.write(`${JSON.stringify(line)}\n`)
            stdout.end()
            stderr.end()
          })
        },
      }
      return { stdout, stderr, stdin, kill() { return true } }
    }) as never,
  })
  return { driver, calls, inputs }
}

async function collect(driver: AntigravityDriver, input: Record<string, unknown>): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of driver.executeTurn({ sessionId: 'agy-session', messages: [], prompt: '你好', ...input } as never)) chunks.push(chunk)
  return chunks
}

function stepUpdate(payload: Record<string, unknown>): Record<string, unknown> {
  return { event: 'step_update', step_update: { conversation_id: 'agy-provider-session', ...payload } }
}

function magpieDriver(readEnv: () => { status: number; stdout: string }, options: { command?: () => string | null } = {}) {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = []
  const envCalls: string[][] = []
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    magpieCommand: options.command ?? (() => 'custom-magpie'),
    resolveContextWindow: () => undefined,
    resolveModelId: () => null,
    spawnSync: ((command: string, args: string[]) => {
      if (command === 'custom-magpie') {
        envCalls.push([command, ...args])
        return { ...readEnv(), stderr: '' }
      }
      return { status: 0, stdout: 'agy 1.4.12', stderr: '' }
    }) as never,
    spawn: ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env })
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
        kill() { return true },
      })
      if (args.at(-1) === 'models') queueMicrotask(() => {
        const configured = options.env.GEMINI_API_KEY === 'test-magpie-key' && args.includes('--settings')
        child.stdout.end(configured ? 'magpie/hl/gpt-6-astra\tGPT-6 Astra\n' : '')
        child.stderr.end()
        child.emit('close', configured ? 0 : 1)
      })
      else child.stdin.once('finish', () => {
        child.stdout.end(`${JSON.stringify(resultEvent(undefined))}\n`)
        child.stderr.end()
      })
      return child
    }) as never,
  })
  return { driver, calls, envCalls }
}

const magpieEnv = [
  'GEMINI_API_KEY=test-magpie-key',
  'GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3425/v1',
  'model=magpie/hl/gpt-6-astra',
  'settings=/tmp/magpie-agy-settings.json',
  'PATH=must-not-replace-host-path',
].join('\n')

test('Antigravity 模型探测从选定的 Magpie 入口读取环境，仅传递允许的变量', async () => {
  const originalKey = process.env.GEMINI_API_KEY
  const { driver, calls, envCalls } = magpieDriver(() => ({ status: 0, stdout: magpieEnv }))
  try {
    const catalog = await driver.listModels()
    assert.deepEqual(envCalls, [['custom-magpie', 'agy', 'env']])
    assert.equal(catalog.groups[0]?.models.some(model => model.id === 'magpie/hl/gpt-6-astra'), true)
    assert.equal(calls[0]?.env.GEMINI_API_KEY, 'test-magpie-key')
    assert.deepEqual(calls[0]?.args, ['--settings', '/tmp/magpie-agy-settings.json', 'models'])
    assert.equal(calls[0]?.env.settings, undefined)
    assert.equal(calls[0]?.env.GOOGLE_GEMINI_BASE_URL, 'http://127.0.0.1:3425/v1')
    assert.notEqual(calls[0]?.env.PATH, 'must-not-replace-host-path')
    assert.equal(calls[0]?.env.model, undefined)
    assert.equal(process.env.GEMINI_API_KEY, originalKey)
    assert.doesNotMatch(JSON.stringify(catalog), /test-magpie-key|magpie-agy-settings/u)
  } finally { driver.dispose() }
})

test('Antigravity 首轮和续接重新读取 Magpie 默认模型，同时保留显式模型和 Host 运行环境', async () => {
  let output = magpieEnv
  const { driver, calls } = magpieDriver(() => ({ status: 0, stdout: output }))
  try {
    await collect(driver, { modelId: 'provider-default' })
    output = magpieEnv.replace('magpie/hl/gpt-6-astra', 'magpie/tlp/gpt-6.1-sol')
      .replace('/tmp/magpie-agy-settings.json', '/tmp/next-agy-settings.json')
    await collect(driver, { providerSessionId: 'agy-provider-session' })
    await collect(driver, {
      modelId: 'magpie/hl/claude-opus-5-5',
      runtimeEnv: { GEMINI_API_KEY: 'host-override', CODINGNS_CREDENTIAL_BROKER_ENDPOINT: 'test-broker' },
    })
    assert.deepEqual(calls.map(call => call.args.slice(call.args.indexOf('--model'), call.args.indexOf('--model') + 2)), [
      ['--model', 'magpie/hl/gpt-6-astra'], ['--model', 'magpie/tlp/gpt-6.1-sol'], ['--model', 'magpie/hl/claude-opus-5-5'],
    ])
    assert.deepEqual(calls[1]?.args.slice(0, 2), ['--conversation', 'agy-provider-session'])
    assert.deepEqual(calls.map(call => call.args.slice(call.args.indexOf('--settings'), call.args.indexOf('--settings') + 2)), [
      ['--settings', '/tmp/magpie-agy-settings.json'],
      ['--settings', '/tmp/next-agy-settings.json'],
      ['--settings', '/tmp/next-agy-settings.json'],
    ])
    assert.equal(calls[0]?.env.GEMINI_API_KEY, 'test-magpie-key')
    assert.equal(calls[1]?.env.GEMINI_API_KEY, 'test-magpie-key')
    assert.equal(calls[2]?.env.GEMINI_API_KEY, 'host-override')
    assert.equal(calls[2]?.env.CODINGNS_CREDENTIAL_BROKER_ENDPOINT, 'test-broker')
  } finally { driver.dispose() }
})

test('Antigravity 兼容不返回 settings 的旧版 Magpie 环境', async () => {
  const { driver, calls } = magpieDriver(() => ({ status: 0, stdout: magpieEnv.replace('settings=/tmp/magpie-agy-settings.json', '') }))
  try {
    await collect(driver, { modelId: 'provider-default' })
    assert.equal(calls[0]?.env.GEMINI_API_KEY, 'test-magpie-key')
    assert.equal(calls[0]?.args.includes('--settings'), false)
    assert.deepEqual(calls[0]?.args.slice(-2), ['--model', 'magpie/hl/gpt-6-astra'])
  } finally { driver.dispose() }
})

test('Antigravity 未选择 Magpie 或环境读取失败、不完整时保留原生启动行为', async () => {
  for (const stdout of ['', 'model=magpie/hl/gpt-6-astra', magpieEnv]) {
    const { driver, calls } = magpieDriver(() => ({ status: stdout === magpieEnv ? 1 : 0, stdout }))
    try {
      await collect(driver, { modelId: 'provider-default', runtimeEnv: { GEMINI_API_KEY: 'native-key' } })
      assert.equal(calls[0]?.args.includes('--model'), false)
      assert.equal(calls[0]?.args.includes('--settings'), false)
      assert.equal(calls[0]?.env.GEMINI_API_KEY, 'native-key')
    } finally { driver.dispose() }
  }
  const { driver, envCalls } = magpieDriver(() => { throw new Error('must not run') }, { command: () => null })
  try {
    await collect(driver, {})
    assert.deepEqual(envCalls, [])
  } finally { driver.dispose() }
})

test('Antigravity 在读取 Magpie 环境期间取消或停用后不再启动会话', async () => {
  const controller = new AbortController()
  const cancelled = magpieDriver(() => { controller.abort(); return { status: 0, stdout: magpieEnv } })
  try {
    await assert.rejects(collect(cancelled.driver, { signal: controller.signal }), /abort/iu)
    assert.deepEqual(cancelled.calls, [])
  } finally { cancelled.driver.dispose() }
  const disposed = magpieDriver(() => { disposed.driver.dispose(); return { status: 0, stdout: magpieEnv } })
  await assert.rejects(collect(disposed.driver, {}), /abort/iu)
  assert.deepEqual(disposed.calls, [])
})

function agentResponseUsage(stepIndex: number, usage: Record<string, number>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return stepUpdate({ step_index: stepIndex, state: 'DONE', step_type: 'agent_response', usage, ...extra })
}

function resultEvent(usage: Record<string, number> | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'result',
    result: {
      conversation_id: 'agy-provider-session',
      status: 'SUCCESS',
      response: '完成',
      num_turns: 1,
      ...(usage === undefined ? {} : { usage }),
      ...extra,
    },
  }
}

test('Antigravity 通过 stdin stream-json 输入一轮并转换标准事件', async () => {
  const { driver, calls, inputs } = scriptedDriver([[
    { event: 'init', conversation_id: 'agy-provider-session' },
    agentResponseUsage(1, { input_tokens: 2, output_tokens: 1 }),
    resultEvent({ input_tokens: 2, output_tokens: 1 }),
  ]])
  assert.equal(driver.supportsToolStepSplitting, true)

  const chunks = await collect(driver, {})

  assert.equal((await driver.detect()).installed, true)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'agy-provider-session' },
    { type: 'text-delta', text: '完成', messageId: 'assistant-antigravity-agy-session-0' },
    { type: 'usage', inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, uncachedInputTokens: 2, totalTokens: 3, cacheHitRate: 0 },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(calls[0], [
    'fake-agy', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--mode', 'plan', '--add-dir', process.cwd(),
  ])
  assert.deepEqual(JSON.parse(inputs[0] ?? '{}'), { event: 'user', message: { content: '你好' } })
  assert.equal(driver.descriptor.capabilities?.includes('permission'), false)
  assert.equal(driver.descriptor.capabilities?.includes('questions'), false)
  driver.dispose()
})

test('Antigravity 每轮只上报单轮用量，不把 result 的会话累计值当成一轮用量', async () => {
  // 实测口径：step_update 是「本次模型调用」，result.usage 是整个会话的累计值。
  const { driver } = scriptedDriver([
    [
      { event: 'init', conversation_id: 'agy-provider-session' },
      agentResponseUsage(1, { input_tokens: 11758, output_tokens: 47, thinking_tokens: 46, cache_read_tokens: 0, total_tokens: 11805 }),
      resultEvent({ input_tokens: 11758, output_tokens: 47, thinking_tokens: 46, cache_read_tokens: 0, total_tokens: 11805 }),
    ],
    [
      agentResponseUsage(4, { input_tokens: 12008, output_tokens: 51, thinking_tokens: 50, cache_read_tokens: 0, total_tokens: 12059 }),
      resultEvent({ input_tokens: 23766, output_tokens: 98, thinking_tokens: 96, cache_read_tokens: 0, total_tokens: 23864 }),
    ],
    [
      agentResponseUsage(7, { input_tokens: 12262, output_tokens: 19, thinking_tokens: 18, cache_read_tokens: 0, total_tokens: 12281 }),
      resultEvent({ input_tokens: 36028, output_tokens: 117, thinking_tokens: 114, cache_read_tokens: 0, total_tokens: 36145 }),
    ],
  ])

  const first = await collect(driver, {})
  const second = await collect(driver, { providerSessionId: 'agy-provider-session' })
  const third = await collect(driver, { providerSessionId: 'agy-provider-session' })

  const usageOf = (chunks: any[]) => chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usageOf(first).inputTokens, 11758)
  assert.equal(usageOf(second).inputTokens, 12008)
  assert.equal(usageOf(second).outputTokens, 51)
  assert.equal(usageOf(third).inputTokens, 12262)
  assert.equal(usageOf(third).outputTokens, 19)
  driver.dispose()
})

test('Antigravity 一轮内多次模型调用按调用求和，思考 token 已含在 output_tokens 内', async () => {
  const { driver } = scriptedDriver([[
    { event: 'init', conversation_id: 'agy-provider-session' },
    agentResponseUsage(1, { input_tokens: 11764, output_tokens: 241, thinking_tokens: 186, cache_read_tokens: 0, total_tokens: 12005 }),
    stepUpdate({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { parameters: { CommandLine: 'pwd' } } }),
    stepUpdate({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { output: '/tmp' } }),
    agentResponseUsage(3, { input_tokens: 12097, output_tokens: 118, thinking_tokens: 77, cache_read_tokens: 0, total_tokens: 12215 }, { text_delta: '完成' }),
    resultEvent({ input_tokens: 23861, output_tokens: 359, thinking_tokens: 263, cache_read_tokens: 0, total_tokens: 24220 }),
  ]])

  const chunks = await collect(driver, {})
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usage.inputTokens, 23861)
  assert.equal(usage.outputTokens, 359)
  assert.equal(usage.totalTokens, 24220)
  // 只有 usage 事件，result 里的累计值不会被 genericEventChunks 再投影一次。
  assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1)
  driver.dispose()
})

test('Antigravity 缺少 step 用量时用会话累计差值补齐单轮用量', async () => {
  const { driver } = scriptedDriver([
    [resultEvent({ input_tokens: 100, output_tokens: 10, total_tokens: 110 }, { response: '一' })],
    [resultEvent({ input_tokens: 260, output_tokens: 25, total_tokens: 285 }, { response: '二' })],
    // 会话被重置时累计值回退，不能给出负数用量。
    [resultEvent({ input_tokens: 120, output_tokens: 8, total_tokens: 128 }, { response: '三' })],
  ])

  const first = await collect(driver, {})
  const second = await collect(driver, { providerSessionId: 'agy-provider-session' })
  const third = await collect(driver, { providerSessionId: 'agy-provider-session' })

  const usageOf = (chunks: any[]) => chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usageOf(first).inputTokens, 100)
  assert.equal(usageOf(first).outputTokens, 10)
  assert.equal(usageOf(second).inputTokens, 160)
  assert.equal(usageOf(second).outputTokens, 15)
  assert.equal(usageOf(third).inputTokens, 120)
  assert.equal(usageOf(third).outputTokens, 8)
  driver.dispose()
})

test('Antigravity 为单轮用量补上上下文窗口与当前上下文占用', async () => {
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 11758, output_tokens: 47, cache_read_tokens: 0, total_tokens: 11805 }),
    resultEvent({ input_tokens: 11758, output_tokens: 47, cache_read_tokens: 0, total_tokens: 11805 }),
  ]], { contextWindow: 1_048_576 })

  const chunks = await collect(driver, { modelId: 'gemini-3.8-flash' })
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usage.contextWindow, 1_048_576)
  assert.equal(usage.contextTokens, 11758)
  assert.equal(usage.contextUsageRatio, Number((11758 / 1_048_576).toFixed(6)))
  driver.dispose()
})

test('Antigravity Claude 模型沿用 Anthropic 口径，缓存读取不计入未缓存输入', async () => {
  // 实测 claude-sonnet-4-6 首轮：input_tokens=3968、cache_read_tokens=9619，
  // input_tokens 只含未缓存输入；Gemini 口径下同一组数字会算出 0 未缓存输入。
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 3968, output_tokens: 15, cache_read_tokens: 9619, total_tokens: 3983 }),
    resultEvent({ input_tokens: 3968, output_tokens: 15, cache_read_tokens: 9619, total_tokens: 3983 }),
  ]], { contextWindow: 250_000, modelId: 'claude-sonnet-4-6' })

  const chunks = await collect(driver, { modelId: 'claude-sonnet-4-6' })
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usage.inputTokens, 3968)
  assert.equal(usage.uncachedInputTokens, 3968)
  assert.equal(usage.cacheReadTokens, 9619)
  assert.equal(usage.cacheHitRate, Number((9619 / (3968 + 9619) * 100).toFixed(4)))
  // 上下文占用 = 未缓存输入 + 缓存读取，缓存不能漏出分母。
  assert.equal(usage.contextTokens, 13587)
  driver.dispose()
})

test('Antigravity 不给 Claude 模型下发 --effort，避免整轮被 CLI 拒绝', async () => {
  // 实测 AGY：`--effort is not supported for model "claude-sonnet-4-6"`，任何档位都会
  // 被判成 invalid model selection；旧会话残留的 Gemini 档位不能让整轮失败。
  const claude = scriptedDriver([[resultEvent(undefined, { response: '好' })]], { modelId: 'claude-sonnet-4-6' })
  await collect(claude.driver, { modelId: 'claude-sonnet-4-6', effortId: 'medium' })
  assert.equal(claude.calls[0]?.includes('--effort'), false)
  claude.driver.dispose()

  // provider-default 时按 AGY 设置文件解析出的 Claude 模型同样不能下发
  const defaultClaude = scriptedDriver([[resultEvent(undefined, { response: '好' })]], { modelId: 'claude-opus-4.6' })
  await collect(defaultClaude.driver, { effortId: 'high' })
  assert.equal(defaultClaude.calls[0]?.includes('--effort'), false)
  defaultClaude.driver.dispose()

  // Gemini 仍然照常下发档位
  const gemini = scriptedDriver([[resultEvent(undefined, { response: '好' })]], { modelId: 'gemini-3.8-flash' })
  await collect(gemini.driver, { modelId: 'gemini-3.8-flash', effortId: 'medium' })
  assert.deepEqual(gemini.calls[0]?.slice(-2), ['--effort', 'medium'])
  gemini.driver.dispose()
})

test('Antigravity 从 agy models 动态加载模型并合并思考档位', async () => {
  const modelProbeCalls: string[][] = []
  const modelProbeOptions: Array<{ shell?: unknown; stdio?: unknown; env?: { PATH?: unknown } }> = []
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: ((command: string, args: string[]) => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: ((command: string, args: string[], options: { shell?: unknown; stdio?: unknown; env?: { PATH?: unknown } }) => {
      modelProbeCalls.push([command, ...args])
      modelProbeOptions.push(options)
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill(): boolean
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => true
      queueMicrotask(() => {
        child.stdout.end([
          'Fetching available models...',
          'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
          'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
          'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
          'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
          'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
          'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
        ].join('\n'))
        child.stderr.end()
        child.emit('close', 0)
      })
      return child
    }) as never,
  })

  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'provider-default', name: '跟随 Antigravity 默认模型', efforts: [] },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', efforts: [] },
  ])
  assert.deepEqual(modelProbeCalls[0], ['fake-agy', 'models'])
  assert.deepEqual(modelProbeOptions[0]?.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(modelProbeOptions[0]?.shell, process.platform === 'win32')
  assert.equal(typeof modelProbeOptions[0]?.env?.PATH, 'string')
  driver.dispose()
})

test('Antigravity 释放驱动时取消后台模型探测并返回可重试回退目录', async () => {
  let killed = false
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => { killed = true; return true }
      return child
    }) as never,
  })

  const pending = driver.listModels()
  await new Promise<void>((resolve) => setImmediate(resolve))
  driver.dispose()
  const catalog = await pending
  assert.equal(catalog.fallback, true)
  assert.equal(killed, true)
})

test('Antigravity 续接会话时传递 conversation，result.response 作为正文兜底', async () => {
  const { driver, calls } = scriptedDriver([[
    { event: 'result', result: { conversation_id: 'agy-existing', response: '续接完成', status: 'SUCCESS', num_turns: 2 } },
  ]])

  const chunks = await collect(driver, { providerSessionId: 'agy-existing', prompt: '继续' })

  assert.deepEqual(chunks, [
    { type: 'text-delta', text: '续接完成', messageId: 'assistant-antigravity-agy-session-0' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(calls[0], [
    'fake-agy', '--conversation', 'agy-existing', '--input-format', 'stream-json',
    '--output-format', 'stream-json', '--mode', 'plan', '--add-dir', process.cwd(),
  ])
  driver.dispose()
})

test('Antigravity 只有 DSH 明确永不询问时才允许自动放行，其他权限状态保持保守模式', async () => {
  const states = [
    { permission: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }, expected: ['--dangerously-skip-permissions'] },
    { permission: { sandboxMode: 'workspace-write', approvalPolicy: 'never' }, expected: ['--mode', 'accept-edits'] },
    { permission: { sandboxMode: 'workspace-write', approvalPolicy: 'ask' }, expected: ['--mode', 'plan'] },
    { permission: { sandboxMode: 'read-only', approvalPolicy: 'never' }, expected: ['--mode', 'plan'] },
    { permission: undefined, expected: ['--mode', 'plan'] },
  ] as const
  for (const [index, state] of states.entries()) {
    const { driver, calls } = scriptedDriver([[
      { event: 'result', result: { conversation_id: `agy-permission-${index}`, response: '完成', status: 'SUCCESS', num_turns: 1 } },
    ]])
    await collect(driver, state.permission === undefined ? {} : { permission: state.permission })
    const permissionIndex = calls[0]?.findIndex((argument) => argument === state.expected[0]) ?? -1
    assert.notEqual(permissionIndex, -1)
    assert.deepEqual(calls[0]?.slice(permissionIndex, permissionIndex + state.expected.length), state.expected)
    driver.dispose()
  }
})

test('Antigravity 不重复追加 result.response，并保留 tool step 生命周期', async () => {
  const { driver } = scriptedDriver([[
    { event: 'init', conversation_id: 'agy-tools' },
    stepUpdate({ conversation_id: 'agy-tools', step_type: 'agent_response', text_delta: '完成' }),
    stepUpdate({ conversation_id: 'agy-tools', step_type: 'tool', state: 'ACTIVE', tool_name: 'bash', tool_info: { parameters: { command: 'pwd' } } }),
    stepUpdate({ conversation_id: 'agy-tools', step_type: 'tool', state: 'DONE', tool_name: 'bash', tool_info: { output: '/tmp' } }),
    { event: 'result', result: { conversation_id: 'agy-tools', response: '完成', status: 'SUCCESS', num_turns: 1 } },
  ]])

  const chunks = await collect(driver, { sessionId: 'agy-tools', prompt: '执行' })

  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'agy-tools' },
    { type: 'text-delta', text: '完成', messageId: 'assistant-antigravity-agy-tools-0' },
    { type: 'tool-event', toolName: 'bash', status: 'running', input: '{"command":"pwd"}' },
    { type: 'tool-event', toolName: 'bash', status: 'completed', output: '/tmp', outputMode: 'snapshot' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Antigravity 续接返回不同 conversation 时明确失败', async () => {
  const { driver } = scriptedDriver([[
    { event: 'result', result: { conversation_id: 'other-conversation', response: '错误会话', status: 'SUCCESS', num_turns: 1 } },
  ]])

  await assert.rejects(async () => {
    for await (const _chunk of driver.executeTurn({ sessionId: 'agy-mismatch', providerSessionId: 'expected-conversation', messages: [], prompt: '继续' })) {}
  }, /Antigravity 恢复会话不一致/)
  driver.dispose()
})

test('Antigravity result 非成功状态转换为 error 终态', async () => {
  const { driver } = scriptedDriver([[
    { event: 'result', result: { conversation_id: 'agy-error', status: 'FAILURE', error: '模型失败', num_turns: 1 } },
  ]])

  const chunks = await collect(driver, { sessionId: 'agy-error', prompt: '失败' })
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'agy-error' },
    { type: 'finish', reason: 'error', failure: { message: '模型失败' } },
  ])
  driver.dispose()
})

test('Antigravity 失败终态仍保留本轮已发生的真实用量', async () => {
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 11758, output_tokens: 47, cache_read_tokens: 0, total_tokens: 11805 }),
    { event: 'result', result: { conversation_id: 'agy-provider-session', status: 'FAILURE', error: '模型失败', usage: { input_tokens: 11758, output_tokens: 47, total_tokens: 11805 } } },
  ]])

  const chunks = await collect(driver, {})
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['session-binding', 'usage', 'finish'])
  assert.equal(chunks[1].inputTokens, 11758)
  assert.equal(chunks[2].reason, 'error')
  driver.dispose()
})

test('Antigravity 子进程提前退出或 stdin 断开时不会触发宿主未捕获异常', async () => {
  const driver = new AntigravityDriver({
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.14', stderr: '' })) as never,
    spawn: (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        stdin: EventEmitter & { end(value?: string): void }
        kill(): boolean
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = Object.assign(new EventEmitter(), {
        end(): void {
          queueMicrotask(() => child.stdin.emit('error', new Error('write EPIPE')))
        },
      })
      child.kill = () => true
      queueMicrotask(() => {
        child.stderr.end('agy failed')
        child.stdout.end()
        child.emit('close', 2)
      })
      return child
    }) as never,
  })

  await assert.rejects(async () => {
    for await (const _chunk of driver.executeTurn({ sessionId: 'agy-failed', messages: [], prompt: '你好' })) {}
  }, /Antigravity 执行失败：agy failed/)
  driver.dispose()
})
