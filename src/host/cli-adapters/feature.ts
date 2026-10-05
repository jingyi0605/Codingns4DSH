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
import { setMaxNativeSubagentsPerParent } from './native-subagent-dispatch.js'
import { containsDelegationCarrier, rewriteDelegationMessages } from './delegation-mention-rewrite.js'
import { clearDelegationAuthorization, setDelegationAuthorization } from './delegation-authorization.js'
import { debugInfo } from '../../shared/debug.js'

export function createCliAdaptersFeature(options: { registry?: CodingNsCliAdapterRegistry } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'cliAdapters',
      version: '0.1.1',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    async start(context) {
      // 用量查询超时对所有适配器统一生效：同一个 timeoutMs 下发给全部网络读取器，
      // 设置变更时整体重建，避免旧超时继续生效。
      const buildSubscriptions = (settings: CodingNsSettings | undefined): ProviderSubscriptionService => {
        const timeoutMs = normalizeSubscriptionUsageSettings(settings?.subscriptionUsage).timeoutSecs * 1000
        return new ProviderSubscriptionService({ commandCode: new CommandCodeSubscriptionService({ timeoutMs }), timeoutMs })
      }
      let subscriptions = buildSubscriptions(context.services.settings?.get())
      // 注入的 registry 自带 SessionStore；只有自建时才有本地 store 变量。
      const sessionStore = options.registry?.sessionRecords
        ?? new CodingNsCliSessionStore(context.services.settings === undefined ? {} : { settings: context.services.settings })
      const nativeSessions = context.services.nativeSessions
      // fork 子会话的绑定来自父会话，启动迁移也必须补齐祖先链。
      if (nativeSessions !== undefined) {
        const migration = sessionStore.migrateLegacySessions(
          expandMigrationChain(nativeSessions, nativeSessions.list()),
        )
        if (migration.migrated > 0 || migration.unresolved > 0) {
          debugInfo('codingns4dsh: 旧外部会话适配器迁移完成', migration)
        }
      }
      const registry = options.registry ?? new CodingNsCliAdapterRegistry([
        new CommandCodeDriver(),
        new ClaudeCodeDriver(),
        new KimiCliDriver(),
        new GeminiCliDriver(),
        new PiAgentDriver(),
        new CodexAppServerDriver(),
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
      registry.warmCatalog()
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
              sessionStore.migrateLegacySessions(collectMigrationChain(nativeSessions, session))
            }
            const current = sessionStore.get(sessionId)
            if (current === undefined || current.status === 'archived') return
            if (eventType === 'turn/start') {
              sessionStore.upsert(sessionId, { ...current, status: 'active' })
            } else if (eventType === 'turn/end') {
              sessionStore.upsert(sessionId, { ...current, status: 'idle' })
            }
          },
        })
        context.resources.add(disposeNativeEvents)
      }
      registerDelegationAgentHooks(context.services.dshContext, registry, context.resources)
      context.resources.add(context.services.rpc.register('cli', (action, payload) => {
        switch (action) {
          case 'catalog': return registry.catalog()
          case 'models': {
            const adapterId = readAdapterId(payload)
            return adapterId === 'dsh' ? readDshModelCatalog(context.services.dshContext) : registry.models(adapterId)
          }
          case 'skills': {
            const request = readSkillsRequest(payload)
            const cwd = resolveSessionCwd(context.services.nativeSessions, request.sessionId, null)
            return registry.listSkills(request.sessionId, {
              ...(cwd === undefined ? {} : { cwd }),
              ...(request.forceReload ? { forceReload: true } : {}),
            })
          }
          case 'adapter/set': return setAdapterEnabled(context.services.settings, registry, payload)
          case 'session/get': return registry.getSession(readSessionId(payload))
          case 'session/set': return registry.setSession(readSessionId(payload), readSessionConfig(payload))
          case 'session/list': return registry.listSessions(readSessionListOptions(payload))
          case 'session/adapter-map':
            // DSH 历史会话的 seed 事件不会发布 session/event；每次读取映射时
            // 重新检查当前已加载对象，覆盖“用户刚点击打开旧会话”的路径。
            // 子会话的父会话可能尚未出现在 list() 里，按需补齐祖先链。
            if (nativeSessions !== undefined) {
              sessionStore.migrateLegacySessions(expandMigrationChain(nativeSessions, nativeSessions.list()))
            }
            return sessionStore.adapterBindings()
          case 'session/archive': return registry.archiveSession(readSessionId(payload))
          case 'session/steer': return registry.steer(readSessionId(payload), readPrompt(payload), false)
          case 'session/follow-up': return registry.steer(readSessionId(payload), readPrompt(payload), true)
          case 'session/interrupt': return registry.interrupt(readSessionId(payload))
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
          subscriptions = buildSubscriptions(next)
          syncSubagentBridgeSettings(next.subagentBridge)
        }))
      }

      const events = context.services.events
      if (events !== undefined) {
        const dispose = events.on('llm/stream', async function* (options: unknown, next: () => AsyncIterable<unknown>) {
          const value = asRecord(options)
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
            const delegation = rewriteDelegationMessages(messages, await registry.catalog())
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
            yield* guardDshNativeStream(next)
            return
          }
          const cwd = resolveSessionCwd(context.services.nativeSessions, sessionId, value)
          const turnInput = extractTurnInput(messages, context.services.dshContext)
          const turnOptions = readCliTurnOptions(value)
          const runtimeEnv = readCliRuntimeEnv(value)
          // 权限状态必须与 DSH 会话当前生效值同源。驱动不能自行假设“完全权限”，
          // 也不能把缺省当成“已确认无限制”：解析失败时留空，由驱动沿用保守默认。
          const permission = resolveSessionPermission(context.services.dshContext, sessionId)
          // 只有 Provider 驱动明确维护了稳定的 turn 分段，才把工具边界映射为 DSH step。
          // Command Code、Codex 会在下一个 assistant 消息处结束当前 step；未声明分段
          // 支持的驱动（如 OpenCode）仍把整轮保持在一个 step，避免 token-meter 在下一
          // 条 usage 到达前失去投影。
          const input = {
            sessionId,
            messages: turnInput.messages,
            prompt: turnInput.prompt,
            ...(turnInput.attachments.length === 0 ? {} : { attachments: turnInput.attachments }),
            ...(permission === undefined ? {} : { permission }),
            ...(turnOptions.plan === true ? { plan: true } : {}),
            ...(turnOptions.forkSession === true ? { forkSession: true } : {}),
            ...(turnOptions.enableAskUserQuestion === true ? { enableAskUserQuestion: true } : {}),
            ...(runtimeEnv === undefined ? {} : { runtimeEnv }),
            ...(config.modelId ? { modelId: config.modelId } : {}),
            ...(config.effortId ? { effortId: config.effortId } : {}),
            ...(config.serviceTierId ? { serviceTierId: config.serviceTierId } : {}),
            ...(config.providerSessionId ? { providerSessionId: config.providerSessionId } : {}),
            ...(config.rawStoreRef ? { rawStoreRef: config.rawStoreRef } : {}),
            ...(cwd === undefined ? {} : { cwd }),
            ...(isAbortSignal(value?.signal) ? { signal: value.signal } : {}),
            ...((registry.supportsSegmentedTurns(config.adapterId) || registry.supportsToolStepSplitting(config.adapterId))
              && nativeSessions?.available === true
              && nativeSessions.injectNextStep !== undefined
              && (nativeSessions.canInjectNextStep === undefined
                || nativeSessions.canInjectNextStep(sessionId))
              ? { splitToolSteps: true }
              : {}),
          }
          const projector = new CodingNsDshMessageProjector({
            adapterId: config.adapterId,
            sessionId,
            ...(config.modelId === undefined ? {} : { modelId: config.modelId }),
            ...(nativeSessions === undefined ? {} : { nativeSessions }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            respondPermission: (response) => registry.respondPermission(sessionId, response),
            respondQuestion: (response) => registry.respondQuestion(sessionId, response),
          })
          const discardSuspendedTurn = (): void => registry.discardSegmentedTurn(sessionId)
          input.signal?.addEventListener('abort', discardSuspendedTurn, { once: true })
          if (input.signal?.aborted) discardSuspendedTurn()
          // DSH UI 的会话未读绿点由 api-session/status 的 true -> false 转换驱动。
          // 外部适配器绕过 DSH 原生 Agent Loop，必须在真正执行外部流前补发同一状态，
          // 否则外部子会话完成后虽已写入历史，侧栏却永远不会生成 completionUnread。
          publishExternalSessionStatus(context.services.events, sessionId, true)
          try {
            for await (const chunk of registry.execute({ ...input, adapterId: config.adapterId })) {
              if (chunk.type === 'step-boundary') {
                // Agent Loop 会在本次 llm/stream 返回后关闭当前 step，并在返回前
                // 检查 next-step inbox。必须先注入，再发送 finish，不能等 complete()
                // 之后再写入，否则 DSH 已经把整个 turn 结算完了。
                const injected = nativeSessions?.available === true
                  ? nativeSessions.injectNextStep?.(sessionId) ?? false
                  : false
                if (!injected) discardSuspendedTurn()
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
            publishExternalSessionStatus(context.services.events, sessionId, false)
          }
        })
        if (typeof dispose === 'function') context.resources.add(() => { (dispose as () => void)() })
      }
      context.resources.add(async () => {
        // DSH 先停用设置上下文再执行异步资源清理时，旧的写队列不能继续调用
        // configEditor，否则会出现 inactive context 并污染退出日志。
        sessionStore.dispose()
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

/** 发布外部回合运行状态，让 DSH 原生 UI 能正确维护完成未读标记。 */
function publishExternalSessionStatus(events: CodingNsHostServices['events'], sessionId: string, running: boolean): void {
  if (sessionId.trim() === '' || events?.emit === undefined) return
  try {
    events.emit('api-session/status', sessionId, running)
  } catch {
    // 状态提示是 UI 增强能力，不能因为精简 Host 没有完整事件转发器而阻断回合。
  }
}

/**
 * 在 Agent Loop 的可变输入边界消费委派 carrier。
 *
 * `llm/stream` 收到的 LOOP 请求由 DSH 深冻结，监听器只能读取；如果在那里改写
 * `messages`，会直接抛出只读属性异常。`agent/pre-step` 返回新的决策消息，随后由
 * Agent Loop 负责把改写后的内容写入当前会话并构造下一次只读 LLM 请求。
 */
function registerDelegationAgentHooks(
  dshContext: CodingNsHostServices['dshContext'],
  registry: CodingNsCliAdapterRegistry,
  resources: FeatureResourceScope,
): void {
  if (dshContext === undefined || typeof dshContext.on !== 'function') return
  const disposers: Array<() => void> = []
  const register = (name: string, listener: (...args: any[]) => unknown): void => {
    const disposer = dshContext.on(name as never, listener as never, { global: true } as never)
    if (typeof disposer === 'function') disposers.push(disposer as () => void)
  }

  register('agent/pre-step', async (payload: unknown, next: () => Promise<unknown>) => {
    const record = asRecord(payload)
    const sessionId = readAgentSessionId(record?.agent)
    const messages = Array.isArray(record?.messages) ? record.messages.filter(isMessage) : []
    let delegation: ReturnType<typeof rewriteDelegationMessages> | undefined
    if (containsDelegationCarrier(messages)) {
      delegation = rewriteDelegationMessages(messages, await registry.catalog())
      if (delegation.kind === 'error') clearDelegationAuthorization(sessionId)
      else if (delegation.kind === 'rewritten') {
        setDelegationAuthorization(sessionId, delegation.value.targets)
      }
    }

    const decision = await next()
    if (delegation?.kind !== 'rewritten' || !isEnterPreStepDecision(decision)) return decision

    // `next()` 可能已经追加系统上下文或模型切换通知，只替换它前面的本轮用户消息。
    const suffix = decision.messages.slice(messages.length)
    return {
      ...decision,
      messages: [...delegation.value.messages, ...suffix],
    }
  })

  // 正常结束、异常结束和中断最终都会进入 idle；在此清理本轮授权，避免下一轮
  // 没有 carrier 时继承上一轮的目标白名单。
  register('agent/status', (payload: unknown) => {
    const record = asRecord(payload)
    if (record?.status === 'idle') clearDelegationAuthorization(readAgentSessionId(record?.agent))
  })
  register('agent/disposed', (payload: unknown) => {
    clearDelegationAuthorization(readAgentSessionId(asRecord(payload)?.agent))
  })

  resources.add(() => {
    for (const dispose of disposers.reverse()) dispose()
  })
}

function isEnterPreStepDecision(value: unknown): value is { kind: 'enter'; messages: readonly CodingNsCliMessage[] } {
  const record = asRecord(value)
  return record?.kind === 'enter' && Array.isArray(record.messages)
}

function readAgentSessionId(value: unknown): string {
  const record = asRecord(value)
  if (typeof record?.id === 'string' && record.id.trim() !== '') return record.id.trim()
  const session = asRecord(record?.session)
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
  return chain
}

/** 对一批会话逐个补齐祖先链，保持原有顺序并去重。 */
function expandMigrationChain(
  nativeSessions: CodingNsHostServices['nativeSessions'],
  sessions: readonly unknown[],
): readonly unknown[] {
  const result: unknown[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    for (const entry of collectMigrationChain(nativeSessions, session)) {
      const record = asRecord(entry)
      const id = typeof record?.id === 'string' ? record.id : ''
      if (id !== '' && seen.has(id)) continue
      if (id !== '') seen.add(id)
      result.push(entry)
    }
  }
  return result
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

function extractTurnInput(
  messages: readonly CodingNsCliMessage[],
  dshContext?: CodingNsHostServices['dshContext'],
): {
  readonly prompt: string
  readonly attachments: readonly CodingNsCliAttachment[]
  /** 当前轮已拼入 prompt 的引用上下文不再作为历史消息重复交给驱动。 */
  readonly messages: readonly CodingNsCliMessage[]
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && isInjectedStepNotice(message)) {
      return { prompt: extractText(message.content), attachments: [], messages }
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
      return {
        prompt: [direct.prompt, ...referenceText].filter(text => text.trim() !== '').join('\n\n').trim(),
        attachments: direct.attachments,
        messages: forwarded,
      }
    }
  }
  return { prompt: '', attachments: [], messages }
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

function extractMessageInput(content: unknown, dshContext?: CodingNsHostServices['dshContext']): { readonly prompt: string; readonly attachments: readonly CodingNsCliAttachment[] } {
  if (typeof content === 'string') return { prompt: content, attachments: [] }
  if (!Array.isArray(content)) return { prompt: '', attachments: [] }
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
  return { prompt: [...text, ...fileNotes].join('\n\n').trim(), attachments }
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
