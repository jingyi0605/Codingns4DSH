import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertDtlsFingerprint,
  connectWebRtcClient,
  createSignalingUrl,
  extractDtlsFingerprint,
} from '../data/build/dist/transport/index.js'

test('信令 URL 使用 /signal 和 ticket 查询参数', () => {
  assert.equal(createSignalingUrl('https://relay.example.com', 'ticket.demo'), 'wss://relay.example.com/signal?ticket=ticket.demo')
})

test('DTLS fingerprint 提取和校验拒绝错误指纹', () => {
  const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n'
  assert.equal(extractDtlsFingerprint(sdp), 'aabbcc')
  assert.doesNotThrow(() => assertDtlsFingerprint('SHA256:AA:BB:CC', sdp))
  assert.throws(() => assertDtlsFingerprint('SHA256:AA:BB:DD', sdp), /fingerprint/u)
})

test('WebRTC Connector 按 offer、answer、fingerprint 顺序建立 Carrier', async () => {
  const socketListeners = new Map<string, (event: Event) => void>()
  const socket = {
    send(data: string) {
      const message = JSON.parse(data) as { type: string }
      if (message.type === 'offer') queueMicrotask(() => {
        socketListeners.get('message')?.({ data: JSON.stringify({ type: 'candidate', candidate: 'candidate:1', mid: '0', senderRole: 'host', sessionId: 'session-1' }) } as MessageEvent<string>)
        socketListeners.get('message')?.({ data: JSON.stringify({ type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n', senderRole: 'host', sessionId: 'session-1' }) } as MessageEvent<string>)
      })
    },
    close() {},
    addEventListener(type: string, listener: (event: Event) => void) { socketListeners.set(type, listener) },
    removeEventListener(type: string) { socketListeners.delete(type) },
  }
  const channelListeners = new Map<string, (event: Event) => void>()
  const channel = {
    readyState: 'open',
    send() {},
    close() {},
    addEventListener(type: string, listener: (event: Event) => void) { channelListeners.set(type, listener) },
    removeEventListener(type: string) { channelListeners.delete(type) },
  }
  const candidates: string[] = []
  const peer = {
    onicecandidate: null,
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer' as const, sdp: 'v=0\r\n' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async (candidate: { candidate: string }) => { candidates.push(candidate.candidate) },
    close() {},
  }
  const connection = await connectWebRtcClient({
    signalingTicket: {
      ticket: 'ticket', expiresAt: '2026-09-21T00:01:00.000Z',
      signalingBaseUrl: 'https://relay.example.com',
      iceServers: [{ urls: 'stun:stun.example.com:3478' }], iceTransportPolicy: 'all',
      hostDtlsFingerprint: 'SHA256:AA:BB:CC', bindingId: 'binding-1', tunnelDomain: 'host.example',
      trafficRemainingBytes: '0',
    },
    signalingSocketFactory: () => socket,
    peerConnectionFactory: () => peer,
  })
  assert.equal(connection.carrier.state, 'open')
  assert.deepEqual(candidates, ['candidate:1'])
  await connection.close()
})
