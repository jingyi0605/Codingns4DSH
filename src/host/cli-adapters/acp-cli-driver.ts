import { spawn, spawnSync } from 'node:child_process'
import type {
  CodingNsAgentEvent,
  CodingNsCliCapability,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, streamRpcRequest, usageChunk } from './rpc-driver-utils.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { buildAcpPromptBlocks } from './attachment-utils.js'
import { acpBridgeMcpServers } from '../cli-bridge/injections.js'
import { advanceCodingNsSegment, createCodingNsSegmentState, decorateCodingNsSegmentEvent } from './stream-normalizer.js'
import { reasoningText } from './reasoning-content.js'

export interface AcpCliDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  /** 传给 Provider 子进程的环境覆盖；不会改写 Host 自身的 process.env。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** ACP 的启动参数；每个产品的参数必须在驱动文件中显式写出。 */
  readonly args: readonly string[]
  /**
   * 按当前会话选择生成启动参数。Cursor 的 ACP 只能在进程启动时固定模型，
   * 因此不能把所有产品都强行塞进 session/set_model。
   */
  readonly buildArgs?: (input: CodingNsCliTurnInput) => readonly string[]
  /** Provider 是否支持在已经建立的 ACP 会话内切换模型。 */
  readonly runtimeModelSelection?: boolean
  /** 读取 Provider 自己公开的只读模型目录；返回 null 表示本次读取失败。 */
  readonly readModelCatalog?: (command: string, runSpawnSync: typeof spawnSync) => CodingNsCliModelCatalog | null
  readonly id: string
  readonly name: string
  /** 只保留已经验证的能力，默认不声明 usage/fork/压缩/权限交互。 */
  readonly capabilities: readonly CodingNsCliCapability[]
  /** 模型目录没有从 ACP 返回时使用的静态回退；未知时应传空目录。 */
  readonly fallbackCatalog?: CodingNsCliModelCatalog
  /** 产品没有可靠的本地会话索引时保持 unknown，不扫描猜测路径。 */
  readonly probeReason?: string
}

interface AcpSession {
  readonly rpc: JsonRpcProcess
  readonly cwd: string | undefined
  readonly argsKey: string
  acpSessionId: string
}

/**
 * Cursor/Kiro 共用的最小 ACP 驱动。
 *
 * ACP 的权限请求在这两个适配器上没有可验证的 DSH 应答能力，因此统一拒绝；
 * 驱动不声明 permission/questions/usage/fork 等能力，避免把协议字段误当能力。
 */
export class AcpCliDriver implements CodingNsCliDriver {
  readonly descriptor
  /** Cursor/Kiro 的 ACP 流可由 Registry 在工具完成后暂停并续读。 */
  readonly supportsToolStepSplitting = true
  private readonly binaries: readonly string[]
  private readonly args: readonly string[]
  private readonly buildArgsForTurn: (input: CodingNsCliTurnInput) => readonly string[]
  private readonly runtimeModelSelection: boolean
  private readonly readModelCatalog: AcpCliDriverOptions['readModelCatalog']
  private readonly fallbackCatalog: CodingNsCliModelCatalog
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly environment: Readonly<Record<string, string | undefined>>
  private readonly probeReason: string
  private cachedBinary: string | null = null
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly sessions = new Map<string, AcpSession>()

  constructor(options: AcpCliDriverOptions) {
    this.descriptor = {
      id: options.id,
      name: options.name,
      protocol: 'acp' as const,
      capabilities: options.capabilities,
    }
    this.binaries = options.binaries ?? []
    this.args = options.args
    this.buildArgsForTurn = options.buildArgs ?? (() => this.args)
    this.runtimeModelSelection = options.runtimeModelSelection ?? true
    this.readModelCatalog = options.readModelCatalog
    this.fallbackCatalog = options.fallbackCatalog ?? emptyCatalog()
    const baseSpawnSync = options.spawnSync ?? spawnSync
    this.environment = options.environment ?? {}
    this.runSpawnSync = Object.keys(this.environment).length === 0
      ? baseSpawnSync
      : ((command, args, spawnOptions) => baseSpawnSync(command, args, {
        ...spawnOptions,
        // detectBinary 先注入 commandEnvironment；Provider 的显式环境必须最后覆盖它。
        env: { ...process.env, ...(spawnOptions?.env ?? {}), ...this.environment },
      })) as typeof spawnSync
    this.runSpawn = options.spawn ?? spawn
    this.probeReason = options.probeReason ?? 'Provider 未公开可安全读取的会话索引，未执行有副作用的探测'
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    if (this.readModelCatalog !== undefined) {
      const command = (await this.detect()).command
      if (command === null) return this.fallbackCatalog
      try {
        const catalog = this.readModelCatalog(command, this.runSpawnSync)
        if (catalog !== null && catalog.groups.some((group) => group.models.length > 0)) return catalog
      } catch { /* 目录读取失败时继续使用明确的静态回退。 */ }
    }
    // ACP 的 session/new 会创建 Provider 会话，不能拿“列模型”当探测手段。
    // 没有只读目录时返回静态回退，由 Client 按 Provider 默认模型运行。
    return this.fallbackCatalog
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    if (!input.providerSessionId?.trim()) return { state: 'unknown', reason: '缺少 Provider 会话标识' }
    return { state: 'unknown', reason: this.probeReason }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error(`${this.descriptor.name} 未安装`)
    const session = await this.getSession(input, command, this.buildArgsForTurn(input))
    let providerSessionId = session.acpSessionId
    if (providerSessionId === '') {
      const created = input.providerSessionId === undefined
        ? await session.rpc.request('session/new', {
          cwd: input.cwd ?? process.cwd(),
          mcpServers: acpBridgeMcpServers(input.sessionId, this.descriptor.id),
        }, { signal: input.signal, killOnAbort: false })
        : await this.loadOrCreate(session.rpc, input)
      providerSessionId = readSessionId(created) ?? input.providerSessionId ?? input.sessionId
      session.acpSessionId = providerSessionId
    }
    yield { type: 'session-binding', providerSessionId }

    if (this.runtimeModelSelection && input.modelId && input.modelId !== 'provider-default') {
      await session.rpc.request('session/set_model', { sessionId: providerSessionId, modelId: input.modelId }, { signal: input.signal, killOnAbort: false }).catch(() => undefined)
    }

    let emittedFinish = false
    const segmentState = createCodingNsSegmentState()
    try {
      const stream = streamRpcRequest(session.rpc, 'session/prompt', {
        sessionId: providerSessionId,
        prompt: await buildAcpPromptBlocks(input.prompt, input.attachments ?? []),
      }, input.signal, { dispose: false, killOnAbort: false })
      let response: unknown
      while (true) {
        const next = await stream.next()
        if (next.done) {
          response = next.value
          break
        }
        const rawChunk = acpMessageToChunk(next.value, input.signal?.aborted ?? false)
        const chunk = rawChunk === null ? null : decorateCodingNsSegmentEvent(rawChunk, input, segmentState, this.descriptor.id)
        if (chunk === null) continue
        if (chunk.type === 'finish') emittedFinish = true
        yield chunk
        advanceCodingNsSegment(chunk, segmentState)
      }
      if (input.signal?.aborted) {
        if (!emittedFinish) yield { type: 'finish', reason: 'cancel' }
      } else if (!emittedFinish) {
        yield { type: 'finish', reason: promptReason(response) }
      }
    } catch (error) {
      if (input.signal?.aborted) {
        if (!emittedFinish) yield { type: 'finish', reason: 'cancel' }
      } else if (!emittedFinish) {
        yield { type: 'finish', reason: 'error', failure: failureFromUnknown(error) }
      }
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.acpSessionId === '') return
    await session.rpc.request('session/cancel', { sessionId: session.acpSessionId }, { killOnAbort: false }).catch(() => undefined)
  }

  dispose(): void {
    for (const rpc of this.processes) rpc.dispose()
    this.processes.clear()
    this.sessions.clear()
    this.cachedBinary = null
  }

  private async getSession(input: CodingNsCliTurnInput, command: string, args: readonly string[]): Promise<AcpSession> {
    const argsKey = JSON.stringify(args)
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd && previous.argsKey === argsKey && !previous.rpc.isClosed) return previous
    previous?.rpc.dispose()
    const rpc = new JsonRpcProcess({ command, args, cwd: input.cwd, env: this.environment, spawn: this.runSpawn })
    const state: AcpSession = { rpc, cwd: input.cwd, argsKey, acpSessionId: '' }
    this.processes.add(rpc)
    this.sessions.set(input.sessionId, state)
    rpc.addExitListener(() => {
      this.processes.delete(rpc)
      if (this.sessions.get(input.sessionId)?.rpc === rpc) this.sessions.delete(input.sessionId)
    })
    // 没有 DSH 权限应答通道时拒绝 Provider 的交互式授权，防止轮次永久等待。
    rpc.setServerRequestHandler(() => ({ outcome: { outcome: 'cancelled' } }))
    try {
      await this.initialize(rpc, input.signal)
      return state
    } catch (error) {
      rpc.dispose()
      if (this.sessions.get(input.sessionId)?.rpc === rpc) this.sessions.delete(input.sessionId)
      throw error
    }
  }

  private async initialize(rpc: JsonRpcProcess, signal?: AbortSignal): Promise<void> {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
      clientCapabilities: {},
    }, { signal, killOnAbort: false })
    rpc.notify('initialized', {})
  }

  private async loadOrCreate(rpc: JsonRpcProcess, input: CodingNsCliTurnInput): Promise<unknown> {
    if (input.providerSessionId) {
      // 恢复失败必须把真实错误交给 Host，不能静默新建会话重放用户请求。
      // 新会话会丢失原上下文，也会把“会话损坏”伪装成一次成功的空白对话。
      return rpc.request('session/load', {
        sessionId: input.providerSessionId,
        cwd: input.cwd ?? process.cwd(),
        mcpServers: acpBridgeMcpServers(input.sessionId, this.descriptor.id),
      }, { signal: input.signal, killOnAbort: false })
    }
    return rpc.request('session/new', {
      cwd: input.cwd ?? process.cwd(),
      mcpServers: acpBridgeMcpServers(input.sessionId, this.descriptor.id),
    }, { signal: input.signal, killOnAbort: false })
  }
}

function acpMessageToChunk(message: JsonRpcMessage, cancelled: boolean): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const rawType = update.sessionUpdate ?? update.type ?? message.method
  const type = typeof rawType === 'string' ? rawType.toLowerCase() : ''
  const text = acpText(update.delta ?? update.text ?? update.content ?? update.message)
  const content = isRecord(update.content) ? update.content : undefined
  const messageId = firstToolText(update.messageId, update.message_id, update.itemId, update.item_id, content?.messageId, content?.message_id, content?.id)
  const withMessageId = messageId === undefined ? {} : { messageId }
  const reasoning = reasoningText(update)
  if (reasoning !== null) return { type: 'reasoning-delta', text: reasoning, ...withMessageId }
  if (type.includes('thought') || type.includes('reason')) return text === null ? null : { type: 'reasoning-delta', text, ...withMessageId }
  if (type.includes('agent_message') || type.includes('message_chunk') || type === 'text' || type.includes('text_delta')) return text === null ? null : { type: 'text-delta', text, ...withMessageId }
  if (type.includes('tool') || type.includes('command')) return toolChunk(update, type)
  const usage = usageChunk(isRecord(update.usage) ? update.usage : update)
  if (usage !== null) return usage
  if (type.includes('error') || type.includes('failed')) {
    const failure = failureFromRecord(update)
    return { type: 'finish', reason: cancelled ? 'cancel' : 'error', ...(cancelled || failure === undefined ? {} : { failure }) }
  }
  if (type.includes('turn_completed') || type.includes('turn_complete') || type === 'completed' || type === 'done' || type === 'prompt_end') return { type: 'finish', reason: cancelled ? 'cancel' : 'stop' }
  return null
}

function toolChunk(update: Record<string, any>, type: string): CodingNsAgentEvent | null {
  const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
  const name = firstToolText(tool.name, tool.toolName, tool.tool_name, tool.title, update.name, update.toolName, update.title)
  const callId = firstToolText(tool.callId, tool.call_id, tool.toolCallId, tool.tool_call_id, tool.id, update.toolCallId, update.tool_call_id, update.id)
  if (!name && !callId) return null
  const input = serializeToolValue(tool.rawInput ?? tool.input ?? tool.arguments ?? tool.args ?? tool.parameters ?? update.rawInput)
  const output = serializeToolValue(tool.rawOutput ?? tool.output ?? tool.result ?? update.rawOutput ?? update.content)
  const error = serializeToolValue(tool.error ?? update.error)
  const fallback = error !== undefined || type.includes('error') || type.includes('fail') ? 'failed' : output !== undefined || type.includes('result') || type.includes('complete') ? 'completed' : 'running'
  return {
    type: 'tool-event', toolName: name ?? 'tool', status: normalizeToolStatus(tool.status ?? tool.state ?? update.status, fallback),
    ...(callId ? { callId } : {}), ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output, outputMode: type.includes('delta') ? 'delta' as const : 'snapshot' as const } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

function readSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const id = firstToolText(value.sessionId, value.session_id, value.id)
  if (id) return id
  if (isRecord(value.session)) return firstToolText(value.session.sessionId, value.session.id) ?? undefined
  return undefined
}

function promptReason(value: unknown): 'stop' | 'cancel' | 'error' {
  if (!isRecord(value) || typeof value.stopReason !== 'string') return 'stop'
  const reason = value.stopReason.toLowerCase()
  return reason === 'cancelled' || reason === 'canceled' ? 'cancel' : reason === 'error' || reason === 'failed' ? 'error' : 'stop'
}

function failureFromUnknown(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) return { message: error.message }
  return { message: 'Provider ACP 请求失败' }
}

function failureFromRecord(value: Record<string, any>): { message: string; code?: string } | undefined {
  const error = isRecord(value.error) ? value.error : value
  const message = firstToolText(error.message, error.errorMessage, error.error_message, error.detail, error.reason)
  if (!message) return undefined
  const code = firstToolText(error.code, error.errorCode, error.error_code)
  return code ? { message, code } : { message }
}

function acpText(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (Array.isArray(value)) {
    const text = value.map((item) => acpText(item) ?? '').join('')
    return text === '' ? null : text
  }
  if (isRecord(value)) {
    for (const key of ['text', 'delta', 'content', 'message']) {
      const nested = acpText(value[key])
      if (nested !== null) return nested
    }
  }
  return null
}
