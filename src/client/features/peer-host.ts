import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientFeatureModule, FeaturePanelProps } from './types.js'
import { startPeerHostManagementPanel } from '../peer-host-management-panel.js'
import { createPeerHostManagementApi } from '../peer-host-management-api.js'
import { DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL, readDshPeerHostPrebootShimMode, readDshPeerHostPrebootShimState } from '../../bootstrap/dsh-peer-host-preboot-shim.js'
import type { CodingNsTransportHooks } from '../../shared/contracts/transport.js'
import { dshSettingsNoteStyle, dshThemeColor } from '../theme.js'
import type { AggregateHostResult, HostScope } from '../../shared/contracts/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId, parseVirtualSessionId, parseVirtualWorkspaceId } from '../../shared/index.js'
import { decodeNativeResponseBytes, isDshNativeRemoteMethod } from '../../host/modules/peer-host/peer-host-native-protocol.js'
import { createPeerHostNativeProjection, type PeerHostNativeProjection } from '../peer-host-native-projection.js'
import { installPeerHostNativeStoreProjection, refreshPeerHostNativeSessions } from '../peer-host-native-store-projection.js'
import { startPeerHostWorkspaceTag } from '../peer-host-workspace-tag.js'
import { startPeerHostWorkspaceTab } from '../peer-host-workspace-tab.js'
import { isPeerHostAggregateRefreshRegistered, registerPeerHostAggregateRefresh, requestPeerHostAggregateRefresh } from '../peer-host-aggregate-refresh.js'
import { resolveCodingNsTranslator, useCodingNsTranslator, type CodingNsLocale } from '../locale.js'
import { publishSessionAdapter } from '../session-adapter-cache.js'
import { startSerialPolling } from '../serial-polling.js'
import { PeerHostRemoteEvents } from '../peer-host-remote-events.js'
import { installPeerHostFileLinkRouting } from '../peer-host-file-links.js'

/** 聚合刷新周期；远端资源只影响自身节点，刷新失败不改变本机界面。 */
const PEER_HOST_AGGREGATE_REFRESH_MS = 30_000
/** 新建会话尚未出现在聚合摘要时，临时保留其远端作用域的最长时间。 */
const PEER_HOST_PENDING_SESSION_SCOPE_TTL_MS = 30_000
/** 远端会话流刷新聚合的合并窗口，避免每个文本增量都触发完整摘要读取。 */
const PEER_HOST_SESSION_REFRESH_DEBOUNCE_MS = 200

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
      label: 'Manage other DSH Hosts',
      labelKey: 'feature.peerHost.label',
      description: 'Aggregate sessions from multiple Hosts',
      descriptionKey: 'feature.peerHost.description',
      order: 50,
      defaultOpen: false,
    },
  },
  start: (context) => {
    const shim = (globalThis as typeof globalThis & { [DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]?: { activate: (transport?: CodingNsTransportHooks) => string; deactivate: () => string; getMode?: () => string } })[DSH_PEER_HOST_PREBOOT_SHIM_GLOBAL]
    const projection = createPeerHostNativeProjection()
    const transport = shim === undefined ? undefined : createPeerHostPageTransport(projection, context.services.uiContext, context.services.locale)
    const management = createPeerHostManagementApi(context.services.rpc)
    if (shim !== undefined) {
      shim.activate(transport!.hooks)
      context.resources.add(() => {
        transport!.dispose()
        shim.deactivate()
        // 资源按逆序释放：此时 Desktop 路由和导航订阅已还原，重新加载本机目录，
        // 避免停用 PeerHost 后仍展示最后一个远端 Host 的全局缓存。
        refreshDshModelCatalog(context.services.uiContext)
        reconnectNativeEvents(context.services.uiContext)
      })
      // 原生侧栏在插件 apply 时按引用捕获 `workspaces.list`，只能就地投影这个对象；
      // 没有 shim 就没有原生 Remote 路由，此时不注入，避免出现点不开的远端条目。
      context.resources.add(installPeerHostNativeStoreProjection({
        uiContext: context.services.uiContext,
        projection,
        moveWorkspace: (workspaceId, beforeWorkspaceId) => management.moveWorkspace(workspaceId, beforeWorkspaceId),
        refreshWorkspaceOrder: async () => {
          // 原生侧栏可能在首次聚合完成前就收到远端 Workspace；拖拽入口此时
          // 先补一次聚合和顺序快照，再继续原操作，避免把虚拟 ID误判成未知项。
          const aggregate = await management.aggregate()
          const order = await management.workspaceOrder()
          transport!.setAggregate(aggregate, order.orderedWorkspaceIds)
          return order.orderedWorkspaceIds
        },
      }))
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
          mergeEvents: transport!.mergeEvents,
          decorateLocalResult: (method, result) => method === 'session/list' ? mergeSessionListResult(result, projection) : result,
        })
        if (route !== undefined) context.resources.add(route)
      }
      // uiWorkspace 可能晚于 CodingNS 就绪；跟随服务生命周期订阅真实选择状态。
      // 模块请求、右栏保留资源和后台流都不能代替前台导航。
      const navigation = context.services.uiContext?.inject(['uiWorkspace'], (scope) => {
        scope.effect(() => transport!.watchNavigation(), 'codingns4dsh: PeerHost model catalog navigation')
      })
      if (navigation !== undefined) context.resources.add(() => navigation.dispose())
      // 文件路径的平台取自资源所属会话，不能由本机平台或前台选择决定。
      const fileLinks = context.services.uiContext?.inject(['sidebarRight'], (scope) => {
        scope.effect(() => installPeerHostFileLinkRouting(scope, (sessionId) => (
          projection.sessions().find((session) => session.sessionId === sessionId)?.cwd
        )) ?? (() => undefined), 'codingns4dsh: PeerHost file links')
      })
      if (fileLinks !== undefined) context.resources.add(() => fileLinks.dispose())
      // 原生 $events 通常早于插件启动；切换一次客户端连接代次，让已打开的流使用聚合入口。
      reconnectNativeEvents(context.services.uiContext)
    }
    const panel = startPeerHostManagementPanel({ rpc: context.services.rpc, locale: context.services.locale })
    context.resources.add(() => panel.dispose())
    // 工作区标签：远端工作区不再把 Host 名写进标题文本，改由彩色标签表达归属。
    const tag = startPeerHostWorkspaceTag()
    context.resources.add(() => tag.dispose())
    // 原生"添加工作区"对话框保持主体不变，只额外挂一个"远程 HOST"标签页。
    const workspaceTab = startPeerHostWorkspaceTab({
      api: management,
      onWorkspaceAdded: () => polling.refresh({ afterPending: true }),
      onWorkspaceRemoved: () => polling.refresh({ afterPending: true }),
      locale: context.services.locale,
    })
    context.resources.add(() => workspaceTab.dispose())
    // 虚拟会话必须进入原生 SessionManager 目录（否则 sessions.retain 解析失败），
    // 因此聚合变化后触发一次原生列表刷新，由页面 Transport 在 session/list 响应里补齐。
    const refresh = async (signal: AbortSignal): Promise<boolean> => {
      const orderReference = projection.workspaceOrder()
      try {
        const aggregate = await management.aggregate(signal)
        // Host 端先完成 aggregate 再 hydrate 顺序；按同一顺序读取可避免拿到空的初始 order，
        // 同时保持 aggregate 的旧返回形状，旧 Host 不支持该 RPC 时仍回退为追加远端项。
        let orderedWorkspaceIds: readonly string[] | undefined
        try {
          orderedWorkspaceIds = (await management.workspaceOrder(signal)).orderedWorkspaceIds
        } catch {
          orderedWorkspaceIds = undefined
        }
        // 串行刷新合并并发请求；停用或超时后，不允许迟到响应重新写入原生列表。
        signal.throwIfAborted()
        // 聚合读取期间如果用户完成了一次拖拽，保留本地刚确认的顺序；本轮只更新
        // 工作区内容，下一轮再从 Host 读取顺序，避免旧的 order 响应覆盖拖拽结果。
        const refreshedOrder = projection.workspaceOrder() === orderReference ? orderedWorkspaceIds : undefined
        tag.setAggregate(aggregate)
        if (transport?.setAggregate(aggregate, refreshedOrder) === true) {
          await refreshPeerHostNativeSessions(context.services.uiContext)
        }
        return true
      } catch {
        // 单个 Host 的摘要失败由聚合层降级，不阻断本机原生工作区与会话。
        return false
      }
    }
    // 首次聚合后台执行，慢远端不能挡住后续模块启动；隐藏页面暂停自动刷新。
    const polling = startSerialPolling(refresh, PEER_HOST_AGGREGATE_REFRESH_MS)
    context.resources.add(() => polling.dispose())
    // 归档入口等原生操作完成后可以立刻请求刷新，而不必等待下一个周期。
    context.resources.add(registerPeerHostAggregateRefresh(() => polling.refresh({ afterPending: true })))
  },
  settingsPanel: PeerHostPanel,
}

