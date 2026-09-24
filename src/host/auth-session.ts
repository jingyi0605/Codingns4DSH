import type {
  AuthDeviceManagementSnapshotDto,
  CodingNsAuthLoginResult,
  CodingNsAuthSessionSnapshot,
  HostBindRequest,
  LoginByEmailRequest,
  TunnelBindingSummary,
} from '../shared/contracts/auth.js'
import type { CodingNsControlApiClient } from './control-api-client.js'
import type { RelaySignalingTicketResponse } from '../shared/contracts/signaling.js'
import type { HostCredentialRecord, CodingNsCredentialStore } from './credential-store.js'

/**
 * Host 侧认证协调器。
 * 只管理状态和依赖边界，不创建 HTTP、计时器或 WebRTC 资源。
 */
export class CodingNsAuthSession {
  private state: CodingNsAuthSessionSnapshot = {
    status: 'logged_out',
    account: null,
    currentDevice: null,
    binding: null,
    expiresAt: null,
    errorCode: null,
  }

  private accessToken: string | null = null
  private credential: HostCredentialRecord | null = null

  constructor(
    private readonly client: CodingNsControlApiClient,
    private readonly credentials: CodingNsCredentialStore,
    private readonly controlBaseUrl: string,
  ) {
    if (controlBaseUrl.trim() === '') {
      throw new TypeError('controlBaseUrl 不能为空')
    }
  }

  snapshot(): CodingNsAuthSessionSnapshot {
    return {
      ...this.state,
      account: this.state.account ? { ...this.state.account } : null,
      currentDevice: this.state.currentDevice ? { ...this.state.currentDevice } : null,
      binding: this.state.binding ? { ...this.state.binding } : null,
    }
  }

  /**
   * 供 Host 侧 Control API/信令适配器临时取用 access token。
   * 调用方不得把返回值写入快照、日志或发送给 Client。
   */
  getAccessToken(): string | null {
    return this.accessToken
  }

  /** 仅供 Host 内部设备运行时调用，Client 不会拿到控制面客户端。 */
  getControlClient(): CodingNsControlApiClient {
    return this.client
  }

  /** 使用保存的 refresh token 恢复会话；没有凭据时保持 logged_out。 */
  async restore(): Promise<CodingNsAuthSessionSnapshot> {
    const credential = await this.credentials.read()
    if (!credential) {
      this.reset('logged_out')
      return this.snapshot()
    }

    this.credential = credential
    return this.refresh()
  }

  async login(request: LoginByEmailRequest): Promise<CodingNsAuthLoginResult> {
    this.state = { ...this.state, status: 'logging_in', errorCode: null }
    try {
      const response = await this.client.login(request)
      await this.saveResponse(response)
      await this.refreshDeviceAndBinding()
      this.state = { ...this.state, status: 'authenticated', errorCode: null }
      return this.loginResult()
    } catch (error) {
      this.state = { ...this.state, status: 'failed', errorCode: errorCode(error) }
      throw error
    }
  }

  async refresh(): Promise<CodingNsAuthSessionSnapshot> {
    const credential = this.credential ?? await this.credentials.read()
    if (!credential) {
      this.reset('logged_out')
      return this.snapshot()
    }

    this.state = { ...this.state, status: 'refreshing', errorCode: null }
    try {
      const response = await this.client.refresh({ refreshToken: credential.refreshToken })
      await this.saveResponse(response)
      await this.refreshDeviceAndBinding()
      this.state = { ...this.state, status: 'authenticated', errorCode: null }
      return this.snapshot()
    } catch (error) {
      this.accessToken = null
      this.state = { ...this.state, status: 'revoked', errorCode: errorCode(error) }
      throw error
    }
  }

  async logout(): Promise<void> {
    this.accessToken = null
    this.credential = null
    await this.credentials.clear()
    this.reset('logged_out')
  }

  async getDevices(): Promise<AuthDeviceManagementSnapshotDto> {
    const token = this.requireAccessToken()
    const devices = await this.client.getDevices(token)
    this.state = { ...this.state, currentDevice: devices.currentDevice }
    return devices
  }

  async listHostBindings(): Promise<TunnelBindingSummary[]> {
    const response = await this.client.listHostBindings(this.requireAccessToken())
    const binding = response.bindings[0] ?? null
    this.state = { ...this.state, binding }
    return response.bindings
  }

  async bindHost(request: HostBindRequest): Promise<TunnelBindingSummary> {
    const response = await this.client.bindHost(this.requireAccessToken(), request)
    this.state = { ...this.state, binding: response.binding }
    return response.binding
  }

  async unbindHost(bindingId: string): Promise<TunnelBindingSummary> {
    const response = await this.client.unbindHost(this.requireAccessToken(), bindingId)
    if (this.state.binding?.bindingId === response.binding.bindingId) {
      this.state = { ...this.state, binding: null }
    }
    return response.binding
  }

  /** 为浏览器 Client 申请短期票据；access/refresh token 永远不离开 Host。 */
  async createClientSignalingTicket(tunnelDomain?: string): Promise<RelaySignalingTicketResponse> {
    const domain = tunnelDomain?.trim() || this.state.binding?.tunnelDomain
    if (!domain) throw new Error('CodingNS 尚未绑定 Host')
    return this.client.createSignalingTicket(this.requireAccessToken(), { tunnelDomain: domain })
  }

  private async saveResponse(response: {
    account: CodingNsAuthSessionSnapshot['account']
    accessToken: string
    expiresAt: string
    refreshToken: string
    refreshTokenExpiresAt: string
  }): Promise<void> {
    this.accessToken = response.accessToken
    this.credential = {
      controlBaseUrl: this.controlBaseUrl,
      accountId: response.account?.accountId ?? '',
      refreshToken: response.refreshToken,
      refreshTokenExpiresAt: response.refreshTokenExpiresAt,
      deviceId: this.state.currentDevice?.deviceId ?? null,
      savedAt: new Date().toISOString(),
    }
    await this.credentials.write(this.credential)
    this.state = {
      ...this.state,
      account: response.account,
      expiresAt: response.expiresAt,
    }
  }

  private async refreshDeviceAndBinding(): Promise<void> {
    const devices = await this.client.getDevices(this.requireAccessToken())
    const bindings = await this.client.listHostBindings(this.requireAccessToken())
    this.state = {
      ...this.state,
      currentDevice: devices.currentDevice,
      binding: bindings.bindings[0] ?? null,
    }
  }

  private loginResult(): CodingNsAuthLoginResult {
    if (!this.state.account) throw new Error('认证响应缺少 account')
    return {
      account: this.state.account,
      expiresAt: this.state.expiresAt ?? '',
      currentDevice: this.state.currentDevice,
      binding: this.state.binding,
    }
  }

  private requireAccessToken(): string {
    if (!this.accessToken) throw new Error('CodingNS 会话未认证')
    return this.accessToken
  }

  private reset(status: CodingNsAuthSessionSnapshot['status']): void {
    this.accessToken = null
    this.credential = null
    this.state = {
      status,
      account: null,
      currentDevice: null,
      binding: null,
      expiresAt: null,
      errorCode: null,
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  return 'AUTH_REQUEST_FAILED'
}
