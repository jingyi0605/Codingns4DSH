import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createPeerHostFeature } from '../data/build/dist/host/features/peer-host.js'
import { createPeerHostPageTransport } from '../data/build/dist/client/features/peer-host.js'
import { PeerHostWebSocketGateway } from '../data/build/dist/host/modules/peer-host/peer-host-ws-gateway.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { CODINGNS_VERSION, DSH_VERSION } from '../data/build/dist/shared/contracts/version.js'
import { createVirtualSessionId } from '../data/build/dist/shared/index.js'

/** 用真正的两端 Feature/RPC/流注册表串起客户端，所有网络和监听入口都替换成内存实现。 */
test('远端审批、提问、计划确认经两层 Host 转发到原生事件帧，答案回到正确 Host', { timeout: 8000 }, async t => {
  t.mock.method(PeerHostWebSocketGateway.prototype, 'start', async () => ({ host: '127.0.0.1', port: 0, path: '/test' }))
  const directory = await mkdtemp(join(process.cwd(), 'data/test-runs/peer-interactions-'))
  const hosts = new Map<string, CodingNsRpcTable>()
  const disposers: Array<() => void | Promise<void>> = []
  const replies: Array<{ host: string; args: any }> = []
  const questions: Array<{ host: string; args: any }> = []
  const eventSignals: AbortSignal[] = []
  const previousFetch = globalThis.fetch
  const previousSocket = globalThis.WebSocket
  const controller = new AbortController()
  let transport: ReturnType<typeof createPeerHostPageTransport> | undefined
  let iterator: AsyncIterator<unknown> | undefined

  async function invoke(table: CodingNsRpcTable, method: string, payload: unknown, signal?: AbortSignal) {
    const route = table.resolve(method)
    assert.ok(route, method)
    return route.handler(route.action, payload, { signal })
  }
  async function response(table: CodingNsRpcTable, body: string, signal?: AbortSignal) {
    const request = JSON.parse(body)
    try {
      // 模拟 HTTP 取消：取消请求不等于销毁服务端句柄，后续 Close 才释放整条流。
      const value = await abortable(Promise.resolve(invoke(table, request.method, request.payload, signal)), signal)
      return Response.json({ result: { ok: true, value } })
    } catch (error: any) {
      if (signal?.aborted) throw error
      return Response.json({ result: { ok: false, error: { code: error.code ?? 'test/error', message: error.message } } })
    }
  }
  const fetchPeer: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/public/host-handshake') return Response.json({ productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: CODINGNS_VERSION, dshVersion: DSH_VERSION, apiCompatibility: 'peer-host-v1', fingerprint: `sha256:${url.hostname}`, capabilities: [] })
    if (url.pathname === '/api/auth/login') return Response.json({ accessToken: 'test-token', refreshToken: 'test-refresh', expiresIn: 3600 })
    const host = hosts.get(url.hostname)
    assert.ok(host, `禁止实际联网：${url.hostname}`)
    return response(host, String(init?.body), init?.signal ?? undefined)
  }
  async function mount(name: string) {
    const rpc = new CodingNsRpcTable()
    const gateway = {
      async invoke({ namespace, method, args }: any) {
        assert.equal(namespace, 'userQuestions')
        assert.equal(method, 'answer')
        questions.push({ host: name, args })
        return true
      },
      async stream({ namespace, method, args }: any) {
        assert.equal(namespace, 'userQuestions')
        assert.equal(method, 'attachWait')
        assert.equal(args.agentId, 'session-1')
        return (async function* () { yield { remainingMs: 1250 } })()
      },
      wireStream: { async open(endpoint: string, payload: unknown, _uplink: unknown, _peer: unknown, signal: AbortSignal) {
        assert.equal(endpoint, '$events')
        assert.deepEqual(payload, { args: {} })
        eventSignals.push(signal)
        return (async function* () {
          yield { type: 'ready', clientId: `client-${name}`, host: { home: '/remote' } }
          yield { type: 'waterfall', event: 'approval/request', eventId: 'same-approval', agentId: 'session-1', request: { toolName: 'exec', reason: '模拟权限申请' } }
          yield { type: 'waterfall', event: 'user-questions/request', eventId: 'same-question', agentId: 'session-1', request: { questions: [{ id: 'plan', question: '是否继续？', intent: { kind: 'plan-review', approve: '继续' } }] } }
          if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        })()
      } },
    }
    const connection = { createSharedFetchHandler: () => ({ async fetch(request: Request) {
      const envelope = await request.json() as any
      assert.equal(envelope.method, '$events/result')
      replies.push({ host: name, args: envelope.payload.args })
      return Response.json({ result: { ok: true } })
    } }) }
    await createPeerHostFeature({ stateDirectory: join(directory, name), ownerUserId: 'local', encryptionKey: new Uint8Array(32).fill(5), fetchImpl: fetchPeer }).start({
      services: { rpc, dshContext: { get: (key: string) => key === 'typertGateway' ? gateway : key === 'connection' ? connection : undefined } },
      resources: { add: (dispose: () => void | Promise<void>) => disposers.push(dispose) },
    } as never)
    hosts.set(`${name}.test`, rpc)
    return rpc
  }
  try {
    await mount('a')
    await mount('b')
    const local = await mount('local')
    const aggregates: any[] = []
    const labels = new Map<string, string>()
    for (const name of ['a', 'b']) {
      const created = await invoke(local, 'peerHost/create', { displayName: name, route: { kind: 'lan', baseUrl: `http://${name}.test`, normalizedOrigin: '' } }) as any
      const peer = await invoke(local, 'peerHost/update', { peerHostId: created.id, username: 'test', password: 'test' }) as any
      assert.equal(peer.status, 'ready')
      labels.set(peer.id, name)
      aggregates.push({ hostId: 'local', targetHostId: peer.id, hostLabel: name, availability: 'ready', errorCode: null, workspaces: [{ key: `${peer.id}:w`, hostId: 'local', targetHostId: peer.id, workspaceId: 'w', displayName: name, hostLabel: name, availability: 'ready', sessions: [{ scope: { hostId: 'local', targetHostId: peer.id, workspaceId: 'w', sessionId: 'session-1', scopeGeneration: 0 }, title: '模拟远端', status: 'active', updatedAt: 1 }] }] })
    }
    globalThis.fetch = async (_input, init) => response(local, String(init?.body), init?.signal ?? undefined)
    class Socket extends EventTarget {
      constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
      send(raw: string) {
        const request = JSON.parse(raw)
        assert.equal(request.endpoint, '$events')
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'ready', clientId: 'local-client', host: { home: '/local' } } }) })))
      }
      close() { this.dispatchEvent(new Event('close')) }
    }
    globalThis.WebSocket = Socket as never
    transport = createPeerHostPageTransport()
    transport.setAggregate(aggregates)
    iterator = transport.hooks.openStream!({ method: '$events', payload: { channel: '/api', payload: { args: {} } }, signal: controller.signal })[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.clientId, 'local-client')
    const frames: any[] = []
    for (let i = 0; i < 4; i++) frames.push((await iterator.next()).value)
    assert.equal(new Set(frames.map(frame => frame.eventId)).size, 4)
    for (const frame of frames) {
      const peerId = [...labels.keys()].find(id => frame.agentId === createVirtualSessionId(id, 'session-1'))!
      assert.ok(peerId)
      const answer = frame.event === 'approval/request' ? 'approved' : { answers: [{ id: 'plan', selected: ['继续'] }] }
      const result = await transport.hooks.rpc!({ method: '$events/result', payload: { channel: '/api', payload: { args: { clientId: 'local-client', eventId: frame.eventId, outcome: { kind: 'result', value: answer } } } } }) as any
      assert.equal(result.ok, true)
      assert.equal(replies.at(-1)!.host, labels.get(peerId))
      assert.equal(replies.at(-1)!.args.clientId, `client-${labels.get(peerId)}`)
      assert.equal(replies.at(-1)!.args.eventId, frame.event === 'approval/request' ? 'same-approval' : 'same-question')
    }
    const peerId = [...labels.keys()][0]!
    const args = { agentId: createVirtualSessionId(peerId, 'session-1'), callId: 'tool-question' }
    const answer = await transport.hooks.rpc!({ method: 'userQuestions/answer', payload: { channel: '/api', payload: { args: { ...args, answer: { answers: [] } } } } }) as any
    assert.equal(answer.ok, true)
    assert.equal(questions.at(-1)!.args.agentId, 'session-1')
    assert.equal(questions.at(-1)!.args.callId, 'tool-question')
    const waiting = transport.hooks.openStream!({ method: 'userQuestions/attachWait', payload: { channel: '/api', payload: { args } } })
    assert.deepEqual(await Array.fromAsync(waiting), [{ remainingMs: 1250 }])
  } finally {
    controller.abort()
    await iterator?.return?.()
    transport?.dispose()
    globalThis.fetch = previousFetch
    globalThis.WebSocket = previousSocket
    for (const dispose of disposers.reverse()) await dispose()
    assert.ok(eventSignals.every(signal => signal.aborted))
    await rm(directory, { recursive: true, force: true })
  }
})

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}
