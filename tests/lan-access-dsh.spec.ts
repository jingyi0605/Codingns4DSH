import assert from 'node:assert/strict'
import test from 'node:test'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import { createLanAccessDshFeature } from '../data/build/dist/host/features/index.js'
import {
  LanAccessDshProxy,
  LanAccessDshRequestTransform,
  PEER_HOST_AUTH_PATHS,
  DEFAULT_LOGIN_PROTECTION_COOKIE_NAME,
  InMemoryLanAccessDshLoginStore,
  createLanAccessDshRpcHandler,
  createLoginProtectionConfig,
  isPeerHostRouteRequest,
  refreshLoginProtectionSession,
  resolvePeerHostAuthResponse,
  verifyPeerHostAccessToken,
  verifyLoginProtectionSession,
  normalizeLanAccessDshConfig,
  normalizeLanAccessDshRpcBody,
  resolveLoginProtectionCookieName,
  rewriteLanAccessDshRequestHeaders,
  type LanAccessDshRuntime,
  type LanAccessDshStream,
} from '../data/build/dist/host/lan-access-dsh.js'
import { PwaPushService, createLanAccessDshPwaProvider } from '../data/build/dist/host/modules/pwa/index.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS, type CodingNsSettings } from '../data/build/dist/shared/contracts/config.js'
import { PEER_HOST_HTTP_PROXY_RULES } from '../data/build/dist/host/modules/peer-host/host-api-proxy-service.js'

class FakeStream implements LanAccessDshStream {
  readonly pipes: LanAccessDshStream[] = []
  destroyed = false
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  pipe(destination: LanAccessDshStream): LanAccessDshStream { this.pipes.push(destination); return destination }
  destroy(): void { this.destroyed = true; this.emit('close') }
  once(event: 'error' | 'close' | 'connect', listener: (...args: unknown[]) => void): LanAccessDshStream {
    const wrapped = (...args: unknown[]): void => { this.listeners.get(event)?.delete(wrapped); listener(...args) }
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(wrapped)
    this.listeners.set(event, listeners)
    return this
  }
  emit(event: 'error' | 'close' | 'connect', ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class FakeRuntime implements LanAccessDshRuntime {
  readonly accepted = new Map<string, (socket: LanAccessDshStream) => void>()
  readonly connected: number[] = []
  readonly closed: number[] = []
  detected: readonly number[] = [9080]

  listListenHosts(): readonly string[] { return ['0.0.0.0', '192.168.1.10'] }
  async detectDshPorts(): Promise<readonly number[]> { return this.detected }
  async listen(config: { listenHost: string; listenPort: number }, onConnection: (socket: LanAccessDshStream) => void): Promise<{ actualPort: number; close: () => Promise<void> }> {
    this.accepted.set(config.listenHost, onConnection)
    return { actualPort: config.listenPort || 43123, close: async () => { this.closed.push(config.listenPort) } }
  }
  connect(dshPort: number, onConnect: (socket: LanAccessDshStream) => void): void { this.connected.push(dshPort); onConnect(new FakeStream()) }
  accept(host = '0.0.0.0'): FakeStream { const socket = new FakeStream(); this.accepted.get(host)?.(socket); return socket }
}

class FakeSettings {
  private readonly listeners = new Set<(next: CodingNsSettings, prev: CodingNsSettings) => void | Promise<void>>()
  private value: CodingNsSettings

  constructor(value: CodingNsSettings) { this.value = value }

  get(): CodingNsSettings { return this.value }

  watch(listener: (next: CodingNsSettings, prev: CodingNsSettings) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async commit(value: CodingNsSettings): Promise<void> {
    const previous = this.value
    this.value = value
    await Promise.all([...this.listeners].map((listener) => listener(value, previous)))
  }

  async update(patch: object): Promise<void> {
    const next = patch as Partial<CodingNsSettings>
    await this.commit({
      ...this.value,
      ...next,
      lanAccessDsh: { ...this.value.lanAccessDsh, ...(next.lanAccessDsh ?? {}) },
    })
  }
}

test('登录保护 Cookie 名称支持按 DSH 实例隔离', () => {
  assert.equal(DEFAULT_LOGIN_PROTECTION_COOKIE_NAME, 'dsh_codingns_session')
  assert.equal(resolveLoginProtectionCookieName('dsh_codingns_stage0'), 'dsh_codingns_stage0')
  assert.equal(resolveLoginProtectionCookieName(''), DEFAULT_LOGIN_PROTECTION_COOKIE_NAME)
  assert.equal(resolveLoginProtectionCookieName('invalid cookie name'), DEFAULT_LOGIN_PROTECTION_COOKIE_NAME)
})

test('配置只包含监听地址、监听端口和 DSH 本地端口', () => {
  assert.deepEqual(normalizeLanAccessDshConfig({ listenHost: '0.0.0.0', listenPort: 13080, dshPort: 9080 }), { listenHost: '0.0.0.0', listenPort: 13080, dshPort: 9080 })
  assert.equal(normalizeLanAccessDshConfig({ listenHost: '10.0.0.8', listenPort: 13080, dshPort: 9080 }, ['0.0.0.0', '10.0.0.8']).listenHost, '10.0.0.8')
  assert.throws(() => normalizeLanAccessDshConfig({ listenHost: '10.0.0.2', listenPort: 13080, dshPort: 9080 }), /监听地址/u)
  assert.throws(() => normalizeLanAccessDshConfig({ listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 }), /dshPort/u)
})

test('自动探测单个 DSH 端口并始终转发到该端口', async () => {
  const runtime = new FakeRuntime()
  const proxy = new LanAccessDshProxy(runtime)
  const snapshot = await proxy.start({ listenHost: '0.0.0.0', listenPort: 13080 })
  assert.equal(snapshot.dshPort, 9080)
  const local = runtime.accept()
  assert.deepEqual(runtime.connected, [9080])
  assert.equal(local.pipes.length, 1)
  await proxy.stop()
  assert.deepEqual(runtime.closed, [13080])
  assert.equal(local.destroyed, true)
})

test('多个 DSH 实例要求手动指定端口', async () => {
  const runtime = new FakeRuntime()
  runtime.detected = [9080, 9081]
  const proxy = new LanAccessDshProxy(runtime)
  await assert.rejects(() => proxy.start({ listenPort: 13080 }), /多个 DSH/u)
  const snapshot = await proxy.start({ listenPort: 13080, dshPort: 9081 })
  assert.equal(snapshot.dshPort, 9081)
})

test('局域网代理改写上游 Host/Origin 并保留 WebSocket 升级', () => {
  const request = new TextEncoder().encode([
    'POST /api/session/list HTTP/1.1',
    'Host: 10.255.0.83:13080',
    'Origin: http://10.255.0.83:13080',
    'Connection: keep-alive',
    '',
    '',
  ].join('\r\n'))
  const rewritten = new TextDecoder().decode(rewriteLanAccessDshRequestHeaders(request, '127.0.0.1:3080'))
  assert.match(rewritten, /Host: 127\.0\.0\.1:3080/u)
  assert.match(rewritten, /Origin: http:\/\/127\.0\.0\.1:3080/u)
  assert.match(rewritten, /Connection: close/u)

  const upgrade = new TextEncoder().encode([
    'GET /api/remote.mux HTTP/1.1',
    'Host: 10.255.0.83:13080',
    'Origin: http://10.255.0.83:13080',
    'Connection: Upgrade',
    'Upgrade: websocket',
    '',
    '',
  ].join('\r\n'))
  const rewrittenUpgrade = new TextDecoder().decode(rewriteLanAccessDshRequestHeaders(upgrade, '127.0.0.1:3080'))
  assert.match(rewrittenUpgrade, /Connection: Upgrade/u)
  assert.match(rewrittenUpgrade, /Upgrade: websocket/u)
})

test('局域网代理兼容未包装 args 的 Connection RPC 请求', () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
  const decode = (value: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(value)) as unknown
  const oldBody = encode({ type: 'client-request', rpcId: 'rpc-1', method: 'session/list', payload: { _request: {} } })
  assert.deepEqual(decode(normalizeLanAccessDshRpcBody('/api/session/list', 'POST', oldBody)), {
    type: 'client-request',
    rpcId: 'rpc-1',
    method: 'session/list',
    payload: { args: { _request: {} } },
  })

  const wrapped = encode({ type: 'client-request', payload: { args: { _request: {} } } })
  assert.deepEqual(normalizeLanAccessDshRpcBody('/api/session/list', 'POST', wrapped), wrapped)
  assert.deepEqual(normalizeLanAccessDshRpcBody('/api/session/list', 'GET', oldBody), oldBody)
  assert.deepEqual(normalizeLanAccessDshRpcBody('/workspace/list', 'POST', oldBody), oldBody)
  assert.deepEqual(normalizeLanAccessDshRpcBody('/api/session/list', 'POST', encode({ payload: { _request: {} } })), encode({ payload: { _request: {} } }))
  const codingNsBody = encode({ type: 'client-request', rpcId: 'rpc-codingns', method: 'codingns/settings/get', payload: {} })
  assert.deepEqual(normalizeLanAccessDshRpcBody('/api/codingns/settings/get', 'POST', codingNsBody), codingNsBody)
})

test('局域网代理重写 RPC 正文时同步更新 Content-Length', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ type: 'client-request', rpcId: 'rpc-2', method: 'session/list', payload: { _request: {} } }))
  const request = new TextEncoder().encode([
    'POST /api/session/list HTTP/1.1',
    'Host: 10.255.0.83:13080',
    'Content-Length: ' + body.length,
    'Connection: keep-alive',
    '',
    '',
  ].join('\r\n'))
  const transform = new LanAccessDshRequestTransform('127.0.0.1:3080')
  const chunks: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    transform.on('data', (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)))
    transform.once('end', resolve)
    transform.once('error', reject)
    transform.end(new Uint8Array([...request, ...body]))
  })
  const output = new TextDecoder().decode(new Uint8Array(chunks.reduce<number[]>((all, chunk) => [...all, ...chunk], [])))
  const [head, outputBody] = output.split('\r\n\r\n', 2)
  assert.match(head ?? '', /Content-Length: \d+/u)
  assert.equal(Number(head?.match(/Content-Length: (\d+)/u)?.[1]), new TextEncoder().encode(outputBody ?? '').length)
  assert.deepEqual(JSON.parse(outputBody ?? '{}'), { type: 'client-request', rpcId: 'rpc-2', method: 'session/list', payload: { args: { _request: {} } } })
})

test('Host 模块独立登记 lanAccessDsh RPC，停用后注销', async () => {
  const table = new CodingNsRpcTable()
  const registry = new FeatureRegistry({ rpc: table })
  registry.register(createLanAccessDshFeature({ runtime: new FakeRuntime() }))
  await registry.reconcile(['lanAccessDsh'])
  assert.deepEqual(table.namespaces(), ['lanAccessDsh'])
  assert.notEqual(table.resolve('lanAccessDsh/addresses'), null)
  await registry.disable('lanAccessDsh')
  assert.deepEqual(table.namespaces(), [])
})

test('局域网访问设置通过 Host RPC 持久化并可刷新回读', async () => {
  const runtime = new FakeRuntime()
  const settings = new FakeSettings({
    controlBaseUrl: 'https://channel.codingns.com:1443',
    controlBaseUrls: ['https://channel.codingns.com:1443'],
    modules: {},
    lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0, pwa: DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS },
  })
  const handler = createLanAccessDshRpcHandler(new LanAccessDshProxy(runtime), settings)
  const next = { autoStart: true, listenHost: '192.168.1.10', listenPort: 13081, dshPort: 3080, pwa: { enabled: true, serviceWorker: true, installPrompt: false, notifications: 'push' as const } }

  assert.deepEqual(await handler('settings/get', {}), settings.get().lanAccessDsh)
  assert.deepEqual(await handler('settings/set', next), next)
  assert.deepEqual(settings.get().lanAccessDsh, next)
})

test('PWA 设置未携带时保留当前档位，显式非法枚举回落到最保守档位', async () => {
  const runtime = new FakeRuntime()
  // 移动端卡片保存过的档位：局域网卡片只改监听映射时必须原样保留。
  const savedPwa = { enabled: true, serviceWorker: true, installPrompt: false, notifications: 'local' as const }
  const settings = new FakeSettings({
    controlBaseUrl: 'https://channel.codingns.com:1443',
    controlBaseUrls: ['https://channel.codingns.com:1443'],
    modules: {},
    lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0, pwa: savedPwa },
  })
  const handler = createLanAccessDshRpcHandler(new LanAccessDshProxy(runtime), settings)
  const saved = await handler('settings/set', { autoStart: true, listenHost: '0.0.0.0', listenPort: 13081, dshPort: 0 }) as { pwa: unknown }
  assert.deepEqual(saved.pwa, savedPwa)
  const normalized = await handler('settings/set', {
    autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0,
    pwa: { enabled: true, serviceWorker: true, installPrompt: true, notifications: 'silent' },
  }) as { pwa: { notifications: string; serviceWorker: boolean } }
  assert.equal(normalized.pwa.notifications, 'off')
  assert.equal(normalized.pwa.serviceWorker, true)
})

test('PWA 状态与推送 RPC：未提供推送服务时给出稳定错误，提供后覆盖订阅全流程', async () => {
  const runtime = new FakeRuntime()
  const proxy = new LanAccessDshProxy(runtime)
  proxy.setPwaProvider(createLanAccessDshPwaProvider({ readSettings: () => ({ enabled: true, serviceWorker: true, installPrompt: true, notifications: 'push' }) }))
  const handler = createLanAccessDshRpcHandler(proxy)
  const status = await handler('pwa/status', {}) as { manifest: boolean; serviceWorker: boolean; assetPaths: readonly string[] }
  assert.equal(status.manifest, true)
  assert.equal(status.serviceWorker, true)
  assert.ok(status.assetPaths.some((path) => path.endsWith('apple-touch-icon.png')))
  await assert.rejects(() => Promise.resolve(handler('pwa/vapid', {})), /推送服务未启用/u)

  const stateDir = await mkdtemp(join(tmpdir(), 'codingns4dsh-rpc-push-'))
  const push = new PwaPushService({ stateDir })
  const handlerWithPush = createLanAccessDshRpcHandler(proxy, undefined, new InMemoryLanAccessDshLoginStore(), { push })
  const vapid = await handlerWithPush('pwa/vapid', {}) as { available: boolean; publicKey: string }
  assert.equal(vapid.available, true)
  assert.equal(Buffer.from(vapid.publicKey, 'base64url').length, 65)
  const client = createECDH('prime256v1')
  client.generateKeys()
  const subscribed = await handlerWithPush('pwa/push/subscribe', {
    endpoint: 'https://push.example.com/sub/rpc',
    keys: { p256dh: client.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    label: 'test-agent',
  }) as { subscriptions: number }
  assert.equal(subscribed.subscriptions, 1)
  assert.deepEqual(await handlerWithPush('pwa/push/status', {}), { available: true, subscriptions: 1 })
  assert.deepEqual(await handlerWithPush('pwa/push/unsubscribe', { endpoint: 'https://push.example.com/sub/rpc' }), { removed: true })
  await assert.rejects(() => Promise.resolve(handlerWithPush('pwa/push/subscribe', { endpoint: 'not-a-url', keys: {} })), /推送订阅参数无效/u)
})

test('启用登录保护时同一次 RPC 返回中继会话，避免启用后立即被新规则拦截', async () => {
  const runtime = new FakeRuntime()
  const store = new InMemoryLanAccessDshLoginStore()
  const handler = createLanAccessDshRpcHandler(new LanAccessDshProxy(runtime), undefined, store)
  const result = await handler('login/set', {
    enabled: true,
    username: 'jackson',
    password: 'password123',
    timeoutSeconds: 1800,
    scopes: { lan: true, relay: true },
  }) as { enabled: boolean; scopes: { lan: boolean; relay: boolean }; relaySession?: { token?: string } }
  assert.equal(result.enabled, true)
  assert.deepEqual(result.scopes, { lan: true, relay: true })
  assert.equal(typeof result.relaySession?.token, 'string')
})

test('登录保护中继票据可在有效期内滚动续签', async () => {
  const store = new InMemoryLanAccessDshLoginStore()
  const handler = createLanAccessDshRpcHandler(new LanAccessDshProxy(new FakeRuntime()), undefined, store)
  const result = await handler('login/set', {
    enabled: true,
    username: 'jackson',
    password: 'password123',
    timeoutSeconds: 1800,
    scopes: { lan: true, relay: true },
  }) as { relaySession: { token: string; expiresAt: string } }
  const refreshed = await handler('login/session/refresh', { token: result.relaySession.token, scope: 'relay' }) as { token: string; expiresAt: string }
  assert.notEqual(refreshed.token, result.relaySession.token)
  assert.ok(Date.parse(refreshed.expiresAt) > Date.parse(result.relaySession.expiresAt) - 1000)
  assert.equal(await verifyLoginProtectionSession(store, refreshed.token, 'relay'), true)
})

test('Host 启动时按持久化配置自动启动映射，运行中修改选项不会重启映射', async () => {
  const runtime = new FakeRuntime()
  const settings = new FakeSettings({
    controlBaseUrl: 'https://channel.codingns.com:1443',
    controlBaseUrls: ['https://channel.codingns.com:1443'],
    modules: {},
    lanAccessDsh: { autoStart: true, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 },
  })
  const services = { rpc: new CodingNsRpcTable(), settings, dshWebPort: 3080 }
  const registry = new FeatureRegistry({ ...services })
  registry.register(createLanAccessDshFeature({ runtime }))
  await registry.reconcile(['lanAccessDsh'])
  runtime.accept()
  assert.deepEqual(runtime.connected, [9080])
  assert.equal(runtime.accepted.has('0.0.0.0'), true)

  await settings.commit({ ...settings.get(), lanAccessDsh: { ...settings.get().lanAccessDsh, autoStart: false } })
  assert.deepEqual(runtime.closed, [])
  await registry.disable('lanAccessDsh')
  assert.deepEqual(runtime.closed, [13080])
})

function peerHostAuthRequest(path: string, body: unknown, authorization?: string): { method: string; path: string; headers: Record<string, string>; body: Uint8Array } {
  return {
    method: 'POST',
    path,
    headers: authorization === undefined ? {} : { authorization },
    body: new TextEncoder().encode(JSON.stringify(body ?? {})),
  }
}

function readAuthResponse(response: Uint8Array | undefined): { status: number; body: Record<string, unknown> } {
  assert.ok(response !== undefined)
  const [head, body] = new TextDecoder().decode(response).split('\r\n\r\n', 2)
  return { status: Number(/^HTTP\/1\.1 (\d+)/u.exec(head ?? '')?.[1] ?? '0'), body: JSON.parse(body ?? '{}') as Record<string, unknown> }
}

test('PeerHost 目标侧登录端点只在校验通过时签发票据', () => {
  const config = createLoginProtectionConfig({ username: 'jackson', password: 'password123', timeoutSeconds: 1800, scopes: { lan: true, relay: true } })
  const accepted = readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.login, { username: 'jackson', password: 'password123' }),
    config,
    new Set(),
  ))
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.expiresIn, 1800)
  assert.equal(typeof accepted.body.accessToken, 'string')
  assert.equal(accepted.body.accessToken, verifyPeerHostAccessToken(config, String(accepted.body.accessToken)) ? accepted.body.accessToken : '')
  assert.equal(verifyPeerHostAccessToken(config, 'forged-token'), false)
  assert.equal(verifyPeerHostAccessToken(null, 'forged-token'), true)

  assert.equal(readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.login, { username: 'jackson', password: 'wrong-password' }),
    config,
    new Set(),
  )).status, 401)
  assert.equal(readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.login, { username: 'jackson' }),
    config,
    new Set(),
  )).status, 401)

  const notProtected = readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.login, { username: 'anyone', password: 'anything' }),
    null,
    new Set(),
  ))
  assert.equal(notProtected.status, 200)
  assert.match(String(notProtected.body.accessToken), /^open\./u)
})

test('PeerHost 票据可刷新，撤销后刷新与代理校验同时失效', () => {
  const config = createLoginProtectionConfig({ username: 'jackson', password: 'password123', timeoutSeconds: 1800, scopes: { lan: true, relay: true } })
  const issued = readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.login, { username: 'jackson', password: 'password123' }),
    config,
    new Set(),
  )).body
  const refreshed = readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.refresh, { refreshToken: issued.refreshToken }),
    config,
    new Set(),
  )).body
  assert.notEqual(refreshed.accessToken, issued.accessToken)
  assert.equal(verifyPeerHostAccessToken(config, String(refreshed.accessToken)), true)

  assert.equal(readAuthResponse(resolvePeerHostAuthResponse(peerHostAuthRequest(PEER_HOST_AUTH_PATHS.refresh, {}), config, new Set())).status, 401)
  const revoked = new Set([String(refreshed.accessToken)])
  assert.equal(readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.refresh, { refreshToken: refreshed.accessToken }),
    config,
    revoked,
  )).status, 401)
  const loggedOut = readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.logout, {}, `Bearer ${String(refreshed.refreshToken)}`),
    config,
    revoked,
  ))
  assert.equal(loggedOut.status, 200)
  assert.equal(verifyPeerHostAccessToken(config, String(refreshed.refreshToken), revoked), false)
})

