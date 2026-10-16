import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, symlink, unlink, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { quickAppFixture, definition } from './quick-apps-fixture.js'
import { QuickAppRegistry } from '../src/host/modules/quick-apps/registry.js'
import { QuickAppLaunches } from '../src/host/modules/quick-apps/launches.js'
import { QuickAppService } from '../src/host/modules/quick-apps/service.js'
import { decodeResourceTarget } from '../src/host/modules/quick-apps/paths.js'
import { validateQuickAppOrigin } from '../src/dsh-capabilities/host/quick-app-origin-adapter.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { registerQuickAppFooter } from '../src/dsh-capabilities/client/quick-app-footer-adapter.js'
import { QuickAppsClient } from '../src/client/quick-apps/client.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { createCodingNsSettingsRpcHandler } from '../src/host/rpc.js'
import { serializeWorkspaceMutation } from '../src/host/workspace-file-mutations.js'
import { runHtmlWorkspaceFileOperation } from '../src/host/html-workspace-files.js'

test('metadata persists across service instances, revisions conflict, removal preserves sources', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const second = new QuickAppRegistry(f.registry.storage, f.registry.workspaceRoot)
  assert.deepEqual(second.list(), f.registry.list())
  await assert.rejects(f.registry.upsert({ ...f.app, title: 'Stale' }, 0), { code: 'QUICK_APP_CONFLICT' })
  const updated = await second.upsert({ ...f.app, title: 'Renamed', order: 2 }, f.app.revision)
  assert.equal(updated.revision, 2)
  assert.equal(f.registry.get(updated.id).title, 'Renamed')
  await assert.rejects(second.remove(updated.id, 1), { code: 'QUICK_APP_CONFLICT' })
  await second.remove(updated.id, 2)
  assert.equal(f.registry.list().length, 0)
  assert.ok((await readFile(join(f.root, 'site/index.html'), 'utf8')).includes('Ordinary static app'))
  assert.equal(JSON.stringify(f.saved()).includes('credential'), false)
})

test('sessionless text, exact workspace and Host identity, distinct unavailable states', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const text = await f.registry.upsert({ ...definition, kind: 'text', entryPath: 'site/空 格.txt' }, 0)
  const service = new QuickAppService(f.registry)
  t.after(() => service.dispose())
  const document = await service.launch(text.id, 'owner') as any
  assert.equal(document.kind, 'text'); assert.equal(document.content, 'unicode\n'); assert.equal(document.canWrite, false)
  assert.ok(document.launchId); assert.ok(document.version)
  await assert.rejects(service.launch(f.app.id, 'owner'), { code: 'QUICK_APP_ORIGIN_UNAVAILABLE' })
  await assert.rejects(f.registry.upsert({ ...definition, workspaceId: 'missing' }, 0), { code: 'QUICK_APP_WORKSPACE_UNAVAILABLE' })
  await assert.rejects(f.registry.upsert({ ...definition, hostId: 'peer' }, 0), { code: 'QUICK_APP_HOST_UNAVAILABLE' })
  assert.equal(await f.registry.availability({ ...f.app, hostId: 'peer' }, false), 'disconnected-host')
  assert.equal(await f.registry.availability({ ...f.app, workspaceId: 'missing' }, false), 'missing-workspace')
  assert.equal(await f.registry.availability({ ...f.app, entryPath: 'site/missing.html' }, false), 'missing-file')
  assert.equal(await f.registry.availability(f.app, false), 'unsupported-runtime')
})

test('raw paths reject traversal and ambiguous encoding before URL normalization', () => {
  for (const path of ['/../secret', '/%2e%2e/secret', '/x/../secret', '/x/%2E%2e/secret', '/%252e%252e/secret', '/x%2fy', '/x%5cy', '/x//y', '//elsewhere', '/%ZZ', '/x\\y', '/x%00']) assert.throws(() => decodeResourceTarget(path), { code: 'QUICK_APP_ACCESS_DENIED' }, path)
  assert.deepEqual(decodeResourceTarget('/%E7%A9%BA%20%E6%A0%BC.txt?v=1'), { path: '空 格.txt', query: '?v=1', trailingSlash: false })
})

test('real HTTP preserves source, modules, binary bytes, Unicode, MIME, queries and HEAD', async t => {
  const f = await quickAppFixture(); t.after(f.dispose); await f.launch()
  for (const [path, mime] of [['index.html', 'text/html'], ['assets/classic.js', 'text/javascript'], ['assets/main.mjs', 'text/javascript'], ['assets/dynamic.mjs', 'text/javascript'], ['assets/main.css', 'text/css'], ['data.json', 'application/json'], ['assets/font.woff2', 'font/woff2'], ['assets/pixel.png', 'image/png'], ['空 格.txt', 'text/plain']]) {
    const response = await f.http(0, `/${path.split('/').map(encodeURIComponent).join('/')}?cache=1`)
    assert.equal(response.status, 200, path)
    assert.ok(String(response.headers['content-type']).startsWith(mime), path)
    assert.deepEqual(response.bytes, await readFile(join(f.root, 'site', path)), path)
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  const head = await f.http(0, '/assets/pixel.png', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.ok(Number(head.headers['content-length']) > 0)
  assert.equal((await f.http(0, '/folder?q=1')).headers.location, '/folder/?q=1')
  assert.equal((await f.http(0, '/folder/')).text, '<p>directory</p>')
})

test('HTTP missing resources remain errors; SPA fallback is navigation-only; static methods cannot write', async t => {
  const f = await quickAppFixture(); t.after(f.dispose); await f.launch()
  const navigation = { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  assert.equal((await f.http(0, '/page', { headers: navigation })).status, 200)
  for (const path of ['/page', '/missing.js', '/missing.css', '/missing.json', '/__quickapp/missing']) {
    assert.equal((await f.http(0, path)).status === 200, false, path)
  }
  assert.equal((await f.http(0, '/missing.js', { headers: navigation })).status, 404)
  assert.equal((await f.http(0, '/index.html', { method: 'PUT', body: 'changed' })).status, 405)
  assert.equal((await f.http(0, '/assets/main.mjs', { headers: { 'service-worker': 'script' } })).status, 403)
  assert.equal((await f.http(0, '/missing.js', { method: 'HEAD' })).bytes.length, 0)
})

test('app credentials, wrong Host, traversal, secrets and cross-app access are rejected', async t => {
  const f = await quickAppFixture(); t.after(f.dispose); await f.launch(); await f.launch()
  assert.notEqual(f.connections[0].origin, f.connections[1].origin)
  assert.equal((await f.http(0, '/index.html', { cookie: '' })).status, 401)
  assert.equal((await f.http(0, '/index.html', { cookie: f.connections[1].cookie })).status, 401)
  assert.equal((await f.http(0, '/index.html', { headers: { host: 'wrong.localhost' } })).status, 403)
  for (const path of ['/../data/member.json', '/%2e%2e/data/member.json', '/.git/config', '/.env', '/private.key', '/%252e%252e/data']) assert.equal((await f.http(0, path)).status, 403, path)
  await symlink(join(f.root, 'data'), join(f.root, 'site', 'escape'))
  assert.equal((await f.http(0, '/escape/member.json')).status, 403)
})

test('mounts use only approved workspace paths and disjoint non-reserved prefixes', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  for (const mounts of [[{ urlPrefix: '/__quickapp', workspacePath: 'data', read: true }], [{ urlPrefix: '/files', workspacePath: '../', read: true }], [{ urlPrefix: '/files', workspacePath: 'data', read: true }, { urlPrefix: '/files/nested', workspacePath: 'site', read: true }]]) {
    await assert.rejects(f.registry.upsert({ ...definition, mounts }, 0), { code: 'QUICK_APP_ACCESS_DENIED' })
  }
  const app = await f.registry.upsert({ ...definition, mounts: [{ urlPrefix: '/files', workspacePath: 'data', read: true }] }, 0)
  await f.service.launch(app.id, 'owner')
  assert.equal((await f.http(0, '/files/member.json')).text, '{"value":1}')
  assert.equal((await f.http(0, '/data/member.json')).status, 404)
})

test('optional file API separates permissions, create-only, stale write/delete, CSRF and Host data', async t => {
  const f = await quickAppFixture(); t.after(f.dispose); await f.launch()
  assert.equal((await f.http(0, '/__quickapp/files?path=data/member.json')).status, 403)
  await f.service.grant(f.app.id, 1, { read: ['data'], write: ['data'], delete: [] }); await f.launch()
  const index = 1; const origin = f.connections[index].origin
  const headers = { origin, 'content-type': 'text/plain; charset=utf-8' }
  const read = await f.http(index, '/__quickapp/files?path=data/member.json')
  const version = read.json().version
  assert.equal(read.json().content, '{"value":1}')
  assert.equal((await f.http(index, '/__quickapp/files?path=data/member.json', { method: 'PUT', headers, body: 'new' })).status, 428)
  assert.equal((await f.http(index, '/__quickapp/files?path=data/member.json', { method: 'PUT', headers: { ...headers, 'if-match': version }, body: 'new' })).status, 200)
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), 'new')
  assert.equal((await f.http(index, '/__quickapp/files?path=data/member.json', { method: 'PUT', headers: { ...headers, 'if-match': version }, body: 'stale' })).status, 412)
  assert.equal((await f.http(index, '/__quickapp/files?path=data/member.json', { method: 'PUT', headers: { ...headers, 'if-none-match': '*' }, body: 'overwrite' })).status, 412)
  assert.equal((await f.http(index, '/__quickapp/files?path=data/new.txt', { method: 'PUT', headers: { ...headers, 'if-none-match': '*' }, body: '' })).status, 200)
  assert.equal((await f.http(index, '/__quickapp/files?path=data/new.txt', { method: 'PUT', headers: { ...headers, origin: 'http://attacker.localhost', 'if-none-match': '*' }, body: 'attack' })).status, 403)
  assert.equal((await f.http(index, '/__quickapp/files?path=data/new.txt', { method: 'DELETE', headers: { ...headers, 'if-match': version } })).status, 403)
  assert.equal((await f.http(index, '/__quickapp/files?path=data/new.txt&hostId=peer')).status, 403)
  assert.equal((await f.http(index, '/__quickapp/files?path=site/index.html')).status, 403)
  await f.service.grant(f.app.id, 1, { read: ['data'], write: [], delete: ['data'] }); await f.launch()
  const latest = (await f.http(2, '/__quickapp/files?path=data/member.json')).json().version
  await writeFile(join(f.root, 'data/member.json'), 'external')
  assert.equal((await f.http(2, '/__quickapp/files?path=data/member.json', { method: 'DELETE', headers: { origin: f.connections[2].origin, 'if-match': latest } })).status, 412)
  const current = (await f.http(2, '/__quickapp/files?path=data/member.json')).json().version
  assert.equal((await f.http(2, '/__quickapp/files?path=data/member.json', { method: 'DELETE', headers: { origin: f.connections[2].origin, 'if-match': current } })).status, 200)
  assert.deepEqual((await readdir(join(f.root, 'data'))).filter(name => name.includes('quickapp-')), [])
})

