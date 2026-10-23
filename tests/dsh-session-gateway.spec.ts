import assert from 'node:assert/strict'
import test from 'node:test'
import { DshCodingNsTransport, DshGateway, DshSession, decodeDshEnvelope, encodeDshEnvelope, type DshEnvelope } from '../data/build/dist/transport/index.js'
import { createDshRpcGatewayFeature } from '../data/build/dist/host/dsh-gateway-feature.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

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

test('DSH Session 允许旧站点客户端跨应用版本握手并回显其版本', async () => {
  const [left, right] = carrierPair()
  const scope = { hostId: 'h1', kind: 'local' } as const
  const host = new DshSession({
    carrier: left.carrier,
    role: 'host',
    generation: 'g1',
    hostScope: scope,
    dshVersion: '0.2.0-rc.1',
    capabilities: ['rpc'],
  })
  const client = new DshSession({
    carrier: right.carrier,
    role: 'client',
    generation: 'g1',
    hostScope: scope,
    dshVersion: '0.1.6-alpha.2',
    capabilities: ['rpc'],
  })
  const frames: DshEnvelope[] = []
  const send = left.carrier.send.bind(left.carrier)
  left.carrier.send = (data: Uint8Array) => { frames.push(decodeDshEnvelope(data)); return send(data) }

  host.start()
  client.start()
  await client.waitReady()
  assert.equal(host.ready, true)
  const ready = frames.find((envelope) => envelope.type === 'session.ready')
  assert.equal(ready?.meta.dshVersion, '0.1.6-alpha.2')
  assert.equal(ready?.meta.hostDshVersion, '0.2.0-rc.1')
  client.close()
  host.close()
})

test('DSH Session 不再按应用版本拒绝对端', async () => {
  const [left, right] = carrierPair()
  const host = new DshSession({ carrier: left.carrier, role: 'host', generation: 'g1', hostScope: { hostId: 'h1', kind: 'local' }, dshVersion: '0.2.0-rc.1' })
  const client = new DshSession({ carrier: right.carrier, role: 'client', generation: 'g1', hostScope: { hostId: 'h1', kind: 'local' }, dshVersion: '0.2.0-rc.2' })
  host.start()
  client.start()
  await client.waitReady()
  assert.equal(host.ready, true)
  assert.equal(client.ready, true)
  client.close()
  host.close()
})

test('DSH Session 对端缺省协议版本时按 v1 放行', async () => {
  const [hostSide, clientSide] = carrierPair()
  const scope = { hostId: 'h1', kind: 'local' } as const
  const host = new DshSession({ carrier: hostSide.carrier, role: 'host', generation: 'g1', hostScope: scope })
  const frames: DshEnvelope[] = []
  const send = hostSide.carrier.send.bind(hostSide.carrier)
  hostSide.carrier.send = (data: Uint8Array) => { frames.push(decodeDshEnvelope(data)); return send(data) }
  host.start()
  clientSide.carrier.send(encodeDshEnvelope({
    version: 1,
    messageId: 'c_1',
    streamId: 'session',
    channel: 'session',
    type: 'session.hello',
    sequence: 0,
    generation: 'g1',
    hostScope: scope,
    meta: { dshVersion: '0.1.6-alpha.2', capabilities: [] },
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.ready, true)
  assert.ok(frames.some((envelope) => envelope.type === 'session.ready'))
  host.close()
})

test('DSH Session 协议不匹配时回发 session.close 原因并进入 degraded', async () => {
  const [hostSide, clientSide] = carrierPair()
  const scope = { hostId: 'h1', kind: 'local' } as const
  const host = new DshSession({ carrier: hostSide.carrier, role: 'host', generation: 'g1', hostScope: scope })
  const frames: DshEnvelope[] = []
  const send = hostSide.carrier.send.bind(hostSide.carrier)
  hostSide.carrier.send = (data: Uint8Array) => { frames.push(decodeDshEnvelope(data)); return send(data) }
  host.start()
  clientSide.carrier.send(encodeDshEnvelope({
    version: 1,
    messageId: 'c_1',
    streamId: 'session',
    channel: 'session',
    type: 'session.hello',
    sequence: 0,
    generation: 'g1',
    hostScope: scope,
    meta: { protocol: 'dsh-transport-v2', dshVersion: '0.2.0-rc.1', capabilities: [] },
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.state, 'degraded')
  const close = frames.find((envelope) => envelope.type === 'session.close')
  assert.equal(close?.meta.reason, 'PROTOCOL_VERSION_UNSUPPORTED')
  host.close()
})

test('DSH Session 客户端拒绝协议不匹配的 ready 并回发 close 原因', async () => {
  const [hostSide, clientSide] = carrierPair()
  const scope = { hostId: 'h1', kind: 'local' } as const
  const client = new DshSession({ carrier: clientSide.carrier, role: 'client', generation: 'g1', hostScope: scope })
  const frames: DshEnvelope[] = []
  const send = clientSide.carrier.send.bind(clientSide.carrier)
  clientSide.carrier.send = (data: Uint8Array) => { frames.push(decodeDshEnvelope(data)); return send(data) }
  client.start()
  hostSide.carrier.send(encodeDshEnvelope({
    version: 1,
    messageId: 'h_1',
    streamId: 'session',
    channel: 'session',
    type: 'session.ready',
    sequence: 0,
    generation: 'g1',
    hostScope: scope,
    meta: { protocol: 'dsh-transport-v2', dshVersion: '0.2.0-rc.1', capabilities: [] },
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(client.state, 'degraded')
  await assert.rejects(client.waitReady(), /PROTOCOL_VERSION_UNSUPPORTED/)
  const close = frames.find((envelope) => envelope.type === 'session.close')
  assert.equal(close?.meta.reason, 'PROTOCOL_VERSION_UNSUPPORTED')
  client.close()
})

test('Host Session 首个 hello 采用 Client generation，重连 generation 不再被误判过期', async () => {
  const [left, right] = carrierPair()
  const host = new DshSession({ carrier: left.carrier, role: 'host', generation: '1', hostScope: { hostId: 'h1', kind: 'local' }, acceptInitialGeneration: true })
  const client = new DshSession({ carrier: right.carrier, role: 'client', generation: '2', hostScope: { hostId: 'h1', kind: 'local' } })
  host.start(); client.start()
  await client.waitReady()
  assert.equal(host.generation, '2')
  assert.equal(host.ready, true)
  host.close(); client.close()
})

test('DSH Gateway 跟随首个 hello 的 generation 路由重连后的 stream', async () => {
  const [hostCarrier, clientCarrier] = carrierPair()
  const gateway = new DshGateway({
    carrier: hostCarrier.carrier,
    generation: '1',
    hostScope: { hostId: 'h1', kind: 'local' },
    features: [{ channel: 'rpc', operation: 'ping', handleStream: (context) => { context.send('rpc.response', { ok: true }); context.close() } }],
  })
  const client = new DshSession({ carrier: clientCarrier.carrier, role: 'client', generation: '2', hostScope: { hostId: 'h1', kind: 'local' } })
  gateway.start(); client.start()
  await client.waitReady()
  assert.equal(gateway.session.generation, '2')
  const replies: DshEnvelope[] = []
  client.subscribe((envelope) => replies.push(envelope))
  client.send({ version: 1, messageId: 'reconnect-open', streamId: 'reconnect-stream', channel: 'rpc', type: 'stream.open', sequence: 1, generation: '2', hostScope: { hostId: 'h1', kind: 'local' }, meta: { operation: 'ping' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(replies.some((item) => item.type === 'rpc.response'))
  await gateway.close(); client.close()
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

test('DSH Gateway 的 handleStream 自然返回时自动释放流配额', async () => {
  const [hostCarrier, clientCarrier] = carrierPair()
  const hostSession = new DshSession({ carrier: hostCarrier.carrier, role: 'host', generation: '1', hostScope: { hostId: 'h1', kind: 'local' } })
  const clientSession = new DshSession({ carrier: clientCarrier.carrier, role: 'client', generation: '1', hostScope: { hostId: 'h1', kind: 'local' } })
  const gateway = new DshGateway({
    carrier: hostCarrier.carrier,
    session: hostSession,
    generation: '1',
    hostScope: { hostId: 'h1', kind: 'local' },
    maxStreams: 1,
    features: [{ channel: 'rpc', operation: 'ping', handleStream: (context) => { context.send('rpc.response', { ok: true }) } }],
  })
  const replies: DshEnvelope[] = []
  gateway.start(); clientSession.start(); await clientSession.waitReady()
  clientSession.subscribe((envelope) => replies.push(envelope))
  const scope = { hostId: 'h1', kind: 'local' as const }
  const open = (streamId: string): void => clientSession.send({ version: 1, messageId: `${streamId}-open`, streamId, channel: 'rpc', type: 'stream.open', sequence: 1, generation: '1', hostScope: scope, meta: { operation: 'ping' } })
  open('first')
  await new Promise((resolve) => setImmediate(resolve))
  open('second')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(replies.some((item) => item.streamId === 'first' && item.type === 'stream.close'))
  assert.equal(replies.some((item) => item.streamId === 'second' && item.type === 'stream.error' && item.meta.errorCode === 'FLOW_CONTROL_INVALID'), false)
  await gateway.close(); clientSession.close(); hostSession.close()
})

test('DSH Gateway 不会把已接受但仍在处理的流重复计入配额', async () => {
  const [hostCarrier, clientCarrier] = carrierPair()
  const hostSession = new DshSession({ carrier: hostCarrier.carrier, role: 'host', generation: '1', hostScope: { hostId: 'h1', kind: 'local' } })
  const clientSession = new DshSession({ carrier: clientCarrier.carrier, role: 'client', generation: '1', hostScope: { hostId: 'h1', kind: 'local' } })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const gateway = new DshGateway({
    carrier: hostCarrier.carrier,
    session: hostSession,
    generation: '1',
    hostScope: { hostId: 'h1', kind: 'local' },
    maxStreams: 2,
    features: [{
      channel: 'rpc',
      operation: 'held',
      handleStream: async (context) => {
        await held
        context.close()
      },
    }],
  })
  const replies: DshEnvelope[] = []
  gateway.start(); clientSession.start(); await clientSession.waitReady()
  clientSession.subscribe((envelope) => replies.push(envelope))
  const scope = { hostId: 'h1', kind: 'local' as const }
  const open = (streamId: string): void => clientSession.send({ version: 1, messageId: `${streamId}-open`, streamId, channel: 'rpc', type: 'stream.open', sequence: 1, generation: '1', hostScope: scope, meta: { operation: 'held' } })
  open('first')
  await new Promise((resolve) => setImmediate(resolve))
  open('second')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(replies.filter((item) => item.type === 'stream.accepted').length, 2)
  assert.equal(replies.some((item) => item.type === 'stream.error' && item.meta.errorCode === 'FLOW_CONTROL_INVALID'), false)
  release()
  await new Promise((resolve) => setImmediate(resolve))
  await gateway.close(); clientSession.close(); hostSession.close()
})

test('DSH Gateway 在异步 stream.open 期间不会丢失 stream.cancel', async () => {
  const [hostCarrier, clientCarrier] = carrierPair()
  const hostSession = new DshSession({ carrier: hostCarrier.carrier, role: 'host', generation: '1', hostScope: { hostId: 'h1', kind: 'local' } })
  const clientSession = new DshSession({ carrier: clientCarrier.carrier, role: 'client', generation: '1', hostScope: { hostId: 'h1', kind: 'local' } })
  let started = 0
  const gateway = new DshGateway({
    carrier: hostCarrier.carrier,
    session: hostSession,
    generation: '1',
    hostScope: { hostId: 'h1', kind: 'local' },
    maxStreams: 1,
    features: [{
      channel: 'web',
      operation: 'web.ws.open',
      canHandle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return true
      },
      handleStream: async (context) => {
        started += 1
        await new Promise((resolve) => setTimeout(resolve, 50))
        context.close()
      },
    }],
  })
  gateway.start(); clientSession.start(); await clientSession.waitReady()
  const scope = { hostId: 'h1', kind: 'local' as const }
  const open = (streamId: string, type: 'stream.open' | 'stream.cancel'): void => clientSession.send({ version: 1, messageId: `${streamId}-${type}`, streamId, channel: 'web', type, sequence: 1, generation: '1', hostScope: scope, meta: { operation: 'web.ws.open' } })
  open('cancelled', 'stream.open')
  open('cancelled', 'stream.cancel')
  await new Promise((resolve) => setTimeout(resolve, 40))
  open('next', 'stream.open')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(started, 1)
  await gateway.close(); clientSession.close(); hostSession.close()
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

test('Host RPC Gateway forwards async RPC results as incremental chunks', async () => {
  const table = new CodingNsRpcTable()
  table.register('test', () => (async function* () {
    yield { part: 'usage' }
    yield { part: 'quotas' }
  })())
  const feature = createDshRpcGatewayFeature(table)
  const sent: DshEnvelope[] = []
  const envelope: DshEnvelope = {
    version: 1, messageId: 'stream-message', streamId: 'stream-1', channel: 'rpc', type: 'stream.open',
    sequence: 0, generation: '1', hostScope: { hostId: 'h1', kind: 'local' },
    meta: { operation: 'rpc.stream', encoding: 'json' },
    body: new TextEncoder().encode(JSON.stringify({ method: 'test/dashboard', payload: {} })),
  }
  const context = {
    envelope,
    session: undefined as never,
    send(type: string, meta: Record<string, unknown> = {}, body?: Uint8Array) {
      sent.push({ ...envelope, messageId: `${type}-${sent.length}`, type, meta, ...(body === undefined ? {} : { body }) })
    },
    close() {},
  }
  await feature.handleStream?.(context)
  assert.deepEqual(sent.map(frame => frame.type), ['rpc.chunk', 'rpc.chunk'])
  assert.deepEqual(sent.map(frame => JSON.parse(new TextDecoder().decode(frame.body))), [{ part: 'usage' }, { part: 'quotas' }])
})

test('Host RPC Gateway aborts a streaming handler when the DSH stream is cancelled', async () => {
  const table = new CodingNsRpcTable()
  let requestSignal: AbortSignal | undefined
  let enteredNext: (() => void) | undefined
  const nextStarted = new Promise<void>(resolve => { enteredNext = resolve })
  table.register('test', (_action, _payload, context) => {
    requestSignal = (context as { readonly signal?: AbortSignal }).signal
    return (async function* () {
      yield { index: 0 }
      enteredNext?.()
      await new Promise<void>(resolve => requestSignal?.addEventListener('abort', () => resolve(), { once: true }))
      yield { index: 1 }
    })()
  })
  const feature = createDshRpcGatewayFeature(table)
  const sent: DshEnvelope[] = []
  const envelope: DshEnvelope = {
    version: 1, messageId: 'cancel-message', streamId: 'stream-cancel', channel: 'rpc', type: 'stream.open',
    sequence: 0, generation: '1', hostScope: { hostId: 'h1', kind: 'local' },
    meta: { operation: 'rpc.stream', encoding: 'json' },
    body: new TextEncoder().encode(JSON.stringify({ method: 'test/dashboard', payload: {} })),
  }
  const context = {
    envelope,
    session: undefined as never,
    send(type: string, meta: Record<string, unknown> = {}, body?: Uint8Array) {
      sent.push({ ...envelope, messageId: `${type}-${sent.length}`, type, meta, ...(body === undefined ? {} : { body }) })
    },
    close() {},
  }
  const pending = feature.handleStream?.(context)
  await nextStarted
  feature.handleMessage?.(context, { ...envelope, type: 'stream.cancel' })
  await pending
  assert.equal(requestSignal?.aborted, true)
  assert.deepEqual(sent.filter(frame => frame.type === 'rpc.chunk').map(frame => JSON.parse(new TextDecoder().decode(frame.body))), [{ index: 0 }])
})

test('DSH Session 发送失败会收敛物理线路，并向对端说明原因', async () => {
  // 只改本地状态的失败会让对端在死线路上等一个永远不来的响应：中继页面的原生
  // 设置 describe 就是这么永久停在 loading 的（页面空白且没有报错）。
  const [left, right] = carrierPair()
  const closed: (string | undefined)[] = []
  const errors: Error[] = []
  const originalSend = left.carrier.send.bind(left.carrier)
  let failuresRemaining = 0
  left.carrier.send = (data: Uint8Array) => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      return Promise.reject(new Error('DataChannel 背压等待超时'))
    }
    return originalSend(data) ?? Promise.resolve()
  }
  left.carrier.close = async (reason?: string) => { closed.push(reason) }
  const scope = { hostId: 'h1', kind: 'local' } as const
  const host = new DshSession({
    carrier: left.carrier,
    role: 'host',
    generation: 'g1',
    hostScope: scope,
    capabilities: ['rpc'],
    onError: (error) => { errors.push(error) },
  })
  const client = new DshSession({
    carrier: right.carrier,
    role: 'client',
    generation: 'g1',
    hostScope: scope,
    capabilities: ['rpc'],
  })
  try {
    host.start()
    client.start()
    await client.waitReady()

    failuresRemaining = 1
    host.send({
      version: 1,
      messageId: 'h_probe',
      streamId: 'probe',
      channel: 'rpc',
      type: 'rpc.response',
      sequence: 99,
      generation: 'g1',
      hostScope: scope,
      meta: {},
      body: new Uint8Array([1, 2, 3]),
    })
    await new Promise((resolve) => setTimeout(resolve, 5))

    assert.equal(errors.length, 1)
    assert.match(errors[0]?.message ?? '', /背压等待超时/u)
    assert.equal(closed.length, 1)
    assert.match(closed[0] ?? '', /DSH Session 失败/u)
    // 对端必须收到 session.close，而不是继续等一个不会来的响应。
    assert.equal(client.state, 'closed')
  } finally {
    host.close()
    client.close()
  }
})
