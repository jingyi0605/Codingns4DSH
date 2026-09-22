import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  CodingNsCliModelCatalog,
  CodingNsCliStreamChunk,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { HttpSseClient, type SseEvent } from './http-sse-client.js'
import { isProviderDefaultModel } from './model-catalog.js'

const WINDOWS = process.platform === 'win32'
const DEFAULT_BINARIES = WINDOWS ? ['opencode.exe', 'opencode'] : ['opencode']
const DEFAULT_URLS = ['http://127.0.0.1:4096']

export interface OpenCodeDriverOptions {
  readonly binaries?: readonly string[]
  readonly serverUrls?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  readonly fetch?: typeof fetch
  readonly serverArgs?: readonly string[]
}

/** OpenCode 的 server/SSE 适配器，向上只暴露 CodingNS 标准流。 */
export class OpenCodeDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'opencode', name: 'OpenCode', protocol: 'http-sse', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] as const } as const
  private readonly binaries: readonly string[]
  private readonly serverUrls: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly serverArgs: readonly string[]
  private readonly http: HttpSseClient
  private cachedBinary: string | null = null
  private cachedServer: string | null = null
  private readonly managedServers = new Map<string, { url: string; child: ChildProcessWithoutNullStreams }>()
  private readonly sessions = new Map<string, string>()

  constructor(options: OpenCodeDriverOptions = {}) {
    this.binaries = options.binaries ?? DEFAULT_BINARIES
    this.serverUrls = options.serverUrls ?? (process.env.OPENCODE_SERVER_URL ? [process.env.OPENCODE_SERVER_URL] : DEFAULT_URLS)
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    this.serverArgs = options.serverArgs ?? ['serve']
    this.http = new HttpSseClient(options.fetch === undefined ? {} : { fetch: options.fetch })
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const server = await this.findServer()
    const binary = this.findBinary()
    if (server !== null) return { installed: true, version: server.version, command: server.url }
    if (binary !== null) return { installed: true, version: binary.version, command: binary.command }
    return { installed: false, version: null, command: null }
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const server = await this.ensureServer(false, undefined)
    if (server === null) return emptyCatalog()
    const paths = ['/config/providers', '/provider', '/models']
    for (const path of paths) {
      try {
        const response = await this.http.json<unknown>(`${server}${path}`)
        if (!response.data || response.status < 200 || response.status >= 300) continue
        const catalog = parseModelCatalog(response.data)
        if (catalog.groups.length > 0) return catalog
      } catch { /* OpenCode 版本间接口不同，继续尝试其他路径。 */ }
    }
    return emptyCatalog()
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk> {
    const server = await this.ensureServer(false, input.cwd)
    if (server === null) throw new Error('OpenCode server 未运行，请先启动 `opencode serve`')
    let sessionId = input.providerSessionId ?? this.sessions.get(input.sessionId)
    if (sessionId !== undefined) this.sessions.set(input.sessionId, sessionId)
    const createdSession = sessionId === undefined
    if (sessionId === undefined) {
      sessionId = await this.createSession(server, input)
      this.sessions.set(input.sessionId, sessionId)
    }

    const streamController = new AbortController()
    let aborted = false
    const abort = (): void => {
      aborted = true
      streamController.abort()
      void this.abortSession(server, sessionId!)
      if (input.cwd !== undefined) this.stopManagedServer(input.cwd)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    const eventStream = this.http.sse(`${server}/event`, { signal: streamController.signal })
    const eventIterator = eventStream[Symbol.asyncIterator]()
    // 先调用 next() 让 SSE 请求真正建立，再发送 prompt，避免首个事件竞态丢失。
    let pendingEvent = eventIterator.next()
    let sendError: unknown = null
    const send = this.sendPrompt(server, sessionId, input).catch((error: unknown) => { sendError = error; return null })
    let emitted = false
    let finished = false
    const cumulative = new Map<string, number>()
    try {
      if (createdSession || input.providerSessionId !== undefined) yield { type: 'session-binding', providerSessionId: sessionId }
      // sendPrompt 的返回体可能包含完整消息；SSE 仍然是首选，返回体作为兜底。
      try {
        while (true) {
          const result = await pendingEvent
          if (result.done) break
          pendingEvent = eventIterator.next()
          const parsed = parseEvent(result.value)
          if (parsed === null) continue
          const chunk = eventToChunk(parsed, cumulative)
          if (chunk !== null) {
            emitted = true
            yield chunk
          }
          if (isFinishedEvent(parsed, emitted)) { finished = true; break }
        }
      } catch (error) {
        if (!aborted) throw error
      }
      if (!finished && !aborted) {
        const response = await send
        if (sendError !== null) throw sendError
        for (const chunk of responseChunks(response, cumulative)) { emitted = true; yield chunk }
      }
      if (aborted || input.signal?.aborted) yield { type: 'finish', reason: 'cancel' }
      else if (finished || emitted) yield { type: 'finish', reason: 'stop' }
      else throw new Error('OpenCode 未返回可识别的事件')
    } finally {
      input.signal?.removeEventListener('abort', abort)
      streamController.abort()
    }
  }

  dispose(): void {
    this.sessions.clear()
    for (const managed of this.managedServers.values()) {
      try { managed.child.kill('SIGTERM') } catch { /* 进程可能已经退出 */ }
    }
    this.managedServers.clear()
    this.cachedBinary = null
    this.cachedServer = null
  }

  private async sendPrompt(server: string, sessionId: string, input: CodingNsCliTurnInput): Promise<unknown> {
    const body: Record<string, unknown> = { parts: [{ type: 'text', text: input.prompt }] }
    if (!isProviderDefaultModel(input.modelId)) { body.model = input.modelId; body.modelID = input.modelId }
    if (input.effortId) body.effort = input.effortId
    const response = await this.http.json<unknown>(`${server}/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (response.status < 200 || response.status >= 300) throw new Error(`OpenCode message 请求失败（HTTP ${response.status}）`)
    return response.data
  }

  private async createSession(server: string, input: CodingNsCliTurnInput): Promise<string> {
    const body = { title: input.sessionId, ...(input.cwd === undefined ? {} : { directory: input.cwd }) }
    const response = await this.http.json<unknown>(`${server}/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const record = asRecord(response.data)
    const id = typeof record?.id === 'string' ? record.id : typeof record?.sessionID === 'string' ? record.sessionID : null
    if (response.status < 200 || response.status >= 300 || id === null) throw new Error(`OpenCode 创建会话失败（HTTP ${response.status}）`)
    return id
  }

  private async abortSession(server: string, sessionId: string): Promise<void> {
    try { await this.http.json(`${server}/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' }) } catch { /* 取消请求尽力而为 */ }
  }

  private async ensureServer(probeOnly: boolean, cwd: string | undefined): Promise<string | null> {
    const workspace = cwd ?? process.cwd()
    const managed = this.managedServers.get(workspace)
    if (managed !== undefined) return managed.url
    if (this.cachedServer !== null) return this.cachedServer
    const server = await this.findServer()
    if (server !== null) { this.cachedServer = server.url; return server.url }
    if (!probeOnly) return this.startServer(workspace)
    return null
  }

  private async startServer(cwd: string): Promise<string | null> {
    const command = this.cachedBinary ?? this.findBinary()?.command
    if (command === null || command === undefined) return null
    const port = 4096 + this.managedServers.size
    const url = `http://127.0.0.1:${port}`
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.runSpawn(command, [...this.serverArgs, '--port', String(port)], {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: WINDOWS,
      })
    } catch { return null }
    child.stdout.on('data', () => undefined)
    child.stderr.on('data', () => undefined)
    this.managedServers.set(cwd, { url, child })
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const health = await this.http.json<unknown>(`${url}/global/health`)
        if (health.status >= 200 && health.status < 300) return url
      } catch { /* 服务尚未监听 */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
    this.stopManagedServer(cwd)
    return null
  }

  private stopManagedServer(cwd: string): void {
    const managed = this.managedServers.get(cwd)
    if (managed === undefined) return
    this.managedServers.delete(cwd)
    try { managed.child.kill('SIGTERM') } catch { /* 进程可能已经退出 */ }
  }

  private async findServer(): Promise<{ url: string; version: string | null } | null> {
    for (const raw of this.serverUrls) {
      const url = raw.replace(/\/$/u, '')
      for (const path of ['/global/health', '/health']) {
        try {
          const response = await this.http.json<unknown>(`${url}${path}`)
          if (response.status < 200 || response.status >= 300) continue
          const record = asRecord(response.data)
          const version = typeof record?.version === 'string' ? record.version : null
          return { url, version }
        } catch { /* 服务未监听或端口不可达 */ }
      }
    }
    return null
  }

  private findBinary(): { command: string; version: string | null } | null {
    if (this.cachedBinary !== null) return { command: this.cachedBinary, version: null }
    for (const command of this.binaries) {
      try {
        const result = this.runSpawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3_000, windowsHide: true, shell: WINDOWS })
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
        if (result.status === 0) {
          this.cachedBinary = command
          return { command, version: output.match(/\d+\.\d+\.\d+/u)?.[0] ?? null }
        }
      } catch { /* PATH 中没有命令 */ }
    }
    return null
  }
}

function parseEvent(event: SseEvent): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(event.data)
    const record = asRecord(value)
    if (record === null) return null
    return event.event === null || typeof record.type === 'string' ? record : { ...record, type: event.event }
  } catch { return null }
}

