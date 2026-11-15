import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'

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
    // 模型解析与本机设置隔离；用量口径不应依赖该解析结果。
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
    // 累计值回退时无法确认当前回合差值，只重建基线。
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
  assert.equal(usageOf(third), undefined)
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

test('Antigravity 原生 Hydrogen 逐次用量重建三轮统计，并经 DSH 投影保留未缓存输入', async () => {
  // 这些是只读 SQLite 提取的逐次数字，不是保存下来的 stdout 事件。
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/antigravity-token-usage.json', import.meta.url), 'utf8'))
  const expected = [
    [115082, 30452, 1616775, 145534, 92810],
    [40429, 20036, 1365001, 60465, 119814],
    [38662, 11415, 1788783, 50077, 139539],
  ]
  let input = 0, output = 0, cache = 0, thinking = 0
  const turns = fixture.turns.map((rows: number[][]) => {
    const steps = rows.map(([index, i, o, c, t]) => {
      input += i; output += o; cache += c; thinking += t
      return agentResponseUsage(index, { input_tokens: i, output_tokens: o, cache_read_tokens: c, thinking_tokens: t, total_tokens: i + o })
    })
    // result 是按官方累计协议构造的校验值，不能作为真实 result 抓包证据。
    return [...steps, resultEvent({ input_tokens: input, output_tokens: output, cache_read_tokens: cache, thinking_tokens: thinking, total_tokens: input + output })]
  })
  const { driver } = scriptedDriver(turns, { modelId: fixture.modelId, contextWindow: 1_048_576 })
  try {
    for (const [turn, [i, o, c, total, context]] of expected.entries()) {
      const chunks = await collect(driver, { modelId: fixture.modelId, ...(turn === 0 ? {} : { providerSessionId: 'agy-provider-session' }) })
      const usages = chunks.filter(chunk => chunk.type === 'usage')
      assert.equal(usages.length, 1)
      const usage = usages[0]
      assert.equal(usage.inputTokens, i)
      assert.equal(usage.uncachedInputTokens, i)
      assert.equal(usage.outputTokens, o)
      assert.equal(usage.cacheReadTokens, c)
      assert.equal(usage.totalTokens, total) // 保留 CLI 的 input + output，不另加缓存。
      assert.equal(usage.cacheHitRate, Number((c / (i + c) * 100).toFixed(4)))
      assert.equal(usage.contextTokens, context) // 最后一次调用，不能用本轮合计。
      const samples: unknown[] = []
      const projector = new CodingNsDshMessageProjector({
        adapterId: 'antigravity', modelId: fixture.modelId, sessionId: `native-turn-${turn}`,
        nativeSessions: { appendUsageSample(_id, sample) { samples.push(sample); return true } },
      })
      await projector.push(usage)
      const projected = await projector.push({ type: 'finish', reason: 'stop' })
      assert.deepEqual(projected.find(chunk => chunk.type === 'usage')?.usage, {
        inputTokens: i, outputTokens: o, cacheReadTokens: c, totalTokens: total,
      })
      assert.equal((samples[0] as { inputTokens: number }).inputTokens, i)
    }
  } finally { driver.dispose() }
})

test('Antigravity 非零缓存口径不依赖模型前缀、别名或实际模型解析成功', async () => {
  for (const modelId of ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gpt-oss-120b', 'claude-sonnet-4-6', 'magpie/hl/claude-opus-5-5', null]) {
    const { driver } = scriptedDriver([[
      agentResponseUsage(1, { input_tokens: 100, output_tokens: 20, cache_read_tokens: 40, total_tokens: 120 }),
      resultEvent(undefined),
    ]], { modelId, contextWindow: 1000 })
    try {
      const usage = (await collect(driver, { modelId: modelId ?? 'provider-default' })).find(chunk => chunk.type === 'usage')
      assert.equal(usage.uncachedInputTokens, 100, String(modelId))
      assert.equal(usage.cacheHitRate, 28.5714)
      assert.equal(usage.contextTokens, 140)
    } finally { driver.dispose() }
  }
})

test('Antigravity 重复 step 快照只替换一次，旧 step 和 checkpoint 不覆盖最后调用的上下文', async () => {
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 10, output_tokens: 1, cache_read_tokens: 80 }),
    agentResponseUsage(3, { input_tokens: 20, output_tokens: 2, cache_read_tokens: 90 }),
    agentResponseUsage(3, { input_tokens: 20, output_tokens: 2, cache_read_tokens: 90 }),
    agentResponseUsage(1, { input_tokens: 12, output_tokens: 1, cache_read_tokens: 80 }),
    stepUpdate({ step_index: 4, state: 'DONE', step_type: 'checkpoint', usage: { input_tokens: 5, output_tokens: 1 } }),
    resultEvent(undefined),
  ]], { contextWindow: 1000 })
  try {
    const usages = (await collect(driver, {})).filter(chunk => chunk.type === 'usage')
    assert.equal(usages.length, 1)
    assert.equal(usages[0].inputTokens, 37)
    assert.equal(usages[0].cacheReadTokens, 170)
    assert.equal(usages[0].outputTokens, 4)
    assert.equal(usages[0].contextTokens, 110)
  } finally { driver.dispose() }
})

test('Antigravity 最后一次响应缺少用量时不沿用较早调用的上下文占用', async () => {
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 10, output_tokens: 1, cache_read_tokens: 80 }),
    stepUpdate({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '完成' }),
    resultEvent({ input_tokens: 30, output_tokens: 3, cache_read_tokens: 170, total_tokens: 33 }),
  ]], { contextWindow: 1000 })
  try {
    const usage = (await collect(driver, {})).find(chunk => chunk.type === 'usage')
    assert.equal(usage.contextWindow, 1000)
    assert.equal(usage.contextTokens, undefined)
    assert.equal(usage.contextUsageRatio, undefined)
  } finally { driver.dispose() }
})

test('Antigravity 累计差值保留缓存且不推测上下文，失败回合也只结算本轮', async () => {
  const { driver } = scriptedDriver([
    [resultEvent({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 200, total_tokens: 110 })],
    [resultEvent({ input_tokens: 140, output_tokens: 15, cache_read_tokens: 500, total_tokens: 155 }, { status: 'ERROR', error: 'failed' })],
    [resultEvent({ input_tokens: 150, output_tokens: 18, cache_read_tokens: 550, total_tokens: 168 })],
  ], { contextWindow: 1000 })
  try {
    for (const [turn, [i, o, c]] of [[100, 10, 200], [40, 5, 300], [10, 3, 50]].entries()) {
      const chunks = await collect(driver, turn === 0 ? {} : { providerSessionId: 'agy-provider-session' })
      const usage = chunks.find(chunk => chunk.type === 'usage')
      assert.equal(usage.uncachedInputTokens, i)
      assert.equal(usage.outputTokens, o)
      assert.equal(usage.cacheReadTokens, c)
      assert.equal(usage.contextWindow, 1000)
      assert.equal(usage.contextTokens, undefined)
      assert.equal(usage.contextUsageRatio, undefined)
      assert.equal(chunks.at(-1).reason, turn === 1 ? 'error' : 'stop')
    }
  } finally { driver.dispose() }
})

test('Antigravity 首次接入已恢复会话且无 step 时只建立累计基线', async () => {
  const { driver } = scriptedDriver([
    [resultEvent({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 200, total_tokens: 110 })],
    [resultEvent({ input_tokens: 140, output_tokens: 15, cache_read_tokens: 500, total_tokens: 155 })],
  ])
  try {
    assert.equal((await collect(driver, { providerSessionId: 'agy-provider-session' })).some(chunk => chunk.type === 'usage'), false)
    const usage = (await collect(driver, { providerSessionId: 'agy-provider-session' })).find(chunk => chunk.type === 'usage')
    assert.equal(usage.uncachedInputTokens, 40)
    assert.equal(usage.cacheReadTokens, 300)
  } finally { driver.dispose() }
})

test('Antigravity 任一累计桶回退时不混合不同基线，也不伪造当前回合精确值', async () => {
  for (const rollback of [
    { input_tokens: 120, output_tokens: 8, cache_read_tokens: 250, total_tokens: 128 },
    { input_tokens: 120, output_tokens: 12, cache_read_tokens: 150, total_tokens: 132 },
    { input_tokens: 120, output_tokens: 12, cache_read_tokens: 250, total_tokens: 100 },
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  ]) {
    const next = { input_tokens: rollback.input_tokens + 10, output_tokens: rollback.output_tokens + 2, cache_read_tokens: rollback.cache_read_tokens + 20, total_tokens: rollback.total_tokens + 12 }
    const { driver } = scriptedDriver([
      [resultEvent({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 200, total_tokens: 110 })],
      [resultEvent(rollback)], [resultEvent(next)],
    ])
    try {
      await collect(driver, {})
      assert.equal((await collect(driver, { providerSessionId: 'agy-provider-session' })).some(chunk => chunk.type === 'usage'), false)
      const usage = (await collect(driver, { providerSessionId: 'agy-provider-session' })).find(chunk => chunk.type === 'usage')
      assert.equal(usage.uncachedInputTokens, 10)
      assert.equal(usage.outputTokens, 2)
      assert.equal(usage.cacheReadTokens, 20)
    } finally { driver.dispose() }
  }
})

test('Antigravity ERROR 空用量信封不能把既有会话累计基线重置为零', async () => {
  // 官方 headless 协议的参数/输入错误信封返回全零 usage，并非会话清空。
  const { driver } = scriptedDriver([
    [resultEvent({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 200, total_tokens: 110 })],
    [resultEvent({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, { status: 'ERROR', error: 'invalid input' })],
    [resultEvent({ input_tokens: 140, output_tokens: 15, cache_read_tokens: 500, total_tokens: 155 })],
  ])
  try {
    await collect(driver, {})
    const failed = await collect(driver, { providerSessionId: 'agy-provider-session' })
    assert.equal(failed.some(chunk => chunk.type === 'usage'), false)
    assert.equal(failed.at(-1).reason, 'error')
    const usage = (await collect(driver, { providerSessionId: 'agy-provider-session' })).find(chunk => chunk.type === 'usage')
    assert.equal(usage.uncachedInputTokens, 40)
    assert.equal(usage.cacheReadTokens, 300)
  } finally { driver.dispose() }
})

test('Antigravity 保留上游显式总量，不用缓存桶或思考字段重写它', async () => {
  for (const total of [0, 999]) {
    const { driver } = scriptedDriver([[
      agentResponseUsage(1, { input_tokens: 100, output_tokens: 20, cache_read_tokens: 400, thinking_tokens: 15, total_tokens: total }),
      resultEvent(undefined),
    ]])
    try {
      const usage = (await collect(driver, {})).find(chunk => chunk.type === 'usage')
      assert.equal(usage.totalTokens, total)
      assert.equal(usage.outputTokens, 20)
      assert.equal(usage.uncachedInputTokens, 100)
      assert.equal(usage.cacheReadTokens, 400)
    } finally { driver.dispose() }
  }
})

test('Antigravity Claude 模型沿用 Anthropic 口径，缓存读取不计入未缓存输入', async () => {
  // 实测 claude-sonnet-4-6 首轮：input_tokens=3968、cache_read_tokens=9619，
  // input_tokens 只含未缓存输入；旧的非 Claude 转换会把同一组数字算成 0。
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
