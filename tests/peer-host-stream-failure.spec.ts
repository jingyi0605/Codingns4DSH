import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createCodingNsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { PeerHostHttpProxyService } from '../data/build/dist/host/modules/peer-host/host-api-proxy-service.js'
import { PeerHostNativeStreams } from '../data/build/dist/host/modules/peer-host/peer-host-native-streams.js'
import { openPeerNativeStream } from '../data/build/dist/host/modules/peer-host/peer-host-native-transport.js'
import { PeerHostNativeStreamError } from '../data/build/dist/host/modules/peer-host/peer-host-request-errors.js'
import type { PeerHostSessionService } from '../data/build/dist/host/modules/peer-host/peer-host-session.js'
import { InMemoryPeerHostCredentialStore, InMemoryPeerHostRecordStore, PeerHostStore } from '../data/build/dist/host/modules/peer-host/peer-host-store.js'

const scope = { hostId: 'local-host', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 }

/** 使用真实代理和流注册表，网络与凭据留在内存，不访问任何实际 Host。 */
async function createProxy(fetchImpl: typeof fetch): Promise<PeerHostHttpProxyService> {
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), new InMemoryPeerHostCredentialStore(), () => 100, () => 'peer-1')
  await store.create({ displayName: '测试机', route: { kind: 'lan', baseUrl: 'http://peer.invalid', normalizedOrigin: '' } })
  await store.updateHandshake('peer-1', {
    status: 'ready', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2',
    apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:test', lastCheckedAt: 100, lastErrorCode: null,
  })
  const sessions = { getAccessToken: async () => 'access-secret' } as unknown as PeerHostSessionService
  return new PeerHostHttpProxyService(store, sessions, { fetchImpl })
}

function response(value: unknown): Response {
  return Response.json({ result: { ok: true, value } })
}

function streamHandler(streams: PeerHostNativeStreams, id: string) {
  const table = new CodingNsRpcTable()
  table.register('peerHost', (_action, _payload, context) => streams.next(id, scope, (context as { signal: AbortSignal }).signal))
  return createCodingNsRpcHandler(table)
}

for (const mode of ['request', 'close'] as const) {
  test(`${mode === 'request' ? '请求取消' : '主动关闭流'}保留 AbortError，不重试也不打印故障`, async t => {
    const errors = t.mock.method(console, 'error', () => undefined)
    const warnings = t.mock.method(console, 'warn', () => undefined)
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const paths: string[] = []
    const proxy = await createProxy(async (input, init) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (!path.endsWith('/nativeStreamNext')) return response(path.endsWith('/nativeStreamOpen') ? { streamId: 'remote-stream' } : { closed: true })
      const signal = init?.signal as AbortSignal
      markStarted()
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const streams = new PeerHostNativeStreams()
    const id = await streams.open(scope, signal => openPeerNativeStream(proxy, 'peer-1', { scope, method: 'session/follow', signal }))
    const controller = new AbortController()
    const pending = streamHandler(streams, id)('peerHost/nativeStreamNext', {}, controller.signal)
    try {
      await started
      if (mode === 'request') controller.abort(new Error('切换会话'))
      else await streams.close(id, scope)
      const result = await pending
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, 'AbortError')
      assert.equal(errors.mock.callCount(), 0)
      assert.equal(warnings.mock.callCount(), 0)
      assert.deepEqual(paths.map(path => path.split('/').at(-1)), ['nativeStreamOpen', 'nativeStreamNext', 'nativeStreamClose'])
      await assert.rejects(streams.next(id, scope), { code: 'CODINGNS_RPC_NOT_FOUND' })
    } finally { streams.dispose() }
  })
}

