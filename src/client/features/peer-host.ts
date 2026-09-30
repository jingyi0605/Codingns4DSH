import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientFeatureModule, FeaturePanelProps } from './types.js'
import { startPeerHostManagementPanel } from '../peer-host-management-panel.js'
import { createPeerHostManagementApi } from '../peer-host-management-api.js'
import { DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL, readDshPeerHostPrebootShimMode, readDshPeerHostPrebootShimState } from '../../bootstrap/dsh-peer-host-preboot-shim.js'
import type { CodingNsTransportHooks } from '../../shared/contracts/transport.js'
import { dshSettingsNoteStyle, dshThemeColor } from '../theme.js'
import type { AggregateHostResult, HostScope } from '../../shared/contracts/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../../shared/index.js'
import { isDshNativeRemoteMethod } from '../../host/modules/peer-host/peer-host-native-protocol.js'
import { createPeerHostNativeProjection, type PeerHostNativeProjection } from '../peer-host-native-projection.js'
import { installPeerHostNativeStoreProjection, refreshPeerHostNativeSessions } from '../peer-host-native-store-projection.js'
import { registerPeerHostAggregateRefresh } from '../peer-host-aggregate-refresh.js'

/** 聚合刷新周期；远端资源只影响自身节点，刷新失败不改变本机界面。 */
const PEER_HOST_AGGREGATE_REFRESH_MS = 30_000

/** PeerHost Client 模块的边界声明；远端凭据和目标连接始终由 Host 侧持有。 */
export const peerHostFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'peerHost',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    requires: [
      // 页面 Transport 不可包装（shim 未注入或形状未知）时只停用 PeerHost，
      // 不再提示"请刷新"——这属于结构不支持，刷新不会改变结果。
      { capability: 'peer-host.client-preboot-transport', required: false, fallback: 'disable' },
      { capability: 'peer-host.native-navigation', required: false, fallback: 'degrade' },
      { capability: 'peer-host.remote-web-context-fallback', required: false, fallback: 'degrade' },
    ],
    ui: {
      label: '管理其他 DSH Host',
      description: '聚合多个 Host 的工作区与会话；原生 Transport shim 随插件安装。',
      order: 50,
      defaultOpen: false,
    },
  },
  start: async (context) => {
    const shim = (globalThis as typeof globalThis & { [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: { activate: (transport?: CodingNsTransportHooks) => string; deactivate: () => string; getMode?: () => string } })[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    const projection = createPeerHostNativeProjection()
    const transport = shim === undefined ? undefined : createPeerHostPageTransport(projection)
    if (shim !== undefined) {
      shim.activate(transport!.hooks)
      context.resources.add(() => { shim.deactivate() })
      // 原生侧栏在插件 apply 时按引用捕获 `workspaces.list`，只能就地投影这个对象；
      // 没有 shim 就没有原生 Remote 路由，此时不注入，避免出现点不开的远端条目。
      context.resources.add(installPeerHostNativeStoreProjection({ uiContext: context.services.uiContext, projection }))
      // Desktop 的 Transport 只有 `{ ownsHost, streamBaseUrl }`，shim 不提供 `rpc`，
      // 因此 DSH 用原生 `createWebConnectionRpc` 建立了 Connection。这里在 Connection
      // 就绪后就地补聚合分流：`rpc.call` 上放行聚合请求，本机流在 Remote 服务的
      // `openRemoteStream` 处原样落回 DSH 自己的实现（含 uplink 与原生 mux）。
      if (shim.getMode?.() === 'desktop') {
        const route = installPeerHostConnectionRouting({
          ...(context.services.uiContext === undefined ? {} : { uiContext: context.services.uiContext }),
          ...(context.services.remote === undefined ? {} : { remote: context.services.remote }),
          hooks: transport!.hooks,
          matchesScope: transport!.matchesScope,
          decorateLocalResult: (method, result) => method === 'session/list' ? mergeSessionListResult(result, projection) : result,
        })
        if (route !== undefined) context.resources.add(route)
      }
    }
    const panel = startPeerHostManagementPanel({ rpc: context.services.rpc })
    context.resources.add(() => panel.dispose())
    const management = createPeerHostManagementApi(context.services.rpc)
    // 虚拟会话必须进入原生 SessionManager 目录（否则 sessions.retain 解析失败），
    // 因此聚合变化后触发一次原生列表刷新，由页面 Transport 在 session/list 响应里补齐。
    const refresh = async (): Promise<void> => {
      try {
        if (transport?.setAggregate(await management.aggregate()) === true) {
          await refreshPeerHostNativeSessions(context.services.uiContext)
        }
      } catch {
        // 单个 Host 的摘要失败由聚合层降级，不阻断本机原生工作区与会话。
      }
    }
    // 归档入口等原生操作完成后可以立刻请求刷新，而不必等待下一个周期。
    context.resources.add(registerPeerHostAggregateRefresh(refresh))
    await refresh()
    const timer = setInterval(() => { void refresh() }, PEER_HOST_AGGREGATE_REFRESH_MS)
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void refresh()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange)
    context.resources.add(() => {
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange)
    })
  },
  settingsPanel: PeerHostPanel,
}

/** 将 DSH preboot shim 绑定到当前页面的 Host RPC；不调用 Connection.rpc，避免递归。 */
export function createPeerHostPageTransport(
  projection: PeerHostNativeProjection = createPeerHostNativeProjection(),
): {
  readonly hooks: CodingNsTransportHooks
  readonly matchesScope: (value: unknown) => boolean
  readonly setAggregate: (aggregate: readonly AggregateHostResult[]) => boolean
} {
  const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
  const scopes = new Map<string, HostScope>()
  const request = async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (fetchImpl === undefined) throw new Error('当前页面没有 fetch')
    const body = JSON.stringify({ type: 'client-request', rpcId: createRequestId(), method: endpoint, payload })
    const paths = [`${channel.replace(/\/$/u, '')}/${endpoint.replace(/^\//u, '')}`, `/api${channel.replace(/\/$/u, '')}/${endpoint.replace(/^\//u, '')}`]
    let response: Response | undefined
    for (const path of paths) {
      response = await fetchImpl(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...(signal === undefined ? {} : { signal }) })
      if (response.status !== 404 && response.status !== 405) break
    }
    if (response === undefined || !response.ok) throw new Error(`transport failure: HTTP ${response?.status ?? 500}`)
    const envelope = await response.json() as { result?: unknown }
    return envelope.result
  }
  const codingNsCall = async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    const result = asRecord(await request('/codingns', endpoint, payload, signal))
    if (result?.ok === true) return result.value
    const error = asRecord(result?.error)
    const failure = new Error(typeof error?.message === 'string' ? error.message : `CodingNS RPC 失败: ${endpoint}`)
    // 保留稳定错误码，让 DSH 的 Remote 失败装上原始 code 而不是退化成 carrierFailure。
    if (typeof error?.code === 'string') (failure as Error & { code?: string }).code = error.code
    throw failure
  }
  const findScope = (value: unknown): HostScope | undefined => {
    if (typeof value === 'string') {
      const session = scopes.get(value)
      if (session !== undefined) return session
      const workspace = scopes.get(value)
      if (workspace !== undefined) return workspace
      return undefined
    }
    if (Array.isArray(value)) {
      for (const item of value) { const found = findScope(item); if (found !== undefined) return found }
      return undefined
    }
    const object = asRecord(value)
    if (object === null) return undefined
    for (const item of Object.values(object)) { const found = findScope(item); if (found !== undefined) return found }
    return undefined
  }
  const openRemoteStream = (method: string, payload: unknown, scope: HostScope, signal?: AbortSignal): AsyncIterable<unknown> => (async function* () {
    const opened = asRecord(await codingNsCall('peerHost/nativeStream', { method, payload, scope }, signal))
    const streamId = typeof opened?.streamId === 'string' ? opened.streamId : ''
    if (streamId === '') throw new Error('PeerHost 原生 Remote 未返回 streamId')
    try {
      while (!(signal?.aborted ?? false)) {
        const next = asRecord(await codingNsCall('peerHost/nativeStreamNext', { streamId, scope }, signal))
        if (next?.done === true) return
        yield next?.value
      }
      signal?.throwIfAborted()
    } finally {
      await codingNsCall('peerHost/nativeStreamClose', { streamId, scope }).catch(() => undefined)
    }
  })()
  const hooks: CodingNsTransportHooks = {
    rpc: async <TResponse = unknown>({ method, payload, signal }: { method: string; payload: unknown; signal?: AbortSignal }): Promise<TResponse> => {
      const value = asRecord(payload)
      const channel = typeof value?.channel === 'string' ? value.channel : '/codingns'
      const body = value?.payload
      if (channel === '/api' && isDshNativeRemoteMethod(method)) {
        const scope = findScope(body)
        if (scope !== undefined && scope.targetHostId !== null) {
          // DSH 的 client 契约要求 unary 结果是 `{ok, value}` / `{ok:false, error}` 信封：
          // 返回裸值会让网关在 `rebuiltFailure(result.error)` 读 undefined.code 而崩成 carrierFailure。
          try {
            return { ok: true, value: await codingNsCall('peerHost/native', { method, payload: body, scope }, signal) } as TResponse
          } catch (error) {
            const code = (error as { code?: unknown }).code
            return {
              ok: false,
              error: { code: typeof code === 'string' ? code : 'gateway/internal', message: error instanceof Error ? error.message : String(error) },
            } as TResponse
          }
        }
      }
      const result = await request(channel, method, body, signal)
      // 原生会话目录必须认识远端会话，否则点击时会因 sessions.retain 解析失败而打不开。
      if (channel === '/api' && method === 'session/list') return mergeSessionListResult(result, projection) as TResponse
      return result as TResponse
    },
    openStream: <TChunk = unknown>({ method, payload, signal }: { method: string; payload: unknown; signal?: AbortSignal; uplink?: AsyncIterable<unknown> }): AsyncIterable<TChunk> => {
      const value = asRecord(payload)
      const channel = typeof value?.channel === 'string' ? value.channel : '/api'
      const body = value?.payload
      if (channel === '/api' && isDshNativeRemoteMethod(method)) {
        const scope = findScope(body)
        if (scope !== undefined && scope.targetHostId !== null) {
          return openRemoteStream(method, body, scope, signal) as AsyncIterable<TChunk>
        }
      }
      // 本机流（含 $events 等非白名单流）必须回到 DSH Gateway：本地 baseline 不能
      // 走 PeerHost，否则原生 workspace/session Store 会整体停在 loading。
      if (channel !== '/api') throw new Error('CODINGNS_BASELINE_STREAM')
      return openDshGatewayStream<TChunk>(method, body, signal)
    },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchImpl === undefined) return Promise.reject(new Error('当前页面没有 fetch'))
      return fetchImpl(input, init)
    },
  }
  return {
    hooks,
    /** 该请求是否落在某个远端 Host 的作用域内；Desktop 连接路由用它决定是否分流。 */
    matchesScope(value: unknown): boolean {
      const scope = findScope(value)
      return scope !== undefined && scope.targetHostId !== null
    },
    setAggregate(aggregate) {
      scopes.clear()
      for (const host of aggregate) {
        for (const workspace of host.workspaces) {
          const virtualHostId = host.targetHostId ?? host.hostId
          const virtualWorkspaceId = createVirtualWorkspaceId(virtualHostId, workspace.workspaceId)
          const workspaceScope: HostScope = { hostId: host.hostId, targetHostId: host.targetHostId, workspaceId: workspace.workspaceId, sessionId: null, scopeGeneration: 0 }
          scopes.set(virtualWorkspaceId, workspaceScope)
          // 归档会话也要能解析作用域：取消归档请求按虚拟会话 ID 路由到目标 Host。
          for (const session of [...workspace.sessions, ...(workspace.archivedSessions ?? [])]) {
            if (session.scope.sessionId === null) continue
            scopes.set(createVirtualSessionId(virtualHostId, session.scope.sessionId), { ...workspaceScope, sessionId: session.scope.sessionId })
          }
        }
      }
      return projection.setAggregate(aggregate)
    },
  }
}

/** DSH Connection 的 rpc 句柄形状；只依赖内部契约，不引用 DSH 版本专属类型。 */
interface ConnectionRpcHandle {
  call?: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>
  [key: string]: unknown
}

/**
 * Desktop 拓扑下把 PeerHost 聚合路由挂到 DSH 原生 Connection 上。
 *
 * Desktop 的页面 Transport 只有 `{ ownsHost, streamBaseUrl }`，DSH 因此用原生
 * `createWebConnectionRpc(transport.fetch)` 建立 `connection.rpc`。shim 不接管这个
 * `rpc`，所以聚合分流必须在这里就地补齐：
 *
 * - `rpc.call`：聚合范围内的请求交给页面 Transport；其余原样委派原生 `call`，
 *   因此 multipart 附件解析、rpcId 校验等原生语义完全保留。本机 `session/list`
 *   需要并入虚拟会话，否则远端会话进不了原生会话目录。
 * - `remote.openRemoteStream`：聚合流交给页面 Transport；本机流原样落回 DSH 自己的
 *   实现，`connection.rpc.open` 始终保持 undefined，网关的 mux 启动与重连判断
 *   因此完全没被改动。
 */
export function installPeerHostConnectionRouting(options: {
  readonly uiContext?: { get(name: string): unknown }
  /** DSH Client Remote 服务；它的 `openRemoteStream` 是所有本机流的唯一入口。 */
  readonly remote?: unknown
  readonly hooks: CodingNsTransportHooks
  /** 作用域判定；与页面 Transport 的 `matchesScope` 是同一个函数，避免白名单漂移。 */
  readonly matchesScope: (value: unknown) => boolean
  readonly decorateLocalResult?: (method: string, result: unknown) => unknown
}): (() => void) | undefined {
  const connection = readConnectionHandle(options.uiContext)
  const rpc = connection?.rpc
  const remote = readRemoteService(options.remote)
  if (rpc === undefined || remote === undefined) return undefined
  const originalCall = typeof rpc.call === 'function' ? rpc.call : undefined
  if (originalCall === undefined) return undefined
  const originalCallRemote = remote.openRemoteStream
  const isPeerScoped = (channel: string, endpoint: string, payload: unknown): boolean => channel === '/api'
    && isDshNativeRemoteMethod(endpoint)
    && options.matchesScope(payload)

  rpc.call = async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (isPeerScoped(channel, endpoint, payload)) {
      return await options.hooks.rpc!({ method: endpoint, payload: { channel, payload }, ...(signal === undefined ? {} : { signal }) })
    }
    const result = await originalCall.call(rpc, channel, endpoint, payload, signal)
    return options.decorateLocalResult === undefined ? result : options.decorateLocalResult(endpoint, result)
  }
  // 聚合流在 `openRemoteStream` 层拦截：本机流原样落回 DSH 自己的实现（原生
  // RemoteStreamMuxClient），因此 uplink 与重连行为都不受影响；也不要动
  // `connection.rpc.open`，否则网关会认为本页自带流通道而不再启动/重连 mux。
  const patchedOpenRemoteStream = (endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>, noConnection?: string): unknown => {
    if (typeof options.hooks.openStream === 'function' && isPeerScoped('/api', endpoint, payload)) {
      return options.hooks.openStream({ method: endpoint, payload: { channel: '/api', payload, uplink }, ...(signal === undefined ? {} : { signal }) })
    }
    return originalCallRemote.call(remote, endpoint, payload, signal, uplink, noConnection)
  }
  try {
    remote.openRemoteStream = patchedOpenRemoteStream
  } catch {
    // 服务对象被冻结时不要留下半接管状态：unary 分流同样回滚。
    rpc.call = originalCall
    return undefined
  }

  return () => {
    rpc.call = originalCall
    if (remote.openRemoteStream === patchedOpenRemoteStream) remote.openRemoteStream = originalCallRemote
  }
}

interface RemoteServiceHandle {
  openRemoteStream(endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>, noConnection?: string): unknown
  [key: string]: unknown
}

function readRemoteService(remote: unknown): RemoteServiceHandle | undefined {
  if (typeof remote !== 'object' || remote === null) return undefined
  const openRemoteStream = (remote as { openRemoteStream?: unknown }).openRemoteStream
  return typeof openRemoteStream === 'function' ? remote as RemoteServiceHandle : undefined
}

/** 聚合范围判定复用页面 Transport 的作用域解析，避免两处白名单漂移。 */
function readConnectionHandle(uiContext: { get(name: string): unknown } | undefined): { rpc?: ConnectionRpcHandle } | undefined {
  if (uiContext === undefined) return undefined
  try {
    const connection = uiContext.get('connection')
    return typeof connection === 'object' && connection !== null ? connection as { rpc?: ConnectionRpcHandle } : undefined
  } catch {
    return undefined
  }
}

/** 把虚拟会话摘要并入 session/list 结果；形状不符时保持本机结果不变。 */
function mergeSessionListResult(result: unknown, projection: PeerHostNativeProjection): unknown {
  const envelope = asRecord(result)
  if (envelope?.ok !== true) return result
  const value = asRecord(envelope.value)
  if (value === null || !Array.isArray(value.items)) return result
  const virtual = projection.sessions()
  if (virtual.length === 0) return result
  const known = new Set(value.items.flatMap((item) => {
    const id = asRecord(item)?.sessionId
    return typeof id === 'string' ? [id] : []
  }))
  const items = [...value.items, ...virtual.filter((session) => !known.has(session.sessionId))]
  return { ...envelope, value: { ...value, items } }
}

function createRequestId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 打开当前页面 DSH Gateway 的单个 Remote 流；协议与 dsh-api-gateway 保持一致。 */
function openDshGatewayStream<TChunk>(endpoint: string, payload: unknown, signal?: AbortSignal): AsyncIterable<TChunk> {
  const streamId = `codingns_${Date.now()}_${Math.random().toString(36).slice(2)}`
  return (async function* () {
    const WebSocketCtor = (globalThis as typeof globalThis & { WebSocket?: new (url: string) => WebSocket }).WebSocket
    if (typeof WebSocketCtor !== 'function') throw new Error('当前页面没有可用 WebSocket')
    const transport = (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__
    const base = transport?.streamBaseUrl ?? (typeof globalThis.location === 'object' ? globalThis.location.href : 'http://localhost/')
    const socketUrl = new URL('/api/remote.mux', base)
    if (socketUrl.protocol === 'http:') socketUrl.protocol = 'ws:'
    else if (socketUrl.protocol === 'https:') socketUrl.protocol = 'wss:'
    const socket = new WebSocketCtor(socketUrl.href)
    const frames: TChunk[] = []
    let wake: (() => void) | undefined
    let ended = false
    let failure: Error | undefined
    const notify = (): void => { const resolve = wake; wake = undefined; resolve?.() }
    const onMessage = (event: MessageEvent): void => {
      try {
        const frame = JSON.parse(String(event.data)) as { streamId?: unknown; type?: unknown; value?: unknown; error?: { message?: unknown } }
        if (frame.streamId !== streamId) return
        if (frame.type === 'end') ended = true
        else if (frame.type === 'error') failure = new Error(typeof frame.error?.message === 'string' ? frame.error.message : 'DSH Remote stream 失败')
        else if (frame.type === 'item') frames.push(frame.value as TChunk)
        notify()
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        notify()
      }
    }
    const onError = (): void => { failure = new Error('DSH Remote stream WebSocket 失败'); notify() }
    const onAbort = (): void => { failure = signal?.reason instanceof Error ? signal.reason : new Error('DSH Remote stream 已取消'); notify() }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await new Promise<void>((resolve, reject) => {
        const opened = (): void => resolve()
        const failed = (): void => reject(new Error('DSH Remote stream WebSocket 打开失败'))
        socket.addEventListener('open', opened, { once: true })
        socket.addEventListener('error', failed, { once: true })
      })
      signal?.throwIfAborted()
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
      while (!ended || frames.length > 0) {
        if (failure !== undefined) throw failure
        if (frames.length === 0) {
          if (ended) break
          await new Promise<void>((resolve) => { wake = resolve })
        }
        while (frames.length > 0) yield frames.shift() as TChunk
      }
      if (failure !== undefined) throw failure
    } finally {
      signal?.removeEventListener('abort', onAbort)
      socket.close(1000, 'stream closed')
    }
  })()
}

/** Desktop 壳的页面判据；与 shim 的拓扑识别保持同一组特征。 */
function isDesktopTopologyPage(): boolean {
  if ((globalThis as typeof globalThis & { dshDesktopBoot?: unknown }).dshDesktopBoot !== undefined) return true
  try {
    return globalThis.location?.protocol?.toLowerCase() === 'dsh-app:'
  } catch {
    return false
  }
}

/** PeerHost 启用状态说明；安装动作发生在启动页 preboot 阶段。 */
function PeerHostPanel({ enabled }: FeaturePanelProps): ReactElement {
  // shim 状态在启用变化后可能改变（刚激活为 active），每次渲染都重读全局。
  const state = readDshPeerHostPrebootShimState()
  const mode = readDshPeerHostPrebootShimMode()
  const desktop = mode === 'desktop' || isDesktopTopologyPage()
  const structural = state === 'external' || state === 'not-installed'
  const message = state === 'external'
    ? '当前页面的 Transport 结构不受支持，插件无法包装它，PeerHost 聚合已停用；刷新页面不会改变结果。'
    : state === 'not-installed'
      ? desktop
        ? '当前 Desktop 页面没有安装 preboot shim；请重启 DSH Desktop 后再打开页面。'
        : '当前页面未安装 preboot shim；请刷新 DSH Web 后再启用 PeerHost。'
      : state === 'requires-reload'
        ? 'preboot shim 已安装，但当前 Connection 尚未绑定聚合 Transport；请刷新 DSH Web 后再操作远端工作区。'
        : state === 'active'
          ? 'preboot shim 已接管页面 Transport；本次页面的原生 Connection 将继续复用同一实例。'
          : 'preboot shim 已随 CodingNS 安装；启用 PeerHost 后立即生效，原生工作区会直接读取聚合 Transport。'
  return createElement('div', {
    role: structural ? 'alert' : 'status',
    'aria-disabled': !enabled,
    style: { ...dshSettingsNoteStyle, color: structural ? dshThemeColor.error : dshThemeColor.labelSecondary, opacity: enabled ? 1 : 0.65 },
  }, message)
}
