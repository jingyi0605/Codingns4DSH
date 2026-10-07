import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostPageTransport, installPeerHostConnectionRouting } from '../data/build/dist/client/features/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'
import { callCliRpc } from '../data/build/dist/client/cli-catalog.js'
import { loadModelCatalog } from '../data/build/dist/client/model-catalog-cache.js'
import { createNavigationFixture } from './peer-host-navigation-fixture.ts'

const peerSession = (host = 'stage0', session = 'session-1') => createVirtualSessionId(host, session)
const peerWorkspace = (host = 'stage0', workspace = 'workspace-1') => createVirtualWorkspaceId(host, workspace)
const catalog = (provider: string) => ({ groups: [{ id: provider, name: provider, models: [{ id: `${provider}-model`, name: provider }] }], failures: [] })
const providers = (result: unknown) => (result as { value: ReturnType<typeof catalog> }).value.groups.map(group => group.id)

/** 两个 PeerHost 提供不同模型，确保测试能识别串 Host，而不只断言成功信封。 */
function aggregate() {
  return ['stage0', 'mac'].map(host => ({
    hostId: 'desktop', targetHostId: host, hostLabel: host, availability: 'ready', errorCode: null,
    workspaces: ['workspace-1', 'workspace-2'].map(workspace => ({
      workspaceId: workspace, displayName: workspace,
      sessions: [{ scope: { hostId: 'desktop', targetHostId: host, workspaceId: workspace, sessionId: workspace === 'workspace-1' ? 'session-1' : 'session-2', scopeGeneration: 0 }, title: host, status: 'idle', updatedAt: 1 }],
    })),
  }))
}

interface RoutedCall { path: string; method: string; host: string | null; payload?: unknown; scope?: unknown }

/** 回放 Desktop Connection 的真实分流入口；不启动 Host，也不访问真实网络。 */
async function withDesktopNavigation(run: (page: ReturnType<typeof createNavigationFixture> & {
  transport: ReturnType<typeof createPeerHostPageTransport>
  call(method: string, payload?: unknown): Promise<unknown>
  cli(action: string, payload: unknown): Promise<unknown>
  models(adapterId: string, sessionId: string): Promise<ReturnType<typeof catalog>>
  open(method: string, payload: unknown): AsyncIterable<unknown>
  calls: RoutedCall[]
  resets: unknown[]
  stop(): void
}) => Promise<void>, initial: unknown = { sessionId: 'local-session' }) {
  const globals = globalThis as typeof globalThis & { window?: unknown }
  const oldWindow = globals.window
  const oldFetch = globalThis.fetch
  globals.window = { location: { pathname: '/', href: 'dsh-app://app/' } } as never
  const navigation = createNavigationFixture(initial)
  const calls: RoutedCall[] = []
  const resets: unknown[] = []
  const streams = new Map<string, number>()
  const response = (value: unknown) => new Response(JSON.stringify({ result: { ok: true, value } }), { headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'http://test.local').pathname
    const request = JSON.parse(String(init?.body))
    const host = request.payload?.scope?.targetHostId ?? null
    const cliRequest = path.endsWith('/peerHost/request') ? JSON.parse(request.payload.body) : undefined
    const method = cliRequest?.method ?? request.payload?.method ?? request.method
    calls.push({ path, method, host, payload: cliRequest?.payload ?? request.payload?.payload ?? request.payload, scope: request.payload?.scope })
    if (path.endsWith('/nativeStream')) {
      const streamId = `stream-${streams.size}`
      streams.set(streamId, 0)
      return response({ streamId })
    }
    if (path.endsWith('/nativeStreamNext')) {
      const reads = streams.get(request.payload.streamId) ?? 0
      streams.set(request.payload.streamId, reads + 1)
      return response(reads === 0 ? { done: false, value: { host } } : { done: true })
    }
    if (path.endsWith('/nativeStreamClose')) return response({ closed: true })
    if (path.endsWith('/peerHost/request')) {
      return response({ status: 200, body: JSON.stringify({ result: { ok: true, value: catalog(host) } }) })
    }
    if (method === 'session/modelCatalog') return response(catalog(host))
    if (method === 'session/create') return response({ sessionId: peerSession(host, 'new-session') })
    return response({ page: host })
  }) as typeof fetch
  const rpc = {
    async call(channel: string, method: string, payload: unknown): Promise<unknown> {
      calls.push({ path: `${channel}/${method}`, method, host: null, payload })
      return { ok: true, value: method === 'session/modelCatalog' || method.endsWith('cli/models') ? catalog('glor') : { sessionId: 'local-new' } }
    },
  }
  const remote = { openRemoteStream: (_method: string, _payload: unknown): AsyncIterable<unknown> => (async function* () { yield { local: true } })() }
  navigation.services.set('connection', { rpc })
  navigation.services.set('modelDirectories', { catalog: { resetGeneration: () => resets.push(navigation.selection.getSnapshot()) } })
  const transport = createPeerHostPageTransport(undefined, navigation.context)
  const restore = installPeerHostConnectionRouting({ uiContext: navigation.context, remote, hooks: transport.hooks, matchesScope: transport.matchesScope })!
  const stop = transport.watchNavigation()
  transport.setAggregate(aggregate() as never)
  try {
    await run({ ...navigation, transport, calls, resets, stop,
      call: (method, payload = { args: {} }) => rpc.call('/api', method, payload),
      cli: (action, payload) => callCliRpc(rpc as never, action, payload),
      models: (adapterId, sessionId) => loadModelCatalog(rpc as never, adapterId, sessionId),
      open: (method, payload) => remote.openRemoteStream(method, payload),
    })
  } finally {
    stop()
    restore()
    globalThis.fetch = oldFetch
    if (oldWindow === undefined) delete globals.window
    else globals.window = oldWindow
  }
}

test('Desktop 启动恢复本机会话，后台远端 page 和 follow 不污染本机模型目录', async () => {
  await withDesktopNavigation(async page => {
    await page.call('session/page', { args: { sessionId: peerSession() } })
    for await (const _ of page.open('session/follow', { args: { sessionId: peerSession('mac') } })) { /* 消费后台流。 */ }
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    assert.equal(page.calls.at(-1)?.path, '/api/session/modelCatalog')
    assert.equal(page.resets.length, 0, '后台请求不能清空前台目录缓存')
    assert.equal(page.transport.matchesScope({ args: {} }, 'session/modelCatalog'), false)
  })
})

test('Desktop 根地址下，远端切回本机并新建 DSH 会话后读取本机目录', async () => {
  await withDesktopNavigation(async page => {
    page.selection.set({ sessionId: peerSession() })
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['stage0'])
    await page.call('session/create', { args: { workspaceId: 'local-workspace' } })
    await page.call('session/page', { args: { sessionId: 'local-new' } })
    page.selection.set({ sessionId: 'local-new' })
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    assert.equal(page.resets.length, 2, '两次真实 Host 切换都必须更新缓存')
    assert.equal(page.calls.at(-1)?.host, null)
  })
})

test('前台远端 A 不被远端 B 的后台请求或本机旧会话请求覆盖', async () => {
  await withDesktopNavigation(async page => {
    await page.call('session/page', { args: { sessionId: peerSession('mac') } })
    await page.call('workspace/follow', { args: { workspaceId: 'local-workspace' } })
    await page.call('session/page', { args: { sessionId: 'local-session' } })
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['stage0'])
    assert.equal(page.calls.at(-1)?.host, 'stage0')
    assert.equal(page.resets.length, 1)
  }, { sessionId: peerSession() })
})

test('目录缓存按 Host 切换：同一 Host 的会话与工作区切换不重复刷新', async () => {
  await withDesktopNavigation(async page => {
    page.selection.set({ sessionId: peerSession() })
    page.selection.set({ sessionId: peerSession('stage0', 'session-2') })
    page.transport.setAggregate(aggregate() as never)
    assert.equal(page.resets.length, 1)
    page.selection.set({ sessionId: peerSession('mac') })
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['mac'])
    assert.equal(page.resets.length, 2)
    page.selection.set({})
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    assert.equal(page.resets.length, 3)
  })
})

test('本机选择覆盖残留远端 URL，PWA 与 Desktop 根地址保持相同路由语义', async () => {
  await withDesktopNavigation(async page => {
    window.location.pathname = `/workspaces/${encodeURIComponent(peerWorkspace())}`
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    page.selection.set({ sessionId: peerSession('mac') })
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['mac'])
  })
})

