import type {
  AuthDeviceManagementSnapshotDto,
  HostBindRequest,
  HostBindResponse,
  HostBindingsResponse,
  HostLabelAvailabilityResponse,
  HostUnbindResponse,
  LoginByEmailRequest,
} from '../shared/contracts/auth.js'
import type {
  DshDeviceHeartbeatResponse,
  DshDeviceListResponse,
  DshDeviceRegistrationRequest,
  DshDeviceRegistrationResponse,
  DshRelayTicketRequest,
  DshRelayTicketResponse,
} from '../shared/contracts/dsh-device.js'
import type {
  RelaySignalingTicketRequest,
  RelaySignalingTicketResponse,
} from '../shared/contracts/signaling.js'

/** 仅 Host 使用的控制面会话响应；refresh token 不进入 shared/client 类型。 */
export interface LoginByEmailResponse {
  account: import('../shared/contracts/auth.js').AccountProfile
  accessToken: string
  expiresAt: string
  refreshToken: string
  refreshTokenExpiresAt: string
}

export interface RefreshTokenRequest {
  refreshToken: string
}

export type RefreshTokenResponse = LoginByEmailResponse

/** codingns-proxy Control API 的真实路径，供后续 HTTP 实现复用。 */
export const CODINGNS_CONTROL_API_PATHS = {
  login: '/api/public/auth/login',
  refresh: '/api/public/auth/refresh',
  me: '/api/v1/auth/me',
  // 当前 codingns-proxy 没有独立的设备管理接口；设备绑定通过 hosts 返回。
  hosts: '/api/v1/hosts',
  bind: '/api/v1/hosts/bind',
  availability: '/api/v1/hosts/availability',
  signalingTicket: '/api/v1/relay/signaling/ticket',
  dshDevices: '/api/v1/dsh/devices',
  dshRelayTicket: '/api/v1/dsh/relay/ticket',
} as const

export class CodingNsControlApiError extends Error {
  readonly status: number
  readonly errorCode: string | null

  constructor(message: string, status: number, errorCode: string | null = null) {
    super(message)
    this.name = 'CodingNsControlApiError'
    this.status = status
    this.errorCode = errorCode
  }
}

/**
 * 控制面客户端边界。实现必须由调用方注入，阶段 2 不执行 fetch。
 * accessToken 只作为调用参数存在，不进入凭据存储或公开快照。
 */
export interface CodingNsControlApiClient {
  login(request: LoginByEmailRequest): Promise<LoginByEmailResponse>
  refresh(request: RefreshTokenRequest): Promise<RefreshTokenResponse>
  getDevices(accessToken: string): Promise<AuthDeviceManagementSnapshotDto>
  listHostBindings(accessToken: string): Promise<HostBindingsResponse>
  bindHost(accessToken: string, request: HostBindRequest): Promise<HostBindResponse>
  unbindHost(accessToken: string, bindingId: string): Promise<HostUnbindResponse>
  checkHostLabelAvailability(accessToken: string, hostLabel: string): Promise<HostLabelAvailabilityResponse>
  createSignalingTicket(
    accessToken: string,
    request: RelaySignalingTicketRequest,
  ): Promise<RelaySignalingTicketResponse>
  registerDshDevice(accessToken: string, request: DshDeviceRegistrationRequest): Promise<DshDeviceRegistrationResponse>
  listDshDevices(accessToken: string): Promise<DshDeviceListResponse>
  heartbeatDshDevice(accessToken: string, deviceId: string, deviceCredential: string): Promise<DshDeviceHeartbeatResponse>
  createDshRelayTicket(accessToken: string, request: DshRelayTicketRequest): Promise<DshRelayTicketResponse>
}

/** 设计文档中的简写名称；保留长名称以明确其 Control API 边界。 */
export type CodingNsControlClient = CodingNsControlApiClient

export interface HttpCodingNsControlApiClientOptions {
  controlBaseUrl: string
  /** 设备接口属于当前 Host API，默认与 Control API 使用同一基地址。 */
  hostApiBaseUrl?: string
  fetcher?: typeof fetch
}

/** 基于原生 fetch 的 Host 控制面客户端；不把 token 写入日志或快照。 */
export class HttpCodingNsControlApiClient implements CodingNsControlApiClient {
  private readonly controlBaseUrl: string
  private readonly hostApiBaseUrl: string
  private readonly fetcher: typeof fetch

  constructor(options: HttpCodingNsControlApiClientOptions) {
    this.controlBaseUrl = normalizeBaseUrl(options.controlBaseUrl)
    this.hostApiBaseUrl = normalizeBaseUrl(options.hostApiBaseUrl ?? options.controlBaseUrl)
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
  }

