import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import type {
  CodingNsCliModelCatalog,
  CodingNsAgentEvent,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { firstToolText, serializeToolValue } from './tool-observation.js'

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

export interface CommandCodeDriverOptions {
  readonly homeDirectory?: string
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/**
 * Command Code 驱动：沿用附件中的 `--session + -p + --output-format json` 方式。
 * 它只负责 CLI 进程和事件转换，不把 Command Code 私有事件泄漏给上层。
 */
export class CommandCodeDriver implements CodingNsCliDriver {
  readonly descriptor = {
    id: 'command-code',
    name: 'Command Code',
    protocol: 'command',
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] as const,
  } as const
  private readonly homeDirectory: string
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private cachedBinary: string | null = null
  private readonly processes = new Set<ChildProcessWithoutNullStreams>()

  constructor(options: CommandCodeDriverOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? join(homedir(), '.commandcode')
    this.binaries = options.binaries ?? COMMAND_CODE_BINARIES
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    for (const command of this.binaries) {
      try {
        const result = this.runSpawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3_000, windowsHide: true, shell: WINDOWS })
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
        const version = output.match(/\d+\.\d+\.\d+/u)?.[0] ?? null
        if (result.status === 0 && version !== null) {
          this.cachedBinary = command
          return { installed: true, version, command }
        }
      } catch {
        // PATH 中不存在候选命令属于正常的未安装状态。
      }
    }
    return { installed: false, version: null, command: null }
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detection = await this.detect()
    if (!detection.installed || detection.command === null) return emptyCatalog()
    let stdout = ''
    try {
      const result = this.runSpawnSync(detection.command, ['--list-models'], { encoding: 'utf8', timeout: 12_000, windowsHide: true, shell: WINDOWS })
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

    const transcriptPath = join(tmpdir(), `dsh-codingns-cc-${safeId(input.sessionId)}.jsonl`)
    writeTranscript(transcriptPath, input)
    const args = ['--session', transcriptPath, '-p', input.prompt, '--output-format', 'json', '--tools-all', '--yolo']
    if (input.modelId) args.push('-m', input.modelId)
    if (input.effortId && input.effortId !== 'default' && input.effortId !== 'Default') args.push('--effort', input.effortId)

    const child = this.runSpawn(binary, args, { cwd: input.cwd ?? process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: WINDOWS })
    this.processes.add(child)
    let finished = false
    const onAbort = (): void => { try { child.kill('SIGTERM') } catch { /* 进程可能已退出 */ } }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    // 必须消费 stderr，错误内容不能回传给 DSH，避免泄露命令参数或文件片段。
    child.stderr.on('data', () => undefined)

    try {
      const lines = readline.createInterface({ input: child.stdout })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          const item = parseJson(line)
          if (item === null) continue
          const event = item.type === 'event' && isRecord(item.event) ? item.event : item
          const eventType = textValue(event.type).toLowerCase()
          const chunks = commandCodeEventChunks(event, input.signal?.aborted ?? false)
          for (const chunk of chunks) {
            if (chunk.type === 'finish') finished = true
            yield chunk
          }
          if (eventType === 'result' && !finished) finished = true
        }
      } finally {
        lines.close()
      }
      if (!finished) {
        if (input.signal?.aborted) yield { type: 'finish', reason: 'cancel' }
        else throw new Error('Command Code 执行失败')
      }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      this.processes.delete(child)
      try { child.kill('SIGTERM') } catch { /* 正常退出 */ }
      try { rmSync(transcriptPath, { force: true }) } catch { /* 临时文件清理尽力而为 */ }
    }
  }

  dispose(): void {
    for (const child of this.processes) { try { child.kill('SIGTERM') } catch { /* 进程可能已退出 */ } }
    this.processes.clear()
    this.cachedBinary = null
  }
}

