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
import type { AggregateHostResult, PeerHostRecord, PeerHostClientRecord } from '../../shared/contracts/peer-host.js'
import type { AssistantWaitingKind } from '../../shared/contracts/assistant.js'
import { assistantWorkspaceMatches } from '../../shared/assistant-lifecycle.js'
import type { DshHostStatus } from '../../shared/contracts/host-status.js'
import { createVirtualSessionId, createVirtualWorkspaceId, normalizePeerHostColor, parseVirtualSessionId, parseVirtualWorkspaceId, type HostScope } from '../../shared/contracts/peer-host.js'
import type { AggregateHostSource } from '../modules/peer-host/peer-host-aggregate-service.js'
import { PeerHostAggregateService } from '../modules/peer-host/peer-host-aggregate-service.js'
import { PeerHostWorkspaceCache } from '../modules/peer-host/peer-host-workspace-cache.js'
import { resolveDshNativeDispatch } from '../modules/peer-host/peer-host-native-dispatch.js'
import { PeerHostNativeStreams } from '../modules/peer-host/peer-host-native-streams.js'
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
import { createPeerHostRemoteSummarySource, readPeerHostRemoteWorkspaceCandidates, type PeerHostRemoteWorkspaceCandidate } from '../modules/peer-host/peer-host-remote-summary-source.js'
import { callPeerCliRpc, callPeerNativeRpc, openPeerNativeStream, readNativeRpcEnvelope } from '../modules/peer-host/peer-host-native-transport.js'
import { createAggregateHostSource } from '../modules/peer-host/peer-host-aggregate-service.js'
import { encodeNativeResponseBytes, isDshNativeRemoteMethod, rewriteNativeRequestIds, rewriteNativeResponseIds, type VirtualIdResolver } from '../modules/peer-host/peer-host-native-protocol.js'
import { resolveCodingNsDebugLevel } from '../../shared/debug.js'
import { AssistantPeerNotifications, assistantPeerNotificationWorkspaceIds, assistantPeerNotificationCapabilityKey } from './assistant-peer-notifications.js'
import { readAssistantNotificationFeed } from '../../shared/assistant-notification-feed.js'
import type { AssistantNotificationFeedRequest } from '../../shared/assistant-notification-feed.js'
import type { AssistantNotificationTarget } from '../../shared/assistant-notifications.js'

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
      // PeerHost 的 Host 服务由本 Feature 在 start() 中按当前状态目录创建，
      // 不属于 DSH Context 的启动前注入能力。把它们写进 requires 会在
      // capabilityProfile 已经冻结之后才去查找尚未创建的局部实例，导致每次
      // 启动都产生 CAPABILITY_UNAVAILABLE，但对实际启动没有任何帮助。
      // 真正由 DSH 提供的能力仍由 capability registry 在入口处统一探测；
      // Relay 也继续在连接器内部按显式 transport 注入情况降级。
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
      const workspaceCache = new PeerHostWorkspaceCache(join(stateDirectory, 'peer-host-workspace-cache.json'), ownerUserId)
      const workspaceRegistry = new VirtualWorkspaceRegistry({
        orderStore: new FileAggregateWorkspaceOrderStore(join(stateDirectory, 'peer-host-workspace-order.json')),
      })
      let workspaceOrderHydrated = false
      const nativeStreams = new PeerHostNativeStreams()
      const dshNativeDispatch = resolveDshNativeDispatch(context.services.dshContext)
      const debugLevel = resolveCodingNsDebugLevel()
      const diagnostics = createPeerHostDiagnosticSink({
        enabled: debugLevel !== 'off',
        sink: (event, snapshot) => {
          const failed = snapshot.status !== 'ready' || snapshot.lastErrorCode !== null
          if (debugLevel === 'warn' && !failed) return
          if (failed) console.warn('[codingns4dsh:peer-host]', { event, ...snapshot })
          else console.info('[codingns4dsh:peer-host]', { event, ...snapshot })
        },
      })
      const lanConnector = options.connectRemote ?? createPeerHostRemoteConnector()
      const relayConnector = createPeerHostRelayConnector({ ...(options.relayTransport === undefined ? {} : { transport: options.relayTransport }) })
      const connector: PeerHostRemoteConnector = (record, accessToken, scope) => record.route.kind === 'relay'
        ? relayConnector(record, accessToken, scope)
        : lanConnector(record, accessToken, scope)
      const localHostId = process.env.CODINGNS4DSH_HOST_ID?.trim() || ownerUserId
      const localSummarySource = createDshNativeSummarySource(context.services.dshContext, context.services.nativeSessions)
      /**
       * 聚合前确保目标 Host 已完成握手和认证。
       *
       * PeerHost 的记录状态是运行时缓存，不是登录凭据本身：远端返回 401 后
       * 状态会暂时变成 session_required，下一次聚合必须主动用持久化的 refresh
       * token/账号密码恢复，否则只要没有手工点“测试”，该目标就会永远被跳过。
       */
      const preparePeerHost = async (input: PeerHostRecord): Promise<PeerHostRecord | null> => {
        if (input.status === 'disabled' || input.status === 'identity_changed') return null
        let record = input
        if (record.status === 'session_required') {
          await sessions.refresh(record.id).catch(() => undefined)
          record = (await store.get(record.id)) ?? record
        } else if (record.status !== 'ready') {
          // configured/unreachable/version_mismatch 等状态都可能只是上一次启动
          // 或网络抖动留下的缓存；自动重试等价于管理面板的“测试”。
          record = await handshake.check(record.id)
        }
        if (record.status !== 'ready') return null
        // 即使 access token 尚未到期，也检查一次当前认证状态；临近过期时这里
        // 会 refresh，refresh token 失效时会用保存的账号密码静默重登。
        try {
          await sessions.getAccessToken(record.id)
        } catch {
          return null
        }
        return (await store.get(record.id)) ?? record
      }
      const buildSources = async (assistantWorkspaceIds?: readonly string[], signal?: AbortSignal): Promise<readonly AggregateHostSource[]> => {
        signal?.throwIfAborted()
        if (options.aggregateSources !== undefined) {
          const sources = await options.aggregateSources()
          signal?.throwIfAborted()
          return assistantWorkspaceIds === undefined ? sources : sources.filter((source) => source.targetHostId !== null)
        }
        const sources: AggregateHostSource[] = assistantWorkspaceIds === undefined ? [createAggregateHostSource({
          hostId: localHostId,
          targetHostId: null,
          hostLabel: '当前 Host',
          source: localSummarySource,
        })] : []
        const records = await store.list()
        signal?.throwIfAborted()
        // 助理只访问受管远端，不能为了本地索引唤醒全部 PeerHost 或重复扫描本地列表。
        const selectedRecords = assistantWorkspaceIds === undefined ? records : records.filter((record) => record.status !== 'disabled' && record.status !== 'identity_changed'
          && (record.visibleWorkspaceIds ?? []).some((workspaceId) => assistantWorkspaceIds.some((selected) => assistantWorkspaceMatches(selected, record.id, workspaceId))))
        const preparedRecords = await Promise.all(selectedRecords.map((record) => preparePeerHost(record).catch(() => null)))
        signal?.throwIfAborted()
        for (const [index, record] of preparedRecords.entries()) {
          if (record === null || record.status !== 'ready') {
            // 受管远端的握手/认证失败也必须交给助理退避，不能冒充没有远端工作区。
            const original = selectedRecords[index]!
            if (original.status !== 'disabled' && original.status !== 'identity_changed') sources.push({
              hostId: localHostId, targetHostId: original.id, hostLabel: original.displayName, hostColor: original.color ?? null,
              load: async () => { throw new Error('远端 Host 暂不可达') },
            })
            continue
          }
          const selectedWorkspaceIds = assistantWorkspaceIds === undefined
            ? (record.visibleWorkspaceIds ?? [])
            : (record.visibleWorkspaceIds ?? []).filter((workspaceId) => assistantWorkspaceIds.some((selected) => assistantWorkspaceMatches(selected, record.id, workspaceId)))
          if (assistantWorkspaceIds !== undefined && selectedWorkspaceIds.length === 0) continue
          sources.push(createAggregateHostSource({
            hostId: localHostId,
            targetHostId: record.id,
            hostLabel: record.displayName,
            hostColor: record.color ?? null,
            source: createPeerHostRemoteSummarySource({
              scope: { hostId: localHostId, targetHostId: record.id, workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 },
              transport: {
                rpc: (request) => callPeerNativeRpc(httpProxy, record.id, { ...request, ...(signal === undefined ? {} : { signal }) }),
                stream: (request) => openPeerNativeStream(httpProxy, record.id, { ...request, ...(signal === undefined ? {} : { signal }) }),
                cli: (request) => callPeerCliRpc(httpProxy, record.id, { ...request, ...(signal === undefined ? {} : { signal }) }),
              },
              // 默认只投影用户显式添加的远端工作区；未添加时不展示该 Host 的任何工作区。
              visibleWorkspaceIds: selectedWorkspaceIds,
            }),
          }))
        }
        return sources
      }
      /** 远端工作区候选的唯一读取入口；不过滤可见性，供"添加工作区"选择器使用。 */
      const readRemoteWorkspaceCandidates = async (peerHostId: string): Promise<readonly PeerHostRemoteWorkspaceCandidate[]> => {
        const configured = await store.get(peerHostId)
        if (configured === null) throw new CodingNsRpcError('PEER_HOST_NOT_FOUND', 'PeerHost 不存在')
        const record = await preparePeerHost(configured)
        if (record === null || record.status !== 'ready') {
          throw new CodingNsRpcError('PEER_HOST_NOT_READY', 'PeerHost 尚未通过握手检查')
        }
        return await readPeerHostRemoteWorkspaceCandidates({
          scope: { hostId: localHostId, targetHostId: record.id, workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 },
          transport: {
            rpc: (request) => callPeerNativeRpc(httpProxy, record.id, request),
            stream: (request) => openPeerNativeStream(httpProxy, record.id, request),
          },
        })
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
      const readNotificationSource = async (peerHostId: string, payload: AssistantNotificationFeedRequest, signal: AbortSignal): Promise<unknown> => {
        const response = await httpProxy.request(peerHostId, {
          scope: { hostId: localHostId, targetHostId: peerHostId, workspaceId: '__assistant_notifications__', sessionId: null, scopeGeneration: 0 },
          path: '/api/codingns/assistant/notifications/source', method: 'POST',
          body: JSON.stringify({ rpcId: `assistant-source-${randomUUID()}`, method: 'assistant/notifications/source', payload }), signal,
        })
        if ([404, 405, 501].includes(response.status)) throw new CodingNsRpcError('UNSUPPORTED_CAPABILITY', '远端不支持会话通知来源协议')
        return readNativeRpcEnvelope(response.body)
      }
      const assistantGateway = {
        async validateNotificationTarget(target: AssistantNotificationTarget): Promise<boolean> {
          if (target.hostId === localHostId) return false
          const record = await store.get(target.hostId)
          if (record === null || record.status === 'disabled' || record.status === 'identity_changed') return false
          const workspaceId = assistantPeerNotificationWorkspaceIds(target.hostId, record.visibleWorkspaceIds ?? [], [target.workspaceId])[0]
          if (workspaceId === undefined) return false
          const signal = AbortSignal.timeout(5_000)
          try {
            const results = await aggregate.load(await buildSources([createVirtualWorkspaceId(target.hostId, workspaceId)], signal))
            signal.throwIfAborted()
            const present = results.some(result => result.targetHostId === target.hostId && result.availability === 'ready'
              && result.workspaces.some(item => item.workspaceId === workspaceId
                && item.sessions.some(session => session.scope.sessionId === target.sessionId && !session.blank)))
            if (!present) return false
            if (target.requestId === undefined) return true
            const feed = readAssistantNotificationFeed(await readNotificationSource(target.hostId, { workspaceIds: [workspaceId] }, signal))
            const actualSession = target.actualRequestTarget?.sessionId ?? target.sessionId
            return feed.pending.some(fact => (fact.actualRequestSessionId ?? fact.sessionId) === actualSession && fact.requestId === target.requestId && fact.kind === target.requestKind)
          } catch { return false }
        },
        subscribeNotifications(managedWorkspaceIds: readonly string[], observer: import('./assistant-peer-notifications.js').AssistantPeerNotificationObserver, signal?: AbortSignal) {
          const subscription = new AssistantPeerNotifications({
            observer,
            nodes: async (signal) => {
              signal.throwIfAborted()
              const records = await store.list()
              signal.throwIfAborted()
              return records.filter(record => record.status !== 'disabled' && record.status !== 'identity_changed')
                .map(record => ({
                  hostId: record.id, hostLabel: record.displayName,
                  capabilityKey: assistantPeerNotificationCapabilityKey(record),
                  workspaceIds: assistantPeerNotificationWorkspaceIds(record.id, record.visibleWorkspaceIds ?? [], managedWorkspaceIds),
                })).filter(node => node.workspaceIds.length > 0)
            },
            read: async (node, payload, signal) => {
              // 通知不依赖索引触发握手；只在缓存尚未 ready 时准备当前这台受管 Host。
              const configured = await store.get(node.hostId)
              if (configured === null) throw new CodingNsRpcError('PEER_HOST_NOT_FOUND', 'PeerHost 不存在')
              if (configured.status !== 'ready' && await preparePeerHost(configured) === null) throw new CodingNsRpcError('PEER_HOST_NOT_READY', '远端 Host 暂不可达')
              signal.throwIfAborted()
              return readNotificationSource(node.hostId, payload, signal)
            },
          }, signal)
          return subscription.start()
        },
        async workspaces(signal?: AbortSignal) {
          signal?.throwIfAborted()
          const records = await store.list()
          signal?.throwIfAborted()
          return records.filter((record) => record.status !== 'disabled' && record.status !== 'identity_changed')
            .flatMap((record) => (record.visibleWorkspaceIds ?? []).map((id) => ({ workspaceId: createVirtualWorkspaceId(record.id, id), name: `${record.displayName} / ${id}`, path: null })))
        },
        async list(managedWorkspaceIds: readonly string[], signal?: AbortSignal) {
          signal?.throwIfAborted()
          // 超时必须到达底层 RPC 和订阅，不能仅让 Promise.race 的调用方提前返回。
          const deadline = AbortSignal.timeout(5_000)
          const loadSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
          const results = await aggregate.load(await buildSources(managedWorkspaceIds, loadSignal))
          signal?.throwIfAborted()
          const failed = results.some((result) => result.availability !== 'ready')
          const sessions = [] as import('./assistant-session-index.js').AssistantSessionSourceRecord[]
          const archivedSessionIds: string[] = []
          for (const result of results) {
            // 本地 Host 已由 global-voice-rpc 通过 sessionQuery 读取；Gateway 只补充
            // 远端摘要，避免同一会话被两条来源重复计入。
            if (result.targetHostId === null) continue
            for (const workspace of result.workspaces) {
              const hostId = workspace.targetHostId ?? workspace.hostId
              const workspaceId = managedWorkspaceIds.find((selected) => assistantWorkspaceMatches(selected, hostId, workspace.workspaceId)) ?? workspace.workspaceId
              for (const session of workspace.sessions) {
                if (session.scope.sessionId === null) continue
                sessions.push(toAssistantSourceRecord(session.scope.sessionId, assistantTitle(session.title, workspace.path, session.scope.sessionId), session.status, workspaceId, workspace.displayName, hostId, session.updatedAt, session.activity))
              }
              for (const session of workspace.archivedSessions ?? []) {
                if (session.scope.sessionId === null) continue
                archivedSessionIds.push(session.scope.sessionId)
                sessions.push(toAssistantSourceRecord(session.scope.sessionId, assistantTitle(session.title, workspace.path, session.scope.sessionId), session.status, workspaceId, workspace.displayName, hostId, session.updatedAt, session.activity))
              }
            }
          }
          const remoteDetails = new Map<string, Promise<{ readonly summary: string | null; readonly waiting: AssistantWaitingKind | null }>>()
          const readRemoteDetails = (session: import('./assistant-session-index.js').AssistantSessionSourceRecord, readSignal?: AbortSignal) => {
            readSignal?.throwIfAborted()
            if (session.hostId === localHostId) {
              return Promise.resolve({ summary: session.summary ?? null, waiting: session.waiting ?? null })
            }
            const key = `${session.hostId}:${session.sessionId}`
            const cached = remoteDetails.get(key)
            if (cached !== undefined) return cached
            const promise = (async () => {
                const virtualWorkspace = parseVirtualWorkspaceId(session.workspaceId)
                const scope = {
                hostId: localHostId,
                targetHostId: session.hostId,
                  workspaceId: virtualWorkspace?.workspaceId ?? (session.workspaceId.startsWith(`${session.hostId}:`) ? session.workspaceId.slice(session.hostId.length + 1) : session.workspaceId),
                sessionId: session.sessionId,
                scopeGeneration: 0,
              } as const
              try {
                // 只读取 DSH 原生 session/follow 的有界 snapshot；不访问目标 Host 的
                // session 存储，也不把流式 chunk 当成摘要正文。
                const stream = aggregatedTransport.openStream({
                  scope,
                  ...(readSignal === undefined ? {} : { signal: readSignal }),
                  method: 'session/follow',
                  payload: {
                    args: {
                      request: {
                        address: { kind: 'session', sessionId: session.sessionId },
                        assistantStream: true,
                        maxMessages: 32,
                      },
                    },
                  },
                })
                for await (const frame of stream) {
                  readSignal?.throwIfAborted()
                  if (!isRecordValue(frame)) continue
                  const value = frame
                  if (value.type !== 'snapshot') continue
                  const records = Array.isArray(value.records) ? value.records : []
                  return {
                    summary: summarizeAssistantRemoteRecords(records),
                    waiting: summarizeAssistantRemoteWaiting(records),
                  }
                }
              } catch {
                readSignal?.throwIfAborted()
                // 单个远端会话不可读时保留其元数据，不能让整个索引失败。
              }
              return { summary: session.summary ?? null, waiting: session.waiting ?? null }
            })()
            remoteDetails.set(key, promise)
            return promise
          }
          return {
            sessions,
            archivedSessionIds,
            volatile: results.length > 0,
            failed,
            warnings: failed ? ['部分远端 Host 暂不可达，已延后重试。'] : [],
            readSummary: async (session: import('./assistant-session-index.js').AssistantSessionSourceRecord, signal?: AbortSignal) => (await readRemoteDetails(session, signal)).summary,
            readWaiting: async (session: import('./assistant-session-index.js').AssistantSessionSourceRecord, signal?: AbortSignal) => (await readRemoteDetails(session, signal)).waiting,
          }
        },
        async dispatch(request: { readonly hostId: string; readonly requestId: string; readonly sessionId: string; readonly mode: 'queue' | 'steer'; readonly content: readonly [{ readonly type: 'text'; readonly text: string }] }, signal?: AbortSignal) {
          if (request.hostId === localHostId) throw new Error('本地 Host 不应经过 PeerHost 派发')
          await aggregatedTransport.rpc({
            scope: { hostId: localHostId, targetHostId: request.hostId, workspaceId: '__assistant__', sessionId: request.sessionId, scopeGeneration: 0 },
            method: 'session/prompt',
            payload: { requestId: request.requestId, sessionId: request.sessionId, mode: request.mode, content: request.content },
            ...(signal === undefined ? {} : { signal }),
          })
        },
      }
      ;(context.services as CodingNsHostServices & { assistantGateway?: typeof assistantGateway }).assistantGateway = assistantGateway
      context.resources.add(() => {
        if ((context.services as CodingNsHostServices & { assistantGateway?: typeof assistantGateway }).assistantGateway === assistantGateway) {
          delete (context.services as CodingNsHostServices & { assistantGateway?: typeof assistantGateway }).assistantGateway
        }
      })
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
      /**
       * 编辑保存 = 一次性完成配置、握手与登录。
       *
       * 用户只在编辑里填一次地址和账号密码；之后连接、续期与票据失效重登全部自动。
       * 因此这里刻意不要求用户先点"测试"再点"登录"。
       */
      const updatePeerHost = async (input: Record<string, unknown>): Promise<PeerHostClientRecord> => {
        const peerHostId = requiredString(input.peerHostId, 'peerHostId')
        // 记录编辑前是否被禁用：握手会把状态写成 ready，必须恢复用户的显式禁用意图。
        const wasDisabled = (await store.get(peerHostId))?.status === 'disabled'
        let record = await store.update(peerHostId, {
          ...(input.displayName === undefined ? {} : { displayName: requiredString(input.displayName, 'displayName') }),
          ...(input.route === undefined ? {} : { route: parseRoute(input.route) }),
          ...(input.color === undefined ? {} : { color: parseColor(input.color) }),
        })
        const username = typeof input.username === 'string' ? input.username.trim() : ''
        const password = typeof input.password === 'string' ? input.password : ''
        // 没有凭据时保持原有登录态：编辑名称或配色不应该把已连接的目标踢下线。
        if (username === '' || password === '') return toPeerHostClientRecord(record)
        record = await handshake.check(peerHostId)
        if (record.status !== 'ready') {
          throw new CodingNsRpcError(
            'PEER_HOST_NOT_READY',
            `PeerHost 握手未通过（${record.status}），凭据未保存`,
          )
        }
        await sessions.login(peerHostId, { username, password })
        // 凭据已经保存，但被禁用的 Host 不应因为一次编辑就被重新启用。
        if (wasDisabled) record = await store.updateStatus(peerHostId, 'disabled', null)
        return toPeerHostClientRecord((await store.get(peerHostId)) ?? record)
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
          case 'create': return toPeerHostClientRecord(await store.create({
            displayName: requiredString(input.displayName, 'displayName'),
            route: parseRoute(input.route),
            ...(input.color === undefined ? {} : { color: parseColor(input.color) }),
          }))
          case 'update': return await updatePeerHost(input)
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
          case 'credentialStatus': {
            const peerHostId = requiredString(input.peerHostId, 'peerHostId')
            const credential = await credentials.read(peerHostId)
            return { peerHostId, hasSavedCredential: credential?.password !== undefined && credential.password !== '' }
          }
          case 'workspaceCandidates': return await readRemoteWorkspaceCandidates(requiredString(input.peerHostId, 'peerHostId'))
          case 'setWorkspaceVisibility': {
            const peerHostId = requiredString(input.peerHostId, 'peerHostId')
            const workspaceId = requiredString(input.workspaceId, 'workspaceId')
            const visible = input.visible === true
            return toPeerHostClientRecord(await store.setWorkspaceVisibility(peerHostId, workspaceId, visible))
          }
          case 'replaceVisibleWorkspaces': {
            const peerHostId = requiredString(input.peerHostId, 'peerHostId')
            const ids = Array.isArray(input.workspaceIds)
              ? input.workspaceIds.flatMap((item) => typeof item === 'string' && item.trim() !== '' ? [item.trim()] : [])
              : []
            return toPeerHostClientRecord(await store.replaceVisibleWorkspaces(peerHostId, ids))
          }
          case 'dismissDisconnectedWorkspace': {
            await workspaceCache.dismiss(requiredString(input.peerHostId, 'peerHostId'), requiredString(input.workspaceId, 'workspaceId'))
            return { removed: true }
          }
          case 'wsEndpoint': return wsEndpoint
          case 'aggregate': {
            // 顺序 Registry 必须认识本地工作区，即使本地 session 摘要在启动瞬间
            // 还没有准备好。否则 order 只会留下远端 ID，客户端拖拽到本地项时
            // 只能拒绝请求，表现为远端永远被固定在列表顶部。
            const loaded = ensureLocalWorkspaceSummaries(
              await aggregate.load(await buildSources()),
              context.services.dshContext,
            )
            // 测试注入的独立来源不受配置列表约束；生产摘要按当前添加状态恢复缓存。
            const results = options.aggregateSources === undefined ? await workspaceCache.apply(loaded, await store.list()) : loaded
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
                // 返回完整墓碑顺序；远端摘要短暂缺失时，客户端仍需知道其拖拽位置。
                orderedWorkspaceIds: workspaceRegistry.listPersistedWorkspaceIds(),
                persistedWorkspaceIds: workspaceRegistry.listPersistedWorkspaceIds(),
              }
            }
            if (action === 'move') {
              const workspaceId = resolveWorkspaceOrderId(
                requiredString(input.virtualWorkspaceId, 'virtualWorkspaceId'),
                workspaceRegistry,
                localHostId,
              )
              const before = input.beforeVirtualWorkspaceId === null || input.beforeVirtualWorkspaceId === undefined
                ? null
                : resolveWorkspaceOrderId(requiredString(input.beforeVirtualWorkspaceId, 'beforeVirtualWorkspaceId'), workspaceRegistry, localHostId)
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
            return encodeNativeResponseBytes(await dshNativeDispatch.rpc(method, input.payload, (rpcContext as { signal?: AbortSignal } | undefined)?.signal))
          }
          case 'nativeStream': {
            const method = requiredString(input.method, 'method')
            if (!isDshNativeRemoteMethod(method)) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 DSH 原生 Remote 方法: ${method}`)
            const scope = parseScope(input.scope)
            // 远端流与 unary 一样需要双向 ID 改写：请求要换回目标 Host 的真实 ID，
            // 帧里的 ID 要重新编码成虚拟 ID，否则原生会话流认不出目标 Host 的会话。
            const payload = rewriteNativeRequestIds(method, input.payload, createScopedNativeIdResolver(workspaceRegistry, scope))
            // 句柄由 nativeStreamNext/Close 轮询管理，不绑定本次 HTTP 请求的 signal：
            // 该 signal 会在 nativeStream 响应返回后立即中止，导致第一次 next 直接结束。
            const streamId = await nativeStreams.open(scope, (signal) => {
              const stream = aggregatedTransport.openStream({ scope, method, payload, signal })
              const targetHostId = scope.targetHostId
              if (targetHostId === null) return stream
              const iterator = mapAsyncIterator(stream[Symbol.asyncIterator](), (value) => rewriteNativeResponseIds(
                value, (id) => createVirtualWorkspaceId(targetHostId, id), (id) => createVirtualSessionId(targetHostId, id),
              ))
              return { [Symbol.asyncIterator]: () => iterator }
            })
            return { streamId }
          }
          case 'nativeStreamOpen': {
            const method = requiredString(input.method, 'method')
            if (!isDshNativeRemoteMethod(method)) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 DSH 原生 Remote 方法: ${method}`)
            const scope = parseScope(input.scope)
            // 句柄会在后续 nativeStreamNext/Close 中被轮询管理，不能绑定到本次 HTTP 请求的短生命周期 signal。
            if (dshNativeDispatch === undefined) throw new CodingNsRpcError('CODINGNS_RPC_UNSUPPORTED', '当前 Host 未提供 DSH Typert Gateway')
            const streamId = await nativeStreams.open(scope, async (signal) => {
              const stream = await dshNativeDispatch.stream(method, input.payload, signal)
              if (!isAsyncIterable(stream)) throw new CodingNsRpcError('CODINGNS_RPC_UNSUPPORTED', `DSH 原生 Remote 方法不是流: ${method}`)
              return stream
            })
            return { streamId }
          }
          case 'nativeStreamNext': {
            const streamId = requiredString(input.streamId, 'streamId')
            const scope = parseScope(input.scope)
            const next = await nativeStreams.next(streamId, scope, (rpcContext as { signal?: AbortSignal } | undefined)?.signal)
            return {
              done: next.done === true,
              ...(next.done === true ? {} : { value: encodeNativeResponseBytes(next.value) }),
            }
          }
          case 'nativeStreamClose': {
            const streamId = requiredString(input.streamId, 'streamId')
            await nativeStreams.close(streamId, parseScope(input.scope))
            return { closed: true }
          }
          case 'native': {
            const method = requiredString(input.method, 'method')
            if (!isDshNativeRemoteMethod(method)) throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 DSH 原生 Remote 方法: ${method}`)
            const scope = parseScope(input.scope)
            const rewritten = rewriteNativeRequestIds(method, input.payload, createScopedNativeIdResolver(workspaceRegistry, scope))
            const signal = (rpcContext as { signal?: AbortSignal } | undefined)?.signal
            const value = await aggregatedTransport.rpc({ scope, method, payload: rewritten, ...(signal === undefined ? {} : { signal }) })
            const virtualHostId = scope.targetHostId ?? scope.hostId
            return encodeNativeResponseBytes(rewriteNativeResponseIds(value, (id) => createVirtualWorkspaceId(virtualHostId, id), (id) => createVirtualSessionId(virtualHostId, id)))
          }
          default: throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 PeerHost RPC: peerHost/${action}`)
        }
      })
      context.resources.add(unregister)
      context.resources.add(() => {
        nativeStreams.dispose()
      })
    },
  }
}

/** 将 session/follow 的有界语义记录压缩成助理可读摘要。 */
export function summarizeAssistantRemoteRecords(records: readonly unknown[]): string | null {
  let latestUser: string | null = null
  let latestAssistant: string | null = null
  let latestTool: string | null = null
  for (const raw of records.slice(-80)) {
    if (!isRecordValue(raw)) continue
    const event = raw
    const data = isRecordValue(event.data) ? event.data : null
    const type = textValue(event.type) ?? textValue(event.kind) ?? textValue(event.event) ?? ''
    const role = textValue(event.role) ?? (data === null ? undefined : textValue(data.role))
    const text = readAssistantRecordText(event, data)
    if (type === 'user/message' || type === 'user.message' || type === 'message/user' || role === 'user') {
      if (text !== null) latestUser = text
      continue
    }
    if (type === 'assistant/message' || type === 'assistant.message' || type === 'message/assistant' || role === 'assistant') {
      if (text !== null) latestAssistant = text
      continue
    }
    if (type === 'tool/call' || type === 'tool.call' || type === 'tool-call' || type === 'tool/result' || type === 'tool.result' || type === 'tool-result' || role === 'tool') {
      const tool = textValue(event.name) ?? textValue(event.tool) ?? textValue(event.toolName)
        ?? (data === null ? undefined : textValue(data.name) ?? textValue(data.tool) ?? textValue(data.toolName))
      if (tool !== undefined) latestTool = tool
    }
  }
  const parts = [
    latestUser === null ? null : `用户：${latestUser}`,
    latestAssistant === null ? null : `助理：${latestAssistant}`,
    latestTool === null ? null : `工具：${latestTool}`,
  ].filter((item): item is string => item !== null)
  return parts.length === 0 ? null : parts.join('；').slice(0, 2000)
}

