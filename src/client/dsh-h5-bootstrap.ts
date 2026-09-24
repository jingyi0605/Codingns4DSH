import type { DshDeviceListResponse, DshRelaySignalingTicket } from '../shared/contracts/dsh-device.js'
import type { RelaySignalingTicketResponse } from '../shared/contracts/signaling.js'
import { SUPPORTED_DSH_VERSION } from '../shared/index.js'
import { installDshTransport } from '../bootstrap/dsh-connection-adapter.js'
import { DshSession } from '../transport/dsh-session.js'
import type { DshHostScope } from '../transport/dsh-envelope.js'
import { DshCodingNsTransport } from '../transport/dsh-transport.js'
import { connectWebRtcClient, type PeerConnectionLike, type SignalingSocketLike } from '../transport/webrtc-client.js'
import type { CodingNsRpcClient } from './features/types.js'
import { RemoteDshWebContext, type RemoteDshWebContextOptions } from './remote-web-context.js'

/** H5 启动器需要的最小参数；不依赖 Node 或 Cordis 私有实现。 */
export interface DshH5BootstrapOptions {
  readonly rpc: CodingNsRpcClient
  readonly dshDeviceId?: string
  readonly signal?: AbortSignal
  readonly boot?: () => void | Promise<void>
}

export interface DshH5BootstrapResult {
  readonly dshDeviceId: string
  readonly registration: ReturnType<typeof installDshTransport>
  readonly dispose: () => Promise<void>
}

export interface DshH5BrowserControlApi {
  listDevices(signal?: AbortSignal): Promise<DshDeviceListResponse>
  createClientTicket(dshDeviceId: string, signal?: AbortSignal): Promise<DshRelaySignalingTicket>
}

export interface DshH5BrowserBootstrapOptions {
  readonly controlApi: DshH5BrowserControlApi
  readonly dshDeviceId?: string
  readonly signal?: AbortSignal
  readonly webContext?: Omit<RemoteDshWebContextOptions, 'transport'>
  readonly generation?: number
  /** 页面可用的阶段提示；不携带任何凭据或业务正文。 */
  readonly onStatus?: (status: DshH5BootstrapStatus) => void
}

export type DshH5BootstrapStatus =
  'ticket'
  | 'webrtc'
  | 'session-ready'
  | 'remote-web'

export interface DshH5BrowserBootstrapResult {
  readonly dshDeviceId: string
  readonly transport: DshCodingNsTransport
  readonly session: DshSession
  readonly webContext?: RemoteDshWebContext
  readonly dispose: () => Promise<void>
}

/**
 * DSH H5 的最小入口：选择独立 DSH 设备、申请票据、建立 WebRTC，最后才启动远程 DSH。
 * 账号凭据只在 Host RPC 内部使用，浏览器只看到设备摘要和短期票据。
 */
export async function startDshH5Bootstrap(options: DshH5BootstrapOptions): Promise<DshH5BootstrapResult> {
  const signal = options.signal
  const devices = await callRpc<DshDeviceListResponse>(options.rpc, 'auth/dsh/device/list', {}, signal)
  const device = chooseDshDevice(devices, options.dshDeviceId)
  const ticket = await callRpc<DshRelaySignalingTicket>(options.rpc, 'auth/dsh/relayTicket', { dshDeviceId: device.dshDeviceId }, signal)
  const connection = await connectWebRtcClient({
    signalingTicket: ticket as unknown as RelaySignalingTicketResponse,
    signalingSocketFactory: (url) => new WebSocket(url) as unknown as SignalingSocketLike,
    peerConnectionFactory: ({ iceServers, iceTransportPolicy }) => createPeerConnection({ iceServers, iceTransportPolicy }),
  })
  const generation = 1
  const hostScope = resolveDshHostScope(ticket)
  const session = new DshSession({ carrier: connection.carrier, role: 'client', generation: String(generation), hostScope })
  const transport = new DshCodingNsTransport({
    carrier: connection.carrier,
    generation: { id: generation, host: { home: '/' } },
    hostScope,
    session,
    requireSessionReady: true,
  })
  let registration: ReturnType<typeof installDshTransport> | undefined
  try {
    session.start()
    await session.waitReady(signal)
    registration = installDshTransport({ dshVersion: SUPPORTED_DSH_VERSION, transport })
    if (options.boot) await options.boot()
    const dispose = async (): Promise<void> => {
      registration?.dispose()
      session.close()
      await transport.close()
      await connection.close()
    }
    return { dshDeviceId: device.dshDeviceId, registration, dispose }
  } catch (error) {
    registration?.dispose()
    session.close()
    await transport.close()
    await connection.close()
    throw error
  }
}

