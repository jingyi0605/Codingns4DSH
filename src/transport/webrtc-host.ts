import type {
  RelayIceServer,
  RelaySignalingTicketRequest,
  RelaySignalingTicketResponse,
} from '../shared/contracts/signaling.js'
import type { CodingNsControlApiClient } from '../host/control-api-client.js'
import { createDataChannelCarrier, createRelayTunnelHostCarrier, TUNNEL_DATA_CHANNEL_LABEL, type CodingNsCarrier, type DataChannelLike } from './carrier.js'
import {
  createSignalingUrl,
  waitForSignalingRegistered,
  type PeerConnectionLike,
  type SignalingSocketLike,
} from './webrtc-client.js'
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from './debug.js'

/** Host 侧每个客户端会话使用一个独立的 PeerConnection。真实 Node WebRTC 实现由调用方注入。 */
export interface HostPeerConnectionLike extends Omit<PeerConnectionLike, 'createDataChannel' | 'createOffer'> {
  readonly connectionState?: string
  readonly iceConnectionState?: string
  createAnswer(): Promise<{ type: 'answer'; sdp?: string }>
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null
}

export interface HostSignalingTicketRequest {
  bindingId: string
  hostDtlsFingerprint: string
  credentialVersion?: number
}

export interface WebRtcHostAcceptorOptions {
  signalingTicket: RelaySignalingTicketResponse
  signalingSocketFactory(url: string): Promise<SignalingSocketLike> | SignalingSocketLike
  peerConnectionFactory(options: {
    iceServers: RelayIceServer[]
    iceTransportPolicy: 'all' | 'relay'
  }): HostPeerConnectionLike
  channelLabel?: string
  onConnection?: (connection: WebRtcHostSession) => void | Promise<void>
  onSessionClosed?: (sessionId: string) => void | Promise<void>
  debug?: DshTransportDebugLogger
}

export interface WebRtcHostSession {
  readonly sessionId: string
  readonly peerConnection: HostPeerConnectionLike
  readonly carrier: CodingNsCarrier | null
  close(): Promise<void>
}

export interface WebRtcHostAcceptor {
  readonly signaling: SignalingSocketLike
  readonly sessions: ReadonlyMap<string, WebRtcHostSession>
  close(): Promise<void>
}

/**
 * 构造 Host 申请角色票据的请求 DTO，并在进入 Control API 前检查边界。
 * 指纹只做非空和控制字符校验，具体格式由 CodingNS 绑定记录比较逻辑决定。
 */
export function createHostSignalingTicketRequest(input: HostSignalingTicketRequest): RelaySignalingTicketRequest {
  if (/[\r\n]/u.test(input.hostDtlsFingerprint)) {
    throw new TypeError('Host signaling ticket 的 DTLS fingerprint 无效')
  }
  const bindingId = input.bindingId.trim()
  const hostDtlsFingerprint = input.hostDtlsFingerprint.trim()
  if (!bindingId) throw new TypeError('Host signaling ticket 的 bindingId 不能为空')
  if (!hostDtlsFingerprint) {
    throw new TypeError('Host signaling ticket 的 DTLS fingerprint 无效')
  }
  if (input.credentialVersion !== undefined
    && (!Number.isInteger(input.credentialVersion) || input.credentialVersion < 1)) {
    throw new TypeError('Host signaling ticket 的 credentialVersion 必须是正整数')
  }
  return {
    bindingId,
    hostDtlsFingerprint,
    ...(input.credentialVersion === undefined ? {} : { credentialVersion: input.credentialVersion }),
  }
}

/** 通过已认证 Host 控制面会话申请 Host 角色信令票据。 */
export function requestHostSignalingTicket(
  controlClient: Pick<CodingNsControlApiClient, 'createSignalingTicket'>,
  accessToken: string,
  input: HostSignalingTicketRequest,
): Promise<RelaySignalingTicketResponse> {
  if (!accessToken.trim()) throw new TypeError('Host signaling ticket 的 accessToken 不能为空')
  return controlClient.createSignalingTicket(accessToken, createHostSignalingTicketRequest(input))
}

/**
 * 接收客户端 offer 并回传 answer 的 Host 侧 WebRTC 骨架。
 * 该函数只编排信令和可注入的 PeerConnection，不创建 Node WebRTC runtime 或网络服务。
 */
export async function acceptWebRtcHost(options: WebRtcHostAcceptorOptions): Promise<WebRtcHostAcceptor> {
  validateHostTicket(options.signalingTicket)
  const debug = options.debug ?? createDshTransportDebugLogger({ side: 'host', component: 'webrtc-host' })
  const signaling = await options.signalingSocketFactory(
    createSignalingUrl(options.signalingTicket.signalingBaseUrl, options.signalingTicket.ticket),
  )
  if ('readyState' in signaling) {
    await waitForSignalingRegistered(signaling, 15_000)
  }
  const heartbeat = 'readyState' in signaling
    ? setInterval(() => {
      if ((signaling as SignalingSocketLike & { readyState?: number }).readyState === 1) {
        try { signaling.send(JSON.stringify({ type: 'ping', at: new Date().toISOString() })) } catch { /* 断线由 close 处理 */ }
      }
    }, 20_000)
    : undefined
  const sessions = new Map<string, HostSessionImpl>()
  const queuedCandidates = new Map<string, Array<{ candidate: string; sdpMid: string | null }>>()
  let closed = false

  const onMessage = (event: Event) => {
    const raw = (event as MessageEvent<string>).data
    if (typeof raw !== 'string') return
    let message: HostSignalingMessage
    try { message = JSON.parse(raw) as HostSignalingMessage } catch { return }
    debug.log('signaling.message', { type: message.type, sessionId: 'sessionId' in message ? message.sessionId : null })
    if (message.type === 'offer') {
      if (message.senderRole !== 'client' || !message.sessionId || !message.sdp) return
      void handleOffer(message.sessionId, message.sdp)
      return
    }
    if (message.type === 'candidate') {
      if (message.senderRole !== 'client' || !message.sessionId || !message.candidate) return
      const session = sessions.get(message.sessionId)
      if (session) void session.addCandidate({ candidate: message.candidate, sdpMid: message.mid })
      else queuedCandidates.set(message.sessionId, [
        ...(queuedCandidates.get(message.sessionId) ?? []),
        { candidate: message.candidate, sdpMid: message.mid },
      ])
      return
    }
    if (message.type === 'peer-left' && message.peerRole === 'client' && message.sessionId) {
      void closeSession(message.sessionId)
    }
  }
  const onClose = () => { void closeAllSessions() }
  signaling.addEventListener('message', onMessage)
  signaling.addEventListener('close', onClose)

  const closeSession = async (sessionId: string) => {
    queuedCandidates.delete(sessionId)
    const session = sessions.get(sessionId)
    if (!session) return
    sessions.delete(sessionId)
    await session.close()
    await options.onSessionClosed?.(sessionId)
  }
  const closeAllSessions = async () => {
    const current = [...sessions.keys()]
    await Promise.all(current.map((sessionId) => closeSession(sessionId)))
  }
  const handleOffer = async (sessionId: string, sdp: string) => {
    if (closed) return
    let session = sessions.get(sessionId)
    if (!session) {
      session = new HostSessionImpl(
        sessionId,
        options.peerConnectionFactory({
          iceServers: options.signalingTicket.iceServers,
          iceTransportPolicy: options.signalingTicket.iceTransportPolicy,
        }),
        signaling,
        options.onConnection,
        () => { void closeSession(sessionId) },
        TUNNEL_DATA_CHANNEL_LABEL,
        options.debug,
      )
      sessions.set(sessionId, session)
    }
    await session.answerOffer(sdp)
    const candidates = queuedCandidates.get(sessionId) ?? []
    queuedCandidates.delete(sessionId)
    for (const candidate of candidates) await session.addCandidate(candidate)
  }

  return {
    signaling,
    get sessions() { return sessions },
    async close() {
      if (closed) return
      closed = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      signaling.removeEventListener('message', onMessage)
      signaling.removeEventListener('close', onClose)
      await closeAllSessions()
      signaling.close(1000, 'host closed')
    },
  }
}

type HostSignalingMessage =
  | { type: 'offer'; sdp: string; senderRole: 'client'; sessionId: string }
  | { type: 'candidate'; candidate: string; mid: string | null; senderRole: 'client'; sessionId: string }
  | { type: 'peer-left'; peerRole: 'client'; sessionId: string | null }
  | { type: 'error'; errorCode: string; detail: string }

class HostSessionImpl implements WebRtcHostSession {
  private _carrier: CodingNsCarrier | null = null
  private closed = false
  private offerPromise: Promise<void> | null = null
  private remoteDescriptionReady = false
  private readonly pendingCandidates: Array<{ candidate: string; sdpMid: string | null }> = []

