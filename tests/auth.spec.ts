import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsAuthSession } from '../dist/host/auth-session.js'
import { CODINGNS_CONTROL_API_PATHS, HttpCodingNsControlApiClient } from '../dist/host/control-api-client.js'
import { InMemoryCodingNsCredentialStore } from '../dist/host/credential-store.js'
import type {
  AuthDeviceManagementSnapshotDto,
  HostBindRequest,
  HostBindResponse,
  HostBindingsResponse,
  HostLabelAvailabilityResponse,
  HostUnbindResponse,
  LoginByEmailRequest,
} from '../dist/shared/contracts/auth.js'
import type {
  CodingNsControlApiClient,
  LoginByEmailResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from '../dist/host/control-api-client.js'
import type { RelaySignalingTicketRequest, RelaySignalingTicketResponse } from '../dist/shared/contracts/signaling.js'

const account = {
  accountId: 'account_1',
  email: 'owner@example.com',
  emailVerified: true,
  role: 'user' as const,
  mustChangePassword: false,
  createdAt: '2026-09-21T00:00:00.000Z',
  status: 'active' as const,
}

const device = {
  deviceId: 'device_1',
  clientType: 'desktop' as const,
  clientInstanceId: 'instance_1',
  displayName: '开发机',
  browserName: null,
  browserVersion: null,
  osName: 'macOS',
  osVersion: '15',
  lastSourceAddress: null,
  lastSeenAt: '2026-09-21T00:00:00.000Z',
  isPrimary: true,
  isCurrent: true,
  isLegacy: false,
}

const binding = {
  bindingId: 'binding_1',
  tunnelDomain: 'dev.example.com',
  hostPublicKey: 'public-key',
  hostFingerprint: 'fingerprint',
  relayBaseUrl: 'https://relay.example.com',
  controlBaseUrl: 'https://control.example.com',
  sessionRateLimitBytesPerSecond: null,
  effectiveSessionRateLimitBytesPerSecond: null,
  status: 'active' as const,
}

class FakeControlApiClient implements CodingNsControlApiClient {
  readonly calls: string[] = []
  private responseToken = 'access_1'

  async login(_request: LoginByEmailRequest): Promise<LoginByEmailResponse> {
    this.calls.push('login')
    return {
      account,
      accessToken: this.responseToken,
      expiresAt: '2026-09-21T01:00:00.000Z',
      refreshToken: 'refresh_1',
      refreshTokenExpiresAt: '2026-10-21T00:00:00.000Z',
    }
  }

  async refresh(_request: RefreshTokenRequest): Promise<RefreshTokenResponse> {
    this.calls.push('refresh')
    this.responseToken = 'access_2'
    return {
      account,
      accessToken: this.responseToken,
      expiresAt: '2026-09-21T02:00:00.000Z',
      refreshToken: 'refresh_2',
      refreshTokenExpiresAt: '2026-11-21T00:00:00.000Z',
    }
  }

  async getDevices(_accessToken: string): Promise<AuthDeviceManagementSnapshotDto> {
    this.calls.push('devices')
    return { currentDevice: device, otherActiveDevices: [], recentLoginRecords: [] }
  }

  async listHostBindings(_accessToken: string): Promise<HostBindingsResponse> {
    this.calls.push('hosts')
    return { bindings: [binding] }
  }

  async bindHost(_accessToken: string, _request: HostBindRequest): Promise<HostBindResponse> {
    this.calls.push('bind')
    return { binding, created: true }
  }

  async unbindHost(_accessToken: string, _bindingId: string): Promise<HostUnbindResponse> {
    this.calls.push('unbind')
    return { released: true, binding }
  }

  async checkHostLabelAvailability(_accessToken: string, _hostLabel: string): Promise<HostLabelAvailabilityResponse> {
    this.calls.push('availability')
    return { hostLabel: 'dev', tunnelDomain: null, available: true, reason: 'available' }
  }

  async createSignalingTicket(_accessToken: string, _request: RelaySignalingTicketRequest): Promise<RelaySignalingTicketResponse> {
    this.calls.push('signaling-ticket')
    return {
      ticket: 'ticket',
      expiresAt: '2026-09-21T01:00:00.000Z',
      signalingBaseUrl: 'https://relay.example.com',
      iceServers: [],
      iceTransportPolicy: 'all',
      hostDtlsFingerprint: binding.hostFingerprint,
      bindingId: binding.bindingId,
      tunnelDomain: binding.tunnelDomain,
      trafficRemainingBytes: '0',
    }
  }
}

test('控制面路径与主仓库契约一致', () => {
  assert.equal(CODINGNS_CONTROL_API_PATHS.login, '/api/public/auth/login')
  assert.equal(CODINGNS_CONTROL_API_PATHS.refresh, '/api/public/auth/refresh')
  assert.equal(CODINGNS_CONTROL_API_PATHS.hosts, '/api/v1/hosts')
  assert.equal(CODINGNS_CONTROL_API_PATHS.bind, '/api/v1/hosts/bind')
  assert.equal(CODINGNS_CONTROL_API_PATHS.signalingTicket, '/api/v1/relay/signaling/ticket')
})

test('HTTP Control API Client 使用真实路径和 Bearer token', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new HttpCodingNsControlApiClient({
    controlBaseUrl: 'https://control.example.com/',
    fetcher: async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ bindings: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await client.listHostBindings('access-token')
  assert.equal(calls[0]?.url, 'https://control.example.com/api/v1/hosts')
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Bearer access-token')
})

test('HTTP Client 使用新的 WebRTC 信令票据接口并携带请求体', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new HttpCodingNsControlApiClient({
    controlBaseUrl: 'https://control.example.com',
    fetcher: async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ ticket: 'ticket' }), { status: 201 })
    },
  })
  await client.createSignalingTicket('access-token', { tunnelDomain: 'host.example' })
  assert.equal(calls[0]?.url, 'https://control.example.com/api/v1/relay/signaling/ticket')
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.deepEqual(await new Response(calls[0]?.init?.body).json(), { tunnelDomain: 'host.example' })
})

test('HTTP Client 不访问父仓库不存在的旧设备接口', async () => {
  const calls: string[] = []
  const client = new HttpCodingNsControlApiClient({
    controlBaseUrl: 'https://control.example.com',
    fetcher: async (input) => {
      calls.push(String(input))
      return new Response('{}', { status: 404 })
    },
  })
  assert.deepEqual(await client.getDevices('access-token'), {
    currentDevice: null,
    otherActiveDevices: [],
    recentLoginRecords: [],
  })
  assert.deepEqual(calls, [])
})

test('Host 认证状态机保存 refresh token，但快照不暴露任何 token', async () => {
  const client = new FakeControlApiClient()
  const store = new InMemoryCodingNsCredentialStore()
  const auth = new CodingNsAuthSession(client, store, 'https://control.example.com')

  const result = await auth.login({ email: account.email, password: 'secret' })
  assert.equal(result.account.accountId, account.accountId)
  assert.equal(auth.snapshot().status, 'authenticated')
  assert.equal('accessToken' in auth.snapshot(), false)
  assert.equal('refreshToken' in auth.snapshot(), false)

  const stored = await store.read()
  assert.equal(stored?.refreshToken, 'refresh_1')
  assert.equal(stored?.accountId, account.accountId)
  assert.equal(auth.snapshot().currentDevice?.deviceId, device.deviceId)
  assert.equal(auth.snapshot().binding?.bindingId, binding.bindingId)

  await auth.refresh()
  assert.equal((await store.read())?.refreshToken, 'refresh_2')
  assert.equal(auth.snapshot().expiresAt, '2026-09-21T02:00:00.000Z')
})

test('Host 绑定与解绑始终使用内存中的 access token', async () => {
  const client = new FakeControlApiClient()
  const auth = new CodingNsAuthSession(client, new InMemoryCodingNsCredentialStore(), 'https://control.example.com')
  await auth.login({ email: account.email, password: 'secret' })

  const bound = await auth.bindHost({ hostLabel: 'dev', hostPublicKey: 'key', hostFingerprint: 'fp' })
  assert.equal(bound.bindingId, binding.bindingId)
  const released = await auth.unbindHost(binding.bindingId)
  assert.equal(released.bindingId, binding.bindingId)
  assert.deepEqual(client.calls.slice(-2), ['bind', 'unbind'])
})

test('退出会清除 Host 凭据和状态', async () => {
  const store = new InMemoryCodingNsCredentialStore()
  const auth = new CodingNsAuthSession(new FakeControlApiClient(), store, 'https://control.example.com')
  await auth.login({ email: account.email, password: 'secret' })
  await auth.logout()
  assert.equal(await store.read(), null)
  assert.equal(auth.snapshot().status, 'logged_out')
  assert.equal(auth.snapshot().account, null)
})