  login(request: LoginByEmailRequest): Promise<LoginByEmailResponse> {
    return this.request(this.controlBaseUrl, CODINGNS_CONTROL_API_PATHS.login, { method: 'POST', body: request })
  }

  refresh(request: RefreshTokenRequest): Promise<RefreshTokenResponse> {
    return this.request(this.controlBaseUrl, CODINGNS_CONTROL_API_PATHS.refresh, { method: 'POST', body: request })
  }

  /**
   * codingns-proxy Connect 只提供账号和 Host 绑定接口，没有旧版的设备管理接口。
   * 保留 DTO 方法是为了兼容插件 RPC；不能向不存在的 `/api/auth/devices` 发请求，
   * 否则登录成功后的补充状态读取会被误报成登录失败。
   */
  getDevices(_accessToken: string): Promise<AuthDeviceManagementSnapshotDto> {
    return Promise.resolve({
      currentDevice: null,
      otherActiveDevices: [],
      recentLoginRecords: [],
    })
  }

  listHostBindings(accessToken: string): Promise<HostBindingsResponse> {
    return this.request(this.controlBaseUrl, CODINGNS_CONTROL_API_PATHS.hosts, { token: accessToken })
  }

  bindHost(accessToken: string, request: HostBindRequest): Promise<HostBindResponse> {
    return this.request(this.controlBaseUrl, CODINGNS_CONTROL_API_PATHS.bind, { method: 'POST', token: accessToken, body: request })
  }

  unbindHost(accessToken: string, bindingId: string): Promise<HostUnbindResponse> {
    return this.request(this.controlBaseUrl, `/api/v1/hosts/${encodeURIComponent(bindingId)}`, { method: 'DELETE', token: accessToken })
  }

  checkHostLabelAvailability(accessToken: string, hostLabel: string): Promise<HostLabelAvailabilityResponse> {
    return this.request(this.controlBaseUrl, `${CODINGNS_CONTROL_API_PATHS.availability}?hostLabel=${encodeURIComponent(hostLabel)}`, { token: accessToken })
  }

  createSignalingTicket(
    accessToken: string,
    request: RelaySignalingTicketRequest,
  ): Promise<RelaySignalingTicketResponse> {
    return this.request(this.controlBaseUrl, CODINGNS_CONTROL_API_PATHS.signalingTicket, {
      method: 'POST',
      token: accessToken,
      body: request,
    })
  }

  registerDshDevice(accessToken: string, request: DshDeviceRegistrationRequest): Promise<DshDeviceRegistrationResponse> {
    return this.request(this.controlBaseUrl, CODINGNS_CONTROL_API_PATHS.dshDevices, { method: 'POST', token: accessToken, body: request })
  }

  listDshDevices(accessToken: string): Promise<DshDeviceListResponse> {
    return this.request(this.controlBaseUrl, CODINGNS_CONTROL_API_PATHS.dshDevices, { token: accessToken })
  }

  heartbeatDshDevice(accessToken: string, deviceId: string, deviceCredential: string): Promise<DshDeviceHeartbeatResponse> {
    return this.request(this.controlBaseUrl, `${CODINGNS_CONTROL_API_PATHS.dshDevices}/${encodeURIComponent(deviceId)}/heartbeat`, {
      method: 'POST',
      token: accessToken,
      headers: { 'x-dsh-device-credential': deviceCredential },
    })
  }

  createDshRelayTicket(accessToken: string, request: DshRelayTicketRequest): Promise<DshRelayTicketResponse> {
    return this.request(this.controlBaseUrl, CODINGNS_CONTROL_API_PATHS.dshRelayTicket, {
      method: 'POST',
      token: accessToken,
      body: request,
      headers: { 'x-dsh-device-credential': request.deviceCredential },
    })
  }

  private async request<T>(baseUrl: string, path: string, options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const headers = new Headers({ accept: 'application/json' })
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value)
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    if (options.token) headers.set('authorization', `Bearer ${options.token}`)
    const requestInit: RequestInit = { method: options.method ?? 'GET', headers }
    if (options.body !== undefined) requestInit.body = JSON.stringify(options.body)
    const response = await this.fetcher(`${baseUrl}${path}`, requestInit)
    const raw = await response.text()
    let data: unknown = null
    if (raw) {
      try { data = JSON.parse(raw) } catch { data = null }
    }
    if (!response.ok) {
      const error = isRecord(data) && typeof data.errorCode === 'string' ? data.errorCode : null
      throw new CodingNsControlApiError(`Control API 请求失败 (${response.status})`, response.status, error)
    }
    return data as T
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('Control API 地址必须使用 HTTP(S)')
  return url.toString().replace(/\/$/u, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
