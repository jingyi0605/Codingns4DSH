import readline from 'node:readline'
import type { CodingNsCliStreamChunk, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { KIMI_CATALOG, enrichEfforts, isProviderDefaultModel } from './model-catalog.js'

/** Kimi 的 wire 协议优先，旧版 CLI 不支持时自动回退 stream-json。 */
export class KimiCliDriver extends StandardStreamDriver {
  private legacySyntax = false

  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'kimi', name: 'Kimi CLI', protocol: 'stream-json', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'steer'] }, { binaries: ['kimi', 'kimi-cli'] }, options)
  }

  async listModels() {
    if (!(await this.detect()).installed) return emptyCatalog()
    const catalog = await super.listModels()
    return catalog.groups.length > 0 ? enrichEfforts(catalog, KIMI_CATALOG) : KIMI_CATALOG
  }

  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json']
    if (input.providerSessionId) args.push(this.legacySyntax ? '--resume' : '--session', input.providerSessionId)
    if (this.legacySyntax) {
      if (input.cwd) args.push('--cwd', input.cwd)
    } else if (input.cwd) args.push('--work-dir', input.cwd)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    return args
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk> {
    try {
      yield* this.executeWireTurn(input)
      return
    } catch {
      if (input.signal?.aborted) {
        yield { type: 'finish', reason: 'cancel' }
        return
      }
      for await (const chunk of super.executeTurn(input)) yield chunk
    }
  }

  private async *executeWireTurn(input: CodingNsCliTurnInput): AsyncGenerator<CodingNsCliStreamChunk> {
    const detection = await this.detect()
    const command = detection.command
    if (command === null) throw new Error('Kimi CLI 未安装')
    this.detectSyntax(command)
    const args = this.legacySyntax ? ['wire', '--output-format', 'stream-json'] : ['--wire']
    if (input.providerSessionId) args.push(this.legacySyntax ? '--resume' : '--session', input.providerSessionId)
    else if (this.legacySyntax) args.push('--new-session')
    if (input.cwd) args.push(this.legacySyntax ? '--cwd' : '--work-dir', input.cwd)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    const child = this.runSpawn(command, args, {
      cwd: input.cwd ?? process.cwd(), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32',
    })
    let finished = false
    let sawProtocol = false
    const onAbort = (): void => { try { child.kill('SIGTERM') } catch { /* 进程可能已经退出 */ } }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    child.stderr.on('data', () => undefined)
    try {
      const payload: Record<string, unknown> = {
        type: 'prompt.submit', content: input.prompt,
        ...(input.providerSessionId ? { session_id: input.providerSessionId } : {}),
        ...(input.modelId ? { model: input.modelId } : {}),
      }
      ;(child as unknown as { stdin: { write(data: string): void } }).stdin.write(`${JSON.stringify(payload)}\n`)
      const lines = readline.createInterface({ input: child.stdout })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          let value: unknown
          try { value = JSON.parse(line) } catch { continue }
          if (!isRecord(value)) continue
          const result = mapKimiWireEvent(value, input.signal?.aborted ?? false)
          if (result.protocol) sawProtocol = true
          if (result.error) throw new Error('Kimi wire 请求失败')
          for (const chunk of result.chunks) {
            if (chunk.type === 'finish') finished = true
            yield chunk
          }
          if (finished) break
        }
      } finally { lines.close() }
      if (input.signal?.aborted) {
        if (!finished) yield { type: 'finish', reason: 'cancel' }
        return
      }
      if (!finished) throw new Error(sawProtocol ? 'Kimi wire 未返回完成事件' : 'Kimi wire 不可用')
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      try { child.kill('SIGTERM') } catch { /* 进程可能已经退出 */ }
    }
  }

  private detectSyntax(command: string): void {
    try {
      const result = this.runSpawnSync(command, ['--help'], { encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: process.platform === 'win32' })
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase()
      this.legacySyntax = /(?:^|\s)wire(?:\s|$)/u.test(output) && !output.includes('--wire')
    } catch {
      this.legacySyntax = false
    }
  }
}

function mapKimiWireEvent(value: Record<string, unknown>, cancelled: boolean): { protocol: boolean; error: boolean; chunks: CodingNsCliStreamChunk[] } {
  const event = isRecord(value.event) ? value.event : isRecord(value.payload) ? value.payload : value
  const type = `${value.type ?? event.type ?? value.event ?? ''}`.toLowerCase()
  const chunks: CodingNsCliStreamChunk[] = []
  const sessionId = firstString(value, event, ['session_id', 'sessionId', 'id'])
  if (sessionId && (type.includes('session') || type.includes('ready'))) chunks.push({ type: 'session-binding', providerSessionId: sessionId })
  const permissionId = firstString(event, value, ['request_id', 'requestId', 'permission_id'])
  if (permissionId && type.includes('permission')) chunks.push({ type: 'permission-request', requestId: permissionId, kind: firstString(event, value, ['kind', 'type']) ?? 'unknown' })
  const text = textFrom(event)
  if (text) {
    if (type.includes('think') || type.includes('reason')) chunks.push({ type: 'reasoning-delta', text })
    else if (!type.includes('result') && !type.includes('complete') && !type.includes('done')) chunks.push({ type: 'text-delta', text })
  }
  const toolName = firstString(event, value, ['tool_name', 'toolName', 'name'])
  if (toolName && (type.includes('tool') || type.includes('command'))) chunks.push({ type: 'tool-running', toolName })
  const usage = isRecord(event.usage) ? event.usage : isRecord(value.usage) ? value.usage : null
  if (usage) chunks.push({ type: 'usage', inputTokens: numberValue(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens), outputTokens: numberValue(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens) })
  if (type.includes('error') || type.includes('failed')) return { protocol: true, error: true, chunks }
  if (type.includes('turnend') || type.includes('turn_end') || type.includes('completed') || type.includes('complete') || type === 'done' || type === 'result' || type.includes('session.completed')) chunks.push({ type: 'finish', reason: cancelled ? 'cancel' : 'stop' })
  return { protocol: true, error: false, chunks }
}

function textFrom(value: Record<string, unknown>): string | null {
  for (const key of ['text', 'delta', 'content', 'message']) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return item
    if (Array.isArray(item)) {
      const parts = item.flatMap((part) => typeof part === 'string' ? [part] : isRecord(part) ? [textFrom(part) ?? ''] : [])
      const joined = parts.join('')
      if (joined.trim()) return joined
    }
    if (isRecord(item)) {
      const nested = textFrom(item)
      if (nested) return nested
    }
  }
  return null
}
function firstString(a: Record<string, unknown>, b: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) for (const source of [a, b]) if (typeof source[key] === 'string' && source[key].trim()) return source[key] as string
  return null
}
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

export { KimiCliDriver as KimiDriver }
