import assert from 'node:assert/strict'
import test from 'node:test'
import { quickAppHttpsFixture } from './quick-apps-https-fixture.js'
import { parseQuickAppHttpsConfig } from '../src/dsh-capabilities/host/quick-app-https-provider.js'

test('configured HTTPS transport validates TLS/SNI/Host, bootstraps once, isolates credentials and closes', { timeout: 30_000 }, async t => {
  const f = await quickAppHttpsFixture(); t.after(f.dispose)
  assert.equal(f.provider.available(f.uiOrigin), true)
  assert.equal(f.provider.available('https://unapproved.test'), false)
  for (const patch of [{ appDomain: 'localhost' }, { appDomain: 'apps.localhost' }, { listenHost: 'all' }, { listenPort: 0 }, { uiOrigins: ['file://'] }, { uiOrigins: ['https://page.apps.quick-app.test'] }, { uiOrigins: ['https://ui.quick-app.test'] }]) assert.throws(() => parseQuickAppHttpsConfig({ ...f.config, ...patch }))
  await assert.rejects(f.service.launch(f.app.id, 'owner', undefined, 'https://unapproved.test'), { code: 'QUICK_APP_ORIGIN_UNAVAILABLE' })
  await f.service.grant(f.app.id, 1, { read: ['data'], write: ['data'], delete: [] })
  const first = await f.launch(); const second = await f.launch()
  assert.notEqual(new URL(first.origin).hostname, new URL(second.origin).hostname)
  const landing = await f.http(first.origin, '/__quickapp/bootstrap')
  assert.equal(landing.status, 200); assert.equal(landing.text.includes(new URL(first.url).hash.slice(1)), false)
  assert.ok(landing.headers['content-security-policy'].includes(`frame-ancestors ${f.uiOrigin}`))
  assert.equal((await f.http(first.origin, '/index.html')).status, 401)
  assert.equal((await f.http(first.origin, '/index.html', { servername: new URL(second.origin).hostname })).status, 421)
  assert.equal((await f.http(first.origin, '/index.html', { headers: { host: 'wrong.test' } })).status, 421)
  assert.equal((await f.http(first.origin, '/__quickapp/exchange', { method: 'POST', headers: { origin: second.origin, 'content-type': 'text/plain' }, body: new URL(first.url).hash.slice(1) })).status, 403)
  const exchanged = await f.exchange(first)
  assert.equal(exchanged.status, 200); assert.equal(exchanged.text, '/index.html')
  const header = exchanged.headers['set-cookie'][0]
  assert.match(header, /^__Host-quickapp=/u)
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/']) assert.ok(header.includes(attribute))
  assert.equal(header.includes('Domain='), false)
  const cookie = header.split(';')[0]
  assert.equal((await f.exchange(first)).status, 403)
  assert.equal((await f.http(first.origin, '/index.html', { headers: { cookie } })).status, 200)
  assert.equal((await f.http(second.origin, '/index.html', { headers: { cookie } })).status, 401)
  assert.equal((await f.http(first.origin, '/__quickapp/ready', { headers: { cookie } })).status, 204)
  await f.service.launches.revoke(first.launchId)
  assert.equal((await f.http(first.origin, '/index.html', { headers: { cookie } })).status, 421)
  await f.service.launches.revoke(second.launchId)
  await assert.rejects(f.http(second.origin, '/index.html'), /ECONNREFUSED/u)
})

test('expired HTTPS leases are reclaimed before the next origin allocation', { timeout: 30_000 }, async t => {
  const f = await quickAppHttpsFixture(); t.after(f.dispose)
  const first = await f.launch()
  Object.defineProperty(f.service.launches, 'now', { value: () => Date.now() + 31 * 60_000 })
  const next = await f.launch()
  assert.equal(f.service.launches.size, 1)
  assert.notEqual(next.origin, first.origin)
  assert.equal((await f.http(first.origin, '/index.html')).status, 421)
  assert.equal((await f.exchange(next)).status, 200)
})
