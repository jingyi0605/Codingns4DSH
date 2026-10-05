import { spawn, spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import type { CodingNsAgentEvent, CodingNsCliAdapterDescriptor, CodingNsCliModelCatalog, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { StandardStreamDriver, emptyCatalog, genericEventChunks } from './standard-stream-driver.js'
import { ANTIGRAVITY_CATALOG, antigravitySupportsEffort, antigravityUsageExcludesCacheFromInput, isProviderDefaultModel, knownAntigravityContextWindow, parseAntigravityModels, resolveAntigravityModelId } from './model-catalog.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'
import { terminateChildProcess, type CodingNsChildProcess } from './process-utils.js'
import { usageChunk } from './rpc-driver-utils.js'
import { advanceCodingNsSegment, createCodingNsSegmentState, decorateCodingNsSegmentEvent } from './stream-normalizer.js'

const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 30_000

/** 进程内保留的会话级累计用量基线数量上限，避免长驻 Host 无限增长。 */
const ANTIGRAVITY_CUMULATIVE_LIMIT = 256

/**
 * 异步缓冲一次外部 CLI 调用。
 *
 * `agy models` 会启动完整 Language Server，并且模型已经输出后还要等待
 * 子进程退出。这里必须使用 spawn，不能用 spawnSync，否则会把 Host 事件循环
 * 一起阻塞。超时和子进程 error 都在 Promise 边界内收敛，避免再次击穿 Host。
 */
async function runBufferedModels(
  runSpawn: typeof spawn,
  command: string,
  environment: Record<string, string | undefined>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Antigravity 模型目录探测已取消'))
      return
    }
    let child: CodingNsChildProcess
    try {
      child = runSpawn(command, ['models'], {
        env: environment,
        windowsHide: true,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as CodingNsChildProcess
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      finish(() => reject(new Error('Antigravity 模型目录探测已取消')))
      terminateChildProcess(child)
    }
    const timer = setTimeout(() => {
      if (settled) return
      finish(() => reject(new Error(`Antigravity 模型目录探测超过 ${timeoutMs}ms`)))
      terminateChildProcess(child)
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384) })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) => finish(() => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim() || `Antigravity CLI exited with code ${String(code)}`))
    }))
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface AntigravityDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  /**
   * 上下文窗口解析。默认读 AGY 设置文件判断 `provider-default` 实际使用的模型，
   * 测试注入固定实现即可脱离本机 AGY 安装状态。
   */
  readonly resolveContextWindow?: (modelId: string | undefined) => number | undefined
  /**
   * 会话实际模型解析。AGY 的 usage 缓存字段口径随模型 Provider 不同（Claude 与
   * Gemini 的 `input_tokens` 含义不一致），默认读 AGY 设置文件判断
   * `provider-default` 实际使用的模型。
   */
  readonly resolveModelId?: (modelId: string | undefined) => string | null
}

/**
 * Antigravity 的 stream-json print 模式：输入从 stdin 以 NDJSON 写入，输出仍是
 * 逐行 JSON。它只有全放行权限模式，因此故意不声明 permission/questions。
 */
export class AntigravityDriver extends StandardStreamDriver implements CodingNsCliDriver {
  private readonly observedText = new WeakMap<object, string>()
  /** 本轮各次模型调用的用量；result 到达时汇总成单轮用量。 */
  private readonly turnUsages = new WeakMap<object, AntigravityTurnState>()
  /** 会话级累计用量基线；AGY 的 result.usage 是整个会话的累计值。 */
  private readonly cumulativeUsages = new Map<string, AntigravityUsage>()
  private readonly resolveContextWindow: (modelId: string | undefined) => number | undefined
  private readonly resolveModelId: (modelId: string | undefined) => string | null
  private readonly modelProbeAbort = new AbortController()

  readonly warmModelCatalog = true
  /** AGY stream-json 会把工具和后续正文放在同一条可暂停事件流中。 */
  readonly supportsToolStepSplitting = true

  readonly descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'> = {
    id: 'antigravity',
    name: 'Antigravity',
    protocol: 'stream-json',
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning'],
  }

  constructor(options: AntigravityDriverOptions = {}) {
    super({
      id: 'antigravity',
      name: 'Antigravity',
      protocol: 'stream-json',
      capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning'],
    }, {
      binaries: options.binaries ?? ['agy'],
      versionArgs: ['--version'],
      modelArgs: ['models'],
    }, options)
    this.resolveContextWindow = options.resolveContextWindow ?? ((modelId) => knownAntigravityContextWindow(modelId))
    this.resolveModelId = options.resolveModelId ?? ((modelId) => resolveAntigravityModelId(modelId))
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detected = await this.detect()
    if (!detected.installed || detected.command === null) return emptyCatalog()
    try {
      // `agy models` 需要向服务端拉取目录；在本机冷启动约 19 秒，
      // 这里沿用 codexhost 的异步缓冲方式，避免同步阻塞 Host 事件循环。
      const result = await runBufferedModels(
        this.runSpawn,
        detected.command,
        this.resolvedEnvironment ?? { ...process.env },
        ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS,
        this.modelProbeAbort.signal,
      )
      return parseAntigravityModels(`${result.stdout}\n${result.stderr}`)
    } catch {
      return ANTIGRAVITY_CATALOG
    }
  }

  protected get usesStdin(): boolean { return true }

  dispose(): void {
    this.modelProbeAbort.abort()
    this.cumulativeUsages.clear()
    super.dispose()
  }

  protected validateProviderSessionBinding(input: CodingNsCliTurnInput, providerSessionId: string): void {
    const expected = input.providerSessionId?.trim()
    if (expected !== undefined && expected !== '' && expected !== providerSessionId) {
      throw new Error(`Antigravity 恢复会话不一致：期望 ${expected}，实际 ${providerSessionId}`)
    }
  }

  protected writeStdin(child: CodingNsChildProcess, input: CodingNsCliTurnInput): void {
    const prompt = promptWithAttachmentPaths(input.prompt, input.attachments ?? [])
    // Antigravity 的 stream-json 输入协议要求每一轮一个 user 事件，且
    // message 必须是带 content 字符串的对象；直接传字符串会让 AGY 退出。
    if (child.stdin === null) throw new Error('Antigravity CLI 未打开 stdin 管道')
    child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`, 'utf8')
  }

  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    const cancelled = input.signal?.aborted ?? false
    const step = readRecord(value.step_update)
    const result = value.event === 'result' ? readRecord(value.result) : null
    let chunks: CodingNsAgentEvent[]
    if (value.event === 'step_update' && step !== null) {
      // AGY 的 step_update（agent_response / state=DONE）携带的是「这一次模型调用」
      // 的真实用量，而最终 result 的 usage 是整个会话的累计值。这里把单次调用收进
      // 本轮累加器，并剥掉 step_update.usage，避免 genericEventChunks 再产出一份
      // 重复采样。
      this.collectStepUsage(input, step)
      const sanitized = { ...step }
      delete sanitized.usage
      // AGY 把真实事件类型放在 step_update.step_type，而外层 event 永远是
      // step_update。把它提升成 genericEventChunks 能识别的 type，才能保留
      // agent_response 正文和 tool 生命周期。
      if (typeof sanitized.step_type === 'string' && sanitized.step_type.trim() !== '') {
        sanitized.type = sanitized.step_type
      }
      chunks = genericEventChunks({ ...value, event: sanitized }, cancelled)
    } else if (result !== null) {
      // result.usage 是会话累计值，绝不能当作单轮用量交给 DSH；剥掉后由下面的
      // 单轮汇总事件补上，否则 token-meter 会把累计值按轮反复累加。
      const sanitizedResult = { ...result }
      delete sanitizedResult.usage
      chunks = genericEventChunks({ ...value, usage: undefined, result: sanitizedResult }, cancelled)
    } else {
      chunks = genericEventChunks(value, cancelled)
    }
    const currentText = this.observedText.get(input) ?? ''
    let observedText = currentText
    for (const chunk of chunks) {
      if (chunk.type === 'text-delta') observedText += chunk.text
    }
    if (observedText !== currentText) this.observedText.set(input, observedText)
    // AGY 的最终 result 可能只在 response 中携带完整正文，不能依赖前面的
    // step_update 一定包含 agent_response 增量。
    if (result !== null) {
      const status = typeof result.status === 'string' ? result.status.trim().toLowerCase() : ''
      if (status !== '' && !['success', 'succeeded', 'completed', 'complete', 'done'].includes(status)) {
        const failureMessage = typeof result.error === 'string' && result.error.trim() !== ''
          ? result.error.trim()
          : `Antigravity result status: ${String(result.status)}`
        const finishIndex = chunks.findIndex((chunk) => chunk.type === 'finish')
        const failureChunk: CodingNsAgentEvent = { type: 'finish', reason: 'error', failure: { message: failureMessage } }
        if (finishIndex >= 0) chunks[finishIndex] = failureChunk
        else chunks.push(failureChunk)
      }
      const response = result.response
      if (typeof response === 'string' && response.length > 0) {
        const delta = appendOrSyncText(observedText, response)
        if (delta.length > 0) chunks.unshift({ type: 'text-delta', text: delta })
      }
      const conversationId = readConversationId(result, input)
      const cumulative = readAntigravityUsage(result.usage)
      const turn = this.takeTurnUsage(input, cumulative, conversationId)
      if (cumulative !== null) this.rememberCumulativeUsage(conversationId, cumulative)
      const usageEvent = this.buildUsageEvent(input, turn)
      if (usageEvent !== null) {
        // usage 必须排在 finish 之前，公共投影层才会在结算前把它交给 token-meter。
        const finishIndex = chunks.findIndex((chunk) => chunk.type === 'finish')
        if (finishIndex >= 0) chunks.splice(finishIndex, 0, usageEvent)
        else chunks.push(usageEvent)
      }
      this.observedText.delete(input)
    }
    return chunks
  }

  /** 收下一次模型调用的用量；同一 step_index 重复上报时以后者为准。 */
  private collectStepUsage(input: CodingNsCliTurnInput, step: Record<string, unknown>): void {
    const usage = readAntigravityUsage(step.usage)
    if (usage === null) return
    const state = this.turnUsages.get(input) ?? {
      calls: new Map<number, AntigravityUsage>(),
      lastInputTokens: undefined,
      lastCacheReadTokens: undefined,
    }
    const stepIndex = typeof step.step_index === 'number' && Number.isFinite(step.step_index)
      ? step.step_index
      : state.calls.size
    state.calls.set(stepIndex, usage)
    state.lastInputTokens = usage.input_tokens
    state.lastCacheReadTokens = usage.cache_read_tokens
    this.turnUsages.set(input, state)
  }

  /**
   * 汇总本轮用量。
   *
   * 首选 step_update 的逐次调用用量（真实单轮口径）；只有 AGY 完全没给 step 用量时
   * 才退回「本次累计值 − 该会话上次累计值」，避免把整个会话的累计值写成一轮用量。
   */
  private takeTurnUsage(
    input: CodingNsCliTurnInput,
    cumulative: AntigravityUsage | null,
    conversationId: string,
  ): AntigravityTurnUsage {
    const state = this.turnUsages.get(input)
    this.turnUsages.delete(input)
    const lastInputTokens = state?.lastInputTokens
    const lastCacheReadTokens = state?.lastCacheReadTokens
    const summed = state === undefined ? null : sumAntigravityUsage(state.calls.values())
    if (summed !== null) return { usage: summed, lastInputTokens, lastCacheReadTokens }
    if (cumulative === null) return { usage: null, lastInputTokens, lastCacheReadTokens }
    const baseline = this.cumulativeUsages.get(conversationId)
    return {
      usage: baseline === undefined ? cumulative : subtractAntigravityUsage(cumulative, baseline),
      lastInputTokens,
      lastCacheReadTokens,
    }
  }

  private rememberCumulativeUsage(conversationId: string, usage: AntigravityUsage): void {
    // Map 保留插入顺序：重新插入即把该会话移到最新，超限时淘汰最旧的会话。
    this.cumulativeUsages.delete(conversationId)
    this.cumulativeUsages.set(conversationId, usage)
    while (this.cumulativeUsages.size > ANTIGRAVITY_CUMULATIVE_LIMIT) {
      const oldest = this.cumulativeUsages.keys().next().value
      if (oldest === undefined) break
      this.cumulativeUsages.delete(oldest)
    }
  }

  /**
   * 把单轮用量映射成公共 usage 事件，并补上 AGY 不报告的上下文容量。
   *
   * `output_tokens` 已经包含 `thinking_tokens`，缓存字段则按模型 Provider 分成两种
   * 口径（见 `antigravityUsageExcludesCacheFromInput`）：Gemini 的 `input_tokens`
   * 是完整提示规模，Claude 的 `input_tokens` 不含缓存读取。后者必须换成
   * `cache_read_input_tokens` 再交给 `usageChunk`，否则未缓存输入会被算成 0。
   */
  private buildUsageEvent(input: CodingNsCliTurnInput, turn: AntigravityTurnUsage): CodingNsAgentEvent | null {
    if (turn.usage === null) return null
    const modelId = this.resolveModelId(input.modelId)
    const excludesCache = antigravityUsageExcludesCacheFromInput(modelId)
    const event = usageChunk(excludesCache
      ? {
          input_tokens: turn.usage.input_tokens,
          output_tokens: turn.usage.output_tokens,
          cache_read_input_tokens: turn.usage.cache_read_tokens,
          total_tokens: turn.usage.total_tokens,
        }
      : turn.usage)
    if (event === null || event.type !== 'usage') return null
    const contextWindow = this.resolveContextWindow(input.modelId)
    if (contextWindow === undefined || contextWindow <= 0) return event
    // 最后一次模型调用的提示规模就是当前上下文占用；Claude 口径还要补回缓存读取。
    // 退回累计差时没有逐次明细，只能用本轮输入合计近似。
    const contextTokens = (turn.lastInputTokens ?? event.inputTokens)
      + (excludesCache ? (turn.lastCacheReadTokens ?? 0) : 0)
    return {
      ...event,
      contextWindow,
      contextTokens,
      contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)),
    }
  }

  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    // `--input-format stream-json` 本身会进入 AGY 的 print mode；不要再拼接裸
    // `--print`，也不要把 `--input-format` 放在 `--print` 后面，否则 AGY 会把
    // 选项误当成 prompt，或报 `flag needs an argument: -print`。
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions']
    if (input.providerSessionId) args.unshift('--conversation', input.providerSessionId)
    const directories = new Set<string>([input.cwd ?? process.cwd()])
    for (const attachment of input.attachments ?? []) directories.add(dirname(attachment.path))
    for (const directory of directories) args.push('--add-dir', directory)
    if (!isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId!)
    // AGY 按模型校验 --effort 并把它当成 invalid model selection 处理；Claude 系列
    // 完全不支持，旧会话残留的档位不能让整轮失败，这里直接不下发。
    if (input.effortId !== undefined && input.effortId.trim() !== '' && input.effortId !== 'default'
      && antigravitySupportsEffort(this.resolveModelId(input.modelId))) {
      args.push('--effort', input.effortId)
    }
    return args
  }
}

/** 将 AGY 的最终正文快照与前面已发出的增量对齐，避免重复渲染。 */
function appendOrSyncText(current: string, snapshot: string): string {
  if (snapshot === current || current.startsWith(snapshot) || current.trim() === snapshot.trim() || current.endsWith(snapshot) || current.includes(snapshot.trim())) return ''
  if (snapshot.startsWith(current)) return snapshot.slice(current.length)
  return snapshot
}

/**
 * AGY 的原始用量结构。
 *
 * 字段名保持 CLI 线协议原样，直接交给 `usageChunk` 折算成公共 usage 事件：
 * `input_tokens` 是完整提示规模（缓存读取含在其中），`output_tokens` 含思考。
 */
interface AntigravityUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_tokens: number
  readonly total_tokens: number
}

interface AntigravityTurnState {
  readonly calls: Map<number, AntigravityUsage>
  lastInputTokens: number | undefined
  lastCacheReadTokens: number | undefined
}

/** 一次汇总后的单轮用量，以及最后一次调用用于推导上下文占用的规模。 */
interface AntigravityTurnUsage {
  readonly usage: AntigravityUsage | null
  readonly lastInputTokens: number | undefined
  readonly lastCacheReadTokens: number | undefined
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readAntigravityUsage(value: unknown): AntigravityUsage | null {
  const record = readRecord(value)
  if (record === null) return null
  const input = tokenCount(record.input_tokens)
  const output = tokenCount(record.output_tokens)
  const cacheRead = tokenCount(record.cache_read_tokens)
  const total = tokenCount(record.total_tokens)
  if (input === 0 && output === 0 && cacheRead === 0 && total === 0) return null
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    total_tokens: total > 0 ? total : input + output,
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function sumAntigravityUsage(values: Iterable<AntigravityUsage>): AntigravityUsage | null {
  let found = false
  let input = 0
  let output = 0
  let cacheRead = 0
  let total = 0
  for (const value of values) {
    found = true
    input += value.input_tokens
    output += value.output_tokens
    cacheRead += value.cache_read_tokens
    total += value.total_tokens
  }
  return found
    ? { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, total_tokens: total }
    : null
}

function subtractAntigravityUsage(current: AntigravityUsage, previous: AntigravityUsage): AntigravityUsage {
  // 会话被清空或换到新会话时累计值会回退；此时不给出负数用量，直接采用当前值。
  if (current.input_tokens < previous.input_tokens || current.output_tokens < previous.output_tokens) return current
  return {
    input_tokens: current.input_tokens - previous.input_tokens,
    output_tokens: current.output_tokens - previous.output_tokens,
    cache_read_tokens: Math.max(0, current.cache_read_tokens - previous.cache_read_tokens),
    total_tokens: Math.max(0, current.total_tokens - previous.total_tokens),
  }
}

function readConversationId(result: Record<string, unknown>, input: CodingNsCliTurnInput): string {
  const value = result.conversation_id ?? result.conversationId
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return input.providerSessionId?.trim() || input.sessionId
}
