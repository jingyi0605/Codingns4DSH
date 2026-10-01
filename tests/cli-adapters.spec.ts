import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CommandCodeDriver } from '../data/build/dist/host/cli-adapters/command-code-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { CommandCodeSubscriptionService } from '../data/build/dist/host/cli-adapters/command-code-subscription.js'
import { ClaudeCodeSubscriptionService, DeepseekSubscriptionService, OpenCodeSubscriptionService, ProviderSubscriptionService, Sub2ApiUsageService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'
import { identifyModelProvider, normalizeProviderBaseUrl } from '../data/build/dist/host/cli-adapters/provider-registry.js'
import { knownCodexContextWindow } from '../data/build/dist/host/cli-adapters/model-catalog.js'

test('Command Code 驱动只把带版本号的候选命令视为已安装', async () => {
  const calls: string[][] = []
  const driver = new CommandCodeDriver({
    binaries: ['missing-command', 'command-code'],
    spawnSync: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      return command === 'command-code'
        ? { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
        : { status: 127, stdout: '', stderr: '' }
    }) as never,
  })

  assert.deepEqual(await driver.detect(), { installed: true, version: '1.2.3', command: 'command-code' })
  assert.deepEqual(calls, [['missing-command', '--version'], ['command-code', '--version']])
})

test('Command Code 在桌面进程 PATH 缺失时通过登录 Shell 解析 CLI', async () => {
  const calls: string[][] = []
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
      calls.push([command, ...args])
      if (args[0] === '-ilc') return { status: 0, stdout: '/Users/test/.local/bin/command-code\n__CODINGNS_PATH__/opt/node/bin:/Users/test/.local/bin\n', stderr: '' }
      if (command === '/Users/test/.local/bin/command-code' && options?.env?.PATH?.includes('/opt/node/bin') === true) return { status: 0, stdout: 'command-code 2.0.0', stderr: '' }
      return { status: null, stdout: '', stderr: '' }
    }) as never,
  })

  assert.deepEqual(await driver.detect(), { installed: true, version: '2.0.0', command: '/Users/test/.local/bin/command-code' })
  assert.deepEqual(calls, [
    ['command-code', '--version'],
    [process.env.SHELL ?? '/bin/sh', '-ilc', 'command -v "$1"; printf "\\n__CODINGNS_PATH__%s\\n" "$PATH"', 'codingns4dsh-command-lookup', 'command-code'],
    ['/Users/test/.local/bin/command-code', '--version'],
  ])
})

test('Command Code 驱动解析模型分组和默认思考强度', async () => {
  const driver = new CommandCodeDriver({
    homeDirectory: '/definitely/missing',
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      assert.equal(command, 'command-code')
      return { status: 0, stdout: 'DeepSeek\ndeepseek/deepseek-v4-pro  fast\n\nAnthropic\nclaude-sonnet-5  sonnet', stderr: '' }
    }) as never,
    binaries: ['command-code'],
  })

  assert.deepEqual(await driver.listModels(), {
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek/deepseek-v4-pro', name: 'deepseek/deepseek-v4-pro', description: 'fast', efforts: ['high', 'max'] }] },
      { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-5', name: 'claude-sonnet-5', description: 'sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
    ],
    currentModel: null,
    currentEffort: null,
  })
})

test('Command Code 驱动识别完整模型目录和工具调用事件', async () => {
  const driver = new CommandCodeDriver({
    homeDirectory: '/definitely/missing',
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      if (args[0] === '--list-models') return {
        status: 0,
        stdout: 'OpenAI\ngpt-6-astra                            most capable\nqwen/qwen3.8-27b                       compact\n',
        stderr: '',
      }
      return { status: 0, stdout: '', stderr: '' }
    }) as never,
    binaries: ['command-code'],
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'gpt-6-astra', name: 'gpt-6-astra', description: 'most capable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'qwen/qwen3.8-27b', name: 'qwen/qwen3.8-27b', description: 'compact', efforts: ['low', 'medium', 'xhigh'] },
  ])
})

test('Command Code 的 BYOK 模型按末段回退拿到内置思考强度', async () => {
  const driver = new CommandCodeDriver({
    homeDirectory: '/definitely/missing',
    spawnSync: ((command: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      return {
        status: 0,
        stdout: 'McGrox (byok)\nmcgrox/deepseek-v4.1-flash             deepseek-v4.1-flash\n\nAnthropic\nclaude-sonnet-5  sonnet\n',
        stderr: '',
      }
    }) as never,
    binaries: ['command-code'],
  })
  const catalog = await driver.listModels()
  // BYOK 前缀不应再让强度落空：末段 deepseek-v4.1-flash 命中内置目录。
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'mcgrox/deepseek-v4.1-flash', name: 'mcgrox/deepseek-v4.1-flash', description: 'deepseek-v4.1-flash', efforts: ['low', 'high', 'max'] },
  ])
  // 无前缀的内置 id 行为不变。
  assert.deepEqual(catalog.groups[1]?.models, [
    { id: 'claude-sonnet-5', name: 'claude-sonnet-5', description: 'sonnet', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ])
})

test('Command Code 的 BYOK 模型优先采用 providers.json 声明的思考强度', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cmd-byok-'))
  try {
    writeFileSync(join(home, 'providers.json'), JSON.stringify({
      provider: {
        'my-gw': {
          baseURL: 'https://example.test/v1',
          models: {
            // 声明了内置目录没有的模型与自定义强度，且含非法值应被过滤。
            'custom-model': { reasoningEfforts: ['low', 'medium', 'max', 'bogus'] },
            // 声明为空数组视为未声明，回退内置目录。
            'deepseek-v4.1-flash': { reasoningEfforts: [] },
          },
        },
      },
    }))
    const driver = new CommandCodeDriver({
      homeDirectory: home,
      spawnSync: ((command: string, args: string[]) => {
        if (args[0] === '--version') return { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
        return {
          status: 0,
          stdout: 'My GW (byok)\nmy-gw/custom-model                     custom\nmy-gw/deepseek-v4.1-flash             deepseek-v4.1-flash\n',
          stderr: '',
        }
      }) as never,
      binaries: ['command-code'],
    })
    const catalog = await driver.listModels()
    assert.deepEqual(catalog.groups[0]?.models, [
      // providers.json 是权威来源；非法值 bogus 按 VALID_EFFORTS 过滤后保留其余。
      { id: 'my-gw/custom-model', name: 'my-gw/custom-model', description: 'custom', efforts: ['low', 'medium', 'max'] },
      // 空声明不算数，回退内置目录末段匹配。
      { id: 'my-gw/deepseek-v4.1-flash', name: 'my-gw/deepseek-v4.1-flash', description: 'deepseek-v4.1-flash', efforts: ['low', 'high', 'max'] },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Command Code 驱动写入历史 transcript、转换 JSON 事件并清理子进程', async () => {
  let receivedArgs: string[] = []
  let transcript = ''
  let killed = false
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: ((command: string, args: string[]) => {
      assert.equal(command, 'command-code')
      receivedArgs = args
      const transcriptPath = args[1]!
      transcript = readFileSync(transcriptPath, 'utf8')
      return {
        stdout: Readable.from([
          `${JSON.stringify({ type: 'event', event: { type: 'thinking_delta', delta: '思考' } })}\n`,
          `${JSON.stringify({ type: 'event', event: { type: 'text_delta', delta: '结果' } })}\n`,
          `${JSON.stringify({ type: 'event', event: { type: 'tool_use', id: 'call-1', name: 'read_directory', input: { path: '.' } } })}\n`,
          `${JSON.stringify({ type: 'result', finalText: '结果', usage: { inputTokens: 2, outputTokens: 3 } })}\n`,
        ]),
        stderr: { on() { return this } },
        kill() { killed = true; return true },
      }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({
    sessionId: 'session/1',
    messages: [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }],
    prompt: '现在的问题',
    cwd: '/workspace',
  })) chunks.push(chunk)

  assert.equal(receivedArgs[0], '--session')
  assert.equal(receivedArgs[2], '-p')
  assert.match(transcript, /之前的问题/u)
  assert.doesNotMatch(transcript, /现在的问题/u)
  assert.deepEqual(chunks, [
    { type: 'reasoning-delta', text: '思考', messageId: 'command-code-message-1' },
    { type: 'text-delta', text: '结果', messageId: 'command-code-message-1' },
    { type: 'tool-event', toolName: 'read_directory', callId: 'call-1', input: '{"path":"."}', status: 'running' },
    { type: 'usage', inputTokens: 2, outputTokens: 3 },
    { type: 'finish', reason: 'stop' },
  ])
  assert.equal(killed, true)
})

test('Command Code usage 保留缓存桶，并按完整输入计算未缓存输入', async () => {
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: (() => ({
      stdout: Readable.from([`${JSON.stringify({ type: 'result', finalText: '完成', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 5, total_tokens: 120 } })}\n`]),
      stderr: { on() { return this } },
      kill() { return true },
    })) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'cache-session', messages: [], prompt: '测试' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5, uncachedInputTokens: 55, totalTokens: 120, cacheHitRate: 40 },
    { type: 'text-delta', text: '完成', messageId: 'command-code-message-1' },
    { type: 'finish', reason: 'stop' },
  ])
})

