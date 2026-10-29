import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import { LanAccessDshProxy, registerWorkspaceMcpLanRoute, synthLanResponse, type LanAccessDshRuntime } from '../src/host/lan-access-dsh.js'

test('Workspace MCP is multiplexed through the existing LAN access listener', async (t) => {
  const runtime: LanAccessDshRuntime = {
    listListenHosts: () => ['127.0.0.1', '0.0.0.0'],
    detectDshPorts: async () => [9080],
    listen: (config, onConnection) => new Promise((resolve, reject) => {
      const server = createServer((socket) => onConnection(socket))
      server.once('error', reject)
      server.listen({ host: config.listenHost, port: config.listenPort }, () => {
        const address = server.address()
        if (address === null || typeof address === 'string') return reject(new Error('Missing listener address'))
        resolve({ actualPort: address.port, close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())) })
      })
    }),
    connect: () => { throw new Error('MCP requests must not be forwarded to DSH') },
  }
  const proxy = new LanAccessDshProxy(runtime)
  const disposeRoute = registerWorkspaceMcpLanRoute(async (request) => {
    assert.equal(request.path, '/mcp')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.authorization, 'Bearer test-key')
    assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body)), { jsonrpc: '2.0', id: 1, method: 'ping' })
    return synthLanResponse({ status: 200, contentType: 'application/json', body: '{"jsonrpc":"2.0","id":1,"result":{}}' })
  })
  t.after(async () => {
    disposeRoute()
    await proxy.close()
  })

  const snapshot = await proxy.start({ listenHost: '127.0.0.1', listenPort: 0, dshPort: 9080 })
  const response = await fetch(`http://127.0.0.1:${snapshot.actualListenPort}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: {} })
})
