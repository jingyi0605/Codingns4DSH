import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { QuickAppService } from '../src/host/modules/quick-apps/service.js'
import { QuickAppRemoteController, QuickAppRemoteOwner } from '../src/host/modules/quick-apps/remote.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { parseQuickAppLanPortsConfig, sameBrowserOrigin } from '../src/dsh-capabilities/host/quick-app-lan-ports.js'
import { configuredQuickAppTransport } from '../src/dsh-capabilities/host/quick-app-transport.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/index.js'
import { isCrossOriginLanBrowserRequest, LanAccessDshProxy, createNodeLanAccessDshRuntime } from '../src/host/lan-access-dsh.js'
import { quickAppLanFixture } from './quick-apps-lan-fixture.js'

test('ordinary LAN access survives public links, rewritten Host, HTTP clients and alternate addresses', { timeout: 30_000 }, async t => {
  const f = await quickAppLanFixture(); t.after(f.dispose)
  const plainProxy = new LanAccessDshProxy(createNodeLanAccessDshRuntime(f.dshPort), `http://127.0.0.1:${f.dshPort}/authenticate`)
  t.after(() => plainProxy.close())
  const plain = await plainProxy.start({ listenHost: '127.0.0.1', listenPort: 0, dshPort: f.dshPort })
  for (const port of [plain.actualListenPort!, f.proxyPort]) {
    const request = (path: string, headers: Record<string, string | undefined>, method = 'GET') => f.http(f.uiOrigin, path, { plain: true, port, headers, method })
    const internalHost = `127.0.0.1:${port}`
    // The existing ingress can replace Host while retaining the browser's public Origin.
    for (const site of ['same-origin', undefined]) {
      const headers = { host: internalHost, origin: f.uiOrigin, referer: `${f.uiOrigin}/`, 'sec-fetch-site': site }
      for (const path of ['/', '/assets/app.js', '/manifest.webmanifest', '/api/workspaces', '/__codingns/session']) {
        assert.equal((await request(path, headers)).status, 200, `${path} through rewritten Host (${site ?? 'HTTP without metadata'})`)
      }
      assert.equal((await request('/api/connection', headers, 'POST')).status, 200)
    }
    assert.equal((await request('/', { host: '192.168.1.20:14443', 'sec-fetch-site': 'none' })).status, 200, 'App uiOrigins does not restrict ordinary LAN addresses')
    assert.equal((await request('/', { host: internalHost, referer: 'https://portal.example/', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).status, 200, 'A user can follow an external link')
    const before = f.requests.length
    for (const [path, method, destination] of [['/api/workspaces', 'GET', 'document'], ['/', 'POST', 'document'], ['/', 'GET', 'iframe']] as const) {
      assert.equal((await request(path, { host: internalHost, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': destination, 'x-forwarded-host': new URL(f.uiOrigin).host }, method)).status, 403)
    }
    assert.equal(f.requests.length, before, 'Foreign API calls, form mutations and frames never reach DSH')
  }
})

test('LAN IP HTTPS ports: real TLS, cookie isolation, writes, original Host admission and restart history', { timeout: 40_000 }, async t => {
  const f = await quickAppLanFixture('10.20.30.40'); t.after(f.dispose)
  assert.equal(f.transport.origins.available!(f.uiOrigin), true)
  const first = await f.launch(); const second = await f.launch()
  assert.equal(new URL(first.origin).hostname, '10.20.30.40')
  assert.notEqual(first.origin, f.uiOrigin); assert.notEqual(first.origin, second.origin)
  assert.equal(first.isolation, 'lan-port')
  const a = await f.exchange(first); const b = await f.exchange(second)
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  const cookieA = a.headers['set-cookie'][0].split(';')[0]; const cookieB = b.headers['set-cookie'][0].split(';')[0]
  assert.notEqual(cookieA.split('=')[0], cookieB.split('=')[0])
  assert.match(a.headers['set-cookie'][0], /Secure; HttpOnly/u)
  const cookies = `${cookieA}; ${cookieB}; dsh_fixture=general-secret`
  assert.equal((await f.http(first.origin, '/index.html', { headers: { cookie: cookies } })).status, 200)
  assert.equal((await f.http(first.origin, '/index.html', { headers: { cookie: cookieB } })).status, 401)
  assert.equal((await f.http(first.origin, '/index.html', { headers: { cookie: cookies, 'sec-fetch-site': 'same-site', origin: second.origin } })).status, 403)
  assert.equal((await f.http(first.origin, '/index.html', { headers: { cookie: cookies, host: new URL(second.origin).host } })).status, 421)
  assert.equal((await f.exchange(first)).status, 403)
  const path = '/__quickapp/files?path=data/member.json'
  const before = (await f.http(first.origin, path, { headers: { cookie: cookies } })).json()
  const headers = { cookie: cookies, origin: first.origin, 'content-type': 'text/plain', 'if-match': before.version }
  assert.equal((await f.http(first.origin, path, { method: 'PUT', headers, body: 'LAN saved' })).status, 200)
  assert.equal((await f.http(first.origin, path, { method: 'PUT', headers, body: 'stale' })).status, 412)
  assert.equal((await f.http(first.origin, path, { method: 'DELETE', headers })).status, 412)
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), 'LAN saved')
  const upstreamBefore = f.requests.length
  for (const [method, path, extra] of [
    ['GET', '/api/workspaces', { 'sec-fetch-site': 'same-site' }],
    ['POST', '/api/codingns/quickApps/launch', { origin: first.origin }],
    ['GET', '/ws', { origin: first.origin, upgrade: 'websocket', connection: 'Upgrade' }],
  ] as const) assert.equal((await f.http(f.uiOrigin, path, { plain: true, port: f.proxyPort, method, headers: { ...extra, cookie: cookies } })).status, 403)
  assert.equal(f.requests.length, upstreamBefore, 'Cross-app requests never reach privileged DSH')
  const plainProxy = new LanAccessDshProxy(createNodeLanAccessDshRuntime(f.dshPort), `http://127.0.0.1:${f.dshPort}/authenticate`)
  t.after(() => plainProxy.close())
  const plainSnapshot = await plainProxy.start({ listenHost: '127.0.0.1', listenPort: 0, dshPort: f.dshPort })
  assert.equal((await f.http(f.uiOrigin, '/api/workspaces', { plain: true, port: plainSnapshot.actualListenPort!, headers: { origin: first.origin, 'sec-fetch-site': 'same-site' } })).status, 403,
    'Old app pages remain blocked when port transport configuration is absent')
  assert.equal((await f.http(f.uiOrigin, '/api/workspaces', { plain: true, port: f.proxyPort, headers: { origin: f.uiOrigin } })).status, 200)
  assert.equal(f.requests.at(-1)?.origin, `http://127.0.0.1:${f.dshPort}`, 'Legitimate LAN requests retain upstream adaptation')
  await f.service.launches.revoke(first.launchId)
  await assert.rejects(f.http(first.origin, '/index.html', { headers: { cookie: cookies } }), /ECONNREFUSED/u)
  await f.proxy.stop()
  assert.equal(f.transport.origins.diagnostic!(f.uiOrigin), 'lan-stopped')
  await assert.rejects(f.http(second.origin, '/index.html'), /ECONNREFUSED/u)
  await f.transport.dispose()
  const restarted = await configuredQuickAppTransport(f.configPath); t.after(restarted.dispose)
  assert.ok(restarted.lan); restarted.lan.started('127.0.0.1')
  const service = new QuickAppService(f.registry, restarted.origins); t.after(() => service.dispose())
  const third = await service.launch(f.app.id, 'fixture-owner', undefined, f.uiOrigin) as any
  assert.notEqual(third.origin, first.origin); assert.notEqual(third.origin, second.origin)
  assert.equal((await readdir(f.config.stateDirectory)).length, 3)
})

test('LAN transport rejects unsafe configuration and reports missing prerequisites', { timeout: 30_000 }, async t => {
  const f = await quickAppLanFixture(); t.after(f.dispose)
  for (const patch of [{ publicHost: '127.0.0.1' }, { publicHost: 'localhost' }, { publicHost: 'lan.dsh.test/path' },
    { uiOrigins: ['http://lan.dsh.test'] }, { ports: [443, 1000] }, { ports: [4000, 3999] }, { stateDirectory: 'relative' },
    { uiOrigins: [`https://lan.dsh.test:${f.config.ports[0]}`] }]) assert.throws(() => parseQuickAppLanPortsConfig({ ...f.config, ...patch }))
  assert.equal((await configuredQuickAppTransport('')).origins.diagnostic!(), 'not-configured')
  assert.equal((await configuredQuickAppTransport('/not/a/config')).origins.diagnostic!(), 'config-invalid')
  assert.equal(f.transport.origins.diagnostic!('https://unapproved.test'), 'ui-not-allowed')
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.1-alpha.3']) {
    const cap = createDshCapabilityRegistry(version, 'host', {}, { quickAppOrigins: f.transport.origins }).getProfile({}).capabilities.get('quick-app.origin')
    assert.equal(cap?.status, version === '0.2.1-alpha.3' ? 'ready' : 'unavailable')
  }
  for (const headers of [{}, { origin: 'null' }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal(sameBrowserOrigin(headers, f.uiOrigin), false)
  assert.equal(isCrossOriginLanBrowserRequest({}), false, 'Existing non-browser calls keep their authentication path')
  assert.equal(isCrossOriginLanBrowserRequest({ host: new URL(f.uiOrigin).host, origin: f.uiOrigin }), false)
  assert.equal(isCrossOriginLanBrowserRequest({ host: new URL(f.uiOrigin).host, origin: 'null' }), true)
  assert.equal(sameBrowserOrigin({ referer: `${f.uiOrigin}/index.html` }, f.uiOrigin), true)
  const seen: any[] = []
  const lease = await f.transport.origins.open((req, res) => { seen.push({ ...req.headers, raw: req.rawHeaders }); res.end() }, f.uiOrigin)
  const activation = await lease.activate('fixture-scope-only', '/index.html')
  const exchange = await f.exchange({ ...activation, origin: lease.origin })
  const cookie = exchange.headers['set-cookie'][0].split(';')[0]
  await f.http(lease.origin, '/index.html', { headers: { cookie: `${cookie}; dsh_token=general-secret`, authorization: 'Bearer general-secret' } })
  assert.equal(seen[0].cookie, cookie); assert.equal(seen[0].authorization, undefined)
  assert.equal(JSON.stringify(seen).includes('general-secret'), false)
  await lease.dispose()
})

test('LAN port exhaustion is explicit; retired origins are never assigned again', { timeout: 30_000 }, async t => {
  const f = await quickAppLanFixture('lan.dsh.test', 1); t.after(f.dispose)
  const first = await f.launch(); await f.service.launches.revoke(first.launchId)
  assert.equal(f.transport.origins.diagnostic!(f.uiOrigin), 'ports-exhausted')
  await assert.rejects(f.launch(), { code: 'QUICK_APP_TRANSPORT_PORTS_EXHAUSTED', reason: 'ports-exhausted' })
})

test('PeerHost LAN-port launches require the controlling guard and preserve owning workspace routing', { timeout: 30_000 }, async t => {
  const f = await quickAppLanFixture(); t.after(f.dispose)
  const owner = new QuickAppRemoteOwner(f.registry.workspaceRoot, f.transport.origins); t.after(() => owner.dispose())
  const gateway = { call: async (_host: string, workspace: string, action: string, payload: any) => {
    assert.equal(workspace, 'workspace-a'); return owner.handle(action, payload, 'authenticated-controlling-host')
  } }
  const app = { ...f.registry.get(f.app.id), hostId: 'peer-a', workspaceId: createVirtualWorkspaceId('peer-a', 'workspace-a') }
  const unprotected = new QuickAppRemoteController(() => gateway); t.after(() => unprotected.dispose())
  await assert.rejects(unprotected.launch(app, 'browser-owner', f.uiOrigin), { code: 'QUICK_APP_RELAY_UNAVAILABLE' })
  const protectedClient = new QuickAppRemoteController(() => gateway, origin => f.transport.lan!.protects(origin)); t.after(() => protectedClient.dispose())
  const launched = await protectedClient.launch(app, 'browser-owner', f.uiOrigin) as any
  const exchange = await f.exchange(launched); const cookie = exchange.headers['set-cookie'][0].split(';')[0]
  const path = '/__quickapp/files?path=data/member.json'
  const read = await f.http(launched.origin, path, { headers: { cookie } })
  assert.equal(read.status, 200)
  assert.equal((await f.http(launched.origin, path, { method: 'PUT', headers: { cookie, origin: launched.origin, 'content-type': 'text/plain', 'if-match': read.json().version }, body: 'owning Host only' })).status, 200)
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), 'owning Host only')
  await protectedClient.close(launched.launchId, 'browser-owner')
  await assert.rejects(f.http(launched.origin, path, { headers: { cookie } }), /ECONNREFUSED/u)
})
