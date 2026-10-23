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

test('Magpie dashboard session rows show an exact DSH title without fuzzy matches', () => {
  const dashboard = parseMagpieDashboardUsage({
    calls: 2,
    sessions: [
      { id: 'provider-session', agent: 'claude', calls: 1 },
      { id: 'provider-session-suffix', agent: 'claude', calls: 1 },
      { id: 'dsh-session', agent: 'claude', calls: 1 },
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
    { dshSessionId: 'native-dsh-session', adapterId: 'dsh', name: 'Native title' },
  ])
  assert.equal(enriched.sessions.find((row) => row.id === 'provider-session')?.dshSessionName, 'Fix routing')
  assert.equal(enriched.sessions.find((row) => row.id === 'native-dsh-session')?.dshSessionName, 'Native title')
  assert.equal(enriched.sessions.find((row) => row.id === 'provider-session-suffix')?.dshSessionName, undefined)
  assert.equal(enriched.sessions.find((row) => row.id === 'dsh-session')?.dshSessionName, undefined)
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
  assert.deepEqual(cards?.[0]?.daily, [{ day: '2026-10-22', used: 12 }])
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
  assert.equal(page.total, null, 'Web API search totals are not exact session totals')
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
  } as never)

  await settings('set', {
    ops: [{ op: 'set', path: ['modules', 'magpieManagement'], value: true }],
  })
  assert.deepEqual(received, [{ op: 'set', path: ['modules', 'magpieManagement'], value: true }])
})

test('Magpie Management is opt-in and no longer renders a launch button in settings', () => {
  assert.equal(magpieManagementFeature.descriptor.enabledByDefault, false)
  assert.equal(magpieManagementFeature.settingsPanel, undefined)
  assert.equal(magpieManagementFeature.descriptor.ui?.defaultOpen, false)
  assert.match(magpieManagementFeature.descriptor.ui?.description ?? '', /below Plugins in the global sidebar/u)
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
  assert.deepEqual(Object.keys(save?.body ?? {}).sort(), ['chat', 'id', 'models', 'name'])
  assert.deepEqual(save?.body?.models, ['model-b'])
  assert.doesNotMatch(JSON.stringify(save?.body), /raw-secret|balance-secret|sk-live/u)
  assert.equal(fixture.state.providers[0]?.headers && (fixture.state.providers[0].headers as { Authorization: string }).Authorization, 'raw-secret')
  assert.equal(fixture.state.providers[1]?.name, 'Other provider')

  await service.updateProvider({ id: 'demo', on: true })
  assert.ok(fixture.calls.some(item => item.path === '/api/provider/on'))
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
  assert.equal(JSON.stringify(fixture.state.groups[1]), groupBefore)
  assert.equal(JSON.stringify(fixture.state.providers), providerBefore)

  const pattern = await service.updateGroup({ id: 'pattern-pool', name: 'Renamed pattern group' })
  assert.equal(pattern.snapshot.groups[1]?.name, 'Renamed pattern group')
  assert.deepEqual(pattern.snapshot.groups[1]?.patterns, ['demo/*'])

  fixture.changeOtherGroupOnSave = true
  await assert.rejects(service.updateGroup({ id: 'fast-pool', routing: 'order' }), /could not be verified/u)
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
          const current = state.providers.find(provider => provider.id === body?.id)
          assert.ok(current)
          for (const [key, value] of Object.entries(body ?? {})) {
            if (key === 'models' && Array.isArray(value)) {
              current.chosen = [...value]
              current.models = value.map(id => {
                const before = (current.models as Array<{ id: string; name?: string }>).find(model => model.id === id)
                return before ?? { id, name: id }
              })
            } else current[key] = value
          }
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

function cloneRecords<T>(records: readonly T[]): T[] {
  return structuredClone(records)
}
