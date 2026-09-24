import assert from 'node:assert/strict'
import test from 'node:test'
import { DshCodingNsTransport } from '../dist/transport/dsh-transport.js'
import { decodeTunnelFrame, encodeTunnelFrame, TUNNEL_PROTOCOL_VERSION } from '../dist/transport/frame.js'
import { decodeDshEnvelope, encodeDshEnvelope } from '../dist/transport/dsh-envelope.js'
import type { CodingNsCarrier } from '../dist/transport/carrier.js'

class FakeCarrier implements CodingNsCarrier {
  state: CodingNsCarrier['state'] = 'open'
  private listeners = new Set<(data: Uint8Array) => void>()
  sent: Uint8Array[] = []
  send(data: Uint8Array): void { this.sent.push(data) }
  subscribe(listener: (data: Uint8Array) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(data: Uint8Array): void { for (const listener of this.listeners) listener(data) }
  async close(): Promise<void> { this.state = 'closed' }
}

test('Tunnel Frame 编解码并拒绝非法版本', () => {
  const encoded = encodeTunnelFrame({ version: TUNNEL_PROTOCOL_VERSION, channel: 'rpc', id: 'x', sequence: 0, kind: 'open', payload: { method: 'ping' } })
  assert.deepEqual(decodeTunnelFrame(encoded).payload, { method: 'ping' })
  assert.throws(() => decodeTunnelFrame(JSON.stringify({ ...JSON.parse(encoded), version: 2 })), /版本不兼容/u)
})

test('DSH Transport 可通过 Fake Carrier 完成 RPC 和 Fetch', async () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({ carrier, generation: { id: 1, host: { home: '/tmp' } } })
  const rpc = transport.rpc<{ ok: boolean }, { method: string }>({ method: 'ping', payload: { method: 'ping' } })
  const rpcFrame = decodeDshEnvelope(carrier.sent[0]!)
  assert.equal(rpcFrame.type, 'stream.open')
  assert.equal(rpcFrame.meta.operation, 'rpc.request')
  carrier.emit(encodeDshEnvelope({ ...rpcFrame, type: 'rpc.response', body: new TextEncoder().encode(JSON.stringify({ ok: true })) }))
  assert.deepEqual(await rpc, { ok: true })

  const fetchPromise = transport.fetch('https://example.test/api', { method: 'GET' })
  const fetchFrame = decodeDshEnvelope(carrier.sent[1]!)
  assert.equal(fetchFrame.type, 'stream.open')
  assert.equal(fetchFrame.meta.operation, 'web.request')
  carrier.emit(encodeDshEnvelope({ ...fetchFrame, type: 'web.response', body: new TextEncoder().encode(JSON.stringify({ status: 200, headers: [['content-type', 'text/plain']], body: 'ok' })) }))
  const response = await fetchPromise
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
  await transport.close()
})

test('Tunnel Frame 拒绝超过注入上限的消息', () => {
  const frame = { version: TUNNEL_PROTOCOL_VERSION, channel: 'rpc' as const, id: 'large', sequence: 0, kind: 'data' as const, payload: 'x'.repeat(200) }
  assert.throws(() => encodeTunnelFrame(frame, { maxBytes: 64 }), /超过大小限制/u)
  assert.throws(() => decodeTunnelFrame(JSON.stringify(frame), { maxBytes: 64 }), /超过大小限制/u)
})

test('Transport 关闭时 pending RPC 和 stream waiter 都收敛', async () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({ carrier, generation: { id: 1, host: { home: '/tmp' } } })
  const rpc = transport.rpc({ method: 'pending', payload: {} })
  const stream = transport.openStream({ method: 'events', payload: {} })
  const next = stream[Symbol.asyncIterator]().next()
  await transport.close()
  await assert.rejects(rpc, /Transport 已关闭/u)
  await assert.rejects(next, /Transport 已关闭/u)
})

test('generation 更新会拒绝旧请求并隔离旧响应', async () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({ carrier, generation: { id: 1, host: { home: '/tmp' } } })
  const oldRequest = transport.rpc<{ generation: number }>({ method: 'old', payload: {} })
  const oldFrame = decodeDshEnvelope(carrier.sent[0]!)
  transport.updateGeneration({ id: 2, host: { home: '/tmp/new' } })
  await assert.rejects(oldRequest, /generation 已过期/u)

  const newRequest = transport.rpc<{ generation: number }>({ method: 'new', payload: {} })
  const newFrame = decodeDshEnvelope(carrier.sent[1]!)
  assert.match(newFrame.messageId, /^g2_/u)
  carrier.emit(encodeDshEnvelope({ ...oldFrame, type: 'rpc.response', body: new TextEncoder().encode(JSON.stringify({ generation: 1 })) }))
  carrier.emit(encodeDshEnvelope({ ...newFrame, type: 'rpc.response', body: new TextEncoder().encode(JSON.stringify({ generation: 2 })) }))
  assert.deepEqual(await newRequest, { generation: 2 })
  await transport.close()
})

test('Transport 支持注入背压窗口并拒绝不可发送帧', async () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({
    carrier,
    generation: { id: 1, host: { home: '/tmp' } },
    flowControl: { canSend: () => false },
  })
  await assert.rejects(transport.rpc({ method: 'blocked', payload: {} }), /背压窗口不足/u)
  assert.equal(carrier.sent.length, 0)
  await transport.close()
})

test('已取消的 stream 不会发送 open 帧', async () => {
  const carrier = new FakeCarrier()
  const transport = new DshCodingNsTransport({ carrier, generation: { id: 1, host: { home: '/tmp' } } })
  const controller = new AbortController()
  controller.abort()
  const stream = transport.openStream({ method: 'events', payload: {}, signal: controller.signal })
  const result = await stream[Symbol.asyncIterator]().next()
  assert.deepEqual(result, { done: true, value: undefined })
  assert.equal(carrier.sent.length, 0)
  await transport.close()
})