/** 从 session/follow 的有界语义记录识别远端等待审批或提问状态。 */
export function summarizeAssistantRemoteWaiting(records: readonly unknown[]): AssistantWaitingKind | null {
  let waiting: AssistantWaitingKind | null = null
  for (const raw of records.slice(-80)) {
    if (!isRecordValue(raw)) continue
    const event = raw
    const data = isRecordValue(event.data) ? event.data : null
    const candidates = [
      textValue(event.type),
      textValue(event.kind),
      textValue(event.event),
      data === null ? undefined : textValue(data.type),
      data === null ? undefined : textValue(data.kind),
      data === null ? undefined : textValue(data.event),
    ].filter((value): value is string => value !== undefined)
    for (const candidate of candidates) {
      const normalized = candidate.toLocaleLowerCase().replaceAll('_', '-')
      if (/approval[/:.-](request|asked|pending)/u.test(normalized)) {
        waiting = 'approval'
      } else if (/(?:user[-/]questions?|question)[/:.-](request|asked|pending)/u.test(normalized)) {
        waiting = 'question'
      } else if (
        /approval[/:.-](resolve|resolved|response|responded|granted|denied|answer|answered)/u.test(normalized)
        || /(?:user[-/]questions?|question)[/:.-](resolve|resolved|response|responded|answer|answered)/u.test(normalized)
        || /turn[/:.-](end|ended|complete|completed)/u.test(normalized)
      ) {
        waiting = null
      }
    }
  }
  return waiting
}

