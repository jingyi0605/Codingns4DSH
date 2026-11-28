import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process'
import { ProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'
import {
  AntigravitySubscriptionService,
  antigravityQuotaGroupPrefix,
  parseAntigravityUsageOutput,
} from '../data/build/dist/host/cli-adapters/antigravity-subscription.js'
import {
  antigravityModelIdFromLabel,
  antigravitySupportsEffort,
  antigravityUsageExcludesCacheFromInput,
  knownAntigravityContextWindow,
  resolveAntigravityModelId,
} from '../data/build/dist/host/cli-adapters/model-catalog.js'

/** agy JSON /usage command.data has the same grouped bucket shape as the TUI. */
const QUOTA_SUMMARY = {
  groups: [
    {
      buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-07T05:47:33Z', remainingFraction: 0.99079525 },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-10-05T19:09:53Z', remainingFraction: 0.9799962 },
      ],
      displayName: 'Gemini Models',
    },
    {
      buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', resetTime: '2026-10-12T14:56:40Z', remainingFraction: 0.9812164 },
        { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', resetTime: '2026-10-05T19:56:40Z', remainingFraction: 0.9724328 },
      ],
      displayName: 'Claude and GPT models',
    },
    {
      buckets: [
        { bucketId: 'gemini-4-weekly', displayName: 'Gemini 4 Argon Weekly Limit', window: 'weekly', resetTime: '2026-11-21T16:31:02Z', remainingFraction: 1 },
      ],
      displayName: 'Gemini 4 Argon',
    },
  ],
}

/** 与 `agy --print /usage` 实测输出同形（制表符分隔）。 */
const USAGE_TEXT = [
  'Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-07T05:47:33Z',
  'Gemini Models\tFive Hour Limit Remaining\t98%\t2026-10-05T19:09:53Z',
  'Claude and GPT models\tWeekly Limit Remaining\t96%\t2026-10-12T14:56:40Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t92%\t2026-10-05T19:56:40Z',
  'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-21T16:31:02Z',
  '',
].join('\n')

const USAGE_JSON = JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: QUOTA_SUMMARY } })
const MINUTE = 60_000

function fakeChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough; killedByTest: boolean } {
  const child = new EventEmitter() as ReturnType<typeof fakeChild>
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killedByTest = false
  child.kill = () => { child.killedByTest = true; return true }
  return child
}

function stubUsageSpawn(output: string, stderr = '', code = 0): typeof spawn {
  return (() => {
    const child = fakeChild()
    queueMicrotask(() => {
      child.stdout.end(output)
      child.stderr.end(stderr)
      child.emit('close', code)
    })
    return child
  }) as typeof spawn
}

function reader(options: ConstructorParameters<typeof AntigravitySubscriptionService>[0] = {}): AntigravitySubscriptionService {
  return new AntigravitySubscriptionService({
    resolveCommand: () => '/fake/agy', spawn: stubUsageSpawn(USAGE_JSON), ...options,
  })
}

test('Antigravity 上下文窗口按模型 id 与 AGY 设置里的展示名解析', () => {
  assert.equal(knownAntigravityContextWindow('gemini-4-argon'), 1_048_576)
  assert.equal(knownAntigravityContextWindow('gemini-4-argon-high'), 1_048_576)
  assert.equal(knownAntigravityContextWindow('gemini-4-neon'), 1_048_576)
  assert.equal(knownAntigravityContextWindow('gemini-4-neon-xhigh'), 1_048_576)
  assert.equal(knownAntigravityContextWindow('magpie/tlp/gemini-4-neon'), undefined)
  assert.equal(knownAntigravityContextWindow('magpie/tlp/gemini-4-argon'), undefined)
  assert.equal(knownAntigravityContextWindow('gemini-3.8-flash'), 1_048_576)
  assert.equal(knownAntigravityContextWindow('gemini-3.1-pro'), 1_048_576)
  assert.equal(knownAntigravityContextWindow('claude-sonnet-4-6'), 250_000)
  assert.equal(knownAntigravityContextWindow('claude-opus-4-6-thinking'), 250_000)
  assert.equal(knownAntigravityContextWindow('gpt-oss-120b'), 131_072)
  // 未知模型宁可没有分母，也不写错误容量
  assert.equal(knownAntigravityContextWindow('unknown-model'), undefined)

  assert.equal(antigravityModelIdFromLabel('Gemini 3.8 Flash (High)'), 'gemini-3.8-flash')
  assert.equal(antigravityModelIdFromLabel('Claude Opus 4.6 (Thinking)'), 'claude-opus-4.6')
  assert.equal(antigravityModelIdFromLabel('GPT-OSS 120B (Medium)'), 'gpt-oss-120b')
  assert.equal(antigravityModelIdFromLabel('   '), null)
})

test('Antigravity provider-default 按 AGY 设置文件里的模型取窗口', () => {
  const read = (label: string | null) => () => JSON.stringify(label === null ? {} : { model: label })
  assert.equal(knownAntigravityContextWindow(undefined, { readFile: read('Gemini 3.8 Flash (High)') }), 1_048_576)
  assert.equal(knownAntigravityContextWindow('provider-default', { readFile: read('Claude Sonnet 4.6 (Thinking)') }), 250_000)
  assert.equal(knownAntigravityContextWindow('provider-default', { readFile: read('Gemini 4 Neon (High)') }), 1_048_576)
  assert.equal(knownAntigravityContextWindow('provider-default', { readFile: read('Unknown Model') }), undefined)
  assert.equal(knownAntigravityContextWindow(undefined, { readFile: () => { throw new Error('ENOENT') } }), 1_048_576)
})

test('Antigravity 实际模型解析与缓存口径按模型 Provider 区分', () => {
  const read = (label: string) => () => JSON.stringify({ model: label })
  assert.equal(resolveAntigravityModelId('gemini-3.8-flash'), 'gemini-3.8-flash')
  assert.equal(resolveAntigravityModelId(undefined, { readFile: read('Claude Sonnet 4.6 (Thinking)') }), 'claude-sonnet-4.6')
  assert.equal(resolveAntigravityModelId(undefined, { readFile: () => { throw new Error('ENOENT') } }), null)

  assert.equal(antigravityUsageExcludesCacheFromInput('claude-sonnet-4-6'), true)
  assert.equal(antigravityUsageExcludesCacheFromInput('claude-opus-4.6'), true)
  assert.equal(antigravityUsageExcludesCacheFromInput('gemini-3.8-flash'), false)
  assert.equal(antigravityUsageExcludesCacheFromInput(null), false)
})

test('Antigravity 只有 Gemini / GPT-OSS 支持 --effort，Claude 系列不支持', () => {
  assert.equal(antigravitySupportsEffort('gemini-3.8-flash'), true)
  assert.equal(antigravitySupportsEffort('gpt-oss-120b'), true)
  assert.equal(antigravitySupportsEffort('claude-sonnet-4-6'), false)
  assert.equal(antigravitySupportsEffort('Claude-Opus-4.6'), false)
  assert.equal(antigravitySupportsEffort(null), true)
})

test('Antigravity uses isolated JSON CLI usage without credential reads and keeps precise quotas', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    let directory = ''
    let calls = 0
    const originalBrowser = process.env.BROWSER
    const service = reader({
      platform,
      timeoutMs: 12_000,
      readFile: () => { throw new Error('only explicit models are requested; no files should be read') },
      spawnSync: (() => { throw new Error('must not read keychain') }) as never,
      spawn: ((command: string, args: string[], options: SpawnOptions) => {
        calls += 1
        assert.equal(command, '/fake/agy')
        assert.deepEqual(args, ['-p', '/usage', '--output-format', 'json', '--agent', 'codingns-usage', '--print-timeout', '12s'])
        assert.equal(options.shell, false)
        assert.equal(options.windowsHide, true)
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
        directory = String(options.cwd)
        assert.notEqual(directory, process.cwd())
        const agent = readFileSync(join(directory, '.agents', 'agents', 'codingns-usage', 'agent.md'), 'utf8')
        assert.match(agent, /tools: \[\]/u)
        assert.match(agent, /mcpServers: \[\]/u)
        assert.ok(options.env?.PATH?.startsWith(directory + delimiter))
        assert.equal(Object.keys(options.env ?? {}).filter(k => /^path$/iu.test(k)).length, 1)
        const browser = join(directory, platform === 'win32' ? 'open.cmd' : 'open')
        assert.equal(options.env?.BROWSER, browser)
        assert.match(readFileSync(browser, 'utf8'), /exit/u)
        if (platform !== 'win32') assert.ok(existsSync(join(directory, 'xdg-open')))
        if (platform === 'win32') assert.equal(options.env?.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
        return stubUsageSpawn(USAGE_JSON)(command, args, options)
      }) as typeof spawn,
    })
    const usage = await service.read({ modelId: 'gemini-3.8-flash' })
    assert.equal(calls, 1)
    assert.equal(existsSync(directory), false)
    assert.equal(process.env.BROWSER, originalBrowser)
    assert.equal(usage?.planType, null)
    assert.equal(usage?.accountName, undefined)
    assert.equal(usage?.paidPlanType, undefined)
    assert.deepEqual(usage?.groups?.map(g => g.id), ['gemini', 'third-party', 'gemini-4'])
    assert.equal(usage?.primary?.remainingPercent, 97.9996)
    assert.equal(usage?.secondary?.remainingPercent, 99.0795)
    assert.equal(usage?.primary?.resetsAt, Date.parse('2026-10-05T19:09:53Z') / 1000)
    assert.equal(usage?.rateLimitReachedType, null)
    assert.equal(usage?.provider?.capability, 'subscription-window')
    assert.equal(JSON.stringify(usage).includes('daily-cloudcode'), false)
    await service.dispose()
  }
})

test('Antigravity JSON and legacy text parsing only accept measured enabled quota', () => {
  const parsed = parseAntigravityUsageOutput(USAGE_JSON)
  assert.equal(parsed[0]?.windows[1]?.remainingFraction, 0.9799962)
  const text = parseAntigravityUsageOutput(USAGE_TEXT)
  assert.equal(text[1]?.windows[1]?.remainingFraction, 0.92)
  assert.equal(text[2]?.windows[0]?.kind, 'weekly')
  for (const value of ['', 'no output', 'A\tB\tnan%\t2026-01-01', '{}', '{broken',
    JSON.stringify({ status: 'ERROR', command: { name: 'usage', data: QUOTA_SUMMARY } }),
    JSON.stringify({ status: 'SUCCESS', command: { name: 'other', data: QUOTA_SUMMARY } }),
  ]) assert.deepEqual(parseAntigravityUsageOutput(value), [])

  const report = (buckets: unknown[]) => JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ display_name: 'Gemini Models', buckets }] } } })
  const buckets = parseAntigravityUsageOutput(report([
    { window: '5h', remaining: { case: 'remainingFraction', value: 0 }, reset_time: '2026-10-05T19:09:53Z' },
    { window: 'weekly', remaining_fraction: 0.12345678 },
    { window: 'unfamiliar', displayName: 'Weekly', remainingFraction: 0.5 },
    { window: 'weekly', remainingFraction: 0.3, disabled: true },
    { window: 'weekly', remainingFraction: -1 }, { window: 'weekly', remainingFraction: 2 },
    { window: 'weekly', remainingFraction: '0.5' }, { window: 'weekly' },
  ]))[0]?.windows
  assert.equal(buckets?.length, 3)
  assert.equal(buckets?.[0]?.remainingFraction, 0)
  assert.equal(buckets?.[1]?.remainingFraction, 0.12345678)
  assert.equal(buckets?.[2]?.kind, 'other')
  assert.equal(antigravityQuotaGroupPrefix('claude-sonnet-4-6'), '3p-')
  assert.equal(antigravityQuotaGroupPrefix('GPT-OSS-120B'), '3p-')
  assert.equal(antigravityQuotaGroupPrefix('gemini-4-argon'), 'gemini-4-')
  assert.equal(antigravityQuotaGroupPrefix(null), 'gemini-')
})

test('Antigravity concurrent models share a query and cached groups for 15 minutes', async () => {
  let now = 1_000_000
  let calls = 0
  const service = reader({ now: () => now, spawn: ((...args: Parameters<typeof spawn>) => {
    calls += 1
    return stubUsageSpawn(USAGE_JSON)(...args)
  }) as typeof spawn })
  const [gemini, claude, argon] = await Promise.all([
    service.read({ modelId: 'gemini-3.8-flash' }),
    service.read({ modelId: 'claude-sonnet-4-6' }),
    service.read({ modelId: 'gemini-4-argon-medium' }),
  ])
  assert.equal(calls, 1)
  assert.equal(gemini?.primary?.remainingPercent, 97.9996)
  assert.equal(claude?.primary?.remainingPercent, 97.2433)
  assert.equal(argon?.primary, null)
  assert.equal(argon?.secondary?.remainingPercent, 100)
  now += 15 * MINUTE - 1
  const cached = await service.read({ modelId: 'gpt-oss-120b' })
  assert.equal(cached?.activeGroupId, 'third-party')
  assert.equal(cached?.capturedAt, gemini?.capturedAt)
  assert.equal(calls, 1)
  now += 1
  const refreshed = await service.read()
  assert.equal(calls, 2)
  assert.notEqual(refreshed?.capturedAt, cached?.capturedAt)
})

test('Antigravity a remaining fraction ending in 403 is quota, not an HTTP refusal', async () => {
  const service = reader({ spawn: stubUsageSpawn(USAGE_JSON.replace('0.9799962', '0.403')) })
  assert.equal((await service.read())?.primary?.remainingPercent, 40.3)
})

test('Antigravity CLI name/id fields retain model groups and zero reset times stay unknown', async () => {
  const report = {
    status: 'SUCCESS', command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.91, reset_time: 1795862639 }] },
      { name: 'Claude and GPT models', buckets: [{ id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }] },
    ] } },
  }
  const service = reader({ spawn: stubUsageSpawn(JSON.stringify(report)) })
  const gemini = await service.read({ modelId: 'gemini-3.8-flash' })
  const claude = await service.read({ modelId: 'claude-sonnet-4-6' })
  assert.equal(gemini?.activeGroupId, 'gemini')
  assert.equal(gemini?.primary?.remainingPercent, 91)
  assert.equal(gemini?.primary?.resetsAt, 1795862639)
  assert.equal(claude?.activeGroupId, 'third-party')
  assert.equal(claude?.primary?.remainingPercent, 100)
  assert.equal(claude?.primary?.resetsAt, null)
  assert.equal(claude?.groups?.[1]?.windows[0]?.label, 'Five Hour Limit Remaining')
})

test('Antigravity normal failures back off exponentially, cap at 6 hours, and reset after success', async () => {
  let now = 0
  let calls = 0
  let succeed = false
  const service = reader({ now: () => now, spawn: ((...args: Parameters<typeof spawn>) => {
    calls += 1
    return stubUsageSpawn(succeed ? USAGE_JSON : 'network error', '', succeed ? 0 : 1)(...args)
  }) as typeof spawn })
  for (const minutes of [10, 20, 40, 80, 160, 320, 360]) {
    assert.equal(await service.read(), null)
    const before = calls
    now += minutes * MINUTE - 1
    assert.equal(await service.read(), null)
    assert.equal(calls, before)
    now += 1
  }
  succeed = true
  assert.ok(await service.read())
  now += 15 * MINUTE
  succeed = false
  assert.equal(await service.read(), null)
  const before = calls
  now += 10 * MINUTE - 1
  assert.equal(await service.read(), null)
  assert.equal(calls, before)
  now += 1
  await service.read()
  assert.equal(calls, before + 1)
})

test('Antigravity authentication and policy refusals halt retries for 6 hours even with partial quotas', async () => {
  for (const message of ['HTTP 403', 'Terms of Service', 'TOS_VIOLATION', 'Verification Required',
    'not logged in', 'authentication required', 'invalid_grant', '未登录']) {
    let now = 0
    let calls = 0
    const service = reader({ now: () => now, spawn: ((...args: Parameters<typeof spawn>) => {
      calls += 1
      return stubUsageSpawn(USAGE_JSON, message)(...args)
    }) as typeof spawn })
    assert.equal(await service.read(), null)
    now = 6 * 60 * MINUTE - 1
    assert.equal(await service.read(), null)
    assert.equal(calls, 1, message)
    now += 1
    await service.read()
    assert.equal(calls, 2)
  }
})

test('Antigravity timeout stops the child, cleans its directory and backs off from one minute', async () => {
  let now = 0
  const children: ReturnType<typeof fakeChild>[] = []
  const directories: string[] = []
  const service = reader({ timeoutMs: 10, now: () => now, spawn: ((_command: string, _args: string[], options: SpawnOptions) => {
    const child = fakeChild()
    children.push(child)
    directories.push(String(options.cwd))
    return child
  }) as typeof spawn })
  assert.equal(await service.read(), null)
  assert.equal(children[0]?.killedByTest, true)
  assert.equal(existsSync(directories[0]!), false)
  now += MINUTE - 1
  assert.equal(await service.read(), null)
  assert.equal(children.length, 1)
  now += 1
  assert.equal(await service.read(), null)
  assert.equal(children.length, 2)
  now += 2 * MINUTE - 1
  assert.equal(await service.read(), null)
  assert.equal(children.length, 2)
  assert.ok(children.every(child => child.stdout.destroyed && child.stderr.destroyed))
})

test('Antigravity dispose resolves all waiters, stops the child and cleans temporary files', async () => {
  let child: ReturnType<typeof fakeChild> | undefined
  let directory = ''
  let spawned!: () => void
  const ready = new Promise<void>(resolve => { spawned = resolve })
  const service = reader({ spawn: ((_command: string, _args: string[], options: SpawnOptions) => {
    child = fakeChild()
    directory = String(options.cwd)
    spawned()
    return child
  }) as typeof spawn })
  const first = service.read()
  const second = service.read({ modelId: 'claude-opus-4.6' })
  await ready
  await service.dispose()
  await service.dispose()
  assert.deepEqual(await Promise.all([first, second]), [null, null])
  assert.equal(child?.killedByTest, true)
  assert.equal(existsSync(directory), false)
  assert.equal(await service.read(), null)
})

test('Antigravity missing CLI, spawn errors, malformed output and process failures return null and clean up', async () => {
  const directories: string[] = []
  assert.equal(await reader({ resolveCommand: () => null, spawn: (() => { assert.fail('must not spawn') }) as never }).read(), null)
  for (const mode of ['throw', 'error', 'nonzero', 'malformed', 'overflow']) {
    const service = reader({ spawn: ((_command: string, _args: string[], options: SpawnOptions) => {
      directories.push(String(options.cwd))
      if (mode === 'throw') throw new Error('spawn failed')
      const child = fakeChild()
      queueMicrotask(() => {
        if (mode === 'error') { child.emit('error', new Error('spawn error')); return }
        child.stdout.end(mode === 'nonzero' ? USAGE_JSON : mode === 'overflow' ? 'x'.repeat(1024 * 1024 + 1) : '{malformed')
        child.stderr.end()
        child.emit('close', mode === 'nonzero' ? 1 : 0)
      })
      return child
    }) as typeof spawn })
    assert.equal(await service.read(), null, mode)
    assert.equal(existsSync(directories.at(-1)!), false, mode)
  }
})

test('ProviderSubscriptionService reuses Host-owned Antigravity state across rebuilds and timeout changes', async () => {
  let now = 0
  let calls = 0
  let output = USAGE_JSON
  const shared = reader({ now: () => now, spawn: ((...args: Parameters<typeof spawn>) => {
    calls += 1
    return stubUsageSpawn(output)(...args)
  }) as typeof spawn })
  let service = new ProviderSubscriptionService({ antigravityService: shared })
  assert.equal((await service.read('antigravity', undefined, 'gemini-3.8-flash'))?.primary?.remainingPercent, 97.9996)
  shared.setTimeoutMs(5_000)
  service = new ProviderSubscriptionService({ antigravityService: shared })
  assert.equal((await service.read('antigravity', undefined, 'claude-sonnet-4-6'))?.primary?.remainingPercent, 97.2433)
  assert.equal(calls, 1)
  now += 15 * MINUTE
  output = JSON.stringify({ status: 'ERROR', error: 'invalid_grant' })
  assert.equal(await service.read('antigravity'), null)
  service = new ProviderSubscriptionService({ antigravityService: shared })
  shared.setTimeoutMs(8_000)
  assert.equal(await service.read('antigravity'), null)
  assert.equal(calls, 2)
  assert.equal(await service.read('cursor-cli'), null)
})

test('ProviderSubscriptionService 按 AGY 当前设置或会话显式模型选择额度组', async (context) => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'codingns-agy-quota-'))
  context.after(() => rmSync(homeDirectory, { recursive: true, force: true }))
  const settingsDirectory = join(homeDirectory, '.gemini', 'antigravity-cli')
  mkdirSync(settingsDirectory, { recursive: true })
  const settingsPath = join(settingsDirectory, 'settings.json')
  const service = new ProviderSubscriptionService({
    antigravity: {
      homeDirectory,
      platform: 'linux',
      resolveCommand: () => '/fake/agy',
      spawn: stubUsageSpawn([
        'Gemini Models\tWeekly Limit Remaining\t85%\t2026-11-21T16:31:02Z',
        'Claude and GPT models\tWeekly Limit Remaining\t45%\t2026-11-21T16:31:02Z',
        'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t10%\t2026-11-21T16:31:02Z',
      ].join('\n')),
    },
  })
  const weeklyRemaining = async (modelId?: string) =>
    (await service.read('antigravity', undefined, modelId))?.secondary?.remainingPercent

  assert.equal(await weeklyRemaining('provider-default'), 85)
  writeFileSync(settingsPath, JSON.stringify({ model: 'Gemini 4 Argon (High)' }))
  assert.equal(await weeklyRemaining('provider-default'), 10)
  writeFileSync(settingsPath, JSON.stringify({ model: 'Claude Sonnet 4.6 (Thinking)' }))
  assert.equal(await weeklyRemaining(), 45)
  assert.equal(await weeklyRemaining('gemini-4-argon-medium'), 10)
  writeFileSync(settingsPath, JSON.stringify({ model: 'Unknown Model' }))
  assert.equal(await weeklyRemaining('provider-default'), 85)
})

test('Antigravity Gemini 4 Hydrogen 不应错配到 Gemini 4 Argon，并保留唯一分组 id', async () => {
  const usageText = [
    'Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-25T10:09:21Z',
    'Gemini Models\tFive Hour Limit Remaining\t93%\t2026-11-18T15:09:21Z',
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-25T14:42:28Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-18T19:42:28Z',
    'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-25T14:42:28Z',
    '',
  ].join('\n')
  const service = new AntigravitySubscriptionService({
    platform: 'win32',
    resolveCommand: () => 'fake-agy',
    spawn: stubUsageSpawn(usageText),
  })

  const hydrogen = await service.read({ modelId: 'gemini-4-hydrogen-high' })
  assert.equal(hydrogen?.activeGroupId, 'gemini')
  assert.equal(hydrogen?.primary?.remainingPercent, 93)
  assert.equal(hydrogen?.secondary?.remainingPercent, 97)

  const argon = await service.read({ modelId: 'gemini-4-argon-high' })
  assert.equal(argon?.activeGroupId, 'gemini-4')
  assert.equal(argon?.primary, null)
  assert.equal(argon?.secondary?.remainingPercent, 100)

  const gpt = await service.read({ modelId: 'gpt-oss-120b-medium' })
  assert.equal(gpt?.activeGroupId, 'third-party')
  assert.equal(gpt?.primary?.remainingPercent, 100)

  const withHydrogenPool = await new AntigravitySubscriptionService({
    platform: 'win32',
    resolveCommand: () => 'fake-agy',
    spawn: stubUsageSpawn(usageText + 'Gemini 4 Hydrogen\tGemini 4 Hydrogen Weekly Limit\t64%\t2026-11-25T14:42:28Z\n'),
  }).read({ modelId: 'gemini-4-hydrogen-high' })
  assert.equal(new Set(withHydrogenPool?.groups?.map(g => g.id)).size, withHydrogenPool?.groups?.length)
  assert.equal(withHydrogenPool?.activeGroupId, 'gemini-4-hydrogen')
  assert.equal(withHydrogenPool?.secondary?.remainingPercent, 64)
})
