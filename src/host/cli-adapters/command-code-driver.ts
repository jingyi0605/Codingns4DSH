import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import readline from 'node:readline'
import type {
  CodingNsCliModelCatalog,
  CodingNsAgentEvent,
  CodingNsAgentToolEvent,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { firstToolText, serializeToolValue } from './tool-observation.js'
import { usageChunk } from './rpc-driver-utils.js'
import { commandEnvironment, resolveCommandPath, terminateChildProcess } from './process-utils.js'

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
  child: ChildProcessWithoutNullStreams | undefined
  readonly transcriptPath: string
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
}

/** 单次运行内的消息标识与增量补齐状态。 */
interface CommandCodeStreamState {
  messageSequence: number
  messageId: string | null
  emittedText: string
  emittedReasoning: string
  sawText: boolean
  perRequestUsageSeen: boolean
  turnUsageSeen: boolean
  sessionId: string | null
  aborted: () => boolean
  /** 本次尝试是否以 `--max-turns` 上限结束；上限不是终态，需要自动续跑。 */
  maxTurnsReached: boolean
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
}

/**
 * CLI 的 `--max-turns` 默认只有 100，复杂任务经常在半途被截断。
 *
 * 这里显式抬高预算，避免“还没做完就输出结束”；真撞到了再由自动续跑兜底。
 */
const DEFAULT_MAX_TURNS = 500
const DEFAULT_AUTO_CONTINUE_ATTEMPTS = 3
const AUTO_CONTINUE_PROMPT = '继续'
/** CLI 在 -p 模式撞到 --max-turns 时的退出码（MAX_TURNS_REACHED）。 */
const COMMAND_CODE_MAX_TURNS_EXIT_CODE = 8

/**
 * Command Code 驱动：沿用 `--session + -p + --output-format json` 的 NDJSON 事件流。
 *
 * 与 Codex 驱动保持同一套消息优化：正文/推理增量携带 assistant 消息身份，工具完成后
 * 的下一条 assistant 消息之前结束当前 DSH step，因此一个 Provider 运行会被切成多个
 * step，而不是把整轮正文堆积到最后一条结算消息里。驱动只输出公共事件契约，工具历史、
 * usage 和原生组件映射全部交给公共消息投影层。
 */
