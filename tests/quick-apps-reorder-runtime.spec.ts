import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QuickApp } from '../src/shared/contracts/quick-apps.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { QuickAppRemoteController, QuickAppRemoteOwner } from '../src/host/modules/quick-apps/remote.js'
import { registerCodingNsRpc } from '../src/host/rpc.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { definition, quickAppFixture } from './quick-apps-fixture.js'

const orderRequest = (apps: readonly QuickApp[]) => apps.map(app => ({ id: app.id, expectedRevision: app.revision }))

for (const workspaceAccess of [false, true]) test(`reordering preserves open HTML and ${workspaceAccess ? 'workspace' : 'legacy scoped'} grants`, async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const app = workspaceAccess ? await f.registry.upsert({ ...f.app, fileAccess: 'workspace' }, f.app.revision) : f.app
  await f.registry.upsert({ ...definition, title: 'Second', order: 1 }, 0)
  if (!workspaceAccess) await f.service.grant(app.id, app.revision, { read: ['data'], write: ['data'], delete: ['data'] })
  const opened = await f.launch()
  const launch = f.service.launches.requireOwner(opened.launchId, 'browser-owner')
  assert.equal((await f.http(0, '/index.html')).status, 200)
  await f.registry.reorder(orderRequest(f.registry.list().reverse()))
  assert.equal((await f.http(0, '/index.html')).status, 200)
  await f.launch()
  // Existing viewers and newly opened viewers must retain their granted operations.
  const path = '/__quickapp/files?path=data/member.json'
  for (const index of [0, 1]) {
    const read = await f.http(index, path)
    assert.equal(read.status, 200)
    const headers = { origin: f.connections[index]!.origin, 'content-type': 'text/plain', 'if-match': read.json().version }
    assert.equal((await f.http(index, path, { method: 'PUT', headers, body: `saved from viewer ${index}` })).status, 200)
    assert.equal((await f.http(index, path, { method: 'DELETE', headers })).status, 412)
  }
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), 'saved from viewer 1')
  await f.service.invalidate(app.id)
  assert.throws(() => f.service.launches.authorize(launch), { code: 'QUICK_APP_REVOKED' })
  assert.ok(f.connections.every(connection => connection.closed))
})

test('local text editing survives reordering without losing stale-save checks', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const app = await f.registry.upsert({ ...definition, kind: 'text', entryPath: 'site/空 格.txt', order: 1 }, 0)
  const opened = await f.service.launch(app.id, 'owner') as { launchId: string; version: string }
  const call = (operation: string, extra = {}) => f.service.documents.handle(opened.launchId, 'owner', { operation, ...extra })
  await call('allow-edit')
  await f.registry.reorder(orderRequest(f.registry.list().reverse()))
  await call('save', { version: opened.version, content: '# Kept open' })
  await assert.rejects(call('save', { version: opened.version, content: 'stale' }), { code: 'QUICK_APP_CONFLICT' })
  assert.equal(await readFile(join(f.root, app.entryPath), 'utf8'), '# Kept open')
})

test('remote text editing and a second launch survive order changes on the controlling Host', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const owner = new QuickAppRemoteOwner(f.registry.workspaceRoot); t.after(() => owner.dispose())
  const controller = new QuickAppRemoteController(() => ({ call: async (host, workspace, action, payload) => {
    assert.equal(host, 'peer-target'); assert.equal(workspace, 'workspace-a')
    return owner.handle(action, payload, 'peer-principal')
  } })); t.after(() => controller.dispose())
  let app: QuickApp = { ...f.app, kind: 'text', entryPath: 'site/空 格.txt', hostId: 'peer-target', workspaceId: createVirtualWorkspaceId('peer-target', 'workspace-a') }
  const opened = await controller.launch(app, 'browser', undefined) as { launchId: string; version: string }
  const call = (operation: string, extra = {}) => controller.document(opened.launchId, 'browser', { operation, ...extra }, () => app)
  await call('allow-edit')
  app = { ...app, order: 2, revision: app.revision + 1 }
  await controller.launch(app, 'browser', undefined)
  await call('save', { version: opened.version, content: '# Remote viewer' })
  assert.equal(await readFile(join(f.root, app.entryPath), 'utf8'), '# Remote viewer')
  app = { ...app, entryPath: 'site/data.json', revision: app.revision + 1 }
  await assert.rejects(call('read'), { code: 'QUICK_APP_ACCESS_DENIED' })
})

test('order-independent launches still reject changed file identity, routing and access policy', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const changes: Partial<QuickApp>[] = [
    { hostId: 'other-host' }, { workspaceId: 'other-workspace' }, { entryPath: 'site/other.html' },
    { documentRoot: '' }, { kind: 'text' }, { fileAccess: 'workspace' },
    { mounts: [{ urlPrefix: '/data', workspacePath: 'data', read: true }] }, { spaFallback: false },
  ]
  for (const change of changes) {
    await f.registry.storage.write([f.app])
    const opened = await f.launch()
    const launch = f.service.launches.requireOwner(opened.launchId, 'browser-owner')
    await f.registry.storage.write([{ ...f.app, ...change, order: 2, revision: f.app.revision + 1 }])
    assert.throws(() => f.service.launches.authorize(launch), { code: 'QUICK_APP_REVOKED' }, JSON.stringify(change))
  }
})

test('registered compatibility HTTP route reorders atomically and rejects stale or unauthenticated requests', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  await f.registry.upsert({ ...definition, title: 'Second', order: 1 }, 0)
  let settings = { ...DEFAULT_CODINGNS_SETTINGS, quickApps: [...f.registry.list()] }
  const rpc = new CodingNsRpcTable()
  const features = new FeatureRegistry({ rpc, resolveManagedWorkspaceRoot: f.registry.workspaceRoot,
    settings: { get: () => settings, update: async patch => { settings = { ...settings, ...patch } } } })
  features.register(createQuickAppsFeature()); await features.start('quickApps'); t.after(() => features.disable('quickApps'))
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  let dispose!: () => Promise<void>
  registerCodingNsRpc({ effect(factory: () => () => Promise<void>) { dispose = factory() },
    webServer: { register: () => () => {} },
    connection: { browserPeer: { id: 'owner' },
      admit: ({ headers }: { headers: Headers }) => headers.get('authorization') === 'Bearer fixture-owner'
        ? { peer: { id: 'owner', principal: { kind: 'owner' } } } : { rejection: 401 },
      fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
        routes.set(route.path, route.fetch); return () => { routes.delete(route.path) }
      } } },
  } as never, rpc)
  t.after(() => dispose())
  const server = createServer((req, res) => { void (async () => {
    const route = routes.get(req.url ?? '')
    if (!route) { res.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const response = await route(new Request(`http://127.0.0.1${req.url}`, { method: 'POST',
      headers: { authorization: req.headers.authorization ?? '' }, body: Buffer.concat(chunks) }))
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
  })().catch(error => { res.writeHead(500).end(String(error)) }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/codingns/quickApps/reorder`
  const apps = [...settings.quickApps].reverse()
  const send = (authorized = true) => fetch(url, { method: 'POST', signal: AbortSignal.timeout(5000),
    headers: { authorization: authorized ? 'Bearer fixture-owner' : '' },
    body: JSON.stringify({ rpcId: 'reorder-test', method: 'quickApps/reorder', payload: { apps: orderRequest(apps) } }) })
  assert.equal((await send(false)).status, 401)
  const response = await send()
  assert.equal(response.status, 200)
  const envelope = await response.json() as any
  assert.equal(envelope.result.ok, true)
  assert.deepEqual(settings.quickApps.map(app => app.id), apps.map(app => app.id))
  const stale = await send()
  assert.equal((await stale.json() as any).result.error.code, 'QUICK_APP_CONFLICT')
  await dispose()
  assert.equal(routes.size, 0)
})
