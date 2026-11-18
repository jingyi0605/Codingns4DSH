import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { decryptZcodeCredential } from './zcode-credentials.js'
import { accountProviderApiKeyEntry, accountProviderApiKeyExists, zcodeAccountFamily } from './zcode-account-keys.js'
import type {
  CodingNsAgentEvent,
  CodingNsAgentPermissionResponse,
  CodingNsAgentQuestionResponse,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import { NATIVE_COMPACTION_TIMEOUT_CODE } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliCompactionInput, CodingNsCliCompactionResult, CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, JsonRpcRequestError, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog } from './rpc-driver-utils.js'
import { randomUUID } from 'node:crypto'
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
  readonly compactionTimeoutMs?: number
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
  queueSteer?: (prompt: string) => void
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
  autoCompactThresholdTokens: number | undefined
  lastRequestContext: number | undefined
  supportsContextSnapshot: boolean
  compacting: boolean
}

const ZCODE_COMPACTION_TIMEOUT_MS = 300_000
const ZCODE_STEER_TOOL_WAIT_MS = 10_000
const ZCODE_STEER_STOP_TIMEOUT_MS = 5_000
const ZCODE_STEER_SEND_ATTEMPTS = 8

export class ZcodeCompactionTimeoutError extends Error {
  readonly code = NATIVE_COMPACTION_TIMEOUT_CODE

