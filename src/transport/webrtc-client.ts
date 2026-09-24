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
}

export interface WebRtcClientConnectorOptions {
  signalingTicket: RelaySignalingTicketResponse
  signalingSocketFactory(url: string): Promise<SignalingSocketLike> | SignalingSocketLike
  peerConnectionFactory(options: { iceServers: RelayIceServer[]; iceTransportPolicy: 'all' | 'relay' }): PeerConnectionLike
  channelLabel?: string
  timeoutMs?: number
  heartbeatIntervalMs?: number
  debug?: DshTransportDebugLogger
}

export interface WebRtcClientConnection {
  carrier: CodingNsCarrier
  peerConnection: PeerConnectionLike
  signaling: SignalingSocketLike
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
    await waitForSignalingRegistered(signaling, options.timeoutMs ?? 15_000, cleanupListeners)
    await waitForPeerReady(signaling, options.timeoutMs ?? 15_000, cleanupListeners)
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

  const close = async () => {
    if (closed) return
    closed = true
    for (const cleanup of cleanupListeners.splice(0)) cleanup()
    await carrier.close()
    peerConnection.close()
    signaling.close(1000, 'client closed')
  }

  try {
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
    for (const candidate of answer.candidates) await peerConnection.addIceCandidate(candidate)
    await waitForOpen(channel, options.timeoutMs ?? 15_000, cleanupListeners)
    await carrier.send(encodeFrame({ type: 'hello', clientContext: null, protocolVersion: '1' }))
    debug.log('webrtc.connected', { channelLabel: TUNNEL_DATA_CHANNEL_LABEL })
    return { carrier, peerConnection, signaling, close }
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

export function waitForSignalingRegistered(socket: SignalingSocketLike, timeoutMs: number, cleanup: Array<() => void> = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove(); reject(new Error('等待 Relay registered 超时')) }, timeoutMs)
    const onMessage = (event: Event) => {
      const raw = (event as MessageEvent<unknown>).data
      if (typeof raw !== 'string') return
      try { const message = JSON.parse(raw) as { type?: string }; if (message.type !== 'registered') return; clearTimeout(timer); remove(); resolve() } catch { /* 忽略非 JSON 信令 */ }
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

function waitForAnswer(
  socket: SignalingSocketLike,
  timeoutMs: number,
  cleanup: Array<() => void>,
): Promise<{ sdp: string; candidates: Array<{ candidate: string; sdpMid: string | null }> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 Host answer 超时')), timeoutMs)
    const candidates: Array<{ candidate: string; sdpMid: string | null }> = []
    const onMessage = (event: Event) => {
      const raw = (event as MessageEvent<string>).data
      if (typeof raw !== 'string') return
      let message: RelaySignalingServerMessage
      try { message = JSON.parse(raw) as RelaySignalingServerMessage } catch { return }
      if (message.type === 'answer') {
        clearTimeout(timer)
        remove()
        resolve({ sdp: message.sdp, candidates })
      } else if (message.type === 'candidate') {
        candidates.push({ candidate: message.candidate, sdpMid: message.mid })
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
