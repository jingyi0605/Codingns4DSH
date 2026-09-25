import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FeatureResourceScope } from '../shared/contracts/feature.js'
import type {
  DshDeviceCredentialRecord,
  DshDeviceRegistrationRequest,
  DshDeviceSummary,
  DshRelayTicketResponse,
} from '../shared/contracts/dsh-device.js'
import type { RelaySignalingTicketResponse } from '../shared/contracts/signaling.js'
import type { CodingNsControlApiClient } from './control-api-client.js'
import {
  FileDshDeviceCredentialStore,
  type DshDeviceCredentialStore,
} from './credential-store.js'
import {
  ensureHostDtlsIdentity,
  FileHostDtlsIdentityStore,
  startHostRelayRuntime,
  type HostDtlsIdentityStore,
  type HostRelayRuntime,
} from './relay-tunnel-runtime.js'
import type { DshGatewayFeature } from '../transport/dsh-gateway.js'
import type { DshTransportDebugLogger } from '../transport/debug.js'

export interface DshHostDeviceRuntimeOptions {
  readonly controlClient: Pick<CodingNsControlApiClient, 'registerDshDevice' | 'listDshDevices' | 'heartbeatDshDevice' | 'createDshRelayTicket'>
  readonly accessToken: string
  /** 认证续期后动态读取最新 access token；未提供时沿用 accessToken。 */
  readonly accessTokenProvider?: () => string | null
  readonly credentialStore?: DshDeviceCredentialStore
  readonly dtlsStore?: HostDtlsIdentityStore
  readonly displayName?: string
  readonly protocolVersion?: string
  readonly capabilities?: readonly string[]
  readonly resources?: Pick<FeatureResourceScope, 'add'>
  readonly signalingSocketFactory?: Parameters<typeof startHostRelayRuntime>[0]['signalingSocketFactory']
  readonly peerConnectionFactory?: Parameters<typeof startHostRelayRuntime>[0]['peerConnectionFactory']
  readonly gatewayFeatures?: readonly DshGatewayFeature[]
  readonly heartbeatIntervalMs?: number
  readonly onRuntime?: (runtime: HostRelayRuntime) => void | Promise<void>
  readonly debug?: DshTransportDebugLogger
}

export interface DshHostDeviceRuntime {
  readonly credential: DshDeviceCredentialRecord
  readonly device: DshDeviceSummary
  readonly runtime: HostRelayRuntime
  stop(): Promise<void>
}

/**
 * 注册一个独立的 DSH 设备并启动 Host Relay runtime。
 * 这里不读取或写入 CodingNS binding，设备凭据也与 refresh token 分文件保存。
 */
