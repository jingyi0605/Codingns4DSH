import type { FeatureModule, FeatureResourceScope } from '../../shared/contracts/feature.js'
import type { CodingNsCliApprovalPolicy, CodingNsCliAttachment, CodingNsCliMessage, CodingNsCliModelCatalog, CodingNsCliPermissionState, CodingNsCliSandboxMode, CodingNsCliSessionConfig } from '../../shared/contracts/cli-adapter.js'
import { CommandCodeDriver } from './command-code-driver.js'
import { ClaudeCodeDriver } from './claude-driver.js'
import { GeminiCliDriver } from './gemini-driver.js'
import { KimiCliDriver } from './kimi-driver.js'
import { PiAgentDriver } from './pi-driver.js'
import { CodexAppServerDriver } from './codex-driver.js'
import { GrokBuildDriver } from './grok-driver.js'
import { OpenCodeDriver } from './opencode-driver.js'
import { MiniMaxCodeDriver } from './mcode-driver.js'
import { ZcodeAppServerDriver } from './zcode-driver.js'
import { CodeBuddyCliDriver, WorkBuddyCliDriver } from './codebuddy-driver.js'
import { CursorCliDriver } from './cursor-driver.js'
import { KiroCliDriver } from './kiro-driver.js'
import { QoderCliDriver } from './qoder-driver.js'
import { AntigravityDriver } from './antigravity-driver.js'
import { DoubaoAppDriver } from './doubao-driver.js'
import { CodingNsCliAdapterRegistry } from './registry.js'
import { CliManagementService } from './management.js'
import { CliUpdateCheckService, type CliUpdateCheckOptions } from './update-check.js'
import { CodingNsCliSessionStore } from './session-store.js'
import { CodingNsDshMessageProjector } from './dsh-message-projector.js'
import { CommandCodeSubscriptionService } from './command-code-subscription.js'
import { ProviderSubscriptionService } from './provider-subscription.js'
import { attachMagpieSessionNames, MagpieUsageService, magpieAgentForAdapter, magpieUsageAgentAliases, type MagpieContextRequestOptions, type MagpieSessionNameBinding } from './magpie-usage.js'
import { readDshProviderSource } from './dsh-config.js'
import { MagpieManagementService } from './magpie-management.js'
import { MagpieWebService } from './magpie-web.js'
import { MagpieUpdateService } from './magpie-update.js'
import type { MagpieDashboardPeriod, MagpieDashboardStreamChunk, MagpieSessionMetrics, MagpieUsageDashboard } from '../../shared/contracts/magpie-management.js'
import type { MagpieUsageSnapshot } from '../../shared/contracts/subscription.js'
import { MagpieInstallDetectionService, normalizeCustomCommand, type MagpieDetectionServiceOptions } from './magpie-detection.js'
import { FileMagpieCommandStore, type MagpieCommandStore } from './magpie-command-store.js'
import type { MagpieDetectionRequest } from '../../shared/contracts/magpie-management.js'
import { createMagpieSessionRouting } from './magpie-session-routing.js'
import { normalizeSubagentBridgeSettings, normalizeSubscriptionUsageSettings, type CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsHostServices } from '../features/types.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { setAdapterRegistry } from './registry-holder.js'
import { createDshVirtualProviderRegistration } from './dsh-virtual-providers.js'
import { dispatchBridgeSubagent, type BridgeAgentRegistry } from '../cli-bridge/dispatch.js'
import { dispatchBridgeSearch } from '../cli-bridge/search-dispatch.js'
import { dispatchBridgeFetch } from '../cli-bridge/fetch-dispatch.js'
import { startSubagentBridgeServer, type SubagentBridgeServer } from '../cli-bridge/bridge-server.js'
import { getSubagentBridge, setSubagentBridge } from '../cli-bridge/bridge-holder.js'
import { delegateCapability, dispatchDelegateSubagent, type DelegateAgentRegistry } from './delegate-dispatch.js'
import { guardNativeSubagentParentTurn, markNativeSubagentParentTurnStarted, setMaxNativeSubagentsPerParent } from './native-subagent-dispatch.js'
import { containsDelegationCarrier, delegationAdapterIds, rewriteDelegationMessages } from './delegation-mention-rewrite.js'
import { clearDelegationAuthorization, setDelegationAuthorization } from './delegation-authorization.js'
import { debugInfo } from '../../shared/debug.js'
import { hasLegacySessionAdapterHint } from './legacy-session-adapter.js'
import {
  DSH_NATIVE_SESSION_ADAPTER_ID,
  formatSessionTranslationOutput,
  readSessionTranslationDiagnostics,
  readSessionTranslationMetrics,
  type SessionTranslationInputRecord,
  type SessionTranslationRecord,
} from '../../shared/contracts/session-translation.js'
import { questionTranslationFields } from '../../shared/contracts/interaction-translation.js'
import { createInteractionTranslation } from '../features/interaction-translation.js'
import { createSessionTranslationRecovery, SessionTranslationCancelled } from '../features/session-translation-recovery.js'
import { isSessionTranslationInputEnabled } from '../features/session-translation-service.js'
import { translationFailure } from '../features/session-translation-runtime.js'
import { createDshCapabilityRegistry } from '../../dsh-capabilities/routes.js'
import type { SessionModelSelectionAdapter } from '../../dsh-capabilities/host/session-model-selection-adapter.js'
import { attachmentFileNotice } from '../../shared/attachment-prompts.js'
import { sessionPromptScope, type SessionPromptAdapter } from '../../dsh-capabilities/host/session-prompt-adapter.js'
import { createSessionPromptTranslation } from '../features/session-prompt-translation.js'
import { codexPerformanceProjection } from './codex-performance-projection.js'
import { grokContextProjection, grokPerformanceProjection } from './grok-performance-projection.js'
import { countSessionTurnSteps } from './session-performance-projection.js'
import type { SessionPerformanceAdapter } from '../../dsh-capabilities/host/session-performance-adapter.js'
import { fromCliProviderId, toCliProviderId } from '../../shared/cli-provider-route.js'
import { DshAgentTeamAdapter, type TeamAgent } from '../../dsh-capabilities/host/agent-team-adapter.js'
import { CodingNsTeamDispatcher } from '../cli-bridge/team-dispatch.js'
import { createAgentTeamTool } from '../cli-bridge/team-tool.js'
import { TeamInputTracker, isTeamInputMessage, pendingPeerInput } from './team-input.js'
import { withTeamSupport } from '../cli-bridge/team-adapters.js'
import { isCredentialReference, type CredentialBrokerBinding } from '../../shared/contracts/credentials.js'
import { parseCredentialCarriers, type CredentialCarrier } from '../../shared/credential-carrier.js'

export function createCliAdaptersFeature(options: {
  registry?: CodingNsCliAdapterRegistry
  /** Tests may provide a deterministic subscription reader without touching host credentials. */
  subscriptions?: Pick<ProviderSubscriptionService, 'read' | 'reset'>
  updateCheck?: CliUpdateCheckOptions
  magpieUsage?: MagpieUsageService
  magpieManagement?: MagpieManagementService
  magpieUpdates?: MagpieUpdateService
  magpieWeb?: MagpieWebService
  /** 本机 Magpie 安装探测；测试可注入固定的平台与命令结果。 */
  magpieDetection?: MagpieInstallDetectionService
  magpieDetectionOptions?: MagpieDetectionServiceOptions
  magpieCommandStore?: MagpieCommandStore
} = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'cliAdapters',
      version: '0.1.1',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
      requires: [
        { capability: 'agent-team.external-member', required: false, fallback: 'degrade' },
        { capability: 'agent-team.external-lead', required: false, fallback: 'degrade' },
        { capability: 'session.external-model-selection', required: false, fallback: 'degrade' },
        { capability: 'session.external-performance', required: false, fallback: 'degrade' },
      ],
    },
    async start(context) {
      const lifetime = new AbortController()
      const magpieSessionRouting = createMagpieSessionRouting()
      context.resources.add(() => magpieSessionRouting.dispose())
      // 用量查询超时对所有适配器统一生效：同一个 timeoutMs 下发给全部网络读取器，
      // 设置变更时整体重建，避免旧超时继续生效。
      const buildSubscriptions = (settings: CodingNsSettings | undefined): ProviderSubscriptionService => {
        const timeoutMs = normalizeSubscriptionUsageSettings(settings?.subscriptionUsage).timeoutSecs * 1000
        return new ProviderSubscriptionService({ commandCode: new CommandCodeSubscriptionService({ timeoutMs }), timeoutMs })
      }
      let subscriptions: Pick<ProviderSubscriptionService, 'read' | 'reset'> = options.subscriptions ?? buildSubscriptions(context.services.settings?.get())
      const magpieCommandStore = options.magpieCommandStore ?? new FileMagpieCommandStore()
      let savedMagpieCommand: string | null = null
      try { savedMagpieCommand = await magpieCommandStore.read() } catch {
        console.warn('codingns4dsh: Could not read the saved Magpie executable path')
      }
      const automaticMagpieDetection = (): MagpieInstallDetectionService => options.magpieDetection
        ?? new MagpieInstallDetectionService(options.magpieDetectionOptions)
      let magpieDetection = savedMagpieCommand === null ? automaticMagpieDetection()
        : new MagpieInstallDetectionService({ ...options.magpieDetectionOptions, customCommand: savedMagpieCommand })
      let magpieDetectionRequest = 0
      // Serialize persistence and selection so a delayed write cannot overtake a reset.
      let magpieSelectionWrites: Promise<void> = Promise.resolve()
      // 最近一次可用的 Magpie 入口；探测会随用户指定的路径变化而重建，Web 服务总是读最新值。
      let magpieCommand: string | null = null
      let magpieVersion: string | null = null
      const magpieWeb = options.magpieWeb ?? new MagpieWebService({ startupCommand: () => magpieCommand })
      const magpieUsage = options.magpieUsage ?? new MagpieUsageService({ lifetimeSignal: lifetime.signal, webApi: magpieWeb })
      const magpieManagement = options.magpieManagement ?? new MagpieManagementService({ webApi: magpieWeb })
      const magpieUpdates = options.magpieUpdates ?? new MagpieUpdateService({ webApi: magpieWeb, version: () => magpieVersion })
      let magpieWebDesired = false
      let magpieWebSync: Promise<void> = Promise.resolve()
      const scheduleMagpieWebSync = (enabled: boolean): void => {
        magpieWebDesired = enabled
        if (!enabled) {
          magpieUpdates.stopBackgroundChecks()
          void magpieWeb.stop().catch(() => undefined)
        }
        const next = magpieWebSync.then(async () => {
          if (magpieWebDesired !== enabled) return
          if (!enabled) {
            await magpieWeb.stop()
            return
          }
          try {
            await magpieWeb.start()
            magpieUpdates.startBackgroundChecks()
          } catch (error) {
            console.warn('codingns4dsh: Magpie Web startup failed; the next Web API request will retry', error)
          }
        })
        magpieWebSync = next.catch(() => undefined)
      }
      // 设置里可能保留了“已启用”，但本机没有可用 Magpie（换机、卸载或安装损坏）。
      // 这种情况下不拉起 Magpie Web，等用户安装后重新检测再启用。
      let magpieInstalled = await magpieDetection.detect().then((detection) => {
        const usable = MagpieInstallDetectionService.isUsable(detection)
        magpieCommand = usable ? detection.command : null
        magpieVersion = usable ? detection.version : null
        return usable
      }, () => false)
      scheduleMagpieWebSync(context.services.settings?.get().modules.magpieManagement === true && magpieInstalled)
      context.resources.add(async () => {
        magpieWebDesired = false
        await magpieWeb.stop()
        await magpieWebSync
        await magpieWeb.dispose()
      })
      let subscriptionSettings = JSON.stringify(context.services.settings?.get().subscriptionUsage ?? null)
      // 注入的 registry 自带 SessionStore；只有自建时才有本地 store 变量。
      const sessionStore = options.registry?.sessionRecords
        ?? new CodingNsCliSessionStore(context.services.settings === undefined ? {} : { settings: context.services.settings })
      const nativeSessions = context.services.nativeSessions
      if (context.services.dshContext !== undefined && context.services.dshVersion !== undefined) {
        const performance = createDshCapabilityRegistry(context.services.dshVersion, 'host', context.services.dshContext)
          .getProfile(context.services.dshContext).capabilities.get('session.external-performance')?.value as SessionPerformanceAdapter | undefined
        if (performance !== undefined) {
          for (const projection of [codexPerformanceProjection, grokPerformanceProjection, grokContextProjection]) {
            context.resources.add(performance.install(projection))
          }
        }
      }
      const translation = context.services.sessionTranslation
      // 启动只恢复持久化索引；旧会话在打开时迁移，禁止在首屏扫描全部历史。
      const registry = options.registry ?? new CodingNsCliAdapterRegistry([
        new CommandCodeDriver({ enableAcp: true }),
        new ClaudeCodeDriver(),
        new KimiCliDriver(),
        new GeminiCliDriver(),
        new PiAgentDriver(),
        new CodexAppServerDriver({ computerUse: 'auto' }),
        new OpenCodeDriver(),
        new GrokBuildDriver(),
        new MiniMaxCodeDriver(),
        new ZcodeAppServerDriver(),
        new CodeBuddyCliDriver(),
        new WorkBuddyCliDriver(),
        new CursorCliDriver(),
        new KiroCliDriver(),
        new QoderCliDriver(),
        new QoderCliDriver({ variant: 'qoder-cn' }),
        new AntigravityDriver(),
        new DoubaoAppDriver(),
      ], context.services.settings?.get().agentAdapters, {
        sessionStore,
        ...(context.services.settings === undefined ? {} : { settings: context.services.settings }),
        ...(context.services.nativeSessions === undefined ? {} : { nativeSessions: context.services.nativeSessions }),
      })
      setAdapterRegistry(registry)
      const teamInputs = new TeamInputTracker()
      context.resources.add(() => teamInputs.clear())
      let teamAdapter: DshAgentTeamAdapter | undefined
      const teamDispatcher = new CodingNsTeamDispatcher({
        adapter: () => teamAdapter,
        registry,
        enabled: () => !lifetime.signal.aborted && normalizeSubagentBridgeSettings(context.services.settings?.get().subagentBridge).enabled,
      })
      const versionSupported = context.services.dshVersion !== undefined && !createDshCapabilityRegistry(context.services.dshVersion, 'host', {}).getProfile({}).diagnostics.some(item => item.capability === 'agent-team.external-member' && item.code === 'CAPABILITY_VERSION_UNSUPPORTED')
      const teamCatalog = (catalog: readonly import('../../shared/contracts/cli-adapter.js').CodingNsCliAdapterDescriptor[]) => withTeamSupport(catalog,
        !versionSupported ? 'version' : !normalizeSubagentBridgeSettings(context.services.settings?.get().subagentBridge).enabled ? 'disabled' : !teamAdapter ? 'profile' : undefined, teamAdapter?.supportsLead)
      const dshContext = context.services.dshContext
      if (dshContext?.inject && context.services.dshVersion) {
        const teamScope = dshContext.inject(['agentTeams', 'agents', 'subagents', 'tools'], scoped => {
          const capability = createDshCapabilityRegistry(context.services.dshVersion!, 'host', scoped).getProfile(scoped).capabilities.get('agent-team.external-member')
          if (capability?.status !== 'ready') return
          const adapter = capability.value as DshAgentTeamAdapter
          teamAdapter = adapter
          const tools = scoped.get('tools') as { register(definition: Record<string, unknown>): unknown }
          const unregister = tools.register(createAgentTeamTool(teamDispatcher))
          scoped.effect(() => () => {
            adapter.dispose()
            if (teamAdapter === adapter) teamAdapter = undefined
            if (typeof unregister === 'function') unregister()
          }, 'CodingNS native Team bridge')
        })
        context.resources.add(() => teamScope.dispose())
      }
      if (dshContext?.on) {
        const stopCreated = dshContext.on('agent/created' as never, ((payload: unknown) => {
          const agent = asRecord(payload)?.agent
          if (agent && typeof agent.id === 'string') teamDispatcher.initializeNativeChild(agent as TeamAgent)
        }) as never, { global: true } as never)
        if (typeof stopCreated === 'function') context.resources.add(stopCreated as () => void)
      }
      context.resources.add(() => {
        if (registry === undefined) return
        setAdapterRegistry(undefined)
      })
      registry.applyEnabledSettings(context.services.settings?.get().agentAdapters)
      const virtualProviders = createDshVirtualProviderRegistration(context.services.dshContext)
      if (virtualProviders !== undefined) context.resources.add(() => virtualProviders.dispose())
      virtualProviders?.setProviders(registry.enabledAdapterIds())
      if (context.services.dshContext !== undefined && context.services.dshVersion !== undefined) {
        const selection = createDshCapabilityRegistry(context.services.dshVersion, 'host', context.services.dshContext)
          .getProfile(context.services.dshContext).capabilities.get('session.external-model-selection')
          ?.value as SessionModelSelectionAdapter | undefined
        if (selection !== undefined) context.resources.add(selection.install((sessionId) => {
          const config = registry.getSession(sessionId)
          if (config.adapterId === 'dsh' && config.teamId && config.providerId && config.modelId) return {
            provider: config.providerId, model: config.modelId, ...(config.effortId ? { reasoningEffort: config.effortId } : {}),
          }
          if (config.adapterId === 'dsh' || !registry.isEnabled(config.adapterId)) return undefined
          return { provider: toCliProviderId(config.adapterId), model: config.modelId?.trim() || 'provider-default' }
        }))
      }
      registry.warmCatalog()
      const management = new CliManagementService(registry)
      context.resources.add(() => management.dispose())
      const updates = new CliUpdateCheckService(options.updateCheck)
      context.resources.add(() => updates.dispose())
      // 外部适配器没有经过 DSH 原生 Agent Loop，必须把同一套运行状态投影给
      // subagentCatalog。这里集中去重，避免 llm/stream、原生 session/event 和
      // agent/status 同时到达时反复刷新同一个子 Agent。
      const publishExternalStatus = createExternalSessionStatusPublisher(
        context.services.events,
        registry,
        sessionStore,
      )
      if (nativeSessions !== undefined) {
        const disposeNativeEvents = nativeSessions.subscribe({
          onEvent: (session, event) => {
            const sessionId = nativeSessionId(session)
            const eventType = nativeEventType(event)
            if (sessionId === undefined || eventType === undefined) return
            // 旧会话可能不在启动时的 SessionStore.list() 中，直到用户点击
            // 侧栏才加载。加载事件本身携带完整快照，此时补做一次迁移；
            // fork 子会话的绑定来自父会话，必须把祖先链一起交给迁移。
            if (sessionStore.get(sessionId) === undefined) {
              if (hasLegacySessionAdapterHint(event)) sessionStore.invalidateLegacySession(session)
              sessionStore.migrateLegacySessions(collectMigrationChain(nativeSessions, session))
            }
            if (eventType === 'turn/start') publishExternalStatus(sessionId, true)
            else if (eventType === 'turn/end') publishExternalStatus(sessionId, false)
            const current = sessionStore.get(sessionId)
            if (current === undefined || current.status === 'archived') return
            if (eventType === 'turn/start') {
              markNativeSubagentParentTurnStarted(sessionId)
              sessionStore.upsert(sessionId, { ...current, status: 'active' })
            } else if (eventType === 'turn/end') {
              const barrier = guardNativeSubagentParentTurn(nativeSessions, sessionId)
              sessionStore.upsert(sessionId, { ...current, status: barrier.blocked ? 'active' : 'idle' })
            }
          },
        })
        context.resources.add(disposeNativeEvents)
      }
      const translationRecovery = createSessionTranslationRecovery(translation, sessionId => registry.getSession(sessionId))
      context.resources.add(() => translationRecovery.dispose())
      const promptTranslation = createSessionPromptTranslation(translation, sessionId => {
        if (!sessionId || isAssistantSession(sessionId) || readNativeSessionHeader(nativeSessions, sessionId)?.origin === 'subagent') return undefined
        const config = registry.getSession(sessionId)
        return (config.translationEnabled ?? (config.adapterId === 'dsh' && translation?.nativeEnabled === true)) ? config.adapterId : undefined
      })
      context.resources.add(() => promptTranslation.dispose())
      if (context.services.dshContext !== undefined && context.services.dshVersion !== undefined) {
        const adapter = createDshCapabilityRegistry(context.services.dshVersion, 'host', context.services.dshContext)
          .getProfile(context.services.dshContext).capabilities.get('session.prompt-assembly')?.value as SessionPromptAdapter | undefined
        if (adapter !== undefined) context.resources.add(adapter.install((assembly, scope) => promptTranslation.translateAssembly(assembly, scope)))
      }
      registerDelegationAgentHooks(context.services.dshContext, registry, context.resources, publishExternalStatus, translation, translationRecovery, promptTranslation, context.services.credentialBroker, nativeSessions, teamInputs)
      const interactionTranslation = createInteractionTranslation(translation, sessionId => registry.getSession(sessionId))
      context.resources.add(() => interactionTranslation.dispose())
      context.resources.add(context.services.rpc.register('cli', async (action, payload, rpcContext) => {
        const rpcSignal = asRecord(rpcContext)?.signal
        const signal = isAbortSignal(rpcSignal) ? rpcSignal : undefined
        switch (action) {
          case 'management/plan':
          case 'management/start':
          case 'management/status':
          case 'management/cancel': return management.rpc(action, payload)
          case 'catalog': return registry.catalog().then(catalog => updates.catalog(teamCatalog(catalog)))
          case 'catalog/refresh': return registry.refreshCatalog(asRecord(payload)?.adapterId === undefined ? undefined : readAdapterId(payload)).then((catalog) => {
            subscriptions = buildSubscriptions(context.services.settings?.get())
            return asRecord(payload)?.checkUpdates === true
              ? updates.refresh(teamCatalog(catalog), asRecord(payload)?.adapterId)
              : updates.catalog(teamCatalog(catalog))
          })
          case 'models': {
            const adapterId = readAdapterId(payload)
            const catalog = adapterId === 'dsh'
              ? readDshModelCatalog(context.services.dshContext)
              : registry.models(adapterId)
            if (asRecord(payload)?.stage === 'base') {
              const base = await catalog
              return magpieAgentForAdapter(adapterId) === null ? base : { ...base, magpiePending: true }
            }
            return typeof magpieUsage.enrichModelCatalog === 'function'
              ? magpieUsage.enrichModelCatalog(adapterId, catalog, signal ?? lifetime.signal)
              : catalog
          }
          case 'translation/models': return context.services.sessionTranslation?.catalog() ?? { models: [], default: null, errors: ['翻译模型目录不可用'] }
          case 'translation/pending': return translationRecovery.pending(payload)
          case 'translation/resolve': return translationRecovery.resolve(payload)
          case 'translation/retry-output': return translationRecovery.retryOutput(payload, signal)
          case 'translation/fields': return interactionTranslation.translate(payload, signal)
          case 'skills': {
            const request = readSkillsRequest(payload)
            const cwd = resolveSessionCwd(context.services.nativeSessions, request.sessionId, null)
            return registry.listSkills(request.sessionId, {
              ...(cwd === undefined ? {} : { cwd }),
              ...(request.forceReload ? { forceReload: true } : {}),
            })
          }
          case 'adapter/set': return setAdapterEnabled(context.services.settings, registry, payload)
          case 'session/get': {
            const sessionId = readSessionId(payload)
            const session = nativeSessions?.get(sessionId)
            if (session !== undefined && nativeSessions !== undefined && sessionStore.get(sessionId) === undefined) {
              sessionStore.migrateLegacySessions(collectMigrationChain(nativeSessions, session))
            }
            return registry.getSession(sessionId)
          }
          case 'session/set': {
            const sessionId = readSessionId(payload)
            const previous = registry.getSession(sessionId)
            const config = readSessionConfig(payload)
            const saved = registry.setSession(sessionId, config)
            if (config.translationEnabled === false || previous.adapterId !== config.adapterId) translationRecovery.cancelSession(sessionId)
            return saved
          }
          case 'session/list': return registry.listSessions(readSessionListOptions(payload))
          case 'session/adapter-map':
            // 列表查询只返回持久化索引，不能触发会话加载或历史解析。
            return sessionStore.adapterBindings()
          case 'session/archive': return registry.archiveSession(readSessionId(payload))
          case 'session/steer': return translateSteerPrompt(translationRecovery, registry, readSessionId(payload), readPrompt(payload), false, signal)
          case 'session/follow-up': return translateSteerPrompt(translationRecovery, registry, readSessionId(payload), readPrompt(payload), true, signal)
          case 'session/interrupt': {
            const sessionId = readSessionId(payload)
            translationRecovery.cancelSession(sessionId)
            return registry.interrupt(sessionId)
          }
          case 'team/status': return context.services.nativeTeam?.diagnostic() ?? registry.teamDiagnostic()
          case 'team/members': return requireTeam(context).invoke('members', payload)
          case 'team/tasks': return requireTeam(context).invoke('tasks', payload)
          case 'team/task': return requireTeam(context).invoke('task', payload)
          case 'team/spawn': return requireTeam(context).invoke('spawn', payload)
          case 'team/message': return requireTeam(context).invoke('message', payload)
          case 'team/task/create': return requireTeam(context).invoke('task/create', payload)
          case 'team/task/update': return requireTeam(context).invoke('task/update', payload)
          case 'team/wait': return requireTeam(context).invoke('wait', payload)
          case 'team/interrupt': return requireTeam(context).invoke('interrupt', payload)
          case 'subscription': {
            const subscription = readSubscriptionRequest(payload)
            const requestSignal = signal ?? lifetime.signal
            // A newly opened native DSH session may not be in the Host bridge's
            // local store yet. Adopt it before reading the Registry, otherwise
            // the native model/provider selection is invisible and the request
            // incorrectly falls back to the official DSH balance.
            if (subscription.adapterId === 'dsh' && subscription.sessionId !== undefined && nativeSessions !== undefined) {
              await nativeSessions.ensure(subscription.sessionId)
              requestSignal.throwIfAborted()
            }
            const session = subscription.sessionId === undefined ? undefined : registry.getSession(subscription.sessionId)
            if (context.services.settings?.get().modules.magpieManagement === true
              && session !== undefined && session.adapterId === subscription.adapterId) {
              const magpie = await magpieUsage.read(session, requestSignal, subscription.includeRoute, subscription.sessionId)
              requestSignal.throwIfAborted()
              const snapshot = magpie ?? (subscription.sessionId === undefined
                ? null
                : await pendingMagpieUsage(magpieUsage, nativeSessions, subscription.sessionId, session, requestSignal, subscription.includeRoute))
              if (snapshot !== null) {
                const sessionName = subscription.sessionId === undefined ? undefined : readDshSessionDisplayName(subscription.sessionId, sessionStore, nativeSessions, context.services.dshContext)
                return { providerUsage: null, magpie: sessionName === undefined ? snapshot : { ...snapshot, sessionName } }
              }
            }
            requestSignal.throwIfAborted()
            const providerUsage = await subscriptions.read(subscription.adapterId, subscription.providerId, subscription.modelId)
            return { providerUsage, magpie: null }
          }
          case 'subscription/reset': {
            const subscription = readSubscriptionResetRequest(payload)
            return subscriptions.reset(subscription.adapterId, subscription.providerId)
          }
          // `/委派` 的 Host 边界：先给 Client 一个可读的能力诊断，再落地异步派发。
          case 'delegate/capability': {
            return delegateCapability({
              agents: readOptionalContextService(context.services.dshContext, 'agents') as DelegateAgentRegistry | undefined,
              nativeSessions: context.services.nativeSessions,
            })
          }
          case 'delegate': {
            const request = readDelegateRequest(payload)
            return dispatchDelegateSubagent(request, {
              agents: readOptionalContextService(context.services.dshContext, 'agents') as DelegateAgentRegistry | undefined,
              nativeSessions: context.services.nativeSessions,
            })
          }
          default: throw new Error(`未知 CLI RPC: cli/${action}`)
        }
      }))
      context.resources.add(context.services.rpc.register('magpie', async (action, payload, rpcContext) => {
        const rpcSignal = asRecord(rpcContext)?.signal
        const signal = isAbortSignal(rpcSignal) ? rpcSignal : lifetime.signal
        // 安装探测本身就是启用前的判断依据，因此不要求模块已启用。
        if (action === 'management/detection') {
          const requestId = ++magpieDetectionRequest
          const request = readMagpieDetectionRequest(payload)
          const force = readMagpieDetectionForce(payload)
          // Only a successful custom probe replaces the saved Host-local selection.
          const customCommand = normalizeCustomCommand(request.commandPath)
          const resetCommand = request.resetCommand === true
          const detectionService = resetCommand ? automaticMagpieDetection() : customCommand === null
            ? magpieDetection
            : new MagpieInstallDetectionService({ ...options.magpieDetectionOptions, customCommand })
          const detection = await detectionService.detect(resetCommand || customCommand === null ? {} : { commandPath: customCommand }, { force: force || resetCommand || customCommand !== null })
          const selection = magpieSelectionWrites.then(async () => {
            if (requestId !== magpieDetectionRequest || lifetime.signal.aborted) return
            const usable = MagpieInstallDetectionService.isUsable(detection)
            if (resetCommand || (usable && customCommand !== null)) {
              try { await magpieCommandStore.write(resetCommand ? null : customCommand) } catch {
                throw new CodingNsRpcError('CODINGNS_MAGPIE_PATH_STORAGE_FAILED', 'Could not save the Magpie executable path')
              }
            }
            if (lifetime.signal.aborted) return
            if (usable || customCommand === null || resetCommand) {
              if (resetCommand || (usable && customCommand !== null)) magpieDetection = detectionService
              magpieInstalled = usable
              magpieCommand = usable ? detection.command : null
              magpieVersion = usable ? detection.version : null
              scheduleMagpieWebSync(context.services.settings?.get().modules.magpieManagement === true && usable)
            }
          })
          magpieSelectionWrites = selection.catch(() => undefined)
          await selection
          return detection
        }
        if (action === 'context') {
          const request = readMagpieContextRequest(payload)
          const target = await resolveMagpieContextTarget(request.sessionId, sessionStore, nativeSessions, magpieUsage, signal)
          if (target === null || !magpieInstalled) return null
          try { await magpieWeb.start() } catch { return null }
          return magpieUsage.readContext(target, signal)
        }
        if (context.services.settings?.get().modules.magpieManagement !== true) {
          throw new CodingNsRpcError('CODINGNS_MAGPIE_DISABLED', 'Magpie management is disabled')
        }
        switch (action) {
          case 'usage/dashboard': {
            const dashboard = await magpieUsage.readDashboard(readMagpieDashboardPeriod(payload), signal, asRecord(payload)?.force === true)
            return attachMagpieSessionNames(dashboard, await magpieSessionNameBindings(sessionStore, nativeSessions, signal, context.services.dshContext))
          }
          case 'usage/dashboard/stream': {
            const input = asRecord(payload)
            const period = readMagpieDashboardPeriod(payload)
            const force = input?.force === true
            return streamMagpieDashboard(magpieUsage, period, signal, force, sessionStore, nativeSessions, context.services.dshContext)
          }
          case 'usage/requests': {
            const request = readMagpieRequestOptions(payload)
            const page = await magpieUsage.readRequestPage(request, signal)
            if (page === null || request.sessionId === undefined) return page
            return {
              ...page,
              sessionName: readDshSessionDisplayName(request.sessionId, sessionStore, nativeSessions, context.services.dshContext) ?? null,
              sessionMetrics: readMagpieSessionMetrics(sessionStore, nativeSessions, request.sessionId, request.sessionIds),
            }
          }
          case 'usage/account/update':
            return magpieUsage.updateAccountPolicy(payload, signal)
          case 'usage/reset':
            return magpieUsage.resetCodexAccount(payload, signal)
          case 'management/snapshot':
            return magpieManagement.readSnapshot(signal)
          case 'management/provider/update':
            return magpieManagement.updateProvider(payload, signal)
          case 'management/group/update':
            return magpieManagement.updateGroup(payload, signal)
          case 'management/account/update':
            return magpieManagement.updateAccount(payload, signal)
          case 'update/status':
            return magpieUpdates.readStatus(signal)
          case 'update/notes':
            return magpieUpdates.readNotes(signal)
          case 'update/check':
            return magpieUpdates.checkForUpdate(signal)
          case 'update/install':
            return magpieUpdates.installUpdate(payload, signal)
          default:
            throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `Unknown Magpie RPC: ${action}`)
        }
      }))

      // 外部 CLI 子代理托管：开启时启动本机回环桥接，把外部 CLI 的子代理调用
      // 转投成 DSH 原生可续子会话；关闭或模块停用时收回端口并清空驱动句柄。
      let bridgeServer: SubagentBridgeServer | undefined
      let bridgeSync: Promise<void> = Promise.resolve()
      const syncSubagentBridge = async (enabled: boolean): Promise<void> => {
        if (enabled === (bridgeServer !== undefined)) return
        if (!enabled) {
          const server = bridgeServer
          bridgeServer = undefined
          setSubagentBridge(undefined)
          await server?.close()
          return
        }
        try {
          const agents = readOptionalContextService(context.services.dshContext, 'agents')
          const server = await startSubagentBridgeServer({
            teamAccess: (sessionId) => teamDispatcher.access(sessionId),
            teamDispatch: (sessionId, input, signal) => teamDispatcher.dispatch(sessionId, input, signal),
            dispatch: (request) => dispatchBridgeSubagent(request, {
              agents: agents as BridgeAgentRegistry | undefined,
              nativeSessions: context.services.nativeSessions,
            }),
            search: (input, signal) => dispatchBridgeSearch(input, {
              web: readOptionalContextService(context.services.dshContext, 'web'),
            }, signal),
            fetch: (input, signal) => dispatchBridgeFetch(input, {
              web: readOptionalContextService(context.services.dshContext, 'web'),
            }, signal),
          })
          bridgeServer = server
          setSubagentBridge(server.runtime)
        } catch (error) {
          console.warn('codingns4dsh: 外部 Agent 子代理桥接启动失败', error)
        }
      }
      const scheduleSubagentBridgeSync = (enabled: boolean): void => {
        bridgeSync = bridgeSync.then(() => syncSubagentBridge(enabled), () => syncSubagentBridge(enabled))
      }
      const syncSubagentBridgeSettings = (raw: unknown): void => {
        const bridgeSettings = normalizeSubagentBridgeSettings(raw)
        // 并发上限先于桥接启停生效：桥接开启后立刻到达的并行调用必须看到用户配置，
        // 否则第一批派发仍会撞上缺省上限。
        setMaxNativeSubagentsPerParent(bridgeSettings.maxConcurrentSubagents)
        scheduleSubagentBridgeSync(bridgeSettings.enabled)
      }
      // 初始值必须在任何派发之前落地：桥接开启后第一批并行调用就会读取上限。
      syncSubagentBridgeSettings(context.services.settings?.get().subagentBridge)
      await bridgeSync
      context.resources.add(async () => {
        const server = bridgeServer
        bridgeServer = undefined
        setSubagentBridge(undefined)
        await server?.close()
      })

      const settings = context.services.settings
      if (settings !== undefined) {
        context.resources.add(settings.watch((next) => {
          registry.applyEnabledSettings(next.agentAdapters)
          virtualProviders?.setProviders(registry.enabledAdapterIds())
          registry.syncPreferences(next.agentAdapterPreferences)
          sessionStore.sync(next.cliSessions)
          translationRecovery.cancelDisabled(next.sessionTranslation)
          const nextSubscriptionSettings = JSON.stringify(next.subscriptionUsage ?? null)
          if (nextSubscriptionSettings !== subscriptionSettings) {
            subscriptionSettings = nextSubscriptionSettings
            subscriptions = buildSubscriptions(next)
          }
          syncSubagentBridgeSettings(next.subagentBridge)
          const magpieWanted = next.modules.magpieManagement === true
          // 只在“需要启动”时重新探测；停用时立即回收，退出探测的旧结果不覆盖新状态。
          void (magpieWanted && !magpieInstalled
            ? magpieDetection.detect({}, { force: true }).then(
              detection => MagpieInstallDetectionService.isUsable(detection),
              () => false,
            )
            : Promise.resolve(magpieInstalled)).then((installed) => {
            magpieInstalled = installed
            if (next.modules.magpieManagement !== true) scheduleMagpieWebSync(false)
            else if (installed) scheduleMagpieWebSync(true)
          })
        }))
      }

      const events = context.services.events
      if (events !== undefined) {
        const dispose = events.on('llm/stream', async function* (options: unknown, next: () => AsyncIterable<unknown>) {
          const value = asRecord(options)
          // 翻译服务也复用 DSH 原生 LLM，但它不是外部 Agent 回合；必须在这里
          // 旁路 CLI Provider 接管，否则翻译请求会被再次当成 Grok/Codex 请求。
          if (isSessionTranslationLlmRequest(value)) {
            yield* next()
            return
          }
          const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
          if (value?.purpose === 'session-title' || value?.purpose === 'compaction') {
            yield* next()
            return
          }
          // fork 子会话继承父会话历史，但可能还没被任何 RPC 触碰过；用户直接在
          // 子会话里发消息时，这里必须补一次迁移，否则子会话会被当成默认 DSH
          // 会话，用户看到的仍是 DSH 主模型而不是原来的外部 Agent。子会话的
          // 绑定来自父会话，所以父会话必须一起进入同一批迁移。
          if (sessionId !== '' && nativeSessions !== undefined) {
            const nativeSession = nativeSessions.get(sessionId)
            if (nativeSession !== undefined) {
              sessionStore.migrateLegacySessions(collectMigrationChain(nativeSessions, nativeSession))
            }
          }
          const storedConfig = sessionId ? registry.getSession(sessionId) : { adapterId: 'dsh' }
          // DSH 原生请求仍会携带当前模型提供方。旧会话在重载后可能暂时
          // 被恢复成 dsh，但 provider 已明确指向外部 Agent；继续旁路会让
          // 第二轮直接落入 DSH 空流，并丢失外部驱动的 usage/context 修正。
          const dshSelection = readDshSelection(value)
          let messages = Array.isArray(value?.messages) ? value.messages.filter(isMessage) : []
          // 委派 carrier 只在普通对话提交时消费。选择 Agent 本身不会经过这里，也不会创建
          // 子会话；Agent Loop 请求会在 agent/pre-step 边界完成改写。这里仅保留
          // 非 Agent Loop 手工 llm/stream 调用的错误消费和外部 Agent 局部解析。
          if (containsDelegationCarrier(messages)) {
            const delegation = rewriteDelegationMessages(messages, await registry.catalogForUse(delegationAdapterIds(messages)))
            if (delegation.kind === 'error') {
              yield* delegationErrorStream(`${delegation.error.code}: ${delegation.error.message}`)
              return
            }
            if (delegation.kind === 'rewritten') {
              // DSH Agent Loop 传入的 options 是深冻结对象，不能把改写结果写回
              // `value.messages`。外部适配器只消费本地快照，原生 Agent 的 carrier
              // 已在 agent/pre-step 中被替换并持久化。
              setDelegationAuthorization(sessionId, delegation.value.targets)
              messages = [...delegation.value.messages]
            }
          } else if (sessionId !== '') clearDelegationAuthorization(sessionId)
          const selectedExternalAdapter = storedConfig.adapterId === 'dsh' && storedConfig.teamId ? undefined : selectExternalAdapter(
            fromCliProviderId(dshSelection.providerId),
            inferMessageAdapter(messages),
            registry,
          )
          // DSH 的 modelSelection 只描述 DSH 自己那条模型路由（例如 glor/deepseek）。
          // 只有它明确指向即将接管的外部适配器时，model/effort 才属于该适配器；
          // 当适配器是从会话历史推断出来的（fork 子会话继承父会话的外部消息，而
          // provider 仍是 DSH 主模型）时，沿用该 model 会把别的 Provider 的模型名
          // 写进外部 Agent——Codex 会用它 thread/start 并直接 404，整个会话从此
          // 无法继续。此时必须留空，由适配器自己的偏好决定模型。
          const selectionOwnedByAdapter = selectedExternalAdapter !== undefined
            && (fromCliProviderId(dshSelection.providerId) ?? dshSelection.providerId) === selectedExternalAdapter
          let config: CodingNsCliSessionConfig = storedConfig.adapterId === 'dsh' && selectedExternalAdapter !== undefined
            ? {
                adapterId: selectedExternalAdapter,
                ...(selectionOwnedByAdapter && dshSelection.modelId !== undefined ? { modelId: dshSelection.modelId } : {}),
                ...(selectionOwnedByAdapter && dshSelection.effortId !== undefined ? { effortId: dshSelection.effortId } : {}),
              }
            : storedConfig
          // DSH 首轮请求可能只通过 provider 临时选择外部 Agent，第二轮请求通常不再携带
          // provider。必须在路由决定后立即持久化绑定，否则下一轮会在进入 Registry 前退回 dsh。
          // 采用规范化结果，让本轮也使用适配器自己的模型偏好，而不是 DSH 主模型。
          if (sessionId !== '' && storedConfig.adapterId === 'dsh' && selectedExternalAdapter !== undefined) {
            config = registry.setSession(sessionId, config)
          }
          if (config.teamId && !teamDispatcher.identity(sessionId)) {
            throw Object.assign(new Error('The native Team identity is unavailable. Restore its Team profile and adapter before continuing.'), { code: 'TEAM_SERVICE_UNAVAILABLE' })
          }
          const turnInput = extractTurnInput(messages, context.services.dshContext, teamInputs.take(sessionId, messages))
          const credentialResolution = await resolveCredentialEnvironment(
            context.services.credentials,
            context.services.credentialBroker,
            sessionId,
            config.credentialRefs,
            turnInput.credentialCarriers,
            config.adapterId === 'dsh',
          )
          if (config.adapterId === 'dsh') {
            if (credentialResolution !== undefined && context.services.credentialBroker?.nativeToolAvailable() !== true) {
              throw new CodingNsRpcError('CREDENTIAL_INJECTION_UNSUPPORTED', 'Native DSH credential tool is unavailable')
            }
            const selection = dshSelection
            if (sessionId !== '' && (selection.modelId !== undefined || selection.effortId !== undefined)) {
              registry.setSession(sessionId, { adapterId: 'dsh', ...selection })
            }
            // Native-session output translation wraps only DSH's own Provider stream:
            // preserve text/reasoning and attach the translation record; the client renders it.
            if (!isSessionTranslationLlmRequest(value)
              && translation !== undefined
              && translation.enabled
              && (config.translationEnabled ?? translation.nativeEnabled === true)
              && sessionId !== ''
              && !isAssistantSession(sessionId)
              && readNativeSessionHeader(nativeSessions, sessionId)?.origin !== 'subagent') {
              yield* guardDshNativeStream(() => translateNativeStream(
                magpieSessionRouting.wrap(sessionId, next()),
                translation,
                translation.bilingual === true,
                isAbortSignal(value?.signal) ? value.signal : undefined,
              ))
              return
            }
            yield* guardDshNativeStream(() => magpieSessionRouting.wrap(sessionId, next()))
            return
          }
          const cwd = resolveSessionCwd(context.services.nativeSessions, sessionId, value)
          const turnOptions = readCliTurnOptions(value)
          const runtimeEnv = readCliRuntimeEnv(value)
          const requestSignal = isAbortSignal(value?.signal)
            ? AbortSignal.any([value.signal, lifetime.signal])
            : lifetime.signal
          const translationLanguage = translation?.enabled && isSessionTranslationInputEnabled(translation, config.adapterId) && config.translationEnabled === true ? readInputTargetLanguage(translation) : undefined
          let translatedPrompt = turnInput.translationPrompt
          if (turnInput.translatePrompt && turnInput.translationPrompt.trim() !== '' && translationLanguage !== undefined) {
            try {
              translatedPrompt = (await translationRecovery.translateInput(sessionId, config.adapterId, turnInput.translationPrompt, requestSignal)).translated
            } catch (error) {
              if (!(error instanceof SessionTranslationCancelled) && !requestSignal?.aborted) throw error
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
          }
          const userPrompt = turnInput.translatePrompt
            ? [translatedPrompt, translationLanguage === undefined ? turnInput.untranslatedPrompt : attachmentNotices(turnInput.attachments, translationLanguage)].filter((part) => part.trim() !== '').join('\n\n')
            : turnInput.prompt
          const prompt = [formatCredentialUsageNotice(credentialResolution), userPrompt]
            .filter((part) => part.trim() !== '')
            .join('\n\n')
          // 权限状态必须与 DSH 会话当前生效值同源。驱动不能自行假设“完全权限”，
          // 也不能把缺省当成“已确认无限制”：解析失败时留空，由驱动沿用保守默认。
          const permission = resolveSessionPermission(context.services.dshContext, sessionId)
          let magpieCodexContextWindow: number | undefined
          if (config.adapterId === 'codex' && config.modelId !== undefined && typeof magpieUsage.readModelMetadata === 'function') {
            try {
              magpieCodexContextWindow = (await magpieUsage.readModelMetadata('codex', config.modelId, requestSignal))?.contextWindow
            } catch (error) {
              if (!requestSignal.aborted) throw error
            }
          }
          // 只有 Provider 驱动明确声明可以维护连续事件流，才把工具边界映射为 DSH step。
          // Command Code、Codex 自己维护 assistant 消息边界；OpenCode 由 Registry
          // 挂起并续读同一条 SSE。其他驱动仍把整轮保持在一个 step，避免 token-meter
          // 在下一条 usage 到达前失去投影。
          const input = {
            sessionId,
            messages: turnInput.messages,
            prompt,
            ...(turnInput.peerInput ? { peerInput: true } : {}),
            ...(translationLanguage === undefined ? {} : { translationLanguage }),
            ...(turnInput.attachments.length === 0 ? {} : { attachments: turnInput.attachments }),
            ...(permission === undefined ? {} : { permission }),
            ...(turnOptions.plan === true ? { plan: true } : {}),
            ...(turnOptions.forkSession === true ? { forkSession: true } : {}),
            ...(turnOptions.enableAskUserQuestion === true ? { enableAskUserQuestion: true } : {}),
            ...(runtimeEnv === undefined && credentialResolution === undefined
              ? {}
              : { runtimeEnv: { ...(runtimeEnv ?? {}), ...(credentialResolution?.runtimeEnv ?? {}) } }),
            ...(config.modelId ? { modelId: config.modelId } : {}),
            ...(magpieCodexContextWindow === undefined ? {} : { modelContextWindow: magpieCodexContextWindow }),
            ...(config.effortId ? { effortId: config.effortId } : {}),
            ...(config.serviceTierId ? { serviceTierId: config.serviceTierId } : {}),
            ...(config.translationEnabled === undefined ? {} : { translationEnabled: config.translationEnabled }),
            ...(config.providerSessionId ? { providerSessionId: config.providerSessionId } : {}),
            ...(config.rawStoreRef ? { rawStoreRef: config.rawStoreRef } : {}),
            ...(cwd === undefined ? {} : { cwd }),
            ...(requestSignal === undefined ? {} : { signal: requestSignal }),
            ...((registry.supportsSegmentedTurns(config.adapterId) || registry.supportsToolStepSplitting(config.adapterId))
              // SessionStore/controller 可能是远端代理而未标记 available，但原生
              // Agent 仍然提供 inject；用真实的 next-step 能力决定分段，不能让
              // available 这个聚合状态把 OpenCode/Command Code 退回单 step。
              && nativeSessions?.injectNextStep !== undefined
              && (nativeSessions.canInjectNextStep === undefined
                || nativeSessions.canInjectNextStep(sessionId))
              ? { splitToolSteps: true }
              : {}),
          }
          const projector = new CodingNsDshMessageProjector({
            adapterId: config.adapterId,
            sessionId,
            ...(config.modelId === undefined ? {} : { modelId: config.modelId }),
            ...(permission === undefined ? {} : { permission }),
            ...(nativeSessions === undefined ? {} : { nativeSessions }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            respondPermission: (response) => registry.respondPermission(sessionId, response),
            respondQuestion: (response) => registry.respondQuestion(sessionId, response),
            ...(translation === undefined ? {} : { translation }),
            ...(translation === undefined ? {} : { translationEnabled: config.translationEnabled === true }),
            prefetchQuestionTranslation: questions => {
              const fields = questionTranslationFields(questions)
              if (fields.length === 0) return
              interactionTranslation.prefetch({ sessionId, direction: 'output', fields })
            },
          })
          const discardSuspendedTurn = (): void => registry.discardSegmentedTurn(sessionId)
          input.signal?.addEventListener('abort', discardSuspendedTurn, { once: true })
          if (input.signal?.aborted) discardSuspendedTurn()
          // DSH UI 的会话和子智能体运行点由 api-session/status 驱动。
          // 外部适配器绕过 DSH 原生 Agent Loop，必须在真正执行外部流前补发同一状态，
          // 否则外部子会话完成后虽已写入历史，客户端目录仍不会得到 running -> idle。
          publishExternalStatus(sessionId, true)
          // 分步驱动（OpenCode、Claude、CodeBuddy 等）在工具完成处只结束一个 DSH
          // step：Agent Loop 注入 next-step 后仍停留在同一个 turn 里继续下一步。
          // 这种挂起不是回合结束，本段 llm/stream 返回时不能播报 idle，否则每个
          // 工具完成都会先「已完成」再「进行中」，会话状态随工具调用反复闪烁。
          // 真正的收尾由最后一段的 finish、原生 turn/end 与 agent/status idle 补齐。
          let suspendedForNextStep = false
          try {
            for await (const chunk of registry.execute({ ...input, adapterId: config.adapterId })) {
              if (chunk.type === 'step-boundary') {
                // Agent Loop 会在本次 llm/stream 返回后关闭当前 step，并在返回前
                // 检查 next-step inbox。必须先注入，再发送 finish，不能等 complete()
                // 之后再写入，否则 DSH 已经把整个 turn 结算完了。
                const injected = nativeSessions?.injectNextStep?.(sessionId) ?? false
                if (!injected) discardSuspendedTurn()
                else suspendedForNextStep = true
                for (const dshChunk of await projector.push(chunk)) yield dshChunk
                continue
              }
              for (const dshChunk of await projector.push(chunk)) yield dshChunk
              // DSH 要求 finish 是唯一且最后一个 chunk。这里 return 也会关闭上游迭代器。
              if (projector.isFinished) return
            }
            const reason = input.signal?.aborted ? 'cancel' : 'stop'
            for (const dshChunk of await projector.complete(reason)) yield dshChunk
          } catch (error) {
            const message = safeError(error)
            for (const dshChunk of await projector.fail(message, input.signal?.aborted ?? false)) yield dshChunk
          } finally {
            input.signal?.removeEventListener('abort', discardSuspendedTurn)
            // 挂起续段不是回合结束：这里不能播报 idle，否则每个工具完成都会让会话
            // 状态在「已完成 / 进行中」之间来回闪烁。收尾由最后一段的 finish、
            // 原生 turn/end 与 agent/status idle 补齐。
            if (!suspendedForNextStep) publishExternalStatus(sessionId, false)
          }
        })
        if (typeof dispose === 'function') context.resources.add(() => { (dispose as () => void)() })
      }
      context.resources.add(async () => {
        // DSH 先停用设置上下文再执行异步资源清理时，旧的写队列不能继续调用
        // configEditor，否则会出现 inactive context 并污染退出日志。
        sessionStore.dispose()
        // Close native interaction cards before unloading their provider transports.
        lifetime.abort()
        await magpieSelectionWrites
        updates.dispose()
        magpieUpdates.dispose()
        await management.dispose()
        await registry.dispose()
        await sessionStore.flush()
        setAdapterRegistry(undefined)
      })
    },
  }
}

function requireTeam(context: { services: CodingNsHostServices }) {
  if (context.services.nativeTeam === undefined) throw new Error('DSH_TEAM_NATIVE_UNAVAILABLE')
  return context.services.nativeTeam
}

/**
 * 为外部 Agent 建立单一状态投影出口。
 *
 * DSH 自己的 Agent 状态由原生 SessionController 负责，插件只给已绑定外部
 * 适配器的会话补发状态；未知会话按 DSH 处理，避免误把原生 Agent 标成外部。
 */
function createExternalSessionStatusPublisher(
  events: CodingNsHostServices['events'],
  registry: CodingNsCliAdapterRegistry,
  sessionStore: CodingNsCliSessionStore,
): (sessionId: string, running: boolean) => void {
  const lastPublished = new Map<string, boolean>()
  return (sessionId, running) => {
    const id = sessionId.trim()
    if (id === '' || events?.emit === undefined) return
    const stored = sessionStore.get(id)
    let adapterId = stored?.adapterId
    if (adapterId === undefined) {
      try {
        adapterId = registry.getSession(id).adapterId
      } catch {
        return
      }
    }
    if (adapterId === 'dsh' || adapterId === undefined) return
    if (lastPublished.get(id) === running) return
    try {
      events.emit('api-session/status', id, running)
      lastPublished.set(id, running)
    } catch {
      // 状态提示是 UI 增强能力，不能因为精简 Host 没有完整事件转发器而阻断回合。
    }
  }
}

/**
 * 在 Agent Loop 的可变输入边界消费委派 carrier。
 *
 * `llm/stream` 收到的 LOOP 请求由 DSH 深冻结，监听器只能读取；如果在那里改写
 * `messages`，会直接抛出只读属性异常。`agent/pre-step` 返回的新消息保留用户原文，并把
 * 译文写入 source 元数据；外部适配器再据此构造发给 Agent 的译文。
 */
function registerDelegationAgentHooks(
  dshContext: CodingNsHostServices['dshContext'],
  registry: CodingNsCliAdapterRegistry,
  resources: FeatureResourceScope,
  publishExternalStatus: (sessionId: string, running: boolean) => void,
  translation: CodingNsHostServices['sessionTranslation'],
  translationRecovery: ReturnType<typeof createSessionTranslationRecovery>,
  promptTranslation: ReturnType<typeof createSessionPromptTranslation>,
  credentialBroker: CodingNsHostServices['credentialBroker'],
  nativeSessions?: CodingNsHostServices['nativeSessions'],
  teamInputs?: TeamInputTracker,
): void {
  if (dshContext === undefined || typeof dshContext.on !== 'function') return
  const disposers: Array<() => void> = []
  const register = (name: string, listener: (...args: any[]) => unknown): void => {
    // Wrap existing pre-step producers so their after-next catalogs are visible.
    const disposer = dshContext.on(name as never, listener as never, { global: true, prepend: name === 'agent/pre-step' } as never)
    if (typeof disposer === 'function') disposers.push(disposer as () => void)
  }

  // DSH Agent Loop 会用 agent/request 的 provider/model 生成 assistant/message.source。
  // 外部流虽然在 llm/stream 旁路执行，但如果这里仍保留 DeepSeek 路由，回复历史
  // 就会被错误归属为 DeepSeek。只改写已绑定的外部会话，不影响 DSH 原生会话。
  register('agent/request', async (payload: unknown, next: () => Promise<unknown>) => {
    const resolved = await next()
    const config = asRecord(resolved)
    if (config === null) return resolved
    const sessionId = readAgentSessionId(asRecord(payload)?.agent)
    if (sessionId === '') return config

    let session: CodingNsCliSessionConfig
    try {
      session = registry.getSession(sessionId)
    } catch {
      return config
    }
    if (session.adapterId === 'dsh' && session.teamId && session.providerId && session.modelId) {
      const { reasoningEffort: _effort, ...nativeConfig } = config
      return { ...nativeConfig, provider: session.providerId, model: session.modelId, ...(session.effortId ? { reasoningEffort: session.effortId } : {}) }
    }
    const providerAdapter = fromCliProviderId(config.provider)
    const configuredAdapter = session.adapterId !== 'dsh' && registry.isEnabled(session.adapterId)
      ? session.adapterId
      : providerAdapter !== undefined && registry.isEnabled(providerAdapter)
        ? providerAdapter
        : undefined
    if (configuredAdapter === undefined) return config

    if (session.adapterId === 'dsh') {
      session = registry.setSession(sessionId, {
        adapterId: configuredAdapter,
        ...(typeof config.model === 'string' && config.model.trim() !== '' ? { modelId: config.model.trim() } : {}),
      })
    }
    const model = session.modelId?.trim() || (typeof config.model === 'string' && config.model.trim() !== '' ? config.model.trim() : configuredAdapter)
    // reasoningEffort 属于被改写掉的那条 DSH 原生路由（例如全局默认模型 glor/deepseek-v4.1-flash
    // 的 max）。外部 CLI 的虚拟 Provider 不声明任何思考强度，DSH 会在准入阶段以
    // UNSUPPORTED_REASONING_EFFORT 拒绝整轮；外部 Agent 的思考强度由适配器自己的
    // effortId 偏好驱动，因此这里必须丢弃继承值，只改写 provider/model。
    const { reasoningEffort: _inheritedReasoningEffort, ...routeConfig } = config
    return { ...routeConfig, provider: toCliProviderId(configuredAdapter), model }
  })

  register('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
    const record = asRecord(payload)
    const sessionId = readAgentSessionId(record?.agent)
    let messages = Array.isArray(record?.messages) ? record.messages.filter(isMessage) : []
    let delegation: ReturnType<typeof rewriteDelegationMessages> | undefined
    if (containsDelegationCarrier(messages)) {
      delegation = rewriteDelegationMessages(messages, await registry.catalogForUse(delegationAdapterIds(messages)))
      if (delegation.kind === 'error') clearDelegationAuthorization(sessionId)
      else if (delegation.kind === 'rewritten') {
        setDelegationAuthorization(sessionId, delegation.value.targets)
        messages = [...delegation.value.messages]
      }
    }

    let translatedInput: readonly (CodingNsCliMessage | undefined)[] | undefined
    try {
      translatedInput = await translatePreStepInput(
        translation,
        translationRecovery,
        registry,
        sessionId,
        messages,
        dshContext,
        isAbortSignal(record?.signal) ? record.signal : undefined,
        nativePreStepContext(translation, registry, sessionId, nativeSessions),
      )
    } catch (error) {
      if (error instanceof SessionTranslationCancelled || record?.signal?.aborted === true) return { kind: 'reject' }
      throw error
    }
    const decision = await next()
    if (!isEnterPreStepDecision(decision)) return decision
    // Match producer-owned messages by identity. Downstream middleware may insert
    // instructions before the human message, so a positional prefix loses data.
    const incoming = Array.isArray(record?.messages) ? record.messages.filter(isMessage) : []
    const replaced = new Set<number>()
    const replacements = translatedInput ?? messages
    const accepted = delegation?.kind === 'rewritten' || translatedInput !== undefined
      ? decision.messages.flatMap(message => {
        const index = incoming.findIndex((original, position) => !replaced.has(position) && (
          original === message || typeof original.id === 'string' && original.id === message.id
          // Legacy callers can return detached messages without durable IDs.
          || original.id === undefined && message.id === undefined && original.role === message.role
            && original.source?.kind === message.source?.kind && original.source?.form === message.source?.form
            && JSON.stringify(original.content) === JSON.stringify(message.content)
        ))
        if (index >= 0) replaced.add(index)
        if (index < 0) return [message]
        const replacement = replacements[index]
        return replacement === undefined ? [] : [replacement]
      }) : decision.messages
    try {
      const scope = sessionPromptScope(record?.agent, isAbortSignal(record?.signal) ? record.signal : undefined)
      const translated = await promptTranslation.translateMessages(accepted, scope)
      if (registry.getSession(sessionId).adapterId !== 'dsh') teamInputs?.accept(sessionId, translated)
      return { ...decision, messages: translated }
    } catch (error) {
      if (error instanceof SessionTranslationCancelled || record?.signal?.aborted === true) return { kind: 'reject' }
      throw error
    }
  })

  // 正常结束、异常结束和中断最终都会进入 idle；在此清理本轮授权，避免下一轮
  // 没有 carrier 时继承上一轮的目标白名单。
  register('agent/status', (payload: unknown) => {
    const record = asRecord(payload)
    const sessionId = readAgentSessionId(record?.agent)
    if (record?.status === 'running') publishExternalStatus(sessionId, true)
    else if (record?.status === 'idle') {
      translationRecovery.cancelSession(sessionId)
      publishExternalStatus(sessionId, false)
      clearDelegationAuthorization(sessionId)
    }
  })
  register('agent/disposed', (payload: unknown) => {
    const sessionId = readAgentSessionId(asRecord(payload)?.agent)
    teamInputs?.release(sessionId)
    credentialBroker?.revokeSession(sessionId)
    getSubagentBridge()?.revokeTeamSession?.(sessionId)
    translationRecovery.cancelSession(sessionId)
    // disposed 只代表运行时释放；subagentCatalog 没有删除语义，保留目录项并
    // 把它标成 idle，后续若 DSH 重新激活会再次收到 running。
    publishExternalStatus(sessionId, false)
    clearDelegationAuthorization(sessionId)
  })

  resources.add(() => {
    for (const dispose of disposers.reverse()) dispose()
  })
}

function isEnterPreStepDecision(value: unknown): value is { kind: 'enter'; messages: readonly CodingNsCliMessage[] } {
  const record = asRecord(value)
  return record?.kind === 'enter' && Array.isArray(record.messages)
}

/**
 * 翻译调用优先使用显式字段；若 DSH 在进入 waterfall 前规范化请求并丢掉未知字段，
 * 再用 system 提示里的稳定标记识别。否则翻译请求会被误当成当前外部 Agent 回合。
 */
function isSessionTranslationLlmRequest(value: Record<string, any> | null): boolean {
  if (value?.codingnsTranslation === true) return true
  if (typeof value?.system === 'string' && value.system.includes('CODINGNS_SESSION_TRANSLATION_V1')) return true
  if (!Array.isArray(value?.messages)) return false
  return value.messages.some((message: unknown) => {
    const record = asRecord(message)
    if (record?.role !== 'system' || !Array.isArray(record.content)) return false
    return record.content.some((part: unknown) => asRecord(part)?.text?.includes?.('CODINGNS_SESSION_TRANSLATION_V1') === true)
  })
}

function readAgentSessionId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.id === 'string' && record.id.trim() !== '') return record.id.trim()
  const session = asRecord(record?.session)
  if (typeof session?.id === 'string' && session.id.trim() !== '') return session.id.trim()
  const header = asRecord(session?.header)
  return typeof header?.id === 'string' ? header.id.trim() : ''
}

/** DSH Context 可能在测试或嵌入式宿主里缺少目标服务；缺失时按不可用处理。 */
function readOptionalContextService(ctx: CodingNsHostServices['dshContext'], name: string): unknown {
  if (ctx === undefined) return undefined
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 将 DSH 原生 session/modelCatalog 归一化为委派选择器复用的模型目录契约。 */
async function readDshModelCatalog(ctx: CodingNsHostServices['dshContext']): Promise<CodingNsCliModelCatalog> {
  const controller = readOptionalContextService(ctx, 'sessionController')
  if (isRecord(controller) && typeof controller.modelCatalog === 'function') {
    try {
      const raw = await controller.modelCatalog()
      const record = asRecord(raw)
      const groups = Array.isArray(record?.groups)
        ? record.groups.flatMap((group) => normalizeDshModelGroup(group))
        : []
      const defaultSelection = asRecord(record?.default)
      const defaultModel = typeof defaultSelection?.model === 'string' && defaultSelection.model.trim() !== '' ? defaultSelection.model.trim() : null
      const defaultEffort = typeof defaultSelection?.reasoningEffort === 'string' && defaultSelection.reasoningEffort.trim() !== '' ? defaultSelection.reasoningEffort.trim() : null
      if (groups.length > 0) return { groups, currentModel: defaultModel, currentEffort: defaultEffort }
      if (defaultModel !== null) return { groups: [{ id: 'dsh', name: 'DeepSeek Harness', models: [{ id: defaultModel, name: defaultModel, efforts: defaultEffort === null ? [] : [defaultEffort] }] }], currentModel: defaultModel, currentEffort: defaultEffort }
    } catch (error) {
      debugInfo('codingns4dsh: DSH 模型目录读取失败', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  // 精简 Host 没有 sessionController 时仍给出稳定的“跟随 DSH 当前模型”选项，
  // 这样 dsh 目标不会退化成无模型可选，实际请求继续沿用 DSH 当前路由。
  return { groups: [{ id: 'dsh', name: 'DeepSeek Harness', models: [{ id: 'provider-default', name: '跟随 DSH 当前模型', efforts: [] }] }], currentModel: 'provider-default', currentEffort: null, fallback: true }
}

function normalizeDshModelGroup(value: unknown): CodingNsCliModelCatalog['groups'][number] {
  const record = asRecord(value)
  const id = typeof record?.id === 'string' && record.id.trim() !== '' ? record.id.trim() : 'dsh'
  const name = typeof record?.name === 'string' && record.name.trim() !== '' ? record.name.trim() : id
  const models = Array.isArray(record?.models) ? record.models.flatMap((item) => {
    const model = asRecord(item)
    const modelId = typeof model?.id === 'string' ? model.id.trim() : ''
    if (modelId === '') return []
    const reasoning = asRecord(model?.reasoning)
    const efforts = Array.isArray(reasoning?.efforts)
      ? reasoning.efforts.flatMap((effort) => typeof asRecord(effort)?.id === 'string' ? [String(asRecord(effort)?.id)] : [])
      : []
    return [{ id: modelId, name: typeof model?.name === 'string' && model.name.trim() !== '' ? model.name.trim() : modelId, ...(typeof model?.description === 'string' && model.description.trim() !== '' ? { description: model.description.trim() } : {}), efforts }]
  }) : []
  return { id, name, models }
}

/**
 * DSH 原生 Provider 可能只返回一个 finish(stop)。不能把这个空回合当作成功，
 * 否则 Session 会落下一条空 assistant/message，用户只能看到“一秒结束”。
 *
 * error finish 携带 Provider 的真实失败原因（状态码、上游错误消息、错误码），
 * 必须原样透传：替换成统一文案会把 400/429/凭证失效等不同故障折叠成同一句
 * “未返回任何有效事件”，既无法排查也不可分类告警。统一兜底文案只用于一种
 * 情形——流以 stop（或无 finish）干净结束且没有任何有效事件，此时没有任何
 * 原始错误可透传。
 */
async function* guardDshNativeStream(next: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
  let meaningful = false
  const terminal: unknown[] = []
  for await (const chunk of next()) {
    if (isDshFinishChunk(chunk)) {
      // error finish 本身就是“有效事件”：立即透传，并标记 meaningful，
      // 让此前缓冲的非 error finish（正常情况下不会出现）也在收尾时放出。
      if (isDshErrorFinishChunk(chunk)) {
        meaningful = true
        yield chunk
        continue
      }
      terminal.push(chunk)
      continue
    }
    meaningful ||= isMeaningfulDshChunk(chunk)
    yield chunk
  }
  if (meaningful) {
    for (const chunk of terminal) yield chunk
    return
  }
  const message = 'CODINGNS_PROVIDER_EMPTY_RESPONSE: DSH Provider 未返回任何有效事件。'
  yield { type: 'block-start', index: 1, blockType: 'text' }
  yield { type: 'text-delta', index: 1, text: message }
  yield { type: 'block-end', index: 1, block: { type: 'text', text: message } }
  yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } }
}

/** carrier 解析失败也必须以可读的 DSH 错误事件结束当前轮次。 */
async function* delegationErrorStream(message: string): AsyncIterable<unknown> {
  yield { type: 'block-start', index: 1, blockType: 'text' }
  yield { type: 'text-delta', index: 1, text: message }
  yield { type: 'block-end', index: 1, block: { type: 'text', text: message } }
  yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'DELEGATE_ERROR' } } }
}

