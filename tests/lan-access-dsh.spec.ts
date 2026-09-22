import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureRegistry } from '../dist/features/index.js'
import { createLanAccessDshFeature } from '../dist/host/features/index.js'
import {
  LanAccessDshProxy,
  normalizeLanAccessDshConfig,
  type LanAccessDshRuntime,
  type LanAccessDshStream,
} from '../dist/host/lan-access-dsh.js'
import { CodingNsRpcTable } from '../dist/host/rpc-table.js'

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

test('配置只包含监听地址、监听端口和 DSH 本地端口', () => {
  assert.deepEqual(normalizeLanAccessDshConfig({ listenHost: '0.0.0.0', listenPort: 13080, dshPort: 9080 }), { listenHost: '0.0.0.0', listenPort: 13080, dshPort: 9080 })
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
