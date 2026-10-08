import { runAsyncCommand } from './process-utils.js'
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CodingNsAgentEvent, CodingNsCliModelCatalog, CodingNsAgentPermissionResponse, CodingNsAgentQuestion, CodingNsAgentQuestionResponse, CodingNsCliSkillDescriptor, CodingNsCliSkillListInput, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, textValue, usageChunk } from './rpc-driver-utils.js'
import { GROK_CATALOG, isProviderDefaultModel } from './model-catalog.js'
import { isRegularFile, probeStoredSession, resolveSessionDirectory } from './session-probe.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { buildAcpPromptBlocks } from './attachment-utils.js'
import { acpBridgeMcpServers } from '../cli-bridge/injections.js'
import { reasoningText } from './reasoning-content.js'
import { ACP_FORM_CLIENT_CAPABILITIES, acpElicitationResponse, readAcpElicitationRequest, type AcpElicitationRequest } from './acp-elicitation.js'
import { readAgentQuestions } from './interaction-events.js'
import { commandEnvironment, WINDOWS } from './process-utils.js'

interface GrokQuestionPending {
  readonly callId: string
  readonly questions: readonly CodingNsAgentQuestion[]
  rpcId?: number | string
  response?: CodingNsAgentQuestionResponse
}

interface GrokQuestionTool {
  readonly callId: string
  readonly questions: readonly CodingNsAgentQuestion[]
}

export interface GrokBuildDriverOptions {
  readonly binaries?: readonly string[]
  readonly sessionRoots?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/** Grok Build 的 ACP stdio 驱动。ACP 会话和权限细节只在 Host 进程内处理。 */
export class GrokBuildDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'grok', name: 'Grok Build', protocol: 'acp', capabilities: ['models', 'skills', 'stream', 'tool-events', 'reasoning', 'usage', 'permission', 'questions'] as const } as const
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly sessionRoots: readonly string[]
  private cachedBinary: string | null = null
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly sessions = new Map<string, { rpc: JsonRpcProcess; cwd: string | undefined; providerSessionId: string; requests: Map<string, { readonly rpcId: number | string; readonly allowOptionId: string; readonly rejectOptionId: string }>; questions: Map<string, AcpElicitationRequest>; grokQuestions: Map<string, GrokQuestionPending>; grokQuestionCallIds: Set<string>; grokQuestionEventIds: Set<string> }>()

  constructor(options: GrokBuildDriverOptions = {}) {
    this.binaries = options.binaries ?? ['grok', 'grok-build']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    this.sessionRoots = options.sessionRoots ?? [join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'sessions')]
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) return emptyCatalog()
    const rpc = new JsonRpcProcess({ command, args: ['agent', '--no-leader', 'stdio'], spawn: this.runSpawn })
    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
        // 保留 Grok 旧版使用的 capabilities，同时发送 ACP 标准字段。
        capabilities: ACP_FORM_CLIENT_CAPABILITIES,
        clientCapabilities: ACP_FORM_CLIENT_CAPABILITIES,
      })
      rpc.notify('initialized', {})
      const session = await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] })
      const parsed = parseGrokCatalog(session)
      return parsed.groups.length > 0 ? parsed : GROK_CATALOG
    } catch {
      return GROK_CATALOG
    } finally { rpc.dispose() }
  }

  /** Grok 的原生目录同时应用信任、禁用、兼容来源和插件命名规则。 */
  async listSkills(input: CodingNsCliSkillListInput): Promise<readonly CodingNsCliSkillDescriptor[]> {
    if (input.signal?.aborted) throw new Error('Skill 目录读取已取消')
    const cwd = input.cwd?.trim() || process.cwd()
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command !== null) {
      try {
        const result = await runAsyncCommand(this.runSpawnSync, command, ['inspect', '--json'], {
          cwd,
          encoding: 'utf8',
          timeout: 5_000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          shell: WINDOWS,
          env: commandEnvironment(command),
        })
        if (result.status === 0) {
          const catalog = parseGrokSkillCatalog(`${result.stdout ?? ''}`)
          if (catalog !== null) return catalog
        }
      } catch { /* 原生目录暂不可用时保持空目录，不能绕过 Grok 的目录信任。 */ }
    }
    return []
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isDirectory() && basename(path) === id,
      validate: async (path, id) => {
        const directory = await resolveSessionDirectory(path)
        return basename(directory) === id && await isRegularFile(join(directory, 'updates.jsonl'))
      },
    })
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error('Grok Build 未安装')
    const state = await this.getSession(input, command)
    const rpc = state.rpc
    let providerSessionId = state.providerSessionId
    let stream: ReturnType<typeof streamGrokPrompt> | undefined
    try {
      if (providerSessionId === '') {
        const session = await rpc.request('session/new', {
          cwd: input.cwd ?? process.cwd(),
          mcpServers: acpBridgeMcpServers(input.sessionId, this.descriptor.id),
        ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}),
        }, { signal: input.signal })
        providerSessionId = readSessionId(session) ?? input.sessionId
        state.providerSessionId = providerSessionId
        this.sessions.set(input.sessionId, state)
        this.sessions.set(providerSessionId, state)
      }
      yield { type: 'session-binding', providerSessionId }
      // Skill 斜杠命令由 Grok 在用户输入开头解析，不能把普通提示插到命令前。
      const nativeCommand = /^\s*\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:\s|$)/u.test(input.prompt)
      const prompt = [
        ...(nativeCommand ? [] : [{ type: 'text', text: GROK_QUESTION_GUIDANCE }]),
        ...await buildAcpPromptBlocks(input.prompt, input.attachments ?? []),
      ]
      stream = streamGrokPrompt(rpc, providerSessionId, prompt, input.signal, (notification) => {
        const elicitation = readAcpElicitationRequest(notification)
        if (elicitation !== null) state.questions.set(elicitation.requestId, elicitation)
        const grokTool = readGrokQuestionTool(notification)
        if (grokTool !== null) rememberGrokQuestion(state, grokTool)
        // 反向请求的 RPC id 只由请求处理器登记，避免用户回答和处理器调度交错时
        // 已回答的问题被重新登记。tool_call 可以先显示问题卡并暂存用户答案。
        const requestId = interactionRequestId(notification)
        if (requestId !== null && notification.id !== undefined && notification.id !== null) state.requests.set(requestId, { rpcId: notification.id, ...permissionOptions(notification) })
      })
      let finishResult: { reason: 'stop' | 'cancel' | 'error'; failure?: { message: string; code?: string } }
      while (true) {
        const item = await stream.next()
        if (item.done) {
          finishResult = item.value
          break
        }
        const chunk = acpMessageToChunk(item.value)
        if (chunk === null) continue
        if (chunk.type === 'question-request' && state.grokQuestionCallIds.has(chunk.requestId)) {
          if (state.grokQuestionEventIds.has(chunk.requestId)) continue
          state.grokQuestionEventIds.add(chunk.requestId)
        }
        // 问题的 tool_call_update 只是同一次交互的生命周期回声，不能再生成普通
        // 工具记录，否则历史里会重新出现空参数或重复的问题调用。
        if (chunk.type === 'tool-event' && chunk.callId !== undefined && state.grokQuestionCallIds.has(chunk.callId)) continue
        yield chunk
      }
      if (finishResult.reason === 'cancel') {
        try { await rpc.request('session/cancel', { sessionId: providerSessionId }, { killOnAbort: false }) }
        catch { /* 不同 ACP 版本的取消方法可能不同，请求级取消已经先行发出。 */ }
      }
      yield { type: 'finish', reason: finishResult.reason, ...(finishResult.failure === undefined ? {} : { failure: finishResult.failure }) }
    } finally {
      // 原生问题卡取消或消费者提前结束时，也要释放反向请求与流监听器。
      await stream?.return({ reason: 'cancel' })
      for (const pending of state.grokQuestions.values()) {
        if (pending.rpcId === undefined || rpc.isClosed) continue
        rpc.respond(pending.rpcId, { outcome: 'cancelled' })
      }
      state.grokQuestions.clear()
      state.grokQuestionCallIds.clear()
      state.grokQuestionEventIds.clear()
      // ACP 进程和会话跨轮复用，统一由 dispose() 回收。
    }
  }

  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) throw new Error('Grok 权限请求已结束')
    const pending = state.requests.get(response.requestId)
    if (pending === undefined) throw new Error('Grok 权限请求不存在')
    state.requests.delete(response.requestId)
    const optionId = response.approved ? pending.allowOptionId : pending.rejectOptionId
    state.rpc.respond(pending.rpcId, { outcome: { outcome: 'selected', optionId } })
  }

  respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): void {
    const state = this.sessions.get(sessionId)
    const pending = state?.grokQuestions.get(response.requestId)
    if (pending !== undefined) {
      pending.response = response
      if (pending.rpcId !== undefined) {
        state!.grokQuestions.delete(response.requestId)
        state!.rpc.respond(pending.rpcId, grokQuestionResponse(pending, response))
      }
      return
    }
    const elicitation = state?.questions.get(response.requestId)
    if (state === undefined || elicitation === undefined) throw new Error('Grok 问题请求不存在')
    state.questions.delete(response.requestId)
    state.rpc.respond(elicitation.rpcId, acpElicitationResponse(elicitation, response))
  }

  dispose(): void { for (const process of this.processes) process.dispose(); this.processes.clear(); this.sessions.clear(); this.cachedBinary = null }

  private async getSession(input: CodingNsCliTurnInput, command: string) {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd) return previous
    previous?.rpc.dispose()
    const rpc = new JsonRpcProcess({ command, args: ['agent', '--no-leader', 'stdio'], cwd: input.cwd, spawn: this.runSpawn })
    this.processes.add(rpc)
    const state = { rpc, cwd: input.cwd, providerSessionId: '', requests: new Map<string, { readonly rpcId: number | string; readonly allowOptionId: string; readonly rejectOptionId: string }>(), questions: new Map<string, AcpElicitationRequest>(), grokQuestions: new Map<string, GrokQuestionPending>(), grokQuestionCallIds: new Set<string>(), grokQuestionEventIds: new Set<string>() }
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
      // 旧版 Grok 读取 capabilities；标准 ACP 读取 clientCapabilities。
      capabilities: ACP_FORM_CLIENT_CAPABILITIES,
      clientCapabilities: ACP_FORM_CLIENT_CAPABILITIES,
    })
    rpc.notify('initialized', {})
    if (input.providerSessionId) {
      try {
        const loaded = await rpc.request('session/load', { sessionId: input.providerSessionId, cwd: input.cwd ?? process.cwd(), mcpServers: acpBridgeMcpServers(input.sessionId, this.descriptor.id) })
        state.providerSessionId = readSessionId(loaded) ?? input.providerSessionId
      } catch { /* 旧版 ACP 没有 load，下一轮在同一进程创建新会话 */ }
    }
    // ACP 权限是 Grok 发起的 server request，先挂起响应，待标准权限入口明确回复原始 id。
    rpc.setServerRequestHandler((message) => {
      const elicitation = readAcpElicitationRequest(message)
      if (elicitation !== null) {
        state.questions.set(elicitation.requestId, elicitation)
        return new Promise<never>(() => undefined)
      }
      const grokRequest = readGrokQuestionRequest(message)
      if (grokRequest !== null) {
        rememberGrokQuestion(state, grokRequest, message.id)
        const pending = state.grokQuestions.get(grokRequest.callId)
        if (pending?.response !== undefined && pending.rpcId !== undefined) {
          state.grokQuestions.delete(pending.callId)
          state.rpc.respond(pending.rpcId, grokQuestionResponse(pending, pending.response))
        }
        return new Promise<never>(() => undefined)
      }
      // 参数不合法的私有提问也使用 Grok 的取消形状，避免发送嵌套 ACP outcome。
      if (isGrokQuestionMethod(message.method)) return { outcome: 'cancelled' }
      if (message.method === 'elicitation/create') return { action: 'cancel' }
      const requestId = interactionRequestId(message)
      if (requestId === null || message.id === undefined || message.id === null) return { outcome: { outcome: 'cancelled' } }
      state.requests.set(requestId, { rpcId: message.id, ...permissionOptions(message) })
      return new Promise<never>(() => undefined)
    })
    this.sessions.set(input.sessionId, state)
    if (state.providerSessionId !== '') this.sessions.set(state.providerSessionId, state)
    return state
  }
}

const GROK_DRAIN_WAIT_MS = 250

/** 内建提问与 MCP 的连接状态无关，宿主能力说明必须随每轮请求一起传递。 */
const GROK_QUESTION_GUIDANCE = [
  '<codingns_host_capabilities>',
  'DSH 宿主支持 Grok Build 内建 ask_user_question 工具，会显示原生问题卡并回传用户的结构化回答。',
  'ask_user_question 属于 grok_build 内建工具，不依赖 MCP 服务器；MCP 正在连接的提示只影响提示中列出的 MCP 服务器。',
  '当用户明确要求使用提问组件，或需要通过问题卡收集用户选择时，请直接调用 ask_user_question 并等待用户回答，再继续验证或处理答案。',
  '</codingns_host_capabilities>',
].join('\n')

/**
 * Grok 可能先返回 prompt 响应，再补发最后一批 session/update。
 * 响应或终态任一先到都会启动固定排空窗口，窗口内的文本和错误仍会被消费。
 */
async function* streamGrokPrompt(
  rpc: JsonRpcProcess,
  sessionId: string,
  prompt: readonly Record<string, unknown>[],
  signal: AbortSignal | undefined,
  onNotification: (message: JsonRpcMessage) => void,
): AsyncGenerator<JsonRpcMessage, { reason: 'stop' | 'cancel' | 'error'; failure?: { message: string; code?: string } }, void> {
  const queue: JsonRpcMessage[] = []
  const requestController = new AbortController()
  let wake: (() => void) | undefined
  let drainDeadline: number | null = null
  let terminalReason: 'stop' | 'cancel' | 'error' | null = null
  let failure: { message: string; code?: string } | undefined
  const notify = (): void => { wake?.(); wake = undefined }
  const beginDrain = (): void => {
    if (drainDeadline === null) drainDeadline = Date.now() + GROK_DRAIN_WAIT_MS
    notify()
  }
  const listener = (message: JsonRpcMessage): void => {
    queue.push(message)
    onNotification(message)
    const notificationReason = grokNotificationReason(message)
    if (notificationReason === null) {
      notify()
      return
    }
    terminalReason = mergeGrokReason(terminalReason, notificationReason)
    if (notificationReason === 'error') {
      const detail = grokFailure(message)
      if (detail !== undefined) failure = detail
    }
    // 部分 Grok 版本只发终态通知而不回复 prompt，主动取消可清理待处理请求。
    requestController.abort()
    beginDrain()
  }
  const removeListener = rpc.addNotificationListener(listener)
  const onAbort = (): void => {
    terminalReason = 'cancel'
    queue.length = 0
    requestController.abort()
    drainDeadline = Date.now()
    notify()
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  void rpc.request('session/prompt', {
    sessionId,
    prompt,
  }, { signal: requestController.signal, killOnAbort: false }).then(
    (response) => {
      const responseReason = grokPromptReason(response)
      if (responseReason !== null) terminalReason = mergeGrokReason(terminalReason, responseReason)
      beginDrain()
    },
    () => {
      if (terminalReason === null) terminalReason = signal?.aborted ? 'cancel' : 'error'
      beginDrain()
    },
  )

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      if (drainDeadline === null) {
        await new Promise<void>((resolve) => { wake = resolve })
        continue
      }
      const remaining = drainDeadline - Date.now()
      if (remaining <= 0) break
      await Promise.race([
        new Promise<void>((resolve) => { wake = resolve }),
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ])
      wake = undefined
    }
    return { reason: terminalReason ?? 'stop', ...(failure === undefined ? {} : { failure }) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    removeListener()
  }
}

function grokPromptReason(value: unknown): 'stop' | 'error' | null {
  if (!isRecord(value) || typeof value.stopReason !== 'string') return null
  const reason = value.stopReason.toLowerCase()
  return reason === 'cancelled' || reason === 'error' || reason === 'failed' ? 'error' : 'stop'
}

function mergeGrokReason(
  current: 'stop' | 'cancel' | 'error' | null,
  next: 'stop' | 'cancel' | 'error',
): 'stop' | 'cancel' | 'error' {
  if (current === 'error' || next === 'error') return 'error'
  if (current === 'cancel' || next === 'cancel') return 'cancel'
  return 'stop'
}

function grokNotificationReason(message: JsonRpcMessage): 'stop' | 'error' | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const type = typeof update.sessionUpdate === 'string'
    ? update.sessionUpdate.toLowerCase()
    : typeof update.type === 'string'
      ? update.type.toLowerCase()
      : ''
  if (type.includes('error') || type.includes('failed')) return 'error'
  if (type.includes('turn_completed') || type.includes('turn_complete') || type === 'completed' || type === 'done') return 'stop'
  return null
}

function grokFailure(message: JsonRpcMessage): { message: string; code?: string } | undefined {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const error = isRecord(update.error) ? update.error : update
  const detail = firstToolText(error.message, error.errorMessage, error.error_message, error.detail, error.reason)
  if (detail === undefined) return undefined
  const code = firstToolText(error.code, error.errorCode, error.error_code)
  return code === undefined ? { message: detail } : { message: detail, code }
}

/** Grok 的提问不是 ACP elicitation，而是 x.ai 私有的反向 ext_method。 */
function readGrokQuestionRequest(message: Record<string, any>): GrokQuestionTool | null {
  // Grok 1.0.x 的真实线路使用 `_x.ai/` 扩展命名空间；保留旧版无下划线
  // 别名兼容历史客户端，但不能把真实请求落入普通未知请求处理。
  if (!isGrokQuestionMethod(message.method)) return null
  const params = isRecord(message.params) ? message.params : {}
  const callId = firstToolText(params.toolCallId, params.tool_call_id, params.callId, params.call_id)
  const questions = readAgentQuestions(params.questions)
  if (callId === undefined || questions.length === 0) return null
  return { callId, questions }
}

function isGrokQuestionMethod(method: unknown): boolean {
  return method === '_x.ai/ask_user_question' || method === 'x.ai/ask_user_question'
}

/** 只认 Grok Build 的结构化 ask_user_question tool_call，不能按普通工具落库。 */
function readGrokQuestionTool(message: Record<string, any>): GrokQuestionTool | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
  const metaSource = isRecord(tool._meta) ? tool._meta : isRecord(update._meta) ? update._meta : {}
  const xaiTool = isRecord(metaSource['x.ai/tool']) ? metaSource['x.ai/tool'] : null
  if (xaiTool?.namespace !== 'grok_build' || xaiTool.name !== 'ask_user_question') return null
  const callId = firstToolText(tool.toolCallId, tool.tool_call_id, tool.callId, tool.call_id, update.toolCallId, update.tool_call_id)
  const rawInput = tool.rawInput ?? tool.input ?? update.rawInput
  const questionsSource = isRecord(rawInput) && Array.isArray(rawInput.questions) ? rawInput.questions : rawInput
  const questions = readAgentQuestions(questionsSource)
  if (callId === undefined || questions.length === 0) return null
  return { callId, questions }
}

type GrokQuestionState = {
  readonly grokQuestions: Map<string, GrokQuestionPending>
  readonly grokQuestionCallIds: Set<string>
}

function rememberGrokQuestion(state: GrokQuestionState, question: GrokQuestionTool, rpcId?: number | string | null): void {
  state.grokQuestionCallIds.add(question.callId)
  const pending = state.grokQuestions.get(question.callId)
  if (pending === undefined) {
    state.grokQuestions.set(question.callId, {
      callId: question.callId,
      questions: question.questions,
      ...(rpcId === undefined || rpcId === null ? {} : { rpcId }),
    })
    return
  }
  if (rpcId !== undefined && rpcId !== null) pending.rpcId = rpcId
}

/** 将 DSH 的 id-keyed 答案改写成 Grok 以问题原文为 key 的私有 outcome。 */
function grokQuestionResponse(pending: GrokQuestionPending, response: CodingNsAgentQuestionResponse): Record<string, unknown> {
  const answers: Record<string, string[]> = {}
  const annotations: Record<string, { notes: string }> = {}
  for (const answer of response.answers) {
    const question = pending.questions.find((item) => item.id === answer.id || item.question === answer.id)
    const key = question?.question ?? answer.id
    const custom = answer.custom?.trim()
    const selected = [...answer.selected]
    if (selected.length === 0 && custom !== undefined && custom !== '') selected.push('Other')
    if (selected.length > 0) answers[key] = selected
    if (custom !== undefined && custom !== '') annotations[key] = { notes: custom }
  }
  return {
    outcome: 'accepted',
    answers,
    ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
  }
}

