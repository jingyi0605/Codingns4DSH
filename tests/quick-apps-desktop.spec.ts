import assert from 'node:assert/strict'
import test from 'node:test'
import { validateQuickAppOrigin } from '../src/dsh-capabilities/host/quick-app-origin-adapter.js'
import { QuickAppsClient } from '../src/client/quick-apps/client.js'
import { QuickAppRemoteOwner, QuickAppRemoteController } from '../src/host/modules/quick-apps/remote.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { quickAppProxyFixture } from './quick-apps-proxy-fixture.js'

test('Desktop PeerHost previews relay through the controlling listener and mutate only the owner', async t => {
  const local = await quickAppProxyFixture('0.2.0-rc.2'); t.after(local.dispose)
  const target = await quickAppProxyFixture('0.2.0-rc.2'); t.after(target.dispose)
  const owner = new QuickAppRemoteOwner(target.registry.workspaceRoot, target.provider); t.after(() => owner.dispose())
  const gateway = { call: async (hostId: string, workspaceId: string, action: string, payload: Record<string, unknown>) => {
    assert.equal(hostId, 'peer-a')
    assert.equal(workspaceId, 'workspace-a')
    return owner.handle(action, payload, 'authenticated-controlling-host')
  } }
  const remote = new QuickAppRemoteController(() => gateway, undefined, local.provider); t.after(() => remote.dispose())
  const app = { ...target.registry.get(target.app.id), hostId: 'peer-a', workspaceId: createVirtualWorkspaceId('peer-a', 'workspace-a') }
  const launch = await remote.launch(app, 'browser-owner', 'dsh-app://app') as any
  assert.equal(launch.origin, local.hostOrigin)
  assert.notEqual(launch.origin, target.hostOrigin)
  const entry = await fetch(launch.url)
  assert.equal(entry.status, 200)
  assert.match(entry.headers.get('content-security-policy')!, /frame-ancestors dsh-app:\/\/app;/u)
  assert.match(entry.headers.get('content-security-policy')!, /sandbox allow-scripts allow-forms allow-downloads;/u)
  const fileUrl = local.hostOrigin + launch.basePath + '__quickapp/files?path=data/member.json'
  const before = await (await fetch(fileUrl)).json()
  const headers = { origin: 'null', 'content-type': 'text/plain', 'if-match': before.version }
  assert.equal((await fetch(fileUrl, { method: 'PUT', headers, body: 'owning Host only' })).status, 200)
  assert.equal((await fetch(fileUrl, { method: 'PUT', headers, body: 'stale' })).status, 412)
  assert.equal((await (await fetch(fileUrl)).json()).content, 'owning Host only')
  const localLaunch = await local.launch('dsh-app://app')
  const localFileUrl = local.hostOrigin + localLaunch.basePath + '__quickapp/files?path=data/member.json'
  assert.equal((await (await fetch(localFileUrl)).json()).content, '{"value":1}')
  await remote.close(launch.launchId, 'browser-owner')
  assert.equal((await fetch(launch.url)).status, 404)
})

test('client preserves the exact Desktop origin even when URL.origin is opaque', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location')
  t.after(() => { if (original) Object.defineProperty(globalThis, 'location', original); else Reflect.deleteProperty(globalThis, 'location') })
  const calls: { endpoint: string; payload: unknown }[] = []
  const client = new QuickAppsClient({ call: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload }); return { ok: true, value: [] }
  } })
  for (const origin of ['dsh-app://app', 'http://127.0.0.1:12345', 'https://host.example.test']) {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(origin) })
    await client.call('list')
    assert.deepEqual(calls.at(-1)?.payload, { uiOrigin: origin })
    await client.call('launch', { id: 'shortcut' })
    assert.deepEqual(calls.at(-1)?.payload, { id: 'shortcut', uiOrigin: origin })
  }
  await client.call('browse', { workspaceId: 'workspace-a' })
  assert.deepEqual(calls.at(-1)?.payload, { workspaceId: 'workspace-a' })
})

test('rc.2 Desktop previews load through the existing listener and keep sandboxing and revocation', async t => {
  const f = await quickAppProxyFixture('0.2.0-rc.2'); t.after(f.dispose)
  const uiOrigin = 'dsh-app://app'
  assert.equal(f.provider.available(uiOrigin), true)
  for (const invalid of ['null', 'file://', 'dsh-app://other', 'dsh-app://app/', 'dsh-app://app:1234']) {
    assert.equal(f.provider.available(invalid), false, invalid)
  }
  const launch = await f.launch(uiOrigin)
  assert.equal(launch.origin, f.hostOrigin)
  assert.equal(launch.isolation, 'sandbox-proxy')
  const response = await fetch(launch.url)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors dsh-app:\/\/app;/u)
  assert.match(response.headers.get('content-security-policy')!, /sandbox allow-scripts allow-forms allow-downloads;/u)
  assert.doesNotMatch(response.headers.get('content-security-policy')!, /allow-same-origin/u)
  const fileUrl = f.hostOrigin + launch.basePath + '__quickapp/files?path=data/member.json'
  const before = await (await fetch(fileUrl)).json()
  const headers = { origin: 'null', 'content-type': 'text/plain', 'if-match': before.version }
  assert.equal((await fetch(fileUrl, { method: 'PUT', headers, body: 'Desktop rc.2' })).status, 200)
  assert.equal((await fetch(fileUrl, { method: 'PUT', headers, body: 'stale' })).status, 412)
  await f.service.invalidate(f.app.id)
  assert.equal((await fetch(launch.url)).status, 404)
  assert.equal(f.provider.available(uiOrigin), true)
})

test('Desktop origin validation refuses non-loopback preview addresses', () => {
  const lease = { origin: 'http://127.0.0.1:12345', uiOrigin: 'dsh-app://app', ownerHostId: 'local', remote: false,
    isolation: 'sandbox-proxy' as const, cookieName: 'quickapp-proxy', basePath: '/__codingns/quick-apps/' + 'a'.repeat(43) + '/',
    activate: async () => ({ url: '' }), dispose: async () => {} }
  validateQuickAppOrigin(lease, 'local', new Set())
  assert.throws(() => validateQuickAppOrigin({ ...lease, remote: true }, 'local', new Set()))
  for (const origin of ['http://example.test:12345', 'http://0.0.0.0:12345', 'https://example.test']) {
    assert.throws(() => validateQuickAppOrigin({ ...lease, origin }, 'local', new Set()))
  }
})
