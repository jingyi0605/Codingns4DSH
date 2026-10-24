import assert from 'node:assert/strict'
import test from 'node:test'
import { attachMagpieSessionNames, MagpieUsageService, parseMagpieDashboardUsage, parseMagpieQuotaCards, parseMagpieQuotaHistory } from '../src/host/cli-adapters/magpie-usage.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createCodingNsSettingsRpcHandler, registerCodingNsRpc } from '../src/host/rpc.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { magpieManagementFeature } from '../src/client/features/magpie-management.js'
import { callMagpieRpc, magpieDashboardIssueForRpcError, magpieManagementIssueForRpcError } from '../src/client/features/magpie-management-page.js'
import {
  MagpieManagementService,
  parseMagpieWebAccounts,
  parseMagpieWebGroups,
  parseMagpieWebProviders,
  readAccountUpdate,
  readGroupUpdate,
  readProviderUpdate,
} from '../src/host/cli-adapters/magpie-management.js'
import { MagpieWebService } from '../src/host/cli-adapters/magpie-web.js'

test('Magpie dashboard parsers preserve verified usage fields and omit unknown/raw fields', () => {
  const usage = parseMagpieDashboardUsage({
    period: 'today', calls: 8, errors: 1, retried: 2, input: 30, output: 50,
    cache_read: 5, cache_write: 3, reasoning: 7, cost: 0.125, unpriced: 1,
    credits: 0.25, credited: 0.1, timed: 6, ttft_ms: 300, decode_ms: 120,
    decode_out: 40, decode_n: 5, sessionCount: 2,
    series: [{ time: '2026-10-22T00:00:00Z', label: '00:00', calls: 3, cost: 0.04, private: 'omit' }],
    agents: [{ id: 'codex', calls: 8 }],
    providerKeys: [{ id: 'key-1', provider: 'example-provider', name: 'Primary', calls: 8, cost: 0.125 }],
    models: [{ model: 'example-provider/model-one', calls: 8 }],
    accounts: [{ account: 'account-label', calls: 8 }],
    sessions: [{ id: 'session-1', agent: 'codex', calls: 8, cost: 0.125 }],
    prompt: 'never return prompt data',
  })

  assert.ok(usage)
  assert.deepEqual(usage.aggregate, {
    calls: 8, errors: 1, retried: 2, inputTokens: 30, outputTokens: 50,
    cacheReadTokens: 5, cacheWriteTokens: 3, reasoningTokens: 7, cost: 0.125,
    unpriced: 1, credits: 0.25, credited: 0.1, timed: 6, ttftMs: 300,
    decodeMs: 120, decodeTokens: 40, decodeCount: 5,
  })
  assert.equal(usage.providers[0]?.provider, 'example-provider')
  assert.equal(usage.accounts[0]?.account, 'account-label')
  assert.equal(usage.sessions[0]?.id, 'session-1')
  assert.equal(usage.series[0]?.label, '00:00')
  assert.doesNotMatch(JSON.stringify(usage), /never return prompt|private/u)

  const noSeries = parseMagpieDashboardUsage({ calls: 0 })
  assert.ok(noSeries, 'an omitted optional series is a partial snapshot, not a failed usage read')
  assert.deepEqual(noSeries.series, [])
  assert.equal(parseMagpieDashboardUsage({ prompt: 'unrecognized only' }), null)
})

test('Magpie dashboard session rows aggregate exact provider and DSH identities', () => {
  const dashboard = parseMagpieDashboardUsage({
    calls: 2,
    sessions: [
      { id: 'provider-session', agent: 'claude', calls: 2, input: 10, output: 4, cost: 0.25 },
      { id: 'provider-session-suffix', agent: 'claude', calls: 1 },
      { id: 'dsh-session', agent: 'claude', calls: 3, input: 20, output: 6, cost: 0.75 },
      { id: 'other-provider-session', agent: 'claude', calls: 4, cost: 2 },
      { id: 'native-dsh-session', agent: 'dsh', calls: 1 },
    ],
  })
  assert.ok(dashboard)
  const enriched = attachMagpieSessionNames({
    period: 'today', capturedAt: '2026-10-23T00:00:00Z', availabilityIssue: null,
    usageStatus: 'available', aggregate: dashboard.aggregate, series: dashboard.series,
    agents: dashboard.agents, providers: dashboard.providers, models: dashboard.models,
    accounts: dashboard.accounts, sessions: dashboard.sessions, sessionCount: dashboard.sessionCount,
    quotaStatus: 'unavailable', quotas: [], quotaHistoryStatus: 'unavailable', quotaHistory: [],
  }, [
    { dshSessionId: 'dsh-session', providerSessionId: 'provider-session', adapterId: 'claude-code', name: 'Fix routing' },
    { dshSessionId: 'other-dsh-session', providerSessionId: 'other-provider-session', adapterId: 'claude-code', name: 'Other work' },
    { dshSessionId: 'native-dsh-session', adapterId: 'dsh', name: 'Native title' },
  ])
  const aggregated = enriched.sessions.find((row) => row.id === 'dsh-session')
  assert.ok(aggregated)
  assert.equal(aggregated.dshSessionName, 'Fix routing')
  assert.equal(aggregated.calls, 5)
  assert.equal(aggregated.inputTokens, 30)
  assert.equal(aggregated.outputTokens, 10)
  assert.equal(aggregated.cost, 1)
  assert.deepEqual(new Set(aggregated.sessionIds), new Set(['dsh-session', 'provider-session']))
  assert.equal(enriched.sessions.some((row) => row.id === 'provider-session'), false, 'provider ID rows are folded into the DSH session')
  assert.equal(enriched.sessions.find((row) => row.id === 'native-dsh-session')?.dshSessionName, 'Native title')
  assert.equal(enriched.sessions.find((row) => row.id === 'provider-session-suffix')?.dshSessionName, undefined)
  assert.equal(enriched.sessions.find((row) => row.id === 'other-dsh-session')?.cost, 2, 'another DSH binding keeps its own totals')
})

test('Magpie quota cards and history preserve nullable windows and exact observed names', () => {
  const cards = parseMagpieQuotaCards({ data: [{
    provider: 'example-provider', name: 'Example Provider', icon: 'example-provider-color', kind: 'oauth', user: 'user-label',
    plan: 'pro', alias: 'work', balance: 'available', readAt: '2026-10-22T00:00:00Z',
    windows: [{ name: 'weekly', used: 45, remaining: 55, resetsAt: '2026-10-29T00:00:00Z', amount: 45, limit: 100, unit: 'requests' }],
    daily: { days: [{ day: '2026-10-22', used: 12 }] },
  }] })
  const history = parseMagpieQuotaHistory({ data: [{
    provider: 'example-provider', user: 'user-label',
    lines: [{ name: 'weekly', points: [{ at: '2026-10-22T00:00:00Z', left: 55, start: '2026-10-15T00:00:00Z', resetsAt: '2026-10-29T00:00:00Z' }] }],
  }] })

  assert.equal(cards?.[0]?.windows[0]?.remainingPercent, 55)
  assert.equal(cards?.[0]?.icon, 'example-provider-color')
  // `daily` carries the window it covers: `since` is the day Magpie starts counting from.
  assert.deepEqual(cards?.[0]?.daily, { since: null, days: [{ day: '2026-10-22', used: 12 }] })
  assert.equal(history?.[0]?.lines[0]?.points[0]?.left, 55)
  assert.equal(parseMagpieQuotaCards({ data: [{ provider: 'bad', name: 'Bad', windows: 'invalid' }] }), null)
  assert.equal(parseMagpieQuotaHistory({ data: [{ provider: 'bad', lines: [{ name: 'too-many', points: 'invalid' }] }] }), null)
})

test('Magpie dashboard endpoint failures stay independent and expose history availability', async () => {
  const urls: string[] = []
  const service = new MagpieUsageService({
    webApi: { async requestJson(path) {
      urls.push(path)
      if (path.includes('/usage?')) return { calls: 4, input: 10, output: 7, series: [] }
      if (path === '/api/usage/quotas') return []
      if (path.includes('/quotas/history')) throw new Error('history unavailable')
      throw new Error('unexpected gateway route')
    } },
  })

  const dashboard = await service.readDashboard('month')
  assert.equal(dashboard?.usageStatus, 'available')
  assert.equal(dashboard?.availabilityIssue, null)
  assert.equal(dashboard?.aggregate?.calls, 4)
  assert.equal(dashboard?.quotaStatus, 'available')
  assert.deepEqual(dashboard?.quotas, [])
  assert.equal(dashboard?.quotaHistoryStatus, 'unavailable')
  assert.deepEqual(dashboard?.quotaHistory, [])
  assert.deepEqual(urls, [
    '/api/usage?period=30d',
    '/api/usage/quotas',
    '/api/usage/quotas/history?days=30',
  ])
})