function commandCodeEventChunks(event: Record<string, unknown>, cancelled: boolean): CodingNsAgentEvent[] {
  const chunks: CodingNsAgentEvent[] = []
  const type = textValue(event.type).trim().toLowerCase()
  const sessionId = textValue(event.sessionId ?? event.session_id ?? recordValue(event.session)?.id ?? recordValue(event.result)?.sessionId).trim()
  if (sessionId) chunks.push({ type: 'session-binding', providerSessionId: sessionId })

  if (type === 'thinking_delta' || type === 'thinking-delta') {
    const text = textValue(event.delta ?? event.thinking ?? event.content)
    if (text) chunks.push({ type: 'reasoning-delta', text })
  } else if (type === 'text_delta' || type === 'text-delta') {
    const text = textValue(event.delta ?? event.text ?? event.content)
    if (text) chunks.push({ type: 'text-delta', text })
  } else if (type === 'message' || type === 'message_update' || type === 'message-update') {
    appendMessageSnapshots(chunks, event)
  }

  if (isToolStart(type)) {
    const tool = readToolChunk(event, type === 'tool_queued' || type === 'tool_started' ? 'started' : 'running')
    if (tool !== null) chunks.push(tool)
  } else if (isToolResult(type)) {
    const tool = readToolChunk(event, type.includes('error') || type.includes('fail') || type.includes('denied') ? 'failed' : 'completed')
    if (tool !== null) chunks.push(tool)
  }

  const usage = recordValue(event.usage)
  if (usage !== null) chunks.push(usageChunk(usage))
  if (type === 'result') {
    const result = recordValue(event.result)
    const finalText = textValue(event.finalText ?? result?.finalText ?? (typeof event.result === 'string' ? event.result : undefined) ?? event.output ?? event.text)
    if (finalText) chunks.push({ type: 'text-snapshot', text: finalText })
    chunks.push({ type: 'finish', reason: cancelled ? 'cancel' : 'stop' })
  }
  return chunks
}

function appendMessageSnapshots(chunks: CodingNsAgentEvent[], event: Record<string, unknown>): void {
  const payload = recordValue(event.message ?? event.data) ?? event
  if (Array.isArray(payload.content)) {
    const snapshots = new Map<'reasoning' | 'text', string[]>()
    for (const block of payload.content) {
      const value = recordValue(block)
      if (value === null) continue
      const blockType = textValue(value.type).toLowerCase()
      const channel = blockType.includes('thinking') || blockType.includes('reasoning') ? 'reasoning' : 'text'
      const text = channel === 'reasoning'
        ? textValue(value.thinking ?? value.reasoning ?? value.text ?? value.content)
        : textValue(value.text ?? value.content)
      if (!text) continue
      const values = snapshots.get(channel) ?? []
      values.push(text)
      snapshots.set(channel, values)
    }
    for (const [channel, values] of snapshots) chunks.push({ type: `${channel}-snapshot`, text: values.join('') })
    return
  }
  const reasoning = textValue(payload.thinking ?? payload.reasoning)
  if (reasoning) chunks.push({ type: 'reasoning-snapshot', text: reasoning })
  const text = textValue(payload.text ?? payload.content ?? event.text ?? event.content)
  if (text) chunks.push({ type: 'text-snapshot', text })
}

function readToolChunk(event: Record<string, unknown>, status: 'started' | 'running' | 'completed' | 'failed'): CodingNsAgentEvent | null {
  const callId = textValue(event.callId ?? event.call_id ?? event.toolUseId ?? event.tool_use_id ?? event.id)
  const fn = recordValue(event.function)
  const toolName = textValue(event.name ?? event.toolName ?? event.tool ?? fn?.name) || 'tool'
  const error = textValue(event.error ?? event.reason)
  const output = textValue(event.output ?? event.result ?? event.content)
  const input = event.input ?? fn?.arguments ?? event.arguments
  const agentId = firstToolText(event.agentId, event.agent_id)
  const detail = serializeToolValue(event.detail ?? event.metadata)
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
  return ['tool_completed', 'tool_result', 'tool_return', 'tool_failed', 'tool_error', 'tool_denied', 'function_result'].includes(type)
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
function usageChunk(value: Record<string, unknown>): CodingNsAgentEvent { return { type: 'usage', inputTokens: numberValue(value.inputTokens), outputTokens: numberValue(value.outputTokens) } }
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 96) || 'default' }
function parseJson(value: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : null } catch { return null } }
function readJson(path: string): Record<string, unknown> | null { if (!existsSync(path)) return null; try { const parsed: unknown = JSON.parse(readFileSync(path, 'utf8')); return isRecord(parsed) ? parsed : null } catch { return null } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }
