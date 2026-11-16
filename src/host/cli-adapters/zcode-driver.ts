import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decryptZcodeCredential } from './zcode-credentials.js'
import type {
  CodingNsAgentEvent,
  CodingNsAgentPermissionResponse,
  CodingNsAgentQuestionResponse,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, JsonRpcRequestError, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog } from './rpc-driver-utils.js'
import { ZCODE_CATALOG } from './model-catalog.js'
import { desktopCliRuntimeCommand, resolveZCodeDesktopRuntime, type CodingNsDesktopAppRuntime } from './desktop-app-runtime.js'
import { promptWithAttachmentPaths, withAttachmentPaths } from './attachment-utils.js'
import { readZcodeInteraction, zcodePermissionMode, type ZcodeInteraction } from './zcode-interactions.js'
import { ZcodeTurnTelemetry } from './zcode-telemetry.js'
import { ZcodeBackgroundTurns } from './zcode-background-turns.js'
import type { CodingNsBackgroundTurn } from './background-turn.js'
import { recoverZcodeBackgroundReplies, type ZcodeRecoveredReply } from './zcode-background-recovery.js'

const record = (value: unknown): Record<string, any> => isRecord(value) ? value : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

export interface ZcodeCliDriverOptions {
  readonly homeDirectory?: string
  readonly desktopRuntime?: CodingNsDesktopAppRuntime | null
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

interface ZcodeSession {
  readonly background: ZcodeBackgroundTurns
  readonly backgroundPermissions: Map<string, CodingNsCliTurnInput['permission']>
  foregroundNotification: ((message: JsonRpcMessage) => void) | undefined
  readonly rpc: JsonRpcProcess
  readonly cwd: string | undefined
  workflowEnabled: boolean
  /** '' 表示尚未创建 ZCode 会话；创建后为 CLI 原生 sess_* 标识。 */
  acpSessionId: string
  providerSessionId: string
  /** turn.terminal 事件里的真实失败码与信息，随错误透传给用户。 */
  failureCode: string | undefined
  failureMessage: string | undefined
  /** 回合是否已经进入 running；idle 终态只有在 running 后才算成功收尾。 */
  sawRunning: boolean
  /** 是否已经订阅 ZCode 的连续会话事件流。 */
  subscribed: boolean
  /** 当前回合是否已经收到正文，用于避免用 turn.completed 快照重复输出。 */
  sawText: boolean
  /**
   * 当前正在流式输出的 assistant 消息标识。
   *
   * ZCode 每一轮里“思考 → 工具 → 再思考”会开出多条 assistant 消息，但正文增量
   * 只带 assistantMessageId，不带消息边界。没有边界时整轮会渲染成一条不断变长的
   * 助手消息，进行中的工作过程看起来就是一块空白。这里记录当前消息身份，切换时
   * 由 zcodeMessageToChunk 补发 message-boundary。
   */
  streamingMessageId: string | undefined
  /** 当前消息是否已经送出过可见正文；只有先有内容才值得补发边界。 */
  streamingMessageStarted: boolean
  /** 当前回合的 DSH 权限，用于审批应答时阻止只读模式被提升。 */
  permission: CodingNsCliTurnInput['permission']
  acceptingInteractions: boolean
  readonly interactions: Map<string, { interaction: ZcodeInteraction; promise: Promise<unknown>; resolve: (value: unknown) => void; settled: boolean }>
  readonly emittedInteractions: Set<string>
  lastUsage: unknown
  supportsContextSnapshot: boolean
}

interface ZcodeTurnEventQueue {
  next(): Promise<IteratorResult<JsonRpcMessage>>
  push(message: JsonRpcMessage): void
  close(): void
}

/**
 * ZCode 驱动：通过 `zcode app-server` 的 ZCode Protocol（{id, method, params}
 * 裸信封）驱动桌面端自带的 zcode.cjs 或 PATH 上的独立 CLI，结构与 Codex 驱动
 * 一致——按 DSH 会话维护持久 app 进程，跨回合复用。
 *
 * 会话流程：session/create|resume → session/send。服务端会在创建期间反向请求
 * session/requestRuntimePreferences，这里用固定默认值应答；模型跟随 CLI 自己
 * 的选择（独立 CLI 的提供商注册表需先在终端 `zcode login` 后才可用）。回合
 * 终态以 state.updated（status=idle / prompt_failed）、computer-use
 * turn-failed 与 v4/telemetry turn.terminal（携带真实 errorCode/errorMessage）
 * 为准。
 */
export class ZcodeAppServerDriver implements CodingNsCliDriver {
  private readonly recoveredReplies = new Map<string, ZcodeRecoveredReply>()
  async recoverBackgroundTurns(sessionId: string, providerSessionId: string, since: number): Promise<readonly ZcodeRecoveredReply[]> {
    return recoverZcodeBackgroundReplies(join(this.homeDirectory, '.zcode', 'cli', 'db', 'db.sqlite'), providerSessionId, since)
  }
  stageRecoveredBackgroundTurn(sessionId: string, reply: ZcodeRecoveredReply): void {
    this.recoveredReplies.set(JSON.stringify([sessionId, reply.turnId]), reply)
  }
  private readonly backgroundListeners = new Set<(turn: CodingNsBackgroundTurn) => void>()
  subscribeBackgroundTurns(listener: (turn: CodingNsBackgroundTurn) => void): () => void {
    this.backgroundListeners.add(listener)
    return () => { this.backgroundListeners.delete(listener) }
  }
  readonly descriptor = {
    id: 'zcode',
    name: 'ZCode',
    protocol: 'json-rpc',
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions'],
  } as const
  /**
   * ZCode 常驻会话跨 DSH step 继续消费同一条事件流：step 边界只挂起迭代器，
   * 下一次 DSH step 从同一个 app-server 进程接着读，不需要重新发送提示词。
   */
  readonly supportsStreamStepSplitting = true
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private cachedRuntime: CodingNsDesktopAppRuntime | null | undefined
  private cachedBinary: string | null = null
  private readonly sessions = new Map<string, ZcodeSession>()
  private readonly processes = new Set<JsonRpcProcess>()
  private cachedCatalog: CodingNsCliModelCatalog | null = null
  private cachedCatalogFingerprint: string | undefined
  private readonly homeDirectory: string
  private readonly hasExplicitDesktopRuntime: boolean
  /** 模型目录声明的默认思考档位；切换 DeepSeek 时服务端要求显式传入。 */
  private readonly defaultEfforts = new Map<string, string>()

  constructor(options: ZcodeCliDriverOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.hasExplicitDesktopRuntime = options.desktopRuntime !== undefined
    this.cachedRuntime = options.desktopRuntime
    this.binaries = options.binaries ?? ['zcode', 'zcode.cmd']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const binary = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (binary.installed) {
      this.cachedBinary = binary.command
      return binary
    }
    const previous = this.cachedRuntime
    const runtime = resolveZCodeDesktopRuntime()
    if (previous && (previous.entry !== runtime?.entry || previous.appVersion !== runtime.appVersion)) this.dispose()
    this.cachedRuntime = runtime
    this.cachedBinary = null
    if (runtime !== null) return { installed: true, version: runtime.appVersion, command: runtime.entry }
    return binary
  }

  /** 登录态或原生套餐配置变化时，同时作废 Host 和驱动的目录缓存。 */
  catalogFingerprint(): string {
    const runtime = this.resolveRuntime()
    const hash = createHash('sha256')
    for (const file of [runtime?.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
      runtime?.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? join(this.homeDirectory, '.zcode', 'v2', 'provider_config.json'),
      join(this.homeDirectory, '.zcode', 'v2', 'setting.json'), join(this.homeDirectory, '.zcode', 'v2', 'credentials.json')]) {
      hash.update(file ?? '')
      try { if (file) hash.update(readFileSync(file)) } catch { hash.update('missing') }
    }
    return hash.digest('hex')
  }

  private invalidateChangedCatalog(): void {
    const fingerprint = this.catalogFingerprint()
    if (fingerprint !== this.cachedCatalogFingerprint) {
      this.cachedCatalog = null
      this.defaultEfforts.clear()
      this.cachedCatalogFingerprint = fingerprint
    }
  }

  private rememberCatalog(value: unknown): void {
    const catalog = catalogFromZcodeSnapshot(value)
    this.rememberDefaultEfforts(value)
    if (catalog.groups.length > 0) this.cachedCatalog = mergeZcodeCatalogs(this.cachedCatalog, catalog)
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    if (!(await this.detect()).installed) return emptyCatalog()
    this.invalidateChangedCatalog()
    if (this.cachedCatalog !== null) return this.cachedCatalog
    let rpc: JsonRpcProcess | null = null
    let result: CodingNsCliModelCatalog | null = null
    try {
      rpc = this.startAppServer()
      this.installServerRequestHandler(rpc)
      const snapshot = await this.syncAccountProviderConfig(rpc)
      const candidates = zcodeAccountCatalogCandidates(snapshot)
      // 原生只公开 current account-plan。逐连接读取原生目录，合并后关闭
      // deferred 探测会话；不改用户套餐设置，也不启动模型回合。
      for (const providerId of [undefined, ...candidates]) {
        if (providerId !== undefined) await this.syncAccountProviderConfig(rpc, undefined, providerId)
        const created = await rpc.request('session/create', { workspace: zcodeWorkspace(process.cwd()), persistence: 'deferred' })
        const catalog = catalogFromZcodeSnapshot(created)
        this.rememberDefaultEfforts(created)
        result = mergeZcodeCatalogs(result, catalog)
        const id = readSessionId(created)
        if (id) await rpc.request('session/close', { sessionId: id }).catch(() => undefined)
      }
      if (result !== null && result.groups.length > 0) this.cachedCatalog = result
      return this.cachedCatalog ?? ZCODE_CATALOG
    } catch {
      return result !== null && result.groups.length > 0 ? result : this.cachedCatalog ?? ZCODE_CATALOG
    } finally { rpc?.dispose() }
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    const providerSessionId = input.providerSessionId?.trim()
    if (providerSessionId === undefined || providerSessionId === '') {
      return { state: 'unknown', reason: '缺少 Provider 会话标识' }
    }
    let rpc: JsonRpcProcess | null = null
    try {
      rpc = this.startAppServer()
      const timer = setTimeout(() => rpc?.dispose(), 12_000)
      timer.unref?.()
      const result = await rpc.request('session/list', {}) as { sessions?: ReadonlyArray<{ sessionId?: unknown }> } | undefined
      clearTimeout(timer)
      const sessions = result?.sessions ?? []
      const found = sessions.some((session) => session.sessionId === providerSessionId)
      return found
        ? { state: 'available', reason: 'Provider 会话仍存在' }
        : { state: 'missing', reason: 'Provider 会话已被删除' }
    } catch (error) {
      return { state: 'unknown', reason: `会话探测失败: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      rpc?.dispose()
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    yield* withAttachmentPaths(input, (prepared) => this.executePreparedTurn(prepared))
  }

  private async *executePreparedTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    if (input.signal?.aborted) { yield { type: 'finish', reason: 'cancel' }; return }
    if (input.externalTurnId !== undefined) {
      yield* this.consumeBackgroundTurn(input, input.externalTurnId)
      return
    }
    if (!(await this.detect()).installed) throw new Error('ZCode 未安装')
    this.invalidateChangedCatalog()
    const session = await this.getSession(input)
    // A user may submit while the native automatic turn is already running.
    // Drain that output (including its approvals) before sending the user's input.
    for (const id of session.background.pendingIds) {
      for await (const e of this.consumeBackgroundTurn(input, id)) if (e.type !== 'finish') yield e
      yield { type: 'message-boundary', channel: 'text', messageId: `after-${id}` }
    }
    if (input.signal?.aborted) { yield { type: 'finish', reason: 'cancel' }; return }
    const requestedProvider = input.modelId?.startsWith('account:') ? input.modelId.split('/')[0] : undefined
    // 每轮激活目标连接，防止原生把 Start Plan 模型映射回默认付费套餐。
    await this.syncAccountProviderConfig(session.rpc, input.signal, requestedProvider)
    session.permission = input.permission
    session.emittedInteractions.clear()
    // 每轮都清掉上一轮的终态痕迹；常驻 session 可能连续发送多轮。
    session.sawRunning = false
    session.sawText = false
    session.streamingMessageId = undefined
    session.streamingMessageStarted = false
    session.failureCode = undefined
    session.failureMessage = undefined
    if (session.acpSessionId === '') {
      // App-server defaults this gate to false, unlike the desktop workflow UI.
      // Set its process-local policy before create/resume so the model actually
      // receives CreateWorkflow and the native /workflow command.
      session.workflowEnabled = await enableZcodeWorkflows(session.rpc, input.cwd, input.signal)
      const workflow = session.workflowEnabled ? { dynamicWorkflowEnabled: true, dynamicWorkflowMode: 'alwaysOn' } : {}
      let created: unknown
      if (input.providerSessionId !== undefined) {
        // A failed resume must never silently replace a user's existing conversation.
        created = await session.rpc.request('session/resume', { sessionId: input.providerSessionId, workspace: zcodeWorkspace(input.cwd), ...workflow }, { signal: input.signal, killOnAbort: false })
        if (readSessionId(created) !== input.providerSessionId) throw new Error('ZCode 返回了不同的原生会话 ID，已停止续接')
      }
      if (created === undefined) {
        created = await session.rpc.request('session/create', {
          workspace: zcodeWorkspace(input.cwd),
          persistence: 'deferred',
          ...workflow,
        }, { signal: input.signal, killOnAbort: false })
      }
      session.acpSessionId = readSessionId(created) ?? input.sessionId
      this.rememberCatalog(created)
      session.supportsContextSnapshot = isRecord(created) && isRecord(created.projection)
    }
    yield { type: 'session-binding', providerSessionId: session.acpSessionId }

    // 每轮覆盖原生模式，尤其是 resume 后或同一会话从全权限切回只读时。
    await session.rpc.request('session/setMode', {
      sessionId: session.acpSessionId,
      mode: zcodePermissionMode(input),
    }, { signal: input.signal, killOnAbort: false })
    await this.applyModelSelection(session, input)
    await this.subscribeSessionEvents(session, input.signal)

    const telemetry = new ZcodeTurnTelemetry(session.acpSessionId)
    const baseline = input.providerSessionId !== undefined || session.lastUsage !== undefined
      ? await readZcodeSessionData(session.rpc, 'session/usage', session.acpSessionId) ?? session.lastUsage : undefined

    const eventQueue = createZcodeTurnEventQueue()
    let rpcExited = false
    const removeExitListener = session.rpc.addExitListener(() => {
      rpcExited = true
      eventQueue.close()
    })
    let sendError: unknown = null
    // resume/subscribe 已完成；send 响应前的交互也必须立即消费，避免双向等待。
    const onNotification = (message: JsonRpcMessage): void => {
      if (!session.acceptingInteractions) return
      // turn.terminal 详情略晚于 turn-failed 事件到达，宽限期结束前必须已经
      // 记下真实 errorCode/errorMessage。
      captureZcodeFailureDetail(message, session)
      const interaction = readZcodeInteraction(message)
      if (interaction !== null) pendingZcodeInteraction(session, interaction)
      eventQueue.push(message)
    }
    session.foregroundNotification = onNotification
    session.background.beginForeground()
    session.acceptingInteractions = true
    const turnContent = promptWithAttachmentPaths(
      zcodePrompt(input.prompt, session.workflowEnabled),
      input.attachments ?? [],
      input.translationLanguage,
    )
    // exactOptionalPropertyTypes：未提供 signal 时不能传 undefined，只能不写这个键。
    const sendOptions: { signal?: AbortSignal; killOnAbort: boolean } = {
      killOnAbort: false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }
    const sendPromise = session.rpc.request('session/send', {
      sessionId: session.acpSessionId,
      content: turnContent,
    }, sendOptions)
      .then(() => undefined, (error: unknown) => {
        sendError = error
        eventQueue.push({ method: 'codingns/send-failed' })
      })
    const onAbort = (): void => {
      session.acceptingInteractions = false
      session.background.cancel()
      cancelZcodeInteractions(session)
      eventQueue.close()
      void session.rpc.request('session/stop', { sessionId: session.acpSessionId }).catch(() => undefined)
    }
    if (input.signal?.aborted) onAbort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      let terminalReason: 'stop' | 'cancel' | 'error' | null = null
      while (true) {
        const next = await eventQueue.next()
        if (next.done) break
        if (input.signal?.aborted) break
        if (sendError !== null && !input.signal?.aborted) throw sendError
        const tool = telemetry.observe(next.value)
        if (tool !== null) yield tool
        const context = telemetry.takeContextObservation()
        if (context !== null) yield context
        const chunk = zcodeMessageToChunk(next.value, session, input)
        if (chunk !== null) yield* asZcodeChunks(chunk)
        terminalReason = readZcodeTerminalReason(next.value, session, input) ?? terminalReason
        // ZCode 一个回合由多个 step 组成（每个 step 是一次模型请求加它发起的工具）。
        // step-finish(reason=tool-calls) 表示本 step 还会续跑；在这里收口成 DSH
        // step，思考与工具结果才各自成为可折叠的一块，而不是全挤进同一条消息。
        const steps = readZcodeStepFinish(next.value, input)
        if (terminalReason === null && steps === 'step') {
          yield { type: 'step-boundary' }
          continue
        }
        if (terminalReason !== null) {
          if (terminalReason === 'error') {
            // turn.terminal 详情（errorCode/errorMessage）略晚于 turn-failed
            // 到达，稍等再透出真实原因。
            await new Promise((resolve) => setTimeout(resolve, 1_500))
            yield failureChunk(session)
          }
          eventQueue.close()
          break
        }
      }
      if (rpcExited && !input.signal?.aborted) throw new Error('Agent 进程已退出')
      await sendPromise
      if (sendError !== null && !input.signal?.aborted) throw sendError
      if (terminalReason === 'stop' || terminalReason === null) {
        if (input.signal?.aborted) {
          terminalReason = 'cancel'
        } else {
          // usage 查询属于正常终态的一部分，不能因为 idle 事件先到就跳过。
          const rawUsage = await readZcodeSessionData(session.rpc, 'session/usage', session.acpSessionId)
          session.lastUsage = rawUsage
          if (telemetry.needsContextSnapshot && session.supportsContextSnapshot) {
            telemetry.readContextSnapshot(await readZcodeSessionData(session.rpc, 'session/read', session.acpSessionId))
          }
          const usage = telemetry.finish(rawUsage, baseline)
          if (usage !== null) yield usage
          terminalReason = 'stop'
        }
      }
      if (terminalReason === 'error') {
        const usage = telemetry.finish(null, baseline)
        if (usage !== null) yield usage
        // 失败详情已经在通知监听器中捕获；这里统一发唯一终态。
        yield { type: 'finish', reason: 'error', failure: zcodeFailure(session) }
      } else if (terminalReason !== null) {
        yield { type: 'finish', reason: input.signal?.aborted ? 'cancel' : terminalReason }
      } else {
        // 理论上只剩取消信号，但保留稳定终态，避免上层收到无 finish 的流。
        yield { type: 'finish', reason: 'cancel' }
      }
    } catch (error) {
      if (!input.signal?.aborted) throw error
      yield { type: 'finish', reason: 'cancel' }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      session.acceptingInteractions = false
      session.foregroundNotification = undefined
      session.background.endForeground()
      removeExitListener()
      eventQueue.close()
      cancelZcodeInteractions(session, session.emittedInteractions)
    }
  }

  private async *consumeBackgroundTurn(input: CodingNsCliTurnInput, id: string): AsyncIterable<CodingNsAgentEvent> {
    const session = this.sessions.get(input.sessionId)
    const turn = session?.background.claim(id)
    const recovered = this.recoveredReplies.get(JSON.stringify([input.sessionId, id]))
    if (!turn && recovered) {
      // Recovery never starts/resumes a Provider or re-executes historical tools.
      try {
        yield { type: 'text-snapshot', text: recovered.text }
        yield { type: 'finish', reason: 'stop' }
      } finally { this.recoveredReplies.delete(JSON.stringify([input.sessionId, id])) }
      return
    }
    // A durable DSH carrier may be replayed after another stream consumed it.
    if (!session || !turn) { yield { type: 'finish', reason: 'stop' }; return }
    // Automatic completion belongs to the task that launched it. A permission
    // choice saved for the next human turn must not change that task midway.
    const permission = session.backgroundPermissions.get(id)
    const { permission: _nextHumanPermission, ...withoutPermission } = input
    const effectiveInput = { ...withoutPermission, ...(permission ? { permission } : {}) }
    session.permission = permission
    const state: ZcodeSession = { ...session, sawRunning: false, sawText: false,
      streamingMessageId: undefined, streamingMessageStarted: false,
      failureCode: undefined, failureMessage: undefined, emittedInteractions: new Set() }
    const telemetry = new ZcodeTurnTelemetry(session.acpSessionId)
    let reason: 'stop' | 'cancel' | 'error' = 'stop'
    const abort = () => {
      turn.cancelled = true
      session.background.cancel()
      cancelZcodeInteractions(session)
      void session.rpc.request('session/stop', { sessionId: session.acpSessionId }).catch(() => undefined)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
    try {
      // Restore the task's permission snapshot, but never send, resume or change
      // the model of an already-running native turn.
      await session.rpc.request('session/setMode', { sessionId: session.acpSessionId, mode: zcodePermissionMode(effectiveInput) }, { signal: input.signal, killOnAbort: false })
      for await (const m of turn.queue) {
        if (input.signal?.aborted || turn.cancelled) { reason = 'cancel'; break }
        if (m.method === 'codingns/background-error') throw new Error(text(record(m.params).message))
        captureZcodeFailureDetail(m, state)
        const tool = telemetry.observe(m)
        if (tool) yield tool
        const context = telemetry.takeContextObservation()
        if (context) yield context
        const chunk = zcodeMessageToChunk(m, state, input)
        if (chunk) yield* asZcodeChunks(chunk)
        const end = readZcodeTerminalReason(m, state, input)
        if (end && (m.method === 'session/event' || m.method === 'state.updated' || !session.subscribed)) { reason = end; break }
      }
      if (turn.cancelled || input.signal?.aborted) reason = 'cancel'
      if (session.rpc.isClosed && reason !== 'cancel') throw new Error('ZCode 后台回合连接已关闭，结果可从原生历史恢复')
      if (reason === 'stop' && telemetry.needsContextSnapshot && session.supportsContextSnapshot) {
        telemetry.readContextSnapshot(await readZcodeSessionData(session.rpc, 'session/read', session.acpSessionId))
      }
      const usage = telemetry.finish(null, undefined)
      if (usage) yield usage
      if (reason === 'error') yield failureChunk(state)
      yield { type: 'finish', reason, ...(reason === 'error' ? { failure: zcodeFailure(state) } : {}) }
    } finally {
      input.signal?.removeEventListener('abort', abort)
      cancelZcodeInteractions(session, state.emittedInteractions)
      session.background.release(id)
      session.backgroundPermissions.delete(id)
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.acceptingInteractions = false
    session.background.cancel()
    cancelZcodeInteractions(session)
    await session.rpc.request('session/stop', { sessionId: session.acpSessionId }).catch(() => undefined)
  }

  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const session = this.sessions.get(sessionId)
    const pending = session?.interactions.get(response.requestId)
    if (session === undefined || pending?.interaction.event.type !== 'permission-request' || pending.settled) throw new Error('ZCode 权限请求不存在')
    // 只读会话不能通过 ExitPlanMode 审批悄悄提升到可写模式。
    const effective = session.permission?.sandboxMode === 'read-only'
      ? { ...response, approved: false, reason: 'DSH 当前会话为只读模式' } : response
    pending.settled = true
    const result = pending.interaction.permissionResponse(effective)
    pending.resolve(result)
  }

  respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): void {
    const session = this.sessions.get(sessionId)
    const pending = session?.interactions.get(response.requestId)
    if (session === undefined || pending?.interaction.event.type !== 'question-request' || pending.settled) throw new Error('ZCode 问题请求不存在')
    pending.settled = true
    const result = pending.interaction.questionResponse(response)
    pending.resolve(result)
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.background.cancel()
      cancelZcodeInteractions(session)
      session.rpc.dispose()
    }
    this.sessions.clear()
    for (const rpc of this.processes) rpc.dispose()
    this.processes.clear()
    this.cachedRuntime = undefined
    this.cachedBinary = null
    this.cachedCatalog = null
    this.cachedCatalogFingerprint = undefined
    this.defaultEfforts.clear()
    this.backgroundListeners.clear()
    this.recoveredReplies.clear()
  }

  private resolveRuntime(): CodingNsDesktopAppRuntime | null {
    if (this.cachedRuntime === undefined) this.cachedRuntime = resolveZCodeDesktopRuntime()
    return this.cachedRuntime
  }

  private startAppServer(runtimeEnv?: Readonly<Record<string, string>>): JsonRpcProcess {
    if (this.cachedBinary !== null) {
      // PATH launchers can wrap the same Desktop CLI. They still need its provider
      // catalog/environment; otherwise only custom providers appear in DSH.
      return new JsonRpcProcess({ command: this.cachedBinary, args: ['app-server'], env: { ...this.resolveRuntime()?.env, ...(runtimeEnv ?? {}) }, wireFormat: 'zcode', spawn: this.runSpawn })
    }
    const runtime = this.resolveRuntime()
    if (runtime !== null) {
      const node = desktopCliRuntimeCommand()
      return new JsonRpcProcess({
        command: quoteWindowsArg(node.command),
        // JsonRpcProcess 在 Windows 上经 shell 启动；node 与入口安装路径（如
        // D:\Program Files\…）都可能含空格，command 和入口参数都必须先加引号。
        args: [quoteWindowsArg(runtime.entry), 'app-server'],
        env: { ...node.env, ...runtime.env, ...(runtimeEnv ?? {}) },
        wireFormat: 'zcode',
        spawn: this.runSpawn,
      })
    }
    const binary = this.cachedBinary ?? 'zcode'
    return new JsonRpcProcess({ command: binary, args: ['app-server'], env: { ...(runtimeEnv ?? {}) }, wireFormat: 'zcode', spawn: this.runSpawn })
  }

  /** 复用同 cwd 的常驻 app 进程；cwd 变化或进程死亡时重建并重新挂载会话。 */
  private async getSession(input: CodingNsCliTurnInput): Promise<ZcodeSession> {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd && !previous.rpc.isClosed) return previous
    if (previous !== undefined) cancelZcodeInteractions(previous)
    previous?.rpc.dispose()
    const rpc = this.startAppServer(input.runtimeEnv)
    const session: ZcodeSession = {
      background: new ZcodeBackgroundTurns(turnId => {
        session.backgroundPermissions.set(turnId, session.permission ? { ...session.permission } : undefined)
        for (const listener of this.backgroundListeners) {
          try { listener({ sessionId: input.sessionId, providerSessionId: session.acpSessionId, turnId }) } catch { /* A missing consumer cannot discard queued output. */ }
        }
      }),
      backgroundPermissions: new Map(),
      foregroundNotification: undefined,
      rpc,
      cwd: input.cwd,
      workflowEnabled: false,
      acpSessionId: '',
      providerSessionId: input.providerSessionId ?? input.sessionId,
      sawRunning: false,
      subscribed: false,
      sawText: false,
      streamingMessageId: undefined,
      streamingMessageStarted: false,
      failureCode: undefined,
      failureMessage: undefined,
      permission: input.permission,
      acceptingInteractions: false,
      interactions: new Map(),
      emittedInteractions: new Set(),
      lastUsage: undefined,
      supportsContextSnapshot: false,
    }
    this.processes.add(rpc)
    this.sessions.set(input.sessionId, session)
    // Exactly one transport listener survives foreground iterator cleanup.
    rpc.addNotificationListener(message => {
      const p = record(message.params)
      if (typeof p.sessionId === 'string' && session.acpSessionId && p.sessionId !== session.acpSessionId) return
      if (session.background.observe(message, session.acpSessionId)) {
        const interaction = readZcodeInteraction(message)
        if (interaction !== null && session.background.hasActive) pendingZcodeInteraction(session, interaction)
      } else session.foregroundNotification?.(message)
    })
    rpc.addExitListener(() => {
      session.background.cancel()
      cancelZcodeInteractions(session)
      this.processes.delete(rpc)
      if (this.sessions.get(input.sessionId)?.rpc === rpc) this.sessions.delete(input.sessionId)
    })
    // ZCode Protocol 没有 initialize 握手（服务端会回 Method not found），
    // 服务端反向请求（运行时偏好 / Provider 运行时认证头）必须在首个请求前就绪。
    rpc.setServerRequestHandler((request) => {
      const interaction = readZcodeInteraction(request)
      // 创建、恢复和回合结束后的历史交互不能挂起；没有活动消费者时安全拒绝。
      return interaction === null || !(session.acceptingInteractions || session.background.hasActive)
        ? handleZcodeServerRequest(request, this.homeDirectory) : pendingZcodeInteraction(session, interaction).promise
    })
    return session
  }

  private installServerRequestHandler(rpc: JsonRpcProcess): void {
    rpc.setServerRequestHandler((request) => handleZcodeServerRequest(request, this.homeDirectory))
  }

  private async syncAccountProviderConfig(rpc: JsonRpcProcess, signal?: AbortSignal, providerId?: string): Promise<Record<string, unknown> | null> {
    if (this.cachedBinary !== null && !this.hasExplicitDesktopRuntime) return null
    const runtime = this.resolveRuntime()
    const snapshot = runtime === null ? null : readZcodeAccountProviderSnapshot(runtime, this.homeDirectory, providerId)
    if (snapshot === null) {
      // 独立 CLI 没有桌面端快照时，沿用其原生登录及模型目录；setModel 的
      // 返回值仍会核对实际来源，不能因缺少桌面应用而拒绝已有 CLI 账号。
      if (providerId !== undefined && runtime !== null) throw new Error(`ZCode 账号连接不可用: ${providerId}`)
      return null
    }
    try {
      await rpc.request('provider/updateAccountConfig', snapshot, { signal, killOnAbort: false })
    } catch (error) {
      if (!isMethodUnavailable(error)) throw error
      if (providerId !== undefined) throw new Error(`ZCode 当前版本无法切换套餐连接: ${providerId}`)
    }
    return snapshot
  }

  private async applyModelSelection(session: ZcodeSession, input: CodingNsCliTurnInput): Promise<void> {
    if ((input.modelId === undefined || input.modelId.trim() === '' || input.modelId === 'provider-default') &&
      (input.effortId === undefined || input.effortId.trim() === '')) return
    if (input.modelId?.startsWith('account:') && !this.cachedCatalog?.groups.some(group => group.models.some(model => model.id === input.modelId))) {
      await this.listModels()
    }
    const selection = resolveZcodeModelSelection(input.modelId, input.effortId, this.cachedCatalog, this.defaultEfforts)
    if (selection === null) throw new Error(`ZCode 模型选择无效: ${input.modelId ?? 'provider-default'}`)
    const applied = await session.rpc.request('session/setModel', {
      sessionId: session.acpSessionId,
      model: selection,
      persistAsWorkspaceLastUsed: false,
    }, { signal: input.signal, killOnAbort: false })
    const actual = catalogFromZcodeSnapshot(applied).currentModel
    if (String(selection.providerId).startsWith('account:') && actual !== null && actual !== `${selection.providerId}/${selection.modelId}`) {
      throw new Error(`ZCode 返回的套餐模型与所选不一致，已停止发送: ${actual}`)
    }
  }

  private rememberDefaultEfforts(value: unknown): void {
    const root = isRecord(value) && isRecord(value.snapshot) ? value.snapshot : value
    const available = isRecord(root) ? root.settings?.model?.available : undefined
    if (!Array.isArray(available)) return
    for (const model of available) {
      const ref = model?.ref
      const effort = model?.reasoning?.defaultLevel
      if (typeof ref?.providerId === 'string' && typeof ref?.modelId === 'string' && typeof effort === 'string') {
        this.defaultEfforts.set(`${ref.providerId}/${ref.modelId}`, effort)
      }
    }
  }

  /** ZCode Protocol 默认只发送状态与遥测通知；订阅后才会推送正文事件。 */
  private async subscribeSessionEvents(session: ZcodeSession, signal?: AbortSignal): Promise<void> {
    if (session.subscribed) return
    try {
      await session.rpc.request('session/subscribe', {
        sessionId: session.acpSessionId,
        deliveryKind: 'desktop-continuous',
        includeSnapshot: false,
      }, { signal, killOnAbort: false })
      session.subscribed = true
    } catch (error) {
      // 旧版 ZCode 没有订阅接口时仍保留状态通知和旧消息通知兼容路径。
      if (!isMethodUnavailable(error)) throw error
    }
  }
}

/** turn.terminal 失败详情（errorCode/errorMessage）在通知到达时即捕获。 */
function captureZcodeFailureDetail(message: JsonRpcMessage, session: ZcodeSession): void {
  if (message.method === 'session/event' && record(message.params).type === 'turn.failed') {
    const error = record(record(message.params).payload)
    session.failureCode = text(error.errorCode) || text(record(error.error).code) || 'turn_failed'
    session.failureMessage = text(error.errorMessage) || text(record(error.error).message) || text(error.message) || undefined
    return
  }
  if (message.method !== 'v4/telemetry/event') return
  const params = isRecord(message.params) ? message.params : {}
  if (params.kind !== 'turn.terminal' || params.status !== 'failed') return
  if (typeof params.errorCode === 'string' && params.errorCode.trim() !== '') session.failureCode = params.errorCode
  if (typeof params.errorMessage === 'string' && params.errorMessage.trim() !== '') session.failureMessage = params.errorMessage
}

/** 回合通知拆出的统一事件；一条通知可以同时产出消息边界与增量。 */
type ZcodeChunk = CodingNsAgentEvent | AsyncIterable<CodingNsAgentEvent>

/** 统一消费单个事件与「边界 + 增量」序列，避免调用方为两种形状分支。 */
function asZcodeChunks(chunk: ZcodeChunk): AsyncIterable<CodingNsAgentEvent> {
  if (typeof (chunk as AsyncIterable<CodingNsAgentEvent>)[Symbol.asyncIterator] === 'function') {
    return chunk as AsyncIterable<CodingNsAgentEvent>
  }
  const single = chunk as CodingNsAgentEvent
  return (async function* () { yield single })()
}

/** ZCode 回合通知 → 单个统一事件；终态由 readZcodeTerminalReason 单独表达。 */
function zcodeMessageToChunk(message: JsonRpcMessage, session: ZcodeSession, input: CodingNsCliTurnInput): ZcodeChunk | null {
  const interaction = readZcodeInteraction(message)
  if (interaction !== null) {
    const id = interaction.event.requestId
    if (session.emittedInteractions.has(id)) return null
    session.emittedInteractions.add(id)
    return interaction.event
  }
  const method = typeof message.method === 'string' ? message.method : ''
  if (method === '' || method.startsWith('startup/') || method.startsWith('process/')) return null
  const params = isRecord(message.params) ? message.params : {}

  if (method === 'v4/telemetry/event') {
    if (params.kind === 'turn.terminal' && params.status === 'failed') {
      session.failureCode = typeof params.errorCode === 'string' ? params.errorCode : undefined
      session.failureMessage = typeof params.errorMessage === 'string' ? params.errorMessage : undefined
    }
    return null
  }
  if (method === 'computer-use/operation-event') {
    const kind = typeof params.kind === 'string' ? params.kind : ''
    if (kind === 'turn-failed' || kind.includes('fail')) {
      session.failureCode = session.failureCode ?? 'turn_failed'
    }
    return null
  }
  if (method === 'session/event') {
    const payload = isRecord(params.payload) ? params.payload : {}
    const kind = typeof payload.kind === 'string' ? payload.kind : ''
    const messageId = typeof payload.assistantMessageId === 'string' ? payload.assistantMessageId : undefined
    // ZCode 在同一轮里为每段“思考 / 正文”开一条新的 assistant 消息，但正文增量
    // 只带 assistantMessageId。这里补发消息边界，让 DSH 把后续正文渲染成新的
    // 文本块，而不是把整轮（含工具前后的两段回答）粘成一条消息。
    // 边界必须与本条增量一起产出：只发边界会把切换后的第一段正文一起丢掉。
    const boundary = takeZcodeMessageBoundary(session, messageId)
    if (kind === 'reasoning_delta') {
      const text = firstText(payload.delta, payload.text)
      if (text === null) return boundary
      session.streamingMessageStarted = true
      const delta: CodingNsAgentEvent = { type: 'reasoning-delta', text, ...(messageId === undefined ? {} : { messageId }) }
      return boundary === null ? delta : (async function* () { yield boundary; yield delta })()
    }
    if (kind === 'text_delta') {
      const text = firstText(payload.delta, payload.text)
      if (text === null) return boundary
      session.sawText = true
      session.streamingMessageStarted = true
      const delta: CodingNsAgentEvent = { type: 'text-delta', text, ...(messageId === undefined ? {} : { messageId }) }
      return boundary === null ? delta : (async function* () { yield boundary; yield delta })()
    }
    // 某些版本只保留 turn.completed 快照，不发送 text_delta；只有当前回合
    // 尚未输出正文时才使用该快照，避免把增量正文再追加一遍。
    if (typeof params.type === 'string' && params.type === 'turn.completed' && !session.sawText) {
      const text = firstText(payload.response, payload.content)
      return text === null ? null : { type: 'text-snapshot', text }
    }
    return null
  }
  if (method === 'state.updated') {
    const reason = typeof params.reason === 'string' ? params.reason : ''
    const patch = isRecord(params.patch) ? params.patch : {}
    if (reason === 'prompt_started' || patch.status === 'running') session.sawRunning = true
    if (reason.includes('failed')) {
      session.failureCode = session.failureCode ?? 'prompt_failed'
    }
    return null
  }

  // 其余消息类通知做保守的正文提取：params 里的 delta/text/content 字符串。
  const text = firstText(params.delta, params.text, params.content)
  if (text !== null) {
    session.sawText = true
    return { type: 'text-delta', text }
  }
  return null
}

/**
 * 判定一条通知是否结束了一个「还会续跑」的 ZCode step。
 *
 * 只有同时满足才收口：ZCode 自己的 `step-finish` 且 reason 为工具调用。回合最后
 * 一个 step 的 reason 是 stop/其他终态，由 readZcodeTerminalReason 结算，绝不能
 * 再发 step 边界，否则会凭空多开一个 step。
 */
function readZcodeStepFinish(message: JsonRpcMessage, input: CodingNsCliTurnInput): 'step' | null {
  if (input.splitToolSteps !== true) return null
  if (message.method !== 'session/event') return null
  const params = isRecord(message.params) ? message.params : {}
  if (params.type !== 'part.upserted') return null
  const part = isRecord(record(params.payload).part) ? record(params.payload).part as Record<string, unknown> : null
  if (part === null || part.type !== 'step-finish') return null
  return part.reason === 'tool-calls' ? 'step' : null
}

/** 读取并推进当前 assistant 消息身份；切换消息时给出一次消息边界。 */
function takeZcodeMessageBoundary(session: ZcodeSession, messageId: string | undefined): CodingNsAgentEvent | null {
  if (messageId === undefined || messageId === session.streamingMessageId) return null
  const boundary: CodingNsAgentEvent | null = session.streamingMessageStarted
    ? { type: 'message-boundary', channel: 'text', messageId }
    : null
  session.streamingMessageId = messageId
  session.streamingMessageStarted = false
  return boundary
}

/** 从通知流推定回合是否已终态；返回 null 表示回合仍在进行。 */
function readZcodeTerminalReason(
  message: JsonRpcMessage,
  session: ZcodeSession,
  input: CodingNsCliTurnInput,
): 'stop' | 'cancel' | 'error' | null {
  if (input.signal?.aborted) return 'cancel'
  const method = typeof message.method === 'string' ? message.method : ''
  const params = isRecord(message.params) ? message.params : {}
  if (method === 'state.updated') {
    const reason = typeof params.reason === 'string' ? params.reason : ''
    const patch = isRecord(params.patch) ? params.patch : {}
    if (reason.includes('failed')) return 'error'
    // 成功终态：回合进入过 running 后回到 idle。
    if (session.sawRunning && patch.status === 'idle') return 'stop'
  }
  if (method === 'computer-use/operation-event') {
    const kind = typeof params.kind === 'string' ? params.kind : ''
    if (kind === 'turn-failed' || kind.includes('fail')) return 'error'
    // desktop-continuous 的 turn.completed 事件可能稍晚于 computer-use
    // 通知到达；没有正文增量时要等会话快照，避免丢掉最终回答。
    if (kind.includes('complete') && (session.sawText || !session.subscribed)) return 'stop'
  }
  if (method === 'session/event' && params.type === 'turn.completed') {
    return 'stop'
  }
  if (method === 'session/event' && params.type === 'turn.failed') return 'error'
  if (method === 'v4/telemetry/event') {
    if (params.kind === 'turn.terminal') {
      if (params.status === 'failed') return 'error'
      if (session.sawText || !session.subscribed) return 'stop'
    }
  }
  return null
}

function failureChunk(session: ZcodeSession): CodingNsAgentEvent {
  const code = session.failureCode
  const detail = session.failureMessage
  const hint = code === 'provider_not_found'
    ? '（ZCode 独立运行时还没有可用的模型提供商：请在终端执行一次 zcode login 完成登录后重试）'
    : code === '1113'
      ? '（ZCode 当前账号没有可用资源包，请检查套餐余额或切换有额度的账号）'
    : ''
  return {
    type: 'text-snapshot',
    text: `ZCode 回合失败${code ? ` [${code}]` : ''}${detail ? `：${detail}` : ''}${hint}`,
  }
}

function zcodeFailure(session: ZcodeSession): { message: string; code?: string } {
  const message = session.failureMessage?.trim() || 'ZCode Provider 未返回具体失败信息。'
  const code = session.failureCode?.trim()
  return code ? { message, code } : { message }
}

async function readZcodeSessionData(rpc: JsonRpcProcess, method: 'session/usage' | 'session/read', sessionId: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  timer.unref?.()
  try {
    return await rpc.request(method, { sessionId, ...(method === 'session/read' ? { messageLimit: 1 } : {}) },
      { signal: controller.signal, killOnAbort: false })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 原生参数在交互 RPC 发出前就会校验，必须在模型调用工具前说明约束。 */
async function enableZcodeWorkflows(rpc: JsonRpcProcess, cwd: string | undefined, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await rpc.request('workspace/updateDynamicWorkflowPolicy', { workspace: zcodeWorkspace(cwd), enabled: true, mode: 'alwaysOn' }, { signal, killOnAbort: false })
    return record(response).enabled === true
  } catch (error) {
    // Older CLI versions have no workflow policy API. Keep ordinary turns usable.
    if (error instanceof JsonRpcRequestError && error.code === -32601) return false
    throw error
  }
}

function zcodePrompt(prompt: string, workflowEnabled = false): string {
  const workflow = workflowEnabled ? '\n已启用 ZCode 原生动态工作流。用户明确要求 workflow/工作流时，先读取 dynamic-workflows Skill 并调用 CreateWorkflow；TodoWrite 只能更新任务清单，不能代替创建原生工作流。原生 run 状态和阶段图可在 DSH 会话标题旁的工作流面板查看。' : ''
  return `${prompt}\n\n<codingns_host_capabilities>\nDSH 支持 ZCode 原生权限审批和 AskUserQuestion。调用 AskUserQuestion 时，questions 为 1–4 个；每题必须填写 question、header、multiSelect；options 为 2–4 个，每项必须填写 label、description，问题和选项标签不得重复。不要自行添加“其他”选项，界面已有自由文本入口。答案按选项文本校验；取消不能视为已回答。${workflow}\n</codingns_host_capabilities>`
}

function zcodeWorkspace(cwd: string | undefined): { workspacePath: string; workspaceKey: string } {
  const workspacePath = cwd?.trim() !== '' && cwd !== undefined ? cwd : process.cwd()
  return { workspacePath, workspaceKey: workspacePath }
}

function readSessionId(created: unknown): string | undefined {
  if (typeof created !== 'object' || created === null) return undefined
  const session = (created as Record<string, any>).session
  if (typeof session === 'object' && session !== null) {
    const id = (session as Record<string, any>).sessionId
    if (typeof id === 'string' && id !== '') return id
  }
  const direct = (created as Record<string, any>).sessionId
  return typeof direct === 'string' && direct !== '' ? direct : undefined
}

function firstText(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** Windows shell 拼接前的引号保护：安全字符集直接通过，其余成对引号包裹。 */
function quoteWindowsArg(value: string): string {
  if (process.platform !== 'win32') return value
  if (/^[A-Za-z0-9_./\\:-]+$/u.test(value)) return value
  return `"${value.replace(/"/gu, '""')}"`
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function catalogFromZcodeSnapshot(value: unknown): CodingNsCliModelCatalog {
  const root = isRecord(value) && isRecord(value.snapshot) ? value.snapshot : value
  const settings = isRecord(root) && isRecord(root.settings) ? root.settings : undefined
  const modelSettings = settings !== undefined && isRecord(settings.model) ? settings.model : undefined
  const available = modelSettings !== undefined && Array.isArray(modelSettings.available) ? modelSettings.available : []
  const groups = new Map<string, { name: string; models: CodingNsCliModelCatalog['groups'][number]['models'][number][] }>()
  for (const item of available) {
    if (!isRecord(item) || !isRecord(item.ref)) continue
    const providerId = typeof item.ref.providerId === 'string' ? item.ref.providerId.trim() : ''
    const modelId = typeof item.ref.modelId === 'string' ? item.ref.modelId.trim() : ''
    if (!providerId || !modelId) continue
    const efforts = isRecord(item.reasoning) && Array.isArray(item.reasoning.levels)
      ? item.reasoning.levels.flatMap((level) => isRecord(level) && typeof level.value === 'string' ? [level.value] : [])
      : []
    const group = groups.get(providerId) ?? { name: typeof item.providerLabel === 'string' ? item.providerLabel : providerId, models: [] }
    group.models.push({
      id: `${providerId}/${modelId}`,
      name: typeof item.label === 'string' && item.label.trim() !== '' ? item.label : modelId,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      efforts: [...new Set(efforts)],
    })
    groups.set(providerId, group)
  }
  const current = modelSettings !== undefined && isRecord(modelSettings.current) ? modelSettings.current : undefined
  const currentModel = current !== undefined && typeof current.providerId === 'string' && typeof current.modelId === 'string'
    ? `${current.providerId}/${current.modelId}` : null
  const currentEffort = current !== undefined && isRecord(current.options) && typeof current.options.reasoningLevel === 'string'
    ? current.options.reasoningLevel : null
  return {
    groups: [...groups.entries()].map(([id, group]) => ({ id, name: group.name, models: group.models })),
    currentModel,
    currentEffort,
  }
}

function mergeZcodeCatalogs(previous: CodingNsCliModelCatalog | null, next: CodingNsCliModelCatalog): CodingNsCliModelCatalog {
  if (previous === null) return next
  const groups = new Map(previous.groups.map(group => [group.id, group]))
  for (const group of next.groups) {
    const old = groups.get(group.id)
    const models = new Map(old?.models.map(model => [model.id, model]) ?? [])
    for (const model of group.models) models.set(model.id, model)
    groups.set(group.id, { ...group, models: [...models.values()] })
  }
  return { ...previous, groups: [...groups.values()], currentModel: previous.currentModel ?? next.currentModel, currentEffort: previous.currentEffort ?? next.currentEffort }
}

function zcodeAccountCatalogCandidates(snapshot: Record<string, unknown> | null): string[] {
  const states = isRecord(snapshot?.states) ? snapshot.states : {}
  const active = Object.keys(states).find(id => states[id]?.current === true)
  if (!active) return []
  const family = active.replace(/-(?:individual-coding-plan|team-coding-plan|start-plan)$/u, '')
  if (family === active) return []
  return Object.keys(states).filter(id => id !== active && states[id]?.entitled === true
    && [`${family}-start-plan`, `${family}-individual-coding-plan`, `${family}-team-coding-plan`].includes(id))
}

function resolveZcodeModelSelection(
  modelId: string | undefined,
  effortId: string | undefined,
  catalog: CodingNsCliModelCatalog | null,
  defaultEfforts: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  const requested = modelId?.trim() ?? ''
  const effectiveRequested = !requested || requested === 'provider-default' ? catalog?.currentModel ?? '' : requested
  if (!effectiveRequested) return null
  const entries = (catalog?.groups ?? []).flatMap((group) => group.models.map((model) => ({ group, model })))
  const found = entries.find(({ model }) => model.id === effectiveRequested)
    ?? (entries.length > 0 && !effectiveRequested.includes('/') ? entries.find(({ model }) => model.id.endsWith(`/${effectiveRequested}`)) : undefined)
  if (found === undefined) return null
  const currentEffort = catalog?.currentModel === found.model.id ? catalog.currentEffort ?? undefined : undefined
  const effort = effortId?.trim() || currentEffort || defaultEfforts.get(found.model.id)
  if (effort !== undefined && effort !== '' && !found.model.efforts.includes(effort)) {
    throw new Error(`ZCode 思维强度不可用: ${effort}`)
  }
  return {
    providerId: found.group.id,
    modelId: found.model.id.slice(found.group.id.length + 1),
    ...(effort ? { options: { reasoningLevel: effort } } : {}),
  }
}

function readZcodeAccountProviderSnapshot(runtime: CodingNsDesktopAppRuntime, homeDirectory = homedir(), selectedProviderId?: string): Record<string, unknown> | null {
  const file = runtime.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  if (typeof file !== 'string' || file.trim() === '') return null
  try {
    const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
    const rules = document.config?.providerConfigRules?.providerRules
    if (!Array.isArray(rules)) return null
    const settings = readJsonFile(join(homeDirectory, '.zcode', 'v2', 'setting.json'))
    const preferred = selectedProviderId ?? resolvePreferredAccountProvider(rules, settings,
      rule => accountProviderHasCredentials(rule, homeDirectory),
      () => accountProviderHasCredentials({ config: { access: { mode: 'start-plan' } } }, homeDirectory) === true)
    if (selectedProviderId !== undefined) {
      const selected = rules.find(rule => isRecord(rule) && rule.providerId === selectedProviderId)
      if (!selected || accountProviderHasCredentials(selected, homeDirectory) !== true) throw new Error(`ZCode 套餐连接凭据不可用: ${selectedProviderId}`)
    }
    const providers: Record<string, unknown> = {}
    const states: Record<string, unknown> = {}
    for (const rule of rules) {
      if (!isRecord(rule) || typeof rule.providerId !== 'string' || !rule.providerId.startsWith('account:')) continue
      const config = isRecord(rule.config) ? rule.config : {}
      // ZCode 的试用额度属于 start-plan，和设置中选中的 coding-plan 是两条
      // 独立的 Provider。只把 preferred 标为 entitled 会把试用 Provider
      // 错误地过滤掉，随后模型请求就会落到没有资源包的 BigModel API。
      const entitled = accountProviderHasCredentials(rule, homeDirectory) ?? rule.providerId === preferred
      const active = rule.providerId === preferred
      providers[rule.providerId] = {
        access: { type: 'zhipu-account', entitled },
        ...(entitled && Array.isArray(config.builtinModelIds) ? { builtinModelIds: config.builtinModelIds } : {}),
      }
      states[rule.providerId] = {
        availability: entitled ? 'available' : 'unavailable',
        entitled,
        current: active,
        ...(entitled ? {} : { unavailableReason: 'not-entitled' }),
      }
    }
    if (preferred === null) return null
    const basedOn = `zcode-builtin:${String(document.revision ?? 0)}:${createHash('sha256').update(file).digest('hex')}`
    return {
      revision: `account:${JSON.stringify([basedOn, providers, states])}`,
      basedOnZCodeBuiltinRevision: basedOn,
      providers,
      states,
    }
  } catch (error) {
    if (selectedProviderId !== undefined) throw error
    return null
  }
}

/** 读取 ZCode 登录态 JWT；Start Plan 使用它作为模型请求凭据。 */
async function readZcodeJwtToken(homeDirectory = homedir()): Promise<string | null> {
  const path = join(homeDirectory, '.zcode', 'v2', 'credentials.json')
  try {
    const credentials = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const value = credentials.zcodejwttoken
    if (typeof value !== 'string') return null
    return await decryptZcodeCredential(value, { credentialPath: path })
  } catch {
    return null
  }
}

/** 处理 ZCode Protocol 的客户端反向请求；模型请求必须提供账号 API Key。 */
async function handleZcodeServerRequest(request: JsonRpcMessage, homeDirectory = homedir()): Promise<unknown> {
  if (request.method === 'session/requestRuntimePreferences') {
    // DSH 的问题组件等待用户回答，不允许 ZCode 五分钟后自行替用户回答。
    return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false }
  }
  if (request.method === 'interaction/requestPermission') return { decision: 'deny' }
  if (request.method === 'interaction/requestUserInput') return { action: 'cancel' }
  if (request.method === 'interaction/requestProviderRuntimeHeaders') {
    const params = isRecord(request.params) ? request.params : {}
    const providerId = typeof params.providerId === 'string' ? params.providerId.trim() : ''
    if (providerId.endsWith('-start-plan') || providerId.endsWith('-offpeak-idle-plan')) {
      const token = await readZcodeJwtToken(homeDirectory)
      if (token !== null) {
        const runtime = resolveZcodeRuntimeHeaders(homeDirectory)
        return {
          headersApplied: true,
          requestAuth: {
            apiKey: token,
            ...(Object.keys(runtime).length > 0 ? { headers: runtime } : {}),
          },
        }
      }
      return { headersApplied: false, errorMessage: 'ZCode Start Plan 登录凭据不可用，请重新登录 ZCode' }
    }
    const apiKey = providerId === '' ? null : await readZcodeProviderApiKey(providerId, homeDirectory)
    if (apiKey !== null) return { headersApplied: true, requestAuth: { apiKey } }
    return { headersApplied: false, errorMessage: 'ZCode Provider 账号凭据不可用，请重新登录 ZCode' }
  }
  // 旧版 app-server 可能发送尚未定义的可选请求；保持兼容，不阻断会话创建。
  return {}
}

/** Start Plan 接口要求的客户端标识，值只用于请求头，不进入日志和持久化。 */
function resolveZcodeRuntimeHeaders(homeDirectory = homedir()): Record<string, string> {
  const headers: Record<string, string> = {}
  try {
    const telemetryPath = join(homeDirectory, '.zcode', 'v2', 'telemetry-state.json')
    const telemetry = JSON.parse(readFileSync(telemetryPath, 'utf8')) as Record<string, unknown>
    if (typeof telemetry.deviceMid === 'string' && telemetry.deviceMid.trim() !== '') {
      headers['X-Device-Mid'] = telemetry.deviceMid.trim()
    }
  } catch {
    // 没有设备标识时仍允许协议尝试，服务端会返回稳定的鉴权错误。
  }
  const version = resolveZCodeDesktopRuntime()?.appVersion?.trim() ?? null
  if (version !== null) headers['X-Client-Version'] = version
  return headers
}

/** 从 ZCode 共享凭据文件读取指定账号 Provider 的 API Key；原文只留在 Host。 */
async function readZcodeProviderApiKey(providerId: string, homeDirectory = homedir()): Promise<string | null> {
  const path = join(homeDirectory, '.zcode', 'v2', 'credentials.json')
  try {
    const credentials = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const prefix = `account-provider:coding-plan:${providerId}:account:`
    const key = Object.keys(credentials).find((candidate) => candidate.startsWith(prefix) && candidate.endsWith(':api-key'))
    if (key === undefined || typeof credentials[key] !== 'string') return null
    return await decryptZcodeCredential(credentials[key], { credentialPath: path })
  } catch {
    return null
  }
}

/** 根据 ZCode 内置 Provider 的套餐类型判断本机是否有对应凭据。 */
function accountProviderHasCredentials(rule: Record<string, any>, homeDirectory = homedir()): boolean | null {
  const providerId = typeof rule.providerId === 'string' ? rule.providerId : ''
  const config = isRecord(rule.config) ? rule.config : {}
  const access = isRecord(config.access) ? config.access : {}
  const mode = typeof access.mode === 'string' ? access.mode : ''
  const credentials = readJsonFile(join(homeDirectory, '.zcode', 'v2', 'credentials.json')) ?? {}
  if (mode === 'start-plan' || mode === 'off-peak') return typeof credentials.zcodejwttoken === 'string' && credentials.zcodejwttoken.trim() !== ''
  if (mode === 'individual-coding-plan' || mode === 'team-coding-plan') {
    const prefix = `account-provider:coding-plan:${providerId}:account:`
    return Object.entries(credentials).some(([key, value]) => key.startsWith(prefix) && key.endsWith(':api-key') && typeof value === 'string' && value.trim() !== '')
  }
  return null
}

export function resolvePreferredAccountProvider(
  rules: readonly unknown[],
  settings: Record<string, any> | null,
  hasCredentials: (rule: Record<string, any>) => boolean | null = accountProviderHasCredentials,
  hasStartLogin: () => boolean = () => accountProviderHasCredentials({ config: { access: { mode: 'start-plan' } } }) === true,
): string | null {
  const ids = new Set(rules.flatMap((rule) => isRecord(rule) && typeof rule.providerId === 'string' && rule.providerId.startsWith('account:') ? [rule.providerId] : []))
  const selections = settings?.providerFamilyConnectionSelections
  if (isRecord(selections)) {
    for (const [family, selection] of Object.entries(selections)) {
      const kind = isRecord(selection) && typeof selection.kind === 'string' ? selection.kind : ''
      const candidate = `account:${family}-${kind}`
      if (ids.has(candidate)) {
        const startPlan = `account:${family}-start-plan`
        // 设置中的套餐是用户的明确选择。只有选中的 Provider 没有对应凭据时，
        // 才回退到仍有登录态的 Start Plan，避免普通套餐被 JWT 静默遮蔽。
        const selectedRule = rules.find((rule): rule is Record<string, any> => isRecord(rule) && rule.providerId === candidate)
        if (selectedRule !== undefined && hasCredentials(selectedRule) === true) return candidate
        // A stale personal/team selection must not hide the family's saved paid
        // plan behind Start Plan. Resolve only within that same account family.
        const savedPlan = rules.find((rule): rule is Record<string, any> => isRecord(rule)
          && typeof rule.providerId === 'string' && rule.providerId.startsWith(`account:${family}-`)
          && ['individual-coding-plan', 'team-coding-plan'].includes(rule.config?.access?.mode)
          && hasCredentials(rule) === true)
        if (savedPlan !== undefined) return savedPlan.providerId
        if (kind === 'start-plan' || !ids.has(startPlan) || !hasStartLogin()) return candidate
        return startPlan
      }
    }
  }
  return null
}

function readJsonFile(path: string): Record<string, any> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function isMethodUnavailable(error: unknown): boolean {
  return error instanceof JsonRpcRequestError && (error.code === -32601 || error.code === -32001)
}

function createZcodeTurnEventQueue(): ZcodeTurnEventQueue {
  const pending: JsonRpcMessage[] = []
  let wake: (() => void) | undefined
  let closed = false
  return {
    async next(): Promise<IteratorResult<JsonRpcMessage>> {
      if (pending.length > 0) return { value: pending.shift()!, done: false }
      if (closed) return { value: undefined, done: true }
      await new Promise<void>((resolve) => { wake = resolve })
      if (pending.length > 0) return { value: pending.shift()!, done: false }
      return { value: undefined, done: true }
    },
    push(message: JsonRpcMessage): void {
      if (closed) return
      pending.push(message)
      wake?.()
      wake = undefined
    },
    close(): void {
      closed = true
      wake?.()
      wake = undefined
    },
  }
}

/** 同一交互可能按新 RPC id 重新通知；共用应答 Promise，只展示一次面板。 */
function pendingZcodeInteraction(session: ZcodeSession, interaction: ZcodeInteraction) {
  const id = interaction.event.requestId
  const previous = session.interactions.get(id)
  if (previous !== undefined) return previous
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => { resolve = done })
  const pending = { interaction, promise, resolve, settled: false }
  session.interactions.set(id, pending)
  return pending
}

function cancelZcodeInteractions(session: ZcodeSession, ids?: ReadonlySet<string>): void {
  for (const [id, pending] of session.interactions) {
    if (ids && !ids.has(id)) continue
    if (!pending.settled) pending.resolve(pending.interaction.cancelled)
    session.interactions.delete(id)
  }
}