function acpMessageToChunk(message: Record<string, any>): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const type = (typeof update.sessionUpdate === 'string' ? update.sessionUpdate : typeof update.type === 'string' ? update.type : typeof message.method === 'string' ? message.method : '').toLowerCase()
  const elicitation = readAcpElicitationRequest(message)
  if (elicitation !== null) return { type: 'question-request', requestId: elicitation.requestId, questions: elicitation.questions }
  const grokQuestion = readGrokQuestionTool(message) ?? readGrokQuestionRequest(message)
  if (grokQuestion !== null) return { type: 'question-request', requestId: grokQuestion.callId, callId: grokQuestion.callId, questions: grokQuestion.questions }
  const reasoning = reasoningText(update)
  if (reasoning !== null) return { type: 'reasoning-delta', text: reasoning }
  const text = textValue(update.delta ?? update.text ?? update.content ?? update.message ?? update.detail)
  if (type.includes('permission')) {
    const requestId = permissionRequestId(message) ?? (typeof update.requestId === 'string' ? update.requestId : typeof update.id === 'string' ? update.id : null)
    if (requestId !== null) {
      const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
      const toolName = firstToolText(tool.title, tool.name, tool.toolName, tool.tool_name, update.toolName)
      const callId = firstToolText(tool.toolCallId, tool.tool_call_id, tool.callId, tool.call_id, update.callId, update.call_id)
      return { type: 'permission-request', requestId, kind: typeof update.kind === 'string' ? update.kind : toolName ?? 'unknown', ...(toolName ? { toolName } : {}), ...(callId ? { callId } : {}), ...(text ? { detail: text } : {}) }
    }
  }
  if (type.includes('agent_message') || type.includes('text') || type === 'message') return text ? { type: 'text-delta', text } : null
  if (type.includes('thought') || type.includes('reason')) return text ? { type: 'reasoning-delta', text } : null
  if (type.includes('tool') || type.includes('command')) {
    const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
    const name = firstToolText(tool.name, tool.toolName, tool.tool_name, tool.title, update.name, update.toolName, update.title)
    const callId = firstToolText(tool.callId, tool.call_id, tool.toolCallId, tool.tool_call_id, tool.id, update.toolCallId, update.tool_call_id, update.id)
    if (!name && !callId) return null
    const input = serializeToolValue(tool.rawInput ?? tool.input ?? tool.arguments ?? tool.args ?? update.rawInput)
    const output = serializeToolValue(tool.rawOutput ?? tool.output ?? tool.result ?? update.rawOutput)
    const error = serializeToolValue(tool.error ?? update.error)
    const agentId = firstToolText(tool.agentId, tool.agent_id, update.agentId, update.agent_id)
    const detail = serializeToolValue(tool.detail ?? update.detail ?? update.content)
    const fallback = error !== undefined || type.includes('error') || type.includes('fail')
      ? 'failed'
      : output !== undefined || type.includes('result') || type.includes('complete')
        ? 'completed'
        : 'running'
    return {
      type: 'tool-event',
      toolName: name ?? 'tool',
      status: normalizeToolStatus(tool.status ?? tool.state ?? update.status, fallback),
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(output !== undefined ? { outputMode: type.toLowerCase().includes('delta') ? 'delta' as const : 'snapshot' as const } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(agentId ? { agentId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }
  return usageChunk(update)
}

function permissionRequestId(message: Record<string, any>): string | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const type = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : typeof update.type === 'string' ? update.type : typeof message.method === 'string' ? message.method : ''
  if (!type.toLowerCase().includes('permission')) return null
  const id = message.id ?? update.requestId ?? update.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

function interactionRequestId(message: Record<string, any>): string | null {
  return permissionRequestId(message)
}

function permissionOptions(message: Record<string, any>): { readonly allowOptionId: string; readonly rejectOptionId: string } {
  const params = isRecord(message.params) ? message.params : {}
  const options = Array.isArray(params.options) ? params.options : []
  const ids = options.flatMap((option) => {
    if (!isRecord(option)) return []
    const id = firstToolText(option.optionId, option.option_id, option.id)
    if (id === undefined) return []
    return [{ id, kind: firstToolText(option.kind, option.type)?.toLowerCase() ?? '' }]
  })
  return {
    allowOptionId: ids.find((option) => /allow|approve|accept/u.test(option.kind))?.id ?? ids[0]?.id ?? 'allow-once',
    rejectOptionId: ids.find((option) => /reject|deny|decline|cancel/u.test(option.kind))?.id ?? ids[1]?.id ?? 'reject-once',
  }
}

function readSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId === 'string') return value.sessionId
  if (isRecord(value.session) && typeof value.session.id === 'string') return value.session.id
  return typeof value.id === 'string' ? value.id : null
}

/** 解析 Grok 原生 `inspect --json`，保留它对禁用 Skill 和兼容来源的判定。 */
function parseGrokSkillCatalog(output: string): readonly CodingNsCliSkillDescriptor[] | null {
  const start = output.indexOf('{')
  if (start < 0) return null
  let value: unknown
  try { value = JSON.parse(output.slice(start)) } catch { return null }
  if (!isRecord(value) || !Array.isArray(value.skills)) return null
  return value.skills.flatMap((raw): CodingNsCliSkillDescriptor[] => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.trim() === '') return []
    // 重名 Skill 必须使用 Provider 返回的限定名，否则可能调用到内建命令。
    const name = typeof raw.invocableAs === 'string' && raw.invocableAs.trim() !== ''
      ? raw.invocableAs.trim().replace(/^\//u, '')
      : raw.name.trim()
    const description = typeof raw.description === 'string' ? raw.description.trim() : ''
    if (description === '') return []
    const disabled = raw.disabled === true || raw.enabled === false || raw.userInvocable === false || raw.compatibilityStatus === 'disabled'
      || (typeof raw.disabledReason === 'string' && raw.disabledReason.trim() !== '')
    return [{
      id: name,
      name,
      description,
      enabled: !disabled,
    }]
  })
}

function parseGrokCatalog(value: unknown): CodingNsCliModelCatalog {
  if (!isRecord(value)) return emptyCatalog()
  const models = isRecord(value.models) && Array.isArray(value.models.availableModels)
    ? value.models.availableModels
    : []
  const configOptions = Array.isArray(value.configOptions) ? value.configOptions : []
  const efforts = new Map<string, string[]>()
  for (const option of configOptions) {
    if (!isRecord(option)) continue
    const id = typeof option.id === 'string' ? option.id : ''
    if (!/model|reasoning/iu.test(id)) continue
    const values = Array.isArray(option.options) ? option.options : Array.isArray(option.values) ? option.values : []
    if (!/reasoning/iu.test(id)) continue
    for (const value of values) {
      const effort = typeof value === 'string' ? value : isRecord(value) && typeof value.id === 'string' ? value.id : null
      if (!effort) continue
      const modelId = typeof option.modelId === 'string' ? option.modelId : '*'
      const current = efforts.get(modelId) ?? []
      if (!current.includes(effort)) current.push(effort)
      efforts.set(modelId, current)
    }
  }
  const items = models.flatMap((entry) => {
    if (typeof entry === 'string') return [{ id: entry, name: entry, efforts: efforts.get(entry) ?? [] }]
    if (!isRecord(entry)) return []
    const id = typeof entry.modelId === 'string' ? entry.modelId : typeof entry.id === 'string' ? entry.id : null
    if (!id) return []
    const meta = isRecord(entry._meta) ? entry._meta : {}
    const declared = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.flatMap((item) => typeof item === 'string' ? [item] : isRecord(item) && typeof item.id === 'string' ? [item.id] : []) : []
    return [{ id, name: typeof entry.name === 'string' ? entry.name : id, efforts: declared.length > 0 ? declared : efforts.get(id) ?? efforts.get('*') ?? [] }]
  })
  if (items.length === 0) return emptyCatalog()
  const deduped = [...new Map(items.map((item) => [item.id, item])).values()]
  return { groups: [{ id: 'grok', name: 'Grok', models: deduped }], currentModel: null, currentEffort: null }
}