test('Magpie dashboard streams each API part and measures the slowest part independently', async () => {
  const timings: Array<{ part: string; elapsedMs: number }> = []
  const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const service = new MagpieUsageService({
    onDashboardTiming: timing => timings.push(timing),
    webApi: {
      async requestJson(path) {
        await delay(path.includes('/history') ? 25 : path.includes('/quotas') ? 12 : 3)
        if (path.includes('/usage?')) return { calls: 4, input: 10, output: 7, series: [] }
        if (path === '/api/usage/quotas') return { data: [{ provider: 'workbuddy', name: 'WorkBuddy', icon: 'workbuddy-color', windows: [] }] }
        if (path.includes('/history')) return []
        throw new Error(`unexpected route ${path}`)
      },
      async requestAssetDataUrl() {
        await delay(80)
        return 'data:image/svg+xml;base64,PHN2Zy8+'
      },
    },
  })
  const chunks = []
  for await (const chunk of service.readDashboardStream('today')) chunks.push(chunk)

  assert.equal(chunks[0]?.part, 'usage', 'the fast overview data arrives without waiting for quota history or logos')
  assert.equal(chunks[0]?.dashboard.usageStatus, 'available')
  assert.equal(chunks[0]?.dashboard.quotaStatus, 'unavailable', 'the cumulative snapshot marks data not received yet as unavailable')
  assert.ok(chunks.find(chunk => chunk.part === 'quotas')?.dashboard.quotas[0]?.logoDataUrl === undefined, 'quota cards arrive before optional logo enrichment')
  assert.ok(chunks.findIndex(chunk => chunk.part === 'complete') < chunks.findIndex(chunk => chunk.part === 'logos'), 'the loading cycle ends before slow optional logos finish')
  assert.equal(chunks.at(-1)?.part, 'logos')
  assert.equal(chunks.find(chunk => chunk.part === 'logos')?.dashboard.quotas[0]?.logoDataUrl, 'data:image/svg+xml;base64,PHN2Zy8+')
  assert.deepEqual(timings.map(timing => timing.part).sort(), ['history', 'quota-logos', 'quotas', 'usage'])
  assert.equal([...timings].sort((left, right) => right.elapsedMs - left.elapsedMs)[0]?.part, 'quota-logos', 'the controlled fixture identifies logo hydration as the longest stage')
})

test('Magpie dashboard serves a fresh cache immediately and refreshes an expired cache in the background', async () => {
  let now = 1_000
  let reads = 0
  const service = new MagpieUsageService({
    now: () => now,
    webApi: { async requestJson(path) {
      reads += 1
      if (path.includes('/usage?')) return { calls: reads, series: [] }
      if (path === '/api/usage/quotas') return []
      if (path.includes('/history')) return []
      throw new Error(`unexpected route ${path}`)
    } },
  })
  const initial = await service.readDashboard('today')
  now += 1_000
  const fresh = await service.readDashboard('today')
  assert.equal(fresh, initial)
  assert.equal(reads, 3, 'a fresh cache avoids all API requests')

  now += 16_000
  const stale = await service.readDashboard('today')
  assert.equal(stale, initial, 'expired data is returned before its refresh completes')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(reads, 6, 'the stale cache refresh starts in the background')
  assert.notEqual(await service.readDashboard('today'), initial, 'the refreshed snapshot replaces the stale cache')
})

test('Magpie quota icons are fetched through the Host Web API and attached as data URLs', async () => {
  const assets: string[] = []
  const service = new MagpieUsageService({
    webApi: {
      async requestJson(path) {
        if (path.includes('/usage?')) return { calls: 1, series: [] }
        if (path === '/api/usage/quotas') return { data: [{ provider: 'workbuddy', name: 'WorkBuddy', icon: 'workbuddy-color', windows: [] }] }
        if (path.includes('/quotas/history')) return []
        throw new Error(`unexpected route ${path}`)
      },
      async requestAssetDataUrl(path) {
        assets.push(path)
        return path === '/icons/workbuddy-color.svg' ? 'data:image/svg+xml;base64,PHN2Zy8+' : null
      },
    },
  })

  const dashboard = await service.readDashboard('today')
  assert.deepEqual(assets, ['/icons/workbuddy-color.svg'])
  assert.equal(dashboard.quotas[0]?.icon, 'workbuddy-color')
  assert.equal(dashboard.quotas[0]?.logoDataUrl, 'data:image/svg+xml;base64,PHN2Zy8+')
})

test('Magpie dashboard reports an automatic Web API startup/authentication failure', async () => {
  const dashboard = await new MagpieUsageService({
    webApi: { async requestJson() { throw new Error('local Web API unavailable') } },
  }).readDashboard('today')
  assert.equal(dashboard.availabilityIssue, 'web-api-unavailable')
  assert.equal(dashboard.usageStatus, 'unavailable')
  assert.equal(dashboard.quotaStatus, 'unavailable')
  assert.equal(dashboard.quotaHistoryStatus, 'unavailable')
  assert.deepEqual(dashboard.sessions, [])
})

test('Magpie page translates Host RPC failure codes into actionable safe diagnoses', () => {
  assert.equal(magpieDashboardIssueForRpcError({ code: 'CODINGNS_RPC_NOT_FOUND' }), 'host-rpc-outdated')
  assert.equal(magpieDashboardIssueForRpcError({ code: 'CODINGNS_MAGPIE_DISABLED' }), 'feature-disabled')
  assert.equal(magpieDashboardIssueForRpcError(new Error('network details remain hidden')), 'host-request-failed')

  assert.equal(magpieManagementIssueForRpcError({ code: 'CODINGNS_RPC_NOT_FOUND' }), 'host-rpc-outdated')
  assert.equal(magpieManagementIssueForRpcError({ code: 'Error', message: 'Unknown Magpie RPC: management/snapshot' }), 'host-rpc-outdated')
  assert.equal(magpieManagementIssueForRpcError({ code: 'Error', message: 'Unknown Magpie RPC: management/provider/update' }), 'host-rpc-outdated')
  assert.equal(magpieManagementIssueForRpcError({ code: 'Error', message: 'Unknown Magpie RPC: management/group/update' }), 'host-rpc-outdated')
  assert.equal(magpieManagementIssueForRpcError({ code: 'Error', message: 'Unknown Magpie RPC: management/account/update' }), 'host-rpc-outdated')
  assert.equal(magpieManagementIssueForRpcError({ code: 'CODINGNS_MAGPIE_DISABLED' }), 'feature-disabled')
  assert.equal(magpieManagementIssueForRpcError({ code: 'Error', message: 'Magpie CLI failed' }), 'host-request-failed')
})

test('Magpie management classifies the legacy Host unknown-action response as an outdated management RPC', async () => {
  const rpc = { async call() {
    return { ok: false as const, error: { code: 'Error', message: 'Unknown Magpie RPC: management/snapshot' } }
  } }
  await assert.rejects(
    callMagpieRpc(rpc, 'management/snapshot', {}),
    (error: unknown) => magpieManagementIssueForRpcError(error) === 'host-rpc-outdated',
  )
})

test('Magpie dashboard RPC uses the CodingNS Host channel and namespaced endpoint', async () => {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown }> = []
  const rpc = { async call(channel: string, endpoint: string, payload: unknown) {
    calls.push({ channel, endpoint, payload })
    return { ok: true as const, value: { available: true } }
  } }

  assert.deepEqual(await callMagpieRpc(rpc, 'usage/dashboard', { period: 'today' }), { available: true })
  assert.deepEqual(await callMagpieRpc(rpc, 'usage/requests', { period: 'week', offset: 0, limit: 50 }), { available: true })
  assert.deepEqual(calls, [
    { channel: '/codingns', endpoint: 'magpie/usage/dashboard', payload: { period: 'today' } },
    { channel: '/codingns', endpoint: 'magpie/usage/requests', payload: { period: 'week', offset: 0, limit: 50 } },
  ])
})

test('Magpie dashboard RPC uses the existing Fetch fallback only for unsupported native routes', async () => {
  const calls: Array<{ channel: string; endpoint: string }> = []
  const rpc = { async call(channel: string, endpoint: string) {
    calls.push({ channel, endpoint })
    if (channel === '/codingns') throw new Error('HTTP 405')
    return { ok: true as const, value: { available: true } }
  } }

  assert.deepEqual(await callMagpieRpc(rpc, 'usage/dashboard', { period: 'today' }), { available: true })
  assert.deepEqual(calls, [
    { channel: '/codingns', endpoint: 'magpie/usage/dashboard' },
    { channel: '/api', endpoint: 'codingns/magpie/usage/dashboard' },
  ])
})

test('Magpie management Host endpoints are registered for the Fetch fallback transport', async (t) => {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let dispose: (() => Promise<void>) | undefined
  const table = new CodingNsRpcTable()
  table.register('magpie', async (action) => ({ action }))
  registerCodingNsRpc({
    effect(effect) { dispose = effect() },
    webServer: { register() { return () => {} } },
    connection: {
      operator: {},
      fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
        routes.set(route.path, route.fetch)
        return () => { routes.delete(route.path) }
      } },
    },
  } as never, table)
  t.after(async () => { await dispose?.() })

  for (const action of ['management/snapshot', 'management/provider/update', 'management/group/update', 'management/account/update']) {
    const endpoint = `magpie/${action}`
    const path = `/api/codingns/${endpoint}`
    const handle = routes.get(path)
    assert.ok(handle, `${path} must be registered`)
    const response = await handle(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 'test-rpc', method: `codingns/${endpoint}`, payload: {} }),
    }))
    assert.equal(response.status, 200)
    const envelope = await response.json() as { result: { ok: boolean; value?: { action: string } } }
    assert.deepEqual(envelope.result, { ok: true, value: { action } })
  }
})

test('Magpie request pages exact-match session/native_session and return only normalized fields', async () => {
  let requestedUrl = ''
  const service = new MagpieUsageService({
    webApi: { async requestJson(path) {
      requestedUrl = path
      return {
        total: 2,
        rows: [
          {
            route_id: 14, t: '2026-10-22T00:00:00Z', agent: 'codingns4dsh',
            provider: 'example-provider', providerAccount: 'user-label', req: 'group/fast',
            served: 'example-provider/model-one', in: 9, out: 4, cost: 0.02,
            priced: true, status: 200, ms: 400, session: 'other-session',
            native_session: 'exact-session', effort: 'high', response_id: 'private-response',
            ep: 'http://private.invalid', err: 'private error',
          },
          {
            route_id: 15, agent: 'codingns4dsh', provider: 'wrong-provider',
            session: 'exact-session-suffix', native_session: 'not-exact',
          },
        ],
      }
    } },
  })

  const page = await service.readRequestPage({
    period: 'week', offset: 0, limit: 10, sessionId: 'exact-session', sessionAgent: 'dsh',
  })
  assert.ok(page)
  assert.match(requestedUrl, /period=7d/u)
  assert.match(requestedUrl, /q=exact-session/u)
  assert.equal(page.total, 1, 'the Host reports the exact total after fully scanning candidate rows')
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0]?.sessionId, 'exact-session', 'the exact identity used to accept the row is returned')
  assert.equal(page.items[0]?.provider, 'example-provider')
  assert.equal(page.items[0]?.account, 'user-label')
  assert.equal(page.items[0]?.group, 'fast')
  const safeRow = JSON.stringify(page.items[0])
  assert.doesNotMatch(safeRow, /private-response|private\.invalid|private error/u)
  assert.equal('responseId' in page.items[0]!, false)

  const invalidPage = await service.readRequestPage({ period: 'week', offset: 1_000_001, limit: 10 })
  assert.equal(invalidPage, null, 'invalid offsets are rejected before a Web API request')
})

test('Magpie session request pages filter before pagination when q returns unrelated candidates', async () => {
  const requested: string[] = []
  const targetRows = (start: number, count: number): readonly Record<string, unknown>[] => Array.from({ length: count }, (_, index) => ({
    route_id: start + index,
    t: `2026-10-24T00:${String(start + index).padStart(2, '0')}:00Z`,
    agent: 'claude',
    session: index === count - 1 ? 'target-session' : `other-${start + index}`,
    provider: 'example-provider',
    req: 'example-provider/model-one',
    served: 'example-provider/model-one',
    status: 200,
  }))
  const service = new MagpieUsageService({
    webApi: { async requestJson(path) {
      requested.push(path)
      const url = new URL(path, 'http://127.0.0.1:3430')
      const offset = Number(url.searchParams.get('offset'))
      return {
        total: 150,
        rows: offset === 0 ? targetRows(0, 100) : targetRows(100, 50),
      }
    } },
  })

  const page = await service.readRequestPage({
    period: 'today', offset: 1, limit: 1, sessionId: 'target-session', sessionAgent: 'claude',
  })
  assert.ok(page)
  assert.deepEqual(page.items.map((item) => item.routeId), [149], 'exact matching happens before the page is sliced')
  assert.equal(page.total, 2, 'a fully scanned candidate result reports the exact session total')
  assert.equal(page.hasMore, false)
  assert.deepEqual(requested.map((path) => new URL(path, 'http://127.0.0.1:3430').searchParams.get('offset')), ['0', '100'])
})

test('Magpie request pages aggregate bounded session aliases and deduplicate ledger rows', async () => {
  const requested: string[] = []
  const service = new MagpieUsageService({
    webApi: { async requestJson(path) {
      requested.push(path)
      const url = new URL(path, 'http://127.0.0.1:3430')
      const identity = url.searchParams.get('q')
      if (identity === 'dsh-session') return {
        total: 2,
        rows: [
          { route_id: 1, agent: 'claude', session: 'dsh-session', provider: 'example-provider', req: 'example-provider/one', cost: 0.01 },
          { route_id: 3, agent: 'claude', session: 'other-session', provider: 'example-provider', req: 'example-provider/other', cost: 8 },
        ],
      }
      if (identity === 'provider-session') return {
        total: 2,
        rows: [
          { route_id: 2, agent: 'claude', session: 'provider-session', provider: 'example-provider', req: 'example-provider/two', cost: 0.02 },
          { route_id: 1, agent: 'claude', native_session: 'provider-session', provider: 'example-provider', req: 'example-provider/duplicate', cost: 0.01 },
        ],
      }
      throw new Error(`unexpected query identity: ${identity}`)
    } },
  })

  const page = await service.readRequestPage({
    period: 'today', offset: 1, limit: 1, sessionId: 'dsh-session', sessionIds: ['dsh-session', 'provider-session'], sessionAgent: 'claude',
  })
  assert.ok(page)
  assert.equal(page.total, 2)
  assert.equal(page.hasMore, false)
  assert.deepEqual(page.items.map((item) => item.routeId), [2], 'pagination is applied after merging and deduplicating aliases')
  assert.deepEqual(requested.map((path) => new URL(path, 'http://127.0.0.1:3430').searchParams.get('q')), ['dsh-session', 'provider-session'])
  assert.equal(await service.readRequestPage({
    period: 'today', offset: 0, limit: 10, sessionId: 'dsh-session', sessionIds: Array.from({ length: 17 }, (_, index) => `id-${index}`), sessionAgent: 'claude',
  }), null, 'direct service callers cannot fan out beyond the bounded alias list')
})

test('Magpie request pages use the resolved ledger session identity for Command Code', async () => {
  const providerSessionId = 'command-acp-session'
  const nativeSessionId = 'native-dsh-session'
  const service = new MagpieUsageService({
    webApi: { async requestJson(path) {
      if (path.startsWith('/api/usage?')) return {
        calls: 1, input: 1, output: 1,
        sessions: [{ agent: 'commandcode', id: nativeSessionId, calls: 1, input: 1, output: 1, cost: 0 }],
      }
      if (path === '/api/usage/quotas') return { data: [] }
      if (path.startsWith('/api/usage/requests')) return {
        total: 1,
        rows: [{ route_id: 1, agent: 'commandcode', session: nativeSessionId, provider: 'example-provider', req: 'example-provider/model-one', served: 'example-provider/model-one', status: 200 }],
      }
      return {}
    } },
  })

  const snapshot = await service.read({
    adapterId: 'command-code', modelId: 'magpie/example-provider/model-one', providerSessionId,
  }, undefined, true, nativeSessionId)
  assert.ok(snapshot)
  assert.equal(snapshot.sessionId, providerSessionId, 'the displayed identity remains the provider session')
  assert.equal(snapshot.requestSessionId, nativeSessionId, 'the request identity follows the Magpie ledger')
})

