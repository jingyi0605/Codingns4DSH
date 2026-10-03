import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  DEFAULT_SUBSCRIPTION_USAGE_SETTINGS,
  SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS,
  SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS,
  isSubscriptionUsageFresh,
  normalizeSubscriptionUsageSettings,
} from '../data/build/dist/shared/index.js'
import {
  CodexSubscriptionService,
  GrokSubscriptionService,
  KimiSubscriptionService,
  ProviderSubscriptionService,
} from '../data/build/dist/host/cli-adapters/provider-subscription.js'

test('用量查询设置默认值与边界收敛', () => {
  assert.deepEqual(DEFAULT_SUBSCRIPTION_USAGE_SETTINGS, { timeoutSecs: 10, refreshIntervalMins: 5 })
  assert.deepEqual(normalizeSubscriptionUsageSettings(undefined), DEFAULT_SUBSCRIPTION_USAGE_SETTINGS)
  assert.deepEqual(normalizeSubscriptionUsageSettings(null), DEFAULT_SUBSCRIPTION_USAGE_SETTINGS)
  assert.equal(normalizeSubscriptionUsageSettings({ timeoutSecs: 0 }).timeoutSecs, SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS.min)
  assert.equal(normalizeSubscriptionUsageSettings({ timeoutSecs: 9_999 }).timeoutSecs, SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS.max)
  assert.equal(normalizeSubscriptionUsageSettings({ refreshIntervalMins: -1 }).refreshIntervalMins, SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS.min)
  assert.equal(normalizeSubscriptionUsageSettings({ refreshIntervalMins: 99_999 }).refreshIntervalMins, SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS.max)
  assert.deepEqual(
    normalizeSubscriptionUsageSettings({ timeoutSecs: 'x', refreshIntervalMins: 15.6 }),
    { timeoutSecs: 10, refreshIntervalMins: 16 },
  )
})

test('用量查询超时统一下发给所有适配器读取器，单项覆盖优先', () => {
  const service = new ProviderSubscriptionService({ timeoutMs: 4_500 })
  for (const reader of [service.codex, service.claudeCode, service.sub2api, service.deepseek, service.official, service.kimi, service.grok, service.zcode, service.codebuddy]) {
    assert.equal(reader.timeoutMs, 4_500)
  }

  const overridden = new ProviderSubscriptionService({ timeoutMs: 4_500, codex: { timeoutMs: 900 } })
  assert.equal(overridden.codex.timeoutMs, 900)
  assert.equal(overridden.kimi.timeoutMs, 4_500)
  assert.equal(overridden.grok.timeoutMs, 4_500)
  assert.equal(overridden.codebuddy.timeoutMs, 4_500)
})

test('Kimi 用量读取归一化五小时、周与月窗口', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codingns-kimi-'))
  const credentialsPath = join(directory, 'kimi-code.json')
  writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'header.payload.signature',
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
  }))
  const requests = []
  const service = new KimiSubscriptionService({
    credentials: [credentialsPath],
    fetch: async (url) => {
      requests.push(String(url))
      return Response.json({
        usages: {
          limit_5h: { used_ratio: 0.25, reset_time: 4_102_444_800 },
          limit_7d: { used_ratio: 0.5 },
          limit_month_code: { used_ratio: 0.75 },
        },
      })
    },
  })

  const usage = await service.read()
  assert.equal(usage.planType, null)
  assert.equal(usage.primary.usedPercent, 25)
  assert.equal(usage.primary.remainingPercent, 75)
  assert.equal(usage.primary.windowDurationMins, 300)
  assert.equal(usage.primary.resetsAt, 4_102_444_800)
  assert.equal(usage.secondary.usedPercent, 50)
  assert.equal(usage.secondary.windowDurationMins, 10_080)
  assert.equal(usage.monthly.usedPercent, 75)
  assert.equal(usage.monthly.windowDurationMins, null)
  assert.deepEqual(requests, ['https://api.kimi.ai/coding/v1/usages'])
})

test('Kimi 缺失或过期凭据时不发起网络请求', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codingns-kimi-expired-'))
  const expiredPath = join(directory, 'expired.json')
  writeFileSync(expiredPath, JSON.stringify({ access_token: 'a.b.c', expires_at: 1 }))
  const requests = []
  const request = async (url) => {
    requests.push(String(url))
    return Response.json({ usages: { limit_5h: { used_ratio: 0.1 } } })
  }

  const expired = new KimiSubscriptionService({ credentials: [expiredPath], fetch: request })
  assert.equal(await expired.read(), null)
  const missing = new KimiSubscriptionService({ credentials: [join(directory, 'missing.json')], fetch: request })
  assert.equal(await missing.read(), null)
  assert.deepEqual(requests, [])
})

test('Grok 账单 gRPC-web 帧解析出已用百分比与重置时间', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codingns-grok-'))
  const authPath = join(directory, 'auth.json')
  writeFileSync(authPath, JSON.stringify({ 'https://auth.x.ai::client-id': { key: 'grok-token' } }))
  const resetsAt = Math.floor(Date.now() / 1000) + 6 * 86_400
  const payload = grokBillingPayload(30, resetsAt)
  const frame = new Uint8Array(5 + payload.length)
  // data 帧：1 字节 flags + 4 字节大端长度。
  frame.set([0, 0, 0, 0, payload.length], 0)
  frame.set(payload, 5)
  const requests = []
  const service = new GrokSubscriptionService({
    credentials: [authPath],
    fetch: async (url, options) => {
      requests.push({ url: String(url), authorization: options?.headers?.Authorization })
      return new Response(frame, { status: 200 })
    },
  })

  const usage = await service.read()
  assert.equal(usage.primary.usedPercent, 30)
  assert.equal(usage.primary.remainingPercent, 70)
  assert.equal(usage.primary.windowDurationMins, 10_080)
  assert.equal(usage.primary.resetsAt, resetsAt)
  assert.equal(usage.planType, null)
  assert.deepEqual(requests, [{
    url: 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig',
    authorization: 'Bearer grok-token',
  }])
})

test('Grok 缺失凭据或鉴权失败时返回空用量', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codingns-grok-missing-'))
  const request = async () => {
    throw new Error('不应发起请求')
  }
  const missing = new GrokSubscriptionService({ credentials: [join(directory, 'auth.json')], fetch: request })
  assert.equal(await missing.read(), null)

  const authPath = join(directory, 'auth.json')
  writeFileSync(authPath, JSON.stringify({ 'https://auth.x.ai::client-id': { key: 'grok-token' } }))
  const unauthorized = new GrokSubscriptionService({
    credentials: [authPath],
    fetch: async () => new Response('', { status: 401 }),
  })
  assert.equal(await unauthorized.read(), null)
})

test('Codex 订阅快照映射重置次数、到期明细与点数余额', async () => {
  await withoutOpenAiBaseUrl(async () => {
    const methods: string[] = []
    const service = createCodexService((request) => {
      methods.push(request.method)
      if (request.method === 'account/rateLimits/read') {
        return {
          rateLimits: {
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: null,
            credits: { hasCredits: true, unlimited: false, balance: '123.45' },
          },
          rateLimitResetCredits: {
            availableCount: 2,
            credits: [
              { id: 'RateLimitResetCredit_1', resetType: 'codexRateLimits', status: 'available', grantedAt: 1_780_000_000, expiresAt: 1_784_000_000, title: 'Rate-limit reset', description: null },
              { id: 'RateLimitResetCredit_2', status: 'redeemed', expiresAt: 1_700_000_000 },
            ],
          },
        }
      }
      return {}
    })

    const usage = await service.read()
    assert.equal(usage?.resetCredits?.availableCount, 2)
    assert.deepEqual(usage?.resetCredits?.credits, [
      { id: 'RateLimitResetCredit_1', expiresAt: 1_784_000_000, title: 'Rate-limit reset', description: null },
    ])
    assert.deepEqual(usage?.credits, { hasCredits: true, unlimited: false, balance: '123.45' })
    assert.deepEqual(methods, ['initialize', 'account/rateLimits/read'])
  })
})

test('Codex 旧版快照缺少重置券与点数时安全降级', async () => {
  await withoutOpenAiBaseUrl(async () => {
    const service = createCodexService((request) => request.method === 'account/rateLimits/read'
      ? { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null } }
      : {})
    const usage = await service.read()
    assert.equal(usage?.resetCredits, null)
    assert.equal(usage?.credits, null)
  })
})

test('Codex 重置携带幂等键且不指定具体重置券', async () => {
  await withoutOpenAiBaseUrl(async () => {
    const consumed: Record<string, unknown>[] = []
    const service = createCodexService((request) => {
      if (request.method === 'account/rateLimitResetCredit/consume') {
        consumed.push(request.params ?? {})
        return { outcome: 'reset' }
      }
      return {}
    })

    assert.deepEqual(await service.reset(), { outcome: 'reset' })
    assert.equal(consumed.length, 1)
    assert.match(String(consumed[0]?.idempotencyKey), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    assert.equal('creditId' in (consumed[0] ?? {}), false)
  })
})

test('Codex 重置遇到未知结果或缺少方法时报稳定错误', async () => {
  await withoutOpenAiBaseUrl(async () => {
    const unknown = createCodexService((request) => request.method === 'account/rateLimitResetCredit/consume' ? { outcome: 'mystery' } : {})
    await assert.rejects(() => unknown.reset(), /无法识别的重置结果/u)

    const unsupported = createCodexService((request) => request.method === 'account/rateLimitResetCredit/consume'
      ? { error: { code: -32601, message: 'Method not found' } }
      : {})
    await assert.rejects(() => unsupported.reset(), /升级 Codex/u)
  })
})

test('订阅重置仅对官方 Codex 开放，第三方上游与其它 Agent 被拒绝', async () => {
  const service = new ProviderSubscriptionService({
    sub2api: { sources: { codex: { baseUrl: 'https://upstream.example.test', apiKey: 'sub2api-secret' } } },
  })
  await assert.rejects(() => service.reset('codex'), /第三方上游/u)
  await assert.rejects(() => service.reset('claude-code'), /不支持重置订阅/u)
})

test('订阅重置 RPC 已注册到 Host 路由与白名单', async () => {
  const [featureSource, rpcSource] = await Promise.all([
    readFile(new URL('../src/host/cli-adapters/feature.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/host/rpc.ts', import.meta.url), 'utf8'),
  ])
  assert.match(featureSource, /case 'subscription\/reset'/u)
  assert.match(rpcSource, /'cli\/subscription\/reset'/u)
})

interface FakeCodexRequest {
  readonly id?: number
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** 假 app-server：按请求回写 result 或 error，信封与 codex JSONL 协议一致。 */
function createCodexService(handler: (request: FakeCodexRequest) => Record<string, unknown>): CodexSubscriptionService {
  const spawn = ((_command: string, _args: string[]) => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    return {
      stdout,
      stderr,
      stdin: {
        write(data: string): void {
          const request = JSON.parse(data) as FakeCodexRequest
          // 通知（initialized 等）没有 id，不产生响应。
          if (typeof request.id !== 'number') return
          const response = handler(request)
          if (response.error !== undefined) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: response.error })}\n`)
          else stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: response })}\n`)
        },
      },
      kill() { stdout.end(); stderr.end(); return true },
    }
  }) as never
  return new CodexSubscriptionService({
    homeDirectory: '/definitely/missing',
    binaries: ['fake-codex'],
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn,
  })
}

/** 排除真实环境里指向第三方上游的 OPENAI_BASE_URL 干扰 Codex 用例。 */
async function withoutOpenAiBaseUrl(run: () => Promise<void>): Promise<void> {
  const previous = process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_BASE_URL
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previous
  }
}

function grokBillingPayload(usedPercent, resetsAt) {
  const resetField = [0x08, ...varint(resetsAt)]
  const floatField = new Uint8Array(4)
  new DataView(floatField.buffer).setFloat32(0, usedPercent, true)
  const nested = new Uint8Array(5 + 2 + resetField.length)
  nested.set([0x0d, ...floatField], 0)
  nested.set([0x2a, resetField.length, ...resetField], 5)
  const top = new Uint8Array(2 + nested.length)
  top.set([0x0a, nested.length], 0)
  top.set(nested, 2)
  return top
}

function varint(value) {
  const bytes = []
  let rest = value
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return bytes
}

test('用量结果只在刷新间隔内复用', () => {
  const now = 1_700_000_000_000
  assert.equal(isSubscriptionUsageFresh(now - 60_000, now, 5), true)
  assert.equal(isSubscriptionUsageFresh(now - 5 * 60_000, now, 5), false)
  assert.equal(isSubscriptionUsageFresh(now - 5 * 60_000 + 1, now, 5), true)
  assert.equal(isSubscriptionUsageFresh(now - 60_000, now, 0), false)
  assert.equal(isSubscriptionUsageFresh(now - 60_000, now, -1), false)
  assert.equal(isSubscriptionUsageFresh(now + 1_000, now, 5), false)
  assert.equal(isSubscriptionUsageFresh(Number.NaN, now, 5), false)
})