test('Command Code 按 assistant 消息切换 DSH step 并只结算每次请求的 usage', async () => {
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.66.0', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: (() => ({
      stdout: Readable.from(commandCodeStreamLines()),
      stderr: { on() { return this } },
      kill() { return true },
    })) as never,
  })
  assert.equal(driver.supportsSegmentedTurns, true)

  const first = []
  for await (const chunk of driver.executeTurn({ sessionId: 'segmented-cc', messages: [], prompt: '先运行 pwd', splitToolSteps: true })) first.push(chunk)
  assert.deepEqual(first, [
    { type: 'session-binding', providerSessionId: 'cc-session-1' },
    { type: 'text-delta', text: '先检查', messageId: 'command-code-message-1' },
    { type: 'usage', inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0, uncachedInputTokens: 60, totalTokens: 110, cacheHitRate: 40 },
    { type: 'tool-event', toolName: 'shell_command', callId: 'call-a', input: '{"command":"pwd"}', status: 'started' },
    { type: 'tool-event', toolName: 'shell_command', callId: 'call-a', detail: 'pwd', status: 'running' },
    { type: 'tool-event', toolName: 'shell_command', callId: 'call-a', output: '[{"type":"text","text":"/workspace"}]', outputMode: 'snapshot', status: 'completed' },
    { type: 'step-boundary' },
  ])

  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'segmented-cc', messages: [], prompt: '继续', splitToolSteps: true, resumeSegmentedTurn: true })) second.push(chunk)
  assert.deepEqual(second, [
    { type: 'reasoning-delta', text: '整理结论', messageId: 'command-code-message-2' },
    { type: 'text-delta', text: '完成', messageId: 'command-code-message-2' },
    { type: 'usage', inputTokens: 180, outputTokens: 5, cacheReadTokens: 150, cacheWriteTokens: 0, uncachedInputTokens: 30, totalTokens: 185, cacheHitRate: 83.3333 },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Command Code 驱动显式抬高 --max-turns 并保留会话续跑参数', async () => {
  let receivedArgs: string[] = []
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.69.0', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: ((command: string, args: string[]) => {
      receivedArgs = args
      return {
        stdout: Readable.from([`${JSON.stringify({ type: 'result', subtype: 'success', stopReason: 'end_turn', finalText: 'ok', usage: { inputTokens: 1, outputTokens: 1 } })}\n`]),
        stderr: { on() { return this } },
        kill() { return true },
      }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'max-turns-args', messages: [], prompt: '执行', modelId: 'deepseek/deepseek-v4-flash-fast', effortId: 'high' })) chunks.push(chunk)

  // CLI 默认 --max-turns 100；驱动必须显式抬高预算，否则复杂任务会在半途被截断。
  assert.equal(receivedArgs[receivedArgs.indexOf('--max-turns') + 1], '500')
  assert.equal(receivedArgs[0], '--session')
  assert.equal(receivedArgs[2], '-p')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: 'stop' })
})

test('Command Code 撞到 --max-turns 时自动续跑并在次数用尽后按失败上报', async () => {
  const prompts: string[] = []
  let spawns = 0
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    autoContinueMaxAttempts: 2,
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.69.0', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: ((command: string, args: string[]) => {
      spawns += 1
      prompts.push(args[args.indexOf('-p') + 1]!)
      // 每次尝试都撞上限：CLI 输出 subtype=max_turns 的结果行并以 8 退出。
      return {
        stdout: Readable.from([
          `${JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId: 'capped-cc' } })}\n`,
          `${JSON.stringify({ type: 'event', event: { type: 'text_delta', delta: `第${spawns}段` } })}\n`,
          `${JSON.stringify({ type: 'event', event: { type: 'run_end', result: { stopReason: 'max_turns', usage: { inputTokens: 10, outputTokens: 2 } } } })}\n`,
          `${JSON.stringify({ type: 'result', subtype: 'max_turns', sessionId: 'capped-cc', stopReason: 'max_turns', finalText: '', usage: { inputTokens: 10, outputTokens: 2 } })}\n`,
        ]),
        stderr: { on() { return this } },
        kill() { return true },
        on(event: string, listener: (value: never) => void) { if (event === 'close') queueMicrotask(() => listener(8 as never)); return this },
      }
    }) as never,
  })

  const chunks: Array<{ type: string; text?: string; messageId?: string }> = []
  let failure: Error | null = null
  try {
    for await (const chunk of driver.executeTurn({ sessionId: 'capped-cc', messages: [], prompt: '复杂任务' })) {
      chunks.push(chunk as { type: string; text?: string })
    }
  } catch (error) {
    failure = error as Error
  }

  // 首次 + 2 次自动续跑：撞上限不是完成，必须继续把预算花在同一会话上。
  assert.equal(spawns, 3)
  assert.deepEqual(prompts, ['复杂任务', '继续', '继续'])
  // 每一段正文都保留；上限尝试不发 finish，避免“没做完却显示已完成”。
  // 消息身份跨续跑单调递增，新进程的正文不会被拼回上一条 assistant 消息。
  assert.deepEqual(chunks.filter(({ type }) => type === 'text-delta'), [
    { type: 'text-delta', text: '第1段', messageId: 'command-code-message-1' },
    { type: 'text-delta', text: '第2段', messageId: 'command-code-message-2' },
    { type: 'text-delta', text: '第3段', messageId: 'command-code-message-3' },
  ])
  assert.equal(chunks.some(({ type }) => type === 'finish'), false)
  // 次数用尽必须按失败上报，并带上可解释的错误码，而不是伪装成正常结束。
  assert.match(failure?.message ?? '', /COMMAND_CODE_MAX_TURNS/u)
  driver.dispose()
})

test('Command Code 撞到 --max-turns 后在续跑中完成时正常结束', async () => {
  let spawns = 0
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    autoContinueMaxAttempts: 2,
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.69.0', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: (() => {
      spawns += 1
      const lines = spawns === 1
        ? [
            `${JSON.stringify({ type: 'event', event: { type: 'text_delta', delta: '先做一半' } })}\n`,
            `${JSON.stringify({ type: 'result', subtype: 'max_turns', stopReason: 'max_turns', finalText: '', usage: { inputTokens: 10, outputTokens: 2 } })}\n`,
          ]
        : [
            `${JSON.stringify({ type: 'event', event: { type: 'text_delta', delta: '全部完成' } })}\n`,
            `${JSON.stringify({ type: 'result', subtype: 'success', stopReason: 'end_turn', finalText: '全部完成', usage: { inputTokens: 12, outputTokens: 4 } })}\n`,
          ]
      return {
        stdout: Readable.from(lines),
        stderr: { on() { return this } },
        kill() { return true },
        on(event: string, listener: (value: never) => void) { if (event === 'close') queueMicrotask(() => listener((spawns === 1 ? 8 : 0) as never)); return this },
      }
    }) as never,
  })

  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'resume-ok-cc', messages: [], prompt: '跑完它' })) chunks.push(chunk)

  assert.equal(spawns, 2)
  assert.deepEqual(chunks.filter(({ type }) => type === 'finish'), [{ type: 'finish', reason: 'stop' }])
  assert.equal(chunks.filter(({ type }) => type === 'text-delta').map((chunk) => (chunk as { text: string }).text).join(''), '先做一半全部完成')
  driver.dispose()
})

test('Command Code 未被 Host 声明为续段时不会复用上一次运行的进程', async () => {
  let spawns = 0
  const kills: number[] = []
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.66.0', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: (() => {
      spawns += 1
      const index = spawns
      return {
        stdout: Readable.from(index === 1 ? commandCodeStreamLines() : [`${JSON.stringify({ type: 'result', subtype: 'success', stopReason: 'end_turn', finalText: '新回合', usage: { inputTokens: 7, outputTokens: 3 } })}\n`]),
        stderr: { on() { return this } },
        kill() { kills.push(index); return true },
      }
    }) as never,
  })

  const first = []
  for await (const chunk of driver.executeTurn({ sessionId: 'stale-cc', messages: [], prompt: '执行', splitToolSteps: true })) first.push(chunk)
  assert.equal(first.at(-1)?.type, 'step-boundary')

  const second = []
  for await (const chunk of driver.executeTurn({ sessionId: 'stale-cc', messages: [], prompt: '新的用户回合', splitToolSteps: true })) second.push(chunk)
  assert.equal(spawns, 2)
  // 第一个（被挂起的）进程必须在启动新回合前就被终止，不能被旧流继续写入。
  assert.deepEqual(kills, [1, 2])
  assert.deepEqual(second, [
    { type: 'usage', inputTokens: 7, outputTokens: 3 },
    { type: 'text-delta', text: '新回合', messageId: 'command-code-message-1' },
    { type: 'finish', reason: 'stop' },
  ])
  driver.dispose()
})

test('Command Code 订阅服务只返回脱敏窗口并统一毫秒重置时间', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'codingns4dsh-command-code-subscription-'))
  writeFileSync(join(homeDirectory, 'auth.json'), JSON.stringify({ apiKey: 'secret-key' }), 'utf8')
  try {
    const service = new CommandCodeSubscriptionService({
      homeDirectory,
      fetch: (async (url: string, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-key')
        if (url.endsWith('/credits')) return new Response(JSON.stringify({ windowLimits: { fiveHour: { used: 2, cap: 10, resetAt: 1_700_000_000_000 }, weekly: { used: 5, cap: 20 } }, credits: { monthlyCredits: 8 } }), { status: 200 })
        return new Response(JSON.stringify({ data: { planId: 'individual-goat', currentPeriodEnd: '2026-10-01T00:00:00Z' } }), { status: 200 })
      }) as typeof fetch,
    })
    const result = await service.read()
    assert.equal(result?.authenticated, true)
    assert.equal(result?.planType, 'individual-goat')
    assert.equal(result?.resetCredits, null)
    assert.deepEqual(result?.primary, { usedPercent: 20, remainingPercent: 80, windowDurationMins: null, resetsAt: 1_700_000_000 })
    assert.deepEqual(result?.secondary, { usedPercent: 25, remainingPercent: 75, windowDurationMins: null, resetsAt: null })
    assert.deepEqual(result?.monthly, { usedPercent: 88.57142857142857, remainingPercent: 11.428571428571429, windowDurationMins: null, resetsAt: 1_790_812_800, remainingCredits: 8, totalCredits: 70 })
    assert.equal(result?.rateLimitReachedType, null)
    assert.equal(typeof result?.capturedAt, 'string')
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('Claude Code 订阅服务读取 OAuth 用量并且不返回访问令牌', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'codingns4dsh-claude-subscription-'))
  writeFileSync(join(homeDirectory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-secret', subscriptionType: 'max' } }), 'utf8')
  try {
    const service = new ClaudeCodeSubscriptionService({
      homeDirectory,
      fetch: (async (_url: string, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer oauth-secret')
        return new Response(JSON.stringify({ five_hour: { utilization: 23, resets_at: '2026-09-23T12:00:00Z' }, seven_day: { utilization: 48, resets_at: 1_800_000_000 } }), { status: 200 })
      }) as typeof fetch,
    })
    const result = await service.read()
    assert.equal(result?.primary?.remainingPercent, 77)
    assert.equal(result?.secondary?.remainingPercent, 52)
    assert.equal(result?.planType, 'max')
    assert.doesNotMatch(JSON.stringify(result), /oauth-secret/u)
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('官方 DeepSeek 订阅服务读取多币种余额并且不返回 API key', async () => {
  const service = new DeepseekSubscriptionService({
    sources: [{ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'deepseek-secret' }],
    fetch: (async (url: string, init?: RequestInit) => {
      assert.equal(url, 'https://api.deepseek.com/user/balance')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer deepseek-secret')
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '97.08', granted_balance: '0.00', topped_up_balance: '97.08' },
          { currency: 'USD', total_balance: '13.63', granted_balance: '1.00', topped_up_balance: '12.63' },
        ],
      }), { status: 200 })
    }) as typeof fetch,
  })
  const result = await service.read()
  assert.equal(result?.deepseek?.isAvailable, true)
  assert.deepEqual(result?.deepseek?.balances[1], { currency: 'USD', totalBalance: 13.63, grantedBalance: 1, toppedUpBalance: 12.63 })
  assert.equal(result?.deepseek?.upstreamUrl, 'https://api.deepseek.com')
  assert.equal(result?.provider?.id, 'deepseek')
  assert.equal(result?.provider?.capability, 'official-balance')
  assert.doesNotMatch(JSON.stringify(result), /deepseek-secret/u)
})

test('模型提供商必须按名称和 baseURL 联合识别', () => {
  assert.equal(normalizeProviderBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com')
  assert.equal(identifyModelProvider({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })?.id, 'deepseek')
  assert.equal(identifyModelProvider({ name: 'deepseek', baseUrl: 'https://proxy.example.test/v1' }), undefined)
  assert.equal(identifyModelProvider({ name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })?.reader, 'deepseek-balance')
  assert.equal(identifyModelProvider({ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })?.id, 'openrouter')
  assert.equal(identifyModelProvider({ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })?.reader, 'openrouter-balance')
})

test('DSH 官方来源走 DeepSeek 余额接口，第三方来源仍走 Sub2API', async () => {
  let officialCalls = 0
  const official = new ProviderSubscriptionService({
    deepseek: {
      sources: [{ baseUrl: 'https://api.deepseek.com', apiKey: 'official-secret' }],
      fetch: (async () => {
        officialCalls += 1
        return new Response(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: 4.2 }] }), { status: 200 })
      }) as typeof fetch,
    },
    sub2api: { sources: {}, fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch },
  })
  assert.equal((await official.read('dsh', 'deepseek-official'))?.deepseek?.balances[0]?.totalBalance, 4.2)
  assert.ok(officialCalls >= 1)

  let sub2apiCalls = 0
  const upstream = new ProviderSubscriptionService({
    sub2api: {
      sources: { dsh: { baseUrl: 'https://sub2api.example.test', apiKey: 'upstream-secret' } },
      fetch: (async (url: string) => {
        if (url === 'https://sub2api.example.test/logo.svg') return new Response('', { status: 404 })
        if (url.startsWith('https://cdn.simpleicons.org/')) return new Response('', { status: 404 })
        sub2apiCalls += 1
        assert.equal(url, 'https://sub2api.example.test/v1/usage')
        return new Response(JSON.stringify({ balance: 10, usage: { today: {}, total: {} } }), { status: 200 })
      }) as typeof fetch,
    },
    deepseek: { fetch: (async () => { throw new Error('不应请求官方接口') }) as typeof fetch },
  })
  assert.equal((await upstream.read('dsh', 'glor'))?.sub2api?.balance, 10)
  assert.equal(sub2apiCalls, 1)
})

test('Sub2API 用量服务映射账户统计并计算缓存命中率且不返回密钥', async () => {
  const service = new Sub2ApiUsageService({
    sources: { codex: { baseUrl: 'https://upstream.example.test', apiKey: 'sub2api-secret' } },
    fetch: (async (url: string, init?: RequestInit) => {
      if (url === 'https://upstream.example.test/logo.svg') {
        assert.equal(new Headers(init?.headers).get('authorization'), null)
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"><path fill="red"/></svg>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })
      }
      assert.equal(url, 'https://upstream.example.test/v1/usage')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sub2api-secret')
      return new Response(JSON.stringify({
        balance: 100,
        remaining: 99.5,
        unit: 'USD',
        planName: '钱包余额',
        mode: 'unrestricted',
        daily_usage: [{ date: '2026-09-23', requests: 10, input_tokens: 100, output_tokens: 20, cache_read_tokens: 900, total_tokens: 1020, cost: 1.2 }],
        model_stats: [{ model: 'gpt-5', requests: 10, input_tokens: 100, output_tokens: 20, cache_read_tokens: 900, total_tokens: 1020, cost: 1.2 }],
        usage: {
          today: { requests: 10, input_tokens: 100, output_tokens: 20, cache_read_tokens: 900, total_tokens: 1020, cost: 1.2 },
          total: { requests: 100, input_tokens: 1000, output_tokens: 200, cache_read_tokens: 9000, total_tokens: 10200, cost: 12 },
          rpm: 3,
          tpm: 400,
          average_duration_ms: 250,
        },
      }), { status: 200 })
    }) as typeof fetch,
  })

  const result = await service.read('codex')
  assert.equal(result?.sub2api?.upstreamType, 'Sub2API')
  assert.equal(result?.sub2api?.upstreamUrl, 'https://upstream.example.test')
  assert.equal(result?.sub2api?.balance, 100)
  assert.equal(result?.sub2api?.remaining, 99.5)
  assert.equal(result?.sub2api?.today.cacheHitRate, 90)
  assert.equal(result?.sub2api?.total.cacheHitRate, 90)
  assert.equal(result?.sub2api?.models[0]?.model, 'gpt-5')
  assert.equal(result?.sub2api?.logoUrl, 'https://upstream.example.test/logo.svg')
  assert.match(result?.sub2api?.logoDataUrl ?? '', /^data:image\/svg\+xml;base64,/u)
  assert.doesNotMatch(JSON.stringify(result), /sub2api-secret/u)
})

test('Sub2API 非成功响应不产生订阅组件数据', async () => {
  const service = new Sub2ApiUsageService({
    sources: { grok: { baseUrl: 'https://upstream.example.test/v1', apiKey: 'secret' } },
    fetch: (async (url: string) => {
      assert.equal(url, 'https://upstream.example.test/v1/usage')
      return new Response('{}', { status: 401 })
    }) as typeof fetch,
  })
  assert.equal(await service.read('grok'), null)
})

test('Codex 检测到第三方上游但 Sub2API 不可用时不回退官方订阅', async () => {
  let officialReaderCalled = false
  const service = new ProviderSubscriptionService({
    sub2api: {
      sources: { codex: { baseUrl: 'https://upstream.example.test', apiKey: 'secret' } },
      fetch: (async () => new Response('{}', { status: 502 })) as typeof fetch,
    },
    codex: {
      homeDirectory: '/definitely/missing',
      binaries: ['codex'],
      spawnSync: (() => {
        officialReaderCalled = true
        return { status: 127, stdout: '', stderr: '' }
      }) as never,
    },
  })
  assert.equal(await service.read('codex'), null)
  assert.equal(officialReaderCalled, false)
})

test('Codex 官方来源允许 Sub2API 探测失败后回退原生订阅', () => {
  const service = new Sub2ApiUsageService({
    sources: { codex: { baseUrl: 'https://api.openai.com/v1', apiKey: 'official-key' } },
  })
  assert.equal(service.hasThirdPartySource('codex'), false)
})