test('Magpie Host RPCs stay gated until the module setting is enabled', async (t) => {
  const table = new CodingNsRpcTable()
  let dashboardCalls = 0
  let requestCalls = 0
  let managementCalls = 0
  let settings = { ...DEFAULT_CODINGNS_SETTINGS, modules: { magpieManagement: false } }
  const usage = {
    async readDashboard(period: string) {
      dashboardCalls += 1
      return { period }
    },
    async readRequestPage(options: { period: string; offset: number; limit: number }) {
      requestCalls += 1
      return options
    },
  }
  const management = {
    async readSnapshot() { managementCalls += 1; return { providerStatus: 'available' } },
    async updateProvider(value: unknown) { managementCalls += 1; return value },
    async updateGroup(value: unknown) { managementCalls += 1; return value },
    async updateAccount(value: unknown) { managementCalls += 1; return value },
  }
  const registry = new FeatureRegistry({ rpc: table, settings: { get: () => settings, watch: () => () => undefined } } as never)
  registry.register(createCliAdaptersFeature({ registry: new CodingNsCliAdapterRegistry([]), magpieUsage: usage as never, magpieManagement: management as never }))
  await registry.start('cliAdapters')
  t.after(() => registry.disable('cliAdapters'))

  const dashboard = table.resolve('magpie/usage/dashboard')!
  const requests = table.resolve('magpie/usage/requests')!
  const managementSnapshot = table.resolve('magpie/management/snapshot')!
  const providerUpdate = table.resolve('magpie/management/provider/update')!
  const groupUpdate = table.resolve('magpie/management/group/update')!
  const accountUpdate = table.resolve('magpie/management/account/update')!
  await assert.rejects(dashboard.handler(dashboard.action, { period: 'today' }), (error: unknown) => {
    assert.match(error instanceof Error ? error.message : '', /disabled/u)
    assert.equal((error as { code?: string }).code, 'CODINGNS_MAGPIE_DISABLED')
    return true
  })
  await assert.rejects(requests.handler(requests.action, { period: 'today', limit: 10 }), /disabled/u)
  await assert.rejects(managementSnapshot.handler(managementSnapshot.action, {}), /disabled/u)
  assert.equal(dashboardCalls + requestCalls + managementCalls, 0)

  settings = { ...settings, modules: { magpieManagement: true } }
  assert.deepEqual(await dashboard.handler(dashboard.action, { period: 'month' }), { period: 'month' })
  assert.deepEqual(await requests.handler(requests.action, { period: 'week', offset: 0, limit: 10 }), {
    period: 'week', offset: 0, limit: 10,
  })
  assert.equal(dashboardCalls, 1)
  assert.equal(requestCalls, 1)
  assert.deepEqual(await managementSnapshot.handler(managementSnapshot.action, {}), { providerStatus: 'available' })
  assert.deepEqual(await providerUpdate.handler(providerUpdate.action, { id: 'demo', name: 'Renamed' }), { id: 'demo', name: 'Renamed' })
  assert.deepEqual(await groupUpdate.handler(groupUpdate.action, { id: 'fast', routing: 'order' }), { id: 'fast', routing: 'order' })
  assert.deepEqual(await accountUpdate.handler(accountUpdate.action, { agent: 'codex', user: 'account@example.test', on: false }), {
    agent: 'codex', user: 'account@example.test', on: false,
  })
  const unknown = table.resolve('magpie/management/unknown')!
  await assert.rejects(unknown.handler(unknown.action, {}), (error: unknown) => (error as { code?: string }).code === 'CODINGNS_RPC_NOT_FOUND')
  assert.equal(managementCalls, 4)
})

test('Magpie Web starts and stops automatically with the management setting and is disposed with the Host feature', async (t) => {
  let settings = { ...DEFAULT_CODINGNS_SETTINGS, modules: { magpieManagement: true } }
  let onSettingsChange: ((value: typeof settings) => void) | undefined
  const calls: string[] = []
  const web = {
    async start() { calls.push('start') },
    async stop() { calls.push('stop') },
    async dispose() { calls.push('dispose') },
    async requestJson() { return {} },
  }
  const table = new CodingNsRpcTable()
  const registry = new FeatureRegistry({ rpc: table, settings: {
    get: () => settings,
    watch(listener: (value: typeof settings) => void) { onSettingsChange = listener; return () => { onSettingsChange = undefined } },
  } } as never)
  registry.register(createCliAdaptersFeature({
    registry: new CodingNsCliAdapterRegistry([]),
    magpieDetection: { detect: async () => ({
      installed: true,
      platform: 'linux',
      source: 'path',
      command: '/usr/local/bin/magpie',
      version: '0.1.1330',
      reason: null,
      checkedAt: 'test',
    }) } as never,
    magpieWeb: web as unknown as MagpieWebService,
    magpieUsage: { async readDashboard() { throw new Error('unused') } } as never,
    magpieManagement: { async readSnapshot() { throw new Error('unused') } } as never,
  }))
  t.after(() => registry.disable('cliAdapters'))
  await registry.start('cliAdapters')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(calls.includes('start'))

  settings = { ...settings, modules: { magpieManagement: false } }
  onSettingsChange?.(settings)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(calls.includes('stop'))

  await registry.disable('cliAdapters')
  assert.equal(calls.at(-1), 'dispose')
})

test('Magpie module enablement is writable only through the existing settings allowlist', async () => {
  let received: unknown
  const value = { ...DEFAULT_CODINGNS_SETTINGS, modules: {} }
  const settings = createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: 'codingns', revision: 1, value }],
    get: () => value,
    mutate: async (_namespace: string, operations: unknown) => { received = operations },
  } as never, {
    detectMagpie: async () => ({
      installed: true,
      platform: 'linux',
      source: 'path',
      command: '/usr/local/bin/magpie',
      version: '0.1.1330',
      reason: null,
      checkedAt: 'test',
    }),
  })

  await settings('set', {
    ops: [{ op: 'set', path: ['modules', 'magpieManagement'], value: true }],
  })
  assert.deepEqual(received, [{ op: 'set', path: ['modules', 'magpieManagement'], value: true }])
})

test('Magpie Management is opt-in, requires a detected Magpie install, and keeps the launch button out of settings', () => {
  assert.equal(magpieManagementFeature.descriptor.enabledByDefault, false)
  assert.equal(magpieManagementFeature.descriptor.ui?.defaultOpen, false)
  assert.match(magpieManagementFeature.descriptor.ui?.description ?? '', /below Plugins in the global sidebar/u)
  assert.equal(magpieManagementFeature.descriptor.ui?.requirementKey, 'settings.requirement.magpieInstall', 'the settings switch reads the Host detection before allowing enablement')
  assert.equal(magpieManagementFeature.settingsPanel?.name, 'MagpieInstallPanel', 'the card body only explains detection and install, never launches Magpie')
})

test('Magpie Web API parsers normalize providers, accounts, and routing groups without returning credentials', () => {
  const providers = parseMagpieWebProviders({ providers: [{
    id: 'demo', name: 'Demo', chat: 'https://api.example.test/v1?key=never-return-this', off: false,
    key: { set: true, masked: 'sk-…' }, keyList: [{ id: 'default', masked: '••••' }],
    balanceToken: { set: true, takes: 'header', token: 'balance-secret' }, headers: { Authorization: 'raw-secret' },
    chosen: ['model-a'], models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
  }] })
  assert.ok(providers)
  assert.equal(providers.records[0]?.state, 'on')
  assert.deepEqual(providers.records[0]?.endpoints, [
    { field: 'chat', url: 'https://api.example.test/v1', editable: false },
  ])
  assert.deepEqual(providers.records[0]?.models.map(model => ({ id: model.id, exposed: model.exposed })), [
    { id: 'demo/model-a', exposed: true },
    { id: 'demo/model-b', exposed: false },
  ])
  assert.equal(providers.records[0]?.keyMasked, 'sk-…')

  const groups = parseMagpieWebGroups({ groups: [
    { id: 'group/fast-pool', name: 'Fast pool', members: ['demo/model-a'], match: [], routing: 'order', affinity: 'session', agents: ['codex'] },
    { id: 'group/pattern-pool', name: 'Pattern pool', members: [], match: ['demo/*'], routing: 'rotate', affinity: 'auto' },
  ] })
  assert.ok(groups)
  assert.equal(groups.groups[0]?.id, 'fast-pool')
  assert.deepEqual(groups.groups[0]?.usedBy, ['codex'])
  assert.deepEqual(groups.groups[1]?.patterns, ['demo/*'])
  // Absent group settings read as Magpie's own defaults, not as unreadable data.
  assert.equal(groups.groups[0]?.context, 0, 'no context means the largest member\'s window')
  assert.deepEqual(groups.groups[0]?.levels, [], 'no levels means the ones the members share')
  assert.equal(groups.groups[0]?.effort, '', 'no effort means the Agent asks')
  assert.equal(groups.groups[0]?.classifier, null)

  const accounts = parseMagpieWebAccounts([{
    provider: 'codex', user: 'account@example.test', plan: 'Plus',
    windows: [{ name: 'weekly', used: 10, remaining: 90, resetsAt: '2026-10-29T00:00:00Z' }],
  }], { codex: [{
    User: 'account@example.test', balance: 'available',
    access_token: 'account-secret', refresh_token: 'refresh-secret',
  }] }, { providers: [{ id: 'codex', account: { logins: [{
    User: 'account@example.test', active: true, on: false, plan: 'Plus',
    access_token: 'nested-account-secret', refresh_token: 'nested-refresh-secret',
  }] } }] })
  assert.ok(accounts)
  assert.equal(accounts[0]?.agent, 'codex')
  assert.equal(accounts[0]?.windows[0]?.remaining, 90)
  assert.equal(accounts[0]?.active, true, 'provider.account.logins supplies the primary login identity')
  assert.equal(accounts[0]?.on, false, 'provider.account.logins supplies routing eligibility')
  assert.equal(accounts[0]?.balance, 'available')
  assert.doesNotMatch(JSON.stringify({ providers: providers.records, groups: groups.groups, accounts }), /never-return-this|raw-secret|balance-secret|account-secret|refresh-secret|do-not-return|nested-/u)
})

