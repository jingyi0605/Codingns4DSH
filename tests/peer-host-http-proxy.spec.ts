import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'
import { PeerHostHttpProxyService } from '../data/build/dist/host/modules/peer-host/host-api-proxy-service.js'
import { PeerHostSessionError, PeerHostSessionService } from '../data/build/dist/host/modules/peer-host/peer-host-session.js'

const scopeHeaders = {
  'x-codingns-host-id': 'host-local',
  'x-codingns-target-host-id': 'peer-1',
  'x-codingns-workspace-id': 'workspace-1',
  'x-codingns-session-id': 'session-1',
  'x-codingns-scope-generation': '3',
}

async function setup(fetchImpl: typeof fetch, onRecover: () => void = () => undefined) {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await store.updateHandshake('peer-1', { status: 'ready', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:first', lastCheckedAt: 100, lastErrorCode: null })
  const sessions = {
    getAccessToken: async (peerHostId: string) => { assert.equal(peerHostId, 'peer-1'); return 'access-secret' },
    recoverAccessToken: async (peerHostId: string) => {
      assert.equal(peerHostId, 'peer-1')
      onRecover()
      throw new PeerHostSessionError('PEER_HOST_SESSION_REQUIRED', '目标 Host 需要登录')
    },
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

test('目标 Host 票据被拒且恢复失败时返回登录态失效', async () => {
  let recovered = 0
  const service = await setup(async () => new Response(JSON.stringify({ error: 'expired' }), { status: 401, headers: { 'content-type': 'application/json' } }), () => { recovered += 1 })
  const response = await service.handle('peer-1', new Request('http://current.test/api/workspaces', { headers: scopeHeaders }))
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'PEER_HOST_SESSION_REQUIRED')
  assert.equal(recovered, 1)
})

// 认证回归使用长期支持的 CLI 路由，避免依赖特定业务接口的白名单扩展。
const AUTH_TEST_RPC_PATH = '/api/codingns/cli/session/adapter-map'

/** 使用真实会话协调器，验证认证恢复不会丢失凭据或把其它请求的状态覆盖掉。 */
async function authenticatedProxy(fetchImpl: typeof fetch) {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 1_000, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await store.updateStatus('peer-1', 'ready', null)
  await credentials.write('peer-1', { accessToken: 'old-access', refreshToken: 'refresh-secret', expiresAt: 121_000, username: 'alice', password: 'password-secret' })
  const sessions = new PeerHostSessionService(store, credentials, { fetchImpl, now: () => 1_000 })
  const proxy = new PeerHostHttpProxyService(store, sessions, { fetchImpl })
  const request = () => proxy.handle('peer-1', new Request(`http://current.test${AUTH_TEST_RPC_PATH}`, {
    method: 'POST', headers: { ...scopeHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'cli/session/adapter-map', payload: { workspaceId: 'workspace-1' } }),
  }))
  return { store, credentials, request }
}

test('业务接口 401 但同一票据可以读取 Host 状态时报告接口拒绝，保持登录态', async () => {
  const paths: string[] = []
  const target = await authenticatedProxy(async (input, init) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer old-access')
    if (path === '/api/codingns/host/status') {
      assert.equal(JSON.parse(String(init?.body)).method, 'host/status')
      return Response.json({ result: { ok: true, value: {} } })
    }
    return new Response('旧版目标只接受浏览器 Cookie', { status: 401 })
  })
  const response = await target.request()
  assert.equal(response.status, 403)
  const error = (await response.json()).error
  assert.equal(error.code, 'PEER_HOST_PROXY_ACCESS_DENIED')
  assert.match(error.message, /登录有效/u)
  assert.equal((await target.store.get('peer-1'))?.status, 'ready')
  assert.equal((await target.credentials.read('peer-1'))?.accessToken, 'old-access')
  assert.deepEqual(paths, [AUTH_TEST_RPC_PATH, '/api/codingns/host/status'])
})

test('过期票据恢复后重放原业务请求一次，返回成功结果而非登录失效', async () => {
  const calls: { path: string; body: string; token: string | null }[] = []
  const target = await authenticatedProxy(async (input, init) => {
    const path = new URL(String(input)).pathname
    const token = new Headers(init?.headers).get('authorization')
    calls.push({ path, body: String(init?.body), token })
    if (path === '/api/auth/refresh') return Response.json({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 120 })
    if (token === 'Bearer old-access') return new Response('expired', { status: 401 })
    return Response.json({ result: { ok: true, value: { profiles: [] } } })
  })
  const response = await target.request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-codingns-scope-generation'), '3')
  assert.deepEqual(await response.json(), { result: { ok: true, value: { profiles: [] } } })
  assert.deepEqual(calls.map(call => call.path), [AUTH_TEST_RPC_PATH, '/api/codingns/host/status', '/api/auth/refresh', AUTH_TEST_RPC_PATH])
  assert.equal(calls[0]?.body, calls[3]?.body)
  assert.equal(calls[3]?.token, 'Bearer new-access')
  assert.equal((await target.store.get('peer-1'))?.status, 'ready')
  assert.equal((await target.credentials.read('peer-1'))?.password, 'password-secret')
})

test('刷新被拒后静默重登成功，原请求仍正常完成', async () => {
  let logins = 0
  const target = await authenticatedProxy(async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/auth/login') {
      logins += 1
      assert.deepEqual(JSON.parse(String(init?.body)), { username: 'alice', password: 'password-secret' })
      return Response.json({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 120 })
    }
    return new Headers(init?.headers).get('authorization') === 'Bearer new-access'
      ? Response.json({ result: { ok: true, value: {} } })
      : new Response('expired', { status: 401 })
  })
  assert.equal((await target.request()).status, 200)
  assert.equal(logins, 1)
  assert.equal((await target.store.get('peer-1'))?.status, 'ready')
})

test('认证检查或续期失败时保留凭据，网络和限流不报登录失效', async (t) => {
  for (const failedPath of ['/api/codingns/host/status', '/api/auth/refresh']) {
    for (const status of [0, 429, 503]) {
      await t.test(`${failedPath}: ${status}`, async () => {
        const target = await authenticatedProxy(async input => {
          const path = new URL(String(input)).pathname
          assert.notEqual(path, '/api/auth/login')
          if (path !== failedPath) return new Response('expired', { status: 401 })
          if (status === 0) throw new Error('network down')
          return new Response('unavailable', { status })
        })
        const response = await target.request()
        assert.equal(response.status, 502)
        assert.equal((await response.json()).error.code, 'PEER_HOST_PROXY_UNREACHABLE')
        assert.equal((await target.store.get('peer-1'))?.status, 'ready')
        assert.equal((await target.credentials.read('peer-1'))?.password, 'password-secret')
      })
    }
  }
})

test('登录检查返回普通网页时不能据 HTTP 200 认定登录有效', async () => {
  const target = await authenticatedProxy(async input => new URL(String(input)).pathname === '/api/codingns/host/status'
    ? new Response('<html>登录页</html>', { status: 200 })
    : new Response('expired', { status: 401 }))
  const response = await target.request()
  assert.equal((await response.json()).error.code, 'PEER_HOST_RESPONSE_INVALID')
  assert.equal((await target.credentials.read('peer-1'))?.accessToken, 'old-access')
})

test('刷新后请求仍为 401 时最多重试一次；新票据有效则报告接口拒绝', async (t) => {
  for (const authenticated of [true, false]) {
    await t.test(String(authenticated), async () => {
      let requests = 0
      let refreshes = 0
      const target = await authenticatedProxy(async (input, init) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/auth/refresh') {
          refreshes += 1
          return Response.json({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 120 })
        }
        if (path === AUTH_TEST_RPC_PATH) requests += 1
        if (authenticated && path === '/api/codingns/host/status' && new Headers(init?.headers).get('authorization') === 'Bearer new-access') {
          return Response.json({ result: { ok: true, value: {} } })
        }
        return new Response('rejected', { status: 401 })
      })
      const response = await target.request()
      assert.equal((await response.json()).error.code, authenticated ? 'PEER_HOST_PROXY_ACCESS_DENIED' : 'PEER_HOST_SESSION_REQUIRED')
      assert.equal(requests, 2)
      assert.equal(refreshes, 1)
      assert.equal((await target.credentials.read('peer-1'))?.password, 'password-secret')
    })
  }
})

test('真正拒绝刷新票据与账号时才要求重新登录', async () => {
  const paths: string[] = []
  const target = await authenticatedProxy(async input => {
    paths.push(new URL(String(input)).pathname)
    return new Response('rejected', { status: 401 })
  })
  const response = await target.request()
  assert.equal((await response.json()).error.code, 'PEER_HOST_SESSION_REQUIRED')
  assert.equal((await target.store.get('peer-1'))?.status, 'session_required')
  assert.equal(await target.credentials.read('peer-1'), null)
  assert.equal(paths.filter(path => path === AUTH_TEST_RPC_PATH).length, 1)
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
