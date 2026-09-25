import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  CodingNsCliModelCatalog,
  CodingNsAgentEvent,
  CodingNsAgentQuestionResponse,
  CodingNsAgentPermissionResponse,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { HttpSseClient, type SseEvent } from './http-sse-client.js'
import { isProviderDefaultModel } from './model-catalog.js'
import { firstToolText, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { isQuestionEvent, questionAnswersList, readAgentQuestions } from './interaction-events.js'
import { usageChunk } from './rpc-driver-utils.js'
import { terminateChildProcess } from './process-utils.js'

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
  readonly descriptor = { id: 'opencode', name: 'OpenCode', protocol: 'http-sse', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions'] as const } as const
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
  /** Provider 会话的实际工作目录；目录变化时禁止复用旧会话。 */
  private readonly sessionCwds = new Map<string, string>()
  private readonly interactionTargets = new Map<string, string>()

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

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    const providerSessionId = input.providerSessionId?.trim()
    if (!providerSessionId) return { state: 'unknown', reason: '缺少 Provider 会话标识' }
    const server = await this.ensureServer(true, input.cwd)
    if (server === null) return { state: 'unreachable', reason: 'OpenCode server 当前不可达' }
    const rawStoreRef = `${server}/session/${encodeURIComponent(providerSessionId)}`
    try {
      const response = await this.http.json<unknown>(rawStoreRef, input.signal === undefined ? {} : { signal: input.signal })
      if (response.status === 404) return { state: 'missing', reason: 'OpenCode server 确认该会话不存在' }
      if (response.status >= 200 && response.status < 300) {
        const record = asRecord(response.data)
        const id = typeof record?.id === 'string' ? record.id : typeof record?.sessionID === 'string' ? record.sessionID : null
        const directory = readProviderDirectory(record)
        if (input.cwd !== undefined && directory !== undefined && directory !== input.cwd.trim()) {
          return { state: 'corrupt', reason: 'OpenCode 会话工作目录与当前 DSH 会话不一致', rawStoreRef }
        }
        return id === null || id === providerSessionId
          ? { state: 'available', reason: 'OpenCode 原始会话可用', rawStoreRef }
          : { state: 'corrupt', reason: 'OpenCode 会话响应与绑定标识不一致', rawStoreRef }
      }
      if (response.status === 401 || response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500) {
        return { state: 'unreachable', reason: `OpenCode server 暂时无法验证会话（HTTP ${response.status}）` }
      }
      return { state: 'unknown', reason: `OpenCode server 无法确认会话状态（HTTP ${response.status}）` }
    } catch {
      return { state: 'unreachable', reason: 'OpenCode server 会话探测请求失败' }
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const server = await this.ensureServer(false, input.cwd)
    if (server === null) throw new Error('OpenCode server 未运行，请先启动 `opencode serve`')
    let sessionId = input.providerSessionId ?? this.sessions.get(input.sessionId)
    if (sessionId !== undefined && !(await this.providerSessionMatchesDirectory(server, sessionId, input.cwd, input.signal))) {
      sessionId = undefined
    }
    if (sessionId !== undefined) this.sessions.set(input.sessionId, sessionId)
    const createdSession = sessionId === undefined
    if (sessionId === undefined) {
      sessionId = await this.createSession(server, input)
      this.sessions.set(input.sessionId, sessionId)
    }
    if (input.cwd?.trim()) this.sessionCwds.set(sessionId, input.cwd.trim())
    this.interactionTargets.set(input.sessionId, server)

    const streamController = new AbortController()
    let aborted = false
    const abort = (): void => {
      aborted = true
      streamController.abort()
      void this.abortSession(server, sessionId!)
      if (input.cwd !== undefined) this.stopManagedServer(input.cwd)
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    const eventStream = this.http.sse(withOpenCodeDirectory(server, '/event', input.cwd), { signal: streamController.signal })
    const eventIterator = eventStream[Symbol.asyncIterator]()
    // 先调用 next() 让 SSE 请求真正建立，再发送 prompt，避免首个事件竞态丢失。
    let pendingEvent = eventIterator.next()
    let sendError: unknown = null
    const send = this.sendPrompt(server, sessionId, input).catch((error: unknown) => {
      sendError = error
      // message 请求失败时，OpenCode 的全局 SSE 通常不会自行结束；主动中止，
      // 否则调用方会一直等不到错误，只看到没有任何输出。
      streamController.abort()
      return null
    })
    let emitted = false
    let finished = false
    const cumulative = new Map<string, number>()
    const partTypes = new Map<string, string>()
    const assistantMessageIds = new Set<string>()
    const knownMessageIds = new Set<string>()
    const pendingMessageParts = new Map<string, Record<string, unknown>[]>()
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
          const eventSession = eventSessionId(parsed)
          // /event 是全局 SSE；没有会话字段的旧版事件仍允许通过，
          // 但明确属于其他会话的事件绝不能结束或污染当前轮次。
          if (eventSession !== undefined && eventSession !== sessionId) continue
          const messageRole = readMessageRole(parsed)
          if (messageRole !== null) {
            knownMessageIds.add(messageRole.id)
            if (messageRole.role === 'assistant') {
              assistantMessageIds.add(messageRole.id)
              const pending = pendingMessageParts.get(messageRole.id) ?? []
              pendingMessageParts.delete(messageRole.id)
              for (const pendingPart of pending) {
                const chunk = eventToChunk(pendingPart, cumulative, assistantMessageIds, partTypes)
                if (chunk !== null) { emitted = true; yield chunk }
              }
            } else {
              pendingMessageParts.delete(messageRole.id)
            }
            continue
          }
          const messageId = eventMessageId(parsed)
          if (messageId !== undefined && !knownMessageIds.has(messageId)) {
            // OpenCode 的 message.part.updated 经常早于 message.updated 到达。
            // 工具调用是当前轮次最重要的实时事件，不能像正文一样等到
            // assistant 消息结算后才投影，否则原生工具节点会被追加到正文底部。
            // 用户消息没有 tool 字段，因此仍然暂存并等待 role 校验。
            if (isOpenCodeToolEvent(parsed)) {
              const chunk = eventToChunk(parsed, cumulative, undefined, partTypes)
              if (chunk !== null) {
                emitted = true
                yield chunk
              }
              continue
            }
            const pending = pendingMessageParts.get(messageId) ?? []
            pending.push(parsed)
            pendingMessageParts.set(messageId, pending)
            continue
          }
          if (messageId !== undefined && !assistantMessageIds.has(messageId)) continue
          const chunk = eventToChunk(parsed, cumulative, assistantMessageIds, partTypes)
          if (chunk !== null) {
            emitted = true
            yield chunk
          }
          if (isFinishedEvent(parsed, emitted)) { finished = true; break }
        }
      } catch (error) {
        if (sendError !== null && !aborted) throw sendError
        if (!aborted) throw error
      }
      if (!finished && !aborted) {
        const response = await send
        if (sendError !== null && !aborted) throw sendError
        for (const chunk of responseChunks(response, cumulative, partTypes)) { emitted = true; yield chunk }
      }
      if (aborted || input.signal?.aborted) yield { type: 'finish', reason: 'cancel' }
      else if (finished || emitted) yield { type: 'finish', reason: 'stop' }
      else throw new Error('OpenCode 未返回可识别的事件')
    } finally {
      if (this.interactionTargets.get(input.sessionId) === server) this.interactionTargets.delete(input.sessionId)
      input.signal?.removeEventListener('abort', abort)
      streamController.abort()
    }
  }

  async respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): Promise<void> {
    const server = this.interactionTargets.get(sessionId)
    if (server === undefined) throw new Error('OpenCode 权限请求已结束')
    const result = await this.http.json(`${server}/permission/${encodeURIComponent(response.requestId)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply: response.approved ? 'once' : 'reject' }),
    })
    if (result.status < 200 || result.status >= 300) throw new Error(`OpenCode 权限回复失败（HTTP ${result.status}）`)
  }

  async respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): Promise<void> {
    const server = this.interactionTargets.get(sessionId)
    if (server === undefined) throw new Error('OpenCode 问题请求已结束')
    const result = await this.http.json(`${server}/question/${encodeURIComponent(response.requestId)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: questionAnswersList(response) }),
    })
    if (result.status < 200 || result.status >= 300) throw new Error(`OpenCode 问题回复失败（HTTP ${result.status}）`)
  }

  dispose(): void {
    this.sessions.clear()
    this.sessionCwds.clear()
    for (const managed of this.managedServers.values()) terminateChildProcess(managed.child)
    this.managedServers.clear()
    this.cachedBinary = null
    this.cachedServer = null
  }

  private async sendPrompt(server: string, sessionId: string, input: CodingNsCliTurnInput): Promise<unknown> {
    const body: Record<string, unknown> = { parts: [{ type: 'text', text: input.prompt }] }
    const model = parseOpenCodeModel(input.modelId)
    if (model !== null) body.model = model
    if (input.effortId) body.variant = input.effortId
    const response = await this.http.json<unknown>(withOpenCodeDirectory(server, `/session/${encodeURIComponent(sessionId)}/message`, input.cwd), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (response.status < 200 || response.status >= 300) throw new Error(`OpenCode message 请求失败（HTTP ${response.status}）`)
    return response.data
  }

  private async createSession(server: string, input: CodingNsCliTurnInput): Promise<string> {
    const body = { title: input.sessionId, ...(input.cwd === undefined ? {} : { directory: input.cwd }) }
    const response = await this.http.json<unknown>(withOpenCodeDirectory(server, '/session', input.cwd), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const record = asRecord(response.data)
    const id = typeof record?.id === 'string' ? record.id : typeof record?.sessionID === 'string' ? record.sessionID : null
    if (response.status < 200 || response.status >= 300 || id === null) throw new Error(`OpenCode 创建会话失败（HTTP ${response.status}）`)
    return id
  }

  private async providerSessionMatchesDirectory(
    server: string,
    sessionId: string,
    cwd: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (cwd === undefined || cwd.trim() === '') return true
    const normalizedCwd = cwd.trim()
    const knownCwd = this.sessionCwds.get(sessionId)
    if (knownCwd !== undefined) return knownCwd === normalizedCwd
    try {
      const response = await this.http.json<unknown>(`${server}/session/${encodeURIComponent(sessionId)}`, signal === undefined ? {} : { signal })
      if (response.status === 404) return false
      if (response.status < 200 || response.status >= 300) return true
      const directory = readProviderDirectory(asRecord(response.data))
      if (directory === undefined) return true
      return directory === normalizedCwd
    } catch {
      // 目录校验失败时保留旧兼容行为，避免临时网络故障导致会话被无故重建。
      return true
    }
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
    terminateChildProcess(managed.child)
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

function parseOpenCodeModel(modelId: string | undefined): { providerID: string; modelID: string } | null {
  if (isProviderDefaultModel(modelId)) return null
  const separator = modelId!.indexOf('/')
  if (separator <= 0 || separator === modelId!.length - 1) return null
  return { providerID: modelId!.slice(0, separator), modelID: modelId!.slice(separator + 1) }
}

function readProviderDirectory(record: Record<string, any> | null): string | undefined {
  const value = record?.directory ?? record?.cwd
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isReasoningField(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'reasoning'
    || normalized === 'thinking'
    || normalized === 'reasoning_content'
    || normalized === 'reasoning_details'
}

function withOpenCodeDirectory(server: string, pathname: string, cwd: string | undefined): string {
  const url = new URL(pathname, `${server.replace(/\/$/u, '')}/`)
  if (cwd?.trim()) url.searchParams.set('directory', cwd.trim())
  return url.toString()
}

function parseEvent(event: SseEvent): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(event.data)
    const record = asRecord(value)
    if (record === null) return null
    return event.event === null || typeof record.type === 'string' ? record : { ...record, type: event.event }
  } catch { return null }
}

function eventToChunk(
  event: Record<string, unknown>,
  cumulative: Map<string, number>,
  assistantMessageIds?: ReadonlySet<string>,
  partTypes?: Map<string, string>,
): CodingNsAgentEvent | null {
  const type = typeof event.type === 'string' ? event.type : ''
  const properties = asRecord(event.properties)
  const part = asRecord(event.part) ?? asRecord(properties?.part) ?? properties ?? event
  const messageId = firstToolText(part.messageID, part.messageId, properties?.messageID, properties?.messageId)
  if (messageId !== undefined && assistantMessageIds !== undefined && !assistantMessageIds.has(messageId)) return null
  if (isQuestionEvent(type)) {
    const requestId = firstToolText(part.id, part.requestID, part.requestId, properties?.id)
    const questions = readAgentQuestions(part.questions ?? properties?.questions ?? part)
    if (requestId !== undefined && questions.length > 0) return { type: 'question-request', requestId, questions }
  }
  if (type.toLowerCase().includes('permission')) {
    const requestId = firstToolText(part.id, part.requestID, part.requestId, properties?.id)
    if (requestId !== undefined) {
      const kind = firstToolText(part.permission, part.kind, part.type) ?? 'unknown'
      const detail = serializeToolValue(part.patterns ?? part.metadata ?? part.detail)
      return {
        type: 'permission-request',
        requestId,
        kind,
        toolName: firstToolText(part.tool, part.toolName) ?? kind,
        ...(detail === undefined ? {} : { detail }),
      }
    }
  }
  const partId = firstToolText(part.id, part.partID, properties?.partID, properties?.partId)
  const rawPartType = typeof part.type === 'string' ? part.type : ''
  if (partId !== undefined && rawPartType !== '') partTypes?.set(partId, rawPartType.trim().toLowerCase())
  const partType = rawPartType.trim().toLowerCase() || (partId === undefined ? '' : partTypes?.get(partId) ?? '')
  const key = partId ?? `${type}:${partType}`
  // OpenCode 1.18 的 delta 把 field 放在 properties 顶层；兼容旧版的顶层 field。
  // field 是最具体的通道声明，必须优先于 part.type，避免 reasoning 被投影成正文。
  const field = firstToolText(part.field, properties?.field, event.field)
  const reasoning = isReasoningField(field) || partType === 'reasoning'
  const text = typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : typeof part.delta === 'string' ? part.delta : null
  if (text !== null && (partType === 'text' || partType === 'reasoning' || type.includes('part'))) {
    const eventDelta = typeof properties?.delta === 'string'
      ? properties.delta
      : typeof event.delta === 'string' ? event.delta : undefined
    if (eventDelta !== undefined) {
      if (!eventDelta) return null
      cumulative.set(key, (cumulative.get(key) ?? 0) + eventDelta.length)
      return reasoning ? { type: 'reasoning-delta', text: eventDelta } : { type: 'text-delta', text: eventDelta }
    }
    const previous = cumulative.get(key) ?? 0
    const snapshotDelta = text.slice(previous)
    cumulative.set(key, text.length)
    if (!snapshotDelta) return null
    return reasoning ? { type: 'reasoning-delta', text: snapshotDelta } : { type: 'text-delta', text: snapshotDelta }
  }
  const toolName = firstToolText(part.tool, part.name)
  if (partType === 'tool' && toolName !== undefined) {
    const state = parseToolRecord(part.state) ?? part
    const callId = firstToolText(part.callID, part.callId, part.toolCallId, part.id)
    const input = serializeToolValue(readOpenCodeToolInput(event, properties, part, state))
    const output = serializeToolValue(state.output ?? state.result)
    const error = serializeToolValue(state.error)
    const fallback = error !== undefined
      ? 'failed'
      : output !== undefined
        ? 'completed'
        : 'running'
    const agentId = firstToolText(state.agentId, state.agent_id, part.agentId, part.agent_id)
    const detail = serializeToolValue(state.detail ?? part.detail)
    return {
      type: 'tool-event',
      toolName,
      status: normalizeToolStatus(state.status, fallback),
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(output !== undefined ? { outputMode: 'snapshot' as const } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(agentId ? { agentId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }
  const usage = asRecord(event.usage) ?? asRecord(part.usage) ?? readOpenCodeTokenUsage(properties)
  if (usage !== null) return usageChunk(usage)
  return null
}

/** OpenCode 将最终用量放在 message.updated.properties.info.tokens。 */
function readOpenCodeTokenUsage(properties: Record<string, unknown> | null): Record<string, unknown> | null {
  const info = asRecord(properties?.info)
  const tokens = asRecord(info?.tokens)
  if (tokens === null) return null
  const cache = asRecord(tokens.cache)
  return {
    input_tokens: tokens.input ?? tokens.input_tokens,
    output_tokens: tokens.output ?? tokens.output_tokens,
    cache_read_tokens: cache?.read ?? tokens.cache_read_tokens ?? tokens.cacheReadTokens,
    cache_creation_tokens: cache?.write ?? tokens.cache_write_tokens ?? tokens.cacheWriteTokens,
    total_tokens: tokens.total ?? tokens.total_tokens ?? tokens.totalTokens,
  }
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

function responseChunks(value: unknown, cumulative: Map<string, number>, partTypes?: Map<string, string>): CodingNsAgentEvent[] {
  const record = asRecord(value)
  if (record === null) return []
  const chunk = eventToChunk(record, cumulative, undefined, partTypes)
  return chunk === null ? [] : [chunk]
}

function readMessageRole(event: Record<string, unknown>): { id: string; role: 'assistant' | 'user' } | null {
  if (event.type !== 'message.updated') return null
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info) ?? properties
  if (info === null) return null
  const messageId = firstToolText(info.id, info.messageID, info.messageId)
  if (messageId === undefined || (info?.role !== 'assistant' && info?.role !== 'user')) return null
  return { id: messageId, role: info.role }
}

function eventMessageId(event: Record<string, unknown>): string | undefined {
  const properties = asRecord(event.properties)
  const part = asRecord(event.part) ?? asRecord(properties?.part)
  return firstToolText(part?.messageID, part?.messageId, properties?.messageID, properties?.messageId)
}

/** 判断尚未关联到 role 的 SSE 是否已经明确是工具 part。 */
function isOpenCodeToolEvent(event: Record<string, unknown>): boolean {
  const properties = asRecord(event.properties)
  const part = asRecord(event.part) ?? asRecord(properties?.part) ?? properties
  if (part === null) return false
  const type = typeof part.type === 'string' ? part.type.trim().toLowerCase() : ''
  return type === 'tool' || typeof part.tool === 'string' || part.callID !== undefined || part.toolCallId !== undefined
}

/**
 * OpenCode 不同版本把工具参数放在不同层级：稳定格式是 state.input，
 * 旧版/代理层还会放到 part.input、arguments 或 metadata.input。优先取
 * 非空值，避免先到达的空快照把真正参数覆盖成 `{}`。
 */
function readOpenCodeToolInput(
  event: Record<string, unknown>,
  properties: Record<string, any> | null,
  part: Record<string, any>,
  state: Record<string, any>,
): unknown {
  const stateMetadata = asRecord(state.metadata)
  const stateData = asRecord(state.data)
  const partMetadata = asRecord(part.metadata)
  const partData = asRecord(part.data)
  const toolCall = asRecord(part.toolCall) ?? asRecord(part.tool_call) ?? asRecord(part.call)
  const values = [
    state.input, state.arguments, state.args, state.parameters,
    state.raw,
    stateMetadata?.input, stateMetadata?.arguments, stateMetadata?.args,
    stateData?.input, stateData?.arguments, stateData?.args,
    part.input, part.arguments, part.args, part.parameters,
    part.raw,
    partMetadata?.input, partMetadata?.arguments, partMetadata?.args,
    partData?.input, partData?.arguments, partData?.args,
    toolCall?.input, toolCall?.arguments, toolCall?.args, toolCall?.parameters, toolCall?.raw,
    properties?.input, properties?.arguments, properties?.args,
    event.input, event.arguments, event.args,
  ]
  let fallback: unknown
  for (const value of values) {
    if (value === undefined || value === null) continue
    if (fallback === undefined) fallback = value
    if (!isEmptyToolValue(value)) return value
  }
  return fallback
}

function isEmptyToolValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() === '' || value.trim() === '{}'
  return isRecord(value) && Object.keys(value).length === 0
}

function eventSessionId(event: Record<string, unknown>): string | undefined {
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  const part = asRecord(event.part) ?? asRecord(properties?.part)
  return firstToolText(
    event.sessionID,
    event.sessionId,
    properties?.sessionID,
    properties?.sessionId,
    info?.sessionID,
    info?.sessionId,
    part?.sessionID,
    part?.sessionId,
  )
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
function parseToolRecord(value: unknown): Record<string, any> | null {
  const record = asRecord(value)
  if (record !== null) return record
  if (typeof value !== 'string' || value.trim() === '') return null
  try { return asRecord(JSON.parse(value)) } catch { return null }
}
function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }
