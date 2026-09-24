/**
 * DSH Host 入口。
 *
 * Host 侧能力全部以功能模块形式交给 FeatureRegistry 管理：依赖顺序、启停和
 * 资源释放由注册表负责，设置里的模块开关通过 watch 驱动 reconcile。入口本身
 * 只负责装配，不承载任何具体业务逻辑，因此新增模块不需要修改这个文件。
 */
import type { Context } from '@deepseek-ai/cordis'
import { FeatureRegistry } from '../features/registry.js'
import { captureRestartFeatureStates, enabledFeatureNames } from '../shared/contracts/config.js'
import { HOST_FEATURES, createHostFeatures } from './features/index.js'
import type { CodingNsHostServices } from './features/types.js'
import { registerCodingNsRpc } from './rpc.js'
import { CodingNsRpcTable } from './rpc-table.js'
import { registerCodingNsSettings } from './settings.js'
import { createCodingNsNativeSessionBridge } from './native-session-bridge.js'
import { installTerminalController } from './terminal/startup.js'
import { DebugWorkspaceService } from './debug.js'

export function apply(ctx?: Context): void {
  if (ctx === undefined) return

  ctx.inject(['settings', 'connection', 'webServer'], async (hostCtx) => {
    const webServerPort = (hostCtx as Context & { webServer: { port: number } }).webServer.port
    const settings = registerCodingNsSettings(hostCtx)
    // controller 必须在功能模块和浏览器 Client 开始消费状态前完成装配。
    // 工厂在本次启动只读取一次开关，设置 watcher 不会热切同名 service。
    const terminal = await installTerminalController(hostCtx, settings, hostCtx.settings, {
      resolveWorkspaceRoot: (workspaceId) => resolveWorkspaceRoot(hostCtx, workspaceId),
    })
    const services: CodingNsHostServices = {
      rpc: new CodingNsRpcTable(),
      settings,
      settingsProvider: hostCtx.settings,
      dshWebPort: webServerPort,
      dshWebAuthenticatedUrl: hostCtx.connection.authenticatedUrl(`http://127.0.0.1:${String(webServerPort)}`),
      events: { on: hostCtx.on.bind(hostCtx) },
      nativeSessions: createCodingNsNativeSessionBridge(hostCtx),
      terminalProcesses: terminal.processService,
      resolveWorkspaceRoot: (workspaceId) => resolveWorkspaceRoot(hostCtx, workspaceId),
      registerDebugProxyRoute: (handler) => hostCtx.connection.fetch.register({
        path: '/api/codingns/debug-proxy',
        methods: ['GET', 'HEAD', 'POST'],
        requestBody: 'streaming',
        fetch: handler,
      }),
    }
    const debug = new DebugWorkspaceService({
      resolveWorkspaceRoot: (workspaceId) => resolveWorkspaceRoot(hostCtx, workspaceId),
      terminalProcesses: terminal.processService,
    })
    const servicesWithDebug: CodingNsHostServices = { ...services, debug }
    const registry = new FeatureRegistry<CodingNsHostServices>(servicesWithDebug)
    registry.registerMany(createHostFeatures({
      terminalStatus: {
        controllerMode: terminal.mode,
        effectiveEnabled: terminal.mode === 'enhanced',
      },
    }))
    registry.validate()
    const restartStates = captureRestartFeatureStates(registry.descriptors(), settings.get())

    registerCodingNsRpc(hostCtx, services.rpc, services.settingsProvider)

    hostCtx.effect(() => {
      const sync = (): void => {
        void registry
          .reconcile(enabledFeatureNames(registry.descriptors(), settings.get(), restartStates))
          .catch((error: unknown) => {
            console.error('dsh-codingns: 功能模块状态同步失败', error)
          })
      }
      sync()
      return settings.watch(sync)
    }, 'dsh-codingns: 功能模块启停同步')
  })
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

export {
  HOST_FEATURES,
  createAuthFeature,
  createLanAccessDshFeature,
  createTerminalStatusFeature,
  createHostFeatures,
  createCliAdaptersFeature,
  createTerminalProcessFeature,
} from './features/index.js'
export type { CodingNsHostServices } from './features/index.js'
export { CodingNsSettingsSchema, registerCodingNsSettings } from './settings.js'
export { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler, registerCodingNsRpc } from './rpc.js'
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
} from './native-session-bridge.js'
export { CommandCodeDriver } from './cli-adapters/command-code-driver.js'
export { CommandCodeSubscriptionService, readCommandCodeApiKey } from './cli-adapters/command-code-subscription.js'
export {
  ProviderSubscriptionService,
  CodexSubscriptionService,
  ClaudeCodeSubscriptionService,
  Sub2ApiUsageService,
  OpenCodeSubscriptionService,
  type Sub2ApiSource,
  type Sub2ApiUsageOptions,
} from './cli-adapters/provider-subscription.js'
export { ClaudeCodeDriver } from './cli-adapters/claude-driver.js'
export { KimiCliDriver } from './cli-adapters/kimi-driver.js'
export { GeminiCliDriver } from './cli-adapters/gemini-driver.js'
export { PiAgentDriver } from './cli-adapters/pi-driver.js'
export { CodexAppServerDriver } from './cli-adapters/codex-driver.js'
export { OpenCodeDriver } from './cli-adapters/opencode-driver.js'
export { GrokBuildDriver } from './cli-adapters/grok-driver.js'
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
  createLanAccessDshRpcHandler,
  createNodeLanAccessDshRuntime,
  normalizeLanAccessDshConfig,
  type LanAccessDshRuntime,
  type LanAccessDshStream,
} from './lan-access-dsh.js'
export {
  CODINGNS_TUNNEL_DATA_CHANNEL_LABEL,
  FileHostDtlsIdentityStore,
  createRegisteredHostSignalingSocket,
  createWeriftPeerConnectionFactory,
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
