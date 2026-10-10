import { runAsyncCommand } from './process-utils.js'
import { detectBinary } from './binary-detection.js'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import readline from 'node:readline'
import type {
  CodingNsCliModelCatalog,
  CodingNsAgentEvent,
  CodingNsAgentToolEvent,
  CodingNsAgentPermissionResponse,
  CodingNsAgentQuestionResponse,
  CodingNsCliCapability,
  CodingNsCliSkillDescriptor,
  CodingNsCliSkillListInput,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { firstToolText, serializeToolValue } from './tool-observation.js'
import { usageChunk } from './rpc-driver-utils.js'
import { commandEnvironment, terminateChildProcess, type CodingNsChildProcess } from './process-utils.js'
import { prepareAttachmentPaths, promptWithAttachmentPaths } from './attachment-utils.js'
import { parseSkillFrontmatter } from './skill-filesystem.js'
import { commandCodeNativeAgentArgs, commandCodeNativeAgentEnvironment, subagentBridgeActive } from '../cli-bridge/injections.js'
import { getSubagentBridge } from '../cli-bridge/bridge-holder.js'
import { AcpCliDriver, type AcpPendingQuestionRequest } from './acp-cli-driver.js'
import type { JsonRpcMessage, JsonRpcProcess } from './json-rpc-process.js'
import { knownCommandCodeContextWindow } from './model-catalog.js'
import {
  CommandCodeHistory,
  type CommandCodeHistoryDelta,
  type CommandCodeHistoryDirection,
  type CommandCodeHistoryMessage,
  type CommandCodeHistoryPage,
  type CommandCodeHistorySubscription,
  type CommandCodeContextUsage,
  type CommandCodeHistoryOptions,
  type CommandCodeForkResult,
  type CommandCodeSessionStats,
  type CommandCodeResumeSessionResult,
  type CommandCodeSendMessageResult,
  type CommandCodeStartSessionResult,
  type CommandCodeSessionDiscovery,
  type CommandCodeSessionSummary,
} from './command-code-history.js'

const WINDOWS = process.platform === 'win32'
const COMMAND_CODE_BINARIES = WINDOWS
  ? ['command-code', 'commandcode', 'cmdc']
  : ['command-code', 'commandcode', 'cmdc', 'cmd']
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const CATALOG_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['deepseek/deepseek-v4-flash-vision-exp', ['high', 'max']],
  ['deepseek/deepseek-v4-pro', ['high', 'max']],
  ['deepseek/deepseek-v4-flash', ['high', 'max']],
  ['deepseek/deepseek-v4.1-flash', ['low', 'high', 'max']],
  ['deepseek/deepseek-v4.1', ['low', 'high', 'max']],
  ['deepseek/deepseek-v4-flash-fast', ['low', 'high', 'max']],
  ['moonshotai/kimi-k3', ['low', 'high', 'max']],
  ['moonshotai/kimi-k2.7-code', []],
  ['moonshotai/kimi-k2.7-code-highspeed', []],
  ['moonshotai/kimi-k2.6', []],
  ['moonshotai/kimi-k2.5', []],
  ['z-ai/glm-5.3-flash', ['low', 'high', 'max']],
  ['z-ai/glm-5.3-flashx', ['low', 'high', 'max']],
  ['zai-org/glm-5.3', ['low', 'high', 'max']],
  ['zai-org/glm-5.2', ['high', 'max']],
  ['zai-org/glm-5.2-fast', []],
  ['zai-org/glm-5.1', []],
  ['zai-org/glm-5', []],
  ['minimaxai/minimax-m3', ['low', 'medium', 'high']],
  ['minimaxai/minimax-m2.7', []],
  ['minimaxai/minimax-m2.5', []],
  ['xiaomi/mimo-v2.6-pro', []],
  ['xiaomi/mimo-v2.6-pro-ultraspeed', []],
  ['xiaomi/mimo-v2.6-flash', []],
  ['xiaomi/mimo-v2.5-pro', []],
  ['xiaomi/mimo-v2.5', []],
  ['qwen/qwen3.8-omni-flash', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-max-0902', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-max', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-27b', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-flash', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.7-max', []],
  ['qwen/qwen3.7-plus', []],
  ['qwen/qwen3.7-flash', []],
  ['qwen/qwen3.6-max-preview', []],
  ['qwen/qwen3.6-plus', []],
  ['meituan/longcat-2.0', []],
  ['stepfun/step-5-preview', []],
  ['stepfun/step-3.7-flash', []],
  ['stepfun/step-3.5-flash', []],
  ['tencent/hy3-paid', []],
  ['tencent/hy4-preview', ['low', 'medium', 'high']],
  ['nvidia/nemotron-3-ultra-550b-a55b', []],
  ['thinkingmachines/inkling', []],
  ['thinkingmachines/inkling-small', []],
  ['poolside/laguna-s-2.1-free', []],
  ['inclusionai/ling-3.0-flash-sante:free', []],
  ['sakana/fugu-ultra', ['high', 'xhigh']],
  ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-sonnet-4-6', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-fable-5-1', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-haiku-4-5', []],
  ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-terra', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.5', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.4', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.4-mini', ['low', 'medium', 'high']],
  ['google/gemini-3.8-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.7-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.6-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.5-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.5-flash-lite', ['low', 'medium', 'high']],
  ['google/gemini-3.1-flash-lite', ['low', 'medium', 'high']],
  ['meta/muse-spark-1.1', ['low', 'medium', 'high', 'xhigh']],
  ['meta/muse-spark-1.2', ['low', 'medium', 'high', 'xhigh']],
  ['meta/muse-spark-1.2-contributor', ['low', 'medium', 'high', 'xhigh']],
  ['meta/muse-spark-1.3', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['meta/muse-spark-1.3-contributor', ['low', 'medium', 'high', 'xhigh']],
  ['xai/grok-4.6', ['low', 'medium', 'high', 'xhigh']],
  ['xai/grok-4.5', ['low', 'medium', 'high']],
  ['xai/grok-4.7', ['low', 'medium', 'high', 'xhigh']],
])

/**
 * 按模型名的最后一段回退查找思考强度。
 *
 * BYOK 提供者的模型 id 带自定义前缀（如 `mcgrox/deepseek-v4.1-flash`），
 * 而 CATALOG_EFFORTS 的键是 Command Code 内置目录 id（`deepseek/deepseek-v4.1-flash`），
 * 直接查表会落空，导致菜单只剩 Default。表内 77 个键的最后一段互不重复，
 * 因此可以安全地按末段匹配；命中多个时按歧义处理并返回空，避免误判。
 */
function catalogEffortsFor(id: string): readonly string[] {
  const key = id.toLowerCase()
  const direct = CATALOG_EFFORTS.get(key)
  if (direct !== undefined) return direct
  const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
  if (bare === key) return []
  let matched: readonly string[] | undefined
  for (const [candidate, efforts] of CATALOG_EFFORTS) {
    if (!candidate.endsWith(`/${bare}`)) continue
    if (matched !== undefined) return [] // 末段歧义，宁可不给强度也不猜
    matched = efforts
  }
  return matched ?? []
}

/**
 * 读取 BYOK 提供者在 `~/.commandcode/providers.json` 里声明的思考强度。
 *
 * 这是 BYOK 模型强度的权威来源：用户在 providers.json 的模型条目上写
 * `reasoningEfforts: [...]`，Command Code 据此校验 `--effort`。内置目录查不到
 * 的自定义模型只能从这里拿到强度。键为 `提供者/模型` 小写形式，空 Map 表示无声明。
 */
function readDeclaredEfforts(homeDirectory: string): ReadonlyMap<string, readonly string[]> {
  const declared = new Map<string, readonly string[]>()
  const config = readJson(join(homeDirectory, 'providers.json'))
  if (config === null) return declared
  const providers = isRecord(config.provider) ? config.provider : isRecord(config.providers) ? config.providers : null
  if (providers === null) return declared
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue
    for (const [modelName, entry] of Object.entries(provider.models)) {
      if (!isRecord(entry) || !Array.isArray(entry.reasoningEfforts)) continue
      const efforts = entry.reasoningEfforts.filter((value): value is string => typeof value === 'string' && VALID_EFFORTS.has(value))
      if (efforts.length > 0) declared.set(`${providerId}/${modelName}`.toLowerCase(), efforts)
    }
  }
  return declared
}

/** 一个 `-p` 运行的事件队列；进程常驻，DSH step 之间只暂停消费。 */
interface CommandCodeEventQueue {
  next(): Promise<IteratorResult<CodingNsAgentEvent>>
  push(event: CodingNsAgentEvent): void
  close(): void
}

/** Command Code 的 `--output-format json` 在一个进程里跑完整个 agent 循环。 */
interface CommandCodeTurn {
  readonly sessionId: string
  /** 当前活动子进程；撞到 --max-turns 自动续跑时会被替换成新进程。 */
  child: CodingNsChildProcess | undefined
  /** 首轮使用的持久 transcript；原生恢复时为空。 */
  readonly transcriptPath: string | undefined
  /** Provider 返回的真实会话 ID；存在时后续进程必须使用 --resume。 */
  providerSessionId: string | undefined
  /** Provider canonical transcript 的 Host 私有路径。 */
  rawStoreRef: string | undefined
  /** 当前消息显式引用的 Skill 路径；路径只进入 CLI 参数，不暴露给 Client。 */
  readonly skillPaths: readonly string[]
  readonly cwd: string
  readonly queue: CommandCodeEventQueue
  /** 当前 assistant 消息身份；正文/推理增量必须携带它，公共投影层才能切块。 */
  currentMessageId: string | undefined
  /** 只有工具真正完成后才允许在下一个 assistant 消息处结束 DSH step。 */
  sawCompletedTool: boolean
  /** 已提前取出、等待下一个 DSH step 继续消费的事件。 */
  pendingChunk: CodingNsAgentEvent | undefined
  /** 运行已经产出终态事件（可能仍在队列里等待消费）。 */
  terminal: boolean
  /** 消费者已经收到 finish；此后不能再被续段复用。 */
  finished: boolean
  aborted: boolean
  failure: Error | null
  disposed: boolean
  /** 已启动的 CLI 尝试次数；撞到 --max-turns 自动续跑时递增。 */
  attempt: number
  /** 最近一次尝试是否撞到 --max-turns 上限（需要自动续跑）。 */
  maxTurnsReached: boolean
  /** 已产生的 assistant 消息序号；跨自动续跑保持单调，避免消息身份重复。 */
  messageSequence: number
  /** 最近一次 CLI 尝试的 stderr 尾部，仅用于失败诊断。 */
  stderrTail: string
  /** 图片副本随整个 Provider turn 释放，跨 DSH step 和自动续跑持续可读。 */
  attachmentCleanup?: () => void
}

interface CommandCodeSkillEntry extends CodingNsCliSkillDescriptor {
  /** `--skill` 需要的 Host 私有目录路径。 */
  readonly path: string
}

/** 单次运行内的消息标识与增量补齐状态。 */
interface CommandCodeStreamState {
  messageSequence: number
  messageId: string | null
  emittedText: string
  emittedReasoning: string
  sawText: boolean
  /** 上一个 Provider assistant 消息是否已经结算过工具。 */
  sawCompletedTool: boolean
  /** 只有 Host 开启 DSH 分段桥接时才产生 step-boundary。 */
  splitToolSteps: boolean
  perRequestUsageSeen: boolean
  turnUsageSeen: boolean
  /** 当前 assistant 消息携带的最后一份 usage 快照，等待消息边界结算。 */
  pendingMessageUsage: Extract<CodingNsAgentEvent, { type: 'usage' }> | null
  /** Provider 原生会话 ID，用于 session-binding 与恢复。 */
  sessionId: string | null
  /** DSH 父会话 ID，用于外部 CLI 子代理桥接重定向。 */
  bridgeSessionId: string
  aborted: () => boolean
  /** 本次尝试是否以 `--max-turns` 上限结束；上限不是终态，需要自动续跑。 */
  maxTurnsReached: boolean
  /** 已经从 Provider 收到运行终态，避免 run_end 与 result 重复结束。 */
  terminalEmitted: boolean
}