function eventToChunk(event: Record<string, unknown>, cumulative: Map<string, number>): CodingNsCliStreamChunk | null {
  const type = typeof event.type === 'string' ? event.type : ''
  const properties = asRecord(event.properties)
  const part = asRecord(event.part) ?? asRecord(properties?.part) ?? properties ?? event
  const partType = typeof part.type === 'string' ? part.type : ''
  const key = typeof part.id === 'string' ? part.id : `${type}:${partType}`
  const text = typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : typeof part.delta === 'string' ? part.delta : null
  if (text !== null && (partType === 'text' || partType === 'reasoning' || type.includes('part'))) {
    const previous = cumulative.get(key) ?? 0
    const delta = text.slice(previous)
    cumulative.set(key, text.length)
    if (!delta) return null
    return partType === 'reasoning' ? { type: 'reasoning-delta', text: delta } : { type: 'text-delta', text: delta }
  }
  const tool = typeof part.tool === 'string' ? part.tool : typeof part.name === 'string' && partType === 'tool' ? part.name : null
  if (tool !== null) return { type: 'tool-running', toolName: tool }
  const usage = asRecord(event.usage) ?? asRecord(part.usage)
  if (usage !== null) return { type: 'usage', inputTokens: numberValue(usage.inputTokens ?? usage.input_tokens), outputTokens: numberValue(usage.outputTokens ?? usage.output_tokens) }
  return null
}

function isFinishedEvent(event: Record<string, unknown>, emitted: boolean): boolean {
  const type = typeof event.type === 'string' ? event.type.toLowerCase() : ''
  if (type.includes('error') || type.includes('completed') || type.includes('done')) return true
  const properties = asRecord(event.properties)
  const rawStatus = event.status ?? properties?.status
  const statusRecord = asRecord(rawStatus)
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : typeof statusRecord?.type === 'string' ? statusRecord.type.toLowerCase() : ''
  return status === 'idle' || status === 'completed' || status === 'success'
}

function responseChunks(value: unknown, cumulative: Map<string, number>): CodingNsCliStreamChunk[] {
  const record = asRecord(value)
  if (record === null) return []
  const chunk = eventToChunk(record, cumulative)
  return chunk === null ? [] : [chunk]
}

function parseModelCatalog(value: unknown): CodingNsCliModelCatalog {
  const root = asRecord(value)
  if (Array.isArray(root?.providers)) {
    const groups = root.providers.flatMap((rawProvider) => {
      const provider = asRecord(rawProvider)
      if (provider === null) return []
      const providerId = typeof provider.id === 'string' ? provider.id : null
      if (!providerId) return []
      const models = asRecord(provider.models)
      if (models === null) return []
      const items = Object.entries(models).map(([id, model]) => {
        const info = asRecord(model)
        return {
          id: `${providerId}/${id}`,
          name: typeof info?.name === 'string' ? info.name : id,
          ...(typeof info?.description === 'string' ? { description: info.description } : {}),
          efforts: parseOpenCodeEfforts(info),
        }
      })
      return items.length > 0 ? [{ id: providerId, name: typeof provider.name === 'string' ? provider.name : providerId, models: items }] : []
    })
    return { groups, currentModel: null, currentEffort: null }
  }
  const providers = asRecord(root?.providers) ?? root
  const groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string; efforts: readonly string[] }> }> = []
  if (providers !== null) for (const [providerId, raw] of Object.entries(providers)) {
    const provider = asRecord(raw)
    const models = asRecord(provider?.models) ?? (Array.isArray(raw) ? Object.fromEntries(raw.map((item) => [String(item), {}])) : null)
    if (models === null) continue
    const items = Object.entries(models).map(([id, model]) => {
      const info = asRecord(model)
      return {
        id: `${providerId}/${id}`,
        name: typeof info?.name === 'string' ? info.name : id,
        ...(typeof info?.description === 'string' ? { description: info.description } : {}),
        efforts: parseOpenCodeEfforts(info),
      }
    })
    if (items.length > 0) groups.push({ id: providerId, name: providerId, models: items })
  }
  return { groups, currentModel: null, currentEffort: null }
}

function parseOpenCodeEfforts(value: Record<string, any> | null): readonly string[] {
  if (value === null) return []
  const variants = Array.isArray(value.variants)
    ? value.variants
    : asRecord(value.variants) !== null ? Object.keys(value.variants as Record<string, unknown>) : []
  const allowed = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  return [...new Set(variants.flatMap((variant) => {
    const variantRecord = asRecord(variant)
    const raw = typeof variant === 'string' ? variant : variantRecord !== null ? variantRecord.id ?? variantRecord.value ?? variantRecord.name : null
    if (typeof raw !== 'string') return []
    const normalized = raw.trim().toLowerCase()
    return allowed.has(normalized) ? [normalized === 'none' ? 'off' : normalized] : []
  }))]
}

function asRecord(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function isRecord(value: unknown): value is Record<string, any> { return asRecord(value) !== null }
function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }
