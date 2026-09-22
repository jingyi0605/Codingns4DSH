import { spawn, spawnSync } from 'node:child_process'
import type { CodingNsCliModelCatalog, CodingNsCliStreamChunk, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, textValue, usageChunk } from './rpc-driver-utils.js'
import { PI_CATALOG, isProviderDefaultModel } from './model-catalog.js'

export interface PiAgentDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/** Pi Agent 的 --mode rpc 适配器。Pi 的长期 RPC 细节被限制在本文件和标准进程层内。 */
export class PiAgentDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'pi', name: 'Pi Agent', protocol: 'json-rpc', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'steer'] as const } as const
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private cachedBinary: string | null = null
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly sessions = new Map<string, { rpc: JsonRpcProcess; cwd: string | undefined; providerSessionId: string; needsResume: boolean }>()

  constructor(options: PiAgentDriverOptions = {}) {
    this.binaries = options.binaries ?? ['pi', 'pi-agent']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detection = await this.detect()
    if (!detection.installed) return emptyCatalog()
    // Pi 的 RPC 目录包含每个模型精确的 thinkingLevelMap；表格接口只有 yes/no，
    // 不能用来判断具体档位，因此只能作为旧版本的降级路径。
    const rpc = new JsonRpcProcess({ command: detection.command!, args: ['--mode', 'rpc'], spawn: this.runSpawn })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await rpc.request('get_available_models', {}, { signal: controller.signal })
      const catalog = parsePiCatalog(response)
      if (catalog.groups.length > 0) return catalog
    } catch { /* 旧版 Pi 没有模型 RPC 时继续读取表格。 */ }
    finally { clearTimeout(timer); rpc.dispose() }
    try {
      const result = this.runSpawnSync(detection.command!, ['--list-models'], { encoding: 'utf8', timeout: 12_000, windowsHide: true, shell: false })
      const catalog = parsePiCliCatalog(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
      if (catalog.groups.length > 0) return catalog
    } catch { /* 旧版 Pi 没有 --list-models。 */ }
    return PI_CATALOG
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error('Pi Agent 未安装')
    const session = this.getSession(input.sessionId, command, input.cwd, input.providerSessionId)
    const rpc = session.rpc
    try {
      // 新版 Pi 接受可选模型设置；旧版会以错误响应结束，随后仍可使用默认模型。
      if (session.needsResume && input.providerSessionId) {
        try {
          await rpc.request('resume', { sessionId: input.providerSessionId }, { signal: input.signal, killOnAbort: false })
          session.providerSessionId = input.providerSessionId
        } catch { /* 旧版 Pi 没有显式 resume，继续复用当前进程 */ }
        session.needsResume = false
      }
      if (!isProviderDefaultModel(input.modelId)) {
        try { await rpc.request('set_model', { model: input.modelId }, { signal: input.signal, killOnAbort: false }) } catch { /* 兼容旧版 */ }
      }
      yield { type: 'session-binding', providerSessionId: session.providerSessionId }
      const stream = streamPiPrompt(rpc, input.prompt, input.signal)
      let finishReason: 'stop' | 'cancel' | 'error'
      while (true) {
        const item = await stream.next()
        if (item.done) {
          finishReason = item.value
          break
        }
        const discoveredId = readSessionId(item.value)
        if (discoveredId && discoveredId !== session.providerSessionId) {
          session.providerSessionId = discoveredId
          yield { type: 'session-binding', providerSessionId: discoveredId }
        }
        const chunk = piMessageToChunk(item.value)
        if (chunk !== null) yield chunk
      }
      if (finishReason === 'cancel') {
        await this.interrupt(input.sessionId)
      }
      yield { type: 'finish', reason: finishReason }
    } finally { /* 跨轮复用：仅 dispose() 才回收长期进程。 */ }
  }

  /** 向运行中的 Pi 会话发送 steering，当前 turn 会立即改变方向。 */
  async steer(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('Pi 会话不存在')
    await session.rpc.request('steer', { message: prompt }, { killOnAbort: false })
  }

  /** 向运行中的 Pi 会话追加 follow-up。 */
  async followUp(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('Pi 会话不存在')
    await session.rpc.request('follow_up', { message: prompt }, { killOnAbort: false })
  }

  /** 中断当前 turn，但保留 Pi 进程供同一会话继续使用。 */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    try { await session.rpc.request('interrupt', {}, { killOnAbort: false }) }
    catch { try { session.rpc.notify('abort', {}) } catch { /* 进程可能已退出 */ } }
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.rpc.dispose()
    this.sessions.clear()
    this.processes.clear()
    this.cachedBinary = null
  }

  private getSession(sessionId: string, command: string, cwd: string | undefined, providerSessionId: string | undefined) {
    const previous = this.sessions.get(sessionId)
    if (previous !== undefined && previous.cwd === cwd) return previous
    previous?.rpc.dispose()
    const rpc = new JsonRpcProcess({ command, args: ['--mode', 'rpc'], cwd, spawn: this.runSpawn })
    this.processes.add(rpc)
    const session = {
      rpc,
      cwd,
      providerSessionId: providerSessionId ?? sessionId,
      needsResume: providerSessionId !== undefined,
    }
    this.sessions.set(sessionId, session)
    return session
  }
}

/**
 * Pi 的 prompt 响应只表示已接受，不能作为轮次终态。
 * 监听器必须先于请求注册，并一直保留到 agent_settled、失败或取消。
 */
async function* streamPiPrompt(
  rpc: JsonRpcProcess,
  prompt: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<JsonRpcMessage, 'stop' | 'cancel' | 'error', void> {
  const queue: JsonRpcMessage[] = []
  let wake: (() => void) | undefined
  let promptSettled = false
  let terminalReason: 'stop' | 'cancel' | 'error' | null = null
  const notify = (): void => { wake?.(); wake = undefined }
  const listener = (message: JsonRpcMessage): void => {
    queue.push(message)
    const type = piEventType(message)
    if (type === 'agent_settled') terminalReason = 'stop'
    else if (type === 'error' || type === 'agent_error' || type === 'agent_failed') terminalReason = 'error'
    notify()
  }
  const removeListener = rpc.addNotificationListener(listener)
  const onAbort = (): void => { terminalReason = 'cancel'; notify() }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  void rpc.request('prompt', { message: prompt }, { signal, killOnAbort: false }).then(
    () => { promptSettled = true; notify() },
    () => {
      promptSettled = true
      terminalReason = signal?.aborted ? 'cancel' : 'error'
      notify()
    },
  )

  try {
    while (queue.length > 0 || !promptSettled || terminalReason === null) {
      if (queue.length > 0) {
        yield queue.shift()!
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
    return terminalReason
  } finally {
    signal?.removeEventListener('abort', onAbort)
    removeListener()
  }
}

function piEventType(message: JsonRpcMessage): string {
  const params = isRecord(message.params) ? message.params : message
  return typeof params.type === 'string' ? params.type.toLowerCase() : ''
}

function parsePiCliCatalog(output: string): CodingNsCliModelCatalog {
  const models: Array<{ id: string; name: string; efforts: readonly string[] }> = []
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(yes|no)(?:\s+|$)/iu)
    if (!match) continue
    const provider = match[1]!
    const model = match[2]!
    const id = `${provider}/${model}`
    if (models.some((item) => item.id === id)) continue
    models.push({ id, name: model, efforts: match[3]!.toLowerCase() === 'yes' ? levels : ['off'] })
  }
  if (models.length === 0) return emptyCatalog()
  return { groups: [{ id: 'pi', name: 'Pi', models }], currentModel: null, currentEffort: null }
}

function parsePiCatalog(value: unknown): CodingNsCliModelCatalog {
  const payload = isRecord(value) && isRecord(value.data) ? value.data : value
  const models = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.models) ? payload.models : []
  const items = models.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
    const id = typeof entry.id === 'string' ? entry.id.trim() : typeof entry.modelId === 'string' ? entry.modelId.trim() : ''
    if (!id) return []
    const modelId = provider ? `${provider}/${id}` : id
    const map = isRecord(entry.thinkingLevelMap) ? entry.thinkingLevelMap : null
    const reasoning = entry.reasoning === true
    const levels = !reasoning
      ? ['off']
      : map === null
        ? ['off', 'minimal', 'low', 'medium', 'high']
        : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((level) => typeof map[level] === 'string' && map[level].trim() !== '')
    return [{ id: modelId, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : id, efforts: levels }]
  })
  if (items.length === 0) return emptyCatalog()
  return { groups: [{ id: 'pi', name: 'Pi', models: [...new Map(items.map((item) => [item.id, item])).values()] }], currentModel: null, currentEffort: null }
}

function piMessageToChunk(message: Record<string, any>): CodingNsCliStreamChunk | null {
  const params = isRecord(message.params) ? message.params : message
  const event = isRecord(params.item) ? params.item : params
  const assistantEvent = isRecord(params.assistantMessageEvent) ? params.assistantMessageEvent : null
  const rootType = typeof event.type === 'string' ? event.type : typeof params.event === 'string' ? params.event : ''
  if (rootType === 'agent_settled' || rootType === 'agent_end' || rootType === 'turn_end') return null
  const type = assistantEvent !== null && typeof assistantEvent.type === 'string' ? assistantEvent.type : rootType
  const text = textValue(assistantEvent?.delta ?? params.delta ?? params.text ?? params.content ?? params.message)
  if (type.includes('text_delta') || type === 'text-delta' || type === 'assistant_message_event' && text) return text ? { type: 'text-delta', text } : null
  if (type.includes('thinking') || type.includes('reasoning')) return text ? { type: 'reasoning-delta', text } : null
  if (type.includes('tool') || type.includes('agent')) {
    const toolName = typeof params.toolName === 'string' ? params.toolName : typeof params.name === 'string' ? params.name : type
    const agentId = typeof params.agentId === 'string' ? params.agentId : typeof params.sessionId === 'string' && type.includes('agent') ? params.sessionId : undefined
    const status = normalizeStatus(params.status ?? params.state ?? (type.includes('completed') ? 'completed' : type.includes('failed') ? 'failed' : 'running'))
    return { type: 'tool-running', toolName, ...(agentId ? { agentId } : {}), ...(status ? { status } : {}) }
  }
  const usage = usageChunk(params)
  return usage ?? null
}

function readSessionId(message: Record<string, any>): string | null {
  const params = isRecord(message.params) ? message.params : message
  for (const key of ['sessionId', 'session_id', 'providerSessionId']) if (typeof params[key] === 'string' && params[key].trim()) return params[key].trim()
  return null
}

function normalizeStatus(value: unknown): 'started' | 'running' | 'completed' | 'failed' | undefined {
  if (value === 'started' || value === 'running' || value === 'completed' || value === 'failed') return value
  return undefined
}
