import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertDtlsFingerprint,
  connectWebRtcClient,
  createSignalingUrl,
  extractDtlsFingerprint,
} from '../data/build/dist/transport/index.js'

/**
 * 真实 WebSocket 允许同一事件类型挂多个监听。旧的测试替身每类只存一个监听，
 * 掩盖了「候选监听被 answer 监听覆盖」这类问题，因此这里按类型存监听集合。
 */
function createEventTargetStub() {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  return {
    addEventListener(type: string, listener: (event: Event) => void) {
      const set = listeners.get(type) ?? new Set<(event: Event) => void>()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener)
    },
    emit(type: string, event: Event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
    },
    count(type: string) { return listeners.get(type)?.size ?? 0 },
  }
}

function createSocketStub(options: {
  onFirstMessageListener?: (emit: (message: unknown) => void) => void
} = {}) {
  const target = createEventTargetStub()
  let notified = false
  return {
    ...target,
    send(data: string) {
      const message = JSON.parse(data) as { type: string }
      if (message.type !== 'offer') return
      queueMicrotask(() => {
        target.emit('message', {
          data: JSON.stringify({ type: 'candidate', candidate: 'candidate:1', mid: '0', senderRole: 'host', sessionId: 'session-1' }),
        } as MessageEvent<string>)
        target.emit('message', {
          data: JSON.stringify({ type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n', senderRole: 'host', sessionId: 'session-1' }),
        } as MessageEvent<string>)
      })
    },
    close() {},
    addEventListener(type: string, listener: (event: Event) => void) {
      target.addEventListener(type, listener)
      if (type !== 'message' || notified || !options.onFirstMessageListener) return
      notified = true
      // 模拟 Relay 把 registered 与 peer-ready 连续下发（同一个事件循环轮次）。
      queueMicrotask(() => options.onFirstMessageListener?.((message) => {
        target.emit('message', { data: JSON.stringify(message) } as MessageEvent<string>)
      }))
    },
    removeEventListener: target.removeEventListener,
  }
}

function createChannelStub() {
  const target = createEventTargetStub()
  return {
    ...target,
    readyState: 'open' as const,
    send() {},
    close() {},
  }
}

function createPeerStub(channel: ReturnType<typeof createChannelStub>, candidates: string[]) {
  const target = createEventTargetStub()
  return {
    ...target,
    onicecandidate: null as unknown,
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer' as const, sdp: 'v=0\r\n' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate: async (candidate: { candidate: string }) => { candidates.push(candidate.candidate) },
    close() {},
  }
}

function ticket() {
  return {
    ticket: 'ticket', expiresAt: '2026-09-21T00:01:00.000Z',
    signalingBaseUrl: 'https://relay.example.com',
    iceServers: [{ urls: 'stun:stun.example.com:3478' }], iceTransportPolicy: 'all' as const,
    hostDtlsFingerprint: 'SHA256:AA:BB:CC', bindingId: 'binding-1', tunnelDomain: 'host.example',
    trafficRemainingBytes: '0',
  }
}

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
  const socket = createSocketStub()
  const channel = createChannelStub()
  const candidates: string[] = []
  const peer = createPeerStub(channel, candidates)
  const connection = await connectWebRtcClient({
    signalingTicket: ticket(),
    signalingSocketFactory: () => socket,
    peerConnectionFactory: () => peer,
  })
  assert.equal(connection.carrier.state, 'open')
  assert.deepEqual(candidates, ['candidate:1'])
  await connection.close()
})

test('answer 之后到达的候选仍会被应用（Host 先发 answer 再收集候选）', async () => {
  // Host 现在先发 answer 再 setLocalDescription，候选只能靠 trickle 后续补发。
  // 旧实现收到 answer 就退订了候选监听，后续候选全部被静默丢弃，ICE 只能靠
  // answer 里的候选慢慢收敛。这里断言 answer 之后的候选确实进了 addIceCandidate。
  const socket = createSocketStub()
  const channel = createChannelStub()
  const candidates: string[] = []
  const peer = createPeerStub(channel, candidates)
  const originalSend = socket.send.bind(socket)
  socket.send = (data: string) => {
    originalSend(data)
    if ((JSON.parse(data) as { type: string }).type !== 'offer') return
    // offer 后先只发 answer，再延迟发候选，精确复现 Fix A 之后的时序。
    queueMicrotask(() => {
      socket.emit('message', {
        data: JSON.stringify({ type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n' }),
      } as MessageEvent<string>)
    })
    setTimeout(() => {
      socket.emit('message', {
        data: JSON.stringify({ type: 'candidate', candidate: 'candidate:late', mid: '0' }),
      } as MessageEvent<string>)
    }, 10)
  }
  const connection = await connectWebRtcClient({
    signalingTicket: ticket(),
    signalingSocketFactory: () => socket,
    peerConnectionFactory: () => peer,
  })
  assert.equal(connection.carrier.state, 'open')
  // 等待延迟候选被队列消费。
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.ok(candidates.includes('candidate:late'), `期望应用延迟候选，实际 ${JSON.stringify(candidates)}`)
  await connection.close()
})

test('registered 与 peer-ready 同轮到达不会丢事件（合并等待）', async () => {
  // 旧实现顺序 await 两次：若 Relay 把 registered/peer-ready 放在同一轮下发，
  // 第二个监听还没挂上就丢了 peer-ready，只能等 15s 超时。这里用短超时断言
  // 合并等待能正常建立连接。
  const socket = createSocketStub({
    onFirstMessageListener: (emit) => {
      emit({ type: 'registered', role: 'client', bindingId: 'binding-1', sessionId: 'session-1' })
      emit({ type: 'peer-ready', peerRole: 'host', sessionId: 'session-1' })
    },
  })
  Object.assign(socket, { readyState: 1 })
  const channel = createChannelStub()
  const candidates: string[] = []
  const peer = createPeerStub(channel, candidates)
  const connection = await connectWebRtcClient({
    signalingTicket: ticket(),
    signalingSocketFactory: () => socket,
    peerConnectionFactory: () => peer,
    timeoutMs: 1_000,
  })
  assert.equal(connection.carrier.state, 'open')
  await connection.close()
})

test('客户端 disconnected 不会主动关闭，PeerConnection failed 才通知关闭', async () => {
  const socket = createSocketStub()
  const channel = createChannelStub()
  const candidates: string[] = []
  const peer = Object.assign(createPeerStub(channel, candidates), { connectionState: 'connected' })
  const connection = await connectWebRtcClient({
    signalingTicket: ticket(),
    signalingSocketFactory: () => socket,
    peerConnectionFactory: () => peer,
  })
  let closedCount = 0
  connection.onClosed(() => { closedCount += 1 })
  peer.connectionState = 'disconnected'
  peer.emit('connectionstatechange', {} as Event)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(closedCount, 0)
  peer.connectionState = 'failed'
  peer.emit('connectionstatechange', {} as Event)
  assert.equal(closedCount, 1)
  await connection.close()
  assert.equal(channel.count('close'), 0)
})
