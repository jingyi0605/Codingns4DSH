import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'
import { PeerHostHttpProxyService } from '../data/build/dist/host/modules/peer-host/host-api-proxy-service.js'
import { PeerHostSessionService } from '../data/build/dist/host/modules/peer-host/peer-host-session.js'

const scopeHeaders = {
  'x-codingns-host-id': 'host-local',
  'x-codingns-target-host-id': 'peer-1',
  'x-codingns-workspace-id': 'workspace-1',
  'x-codingns-session-id': 'session-1',
  'x-codingns-scope-generation': '3',
}

async function setup(fetchImpl: typeof fetch, onInvalidate: () => void = () => undefined) {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await store.updateHandshake('peer-1', { status: 'ready', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:first', lastCheckedAt: 100, lastErrorCode: null })
  const sessions = {
    getAccessToken: async (peerHostId: string) => { assert.equal(peerHostId, 'peer-1'); return 'access-secret' },
    invalidate: async (peerHostId: string) => { assert.equal(peerHostId, 'peer-1'); onInvalidate() },
  }
  return new PeerHostHttpProxyService(store, sessions as never, { fetchImpl })
}

test('合法 PeerHost HTTP 请求只能转发到登记目标并注入 Host 侧 Bearer token', async () => {
  let received: { url: string; authorization: string | null } | undefined
  const service = await setup(async (input, init) => {
    received = { url: String(input), authorization: new Headers(init?.headers).get('authorization') }
    return new Response(JSON.stringify({ workspaces: [] }), { status: 200, headers: { 'content-type': 'application/json', authorization: 'remote-secret' } })
  })
  const response = await service.handle('peer-1', new Request('http://current.test/api/workspaces?workspaceId=workspace-1', { headers: scopeHeaders }))
  assert.equal(response.status, 200)
  assert.deepEqual(received, { url: 'http://127.0.0.1:13080/api/workspaces?workspaceId=workspace-1', authorization: 'Bearer access-secret' })
  assert.equal(response.headers.get('authorization'), null)
  assert.equal(response.headers.get('x-codingns-scope-generation'), '3')
})

test('未知路径、方法、查询参数和错误作用域均被拒绝', async () => {
  let called = 0
  const service = await setup(async () => { called += 1; return Response.json({}) })
  const unknown = await service.handle('peer-1', new Request('http://current.test/api/admin/users', { headers: scopeHeaders }))
  assert.equal(unknown.status, 400)
  assert.equal((await unknown.json()).error.code, 'PEER_HOST_PROXY_PATH_NOT_ALLOWED')
  const method = await service.handle('peer-1', new Request('http://current.test/api/workspaces', { method: 'DELETE', headers: scopeHeaders }))
  assert.equal(method.status, 400)
  const query = await service.handle('peer-1', new Request('http://current.test/api/workspaces?baseUrl=https://evil.test', { headers: scopeHeaders }))
  assert.equal(query.status, 400)
  const scope = await service.handle('peer-1', new Request('http://current.test/api/workspaces', { headers: { ...scopeHeaders, 'x-codingns-target-host-id': 'peer-2' } }))
  assert.equal(scope.status, 400)
  assert.equal(called, 0)
})

test('代理不接受任意目标 URL，也不会把上游失败伪装成空列表', async () => {
  const service = await setup(async () => { throw new Error('network down') })
  const response = await service.handle('peer-1', new Request('http://evil.test/api/workspaces', { headers: scopeHeaders }))
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, 'PEER_HOST_PROXY_UNREACHABLE')
})

test('目标 Host 返回 401 时只清理该 PeerHost 登录态', async () => {
  let invalidated = 0
  const service = await setup(async () => new Response(JSON.stringify({ error: 'expired' }), { status: 401, headers: { 'content-type': 'application/json' } }), () => { invalidated += 1 })
  const response = await service.handle('peer-1', new Request('http://current.test/api/workspaces', { headers: scopeHeaders }))
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'PEER_HOST_SESSION_REQUIRED')
  assert.equal(invalidated, 1)
})

test('缺少目标凭据时按登录态失效返回，不伪装成目标代理不可达', async () => {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await store.updateHandshake('peer-1', { status: 'ready', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:first', lastCheckedAt: 100, lastErrorCode: null })
  const sessions = new PeerHostSessionService(store, credentials, { fetchImpl: async () => Response.json({}) })
  const service = new PeerHostHttpProxyService(store, sessions, { fetchImpl: async () => { throw new Error('目标请求不应被发出') } })
  const response = await service.handle('peer-1', new Request('http://current.test/api/codingns/host/status', { method: 'POST', headers: scopeHeaders }))
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'PEER_HOST_SESSION_REQUIRED')
  assert.equal((await store.get('peer-1'))?.status, 'session_required')
})
