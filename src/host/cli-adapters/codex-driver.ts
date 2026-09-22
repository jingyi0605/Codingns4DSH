import { spawn, spawnSync } from 'node:child_process'
import type { CodingNsCliModelCatalog, CodingNsCliPermissionResponse, CodingNsCliStreamChunk, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver } from './driver.js'
import { JsonRpcProcess } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, streamRpcRequest, textValue, usageChunk } from './rpc-driver-utils.js'
import { CODEX_CATALOG, isProviderDefaultModel } from './model-catalog.js'

export interface CodexAppServerDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/** Codex app-server 的 JSON-RPC 驱动，Host 只暴露统一文本流，不暴露线程和 token。 */
export class CodexAppServerDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'codex', name: 'Codex', protocol: 'json-rpc', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'steer'] as const } as const
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private cachedBinary: string | null = null
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly sessions = new Map<string, {
    rpc: JsonRpcProcess
    cwd: string | undefined
    threadId: string
    turnId: string | null
    providerSessionId: string
    pendingPermissions: Map<string, (value: unknown) => void>
  }>()

  constructor(options: CodexAppServerDriverOptions = {}) {
    this.binaries = options.binaries ?? ['codex']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) return emptyCatalog()
    const rpc = new JsonRpcProcess({ command, args: ['app-server'], spawn: this.runSpawn })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'dsh-codingns', version: '0.1.0' },
        capabilities: {},
      }, { signal: controller.signal })
      rpc.notify('initialized', {})
      // config/read 让 Codex 完成一次配置加载；model/list 才返回带 effort 元数据的目录。
      await rpc.request('config/read', {}, { signal: controller.signal })
      const response = await rpc.request('model/list', {}, { signal: controller.signal })
      const catalog = parseCodexCatalog(response)
      return catalog.groups.length > 0 ? catalog : CODEX_CATALOG
    } catch {
      return CODEX_CATALOG
    } finally {
      clearTimeout(timer)
      rpc.dispose()
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error('Codex 未安装')
    const session = await this.getSession(input, command)
    const rpc = session.rpc
    try {
      if (session.threadId === '') {
        const thread = input.providerSessionId
          ? await rpc.request('thread/resume', { threadId: input.providerSessionId, cwd: input.cwd ?? process.cwd(), ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}) }, { signal: input.signal, killOnAbort: false })
          : await rpc.request('thread/start', { cwd: input.cwd ?? process.cwd(), ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}) }, { signal: input.signal, killOnAbort: false })
        session.threadId = readId(thread) ?? input.providerSessionId ?? input.sessionId
        session.providerSessionId = session.threadId
      }
      yield { type: 'session-binding', providerSessionId: session.providerSessionId }
      try {
        for await (const message of streamRpcRequest(rpc, 'turn/start', {
          threadId: session.threadId,
          input: [{ type: 'text', text: input.prompt }],
          ...(input.effortId ? { effort: input.effortId } : {}),
        }, input.signal, { dispose: false, killOnAbort: false })) {
          const turnId = readTurnId(message)
          if (turnId) session.turnId = turnId
          const chunk = codexMessageToChunk(message)
          if (chunk !== null) yield chunk
        }
      } catch (error) {
        if (!input.signal?.aborted) throw error
        await this.interrupt(input.sessionId)
      }
      yield { type: 'finish', reason: input.signal?.aborted ? 'cancel' : 'stop' }
    } finally { /* app-server 在会话结束前保持连接。 */ }
  }

  /** 将新输入 steer 到当前 Codex turn。 */
  async steer(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.threadId === '' || session.turnId === null) throw new Error('Codex 会话未运行')
    const result = await session.rpc.request('turn/steer', { threadId: session.threadId, turnId: session.turnId, input: [{ type: 'text', text: prompt }] }, { killOnAbort: false })
    const turnId = readId(result)
    if (turnId) session.turnId = turnId
  }

  /** 中断当前 Codex turn，但保留 app-server 线程。 */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.threadId === '' || session.turnId === null) return
    try { await session.rpc.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }, { killOnAbort: false }) }
    catch { /* app-server 可能已经发出 turn/completed */ }
  }

  /** 回传原生权限请求；审批值只在 Host 进程中流转。 */
  respondPermission(sessionId: string, response: CodingNsCliPermissionResponse): void {
    this.respondToPermission(sessionId, response.requestId, response.approved, response.reason)
  }

  /** 保留原生方法名，兼容已有 Host 内部调用方。 */
  respondToPermission(sessionId: string, requestId: string, approved: boolean, reason?: string): boolean {
    const session = this.sessions.get(sessionId)
    const resolve = session?.pendingPermissions.get(requestId)
    if (resolve === undefined || session === undefined) return false
    session.pendingPermissions.delete(requestId)
    resolve({ approved, ...(reason?.trim() ? { reason: reason.trim().slice(0, 512) } : {}) })
    return true
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      for (const resolve of session.pendingPermissions.values()) resolve({ approved: false })
      session.pendingPermissions.clear()
      session.rpc.dispose()
    }
    this.sessions.clear()
    this.processes.clear()
    this.cachedBinary = null
  }

  private async getSession(input: CodingNsCliTurnInput, command: string) {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd) return previous
    previous?.rpc.dispose()
    const rpc = new JsonRpcProcess({ command, args: ['app-server'], cwd: input.cwd, spawn: this.runSpawn })
    const session = { rpc, cwd: input.cwd, threadId: '', turnId: null as string | null, providerSessionId: input.providerSessionId ?? input.sessionId, pendingPermissions: new Map<string, (value: unknown) => void>() }
    this.processes.add(rpc)
    this.sessions.set(input.sessionId, session)
    await rpc.request('initialize', { clientInfo: { name: 'dsh-codingns', version: '0.1.0' }, capabilities: {} }, { signal: input.signal, killOnAbort: false })
    rpc.notify('initialized', {})
    rpc.setServerRequestHandler((request) => {
      const requestId = readRequestId(request)
      if (requestId === null) return { approved: false }
      return new Promise<unknown>((resolve) => session.pendingPermissions.set(requestId, resolve))
    })
    return session
  }
}

