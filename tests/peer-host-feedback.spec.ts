import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createPeerHostPageTransport, installPeerHostConnectionRouting } from '../src/client/features/peer-host.js'
import { createPeerHostFeature } from '../src/host/features/peer-host.js'
import { PeerHostWebSocketGateway } from '../src/host/modules/peer-host/peer-host-ws-gateway.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { CODINGNS_VERSION, DSH_VERSION } from '../src/shared/contracts/version.js'
import { createVirtualSessionId, type AggregateHostResult } from '../src/shared/contracts/peer-host.js'

/** 串起页面分流、代理 Host、目标 Host 和 Gateway；网络与监听全部使用内存夹具。 */
test('远程消息反馈可读取、保存和删除，同名会话按 Host 隔离，本机反馈保持本机', async t => {
  t.mock.method(PeerHostWebSocketGateway.prototype, 'start', async () => ({ host: '127.0.0.1', port: 0, path: '/test' }))
  const directory = await mkdtemp(join(process.cwd(), 'data/test-runs/peer-feedback-'))
  const previousFetch = globalThis.fetch
  const hosts = new Map<string, CodingNsRpcTable>()
  const disposers: Array<() => void | Promise<void>> = []
  const calls: Array<{ host: string; endpoint: string; request: any }> = []
  const localCalls: string[] = []
  const aggregates: AggregateHostResult[] = []
  let restoreConnection: (() => void) | undefined
  let transport: ReturnType<typeof createPeerHostPageTransport> | undefined
  let gatewayFailure = false

  async function invoke(table: CodingNsRpcTable, endpoint: string, payload: unknown, signal?: AbortSignal) {
    const route = table.resolve(endpoint)
    assert.ok(route, endpoint)
    return route.handler(route.action, payload, { signal })
  }

  async function respond(table: CodingNsRpcTable, body: string, signal?: AbortSignal) {
    const envelope = JSON.parse(body)
    try {
      return Response.json({ result: { ok: true, value: await invoke(table, envelope.method, envelope.payload, signal) } })
    } catch (error: any) {
      return Response.json({ result: { ok: false, error: { code: error.code ?? 'test/error', message: error.message } } })
    }
  }

  const fetchPeer: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/public/host-handshake') return Response.json({ productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: CODINGNS_VERSION, dshVersion: DSH_VERSION, apiCompatibility: 'peer-host-v1', fingerprint: `sha256:${url.hostname}`, capabilities: [] })
    if (url.pathname === '/api/auth/login') return Response.json({ accessToken: 'test-token', refreshToken: 'test-refresh', expiresIn: 3600 })
    assert.equal(url.pathname, '/api/codingns/peerHost/nativeLocal')
    const host = hosts.get(url.hostname)
    assert.ok(host, `禁止实际联网：${url.hostname}`)
    return respond(host, String(init?.body), init?.signal ?? undefined)
  }

  async function mount(name: string) {
    const table = new CodingNsRpcTable()
    const feedback = new Map<string, any>()
    const gateway = {
      async invoke({ namespace, method, args }: any) {
        const request = args.request
        calls.push({ host: name, endpoint: `${namespace}/${method}`, request })
        if (gatewayFailure) throw Object.assign(new Error('反馈存储不可用'), { code: 'feedback/storage-unavailable' })
        if (request.sessionId !== 'session-1') return { ok: false, error: { code: 'session-not-found', sessionId: request.sessionId } }
        if (namespace === 'sessionFeedback') return { ok: true, value: { recorded: true } }
        assert.equal(namespace, 'messageFeedback')
        if (method === 'list') return { ok: true, value: { items: [...feedback.values()] } }
        const current = feedback.get(request.messageId) ?? null
        if (request.ifVersion !== (current?.version ?? null)) return { ok: false, error: { code: 'version-conflict', current } }
        if (method === 'delete') {
          feedback.delete(request.messageId)
          return { ok: true, value: { absent: true } }
        }
        assert.equal(method, 'put')
        const item = { messageId: request.messageId, rating: request.rating, note: request.note, version: 'v1', createdAt: 1, updatedAt: 1 }
        feedback.set(request.messageId, item)
        return { ok: true, value: item }
      },
      stream: async () => (async function* () {})(),
    }
    await createPeerHostFeature({ stateDirectory: join(directory, name), ownerUserId: 'local', encryptionKey: new Uint8Array(32).fill(5), fetchImpl: fetchPeer }).start({
      services: { rpc: table, dshContext: { get: (key: string) => key === 'typertGateway' ? gateway : undefined } },
      resources: { add: (dispose: () => void | Promise<void>) => disposers.push(dispose) },
    } as never)
    hosts.set(`${name}.test`, table)
    return table
  }

  try {
    await mount('a')
    await mount('b')
    const local = await mount('local')
    const ids: string[] = []
    for (const name of ['a', 'b']) {
      const created = await invoke(local, 'peerHost/create', { displayName: name, route: { kind: 'lan', baseUrl: `http://${name}.test`, normalizedOrigin: '' } }) as any
      const peer = await invoke(local, 'peerHost/update', { peerHostId: created.id, username: 'test', password: 'test' }) as any
      assert.equal(peer.status, 'ready')
      ids.push(createVirtualSessionId(peer.id, 'session-1'))
      aggregates.push({
        hostId: 'local', targetHostId: peer.id, hostLabel: name, availability: 'ready', errorCode: null,
        workspaces: [{ key: `${peer.id}:w`, hostId: 'local', targetHostId: peer.id, workspaceId: 'w', path: '/repo', displayName: name, hostLabel: name, availability: 'ready', sessions: [{
          scope: { hostId: 'local', targetHostId: peer.id, workspaceId: 'w', sessionId: 'session-1', scopeGeneration: 0 },
          title: '远端会话', status: 'idle', updatedAt: 1,
        }] }],
      })
    }
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), '/codingns/peerHost/native', '远程反馈不能回落到本机反馈接口')
      return respond(local, String(init?.body), init?.signal ?? undefined)
    }
    transport = createPeerHostPageTransport()
    transport.setAggregate(aggregates)
    const rpc = { call: async (_channel: string, endpoint: string, _payload: unknown): Promise<any> => {
      localCalls.push(endpoint)
      return { ok: true, value: { ok: true, value: '本机反馈' } }
    } }
    restoreConnection = installPeerHostConnectionRouting({
      uiContext: { get: key => key === 'connection' ? { rpc } : undefined },
      remote: { openRemoteStream: () => (async function* () {})() },
      hooks: transport.hooks, matchesScope: transport.matchesScope,
    })
    assert.ok(restoreConnection)
    const payload = (request: unknown) => ({ args: { request } })
    const call = (endpoint: string, request: unknown) => rpc.call('/api', endpoint, payload(request))
    const a = ids[0]!
    const b = ids[1]!

    assert.deepEqual(await call('messageFeedback/list', { sessionId: a }), { ok: true, value: { ok: true, value: { items: [] } } })
    assert.equal(calls.at(-1)?.host, 'a')
    // messageId 与 note 故意包含另一台 Host 的虚拟会话 ID；它们不能决定路由或被改写。
    const saved = await call('messageFeedback/put', { messageId: b, note: b, sessionId: a, rating: 'positive', ifVersion: null })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.ok, true)
    assert.equal(saved.value.value.messageId, b)
    assert.equal(saved.value.value.note, b)
    assert.equal(calls.at(-1)?.host, 'a')
    assert.equal(calls.at(-1)?.request.sessionId, 'session-1')
    assert.deepEqual((await call('messageFeedback/list', { sessionId: a })).value.value.items, [saved.value.value])
    assert.deepEqual((await call('messageFeedback/list', { sessionId: b })).value.value.items, [])
    assert.equal(calls.at(-1)?.host, 'b')

    const conflict = await call('messageFeedback/delete', { sessionId: a, messageId: b, ifVersion: 'stale' })
    assert.deepEqual(conflict, { ok: true, value: { ok: false, error: { code: 'version-conflict', current: saved.value.value } } })
    assert.deepEqual(await call('messageFeedback/delete', { sessionId: a, messageId: b, ifVersion: 'v1' }), { ok: true, value: { ok: true, value: { absent: true } } })
    assert.deepEqual((await call('messageFeedback/list', { sessionId: a })).value.value.items, [])
    assert.deepEqual(await call('sessionFeedback/record', { text: b, sessionId: a }), { ok: true, value: { ok: true, value: { recorded: true } } })
    assert.equal(calls.at(-1)?.host, 'a')
    assert.equal(calls.at(-1)?.request.text, b)

    gatewayFailure = true
    assert.deepEqual(await call('messageFeedback/list', { sessionId: a }), { ok: false, error: { code: 'feedback/storage-unavailable', message: '反馈存储不可用' } })
    assert.deepEqual(localCalls, [])
    // 本机会话的反馈文字即使引用远端会话，也不能被转发到远端。
    for (const endpoint of ['messageFeedback/list', 'messageFeedback/put', 'messageFeedback/delete', 'sessionFeedback/record']) {
      assert.deepEqual(await call(endpoint, { note: a, text: a, sessionId: 'local-session' }), { ok: true, value: { ok: true, value: '本机反馈' } })
    }
    assert.equal(localCalls.length, 4)
  } finally {
    restoreConnection?.()
    transport?.dispose()
    globalThis.fetch = previousFetch
    for (const dispose of disposers.reverse()) await dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
