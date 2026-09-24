import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliModelCatalog,
  CodingNsAgentEvent,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { usageChunk } from './rpc-driver-utils.js'

const WINDOWS = process.platform === 'win32'

export interface StandardStreamDriverOptions {
  readonly binaries?: readonly string[]
  /** 仅供会话存在性探测使用；测试和自定义安装可覆盖默认存储根目录。 */
  readonly sessionRoots?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  readonly versionArgs?: readonly string[]
  readonly modelArgs?: readonly string[]
}

/**
 * 把采用 JSONL/stream-json 的 CLI 统一成 CodingNS 的最小驱动契约。
 * 子类只需提供命令参数和事件映射，进程终止、stderr 消费及清理由这里统一处理。
 */
export abstract class StandardStreamDriver implements CodingNsCliDriver {
  readonly descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>
  protected readonly binaries: readonly string[]
  protected readonly runSpawnSync: typeof spawnSync
  protected readonly runSpawn: typeof spawn
  private readonly versionArgs: readonly string[]
  private readonly modelArgs: readonly string[]
  private cachedBinary: string | null = null
  private readonly processes = new Set<ChildProcessWithoutNullStreams>()

  protected constructor(
    descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>,
    defaults: { binaries: readonly string[]; versionArgs?: readonly string[]; modelArgs?: readonly string[] },
    options: StandardStreamDriverOptions = {},
  ) {
    this.descriptor = descriptor
    this.binaries = options.binaries ?? defaults.binaries
    this.versionArgs = options.versionArgs ?? defaults.versionArgs ?? ['--version']
    this.modelArgs = options.modelArgs ?? defaults.modelArgs ?? ['--help']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    for (const command of this.binaries) {
      try {
        const result = this.runSpawnSync(command, this.versionArgs, { encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: WINDOWS })
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
        const version = this.parseVersion(output)
        if (result.status === 0 && version !== null) {
          this.cachedBinary = command
          return { installed: true, version, command }
        }
      } catch {
        // 候选命令不存在时继续尝试下一个名称。
      }
    }
    return { installed: false, version: null, command: null }
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) return emptyCatalog()
    try {
      const result = this.runSpawnSync(command, this.modelArgs, { encoding: 'utf8', timeout: 12_000, windowsHide: true, shell: WINDOWS })
      if (result.status !== 0) return emptyCatalog()
      return this.parseModels(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    } catch {
      return emptyCatalog()
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error(`${this.descriptor.name} 未安装`)
    const child = this.runSpawn(command, this.buildArgs(input), {
      cwd: input.cwd ?? process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: WINDOWS,
    })
    this.processes.add(child)
    let emittedFinish = false
    let emittedBinding = input.providerSessionId !== undefined
    const onAbort = (): void => { try { child.kill('SIGTERM') } catch { /* 进程可能已退出 */ } }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    child.stderr.on('data', () => undefined)
    try {
      const lines = readline.createInterface({ input: child.stdout })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          const parsed = parseJson(line)
          if (parsed === null) continue
          if (!emittedBinding) {
            const providerSessionId = typeof parsed.session_id === 'string'
              ? parsed.session_id
              : typeof parsed.sessionId === 'string'
                ? parsed.sessionId
                : null
            if (providerSessionId !== null && providerSessionId.trim() !== '') {
              emittedBinding = true
              yield { type: 'session-binding', providerSessionId: providerSessionId.trim() }
            }
          }
          for (const chunk of this.parseEvent(parsed, input)) {
            if (chunk.type === 'finish') emittedFinish = true
            yield chunk
          }
        }
      } finally { lines.close() }
      if (!emittedFinish) {
        if (input.signal?.aborted) yield { type: 'finish', reason: 'cancel' }
        else throw new Error(`${this.descriptor.name} 执行失败`)
      }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      this.processes.delete(child)
      try { child.kill('SIGTERM') } catch { /* 正常退出 */ }
    }
  }

  dispose(): void {
    for (const child of this.processes) { try { child.kill('SIGTERM') } catch { /* 进程可能已退出 */ } }
    this.processes.clear()
    this.cachedBinary = null
  }

  protected parseVersion(output: string): string | null { return output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0] ?? null }
  protected abstract buildArgs(input: CodingNsCliTurnInput): readonly string[]
  protected parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    return genericEventChunks(value, input.signal?.aborted ?? false)
  }
  protected parseModels(output: string): CodingNsCliModelCatalog { return parseHelpModels(output) }
}

export function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }

function parseJson(line: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(line); return isRecord(value) ? value : null } catch { return null } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function genericEventChunks(value: Record<string, unknown>, cancelled: boolean): CodingNsAgentEvent[] {
  const chunks: CodingNsAgentEvent[] = []
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : ''
  const event = isRecord(value.event) ? value.event : value
  const eventType = typeof event.type === 'string' ? event.type.toLowerCase() : type
  if (eventType.includes('think') || eventType.includes('reason')) {
    const delta = isRecord(event.delta) ? event.delta : event
    const reasoning = typeof event.delta === 'string' ? event.delta : typeof delta.text === 'string' ? delta.text : typeof delta.content === 'string' ? delta.content : null
    if (reasoning) chunks.push({ type: 'reasoning-delta', text: reasoning })
  } else {
    const delta = isRecord(event.delta) ? event.delta : event
    const text = typeof event.delta === 'string' ? event.delta : typeof delta.text === 'string' ? delta.text : typeof delta.content === 'string' ? delta.content : null
    if (text !== null && text.length > 0 && !['result', 'final', 'error'].includes(eventType)) chunks.push({ type: 'text-delta', text })
    const message = isRecord(event.message) ? event.message : null
    const messageContent = message === null ? null : typeof message.content === 'string' ? message.content : null
    if (messageContent) chunks.push({ type: 'text-delta', text: messageContent })
  }
  const nestedTool = isToolRecord(event.tool_call) ? event.tool_call : isToolRecord(event.toolCall) ? event.toolCall : isToolRecord(event.function) ? event.function : event
  const toolName = firstToolText(nestedTool.toolName, nestedTool.tool_name, nestedTool.name)
  const callId = firstToolText(nestedTool.callId, nestedTool.call_id, nestedTool.toolCallId, nestedTool.tool_call_id, nestedTool.toolUseId, nestedTool.tool_use_id, nestedTool.id, event.tool_call_id, event.tool_use_id)
  if ((toolName || callId) && (eventType.includes('tool') || eventType.includes('function') || eventType.includes('command'))) {
    const input = serializeToolValue(nestedTool.input ?? nestedTool.arguments ?? nestedTool.args ?? nestedTool.parameters)
    const output = serializeToolValue(nestedTool.output ?? nestedTool.result)
    const error = serializeToolValue(nestedTool.error)
    const fallback = error !== undefined || eventType.includes('error') || eventType.includes('fail')
      ? 'failed'
      : output !== undefined || eventType.includes('result') || eventType.includes('complete')
        ? 'completed'
        : 'running'
    chunks.push({
      type: 'tool-event',
      toolName: toolName ?? 'tool',
      status: normalizeToolStatus(nestedTool.status ?? nestedTool.state, fallback),
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(output !== undefined ? { outputMode: eventType.includes('delta') ? 'delta' as const : 'snapshot' as const } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(firstToolText(nestedTool.agentId, nestedTool.agent_id) ? { agentId: firstToolText(nestedTool.agentId, nestedTool.agent_id)! } : {}),
      ...(serializeToolValue(nestedTool.detail) !== undefined ? { detail: serializeToolValue(nestedTool.detail)! } : {}),
    })
  }
  const usage = isRecord(value.usage) ? value.usage : isRecord(event.usage) ? event.usage : null
  const usageEvent = usageChunk(usage)
  if (usageEvent) chunks.push(usageEvent)
  if (['result', 'turn_end', 'done', 'complete', 'completed', 'final'].includes(eventType) || type === 'result') chunks.push({ type: 'finish', reason: cancelled ? 'cancel' : 'stop' })
  return chunks
}

function parseHelpModels(output: string): CodingNsCliModelCatalog {
  const models: Array<{ id: string; name: string; description?: string; efforts: readonly string[] }> = []
  const seen = new Set<string>()
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/(?:--model(?:=|\s+)|model(?:s)?\s*:\s*)([A-Za-z0-9][A-Za-z0-9_./:-]{2,})/iu)
    const id = match?.[1]
    if (!id || /^(?:model|models|string|value)$/iu.test(id) || seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: id, efforts: [] })
  }
  return models.length === 0 ? emptyCatalog() : { groups: [{ id: 'default', name: '可用模型', models }], currentModel: null, currentEffort: null }
}
