import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostPageTransport } from '../data/build/dist/client/features/peer-host.js'
import { registerPeerHostAggregateRefresh } from '../data/build/dist/client/peer-host-aggregate-refresh.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'
import { createNavigationFixture } from './peer-host-navigation-fixture.ts'

const aggregate = [{
  hostId: 'host-local',
  targetHostId: 'peer-1',
  hostLabel: '开发机',
  availability: 'ready' as const,
  errorCode: null,
  workspaces: [{
    key: 'peer-1:workspace-1',
    hostId: 'host-local',
    targetHostId: 'peer-1',
    workspaceId: 'workspace-1',
    displayName: '远端工作区',
    hostLabel: '开发机',
    availability: 'ready' as const,
    sessions: [{
      scope: { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
      title: '远端会话',
      status: 'active',
      updatedAt: 1,
    }],
  }],
}]

function response(value: unknown): Response {
  return new Response(JSON.stringify({ result: { ok: true, value } }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function binaryResponse(value: Record<string, unknown>, bytes: Uint8Array): Response {
  const form = new FormData()
  form.append('metadata', JSON.stringify({
    type: 'server-response',
    rpcId: 'local-binary-response',
    result: { ok: true, value },
    attachments: [{ codec: 'bytes', part: 'bytes-0', path: ['data'] }],
  }))
  form.append('bytes-0', new Blob([bytes], { type: 'application/octet-stream' }), 'bytes.bin')
  return new Response(form, { status: 200 })
}

test('页面 connector 可解析本机 workspaceFiles/readBytes 的 multipart 二进制响应', async () => {
  const previousFetch = globalThis.fetch
  const bytes = new Uint8Array([0, 45, 60, 255])
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    assert.equal(path, '/api/workspaceFiles/readBytes')
    return binaryResponse({
      offset: 0,
      data: null,
      eof: true,
      absolutePath: '/workspace/image.png',
      version: 'v1',
      bytes: bytes.byteLength,
    }, bytes)
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    const result = await transport.hooks.rpc?.({
      method: 'workspaceFiles/readBytes',
      payload: { channel: '/api', payload: { path: 'image.png' } },
    })
    assert.deepEqual(result, {
      ok: true,
      value: {
        offset: 0,
        data: bytes,
        eof: true,
        absolutePath: '/workspace/image.png',
        version: 'v1',
        bytes: bytes.byteLength,
      },
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 将虚拟 Session 的原生 Remote 路由到 peerHost/native', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ path, body })
    return response({ page: 'remote' })
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    const sessionId = createVirtualSessionId('peer-1', 'session-1')
    const result = await transport.hooks.rpc?.({
      method: 'session/page',
      payload: { channel: '/api', payload: { sessionId } },
    })
    // DSH 的 client 契约要求结果信封；返回裸值会让网关读 undefined.code 而崩成 carrierFailure。
    assert.deepEqual(result, { ok: true, value: { page: 'remote' } })
    assert.equal(calls[0]?.path, '/codingns/peerHost/native')
    const routed = calls[0]?.body.payload as Record<string, unknown>
    assert.equal(routed.method, 'session/page')
    assert.deepEqual(routed.scope, { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 将远程会话引用候选路由到目标 Host', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ path, body })
    return response([])
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    const sessionId = createVirtualSessionId('peer-1', 'session-1')
    const result = await transport.hooks.rpc?.({
      method: 'sessionReferenceResolver/candidates',
      payload: { channel: '/api', payload: { args: { agentId: sessionId, query: '' } } },
    })
    assert.deepEqual(result, { ok: true, value: [] })
    assert.equal(calls[0]?.path, '/codingns/peerHost/native')
    const routed = calls[0]?.body.payload as Record<string, unknown>
    assert.equal(routed.method, 'sessionReferenceResolver/candidates')
    assert.deepEqual(routed.scope, { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 在聚合暂时漏掉会话时仍沿用最后确认的远端路由', async () => {
  const paths: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    paths.push(path)
    return response({ page: 'remote' })
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    // 工作区仍存在，但本轮 session/list 暂时没有返回当前会话。
    transport.setAggregate([{ ...aggregate[0]!, workspaces: [{ ...aggregate[0]!.workspaces[0]!, sessions: [] }] }])
    const sessionId = createVirtualSessionId('peer-1', 'session-1')
    const result = await transport.hooks.rpc?.({
      method: 'session/page',
      payload: { channel: '/api', payload: { sessionId } },
    })
    assert.deepEqual(result, { ok: true, value: { page: 'remote' } })
    assert.deepEqual(paths, ['/codingns/peerHost/native'])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 将无参数的 session/modelCatalog 路由到当前远程 Host', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ path, body })
    return response({ groups: [{ id: 'deepseek-api', name: 'DeepSeek API', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }] })
  }) as typeof fetch
  try {
    const sessionId = createVirtualSessionId('peer-1', 'session-1')
    const navigation = createNavigationFixture({ sessionId })
    const transport = createPeerHostPageTransport(undefined, navigation.context)
    transport.setAggregate(aggregate)
    // 目录的原生契约没有参数，目标来自前台选择，而不是最近一次远端请求。
    calls.length = 0
    const result = await transport.hooks.rpc?.({
      method: 'session/modelCatalog',
      payload: { channel: '/api', payload: {} },
    })
    assert.deepEqual(result, {
      ok: true,
      value: { groups: [{ id: 'deepseek-api', name: 'DeepSeek API', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }] },
    })
    assert.equal(calls[0]?.path, '/codingns/peerHost/native')
    const routed = calls[0]?.body.payload as Record<string, unknown>
    assert.equal(routed.method, 'session/modelCatalog')
    assert.deepEqual(routed.scope, { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 在远程工作区作用域变化时使 DSH 模型目录失效', async () => {
  const previousFetch = globalThis.fetch
  let resetCount = 0
  globalThis.fetch = (async () => response({ page: 'remote' })) as typeof fetch
  const navigation = createNavigationFixture({ sessionId: 'local-session' })
  navigation.services.set('modelDirectories', { catalog: { resetGeneration: () => { resetCount += 1 } } })
  let stop: (() => void) | undefined
  try {
    const transport = createPeerHostPageTransport(undefined, navigation.context)
    transport.setAggregate(aggregate)
    stop = transport.watchNavigation()
    const sessionId = createVirtualSessionId('peer-1', 'session-1')
    navigation.selection.set({ sessionId })
    await transport.hooks.rpc?.({
      method: 'session/page',
      payload: { channel: '/api', payload: { sessionId } },
    })
    assert.equal(resetCount, 1, '首次进入远程工作区必须清掉本地模型目录')
    await transport.hooks.rpc?.({
      method: 'session/page',
      payload: { channel: '/api', payload: { sessionId } },
    })
    assert.equal(resetCount, 1, '同一远程工作区内的请求不能重复刷新模型目录')
    navigation.selection.set({ sessionId: 'local-session' })
    assert.equal(resetCount, 2, '切回本机工作区必须重新读取本地模型目录')
  } finally {
    stop?.()
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 将远端会话的 CLI 目录路由到目标 Host 并还原真实 sessionId', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ path, body })
    const nested = { result: { ok: true, value: { groups: [{ name: '远端模型', models: [] }] } } }
    return response({ status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify(nested) })
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    const sessionId = createVirtualSessionId('peer-1', 'session-1')
    const result = await transport.hooks.rpc?.({
      method: 'cli/models',
      payload: { channel: '/codingns', payload: { sessionId, adapterId: 'codex' } },
    })
    assert.deepEqual(result, { ok: true, value: { groups: [{ name: '远端模型', models: [] }] } })
    assert.equal(calls[0]?.path, '/codingns/peerHost/request')
    const routed = calls[0]?.body.payload as Record<string, unknown>
    assert.equal(routed.path, '/api/codingns/cli/models')
    const forwarded = JSON.parse(String(routed.body)) as { payload: { sessionId: string; adapterId: string } }
    assert.equal(forwarded.payload.sessionId, 'session-1')
    assert.equal(forwarded.payload.adapterId, 'codex')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 在前台选择只有远程工作区时，CLI 目录读取该工作区', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ path, body })
    if (path.endsWith('/peerHost/request')) {
      const nested = { result: { ok: true, value: path.endsWith('/peerHost/request') && JSON.stringify(body).includes('cli/models')
        ? { groups: [{ id: 'remote', name: '远端模型', models: [{ id: 'remote-model', name: '远端模型' }] }] }
        : [{ id: 'remote-adapter', name: '远端适配器', installed: true, enabled: true }] } }
      return response({ status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify(nested) })
    }
    return response({ page: 'remote' })
  }) as typeof fetch
  try {
    const navigation = createNavigationFixture({ workspaceId: createVirtualWorkspaceId('peer-1', 'workspace-1') })
    const transport = createPeerHostPageTransport(undefined, navigation.context)
    transport.setAggregate(aggregate)
    assert.equal(transport.matchesScope({}, 'cli/catalog'), true)
    calls.length = 0
    const adapterResult = await transport.hooks.rpc?.({
      method: 'cli/catalog',
      payload: { channel: '/codingns', payload: {} },
    })
    const modelResult = await transport.hooks.rpc?.({
      method: 'cli/models',
      payload: { channel: '/codingns', payload: { adapterId: 'remote-adapter' } },
    })
    assert.deepEqual(adapterResult, { ok: true, value: [{ id: 'remote-adapter', name: '远端适配器', installed: true, enabled: true }] })
    assert.deepEqual(modelResult, { ok: true, value: { groups: [{ id: 'remote', name: '远端模型', models: [{ id: 'remote-model', name: '远端模型' }] }] } })
    assert.deepEqual(calls.map((call) => call.path), ['/codingns/peerHost/request', '/codingns/peerHost/request'])
    for (const call of calls) {
      const routed = call.body.payload as Record<string, unknown>
      assert.deepEqual(routed.scope, { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: null, scopeGeneration: 0 })
    }
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 的 Peer unary 失败保留稳定错误码而不是抛裸错误', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ result: { ok: false, error: { code: 'session/not-found', message: 'session not found' } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    const result = await transport.hooks.rpc?.({
      method: 'session/page',
      payload: { channel: '/api', payload: { sessionId: createVirtualSessionId('peer-1', 'session-1') } },
    })
    assert.deepEqual(result, { ok: false, error: { code: 'session/not-found', message: 'session not found' } })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 通过 nativeStream 读取远端 session/follow 并关闭句柄', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const previousFetch = globalThis.fetch
  let nextCount = 0
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ path, body })
    if (path.endsWith('/nativeStream')) return response({ streamId: 'stream-1' })
    if (path.endsWith('/nativeStreamNext')) {
      nextCount += 1
      return response(nextCount === 1 ? { done: false, value: { type: 'snapshot' } } : { done: true })
    }
    if (path.endsWith('/nativeStreamClose')) return response({ closed: true })
    throw new Error(`unexpected path: ${path}`)
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    const sessionId = createVirtualSessionId('peer-1', 'session-1')
    const stream = transport.hooks.openStream?.({
      method: 'session/follow',
      payload: { channel: '/api', payload: { sessionId } },
    })
    assert.ok(stream)
    const values: unknown[] = []
    for await (const value of stream) values.push(value)
    assert.deepEqual(values, [{ type: 'snapshot' }])
    assert.deepEqual(calls.map((call) => call.path), [
      '/codingns/peerHost/nativeStream',
      '/codingns/peerHost/nativeStreamNext',
      '/codingns/peerHost/nativeStreamNext',
      '/codingns/peerHost/nativeStreamClose',
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 收到远端 session/follow 帧后合并触发聚合刷新', async (t) => {
  // 合并窗口用模拟定时器推进，避免真实等待时长受机器负载影响：流在窗口内结束时
  // 只应产生一次刷新，而不是每个帧各刷新一次。
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const previousFetch = globalThis.fetch
  let nextCount = 0
  let refreshCount = 0
  const disposeRefresh = registerPeerHostAggregateRefresh(() => { refreshCount += 1 })
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    if (path.endsWith('/nativeStream')) return response({ streamId: 'stream-refresh' })
    if (path.endsWith('/nativeStreamNext')) {
      nextCount += 1
      return response(nextCount === 1 ? { done: false, value: { type: 'snapshot' } } : { done: true })
    }
    if (path.endsWith('/nativeStreamClose')) return response({ closed: true })
    throw new Error(`unexpected path: ${path}`)
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    const stream = transport.hooks.openStream?.({
      method: 'session/follow',
      payload: { channel: '/api', payload: { sessionId: createVirtualSessionId('peer-1', 'session-1') } },
    })
    assert.ok(stream)
    for await (const _value of stream) { /* 消费完整流：帧和流结束都在同一个合并窗口内登记。 */ }
    assert.equal(refreshCount, 0, '合并窗口未到前不应立刻刷新')
    t.mock.timers.tick(200)
    assert.equal(refreshCount, 1, '窗口内多个事件只触发一次刷新')
    t.mock.timers.tick(1_000)
    assert.equal(refreshCount, 1, '没有新事件时不应重复刷新')
  } finally {
    disposeRefresh()
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 将本地 workspace/follow 回退到 DSH Gateway stream', async () => {
  const previousWebSocket = (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket
  class FakeWebSocket {
    static readonly OPEN = 1
    readyState = 0
    readonly url: string
    listeners = new Map<string, Array<(event: unknown) => void>>()
    constructor(url: string) {
      this.url = url
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN
        this.emit('open', {})
      })
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
      const entries = this.listeners.get(type) ?? []
      entries.push(listener)
      this.listeners.set(type, entries)
    }
    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener))
    }
    send(value: string): void {
      const request = JSON.parse(value) as { streamId: string; type: string }
      if (request.type !== 'open') return
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'item', streamId: request.streamId, value: { local: true } }) }))
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'end', streamId: request.streamId }) }))
    }
    close(): void {}
    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }
  }
  ;(globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket = FakeWebSocket
  try {
    const transport = createPeerHostPageTransport()
    const stream = transport.hooks.openStream?.({
      method: 'workspace/follow',
      payload: { channel: '/api', payload: { workspaceId: 'local-workspace' } },
    })
    assert.ok(stream)
    const values: unknown[] = []
    for await (const value of stream) values.push(value)
    assert.deepEqual(values, [{ local: true }])
  } finally {
    if (previousWebSocket === undefined) delete (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket
    else (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket = previousWebSocket
  }
})

interface FakeSocketHarness {
  readonly opens: Array<{ streamId: string; endpoint: string; payload: unknown }>
  restore(): void
}

/** 安装只记录 open 帧、按脚本回放的假 WebSocket；用于断言本地流回退路径。 */
function installFakeWebSocket(script: (socket: { emit: (type: string, event: unknown) => void }, request: { streamId: string; endpoint: string }) => void): FakeSocketHarness {
  const previous = (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket
  const opens: Array<{ streamId: string; endpoint: string; payload: unknown }> = []
  class FakeWebSocket {
    static readonly OPEN = 1
    readyState = 0
    readonly url: string
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>()
    constructor(url: string) {
      this.url = url
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN
        this.emit('open', {})
      })
    }
    addEventListener(type: string, listener: (event: unknown) => void): void {
      const entries = this.listeners.get(type) ?? []
      entries.push(listener)
      this.listeners.set(type, entries)
    }
    removeEventListener(type: string, listener: (event: unknown) => void): void {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener))
    }
    send(value: string): void {
      const frame = JSON.parse(value) as { type: string; streamId: string; endpoint: string; payload: unknown }
      if (frame.type !== 'open') return
      opens.push({ streamId: frame.streamId, endpoint: frame.endpoint, payload: frame.payload })
      script({ emit: (type, event) => this.emit(type, event) }, frame)
    }
    close(): void {}
    emit(type: string, event: unknown): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    }
  }
  ;(globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket = FakeWebSocket
  return {
    opens,
    restore() {
      if (previous === undefined) delete (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket
      else (globalThis as typeof globalThis & { WebSocket?: unknown }).WebSocket = previous
    },
  }
}

test('页面 connector 在远端新建会话后立刻按虚拟 ID 路由后续 unary 与 stream', async () => {
  const paths: string[] = []
  const previousFetch = globalThis.fetch
  let nextCount = 0
  const createdSessionId = createVirtualSessionId('peer-1', 'session-new')
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    paths.push(path)
    if (path.endsWith('/peerHost/native')) return response({ sessionId: createdSessionId })
    if (path.endsWith('/nativeStream')) return response({ streamId: 'stream-new' })
    if (path.endsWith('/nativeStreamNext')) {
      nextCount += 1
      return response(nextCount === 1 ? { done: false, value: { type: 'snapshot' } } : { done: true })
    }
    if (path.endsWith('/nativeStreamClose')) return response({ closed: true })
    throw new Error(`unexpected path: ${path}`)
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    // 聚合里没有该工作区的任何会话，模拟"远端工作区里还没有会话"。
    transport.setAggregate([{ ...aggregate[0]!, workspaces: [{ ...aggregate[0]!.workspaces[0]!, sessions: [] }] }])
    const created = await transport.hooks.rpc?.({
      method: 'session/create',
      payload: { channel: '/api', payload: { args: { request: { workspaceId: createVirtualWorkspaceId('peer-1', 'workspace-1') } } } },
    })
    assert.deepEqual(created, { ok: true, value: { sessionId: createdSessionId } })
    assert.equal(paths.at(-1), '/codingns/peerHost/native')

    paths.length = 0
    const page = await transport.hooks.rpc?.({
      method: 'session/page',
      payload: { channel: '/api', payload: { args: { request: { address: { kind: 'session', sessionId: createdSessionId } } } } },
    })
    assert.deepEqual(page, { ok: true, value: { sessionId: createdSessionId } })
    assert.deepEqual(paths, ['/codingns/peerHost/native'])

    paths.length = 0
    const stream = transport.hooks.openStream?.({
      method: 'session/follow',
      payload: { channel: '/api', payload: { args: { request: { address: { kind: 'session', sessionId: createdSessionId } } } } },
    })
    assert.ok(stream)
    const values: unknown[] = []
    for await (const value of stream) values.push(value)
    assert.deepEqual(values, [{ type: 'snapshot' }])
    assert.deepEqual(paths, [
      '/codingns/peerHost/nativeStream',
      '/codingns/peerHost/nativeStreamNext',
      '/codingns/peerHost/nativeStreamNext',
      '/codingns/peerHost/nativeStreamClose',
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 在远端会话确认消失后仍沿用目标 Host 路由', async () => {
  const paths: string[] = []
  const previousFetch = globalThis.fetch
  const createdSessionId = createVirtualSessionId('peer-1', 'session-new')
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    paths.push(path)
    if (path.endsWith('/peerHost/native')) return response(paths.length === 1 ? { sessionId: createdSessionId } : { page: 'remote' })
    throw new Error(`unexpected path: ${path}`)
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    const emptyAggregate = [{ ...aggregate[0]!, workspaces: [{ ...aggregate[0]!.workspaces[0]!, sessions: [] }] }]
    transport.setAggregate(emptyAggregate)
    const payload = { channel: '/api', payload: { args: { request: { workspaceId: createVirtualWorkspaceId('peer-1', 'workspace-1') } } } }
    const created = await transport.hooks.rpc?.({ method: 'session/create', payload })
    assert.deepEqual(created, { ok: true, value: { sessionId: createdSessionId } })

    // 聚合确认后 pending 作用域应被正式条目接管并清理。
    const confirmedAggregate = [{
      ...aggregate[0]!,
      workspaces: [{
        ...aggregate[0]!.workspaces[0]!,
        sessions: [{
          ...aggregate[0]!.workspaces[0]!.sessions[0]!,
          scope: { ...aggregate[0]!.workspaces[0]!.sessions[0]!.scope, sessionId: 'session-new' },
        }],
      }],
    }]
    transport.setAggregate(confirmedAggregate)
    // 下一次聚合暂时移除该会话时，仍沿用最后确认的远端作用域，避免回落本机 Gateway。
    transport.setAggregate(emptyAggregate)
    const page = await transport.hooks.rpc?.({
      method: 'session/page',
      payload: { channel: '/api', payload: { sessionId: createdSessionId } },
    })
    assert.deepEqual(page, { ok: true, value: { page: 'remote' } })
    assert.deepEqual(paths, ['/codingns/peerHost/native', '/codingns/peerHost/native'])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 在 pending 超时后清理远端作用域', async () => {
  const paths: string[] = []
  const previousFetch = globalThis.fetch
  const previousNow = Date.now
  let now = previousNow()
  const createdSessionId = createVirtualSessionId('peer-1', 'session-timeout')
  Date.now = () => now
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    paths.push(path)
    if (path.endsWith('/peerHost/native')) return response({ sessionId: createdSessionId })
    throw new Error(`unexpected path: ${path}`)
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    const emptyAggregate = [{ ...aggregate[0]!, workspaces: [{ ...aggregate[0]!.workspaces[0]!, sessions: [] }] }]
    transport.setAggregate(emptyAggregate)
    const payload = { channel: '/api', payload: { args: { request: { workspaceId: createVirtualWorkspaceId('peer-1', 'workspace-1') } } } }
    const created = await transport.hooks.rpc?.({ method: 'session/create', payload })
    assert.deepEqual(created, { ok: true, value: { sessionId: createdSessionId } })

    // 推进超过生产代码中的 pending TTL，再让一次聚合刷新执行清理。
    now += 31_000
    transport.setAggregate(emptyAggregate)
    const page = await transport.hooks.rpc?.({
      method: 'session/page',
      payload: { channel: '/api', payload: { sessionId: createdSessionId } },
    })
    assert.deepEqual(page, {
      ok: false,
      error: {
        code: 'PEER_HOST_SCOPE_MISMATCH',
        message: '远端会话作用域暂不可用，请等待 PeerHost 工作区刷新',
      },
    })
    assert.deepEqual(paths, ['/codingns/peerHost/native'])
  } finally {
    Date.now = previousNow
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 在远端新建会话后立刻请求聚合刷新，失败时不请求', async () => {
  const previousFetch = globalThis.fetch
  let refreshCount = 0
  let fail = false
  const createdSessionId = createVirtualSessionId('peer-1', 'session-new')
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input), 'http://dsh.test').pathname
    if (!path.endsWith('/peerHost/native')) throw new Error(`unexpected path: ${path}`)
    if (fail) {
      return new Response(JSON.stringify({ result: { ok: false, error: { code: 'gateway/internal', message: '目标 Host 不可达' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return response({ sessionId: createdSessionId })
  }) as typeof fetch
  const dispose = registerPeerHostAggregateRefresh(() => { refreshCount += 1 })
  try {
    const transport = createPeerHostPageTransport()
    // 聚合里没有该工作区的任何会话：只有刷新摘要，侧栏才能把新会话挂到远端工作区。
    transport.setAggregate([{ ...aggregate[0]!, workspaces: [{ ...aggregate[0]!.workspaces[0]!, sessions: [] }] }])
    const payload = { channel: '/api', payload: { args: { request: { workspaceId: createVirtualWorkspaceId('peer-1', 'workspace-1') } } } }
    const created = await transport.hooks.rpc?.({ method: 'session/create', payload })
    assert.deepEqual(created, { ok: true, value: { sessionId: createdSessionId } })
    assert.equal(refreshCount, 1)

    fail = true
    const failed = await transport.hooks.rpc?.({ method: 'session/create', payload })
    assert.equal((failed as { ok?: boolean } | undefined)?.ok, false)
    assert.equal(refreshCount, 1)
  } finally {
    dispose()
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 把虚拟会话并入原生 session/list 结果', async () => {
  const previousFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = (async (input) => {
    paths.push(new URL(String(input), 'http://dsh.test').pathname)
    return response({ items: [{ agentAvailable: true, sessionId: 'local-session', updatedAt: 1, running: false, blank: false }] })
  }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    const result = await transport.hooks.rpc?.({
      method: 'session/list',
      payload: { channel: '/api', payload: { args: {} } },
    }) as { value: { items: Array<Record<string, unknown>> } }
    assert.deepEqual(paths, ['/api/session/list'])
    assert.deepEqual(result.value.items.map((item) => item.sessionId), ['local-session', createVirtualSessionId('peer-1', 'session-1')])
    const projected = result.value.items[1] ?? {}
    assert.deepEqual(projected.projections, { kind: 'cached', asOfSeq: 0, values: { title: '远端会话' } })
    assert.equal(projected.running, true)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('页面 connector 将 $events 等本地流回退到 DSH Gateway 而不是抛错', async () => {
  const socket = installFakeWebSocket((fake, request) => {
    queueMicrotask(() => fake.emit('message', { data: JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'ready' } }) }))
    queueMicrotask(() => fake.emit('message', { data: JSON.stringify({ type: 'end', streamId: request.streamId }) }))
  })
  try {
    const transport = createPeerHostPageTransport()
    const stream = transport.hooks.openStream?.({
      method: '$events',
      payload: { channel: '/api', payload: { args: {} } },
    })
    assert.ok(stream)
    const values: unknown[] = []
    for await (const value of stream) values.push(value)
    assert.deepEqual(values, [{ type: 'ready' }])
    assert.equal(socket.opens[0]?.endpoint, '$events')
  } finally {
    socket.restore()
  }
})

test('问题回答只按 agentId 选 Host，正文中的虚拟 ID 不改变本机归属', async () => {
  const previous = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = (async input => { paths.push(String(input)); return response(true) }) as typeof fetch
  try {
    const transport = createPeerHostPageTransport()
    transport.setAggregate(aggregate)
    const remoteId = createVirtualSessionId('peer-1', 'session-1')
    await transport.hooks.rpc!({ method: 'userQuestions/answer', payload: { channel: '/api', payload: { args: { agentId: 'local-session', callId: 'c', answer: { answers: [{ id: 'q', selected: [remoteId] }] } } } } })
    assert.deepEqual(paths, ['/api/userQuestions/answer'])
    const missing = createVirtualSessionId('peer-1', 'removed-session')
    const payload = { args: { agentId: missing, callId: 'c', answer: { answers: [] } } }
    assert.equal(transport.matchesScope(payload, 'userQuestions/answer'), true)
    const result = await transport.hooks.rpc!({ method: 'userQuestions/answer', payload: { channel: '/api', payload } }) as any
    assert.equal(result.error.code, 'PEER_HOST_SCOPE_MISMATCH')
    assert.throws(() => transport.hooks.openStream!({ method: 'userQuestions/attachWait', payload: { channel: '/api', payload: { args: { agentId: missing, callId: 'c' } } } }), /会话不可用/)
    assert.equal(paths.length, 1, '过期的远端问题不能回落本机接口')
  } finally { globalThis.fetch = previous }
})
