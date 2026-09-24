import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bindDshConnection,
  createDshClientTransportHooks,
  createDshGenerationSource,
  installDshTransport,
} from '../data/build/dist/bootstrap/dsh-connection-adapter.js'
import { DshCodingNsTransport } from '../data/build/dist/transport/dsh-transport.js'
import type { CodingNsCarrier } from '../data/build/dist/transport/carrier.js'
import { decodeDshEnvelope, encodeDshEnvelope } from '../data/build/dist/transport/dsh-envelope.js'

class FakeCarrier implements CodingNsCarrier {
  state: CodingNsCarrier['state'] = 'open'
  sent: Uint8Array[] = []
  private listeners = new Set<(data: Uint8Array) => void>()
  send(data: Uint8Array): void { this.sent.push(data) }
  subscribe(listener: (data: Uint8Array) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(data: Uint8Array): void { for (const listener of this.listeners) listener(data) }
  async close(): Promise<void> { this.state = 'closed' }
}

test('适配层将 DSH rpc.call 路由映射到 CodingNS Transport', async () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({ carrier, generation: { id: 1, host: { home: '/tmp' } } })
  const hooks = createDshClientTransportHooks(transport)
  const resultPromise = hooks.rpc.call('/api', 'ping', { ok: true })
  const frame = decodeDshEnvelope(carrier.sent[0]!)
  carrier.emit(encodeDshEnvelope({ ...frame, type: 'rpc.response', body: new TextEncoder().encode(JSON.stringify({ pong: true })) }))
  assert.deepEqual(await resultPromise, { ok: true, value: { pong: true } })
  await transport.close()
})

test('generation source 首次 ready，generation 失效后结束', async () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({ carrier, generation: { id: 3, host: { home: '/workspace' } } })
  const source = createDshGenerationSource(transport)
  const controller = new AbortController()
  let host: { home: string } | undefined
  let ended = false
  const running = source(controller.signal, (next) => { host = next })
    .then(() => { ended = true })
  await Promise.resolve()
  assert.deepEqual(host, { home: '/workspace' })
  await transport.close()
  await running
  assert.equal(ended, true)
})

test('bindDshConnection 注册 source、启动 loop，并在 dispose 时停止和关闭 Transport', async () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({ carrier, generation: { id: 4, host: { home: '/tmp' } }, reconnect: async () => {} })
  let source: ((signal: AbortSignal, ready: (host: { home: string }) => void) => Promise<void>) | undefined
  let started = false
  let stopped = false
  let reconnects = 0
  const ctx = {
    connection: {
      registerGenerationSource(next: typeof source) {
        source = next
        return () => { source = undefined }
      },
      start(sinks: { onReconnectRequested?: () => void }) {
        started = true
        sinks.onReconnectRequested?.()
        reconnects++
        return { stop: () => { stopped = true } }
      },
    },
    effect() { return undefined },
  }
  const dispose = bindDshConnection(ctx, transport)
  assert.equal(started, true)
  assert.equal(reconnects, 1)
  assert.notEqual(source, undefined)
  await dispose()
  assert.equal(stopped, true)
  assert.equal(carrier.state, 'closed')
})

test('版本不匹配时拒绝安装 DSH Transport', () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({ carrier, generation: { id: 5, host: { home: '/tmp' } } })
  assert.throws(
    () => installDshTransport({ dshVersion: '0.1.7', transport }),
    /不支持的 DSH 版本/u,
  )
})
