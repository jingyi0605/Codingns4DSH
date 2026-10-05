import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'
import {
  AntigravitySubscriptionService,
  antigravityQuotaGroupPrefix,
  decodeKeyringSecret,
  parseAntigravityUsageOutput,
  readAccountName,
  readAntigravityQuotaGroups,
} from '../data/build/dist/host/cli-adapters/antigravity-subscription.js'
import {
  antigravityModelIdFromLabel,
  antigravitySupportsEffort,
  antigravityUsageExcludesCacheFromInput,
  knownAntigravityContextWindow,
  resolveAntigravityModelId,
} from '../data/build/dist/host/cli-adapters/model-catalog.js'

/** 与 agy 1.2.17 实测的 `v1internal:retrieveUserQuotaSummary` 响应同形。 */
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
  ],
}

/** 与 `agy --print /usage` 实测输出同形（制表符分隔）。 */
const USAGE_TEXT = [
  'Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-07T05:47:33Z',
  'Gemini Models\tFive Hour Limit Remaining\t98%\t2026-10-05T19:09:53Z',
  'Claude and GPT models\tWeekly Limit Remaining\t96%\t2026-10-12T14:56:40Z',
  'Claude and GPT models\tFive Hour Limit Remaining\t92%\t2026-10-05T19:56:40Z',
  '',
].join('\n')

function fakeIdToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.signature`
}

/** 写一份旧版凭据文件（agy 1.2.17 之前的位置）。 */
function makeHome(options: { readonly expiry?: string; readonly idToken?: string | null } = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'codingns-antigravity-'))
  const directory = join(home, '.gemini', 'antigravity-cli')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'antigravity-oauth-token'), JSON.stringify({
    token: { access_token: 'test-access-token', token_type: 'Bearer', expiry: options.expiry ?? '2099-01-01T00:00:00.000Z' },
    ...(options.idToken === null ? {} : { id_token: options.idToken ?? fakeIdToken({ email: 'user@example.com', name: 'Test User' }) }),
  }), 'utf8')
  return home
}

function stubFetch(
  calls: Array<{ url: string; authorization: string | null; userAgent: string | null; body: string | undefined }>,
  handlers: { readonly quota?: () => Response; readonly tier?: () => Response } = {},
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const target = String(url)
    calls.push({
      url: target,
      authorization: headers.get('authorization'),
      userAgent: headers.get('user-agent'),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    if (target.endsWith('retrieveUserQuotaSummary')) return (handlers.quota ?? (() => Response.json(QUOTA_SUMMARY)))()
    return (handlers.tier ?? (() => Response.json({
      currentTier: { id: 'free-tier', name: 'Antigravity' },
      paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
    })))()
  }) as typeof fetch
}

/** 造一个只回放 `/usage` 文本的 agy 子进程。 */
function stubUsageSpawn(output: string): typeof import('node:child_process').spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => {
      child.stdout.end(output)
      child.stderr.end()
      child.emit('close', 0)
    })
    return child
  }) as never
}

test('Antigravity 上下文窗口按模型 id 与 AGY 设置里的展示名解析', () => {
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

test('Antigravity 凭据读取器返回两组额度、套餐档位与账号名', async () => {
  const calls: Array<{ url: string; authorization: string | null; userAgent: string | null; body: string | undefined }> = []
  const service = new AntigravitySubscriptionService({ homeDirectory: makeHome(), fetch: stubFetch(calls, {}), platform: 'linux' })

  const usage = await service.read()
  assert.ok(usage !== null)
  assert.equal(usage.planType, 'free-tier')
  assert.equal(usage.paidPlanType, 'Google AI Pro')
  assert.equal(usage.accountName, 'user@example.com')
  // 两个分组都带出来，各自的 5 小时与周窗口都在
  assert.deepEqual(usage.groups?.map((group) => group.id), ['gemini', 'third-party'])
  const gemini = usage.groups?.[0]
  assert.deepEqual(gemini?.windows.map((entry) => entry.kind), ['weekly', 'five-hour'])
  assert.equal(gemini?.windows[1]?.window.remainingPercent, 97.9996)
  assert.equal(usage.groups?.[1]?.windows[1]?.window.remainingPercent, 97.2433)
  // 主窗口跟随会话模型：默认按 Gemini 组
  assert.equal(usage.primary?.remainingPercent, 97.9996)
  assert.equal(usage.secondary?.remainingPercent, 99.0795)
  // 窗口单位必须是 Unix 秒：客户端按秒换算倒计时
  assert.equal(usage.primary?.resetsAt, Date.parse('2026-10-05T19:09:53Z') / 1000)
  assert.equal(usage.secondary?.resetsAt, Date.parse('2026-10-07T05:47:33Z') / 1000)
  assert.equal(usage.rateLimitReachedType, null)
  assert.equal(usage.provider?.capability, 'subscription-window')
  assert.deepEqual(calls.map((call) => call.url).sort(), [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  ])
  for (const call of calls) {
    assert.equal(call.authorization, 'Bearer test-access-token')
    // 缺失或非 Antigravity 的 User-Agent 会被上游 403 拒绝
    assert.equal(call.userAgent, 'antigravity-cli')
  }
})

test('Antigravity 凭据优先读系统钥匙串（agy 1.2.17 起不再写文件）', async () => {
  const payload = {
    token: { access_token: 'keychain-token', token_type: 'Bearer', refresh_token: 'r', expiry: '2099-01-01T00:00:00.000Z' },
    auth_method: 'consumer',
    id_token: fakeIdToken({ email: 'keychain@example.com' }),
  }
  const secret = `go-keyring-base64:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`
  const spawnCalls: string[][] = []
  const keychainCalls: Array<{ url: string; authorization: string | null }> = []
  const service = new AntigravitySubscriptionService({
    // 目录里没有旧版凭据文件：只能来自钥匙串
    homeDirectory: mkdtempSync(join(tmpdir(), 'codingns-antigravity-empty-')),
    platform: 'darwin',
    spawnSync: ((command: string, args: string[]) => {
      spawnCalls.push([command, ...args])
      return { status: 0, stdout: `${secret}\n`, stderr: '' }
    }) as never,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      keychainCalls.push({ url: String(url), authorization: headers.get('authorization') })
      if (String(url).endsWith('retrieveUserQuotaSummary')) return Response.json(QUOTA_SUMMARY)
      return Response.json({ currentTier: { id: 'free-tier' }, paidTier: { name: 'Google AI Pro' } })
    }) as typeof fetch,
  })

  const usage = await service.read()
  assert.deepEqual(spawnCalls[0], ['security', 'find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'])
  assert.equal(usage?.accountName, 'keychain@example.com')
  assert.equal(usage?.groups?.length, 2)
  for (const call of keychainCalls) assert.equal(call.authorization, 'Bearer keychain-token')
})

test('Antigravity 没有凭据时回退到 agy --print /usage，并给出两组额度', async () => {
  const commands: string[][] = []
  const service = new AntigravitySubscriptionService({
    homeDirectory: mkdtempSync(join(tmpdir(), 'codingns-antigravity-empty-')),
    platform: 'linux',
    resolveCommand: () => '/fake/agy',
    spawn: ((command: string, args: string[]) => {
      commands.push([command, ...args])
      return stubUsageSpawn(USAGE_TEXT)(command, args, {} as never)
    }) as never,
    fetch: (async () => { throw new Error('无凭据时不应发起 API 请求') }) as unknown as typeof fetch,
  })

  const usage = await service.read()
  assert.deepEqual(commands[0], ['/fake/agy', '--print', '/usage'])
  assert.equal(usage?.planType, null)
  assert.equal(usage?.accountName, undefined)
  assert.deepEqual(usage?.groups?.map((group) => group.id), ['gemini', 'third-party'])
  // 上游只给整数百分比，读取器按百分数还原成比例
  assert.equal(usage?.groups?.[0]?.windows[1]?.window.remainingPercent, 98)
  assert.equal(usage?.groups?.[1]?.windows[1]?.window.remainingPercent, 92)
  assert.equal(usage?.primary?.remainingPercent, 98)
  assert.equal(usage?.primary?.resetsAt, Date.parse('2026-10-05T19:09:53Z') / 1000)
})

test('Antigravity 主窗口跟随会话模型选择对应分组', async () => {
  const gemini = await new AntigravitySubscriptionService({ homeDirectory: makeHome(), fetch: stubFetch([], {}), platform: 'linux' })
    .read({ modelId: 'gemini-3.8-flash' })
  assert.equal(gemini?.primary?.remainingPercent, 97.9996)
  assert.equal(gemini?.secondary?.remainingPercent, 99.0795)

  const claude = await new AntigravitySubscriptionService({ homeDirectory: makeHome(), fetch: stubFetch([], {}), platform: 'linux' })
    .read({ modelId: 'claude-sonnet-4-6' })
  assert.equal(claude?.primary?.remainingPercent, 97.2433)
  assert.equal(claude?.secondary?.remainingPercent, 98.1216)
  assert.equal(claude?.primary?.resetsAt, Date.parse('2026-10-05T19:56:40Z') / 1000)
  // 两个分组始终都在，切换模型只影响底部入口用哪一组
  assert.equal(claude?.groups?.length, 2)

  const fromSettings = await new AntigravitySubscriptionService({
    homeDirectory: makeHome(),
    fetch: stubFetch([], {}),
    platform: 'linux',
    resolveModelId: () => 'claude-opus-4.6',
  }).read()
  assert.equal(fromSettings?.primary?.remainingPercent, 97.2433)
})

test('Antigravity /usage 文本解析与分组 id 归类', () => {
  const groups = parseAntigravityUsageOutput(USAGE_TEXT)
  assert.deepEqual(groups.map((group) => group.displayName), ['Gemini Models', 'Claude and GPT models'])
  assert.deepEqual(groups[0]?.windows.map((window) => window.kind), ['weekly', 'five-hour'])
  assert.equal(groups[1]?.windows[1]?.remainingFraction, 0.92)
  assert.equal(groups[1]?.windows[1]?.resetsAt, Date.parse('2026-10-05T19:56:40Z') / 1000)
  // 非表格行、缺列、非数字百分比都要忽略
  assert.deepEqual(parseAntigravityUsageOutput('no output produced'), [])
  assert.deepEqual(parseAntigravityUsageOutput('A\tB\tnot-a-percent\t2026-01-01T00:00:00Z'), [])
  assert.deepEqual(parseAntigravityUsageOutput(''), [])

  assert.equal(antigravityQuotaGroupPrefix('claude-sonnet-4-6'), '3p-')
  assert.equal(antigravityQuotaGroupPrefix('GPT-OSS-120B'), '3p-')
  assert.equal(antigravityQuotaGroupPrefix('gemini-3.8-flash'), 'gemini-')
  assert.equal(antigravityQuotaGroupPrefix(null), 'gemini-')

  // API 响应同样解析成窗口草稿
  const apiGroups = readAntigravityQuotaGroups(QUOTA_SUMMARY)
  assert.deepEqual(apiGroups.map((group) => group.displayName), ['Gemini Models', 'Claude and GPT models'])
  assert.equal(apiGroups[0]?.windows.length, 2)
  assert.deepEqual(readAntigravityQuotaGroups(null), [])
  assert.deepEqual(readAntigravityQuotaGroups({ groups: [{ buckets: [{ bucketId: 'x' }] }] }), [])
})

test('Antigravity 钥匙串密文按 go-keyring-base64 解包', () => {
  const payload = { token: { access_token: 'abc' }, auth_method: 'consumer' }
  const encoded = `go-keyring-base64:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`
  assert.deepEqual(decodeKeyringSecret(encoded), payload)
  // 普通 JSON 原样解析，损坏内容返回 null
  assert.deepEqual(decodeKeyringSecret('{"token":{"access_token":"x"}}'), { token: { access_token: 'x' } })
  assert.equal(decodeKeyringSecret('go-keyring-base64:!!!'), null)
  assert.equal(decodeKeyringSecret('not json'), null)
})

test('Antigravity 账号名从 id_token 负载读取，缺失或损坏时返回 null', () => {
  assert.equal(readAccountName(fakeIdToken({ email: 'user@example.com', name: 'Test User' })), 'user@example.com')
  assert.equal(readAccountName(fakeIdToken({ name: 'Test User' })), 'Test User')
  assert.equal(readAccountName('not-a-jwt'), null)
  assert.equal(readAccountName('a.!!!.c'), null)
  assert.equal(readAccountName(null), null)
})

test('Antigravity 无凭据且拿不到 CLI 输出时安静降级', async () => {
  let requested = 0
  const missing = new AntigravitySubscriptionService({
    homeDirectory: mkdtempSync(join(tmpdir(), 'codingns-antigravity-empty-')),
    platform: 'linux',
    resolveCommand: () => null,
    fetch: (async () => { requested += 1; return Response.json(QUOTA_SUMMARY) }) as unknown as typeof fetch,
  })
  assert.equal(await missing.read(), null)
  assert.equal(requested, 0)

  // 令牌过期时不发请求，也不读 CLI
  let spawned = 0
  const expired = new AntigravitySubscriptionService({
    homeDirectory: makeHome({ expiry: '2020-01-01T00:00:00.000Z' }),
    platform: 'linux',
    resolveCommand: () => null,
    spawn: ((...args: unknown[]) => { spawned += 1; return stubUsageSpawn(USAGE_TEXT)(...(args as [never, never, never])) }) as never,
    fetch: (async () => { requested += 1; return Response.json(QUOTA_SUMMARY) }) as unknown as typeof fetch,
  })
  assert.equal(await expired.read(), null)
  assert.equal(requested, 0)
  assert.equal(spawned, 0)

  // 上游整体失败时降级为 null
  const failing = new AntigravitySubscriptionService({
    homeDirectory: makeHome(),
    platform: 'linux',
    resolveCommand: () => null,
    fetch: (async () => new Response('{"error":{"code":403}}', { status: 403 })) as unknown as typeof fetch,
  })
  assert.equal(await failing.read(), null)

  // 凭据接口没有分组时改走 CLI 兜底
  const fallback = await new AntigravitySubscriptionService({
    homeDirectory: makeHome(),
    platform: 'linux',
    fetch: stubFetch([], { quota: () => Response.json({ groups: [] }) }),
    resolveCommand: () => '/fake/agy',
    spawn: ((command: string, args: string[]) => stubUsageSpawn(USAGE_TEXT)(command, args, {} as never)) as never,
  }).read()
  assert.equal(fallback?.groups?.length, 2)
})

test('ProviderSubscriptionService 把 antigravity 路由到官方用量读取器并透传模型', async () => {
  const service = new ProviderSubscriptionService({
    antigravity: { homeDirectory: makeHome(), fetch: stubFetch([], {}), platform: 'linux' },
  })
  const usage = await service.read('antigravity', undefined, 'gemini-3.8-flash')
  assert.equal(usage?.provider?.id, 'antigravity')
  assert.equal(usage?.primary?.remainingPercent, 97.9996)
  assert.equal(usage?.accountName, 'user@example.com')
  const claude = await service.read('antigravity', undefined, 'claude-sonnet-4-6')
  assert.equal(claude?.primary?.remainingPercent, 97.2433)
  // 未支持的适配器仍然返回 null，不影响既有行为
  assert.equal(await service.read('cursor-cli'), null)
})