test('Magpie account.Agent links accounts independently of provider.id and unsupported model rows do not hide providers', async () => {
  const providerPayload = { providers: [{
    id: 'openai-subscription', name: 'Codex Plus',
    account: { Agent: 'codex', Name: 'Codex', logins: [{ User: 'primary@example.test', active: true, on: true }] },
    chosen: ['gpt-4.1', 'legacy model id'],
    models: [{ id: 'gpt-4.1', name: 'GPT 4.1' }, { id: 'legacy model id', name: 'Legacy model' }],
  }, {
    id: 'grok', name: 'Grok', chosen: [], models: [{ id: 'grok-4+fast', name: 'Grok 4 Fast' }],
  }] }
  const parsed = parseMagpieWebProviders(providerPayload)
  assert.ok(parsed)
  assert.equal(parsed.partial, true)
  assert.equal(parsed.writesSafe, true)
  assert.equal(parsed.records.length, 2, 'one unsupported model row must not invalidate the provider inventory')
  assert.equal(parsed.records[0]?.accountAgent, 'codex')
  assert.equal(parsed.records[0]?.account, 'Codex')
  assert.deepEqual(parsed.records[0]?.models.map(model => model.id), ['openai-subscription/gpt-4.1'])
  assert.equal(parsed.records[0]?.modelsEditable, false)
  assert.equal(parsed.records[1]?.modelsEditable, true)

  const accounts = parseMagpieWebAccounts(null, null, providerPayload)
  assert.equal(accounts?.[0]?.agent, 'codex', 'nested account.Agent identifies the account owner')

  const writes: string[] = []
  const service = new MagpieManagementService({ webApi: {
    async requestJson(path, options) {
      if (options?.method === 'POST') writes.push(path)
      if (path === '/api/providers') return providerPayload
      if (path === '/api/groups') return { groups: [] }
      if (path === '/api/usage/quotas') return []
      if (path === '/api/login/usage') return { codex: [{ User: 'primary@example.test', active: true, on: true }] }
      throw new Error(`unexpected route ${path}`)
    },
  } })
  const snapshot = await service.readSnapshot()
  assert.equal(snapshot.providerStatus, 'partial')
  assert.equal(snapshot.providers.length, 2)
  assert.equal(snapshot.accounts[0]?.agent, 'codex')
  await assert.rejects(service.updateProvider({ id: 'openai-subscription', models: ['openai-subscription/gpt-4.1'] }), /cannot safely edit/u)
  assert.deepEqual(writes, [], 'unsafe model data cannot be overwritten by a partial list')
})

test('Magpie account status remains available from provider.account.logins when usage feeds fail', async () => {
  const service = new MagpieManagementService({ webApi: {
    async requestJson(path) {
      if (path === '/api/providers') return { providers: [{
        id: 'codex', name: 'Codex', account: { logins: [{ User: 'primary@example.test', active: true, on: true }] },
      }] }
      throw new Error('feed unavailable')
    },
  } })
  const snapshot = await service.readSnapshot()
  assert.equal(snapshot.providerStatus, 'partial')
  assert.equal(snapshot.accountStatus, 'available')
  assert.equal(snapshot.accountApiStatus, 'unavailable')
  assert.deepEqual(snapshot.accounts.map(({ agent, user, active, on }) => ({ agent, user, active, on })), [{
    agent: 'codex', user: 'primary@example.test', active: true, on: true,
  }])
})

test('Magpie management inputs fail closed on unknown fields, cross-provider models, and private endpoints', () => {
  assert.throws(() => readProviderUpdate({ id: 'demo', off: true }), /unsupported field/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', name: 'Renamed', off: true }), /unsupported field/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', endpointField: 'chat', endpointUrl: 'https://user:pass@example.com/v1' }), /HTTP\(S\) URL/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', models: ['other/model'] }), /outside the allowed provider/u)
  assert.deepEqual(readProviderUpdate({ id: 'demo', endpointField: 'anthropic', endpointUrl: 'https://api.example.com/v1' }), {
    id: 'demo', endpointField: 'anthropic', endpointUrl: 'https://api.example.com',
  })
  assert.deepEqual(readProviderUpdate({ id: 'demo', on: false }), { id: 'demo', on: false })
  assert.throws(() => readGroupUpdate({ id: 'fast', routing: 'random' }), /routing policy/u)
  assert.throws(() => readGroupUpdate({ id: 'fast', routing: 'order', secret: 'value' }), /unsupported field/u)
  assert.deepEqual(readGroupUpdate({ id: 'fast', routing: 'manual', pick: 'demo/model-a' }), { id: 'fast', routing: 'manual', pick: 'demo/model-a' })
  assert.throws(() => readGroupUpdate({ id: 'fast', routing: 'order', pick: 'demo/model-a' }), /manual routing group/u)
  assert.throws(() => readGroupUpdate({ id: 'fast', pick: 'not a model' }), /manual routing pick/u)
  assert.deepEqual(readGroupUpdate({ id: 'fast', unlists: true, fast: ['demo/model-a', 'demo/model-a'] }), { id: 'fast', unlists: true, fast: ['demo/model-a'] })
  assert.throws(() => readGroupUpdate({ id: 'fast', unlists: 'yes' }), /group listing/u)
  assert.throws(() => readGroupUpdate({ id: 'fast', fast: ['demo/model-a<b>'] }), /Invalid Magpie group member/u)
  assert.deepEqual(readAccountUpdate({ agent: 'codex', user: 'second@example.test', on: true }), {
    agent: 'codex', user: 'second@example.test', on: true,
  })
  assert.throws(() => readAccountUpdate({ agent: 'codex', user: 'second@example.test', on: true, webApiKey: 'must-not-cross-rpc' }), /unsupported field/u)
  assert.throws(() => readAccountUpdate({ agent: '../codex', user: 'second@example.test', on: true }), /Invalid Magpie account update/u)
  assert.throws(() => readAccountUpdate({ agent: 'codex', user: 'second@example.test', on: 'on' }), /Invalid Magpie account update/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', on: 'off' }), /provider availability/u)
  assert.deepEqual(readProviderUpdate({ id: 'demo', name: 'Renamed' }), { id: 'demo', name: 'Renamed' })
})

test('Magpie account routing updates use Web API login routes and block disabling the final active account', async () => {
  const fixture = createManagementWebApiFixture()
  const service = new MagpieManagementService({ webApi: fixture.api })
  const before = await service.readSnapshot()
  assert.equal(before.accountApiStatus, 'available')
  assert.equal(before.accounts.find(item => item.user === 'secondary@example.test')?.on, false)

  const enabled = await service.updateAccount({ agent: 'codex', user: 'secondary@example.test', on: true })
  assert.equal(enabled.snapshot.accounts.find(item => item.user === 'secondary@example.test')?.on, true)
  const call = fixture.calls.find(item => item.path === '/api/login/on')
  assert.deepEqual(call?.body, { Agent: 'codex', User: 'secondary@example.test' })

  await service.updateAccount({ agent: 'codex', user: 'secondary@example.test', on: false })
  const postsBeforeFinalDisable = fixture.calls.filter(item => item.path === '/api/login/off').length
  await assert.rejects(service.updateAccount({ agent: 'codex', user: 'primary@example.test', on: false }), /at least one account/u)
  assert.equal(fixture.calls.filter(item => item.path === '/api/login/off').length, postsBeforeFinalDisable)
})

test('Magpie provider IDs are read with whether they can be written', () => {
  const parsed = parseMagpieWebProviders({ providers: [
    { id: 'grox-ds', name: 'Grox-Deepseek', chat: 'https://www.mcgrox.top', was: ['grox'] },
    { id: 'b.ai', name: 'Hand-written', chat: 'https://relay.example.test/v1' },
  ] })
  assert.ok(parsed)
  assert.equal(parsed.records[0]?.id, 'grox-ds')
  assert.equal(parsed.records[0]?.name, 'Grox-Deepseek')
  assert.equal(parsed.records[0]?.idEditable, true, 'an ID in Magpie\'s own spelling may be renamed')
  assert.equal(parsed.records[1]?.idEditable, false, 'an ID Magpie stored by hand is one its editor refuses to write')
})

test('Magpie provider ID updates accept only the spelling Magpie writes and only reachable IDs', () => {
  assert.deepEqual(readProviderUpdate({ id: 'demo', newId: 'demo-relay' }), { id: 'demo', newId: 'demo-relay' })
  assert.deepEqual(readProviderUpdate({ id: 'demo', newId: ' Demo-Relay ' }), { id: 'demo', newId: 'demo-relay' }, 'the ID is stored lower case')
  assert.throws(() => readProviderUpdate({ id: 'demo', newId: 'demo' }), /no changes/u, 'an unchanged ID is not a rename')
  assert.deepEqual(readProviderUpdate({ id: 'demo', name: 'Renamed', newId: 'demo-2' }), { id: 'demo', newId: 'demo-2', name: 'Renamed' })
  assert.throws(() => readProviderUpdate({ id: 'demo', newId: 'Demo Relay' }), /Invalid Magpie provider ID/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', newId: '-demo' }), /Invalid Magpie provider ID/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', newId: '' }), /Invalid Magpie provider ID/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', newId: 'magpie' }), /reserves this provider ID/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', newId: 'group' }), /reserves this provider ID/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', newId: 'auto' }), /reserves this provider ID/u)
  assert.throws(() => readProviderUpdate({ id: 'demo', newId: 'x'.repeat(65) }), /Invalid Magpie provider ID/u)
})