  constructor(
    public readonly sessionId: string,
    public readonly peerConnection: HostPeerConnectionLike,
    private readonly signaling: SignalingSocketLike,
    private readonly onConnection: WebRtcHostAcceptorOptions['onConnection'],
    private readonly onTransportClosed: () => void | Promise<void>,
    channelLabel: string | undefined,
    private readonly debug?: DshTransportDebugLogger,
  ) {
    this.peerConnection.addEventListener?.('connectionstatechange', this.onPeerState)
    this.peerConnection.addEventListener?.('iceconnectionstatechange', this.onPeerState)
    this.peerConnection.onicecandidate = (event) => {
      if (this.closed || !event.candidate) return
      this.signaling.send(JSON.stringify({
        type: 'candidate',
        candidate: event.candidate.candidate,
        mid: event.candidate.sdpMid,
        sessionId: this.sessionId,
      }))
    }
    this.peerConnection.ondatachannel = (event) => {
      if (this.closed) return
      const channel = event.channel
      if (channelLabel && 'label' in channel && typeof (channel as DataChannelLike & { label?: unknown }).label === 'string'
        && (channel as DataChannelLike & { label: string }).label !== channelLabel) {
        channel.close()
        return
      }
      if (this._carrier) void this._carrier.close()
      this.debug?.log('data-channel.accepted', { sessionId: this.sessionId, label: channel.label ?? null })
      this._carrier = createRelayTunnelHostCarrier(createDataChannelCarrier(channel, { ...(this.debug ? { debug: this.debug } : {}) }), this.debug)
      this._carrier.onClosed?.(() => { void this.onTransportClosed() })
      void this.onConnection?.(this)
    }
  }

  get carrier(): CodingNsCarrier | null { return this._carrier }

  answerOffer(sdp: string): Promise<void> {
    if (this.offerPromise) return this.offerPromise
    this.offerPromise = this.answerOfferOnce(sdp).finally(() => { this.offerPromise = null })
    return this.offerPromise
  }

  async addCandidate(candidate: { candidate: string; sdpMid: string | null }): Promise<void> {
    if (this.closed) return
    if (!this.remoteDescriptionReady) {
      this.pendingCandidates.push(candidate)
      return
    }
    await this.peerConnection.addIceCandidate(candidate)
  }

  private async answerOfferOnce(sdp: string): Promise<void> {
    if (this.closed) return
    await this.peerConnection.setRemoteDescription({ type: 'offer', sdp })
    this.remoteDescriptionReady = true
    const pendingCandidates = this.pendingCandidates.splice(0)
    for (const candidate of pendingCandidates) await this.peerConnection.addIceCandidate(candidate)
    const answer = await this.peerConnection.createAnswer()
    await this.peerConnection.setLocalDescription(answer)
    if (!this.closed) {
      this.signaling.send(JSON.stringify({ type: 'answer', sdp: answer.sdp ?? '', sessionId: this.sessionId }))
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.peerConnection.onicecandidate = null
    this.peerConnection.ondatachannel = null
    this.peerConnection.removeEventListener?.('connectionstatechange', this.onPeerState)
    this.peerConnection.removeEventListener?.('iceconnectionstatechange', this.onPeerState)
    await this._carrier?.close()
    this._carrier = null
    this.peerConnection.close()
  }

  private readonly onPeerState = () => {
    const state = this.peerConnection as HostPeerConnectionLike & { connectionState?: string; iceConnectionState?: string }
    const value = state.connectionState ?? state.iceConnectionState
    if (value === 'failed' || value === 'disconnected' || value === 'closed') void this.onTransportClosed()
  }
}

function validateHostTicket(ticket: RelaySignalingTicketResponse): void {
  if (!ticket.ticket.trim() || !ticket.bindingId.trim() || !ticket.signalingBaseUrl.trim()) {
    throw new TypeError('Host signaling ticket 缺少必需字段')
  }
  if (!ticket.hostDtlsFingerprint.trim() || /[\r\n]/u.test(ticket.hostDtlsFingerprint)) {
    throw new TypeError('Host signaling ticket 的 DTLS fingerprint 无效')
  }
  if (ticket.credentialVersion !== undefined
    && (!Number.isInteger(ticket.credentialVersion) || ticket.credentialVersion < 1)) {
    throw new TypeError('Host signaling ticket 的 credentialVersion 无效')
  }
}