test('Codex 配置读取 model provider 的第三方 base_url 和 bearer token', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'codingns4dsh-codex-provider-'))
  const previousHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = homeDirectory
  writeFileSync(join(homeDirectory, 'config.toml'), [
    'model_provider = "custom"',
    '',
    '[model_providers.custom]',
    'base_url = "https://upstream.example.test"',
    'experimental_bearer_token = "provider-secret"',
  ].join('\n'), 'utf8')
  try {
    const service = new Sub2ApiUsageService({
      fetch: (async (url: string, init?: RequestInit) => {
        assert.equal(url, 'https://upstream.example.test/v1/usage')
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer provider-secret')
        return new Response('{}', { status: 401 })
      }) as typeof fetch,
    })
    assert.equal(await service.read('codex'), null)
    assert.equal(service.hasThirdPartySource('codex'), true)
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousHome
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('OpenCode 订阅服务只识别本地认证而不伪造额度', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'codingns4dsh-opencode-subscription-'))
  writeFileSync(join(homeDirectory, 'auth.json'), JSON.stringify({ deepseek: { type: 'api', key: 'provider-secret' } }), 'utf8')
  try {
    const result = await new OpenCodeSubscriptionService({ homeDirectory }).read()
    assert.equal(result, null)
  } finally {
    rmSync(homeDirectory, { recursive: true, force: true })
  }
})

test('Command Code 累积快照经公共消息投影层只输出新增后缀和最后一次 usage', async () => {
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.2.3', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: (() => ({
      stdout: Readable.from([
        `${JSON.stringify({ type: 'event', event: { type: 'message', message: { content: [{ type: 'thinking', thinking: 'The user asks.' }] }, usage: { inputTokens: 1, outputTokens: 1 } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'thinking', thinking: 'The user asks.' }] }, usage: { inputTokens: 2, outputTokens: 2 } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'thinking', thinking: 'The user asks. Let me inspect.' }] }, usage: { inputTokens: 3, outputTokens: 3 } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'tool_use', id: 'call-1', name: 'read_directory', input: { path: '.' } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'tool_result', id: 'call-1', name: 'read_directory', output: 'file.txt' } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'tool_denied', id: 'call-2', name: 'shell', input: { command: 'sudo true' }, reason: '权限不足' } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message', message: { content: [{ type: 'text', text: 'I' }] }, usage: { inputTokens: 4, outputTokens: 4 } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'text', text: "I'll" }] }, usage: { inputTokens: 5, outputTokens: 5 } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'text', text: "I'll list" }] }, usage: { inputTokens: 6, outputTokens: 6 } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'text', text: "I'll list the " }, { type: 'text', text: 'current directory.' }] }, usage: { inputTokens: 7, outputTokens: 7 } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'text', text: "I'll list the current directory." }] }, usage: { inputTokens: 8, outputTokens: 8 } } })}\n`,
        `${JSON.stringify({ type: 'result', finalText: "I'll list the current directory.", usage: { inputTokens: 9, outputTokens: 10 } })}\n`,
      ]),
      stderr: { on() { return this } },
      kill() { return true },
    })) as never,
  })
  const registry = new CodingNsCliAdapterRegistry([driver])
  const chunks = []
  const projector = new CodingNsDshMessageProjector({ adapterId: 'command-code', sessionId: 'snapshot-session' })

  for await (const event of registry.execute({
    adapterId: 'command-code',
    sessionId: 'snapshot-session',
    messages: [],
    prompt: '列出当前目录',
    cwd: '/workspace',
  })) chunks.push(...await projector.push(event))

  assert.deepEqual(chunks.filter((chunk) => chunk.codingnsExternalTool === undefined), [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'The user asks.' },
    { type: 'reasoning-delta', index: 0, text: ' Let me inspect.' },
    { type: 'block-start', index: 2, blockType: 'reasoning' },
    { type: 'block-end', index: 2, block: { type: 'reasoning', text: ' ' } },
    { type: 'block-start', index: 3, blockType: 'reasoning' },
    { type: 'block-end', index: 3, block: { type: 'reasoning', text: ' ' } },
    { type: 'block-start', index: 4, blockType: 'reasoning' },
    { type: 'block-end', index: 4, block: { type: 'reasoning', text: ' ' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'I' },
    { type: 'text-delta', index: 1, text: "'ll" },
    { type: 'text-delta', index: 1, text: ' list' },
    { type: 'text-delta', index: 1, text: ' the current directory.' },
    { type: 'usage', usage: { inputTokens: 9, outputTokens: 10 } },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The user asks. Let me inspect.' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: "I'll list the current directory." } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('Command Code 真实会话模式中的多工具边界和 reasoning 改写不会终止会话或吞并正文', async () => {
  const driver = new CommandCodeDriver({
    binaries: ['command-code'],
    spawnSync: ((command: string, args: string[]) => args[0] === '--version'
      ? { status: 0, stdout: 'command-code 1.62.1', stderr: '' }
      : { status: 0, stdout: '', stderr: '' }) as never,
    spawn: (() => ({
      stdout: Readable.from([
        `${JSON.stringify({ type: 'event', event: { type: 'message', message: { content: [{ type: 'thinking', thinking: 'stage A' }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message', message: { content: [{ type: 'text', text: "I'll check." }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'tool_use', id: 'read-1', name: 'read_directory', input: { path: '/workspace' } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'tool_result', id: 'read-1', name: 'read_directory', output: [{ type: 'text', text: 'Found 2 items' }] } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message', message: { content: [{ type: 'thinking', thinking: 'stage B' }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'thinking', thinking: 'stage X' }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'thinking', thinking: 'stage X plus' }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message', message: { content: [{ type: 'text', text: 'Now build.' }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'tool_use', id: 'shell-1', name: 'shell_command', input: { command: 'true' } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'tool_result', id: 'shell-1', name: 'shell_command', output: '' } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message', message: { content: [{ type: 'thinking', thinking: 'stage C' }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'thinking', thinking: 'stoge C' }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'thinking', thinking: 'stoge C done' }] } } })}\n`,
        `${JSON.stringify({ type: 'event', event: { type: 'message', message: { content: [{ type: 'text', text: 'Found' }] }, usage: { inputTokens: 10, outputTokens: 20 } } })}\n`,
        `${JSON.stringify({ type: 'result', finalText: 'Found', usage: { inputTokens: 11, outputTokens: 21 } })}\n`,
      ]),
      stderr: { on() { return this } },
      kill() { return true },
    })) as never,
  })
  const registry = new CodingNsCliAdapterRegistry([driver])
  const chunks = []
  const projector = new CodingNsDshMessageProjector({ adapterId: 'command-code', sessionId: 'real-pattern' })

  for await (const event of registry.execute({
    adapterId: 'command-code',
    sessionId: 'real-pattern',
    messages: [],
    prompt: '创建页面',
    cwd: '/workspace',
  })) chunks.push(...await projector.push(event))

  const durableChunks = chunks.filter((chunk) => chunk.codingnsExternalTool === undefined)
  // 每条 assistant 消息自成一段：推理改写只输出新增后缀，下一条消息不会被拼进上一条的正文块。
  assert.deepEqual(durableChunks.filter(({ type }) => type === 'reasoning-delta'), [
    { type: 'reasoning-delta', index: 0, text: 'stage A' },
    { type: 'reasoning-delta', index: 4, text: 'stage B' },
    { type: 'reasoning-delta', index: 4, text: ' plus' },
    { type: 'reasoning-delta', index: 8, text: 'stage C' },
    { type: 'reasoning-delta', index: 8, text: ' done' },
  ])
  assert.deepEqual(durableChunks.filter(({ type }) => type === 'text-delta'), [
    { type: 'text-delta', index: 1, text: "I'll check." },
    { type: 'text-delta', index: 5, text: 'Now build.' },
    { type: 'text-delta', index: 9, text: 'Found' },
  ])
  assert.deepEqual(durableChunks.filter(({ type }) => type === 'usage'), [
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 21 } },
  ])
  assert.deepEqual(durableChunks.slice(-2), [
    { type: 'block-end', index: 9, block: { type: 'text', text: 'Found' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('Agent 注册表隔离会话配置并拒绝未知 Agent', async () => {
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
  }])

  assert.deepEqual(registry.setSession('s1', { adapterId: 'fake', modelId: 'm1' }), { adapterId: 'fake', modelId: 'm1' })
  assert.deepEqual(registry.getSession('s1'), { adapterId: 'fake', modelId: 'm1' })
  assert.deepEqual(registry.getSession('s2'), { adapterId: 'dsh' })
  assert.throws(() => registry.setSession('s1', { adapterId: 'missing' }), /Agent 不可用/u)
})

test('Agent 注册表允许把会话切回内置 DSH Agent', () => {
  const registry = new CodingNsCliAdapterRegistry([])
  assert.deepEqual(registry.setSession('session-dsh', { adapterId: 'dsh' }), { adapterId: 'dsh' })
  assert.deepEqual(registry.getSession('session-dsh'), { adapterId: 'dsh' })
})

test('外部 Agent 可以单独停用并阻止模型目录和会话绑定', async () => {
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } },
  }])

  assert.equal((await registry.catalog())[0]?.enabled, true)
  registry.setEnabled('fake', false)
  assert.equal((await registry.catalog())[0]?.enabled, false)
  await assert.rejects(registry.models('fake'), /Agent 已停用/u)
  assert.throws(() => registry.setSession('disabled-agent', { adapterId: 'fake' }), /Agent 已停用/u)
  assert.deepEqual(registry.getSession('disabled-agent'), { adapterId: 'dsh' })
})

