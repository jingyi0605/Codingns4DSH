import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import { createLanAccessDshFeature } from '../data/build/dist/host/features/index.js'
import {
  LanAccessDshProxy,
  createLanAccessDshRpcHandler,
  normalizeLanAccessDshConfig,
  rewriteLanAccessDshRequestHeaders,
  type LanAccessDshRuntime,
  type LanAccessDshStream,
} from '../data/build/dist/host/lan-access-dsh.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import type { CodingNsSettings } from '../data/build/dist/shared/contracts/config.js'

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
    lanAccessDsh: { autoStart: false, listenHost: '0.0.0.0', listenPort: 13080, dshPort: 0 },
  })
  const handler = createLanAccessDshRpcHandler(new LanAccessDshProxy(runtime), settings)
  const next = { autoStart: true, listenHost: '192.168.1.10', listenPort: 13081, dshPort: 3080 }

  assert.deepEqual(await handler('settings/get', {}), settings.get().lanAccessDsh)
  assert.deepEqual(await handler('settings/set', next), next)
  assert.deepEqual(settings.get().lanAccessDsh, next)
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
