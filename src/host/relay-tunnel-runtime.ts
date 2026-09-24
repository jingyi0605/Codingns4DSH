/**
 * CodingNS Relay Host 运行时。
 *
 * 这个模块把 Host 侧真正需要的运行时资源集中起来：DTLS 身份、Host 票据、
 * Relay 信令 WebSocket 以及每个 Client 独立的 werift PeerConnection。业务层
 * 只接收已经打开的 DataChannel Carrier，不接触 access token 或信令细节。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RTCCertificate, RTCDtlsTransport, RTCPeerConnection } from 'werift'
import type { FeatureResourceScope } from '../shared/contracts/feature.js'
import type { FeatureModule } from '../shared/contracts/feature.js'
import type { FeatureRegistry } from '../features/registry.js'
import type { RelayIceServer, RelaySignalingTicketResponse } from '../shared/contracts/signaling.js'
import type { CodingNsControlApiClient } from './control-api-client.js'
import {
  acceptWebRtcHost,
  createHostSignalingTicketRequest,
  type HostPeerConnectionLike,
  type WebRtcHostAcceptor,
  type WebRtcHostSession,
} from '../transport/webrtc-host.js'
import { DshGateway, type DshGatewayFeature } from '../transport/dsh-gateway.js'

/** Relay Tunnel 规定的 DataChannel label，不允许使用插件自定义值。 */
export const CODINGNS_TUNNEL_DATA_CHANNEL_LABEL = 'codingns-tunnel'

export interface HostDtlsIdentityMaterial {
  privateKeyPem: string
  certPem: string
  signatureHash: { signature: number; hash: number }
  fingerprint: string
  createdAt: string
  updatedAt: string
}

export interface HostDtlsIdentityStore {
  read(): Promise<HostDtlsIdentityMaterial | null>
  write(identity: HostDtlsIdentityMaterial): Promise<void>
}

/** 文件存储适用于 Host 桌面进程；先写临时文件再 rename，避免半截证书。 */
export class FileHostDtlsIdentityStore implements HostDtlsIdentityStore {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new TypeError('DTLS identity file path 不能为空')
  }

  async read(): Promise<HostDtlsIdentityMaterial | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return parseIdentity(parsed)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  async write(identity: HostDtlsIdentityMaterial): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(identity)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, this.filePath)
  }
}

/** 生成一张新的 werift DTLS 证书，并返回控制面约定的 sha-256 指纹。 */
export async function generateHostDtlsIdentity(): Promise<HostDtlsIdentityMaterial> {
  const certificate = await RTCDtlsTransport.SetupCertificate()
  const fingerprint = formatHostDtlsFingerprint(certificate)
  const now = new Date().toISOString()
  return {
    privateKeyPem: certificate.privateKey,
    certPem: certificate.certPem,
    signatureHash: certificate.signatureHash as unknown as { signature: number; hash: number },
    fingerprint,
    createdAt: now,
    updatedAt: now,
  }
}

/** 读取已有身份，否则生成并持久化；指纹因此跨进程重启保持不变。 */
export async function ensureHostDtlsIdentity(store: HostDtlsIdentityStore): Promise<HostDtlsIdentityMaterial> {
  const existing = await store.read()
  if (existing) return existing
  const generated = await generateHostDtlsIdentity()
  await store.write(generated)
  return generated
}

export function formatHostDtlsFingerprint(certificate: Pick<RTCCertificate, 'getFingerprints'>): string {
  const fingerprints = certificate.getFingerprints()
  const selected = fingerprints.find((item) => item.algorithm.toLowerCase() === 'sha-256') ?? fingerprints[0]
  if (!selected) throw new Error('DTLS 证书缺少指纹')
  const value = selected.value.split(':').map((part) => part.trim().toUpperCase().padStart(2, '0')).join(':')
  return `${selected.algorithm.toLowerCase()} ${value}`
}

export interface HostRelaySession extends WebRtcHostSession {
  readonly tunnelDomain: string
  readonly gateway: DshGateway
}

export interface HostRelayRuntimeOptions {
  readonly controlClient: Pick<CodingNsControlApiClient, 'createSignalingTicket'>
  /** DSH 独立设备可注入自己的票据申请器，避免复用 CodingNS binding。 */
  readonly createTicket?: (input: { accessToken: string; identity: HostDtlsIdentityMaterial; credentialVersion?: number }) => Promise<RelaySignalingTicketResponse>
  readonly accessToken: string
  readonly bindingId?: string
  readonly credentialVersion?: number
  readonly dtlsStore: HostDtlsIdentityStore
  readonly signalingSocketFactory?: (url: string) => Promise<HostSignalingSocket> | HostSignalingSocket
  readonly peerConnectionFactory?: (options: { iceServers: RelayIceServer[]; iceTransportPolicy: 'all' | 'relay' }) => HostPeerConnectionLike
  readonly resources?: Pick<FeatureResourceScope, 'add'>
  readonly onSession?: (session: HostRelaySession) => void | Promise<void>
  readonly gatewayFeatures?: readonly DshGatewayFeature[]
  readonly gatewayRegistry?: FeatureRegistry<unknown, FeatureModule<unknown>>
  readonly generation?: string
  readonly hostId?: string
  readonly ticketRenewSkewMs?: number
}

export interface HostRelayRuntime {
  readonly identity: HostDtlsIdentityMaterial
  readonly ticket: RelaySignalingTicketResponse
  readonly acceptor: WebRtcHostAcceptor
  readonly sessions: ReadonlyMap<string, WebRtcHostSession>
  close(): Promise<void>
}

/**
 * 启动一个可接收多个 Client 的 Host Relay runtime。
 * `resources` 若提供，所有 WebSocket、PeerConnection、心跳和换票计时器都会登记。
 */
export async function startHostRelayRuntime(options: HostRelayRuntimeOptions): Promise<HostRelayRuntime> {
  if (!options.accessToken.trim()) throw new TypeError('Host Relay accessToken 不能为空')
  if (!options.bindingId?.trim() && options.createTicket === undefined) throw new TypeError('Host Relay bindingId 或 createTicket 必须提供')
  const bindingId = options.bindingId?.trim() ?? ''
  const identity = await ensureHostDtlsIdentity(options.dtlsStore)
  const requestTicket = (): Promise<RelaySignalingTicketResponse> => options.createTicket
    ? options.createTicket({ accessToken: options.accessToken, identity, ...(options.credentialVersion === undefined ? {} : { credentialVersion: options.credentialVersion }) })
    : options.controlClient.createSignalingTicket(options.accessToken, createHostSignalingTicketRequest({
    bindingId,
    hostDtlsFingerprint: identity.fingerprint,
    ...(options.credentialVersion === undefined ? {} : { credentialVersion: options.credentialVersion }),
  }))
  let ticket = await requestTicket()
  let closed = false
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let renewalInFlight = false
  let acceptor = await createAcceptor(ticket)
  const gateways = new Map<string, DshGateway>()

  const scheduleRenewal = (): void => {
    if (renewTimer !== null) clearTimeout(renewTimer)
    const expiresAt = Date.parse(ticket.expiresAt)
    const skew = options.ticketRenewSkewMs ?? 30_000
    // 信令票据只在 WebSocket 建立时校验。连接仍然存活时不能因为票据
    // 到期而替换 WebSocket，否则会在客户端 offer/answer 期间丢信令。
    const signalingOpen = isSignalingOpen(acceptor.signaling)
    const untilExpiry = Number.isFinite(expiresAt) ? expiresAt - Date.now() : 60_000
    const delay = signalingOpen
      ? Math.min(2_147_000_000, Math.max(30_000, untilExpiry - skew))
      : Math.max(1_000, Math.min(30_000, untilExpiry - skew))
    renewTimer = setTimeout(() => { void renew() }, delay)
    options.resources?.add(() => {
      if (renewTimer !== null) clearTimeout(renewTimer)
      renewTimer = null
    })
  }
  const renew = async (): Promise<void> => {
    if (closed || renewalInFlight) return
    if (isSignalingOpen(acceptor.signaling)) {
      scheduleRenewal()
      return
    }
    renewalInFlight = true
    try {
      const nextTicket = await requestTicket()
      const previous = acceptor
      ticket = nextTicket
      acceptor = await createAcceptor(nextTicket)
      await previous.close()
      scheduleRenewal()
    } catch {
      if (!closed) {
        renewTimer = setTimeout(() => { void renew() }, 5_000)
      }
    } finally {
      renewalInFlight = false
    }
  }
  scheduleRenewal()
  options.resources?.add(() => runtimeClose())

  async function createAcceptor(currentTicket: RelaySignalingTicketResponse): Promise<WebRtcHostAcceptor> {
    // acceptWebRtcHost 负责等待 registered；这里必须返回尚未消费注册事件的原始 socket。
    const socketFactory = options.signalingSocketFactory ?? createRawHostSignalingSocket
    return acceptWebRtcHost({
      signalingTicket: currentTicket,
      signalingSocketFactory: socketFactory,
      peerConnectionFactory: options.peerConnectionFactory ?? createWeriftPeerConnectionFactory(identity),
      channelLabel: CODINGNS_TUNNEL_DATA_CHANNEL_LABEL,
      onConnection: (session) => {
        if (!session.carrier) return
        const gateway = new DshGateway({
          carrier: session.carrier,
          generation: options.generation ?? '1',
          hostScope: { hostId: options.hostId ?? bindingId, kind: 'local' },
          ...(options.gatewayFeatures === undefined ? {} : { features: options.gatewayFeatures }),
          ...(options.gatewayRegistry === undefined ? {} : { registry: options.gatewayRegistry }),
        })
        gateway.start()
        gateways.set(session.sessionId, gateway)
        void options.onSession?.({
          sessionId: session.sessionId,
          peerConnection: session.peerConnection,
          get carrier() { return session.carrier },
          close: async () => { await gateway.close(); await session.close() },
          tunnelDomain: currentTicket.tunnelDomain,
          gateway,
        })
      },
      onSessionClosed: async (sessionId) => {
        const gateway = gateways.get(sessionId)
        gateways.delete(sessionId)
        await gateway?.close()
      },
    })
  }

  async function runtimeClose(): Promise<void> {
    if (closed) return
    closed = true
    if (renewTimer !== null) clearTimeout(renewTimer)
    renewTimer = null
    await acceptor.close()
    for (const gateway of gateways.values()) await gateway.close()
    gateways.clear()
  }

  return {
    identity,
    get ticket() { return ticket },
    get acceptor() { return acceptor },
    get sessions() { return acceptor.sessions },
    close: runtimeClose,
  }
}

function isSignalingOpen(socket: unknown): boolean {
  if (!isRecord(socket) || typeof socket.readyState !== 'number') return true
  return socket.readyState === 1
}

/** 为 Host answerer 创建 werift PeerConnection，并适配到 transport 的注入接口。 */
export function createWeriftPeerConnectionFactory(identity?: HostDtlsIdentityMaterial): NonNullable<HostRelayRuntimeOptions['peerConnectionFactory']> {
  return ({ iceServers, iceTransportPolicy }) => {
    const certificate = identity ? new RTCCertificate(identity.privateKeyPem, identity.certPem, identity.signatureHash as never) : undefined
    const peer = new RTCPeerConnection({ iceServers, iceTransportPolicy, ...(certificate ? { certificates: [certificate] } : {}) })
    const adapted: HostPeerConnectionLike = {
      get onicecandidate() { return peer.onicecandidate as HostPeerConnectionLike['onicecandidate'] },
      set onicecandidate(value) { peer.onicecandidate = value as never },
      get ondatachannel() { return peer.ondatachannel as HostPeerConnectionLike['ondatachannel'] },
      set ondatachannel(value) { peer.ondatachannel = value as never },
      createAnswer: async () => {
        const answer = await peer.createAnswer()
        return { type: 'answer', sdp: answer.sdp }
      },
      setRemoteDescription: (description) => peer.setRemoteDescription(description as never),
      setLocalDescription: (description) => peer.setLocalDescription(description as never).then(() => undefined),
      addIceCandidate: (candidate) => peer.addIceCandidate(candidate as never),
      close: () => { void peer.close() },
    }
    return adapted
  }
}

export interface HostSignalingSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'message' | 'close' | 'error', listener: (event: Event) => void): void
}

/** 建立 Host 信令并等待服务端 registered；registered 后每 20 秒发 ping。 */
export async function createRegisteredHostSignalingSocket(url: string, options: { registrationTimeoutMs?: number; heartbeatIntervalMs?: number } = {}): Promise<HostSignalingSocket> {
  const WebSocketCtor = globalThis.WebSocket
  if (!WebSocketCtor) throw new Error('当前 Node 运行时没有 WebSocket 实现')
  const socket = new WebSocketCtor(url) as unknown as HostSignalingSocket & { onopen: ((event: Event) => void) | null; onmessage: ((event: MessageEvent) => void) | null; onclose: ((event: CloseEvent) => void) | null; onerror: ((event: Event) => void) | null }
  const timeoutMs = options.registrationTimeoutMs ?? 15_000
  const heartbeatMs = options.heartbeatIntervalMs ?? 20_000
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => finish(new Error('等待 Relay registered 超时')), timeoutMs)
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let done = false
    let result: HostSignalingSocket | null = null
    const cleanup = (): void => {
      if (timer !== null) clearTimeout(timer)
      if (heartbeat !== null) clearInterval(heartbeat)
      timer = null
      heartbeat = null
    }
    const finish = (error?: Error): void => {
      if (done) return
      done = true
      cleanup()
      if (error) {
        try { socket.close(1000, 'registration_failed') } catch { /* ignore */ }
        reject(error)
      } else {
        heartbeat = heartbeatMs > 0 ? setInterval(() => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping', at: new Date().toISOString() }))
        }, heartbeatMs) : null
        result = {
          get readyState() { return socket.readyState },
          send: (data) => socket.send(data),
          close: (code, reason) => {
            cleanup()
            socket.close(code, reason)
          },
          addEventListener: (type, listener) => socket.addEventListener(type, listener),
          removeEventListener: (type, listener) => socket.removeEventListener(type, listener),
        }
        resolve(result)
      }
    }
    socket.onmessage = (event) => {
      let message: unknown
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : '') } catch { return }
      if (isRecord(message) && message.type === 'registered') finish()
      else if (isRecord(message) && message.type === 'error') finish(new Error(`${String(message.errorCode)}: ${String(message.detail)}`))
    }
    socket.onerror = () => {
      if (done) { cleanup(); return }
      finish(new Error('Relay 信令 WebSocket 连接失败'))
    }
    socket.onclose = () => {
      if (done) { cleanup(); return }
      finish(new Error('Relay 信令 WebSocket 已关闭'))
    }
  })
}

/** 默认运行时使用的原始 WebSocket 工厂，注册握手交给 acceptWebRtcHost 统一处理。 */
async function createRawHostSignalingSocket(url: string): Promise<HostSignalingSocket> {
  const WebSocketCtor = globalThis.WebSocket
  if (!WebSocketCtor) throw new Error('当前 Node 运行时没有 WebSocket 实现')
  const socket = new WebSocketCtor(url) as unknown as HostSignalingSocket
  return socket
}

function parseIdentity(value: unknown): HostDtlsIdentityMaterial {
  if (!isRecord(value) || typeof value.privateKeyPem !== 'string' || typeof value.certPem !== 'string'
    || typeof value.fingerprint !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
    || !isRecord(value.signatureHash) || typeof value.signatureHash.signature !== 'number' || typeof value.signatureHash.hash !== 'number') {
    throw new TypeError('DTLS identity 文件格式无效')
  }
  return {
    privateKeyPem: value.privateKeyPem,
    certPem: value.certPem,
    fingerprint: value.fingerprint,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    signatureHash: { signature: value.signatureHash.signature, hash: value.signatureHash.hash },
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === code
}