export async function startDshHostDeviceRuntime(options: DshHostDeviceRuntimeOptions): Promise<DshHostDeviceRuntime> {
  if (!options.accessToken.trim()) throw new TypeError('DSH Host accessToken 不能为空')
  const getAccessToken = (): string => {
    const token = options.accessTokenProvider === undefined ? options.accessToken : options.accessTokenProvider()
    if (typeof token !== 'string' || !token.trim()) throw new Error('DSH Host accessToken 已失效')
    return token
  }
  const credentialStore = options.credentialStore ?? new FileDshDeviceCredentialStore(defaultDshCredentialPath())
  const dtlsStore = options.dtlsStore ?? new FileHostDtlsIdentityStore(defaultDtlsPath())
  const identity = await ensureHostDtlsIdentity(dtlsStore)
  let credential = await credentialStore.read()
  let device: DshDeviceSummary
  if (credential === null || credential.dtlsFingerprint !== identity.fingerprint) {
    const request: DshDeviceRegistrationRequest = {
      displayName: options.displayName?.trim() || 'DSH Host',
      devicePublicKey: identity.certPem,
      dtlsFingerprint: identity.fingerprint,
      protocolVersion: options.protocolVersion ?? 'dsh-envelope-v1',
      capabilities: [...(options.capabilities ?? ['rpc', 'pty', 'file', 'web'])],
    }
    const registered = await options.controlClient.registerDshDevice(getAccessToken(), request)
    credential = {
      deviceId: registered.device.dshDeviceId ?? registered.device.deviceId ?? (() => { throw new Error('DSH 注册响应缺少设备标识') })(),
      deviceCredential: registered.deviceCredential,
      credentialVersion: registered.credentialVersion,
      dtlsFingerprint: identity.fingerprint,
      tunnelDomain: registered.device.tunnelDomain ?? null,
      displayName: registered.device.displayName,
      savedAt: new Date().toISOString(),
    }
    await credentialStore.write(credential)
    device = registered.device
  } else {
    const listed = await options.controlClient.listDshDevices(getAccessToken())
    device = listed.devices.find((candidate) => (candidate.dshDeviceId ?? candidate.deviceId) === credential!.deviceId) ?? {
      dshDeviceId: credential.deviceId,
      deviceId: credential.deviceId,
      displayName: credential.displayName,
      protocolVersion: options.protocolVersion ?? 'dsh-envelope-v1',
      capabilities: [...(options.capabilities ?? [])],
      dtlsFingerprint: credential.dtlsFingerprint,
      ...(credential.tunnelDomain === null ? {} : { tunnelDomain: credential.tunnelDomain }),
      status: 'active',
      online: false,
      lastHeartbeatAt: null,
      createdAt: credential.savedAt,
      updatedAt: credential.savedAt,
    }
  }

  if (credential === null) throw new Error('DSH 设备凭据初始化失败')
  const savedCredential = credential

  await options.controlClient.heartbeatDshDevice(getAccessToken(), savedCredential.deviceId, savedCredential.deviceCredential)
  const runtimeOptions = {
    controlClient: { createSignalingTicket: async () => { throw new Error('DSH runtime 必须使用 DSH ticket') } },
    createTicket: ({ identity: material, credentialVersion }: { accessToken: string; identity: typeof identity; credentialVersion?: number }) => requestDshTicket(options.controlClient, getAccessToken(), savedCredential, material.fingerprint, credentialVersion),
    accessToken: options.accessToken,
    bindingId: savedCredential.deviceId,
    credentialVersion: savedCredential.credentialVersion,
    dtlsStore,
    hostId: savedCredential.deviceId,
    ...(options.resources === undefined ? {} : { resources: options.resources }),
    ...(options.signalingSocketFactory === undefined ? {} : { signalingSocketFactory: options.signalingSocketFactory }),
    ...(options.peerConnectionFactory === undefined ? {} : { peerConnectionFactory: options.peerConnectionFactory }),
    ...(options.gatewayFeatures === undefined ? {} : { gatewayFeatures: options.gatewayFeatures }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  } satisfies Parameters<typeof startHostRelayRuntime>[0]
  const runtime = await startHostRelayRuntime(runtimeOptions)

  let stopped = false
  const interval = options.heartbeatIntervalMs === 0 ? null : setInterval(() => {
    if (stopped) return
    void Promise.resolve()
      .then(() => options.controlClient.heartbeatDshDevice(getAccessToken(), savedCredential.deviceId, savedCredential.deviceCredential))
      .catch(() => undefined)
  }, options.heartbeatIntervalMs ?? 30_000)
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (interval !== null) clearInterval(interval)
    await runtime.close()
  }
  options.resources?.add(stop)
  await options.onRuntime?.(runtime)
  return { credential: savedCredential, device, runtime, stop }
}

async function requestDshTicket(
  client: Pick<CodingNsControlApiClient, 'createDshRelayTicket'>,
  accessToken: string,
  credential: DshDeviceCredentialRecord,
  fingerprint: string,
  credentialVersion: number | undefined,
): Promise<RelaySignalingTicketResponse> {
  const response: DshRelayTicketResponse = await client.createDshRelayTicket(accessToken, {
    dshDeviceId: credential.deviceId,
    deviceCredential: credential.deviceCredential,
    hostDtlsFingerprint: fingerprint,
    credentialVersion: credentialVersion ?? credential.credentialVersion,
    role: 'host',
  })
  return {
    ...response,
    bindingId: response.dshDeviceId,
    tunnelDomain: response.tunnelDomain ?? response.dshDeviceId,
    credentialVersion: response.credentialVersion,
  }
}

function defaultDshCredentialPath(): string { return join(homedir(), '.config', 'dsh-codingns', 'device-credential.json') }
function defaultDtlsPath(): string { return join(homedir(), '.config', 'dsh-codingns', 'dtls-identity.json') }
