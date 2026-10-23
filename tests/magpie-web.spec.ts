import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { FeatureRegistry } from '../src/features/registry.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { MagpieManagementService } from '../src/host/cli-adapters/magpie-management.js'
import { MagpieUsageService } from '../src/host/cli-adapters/magpie-usage.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { MagpieWebService } from '../src/host/cli-adapters/magpie-web.js'

test('Magpie Web starts on a loopback ephemeral port, authenticates, and stops only its owned child', async () => {
  const calls: Array<{ url: URL; method: string; cookie: string | null }> = []
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; pid: undefined; exitCode: number | null; signalCode: NodeJS.Signals | null }
  child.stdout = new PassThrough()
  child.pid = undefined
  child.exitCode = null
  child.signalCode = null
  child.kill = (() => {
    child.exitCode = 0
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }) as ChildProcess['kill']
  const service = new MagpieWebService({
    webKey: '0123456789abcdef',
    resolveCommand: async () => '/mock/bin/magpie',
    spawn: ((command, args, options) => {
      assert.equal(command, '/mock/bin/magpie')
      assert.deepEqual(args, ['web', '--addr', '127.0.0.1:0', '--no-open'])
      assert.equal(options?.env?.MAGPIE_WEB_KEY, '0123456789abcdef')
      assert.equal(options?.env?.MAGPIE_WEB_URL, '')
      queueMicrotask(() => child.stdout.write('● magpie web on http://127.0.0.1:54321/?k=0123456789abcdef\n'))
      return child
    }) as typeof import('node:child_process').spawn,
    fetch: (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const cookie = new Headers(init?.headers).get('cookie')
      calls.push({ url, method, cookie })
      if (url.pathname === '/') {
        assert.equal(url.searchParams.get('k'), '0123456789abcdef')
        return new Response(null, {
          status: 303,
          headers: {
            location: '/',
            'set-cookie': 'magpie_web_54321=0123456789abcdef; Path=/; HttpOnly; SameSite=Lax',
          },
        })
      }
      assert.equal(cookie, 'magpie_web_54321=0123456789abcdef')
      if (url.pathname === '/api/providers') return Response.json({ providers: [] })
      if (url.pathname === '/api/settings') return Response.json({ theme: 'dark' })
      throw new Error(`unexpected path ${url.pathname}`)
    }) as typeof fetch,
  })

  assert.deepEqual(await service.requestJson('/api/settings'), { theme: 'dark' })
  assert.deepEqual(calls.map(call => [call.method, call.url.pathname]), [
    ['GET', '/'],
    ['GET', '/api/providers'],
    ['GET', '/'],
    ['GET', '/api/settings'],
  ])
  await service.dispose()
  assert.equal(child.exitCode, 0)
  await assert.rejects(service.start(), /disposed/u)
})

test('Magpie Web generates an unshared API key when no valid key is configured', async () => {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; pid: undefined; exitCode: number | null; signalCode: NodeJS.Signals | null }
  child.stdout = new PassThrough()
  child.pid = undefined
  child.exitCode = null
  child.signalCode = null
  child.kill = (() => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0, null)); return true }) as ChildProcess['kill']
  let generatedKey = ''
  const service = new MagpieWebService({
    environment: { MAGPIE_WEB_KEY: '' },
    resolveCommand: async () => '/mock/bin/magpie',
    spawn: ((_command, _args, options) => {
      generatedKey = options?.env?.MAGPIE_WEB_KEY ?? ''
      assert.match(generatedKey, /^[A-Za-z0-9_-]{43}$/u)
      queueMicrotask(() => child.stdout.write(`magpie web on http://127.0.0.1:54323/?k=${generatedKey}\n`))
      return child
    }) as typeof import('node:child_process').spawn,
    fetch: (async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/') {
        assert.equal(url.searchParams.get('k'), generatedKey)
        return new Response(null, {
          status: 303,
          headers: { location: '/', 'set-cookie': `magpie_web_54323=${generatedKey}; Path=/; HttpOnly` },
        })
      }
      if (url.pathname === '/api/providers') return Response.json({ providers: [] })
      throw new Error(`unexpected path ${url.pathname}`)
    }) as typeof fetch,
  })

  await service.start()
  assert.notEqual(generatedKey, '')
  await service.dispose()
})

test('Magpie Web rejects unsafe routes, redirects, and oversized JSON without returning response bodies', async () => {
  let mode: 'redirect' | 'oversized' = 'redirect'
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; pid: undefined; exitCode: number | null; signalCode: NodeJS.Signals | null }
  child.stdout = new PassThrough()
  child.pid = undefined
  child.exitCode = null
  child.signalCode = null
  child.kill = (() => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0, null)); return true }) as ChildProcess['kill']
  const service = new MagpieWebService({
    webKey: '0123456789abcdef',
    resolveCommand: async () => '/mock/bin/magpie',
    spawn: (() => {
      queueMicrotask(() => child.stdout.write('magpie web on http://127.0.0.1:54322/\n'))
      return child
    }) as typeof import('node:child_process').spawn,
    fetch: (async (input) => {
      const url = new URL(String(input))
      if (url.pathname === '/') return new Response(null, {
        status: 303,
        headers: { location: '/', 'set-cookie': 'magpie_web_54322=0123456789abcdef; Path=/' },
      })
      if (url.pathname === '/api/providers') return Response.json({ providers: [] })
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://example.com/' } })
      return new Response(JSON.stringify({ message: 'x'.repeat(128) }), {
        headers: { 'content-type': 'application/json', 'content-length': '4194305' },
      })
    }) as typeof fetch,
  })

  await assert.rejects(service.requestJson('/api/../settings'), /Invalid Magpie Web API route/u)
  await assert.rejects(service.requestJson('/api/settings'), /Magpie Web API returned HTTP 302/u)
  mode = 'oversized'
  await assert.rejects(service.requestJson('/api/settings'), /invalid or oversized response/u)
  await service.dispose()
})

test('installed Magpie Web API end-to-end in a temporary isolated profile', { skip: process.env.CODINGNS_MAGPIE_WEB_INTEGRATION !== '1' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-magpie-web-integration-'))
  const home = join(root, 'home')
  const config = join(root, 'config')
  const data = join(root, 'data')
  const cache = join(root, 'cache')
  await Promise.all([mkdir(home), mkdir(config), mkdir(data), mkdir(cache)])
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    MAGPIE_ADDR: '127.0.0.1:0',
    MAGPIE_NO_ACCOUNTS: '1',
    MAGPIE_WEB_URL: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '',
  }
  delete environment.MAGPIE_WEB_KEY
  const setupSyntheticRecord = (args: readonly string[]): void => {
    const result = spawnSync('magpie', [...args], {
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    assert.equal(result.error, undefined, 'the installed Magpie CLI must be executable')
    assert.equal(result.status, 0, `isolated synthetic setup failed for magpie ${args[0]}`)
  }
  try {
    setupSyntheticRecord(['provider', 'add', 'synthetic', 'name=Synthetic', 'url=http://127.0.0.1:4499/v1', 'models=model-a'])
    setupSyntheticRecord(['provider', 'add', 'synthetic-other', 'name=Synthetic Other', 'url=http://127.0.0.1:4498/v1', 'models=model-b'])
    setupSyntheticRecord(['group', 'add', 'CodingNS Integration', 'models=synthetic/model-a,synthetic/*', 'routing=order', 'stays=session'])
    setupSyntheticRecord(['group', 'add', 'CodingNS Untouched', 'models=synthetic-other/model-b', 'routing=smart', 'stays=auto'])
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }

  const settings = {
    ...DEFAULT_CODINGNS_SETTINGS,
    modules: { ...DEFAULT_CODINGNS_SETTINGS.modules, magpieManagement: true },
  }
  const rpc = new CodingNsRpcTable()
  const feature = new FeatureRegistry({
    rpc,
    settings: { get: () => settings, watch: () => () => undefined },
  } as never)
  const web = new MagpieWebService({ environment })
  feature.register(createCliAdaptersFeature({
    registry: new CodingNsCliAdapterRegistry([]),
    magpieWeb: web,
    magpieUsage: new MagpieUsageService({ webApi: web }),
    magpieManagement: new MagpieManagementService({ webApi: web }),
  }))
  try {
    await feature.start('cliAdapters')
    await new Promise(resolve => setImmediate(resolve))

    const readSnapshotRpc = rpc.resolve('magpie/management/snapshot')
    const updateProviderRpc = rpc.resolve('magpie/management/provider/update')
    const updateGroupRpc = rpc.resolve('magpie/management/group/update')
    const readDashboardRpc = rpc.resolve('magpie/usage/dashboard')
    const readRequestsRpc = rpc.resolve('magpie/usage/requests')
    assert.ok(readSnapshotRpc && updateProviderRpc && updateGroupRpc && readDashboardRpc && readRequestsRpc)
    const snapshot = await readSnapshotRpc.handler(readSnapshotRpc.action, {}) as {
      providerStatus: string
      providers: Array<{ id: string; name: string; state: string; endpoints: Array<{ field: string; url: string }> }>
      accountStatus: string
      accountApiStatus: string
      accounts: unknown[]
      groupStatus: string
      groups: Array<{ id: string; name: string; routing: string | null; stays: string | null; patterns: readonly string[] }>
    }
    assert.equal(snapshot.providerStatus, 'available')
    assert.equal(snapshot.accountStatus, 'available')
    assert.equal(snapshot.accountApiStatus, 'available')
    assert.deepEqual(snapshot.accounts, [], 'the temporary profile contains no signed-in accounts')
    assert.equal(snapshot.groupStatus, 'available')
    assert.ok(snapshot.providers.some(provider => provider.id === 'synthetic'))
    assert.ok(snapshot.groups.some(group => group.name === 'CodingNS Integration'))

    const updatedProvider = await updateProviderRpc.handler(updateProviderRpc.action, {
      id: 'synthetic',
      name: 'Synthetic Edited',
      endpointField: 'chat',
      endpointUrl: 'http://127.0.0.1:4499/v2',
      models: ['synthetic/model-a'],
      on: false,
    }) as { snapshot: typeof snapshot }
    const synthetic = updatedProvider.snapshot.providers.find(provider => provider.id === 'synthetic')
    assert.equal(synthetic?.state, 'off')
    assert.equal(synthetic?.name, 'Synthetic Edited')
    assert.equal(synthetic?.endpoints[0]?.url, 'http://127.0.0.1:4499/v2')

    const reenabledProvider = await updateProviderRpc.handler(updateProviderRpc.action, { id: 'synthetic', on: true }) as { snapshot: typeof snapshot }
    assert.equal(reenabledProvider.snapshot.providers.find(provider => provider.id === 'synthetic')?.state, 'on')

    const group = snapshot.groups.find(item => item.name === 'CodingNS Integration')
    const otherGroupBefore = snapshot.groups.find(item => item.name === 'CodingNS Untouched')
    assert.ok(group && otherGroupBefore)
    const updatedGroup = await updateGroupRpc.handler(updateGroupRpc.action, {
      id: group.id,
      name: 'CodingNS Integration Edited',
      models: ['synthetic/model-a', 'synthetic/*'],
      routing: 'rotate',
      stays: 'turn',
    }) as { snapshot: typeof snapshot }
    const savedGroup = updatedGroup.snapshot.groups.find(item => item.id === group.id)
    assert.equal(savedGroup?.name, 'CodingNS Integration Edited')
    assert.equal(savedGroup?.routing, 'rotate')
    assert.equal(savedGroup?.stays, 'turn')
    assert.deepEqual(savedGroup?.patterns, ['synthetic/*'])
    assert.deepEqual(updatedGroup.snapshot.groups.find(item => item.id === otherGroupBefore.id), otherGroupBefore)
    assert.equal(updatedGroup.snapshot.providers.find(provider => provider.id === 'synthetic-other')?.state, 'on')

    const dashboard = await readDashboardRpc.handler(readDashboardRpc.action, { period: 'today' }) as {
      usageStatus: string
      quotaStatus: string
      quotaHistoryStatus: string
    }
    assert.equal(dashboard.usageStatus, 'available')
    assert.equal(dashboard.quotaStatus, 'available')
    assert.equal(dashboard.quotaHistoryStatus, 'available')
    const requestPage = await readRequestsRpc.handler(readRequestsRpc.action, { period: 'today', offset: 0, limit: 10 }) as {
      items: unknown[]
      total: number | null
    }
    assert.deepEqual(requestPage.items, [])
    assert.equal(requestPage.total, 0)

    const paths = [
      '/api/providers',
      '/api/groups',
      '/api/usage?period=today',
      '/api/usage/requests?period=today&offset=0&limit=10',
      '/api/usage/quotas',
      '/api/usage/quotas/history?days=30',
      '/api/login/usage',
    ]
    const values = await Promise.all(paths.map(path => web.requestJson(path)))
    assert.ok(values[0] && typeof values[0] === 'object' && Array.isArray((values[0] as { providers?: unknown }).providers))
    assert.ok(values[1] && typeof values[1] === 'object' && Array.isArray((values[1] as { groups?: unknown }).groups))
    assert.ok(values[2] && typeof values[2] === 'object' && 'calls' in values[2])
    assert.ok(values[3] && typeof values[3] === 'object' && Array.isArray((values[3] as { rows?: unknown }).rows))
    assert.ok(Array.isArray(values[4]))
    assert.ok(Array.isArray(values[5]))
    assert.ok(values[6] !== null && typeof values[6] === 'object', 'login usage is a structured array or per-agent object')
  } finally {
    await feature.disable('cliAdapters')
    await assert.rejects(web.requestJson('/api/providers'), /disposed/u)
    await rm(root, { recursive: true, force: true })
  }
})
