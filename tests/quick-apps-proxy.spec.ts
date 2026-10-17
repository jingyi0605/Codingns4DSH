import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { QuickAppRemoteOwner, QuickAppRemoteController } from '../src/host/modules/quick-apps/remote.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/index.js'
import { createServer, request } from 'node:http'
import { quickAppStorageKey } from '../src/shared/quick-app-browser-storage.js'
import { PeerHostStore } from '../src/host/modules/peer-host/peer-host-store.js'
import { PeerHostSessionService } from '../src/host/modules/peer-host/peer-host-session.js'
import { PeerHostHttpProxyService } from '../src/host/modules/peer-host/host-api-proxy-service.js'
import { createQuickAppPeerGateway } from '../src/host/modules/peer-host/quick-app-gateway.js'
import { quickAppProxyFixture } from './quick-apps-proxy-fixture.js'
import { quickAppProxyBase } from '../src/shared/quick-app-proxy-path.js'

test('Host proxy uses the existing LAN address, scoped file API and lifecycle without certificates', { timeout: 30_000 }, async t => {
  const f = await quickAppProxyFixture(); t.after(f.dispose)
  const launch = await f.launch()
  assert.equal(launch.isolation, 'sandbox-proxy'); assert.equal(launch.origin, f.origin)
  const get = (path: string, init?: RequestInit) => fetch(f.origin + launch.basePath + path, init)
  const entry = await get('index.html', { headers: { cookie: 'dsh=secret', authorization: 'Bearer secret' } })
  assert.equal(entry.status, 200); assert.match(entry.headers.get('content-security-policy')!, /sandbox allow-scripts/u)
  assert.equal(entry.headers.get('set-cookie'), null)
  assert.equal(await entry.text(), await readFile(join(f.root, 'site/index.html'), 'utf8'))
  assert.equal(f.seen.at(-1)?.cookie, undefined); assert.equal(f.seen.at(-1)?.authorization, undefined, 'LAN does not inject privileged credentials')
  const image = await get('assets/pixel.png'); assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), await readFile(join(f.root, 'site/assets/pixel.png')))
  assert.equal((await get('missing.js')).status, 404)
  assert.equal((await get('folder', { redirect: 'manual' })).headers.get('location'), launch.basePath + 'folder/')
  assert.equal((await get('index.html', { method: 'HEAD' })).headers.get('content-length'), String(Buffer.byteLength(await readFile(join(f.root, 'site/index.html')))))
  const path = '__quickapp/files?path=data/member.json'
  const before = await (await get(path)).json()
  const headers = { origin: 'null', 'content-type': 'text/plain', 'if-match': before.version }
  assert.equal((await get(path, { method: 'OPTIONS', headers: { origin: 'null' } })).status, 204)
  assert.equal((await get(path, { method: 'PUT', headers, body: 'saved via Host' })).status, 200)
  assert.equal((await get(path, { method: 'PUT', headers, body: 'stale' })).status, 412)
  assert.equal((await get(path, { method: 'DELETE', headers })).status, 412)
  assert.equal((await get('__quickapp/files?path=../outside')).status, 403)
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), 'saved via Host')
  const second = await f.launch(); assert.notEqual(second.basePath, launch.basePath)
  await f.service.invalidate(f.app.id)
  assert.equal((await get('index.html')).status, 404); assert.equal(f.routes.size, 1, 'The shared 404 route prevents expired previews falling into the DSH SPA')
  assert.equal((await fetch(f.origin)).status, 200, 'Closing apps leaves normal LAN access running')
  await f.provider.dispose(); assert.equal(f.routes.size, 0)
})

test('sandbox proxy capability is explicit on supported DSH and does not affect older fixtures', () => {
  const ctx = { webServer: { getOrigin: () => 'http://127.0.0.1:12345', register: () => async () => undefined } }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.3']) {
    const capability = createDshCapabilityRegistry(version, 'host', ctx).getProfile(ctx).capabilities.get('quick-app.proxy')
    assert.equal(capability?.status, version === '0.2.0-rc.2' || version === '0.2.1-alpha.3' ? 'ready' : 'unavailable')
    if (capability?.status !== 'ready') assert.ok(capability?.reason)
  }
  assert.equal(createDshCapabilityRegistry('0.2.1-alpha.3', 'host', {}).getProfile({}).capabilities.get('quick-app.proxy')?.status, 'unavailable')
})

test('LAN preview exemption cannot normalize into a privileged DSH route', () => {
  const base = '/__codingns/quick-apps/' + 'a'.repeat(43) + '/'
  assert.equal(quickAppProxyBase(base + 'assets/main.js'), base)
  for (const path of ['../../../api/workspaces', '%2e%2e/%2e%2e/%2e%2e/api/workspaces', '..\\..\\..\\api/workspaces']) {
    assert.equal(quickAppProxyBase(base + path), undefined)
  }
})

test('actual PeerHost HTTP carrier proxies resources through the controlling address and writes only to the owner', { timeout: 30_000 }, async t => {
  const local = await quickAppProxyFixture(); t.after(local.dispose)
  const target = await quickAppProxyFixture(); t.after(target.dispose)
  const owner = new QuickAppRemoteOwner(target.registry.workspaceRoot, target.provider); t.after(() => owner.dispose())
  const secret = 'fixture-peer-management-secret'
  let resources = 0
  const carrier = createServer(async (req, res) => {
    if (req.url !== '/api/codingns/quickApps/remote' || req.method !== 'POST' || req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(403).end(); return }
    let body = ''; for await (const chunk of req) body += chunk
    const envelope = JSON.parse(body)
    assert.equal(envelope.payload.app.workspaceId, 'workspace-a')
    if (envelope.payload.action === 'resource') resources++
    let result
    try { result = { ok: true, value: await owner.handle(envelope.payload.action, envelope.payload, 'authenticated-controlling-host') } }
    catch (error) { result = { ok: false, error: { code: (error as any).code, message: (error as Error).message } } }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }))
  })
  await new Promise<void>(resolve => carrier.listen(0, '127.0.0.1', resolve))
  t.after(async () => { carrier.closeAllConnections(); await new Promise<void>(resolve => carrier.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(carrier.address() as { port: number }).port}`
  let records: any[] = []; const credentials = new Map<string, any>()
  const credentialStore = { read: async (id: string) => credentials.get(id) ?? null, write: async (id: string, value: unknown) => { credentials.set(id, value) }, clear: async (id: string) => { credentials.delete(id) } }
  const store = new PeerHostStore('controller', { read: async () => records, write: async value => { records = [...value] } }, credentialStore, Date.now, () => 'peer-a')
  const record = await store.create({ displayName: 'Owner', route: { kind: 'lan', baseUrl: origin, normalizedOrigin: origin } })
  await store.updateStatus(record.id, 'ready', null); await store.replaceVisibleWorkspaces(record.id, ['workspace-a'])
  credentials.set(record.id, { accessToken: secret, refreshToken: 'unused', expiresAt: Date.now() + 60_000 })
  const gateway = createQuickAppPeerGateway(store, new PeerHostHttpProxyService(store, new PeerHostSessionService(store, credentialStore)), 'controller')
  const remote = new QuickAppRemoteController(() => gateway, undefined, local.provider); t.after(() => remote.dispose())
  const app = { ...target.registry.get(target.app.id), hostId: 'peer-a', workspaceId: createVirtualWorkspaceId('peer-a', 'workspace-a') }
  const launched = await remote.launch(app, 'browser-owner', local.origin) as any
  assert.equal(JSON.stringify(launched).includes(secret), false)
  assert.equal(new URL(launched.url).origin, local.origin)
  const response = await fetch(launched.url); assert.equal(response.status, 200); assert.match(await response.text(), /Ordinary static app/u)
  const resource = local.origin + launched.basePath + '__quickapp/files?path=data/member.json'
  const before = await (await fetch(resource)).json()
  assert.equal((await fetch(resource, { method: 'PUT', headers: { origin: 'null', 'content-type': 'text/plain', 'if-match': before.version }, body: 'owning Host only' })).status, 200)
  assert.equal(await readFile(join(target.root, 'data/member.json'), 'utf8'), 'owning Host only')
  assert.equal(await readFile(join(local.root, 'data/member.json'), 'utf8'), '{"value":1}')
  const image = await fetch(local.origin + launched.basePath + 'assets/pixel.png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), await readFile(join(target.root, 'site/assets/pixel.png')))
  assert.ok(resources >= 4, 'Static bytes and workspace operations use the authenticated HTTP carrier')
  assert.equal((await fetch(local.origin + launched.basePath + 'folder', { redirect: 'manual' })).headers.get('location'), launched.basePath + 'folder/')
  await remote.close(launched.launchId, 'browser-owner')
  assert.equal((await fetch(launched.url)).status, 404)
  const stored = await remote.launch(app, 'browser-owner', local.origin, undefined, true) as any
  assert.equal(stored.storageScope, quickAppStorageKey(app), 'The controlling Host supplies the stable shortcut identity')
  const bootstrap = await new Promise<string>((resolve, reject) => {
    const req = request(stored.url, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } }, res => {
      let body = ''; res.on('data', bytes => { body += String(bytes) }); res.on('end', () => resolve(body)); res.on('error', reject)
    }); req.on('error', reject); req.end()
  })
  assert.ok(bootstrap.includes(stored.storageToken), 'Storage navigation bootstraps survive the actual PeerHost resource carrier')
  assert.match(await (await fetch(stored.url, { headers: { accept: 'text/html' } })).text(), /Ordinary static app/u)
  await remote.close(stored.launchId, 'browser-owner')
})
