import type {
  RelayIceServer,
  RelaySignalingServerMessage,
  RelaySignalingTicketResponse,
} from '../shared/index.js'
import { createDataChannelCarrier, type CodingNsCarrier, type DataChannelLike } from './carrier.js'

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
  const signalingUrl = createSignalingUrl(ticket.signalingBaseUrl, ticket.ticket)
  const signaling = await options.signalingSocketFactory(signalingUrl)
  const peerConnection = options.peerConnectionFactory({
    iceServers: ticket.iceServers,
    iceTransportPolicy: ticket.iceTransportPolicy,
  })
  const channel = peerConnection.createDataChannel(options.channelLabel ?? 'dsh-codingns')
  const carrier = createDataChannelCarrier(channel)
  const cleanupListeners: Array<() => void> = []
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
    const answer = await answerPromise
    assertDtlsFingerprint(ticket.hostDtlsFingerprint, answer.sdp)
    await peerConnection.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    for (const candidate of answer.candidates) await peerConnection.addIceCandidate(candidate)
    await waitForOpen(channel, options.timeoutMs ?? 15_000, cleanupListeners)
    return { carrier, peerConnection, signaling, close }
  } catch (error) {
    await close()
    throw error
  }
}

export function createSignalingUrl(baseUrl: string, ticket: string): string {
  const url = new URL('/signal', ensureWebSocketProtocol(baseUrl))
  url.searchParams.set('ticket', ticket)
  return url.toString()
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
