import assert from 'node:assert/strict'
import test from 'node:test'
import type { PeerHostHttpProxyService } from '../data/build/dist/host/modules/peer-host/host-api-proxy-service.js'
import { callPeerNativeRpc, openPeerNativeStream, readNativeRpcEnvelope } from '../data/build/dist/host/modules/peer-host/peer-host-native-transport.js'

const scope = { hostId: 'local-host', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: null, scopeGeneration: 0 }

interface ProxyCall {
  readonly path: string
  readonly envelope: { rpcId?: unknown; method?: unknown; payload?: unknown }
}

/** 复刻目标 `/api/codingns/<endpoint>` fetch 路由的信封校验与响应形状。 */
function createTargetProxy(handler: (endpoint: string, payload: unknown) => unknown): { calls: ProxyCall[]; service: PeerHostHttpProxyService } {
  const calls: ProxyCall[] = []
  const service = {
    async request(_peerHostId: string, request: { readonly path: string; readonly body?: string }) {
      const envelope = JSON.parse(request.body ?? '{}') as ProxyCall['envelope']
      const endpoint = request.path.replace('/api/codingns/', '')
      calls.push({ path: request.path, envelope })
      if (typeof envelope.rpcId !== 'string' || envelope.method !== endpoint) {
        return { status: 400, headers: [], body: 'invalid RPC envelope' }
      }
      return {
        status: 200,
        headers: [],
        body: JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: handler(endpoint, envelope.payload) }),
      }
    },
  } as unknown as PeerHostHttpProxyService
  return { calls, service }
}

test('原生调用使用目标 fetch 路由信封并透传内层载荷', async () => {
  const proxy = createTargetProxy((endpoint, payload) => ({ ok: true, value: { endpoint, payload } }))
  const value = await callPeerNativeRpc(proxy.service, 'peer-1', { scope, method: 'session/list', payload: { limit: 1 } })
  assert.deepEqual(value, {
    endpoint: 'peerHost/nativeLocal',
    payload: { method: 'session/list', payload: { limit: 1 }, scope },
  })
  assert.equal(proxy.calls.length, 1)
  assert.equal(proxy.calls[0]?.path, '/api/codingns/peerHost/nativeLocal')
  assert.equal(typeof proxy.calls[0]?.envelope.rpcId, 'string')
  assert.equal(proxy.calls[0]?.envelope.method, 'peerHost/nativeLocal')
})

test('原生流按 open/next/close 顺序取值并在 done 后关闭', async () => {
  const results = [
    { ok: true, value: { streamId: 'stream-1' } },
    { ok: true, value: { done: false, value: { type: 'baseline', value: { items: [] } } } },
    { ok: true, value: { done: false, value: { type: 'upsert' } } },
    { ok: true, value: { done: true } },
    { ok: true, value: { closed: true } },
  ]
  let index = 0
  const proxy = createTargetProxy(() => results[index++])
  const received: unknown[] = []
  for await (const frame of openPeerNativeStream(proxy.service, 'peer-1', { scope, method: 'workspace/follow' })) received.push(frame)
  assert.deepEqual(received, [{ type: 'baseline', value: { items: [] } }, { type: 'upsert' }])
  assert.deepEqual(proxy.calls.map((call) => call.envelope.method), [
    'peerHost/nativeStreamOpen',
    'peerHost/nativeStreamNext',
    'peerHost/nativeStreamNext',
    'peerHost/nativeStreamNext',
    'peerHost/nativeStreamClose',
  ])
})

test('原生响应错误按稳定错误码抛出，非 JSON 响应单独归类', () => {
  assert.throws(
    () => readNativeRpcEnvelope(JSON.stringify({ type: 'server-response', rpcId: 'r1', result: { ok: false, error: { code: 'CODINGNS_RPC_UNSUPPORTED', message: '不支持' } } })),
    (error: unknown) => (error as { code?: string }).code === 'CODINGNS_RPC_UNSUPPORTED',
  )
  assert.throws(
    () => readNativeRpcEnvelope(JSON.stringify({ error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '需要登录' } })),
    (error: unknown) => (error as { code?: string }).code === 'PEER_HOST_SESSION_REQUIRED',
  )
  assert.throws(
    () => readNativeRpcEnvelope('invalid RPC envelope'),
    (error: unknown) => (error as { code?: string }).code === 'CODINGNS_RPC_RESPONSE_INVALID',
  )
})

test('目标入口短暂不可达时流通道有限重试并最终成功', async () => {
  let opens = 0
  const service = {
    async request(_peerHostId: string, request: { readonly path: string }) {
      if (request.path.endsWith('/nativeStreamOpen')) {
        opens += 1
        if (opens < 3) {
          return { status: 502, headers: [], body: JSON.stringify({ error: { code: 'PEER_HOST_PROXY_UNREACHABLE', message: '目标 Host 代理不可达' } }) }
        }
        return { status: 200, headers: [], body: JSON.stringify({ result: { ok: true, value: { streamId: 'stream-1' } } }) }
      }
      if (request.path.endsWith('/nativeStreamNext')) {
        return { status: 200, headers: [], body: JSON.stringify({ result: { ok: true, value: { done: true } } }) }
      }
      return { status: 200, headers: [], body: JSON.stringify({ result: { ok: true, value: {} } }) }
    },
  } as unknown as PeerHostHttpProxyService
  const received: unknown[] = []
  for await (const frame of openPeerNativeStream(service, 'peer-1', { scope, method: 'session/follow' })) received.push(frame)
  assert.deepEqual(received, [])
  assert.equal(opens, 3)
})

test('业务错误不触发重试', async () => {
  let calls = 0
  const service = {
    async request() {
      calls += 1
      return { status: 200, headers: [], body: JSON.stringify({ result: { ok: false, error: { code: 'PEER_HOST_SESSION_REQUIRED', message: '需要登录' } } }) }
    },
  } as unknown as PeerHostHttpProxyService
  await assert.rejects(
    (async () => {
      const frames: unknown[] = []
      for await (const frame of openPeerNativeStream(service, 'peer-1', { scope, method: 'session/follow' })) frames.push(frame)
      return frames
    })(),
    (error: unknown) => (error as { code?: string }).code === 'PEER_HOST_SESSION_REQUIRED',
  )
  assert.equal(calls, 1)
})
