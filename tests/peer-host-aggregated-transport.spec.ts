import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AggregatedHostTransportError,
  AggregatedHostTransportService,
} from '../data/build/dist/host/modules/peer-host/aggregated-host-transport.js'

const localScope = { hostId: 'host-local', targetHostId: null, workspaceId: 'workspace-1', sessionId: null, scopeGeneration: 1 } as const
const peerScope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 2 } as const
const plugin = {
  pluginId: '@jingyi0605/codingns4dsh',
  pluginVersion: '0.2.0-beta.1',
  manifestSource: 'local' as const,
  bundleSource: 'local' as const,
  uiSource: 'local' as const,
  allowRemoteManifest: false as const,
  allowRemoteBundle: false as const,
}

function createTransport(overrides: Record<string, unknown> = {}) {
  const requests: Array<Record<string, unknown>> = []
  const transport = new AggregatedHostTransportService({
    localHostId: 'host-local',
    hostHome: 'http://local.test',
    localPlugin: plugin,
    capabilities: [],
    local: {
      rpc: async (request) => ({ local: request.method }),
      fetch: async () => Response.json({ local: true }),
    },
    httpProxy: {
      request: async (peerHostId: string, request: Record<string, unknown>) => {
        requests.push({ peerHostId, ...request })
        return { status: 200, headers: [], body: JSON.stringify({ remote: true }) }
      },
    } as never,
    wsProxy: { open: async () => () => undefined } as never,
    ...overrides,
  })
  return { transport, requests }
}

test('Aggregated RPC 只允许固定 method，并按 HostScope 路由到目标 Host', async () => {
  const { transport, requests } = createTransport()
  assert.deepEqual(await transport.rpc({ scope: localScope, method: 'workspace.list' }), { local: 'workspace.list' })
  assert.deepEqual(await transport.rpc({ scope: peerScope, method: 'session.send', payload: { text: 'hi' } }), { remote: true })
  assert.equal(requests[0]?.peerHostId, 'peer-1')
  assert.equal(requests[0]?.path, '/api/sessions')
  assert.equal(requests[0]?.method, 'POST')
  await assert.rejects(transport.rpc({ scope: peerScope, method: 'admin.secret' }), (error: unknown) => error instanceof AggregatedHostTransportError && error.code === 'PEER_HOST_AGGREGATED_TRANSPORT_UNSUPPORTED')
})

test('Aggregated Transport 拒绝任意 URL、远端 Bundle，并提供 generation/reconnect', async () => {
  let reconnects = 0
  const { transport } = createTransport({ peer: { reconnect: async () => { reconnects += 1 } } })
  await assert.rejects(transport.fetch({ scope: peerScope, path: 'https://evil.test/api/workspaces' }), /路径未加入白名单/u)
  await assert.rejects(transport.loadBundle('https://evil.test/plugin.js'), (error: unknown) => error instanceof AggregatedHostTransportError && error.code === 'PEER_HOST_AGGREGATED_BUNDLE_FORBIDDEN')
  assert.equal(transport.readManifest().remoteBundle, 'forbidden')
  const seen: number[] = []
  const dispose = transport.onGenerationChange((generation) => { if (generation !== undefined) seen.push(generation.id) })
  await transport.reconnect()
  dispose()
  assert.equal(reconnects, 1)
  assert.deepEqual(seen, [1])
  assert.equal(transport.getGeneration()?.id, 1)
})

test('关闭后的旧 Transport 不会继续接受请求，目标 token 不出现在契约中', async () => {
  const { transport } = createTransport()
  await transport.close()
  await assert.rejects(transport.rpc({ scope: localScope, method: 'workspace.list' }), /已关闭/u)
  assert.equal('accessToken' in transport.readManifest(), false)
})

test('DSH 原生 Remote 只走显式 native connector，不错误降级到旧 HTTP API', async () => {
  const calls: string[] = []
  const { transport, requests } = createTransport({ peer: {
    nativeRpc: async (_peerHostId: string, request: { method: string }) => {
      calls.push(request.method)
      return { native: true }
    },
    nativeStream: (_peerHostId: string, request: { method: string }) => (async function* () { calls.push(request.method); yield { type: 'baseline' } })(),
  } })
  const result = await transport.rpc({ scope: peerScope, method: 'session/prompt', payload: { sessionId: 'remote-session' } })
  assert.deepEqual(result, { native: true })
  const stream = transport.openStream<{ type: string }>({ scope: peerScope, method: 'session/follow', payload: {} })
  assert.deepEqual(await Array.fromAsync(stream), [{ type: 'baseline' }])
  assert.deepEqual(calls, ['session/prompt', 'session/follow'])
  assert.deepEqual(requests, [])
})

test('未装配原生 Remote connector 时明确返回 unsupported', async () => {
  const { transport } = createTransport()
  await assert.rejects(transport.rpc({ scope: peerScope, method: 'session/prompt', payload: {} }), /原生 Remote 尚未装配/u)
  const chunks = transport.openStream({ scope: peerScope, method: 'workspace/follow' })
  await assert.rejects(async () => { for await (const _chunk of chunks) { /* 预期不会产生数据 */ } }, /原生 Remote stream 尚未装配/u)
})

test('原生 Remote 同样必须通过 HostScope 校验', async () => {
  const calls: string[] = []
  const { transport } = createTransport({ peer: {
    nativeRpc: async () => { calls.push('called'); return {} },
  } })
  await assert.rejects(transport.rpc({ scope: { ...peerScope, hostId: 'other-host' }, method: 'session/prompt', payload: {} }), /作用域不匹配/u)
  assert.deepEqual(calls, [])
})
