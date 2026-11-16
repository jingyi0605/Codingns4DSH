import assert from 'node:assert/strict'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { startMagpieSessionProxy } from '../data/build/dist/host/cli-adapters/magpie-session-proxy.js'

interface Seen { readonly method: string | undefined; readonly url: string | undefined; readonly headers: IncomingHttpHeaders; readonly body: string }

async function startUpstream(handler: (seen: Seen, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(entry)
      handler(entry, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

function send(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

test('the session proxy tags forwarded requests with the DSH session and keeps credentials and body intact', async (t) => {
  const upstream = await startUpstream((_seen, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: one\n\n'); setTimeout(() => res.end('data: two\n\n'), 10) })
  t.after(() => upstream.server.close())
  const proxy = await startMagpieSessionProxy(`${upstream.url}/v1`, 'dsh-session-1')
  assert.ok(proxy)
  t.after(() => proxy.close())

  const reply = await send(`${proxy.baseUrl}/v1beta/models/m:streamGenerateContent?alt=sse`, {
    method: 'POST', headers: { 'x-goog-api-key': 'k-1', 'content-type': 'application/json' }, body: '{"hello":"world"}',
  })

  assert.equal(reply.status, 200)
  assert.equal(reply.body, 'data: one\n\ndata: two\n\n')
  assert.equal(upstream.seen.length, 1)
  assert.equal(upstream.seen[0]?.method, 'POST')
  assert.equal(upstream.seen[0]?.url, '/v1/v1beta/models/m:streamGenerateContent?alt=sse')
  assert.equal(upstream.seen[0]?.headers['x-magpie-session'], 'dsh-session-1')
  assert.equal(upstream.seen[0]?.headers['x-goog-api-key'], 'k-1')
  assert.equal(upstream.seen[0]?.body, '{"hello":"world"}')
  assert.match(String(upstream.seen[0]?.headers.host), /^127\.0\.0\.1:\d+$/u)
})

test('the session proxy does not override a session header the client already sent', async (t) => {
  const upstream = await startUpstream((_seen, res) => res.end('{}'))
  t.after(() => upstream.server.close())
  const proxy = await startMagpieSessionProxy(upstream.url, 'dsh-session-1')
  assert.ok(proxy)
  t.after(() => proxy.close())

  await send(`${proxy.baseUrl}/v1/models`, { headers: { 'X-Magpie-Session': 'client-session' } })

  assert.equal(upstream.seen[0]?.url, '/v1/models')
  assert.equal(upstream.seen[0]?.headers['x-magpie-session'], 'client-session')
})

test('the session proxy relays upstream error statuses and answers 502 when the gateway is down', async (t) => {
  const upstream = await startUpstream((_seen, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"slow down"}') })
  const proxy = await startMagpieSessionProxy(upstream.url, 'dsh-session-1')
  assert.ok(proxy)
  t.after(() => proxy.close())

  assert.deepEqual(await send(`${proxy.baseUrl}/v1/x`), { status: 429, body: '{"error":"slow down"}' })
  await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
  const down = await send(`${proxy.baseUrl}/v1/x`)
  assert.equal(down.status, 502)
  assert.doesNotMatch(down.body, /127\.0\.0\.1/u)
})

test('the session proxy stops listening once closed, even with an open stream', async (t) => {
  const upstream = await startUpstream((_seen, res) => { res.writeHead(200); res.write('start') })
  t.after(() => { upstream.server.closeAllConnections(); upstream.server.close() })
  const proxy = await startMagpieSessionProxy(upstream.url, 'dsh-session-1')
  assert.ok(proxy)
  const pending = send(`${proxy.baseUrl}/v1/stream`).catch(() => null)
  await new Promise((resolve) => setTimeout(resolve, 50))

  await proxy.close()
  await pending

  await assert.rejects(send(`${proxy.baseUrl}/v1/x`))
})

test('the session proxy refuses targets and session IDs it cannot forward safely', async () => {
  assert.equal(await startMagpieSessionProxy('http://magpie.example.com:3425', 'dsh-session-1'), null)
  assert.equal(await startMagpieSessionProxy('file:///tmp/magpie', 'dsh-session-1'), null)
  assert.equal(await startMagpieSessionProxy('not a url', 'dsh-session-1'), null)
  assert.equal(await startMagpieSessionProxy('http://127.0.0.1:3425', ''), null)
  assert.equal(await startMagpieSessionProxy('http://127.0.0.1:3425', 'a'.repeat(129)), null)
  assert.equal(await startMagpieSessionProxy('http://127.0.0.1:3425', 'bad\nsession'), null)
})
