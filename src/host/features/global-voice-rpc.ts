import { randomUUID } from 'node:crypto'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { VoiceRuntimeCapabilities, VoiceRuntimeEvent, VoiceRuntimeState } from '../../shared/contracts/voice-runtime.js'
import type { CodingNsHostServices } from './types.js'
import type { AssistantSessionSourceRecord } from './assistant-session-index.js'
import { createAssistantScope } from './assistant-scope.js'
import { AssistantDispatcher } from './assistant-dispatch.js'
import { AssistantVoiceTurnRouter } from './assistant-voice-turn.js'
import { buildAssistantSessionIndex, type AssistantSessionIndexSnapshot } from './assistant-session-index.js'
import { sanitizeSpeechText, summarizeAssistantEntries } from './assistant-summary.js'
import { GlobalVoiceCoordinator } from './global-voice-coordinator.js'
import { VoiceAgentService } from './voice-agent-service.js'
import { createAssistantVoiceActionBridge } from './voice-agent-actions.js'
import { AssistantWaitingState } from './assistant-waiting-state.js'
import { debugInfo } from '../../shared/debug.js'
import { createAssistantVoiceStreamHandler } from './assistant-voice-stream.js'
import { SherpaVoiceRuntime } from './sherpa-voice-runtime.js'
import { DEFAULT_ASSISTANT_VOICE_SETTINGS, type AssistantVoiceSettings } from '../../shared/contracts/config.js'
import { installAssistantVoiceModel } from './voice-model-setup.js'

/**
 * 全局智能助理 Host 边界。
 *
 * 这里故意不接收 sessionId：会话索引、意图和派发各自通过快照协作，语音租约
 * 只属于 Host。这样刷新页面或切换当前对话不会改变助理的目标范围。
 */
export function createGlobalVoiceRpcFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'globalVoiceRpc',
      version: '0.2.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      const runtime = new SherpaVoiceRuntime({
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
          streamingAudio: runtime.capabilities.streamingOutput,
          readAloud: runtime.capabilities.textToSpeech,
          voices: runtime.capabilities.textToSpeech,
        })
      }
      const disposeVoiceAgent = provideHostVoiceAgentService(context.services.dshContext, agent)
      if (disposeVoiceAgent !== undefined) context.resources.add(disposeVoiceAgent)
      const dispatcher = new AssistantDispatcher((request) => dispatchPrompt(context.services, request))
      const router = new AssistantVoiceTurnRouter(dispatcher)
      const waitingState = new AssistantWaitingState()
      let lastSnapshot: AssistantSessionIndexSnapshot | null = null
      let lastArchivedSessionIds: readonly string[] = []
      let lastIndexKey = ''
      let lastIndexVolatile = false
      let buildingIndex: Promise<AssistantSessionIndexSnapshot> | undefined
      const buildIndex = async (): Promise<AssistantSessionIndexSnapshot> => {
        const managed = context.services.settings?.get().assistant?.managedWorkspaceIds ?? []
        const archived = readStringArray(readOptionalService(context.services.dshContext, 'workspaceRegistry')?.archivedSessionIds)
        const key = JSON.stringify([managed, archived])
        if (lastSnapshot !== null && key === lastIndexKey && !lastIndexVolatile) return lastSnapshot
        if (buildingIndex !== undefined) return buildingIndex
        buildingIndex = (async () => {
          const source = await readAssistantSource(context.services, managed, waitingState)
          lastArchivedSessionIds = source.archivedSessionIds
          const snapshot = await buildAssistantSessionIndex({
            sessions: source.sessions,
            scope: createAssistantScope(managed),
            archivedSessionIds: source.archivedSessionIds,
            generation: (lastSnapshot?.generation ?? 0) + 1,
            ...(source.readSummary === undefined ? {} : { readSummary: source.readSummary }),
            ...(source.readWaiting === undefined ? {} : { readWaiting: source.readWaiting }),
          })
          lastSnapshot = snapshot
          lastIndexKey = JSON.stringify([managed, source.archivedSessionIds])
          lastIndexVolatile = source.volatile === true
          return snapshot
        })().finally(() => { buildingIndex = undefined })
        return buildingIndex
      }
      const invalidateIndex = (): void => { lastSnapshot = null; lastIndexKey = ''; lastIndexVolatile = false }
      const eventDisposers: Array<() => void> = []
      for (const eventName of ['session/flush', 'session/update', 'session/title', 'session/status', 'workspace/archive', 'workspace/unarchive', 'workspace/changed']) {
        const disposer = context.services.events?.on(eventName, invalidateIndex)
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
          if (sessionId !== null) waitingState.request({ sessionId, kind })
          invalidateIndex()
        })
        if (typeof disposer === 'function') eventDisposers.push(disposer as () => void)
      }
      for (const eventName of ['approval/resolve', 'approval/resolved', 'user-questions/resolve', 'user-questions/resolved', 'user-question/resolve', 'user-question/answered', 'session/complete']) {
        const disposer = context.services.events?.on(eventName, (...args: any[]) => {
          const sessionId = readWaitingSessionId(args)
          if (sessionId !== null) waitingState.resolve(sessionId)
          invalidateIndex()
        })
        if (typeof disposer === 'function') eventDisposers.push(disposer as () => void)
      }
      const nativeSessionDisposer = context.services.nativeSessions?.subscribe({
        onEvent: invalidateIndex,
        onFlush: invalidateIndex,
      })
      if (typeof nativeSessionDisposer === 'function') eventDisposers.push(nativeSessionDisposer)
      const disposeSettingsWatch = context.services.settings?.watch?.(() => invalidateIndex())
      if (typeof disposeSettingsWatch === 'function') eventDisposers.push(disposeSettingsWatch)
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
      if (context.services.registerAssistantVoiceStreamRoute !== undefined) {
        context.resources.add(context.services.registerAssistantVoiceStreamRoute(createAssistantVoiceStreamHandler({ coordinator })))
      }
      context.resources.add(async () => {
        await actionBridge.dispose()
        coordinator.dispose()
      })
      context.resources.add(context.services.rpc.register('assistant', async (action, payload) => {
        switch (action) {
          case 'index':
            return await buildIndex()
          case 'summary': {
            const snapshot = await buildIndex()
            return summarizeAssistantEntries(snapshot.entries, snapshot.scope, snapshot.generation, snapshot.unreadableCount)
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
          case 'voice/capabilities':
            return {
              ...coordinator.snapshot(),
              voiceAgent: agent.capabilities(),
            }
          case 'voice/setup': {
            const modelId = readVoiceModelId(payload)
            if (coordinator.snapshot().active || runtime.running) {
              throw new Error('请先停止当前实时语音，再更换语音模型')
            }
            const installed = await installAssistantVoiceModel(modelId)
            const current = readAssistantVoiceSettings(context.services)
            const next: AssistantVoiceSettings = {
              ...DEFAULT_ASSISTANT_VOICE_SETTINGS,
              ...current,
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
            if (context.services.settings === undefined) throw new Error('当前 Host 不支持保存语音设置')
            await context.services.settings.update({
              assistant: {
                ...context.services.settings.get().assistant,
                voice: next,
              },
            })
            runtime.configureEnvironment(buildSherpaRuntimeEnvironment(next))
            updateVoiceAgentCapabilities()
            return { modelId, downloaded: installed.downloaded }
          }
          case 'voice/start':
            {
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
                }
                const snapshot = await coordinator.start(ownerId)
                updateVoiceAgentCapabilities()
                return snapshot
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
          case 'voice/stop':
            return await coordinator.stop(readOwner(payload))
          case 'voice/heartbeat':
            return coordinator.heartbeat(readOwner(payload))
          case 'voice/interrupt':
            return await coordinator.interrupt(readOwner(payload))
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
          case 'voice/text': {
            const ownerId = readOwner(payload)
            coordinator.assertOwner(ownerId)
            const request = readAssistantRequest(payload)
            const result = await actionBridge.handleFinalText(request.text, request.requestId)
            debugInfo('codingns4dsh: assistant voice text resolved', {
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
          default:
            throw new Error(`未知全局语音 RPC: assistant/${action}`)
        }
      }))
    },
  }
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
}): Promise<void> {
  const localHostId = process.env.CODINGNS4DSH_HOST_ID?.trim() || 'local-host'
  if (request.hostId !== undefined && request.hostId !== localHostId && services.assistantGateway !== undefined) {
    await services.assistantGateway.dispatch({ ...request, hostId: request.hostId })
    return
  }
  const controller = readOptionalService(services.dshContext, 'sessionController')
  if (controller !== undefined && typeof controller.prompt === 'function') {
    await controller.prompt(request)
    return
  }
  throw new Error('DSH sessionController.prompt 不可用，无法派发任务')
}

async function readAssistantSource(services: CodingNsHostServices, managedWorkspaceIds: readonly string[] = [], waitingState?: AssistantWaitingState): Promise<{
  readonly sessions: readonly AssistantSessionSourceRecord[]
  readonly archivedSessionIds: readonly string[]
  readonly volatile?: boolean
  readonly readSummary?: (session: AssistantSessionSourceRecord) => Promise<string | null>
  readonly readWaiting?: (session: AssistantSessionSourceRecord) => Promise<'approval' | 'question' | null>
}> {
  const ctx = services.dshContext
  const query = readOptionalService(ctx, 'sessionQuery')
  const primaryValue = query !== undefined && typeof query.listSessions === 'function'
    ? await query.listSessions()
    : []
  const primaryRecords = flattenSessionList(primaryValue)
  const bridgeSessions = managedWorkspaceIds.length > 0 && services.nativeSessions !== undefined
    ? await services.nativeSessions.listRemote()
    : []
  const gatewayResult = services.assistantGateway === undefined || managedWorkspaceIds.length === 0
    ? undefined
    : await services.assistantGateway.list(managedWorkspaceIds).catch(() => undefined)
  const sessions = dedupeSessionRecords([
    ...primaryRecords,
    ...(primaryRecords.length === 0 ? flattenSessionList(bridgeSessions) : []),
    ...(gatewayResult?.sessions ?? []),
  ])
  const workspaces = readWorkspaceRecords(ctx)
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const archived = [...new Set([
    ...readStringArray(readOptionalService(ctx, 'workspaceRegistry')?.archivedSessionIds),
    ...(gatewayResult?.archivedSessionIds ?? []),
  ])]
  const archivedSet = new Set(archived)
  const managed = new Set(managedWorkspaceIds)
  const waitingBySession = readPendingWaiting(ctx)
  for (const [sessionId, kind] of waitingState?.snapshot() ?? []) waitingBySession.set(sessionId, kind)
  const hostId = process.env.CODINGNS4DSH_HOST_ID?.trim() || 'local-host'
  const records: AssistantSessionSourceRecord[] = sessions.flatMap((raw) => {
    const value = asRecord(raw)
    const header = asRecord(value?.header) ?? value
    const sessionId = readText(header, ['sessionId', 'id', 'key'])
    if (sessionId === null) return []
    // PeerHost Gateway 返回的摘要记录已经携带 workspaceId/hostId；本地
    // sessionQuery 记录才需要通过 workspaceRegistry 的成员关系或 cwd 反查。
    const workspaceId = readText(value, ['workspaceId']) ?? findWorkspaceId(sessionId, header, workspaces)
    if (workspaceId === null || !managed.has(workspaceId) || archivedSet.has(sessionId)) return []
    const workspace = workspaceById.get(workspaceId)
    const sourceWorkspaceName = readText(value, ['workspaceName', 'workspaceDisplayName'])
    const sourceHostId = readText(value, ['hostId', 'sourceHostId']) ?? hostId
    const state = readText(value, ['state', 'status']) ?? ''
    const live = value?.live === true
    const running = live || value?.running === true || /running|active|working/iu.test(state)
    // listSessions 的 persisted/live 只是可用性包装，不足以证明会话已完成；
    // 没有显式状态时保留 completed=false，由索引 status=unknown 表示未知。
    const completed = value?.completed === true || /completed|complete|done/iu.test(state)
    return [{
      sessionId,
      workspaceId,
      workspaceName: sourceWorkspaceName ?? workspace?.name ?? workspaceId,
      hostId: sourceHostId,
      running: running && !completed,
      completed,
      error: value?.error === true || /error|failed/iu.test(state),
      updatedAt: readTimestamp(header, ['updatedAt', 'updated', 'lastUpdatedAt']),
      waiting: readWaiting(value) ?? waitingBySession.get(sessionId) ?? null,
      title: readText(value, ['title', 'name', 'displayName']),
      titleEvents: readStringArray(value?.titleEvents),
      summary: null,
    }]
  })
  const readSurface = query !== undefined && typeof query.readSurface === 'function' ? query.readSurface.bind(query) : undefined
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
      if (record.hostId !== hostId) return record
      const title = await readSessionTitle(readTitle, record.sessionId)
      return title === null ? record : { ...record, title }
    }))
  // workspaceRegistry 可能只暴露归档 ID，而 sessionQuery 不再返回归档记录。
  // 为了给用户明确的“已归档”诊断，这里只建立没有正文的元数据占位，不读取归档日志。
  const knownSessionIds = new Set(records.map((record) => `${record.hostId}:${record.sessionId}`))
  const archivedStubs: AssistantSessionSourceRecord[] = workspaces.flatMap((workspace) => workspace.archivedSessionIds.flatMap((sessionId): AssistantSessionSourceRecord[] => {
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
  })).concat(sessions.flatMap((raw) => {
    const value = asRecord(raw)
    const header = asRecord(value?.header) ?? value
    const sessionId = readText(header, ['sessionId', 'id', 'key'])
    const workspaceId = readText(value, ['workspaceId'])
    const sourceHostId = readText(value, ['hostId', 'sourceHostId']) ?? hostId
    if (sessionId === null || workspaceId === null || sourceHostId === hostId || !managed.has(workspaceId) || !archivedSet.has(sessionId)) return []
    const workspace = workspaceById.get(workspaceId)
    return [{
      sessionId,
      workspaceId,
      workspaceName: readText(value, ['workspaceName', 'workspaceDisplayName']) ?? workspace?.name ?? workspaceId,
      hostId: sourceHostId,
      running: false,
      completed: false,
      updatedAt: null,
      waiting: null,
      title: readText(value, ['title', 'name', 'displayName']),
      summary: null,
    }]
  }))
  return {
    sessions: [...hydratedRecords, ...archivedStubs],
    archivedSessionIds: archived,
    ...(gatewayResult?.volatile === true ? { volatile: true } : {}),
    ...((readSurface === undefined && gatewayResult?.readSummary === undefined) ? {} : {
      readSummary: async (session) => {
        if (session.hostId === hostId && readSurface !== undefined) return readSurfaceSummary(readSurface, session.sessionId)
        if (session.hostId !== hostId && gatewayResult?.readSummary !== undefined) return gatewayResult.readSummary(session)
        return session.summary ?? null
      },
    }),
    ...((gatewayResult?.readWaiting === undefined) ? {} : {
      readWaiting: async (session: AssistantSessionSourceRecord) => {
        if (session.hostId !== hostId) return gatewayResult.readWaiting!(session)
        return session.waiting ?? null
      },
    }),
  }
}

