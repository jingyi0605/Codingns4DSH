import assert from 'node:assert/strict'
import test from 'node:test'
import { NewApiSubscriptionService, normalizeNewApiBilling, normalizeNewApiUsage, resolveNewApiSources, summarizeNewApiLogs } from '../data/build/dist/host/cli-adapters/new-api-subscription.js'
import { ProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'

test('New-API 以 token 主接口为准并合并两个 billing 接口', async () => {
  const calls: string[] = []
  const service = new NewApiSubscriptionService({
    sources: { codex: { baseUrl: 'https://new-api.example.test/v1', apiKey: 'new-api-secret' } },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push(url)
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer new-api-secret')
      if (url === 'https://new-api.example.test/api/usage/token') {
        return new Response(JSON.stringify({ data: { total_available: 800, total_used: 200, total_granted: 1000, unit: 'TOKENS', expires_at: 1_800_000_000 } }), { status: 200 })
      }
      if (url === 'https://new-api.example.test/api/log/token') {
        return new Response(JSON.stringify({ success: true, data: [{ type: 2, created_at: Math.floor(Date.now() / 1000), model_name: 'gpt-5', prompt_tokens: 10, completion_tokens: 5, group: 'default' }] }), { status: 200 })
      }
      if (url.endsWith('/dashboard/billing/subscription')) {
        return new Response(JSON.stringify({ object: 'billing_subscription', hard_limit_usd: 10, access_until: 1_800_000_000 }), { status: 200 })
      }
      return new Response(JSON.stringify({ object: 'billing_usage', total_usage: 250 }), { status: 200 })
    }) as typeof fetch,
  })

  const result = await service.read('codex')
  assert.deepEqual(calls, [
    'https://new-api.example.test/api/usage/token',
    'https://new-api.example.test/v1/dashboard/billing/subscription',
    'https://new-api.example.test/v1/dashboard/billing/usage',
    'https://new-api.example.test/api/log/token',
  ])
  assert.equal(result?.provider?.capability, 'new-api')
  assert.equal(result?.providerBalance?.remaining, 800)
  assert.equal(result?.providerBalance?.used, 200)
  assert.equal(result?.providerBalance?.total, 1000)
  assert.equal(result?.providerBalance?.unit, 'TOKENS')
  assert.equal(result?.primary, null)
  assert.equal(result?.provider?.logoUrl, 'https://new-api.example.test/logo.png')
  assert.match(JSON.stringify(result?.providerBalance?.details), /累计费用/u)
  assert.match(JSON.stringify(result?.providerBalance?.details), /最近日志统计范围/u)
  assert.match(JSON.stringify(result?.providerBalance?.details), /累计 Token（最近日志）/u)
  assert.doesNotMatch(JSON.stringify(result), /new-api-secret/u)
})

test('New-API billing 为 USD 时不把无单位 token 原始配额当作已用金额', async () => {
  const service = new NewApiSubscriptionService({
    sources: { claude: { baseUrl: 'https://new-api.example.test', apiKey: 'new-api-secret' } },
    fetch: (async (url: string) => {
      if (url.endsWith('/api/usage/token')) {
        return new Response(JSON.stringify({
          code: true,
          data: {
            object: 'token_usage',
            total_available: -30428371,
            total_granted: 0,
            total_used: 30428371,
            unlimited_quota: true,
          },
        }), { status: 200 })
      }
      if (url.endsWith('/dashboard/billing/subscription')) {
        return new Response(JSON.stringify({
          object: 'billing_subscription',
          hard_limit_usd: 100000000,
          soft_limit_usd: 100000000,
          access_until: 0,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ object: 'list', total_usage: 6085.6742 }), { status: 200 })
    }) as typeof fetch,
  })
  const result = await service.read('claude')
  assert.equal(result?.providerBalance?.unit, 'USD')
  assert.ok(Math.abs((result?.providerBalance?.used ?? 0) - 60.856742) < 1e-9)
  assert.equal(result?.providerBalance?.remaining, null)
  assert.equal(result?.providerBalance?.total, null)
  assert.match(JSON.stringify(result?.providerBalance?.details), /累计费用/u)
  assert.match(JSON.stringify(result?.providerBalance?.details), /上游原始额度/u)
})

test('New-API billing 不可读时隐藏无单位原始配额的顶部金额', async () => {
  const service = new NewApiSubscriptionService({
    sources: { claude: { baseUrl: 'https://new-api.example.test', apiKey: 'new-api-secret' } },
    fetch: (async (url: string) => {
      if (url.endsWith('/api/usage/token')) {
        return new Response(JSON.stringify({
          code: true,
          data: { object: 'token_usage', total_available: -30428371, total_used: 30428371, unlimited_quota: true },
        }), { status: 200 })
      }
      return new Response('{}', { status: 401 })
    }) as typeof fetch,
  })
  const result = await service.read('claude')
  assert.equal(result?.providerBalance?.used, null)
  assert.equal(result?.providerBalance?.remaining, null)
  assert.match(JSON.stringify(result?.providerBalance?.details), /上游原始额度/u)
})

test('New-API token 鉴权失败时不把 billing 错误响应伪装成余额', async () => {
  const calls: string[] = []
  const service = new NewApiSubscriptionService({
    sources: { dsh: { baseUrl: 'https://new-api.example.test', apiKey: 'expired-secret' } },
    fetch: (async (url: string) => {
      calls.push(url)
      return new Response('{}', { status: 401 })
    }) as typeof fetch,
  })
  assert.equal(await service.read('dsh'), null)
  assert.deepEqual(calls, ['https://new-api.example.test/api/usage/token'])
})

test('New-API 缺失字段保持 null 并显示上游未提供', () => {
  const result = normalizeNewApiUsage({ data: { object: 'token_usage', unlimited_quota: true, total_available: 100000000 } }, 'https://new-api.example.test')
  assert.equal(result?.providerBalance?.remaining, null)
  assert.equal(result?.providerBalance?.total, null)
  assert.equal(result?.providerBalance?.used, null)
  assert.match(JSON.stringify(result?.providerBalance?.details), /上游未提供/u)
})

test('New-API 无限额度仍保留上游明确返回的实际剩余额度', () => {
  const result = normalizeNewApiUsage({
    data: { object: 'token_usage', unlimited_quota: true, remaining: 0.002828, total_available: 0, total_used: 0, unit: 'USD' },
  }, 'https://new-api.example.test')
  assert.equal(result?.providerBalance?.remaining, 0.002828)
  assert.equal(result?.providerBalance?.total, null)
})

test('New-API 无限额度不把负 total_available 当作剩余额度', () => {
  const result = normalizeNewApiUsage({
    data: {
      object: 'token_usage',
      expires_at: 0,
      model_limits: {},
      name: 'Claude',
      total_available: -30428371,
      total_granted: 0,
      total_used: 30428371,
      unlimited_quota: true,
    },
  }, 'https://new-api.example.test')
  assert.equal(result?.providerBalance?.remaining, null)
  assert.equal(result?.providerBalance?.total, null)
  assert.equal(result?.providerBalance?.used, 30428371)
  assert.match(JSON.stringify(result?.providerBalance?.details), /上游未提供/u)
})

test('New-API 使用 Token 接口明确返回的 active 状态判断 Key 是否过期', () => {
  const result = normalizeNewApiUsage({ data: { object: 'token_usage', is_active: false, remaining: 4 } }, 'https://new-api.example.test')
  assert.equal(result?.providerBalance?.keyExpired, true)
})

test('New-API 只聚合消费日志，并明确限制为最近 1000 条', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  const result = summarizeNewApiLogs({
    success: true,
    data: [
      {
        type: 2,
        created_at: Math.floor(now / 1000),
        model_name: 'claude-sonnet-5',
        prompt_tokens: 100,
        completion_tokens: 20,
        quota: 300,
        group: '高缓',
        other: JSON.stringify({ cache_creation_tokens: 50, cache_read_tokens: 25 }),
      },
      {
        type: 2,
        created_at: Math.floor(now / 1000) - 86_400,
        model_name: 'gpt-5',
        prompt_tokens: 10,
        completion_tokens: 5,
        quota: 100,
      },
      { type: 1, created_at: Math.floor(now / 1000), prompt_tokens: 9999 },
    ],
  }, now)
  assert.equal(result?.count, 2)
  assert.equal(result?.todayTokens, 195)
  assert.equal(result?.totalTokens, 210)
  assert.equal(result?.totalQuota, 400)
  assert.equal(result?.todayQuota, 300)
  assert.equal(result?.cacheCreationTokens, 50)
  assert.equal(result?.cacheReadTokens, 25)
  assert.ok(Math.abs((result?.cacheHitRate ?? 0) - 25 / 135 * 100) < 1e-4)
  assert.deepEqual(result?.models.map((item) => item.name), ['claude-sonnet-5', 'gpt-5'])
  assert.deepEqual(result?.daily.map((item) => item.date), ['2026-10-03', '2026-10-02'])
  assert.deepEqual(result?.groups, ['高缓'])
})

test('New-API 无消费日志时不把空数组伪装成零用量', () => {
  assert.equal(summarizeNewApiLogs({ success: true, data: [] }), null)
  assert.equal(summarizeNewApiLogs({ success: false, data: [] }), null)
})

test('New-API 读取器拒绝只有余额字段的非 New-API 响应', () => {
  const result = normalizeNewApiUsage({ balance: 4, remaining: 3, usage: { today: {}, total: {} } }, 'https://sub2api.example.test')
  assert.equal(result, null)
})

test('New-API billing 只有明确单位时才换算累计费用', () => {
  const result = normalizeNewApiBilling(
    { object: 'billing_subscription', hard_limit_usd: 10, access_until: 0, currency: 'USD' },
    { object: 'billing_usage', total_usage: 250 },
    'https://new-api.example.test',
  )
  assert.equal(result?.providerBalance?.used, 2.5)
  assert.equal(result?.providerBalance?.remaining, 7.5)
  assert.equal(result?.providerBalance?.keyExpired, false)
})

test('New-API billing 无限额度哨兵值不作为真实上限', () => {
  const result = normalizeNewApiBilling(
    { object: 'billing_subscription', hard_limit_usd: 100000000, access_until: 1_800_000_000 },
    { object: 'list', total_usage: 0 },
    'https://new-api.example.test',
  )
  assert.equal(result?.providerBalance?.total, null)
  assert.match(JSON.stringify(result?.providerBalance?.details), /上游未提供/u)
})

test('New-API billing 根据 hard_limit_usd 推断 USD 并解析累计费用', () => {
  const result = normalizeNewApiBilling(
    {
      object: 'billing_subscription',
      hard_limit_usd: 100000000,
      soft_limit_usd: 100000000,
      access_until: 0,
    },
    {
      object: 'list',
      total_usage: 6085.6742,
    },
    'https://new-api.example.test',
  )
  assert.equal(result?.providerBalance?.unit, 'USD')
  assert.ok(Math.abs((result?.providerBalance?.used ?? 0) - 60.856742) < 1e-9)
  assert.match(JSON.stringify(result?.providerBalance?.details), /累计费用/u)
})

test('New-API billing 与 Token 原始配额一致时识别为 TOKENS', () => {
  const result = normalizeNewApiBilling(
    {
      object: 'billing_subscription',
      hard_limit_usd: 100000000,
      access_until: 0,
    },
    {
      object: 'list',
      total_usage: 3042837100,
    },
    'https://new-api.example.test',
    Date.now(),
    30428371,
    null,
  )
  assert.equal(result?.providerBalance?.unit, 'TOKENS')
  assert.equal(result?.providerBalance?.used, 30428371)
  assert.match(JSON.stringify(result?.providerBalance?.details), /累计 Token/u)
})

test('New-API 读取失败后才尝试 Sub2API，原有按日和按模型数据保持独立', async () => {
  const calls: string[] = []
  const service = new ProviderSubscriptionService({
    newApi: {
      sources: { codex: { baseUrl: 'https://upstream.example.test', apiKey: 'new-api-secret' } },
      fetch: (async (url: string) => {
        calls.push(`new:${url}`)
        return new Response('{}', { status: 404 })
      }) as typeof fetch,
    },
    sub2api: {
      sources: { codex: { baseUrl: 'https://upstream.example.test', apiKey: 'sub2api-secret' } },
      fetch: (async (url: string) => {
        calls.push(`sub:${url}`)
        if (url.endsWith('/logo.svg')) return new Response('', { status: 404 })
        return new Response(JSON.stringify({ balance: 4, remaining: 3, unit: 'USD', usage: { today: {}, total: {} }, daily_usage: [], model_stats: [] }), { status: 200 })
      }) as typeof fetch,
    },
  })
  const result = await service.read('codex')
  assert.equal(result?.sub2api?.remaining, 3)
  assert.equal(result?.providerBalance, undefined)
  assert.equal(calls[0], 'new:https://upstream.example.test/api/usage/token')
  assert.ok(calls.includes('sub:https://upstream.example.test/v1/usage'))
})

test('统一分类会把 Command Code 的 New-API 来源同时作为 Sub2API 候选探测', async () => {
  const newCalls: string[] = []
  const subCalls: string[] = []
  const service = new ProviderSubscriptionService({
    newApi: {
      sources: { 'command-code': { baseUrl: 'https://command-upstream.example.test', apiKey: 'new-secret' } },
      fetch: (async (url: string) => {
        newCalls.push(url)
        return new Response('{}', { status: 404 })
      }) as typeof fetch,
    },
    sub2api: {
      fetch: (async (url: string) => {
        subCalls.push(url)
        if (url.endsWith('/logo.svg')) return new Response('', { status: 404 })
        return new Response(JSON.stringify({
          balance: 8,
          remaining: 7,
          unit: 'USD',
          usage: { today: {}, total: {} },
          daily_usage: [],
          model_stats: [],
        }), { status: 200 })
      }) as typeof fetch,
    },
  })
  const result = await service.read('command-code')
  assert.equal(result?.sub2api?.remaining, 7)
  assert.equal(newCalls[0], 'https://command-upstream.example.test/api/usage/token')
  assert.ok(subCalls.includes('https://command-upstream.example.test/v1/usage'))
})

test('New-API 来源发现过滤所有适配器的官方上游地址', () => {
  const sources = resolveNewApiSources('opencode', undefined, {
    opencode: [
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'official-key' },
      { baseUrl: 'https://new-api.example.test/v1', apiKey: 'proxy-key' },
    ],
  })
  assert.deepEqual(sources, [{ baseUrl: 'https://new-api.example.test/v1', apiKey: 'proxy-key' }])
})

test('New-API Logo 始终使用上游根地址的 logo.png，并清除版本路径与凭据', () => {
  const result = normalizeNewApiUsage(
    { data: { object: 'token_usage', remaining: 4, total_used: 1 } },
    'https://user:secret@new-api.example.test/v1/',
  )
  assert.equal(result?.provider?.baseUrl, 'https://new-api.example.test/v1')
  assert.equal(result?.provider?.logoUrl, 'https://new-api.example.test/logo.png')
})
