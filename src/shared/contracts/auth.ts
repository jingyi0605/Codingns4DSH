/**
 * CodingNS 控制面认证契约。
 *
 * 这些 DTO 与 codingns-proxy/packages/shared-contracts 保持字段兼容。
 * 阶段 2 只定义数据边界，不在插件中发起真实网络请求。
 */

export type AccountRole = 'user' | 'admin'
export type AccountStatus = 'pending_verification' | 'active' | 'disabled'

export interface AccountProfile {
  accountId: string
  email: string
  emailVerified: boolean
  role: AccountRole
  mustChangePassword: boolean
  createdAt: string
  status?: AccountStatus
  sessionVersion?: number
}

export interface LoginByEmailRequest {
  email: string
  password: string
}

export type AuthClientType = 'desktop' | 'web' | 'ios' | 'android' | 'unknown'

export interface AuthDeviceViewDto {
  deviceId: string | null
  clientType: AuthClientType
  clientInstanceId: string | null
  displayName: string | null
  browserName: string | null
  browserVersion: string | null
  osName: string | null
  osVersion: string | null
  lastSourceAddress: string | null
  lastSeenAt: string
  isPrimary: boolean
  isCurrent: boolean
  isLegacy: boolean
}

export interface RecentLoginRecordViewDto {
  id: string
  deviceId: string | null
  clientType: AuthClientType
  displayName: string | null
  browserName: string | null
  browserVersion: string | null
  osName: string | null
  osVersion: string | null
  sourceAddress: string | null
  occurredAt: string
  isCurrentDevice: boolean
  isLegacy: boolean
}

export interface AuthDeviceManagementSnapshotDto {
  currentDevice: AuthDeviceViewDto | null
  otherActiveDevices: AuthDeviceViewDto[]
  recentLoginRecords: RecentLoginRecordViewDto[]
}

export interface TunnelBindingSummary {
  bindingId: string
  tunnelDomain: string
  hostPublicKey: string
  hostFingerprint: string
  relayBaseUrl: string
  controlBaseUrl: string
  sessionRateLimitBytesPerSecond: string | null
  effectiveSessionRateLimitBytesPerSecond: string | null
  status: 'active' | 'disabled'
  credentialVersion?: number
  runtime?: {
    online: boolean
    onlineSince: string | null
    lastHeartbeatAt: string | null
    localTargetBaseUrl: string | null
    candidateEndpoints: Array<{
      endpointId: string
      kind: 'relay' | 'lan' | 'loopback' | 'tailscale' | 'custom'
      url: string
      priority: number
      expiresAt: string | null
      source: 'host_reported' | 'desktop_scan' | 'user_saved'
    }>
  } | null
}

export interface HostBindRequest {
  hostLabel: string
  hostPublicKey: string
  hostFingerprint: string
}

export interface HostBindResponse {
  binding: TunnelBindingSummary
  created: boolean
}

export interface HostBindingsResponse {
  bindings: TunnelBindingSummary[]
}

export interface HostUnbindResponse {
  released: true
  binding: TunnelBindingSummary
}

export interface HostLabelAvailabilityResponse {
  hostLabel: string
  tunnelDomain: string | null
  available: boolean
  reason: 'available' | 'occupied' | 'reserved' | 'unavailable'
}

export type CodingNsAuthStatus =
  | 'logged_out'
  | 'logging_in'
  | 'authenticated'
  | 'refreshing'
  | 'revoked'
  | 'failed'

/** 不含 access/refresh token，可安全用于 Host 内部状态展示和日志摘要。 */
export interface CodingNsAuthSessionSnapshot {
  status: CodingNsAuthStatus
  account: AccountProfile | null
  currentDevice: AuthDeviceViewDto | null
  binding: TunnelBindingSummary | null
  expiresAt: string | null
  errorCode: string | null
}

export interface CodingNsAuthLoginResult {
  account: AccountProfile
  expiresAt: string
  currentDevice: AuthDeviceViewDto | null
  binding: TunnelBindingSummary | null
}
