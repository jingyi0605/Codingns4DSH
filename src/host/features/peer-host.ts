import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsHostServices } from './types.js'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { CODINGNS_VERSION, DSH_VERSION, isDshVersionCompatible } from '../../shared/contracts/version.js'
import { PeerHostHandshakeService } from '../modules/peer-host/peer-host-handshake.js'
import { PeerHostSessionService } from '../modules/peer-host/peer-host-session.js'
import { PeerHostHttpProxyService } from '../modules/peer-host/host-api-proxy-service.js'
import {
  EncryptedFilePeerHostCredentialStore,
  FilePeerHostRecordStore,
  PeerHostStore,
} from '../modules/peer-host/peer-host-store.js'
import type { PeerHostRoute } from '../../shared/contracts/peer-host.js'
import type { PeerHostRecord, PeerHostClientRecord } from '../../shared/contracts/peer-host.js'
import type { DshHostStatus } from '../../shared/contracts/host-status.js'
import { createVirtualSessionId, createVirtualWorkspaceId, type HostScope } from '../../shared/contracts/peer-host.js'
import type { AggregateHostSource } from '../modules/peer-host/peer-host-aggregate-service.js'
import { PeerHostAggregateService } from '../modules/peer-host/peer-host-aggregate-service.js'
import { resolveDshNativeDispatch } from '../modules/peer-host/peer-host-native-dispatch.js'
import { FileAggregateWorkspaceOrderStore, VirtualWorkspaceRegistry } from '../modules/peer-host/peer-host-virtual-registry.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { PeerHostWebSocketGateway, PEER_HOST_WS_PATH, type PeerHostWsGatewayEndpoint } from '../modules/peer-host/peer-host-ws-gateway.js'
import { PeerHostWsProxyError, PeerHostWsProxyService, type PeerHostRemoteConnector } from '../modules/peer-host/host-ws-proxy-service.js'
import { createPeerHostRemoteConnector } from '../modules/peer-host/host-ws-connector.js'
import { createPeerHostRelayConnector, PeerHostReconnectManager, type PeerHostRelayTransportFactory } from '../modules/peer-host/peer-host-relay.js'
import { PEER_HOST_ERROR_CODES } from '../../shared/contracts/peer-host.js'
import { FileLanAccessDshLoginStore, resolveLoginProtectionCookieName, verifyLoginProtectionSession } from '../lan-access-dsh.js'
import { createPeerHostDiagnosticSink, toPeerHostDiagnosticSnapshot } from '../modules/peer-host/peer-host-diagnostics.js'
import { AggregatedHostTransportService } from '../modules/peer-host/aggregated-host-transport.js'
import { createDshNativeSummarySource } from '../modules/peer-host/dsh-native-summary-source.js'
import { createPeerHostRemoteSummarySource } from '../modules/peer-host/peer-host-remote-summary-source.js'
import { callPeerNativeRpc, openPeerNativeStream, readNativeRpcEnvelope } from '../modules/peer-host/peer-host-native-transport.js'
import { createAggregateHostSource } from '../modules/peer-host/peer-host-aggregate-service.js'
import { isDshNativeRemoteMethod, rewriteNativeRequestIds, rewriteNativeResponseIds } from '../modules/peer-host/peer-host-native-protocol.js'

/** 原生 Remote 流句柄的存活窗口；每次轮询续期，超时仍未再被轮询即回收。 */
const NATIVE_STREAM_TTL_MS = 600_000

export interface PeerHostFeatureOptions {
  readonly stateDirectory?: string
  readonly ownerUserId?: string
  readonly encryptionKey?: Uint8Array
  readonly fetchImpl?: typeof fetch
  /** 测试或已验证的 Host-to-Host WebSocket connector；未注入时保持不可用。 */
  readonly connectRemote?: PeerHostRemoteConnector
  /** 仅允许复用已验证的 Host 侧 Relay Transport；缺省时中转保持不可用。 */
  readonly relayTransport?: PeerHostRelayTransportFactory
  /** 当前 Host/已验证 PeerHost 的摘要源；未注入时必须保持明确降级。 */
  readonly aggregateSources?: () => Promise<readonly AggregateHostSource[]>
}

/** PeerHost Host 模块；配置、握手和目标登录态只在 Host 进程内装配。 */
export function createPeerHostFeature(options: PeerHostFeatureOptions = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'peerHost',
      version: '0.1.0',
      enabledByDefault: false,
      dependencies: [],
      runtime: 'host',
      requires: [
        { capability: 'peer-host.store', required: false, fallback: 'degrade' },
        { capability: 'peer-host.handshake', required: false, fallback: 'degrade' },
        { capability: 'peer-host.http-proxy', required: false, fallback: 'degrade' },
        { capability: 'peer-host.ws-proxy', required: false, fallback: 'degrade' },
        { capability: 'peer-host.aggregate', required: false, fallback: 'degrade' },
        { capability: 'peer-host.aggregated-transport', required: false, fallback: 'degrade' },
        { capability: 'peer-host.target-capabilities', required: false, fallback: 'degrade' },
        { capability: 'peer-host.local-plugin-baseline', required: false, fallback: 'degrade' },
        { capability: 'peer-host.relay-route', required: false, fallback: 'degrade' },
      ],
    },
    async start(context) {
      const stateDirectory = options.stateDirectory ?? process.env.CODINGNS4DSH_STATE_DIR?.trim() ?? join(homedir(), '.config', 'codingns4dsh')
      const ownerUserId = options.ownerUserId ?? process.env.CODINGNS4DSH_OWNER_ID?.trim() ?? 'local-host'
      const encryptionKey = options.encryptionKey ?? await loadPeerHostKey(join(stateDirectory, 'peer-host-key.bin'))
      const credentials = new EncryptedFilePeerHostCredentialStore(join(stateDirectory, 'peer-host-credentials.enc'), encryptionKey)
      const store = new PeerHostStore(ownerUserId, new FilePeerHostRecordStore(join(stateDirectory, 'peer-host-records.json')), credentials)
      const handshake = new PeerHostHandshakeService(store, credentials, {
        productId: 'CodingNS',
        pluginId: '@jingyi0605/codingns4dsh',
        pluginVersion: CODINGNS_VERSION,
        apiCompatibility: 'peer-host-v1',
        isDshVersionSupported: isDshVersionCompatible,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })
      const sessions = new PeerHostSessionService(store, credentials, options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      const httpProxy = new PeerHostHttpProxyService(store, sessions, options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      const aggregate = new PeerHostAggregateService()
      const workspaceRegistry = new VirtualWorkspaceRegistry({
        orderStore: new FileAggregateWorkspaceOrderStore(join(stateDirectory, 'peer-host-workspace-order.json')),
      })
      let workspaceOrderHydrated = false
      const nativeStreams = new Map<string, { readonly iterator: AsyncIterator<unknown>; readonly scope: HostScope; readonly expiresAt: number }>()
      const dshNativeDispatch = resolveDshNativeDispatch(context.services.dshContext)
      const diagnostics = createPeerHostDiagnosticSink({
        enabled: process.env.CODINGNS4DSH_DEBUG === '1',
        sink: (event, snapshot) => console.info('[codingns4dsh:peer-host]', { event, ...snapshot }),
      })
      const lanConnector = options.connectRemote ?? createPeerHostRemoteConnector()
      const relayConnector = createPeerHostRelayConnector({ ...(options.relayTransport === undefined ? {} : { transport: options.relayTransport }) })
      const connector: PeerHostRemoteConnector = (record, accessToken, scope) => record.route.kind === 'relay'
        ? relayConnector(record, accessToken, scope)
        : lanConnector(record, accessToken, scope)
      const localHostId = process.env.CODINGNS4DSH_HOST_ID?.trim() || ownerUserId
      const localSummarySource = createDshNativeSummarySource(context.services.dshContext, context.services.nativeSessions)
      const buildSources = async (): Promise<readonly AggregateHostSource[]> => {
        if (options.aggregateSources !== undefined) return options.aggregateSources()
        const sources: AggregateHostSource[] = [createAggregateHostSource({
          hostId: localHostId,
          targetHostId: null,
          hostLabel: '当前 Host',
          source: localSummarySource,
        })]
        for (const record of await store.list()) {
          if (record.status !== 'ready') continue
          sources.push(createAggregateHostSource({
            hostId: localHostId,
            targetHostId: record.id,
            hostLabel: record.displayName,
            source: createPeerHostRemoteSummarySource({
              scope: { hostId: localHostId, targetHostId: record.id, workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 },
              transport: {
                rpc: (request) => callPeerNativeRpc(httpProxy, record.id, request),
                stream: (request) => openPeerNativeStream(httpProxy, record.id, request),
              },
            }),
          }))
        }
        return sources
      }
      const reconnectManager = new PeerHostReconnectManager({
        connect: connector,
        onState: async (snapshot) => {
          const current = await store.get(snapshot.peerHostId)
          if (current === null || snapshot.state === 'connecting' || snapshot.state === 'reconnecting' || snapshot.state === 'stopped') return
          if (snapshot.state === 'ready') {
            if (current.status !== 'ready') await store.updateStatus(snapshot.peerHostId, 'ready', null)
            return
          }
          const errorCode = snapshot.lastErrorCode === PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE
            ? PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE
            : PEER_HOST_ERROR_CODES.UNREACHABLE
          await store.updateStatus(snapshot.peerHostId, 'unreachable', errorCode)
        },
      })
      context.resources.add(() => reconnectManager.close())
      // WS 代理的客户端 socket 无法在关闭后替换远端 socket；因此这里保持一条连接一一绑定，
      // 重连 manager 仅治理显式的 Host 侧长连接消费者，避免后台重连产生孤立远端连接。
      const wsProxy = new PeerHostWsProxyService(store, sessions, connector)
      const aggregatedTransport = new AggregatedHostTransportService({
        localHostId,
        hostHome: process.env.HOME?.trim() || homedir(),
        localPlugin: {
          pluginId: '@jingyi0605/codingns4dsh',
          pluginVersion: CODINGNS_VERSION,
          manifestSource: 'local',
          bundleSource: 'local',
          uiSource: 'local',
          allowRemoteManifest: false,
          allowRemoteBundle: false,
        },
        capabilities: [{ hostId: localHostId, targetHostId: null, hostLabel: '当前 Host', status: 'ready', dshVersion: context.services.dshVersion ?? DSH_VERSION, apiCompatibility: 'peer-host-v1', capabilities: ['peer-host.aggregate'] }],
        httpProxy,
        wsProxy,
        peer: {
          nativeRpc: <TResponse>(peerHostId: string, request: Parameters<typeof callPeerNativeRpc>[2]) => callPeerNativeRpc(httpProxy, peerHostId, request) as Promise<TResponse>,
          nativeStream: <TChunk>(peerHostId: string, request: Parameters<typeof openPeerNativeStream>[2]) => openPeerNativeStream(httpProxy, peerHostId, request) as AsyncIterable<TChunk>,
        },
      })
      context.resources.add(() => aggregatedTransport.close())
      const loginStore = new FileLanAccessDshLoginStore()
      const lanSettings = context.services.settings?.get().lanAccessDsh
      const gateway = new PeerHostWebSocketGateway({
        listenHost: process.env.CODINGNS4DSH_PEER_HOST_WS_HOST?.trim() || (lanSettings?.autoStart === true ? lanSettings.listenHost : '127.0.0.1'),
        listenPort: parsePort(process.env.CODINGNS4DSH_PEER_HOST_WS_PORT),
        path: PEER_HOST_WS_PATH,
        authorizeUpgrade: (request) => authorizePeerHostUpgrade(loginStore, request),
        onConnection: (socket, request) => {
          const scope = parseWebSocketScope(request.url)
          if (scope.targetHostId === null) {
            throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 缺少目标 Host')
          }
          return wsProxy.open(scope.targetHostId, socket, scope)
        },
      })
      let wsEndpoint: PeerHostWsGatewayEndpoint | null = null
      try {
        wsEndpoint = await gateway.start()
        context.resources.add(() => gateway.close())
      } catch {
        console.error('codingns4dsh: PeerHost WebSocket 网关启动失败')
      }
      if (context.services.registerPeerHostHandshakeRoute !== undefined) {
        const unregisterHandshake = context.services.registerPeerHostHandshakeRoute(async () => Response.json({
          productId: 'CodingNS',
          pluginId: '@jingyi0605/codingns4dsh',
          pluginVersion: CODINGNS_VERSION,
          dshVersion: context.services.dshVersion ?? DSH_VERSION,
          hostname: hostname().trim() || null,
          configProfile: process.env.CODINGNS4DSH_PROFILE_NAME?.trim() || null,
          apiCompatibility: 'peer-host-v1',
          fingerprint: process.env.CODINGNS4DSH_HOST_FINGERPRINT?.trim() || null,
          capabilities: ['peer-host.store', 'peer-host.handshake', 'peer-host.http-proxy', 'peer-host.ws-proxy', 'peer-host.aggregate', 'peer-host.aggregated-transport'],
        }))
        context.resources.add(unregisterHandshake)
      }
      const unregister = context.services.rpc.register('peerHost', async (action, payload, rpcContext) => {
        const input = record(payload)
        switch (action) {
          case 'list': return (await store.list()).map(toPeerHostClientRecord)
          case 'diagnostics': {
            const snapshots = (await store.list()).map(toPeerHostDiagnosticSnapshot)
            for (const snapshot of snapshots) diagnostics.emit('peer-host.snapshot', snapshot)
            return snapshots
          }
          case 'create': return toPeerHostClientRecord(await store.create({ displayName: requiredString(input.displayName, 'displayName'), route: parseRoute(input.route) }))
          case 'update': return toPeerHostClientRecord(await store.update(requiredString(input.peerHostId, 'peerHostId'), {
            ...(input.displayName === undefined ? {} : { displayName: requiredString(input.displayName, 'displayName') }),
            ...(input.route === undefined ? {} : { route: parseRoute(input.route) }),
          }))
          case 'remove': await store.remove(requiredString(input.peerHostId, 'peerHostId')); return { removed: true }
          case 'enable': return toPeerHostClientRecord(await store.updateStatus(requiredString(input.peerHostId, 'peerHostId'), 'configured', null))
          case 'disable': return toPeerHostClientRecord(await store.updateStatus(requiredString(input.peerHostId, 'peerHostId'), 'disabled', null))
          case 'check': return handshake.check(requiredString(input.peerHostId, 'peerHostId')).then(toPeerHostClientRecord)
          case 'reconnect': {
            const peerHostId = requiredString(input.peerHostId, 'peerHostId')
            await store.updateStatus(peerHostId, 'reconnecting', null)
            return handshake.check(peerHostId).then(toPeerHostClientRecord)
          }
          case 'status': return loadPeerHostStatus(httpProxy, requiredString(input.peerHostId, 'peerHostId'), localHostId)
          case 'login': return sessions.login(requiredString(input.peerHostId, 'peerHostId'), {
            username: requiredString(input.username, 'username'),
            password: requiredString(input.password, 'password'),
          })
          case 'logout': return sessions.logout(requiredString(input.peerHostId, 'peerHostId'))
          case 'wsEndpoint': return wsEndpoint
          case 'aggregate': {
            const results = await aggregate.load(await buildSources())
            workspaceRegistry.replace(results)
            if (!workspaceOrderHydrated) {
              await workspaceRegistry.hydrateOrder()
              workspaceOrderHydrated = true
            }
            return results
          }
          case 'workspaceOrder': {
            const action = input.action === undefined ? 'get' : requiredString(input.action, 'action')
            if (action === 'get') {
              return {
                orderedWorkspaceIds: workspaceRegistry.listWorkspaceIds(),
                persistedWorkspaceIds: workspaceRegistry.listPersistedWorkspaceIds(),
              }
            }
            if (action === 'move') {
              const workspaceId = requiredString(input.virtualWorkspaceId, 'virtualWorkspaceId')
              const before = input.beforeVirtualWorkspaceId === null || input.beforeVirtualWorkspaceId === undefined
                ? null
                : requiredString(input.beforeVirtualWorkspaceId, 'beforeVirtualWorkspaceId')
              return { orderedWorkspaceIds: await workspaceRegistry.move(workspaceId, before) }
            }
            throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 PeerHost workspaceOrder 操作: ${action}`)
          }
          case 'request': {
            const peerHostId = requiredString(input.peerHostId, 'peerHostId')
            const scope = parseScope(input.scope)
            return httpProxy.request(peerHostId, {
              scope,
              path: requiredString(input.path, 'path'),
              ...(input.method === undefined ? {} : { method: requiredString(input.method, 'method') }),
              ...(input.body === undefined ? {} : { body: requiredString(input.body, 'body') }),
            })
          }
          case 'nativeLocal': {
            const method = requiredString(input.method, 'method')
            if (!isDshNativeRemoteMethod(method)) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 DSH 原生 Remote 方法: ${method}`)
            parseScope(input.scope)
            // 必须经过 DSH 自己的 Typert Gateway 解码线上载荷，不能直接调用 Controller。
            if (dshNativeDispatch === undefined) throw new CodingNsRpcError('CODINGNS_RPC_UNSUPPORTED', '当前 Host 未提供 DSH Typert Gateway')
            return await dshNativeDispatch.rpc(method, input.payload, (rpcContext as { signal?: AbortSignal } | undefined)?.signal)
          }
          case 'nativeStream': {
            const method = requiredString(input.method, 'method')
            if (!isDshNativeRemoteMethod(method)) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 DSH 原生 Remote 方法: ${method}`)
            const scope = parseScope(input.scope)
            // 远端流与 unary 一样需要双向 ID 改写：请求要换回目标 Host 的真实 ID，
            // 帧里的 ID 要重新编码成虚拟 ID，否则原生会话流认不出目标 Host 的会话。
            const payload = rewriteNativeRequestIds(method, input.payload, workspaceRegistry)
            // 句柄由 nativeStreamNext/Close 轮询管理，不绑定本次 HTTP 请求的 signal：
            // 该 signal 会在 nativeStream 响应返回后立即中止，导致第一次 next 直接结束。
            const stream = aggregatedTransport.openStream({ scope, method, payload })
            const targetHostId = scope.targetHostId
            const iterator = targetHostId === null
              ? stream[Symbol.asyncIterator]()
              : mapAsyncIterator(stream[Symbol.asyncIterator](), (value) => rewriteNativeResponseIds(
                value,
                (id) => createVirtualWorkspaceId(targetHostId, id),
                (id) => createVirtualSessionId(targetHostId, id),
              ))
            const streamId = randomUUID()
            nativeStreams.set(streamId, { iterator, scope, expiresAt: Date.now() + NATIVE_STREAM_TTL_MS })
            return { streamId }
          }
          case 'nativeStreamOpen': {
            const method = requiredString(input.method, 'method')
            if (!isDshNativeRemoteMethod(method)) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 DSH 原生 Remote 方法: ${method}`)
            const scope = parseScope(input.scope)
            // 句柄会在后续 nativeStreamNext/Close 中被轮询管理，不能绑定到本次 HTTP 请求的短生命周期 signal。
            if (dshNativeDispatch === undefined) throw new CodingNsRpcError('CODINGNS_RPC_UNSUPPORTED', '当前 Host 未提供 DSH Typert Gateway')
            const stream = await dshNativeDispatch.stream(method, input.payload)
            if (!isAsyncIterable(stream)) throw new CodingNsRpcError('CODINGNS_RPC_UNSUPPORTED', `DSH 原生 Remote 方法不是流: ${method}`)
            const streamId = randomUUID()
            nativeStreams.set(streamId, { iterator: stream[Symbol.asyncIterator](), scope, expiresAt: Date.now() + NATIVE_STREAM_TTL_MS })
            return { streamId }
          }
          case 'nativeStreamNext': {
            const streamId = requiredString(input.streamId, 'streamId')
            const stream = nativeStreams.get(streamId)
            if (stream === undefined || stream.expiresAt < Date.now()) {
              if (stream?.iterator.return !== undefined) await stream.iterator.return()
              nativeStreams.delete(streamId)
              throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', 'DSH 原生 Remote 流已失效')
            }
            const scope = parseScope(input.scope)
            assertSameScope(stream.scope, scope)
            // 每次轮询都算一次心跳：空闲会话的 next 会长时间挂起，不能只在出帧时续期。
            nativeStreams.set(streamId, { ...stream, expiresAt: Date.now() + NATIVE_STREAM_TTL_MS })
            const next = await stream.iterator.next()
            if (next.done === true) nativeStreams.delete(streamId)
            return { done: next.done === true, ...(next.done === true ? {} : { value: next.value }) }
          }
          case 'nativeStreamClose': {
            const streamId = requiredString(input.streamId, 'streamId')
            const stream = nativeStreams.get(streamId)
            nativeStreams.delete(streamId)
            if (stream?.iterator.return !== undefined) await stream.iterator.return()
            return { closed: true }
          }
          case 'native': {
            const method = requiredString(input.method, 'method')
            if (!isDshNativeRemoteMethod(method)) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 DSH 原生 Remote 方法: ${method}`)
            const scope = parseScope(input.scope)
            const rewritten = rewriteNativeRequestIds(method, input.payload, workspaceRegistry)
            const value = await aggregatedTransport.rpc({ scope, method, payload: rewritten })
            const virtualHostId = scope.targetHostId ?? scope.hostId
            return rewriteNativeResponseIds(value, (id) => createVirtualWorkspaceId(virtualHostId, id), (id) => createVirtualSessionId(virtualHostId, id))
          }
          default: throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 PeerHost RPC: peerHost/${action}`)
        }
      })
      context.resources.add(unregister)
      context.resources.add(() => {
        for (const stream of nativeStreams.values()) void stream.iterator.return?.()
        nativeStreams.clear()
      })
    },
  }
}

/** 逐帧映射异步迭代器；不改变完成与错误语义。 */
function mapAsyncIterator<TValue, TMapped>(iterator: AsyncIterator<TValue>, map: (value: TValue) => TMapped): AsyncIterator<TMapped> {
  const mapped: AsyncIterator<TMapped> = {
    async next(): Promise<IteratorResult<TMapped>> {
      const next = await iterator.next()
      if (next.done === true) return { done: true, value: undefined }
      return { done: false, value: map(next.value) }
    },
  }
  if (iterator.return !== undefined) {
    const close = iterator.return.bind(iterator)
    mapped.return = async (value?: unknown): Promise<IteratorResult<TMapped>> => {
      const result = await close(value)
      if (result.done === true) return { done: true, value: undefined }
      return { done: false, value: map(result.value) }
    }
  }
  return mapped
}

/** 通过目标 Host 自有 RPC 读取资源采样；不把目标 URL 暴露给客户端。 */
async function loadPeerHostStatus(httpProxy: PeerHostHttpProxyService, peerHostId: string, localHostId: string): Promise<DshHostStatus> {
  const scope = { hostId: localHostId, targetHostId: peerHostId, workspaceId: '__management__', sessionId: null, scopeGeneration: 0 } as const
  const response = await httpProxy.request(peerHostId, {
    scope,
    path: '/api/codingns/host/status',
    method: 'POST',
    body: JSON.stringify({ rpcId: `peer-host-status-${randomUUID()}`, method: 'host/status', payload: {} }),
  })
  return parsePeerHostStatus(readNativeRpcEnvelope(response.body))
}

function parsePeerHostStatus(value: unknown): DshHostStatus {
  const input = record(value)
  const cpuPercent = finiteNumber(input.cpuPercent)
  const memoryPercent = finiteNumber(input.memoryPercent)
  const memoryUsedBytes = finiteNumber(input.memoryUsedBytes)
  const memoryTotalBytes = finiteNumber(input.memoryTotalBytes)
  const sampledAt = finiteNumber(input.sampledAt)
  if (cpuPercent === null || memoryPercent === null || memoryUsedBytes === null || memoryTotalBytes === null || sampledAt === null) {
    throw new CodingNsRpcError('CODINGNS_RPC_RESPONSE_INVALID', '目标 Host 资源状态字段无效')
  }
  return { cpuPercent, memoryPercent, memoryUsedBytes, memoryTotalBytes, sampledAt }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

function assertSameScope(expected: HostScope, actual: HostScope): void {
  if (expected.hostId !== actual.hostId || expected.targetHostId !== actual.targetHostId || expected.workspaceId !== actual.workspaceId || expected.sessionId !== actual.sessionId || expected.scopeGeneration !== actual.scopeGeneration) {
    throw new CodingNsRpcError('CODINGNS_RPC_SCOPE_MISMATCH', 'DSH 原生 Remote 流作用域不匹配')
  }
}

async function authorizePeerHostUpgrade(loginStore: FileLanAccessDshLoginStore, request: import('node:http').IncomingMessage): Promise<boolean> {
  const origin = request.headers.origin
  const host = request.headers.host
  if (typeof origin === 'string' && typeof host === 'string') {
    try {
      const originUrl = new URL(origin)
      const originHost = normalizeHostName(originUrl.hostname)
      const requestHost = normalizeHostName(readRequestHost(host))
      if (originHost !== requestHost) return false
    } catch { return false }
  }
  const config = await loginStore.read()
  if (config === null || !config.enabled || !config.scopes.lan) return true
  const token = readCookie(request.headers.cookie, resolveLoginProtectionCookieName())
  return verifyLoginProtectionSession(loginStore, token, 'lan')
}

function parseWebSocketScope(rawUrl: string | undefined): HostScope {
  if (rawUrl === undefined) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 缺少作用域')
  const url = new URL(rawUrl, 'http://peer-host.invalid')
  const allowed = new Set(['hostId', 'targetHostId', 'workspaceId', 'sessionId', 'scopeGeneration'])
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 查询参数未加入白名单')
  for (const key of allowed) if (url.searchParams.getAll(key).length > 1) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 作用域参数不得重复')
  const hostId = requiredString(url.searchParams.get('hostId'), 'hostId')
  const targetHostId = requiredString(url.searchParams.get('targetHostId'), 'targetHostId')
  const workspaceId = requiredString(url.searchParams.get('workspaceId'), 'workspaceId')
  const sessionId = url.searchParams.get('sessionId')
  const scopeGeneration = Number(url.searchParams.get('scopeGeneration'))
  if (!Number.isSafeInteger(scopeGeneration) || scopeGeneration < 0) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 作用域 generation 无效')
  return { hostId, targetHostId, workspaceId, sessionId: sessionId?.trim() || null, scopeGeneration }
}

function readCookie(value: string | undefined, name: string): string | undefined {
  for (const item of (value ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator > 0 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim()
  }
  return undefined
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0
  const port = Number(value)
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : 0
}

function normalizeHostName(value: string): string {
  const host = value.trim().toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return '127.0.0.1'
  return host
}

function readRequestHost(value: string): string {
  const host = value.trim()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 1 ? host.slice(1, end) : ''
  }
  return host.split(':')[0] ?? ''
}

async function loadPeerHostKey(path: string): Promise<Uint8Array> {
  try {
    const key = await readFile(path)
    if (key.byteLength !== 32) throw new Error('PeerHost 密钥文件长度无效')
    return key
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
    const key = randomBytes(32)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      await writeFile(path, key, { mode: 0o600, flag: 'wx' })
      return key
    } catch (writeError) {
      if (!isNodeError(writeError, 'EEXIST')) throw writeError
      const existing = await readFile(path)
      if (existing.byteLength !== 32) throw new Error('PeerHost 密钥文件长度无效')
      return existing
    }
  }
}

