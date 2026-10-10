import { randomUUID } from 'node:crypto'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { VoiceRuntimeCapabilities, VoiceRuntimeEvent, VoiceRuntimeState } from '../../shared/contracts/voice-runtime.js'
import type { CodingNsHostServices } from './types.js'
import type { AssistantSessionSourceRecord } from './assistant-session-index.js'
import { createAssistantScope, getAssistantScopeState } from './assistant-scope.js'
import { AssistantDispatcher } from './assistant-dispatch.js'
import { AssistantVoiceTurnRouter } from './assistant-voice-turn.js'
import { buildAssistantSessionIndex, type AssistantSessionIndexSnapshot } from './assistant-session-index.js'
import { sanitizeSpeechText, summarizeAssistantEntries } from './assistant-summary.js'
import { parseAssistantIntent } from './assistant-intent.js'
import type { AssistantDebugSnapshot, AssistantLifecycleSnapshot, SessionIndexEntry } from '../../shared/contracts/assistant.js'
import { AssistantIndexUpdates, assistantSessionKey, isAssistantIndexEvent } from './assistant-index-updates.js'
import { AssistantBackground } from './assistant-background.js'
import { readAssistantPrompts } from '../../shared/assistant-prompts.js'
import { createAssistantChatSystem } from './assistant-prompts.js'
import { speakAssistantStructuredIndex } from './assistant-structured-index.js'
import { AssistantIndexAnalysis } from './assistant-index-analysis.js'
import { AssistantIndexJournal } from './assistant-index-journal.js'
import { AssistantTextChat } from './assistant-text-chat.js'
import { AssistantVoiceChat } from './assistant-voice-chat.js'
import { createAssistantLlmAdapter, type AssistantLlmAdapter } from '../../dsh-capabilities/host/assistant-llm-adapter.js'
import { createAssistantAgentAdapter, ASSISTANT_AGENT_PREFIX } from '../../dsh-capabilities/host/assistant-agent-adapter.js'
import { readAssistantAttachmentStore } from '../../dsh-capabilities/host/assistant-attachment-adapter.js'
import { readAssistantAttachmentUploads } from '../../shared/assistant-attachments.js'
import { createAssistantManagementTools, type AssistantManagementSnapshot } from './assistant-management-tools.js'
import { minimumSupportedDshVersion } from '../../shared/contracts/version.js'
import { GlobalVoiceCoordinator } from './global-voice-coordinator.js'
import { VoiceAgentService } from './voice-agent-service.js'
import { createAssistantVoiceActionBridge } from './voice-agent-actions.js'
import { AssistantWaitingState } from './assistant-waiting-state.js'
import { debugInfo } from '../../shared/debug.js'
import { createAssistantVoiceStreamHandler } from './assistant-voice-stream.js'
import { SherpaWorkerRuntime } from './sherpa-worker-runtime.js'
import { buildAssistantVoiceHotwords, readAssistantVoiceHotwords } from './assistant-voice-hotwords.js'
import { DEFAULT_ASSISTANT_SETTINGS, DEFAULT_ASSISTANT_VOICE_SETTINGS, type AssistantSettings, type AssistantVoiceSettings } from '../../shared/contracts/config.js'
import { AssistantVoiceModelManager, type AssistantVoiceModelProbe } from './voice-model-management.js'
import type { AssistantVoiceModelProgress, AssistantVoiceModelsSnapshot } from '../../shared/voice-models.js'
import { AssistantTtsService } from './assistant-tts-service.js'
import type { AssistantTtsSnapshot } from '../../shared/assistant-tts.js'
import { AssistantConversation, type AssistantConversationContext } from './assistant-conversation.js'
import { createAssistantConversationStorage, type AssistantConversationStorage } from './assistant-conversation-storage.js'
import { DEFAULT_ASSISTANT_NAME, assistantWorkspaceMatches, readAssistantProfile, readAssistantPersonality, validateAssistantModel, validateAssistantPersonality } from '../../shared/assistant-lifecycle.js'
import { createVirtualWorkspaceId } from '../../shared/contracts/peer-host.js'
import { configureAssistantSettings } from './assistant-lifecycle-settings.js'
import { AssistantVoiceInitialization } from './assistant-voice-initialization.js'
import { installVoiceDiagnostics } from '../voice-diagnostics.js'
import { measureVoice, traceVoice, sanitizeVoiceDiagnosticFields } from '../../shared/voice-diagnostics.js'
import { assistantSourceCache } from './assistant-source-cache.js'
import { AssistantNotificationEvents } from './assistant-notification-events.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { AssistantNotificationAckRequest, AssistantNotificationReadRequest, AssistantNotificationTargetRequest } from '../../shared/assistant-notifications.js'
import { AssistantNotificationSource } from './assistant-notification-source.js'
import { readAssistantNotificationFeedRequest, type AssistantNotificationFact as AssistantSourceFact } from '../../shared/assistant-notification-feed.js'
import { bindDesktopAssistantNotifications } from '../desktop-assistant/notifications.js'
import { AssistantNotificationController } from './assistant-notification-stream.js'

/**
 * 全局智能助理 Host 边界。
 *
 * 这里故意不接收 sessionId：会话索引、意图和派发各自通过快照协作，语音租约
 * 只属于 Host。这样刷新页面或切换当前对话不会改变助理的目标范围。
 */
