import type { DshDeviceListResponse, DshRelaySignalingTicket } from '../shared/contracts/dsh-device.js'
import type { RelaySignalingTicketResponse } from '../shared/contracts/signaling.js'
import { assertSupportedDshVersion } from '../shared/index.js'
import { installDshTransport } from '../bootstrap/dsh-connection-adapter.js'
import { DshSession } from '../transport/dsh-session.js'
import type { DshHostScope } from '../transport/dsh-envelope.js'
import { DshCodingNsTransport } from '../transport/dsh-transport.js'
import { connectWebRtcClient, type PeerConnectionLike, type SignalingSocketLike } from '../transport/webrtc-client.js'
import type { CodingNsRpcClient } from './features/types.js'
import { RemoteDshWebContext, type RemoteDshWebContextOptions } from './remote-web-context.js'
import { createDshTransportDebugLogger } from '../transport/debug.js'
import { assertInjectedDshVersion } from './dsh-runtime-version.js'

/** H5 启动器需要的最小参数；不依赖 Node 或 Cordis 私有实现。 */
export interface DshH5BootstrapOptions {
  readonly rpc: CodingNsRpcClient
  readonly dshDeviceId?: string
  /** 登录保护开启中继范围时使用的短期 Host 签名票据。 */
  readonly loginProtectionToken?: string
  /** 重连时动态读取最新登录保护票据，避免使用已续签前的旧值。 */
  readonly getLoginProtectionToken?: () => string | undefined
  readonly signal?: AbortSignal
  readonly boot?: () => void | Promise<void>
}

export interface DshH5BootstrapResult {
  readonly dshDeviceId: string
  /** 当前 WebRTC ICE 策略，all 表示允许直连，relay 表示强制中转。 */
  readonly relayMode: 'direct' | 'relay'
  readonly registration: ReturnType<typeof installDshTransport>
  readonly dispose: () => Promise<void>
}

export interface DshH5BrowserControlApi {
  listDevices(signal?: AbortSignal): Promise<DshDeviceListResponse>
  /** 可复用 sessionId，刷新页面时让 Relay 顶掉旧的同会话连接。 */
  createClientTicket(dshDeviceId: string, signal?: AbortSignal, sessionId?: string): Promise<DshRelaySignalingTicket>
}