/** 将 DSH preboot shim 绑定到当前页面的 Host RPC；不调用 Connection.rpc，避免递归。 */
export function createPeerHostPageTransport(
  projection: PeerHostNativeProjection = createPeerHostNativeProjection(),
  uiContext?: { get(name: string): unknown },
  locale?: CodingNsLocale,
): {
  readonly hooks: CodingNsTransportHooks
  readonly matchesScope: (value: unknown, method?: string) => boolean
  readonly setAggregate: (aggregate: readonly AggregateHostResult[], orderedWorkspaceIds?: readonly string[]) => boolean
  /** 跟随原生前台选择刷新 Host 模型目录；返回导航订阅的清理函数。 */
  readonly watchNavigation: () => () => void
  readonly mergeEvents: (local: (signal: AbortSignal) => AsyncIterable<unknown>, signal?: AbortSignal) => AsyncIterable<unknown>
  readonly dispose: () => void
} {
  const t = resolveCodingNsTranslator(locale)
  const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
  const scopes = new Map<string, HostScope>()
  const remoteHostScopes = new Map<string, HostScope>()
  // DSH 的模型目录是 Host generation 级缓存；PeerHost 工作区切换不会触发 DSH
  // 自己的 connection/reset，因此仅按前台导航的 Host 变化使目录失效。
  let activeModelCatalogScopeKey: string | undefined
  const modelCatalogScopeKey = (scope: HostScope | undefined): string | undefined => {
    if (scope?.targetHostId === null || scope?.targetHostId === undefined) return undefined
    return scope.targetHostId
  }
  const refreshModelCatalogForScope = (scope: HostScope | undefined): void => {
    const nextKey = modelCatalogScopeKey(scope)
    if (nextKey === activeModelCatalogScopeKey) return
    activeModelCatalogScopeKey = nextKey
    refreshDshModelCatalog(uiContext)
  }
  let aggregateRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let aggregateRefreshInFlight: Promise<void> | undefined
  let aggregateRefreshQueued = false
  let aggregateRefreshLastStartedAt: number | undefined
  const scheduleAggregateRefresh = (): void => {
    if (!isPeerHostAggregateRefreshRegistered()) return
    aggregateRefreshQueued = true
    if (aggregateRefreshTimer !== undefined || aggregateRefreshInFlight !== undefined) return
    const elapsed = aggregateRefreshLastStartedAt === undefined ? 0 : Date.now() - aggregateRefreshLastStartedAt
    const delay = Math.max(0, PEER_HOST_SESSION_REFRESH_DEBOUNCE_MS - elapsed)
    aggregateRefreshTimer = setTimeout(() => {
      aggregateRefreshTimer = undefined
      if (!aggregateRefreshQueued) return
      aggregateRefreshQueued = false
      if (!isPeerHostAggregateRefreshRegistered()) return
      aggregateRefreshLastStartedAt = Date.now()
      let result: void | Promise<void>
      try {
        result = requestPeerHostAggregateRefresh()
      } catch {
        result = undefined
      }
      if (result === undefined) {
        if (aggregateRefreshQueued) scheduleAggregateRefresh()
        return
      }
      aggregateRefreshInFlight = Promise.resolve(result).catch(() => undefined).finally(() => {
        aggregateRefreshInFlight = undefined
        if (aggregateRefreshQueued) scheduleAggregateRefresh()
      })
    }, delay)
  }
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
    const envelope = await readPageRpcResponse(response)
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
  const scopeForNativeRequest = (method: string, value: unknown): HostScope | undefined => {
    // 问题答案是任意用户内容，只能由正式 agentId 决定目标，不能扫描答案里的字符串。
    if (method === 'userQuestions/answer' || method === 'userQuestions/attachWait') return findScope(questionAgentId(value))
    // 反馈只能由 request.sessionId 决定归属，消息 ID、反馈文字和版本号都不是路由身份。
    if (method.startsWith('messageFeedback/') || method === 'sessionFeedback/record') {
      const input = asRecord(value)
      const request = asRecord(asRecord(input?.args)?.request ?? input?.request)
      return findScope(request?.sessionId)
    }
    const direct = findScope(value)
    if (direct !== undefined) return direct
    return method === 'session/modelCatalog' && !containsResourceId(value) ? navigationScope() : undefined
  }
  const scopeForPluginRequest = (endpoint: string, value: unknown): HostScope | undefined => {
    // 设置页明确选择本机时，不能让无会话的目录查询跟随前台远端工作区。
    if ((endpoint === 'cli/catalog' || endpoint === 'cli/models' || endpoint === 'cli/catalog/refresh')
      && asRecord(value)?.catalogHostId === 'local') return undefined
    if (endpoint.startsWith('fileManagement/')) {
      // 文件内容与路径均不参与路由；显式资源必须属于同一台 Host 的同一工作区。
      const input = asRecord(value)
      const workspace = findScope(input?.workspaceId)
      const session = findScope(input?.sessionId)
      if (hasVirtualResourceScope(value)) {
        if (typeof input?.workspaceId === 'string' && workspace === undefined) return undefined
        if (typeof input?.sessionId === 'string' && session === undefined) return undefined
        if (workspace !== undefined && session !== undefined
          && (workspace.targetHostId !== session.targetHostId || workspace.workspaceId !== session.workspaceId)) return undefined
      }
      return workspace ?? session
    }
    // 调试只按顶层资源选择 Host，配置正文里的字符串不能影响路由。
    if (isDebugPluginEndpoint(endpoint)) {
      const input = asRecord(value)
      return findScope(input?.workspaceId) ?? findScope(input?.sessionId)
    }
    const direct = findScope(value)
    if (direct !== undefined) return direct
    // 显式指定本机 Session 的目录请求保持本机；只有无资源 ID 的工具栏目录
    // 才跟随前台导航，不能被其他会话的 CLI 请求带到错误 Host。
    if ((endpoint !== 'cli/catalog' && endpoint !== 'cli/models') || containsResourceId(value)) return undefined
    return navigationScope()
  }
  const navigationScope = (): HostScope | undefined => {
    const selection = readNativeNavigationStore(uiContext)?.getSnapshot()
    // 空选择和本机选择都是明确的本机状态；Desktop/PWA 的根地址不表达导航，
    // 也不能让旧 URL 覆盖当前会话。新远端会话的 ID 由 pending 作用域补齐。
    if (selection !== undefined) {
      const direct = findScope(selection)
      if (direct !== undefined) return direct
      // 目录属于 Host，不依赖会话是否已进入聚合。pending 到期或摘要暂时缺行时，
      // 虚拟 ID 仍明确携带目标 Host，不能把远端目录静默换成本机目录。
      const selected = asRecord(selection)
      const sessionId = selected?.sessionId ?? asRecord(selected?.subagentAddress)?.parentSessionId
      const session = typeof sessionId === 'string' ? parseVirtualSessionId(sessionId) : null
      const workspace = typeof selected?.workspaceId === 'string' ? parseVirtualWorkspaceId(selected.workspaceId) : null
      const hostId = session?.hostId ?? workspace?.targetHostId
      return hostId === null || hostId === undefined ? undefined : remoteHostScopes.get(hostId)
    }
    // 没有原生导航服务的旧宿主只依据显式工作区 URL；从不猜最近请求属于谁。
    return currentLocationWorkspaceScope()
  }
  const currentLocationWorkspaceScope = (): HostScope | undefined => {
    if (typeof window === 'undefined') return undefined
    const match = window.location.pathname.match(/\/workspaces\/([^/]+)/u)
    if (match?.[1] === undefined) return undefined
    let workspaceId: string
    try { workspaceId = decodeURIComponent(match[1]) } catch { return undefined }
    const parsed = parseVirtualWorkspaceId(workspaceId)
    if (parsed === null || parsed.targetHostId === null) return undefined
    return findScope(parsed.virtualWorkspaceId)
  }
  const containsResourceId = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsResourceId)
    const record = asRecord(value)
    if (record === null) return false
    for (const [key, child] of Object.entries(record)) {
      if ((key === 'workspaceId' || key === 'sessionId' || key === 'parentSessionId') && typeof child === 'string' && child !== '') return true
      if (containsResourceId(child)) return true
    }
    return false
  }
  const rewriteCliPayload = (value: unknown, scope: HostScope, key = ''): unknown => {
    if (typeof value === 'string') {
      const parsed = parseVirtualSessionId(value)
      const isSessionField = key === 'sessionId' || key === 'parentSessionId' || key === 'childSessionId'
      return isSessionField && parsed !== null && parsed.hostId === (scope.targetHostId ?? scope.hostId) ? parsed.sessionId : value
    }
    if (Array.isArray(value)) return value.map((item) => rewriteCliPayload(item, scope, key))
    const record = asRecord(value)
    if (record === null) return value
    return Object.fromEntries(Object.entries(record).map(([childKey, child]) => [childKey, rewriteCliPayload(child, scope, childKey)]))
  }
  const remotePluginRpc = async (scope: HostScope, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (scope.targetHostId === null) throw new Error('PeerHost 插件请求缺少目标 Host')
    const response = asRecord(await codingNsCall('peerHost/request', {
      peerHostId: scope.targetHostId,
      scope,
      path: `/api/codingns/${endpoint}`,
      method: 'POST',
      body: JSON.stringify({ rpcId: createRequestId(), method: endpoint, payload: endpoint.startsWith('git/')
        ? { ...asRecord(payload), workspaceId: scope.workspaceId }
        : endpoint.startsWith('cli/') ? rewriteCliPayload(payload, scope) : rewritePluginResourcePayload(payload, scope) }),
    }, signal))
    const status = typeof response?.status === 'number' ? response.status : 500
    const body = typeof response?.body === 'string' ? response.body : ''
    if (status < 200 || status >= 300) {
      // Host 代理已经生成脱敏的稳定错误，不能再用裸 HTTP 状态掩盖认证原因。
      let error: Record<string, unknown> | null = null
      try { error = asRecord(asRecord(JSON.parse(body))?.error) } catch { /* 非 JSON 响应继续使用状态码兜底。 */ }
      if (typeof error?.code === 'string' && typeof error.message === 'string') {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
      throw new Error(`远端 Host 插件 RPC 失败: HTTP ${status}`)
    }
    try {
      const envelope = asRecord(JSON.parse(body))
      // Git 面板及缓存继续持有虚拟 ID，真实 ID 只出现在目标 Host 的请求中。
      return endpoint.startsWith('git/')
        ? projectGitWorkspaceIds(envelope?.result, scope.workspaceId, createVirtualWorkspaceId(scope.targetHostId, scope.workspaceId))
        : envelope?.result
    } catch {
      throw new Error('远端 Host 插件 RPC 响应不是 JSON')
    }
  }
  const mergeRemoteAdapterMap = async (localResult: unknown, signal?: AbortSignal): Promise<unknown> => {
    const localEnvelope = asRecord(localResult)
    if (localEnvelope?.ok !== true || !Array.isArray(localEnvelope.value)) return localResult
    const rows = [...localEnvelope.value]
    for (const [targetHostId, scope] of remoteHostScopes) {
      try {
        const remoteEnvelope = asRecord(await remotePluginRpc(scope, 'cli/session/adapter-map', {}, signal))
        if (remoteEnvelope?.ok !== true || !Array.isArray(remoteEnvelope.value)) continue
        for (const raw of remoteEnvelope.value) {
          const row = asRecord(raw)
          const sessionId = typeof row?.sessionId === 'string' ? row.sessionId : ''
          const adapterId = typeof row?.adapterId === 'string' ? row.adapterId : ''
          if (sessionId !== '' && adapterId !== '') rows.push({ sessionId: createVirtualSessionId(targetHostId, sessionId), adapterId })
        }
      } catch {
        // 旧版目标 Host 没有 CLI 映射时保留本机结果，远端会话仍可打开。
      }
    }
    return { ...localEnvelope, value: rows }
  }
  const openRemoteStream = (method: string, payload: unknown, scope: HostScope, signal?: AbortSignal): AsyncIterable<unknown> => (async function* () {
    const opened = asRecord(await codingNsCall('peerHost/nativeStream', { method, payload, scope }, signal))
    const streamId = typeof opened?.streamId === 'string' ? opened.streamId : ''
    if (streamId === '') throw new Error('PeerHost 原生 Remote 未返回 streamId')
    try {
      while (!(signal?.aborted ?? false)) {
        const next = asRecord(await codingNsCall('peerHost/nativeStreamNext', { streamId, scope }, signal))
        if (next?.done === true) return
        yield decodeNativeResponseBytes(next?.value)
      }
      signal?.throwIfAborted()
    } finally {
      await codingNsCall('peerHost/nativeStreamClose', { streamId, scope }, AbortSignal.timeout(5_000)).catch(() => undefined)
    }
  })()
  const events = new PeerHostRemoteEvents({
    open: (scope, signal) => openRemoteStream('$events', { args: {} }, scope, signal),
    reply: (scope, payload, signal) => codingNsCall('peerHost/native', { method: '$events/result', payload, scope }, signal),
    accepts: (agentId, scope) => scopes.get(agentId)?.targetHostId === scope.targetHostId,
    prepare: () => refreshPeerHostNativeSessions(uiContext as Parameters<typeof refreshPeerHostNativeSessions>[0]),
  })
  /**
   * 记录刚在远端新建的会话作用域。
   *
   * 新会话要等下一轮聚合刷新才会进入投影，但 DSH 在 `session/create` 返回后立刻
   * 用同一个虚拟会话 ID 发起 `session/follow`。不在这里登记，作用域查找会落空并
   * 退回本机 Gateway，表现为"会话建好了却打不开"。
   */
  interface PendingSessionScope {
    readonly scope: HostScope
    readonly expiresAt: number
    readonly timer: ReturnType<typeof setTimeout>
  }
  const pendingSessionScopes = new Map<string, PendingSessionScope>()
  const forgetPendingSession = (sessionId: string): PendingSessionScope | undefined => {
    const pending = pendingSessionScopes.get(sessionId)
    if (pending === undefined) return undefined
    clearTimeout(pending.timer)
    pendingSessionScopes.delete(sessionId)
    return pending
  }
  const rememberCreatedSession = (scope: HostScope, value: unknown): void => {
    const sessionId = asRecord(value)?.sessionId
    if (typeof sessionId !== 'string') return
    const parsed = parseVirtualSessionId(sessionId)
    if (parsed === null) return
    // 只接受目标 Host 自己编码回来的虚拟 ID，避免把别的 Host 的会话挂到当前作用域。
    if (parsed.hostId !== (scope.targetHostId ?? scope.hostId)) return
    const created: HostScope = { ...scope, sessionId: parsed.sessionId }
    const expiresAt = Date.now() + PEER_HOST_PENDING_SESSION_SCOPE_TTL_MS
    const previous = forgetPendingSession(sessionId)
    if (previous !== undefined && scopes.get(sessionId) === previous.scope) scopes.delete(sessionId)
    const timer = setTimeout(() => {
      const pending = pendingSessionScopes.get(sessionId)
      if (pending === undefined || pending.expiresAt !== expiresAt) return
      pendingSessionScopes.delete(sessionId)
      // 聚合确认后 scopes 会持有新的对象；只清理仍由 pending 持有的旧作用域。
      if (scopes.get(sessionId) === pending.scope) scopes.delete(sessionId)
      refreshModelCatalogForScope(navigationScope())
    }, PEER_HOST_PENDING_SESSION_SCOPE_TTL_MS)
    // Node 测试进程不应因一个未确认的远端会话被定时器阻塞退出；浏览器没有 unref 时照常运行。
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
    pendingSessionScopes.set(sessionId, { scope: created, expiresAt, timer })
    scopes.set(sessionId, created)
    refreshModelCatalogForScope(navigationScope())
  }
  /** 父会话目录早于聚合到达时，复用新建会话的临时作用域与清理机制。 */
  const rememberSubagentCatalog = (scope: HostScope, value: unknown): void => {
    const catalog = asRecord(asRecord(asRecord(value)?.projections)?.values)?.subagentCatalog
    if (!Array.isArray(catalog)) return
    for (const child of catalog) {
      const id = asRecord(child)?.id
      if (typeof id === 'string' && !scopes.has(id)) rememberCreatedSession(scope, { sessionId: id })
    }
  }
  const hooks: CodingNsTransportHooks = {
    rpc: async <TResponse = unknown>({ method, payload, signal }: { method: string; payload: unknown; signal?: AbortSignal }): Promise<TResponse> => {
      const value = asRecord(payload)
      const channel = typeof value?.channel === 'string' ? value.channel : '/codingns'
      const body = value?.payload
      if (channel === '/api' && method === '$events/result' && events.ownsResult(body)) {
        try {
          return { ok: true, value: await events.reply(body, signal) } as TResponse
        } catch (error) {
          const code = (error as { code?: unknown }).code
          return { ok: false, error: { code: typeof code === 'string' ? code : 'gateway/internal', message: error instanceof Error ? error.message : String(error) } } as TResponse
        }
      }
      const endpoint = peerHostPluginEndpoint(channel, method)
      if (endpoint === 'cli/session/adapter-map') {
        return await mergeRemoteAdapterMap(await request(channel, method, body, signal), signal) as TResponse
      }
      if (endpoint !== undefined) {
        if (endpoint.startsWith('fileManagement/') && hasVirtualResourceScope(body) && scopeForPluginRequest(endpoint, body) === undefined) {
          return { ok: false, error: { code: 'PEER_HOST_SCOPE_MISMATCH', message: t('peerHost.fileWorkspaceUnavailable') } } as TResponse
        }
        if (isDebugPluginEndpoint(endpoint) && hasVirtualResourceScope(body) && scopeForPluginRequest(endpoint, body) === undefined) {
          return { ok: false, error: { code: 'PEER_HOST_SCOPE_MISMATCH', message: t('peerHost.debugWorkspaceUnavailable') } } as TResponse
        }
        // Git 只由顶层 workspaceId 决定归属，文件名和提交正文不能参与 Host 选择。
        const workspaceId = asRecord(body)?.workspaceId
        const scope = endpoint.startsWith('git/') ? findScope(workspaceId) : scopeForPluginRequest(endpoint, body)
        if (endpoint.startsWith('git/') && typeof workspaceId === 'string' && parseVirtualWorkspaceId(workspaceId) !== null && scope === undefined) {
          return { ok: false, error: { code: 'PEER_HOST_SCOPE_MISMATCH', message: t('peerHost.gitWorkspaceUnavailable') } } as TResponse
        }
        if (scope !== undefined && scope.targetHostId !== null) {
          try {
            return await remotePluginRpc(scope, endpoint, body, signal) as TResponse
          } catch (error) {
            return { ok: false, error: { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error) } } as TResponse
          }
        }
      }
      if (channel === '/api' && isDshNativeRemoteMethod(method)) {
        const scope = scopeForNativeRequest(method, body)
        if (scope === undefined && hasVirtualQuestionAgent(method, body)) {
          return { ok: false, error: { code: 'PEER_HOST_SCOPE_MISMATCH', message: t('peerHost.questionSessionUnavailable') } } as TResponse
        }
        if (scope !== undefined && scope.targetHostId !== null) {
          // DSH 的 client 契约要求 unary 结果是 `{ok, value}` / `{ok:false, error}` 信封：
          // 返回裸值会让网关在 `rebuiltFailure(result.error)` 读 undefined.code 而崩成 carrierFailure。
          try {
            const created = decodeNativeResponseBytes(await codingNsCall('peerHost/native', { method, payload: body, scope }, signal))
            if (method === 'session/create' || method === 'session/fork') {
              rememberCreatedSession(scope, created)
              // 侧栏按聚合摘要里的 workspace.sessionIds 归组，新会话只有在刷新后的摘要里
              // 才会挂到远端工作区。不立刻刷新，它会先落在"未分组/本机默认工作区"，
              // 看起来像新建到了本机。刷新失败不影响创建结果。
              void Promise.resolve(requestPeerHostAggregateRefresh()).catch(() => undefined)
            }
            return { ok: true, value: created } as TResponse
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
      if (channel === '/api' && method === '$events') {
        return events.open(localSignal => openDshGatewayStream(method, body, localSignal), signal) as AsyncIterable<TChunk>
      }
      if (channel === '/api' && isDshNativeRemoteMethod(method)) {
        const scope = scopeForNativeRequest(method, body)
        if (scope === undefined && hasVirtualQuestionAgent(method, body)) throw new Error('远端问题所属会话不可用，请重新连接')
        if (scope !== undefined && scope.targetHostId !== null) {
          const stream = openRemoteStream(method, body, scope, signal) as AsyncIterable<TChunk>
          if (method !== 'session/follow') return stream
          // session/follow 承载远端新建、续接过程中的实时事件。聚合摘要本身仍按轮询
          // 读取，但由这里把事件转成合并刷新，侧栏无需切换到别的会话才能更新状态。
          return (async function* (): AsyncIterable<TChunk> {
            let emitted = false
            try {
              for await (const chunk of stream) {
                emitted = true
                // 父会话先公布子会话目录，聚合稍后才补基线。立即登记已验证的虚拟 ID，
                // 避免用户在这段窗口打开子会话时把 CLI 配置读到本机并缓存成 dsh。
                rememberSubagentCatalog(scope, chunk)
                scheduleAggregateRefresh()
                yield chunk
              }
            } finally {
              // 某些实现只在回合结束时写入 updatedAt/status，流结束也必须补一次刷新。
              if (!emitted) scheduleAggregateRefresh()
            }
          })()
        }
      }
      // 其余本机流必须回到 DSH Gateway：本地 baseline 不能
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
    mergeEvents: (local, signal) => events.open(local, signal),
    dispose() {
      events.dispose()
      if (aggregateRefreshTimer !== undefined) clearTimeout(aggregateRefreshTimer)
      for (const sessionId of pendingSessionScopes.keys()) forgetPendingSession(sessionId)
    },
    /** 该请求是否落在某个远端 Host 的作用域内；Desktop 连接路由用它决定是否分流。 */
    matchesScope(value: unknown, method?: string): boolean {
      if (method === '$events/result') return events.ownsResult(value)
      if (hasVirtualQuestionAgent(method ?? '', value)) return true
      const endpoint = method?.replace(/^codingns\//u, '') ?? ''
      if (endpoint.startsWith('fileManagement/')) {
        const scope = scopeForPluginRequest(endpoint, value)
        return scope === undefined ? hasVirtualResourceScope(value) : scope.targetHostId !== null
      }
      if (isDebugPluginEndpoint(endpoint)) {
        const scope = scopeForPluginRequest(endpoint, value)
        // 聚合暂时缺失时仍接管虚拟资源，返回明确错误，禁止回落本机调试服务。
        return scope === undefined ? hasVirtualResourceScope(value) : scope.targetHostId !== null
      }
      if (method?.startsWith('git/') || method?.startsWith('codingns/git/')) {
        const workspaceId = asRecord(value)?.workspaceId
        // 聚合断线后也要接管虚拟 ID，交给上面的明确错误，不能落回本机 Git。
        return typeof workspaceId === 'string' && parseVirtualWorkspaceId(workspaceId) !== null
      }
      const cli = method === undefined
        ? undefined
        : method === 'cli/catalog' || method === 'cli/models'
          ? method
          : method.startsWith('codingns/cli/') ? method.slice('codingns/'.length) : undefined
      const scope = cli === undefined
        ? scopeForNativeRequest(method ?? '', value)
        : scopeForPluginRequest(cli, value)
      return scope !== undefined && scope.targetHostId !== null
    },
    watchNavigation() {
      const store = readNativeNavigationStore(uiContext)
      const refresh = (): void => refreshModelCatalogForScope(navigationScope())
      const stop = store?.subscribe(refresh)
      refresh()
      return stop ?? (() => undefined)
    },
    setAggregate(aggregate, orderedWorkspaceIds) {
      scopes.clear()
      remoteHostScopes.clear()
      for (const host of aggregate) {
        if (host.targetHostId !== null) {
          remoteHostScopes.set(host.targetHostId, { hostId: host.hostId, targetHostId: host.targetHostId, workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 })
        }
        for (const workspace of host.workspaces) {
          const virtualHostId = host.targetHostId ?? host.hostId
          const virtualWorkspaceId = createVirtualWorkspaceId(virtualHostId, workspace.workspaceId)
          const workspaceScope: HostScope = { hostId: host.hostId, targetHostId: host.targetHostId, workspaceId: workspace.workspaceId, sessionId: null, scopeGeneration: 0 }
          scopes.set(virtualWorkspaceId, workspaceScope)
          // 归档会话也要能解析作用域：取消归档请求按虚拟会话 ID 路由到目标 Host。
          for (const session of [...workspace.sessions, ...(workspace.archivedSessions ?? []), ...(workspace.subagentSessions ?? [])]) {
            if (session.scope.sessionId === null) continue
            scopes.set(createVirtualSessionId(virtualHostId, session.scope.sessionId), { ...workspaceScope, sessionId: session.scope.sessionId })
          }
        }
      }
      // 刚创建、尚未进入聚合的会话要保住作用域；聚合里已存在的以聚合为准。
      // 一旦聚合确认，pending 记录立即清掉；之后远端删除会随下一次聚合重建自然移除。
      const now = Date.now()
      for (const [sessionId, pending] of [...pendingSessionScopes]) {
        if (scopes.has(sessionId)) {
          forgetPendingSession(sessionId)
          continue
        }
        if (pending.expiresAt <= now) {
          forgetPendingSession(sessionId)
          continue
        }
        scopes.set(sessionId, pending.scope)
      }
      refreshModelCatalogForScope(navigationScope())
      const changed = projection.setAggregate(aggregate, orderedWorkspaceIds)
      const readyHosts = new Set(aggregate.filter(host => host.availability === 'ready' && host.workspaces.length > 0).map(host => host.targetHostId))
      events.setPeers([...remoteHostScopes.values()].filter(scope => readyHosts.has(scope.targetHostId)))
      return changed
    },
  }
}

/** 两种 Connection 通道共用插件白名单，避免页面 Transport 与原生连接分流不一致。 */
function peerHostPluginEndpoint(channel: string, method: string): string | undefined {
  const endpoint = channel === '/codingns' ? method
    : channel === '/api' && method.startsWith('codingns/') ? method.slice('codingns/'.length) : ''
  return endpoint.startsWith('cli/') || endpoint.startsWith('git/') || endpoint.startsWith('debug/') || endpoint.startsWith('fileManagement/') || endpoint === 'terminal/status' ? endpoint : undefined
}

function questionAgentId(value: unknown): unknown {
  const input = asRecord(value)
  return asRecord(input?.args)?.agentId ?? input?.agentId
}

function hasVirtualQuestionAgent(method: string, value: unknown): boolean {
  if (method !== 'userQuestions/answer' && method !== 'userQuestions/attachWait') return false
  const id = questionAgentId(value)
  return typeof id === 'string' && parseVirtualSessionId(id) !== null
}

function isDebugPluginEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('debug/') || endpoint === 'terminal/status'
}

function hasVirtualResourceScope(value: unknown): boolean {
  const input = asRecord(value)
  return (typeof input?.workspaceId === 'string' && parseVirtualWorkspaceId(input.workspaceId) !== null)
    || (typeof input?.sessionId === 'string' && parseVirtualSessionId(input.sessionId) !== null)
}

/** 只投影响应中的工作区标识；Diff、提交正文和文件路径均保持原文。 */
function projectGitWorkspaceIds(value: unknown, workspaceId: string, virtualWorkspaceId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => projectGitWorkspaceIds(item, workspaceId, virtualWorkspaceId))
  const record = asRecord(value)
  if (record === null) return value
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    key === 'workspaceId' && child === workspaceId ? virtualWorkspaceId : projectGitWorkspaceIds(child, workspaceId, virtualWorkspaceId),
  ]))
}

