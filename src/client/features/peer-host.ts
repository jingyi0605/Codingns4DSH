import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientFeatureModule, FeaturePanelProps } from './types.js'
import { startPeerHostManagementPanel } from '../peer-host-management-panel.js'
import { startPeerHostNativeNavigation, startPeerHostNativeSession } from '../peer-host-native-session-ui.js'
import { createPeerHostManagementApi } from '../peer-host-management-api.js'
import { createPeerHostWebSocketFactory } from '../peer-host-scoped-client.js'
import { DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL } from '../../bootstrap/dsh-peer-host-preboot-shim.js'
import type { CodingNsTransportHooks } from '../../shared/contracts/transport.js'
import { dshSettingsNoteStyle, dshThemeColor } from '../theme.js'
import { installPeerHostNativeStoreAdapter } from '../peer-host-native-store-adapter.js'
import type { AggregateHostResult, HostScope } from '../../shared/contracts/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../../shared/index.js'
import { isDshNativeRemoteMethod } from '../../host/modules/peer-host/peer-host-native-protocol.js'

/** PeerHost Client 模块的边界声明；远端凭据和目标连接始终由 Host 侧持有。 */
export const peerHostFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'peerHost',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    requires: [
      { capability: 'peer-host.client-preboot-transport', required: false, fallback: 'degrade' },
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
    const shim = (globalThis as typeof globalThis & { [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: { activate: (transport?: CodingNsTransportHooks) => string; deactivate: () => string } })[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    const transport = shim === undefined ? undefined : createPeerHostPageTransport()
    if (shim !== undefined) {
      shim.activate(transport!.hooks)
      context.resources.add(() => { shim.deactivate() })
    }
    const panel = startPeerHostManagementPanel({ rpc: context.services.rpc })
    context.resources.add(() => panel.dispose())
    const management = createPeerHostManagementApi(context.services.rpc)
    let endpoint = null as Awaited<ReturnType<typeof management.webSocketEndpoint>>
    let results: Awaited<ReturnType<typeof management.aggregate>> | null = null
    let workspaceOrder: readonly string[] = []
    let aggregateError: unknown
    try {
      ;[endpoint, results] = await Promise.all([management.webSocketEndpoint(), management.aggregate()])
      try { workspaceOrder = (await management.workspaceOrder()).orderedWorkspaceIds } catch { workspaceOrder = [] }
    } catch (error) {
      aggregateError = error
      try { endpoint = await management.webSocketEndpoint() } catch { endpoint = null }
    }
    let socketFactory: ReturnType<typeof createPeerHostWebSocketFactory> | undefined
    if (endpoint !== null) {
      try {
        socketFactory = createPeerHostWebSocketFactory(endpoint)
      } catch {
        endpoint = null
        aggregateError = new Error('PeerHost 实时通道端点不可用')
      }
    }
    if (results !== null) {
      transport?.setAggregate(results)
    }
    if (results !== null && context.services.uiContext !== undefined) {
      const nativeStore = installPeerHostNativeStoreAdapter({
        context: context.services.uiContext,
        aggregate: results,
        workspaceOrder,
        moveWorkspace: (workspaceId, beforeWorkspaceId) => management.moveWorkspace(workspaceId, beforeWorkspaceId),
      })
      context.resources.add(() => nativeStore.dispose())
      if (!nativeStore.supported) {
        console.warn(`codingns4dsh: 原生 Workspace/Session 列表未接入：${nativeStore.reason ?? '未知原因'}`)
      }
    }
    const session = startPeerHostNativeSession({
      controller: context.services.peerHostSession,
      client: context.services.peerHost,
      ...(socketFactory === undefined ? {} : { socketFactory }),
    })
    context.resources.add(() => session.close())
    const navigation = startPeerHostNativeNavigation({
      controller: context.services.peerHostSession,
      onSelect: async (scope) => {
        const selected = await context.services.peerHostSession.select({
          hostId: scope.hostId,
          targetHostId: scope.targetHostId,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
        })
        await session.open(selected)
      },
    })
    context.resources.add(() => navigation.dispose())
    if (results !== null) navigation.refresh(results)
    else navigation.setStatus({
      status: 'degraded',
      reason: aggregateError instanceof Error && aggregateError.message === 'PeerHost 实时通道端点不可用'
        ? aggregateError.message
        : 'PeerHost 聚合摘要暂不可用',
    })
  },
  settingsPanel: PeerHostPanel,
}

/** 将 DSH preboot shim 绑定到当前页面的 Host RPC；不调用 Connection.rpc，避免递归。 */
export function createPeerHostPageTransport(): {
  readonly hooks: CodingNsTransportHooks
  readonly setAggregate: (aggregate: readonly AggregateHostResult[]) => void
} {
  const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
  const scopes = new Map<string, HostScope>()
  let lastRemoteScope: HostScope | undefined
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
    throw new Error(typeof error?.message === 'string' ? error.message : `CodingNS RPC 失败: ${endpoint}`)
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
        const scope = findScope(body) ?? (method === 'session/control' || method === 'workspace/follow' ? lastRemoteScope : undefined)
        if (scope !== undefined && scope.targetHostId !== null) {
          lastRemoteScope = scope
          return await codingNsCall('peerHost/native', { method, payload: body, scope }, signal) as TResponse
        }
      }
      return await request(channel, method, body, signal) as TResponse
    },
    openStream: <TChunk = unknown>({ method, payload, signal }: { method: string; payload: unknown; signal?: AbortSignal; uplink?: AsyncIterable<unknown> }): AsyncIterable<TChunk> => {
      const value = asRecord(payload)
      const channel = typeof value?.channel === 'string' ? value.channel : '/api'
      const body = value?.payload
      if (channel === '/api' && isDshNativeRemoteMethod(method)) {
        const scope = findScope(body) ?? (method === 'session/control' || method === 'workspace/follow' ? lastRemoteScope : undefined)
        if (scope !== undefined && scope.targetHostId !== null) {
          lastRemoteScope = scope
          return openRemoteStream(method, body, scope, signal) as AsyncIterable<TChunk>
        }
        // 本地资源仍需使用 DSH Gateway 的标准 Remote stream；不能把它
        // 当作 PeerHost baseline，否则原生 workspace/session Store 会整体停在 loading。
        return openDshGatewayStream<TChunk>(method, body, signal)
      }
      throw new Error('CODINGNS_BASELINE_STREAM')
    },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchImpl === undefined) return Promise.reject(new Error('当前页面没有 fetch'))
      return fetchImpl(input, init)
    },
  }
  return {
    hooks,
    setAggregate(aggregate) {
      scopes.clear()
      for (const host of aggregate) {
        for (const workspace of host.workspaces) {
          const virtualHostId = host.targetHostId ?? host.hostId
          const virtualWorkspaceId = createVirtualWorkspaceId(virtualHostId, workspace.workspaceId)
          const workspaceScope: HostScope = { hostId: host.hostId, targetHostId: host.targetHostId, workspaceId: workspace.workspaceId, sessionId: null, scopeGeneration: 0 }
          scopes.set(virtualWorkspaceId, workspaceScope)
          for (const session of workspace.sessions) {
            if (session.scope.sessionId === null) continue
            scopes.set(createVirtualSessionId(virtualHostId, session.scope.sessionId), { ...workspaceScope, sessionId: session.scope.sessionId })
          }
        }
      }
    },
  }
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

