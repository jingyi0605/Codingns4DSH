import type { RelayIceServer, RelaySignalingTicketResponse } from './signaling.js'

/** DSH-CodingNS 自己的设备记录，不与 CodingNS Host binding 共用身份。 */
export interface DshDeviceSummary {
  /** DSH 独立设备身份；不能与 CodingNS host bindingId 混用。 */
  dshDeviceId: string
  /** 旧 DTO 兼容字段，服务端迁移期间可存在。 */
  deviceId?: string
  displayName: string
  protocolVersion: string
  capabilities: string[]
  dtlsFingerprint: string
  tunnelDomain?: string
  status: 'active' | 'disabled' | 'revoked' | 'offline'
  online: boolean
  lastHeartbeatAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DshDeviceRegistrationRequest {
  displayName: string
  devicePublicKey: string
  dtlsFingerprint: string
  protocolVersion: string
  capabilities: string[]
}

export interface DshDeviceRegistrationResponse {
  device: DshDeviceSummary
  deviceCredential: string
  credentialVersion: number
}

export interface DshDeviceListResponse {
  devices: DshDeviceSummary[]
  currentDeviceId?: string
}

export interface DshDeviceHeartbeatResponse {
  device: DshDeviceSummary
  credentialVersion: number
}

export interface DshRelayTicketRequest {
  dshDeviceId: string
  deviceCredential: string
  hostDtlsFingerprint: string
  credentialVersion: number
  role?: 'host' | 'client'
}

/** DSH ticket 复用 Relay 的 ICE/信令字段，但不带 CodingNS bindingId。 */
export interface DshRelayTicketResponse extends Omit<RelaySignalingTicketResponse, 'bindingId' | 'tunnelDomain' | 'hostDtlsFingerprint' | 'credentialVersion'> {
  product: 'dsh-codingns'
  dshDeviceId: string
  hostDtlsFingerprint: string
  tunnelDomain?: string
  credentialVersion: number
  hostScope?: { hostId: string; kind: 'local' | 'remote' }
}

/** H5/Host 侧使用的票据别名，名称与 Relay API DTO 保持一致。 */
export type DshRelaySignalingTicket = DshRelayTicketResponse

export type DshRelayTicketLike = DshRelayTicketResponse | RelaySignalingTicketResponse
export type DshIceServer = RelayIceServer

/** Host 本地保存的 DSH 设备凭据；deviceCredential 只存在 Host。 */
export interface DshDeviceCredentialRecord {
  deviceId: string
  deviceCredential: string
  credentialVersion: number
  dtlsFingerprint: string
  tunnelDomain: string | null
  displayName: string
  savedAt: string
}
