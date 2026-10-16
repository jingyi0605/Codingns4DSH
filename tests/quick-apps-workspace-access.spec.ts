import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { quickAppFixture, definition } from './quick-apps-fixture.js'
import { QuickAppRegistry, parseDefinition } from '../src/host/modules/quick-apps/registry.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { serializeWorkspaceMutation } from '../src/host/workspace-file-mutations.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'

test('saved workspace trust allows HTTP read/create/update/delete without per-path grants or code reapproval', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const app = await f.registry.upsert({ ...f.app, fileAccess: 'workspace' }, f.app.revision)
  const reloaded = CodingNsSettingsSchema(JSON.parse(JSON.stringify({ quickApps: [app] })))
  assert.equal(reloaded.quickApps[0]?.fileAccess, 'workspace')
  assert.equal(new QuickAppRegistry(f.registry.storage, f.registry.workspaceRoot).get(app.id).fileAccess, 'workspace')
  await f.launch()
  const origin = f.connections[0]!.origin
  const target = '/__quickapp/files?path=data/member.json'
  const initial = await f.http(0, target); assert.equal(initial.status, 200)
  await writeFile(join(f.root, 'site/assets/main.mjs'), '/* ordinary app update */')
  const headers = { origin, 'content-type': 'text/plain', 'if-match': initial.json().version }
  assert.equal((await f.http(0, target, { method: 'PUT', headers, body: 'updated' })).status, 200)
  assert.equal((await f.http(0, target, { method: 'PUT', headers, body: 'stale' })).status, 412)
  assert.equal((await f.http(0, target, { method: 'DELETE', headers })).status, 412)
  assert.equal((await f.http(0, target, { method: 'DELETE', headers: { origin } })).status, 428)
  const fresh = await f.http(0, target)
  assert.equal((await f.http(0, target, { method: 'DELETE', headers: { origin, 'if-match': fresh.json().version } })).status, 200)
  await assert.rejects(readFile(join(f.root, 'data/member.json')), { code: 'ENOENT' })
  const create = { method: 'PUT', headers: { origin, 'content-type': 'text/plain', 'if-none-match': '*' }, body: 'created' }
  const created = await f.http(0, '/__quickapp/files?path=root-note.txt', create)
  assert.equal(created.status, 200)
  assert.equal(created.json().version, (await f.http(0, '/__quickapp/files?path=root-note.txt')).json().version)
  assert.equal((await f.http(0, '/__quickapp/files?path=root-note.txt', create)).status, 412)
  assert.equal(await readFile(join(f.root, 'root-note.txt'), 'utf8'), 'created')
  assert.equal((await f.http(0, '/root-note.txt')).status, 404, 'static URLs still map to the application folder')
  await assert.rejects(f.service.grant(app.id, app.revision, { read: [], write: [], delete: [] }), { code: 'QUICK_APP_ACCESS_DENIED' })
})

test('workspace trust preserves containment, credential and queued-revocation checks', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  const other = await quickAppFixture(); t.after(other.dispose)
  await f.registry.upsert({ ...f.app, fileAccess: 'workspace' }, f.app.revision)
  const opened = await f.launch()
  await symlink(other.root, join(f.root, 'other-workspace'))
  await writeFile(join(f.root, '.env'), 'fixture-secret')
  for (const path of ['../outside.txt', '.env', 'private.key', 'other-workspace/site/index.html', '/etc/passwd', '%2e%2e/file']) {
    assert.equal((await f.http(0, `/__quickapp/files?path=${encodeURIComponent(path)}`)).status, 403, path)
  }
  assert.equal((await f.http(0, '/__quickapp/files?path=data/member.json&workspaceId=other')).status, 403)
  assert.equal((await f.http(0, '/__quickapp/files?path=data/member.json', { cookie: 'quickapp=wrong' })).status, 401)
  assert.equal((await f.http(0, '/index.html', { headers: { host: 'wrong.test' } })).status, 403)
  const launch = f.service.launches.requireOwner(opened.launchId, 'browser-owner')
  const before = await f.service.files.read(launch, 'data/member.json')
  let release!: () => void
  const held = serializeWorkspaceMutation(join(f.root, 'data/member.json'), () => new Promise<void>(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  const pending = f.service.files.mutate(launch, 'PUT', 'data/member.json', 'must not save', before.version)
  const rejected = assert.rejects(pending, { code: 'QUICK_APP_REVOKED' })
  for (let i = 0; i < 100 && !f.service.files.pending; i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.equal(f.service.files.pending, 1)
  await f.service.invalidate(f.app.id)
  release(); await held; await rejected
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), '{"value":1}')
})

test('legacy shortcuts remain unchanged until saved; authenticated revoke clears persisted trust even with a missing entry', async t => {
  const f = await quickAppFixture(); t.after(f.dispose)
  let settings = { ...DEFAULT_CODINGNS_SETTINGS, quickApps: [f.app] }
  const rpc = new CodingNsRpcTable()
  const feature = new FeatureRegistry({ rpc, resolveManagedWorkspaceRoot: f.registry.workspaceRoot,
    quickAppPeerGateway: { call: async () => ({ availability: 'available' }) },
    settings: { get: () => settings, update: async patch => { settings = { ...settings, ...patch } } } })
  feature.register(createQuickAppsFeature()); await feature.start('quickApps'); t.after(() => feature.disable('quickApps'))
  const invoke = (action: string, payload: unknown, context: unknown = { peer: { id: 'owner' } }): Promise<any> =>
    rpc.resolve(`quickApps/${action}`)!.handler(action, payload, context) as Promise<any>
  assert.equal((await invoke('list', {}))[0].fileAccess, undefined)
  await assert.rejects(invoke('upsert', { app: { ...definition, hostId: 'old-peer', workspaceId: createVirtualWorkspaceId('old-peer', 'workspace-a'), fileAccess: 'workspace' }, expectedRevision: 0 }),
    { code: 'QUICK_APP_WORKSPACE_ACCESS_UNAVAILABLE' })
  await assert.rejects(invoke('upsert', { app: { ...f.app, fileAccess: 'workspace' }, expectedRevision: 1 }, {}), { code: 'QUICK_APP_PRINCIPAL_UNAVAILABLE' })
  const trusted = await invoke('upsert', { app: { ...f.app, fileAccess: 'workspace' }, expectedRevision: 1 })
  assert.equal(trusted.fileAccess, 'workspace')
  await unlink(join(f.root, f.app.entryPath))
  const revoked = await invoke('revoke', { id: f.app.id })
  assert.equal(revoked.app.revision, trusted.revision + 1)
  assert.equal(settings.quickApps[0]?.fileAccess, undefined)
  await feature.disable('quickApps'); await feature.start('quickApps')
  assert.equal((await invoke('list', {}))[0].fileAccess, undefined)
  assert.equal(parseDefinition({ ...definition, kind: 'text', fileAccess: 'workspace' }).fileAccess, undefined)
  assert.throws(() => parseDefinition({ ...definition, fileAccess: 'all-hosts' }), { code: 'QUICK_APP_ACCESS_DENIED' })
})
