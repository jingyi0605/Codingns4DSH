import { spawn, spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import type { CodingNsAgentEvent, CodingNsCliAdapterDescriptor, CodingNsCliModelCatalog, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { StandardStreamDriver, emptyCatalog, genericEventChunks } from './standard-stream-driver.js'
import { ANTIGRAVITY_CATALOG, isProviderDefaultModel, parseAntigravityModels } from './model-catalog.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'
import { terminateChildProcess, type CodingNsChildProcess } from './process-utils.js'
import { advanceCodingNsSegment, createCodingNsSegmentState, decorateCodingNsSegmentEvent } from './stream-normalizer.js'

const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 30_000

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
}

/**
 * Antigravity 的 stream-json print 模式：输入从 stdin 以 NDJSON 写入，输出仍是
 * 逐行 JSON。它只有全放行权限模式，因此故意不声明 permission/questions。
 */
export class AntigravityDriver extends StandardStreamDriver implements CodingNsCliDriver {
  private readonly observedText = new WeakMap<object, string>()
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
    // AGY 会在 step_update 和最终 result 中重复携带 usage；只保留最终 result
    // 的汇总，避免 DSH 面板把同一轮用量累计两次。
    const step = value.step_update
    let chunks: CodingNsAgentEvent[]
    if (value.event === 'step_update' && step !== null && typeof step === 'object' && !Array.isArray(step)) {
      const sanitized = { ...(step as Record<string, unknown>) }
      delete sanitized.usage
      // AGY 把真实事件类型放在 step_update.step_type，而外层 event 永远是
      // step_update。把它提升成 genericEventChunks 能识别的 type，才能保留
      // agent_response 正文和 tool 生命周期。
      if (typeof sanitized.step_type === 'string' && sanitized.step_type.trim() !== '') {
        sanitized.type = sanitized.step_type
      }
      chunks = genericEventChunks({ ...value, event: sanitized }, input.signal?.aborted ?? false)
    } else {
      chunks = genericEventChunks(value, input.signal?.aborted ?? false)
    }
    const currentText = this.observedText.get(input) ?? ''
    let observedText = currentText
    for (const chunk of chunks) {
      if (chunk.type === 'text-delta') observedText += chunk.text
    }
    if (observedText !== currentText) this.observedText.set(input, observedText)
    // AGY 的最终 result 可能只在 response 中携带完整正文，不能依赖前面的
    // step_update 一定包含 agent_response 增量。
    if (value.event === 'result' && value.result !== null && typeof value.result === 'object' && !Array.isArray(value.result)) {
      const result = value.result as Record<string, unknown>
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
      this.observedText.delete(input)
    }
    return chunks
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
    if (input.effortId !== undefined && input.effortId.trim() !== '' && input.effortId !== 'default') {
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
