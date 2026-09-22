import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CodingNsCliModelCatalog, CodingNsCliPermissionResponse, CodingNsCliStreamChunk, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, textValue, usageChunk } from './rpc-driver-utils.js'
import { CODEX_CATALOG, isProviderDefaultModel } from './model-catalog.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, normalizeToolStatus, serializeToolValue } from './tool-observation.js'

export interface CodexAppServerDriverOptions {
  readonly binaries?: readonly string[]
  readonly sessionRoots?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/** Codex app-server 的 JSON-RPC 驱动，Host 只暴露统一文本流，不暴露线程和 token。 */
export class CodexAppServerDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'codex', name: 'Codex', protocol: 'json-rpc', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'steer'] as const } as const
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly sessionRoots: readonly string[]
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
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.sessionRoots = options.sessionRoots ?? [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]
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

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path).endsWith(`${id}.jsonl`),
      validate: async (path, id) => {
        const record = await readFirstJsonRecord(path)
        return isRecord(record?.payload) && record.payload.id === id
      },
    })
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
      const eventQueue = createCodexTurnEventQueue()
      let activeTurnId: string | null = null
      let terminalReason: 'stop' | 'cancel' | 'error' | null = null
      const onNotification = (message: JsonRpcMessage): void => {
        if (!isCodexNotificationForTurn(message, session.threadId, activeTurnId)) return
        const turnId = readTurnId(message)
        if (turnId !== null) {
          activeTurnId = turnId
          session.turnId = turnId
        }
        eventQueue.push(message)
        const reason = readCodexTerminalReason(message)
        if (reason !== null) {
          terminalReason = reason
          eventQueue.close()
        }
      }
      // 与父仓库 CodexRuntimeAdapter 一致：监听器必须先于 turn/start 注册，
      // 否则响应前到达的 turn/started 或文本通知也会丢失。
      const removeNotificationListener = rpc.addNotificationListener(onNotification)
      const onAbort = (): void => {
        terminalReason = 'cancel'
        eventQueue.close()
      }
      if (input.signal?.aborted) onAbort()
      else input.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await rpc.request('turn/start', {
          threadId: session.threadId,
          input: [{ type: 'text', text: input.prompt }],
          ...(input.effortId ? { effort: input.effortId } : {}),
        }, { signal: input.signal, killOnAbort: false })
        const responseTurnId = readTurnId(response)
        if (responseTurnId !== null) {
          activeTurnId = responseTurnId
          session.turnId = responseTurnId
        }
        // 某些 app-server 会直接在 turn/start 响应中返回终态。父仓库把它
        // 归一化成 turn/completed，这里复用同一规则，避免永久等待通知。
        const responseTerminal = buildCodexCompletionNotification(response, session.threadId)
        if (responseTerminal !== null) onNotification(responseTerminal)

        for await (const message of eventQueue.iterable) {
          const chunk = codexMessageToChunk(message)
          if (chunk !== null) yield chunk
        }
        if (input.signal?.aborted) await this.interrupt(input.sessionId)
      } catch (error) {
        if (!input.signal?.aborted) throw error
        await this.interrupt(input.sessionId)
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
        removeNotificationListener()
        eventQueue.close()
      }
      yield { type: 'finish', reason: input.signal?.aborted ? 'cancel' : terminalReason ?? 'stop' }
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
  if (isCodexToolEvent(method, type)) {
    const name = firstToolText(item.name, item.toolName, item.tool, item.command !== undefined ? 'command_execution' : undefined, type)
    const callId = firstToolText(item.callId, item.call_id, item.toolCallId, item.id, params.itemId)
    const agentId = firstToolText(item.agentId, item.agent_id, type.includes('agent') || type.includes('collab') ? item.id : undefined)
    const input = serializeToolValue(item.arguments ?? item.input ?? item.command)
    const rawOutput = item.result ?? item.output ?? item.aggregated_output
    const explicitError = serializeToolValue(item.error)
    const output = serializeToolValue(rawOutput)
    const exitCodeFailed = typeof item.exitCode === 'number' && item.exitCode !== 0 || typeof item.exit_code === 'number' && item.exit_code !== 0
    const failed = explicitError !== undefined || exitCodeFailed || method.includes('failed') || normalizeToolStatus(item.status ?? item.state, 'running') === 'failed'
    const fallback = failed ? 'failed' : method.includes('completed') || output !== undefined ? 'completed' : 'running'
    const detail = serializeToolValue(item.detail ?? item.description)
    return {
      type: 'tool-running',
      toolName: name ?? (agentId ? 'subagent' : 'tool'),
      status: normalizeToolStatus(item.status ?? item.state, fallback),
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(failed
        ? { error: explicitError ?? output ?? `exit code ${String(item.exitCode ?? item.exit_code)}` }
        : output === undefined ? {} : { output }),
      ...(!failed && output !== undefined ? { outputMode: 'snapshot' as const } : {}),
      ...(agentId ? { agentId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }
  return usageChunk(params)
}

function readRequestId(value: unknown): string | null {
  if (!isRecord(value)) return null
  for (const key of ['requestId', 'request_id', 'id']) if (typeof value[key] === 'string' || typeof value[key] === 'number') return String(value[key])
  return null
}

function readTurnId(message: unknown): string | null {
  if (!isRecord(message)) return null
  const params = isRecord(message.params) ? message.params : message
  for (const key of ['turnId', 'turn_id']) if (typeof params[key] === 'string') return params[key]
  if (isRecord(params.turn) && typeof params.turn.id === 'string') return params.turn.id
  return null
}

/**
 * 复用父仓库 CodexRuntimeAdapter 的事件队列结构：终止时先排空已入队事件，
 * 再结束异步迭代，保证 turn/completed 前到达的最后一个文本片段不会丢失。
 */
function createCodexTurnEventQueue(): {
  readonly iterable: AsyncIterable<JsonRpcMessage>
  push(message: JsonRpcMessage): void
  close(): void
} {
  const values: JsonRpcMessage[] = []
  const waiters: Array<(result: IteratorResult<JsonRpcMessage>) => void> = []
  let closed = false
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<JsonRpcMessage>> {
            const value = values.shift()
            if (value !== undefined) return Promise.resolve({ done: false, value })
            if (closed) return Promise.resolve({ done: true, value: undefined })
            return new Promise((resolve) => waiters.push(resolve))
          },
        }
      },
    },
    push(message) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ done: false, value: message })
      else values.push(message)
    },
    close() {
      if (closed) return
      closed = true
      while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined })
    },
  }
}

/** 只接收当前 thread/turn 的事件，避免子 Agent 的完成通知提前结束父轮次。 */
function isCodexNotificationForTurn(message: JsonRpcMessage, threadId: string, turnId: string | null): boolean {
  const params = isRecord(message.params) ? message.params : null
  const notificationThreadId = readScopedId(params, ['threadId', 'thread_id'], 'thread')
  const notificationTurnId = readTurnId(message)
  if (notificationThreadId !== null && notificationThreadId !== threadId) return false
  return turnId === null || notificationTurnId === null || notificationTurnId === turnId
}

function readCodexTerminalReason(message: JsonRpcMessage): 'stop' | 'cancel' | 'error' | null {
  if (message.method === 'error') {
    const params = isRecord(message.params) ? message.params : null
    return params?.willRetry === true ? null : 'error'
  }
  if (message.method !== 'turn/completed') return null
  const params = isRecord(message.params) ? message.params : null
  const turn = isRecord(params?.turn) ? params.turn : null
  if (turn?.status === 'failed') return 'error'
  if (turn?.status === 'interrupted' || turn?.status === 'cancelled') return 'cancel'
  return 'stop'
}

/** 将 turn/start 响应里的终态归一化成父仓库使用的 turn/completed 通知。 */
function buildCodexCompletionNotification(value: unknown, threadId: string): JsonRpcMessage | null {
  if (!isRecord(value) || !isRecord(value.turn)) return null
  const status = value.turn.status
  if (status !== 'completed' && status !== 'failed' && status !== 'interrupted' && status !== 'cancelled') return null
  return { method: 'turn/completed', params: { threadId, turn: value.turn } }
}

function readScopedId(value: Record<string, any> | null, keys: readonly string[], nestedKey: string): string | null {
  if (value === null) return null
  for (const key of keys) if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
  const nested = value[nestedKey]
  return isRecord(nested) && typeof nested.id === 'string' && nested.id.trim() ? nested.id.trim() : null
}

function isCodexToolEvent(method: string, type: string): boolean {
  if (method.includes('command') || method.includes('tool') || method.includes('agent')) return true
  const normalized = type.replace(/[_-]/gu, '').toLowerCase()
  return ['commandexecution', 'filechange', 'mcptoolcall', 'functioncall', 'customtoolcall', 'dynamictoolcall'].includes(normalized)
}

function readId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.threadId === 'string') return value.threadId
  if (typeof value.id === 'string') return value.id
  if (isRecord(value.thread) && typeof value.thread.id === 'string') return value.thread.id
  return null
}
