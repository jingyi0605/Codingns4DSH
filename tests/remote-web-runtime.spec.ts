import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalDshWebRuntimeProvider, createRemoteWebRuntimeFeature, type DshWebRuntimeProvider } from '../data/build/dist/host/remote-web-runtime.js'
import type { DshEnvelope } from '../data/build/dist/transport/dsh-envelope.js'

const scope = { hostId: 'h1', kind: 'local' as const }

function context(operation: string, streamId: string, payload: unknown) {
  const sent: DshEnvelope[] = []
  const envelope: DshEnvelope = {
    version: 1,
    messageId: `${streamId}-open`,
    streamId,
    channel: 'web',
    type: 'stream.open',
    sequence: 1,
    generation: '1',
    hostScope: scope,
    meta: { operation, encoding: 'json' },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  }
  return {
    sent,
    value: {
      envelope,
      session: undefined as never,
      send(type: string, meta: Record<string, unknown> = {}, body?: Uint8Array) {
        sent.push({ ...envelope, messageId: `${streamId}-${sent.length}`, type, meta, ...(body === undefined ? {} : { body }) })
      },
      close() {},
    },
  }
}

test('Remote Web Session 按 sessionId 保存并可继续读取 boot 和资源', async () => {
  const provider: DshWebRuntimeProvider = {
    async openSession() { return { sessionId: 'web-1', dshVersion: '0.1.6-alpha.2', capabilities: [] } as never },
    async getBoot(session) { assert.equal(session.sessionId, 'web-1'); return { dshVersion: '0.1.6-alpha.2', contentType: 'text/html', html: '<html></html>', capabilities: [] } },
    async getAsset(session, path) { assert.equal(session.sessionId, 'web-1'); assert.equal(path, '/assets/app.js'); return { contentType: 'text/javascript', body: new Uint8Array([1, 2]) } },
    async getPluginManifest() { return [] },
    async getPluginBundle() { return { contentType: 'application/javascript', body: new Uint8Array() } },
    async openWebSocket() { throw new Error('unused') },
  }
  const feature = createRemoteWebRuntimeFeature({ provider })
  const opened = context('web.session.open', 's-open', {})
  await feature.handleStream?.(opened.value)
  const session = JSON.parse(new TextDecoder().decode(opened.sent[0]?.body)) as { sessionId: string }
  assert.equal(session.sessionId, 'web-1')

  const boot = context('web.boot.get', 's-boot', { sessionId: session.sessionId })
  await feature.handleStream?.(boot.value)
  assert.equal(boot.sent[0]?.type, 'web.boot.response')

  const asset = context('web.asset.get', 's-asset', { sessionId: session.sessionId, path: '/assets/app.js' })
  await feature.handleStream?.(asset.value)
  assert.equal(asset.sent[0]?.type, 'web.asset.response')
  assert.deepEqual([...asset.sent[0]!.body!], [1, 2])
})

test('Remote Web Session close 会删除会话，WebSocket 打开失败会返回稳定错误', async () => {
  let opened = false
  const provider: DshWebRuntimeProvider = {
    async openSession() { opened = true; return { sessionId: 'web-2', dshVersion: '0.1.6-alpha.2' } },
    async getBoot() { throw new Error('unused') },
    async getAsset() { throw new Error('unused') },
    async getPluginManifest() { return [] },
    async getPluginBundle() { throw new Error('unused') },
    async openWebSocket() { throw new Error('socket unavailable') },
  }
  const feature = createRemoteWebRuntimeFeature({ provider })
  const open = context('web.session.open', 's-open-2', {})
  await feature.handleStream?.(open.value)
  assert.equal(opened, true)
  const close = context('web.session.close', 's-close-2', { sessionId: 'web-2' })
  await feature.handleStream?.(close.value)
  const socket = context('web.ws.open', 's-ws-2', { sessionId: 'web-2', path: '/api/socket' })
  await feature.handleStream?.(socket.value)
  assert.equal(socket.sent[0]?.type, 'stream.error')
  assert.equal(socket.sent[0]?.meta.errorCode, 'WEB_SESSION_NOT_FOUND')
})

test('本地 DSH Web Provider 使用官方认证 URL 换取并复用 Cookie', async () => {
  const requests: Array<{ url: string; cookie: string | undefined }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    requests.push({ url, cookie: headers.get('cookie') ?? undefined })
    if (url.includes('?token=launch-token')) {
      return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-test=session-cookie; Path=/; HttpOnly' } })
    }
    if (url.endsWith('/api/plugins/manifest')) {
      assert.equal(headers.get('cookie'), 'dsh-auth-test=session-cookie')
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    assert.equal(headers.get('cookie'), 'dsh-auth-test=session-cookie')
    return new Response('<html><script src="/assets/app.js"></script></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  }
  const provider = createLocalDshWebRuntimeProvider({
    port: 3080,
    dshVersion: '0.1.6-alpha.2',
    authenticatedUrl: 'http://127.0.0.1:3080/?token=launch-token',
    fetcher,
  })
  const session = await provider.openSession({})
  const boot = await provider.getBoot(session)
  assert.match(boot.html, /app\.js/u)
  await provider.getPluginManifest(session)
  assert.deepEqual(requests.map((item) => item.url), [
    'http://127.0.0.1:3080/?token=launch-token',
    'http://127.0.0.1:3080/',
    'http://127.0.0.1:3080/api/plugins/manifest',
  ])
  assert.equal(requests[1]?.cookie, 'dsh-auth-test=session-cookie')
  assert.equal(requests[2]?.cookie, 'dsh-auth-test=session-cookie')
})

test('本地 DSH Web Provider 为 WebSocket 握手注入认证 Cookie', async () => {
  let socketOptions: { readonly headers?: Readonly<Record<string, string>> } | undefined
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes('?token=launch-token')) {
      return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-test=session-cookie; Path=/; HttpOnly' } })
    }
    return new Response('<html></html>', { status: 200 })
  }
  const socket = {} as never
  const provider = createLocalDshWebRuntimeProvider({
    port: 3080,
    dshVersion: '0.1.6-alpha.2',
    authenticatedUrl: 'http://127.0.0.1:3080/?token=launch-token',
    fetcher,
    websocketFactory: (_url, options) => { socketOptions = options; return socket },
  })
  const session = await provider.openSession({})
  await provider.getBoot(session)
  assert.equal(await provider.openWebSocket(session, '/api/remote.mux'), socket)
  assert.equal(socketOptions?.headers?.cookie, 'dsh-auth-test=session-cookie')
  assert.equal(socketOptions?.headers?.origin, 'http://127.0.0.1:3080')
})

test('Remote Web 将 encoding=text 的 Envelope 恢复为本地 WebSocket 文本帧', async () => {
  const listeners = new Map<string, (event: Event) => void>()
  const sent: Array<string | Uint8Array> = []
  const socket = {
    readyState: 1,
    send(value: string | Uint8Array) { sent.push(value) },
    close() { listeners.get('close')?.({} as Event) },
    addEventListener(type: string, listener: (event: Event) => void) { listeners.set(type, listener) },
    removeEventListener(type: string) { listeners.delete(type) },
  }
  const provider: DshWebRuntimeProvider = {
    async openSession() { return { sessionId: 'web-text', dshVersion: '0.1.6-alpha.2' } },
    async getBoot() { throw new Error('unused') },
    async getAsset() { throw new Error('unused') },
    async getPluginManifest() { return [] },
    async getPluginBundle() { throw new Error('unused') },
    async openWebSocket() { return socket },
  }
  const feature = createRemoteWebRuntimeFeature({ provider })
  const openSession = context('web.session.open', 's-text-session', {})
  await feature.handleStream?.(openSession.value)
  const open = context('web.ws.open', 's-text-ws', { sessionId: 'web-text', path: '/api/remote.mux' })
  const running = feature.handleStream?.(open.value)
  for (let attempt = 0; attempt < 20 && !listeners.has('close'); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await feature.handleMessage?.({ ...open.value, envelope: { ...open.value.envelope, type: 'web.ws.data', meta: { encoding: 'text' }, body: new TextEncoder().encode('{"type":"open"}') } }, {
    ...open.value.envelope,
    type: 'web.ws.data',
    meta: { encoding: 'text' },
    body: new TextEncoder().encode('{"type":"open"}'),
  })
  assert.equal(sent.at(-1), '{"type":"open"}')
  listeners.get('close')?.({} as Event)
  await running
})

test('Remote Web 将 /api/remote.mux 的 Buffer 文本帧恢复为 encoding=text', async () => {
  const listeners = new Map<string, (event: Event) => void>()
  const socket = {
    readyState: 1,
    send() {},
    close() { listeners.get('close')?.({} as Event) },
    addEventListener(type: string, listener: (event: Event) => void) { listeners.set(type, listener) },
    removeEventListener(type: string) { listeners.delete(type) },
  }
  const provider: DshWebRuntimeProvider = {
    async openSession() { return { sessionId: 'web-buffer', dshVersion: '0.1.6-alpha.2' } },
    async getBoot() { throw new Error('unused') },
    async getAsset() { throw new Error('unused') },
    async getPluginManifest() { return [] },
    async getPluginBundle() { throw new Error('unused') },
    async openWebSocket() { return socket },
  }
  const feature = createRemoteWebRuntimeFeature({ provider })
  const openSession = context('web.session.open', 's-buffer-session', {})
  await feature.handleStream?.(openSession.value)
  const open = context('web.ws.open', 's-buffer-ws', { sessionId: 'web-buffer', path: '/api/remote.mux' })
  const running = feature.handleStream?.(open.value)
  // openWebSocketStream 会先等待 WebSocket 打开，再异步注册 message 监听器。
  // 测试必须等到监听器存在后再注入首帧，否则会把真实实现误判为丢帧。
  for (let attempt = 0; attempt < 20 && !listeners.has('message'); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(listeners.has('message'), true)
  listeners.get('message')?.({ data: Buffer.from(JSON.stringify({ type: 'item', streamId: 'events', value: { type: 'ready' } })) } as unknown as Event)
  await Promise.resolve()
  const forwarded = open.sent.find((item) => item.type === 'web.ws.data')
  assert.equal(forwarded?.meta.encoding, 'text')
  assert.equal(new TextDecoder().decode(forwarded?.body), JSON.stringify({ type: 'item', streamId: 'events', value: { type: 'ready' } }))
  listeners.get('close')?.({} as Event)
  await running
})
