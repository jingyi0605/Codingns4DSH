import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPeerHostPageTransport, installPeerHostConnectionRouting } from '../src/client/features/peer-host.js'
import { DebugWorkspaceService } from '../src/host/debug.js'
import { createDebugFeature } from '../src/host/features/debug.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { LanAccessDshProxy, createLoginProtectionConfig, type ParsedLanRequest } from '../src/host/lan-access-dsh.js'
import { PeerHostHttpProxyService } from '../src/host/modules/peer-host/host-api-proxy-service.js'
import { PeerHostSessionError } from '../src/host/modules/peer-host/peer-host-session.js'
import { InMemoryPeerHostCredentialStore, InMemoryPeerHostRecordStore, PeerHostStore } from '../src/host/modules/peer-host/peer-host-store.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'

const workspaceId = createVirtualWorkspaceId('peer-1', 'workspace-1')
const sessionId = createVirtualSessionId('peer-1', 'session-1')
const scope = { sessionId, workspaceId, generation: 0 }
const profile = {
  id: 'frontend', name: '远端前端', cwdRelative: '.', command: 'node', args: [sessionId],
  env: { workspaceId, sessionId },
  shell: { profileId: 'bash', path: '/bin/bash', args: ['-i'], name: 'bash' },
  runtimeType: 'local-pty', port: 5173, proxy: { enabled: true },
}

/** 回放页面分流、Host 白名单和目标 Debug RPC；网络与终端均为夹具，不启动真实服务。 */
async function withRemoteDebug(run: (fixture: {
  root: string
  calls: { endpoint: string; payload: any }[]
  localCalls: string[]
  rejectToken(): void
  call(endpoint: string, payload?: unknown, channel?: string): Promise<any>
  pageCall(endpoint: string, payload?: unknown): Promise<any>
}) => Promise<void>, options: { legacyDebugAuth?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'peer-host-debug-'))
  const originalFetch = globalThis.fetch
  const calls: { endpoint: string; payload: any }[] = []
  const localCalls: string[] = []
  const resources: (() => void)[] = []
  let restoreConnection: (() => void) | undefined
  try {
    const table = new CodingNsRpcTable()
    const service = new DebugWorkspaceService({
      // 虚拟 ID 到达真实服务会重现“Workspace 根目录不可用”。
      resolveWorkspaceRoot: id => id === 'workspace-1' ? root : null,
      terminalProcesses: {
        listInstances: () => [],
        deleteProfile: async () => true,
        createProfile: async () => profile,
        launch: async (input: unknown) => ({ instance: { id: 'runtime-1', input }, terminal: { id: 'terminal-1' } }),
      } as never,
      portInspector: { inspect: async () => null, terminate: async () => { throw new Error('不应结束真实进程') } },
    })
    await createDebugFeature().start({ services: { rpc: table, debug: service }, resources: { add: (dispose: () => void) => resources.push(dispose) } } as never)
    const store = new PeerHostStore('owner', new InMemoryPeerHostRecordStore(), new InMemoryPeerHostCredentialStore(), () => 100, () => 'peer-1')
    await store.create({ displayName: '远端开发机', route: { kind: 'lan', baseUrl: 'http://remote.test', normalizedOrigin: '' } })
    await store.updateStatus('peer-1', 'ready', null)
    // 直接调用真实 LAN 鉴权边界，不启动监听、不读取任何已有 Profile。
    const lan = new LanAccessDshProxy({} as never)
    lan.setLoginConfig(createLoginProtectionConfig({ username: 'test-user', password: 'test-password', timeoutSeconds: 1800, scopes: { lan: true, relay: true } }))
    const authorize = (request: ParsedLanRequest) => (lan as unknown as {
      authorize(request: ParsedLanRequest, local: boolean, socket: unknown): Uint8Array | 'pass'
    }).authorize(request, false, { remoteAddress: '192.0.2.1' })
    const login = authorize({ method: 'POST', path: '/api/auth/login', headers: {}, body: Buffer.from(JSON.stringify({ username: 'test-user', password: 'test-password' })) })
    assert.notEqual(login, 'pass')
    let accessToken = JSON.parse(Buffer.from(login as Uint8Array).toString().split('\r\n\r\n')[1]!).accessToken as string
    const proxy = new PeerHostHttpProxyService(store, {
      getAccessToken: async () => accessToken,
      recoverAccessToken: async () => { throw new PeerHostSessionError('PEER_HOST_SESSION_REQUIRED', '目标票据失效') },
    } as never, {
      fetchImpl: async (input, init) => {
        assert.equal(new URL(String(input)).origin, 'http://remote.test')
        const path = new URL(String(input)).pathname
        const headers = new Headers(init?.headers)
        // 回放旧 LAN 白名单：调试路径未识别为 PeerHost 请求，Bearer 被忽略后落入 Cookie 校验。
        if (options.legacyDebugAuth && path.startsWith('/api/codingns/debug/')) headers.delete('authorization')
        const authorized = authorize({
          method: init?.method ?? 'GET', path,
          headers: Object.fromEntries(headers), body: Buffer.from(String(init?.body)),
        })
        if (authorized !== 'pass') {
          const status = Number(/^HTTP\/1\.1 (\d+)/u.exec(Buffer.from(authorized).toString())?.[1])
          return new Response('目标 LAN 登录保护拒绝请求', { status })
        }
        const request = JSON.parse(String(init?.body))
        if (request.method === 'host/status') return Response.json({ result: { ok: true, value: {} } })
        calls.push({ endpoint: request.method, payload: request.payload })
        assert.equal(new URL(String(input)).pathname, `/api/codingns/${request.method}`)
        if (request.method === 'terminal/status') return Response.json({ result: { ok: true, value: { platform: 'linux' } } })
        const target = table.resolve(request.method)!
        try { return Response.json({ result: { ok: true, value: await target.handler(target.action, request.payload) } }) }
        catch (error) { return Response.json({ result: { ok: false, error: { code: 'REMOTE_DEBUG_ERROR', message: (error as Error).message } } }) }
      },
    })
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), '/codingns/peerHost/request')
      const request = JSON.parse(String(init?.body)).payload
      assert.equal(request.peerHostId, 'peer-1')
      return Response.json({ result: { ok: true, value: await proxy.request(request.peerHostId, request) } })
    }
    const transport = createPeerHostPageTransport()
    transport.setAggregate([{
      hostId: 'host-local', targetHostId: 'peer-1', hostLabel: '远端', availability: 'ready', errorCode: null,
      workspaces: [{ workspaceId: 'workspace-1', displayName: '远端项目', sessions: [{
        scope: { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
        title: '远端会话', status: 'idle', updatedAt: 1,
      }] }],
    }] as never)
    const rpc = { call: async (_channel: string, endpoint: string, _payload: unknown): Promise<any> => {
      localCalls.push(endpoint)
      return { ok: true, value: '本机结果' }
    } }
    restoreConnection = installPeerHostConnectionRouting({
      uiContext: { get: name => name === 'connection' ? { rpc } : undefined },
      remote: { openRemoteStream: () => (async function* () {})() },
      hooks: transport.hooks, matchesScope: transport.matchesScope,
    })
    assert.ok(restoreConnection)
    await run({
      root, calls, localCalls, rejectToken: () => { accessToken = 'forged-ticket' },
      call: (endpoint, payload = scope, channel = '/codingns') => rpc.call(channel, endpoint, payload),
      pageCall: (endpoint, payload = scope) => transport.hooks.rpc!({ method: endpoint, payload: { channel: '/codingns', payload } }),
    })
  } finally {
    restoreConnection?.()
    for (const dispose of resources.reverse()) dispose()
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
}

test('PeerHost 调试通过目标根目录读写配置，页面与原生连接通道一致', async () => {
  await withRemoteDebug(async fixture => {
    const config = { version: 1, profiles: [profile] }
    assert.equal((await fixture.call('debug/config/save', { ...scope, config })).ok, true)
    const saved = JSON.parse(await readFile(join(fixture.root, '.codingns', 'debug.json'), 'utf8'))
    // 即使配置正文包含虚拟 ID，也不能被资源标识改写误伤。
    assert.deepEqual(saved.profiles[0].args, [sessionId])
    assert.deepEqual(saved.profiles[0].env, { workspaceId, sessionId })
    const loaded = await fixture.pageCall('debug/config/get')
    assert.equal(loaded.value.profiles[0].name, '远端前端')
    assert.deepEqual(await fixture.call('codingns/debug/config/get', scope, '/api'), loaded)
    await fixture.call('debug/config/update', { ...scope, profileId: profile.id, profile: { ...profile, name: '更新后' } })
    assert.equal((await fixture.call('debug/profile/list')).value[0].name, '更新后')
    await fixture.call('debug/config/delete', { ...scope, profileId: profile.id })
    assert.deepEqual((await fixture.call('debug/config/get')).value.profiles, [])
    for (const call of fixture.calls) {
      assert.equal(call.payload.workspaceId, 'workspace-1')
      assert.equal(call.payload.sessionId, 'session-1')
    }
    assert.deepEqual(fixture.localCalls, [])
  })
})

test('远端 LAN 拒绝无效票据时保留认证错误码和原因，不执行调试业务', async () => {
  await withRemoteDebug(async fixture => {
    fixture.rejectToken()
    const result = await fixture.call('debug/config/get')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'PEER_HOST_SESSION_REQUIRED')
    assert.equal(result.error.message, '目标 Host 登录态已失效')
    assert.deepEqual(fixture.calls, [])
    assert.deepEqual(fixture.localCalls, [])
  })
})

test('旧版目标未放行调试接口时提示接口权限，正常票据仍可用于其它接口', async () => {
  await withRemoteDebug(async fixture => {
    const result = await fixture.call('debug/config/get')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'PEER_HOST_PROXY_ACCESS_DENIED')
    assert.match(result.error.message, /登录有效/u)
    assert.deepEqual(fixture.calls, [])
    assert.equal((await fixture.call('terminal/status')).ok, true)
    assert.deepEqual(fixture.localCalls, [])
  }, { legacyDebugAuth: true })
})

test('远端调试启动、端口和 Shell 查询均使用目标作用域', async () => {
  await withRemoteDebug(async fixture => {
    await fixture.call('debug/config/save', { ...scope, config: { version: 1, profiles: [profile] } })
    const launched = await fixture.call('debug/profile/launch', { ...scope, dshSessionId: sessionId, profileId: profile.id, cols: 80, rows: 24 })
    assert.equal(launched.ok, true)
    assert.equal(launched.value.instance.input.workspaceId, 'workspace-1')
    assert.equal(launched.value.instance.input.dshSessionId, 'session-1')
    assert.deepEqual((await fixture.call('debug/runtime/list')).value, [])
    const port = await fixture.call('debug/port/check', { ...scope, profileId: profile.id })
    assert.equal(port.value.workspaceId, 'workspace-1')
    assert.equal(port.value.listening, false)
    assert.equal((await fixture.call('terminal/status')).value.platform, 'linux')
    assert.deepEqual(fixture.localCalls, [])
  })
})

test('本机调试和无作用域 Shell 查询保留原调用，远端业务失败不回退本机', async () => {
  await withRemoteDebug(async fixture => {
    const local = { sessionId: 'session-1', workspaceId: 'workspace-1', generation: 0 }
    assert.equal((await fixture.call('debug/config/get', local)).value, '本机结果')
    assert.equal((await fixture.call('debug/config/save', { ...local, config: { version: 1, profiles: [profile] } })).value, '本机结果')
    assert.equal((await fixture.call('terminal/status', {})).value, '本机结果')
    const failed = await fixture.call('debug/config/update', { ...scope, profileId: 'missing', profile })
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'REMOTE_DEBUG_ERROR')
    assert.match(failed.error.message, /配置项不存在/u)
    const callsBefore = fixture.calls.length
    const mismatch = await fixture.call('debug/config/get', { ...scope, workspaceId: createVirtualWorkspaceId('peer-2', 'workspace-1') })
    assert.equal(mismatch.ok, false)
    assert.match(mismatch.error.message, /作用域不一致/u)
    assert.equal(fixture.calls.length, callsBefore)
    const missing = await fixture.call('debug/config/get', {
      ...scope, sessionId: createVirtualSessionId('missing-peer', 'session-1'), workspaceId: createVirtualWorkspaceId('missing-peer', 'workspace-1'),
    })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'PEER_HOST_SCOPE_MISMATCH')
    assert.equal(fixture.calls.length, callsBefore)
    assert.deepEqual(fixture.localCalls, ['debug/config/get', 'debug/config/save', 'terminal/status'])
  })
})