test('Magpie provider Web API patches omit credentials and preserve unedited fields through read-back', async () => {
  const fixture = createManagementWebApiFixture()
  const service = new MagpieManagementService({ webApi: fixture.api })
  const result = await service.updateProvider({
    id: 'demo', name: 'Renamed Demo', endpointField: 'chat', endpointUrl: 'https://new.example.test/v1',
    models: ['demo/model-b'], on: false,
  })
  const provider = result.snapshot.providers.find(item => item.id === 'demo')
  assert.equal(provider?.name, 'Renamed Demo')
  assert.equal(provider?.state, 'off')
  assert.deepEqual(provider?.models.map(model => model.id), ['demo/model-b'])
  const save = fixture.calls.find(item => item.path === '/api/provider/save')
  // Every base URL goes back as Magpie returned it, replaced by the one edited: a save that left
  // one out is read as a provider without that API and refused ("a provider needs a base URL").
  assert.deepEqual(save?.body, {
    id: 'demo', name: 'Renamed Demo', chat: 'https://new.example.test/v1',
    responses: 'https://responses.example.test/v1', models: ['model-b'],
  })
  assert.deepEqual(save?.body?.models, ['model-b'])
  assert.doesNotMatch(JSON.stringify(save?.body), /raw-secret|balance-secret|sk-live/u)
  assert.equal(fixture.state.providers[0]?.headers && (fixture.state.providers[0].headers as { Authorization: string }).Authorization, 'raw-secret')
  assert.equal(fixture.state.providers[1]?.name, 'Other provider')

  await service.updateProvider({ id: 'demo', on: true })
  assert.ok(fixture.calls.some(item => item.path === '/api/provider/on'))
})

test('Magpie provider renames save under the current ID and read the provider back under the new one', async () => {
  const fixture = createManagementWebApiFixture()
  const service = new MagpieManagementService({ webApi: fixture.api })
  const otherBefore = JSON.stringify(fixture.state.providers[1])
  const result = await service.updateProvider({ id: 'demo', newId: 'demo-relay', name: 'Relay demo', models: ['demo/model-b'] })
  const saved = result.snapshot.providers.find(item => item.id === 'demo-relay')
  assert.equal(result.id, 'demo-relay', 'the result names the provider by the ID it has now')
  assert.equal(saved?.name, 'Relay demo')
  assert.equal(result.snapshot.providers.some(item => item.id === 'demo'), false, 'the provider no longer answers to the ID it had')
  assert.deepEqual(saved?.models.filter(model => model.exposed).map(model => model.id), ['demo-relay/model-b'], 'picks are read back under the new ID')
  assert.equal(saved?.idEditable, true)
  const save = fixture.calls.find(item => item.path === '/api/provider/save' && item.body?.from !== undefined)
  assert.equal(save?.body?.from, 'demo', 'Magpie saves the fields under the ID the provider had')
  assert.equal(save?.body?.id, 'demo-relay')
  assert.deepEqual(save?.body?.models, ['model-b'], 'a pick is appended to the ID the provider is moved to')
  assert.equal(save?.body?.chat, 'https://api.example.test/v1', 'the base URLs go back as Magpie returned them')
  assert.equal(save?.body?.responses, 'https://responses.example.test/v1')
  assert.equal(JSON.stringify(fixture.state.providers.find(item => item.id === 'other')), otherBefore)
  // The routing group naming the provider's models followed it, as Magpie's own rename does.
  assert.deepEqual(fixture.state.groups[0]?.members, ['demo-relay/model-a', 'demo-relay/model-b'])
  assert.equal(fixture.state.providers.find(item => item.id === 'demo-relay')?.was && (fixture.state.providers.find(item => item.id === 'demo-relay')!.was as string[]).includes('demo'), true)

  // A rename keeps the provider's state switch on the ID it has now.
  await service.updateProvider({ id: 'demo-relay', on: false })
  assert.ok(fixture.calls.some(item => item.path === '/api/provider/off' && item.body?.id === 'demo-relay'))
})

test('Magpie provider renames refuse an ID another provider answers to or one this Host cannot write', async () => {
  const fixture = createManagementWebApiFixture()
  const service = new MagpieManagementService({ webApi: fixture.api })
  fixture.state.providers[1]!.was = ['other-old']
  await assert.rejects(service.updateProvider({ id: 'demo', newId: 'other' }), /already answers to this ID/u)
  await assert.rejects(service.updateProvider({ id: 'demo', newId: 'other-old' }), /already answers to this ID/u, 'an ID Magpie remembers as an alias is taken too')
  assert.equal(fixture.calls.some(item => item.path === '/api/provider/save' && item.body?.from !== undefined), false, 'a refused rename writes nothing')
  await assert.rejects(service.updateProvider({ id: 'legacy.id', newId: 'legacy' }), /cannot be renamed/u)
  // Magpie itself would save over the provider holding the ID, so the Host verifies rather than trusts.
  fixture.overwriteTakenId = true
  await assert.rejects(service.updateProvider({ id: 'demo', newId: 'other' }), /already answers to this ID/u)
})

test('Magpie routing-group Web API writes preserve patterns and isolate other groups and providers', async () => {
  const fixture = createManagementWebApiFixture()
  const service = new MagpieManagementService({ webApi: fixture.api })
  const providerBefore = JSON.stringify(fixture.state.providers)
  const groupBefore = JSON.stringify(fixture.state.groups[1])
  const result = await service.updateGroup({
    id: 'fast-pool', name: 'Balanced pool', models: ['demo/model-b', 'demo/model-a'], routing: 'rotate', stays: 'turn',
  })
  assert.equal(result.snapshot.groups[0]?.name, 'Balanced pool')
  assert.deepEqual(result.snapshot.groups[0]?.members.map(member => member.id), ['demo/model-b', 'demo/model-a'])
  const save = fixture.calls.find(item => item.path === '/api/groups/save')
  assert.deepEqual(save?.body?.members, ['demo/model-b', 'demo/model-a'])
  assert.deepEqual(save?.body?.match, [])
  assert.equal(save?.body?.affinity, 'turn')
  // Magpie's handler writes every group field it receives and resets one it does not: a save
  // must carry the rest of the group back, or it would clear them.
  assert.equal(save?.body?.unlists, false)
  assert.deepEqual(save?.body?.fast, [])
  assert.deepEqual(save?.body?.off, [])
  assert.equal(JSON.stringify(fixture.state.groups[1]), groupBefore)
  assert.equal(JSON.stringify(fixture.state.providers), providerBefore)

  const pattern = await service.updateGroup({ id: 'pattern-pool', name: 'Renamed pattern group' })
  assert.equal(pattern.snapshot.groups[1]?.name, 'Renamed pattern group')
  assert.deepEqual(pattern.snapshot.groups[1]?.patterns, ['demo/*'])

  fixture.changeOtherGroupOnSave = true
  await assert.rejects(service.updateGroup({ id: 'fast-pool', routing: 'order' }), /could not be verified/u)
})

test('Magpie routing-group context, levels, and effort are read, written, and verified', () => {
  const groups = parseMagpieWebGroups({ groups: [
    {
      id: 'group/sized', name: 'Sized', members: ['demo/model-a'], match: [], routing: 'smart',
      context: 200_000, levels: ['low', 'high'], shared: ['low', 'medium', 'high'], effort: 'auto', classifier: 'demo/model-a',
    },
    {
      id: 'group/small', name: 'Small window', members: ['demo/model-b'], match: [], context: -1,
      levels: [], shared: [], effort: '',
    },
  ] })
  assert.ok(groups)
  assert.equal(groups.groups[0]?.context, 200_000)
  assert.deepEqual(groups.groups[0]?.levels, ['low', 'high'])
  assert.deepEqual(groups.groups[0]?.sharedLevels, ['low', 'medium', 'high'])
  assert.equal(groups.groups[0]?.effort, 'auto')
  assert.equal(groups.groups[0]?.classifier, 'demo/model-a')
  assert.equal(groups.groups[1]?.context, -1, 'a negative window is the smallest member\'s')
  assert.equal(groups.groups[1]?.effort, '')
  assert.equal(groups.groups[1]?.classifier, null)

  // A shape this Host cannot write back makes the whole read fail rather than half of it.
  assert.equal(parseMagpieWebGroups({ groups: [{ id: 'group/x', name: 'X', members: [], context: 'big' }] }), null)
  assert.equal(parseMagpieWebGroups({ groups: [{ id: 'group/x', name: 'X', members: [], context: -5 }] }), null)
  assert.equal(parseMagpieWebGroups({ groups: [{ id: 'group/x', name: 'X', members: [], levels: ['extreme'] }] }), null)
  assert.equal(parseMagpieWebGroups({ groups: [{ id: 'group/x', name: 'X', members: [], effort: 'sometimes' }] }), null)
})

