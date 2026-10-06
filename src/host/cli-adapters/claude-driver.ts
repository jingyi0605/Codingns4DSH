import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type { CodingNsAgentEvent, CodingNsAgentPermissionResponse, CodingNsAgentQuestion, CodingNsAgentQuestionResponse, CodingNsCliAttachment, CodingNsCliModelCatalog, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { CLAUDE_CATALOG, clearEfforts, isProviderDefaultModel } from './model-catalog.js'
import { discoverClaudeModelCatalog } from './claude-model-options.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, serializeToolValue } from './tool-observation.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'
import { WINDOWS, commandEnvironment, type CodingNsChildProcess } from './process-utils.js'
import { claudeBridgeArgs } from '../cli-bridge/injections.js'
import { readAgentQuestions } from './interaction-events.js'

interface ClaudePendingInteraction {
  readonly kind: 'permission' | 'question'
  readonly input: Record<string, unknown>
  readonly toolName: string
  readonly toolUseId?: string
  readonly questions?: readonly ClaudeQuestionBinding[]
}

interface ClaudeQuestionBinding {
  readonly id: string
  /** Claude 的公开协议按 question 文本作为 answers 的键。 */
  readonly providerKey: string
}

interface ClaudeInteractionState {
  write: ((data: string) => void) | undefined
  readonly pending: Map<string, ClaudePendingInteraction>
}

export class ClaudeCodeDriver extends StandardStreamDriver {
  /** Claude 的 stream-json 可以在工具完成后暂停并由 Registry 续读同一进程。 */
  readonly supportsToolStepSplitting = true
  private readonly sessionRoots: readonly string[]
  private readonly claudeConfigDir: string | undefined
  private readonly discoveryFetch: typeof fetch | undefined
  /** 参数分片按会话和内容块索引隔离，避免并发会话或多个工具互相串入。 */
  private readonly toolInputStates = new Map<string, Map<number, ClaudeToolInputState>>()
  /**
   * `--effort` 探测结论，绑定到具体的 CLI 路径与版本。
   *
   * 只缓存确定结论：探测本身失败（进程无法启动、读不到帮助文本）时保持未缓存，
   * 下一轮重试。否则一次偶发失败会把强度切换永久关掉，且无法自愈。
   */
  private effortProbe: { readonly command: string; readonly version: string | null; readonly supported: boolean } | undefined
  /** 最近一次 detect 得到的版本；CLI 原地升级后据此让探测缓存失效。 */
  private detectedVersion: string | null = null

  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'claude-code', name: 'Claude Code', protocol: 'stream-json', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions'] }, { binaries: ['claude'] }, options)
    this.sessionRoots = options.sessionRoots ?? [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')]
    this.claudeConfigDir = options.claudeConfigDir
    this.discoveryFetch = options.fetch
  }
  private readonly interactions = new Map<string, ClaudeInteractionState>()

  /** Claude 的 SDK wire 通过 stdin 接收首条 user 消息并回传 control_response。 */
  protected get usesStdin(): boolean { return true }

  protected writeStdin(child: CodingNsChildProcess, input: CodingNsCliTurnInput): void {
    const state = this.interactions.get(input.sessionId)
    if (state === undefined || child.stdin === null) return
    state.write = (data) => { child.stdin?.write(data) }
    // Claude Agent SDK 在首条 user 消息前先发公开 initialize control_request；
    // 保留这个握手，确保 CLI 开启同一条双向权限通道。
    state.write(`${JSON.stringify({
      type: 'control_request',
      request_id: `initialize:${input.sessionId}`,
      request: { subtype: 'initialize' },
    })}\n`)
    const prompt = promptWithAttachmentPaths(input.prompt, input.attachments ?? [])
    state.write(`${JSON.stringify({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      parent_tool_use_id: null,
    })}\n`)
  }

  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const state = this.interactions.get(sessionId)
    const pending = state?.pending.get(response.requestId)
    if (state === undefined || pending?.kind !== 'permission') throw new Error('Claude Code 权限请求已结束')
    state.pending.delete(response.requestId)
    this.writeControlResponse(state, response.requestId, response.approved
      ? {
          behavior: 'allow',
          updatedInput: pending.input,
          decisionClassification: 'user_temporary',
          ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
        }
      : {
          behavior: 'deny',
          message: response.reason?.trim() || '用户拒绝了权限请求',
          decisionClassification: 'user_reject',
          ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
        })
  }

  respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): void {
    const state = this.interactions.get(sessionId)
    const pending = state?.pending.get(response.requestId)
    if (state === undefined || pending?.kind !== 'question' || pending.questions === undefined) throw new Error('Claude Code 问题请求已结束')
    state.pending.delete(response.requestId)
    const answers = Object.fromEntries(pending.questions.map((question) => {
      const answer = response.answers.find((item) => item.id === question.id)
      const values = answer === undefined ? [] : [...answer.selected, ...(answer.custom?.trim() ? [answer.custom.trim()] : [])]
      return [question.providerKey, values.join(', ')]
    }))
    this.writeControlResponse(state, response.requestId, {
      behavior: 'allow',
      updatedInput: { ...pending.input, answers },
      decisionClassification: 'user_temporary',
      ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
    })
  }

  private writeControlResponse(state: ClaudeInteractionState, requestId: string, response: Record<string, unknown>): void {
    const write = state.write
    if (write === undefined) throw new Error('Claude Code 控制通道不可用，无法回传交互结果')
    write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`)
  }

  /** 每次探测都记录版本，让 `--effort` 缓存能随 CLI 原地升级失效。 */
  override async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const detected = await super.detect()
    this.detectedVersion = detected.version
    return detected
  }

  async listModels() {
    const detected = await this.detect()
    if (!detected.installed || detected.command === null) return emptyCatalog()
    let catalog: CodingNsCliModelCatalog
    try {
      catalog = await discoverClaudeModelCatalog({
        command: detected.command,
        spawn: this.runSpawn,
        ...(this.discoveryFetch ? { fetch: this.discoveryFetch } : {}),
        ...(this.claudeConfigDir ? { configDir: this.claudeConfigDir } : {}),
      })
    } catch {
      catalog = CLAUDE_CATALOG
    }
    // CLI 明确不支持 `--effort` 时，驱动不会下发该参数；此时目录也不能展示档位，
    // 否则用户看到的是一个切换后不生效的选项。探测不确定时保持目录原样。
    return this.probeEffortSupport() === 'unsupported' ? clearEfforts(catalog) : catalog
  }
  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path) === `${id}.jsonl`,
      validate: async (path, id) => (await readFirstJsonRecord(path))?.sessionId === id,
    })
  }

  /**
   * Claude Code 的 `@路径` 图片解析器只按路径后缀判断格式。DSH 附件对象使用
   * 内容寻址路径，通常没有扩展名（例如 `.../objects/15/<sha256>`），即使文件
   * 本身是 PNG 也会被 CLI 判定为 `Unsupported image format: .`。
   *
   * 发送前为这类图片建立带受支持后缀的临时副本，回合结束后立即清理。只改写
   * Claude 的输入路径，不改变 DSH 附件存储，也不把临时路径写入会话历史。
   */
  override async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const prepared = await prepareClaudeTurnInput(input)
    this.toolInputStates.delete(input.sessionId)
    const interaction: ClaudeInteractionState = { write: undefined, pending: new Map() }
    this.interactions.set(input.sessionId, interaction)
    try {
      yield* super.executeTurn(prepared.input)
    } finally {
      this.toolInputStates.delete(input.sessionId)
      if (this.interactions.get(input.sessionId) === interaction) this.interactions.delete(input.sessionId)
      await prepared.cleanup()
    }
  }

  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    // Claude Agent SDK 在 canUseTool 回调存在时使用这个隐藏的 stdio 协议入口。
    // `--permission-prompts host` 只决定提示由谁回答，没有注册 stdio
    // 权限处理器；CLI 因而不向模型提供 AskUserQuestion。
    const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--verbose']
    args.push(...claudePermissionArgs(input.permission))
    // 子代理托管开启时注入 MCP 替身工具并停用内建 Task 子代理。
    args.push(...claudeBridgeArgs(input.sessionId, this.descriptor.id))
    for (const directory of new Set((input.attachments ?? []).map((attachment) => dirname(attachment.path)))) args.push('--add-dir', directory)
    if (input.providerSessionId) args.push('--resume', input.providerSessionId)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    // `--effort` 是 CLI 的会话级参数，会写进请求的 output_config.effort；
    // 只有探测到当前 CLI 支持该参数时才下发，避免旧版本因未知参数直接失败。
    const effort = input.effortId?.trim()
    if (effort && effort !== 'default' && this.supportsEffortOption()) args.push('--effort', effort)
    return args
  }

  /**
   * 探测 `claude` 对 `--effort` 的支持状态。
   *
   * 只在拿到确定结论时缓存，并按「CLI 路径 + 版本」作键：路径相同但版本变了
   * （原地升级）会重新探测。探测失败时返回 unknown 且不缓存，让下一轮重试——
   * 既不会把偶发失败固化成「不支持」，也不会冒险给旧 CLI 传未知选项。
   */
  private probeEffortSupport(): 'supported' | 'unsupported' | 'unknown' {
    const command = this.resolvedBinary
    if (command === null) return 'unknown'
    const cached = this.effortProbe
    if (cached !== undefined && cached.command === command && cached.version === this.detectedVersion) {
      return cached.supported ? 'supported' : 'unsupported'
    }
    try {
      const result = this.runSpawnSync(command, ['--help'], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: WINDOWS, env: commandEnvironment(command),
      })
      const help = `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`
      // 只有真正读到帮助文本才算拿到结论。退出码非零或输出为空时，既可能是
      // 旧 CLI 没有该参数，也可能是本次调用环境异常；一律按 unknown 处理，
      // 不缓存、也不据此清空目录，避免把偶发失败固化成「不支持」。
      if (result.status !== 0 || help.trim() === '') return 'unknown'
      const supported = /--effort\b/u.test(help)
      this.effortProbe = { command, version: this.detectedVersion, supported }
      return supported ? 'supported' : 'unsupported'
    } catch {
      return 'unknown'
    }
  }

  /** 只有确认支持时才下发 `--effort`；旧版本遇到未知选项会整轮失败。 */
  private supportsEffortOption(): boolean {
    return this.probeEffortSupport() === 'supported'
  }

  override dispose(): void {
    this.effortProbe = undefined
    this.detectedVersion = null
    this.toolInputStates.clear()
    this.interactions.clear()
    super.dispose()
  }

  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    const interaction = this.parseInteraction(value, input.sessionId)
    if (interaction !== null) return [interaction]
    const event = value.type === 'stream_event' && typeof value.event === 'object' && value.event !== null ? value.event as Record<string, unknown> : value
    const delta = typeof event.delta === 'object' && event.delta !== null ? event.delta as Record<string, unknown> : null
    if (event.type === 'message_start') this.toolInputStates.delete(input.sessionId)
    if (event.type === 'content_block_delta' && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') return [{ type: 'reasoning-delta', text: delta.thinking }]
    if (event.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') return [{ type: 'text-delta', text: delta.text }]
    if (event.type === 'content_block_start' && isToolRecord(event.content_block) && event.content_block.type === 'tool_use') {
      return this.startClaudeTool(input.sessionId, event)
    }
    if (event.type === 'content_block_delta' && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const state = this.toolInputStates.get(input.sessionId)?.get(claudeBlockIndex(event))
      if (state !== undefined) state.partialJson += delta.partial_json
      return []
    }
    if (event.type === 'content_block_stop') return this.finishClaudeToolInput(input.sessionId, event)
    if ((value.type === 'assistant' || value.type === 'user') && typeof value.message === 'object' && value.message !== null) {
      const message = value.message as Record<string, unknown>
      const content = Array.isArray(message.content) ? message.content : []
      return content.flatMap((part): readonly CodingNsAgentEvent[] => {
        if (!part || typeof part !== 'object') return []
        const item = part as Record<string, unknown>
        if (item.type === 'tool_use') {
          const tool = claudeToolUse(item)
          return tool === null ? [] : [...this.completeClaudeTool(input.sessionId, tool)]
        }
        if (item.type === 'tool_result') {
          const tool = claudeToolResult(item)
          return tool === null ? [] : [...this.flushClaudeToolBeforeResult(input.sessionId, tool.callId), tool]
        }
        // 开启 `--include-partial-messages` 后，正文和思考已经由
        // `stream_event/content_block_delta` 实时下发。这里的 assistant/user
        // 记录只是同一块内容的结算快照，不能再投影到 DSH；否则运行时若把
        // 快照和实时块同时写入同一个 assistant，会把整段正文追加第二遍。
        // 工具生命周期仍由上面的 tool_use/tool_result 分支读取。
        return []
      })
    }
    return super.parseEvent(value, input)
  }

  private parseInteraction(value: Record<string, unknown>, sessionId: string): CodingNsAgentEvent | null {
    if (value.type !== 'control_request' || typeof value.request_id !== 'string' || !isRecord(value.request)) return null
    const requestId = value.request_id.trim()
    const request = value.request
    if (requestId === '' || request.subtype !== 'can_use_tool' || typeof request.tool_name !== 'string' || !isRecord(request.input)) return null
    const toolName = request.tool_name.trim()
    const input = request.input
    const state = this.interactions.get(sessionId)
    if (state === undefined) return null
    const toolUseId = typeof request.tool_use_id === 'string' && request.tool_use_id.trim() !== '' ? request.tool_use_id : undefined
    if (toolName === 'AskUserQuestion') {
      const questions = readAgentQuestions(input.questions ?? input)
      if (questions.length === 0) {
        this.writeControlResponse(state, requestId, {
          behavior: 'deny',
          message: 'Claude Code 的问题请求格式无效',
          decisionClassification: 'user_reject',
          ...(toolUseId ? { toolUseID: toolUseId } : {}),
        })
        return null
      }
      state.pending.set(requestId, {
        kind: 'question', input, toolName, ...(toolUseId ? { toolUseId } : {}),
        questions: questions.map((question, index) => ({ id: question.id, providerKey: readClaudeQuestionKey(input, question, index) })),
      })
      return { type: 'question-request', requestId, questions }
    }
    state.pending.set(requestId, {
      kind: 'permission', input, toolName, ...(toolUseId ? { toolUseId } : {}),
    })
    const reason = typeof request.decision_reason === 'string' && request.decision_reason.trim() !== ''
      ? request.decision_reason.trim()
      : typeof request.blocked_path === 'string' && request.blocked_path.trim() !== ''
        ? `访问路径：${request.blocked_path.trim()}`
        : undefined
    return {
      type: 'permission-request', requestId, kind: toolName, toolName,
      ...(toolUseId ? { callId: toolUseId } : {}), ...(reason ? { detail: reason } : {}),
    }
  }

  /** 开始事件的空 input 是占位；原生调用头不可改写，必须等完整参数。 */
  private startClaudeTool(sessionId: string, event: Record<string, unknown>): readonly CodingNsAgentEvent[] {
    const tool = claudeToolUse(event.content_block as Record<string, unknown>)
    if (tool === null) return []
    if (tool.input !== undefined && tool.input.trim() !== '' && parseClaudeToolInput(tool.input) !== '{}') return [tool]
    const states = this.toolInputStates.get(sessionId) ?? new Map<number, ClaudeToolInputState>()
    states.set(claudeBlockIndex(event), { tool, partialJson: '' })
    this.toolInputStates.set(sessionId, states)
    return []
  }

  /** 参数块结束后才发完整调用；缺失或损坏的增量由 assistant 完整快照补齐。 */
  private finishClaudeToolInput(sessionId: string, event: Record<string, unknown>): readonly CodingNsAgentEvent[] {
    const states = this.toolInputStates.get(sessionId)
    const index = claudeBlockIndex(event)
    const state = states?.get(index)
    if (state === undefined) return []
    const input = parseClaudeToolInput(state.partialJson)
    if (input === undefined) return []
    states?.delete(index)
    return [{ ...state.tool, input }]
  }

  /** assistant 完整快照是调用参数的最终事实，消费掉对应的暂存块避免重复。 */
  private completeClaudeTool(sessionId: string, tool: ClaudeToolEvent): readonly CodingNsAgentEvent[] {
    const callId = tool.callId
    if (callId === undefined) return [tool]
    const states = this.toolInputStates.get(sessionId)
    if (states !== undefined) {
      for (const [index, state] of states) {
        if (state.tool.callId === callId) states.delete(index)
      }
    }
    return [tool]
  }

  /** 没有 assistant 快照时，以工具结果到达作为空参数调用的最后回退点。 */
  private flushClaudeToolBeforeResult(sessionId: string, callId: string | undefined): readonly CodingNsAgentEvent[] {
    if (callId === undefined) return []
    const states = this.toolInputStates.get(sessionId)
    if (states === undefined) return []
    for (const [index, state] of states) {
      if (state.tool.callId !== callId) continue
      states.delete(index)
      return [{ ...state.tool, input: parseClaudeToolInput(state.partialJson) ?? state.tool.input ?? '{}' }]
    }
    return []
  }
}

type ClaudeToolEvent = Extract<CodingNsAgentEvent, { type: 'tool-event' }>

interface ClaudeToolInputState {
  readonly tool: ClaudeToolEvent
  partialJson: string
}

function claudeBlockIndex(event: Record<string, unknown>): number {
  return typeof event.index === 'number' ? event.index : 0
}

function parseClaudeToolInput(value: string): string | undefined {
  if (value.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return JSON.stringify(parsed)
  } catch {
    return undefined
  }
}

const CLAUDE_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png'])

interface PreparedClaudeTurnInput {
  readonly input: CodingNsCliTurnInput
  readonly cleanup: () => Promise<void>
}

async function prepareClaudeTurnInput(input: CodingNsCliTurnInput): Promise<PreparedClaudeTurnInput> {
  const attachments = input.attachments ?? []
  if (!attachments.some((attachment) => attachment.kind === 'image' && !CLAUDE_IMAGE_EXTENSIONS.has(extname(attachment.path).toLowerCase()))) {
    return { input, cleanup: async () => {} }
  }

  let temporaryDirectory: string | undefined
  const prepared: CodingNsCliAttachment[] = []
  try {
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.kind !== 'image' || CLAUDE_IMAGE_EXTENSIONS.has(extname(attachment.path).toLowerCase())) {
        prepared.push(attachment)
        continue
      }
      const bytes = await readFile(attachment.path)
      const extension = claudeImageExtension(attachment, bytes)
      if (extension === undefined) {
        prepared.push(attachment)
        continue
      }
      temporaryDirectory ??= await mkdtemp(join(tmpdir(), 'codingns-claude-image-'))
      const path = join(temporaryDirectory, `attachment-${index}${extension}`)
      await copyFile(attachment.path, path)
      prepared.push({ ...attachment, path })
    }
  } catch (error) {
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
  if (temporaryDirectory === undefined) return { input, cleanup: async () => {} }
  return {
    input: { ...input, attachments: prepared },
    cleanup: async () => { await rm(temporaryDirectory!, { recursive: true, force: true }) },
  }
}

function claudeImageExtension(attachment: CodingNsCliAttachment, bytes: Uint8Array): string | undefined {
  const mime = attachment.mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg'
  const nameExtension = extname(attachment.name ?? '').toLowerCase()
  if (CLAUDE_IMAGE_EXTENSIONS.has(nameExtension)) return nameExtension
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg'
  return undefined
}

function claudeToolUse(item: Record<string, unknown>): ClaudeToolEvent | null {
  const toolName = firstToolText(item.name, item.toolName)
  if (toolName === undefined) return null
  const callId = firstToolText(item.id, item.tool_use_id, item.toolUseId)
  const input = serializeToolValue(item.input ?? item.arguments)
  const agentId = firstToolText(item.agentId, item.agent_id)
  const detail = serializeToolValue(item.detail)
  return {
    type: 'tool-event',
    toolName,
    status: 'running',
    ...(callId ? { callId } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(agentId ? { agentId } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

function claudeToolResult(item: Record<string, unknown>): ClaudeToolEvent | null {
  const callId = firstToolText(item.tool_use_id, item.toolUseId, item.callId)
  if (callId === undefined) return null
  const failed = item.is_error === true || item.isError === true
  const content = serializeToolValue(item.content ?? item.output ?? item.result)
  const agentId = firstToolText(item.agentId, item.agent_id)
  const detail = serializeToolValue(item.detail)
  return {
    type: 'tool-event',
    toolName: firstToolText(item.name, item.toolName) ?? 'tool',
    callId,
    status: failed ? 'failed' : 'completed',
    ...(failed ? (content === undefined ? {} : { error: content }) : (content === undefined ? {} : { output: content })),
    ...(!failed && content !== undefined ? { outputMode: 'snapshot' as const } : {}),
    ...(agentId ? { agentId } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

/** 把 DSH 的生效权限映射到 Claude Code 公开的 permission-mode。 */
function claudePermissionArgs(permission: CodingNsCliTurnInput['permission']): readonly string[] {
  if (permission?.sandboxMode === 'danger-full-access' && permission.approvalPolicy === 'never') return ['--permission-mode', 'bypassPermissions']
  if (permission?.sandboxMode === 'workspace-write' && permission.approvalPolicy === 'never') return ['--permission-mode', 'acceptEdits']
  if (permission?.sandboxMode === 'read-only') return ['--permission-mode', 'plan']
  if (permission?.approvalPolicy === 'ask' && permission.sandboxMode !== undefined) return ['--permission-mode', 'manual']
  // 缺省字段表示 Host 尚未读到权限事实；不猜测为 bypass，沿用 Claude 的默认审批。
  return []
}

function readClaudeQuestionKey(input: Record<string, unknown>, question: CodingNsAgentQuestion, _index: number): string {
  // Claude SDK 的 AskUserQuestion answers 以完整 question 文本为键，而不是 DSH
  // 侧生成的 question-N ID。保留 Provider 原文，避免回答被 CLI 丢弃。
  const source = Array.isArray(input.questions) ? input.questions : []
  for (const item of source) {
    if (!isRecord(item)) continue
    if (typeof item.question === 'string' && item.question.trim() === question.question) return item.question
  }
  return question.question
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 简短别名，便于按适配器名称装配。 */
export { ClaudeCodeDriver as ClaudeDriver }