function isDshFinishChunk(value: unknown): boolean {
  const record = asRecord(value)
  return record?.type === 'finish'
}

/** error finish（reason.kind === 'error'）携带 Provider 的原始失败，是必须透传的有效事件。 */
function isDshErrorFinishChunk(value: unknown): boolean {
  const record = asRecord(value)
  return record?.type === 'finish' && asRecord(record.reason)?.kind === 'error'
}

function isMeaningfulDshChunk(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  if (record.type === 'text-delta' || record.type === 'reasoning-delta' || record.type === 'usage' || record.type === 'tool-call-delta' || record.type === 'tool-call' || record.type === 'tool-result') return true
  if (record.type === 'block-end') {
    const block = asRecord(record.block)
    return block?.type === 'tool-call' || block?.type === 'tool-result' || typeof block?.text === 'string' && block.text !== ''
  }
  return false
}

function readAdapterId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.adapterId !== 'string' || record.adapterId.trim() === '') throw new Error('adapterId 不能为空')
  return record.adapterId.trim()
}

function readSubscriptionRequest(value: unknown): { adapterId: string; sessionId?: string; providerId?: string; modelId?: string; includeRoute: boolean } {
  const record = asRecord(value)
  if (record === null || record.adapterId === undefined) return { adapterId: 'command-code', includeRoute: false }
  const adapterId = readAdapterId(value)
  return {
    adapterId,
    ...(typeof record.sessionId === 'string' && record.sessionId.trim() !== '' ? { sessionId: record.sessionId.trim() } : {}),
    includeRoute: record.includeRoute === true,
    ...(typeof record.providerId === 'string' && record.providerId.trim() !== '' ? { providerId: record.providerId.trim() } : {}),
    // Antigravity 用会话模型区分 Gemini 与 Claude/GPT 两个独立配额组。
    ...(typeof record.modelId === 'string' && record.modelId.trim() !== '' ? { modelId: record.modelId.trim() } : {}),
  }
}

/** 重置请求必须显式给出适配器；缺省回退 command-code 会让重置落到错误的 Agent。 */
function readSubscriptionResetRequest(value: unknown): { adapterId: string; providerId?: string } {
  const record = asRecord(value)
  if (record === null || record.adapterId === undefined) throw new Error('adapterId 不能为空')
  return readSubscriptionRequest(value)
}

function readSessionId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.sessionId !== 'string' || record.sessionId.trim() === '') throw new Error('sessionId 不能为空')
  return record.sessionId.trim()
}

/** `/委派` 请求：父会话、目标适配器与自包含任务描述。 */
function readDelegateRequest(value: unknown): { sessionId: string; adapterId: string; prompt: string; modelId?: string } {
  const record = asRecord(value)
  const sessionId = readSessionId(value)
  const adapterId = readAdapterId(value)
  // 这里不能复用 readPrompt：旧 Client 可能仍传入空 prompt，空串要交给派发内核返回
  // 结构化空任务错误；不得读取历史消息补齐任务。
  const rawPrompt = record?.prompt
  if (rawPrompt !== undefined && typeof rawPrompt !== 'string') throw new Error('prompt 必须是字符串')
  const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : ''
  return {
    sessionId,
    adapterId,
    prompt,
    ...(typeof record?.modelId === 'string' && record.modelId.trim() !== '' ? { modelId: record.modelId.trim() } : {}),
  }
}

function readSessionConfig(value: unknown): CodingNsCliSessionConfig {
  const record = asRecord(value)
  const adapterId = readAdapterId(record)
  return {
    adapterId,
    ...(typeof record?.modelId === 'string' && record.modelId.trim() ? { modelId: record.modelId.trim() } : {}),
    ...(typeof record?.effortId === 'string' && record.effortId.trim() ? { effortId: record.effortId.trim() } : {}),
    // `default` 是显式的“标准速度”选择，不能当作空值丢弃，否则关掉 Fast 会被
    // Registry 回退成上一次记住的加速档。
    ...(typeof record?.serviceTierId === 'string' && record.serviceTierId.trim() ? { serviceTierId: record.serviceTierId.trim() } : {}),
    ...(typeof record?.translationEnabled === 'boolean' ? { translationEnabled: record.translationEnabled } : {}),
    ...(typeof record?.providerId === 'string' && record.providerId.trim() ? { providerId: record.providerId.trim() } : {}),
    ...(typeof record?.providerSessionId === 'string' && record.providerSessionId.trim() ? { providerSessionId: record.providerSessionId.trim() } : {}),
    ...(typeof record?.rawStoreRef === 'string' && record.rawStoreRef.trim() ? { rawStoreRef: record.rawStoreRef.trim() } : {}),
    ...(Array.isArray(record?.credentialRefs) ? { credentialRefs: record.credentialRefs.filter(isCredentialReference) } : {}),
  }
}

function readSessionListOptions(value: unknown): { includeArchived?: boolean; adapterId?: string } {
  const record = asRecord(value)
  const adapterId = typeof record?.adapterId === 'string' && record.adapterId.trim() ? record.adapterId.trim() : undefined
  const includeArchived = record?.includeArchived === true ? true : undefined
  return {
    ...(adapterId ? { adapterId } : {}),
    ...(includeArchived === true ? { includeArchived: true } : {}),
  }
}

function readSkillsRequest(value: unknown): { readonly sessionId: string; readonly forceReload: boolean } {
  const record = asRecord(value)
  return {
    sessionId: readSessionId(value),
    forceReload: record?.forceReload === true,
  }
}

function readPrompt(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.prompt !== 'string' || record.prompt.trim() === '') throw new Error('prompt 不能为空')
  return record.prompt.trim()
}

/** 从 DSH 原生 llm/stream 请求头捕获当前模型和思考强度。 */
function readDshSelection(value: Record<string, any> | null): { modelId?: string; effortId?: string; providerId?: string } {
  const candidates = [
    value,
    asRecord(value?.request),
    asRecord(value?.config),
    asRecord(value?.header),
    ...readModelSelectionCandidates(value),
  ]
  const read = (keys: readonly string[]): string | undefined => {
    for (const candidate of candidates) {
      for (const key of keys) {
        const result = candidate?.[key]
        if (typeof result === 'string' && result.trim() !== '') return result.trim()
      }
    }
    return undefined
  }
  const modelId = read(['model', 'modelId'])
  const effortId = read(['reasoningEffort', 'effortId', 'thinking'])
  const providerId = read(['provider', 'providerId', 'providerName'])
  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(effortId === undefined ? {} : { effortId }),
    ...(providerId === undefined ? {} : { providerId }),
  }
}

/** 读取 DSH/Host 明确下发给外部 CLI 的运行选项；缺省值不改变 Provider 行为。 */
function readCliTurnOptions(value: Record<string, any> | null): {
  readonly plan?: boolean
  readonly forkSession?: boolean
  readonly enableAskUserQuestion?: boolean
} {
  const candidates = [
    value,
    asRecord(value?.options),
    asRecord(value?.request),
    asRecord(asRecord(value?.request)?.options),
    asRecord(value?.config),
  ]
  const read = (keys: readonly string[]): boolean => candidates.some((candidate) => keys.some((key) => candidate?.[key] === true))
  const plan = read(['plan'])
  const forkSession = read(['forkSession', 'fork'])
  const enableAskUserQuestion = read(['enableAskUserQuestion', 'askUserQuestion'])
  return {
    ...(plan ? { plan: true } : {}),
    ...(forkSession ? { forkSession: true } : {}),
    ...(enableAskUserQuestion ? { enableAskUserQuestion: true } : {}),
  }
}

/** 父仓库通过运行时环境开启 ask_user_question；保留同一兼容入口。 */
function readCliRuntimeEnv(value: Record<string, any> | null): Readonly<Record<string, string>> | undefined {
  const candidate = asRecord(value?.runtimeEnv) ?? asRecord(asRecord(value?.options)?.runtimeEnv)
  if (candidate === null) return undefined
  // The only browser/DSH compatibility variable is a boolean feature switch.
  // Credential values must come from Host-owned references, never from this payload.
  const entries = Object.entries(candidate)
    .filter(([name, item]) => name === 'CMD_TOOLS_ASK_USER_QUESTION_ENABLE' && item === 'true') as [string, string][]
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

async function resolveCredentialEnvironment(
  service: CodingNsHostServices['credentials'],
  broker: CodingNsHostServices['credentialBroker'],
  sessionId: string,
  references: CodingNsCliSessionConfig['credentialRefs'],
  carriers: readonly CredentialCarrier[] = [],
  reuseExisting = false,
): Promise<{
  readonly runtimeEnv: Readonly<Record<string, string>>
  readonly environmentNames: readonly string[]
  readonly requestCodes: readonly {
    readonly requestCode: string
    readonly label: string
    readonly bindings: readonly CredentialBrokerBinding[]
  }[]
} | undefined> {
  if ((references === undefined || references.length === 0) && carriers.length === 0) return undefined
  if (service === undefined || broker === undefined) throw new CodingNsRpcError('CREDENTIAL_BROKER_UNAVAILABLE', 'Credential broker is unavailable')
  const processEnvironment = broker.processEnvironment(sessionId)
  const requestCodes: Array<{
    readonly requestCode: string
    readonly label: string
    readonly bindings: readonly CredentialBrokerBinding[]
  }> = []
  for (const reference of references ?? []) {
    const issued = await broker.issue({ sessionId, credentialId: reference.credentialId, bindings: reference.bindings, reuseExisting })
    requestCodes.push(issued)
  }
  for (const carrier of carriers) {
    requestCodes.push(await broker.resolveCarrier(sessionId, carrier.requestCode, carrier.label))
  }
  const environmentNames = requestCodes.flatMap((item) => item.bindings.map((binding) => binding.env))
  if (new Set(environmentNames).size !== environmentNames.length) {
    throw new CodingNsRpcError('CREDENTIAL_ENV_CONFLICT', 'Credential environment names must be unique')
  }
  return {
    runtimeEnv: {
      CODINGNS_CREDENTIAL_BROKER_ENDPOINT: processEnvironment.endpoint,
      CODINGNS_CREDENTIAL_BROKER_TOKEN: processEnvironment.token,
      CODINGNS_CREDENTIAL_SESSION: processEnvironment.sessionId,
      PATH: processEnvironment.path,
    },
    environmentNames: [...new Set(environmentNames)].sort(),
    requestCodes,
  }
}

export function formatCredentialUsageNotice(
  resolution: Awaited<ReturnType<typeof resolveCredentialEnvironment>> | undefined,
  nativeToolAvailable = false,
): string {
  if (resolution === undefined || resolution.requestCodes.length === 0) return ''
  const codes = resolution.requestCodes.map((item) => [
    `- ${item.label}: ${item.requestCode}`,
    ...item.bindings.map((binding) => `  ${binding.field} -> ${binding.env} (${binding.kind}; ${binding.usages.join(', ')})`),
  ].join('\n')).join('\n')
  const usage = nativeToolAvailable
    ? [
      'Use the native `codingns_credential` tool, not a shell command, to consume this credential.',
      'Call it with action="exec", the request code, and a command array. For SSH, use `sh -lc` so the broker-provided username expands inside the broker environment; the broker configures SSH askpass for SSH secret bindings.',
      'Example command array: ["sh", "-lc", "exec ssh -o IdentityAgent=none -o IdentitiesOnly=yes -o PubkeyAuthentication=no -o PreferredAuthentications=' + 'pass' + 'word,keyboard-interactive -o NumberOfPasswordPrompts=1 -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \\\"$CREDENTIAL_USERNAME@HOST\\\" \\\"printf ssh-login-ok\\\""]',
    ]
    : [
      'If the native `codingns_credential` tool is available, prefer it: call action="exec" with the request code and a command argv array. Otherwise use the credential CLI shown below.',
      'Use `codingns-credential exec --code <request-code> -- <command>` or `codingns-credential exec --handle <handle> -- <command>` after describe.',
      'For SSH, the broker configures SSH askpass for SSH secret bindings. Run SSH inside a child shell so the username environment variable expands there, and disable unrelated SSH-agent keys with `-o IdentityAgent=none -o IdentitiesOnly=yes -o PubkeyAuthentication=no -o PreferredAuthentications=' + 'pass' + 'word,keyboard-interactive -o NumberOfPasswordPrompts=1`.',
      'CLI example: `codingns-credential exec --code <request-code> -- sh -lc \'exec ssh -o IdentityAgent=none -o IdentitiesOnly=yes -o PubkeyAuthentication=no -o PreferredAuthentications=' + 'pass' + 'word,keyboard-interactive -o NumberOfPasswordPrompts=1 "$CREDENTIAL_USERNAME@HOST" "printf ssh-login-ok"\'`.',
    ]
  return [
    'CodingNS credential broker is available for this Agent.',
    ...(nativeToolAvailable ? [] : ['Use `codingns-credential describe --code <request-code>` to inspect bindings without reading secret values; it returns a handle for later execution.']),
    ...usage,
    'The request codes and environment names below are session-scoped. Never print credential values or open the credential store.',
    codes,
  ].join('\n')
}

/** Compatibility formatter for callers that only have environment names. */
export function formatCredentialEnvironmentNotice(environmentNames: readonly string[]): string {
  const names = [...new Set(environmentNames.map((name) => name.trim()).filter((name) => name !== ''))].sort()
  if (names.length === 0) return ''
  return [
    'The selected CodingNS credential is available to this Agent through these process environment variables:',
    names.map((name) => `- ${name}`).join('\n'),
    'Read these variables from the process environment when a tool or command needs the credential. Never print their values in chat, logs, or tool output.',
  ].join('\n')
}

/** Prefer the pending/next DSH route because lastUsed may still be stale. */
function readModelSelectionCandidates(value: Record<string, any> | null): Record<string, any>[] {
  const result: Record<string, any>[] = []
  for (const candidate of [value, asRecord(value?.request), asRecord(value?.config), asRecord(value?.header), asRecord(asRecord(value?.record)?.rows)]) {
    const selection = asRecord(candidate?.modelSelection)
    if (selection !== null) result.push(selection)
    const lastUsed = asRecord(selection?.lastUsed)
    const next = asRecord(selection?.next)
    const pending = asRecord(selection?.pending)
    if (pending !== null) result.push(pending)
    if (next !== null) result.push(next)
    if (lastUsed !== null) result.push(lastUsed)
  }
  return result
}

/**
 * 分叉子会话的绑定来自父会话，迁移时必须把祖先链一起交给 SessionStore。
 * 只传子会话会让继承逻辑找不到父记录，子会话继续停留在 dsh。
 */
function collectMigrationChain(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  session: unknown,
): readonly unknown[] {
  const chain: unknown[] = [session]
  const seen = new Set<string>()
  let current = session
  for (let depth = 0; depth < 16; depth += 1) {
    const record = asRecord(current)
    const header = asRecord(record?.header)
    const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession.trim() : ''
    if (parentSessionId === '' || seen.has(parentSessionId)) break
    seen.add(parentSessionId)
    const parent = nativeSessions?.get(parentSessionId)
    if (parent === undefined) break
    chain.push(parent)
    current = parent
  }
  // 先迁移祖先再迁移子会话，深层 fork 不依赖下一轮轮询补齐中间父节点。
  return chain.reverse()
}

function selectExternalAdapter(
  selectedProvider: string | undefined,
  messageAdapter: string | undefined,
  registry: CodingNsCliAdapterRegistry,
): string | undefined {
  for (const candidate of [selectedProvider, messageAdapter]) {
    if (candidate !== undefined && candidate !== 'dsh' && registry.isEnabled(candidate)) return candidate
  }
  return undefined
}

/** 从当前会话历史恢复外部路由，覆盖 DSH 第二轮省略 provider 的请求形态。 */
function inferMessageAdapter(messages: readonly CodingNsCliMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = asRecord((messages[index] as unknown as Record<string, unknown>).source)
    if (source?.kind !== 'model') continue
    const provider = typeof source.provider === 'string' ? source.provider.trim() : undefined
    // Legacy raw providers need explicit plugin metadata; native API brands can
    // have the same names as CLI adapters. The latest model source is decisive.
    return fromCliProviderId(provider)
      ?? (typeof source.adapterId === 'string' ? source.adapterId : undefined)
      ?? (source.plugin === 'codingns4dsh' ? provider : undefined)
  }
  return undefined
}

async function setAdapterEnabled(
  settings: CodingNsHostServices['settings'],
  registry: CodingNsCliAdapterRegistry,
  value: unknown,
): Promise<{ adapterId: string; enabled: boolean }> {
  const record = asRecord(value)
  const adapterId = readAdapterId(record)
  if (typeof record?.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
  const enabled = registry.setEnabled(adapterId, record.enabled)
  if (settings !== undefined) await settings.update({ agentAdapters: registry.enabledSnapshot() })
  return { adapterId, enabled }
}

/** 运行中的外部 Agent 插话也必须经过同一条输入翻译路径。 */
async function translateSteerPrompt(
  translationRecovery: ReturnType<typeof createSessionTranslationRecovery>,
  registry: CodingNsCliAdapterRegistry,
  sessionId: string,
  prompt: string,
  followUp: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const session = registry.getSession(sessionId)
  let translated = prompt
  if (session.translationEnabled === true) {
    try {
      translated = (await translationRecovery.translateInput(sessionId, session.adapterId, prompt, signal)).translated
    } catch (error) {
      if (error instanceof SessionTranslationCancelled) return
      throw error
    }
  }
  signal?.throwIfAborted()
  await registry.steer(sessionId, translated, followUp)
}

/**
 * 在 Agent Loop 接受本轮输入时生成一次输入译文。
 *
 * DSH 随后会把返回的消息写入 `user/message`。正文只放实际发送的译文；原文和模型
 * 记录在 source 元数据中供 Client 详情按钮读取。外部 CLI 边界也会移除该元数据。
 */
async function translatePreStepInput(
  translation: CodingNsHostServices['sessionTranslation'],
  translationRecovery: ReturnType<typeof createSessionTranslationRecovery>,
  registry: CodingNsCliAdapterRegistry,
  sessionId: string,
  messages: readonly CodingNsCliMessage[],
  dshContext: CodingNsHostServices['dshContext'],
  signal?: AbortSignal,
  nativeSession?: { readonly adapterId: string; readonly translationEnabled: boolean },
): Promise<readonly (CodingNsCliMessage | undefined)[] | undefined> {
  if (translation === undefined || !translation.enabled || sessionId.trim() === '') return undefined
  if (messages.some(isTeamInputMessage)) {
    const next: Array<CodingNsCliMessage | undefined> = []
    for (const message of messages) {
      // Team protocol text keeps its sender and machine-owned body. Human
      // messages accepted at the same boundary still use submission recovery.
      try {
        const translated = isHumanUserMessage(message)
          ? await translatePreStepInput(translation, translationRecovery, registry, sessionId, [message], dshContext, signal, nativeSession)
          : undefined
        next.push(translated?.[0] ?? message)
      } catch (error) {
        if (!(error instanceof SessionTranslationCancelled) || signal?.aborted) throw error
        // Cancelling one submission does not cancel independently accepted
        // Team work. Keep the original positions until pre-step producers merge.
        next.push(undefined)
      }
    }
    return next.some((message, index) => message !== messages[index]) ? next : undefined
  }

  const messageIndex = findLatestHumanMessage(messages)
  const current = messageIndex < 0 ? undefined : messages[messageIndex]
  if (current === undefined || readInputTranslation(current.source) !== undefined) return undefined

  if (nativeSession !== undefined) {
    // DSH 原生会话：消息本身就是发给 Provider 的正文，直接替换为译文并把原文留在元数据。
    if (nativeSession.translationEnabled !== true || !isSessionTranslationInputEnabled(translation, nativeSession.adapterId)) return undefined
    const input = extractTurnInput(messages, dshContext)
    if (input.prompt.trim() === '') return undefined
    const result = await translationRecovery.translateInput(sessionId, nativeSession.adapterId, input.translationPrompt, signal)
    const translated = [result.translated, attachmentNotices(input.attachments, readInputTargetLanguage(translation))].filter((part) => part.trim() !== '').join('\n\n').trim()
    if (translated === '') return undefined
    const record: SessionTranslationInputRecord = {
      original: input.prompt,
      translated,
      ...(result.sourceLanguage === undefined ? {} : { sourceLanguage: result.sourceLanguage }),
      targetLanguage: readInputTargetLanguage(translation),
      ...(result.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
      ...(result.model === undefined ? {} : { model: result.model }),
      ...readSessionTranslationDiagnostics(result),
      ...readSessionTranslationMetrics(result),
      ...(result.failed === true ? { failed: true } : {}),
    }
    const next = [...messages]
    next[messageIndex] = {
      ...current,
      content: result.failed ? current.content : replaceInputTranslationContent(nativeTranslationContent(current.content, dshContext), translated),
      source: { ...(current.source ?? {}), kind: 'user', codingnsTranslationInput: record },
    }
    return next
  }

  let session: CodingNsCliSessionConfig
  try {
    session = registry.getSession(sessionId)
  } catch {
    return undefined
  }
  if (session.adapterId === 'dsh' || session.translationEnabled !== true || !isSessionTranslationInputEnabled(translation, session.adapterId)) return undefined

  const input = extractTurnInput(messages, dshContext)
  if (input.prompt.trim() === '') return undefined

  const result = await translationRecovery.translateInput(sessionId, session.adapterId, input.translationPrompt, signal)
  const translated = [result.translated, attachmentNotices(input.attachments, readInputTargetLanguage(translation))]
    .filter((part) => part.trim() !== '')
    .join('\n\n')
    .trim()
  if (translated === '') return undefined

  const record: SessionTranslationInputRecord = {
    original: input.prompt,
    translated,
    ...(result.sourceLanguage === undefined ? {} : { sourceLanguage: result.sourceLanguage }),
    targetLanguage: readInputTargetLanguage(translation),
    ...(result.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
    ...(result.model === undefined ? {} : { model: result.model }),
    ...readSessionTranslationDiagnostics(result),
    ...readSessionTranslationMetrics(result),
    ...(result.failed === true ? { failed: true } : {}),
  }
  const next = [...messages]
  next[messageIndex] = {
    ...current,
    source: {
      ...(current.source ?? {}),
      kind: 'user',
      codingnsTranslationInput: record,
    },
  }
  return next
}

/** 旧测试替身没有 inputLanguage 时沿用历史默认值英语。 */
function readInputTargetLanguage(translation: NonNullable<CodingNsHostServices['sessionTranslation']>): SessionTranslationInputRecord['targetLanguage'] {
  const language = translation.inputLanguage
  return language === undefined ? 'en' : language
}

/**
 * 判断本次 pre-step 是否按 DSH 原生会话翻译。
 *
 * 原生会话的翻译记录来自全局 `nativeEnabled` 与适配器偏好（会话索引对 `dsh` 不落盘），
 * 子代理与插件自己的助理会话必须排除，避免把内部执行流水线翻译掉。
 */
function nativePreStepContext(
  translation: CodingNsHostServices['sessionTranslation'],
  registry: CodingNsCliAdapterRegistry,
  sessionId: string,
  nativeSessions: CodingNsHostServices['nativeSessions'],
): { readonly adapterId: string; readonly translationEnabled: boolean } | undefined {
  if (translation === undefined || !translation.enabled || sessionId.trim() === '') return undefined
  if (isAssistantSession(sessionId)) return undefined
  if (readNativeSessionHeader(nativeSessions, sessionId)?.origin === 'subagent') return undefined
  let session: CodingNsCliSessionConfig
  try {
    session = registry.getSession(sessionId)
  } catch {
    return undefined
  }
  if (session.adapterId !== DSH_NATIVE_SESSION_ADAPTER_ID) return undefined
  return {
    adapterId: DSH_NATIVE_SESSION_ADAPTER_ID,
    // 会话级开关优先；用户没有单独设置过该会话时跟随「DSH 原生会话」总开关。
    translationEnabled: session.translationEnabled ?? translation.nativeEnabled === true,
  }
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

/** 原生 Provider 选中的模型，用于在 Magpie 会话身份可读之前判断该模型是否由 Magpie 提供。 */
function readNativeModelSelection(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  sessionId: string,
): { readonly providerId?: string; readonly modelId: string } | undefined {
  if (nativeSessions === undefined) return undefined
  const current = nativeSessions.modelSelection?.(sessionId)
  if (current !== undefined && current.model.trim() !== '') {
    const provider = current.provider.trim()
    return provider === '' ? { modelId: current.model.trim() } : { providerId: provider, modelId: current.model.trim() }
  }
  let session: unknown
  try { session = nativeSessions.get(sessionId) } catch { return undefined }
  const root = asRecord(session)
  const selection = asRecord(root?.modelSelection) ?? asRecord(asRecord(asRecord(root?.record)?.rows)?.modelSelection)
  const value = asRecord(selection?.val) ?? selection
  // 待用的 pending/next 优先；lastUsed 可能仍描述上一个模型。
  for (const candidate of [asRecord(value?.pending), asRecord(value?.next), asRecord(value?.lastUsed)]) {
    const modelId = readOptionalText(candidate?.model)
    if (modelId === undefined) continue
    const providerId = readOptionalText(candidate?.provider)
    return providerId === undefined ? { modelId } : { providerId, modelId }
  }
  return undefined
}

/** Magpie 网关只监听本机回环；Provider 指向这里时才算 Magpie 自己的路由。 */
const MAGPIE_GATEWAY_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function isMagpieGateway(baseUrl: string): boolean {
  try {
    const target = new URL(baseUrl)
    // 端口由 `magpie web` 绑定（默认 3425），配置里改端口也应视为同一网关，
    // 因此这里只要求回环地址，不再硬编码端口。
    return MAGPIE_GATEWAY_HOSTS.has(target.hostname)
  } catch {
    return false
  }
}

/**
 * Provider ID 本身可能是任意用户命名，因此先看 DSH 配置里的 baseURL；
 * 配置读不到时只接受与 `readDshDefaultProvider()` 相同的 Magpie 名称约定。
 */
function isMagpieGatewayProvider(providerId: string): boolean {
  const source = readDshProviderSource(providerId)
  if (source !== null) return isMagpieGateway(source.baseUrl)
  return /^magpie(?:[-_.].*)?$/iu.test(providerId)
}

/** Resolve the exact identities needed for one Magpie context read. */
async function resolveMagpieContextTarget(
  sessionId: string,
  sessionStore: CodingNsCliSessionStore,
  nativeSessions: CodingNsNativeSessionBridge | undefined,
  magpieUsage: MagpieUsageService,
  signal: AbortSignal,
): Promise<MagpieContextRequestOptions | null> {
  const normalizedSessionId = sessionId.trim()
  if (normalizedSessionId === '') return null
  let stored = sessionStore.get(normalizedSessionId)
  if (stored === undefined && nativeSessions !== undefined) {
    try { await nativeSessions.ensure(normalizedSessionId); signal.throwIfAborted() } catch { return null }
    stored = sessionStore.get(normalizedSessionId)
  }
  const adapterId = stored?.adapterId ?? DSH_NATIVE_SESSION_ADAPTER_ID
  const selection = adapterId === DSH_NATIVE_SESSION_ADAPTER_ID
    ? readNativeModelSelection(nativeSessions, normalizedSessionId)
    : undefined
  const modelId = stored?.modelId?.trim() || selection?.modelId
  if (modelId === undefined || modelId === '') return null
  const providerId = stored?.providerId?.trim() || selection?.providerId
  if (adapterId === DSH_NATIVE_SESSION_ADAPTER_ID) {
    if (providerId === undefined || !isMagpieGatewayProvider(providerId)) return null
  } else if (await magpieUsage.readModelMetadata(adapterId, modelId, signal) === null) {
    return null
  }
  const agents = magpieUsageAgentAliases(adapterId)
  if (agents.length === 0) return null
  const sessionIds = [...new Set([normalizedSessionId, stored?.providerSessionId?.trim() ?? ''].filter(Boolean))]
  return { agents, sessionIds }
}

/**
 * 读到用量之后仍然要判断「这个模型是不是 Magpie 的」。
 *
 * `magpieUsage.read()` 只有在会话身份（Provider 会话 ID 或 DSH 会话 ID）已经出现在
 * Magpie 账本里时才返回快照。新会话的首个请求可能还没被 Magpie Web 记账，或者两边的
 * 会话 ID 在滚动升级期间并不相等，这时返回 null 会让 Host 直接回退到官方余量。
 * 只有确认模型由 Magpie 提供时才下发占位快照，避免官方数字抢占首屏。
 */
async function pendingMagpieUsage(
  magpie: MagpieUsageService,
  nativeSessions: CodingNsHostServices['nativeSessions'],
  sessionId: string,
  session: CodingNsCliSessionConfig,
  signal: AbortSignal,
  includeRoute = false,
): Promise<MagpieUsageSnapshot | null> {
  const agent = magpieAgentForAdapter(session.adapterId)
  const modelId = session.modelId?.trim()
  if (agent === null || modelId === undefined || modelId === '') return null
  try {
    if (session.adapterId === DSH_NATIVE_SESSION_ADAPTER_ID) {
      const providerId = session.providerId?.trim() || readNativeModelSelection(nativeSessions, sessionId)?.providerId
      if (providerId === undefined || !isMagpieGatewayProvider(providerId)) return null
    }
    const confirmed = await magpie.readModelMetadata(session.adapterId, modelId, signal)
    signal.throwIfAborted()
    if (confirmed === null) return null
    // Gateway totals do not depend on a provider session binding. Keep them
    // while the exact session row is pending, without attributing other rows.
    return await magpie.read(session, signal, includeRoute, sessionId, { allowPendingSession: true })
      ?? pendingMagpieSnapshot(agent, modelId)
  } catch {
    // 目录不可读、超时或请求被取消：保持原有回退语义，不伪造 Magpie 用量。
    return null
  }
}

/** Magpie 已经确认提供该模型、但会话身份还读不到时下发的占位快照。 */
function pendingMagpieSnapshot(agent: string, modelId: string): MagpieUsageSnapshot {
  const capturedAt = new Date().toISOString()
  return {
    agent,
    modelId,
    capturedAt,
    usageStatus: 'unavailable',
    aggregate: null,
    sessionId: null,
    session: null,
    routeStatus: 'not-requested',
    route: null,
    upstreamProvider: null,
    upstreamProviders: [],
    // 客户端据此在 3 秒内带路由补读，而不是停留在官方余额上。
    quotaStatus: 'provider-unavailable',
    quotas: [],
  }
}

/** 读取原生会话 header；测试替身或会话尚未装载时返回 undefined。 */
function readNativeSessionHeader(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  sessionId: string,
): Record<string, unknown> | undefined {
  if (nativeSessions === undefined) return undefined
  try {
    return asRecord(asRecord(nativeSessions.get(sessionId))?.header) ?? undefined
  } catch {
    return undefined
  }
}

/** 插件自己的全局助理会话不属于用户对话，不能被翻译改写。 */
function isAssistantSession(sessionId: string): boolean {
  // 复用助理适配器导出的会话前缀常量：会话身份的唯一定义在那里，重复字面量会漂移。
  return sessionId.startsWith(ASSISTANT_AGENT_PREFIX)
}

interface NativeStreamBlock {
  readonly index: number
  readonly kind: 'reasoning' | 'text'
  readonly translate: boolean
  text: string
  closed: boolean
}

/** Translate completed native output blocks without buffering their visible deltas. */
async function* translateNativeStream(
  stream: AsyncIterable<unknown>,
  translation: NonNullable<CodingNsHostServices['sessionTranslation']>,
  bilingual: boolean,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const blocks = new Map<number, NativeStreamBlock>()

  const bufferOf = (index: number, kind: NativeStreamBlock['kind']): NativeStreamBlock | undefined => {
    const existing = blocks.get(index)
    if (existing !== undefined) return existing.kind === kind && !existing.closed ? existing : undefined
    const created: NativeStreamBlock = {
      index, kind, text: '', closed: false,
      translate: translation.shouldTranslate(DSH_NATIVE_SESSION_ADAPTER_ID, kind === 'reasoning' ? 'reasoning' : 'assistant', true),
    }
    blocks.set(index, created)
    return created
  }

  const translateBlock = async (block: NativeStreamBlock): Promise<SessionTranslationRecord | undefined> => {
    const original = block.text
    if (original.trim() === '') return undefined
    const kind = block.kind === 'reasoning' ? 'reasoning' as const : 'assistant' as const
    let record: SessionTranslationRecord | undefined
    try {
      const result = await translation.translateOutput(DSH_NATIVE_SESSION_ADAPTER_ID, kind, original, signal, true)
      if (result !== null && result !== undefined) {
        record = {
          original: result.original,
          translated: result.translated,
          ...(result.sourceLanguage === undefined ? {} : { sourceLanguage: result.sourceLanguage }),
          targetLanguage: result.targetLanguage,
          outputKind: kind,
          bilingual: result.bilingual,
          ...(result.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
          ...(result.model === undefined ? {} : { model: result.model }),
          ...readSessionTranslationDiagnostics(result),
          ...readSessionTranslationMetrics(result),
          ...(result.failed === true ? { failed: true } : {}),
        }
      }
    } catch (error) {
      record = { original, translated: original, targetLanguage: translation.outputLanguage ?? 'zh', outputKind: kind, bilingual, failed: true, failure: translationFailure(error, signal) }
    }
    if (record === undefined) return undefined
    const visible = formatSessionTranslationOutput(record)
    if (visible.trim() === '' || visible === original && record.failed !== true) return undefined
    return record
  }

  try {
    for await (const chunk of stream) {
      const record = asRecord(chunk)
      const type = typeof record?.type === 'string' ? record.type : ''
      const index = typeof record?.index === 'number' ? record.index : undefined
      if (type === 'text-delta' || type === 'reasoning-delta') {
        if (index === undefined || typeof record?.text !== 'string') { yield chunk; continue }
        const kind = type === 'text-delta' ? 'text' as const : 'reasoning' as const
        const block = bufferOf(index, kind)
        // Decide once per block: changing settings must not translate only a suffix
        // or drop a prefix that was already buffered.
        if (block === undefined || !block.translate) { yield chunk; continue }
        block.text += record.text
        // Keep provider deltas visible while the completed block is being translated.
        yield chunk
        continue
      }
      if (type === 'block-end' && index !== undefined) {
        const block = blocks.get(index)
        if (block !== undefined && !block.closed) {
          block.closed = true
          if (block.text.trim() !== '') {
            const translationRecord = await translateBlock(block)
            if (translationRecord !== undefined) {
              const finalBlock = asRecord(record?.block)
              yield {
                ...(record ?? {}),
                block: {
                  ...(finalBlock ?? {}),
                  type: block.kind,
                  text: block.text,
                  codingnsTranslation: translationRecord,
                },
                codingnsTranslation: translationRecord,
              }
              continue
            }
          }
        }
        yield chunk
        continue
      }
      yield chunk
    }
  } catch (error) {
    // 流异常时先把缓存正文按原文补发，再把原始错误交给 DSH，保证回复不丢失。
    for (const item of flushBuffered()) yield item
    throw error
  }
  for (const item of flushBuffered()) yield item

  /**
   * Provider 未发送 block-end（中断或异常）时，结束已透传的原文块。
   *
   * 不能用 `finally` 里的 `yield`：异常正在传播时生成器已经结束，后续 yield 会被
   * 直接丢弃，用户会看不到已经生成的半截回复。
   */
  function* flushBuffered(): Generator<unknown> {
    for (const block of [...blocks.values()]) {
      if (block.closed || block.text.trim() === '') continue
      block.closed = true
      yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } }
    }
  }
}

function extractTurnInput(
  messages: readonly CodingNsCliMessage[],
  dshContext?: CodingNsHostServices['dshContext'],
  acceptedPeerInput: readonly CodingNsCliMessage[] = pendingPeerInput(messages),
): {
  readonly prompt: string
  readonly peerInput?: boolean
  readonly attachments: readonly CodingNsCliAttachment[]
  /** 只翻译用户自然语言和引用文本；附件提示保持原文。 */
  readonly translationPrompt: string
  readonly untranslatedPrompt: string
  /** 继续提示是 Host 注入的控制文本，不应再送入用户输入翻译。 */
  readonly translatePrompt: boolean
  readonly credentialCarriers: readonly CredentialCarrier[]
  /** 当前轮已拼入 prompt 的引用上下文不再作为历史消息重复交给驱动。 */
  readonly messages: readonly CodingNsCliMessage[]
} {
  if (acceptedPeerInput.some(isTeamInputMessage)) {
    const parts = acceptedPeerInput.map(message => {
      const part = extractMessageInput(message.content, dshContext)
      const translated = isHumanUserMessage(message) ? readInputTranslation(message.source) : undefined
      return translated ? { ...part, prompt: translated.translated } : part
    })
    const prompt = parts.map(part => part.prompt).filter(text => text.trim() !== '').join('\n\n')
    return {
      prompt,
      peerInput: true,
      translationPrompt: prompt,
      untranslatedPrompt: '',
      attachments: parts.flatMap(part => part.attachments),
      credentialCarriers: parts.flatMap(part => part.credentialCarriers),
      translatePrompt: false,
      messages: stripCredentialCarriers(stripInputTranslationDisplay(messages)),
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isInjectedStepNotice(message)) {
      const prompt = extractText(message.content)
      return { prompt, translationPrompt: prompt, untranslatedPrompt: '', attachments: [], credentialCarriers: [], translatePrompt: false, messages: stripCredentialCarriers(messages) }
    }
    if (message !== undefined && isHumanUserMessage(message)) {
      const direct = extractMessageInput(message.content, dshContext)
      const referenceIndexes = messages
        .slice(index + 1)
        .map((candidate, offset) => isSessionReferenceContext(candidate) ? index + 1 + offset : -1)
        .filter((candidateIndex): candidateIndex is number => candidateIndex >= 0)
      const referenceText = referenceIndexes
        .map(referenceIndex => messages[referenceIndex])
        .filter((candidate): candidate is CodingNsCliMessage => candidate !== undefined)
        .map(candidate => extractText(candidate.content))
        .filter(text => text.trim() !== '')
      const forwarded = referenceIndexes.length === 0
        ? messages
        : messages.filter((_candidate, candidateIndex) => !referenceIndexes.includes(candidateIndex))
      const translatedInput = readInputTranslation(message.source)
      if (translatedInput !== undefined) {
        const prompt = [translatedInput.translated, ...referenceText].join('\n\n')
      return {
          prompt,
          translationPrompt: prompt,
          untranslatedPrompt: '',
          attachments: direct.attachments,
          translatePrompt: false,
        credentialCarriers: direct.credentialCarriers,
        messages: stripCredentialCarriers(stripInputTranslationDisplay(forwarded)),
        }
      }
      return {
        prompt: [direct.prompt, ...referenceText].filter(text => text.trim() !== '').join('\n\n').trim(),
        translationPrompt: [direct.translationPrompt, ...referenceText].filter(text => text.trim() !== '').join('\n\n').trim(),
        untranslatedPrompt: direct.untranslatedPrompt,
        attachments: direct.attachments,
        translatePrompt: true,
        credentialCarriers: direct.credentialCarriers,
        messages: stripCredentialCarriers(stripInputTranslationDisplay(forwarded)),
      }
    }
  }
  return {
    prompt: '',
    translationPrompt: '',
    untranslatedPrompt: '',
    attachments: [],
    credentialCarriers: [],
    translatePrompt: false,
    messages: stripCredentialCarriers(stripInputTranslationDisplay(messages)),
  }
}

function findLatestHumanMessage(messages: readonly CodingNsCliMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isHumanUserMessage(message)) return index
  }
  return -1
}

function readInputTranslation(value: CodingNsCliMessage['source']): SessionTranslationInputRecord | undefined {
  const candidate = value?.codingnsTranslationInput
  if (!isRecord(candidate) || typeof candidate.original !== 'string' || typeof candidate.translated !== 'string') return undefined
  if (candidate.original.trim() === '' || candidate.translated.trim() === '') return undefined
  const targetLanguage = candidate.targetLanguage === 'fr' || candidate.targetLanguage === 'de' || candidate.targetLanguage === 'ja' || candidate.targetLanguage === 'zh'
    ? candidate.targetLanguage
    : 'en'
  const sourceLanguage = candidate.sourceLanguage === 'zh' || candidate.sourceLanguage === 'en' || candidate.sourceLanguage === 'fr' || candidate.sourceLanguage === 'de' || candidate.sourceLanguage === 'ja'
    ? candidate.sourceLanguage
    : undefined
  return {
    original: candidate.original,
    translated: candidate.translated,
    ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
    targetLanguage,
    ...(candidate.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
  }
}

/** 把历史消息还原为 Provider 可见的纯译文，并移除内部翻译元数据。 */
function stripInputTranslationDisplay(messages: readonly CodingNsCliMessage[]): readonly CodingNsCliMessage[] {
  return messages.map((message) => {
    const record = readInputTranslation(message.source)
    if (record === undefined) return message
    const source = message.source
    const cleanSource = source === undefined
      ? undefined
      : (() => {
        const { codingnsTranslationInput: _translation, ...rest } = source
        return rest
      })()
    return {
      ...message,
      content: replaceInputTranslationContent(message.content, record.translated),
      ...(cleanSource === undefined ? {} : { source: cleanSource }),
    }
  })
}

function stripCredentialCarriers(messages: readonly CodingNsCliMessage[]): readonly CodingNsCliMessage[] {
  return messages.map((message) => {
    const content = replaceCredentialCarriersInContent(message.content)
    return content === message.content ? message : { ...message, content }
  })
}

function replaceCredentialCarriersInContent(content: unknown): unknown {
  if (typeof content === 'string') return parseCredentialCarriers(content).text
  if (!Array.isArray(content)) return content
  let changed = false
  const next = content.map((part) => {
    if (!isRecord(part) || typeof part.text !== 'string') return part
    const text = parseCredentialCarriers(part.text).text
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? next : content
}

function replaceInputTranslationContent(content: unknown, text: string): unknown {
  if (typeof content === 'string') return text
  if (!Array.isArray(content)) return [{ type: 'text', text }]
  let replaced = false
  const blocks = content.flatMap((part) => {
    if (!isRecord(part) || part.type !== 'text') return [part]
    if (replaced) return []
    replaced = true
    return [{ ...part, text }]
  })
  return replaced ? blocks : [{ type: 'text', text }, ...content]
}

/** Resolved files already have localized path notices. Leaving their file blocks
 * would make DSH append another, English-only file notice at adapter dispatch.
 * Preserve images and unresolved files so DSH retains modality/error handling.
 */
function nativeTranslationContent(content: unknown, dshContext: CodingNsHostServices['dshContext']): unknown {
  if (!Array.isArray(content)) return content
  return content.filter(part => {
    if (!isRecord(part) || part.type !== 'file') return true
    return resolveDshAttachmentPath(dshContext, 'file', isRecord(part.attachment) ? part.attachment : part) === undefined
  })
}

/** DSH 为工具分段注入的继续提示必须成为下一次 Provider 请求的 prompt。 */
function isInjectedStepNotice(message: CodingNsCliMessage): boolean {
  if (message.role !== 'user' || !isRecord(message.source)) return false
  if (message.source.form !== 'notice') return false
  // v4 continuations share DSH's model-selection source; only our own IDs
  // identify a continuation, not an ordinary model-switch notification.
  return message.source.kind === 'model-selection' && message.id?.startsWith('codingns-external-step-') === true
    || message.source.kind === 'plugin' && message.source.plugin === 'codingns4dsh'
}

function isHumanUserMessage(message: CodingNsCliMessage): boolean {
  if (message.role !== 'user') return false
  // 旧测试和旧调用方没有 source，保留其兼容语义；有 source 时只接受真实用户消息。
  if (message.source === undefined) return true
  if (!isRecord(message.source)) return false
  return message.source.kind === undefined || message.source.kind === 'user'
}

/** DSH 为当前用户消息生成的只读跨会话快照，允许进入外部 Agent 的当前 prompt。 */
function isSessionReferenceContext(message: CodingNsCliMessage): boolean {
  if (message.role !== 'user' || !isRecord(message.source)) return false
  return message.source.kind === 'session-reference' && message.source.form === 'recall'
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isRecord).map((part) => typeof part.text === 'string' ? part.text : '').join('\n').trim()
}

function extractMessageInput(content: unknown, dshContext?: CodingNsHostServices['dshContext']): {
  readonly prompt: string
  readonly translationPrompt: string
  readonly untranslatedPrompt: string
  readonly attachments: readonly CodingNsCliAttachment[]
  readonly credentialCarriers: readonly CredentialCarrier[]
} {
  if (typeof content === 'string') {
    const parsed = parseCredentialCarriers(content)
    return { prompt: parsed.text, translationPrompt: parsed.text, untranslatedPrompt: '', attachments: [], credentialCarriers: parsed.carriers }
  }
  if (!Array.isArray(content)) return { prompt: '', translationPrompt: '', untranslatedPrompt: '', attachments: [], credentialCarriers: [] }
  const text: string[] = []
  const attachments: CodingNsCliAttachment[] = []
  const credentialCarriers: CredentialCarrier[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (typeof part.text === 'string' && part.text.trim() !== '') {
      const parsed = parseCredentialCarriers(part.text)
      text.push(parsed.text)
      for (const carrier of parsed.carriers) {
        if (!credentialCarriers.some((item) => item.requestCode === carrier.requestCode)) credentialCarriers.push(carrier)
      }
    }
    const kind = part.type === 'image' ? 'image' : part.type === 'file' ? 'file' : null
    if (kind === null) continue
    const reference = isRecord(part.attachment) ? part.attachment : part
    const path = resolveDshAttachmentPath(dshContext, kind, reference)
    if (path === undefined) continue
    const name = typeof reference.name === 'string' && reference.name.trim() !== '' ? reference.name.trim() : undefined
    const mimeType = typeof reference.mediaType === 'string' && reference.mediaType.trim() !== '' ? reference.mediaType.trim() : undefined
    attachments.push({ kind, path, ...(name === undefined ? {} : { name }), ...(mimeType === undefined ? {} : { mimeType }) })
  }
  const translationPrompt = text.join('\n\n').trim()
  const untranslatedPrompt = attachmentNotices(attachments)
  return {
    prompt: [translationPrompt, untranslatedPrompt].filter(value => value !== '').join('\n\n'),
    translationPrompt,
    untranslatedPrompt,
    attachments,
    credentialCarriers,
  }
}

function attachmentNotices(attachments: readonly CodingNsCliAttachment[], language?: SessionTranslationInputRecord['targetLanguage']): string {
  return attachments.filter(attachment => attachment.kind === 'file').map(attachment => attachmentFileNotice(attachment, language)).join('\n\n')
}

function resolveDshAttachmentPath(
  dshContext: CodingNsHostServices['dshContext'],
  kind: CodingNsCliAttachment['kind'],
  reference: Record<string, unknown>,
): string | undefined {
  if (dshContext === undefined || typeof reference.attachmentId !== 'string') return undefined
  try {
    const attachments = dshContext.get('attachments') as Record<string, unknown> | undefined
    const resolver = attachments?.[kind === 'image' ? 'imageHostPath' : 'fileHostPath']
    if (typeof resolver !== 'function') return undefined
    const hostPath = resolver.call(attachments, reference)
    if (typeof hostPath !== 'string' || hostPath.trim() === '') return undefined
    const fs = dshContext.get('fs') as Record<string, unknown> | undefined
    const mapper = fs?.processPathFromHostPath
    const processPath = typeof mapper === 'function' ? mapper.call(fs, hostPath) : undefined
    return typeof processPath === 'string' && processPath.trim() !== '' ? processPath : hostPath
  } catch {
    return undefined
  }
}

/**
 * 读取 DSH 会话当前生效的权限状态。
 *
 * 三个服务各自负责一部分事实，必须与 DSH 执行侧同源：
 * - `sandboxPolicy.resolve()` 给出含部署默认的生效模式；
 * - `approval.overrideOf()` 只返回会话覆盖值，缺省时用服务自身配置的默认策略补齐；
 * - `permissionPresets.current()` 只用于诊断。
 *
 * 任一服务缺失或结构不符时留空对应字段：驱动必须区分“还没读到”和“已确认无限制”，
 * 绝不能把探测失败当成 danger-full-access。
 */
function resolveSessionPermission(
  dshContext: CodingNsHostServices['dshContext'],
  sessionId: string,
): CodingNsCliPermissionState | undefined {
  if (dshContext === undefined || sessionId.trim() === '') return undefined
  const session = nativeSessionFor(dshContext, sessionId)
  if (session === undefined) return undefined
  const sandboxMode = readSandboxMode(dshContext, session)
  const approvalPolicy = readApprovalPolicy(dshContext, session)
  const preset = readPermissionPreset(dshContext, session)
  if (sandboxMode === undefined && approvalPolicy === undefined && preset === undefined) return undefined
  return {
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(preset === undefined ? {} : { preset }),
  }
}

/**
 * DSH 的 `agents` 注册表持有 Agent，而权限服务以 Agent 的 Session 为读取键。
 * 两者形状变化时都必须留空，不能把 Agent 直接当 Session 传进服务。
 */
function nativeSessionFor(dshContext: NonNullable<CodingNsHostServices['dshContext']>, sessionId: string): unknown {
  try {
    const agents = dshContext.get('agents') as Record<string, unknown> | undefined
    const get = agents?.get
    if (typeof get !== 'function') return undefined
    const agent = asRecord(get.call(agents, sessionId))
    return agent?.session ?? undefined
  } catch {
    return undefined
  }
}

function readSandboxMode(dshContext: NonNullable<CodingNsHostServices['dshContext']>, session: unknown): CodingNsCliSandboxMode | undefined {
  try {
    const service = dshContext.get('sandboxPolicy') as Record<string, unknown> | undefined
    const resolvePolicy = service?.resolve
    if (typeof resolvePolicy !== 'function') return undefined
    const policy = resolvePolicy.call(service, { session })
    // 先落到 unknown 再收窄：asRecord 返回的 any 属性不会触发类型谓词收窄，
    // 直接返回会退化成 boolean，无法赋给 CodingNsCliSandboxMode。
    const mode: unknown = asRecord(policy)?.mode
    return isSandboxMode(mode) ? mode : undefined
  } catch {
    return undefined
  }
}

function readApprovalPolicy(dshContext: NonNullable<CodingNsHostServices['dshContext']>, session: unknown): CodingNsCliApprovalPolicy | undefined {
  try {
    const service = dshContext.get('approval') as Record<string, unknown> | undefined
    const overrideOf = service?.overrideOf
    const override = typeof overrideOf === 'function' ? overrideOf.call(service, session) : undefined
    if (isApprovalPolicy(override)) return override
    // 没有会话覆盖时，服务自身配置的策略就是生效值；缺省与 DSH 一致按 ask 处理。
    const configured = asRecord(service?.config)?.policy
    return isApprovalPolicy(configured) ? configured : 'ask'
  } catch {
    return undefined
  }
}

function readPermissionPreset(dshContext: NonNullable<CodingNsHostServices['dshContext']>, session: unknown): string | undefined {
  try {
    const service = dshContext.get('permissionPresets') as Record<string, unknown> | undefined
    const current = service?.current
    if (typeof current !== 'function') return undefined
    const preset = current.call(service, session)
    return typeof preset === 'string' && preset.trim() !== '' ? preset.trim() : undefined
  } catch {
    return undefined
  }
}

function isSandboxMode(value: unknown): value is CodingNsCliSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function isApprovalPolicy(value: unknown): value is CodingNsCliApprovalPolicy {
  return value === 'ask' || value === 'never'
}

function resolveSessionCwd(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  sessionId: string,
  value: Record<string, any> | null,
): string | undefined {
  const direct = typeof value?.cwd === 'string' && value.cwd.trim() ? value.cwd.trim() : undefined
  if (direct !== undefined) return direct
  if (nativeSessions === undefined || sessionId.trim() === '') return undefined
  const session = nativeSessions.get(sessionId)
  const record = asRecord(session)
  const header = asRecord(record?.header)
  const meta = asRecord(record?.meta)
  const directCwd = [header?.cwd, meta?.cwd, record?.cwd].find((item): item is string => typeof item === 'string' && item.trim() !== '')
  if (directCwd !== undefined) return directCwd.trim()
  const snapshot = record?.snapshotEvents
  if (typeof snapshot === 'function') {
    try {
      const events = snapshot.call(session)
      const eventCwd = findCwdInValue(events, 0)
      if (eventCwd !== undefined) return eventCwd
    } catch { /* 原生会话快照不可读时继续使用未解析状态。 */ }
  }
  return findCwdInValue(record, 0)
}

/** DSH 的 cwd 可能只存在 request/header.data.header 或事件 data.cwd 中。 */
function findCwdInValue(value: unknown, depth: number): string | undefined {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCwdInValue(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ['cwd', 'workingDirectory']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  for (const key of ['header', 'request', 'context', 'data', 'meta', 'session']) {
    const found = findCwdInValue(record[key], depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function readMagpieDashboardPeriod(payload: unknown): MagpieDashboardPeriod {
  const value = asRecord(payload)?.period
  if (value === 'today' || value === 'week' || value === 'month' || value === 'all') return value
  throw new TypeError('Magpie usage period must be today, week, month, or all')
}

async function* streamMagpieDashboard(
  service: MagpieUsageService,
  period: MagpieDashboardPeriod,
  signal: AbortSignal,
  force: boolean,
  sessionStore: CodingNsCliSessionStore,
  nativeSessions: CodingNsNativeSessionBridge | undefined,
  dshContext: unknown,
): AsyncIterable<MagpieDashboardStreamChunk> {
  const names = magpieSessionNameBindings(sessionStore, nativeSessions, signal, dshContext).catch(() => [] as readonly MagpieSessionNameBinding[])
  let latest: MagpieUsageDashboard | undefined
  for await (const chunk of service.readDashboardStream(period, signal, force)) {
    latest = chunk.dashboard
    yield chunk
  }
  if (latest !== undefined) {
    const named = attachMagpieSessionNames(latest, await names)
    if (named !== latest) yield { part: 'sessions', dashboard: named, stale: false }
  }
}

/** 探测载荷只接受入口路径或显式重置；其余字段忽略，避免把参数带进命令行。 */
function readMagpieDetectionRequest(payload: unknown): MagpieDetectionRequest {
  const record = asRecord(payload)
  if (record?.resetCommand === true) return { resetCommand: true }
  if (record === null || typeof record.commandPath !== 'string') return {}
  const commandPath = record.commandPath.trim()
  return commandPath === '' ? {} : { commandPath }
}

/** `force` 只在用户主动重新检测时出现；缺省复用短期探测结果。 */
function readMagpieDetectionForce(payload: unknown): boolean {
  return asRecord(payload)?.force === true
}

function readMagpieContextRequest(payload: unknown): { readonly sessionId: string } {
  const sessionId = readOptionalMagpieIdentity(asRecord(payload)?.sessionId, 512)
  if (sessionId === undefined) throw new TypeError('Magpie context requires a session ID')
  return { sessionId }
}

function readMagpieRequestOptions(payload: unknown): {
  readonly period: MagpieDashboardPeriod
  readonly offset: number
  readonly limit: number
  readonly sessionId?: string
  readonly sessionIds?: readonly string[]
  readonly sessionAgent?: string
} {
  const record = asRecord(payload)
  if (record === null) throw new TypeError('Magpie request page must be an object')
  const period = readMagpieDashboardPeriod(record)
  const offset = record.offset === undefined ? 0 : record.offset
  const limit = record.limit === undefined ? 50 : record.limit
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new TypeError('Magpie request offset is out of bounds')
  }
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Magpie request limit must be between 1 and 100')
  }
  const sessionId = readOptionalMagpieIdentity(record.sessionId, 512)
  const sessionIds = record.sessionIds === undefined
    ? undefined
    : readOptionalMagpieIdentityList(record.sessionIds, 16, 512)
  const sessionAgent = readOptionalMagpieIdentity(record.sessionAgent, 64)
  if ((sessionId === undefined) !== (sessionAgent === undefined)) {
    throw new TypeError('Magpie session details require both sessionId and sessionAgent')
  }
  if (sessionIds !== undefined && sessionId === undefined) {
    throw new TypeError('Magpie session IDs require a primary session ID')
  }
  if (sessionAgent !== undefined && !/^[a-z0-9][a-z0-9-]*$/u.test(sessionAgent)) {
    throw new TypeError('Magpie session Agent is invalid')
  }
  return {
    period,
    offset,
    limit,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sessionIds === undefined ? {} : { sessionIds }),
    ...(sessionAgent === undefined ? {} : { sessionAgent }),
  }
}

function readMagpieSessionMetrics(
  sessionStore: CodingNsCliSessionStore,
  nativeSessions: CodingNsNativeSessionBridge | undefined,
  sessionId: string,
  sessionIds: readonly string[] | undefined,
): MagpieSessionMetrics | null {
  if (nativeSessions === undefined) return null
  const identities = new Set([sessionId, ...(sessionIds ?? [])])
  const bindings = sessionStore.list({ includeArchived: true }).filter((record) =>
    identities.has(record.dshSessionId) || (record.providerSessionId !== undefined && identities.has(record.providerSessionId)))
  const direct = bindings.find((record) => record.dshSessionId === sessionId)
  const boundSessionIds = [...new Set(bindings.map((record) => record.dshSessionId))]
  if (direct === undefined && boundSessionIds.length > 1) return null
  const dshSessionId = direct?.dshSessionId ?? boundSessionIds[0] ?? sessionId
  let session: unknown
  try { session = nativeSessions.get(dshSessionId) } catch { return null }
  const snapshotEvents = asRecord(session)?.snapshotEvents
  if (typeof snapshotEvents !== 'function') return null
  try {
    const events: unknown = snapshotEvents.call(session)
    return Array.isArray(events) ? countSessionTurnSteps(events) : null
  } catch {
    return null
  }
}

function readOptionalMagpieIdentity(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError('Magpie session identity must be text')
  const text = value.trim()
  if (text === '' || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new TypeError('Magpie session identity is invalid')
  }
  return text
}

function readOptionalMagpieIdentityList(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError('Magpie session IDs are invalid')
  const values = value.map((item) => readOptionalMagpieIdentity(item, maxLength))
  if (values.some((item): item is undefined => item === undefined)) throw new TypeError('Magpie session IDs are invalid')
  return [...new Set(values as string[])]
}

async function magpieSessionNameBindings(
  sessionStore: CodingNsCliSessionStore,
  nativeSessions: CodingNsNativeSessionBridge | undefined,
  signal?: AbortSignal,
  dshContext?: unknown,
): Promise<readonly MagpieSessionNameBinding[]> {
  const records = sessionStore.list({ includeArchived: true })
  const bindings: MagpieSessionNameBinding[] = []
  const knownSessionIds = new Set<string>()
  let nativeValues: readonly unknown[] = nativeSessions?.list() ?? []
  if (nativeSessions?.listRemote !== undefined) {
    try { nativeValues = await nativeSessions.listRemote(signal) } catch { signal?.throwIfAborted() }
  }
  const nativeNames = new Map<string, string>()
  for (const value of nativeValues) {
    const sessionId = nativeSessionId(value)
    const name = readNativeSessionDisplayName(value, dshContext)
    if (sessionId !== undefined && name !== undefined) nativeNames.set(sessionId, name)
  }
  for (const record of records) {
    knownSessionIds.add(record.dshSessionId)
    const name = nativeNames.get(record.dshSessionId) ?? readDshSessionDisplayName(record.dshSessionId, sessionStore, nativeSessions, dshContext)
    bindings.push({
      dshSessionId: record.dshSessionId,
      adapterId: record.adapterId,
      ...(record.providerSessionId === undefined ? {} : { providerSessionId: record.providerSessionId }),
      ...(name === undefined ? {} : { name }),
    })
  }
  // Native DSH sessions do not always have a CodingNS session-index record. They
  // still use the DSH session ID as Magpie's identity, so include their title
  // only when no external adapter binding claims the same DSH session.
  for (const value of nativeValues) {
    const sessionId = nativeSessionId(value)
    if (sessionId === undefined || knownSessionIds.has(sessionId)) continue
    const name = readNativeSessionDisplayName(value, dshContext)
    bindings.push({ dshSessionId: sessionId, adapterId: 'dsh', ...(name === undefined ? {} : { name }) })
  }
  return bindings
}

function readDshSessionDisplayName(
  sessionId: string,
  sessionStore: CodingNsCliSessionStore,
  nativeSessions: CodingNsNativeSessionBridge | undefined,
  dshContext?: unknown,
): string | undefined {
  const direct = readNativeSession(nativeSessions, sessionId)
  const directName = readNativeSessionDisplayName(direct, dshContext)
  if (directName !== undefined) return directName
  const directRecord = sessionStore.get(sessionId)
  const directRecordName = cleanDisplayName(directRecord?.title)
  if (directRecordName !== undefined) return directRecordName
  const binding = sessionStore.list({ includeArchived: true }).find((record) => record.dshSessionId === sessionId || record.providerSessionId === sessionId)
  if (binding === undefined) return undefined
  return readNativeSessionDisplayName(readNativeSession(nativeSessions, binding.dshSessionId), dshContext)
    ?? cleanDisplayName(binding.title)
}

function readNativeSessionDisplayName(value: unknown, dshContext?: unknown): string | undefined {
  const root = asRecord(value)
  if (root === null) return undefined
  const projection = asRecord(root.projections) ?? asRecord(asRecord(root.record)?.projections)
  const values = asRecord(projection?.values)
  const record = asRecord(root.record)
  const header = asRecord(root.header)
  const recordHeader = asRecord(record?.header)
  const rows = asRecord(record?.rows)
  const rowProjection = asRecord(rows?.projections)
  const rowValues = asRecord(rowProjection?.values)
  const titleService = asRecord(readOptionalDshService(dshContext, 'sessionTitle'))
  if (typeof titleService?.get === 'function') {
    try {
      const snapshot = titleService.get(value)
      const title = cleanDisplayName(asRecord(snapshot)?.title ?? snapshot)
      if (title !== undefined) return title
    } catch { /* The optional native title service may not accept this session shape. */ }
  }
  for (const candidate of [
    values?.title, rowValues?.title, root.title, root.name, root.displayName,
    header?.title, header?.name, header?.displayName,
    record?.title, record?.name, recordHeader?.title, recordHeader?.name,
  ]) {
    const title = cleanDisplayName(candidate)
    if (title !== undefined) return title
  }
  if (typeof root.snapshotEvents === 'function') {
    try {
      const events: unknown = root.snapshotEvents.call(value)
      if (Array.isArray(events)) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = asRecord(events[index])
          if (event?.type !== 'session/title') continue
          const title = cleanDisplayName(asRecord(event.data)?.title ?? event.title)
          if (title !== undefined) return title
        }
      }
    } catch { /* A missing or closed native history cannot block usage rendering. */ }
  }
  return undefined
}

function readNativeSession(nativeSessions: CodingNsNativeSessionBridge | undefined, sessionId: string): unknown {
  try { return nativeSessions?.get(sessionId) }
  catch { return undefined }
}

function readOptionalDshService(context: unknown, name: string): unknown {
  const get = (context as { readonly get?: unknown } | null | undefined)?.get
  if (typeof get !== 'function') return undefined
  try { return (get as (service: string) => unknown).call(context, name) }
  catch { return undefined }
}

function cleanDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240)
  return name === '' ? undefined : name
}

function asRecord(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function isRecord(value: unknown): value is Record<string, any> { return asRecord(value) !== null }
function nativeSessionId(value: unknown): string | undefined {
  const record = asRecord(value)
  return typeof record?.id === 'string' && record.id.trim() ? record.id.trim() : typeof record?.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined
}
function nativeEventType(value: unknown): string | undefined {
  const record = asRecord(value)
  return typeof record?.type === 'string' ? record.type : undefined
}
function isMessage(value: unknown): value is CodingNsCliMessage { const record = asRecord(value); return (record?.role === 'user' || record?.role === 'assistant' || record?.role === 'system' || record?.role === 'tool') && 'content' in record }
function isAbortSignal(value: unknown): value is AbortSignal { return asRecord(value)?.aborted === true || (asRecord(value)?.addEventListener instanceof Function) }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) }