/** 只还原调试与文件请求的顶层资源标识，配置、文件正文和路径必须原样保存。 */
function rewritePluginResourcePayload(value: unknown, scope: HostScope): unknown {
  const input = asRecord(value)
  if (input === null) return value
  const result = { ...input }
  const workspace = typeof input.workspaceId === 'string' ? parseVirtualWorkspaceId(input.workspaceId) : null
  if (workspace !== null) {
    if (workspace.hostId !== scope.targetHostId || workspace.workspaceId !== scope.workspaceId) throw new Error('请求的 Workspace 与目标 Host 作用域不一致')
    result.workspaceId = workspace.workspaceId
  }
  for (const key of ['sessionId', 'dshSessionId']) {
    const session = typeof input[key] === 'string' ? parseVirtualSessionId(input[key]) : null
    if (session === null) continue
    if (session.hostId !== scope.targetHostId) throw new Error('请求的 Session 与目标 Host 作用域不一致')
    result[key] = session.sessionId
  }
  return result
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
  readonly matchesScope: (value: unknown, method?: string) => boolean
  readonly decorateLocalResult?: (method: string, result: unknown) => unknown
  readonly mergeEvents?: (local: (signal: AbortSignal) => AsyncIterable<unknown>, signal?: AbortSignal) => AsyncIterable<unknown>
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
    && options.matchesScope(payload, endpoint)
  const isPeerPlugin = (channel: string, endpoint: string, payload: unknown): boolean => {
    const pluginEndpoint = peerHostPluginEndpoint(channel, endpoint)
    return pluginEndpoint !== undefined && (pluginEndpoint === 'cli/session/adapter-map' || options.matchesScope(payload, endpoint))
  }

  rpc.call = async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (isPeerScoped(channel, endpoint, payload) || isPeerPlugin(channel, endpoint, payload)) {
      return await options.hooks.rpc!({ method: endpoint, payload: { channel, payload }, ...(signal === undefined ? {} : { signal }) })
    }
    const result = await originalCall.call(rpc, channel, endpoint, payload, signal)
    return options.decorateLocalResult === undefined ? result : options.decorateLocalResult(endpoint, result)
  }
  // 聚合流在 `openRemoteStream` 层拦截：本机流原样落回 DSH 自己的实现（原生
  // RemoteStreamMuxClient），因此 uplink 与重连行为都不受影响；也不要动
  // `connection.rpc.open`，否则网关会认为本页自带流通道而不再启动/重连 mux。
  const patchedOpenRemoteStream = (endpoint: string, payload: unknown, signal?: AbortSignal, uplink?: AsyncIterable<unknown>, noConnection?: string): unknown => {
    if (endpoint === '$events' && options.mergeEvents !== undefined) {
      return options.mergeEvents(localSignal => originalCallRemote.call(remote, endpoint, payload, localSignal, uplink, noConnection) as AsyncIterable<unknown>, signal)
    }
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

/** 只更新浏览器内的事件订阅代次，不重启 Host 或任何运行实例。 */
function reconnectNativeEvents(uiContext: { get(name: string): unknown } | undefined): void {
  try {
    const connection = uiContext?.get('connection') as { reconnect?: () => void } | undefined
    connection?.reconnect?.()
  } catch { /* 原生连接尚未挂载时，首次连接会直接使用新的入口。 */ }
}

/** DSH 前台选择 Store；rc.2 和 alpha.1 都通过它持久化当前会话。 */
interface NativeNavigationStore {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** 只借用原生导航数据，不修改选择策略，也不从后台保留会话推断前台。 */
function readNativeNavigationStore(uiContext: { get(name: string): unknown } | undefined): NativeNavigationStore | undefined {
  try {
    const service = asRecord(uiContext?.get('uiWorkspace'))
    const store = asRecord(service?.selection)
    if (typeof store?.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return undefined
    return store as unknown as NativeNavigationStore
  } catch {
    // 服务尚未挂载时由注入生命周期稍后订阅；无此服务的宿主退回显式 URL。
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
  for (const session of virtual) {
    if (session.adapterId !== undefined) publishSessionAdapter(session.sessionId, session.adapterId)
  }
  const items = [...value.items, ...virtual.filter((session) => !known.has(session.sessionId))]
  return { ...envelope, value: { ...value, items } }
}

function createRequestId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * 解析页面 DSH Gateway 的 JSON 或 multipart 响应。
 *
 * `workspaceFiles/readBytes` 等 Remote 会把 Uint8Array 放到 multipart 附件里；
 * 页面 Transport 不能直接调用 `response.json()`，否则 multipart 的 `--` 边界会被
 * JSON 解析器当成负数开头，产生误导性的“No number after minus sign”错误。
 */
async function readPageRpcResponse(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'multipart/form-data') return await response.json() as Record<string, unknown>

  const fields = new Map<string, FormDataEntryValue>()
  for (const [name, value] of (await response.formData()).entries()) {
    if (fields.has(name)) throw new TypeError('connection: invalid binary response fields')
    fields.set(name, value)
  }
  const metadata = fields.get('metadata')
  if (typeof metadata !== 'string') throw new TypeError('connection: invalid binary response fields')
  const envelope = asRecord(JSON.parse(metadata))
  const result = asRecord(envelope?.result)
  if (envelope === null || result === null) throw new TypeError('connection: invalid server-response envelope')
  fields.delete('metadata')
  if (result.ok !== true) {
    if (fields.size !== 0) throw new TypeError('connection: invalid binary response fields')
    return envelope
  }
  const attachments = envelope.attachments
  if (!Array.isArray(attachments) || attachments.length === 0) throw new TypeError('connection: invalid binary response result')
  const root = { value: result.value }
  for (const rawAttachment of attachments) {
    const attachment = asRecord(rawAttachment)
    const path = attachment?.path
    const part = attachment?.part
    if (attachment?.codec !== 'bytes' || typeof part !== 'string' || !Array.isArray(path)) {
      throw new TypeError('connection: invalid binary response attachment')
    }
    const data = fields.get(part)
    if (!(data instanceof Blob)) throw new TypeError('connection: invalid binary response fields')
    let parent: object = root
    let key: string | number = 'value'
    for (const segment of path) {
      const value = Reflect.get(parent, key)
      if (typeof value !== 'object' || value === null) throw new TypeError('connection: invalid binary response path')
      if (Array.isArray(value)) {
        if (typeof segment !== 'number' || !Number.isSafeInteger(segment) || segment < 0 || segment >= value.length) {
          throw new TypeError('connection: invalid binary response path')
        }
      } else if (typeof segment !== 'string') {
        throw new TypeError('connection: invalid binary response path')
      }
      if (!Object.hasOwn(value, segment)) throw new TypeError('connection: invalid binary response path')
      parent = value
      key = segment
    }
    if (Reflect.get(parent, key) !== null) throw new TypeError('connection: invalid binary response placeholder')
    Object.defineProperty(parent, key, {
      value: new Uint8Array(await data.arrayBuffer()),
      enumerable: true,
      writable: true,
      configurable: true,
    })
    fields.delete(part)
  }
  if (fields.size !== 0) throw new TypeError('connection: invalid binary response fields')
  return { ...envelope, result: { ...result, value: root.value } }
}

/**
 * 让 DSH 原生模型目录丢弃上一工作区的缓存并立即读取新作用域。
 *
 * `modelDirectories.catalog` 在 DSH 类型中是内部字段，这里只做运行时结构探测，
 * 这样旧版 DSH 或 Desktop 没有该服务时仍保持原有路由行为。
 */
function refreshDshModelCatalog(uiContext: { get(name: string): unknown } | undefined): void {
  if (uiContext === undefined) return
  try {
    const service = asRecord(uiContext.get('modelDirectories'))
    const catalog = service === null ? null : asRecord(service.catalog)
    if (catalog === null) return
    const resetGeneration = catalog.resetGeneration
    const refresh = catalog.refresh
    if (typeof resetGeneration === 'function') {
      resetGeneration.call(catalog)
      return
    }
    if (typeof refresh === 'function') refresh.call(catalog)
  } catch {
    // 模型选择插件未挂载或 DSH 版本没有该内部服务时，不影响远程请求本身。
  }
}

/** 打开当前页面 DSH Gateway 的单个 Remote 流；协议与 dsh-api-gateway 保持一致。 */
function openDshGatewayStream<TChunk>(endpoint: string, payload: unknown, signal?: AbortSignal): AsyncIterable<TChunk> {
  const streamId = `codingns_${Date.now()}_${Math.random().toString(36).slice(2)}`
  return (async function* () {
    signal?.throwIfAborted()
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
    const onAbort = (): void => { failure = signal?.reason instanceof Error ? signal.reason : new Error('DSH Remote stream 已取消'); notify(); socket.close(1000, 'stream aborted') }
    const onClose = (): void => { if (!ended) failure ??= new Error('DSH Remote stream WebSocket 已关闭'); notify() }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          socket.removeEventListener('open', opened)
          socket.removeEventListener('error', failed)
          socket.removeEventListener('close', failed)
          signal?.removeEventListener('abort', failed)
        }
        const opened = (): void => { cleanup(); resolve() }
        const failed = (): void => { cleanup(); reject(failure ?? new Error('DSH Remote stream WebSocket 打开失败')) }
        socket.addEventListener('open', opened, { once: true })
        socket.addEventListener('error', failed, { once: true })
        socket.addEventListener('close', failed, { once: true })
        signal?.addEventListener('abort', failed, { once: true })
        if (signal?.aborted) failed()
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
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
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
function PeerHostPanel({ services, enabled }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  // shim 状态在启用变化后可能改变（刚激活为 active），每次渲染都重读全局。
  const state = readDshPeerHostPrebootShimState()
  const mode = readDshPeerHostPrebootShimMode()
  const desktop = mode === 'desktop' || isDesktopTopologyPage()
  const structural = state === 'external' || state === 'not-installed'
  const message = state === 'external'
    ? t('peerHost.stateExternal')
    : state === 'not-installed'
      ? desktop
        ? t('peerHost.stateNotInstalledDesktop')
        : t('peerHost.stateNotInstalledWeb')
      : state === 'requires-reload'
        ? t('peerHost.stateRequiresReload')
        : state === 'active'
          ? t('peerHost.stateActive')
          : t('peerHost.statePending')
  return createElement('div', {
    role: structural ? 'alert' : 'status',
    'aria-disabled': !enabled,
    style: { ...dshSettingsNoteStyle, color: structural ? dshThemeColor.error : dshThemeColor.labelSecondary, opacity: enabled ? 1 : 0.65 },
  }, message)
}