export function createGlobalVoiceRpcFeature(options: { readonly probeVoiceModel?: AssistantVoiceModelProbe; readonly conversationStorage?: AssistantConversationStorage; readonly conversationAdapter?: AssistantLlmAdapter } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'globalVoiceRpc',
      version: '0.2.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
      requires: [{ capability: 'assistant.agent', required: false, fallback: 'degrade' }],
    },
    start(context) {
      const diagnostics = installVoiceDiagnostics(() => coordinator.snapshot().active)
      if (diagnostics !== undefined) context.resources.add(diagnostics.dispose)
      let resetting = false
      let disposed = false
      let statusRevision = 0
      let indexAbort = new AbortController()
      // 每次读取当前档案，资源准备与旧配置都不能隐式创建助理。
      const assistantProfile = () => readAssistantProfile(context.services.settings?.get().assistant ?? DEFAULT_ASSISTANT_SETTINGS)
      const automaticEnabled = (): boolean => !disposed && !resetting && context.services.settings?.get().modules.globalVoiceAssistant === true
        && assistantProfile().initialized && (context.services.settings?.get().assistant.managedWorkspaceIds.length ?? 0) > 0
      let lifecycleRevision = 0
      const tts = new AssistantTtsService(context.services, { isVoiceActive: () => coordinator.snapshot().active })
      context.resources.add(() => tts.dispose())
      const runtime = new SherpaWorkerRuntime({
        env: buildSherpaRuntimeEnvironment(readAssistantVoiceSettings(context.services)),
      })
      const agent = new VoiceAgentService({
        secureContext: true,
        ...runtime.capabilities,
      })
      const updateVoiceAgentCapabilities = (): void => {
        agent.updateCapabilities({
          secureContext: true,
          realtime: runtime.capabilities.realtime,
          recognition: runtime.capabilities.speechToText,
          audioInput: runtime.capabilities.streamingInput,
          wakeWord: runtime.capabilities.wakeWord,
          bargeIn: runtime.capabilities.bargeIn,
          streamingAudio: tts.outputReady || runtime.capabilities.streamingOutput,
          readAloud: tts.outputReady || runtime.capabilities.textToSpeech,
          voices: tts.outputReady || runtime.capabilities.textToSpeech,
        })
      }
      const disposeVoiceAgent = provideHostVoiceAgentService(context.services.dshContext, agent)
      if (disposeVoiceAgent !== undefined) context.resources.add(disposeVoiceAgent)
      const dispatcher = new AssistantDispatcher((request, signal) => dispatchPrompt(context.services, request, signal))
      const router = new AssistantVoiceTurnRouter(dispatcher)
      const waitingState = new AssistantWaitingState()
      let lastSnapshot: AssistantSessionIndexSnapshot | null = null
      const indexedEntries = new Map<string, SessionIndexEntry>()
      let lastArchivedSessionIds: readonly string[] = []
      let buildingIndex: Promise<AssistantSessionIndexSnapshot> | undefined
      let buildingIndexRevision = 0
      const journal = new AssistantIndexJournal()
      const llm = createAssistantLlmAdapter(context.services.dshContext, context.services.dshVersion ?? minimumSupportedDshVersion())
      const textChat = new AssistantTextChat(llm)
      const managementTools = createAssistantManagementTools({
        dispatcher,
        snapshot: (signal) => readManagementSnapshot(signal),
        read: async (entry, signal) => {
          const revision = lifecycleRevision
          const managed = assistantSettings().managedWorkspaceIds
          const source = await readAssistantSource(context.services, managed, waitingState, signal)
          signal.throwIfAborted()
          if (resetting || revision !== lifecycleRevision) throw new Error('助理管理范围已变化，请重新查询')
          const current = source.sessions.find((item) => item.hostId === entry.hostId && item.sessionId === entry.sessionId && item.workspaceId === entry.workspaceId)
          if (current === undefined || source.archivedSessionIds.includes(entry.sessionId)) throw new Error('目标会话已退出助理管理范围')
          const summary = await source.readSummary?.(current, signal) ?? null
          signal.throwIfAborted()
          if (resetting || revision !== lifecycleRevision) throw new Error('助理管理范围已变化，请重新查询')
          return summary
        },
      })
      const managementAgent = createAssistantAgentAdapter(context.services.dshContext, context.services.dshVersion ?? minimumSupportedDshVersion(), llm, managementTools)
      const notificationSource = new AssistantNotificationSource({ recover: (workspaceIds) => notifications.recoverSource(workspaceIds).map(toSourceNotificationFact), capabilities: () => ({ completed: true, error: true, requests: true, resolve: true, recovery: notifications.recoverySupported }) })
      context.resources.add(() => notificationSource.dispose())
      const notifications = new AssistantNotificationEvents(context.services, { enabled: () => !resetting && !disposed, excludedSessionIds: () => managementAgent.sessionIds, onFact: (fact) => notificationSource.append(toSourceNotificationFact(fact)) })
      context.resources.add(() => notifications.dispose())
      // 通知页面只在首次连接和连接代次变化时读取快照，正常变化走 Typert Remote WebSocket。
      // TypertRemoteService 只能在真正的 Cordis Host Context 上注册；没有 typert
      // 注册表的测试夹具和纯 RPC 宿主跳过 Remote，读取继续由 rpc-table 承担。
      const notificationContext = context.services.dshContext
      if (notificationContext !== undefined && readOptionalService(notificationContext, 'typert') !== undefined) {
        new AssistantNotificationController(notificationContext, notifications.center, {
          source: notificationSource,
          authorizeSource: (workspaceIds) => {
            const allowed = new Set(readWorkspaceRecords(context.services.dshContext).map(workspace => workspace.id))
            if (workspaceIds.some(id => !allowed.has(id))) throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_FORBIDDEN', '通知来源工作区不可访问')
          },
          sourceScope: (workspaceIds) => notifications.sourceScope(workspaceIds),
          renewSourceScope: (workspaceIds) => notifications.renewSourceScope(workspaceIds),
        })
      }
      // 同一 Host 中心供原生时钟和独立列表读取，主页面隐藏时仍准确同步。
      context.resources.add(bindDesktopAssistantNotifications(context.services, {
        read: (input) => { notifications.readCurrent(); return notifications.center.read(input) },
        presented: (input) => { notifications.center.ack(input) },
      }))
      // 正式文字和语音共用连续对话；租约只约束收音和当前语音轮次。
      const voiceTextChat = new AssistantTextChat(options.conversationAdapter ?? managementAgent, '助理 Agent 对话')
      const conversation = new AssistantConversation(voiceTextChat, llm, options.conversationStorage ?? createAssistantConversationStorage(), readAssistantAttachmentStore(context.services.dshContext))
      const previewChat = new AssistantTextChat(llm, '助理预览')
      const voiceChat = new AssistantVoiceChat(voiceTextChat, conversation)
      context.resources.add(async () => { conversation.dispose(); voiceChat.clear(); voiceTextChat.dispose(); previewChat.dispose(); await managementAgent.dispose() })
      const indexAnalysis = new AssistantIndexAnalysis(llm)
      let indexSelection: { provider?: string; model?: string } = { ...context.services.settings?.get().assistant.model }
      const readDefaultModelKey = (): string => { const model = readOptionalService(context.services.dshContext, 'agentDefaultModel')?.currentSelection?.(); return JSON.stringify([model?.provider ?? '', model?.model ?? '']) }
      let defaultModelKey = readDefaultModelKey()
      const materials = new Map<string, { version: number; summary: string | null }>()
      const localHostId = process.env.CODINGNS4DSH_HOST_ID?.trim() || 'local-host'
      const liveActivity = (entry: SessionIndexEntry): 'running' | 'idle' | 'unknown' => {
        const agent = entry.hostId === localHostId ? readOptionalService(context.services.dshContext, 'agents')?.get?.(entry.sessionId) : undefined
        if (agent?.status === 'running' || agent?.status === 'idle') return agent.status
        return entry.activity ?? (entry.running ? 'running' : entry.completed || entry.error === true ? 'idle' : 'unknown')
      }
      const updates = new AssistantIndexUpdates(async () => {
        if (!automaticEnabled()) return
        if (indexAnalysis.read()?.state === 'running' || buildingIndex !== undefined && buildingIndexRevision === indexRevision) return
        const snapshot = await buildIndex('automatic')
        if (automaticEnabled() && (updates.hasReady(snapshot.entries) || indexAnalysis.read()?.generation !== snapshot.generation)) startIndexAnalysis(snapshot, false, true)
      }, liveActivity)
      updates.setEnabled(automaticEnabled())
      context.resources.add(() => textChat.dispose())
      context.resources.add(() => indexAnalysis.dispose())
      context.resources.add(() => updates.dispose())
      const withIndexAnalysis = (snapshot: AssistantSessionIndexSnapshot, metadata: readonly SessionIndexEntry[] = snapshot.entries): AssistantSessionIndexSnapshot => {
        const run = indexAnalysis.read()
        const tasks = new Map((run?.tasks ?? []).map((task) => [assistantSessionKey(task), task]))
        const liveEntries = new Map(metadata.map((entry) => [assistantSessionKey(entry), entry]))
        const entries = snapshot.entries.map((entry) => {
          // 同步运行状态与索引进度，但保留正文实际来自的版本，不能把旧材料伪装成新版本。
          const live = liveEntries.get(assistantSessionKey(entry)) ?? entry
          const { sourceVersion: _currentVersion, ...current } = updates.stamp({ ...entry, waiting: live.waiting, error: live.error ?? false }, tasks.get(assistantSessionKey(entry)))
          return { ...current, ...(entry.sourceVersion === undefined ? {} : { sourceVersion: entry.sourceVersion }) }
        })
        if (run === undefined || run.generation !== snapshot.generation) return { ...snapshot, entries }
        // 模型提取的进展证据保持原样，Host 填充的执行状态跟随当前会话同步。
        const statuses = new Map(entries.map((entry) => [assistantSessionKey(entry), entry.status]))
        const analysis = run.result === undefined ? run : { ...run, result: { ...run.result, sessions: run.result.sessions.map((session) => ({ ...session, sourceStatus: statuses.get(assistantSessionKey(session)) ?? session.sourceStatus })) } }
        return { ...snapshot, entries, analysis }
      }
      const cancelIndexAnalysis = (): void => indexAnalysis.cancelActive()
      // 正文索引立即返回，LLM 在后台生成；轮询现有调试接口即可读取进度与结果。
      const startIndexAnalysis = (snapshot: AssistantSessionIndexSnapshot, retryFailures = false, automatic = false): AssistantSessionIndexSnapshot => {
        if (disposed || resetting || lastSnapshot !== snapshot || automatic && !automaticEnabled()) return withIndexAnalysis(snapshot)
        if (snapshot.entries.length === 0) { cancelIndexAnalysis(); return snapshot }
        const revision = indexRevision
        const prompts = readAssistantPrompts(context.services.settings?.get().assistant.prompts)
        indexAnalysis.start(snapshot, indexSelection, prompts.index,
          () => !disposed && (!automatic || automaticEnabled()) && lastSnapshot === snapshot && sameManagedScope(snapshot, context.services.settings?.get().assistant.managedWorkspaceIds ?? []),
          (run) => {
            if (resetting || revision !== indexRevision || lastSnapshot !== snapshot) return
            statusRevision++
            journal.updateAnalysis(run)
            for (const task of run.tasks ?? []) {
              if (task.state === 'completed') updates.complete(task)
              if (['completed', 'failed', 'cancelled'].includes(task.state)) {
                const entry = snapshot.entries.find((item) => assistantSessionKey(item) === assistantSessionKey(task))
                if (entry !== undefined) updates.attempted(entry)
              }
            }
            if (run.state !== 'running' && updates.hasReady(snapshot.entries)) updates.schedule()
          }, (entry) => updates.canIndex(entry), async (entry, signal) => {
            if (entry.hostId === localHostId) return updates.canIndex(entry)
            // 远端没有本地完成事件：每个真实模型请求前重新确认空闲和版本。
            const managed = context.services.settings?.get().assistant.managedWorkspaceIds ?? []
            const source = await readAssistantSource(context.services, managed, waitingState, signal)
            signal.throwIfAborted()
            if (disposed || resetting || revision !== indexRevision || automatic && !automaticEnabled()) return false
            const metadata = await buildAssistantSessionIndex({ sessions: source.sessions, scope: createAssistantScope(managed), archivedSessionIds: source.archivedSessionIds })
            signal.throwIfAborted()
            if (revision !== indexRevision) return false
            observeVersions(metadata.entries)
            const current = metadata.entries.find((item) => assistantSessionKey(item) === assistantSessionKey(entry))
            return current !== undefined && current.activity === 'idle' && current.updatedAt === entry.updatedAt && updates.canIndex(entry)
          }, retryFailures,
        )
        return withIndexAnalysis(snapshot)
      }
      const chooseIndexModel = (payload: unknown): void => {
        const value = asRecord(payload)
        const provider = readText(value, ['provider']); const model = readText(value, ['model'])
        if (provider === null && model === null) return
        if (provider === null || model === null) throw new Error('索引模型必须同时指定提供商和模型')
        const current = indexSelection.provider === undefined ? indexAnalysis.read() : indexSelection
        if (current?.provider === provider && current.model === model) { indexSelection = { provider, model }; return }
        indexSelection = { provider, model }; cancelIndexAnalysis(); textChat.cancelActive(); voiceChat.clear(); updates.reset()
        statusRevision++
      }
      // 刷新可以清空缓存，但索引代次必须持续递增，不能每次回到 1。
      let indexGeneration = 0
      let indexRevision = 0
      const observeVersions = (entries: readonly SessionIndexEntry[]): boolean => {
        const changed = updates.observe(entries)
        if (changed) statusRevision++
        if (indexAnalysis.read()?.state !== 'running') return changed
        for (const entry of lastSnapshot?.entries ?? []) if (!updates.canIndex(entry)) indexAnalysis.deferSession(assistantSessionKey(entry))
        return changed
      }
      const buildIndex = async (trigger: 'automatic' | 'manual' = 'manual'): Promise<AssistantSessionIndexSnapshot> => {
        if (disposed || resetting || trigger === 'automatic' && !automaticEnabled()) throw new Error('助理后台索引已停止')
        const managed = context.services.settings?.get().assistant?.managedWorkspaceIds ?? []
        const revision = indexRevision
        const signal = indexAbort.signal
        if (buildingIndex !== undefined && buildingIndexRevision === revision) return buildingIndex
        if (buildingIndex !== undefined) { await buildingIndex.catch(() => undefined); signal.throwIfAborted() }
        const { source, metadata } = (await background.read(trigger === 'manual' || metadataDirty)).value
        signal.throwIfAborted()
        if (resetting || revision !== indexRevision) throw new Error('索引任务已撤销')
        if (JSON.stringify(managed) !== JSON.stringify(context.services.settings?.get().assistant.managedWorkspaceIds ?? [])) throw new Error('索引范围已变化')
        if (buildingIndex !== undefined && buildingIndexRevision === revision) return buildingIndex
        if (resetting || revision !== indexRevision) throw new Error('索引任务已撤销')
        observeVersions(metadata.entries)
        const members = new Set(metadata.entries.map(assistantSessionKey))
        for (const key of materials.keys()) if (!members.has(key)) materials.delete(key)
        const materialKeys = new Set(metadata.entries.filter((value) => { const entry = updates.stamp(value); return updates.canIndex(entry) && materials.get(assistantSessionKey(entry))?.version !== entry.sourceVersion }).map(assistantSessionKey))
        if (trigger !== 'manual' && lastSnapshot !== null && sameIndexMembership(lastSnapshot, metadata) && updates.matches(lastSnapshot) && materialKeys.size === 0) return lastSnapshot
        const recordId = journal.begin(trigger, managed)
        statusRevision++
        const failures = new Map<string, string>()
        const task = (async () => {
          lastArchivedSessionIds = source.archivedSessionIds
          const snapshot = await buildAssistantSessionIndex({
            sessions: source.sessions.map((session) => updates.stamp({ ...session, title: session.title ?? null })),
            scope: createAssistantScope(managed),
            archivedSessionIds: source.archivedSessionIds,
            generation: ++indexGeneration,
            ...(source.readSummary === undefined ? {} : { readSummary: async (session: AssistantSessionSourceRecord) => {
              const key = assistantSessionKey(session)
              const cached = materials.get(key)
              const entry = { ...session, title: session.title ?? null }
              if (!updates.canIndex(entry)) return cached?.summary ?? null
              if (cached !== undefined && cached.version === session.sourceVersion) return cached.summary
              try {
                signal.throwIfAborted()
                const summary = await source.readSummary!(session, signal)
                signal.throwIfAborted()
                if (revision === indexRevision && session.sourceVersion !== undefined && updates.canIndex(entry)) materials.set(key, { version: session.sourceVersion, summary })
                return summary
              }
              catch (error) {
                failures.set(`${session.hostId}:${session.sessionId}`, sanitizeSpeechText(error instanceof Error ? error.message : String(error)).slice(0, 500))
                throw error
              }
            } }),
            ...(source.readWaiting === undefined ? {} : { readWaiting: (session: AssistantSessionSourceRecord) => materialKeys.has(assistantSessionKey(session)) ? source.readWaiting!(session, signal) : session.waiting }),
          })
          // 构建期间若源数据已经变化，保留记录，但不能把结果误标为最新。
          signal.throwIfAborted()
          if (revision !== indexRevision || disposed) throw new Error('索引任务已撤销')
          lastSnapshot = snapshot
          indexedEntries.clear()
          for (const entry of snapshot.entries) indexedEntries.set(assistantSessionKey(entry), entry)
          statusRevision++
          journal.complete(recordId, snapshot, source.warnings, failures)
          return snapshot
        })().catch((error) => { journal.fail(recordId, error); throw error }).finally(() => { if (buildingIndex === task) { buildingIndex = undefined; statusRevision++ } })
        buildingIndexRevision = revision; buildingIndex = task
        return task
      }
      const cancelIndexWork = (): void => {
        indexRevision++; indexAbort.abort(new Error('索引任务已撤销')); indexAbort = new AbortController()
        cancelIndexAnalysis()
        // 保留取消证据，但不把因模块停用而撤销的版本标成已尝试。
        const run = indexAnalysis.read()
        if (run !== undefined) journal.updateAnalysis(run)
        statusRevision++
      }
      const invalidateIndex = (): void => { cancelIndexWork(); textChat.cancelActive(); voiceChat.clear(); lastSnapshot = null; updates.reset() }
      let metadataDirty = true
      let membershipDirty = true
      const localSessionKeys = new Map<string, string>()
      const waitingOverrides = new Map<string, 'approval' | 'question' | null>()
      const refreshMembership = (): void => {
        if (!membershipDirty) return
        membershipDirty = false
        localSessionKeys.clear()
        const managed = context.services.settings?.get().assistant.managedWorkspaceIds ?? []
        const archived = new Set(readStringArray(readOptionalService(context.services.dshContext, 'workspaceRegistry')?.archivedSessionIds))
        for (const workspace of readWorkspaceRecords(context.services.dshContext)) {
          if (!managed.some((selected) => assistantWorkspaceMatches(selected, localHostId, workspace.id, true))) continue
          for (const id of workspace.sessionIds) if (!archived.has(id)) localSessionKeys.set(id, assistantSessionKey({ hostId: localHostId, sessionId: id }))
        }
      }
      let metadataEventRevision = 0
      type AssistantMetadata = { source: Awaited<ReturnType<typeof readAssistantSource>>; metadata: AssistantSessionIndexSnapshot; eventRevision: number }
      const background: AssistantBackground<AssistantMetadata> = new AssistantBackground<AssistantMetadata>({
        read: async (signal) => {
          const eventRevision = metadataEventRevision
          const managed = [...context.services.settings?.get().assistant.managedWorkspaceIds ?? []]
          let source = await readAssistantSource(context.services, managed, waitingState, signal)
          signal.throwIfAborted()
          if (source.failed) {
            // 短暂断线不是删除成员。保留同一范围已知远端元数据，但撤销空闲证明，
            // 从而保留材料与成功结果，同时禁止把离线来源当作最新事实送进模型。
            const current = new Set(source.sessions.map(assistantSessionKey))
            const missing = (background.snapshot()?.value.source.sessions ?? []).filter((entry) => entry.hostId !== localHostId && !current.has(assistantSessionKey(entry)))
            source = { ...source, sessions: [...source.sessions, ...missing.map((entry) => ({ ...entry, running: false, completed: false, activity: 'unknown' as const }))] }
          }
          const metadata = await buildAssistantSessionIndex({ sessions: source.sessions, scope: createAssistantScope(managed), archivedSessionIds: source.archivedSessionIds })
          signal.throwIfAborted()
          return { source, metadata, eventRevision }
        },
        publish: ({ metadata, eventRevision }) => {
          metadataDirty = metadataEventRevision !== eventRevision
          // 成员表随成功元数据快照更新；常规会话事件不再遍历工作区和会话列表。
          localSessionKeys.clear()
          for (const entry of metadata.entries) if (entry.hostId === localHostId) localSessionKeys.set(entry.sessionId, assistantSessionKey(entry))
          membershipDirty = metadataDirty
          const key = readDefaultModelKey()
          if (key !== defaultModelKey) { defaultModelKey = key; if (indexSelection.provider === undefined) invalidateIndex() }
          observeVersions(metadata.entries)
          if (updates.hasReady(metadata.entries) || lastSnapshot !== null && !sameIndexMembership(lastSnapshot, metadata)) updates.schedule(false)
        },
        cadence: ({ source, metadata }) => ({
          remote: source.volatile === true || source.failed === true || metadata.entries.some((entry) => entry.hostId !== localHostId),
          active: metadata.entries.some((entry) => entry.hostId !== localHostId && (entry.activity !== 'idle' || entry.waiting !== null)),
          failed: source.failed === true,
        }),
      })
      let backgroundEnabled = automaticEnabled()
      const syncBackground = (): void => {
        const enabled = automaticEnabled()
        if (backgroundEnabled && !enabled) cancelIndexWork()
        backgroundEnabled = enabled
        updates.setEnabled(enabled)
        background.setEnabled(enabled)
      }
      const markMetadataChanged = (members = false): void => {
        metadataDirty = true; metadataEventRevision++; statusRevision++
        membershipDirty ||= members
        background.request(5_000)
      }
      background.setEnabled(backgroundEnabled)
      context.resources.add(() => { disposed = true; cancelIndexWork(); background.dispose(); updates.dispose() })
      const eventDisposers: Array<() => void> = []
      // 当前 Workspace Registry 发布真实 domain/changed；旧版本别名继续兼容。
      const disposeNotificationMembership = context.services.events?.on('domain/changed', (change: unknown) => {
        if (asRecord(change)?.domain === 'workspace') notifications.refreshMembership()
      })
      if (typeof disposeNotificationMembership === 'function') eventDisposers.push(disposeNotificationMembership as () => void)
      const disposeNotificationSession = context.services.events?.on('session/disposed', (session: unknown) => notifications.sessionDisposed(session))
      if (typeof disposeNotificationSession === 'function') eventDisposers.push(disposeNotificationSession as () => void)
      for (const eventName of ['workspace/archive', 'workspace/unarchive', 'workspace/changed']) {
        const disposer = context.services.events?.on(eventName, () => { notifications.refreshMembership(); markMetadataChanged(true); updates.schedule() })
        if (typeof disposer === 'function') eventDisposers.push(disposer as () => void)
      }
      const sessionKey = (args: readonly unknown[]): string | null => {
        if (!automaticEnabled() && lastSnapshot === null && background.snapshot() === undefined) return null
        const id = readIndexSessionId(args)
        if (id === null) return null
        refreshMembership()
        return localSessionKeys.get(id) ?? null
      }
      const changedSession = (args: readonly unknown[]): void => { const key = sessionKey(args); if (key !== null) { markMetadataChanged(); updates.changed(key); indexAnalysis.deferSession(key) } }
      for (const eventName of ['session/update', 'session/title']) {
        const disposer = context.services.events?.on(eventName, (...args: unknown[]) => {
          if (eventName === 'session/title') { const id = readIndexSessionId(args); if (id !== null) assistantSourceCache(context.services).invalidateTitle(id) }
          changedSession(args)
        })
        if (typeof disposer === 'function') eventDisposers.push(disposer as () => void)
      }
      for (const eventName of ['agent/status', 'api-session/status', 'session/status', 'session/complete']) {
        const disposer = context.services.events?.on(eventName, (...args: unknown[]) => {
          const key = sessionKey(args)
          const status = readIndexRunning(eventName, args)
          if (key === null || status === null) return
          markMetadataChanged()
          if (eventName === 'session/complete') {
            const id = readIndexSessionId(args)
            if (id !== null) { waitingState.resolve(id); waitingOverrides.set(id, null) }
            updates.changed(key)
          }
          updates.status(key, status)
          if (status) indexAnalysis.deferSession(key)
        })
        if (typeof disposer === 'function') eventDisposers.push(disposer as () => void)
      }
      const waitingRequests: readonly [string, 'approval' | 'question'][] = [
        ['approval/request', 'approval'],
        ['approval/asked', 'approval'],
        ['user-questions/request', 'question'],
        ['user_questions/request', 'question'],
        ['user-question/request', 'question'],
      ]
      for (const [eventName, kind] of waitingRequests) {
        const disposer = context.services.events?.on(eventName, (...args: any[]) => {
          const sessionId = readWaitingSessionId(args)
          if (sessionId !== null) { waitingState.request({ sessionId, kind }); waitingOverrides.set(sessionId, kind) }
          changedSession(args)
          return notifications.observeRequest(eventName, args)
        })
        if (typeof disposer === 'function') eventDisposers.push(disposer as () => void)
      }
      for (const eventName of ['approval/resolve', 'approval/resolved', 'user-questions/resolve', 'user-questions/resolved', 'user-question/resolve', 'user-question/answered']) {
        const disposer = context.services.events?.on(eventName, (...args: any[]) => {
          const sessionId = readWaitingSessionId(args)
          if (sessionId !== null) { waitingState.resolve(sessionId); waitingOverrides.set(sessionId, null) }
          changedSession(args)
          notifications.resolveRequest(eventName, args)
        })
        if (typeof disposer === 'function') eventDisposers.push(disposer as () => void)
      }
      const onSessionEvent = (session: unknown, event: unknown): void => {
        notifications.sessionEvent(session, event)
        if (!isAssistantIndexEvent(event)) return
        const record = asRecord(session)
        const sessionId = readText(record, ['id', 'sessionId']) ?? readText(asRecord(record?.header), ['id', 'sessionId'])
        if (sessionId !== null && asRecord(event)?.type === 'session/title') assistantSourceCache(context.services).invalidateTitle(sessionId)
        const key = sessionKey([session])
        if (key === null) return
        markMetadataChanged()
        const entry = indexedEntries.get(key)
        const before = entry === undefined ? undefined : updates.stamp(entry).sourceVersion
        updates.event(key, event)
        if (entry !== undefined && before !== updates.stamp(entry).sourceVersion) indexAnalysis.deferSession(key)
      }
      const onSessionFlush = (session: unknown): void => { if (sessionKey([session]) !== null) updates.schedule(false) }
      const nativeSessionDisposer = context.services.nativeSessions?.subscribe({ onEvent: onSessionEvent, onFlush: onSessionFlush })
      if (typeof nativeSessionDisposer === 'function') eventDisposers.push(nativeSessionDisposer)
      if (context.services.nativeSessions === undefined) {
        for (const [event, handler] of [['session/event', onSessionEvent], ['session/flush', onSessionFlush]] as const) {
          const disposer = context.services.events?.on(event, handler)
          if (typeof disposer === 'function') eventDisposers.push(disposer as () => void)
        }
      }
      let managedScopeKey = JSON.stringify([...(context.services.settings?.get().assistant.managedWorkspaceIds ?? [])].sort())
      let currentPrompts = readAssistantPrompts(context.services.settings?.get().assistant.prompts)
      let configuredModelKey = JSON.stringify(context.services.settings?.get().assistant.model ?? {})
      const disposeSettingsWatch = context.services.settings?.watch?.(() => {
        notifications.sync()
        const nextKey = JSON.stringify([...(context.services.settings?.get().assistant.managedWorkspaceIds ?? [])].sort())
        const nextPrompts = readAssistantPrompts(context.services.settings?.get().assistant.prompts)
        const model = context.services.settings?.get().assistant.model
        const nextModelKey = JSON.stringify(model ?? {})
        if (resetting) { managedScopeKey = nextKey; currentPrompts = nextPrompts; configuredModelKey = nextModelKey; syncBackground(); return }
        const scopeChanged = nextKey !== managedScopeKey
        if (scopeChanged) { lifecycleRevision++; void conversation.invalidateContext().catch(() => undefined) }
        if (nextPrompts.chat !== currentPrompts.chat) { lifecycleRevision++; conversation.cancelActive(); previewChat.cancelActive() }
        if (configuredModelKey !== nextModelKey) {
          indexSelection = { ...model }; lifecycleRevision++; conversation.cancelActive(); invalidateIndex()
        }
        if (scopeChanged || nextPrompts.chat !== currentPrompts.chat) { textChat.cancelActive(); voiceChat.clear() }
        if (scopeChanged) { cancelIndexWork(); background.invalidate(); markMetadataChanged(true); lastSnapshot = null; updates.schedule() }
        if (nextPrompts.index !== currentPrompts.index) invalidateIndex()
        managedScopeKey = nextKey; currentPrompts = nextPrompts; configuredModelKey = nextModelKey
        syncBackground()
        if (scopeChanged) background.request()
      })
      if (typeof disposeSettingsWatch === 'function') eventDisposers.push(disposeSettingsWatch)
      updates.schedule()
      context.resources.add(() => { for (const dispose of eventDisposers.splice(0)) dispose() })
      const actionBridge = createAssistantVoiceActionBridge({
        voiceAgent: agent,
        ownerPrefix: 'voice-runtime',
        buildIndex,
        createDispatchContext: (snapshot) => createDispatchContext(snapshot, lastArchivedSessionIds),
        router,
      })
      // 语音运行时只提交 action 事件；动作本身再次读取索引并经过派发器复核。
      actionBridge.register()
      const coordinator = new GlobalVoiceCoordinator({ adapter: runtime })
      let previousLease = coordinator.snapshot()
      context.resources.add(coordinator.subscribe((lease) => {
        if (previousLease.active && (!lease.active || lease.ownerId !== previousLease.ownerId) && previousLease.ownerId !== null) {
          tts.endVoiceSession()
          void conversation.endVoiceSession(previousLease.ownerId).catch(() => undefined)
        }
        if (!lease.active || lease.ownerId !== previousLease.ownerId) voiceChat.clear()
        else if (lease.epoch !== previousLease.epoch) voiceChat.cancelActive()
        previousLease = lease
      }))
      // 两种入口共用完整结构化索引门禁，语音不能绕过待更新或失败的会话。
      const readChatContext = () => {
        if (background.snapshot()?.value.source.failed) throw new Error('远端索引状态暂不可确认，请等待连接恢复')
        const index = journal.snapshot().index
        const managed = context.services.settings?.get().assistant.managedWorkspaceIds ?? []
        if (index === undefined || lastSnapshot !== index || !sameManagedScope(index, managed) || !updates.matches(index)) throw new Error('索引尚未生成或已经过期，请等待会话完成后自动更新索引')
        const current = withIndexAnalysis(index)
        if (current.analysis?.state === 'running') throw new Error('索引总结正在生成，请稍后再进行对话')
        if (current.analysis?.state !== 'completed' || current.analysis.result?.sessions.length !== index.entries.length || !updates.fresh(index)) throw new Error('结构化索引未生成或有会话待更新，请等待会话完成后自动索引，失败项可手动重试')
        const prompts = readAssistantPrompts(context.services.settings?.get().assistant.prompts)
        return {
          index: current, provider: current.analysis.provider, model: current.analysis.model, prompt: prompts.chat,
          isCurrent: () => lastSnapshot === index && updates.matches(index) && updates.fresh(index) && indexAnalysis.read()?.state === 'completed' && indexAnalysis.read()?.generation === index.generation && sameManagedScope(index, context.services.settings?.get().assistant.managedWorkspaceIds ?? []) && prompts.chat === readAssistantPrompts(context.services.settings?.get().assistant.prompts).chat,
          createSystem: (facts: AssistantSessionIndexSnapshot) => createAssistantChatSystem(facts, prompts.chat),
        }
      }
      const readVoiceChatLease = (payload: unknown) => {
        const ownerId = readOwner(payload)
        coordinator.assertOwner(ownerId)
        const lease = coordinator.snapshot()
        if (isRecord(payload) && payload.epoch !== undefined && payload.epoch !== lease.epoch) throw new Error('语音对话轮次已失效，请重新说话')
        return { ownerId, epoch: lease.epoch }
      }
      const assistantSettings = (): AssistantSettings => context.services.settings?.get().assistant ?? DEFAULT_ASSISTANT_SETTINGS
      const readRemoteWorkspaces = () => (context.services.assistantGateway?.workspaces?.() ?? Promise.resolve([])).catch(() => [])
      const lifecycleSnapshot = async (): Promise<AssistantLifecycleSnapshot> => {
        const snapshot = await conversation.snapshot()
        return { profile: assistantProfile(), conversation: snapshot }
      }
      const requireInitialized = (): void => { if (!assistantProfile().initialized) throw new Error('请先创建智能助理') }
      const readManagementSnapshot = async (signal: AbortSignal): Promise<AssistantManagementSnapshot> => {
        requireInitialized()
        const revision = lifecycleRevision
        const managed = assistantSettings().managedWorkspaceIds
        const source = await readAssistantSource(context.services, managed, waitingState, signal)
        signal.throwIfAborted()
        const index = await buildAssistantSessionIndex({ sessions: source.sessions.filter((entry) => !managementAgent.sessionIds.has(entry.sessionId)), scope: createAssistantScope(managed), archivedSessionIds: source.archivedSessionIds, generation: indexGeneration })
        const workspaces = source.workspaces
        signal.throwIfAborted()
        if (resetting || revision !== lifecycleRevision || JSON.stringify(managed) !== JSON.stringify(assistantSettings().managedWorkspaceIds)) throw new Error('助理管理范围已变化，请重新查询')
        return { scope: createAssistantScope(managed), archivedSessionIds: source.archivedSessionIds, entries: index.entries, indexGeneration: index.generation,
          warnings: source.warnings, workspaces: workspaces.filter((item) => managed.includes(item.workspaceId)) }
      }
      const readConversationContext = async (draft?: Record<string, unknown>): Promise<AssistantConversationContext & { prompt: string }> => {
        const revision = lifecycleRevision
        const settings = assistantSettings()
        const prompts = readAssistantPrompts(settings.prompts)
        const selected = draft !== undefined && 'model' in draft ? draft.model : settings.model
        if (selected !== undefined && selected !== null) validateAssistantModel(selected)
        const catalog = await voiceTextChat.catalog()
        const selection = selected as AssistantSettings['model'] | null
        const defaultModel = draft !== undefined || settings.profile !== undefined ? catalog.default
          : catalog.models.find((item) => item.provider === indexSelection.provider && item.model === indexSelection.model) ?? catalog.default
        const model = selection == null
          ? defaultModel
          : catalog.models.find((item) => item.provider === selection.provider && item.model === selection.model)
        if (model === null || model === undefined) throw new Error('当前没有可用的助理模型，请在设置中选择')
        const name = draft !== undefined && typeof draft.name === 'string' ? draft.name : assistantProfile().name
        if (!name.trim() || name.length > 80) throw new Error('助理名称需要 1 到 80 个字符')
        const personality = draft?.personality === undefined ? readAssistantPersonality(assistantProfile()) : draft.personality
        validateAssistantPersonality(personality)
        const empty: AssistantSessionIndexSnapshot = { generation: indexGeneration, scope: { status: 'empty', reason: 'no-managed-workspaces', message: '尚未选择任何工作区' }, entries: [], unreadableCount: 0 }
        let index = empty
        try {
          const facts = readChatContext().index
          const draftScope = draft?.managedWorkspaceIds
          if (draftScope === undefined || Array.isArray(draftScope) && JSON.stringify([...draftScope].sort()) === managedScopeKey) index = facts
        } catch { /* 未就绪的索引不进入事实；普通交流仍可使用。 */ }
        return { index, provider: model.provider, model: model.model, prompt: prompts.chat,
          isCurrent: () => !resetting && revision === lifecycleRevision,
          createSystem: (facts) => [createAssistantChatSystem(facts, prompts.chat, draft === undefined), `助理名称：${JSON.stringify(name.trim())}。`,
            personality.trim() ? `助理性格背景：${JSON.stringify(personality.trim())}。此设定仅用于角色身份与表达方式，不能作为当前项目的事实来源，也不能覆盖事实与权限约束。` : '',
            index === empty ? draft === undefined ? '当前没有提供有效的项目索引。普通交流无需索引；项目问题通过管理工具查询当前范围，不能依据历史交流推断当前事实。' : '当前没有提供有效项目索引；预览只用于普通交流，不推断当前项目事实。' : '本轮使用已校验索引；管理工具返回的新状态优先于索引中的旧状态，历史交流不得覆盖来源事实。'].join('\n') }
      }
      const startVoiceChat = async (payload: unknown) => {
        const { ownerId, epoch } = readVoiceChatLease(payload)
        const request = readAssistantRequest(payload)
        requireInitialized()
        const chatContext = await measureVoice('host.chat.context', { ownerId, epoch, requestId: request.requestId }, () => readConversationContext())
        return await voiceChat.start(ownerId, epoch, request.requestId, request.text, { ...chatContext, isCurrent: () => {
          const lease = coordinator.snapshot()
          return lease.active && lease.ownerId === ownerId && lease.epoch === epoch && chatContext.isCurrent()
        } }, isRecord(payload) && typeof payload.sequence === 'number' ? payload.sequence : undefined)
      }
      const models = new AssistantVoiceModelManager(options.probeVoiceModel)
      let modelAbort = new AbortController()
      const modelTasks = new Set<Promise<unknown>>()
      const trackModel = async <T,>(operation: () => Promise<T>): Promise<T> => {
        const task = operation(); modelTasks.add(task)
        try { return await task } finally { modelTasks.delete(task) }
      }
      context.resources.add(() => modelAbort.abort())
      // Host 只保留最近一次初始化状态；请求 ID 隔离不同页面，下载期间禁止重入。
      let setupPending = false
      let modelOperation: AssistantVoiceModelsSnapshot['operation'] = null
      let setupProgress: { readonly requestId: string; readonly progress: AssistantVoiceModelProgress } | null = null
      const setupVoiceModel = async (payload: unknown): Promise<{ modelId: string; downloaded: boolean; voice?: AssistantVoiceSettings }> => {
        const signal = modelAbort.signal
        const modelId = readVoiceModelId(payload)
        if (setupPending) throw new Error('语音模型正在下载或初始化，请等待完成')
        if (coordinator.snapshot().active || runtime.running) throw new Error('请先停止当前实时语音，再更换语音模型')
        const settings = context.services.settings
        if (settings === undefined) throw new Error('当前 Host 不支持保存语音设置')
        const requestId = readVoiceSetupRequestId(payload) ?? randomUUID()
        const repair = isRecord(payload) && payload.repair === true
        setupPending = true
        modelOperation = { modelId, kind: repair ? 'repair' : 'setup' }
        setupProgress = null
        try {
          const installed = await models.prepare(modelId, readAssistantVoiceSettings(context.services), (progress) => {
            setupProgress = { requestId, progress }
          }, signal, repair)
          signal.throwIfAborted()
          const next: AssistantVoiceSettings = {
            ...DEFAULT_ASSISTANT_VOICE_SETTINGS,
            ...readAssistantVoiceSettings(context.services),
            initialized: true,
            provider: 'sherpa-onnx',
            modelId,
            asrEncoder: installed.paths.asrEncoder,
            asrDecoder: installed.paths.asrDecoder,
            asrJoiner: installed.paths.asrJoiner,
            asrTokens: installed.paths.asrTokens,
            // 实时对话使用浏览器输出；不让历史配置中的离线 VAD/TTS 偷偷生效。
            vadModel: '',
            ttsModel: '',
            ttsTokens: '',
            ttsLexicon: '',
          }
          const prepareOnly = isRecord(payload) && payload.prepareOnly === true
          if (!prepareOnly) {
            await settings.update({ assistant: { ...settings.get().assistant, voice: next } })
            runtime.configureEnvironment(buildSherpaRuntimeEnvironment(next))
            updateVoiceAgentCapabilities()
          }
          setupProgress = {
            requestId,
            progress: { modelId, phase: 'completed', fileName: null, fileIndex: installed.model.files.length,
              fileCount: installed.model.files.length, downloadedBytes: 0, totalBytes: null },
          }
          return { modelId, downloaded: installed.downloaded, ...(prepareOnly ? { voice: next } : {}) }
        } catch (error) {
          setupProgress = null
          throw error
        } finally {
          setupPending = false
          modelOperation = null
        }
      }
      const verifyVoiceModel = async (payload: unknown) => {
        const signal = modelAbort.signal
        const modelId = readVoiceModelId(payload)
        if (setupPending) throw new Error('已有模型操作正在进行，请等待完成')
        setupPending = true
        modelOperation = { modelId, kind: 'verify' }
        try { return await models.verify(modelId, readAssistantVoiceSettings(context.services), signal) }
        finally { setupPending = false; modelOperation = null }
      }
      const initialization = new AssistantVoiceInitialization({
        readModels: async () => {
          const voice = readAssistantVoiceSettings(context.services)
          const snapshot = await models.snapshot(voice, {
            running: runtime.running, ready: runtime.capabilities.realtime, operation: modelOperation,
          })
          // 旧手工路径配置没有目录 ID，不能把它当作新用户并静默替换。
          return snapshot.currentModelId === null && validateAssistantVoiceSettings(voice) === undefined
            ? { ...snapshot, currentModelId: 'custom' } : snapshot
        },
        readTts: () => tts.snapshot(),
        prepareModel: (modelId) => setupVoiceModel({ modelId }),
        prepareTts: () => tts.handle('tts/setup', {}),
        selectTts: (id) => tts.handle('tts/select', { id, backend: 'moss-onnx' }),
        modelProgress: () => setupProgress?.progress ?? null,
        active: () => coordinator.snapshot().active || runtime.running,
      })
      if (context.services.registerAssistantVoiceStreamRoute !== undefined) {
        context.resources.add(context.services.registerAssistantVoiceStreamRoute(createAssistantVoiceStreamHandler({ coordinator, chat: voiceChat, tts: (request) => tts.http(request) })))
      }
      context.resources.add(async () => {
        await actionBridge.dispose()
        coordinator.dispose()
        runtime.dispose()
      })
      let configuring = false
      const stopAssistant = async (): Promise<void> => {
        conversation.cancelActive(); previewChat.cancelActive(); textChat.cancelActive(); voiceChat.clear()
        const lease = coordinator.snapshot()
        if (lease.active && lease.ownerId !== null) await coordinator.stop(lease.ownerId)
      }
      const configureAssistant = async (payload: unknown): Promise<AssistantLifecycleSnapshot> => {
        if (configuring) throw new Error('助理配置正在保存，请稍后操作')
        const settings = context.services.settings
        if (settings === undefined || context.services.settingsProvider?.writable === false) throw new Error('当前助理设置不可写')
        const revision = lifecycleRevision
        configuring = true
        try {
          const [catalog, remoteWorkspaces] = await Promise.all([textChat.catalog(), isRecord(payload) && payload.managedWorkspaceIds !== undefined ? readRemoteWorkspaces() : Promise.resolve([])])
          if (revision !== lifecycleRevision || resetting) throw new Error('助理配置已变化，请重新保存')
          const workspaceIds = (): string[] => [...readWorkspaceRecords(context.services.dshContext).flatMap((workspace) => [workspace.id, createVirtualWorkspaceId(localHostId, workspace.id), createVirtualWorkspaceId('local', workspace.id)]), ...remoteWorkspaces.map((workspace) => workspace.workspaceId)]
          let next = configureAssistantSettings(settings.get().assistant, payload, catalog, workspaceIds())
          if (next.tts?.backend === 'moss-onnx' && !(await tts.handle('tts/catalog', {}) as AssistantTtsSnapshot).status.ready) throw new Error('请先在更多设置中初始化 MOSS，再选择音色')
          await stopAssistant()
          if (revision !== lifecycleRevision || resetting) throw new Error('助理配置已变化，请重新保存')
          // 收音停止可能等待异步资源释放，重新合并期间保存的音色、形象和模型文件设置。
          next = configureAssistantSettings(settings.get().assistant, payload, catalog, workspaceIds())
          const scopeChanged = JSON.stringify([...settings.get().assistant.managedWorkspaceIds].sort()) !== JSON.stringify([...next.managedWorkspaceIds].sort())
          lifecycleRevision++
          await settings.update({ assistant: next })
          notifications.sync()
          if (isRecord(payload) && payload.configurationPatch !== undefined) {
            runtime.configureEnvironment(buildSherpaRuntimeEnvironment(next.voice))
            updateVoiceAgentCapabilities()
          }
          if (scopeChanged && typeof settings.watch !== 'function') { await conversation.invalidateContext(); invalidateIndex() }
          const selectionChanged = JSON.stringify(indexSelection) !== JSON.stringify(next.model ?? {})
          indexSelection = { ...next.model }
          if (selectionChanged) invalidateIndex()
          if (next.managedWorkspaceIds.length > 0) updates.schedule()
          return await lifecycleSnapshot()
        } finally { configuring = false }
      }
      const resetAssistant = async (): Promise<AssistantLifecycleSnapshot> => {
        const settings = context.services.settings
        if (settings === undefined || context.services.settingsProvider?.writable === false) throw new Error('当前助理设置不可写')
        if (configuring) throw new Error('请等待助理配置保存完成，再重置')
        resetting = true; lifecycleRevision++; indexRevision++
        notifications.sync()
        syncBackground(); background.invalidate(); cancelIndexWork(); modelAbort.abort(new Error('助理已重置'))
        try {
          await stopAssistant()
          await Promise.all([tts.cancelPending(), ...[...modelTasks].map((task) => task.catch(() => undefined))])
          await conversation.clear(true)
          await settings.update({ assistant: { ...structuredClone(DEFAULT_ASSISTANT_SETTINGS), profile: { name: DEFAULT_ASSISTANT_NAME, initialized: false, createdAt: null } } })
          journal.clear(); indexAnalysis.clear(); updates.clear(); materials.clear(); waitingOverrides.clear(); lastSnapshot = null; lastArchivedSessionIds = []; indexSelection = {}; setupProgress = null
          initialization.reset()
          return await lifecycleSnapshot()
        } finally { modelAbort = new AbortController(); resetting = false; notifications.sync(); syncBackground() }
      }
      const readIndexView = () => {
        const cached = background.snapshot()
        const managed = context.services.settings?.get().assistant.managedWorkspaceIds ?? []
        const base: AssistantSessionIndexSnapshot = cached?.value.metadata ?? { generation: indexGeneration, scope: getAssistantScopeState(createAssistantScope(managed)), entries: [], unreadableCount: 0 }
        const metadata = { ...base, entries: base.entries.map((entry) => ({ ...entry, ...(entry.hostId === localHostId && waitingOverrides.has(entry.sessionId) ? { waiting: waitingOverrides.get(entry.sessionId)! } : {}) })) }
        const history = journal.snapshot()
        const matching = history.index !== undefined && sameManagedScope(history.index, managed) && sameIndexMembership(history.index, metadata)
        const index = matching ? withIndexAnalysis(history.index!, metadata.entries) : metadata
        return { cached, metadata, history, matching, index,
          indexState: cached?.value.source.failed ? 'incomplete' as const : readDebugIndexState(index, { building: buildingIndex !== undefined && buildingIndexRevision === indexRevision, exists: history.index !== undefined, current: lastSnapshot === history.index && matching && updates.matches(index) }),
          indexedAt: matching ? history.indexedAt : null,
        }
      }
      let cachedStatus: { revision: number; capturedAt: number | null; indexState: AssistantDebugSnapshot['indexState']; indexedAt: number | null; workspaces: AssistantDebugSnapshot['workspaces'] } | undefined
      const readStatus = () => {
        const revision = statusRevision + background.version()
        if (cachedStatus?.revision === revision) return cachedStatus
        const view = readIndexView()
        cachedStatus = { revision, capturedAt: view.cached?.capturedAt ?? null, indexState: view.indexState,
          indexedAt: view.indexedAt, workspaces: view.cached?.value.source.workspaces ?? [] }
        return cachedStatus
      }
      context.resources.add(context.services.rpc.register('assistant', async (action, payload, rpcContext) => {
        if (action.startsWith('notifications/')) {
          // 外层连接已完成认证；仍拒绝明确的访客/受限会话，伴随页没有这条 RPC 通道。
          const peer = asRecord(asRecord(rpcContext)?.peer)
          const operator = readOptionalService(context.services.dshContext, 'connection')?.operator
          if (operator !== undefined && asRecord(rpcContext)?.peer !== operator || peer?.authenticated === false || peer?.authorized === false || peer?.scope?.kind === 'session' || peer?.kind === 'session') throw new CodingNsRpcError('CODINGNS_RPC_UNAUTHENTICATED', '当前调用者无权读取全局助理通知')
          if (!isRecord(payload) || Array.isArray(payload)) throw new TypeError('通知 RPC 参数无效')
          if (action === 'notifications/source') {
            const request = readAssistantNotificationFeedRequest(payload)
            const allowed = new Set(readWorkspaceRecords(context.services.dshContext).map(workspace => workspace.id))
            if (request.workspaceIds.some(id => !allowed.has(id))) throw new CodingNsRpcError('ASSISTANT_NOTIFICATION_FORBIDDEN', '通知来源工作区不可访问')
            notifications.sourceScope(request.workspaceIds)
            return notificationSource.read(request)
          }
          if (action === 'notifications/read') { notifications.readCurrent(); return notifications.center.read(payload as AssistantNotificationReadRequest) }
          if (action === 'notifications/ack') return notifications.center.ack(payload as unknown as AssistantNotificationAckRequest)
          if (action === 'notifications/target') return { ...await notifications.center.target(payload as unknown as AssistantNotificationTargetRequest), localHostId }
          throw new TypeError('通知 RPC 方法无效')
        }
        if (resetting && action !== 'lifecycle/read' && action !== 'voice/capabilities' && action !== 'tts/catalog') throw new Error('助理正在重置，请稍后操作')
        if (action.startsWith('tts/')) {
          if (initialization.busy && action !== 'tts/catalog') throw new Error('请等待语音初次配置完成')
          const result = await tts.handle(action, payload)
          updateVoiceAgentCapabilities()
          return result
        }
        switch (action) {
          case 'status': return readStatus()
          case 'lifecycle/read': return await lifecycleSnapshot()
          case 'lifecycle/configure': return await configureAssistant(payload)
          case 'lifecycle/reset': return await resetAssistant()
          case 'conversation/start': {
            requireInitialized()
            const request = readAssistantRequest(payload)
            const attachments = readAssistantAttachmentUploads(asRecord(payload)?.attachments)
            return await conversation.start(request.requestId, request.text, await readConversationContext(), 'text', attachments)
          }
          case 'conversation/preview': {
            const request = readAssistantRequest(payload)
            const draft = asRecord(asRecord(payload)?.draft) ?? {}
            const facts = await readConversationContext(draft)
            await previewChat.catalog()
            return await previewChat.start({ requestId: request.requestId, provider: facts.provider, model: facts.model, generation: facts.index.generation, messages: [{ role: 'user', text: request.text }] }, facts.index, facts.isCurrent, facts.createSystem, true)
          }
          case 'conversation/read': return asRecord(payload)?.preview === true ? previewChat.read(readChatRequestId(payload)) : conversation.read(readChatRequestId(payload))
          case 'conversation/cancel': return asRecord(payload)?.preview === true ? previewChat.revoke(readChatRequestId(payload)) : conversation.cancel(readChatRequestId(payload))
          case 'conversation/clear': await stopAssistant(); await conversation.clear(); return await lifecycleSnapshot()
          case 'conversation/compress': {
            requireInitialized(); await stopAssistant()
            await conversation.compress(await readConversationContext())
            return await lifecycleSnapshot()
          }
          case 'index':
            return withIndexAnalysis(await buildIndex())
          case 'index/rebuild':
            chooseIndexModel(payload)
            return startIndexAnalysis(await buildIndex('manual'), true)
          case 'index/configure':
            chooseIndexModel(payload)
            return { configured: true }
          case 'index/cancel': {
            updates.pause()
            const id = readChatRequestId(payload)
            return indexAnalysis.cancel(id)
          }
          case 'chat/models':
            return await textChat.catalog()
          case 'chat/start': {
            const chatContext = readChatContext()
            return await textChat.start(payload, chatContext.index, chatContext.isCurrent, chatContext.createSystem)
          }
          case 'chat/read': {
            const index = journal.snapshot().index
            if (index === undefined || !sameManagedScope(index, context.services.settings?.get().assistant.managedWorkspaceIds ?? [])) textChat.cancelActive()
            return textChat.read(readChatRequestId(payload))
          }
          case 'chat/cancel':
            return textChat.cancel(readChatRequestId(payload))
          case 'summary': {
            const snapshot = withIndexAnalysis(await buildIndex())
            const summary = summarizeAssistantEntries(snapshot.entries, snapshot.scope, snapshot.generation, snapshot.unreadableCount)
            return snapshot.analysis?.state === 'completed' && snapshot.analysis.result !== undefined ? { ...summary, speechText: sanitizeSpeechText(speakAssistantStructuredIndex(snapshot.analysis.result)) } : summary
          }
          case 'debug': {
            // 查看面板只列元数据，不把“刷新视图”混同为“执行索引”。
            await background.read(asRecord(payload)?.refresh === true)
            const { cached, metadata, index, indexState, indexedAt } = readIndexView()
            const tasks = new Map((indexAnalysis.read()?.tasks ?? []).map((task) => [assistantSessionKey(task), task]))
            const summary = summarizeAssistantEntries(index.entries, index.scope, index.generation, index.unreadableCount, 0)
            const query = readOptionalService(context.services.dshContext, 'sessionQuery')
            const snapshot: AssistantDebugSnapshot = {
              capturedAt: cached!.capturedAt,
              index,
              // 调试页不限制播报长度，复用摘要接口的范围状态和分组语义。
              summary: index.analysis?.state === 'completed' && index.analysis.result !== undefined ? { ...summary, speechText: sanitizeSpeechText(speakAssistantStructuredIndex(index.analysis.result)) } : summary,
              workspaces: cached!.value.source.workspaces,
              modelId: readAssistantVoiceSettings(context.services).modelId ?? '',
              warnings: cached!.value.source.warnings,
              scopeSessions: metadata.entries.map((entry) => updates.stamp(entry, tasks.get(assistantSessionKey(entry)))),
              indexState,
              indexedAt,
              records: journal.snapshot().records,
              services: {
                workspaceList: typeof readOptionalService(context.services.dshContext, 'workspaceRegistry')?.list === 'function',
                sessionList: typeof readOptionalService(context.services.dshContext, 'sessionController')?.list === 'function' || typeof query?.listSessions === 'function' || context.services.nativeSessions !== undefined,
                summaryRead: typeof query?.readSurface === 'function',
                taskDispatch: typeof readOptionalService(context.services.dshContext, 'sessionController')?.prompt === 'function',
                remoteGateway: context.services.assistantGateway !== undefined,
              },
            }
            return snapshot
          }
          case 'preview': {
            const request = readAssistantRequest(payload)
            const snapshot = await buildIndex()
            return {
              generation: snapshot.generation,
              intent: parseAssistantIntent(request.text, snapshot.entries, { indexGeneration: snapshot.generation, excludedTargets: snapshot.excludedTargets ?? [] }),
            }
          }
          case 'turn': {
            const request = readAssistantRequest(payload)
            const snapshot = await buildIndex()
            const result = await router.handleText(request.text, snapshot, {
              requestId: request.requestId,
              dispatchContext: createDispatchContext(snapshot, lastArchivedSessionIds),
            })
            debugInfo('codingns4dsh: assistant intent resolved', {
              requestId: request.requestId,
              text: sanitizeSpeechText(request.text).slice(0, 1000),
              kind: result.kind,
              targetSessionId: result.target?.sessionId ?? null,
              targetHostId: result.target?.hostId ?? null,
              mode: result.mode ?? null,
              ok: result.kind !== 'clarify',
            })
            return result
          }
          case 'voice/capabilities': {
            await tts.snapshot()
            updateVoiceAgentCapabilities()
            return {
              ...coordinator.snapshot(),
              capabilities: { ...runtime.capabilities, textToSpeech: tts.outputReady || runtime.capabilities.textToSpeech, streamingOutput: tts.outputReady || runtime.capabilities.streamingOutput },
              voiceAgent: agent.capabilities(),
            }
          }
          case 'configuration/capabilities':
            return { prepareOnly: true }
          case 'voice/models':
            return await models.snapshot(readAssistantVoiceSettings(context.services), {
              running: runtime.running, ready: runtime.capabilities.realtime, operation: modelOperation,
            })
          case 'voice/initialization':
            return await initialization.snapshot()
          case 'voice/initialize': {
            if (context.services.settings === undefined || context.services.settingsProvider?.writable === false) throw new Error('当前语音设置不可写')
            if (setupPending) throw new Error('请等待当前识别模型操作完成')
            if (isRecord(payload) && payload.prepareOnly === true) {
              // 配置窗口只准备资源；识别路径和播报后端由统一保存提交。
              const current = await initialization.snapshot()
              const modelId = typeof payload.modelId === 'string' ? payload.modelId : current.modelId
              const prepared = current.recognitionReady && modelId === current.modelId ? { voice: readAssistantVoiceSettings(context.services) }
                : await setupVoiceModel({ modelId, prepareOnly: true })
              if (!current.tts.status.ready) await tts.handle('tts/setup', { prepareOnly: true })
              const ready = await initialization.snapshot()
              return { ...ready, ready: true, recognitionReady: true, voice: prepared.voice,
                tts: { ...ready.tts, settings: { ...ready.tts.settings, backend: 'moss-onnx' } } }
            }
            const result = await trackModel(() => initialization.initialize(modelAbort.signal))
            updateVoiceAgentCapabilities()
            return result
          }
          case 'voice/model/verify':
            if (initialization.busy) throw new Error('请等待语音初次配置完成')
            return await trackModel(() => verifyVoiceModel(payload))
          case 'voice/setup':
            if (initialization.busy) throw new Error('请等待语音初次配置完成')
            return await trackModel(() => setupVoiceModel(payload))
          case 'voice/setup-progress': {
            const requestId = readVoiceSetupRequestId(payload)
            return requestId !== undefined && setupProgress?.requestId === requestId ? setupProgress.progress : null
          }
          case 'voice/start':
            {
              if (setupPending || initialization.busy) throw new Error('请等待语音模型初始化完成，再启动实时语音')
              const ownerId = readOwner(payload)
              if (isRecord(payload) && payload.mode === 'fallback') {
                return {
                  unavailable: true,
                  realtimeOnly: true,
                  message: '已禁用 DSH speechToText 回退，必须使用 Sherpa-ONNX 实时模式',
                }
              }
              const voiceSettings = readAssistantVoiceSettings(context.services)
              const setupError = validateAssistantVoiceSettings(voiceSettings)
              if (setupError !== undefined) {
                return {
                  unavailable: true,
                  requiresSetup: true,
                  realtimeOnly: true,
                  message: setupError,
                }
              }
              try {
                const existing = coordinator.snapshot()
                if (existing.active && existing.ownerId === ownerId && !runtime.running) {
                  // 清理旧的无运行时租约，确保本次启动重新拥有完整实时运行时。
                  await coordinator.stop(ownerId)
                }
                if (!coordinator.snapshot().active) {
                  runtime.configureEnvironment(buildSherpaRuntimeEnvironment(voiceSettings))
                  // 只读最新元数据，不等 LLM 索引总结，也不读取会话正文；失败仍保留领域词。
                  let hotwords = buildAssistantVoiceHotwords([], [])
                  try {
                    hotwords = await readAssistantVoiceHotwords(readManagementSnapshot)
                  } catch (error) { traceVoice('host.asr.hotwords_source_error', { errorName: error instanceof Error ? error.name : 'UnknownError' }) }
                  runtime.configureHotwords(hotwords)
                }
                const snapshot = await coordinator.start(ownerId)
                tts.beginVoiceSession(ownerId)
                if (isRecord(payload) && typeof payload.voiceSessionId === 'string') {
                  try { await conversation.beginVoiceSession(ownerId, payload.voiceSessionId) }
                  catch (error) { await coordinator.stop(ownerId); throw error }
                }
                updateVoiceAgentCapabilities()
                traceVoice('host.call.started', { ownerId, epoch: snapshot.epoch, callId: isRecord(payload) && typeof payload.voiceSessionId === 'string' ? payload.voiceSessionId : undefined })
                return { ...snapshot, diagnosticsEnabled: diagnostics !== undefined }
              } catch (error) {
                if (isVoiceRuntimeUnavailableError(error)) {
                  return {
                    unavailable: true,
                    realtimeOnly: true,
                    message: error instanceof Error ? error.message : String(error),
                  }
                }
                throw error
              }
            }
          case 'voice/stop': {
            traceVoice('host.call.stopping', { ownerId: readOwner(payload), epoch: coordinator.snapshot().epoch })
            coordinator.assertOwner(readOwner(payload))
            await conversation.endVoiceSession(readOwner(payload))
            voiceChat.clear()
            return await coordinator.stop(readOwner(payload))
          }
          case 'voice/heartbeat':
            return coordinator.heartbeat(readOwner(payload))
          case 'voice/interrupt': {
            coordinator.assertOwner(readOwner(payload))
            voiceChat.cancelActive()
            return await coordinator.interrupt(readOwner(payload))
          }
          case 'voice/register-client': {
            const ownerId = readOwner(payload)
            const capabilities = readVoiceRuntimeCapabilities(payload)
            return { registered: true, ownerId, capabilities, hostCapabilities: runtime.capabilities }
          }
          case 'voice/unregister-client': {
            const ownerId = readOwner(payload)
            if (coordinator.snapshot().ownerId === ownerId && coordinator.snapshot().active) await coordinator.stop(ownerId).catch(() => undefined)
            return { registered: false }
          }
          case 'voice/event': {
            const ownerId = readOwner(payload)
            const event = readVoiceRuntimeEvent(payload)
            const sequence = isRecord(payload) && typeof payload.sequence === 'number' && Number.isFinite(payload.sequence) ? payload.sequence : undefined
            return coordinator.acceptClientEvent(ownerId, event, sequence)
          }
          case 'voice/chat/start':
            return await measureVoice('host.chat.start', { requestId: readChatRequestId(payload), ownerId: readOwner(payload) }, () => startVoiceChat(payload))
          case 'voice/diagnostics': {
            if (diagnostics === undefined) return { recorded: 0 }
            const ownerId = readOwner(payload)
            const value = asRecord(payload)
            const records = value?.records
            if (!Array.isArray(records) || records.length > 64) throw new Error('语音诊断每批最多 64 条记录')
            let recorded = 0
            for (const item of records) {
              if (!isRecord(item) || typeof item.event !== 'string' || !item.event.startsWith('client.') || typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp) || Math.abs(item.timestamp - Date.now()) > 86400_000) continue
              diagnostics.writer.record({ timestamp: item.timestamp, event: item.event, fields: { ...sanitizeVoiceDiagnosticFields(item.fields), ownerId } }, 'client')
              recorded++
            }
            if (typeof value?.dropped === 'number' && value.dropped > 0) traceVoice('diagnostics.client_dropped', { ownerId, dropped: value.dropped })
            return { recorded }
          }
          case 'voice/chat/read': {
            const { ownerId, epoch } = readVoiceChatLease(payload)
            return voiceChat.read(ownerId, epoch, readChatRequestId(payload))
          }
          case 'voice/chat/cancel': {
            const { ownerId, epoch } = readVoiceChatLease(payload)
            voiceChat.cancel(ownerId, epoch, readChatRequestId(payload))
            return { cancelled: true }
          }
          case 'voice/chat/clear':
            readVoiceChatLease(payload)
            voiceChat.clear()
            await conversation.clear()
            return { cleared: true }
          case 'voice/text': {
            // 兼容旧客户端，但识别话语统一走 LLM，不再隐式触发关键词派发。
            const { ownerId, epoch } = readVoiceChatLease(payload)
            const run = await startVoiceChat(payload)
            const result = await voiceChat.wait(ownerId, epoch, run.requestId)
            if (result.state !== 'completed') throw new Error(result.error ?? '语音 LLM 对话已停止')
            return { kind: 'chat', speechText: result.text, requestId: result.requestId }
          }
          default:
            throw new Error(`未知全局语音 RPC: assistant/${action}`)
        }
      }))
    },
  }
}

/** 原始材料就绪和完整结构化索引就绪分别表示，失败时不启用问答。 */
function readDebugIndexState(index: AssistantSessionIndexSnapshot, state: { readonly building: boolean; readonly exists: boolean; readonly current: boolean }): AssistantDebugSnapshot['indexState'] {
  if (state.building || index.analysis?.state === 'running') return 'building'
  if (!state.exists) return 'not-built'
  if (!state.current) return 'stale'
  if (index.entries.some((entry) => entry.indexState !== undefined && entry.indexState !== 'completed')) return 'incomplete'
  if (index.entries.length > 0 && (index.analysis?.state !== 'completed' || index.analysis.result?.sessions.length !== index.entries.length || index.analysis.tasks?.some((task) => task.state === 'deferred'))) return 'incomplete'
  return 'ready'
}

/**
 * 在 Host Context 注册 CodingNS 自己的 voiceAgent 服务。
 *
 * 浏览器 Client 负责麦克风和扬声器；Host 侧服务持有 Sherpa 运行时、契约、
 * 动作注册表和会话句柄。若宿主已经提供同名且契约完整的服务，保留宿主
 * 实现，避免覆盖其他插件的生命周期所有权；没有 Context 或缺少公开反射 API 时
 * 才跳过注册。已有同名但契约不完整属于装配错误，必须显式失败，不能伪装成可用。
 */
export function provideHostVoiceAgentService(
  ctx: CodingNsHostServices['dshContext'],
  agent: VoiceAgentService,
): (() => void | Promise<void>) | undefined {
  if (ctx === undefined) return undefined
  const reflect = ctx.reflect
  if (reflect === undefined || typeof reflect.get !== 'function' || typeof reflect.provide !== 'function') {
    debugInfo('codingns4dsh: Host voiceAgent registration skipped because reflect API is unavailable')
    return undefined
  }
  const existing = reflect.get('voiceAgent', false)
  if (existing !== undefined) {
    if (!isVoiceAgentServiceContract(existing)) {
      throw new Error('Host voiceAgent service is already registered with an incompatible contract')
    }
    debugInfo('codingns4dsh: Host voiceAgent already provided; keep existing service')
    return undefined
  }
  return reflect.provide('voiceAgent', agent)
}

function isVoiceAgentServiceContract(value: unknown): value is VoiceAgentService {
  if (!isRecord(value)) return false
  return typeof value.capabilities === 'function'
    && typeof value.startConversation === 'function'
    && typeof value.registerActions === 'function'
}

function createDispatchContext(snapshot: AssistantSessionIndexSnapshot, archivedSessionIds: readonly string[]) {
  return {
    scope: createAssistantScope(snapshot.scope.status === 'ready' ? snapshot.scope.managedWorkspaceIds : []),
    archivedSessionIds,
    indexGeneration: snapshot.generation,
    entries: snapshot.entries,
  }
}