function parseRoute(value: unknown): PeerHostRoute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('route 必须是对象')
  const route = value as Record<string, unknown>
  if (route.kind === 'lan') return { kind: 'lan', baseUrl: requiredString(route.baseUrl, 'baseUrl'), normalizedOrigin: typeof route.normalizedOrigin === 'string' ? route.normalizedOrigin : '' }
  if (route.kind === 'relay') return { kind: 'relay', deviceId: requiredString(route.deviceId, 'deviceId'), relayEntryId: requiredString(route.relayEntryId, 'relayEntryId'), transportVersion: requiredString(route.transportVersion, 'transportVersion') }
  throw new TypeError('route.kind 无效')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('PeerHost RPC 参数必须是对象')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 不能为空`)
  return value.trim()
}

function parseScope(value: unknown): import('../../shared/contracts/peer-host.js').HostScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('scope 必须是对象')
  const scope = value as Record<string, unknown>
  const hostId = requiredString(scope.hostId, 'scope.hostId')
  const targetHostId = scope.targetHostId === null ? null : requiredString(scope.targetHostId, 'scope.targetHostId')
  const workspaceId = requiredString(scope.workspaceId, 'scope.workspaceId')
  const sessionId = scope.sessionId === null ? null : requiredString(scope.sessionId, 'scope.sessionId')
  if (typeof scope.scopeGeneration !== 'number' || !Number.isSafeInteger(scope.scopeGeneration) || scope.scopeGeneration < 0) throw new TypeError('scope.scopeGeneration 无效')
  return { hostId, targetHostId, workspaceId, sessionId, scopeGeneration: scope.scopeGeneration }
}

export function toPeerHostClientRecord(record: PeerHostRecord): PeerHostClientRecord {
  return {
    ...record,
    fingerprint: redactFingerprint(record.fingerprint),
    route: record.route.kind === 'lan' ? { kind: 'lan' } : { kind: 'relay' },
  }
}

function redactFingerprint(value: string | null): string | null {
  if (value === null || value.length <= 12) return value
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}
