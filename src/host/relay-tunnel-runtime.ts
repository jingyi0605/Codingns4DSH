/**
 * Codingns4DSH Relay Host 运行时。
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
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from '../transport/debug.js'
import { DATA_CHANNEL_MAX_MESSAGE_BYTES } from '../transport/carrier.js'

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
  /** DSH 独立设备可注入自己的票据申请器，避免复用 Codingns4DSH binding。 */
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
  /** 传给 DSH Gateway 的运行时版本；缺省时仅保留独立模块测试兼容性。 */
  readonly dshVersion?: string
  readonly gatewayRegistry?: FeatureRegistry<unknown, FeatureModule<unknown>>
  readonly debug?: DshTransportDebugLogger
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

/** 同一 Host 进程内只允许一个 Relay runtime，避免热重载留下旧 Gateway 和流。 */
const activeRelayRuntimes = new Map<string, { close(): Promise<void> }>()

/**
 * 启动一个可接收多个 Client 的 Host Relay runtime。
 * `resources` 若提供，所有 WebSocket、PeerConnection、心跳和换票计时器都会登记。
 */
export async function startHostRelayRuntime(options: HostRelayRuntimeOptions): Promise<HostRelayRuntime> {
  if (!options.accessToken.trim()) throw new TypeError('Host Relay accessToken 不能为空')
  if (!options.bindingId?.trim() && options.createTicket === undefined) throw new TypeError('Host Relay bindingId 或 createTicket 必须提供')
  const bindingId = options.bindingId?.trim() ?? ''
  const runtimeKey = (options.hostId?.trim() || bindingId) || null
  const previousRuntime = runtimeKey === null ? undefined : activeRelayRuntimes.get(runtimeKey)
  if (previousRuntime) await previousRuntime.close()
  const debug = options.debug ?? createDshTransportDebugLogger({ side: 'host', component: 'relay-runtime' })
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
  let renewalResourceRegistered = false
  let acceptor = await createAcceptor(ticket)
  const gateways = new Map<string, DshGateway>()

  const scheduleRenewal = (): void => {
    if (renewTimer !== null) clearTimeout(renewTimer)
    if (closed) return
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
    if (options.resources && !renewalResourceRegistered) {
      renewalResourceRegistered = true
      options.resources.add(() => {
        if (renewTimer !== null) clearTimeout(renewTimer)
        renewTimer = null
      })
    }
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
      debug,
      onConnection: (session) => {
        if (!session.carrier) return
        const gateway = new DshGateway({
          carrier: session.carrier,
          generation: options.generation ?? '1',
          hostScope: { hostId: options.hostId ?? bindingId, kind: 'local' },
          ...(options.gatewayFeatures === undefined ? {} : { features: options.gatewayFeatures }),
          ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
          ...(options.gatewayRegistry === undefined ? {} : { registry: options.gatewayRegistry }),
          debug,
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
    if (runtimeKey !== null && activeRelayRuntimes.get(runtimeKey) === registration) activeRelayRuntimes.delete(runtimeKey)
    if (renewTimer !== null) clearTimeout(renewTimer)
    renewTimer = null
    await acceptor.close()
    for (const gateway of gateways.values()) await gateway.close()
    gateways.clear()
  }

  const registration = { close: runtimeClose }
  if (runtimeKey !== null) activeRelayRuntimes.set(runtimeKey, registration)

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

/** werift PeerConnection 中适配层需要用到的最小结构，便于用替身测试提前 connect 的门控。 */
export interface WeriftPeerConnectionLike {
  readonly connectionState: string
  readonly iceConnectionState: string
  onicecandidate: unknown
  ondatachannel: unknown
  createAnswer(): Promise<{ sdp: string }>
  setRemoteDescription(description: unknown): Promise<void>
  setLocalDescription(description: unknown): Promise<void>
  addIceCandidate(candidate: unknown): Promise<void>
  addEventListener(type: string, listener: unknown): void
  removeEventListener(type: string, listener: unknown): void
  close(): void
  /** werift 声明为 private，因此这里是可选字段。 */
  connect?(): Promise<void>
}

/**
 * 把 werift PeerConnection 适配到 Host 注入接口，并在此处实现「提前 connect」。
 *
 * werift 的 setLocalDescription(answer) 内部会先 await gatherCandidates() 再调用
 * connect()。STUN/TURN 不可达时 gatherCandidates 要等满 5s 超时，ICE 检查因此被
 * 推迟 5s，DataChannel 才迟迟不 open（实测 dead STUN 下 5.1s，正常网络 0.3s）。
 *
 * 这里在「首个本地候选出现」时提前调用 connect()，把 ICE 检查与剩余的候选收集
 * 并行起来，实测可把 open 时间压到 ~0.18s。两个约束必须同时满足：
 *   1. 必须有本地候选：零候选时调用 connect() 会让 ICE 进入 failed（实测必然失败）。
 *   2. 必须已有 remote description：iceTransport.start() 在缺 remoteParams 时直接抛错。
 * 提前调用是安全的：werift 收集结束后自己再调 connect() 时，ICE/DTLS 已 connected，
 * 会命中 connect() 内部的 checkDtlsConnected 早退分支，不会重复握手。
 */
export function adaptWeriftPeerConnection(peer: WeriftPeerConnectionLike): HostPeerConnectionLike {
  let originalOnIceCandidate: HostPeerConnectionLike['onicecandidate'] = null
  let remoteDescriptionSet = false
  let earlyConnectStarted = false
  let peerClosed = false
  const earlyConnect = async (): Promise<void> => {
    if (earlyConnectStarted || peerClosed || !remoteDescriptionSet) return
    // werift 把 connect() 声明为 private；这是唯一能绕开 5s 收集等待的入口
    // （公开的二次 setLocalDescription 会被 signaling state 拒绝）。
    const connect = peer.connect?.bind(peer)
    if (typeof connect !== 'function') return
    earlyConnectStarted = true
    try {
      await connect()
    } catch {
      // 失败不影响主流程：werift 收集结束后的 connect() 仍会重试。
      earlyConnectStarted = false
    }
  }
  return {
    get connectionState() { return peer.connectionState },
    get iceConnectionState() { return peer.iceConnectionState },
    get onicecandidate() { return originalOnIceCandidate as HostPeerConnectionLike['onicecandidate'] },
    set onicecandidate(value) {
      originalOnIceCandidate = value
      if (!value) { peer.onicecandidate = null; return }
      peer.onicecandidate = ((event: { candidate?: unknown } | undefined) => {
        value(event as never)
        // 首个本地候选出现即触发；零候选时绝不调用 connect()。
        if (event?.candidate) void earlyConnect()
      }) as never
    },
    get ondatachannel() { return peer.ondatachannel as HostPeerConnectionLike['ondatachannel'] },
    set ondatachannel(value) { peer.ondatachannel = value as never },
    addEventListener: (type, listener) => { peer.addEventListener(type, listener as never) },
    removeEventListener: (type, listener) => { peer.removeEventListener(type, listener as never) },
    createAnswer: async () => {
      const answer = await peer.createAnswer()
      return { type: 'answer', sdp: answer.sdp }
    },
    setRemoteDescription: async (description) => {
      await peer.setRemoteDescription(description as never)
      remoteDescriptionSet = true
    },
    setLocalDescription: (description) => peer.setLocalDescription(description as never).then(() => undefined),
    addIceCandidate: (candidate) => peer.addIceCandidate(candidate as never),
    close: () => { peerClosed = true; peer.close() },
  }
}

/** 为 Host answerer 创建 werift PeerConnection，并适配到 transport 的注入接口。 */
export function createWeriftPeerConnectionFactory(identity?: HostDtlsIdentityMaterial): NonNullable<HostRelayRuntimeOptions['peerConnectionFactory']> {
  return ({ iceServers, iceTransportPolicy }) => {
    const certificate = identity ? new RTCCertificate(identity.privateKeyPem, identity.certPem, identity.signatureHash as never) : undefined
    // 浏览器按对端 SDP 宣告的 max-message-size 限制 RTCDataChannel.send()。werift 默认
    // 只宣告 64 KiB，而 Carrier 的整分片是 64 KiB 正文加 20 字节头，浏览器一旦发送
    // 超过 64 KiB 的消息就会抛错，中继下的原生设置与附件因此失败。
    const peer = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy,
      maxMessageSize: DATA_CHANNEL_MAX_MESSAGE_BYTES,
      ...(certificate ? { certificates: [certificate] } : {}),
    })
    return adaptWeriftPeerConnection(peer as unknown as WeriftPeerConnectionLike)
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
