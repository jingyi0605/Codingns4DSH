import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { CodingNsAgentEvent, CodingNsAgentPermissionResponse, CodingNsAgentToolEvent, CodingNsCliAdapterDescriptor, CodingNsCliModelCatalog, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { AcpCliDriver } from './acp-cli-driver.js'
import { JsonRpcRequestError, type JsonRpcProcess } from './json-rpc-process.js'
import { StandardStreamDriver, emptyCatalog, genericEventChunks } from './standard-stream-driver.js'
import { ANTIGRAVITY_CATALOG, antigravitySupportsEffort, isProviderDefaultModel, knownAntigravityContextWindow, parseAntigravityModels, resolveAntigravityEffort, resolveAntigravityModelId } from './model-catalog.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'
import { startMagpieSessionProxy } from './magpie-session-proxy.js'
import { commandEnvironment, runAsyncCommand, terminateChildProcess, withCommandSignal, type CodingNsChildProcess } from './process-utils.js'
import { isRecord, usageChunk } from './rpc-driver-utils.js'
import { advanceCodingNsSegment, createCodingNsSegmentState, decorateCodingNsSegmentEvent } from './stream-normalizer.js'
import { normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { AntigravityAutoUpdater, antigravityCommandEnvironment, spawnAntigravity } from './antigravity-updater.js'
import { readAntigravityToolDetail, type AntigravityToolDetailRequest, type AntigravityToolDetail } from './antigravity-tool-detail.js'

const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 30_000

/** 进程内保留的会话级累计用量基线数量上限，避免长驻 Host 无限增长。 */
const ANTIGRAVITY_CUMULATIVE_LIMIT = 256

/** 仅在本轮 Host 调用内传递，不进入共享协议或持久化会话。 */
interface AntigravityTurnInput extends CodingNsCliTurnInput {
  readonly magpieSettings?: string
  /** 图片回合走 ACP 时，普通文件附件所在目录；图片已内联，不需要目录授权。 */
  readonly acpAddDirectories?: readonly string[]
}

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
  args: readonly string[],
  environment: Record<string, string | undefined>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Antigravity 模型目录探测已取消'))
      return
    }
    let child: CodingNsChildProcess
    try {
      child = spawnAntigravity(runSpawn, command, args, {
        env: antigravityCommandEnvironment(environment),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
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
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `Antigravity CLI exited with code ${String(code)}`))
    }))
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function acpModelMatches(state: unknown, model: string): boolean | undefined {
  if (!isRecord(state)) return undefined
  const currentIds: string[] = []
  if (isRecord(state.models) && typeof state.models.currentModelId === 'string') currentIds.push(state.models.currentModelId)
  if (Array.isArray(state.configOptions)) {
    for (const option of state.configOptions) {
      if (isRecord(option) && option.id === 'model' && typeof option.currentValue === 'string') currentIds.push(option.currentValue)
    }
  }
  return currentIds.length === 0 ? undefined : currentIds.every(id => id === model)
}

export interface AntigravityDriverOptions {
  /** 原生调用详情只读来源；测试可注入独立数据库，不能使用工具参数中的文件补历史。 */
  readonly readToolDetail?: (request: AntigravityToolDetailRequest) => AntigravityToolDetail | null
  readonly autoUpdater?: Pick<AntigravityAutoUpdater, 'check' | 'dispose'>
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  /** Host 已检测的 Magpie 入口；实时读取以跟随自定义路径的切换，不加载 Shell Profile。 */
  readonly magpieCommand?: () => string | null
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
  /**
   * `provider-default` 实际使用的思考档位。默认读 AGY 设置文件里模型展示名尾部的
   * "(High)" 标注；图片回合走 ACP 时需要显式下发，否则会落到 ACP 自己的默认档位。
   */
  readonly resolveEffort?: () => string | null
}

export class AntigravityDriver extends StandardStreamDriver implements CodingNsCliDriver {
  private readonly observedText = new WeakMap<object, string>()
  private readonly diagnostics = new WeakMap<object, string>()
  protected observeStderr = (chunk: string, input: CodingNsCliTurnInput): void => {
    this.diagnostics.set(input, `${this.diagnostics.get(input) ?? ''}${chunk}`.slice(-16_384))
  }
  /** step_index is unique only within one CLI execution; resumed and concurrent turns need separate scopes. */
  private readonly toolCallScopes = new WeakMap<object, { readonly id: string; readonly settledSteps: Set<number>; readonly pendingInputs: Map<number, CodingNsAgentToolEvent> }>()
  /** 本轮各次模型调用的用量；result 到达时汇总成单轮用量。 */
  private readonly turnUsages = new WeakMap<object, AntigravityTurnState>()
  /** 会话级累计用量基线；AGY 的 result.usage 是整个会话的累计值。 */
  private readonly cumulativeUsages = new Map<string, AntigravityUsage>()
  private readonly resolveContextWindow: (modelId: string | undefined) => number | undefined
  private readonly resolveModelId: (modelId: string | undefined) => string | null
  private readonly modelProbeAbort = new AbortController()
  private readonly magpieCommand: () => string | null
  private readonly autoUpdater: Pick<AntigravityAutoUpdater, 'check' | 'dispose'>
  private readonly resolveEffort: () => string | null
  private readonly acp: AcpCliDriver
  private readonly readToolDetail: (request: AntigravityToolDetailRequest) => AntigravityToolDetail | null

  readonly warmModelCatalog = true
  readonly supportsToolStepSplitting = true

  readonly descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'> = {
    id: 'antigravity',
    name: 'Antigravity',
    protocol: 'stream-json',
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'permission'],
  }

  constructor(options: AntigravityDriverOptions = {}) {
    super({
      id: 'antigravity',
      name: 'Antigravity',
      protocol: 'stream-json',
      capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'permission'],
    }, {
      binaries: options.binaries ?? ['agy'],
      versionArgs: ['--version'],
      modelArgs: ['models'],
      resolveWindowsCommand: true,
    }, options)
    this.resolveContextWindow = options.resolveContextWindow ?? ((modelId) => knownAntigravityContextWindow(modelId))
    this.resolveModelId = options.resolveModelId ?? ((modelId) => resolveAntigravityModelId(modelId))
    this.magpieCommand = options.magpieCommand ?? (() => null)
    this.autoUpdater = options.autoUpdater ?? new AntigravityAutoUpdater(this.runSpawn)
    this.resolveEffort = options.resolveEffort ?? (() => resolveAntigravityEffort())
    this.acp = new AcpCliDriver({
      id: 'antigravity',
      name: 'Antigravity',
      binaries: options.binaries ?? ['agy'],
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      resolveWindowsCommand: true,
      ...(options.spawnSync === undefined ? {} : { spawnSync: options.spawnSync }),
      environment: antigravityCommandEnvironment({}),
      args: ['acp'],
      buildArgs: (input) => this.buildAcpArgs(input as AntigravityTurnInput),
      // 模型和思考档位走 ACP 的 config option，不用 session/set_model。
      runtimeModelSelection: false,
      configureSession: (rpc, sessionId, input, openedSession) => this.configureAcpSession(rpc, sessionId, input, openedSession),
      capabilities: ['stream', 'resume', 'interrupt', 'tool-events', 'permission'],
      permissionOptions: 'once',
      readQuestionRequest: () => null,
      decidePermission: (_message, input) => input.permission?.nativeApprovalMode === undefined ? 'reject' : undefined,
      enrichUsage: (usage, input) => {
        if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) {
          const normalized = usageChunk({ ...usage, uncachedInputTokens: usage.inputTokens })
          if (normalized?.type === 'usage') usage = normalized
        }
        if (usage.contextWindow !== undefined) return usage
        const contextWindow = this.resolveContextWindow(input.modelId)
        return contextWindow === undefined ? usage : { ...usage, contextWindow }
      },
    })
    this.readToolDetail = options.readToolDetail ?? readAntigravityToolDetail
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detected = await this.detect()
    if (!detected.installed || detected.command === null) return emptyCatalog()
    this.autoUpdater.check(detected.command, this.resolvedEnvironment ?? commandEnvironment(detected.command))
    try {
      const magpie = await this.readMagpieEnvironment(this.modelProbeAbort.signal)
      // `agy models` 需要向服务端拉取目录；在本机冷启动约 19 秒，
      // 这里沿用 codexhost 的异步缓冲方式，避免同步阻塞 Host 事件循环。
      // --settings 是全局参数，必须放在 models 子命令之前。
      const stdout = await runBufferedModels(
        this.runSpawn,
        detected.command,
        [...(magpie?.settings === undefined ? [] : ['--settings', magpie.settings]), 'models'],
        { ...(this.resolvedEnvironment ?? commandEnvironment(detected.command)), ...magpie?.env },
        ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS,
        this.modelProbeAbort.signal,
      )
      return parseAntigravityModels(stdout)
    } catch {
      return ANTIGRAVITY_CATALOG
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const signal = input.signal === undefined ? this.modelProbeAbort.signal
      : AbortSignal.any([this.modelProbeAbort.signal, input.signal])
    const magpie = await this.readMagpieEnvironment(signal)
    // AGY cannot add request headers itself, so a per-turn loopback proxy tags
    // its Magpie requests with the DSH session ID. Without it Magpie records
    // them with no session and the usage panel can never match them.
    // Falls back to the direct gateway URL when the proxy cannot start.
    const proxy = magpie === null ? null : await startMagpieSessionProxy(magpie.env.GOOGLE_GEMINI_BASE_URL!, input.sessionId)
      .catch(() => null)
    try {
      // 与 Magpie 的 Shell 包装器一致：显式 --model 优先，否则跟随其当前模型。
      // 凭据只留在本轮子进程环境，不修改宿主环境、会话配置或 Client 返回值。
      const prepared: AntigravityTurnInput = magpie === null ? { ...input, signal } : {
        ...input,
        signal,
        modelId: isProviderDefaultModel(input.modelId) ? magpie.model : input.modelId!,
        runtimeEnv: { ...magpie.env, ...(proxy === null ? {} : { GOOGLE_GEMINI_BASE_URL: proxy.baseUrl }), ...input.runtimeEnv },
        ...(magpie.settings === undefined ? {} : { magpieSettings: magpie.settings }),
      }
      const nativeMode = prepared.permission?.nativeApprovalMode
      if ((nativeMode !== undefined && nativeMode !== 'full-access') || prepared.attachments?.some(attachment => attachment.kind === 'image')) {
        yield* this.executeAcpTurn(prepared)
        return
      }
      const scope = { id: randomUUID(), settledSteps: new Set<number>(), pendingInputs: new Map<number, CodingNsAgentToolEvent>() }
      this.toolCallScopes.set(prepared, scope)
      try {
        for await (const event of super.executeTurn(prepared)) {
          if (event.type === 'finish') {
            for (const pending of scope.pendingInputs.values()) yield pending
            scope.pendingInputs.clear()
          }
          yield event
        }
      } catch (error) {
        for (const pending of scope.pendingInputs.values()) yield pending
        throw error
      } finally {
        this.toolCallScopes.delete(prepared)
        this.observedText.delete(prepared)
        this.turnUsages.delete(prepared)
        this.diagnostics.delete(prepared)
      }
    } finally {
      await proxy?.close()
    }
  }

  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    this.acp.respondPermission(sessionId, response)
  }

  private async *executeAcpTurn(input: AntigravityTurnInput): AsyncGenerator<CodingNsAgentEvent> {
    const { command } = this.resolvedBinary === null ? await this.detect() : { command: this.resolvedBinary }
    if (command !== null) this.autoUpdater.check(command, this.resolvedEnvironment ?? commandEnvironment(command))
    const attachments = input.attachments ?? []
    // 图片内联；普通文件保持与 stream-json 相同的 @路径 引用，避免改变文件读取行为。
    const prompt = promptWithAttachmentPaths(input.prompt, attachments.filter((attachment) => attachment.kind !== 'image'), input.translationLanguage)
    const acpInput: AntigravityTurnInput = {
      ...input,
      prompt,
      attachments: attachments.filter((attachment) => attachment.kind === 'image'),
      acpAddDirectories: [...new Set(attachments.filter((attachment) => attachment.kind !== 'image').map((attachment) => dirname(attachment.path)))],
    }
    try {
      for await (const event of this.acp.executeTurn(acpInput)) {
        if (event.type === 'session-binding') this.validateProviderSessionBinding(acpInput, event.providerSessionId)
        yield event
      }
    } finally {
      // Agy ACP 进程带完整 Language Server，只为这一回合借用，不留常驻进程。
      this.acp.closeSession(input.sessionId)
    }
  }

  private buildAcpArgs(input: AntigravityTurnInput): readonly string[] {
    const args: string[] = []
    if (input.magpieSettings !== undefined) args.push('--settings', input.magpieSettings)
    args.push('acp')
    if (antigravityPermissionMode(input.permission) === null) args.push('--dangerously-skip-permissions')
    // 图片已内联；这里只让 Agy 能读到同一回合里的普通文件附件。
    for (const directory of input.acpAddDirectories ?? []) args.push('--add-dir', directory)
    return args
  }

  /** 把 DSH 选择的模型、思考档位和权限模式写进 ACP 会话；失败必须让本轮报错，不能悄悄换模型。 */
  private async configureAcpSession(rpc: JsonRpcProcess, sessionId: string, input: CodingNsCliTurnInput, openedSession: unknown): Promise<void> {
    const explicit = !isProviderDefaultModel(input.modelId)
    const model = explicit ? input.modelId!.trim() : this.resolveModelId(undefined)
    if (model !== null) {
      try {
        const configured = await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: model }, { signal: input.signal, killOnAbort: false })
        if (acpModelMatches(configured, model) === false) throw new Error(`Antigravity ACP did not select model ${model}`)
      } catch (error) {
        if (!(error instanceof JsonRpcRequestError && error.code === -32602)) throw error
        if (acpModelMatches(openedSession, model) !== true) {
          throw new Error(`Antigravity ACP rejected model ${model} and could not confirm it as the current session model: ${error.message}`, { cause: error })
        }
      }
    }
    const requested = explicit ? input.effortId?.trim() : this.resolveEffort() ?? undefined
    const effort = requested !== undefined && requested !== '' && requested !== 'default' ? requested : undefined
    // 与 buildArgs 一致：Claude 系列不支持思考档位，旧会话残留的档位不能下发。
    if (effort !== undefined && antigravitySupportsEffort(model)) {
      await rpc.request('session/set_config_option', { sessionId, configId: 'thought_level', value: effort }, { signal: input.signal, killOnAbort: false })
    }
    const mode = antigravityPermissionMode(input.permission)
    if (mode === null) return
    try {
      await rpc.request('session/set_mode', { sessionId, modeId: mode }, { signal: input.signal, killOnAbort: false })
    } catch (error) {
      if (mode !== 'auto' || !(error instanceof JsonRpcRequestError)) throw error
      throw Object.assign(new Error(`Antigravity 无法启用自动审查。请检查 agy 版本、账号和终端沙箱，或选择“人工审批”。${error.message}`, { cause: error }), { code: 'AGY_AUTO_MODE_UNAVAILABLE' })
    }
  }

  private async readMagpieEnvironment(signal: AbortSignal): Promise<{
    readonly model: string
    readonly env: Readonly<Record<string, string>>
    readonly settings?: string
  } | null> {
    signal.throwIfAborted()
    const command = this.magpieCommand()
    if (command === null) return null
    try {
      const result = await withCommandSignal(signal, () => runAsyncCommand(this.runSpawnSync, command, ['agy', 'env'], {
        encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
        windowsHide: true, shell: process.platform === 'win32', env: commandEnvironment(command),
      }))
      signal.throwIfAborted()
      if (result.status !== 0) return null
      // env 是 KEY=value 文本，绝不作为 Shell 脚本执行；只接受 AGY 所需字段。
      const values = new Map<string, string>()
      for (const line of result.stdout.split(/\r?\n/u)) {
        const separator = line.indexOf('=')
        if (separator < 1) continue
        const key = line.slice(0, separator)
        if (['model', 'settings', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL'].includes(key)) values.set(key, line.slice(separator + 1))
      }
      const model = values.get('model')?.trim()
      const apiKey = values.get('GEMINI_API_KEY')
      const baseUrl = values.get('GOOGLE_GEMINI_BASE_URL')
      if (!model || !apiKey?.trim() || !baseUrl?.trim()) return null
      // Magpie 还通过 settings 文件接入自定义模型；只有环境变量时 AGY
      // 仍会走原生登录检查。只作为 CLI 参数透传，不读取或持久化其内容。
      const settings = values.get('settings')?.trim()
      return { model, env: { GEMINI_API_KEY: apiKey, GOOGLE_GEMINI_BASE_URL: baseUrl }, ...(settings ? { settings } : {}) }
    } catch {
      signal.throwIfAborted()
      // 未配置、旧版不支持或入口不可用时，保留原生 AGY 路径；不转发含凭据的输出。
      return null
    }
  }

  protected get usesStdin(): boolean { return true }

  protected override spawnProcess(command: string, args: readonly string[], options: SpawnOptions): CodingNsChildProcess {
    // Windows 更新由 autoUpdater 自动调用官方 update 入口，业务进程避开 detached 路径。
    this.autoUpdater.check(command, this.resolvedEnvironment ?? commandEnvironment(command))
    return spawnAntigravity(this.runSpawn, command, args, {
      ...options,
      env: antigravityCommandEnvironment(options.env ?? {}),
    })
  }

  dispose(): void {
    this.autoUpdater.dispose()
    this.modelProbeAbort.abort()
    this.cumulativeUsages.clear()
    this.acp.dispose()
    super.dispose()
  }

  protected validateProviderSessionBinding(input: CodingNsCliTurnInput, providerSessionId: string): void {
    const expected = input.providerSessionId?.trim()
    if (expected !== undefined && expected !== '' && expected !== providerSessionId) {
      throw new Error(`Antigravity 恢复会话不一致：期望 ${expected}，实际 ${providerSessionId}`)
    }
  }

  protected writeStdin(child: CodingNsChildProcess, input: CodingNsCliTurnInput): void {
    const prompt = promptWithAttachmentPaths(input.prompt, input.attachments ?? [], input.translationLanguage)
    // Antigravity 的 stream-json 输入协议要求每一轮一个 user 事件，且
    // message 必须是带 content 字符串的对象；直接传字符串会让 AGY 退出。
    if (child.stdin === null) throw new Error('Antigravity CLI 未打开 stdin 管道')
    child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`, 'utf8')
  }

  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    const cancelled = input.signal?.aborted ?? false
    const step = readRecord(value.step_update)
    const result = value.event === 'result' ? readRecord(value.result) : null
    const resultSucceeded = isSuccessStatus(result?.status)
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
      chunks = step.step_type === 'tool'
        ? this.parseToolStep(step, input)
        : genericEventChunks({ ...value, event: sanitized }, cancelled)
      const observation = this.buildPerformanceObservation(input, step)
      if (observation !== null) chunks.unshift(observation)
    } else if (result !== null) {
      // result.usage 是会话累计值，绝不能当作单轮用量交给 DSH；剥掉后由下面的
      // 单轮汇总事件补上，否则 token-meter 会把累计值按轮反复累加。
      const sanitizedResult = { ...result }
      delete sanitizedResult.usage
      // AGY 会把会话库里上一轮遗留的 error 字符串带进后续轮次的 result，即使本轮
      // status 已经是成功。通用解析会把任何 error 字段当成失败，导致已经生成完
      // 的结算文本被一个 finish:error 吞掉。成功态以 status 为准，丢弃陈旧 error。
      if (resultSucceeded) delete sanitizedResult.error
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
      if (!cancelled && status !== '' && !resultSucceeded) {
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
      const reportedCumulative = readAntigravityUsage(result.usage)
      // Parameter/input failures may carry an all-zero usage envelope. It is not
      // evidence that the existing session baseline was reset.
      const cumulative = status !== '' && !resultSucceeded
        && reportedCumulative !== null
        && Object.values(reportedCumulative).every(count => count === 0)
        ? null
        : reportedCumulative
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
    // DONE 仅表示工具步骤结束，不意味着成功；AGY 的拒绝会藏在 tool_info.error，
    // 最终 result 仍可能为 SUCCESS。不要把这类无头审批失败投影为已完成的任务。
    let deniedReason: string | undefined
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!
      if (chunk.type !== 'tool-event' || !chunk.error?.trim()) continue
      chunks[index] = { ...chunk, status: 'failed' }
      if (isAntigravityPermissionDenial(chunk.error)) deniedReason ??= chunk.error
    }
    const diagnostic = this.diagnostics.get(input) ?? ''
    if (deniedReason === undefined) {
      deniedReason = diagnostic.split(/\r?\n/u).find(isAntigravityPermissionDenial)
    }
    if (deniedReason === undefined && !resultSucceeded && typeof result?.error === 'string' && isAntigravityPermissionDenial(result.error)) {
      deniedReason = result.error
    }
    if (!cancelled && deniedReason !== undefined) {
      const failure = {
        code: 'AGY_PERMISSION_DENIED',
        message: `Antigravity 工具审批未通过。agy 无头模式无法把审批请求回传 DSH。请在 DSH 会话中选择“人工审批”，或在交互式 agy 的 /permissions 中检查权限规则。原始原因：${deniedReason.slice(0, 1200)}`,
      }
      chunks = chunks.filter(chunk => chunk.type !== 'finish' && (result === null || chunk.type !== 'text-delta'))
      if (result === null) {
        const turn = this.takeTurnUsage(input, null, input.providerSessionId ?? '')
        const usage = this.buildUsageEvent(input, turn)
        if (usage !== null) chunks.push(usage)
      }
      chunks.push({ type: 'finish', reason: 'error', failure })
      this.observedText.delete(input)
      this.diagnostics.delete(input)
    } else if (result !== null) {
      this.diagnostics.delete(input)
    }
    return chunks
  }

  /**
   * AGY keeps lifecycle state and step_index outside tool_info. A single step
   * can therefore emit ACTIVE, updates, and DONE snapshots without a provider
   * call id. Stabilize those snapshots into one scoped call identity and
   * suppress terminal replays after the step has settled.
   */
  private parseToolStep(step: Record<string, unknown>, input: CodingNsCliTurnInput): CodingNsAgentEvent[] {
    const info = readRecord(step.tool_info) ?? {}
    const name = typeof info.name === 'string' && info.name.trim() !== '' ? info.name : step.tool_name
    const toolName = typeof name === 'string' && name.trim() !== '' ? name.trim() : 'tool'
    const scope = this.toolCallScopes.get(input)
    const index = step.step_index
    const stepIndex = typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? index : undefined
    if (stepIndex !== undefined && scope?.settledSteps.has(stepIndex)) return []
    const callId = scope === undefined || stepIndex === undefined
      ? undefined
      : `antigravity-${scope.id}-step-${stepIndex}`
    const wireParameters = readRecord(info.parameters)
    const native = stepIndex === undefined ? null : this.readToolDetail({
      providerSessionId: readConversationId(step, input), stepIndex, toolName,
      ...(wireParameters === null ? {} : { parameters: wireParameters }),
    })
    const parameters = native?.parameters ?? wireParameters
    const args = parameters === null ? null : { ...parameters }
    if (args !== null) {
      const aliases = toolName === 'run_command' ? { CommandLine: 'command' }
        : toolName === 'write_file' ? { Path: 'file_path', Content: 'content' }
          : toolName === 'edit_file' ? { Path: 'file_path', Target: 'old_string', Replacement: 'new_string' }
            : toolName === 'read_file' ? { Path: 'file_path' }
              : {}
      for (const [source, target] of Object.entries(aliases)) {
        if (args[target] === undefined && args[source] !== undefined) args[target] = args[source]
        delete args[source]
      }
    }
    const serializedInput = serializeToolValue(args ?? info.parameters)
      ?? (stepIndex === undefined ? undefined : scope?.pendingInputs.get(stepIndex)?.input)
    const output = serializeToolValue(info.output)
    const wireStatus = normalizeToolStatus(step.state, 'running')
    const error = serializeToolValue(info.error)
      ?? (wireStatus === 'completed' || wireStatus === 'failed' ? native?.error : undefined)
    const status = error !== undefined ? 'failed' : wireStatus
    const terminal = status === 'completed' || status === 'failed'
    // 原生详情可能已完成，而当前消费到的仍是 ACTIVE；只在 wire 终态发布结果。
    const fullOutput = terminal ? native?.output ?? output : output
    const pendingBody = !terminal && (args === null
      ? stepIndex !== undefined && scope?.pendingInputs.has(stepIndex) === true
      : toolName === 'write_file' && args.content === undefined
        || toolName === 'edit_file' && (args.old_string === undefined || args.new_string === undefined))
    if (stepIndex !== undefined && (status === 'completed' || status === 'failed')) {
      scope?.settledSteps.add(stepIndex)
    }
    const event: CodingNsAgentToolEvent = {
      type: 'tool-event',
      toolName: toolName === 'run_command' ? 'bash' : toolName,
      status,
      ...(callId === undefined ? {} : { callId }),
      ...(serializedInput === undefined ? {} : { input: serializedInput }),
      ...(fullOutput === undefined ? {} : { output: fullOutput, outputMode: 'snapshot' }),
      ...(!terminal || native?.images === undefined ? {} : { outputImages: native.images }),
      ...(error === undefined ? {} : { error }),
    }
    if (stepIndex !== undefined) {
      if (pendingBody) scope?.pendingInputs.set(stepIndex, event)
      else scope?.pendingInputs.delete(stepIndex)
    }
    // 只有路径的开始通知不能把不完整参数固化到原生工具声明；等待终态详情。
    // 提前退出时 executeTurn 会先释放这些真实摘要，再交给现有终态闭合路径。
    if (pendingBody) {
      const { input: _pendingInput, ...pending } = event
      return [pending]
    }
    return [event]
  }

  /** 收下一次模型调用的用量；同一 step_index 重复上报时以后者为准。 */
  private collectStepUsage(input: CodingNsCliTurnInput, step: Record<string, unknown>): void {
    const usage = readAntigravityUsage(step.usage)
    if (usage === null && step.step_type !== 'agent_response') return
    const state = this.turnUsages.get(input) ?? {
      calls: new Map<number, AntigravityUsage>(),
      lastResponseStepIndex: undefined,
    }
    const stepIndex = typeof step.step_index === 'number' && Number.isFinite(step.step_index)
      ? step.step_index
      : state.calls.size
    if (usage !== null) state.calls.set(stepIndex, usage)
    if (step.step_type === 'agent_response'
      && (state.lastResponseStepIndex === undefined || stepIndex >= state.lastResponseStepIndex)) {
      state.lastResponseStepIndex = stepIndex
    }
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
    const lastResponse = state?.lastResponseStepIndex === undefined
      ? undefined
      : state.calls.get(state.lastResponseStepIndex)
    const contextTokens = lastResponse === undefined
      ? undefined
      : lastResponse.input_tokens + lastResponse.cache_read_tokens
    const summed = state === undefined ? null : sumAntigravityUsage(state.calls.values())
    if (summed !== null) return { usage: summed, contextTokens }
    if (cumulative === null) return { usage: null, contextTokens }
    const baseline = this.cumulativeUsages.get(conversationId)
    return {
      // A first observation of a resumed session has no trustworthy baseline.
      usage: baseline === undefined
        ? (input.providerSessionId?.trim() ? null : cumulative)
        : subtractAntigravityUsage(cumulative, baseline),
      contextTokens,
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
   * `output_tokens` 已经包含 `thinking_tokens`。实测（agy 1.5.9）所有模型的
   * `input_tokens` 都只含未缓存输入，缓存命中单独放在 `cache_read_tokens`：Gemini 一次
   * 调用里 `input_tokens=2553`、`cache_read_tokens=7571`，缓存读取大于输入，不可能含在
   * 输入里。因此一律把缓存作为独立桶传给 `usageChunk`，保留未缓存输入和缓存读取的分离口径。
   */
  private buildUsageEvent(input: CodingNsCliTurnInput, turn: AntigravityTurnUsage): CodingNsAgentEvent | null {
    if (turn.usage === null) return null
    const event = usageChunk({
      input_tokens: turn.usage.input_tokens,
      output_tokens: turn.usage.output_tokens,
      cache_read_input_tokens: turn.usage.cache_read_tokens,
      total_tokens: turn.usage.total_tokens,
    })
    if (event === null || event.type !== 'usage') return null
    const contextWindow = this.resolveContextWindow(input.modelId)
    if (contextWindow === undefined || contextWindow <= 0) return event
    // Only the last agent_response provides a defensible current-context size.
    return {
      ...event,
      contextWindow,
      ...(turn.contextTokens === undefined ? {} : {
        contextTokens: turn.contextTokens,
        contextUsageRatio: Number(Math.min(1, turn.contextTokens / contextWindow).toFixed(6)),
      }),
    }
  }

  /**
   * 用 AGY 自己报告的单次模型调用耗时合成吞吐样本。
   *
   * AGY 的 agent_response step 带 `duration_seconds` 和该次调用的 `output_tokens`。DSH 自己
   * 按 usage 到达时间算速度时，外部 Agent 的事件几乎同时落盘，会得出上千万 tok/s 的假数字，
   * 因此必须由驱动提供真实耗时。没有用量、耗时或输出的 step 不产出样本。
   */
  private buildPerformanceObservation(input: CodingNsCliTurnInput, step: Record<string, unknown>): CodingNsAgentEvent | null {
    if (step.step_type !== 'agent_response' || typeof step.state !== 'string' || step.state.trim().toUpperCase() !== 'DONE') return null
    const usage = readAntigravityUsage(step.usage)
    const duration = step.duration_seconds
    if (usage === null || usage.output_tokens <= 0 || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null
    const stepIndex = typeof step.step_index === 'number' && Number.isFinite(step.step_index) ? step.step_index : 0
    const conversationId = readConversationId(step, input)
    const completedAt = this.eventTime()
    const startedAt = completedAt - Math.round(duration * 1000)
    const sample = {
      id: `${conversationId}:${stepIndex}:${completedAt}`,
      startedAt,
      // AGY 不报告首 token 时刻；取调用起点，让整次耗时都算解码时间，首字延迟恒为 0 而不是编造。
      firstTokenAt: startedAt,
      completedAt,
      outputTokens: usage.output_tokens,
    }
    return { type: 'usage-observation', requestPerformance: { adapterId: 'antigravity', id: sample.id, samples: [sample] } }
  }

  protected buildArgs(input: AntigravityTurnInput): readonly string[] {
    // `--input-format stream-json` 本身会进入 AGY 的 print mode；不要再拼接裸
    // `--print`，也不要把 `--input-format` 放在 `--print` 后面，否则 AGY 会把
    // 选项误当成 prompt，或报 `flag needs an argument: -print`。
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', ...antigravityPermissionArgs(input.permission)]
    if (input.providerSessionId) args.unshift('--conversation', input.providerSessionId)
    if (input.magpieSettings !== undefined) args.push('--settings', input.magpieSettings)
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

function antigravityPermissionArgs(permission: CodingNsCliTurnInput['permission']): readonly string[] {
  const mode = antigravityPermissionMode(permission)
  return mode === null ? ['--dangerously-skip-permissions'] : ['--mode', mode]
}

/** 权限模式；返回 null 表示全放行（stream-json 与 ACP 都用 --dangerously-skip-permissions，而不是模式）。 */
function antigravityPermissionMode(permission: CodingNsCliTurnInput['permission']): 'default' | 'plan' | 'auto' | 'accept-edits' | null {
  if (permission?.nativeApprovalMode === 'manual') return 'default'
  if (permission?.nativeApprovalMode === 'read-only') return 'plan'
  if (permission?.nativeApprovalMode === 'auto-review') return 'auto'
  if (permission?.nativeApprovalMode === 'accept-edits') return 'accept-edits'
  if (permission?.sandboxMode === 'danger-full-access' && permission.approvalPolicy === 'never') return null
  if (permission?.sandboxMode === 'workspace-write' && permission.approvalPolicy === 'never') return 'accept-edits'
  return 'plan'
}

function isAntigravityPermissionDenial(text: string): boolean {
  return /permission check failed|user denied permission|soft[- ]denied|soft-denying tool confirmation/iu.test(text)
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
 * 字段名保持 CLI 线协议原样：input 不含缓存读取，output 已含思考，
 * total 为上游 input + output，不强制改成 DSH 所有互斥桶之和。
 */
interface AntigravityUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_tokens: number
  readonly total_tokens: number
}

interface AntigravityTurnState {
  readonly calls: Map<number, AntigravityUsage>
  lastResponseStepIndex: number | undefined
}

/** 一次汇总后的单轮用量，以及最后一次调用用于推导上下文占用的规模。 */
interface AntigravityTurnUsage {
  readonly usage: AntigravityUsage | null
  readonly contextTokens: number | undefined
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

const ANTIGRAVITY_SUCCESS_STATUSES: readonly string[] = ['success', 'succeeded', 'completed', 'complete', 'done']

/** result.status 明确是成功态；缺失或非字符串不算成功，交给原有逻辑处理。 */
function isSuccessStatus(status: unknown): boolean {
  return typeof status === 'string' && ANTIGRAVITY_SUCCESS_STATUSES.includes(status.trim().toLowerCase())
}

function readAntigravityUsage(value: unknown): AntigravityUsage | null {
  const record = readRecord(value)
  if (record === null) return null
  const input = tokenCount(record.input_tokens)
  const output = tokenCount(record.output_tokens)
  const cacheRead = tokenCount(record.cache_read_tokens)
  const total = tokenCount(record.total_tokens)
  // Explicit zero usage is a valid cumulative baseline; only an absent envelope
  // should be treated as missing usage.
  if (![record.input_tokens, record.output_tokens, record.cache_read_tokens, record.total_tokens]
    .some(count => typeof count === 'number' && Number.isFinite(count) && count >= 0)) return null
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    total_tokens: typeof record.total_tokens === 'number' && Number.isFinite(record.total_tokens) && record.total_tokens >= 0
      ? total
      : input + output,
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

function subtractAntigravityUsage(current: AntigravityUsage, previous: AntigravityUsage): AntigravityUsage | null {
  // Any bucket rollback makes the current-turn delta unknowable.
  if (current.input_tokens < previous.input_tokens || current.output_tokens < previous.output_tokens
    || current.cache_read_tokens < previous.cache_read_tokens || current.total_tokens < previous.total_tokens) return null
  return {
    input_tokens: current.input_tokens - previous.input_tokens,
    output_tokens: current.output_tokens - previous.output_tokens,
    cache_read_tokens: current.cache_read_tokens - previous.cache_read_tokens,
    total_tokens: current.total_tokens - previous.total_tokens,
  }
}

function readConversationId(result: Record<string, unknown>, input: CodingNsCliTurnInput): string {
  const value = result.conversation_id ?? result.conversationId
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return input.providerSessionId?.trim() || input.sessionId
}
