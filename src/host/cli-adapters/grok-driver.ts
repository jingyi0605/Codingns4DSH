import { runAsyncCommand } from './process-utils.js'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CodingNsAgentEvent, CodingNsAgentImageArtifact, CodingNsCliModelCatalog, CodingNsAgentPermissionResponse, CodingNsAgentQuestion, CodingNsAgentQuestionResponse, CodingNsCliSkillDescriptor, CodingNsCliSkillListInput, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
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
import { imageArtifactPathsFromValue, stripImageMarkdown } from '../image-artifact-store.js'
import { advanceCodingNsSegment, createCodingNsSegmentState, decorateCodingNsSegmentEvent } from './stream-normalizer.js'

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
  private readonly sessions = new Map<string, { rpc: JsonRpcProcess; cwd: string | undefined; rawStoreRef: string | undefined; providerSessionId: string; requests: Map<string, { readonly rpcId: number | string; readonly allowOptionId: string; readonly rejectOptionId: string }>; questions: Map<string, AcpElicitationRequest>; grokQuestions: Map<string, GrokQuestionPending>; grokQuestionCallIds: Set<string>; grokQuestionEventIds: Set<string> }>()

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
    const rpc = new JsonRpcProcess({ command, args: ['agent', '--no-leader', 'stdio'], env: grokRuntimeEnvironment(), spawn: this.runSpawn })
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
    if (input.signal?.aborted) throw new Error('Skill catalog loading was canceled')
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
          env: grokRuntimeEnvironment(command),
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
    if (command === null) throw new Error('Grok Build is not installed')
    const state = await this.getSession(input, command)
    const rpc = state.rpc
    let providerSessionId = state.providerSessionId
    let stream: ReturnType<typeof streamGrokPrompt> | undefined
    let reusable = false
    const promptId = randomUUID()
    const segmentState = createCodingNsSegmentState()
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
      stream = streamGrokPrompt(rpc, providerSessionId, promptId, prompt, input.signal, (notification) => {
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
        for (const rawChunk of acpMessageToChunks(item.value)) {
          const resolved = rawChunk.type === 'image-artifact'
            ? await resolveGrokImageArtifact(rawChunk, state, this.sessionRoots)
            : rawChunk
          if (resolved === null) continue
          const chunk = decorateCodingNsSegmentEvent(resolved, input, segmentState, this.descriptor.id)
          if (chunk.type === 'question-request' && state.grokQuestionCallIds.has(chunk.requestId)) {
            if (state.grokQuestionEventIds.has(chunk.requestId)) continue
            state.grokQuestionEventIds.add(chunk.requestId)
          }
          // 问题的 tool_call_update 只是同一次交互的生命周期回声，不能再生成普通
          // 工具记录，否则历史里会重新出现空参数或重复的问题调用。
          if (chunk.type === 'tool-event' && chunk.callId !== undefined && state.grokQuestionCallIds.has(chunk.callId)) continue
          yield chunk
          advanceCodingNsSegment(chunk, segmentState)
          if (chunk.type === 'question-request') segmentState.segment += 1
        }
      }
      reusable = finishResult.reason !== 'cancel' && !input.signal?.aborted
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
      state.questions.clear()
      state.requests.clear()
      if (stream !== undefined && !reusable) {
        // An abandoned prompt can keep producing updates without prompt metadata.
        // Reload its persisted session on a fresh transport before accepting new input.
        await rpc.disposeAndWait()
        this.processes.delete(rpc)
      }
    }
  }

  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) throw new Error('The Grok permission request has ended')
    const pending = state.requests.get(response.requestId)
    if (pending === undefined) throw new Error('The Grok permission request does not exist')
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
    if (state === undefined || elicitation === undefined) throw new Error('The Grok question request does not exist')
    state.questions.delete(response.requestId)
    state.rpc.respond(elicitation.rpcId, acpElicitationResponse(elicitation, response))
  }

  dispose(): void { for (const process of this.processes) process.dispose(); this.processes.clear(); this.sessions.clear(); this.cachedBinary = null }

  private async getSession(input: CodingNsCliTurnInput, command: string) {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd && !previous.rpc.isClosed) return previous
    if (previous !== undefined) {
      await previous.rpc.disposeAndWait()
      this.processes.delete(previous.rpc)
    }
    const resumeId = input.providerSessionId ?? (previous?.cwd === input.cwd ? previous?.providerSessionId : undefined)
    const rpc = new JsonRpcProcess({ command, args: ['agent', '--no-leader', 'stdio'], cwd: input.cwd, env: grokRuntimeEnvironment(), spawn: this.runSpawn })
    this.processes.add(rpc)
    const state = { rpc, cwd: input.cwd, rawStoreRef: input.rawStoreRef, providerSessionId: '', requests: new Map<string, { readonly rpcId: number | string; readonly allowOptionId: string; readonly rejectOptionId: string }>(), questions: new Map<string, AcpElicitationRequest>(), grokQuestions: new Map<string, GrokQuestionPending>(), grokQuestionCallIds: new Set<string>(), grokQuestionEventIds: new Set<string>() }
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
      // 旧版 Grok 读取 capabilities；标准 ACP 读取 clientCapabilities。
      capabilities: ACP_FORM_CLIENT_CAPABILITIES,
      clientCapabilities: ACP_FORM_CLIENT_CAPABILITIES,
    })
    rpc.notify('initialized', {})
    if (resumeId) {
      try {
        const loaded = await rpc.request('session/load', { sessionId: resumeId, cwd: input.cwd ?? process.cwd(), mcpServers: acpBridgeMcpServers(input.sessionId, this.descriptor.id) })
        state.providerSessionId = readSessionId(loaded) ?? resumeId
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

/**
 * Grok 会默认兼容加载 `~/.claude/Claude.md`。CodingNS 已经有自己的会话规则，
 * 外部 Agent 不应继承 Claude 的全局语言偏好或其他宿主专属指令。
 */
function grokRuntimeEnvironment(command?: string): Record<string, string | undefined> {
  const base = command === undefined ? process.env : commandEnvironment(command)
  return { ...base, GROK_CLAUDE_AGENTS_ENABLED: '0' }
}

/** 内建提问与 MCP 的连接状态无关，宿主能力说明必须随每轮请求一起传递。 */
const GROK_QUESTION_GUIDANCE = [
  '<codingns_host_capabilities>',
  'The DSH host provides Grok Build\'s built-in ask_user_question tool. It displays a native question card and returns the user\'s structured answer.',
  'ask_user_question is a grok_build built-in tool and does not depend on an MCP server. MCP connection notices only describe the MCP servers listed in the prompt.',
  'When the user explicitly asks to use a question component, or when a question card is needed to collect a choice, call ask_user_question directly, wait for the user\'s answer, and then continue.',
  '</codingns_host_capabilities>',
].join('\n')

/**
 * Grok 可能先返回 prompt 响应，再补发最后一批 session/update。
 * 响应或终态任一先到都会启动固定排空窗口，窗口内的文本和错误仍会被消费。
 */
async function* streamGrokPrompt(
  rpc: JsonRpcProcess,
  sessionId: string,
  promptId: string,
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
  let completed = false
  const notify = (): void => { wake?.(); wake = undefined }
  const beginDrain = (): void => {
    if (drainDeadline === null) drainDeadline = Date.now() + GROK_DRAIN_WAIT_MS
    notify()
  }
  const listener = (message: JsonRpcMessage): void => {
    if (!isGrokPromptMessage(message, sessionId, promptId)) return
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

  if (!signal?.aborted) void rpc.request('session/prompt', {
    sessionId,
    prompt,
    _meta: { promptId },
  }, { signal: requestController.signal, killOnAbort: false }).then(
    (response) => {
      const responseReason = grokPromptReason(response)
      if (responseReason !== null) terminalReason = mergeGrokReason(terminalReason, responseReason)
      beginDrain()
    },
    () => {
      if (requestController.signal.aborted) return
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
    completed = true
    return { reason: terminalReason ?? 'stop', ...(failure === undefined ? {} : { failure }) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    removeListener()
    if (!completed || signal?.aborted) {
      // ACP cancellation is a notification; waiting for an RPC response can hang.
      try { rpc.notify('session/cancel', { sessionId }) } catch { /* The process may already have exited. */ }
    }
    // Terminal-only providers and consumers that close the iterator both need cleanup.
    requestController.abort()
  }
}

function isGrokPromptMessage(message: JsonRpcMessage, sessionId: string, promptId: string): boolean {
  const params = isRecord(message.params) ? message.params : message
  if (typeof params.sessionId === 'string' && params.sessionId !== sessionId) return false
  const update = isRecord(params.update) ? params.update : params
  const meta = isRecord(params._meta) ? params._meta : {}
  const owner = firstToolText(update.prompt_id, update.promptId, meta.promptId)
  return owner === undefined || owner === promptId
}

function grokPromptReason(value: unknown): 'stop' | 'cancel' | 'error' | null {
  if (!isRecord(value)) return null
  const reason = firstToolText(value.stopReason, value.stop_reason)?.toLowerCase()
  if (reason === undefined) return null
  if (reason === 'cancelled' || reason === 'canceled') return 'cancel'
  return reason === 'error' || reason === 'failed' ? 'error' : 'stop'
}

function mergeGrokReason(
  current: 'stop' | 'cancel' | 'error' | null,
  next: 'stop' | 'cancel' | 'error',
): 'stop' | 'cancel' | 'error' {
  if (current === 'error' || next === 'error') return 'error'
  if (current === 'cancel' || next === 'cancel') return 'cancel'
  return 'stop'
}

function grokNotificationReason(message: JsonRpcMessage): 'stop' | 'cancel' | 'error' | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const type = typeof update.sessionUpdate === 'string'
    ? update.sessionUpdate.toLowerCase()
    : typeof update.type === 'string'
      ? update.type.toLowerCase()
      : ''
  if (['turn_error', 'turn_failed', 'error', 'failed'].includes(type)) return 'error'
  if (['turn_completed', 'turn_complete', 'prompt_complete', 'completed', 'done'].includes(type)) return grokPromptReason(update) ?? 'stop'
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

function grokStreamId(message: Record<string, any>): string | undefined {
  const params = isRecord(message.params) ? message.params : message
  const meta = isRecord(params._meta) ? params._meta : {}
  return typeof meta.streamStartMs === 'number' && Number.isFinite(meta.streamStartMs)
    ? `grok-stream-${meta.streamStartMs}` : undefined
}

function acpMessageToChunks(message: Record<string, any>): readonly CodingNsAgentEvent[] {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const type = (typeof update.sessionUpdate === 'string' ? update.sessionUpdate : typeof update.type === 'string' ? update.type : typeof message.method === 'string' ? message.method : '').toLowerCase()
  const elicitation = readAcpElicitationRequest(message)
  if (elicitation !== null) return [{ type: 'question-request', requestId: elicitation.requestId, questions: elicitation.questions }]
  const grokQuestion = readGrokQuestionTool(message) ?? readGrokQuestionRequest(message)
  if (grokQuestion !== null) return [{ type: 'question-request', requestId: grokQuestion.callId, callId: grokQuestion.callId, questions: grokQuestion.questions }]
  const text = textValue(update.delta ?? update.text ?? update.content ?? update.message ?? update.detail)
  const artifactPaths = [
    update.rawOutput,
    update.raw_output,
    update.output,
    update.result,
    update.image,
    update.images,
    update.content,
    update.file,
    update.files,
  ].flatMap((value) => imageArtifactPathsFromValue(value))
  const markdownPaths = imageArtifactPathsFromValue(text ?? '')
  const imagePaths = [...new Set([...artifactPaths, ...markdownPaths])]
  const imageEvents: CodingNsAgentEvent[] = imagePaths.map((path): CodingNsAgentImageArtifact => ({ type: 'image-artifact', path }))
  // Grok identifies each model call independently of the enclosing user prompt.
  const messageId = grokStreamId(message)
  const identity = messageId === undefined ? {} : { messageId }
  const reasoning = reasoningText(update)
  if (reasoning !== null) return [...imageEvents, { type: 'reasoning-delta', text: reasoning, ...identity }]
  if (type.includes('permission')) {
    const requestId = permissionRequestId(message) ?? (typeof update.requestId === 'string' ? update.requestId : typeof update.id === 'string' ? update.id : null)
    if (requestId !== null) {
      const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
      const toolName = firstToolText(tool.title, tool.name, tool.toolName, tool.tool_name, update.toolName)
      const callId = firstToolText(tool.toolCallId, tool.tool_call_id, tool.callId, tool.call_id, update.callId, update.call_id)
      return [{ type: 'permission-request', requestId, kind: typeof update.kind === 'string' ? update.kind : toolName ?? 'unknown', ...(toolName ? { toolName } : {}), ...(callId ? { callId } : {}), ...(text ? { detail: text } : {}) }]
    }
  }
  if (type.includes('agent_message') || type.includes('text') || type === 'message') {
    const visible = text === null ? '' : stripImageMarkdown(text, markdownPaths)
    const textEvent: CodingNsAgentEvent | undefined = visible === '' ? undefined : { type: 'text-delta', text: visible, ...identity }
    return [...imageEvents, ...(textEvent === undefined ? [] : [textEvent])]
  }
  if (type.includes('image') || type.includes('artifact') || type.includes('generated')) return imageEvents
  if (type.includes('thought') || type.includes('reason')) return text ? [{ type: 'reasoning-delta', text, ...identity }] : []
  if (type.includes('tool') || type.includes('command')) {
    const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
    const name = firstToolText(tool.name, tool.toolName, tool.tool_name, tool.title, update.name, update.toolName, update.title)
    const callId = firstToolText(tool.callId, tool.call_id, tool.toolCallId, tool.tool_call_id, tool.id, update.toolCallId, update.tool_call_id, update.id)
    if (!name && !callId) return []
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
    return [...imageEvents, {
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
    }]
  }
  const usage = usageChunk(update)
  return usage === null ? imageEvents : [...imageEvents, usage]
}

async function resolveGrokImageArtifact(
  artifact: Extract<CodingNsAgentEvent, { type: 'image-artifact' }>,
  state: { readonly cwd: string | undefined; readonly rawStoreRef: string | undefined; readonly providerSessionId: string },
  roots: readonly string[],
): Promise<Extract<CodingNsAgentEvent, { type: 'image-artifact' }> | null> {
  const raw = artifact.path?.trim()
  if (raw === undefined || raw === '') return artifact.data === undefined ? null : artifact
  const candidates = isAbsolute(raw)
      ? [raw]
      : [
        ...(state.rawStoreRef === undefined ? [] : containedPath(state.rawStoreRef, raw)),
        ...(state.rawStoreRef === undefined ? [] : containedPath(dirname(state.rawStoreRef), raw)),
        ...roots.flatMap((root) => containedPath(root, join(state.providerSessionId, raw))),
        ...roots.flatMap((root) => containedPath(root, raw)),
        ...(state.cwd === undefined ? [] : containedPath(state.cwd, raw)),
      ]
  for (const candidate of candidates) {
    try {
      if (await isRegularFile(candidate)) return { ...artifact, path: candidate }
    } catch { /* Provider 可能只在另一处保存产物，继续尝试受控候选。 */ }
  }
  return null
}

function containedPath(root: string, child: string): readonly string[] {
  const base = resolve(root)
  const candidate = resolve(base, child)
  const outside = relative(base, candidate)
  return outside === '' || outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside) ? [] : [candidate]
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
