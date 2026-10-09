import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL,
  CODINGNS_BOOTSTRAP_DSH_VERSION,
  installDshPeerHostPrebootShim,
} from '../data/build/dist/bootstrap/index.js'
import { createPeerHostPageTransport, installPeerHostConnectionRouting } from '../data/build/dist/client/features/peer-host.js'
import { createVirtualSessionId } from '../data/build/dist/shared/index.js'
import { createNavigationFixture } from './peer-host-navigation-fixture.ts'

test('原生连接合并远端事件时仍复用本机 mux，远端审批结果按事件身份分流', async () => {
  const localCalls: string[] = []
  const peerCalls: string[] = []
  const controller = new AbortController()
  const rpc = { call: async (_channel: string, endpoint: string) => { localCalls.push(endpoint); return { ok: true, value: true } } }
  let localSignal: AbortSignal | undefined
  const remote = { openRemoteStream: (_endpoint: string, _payload: unknown, signal?: AbortSignal) => {
    localSignal = signal
    return (async function* () { yield { type: 'ready', clientId: 'local' } })()
  } }
  const route = installPeerHostConnectionRouting({
    uiContext: { get: () => ({ rpc }) }, remote,
    hooks: { rpc: async ({ method }) => { peerCalls.push(method); return { ok: true, value: true } as never } },
    matchesScope: (value, method) => method === '$events/result' && (value as any)?.args?.eventId === 'peer-event',
    mergeEvents: (local, signal) => local(signal!),
  })!
  try {
    assert.deepEqual(await Array.fromAsync(remote.openRemoteStream('$events', { args: {} }, controller.signal)), [{ type: 'ready', clientId: 'local' }])
    assert.equal(localSignal, controller.signal)
    assert.equal(Object.hasOwn(rpc, 'open'), false)
    await rpc.call('/api', '$events/result', { args: { eventId: 'peer-event' } })
    await rpc.call('/api', '$events/result', { args: { eventId: 'local-event' } })
    assert.deepEqual(peerCalls, ['$events/result'])
    assert.deepEqual(localCalls, ['$events/result'])
  } finally { route() }
})