/** PeerHost 启用状态说明；安装动作发生在启动页 preboot 阶段。 */
function PeerHostPanel({ enabled }: FeaturePanelProps): ReactElement {
  const [state, setState] = useState<string>('not-installed')
  useEffect(() => {
    const shim = (globalThis as typeof globalThis & { [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: { getState: () => string } })[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    setState(shim?.getState() ?? 'not-installed')
  }, [enabled])
  const message = state === 'external'
    ? '检测到 Desktop 外部 Transport，插件不会覆盖它；PeerHost 原生聚合需要重新加载页面。'
    : state === 'not-installed'
      ? '当前页面未安装 preboot shim，请刷新 DSH Web 后再启用 PeerHost。'
      : state === 'requires-reload'
        ? 'preboot shim 已安装，但当前 Connection 尚未绑定聚合 Transport；请刷新 DSH Web 后再操作远端工作区。'
      : state === 'active'
        ? 'preboot shim 已接管页面 Transport；本次页面的原生 Connection 将继续复用同一实例。'
        : 'preboot shim 已随 CodingNS 安装；首次启用 PeerHost 后请刷新 DSH Web，使原生工作区读取聚合 Transport。'
  return createElement('div', {
    role: state === 'external' || state === 'not-installed' ? 'alert' : 'status',
    'aria-disabled': !enabled,
    style: { ...dshSettingsNoteStyle, color: state === 'external' || state === 'not-installed' ? dshThemeColor.error : dshThemeColor.labelSecondary, opacity: enabled ? 1 : 0.65 },
  }, message)
}