export class CommandCodeDriver implements CodingNsCliDriver {
  readonly descriptor = {
    id: 'command-code',
    name: 'Command Code',
    protocol: 'command',
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] as const,
  } as const
  /** 驱动自己维护 Provider turn 边界，Host 可以把工具边界映射为 DSH step。 */
  readonly supportsSegmentedTurns = true
  private readonly homeDirectory: string
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly maxTurns: number
  private readonly autoContinueMaxAttempts: number
  private readonly autoContinuePrompt: string
  private cachedBinary: string | null = null
  private cachedEnvironment: Record<string, string | undefined> | undefined
  private readonly processes = new Set<ChildProcessWithoutNullStreams>()
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
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    for (const command of this.binaries) {
      const direct = this.detectCommand(command)
      if (direct !== null) return direct
      if (!this.lookupAfterDetectionFailure) continue
      const resolved = resolveCommandPath(command, this.runSpawnSync)
      if (resolved === null) continue
      const fallback = this.detectCommand(resolved)
      if (fallback !== null) return fallback
    }
    return { installed: false, version: null, command: null }
  }

  private lookupAfterDetectionFailure = false

  private detectCommand(command: string): { installed: true; version: string; command: string } | null {
    this.lookupAfterDetectionFailure = false
    try {
      const result = this.runSpawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3_000, windowsHide: true, shell: WINDOWS, env: commandEnvironment(command) })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      const version = output.match(/\d+\.\d+\.\d+/u)?.[0] ?? null
      if (result.status === 0 && version !== null) {
        this.cachedBinary = command
        this.cachedEnvironment = commandEnvironment(command)
        return { installed: true, version, command }
      }
      this.lookupAfterDetectionFailure = result.status === null
    } catch {
      // PATH 中不存在候选命令属于正常的未安装状态。
      this.lookupAfterDetectionFailure = true
    }
    return null
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detection = await this.detect()
    if (!detection.installed || detection.command === null) return emptyCatalog()
    let stdout = ''
    try {
      const result = this.runSpawnSync(detection.command, ['--list-models'], { encoding: 'utf8', timeout: 12_000, windowsHide: true, shell: WINDOWS, ...(this.cachedEnvironment === undefined ? {} : { env: this.cachedEnvironment }) })
      stdout = result.stdout ?? ''
    } catch {
      return emptyCatalog()
    }

    const groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string; efforts: readonly string[] }> }> = []
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
      currentGroup.models.push({ id, name: id, ...(description ? { description } : {}), efforts: CATALOG_EFFORTS.get(id.toLowerCase()) ?? [] })
    }

    const config = readJson(join(this.homeDirectory, 'config.json'))
    const currentModel = typeof config?.model === 'string' ? config.model : null
    const configuredEffort = currentModel !== null && isRecord(config?.reasoningEffort) ? config.reasoningEffort[currentModel] : undefined
    const currentEffort = typeof configuredEffort === 'string' && VALID_EFFORTS.has(configuredEffort) ? configuredEffort : null
    const result = { groups, currentModel, currentEffort } satisfies CodingNsCliModelCatalog
    return result
  }

  async probeSession(_input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return {
      state: 'ephemeral',
      reason: 'Command Code 当前使用单轮临时 transcript，不存在可恢复的 Provider 原始会话',
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const binary = this.cachedBinary ?? (await this.detect()).command
    if (binary === null) throw new Error('Command Code 未安装')

    const segmented = input.splitToolSteps === true
    const turn = segmented ? this.acquireTurn(input, binary) : this.startTurn(input, binary)
    let suspended = false
    const onAbort = (): void => { turn.aborted = true; this.disposeTurn(turn) }
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
    for (const turn of [...this.turns.values()]) this.disposeTurn(turn)
    this.turns.clear()
    for (const child of this.processes) terminateChildProcess(child)
    this.processes.clear()
    this.cachedBinary = null
  }

  /** 丢弃等待下一个 DSH step 的 `-p` 运行，避免旧进程继续占用新一轮输出。 */
  discardSegmentedTurn(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn !== undefined) this.disposeTurn(turn)
  }

  /** 只有 Host 显式声明续段时才复用常驻进程；新的用户回合必须重新启动。 */
  private acquireTurn(input: CodingNsCliTurnInput, binary: string): CommandCodeTurn {
    const existing = this.turns.get(input.sessionId)
    if (existing !== undefined) {
      if (input.resumeSegmentedTurn === true && !existing.disposed && !existing.finished) return existing
      this.disposeTurn(existing)
    }
    const turn = this.startTurn(input, binary)
    this.turns.set(input.sessionId, turn)
    return turn
  }

  private startTurn(input: CodingNsCliTurnInput, binary: string): CommandCodeTurn {
    const transcriptPath = join(tmpdir(), `codingns4dsh-cc-${safeId(input.sessionId)}.jsonl`)
    writeTranscript(transcriptPath, input)
    const turn: CommandCodeTurn = {
      sessionId: input.sessionId,
      child: undefined,
      transcriptPath,
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
    }
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
        // 自动续跑是同一个 DSH 运行里的下一段；消息序号必须跨尝试连续，
        // 否则新进程会从 command-code-message-1 重新编号，公共投影层会把它
        // 当成同一条消息继续追加，而不是开启新段。
        const state = createStreamState(() => turn.aborted, turn.messageSequence)
        const child = this.spawnAttempt(turn, input, binary)
        const code = await this.readAttempt(turn, child, state)
        turn.messageSequence = state.messageSequence
        if (turn.disposed || turn.finished) return

        const capped = state.maxTurnsReached || code === COMMAND_CODE_MAX_TURNS_EXIT_CODE
        const autoContinueUsed = turn.attempt - 1
        if (capped && !turn.aborted && !turn.terminal && autoContinueUsed < this.autoContinueMaxAttempts) {
          // 续跑必须落在同一个会话上。CLI 可能把 transcript 写回会话文件、也可能
          // 写进按 cwd 归档的 canonical 目录；两种落点都要先归位到同一个文件，
          // 否则“继续”会开出一个没有上文的新会话，等于白跑一轮预算。
          syncCommandCodeTranscript(turn.transcriptPath, this.homeDirectory, input.cwd)
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
  ): ChildProcessWithoutNullStreams {
    const args = this.buildTurnArgs(input, turn)
    const child = this.runSpawn(binary, args, { cwd: input.cwd ?? process.cwd(), env: this.cachedEnvironment ?? commandEnvironment(binary), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: WINDOWS })
    // 自动续跑会替换活动进程；已退出的旧尝试不能继续留在进程表里等待 terminate。
    if (turn.child !== undefined) this.processes.delete(turn.child)
    this.processes.add(child)
    // 必须消费 stderr，错误内容不能回传给 DSH，避免泄露命令参数或文件片段。
    child.stderr?.on('data', () => undefined)
    turn.child = child
    return child
  }

  private buildTurnArgs(input: CodingNsCliTurnInput, turn: CommandCodeTurn): string[] {
    // 续跑沿用同一个 transcript 文件，只把输入换成续跑提示；不能再次写入历史，
    // 否则会把 CLI 已经落盘的进度覆盖成空会话。
    const prompt = turn.attempt > 1 ? this.autoContinuePrompt : input.prompt
    const args = ['--session', turn.transcriptPath, '-p', prompt, '--output-format', 'json', '--tools-all', '--yolo', '--max-turns', String(this.maxTurns)]
    if (input.modelId) args.push('-m', input.modelId)
    if (input.effortId && input.effortId !== 'default' && input.effortId !== 'Default') args.push('--effort', input.effortId)
    return args
  }

  /** 读取一次尝试的 stdout，直到进程结束；队列在整个运行结束前保持打开。 */
  private async readAttempt(
    turn: CommandCodeTurn,
    child: ChildProcessWithoutNullStreams,
    state: CommandCodeStreamState,
  ): Promise<number | null> {
    // 测试替身可能只提供 stdout/kill，没有 ChildProcess 的事件接口。
    const emitter = typeof (child as { on?: unknown }).on === 'function'
      ? child as unknown as {
          on(event: string, listener: (...args: any[]) => void): unknown
        }
      : null
    let exitCode: number | null = null
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
      emitter.on('close', (code: number | null) => {
        exitCode = code
        if (state.maxTurnsReached) turn.maxTurnsReached = true
        resolveClose?.()
      })
    }
    try {
      const lines = readline.createInterface({ input: child.stdout })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          const item = parseJson(line)
          if (item === null) continue
          const event = item.type === 'event' && isRecord(item.event) ? item.event : item
          for (const chunk of commandCodeEventChunks(event, state)) {
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
    try { rmSync(turn.transcriptPath, { force: true }) } catch { /* 临时文件清理尽力而为 */ }
  }
}

function createStreamState(aborted: () => boolean, messageSequence = 0): CommandCodeStreamState {
  return {
    messageSequence,
    messageId: null,
    emittedText: '',
    emittedReasoning: '',
    sawText: false,
    perRequestUsageSeen: false,
    turnUsageSeen: false,
    sessionId: null,
    aborted,
    maxTurnsReached: false,
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
    case 'turn_start':
    case 'turn-start':
      beginMessage(state)
      break
    case 'message_start':
    case 'message-start':
      // 正常一轮只有一个模型请求；没有 turn_start 的旧版本由这里补消息身份。
      if (state.messageId === null) beginMessage(state)
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
      break
    case 'model_request_end':
    case 'model-request-end': {
      const usage = usageChunk(recordValue(event.usage))
      if (usage !== null) {
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
        const usage = usageChunk(recordValue(event.usage))
        if (usage !== null) {
          state.perRequestUsageSeen = true
          state.turnUsageSeen = true
          chunks.push(usage)
        }
      }
      break
    }
    case 'run_end':
    case 'run-end':
      // run_end 只是“CLI 侧整个 run 收尾了”，最终结算仍以紧随其后的 result 行为准。
      // 这里只识别轮次上限：上限不是终态，等进程退出后决定续跑还是报错。
      if (isMaxTurnsOutcome(event)) state.maxTurnsReached = true
      break
    case 'result': {
      if (!state.perRequestUsageSeen) {
        const usage = usageChunk(recordValue(event.usage))
        if (usage !== null) chunks.push(usage)
      }
      if (!state.sawText) {
        const finalText = textValue(event.finalText ?? recordValue(event.result)?.finalText ?? (typeof event.result === 'string' ? event.result : undefined))
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
      chunks.push({ type: 'finish', reason: state.aborted() ? 'cancel' : resultReason(event) })
      break
    }
    default:
      break
  }

  if (isToolStart(type)) {
    const tool = readToolChunk(event, type === 'tool_queued' || type === 'tool_started' ? 'started' : 'running')
    if (tool !== null) chunks.push(tool)
  } else if (isToolResult(type)) {
    const failed = type.includes('error') || type.includes('fail') || type.includes('denied') || type.includes('blocked')
    const tool = readToolChunk(event, failed ? 'failed' : 'completed')
    if (tool !== null) {
      chunks.push(tool)
      // 工具完成后的正文属于下一条 assistant 消息。即使 CLI 没有发送
      // turn_start/message_start，也要让公共投影层看到消息身份切换。
      if (tool.status === 'completed' || tool.status === 'failed') resetMessageIdentity(state)
    }
  }
  return chunks
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
  let text = ''
  let reasoning = ''
  for (const block of content) {
    const value = recordValue(block)
    if (value === null) continue
    const blockType = textValue(value.type).toLowerCase()
    const isReasoning = blockType.includes('thinking') || blockType.includes('reasoning')
      || typeof value.thinking === 'string' || typeof value.reasoning === 'string'
    if (isReasoning) reasoning += textValue(value.thinking ?? value.reasoning ?? value.text ?? value.content)
    else text += textValue(value.text ?? value.content)
  }
  if (text.length > state.emittedText.length) {
    const delta = text.slice(state.emittedText.length)
    ensureMessage(state)
    state.emittedText = text
    state.sawText = true
    chunks.push(textDelta(delta, state))
  }
  if (reasoning.length > state.emittedReasoning.length) {
    const delta = reasoning.slice(state.emittedReasoning.length)
    ensureMessage(state)
    state.emittedReasoning = reasoning
    chunks.push(reasoningDelta(delta, state))
  }
}

function readToolChunk(event: Record<string, unknown>, status: 'started' | 'running' | 'completed' | 'failed'): CodingNsAgentToolEvent | null {
  const callId = firstToolText(event.callId, event.call_id, event.toolCallId, event.tool_call_id, event.toolUseId, event.tool_use_id, event.id)
  const fn = recordValue(event.function)
  const toolName = textValue(event.name ?? event.toolName ?? event.tool_name ?? event.tool ?? fn?.name) || 'tool'
  const error = textValue(event.error ?? event.reason ?? event.message)
  const output = textValue(event.output ?? event.result ?? event.content)
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
 * `--session` 指定的文件。两种落点都要先归位，否则自动续跑的“继续”会落在一个
 * 没有上文的会话上。归位只做“canonical 比本地新”的单向复制，不覆盖更新的本地文件。
 */
function syncCommandCodeTranscript(
  transcriptPath: string,
  homeDirectory: string,
  cwd: string | undefined,
): void {
  const canonicalPath = resolveCanonicalTranscriptPath(transcriptPath, homeDirectory, cwd)
  if (canonicalPath === null) return
  try {
    if (statSync(canonicalPath).mtimeMs <= statSync(transcriptPath).mtimeMs) return
    copyFileSync(canonicalPath, transcriptPath)
  } catch {
    // transcript 归位是续跑优化；文件缺失或不可读时保持现状即可。
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
  const history = input.messages.length > 0 ? input.messages.slice(0, -1) : []
  let parentId: string | null = null
  const lines = [JSON.stringify({ type: 'session', version: 3, id: input.sessionId, timestamp: new Date().toISOString(), cwd: input.cwd ?? process.cwd() })]
  history.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return
    const id = message.id ?? `message-${index}`
    lines.push(JSON.stringify({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role: message.role, content: [{ type: 'text', text: extractText(message.content) }] } }))
    parentId = id
  })
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

function extractText(content: unknown): string { if (typeof content === 'string') return content; if (!Array.isArray(content)) return ''; return content.filter(isRecord).map((part) => typeof part.text === 'string' ? part.text : '').join('\n').trim() }
function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 96) || 'default' }
function parseJson(value: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : null } catch { return null } }
function readJson(path: string): Record<string, unknown> | null { if (!existsSync(path)) return null; try { const parsed: unknown = JSON.parse(readFileSync(path, 'utf8')); return isRecord(parsed) ? parsed : null } catch { return null } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }
