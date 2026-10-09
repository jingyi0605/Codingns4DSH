import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { R4SubscriptionService } from '../data/build/dist/host/cli-adapters/r4-subscription.js'
import { ProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'
import { ProviderBalancePopover } from '../data/build/dist/client/subscription-slot.js'
import { en, zh } from '../data/build/dist/client/locales/usage.js'

const source = { baseUrl: 'https://api.r4.codes/v1', apiKey: 'coder-test-secret' }
const meta = { key: { name: 'private', start: 'coder-test' }, plan: { package_name: 'Mini +1', remaining_usd: '12.500000', total_usd: '50', expires_at: '2026-11-01T00:00:00Z' }, wallet: { balance_usd: '3.250000' } }
const key = { limit_usd: '10.000000', spent_usd: '9.000000', held_usd: '2.000000', remaining_usd: '-1.000000' }
const point = { request_count: 2, charged_usd_total: '0.001234', prompt_tokens_total: 1200, completion_tokens_total: 40, cache_read_tokens_total: null, cache_creation_tokens_total: 0 }
const usage = { day: '2026-10-09', today: point, series: [{ ...point, bucket: '2026-10-09' }], models: [{ model_slug: 'claude-test', points: [{ bucket: '2026-10-09', request_count: 2, charged_usd_total: '0.001234' }] }] }

function reader(payloads: Record<string, unknown> = { meta, key, usage }) {
  return new R4SubscriptionService({ fetch: (async (url, init) => {
    const path = new URL(String(url))
    assert.equal(path.origin, 'https://api.r4.codes')
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${source.apiKey}`)
    assert.equal(init?.redirect, 'error')
    assert.ok(init?.signal)
    return Response.json(payloads[path.pathname.split('/').at(-1)!] ?? {})
  }) as typeof fetch })
}

test('R4 keeps account snapshot, Key counters and seven-day ledger separate', async () => {
  const result = await reader().read({ ...source, baseUrl: 'https://user:password@api.r4.codes/v1/?token=private#private' })
  const balance = result!.providerBalance!
  assert.equal(balance.balance, 15.75)
  assert.equal(balance.total, null)
  assert.equal(balance.used, null)
  assert.equal(balance.r4?.packageBalance, 12.5)
  assert.equal(balance.r4?.walletBalance, 3.25)
  assert.deepEqual(balance.r4?.key, { limit: 10, spent: 9, held: 2, remaining: -1, unlimited: false })
  assert.equal(balance.r4?.today?.cost, 0.001234)
  assert.equal(balance.r4?.today?.cacheReadTokens, null)
  assert.deepEqual(balance.r4?.models, [{ name: 'claude-test', requests: 2, cost: 0.001234 }])
  assert.equal(balance.expiresAt, undefined)
  assert.doesNotMatch(JSON.stringify(result), /coder-test|private|password|token=/u)
})

test('R4 distinguishes no Key limit, zero limit, missing limit and negative remaining', async () => {
  for (const [limit, unlimited] of [[null, true], ['0', false], [undefined, false]] as const) {
    const result = await reader({ key: { limit_usd: limit, spent_usd: '0', held_usd: '0', remaining_usd: limit === null ? null : '-2' } }).read(source)
    assert.equal(result?.providerBalance?.r4?.key?.unlimited, unlimited)
    assert.equal(result?.providerBalance?.r4?.key?.limit, limit === '0' ? 0 : null)
    assert.equal(result?.providerBalance?.balance, null)
  }
})

test('R4 treats explicit absent plans and wallets as zero, missing or malformed fields as unknown', async () => {
  assert.equal((await reader({ meta: { plan: null, wallet: null } }).read(source))?.providerBalance?.balance, 0)
  assert.equal((await reader({ meta: { plan: null, wallet: { balance_usd: '0' } } }).read(source))?.providerBalance?.balance, 0)
  const partial = await reader({ meta: { plan: { remaining_usd: '4' } } }).read(source)
  assert.equal(partial?.providerBalance?.r4?.packageBalance, 4)
  assert.equal(partial?.providerBalance?.balance, null)
  for (const invalid of [null, '', ' ', 'NaN', true, [], {}, Infinity]) {
    assert.equal(await reader({ meta: { wallet: { balance_usd: invalid } }, key: { spent_usd: invalid }, usage: { today: { request_count: invalid } } }).read(source), null)
  }
})

test('R4 allows partial results and does not retry HTTP failures or invalid JSON', async () => {
  for (const status of [401, 403, 429, 500]) {
    const calls: string[] = []
    const service = new R4SubscriptionService({ fetch: (async (url) => {
      calls.push(String(url))
      return String(url).endsWith('/key') ? Response.json(key) : new Response('not JSON', { status })
    }) as typeof fetch })
    const result = await service.read(source)
    assert.equal(calls.length, 3)
    assert.equal(result?.providerBalance?.balance, null)
    assert.equal(result?.providerBalance?.r4?.key?.remaining, -1)
  }
  const invalid = new R4SubscriptionService({ fetch: (async () => new Response('not JSON')) as typeof fetch })
  assert.equal(await invalid.read(source), null)
})

test('R4 times out requests and refuses nonofficial origins or empty credentials without network calls', async () => {
  let calls = 0
  const service = new R4SubscriptionService({ timeoutMs: 5, fetch: ((_url, init) => {
    calls++
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))
  }) as typeof fetch })
  for (const baseUrl of ['http://api.r4.codes', 'https://api.r4.codes.evil.test', 'https://proxy.test', 'not a URL']) {
    assert.equal(await service.read({ ...source, baseUrl }), null)
  }
  assert.equal(await service.read({ ...source, apiKey: ' ' }), null)
  assert.equal(calls, 0)
  assert.equal(await service.read(source), null)
  assert.equal(calls, 3)
})

test('unified Agent routing recognizes R4 by origin and never probes old protocols or falls back on failure', async () => {
  for (const adapter of ['codex', 'claude-code', 'opencode', 'grok', 'command-code', 'codebuddy', 'workbuddy', 'zcode', 'dsh']) {
    for (const status of [200, 403]) {
      let calls = 0
      const forbidden = async () => { assert.fail('must not probe another protocol or account') }
      const service = new ProviderSubscriptionService({
        newApi: { sources: { [adapter]: source }, fetch: forbidden },
        sub2api: { sources: {}, fetch: forbidden },
        r4: { fetch: (async () => { calls++; return Response.json(status === 200 ? key : {}, { status }) }) as typeof fetch },
      })
      service.codex.read = forbidden
      service.claudeCode.read = forbidden
      service.deepseek.read = forbidden
      const result = await service.read(adapter, 'my-custom-name')
      assert.equal(calls, 3, adapter)
      assert.equal(result?.provider?.id ?? null, status === 200 ? 'r4' : null)
    }
  }
})

test('shared balance popover renders R4 scopes and both locales without lifetime account totals', async () => {
  const result = await reader().read(source)
  for (const dictionary of [en, zh]) {
    const html = renderToStaticMarkup(createElement(ProviderBalancePopover, {
      usage: result!.providerBalance!, providerName: 'R4 Coder', nowMs: Date.now(),
      t: (value: string) => dictionary[value] ?? value,
    }))
    assert.ok(html.includes(dictionary['usage.r4KeyLimit']!))
    assert.ok(html.includes(dictionary['usage.r4TodayCost']!))
    assert.ok(html.includes(dictionary['usage.statTodayRequests']!))
    assert.ok(html.includes(dictionary['usage.accountBalance']!))
    assert.match(html, /15\.75|15.750/u)
    assert.match(html, /-1\.00/u)
    assert.match(html, /0\.001234/u)
    assert.doesNotMatch(html, /coder-test|Total cost|累计费用/u)
    assert.doesNotMatch(html, /<table/u)
    for (const key of ['usage.r4PackageBalance', 'usage.r4WalletBalance', 'usage.r4PackageExpiry', 'usage.r4KeySpent', 'usage.r4KeyHeld', 'usage.r4inputTokens', 'usage.r4AccountUsage']) {
      assert.ok(!html.includes(dictionary[key]!), `${key} should be omitted`)
    }
  }
})