function readAssistantRecordText(event: Record<string, unknown>, data: Record<string, unknown> | null): string | null {
  for (const source of [event, data]) {
    if (source === null) continue
    for (const key of ['text', 'message', 'content', 'summary', 'transcript']) {
      const value = source[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
      if (Array.isArray(value)) {
        const text = value.map((item) => {
          if (typeof item === 'string') return item
          if (!isRecordValue(item)) return ''
          return textValue(item.text) ?? textValue(item.content) ?? textValue(item.value) ?? ''
        }).join(' ').trim()
        if (text !== '') return text
      }
    }
  }
  return null
}

function toAssistantSourceRecord(
  sessionId: string,
  title: string | null,
  status: string,
  workspaceId: string,
  workspaceName: string,
  hostId: string,
  updatedAt: number,
  activity?: 'running' | 'idle' | 'unknown',
): import('./assistant-session-index.js').AssistantSessionSourceRecord {
  const normalized = status.toLocaleLowerCase()
  const running = /running|active|working|queued/u.test(normalized)
  const error = /error|failed|failure/u.test(normalized)
  const completed = /completed|complete|done|success/u.test(normalized)
  return {
    sessionId,
    title,
    workspaceId,
    workspaceName,
    hostId,
    running,
    activity: activity ?? (running ? 'running' : /completed|complete|done|success|error|failed/u.test(normalized) ? 'idle' : 'unknown'),
    completed,
    ...(error ? { error: true } : {}),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    waiting: null,
    summary: null,
  }
}

/** 助理索引不能把远端 source 为导航而猜出的目录名或 ID 当成正式标题。 */
function assistantTitle(title: string, workspacePath: string, sessionId: string): string | null {
  const normalized = title.trim()
  if (normalized === '' || normalized === sessionId) return null
  const segments = workspacePath.split(/[\\/]+/u).filter((segment) => segment !== '')
  const directory = segments.at(-1) ?? ''
  return directory !== '' && normalized === directory ? null : normalized
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

/**
 * 解析工作区标签配色。
 *
 * 颜色最终会写进本机侧栏 DOM 的内联样式，因此只接受 `#rrggbb`；`null` 表示
 * 清除自定义色，回退到客户端按名称推导的稳定色。
 */
function parseColor(value: unknown): string | null {
  if (value === null) return null
  const normalized = normalizePeerHostColor(value)
  if (normalized === null) throw new TypeError('color 必须是 #rrggbb 形式')
  return normalized
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 不能为空`)
  return value.trim()
}

/**
 * 为原生 Remote 请求补充“聚合尚未确认”的临时 ID 解析。
 *
 * session/create 返回后，客户端会马上打开 session/follow；此时 Host 侧聚合
 * Registry 可能还没有新会话，但请求 scope 已经携带了真实 sessionId。只允许
 * 解析与当前目标 Host、工作区和会话 scope 完全匹配的虚拟 ID，避免把任意旧 ID
 * 当成可路由资源。
 */
export function createScopedNativeIdResolver(registry: VirtualWorkspaceRegistry, scope: HostScope): VirtualIdResolver {
  const workspacePath = scope.targetHostId === null ? undefined
    : registry.get(createVirtualWorkspaceId(scope.targetHostId, scope.workspaceId))?.path
  return {
    ...(workspacePath === undefined ? {} : { workspacePath }),
    resolveWorkspace(id) {
      const known = registry.resolveWorkspace(id)
      if (known !== null) return known
      if (scope.targetHostId === null) return null
      const parsed = parseVirtualWorkspaceId(id)
      if (parsed === null || parsed.hostId !== scope.targetHostId || parsed.workspaceId !== scope.workspaceId) return null
      return { workspaceId: parsed.workspaceId, targetHostId: scope.targetHostId }
    },
    resolveSession(id) {
      const known = registry.resolveSession(id)
      if (known !== null) return known
      if (scope.targetHostId === null || scope.sessionId === null) return null
      const parsed = parseVirtualSessionId(id)
      if (parsed === null || parsed.hostId !== scope.targetHostId || parsed.sessionId !== scope.sessionId) return null
      return { sessionId: parsed.sessionId, targetHostId: scope.targetHostId }
    },
    resolveWorkspacePath(path) {
      const prefix = 'codingns-peer-host://'
      if (!path.startsWith(prefix) || scope.targetHostId === null) return null
      const encoded = path.slice(prefix.length)
      const separator = encoded.indexOf('/')
      const encodedWorkspaceId = separator < 0 ? encoded : encoded.slice(0, separator)
      let virtualWorkspaceId: string
      try {
        virtualWorkspaceId = decodeURIComponent(encodedWorkspaceId)
      } catch {
        return null
      }
      const parsed = parseVirtualWorkspaceId(virtualWorkspaceId)
      if (parsed === null || parsed.targetHostId !== scope.targetHostId) return null
      const realPath = registry.get(virtualWorkspaceId)?.path
      if (realPath === undefined || separator < 0) return realPath ?? null
      const suffix = encoded.slice(separator)
      return `${realPath.replace(/[\\/]+$/u, '')}/${suffix.replace(/^[/\\]+/u, '')}`
    },
  }
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

/**
 * 用 DSH 原生注册表补齐本地工作区。
 *
 * 本地摘要还在启动、会话服务暂时不可读时，聚合 source 可能只返回远端结果。
 * 顺序 Registry 仍必须知道本地 ID，否则客户端无法把本地项转换成混合顺序中的
 * 虚拟 ID。这里仅补齐排序所需的最小记录，真实会话仍由本机 DSH Store 提供。
 */
export function ensureLocalWorkspaceSummaries(
  results: readonly AggregateHostResult[],
  ctx: CodingNsHostServices['dshContext'],
): readonly AggregateHostResult[] {
  if (ctx === undefined) return results
  const local = results.find((host) => host.targetHostId === null)
  if (local === undefined) return results
  let registry: unknown
  try { registry = ctx.get('workspaceRegistry') } catch { return results }
  if (!isRecordValue(registry) || typeof registry.list !== 'function') return results
  let raw: readonly unknown[]
  try {
    const listed = registry.list()
    raw = Array.isArray(listed) ? listed : []
  } catch {
    return results
  }
  const known = new Set(local.workspaces.map((workspace) => workspace.workspaceId))
  const missing = raw.flatMap((item) => {
    if (!isRecordValue(item)) return []
    const workspaceId = textValue(item.id) ?? textValue(item.workspaceId) ?? textValue(item.key)
    if (workspaceId === undefined || known.has(workspaceId)) return []
    const path = textValue(item.path) ?? textValue(item.cwd) ?? workspaceId
    return [{
      key: `${local.hostId}:${workspaceId}`,
      hostId: local.hostId,
      targetHostId: null,
      workspaceId,
      displayName: textValue(item.displayName) ?? textValue(item.title) ?? textValue(item.name) ?? workspaceId,
      path,
      hostLabel: local.hostLabel,
      availability: 'ready' as const,
      sessions: [],
    }]
  })
  if (missing.length === 0) return results
  return results.map((host) => host.targetHostId === null
    ? { ...host, workspaces: [...host.workspaces, ...missing] }
    : host)
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 将初始化竞态期间原生列表传来的本地裸 ID解析为顺序 Registry 的虚拟 ID。 */
function resolveWorkspaceOrderId(value: string, registry: VirtualWorkspaceRegistry, localHostId: string): string {
  if (parseVirtualWorkspaceId(value) !== null) return value
  const local = registry.list().find((workspace) => workspace.targetHostId === null && workspace.workspaceId === value)
  if (local !== undefined) return local.virtualWorkspaceId
  // 启动竞态下 Registry 可能还没有完成首轮 aggregate；本地 Host ID 是稳定的，
  // 先生成同一格式的虚拟 ID并写入墓碑顺序，后续 aggregate 会补齐记录。
  return createVirtualWorkspaceId(localHostId, value)
}

export function toPeerHostClientRecord(record: PeerHostRecord): PeerHostClientRecord {
  return {
    ...record,
    fingerprint: redactFingerprint(record.fingerprint),
    // 局域网地址用于编辑窗口默认回填；PeerHostStore 已保证它是无凭据的 HTTP(S) Origin。
    route: record.route.kind === 'lan' ? { kind: 'lan', baseUrl: record.route.baseUrl } : { kind: 'relay' },
  }
}

function redactFingerprint(value: string | null): string | null {
  if (value === null || value.length <= 12) return value
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}
