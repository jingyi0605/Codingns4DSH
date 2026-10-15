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
import { CodingNsCliSessionStore } from './session-store.js'
import { CodingNsDshMessageProjector } from './dsh-message-projector.js'
import { CommandCodeSubscriptionService } from './command-code-subscription.js'
import { ProviderSubscriptionService } from './provider-subscription.js'
import { normalizeSubagentBridgeSettings, normalizeSubscriptionUsageSettings, type CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsHostServices } from '../features/types.js'
import { setAdapterRegistry } from './registry-holder.js'
import { createDshVirtualProviderRegistration } from './dsh-virtual-providers.js'
import { dispatchBridgeSubagent, type BridgeAgentRegistry } from '../cli-bridge/dispatch.js'
import { startSubagentBridgeServer, type SubagentBridgeServer } from '../cli-bridge/bridge-server.js'
import { setSubagentBridge } from '../cli-bridge/bridge-holder.js'
import { delegateCapability, dispatchDelegateSubagent, type DelegateAgentRegistry } from './delegate-dispatch.js'
import { guardNativeSubagentParentTurn, markNativeSubagentParentTurnStarted, setMaxNativeSubagentsPerParent } from './native-subagent-dispatch.js'
import { containsDelegationCarrier, delegationAdapterIds, rewriteDelegationMessages } from './delegation-mention-rewrite.js'
import { clearDelegationAuthorization, setDelegationAuthorization } from './delegation-authorization.js'
import { debugInfo } from '../../shared/debug.js'
import { hasLegacySessionAdapterHint } from './legacy-session-adapter.js'
import {
  DSH_NATIVE_SESSION_ADAPTER_ID,
  formatSessionTranslationOutput,
  readSessionTranslationMetrics,
  type SessionTranslationInputRecord,
  type SessionTranslationRecord,
} from '../../shared/contracts/session-translation.js'
import { createInteractionTranslation } from '../features/interaction-translation.js'
import { createSessionTranslationRecovery, SessionTranslationCancelled } from '../features/session-translation-recovery.js'
import { ASSISTANT_AGENT_PREFIX } from '../../dsh-capabilities/host/assistant-agent-adapter.js'
import { createDshCapabilityRegistry } from '../../dsh-capabilities/routes.js'
import type { SessionModelSelectionAdapter } from '../../dsh-capabilities/host/session-model-selection-adapter.js'
import { sessionPromptScope, type SessionPromptAdapter } from '../../dsh-capabilities/host/session-prompt-adapter.js'
import { createSessionPromptTranslation } from '../features/session-prompt-translation.js'

export function createCliAdaptersFeature(options: { registry?: CodingNsCliAdapterRegistry } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'cliAdapters',
      version: '0.1.1',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
      requires: [{ capability: 'session.external-model-selection', required: false, fallback: 'degrade' }],
    },
    async start(context) {
      const lifetime = new AbortController()
      // 用量查询超时对所有适配器统一生效：同一个 timeoutMs 下发给全部网络读取器，
      // 设置变更时整体重建，避免旧超时继续生效。
      const buildSubscriptions = (settings: CodingNsSettings | undefined): ProviderSubscriptionService => {
        const timeoutMs = normalizeSubscriptionUsageSettings(settings?.subscriptionUsage).timeoutSecs * 1000
        return new ProviderSubscriptionService({ commandCode: new CommandCodeSubscriptionService({ timeoutMs }), timeoutMs })
      }
      let subscriptions = buildSubscriptions(context.services.settings?.get())
      let subscriptionSettings = JSON.stringify(context.services.settings?.get().subscriptionUsage ?? null)
      // 注入的 registry 自带 SessionStore；只有自建时才有本地 store 变量。
      const sessionStore = options.registry?.sessionRecords
        ?? new CodingNsCliSessionStore(context.services.settings === undefined ? {} : { settings: context.services.settings })
      const nativeSessions = context.services.nativeSessions
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
      context.resources.add(() => {
        if (registry === undefined) return
        setAdapterRegistry(undefined)
      })
      registry.applyEnabledSettings(context.services.settings?.get().agentAdapters)
      const virtualProviders = createDshVirtualProviderRegistration(context.services.dshContext)
      virtualProviders?.setProviders(registry.enabledAdapterIds())
      if (virtualProviders !== undefined) context.resources.add(() => virtualProviders.dispose())
      if (context.services.dshContext !== undefined && context.services.dshVersion !== undefined) {
        const selection = createDshCapabilityRegistry(context.services.dshVersion, 'host', context.services.dshContext)
          .getProfile(context.services.dshContext).capabilities.get('session.external-model-selection')
          ?.value as SessionModelSelectionAdapter | undefined
        if (selection !== undefined) context.resources.add(selection.install((sessionId) => {
          const config = registry.getSession(sessionId)
          if (config.adapterId === 'dsh' || !registry.isEnabled(config.adapterId)) return undefined
          return { provider: config.adapterId, model: config.modelId?.trim() || 'provider-default' }
        }))
      }
      registry.warmCatalog()
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
      registerDelegationAgentHooks(context.services.dshContext, registry, context.resources, publishExternalStatus, translation, translationRecovery, promptTranslation, nativeSessions)
      const interactionTranslation = createInteractionTranslation(translation, sessionId => registry.getSession(sessionId))
      context.resources.add(() => interactionTranslation.dispose())
      context.resources.add(context.services.rpc.register('cli', (action, payload, rpcContext) => {
        const rpcSignal = asRecord(rpcContext)?.signal
        const signal = isAbortSignal(rpcSignal) ? rpcSignal : undefined
        switch (action) {
          case 'catalog': return registry.catalog()
          case 'catalog/refresh': return registry.refreshCatalog(asRecord(payload)?.adapterId === undefined ? undefined : readAdapterId(payload)).then((catalog) => {
            subscriptions = buildSubscriptions(context.services.settings?.get())
            return catalog
          })
          case 'models': {
            const adapterId = readAdapterId(payload)
            return adapterId === 'dsh' ? readDshModelCatalog(context.services.dshContext) : registry.models(adapterId)
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
            const config = registry.setSession(sessionId, readSessionConfig(payload))
            if (config.translationEnabled === false || previous.adapterId !== config.adapterId) translationRecovery.cancelSession(sessionId)
            return config
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
            return subscriptions.read(subscription.adapterId, subscription.providerId, subscription.modelId)
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
            dispatch: (request) => dispatchBridgeSubagent(request, {
              agents: agents as BridgeAgentRegistry | undefined,
              nativeSessions: context.services.nativeSessions,
            }),
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
          translationRecovery.cancelDisabled(next.sessionTranslation?.nativeEnabled === true)
          const nextSubscriptionSettings = JSON.stringify(next.subscriptionUsage ?? null)
          if (nextSubscriptionSettings !== subscriptionSettings) {
            subscriptionSettings = nextSubscriptionSettings
            subscriptions = buildSubscriptions(next)
          }
          syncSubagentBridgeSettings(next.subagentBridge)
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
          const selectedExternalAdapter = selectExternalAdapter(
            dshSelection.providerId,
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
            && dshSelection.providerId === selectedExternalAdapter
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
          if (config.adapterId === 'dsh') {
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
                next(),
                translation,
                translation.bilingual === true,
                isAbortSignal(value?.signal) ? value.signal : undefined,
              ))
              return
            }
            yield* guardDshNativeStream(next)
            return
          }
          const cwd = resolveSessionCwd(context.services.nativeSessions, sessionId, value)
          const turnInput = extractTurnInput(messages, context.services.dshContext)
          const turnOptions = readCliTurnOptions(value)
          const runtimeEnv = readCliRuntimeEnv(value)
          const requestSignal = isAbortSignal(value?.signal)
            ? AbortSignal.any([value.signal, lifetime.signal])
            : lifetime.signal
          let translatedPrompt = turnInput.translationPrompt
          if (turnInput.translatePrompt && turnInput.translationPrompt.trim() !== '' && translation !== undefined && config.translationEnabled === true) {
            try {
              translatedPrompt = (await translationRecovery.translateInput(sessionId, config.adapterId, turnInput.translationPrompt, requestSignal)).translated
            } catch (error) {
              if (!(error instanceof SessionTranslationCancelled) && !requestSignal?.aborted) throw error
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
          }
          const prompt = turnInput.translatePrompt
            ? [translatedPrompt, turnInput.untranslatedPrompt].filter((part) => part.trim() !== '').join('\n\n')
            : turnInput.prompt
          // 权限状态必须与 DSH 会话当前生效值同源。驱动不能自行假设“完全权限”，
          // 也不能把缺省当成“已确认无限制”：解析失败时留空，由驱动沿用保守默认。
          const permission = resolveSessionPermission(context.services.dshContext, sessionId)
          // 只有 Provider 驱动明确声明可以维护连续事件流，才把工具边界映射为 DSH step。
          // Command Code、Codex 自己维护 assistant 消息边界；OpenCode 由 Registry
          // 挂起并续读同一条 SSE。其他驱动仍把整轮保持在一个 step，避免 token-meter
          // 在下一条 usage 到达前失去投影。
          const input = {
            sessionId,
            messages: turnInput.messages,
            prompt,
            ...(turnInput.attachments.length === 0 ? {} : { attachments: turnInput.attachments }),
            ...(permission === undefined ? {} : { permission }),
            ...(turnOptions.plan === true ? { plan: true } : {}),
            ...(turnOptions.forkSession === true ? { forkSession: true } : {}),
            ...(turnOptions.enableAskUserQuestion === true ? { enableAskUserQuestion: true } : {}),
            ...(runtimeEnv === undefined ? {} : { runtimeEnv }),
            ...(config.modelId ? { modelId: config.modelId } : {}),
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
  nativeSessions?: CodingNsHostServices['nativeSessions'],
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
    const configuredAdapter = session.adapterId !== 'dsh' && registry.isEnabled(session.adapterId)
      ? session.adapterId
      : typeof config.provider === 'string' && registry.isEnabled(config.provider)
        ? config.provider
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
    return { ...routeConfig, provider: configuredAdapter, model }
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

    let translatedInput: readonly CodingNsCliMessage[] | undefined
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
    if (translatedInput !== undefined) messages = [...translatedInput]

    const decision = await next()
    if (!isEnterPreStepDecision(decision)) return decision
    // Match producer-owned messages by identity. Downstream middleware may insert
    // instructions before the human message, so a positional prefix loses data.
    const incoming = Array.isArray(record?.messages) ? record.messages.filter(isMessage) : []
    const replaced = new Set<number>()
    const accepted = delegation?.kind === 'rewritten' || translatedInput !== undefined
      ? decision.messages.map(message => {
        const index = incoming.findIndex((original, position) => !replaced.has(position) && (
          original === message || typeof original.id === 'string' && original.id === message.id
          // Legacy callers can return detached messages without durable IDs.
          || original.id === undefined && message.id === undefined && original.role === message.role
            && original.source?.kind === message.source?.kind && original.source?.form === message.source?.form
            && JSON.stringify(original.content) === JSON.stringify(message.content)
        ))
        if (index >= 0) replaced.add(index)
        return index < 0 ? message : messages[index] ?? message
      }) : decision.messages
    try {
      const scope = sessionPromptScope(record?.agent, isAbortSignal(record?.signal) ? record.signal : undefined)
      return { ...decision, messages: await promptTranslation.translateMessages(accepted, scope) }
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
 */
async function* guardDshNativeStream(next: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
  let meaningful = false
  const terminal: unknown[] = []
  for await (const chunk of next()) {
    if (isDshFinishChunk(chunk)) {
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

function isMeaningfulDshChunk(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  if (record.type === 'text-delta' || record.type === 'reasoning-delta' || record.type === 'usage' || record.type === 'tool-call' || record.type === 'tool-result') return true
  if (record.type === 'block-end') {
    const block = asRecord(record.block)
    return typeof block?.text === 'string' && block.text !== ''
  }
  return false
}

function readAdapterId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.adapterId !== 'string' || record.adapterId.trim() === '') throw new Error('adapterId 不能为空')
  return record.adapterId.trim()
}

function readSubscriptionRequest(value: unknown): { adapterId: string; providerId?: string; modelId?: string } {
  const record = asRecord(value)
  if (record === null || record.adapterId === undefined) return { adapterId: 'command-code' }
  const adapterId = readAdapterId(value)
  return {
    adapterId,
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
  const entries = Object.entries(candidate).filter(([, item]) => typeof item === 'string') as [string, string][]
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/** DSH Session 快照把最近选择放在 modelSelection.lastUsed/next。 */
function readModelSelectionCandidates(value: Record<string, any> | null): Record<string, any>[] {
  const result: Record<string, any>[] = []
  for (const candidate of [value, asRecord(value?.request), asRecord(value?.config), asRecord(value?.header), asRecord(asRecord(value?.record)?.rows)]) {
    const selection = asRecord(candidate?.modelSelection)
    if (selection !== null) result.push(selection)
    const lastUsed = asRecord(selection?.lastUsed)
    const next = asRecord(selection?.next)
    const pending = asRecord(selection?.pending)
    if (lastUsed !== null) result.push(lastUsed)
    if (next !== null) result.push(next)
    if (pending !== null) result.push(pending)
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
    // 旧会话和 DSH 原生投影的 source 形状不完全一致；只要是模型消息就读取
    // provider，最终仍由 selectExternalAdapter 校验是否为已启用外部适配器。
    if (source?.kind !== 'model') continue
    const provider = source.provider
    if (typeof provider === 'string' && provider.trim() !== '') return provider.trim()
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
): Promise<readonly CodingNsCliMessage[] | undefined> {
  if (translation === undefined || !translation.enabled || sessionId.trim() === '') return undefined

  const messageIndex = findLatestHumanMessage(messages)
  const current = messageIndex < 0 ? undefined : messages[messageIndex]
  if (current === undefined || readInputTranslation(current.source) !== undefined) return undefined

  if (nativeSession !== undefined) {
    // DSH 原生会话：消息本身就是发给 Provider 的正文，直接替换为译文并把原文留在元数据。
    if (nativeSession.translationEnabled !== true) return undefined
    const input = extractTurnInput(messages, dshContext)
    if (input.translationPrompt.trim() === '') return undefined
    const result = await translationRecovery.translateInput(sessionId, nativeSession.adapterId, input.translationPrompt, signal)
    const translated = [result.translated, input.untranslatedPrompt].filter((part) => part.trim() !== '').join('\n\n').trim()
    if (translated === '') return undefined
    const record: SessionTranslationInputRecord = {
      original: input.prompt,
      translated,
      ...(result.sourceLanguage === undefined ? {} : { sourceLanguage: result.sourceLanguage }),
      targetLanguage: readInputTargetLanguage(translation),
      ...(result.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
      ...(result.model === undefined ? {} : { model: result.model }),
      ...readSessionTranslationMetrics(result),
      ...(result.failed === true ? { failed: true } : {}),
    }
    const next = [...messages]
    next[messageIndex] = {
      ...current,
      content: result.failed ? current.content : [{ type: 'text', text: translated }],
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
  if (session.adapterId === 'dsh' || session.translationEnabled !== true) return undefined

  const input = extractTurnInput(messages, dshContext)
  if (input.translationPrompt.trim() === '') return undefined

  const result = await translationRecovery.translateInput(sessionId, session.adapterId, input.translationPrompt, signal)
  const translated = [result.translated, input.untranslatedPrompt]
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
  text: string
  closed: boolean
}

/**
 * DSH 原生会话的输出翻译。
 *
 * 原生回复由 DSH 自己组装成 `assistant/message`，插件只能在 Provider 流边界改写：
 * 文本与思考增量先缓存，块结束时一次性发出原文，并把译文放进记录供客户端显示；
 * 工具调用、usage 与 finish 原样透传。翻译失败、流中断或异常都会补发原文块，保证回复不丢失。
 */
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
    const created: NativeStreamBlock = { index, kind, text: '', closed: false }
    blocks.set(index, created)
    return created
  }

  const translateBlock = async (block: NativeStreamBlock): Promise<readonly unknown[]> => {
    const original = block.text
    if (original.trim() === '') return []
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
          ...readSessionTranslationMetrics(result),
          ...(result.failed === true ? { failed: true } : {}),
        }
      }
    } catch {
      record = { original, translated: original, targetLanguage: translation.outputLanguage ?? 'zh', outputKind: kind, bilingual, failed: true }
    }
    if (record === undefined) return []
    const visible = formatSessionTranslationOutput(record)
    if (visible.trim() === '' || visible === original && record.failed !== true) return []
    return [
      // Keep the provider text in the native history. The client chooses the translated
      // text for display from codingnsTranslation.translated.
      { type: `${block.kind}-delta`, index: block.index, text: original, codingnsTranslation: record },
      { type: 'block-end', index: block.index, block: { type: block.kind, text: original, codingnsTranslation: record }, codingnsTranslation: record },
    ]
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
        if (block === undefined) { yield chunk; continue }
        block.text += record.text
        continue
      }
      if (type === 'block-end' && index !== undefined) {
        const block = blocks.get(index)
        if (block !== undefined && !block.closed) {
          block.closed = true
          if (block.text.trim() !== '') {
            const emitted = await translateBlock(block)
            for (const item of emitted) yield item
            if (emitted.length > 0) continue
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
   * Provider 未发送 block-end（中断或异常）时，把缓存正文按原文补发。
   *
   * 不能用 `finally` 里的 `yield`：异常正在传播时生成器已经结束，后续 yield 会被
   * 直接丢弃，用户会看不到已经生成的半截回复。
   */
  function* flushBuffered(): Generator<unknown> {
    for (const block of [...blocks.values()]) {
      if (block.closed || block.text.trim() === '') continue
      block.closed = true
      yield { type: `${block.kind}-delta`, index: block.index, text: block.text }
      yield { type: 'block-end', index: block.index, block: { type: block.kind, text: block.text } }
    }
  }
}

function extractTurnInput(
  messages: readonly CodingNsCliMessage[],
  dshContext?: CodingNsHostServices['dshContext'],
): {
  readonly prompt: string
  readonly attachments: readonly CodingNsCliAttachment[]
  /** 只翻译用户自然语言和引用文本；附件提示保持原文。 */
  readonly translationPrompt: string
  readonly untranslatedPrompt: string
  /** 继续提示是 Host 注入的控制文本，不应再送入用户输入翻译。 */
  readonly translatePrompt: boolean
  /** 当前轮已拼入 prompt 的引用上下文不再作为历史消息重复交给驱动。 */
  readonly messages: readonly CodingNsCliMessage[]
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isInjectedStepNotice(message)) {
      const prompt = extractText(message.content)
      return { prompt, translationPrompt: prompt, untranslatedPrompt: '', attachments: [], translatePrompt: false, messages }
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
        return {
          prompt: translatedInput.translated,
          translationPrompt: translatedInput.translated,
          untranslatedPrompt: '',
          attachments: direct.attachments,
          translatePrompt: false,
          messages: stripInputTranslationDisplay(forwarded),
        }
      }
      return {
        prompt: [direct.prompt, ...referenceText].filter(text => text.trim() !== '').join('\n\n').trim(),
        translationPrompt: [direct.translationPrompt, ...referenceText].filter(text => text.trim() !== '').join('\n\n').trim(),
        untranslatedPrompt: direct.untranslatedPrompt,
        attachments: direct.attachments,
        translatePrompt: true,
        messages: stripInputTranslationDisplay(forwarded),
      }
    }
  }
  return { prompt: '', translationPrompt: '', untranslatedPrompt: '', attachments: [], translatePrompt: false, messages: stripInputTranslationDisplay(messages) }
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
  const targetLanguage = candidate.targetLanguage === 'fr' || candidate.targetLanguage === 'de' || candidate.targetLanguage === 'ja'
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

/** DSH 为工具分段注入的继续提示必须成为下一次 Provider 请求的 prompt。 */
function isInjectedStepNotice(message: CodingNsCliMessage): boolean {
  if (message.role !== 'user' || !isRecord(message.source)) return false
  if (message.source.form !== 'notice') return false
  return message.source.kind === 'model-selection'
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
} {
  if (typeof content === 'string') return { prompt: content, translationPrompt: content, untranslatedPrompt: '', attachments: [] }
  if (!Array.isArray(content)) return { prompt: '', translationPrompt: '', untranslatedPrompt: '', attachments: [] }
  const text: string[] = []
  const attachments: CodingNsCliAttachment[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (typeof part.text === 'string' && part.text.trim() !== '') text.push(part.text)
    const kind = part.type === 'image' ? 'image' : part.type === 'file' ? 'file' : null
    if (kind === null) continue
    const reference = isRecord(part.attachment) ? part.attachment : part
    const path = resolveDshAttachmentPath(dshContext, kind, reference)
    if (path === undefined) continue
    const name = typeof reference.name === 'string' && reference.name.trim() !== '' ? reference.name.trim() : undefined
    const mimeType = typeof reference.mediaType === 'string' && reference.mediaType.trim() !== '' ? reference.mediaType.trim() : undefined
    attachments.push({ kind, path, ...(name === undefined ? {} : { name }), ...(mimeType === undefined ? {} : { mimeType }) })
  }
  const fileNotes = attachments.filter((attachment) => attachment.kind === 'file').map((attachment) => `附件文件${attachment.name === undefined ? '' : `「${attachment.name}」`}位于：${attachment.path}\n请使用工具读取该文件的内容。`)
  const translationPrompt = text.join('\n\n').trim()
  const untranslatedPrompt = fileNotes.join('\n\n').trim()
  return { prompt: [translationPrompt, untranslatedPrompt].filter(value => value !== '').join('\n\n'), translationPrompt, untranslatedPrompt, attachments }
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
