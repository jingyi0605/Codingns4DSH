import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import { antigravityContextProjection } from '../data/build/dist/host/cli-adapters/provider-context-projection.js'
import { createCodingNsNativeSessionBridge, type CodingNsNativeSessionBridge } from '../data/build/dist/host/native-session-bridge.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import type { CodingNsAgentEvent } from '../src/shared/contracts/cli-adapter.js'

/**
 * 造一个只回放固定 NDJSON 的 agy 子进程；每次调用消费一组输出行。
 *
 * 关闭上下文窗口解析，保证断言只针对线协议投影，不依赖本机 AGY 设置文件。
 */
function scriptedDriver(
  turns: readonly (readonly Record<string, unknown>[])[],
  options: { readonly contextWindow?: number; readonly modelId?: string | null; readonly resolveDefaultContextWindow?: boolean; readonly onRequest?: () => void } = {},
) {
  const calls: string[][] = []
  const inputs: string[] = []
  let index = 0
  const driver = new AntigravityDriver({
    autoUpdater: { check() {}, dispose() {} },
    binaries: ['fake-agy'],
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.2.17', stderr: '' })) as never,
    ...(options.resolveDefaultContextWindow === true
      ? {}
      : { resolveContextWindow: options.contextWindow === undefined ? () => undefined : () => options.contextWindow }),
    // 实测所有模型的 input_tokens 都不含缓存读取；modelId 只影响上下文窗口和 --effort。
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
            options.onRequest?.()
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
    autoUpdater: { check() {}, dispose() {} },
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

test('Antigravity Windows 模型发现、首轮和续接仅在业务子进程中禁用原生后台更新', async () => {
  const original = process.env.AGY_CLI_DISABLE_AUTO_UPDATE
  process.env.AGY_CLI_DISABLE_AUTO_UPDATE = 'false'
  const { driver, calls } = magpieDriver(() => ({ status: 0, stdout: magpieEnv }))
  try {
    const catalog = await driver.listModels()
    assert.equal(catalog.groups[0]?.models.some(model => model.id === 'magpie/hl/gpt-6-astra'), true)
    await collect(driver, {})
    await collect(driver, {
      providerSessionId: 'agy-provider-session',
      runtimeEnv: { AGY_CLI_DISABLE_AUTO_UPDATE: 'false', CODINGNS_CREDENTIAL_BROKER_ENDPOINT: 'test-broker' },
    })
    assert.equal(calls.length, 3)
    for (const call of calls) {
      assert.equal(call.env.AGY_CLI_DISABLE_AUTO_UPDATE, process.platform === 'win32' ? 'true' : 'false')
      assert.equal(call.env.GEMINI_API_KEY, 'test-magpie-key')
    }
    assert.equal(calls[2]?.env.CODINGNS_CREDENTIAL_BROKER_ENDPOINT, 'test-broker')
    assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'false')
  } finally {
    driver.dispose()
    if (original === undefined) delete process.env.AGY_CLI_DISABLE_AUTO_UPDATE
    else process.env.AGY_CLI_DISABLE_AUTO_UPDATE = original
  }
})

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

test('Antigravity 每轮经本地会话代理访问 Magpie 网关，轮次结束后代理关闭', async () => {
  const { driver, calls } = magpieDriver(() => ({ status: 0, stdout: magpieEnv }))
  try {
    await collect(driver, { modelId: 'provider-default' })
    const proxied = new URL(calls[0]?.env.GOOGLE_GEMINI_BASE_URL ?? '')
    assert.equal(proxied.hostname, '127.0.0.1')
    assert.notEqual(proxied.port, '3425')
    assert.equal(proxied.pathname, '/v1')
    assert.equal(calls[0]?.env.GEMINI_API_KEY, 'test-magpie-key')
    await assert.rejects(fetch(`${proxied.origin}/v1/models`))
  } finally { driver.dispose() }
})

test('Antigravity 的 Magpie 网关不是本机回环地址时直连，不启动会话代理', async () => {
  const remote = magpieEnv.replace('http://127.0.0.1:3425/v1', 'https://magpie.example.com/v1')
  const { driver, calls } = magpieDriver(() => ({ status: 0, stdout: remote }))
  try {
    await collect(driver, { modelId: 'provider-default' })
    assert.equal(calls[0]?.env.GOOGLE_GEMINI_BASE_URL, 'https://magpie.example.com/v1')
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
      assert.equal(calls[0]?.env.AGY_CLI_DISABLE_AUTO_UPDATE, process.platform === 'win32' ? 'true' : process.env.AGY_CLI_DISABLE_AUTO_UPDATE)
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
    { type: 'usage', inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, uncachedInputTokens: 2, totalTokens: 3, cacheHitRate: 0, contextTokens: 2 },
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
    // 会话被重置时累计值回退，不能推测本轮精确用量。
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

test('Antigravity Hydrogen 模型使用默认解析器提供的上下文窗口', async () => {
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 100, output_tokens: 5, cache_read_tokens: 200, total_tokens: 105 }),
    agentResponseUsage(3, { input_tokens: 10, output_tokens: 3, cache_read_tokens: 20, total_tokens: 13 }),
    resultEvent({ input_tokens: 110, output_tokens: 8, cache_read_tokens: 220, total_tokens: 118 }),
  ]], { modelId: 'gemini-4-hydrogen', resolveDefaultContextWindow: true })

  try {
    const usage = (await collect(driver, { modelId: 'gemini-4-hydrogen' })).find(chunk => chunk.type === 'usage')
    assert.equal(usage.contextWindow, 1_048_576)
    assert.equal(usage.inputTokens, 110)
    assert.equal(usage.cacheReadTokens, 220)
    assert.equal(usage.contextTokens, 30)
    assert.equal(usage.contextUsageRatio, Number((30 / 1_048_576).toFixed(6)))
  } finally {
    driver.dispose()
  }
})

test('Antigravity Argon 用最后一次模型调用计算上下文占用', async () => {
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 12_000, output_tokens: 40, cache_read_tokens: 0, total_tokens: 12_040 }),
    agentResponseUsage(3, { input_tokens: 2_000, output_tokens: 20, cache_read_tokens: 11_000, total_tokens: 2_020 }),
    resultEvent({ input_tokens: 14_000, output_tokens: 60, cache_read_tokens: 11_000, total_tokens: 14_060 }),
  ]], { modelId: 'gemini-4-argon', resolveDefaultContextWindow: true })

  try {
    const usage = (await collect(driver, { modelId: 'gemini-4-argon', effortId: 'low' })).find(chunk => chunk.type === 'usage')
    assert.equal(usage.contextWindow, 1_048_576)
    assert.equal(usage.contextTokens, 13_000)
    assert.equal(usage.contextUsageRatio, 0.012398)
    assert.equal(usage.inputTokens, 14_000)
    assert.equal(usage.cacheReadTokens, 11_000)
  } finally {
    driver.dispose()
  }
})

test('Antigravity 用可信模型容量与最后一次调用的占用计算百分比', async () => {
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 12_000, output_tokens: 600, cache_read_tokens: 990_000 }),
    agentResponseUsage(2, { input_tokens: 2_276, output_tokens: 1_634, cache_read_tokens: 185_437 }),
    resultEvent({ input_tokens: 14_276, output_tokens: 2_234, cache_read_tokens: 1_175_437 }),
  ]], { resolveDefaultContextWindow: true })
  try {
    for (const [modelId, modelContextWindow, expectedWindow, expectedRatio] of [
      ['gemini-4-neon', undefined, 1_048_576, 0.179017],
      ['unknown-model', undefined, undefined, undefined],
      ['magpie/tlp/gemini-4-neon', 1_000_000, 1_000_000, 0.187713],
    ] as const) {
      const chunks = await collect(driver, { modelId, modelContextWindow })
      const usage = chunks.find(chunk => chunk.type === 'usage')
      assert.equal(usage.inputTokens, 14_276)
      assert.equal(usage.cacheReadTokens, 1_175_437)
      assert.equal(usage.contextTokens, 187_713)
      assert.equal(usage.contextWindow, expectedWindow)
      assert.equal(usage.contextUsageRatio, expectedRatio)

      const events = [
        { type: 'turn/start', seq: 0, data: { turn: 1 } },
        { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
        { type: 'request/context', seq: 2, data: { provider: 'codingns-cli-antigravity', model: modelId, contextWindow: 1_000_000 } },
      ]
      const session = {
        snapshotEvents: () => [...events],
        append(type: string, data: (typeof events)[number]['data']) {
          const event = { type, data, seq: events.length }
          events.push(event)
          return event
        },
      }
      const nativeSessions = createCodingNsNativeSessionBridge({
        get: (name: string) => name === 'sessions' ? { get: () => session, list: () => [session] } : undefined,
      } as never)
      const projector = new CodingNsDshMessageProjector({ adapterId: 'antigravity', sessionId: 'agy-session', modelId, nativeSessions })
      for (const chunk of chunks) await projector.push(chunk)
      const projection = antigravityContextProjection
      assert.deepEqual(projection.wire.view(events.reduce(projection.apply, projection.init())), {
        pressureTokens: 187_713, ...(expectedWindow === undefined ? {} : { contextWindow: expectedWindow }),
      })
    }
  } finally {
    driver.dispose()
  }
})

test('Antigravity 缓存读取不计入未缓存输入，Claude 与 Gemini 口径一致', async () => {
  // 实测 claude-sonnet-4-6 首轮：input_tokens=3968、cache_read_tokens=9619，
  // input_tokens 只含未缓存输入；把它当成完整提示会算出 0 未缓存输入。
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

test('Antigravity Gemini 的 input_tokens 同样不含缓存读取，缓存命中率不会被算成 100%', async () => {
  // agy 1.5.9 实测 Gemini 一次调用：input_tokens=2553、cache_read_tokens=7571。
  // 缓存读取大于输入，说明 input_tokens 只含未缓存部分；旧实现把它当完整提示，命中率恒为 100%。
  const { driver } = scriptedDriver([[
    agentResponseUsage(3, { input_tokens: 2553, output_tokens: 65, cache_read_tokens: 7571, total_tokens: 2618 }),
    resultEvent({ input_tokens: 2553, output_tokens: 65, cache_read_tokens: 7571, total_tokens: 2618 }),
  ]], { contextWindow: 1_048_576, modelId: 'gemini-3.8-flash' })

  const chunks = await collect(driver, { modelId: 'gemini-3.8-flash' })
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  assert.equal(usage.uncachedInputTokens, 2553)
  assert.equal(usage.cacheReadTokens, 7571)
  assert.equal(usage.cacheHitRate, Number((7571 / (2553 + 7571) * 100).toFixed(4)))
  assert.equal(usage.contextTokens, 2553 + 7571)
  driver.dispose()
})

test('Antigravity 用 step 的 duration_seconds 产出请求速度样本，不编造首字延迟', async () => {
  const { driver } = scriptedDriver([[
    { event: 'init', conversation_id: 'agy-provider-session' },
    stepUpdate({ step_index: 1, state: 'DONE', step_type: 'agent_response', duration_seconds: 16.5, usage: { input_tokens: 9603, output_tokens: 424, thinking_tokens: 392, cache_read_tokens: 0, total_tokens: 10027 } }),
    // 没有耗时或输出的 step 不产出样本
    stepUpdate({ step_index: 3, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 } }),
    resultEvent({ input_tokens: 9608, output_tokens: 424, total_tokens: 10032 }),
  ]])

  const chunks = await collect(driver, {})
  const observations = chunks.filter((chunk) => chunk.type === 'usage-observation')
  assert.equal(observations.length, 1)
  const batch = observations[0].requestPerformance
  assert.equal(batch.adapterId, 'antigravity')
  const [sample] = batch.samples
  assert.equal(sample.outputTokens, 424)
  assert.equal(sample.completedAt - sample.startedAt, 16_500)
  assert.equal(sample.firstTokenAt, sample.startedAt)
  driver.dispose()
})

test('Antigravity 文件工具按 step_index 配对生命周期，并换成公共 edit/write 参数名', async () => {
  // agy 1.5.9 实测：线协议没有 call id 和 tool_info.status，参数名是大写的 Path/Content/Target/Replacement。
  const { driver } = scriptedDriver([[
    { event: 'init', conversation_id: 'agy-provider-session' },
    stepUpdate({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: '/w/a.txt' } } }),
    stepUpdate({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_file', duration_seconds: 0.1, tool_info: { name: 'write_file', parameters: { Path: '/w/a.txt' } } }),
    stepUpdate({ step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'edit_file', tool_info: { name: 'edit_file', parameters: { Path: '/w/b.txt', Target: 'old', Replacement: 'new' } } }),
    stepUpdate({ step_index: 4, state: 'ERROR', step_type: 'tool', tool_name: 'edit_file', tool_info: { name: 'edit_file', parameters: { Path: '/w/b.txt', Target: 'old', Replacement: 'new' }, error: { type: 'TOOL_ERROR', message: 'denied' } } }),
    resultEvent(undefined),
  ]])

  const tools = (await collect(driver, {})).filter((chunk) => chunk.type === 'tool-event')
  assert.deepEqual(tools.map((tool) => [tool.toolName, tool.status]), [
    ['write_file', 'running'],
    ['write_file', 'completed'],
    ['edit_file', 'running'],
    ['edit_file', 'failed'],
  ])
  assert.match(tools[0].callId, /^antigravity-[0-9a-f-]+-step-2$/u)
  assert.equal(tools[0].callId, tools[1].callId)
  assert.match(tools[2].callId, /^antigravity-[0-9a-f-]+-step-4$/u)
  assert.equal(tools[2].callId, tools[3].callId)
  // 只有路径的写入开始通知先等待详情，终态仍须保存真实路径。
  assert.equal(tools[0].input, undefined)
  assert.deepEqual(JSON.parse(tools[1].input), { file_path: '/w/a.txt' })
  assert.deepEqual(JSON.parse(tools[2].input), { file_path: '/w/b.txt', old_string: 'old', new_string: 'new' })
  driver.dispose()
})

test('Antigravity 每轮工具调用使用独立命名空间，并忽略已结算 step 的终态重放', async () => {
  const tool = (state: string, output?: string): Record<string, unknown> => stepUpdate({
    step_index: 1,
    state,
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: {
      name: 'run_command',
      ...(state === 'ACTIVE' ? { parameters: { CommandLine: 'pwd' } } : {}),
      ...(output === undefined ? {} : { output }),
    },
  })
  const { driver } = scriptedDriver([
    [tool('ACTIVE'), tool('DONE', 'first'), tool('DONE', 'replayed'), resultEvent(undefined)],
    [tool('ACTIVE'), tool('DONE', 'second'), resultEvent(undefined)],
  ])

  try {
    const first = (await collect(driver, {})).filter((chunk) => chunk.type === 'tool-event')
    const second = (await collect(driver, { providerSessionId: 'agy-provider-session' })).filter((chunk) => chunk.type === 'tool-event')
    assert.deepEqual(first.map((toolEvent) => [toolEvent.status, toolEvent.output]), [
      ['running', undefined],
      ['completed', 'first'],
    ])
    assert.deepEqual(second.map((toolEvent) => [toolEvent.status, toolEvent.output]), [
      ['running', undefined],
      ['completed', 'second'],
    ])
    assert.notEqual(first[0]?.callId, second[0]?.callId)
    assert.equal(first[0]?.callId, first[1]?.callId)
    assert.equal(second[0]?.callId, second[1]?.callId)
  } finally { driver.dispose() }
})

test('Antigravity 恢复会话首次只有累计用量时建立基线，不把历史累计量记为当前回合', async () => {
  const { driver } = scriptedDriver([
    [resultEvent({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 200, total_tokens: 110 })],
    [resultEvent({ input_tokens: 140, output_tokens: 15, cache_read_tokens: 500, total_tokens: 155 })],
  ])

  try {
    const first = await collect(driver, { providerSessionId: 'agy-provider-session' })
    const second = await collect(driver, { providerSessionId: 'agy-provider-session' })
    assert.equal(first.find((chunk) => chunk.type === 'usage'), undefined)
    const usage = second.find((chunk) => chunk.type === 'usage')
    assert.equal(usage.inputTokens, 40)
    assert.equal(usage.outputTokens, 5)
    assert.equal(usage.cacheReadTokens, 300)
  } finally { driver.dispose() }
})

test('Antigravity 任一累计桶回退时省略无法确认的差值，并在下一轮重新建立基线', async () => {
  const { driver } = scriptedDriver([
    [resultEvent({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 200, total_tokens: 110 })],
    [resultEvent({ input_tokens: 140, output_tokens: 15, cache_read_tokens: 150, total_tokens: 155 })],
    [resultEvent({ input_tokens: 150, output_tokens: 18, cache_read_tokens: 170, total_tokens: 175 })],
  ])

  try {
    await collect(driver, {})
    const rollback = await collect(driver, { providerSessionId: 'agy-provider-session' })
    const recovered = await collect(driver, { providerSessionId: 'agy-provider-session' })
    assert.equal(rollback.find((chunk) => chunk.type === 'usage'), undefined)
    const usage = recovered.find((chunk) => chunk.type === 'usage')
    assert.equal(usage.inputTokens, 10)
    assert.equal(usage.outputTokens, 3)
    assert.equal(usage.cacheReadTokens, 20)
  } finally { driver.dispose() }
})

test('Antigravity 失败回合的全零 usage 不清空既有累计基线', async () => {
  const { driver } = scriptedDriver([
    [resultEvent({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 200, total_tokens: 110 })],
    [resultEvent({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, { status: 'ERROR', error: 'invalid input' })],
    [resultEvent({ input_tokens: 140, output_tokens: 15, cache_read_tokens: 500, total_tokens: 155 })],
  ])

  try {
    await collect(driver, {})
    const failed = await collect(driver, { providerSessionId: 'agy-provider-session' })
    const recovered = await collect(driver, { providerSessionId: 'agy-provider-session' })
    assert.equal(failed.find((chunk) => chunk.type === 'usage'), undefined)
    const usage = recovered.find((chunk) => chunk.type === 'usage')
    assert.equal(usage.inputTokens, 40)
    assert.equal(usage.outputTokens, 5)
    assert.equal(usage.cacheReadTokens, 300)
  } finally { driver.dispose() }
})

test('Antigravity 最后一个 agent_response 缺少 usage 时不沿用旧调用的上下文占用', async () => {
  const { driver } = scriptedDriver([[
    agentResponseUsage(1, { input_tokens: 10, output_tokens: 1, cache_read_tokens: 80 }),
    stepUpdate({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '完成' }),
    resultEvent({ input_tokens: 30, output_tokens: 3, cache_read_tokens: 170, total_tokens: 33 }),
  ]], { contextWindow: 1_000 })

  try {
    const chunks = await collect(driver, { modelId: 'gemini-3.8-flash' })
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.equal(usage.contextWindow, 1_000)
    assert.equal(usage.contextTokens, undefined)
    assert.equal(usage.contextUsageRatio, undefined)
  } finally { driver.dispose() }
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

test('Antigravity 续接和并发执行复用 step_index 时，工具身份仍按执行隔离', async () => {
  const { driver } = scriptedDriver([[
    stepUpdate({ step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_info: { name: 'read_file', parameters: { Path: '/work/a.txt' } } }),
    stepUpdate({ step_index: 2, step_type: 'tool', state: 'DONE', tool_info: { name: 'read_file', output: 'ok' } }),
    resultEvent(undefined),
  ]])
  try {
    const input = { providerSessionId: 'agy-provider-session', prompt: '继续' }
    const turns = [await collect(driver, input), await collect(driver, input), ...await Promise.all([
      collect(driver, input), collect(driver, input),
    ])]
    const ids = turns.map((events) => {
      const tools = events.filter((event) => event.type === 'tool-event')
      assert.equal(tools.length, 2)
      assert.equal(tools[0].callId, tools[1].callId)
      assert.ok(tools[0].callId)
      return tools[0].callId
    })
    assert.equal(new Set(ids).size, turns.length)
  } finally { driver.dispose() }
})

test('Antigravity 缺少 tool_info 的状态更新仍沿用同一 step 的工具身份', async () => {
  const { driver } = scriptedDriver([[
    stepUpdate({ step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file', tool_info: { parameters: { Path: '/work/a.txt' } } }),
    stepUpdate({ step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'read_file' }),
    resultEvent(undefined),
  ]])
  try {
    const tools = (await collect(driver, {})).filter((event) => event.type === 'tool-event')
    assert.equal(tools.length, 2)
    assert.equal(tools[0].callId, tools[1].callId)
    assert.equal(tools[1].status, 'completed')
  } finally { driver.dispose() }
})

test('Antigravity 分步续读忽略已结算工具的重复终态，后续工具和正文不丢失', async () => {
  const tool = (index: number, state: string) => stepUpdate({
    step_index: index, step_type: 'tool', state,
    tool_info: { name: 'read_file', parameters: { Path: '/work/a.txt' }, ...(state === 'DONE' ? { output: 'ok' } : {}) },
  })
  const { driver, calls } = scriptedDriver([[
    tool(1, 'ACTIVE'), tool(1, 'DONE'), tool(1, 'DONE'),
    tool(2, 'ACTIVE'), tool(2, 'DONE'),
    resultEvent(undefined, { response: '最终答复' }),
  ]])
  const registry = new CodingNsCliAdapterRegistry([driver])
  const steps: CodingNsAgentEvent[][] = []
  try {
    for (let index = 0; index < 4; index += 1) {
      const events = []
      for await (const event of registry.execute({ adapterId: 'antigravity', sessionId: 'agy-session', messages: [], prompt: '执行', splitToolSteps: true })) events.push(event)
      steps.push(events)
      if (!events.some((event) => event.type === 'step-boundary')) break
    }
    assert.deepEqual(steps.map((events) => events.filter((event) => event.type === 'tool-event').length), [2, 2, 0])
    const ids = steps.slice(0, 2).map((events) => {
      const tools = events.filter((event) => event.type === 'tool-event')
      assert.equal(tools[0].callId, tools[1].callId)
      return tools[0].callId
    })
    assert.notEqual(ids[0], ids[1])
    assert.equal(steps.at(-1)?.filter((event) => event.type === 'text-delta').map((event) => event.text).join(''), '最终答复')
    assert.equal(calls.length, 1)
  } finally { await registry.dispose() }
})

test('Antigravity 从 stdout 加载目录并合并档位，只有诊断时返回可重试回退目录', async () => {
  const modelProbeCalls: string[][] = []
  const modelProbeOptions: Array<{ shell?: unknown; stdio?: unknown; env?: { PATH?: unknown } }> = []
  const driver = new AntigravityDriver({
    autoUpdater: { check() {}, dispose() {} },
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
        child.stdout.end(modelProbeCalls.length === 1 ? [
          'Warning: loading cached catalog',
          'magpie/hl/gpt-6-astra\tGPT-6 Astra',
          'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
          'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
          'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
          'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
          'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
          'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
        ].join('\n') : 'Warning: loading cached catalog\n')
        child.stderr.end('Fetching available models...\nWarning:\tloading cached catalog\n')
        child.emit('close', 0)
      })
      return child
    }) as never,
  })

  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'provider-default', name: '跟随 Antigravity 默认模型', efforts: [] },
    { id: 'magpie/hl/gpt-6-astra', name: 'GPT-6 Astra', efforts: [] },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', efforts: [] },
  ])
  assert.deepEqual(modelProbeCalls[0], ['fake-agy', 'models'])
  assert.deepEqual(modelProbeOptions[0]?.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(modelProbeOptions[0]?.shell, false)
  assert.equal(typeof modelProbeOptions[0]?.env?.PATH, 'string')
  const fallback = await driver.listModels()
  assert.equal(fallback.fallback, true)
  assert.deepEqual(fallback.groups[0]?.models.map(model => model.id), ['provider-default'])
  driver.dispose()
})

test('Antigravity 释放驱动时取消后台模型探测并返回可重试回退目录', async () => {
  let killed = false
  const driver = new AntigravityDriver({
    autoUpdater: { check() {}, dispose() {} },
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

test('Antigravity 成功态 result 携带上一轮遗留 error 时仍以 stop 结算并保留正文', async () => {
  const { driver } = scriptedDriver([[
    {
      event: 'result',
      result: {
        conversation_id: 'agy-stale-error',
        status: 'SUCCESS',
        response: '本轮结算文本',
        error: 'FAILED_PRECONDITION (code 400): User location is not supported for the API use.',
        num_turns: 1,
      },
    },
  ]])

  const chunks = await collect(driver, { sessionId: 'agy-stale-error', prompt: '继续' })

  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'agy-stale-error' },
    { type: 'text-delta', text: '本轮结算文本', messageId: 'assistant-antigravity-agy-stale-error-0' },
    { type: 'finish', reason: 'stop' },
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
  assert.deepEqual(chunks[2].failure, { message: '模型失败' })
  driver.dispose()
})

test('Antigravity 请求发出后取消，仍解析随后 ERROR 的用量并以 cancel 结算', async () => {
  const controller = new AbortController()
  const { driver, inputs } = scriptedDriver([[
    resultEvent({ input_tokens: 17, output_tokens: 3 }, { status: 'ERROR', error: 'user denied permission', response: '' }),
  ]], { onRequest: () => controller.abort() })
  try {
    const chunks = await collect(driver, { signal: controller.signal })
    assert.deepEqual(inputs.map(input => JSON.parse(input)), [{ event: 'user', message: { content: '你好' } }])
    assert.deepEqual(chunks.map(chunk => chunk.type), ['session-binding', 'usage', 'finish'])
    assert.equal(chunks[1].inputTokens, 17)
    assert.deepEqual(chunks[2], { type: 'finish', reason: 'cancel' })
  } finally { driver.dispose() }
})

test('Antigravity 子进程提前退出或 stdin 断开时不会触发宿主未捕获异常', async () => {
  const driver = new AntigravityDriver({
    autoUpdater: { check() {}, dispose() {} },
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

// 新版工具历史回归：覆盖驱动、Registry 分步与原生历史投影的完整链路。
function historySink() {
  const calls: Parameters<NonNullable<CodingNsNativeSessionBridge['appendToolCall']>>[1][] = []
  const results: Array<{
    callId: string
    result: Parameters<NonNullable<CodingNsNativeSessionBridge['appendToolResult']>>[1]
  }> = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'antigravity', sessionId: 'agy-session',
    nativeSessions: {
      appendToolCall(sessionId, call) {
        calls.push(call)
        return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: calls.length }
      },
      appendToolResult(handle, result) {
        results.push({ callId: handle.callId, result })
        return true
      },
    },
  })
  return { calls, results, projector }
}

test('Antigravity 同一 step 的 ACTIVE、更新和 DONE 只写入一条原生工具历史', async () => {
  const { driver } = scriptedDriver([[
    stepUpdate({ step_index: 0, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' } } }),
    stepUpdate({ step_index: 0, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', output: '/work' } }),
    stepUpdate({ step_index: 0, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { name: 'run_command', output: '/workspace' } }),
    resultEvent(undefined),
  ]])
  const sink = historySink()
  try {
    for await (const event of driver.executeTurn({ sessionId: 'agy-session', messages: [], prompt: '执行' })) {
      await sink.projector.push(event)
      if (event.type === 'tool-event' && event.status === 'running') assert.equal(sink.results.length, 0)
    }
    assert.equal(sink.calls.length, 1)
    assert.equal(sink.calls[0]?.name, 'bash')
    assert.deepEqual(JSON.parse(sink.calls[0]!.arguments), { command: 'pwd' })
    assert.deepEqual(sink.results, [{ callId: sink.calls[0]!.callId, result: { output: '/workspace', isError: false } }])
  } finally { driver.dispose() }
})

test('Antigravity 经 Registry 分步后并发工具整批结算，完成快照重放不再声明历史', async () => {
  const tool = (index: number, state: string, info: Record<string, unknown>) => stepUpdate({
    step_index: index, step_type: 'tool', state, tool_info: { name: 'run_command', ...info },
  })
  const { driver, calls: processes } = scriptedDriver([[
    tool(1, 'ACTIVE', { parameters: { CommandLine: 'pwd' } }),
    tool(2, 'ACTIVE', { parameters: { CommandLine: 'pwd' } }),
    tool(2, 'ACTIVE', { output: 'partial' }),
    tool(2, 'DONE', { output: 'second' }),
    tool(1, 'DONE', { output: 'first' }),
    tool(1, 'DONE', { output: 'first' }),
    tool(3, 'ACTIVE', { parameters: { CommandLine: 'pwd' } }),
    tool(3, 'DONE', { output: 'third' }),
    resultEvent(undefined),
  ]])
  const registry = new CodingNsCliAdapterRegistry([driver])
  const steps: ReturnType<typeof historySink>[] = []
  try {
    for (let index = 0; index < 5; index++) {
      const sink = historySink()
      steps.push(sink)
      let boundary = false
      for await (const event of registry.execute({ adapterId: 'antigravity', sessionId: 'agy-session', messages: [], prompt: '执行', splitToolSteps: true })) {
        await sink.projector.push(event)
        if (event.type === 'step-boundary') boundary = true
      }
      await sink.projector.complete()
      if (!boundary) break
    }
    assert.equal(steps.length, 3)
    assert.deepEqual(steps.map((sink) => sink.calls.length), [2, 1, 0])
    assert.deepEqual(steps.map((sink) => sink.results.map(({ result }) => result.output)), [['second', 'first'], ['third'], []])
    assert.equal(new Set(steps.flatMap((sink) => sink.calls.map((call) => call.callId))).size, 3)
    assert.ok(steps.flatMap((sink) => sink.calls).every((call) => call.name === 'bash' && JSON.parse(call.arguments).command === 'pwd'))
    assert.equal(processes.length, 1)
  } finally { await registry.dispose() }
})

test('Antigravity 恢复回合和并发回合复用 step_index 时仍使用独立身份', async () => {
  const { driver } = scriptedDriver([[
    stepUpdate({ step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_info: { name: 'read_file', parameters: { Path: '/workspace/a.txt' } } }),
    stepUpdate({ step_index: 2, step_type: 'tool', state: 'DONE', tool_info: { name: 'read_file' } }),
    resultEvent(undefined),
  ]])
  const sink = historySink()
  const input = { sessionId: 'agy-session', providerSessionId: 'agy-provider-session', messages: [], prompt: '继续' }
  try {
    const first = await collect(driver, input)
    const resumed = await collect(driver, input)
    const concurrent = await Promise.all([collect(driver, input), collect(driver, input)])
    const turns = [first, resumed, ...concurrent]
    const ids = turns.map((events) => events.find((event) => event.type === 'tool-event').callId)
    assert.equal(new Set(ids).size, 4)
    for (const events of turns) {
      // 同一个历史 sink 也不能将不同回合的索引复用误合并。
      for (const event of events.filter((event) => event.type === 'tool-event')) await sink.projector.push(event)
    }
    await sink.projector.complete()
    assert.equal(sink.calls.length, 4)
    assert.equal(sink.results.length, 4)
    assert.deepEqual(sink.results.map(({ callId }) => callId), sink.calls.map((call) => call.callId))
    assert.ok(sink.calls.every((call) => JSON.parse(call.arguments).file_path === '/workspace/a.txt'))
  } finally { driver.dispose() }
})
