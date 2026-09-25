import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptWebRtcHost,
  createHostSignalingTicketRequest,
  requestHostSignalingTicket,
  type HostPeerConnectionLike,
} from '../data/build/dist/transport/index.js'

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
  let remoteSdp = ''
  let closed = false
  const candidates: string[] = []
  peer = {
    onicecandidate: null,
    ondatachannel: null,
    createAnswer: async () => ({ type: 'answer' as const, sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n' }),
    setRemoteDescription: async (description) => { remoteSdp = description.sdp },
    setLocalDescription: async () => {},
    addIceCandidate: async (candidate) => { candidates.push(candidate.candidate) },
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