test('bounded bodies and invalid UTF-8 fail without replacing existing content', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  await f.service.grant(f.app.id, 1, { read: ['data'], write: ['data'], delete: [] }); await f.launch()
  const headers = { origin: f.connections[0].origin, 'content-type': 'text/plain', 'if-none-match': '*' }
  assert.equal((await f.http(0, '/__quickapp/files?path=data/new.txt', { method: 'PUT', headers: { ...headers, 'content-length': String(4 * 1024 * 1024 + 1) } })).status, 413)
  assert.equal((await f.http(0, '/__quickapp/files?path=data/new.txt', { method: 'PUT', headers, body: Buffer.from([0xff]) })).status, 400)
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), '{"value":1}')
})

test('revoked queued mutation rechecks authority and cleans its queue', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const { launch } = await f.service.launches.create(f.app, 'owner', { read: ['data'], write: ['data'], delete: ['data'] })
  const version = (await f.service.files.read(launch, 'data/member.json')).version
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  // Hold the real per-file queue to test revocation specifically at execution time.
  const held = serializeWorkspaceMutation(join(f.root, 'data/member.json'), () => barrier)
  const pending = f.service.files.mutate(launch, 'PUT', 'data/member.json', 'must not save', version)
  await new Promise(resolve => setImmediate(resolve))
  await f.service.launches.revoke(launch.id); release(); await held
  await assert.rejects(pending, { code: 'QUICK_APP_REVOKED' })
  assert.equal(f.service.files.pending, 0)
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), '{"value":1}')
})

test('queued path revalidation rejects an ancestor replaced by a symlink', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const { launch } = await f.service.launches.create(f.app, 'owner', { read: [], write: ['data'], delete: [] })
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const held = serializeWorkspaceMutation(join(f.root, 'data/new.txt'), () => barrier)
  const pending = f.service.files.mutate(launch, 'PUT', 'data/new.txt', 'must not save', undefined, '*')
  await new Promise(resolve => setImmediate(resolve))
  await rm(join(f.root, 'data'), { recursive: true }); await symlink(join(f.root, 'site'), join(f.root, 'data')); release(); await held
  await assert.rejects(pending, { code: 'QUICK_APP_ACCESS_DENIED' })
  assert.equal(f.service.files.pending, 0)
  await assert.rejects(readFile(join(f.root, 'site/new.txt')), { code: 'ENOENT' })
})

test('expiry, revision invalidation, credentials, restart and disposal cannot revive a launch', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  let now = 1000
  const launches = new QuickAppLaunches(f.registry, () => now)
  const { launch, credential } = await launches.create(f.app, 'owner', { read: [], write: [], delete: [] })
  assert.throws(() => launches.authorize(launch, 'incorrect'), { code: 'QUICK_APP_UNAUTHENTICATED' })
  launches.authorize(launch, credential)
  now += 31 * 60 * 1000
  assert.throws(() => launches.authorize(launch, credential), { code: 'QUICK_APP_LAUNCH_EXPIRED' })
  assert.throws(() => new QuickAppLaunches(f.registry).authorize(launch, credential), { code: 'QUICK_APP_REVOKED' })
  const live = await f.launch()
  await f.registry.upsert({ ...f.app, title: 'Changed' }, 1)
  await assert.rejects(f.http(0, '/index.html', { headers: { 'if-none-match': 'anything' } }))
  assert.equal(f.service.launches.size, 0)
  assert.ok(f.connections[0].closed)
  await f.service.dispose()
  await assert.rejects(f.service.launch(f.app.id, 'owner'), { code: 'QUICK_APP_REVOKED' })
  assert.ok(live.launchId)
})

test('transport gate rejects same origin, shared cookie hosts, wrong Host, remote loopback and mixed content', () => {
  const lease = { origin: 'https://app.example.test', uiOrigin: 'https://ui.example.test', ownerHostId: 'local', remote: true, cookieName: 'app', activate: async () => ({ url: '' }), dispose: async () => undefined }
  validateQuickAppOrigin(lease, 'local', new Set())
  for (const patch of [{ origin: lease.uiOrigin }, { origin: `${lease.uiOrigin}:9443` }, { origin: 'http://app.example.test' }, { origin: 'https://127.0.0.1' }, { origin: 'https://[::ffff:7f00:1]' }, { origin: 'https://localhost.' }, { origin: 'https://app.localhost' }, { ownerHostId: 'peer' }, { origin: 'https://app.example.test/prefix' }]) assert.throws(() => validateQuickAppOrigin({ ...lease, ...patch }, 'local', new Set()))
  assert.throws(() => validateQuickAppOrigin(lease, 'local', new Set([lease.origin])))
  assert.throws(() => validateQuickAppOrigin(lease, 'local', new Set(['https://app.example.test:9443'])))
})

test('capability fixtures fail closed for legacy contexts and prefix-only current contexts', () => {
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.1-alpha.3']) {
    const ctx = { webServer: { register() {} } }
    const profile = createDshCapabilityRegistry(version, 'host', ctx).getProfile(ctx)
    assert.equal(profile.capabilities.get('quick-app.origin')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some(item => item.capability === 'quick-app.origin'))
  }
  const provider = { open() {} }
  assert.equal(createDshCapabilityRegistry('0.2.1-alpha.3', 'host', {}, { quickAppOrigins: provider }).getProfile({}).capabilities.get('quick-app.origin')?.status, 'ready')
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2']) assert.equal(createDshCapabilityRegistry(version, 'client', { slots: { register() {}, inject() {} } }).getProfile({}).capabilities.get('sidebar.footer-action')?.status, 'unavailable')
})

test('footer lifecycle waits for its native slot and cleans pending/active registration', () => {
  const events: string[] = []; let install!: () => () => void
  const dispose = registerQuickAppFooter({ inject: (name: string, callback: () => () => void) => { events.push(name); install = callback; return () => events.push('wait-disposed') }, register: (options: { name: string }) => { events.push(options.name); return () => events.push('entry-disposed') } }, () => null)
  const remove = install(); remove(); dispose()
  assert.deepEqual(events, ['sidebar.footer.action', 'sidebar.footer.action', 'entry-disposed', 'wait-disposed'])
})

test('client closes late launch results after closing its view, without conversation RPCs', async () => {
  let finish!: (value: unknown) => void
  const calls: string[] = []
  const client = new QuickAppsClient({ call: async (_channel, endpoint) => {
    calls.push(endpoint)
    if (endpoint.endsWith('/launch')) return new Promise(resolve => { finish = value => resolve({ ok: true, value }) })
    return { ok: true, value: {} }
  } })
  const pending = client.open('app'); await new Promise(resolve => setImmediate(resolve))
  await client.close(); finish({ kind: 'html', launchId: 'late', url: 'https://app.test', origin: 'https://app.test', expiresAt: 1 })
  assert.equal(await pending, undefined)
  assert.deepEqual(calls, ['quickApps/launch', 'quickApps/close'])
})

test('feature owns its RPC lifecycle, preserves unrelated settings, and requires trusted launch owner', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  let settings = { ...DEFAULT_CODINGNS_SETTINGS, quickApps: [...f.registry.list()], sessionTranslation: { ...DEFAULT_CODINGNS_SETTINGS.sessionTranslation, inputEnabled: false } }
  const rpc = new CodingNsRpcTable()
  const registry = new FeatureRegistry({ rpc, resolveManagedWorkspaceRoot: f.registry.workspaceRoot, settings: { get: () => settings, update: async patch => { settings = { ...settings, ...patch } } } })
  registry.register(createQuickAppsFeature()); await registry.start('quickApps')
  const invoke = (action: string, input: unknown, context?: unknown) => rpc.resolve(`quickApps/${action}`)!.handler(action, input, context)
  const owner = { peer: { id: 'owner' } }
  assert.equal((await invoke('list', {}, owner) as unknown[]).length, 1)
  await assert.rejects(async () => invoke('launch', { id: f.app.id, principal: 'spoofed' }), { code: 'QUICK_APP_PRINCIPAL_UNAVAILABLE' })
  await invoke('upsert', { app: { ...f.app, title: 'Feature edited' }, expectedRevision: 1 }, owner)
  assert.equal(settings.sessionTranslation.inputEnabled, false)
  await registry.disable('quickApps'); assert.equal(rpc.resolve('quickApps/list'), null)
})

test('settings RPC allows the Quick Apps module switch', async () => {
  let updated = false
  const handler = createCodingNsSettingsRpcHandler({ writable: true, describe: () => [{ ns: 'codingns', value: DEFAULT_CODINGNS_SETTINGS, revision: 1 }], mutate: async () => { updated = true } })
  await handler('set', { ops: [{ op: 'set', path: ['modules', 'quickApps'], value: true }] })
  assert.ok(updated)
})

