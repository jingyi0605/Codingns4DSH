import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import type {
  CodingNsCliModelCatalog,
  CodingNsCliStreamChunk,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'

const WINDOWS = process.platform === 'win32'
const COMMAND_CODE_BINARIES = WINDOWS
  ? ['command-code', 'commandcode', 'cmdc']
  : ['command-code', 'commandcode', 'cmdc', 'cmd']
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const CATALOG_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['deepseek/deepseek-v4-pro', ['high', 'max']],
  ['deepseek/deepseek-v4-flash', ['high', 'max']],
  ['deepseek/deepseek-v4-flash-fast', ['low', 'high', 'max']],
  ['moonshotai/kimi-k3', ['low', 'high', 'max']],
  ['z-ai/glm-5.3-flash', ['low', 'high', 'max']],
  ['zai-org/glm-5.3', ['low', 'high', 'max']],
  ['zai-org/glm-5.2', ['high', 'max']],
  ['minimaxai/minimax-m3', ['low', 'medium', 'high']],
  ['qwen/qwen3.8-max', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-flash', ['low', 'medium', 'xhigh']],
  ['tencent/hy4-preview', ['low', 'medium', 'high']],
  ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.5', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh']],
  ['google/gemini-3.8-flash', ['low', 'medium', 'high']],
  ['xai/grok-4.6', ['low', 'medium', 'high', 'xhigh']],
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
  readonly descriptor = { id: 'command-code', name: 'Command Code' } as const
  private readonly homeDirectory: string
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private cachedBinary: string | null = null
  private cachedModels: CodingNsCliModelCatalog | null = null
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
    if (this.cachedModels !== null) return this.cachedModels
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
    if (groups.length > 0) this.cachedModels = result
    return result
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk> {
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
          if (item?.type === 'event' && isRecord(item.event)) {
            const event = item.event
            if (event.type === 'thinking_delta' && typeof event.delta === 'string' && event.delta) yield { type: 'reasoning-delta', text: event.delta }
            else if (event.type === 'text_delta' && typeof event.delta === 'string' && event.delta) yield { type: 'text-delta', text: event.delta }
            else if (event.type === 'tool_running' && typeof event.toolName === 'string' && event.toolName) yield { type: 'tool-running', toolName: event.toolName }
            else if (event.type === 'turn_end' && isRecord(event.usage)) yield usageChunk(event.usage)
          } else if (item?.type === 'result') {
            if (isRecord(item.usage)) yield usageChunk(item.usage)
            finished = true
            yield { type: 'finish', reason: input.signal?.aborted ? 'cancel' : 'stop' }
          }
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
    this.cachedModels = null
    this.cachedBinary = null
  }
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
function usageChunk(value: Record<string, unknown>): CodingNsCliStreamChunk { return { type: 'usage', inputTokens: numberValue(value.inputTokens), outputTokens: numberValue(value.outputTokens) } }
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 96) || 'default' }
function parseJson(value: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : null } catch { return null } }
function readJson(path: string): Record<string, unknown> | null { if (!existsSync(path)) return null; try { const parsed: unknown = JSON.parse(readFileSync(path, 'utf8')); return isRecord(parsed) ? parsed : null } catch { return null } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }
