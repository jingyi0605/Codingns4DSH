import { createHash } from 'node:crypto'
import { runAsyncCommand } from './process-utils.js'
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CodingNsCliModelCatalog, CodingNsAgentEvent, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, textValue, usageChunk } from './rpc-driver-utils.js'
import { PI_CATALOG, isProviderDefaultModel } from './model-catalog.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { commandEnvironment, WINDOWS } from './process-utils.js'
import { buildPiImages, promptWithAttachmentPaths } from './attachment-utils.js'
import { reasoningText } from './reasoning-content.js'
import { piBridgeArgs, piBridgeEnvironment } from '../cli-bridge/injections.js'
import { PiPerformanceTracker } from './pi-performance.js'

const PI_ABORT_TIMEOUT_MS = 2_000

export interface PiAgentDriverOptions {
  readonly binaries?: readonly string[]
  readonly sessionRoots?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/** Pi Agent 的 --mode rpc 适配器。Pi 的长期 RPC 细节被限制在本文件和标准进程层内。 */
export class PiAgentDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'pi', name: 'Pi Agent', protocol: 'json-rpc', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'steer'] as const } as const
  /** 工具完成后由 Registry 挂起并续读同一个事件迭代器，使工具和正文按时间线分 step。 */
  readonly supportsToolStepSplitting = true
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly sessionRoots: readonly string[]
  private cachedBinary: string | null = null
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly sessions = new Map<string, {
    rpc: JsonRpcProcess
    cwd: string | undefined
    rawStoreRef: string | undefined
    bridgeFingerprint: string
    providerSessionId: string
    providerSessionIdKnown: boolean
    stateLoaded: boolean
    modelContextWindow: number | undefined
  }>()

  constructor(options: PiAgentDriverOptions = {}) {
    this.binaries = options.binaries ?? ['pi', 'pi-agent']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    const configDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
    this.sessionRoots = options.sessionRoots ?? [process.env.PI_CODING_AGENT_SESSION_DIR ?? join(configDirectory, 'sessions')]
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detection = await this.detect()
    if (!detection.installed) return emptyCatalog()
    // Pi 的 RPC 目录包含每个模型精确的 thinkingLevelMap；表格接口只有 yes/no，
    // 不能用来判断具体档位，因此只能作为旧版本的降级路径。
    const rpc = new JsonRpcProcess({ command: detection.command!, args: ['--mode', 'rpc'], spawn: this.runSpawn })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await rpc.request('get_available_models', {}, { signal: controller.signal, wireFormat: 'pi' })
      const catalog = parsePiCatalog(response)
      if (catalog.groups.length > 0) return catalog
    } catch { /* 旧版 Pi 没有模型 RPC 时继续读取表格。 */ }
    finally { clearTimeout(timer); rpc.dispose() }
    try {
      const result = await runAsyncCommand(this.runSpawnSync, detection.command!, ['--list-models'], { encoding: 'utf8', timeout: 12_000, windowsHide: true, shell: WINDOWS, env: commandEnvironment(detection.command!) })
      const catalog = parsePiCliCatalog(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
      if (catalog.groups.length > 0) return catalog
    } catch { /* 旧版 Pi 没有 --list-models。 */ }
    return PI_CATALOG
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path).endsWith(`${id}.jsonl`),
      validate: async (path, id) => {
        const record = await readFirstJsonRecord(path)
        return record?.type === 'session' && record.id === id
      },
    })
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error('Pi Agent 未安装')
    const session = this.getSession(input.sessionId, command, input.cwd, input.providerSessionId, input.rawStoreRef, input.runtimeEnv)
    const rpc = session.rpc
    try {
      // Pi 的 sessionId 由进程创建；先读状态，避免把 DSH sessionId 错当成 Provider 会话标识。
      if (!session.stateLoaded) {
        try {
          const state = await rpc.request('get_state', {}, { signal: input.signal, killOnAbort: false, wireFormat: 'pi' })
          const discoveredId = readPiStateSessionId(state)
          if (discoveredId) {
            session.providerSessionId = discoveredId
            session.providerSessionIdKnown = true
          }
          session.modelContextWindow = readPiModelContextWindow(state)
        } catch { /* 旧版 Pi 不提供 get_state 时保留 Host 侧回退标识。 */ }
        session.stateLoaded = true
      }
      if (!isProviderDefaultModel(input.modelId)) {
        const model = parsePiModelId(input.modelId)
        if (model !== null) {
          try {
            const selected = await rpc.request('set_model', model, { signal: input.signal, killOnAbort: false, wireFormat: 'pi' })
            session.modelContextWindow = readPiModelContextWindow(selected) ?? session.modelContextWindow
          } catch { /* 模型目录或旧版 Pi 不支持切换时继续使用当前模型。 */ }
        }
      }
      if (input.effortId && input.effortId !== 'default') {
        try {
          await rpc.request('set_thinking_level', { level: input.effortId }, { signal: input.signal, killOnAbort: false, wireFormat: 'pi' })
        } catch { /* 旧版 Pi 不支持单独设置思考等级时使用当前等级。 */ }
      }
      yield { type: 'session-binding', providerSessionId: session.providerSessionId }
      const images = await buildPiImages(input.attachments ?? [])
      const performance = new PiPerformanceTracker()
      const stream = streamPiPrompt(rpc, {
        // 图片已通过原生 images 字段传递，不再引导模型把无后缀图片当普通文件读取。
        message: promptWithAttachmentPaths(input.prompt, (input.attachments ?? []).filter((attachment) => attachment.kind === 'file'), input.translationLanguage),
        ...(images.length > 0 ? { images } : {}),
      }, input.signal, (message, receivedAt) => performance.observe(message, receivedAt))
      let finishResult: { reason: 'stop' | 'cancel' | 'error'; failure?: { message: string; code?: string } }
      let latestUsage: Extract<CodingNsAgentEvent, { type: 'usage' }> | null = null
      const streamState: PiStreamState = { streamed: new Set() }
      while (true) {
        const item = await stream.next()
        if (item.done) {
          finishResult = item.value
          break
        }
        const discoveredId = readSessionId(item.value.message)
        if (discoveredId) session.providerSessionIdKnown = true
        if (discoveredId && discoveredId !== session.providerSessionId) {
          session.providerSessionId = discoveredId
          yield { type: 'session-binding', providerSessionId: discoveredId }
        }
        if (item.value.performance !== undefined) {
          yield {
            type: 'usage-observation',
            requestPerformance: {
              adapterId: 'pi',
              id: item.value.performance.id,
              samples: [item.value.performance],
            },
          }
        }
        for (const chunk of piMessageToChunks(item.value.message, streamState)) {
          if (chunk.type === 'usage') {
            // Pi 的 message_update 用量是同一轮的滚动快照，先保留最后一份，
            // 等 get_session_stats 补齐上下文后只投影一次，避免重复采样。
            latestUsage = chunk
          } else yield chunk
        }
      }
      const statsUsage = input.signal?.aborted
        ? null
        : await readPiSessionStats(rpc, input.signal, session.modelContextWindow)
      const enrichedUsage = enrichPiUsage(latestUsage, statsUsage, session.modelContextWindow)
      if (enrichedUsage !== null) yield enrichedUsage
      if (finishResult.reason === 'cancel') {
        await this.interrupt(input.sessionId)
      }
      yield { type: 'finish', reason: finishResult.reason, ...(finishResult.failure === undefined ? {} : { failure: finishResult.failure }) }
    } finally { /* 跨轮复用：仅 dispose() 才回收长期进程。 */ }
  }

  /** 向运行中的 Pi 会话发送 steering，当前 turn 会立即改变方向。 */
  async steer(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('Pi 会话不存在')
    await session.rpc.request('steer', { message: prompt }, { killOnAbort: false, wireFormat: 'pi' })
  }

  /** 向运行中的 Pi 会话追加 follow-up。 */
  async followUp(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('Pi 会话不存在')
    await session.rpc.request('follow_up', { message: prompt }, { killOnAbort: false, wireFormat: 'pi' })
  }

  /** 中断当前 turn，但保留 Pi 进程供同一会话继续使用。 */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    try { session.rpc.notify('abort', {}, 'pi') } catch { /* 进程可能已退出 */ }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, PI_ABORT_TIMEOUT_MS)
    try {
      await session.rpc.request('abort', {}, { signal: controller.signal, killOnAbort: false, wireFormat: 'pi' })
    } catch {
      if (timedOut) session.rpc.dispose()
    } finally {
      clearTimeout(timer)
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.rpc.dispose()
    this.sessions.clear()
    this.processes.clear()
    this.cachedBinary = null
  }

  private getSession(
    sessionId: string,
    command: string,
    cwd: string | undefined,
    providerSessionId: string | undefined,
    rawStoreRef: string | undefined,
    runtimeEnv: Readonly<Record<string, string>> | undefined,
  ) {
    const bridgeArgs = piBridgeArgs(sessionId)
    const bridgeEnvironment = piBridgeEnvironment(sessionId, 'pi')
    const bridgeFingerprint = createHash('sha256')
      .update(JSON.stringify([bridgeArgs, bridgeEnvironment]))
      .digest('hex')
    const previous = this.sessions.get(sessionId)
    if (previous !== undefined
      && previous.cwd === cwd
      && previous.bridgeFingerprint === bridgeFingerprint
      && !previous.rpc.isClosed
      && (providerSessionId === undefined || providerSessionId === previous.providerSessionId)
      && (rawStoreRef === undefined || rawStoreRef === previous.rawStoreRef)) {
      if (providerSessionId !== undefined) previous.providerSessionIdKnown = true
      return previous
    }
    const resumeStoreRef = rawStoreRef ?? previous?.rawStoreRef
    const resumeProviderSessionId = providerSessionId
      ?? (previous?.providerSessionIdKnown ? previous.providerSessionId : undefined)
    previous?.rpc.dispose()
    const args = ['--mode', 'rpc', ...bridgeArgs]
    if (resumeStoreRef?.trim()) args.push('--session', resumeStoreRef.trim())
    else if (resumeProviderSessionId?.trim()) args.push('--session-id', resumeProviderSessionId.trim())
    const rpc = new JsonRpcProcess({ command, args, cwd, env: { ...bridgeEnvironment, ...(runtimeEnv ?? {}) }, spawn: this.runSpawn })
    this.processes.add(rpc)
    const session = {
      rpc,
      cwd,
      rawStoreRef: resumeStoreRef,
      bridgeFingerprint,
      providerSessionId: providerSessionId ?? previous?.providerSessionId ?? sessionId,
      providerSessionIdKnown: providerSessionId !== undefined || (previous?.providerSessionIdKnown ?? false),
      stateLoaded: false,
      modelContextWindow: undefined as number | undefined,
    }
    this.sessions.set(sessionId, session)
    rpc.addExitListener(() => {
      this.processes.delete(rpc)
      if (this.sessions.get(sessionId)?.rpc === rpc) this.sessions.delete(sessionId)
    })
    return session
  }
}

/**
 * Pi 的 prompt 响应只表示已接受，不能作为轮次终态。
 * 监听器必须先于请求注册，并一直保留到 agent_settled、失败或取消。
 */
async function* streamPiPrompt(
  rpc: JsonRpcProcess,
  prompt: Record<string, unknown>,
  signal: AbortSignal | undefined,
  observe?: (message: JsonRpcMessage, receivedAt: number) => import('../../shared/request-performance.js').RequestPerformance | undefined,
): AsyncGenerator<{ message: JsonRpcMessage; performance?: import('../../shared/request-performance.js').RequestPerformance }, { reason: 'stop' | 'cancel' | 'error'; failure?: { message: string; code?: string } }, void> {
  const queue: Array<{ message: JsonRpcMessage; performance?: import('../../shared/request-performance.js').RequestPerformance }> = []
  let wake: (() => void) | undefined
  let promptSettled = false
  let terminalReason: 'stop' | 'cancel' | 'error' | null = null
  let failure: { message: string; code?: string } | undefined
  const notify = (): void => { wake?.(); wake = undefined }
  const listener = (message: JsonRpcMessage): void => {
    if (terminalReason === 'cancel') return
    const receivedAt = Date.now()
    const performance = observe?.(message, receivedAt)
    queue.push({ message, ...(performance === undefined ? {} : { performance }) })
    const type = piEventType(message)
    if (type === 'error' || type === 'agent_error' || type === 'agent_failed' || piEventHasError(message)) {
      terminalReason = 'error'
      failure = piFailure(message)
    }
    else if (type === 'agent_settled' && terminalReason === null) terminalReason = 'stop'
    notify()
  }
  const removeListener = rpc.addNotificationListener(listener)
  const removeExitListener = rpc.addExitListener((error) => {
    if (terminalReason !== null) return
    terminalReason = 'error'
    failure = errorMessageFromUnknown(error)
    notify()
  })
  const onAbort = (): void => {
    terminalReason = 'cancel'
    promptSettled = true
    queue.length = 0
    try { rpc.notify('abort', {}, 'pi') } catch { /* 进程可能已退出 */ }
    notify()
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  void rpc.request('prompt', prompt, { signal, killOnAbort: false, wireFormat: 'pi' }).then(
    () => { promptSettled = true; notify() },
    (error: unknown) => {
      promptSettled = true
      terminalReason = signal?.aborted ? 'cancel' : 'error'
      if (terminalReason === 'error') failure = errorMessageFromUnknown(error)
      notify()
    },
  )

  try {
    while (queue.length > 0 || !promptSettled || terminalReason === null) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
    return { reason: terminalReason, ...(failure === undefined ? {} : { failure }) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    removeListener()
    removeExitListener()
  }
}

function piEventType(message: JsonRpcMessage): string {
  const params = isRecord(message.params) ? message.params : message
  return typeof params.type === 'string' ? params.type.toLowerCase() : ''
}

function piEventHasError(message: JsonRpcMessage): boolean {
  const params = isRecord(message.params) ? message.params : message
  const event = isRecord(params.message) ? params.message : params
  const stopReason = textValue(event.stopReason ?? params.stopReason)
  return stopReason === 'error' || stopReason === 'failed' || typeof event.errorMessage === 'string' && event.errorMessage.trim() !== ''
}

function piFailure(message: JsonRpcMessage): { message: string; code?: string } {
  const params = isRecord(message.params) ? message.params : message
  const event = isRecord(params.message) ? params.message : params
  const value = event.errorMessage ?? event.error ?? params.errorMessage ?? params.error ?? event.stopReason
  const detail = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'Pi Agent Provider 未返回具体失败信息。'
  const codeValue = event.errorCode ?? params.errorCode ?? event.code ?? params.code
  const code = typeof codeValue === 'string' && codeValue.trim() !== '' ? codeValue.trim() : undefined
  return code === undefined ? { message: detail } : { message: detail, code }
}

function errorMessageFromUnknown(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : String(error) }
}

function parsePiCliCatalog(output: string): CodingNsCliModelCatalog {
  const models: Array<{ id: string; name: string; efforts: readonly string[] }> = []
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(yes|no)(?:\s+|$)/iu)
    if (!match) continue
    const provider = match[1]!
    const model = match[2]!
    const id = `${provider}/${model}`
    if (models.some((item) => item.id === id)) continue
    models.push({ id, name: model, efforts: match[3]!.toLowerCase() === 'yes' ? levels : ['off'] })
  }
  if (models.length === 0) return emptyCatalog()
  return { groups: [{ id: 'pi', name: 'Pi', models }], currentModel: null, currentEffort: null }
}

function parsePiCatalog(value: unknown): CodingNsCliModelCatalog {
  const payload = isRecord(value) && isRecord(value.data) ? value.data : value
  const models = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.models) ? payload.models : []
  const items = models.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    const id = typeof entry.id === 'string' ? entry.id.trim() : typeof entry.modelId === 'string' ? entry.modelId.trim() : ''
    if (!id) return []
    const modelId = provider ? `${provider}/${id}` : id
    const map = isRecord(entry.thinkingLevelMap) ? entry.thinkingLevelMap : null
    const reasoning = entry.reasoning === true
    const levels = !reasoning
      ? ['off']
      : map === null
        ? ['off', 'minimal', 'low', 'medium', 'high']
        : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((level) => typeof map[level] === 'string' && map[level].trim() !== '')
    return [{ id: modelId, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : id, efforts: levels }]
  })
  if (items.length === 0) return emptyCatalog()
  return { groups: [{ id: 'pi', name: 'Pi', models: [...new Map(items.map((item) => [item.id, item])).values()] }], currentModel: null, currentEffort: null }
}

/** 记录当前 assistant 消息里已经流式输出过的内容块，避免 *_end 的完整内容重复追加。 */
interface PiStreamState {
  readonly streamed: Set<string>
}

function piBoundary(channel: 'reasoning' | 'text'): CodingNsAgentEvent {
  return { type: 'message-boundary', channel, messageId: `pi-assistant-${channel}` }
}

function piMessageToChunks(message: Record<string, any>, state: PiStreamState = { streamed: new Set() }): readonly CodingNsAgentEvent[] {
  const params = isRecord(message.params) ? message.params : message
  const event = isRecord(params.item) ? params.item : params
  const assistantEvent = isRecord(params.assistantMessageEvent) ? params.assistantMessageEvent : null
  const completedMessage = isRecord(params.message) ? params.message : null
  const rootType = typeof event.type === 'string' ? event.type : typeof params.event === 'string' ? params.event : ''
  const usage = piUsageChunk(params) ?? (completedMessage === null ? null : piUsageChunk(completedMessage))
  if (rootType === 'message_start') state.streamed.clear()
  // Pi 在 message_end/turn_end 才明确告知一条 assistant 消息已完成。必须在这里关闭
  // 正文和思考块，否则文本会一直停留在打开的块里，直到整轮 finish 才一次性落盘。
  if (rootType === 'message_end' || rootType === 'turn_end') {
    state.streamed.clear()
    const closing = completedMessage === null || completedMessage.role === 'assistant'
      ? [piBoundary('reasoning'), piBoundary('text')]
      : []
    return usage === null ? closing : [...closing, usage]
  }
  if (rootType === 'agent_start'
    || rootType === 'agent_settled'
    || rootType === 'agent_end'
    || rootType === 'turn_start'
    || rootType === 'message_start') return usage === null ? [] : [usage]
  const type = assistantEvent !== null && typeof assistantEvent.type === 'string' ? assistantEvent.type : rootType
  if (type === 'thinking_end' || type === 'text_end') {
    // *_end 携带该内容块的完整内容。已流式输出过就只收尾；Provider 没有发 delta 时补发一次。
    const channel = type === 'thinking_end' ? 'reasoning' : 'text'
    const key = `${channel}:${String(assistantEvent?.contentIndex ?? '')}`
    const full = textValue(assistantEvent?.content)
    const chunks: CodingNsAgentEvent[] = []
    if (!state.streamed.has(key) && full) chunks.push({ type: channel === 'reasoning' ? 'reasoning-delta' : 'text-delta', text: full })
    state.streamed.delete(key)
    chunks.push(piBoundary(channel))
    if (usage !== null) chunks.push(usage)
    return chunks
  }
  // toolcall_* 只是模型在流式拼装调用参数，真正的执行由 tool_execution_* 表达。
  // 把它们转成工具事件会生成大量无 callId 的空 `tool` 调用，且 toolcall_end 会在工具
  // 尚未执行时就被当成“已完成”，导致按工具分 step 时过早切分。
  if (type === 'toolcall_start' || type === 'toolcall_delta' || type === 'toolcall_end') return usage === null ? [] : [usage]
  if (type === 'thinking_delta' || type === 'text_delta') {
    state.streamed.add(`${type === 'thinking_delta' ? 'reasoning' : 'text'}:${String(assistantEvent?.contentIndex ?? '')}`)
  }
  const reasoning = reasoningText(assistantEvent ?? params)
  if (reasoning !== null) return usage === null ? [{ type: 'reasoning-delta', text: reasoning }] : [{ type: 'reasoning-delta', text: reasoning }, usage]
  const text = textValue(assistantEvent?.delta ?? params.delta ?? params.text ?? params.content ?? params.message)
  if (type.includes('text_delta') || type === 'text-delta' || type === 'assistant_message_event' && text) {
    if (!text) return usage === null ? [] : [usage]
    return usage === null ? [{ type: 'text-delta', text }] : [{ type: 'text-delta', text }, usage]
  }
  if (type.includes('thinking') || type.includes('reasoning')) {
    if (!text) return usage === null ? [] : [usage]
    return usage === null ? [{ type: 'reasoning-delta', text }] : [{ type: 'reasoning-delta', text }, usage]
  }
  const toolResultMessage = completedMessage?.role === 'toolResult' ? completedMessage : null
  const toolCall = isToolRecord(assistantEvent?.toolCall) ? assistantEvent.toolCall : null
  if (type.includes('tool') || type.includes('agent') || toolResultMessage !== null) {
    const source = toolResultMessage ?? assistantEvent ?? event
    const toolName = firstToolText(source.toolName, source.name, toolCall?.name, params.toolName, params.name) ?? (type.includes('agent') ? 'subagent' : 'tool')
    const callId = firstToolText(source.toolCallId, source.callId, source.id, toolCall?.id, params.toolCallId, params.callId)
    const input = serializeToolValue(source.args ?? source.arguments ?? toolCall?.arguments ?? params.args)
    const failed = source.isError === true || params.isError === true || type.includes('failed') || type.includes('error')
    const resultValue = source.partialResult ?? source.result ?? (toolResultMessage === null ? source.output : source.content)
    const result = serializeToolValue(resultValue)
    const agentId = firstToolText(source.agentId, params.agentId, type.includes('agent') ? source.sessionId ?? params.sessionId : undefined)
    const detail = serializeToolValue(source.detail ?? params.detail)
    const status = normalizeToolStatus(
      source.status ?? source.state ?? params.status ?? params.state,
      failed ? 'failed' : type.includes('end') || type.includes('completed') || toolResultMessage !== null ? 'completed' : 'running',
    )
    const tool: CodingNsAgentEvent = {
      type: 'tool-event',
      toolName,
      status,
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(failed ? (result === undefined ? {} : { error: result }) : (result === undefined ? {} : { output: result })),
      ...(!failed && result !== undefined ? { outputMode: 'snapshot' as const } : {}),
      ...(agentId ? { agentId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
    return usage === null ? [tool] : [tool, usage]
  }
  return usage === null ? [] : [usage]
}

/** Pi 的 Usage 使用 input/output/cacheRead/cacheWrite 短字段，且 input 不含缓存桶。 */
function piUsageChunk(value: unknown): Extract<CodingNsAgentEvent, { type: 'usage' }> | null {
  if (!isRecord(value)) return null
  const usage = isRecord(value.usage) ? value.usage : value
  const inputTokens = piNumber(usage.input ?? usage.inputTokens)
  const outputTokens = piNumber(usage.output ?? usage.outputTokens)
  const cacheReadTokens = piNumber(usage.cacheRead ?? usage.cacheReadTokens)
  const cacheWriteTokens = piNumber(usage.cacheWrite ?? usage.cacheWriteTokens)
  const totalTokens = piNumber(usage.totalTokens ?? usage.total_tokens)
  const contextWindow = piNumber(usage.contextWindow ?? usage.context_window)
  const contextTokens = piNumber(usage.contextTokens ?? usage.context_tokens)
  const contextUsageRatio = piNumber(usage.contextUsageRatio ?? usage.context_usage_ratio)
  const normalized = usageChunk({
    inputTokens: inputTokens ?? 0,
    ...(inputTokens === undefined ? {} : { uncachedInputTokens: inputTokens }),
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextUsageRatio === undefined ? {} : { contextUsageRatio }),
  })
  return normalized?.type === 'usage' ? normalized : null
}

function piNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined
}

function readPiModelContextWindow(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const data = isRecord(value.data) ? value.data : value
  const model = isRecord(data.model) ? data.model : undefined
  const contextWindow = piNumber(model?.contextWindow ?? model?.context_window)
  return contextWindow !== undefined && contextWindow > 0 ? contextWindow : undefined
}

interface PiStatsUsage {
  readonly contextWindow?: number
  readonly contextTokens?: number
  readonly contextUsageRatio?: number
}

async function readPiSessionStats(rpc: JsonRpcProcess, signal: AbortSignal | undefined, fallbackContextWindow: number | undefined): Promise<PiStatsUsage | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const value = await rpc.request('get_session_stats', {}, { signal: controller.signal, killOnAbort: false, wireFormat: 'pi' })
    if (!isRecord(value)) return null
    const data = isRecord(value.data) ? value.data : value
    const context = isRecord(data.contextUsage) ? data.contextUsage : isRecord(data.context_usage) ? data.context_usage : undefined
    const contextWindow = piNumber(context?.contextWindow ?? context?.context_window) ?? fallbackContextWindow
    const contextTokens = piNumber(context?.tokens ?? context?.contextTokens ?? context?.context_tokens)
    const percent = piNumber(context?.percent)
    const contextUsageRatio = piNumber(context?.contextUsageRatio ?? context?.context_usage_ratio)
      ?? (percent === undefined ? undefined : Math.min(1, percent / 100))
    if (contextWindow === undefined && contextTokens === undefined && contextUsageRatio === undefined) return null
    return {
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(contextUsageRatio === undefined ? {} : { contextUsageRatio }),
    }
  } catch {
    // 旧版 Pi 没有 get_session_stats 时保留 message_update 的用量路径。
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

function enrichPiUsage(
  usage: Extract<CodingNsAgentEvent, { type: 'usage' }> | null,
  stats: PiStatsUsage | null,
  fallbackContextWindow: number | undefined,
): Extract<CodingNsAgentEvent, { type: 'usage' }> | null {
  const contextWindow = stats?.contextWindow ?? fallbackContextWindow
  const contextTokens = stats?.contextTokens
    ?? (usage === null ? undefined : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
  const contextUsageRatio = stats?.contextUsageRatio
    ?? (contextWindow !== undefined && contextTokens !== undefined && contextWindow > 0
      ? Number(Math.min(1, contextTokens / contextWindow).toFixed(6))
      : undefined)
  if (usage === null) {
    if (contextWindow === undefined && contextTokens === undefined && contextUsageRatio === undefined) return null
    return {
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(contextUsageRatio === undefined ? {} : { contextUsageRatio }),
    }
  }
  if (contextWindow === undefined && contextTokens === undefined && contextUsageRatio === undefined) return usage
  return {
    ...usage,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextUsageRatio === undefined ? {} : { contextUsageRatio }),
  }
}

function readSessionId(message: Record<string, any>): string | null {
  const params = isRecord(message.params) ? message.params : message
  for (const key of ['sessionId', 'session_id', 'providerSessionId']) if (typeof params[key] === 'string' && params[key].trim()) return params[key].trim()
  return null
}

function readPiStateSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  const data = isRecord(value.data) ? value.data : value
  return textValue(data.sessionId ?? data.session_id) ?? null
}

function parsePiModelId(value: string | undefined): { provider: string; modelId: string } | null {
  if (!value) return null
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) return null
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) }
}
