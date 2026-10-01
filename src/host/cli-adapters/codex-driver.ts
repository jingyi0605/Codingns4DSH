import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CodingNsAgentEvent, CodingNsAgentQuestionResponse, CodingNsCliModelCatalog, CodingNsAgentPermissionResponse, CodingNsCliSandboxMode, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, JsonRpcRequestError, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, textValue, usageChunk } from './rpc-driver-utils.js'
import { CODEX_CATALOG, isProviderDefaultModel } from './model-catalog.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { isQuestionEvent, questionAnswersRecord, readAgentQuestions } from './interaction-events.js'
import { codexBridgeArgs, codexBridgeDeveloperInstructions } from '../cli-bridge/injections.js'

export interface CodexAppServerDriverOptions {
  readonly binaries?: readonly string[]
  readonly sessionRoots?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

interface CodexSegmentedTurn {
  readonly queue: CodexTurnEventQueue
  removeNotificationListener: () => void
  removeAbortListener: () => void
  terminalReason: 'stop' | 'cancel' | 'error' | null
  done: boolean
  pendingChunk: CodingNsAgentEvent | undefined
  currentAssistantMessageId: string | undefined
  sawCompletedTool: boolean
}

interface CodexTurnEventQueue {
  readonly iterable: AsyncIterable<JsonRpcMessage>
  next(): Promise<IteratorResult<JsonRpcMessage>>
  push(message: JsonRpcMessage): void
  close(): void
}

interface CodexSession {
  readonly rpc: JsonRpcProcess
  readonly cwd: string | undefined
  modelId: string | undefined
  contextWindow: number | undefined
  contextTokens: number | undefined
  threadId: string
  /**
   * 线程当前真正生效的模型。
   *
   * Codex 只在 `thread/start` 时确定线程模型：同一 app-server 进程内再次
   * `thread/resume` 不会改写已持久化的模型。必须与期望模型分开记录，才能在
   * 模型变化或线程被错误模型污染时显式纠正。
   */
  threadModelId: string | undefined
  /** 旧版 Codex 没有 thread/settings/update；失败一次后不再每轮重试。 */
  threadModelCorrectionUnsupported: boolean
  turnId: string | null
  providerSessionId: string
  readonly pendingPermissions: Map<string, PendingCodexPermission>
  readonly pendingQuestions: Map<string, (value: unknown) => void>
  segmentedTurn: CodexSegmentedTurn | undefined
  compacting: Promise<void> | undefined
  suppressCompactionNotifications: boolean
  readonly suppressedCompactionTurnIds: Set<string>
  pendingCompactionEvents: CodingNsAgentEvent[]
  /** 自动压缩的待闭合事务：item/started 开启，item/completed 或 turn 终结时闭合。 */
  autoCompaction: { readonly compactionId: string | undefined; open: boolean } | undefined
}

// 只有 Provider 已明确报告超过窗口时才主动压缩；接近上限仍交给 Codex
// 自身的 auto-compact，避免对正常的高占用回合重复发起压缩。
const CODEX_COMPACTION_THRESHOLD = 1
const CODEX_COMPACTION_TIMEOUT_MS = 60_000
// Codex CLI 默认会启用 computer_use；DSH 没有对应的桌面控制宿主，必须在
// app-server 进程启动时关闭该 feature，避免模型进入无法完成的控制回合。
const CODEX_APP_SERVER_ARGS = ['app-server', '--disable', 'computer_use'] as const

interface PendingCodexPermission {
  readonly resolve: (value: unknown) => void
  readonly response: 'legacy' | 'command' | 'file-change' | 'permissions'
  /**
   * `item/permissions/requestApproval` 的原始请求画像。
   *
   * 该协议的应答不是布尔值，而是 `{permissions, scope}`：批准必须回显 Codex 请求的
   * 权限范围，拒绝必须给出空画像。丢掉请求画像就无法构造合法应答。
   */
  readonly requested?: unknown
}

/** Codex app-server 的 JSON-RPC 驱动，Host 只暴露统一文本流，不暴露线程和 token。 */
export class CodexAppServerDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'codex', name: 'Codex', protocol: 'json-rpc', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions', 'steer'] as const } as const
  // Codex 一个 Provider turn 可能同时包含多个工具调用。只有 assistant item
  // 切换后才分段，不能在每个工具完成后注入下一 step。
  readonly supportsSegmentedTurns = true
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly sessionRoots: readonly string[]
  private cachedBinary: string | null = null
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly sessions = new Map<string, CodexSession>()

  constructor(options: CodexAppServerDriverOptions = {}) {
    this.binaries = options.binaries ?? ['codex']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.sessionRoots = options.sessionRoots ?? [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) return emptyCatalog()
    const rpc = new JsonRpcProcess({ command, args: CODEX_APP_SERVER_ARGS, spawn: this.runSpawn })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
        capabilities: {},
      }, { signal: controller.signal })
      rpc.notify('initialized', {})
      // config/read 让 Codex 完成一次配置加载；model/list 才返回带 effort 元数据的目录。
      await rpc.request('config/read', {}, { signal: controller.signal })
      const response = await rpc.request('model/list', {}, { signal: controller.signal })
      const catalog = parseCodexCatalog(response)
      return catalog.groups.length > 0 ? catalog : CODEX_CATALOG
    } catch {
      return CODEX_CATALOG
    } finally {
      clearTimeout(timer)
      rpc.dispose()
    }
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path).endsWith(`${id}.jsonl`),
      validate: async (path, id) => {
        const record = await readFirstJsonRecord(path)
        return isRecord(record?.payload) && record.payload.id === id
      },
    })
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error('Codex 未安装')
    if (input.splitToolSteps && this.supportsSegmentedTurns) {
      yield* this.executeSegmentedTurn(input, command)
      return
    }
    const session = await this.getSession(input, command)
    prepareCodexSession(session, input)
    const rpc = session.rpc
    try {
      if (session.threadId === '') {
        const threadParams = codexThreadParams(input)
        const thread = input.providerSessionId
          ? await rpc.request('thread/resume', { threadId: input.providerSessionId, ...threadParams }, { signal: input.signal, killOnAbort: false })
          : await rpc.request('thread/start', threadParams, { signal: input.signal, killOnAbort: false })
        session.threadId = readId(thread) ?? input.providerSessionId ?? input.sessionId
        session.providerSessionId = session.threadId
        session.threadModelId = readThreadModel(thread)
      }
      await this.alignThreadModel(session, input)
      await this.ensureContextCapacity(session, input)
      yield* drainCompactionEvents(session)
      yield { type: 'session-binding', providerSessionId: session.providerSessionId }
      const eventQueue = createCodexTurnEventQueue()
      let activeTurnId: string | null = null
      let turnStartResolved = false
      const notificationsBeforeTurnStart: JsonRpcMessage[] = []
      let terminalReason: 'stop' | 'cancel' | 'error' | null = null
      let sawMeaningfulEvent = false
      const acceptNotification = (message: JsonRpcMessage, allowUnidentifiedTool: boolean): void => {
        // Codex 自动压缩可能在独立的内部 turn 中运行。它不属于当前用户 turn，
        // 但压缩 item 和 thread/compacted 必须继续进入公共投影层，否则压缩虽已发生，
        // 原生会话不会显示任何 compaction 活动。
        if (isCodexCompactionNotification(message, session.threadId)) {
          const notificationTurnId = readTurnId(message)
          // 显式 thread/compact/start 由 waitForCompaction 独占消费通知并生成
          // start/summary/end，当前 turn 队列不能再次投影同一组事件。
          if (!session.suppressCompactionNotifications
            && (notificationTurnId === null || !session.suppressedCompactionTurnIds.has(notificationTurnId))) eventQueue.push(message)
          return
        }
        if (!isCodexNotificationForTurn(message, session.threadId, activeTurnId, allowUnidentifiedTool)) return
        const turnId = readTurnId(message)
        if (turnId !== null) {
          activeTurnId = turnId
          session.turnId = turnId
        }
        eventQueue.push(message)
        const reason = readCodexTerminalReason(message)
        if (reason !== null) {
          terminalReason = reason
          eventQueue.close()
        }
      }
      const onNotification = (message: JsonRpcMessage): void => {
        // thread/resume 后，Codex 可能把旧回合的 item 通知迟到到达，并且
        // 与本次 turn/start 的响应交错。响应返回前不能把这些通知当成当前回合，
        // 否则旧工具历史会在流式界面被追加到当前消息末尾。
        if (!turnStartResolved) {
          notificationsBeforeTurnStart.push(message)
          return
        }
        acceptNotification(message, true)
      }
      // 与父仓库 CodexRuntimeAdapter 一致：监听器必须先于 turn/start 注册，
      // 否则响应前到达的 turn/started 或文本通知也会丢失。
      const removeNotificationListener = rpc.addNotificationListener(onNotification)
      const onAbort = (): void => {
        terminalReason = 'cancel'
        eventQueue.close()
      }
      if (input.signal?.aborted) onAbort()
      else input.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await this.startTurn(session, input)
        // turn/start 可能因上下文超限内部触发 compact；压缩事件在重试成功后
        // 仍需先交给公共投影器，不能留在驱动的暂存队列里。
        yield* drainCompactionEvents(session)
        const responseTurnId = readTurnId(response)
        if (responseTurnId !== null) {
          activeTurnId = responseTurnId
          session.turnId = responseTurnId
        }
        turnStartResolved = true
        // 响应前缓存的通知可能来自 thread/resume 的旧历史。没有 turnId 的事件
        // 无法证明属于本次回合，因此只能丢弃；有明确 turnId 的事件仍按原有规则处理。
        for (const message of notificationsBeforeTurnStart.splice(0)) acceptNotification(message, false)
        // 某些 app-server 会直接在 turn/start 响应中返回终态。父仓库把它
        // 归一化成 turn/completed，这里复用同一规则，避免永久等待通知。
        const responseTerminal = buildCodexCompletionNotification(response, session.threadId)
        if (responseTerminal !== null) onNotification(responseTerminal)

        for await (const message of eventQueue.iterable) {
          const rawChunk = codexMessageToChunk(message)
          if (rawChunk === null) continue
          for (const chunk of expandCodexCompactionChunk(session, rawChunk)) {
            if (chunk.type !== 'finish') sawMeaningfulEvent = true
            yield stabilizeCodexEvent(session, chunk)
          }
        }
        if (input.signal?.aborted) await this.interrupt(input.sessionId)
      } catch (error) {
        if (!input.signal?.aborted) throw error
        await this.interrupt(input.sessionId)
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
        removeNotificationListener()
        eventQueue.close()
      }
      // 终态 chunk 之后调用方不会再拉动本迭代器，turnId 必须在产出 finish
      // 前复位，否则下一轮 steer/interrupt 会指向已经结束的 turn。
      session.turnId = null
      const danglingCompaction = closeDanglingAutoCompaction(session)
      if (danglingCompaction !== undefined) yield stabilizeCodexEvent(session, danglingCompaction)
      if (!input.signal?.aborted && terminalReason !== 'cancel' && !sawMeaningfulEvent) {
        yield { type: 'text-delta', text: 'CODINGNS_PROVIDER_EMPTY_RESPONSE: Codex Provider 未返回任何有效事件。' }
        yield { type: 'finish', reason: 'error' }
      } else {
        yield { type: 'finish', reason: input.signal?.aborted ? 'cancel' : terminalReason ?? 'stop' }
      }
    } finally { /* app-server 在会话结束前保持连接。 */ }
  }

  /**
   * 将一个 Codex turn 按 assistant item 切成多个 DSH step。
   *
   * DSH 的 step 边界只能由 Agent Loop 提交；这里仅提前结束本次 llm/stream，
   * 保留同一个 Codex turn 的通知队列，下一次 llm/stream 再继续消费它。
   */
  private async *executeSegmentedTurn(input: CodingNsCliTurnInput, command: string): AsyncIterable<CodingNsAgentEvent> {
    const session = await this.getSession(input, command)
    prepareCodexSession(session, input)
    const rpc = session.rpc
    let active: CodexSegmentedTurn | undefined
    try {
      if (session.threadId === '') {
        const threadParams = codexThreadParams(input)
        const thread = input.providerSessionId
          ? await rpc.request('thread/resume', { threadId: input.providerSessionId, ...threadParams }, { signal: input.signal, killOnAbort: false })
          : await rpc.request('thread/start', threadParams, { signal: input.signal, killOnAbort: false })
        session.threadId = readId(thread) ?? input.providerSessionId ?? input.sessionId
        session.providerSessionId = session.threadId
        session.threadModelId = readThreadModel(thread)
      }
      // 只有 Host 显式声明续段时才复用挂起的 Provider 运行。新用户回合、注入
      // 失败或取消后的下一次执行必须丢弃旧段：旧段要么已经跑完，要么其队列
      // 已关闭，复用只会立刻产出 stop，把新消息变成空回合。
      const suspended = input.resumeSegmentedTurn === true
        && session.segmentedTurn !== undefined
        && !session.segmentedTurn.done
        ? session.segmentedTurn
        : undefined
      if (suspended === undefined && session.segmentedTurn !== undefined) {
        this.closeSegmentedTurn(session, session.segmentedTurn)
      }
      // 分段 step 仍属于同一个 Provider turn；恢复它时不能插入 compact turn，
      // 也不能改写线程模型（同一个 Provider turn 中途换模型会被 Codex 拒绝）。
      const hasSuspendedTurn = suspended !== undefined
      if (!hasSuspendedTurn) await this.alignThreadModel(session, input)
      if (!hasSuspendedTurn) await this.ensureContextCapacity(session, input)
      if (!hasSuspendedTurn) yield* drainCompactionEvents(session)
      active = suspended ?? await this.startSegmentedTurn(session, input)
      yield* drainCompactionEvents(session)
      const isNew = suspended === undefined
      if (isNew) session.segmentedTurn = active
      if (isNew) yield { type: 'session-binding', providerSessionId: session.providerSessionId }

      for await (const chunk of this.consumeSegment(session, active, input)) yield chunk
      if (active.done && session.segmentedTurn === active) session.segmentedTurn = undefined
    } catch (error) {
      if (active !== undefined && !active.done) this.closeSegmentedTurn(session, active)
      if (!input.signal?.aborted) throw error
      await this.interrupt(input.sessionId)
    }
  }

  private async startSegmentedTurn(
    session: CodexSession,
    input: CodingNsCliTurnInput,
  ): Promise<CodexSegmentedTurn> {
    const eventQueue = createCodexTurnEventQueue()
    let activeTurnId: string | null = null
    let turnStartResolved = false
    const notificationsBeforeTurnStart: JsonRpcMessage[] = []
    const active: CodexSegmentedTurn = {
      queue: eventQueue,
      removeNotificationListener: () => undefined,
      terminalReason: null,
      done: false,
      pendingChunk: undefined,
      currentAssistantMessageId: undefined,
      sawCompletedTool: false,
      removeAbortListener: () => undefined,
    }
    const acceptNotification = (message: JsonRpcMessage, allowUnidentifiedTool: boolean): void => {
      if (isCodexCompactionNotification(message, session.threadId)) {
        const notificationTurnId = readTurnId(message)
        // 显式 thread/compact/start 由 waitForCompaction 独占消费通知并生成
        // start/summary/end，当前分段 turn 不能再次投影同一组事件。
        if (!session.suppressCompactionNotifications
          && (notificationTurnId === null || !session.suppressedCompactionTurnIds.has(notificationTurnId))) eventQueue.push(message)
        return
      }
      if (!isCodexNotificationForTurn(message, session.threadId, activeTurnId, allowUnidentifiedTool)) return
      const turnId = readTurnId(message)
      if (turnId !== null) {
        activeTurnId = turnId
        session.turnId = turnId
      }
      eventQueue.push(message)
      const reason = readCodexTerminalReason(message)
      if (reason !== null) {
        active.terminalReason = reason
        eventQueue.close()
      }
    }
    const onNotification = (message: JsonRpcMessage): void => {
      if (!turnStartResolved) {
        notificationsBeforeTurnStart.push(message)
        return
      }
      acceptNotification(message, true)
    }
    active.removeNotificationListener = session.rpc.addNotificationListener(onNotification)
    const onAbort = (): void => {
      active.terminalReason = 'cancel'
      eventQueue.close()
    }
    active.removeAbortListener = () => input.signal?.removeEventListener('abort', onAbort)
    if (input.signal?.aborted) onAbort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await this.startTurn(session, input)
      const responseTurnId = readTurnId(response)
      if (responseTurnId !== null) {
        activeTurnId = responseTurnId
        session.turnId = responseTurnId
      }
      turnStartResolved = true
      for (const message of notificationsBeforeTurnStart.splice(0)) acceptNotification(message, false)
      const responseTerminal = buildCodexCompletionNotification(response, session.threadId)
      if (responseTerminal !== null) onNotification(responseTerminal)
      return active
    } catch (error) {
      this.closeSegmentedTurn(session, active)
      throw error
    }
  }

  private async *consumeSegment(session: CodexSession, active: CodexSegmentedTurn, input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    while (true) {
      let chunk: CodingNsAgentEvent | null
      if (active.pendingChunk !== undefined) {
        chunk = active.pendingChunk
        active.pendingChunk = undefined
      } else {
        const next = await active.queue.next()
        if (next.done) {
          if (input.signal?.aborted) throw new Error('请求已取消')
          active.done = true
          session.turnId = null
          // finish 是调用方看到的最后一个 chunk，之后不会再拉动本迭代器。
          // 悬挂段必须在产出终态前解除，否则它会被当成下一轮的可续段复用。
          if (session.segmentedTurn === active) session.segmentedTurn = undefined
          active.removeAbortListener()
          active.removeNotificationListener()
          const danglingCompaction = closeDanglingAutoCompaction(session)
          if (danglingCompaction !== undefined) yield stabilizeCodexEvent(session, danglingCompaction)
          yield { type: 'finish', reason: active.terminalReason ?? 'stop' }
          return
        }
        if (input.signal?.aborted) throw new Error('请求已取消')
        chunk = codexMessageToChunk(next.value)
      }
      if (chunk === null) continue

      for (const part of expandCodexCompactionChunk(session, chunk)) {
        // 一个 assistant item 可能在多个工具调用之间切换。把新 item 的首个
        // 正文留给下一次 llm/stream，当前流只返回边界，确保 DSH 先创建新 step。
        if ((part.type === 'text-delta' || part.type === 'reasoning-delta')
          && part.messageId !== undefined) {
          const previousMessageId = active.currentAssistantMessageId
          if (previousMessageId !== undefined
            && previousMessageId !== part.messageId
            && active.sawCompletedTool) {
            active.pendingChunk = part
            active.currentAssistantMessageId = part.messageId
            active.sawCompletedTool = false
            yield { type: 'step-boundary' }
            return
          }
          active.currentAssistantMessageId = part.messageId
        }
        const stabilizedChunk = stabilizeCodexEvent(session, part)
        if (stabilizedChunk.type === 'tool-event' && (stabilizedChunk.status === 'completed' || stabilizedChunk.status === 'failed')) {
          active.sawCompletedTool = true
        }
        yield stabilizedChunk
      }
    }
  }

  private closeSegmentedTurn(session: CodexSession, active: CodexSegmentedTurn): void {
    active.done = true
    active.removeAbortListener()
    active.removeNotificationListener()
    active.queue.close()
    if (session.segmentedTurn === active) session.segmentedTurn = undefined
  }

  /**
   * 让线程真正生效的模型与 DSH 当前选择的模型保持一致。
   *
   * Codex 只在 `thread/start` 时决定线程模型，同一 app-server 进程内再次
   * `thread/resume` 不会改写已持久化的模型。用户在 DSH 里切换模型后，如果不
   * 显式纠正，后续 turn 仍会沿用旧模型；而线程一旦被写入错误模型（例如历史
   * 路由把 DSH 主模型泄漏给 Codex），会话就会持续以 404 失败且无法自愈。
   * 这里只在两者确实不同时下发一次纠正，避免每个 step 都产生额外 RPC。
   */
  private async alignThreadModel(session: CodexSession, input: CodingNsCliTurnInput): Promise<void> {
    if (session.threadId === '' || session.threadModelCorrectionUnsupported) return
    const desired = isProviderDefaultModel(input.modelId) ? undefined : input.modelId?.trim()
    if (desired === undefined || desired === '') return
    if (session.threadModelId === desired) return
    try {
      const response = await session.rpc.request(
        'thread/settings/update',
        { threadId: session.threadId, model: desired },
        { signal: input.signal, killOnAbort: false },
      )
      session.threadModelId = readThreadModel(response) ?? desired
    } catch (error) {
      // 旧版 Codex 可能没有该方法；纠正失败不能阻断本轮，模型仍由 turn 自身决定。
      // 只有“方法不存在”才永久关闭纠正，避免网络类瞬时失败让会话再也无法换模型。
      if (isMethodNotFound(error)) session.threadModelCorrectionUnsupported = true
    }
  }

  /** 在下一轮开始前主动压缩，避免把已满的线程直接交给 turn/start。 */
  private async ensureContextCapacity(session: CodexSession, input: CodingNsCliTurnInput): Promise<void> {
    if (session.contextWindow === undefined || session.contextTokens === undefined) return
    // 达到窗口上限时下一轮还会追加用户输入，必须在 turn/start 前压缩；
    // 只用严格大于会把恰好满窗的会话直接送进超限错误路径。
    if (session.contextTokens < session.contextWindow * CODEX_COMPACTION_THRESHOLD) return
    await this.compactThread(session, input)
  }

  /** turn/start 遇到上下文超限时压缩一次并重试，兼容关闭自动压缩的 Codex 配置。 */
  private async startTurn(session: CodexSession, input: CodingNsCliTurnInput): Promise<unknown> {
    try {
      return await session.rpc.request('turn/start', codexTurnStartParams(input, session.threadId), { signal: input.signal, killOnAbort: false })
    } catch (error) {
      if (!isContextWindowError(error)) throw error
      await this.compactThread(session, input)
      return session.rpc.request('turn/start', codexTurnStartParams(input, session.threadId), { signal: input.signal, killOnAbort: false })
    }
  }

  /** thread/compact/start 立即返回，真正完成由 contextCompaction turn 的终态通知表示。 */
  private async compactThread(session: CodexSession, input: CodingNsCliTurnInput): Promise<void> {
    if (session.compacting !== undefined) return session.compacting
    // 在创建异步等待器前同步设置，避免多个 RPC 监听器交错处理同一批通知时
    // 另一个监听器重复投影显式压缩事件。
    session.suppressCompactionNotifications = true
    const compacting = this.waitForCompaction(session, input)
    session.compacting = compacting
    try {
      await compacting
      session.contextTokens = 0
    } finally {
      if (session.compacting === compacting) session.compacting = undefined
      session.suppressCompactionNotifications = false
    }
  }

  private async waitForCompaction(session: CodexSession, input: CodingNsCliTurnInput): Promise<void> {
    const compactionId = `codex-compaction-${randomUUID()}`
    session.pendingCompactionEvents.push({ type: 'context-compaction', phase: 'start', compactionId })
    let compactTurnId: string | null = null
    let sawCompaction = false
    let summary: string | undefined
    let shadowedTokenCount: number | undefined
    let shadowedItemCount: number | undefined
    let resolveDone: (() => void) | undefined
    let rejectDone: ((error: Error) => void) | undefined
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
    const onNotification = (message: JsonRpcMessage): void => {
      const params = isRecord(message.params) ? message.params : null
      if (readScopedId(params, ['threadId', 'thread_id'], 'thread') !== session.threadId) return
      if (message.method === 'thread/compacted') {
        const details = compactionDetails(params)
        summary = details.summary ?? summary
        shadowedTokenCount = details.shadowedTokenCount ?? shadowedTokenCount
        shadowedItemCount = details.shadowedItemCount ?? shadowedItemCount
        resolveDone?.()
        return
      }
      if (message.method === 'item/started') {
        const item = isRecord(params?.item) ? params.item : null
        if (isCodexCompactionItemType(item?.type)) {
          sawCompaction = true
          compactTurnId = readTurnId(message)
          if (compactTurnId !== null) session.suppressedCompactionTurnIds.add(compactTurnId)
        }
        return
      }
      if (message.method === 'item/completed') {
        const item = isRecord(params?.item) ? params.item : null
        if (isCodexCompactionItemType(item?.type)) {
          const itemTurnId = readTurnId(message)
          if (itemTurnId !== null) session.suppressedCompactionTurnIds.add(itemTurnId)
          const details = compactionDetails(item)
          summary = details.summary ?? summary
          shadowedTokenCount = details.shadowedTokenCount ?? shadowedTokenCount
          shadowedItemCount = details.shadowedItemCount ?? shadowedItemCount
        }
        return
      }
      if (message.method !== 'turn/completed') return
      const turnId = readTurnId(message)
      if (sawCompaction && compactTurnId !== null && turnId !== compactTurnId) return
      if (!sawCompaction && compactTurnId === null) return
      const turn = isRecord(params?.turn) ? params.turn : null
      if (turn?.status === 'failed' || turn?.status === 'interrupted' || turn?.status === 'cancelled') {
        rejectDone?.(new Error('Codex 上下文压缩失败'))
      } else {
        resolveDone?.()
      }
    }
    const removeListener = session.rpc.addNotificationListener(onNotification)
    const timer = setTimeout(() => rejectDone?.(new Error('Codex 上下文压缩超时')), CODEX_COMPACTION_TIMEOUT_MS)
    timer.unref?.()
    try {
      await session.rpc.request('thread/compact/start', { threadId: session.threadId }, { signal: input.signal, killOnAbort: false })
      await done
      if (summary !== undefined || shadowedTokenCount !== undefined || shadowedItemCount !== undefined) {
        // Codex 的 app-server 通知通常不携带被压缩 token 数。DSH 的
        // contextPressure 必须用该数扣除已被替换的 surface；这里使用压缩前
        // 最后一次 Provider prompt 规模作为保守锚点，不能把缺失值写成 0。
        const resolvedShadowedTokenCount = shadowedTokenCount ?? session.contextTokens
        session.pendingCompactionEvents.push({
          type: 'context-compaction',
          phase: 'summary',
          compactionId,
          ...(summary === undefined ? {} : { summary }),
          ...(resolvedShadowedTokenCount === undefined ? {} : { shadowedTokenCount: resolvedShadowedTokenCount }),
          ...(shadowedItemCount === undefined ? {} : { shadowedItemCount }),
        })
      }
      session.pendingCompactionEvents.push({ type: 'context-compaction', phase: 'end', compactionId })
    } catch (error) {
      session.pendingCompactionEvents.push({
        type: 'context-compaction',
        phase: 'end',
        compactionId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      clearTimeout(timer)
      removeListener()
    }
  }

  /** 将新输入 steer 到当前 Codex turn。 */
  async steer(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.threadId === '' || session.turnId === null) throw new Error('Codex 会话未运行')
    const result = await session.rpc.request('turn/steer', { threadId: session.threadId, turnId: session.turnId, input: [{ type: 'text', text: prompt }] }, { killOnAbort: false })
    const turnId = readId(result)
    if (turnId) session.turnId = turnId
  }

  /** 中断当前 Codex turn，但保留 app-server 线程。 */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.threadId === '' || session.turnId === null) return
    try { await session.rpc.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }, { killOnAbort: false }) }
    catch { /* app-server 可能已经发出 turn/completed */ }
  }

  /**
   * 丢弃等待下一个 DSH step 的分段运行（取消、注入失败或切换适配器时）。
   * 队列关闭后旧回合的通知不会再被投影进下一轮，续段标记同时解除。
   */
  discardSegmentedTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session?.segmentedTurn === undefined) return
    this.closeSegmentedTurn(session, session.segmentedTurn)
  }

  /** 回传原生权限请求；审批值只在 Host 进程中流转。 */
  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const session = this.sessions.get(sessionId)
    const pending = session?.pendingPermissions.get(response.requestId)
    if (pending === undefined || session === undefined) throw new Error('Codex 权限请求不存在')
    session.pendingPermissions.delete(response.requestId)
    if (pending.response === 'file-change') {
      pending.resolve({ decision: response.approved ? 'accept' : 'decline' })
    } else if (pending.response === 'command') {
      pending.resolve({ decision: response.approved ? 'accept' : 'decline' })
    } else if (pending.response === 'permissions') {
      // `item/permissions/requestApproval` 的应答形状是 {permissions, scope}，
      // 不是 {approved}。批准回显请求画像；拒绝给空画像，语义等价于“不授予额外权限”。
      pending.resolve(response.approved
        ? { permissions: grantedPermissionProfile(pending.requested), scope: 'turn' }
        : { permissions: {}, scope: 'turn' })
    } else {
      pending.resolve({
        approved: response.approved,
        ...(response.reason?.trim() ? { reason: response.reason.trim().slice(0, 512) } : {}),
      })
    }
  }

  /** 回传 requestUserInput 的结构化回答。 */
  respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): void {
    const session = this.sessions.get(sessionId)
    const resolve = session?.pendingQuestions.get(response.requestId)
    if (resolve === undefined || session === undefined) throw new Error('Codex 问题请求不存在')
    session.pendingQuestions.delete(response.requestId)
    resolve({ answers: questionAnswersRecord(response) })
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.segmentedTurn !== undefined) this.closeSegmentedTurn(session, session.segmentedTurn)
      for (const pending of session.pendingPermissions.values()) pending.resolve({ approved: false })
      session.pendingPermissions.clear()
      for (const resolve of session.pendingQuestions.values()) resolve({ answers: {} })
      session.pendingQuestions.clear()
      session.rpc.dispose()
    }
    this.sessions.clear()
    this.processes.clear()
    this.cachedBinary = null
  }

  private async getSession(input: CodingNsCliTurnInput, command: string) {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd) return previous
    if (previous?.segmentedTurn !== undefined) this.closeSegmentedTurn(previous, previous.segmentedTurn)
    previous?.rpc.dispose()
    // 子代理托管开启时用 `-c` 覆盖注入 MCP 替身工具；工具由桥接转投成 DSH 原生子会话。
    const bridgeArgs = codexBridgeArgs(input.sessionId, this.descriptor.id)
    const rpc = new JsonRpcProcess({ command, args: [...CODEX_APP_SERVER_ARGS, ...bridgeArgs], cwd: input.cwd, spawn: this.runSpawn })
    const session = {
      rpc,
      cwd: input.cwd,
      modelId: input.modelId,
      contextWindow: undefined as number | undefined,
      contextTokens: undefined as number | undefined,
      threadId: '',
      threadModelId: undefined as string | undefined,
      threadModelCorrectionUnsupported: false,
      turnId: null as string | null,
      providerSessionId: input.providerSessionId ?? input.sessionId,
      pendingPermissions: new Map<string, PendingCodexPermission>(),
      pendingQuestions: new Map<string, (value: unknown) => void>(),
      segmentedTurn: undefined as CodexSegmentedTurn | undefined,
      compacting: undefined as Promise<void> | undefined,
      suppressCompactionNotifications: false,
      suppressedCompactionTurnIds: new Set<string>(),
      pendingCompactionEvents: [] as CodingNsAgentEvent[],
      autoCompaction: undefined as CodexSession['autoCompaction'],
    }
    this.processes.add(rpc)
    this.sessions.set(input.sessionId, session)
    await rpc.request('initialize', { clientInfo: { name: 'codingns4dsh', version: '0.1.1' }, capabilities: { experimentalApi: true } }, { signal: input.signal, killOnAbort: false })
    rpc.notify('initialized', {})
    rpc.setServerRequestHandler((request) => {
      const requestId = readRequestId(request)
      if (requestId === null) return { approved: false }
      const params = isRecord(request.params) ? request.params : request
      const item = isRecord(params.item) ? params.item : params
      const method = typeof request.method === 'string' ? request.method : ''
      const type = typeof item.type === 'string' ? item.type : ''
      // 动态工具服务端请求要求客户端执行任意工具。
      // DSH 适配器只负责观察 Codex 已执行的工具，不具备安全执行任意动态工具
      // 的能力；必须显式回绝请求，不能把它挂进权限等待表，否则 Provider 会永久等待。
      if (method === ['item', 'tool', 'call'].join('/')) {
        return {
          success: false,
          contentItems: [{ type: 'inputText', text: 'CodingNS 不支持由 Codex 反向调用动态工具' }],
        }
      }
      if (isQuestionEvent(`${method} ${type}`)) {
        return new Promise<unknown>((resolve) => session.pendingQuestions.set(requestId, resolve))
      }
      const kind = permissionResponseKind(method, params)
      return new Promise<unknown>((resolve) => session.pendingPermissions.set(requestId, {
        resolve,
        response: kind,
        ...(kind === 'permissions' ? { requested: params.permissions } : {}),
      }))
    })
    return session
  }
}

function stabilizeCodexUsage(session: CodexSession, event: CodingNsAgentEvent): CodingNsAgentEvent {
  if (event.type !== 'usage') return event
  if (event.contextTokens !== undefined) session.contextTokens = event.contextTokens
  if (event.contextWindow === undefined) return event
  if (session.contextWindow === undefined) {
    session.contextWindow = event.contextWindow
    return event
  }
  if (session.contextWindow === event.contextWindow) return event
  // 同一 Codex thread/model 的 usage 通知可能带有全局默认窗口或迟到旧值。
  // 它不能覆盖首个已确认窗口，否则 DSH 会把 256K 错显示成 1M，并跳过压缩。
  const contextTokens = event.contextTokens ?? event.inputTokens
  return {
    ...event,
    contextWindow: session.contextWindow,
    contextTokens,
    contextUsageRatio: Number(Math.min(1, contextTokens / session.contextWindow).toFixed(6)),
  }
}

function stabilizeCodexEvent(session: CodexSession, event: CodingNsAgentEvent): CodingNsAgentEvent {
  if (event.type !== 'context-compaction') return stabilizeCodexUsage(session, event)

  // 自动压缩的 item 通知没有独立 usage。压缩结束后清零本地状态，避免下一轮
  // 把压缩前的旧 prompt 规模误认为当前上下文并再次发起压缩。
  if (event.phase === 'end') {
    session.contextTokens = 0
    return event
  }

  if (event.phase !== 'summary' || event.shadowedTokenCount !== undefined || session.contextTokens === undefined) return event
  return { ...event, shadowedTokenCount: session.contextTokens }
}

function prepareCodexSession(session: CodexSession, input: CodingNsCliTurnInput): void {
  // 未提供 modelId 表示沿用当前 Codex thread 的模型，不能因为配置字段缺省
  // 就把已经确认的上下文容量清空。
  if (input.modelId === undefined || session.modelId === input.modelId) return
  // 模型切换意味着上下文容量可能改变；只有这类明确路由变化才允许重置
  // 稳定窗口，同一模型的迟到 usage 不能触发重置。
  session.modelId = input.modelId
  session.contextWindow = undefined
}

function parseCodexCatalog(value: unknown): CodingNsCliModelCatalog {
  const root = isRecord(value) && isRecord(value.data) ? value.data : value
  const models = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.models) ? root.models
      : isRecord(root) && Array.isArray(root.data) ? root.data
        : []
  const items = models.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (entry.hidden === true) return []
    const id = typeof entry.model === 'string' ? entry.model.trim() : typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) return []
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? [...new Set(entry.supportedReasoningEfforts.flatMap((item) => {
          const effort = typeof item === 'string'
            ? item
            : isRecord(item) && typeof item.reasoningEffort === 'string'
              ? item.reasoningEffort
              : null
          return effort?.trim() ? [effort.trim()] : []
        }))]
      : []
    return [{
      id,
      name: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName : id,
      efforts,
    }]
  })
  if (items.length === 0) return emptyCatalog()
  return {
    groups: [{ id: 'codex', name: 'Codex', models: [...new Map(items.map((item) => [item.id, item])).values()] }],
    currentModel: null,
    currentEffort: null,
  }
}

function codexMessageToChunk(message: Record<string, any>): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const item = isRecord(params.item) ? params.item : params
  const method = typeof message.method === 'string' ? message.method : ''
  const type = typeof item.type === 'string' ? item.type : ''
  const text = textValue(params.delta ?? params.text ?? params.content ?? params.message)
  if (isCodexCompactionItemType(type)) {
    const details = compactionDetails(item)
    const compactionId = firstToolText(item.id, params.itemId)
    const phase = method === 'thread/compacted'
      ? 'end'
      : method.includes('started') || method.includes('start')
      ? 'start'
      : method.includes('completed') || method.includes('compacted') || method.includes('summary')
        ? 'summary'
        : 'end'
    return {
      type: 'context-compaction',
      phase,
      ...(compactionId === undefined ? {} : { compactionId }),
      ...(details.summary === undefined ? {} : { summary: details.summary }),
      ...(details.shadowedTokenCount === undefined ? {} : { shadowedTokenCount: details.shadowedTokenCount }),
      ...(details.shadowedItemCount === undefined ? {} : { shadowedItemCount: details.shadowedItemCount }),
    }
  }
  if (method === 'thread/compacted') {
    const details = compactionDetails(params)
    return {
      type: 'context-compaction',
      phase: 'end',
      ...(details.summary === undefined ? {} : { summary: details.summary }),
      ...(details.shadowedTokenCount === undefined ? {} : { shadowedTokenCount: details.shadowedTokenCount }),
      ...(details.shadowedItemCount === undefined ? {} : { shadowedItemCount: details.shadowedItemCount }),
    }
  }
  if (method === 'turn/completed' && isContextCompactionTurn(params.turn)) {
    const compactionId = readTurnId(message)
    return { type: 'context-compaction', phase: 'end', ...(compactionId === null ? {} : { compactionId }) }
  }
  if (isQuestionEvent(`${method} ${type}`)) {
    const requestId = readRequestId(message) ?? readRequestId(params)
    const questions = readAgentQuestions(params.questions ?? item.questions ?? params)
    if (requestId !== null && questions.length > 0) return { type: 'question-request', requestId, questions }
  }
  if (method.includes('permission') || method.includes('Approval') || type.includes('permission') || type.includes('approval')) {
    const requestId = readRequestId(message) ?? readRequestId(params)
    const permission = codexPermissionDetails(method, params, item)
    const detail = permission.detail ?? text ?? undefined
    if (requestId !== null) return {
      type: 'permission-request',
      requestId,
      kind: permission.kind,
      ...(permission.toolName === undefined ? {} : { toolName: permission.toolName }),
      ...(permission.callId === undefined ? {} : { callId: permission.callId }),
      ...(detail === undefined ? {} : { detail }),
    }
  }
  const messageId = firstToolText(params.itemId, item.id)
  if (method.includes('agentMessage') || method.includes('message') && (type.includes('text') || type === '')) {
    return text ? { type: 'text-delta', text, ...(messageId === undefined ? {} : { messageId }) } : null
  }
  if (method.includes('reason') || type.includes('reason')) {
    return text ? { type: 'reasoning-delta', text, ...(messageId === undefined ? {} : { messageId }) } : null
  }
  if (isCodexToolEvent(method, type)) {
    const name = firstToolText(
      isFileChangeType(type) ? 'edit_file' : undefined,
      item.name,
      item.toolName,
      item.tool,
      item.command !== undefined ? 'command_execution' : undefined,
      type,
    )
    const callId = firstToolText(item.callId, item.call_id, item.toolCallId, item.id, params.itemId)
    const agentId = firstToolText(item.agentId, item.agent_id, type.includes('agent') || type.includes('collab') ? item.id : undefined)
    const input = serializeToolValue(isFileChangeType(type) ? fileChangeToolInput(item) : item.arguments ?? item.input ?? item.command)
    const rawOutput = item.result ?? item.output ?? item.aggregated_output
    const explicitError = serializeToolValue(item.error)
    const output = serializeToolValue(rawOutput)
    const exitCodeFailed = typeof item.exitCode === 'number' && item.exitCode !== 0 || typeof item.exit_code === 'number' && item.exit_code !== 0
    const failed = explicitError !== undefined || exitCodeFailed || method.includes('failed') || normalizeToolStatus(item.status ?? item.state, 'running') === 'failed'
    const fallback = failed ? 'failed' : method.includes('completed') || output !== undefined ? 'completed' : 'running'
    const detail = serializeToolValue(item.detail ?? item.description)
    return {
      type: 'tool-event',
      toolName: name ?? (agentId ? 'subagent' : 'tool'),
      status: normalizeToolStatus(item.status ?? item.state, fallback),
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(failed
        ? { error: explicitError ?? output ?? `exit code ${String(item.exitCode ?? item.exit_code)}` }
        : output === undefined ? {} : { output }),
      ...(!failed && output !== undefined ? { outputMode: 'snapshot' as const } : {}),
      ...(agentId ? { agentId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }
  return codexUsageChunk(params)
}

function* drainCompactionEvents(session: CodexSession): Generator<CodingNsAgentEvent> {
  while (session.pendingCompactionEvents.length > 0) {
    const event = session.pendingCompactionEvents.shift()
    if (event !== undefined) yield event
  }
}

/**
 * 把自动压缩的 item 生命周期展开成闭合的 start/summary/end 事务。
 *
 * Codex 0.158 起，压缩只通过 contextCompaction item 的 started/completed 通知
 * 发布，`thread/compacted`（ContextCompactedNotification）已废弃且不再发送。
 * 而 DSH 会话格式要求每个 compaction/start 必须由 compaction/end 闭合，否则
 * 历史加载会以 "turn/end crosses an open compaction" 失败。这里在 item/completed
 * 之后合成 end，同时兼容旧版 Codex 仍会发送的 thread/compacted 完成信号。
 */
function* expandCodexCompactionChunk(session: CodexSession, chunk: CodingNsAgentEvent): Generator<CodingNsAgentEvent> {
  if (chunk.type !== 'context-compaction') {
    yield chunk
    return
  }
  if (chunk.phase === 'start') {
    if (session.autoCompaction?.open === true && session.autoCompaction.compactionId === chunk.compactionId) {
      yield chunk
      return
    }
    session.autoCompaction = { compactionId: chunk.compactionId, open: true }
    yield chunk
    return
  }
  if (chunk.phase === 'summary') {
    yield chunk
    const pending = session.autoCompaction
    if (pending !== undefined && pending.open) {
      pending.open = false
      yield {
        type: 'context-compaction',
        phase: 'end',
        ...(chunk.compactionId === undefined ? {} : { compactionId: chunk.compactionId }),
      }
    }
    return
  }
  const pending = session.autoCompaction
  if (pending !== undefined) {
    if (pending.open) {
      // item/started 之后直接收到完成信号（旧版 Codex 的 thread/compacted）：
      // 由该信号闭合事务。
      pending.open = false
      yield chunk
    }
    // 已经由 item/completed 合成过 end 的重复完成信号不再下发；桥接层虽然
    // 对重复 end 幂等，但重复通知没有新的语义。
    return
  }
  yield chunk
}

/** 流终结时为未收到完成通知的自动压缩补一个 end，避免会话日志残留未闭合事务。 */
function closeDanglingAutoCompaction(session: CodexSession): CodingNsAgentEvent | undefined {
  const pending = session.autoCompaction
  if (pending === undefined || !pending.open) return undefined
  session.autoCompaction = undefined
  return {
    type: 'context-compaction',
    phase: 'end',
    ...(pending.compactionId === undefined ? {} : { compactionId: pending.compactionId }),
  }
}

interface CodexCompactionDetails {
  readonly summary?: string
  readonly shadowedTokenCount?: number
  readonly shadowedItemCount?: number
}

function compactionDetails(value: unknown): CodexCompactionDetails {
  if (!isRecord(value)) return {}
  const nested = isRecord(value.compaction) ? value.compaction : isRecord(value.item) ? value.item : value
  const summary = textValue(nested.summary ?? nested.summaryText ?? nested.compactionSummary)
  const shadowedTokenCount = optionalToken(nested.shadowedTokenCount ?? nested.shadowed_tokens ?? nested.compactedTokens)
  const shadowedItemCount = optionalToken(nested.shadowedItemCount ?? nested.shadowed_items ?? nested.compactedItems)
  return {
    ...(summary === null || summary.trim() === '' ? {} : { summary: summary.trim() }),
    ...(shadowedTokenCount === undefined ? {} : { shadowedTokenCount }),
    ...(shadowedItemCount === undefined ? {} : { shadowedItemCount }),
  }
}

function isContextCompactionTurn(value: unknown): boolean {
  if (!isRecord(value)) return false
  const kind = String(value.type ?? value.kind ?? value.name ?? '').toLowerCase()
  return kind.includes('contextcompaction') || kind.includes('compaction')
}

interface CodexPermissionDetails {
  readonly kind: string
  readonly toolName?: string
  readonly callId?: string
  readonly detail?: string
}

function codexPermissionDetails(method: string, params: Record<string, any>, item: Record<string, any>): CodexPermissionDetails {
  const fileChange = method.includes('fileChange') || method.includes('file_change') || String(item.type ?? '').toLowerCase() === 'filechange'
  // 沙箱提权请求没有 command/grantRoot，只有一个待授予的权限画像；
  // 必须把画像摘要带进 detail，否则审批弹窗只会显示一个空理由。
  const permissions = method.includes('permissions') && method.includes('Approval') ? params.permissions : undefined
  const command = typeof params.command === 'string' ? params.command : typeof item.command === 'string' ? item.command : undefined
  const reason = typeof params.reason === 'string' ? params.reason : typeof params.description === 'string' ? params.description : undefined
  const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : undefined
  const paths = permissionPaths(params.fileChanges ?? params.file_changes ?? item.changes)
  const callId = firstToolText(params.callId, params.call_id, params.itemId, item.id)
  const detail = [reason, command, paths.length > 0 ? `文件: ${paths.join(', ')}` : undefined, grantRoot ? `允许写入: ${grantRoot}` : undefined, permissionProfileSummary(permissions)]
    .filter((value): value is string => value !== undefined && value.trim() !== '')
    .join('；')
  return {
    kind: permissions !== undefined ? 'permissions' : typeof params.kind === 'string' ? params.kind : fileChange ? 'file_change' : 'command',
    ...(fileChange ? { toolName: 'edit' } : {}),
    ...(callId === undefined ? {} : { callId }),
    ...(detail === '' ? {} : { detail }),
  }
}

/** 把权限画像压成一句可读摘要；未知形状返回 undefined，不猜测语义。 */
function permissionProfileSummary(value: unknown): string | undefined {
  const profile = isRecord(value) ? value : null
  if (profile === null) return undefined
  const fileSystem = isRecord(profile.fileSystem) ? profile.fileSystem : null
  const network = isRecord(profile.network) ? profile.network : null
  const parts: string[] = []
  const write = stringList(fileSystem?.write)
  const read = stringList(fileSystem?.read)
  if (write.length > 0) parts.push(`请求写入: ${write.join(', ')}`)
  if (read.length > 0) parts.push(`请求读取: ${read.join(', ')}`)
  if (network?.enabled === true) parts.push('请求网络访问')
  return parts.length === 0 ? undefined : parts.join('；')
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : []
}

function permissionPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => permissionPaths(entry))
  if (!isRecord(value)) return []
  const path = firstToolText(value.path, value.filePath, value.file_path)
  return path === undefined ? [] : [path]
}

function isFileChangeType(type: string): boolean {
  return type.replace(/[_-]/gu, '').toLowerCase() === 'filechange'
}

function fileChangeToolInput(item: Record<string, any>): unknown {
  const changes = Array.isArray(item.changes) ? item.changes : []
  return {
    changes: changes.map((change) => isRecord(change) ? {
      file_path: firstToolText(change.path, change.filePath, change.file_path) ?? '',
      ...(typeof change.kind === 'string' ? { kind: change.kind } : {}),
      ...(typeof change.diff === 'string' ? { diff: change.diff } : typeof change.patch === 'string' ? { diff: change.patch } : {}),
    } : change),
  }
}

/** Codex app-server 的 inputTokens 是含缓存读取的完整输入，cachedInputTokens 是其中已命中的子集。 */
function codexUsageChunk(params: Record<string, any>): CodingNsAgentEvent | null {
  const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : isRecord(params.token_usage) ? params.token_usage : null
  if (tokenUsage === null) return usageChunk(params)
  const latest = isRecord(tokenUsage.last)
    ? tokenUsage.last
    : isRecord(tokenUsage.lastUsage)
      ? tokenUsage.lastUsage
      : isRecord(tokenUsage.last_token_usage)
        ? tokenUsage.last_token_usage
        : isRecord(tokenUsage.total)
          ? tokenUsage.total
          : tokenUsage
  const inputTokens = optionalToken(latest.inputTokens ?? latest.input_tokens)
  const cacheReadTokens = optionalToken(latest.cachedInputTokens ?? latest.cached_input_tokens)
  const usage = usageChunk({
    inputTokens: inputTokens ?? 0,
    ...(latest.outputTokens === undefined && latest.output_tokens === undefined ? {} : { outputTokens: latest.outputTokens ?? latest.output_tokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(latest.totalTokens === undefined && latest.total_tokens === undefined ? {} : { totalTokens: latest.totalTokens ?? latest.total_tokens }),
  })
  if (usage === null) return null
  if (usage.type !== 'usage') return null
  const contextWindowValue = optionalToken(
    tokenUsage.contextWindow
      ?? tokenUsage.context_window
      ?? tokenUsage.modelContextWindow
      ?? tokenUsage.model_context_window
      ?? latest.contextWindow
      ?? latest.context_window
      ?? latest.modelContextWindow
      ?? latest.model_context_window
      ?? params.contextWindow
      ?? params.context_window,
  )
  const contextWindow = contextWindowValue !== undefined && contextWindowValue > 0 ? contextWindowValue : undefined
  const contextTokens = usage.inputTokens
  return {
    ...usage,
    ...(contextWindow === undefined ? {} : {
      contextWindow,
      contextTokens,
      contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)),
    }),
  }
}

function optionalToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readRequestId(value: unknown): string | null {
  if (!isRecord(value)) return null
  for (const key of ['requestId', 'request_id', 'id']) if (typeof value[key] === 'string' || typeof value[key] === 'number') return String(value[key])
  return null
}

function readTurnId(message: unknown): string | null {
  if (!isRecord(message)) return null
  const params = isRecord(message.params) ? message.params : message
  for (const key of ['turnId', 'turn_id']) if (typeof params[key] === 'string') return params[key]
  if (isRecord(params.turn) && typeof params.turn.id === 'string') return params.turn.id
  return null
}

/**
 * 复用父仓库 CodexRuntimeAdapter 的事件队列结构：终止时先排空已入队事件，
 * 再结束异步迭代，保证 turn/completed 前到达的最后一个文本片段不会丢失。
 */
function createCodexTurnEventQueue(): CodexTurnEventQueue {
  const values: JsonRpcMessage[] = []
  const waiters: Array<(result: IteratorResult<JsonRpcMessage>) => void> = []
  let closed = false
  const next = (): Promise<IteratorResult<JsonRpcMessage>> => {
    const value = values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => waiters.push(resolve))
  }
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next,
        }
      },
    },
    next,
    push(message) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ done: false, value: message })
      else values.push(message)
    },
    close() {
      if (closed) return
      closed = true
      while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined })
    },
  }
}

/** 只接收当前 thread/turn 的事件，避免子 Agent 的完成通知提前结束父轮次。 */
function isCodexNotificationForTurn(
  message: JsonRpcMessage,
  threadId: string,
  turnId: string | null,
  allowUnidentifiedTool: boolean,
): boolean {
  const params = isRecord(message.params) ? message.params : null
  const notificationThreadId = readScopedId(params, ['threadId', 'thread_id'], 'thread')
  const notificationTurnId = readTurnId(message)
  if (notificationThreadId !== null && notificationThreadId !== threadId) return false
  // 权限/问题审批是 Codex 发起的 JSON-RPC 请求，必须先交给交互层，不能因
  // 它的 turnId 尚未出现在 turn/start 响应中而丢弃。
  if (message.id !== undefined && message.id !== null) return true
  // 响应返回前 activeTurnId 为空；带 turnId 的旧通知不能提前关闭新回合队列。
  if (turnId === null && notificationTurnId !== null) return false
  // turn/start 响应前的无 turnId 通知无法证明属于本次回合，尤其不能让迟到的
  // 无标识 turn/completed 直接关闭新回合；响应后再交给当前开放的 DSH step。
  if (notificationTurnId === null && !allowUnidentifiedTool) return false
  return turnId === null || notificationTurnId === null || notificationTurnId === turnId
}

function isCodexCompactionNotification(message: JsonRpcMessage, threadId: string): boolean {
  const params = isRecord(message.params) ? message.params : null
  if (readScopedId(params, ['threadId', 'thread_id'], 'thread') !== null
    && readScopedId(params, ['threadId', 'thread_id'], 'thread') !== threadId) return false
  if (message.method === 'thread/compacted') return true
  if (message.method !== 'item/started' && message.method !== 'item/completed') return false
  const item = isRecord(params?.item) ? params.item : null
  return isCodexCompactionItemType(item?.type)
}

function isCodexCompactionItemType(value: unknown): boolean {
  return value === 'contextCompaction' || value === 'context_compaction' || value === 'context-compaction'
}

function isContextWindowError(error: unknown): boolean {
  if (error instanceof JsonRpcRequestError) return hasContextWindowError(error.data)
  return hasContextWindowError(error)
}

/**
 * 判断 RPC 失败是否表示“服务端不认识这个方法”。
 *
 * 旧版 Codex app-server 没有 `thread/settings/update`。只有这种情况才应永久
 * 关闭模型纠正；进程退出、超时等瞬时失败必须保留重试机会，否则一次抖动就会让
 * 该会话再也无法切换模型。
 */
function isMethodNotFound(error: unknown): boolean {
  if (error instanceof JsonRpcRequestError) {
    if (error.code === -32601) return true
    const data = isRecord(error.data) ? error.data : null
    if (data?.code === -32601) return true
    return typeof data?.message === 'string' && /method\s*not\s*found|unknown method/iu.test(data.message)
  }
  if (isRecord(error) && error.code === -32601) return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /method\s*not\s*found|unknown method/iu.test(message)
}

function hasContextWindowError(value: unknown): boolean {
  if (typeof value === 'string') return /context[_-]?window[_-]?exceeded|context window exceeded/iu.test(value)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => /context.?window.?exceeded/iu.test(key) || hasContextWindowError(child))
}

function readCodexTerminalReason(message: JsonRpcMessage): 'stop' | 'cancel' | 'error' | null {
  const method = message.method ?? ''
  if (method === 'error') {
    const params = isRecord(message.params) ? message.params : null
    return params?.willRetry === true ? null : 'error'
  }
  if (!isCodexTerminalMethod(method)) return null
  const params = isRecord(message.params) ? message.params : null
  const turn = isRecord(params?.turn) ? params.turn : null
  if (turn?.status === 'failed' || hasContextWindowError(turn?.error)) return 'error'
  if (turn?.status === 'interrupted' || turn?.status === 'cancelled') return 'cancel'
  if (method === 'turn/failed' || method === 'turn/error') return 'error'
  if (method === 'turn/interrupted' || method === 'turn/cancelled' || method === 'turn/aborted') return 'cancel'
  return 'stop'
}

/** Codex 版本间曾使用不同的 turn 终态通知名，统一收敛到同一结束路径。 */
function isCodexTerminalMethod(method: string): boolean {
  return method === 'turn/completed'
    || method === 'turn/failed'
    || method === 'turn/error'
    || method === 'turn/interrupted'
    || method === 'turn/cancelled'
    || method === 'turn/aborted'
}

/** 将 turn/start 响应里的终态归一化成父仓库使用的 turn/completed 通知。 */
function buildCodexCompletionNotification(value: unknown, threadId: string): JsonRpcMessage | null {
  if (!isRecord(value) || !isRecord(value.turn)) return null
  const status = value.turn.status
  if (status !== 'completed' && status !== 'failed' && status !== 'interrupted' && status !== 'cancelled') return null
  return { method: 'turn/completed', params: { threadId, turn: value.turn } }
}

function readScopedId(value: Record<string, any> | null, keys: readonly string[], nestedKey: string): string | null {
  if (value === null) return null
  for (const key of keys) if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
  const nested = value[nestedKey]
  return isRecord(nested) && typeof nested.id === 'string' && nested.id.trim() ? nested.id.trim() : null
}

function isCodexToolEvent(method: string, type: string): boolean {
  if (method.includes('command') || method.includes('tool') || method.includes('agent')) return true
  const normalized = type.replace(/[_-]/gu, '').toLowerCase()
  return ['commandexecution', 'filechange', 'mcptoolcall', 'functioncall', 'customtoolcall', 'dynamictoolcall'].includes(normalized)
}

/**
 * `thread/start` 与 `thread/resume` 共用的线程参数。
 *
 * 权限必须在这里就与 `turn/start` 保持一致：Codex 的线程级沙箱会成为后续回合
 * 的默认值，只在 turn 上覆盖会让首次工具调用落到与 DSH 不同的模式。
 */
function codexThreadParams(input: CodingNsCliTurnInput): Record<string, unknown> {
  const developerInstructions = codexBridgeDeveloperInstructions(input.sessionId)
  return {
    cwd: input.cwd ?? process.cwd(),
    sandbox: codexSandboxMode(input),
    approvalPolicy: codexApprovalPolicy(input),
    ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}),
    ...(developerInstructions === undefined ? {} : { developerInstructions }),
  }
}

function codexTurnStartParams(input: CodingNsCliTurnInput, threadId: string): Record<string, unknown> {
  const cwd = resolve(input.cwd ?? process.cwd())
  const inputBlocks: Record<string, unknown>[] = []
  const attachments = input.attachments ?? []
  if (input.prompt.trim() !== '' || attachments.length === 0) inputBlocks.push({ type: 'text', text: input.prompt })
  for (const attachment of attachments) {
    if (attachment.kind === 'image') inputBlocks.push({ type: 'localImage', path: attachment.path })
  }
  return {
    threadId,
    input: inputBlocks,
    cwd,
    sandboxPolicy: codexSandboxPolicy(input, cwd),
    approvalPolicy: codexApprovalPolicy(input),
    ...(input.effortId ? { effort: input.effortId } : {}),
  }
}

/**
 * 由 DSH 会话权限状态派生 Codex 原生沙箱模式。
 *
 * `permission` 缺省表示 Host **还没读到**权限事实，此时沿用旧的保守默认
 * （工作区可写），不能推断为完全权限。三个字段必须来自同一份状态。
 */
function codexSandboxMode(input: CodingNsCliTurnInput): CodingNsCliSandboxMode {
  return input.permission?.sandboxMode ?? 'workspace-write'
}

function codexSandboxPolicy(input: CodingNsCliTurnInput, cwd: string): Record<string, unknown> {
  const mode = codexSandboxMode(input)
  // danger-full-access 必须映射成 Codex 自己的 bypass 形状；继续下发
  // workspaceWrite 会让 DSH 声明完全权限、Codex 实际只读，两侧语义分叉。
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  // DSH 的 workspace-write 只约束自身工具沙箱，不会自动传递给 Codex
  // app-server。显式声明当前工作区，避免 Codex 将文件编辑误判为只读越权。
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

/**
 * 由同一份权限状态派生审批策略。
 *
 * DSH 的 `never` 表示“需要审批的动作会被自动拒绝”，因此绝不能同时向 Codex
 * 声明 `on-request`：那会让 Codex 发起注定被自动拒绝的审批，模型还会误以为
 * 用户拒绝了它。`ask` 才映射为 Codex 的 `on-request`。
 */
function codexApprovalPolicy(input: CodingNsCliTurnInput): string {
  return input.permission?.approvalPolicy === 'never' ? 'never' : 'on-request'
}

function permissionResponseKind(method: string, params: Record<string, any>): PendingCodexPermission['response'] {
  // 沙箱提权请求的应答是 {permissions, scope}，必须在识别 fileChange/command 之前
  // 判定，否则会落到 legacy 分支返回 {approved}，形状不符。
  if (method.includes('permissions') && method.includes('Approval')) return 'permissions'
  if (method.includes('fileChange') || method.includes('file_change')) return 'file-change'
  // 新版 Codex 带 threadId/turnId/itemId，并要求 decision；旧版测试和旧
  // app-server 使用 approved 字段，按请求形状保持向后兼容。
  if (method.includes('commandExecution') && (params.threadId !== undefined || params.turnId !== undefined || params.itemId !== undefined)) return 'command'
  return 'legacy'
}

/**
 * 把 Codex 请求的权限画像转成可回传的授予画像。
 *
 * `RequestPermissionProfile` 与 `GrantedPermissionProfile` 同形，但缺省字段在
 * 授予侧是可选的；这里只保留实际存在的部分，避免回传 null 触发 schema 拒绝。
 */
function grantedPermissionProfile(requested: unknown): Record<string, unknown> {
  const profile = isRecord(requested) ? requested : null
  const fileSystem = isRecord(profile?.fileSystem) ? profile.fileSystem : undefined
  const network = isRecord(profile?.network) ? profile.network : undefined
  return {
    ...(fileSystem === undefined ? {} : { fileSystem }),
    ...(network === undefined ? {} : { network }),
  }
}

function readId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.threadId === 'string') return value.threadId
  if (typeof value.id === 'string') return value.id
  if (isRecord(value.thread) && typeof value.thread.id === 'string') return value.thread.id
  return null
}

/**
 * 读取线程当前生效的模型。
 *
 * `thread/start`、`thread/resume` 的响应都在顶层返回 `model`；旧版协议把它嵌在
 * `thread.model` 中。读不到时返回 undefined，调用方按“未知”处理并自行纠正。
 */
function readThreadModel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const direct = value.model
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  const nested = isRecord(value.thread) ? value.thread.model : undefined
  return typeof nested === 'string' && nested.trim() !== '' ? nested.trim() : undefined
}