async function readSessionTitle(readTitle: (sessionId: string) => Promise<unknown>, sessionId: string): Promise<string | null> {
  try {
    const value = await readTitle(sessionId)
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
    // 单个标题查询失败不阻断其余会话索引。
  }
  return null
}

async function readSurfaceSummary(readSurface: (sessionId: string) => Promise<unknown>, sessionId: string): Promise<string | null> {
  const value = await readSurface(sessionId)
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
    const text = readEventText(event) ?? (data === null ? null : readEventText(data))
    if (type === 'user/message' || type === 'user.message' || type === 'message/user') {
      if (text !== null) latestUser = text
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
          return record === null ? '' : readText(record, ['text', 'content', 'value']) ?? ''
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

function findWorkspaceId(sessionId: string, header: Record<string, any> | null, workspaces: readonly WorkspaceRecord[]): string | null {
  for (const workspace of workspaces) if (workspace.sessionIds.includes(sessionId)) return workspace.id
  const cwd = readText(header, ['cwd'])
  if (cwd === null) return null
  const candidate = workspaces.find((workspace) => workspace.path !== null && (cwd === workspace.path || cwd.startsWith(`${workspace.path}/`)))
  return candidate?.id ?? null
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

function readText(value: Record<string, any> | null, keys: readonly string[]): string | null {
  if (value === null) return null
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
  const states: readonly VoiceRuntimeState[] = ['disabled', 'loading', 'standby', 'listening', 'speaking', 'interrupted', 'error']
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

function readTimestamp(value: Record<string, any> | null, keys: readonly string[]): number | null {
  if (value === null) return null
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