export interface CommandCodeDriverOptions {
  readonly homeDirectory?: string
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  /** 传给 CLI 的 `--max-turns`；缺省用 DEFAULT_MAX_TURNS，避免落到 CLI 的 100 轮默认值。 */
  readonly maxTurns?: number
  /** 撞到 `--max-turns` 上限后自动续跑的次数上限；0 表示撞上限即结束。 */
  readonly autoContinueMaxAttempts?: number
  /** 自动续跑时发给 CLI 的输入文本。 */
  readonly autoContinuePrompt?: string
  /** 可注入 Provider status 读取器；用于在 transcript 没有窗口字段时校准上下文容量。 */
  readonly readStatus?: CommandCodeHistoryOptions['readStatus']
  /** 正式 Host 运行时启用 `cmd acp`，支持 DSH 原生权限和问题回传。 */
  readonly enableAcp?: boolean
}

/**
 * CLI 的 `--max-turns` 默认只有 100，复杂任务经常在半途被截断。
 *
 * 这里显式抬高预算，避免“还没做完就输出结束”；真撞到了再由自动续跑兜底。
 */
const DEFAULT_MAX_TURNS = 500
const DEFAULT_AUTO_CONTINUE_ATTEMPTS = 3
const AUTO_CONTINUE_PROMPT = '继续'

/** Command Code ACP 自由文本兼容 loader 的 URL；只注入子进程，不改写安装包。 */
const COMMAND_CODE_ACP_LOADER_URL = new URL('./command-code-acp-loader.js', import.meta.url).href

function commandCodeAcpEnvironment(): Readonly<Record<string, string>> {
  // file URL 会把空格编码成 %20，避免 Windows 的 NODE_OPTIONS 按空格拆路径。
  const loaderOption = `--loader=${COMMAND_CODE_ACP_LOADER_URL}`
  const existing = process.env.NODE_OPTIONS?.trim()
  return { NODE_OPTIONS: existing === undefined || existing === '' ? loaderOption : `${existing} ${loaderOption}` }
}
/** CLI 在 -p 模式撞到 --max-turns 时的退出码（MAX_TURNS_REACHED）。 */
const COMMAND_CODE_MAX_TURNS_EXIT_CODE = 8
/** 发送 SIGINT 后等待 CLI 自己收尾的时间；超时再强制清理进程树。 */
const COMMAND_CODE_INTERRUPT_GRACE_MS = 1_500

/** 将 DSH 权限状态映射为 Command Code 参数；未知状态保持 CLI 默认审批。 */
function commandCodePermissionArgs(permission: CodingNsCliTurnInput['permission']): string[] {
  if (permission?.sandboxMode === 'danger-full-access' && permission.approvalPolicy === 'never') return ['--yolo']
  if (permission?.sandboxMode === 'workspace-write') return ['--permission-mode', 'accept-edits']
  if (permission?.sandboxMode === 'read-only') return ['--plan']
  return []
}

/**
 * Command Code 驱动：使用 `--session` 建立首轮输入，随后绑定 Provider 原生会话并用
 * `--resume + -p + --output-format json` 续接。首轮历史只作为 CLI 的输入快照，不能替代
 * Provider 自己维护的 canonical transcript。
 *
 * 与 Codex 驱动保持同一套消息优化：正文/推理增量携带 assistant 消息身份，工具完成后
 * 的下一条 assistant 消息之前结束当前 DSH step，因此一个 Provider 运行会被切成多个
 * step，而不是把整轮正文堆积到最后一条结算消息里。驱动只输出公共事件契约，工具历史、
 * usage 和原生组件映射全部交给公共消息投影层。
 */
export class CommandCodeDriver implements CodingNsCliDriver {
  readonly descriptor: {
    readonly id: 'command-code'
    readonly name: 'Command Code'
    readonly protocol: 'command' | 'acp'
    readonly capabilities: readonly CodingNsCliCapability[]
  }
  /** 驱动自己维护 Provider turn 边界，Host 可以把工具边界映射为 DSH step。 */
  readonly supportsSegmentedTurns = true
  private readonly homeDirectory: string
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly maxTurns: number
  private readonly autoContinueMaxAttempts: number
  private readonly autoContinuePrompt: string
  private readonly history: CommandCodeHistory
  private readonly acpDriver: AcpCliDriver | undefined
  readonly respondPermission: (sessionId: string, response: CodingNsAgentPermissionResponse) => void | Promise<void>
  readonly respondQuestion: (sessionId: string, response: CodingNsAgentQuestionResponse) => void | Promise<void>
  /** 按规范化 cwd 缓存 Skill 摘要；forceReload 用于响应目录变更。 */
  private readonly skillCatalogs = new Map<string, readonly CommandCodeSkillEntry[]>()
  private cachedBinary: string | null = null
  private cachedEnvironment: Record<string, string | undefined> | undefined
  private readonly processes = new Set<CodingNsChildProcess>()
  private readonly turns = new Map<string, CommandCodeTurn>()

  constructor(options: CommandCodeDriverOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? join(homedir(), '.commandcode')
    this.binaries = options.binaries ?? COMMAND_CODE_BINARIES
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    this.maxTurns = normalizePositiveInteger(
      options.maxTurns ?? readOptionalIntegerEnv('CODINGNS_COMMAND_CODE_MAX_TURNS'),
      DEFAULT_MAX_TURNS,
    )
    this.autoContinueMaxAttempts = normalizeNonNegativeInteger(
      options.autoContinueMaxAttempts ?? readOptionalIntegerEnv('CODINGNS_COMMAND_CODE_AUTO_CONTINUE_ATTEMPTS'),
      DEFAULT_AUTO_CONTINUE_ATTEMPTS,
    )
    this.autoContinuePrompt = options.autoContinuePrompt?.trim() || AUTO_CONTINUE_PROMPT
    const readStatus = options.readStatus ?? ((workspacePath: string) => this.readCommandCodeStatus(workspacePath))
    this.history = new CommandCodeHistory(this.homeDirectory, { readStatus })
    const legacyCapabilities: readonly CodingNsCliCapability[] = ['models', 'skills', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'history']
    const acpCapabilities: readonly CodingNsCliCapability[] = [...legacyCapabilities, 'permission', 'questions']
    this.descriptor = { id: 'command-code', name: 'Command Code', protocol: options.enableAcp === true ? 'acp' : 'command', capabilities: options.enableAcp === true ? acpCapabilities : legacyCapabilities }
    if (options.enableAcp === true) {
      this.acpDriver = new AcpCliDriver({
        binaries: this.binaries,
        spawnSync: this.runSpawnSync,
        spawn: this.runSpawn,
        args: ['acp'],
        buildArgs: (input) => commandCodeAcpArgs(input),
        runtimeModelSelection: false,
        configureSession: configureCommandCodeAcpSession,
        sessionEnvironment: commandCodeAcpEnvironment(),
        sessionEnvironmentForInput: (input) => commandCodeNativeAgentEnvironment(input.sessionId, 'command-code'),
        id: 'command-code',
        name: 'Command Code',
        capabilities: acpCapabilities,
        readQuestionRequest: readCommandCodeQuestionRequest,
        decidePermission: commandCodeAcpPermissionDecision,
        enrichUsage: enrichCommandCodeUsage,
        probeReason: 'Command Code ACP 不公开可安全读取的会话索引',
      })
      this.respondPermission = (sessionId, response) => this.acpDriver!.respondPermission(sessionId, response)
      this.respondQuestion = (sessionId, response) => this.acpDriver!.respondQuestion(sessionId, response)
    } else {
      this.acpDriver = undefined
      // 保持旧实例的运行时能力声明：未启用 ACP 时不暴露这两个可回写接口。
      this.respondPermission = () => { throw new Error('Command Code ACP 未启用') }
      this.respondQuestion = () => { throw new Error('Command Code ACP 未启用') }
      delete (this as unknown as { respondPermission?: unknown }).respondPermission
      delete (this as unknown as { respondQuestion?: unknown }).respondQuestion
    }
  }

  /** 读取 Command Code 原生会话目录，供 Provider History 层使用。 */
  detectSessions(workspacePath: string): Promise<readonly CommandCodeSessionSummary[]> {
    return this.history.detectSessions(workspacePath)
  }

  detectSessionsDetailed(workspacePath: string): Promise<CommandCodeSessionDiscovery> {
    return this.history.detectSessionsDetailed(workspacePath)
  }

  /** 读取 Command Code 与 `.agents` 兼容目录中的 Skill 摘要，不返回本地路径。 */
  async listSkills(input: CodingNsCliSkillListInput): Promise<readonly CodingNsCliSkillDescriptor[]> {
    if (input.signal?.aborted) throw new Error('Skill 目录读取已取消')
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) return []
    const cwd = resolve(input.cwd ?? process.cwd())
    const entries = this.readSkillCatalog(cwd, input.forceReload === true)
    return entries.map(({ path: _path, ...descriptor }) => descriptor)
  }

  /** 只为显式 `/skill-name` 或 `$skill-name` 下发匹配的 Skill 目录。 */
  private async resolveSkillPaths(input: CodingNsCliTurnInput): Promise<readonly string[]> {
    const names = commandCodeSkillNames(input.prompt)
    if (names.length === 0) return []
    if (input.signal?.aborted) throw new Error('Skill 目录读取已取消')
    const entries = this.readSkillCatalog(resolve(input.cwd ?? process.cwd()), false)
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    const paths: string[] = []
    for (const name of names) {
      const entry = byName.get(name)
      if (entry?.enabled !== true || paths.includes(entry.path)) continue
      paths.push(entry.path)
    }
    return paths
  }

  private readSkillCatalog(cwd: string, forceReload: boolean): readonly CommandCodeSkillEntry[] {
    const cached = this.skillCatalogs.get(cwd)
    if (!forceReload && cached !== undefined) return cached
    const entries = scanCommandCodeSkills(cwd, this.homeDirectory)
    this.skillCatalogs.set(cwd, entries)
    return entries
  }

  startSession(workspacePath: string, options: { readonly initialPrompt?: string } = {}): Promise<CommandCodeStartSessionResult> {
    return this.history.startSession(workspacePath, options)
  }

  resumeSession(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeResumeSessionResult> {
    return this.history.resumeSession(providerSessionId, rawStoreRef)
  }

  sendMessage(providerSessionId: string, rawStoreRef: string, content: string): Promise<CommandCodeSendMessageResult> {
    return this.history.sendMessage(providerSessionId, rawStoreRef, content)
  }

  readSessionHistory(providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, direction: CommandCodeHistoryDirection = 'forward'): Promise<CommandCodeHistoryPage> {
    return this.history.readSessionHistory(providerSessionId, rawStoreRef, cursor, limit, direction)
  }

  readSessionHistoryDelta(providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, direction: CommandCodeHistoryDirection = 'forward'): Promise<CommandCodeHistoryDelta> {
    return this.history.readSessionHistoryDelta(providerSessionId, rawStoreRef, cursor, limit, direction)
  }

  subscribeSession(providerSessionId: string, rawStoreRef: string, cursor: string | null, limit: number, onEvent: (event: { readonly messages: readonly CommandCodeHistoryMessage[]; readonly cursor: string | null }) => Promise<void> | void): CommandCodeHistorySubscription {
    return this.history.subscribeSession(providerSessionId, rawStoreRef, cursor, limit, onEvent)
  }

  readSessionTitle(providerSessionId: string, rawStoreRef: string): Promise<string> {
    return this.history.readSessionTitle(providerSessionId, rawStoreRef)
  }

  renameSessionTitle(providerSessionId: string, rawStoreRef: string, title: string): Promise<string> {
    return this.history.renameSessionTitle(providerSessionId, rawStoreRef, title)
  }

  updateSessionArchiveState(providerSessionId: string, rawStoreRef: string, isArchived: boolean): Promise<{ readonly rawStoreRef: string; readonly isArchived: boolean }> {
    return this.history.updateSessionArchiveState(providerSessionId, rawStoreRef, isArchived)
  }

  deleteSession(providerSessionId: string, rawStoreRef: string): Promise<void> {
    return this.history.deleteSession(providerSessionId, rawStoreRef)
  }

  readContextUsage(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeContextUsage | null> {
    return this.history.readContextUsage(providerSessionId, rawStoreRef)
  }

  readSessionStats(providerSessionId: string, rawStoreRef: string): Promise<CommandCodeSessionStats | null> {
    return this.history.readSessionStats(providerSessionId, rawStoreRef)
  }

  forkSession(providerSessionId: string, workspacePath: string, options: { readonly rawStoreRef: string; readonly sourceType: 'session' | 'message'; readonly sourceMessageId?: string | null }): Promise<CommandCodeForkResult> {
    return this.history.forkSession(providerSessionId, workspacePath, options)
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync, parseVersion: (output) => output.match(/\d+\.\d+\.\d+/u)?.[0] ?? null })
    this.cachedBinary = result.command
    this.cachedEnvironment = result.command === null ? undefined : commandEnvironment(result.command)
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detection = await this.detect()
    if (!detection.installed || detection.command === null) return emptyCatalog()
    let stdout = ''
    try {
      const result = await runAsyncCommand(this.runSpawnSync, detection.command, ['--list-models'], { encoding: 'utf8', timeout: 12_000, windowsHide: true, shell: WINDOWS, ...(this.cachedEnvironment === undefined ? {} : { env: this.cachedEnvironment }) })
      stdout = result.stdout ?? ''
    } catch {
      return emptyCatalog()
    }

    const groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string; efforts: readonly string[] }> }> = []
    const declared = readDeclaredEfforts(this.homeDirectory)
    let currentGroup: (typeof groups)[number] | undefined
    for (const rawLine of stdout.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('Available models') || line.startsWith('Pass the full id') || line.startsWith('cmd --') || line.startsWith('Docs:')) continue
      if (!/\s{2,}/u.test(line) && !line.includes(' · ')) {
        currentGroup = { id: line.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), name: line, models: [] }
        groups.push(currentGroup)
        continue
      }
      const match = line.match(/^(\S+)\s{2,}(.*)$/u)
      if (!match || currentGroup === undefined) continue
      const id = match[1]!
      const description = match[2]!.trim()
      // BYOK 模型以 providers.json 的声明为准，内置目录作为回退；
      // 目录回退按末段匹配，使 `mcgrox/deepseek-v4.1-flash` 也能拿到内置强度。
      const efforts = declared.get(id.toLowerCase()) ?? catalogEffortsFor(id)
      currentGroup.models.push({ id, name: id, ...(description ? { description } : {}), efforts })
    }

    const config = readJson(join(this.homeDirectory, 'config.json'))
    // status --json 反映 CLI 当前真实模型；配置文件可能仍是旧值，优先使用运行时状态。
    let statusModel: string | null = null
    try {
      const status = await runAsyncCommand(this.runSpawnSync, detection.command, ['status', '--json'], { encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: WINDOWS, ...(this.cachedEnvironment === undefined ? {} : { env: this.cachedEnvironment }) })
      const parsed = parseJson(status.stdout ?? '')
      statusModel = typeof parsed?.model === 'string' && parsed.model.trim() !== '' ? parsed.model.trim() : null
    } catch { /* 状态读取失败时回退配置文件 */ }
    const currentModel = statusModel ?? (typeof config?.model === 'string' ? config.model : null)
    const configuredEffort = currentModel !== null && isRecord(config?.reasoningEffort) ? config.reasoningEffort[currentModel] : undefined
    const currentEffort = typeof configuredEffort === 'string' && VALID_EFFORTS.has(configuredEffort) ? configuredEffort : null
    const result = { groups, currentModel, currentEffort } satisfies CodingNsCliModelCatalog
    return result
  }

  /** 读取 Provider 当前 status；历史层只在模型一致时使用其中的上下文窗口。 */
  private async readCommandCodeStatus(workspacePath: string): Promise<Record<string, unknown> | null> {
    const command = this.cachedBinary ?? this.binaries[0]
    if (command === undefined) return null
    try {
      const result = await runAsyncCommand(this.runSpawnSync, command, ['status', '--json'], {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
        shell: WINDOWS,
        env: this.cachedEnvironment ?? commandEnvironment(command),
      })
      return parseJson(result.stdout ?? '')
    } catch {
      return null
    }
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    if (this.acpDriver !== undefined) return this.acpDriver.probeSession(input)
    throwIfCommandCodeProbeAborted(input.signal)
    const providerSessionId = input.providerSessionId?.trim()
    if (!providerSessionId) return { state: 'unknown', reason: '缺少 Provider 会话标识' }
    const candidates = new Set<string>()
    const rawStoreRef = input.rawStoreRef?.trim()
    const safeRawStoreRef = rawStoreRef !== undefined && isSafeCommandCodeTranscriptPath(rawStoreRef, this.homeDirectory)
      ? rawStoreRef
      : undefined
    if (safeRawStoreRef !== undefined) candidates.add(safeRawStoreRef)
    const discovered = resolveCanonicalTranscriptPath(
      join(this.homeDirectory, 'projects', `${providerSessionId}.jsonl`),
      this.homeDirectory,
      input.cwd,
    )
    if (discovered !== null) candidates.add(discovered)
    const checkpoint = resolveCommandCodeCheckpointPath(this.homeDirectory, input.cwd ?? process.cwd(), providerSessionId)
    if (checkpoint !== null) candidates.add(checkpoint)
    if (candidates.size === 0) return { state: 'missing', reason: 'Command Code 原生会话文件不存在' }

    let lastFailure: CodingNsCliSessionProbeResult | undefined
    for (const candidate of candidates) {
      throwIfCommandCodeProbeAborted(input.signal)
      if (!existsSync(candidate)) continue
      try {
        if (!statSync(candidate).isFile()) {
          lastFailure = { state: 'missing', reason: 'Command Code 原生会话路径不是文件', rawStoreRef: candidate }
          continue
        }
        // 探测只需验证首条记录；CLI 正在追加时末尾可能存在半行，不能因此拒绝
        // 一个仍可由 --resume 找到的会话。完整历史解析由独立的读取入口负责。
        const firstRecord = readFirstJsonRecord(candidate)
        if (firstRecord === null) {
          lastFailure = { state: 'corrupt', reason: 'Command Code 原生会话首条记录不是有效 JSONL', rawStoreRef: candidate }
          continue
        }
        if (candidate.endsWith('.checkpoints.jsonl')) {
          // checkpoint 只保存回退点，Command Code 的 --resume 索引仍要求同名
          // `.jsonl` transcript。仅有 checkpoint 的旧会话不能宣称可恢复。
          lastFailure = { state: 'missing', reason: 'Command Code 只有 checkpoint，没有可恢复 transcript', rawStoreRef: candidate }
          continue
        }
        const recordedId = textValue(firstRecord.id ?? firstRecord.sessionId).trim()
        if (recordedId !== '' && recordedId !== providerSessionId) {
          lastFailure = { state: 'corrupt', reason: 'Command Code 原生会话标识与绑定不一致', rawStoreRef: candidate }
          continue
        }
        return { state: 'available', reason: 'Command Code 原生会话可用', rawStoreRef: candidate }
      } catch (error) {
        lastFailure = { state: 'unreachable', reason: `无法读取 Command Code 原生会话：${error instanceof Error ? error.message : String(error)}`, rawStoreRef: candidate }
      }
    }
    return lastFailure ?? { state: 'missing', reason: 'Command Code 原生会话文件不存在', ...(safeRawStoreRef ? { rawStoreRef: safeRawStoreRef } : {}) }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const skillPaths = await this.resolveSkillPaths(input)
    const turnInput = skillPaths.length === 0 ? input : { ...input, skillPaths }
    if (this.acpDriver !== undefined) {
      yield* this.acpDriver.executeTurn(turnInput)
      return
    }
    const binary = this.cachedBinary ?? (await this.detect()).command
    if (binary === null) throw new Error('Command Code 未安装')

    const segmented = input.splitToolSteps === true
    const existing = this.turns.get(input.sessionId)
    const resuming = segmented && input.resumeSegmentedTurn === true && existing !== undefined && !existing.disposed && !existing.finished
    const prepared = resuming ? undefined : await prepareAttachmentPaths(input)
    let turn: CommandCodeTurn
    try {
      const preparedInput = prepared?.input ?? input
      turn = segmented ? this.acquireTurn(preparedInput, binary, skillPaths) : this.startTurn(preparedInput, binary, skillPaths)
      if (prepared !== undefined) turn.attachmentCleanup = prepared.cleanup
    } catch (error) {
      prepared?.cleanup()
      throw error
    }
    let suspended = false
    const onAbort = (): void => { this.requestGracefulStop(turn) }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    try {
      yield* this.consumeTurn(turn, input, segmented, () => { suspended = true })
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      // 只有驱动自己为下一个 DSH step 挂起时才保留进程；正常结束、取消和调用方
      // 提前关闭流都必须回收 CLI 进程与临时 transcript。
      if (!suspended) this.disposeTurn(turn)
    }
  }

  dispose(): void {
    this.acpDriver?.dispose()
    for (const turn of [...this.turns.values()]) this.disposeTurn(turn)
    this.turns.clear()
    for (const child of this.processes) terminateChildProcess(child)
    this.processes.clear()
    this.skillCatalogs.clear()
    this.cachedBinary = null
  }

  /** 丢弃等待下一个 DSH step 的 `-p` 运行，避免旧进程继续占用新一轮输出。 */
  discardSegmentedTurn(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn !== undefined) this.disposeTurn(turn)
  }

  /** 只有 Host 显式声明续段时才复用常驻进程；新的用户回合必须重新启动。 */
  private acquireTurn(input: CodingNsCliTurnInput, binary: string, skillPaths: readonly string[]): CommandCodeTurn {
    const existing = this.turns.get(input.sessionId)
    if (existing !== undefined) {
      if (input.resumeSegmentedTurn === true && !existing.disposed && !existing.finished) return existing
      this.disposeTurn(existing)
    }
    const turn = this.startTurn(input, binary, skillPaths)
    this.turns.set(input.sessionId, turn)
    return turn
  }

  private startTurn(input: CodingNsCliTurnInput, binary: string, skillPaths: readonly string[]): CommandCodeTurn {
    const cwd = input.cwd ?? process.cwd()
    const requestedProviderSessionId = input.providerSessionId?.trim() || undefined
    // 旧 synthetic ID 可能只对应 checkpoint；回退时必须以当前 DSH 会话 ID
    // 作为文件名，保证后续 session-binding、索引和 --resume 使用同一个标识。
    const canonicalKey = requestedProviderSessionId !== undefined
      && !isLegacySyntheticSessionId(requestedProviderSessionId)
      ? requestedProviderSessionId
      : input.sessionId
    const canonicalPath = resolveCommandCodeTranscriptPath(this.homeDirectory, cwd, canonicalKey)
    const hasCanonicalTranscript = existsSync(canonicalPath) && isSafeCommandCodeTranscriptPath(canonicalPath, this.homeDirectory)
    const hasRequestedRawTranscript = input.rawStoreRef?.trim() !== undefined
      && existsSync(input.rawStoreRef.trim())
      && isSafeCommandCodeTranscriptPath(input.rawStoreRef.trim(), this.homeDirectory)
    // 旧版本会把只有 checkpoint 的外部路径登记成 synthetic session ID；该 ID
    // 无法被 Command Code 的 --resume 索引解析。没有可读 JSONL 时重新从 DSH
    // 历史建立 canonical transcript，避免把坏绑定继续传给 Provider。
    const canResume = requestedProviderSessionId !== undefined
      && (hasCanonicalTranscript || hasRequestedRawTranscript || !isLegacySyntheticSessionId(requestedProviderSessionId))
    const providerSessionId = canResume ? requestedProviderSessionId : input.sessionId
    const transcriptPath = canResume ? undefined : canonicalPath
    if (transcriptPath !== undefined) writeTranscript(transcriptPath, input)
    const turn: CommandCodeTurn = {
      sessionId: input.sessionId,
      child: undefined,
      transcriptPath,
      providerSessionId,
      rawStoreRef: canResume ? input.rawStoreRef?.trim() || undefined : transcriptPath,
      skillPaths,
      cwd,
      queue: createEventQueue(),
      currentMessageId: undefined,
      sawCompletedTool: false,
      pendingChunk: undefined,
      terminal: false,
      finished: false,
      aborted: false,
      failure: null,
      disposed: false,
      attempt: 0,
      maxTurnsReached: false,
      messageSequence: 0,
      stderrTail: '',
    }
    // 首轮固定使用 canonical transcript；CLI 事件里的 checkpoint ID 不可用于
    // --resume，因此先登记稳定的 DSH 会话 ID，后续回合沿用同一路径恢复。
    if (!canResume && transcriptPath !== undefined) {
      turn.queue.push({ type: 'session-binding', providerSessionId: providerSessionId!, rawStoreRef: transcriptPath })
    }
    // 普通回合也登记活动 turn；Registry 的 interrupt 不应只对分段回合生效。
    this.turns.set(input.sessionId, turn)
    void this.runTurnAttempts(turn, input, binary)
    return turn
  }

  /**
   * 运行一个 `-p` 会话，并在撞到 `--max-turns` 上限时自动续跑。
   *
   * CLI 的 `--max-turns` 只是“单个进程的模型往返预算”，撞到上限会退出 8 并把
   * `subtype=max_turns` 的结果行当成正常结束。对 DSH 来说那既不是完成也不是失败：
   * 直接结束会把只做了一半的任务显示成“已完成”。这里的策略与父仓库
   * `CommandCodeRuntimeAdapter` 对齐——显式抬高预算，撞上限后在同一会话上自动
   * 续跑若干次；次数用尽才按失败上报。
   */
  private async runTurnAttempts(
    turn: CommandCodeTurn,
    input: CodingNsCliTurnInput,
    binary: string,
  ): Promise<void> {
    try {
      while (true) {
        turn.attempt += 1
        turn.stderrTail = ''
        // 自动续跑是同一个 DSH 运行里的下一段；消息序号必须跨尝试连续，
        // 否则新进程会从 command-code-message-1 重新编号，公共投影层会把它
        // 当成同一条消息继续追加，而不是开启新段。
        const state = createStreamState(
          () => turn.aborted,
          turn.messageSequence,
          turn.providerSessionId ?? null,
          turn.sessionId,
          input.splitToolSteps === true,
        )
        const child = this.spawnAttempt(turn, input, binary)
        const code = await this.readAttempt(turn, child, state)
        turn.messageSequence = state.messageSequence
        // 首轮使用临时 `--session` 文件。Provider 会话 ID 在流中确认后，必须在
        // 本次尝试结束时把临时 transcript 提升到 canonical 路径；否则下一轮拿着
        // 已登记的 ID 执行 `--resume` 时，Command Code 找不到对应原生会话。
        if (turn.transcriptPath !== undefined && turn.providerSessionId !== undefined) {
          syncCommandCodeTranscript(turn.transcriptPath, this.homeDirectory, input.cwd, turn.providerSessionId)
        }
        if (turn.disposed || turn.finished) return

        const capped = state.maxTurnsReached || code === COMMAND_CODE_MAX_TURNS_EXIT_CODE
        const autoContinueUsed = turn.attempt - 1
        if (capped && !turn.aborted && !turn.terminal && turn.providerSessionId !== undefined && autoContinueUsed < this.autoContinueMaxAttempts) {
          // 续跑必须落在同一个会话上。CLI 可能把 transcript 写回会话文件、也可能
          // 写进按 cwd 归档的 canonical 目录；两种落点都要先归位到同一个文件，
          // 否则“继续”会开出一个没有上文的新会话，等于白跑一轮预算。
          continue
        }
        if (capped && !turn.aborted && !turn.terminal) {
          turn.failure ??= new Error(
            buildMaxTurnsReachedMessage(autoContinueUsed, this.maxTurns),
          )
        }
        return
      }
    } catch (error) {
      turn.failure ??= error instanceof Error ? error : new Error(String(error))
    } finally {
      turn.queue.close()
      if (turn.child !== undefined) this.processes.delete(turn.child)
    }
  }

  /** 启动一次 CLI 尝试；首次写入 transcript，续跑沿用同一会话文件。 */
  private spawnAttempt(
    turn: CommandCodeTurn,
    input: CodingNsCliTurnInput,
    binary: string,
  ): CodingNsChildProcess {
    const args = this.buildTurnArgs(input, turn)
    const bridgeEnvironment = commandCodeNativeAgentEnvironment(input.sessionId, this.descriptor.id)
    const child = this.runSpawn(binary, args, {
      cwd: input.cwd ?? process.cwd(),
      env: { ...(this.cachedEnvironment ?? commandEnvironment(binary)), ...(input.runtimeEnv ?? {}), ...bridgeEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: WINDOWS,
    }) as CodingNsChildProcess
    // 自动续跑会替换活动进程；已退出的旧尝试不能继续留在进程表里等待 terminate。
    if (turn.child !== undefined) this.processes.delete(turn.child)
    this.processes.add(child)
    // 必须消费 stderr，错误内容只保留尾部用于诊断，避免泄露整段命令输出。
    child.stderr?.on('data', (chunk: Buffer | string) => {
      turn.stderrTail = `${turn.stderrTail}${chunk.toString()}`.slice(-512)
    })
    turn.child = child
    return child
  }

  private buildTurnArgs(input: CodingNsCliTurnInput, turn: CommandCodeTurn): string[] {
    // 续跑沿用同一个 Provider 会话，只把输入换成续跑提示；不能再次写入历史，
    // 否则会把 CLI 已经落盘的进度覆盖成空会话。
    const prompt = turn.attempt > 1 ? this.autoContinuePrompt : promptWithAttachmentPaths(input.prompt, input.attachments ?? [])
    const args = turn.transcriptPath !== undefined && turn.attempt === 1
      ? ['--session', turn.transcriptPath, '-p', prompt, '--output-format', 'json', '--skip-onboarding', '--max-turns', String(this.maxTurns)]
      : turn.providerSessionId !== undefined
      ? ['-p', prompt, '--output-format', 'json', '--skip-onboarding', '--max-turns', String(this.maxTurns), '--resume', turn.providerSessionId]
      : ['--session', turn.transcriptPath!, '-p', prompt, '--output-format', 'json', '--skip-onboarding', '--max-turns', String(this.maxTurns)]
    // 只有 Host 明确确认“完全访问且永不询问”时才允许 --yolo。
    // 权限状态缺省表示尚未读取，必须保持 CLI 的保守默认，不能把未知状态升级为完全访问。
    args.push(...commandCodePermissionArgs(input.permission))
    if (input.plan === true && !args.includes('--plan')) args.push('--plan')
    // Command Code 只允许从已有 --resume 会话分叉；首轮临时 transcript 不能带该参数。
    if (input.forkSession === true && turn.providerSessionId !== undefined) args.push('--fork-session')
    if (input.enableAskUserQuestion === true || input.runtimeEnv?.CMD_TOOLS_ASK_USER_QUESTION_ENABLE === 'true') {
      args.push('--tools-enable', 'ask_user_question')
    }
    for (const path of turn.skillPaths) args.push('--skill', path)
    // 每次启动都加载屏蔽 Mod：父会话转投 DSH，子会话仅禁用嵌套 agent；桥接
    // 不可用时由 Mod 明确阻断，不能回退到 Command Code 原生子代理。
    args.push(...commandCodeNativeAgentArgs(input.sessionId))
    for (const directory of new Set((input.attachments ?? []).map((attachment) => dirname(attachment.path)))) args.push('--add-dir', directory)
    if (input.modelId && input.modelId !== 'provider-default') args.push('--model', input.modelId)
    const effort = input.effortId?.trim().toLowerCase()
    if (effort !== undefined && VALID_EFFORTS.has(effort)) args.push('--effort', effort)
    return args
  }

  /** 中断当前会话并清理 CLI 进程；不存在活动运行时视为幂等成功。 */
  async interrupt(sessionId: string): Promise<void> {
    if (this.acpDriver !== undefined) {
      await this.acpDriver.interrupt(sessionId)
      return
    }
    const turn = this.turns.get(sessionId)
    if (turn === undefined) return
    this.requestGracefulStop(turn)
  }

  /** 先让 CLI 保存检查点并自行退出，超时后才清理进程树。 */
  private requestGracefulStop(turn: CommandCodeTurn): void {
    turn.aborted = true
    const child = turn.child
    if (child === undefined) {
      this.disposeTurn(turn)
      return
    }
    try { child.kill('SIGINT') } catch { /* 进程可能已经退出 */ }
    const timer = setTimeout(() => {
      if (!turn.disposed) this.disposeTurn(turn)
    }, COMMAND_CODE_INTERRUPT_GRACE_MS)
    timer.unref?.()
  }

  /** 读取一次尝试的 stdout，直到进程结束；队列在整个运行结束前保持打开。 */
  private async readAttempt(
    turn: CommandCodeTurn,
    child: CodingNsChildProcess,
    state: CommandCodeStreamState,
  ): Promise<number | null> {
    // 测试替身可能只提供 stdout/kill，没有 ChildProcess 的事件接口。
    const emitter = typeof (child as { on?: unknown }).on === 'function'
      ? child as unknown as {
          on(event: string, listener: (...args: any[]) => void): unknown
        }
      : null
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let resolveClose: (() => void) | null = null
    const closed = new Promise<void>((resolve) => { resolveClose = resolve })
    if (emitter !== null) {
      // 未监听 error 的 ChildProcess 会把 spawn 失败升级成宿主进程异常。
      // 这里只记账并结束本次尝试；队列统一由 runTurnAttempts 关闭，
      // 避免某次尝试失败时把仍在排队的正文事件丢掉。
      emitter.on('error', (error: Error) => {
        turn.failure ??= error
        resolveClose?.()
      })
      emitter.on('close', (code: number | null, signal?: string | null) => {
        exitCode = code
        exitSignal = signal ?? null
        if (state.maxTurnsReached) turn.maxTurnsReached = true
        resolveClose?.()
      })
    }
    try {
      const lines = readline.createInterface({ input: child.stdout })
      let lineNumber = 0
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          lineNumber += 1
          const item = parseJson(line)
          if (item === null) {
            // CLI 升级后可能输出非对象或损坏的 NDJSON；保留行号诊断，不能静默吞掉。
            console.warn(`[codingns4dsh] Command Code 忽略非法 NDJSON（第 ${lineNumber} 行）`)
            continue
          }
          const event = item.type === 'event' && isRecord(item.event) ? item.event : item
          for (const rawChunk of commandCodeEventChunks(event, state)) {
            let chunk = rawChunk
            if (rawChunk.type === 'session-binding') {
              // `--session <path>` 模式下 CLI 发出的 sessionId 是 checkpoint
              // 内部 ID，不是可供 --resume 查找的 transcript ID；保持 Host 绑定。
              if (turn.transcriptPath !== undefined) continue
              turn.providerSessionId = rawChunk.providerSessionId
              turn.rawStoreRef = resolveCommandCodeTranscriptPath(this.homeDirectory, turn.cwd, rawChunk.providerSessionId)
              // Provider ID 一旦确认就立即暴露 canonical 路径；文件可能稍后才落盘，
              // 但 Registry 必须先保存稳定绑定，冷恢复时才能直接定位原生会话。
              chunk = { ...rawChunk, rawStoreRef: turn.rawStoreRef }
            }
            if (chunk.type === 'finish') turn.terminal = true
            turn.queue.push(chunk)
          }
        }
      } finally {
        lines.close()
      }
    } catch (error) {
      turn.failure ??= error instanceof Error ? error : new Error(String(error))
    }
    // 没有 close 事件时，stdout 结束即视为本次尝试结束。
    if (emitter === null) {
      if (state.maxTurnsReached) turn.maxTurnsReached = true
    } else {
      await closed
    }
    if (!turn.terminal && !state.maxTurnsReached) {
      if (turn.aborted || exitSignal === 'SIGINT' || exitSignal === 'SIGTERM') {
        turn.terminal = true
        turn.queue.push({ type: 'finish', reason: 'cancel' })
      } else if (turn.failure !== null || (exitCode !== null && exitCode !== 0) || exitSignal !== null) {
        const message = turn.failure?.message
          || (turn.stderrTail.trim() !== '' ? `Command Code 执行失败：${turn.stderrTail.trim()}` : `Command Code 进程退出（代码 ${exitCode ?? exitSignal ?? 'unknown'}）`)
        turn.failure = null
        turn.terminal = true
        turn.queue.push({
          type: 'finish',
          reason: 'error',
          failure: { message, code: exitCode === null ? 'COMMAND_CODE_SPAWN_ERROR' : `COMMAND_CODE_EXIT_${exitCode}` },
        })
      }
    }
    return exitCode
  }

  private async *consumeTurn(
    turn: CommandCodeTurn,
    input: CodingNsCliTurnInput,
    segmented: boolean,
    suspend: () => void,
  ): AsyncIterable<CodingNsAgentEvent> {
    while (true) {
      let chunk: CodingNsAgentEvent
      if (turn.pendingChunk !== undefined) {
        chunk = turn.pendingChunk
        turn.pendingChunk = undefined
      } else {
        const next = await turn.queue.next()
        if (next.done) {
          if (turn.failure !== null) throw turn.failure
          if (turn.terminal) return
          if (turn.aborted || input.signal?.aborted === true) {
            yield { type: 'finish', reason: 'cancel' }
            return
          }
          throw new Error('Command Code 执行失败')
        }
        chunk = next.value
      }

      // 一个 `-p` 运行会在同一进程里连续跑多个 agent turn。把新 assistant 消息的
      // 首个正文留给下一次 llm/stream，当前流只返回边界，确保 DSH 先创建新 step。
      if (segmented && chunk.type === 'step-boundary') {
        // 解析层已经把下一条 Provider 消息留在队列中；清掉旧消息身份，避免
        // 续段后的首个正文再次被误判成一个额外边界。
        turn.currentMessageId = undefined
        turn.sawCompletedTool = false
        suspend()
        yield chunk
        return
      }
      if (segmented
        && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
        && chunk.messageId !== undefined) {
        const previousMessageId = turn.currentMessageId
        if (previousMessageId !== undefined
          && previousMessageId !== chunk.messageId
          && turn.sawCompletedTool) {
          turn.pendingChunk = chunk
          turn.currentMessageId = chunk.messageId
          turn.sawCompletedTool = false
          suspend()
          yield { type: 'step-boundary' }
          return
        }
        turn.currentMessageId = chunk.messageId
      }
      if (chunk.type === 'tool-event' && (chunk.status === 'completed' || chunk.status === 'failed')) {
        turn.sawCompletedTool = true
      }
      if (chunk.type === 'finish') turn.finished = true
      yield chunk
    }
  }

  private disposeTurn(turn: CommandCodeTurn): void {
    if (turn.disposed) return
    turn.disposed = true
    turn.queue.close()
    if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId)
    const child = turn.child
    if (child !== undefined) {
      this.processes.delete(child)
      terminateChildProcess(child)
    }
    turn.attachmentCleanup?.()
    // 首轮 transcript 已经是 canonical 文件，必须保留给下一轮 --resume 及冷恢复。
  }
}

function enrichCommandCodeUsage(
  event: Extract<CodingNsAgentEvent, { type: 'usage' }>,
  input: CodingNsCliTurnInput,
): Extract<CodingNsAgentEvent, { type: 'usage' }> {
  const contextWindow = event.contextWindow ?? knownCommandCodeContextWindow(input.modelId)
  if (contextWindow === undefined || contextWindow <= 0) return event
  const contextTokens = event.contextTokens ?? (event.inputTokens > 0 ? event.inputTokens : undefined)
  return {
    ...event,
    contextWindow,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(event.contextUsageRatio !== undefined || contextTokens === undefined
      ? {}
      : { contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)) }),
  }
}

function createStreamState(
  aborted: () => boolean,
  messageSequence = 0,
  sessionId: string | null = null,
  bridgeSessionId = '',
  splitToolSteps = false,
): CommandCodeStreamState {
  return {
    messageSequence,
    messageId: null,
    emittedText: '',
    emittedReasoning: '',
    sawText: false,
    sawCompletedTool: false,
    splitToolSteps,
    perRequestUsageSeen: false,
    turnUsageSeen: false,
    pendingMessageUsage: null,
    sessionId,
    bridgeSessionId,
    aborted,
    maxTurnsReached: false,
    terminalEmitted: false,
  }
}