test('Registry 为普通适配器在工具完成处切分 step 并继续消费同一条 Provider 流', async () => {
  let starts = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      starts += 1
      yield { type: 'text-delta', text: '工具前' } as const
      yield { type: 'tool-event', toolName: 'shell', callId: 'call-1', status: 'running' } as const
      yield { type: 'tool-event', toolName: 'shell', callId: 'call-1', output: '完成', outputMode: 'snapshot', status: 'completed' } as const
      yield { type: 'text-delta', text: '最终正文' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const input = { adapterId: 'fake' as const, sessionId: 'segmented-fake', messages: [], prompt: '执行', splitToolSteps: true }
  const first = []
  for await (const event of registry.execute(input)) first.push(event)
  const second = []
  for await (const event of registry.execute(input)) second.push(event)

  assert.equal(starts, 1)
  assert.deepEqual(first.map(({ type }) => type), ['text-delta', 'tool-event', 'tool-event', 'step-boundary'])
  assert.deepEqual(second, [
    { type: 'text-delta', text: '最终正文' },
    { type: 'finish', reason: 'stop' },
  ])

  // 续段消费完成后必须撤销登记：下一条用户消息不能复用已经耗尽的旧迭代器。
  const third = []
  for await (const event of registry.execute(input)) third.push(event)
  assert.equal(starts, 2)
  assert.deepEqual(third.map(({ type }) => type), ['text-delta', 'tool-event', 'tool-event', 'step-boundary'])
  await registry.dispose()
})

test('自行分段的驱动只在切分边界后收到续段意图，丢弃时同步清理驱动状态', async () => {
  const resumes: Array<boolean | undefined> = []
  const discarded: string[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    supportsSegmentedTurns: true,
    discardSegmentedTurn(sessionId: string) { discarded.push(sessionId) },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input: { readonly resumeSegmentedTurn?: boolean }) {
      resumes.push(input.resumeSegmentedTurn)
      if (input.resumeSegmentedTurn !== true) {
        yield { type: 'tool-event', toolName: 'shell', callId: 'call-1', status: 'completed' } as const
        yield { type: 'step-boundary' } as const
        return
      }
      yield { type: 'text-delta', text: '收尾正文' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const input = { adapterId: 'codex' as const, sessionId: 'resume-protocol', messages: [], prompt: '执行', splitToolSteps: true }

  const first = []
  for await (const event of registry.execute(input)) first.push(event)
  assert.deepEqual(first.map(({ type }) => type), ['tool-event', 'step-boundary'])

  const second = []
  for await (const event of registry.execute(input)) second.push(event)
  assert.deepEqual(second.map(({ type }) => type), ['text-delta', 'finish'])
  assert.deepEqual(resumes, [undefined, true])

  // 再次切分后由 Host 丢弃：必须通知驱动结束悬挂运行，且下一次执行重新开始。
  const third = []
  for await (const event of registry.execute(input)) third.push(event)
  assert.equal(third.at(-1)?.type, 'step-boundary')
  registry.discardSegmentedTurn('resume-protocol')
  assert.deepEqual(discarded, ['resume-protocol'])

  const fourth = []
  for await (const event of registry.execute(input)) fourth.push(event)
  assert.equal(resumes.at(-1), undefined)
  await registry.dispose()
})

test('Pi 适配器即使 DSH 原生 step 注入可用也不启用分段模式', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let splitToolSteps: boolean | undefined
  const injected: string[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'pi', name: 'Pi Agent' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      splitToolSteps = input.splitToolSteps
      yield { type: 'tool-event', toolName: 'shell', callId: 'call-1', status: 'completed' } as const
      yield { type: 'text-delta', text: '后续正文' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      supportsEvents: false,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      async listRemote() { return [] },
      async ensure() { return null },
      async flush() {},
      injectNextStep(sessionId) {
        injected.push(sessionId)
        return true
      },
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'pi-segmented', adapterId: 'pi' })

  const chunks = []
  for await (const chunk of listener!({ sessionId: 'pi-segmented', messages: [{ role: 'user', content: '执行工具' }] }, async function* () {})) chunks.push(chunk)

  assert.equal(splitToolSteps, undefined)
  assert.deepEqual(injected, [])
  assert.equal(chunks.at(-1)?.type, 'finish')
  await features.disable('cliAdapters')
})

test('CLI 功能模块登记 cli RPC，停用后注销命名空间', async () => {
  const table = new CodingNsRpcTable()
  const registry = new CodingNsCliAdapterRegistry([])
  const features = new FeatureRegistry({ rpc: table })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  assert.deepEqual(table.namespaces(), ['cli'])
  assert.deepEqual(await table.resolve('cli/catalog')?.handler('catalog', {}), [])
  await features.disable('cliAdapters')
  assert.deepEqual(table.namespaces(), [])
})

test('CLI 功能模块向 DSH 注册外部 Provider 的图片能力，流仍由 llm/stream 接管', async () => {
  const table = new CodingNsRpcTable()
  let registeredProviders: string[] = []
  let disposed = false
  let virtualAdapter: {
    resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; inputModalities: readonly string[] }>
  } | undefined
  const llm = {
    registerAdapter(providers: string[], adapter: typeof virtualAdapter & Record<string, unknown>) {
      // DSH 0.2 在首次注册路由时会同步读取这两个可选契约；真实运行时若缺少
      // providerRetryPolicy，cliAdapters 会在登记 cli RPC 之前启动失败。
      const contract = adapter as unknown as {
        providerRetryPolicy(provider: string): unknown
        imageRequestPricing(provider: string, model: string): unknown
      }
      contract.providerRetryPolicy(providers[0] ?? 'codex')
      contract.imageRequestPricing(providers[0] ?? 'codex', 'gpt-5.5')
      registeredProviders = [...providers]
      virtualAdapter = adapter as NonNullable<typeof virtualAdapter>
      const registration = (() => { disposed = true }) as (() => void) & { replace?: (next: string[]) => void }
      registration.replace = (next) => { registeredProviders = [...next] }
      return registration
    },
  }
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } as const },
  }])
  const features = new FeatureRegistry({
    rpc: table,
    dshContext: { get(name: string) { return name === 'llm' ? llm : undefined } } as never,
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')

  assert.deepEqual(registeredProviders, ['codex'])
  assert.notEqual(virtualAdapter, undefined)
  assert.deepEqual(await virtualAdapter!.resolveModel('codex', 'gpt-5.5'), {
    provider: 'codex',
    id: 'gpt-5.5',
    name: 'gpt-5.5',
    inputModalities: ['text', 'image'],
  })

  await features.disable('cliAdapters')
  assert.equal(disposed, true)
})

test('CLI 功能模块按会话配置接管 llm/stream，并保留默认 DSH 流的旁路行为', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let capturedPrompt = ''
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      capturedPrompt = input.prompt
      yield { type: 'text-delta', text: '来自 CLI' }
      yield { type: 'finish', reason: 'stop' }
      yield { type: 'text-delta', text: '不应出现在 finish 之后' }
      yield { type: 'finish', reason: 'stop' }
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 's1', adapterId: 'fake' })
  assert.notEqual(listener, undefined)

  const chunks = []
  for await (const chunk of listener!({
    sessionId: 's1',
    messages: [
      { role: 'user', source: { kind: 'plugin', plugin: 'dsh-system-prompt', form: 'catalog' }, content: '不应发送给外部 Agent' },
      { role: 'user', source: { kind: 'user' }, content: '你好' },
    ],
  }, async function* () { yield { type: 'text-delta', text: '默认' } })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '来自 CLI' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '来自 CLI' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(capturedPrompt, '你好')

  const passthrough = []
  for await (const chunk of listener!({ sessionId: 'unknown', messages: [] }, async function* () { yield { type: 'text-delta', text: '默认' } })) passthrough.push(chunk)
  assert.deepEqual(passthrough, [{ type: 'text-delta', text: '默认' }])

  const dshSelection = []
  for await (const chunk of listener!({
    sessionId: 'dsh-selection',
    modelSelection: {
      lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      next: { provider: 'deepseek', model: 'deepseek-next', reasoningEffort: 'low' },
    },
  }, async function* () { yield { type: 'text-delta', text: '默认 DSH' } })) dshSelection.push(chunk)
  assert.deepEqual(dshSelection, [{ type: 'text-delta', text: '默认 DSH' }])
  assert.deepEqual(registry.getSession('dsh-selection'), {
    adapterId: 'dsh',
    modelId: 'deepseek-chat',
    effortId: 'high',
    providerId: 'deepseek',
  })
  await features.disable('cliAdapters')
  assert.equal(listener, undefined)
})

test('fork 子会话从继承的历史推断外部适配器时，不得把 DSH 主模型写入外部 Agent', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const received: { prompt: string; modelId?: string }[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      received.push({ prompt: input.prompt, ...(input.modelId === undefined ? {} : { modelId: input.modelId }) })
      yield { type: 'text-delta', text: 'Codex 回复' }
      yield { type: 'finish', reason: 'stop' }
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')

  // fork 子会话：继承的历史里有父会话的外部 Agent 消息（provider=codex），
  // 但本轮 DSH 路由仍然是主模型 glor/deepseek-v4.1-flash。
  // 修复前这段历史会让 Codex 接管，同时把 deepseek-v4.1-flash 当成 Codex 模型，
  // thread/start 直接 404，会话再也无法继续。
  const chunks: unknown[] = []
  for await (const chunk of listener!({
    sessionId: 'fork-child',
    modelSelection: {
      lastUsed: { provider: 'glor', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    },
    messages: [
      { role: 'assistant', source: { kind: 'model', plugin: 'codingns4dsh', provider: 'codex', model: 'codex' }, content: '父会话的外部 Agent 回复' },
      { role: 'user', source: { kind: 'user' }, content: '继续' },
    ],
  }, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) chunks.push(chunk)

  assert.equal(received.length, 1)
  assert.equal(received[0]?.prompt, '继续')
  // 关键断言：绝不能把 DSH 主模型名透给 Codex。
  assert.notEqual(received[0]?.modelId, 'deepseek-v4.1-flash')
  assert.equal(chunks.some((chunk) => (chunk as { type?: string }).type === 'text-delta'), true)
  // 绑定必须落盘为 codex，且不得留下 DSH 主模型。
  assert.deepEqual(registry.getSession('fork-child'), { adapterId: 'codex' })
  await features.disable('cliAdapters')
})

test('DSH 请求明确携带外部 provider 时恢复外部适配器路由', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const calls: string[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      calls.push(input.prompt)
      yield { type: 'text-delta', text: '第二轮由 Codex 处理' }
      yield { type: 'finish', reason: 'stop' }
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  const chunks = []
  for await (const chunk of listener!({
    sessionId: 'dsh-restored-codex',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', source: { kind: 'user' }, content: '继续' }],
  }, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) chunks.push(chunk)
  assert.equal(calls[0], '继续')
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === '第二轮由 Codex 处理'), true)
  await features.disable('cliAdapters')
})

test('DSH 首轮选择 Codex 后，未携带 provider 的第二轮仍沿用 Codex', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const prompts: string[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      prompts.push(input.prompt)
      yield { type: 'text-delta', text: `Codex: ${input.prompt}` }
      yield { type: 'finish', reason: 'stop' }
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')

  const first: unknown[] = []
  for await (const chunk of listener!({
    sessionId: 'dsh-codex-persist',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', source: { kind: 'user' }, content: '第一轮' }],
  }, async function* () {})) first.push(chunk)
  const second: unknown[] = []
  for await (const chunk of listener!({
    sessionId: 'dsh-codex-persist',
    messages: [{ role: 'user', source: { kind: 'user' }, content: '第二轮' }],
  }, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) second.push(chunk)

  assert.deepEqual(prompts, ['第一轮', '第二轮'])
  assert.equal(first.some((chunk) => (chunk as { type?: string }).type === 'text-delta'), true)
  assert.equal(second.some((chunk) => (chunk as { type?: string }).type === 'text-delta'), true)
  assert.equal(registry.getSession('dsh-codex-persist').adapterId, 'codex')
  await features.disable('cliAdapters')
})

test('DSH 从 modelSelection.pending 和历史消息恢复 Codex 路由', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const prompts: string[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      prompts.push(input.prompt)
      yield { type: 'text-delta', text: 'Codex 回复' }
      yield { type: 'finish', reason: 'stop' }
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')

  const first: unknown[] = []
  for await (const chunk of listener!({
    sessionId: 'dsh-codex-shape',
    modelSelection: { pending: { provider: 'codex', model: 'gpt-5.6-sol' } },
    messages: [{ role: 'user', source: { kind: 'user' }, content: '第一轮' }],
  }, async function* () {})) first.push(chunk)
  const second: unknown[] = []
  for await (const chunk of listener!({
    sessionId: 'dsh-codex-shape',
    messages: [
      { role: 'assistant', source: { kind: 'model', plugin: 'codingns4dsh', provider: 'codex' }, content: '上一轮回复' },
      { role: 'user', source: { kind: 'user' }, content: '第二轮' },
    ],
  }, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) second.push(chunk)

  assert.deepEqual(prompts, ['第一轮', '第二轮'])
  assert.equal(second.some((chunk) => (chunk as { type?: string }).type === 'text-delta'), true)
  await features.disable('cliAdapters')
})

test('DSH 原生 Provider 只有 finish(stop) 时输出明确错误而不是空正常终态', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature())
  await features.start('cliAdapters')
  const chunks = []
  for await (const chunk of listener!({ sessionId: 'native-empty', provider: 'deepseek-official' }, async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) chunks.push(chunk)
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && String(chunk.text).includes('CODINGNS_PROVIDER_EMPTY_RESPONSE')), true)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'error', failure: { message: 'CODINGNS_PROVIDER_EMPTY_RESPONSE: DSH Provider 未返回任何有效事件。', code: 'PROVIDER_ERROR' } } })
  await features.disable('cliAdapters')
})

test('分段适配器的 step 边界必须在 DSH finish 前注入下一个 step', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const order: string[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    supportsSegmentedTurns: true,
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      assert.equal(input.splitToolSteps, true)
      yield { type: 'step-boundary' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      async ensure() { return null },
      async flush() {},
      appendRequestContext() { return true },
      injectNextStep() {
        order.push('inject')
        return true
      },
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'codex-step-order', adapterId: 'codex' })

  const chunks = []
  for await (const chunk of listener!({ sessionId: 'codex-step-order', messages: [{ role: 'user', content: '执行工具' }] }, async function* () {})) {
    chunks.push(chunk)
    if (chunk.type === 'finish') assert.deepEqual(order, ['inject'])
  }
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
  await features.disable('cliAdapters')
})

test('Codex 在原生会话不可注入下一步时不启用分段模式', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let splitToolSteps: boolean | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    supportsSegmentedTurns: true,
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      splitToolSteps = input.splitToolSteps
      yield { type: 'tool-event', toolName: 'shell', callId: 'call-1', status: 'completed' } as const
      yield { type: 'text-delta', text: '工具完成后的正文' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      supportsEvents: false,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      async listRemote() { return [] },
      async ensure() { return null },
      async flush() {},
      canInjectNextStep() { return false },
      injectNextStep() { throw new Error('不应调用注入') },
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'codex-no-injection', adapterId: 'codex' })

  const chunks = []
  for await (const chunk of listener!({ sessionId: 'codex-no-injection', messages: [{ role: 'user', content: '执行工具' }] }, async function* () {})) chunks.push(chunk)

  assert.equal(splitToolSteps, undefined)
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === '工具完成后的正文'), true)
  assert.equal(chunks.at(-1)?.type, 'finish')
  await features.disable('cliAdapters')
})

test('OpenCode 不按工具完成切分 DSH step，Command Code 与 Codex 一样允许分段', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const splitToolSteps = new Map<string, boolean | undefined>()
  const injected: string[] = []
  const drivers = ['opencode', 'command-code'].map((adapterId) => ({
    descriptor: { id: adapterId, name: adapterId },
    // 真实 CommandCodeDriver 声明 supportsSegmentedTurns；这里用假驱动复现该契约。
    ...(adapterId === 'command-code' ? { supportsSegmentedTurns: true } : {}),
    async detect() { return { installed: true, version: '1.0.0', command: adapterId } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input: { readonly splitToolSteps?: boolean }) {
      splitToolSteps.set(adapterId, input.splitToolSteps)
      yield { type: 'tool-event', toolName: 'shell', callId: `${adapterId}-call`, status: 'completed' } as const
      yield { type: 'text-delta', text: '后续正文' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }))
  const registry = new CodingNsCliAdapterRegistry(drivers)
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      async ensure() { return null },
      async flush() {},
      appendRequestContext() { return true },
      injectNextStep(sessionId) {
        injected.push(sessionId)
        return true
      },
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')

  for (const adapterId of ['opencode', 'command-code']) {
    const sessionId = `${adapterId}-stable-step`
    await table.resolve('cli/session/set')?.handler('session/set', { sessionId, adapterId })
    const chunks = []
    for await (const chunk of listener!({ sessionId, messages: [{ role: 'user', content: '执行工具' }] }, async function* () {})) chunks.push(chunk)
    assert.equal(chunks.at(-1)?.type, 'finish')
  }

  assert.deepEqual([...splitToolSteps.entries()], [['opencode', undefined], ['command-code', true]])
  assert.deepEqual(injected, [])
  await features.disable('cliAdapters')
})

test('Codex 连续 50 个工具事件后仍可接收第二条用户消息且不注入 step 提示', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const prompts: string[] = []
  const injected: string[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    supportsSegmentedTurns: true,
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input: { readonly prompt: string }) {
      prompts.push(input.prompt)
      for (let index = 0; index < 50; index += 1) {
        yield { type: 'tool-event', toolName: 'shell', callId: `call-${index}`, status: 'completed' } as const
      }
      yield { type: 'text-delta', text: '完成' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      async ensure() { return null },
      async flush() {},
      appendRequestContext() { return true },
      injectNextStep(sessionId) {
        injected.push(sessionId)
        return true
      },
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'codex-fifty-tools', adapterId: 'codex' })

  const first = []
  for await (const chunk of listener!({ sessionId: 'codex-fifty-tools', messages: [{ role: 'user', content: '第一条' }] }, async function* () {})) first.push(chunk)
  const second = []
  for await (const chunk of listener!({ sessionId: 'codex-fifty-tools', messages: [{ role: 'user', content: '第二条' }] }, async function* () {})) second.push(chunk)

  assert.equal(first.at(-1)?.type, 'finish')
  assert.equal(second.at(-1)?.type, 'finish')
  assert.deepEqual(prompts, ['第一条', '第二条'])
  assert.deepEqual(injected, [])
  await features.disable('cliAdapters')
})

test('Codex 新会话在首个 usage 到达前也使用 256K 上下文窗口', async () => {
  const contexts: unknown[] = []
  const nativeSessions = {
    available: true,
    store: undefined,
    controller: undefined,
    get() { return { header: { cwd: '/workspace' } } },
    list() { return [] },
    async ensure() { return null },
    async flush() {},
    appendRequestContext(_sessionId: string, context: unknown) {
      contexts.push(context)
      return true
    },
    subscribe() { return () => {} },
  }
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'text-delta', text: '首轮响应' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }], {}, { nativeSessions })

  const chunks = []
  for await (const chunk of registry.execute({
    adapterId: 'codex',
    sessionId: 'codex-new-context',
    modelId: 'gpt-5.6-sol',
    messages: [],
    prompt: '第一句话',
  })) chunks.push(chunk)

  assert.deepEqual(contexts, [{
    provider: 'codex',
    model: 'gpt-5.6-sol',
    contextWindow: 258400,
    confirmed: true,
    source: 'catalog',
  }])
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('Codex 已知模型表覆盖当前主力模型并容忍大小写与空白', () => {
  assert.equal(knownCodexContextWindow('gpt-5.6-sol'), 258400)
  assert.equal(knownCodexContextWindow('gpt-6.1-sol'), 258400)
  assert.equal(knownCodexContextWindow(' GPT-6-Astra '), 258400)
  assert.equal(knownCodexContextWindow('unknown-model'), undefined)
  assert.equal(knownCodexContextWindow(undefined), undefined)
})

test('CLI 功能模块把异常和取消映射成 DSH 原生终止原因且不会留下运行中工具', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      yield { type: 'tool-event', toolName: 'shell', callId: 'call-active', status: 'running' } as const
      if (input.signal?.aborted) yield { type: 'finish', reason: 'cancel' } as const
      else throw new Error('失败内容\n~~~\n不能逃出代码块')
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'terminal-dsh', adapterId: 'fake' })

  const failed = []
  for await (const chunk of listener!({ sessionId: 'terminal-dsh', messages: [{ role: 'user', content: '执行' }] }, async function* () {})) failed.push(chunk)
  assert.equal(failed.at(-1)?.type, 'finish')
  assert.deepEqual(failed.at(-1)?.reason, {
    kind: 'error',
    failure: { message: '失败内容\n~~~\n不能逃出代码块', code: 'PROVIDER_ERROR' },
  })
  assert.equal(failed.filter(({ type }) => type === 'finish').length, 1)
  assert.match(failed.map(({ text }) => text ?? '').join(''), /~~~~text/u)

  const controller = new AbortController()
  controller.abort()
  const cancelled = []
  for await (const chunk of listener!({ sessionId: 'terminal-dsh', signal: controller.signal, messages: [{ role: 'user', content: '取消' }] }, async function* () {})) cancelled.push(chunk)
  assert.deepEqual(cancelled.at(-1), {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: '外部 Agent 执行已取消', code: 'ABORTED' } },
  })
  await features.disable('cliAdapters')
})

test('CLI 功能模块只把快照新增后缀转换成 DSH delta 并只输出最新 usage', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      yield { type: 'reasoning-snapshot', text: '思' } as const
      yield { type: 'reasoning-snapshot', text: '思考' } as const
      yield { type: 'reasoning-snapshot', text: '思考' } as const
      yield { type: 'reasoning-snapshot', text: '思叉' } as const
      yield { type: 'reasoning-snapshot', text: '思叉新增' } as const
      yield { type: 'text-snapshot', text: 'I' } as const
      yield { type: 'text-snapshot', text: "I'll" } as const
      yield { type: 'usage', inputTokens: 1, outputTokens: 2 } as const
      yield { type: 'usage', inputTokens: 3, outputTokens: 4 } as const
      yield { type: 'text-snapshot', text: "I'll" } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({ rpc: table, events })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'snapshot-dsh', adapterId: 'fake' })

  const chunks = []
  for await (const chunk of listener!({ sessionId: 'snapshot-dsh', messages: [{ role: 'user', content: '继续' }] }, async function* () {})) chunks.push(chunk)

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '思' },
    { type: 'reasoning-delta', index: 0, text: '考' },
    { type: 'reasoning-delta', index: 0, text: '新增' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'I' },
    { type: 'text-delta', index: 1, text: "'ll" },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考新增' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: "I'll" } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await features.disable('cliAdapters')
})

test('CLI 功能模块把 Provider 折叠进 inputTokens 的缓存折算成 DSH 互斥桶', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const samples: unknown[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() {
      // Codex / Command Code 口径：inputTokens 已包含缓存读取，未缓存输入单列。
      yield { type: 'usage', inputTokens: 182936, outputTokens: 126, cacheReadTokens: 182016, cacheWriteTokens: 0, uncachedInputTokens: 920, totalTokens: 183062 } as const
      yield { type: 'text-delta', text: '完成' } as const
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      async ensure() { return null },
      async flush() {},
      appendUsageSample(sessionId, usage) { samples.push({ sessionId, usage }); return true },
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'usage-buckets', adapterId: 'codex' })

  const chunks = []
  for await (const chunk of listener!({ sessionId: 'usage-buckets', messages: [{ role: 'user', content: '执行' }] }, async function* () {})) chunks.push(chunk)

  // DSH 计费输入 = 未缓存 + 缓存读写 = Provider 的完整输入 182936，命中率 99.4971%。
  assert.deepEqual(chunks.filter(({ type }) => type === 'usage'), [{
    type: 'usage',
    usage: { inputTokens: 920, outputTokens: 126, cacheReadTokens: 182016, cacheWriteTokens: 0, totalTokens: 183062 },
  }])
  assert.deepEqual(samples, [{
    sessionId: 'usage-buckets',
    usage: { inputTokens: 920, outputTokens: 126, cacheReadTokens: 182016, cacheWriteTokens: 0, totalTokens: 183062 },
  }])
  assert.equal(chunks.at(-1)?.type, 'finish')
  await features.disable('cliAdapters')
})

test('CLI 功能模块从 DSH 会话头传递工作目录并把统一工具事件交给公共原生投影层', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let receivedCwd: string | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      receivedCwd = input.cwd
      yield { type: 'tool-event', toolName: 'read_directory', callId: 'call-1', input: '{"path":"."}', status: 'running' }
      yield { type: 'tool-event', toolName: 'read_directory', callId: 'call-1', output: 'file.txt', outputMode: 'snapshot', status: 'completed' }
      yield { type: 'finish', reason: 'stop' }
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const nativeCalls: unknown[] = []
  const nativeResults: unknown[] = []
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      store: undefined,
      controller: undefined,
      get() { return { header: { cwd: '/workspace/project' } } },
      list() { return [] },
      async ensure() { return null },
      async flush() {},
      appendToolCall(sessionId, call) {
        nativeCalls.push({ sessionId, call })
        return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: 10 }
      },
      appendToolResult(handle, result) {
        nativeResults.push({ handle, result })
        return true
      },
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 's-cwd', adapterId: 'fake' })
  const chunks = []
  for await (const chunk of listener!({ sessionId: 's-cwd', messages: [{ role: 'user', content: '读取目录' }] }, async function* () {})) chunks.push(chunk)
  assert.equal(receivedCwd, '/workspace/project')
  assert.deepEqual(chunks, [
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(nativeCalls, [{
    sessionId: 's-cwd',
    call: { callId: 'call-1', name: 'read_directory', arguments: '{"path":"."}', adapterId: 'fake' },
  }])
  assert.deepEqual(nativeResults, [{
    handle: { sessionId: 's-cwd', turn: 1, step: 1, callId: 'call-1', callSeq: 10 },
    result: { output: 'file.txt', isError: false },
  }])
  await features.disable('cliAdapters')
})

test('CLI 功能模块解析 DSH 图片和文件附件并传给外部驱动', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let received: { prompt: string; attachments?: readonly { kind: string; path: string; name?: string }[] } | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      received = input
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const dshContext = {
    get(name: string): unknown {
      if (name === 'attachments') return {
        imageHostPath: () => '/dsh/attachments/photo.png',
        fileHostPath: () => '/dsh/attachments/readme.md',
      }
      if (name === 'fs') return { processPathFromHostPath: (path: string) => `/process${path}` }
      return undefined
    },
  }
  const features = new FeatureRegistry({ rpc: table, events, dshContext: dshContext as never })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'codex-attachments', adapterId: 'codex' })

  for await (const _chunk of listener!({
    sessionId: 'codex-attachments',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '请检查附件。' },
        { type: 'image', attachment: { attachmentId: 'sha256:image', mediaType: 'image/png', name: 'photo.png' } },
        { type: 'file', attachment: { attachmentId: 'sha256:file', name: 'readme.md', bytes: 12 } },
      ],
    }],
  }, async function* () {})) { /* 消费完整流 */ }

  assert.deepEqual(received, {
    adapterId: 'codex',
    sessionId: 'codex-attachments',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '请检查附件。' },
        { type: 'image', attachment: { attachmentId: 'sha256:image', mediaType: 'image/png', name: 'photo.png' } },
        { type: 'file', attachment: { attachmentId: 'sha256:file', name: 'readme.md', bytes: 12 } },
      ],
    }],
    prompt: '请检查附件。\n\n附件文件「readme.md」位于：/process/dsh/attachments/readme.md\n请使用工具读取该文件的内容。',
    attachments: [
      { kind: 'image', path: '/process/dsh/attachments/photo.png', name: 'photo.png', mimeType: 'image/png' },
      { kind: 'file', path: '/process/dsh/attachments/readme.md', name: 'readme.md' },
    ],
  })
  await features.disable('cliAdapters')
})