test('读取超时仍记录真实失败与订阅上下文，不被取消分支吞掉', async t => {
  const errors = t.mock.method(console, 'error', () => undefined)
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const proxy = await createProxy(async (input, init) => {
    if (!String(input).endsWith('/nativeStreamNext')) return response({ streamId: 'remote-stream' })
    const signal = init?.signal as AbortSignal
    markStarted()
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const streams = new PeerHostNativeStreams()
  const id = await streams.open(scope, signal => openPeerNativeStream(proxy, 'peer-1', { scope, method: '$events', signal }))
  const controller = new AbortController()
  const pending = streamHandler(streams, id)('peerHost/nativeStreamNext', {}, controller.signal)
  try {
    await started
    controller.abort(new DOMException('读取超时', 'TimeoutError'))
    const result = await pending
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'PEER_HOST_PROXY_UNREACHABLE')
    assert.equal(errors.mock.callCount(), 1)
    const details = errors.mock.calls[0]!.arguments[1] as { method: string; cause: { name: string }; targetHostId: string; phase: string }
    assert.equal(details.method, '$events')
    assert.equal(details.targetHostId, 'peer-1')
    assert.equal(details.phase, 'next')
    assert.equal(details.cause.name, 'TimeoutError')
  } finally { streams.dispose() }
})

test('连接失败重试耗尽后只记录一次目标、订阅方法、耗时和脱敏底层原因', async t => {
  const errors = t.mock.method(console, 'error', () => undefined)
  const networkCause = Object.assign(new Error('http://private.invalid password-secret access-secret'), { code: 'ECONNREFUSED', errno: -61, syscall: 'connect' })
  const networkError = new TypeError('fetch failed', { cause: networkCause })
  let reads = 0
  const proxy = await createProxy(async input => {
    if (!String(input).endsWith('/nativeStreamNext')) return response({ streamId: 'remote-stream' })
    reads += 1
    throw networkError
  })
  const streams = new PeerHostNativeStreams()
  const id = await streams.open(scope, signal => openPeerNativeStream(proxy, 'peer-1', { scope, method: 'session/follow', signal }))
  try {
    const result = await streamHandler(streams, id)('peerHost/nativeStreamNext', {}, new AbortController().signal)
    assert.equal(reads, 3)
    assert.equal(errors.mock.callCount(), 1)
    const details = errors.mock.calls[0]!.arguments[1] as Record<string, unknown>
    assert.equal(details.targetHostId, 'peer-1')
    assert.equal(details.method, 'session/follow')
    assert.equal(details.phase, 'next')
    assert.equal(details.workspaceId, 'workspace-1')
    assert.equal(details.sessionId, 'session-1')
    assert.equal(details.attempts, 3)
    assert.equal(details.status, 502)
    assert.ok(Number(details.elapsedMs) >= 1100)
    assert.deepEqual(details.cause, { name: 'TypeError', cause: { name: 'Error', code: 'ECONNREFUSED', errno: -61, syscall: 'connect' } })
    assert.equal(result.ok, false)
    if (!result.ok) assert.deepEqual(result.error, { code: 'PEER_HOST_PROXY_UNREACHABLE', message: '目标 Host 代理不可达', details: {} })
    assert.doesNotMatch(JSON.stringify([details, result]), /private\.invalid|password-secret|access-secret/u)
  } finally { streams.dispose() }
})

test('重试等待期间取消会立即退出，不再向目标发出请求', async () => {
  const controller = new AbortController()
  let requests = 0
  const proxy = await createProxy(async () => {
    requests += 1
    void setImmediate().then(() => controller.abort())
    throw new TypeError('fetch failed')
  })
  const iterator = openPeerNativeStream(proxy, 'peer-1', { scope, method: 'workspace/follow', signal: controller.signal })[Symbol.asyncIterator]()
  await assert.rejects(iterator.next(), { name: 'AbortError' })
  assert.equal(requests, 1)
})

test('请求尚未发出就被取消时不访问代理，也不产生失败诊断', async () => {
  let requests = 0
  const proxy = await createProxy(async () => { requests += 1; return response({}) })
  const controller = new AbortController()
  controller.abort()
  const iterator = openPeerNativeStream(proxy, 'peer-1', { scope, method: '$events', signal: controller.signal })[Symbol.asyncIterator]()
  await assert.rejects(iterator.next(), { name: 'AbortError' })
  assert.equal(requests, 0)
})

test('底层 cause 留在 Host 内存，open 失败也带上下文和聚合连接错误', async () => {
  const nested = Object.assign(new Error('凭据正文'), { code: 'ETIMEDOUT', syscall: 'connect' })
  const aggregate = new AggregateError([nested], '内部地址')
  const networkError = new TypeError('fetch failed', { cause: aggregate })
  const proxy = await createProxy(async () => { throw networkError })
  const iterator = openPeerNativeStream(proxy, 'peer-1', { scope, method: 'workspace/follow' })[Symbol.asyncIterator]()
  await assert.rejects(iterator.next(), (error: unknown) => {
    assert.ok(error instanceof PeerHostNativeStreamError)
    assert.equal(error.cause, networkError)
    assert.equal(error.diagnostics.phase, 'open')
    assert.deepEqual(error.diagnostics.cause, { name: 'TypeError', cause: { name: 'AggregateError', errors: [{ name: 'Error', code: 'ETIMEDOUT', syscall: 'connect' }] } })
    return true
  })
})

test('本地代理校验失败保留原错误码，不退化成连接不可达', async () => {
  let requests = 0
  const proxy = await createProxy(async () => { requests += 1; return response({}) })
  const iterator = openPeerNativeStream(proxy, 'peer-1', {
    scope, method: 'session/follow', payload: { text: 'x'.repeat(4 * 1024 * 1024) },
  })[Symbol.asyncIterator]()
  await assert.rejects(iterator.next(), { code: 'PEER_HOST_PROXY_PATH_NOT_ALLOWED' })
  assert.equal(requests, 0)
})