function parseCodexCatalog(value: unknown): CodingNsCliModelCatalog {
  const root = isRecord(value) && isRecord(value.data) ? value.data : value
  const models = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.models) ? root.models
      : isRecord(root) && Array.isArray(root.data) ? root.data
        : []
  const items = models.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (entry.hidden === true) return []
    const id = typeof entry.model === 'string' ? entry.model.trim() : typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) return []
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? [...new Set(entry.supportedReasoningEfforts.flatMap((item) => {
          const effort = typeof item === 'string'
            ? item
            : isRecord(item) && typeof item.reasoningEffort === 'string'
              ? item.reasoningEffort
              : null
          return effort?.trim() ? [effort.trim()] : []
        }))]
      : []
    return [{
      id,
      name: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName : id,
      efforts,
    }]
  })
  if (items.length === 0) return emptyCatalog()
  return {
    groups: [{ id: 'codex', name: 'Codex', models: [...new Map(items.map((item) => [item.id, item])).values()] }],
    currentModel: null,
    currentEffort: null,
  }
}

function codexMessageToChunk(message: Record<string, any>): CodingNsCliStreamChunk | null {
  const params = isRecord(message.params) ? message.params : message
  const item = isRecord(params.item) ? params.item : params
  const method = typeof message.method === 'string' ? message.method : ''
  const type = typeof item.type === 'string' ? item.type : ''
  const text = textValue(params.delta ?? params.text ?? params.content ?? params.message)
  if (method.includes('permission') || method.includes('Approval') || type.includes('permission') || type.includes('approval')) {
    const requestId = readRequestId(message) ?? readRequestId(params)
    const detail = text ?? (typeof params.command === 'string' ? params.command : typeof params.description === 'string' ? params.description : null)
    if (requestId !== null) return { type: 'permission-request', requestId, kind: typeof params.kind === 'string' ? params.kind : 'unknown', ...(detail ? { detail } : {}) }
  }
  if (method.includes('agentMessage') || method.includes('message') && (type.includes('text') || type === '')) return text ? { type: 'text-delta', text } : null
  if (method.includes('reason') || type.includes('reason')) return text ? { type: 'reasoning-delta', text } : null
  if (method.includes('command') || method.includes('tool') || method.includes('agent') || type.includes('tool') || type.includes('agent')) {
    const name = typeof item.name === 'string' ? item.name : typeof item.toolName === 'string' ? item.toolName : null
    const agentId = typeof item.agentId === 'string' ? item.agentId : typeof item.id === 'string' && (method.includes('agent') || type.includes('agent') || type.includes('collab')) ? item.id : undefined
    const status = normalizeStatus(item.status ?? item.state ?? (method.includes('completed') ? 'completed' : method.includes('failed') ? 'failed' : 'running'))
    return name || agentId ? { type: 'tool-running', toolName: name ?? 'subagent', ...(agentId ? { agentId } : {}), ...(status ? { status } : {}) } : null
  }
  return usageChunk(params)
}

function readRequestId(value: unknown): string | null {
  if (!isRecord(value)) return null
  for (const key of ['requestId', 'request_id', 'id']) if (typeof value[key] === 'string' || typeof value[key] === 'number') return String(value[key])
  return null
}

function readTurnId(message: Record<string, any>): string | null {
  const params = isRecord(message.params) ? message.params : message
  for (const key of ['turnId', 'turn_id']) if (typeof params[key] === 'string') return params[key]
  if (isRecord(params.turn) && typeof params.turn.id === 'string') return params.turn.id
  return null
}

function normalizeStatus(value: unknown): 'started' | 'running' | 'completed' | 'failed' | undefined {
  if (value === 'started' || value === 'running' || value === 'completed' || value === 'failed') return value
  return undefined
}

function readId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.threadId === 'string') return value.threadId
  if (typeof value.id === 'string') return value.id
  if (isRecord(value.thread) && typeof value.thread.id === 'string') return value.thread.id
  return null
}