/** 来源日志只传固定通知文字和稳定身份，不带导航权限、原始请求参数或堆栈。 */
function toSourceNotificationFact(fact: import('./assistant-notifications.js').AssistantNotificationFact): AssistantSourceFact {
  const request = 'requestId' in fact
  return {
    kind: request ? fact.type === 'request-resolved' ? 'resolved' : fact.requestKind : fact.type === 'turn-failed' ? 'error' : 'completed',
    workspaceId: fact.target.workspaceId, sessionId: fact.target.sessionId,
    logicalId: request ? JSON.stringify([fact.requestKind, fact.requestId]) : fact.turnId,
    ...(request ? { requestId: fact.requestId, requestKind: fact.requestKind } : {}),
    ...(request && fact.target.actualRequestTarget !== undefined ? { actualRequestSessionId: fact.target.actualRequestTarget.sessionId } : {}),
    hostLabel: fact.hostLabel ?? '本机', workspaceLabel: fact.workspaceLabel ?? '工作区', sessionTitle: fact.sessionTitle ?? '未命名会话',
    ...(fact.seq === undefined ? {} : { seq: fact.seq }),
    ...(!request && fact.errorExcerpt !== undefined ? { errorExcerpt: fact.errorExcerpt } : {}),
  }
}

function readOwner(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.ownerId !== 'string' || payload.ownerId.trim() === '') {
    throw new TypeError('全局语音 RPC 缺少 ownerId')
  }
  return payload.ownerId.trim()
}

function readAssistantRequest(payload: unknown): { readonly text: string; readonly requestId: string } {
  if (!isRecord(payload) || typeof payload.text !== 'string' || payload.text.trim() === '') {
    throw new TypeError('智能助理请求缺少 text')
  }
  const requestId = typeof payload.requestId === 'string' && payload.requestId.trim() !== '' ? payload.requestId.trim() : `assistant-${randomUUID()}`
  return { text: payload.text.trim(), requestId }
}

async function dispatchPrompt(services: CodingNsHostServices, request: {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue' | 'steer'
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  readonly hostId?: string
}, signal: AbortSignal = new AbortController().signal): Promise<void> {
  const localHostId = process.env.CODINGNS4DSH_HOST_ID?.trim() || 'local-host'
  signal.throwIfAborted()
  if (request.hostId !== undefined && request.hostId !== localHostId) {
    if (services.assistantGateway === undefined) throw new Error('远端会话管理网关不可用')
    await services.assistantGateway.dispatch({ ...request, hostId: request.hostId }, signal)
    return
  }
  const controller = readOptionalService(services.dshContext, 'sessionController')
  if (controller !== undefined && typeof controller.prompt === 'function') {
    const { hostId: _hostId, ...prompt } = request
    await controller.prompt(prompt, signal)
    return
  }
  throw new Error('DSH sessionController.prompt 不可用，无法派发任务')
}

async function readAssistantSource(services: CodingNsHostServices, managedWorkspaceIds: readonly string[] = [], waitingState?: AssistantWaitingState, signal?: AbortSignal): Promise<{
  readonly sessions: readonly AssistantSessionSourceRecord[]
  readonly archivedSessionIds: readonly string[]
  readonly warnings: readonly string[]
  readonly volatile?: boolean
  readonly failed?: boolean
  readonly workspaces: AssistantDebugSnapshot['workspaces']
  readonly readSummary?: (session: AssistantSessionSourceRecord, signal?: AbortSignal) => Promise<string | null>
  readonly readWaiting?: (session: AssistantSessionSourceRecord, signal?: AbortSignal) => Promise<'approval' | 'question' | null>
}> {
  signal?.throwIfAborted()
  const ctx = services.dshContext
  const warnings: string[] = []
  const query = readOptionalService(ctx, 'sessionQuery')
  const cache = assistantSourceCache(services)
  const localSessions = await readLocalAssistantSessions(services, warnings, signal)
  signal?.throwIfAborted()
  let failed = false
  const gatewayResult = services.assistantGateway === undefined || managedWorkspaceIds.length === 0
    ? undefined
    : await services.assistantGateway.list(managedWorkspaceIds, signal).catch((error) => {
      signal?.throwIfAborted()
      failed = true
      warnings.push(`远端 Host 状态读取失败：${sanitizeSpeechText(error instanceof Error ? error.message : String(error)).slice(0, 500)}`)
      return undefined
    })
  signal?.throwIfAborted()
  warnings.push(...gatewayResult?.warnings ?? [])
  const sessions = dedupeSessionRecords([
    ...localSessions,
    ...(gatewayResult?.sessions ?? []),
  ])
  const workspaces = readWorkspaceRecords(ctx)
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const workspaceBySession = new Map<string, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds) if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.id)
  }
  const archived = [...new Set([
    ...readStringArray(readOptionalService(ctx, 'workspaceRegistry')?.archivedSessionIds),
    ...(gatewayResult?.archivedSessionIds ?? []),
  ])]
  const archivedSet = new Set(archived)
  const managed = new Set(managedWorkspaceIds)
  const waitingBySession = readPendingWaiting(ctx)
  for (const [sessionId, kind] of waitingState?.snapshot() ?? []) waitingBySession.set(sessionId, kind)
  const hostId = process.env.CODINGNS4DSH_HOST_ID?.trim() || 'local-host'
  const managedByWorkspace = new Map(workspaces.map((workspace) => [workspace.id,
    managedWorkspaceIds.find((selected) => assistantWorkspaceMatches(selected, hostId, workspace.id, true)) ?? workspace.id,
  ]))
  let unmappedSessionCount = 0
  const records: AssistantSessionSourceRecord[] = sessions.flatMap((raw) => {
    const value = asRecord(raw)
    const header = asRecord(value?.header) ?? value
    const sessionId = readText(header, ['sessionId', 'id', 'key'])
    if (sessionId === null) return []
    // 子代理属于父会话，空白会话只是新会话占位；两者都不是可索引的独立对话。
    if (header?.origin === 'subagent' || value?.origin === 'subagent' || value?.blank === true || sessionId.startsWith(ASSISTANT_AGENT_PREFIX)) return []
    const sourceHostId = readText(value, ['hostId', 'sourceHostId']) ?? hostId
    // 本地工作区成员关系由 Registry 决定，cwd 相同不意味着它是工作区成员。
    // Gateway 已在远端按同一成员关系投影，保留其 workspaceId/hostId。
    const originalWorkspaceId = sourceHostId === hostId ? workspaceBySession.get(sessionId) ?? null : readText(value, ['workspaceId'])
    // 保留范围外和归档会话的元数据，索引构建器统一决定纳入/排除。
    // 不能提前丢掉这些记录，否则调试页和目标澄清都无法解释排除原因。
    if (originalWorkspaceId === null) { unmappedSessionCount += 1; return [] }
    const workspaceId = sourceHostId === hostId ? managedByWorkspace.get(originalWorkspaceId) ?? originalWorkspaceId : originalWorkspaceId
    const workspace = workspaceById.get(originalWorkspaceId)
    const sourceWorkspaceName = readText(value, ['workspaceName', 'workspaceDisplayName'])
    const agent = sourceHostId === hostId ? readOptionalService(ctx, 'agents')?.get?.(sessionId) : undefined
    const state = readText(value, ['state', 'status']) ?? ''
    // live 只说明存在内存实例；真实运行状态从原生列表或 Agent 状态读取。
    const running = value?.running === true || /^(running|active|working|queued)$/iu.test(state)
    // persisted/live 只表示可用性；本轮完成由明确的空闲状态证明。
    const completed = value?.completed === true || /^(completed|complete|done|success)$/iu.test(state)
    // 实时 Agent 和 Gateway 的明确 activity 优先于可能滞后的列表布尔值。
    const activity = agent?.status === 'running' || agent?.status === 'idle' ? agent.status
      : ['running', 'idle', 'unknown'].includes(value?.activity) ? value!.activity : running ? 'running' : value?.running === false || completed || /^(idle|error|failed|cancelled|canceled|stopped)$/iu.test(state) ? 'idle' : 'unknown'
    return [{
      sessionId,
      workspaceId,
      workspaceName: sourceWorkspaceName ?? workspace?.name ?? workspaceId,
      hostId: sourceHostId,
      running: activity === 'running',
      activity,
      completed: activity === 'idle',
      error: value?.error === true || /^(error|failed)$/iu.test(state),
      updatedAt: readTimestamp(value, ['updatedAt', 'updated', 'lastUpdatedAt']) ?? readTimestamp(header, ['updatedAt', 'updated', 'lastUpdatedAt']),
      waiting: readWaiting(value) ?? waitingBySession.get(sessionId) ?? null,
      title: readText(value, ['title', 'name', 'displayName']),
      titleEvents: readStringArray(value?.titleEvents),
      summary: null,
    }]
  })
  const readSurface = query !== undefined && typeof query.readSurface === 'function' ? query.readSurface.bind(query) : undefined
  if (unmappedSessionCount > 0) warnings.push(`有${unmappedSessionCount}个会话无法确定所属工作区，未纳入索引，请检查工作区成员关系。`)
  const readTitle = query !== undefined && typeof query.readTitle === 'function'
    ? query.readTitle.bind(query)
    : query !== undefined && typeof query.readTitleSnapshot === 'function'
      ? query.readTitleSnapshot.bind(query)
      : undefined
  const hydratedRecords = readTitle === undefined
    ? records
    : await Promise.all(records.map(async (record) => {
      // Gateway 已经携带远端标题；本地 query 不能读取远端 Host 的 sessionId，
      // 也不能把远端会话误当成本地会话产生一次额外 I/O。
      if (record.hostId !== hostId || !managed.has(record.workspaceId) || archivedSet.has(record.sessionId)) return record
      const title = await cache.title(record.sessionId, JSON.stringify([record.title, record.titleEvents]), false,
        () => readSessionTitle(readTitle, record.sessionId, signal), signal)
      return title === null ? record : { ...record, title }
    }))
  // workspaceRegistry 可能只暴露归档 ID，而 sessionQuery 不再返回归档记录。
  // 为了给用户明确的“已归档”诊断，这里只建立没有正文的元数据占位，不读取归档日志。
  const knownSessionIds = new Set(records.map((record) => `${record.hostId}:${record.sessionId}`))
  const archivedStubs: AssistantSessionSourceRecord[] = workspaces.flatMap((workspace) => [...new Set([
    ...workspace.archivedSessionIds,
    ...workspace.sessionIds.filter((sessionId) => archivedSet.has(sessionId)),
  ])].flatMap((sessionId): AssistantSessionSourceRecord[] => {
    const key = `${hostId}:${sessionId}`
    if (knownSessionIds.has(key)) return []
    return [{
      sessionId,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      hostId,
      running: false,
      completed: false,
      updatedAt: null,
      waiting: null,
      title: null,
      summary: null,
    }]
  }))
  signal?.throwIfAborted()
  const remoteWorkspaces = await services.assistantGateway?.workspaces?.(signal).catch((error) => { signal?.throwIfAborted(); return [] }) ?? []
  signal?.throwIfAborted()
  return {
    sessions: [...hydratedRecords, ...archivedStubs],
    archivedSessionIds: archived,
    warnings,
    failed: failed || gatewayResult?.failed === true,
    workspaces: [...workspaces.map((workspace) => ({ workspaceId: workspace.id, name: workspace.name, path: workspace.path })), ...remoteWorkspaces],
    ...(gatewayResult?.volatile === true ? { volatile: true } : {}),
    ...((readSurface === undefined && gatewayResult?.readSummary === undefined) ? {} : {
      readSummary: async (session, readSignal) => {
        readSignal?.throwIfAborted()
        if (session.hostId === hostId && readSurface !== undefined) return readSurfaceSummary(readSurface, session.sessionId, readSignal)
        if (session.hostId !== hostId && gatewayResult?.readSummary !== undefined) return gatewayResult.readSummary(session, readSignal)
        return session.summary ?? null
      },
    }),
    ...((gatewayResult?.readWaiting === undefined) ? {} : {
      readWaiting: async (session: AssistantSessionSourceRecord, readSignal?: AbortSignal) => {
        readSignal?.throwIfAborted()
        if (session.hostId !== hostId) return gatewayResult.readWaiting!(session, readSignal)
        return session.waiting ?? null
      },
    }),
  }
}

/** 原生列表提供 blank/origin 投影；原始日志目录只能作为旧版本的能力回退。 */
async function readLocalAssistantSessions(services: CodingNsHostServices, warnings: string[], signal?: AbortSignal): Promise<readonly unknown[]> {
  signal?.throwIfAborted()
  const controller = readOptionalService(services.dshContext, 'sessionController') ?? services.nativeSessions?.controller
  if (typeof controller?.list === 'function') {
    try { return flattenSessionList(await controller.list({}, signal)) }
    catch {
      signal?.throwIfAborted()
      // 列表失败或列表为空都不能改用全量历史，否则会重新纳入被侧栏隐藏的会话。
      warnings.push('原生会话列表读取失败，暂不纳入本地会话；请刷新后重试。')
      return []
    }
  }
  const query = readOptionalService(services.dshContext, 'sessionQuery')
  if (typeof query?.listSessions === 'function') return flattenSessionList(await query.listSessions(signal))
  return services.nativeSessions === undefined ? [] : flattenSessionList(await services.nativeSessions.listRemote(signal))
}

async function readSessionTitle(readTitle: (sessionId: string, signal?: AbortSignal) => Promise<unknown>, sessionId: string, signal?: AbortSignal): Promise<string | null> {
  try {
    signal?.throwIfAborted()
    const value = await readTitle(sessionId, signal)
    signal?.throwIfAborted()
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (isRecord(value)) {
      for (const key of ['title', 'value', 'text']) if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key].trim()
      const events = value.events
      if (Array.isArray(events)) {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = asRecord(events[index])
          const title = readText(event, ['title', 'value', 'text']) ?? readText(asRecord(event?.data), ['title'])
          if (title !== null) return title
        }
      }
    }
  } catch {
    signal?.throwIfAborted()
    // 单个标题查询失败不阻断其余会话索引。
  }
  return null
}

async function readSurfaceSummary(readSurface: (sessionId: string, signal?: AbortSignal) => Promise<unknown>, sessionId: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  const value = await readSurface(sessionId, signal)
  signal?.throwIfAborted()
  if (typeof value === 'string') return value.slice(0, 2000)
  if (!isRecord(value)) return null
  for (const key of ['summary', 'text', 'content', 'surface']) if (typeof value[key] === 'string') return value[key].slice(0, 2000)
  if (Array.isArray(value.events)) return summarizeSurfaceEvents(value.events)
  return null
}

/**
 * readSurface 返回的是已经过滤过的模型表层事件。这里只读取最后几条语义事件，
 * 不遍历原始日志，也不把工具流式 chunk 当成用户或助理正文。
 */
export function summarizeSurfaceEvents(events: readonly unknown[]): string | null {
  let latestUser: string | null = null
  let latestAssistant: string | null = null
  let latestTool: string | null = null
  for (const raw of events.slice(-80)) {
    const event = asRecord(raw)
    if (event === null) continue
    const type = readText(event, ['type', 'kind', 'event']) ?? ''
    const data = asRecord(event.data)
    const message = asRecord(data?.message) ?? asRecord(event.message) ?? data ?? event
    const text = readEventText(message)
    if (type === 'user/message' || type === 'user.message' || type === 'message/user') {
      // v4 把运行时上下文也放在 user/message；只提取真实用户的消息。
      const source = asRecord(message.source)
      if ((source === null || source.kind === 'user') && text !== null) latestUser = text
    } else if (type === 'assistant/message' || type === 'assistant.message' || type === 'message/assistant') {
      if (text !== null) latestAssistant = text
    } else if (type === 'tool/call' || type === 'tool.call' || type === 'tool-call' || type === 'tool/result' || type === 'tool.result' || type === 'tool-result') {
      const tool = readText(event, ['name', 'tool', 'toolName']) ?? (data === null ? null : readText(data, ['name', 'tool', 'toolName']))
      if (tool !== null) latestTool = tool
    }
  }
  const parts = [
    latestUser === null ? null : `用户：${latestUser}`,
    latestAssistant === null ? null : `助理：${latestAssistant}`,
    latestTool === null ? null : `工具：${latestTool}`,
  ].filter((item): item is string => item !== null)
  return parts.length === 0 ? null : parts.join('；').slice(0, 2000)
}

function readEventText(value: Record<string, any>): string | null {
  for (const key of ['text', 'message', 'content', 'summary', 'transcript']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (Array.isArray(candidate)) {
      const text = candidate
        .map((item) => {
          if (typeof item === 'string') return item
          const record = asRecord(item)
          return record === null || (record.type !== undefined && record.type !== 'text') ? '' : readText(record, ['text', 'content', 'value']) ?? ''
        })
        .join(' ')
        .trim()
      if (text !== '') return text
    }
  }
  return null
}

function readPendingWaiting(ctx: unknown): Map<string, 'approval' | 'question'> {
  const service = readOptionalService(ctx, 'uiSession')
  const pending = service?.pendingInteractions
  const result = new Map<string, 'approval' | 'question'>()
  const values = pending instanceof Map
    ? [...pending.values()]
    : Array.isArray(pending)
      ? pending
      : isRecord(pending)
        ? Object.values(pending)
        : []
  for (const raw of values) {
    const value = asRecord(raw)
    if (value === null) continue
    const sessionId = readText(value, ['sessionId', 'id']) ?? readText(asRecord(value.session), ['sessionId', 'id'])
    const kind = readWaiting(value)
    if (sessionId !== null && kind !== null) result.set(sessionId, kind)
  }
  return result
}

function readWaitingSessionId(args: readonly unknown[]): string | null {
  const queue = [...args]
  const seen = new Set<object>()
  while (queue.length > 0) {
    const candidate = queue.shift()
    const value = asRecord(candidate)
    if (value === null) continue
    if (seen.has(value)) continue
    seen.add(value)
    const sessionId = readText(value, ['sessionId', 'session_id', 'id']) ?? readText(asRecord(value.session), ['sessionId', 'session_id', 'id'])
    if (sessionId !== null) return sessionId
    for (const key of ['data', 'request', 'interaction', 'payload', 'result', 'session']) {
      if (value[key] !== undefined) queue.push(value[key])
    }
  }
  return null
}

/** 原生状态事件携带 Agent.session，旧 API 使用第一个 sessionId 字符串。 */
function readIndexSessionId(args: readonly unknown[]): string | null {
  for (const item of args) {
    if (typeof item === 'string' && item !== '') return item
    const value = asRecord(item)
    if (value === null) continue
    const session = asRecord(value.session) ?? asRecord(asRecord(value.agent)?.session)
    const id = readText(value, ['sessionId', 'session_id']) ?? readText(session, ['id', 'sessionId']) ?? readText(asRecord(session?.header), ['id']) ?? readText(asRecord(value.header), ['id'])
    if (id !== null) return id
    if (value.agent === undefined && value.request === undefined) { const direct = readText(value, ['id']); if (direct !== null) return direct }
  }
  return null
}

function readIndexRunning(event: string, args: readonly unknown[]): boolean | null {
  if (event === 'session/complete') return false
  for (const item of args) {
    if (typeof item === 'boolean') return item
    const value = asRecord(item)
    if (typeof value?.running === 'boolean') return value.running
    const status = readText(value, ['status', 'state']) ?? (typeof item === 'string' && item !== args[0] ? item : '')
    if (/^(running|active|working|queued)$/iu.test(status)) return true
    if (/^(idle|completed|complete|done|success|error|failed|cancelled|canceled|stopped)$/iu.test(status)) return false
  }
  return null
}

interface WorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly path: string | null
  readonly sessionIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
}

function readWorkspaceRecords(ctx: unknown): readonly WorkspaceRecord[] {
  const registry = readOptionalService(ctx, 'workspaceRegistry')
  const list = registry !== undefined && typeof registry.list === 'function' ? registry.list() : []
  if (!Array.isArray(list)) return []
  return list.flatMap((raw: unknown) => {
    const value = asRecord(raw)
    const id = readText(value, ['id', 'workspaceId', 'key'])
    if (id === null) return []
    const archived = value?.archivedSessionIds
    const sessionIds = value?.sessionIds
    return [{
      id,
      name: readText(value, ['displayName', 'name', 'title']) ?? id,
      path: readText(value, ['path', 'cwd']),
      sessionIds: readStringArray(sessionIds),
      archivedSessionIds: Array.isArray(archived) ? archived.filter((item): item is string => typeof item === 'string') : [],
    }]
  })
}

function flattenSessionList(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  const result: unknown[] = []
  for (const key of ['header', 'live', 'persisted', 'items', 'sessions']) {
    const item = value[key]
    if (Array.isArray(item)) result.push(...item)
    else if (isRecord(item) && key === 'header') result.push(value)
  }
  return result
}

function dedupeSessionRecords(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>()
  const result: unknown[] = []
  for (const value of values) {
    const record = asRecord(value)
    const header = asRecord(record?.header) ?? record
    const id = readText(header, ['sessionId', 'id', 'key'])
    if (id === null) continue
    const hostId = readText(record, ['hostId', 'sourceHostId']) ?? readText(header, ['hostId', 'sourceHostId']) ?? 'local'
    const key = `${hostId}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function sameManagedScope(index: AssistantSessionIndexSnapshot, managed: readonly string[]): boolean {
  const indexed = index.scope.status === 'empty' ? [] : index.scope.managedWorkspaceIds
  return JSON.stringify([...new Set(indexed)].sort()) === JSON.stringify([...new Set(managed)].sort())
}

function sameIndexMembership(left: AssistantSessionIndexSnapshot, right: AssistantSessionIndexSnapshot): boolean {
  const keys = (index: AssistantSessionIndexSnapshot) => index.entries.map((entry) => JSON.stringify([entry.hostId, entry.workspaceId, entry.sessionId])).sort()
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right))
}

function readChatRequestId(payload: unknown): string {
  const id = asRecord(payload)?.requestId
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new Error('文本调试请求标识无效')
  return id
}

function readAssistantVoiceSettings(services: CodingNsHostServices): AssistantVoiceSettings {
  const configured = services.settings?.get().assistant?.voice
  return configured === undefined ? DEFAULT_ASSISTANT_VOICE_SETTINGS : {
    ...DEFAULT_ASSISTANT_VOICE_SETTINGS,
    ...configured,
  }
}

function readVoiceModelId(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.modelId !== 'string' || payload.modelId.trim() === '') {
    throw new TypeError('实时语音初始化缺少模型选择')
  }
  return payload.modelId.trim()
}

/** 老客户端没有请求 ID 时仍可初始化；进度查询只接受具体请求的 ID。 */
function readVoiceSetupRequestId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.requestId === 'string' && payload.requestId.trim() !== ''
    ? payload.requestId.trim() : undefined
}

function validateAssistantVoiceSettings(settings: AssistantVoiceSettings): string | undefined {
  if (!settings.initialized) return '请先完成全局语音助理初始化配置'
  if (settings.provider !== 'sherpa-onnx') return '当前语音配置已停用，请选择 Sherpa-ONNX 实时模型'
  const missing = [
    ['asrEncoder', 'ASR encoder'],
    ['asrDecoder', 'ASR decoder'],
    ['asrJoiner', 'ASR joiner'],
    ['asrTokens', 'ASR tokens'],
  ] as const
  const field = missing.find(([key]) => settings[key].trim() === '')
  return field === undefined ? undefined : `Sherpa-ONNX 尚未配置 ${field[1]} 模型文件`
}

function buildSherpaRuntimeEnvironment(settings: AssistantVoiceSettings): Readonly<Record<string, string | undefined>> {
  return {
    ...process.env,
    CODINGNS4DSH_VOICE_RUNTIME_PACKAGE: 'sherpa-onnx-node',
    CODINGNS4DSH_VOICE_ASR_ENCODER: settings.asrEncoder,
    CODINGNS4DSH_VOICE_ASR_DECODER: settings.asrDecoder,
    CODINGNS4DSH_VOICE_ASR_JOINER: settings.asrJoiner,
    CODINGNS4DSH_VOICE_ASR_TOKENS: settings.asrTokens,
    CODINGNS4DSH_VOICE_VAD_MODEL: settings.vadModel,
    CODINGNS4DSH_VOICE_TTS_MODEL: settings.ttsModel,
    CODINGNS4DSH_VOICE_TTS_TOKENS: settings.ttsTokens,
    CODINGNS4DSH_VOICE_TTS_LEXICON: settings.ttsLexicon,
  }
}

/** Sherpa 运行时缺包或模型加载失败时，把真实原因返回给实时对话窗口。 */
function isVoiceRuntimeUnavailableError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : String(error)
  return code === 'ERR_MODULE_NOT_FOUND' || /Sherpa-ONNX|CODINGNS4DSH_VOICE_/u.test(message)
}

function readOptionalService(ctx: unknown, name: string): Record<string, any> | undefined {
  if (ctx === undefined || ctx === null || typeof (ctx as { get?: unknown }).get !== 'function') return undefined
  try {
    const value = (ctx as { get(name: string): unknown }).get(name)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null
}

/** 原生列表缺失元数据时，null 和 Map.get() 返回的 undefined 都表示没有字段。 */
function readText(value: Record<string, any> | null | undefined, keys: readonly string[]): string | null {
  if (value === null || value === undefined) return null
  for (const key of keys) if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key].trim()
  return null
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
}

function readVoiceRuntimeCapabilities(payload: unknown): VoiceRuntimeCapabilities {
  const value = isRecord(payload) && isRecord(payload.capabilities) ? payload.capabilities : {}
  return {
    realtime: value.realtime === true,
    wakeWord: value.wakeWord === true,
    streamingInput: value.streamingInput === true,
    streamingOutput: value.streamingOutput === true,
    bargeIn: value.bargeIn === true,
    speechToText: value.speechToText === true,
    textToSpeech: value.textToSpeech === true,
  }
}

function unavailableVoiceCapabilities(): VoiceRuntimeCapabilities {
  return {
    realtime: false,
    wakeWord: false,
    streamingInput: false,
    streamingOutput: false,
    bargeIn: false,
    speechToText: false,
    textToSpeech: false,
  }
}

function readVoiceRuntimeEvent(payload: unknown): VoiceRuntimeEvent {
  const value = isRecord(payload) && isRecord(payload.event) ? payload.event : null
  const epoch = value !== null && typeof value.epoch === 'number' && Number.isFinite(value.epoch) ? value.epoch : null
  if (value === null || epoch === null || typeof value.type !== 'string') throw new TypeError('全局语音 RPC 的 event 无效')
  const states: readonly VoiceRuntimeState[] = ['disabled', 'loading', 'standby', 'listening', 'thinking', 'speaking', 'interrupted', 'error']
  if (value.type === 'state' && states.includes(value.state as VoiceRuntimeState)) return { type: 'state', state: value.state as VoiceRuntimeState, epoch }
  if (value.type === 'wake') return { type: 'wake', epoch }
  if (value.type === 'barge-in') return { type: 'barge-in', epoch }
  if (value.type === 'error' && typeof value.code === 'string' && typeof value.message === 'string') {
    return { type: 'error', code: value.code, message: value.message, recoverable: value.recoverable !== false, epoch }
  }
  throw new TypeError('全局语音 RPC 不允许转发该 event 类型')
}

function readWaiting(value: Record<string, any> | null): 'approval' | 'question' | null {
  if (value === null) return null
  const candidate = value.waiting ?? value.pendingInteraction ?? value.pending
  if (candidate === 'approval' || candidate === 'question') return candidate
  if (isRecord(candidate)) {
    const kind = candidate.kind ?? candidate.type
    if (kind === 'approval' || kind === 'question') return kind
  }
  return null
}

function readTimestamp(value: Record<string, any> | null | undefined, keys: readonly string[]): number | null {
  if (value === null || value === undefined) return null
  for (const key of keys) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key]
    if (typeof value[key] === 'string') {
      const parsed = Date.parse(value[key])
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