function createEventQueue(): CommandCodeEventQueue {
  const values: CodingNsAgentEvent[] = []
  const waiters: Array<(result: IteratorResult<CodingNsAgentEvent>) => void> = []
  let closed = false
  const next = (): Promise<IteratorResult<CodingNsAgentEvent>> => {
    const value = values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => waiters.push(resolve))
  }
  return {
    next,
    push(event) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ done: false, value: event })
      else values.push(event)
    },
    close() {
      if (closed) return
      closed = true
      while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined })
    },
  }
}

/**
 * Command Code NDJSON → 公共 Agent 事件。
 *
 * 关键约定（对照本机 1.66.0 真实事件流）：
 * - `turn_start` / `message_start` 标识新的 assistant 消息，正文和推理增量都带上它；
 * - `tool_*` 使用 `toolCallId` 作为稳定调用 ID，同一调用的 queued/running/completed
 *   只能投影成一个 DSH 工具节点；
 * - `model_request_end` 的 usage 是当前请求的上下文占用；`run_end`/最终 `result`
 *   的 usage 是整个运行的累计值，只在完全没有单请求 usage 时兜底。
 */
function commandCodeEventChunks(event: Record<string, unknown>, state: CommandCodeStreamState): CodingNsAgentEvent[] {
  const chunks: CodingNsAgentEvent[] = []
  const type = textValue(event.type).trim().toLowerCase()

  const sessionId = readSessionId(event)
  if (sessionId !== null && sessionId !== state.sessionId) {
    state.sessionId = sessionId
    chunks.push({ type: 'session-binding', providerSessionId: sessionId })
  }

  switch (type) {
    case 'run_start':
    case 'run-start':
    case 'session_created':
    case 'session-created':
    case 'model_request_start':
    case 'model-request-start':
    case 'model_trace':
    case 'model-trace':
      // 这些事件只标记 Provider 生命周期，不应制造正文或终态。
      break
    case 'turn_start':
    case 'turn-start':
      if (state.splitToolSteps) emitPendingMessageUsage(chunks, state)
      if (state.splitToolSteps && state.sawCompletedTool) chunks.push({ type: 'step-boundary' })
      beginMessage(state)
      state.sawCompletedTool = false
      break
    case 'message_start':
    case 'message-start':
      // 正常一轮只有一个模型请求；没有 turn_start 的旧版本由这里补消息身份。
      if (state.messageId === null) {
        if (state.splitToolSteps) emitPendingMessageUsage(chunks, state)
        if (state.splitToolSteps && state.sawCompletedTool) chunks.push({ type: 'step-boundary' })
        beginMessage(state)
        state.sawCompletedTool = false
      }
      break
    case 'text_delta':
    case 'text-delta': {
      const text = textValue(event.delta ?? event.text ?? event.content)
      if (text) {
        ensureMessage(state)
        state.emittedText += text
        state.sawText = true
        chunks.push(textDelta(text, state))
      }
      break
    }
    case 'thinking_delta':
    case 'thinking-delta': {
      const text = textValue(event.delta ?? event.thinking ?? event.content)
      if (text) {
        ensureMessage(state)
        state.emittedReasoning += text
        chunks.push(reasoningDelta(text, state))
      }
      break
    }
    case 'message':
    case 'message_update':
    case 'message-update':
    case 'message_end':
    case 'message-end':
      // 只补齐增量流没有覆盖到的正文，避免累计快照被重复追加。
      appendContentFallback(chunks, event.content ?? recordValue(event.message)?.content, state)
      captureMessageUsage(event, state)
      break
    case 'model_request_end':
    case 'model-request-end': {
      const usage = usageChunkFromEvent(event)
      if (usage !== null) {
        state.pendingMessageUsage = null
        state.perRequestUsageSeen = true
        state.turnUsageSeen = true
        chunks.push(usage)
      }
      break
    }
    case 'turn_end':
    case 'turn-end': {
      // 旧版本可能只在 turn_end 带 usage；与 model_request_end 去重，不重复结算。
      if (!state.turnUsageSeen) {
        const usage = usageChunkFromEvent(event) ?? (state.splitToolSteps ? state.pendingMessageUsage : null)
        if (usage !== null) {
          state.pendingMessageUsage = null
          state.perRequestUsageSeen = true
          state.turnUsageSeen = true
          chunks.push(usage)
        }
      }
      break
    }
    case 'run_end':
    case 'run-end':
      if (state.splitToolSteps && !state.turnUsageSeen) emitPendingMessageUsage(chunks, state, event)
      if (!state.sawText) {
        const finalText = readFinalText(event)
        if (finalText) {
          ensureMessage(state)
          state.sawText = true
          state.emittedText = finalText
          chunks.push(textDelta(finalText, state))
        }
      }
      if (isMaxTurnsOutcome(event)) {
        // 撞到 CLI 的轮次上限不是终态，但 run_end 可能同时携带本次已生成的
        // 最后一段正文。正文必须先投影出去，续跑只负责继续执行，不能吞掉这段结果。
        state.maxTurnsReached = true
        break
      }
      if (!state.terminalEmitted) {
        state.terminalEmitted = true
        chunks.push({ type: 'finish', reason: state.aborted() ? 'cancel' : resultReason(event) })
      }
      break
    case 'result': {
      if (state.terminalEmitted) break
      const resultUsage = usageChunkFromEvent(event)
      if (state.splitToolSteps && state.pendingMessageUsage !== null) emitPendingMessageUsage(chunks, state)
      else if (!state.turnUsageSeen) {
        const usage = resultUsage ?? state.pendingMessageUsage
        if (usage !== null) {
          state.perRequestUsageSeen = true
          state.turnUsageSeen = true
          chunks.push(usage)
        }
      }
      if (!state.sawText) {
        const finalText = readFinalText(event)
        if (finalText) {
          ensureMessage(state)
          state.sawText = true
          state.emittedText += finalText
          chunks.push(textDelta(finalText, state))
        }
      }
      // 撞到 CLI 的轮次上限不是终态：这里只记账，等进程退出后决定自动续跑还是
      // 按失败上报。直接发 finish 就是“任务没做完却显示已完成”的老毛病。
      if (isMaxTurnsOutcome(event)) {
        state.maxTurnsReached = true
        break
      }
      const reason = state.aborted() ? 'cancel' : resultReason(event)
      state.terminalEmitted = true
      chunks.push({
        type: 'finish',
        reason,
        ...(reason === 'error' ? { failure: commandCodeFailure(event) } : {}),
      })
      break
    }
    case 'error':
    case 'fatal_error':
    case 'run_error':
      if (!state.terminalEmitted) {
        state.terminalEmitted = true
        chunks.push({ type: 'finish', reason: state.aborted() ? 'cancel' : 'error', ...(state.aborted() ? {} : { failure: commandCodeFailure(event) }) })
      }
      break
    default:
      if (type !== '' && !isToolStart(type) && !isToolResult(type)) {
        // 未知事件不应改变正常流，但必须留下可定位的升级诊断。
        console.warn(`[codingns4dsh] Command Code 忽略未知事件：${type}`)
      }
      break
  }

  if (isToolStart(type)) {
    // 某些版本只在 message/message_update 上携带 usage，工具开始即表示该
    // assistant 消息已经结束；先结算最后一份快照，避免工具 step 没有 usage。
    if (state.splitToolSteps) emitPendingMessageUsage(chunks, state, event)
    // 某些 Command Code 版本对“只有工具调用的 assistant 消息”不发送
    // turn_start/message_start。上一个工具已经完成时，下一次工具开始就是
    // 明确的消息边界；同一消息里的并行工具不会命中此分支，因为它们之间
    // 还没有 completed 结果。
    if (state.splitToolSteps && state.sawCompletedTool) {
      chunks.push({ type: 'step-boundary' })
      state.sawCompletedTool = false
    }
    const tool = readToolChunk(event, type === 'tool_queued' || type === 'tool_started' ? 'started' : 'running')
    if (tool !== null) chunks.push(tool)
  } else if (isToolResult(type)) {
    // 子代理托管命中时，mod 用 block 结束内建 agent 调用，真正的执行已经发生在
    // DSH 原生子会话里；这里必须投影为桥接返回的 running/completed/failed 状态，
    // 而不是把后台创建误报为完成或把普通 hook 拦截误报为托管成功。
    const redirected = type.includes('blocked') ? consumeBridgeRedirect(state, event) : undefined
    const failed = redirected === undefined && (type.includes('error') || type.includes('fail') || type.includes('denied') || type.includes('blocked'))
    // 后台托管的 hook_blocked 只代表“已创建子会话”。如果这里投影成 completed，
    // 父 Agent 会跳过 wait/read，子会话随后失败也就没有机会回到父会话。
    const redirectedStatus = redirected === undefined
      ? undefined
      : redirected.completed === false || redirected.status === 'running'
        ? 'running' as const
        : redirected.ok && redirected.status !== 'failed' && redirected.status !== 'interrupted'
          ? 'completed' as const
          : 'failed' as const
    const tool = readToolChunk(event, redirectedStatus ?? (failed ? 'failed' : 'completed'))
    if (tool !== null) {
      chunks.push(tool)
      // 工具完成后的正文属于下一条 assistant 消息。即使 CLI 没有发送
      // turn_start/message_start，也要让公共投影层看到消息身份切换。
      if (tool.status === 'completed' || tool.status === 'failed') resetMessageIdentity(state)
      if (tool.status === 'completed' || tool.status === 'failed') state.sawCompletedTool = true
    }
  }
  if (type === 'message' || type === 'message_update' || type === 'message-update') captureMessageUsage(event, state)
  return chunks
}

/** 从所有 Command Code 事件形状读取 usage；message 快照可能嵌套在 message 内。 */
function usageChunkFromEvent(event: Record<string, unknown>): Extract<CodingNsAgentEvent, { type: 'usage' }> | null {
  const result = recordValue(event.result)
  const message = recordValue(event.message)
  const usage = usageChunk(recordValue(event.usage) ?? recordValue(message?.usage) ?? recordValue(result?.usage))
  return usage?.type === 'usage' ? usage : null
}

/** 暂存消息累计快照，只保留同一请求最后一次值，避免重复结算。 */
function captureMessageUsage(event: Record<string, unknown>, state: CommandCodeStreamState): void {
  if (state.turnUsageSeen) return
  const usage = usageChunkFromEvent(event)
  if (usage !== null) state.pendingMessageUsage = usage
}

/** 在消息、工具或回合边界结算消息快照。 */
function emitPendingMessageUsage(
  chunks: CodingNsAgentEvent[],
  state: CommandCodeStreamState,
  event?: Record<string, unknown>,
): void {
  if (state.turnUsageSeen) return
  const usage = state.pendingMessageUsage ?? (event === undefined ? null : usageChunkFromEvent(event))
  if (usage === null) return
  state.pendingMessageUsage = null
  state.perRequestUsageSeen = true
  state.turnUsageSeen = true
  chunks.push(usage)
}

function readFinalText(event: Record<string, unknown>): string {
  const result = recordValue(event.result)
  return textValue(
    event.finalText
      ?? result?.finalText
      ?? result?.output
      ?? result?.text
      ?? (typeof event.result === 'string' ? event.result : undefined)
      ?? event.output
      ?? event.text,
  )
}

/** 该 blocked 事件是否来自桥接转投；命中后消费一次记录，避免重复投影。 */
function consumeBridgeRedirect(state: CommandCodeStreamState, event: Record<string, unknown>) {
  if (state.bridgeSessionId === '') return undefined
  const callId = firstToolText(event.callId, event.call_id, event.toolCallId, event.tool_call_id, event.toolUseId, event.tool_use_id, event.id)
  if (callId === undefined || callId === '') return undefined
  try {
    return getSubagentBridge()?.consumeRedirect(state.bridgeSessionId, callId)
  } catch {
    return undefined
  }
}

function beginMessage(state: CommandCodeStreamState): void {
  state.messageSequence += 1
  state.messageId = `command-code-message-${state.messageSequence}`
  state.emittedText = ''
  state.emittedReasoning = ''
  state.turnUsageSeen = false
}

/** 丢弃当前消息身份；下一条正文增量会懒加载新的身份。 */
function resetMessageIdentity(state: CommandCodeStreamState): void {
  state.messageId = null
  state.emittedText = ''
  state.emittedReasoning = ''
}

function ensureMessage(state: CommandCodeStreamState): void {
  if (state.messageId === null) beginMessage(state)
}

function textDelta(text: string, state: CommandCodeStreamState): CodingNsAgentEvent {
  return { type: 'text-delta', text, ...(state.messageId === null ? {} : { messageId: state.messageId }) }
}

function reasoningDelta(text: string, state: CommandCodeStreamState): CodingNsAgentEvent {
  return { type: 'reasoning-delta', text, ...(state.messageId === null ? {} : { messageId: state.messageId }) }
}

/** 用完整的 assistant content 补齐缺失的正文/推理增量（只发送尚未发送的尾部）。 */
function appendContentFallback(chunks: CodingNsAgentEvent[], content: unknown, state: CommandCodeStreamState): void {
  if (!Array.isArray(content)) return
  let snapshotText = ''
  let snapshotReasoning = ''
  let pendingKind: 'text' | 'reasoning' | null = null
  let pendingDelta = ''
  const flushPending = (): void => {
    if (pendingKind === null || pendingDelta === '') return
    chunks.push(pendingKind === 'text' ? textDelta(pendingDelta, state) : reasoningDelta(pendingDelta, state))
    pendingKind = null
    pendingDelta = ''
  }
  for (const block of content) {
    const value = recordValue(block)
    if (value === null) continue
    const blockType = textValue(value.type).toLowerCase()
    const isReasoning = blockType.includes('thinking') || blockType.includes('reasoning')
      || typeof value.thinking === 'string' || typeof value.reasoning === 'string'
    const blockText = textValue(isReasoning
      ? value.thinking ?? value.reasoning ?? value.text ?? value.content
      : value.text ?? value.content)
    if (isReasoning) {
      snapshotReasoning += blockText
      if (snapshotReasoning.length > state.emittedReasoning.length) {
        const delta = snapshotReasoning.slice(state.emittedReasoning.length)
        ensureMessage(state)
        state.emittedReasoning = snapshotReasoning
        if (pendingKind !== 'reasoning') flushPending()
        pendingKind = 'reasoning'
        pendingDelta += delta
      }
    } else {
      snapshotText += blockText
      if (snapshotText.length > state.emittedText.length) {
        const delta = snapshotText.slice(state.emittedText.length)
        ensureMessage(state)
        state.emittedText = snapshotText
        state.sawText = true
        if (pendingKind !== 'text') flushPending()
        pendingKind = 'text'
        pendingDelta += delta
      }
    }
  }
  flushPending()
}

function readToolChunk(event: Record<string, unknown>, status: 'started' | 'running' | 'completed' | 'failed'): CodingNsAgentToolEvent | null {
  const callId = firstToolText(event.callId, event.call_id, event.toolCallId, event.tool_call_id, event.toolUseId, event.tool_use_id, event.id)
  const fn = recordValue(event.function)
  const toolName = textValue(event.name ?? event.toolName ?? event.tool_name ?? event.tool ?? fn?.name) || 'tool'
  const error = textValue(event.error ?? event.reason ?? event.message)
  const output = textValue(event.output ?? event.result ?? event.content ?? event.hookOutput)
  const input = event.input ?? fn?.arguments ?? event.arguments
  const agentId = firstToolText(event.agentId, event.agent_id)
  const detail = serializeToolValue(event.detail ?? event.metadata ?? event.description)
  if (!callId && !toolName) return null
  return {
    type: 'tool-event',
    toolName,
    ...(callId ? { callId } : {}),
    ...(input !== undefined ? { input: structuredText(input) } : {}),
    ...(output ? { output } : {}),
    ...(output ? { outputMode: 'snapshot' as const } : {}),
    ...(error ? { error } : {}),
    ...(agentId ? { agentId } : {}),
    ...(detail !== undefined ? { detail } : {}),
    status,
  }
}

function isToolStart(type: string): boolean {
  return ['tool_queued', 'tool_started', 'tool_running', 'tool_use', 'tool_call', 'function_call'].includes(type)
}

function isToolResult(type: string): boolean {
  return ['tool_completed', 'tool_result', 'tool_return', 'tool_failed', 'tool_error', 'tool_denied', 'tool_hook_blocked', 'function_result'].includes(type)
}

function resultReason(event: Record<string, unknown>): 'stop' | 'cancel' | 'error' {
  const resultRecord = recordValue(event.result)
  const stopReason = textValue(event.stopReason ?? resultRecord?.stopReason).toLowerCase()
  const subtype = textValue(event.subtype).toLowerCase()
  if (event.error !== undefined || subtype === 'error' || stopReason.includes('error') || stopReason.includes('fail')) return 'error'
  if (stopReason.includes('interrupt') || stopReason.includes('cancel') || stopReason === 'aborted') return 'cancel'
  return 'stop'
}

function commandCodeFailure(event: Record<string, unknown>): { message: string; code?: string } {
  const result = recordValue(event.result)
  const candidate = event.error ?? event.errorMessage ?? event.error_message ?? result?.error ?? result?.errorMessage ?? result?.message ?? event.message
  const message = textValue(candidate) ?? (typeof candidate === 'string' ? candidate.trim() : '')
  const codeValue = result?.code ?? result?.errorCode ?? event.code ?? event.errorCode
  const code = typeof codeValue === 'string' && codeValue.trim() !== '' ? codeValue.trim() : undefined
  const actual = message.trim() || 'Command Code Provider 未返回具体失败信息。'
  return code === undefined ? { message: actual } : { message: actual, code }
}

/**
 * 读取 CLI 的结束原因。
 *
 * `result` 行的 subtype/stopReason 在顶层，`run_end` 的 stopReason 藏在 result 里，
 * 两种都要认，否则 max_turns 会被当成正常完成。
 */
function readOutcomeSignal(event: Record<string, unknown>): string {
  const resultRecord = recordValue(event.result)
  return textValue(
    event.subtype
      ?? event.stopReason
      ?? event.stop_reason
      ?? resultRecord?.stopReason
      ?? resultRecord?.stop_reason
      ?? resultRecord?.subtype,
  ).trim().toLowerCase()
}

function isMaxTurnsOutcome(event: Record<string, unknown>): boolean {
  const signal = readOutcomeSignal(event)
  return signal.includes('max_turns') || signal.includes('max-turns') || signal.includes('maxturns')
}

/**
 * 把 CLI 可能写到 canonical 目录的 transcript 归位到 `--session` 指定的文件。
 *
 * 实测 CLI 的落盘位置取决于会话文件里是否已有历史：空会话（只有 session 头）时
 * 会把消息写进 `~/.commandcode/projects/<slug>/<id>.jsonl`，带上历史时则写回
 * `--session` 指定的文件。两种落点都要统一，否则下一轮恢复会落在一个没有上文的
 * 会话上。两边都存在时按修改时间同步最新内容，首轮则创建 canonical 文件。
 */
function syncCommandCodeTranscript(
  transcriptPath: string,
  homeDirectory: string,
  cwd: string | undefined,
  providerSessionId?: string,
): void {
  const canonicalPath = providerSessionId === undefined
    ? resolveCanonicalTranscriptPath(transcriptPath, homeDirectory, cwd)
    : resolveCommandCodeTranscriptPath(homeDirectory, cwd ?? process.cwd(), providerSessionId)
  if (canonicalPath === null) return
  if (providerSessionId !== undefined && !isSafeCommandCodeTranscriptTarget(canonicalPath, homeDirectory)) return
  try {
    if (!existsSync(transcriptPath) || !statSync(transcriptPath).isFile()) return
    const sourceMtime = statSync(transcriptPath).mtimeMs
    if (!existsSync(canonicalPath)) {
      mkdirSync(dirname(canonicalPath), { recursive: true })
      copyFileSync(transcriptPath, canonicalPath)
      return
    }
    if (!statSync(canonicalPath).isFile()) return
    const canonicalMtime = statSync(canonicalPath).mtimeMs
    if (sourceMtime > canonicalMtime) copyFileSync(transcriptPath, canonicalPath)
    else if (canonicalMtime > sourceMtime) copyFileSync(canonicalPath, transcriptPath)
  } catch {
    // transcript 归位是恢复前的必要同步；文件竞态或不可读时保持当前运行结果。
  }
}

/** 按 CLI 的 `<cwd slug>/<session id>` 规则定位 canonical transcript。 */
function resolveCanonicalTranscriptPath(
  transcriptPath: string,
  homeDirectory: string,
  cwd: string | undefined,
): string | null {
  const projectsRoot = join(homeDirectory, 'projects')
  const id = basename(transcriptPath, '.jsonl')
  const candidates = new Set<string>()
  if (cwd) candidates.add(join(projectsRoot, workspaceSlug(cwd), `${id}.jsonl`))
  // cwd 缺失或 slug 规则变化时，退化为按会话文件名在 projects 下检索。
  try {
    for (const entry of readdirSync(projectsRoot)) {
      if (candidates.has(join(projectsRoot, entry, `${id}.jsonl`))) continue
      if (existsSync(join(projectsRoot, entry, `${id}.jsonl`))) {
        candidates.add(join(projectsRoot, entry, `${id}.jsonl`))
        break
      }
    }
  } catch {
    // projects 目录不存在说明 CLI 还没写过 canonical transcript。
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 按 Provider 会话 ID 计算 Command Code 的 canonical transcript 路径。 */
function resolveCommandCodeTranscriptPath(homeDirectory: string, cwd: string, providerSessionId: string): string {
  return join(homeDirectory, 'projects', workspaceSlug(cwd), `${safeId(providerSessionId)}.jsonl`)
}

/** Provider 索引只能指向 Command Code 项目目录中的 JSONL，避免旧配置污染探测边界。 */
function isSafeCommandCodeTranscriptPath(candidate: string, homeDirectory: string): boolean {
  const projectsRootPath = resolve(join(homeDirectory, 'projects'))
  let projectsRoot = projectsRootPath
  try { if (existsSync(projectsRootPath)) projectsRoot = realpathSync(projectsRootPath) } catch { return false }
  const resolvedCandidate = resolve(candidate)
  let actualCandidate = resolvedCandidate
  try { if (existsSync(resolvedCandidate)) actualCandidate = realpathSync(resolvedCandidate) } catch { return false }
  const relativePath = relative(projectsRoot, actualCandidate)
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean)
  return relativePath !== ''
    && !relativePath.startsWith('..')
    && segments.length === 2
    && actualCandidate.endsWith('.jsonl')
    // checkpoint 不是 --resume 使用的 transcript，即使扩展名同为 .jsonl
    // 也不能把它当作可恢复会话绑定。
    && !actualCandidate.endsWith('.checkpoints.jsonl')
}

/** 允许同步创建的 canonical transcript 目标，路径必须严格位于 projects/<slug>/*.jsonl。 */
function isSafeCommandCodeTranscriptTarget(candidate: string, homeDirectory: string): boolean {
  const projectsRoot = resolve(join(homeDirectory, 'projects'))
  const resolvedCandidate = resolve(candidate)
  const relativePath = relative(projectsRoot, resolvedCandidate)
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean)
  return relativePath !== ''
    && !relativePath.startsWith('..')
    && segments.length === 2
    && resolvedCandidate.endsWith('.jsonl')
    && !resolvedCandidate.endsWith('.checkpoints.jsonl')
}

/** 只读 JSONL 首条记录，避免探测大 transcript 时把整份文件载入内存。 */
function readFirstJsonRecord(path: string): Record<string, unknown> | null {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/u).find((line) => line.trim() !== '')
    return firstLine === undefined ? null : parseJson(firstLine)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Command Code 的 `--session <临时路径>` 在部分版本只落检查点文件，不创建主 transcript。
 * 检查点足以证明会话仍可被 `--resume` 找到，但不包含完整消息历史，因此只用于探测回退。
 */
function resolveCommandCodeCheckpointPath(homeDirectory: string, cwd: string, providerSessionId: string): string | null {
  const expected = join(homeDirectory, 'projects', workspaceSlug(cwd), `${providerSessionId}.checkpoints.jsonl`)
  if (existsSync(expected)) return expected
  const projectsRoot = join(homeDirectory, 'projects')
  try {
    for (const entry of readdirSync(projectsRoot)) {
      const candidate = join(projectsRoot, entry, `${providerSessionId}.checkpoints.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // projects 目录不存在说明 CLI 还没写过检查点。
  }
  return null
}

/** CLI 的 canonical 目录名：绝对路径去掉前导分隔符，非字母数字统一换成连字符并转小写。 */
function workspaceSlug(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(':', '-')
    .replaceAll('\\', '-')
    .replaceAll('/', '-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/** 从用户文本提取显式 Skill mention，和 Codex 的 `/name`、`$name` 语义保持一致。 */
function commandCodeSkillNames(prompt: string): readonly string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of prompt.matchAll(/(?:^|\s)(?:\$|\/)([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/gu)) {
    const name = match[1]?.trim()
    if (name === undefined || name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * 按 Command Code 的优先级扫描项目级、用户级和额外 Skill 根目录。
 *
 * 只把合法的 `SKILL.md` 摘要交给 Client；绝对路径保留在 Host，供显式 mention
 * 通过 `--skill` 下发。重名时高优先级目录胜出，避免同一 Skill 被重复注入。
 */
function scanCommandCodeSkills(cwd: string, homeDirectory: string): readonly CommandCodeSkillEntry[] {
  const projectRoot = commandCodeProjectRoot(cwd)
  const userHome = basename(homeDirectory) === '.commandcode' ? dirname(homeDirectory) : homeDirectory
  const disabledSkills = readCommandCodeDisabledSkills(projectRoot, homeDirectory)
  const roots = [
    join(projectRoot, '.commandcode', 'skills'),
    ...commandCodeProjectAgentsSkillRoots(cwd, userHome),
    join(homeDirectory, 'skills'),
    join(userHome, '.agents', 'skills'),
    ...readCommandCodeConfiguredSkillRoots(projectRoot, homeDirectory),
  ]
  const entries: CommandCodeSkillEntry[] = []
  const seenNames = new Set<string>()
  const visitedDirectories = new Set<string>()
  for (const root of roots) scanCommandCodeSkillRoot(root, entries, seenNames, visitedDirectories, disabledSkills)
  return entries
}

/** Command Code 会从当前目录向上查找项目 `.agents/skills`，最多跨十级。 */
function commandCodeProjectAgentsSkillRoots(cwd: string, userHome: string): readonly string[] {
  const roots: string[] = []
  let current = resolve(cwd)
  for (let depth = 0; depth <= 10; depth += 1) {
    if (current === resolve(userHome)) break
    roots.push(join(current, '.agents', 'skills'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

function commandCodeProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  const fallback = current
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return fallback
    current = parent
  }
}

function readCommandCodeConfiguredSkillRoots(projectRoot: string, homeDirectory: string): readonly string[] {
  const settingsLayers = [
    { path: join(projectRoot, '.commandcode', 'settings.local.json'), base: projectRoot },
    { path: join(projectRoot, '.commandcode', 'settings.json'), base: projectRoot },
    { path: join(homeDirectory, 'settings.json'), base: basename(homeDirectory) === '.commandcode' ? dirname(homeDirectory) : homeDirectory },
  ]
  const layer = settingsLayers.find(({ path }) => Array.isArray(readJson(path)?.skills))
  if (layer === undefined) return []
  const settings = readJson(layer.path)
  if (!Array.isArray(settings?.skills)) return []
  const roots: string[] = []
  for (const value of settings.skills) {
    if (typeof value !== 'string' || value.trim() === '') continue
    const configured = value.trim()
    const userHome = basename(homeDirectory) === '.commandcode' ? dirname(homeDirectory) : homeDirectory
    roots.push(configured.startsWith('~/')
      ? resolve(userHome, configured.slice(2))
      : resolve(layer.base, configured))
  }
  return roots
}

function scanCommandCodeSkillRoot(
  root: string,
  entries: CommandCodeSkillEntry[],
  seenNames: Set<string>,
  visitedDirectories: Set<string>,
  disabledSkills: ReadonlySet<string>,
): void {
  if (!existsSync(root)) return
  let canonicalRoot: string
  try {
    if (!statSync(root).isDirectory()) return
    canonicalRoot = realpathSync(root)
  } catch {
    return
  }
  const walk = (directory: string, depth: number): void => {
    if (depth > 32) return
    let canonicalDirectory: string
    try {
      canonicalDirectory = realpathSync(directory)
    } catch {
      return
    }
    if (visitedDirectories.has(canonicalDirectory)) return
    visitedDirectories.add(canonicalDirectory)
    const ownSkillFile = join(canonicalDirectory, 'SKILL.md')
    try {
      if (statSync(ownSkillFile).isFile()) {
        const entry = parseCommandCodeSkillFile(ownSkillFile)
        if (entry !== null && !seenNames.has(entry.name)) {
          seenNames.add(entry.name)
          entries.push(disabledSkills.has(entry.name) ? { ...entry, enabled: false } : entry)
        }
        return
      }
    } catch {
      // 当前目录不是 Skill 目录，继续检查可能的分组子目录。
    }
    let children
    try {
      children = readdirSync(canonicalDirectory, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      if (child.name === '.git' || child.name === 'node_modules') continue
      const childPath = join(canonicalDirectory, child.name)
      if (child.isDirectory()) {
        walk(childPath, depth + 1)
      }
    }
  }
  // 首次遍历也使用规范路径，确保额外目录的符号链接遵守去重规则。
  walk(canonicalRoot, 0)
}

/** disabledSkills 是用户设置与项目设置的并集，保持 Command Code 的禁用语义。 */
function readCommandCodeDisabledSkills(projectRoot: string, homeDirectory: string): ReadonlySet<string> {
  const disabled = new Set<string>()
  const paths = [
    join(homeDirectory, 'settings.json'),
    join(projectRoot, '.commandcode', 'settings.json'),
    join(projectRoot, '.commandcode', 'settings.local.json'),
  ]
  for (const path of paths) {
    const settings = readJson(path)
    if (!Array.isArray(settings?.disabledSkills)) continue
    for (const value of settings.disabledSkills) {
      if (typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.trim())) disabled.add(value.trim())
    }
  }
  return disabled
}

function parseCommandCodeSkillFile(path: string): CommandCodeSkillEntry | null {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const match = source.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (match === null) return null
  const fields = parseSkillFrontmatter(match[1] ?? '')
  if (fields === null) return null
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  const directoryName = basename(dirname(path))
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)
    || name !== directoryName
    || description === '') return null
  return {
    id: name,
    name,
    description,
    enabled: fields['user-invocable'] !== false,
    path: dirname(path),
  }
}

function buildMaxTurnsReachedMessage(autoContinueCount: number, maxTurns: number): string {
  const autoContinueSuffix = autoContinueCount > 0
    ? `，自动续跑 ${autoContinueCount} 次后仍未完成`
    : ''
  return `COMMAND_CODE_MAX_TURNS:单次运行达到 --max-turns ${maxTurns} 上限${autoContinueSuffix}，会话已停止，任务可能尚未完成。`
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

/** 读取可选的整数环境变量；与父仓库同名，便于两套 Host 用同一份运维配置。 */
function readOptionalIntegerEnv(name: string): number | null {
  const raw = process.env[name]?.trim()
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function readSessionId(event: Record<string, unknown>): string | null {
  const value = textValue(event.sessionId ?? event.session_id ?? recordValue(event.session)?.id ?? recordValue(event.result)?.sessionId).trim()
  return value === '' ? null : value
}

/** 会话探测由 Registry 控制超时；文件扫描期间也必须尊重取消信号。 */
function throwIfCommandCodeProbeAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  const error = new Error('Command Code 会话探测已取消')
  error.name = 'AbortError'
  throw error
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : structuredText(value)
}

function structuredText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}

function recordValue(value: unknown): Record<string, any> | null {
  return isRecord(value) ? value : null
}

function writeTranscript(path: string, input: CodingNsCliTurnInput): void {
  mkdirSync(dirname(path), { recursive: true })
  const history = input.messages.length > 0 ? input.messages.slice(0, -1) : []
  let parentId: string | null = null
  const lines = [JSON.stringify({ type: 'session', version: 3, id: input.sessionId, timestamp: new Date().toISOString(), cwd: input.cwd ?? process.cwd() })]
  history.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') return
    const content = extractText(message.content, message)
    if (content.length === 0) return
    const id = message.id ?? `message-${index}`
    const role = message.role === 'tool' ? 'user' : message.role
    lines.push(JSON.stringify({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role, content } }))
    parentId = id
  })
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

type CommandCodeTranscriptBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }

/** 把 DSH 消息块转换为 Command Code 原生 transcript 块，保留工具和推理语义。 */
function extractText(content: unknown, message: { readonly role: string; readonly toolCallId?: string; readonly source?: { readonly callId?: string } }): readonly CommandCodeTranscriptBlock[] {
  if (message.role === 'tool') {
    const toolCallId = message.toolCallId ?? message.source?.callId
    if (toolCallId === undefined || toolCallId.trim() === '') return []
    return [{ type: 'tool_result', tool_use_id: toolCallId, content: extractToolResultContent(content) }]
  }
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: CommandCodeTranscriptBlock[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type === 'tool-call') {
      const id = typeof part.id === 'string' ? part.id.trim() : ''
      const name = typeof part.name === 'string' ? part.name.trim() : ''
      if (id === '' || name === '') continue
      blocks.push({ type: 'tool_use', id, name, input: parseToolInput(part.arguments ?? part.input) })
      continue
    }
    if (part.type === 'tool-result') {
      const toolUseId = firstText(part.toolCallId, part.tool_use_id, part.toolUseId)
      if (toolUseId !== '') blocks.push({ type: 'tool_result', tool_use_id: toolUseId, content: extractToolResultContent(part.content ?? part.output ?? part.result) })
      continue
    }
    if (part.type === 'thinking' || part.type === 'reasoning') {
      const thinking = firstText(part.thinking, part.reasoning, part.text, part.content)
      if (thinking !== '') blocks.push({ type: 'thinking', thinking })
      continue
    }
    const text = typeof part.text === 'string' ? part.text : ''
    if (text !== '') blocks.push({ type: 'text', text })
  }
  return blocks
}

function extractToolResultContent(content: unknown): readonly { readonly type: 'text'; readonly text: string }[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    const parts = content.filter(isRecord).map((part) => {
      if (typeof part.text === 'string') return { type: 'text' as const, text: part.text }
      return null
    }).filter((part): part is { readonly type: 'text'; readonly text: string } => part !== null)
    if (parts.length > 0) return parts
  }
  return [{ type: 'text', text: structuredText(content) }]
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) as unknown } catch { return value }
}

function firstText(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value !== '') ?? ''
}

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 96) || 'default' }

/** 旧驱动生成的 Host synthetic ID；没有 canonical transcript 时必须放弃 --resume。 */
function isLegacySyntheticSessionId(value: string): boolean {
  return value.startsWith('codingns4dsh-cc-session-') || value.startsWith('dsh-codingns-cc-session-')
}
function parseJson(value: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : null } catch { return null } }
function readJson(path: string): Record<string, unknown> | null { if (!existsSync(path)) return null; try { const parsed: unknown = JSON.parse(readFileSync(path, 'utf8')); return isRecord(parsed) ? parsed : null } catch { return null } }

/** 保留启动选择作为进程复用条件；ACP 的实际会话状态由原生协议显式设置。 */
function commandCodeAcpArgs(input: CodingNsCliTurnInput): readonly string[] {
  // Command Code 的全局 --mod 必须放在 acp 子命令之前；放到 acp 之后会被
  // Commander 当成 ACP 子命令参数而拒绝。该参数无论桥接状态都必须存在，确保
  // 启动阶段就屏蔽原生 agent。
  const args = [...commandCodeNativeAgentArgs(input.sessionId), 'acp', ...commandCodePermissionArgs(input.permission)]
  if (input.plan === true && !args.includes('--plan')) args.push('--plan')
  if (input.enableAskUserQuestion === true || input.runtimeEnv?.CMD_TOOLS_ASK_USER_QUESTION_ENABLE === 'true') {
    args.push('--tools-enable', 'ask_user_question')
  }
  for (const path of input.skillPaths ?? []) args.push('--skill', path)
  if (input.modelId !== undefined && input.modelId !== 'provider-default') args.push('--model', input.modelId)
  const effort = input.effortId?.trim().toLowerCase()
  if (effort !== undefined && VALID_EFFORTS.has(effort)) args.push('--effort', effort)
  return args
}

/**
 * Command Code 1.74.3 的 acp 子命令不执行普通 CLI action 的参数初始化。
 * 仅传 --model/--effort/--permission-mode 会被静默忽略，恢复的会话还会沿用旧模型。
 * 必须在 prompt 前设置线程状态，且不能吞掉模型或权限设置失败。
 */
async function configureCommandCodeAcpSession(rpc: JsonRpcProcess, sessionId: string, input: CodingNsCliTurnInput): Promise<void> {
  const requestOptions = { signal: input.signal, killOnAbort: false }
  if (input.modelId !== undefined && input.modelId !== 'provider-default') {
    await rpc.request('session/set_model', { sessionId, modelId: input.modelId }, requestOptions)
  }
  await rpc.request('session/set_mode', { sessionId, modeId: commandCodeAcpMode(input) }, requestOptions)
  const effort = input.effortId?.trim().toLowerCase()
  if (effort !== undefined && VALID_EFFORTS.has(effort)) {
    await rpc.request('session/set_config_option', { sessionId, configId: 'effort', value: effort }, requestOptions)
  }
}

/** ACP 使用权限引擎的模式 ID，与普通 CLI 的 accept-edits/yolo 别名不同。 */
function commandCodeAcpMode(input: CodingNsCliTurnInput): string {
  const permission = input.permission
  if (input.plan === true || permission?.sandboxMode === 'read-only') return 'plan'
  // 工作区内写入已经由沙箱模式授权；ask 只表示需要审批时可以询问，不能把
  // 每次普通编辑都降级到 default。auto-accept 仍由 CLI 检查越界与风险操作。
  if (permission?.sandboxMode === 'workspace-write') return 'auto-accept'
  if (permission?.approvalPolicy !== 'never') return 'default'
  if (permission.sandboxMode === 'danger-full-access') return 'bypass'
  return 'default'
}

/** 托管委派由 DSH 桥接校验目标授权，不能再交给 CLI 对每次调用重复审批。 */
function commandCodeAcpPermissionDecision(message: JsonRpcMessage, input: CodingNsCliTurnInput): 'allow' | 'reject' | undefined {
  if (message.method !== 'session/request_permission') return undefined
  const params = isRecord(message.params) ? message.params : {}
  const tool = isRecord(params.toolCall) ? params.toolCall : {}
  const toolName = firstToolText(tool.name, tool.toolName, tool.tool_name, tool.title)
  const metadata = isRecord(params._meta) ? params._meta : {}
  const permission = input.permission
  const canWrite = input.plan !== true
    && (permission?.sandboxMode === 'workspace-write' || permission?.sandboxMode === 'danger-full-access')
  // 只识别插件自己的两个入口，不能把全部 MCP/自定义工具或显式风险请求放行。
  if (canWrite && metadata.risk === undefined && subagentBridgeActive(input.sessionId)
    && (toolName === 'agent_subagent' || toolName === 'mcp__codingns__agent_subagent')) return 'allow'
  // never 允许已有授权范围内的工作，但不允许把剩余审批升级成交互弹窗。
  return permission?.approvalPolicy === 'never' ? 'reject' : undefined
}

/** Command Code 将 ask_user_question 编译成 `session/request_permission`。 */
function readCommandCodeQuestionRequest(message: JsonRpcMessage): AcpPendingQuestionRequest | null {
  const method = message.method?.toLowerCase()
  if (method !== 'session/request_permission' || (typeof message.id !== 'string' && typeof message.id !== 'number')) return null
  const params = isRecord(message.params) ? message.params : {}
  const tool = isRecord(params.toolCall) ? params.toolCall : isRecord(params.tool_call) ? params.tool_call : {}
  const kind = firstToolText(tool.kind, params.kind)?.toLowerCase()
  const toolName = firstToolText(tool.name, tool.toolName, tool.tool_name)
  if (kind !== 'other' && toolName !== 'ask_user_question') return null
  const rawInput = isRecord(tool.rawInput) ? tool.rawInput : isRecord(tool.raw_input) ? tool.raw_input : {}
  const questionText = firstToolText(rawInput.question, rawInput.prompt, params.question, params.prompt)
  const rawOptions = Array.isArray(rawInput.options)
    ? rawInput.options
    : Array.isArray(params.questionOptions)
      ? params.questionOptions
      : []
  if (questionText === undefined || rawOptions.length === 0) return null
  const options = rawOptions.flatMap((rawOption) => {
    if (typeof rawOption === 'string' && rawOption.trim() !== '') return [{ label: rawOption.trim() }]
    if (!isRecord(rawOption)) return []
    const label = firstToolText(rawOption.label, rawOption.name, rawOption.title, rawOption.value)
    if (label === undefined) return []
    const description = firstToolText(rawOption.description, rawOption.detail)
    return [{ label, ...(description === undefined ? {} : { description }) }]
  })
  if (options.length === 0) return null
  const protocolOptions = Array.isArray(params.options) ? params.options : []
  const optionIds = options.map((_, index) => {
    const protocolOption = isRecord(protocolOptions[index]) ? protocolOptions[index] : {}
    return firstToolText(protocolOption.optionId, protocolOption.option_id, protocolOption.id) ?? `option_${index}`
  })
  const requestId = String(message.id)
  const questionId = `command-code-question-${requestId}`
  const header = firstToolText(rawInput.header, params.header)
  return {
    requestId,
    rpcId: message.id,
    questions: [{
      id: questionId,
      question: questionText,
      ...(header === undefined ? {} : { header }),
      options,
    }],
    respond: (response) => {
      const answer = response.answers.find((item) => item.id === questionId) ?? response.answers[0]
      const custom = answer?.custom?.trim() ?? ''
      const selected = answer?.selected[0]?.trim() ?? ''
      const selectedIndex = options.findIndex((option) => option.label === selected)
      if (custom !== '') {
        // `optionId` 使用保留值，未加载兼容桥时会安全地取消，不会误选第一项。
        // loader 会从 _meta 读取原文，并把它作为 ask_user_question 的工具答案。
        return {
          outcome: { outcome: 'selected', optionId: '__codingns_custom__' },
          answers: [{ questionIndex: 0, selectedOptions: [custom] }],
          _meta: { 'codingns/questionAnswer': custom },
        }
      }
      if (selected === '' || selectedIndex < 0) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: optionIds[selectedIndex] } }
    },
  }
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }
