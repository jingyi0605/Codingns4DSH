import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createLoginProtectionConfig, createNodeLanAccessDshRuntime, LanAccessDshProxy } from '../src/host/lan-access-dsh.js'

test('an admitted LAN browser waits for native authentication and then uses it without exposing the native cookie', async (t) => {
  const nativeCookie = 'fixture_native=authenticated'
  const password = 'fixture-local-password'
  let exchanges = 0
  let reads = 0
  let entryReady = false
  let nativeReady = false
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture')
    if (url.searchParams.get('token') === 'fixture') {
      exchanges++
      if (!nativeReady) { res.writeHead(401).end(); return }
      res.writeHead(303, { location: '/', 'set-cookie': ['fixture_expired=; Max-Age=0', `${nativeCookie}; HttpOnly; Path=/`] }).end()
      return
    }
    reads++
    if (req.headers.cookie?.split(';').find(pair => pair.trim().startsWith('fixture_native='))?.trim() !== nativeCookie) {
      res.writeHead(401).end('native pairing page')
      return
    }
    res.end('authenticated DSH fixture')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => { upstream.closeAllConnections(); upstream.close() })
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const runtime = createNodeLanAccessDshRuntime(address.port)
  const proxy = new LanAccessDshProxy({
    ...runtime,
    // Exercise the real TCP forwarding while treating this fixture socket as a LAN browser.
    listen: (config, onConnection) => runtime.listen(config, socket => {
      Object.defineProperty(socket, 'remoteAddress', { value: '192.0.2.10' })
      onConnection(socket)
    }),
  }, base => entryReady ? `${base}?token=fixture` : undefined, 'fixture_lan')
  t.after(() => proxy.stop())
  const lan = await proxy.start({ listenPort: 0, listenHost: '127.0.0.1', login: createLoginProtectionConfig({ username: 'fixture-user', password, timeoutSeconds: 1800 }) })
  const url = `http://127.0.0.1:${lan.actualListenPort}`
  const request = (path: string, init?: RequestInit) => fetch(`${url}${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const login = (value: string) => request('/__codingns/login', { method: 'POST', body: new URLSearchParams({ username: 'fixture-user', password: value }) })

  assert.equal((await request('/')).status, 200)
  assert.equal((await request('/api/protected')).status, 401)
  assert.equal((await login('incorrect')).status, 401)
  assert.equal(exchanges, 0)
  assert.equal(reads, 0)

  const notReady = await login(password)
  assert.equal(notReady.status, 503)
  assert.equal(notReady.headers.get('set-cookie'), null)
  assert.match(await notReady.text(), /DSH 暂时无法完成登录/u)
  entryReady = true
  const rejected = await login(password)
  assert.equal(rejected.status, 503)
  assert.equal(exchanges, 1)
  nativeReady = true
  const [first, second] = await Promise.all([login(password), login(password)])
  assert.equal(exchanges, 2, 'concurrent password logins reuse the same native exchange')
  for (const response of [first, second]) {
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/')
    assert.deepEqual(response.headers.getSetCookie().map(value => value.split('=')[0]), ['fixture_lan'])
  }
  const session = first.headers.getSetCookie()[0]!.split(';')[0]
  const page = await request('/', { headers: { cookie: `${session}; fixture_native=stale` } })
  assert.equal(page.status, 200)
  assert.equal(await page.text(), 'authenticated DSH fixture')
  assert.equal(await (await request('/api/protected', { headers: { cookie: session } })).text(), 'authenticated DSH fixture')
  assert.equal(exchanges, 2)
})