test('PeerHost 出站白名单只覆盖固定资源路由', () => {
  assert.equal(isPeerHostRouteRequest({ method: 'POST', path: '/api/codingns/host/status' }), true)
  assert.equal(isPeerHostRouteRequest({ method: 'POST', path: '/api/codingns/peerHost/nativeLocal' }), true)
  assert.equal(isPeerHostRouteRequest({ method: 'POST', path: '/api/codingns/cli/session/get' }), true)
  assert.equal(isPeerHostRouteRequest({ method: 'POST', path: '/api/codingns/cli/models' }), true)
  assert.equal(isPeerHostRouteRequest({ method: 'GET', path: '/api/codingns/cli/catalog' }), false)
  assert.equal(isPeerHostRouteRequest({ method: 'GET', path: '/api/workspaces' }), true)
  assert.equal(isPeerHostRouteRequest({ method: 'POST', path: '/api/workspaces' }), false)
  assert.equal(isPeerHostRouteRequest({ method: 'GET', path: '/api/admin/users' }), false)
})

test('PeerHost 发送端 HTTP 路由均可进入目标 Bearer 校验，WebSocket 保持原范围', () => {
  for (const rule of PEER_HOST_HTTP_PROXY_RULES) {
    for (const method of rule.methods) assert.equal(isPeerHostRouteRequest({ method, path: rule.prefix }), true, `${method} ${rule.prefix}`)
  }
  assert.equal(isPeerHostRouteRequest({ method: 'GET', path: '/ws' }), true)
  assert.equal(isPeerHostRouteRequest({ method: 'POST', path: '/ws' }), false)
  assert.equal(isPeerHostRouteRequest({ method: 'POST', path: '/api/codingns/debug-admin/config/get' }), false)
})

test('远端调试经过真实 LAN 登录保护：有效票据放行，缺失、伪造、撤销与越界请求拒绝', () => {
  const config = createLoginProtectionConfig({ username: 'jackson', password: 'password123', timeoutSeconds: 1800, scopes: { lan: true, relay: true } })
  const proxy = new LanAccessDshProxy({} as never)
  proxy.setLoginConfig(config)
  const issued = readAuthResponse(resolvePeerHostAuthResponse(
    peerHostAuthRequest(PEER_HOST_AUTH_PATHS.login, { username: 'jackson', password: 'password123' }), config, new Set(),
  )).body
  const token = String(issued.accessToken)
  // 只执行鉴权函数，不启动监听、不访问本机的真实凭据或服务。
  const authorize = (path: string, method: string, ticket?: string) => (proxy as unknown as {
    authorize(request: unknown, local: boolean, socket: unknown): Uint8Array | 'pass'
  }).authorize({ method, path, headers: ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }, body: new Uint8Array() }, false, { remoteAddress: '192.0.2.1' })
  const rejected = (response: Uint8Array | 'pass') => {
    assert.notEqual(response, 'pass')
    assert.match(new TextDecoder().decode(response as Uint8Array), /^HTTP\/1\.1 401 /u)
  }
  for (const path of ['/api/codingns/debug/config/get', '/api/codingns/debug/config/save', '/api/codingns/terminal/status', '/api/codingns/git/status']) {
    assert.equal(authorize(path, 'POST', token), 'pass')
    rejected(authorize(path, 'POST'))
    rejected(authorize(path, 'POST', 'forged-token'))
    rejected(authorize(path, 'GET', token))
  }
  rejected(authorize('/api/codingns/debug-admin/config/get', 'POST', token))
  rejected(authorize('/api/codingns/terminal/enable', 'POST', token))
  rejected(authorize('/api/admin/users', 'POST', token))
  assert.notEqual(authorize(PEER_HOST_AUTH_PATHS.logout, 'POST', token), 'pass')
  rejected(authorize('/api/codingns/debug/config/get', 'POST', token))
})