test('CLI 目录的显式本机 ID 不被前台远端劫持，无参数目录跟随前台', async () => {
  await withDesktopNavigation(async page => {
    assert.equal(page.transport.matchesScope({ sessionId: 'local-session', adapterId: 'codex' }, 'cli/models'), false)
    assert.equal(page.transport.matchesScope({ args: { workspaceId: 'local-workspace' } }, 'codingns/cli/catalog'), false)
    assert.deepEqual(providers(await page.call('codingns/cli/models', { sessionId: 'local-session', adapterId: 'codex' })), ['glor'])
    const remote = await page.transport.hooks.rpc?.({ method: 'cli/models', payload: { channel: '/codingns', payload: { adapterId: 'codex' } } })
    assert.deepEqual(providers(remote), ['stage0'])
    const explicit = await page.transport.hooks.rpc?.({ method: 'cli/models', payload: { channel: '/codingns', payload: { sessionId: peerSession('mac'), adapterId: 'codex' } } })
    assert.deepEqual(providers(explicit), ['mac'])
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['stage0'])
  }, { sessionId: peerSession() })
})

test('远端适配器和模型读写按自身会话路由，保持模型、思考强度和服务档位参数', async () => {
  await withDesktopNavigation(async page => {
    for (const host of ['stage0', 'mac']) {
      const sessionId = peerSession(host)
      await page.cli('catalog', { sessionId })
      assert.equal(page.calls.at(-1)?.host, host)
      assert.deepEqual(page.calls.at(-1)?.payload, { sessionId: 'session-1' })
      await page.cli('models', { sessionId, adapterId: 'codex' })
      assert.equal(page.calls.at(-1)?.host, host)
      assert.deepEqual(page.calls.at(-1)?.payload, { sessionId: 'session-1', adapterId: 'codex' })
      await page.cli('session/get', { sessionId })
      assert.equal(page.calls.at(-1)?.host, host)
      const config = { adapterId: 'codex', providerId: 'custom', modelId: 'gpt-model', effortId: 'high', serviceTierId: 'priority' }
      await page.cli('session/set', { sessionId, ...config })
      assert.equal(page.calls.at(-1)?.host, host)
      assert.deepEqual(page.calls.at(-1)?.payload, { sessionId: 'session-1', ...config })
      await page.cli('session/set', { sessionId, adapterId: 'dsh' })
      assert.equal(page.calls.at(-1)?.host, host)
    }
    assert.deepEqual(page.selection.getSnapshot(), { sessionId: peerSession('stage0') })
    assert.equal(page.resets.length, 1, '其他会话的适配器读写不能触发前台目录重置')
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['stage0'])
  }, { sessionId: peerSession('stage0') })
})

test('同一页面 RPC 的外部模型缓存分别读取本机和多个远端 Host 的目录', async () => {
  await withDesktopNavigation(async page => {
    for (const [sessionId, expected] of [['local-session', 'glor'], [peerSession('stage0'), 'stage0'], [peerSession('mac'), 'mac']] as const) {
      const value = await page.models('codex', sessionId)
      assert.deepEqual(value.groups.map(group => group.id), [expected])
    }
    const calls = page.calls.length
    assert.deepEqual((await page.models('codex', peerSession('stage0', 'session-2'))).groups.map(group => group.id), ['stage0'])
    assert.deepEqual((await page.models('codex', 'another-local-session')).groups.map(group => group.id), ['glor'])
    assert.equal(page.calls.length, calls, '同一 Host 的不同会话应继续复用缓存')
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
  })
})

test('远端 DSH 模型选择与发送保持资源作用域，前台切回本机不改写远端操作', async () => {
  await withDesktopNavigation(async page => {
    const sessionId = peerSession('mac')
    const selection = { provider: 'remote-provider', model: 'remote-model', reasoningEffort: 'high' }
    for (const foreground of [peerSession('stage0'), 'local-session']) {
      page.selection.set({ sessionId: foreground })
      for (const [method, args] of [
        ['session/initializeDefaultModel', { sessionId }],
        ['session/selectModel', { sessionId, selection }],
        ['session/prompt', { sessionId, text: '远端对话' }],
        ['commands/list', { sessionId }],
      ] as const) {
        await page.call(method, { args })
        assert.equal(page.calls.at(-1)?.host, 'mac')
        assert.deepEqual(page.calls.at(-1)?.payload, { args }, 'Host 边界前保留完整原生参数')
      }
    }
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    assert.equal(page.resets.length, 2)
  })
})

