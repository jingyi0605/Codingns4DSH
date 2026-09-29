import type {
  RelayIceServer,
  RelaySignalingServerMessage,
  RelaySignalingTicketResponse,
} from '../shared/index.js'
import { createDataChannelCarrier, TUNNEL_DATA_CHANNEL_LABEL, type CodingNsCarrier, type DataChannelLike } from './carrier.js'
import { encodeFrame } from './frame.js'
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from './debug.js'

export interface SignalingSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'message' | 'close' | 'error', listener: (event: Event) => void): void
}

export interface PeerConnectionLike {
  createDataChannel(label: string): DataChannelLike
  createOffer(): Promise<{ type: 'offer'; sdp?: string }>
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>
  addIceCandidate(candidate: { candidate: string; sdpMid: string | null }): Promise<void>
  close(): void
  onicecandidate: ((event: { candidate: { candidate: string; sdpMid: string | null } | null }) => void) | null
  addEventListener?(type: string, listener: (event: Event) => void): void
  removeEventListener?(type: string, listener: (event: Event) => void): void
}

export interface WebRtcClientConnectorOptions {
  signalingTicket: RelaySignalingTicketResponse
  signalingSocketFactory(url: string): Promise<SignalingSocketLike> | SignalingSocketLike
  peerConnectionFactory(options: { iceServers: RelayIceServer[]; iceTransportPolicy: 'all' | 'relay' }): PeerConnectionLike
  channelLabel?: string
  timeoutMs?: number
  /** 已保留的兼容参数；disconnected 不再单独触发重连，以 DataChannel/failed/closed 为准。 */
  disconnectedGracePeriodMs?: number
  heartbeatIntervalMs?: number
  debug?: DshTransportDebugLogger
}

export interface WebRtcClientConnection {
  carrier: CodingNsCarrier
  peerConnection: PeerConnectionLike
  signaling: SignalingSocketLike
  onClosed(listener: (error?: Error) => void): () => void
  close(): Promise<void>
}

