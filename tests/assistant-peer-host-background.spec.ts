import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createPeerHostFeature } from '../src/host/features/peer-host.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import type { AssistantHostGateway, CodingNsHostServices } from '../src/host/features/types.js'
import { CODINGNS_VERSION } from '../src/shared/contracts/version.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'

async function gatewayFixture(t: TestContext) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'assistant-peer-background-'))
  const resources: Array<() => void | Promise<void>> = []
  const calls: { path: string; signal: AbortSignal | null | undefined }[] = []
  let holding = false
  let handshakesFail = false
  let observed!: () => void
  const started = new Promise<void>((resolve) => { observed = resolve })
  const rpc = new CodingNsRpcTable()
  const services: CodingNsHostServices = { rpc }
  const response = (value: unknown) => Response.json({ result: { ok: true, value } })
  const feature = createPeerHostFeature({
    stateDirectory, ownerUserId: 'local-host', encryptionKey: new Uint8Array(32).fill(7),
    fetchImpl: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      calls.push({ path, signal: init?.signal })
      if (path === '/api/public/host-handshake') {
        if (handshakesFail) throw new Error('测试远端不可达')
        return Response.json({ productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: CODINGNS_VERSION, dshVersion: '0.2.0-rc.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:test', capabilities: [] })
      }
      if (path === '/api/auth/login') return Response.json({ accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresIn: 3600 })
      if (holding && path.startsWith('/api/codingns/') && !path.endsWith('nativeStreamClose')) {
        assert.ok(init?.signal, '真实 fetch 必须收到后台取消信号')
        init.signal.throwIfAborted()
        observed()
        await new Promise<void>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
      }
      if (path.endsWith('nativeStreamOpen')) return response({ streamId: 'test-stream' })
      if (path.endsWith('nativeStreamNext')) return response({ done: false, value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } } })
      if (path.endsWith('nativeLocal')) return response({ items: [] })
      return response({})
    },
  })
  await feature.start({ services, resources: { add: (dispose: () => void | Promise<void>) => { resources.push(dispose) } } } as never)
  t.after(async () => { for (const dispose of resources.reverse()) await dispose(); await rm(stateDirectory, { recursive: true, force: true }) })
  const call = async (action: string, payload: unknown) => rpc.resolve(`peerHost/${action}`)!.handler(action, payload) as Promise<any>
  const route = { kind: 'lan', baseUrl: 'http://127.0.0.1:1', normalizedOrigin: '' }
  const peer = await call('create', { displayName: '测试远端', route })
  await call('update', { peerHostId: peer.id, displayName: '测试远端', route, username: 'fixture', password: 'fixture-password' })
  await call('setWorkspaceVisibility', { peerHostId: peer.id, workspaceId: 'remote-workspace', visible: true })
  calls.length = 0
  return { gateway: services.assistantGateway as AssistantHostGateway, calls, started, peer,
    scope: [createVirtualWorkspaceId(peer.id, 'remote-workspace')],
    hold: () => { holding = true },
    failHandshake: async () => { handshakesFail = true; await call('enable', { peerHostId: peer.id }) },
  }
}

test('助理只管理本地工作区时不扫描远端 Host，也不重复调用本地聚合来源', async (t) => {
  const f = await gatewayFixture(t)
  const result = await f.gateway.list(['local-workspace'], new AbortController().signal)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(result.sessions, [])
  assert.equal(result.volatile, false)
})

test('Gateway 取消到达实际 HTTP fetch，而不只让上层提前返回', async (t) => {
  const f = await gatewayFixture(t)
  f.hold()
  const controller = new AbortController()
  const pending = f.gateway.list(f.scope, controller.signal)
  const rejected = assert.rejects(pending, /测试取消/u)
  await f.started
  controller.abort(new Error('测试取消'))
  await rejected
  const requests = f.calls.filter((request) => request.path.startsWith('/api/codingns/') && !request.path.endsWith('nativeStreamClose'))
  assert.ok(requests.length > 0)
  assert.ok(requests.every((request) => request.signal?.aborted === true))
})

test('受管远端握手失败保留失败信号，供后台执行退避', async (t) => {
  const f = await gatewayFixture(t)
  await f.failHandshake()
  const result = await f.gateway.list(f.scope, new AbortController().signal)
  assert.equal(result.failed, true)
  assert.equal(result.volatile, true)
  assert.ok(result.warnings?.length)
})