  constructor() {
    super('ZCode 上下文压缩超时')
    this.name = 'ZcodeCompactionTimeoutError'
  }
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
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'steer', 'tool-events', 'reasoning', 'usage', 'permission', 'questions'],
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
  private readonly compactionTimeoutMs: number
  private readonly homeDirectory: string
  /** 模型目录声明的默认思考档位；切换 DeepSeek 时服务端要求显式传入。 */
  private readonly defaultEfforts = new Map<string, string>()

  constructor(options: ZcodeCliDriverOptions = {}) {
    this.compactionTimeoutMs = options.compactionTimeoutMs ?? ZCODE_COMPACTION_TIMEOUT_MS
    this.homeDirectory = options.homeDirectory ?? homedir()
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
      // 同一把 key 只探测一次：个人版套餐复用 team 槽位的 key 时，两条槽位指向
      // 同一份额度，若逐个探测会在菜单里出现两条一模一样的套餐。这里只跳过
      // 「current 借用 key 的那个来源槽位」；start-plan 等自有凭据路径不受影响。
      const credentials = readJsonFile(join(this.homeDirectory, '.zcode', 'v2', 'credentials.json')) ?? {}
      const currentProvider = Object.entries(isRecord(snapshot?.states) ? snapshot.states : {})
        .find(([, state]) => isRecord(state) && state.current === true)?.[0]
      const currentEntry = currentProvider === undefined ? null : accountProviderApiKeyEntry(currentProvider, credentials)
      const borrowedSource = currentEntry !== null && currentEntry.borrowed === true ? currentEntry.sourceProviderId : undefined
      const candidates = zcodeAccountCatalogCandidates(snapshot)
        .filter(id => borrowedSource === undefined || id !== borrowedSource)
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

  async compact(input: CodingNsCliCompactionInput): Promise<CodingNsCliCompactionResult> {
    input.signal?.throwIfAborted()
    if (!input.providerSessionId) throw new Error('ZCODE_COMPACTION_SESSION_REQUIRED')
    const existing = this.sessions.get(input.sessionId)
    // 回合进行中不能压缩：协议会拒绝，提前给出可诊断的忙碌错误。
    if (existing?.acceptingInteractions === true || existing?.compacting || compactionBackground(existing)?.hasActive) throw new Error('ZCODE_COMPACTION_BUSY')
    if (!(await this.detect()).installed) throw new Error('ZCode 未安装')
    // 压缩是维护操作，不是新回合：必须复用已有的常驻会话实例。走 getSession 会在
    // 「绑定已存在」时另起一个 app-server，而那个进程并不知道原生会话，压缩前的
    // resume 又可能因权限模式尚未下发而被拒，压缩就此中断。
    const session = existing ?? await this.getSession({ ...input, messages: [], prompt: '' })
    const timeout = AbortSignal.timeout(this.compactionTimeoutMs)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    // 压缩在 ZCode 侧是一个真实回合：期间必须把它的通知挡在后台回合判定之外，
    // 否则会被当成「后台回合」，往会话里插一条工作流结果通知、并把压缩标记
    // （Compacted）当成助手回复显示。
    session.compacting = true
    // Background-aware drivers must classify the maintenance turn as owned
    // foreground work, so its output cannot become a workflow notification.
    const background = compactionBackground(session)
    background?.beginForeground()
    const compactionId = `zcode-compaction-${randomUUID()}`
    const emit = input.onCompactionEvent
    let started = false
    let accepted = false
    let completion: ReturnType<typeof observeZcodeCompaction> | undefined
    try {
      if (session.acpSessionId === '') {
        const resumed = await session.rpc.request('session/resume', {
          sessionId: input.providerSessionId,
          workspace: zcodeWorkspace(input.cwd),
        }, { signal, killOnAbort: false })
        const resumedId = readSessionId(resumed)
        if (resumedId !== input.providerSessionId) throw new Error('ZCode 返回了不同的原生会话 ID，已停止压缩')
        session.acpSessionId = resumedId
      }
      if (session.acpSessionId !== input.providerSessionId) throw new Error('ZCODE_COMPACTION_SESSION_MISMATCH')
      await this.subscribeSessionEvents(session, signal)
      const before = zcodeContextUsed(await readZcodeSessionData(session.rpc, 'session/read', session.acpSessionId))
      signal.throwIfAborted()
      completion = observeZcodeCompaction(session.rpc, session.acpSessionId, signal)
      const compactStartedAt = Date.now()
      emit?.({ type: 'context-compaction', phase: 'start', compactionId })
      started = true
      const response = await session.rpc.request('session/compact', {
        sessionId: session.acpSessionId,
        inputId: randomUUID(),
      }, { signal, killOnAbort: false })
      const state = compactionRecord(compactionRecord(response).compact).state
      accepted = state === 'accepted'
      if (accepted) await completion.promise
      else if (state === 'failed' || state === 'cancelled') throw new Error(`ZCODE_COMPACTION_${state.toUpperCase()}`)
      signal.throwIfAborted()
      // Native completion carries no text. The persisted compact_summary is a
      // separate hidden message; read it before releasing maintenance to queued turns.
      const summary = zcodeCompactionSummary(
        await readZcodeSessionData(session.rpc, 'session/read', session.acpSessionId, 8), compactStartedAt,
      )
      // 压缩改变了原生会话规模：丢弃旧基线，下一轮按新会话重新取增量。
      session.lastUsage = undefined
      session.lastRequestContext = undefined
      const events: Extract<CodingNsAgentEvent, { type: 'context-compaction' }>[] = [
        {
          type: 'context-compaction', phase: 'summary', compactionId,
          provider: 'zcode',
          ...(summary === undefined ? {} : { summary }),
          ...(before === undefined ? {} : { shadowedTokenCount: before }),
        },
        { type: 'context-compaction', phase: 'end', compactionId },
      ]
      // DSH accepts null-turn maintenance lifecycles. Registry callers project live;
      // callers without a display sink retain the legacy next-turn fallback.
      if (emit) for (const event of events) emit(event)

      return { compacted: true }
    } catch (error) {
      if (started) emit?.({ type: 'context-compaction', phase: 'end', compactionId,
        error: error instanceof Error ? error.message : String(error) })
      if (accepted) {
        // The RPC acknowledgement does not end the native turn. Settle it before
        // releasing the execution lock, including on cancellation and timeout.
        try { await session.rpc.request('session/stop', { sessionId: session.acpSessionId },
          { signal: AbortSignal.timeout(1_500), killOnAbort: false }) } catch { /* original failure remains authoritative */ }
      }
      if (input.signal?.aborted !== true && isZcodeTimeoutAbort(signal, error)) throw new ZcodeCompactionTimeoutError()
      throw error
    } finally {
      completion?.dispose()
      background?.endForeground()
      session.compacting = false
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    yield* withAttachmentPaths(input, (prepared) => this.executePreparedTurn(prepared))
  }

  steer(sessionId: string, prompt: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.acceptingInteractions || session.queueSteer === undefined) {
      throw new Error('ZCode 没有可插话的前台回合')
    }
    const instruction = prompt.trim()
    if (instruction) session.queueSteer(instruction)
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
    let pendingSteer: string | undefined
    let steerTimer: ReturnType<typeof setTimeout> | undefined
    let waitingForStop = false
    let activeNativeTurnId: string | undefined
    let retiredNativeTurnId: string | undefined
    let replacedBySteer = false
    const activeTools = new Set<string>()
    const isRetiredNotification = (message: JsonRpcMessage): boolean => {
      const params = record(message.params)
      if (retiredNativeTurnId !== undefined && params.turnId === retiredNativeTurnId) return true
      if (!replacedBySteer || activeNativeTurnId === undefined) return false
      if (message.method !== 'state.updated' || params.turnId !== undefined) return false
      // The stopped turn can emit an unscoped prompt_failed after the new turn
      // starts. Once the replacement has a native ID, use its scoped terminal events.
      return String(params.reason ?? '').includes('failed') || record(params.patch).status === 'idle'
    }
    // resume/subscribe 已完成；send 响应前的交互也必须立即消费，避免双向等待。
    const onNotification = (message: JsonRpcMessage): void => {
      if (!session.acceptingInteractions || isRetiredNotification(message)) return
      const params = record(message.params)
      if (message.method === 'session/event' && params.type === 'turn.started' && typeof params.turnId === 'string') {
        activeNativeTurnId = params.turnId
      }
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
    session.queueSteer = (prompt) => {
      if (pendingSteer === undefined) {
        pendingSteer = prompt
        steerTimer = setTimeout(() => eventQueue.push({ method: 'codingns/steer-tool-timeout' }), ZCODE_STEER_TOOL_WAIT_MS)
        steerTimer.unref()
        eventQueue.push({ method: 'codingns/steer-requested' })
      } else {
        pendingSteer += `\n\n${prompt}`
      }
    }
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
    const requestSend = (content: string) => session.rpc.request('session/send', { sessionId: session.acpSessionId, content }, sendOptions)
    const sendAfterSteer = async (content: string): Promise<unknown> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await requestSend(content)
        } catch (error) {
          // Native idle can precede release of the turn's execution lock.
          if (!(error instanceof JsonRpcRequestError) || error.code !== -32010 || attempt >= ZCODE_STEER_SEND_ATTEMPTS) throw error
          await delay(150, undefined, { signal: input.signal })
        }
      }
    }
    const send = (content: string, afterSteer = false) => {
      const attempt: { error: unknown; promise: Promise<void> } = { error: null, promise: Promise.resolve() }
      attempt.promise = (afterSteer ? sendAfterSteer(content) : requestSend(content))
        .then(() => undefined, (error: unknown) => {
          attempt.error = error
          eventQueue.push({ method: 'codingns/send-failed' })
        })
      return attempt
    }
    let sendAttempt = send(turnContent)
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
        if (isRetiredNotification(next.value)) continue
        if (sendAttempt.error !== null && !waitingForStop) throw sendAttempt.error
        if (next.value.method === 'codingns/steer-stop-timeout' && waitingForStop) {
          throw new Error('ZCode 未确认停止当前回合，插话未发送')
        }
        const tool = telemetry.observe(next.value)
        if (tool !== null) {
          if (tool.callId !== undefined && tool.status !== undefined) {
            if (tool.status === 'completed' || tool.status === 'failed') activeTools.delete(tool.callId)
            else activeTools.add(tool.callId)
          }
          yield tool
        }
        const context = telemetry.takeContextObservation()
        if (context !== null) yield context
        const chunk = zcodeMessageToChunk(next.value, session, input)
        if (chunk !== null) yield* asZcodeChunks(chunk)
        terminalReason = readZcodeTerminalReason(next.value, session, input) ?? terminalReason
        if (pendingSteer !== undefined) {
          if (terminalReason === 'stop' || (waitingForStop && terminalReason !== null)) {
            const prompt = pendingSteer
            pendingSteer = undefined
            clearTimeout(steerTimer)
            waitingForStop = false
            terminalReason = null
            activeTools.clear()
            session.sawRunning = false
            session.sawText = false
            session.streamingMessageId = undefined
            session.streamingMessageStarted = false
            session.failureCode = undefined
            session.failureMessage = undefined
            yield { type: 'message-boundary', channel: 'text', messageId: randomUUID() }
            if (input.signal?.aborted) break
            retiredNativeTurnId = activeNativeTurnId
            activeNativeTurnId = undefined
            replacedBySteer = true
            session.background.beginForeground()
            sendAttempt = send(zcodePrompt(prompt, session.workflowEnabled), true)
            continue
          }
          if (terminalReason === null && !waitingForStop && (activeTools.size === 0 || next.value.method === 'codingns/steer-tool-timeout')) {
            waitingForStop = true
            clearTimeout(steerTimer)
            cancelZcodeInteractions(session, session.emittedInteractions)
            const timeout = AbortSignal.timeout(ZCODE_STEER_STOP_TIMEOUT_MS)
            const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout])
            await session.rpc.request('session/stop', { sessionId: session.acpSessionId }, { signal, killOnAbort: false })
            steerTimer = setTimeout(() => eventQueue.push({ method: 'codingns/steer-stop-timeout' }), ZCODE_STEER_STOP_TIMEOUT_MS)
            steerTimer.unref()
          }
        }
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
      await sendAttempt.promise
      if (sendAttempt.error !== null && !input.signal?.aborted) throw sendAttempt.error
      if (terminalReason === 'stop' || terminalReason === null) {
        if (input.signal?.aborted) {
          terminalReason = 'cancel'
        } else {
          // usage 查询属于正常终态的一部分，不能因为 idle 事件先到就跳过。
          const rawUsage = await readZcodeSessionData(session.rpc, 'session/usage', session.acpSessionId)
          session.lastUsage = rawUsage
          if (session.supportsContextSnapshot) {
            const snapshot = await readZcodeSessionData(session.rpc, 'session/read', session.acpSessionId)
            if (telemetry.needsContextSnapshot) telemetry.readContextSnapshot(snapshot)
            const threshold = telemetry.readAutoCompactThreshold(snapshot)
            if (threshold !== null) session.autoCompactThresholdTokens = threshold
          }
          const usage = telemetry.finish(rawUsage, baseline)
          if (usage !== null) yield withZcodeContextPressure(usage, session)
          terminalReason = 'stop'
        }
      }
      if (terminalReason === 'error') {
        const usage = telemetry.finish(null, baseline)
        if (usage !== null) yield withZcodeContextPressure(usage, session)
        // 失败详情已经在通知监听器中捕获；这里统一发唯一终态。
        yield { type: 'finish', reason: 'error', failure: { ...zcodeFailure(session), ...(isZcodeContextOverflow(session) ? { contextOverflow: true } : {}) } }
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
      clearTimeout(steerTimer)
      delete session.queueSteer
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
    if (previous !== undefined && previous.cwd === input.cwd && !previous.rpc.isClosed
      && (input.providerSessionId === undefined || previous.acpSessionId === input.providerSessionId)) return previous
    if (previous !== undefined) { previous.background.cancel(); cancelZcodeInteractions(previous) }
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
      autoCompactThresholdTokens: undefined,
      lastRequestContext: undefined,
      supportsContextSnapshot: false,
      compacting: false,
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
    // A PATH launcher may use the discovered desktop provider configuration too.
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
  async readAutoCompactThreshold(sessionId: string, signal?: AbortSignal): Promise<number | undefined> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.acpSessionId === '') return undefined
    const snapshot = await readZcodeSessionData(session.rpc, 'session/read', session.acpSessionId)
    const telemetry = new ZcodeTurnTelemetry(session.acpSessionId)
    const threshold = telemetry.readAutoCompactThreshold(snapshot)
    if (threshold !== null) session.autoCompactThresholdTokens = threshold
    signal?.throwIfAborted()
    return session.autoCompactThresholdTokens
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

  // 每次模型请求都只上报“这一次调用”的上下文占用。
  //
  // 从前整轮的多次模型请求会被累加成一条 usage（同一份历史被重复计费），
  // DSH 的 contextPressure 会因此把上下文按几倍放大，于是每个 turn/start 都
  // 触发一次核心自动压缩，而核心压缩对虚拟 Provider 只能失败。
  // 这里按请求粒度回填真实占用，计费累计交给 DSH 自己完成。
  if (method === 'session/event' && params.type === 'session.updated') {
    const payload = isRecord(params.payload) ? params.payload : {}
    if (typeof payload.stopReason === 'string' && (payload.querySource === undefined || payload.querySource === 'main_turn')) {
      const used = zcodeUsagePressure(compactionRecord(payload.usage), payload.inputBaselineBySource)
      if (used !== null) session.lastRequestContext = used
      return null
    }
  }
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

function isZcodeContextOverflow(session: ZcodeSession): boolean {
  const code = (session.failureCode ?? '').toLowerCase()
  const detail = (session.failureMessage ?? '').toLowerCase()
  const pattern = /prompt is too long|context[_ ]?length|context[_ ]?window|exceed.*(token|context)|too many tokens|context_overflow/u
  return pattern.test(detail) || code === 'context_overflow' || code === 'context_length_exceeded' || code === '1261'
}

function zcodeFailure(session: ZcodeSession): { message: string; code?: string } {
  const message = session.failureMessage?.trim() || 'ZCode Provider 未返回具体失败信息。'
  const code = session.failureCode?.trim()
  return code ? { message, code } : { message }
}

function compactionRecord(value: unknown): Record<string, any> {
  return isRecord(value) ? value : {}
}

function compactionBackground(session: ZcodeSession | undefined) {
  const background = (session as ZcodeSession & {
    readonly background?: { readonly hasActive: boolean; beginForeground(): void; endForeground(): void }
  } | undefined)?.background
  return background && typeof background.beginForeground === 'function' && typeof background.endForeground === 'function'
    ? background : undefined
}

function zcodeContextUsed(value: unknown): number | undefined {
  const root = isRecord(value) && isRecord(value.snapshot) ? value.snapshot : isRecord(value) ? value : undefined
  const projection = isRecord(root) && isRecord(root.projection) ? root.projection : undefined
  const used = projection?.contextUsed
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : undefined
}

function isZcodeTimeoutAbort(signal: AbortSignal, error: unknown): boolean {
  if (!signal.aborted) return false
  if (isRecord(signal.reason) && signal.reason.name === 'TimeoutError') return true
  return error instanceof Error && error.name === 'TimeoutError'
}

function observeZcodeCompaction(
  rpc: JsonRpcProcess,
  sessionId: string,
  signal: AbortSignal,
) {
  let resolve!: () => void, reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  // Completion can arrive before the acknowledgement; attach before sending.
  void promise.catch(() => undefined)
  const abort = () => reject(signal.reason ?? new Error('ZCODE_COMPACTION_CANCELLED'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const removeExit = rpc.addExitListener(error => reject(error))
  const removeNotification = rpc.addNotificationListener(message => {
    const params = compactionRecord(message.params), patch = compactionRecord(params.patch)
    const id = params.sessionId ?? patch.sessionId
    if (typeof id === 'string' && id !== sessionId) return
    if (message.method !== 'state.updated') return
    if (params.reason === 'session_compacted') resolve()
    else if (params.reason === 'session_compact_failed' || params.reason === 'session_compact_cancelled') reject(new Error(String(params.reason)))
  })
  return { promise, dispose() { signal.removeEventListener('abort', abort); removeExit(); removeNotification() } }
}

function zcodeCompactionSummary(value: unknown, startedAt: number): string | undefined {
  const root = isRecord(value) && isRecord(value.snapshot) ? value.snapshot : value
  if (!isRecord(root) || !Array.isArray(root.messages)) return undefined
  // Use the native semantic marker and this operation's timestamp, so an older
  // summary or the visible "Compacted" assistant marker cannot become its body.
  const message = [...root.messages].reverse().find(candidate => {
    const info = compactionRecord(compactionRecord(candidate).info)
    return compactionRecord(info.semantics).kind === 'compact_summary'
      && typeof compactionRecord(info.time).created === 'number'
      && compactionRecord(info.time).created >= startedAt
  })
  const parts = compactionRecord(message).parts
  if (!Array.isArray(parts)) return undefined
  const text = parts.filter(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n\n')
  return text.trim() === '' ? undefined : text
}

async function readZcodeSessionData(rpc: JsonRpcProcess, method: 'session/usage' | 'session/read', sessionId: string, messageLimit = 1): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  timer.unref?.()
  try {
    return await rpc.request(method, { sessionId, ...(method === 'session/read' ? { messageLimit } : {}) },
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
    const timeout = AbortSignal.timeout(10_000)
    const response = await rpc.request('workspace/updateDynamicWorkflowPolicy', { workspace: zcodeWorkspace(cwd), enabled: true, mode: 'alwaysOn' }, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]), killOnAbort: false })
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
    // current 既要出现在目录里，也要真的能跑：OAuth 连接的套餐放在 candidates 里
    // 逐个探测列出，但默认仍落在 DSH 能交出凭据的套餐上（见 accountProviderUsable）。
    const preferred = selectedProviderId ?? resolvePreferredAccountProvider(rules, settings,
      rule => accountProviderUsable(rule, homeDirectory),
      () => accountProviderUsable({ config: { access: { mode: 'start-plan' } } }, homeDirectory) === true)
    if (selectedProviderId !== undefined) {
      const selected = rules.find(rule => isRecord(rule) && rule.providerId === selectedProviderId)
      if (!selected || accountProviderConnected(selected, homeDirectory) !== true) throw new Error(`ZCode 套餐连接凭据不可用: ${selectedProviderId}`)
    }
    const providers: Record<string, unknown> = {}
    const states: Record<string, unknown> = {}
    for (const rule of rules) {
      if (!isRecord(rule) || typeof rule.providerId !== 'string' || !rule.providerId.startsWith('account:')) continue
      const config = isRecord(rule.config) ? rule.config : {}
      // ZCode 的试用额度属于 start-plan，和设置中选中的 coding-plan 是两条
      // 独立的 Provider。只把 preferred 标为 entitled 会把试用 Provider
      // 错误地过滤掉，随后模型请求就会落到没有资源包的 BigModel API。
      const entitled = accountProviderConnected(rule, homeDirectory) ?? rule.providerId === preferred
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
    if (providerId !== '') {
      const apiKey = await readZcodeProviderApiKey(providerId, homeDirectory)
      if (apiKey !== null) return { headersApplied: true, requestAuth: { apiKey } }
      // 个人/团队套餐改用 OAuth 连接后，ZCode 不再写 coding-plan 的 api-key。这类
      // 套餐的项目 Token 由 ZCode 用登录态做签名请求签发，DSH 无法复现；实测把
      // OAuth 登录令牌当 api-key 会被 ZCode 自己的 v4 签名器拒绝
      // （ClientRequestSigningV4Error，请求根本不会出网，也不会带指纹重问）。
      // 因此直接给出可操作原因，不做注定失败的尝试。
      const family = zcodeAccountFamily(providerId)
      if (family !== null && zcodeOauthAccessTokenValue(family, homeDirectory) !== null) {
        return { headersApplied: false, errorMessage: ZCODE_OAUTH_PLAN_NEEDS_API_KEY }
      }
    }
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
    const credentials = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
    const entry = accountProviderApiKeyEntry(providerId, credentials)
    if (entry === null) return null
    const value = credentials[entry.key]
    if (typeof value !== 'string') return null
    return await decryptZcodeCredential(value, { credentialPath: path })
  } catch {
    return null
  }
}

/**
 * ZCode 账号族的登录令牌键。
 *
 * OAuth 连接的套餐不使用 coding-plan 的 api-key，登录令牌是唯一凭据；
 * `setting.json` 的 `modelProviderFamilyModes` 声明该族处于 oauth 模式。
 */
const ZCODE_OAUTH_ACCESS_TOKEN_KEYS: Readonly<Record<string, readonly string[]>> = {
  zai: ['oauth:zai:access_token', 'oauth:zai_cn:access_token'],
  bigmodel: ['oauth:bigmodel:access_token'],
}

const ZCODE_OAUTH_PLAN_NEEDS_API_KEY = '该套餐在 ZCode 桌面端以 OAuth 方式连接，项目 Token 由 ZCode 自己签发，DSH 无法复现；请在 ZCode 的模型设置里改用 API Key 连接这个套餐后重试'

/** 该族的 OAuth 登录令牌原文键；未处于 oauth 模式或没有令牌时返回 null。 */
function zcodeOauthAccessTokenKey(family: string, homeDirectory = homedir()): string | null {
  const settings = readJsonFile(join(homeDirectory, '.zcode', 'v2', 'setting.json'))
  const modes = settings?.modelProviderFamilyModes
  const mode = isRecord(modes) && typeof modes[family] === 'string' ? modes[family] : ''
  if (mode !== 'oauth') return null
  const credentials = readJsonFile(join(homeDirectory, '.zcode', 'v2', 'credentials.json')) ?? {}
  for (const key of ZCODE_OAUTH_ACCESS_TOKEN_KEYS[family] ?? [`oauth:${family}:access_token`]) {
    const value = credentials[key]
    if (typeof value === 'string' && value.trim() !== '') return key
  }
  return null
}

/** 该族的 OAuth 登录令牌原文；未处于 oauth 模式或没有令牌时返回 null。 */
function zcodeOauthAccessTokenValue(family: string, homeDirectory = homedir()): string | null {
  const key = zcodeOauthAccessTokenKey(family, homeDirectory)
  if (key === null) return null
  const credentials = readJsonFile(join(homeDirectory, '.zcode', 'v2', 'credentials.json')) ?? {}
  const value = credentials[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 账号套餐是否已连接：api-key、登录 JWT 或 OAuth 登录都算。
 *
 * 连接状态决定套餐能否出现在模型目录里。OAuth 连接的套餐（ZCode 桌面端
 * `modelProviderFamilyModes[family] = "oauth"`）不再写 coding-plan 的 api-key，
 * 只有 `oauth:<family>:access_token`；少了这一步，用户在设置里选中的套餐会
 * 被判成未连接，直接从目录里消失。
 */
function accountProviderConnected(rule: Record<string, any>, homeDirectory = homedir()): boolean | null {
  const providerId = typeof rule.providerId === 'string' ? rule.providerId : ''
  const config = isRecord(rule.config) ? rule.config : {}
  const access = isRecord(config.access) ? config.access : {}
  const mode = typeof access.mode === 'string' ? access.mode : ''
  const credentials = readJsonFile(join(homeDirectory, '.zcode', 'v2', 'credentials.json')) ?? {}
  if (mode === 'start-plan' || mode === 'off-peak') return typeof credentials.zcodejwttoken === 'string' && credentials.zcodejwttoken.trim() !== ''
  if (mode === 'individual-coding-plan' || mode === 'team-coding-plan') {
    if (accountProviderApiKeyExists(providerId, credentials)) return true
    const family = zcodeAccountFamily(providerId)
    return family !== null && zcodeOauthAccessTokenValue(family, homeDirectory) !== null
  }
  return null
}

/**
 * 账号套餐能否真正用于模型请求：DSH 只能交出 coding-plan 的 api-key 与登录 JWT。
 *
 * OAuth 连接的套餐需要 ZCode 用自己的登录态签发项目 Token，DSH 无法复现该
 * 签名流程，实测把 OAuth 令牌当 api-key 会被 ZCode 的客户端签名器拒绝
 * （`ClientRequestSigningV4Error`，请求不会出网）。因此 current 只在这里为真
 * 的套餐里选，避免默认落到一个注定失败的连接上；coding-plan 允许在同家族内
 * 复用可用 api-key（见 `accountProviderApiKeyEntry`）。
 */
function accountProviderUsable(rule: Record<string, any>, homeDirectory = homedir()): boolean | null {
  const providerId = typeof rule.providerId === 'string' ? rule.providerId : ''
  const config = isRecord(rule.config) ? rule.config : {}
  const access = isRecord(config.access) ? config.access : {}
  const mode = typeof access.mode === 'string' ? access.mode : ''
  const credentials = readJsonFile(join(homeDirectory, '.zcode', 'v2', 'credentials.json')) ?? {}
  if (mode === 'start-plan' || mode === 'off-peak') return typeof credentials.zcodejwttoken === 'string' && credentials.zcodejwttoken.trim() !== ''
  if (mode === 'individual-coding-plan' || mode === 'team-coding-plan') return accountProviderApiKeyExists(providerId, credentials)
  return null
}

/** 同族 key 复用与凭据键解析见 zcode-account-keys.ts；模型目录与用量读取共用。 */
export function resolvePreferredAccountProvider(
  rules: readonly unknown[],
  settings: Record<string, any> | null,
  hasCredentials: (rule: Record<string, any>) => boolean | null = accountProviderUsable,
  hasStartLogin: () => boolean = () => accountProviderUsable({ config: { access: { mode: 'start-plan' } } }) === true,
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

function withZcodeContextPressure(usage: CodingNsAgentEvent, session: ZcodeSession): CodingNsAgentEvent {
  if (usage.type !== 'usage' || session.lastRequestContext === undefined) return usage
  const contextTokens = session.lastRequestContext
  const window = usage.contextWindow
  return {
    ...usage,
    contextTokens,
    ...(window === undefined || window <= 0
      ? {}
      : { contextUsageRatio: Number(Math.min(1, contextTokens / window).toFixed(6)) }),
    // 原生阈值随用量一起交给上层：自动压缩优先用它，读不到时按比例兜底。
    ...(session.autoCompactThresholdTokens === undefined ? {} : { autoCompactThresholdTokens: session.autoCompactThresholdTokens }),
  }
}

/**
 * 一次模型请求的真实上下文占用。
 *
 * `session/usage` 查询返回的是去重后的累计值，缓存命中时会把真实占用低估到
 * 十分之一；模型完成事件里的 `usage` 才是这次请求实际发出的 prompt 规模。
 * 旧版事件没有 usage 时退回该来源的去重输入口径。
 */
function zcodeUsagePressure(usage: Record<string, any>, baseline: unknown): number | null {
  const inputTokens = numberOrNull(usage.inputTokens ?? usage.input_tokens)
  const cacheReadTokens = numberOrNull(usage.cacheReadTokens ?? usage.cachedInputTokens ?? usage.cache_read_tokens) ?? 0
  const cacheWriteTokens = numberOrNull(usage.cacheWriteTokens ?? usage.cache_write_tokens) ?? 0
  if (inputTokens !== null) {
    const explicitUncached = numberOrNull(usage.uncachedInputTokens ?? usage.uncached_input_tokens)
    const fromBaseline = isRecord(baseline) ? numberOrNull(baseline.main_turn ?? baseline.mainTurn) : null
    // 新版 CLI 的 inputTokens 已是未缓存输入（另有 baseline 去重口径）；
    // 旧版是含缓存的完整输入。两种口径下都要还原成“这次请求的 prompt 规模”。
    const uncached = explicitUncached ?? (fromBaseline === null ? inputTokens : Math.max(0, inputTokens - fromBaseline))
    const used = uncached + cacheReadTokens + cacheWriteTokens
    if (used > 0) return used
  }
  return null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
