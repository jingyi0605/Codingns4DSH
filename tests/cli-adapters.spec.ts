import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createCliAdaptersFeature } from '../dist/host/cli-adapters/feature.js'
import { CommandCodeDriver } from '../dist/host/cli-adapters/command-code-driver.js'
import { CodingNsDshMessageProjector } from '../dist/host/cli-adapters/dsh-message-projector.js'
import { CodingNsCliAdapterRegistry } from '../dist/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../dist/host/rpc-table.js'
import { FeatureRegistry } from '../dist/features/registry.js'
import { CommandCodeSubscriptionService } from '../dist/host/cli-adapters/command-code-subscription.js'
import { ClaudeCodeSubscriptionService, OpenCodeSubscriptionService, ProviderSubscriptionService, Sub2ApiUsageService } from '../dist/host/cli-adapters/provider-subscription.js'

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
    { type: 'reasoning-delta', text: '思考' },
    { type: 'text-delta', text: '结果' },
    { type: 'tool-event', toolName: 'read_directory', callId: 'call-1', input: '{"path":"."}', status: 'running' },
    { type: 'usage', inputTokens: 2, outputTokens: 3 },
    { type: 'text-snapshot', text: '结果' },
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
      stdout: Readable.from([`${JSON.stringify({ type: 'result', finalText: '完成', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 5 } })}\n`]),
      stderr: { on() { return this } },
      kill() { return true },
    })) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'cache-session', messages: [], prompt: '测试' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5, uncachedInputTokens: 55, totalTokens: 120, cacheHitRate: 40 },
    { type: 'text-snapshot', text: '完成' },
    { type: 'finish', reason: 'stop' },
  ])
})

test('Command Code 订阅服务只返回脱敏窗口并统一毫秒重置时间', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'dsh-codingns-command-code-subscription-'))
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
  const homeDirectory = mkdtempSync(join(tmpdir(), 'dsh-codingns-claude-subscription-'))
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

test('Sub2API 用量服务映射账户统计并计算缓存命中率且不返回密钥', async () => {
  const service = new Sub2ApiUsageService({
    sources: { codex: { baseUrl: 'https://upstream.example.test', apiKey: 'sub2api-secret' } },
    fetch: (async (url: string, init?: RequestInit) => {
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

test('OpenCode 订阅服务只识别本地认证而不伪造额度', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'dsh-codingns-opencode-subscription-'))
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
    { type: 'reasoning-delta', index: 0, text: 'The user asks.' },
    { type: 'reasoning-delta', index: 0, text: ' Let me inspect.' },
    { type: 'text-delta', index: 1, text: 'I' },
    { type: 'text-delta', index: 1, text: "'ll" },
    { type: 'text-delta', index: 1, text: ' list' },
    { type: 'text-delta', index: 1, text: ' the current directory.' },
    { type: 'usage', usage: { inputTokens: 9, outputTokens: 10 } },
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
  assert.deepEqual(durableChunks.filter(({ type }) => type === 'reasoning-delta'), [
    { type: 'reasoning-delta', index: 0, text: 'stage A' },
    { type: 'reasoning-delta', index: 0, text: 'stage B' },
    { type: 'reasoning-delta', index: 0, text: ' plus' },
    { type: 'reasoning-delta', index: 0, text: 'stage C' },
    { type: 'reasoning-delta', index: 0, text: ' done' },
  ])
  assert.deepEqual(durableChunks.filter(({ type }) => type === 'text-delta'), [
    { type: 'text-delta', index: 1, text: "I'll check." },
    { type: 'text-delta', index: 1, text: 'Now build.' },
    { type: 'text-delta', index: 1, text: 'Found' },
  ])
  assert.deepEqual(durableChunks.slice(-2), [
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 21 } },
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
    { type: 'text-delta', index: 1, text: '来自 CLI' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(capturedPrompt, '你好')

  const passthrough = []
  for await (const chunk of listener!({ sessionId: 'unknown', messages: [] }, async function* () { yield { type: 'text-delta', text: '默认' } })) passthrough.push(chunk)
  assert.deepEqual(passthrough, [{ type: 'text-delta', text: '默认' }])
  await features.disable('cliAdapters')
  assert.equal(listener, undefined)
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
    { type: 'reasoning-delta', index: 0, text: '思' },
    { type: 'reasoning-delta', index: 0, text: '考' },
    { type: 'reasoning-delta', index: 0, text: '新增' },
    { type: 'text-delta', index: 1, text: 'I' },
    { type: 'text-delta', index: 1, text: "'ll" },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
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
    call: { callId: 'call-1', name: 'read_directory', arguments: '{"path":"."}' },
  }])
  assert.deepEqual(nativeResults, [{
    handle: { sessionId: 's-cwd', turn: 1, step: 1, callId: 'call-1', callSeq: 10 },
    result: { output: 'file.txt', isError: false },
  }])
  await features.disable('cliAdapters')
})
