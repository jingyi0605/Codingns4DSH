import { spawn, spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type {
  CodingNsAgentEvent,
  CodingNsCliCapability,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type {
  CodingNsCliDriver,
  CodingNsCliSessionProbeInput,
  CodingNsCliSessionProbeResult,
} from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { emptyCatalog, isRecord, streamRpcRequest, textValue, usageChunk } from './rpc-driver-utils.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { buildAcpPromptBlocks } from './attachment-utils.js'
import { acpBridgeMcpServers } from '../cli-bridge/injections.js'
import { advanceCodingNsSegment, createCodingNsSegmentState, decorateCodingNsSegmentEvent } from './stream-normalizer.js'
import { commandEnvironment, resolveCommandPath, WINDOWS } from './process-utils.js'
import { isProviderDefaultModel } from './model-catalog.js'

/** 同源 CodeBuddy / WorkBuddy 的产品身份参数。协议驱动只实现一份。 */
export interface CodeBuddyRuntimeProfile {
  readonly adapterId: 'codebuddy' | 'workbuddy' | string
  readonly displayName: string
  readonly configRootEnvVars: readonly string[]
  readonly defaultConfigRoot: string
  readonly historyDirRule: 'lowercase-slug' | 'preserve-case' | 'none'
  readonly platforms: readonly NodeJS.Platform[]
  readonly commandEnvOverride: string
  readonly binaries: readonly string[]
  readonly bundledInApp: boolean
}

export interface CodeBuddyDriverOptions {
  /** 覆盖 PATH 候选命令，主要用于自定义安装与测试。 */
  readonly binaries?: readonly string[]
  /** 覆盖候选命令；显式值无效时不会回退到其他候选。 */
  readonly commandPath?: string
  /** 测试与宿主注入的环境快照，不会写回 process.env。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** `env` 是 environment 的兼容别名，便于与其他驱动测试保持一致。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly configRoot?: string
  readonly sessionRoots?: readonly string[]
  readonly fallbackCatalog?: CodingNsCliModelCatalog
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  readonly platform?: NodeJS.Platform
  readonly profile?: CodeBuddyRuntimeProfile
}

const CODEBUDDY_HOME = join(homedir(), '.codebuddy')
const WORKBUDDY_HOME = join(homedir(), '.workbuddy-ai')

/** CodeBuddy 独立 CLI 的产品身份。 */
export const CODEBUDDY_PROFILE: CodeBuddyRuntimeProfile = {
  adapterId: 'codebuddy',
  displayName: 'CodeBuddy',
  configRootEnvVars: ['CODEBUDDY_CONFIG_DIR'],
  defaultConfigRoot: CODEBUDDY_HOME,
  historyDirRule: 'lowercase-slug',
  platforms: ['darwin', 'win32', 'linux'],
  commandEnvOverride: 'CODEBUDDY_CLI_PATH',
  binaries: ['codebuddy', 'codebuddy.cmd'],
  bundledInApp: false,
}

/** WorkBuddy 桌面应用内置 CLI 的产品身份。 */
export const WORKBUDDY_PROFILE: CodeBuddyRuntimeProfile = {
  adapterId: 'workbuddy',
  displayName: 'WorkBuddy',
  configRootEnvVars: ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR'],
  defaultConfigRoot: WORKBUDDY_HOME,
  historyDirRule: 'preserve-case',
  platforms: ['darwin', 'win32'],
  commandEnvOverride: 'WORKBUDDY_CLI_PATH',
  // WorkBuddy 的入口文件仍叫 codebuddy，但只能使用桌面应用内置副本。
  binaries: ['codebuddy'],
  bundledInApp: true,
}

/** ACP 驱动的公共能力保持保守；权限/提问/用量尚未在两种产品身份上完成真机验收。 */
const CONSERVATIVE_CAPABILITIES: readonly CodingNsCliCapability[] = [
  'models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning',
]

/** 无副作用模型探测的最低回退项；登记层可以传入更完整的真实目录覆盖它。 */
export const CODEBUDDY_DEFAULT_CATALOG: CodingNsCliModelCatalog = {
  groups: [{ id: 'codebuddy', name: 'CodeBuddy', models: [{ id: 'provider-default', name: '跟随 CodeBuddy 默认模型', efforts: [] }] }],
  currentModel: null,
  currentEffort: null,
}

export const WORKBUDDY_DEFAULT_CATALOG: CodingNsCliModelCatalog = {
  groups: [{ id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'provider-default', name: '跟随 WorkBuddy 默认模型', efforts: [] }] }],
  currentModel: null,
  currentEffort: null,
}

/**
 * CodeBuddy 与 WorkBuddy 共用的 ACP stdio 驱动。
 *
 * 每轮启动一个短生命周期 ACP 进程，继续会话时通过 `session/load` 恢复。
 * 这样取消不会把残留取消态带到下一轮，且不需要复制厂商 SDK 或桌面应用登录态。
 */
export class CodeBuddyCliDriver implements CodingNsCliDriver {
  readonly descriptor: Omit<import('../../shared/contracts/cli-adapter.js').CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>
  /** CodeBuddy/WorkBuddy 的 ACP 流可由 Registry 在工具完成后暂停并续读。 */
  readonly supportsToolStepSplitting = true
  protected readonly profile: CodeBuddyRuntimeProfile
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly environment: Readonly<Record<string, string | undefined>>
  private readonly configRoot: string
  private readonly sessionRoots: readonly string[]
  private readonly fallbackCatalog: CodingNsCliModelCatalog
  private readonly platform: NodeJS.Platform
  private readonly binaries: readonly string[]
  private readonly binariesOverride: boolean
  private readonly commandPath: string | undefined
  private cachedCommand: string | null = null
  private lastVersion: string | null = null
  private detectionDiagnostic: string | undefined
  private readonly processes = new Map<string, { readonly rpc: JsonRpcProcess; providerSessionId: string }>()

  constructor(options: CodeBuddyDriverOptions = {}) {
    this.profile = options.profile ?? CODEBUDDY_PROFILE
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    this.platform = options.platform ?? process.platform
    this.binariesOverride = options.binaries !== undefined
    this.binaries = options.binaries ?? this.profile.binaries
    this.commandPath = options.commandPath?.trim() || undefined
    this.environment = { ...process.env, ...(options.environment ?? options.env ?? {}) }
    this.configRoot = resolveConfigRoot(this.profile, options.configRoot, this.environment)
    this.sessionRoots = options.sessionRoots ?? [join(this.configRoot, 'projects'), join(this.configRoot, 'sessions')]
    this.fallbackCatalog = options.fallbackCatalog ?? (this.profile.adapterId === WORKBUDDY_PROFILE.adapterId ? WORKBUDDY_DEFAULT_CATALOG : CODEBUDDY_DEFAULT_CATALOG)
    this.descriptor = {
      id: this.profile.adapterId,
      name: this.profile.displayName,
      protocol: 'acp',
      capabilities: CONSERVATIVE_CAPABILITIES,
    }
  }

  /** 当前使用的产品身份配置根，供测试和诊断使用；不包含凭据。 */
  get configDirectory(): string { return this.configRoot }

  /** 最近一次探测失败的脱敏诊断。 */
  get discoveryError(): string | undefined { return this.detectionDiagnostic }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    if (!this.profile.platforms.includes(this.platform)) {
      this.detectionDiagnostic = `${this.profile.displayName} 官方未提供 ${this.platform} 平台版本`
      return { installed: false, version: null, command: null }
    }

    const explicit = this.explicitCommand()
    if (explicit !== undefined) {
      const result = this.detectCommand(explicit)
      if (result !== null) return result
      this.detectionDiagnostic = `${this.profile.displayName} 显式指定的 CLI 路径无效`
      return { installed: false, version: null, command: null }
    }

    for (const command of this.candidateCommands()) {
      const result = this.detectCommand(command)
      if (result !== null) return result
    }
    this.detectionDiagnostic = `${this.profile.displayName} CLI 未安装`
    return { installed: false, version: null, command: null }
  }

  /** ACP 无模型探测接口时只返回登记层提供的静态回退目录，避免创建 Provider 会话。 */
  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detection = await this.detect()
    return detection.installed ? this.fallbackCatalog : emptyCatalog()
  }

  /** 只读扫描产品自己的历史根；不会调用 ACP load/prompt。 */
  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && (path.endsWith(`${id}.jsonl`) || basename(path).includes(id)),
      validate: async (path, id) => {
        const record = await readFirstJsonRecord(path)
        const value = record?.sessionId ?? record?.session_id ?? record?.id
        return value === id
      },
    })
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedCommand ?? (await this.detect()).command
    if (command === null) throw new Error(`${this.profile.displayName} CLI 未安装`)

    const rpc = new JsonRpcProcess({
      command,
      args: ['--acp'],
      cwd: input.cwd,
      env: this.runtimeEnvironment(command),
      spawn: this.runSpawn,
    })
    const processState = { rpc, providerSessionId: '' }
    this.processes.set(input.sessionId, processState)
    // 未声明 permission/questions 时，私有交互必须快速拒绝，不能让一轮永久等待。
    rpc.setServerRequestHandler(() => ({ outcome: { outcome: 'cancelled' } }))
    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
        clientCapabilities: {},
      }, { signal: input.signal })
      rpc.notify('initialized', {})

      const session = input.providerSessionId
        ? await rpc.request('session/load', {
          sessionId: input.providerSessionId,
          cwd: input.cwd ?? process.cwd(),
          mcpServers: acpBridgeMcpServers(input.sessionId, this.profile.adapterId),
        }, { signal: input.signal })
        : await rpc.request('session/new', {
          cwd: input.cwd ?? process.cwd(),
          mcpServers: acpBridgeMcpServers(input.sessionId, this.profile.adapterId),
        }, { signal: input.signal })
      const providerSessionId = readSessionId(session) ?? input.providerSessionId ?? input.sessionId
      processState.providerSessionId = providerSessionId
      yield { type: 'session-binding', providerSessionId }

      // ACP 版本间的模型设置方法并不完全一致；失败时沿用 Provider 默认模型，不能阻断本轮。
      if (!isProviderDefaultModel(input.modelId)) {
        await rpc.request('session/set_model', { sessionId: providerSessionId, modelId: input.modelId }, { signal: input.signal, killOnAbort: false }).catch(() => undefined)
      }

      const stream = streamRpcRequest(rpc, 'session/prompt', {
        sessionId: providerSessionId,
        prompt: await buildAcpPromptBlocks(input.prompt, input.attachments ?? []),
      }, input.signal, { dispose: false, killOnAbort: false })
      let finished = false
      const segmentState = createCodingNsSegmentState()
      let promptResponse: unknown
      while (true) {
        const item = await stream.next()
        if (item.done) {
          promptResponse = item.value
          break
        }
        const rawChunk = codeBuddyMessageToChunk(item.value)
        const chunk = rawChunk === null ? null : decorateCodingNsSegmentEvent(rawChunk, input, segmentState, this.descriptor.id)
        if (chunk?.type === 'finish') finished = true
        if (chunk !== null) yield chunk
        if (chunk !== null) advanceCodingNsSegment(chunk, segmentState)
      }
      if (!finished) yield { type: 'finish', reason: promptReason(promptResponse, input.signal) }
    } finally {
      if (this.processes.get(input.sessionId) === processState) this.processes.delete(input.sessionId)
      await rpc.disposeAndWait()
    }
  }

  /** 中断当前 ACP 进程；服务端取消失败时仍关闭本轮进程。 */
  async interrupt(sessionId: string): Promise<void> {
    const state = this.processes.get(sessionId)
    if (state === undefined) return
    try {
      await state.rpc.request('session/cancel', { sessionId: state.providerSessionId || sessionId }, { killOnAbort: false })
    } catch { /* 进程关闭兜底 */ }
    state.rpc.dispose()
  }

  dispose(): void {
    for (const state of this.processes.values()) state.rpc.dispose()
    this.processes.clear()
    this.cachedCommand = null
    this.lastVersion = null
  }

  private explicitCommand(): string | undefined {
    if (this.commandPath !== undefined) return this.commandPath
    const value = this.profile.commandEnvOverride === '' ? undefined : this.environment[this.profile.commandEnvOverride]
    return value?.trim() || undefined
  }

  private candidateCommands(): readonly string[] {
    if (this.profile.bundledInApp && !this.binariesOverride) return bundledWorkBuddyCommands(this.platform, this.environment)
    return this.binaries
  }

  private detectCommand(command: string): { installed: true; version: string; command: string } | null {
    try {
      const options: SpawnSyncOptions = {
        encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: WINDOWS,
        env: this.runtimeEnvironment(command),
      }
      const result = this.runSpawnSync(command, ['--version'], options) as SpawnSyncReturns<string>
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      const version = output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0]
      if (result.status === 0 && version !== undefined) {
        this.cachedCommand = command
        this.lastVersion = version
        this.detectionDiagnostic = undefined
        return { installed: true, version, command }
      }
      // CodeBuddy 的 PATH shim 可能在 GUI 环境中不在当前 PATH，失败后只对非内置产品做一次登录 Shell 查找。
      if (!this.profile.bundledInApp && !isAbsolute(command) && result.status === null) {
        const resolved = resolveCommandPath(command, this.runSpawnSync)
        if (resolved !== null && resolved !== command) return this.detectCommand(resolved)
      }
    } catch {
      // 继续尝试下一个官方候选；错误只保留脱敏诊断。
    }
    return null
  }

  private runtimeEnvironment(command: string): Readonly<Record<string, string | undefined>> {
    const env = { ...commandEnvironment(command), ...this.environment }
    for (const variable of this.profile.configRootEnvVars) env[variable] = this.configRoot
    return env
  }
}

/** WorkBuddy 只允许应用内置 codebuddy，不会误启动 PATH 上的 CodeBuddy。 */
export class WorkBuddyCliDriver extends CodeBuddyCliDriver {
  constructor(options: Omit<CodeBuddyDriverOptions, 'profile'> = {}) {
    super({ ...options, profile: WORKBUDDY_PROFILE })
  }
}

export { CodeBuddyCliDriver as CodeBuddyDriver }

function resolveConfigRoot(
  profile: CodeBuddyRuntimeProfile,
  explicit: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const candidate = explicit?.trim()
    || profile.configRootEnvVars.map((name) => environment[name]?.trim()).find((value): value is string => Boolean(value))
    || profile.defaultConfigRoot
  return candidate
}

function bundledWorkBuddyCommands(platform: NodeJS.Platform, environment: Readonly<Record<string, string | undefined>>): readonly string[] {
  if (platform === 'darwin') {
    const roots = [
      '/Applications/WorkBuddy AI.app',
      '/Applications/WorkBuddy.app',
      join(homedir(), 'Applications/WorkBuddy AI.app'),
      join(homedir(), 'Applications/WorkBuddy.app'),
    ]
    return roots.map((root) => join(root, 'Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'))
  }
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA ?? join(homedir(), 'AppData/Local')
    const programFiles = environment.PROGRAMFILES ?? 'C:\\Program Files'
    const roots = [
      join(local, 'Programs/WorkBuddy AI'),
      join(local, 'Programs/WorkBuddy'),
      join(programFiles, 'WorkBuddy AI'),
      join(programFiles, 'WorkBuddy'),
    ]
    return roots.flatMap((root) => [
      join(root, 'resources/app.asar.unpacked/cli/bin/codebuddy.exe'),
      join(root, 'resources/app.asar.unpacked/cli/bin/codebuddy.cmd'),
      join(root, 'resources/app.asar.unpacked/cli/bin/codebuddy'),
    ])
  }
  return []
}

function codeBuddyMessageToChunk(message: JsonRpcMessage): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const method = typeof message.method === 'string' ? message.method.toLowerCase() : ''
  const rawType = update.sessionUpdate ?? update.type ?? method
  const type = typeof rawType === 'string' ? rawType.toLowerCase() : ''
  const text = acpText(update.delta ?? update.text ?? update.content ?? update.message)
  const content = isRecord(update.content) ? update.content : undefined
  const messageId = firstToolText(update.messageId, update.message_id, update.itemId, update.item_id, content?.messageId, content?.message_id, content?.id)
  const withMessageId = messageId === undefined ? {} : { messageId }

  if (type.includes('permission') || type.includes('interruption')) return null
  if (type.includes('thought') || type.includes('reason')) return text ? { type: 'reasoning-delta', text, ...withMessageId } : null
  if (type.includes('user') && type.includes('message')) return null
  if (type.includes('agent_message') || type.includes('text') || type === 'message') return text ? { type: 'text-delta', text, ...withMessageId } : null

  if (type.includes('tool') || type.includes('command')) {
    const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
    const toolName = firstToolText(tool.name, tool.toolName, tool.tool_name, tool.title, update.name, update.toolName, update.tool_name, update.title)
    const callId = firstToolText(tool.callId, tool.call_id, tool.toolCallId, tool.tool_call_id, tool.toolUseId, tool.tool_use_id, tool.id, update.toolCallId, update.tool_call_id, update.id)
    if (toolName === undefined && callId === undefined) return null
    const input = serializeToolValue(tool.rawInput ?? tool.input ?? tool.arguments ?? tool.args ?? tool.parameters ?? update.rawInput)
    const output = serializeToolValue(tool.rawOutput ?? tool.output ?? tool.result ?? update.rawOutput)
    const error = serializeToolValue(tool.error ?? update.error)
    const fallback = error !== undefined || type.includes('error') || type.includes('fail')
      ? 'failed'
      : output !== undefined || type.includes('result') || type.includes('complete')
        ? 'completed'
        : 'running'
    return {
      type: 'tool-event',
      toolName: toolName ?? 'tool',
      status: normalizeToolStatus(tool.status ?? tool.state ?? update.status, fallback),
      ...(callId === undefined ? {} : { callId }),
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output, outputMode: type.includes('delta') ? 'delta' as const : 'snapshot' as const }),
      ...(error === undefined ? {} : { error }),
      ...(firstToolText(tool.agentId, tool.agent_id, update.agentId, update.agent_id) ? { agentId: firstToolText(tool.agentId, tool.agent_id, update.agentId, update.agent_id)! } : {}),
      ...(serializeToolValue(tool.detail ?? update.detail) === undefined ? {} : { detail: serializeToolValue(tool.detail ?? update.detail)! }),
    }
  }

  const usage = usageChunk(update)
  if (usage !== null) return usage
  if (type.includes('turn_completed') || type.includes('turn_complete') || type.includes('prompt_end') || type === 'done' || type === 'result' || type === 'completed') return { type: 'finish', reason: 'stop' }
  if (type.includes('error') || type.includes('failed')) {
    const failure = readFailure(update)
    return { type: 'finish', reason: 'error', ...(failure === undefined ? {} : { failure }) }
  }
  return null
}

function readSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId === 'string' && value.sessionId.trim()) return value.sessionId.trim()
  if (typeof value.session_id === 'string' && value.session_id.trim()) return value.session_id.trim()
  if (isRecord(value.session) && typeof value.session.id === 'string' && value.session.id.trim()) return value.session.id.trim()
  return typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null
}

function promptReason(value: unknown, signal: AbortSignal | undefined): 'stop' | 'cancel' | 'error' {
  if (signal?.aborted) return 'cancel'
  if (!isRecord(value) || typeof value.stopReason !== 'string') return 'stop'
  const reason = value.stopReason.toLowerCase()
  return reason === 'cancelled' || reason === 'canceled' ? 'cancel' : reason === 'error' || reason === 'failed' ? 'error' : 'stop'
}

function acpText(value: unknown): string | null {
  const direct = textValue(value)
  if (direct) return direct
  if (Array.isArray(value)) {
    const joined = value.map((item) => acpText(item) ?? '').join('')
    return joined.trim() ? joined : null
  }
  if (isRecord(value)) {
    for (const key of ['text', 'delta', 'content', 'message']) {
      const nested = acpText(value[key])
      if (nested) return nested
    }
  }
  return null
}

function readFailure(value: Record<string, unknown>): { message: string; code?: string } | undefined {
  const error = isRecord(value.error) ? value.error : value
  const message = firstToolText(error.message, error.errorMessage, error.error_message, error.detail, error.reason)
  if (message === undefined) return undefined
  const code = firstToolText(error.code, error.errorCode, error.error_code)
  return code === undefined ? { message } : { message, code }
}
