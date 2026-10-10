import { spawn, spawnSync } from 'node:child_process'
import type {
  CodingNsAgentEvent,
  CodingNsAgentPermissionResponse,
  CodingNsAgentQuestion,
  CodingNsAgentQuestionResponse,
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
import { ACP_FORM_CLIENT_CAPABILITIES, acpElicitationResponse, readAcpElicitationRequest } from './acp-elicitation.js'

export interface AcpCliDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  /** 传给 Provider 子进程的环境覆盖；不会改写 Host 自身的 process.env。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** 仅在 ACP 会话进程启动时加载的扩展环境；不参与版本、路径或模型探测。 */
  readonly sessionEnvironment?: Readonly<Record<string, string | undefined>>
  /** 按当前 DSH 会话生成 ACP 子进程的扩展环境；不参与版本、路径或模型探测。 */
  readonly sessionEnvironmentForInput?: (input: CodingNsCliTurnInput) => Readonly<Record<string, string | undefined>>
  /** ACP 的启动参数；每个产品的参数必须在驱动文件中显式写出。 */
  readonly args: readonly string[]
  /**
   * 按当前会话选择生成启动参数。Cursor 的 ACP 只能在进程启动时固定模型，
   * 因此不能把所有产品都强行塞进 session/set_model。
   */
  readonly buildArgs?: (input: CodingNsCliTurnInput) => readonly string[]
  /** Provider 是否支持在已经建立的 ACP 会话内切换模型。 */
  readonly runtimeModelSelection?: boolean
  /** 产品通过原生 ACP 请求设置会话模型、权限和思考强度；失败时禁止继续发送 prompt。 */
  readonly configureSession?: (rpc: JsonRpcProcess, sessionId: string, input: CodingNsCliTurnInput) => Promise<void>
  /** 读取 Provider 自己公开的只读模型目录；返回 null 表示本次读取失败。 */
  readonly readModelCatalog?: (command: string, runSpawnSync: typeof spawnSync, environment: Readonly<Record<string, string | undefined>>) => CodingNsCliModelCatalog | null | Promise<CodingNsCliModelCatalog | null>
  readonly id: string
  readonly name: string
  /** 只保留已经验证的能力，默认不声明 usage/fork/压缩/权限交互。 */
  readonly capabilities: readonly CodingNsCliCapability[]
  /** 模型目录没有从 ACP 返回时使用的静态回退；未知时应传空目录。 */
  readonly fallbackCatalog?: CodingNsCliModelCatalog
  /** 产品没有可靠的本地会话索引时保持 unknown，不扫描猜测路径。 */
  readonly probeReason?: string
  /** Provider 自定义的问题请求解析器；标准 ACP form 由默认解析器处理。 */
  readonly readQuestionRequest?: (message: JsonRpcMessage) => AcpPendingQuestionRequest | null
  /** 在 DSH 已明确授权的范围内自动回应 ACP 权限请求；返回 undefined 继续交给原生审批面板。 */
  readonly decidePermission?: (message: JsonRpcMessage, input: CodingNsCliTurnInput) => 'allow' | 'reject' | undefined
  /** Provider 可在 Host 侧补齐 ACP 未携带的上下文窗口等用量字段。 */
  readonly enrichUsage?: (
    usage: Extract<CodingNsAgentEvent, { type: 'usage' }>,
    input: CodingNsCliTurnInput,
  ) => Extract<CodingNsAgentEvent, { type: 'usage' }>
}

/** ACP 交互问题在 Host 中等待 DSH 回答时保留的请求状态。 */
export interface AcpPendingQuestionRequest {
  readonly requestId: string
  readonly rpcId: number | string
  readonly questions: readonly CodingNsAgentQuestion[]
  readonly respond: (response: CodingNsAgentQuestionResponse) => unknown
}

interface AcpSession {
  readonly rpc: JsonRpcProcess
  readonly cwd: string | undefined
  readonly argsKey: string
  acpSessionId: string
  readonly permissions: Map<string, AcpPermissionRequest>
  readonly questions: Map<string, AcpPendingQuestionRequest>
  /** 已由 Host 自动回应的请求不会再投影成 UI 权限组件。 */
  readonly autoResolvedPermissions: Set<string>
}

interface AcpPermissionRequest {
  readonly rpcId: number | string
  readonly allowOptionId: string
  readonly rejectOptionId: string
}

/**
 * Cursor/Kiro 共用的最小 ACP 驱动。
 *
 * ACP 标准权限和 form elicitation 请求由本驱动保留原始 JSON-RPC id，并通过
 * 统一权限/问题事件交给 DSH 原生组件；未知的扩展 server request 仍然快速取消，
 * 避免 Provider 永久等待。URL elicitation 需要浏览器安全同意流程，本驱动不宣告。
 */
export class AcpCliDriver implements CodingNsCliDriver {
  readonly descriptor
  /** Cursor/Kiro 的 ACP 流可由 Registry 在工具完成后暂停并续读。 */
  readonly supportsToolStepSplitting = true
  private readonly binaries: readonly string[]
  private readonly args: readonly string[]
  private readonly buildArgsForTurn: (input: CodingNsCliTurnInput) => readonly string[]
  private readonly runtimeModelSelection: boolean
  private readonly configureSession: AcpCliDriverOptions['configureSession']
  private readonly readModelCatalog: AcpCliDriverOptions['readModelCatalog']
  private readonly fallbackCatalog: CodingNsCliModelCatalog
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly environment: Readonly<Record<string, string | undefined>>
  private readonly sessionEnvironment: Readonly<Record<string, string | undefined>>
  private readonly sessionEnvironmentForInput: (input: CodingNsCliTurnInput) => Readonly<Record<string, string | undefined>>
  private readonly probeReason: string
  private readonly readQuestionRequest: (message: JsonRpcMessage) => AcpPendingQuestionRequest | null
  private readonly decidePermission: AcpCliDriverOptions['decidePermission']
  private readonly enrichUsage: AcpCliDriverOptions['enrichUsage']
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
    this.configureSession = options.configureSession
    this.readModelCatalog = options.readModelCatalog
    this.fallbackCatalog = options.fallbackCatalog ?? emptyCatalog()
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.environment = options.environment ?? {}
    this.sessionEnvironment = { ...this.environment, ...(options.sessionEnvironment ?? {}) }
    this.sessionEnvironmentForInput = options.sessionEnvironmentForInput ?? (() => ({}))
    this.runSpawn = options.spawn ?? spawn
    this.probeReason = options.probeReason ?? 'Provider 未公开可安全读取的会话索引，未执行有副作用的探测'
    this.readQuestionRequest = options.readQuestionRequest ?? readStandardQuestionRequest
    this.decidePermission = options.decidePermission
    this.enrichUsage = options.enrichUsage
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync, environment: this.environment })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    if (this.readModelCatalog !== undefined) {
      const command = (await this.detect()).command
      if (command === null) return this.fallbackCatalog
      try {
        const catalog = await this.readModelCatalog(command, this.runSpawnSync, this.environment)
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

  /** 回复 ACP 标准 `session/request_permission`，只使用 Provider 给出的选项 id。 */
  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const session = this.sessions.get(sessionId)
    const pending = session?.permissions.get(response.requestId)
    if (session === undefined || pending === undefined) throw new Error(`${this.descriptor.name} 权限请求不存在`)
    session.permissions.delete(response.requestId)
    session.rpc.respond(pending.rpcId, {
      outcome: {
        outcome: 'selected',
        optionId: response.approved ? pending.allowOptionId : pending.rejectOptionId,
      },
    })
  }

  /** 回复 ACP 标准 `elicitation/create` 的 form 内容。 */
  respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): void {
    const session = this.sessions.get(sessionId)
    const pending = session?.questions.get(response.requestId)
    if (session === undefined || pending === undefined) throw new Error(`${this.descriptor.name} 问题请求不存在`)
    session.questions.delete(response.requestId)
    session.rpc.respond(pending.rpcId, pending.respond(response))
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

    await this.configureSession?.(session.rpc, providerSessionId, input)
    if (this.runtimeModelSelection && input.modelId && input.modelId !== 'provider-default') {
      await session.rpc.request('session/set_model', { sessionId: providerSessionId, modelId: input.modelId }, { signal: input.signal, killOnAbort: false }).catch(() => undefined)
    }

    let emittedFinish = false
    let pendingFinish: Extract<CodingNsAgentEvent, { type: 'finish' }> | null = null
    let latestUsage: Extract<CodingNsAgentEvent, { type: 'usage' }> | null = null
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
        const rawChunk = acpMessageToChunk(next.value, input.signal?.aborted ?? false, this.readQuestionRequest, session.autoResolvedPermissions)
        const enrichedChunk = rawChunk?.type === 'usage' ? this.enrichUsage?.(rawChunk, input) ?? rawChunk : rawChunk
        const chunk = enrichedChunk === null ? null : decorateCodingNsSegmentEvent(enrichedChunk, input, segmentState, this.descriptor.id)
        if (chunk === null) continue
        if (chunk.type === 'usage') {
          latestUsage = mergeAcpUsageContext(chunk, latestUsage)
          // Command Code 的 usage_update 只报告上下文占用，等最终响应的 token
          // 统计到达后合并成一个完整用量事件，避免同一轮写入两个重复样本。
          if (isContextOnlyUsage(chunk)) continue
        }
        if (chunk.type === 'finish') {
          emittedFinish = true
          // ACP 的结束通知可能先于 session/prompt 响应到达；先缓存，确保响应中的
          // 最终 token 用量在 finish 之前投影给 DSH。
          pendingFinish = chunk
          continue
        }
        yield chunk
        advanceCodingNsSegment(chunk, segmentState)
      }
      if (input.signal?.aborted) {
        if (pendingFinish !== null) {
          yield pendingFinish
          advanceCodingNsSegment(pendingFinish, segmentState)
        } else if (!emittedFinish) {
          yield { type: 'finish', reason: 'cancel' }
        }
      } else {
        const responseUsage = acpResponseUsage(response)
        if (responseUsage !== null) {
          const mergedUsage = mergeAcpUsageContext(responseUsage, latestUsage)
          yield this.enrichUsage?.(mergedUsage, input) ?? mergedUsage
        } else if (latestUsage !== null && isContextOnlyUsage(latestUsage)) {
          yield latestUsage
        }
        if (pendingFinish !== null) {
          yield pendingFinish
          advanceCodingNsSegment(pendingFinish, segmentState)
        } else if (!emittedFinish) {
          yield { type: 'finish', reason: promptReason(response) }
        }
      }
    } catch (error) {
      if (input.signal?.aborted) {
        if (pendingFinish !== null) {
          yield pendingFinish
          advanceCodingNsSegment(pendingFinish, segmentState)
        } else if (!emittedFinish) {
          yield { type: 'finish', reason: 'cancel' }
        }
      } else if (pendingFinish !== null) {
        yield pendingFinish
        advanceCodingNsSegment(pendingFinish, segmentState)
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
    // 会话级注入必须在每次创建 ACP 进程时重新计算：桥接端点、令牌和父会话身份
    // 都是运行时状态，不能在驱动构造时静态捕获。runtimeEnv 先于专用注入合并，
    // 让桥接身份始终由 Host 掌握，避免调用方覆盖 CODINGNS_* 变量。
    const sessionEnvironment = {
      ...this.sessionEnvironment,
      ...(input.runtimeEnv ?? {}),
      ...this.sessionEnvironmentForInput(input),
    }
    const rpc = new JsonRpcProcess({ command, args, cwd: input.cwd, env: sessionEnvironment, spawn: this.runSpawn })
    const state: AcpSession = {
      rpc,
      cwd: input.cwd,
      argsKey,
      acpSessionId: '',
      permissions: new Map(),
      questions: new Map(),
      autoResolvedPermissions: new Set(),
    }
    this.processes.add(rpc)
    this.sessions.set(input.sessionId, state)
    rpc.addExitListener(() => {
      this.processes.delete(rpc)
      if (this.sessions.get(input.sessionId)?.rpc === rpc) this.sessions.delete(input.sessionId)
    })
    // ACP 标准权限请求必须等待 DSH 原生审批；未知扩展请求仍快速取消，避免
    // Provider 因没有对应能力而永久挂起。
    rpc.setServerRequestHandler((message) => {
      const elicitation = this.readQuestionRequest(message)
      if (elicitation !== null) {
        state.questions.set(elicitation.requestId, elicitation)
        return new Promise<never>(() => undefined)
      }
      if (message.method === 'elicitation/create') return { action: 'cancel' }
      const permission = readAcpPermissionRequest(message)
      if (permission === null || message.id === undefined || message.id === null) {
        return { outcome: { outcome: 'cancelled' } }
      }
      const decision = this.decidePermission?.(message, input)
      if (decision !== undefined) {
        state.autoResolvedPermissions.add(permission.requestId)
        return {
          outcome: {
            outcome: 'selected',
            optionId: decision === 'allow' ? permission.allowOptionId : permission.rejectOptionId,
          },
        }
      }
      state.permissions.set(permission.requestId, {
        rpcId: message.id,
        allowOptionId: permission.allowOptionId,
        rejectOptionId: permission.rejectOptionId,
      })
      return new Promise<never>(() => undefined)
    })
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
      clientCapabilities: ACP_FORM_CLIENT_CAPABILITIES,
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

function acpMessageToChunk(
  message: JsonRpcMessage,
  cancelled: boolean,
  readQuestionRequest: (message: JsonRpcMessage) => AcpPendingQuestionRequest | null,
  autoResolvedPermissions?: Set<string>,
): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const rawType = update.sessionUpdate ?? update.type ?? message.method
  const type = typeof rawType === 'string' ? rawType.toLowerCase() : ''
  const text = acpText(update.delta ?? update.text ?? update.content ?? update.message)
  const content = isRecord(update.content) ? update.content : undefined
  const messageId = firstToolText(update.messageId, update.message_id, update.itemId, update.item_id, content?.messageId, content?.message_id, content?.id)
  const withMessageId = messageId === undefined ? {} : { messageId }
  const elicitation = readQuestionRequest(message)
  if (elicitation !== null) return { type: 'question-request', requestId: elicitation.requestId, questions: elicitation.questions }
  const permission = readAcpPermissionRequest(message)
  if (permission !== null) {
    if (autoResolvedPermissions?.delete(permission.requestId) === true) return null
    return {
      type: 'permission-request',
      requestId: permission.requestId,
      kind: permission.kind,
      ...(permission.toolName === undefined ? {} : { toolName: permission.toolName }),
      ...(permission.callId === undefined ? {} : { callId: permission.callId }),
      ...(permission.detail === undefined ? {} : { detail: permission.detail }),
    }
  }
  const reasoning = reasoningText(update)
  if (reasoning !== null) return { type: 'reasoning-delta', text: reasoning, ...withMessageId }
  if (type.includes('thought') || type.includes('reason')) return text === null ? null : { type: 'reasoning-delta', text, ...withMessageId }
  if (type.includes('agent_message') || type.includes('message_chunk') || type === 'text' || type.includes('text_delta')) return text === null ? null : { type: 'text-delta', text, ...withMessageId }
  if (type.includes('tool') || type.includes('command')) return toolChunk(update, type)
  if (type === 'usage_update' || type === 'usage-update') {
    const used = nonNegativeNumber(update.used ?? update.contextTokens ?? update.context_tokens)
    const size = positiveNumber(update.size ?? update.contextWindow ?? update.context_window)
    if (used === undefined && size === undefined) return null
    return usageEvent({
      inputTokens: 0,
      outputTokens: 0,
      ...(used === undefined ? {} : { contextTokens: used }),
      ...(size === undefined ? {} : { contextWindow: size }),
      ...(used === undefined || size === undefined ? {} : { contextUsageRatio: Math.min(1, used / size) }),
    })
  }
  const usage = usageChunk(isRecord(update.usage) ? update.usage : update)
  if (usage?.type === 'usage') return usage
  if (type.includes('error') || type.includes('failed')) {
    const failure = failureFromRecord(update)
    return { type: 'finish', reason: cancelled ? 'cancel' : 'error', ...(cancelled || failure === undefined ? {} : { failure }) }
  }
  if (type.includes('turn_completed') || type.includes('turn_complete') || type === 'completed' || type === 'done' || type === 'prompt_end') return { type: 'finish', reason: cancelled ? 'cancel' : 'stop' }
  return null
}

type AcpUsageEvent = Extract<CodingNsAgentEvent, { type: 'usage' }>

function usageEvent(value: unknown): AcpUsageEvent | null {
  const usage = usageChunk(value)
  return usage?.type === 'usage' ? usage : null
}

function acpResponseUsage(value: unknown): AcpUsageEvent | null {
  if (!isRecord(value)) return null
  const metadata = isRecord(value._meta) ? value._meta : undefined
  return usageEvent(metadata?.usage ?? value.usage)
}

function mergeAcpUsageContext(usage: AcpUsageEvent, previous: AcpUsageEvent | null): AcpUsageEvent {
  if (previous === null) return usage
  const contextWindow = usage.contextWindow ?? previous.contextWindow
  const contextTokens = usage.contextTokens ?? previous.contextTokens
  return {
    ...usage,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(usage.contextUsageRatio !== undefined || contextWindow === undefined || contextTokens === undefined
      ? {}
      : { contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)) }),
  }
}

function isContextOnlyUsage(usage: AcpUsageEvent): boolean {
  return usage.inputTokens === 0
    && usage.outputTokens === 0
    && (usage.contextWindow !== undefined || usage.contextTokens !== undefined || usage.contextUsageRatio !== undefined)
}

/** 读取 ACP v1/v2 标准权限请求；未知扩展字段不会被当成权限。 */
function readAcpPermissionRequest(message: JsonRpcMessage): {
  readonly requestId: string
  readonly kind: string
  readonly toolName?: string
  readonly callId?: string
  readonly detail?: string
  readonly allowOptionId: string
  readonly rejectOptionId: string
} | null {
  const method = typeof message.method === 'string' ? message.method.toLowerCase() : ''
  const params = isRecord(message.params) ? message.params : {}
  // ACP v1 的可回传权限只有 server request；session/update 中同名扩展没有
  // 可验证的响应方法，不能把它投影成可回传的 DSH 权限事件。
  if (method !== 'session/request_permission') return null
  const requestId = message.id ?? params.requestId ?? params.request_id ?? params.id
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return null
  const tool = isRecord(params.toolCall) ? params.toolCall : isRecord(params.tool_call) ? params.tool_call : {}
  const toolName = firstToolText(tool.title, tool.name, tool.toolName, params.toolName, params.tool_name)
  const callId = firstToolText(tool.toolCallId, tool.tool_call_id, tool.callId, tool.call_id, params.callId, params.call_id)
  const detail = firstToolText(params.detail, params.reason, params.message, tool.detail)
  const kind = firstToolText(params.kind, params.permissionKind, tool.kind) ?? toolName ?? 'unknown'
  const options = Array.isArray(params.options) ? params.options : []
  const ids = options.flatMap((option) => {
    if (!isRecord(option)) return []
    const id = firstToolText(option.optionId, option.option_id, option.id)
    if (id === undefined) return []
    const optionKind = firstToolText(option.kind, option.type)?.toLowerCase() ?? ''
    return [{ id, kind: optionKind }]
  })
  return {
    requestId: String(requestId), kind,
    ...(toolName === undefined ? {} : { toolName }),
    ...(callId === undefined ? {} : { callId }),
    ...(detail === undefined ? {} : { detail }),
    allowOptionId: ids.find((option) => /allow|approve|accept/u.test(option.kind))?.id ?? ids[0]?.id ?? 'allow-once',
    rejectOptionId: ids.find((option) => /reject|deny|decline|cancel/u.test(option.kind))?.id ?? ids[1]?.id ?? 'reject-once',
  }
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

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readStandardQuestionRequest(message: JsonRpcMessage): AcpPendingQuestionRequest | null {
  const request = readAcpElicitationRequest(message)
  if (request === null) return null
  return {
    requestId: request.requestId,
    rpcId: request.rpcId,
    questions: request.questions,
    respond: (response) => acpElicitationResponse(request, response),
  }
}
