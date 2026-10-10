import type { SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { CodingNsAgentEvent, CodingNsAgentPermissionResponse, CodingNsAgentQuestion, CodingNsAgentQuestionResponse, CodingNsCliModelCatalog, CodingNsCliSkillDescriptor, CodingNsCliSkillListInput, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { CLAUDE_CATALOG, clearEfforts, isProviderDefaultModel } from './model-catalog.js'
import { discoverClaudeModelCatalog } from './claude-model-options.js'
import { spawnClaudeProcess } from './claude-process.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, serializeToolValue } from './tool-observation.js'
import { buildClaudeUserContent } from './attachment-utils.js'
import { WINDOWS, commandEnvironment, runAsyncCommand, type CodingNsChildProcess } from './process-utils.js'
import { claudeBridgeArgs } from '../cli-bridge/injections.js'
import { readAgentQuestions } from './interaction-events.js'
import { scanCompatibleSkills } from './skill-filesystem.js'

export interface ClaudeCodeDriverOptions extends StandardStreamDriverOptions {
  /** 测试或托管环境可显式指定用户级 Skill 根目录。 */
  readonly skillRoots?: readonly string[]
  /** 企业托管配置目录；默认使用 Claude Code 对应平台的原生位置。 */
  readonly managedSettingsDir?: string
}

function defaultClaudeManagedSettingsDir(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (process.platform === 'win32') return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode')
  return '/etc/claude-code'
}

/** 仅读取 Skill 可见性相关字段，避免凭据或其他设置进入目录响应。 */
function claudeSkillSettings(cwd: string, configDir: string, managedDir: string): {
  readonly skillOverrides: Record<string, unknown>
  readonly strictPluginOnlyCustomization: boolean
} {
  let projectRoot = cwd
  let current = cwd
  while (true) {
    if (existsSync(join(current, '.git'))) { projectRoot = current; break }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const skillOverrides: Record<string, unknown> = {}
  let strictPluginOnlyCustomization = false
  // 用户 < 项目 < 本地 < 企业，和 Claude 的设置来源优先级一致。
  const paths = [join(configDir, 'settings.json'), join(projectRoot, '.claude', 'settings.json'), join(projectRoot, '.claude', 'settings.local.json'), join(managedDir, 'managed-settings.json')]
  for (const path of paths) {
    try {
      const settings: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!isToolRecord(settings)) continue
      if (isToolRecord(settings.skillOverrides)) Object.assign(skillOverrides, settings.skillOverrides)
      if (path === paths.at(-1)) strictPluginOnlyCustomization = settings.strictPluginOnlyCustomization === true
    } catch { /* 缺少或无法解析的配置交给 Claude 自身诊断，不污染 Skill 菜单。 */ }
  }
  return { skillOverrides, strictPluginOnlyCustomization }
}

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
  readonly userContent: readonly Record<string, unknown>[]
}

export class ClaudeCodeDriver extends StandardStreamDriver {
  /** Claude 的 stream-json 可以在工具完成后暂停并由 Registry 续读同一进程。 */
  readonly supportsToolStepSplitting = true
  private readonly sessionRoots: readonly string[]
  private readonly claudeConfigDir: string | undefined
  private readonly discoveryFetch: typeof fetch | undefined
  private readonly skillRoots: readonly string[] | undefined
  private readonly managedSettingsDir: string
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

  constructor(options: ClaudeCodeDriverOptions = {}) {
    super({ id: 'claude-code', name: 'Claude Code', protocol: 'stream-json', capabilities: ['models', 'skills', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions'] }, { binaries: ['claude'] }, options)
    this.sessionRoots = options.sessionRoots ?? [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')]
    this.claudeConfigDir = options.claudeConfigDir
    this.discoveryFetch = options.fetch
    this.skillRoots = options.skillRoots
    this.managedSettingsDir = options.managedSettingsDir ?? defaultClaudeManagedSettingsDir()
  }
  private readonly interactions = new Map<string, ClaudeInteractionState>()

  /** Claude 的 SDK wire 通过 stdin 接收首条 user 消息并回传 control_response。 */
  protected get usesStdin(): boolean { return true }

  protected override spawnProcess(command: string, args: readonly string[], options: SpawnOptions): CodingNsChildProcess {
    return spawnClaudeProcess(command, args, options, this.runSpawn) as CodingNsChildProcess
  }

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
    state.write(`${JSON.stringify({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: state.userContent },
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
    if (detected.installed) await this.probeEffortSupport()
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
    return (await this.probeEffortSupport()) === 'unsupported' ? clearEfforts(catalog) : catalog
  }

  /** Claude Code 原生按 SKILL.md 目录发现 Skill；正文仍由 Claude 自己加载。 */
  async listSkills(input: CodingNsCliSkillListInput): Promise<readonly CodingNsCliSkillDescriptor[]> {
    if (input.signal?.aborted) throw new Error('Skill 目录读取已取消')
    const cwd = resolve(input.cwd?.trim() || process.cwd())
    const configDir = this.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    const settings = claudeSkillSettings(cwd, configDir, this.managedSettingsDir)
    if (settings.strictPluginOnlyCustomization === true) return []
    const roots = this.skillRoots ?? [join(this.managedSettingsDir, '.claude', 'skills'), join(configDir, 'skills')]
    const entries = scanCompatibleSkills(cwd, {
      projectDirectories: ['.claude/skills'],
      userDirectories: roots,
      userFirst: true,
      stopAtGitRoot: true,
    })
    return entries.map(({ path: _path, ...descriptor }) => ({
      ...descriptor,
      // 子目录限定名仍是同一个 Skill，普通名称的禁用设置也必须作用于它。
      enabled: descriptor.enabled && (settings.skillOverrides[descriptor.name] ?? settings.skillOverrides[descriptor.name.split(':').at(-1) ?? '']) !== 'off',
    }))
  }
  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path) === `${id}.jsonl`,
      validate: async (path, id) => (await readFirstJsonRecord(path))?.sessionId === id,
    })
  }

  /**
   * 图片通过原生 stdin 内容块发送，避免 @路径解析器按后缀拒绝无扩展名图片。
   * 同一通路支持 PNG/JPEG/GIF/WebP；文件附件继续开放其原始目录供工具读取。
   */
  override async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const userContent = await buildClaudeUserContent(input.prompt, input.attachments ?? [])
    this.toolInputStates.delete(input.sessionId)
    const interaction: ClaudeInteractionState = { write: undefined, pending: new Map(), userContent }
    this.interactions.set(input.sessionId, interaction)
    try {
      // 图片已内联，不能再让文本驱动生成副本或把相同图片作为 @路径发送第二遍。
      yield* super.executeTurn({ ...input, attachments: (input.attachments ?? []).filter((attachment) => attachment.kind === 'file') })
    } finally {
      this.toolInputStates.delete(input.sessionId)
      if (this.interactions.get(input.sessionId) === interaction) this.interactions.delete(input.sessionId)
    }
  }

  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    // Claude Agent SDK 在 canUseTool 回调存在时使用这个隐藏的 stdio 协议入口。
    // `--permission-prompts host` 只决定提示由谁回答，没有注册 stdio
    // 权限处理器；CLI 因而不向模型提供 AskUserQuestion。
    const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--include-partial-messages', '--verbose']
    args.push(...claudePermissionArgs(input.permission))
    // 子代理托管开启时注入 MCP 替身工具并停用内建 Task/Agent 子代理。
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
  private async probeEffortSupport(): Promise<'supported' | 'unsupported' | 'unknown'> {
    const command = this.resolvedBinary
    if (command === null) return 'unknown'
    const cached = this.effortProbe
    if (cached !== undefined && cached.command === command && cached.version === this.detectedVersion) {
      return cached.supported ? 'supported' : 'unsupported'
    }
    try {
      const result = await runAsyncCommand(this.runSpawnSync, command, ['--help'], {
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
    return this.effortProbe?.command === this.resolvedBinary && this.effortProbe?.version === this.detectedVersion && this.effortProbe?.supported === true
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