/** 客户端发起 offer，校验 Host fingerprint 后返回 DataChannel Carrier。 */
export async function connectWebRtcClient(options: WebRtcClientConnectorOptions): Promise<WebRtcClientConnection> {
  const ticket = options.signalingTicket
  const debug = options.debug ?? createDshTransportDebugLogger({ side: 'h5', component: 'webrtc-client' })
  const signalingUrl = createSignalingUrl(ticket.signalingBaseUrl, ticket.ticket)
  debug.log('signaling.connect', { signalingBaseUrl: ticket.signalingBaseUrl })
  const signaling = await options.signalingSocketFactory(signalingUrl)
  const cleanupListeners: Array<() => void> = []
  // 真实 WebSocket 暴露 readyState；测试注入的最小 socket 可能没有该字段。
  // 生产路径严格等待 registered，旧的纯协议 fake 仍可直接进入 offer 流程。
  if ('readyState' in signaling) {
    // 原来分成两次 await（先 registered 再 peer-ready）。Relay 会把 registered 和
    // peer-ready 连续发出，如果两条消息落在同一个事件循环轮次里，第二个 await 的
    // 监听还没挂上，peer-ready 就被丢掉，只能干等 15s 超时重连。
    // 这里用单个监听同时记录两个状态，消除丢事件窗口，也少一次订阅往返。
    await waitForSignalingReady(signaling, options.timeoutMs ?? 15_000, cleanupListeners)
  }
  const heartbeat = options.heartbeatIntervalMs === 0 ? null : setInterval(() => {
    try { signaling.send(JSON.stringify({ type: 'ping', at: new Date().toISOString() })) } catch { /* 断线由 close 事件处理 */ }
  }, options.heartbeatIntervalMs ?? 20_000)
  cleanupListeners.push(() => { if (heartbeat) clearInterval(heartbeat) })
  const peerConnection = options.peerConnectionFactory({
    iceServers: ticket.iceServers,
    iceTransportPolicy: ticket.iceTransportPolicy,
  })
  // Relay Tunnel 的标签属于线协议，不能由调用方改写。
  const channel = peerConnection.createDataChannel(TUNNEL_DATA_CHANNEL_LABEL)
  const carrier = createDataChannelCarrier(channel, { ...(options.debug ? { debug: options.debug } : {}) })
  let closed = false
  let closeNotified = false
  const closeListeners = new Set<(error?: Error) => void>()
  const notifyClosed = (error?: Error) => {
    if (closeNotified) return
    closeNotified = true
    debug.log('webrtc.connection.closed', { reason: error?.message ?? 'closed' })
    for (const listener of [...closeListeners]) listener(error)
    closeListeners.clear()
  }
  const onSignalingClose = () => notifyClosed(new Error('Relay signaling closed'))
  const onSignalingError = () => notifyClosed(new Error('Relay signaling error'))
  const onPeerState = () => {
    const state = (peerConnection as PeerConnectionLike & { connectionState?: string; iceConnectionState?: string })
    const value = state.connectionState ?? state.iceConnectionState
    debug.log('webrtc.peer.state', { state: value ?? 'unknown' })
    if (value === 'failed' || value === 'closed') {
      notifyClosed(new Error(`PeerConnection ${value}`))
    }
  }
  signaling.addEventListener('close', onSignalingClose)
  signaling.addEventListener('error', onSignalingError)
  peerConnection.addEventListener?.('connectionstatechange', onPeerState)
  peerConnection.addEventListener?.('iceconnectionstatechange', onPeerState)
  const carrierClosed = (reason?: string) => notifyClosed(new Error(reason ?? 'DataChannel closed'))
  carrier.onClosed?.(carrierClosed)

  const close = async () => {
    if (closed) return
    closed = true
    notifyClosed(new Error('client closed'))
    signaling.removeEventListener('close', onSignalingClose)
    signaling.removeEventListener('error', onSignalingError)
    peerConnection.removeEventListener?.('connectionstatechange', onPeerState)
    peerConnection.removeEventListener?.('iceconnectionstatechange', onPeerState)
    for (const cleanup of cleanupListeners.splice(0)) cleanup()
    await carrier.close()
    peerConnection.close()
    signaling.close(1000, 'client closed')
  }

  try {
    // 候选可能在 answer 之后才到（Host 现在先发 answer 再收集），因此候选监听必须
    // 覆盖整条连接生命周期，不能挂在 waitForAnswer 上（它在 answer 到达时就退订了）。
    const remoteCandidates = createRemoteCandidateQueue(peerConnection, debug)
    const onCandidateMessage = (event: Event) => {
      const raw = (event as MessageEvent<unknown>).data
      if (typeof raw !== 'string') return
      let message: RelaySignalingServerMessage
      try { message = JSON.parse(raw) as RelaySignalingServerMessage } catch { return }
      if (message.type !== 'candidate') return
      remoteCandidates.push({ candidate: message.candidate, sdpMid: message.mid })
    }
    signaling.addEventListener('message', onCandidateMessage)
    cleanupListeners.push(() => {
      signaling.removeEventListener('message', onCandidateMessage)
      remoteCandidates.dispose()
    })
    const answerPromise = waitForAnswer(
      signaling,
      options.timeoutMs ?? 15_000,
      cleanupListeners,
    )
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return
      signaling.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate.candidate,
        mid: event.candidate.sdpMid,
      }))
    }
    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    signaling.send(JSON.stringify({ type: 'offer', sdp: offer.sdp ?? '' }))
    debug.log('signaling.offer.sent', { sdpBytes: offer.sdp?.length ?? 0 })
    const answer = await answerPromise
    assertDtlsFingerprint(ticket.hostDtlsFingerprint, answer.sdp)
    await peerConnection.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    // answer 之前到达的候选在队列里等 remote description，这里放行。
    remoteCandidates.flush()
    await waitForOpen(channel, options.timeoutMs ?? 15_000, cleanupListeners)
    await carrier.send(encodeFrame({ type: 'hello', clientContext: null, protocolVersion: '1' }))
    debug.log('webrtc.connected', { channelLabel: TUNNEL_DATA_CHANNEL_LABEL })
    return { carrier, peerConnection, signaling, onClosed: (listener) => { if (closeNotified) { listener(new Error('connection closed')); return () => undefined } closeListeners.add(listener); return () => closeListeners.delete(listener) }, close }
  } catch (error) {
    await close()
    throw error
  }
}

export function createSignalingUrl(baseUrl: string, ticket: string): string {
  const base = new URL(ensureWebSocketProtocol(baseUrl))
  const pathname = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  const url = new URL('signal', `${base.origin}${pathname}`)
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

/**
 * 合并等待 registered + peer-ready。
 *
 * 两者由 Relay 连续下发，用两个独立 Promise 顺序等待时存在丢事件窗口：
 * 若两条消息在同一个事件循环轮次到达，后一个监听尚未注册，消息被丢弃，
 * 调用方只能等到超时才重连。这里用单个监听同时记录两个状态，谁先到都不会丢。
 */
export function waitForSignalingReady(socket: SignalingSocketLike, timeoutMs: number, cleanup: Array<() => void> = []): Promise<void> {
  return new Promise((resolve, reject) => {
    let registered = false
    let peerReady = false
    let settled = false
    const timer = setTimeout(() => { remove(); reject(new Error('等待 Relay registered 超时')) }, timeoutMs)
    const finish = () => {
      if (settled || !registered || !peerReady) return
      settled = true
      clearTimeout(timer)
      remove()
      resolve()
    }
    const onMessage = (event: Event) => {
      const raw = (event as MessageEvent<unknown>).data
      if (typeof raw !== 'string') return
      try {
        const message = JSON.parse(raw) as { type?: string; errorCode?: string; detail?: string }
        if (message.type === 'error') {
          settled = true
          clearTimeout(timer)
          remove()
          const code = message.errorCode?.trim() || 'RELAY_ERROR'
          const detail = message.detail?.trim()
          reject(new Error(detail ? `Relay ${code}: ${detail}` : `Relay ${code}`))
          return
        }
        if (message.type === 'registered') { registered = true; finish(); return }
        if (message.type === 'peer-ready') { peerReady = true; finish() }
      } catch { /* 忽略非 JSON 信令 */ }
    }
    const onClose = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      remove()
      reject(new Error(registered ? '信令连接在 peer-ready 前关闭' : '信令连接在 registered 前关闭'))
    }
    const remove = () => { socket.removeEventListener('message', onMessage); socket.removeEventListener('close', onClose) }
    socket.addEventListener('message', onMessage); socket.addEventListener('close', onClose); cleanup.push(remove)
  })
}

export function waitForSignalingRegistered(socket: SignalingSocketLike, timeoutMs: number, cleanup: Array<() => void> = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error('等待 Relay registered 超时')) }, timeoutMs)
    const onMessage = (event: Event) => {
      const raw = (event as MessageEvent<unknown>).data
      if (typeof raw !== 'string') return
      try {
        const message = JSON.parse(raw) as { type?: string; errorCode?: string; detail?: string }
        if (message.type === 'error') {
          clearTimeout(timer)
          remove()
          const code = message.errorCode?.trim() || 'RELAY_ERROR'
          const detail = message.detail?.trim()
          reject(new Error(detail ? `Relay ${code}: ${detail}` : `Relay ${code}`))
          return
        }
        if (message.type !== 'registered') return
        clearTimeout(timer)
        remove()
        resolve()
      } catch { /* 忽略非 JSON 信令 */ }
    }
    const onClose = () => { clearTimeout(timer); remove(); reject(new Error('信令连接在 registered 前关闭')) }
    const remove = () => { socket.removeEventListener('message', onMessage); socket.removeEventListener('close', onClose) }
    socket.addEventListener('message', onMessage); socket.addEventListener('close', onClose); cleanup.push(remove)
  })
}

/** Relay 只有在 Host 在线后才接受客户端 offer，避免过早发送被 HOST_NOT_CONNECTED 拒绝。 */
export function waitForPeerReady(socket: SignalingSocketLike, timeoutMs: number, cleanup: Array<() => void> = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error('等待 Relay peer-ready 超时')) }, timeoutMs)
    const onMessage = (event: Event) => {
      const raw = (event as MessageEvent<unknown>).data
      if (typeof raw !== 'string') return
      try {
        const message = JSON.parse(raw) as { type?: string }
        if (message.type === 'peer-ready') { clearTimeout(timer); remove(); resolve() }
        else if (message.type === 'error') { clearTimeout(timer); remove(); reject(new Error('Relay 拒绝 peer-ready')) }
      } catch { /* 忽略非 JSON 信令 */ }
    }
    const onClose = () => { clearTimeout(timer); remove(); reject(new Error('信令连接在 peer-ready 前关闭')) }
    const remove = () => { socket.removeEventListener('message', onMessage); socket.removeEventListener('close', onClose) }
    socket.addEventListener('message', onMessage); socket.addEventListener('close', onClose); cleanup.push(remove)
  })
}

export function extractDtlsFingerprint(sdp: string): string | null {
  const match = sdp.match(/^a=fingerprint:([^\r\n]+)$/mu)
  return match?.[1] ? normalizeFingerprint(match[1]) : null
}

export function assertDtlsFingerprint(expected: string, sdp: string): void {
  const actual = extractDtlsFingerprint(sdp)
  if (!actual || actual !== normalizeFingerprint(expected)) {
    throw new Error('Host DTLS fingerprint 校验失败')
  }
}

/**
 * Host 现在先发 answer 再 setLocalDescription，候选只能靠 trickle 后续补发。
 * addIceCandidate 必须严格串行（按调用顺序处理），所以这里把所有远端候选压进
 * 一条 promise 链；remote description 就绪前的候选先缓冲，避免被静默丢弃。
 */
interface RemoteCandidateQueue {
  push(candidate: { candidate: string; sdpMid: string | null }): void
  flush(): void
  dispose(): void
}

function createRemoteCandidateQueue(
  peerConnection: PeerConnectionLike,
  debug: DshTransportDebugLogger,
): RemoteCandidateQueue {
  const buffered: Array<{ candidate: string; sdpMid: string | null }> = []
  let remoteDescriptionReady = false
  let chain: Promise<void> = Promise.resolve()
  let disposed = false
  let received = 0
  let applied = 0
  const apply = (candidate: { candidate: string; sdpMid: string | null }) => {
    chain = chain
      .then(() => peerConnection.addIceCandidate(candidate).then(() => { applied += 1 }))
      .catch((error: unknown) => {
        debug.log('webrtc.candidate.failed', {
          candidateCount: received,
          code: error instanceof Error ? error.message : String(error),
        })
      })
  }
  return {
    push(candidate) {
      if (disposed) return
      received += 1
      if (!remoteDescriptionReady) { buffered.push(candidate); return }
      apply(candidate)
    },
    flush() {
      if (disposed) return
      remoteDescriptionReady = true
      for (const candidate of buffered.splice(0)) apply(candidate)
      debug.log('webrtc.candidate.flushed', { candidateCount: received })
    },
    dispose() {
      disposed = true
      debug.log('webrtc.candidate.summary', { candidateCount: received, applied: applied })
    },
  }
}

function waitForAnswer(
  socket: SignalingSocketLike,
  timeoutMs: number,
  cleanup: Array<() => void>,
): Promise<{ sdp: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 Host answer 超时')), timeoutMs)
    const onMessage = (event: Event) => {
      const raw = (event as MessageEvent<string>).data
      if (typeof raw !== 'string') return
      let message: RelaySignalingServerMessage
      try { message = JSON.parse(raw) as RelaySignalingServerMessage } catch { return }
      if (message.type === 'answer') {
        clearTimeout(timer)
        remove()
        resolve({ sdp: message.sdp })
      } else if (message.type === 'error') {
        clearTimeout(timer)
        remove()
        reject(new Error(`${message.errorCode}: ${message.detail}`))
      }
    }
    const onClose = () => { clearTimeout(timer); remove(); reject(new Error('信令连接已关闭')) }
    const remove = () => {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    cleanup.push(remove)
  })
}

function waitForOpen(channel: DataChannelLike, timeoutMs: number, cleanup: Array<() => void>): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error('等待 DataChannel open 超时')) }, timeoutMs)
    const onOpen = () => { clearTimeout(timer); remove(); resolve() }
    const onClose = () => { clearTimeout(timer); remove(); reject(new Error('DataChannel 在 ready 前关闭')) }
    const remove = () => {
      channel.removeEventListener('open', onOpen)
      channel.removeEventListener('close', onClose)
    }
    channel.addEventListener('open', onOpen)
    channel.addEventListener('close', onClose)
    cleanup.push(remove)
  })
}

function normalizeFingerprint(value: string): string {
  return value.trim().replace(/^[a-z0-9-]+(?:\s+|:)+/iu, '').replace(/[^0-9a-f]/giu, '').toLowerCase()
}

function ensureWebSocketProtocol(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Relay URL 必须使用 HTTP(S) 或 WS(S)')
  return url.toString()
}
