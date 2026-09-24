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
})
