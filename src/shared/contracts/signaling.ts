export interface RelayIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface RelaySignalingTicketRequest {
  tunnelDomain?: string
  bindingId?: string
  hostDtlsFingerprint?: string
  credentialVersion?: number
}

export interface RelaySignalingTicketResponse {
  ticket: string
  expiresAt: string
  signalingBaseUrl: string
  iceServers: RelayIceServer[]
  iceTransportPolicy: 'all' | 'relay'
  hostDtlsFingerprint: string
  bindingId: string
  tunnelDomain: string
  trafficRemainingBytes: string
  credentialVersion?: number
}

export type RelaySignalingClientMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'candidate'; candidate: string; mid: string | null }
  | { type: 'ping'; at: string }

export type RelaySignalingServerMessage =
  | { type: 'registered'; role: 'client' | 'host'; bindingId: string; sessionId: string | null }
  | { type: 'peer-ready'; peerRole: 'client' | 'host'; sessionId: string | null }
  | { type: 'peer-left'; peerRole: 'client' | 'host'; sessionId: string | null }
  | { type: 'answer'; sdp: string; senderRole: 'host'; sessionId: string }
  | { type: 'candidate'; candidate: string; mid: string | null; senderRole: 'host'; sessionId: string }
  | { type: 'pong'; at: string }
  | { type: 'error'; errorCode: string; detail: string }
