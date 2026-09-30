import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostPageTransport } from '../data/build/dist/client/features/peer-host.js'
import { registerPeerHostAggregateRefresh } from '../data/build/dist/client/peer-host-aggregate-refresh.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'

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
    assert.deepEqual(projected.projections, { kind: 'cached', values: { title: '远端会话' } })
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