test('Magpie routing-group update input accepts only the context, levels, and effort Magpie defines', () => {
  assert.deepEqual(readGroupUpdate({ id: 'g', context: 200_000 }), { id: 'g', context: 200_000 })
  assert.deepEqual(readGroupUpdate({ id: 'g', context: 0 }), { id: 'g', context: 0 })
  assert.deepEqual(readGroupUpdate({ id: 'g', context: -1 }), { id: 'g', context: -1 })
  assert.throws(() => readGroupUpdate({ id: 'g', context: '200k' }), /Invalid group context window/u)
  assert.throws(() => readGroupUpdate({ id: 'g', context: 1.5 }), /Invalid group context window/u)
  assert.throws(() => readGroupUpdate({ id: 'g', context: -2 }), /Invalid group context window/u)
  assert.deepEqual(readGroupUpdate({ id: 'g', levels: ['low', 'high', 'low'] }), { id: 'g', levels: ['low', 'high'] })
  assert.deepEqual(readGroupUpdate({ id: 'g', levels: [] }), { id: 'g', levels: [] }, 'an empty list is "shared"')
  assert.throws(() => readGroupUpdate({ id: 'g', levels: ['extreme'] }), /Invalid group reasoning levels/u)
  assert.deepEqual(readGroupUpdate({ id: 'g', effort: 'auto', classifier: 'demo/model-a' }), { id: 'g', effort: 'auto', classifier: 'demo/model-a' })
  assert.deepEqual(readGroupUpdate({ id: 'g', effort: '', classifier: '' }), { id: 'g', effort: '', classifier: '' })
  assert.throws(() => readGroupUpdate({ id: 'g', effort: 'sometimes' }), /effort policy/u)
  assert.throws(() => readGroupUpdate({ id: 'g', classifier: 'not a model' }), /Invalid group classifier/u)
})

test('Magpie routing-group writes carry the context window, levels, and effort through read-back', async () => {
  const fixture = createManagementWebApiFixture()
  fixture.state.groups[0] = {
    id: 'group/fast-pool', name: 'Fast pool', members: ['demo/model-a', 'demo/model-b'], match: [],
    routing: 'smart', affinity: 'auto', context: 200_000, levels: ['low', 'high'],
    shared: ['low', 'medium', 'high'], effort: 'auto', classifier: 'demo/model-a',
  }
  const service = new MagpieManagementService({ webApi: fixture.api })

  const before = await service.readSnapshot()
  assert.equal(before.groups[0]?.context, 200_000)
  assert.deepEqual(before.groups[0]?.levels, ['low', 'high'])
  assert.equal(before.groups[0]?.effort, 'auto')
  assert.equal(before.groups[0]?.classifier, 'demo/model-a')

  const result = await service.updateGroup({ id: 'fast-pool', context: -1, levels: ['low'], effort: '', classifier: '' })
  assert.equal(result.snapshot.groups[0]?.context, -1)
  assert.deepEqual(result.snapshot.groups[0]?.levels, ['low'])
  assert.equal(result.snapshot.groups[0]?.effort, '')
  assert.equal(result.snapshot.groups[0]?.classifier, null, 'Magpie clears the classifier when the Agent asks')

  const save = fixture.calls.filter(item => item.path === '/api/groups/save').at(-1)
  assert.equal(save?.body?.context, -1)
  assert.deepEqual(save?.body?.levels, ['low'])
  assert.equal(save?.body?.effort, '')
  assert.equal(save?.body?.classifier, '', 'an emptied classifier is sent as Magpie writes it')
  // `shared` is Magpie's own working-out of the members' levels and is never written back.
  assert.equal(save?.body?.shared, undefined)

  // Picking each turn's level needs the model that rates it: without one nothing is written.
  fixture.state.groups[0]!.classifier = null
  const savesBefore = fixture.calls.filter(item => item.path === '/api/groups/save').length
  await assert.rejects(service.updateGroup({ id: 'fast-pool', effort: 'auto' }), /needs the model that rates it/u)
  assert.equal(fixture.calls.filter(item => item.path === '/api/groups/save').length, savesBefore)
})

test('Magpie routing-group writes carry pick, listing, and fast mode through read-back', async () => {
  const fixture = createManagementWebApiFixture()
  fixture.state.groups[0] = {
    id: 'group/fast-pool', name: 'Fast pool', members: ['demo/model-a', 'demo/model-b'], match: [],
    routing: 'manual', affinity: 'session', pick: 'demo/model-a', unlists: true, fast: ['demo/model-b'],
    // memberInfo is how Magpie tells a group which member can go fast (provider.CanFast).
    memberInfo: [{ id: 'demo/model-a', provider: 'demo', name: 'Demo', model: 'model-a' }, { id: 'demo/model-b', provider: 'demo', name: 'Demo', model: 'model-b', canFast: true }],
    firstToken: 30, patience: 120, sink: true, extra: 'preserve',
  }
  const service = new MagpieManagementService({ webApi: fixture.api })

  const before = await service.readSnapshot()
  assert.equal(before.groups[0]?.pick, 'demo/model-a')
  assert.equal(before.groups[0]?.unlists, true)
  assert.deepEqual(before.groups[0]?.fast, ['demo/model-b'])
  assert.deepEqual(before.groups[0]?.members.map(member => [member.id, member.canFast ?? false]), [
    ['demo/model-a', false],
    ['demo/model-b', true],
  ])

  const result = await service.updateGroup({ id: 'fast-pool', pick: 'demo/model-b', unlists: false, fast: [] })
  assert.equal(result.snapshot.groups[0]?.pick, 'demo/model-b')
  assert.equal(result.snapshot.groups[0]?.unlists, false)
  assert.deepEqual(result.snapshot.groups[0]?.fast, [])
  const save = fixture.calls.filter(item => item.path === '/api/groups/save').at(-1)
  assert.equal(save?.body?.pick, 'demo/model-b')
  assert.deepEqual(save?.body?.fast, [])
  // Magpie names a group it found itself `group/<id>`; the save must keep that id.
  assert.equal(save?.body?.id, 'group/fast-pool')
  // Settings this Host does not edit are still written back, because Magpie resets what a save leaves out.
  assert.equal(save?.body?.firstToken, 30)
  assert.equal(save?.body?.patience, 120)
  assert.equal(save?.body?.sink, true)

  // Without a model to send to, a manual group is refused before anything is written.
  const savesBefore = fixture.calls.filter(item => item.path === '/api/groups/save').length
  await assert.rejects(service.updateGroup({ id: 'fast-pool', pick: '' }), /Invalid manual routing pick/u)
  fixture.state.groups[0]!.pick = null
  await assert.rejects(service.updateGroup({ id: 'fast-pool', name: 'Renamed' }), /needs the model it sends to/u)
  assert.equal(fixture.calls.filter(item => item.path === '/api/groups/save').length, savesBefore)
})

test('Magpie routing-group writes refuse a group whose patterns cannot be read back', async () => {
  const fixture = createManagementWebApiFixture()
  // A plugin behind on updates lists its models as null; Magpie still routes the group.
  fixture.state.groups[1]!.members = null
  const service = new MagpieManagementService({ webApi: fixture.api })
  const snapshot = await service.readSnapshot()
  assert.equal(snapshot.groupStatus, 'unavailable', 'a group whose members cannot be read is not offered as editable')
  await assert.rejects(service.updateGroup({ id: 'pattern-pool', name: 'Renamed' }), /unavailable/u)
  assert.equal(fixture.calls.filter(item => item.path === '/api/groups/save').length, 0)
})

test('Magpie management inlines the icon each provider row names, as the subscription page does', async () => {
  const assets: string[] = []
  const service = new MagpieManagementService({
    webApi: {
      // `/api/providers` is the only source of icons; assets are fetched through the Web session.
      async requestJson(path: string) {
        if (path === '/api/providers') return {
          providers: [
            { id: 'claude-upstream', name: 'Claude upstream', icon: 'claude-color', chosen: [], models: [] },
            { id: 'own-upstream', name: 'Own upstream', icon: 'file:0123456789abcdef.png', chosen: [], models: [] },
            { id: 'plain-upstream', name: 'Plain upstream', chosen: [], models: [] },
          ],
        }
        if (path === '/api/groups') return { groups: [] }
        if (path === '/api/usage/quotas') return []
        if (path === '/api/login/usage') return {}
        throw new Error(`unexpected route ${path}`)
      },
      async requestAssetDataUrl(path: string) {
        assets.push(path)
        if (path === '/icons/claude-color.svg') return 'data:image/svg+xml;base64,PHN2Zy8+'
        if (path === '/api/icons/0123456789abcdef.png') return 'data:image/png;base64,AAAA'
        return null
      },
    },
  })

  const snapshot = await service.readSnapshot()
  assert.deepEqual(assets, ['/icons/claude-color.svg', '/api/icons/0123456789abcdef.png'])
  assert.equal(snapshot.providers[0]?.icon, 'claude-color')
  assert.equal(snapshot.providers[0]?.logoDataUrl, 'data:image/svg+xml;base64,PHN2Zy8+')
  assert.equal(snapshot.providers[1]?.logoDataUrl, 'data:image/png;base64,AAAA')
  assert.equal(snapshot.providers[2]?.icon, undefined, 'a provider without an icon is not given one')
  assert.equal(snapshot.providers[2]?.logoDataUrl, undefined)
  assert.equal(snapshot.providerStatus, 'available', 'a missing or unreadable icon never downgrades the provider read')
})

test('Magpie management keeps providers readable when the logo fetch fails', async () => {
  const service = new MagpieManagementService({
    webApi: {
      async requestJson(path: string) {
        if (path === '/api/providers') return {
          providers: [{ id: 'demo', name: 'Demo', icon: 'demo-color', chosen: [], models: [] }],
        }
        if (path === '/api/groups') return { groups: [] }
        if (path === '/api/usage/quotas') return []
        if (path === '/api/login/usage') return {}
        throw new Error(`unexpected route ${path}`)
      },
      async requestAssetDataUrl() { throw new Error('asset route unavailable') },
    },
  })
  const snapshot = await service.readSnapshot()
  assert.equal(snapshot.providers[0]?.name, 'Demo')
  assert.equal(snapshot.providers[0]?.logoDataUrl, undefined)
  assert.equal(snapshot.providerStatus, 'available')
})

test('Magpie management Web API outages are reported as unavailable without a CLI/key setup branch', async () => {
  const service = new MagpieManagementService({ webApi: { async requestJson() { throw new Error('offline') } } })
  const snapshot = await service.readSnapshot()
  assert.equal(snapshot.availabilityIssue, 'web-api-unavailable')
  assert.equal(snapshot.providerStatus, 'unavailable')
  assert.equal(snapshot.groupStatus, 'unavailable')
  assert.equal(snapshot.accountApiStatus, 'unavailable')
})

test('Magpie management service without the Host-owned Web API fails closed without starting a process', async () => {
  const snapshot = await new MagpieManagementService().readSnapshot()
  assert.equal(snapshot.availabilityIssue, 'web-api-unavailable')
  assert.equal(snapshot.providerStatus, 'unavailable')
  assert.equal(snapshot.groupStatus, 'unavailable')
  assert.equal(snapshot.accountApiStatus, 'unavailable')
})

function createManagementWebApiFixture(): {
  readonly state: {
    providers: Array<Record<string, unknown>>
    groups: Array<Record<string, unknown>>
    accounts: Array<{ agent: string; user: string; active: boolean; on: boolean; windows: unknown[] }>
  }
  readonly calls: Array<{ path: string; body: Record<string, unknown> | undefined }>
  readonly api: { requestJson(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<unknown> }
  changeOtherGroupOnSave: boolean
  /** Like Magpie's own handler: a save writes every group field, so a key left out is reset. */
  writeAllGroupFields: boolean
  /** Like Magpie's own handler: a save under a taken ID replaces the provider that has it. */
  overwriteTakenId: boolean
} {
  const state = {
    providers: [
      {
        id: 'demo', name: 'Demo', chat: 'https://api.example.test/v1', responses: 'https://responses.example.test/v1', off: false,
        key: { set: true, masked: 'sk-live-…' }, balanceToken: { set: true, takes: 'header', token: 'balance-secret' },
        headers: { Authorization: 'raw-secret' }, chosen: ['model-a', 'model-b'],
        models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }],
      },
      { id: 'other', name: 'Other provider', chat: 'https://other.example.test/v1', off: false, chosen: ['model-x'], models: [{ id: 'model-x', name: 'Model X' }] },
      // A provider saved under an ID Magpie's own editor refuses to write again.
      { id: 'legacy.id', name: 'Legacy provider', chat: 'https://legacy.example.test/v1', off: false, chosen: [], models: [] },
    ],
    groups: [
      { id: 'group/fast-pool', name: 'Fast pool', members: ['demo/model-a', 'demo/model-b'], match: [], routing: 'order', affinity: 'session', extra: 'preserve' },
      { id: 'group/pattern-pool', name: 'Pattern pool', members: [], match: ['demo/*'], routing: 'order', affinity: 'auto' },
    ],
    accounts: [
      { agent: 'codex', user: 'primary@example.test', active: true, on: true, windows: [] },
      { agent: 'codex', user: 'secondary@example.test', active: false, on: false, windows: [] },
    ],
  }
  const calls: Array<{ path: string; body: Record<string, unknown> | undefined }> = []
  const fixture: ReturnType<typeof createManagementWebApiFixture> = {
    state,
    calls,
    changeOtherGroupOnSave: false,
    writeAllGroupFields: false,
    overwriteTakenId: false,
    api: {
      async requestJson(path, options = {}) {
        const body = options.body !== null && typeof options.body === 'object' && !Array.isArray(options.body)
          ? options.body as Record<string, unknown>
          : undefined
        calls.push({ path, body })
        if (path === '/api/providers') return { providers: cloneRecords(state.providers) }
        if (path === '/api/groups') return { groups: cloneRecords(state.groups) }
        if (path === '/api/usage/quotas') return []
        if (path === '/api/login/usage') return { codex: cloneRecords(state.accounts) }
        if (path === '/api/provider/save') {
          // Magpie saves the fields under `from`, the ID the provider had, then moves the provider
          // to `id`: the groups naming its models follow it, and the old ID stays a remembered alias.
          if (typeof body?.from === 'string' && body.from !== body.id) {
            const before = state.providers.find(provider => provider.id === body.from)
            assert.ok(before, 'a rename saves under the ID the provider had')
            const to = String(body.id)
            const taken = state.providers.find(provider => provider.id === to)
            if (fixture.overwriteTakenId) {
              if (taken !== undefined) state.providers.splice(state.providers.indexOf(taken), 1)
            } else {
              assert.equal(taken, undefined, 'Magpie replaces the provider saved under a taken ID')
            }
            const was = [...(Array.isArray(before.was) ? before.was as string[] : []).filter(alias => alias !== to), body.from]
            applyProviderFields(before, { ...body, id: undefined, from: undefined })
            before.id = to
            before.was = was
            // Magpie takes the groups naming the provider's models with it (agent.RenameProvider).
            const renamed = (member: unknown): unknown => typeof member === 'string' && member.startsWith(`${body.from}/`)
              ? `${to}/${member.slice(String(body.from).length + 1)}`
              : member
            for (const group of state.groups) {
              if (Array.isArray(group.members)) group.members = (group.members as string[]).map(renamed)
              if (Array.isArray(group.match)) group.match = (group.match as string[]).map(renamed)
            }
          }
          const current = state.providers.find(provider => provider.id === body?.id)
          if (current === undefined) {
            assert.ok(body?.from !== undefined || fixture.overwriteTakenId || typeof body?.id !== 'string')
            return { ok: true }
          }
          applyProviderFields(current, body)
          return { ok: true }
        }
        if (path === '/api/provider/on' || path === '/api/provider/off') {
          const current = state.providers.find(provider => provider.id === body?.id)
          assert.ok(current)
          current.off = path.endsWith('/off')
          return { ok: true }
        }
        if (path === '/api/groups/save') {
          const current = state.groups.find(group => group.id === `group/${String(body?.id)}` || group.id === body?.id)
          assert.ok(current)
          Object.assign(current, body)
          if (fixture.writeAllGroupFields) {
            for (const key of MAGPIE_GROUP_SAVE_FIELDS) {
              if (body?.[key] !== undefined) continue
              if (key === 'name' || key === 'members' || key === 'match' || key === 'routing' || key === 'affinity') continue
              delete current[key]
            }
          }
          if (fixture.changeOtherGroupOnSave) state.groups[1]!.name = 'Unexpected side effect'
          return { ok: true }
        }
        if (path === '/api/login/on' || path === '/api/login/off') {
          const current = state.accounts.find(account => account.agent === body?.Agent && account.user === body?.User)
          assert.ok(current)
          current.on = path.endsWith('/on')
          return { ok: true }
        }
        throw new Error(`unexpected Web API route ${path}`)
      },
    },
  }
  return fixture
}

/** Every field Magpie's `/api/groups/save` writes; one left out of the body is reset. */
const MAGPIE_GROUP_SAVE_FIELDS = [
  'id', 'from', 'name', 'members', 'match', 'routing', 'pick', 'affinity', 'sink', 'firstToken', 'patience', 'rules',
  'effort', 'classifier', 'context', 'levels', 'family', 'fast', 'off', 'weights', 'unlists',
] as const

function cloneRecords<T>(records: readonly T[]): T[] {
  return structuredClone(records)
}

/** Write a provider save body onto its stored row, as Magpie's handler stores what the form sent. */
function applyProviderFields(current: Record<string, unknown>, body: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(body)) {
    // `from` names the ID the provider had for that one save; it is not a field of the provider.
    if (key === 'from' || key === 'id') continue
    if (key === 'models' && Array.isArray(value)) {
      current.chosen = [...value]
      current.models = value.map(id => {
        const before = (current.models as Array<{ id: string; name?: string }>).find(model => model.id === id)
        return before ?? { id, name: id }
      })
    } else if (value !== undefined) current[key] = value
  }
}