test('disconnect revokes its launch and origin reservations survive close', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const controller = new AbortController()
  await f.service.launch(f.app.id, 'owner', controller.signal)
  const origin = f.connections[0].origin
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.service.launches.size, 0)
  assert.ok(f.connections[0].closed)
  assert.ok((f.service as unknown as { origins: Set<string> }).origins.has(origin))
})

test('a close immediately after open prevents the launch request', async () => {
  let calls = 0
  const client = new QuickAppsClient({ call: async () => { calls++; return { ok: true, value: {} } } })
  const opening = client.open('app'); await client.close()
  assert.equal(await opening, undefined)
  assert.equal(calls, 0)
})

test('a retargeted workspace symlink cannot move an existing launch to another root', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const alias = join(f.root, 'workspace-link')
  await symlink(f.root, alias)
  const registry = new QuickAppRegistry(f.registry.storage, () => alias)
  const launches = new QuickAppLaunches(registry)
  const { launch } = await launches.create(f.app, 'owner', { read: ['data'], write: [], delete: [] })
  await launches.validateWorkspace(launch)
  await unlink(alias); await symlink(join(f.root, 'site'), alias)
  await assert.rejects(launches.validateWorkspace(launch), { code: 'QUICK_APP_REVOKED' })
})

test('Quick Apps refuses a terminal-only workspace resolver', async () => {
  const registry = new FeatureRegistry({ rpc: new CodingNsRpcTable(), resolveWorkspaceRoot: () => '/stale-terminal-root', settings: { get: () => DEFAULT_CODINGNS_SETTINGS } })
  registry.register(createQuickAppsFeature())
  await assert.rejects(registry.start('quickApps'))
  assert.equal(registry.getState('quickApps'), 'failed')
})

test('application code changes invalidate remembered and active file grants', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  await f.service.grant(f.app.id, 1, { read: ['data'], write: ['data'], delete: [] })
  await writeFile(join(f.root, 'site/assets/main.mjs'), '/* changed before launch */')
  await f.launch()
  assert.equal((await f.http(0, '/__quickapp/files?path=data/member.json')).status, 403)
  await f.service.grant(f.app.id, 1, { read: ['data'], write: ['data'], delete: [] }); await f.launch()
  assert.equal((await f.http(1, '/__quickapp/files?path=data/member.json')).status, 200)
  await writeFile(join(f.root, 'site/assets/dynamic.mjs'), '/* changed while open */')
  await assert.rejects(f.http(1, '/__quickapp/files?path=data/member.json'))
  assert.equal(f.service.launches.size, 0)
  await f.launch()
  assert.equal((await f.http(2, '/__quickapp/files?path=data/member.json')).status, 403)
})

test('legacy preview and independent Quick Apps services share physical-file mutation ordering', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const second = new QuickAppService(f.registry); t.after(() => second.dispose())
  const permissions = { read: ['data'], write: ['data'], delete: [] }
  const a = (await f.service.launches.create(f.app, 'owner', permissions)).launch
  const b = (await second.launches.create(f.app, 'owner', permissions)).launch
  const version = (await f.service.files.read(a, 'data/member.json')).version
  const saves = await Promise.allSettled([f.service.files.mutate(a, 'PUT', 'data/member.json', 'first', version), second.files.mutate(b, 'PUT', 'data/member.json', 'second', version)])
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((saves.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'QUICK_APP_CONFLICT')
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const held = serializeWorkspaceMutation(join(f.root, 'data/member.json'), () => barrier)
  let completed = false
  const legacy = runHtmlWorkspaceFileOperation(f.root, { documentPath: 'site/index.html', scopes: ['../data'], path: '../data/member.json', operation: 'write', content: 'legacy preserved' }).then(() => { completed = true })
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(completed, false)
  release(); await held; await legacy
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), 'legacy preserved')
  assert.equal(f.service.files.pending, 0); assert.equal(second.files.pending, 0)
})
