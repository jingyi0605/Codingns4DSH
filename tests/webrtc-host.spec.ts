import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptWebRtcHost,
  createHostSignalingTicketRequest,
  requestHostSignalingTicket,
  type HostPeerConnectionLike,
} from '../data/build/dist/transport/index.js'
import {
  adaptWeriftPeerConnection,
  type WeriftPeerConnectionLike,
} from '../data/build/dist/host/index.js'

function ticket() {
  return {
    ticket: 'host-ticket',
    expiresAt: '2026-09-21T00:01:00.000Z',
    signalingBaseUrl: 'https://relay.example.com',
    iceServers: [{ urls: 'stun:stun.example.com:3478' }],
    iceTransportPolicy: 'all' as const,
    hostDtlsFingerprint: 'SHA-256 AA:BB:CC',
    bindingId: 'binding-1',
    tunnelDomain: 'host.example',
    trafficRemainingBytes: '0',
    credentialVersion: 3,
  }
}

test('Host ticket DTO 校验 binding、fingerprint 和 credentialVersion 边界', () => {
  assert.deepEqual(createHostSignalingTicketRequest({
    bindingId: ' binding-1 ',
    hostDtlsFingerprint: ' SHA-256 AA:BB:CC ',
    credentialVersion: 3,
  }), {
    bindingId: 'binding-1',
    hostDtlsFingerprint: 'SHA-256 AA:BB:CC',
    credentialVersion: 3,
  })
  assert.throws(() => createHostSignalingTicketRequest({ bindingId: '', hostDtlsFingerprint: 'x' }), /bindingId/u)
  assert.throws(() => createHostSignalingTicketRequest({ bindingId: 'b', hostDtlsFingerprint: 'x\n' }), /fingerprint/u)
  assert.throws(() => createHostSignalingTicketRequest({ bindingId: 'b', hostDtlsFingerprint: 'x', credentialVersion: 0 }), /credentialVersion/u)
})

test('Host acceptor 为每个客户端 offer 创建 answer，并接管 DataChannel carrier', async () => {
  const listeners = new Map<string, (event: Event) => void>()
  const sent: Array<Record<string, unknown>> = []
  const socket = {
    send(data: string) { sent.push(JSON.parse(data) as Record<string, unknown>) },
    close() {},
    addEventListener(type: string, listener: (event: Event) => void) { listeners.set(type, listener) },
    removeEventListener(type: string) { listeners.delete(type) },
  }
  const channelListeners = new Map<string, (event: Event) => void>()
  const channel = {
    readyState: 'open',
    send() {},
    close() {},
    addEventListener(type: string, listener: (event: Event) => void) { channelListeners.set(type, listener) },
    removeEventListener(type: string) { channelListeners.delete(type) },
  }
  let peer: HostPeerConnectionLike
  const peerListeners = new Map<string, (event: Event) => void>()
  let remoteSdp = ''
  let closed = false
  const candidates: string[] = []
  peer = {
    connectionState: 'connected',
    onicecandidate: null,
    ondatachannel: null,
    createAnswer: async () => ({ type: 'answer' as const, sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n' }),
    setRemoteDescription: async (description) => { remoteSdp = description.sdp },
    setLocalDescription: async () => {},
    addIceCandidate: async (candidate) => { candidates.push(candidate.candidate) },
    addEventListener: (type, listener) => { peerListeners.set(type, listener) },
    removeEventListener: (type) => { peerListeners.delete(type) },
    close: () => { closed = true },
  }
  const carriers: unknown[] = []
  const closedSessions: string[] = []
  const host = await acceptWebRtcHost({
    signalingTicket: ticket(),
    signalingSocketFactory: () => socket,
    peerConnectionFactory: () => peer,
    onConnection: (connection) => { carriers.push(connection.carrier) },
    onSessionClosed: (sessionId) => { closedSessions.push(sessionId) },
  })
  listeners.get('message')?.({ data: JSON.stringify({
    type: 'candidate', candidate: 'candidate:early', mid: '0', senderRole: 'client', sessionId: 'session-1',
  }) } as MessageEvent<string>)
  listeners.get('message')?.({ data: JSON.stringify({
    type: 'offer', sdp: 'v=0\r\no=client\r\n', senderRole: 'client', sessionId: 'session-1',
  }) } as MessageEvent<string>)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(remoteSdp, 'v=0\r\no=client\r\n')
  assert.deepEqual(candidates, ['candidate:early'])
  assert.deepEqual(sent, [{ type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n', sessionId: 'session-1' }])
  peer.ondatachannel?.({ channel })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.sessions.size, 1)
  assert.equal(carriers.length, 1)
  peer.connectionState = 'disconnected'
  peerListeners.get('connectionstatechange')?.({} as Event)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(host.sessions.size, 1)
  peer.connectionState = 'failed'
  peerListeners.get('connectionstatechange')?.({} as Event)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.sessions.size, 0)
  assert.deepEqual(closedSessions, ['session-1'])
  channelListeners.get('close')?.({} as Event)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.sessions.size, 0)
  assert.deepEqual(closedSessions, ['session-1'])
  await host.close()
  assert.equal(closed, true)
  assert.equal(host.sessions.size, 0)
})

test('Host ticket 请求委托给 Control API 并保留 credentialVersion', async () => {
  let received: unknown
  const result = await requestHostSignalingTicket({
    createSignalingTicket: async (_token, request) => {
      received = request
      return ticket()
    },
  }, 'access-token', { bindingId: 'binding-1', hostDtlsFingerprint: 'SHA256:AA:BB:CC', credentialVersion: 3 })
  assert.equal(result.bindingId, 'binding-1')
  assert.deepEqual(received, { bindingId: 'binding-1', hostDtlsFingerprint: 'SHA256:AA:BB:CC', credentialVersion: 3 })
})

function createWeriftPeerStub(overrides: Partial<WeriftPeerConnectionLike> = {}) {
  let connectCalls = 0
  const peer: WeriftPeerConnectionLike & { connectCalls: number } = {
    connectionState: 'new',
    iceConnectionState: 'new',
    onicecandidate: null,
    ondatachannel: null,
    createAnswer: async () => ({ sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n' }),
    setRemoteDescription: async () => {},
    setLocalDescription: async () => {},
    addIceCandidate: async () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    close: () => {},
    connect: async () => { connectCalls += 1 },
    get connectCalls() { return connectCalls },
    ...overrides,
  }
  return peer
}

test('首个本地候选出现即提前 connect，绕开 STUN 收集的 5s 等待', async () => {
  // werift 的 setLocalDescription(answer) 会先 await gatherCandidates() 再 connect()，
  // STUN 不可达时要等满 5s 才建连。适配层必须在首个本地候选出现时提前 connect()。
  const peer = createWeriftPeerStub()
  const adapted = adaptWeriftPeerConnection(peer)
  const seen: unknown[] = []
  adapted.onicecandidate = (event) => { seen.push(event) }
  await adapted.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\n' })
  const emit = peer.onicecandidate as (event: unknown) => void
  // 没有候选的 icecandidate（收集结束）绝不能触发 connect。
  emit({ type: 'icecandidate', candidate: undefined })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(peer.connectCalls, 0, '零候选时不得调用 connect')
  emit({ type: 'icecandidate', candidate: { candidate: 'candidate:1' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(peer.connectCalls, 1)
  assert.equal(seen.length, 2, '原始 onicecandidate 回调必须继续收到全部事件')
  // 后续候选与 werift 自己的收尾 connect() 都不能重复握手。
  emit({ type: 'icecandidate', candidate: { candidate: 'candidate:2' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(peer.connectCalls, 1, 'connect 只能调用一次')
})

test('remote description 就绪前不提前 connect', async () => {
  // iceTransport.start() 缺 remoteParams 会直接抛错，因此必须等 setRemoteDescription。
  const peer = createWeriftPeerStub()
  const adapted = adaptWeriftPeerConnection(peer)
  adapted.onicecandidate = () => {}
  const emit = peer.onicecandidate as (event: unknown) => void
  emit({ type: 'icecandidate', candidate: { candidate: 'candidate:1' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(peer.connectCalls, 0)
  await adapted.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\n' })
  emit({ type: 'icecandidate', candidate: { candidate: 'candidate:1' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(peer.connectCalls, 1)
})

test('提前 connect 抛错不会影响主流程', async () => {
  const peer = createWeriftPeerStub({ connect: async () => { throw new Error('boom') } })
  const adapted = adaptWeriftPeerConnection(peer)
  adapted.onicecandidate = () => {}
  await adapted.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\n' })
  const emit = peer.onicecandidate as (event: unknown) => void
  emit({ type: 'icecandidate', candidate: { candidate: 'candidate:1' } })
  await new Promise((resolve) => setImmediate(resolve))
  // 仍可继续走正常 answer 流程。
  assert.equal((await adapted.createAnswer()).type, 'answer')
})

test('缺少 private connect 时适配层退化为原行为', async () => {
  const peer = createWeriftPeerStub()
  delete (peer as { connect?: unknown }).connect
  const adapted = adaptWeriftPeerConnection(peer)
  adapted.onicecandidate = () => {}
  await adapted.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\n' })
  const emit = peer.onicecandidate as (event: unknown) => void
  assert.doesNotThrow(() => emit({ type: 'icecandidate', candidate: { candidate: 'candidate:1' } }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await adapted.createAnswer()).type, 'answer')
})
