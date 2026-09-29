import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostPageTransport } from '../data/build/dist/client/features/peer-host.js'
import { createVirtualSessionId } from '../data/build/dist/shared/index.js'

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
    assert.deepEqual(result, { page: 'remote' })
    assert.equal(calls[0]?.path, '/codingns/peerHost/native')
    const routed = calls[0]?.body.payload as Record<string, unknown>
    assert.equal(routed.method, 'session/page')
    assert.deepEqual(routed.scope, { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 })
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
