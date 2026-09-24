import assert from 'node:assert/strict'
import test from 'node:test'
import { DshCodingNsTransport, DshGateway, DshSession, decodeDshEnvelope, encodeDshEnvelope, type DshEnvelope } from '../dist/transport/index.js'
import { createDshRpcGatewayFeature } from '../dist/host/dsh-gateway-feature.js'
import { CodingNsRpcTable } from '../dist/host/rpc-table.js'

function carrierPair(): [{ carrier: any; connect(peer: any): void }, { carrier: any; connect(peer: any): void }] {
  const make = () => {
    const listeners = new Set<(data: Uint8Array) => void>()
    let peer: any
    const carrier = {
      state: 'open' as const,
      send(data: Uint8Array) { for (const listener of peer?.listeners ?? []) listener(new Uint8Array(data)) },
      subscribe(listener: (data: Uint8Array) => void) { listeners.add(listener); return () => listeners.delete(listener) },
      close: async () => undefined,
      listeners,
    }
    return { carrier, connect(next: any) { peer = next } }
  }
  const left = make(); const right = make(); left.connect(right.carrier); right.connect(left.carrier)
  return [left, right]
}

test('DSH Session 完成 hello/ready 协商并进入 ready', async () => {
  const [left, right] = carrierPair()
  const host = new DshSession({ carrier: left.carrier, role: 'host', generation: 'g1', hostScope: { hostId: 'h1', kind: 'local' }, capabilities: ['rpc'] })
  const client = new DshSession({ carrier: right.carrier, role: 'client', generation: 'g1', hostScope: { hostId: 'h1', kind: 'local' }, capabilities: ['rpc', 'pty'] })
  host.start(); client.start()
  await client.waitReady()
  assert.equal(host.ready, true)
  assert.deepEqual(client.capabilities, ['rpc'])
  host.close(); client.close()
})

test('DSH Gateway 按 channel/operation 路由 stream.open', async () => {
  const [hostCarrier, clientCarrier] = carrierPair()
  const hostSession = new DshSession({ carrier: hostCarrier.carrier, role: 'host', generation: '1', hostScope: { hostId: 'h1', kind: 'local' }, capabilities: ['rpc'] })
  const clientSession = new DshSession({ carrier: clientCarrier.carrier, role: 'client', generation: '1', hostScope: { hostId: 'h1', kind: 'local' }, capabilities: ['rpc'] })
  const gateway = new DshGateway({ carrier: hostCarrier.carrier, session: hostSession, generation: '1', hostScope: { hostId: 'h1', kind: 'local' }, features: [{ channel: 'rpc', operation: 'ping', handleStream: (context) => { context.send('rpc.response', { ok: true }); context.close() } }] })
  gateway.start(); clientSession.start()
  await clientSession.waitReady()
  const replies: DshEnvelope[] = []
  clientSession.subscribe((envelope) => replies.push(envelope))
  clientSession.send({ version: 1, messageId: 'm1', streamId: 's1', channel: 'rpc', type: 'stream.open', sequence: 1, generation: '1', hostScope: { hostId: 'h1', kind: 'local' }, meta: { operation: 'ping' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(replies.some((item) => item.type === 'stream.accepted'))
  assert.ok(replies.some((item) => item.type === 'rpc.response'))
  await gateway.close(); clientSession.close()
})

test('DSH Envelope body 保持原始二进制', () => {
  const envelope: DshEnvelope = { version: 1, messageId: 'm', streamId: 's', channel: 'file', type: 'file.chunk', sequence: 0, generation: 'g1', hostScope: { hostId: 'h1', kind: 'local' }, meta: {}, body: new Uint8Array([0, 255, 1]) }
  const encoded = encodeDshEnvelope(envelope)
  assert.ok(encoded.includes(255))
})

test('DSH Transport 的 stream.open 可以被 Gateway 接受并返回 RPC response', async () => {
  const [hostCarrier, clientCarrier] = carrierPair()
  const hostSession = new DshSession({ carrier: hostCarrier.carrier, role: 'host', generation: '1', hostScope: { hostId: 'h1', kind: 'local' }, capabilities: ['rpc'] })
  const gateway = new DshGateway({
    carrier: hostCarrier.carrier,
    session: hostSession,
    generation: '1',
    hostScope: { hostId: 'h1', kind: 'local' },
    features: [{ channel: 'rpc', operation: 'rpc.request', handleStream: (context) => {
      context.send('rpc.response', { encoding: 'json' }, new TextEncoder().encode(JSON.stringify({ ok: true })))
      context.close()
    } }],
  })
  gateway.start()
  const clientSession = new DshSession({ carrier: clientCarrier.carrier, role: 'client', generation: '1', hostScope: { hostId: 'h1', kind: 'local' }, capabilities: ['rpc'] })
  clientSession.start()
  await clientSession.waitReady()
  const transport = new DshCodingNsTransport({ carrier: clientCarrier.carrier, session: clientSession, requireSessionReady: true, generation: { id: 1, host: { home: '/' } }, hostScope: { hostId: 'h1', kind: 'local' } })
  assert.deepEqual(await transport.rpc({ method: 'rpc.request', payload: { ping: true } }), { ok: true })
  await transport.close()
  await gateway.close()
  clientSession.close()
  hostSession.close()
})

test('Host RPC Gateway feature 只分发已登记的 RPC 命名空间', async () => {
  const table = new CodingNsRpcTable()
  table.register('test', async (action, payload) => ({ action, payload }))
  const feature = createDshRpcGatewayFeature(table)
  const sent: DshEnvelope[] = []
  const envelope: DshEnvelope = {
      version: 1,
      messageId: 'm',
      streamId: 's',
      channel: 'rpc' as const,
      type: 'stream.open',
      sequence: 0,
      generation: '1',
      hostScope: { hostId: 'h1', kind: 'local' as const },
      meta: { operation: 'rpc.request', encoding: 'json' },
      body: new TextEncoder().encode(JSON.stringify({ method: 'test/run', payload: { ok: true } })),
  }
  const context = {
    envelope,
    session: undefined as never,
    send(type: string, meta: Record<string, unknown> = {}, body?: Uint8Array) {
      sent.push({
        ...envelope,
        messageId: `${type}-1`,
        type,
        meta,
        ...(body === undefined ? {} : { body }),
      })
    },
    close() {},
  }
  await feature.handleStream?.(context)
  assert.equal(sent[0]?.type, 'rpc.response')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(sent[0]?.body)), { action: 'run', payload: { ok: true } })
})
