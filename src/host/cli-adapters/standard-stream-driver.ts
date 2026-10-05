import { spawn, spawnSync } from 'node:child_process'
import readline from 'node:readline'
import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliModelCatalog,
  CodingNsAgentEvent,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { usageChunk } from './rpc-driver-utils.js'
import { reasoningText, textContent } from './reasoning-content.js'
import { commandEnvironment, resolveCommandPath, terminateChildProcess, type CodingNsChildProcess } from './process-utils.js'
import { advanceCodingNsSegment, createCodingNsSegmentState, decorateCodingNsSegmentEvent } from './stream-normalizer.js'

const WINDOWS = process.platform === 'win32'

export interface StandardStreamDriverOptions {
  readonly binaries?: readonly string[]
  /** 仅供会话存在性探测使用；测试和自定义安装可覆盖默认存储根目录。 */
  readonly sessionRoots?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  readonly versionArgs?: readonly string[]
  readonly modelArgs?: readonly string[]
  /** Claude 模型发现的配置目录和网络请求注入点。 */
  readonly claudeConfigDir?: string
  readonly fetch?: typeof fetch
}

/**
 * 把采用 JSONL/stream-json 的 CLI 统一成 Codingns4DSH 的最小驱动契约。
 * 子类只需提供命令参数和事件映射，进程终止、stderr 消费及清理由这里统一处理。
 */
export abstract class StandardStreamDriver implements CodingNsCliDriver {
  readonly descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>
  readonly supportsToolStepSplitting?: boolean
  protected readonly binaries: readonly string[]
  protected readonly runSpawnSync: typeof spawnSync
  protected readonly runSpawn: typeof spawn
  private readonly versionArgs: readonly string[]
  private readonly modelArgs: readonly string[]
  private cachedBinary: string | null = null
  private cachedEnvironment: Record<string, string | undefined> | undefined
  private readonly processes = new Set<CodingNsChildProcess>()

  protected constructor(
    descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>,
    defaults: { binaries: readonly string[]; versionArgs?: readonly string[]; modelArgs?: readonly string[] },
    options: StandardStreamDriverOptions = {},
  ) {
    this.descriptor = descriptor
    this.binaries = options.binaries ?? defaults.binaries
    this.versionArgs = options.versionArgs ?? defaults.versionArgs ?? ['--version']
    this.modelArgs = options.modelArgs ?? defaults.modelArgs ?? ['--help']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    for (const command of this.binaries) {
      const direct = await this.detectCommand(command)
      if (direct !== null) return direct
      if (!this.lookupAfterDetectionFailure) continue
      const resolved = resolveCommandPath(command, this.runSpawnSync)
      if (resolved === null) continue
      const fallback = await this.detectCommand(resolved, commandEnvironment(resolved))
      if (fallback !== null) return fallback
    }
    return { installed: false, version: null, command: null }
  }

  private lookupAfterDetectionFailure = false

  private async detectCommand(command: string, env?: Record<string, string | undefined>): Promise<{ installed: true; version: string; command: string } | null> {
    this.lookupAfterDetectionFailure = false
    try {
      const result = this.runSpawnSync(command, this.versionArgs, { encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: WINDOWS, ...(env === undefined ? {} : { env }) })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      const version = this.parseVersion(output)
      if (result.status === 0 && version !== null) {
        this.cachedBinary = command
        this.cachedEnvironment = env ?? commandEnvironment(command)
        return { installed: true, version, command }
      }
      this.lookupAfterDetectionFailure = result.status === null
    } catch {
      // 候选命令不存在时继续尝试下一个名称。
      this.lookupAfterDetectionFailure = true
    }
    return null
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) return emptyCatalog()
    try {
      const result = this.runSpawnSync(command, this.modelArgs, { encoding: 'utf8', timeout: 12_000, windowsHide: true, shell: WINDOWS, ...(this.cachedEnvironment === undefined ? {} : { env: this.cachedEnvironment }) })
      if (result.status !== 0) return emptyCatalog()
      return this.parseModels(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    } catch {
      return emptyCatalog()
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error(`${this.descriptor.name} 未安装`)
    let child: CodingNsChildProcess
    try {
      child = this.runSpawn(command, this.buildArgs(input), {
        cwd: input.cwd ?? process.cwd(), env: this.cachedEnvironment ?? { ...process.env }, stdio: [this.usesStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, shell: WINDOWS,
      }) as CodingNsChildProcess
    } catch (error) {
      // spawn 在命令路径或参数非法时可能同步抛错；必须收敛成当前回合错误，
      // 不能让异常越过适配器边界把整个 Host 进程带崩。
      throw new Error(`${this.descriptor.name} 执行失败：${toError(error).message}`)
    }
    this.processes.add(child)
    let emittedFinish = false
    const segmentState = this.supportsToolStepSplitting === true ? createCodingNsSegmentState() : undefined
    let emittedBinding = input.providerSessionId !== undefined
    let processErrorMessage: string | null = null
    const rememberProcessError = (error: unknown): void => {
      processErrorMessage ??= toError(error).message
    }
    // 子进程和它的三个 stdio 流都必须有 error 监听。否则 AGY 这类快速退出的
    // CLI 在 stdin 写入 EPIPE 或 spawn 失败时，会把异常升级成宿主进程崩溃。
    addErrorListener(child, rememberProcessError)
    addErrorListener(child.stdin, rememberProcessError)
    addErrorListener(child.stdout, rememberProcessError)
    addErrorListener(child.stderr, rememberProcessError)
    const onAbort = (): void => {
      if (this.usesStdin) closeStdin(child)
      terminateChildProcess(child)
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      // 只保留有限长度的 Provider 原始诊断，避免异常输出撑爆 DSH 会话。
      stderr = `${stderr}${String(chunk)}`.slice(-16_384)
    })
    try {
      if (this.usesStdin && !input.signal?.aborted) this.writeStdin(child, input)
      const lines = readline.createInterface({ input: child.stdout })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          const parsed = parseJson(line)
          if (parsed === null) continue
          const providerSessionId = typeof parsed.session_id === 'string'
            ? parsed.session_id
            : typeof parsed.sessionId === 'string'
              ? parsed.sessionId
              : typeof parsed.conversation_id === 'string'
                ? parsed.conversation_id
                : typeof parsed.conversationId === 'string'
                  ? parsed.conversationId
                  : nestedSessionId(parsed)
          if (providerSessionId !== null && providerSessionId.trim() !== '') {
            this.validateProviderSessionBinding(input, providerSessionId.trim())
            if (!emittedBinding) {
              emittedBinding = true
              yield { type: 'session-binding', providerSessionId: providerSessionId.trim() }
            }
          }
          for (const rawChunk of this.parseEvent(parsed, input)) {
            const chunk = segmentState === undefined ? rawChunk : decorateCodingNsSegmentEvent(rawChunk, input, segmentState, this.descriptor.id)
            if (chunk.type === 'finish') emittedFinish = true
            yield chunk
            if (segmentState !== undefined) advanceCodingNsSegment(chunk, segmentState)
          }
        }
      } finally { lines.close() }
      if (!emittedFinish) {
        if (input.signal?.aborted) yield { type: 'finish', reason: 'cancel' }
        else {
          const detail = stderr.trim() || String(processErrorMessage ?? '').trim()
          throw new Error(detail === '' ? `${this.descriptor.name} 执行失败` : `${this.descriptor.name} 执行失败：${detail}`)
        }
      }
    } finally {
      if (this.usesStdin) closeStdin(child)
      input.signal?.removeEventListener('abort', onAbort)
      this.processes.delete(child)
      terminateChildProcess(child)
    }
  }

  /** 已探测到的 CLI 路径；供子类在同步的 buildArgs 里做参数能力探测。 */
  protected get resolvedBinary(): string | null { return this.cachedBinary }

  /**
   * 已探测命令对应的运行环境。桌面/DSH 进程可能没有登录 Shell 的完整 PATH，
   * 子类执行额外的同步探测命令时必须沿用这里的环境，不能退回宿主默认环境。
   */
  protected get resolvedEnvironment(): Record<string, string | undefined> | undefined {
    return this.cachedEnvironment
  }

  /** 是否需要把当前轮输入写入子进程 stdin。默认保持原有 ignore 语义。 */
  protected get usesStdin(): boolean { return false }

  /** 向使用 stdin 的 CLI 写入一轮输入；子类负责遵循其线协议。 */
  protected writeStdin(_child: CodingNsChildProcess, _input: CodingNsCliTurnInput): void {}

  /** 续接会话时由需要强一致性的 Provider 校验原生会话 ID。 */
  protected validateProviderSessionBinding(_input: CodingNsCliTurnInput, _providerSessionId: string): void {}

  dispose(): void {
    for (const child of this.processes) terminateChildProcess(child)
    this.processes.clear()
    this.cachedBinary = null
    this.cachedEnvironment = undefined
  }

  protected parseVersion(output: string): string | null { return output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0] ?? null }
  protected abstract buildArgs(input: CodingNsCliTurnInput): readonly string[]
  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    return genericEventChunks(value, input.signal?.aborted ?? false)
  }
  protected parseModels(output: string): CodingNsCliModelCatalog { return parseHelpModels(output) }
}

export function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }

function parseJson(line: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(line); return isRecord(value) ? value : null } catch { return null } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function nestedSessionId(value: Record<string, unknown>): string | null {
  for (const key of ['init', 'step_update', 'result']) {
    const nested = value[key]
    if (!isRecord(nested)) continue
    for (const id of ['session_id', 'sessionId', 'conversation_id', 'conversationId']) {
      if (typeof nested[id] === 'string') return nested[id]
    }
  }
  return null
}

export function genericEventChunks(value: Record<string, unknown>, cancelled: boolean): CodingNsAgentEvent[] {
  const chunks: CodingNsAgentEvent[] = []
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : ''
  const eventName = typeof value.event === 'string' ? value.event.toLowerCase() : ''
  // 部分 CLI（包括 AGY）使用 `event: "step_update"` 搭配同名对象承载负载，
  // 不能只把字符串事件名当作普通字段，否则文本增量和 result 终态都会丢失。
  const event = isRecord(value.event)
    ? value.event
    : eventName !== '' && isRecord(value[eventName])
      ? value[eventName] as Record<string, any>
      : value
  const eventType = typeof event.type === 'string' ? event.type.toLowerCase() : eventName || type
  const messageId = firstToolText(event.messageId, event.message_id, event.itemId, event.item_id, value.messageId, value.message_id)
  const withMessageId = messageId === undefined ? {} : { messageId }
  const explicitReasoning = reasoningText(event)
  if (eventType.includes('think') || eventType.includes('reason')) {
    const delta = isRecord(event.delta) ? event.delta : event
    const reasoning = explicitReasoning
      ?? (typeof event.delta === 'string' ? event.delta : typeof event.text_delta === 'string' ? event.text_delta : typeof delta.text === 'string' ? delta.text : typeof delta.content === 'string' ? delta.content : null)
    if (reasoning) chunks.push({ type: 'reasoning-delta', text: reasoning, ...withMessageId })
  } else {
    const delta = isRecord(event.delta) ? event.delta : event
    const text = typeof event.delta === 'string' ? event.delta : typeof event.text_delta === 'string' ? event.text_delta : typeof delta.text === 'string' ? delta.text : typeof delta.content === 'string' ? delta.content : null
    if (explicitReasoning) chunks.push({ type: 'reasoning-delta', text: explicitReasoning, ...withMessageId })
    if (text !== null && text.length > 0 && !['result', 'final', 'error'].includes(eventType)) chunks.push({ type: 'text-delta', text, ...withMessageId })
    const message = isRecord(event.message) ? event.message : null
    const messageContent = message === null ? null : textContent(message.content)
    if (messageContent) chunks.push({ type: 'text-delta', text: messageContent, ...withMessageId })
    if (message === null && text === null) {
      const content = textContent(event.content)
      if (content) chunks.push({ type: 'text-delta', text: content, ...withMessageId })
    }
  }
  const nestedTool = isToolRecord(event.tool_call)
    ? event.tool_call
    : isToolRecord(event.toolCall)
      ? event.toolCall
      : isToolRecord(event.function)
        ? event.function
        : isToolRecord(event.tool_info)
          ? event.tool_info
          : event
  const toolName = firstToolText(nestedTool.toolName, nestedTool.tool_name, nestedTool.name, event.toolName, event.tool_name)
  const callId = firstToolText(nestedTool.callId, nestedTool.call_id, nestedTool.toolCallId, nestedTool.tool_call_id, nestedTool.toolUseId, nestedTool.tool_use_id, nestedTool.id, event.tool_call_id, event.tool_use_id)
  if ((toolName || callId) && (eventType.includes('tool') || eventType.includes('function') || eventType.includes('command'))) {
    const input = serializeToolValue(nestedTool.input ?? nestedTool.arguments ?? nestedTool.args ?? nestedTool.parameters)
    const output = serializeToolValue(nestedTool.output ?? nestedTool.result)
    const error = serializeToolValue(nestedTool.error)
    const fallback = error !== undefined || eventType.includes('error') || eventType.includes('fail')
      ? 'failed'
      : output !== undefined || eventType.includes('result') || eventType.includes('complete')
        ? 'completed'
        : 'running'
    chunks.push({
      type: 'tool-event',
      toolName: toolName ?? 'tool',
      status: normalizeToolStatus(nestedTool.status ?? nestedTool.state, fallback),
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(output !== undefined ? { outputMode: eventType.includes('delta') ? 'delta' as const : 'snapshot' as const } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(firstToolText(nestedTool.agentId, nestedTool.agent_id) ? { agentId: firstToolText(nestedTool.agentId, nestedTool.agent_id)! } : {}),
      ...(serializeToolValue(nestedTool.detail) !== undefined ? { detail: serializeToolValue(nestedTool.detail)! } : {}),
    })
  }
  const usage = isRecord(value.usage) ? value.usage : isRecord(event.usage) ? event.usage : null
  const usageEvent = usageChunk(usage)
  if (usageEvent) chunks.push(usageEvent)
  const failure = readFailure(value, event)
  if (failure !== undefined) {
    chunks.push({ type: 'finish', reason: cancelled ? 'cancel' : 'error', ...(cancelled ? {} : { failure }) })
  } else if (['result', 'turn_end', 'done', 'complete', 'completed', 'final'].includes(eventType) || type === 'result') {
    chunks.push({ type: 'finish', reason: cancelled ? 'cancel' : 'stop' })
  }
  return chunks
}

function closeStdin(child: CodingNsChildProcess): void {
  const stdin = child.stdin
  if (stdin === null) return
  if (stdin.writableEnded === true) return
  try { stdin.end() } catch { /* 子进程可能已提前关闭 stdin */ }
}

interface ErrorEmitterLike {
  on(event: string, listener: (error: unknown) => void): unknown
}

function addErrorListener(value: unknown, listener: (error: unknown) => void): void {
  if (value === null || typeof value !== 'object') return
  const emitter = value as Partial<ErrorEmitterLike>
  if (typeof emitter.on === 'function') emitter.on('error', listener)
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function readFailure(value: Record<string, unknown>, event: Record<string, any>): { message: string; code?: string } | undefined {
  const candidate = event.error ?? event.errorMessage ?? event.error_message ?? value.error ?? value.errorMessage ?? value.error_message
  const message = typeof candidate === 'string'
    ? candidate.trim()
    : isRecord(candidate)
      ? [candidate.message, candidate.detail, candidate.description].find((item): item is string => typeof item === 'string' && item.trim() !== '')?.trim()
      : undefined
  if (!message) return undefined
  const codeValue = isRecord(candidate) ? candidate.code ?? candidate.errorCode ?? candidate.error_code : value.code ?? value.errorCode
  const code = typeof codeValue === 'string' && codeValue.trim() !== '' ? codeValue.trim() : undefined
  return code === undefined ? { message } : { message, code }
}

function parseHelpModels(output: string): CodingNsCliModelCatalog {
  const models: Array<{ id: string; name: string; description?: string; efforts: readonly string[] }> = []
  const seen = new Set<string>()
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/(?:--model(?:=|\s+)|model(?:s)?\s*:\s*)([A-Za-z0-9][A-Za-z0-9_./:-]{2,})/iu)
    const id = match?.[1]
    if (!id || /^(?:model|models|string|value)$/iu.test(id) || seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: id, efforts: [] })
  }
  return models.length === 0 ? emptyCatalog() : { groups: [{ id: 'default', name: '可用模型', models }], currentModel: null, currentEffort: null }
}