export interface DshH5BrowserBootstrapOptions {
  readonly controlApi: DshH5BrowserControlApi
  readonly dshDeviceId?: string
  readonly signal?: AbortSignal
  readonly webContext?: Omit<RemoteDshWebContextOptions, 'transport'>
  readonly generation?: number
  /** 浏览器侧稳定的 Relay Client 会话标识；不携带账号凭据。 */
  readonly clientSessionId?: string
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
  const dshVersion = assertInjectedDshVersion()
  assertSupportedDshVersion(dshVersion)
  const signal = options.signal
  const debug = createDshTransportDebugLogger({ side: 'h5', component: 'h5-bootstrap' })
  const devices = await callRpc<DshDeviceListResponse>(options.rpc, 'auth/dsh/device/list', {}, signal)
  const device = chooseDshDevice(devices, options.dshDeviceId)
  const loginProtectionToken = (): string | undefined => options.getLoginProtectionToken?.() ?? options.loginProtectionToken
  const firstLoginProtectionToken = loginProtectionToken()
  const firstTicket = await callRpc<DshRelaySignalingTicket>(options.rpc, 'auth/dsh/relayTicket', {
    dshDeviceId: device.dshDeviceId,
    ...(firstLoginProtectionToken === undefined ? {} : { loginProtectionToken: firstLoginProtectionToken }),
  }, signal)
  let generation = 1
  let connection = await connectWebRtcClient(createWebRtcClientOptions(firstTicket, debug))
  let session = new DshSession({ carrier: connection.carrier, role: 'client', generation: String(generation), hostScope: resolveDshHostScope(firstTicket), dshVersion, debug })
  let reconnecting = false
  let stopped = false
  let reconnectRef: ((reconnectSignal?: AbortSignal) => Promise<void>) | undefined
  let unsubscribeConnectionClosed: (() => void) | undefined
  const transport = new DshCodingNsTransport({
    carrier: connection.carrier,
    generation: { id: generation, host: { home: '/' } },
    hostScope: resolveDshHostScope(firstTicket),
    session,
    requireSessionReady: true,
    reconnect: (reconnectSignal) => reconnectRef?.(reconnectSignal) ?? Promise.reject(new Error('DSH 重连尚未就绪')),
    debug,
  })
  const reconnect = async (reconnectSignal?: AbortSignal): Promise<void> => {
    if (stopped || reconnecting) return
    reconnecting = true
    transport.invalidateConnection(new Error('WebRTC connection closed'))
    session.close('旧 WebRTC generation 已失效')
    try {
      for (let attempt = 0; !stopped; attempt += 1) {
        let nextConnection: Awaited<ReturnType<typeof connectWebRtcClient>> | undefined
        let nextSession: DshSession | undefined
        try {
          const waitMs = Math.min(10_000, 500 * (attempt + 1))
          if (attempt > 0) await delay(waitMs, reconnectSignal ?? signal)
          const currentLoginProtectionToken = loginProtectionToken()
          const ticket = await callRpc<DshRelaySignalingTicket>(options.rpc, 'auth/dsh/relayTicket', {
            dshDeviceId: device.dshDeviceId,
            ...(currentLoginProtectionToken === undefined ? {} : { loginProtectionToken: currentLoginProtectionToken }),
          }, reconnectSignal ?? signal)
          nextConnection = await connectWebRtcClient(createWebRtcClientOptions(ticket, debug))
          nextSession = new DshSession({ carrier: nextConnection.carrier, role: 'client', generation: String(generation + 1), hostScope: resolveDshHostScope(ticket), dshVersion, debug })
          nextSession.start()
          await waitForSessionReady(nextSession, reconnectSignal ?? signal, 15_000)
          const previous = connection
          connection = nextConnection
          session = nextSession
          generation += 1
          attachConnectionClose(nextConnection)
          transport.replaceConnection(nextConnection.carrier, nextSession, { id: generation, host: { home: '/' } })
          await previous.close()
          nextConnection = undefined
          nextSession = undefined
          return
        } catch (error) {
          await nextSession?.close()
          await nextConnection?.close()
          debug.log('bootstrap.reconnect.error', { generation, error: error instanceof Error ? error.message : String(error) })
          if (stopped || signal?.aborted || reconnectSignal?.aborted) throw error
        }
      }
    } finally {
      reconnecting = false
    }
  }
  reconnectRef = reconnect
  const attachConnectionClose = (current: Awaited<ReturnType<typeof connectWebRtcClient>>): void => {
    unsubscribeConnectionClosed?.()
    unsubscribeConnectionClosed = current.onClosed((error) => {
      if (stopped || current !== connection) return
      const reason = error ?? new Error('WebRTC connection closed')
      transport.invalidateConnection(reason)
      session.close(reason.message)
    })
  }
  attachConnectionClose(connection)
  let registration: ReturnType<typeof installDshTransport> | undefined
  try {
    session.start()
    await session.waitReady(signal)
    registration = installDshTransport({ dshVersion, transport })
    if (options.boot) await options.boot()
    const dispose = async (): Promise<void> => {
      stopped = true
      unsubscribeConnectionClosed?.()
      unsubscribeConnectionClosed = undefined
      registration?.dispose()
      session.close()
      await transport.close()
      await connection.close()
    }
    return { dshDeviceId: device.dshDeviceId, relayMode: firstTicket.iceTransportPolicy === 'relay' ? 'relay' : 'direct', registration, dispose }
  } catch (error) {
    stopped = true
    unsubscribeConnectionClosed?.()
    unsubscribeConnectionClosed = undefined
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
  const debug = createDshTransportDebugLogger({ side: 'h5', component: 'h5-bootstrap' })
  options.onStatus?.('ticket')
  const devices = await options.controlApi.listDevices(signal)
  const device = chooseDshDevice(devices, options.dshDeviceId)
  let generation = options.generation ?? 1
  let connection: Awaited<ReturnType<typeof connectWebRtcClient>> | undefined
  let session: DshSession | undefined
  let reconnecting = false
  let stopped = false
  let reconnectScheduled = false
  let reconnectRef: ((signal?: AbortSignal) => Promise<void>) | undefined
  const clientSessionId = options.clientSessionId?.trim() || undefined
  const firstTicket = await options.controlApi.createClientTicket(device.dshDeviceId, signal, clientSessionId)
  options.onStatus?.('webrtc')
  connection = await connectWebRtcClient(createWebRtcClientOptions(firstTicket, debug))
  const hostScope = resolveDshHostScope(firstTicket)
  session = new DshSession({ carrier: connection.carrier, role: 'client', generation: String(generation), hostScope, debug })
  const transport = new DshCodingNsTransport({
    carrier: connection.carrier,
    generation: { id: generation, host: { home: '/' } },
    hostScope,
    session,
    requireSessionReady: true,
    reconnect: (reconnectSignal) => reconnectRef?.(reconnectSignal) ?? Promise.reject(new Error('H5 重连尚未就绪')),
    debug,
  })
  const reconnect = async (): Promise<void> => {
    if (stopped || reconnecting) return
    reconnecting = true
    debug.log('bootstrap.reconnect.start', { generation })
    transport.invalidateConnection(new Error('WebRTC connection closed'))
    session?.close('旧 WebRTC generation 已失效')
    try {
      for (let attempt = 0; !stopped; attempt += 1) {
        try {
          // 首次尝试立即重连（移动端切回前台时 Host 通常还在，秒连体感最好）；
          // 后续退避 300ms 起指数增长、上限 3s，避免原来最长 10s 的等待。
          const waitMs = Math.min(3_000, 300 * 2 ** (attempt - 1))
          if (attempt > 0) await delay(waitMs, signal)
          options.onStatus?.('ticket')
          const ticket = await options.controlApi.createClientTicket(device.dshDeviceId, signal, clientSessionId)
          debug.log('bootstrap.reconnect.ticket', { generation: generation + 1 })
          options.onStatus?.('webrtc')
          const nextConnection = await connectWebRtcClient(createWebRtcClientOptions(ticket, debug))
          const nextSession = new DshSession({ carrier: nextConnection.carrier, role: 'client', generation: String(generation + 1), hostScope: resolveDshHostScope(ticket), debug })
          nextSession.start()
          await waitForSessionReady(nextSession, signal, 15_000)
          const previous = connection
          connection = nextConnection
          session = nextSession
          generation += 1
          transport.replaceConnection(nextConnection.carrier, nextSession, { id: generation, host: { home: '/' } })
          attachConnectionClose(nextConnection)
          await previous?.close()
          debug.log('bootstrap.reconnect.ready', { generation })
          options.onStatus?.('remote-web')
          return
        } catch (error) {
          debug.log('bootstrap.reconnect.error', { generation, error: error instanceof Error ? error.message : String(error) })
          if (stopped || signal?.aborted) throw error
        }
      }
    } finally {
      reconnecting = false
    }
  }
  const attachConnectionClose = (current: Awaited<ReturnType<typeof connectWebRtcClient>>): void => {
    current.onClosed((error) => {
      if (stopped || current !== connection) return
      const reason = error ?? new Error('WebRTC connection closed')
      debug.log('bootstrap.connection.closed', { generation, error: reason.message })
      // 物理线路断开必须立刻让在途请求失败，而不是等重连流程再收尾：
      // 中继页面上的原生设置 describe 只会一直停在 loading，表现成「模型」页
      // 空白且没有任何报错，会话列表却因为重连成功而看起来正常。
      transport.invalidateConnection(reason)
      session?.close(reason.message)
      // 移动端切后台会频繁断连，重连延迟直接体现为「卡住不动」的体感。
      // 原来这里等 50ms 只是为了不在 close 回调栈里重入，用 microtask 就能达到
      // 同样效果且不引入额外延迟；reconnecting 与 current !== connection 双重
      // 守卫保证不会并发重连或对已替换的连接重复触发。
      if (!reconnectScheduled) {
        reconnectScheduled = true
        queueMicrotask(() => { reconnectScheduled = false; void reconnect() })
      }
    })
  }
  reconnectRef = reconnect
  attachConnectionClose(connection)
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
      get session() { return session as DshSession },
      ...(webContext ? { webContext } : {}),
      dispose: async () => {
        stopped = true
        await webContext?.dispose()
        session?.close()
        await transport.close()
        await connection?.close()
      },
    }
  } catch (error) {
    await webContext?.dispose()
    stopped = true
    session?.close()
    await transport.close()
    await connection?.close()
    throw error
  }
}

function createWebRtcClientOptions(ticket: DshRelaySignalingTicket, debug: ReturnType<typeof createDshTransportDebugLogger>) {
  return {
    signalingTicket: ticket as unknown as RelaySignalingTicketResponse,
    signalingSocketFactory: (url: string) => new WebSocket(url) as unknown as SignalingSocketLike,
    peerConnectionFactory: ({ iceServers, iceTransportPolicy }: { iceServers: readonly { urls: string | string[]; username?: string; credential?: string }[]; iceTransportPolicy: 'all' | 'relay' }) => createPeerConnection({ iceServers, iceTransportPolicy }),
    debug,
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('请求已取消')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason instanceof Error ? signal.reason : new Error('请求已取消')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
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
    async createClientTicket(dshDeviceId, signal, sessionId) {
      return requestJson<DshRelaySignalingTicket>(`${normalizedBaseUrl}/api/v1/dsh/relay/ticket`, {
        method: 'POST',
        ...(signal === undefined ? {} : { signal }),
        body: { dshDeviceId, role: 'client', ...(sessionId?.trim() ? { sessionId: sessionId.trim() } : {}) },
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
  // 数据和身份仍然使用 DSH 独立 DTO，不会回退到 Codingns4DSH binding。
  if (!result.ok && (result.error.code === 'CODINGNS_RPC_NOT_FOUND' || /未知 Codingns4DSH RPC/u.test(result.error.message))) {
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