type ShimGlobal = typeof globalThis & {
  __DSH_TRANSPORT__?: unknown
  dshDesktopBoot?: unknown
  [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: { getMode: () => string; dispose: () => void }
}

/** Desktop 真实顺序：前端 Bundle 先直接赋值 Transport，注入脚本行之后才执行。 */
async function withDesktopPage(run: (facade: Record<string, unknown>) => void | Promise<void>): Promise<void> {
  const globals = globalThis as ShimGlobal
  const hadDesktop = Object.hasOwn(globals, 'dshDesktopBoot')
  const hadTransport = Object.hasOwn(globals, '__DSH_TRANSPORT__')
  globals.dshDesktopBoot = {}
  globals.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:13082' }
  const shim = installDshPeerHostPrebootShim({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION })
  try {
    assert.equal(shim.getMode(), 'desktop')
    await run(globals.__DSH_TRANSPORT__ as Record<string, unknown>)
  } finally {
    shim.dispose()
    if (!hadDesktop) delete globals.dshDesktopBoot
    if (!hadTransport) delete globals.__DSH_TRANSPORT__
  }
}

function remoteWorkspaceAggregate(): unknown[] {
  return [{
    hostId: 'host-local',
    targetHostId: 'peer-1',
    hostLabel: '开发机',
    availability: 'ready',
    errorCode: null,
    workspaces: [{
      key: 'peer-1:workspace-1',
      hostId: 'host-local',
      targetHostId: 'peer-1',
      workspaceId: 'workspace-1',
      displayName: '远端工作区',
      hostLabel: '开发机',
      availability: 'ready',
      sessions: [{
        scope: { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
        title: '远端会话',
        status: 'idle',
        updatedAt: 10,
      }],
    }],
  }]
}

test('Desktop Transport 被访问器接管后仍保留 streamBaseUrl，且不提供 rpc/openStream', async () => {
  await withDesktopPage((facade) => {
    assert.equal(facade.ownsHost, true)
    // 聚合流基址必须透传，否则 `/api/remote.mux` 会退回 document.baseURI。
    assert.equal(facade.streamBaseUrl, 'http://127.0.0.1:13082')
    // 关键约束：Desktop 分支不提供 rpc/openStream，DSH 才会继续创建原生
    // `createWebConnectionRpc`，并在 `connection.rpc.open === void 0` 时启动 Remote mux。
    assert.equal(facade.rpc, undefined)
    assert.equal(facade.openStream, undefined)
    // 运行时再赋值时 setter 接管，facade 身份稳定。
    const before = facade
    ;(globalThis as ShimGlobal).__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:9999' }
    assert.equal((globalThis as ShimGlobal).__DSH_TRANSPORT__, before)
    assert.equal(facade.streamBaseUrl, 'http://127.0.0.1:9999')
  })
})

test('Desktop 聚合路由分流远端请求，本机调用原样委派原生实现', async () => {
  await withDesktopPage(async () => {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(remoteWorkspaceAggregate() as never)

    const nativeCalls: { channel: string; endpoint: string; payload: unknown }[] = []
    const rpc = {
      call: async (channel: string, endpoint: string, payload: unknown) => {
        nativeCalls.push({ channel, endpoint, payload })
        return { ok: true, value: { items: [{ sessionId: 'local-1' }] } }
      },
    }
    const localOpens: string[] = []
    const remote = {
      openRemoteStream: (endpoint: string) => {
        localOpens.push(endpoint)
        return (async function* () { yield { local: true } })()
      },
    }
    const hooks = {
      rpc: async ({ method, payload }: { method: string; payload: { channel: string; payload: unknown } }) => ({
        ok: true,
        value: { routed: method, channel: payload.channel },
      }),
      openStream: ({ method }: { method: string }) => (async function* () { yield { routed: method } })(),
    }
    const matchesScope = (value: unknown): boolean => JSON.stringify(value ?? null).includes('virtual')

    const route = installPeerHostConnectionRouting({
      uiContext: { get: (name: string) => (name === 'connection' ? { rpc } : undefined) },
      remote,
      hooks,
      matchesScope,
    })
    assert.equal(typeof route, 'function')

    // 远端作用域的本机 `/api` 原生方法走聚合 Transport。
    const peer = await rpc.call('/api', 'session/list', { args: { workspaceId: 'virtual' } })
    assert.deepEqual(peer, { ok: true, value: { routed: 'session/list', channel: '/api' } })
    assert.equal(nativeCalls.length, 0)

    // 本机 session/list 委派原生实现，并保持结果形状不变（未注入装饰时原样返回）。
    const local = await rpc.call('/api', 'session/list', { args: {} })
    assert.deepEqual(local, { ok: true, value: { items: [{ sessionId: 'local-1' }] } })
    assert.deepEqual(nativeCalls, [{ channel: '/api', endpoint: 'session/list', payload: { args: {} } }])

    // 非 `/api` 通道永不分流。
    await rpc.call('/codingns', 'peerHost/request', { id: 1 })
    assert.equal(nativeCalls.length, 2)

    // 远端流走聚合 Transport；本机流原样落回 DSH 自己的 openRemoteStream。
    const peerStream = remote.openRemoteStream('session/follow', { args: { sessionId: 'virtual' } }) as AsyncIterable<unknown>
    const peerItems: unknown[] = []
    for await (const item of peerStream) peerItems.push(item)
    assert.deepEqual(peerItems, [{ routed: 'session/follow' }])
    assert.deepEqual(localOpens, [])

    const localStream = remote.openRemoteStream('session/follow', { args: { sessionId: 'local-1' } }) as AsyncIterable<unknown>
    const localItems: unknown[] = []
    for await (const item of localStream) localItems.push(item)
    assert.deepEqual(localItems, [{ local: true }])
    assert.deepEqual(localOpens, ['session/follow'])

    // 关键：分流不能以定义 `connection.rpc.open` 为代价，否则网关会跳过 mux 启动/重连。
    assert.equal(Object.hasOwn(rpc, 'open'), false)

    route!()
    assert.equal(Object.hasOwn(rpc, 'open'), false)
    assert.equal(remote.openRemoteStream.toString().includes('hooks'), false)
  })
})

test('Desktop 路由只装饰本机 session/list，最终仍还原 Remote 服务方法', async () => {
  await withDesktopPage(async () => {
    const transport = createPeerHostPageTransport()
    const rpc = { call: async () => ({ ok: true, value: { items: [] } }) }
    const originalOpen = function * (): Generator<unknown> { yield 'native' }
    const remote = { openRemoteStream: originalOpen as unknown as (...args: unknown[]) => unknown }
    const route = installPeerHostConnectionRouting({
      uiContext: { get: () => ({ rpc }) },
      remote,
      hooks: {},
      matchesScope: () => false,
      decorateLocalResult: (_method, result) => ({ ...(result as Record<string, unknown>), decorated: true }),
    })
    const decorated = await rpc.call('/api', 'session/list', { args: {} }) as Record<string, unknown>
    assert.equal(decorated.decorated, true)

    route!()
    assert.equal(remote.openRemoteStream, originalOpen)
  })
})

test('缺少 Remote 服务时不安装 Desktop 路由，避免半接管', async () => {
  await withDesktopPage(async () => {
    const rpc = { call: async () => ({ ok: true, value: null }) }
    const route = installPeerHostConnectionRouting({
      uiContext: { get: () => ({ rpc }) },
      hooks: {},
      matchesScope: () => true,
    })
    assert.equal(route, undefined)
  })
})

test('Desktop 本机基线与终端流保留原生上行通道、取消信号和连接选项', async () => {
  await withDesktopPage(async () => {
    const calls: unknown[][] = []
    const rpc = { call: async () => ({ ok: true, value: null }) }
    const originalOpen = (...args: unknown[]) => {
      calls.push(args)
      return (async function* () { yield { native: true } })()
    }
    const remote = { openRemoteStream: originalOpen }
    const navigation = createNavigationFixture({ sessionId: createVirtualSessionId('peer-1', 'session-1') })
    navigation.services.set('connection', { rpc })
    const transport = createPeerHostPageTransport(undefined, navigation.context)
    transport.setAggregate(remoteWorkspaceAggregate() as never)
    const restore = installPeerHostConnectionRouting({
      uiContext: navigation.context, remote, hooks: transport.hooks, matchesScope: transport.matchesScope,
    })!
    const signal = new AbortController().signal
    const uplink = (async function* () { yield new Uint8Array([1, 2]) })()
    try {
      for (const method of ['$events', 'session/follow', 'terminal/follow']) {
        const payload = { args: { sessionId: 'local-session' } }
        const stream = remote.openRemoteStream(method, payload, signal, uplink, 'keep-native')
        const frames: unknown[] = []
        for await (const frame of stream) frames.push(frame)
        assert.deepEqual(frames, [{ native: true }])
        const call = calls.at(-1)!
        assert.equal(call[0], method)
        assert.equal(call[1], payload)
        assert.equal(call[2], signal)
        assert.equal(call[3], uplink)
        assert.equal(call[4], 'keep-native')
      }
      assert.equal(Object.hasOwn(rpc, 'open'), false)
    } finally {
      restore()
    }
    assert.equal(remote.openRemoteStream, originalOpen)
  })
})