/** 独立 H5 页面使用的入口；Control API 会话通过 HttpOnly Cookie 提供。 */
export async function startDshH5BrowserBootstrap(options: DshH5BrowserBootstrapOptions): Promise<DshH5BrowserBootstrapResult> {
  const signal = options.signal
  options.onStatus?.('ticket')
  const devices = await options.controlApi.listDevices(signal)
  const device = chooseDshDevice(devices, options.dshDeviceId)
  const ticket = await options.controlApi.createClientTicket(device.dshDeviceId, signal)
  options.onStatus?.('webrtc')
  const connection = await connectWebRtcClient({
    signalingTicket: ticket as unknown as RelaySignalingTicketResponse,
    signalingSocketFactory: (url) => new WebSocket(url) as unknown as SignalingSocketLike,
    peerConnectionFactory: ({ iceServers, iceTransportPolicy }) => createPeerConnection({ iceServers, iceTransportPolicy }),
  })
  const generation = options.generation ?? 1
  const hostScope = resolveDshHostScope(ticket)
  const session = new DshSession({ carrier: connection.carrier, role: 'client', generation: String(generation), hostScope })
  const transport = new DshCodingNsTransport({
    carrier: connection.carrier,
    generation: { id: generation, host: { home: '/' } },
    hostScope,
    session,
    requireSessionReady: true,
  })
  let webContext: RemoteDshWebContext | undefined
  try {
    session.start()
    await waitForSessionReady(session, signal, 15_000)
    options.onStatus?.('session-ready')
    if (options.webContext) {
      webContext = new RemoteDshWebContext({ ...options.webContext, transport })
      options.onStatus?.('remote-web')
      await withTimeout(webContext.open(signal), signal, 30_000, '读取远程 DSH Web 超时')
    }
    return {
      dshDeviceId: device.dshDeviceId,
      transport,
      session,
      ...(webContext ? { webContext } : {}),
      dispose: async () => {
        await webContext?.dispose()
        session.close()
        await transport.close()
        await connection.close()
      },
    }
  } catch (error) {
    await webContext?.dispose()
    session.close()
    await transport.close()
    await connection.close()
    throw error
  }
}

async function waitForSessionReady(session: DshSession, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  await withTimeout(session.waitReady(signal), signal, timeoutMs, '等待 DSH session.ready 超时')
}

async function withTimeout<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, message: string): Promise<T> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('请求已取消')
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        if (signal) {
          const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('请求已取消'))
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbort = () => signal.removeEventListener('abort', onAbort)
        }
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbort?.()
  }
}

/** 使用同源或跨域 HttpOnly Cookie 调用控制站，不读取 Cookie 内容。 */
export function createHttpDshH5ControlApi(baseUrl = ''): DshH5BrowserControlApi {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '')
  return {
    async listDevices(signal) {
      return requestJson<DshDeviceListResponse>(`${normalizedBaseUrl}/api/v1/dsh/devices`, signal === undefined ? {} : { signal })
    },
    async createClientTicket(dshDeviceId, signal) {
      return requestJson<DshRelaySignalingTicket>(`${normalizedBaseUrl}/api/v1/dsh/relay/ticket`, {
        method: 'POST',
        ...(signal === undefined ? {} : { signal }),
        body: { dshDeviceId, role: 'client' },
      })
    },
  }
}

export function chooseDshDevice(response: DshDeviceListResponse, requested?: string) {
  const device = requested === undefined
    ? response.devices.find((item) => item.online && item.status === 'active')
    : response.devices.find((item) => item.dshDeviceId === requested && item.online && item.status === 'active')
  if (!device) throw new Error(requested ? `DSH 设备不可用: ${requested}` : '没有可用的 DSH Host')
  return device
}

/**
 * HostScope 是线上 Tunnel 的共享身份，不是两端各自的视角。
 * Host Runtime 当前以 local 作为 canonical kind；旧 Control API 未下发
 * hostScope 时也必须回退到同一值，否则首个 session.hello 会被 Host 拒绝。
 */
export function resolveDshHostScope(ticket: DshRelaySignalingTicket): DshHostScope {
  const scope = ticket.hostScope
  if (scope !== undefined) {
    if (scope.hostId !== ticket.dshDeviceId) throw new Error('DSH Ticket HostScope 与设备不一致')
    return scope
  }
  return { hostId: ticket.dshDeviceId, kind: 'local' }
}

function createPeerConnection(options: { iceServers: readonly { urls: string | string[]; username?: string; credential?: string }[]; iceTransportPolicy: 'all' | 'relay' }): PeerConnectionLike {
  const Constructor = globalThis.RTCPeerConnection
  if (!Constructor) throw new Error('当前浏览器不支持 RTCPeerConnection')
  return new Constructor({ iceServers: [...options.iceServers], iceTransportPolicy: options.iceTransportPolicy }) as unknown as PeerConnectionLike
}

async function callRpc<T>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  let result = await rpc.call('/codingns', endpoint, payload, signal)
  // 旧 Host 在 auth 命名空间下暂时暴露 DSH 动作；迁移期间只允许此兼容回退，
  // 数据和身份仍然使用 DSH 独立 DTO，不会回退到 CodingNS binding。
  if (!result.ok && (result.error.code === 'CODINGNS_RPC_NOT_FOUND' || /未知 CodingNS RPC/u.test(result.error.message))) {
    result = await rpc.call('/codingns', `auth/${endpoint}`, payload, signal)
  }
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

async function requestJson<T>(url: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    credentials: 'include',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    headers: { accept: 'application/json', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const data = await response.json().catch(() => ({})) as { detail?: string; errorCode?: string }
  if (!response.ok) throw new Error(data.detail ?? data.errorCode ?? `Control API 请求失败 (${response.status})`)
  return data as T
}