/**
 * 本机 Command Code 1.66.0 的 `--output-format json` 事件序列：
 * 一个进程连续跑两个 agent turn，第一个 turn 调用工具，第二个 turn 收尾。
 */
function commandCodeStreamLines(): string[] {
  const event = (value: unknown): string => `${JSON.stringify({ type: 'event', event: value })}\n`
  const requestUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0 }
  const finalUsage = { inputTokens: 180, outputTokens: 5, cacheReadTokens: 150, cacheWriteTokens: 0 }
  return [
    event({ type: 'run_start', sessionId: 'cc-session-1' }),
    event({ type: 'turn_start', turnNumber: 1 }),
    event({ type: 'message_start' }),
    event({ type: 'text_delta', delta: '先检查' }),
    event({ type: 'message_update', content: [{ type: 'text', text: '先检查' }] }),
    event({ type: 'model_request_end', model: 'm', usage: requestUsage, stopReason: 'tool_use' }),
    event({ type: 'message_end', content: [{ type: 'text', text: '先检查' }] }),
    event({ type: 'tool_queued', toolCallId: 'call-a', toolName: 'shell_command', input: { command: 'pwd' } }),
    event({ type: 'tool_running', toolCallId: 'call-a', toolName: 'shell_command', description: 'pwd' }),
    event({ type: 'tool_completed', toolCallId: 'call-a', toolName: 'shell_command', result: [{ type: 'text', text: '/workspace' }] }),
    event({ type: 'turn_end', turnNumber: 1, hadToolCalls: true, usage: requestUsage }),
    event({ type: 'turn_start', turnNumber: 2 }),
    event({ type: 'message_start' }),
    event({ type: 'thinking_delta', delta: '整理结论' }),
    event({ type: 'text_delta', delta: '完成' }),
    event({ type: 'message_update', content: [{ type: 'thinking', thinking: '整理结论' }, { type: 'text', text: '完成' }] }),
    event({ type: 'model_request_end', model: 'm', usage: finalUsage, stopReason: 'end_turn' }),
    event({ type: 'message_end', content: [{ type: 'thinking', thinking: '整理结论' }, { type: 'text', text: '完成' }] }),
    event({ type: 'turn_end', turnNumber: 2, hadToolCalls: false, usage: finalUsage }),
    event({ type: 'run_end', result: { finalText: '完成', stopReason: 'end_turn', turnCount: 2, usage: { inputTokens: 280, outputTokens: 15, cacheReadTokens: 190, cacheWriteTokens: 0 } } }),
    `${JSON.stringify({ type: 'result', subtype: 'success', sessionId: 'cc-session-1', stopReason: 'end_turn', usage: { inputTokens: 280, outputTokens: 15, cacheReadTokens: 190, cacheWriteTokens: 0 }, durationMs: 123, finalText: '完成' })}\n`,
  ]
}

test('DSH 会话权限状态随轮次下发驱动，缺省字段按未读到处理', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let received: Record<string, unknown> | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      received = input
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const session = { id: 'codex-permission' }
  const dshContext = {
    get(name: string): unknown {
      if (name === 'agents') return { get: (id: string) => id === 'codex-permission' ? { session } : undefined }
      if (name === 'sandboxPolicy') return { resolve: (request: { session?: unknown }) => ({ mode: request.session === session ? 'danger-full-access' : 'read-only', workspaceRoot: '/tmp' }) }
      if (name === 'approval') return { overrideOf: () => 'never', config: { policy: 'ask' } }
      if (name === 'permissionPresets') return { current: () => 'danger-full-access' }
      return undefined
    },
  }
  const features = new FeatureRegistry({ rpc: table, events, dshContext: dshContext as never })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'codex-permission', adapterId: 'codex' })

  for await (const _chunk of listener!({ sessionId: 'codex-permission', messages: [{ role: 'user', content: '检查权限' }] }, async function* () {})) { /* 消费完整流 */ }

  assert.deepEqual(received?.permission, {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    preset: 'danger-full-access',
  })
  await features.disable('cliAdapters')
})

test('DSH 权限服务不可用时不下发权限字段，驱动沿用保守默认', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let received: Record<string, unknown> | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      received = input
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  // 精简 Host 可能没有装载权限服务；探测失败必须留空，而不是推断为完全权限。
  const dshContext = { get: () => undefined }
  const features = new FeatureRegistry({ rpc: table, events, dshContext: dshContext as never })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  await table.resolve('cli/session/set')?.handler('session/set', { sessionId: 'codex-no-permission', adapterId: 'codex' })

  for await (const _chunk of listener!({ sessionId: 'codex-no-permission', messages: [{ role: 'user', content: '检查权限' }] }, async function* () {})) { /* 消费完整流 */ }

  assert.equal(received?.permission, undefined)
  await features.disable('cliAdapters')
})

test('stage0 形态：fork 子会话被识别为父会话的外部 Agent，而不是默认 DSH 会话', async () => {
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const handled: string[] = []

  // 真实 stage0 日志形态：外部 Agent 只回了一段文本、没调工具，因此日志里
  // 完全没有 codingns4dsh 痕迹，只有继承下来的 request/context。
  const parent = {
    id: 'stage0-parent',
    header: { id: 'stage0-parent', cwd: '/workspace', createdAt: 1790738653345, isSeeded: false },
    snapshotEvents: () => [
      { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { type: 'request/context', data: { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' } },
      { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    ],
  }
  const child = {
    id: 'stage0-child',
    header: { id: 'stage0-child', cwd: '/workspace', createdAt: 1790819437613, isSeeded: true, parentSession: 'stage0-parent' },
    snapshotEvents: () => [
      { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      { type: 'request/context', data: { provider: 'command-code', model: 'deepseek/deepseek-v4.1-flash' } },
      { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    ],
  }

  const sessionStore = new CodingNsCliSessionStore()
  // 父会话此前由用户在界面上显式选择过 command-code。
  sessionStore.upsert('stage0-parent', { adapterId: 'command-code', modelId: 'deepseek/deepseek-v4.1-flash' })
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'command-code', name: 'Command Code' },
    async detect() { return { installed: true, version: '1.0.0', command: 'cc' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      handled.push(input.prompt)
      yield { type: 'text-delta', text: '来自 Command Code' }
      yield { type: 'finish', reason: 'stop' }
    },
  }], {}, { sessionStore })

  const events = {
    on(_name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      listener = next
      return () => { listener = undefined }
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    nativeSessions: {
      available: true,
      supportsEvents: false,
      store: undefined,
      controller: undefined,
      get(sessionId: string) {
        if (sessionId === 'stage0-child') return child
        if (sessionId === 'stage0-parent') return parent
        return undefined
      },
      // 子会话已加载，父会话尚未进入 list()：祖先链必须按 header 补齐。
      list() { return [child] },
      async listRemote() { return [] },
      async ensure() { return null },
      async flush() {},
      subscribe() { return () => {} },
    },
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')

  const chunks: unknown[] = []
  for await (const chunk of listener!({
    sessionId: 'stage0-child',
    modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    messages: [
      { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' }, content: '父会话回复' },
      { role: 'user', source: { kind: 'user' }, content: '继续' },
    ],
  }, async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) chunks.push(chunk)

  // 关键断言：子会话被路由到原来的外部 Agent，而不是回落到 DSH 主会话。
  assert.deepEqual(handled, ['继续'])
  assert.equal(chunks.some((chunk) => (chunk as { type?: string; text?: string }).type === 'text-delta'), true)
  assert.equal(registry.getSession('stage0-child').adapterId, 'command-code')
  // DSH 主模型名绝不能进入外部 Agent。
  assert.notEqual(registry.getSession('stage0-child').modelId, 'deepseek-flash')
  await features.disable('cliAdapters')
})

test('委派 RPC 允许任务留空，交由派发内核回退到最近一条用户消息', async () => {
  const table = new CodingNsRpcTable()
  const features = new FeatureRegistry({ rpc: table })
  features.register(createCliAdaptersFeature({ registry: new CodingNsCliAdapterRegistry([]) }))
  await features.start('cliAdapters')
  const handler = table.resolve('cli/delegate')?.handler

  // popupSelect 打开时焦点在弹层，草稿里往往只剩 `/委派` 本身，prompt 因此是空串。
  // 这里必须放行到派发内核（由它回退到最近一条人类消息），而不是在参数校验就抛错，
  // 否则用户会看到「prompt 不能为空」而完全无法委派。
  const result = await handler?.('delegate', { sessionId: 'session-delegate-empty', adapterId: 'codex', prompt: '' }) as Record<string, unknown> | undefined
  assert.notEqual(result, undefined)
  assert.equal(result?.ok, false)
  // 缺少可续子代理/原生会话桥接时返回可读诊断，绝不能是参数校验错误。
  assert.doesNotMatch(String(result?.error ?? ''), /prompt 不能为空/u)

  // 显式传入非字符串仍要拒绝，避免把类型错误静默当成空任务。
  await assert.rejects(
    async () => { await handler?.('delegate', { sessionId: 'session-delegate-empty', adapterId: 'codex', prompt: 42 }) },
    /prompt 必须是字符串/u,
  )
  await features.disable('cliAdapters')
})
