/**
 * DSH Host 入口。
 *
 * Host 侧能力全部以功能模块形式交给 FeatureRegistry 管理：依赖顺序、启停和
 * 资源释放由注册表负责，设置里的模块开关通过 watch 驱动 reconcile。入口本身
 * 只负责装配，不承载任何具体业务逻辑，因此新增模块不需要修改这个文件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { FeatureRegistry } from '../features/registry.js'
import { captureRestartFeatureStates, enabledFeatureNames, type CodingNsSettings } from '../shared/contracts/config.js'
import { HOST_FEATURES, createHostFeatures } from './features/index.js'
import type { CodingNsHostServices } from './features/types.js'
import { registerCodingNsRpc } from './rpc.js'
import { CodingNsRpcTable } from './rpc-table.js'
import { registerCodingNsSettings } from './settings.js'
import { createCodingNsNativeSessionBridge } from './native-session-bridge.js'
import { installTerminalController } from './terminal/startup.js'
import { DebugWorkspaceService } from './debug.js'
import { detectRuntimeDshVersion, DSH_VERSION_INJECTION_NAME } from './dsh-runtime-version.js'
import { createDshCapabilityRegistry } from '../dsh-capabilities/index.js'
import { debugInfo, debugWarn } from '../shared/debug.js'
import { repairLegacySessionLogs } from './session-migration-repair.js'
import { injectDshWebPwaMetadata, injectDshWebTransportOwnership } from './index-injection.js'
import { applyViewportFitTap } from './modules/pwa/pwa-viewport.js'
import type { DshHostSettingsProvider, DshHostSettingsScope } from '../dsh-capabilities/host/config-forms-adapter.js'
import { DshNativeTeamProxy, type AgentRegistry, type NativeTeamService } from './cli-adapters/native-team-proxy.js'
import { createAgentSubagentTool } from './cli-adapters/subagent-tool.js'
import { registerNativeTeamSubagentProviders, type NativeSubagentService } from './cli-adapters/native-team-subagent.js'
import { setNativeSubagents } from './cli-adapters/native-subagent-holder.js'
import { installSidebarSessionCompat } from '../dsh-capabilities/host/sidebar-session-compat.js'

export function apply(ctx?: Context): void {
  if (ctx === undefined) return
  const dshVersion = detectRuntimeDshVersion()
  debugInfo('codingns4dsh: host apply entered', { dshVersion })

  // 原生侧栏早于本插件 Client 启动；取消误报修复必须在首屏资源下发时生效。
  ctx.inject(['clientModules', 'webServer'], (webCtx) => installSidebarSessionCompat(webCtx, dshVersion))

  // DSH 0.1.7 的官方 v3->v4 迁移器要求每个 tool/call 先有 assistant/message
  // 声明。旧版外部 Agent 曾直接写入 tool/call，必须在任何会话 open 前修复。
  ctx.inject(['sessionPersistence'], async (sessionCtx) => {
    const persistence = sessionCtx.get('sessionPersistence') as unknown
    if (!isRecord(persistence) || typeof persistence.root !== 'string') return
    const open = persistence.open
    if (typeof open !== 'function') return
    let repair: Promise<unknown> | undefined
    const repairBeforeOpen = (): Promise<unknown> => {
      repair ??= repairLegacySessionLogs({
        root: persistence.root as string,
        logger: (message, error) => console.warn('codingns4dsh:', message, error),
      }).catch((error) => {
        console.warn('codingns4dsh: 历史会话扫描失败', error)
        return undefined
      })
      return repair
    }
    // DSH 的 v3->v4 转换发生在 persistence.open 内部。只在启动时异步扫描
    // 会晚于第一次点击历史会话，因此必须把修复挂到真正的读取边界之前。
    try {
      persistence.open = async function (...args: unknown[]): Promise<unknown> {
        await repairBeforeOpen()
        return open.apply(this, args)
      }
    } catch (error) {
      // 某些 Host 会冻结 Service 实例；启动扫描仍然可修复磁盘上的旧日志。
      console.warn('codingns4dsh: 无法包装 sessionPersistence.open', error)
    }
    const report = await repairBeforeOpen()
    debugInfo('codingns4dsh: legacy session repair finished', report)
  })

  ctx.inject(['settings', 'connection', 'webServer'], async (hostCtx) => {
    const settingsContext = hostCtx as Context & { readonly settings: DshHostSettingsProvider }
    debugInfo('codingns4dsh: host inject ready', {
      hasConnection: hostCtx.connection !== undefined,
      hasSettings: settingsContext.settings !== undefined,
      hasWebServer: (hostCtx as Context & { webServer?: unknown }).webServer !== undefined,
    })
    const webServerPort = (hostCtx as Context & { webServer: { port: number } }).webServer.port
    // 仅在 DSH 已提供 Transport 时补充 ownsHost；普通 Web 的 Codingns4DSH
    // 设置由 Client RPC 桥接持久化，不能在这里追加同名全局覆盖 Desktop。
    const indexInjectionEvents = hostCtx as unknown as { on(name: string, listener: (table: unknown[]) => void): unknown }
    // 设置服务在下面才注册；注入回调在每个页面渲染时读取最新值，避免缓存旧开关。
    let indexInjectionSettings: DshHostSettingsScope<CodingNsSettings> | undefined
    // 结构化 `html` 行属于版本相关能力；缺失时 PWA 注入整块跳过（Transport 注入保持原样）。
    let indexInjectionCapabilityReady = false
    debugInfo('codingns4dsh: host index injection registration begin')
    indexInjectionEvents.on('webserver/index-inject', (table) => {
      try {
        injectDshWebTransportOwnership(table)
        table.push({ kind: 'global', name: DSH_VERSION_INJECTION_NAME, value: dshVersion })
        if (indexInjectionSettings !== undefined && indexInjectionCapabilityReady) {
          injectDshWebPwaMetadata(table, indexInjectionSettings.get().lanAccessDsh.pwa)
        }
      } catch (error) {
        // 首页认证不应因插件注入表异常变成 WebServer 的 HTTP 400。
        debugWarn('codingns4dsh: host index injection skipped', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
    debugInfo('codingns4dsh: host index injection registration ready')
    debugInfo('codingns4dsh: host settings registration begin')
    const settings = registerCodingNsSettings(settingsContext)
    indexInjectionSettings = settings
    debugInfo('codingns4dsh: host settings registered')
    const workspaceRoots = new Map<string, string>()
    // controller 必须在功能模块和浏览器 Client 开始消费状态前完成装配。
    // 工厂在本次启动只读取一次开关，设置 watcher 不会热切同名 service。
    const terminal = await installTerminalController(hostCtx, settings, settingsContext.settings, {
      resolveWorkspaceRoot: (workspaceId) => workspaceRoots.get(workspaceId) ?? resolveWorkspaceRoot(hostCtx, workspaceId),
      registerWorkspaceRoot: (workspaceId, cwd) => workspaceRoots.set(workspaceId, cwd),
    })
    debugInfo('codingns4dsh: host terminal controller ready', { mode: terminal.mode })
    const services: CodingNsHostServices = {
      rpc: new CodingNsRpcTable(),
      dshContext: hostCtx,
      dshVersion,
      settings,
      settingsProvider: settingsContext.settings,
      dshWebPort: webServerPort,
      dshWebAuthenticatedUrl: hostCtx.connection.authenticatedUrl(`http://127.0.0.1:${String(webServerPort)}`),
      events: { on: hostCtx.on.bind(hostCtx), emit: hostCtx.emit.bind(hostCtx) },
      nativeSessions: createCodingNsNativeSessionBridge(hostCtx, dshVersion),
      nativeTeam: new DshNativeTeamProxy(
        readOptionalService(hostCtx, 'agentTeams') as NativeTeamService | undefined,
        readOptionalService(hostCtx, 'agents') as AgentRegistry | undefined,
      ),
      terminalProcesses: terminal.processService,
      resolveWorkspaceRoot: (workspaceId) => workspaceRoots.get(workspaceId) ?? resolveWorkspaceRoot(hostCtx, workspaceId),
      listWorkspaceRoots: () => [...workspaceRoots.values(), ...readWorkspaceRoots(hostCtx)],
      registerDebugProxyRoute: (handler) => hostCtx.connection.fetch.register({
        path: '/api/codingns/debug-proxy',
        methods: ['GET', 'HEAD', 'POST'],
        requestBody: 'streaming',
        fetch: handler,
      }),
      registerPeerHostHandshakeRoute: (handler) => hostCtx.connection.fetch.register({
        path: '/api/public/host-handshake',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: handler,
      }),
      registerAssistantVoiceStreamRoute: (handler) => hostCtx.connection.fetch.register({
        path: '/api/codingns/assistant/voice/stream',
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: handler,
      }),
    }
    const debug = new DebugWorkspaceService({
      resolveWorkspaceRoot: (workspaceId) => workspaceRoots.get(workspaceId) ?? resolveWorkspaceRoot(hostCtx, workspaceId),
      terminalProcesses: terminal.processService,
    })
    const servicesWithDebug: CodingNsHostServices = { ...services, debug }
    const capabilityProfile = createDshCapabilityRegistry(dshVersion, 'host', hostCtx).getProfile(hostCtx)
    debugInfo('codingns4dsh: host capabilities resolved', {
      dshVersion,
      capabilities: [...capabilityProfile.capabilities.entries()].map(([capability, resolution]) => ({ capability, status: resolution.status, route: resolution.routeId, reason: resolution.reason ?? null })),
      diagnostics: capabilityProfile.diagnostics,
    })
    // viewport 改写是版本相关的 raw HTML 变换：能力缺失时整块跳过并留诊断，
    // 不能把版本判断写进业务代码。
    indexInjectionCapabilityReady = capabilityProfile.capabilities.get('web.index-inject')?.status === 'ready'
    if (!indexInjectionCapabilityReady) {
      debugWarn('codingns4dsh: 跳过启动页 PWA 元数据注入', {
        status: capabilityProfile.capabilities.get('web.index-inject')?.status ?? 'missing',
      })
    }
    const indexTap = capabilityProfile.capabilities.get('web.index-tap')
    const webServerForTaps = (hostCtx as Context & { webServer?: { tapIndex?: (transform: (html: string) => string) => () => void } }).webServer
    if (indexTap?.status === 'ready' && typeof webServerForTaps?.tapIndex === 'function') {
      hostCtx.effect(() => {
        const dispose = webServerForTaps.tapIndex?.((html) => applyViewportFitTap(html))
        return () => { dispose?.() }
      }, 'codingns4dsh: 启动页 viewport 改写')
      debugInfo('codingns4dsh: index viewport tap registered')
    } else {
      debugWarn('codingns4dsh: 跳过启动页 viewport 改写', { status: indexTap?.status ?? 'missing' })
    }
    const registry = new FeatureRegistry<CodingNsHostServices>(servicesWithDebug, capabilityProfile)
    registry.registerMany(createHostFeatures({
      terminalStatus: {
        controllerMode: terminal.mode,
        effectiveEnabled: terminal.mode === 'enhanced',
        runtimeTypes: terminal.runtimeTypes,
        ...(terminal.runtimeWarning === undefined ? {} : { runtimeWarning: terminal.runtimeWarning }),
      },
    }))
    registry.validate()
    debugInfo('codingns4dsh: host feature registry ready', { features: registry.descriptors().map((item) => item.name) })
    const restartStates = captureRestartFeatureStates(registry.descriptors(), settings.get(), dshVersion)

    try {
      registerCodingNsRpc(hostCtx, services.rpc, services.settingsProvider)
      debugInfo('codingns4dsh: host RPC registration requested')
    } catch (error) {
      console.error('codingns4dsh: host RPC registration failed', error)
      throw error
    }

    // DSH 提供原生工具运行时后再注册；能力缺失时不阻塞 Host 启动。
    hostCtx.inject(['tools'], (toolsCtx) => {
      if (capabilityProfile.capabilities.get('subagent.continuable')?.status !== 'ready') return
      const tools = (toolsCtx as unknown as { tools?: { register(definition: Record<string, unknown>): unknown } }).tools
      if (tools === undefined || typeof tools.register !== 'function') return
      try {
        const dispose = tools.register(createAgentSubagentTool({ nativeSessions: services.nativeSessions }))
        return typeof dispose === 'function' ? dispose : undefined
      } catch (error) {
        debugWarn('codingns4dsh: agent_subagent 工具注册失败', { error: error instanceof Error ? error.message : String(error) })
        return undefined
      }
    })
    hostCtx.inject(['subagents'], (subagentCtx) => {
      if (capabilityProfile.capabilities.get('subagent.continuable')?.status !== 'ready') return
      const service = (subagentCtx as unknown as { subagents?: NativeSubagentService }).subagents
      if (service === undefined || typeof service.registerProvider !== 'function') return
      const disposeProviders = registerNativeTeamSubagentProviders(service)
      setNativeSubagents(service)
      return () => {
        disposeProviders()
        setNativeSubagents(undefined)
      }
    })

    hostCtx.effect(() => {
      const sync = (): void => {
        const enabled = enabledFeatureNames(registry.descriptors(), settings.get(), restartStates, dshVersion)
        debugInfo('codingns4dsh: host feature sync', { enabled, states: registry.list() })
        void registry
          .reconcile(enabled)
          .catch((error: unknown) => {
            console.error('codingns4dsh: 功能模块状态同步失败', error)
          })
      }
      sync()
      return settings.watch(sync)
    }, 'codingns4dsh: 功能模块启停同步')
  })
}

function readOptionalService(ctx: Context, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function resolveWorkspaceRoot(ctx: Context, workspaceId: string): string | null {
  try {
    const registry = ctx.get('workspaceRegistry') as { readonly list?: () => readonly Record<string, unknown>[] } | undefined
    const entry = registry?.list?.().find((candidate) => candidate.id === workspaceId)
    if (entry === undefined) return null
    for (const key of ['rootPath', 'path', 'cwd', 'directory']) {
      const value = entry[key]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
  } catch {
    // Workspace Registry 还未装配时由启动服务返回可读的不可用错误。
  }
  return null
}

function readWorkspaceRoots(ctx: Context): readonly string[] {
  try {
    const registry = ctx.get('workspaceRegistry') as { readonly list?: () => readonly Record<string, unknown>[] } | undefined
    return (registry?.list?.() ?? []).flatMap((entry) => {
      for (const key of ['rootPath', 'path', 'cwd', 'directory']) {
        const value = entry[key]
        if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
      }
      return []
    })
  } catch {
    return []
  }
}

export {
  HOST_FEATURES,
  createAuthFeature,
  createLanAccessDshFeature,
  createTerminalStatusFeature,
  createHostFeatures,
  createCliAdaptersFeature,
  createTerminalProcessFeature,
  createGitManagementFeature,
  createFileManagementFeature,
  createPeerHostFeature,
  createAssistantVoiceActionBridge,
  VoiceAgentService,
  GlobalVoiceCoordinator,
} from './features/index.js'
export type {
  CodingNsHostServices,
  AssistantVoiceActionBridge,
  AssistantVoiceActionBridgeOptions,
  StartConversationOptions,
  VoiceAction,
  VoiceActionControl,
  VoiceActionRegistration,
  VoiceAgentCapabilities,
  VoiceConversation,
  VoiceEvent,
} from './features/index.js'
export { CodingNsSettingsSchema, registerCodingNsSettings } from './settings.js'
export { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler, registerCodingNsRpc } from './rpc.js'
export {
  AGGREGATED_HOST_RPC_ROUTES,
  AggregatedHostTransportError,
  AggregatedHostTransportService,
  PeerHostAggregatedTransport,
  type AggregatedHostLocalHandlers,
  type AggregatedHostPeerHandlers,
  type AggregatedHostTransportOptions,
} from './modules/peer-host/aggregated-host-transport.js'
export {
  FileAggregateWorkspaceOrderStore,
  VirtualWorkspaceRegistry,
  type AggregateWorkspaceOrderStore,
  type VirtualSessionEntry,
  type VirtualWorkspaceEntry,
} from './modules/peer-host/peer-host-virtual-registry.js'
export {
  DSH_NATIVE_REMOTE_METHODS,
  isDshNativeRemoteMethod,
  rewriteNativeRequestIds,
  rewriteNativeResponseIds,
  type DshNativeRemoteMethod,
  type VirtualIdResolver,
} from './modules/peer-host/peer-host-native-protocol.js'
export {
  DebugWorkspaceService,
  NodeDebugPortInspector,
  type DebugPortCheck,
  type DebugPortInspector,
  type DebugPortProcess,
  type DebugProxyBinding,
} from './debug.js'
export {
  CodingNsRpcError,
  CodingNsRpcTable,
  type CodingNsRpcHandler,
  type CodingNsRpcTarget,
} from './rpc-table.js'

export { CodingNsAuthSession } from './auth-session.js'
export {
  createCodingNsNativeSessionBridge,
  type CodingNsNativeSessionBridge,
  type CodingNsNativeSessionController,
  type CodingNsNativeSessionStore,
  type CodingNsNativeWorkspaceController,
  type CodingNsNativeRequestContext,
  type CodingNsNativeUsageSample,
} from './native-session-bridge.js'
export {
  repairLegacySessionLog,
  repairLegacySessionLogs,
  type LegacySessionRepairOptions,
  type LegacySessionRepairReport,
} from './session-migration-repair.js'
export {
  defaultLegacySettingsPath,
  parseLegacyImportedSessionRecords,
  readLegacyImportedSessionRecords,
} from './cli-adapters/legacy-session-settings.js'
export { CommandCodeDriver } from './cli-adapters/command-code-driver.js'
export {
  startSubagentBridgeServer,
  type SubagentBridgeServer,
  type SubagentBridgeDispatchRequest,
  type SubagentBridgeDispatchResult,
} from './cli-bridge/bridge-server.js'
export {
  createSubagentBridgeRuntime,
  getSubagentBridge,
  setSubagentBridge,
  type SubagentBridgeRuntime,
  type SubagentBridgeRedirect,
} from './cli-bridge/bridge-holder.js'
export { dispatchBridgeSubagent, type BridgeAgentRegistry, type SubagentBridgeDispatchDeps } from './cli-bridge/dispatch.js'
export {
  dispatchNativeSubagent,
  NATIVE_SUBAGENT_TIMEOUT_MS,
  BACKGROUND_NATIVE_SUBAGENT_TIMEOUT_MS,
  type NativeParentAgent,
  type NativeSubagentDispatchRequest,
  type NativeSubagentDispatchResult,
} from './cli-adapters/native-subagent-dispatch.js'
export { CommandCodeSubscriptionService, readCommandCodeApiKey } from './cli-adapters/command-code-subscription.js'
export {
  ProviderSubscriptionService,
  CodexSubscriptionService,
  ClaudeCodeSubscriptionService,
  DeepseekSubscriptionService,
  Sub2ApiUsageService,
  type Sub2ApiReadResult,
  OpenCodeSubscriptionService,
  type DeepseekSubscriptionOptions,
  type Sub2ApiSource,
  type Sub2ApiUsageOptions,
  isSub2ApiUsageSignature,
} from './cli-adapters/provider-subscription.js'
export {
  NewApiSubscriptionService,
  normalizeNewApiUsage,
  normalizeNewApiBilling,
  resolveNewApiSources,
  isOfficialAgentBaseUrl,
  type NewApiReadResult,
  type NewApiSource,
  type NewApiSubscriptionOptions,
} from './cli-adapters/new-api-subscription.js'
export {
  CustomUpstreamClassifier,
  mergeCustomUpstreamCandidates,
  type CustomUpstreamCandidate,
  type CustomUpstreamClassification,
  type CustomUpstreamClassifierOptions,
  type CustomUpstreamKind,
  type CustomUpstreamReadResult,
  type CustomUpstreamReaders,
  type CustomUpstreamSource,
} from './cli-adapters/custom-upstream-classifier.js'
export {
  CodeBuddySubscriptionService,
  normalizeCodeBuddySummary,
  type CodeBuddySubscriptionOptions,
} from './cli-adapters/codebuddy-subscription.js'
export { QoderSubscriptionService, readLatestQoderQuota, type QoderSubscriptionOptions } from './cli-adapters/qoder-subscription.js'
export { OfficialProviderSubscriptionService, type OfficialProviderSubscriptionOptions } from './cli-adapters/official-provider-subscription.js'
export {
  MODEL_PROVIDER_DEFINITIONS,
  identifyModelProvider,
  normalizeProviderBaseUrl,
  normalizeProviderName,
  thirdPartyProvider,
  type ProviderDefinition,
  type ProviderIdentity,
  type ProviderSubscriptionCapability,
  type ProviderSubscriptionReader,
} from './cli-adapters/provider-registry.js'
export { ClaudeCodeDriver } from './cli-adapters/claude-driver.js'
export { KimiCliDriver } from './cli-adapters/kimi-driver.js'
export { GeminiCliDriver } from './cli-adapters/gemini-driver.js'
export { PiAgentDriver } from './cli-adapters/pi-driver.js'
export { CodexAppServerDriver } from './cli-adapters/codex-driver.js'
export { OpenCodeDriver } from './cli-adapters/opencode-driver.js'
export { GrokBuildDriver } from './cli-adapters/grok-driver.js'
export { AntigravityDriver } from './cli-adapters/antigravity-driver.js'
export { AcpCliDriver } from './cli-adapters/acp-cli-driver.js'
export { CursorCliDriver } from './cli-adapters/cursor-driver.js'
export { KiroCliDriver } from './cli-adapters/kiro-driver.js'
export {
  CodeBuddyCliDriver,
  CodeBuddyDriver,
  CodeBuddyCnCliDriver,
  CodeBuddyCnDriver,
  WorkBuddyCliDriver,
  CODEBUDDY_PROFILE,
  CODEBUDDY_CN_PROFILE,
  WORKBUDDY_PROFILE,
  type CodeBuddyRuntimeProfile,
  type CodeBuddyDriverOptions,
} from './cli-adapters/codebuddy-driver.js'
export {
  QoderCliDriver,
  QODER_PROFILES,
  type QoderCliProfile,
  type QoderCliDriverOptions,
} from './cli-adapters/qoder-driver.js'
export { StandardStreamDriver } from './cli-adapters/standard-stream-driver.js'
export { JsonRpcProcess } from './cli-adapters/json-rpc-process.js'
export { HttpSseClient } from './cli-adapters/http-sse-client.js'
export { CodingNsCliAdapterRegistry } from './cli-adapters/registry.js'
export {
  CodingNsCliSessionStore,
  type CodingNsCliSessionPersistence,
  type CodingNsCliSessionPatch,
  type CodingNsCliProviderStatePatch,
  type CodingNsCliSessionStoreOptions,
} from './cli-adapters/session-store.js'
export type {
  CodingNsCliDriver,
  CodingNsCliSessionProbeInput,
  CodingNsCliSessionProbeResult,
  CodingNsCliSessionProbeState,
} from './cli-adapters/driver.js'
export {
  CODINGNS_CONTROL_API_PATHS,
  CodingNsControlApiError,
  HttpCodingNsControlApiClient,
  type CodingNsControlApiClient,
  type CodingNsControlClient,
  type HttpCodingNsControlApiClientOptions,
} from './control-api-client.js'
export {
  InMemoryCodingNsCredentialStore,
  FileCodingNsCredentialStore,
  InMemoryDshDeviceCredentialStore,
  FileDshDeviceCredentialStore,
  type CodingNsCredentialStore,
  type HostCredentialRecord,
  type DshDeviceCredentialStore,
} from './credential-store.js'
export {
  startDshHostDeviceRuntime,
  type DshHostDeviceRuntime,
  type DshHostDeviceRuntimeOptions,
} from './dsh-device-runtime.js'
export { createDshRpcGatewayFeature } from './dsh-gateway-feature.js'
export {
  createLocalDshWebRuntimeProvider,
  createRemoteWebRuntimeFeature,
  type DshWebAsset,
  type DshWebBoot,
  type DshWebRuntimeProvider,
  type DshWebSession,
  type DshWebSocketLike,
  type LocalDshWebRuntimeProviderOptions,
  type RemoteWebRuntimeFeatureOptions,
} from './remote-web-runtime.js'
export type {
  LoginByEmailResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from './control-api-client.js'
export {
  LanAccessDshError,
  LanAccessDshProxy,
  FileLanAccessDshLoginStore,
  InMemoryLanAccessDshLoginStore,
  createLanAccessDshRpcHandler,
  createNodeLanAccessDshRuntime,
  normalizeLanAccessDshConfig,
  openLoginProtectionSession,
  resolveLanAccessDshPwaResponse,
  synthLanResponse,
  verifyLoginProtectionSession,
  type LanAccessDshRuntime,
  type LanAccessDshStream,
  type LanAccessDshLoginRecord,
  type LanAccessDshLoginStore,
  type LanSynthesizedResponse,
} from './lan-access-dsh.js'
export { injectDshWebPwaMetadata, injectDshWebTransportOwnership, CODINGNS_PWA_METADATA_MARKUP } from './index-injection.js'
export {
  PWA_ASSET_PREFIX,
  PWA_MANIFEST_PATH,
  PWA_SERVICE_WORKER_PATH,
  createLanAccessDshPwaBundle,
  createLanAccessDshPwaProvider,
  createPwaClientScript,
  createPwaIconPng,
  createPwaManifest,
  createPwaServiceWorkerScript,
  type LanAccessDshPwaAsset,
  type LanAccessDshPwaBundle,
  type LanAccessDshPwaProvider,
} from './modules/pwa/index.js'
export { applyViewportFitTap, hasViewportFit } from './modules/pwa/pwa-viewport.js'
export {
  CODINGNS_TUNNEL_DATA_CHANNEL_LABEL,
  FileHostDtlsIdentityStore,
  createRegisteredHostSignalingSocket,
  adaptWeriftPeerConnection,
  createWeriftPeerConnectionFactory,
  type WeriftPeerConnectionLike,
  ensureHostDtlsIdentity,
  formatHostDtlsFingerprint,
  generateHostDtlsIdentity,
  startHostRelayRuntime,
  type HostDtlsIdentityMaterial,
  type HostDtlsIdentityStore,
  type HostRelayRuntime,
  type HostRelayRuntimeOptions,
  type HostRelaySession,
  type HostSignalingSocket,
} from './relay-tunnel-runtime.js'
export * from './terminal/index.js'
export { PeerHostWebSocketGateway, PEER_HOST_WS_PATH } from './modules/peer-host/peer-host-ws-gateway.js'
export {
  createPeerHostRelayConnector,
  PeerHostReconnectManager,
  type PeerHostRelayConnectorOptions,
  type PeerHostRelayTransportFactory,
  type PeerHostReconnectManagerOptions,
  type PeerHostReconnectSnapshot,
  type PeerHostReconnectState,
} from './modules/peer-host/peer-host-relay.js'
export {
  createPeerHostDiagnosticSink,
  peerHostSafeError,
  toPeerHostDiagnosticSnapshot,
  type PeerHostDiagnosticSink,
  type PeerHostDiagnosticSnapshot,
} from './modules/peer-host/peer-host-diagnostics.js'
