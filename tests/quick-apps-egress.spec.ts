import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { quickAppPageEgressUrl, quickAppRequestUsesEgress } from '../src/shared/quick-app-network-bootstrap.js'
import { parseQuickAppNetworkAllow } from '../src/shared/quick-app-network-allow.js'
import { deliverQuickAppEgress, proxyQuickAppEgress, quickAppEgressAddressBlocked, type QuickAppEgressHop } from '../src/host/modules/quick-apps/egress.js'
import { QuickAppError } from '../src/host/modules/quick-apps/errors.js'
import { parseDefinition } from '../src/host/modules/quick-apps/registry.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { definition } from './quick-apps-fixture.js'
import { quickAppProxyFixture } from './quick-apps-proxy-fixture.js'

test('egress addresses exclude loopback, link-local, private, and metadata ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.4.5', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.1.1', '198.18.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(quickAppEgressAddressBlocked(address), true, address)
  }
  assert.equal(quickAppEgressAddressBlocked('8.8.8.8'), false)
  assert.equal(quickAppEgressAddressBlocked('2606:4700:4700::1111'), false)
})

test('sandbox pages proxy only cross-host http(s) and keep the launch egress path', () => {
  const page = 'http://127.0.0.1:8080/__codingns/quick-apps/abc/dir/index.html'
  assert.equal(quickAppPageEgressUrl(page), 'http://127.0.0.1:8080/__codingns/quick-apps/abc/__quickapp/egress')
  assert.equal(quickAppRequestUsesEgress(page, './app.js'), false)
  assert.equal(quickAppRequestUsesEgress(page, 'http://127.0.0.1:8080/__codingns/quick-apps/abc/__quickapp/files?path=a'), false)
  assert.equal(quickAppRequestUsesEgress(page, 'https://api.example.test/v1/models'), true)
  assert.equal(quickAppRequestUsesEgress(page, 'http://127.0.0.1:9/local'), true)
  assert.equal(quickAppRequestUsesEgress(page, 'blob:http://127.0.0.1:8080/uuid'), false)
})

test('egress follows public redirects, drops authorization on a host change, and refuses private targets', async () => {
  const seen: QuickAppEgressHop[] = []
  const result = await proxyQuickAppEgress(JSON.stringify({
    method: 'POST', url: 'https://api.example.test/v1/models', headers: [['authorization', 'Bearer secret'], ['content-type', 'application/json']], body: Buffer.from('{"n":1}').toString('base64'),
  }), AbortSignal.timeout(1000), {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    deliver: async hop => {
      seen.push(hop)
      if (seen.length === 1) return { status: 302, contentType: 'text/plain', body: Buffer.alloc(0), location: 'https://cdn.example.test/result' }
      return { status: 200, contentType: 'application/json', body: Buffer.from('{"ok":true}') }
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.toString(), '{"ok":true}')
  assert.equal(seen[0]?.headers.authorization, 'Bearer secret')
  assert.equal(seen[0]?.hostHeader, 'api.example.test')
  assert.equal(seen[0]?.address, '8.8.8.8')
  assert.equal(seen[1]?.headers.authorization, undefined)
  assert.equal(seen[1]?.method, 'GET')
  assert.equal(seen[1]?.hostname, 'cdn.example.test')
  let calls = 0
  await assert.rejects(() => proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'http://127.0.0.1/secret', headers: [] }), AbortSignal.timeout(1000), {
    deliver: async () => { calls += 1; return { status: 200, contentType: 'text/plain', body: Buffer.alloc(0) } },
  }), (error: QuickAppError) => error.code === 'QUICK_APP_EGRESS_DENIED')
  await assert.rejects(() => proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'https://api.example.test/start', headers: [['authorization', 'Bearer secret']] }), AbortSignal.timeout(1000), {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    deliver: async () => { calls += 1; return { status: 302, contentType: 'text/plain', body: Buffer.alloc(0), location: 'http://169.254.169.254/latest/meta-data' } },
  }), (error: QuickAppError) => error.code === 'QUICK_APP_EGRESS_DENIED')
  assert.equal(calls, 1)
})

test('an app allow list permits only the saved local addresses, ranges, and names', async () => {
  assert.deepEqual(parseQuickAppNetworkAllow([' 192.168.1.5/24 ', 'LocalHost', '127.0.0.1', '::ffff:127.0.0.1', '::1']), ['192.168.1.0/24', 'localhost', '127.0.0.1', '::1'])
  assert.equal(parseDefinition(definition).networkAllow, undefined)
  const parsed = parseDefinition({ ...definition, networkAllow: ['169.254.169.254', 'fe80::1'] })
  assert.deepEqual(parsed.networkAllow, ['169.254.169.254', 'fe80::1'])
  assert.deepEqual(CodingNsSettingsSchema({ quickApps: [{ ...parsed, id: 'app', revision: 1 }] }).quickApps[0]?.networkAllow, ['169.254.169.254', 'fe80::1'])
  for (const entry of ['8.8.8.8', '0.0.0.0/0', '192.168.0.0/15', 'not a host', '2130706433']) assert.throws(() => parseQuickAppNetworkAllow([entry]), entry)
  const deliver = async () => ({ status: 200, contentType: 'text/plain', body: Buffer.from('local') })
  const allowed = await proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:11434/api/tags', headers: [] }), AbortSignal.timeout(1000), { allow: ['127.0.0.1'], deliver })
  assert.equal(allowed.body.toString(), 'local')
  const named = await proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'http://localhost/api/tags', headers: [] }), AbortSignal.timeout(1000), {
    allow: ['127.0.0.1'], lookup: async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }], deliver: async hop => {
      assert.equal(hop.address, '127.0.0.1')
      return deliver(hop)
    },
  })
  assert.equal(named.status, 200)
  await assert.rejects(() => proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'http://192.168.2.4/', headers: [] }), AbortSignal.timeout(1000), {
    allow: ['192.168.1.0/24'], deliver,
  }), (error: QuickAppError) => error.code === 'QUICK_APP_EGRESS_DENIED')
  await assert.rejects(() => proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'http://localhost/', headers: [] }), AbortSignal.timeout(1000), {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }], deliver,
  }), (error: QuickAppError) => error.code === 'QUICK_APP_EGRESS_DENIED')
  const fake = await proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'https://api.glor-ai.com/v1/models', headers: [['authorization', 'Bearer secret']] }), AbortSignal.timeout(1000), {
    lookup: async () => [{ address: '198.18.0.17', family: 4 }],
    deliver: async hop => {
      assert.equal(hop.address, '198.18.0.17')
      assert.equal(hop.hostname, 'api.glor-ai.com')
      assert.equal(hop.hostHeader, 'api.glor-ai.com')
      assert.equal(hop.headers.authorization, 'Bearer secret')
      return { status: 200, contentType: 'application/json', body: Buffer.from('{"models":true}') }
    },
  })
  assert.equal(fake.status, 200)
  const preferred = await proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'https://api.example.test/v1/models', headers: [] }), AbortSignal.timeout(1000), {
    lookup: async () => [{ address: '198.18.0.17', family: 4 }, { address: '8.8.8.8', family: 4 }],
    deliver: async hop => { assert.equal(hop.address, '8.8.8.8'); return deliver(hop) },
  })
  assert.equal(preferred.status, 200)
  await assert.rejects(() => proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'http://198.18.0.17/', headers: [] }), AbortSignal.timeout(1000), { deliver }), (error: QuickAppError) => error.code === 'QUICK_APP_EGRESS_DENIED')
  await assert.rejects(() => proxyQuickAppEgress(JSON.stringify({ method: 'GET', url: 'https://api.example.test/', headers: [] }), AbortSignal.timeout(1000), {
    lookup: async () => [{ address: '198.18.0.17', family: 4 }, { address: '10.1.1.1', family: 4 }], deliver,
  }), (error: QuickAppError) => error.code === 'QUICK_APP_EGRESS_DENIED')
})

test('egress delivery preserves the public Host header and does not return upstream cookies', async () => {
  const seen: { host?: string; authorization?: string; cookie?: string }[] = []
  const server = createServer((req, res) => {
    seen.push({ host: req.headers.host, authorization: req.headers.authorization, cookie: req.headers.cookie })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'session=secret' })
    res.end('{"models":true}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const result = await deliverQuickAppEgress({
      protocol: 'http:', hostname: 'api.example.test', hostHeader: 'api.example.test', address: '127.0.0.1', family: 4, port,
      method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer secret' }, body: Buffer.alloc(0),
    }, AbortSignal.timeout(5000))
    assert.equal(result.status, 200)
    assert.equal(result.contentType, 'application/json; charset=utf-8')
    assert.equal(result.body.toString(), '{"models":true}')
    assert.deepEqual(seen, [{ host: 'api.example.test', authorization: 'Bearer secret', cookie: undefined }])
    assert.equal('location' in result, false)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('sandbox navigation installs the network shim and the launch route blocks private targets', async t => {
  const f = await quickAppProxyFixture(); t.after(() => f.dispose())
  const launch = await f.launch()
  const bootstrap = await textRequest(launch.url, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', accept: 'text/html' })
  assert.match(bootstrap, /function quickAppNetworkInstall/u)
  assert.match(bootstrap, /__quickapp\/egress/u)
  assert.doesNotMatch(bootstrap, /quickAppStorageRuntime/u)
  const page = await textRequest(launch.url, { accept: 'text/html' })
  assert.match(page, /^<script>[\s\S]*function quickAppNetworkInstall[\s\S]*quickAppNetworkInstall\(\);<\/script>/u)
  assert.match(page, /Ordinary static app/u)
  const stored = await f.launch(f.origin, true)
  assert.match(await textRequest(stored.url, { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', accept: 'text/html' }), /function quickAppNetworkInstall[\s\S]*quickAppStorageRuntime/u)
  const denied = await fetch(`${f.origin}${launch.basePath}__quickapp/egress`, {
    method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' },
    body: JSON.stringify({ method: 'GET', url: 'http://169.254.169.254/latest/meta-data', headers: [] }),
  })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error.code, 'QUICK_APP_EGRESS_DENIED')
  const missingOrigin = await fetch(`${f.origin}${launch.basePath}__quickapp/egress`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ method: 'GET', url: 'https://api.example.test/v1/models', headers: [] }),
  })
  assert.equal(missingOrigin.status, 403)
})

function textRequest(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks).toString()))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}
