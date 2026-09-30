import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'
import { PeerHostHandshakeService } from '../data/build/dist/host/modules/peer-host/peer-host-handshake.js'

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    productId: 'CodingNS',
    pluginId: '@jingyi0605/codingns4dsh',
    pluginVersion: '0.1.2',
    dshVersion: '0.1.6-alpha.2',
    apiCompatibility: 'peer-host-v1',
    fingerprint: 'sha256:first',
    capabilities: ['workspace.summary'],
    ...overrides,
  }
}

async function setup(fetchImpl: typeof fetch = async () => response(payload())) {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  const service = new PeerHostHandshakeService(store, credentials, {
    productId: 'CodingNS',
    pluginId: '@jingyi0605/codingns4dsh',
    pluginVersion: '0.1.2',
    apiCompatibility: 'peer-host-v1',
    isDshVersionSupported: (version) => version === '0.1.6-alpha.2',
    fetchImpl,
    now: () => 200,
  })
  return { store, credentials, service }
}

test('握手成功进入 ready 并保存脱敏身份摘要', async () => {
  const { service, store } = await setup(async () => response(payload({ hostname: 'dev-host', configProfile: 'office' })))
  const record = await service.check('peer-1')
  assert.equal(record.status, 'ready')
  assert.equal(record.fingerprint, 'sha256:first')
  assert.equal(record.lastCheckedAt, 200)
  assert.equal(record.hostname, 'dev-host')
  assert.equal(record.configProfile, 'office')
  assert.equal((await store.get('peer-1'))?.route.kind, 'lan')
})

test('插件缺失、版本不兼容和不可达分别进入可解释状态', async () => {
  const missing = await setup(async () => response(payload({ pluginId: null, pluginVersion: null })))
  assert.equal((await missing.service.check('peer-1')).status, 'plugin_missing')

  const mismatch = await setup(async () => response(payload({ dshVersion: '0.1.7-rc.2' })))
  assert.equal((await mismatch.service.check('peer-1')).status, 'version_mismatch')

  const unreachable = await setup(async () => { throw new Error('network down') })
  assert.equal((await unreachable.service.check('peer-1')).status, 'unreachable')
})

test('fingerprint 改变进入 identity_changed 并清理目标凭据', async () => {
  const first = await setup()
  await first.service.check('peer-1')
  await first.credentials.write('peer-1', { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 300 })
  const changed = new PeerHostHandshakeService(first.store, first.credentials, {
    productId: 'CodingNS',
    pluginId: '@jingyi0605/codingns4dsh',
    pluginVersion: '0.1.2',
    apiCompatibility: 'peer-host-v1',
    isDshVersionSupported: () => true,
    fetchImpl: async () => response(payload({ fingerprint: 'sha256:changed' })),
    now: () => 400,
  })
  assert.equal((await changed.check('peer-1')).status, 'identity_changed')
  assert.equal(await first.credentials.read('peer-1'), null)
})

test('Relay 路由在 Host-to-Host 能力未验证前保持不可用', async () => {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '中转机', route: { kind: 'relay', deviceId: 'device-1', relayEntryId: 'entry-1', transportVersion: 'v1' } })
  const service = new PeerHostHandshakeService(store, credentials, {
    productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', apiCompatibility: 'peer-host-v1', isDshVersionSupported: () => true,
    now: () => 200,
  })
  const record = await service.check('peer-1')
  assert.equal(record.status, 'unreachable')
  assert.equal(record.lastErrorCode, 'PEER_HOST_RELAY_UNAVAILABLE')
})
