import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { quickAppHttpsFixture } from './quick-apps-https-fixture.js'
import { quickAppLanFixture } from './quick-apps-lan-fixture.js'
import { quickAppFixture, definition } from './quick-apps-fixture.js'
import { PeerHostStore } from '../src/host/modules/peer-host/peer-host-store.js'
import { PeerHostSessionService } from '../src/host/modules/peer-host/peer-host-session.js'
import { PeerHostHttpProxyService } from '../src/host/modules/peer-host/host-api-proxy-service.js'
import { createQuickAppPeerGateway } from '../src/host/modules/peer-host/quick-app-gateway.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { isPeerHostHttpRoute } from '../src/shared/peer-host-http-routes.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { fixtureWorkspaceDirectoryBrowser } from './fixtures/quick-app-directory.js'

for (const transport of ['hostname', 'lan-ports'] as const) test(`PeerHost gateway uses actual HTTP carrier, target-owned ${transport} HTTPS grants, exact workspaces and lifecycle cleanup`, { timeout: 45_000 }, async t => {
  const target = transport === 'hostname' ? await quickAppHttpsFixture() : await quickAppLanFixture(); t.after(target.dispose)
  const local = await quickAppFixture(); t.after(local.dispose)
  const other = await quickAppFixture(); t.after(other.dispose)
  await writeFile(join(other.root, 'data/member.json'), 'other Host')
  const credentials = new Map<string, any>()
  const credentialStore = { read: async (id: string) => credentials.get(id) ?? null, write: async (id: string, value: unknown) => { credentials.set(id, value) }, clear: async (id: string) => { credentials.delete(id) } }
  let records: any[] = []; let sequence = 0
  const store = new PeerHostStore('fixture-owner', { read: async () => records, write: async value => { records = [...value] } }, credentialStore, Date.now, () => `peer-${++sequence}`)
  const targets: string[] = []
  for (const [name, fixture] of [['target', target], ['other', other]] as const) {
    const table = new CodingNsRpcTable(); let settings = { ...DEFAULT_CODINGNS_SETTINGS, quickApps: [] }
    const feature = new FeatureRegistry({ rpc: table, workspaceDirectoryBrowser: fixtureWorkspaceDirectoryBrowser(), resolveManagedWorkspaceRoot: fixture.registry.workspaceRoot, ...(name === 'target' ? { quickAppOrigins: target.provider } : {}), settings: { get: () => settings, update: async patch => { settings = { ...settings, ...patch } } } })
    feature.register(createQuickAppsFeature()); await feature.start('quickApps'); t.after(() => feature.disable('quickApps'))
    const secret = `fixture-management-token-${name}`
    const server = createServer(async (request, response) => {
      if (request.url !== '/api/codingns/quickApps/remote' || request.method !== 'POST' || request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(403); response.end(); return }
      let body = ''; for await (const chunk of request) body += chunk
      const envelope = JSON.parse(body)
      assert.equal(envelope.method, 'quickApps/remote')
      const route = table.resolve(envelope.method)!
      let result: unknown
      try { result = { ok: true, value: await route.handler(route.action, envelope.payload, { peer: { id: 'authenticated-owner' } }) } }
      catch (error) { result = { ok: false, error: { code: (error as any).code, message: (error as Error).message } } }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ result }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const record = await store.create({ displayName: name, route: { kind: 'lan', baseUrl: origin, normalizedOrigin: origin } })
    await store.updateStatus(record.id, 'ready', null); await store.replaceVisibleWorkspaces(record.id, ['workspace-a'])
    credentials.set(record.id, { accessToken: secret, refreshToken: 'unused', expiresAt: Date.now() + 60_000 })
    targets.push(record.id)
  }
  const sessions = new PeerHostSessionService(store, credentialStore)
  const proxy = new PeerHostHttpProxyService(store, sessions)
  const gateway = createQuickAppPeerGateway(store, proxy, 'controlling-host')
  let settings: any = { ...DEFAULT_CODINGNS_SETTINGS, quickApps: [] }
  const rpc = new CodingNsRpcTable()
  const source = new FeatureRegistry({ rpc, quickAppPeerGateway: gateway,
    ...('transport' in target ? { quickAppLanTransport: target.transport.lan } : {}),
    resolveManagedWorkspaceRoot: local.registry.workspaceRoot, settings: { get: () => settings, update: async patch => { settings = { ...settings, ...patch } } } })
  source.register(createQuickAppsFeature()); await source.start('quickApps'); t.after(() => source.disable('quickApps'))
  let connection = new AbortController()
  const invoke = async (action: string, payload: unknown) => rpc.resolve(`quickApps/${action}`)!.handler(action, payload, { peer: { id: 'browser-owner', signal: connection.signal } }) as any
  await writeFile(join(target.root, 'target-only.txt'), 'target')
  const browseScope = { hostId: targets[0], workspaceId: createVirtualWorkspaceId(targets[0], 'workspace-a'), path: '' }
  assert.ok((await invoke('browse', browseScope)).entries.some((entry: any) => entry.name === 'target-only.txt'))
  await assert.rejects(invoke('browse', { ...browseScope, hostId: targets[1] }), { code: 'QUICK_APP_ACCESS_DENIED' })
  await assert.rejects(gateway.call(targets[0], 'unmanaged', 'browse', {}), { code: 'QUICK_APP_HOST_UNAVAILABLE' })
  assert.ok((await gateway.call(targets[0], 'workspace-a', 'browse', { workspaceId: 'unmanaged', path: '' }) as any).entries.length)
  const app = await invoke('upsert', { app: { ...definition, hostId: targets[0], workspaceId: createVirtualWorkspaceId(targets[0], 'workspace-a') }, expectedRevision: 0 })
  assert.equal(settings.quickApps[0].hostId, targets[0]); assert.equal(settings.quickApps[0].workspaceId, createVirtualWorkspaceId(targets[0], 'workspace-a'))
  assert.equal((await invoke('list', { uiOrigin: target.uiOrigin }))[0].availability, 'available')
  await assert.rejects(invoke('upsert', { app: { ...definition, hostId: targets[0], workspaceId: app.workspaceId, entryPath: 'site/missing.html' }, expectedRevision: 0 }), { code: 'QUICK_APP_NOT_FOUND' })
  await assert.rejects(invoke('upsert', { app: { ...definition, hostId: targets[1], workspaceId: app.workspaceId }, expectedRevision: 0 }), { code: 'QUICK_APP_ACCESS_DENIED' })
  await assert.rejects(gateway.call(targets[0], 'unmanaged', 'validate', {}), { code: 'QUICK_APP_HOST_UNAVAILABLE' })
  await invoke('grant', { id: app.id, expectedRevision: 1, permissions: { read: ['data'], write: ['data'], delete: ['data'] } })
  const launch = await invoke('launch', { id: app.id, hostId: targets[1], uiOrigin: target.uiOrigin })
  assert.equal(JSON.stringify(launch).includes('fixture-management-token'), false)
  const exchange = await target.exchange(launch); assert.equal(exchange.status, 200)
  const cookie = exchange.headers['set-cookie'][0].split(';')[0]
  const resource = '/__quickapp/files?path=data/member.json'
  const read = await target.http(launch.origin, resource, { headers: { cookie } })
  const headers = { cookie, origin: launch.origin, 'content-type': 'text/plain', 'if-match': read.json().version }
  assert.equal((await target.http(launch.origin, resource, { method: 'PUT', headers, body: 'owning Host saved' })).status, 200)
  assert.equal((await target.http(launch.origin, resource, { method: 'PUT', headers, body: 'stale' })).status, 412)
  assert.equal((await target.http(launch.origin, resource, { method: 'DELETE', headers })).status, 412)
  assert.equal(await readFile(join(target.root, 'data/member.json'), 'utf8'), 'owning Host saved')
  assert.equal(await readFile(join(local.root, 'data/member.json'), 'utf8'), '{"value":1}')
  assert.equal(await readFile(join(other.root, 'data/member.json'), 'utf8'), 'other Host')
  const document = await invoke('upsert', { app: { ...definition, kind: 'text', entryPath: 'site/空 格.txt', hostId: targets[0], workspaceId: app.workspaceId }, expectedRevision: 0 })
  const text = await invoke('launch', { id: document.id })
  assert.equal(text.kind, 'text'); assert.equal(text.canWrite, false)
  await assert.rejects(invoke('document', { id: text.launchId, operation: 'save', content: 'denied', version: text.version }), { code: 'QUICK_APP_ACCESS_DENIED' })
  await invoke('document', { id: text.launchId, operation: 'allow-edit' })
  await invoke('document', { id: text.launchId, operation: 'save', content: 'owning document', version: text.version, hostId: targets[1], workspaceId: 'wrong' })
  await assert.rejects(invoke('document', { id: text.launchId, operation: 'save', content: 'stale', version: text.version }), { code: 'QUICK_APP_CONFLICT' })
  assert.equal(await readFile(join(target.root, 'site/空 格.txt'), 'utf8'), 'owning document')
  assert.equal(await readFile(join(local.root, 'site/空 格.txt'), 'utf8'), 'unicode\n')
  assert.equal(await readFile(join(other.root, 'site/空 格.txt'), 'utf8'), 'unicode\n')
  await invoke('close', { id: text.launchId })
  await assert.rejects(invoke('document', { id: text.launchId, operation: 'read' }), { code: 'QUICK_APP_ACCESS_DENIED' })
  const trusted = await invoke('upsert', { app: { ...app, fileAccess: 'workspace' }, expectedRevision: app.revision })
  const workspaceLaunch = await invoke('launch', { id: trusted.id, hostId: targets[1], uiOrigin: target.uiOrigin })
  const workspaceExchange = await target.exchange(workspaceLaunch)
  const workspaceCookie = workspaceExchange.headers['set-cookie'][0].split(';')[0]
  const workspacePath = '/__quickapp/files?path=workspace-file.txt'
  const created = await target.http(workspaceLaunch.origin, workspacePath, { method: 'PUT',
    headers: { cookie: workspaceCookie, origin: workspaceLaunch.origin, 'content-type': 'text/plain', 'if-none-match': '*' }, body: 'target workspace' })
  assert.equal(created.status, 200)
  assert.equal(await readFile(join(target.root, 'workspace-file.txt'), 'utf8'), 'target workspace')
  await assert.rejects(readFile(join(local.root, 'workspace-file.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(other.root, 'workspace-file.txt')), { code: 'ENOENT' })
  assert.equal((await target.http(workspaceLaunch.origin, workspacePath, { method: 'DELETE',
    headers: { cookie: workspaceCookie, origin: workspaceLaunch.origin, 'if-match': created.json().version } })).status, 200)
  await invoke('revoke', { id: trusted.id })
  assert.equal(settings.quickApps.find((item: any) => item.id === trusted.id).fileAccess, undefined)
  const afterRevoke = await invoke('launch', { id: trusted.id, uiOrigin: target.uiOrigin })
  const afterExchange = await target.exchange(afterRevoke)
  assert.equal((await target.http(afterRevoke.origin, resource, { headers: { cookie: afterExchange.headers['set-cookie'][0].split(';')[0] } })).status, 403)
  await invoke('close', { id: afterRevoke.launchId })
  connection.abort()
  for (let i = 0; i < 30; i++) { try { await target.http(launch.origin, '/index.html', { headers: { cookie } }); await new Promise(resolve => setTimeout(resolve, 10)) } catch { break } }
  await assert.rejects(target.http(launch.origin, '/index.html', { headers: { cookie } }), /ECONNREFUSED/u)
  await source.disable('quickApps'); await source.start('quickApps')
  connection = new AbortController()
  assert.equal((await invoke('list', { uiOrigin: target.uiOrigin }))[0].hostId, targets[0])
  await store.updateStatus(targets[0], 'disabled', null)
  assert.equal((await invoke('list', { uiOrigin: target.uiOrigin }))[0].availability, 'disconnected-host')
  await assert.rejects(invoke('launch', { id: app.id, uiOrigin: target.uiOrigin }), { code: 'QUICK_APP_HOST_UNAVAILABLE' })
  await store.update(targets[0], { route: { kind: 'relay', deviceId: 'fixture-device', relayEntryId: 'fixture-relay', transportVersion: 'v1' } })
  assert.equal((await invoke('list', { uiOrigin: target.uiOrigin }))[0].availability, 'unsupported-connection')
  assert.equal(isPeerHostHttpRoute('POST', '/api/codingns/quickApps/remote'), true)
  for (const path of ['/api/codingns/quickApps/grant', '/api/codingns/quickApps/remote/admin']) assert.equal(isPeerHostHttpRoute('POST', path), false)
  t.diagnostic('Real local HTTP PeerHost proxy and HTTPS data plane; fixture authentication replaces installed DSH/LAN authentication. No LAN device or relay was used.')
})
