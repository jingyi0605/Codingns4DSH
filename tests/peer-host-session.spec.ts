import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'
import { PeerHostHandshakeService } from '../data/build/dist/host/modules/peer-host/peer-host-handshake.js'
import { PeerHostSessionService } from '../data/build/dist/host/modules/peer-host/peer-host-session.js'

function response(value: unknown, status = 200): Response {
  return new Response(value === null ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

async function setup(fetchImpl: typeof fetch) {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 1_000, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  const handshake = new PeerHostHandshakeService(store, credentials, {
    productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', apiCompatibility: 'peer-host-v1', isDshVersionSupported: () => true,
    fetchImpl: async () => response({ productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:first', capabilities: [] }),
    now: () => 1_000,
  })
  await handshake.check('peer-1')
  return { store, credentials, service: new PeerHostSessionService(store, credentials, { fetchImpl, now: () => 1_000, refreshSkewMs: 30_000 }) }
}

test('目标登录 token 连同账号写入 Host 凭据存储，Client 仅得到脱敏视图', async () => {
  const calls: Array<{ path: string; body: string | null; authorization: string | null }> = []
  const target = await setup(async (input, init) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, body: typeof init?.body === 'string' ? init.body : null, authorization: new Headers(init?.headers).get('authorization') })
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 120 })
  })
  const view = await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  assert.deepEqual(view, { peerHostId: 'peer-1', status: 'logged_in', expiresAt: 121_000 })
  // Client 视图永远不含 token，也不含账号密码。
  assert.equal(JSON.stringify(view).includes('access-secret'), false)
  assert.equal(JSON.stringify(view).includes('password-secret'), false)
  // 账号密码随凭据一起加密保存：这是"编辑里保存一次，之后自动连接"的前提。
  assert.deepEqual(await target.credentials.read('peer-1'), {
    accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 121_000,
    username: 'alice', password: 'password-secret',
  })
  assert.deepEqual(calls[0], { path: '/api/auth/login', body: JSON.stringify({ username: 'alice', password: 'password-secret' }), authorization: null })
})

test('access token 临近过期时由 Host 自动 refresh', async () => {
  let refreshCalls = 0
  const target = await setup(async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/auth/refresh') {
      refreshCalls += 1
      return response({ accessToken: 'access-refreshed', refreshToken: 'refresh-refreshed', expiresIn: 120 })
    }
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 1 })
  })
  await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  assert.equal(await target.service.getAccessToken('peer-1'), 'access-refreshed')
  assert.equal(refreshCalls, 1)
})

test('refreshToken 失效但保存了账号时静默重登，用户不必再手工登录', async () => {
  let loginCalls = 0
  const target = await setup(async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/auth/refresh') return response({ message: 'expired' }, 401)
    if (path === '/api/auth/login') {
      loginCalls += 1
      return response({ accessToken: 'access-relogin', refreshToken: 'refresh-relogin', expiresIn: 120 })
    }
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 1 })
  })
  await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  assert.equal(await target.service.getAccessToken('peer-1'), 'access-relogin')
  assert.equal(loginCalls, 1)
  // 重登后目标仍为 ready，账号密码继续保留，下一次仍然可以自动恢复。
  assert.equal((await target.store.get('peer-1'))?.status, 'ready')
  assert.equal((await target.credentials.read('peer-1'))?.password, 'password-secret')
})

test('账号被目标拒绝时清除凭据并转为需要登录，不做无限重试', async () => {
  let loginCalls = 0
  const target = await setup(async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/auth/refresh') return response({ message: 'expired' }, 401)
    if (path === '/api/auth/login') {
      loginCalls += 1
      // 首次登录成功（用户保存凭据那一刻），之后目标改了口令，重登被拒。
      if (loginCalls === 1) return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 1 })
      return response({ error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '目标 Host 用户名或密码错误' } }, 401)
    }
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 1 })
  })
  await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  await assert.rejects(target.service.getAccessToken('peer-1'), /需要登录/u)
  assert.equal((await target.store.get('peer-1'))?.status, 'session_required')
  // 口令被拒后必须清除凭据，否则会拿同一份错误口令反复重试。
  assert.equal(await target.credentials.read('peer-1'), null)
})

test('续期网络失败时保留凭据，不误报登录失效或额外尝试账号登录', async () => {
  let loginCalls = 0
  const target = await setup(async (input) => {
    const path = new URL(String(input)).pathname
    // 首次登录成功；此后所有认证请求都因网络不可达失败。
    if (path === '/api/auth/login') {
      loginCalls += 1
      if (loginCalls === 1) return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 1 })
    }
    throw new Error('network down')
  })
  await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  await assert.rejects(target.service.getAccessToken('peer-1'), { code: 'PEER_HOST_PROXY_UNREACHABLE' })
  // 网络类失败保留凭据，等待下一次请求再试。
  assert.equal((await target.credentials.read('peer-1'))?.password, 'password-secret')
  assert.equal((await target.store.get('peer-1'))?.status, 'ready')
  assert.equal(loginCalls, 1)
})

test('并发恢复同一旧票据只续期一次，迟到的旧 401 复用新票据', async () => {
  let refreshes = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const target = await setup(async input => {
    assert.equal(new URL(String(input)).pathname, '/api/auth/refresh')
    refreshes += 1
    await gate
    return response({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 120 })
  })
  await target.credentials.write('peer-1', { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 2_000 })
  const requests = [target.service.getAccessToken('peer-1'), target.service.recoverAccessToken('peer-1', 'old-access'), target.service.refresh('peer-1')]
  release()
  await Promise.all(requests)
  assert.equal(refreshes, 1)
  assert.equal(await target.service.recoverAccessToken('peer-1', 'old-access'), 'new-access')
  assert.equal(refreshes, 1)
})

test('缓存为需要登录但凭据仍可刷新时自动恢复 ready', async () => {
  const target = await setup(async () => response({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 120 }))
  await target.credentials.write('peer-1', { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 121_000 })
  await target.store.updateStatus('peer-1', 'session_required', 'PEER_HOST_SESSION_REQUIRED')
  assert.equal(await target.service.getAccessToken('peer-1'), 'new-access')
  assert.equal((await target.store.get('peer-1'))?.status, 'ready')
})

test('退出会话会清理目标凭据，即使远端退出请求失败', async () => {
  const target = await setup(async (input) => {
    if (new URL(String(input)).pathname === '/api/auth/logout') throw new Error('network down')
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 120 })
  })
  await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  assert.deepEqual(await target.service.logout('peer-1'), { peerHostId: 'peer-1', status: 'logged_out', expiresAt: null })
  assert.equal(await target.credentials.read('peer-1'), null)
})

test('目标拒绝旧登录态后可以直接重新登录并恢复 ready', async () => {
  const target = await setup(async () => response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 120 }))
  await target.service.invalidate('peer-1')
  assert.equal((await target.store.get('peer-1'))?.status, 'session_required')
  const view = await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  assert.equal(view.status, 'logged_in')
  assert.equal((await target.store.get('peer-1'))?.status, 'ready')
  assert.deepEqual(await target.credentials.read('peer-1'), {
    accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 121_000,
    username: 'alice', password: 'password-secret',
  })
})

test('目标拒绝登录凭据时提示密码错误，而不是笼统的登录态失效', async () => {
  const target = await setup(async () => response({ error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '目标 Host 用户名或密码错误' } }, 401))
  await assert.rejects(
    target.service.login('peer-1', { username: 'alice', password: 'wrong-password' }),
    (error: unknown) => {
      const value = error as { code?: string; message?: string }
      assert.equal(value.code, 'PEER_HOST_SESSION_REQUIRED')
      assert.match(value.message ?? '', /用户名或密码错误/u)
      return true
    },
  )
  assert.equal((await target.store.get('peer-1'))?.status, 'ready')
})