test('右栏文件和终端请求始终访问资源所属 Host，不跟随前台目录或后台请求切换', async () => {
  await withDesktopNavigation(async page => {
    const sessionId = peerSession('mac')
    const workspaceId = peerWorkspace('mac')
    const requests = [
      ['workspaceFiles/list', { workspaceId, path: 'src' }],
      ['workspaceFiles/read', { workspaceFileScopeId: sessionId, path: 'src/main.ts' }],
      ['workspaceFiles/readBytes', { workspaceFileScopeId: sessionId, path: 'image.png' }],
      ['fileReferences/list', { sessionId }],
      ['terminal/list', { sessionId }],
      ['terminal/environment', { sessionId }],
      ['codingnsTerminal/list', { agentId: sessionId }],
      ['codingnsTerminal/resize', { agentId: sessionId, terminalId: 'term-1', columns: 100, rows: 30 }],
    ] as const
    for (const foreground of [peerSession('stage0'), 'local-session']) {
      page.selection.set({ sessionId: foreground })
      for (const [method, args] of requests) {
        await page.call(method, { args })
        assert.equal(page.calls.at(-1)?.host, 'mac', method)
        assert.deepEqual(page.calls.at(-1)?.payload, { args }, method)
      }
      await page.call('workspaceFiles/list', { args: { workspaceId: 'local-workspace', path: 'src' } })
      assert.equal(page.calls.at(-1)?.host, null, '显式本机右栏请求不受远端前台影响')
    }
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    assert.equal(page.resets.length, 2, '右栏请求不能改变目录 Host')
  })
})

test('右栏远端终端流在前台切回本机后继续按原 Host 拉取并关闭', async () => {
  await withDesktopNavigation(async page => {
    const payload = { args: { agentId: peerSession('mac'), terminalId: 'term-1' } }
    let frames = 0
    for await (const frame of page.open('codingnsTerminal/follow', payload)) {
      assert.deepEqual(frame, { host: 'mac' })
      frames += 1
      page.selection.set({ sessionId: 'local-session' })
      assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    }
    assert.equal(frames, 1)
    const streamCalls = page.calls.filter(call => call.path.includes('/nativeStream'))
    assert.equal(streamCalls.length, 4, '打开、读取帧、读取结束、关闭都必须成功')
    assert.ok(streamCalls.every(call => call.host === 'mac'))
    assert.deepEqual(streamCalls[0]?.payload, payload)
    assert.deepEqual(page.selection.getSnapshot(), { sessionId: 'local-session' })
    assert.equal(page.resets.length, 2)
  }, { sessionId: peerSession('stage0') })
})

test('远端新会话聚合前由 pending 绑定模型目录，切回本机后不泄漏', async () => {
  await withDesktopNavigation(async page => {
    await page.call('session/create', { args: { workspaceId: peerWorkspace('mac') } })
    assert.equal(page.resets.length, 0, '创建资源本身不是前台导航')
    page.selection.set({ sessionId: peerSession('mac', 'new-session') })
    page.transport.setAggregate(aggregate() as never)
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['mac'])
    page.selection.set({ sessionId: 'local-session' })
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    assert.equal(page.resets.length, 2)
  })
})

test('恢复远端选择先于聚合时，聚合到达自动纠正目录 Host', async () => {
  await withDesktopNavigation(async page => {
    page.transport.setAggregate([])
    const before = page.resets.length
    page.transport.setAggregate(aggregate() as never)
    assert.equal(page.resets.length, before + 1)
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['mac'])
  }, { sessionId: peerSession('mac') })
})

test('新远端会话的 pending 到期时，目录仍从虚拟 ID 识别目标 Host', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withDesktopNavigation(async page => {
    await page.call('session/create', { args: { workspaceId: peerWorkspace('mac') } })
    page.selection.set({ sessionId: peerSession('mac', 'new-session') })
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['mac'])
    t.mock.timers.tick(30_001)
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['mac'])
    assert.equal(page.calls.at(-1)?.host, 'mac')
    assert.equal(page.resets.length, 1)
  })
})

test('导航监听释放后不再重置目录，后台请求也不恢复监听', async () => {
  await withDesktopNavigation(async page => {
    assert.equal(page.listeners.size, 1)
    page.stop()
    assert.equal(page.listeners.size, 0)
    page.selection.set({ sessionId: peerSession() })
    await page.call('session/page', { args: { sessionId: peerSession('mac') } })
    assert.equal(page.resets.length, 0)
  })
})

test('缺少原生导航服务时仅按显式工作区 URL 读取目录，后台请求不成为导航', async () => {
  await withDesktopNavigation(async page => {
    page.services.delete('uiWorkspace')
    await page.call('session/page', { args: { sessionId: peerSession() } })
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
    window.location.pathname = `/workspaces/${encodeURIComponent(peerWorkspace('mac'))}`
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['mac'])
    window.location.pathname = '/workspaces/local-workspace'
    assert.deepEqual(providers(await page.call('session/modelCatalog')), ['glor'])
  })
})
