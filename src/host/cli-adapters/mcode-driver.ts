import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import type {
  CodingNsAgentEvent,
  CodingNsCliModelCatalog,
  CodingNsCliPermissionState,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, usageChunk } from './rpc-driver-utils.js'
import { MINIMAX_CODE_CATALOG, isProviderDefaultModel } from './model-catalog.js'
import { buildMcodeCatalog, parseMcodeModelCatalog, readMcodeConfigYaml } from './mcode-catalog.js'
import { probeStoredSession } from './session-probe.js'
import { buildAcpPromptBlocks, promptWithAttachmentPaths } from './attachment-utils.js'
import { firstToolText, serializeToolValue } from './tool-observation.js'
import { terminateChildProcess, WINDOWS } from './process-utils.js'

export interface MiniMaxCodeDriverOptions {
  readonly binaries?: readonly string[]
  readonly sessionRoots?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

interface McodeSession {
  readonly rpc: JsonRpcProcess
  readonly cwd: string | undefined
  /** '' 表示尚未创建 ACP 会话；创建后为 CLI 原生 mvs_* 标识。 */
  acpSessionId: string
  providerSessionId: string
  permission: CodingNsCliPermissionState | undefined
}

/** 显式非默认档位时 exec 是官方唯一精确下发思考档位的入口。 */
const EXEC_ONLY_EFFORT = true

/**
 * MiniMax Code（mcode）驱动：通过 `mcode acp` 的 Agent Client Protocol 常驻
 * 进程驱动 CLI，结构与 Codex 驱动一致——按 DSH 会话维护持久 app 进程，跨回合
 * 复用以消除冷启动；正文以 agent_message_chunk 增量流式到达。会话 id 与 CLI
 * 自己的存储一致（mvs_*），进程重启后用 session/load 重新挂载历史。
 *
 * 思考档位：ACP 无档位通道，默认/未选档位走 ACP 快路径；显式选择非默认档位
 * 时改走 `mcode exec --effort` 单发（官方唯一精确档位入口），同样逐字流式。
 * 档位清单动态读取官方 `~/.minimax/config.yaml`（effortOptions/defaultEffort）。
 */
export class MiniMaxCodeDriver implements CodingNsCliDriver {
  readonly descriptor = {
    id: 'mcode',
    name: 'MiniMax Code',
    protocol: 'acp',
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'],
  } as const
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly sessionRoots: readonly string[]
  private readonly minimaxHome: string
  private cachedBinary: string | null = null
  private mcodeCatalog: CodingNsCliModelCatalog | undefined
  private readonly sessions = new Map<string, McodeSession>()
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly execChildren = new Map<string, ChildProcessWithoutNullStreams>()

  constructor(options: MiniMaxCodeDriverOptions = {}) {
    this.binaries = options.binaries ?? ['mcode', 'mcode.cmd']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    const minimaxHome = process.env.MINIMAX_HOME ?? join(homedir(), '.minimax')
    this.minimaxHome = minimaxHome
    this.sessionRoots = options.sessionRoots ?? [join(minimaxHome, 'v2', 'sessions'), join(minimaxHome, 'sessions')]
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    if (!(await this.detect()).installed) return emptyCatalog()
    // 与 codex 同思路：档位以 CLI 自己声明的目录为准。codex 读 model/list 的
    // supportedReasoningEfforts；mcode 的同源数据在官方 config.yaml 的
    // effortOptions/defaultEffort。解析失败回退内置清单。
    const configYaml = readMcodeConfigYaml(this.minimaxHome)
    const data = configYaml === null ? null : parseMcodeModelCatalog(configYaml)
    if (data === null) return MINIMAX_CODE_CATALOG
    this.mcodeCatalog = buildMcodeCatalog(data)
    return this.mcodeCatalog
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => {
        if (!entry.isDirectory()) return false
        const encoded = Buffer.from(id, 'utf8').toString('base64')
        return entry.name.includes(id) || entry.name.includes(encoded)
      },
      validate: async () => true,
    })
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error('MiniMax Code 未安装')
    const effort = input.effortId?.trim()
    if (EXEC_ONLY_EFFORT && effort !== undefined && effort !== '' && effort !== 'default' && isCatalogEffort(input.modelId, effort, this.effortCatalog())) {
      yield* this.executeExecTurn(input, command)
      return
    }
    const session = await this.getSession(input, command)
    session.permission = input.permission
    if (session.acpSessionId === '') {
      const attached = input.providerSessionId === undefined
        ? await session.rpc.request('session/new', { cwd: input.cwd ?? process.cwd(), mcpServers: [] }, { signal: input.signal, killOnAbort: false })
        : await this.loadSessionWithFallback(session, input)
      session.acpSessionId = readAcpSessionId(attached) ?? input.providerSessionId ?? `mvs_acp_fallback_${Date.now().toString(36)}`
    }
    yield { type: 'session-binding', providerSessionId: session.acpSessionId }
    if (input.modelId && !isProviderDefaultModel(input.modelId)) {
      await session.rpc.request('session/set_model', { sessionId: session.acpSessionId, modelId: input.modelId }).catch(() => undefined)
    }

    const eventQueue = createMcodeTurnEventQueue()
    let rpcExited = false
    const removeExitListener = session.rpc.addExitListener(() => {
      rpcExited = true
      eventQueue.close()
    })
    let sendResolved = false
    // session/load 的重放通知不能进入当前回合；监听器在 load 之后注册，天然
    // 只收 prompt 期间的更新。响应可能先于最后一条 update 到达，用竞速收尾。
    let sendError: unknown = null
    let promptResult: unknown
    const promptBlocks = await buildAcpPromptBlocks(input.prompt, input.attachments ?? [])
    const sendPromise = session.rpc.request('session/prompt', {
      sessionId: session.acpSessionId,
      prompt: promptBlocks,
    }, { onNotification: (message) => {
      // 请求级监听器会收到该 ACP 进程上的所有会话通知；并发子代理或续聊时，
      // 其他会话迟到的 closing message 会混入当前回合，按 sessionId 过滤。
      if (isRecord(message.params) && typeof message.params.sessionId === 'string'
        && message.params.sessionId !== session.acpSessionId) return
      eventQueue.push(message)
    }, signal: input.signal, killOnAbort: false })
      .then((value) => { sendError = undefined; promptResult = value; return value }, (error: unknown) => { sendError = error })
    const onAbort = (): void => {
      void session.rpc.request('session/cancel', { sessionId: session.acpSessionId }).catch(() => undefined)
      eventQueue.close()
    }
    if (input.signal?.aborted) onAbort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      while (true) {
        const next = await Promise.race([
          eventQueue.next(),
          sendPromise.then(() => ({ __response: true as const })),
        ])
        if (next !== null && typeof next === 'object' && '__response' in next) break
        if (next.done) break
        const chunk = mcodeAcpMessageToChunk(next.value, input)
        if (chunk !== null) yield chunk
      }
      await sendPromise.catch(() => undefined)
      if (isProcessDead(sendError)) throw sendError
      if (rpcExited && !input.signal?.aborted) throw new Error('Agent 进程已退出')
      if (!eventQueue.terminated) {
        yield { type: 'finish', reason: mcodePromptReason(promptResult, input.signal) }
      }
    } catch (error) {
      if (!input.signal?.aborted) throw error
      yield { type: 'finish', reason: 'cancel' }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      removeExitListener()
      eventQueue.close()
    }
  }

  /** 显式思考档位路径：`mcode exec --effort` 单发，提示词经 stdin 下发。 */
  private async *executeExecTurn(input: CodingNsCliTurnInput, command: string): AsyncGenerator<CodingNsAgentEvent> {
    const args = ['exec', '--output-format', 'stream-json', '--input', '-']
    if (input.cwd) args.push('--cwd', quoteWindowsArg(input.cwd))
    if (input.providerSessionId) args.push('--session', input.providerSessionId)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', quoteWindowsArg(input.modelId))
    const effort = input.effortId?.trim()
    if (effort !== undefined && effort !== '' && isCatalogEffort(input.modelId, effort, this.effortCatalog())) {
      args.push('--effort', quoteWindowsArg(effort))
    }
    const child = this.runSpawn(command, args, {
      cwd: input.cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: WINDOWS,
    }) as ChildProcessWithoutNullStreams
    this.execChildren.set(input.sessionId, child)
    let emittedFinish = false
    let emittedBinding = input.providerSessionId !== undefined
    const onAbort = (): void => { terminateChildProcess(child) }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    child.stderr.on('data', () => undefined)
    try {
      child.stdin.end(`${promptWithAttachmentPaths(input.prompt, input.attachments ?? [])}\n`, 'utf8')
      const lines = readline.createInterface({ input: child.stdout })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          const parsed = parseJsonLine(line)
          if (parsed === null) continue
          if (!emittedBinding) {
            const providerSessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim() !== '' ? parsed.sessionId.trim() : null
            if (providerSessionId !== null) {
              emittedBinding = true
              yield { type: 'session-binding', providerSessionId }
            }
          }
          const chunk = mcodeExecEventToChunk(parsed, input)
          if (chunk === null) continue
          if (chunk.type === 'finish') emittedFinish = true
          yield chunk
        }
      } finally { lines.close() }
      if (!emittedFinish) {
        if (input.signal?.aborted) yield { type: 'finish', reason: 'cancel' }
        else throw new Error('MiniMax Code 执行失败')
      }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      this.execChildren.delete(input.sessionId)
      terminateChildProcess(child)
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) {
      await session.rpc.request('session/cancel', { sessionId: session.acpSessionId }).catch(() => undefined)
    }
    const child = this.execChildren.get(sessionId)
    if (child !== undefined) terminateChildProcess(child)
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.rpc.dispose()
    this.sessions.clear()
    for (const rpc of this.processes) rpc.dispose()
    this.processes.clear()
    for (const child of this.execChildren.values()) terminateChildProcess(child)
    this.execChildren.clear()
    this.cachedBinary = null
  }

  /** 复用同 cwd 的常驻 ACP 进程；cwd 变化或进程死亡时重建并重新挂载会话。 */
  private async getSession(input: CodingNsCliTurnInput, command: string): Promise<McodeSession> {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd && !previous.rpc.isClosed) return previous
    previous?.rpc.dispose()
    const rpc = new JsonRpcProcess({ command, args: ['acp'], cwd: input.cwd, spawn: this.runSpawn })
    const session: McodeSession = {
      rpc,
      cwd: input.cwd,
      acpSessionId: '',
      providerSessionId: input.providerSessionId ?? input.sessionId,
      permission: input.permission,
    }
    this.processes.add(rpc)
    this.sessions.set(input.sessionId, session)
    rpc.addExitListener(() => {
      this.processes.delete(rpc)
      if (this.sessions.get(input.sessionId)?.rpc === rpc) this.sessions.delete(input.sessionId)
    })
    rpc.setServerRequestHandler((request) => {
      if (request.method === 'session/request_permission') return approveFirstAcpOption(request, session.permission)
      throw new Error('请求不受支持')
    })
    try {
      await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, { signal: input.signal, killOnAbort: false })
      rpc.notify('initialized', {})
    } catch (error) {
      rpc.dispose()
      if (this.sessions.get(input.sessionId)?.rpc === rpc) this.sessions.delete(input.sessionId)
      throw error
    }
    return session
  }

  /** 优先 session/load 挂载原生会话；过期或不存在时退回 session/new。 */
  private async loadSessionWithFallback(session: McodeSession, input: CodingNsCliTurnInput): Promise<unknown> {
    if (input.providerSessionId !== undefined) {
      try {
        return await session.rpc.request('session/load', {
          sessionId: input.providerSessionId,
          cwd: input.cwd ?? process.cwd(),
          mcpServers: [],
        }, { signal: input.signal, killOnAbort: false })
      } catch {
        session.providerSessionId = input.sessionId
      }
    }
    return await session.rpc.request('session/new', { cwd: input.cwd ?? process.cwd(), mcpServers: [] }, { signal: input.signal, killOnAbort: false })
  }

  private effortCatalog(): CodingNsCliModelCatalog {
    if (this.mcodeCatalog !== undefined) return this.mcodeCatalog
    const configYaml = readMcodeConfigYaml(this.minimaxHome)
    const data = configYaml === null ? null : parseMcodeModelCatalog(configYaml)
    if (data !== null) this.mcodeCatalog = buildMcodeCatalog(data)
    return this.mcodeCatalog ?? MINIMAX_CODE_CATALOG
  }
}

/** 档位必须出现在该模型的官方 effortOptions 里才会下发给 CLI。 */
function isCatalogEffort(modelId: string | undefined, effortId: string, catalog: CodingNsCliModelCatalog): boolean {
  const model = modelId?.trim().toLowerCase()
  for (const group of catalog.groups) {
    for (const entry of group.models) {
      if (entry.id.toLowerCase() !== model) continue
      return entry.efforts.some((effort) => effort.toLowerCase() === effortId.toLowerCase())
    }
  }
  return false
}

function isProcessDead(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Agent 进程已退出')
}

interface McodeTurnEventQueue {
  next(): Promise<IteratorResult<JsonRpcMessage>>
  push(message: JsonRpcMessage): void
  close(): void
  readonly terminated: boolean
}

function createMcodeTurnEventQueue(): McodeTurnEventQueue {
  const pending: JsonRpcMessage[] = []
  let wake: (() => void) | undefined
  let closed = false
  return {
    async next(): Promise<IteratorResult<JsonRpcMessage>> {
      if (pending.length > 0) return { value: pending.shift()!, done: false }
      if (closed) return { value: undefined, done: true }
      await new Promise<void>((resolve) => { wake = resolve })
      if (pending.length > 0) return { value: pending.shift()!, done: false }
      return { value: undefined, done: true }
    },
    push(message: JsonRpcMessage): void {
      pending.push(message)
      wake?.()
      wake = undefined
    },
    close(): void {
      closed = true
      wake?.()
      wake = undefined
    },
    get terminated(): boolean {
      return closed
    },
  }
}

function mcodePromptReason(result: unknown, signal: AbortSignal | undefined): 'stop' | 'cancel' | 'error' {
  if (signal?.aborted) return 'cancel'
  if (!isRecord(result) || typeof result.stopReason !== 'string') return 'stop'
  const reason = result.stopReason.toLowerCase()
  if (reason === 'cancelled') return 'cancel'
  if (reason === 'error' || reason === 'failed') return 'error'
  return 'stop'
}

/** ACP session/update → 单个统一事件；终态由 finish 通道单独表达。 */
function mcodeAcpMessageToChunk(message: JsonRpcMessage, input: CodingNsCliTurnInput): CodingNsAgentEvent | null {
  if (message.method !== 'session/update') return null
  const params = isRecord(message.params) ? message.params : {}
  const update = isRecord(params.update) ? params.update : null
  if (update === null) return null
  const kind = firstToolText(update.sessionUpdate)?.toLowerCase() ?? ''
  if (kind === 'agent_message_chunk') {
    const text = acpText(update.content)
    return text === null ? null : { type: 'text-delta', text }
  }
  if (kind === 'agent_thought_chunk') {
    const text = acpText(update.content)
    return text === null ? null : { type: 'reasoning-delta', text }
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const failed = firstToolText(update.status) === 'failed'
    const output = acpText(update.content ?? update.rawOutput)
    return {
      type: 'tool-event',
      toolName: firstToolText(update.title, update.toolName) ?? 'tool',
      status: kind === 'tool_call' ? 'running' : failed ? 'failed' : 'completed',
      ...(firstToolText(update.toolCallId, update.id) ? { callId: firstToolText(update.toolCallId, update.id)! } : {}),
      ...(firstToolText(update.title) ? { detail: firstToolText(update.title)! } : {}),
      ...(output !== null ? { output } : {}),
      ...(output !== null ? { outputMode: 'snapshot' as const } : {}),
      ...(input.signal?.aborted ? { error: '已取消' } : {}),
    }
  }
  if (kind === 'usage_update') {
    return usageChunk(isRecord(update.usage) ? update.usage : update)
  }
  return null
}

/** exec stream-json 事件 → 单个统一事件；exec.completed/failed 是终态。 */
function mcodeExecEventToChunk(value: Record<string, unknown>, input: CodingNsCliTurnInput): CodingNsAgentEvent | null {
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : ''
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = isRecord(value.item) ? value.item : null
    if (item === null) return null
    const itemId = firstToolText(item.id) ?? ''
    const itemType = firstToolText(item.type)?.toLowerCase() ?? ''
    if (itemType === 'agent_message') {
      if (!type.includes('completed')) {
        const delta = firstToolText(item.contentDelta)
        if (delta === undefined) return null
        return { type: 'text-delta', text: delta }
      }
      const text = firstToolText(item.content)
      return text === undefined ? null : { type: 'text-snapshot', text }
    }
    if (itemType === 'reasoning' || itemType.includes('think')) {
      const text = firstToolText(item.contentDelta, item.content)
      if (text === undefined) return null
      return type.includes('completed') ? { type: 'reasoning-snapshot', text } : { type: 'reasoning-delta', text }
    }
    const toolName = firstToolText(item.toolName)
      ?? (itemType === 'command_execution' ? 'command' : itemType === 'file_change' ? 'file-change' : itemType === 'mcp_tool_call' ? 'mcp' : itemType || null)
    if (toolName === null) return null
    const error = item.exitCode !== undefined && item.exitCode !== 0 ? `exit ${String(item.exitCode)}` : undefined
    return {
      type: 'tool-event',
      toolName,
      status: type.includes('completed') ? (error !== undefined ? 'failed' : 'completed') : 'running',
      ...(itemId ? { callId: itemId } : {}),
      ...(serializeToolValue(item.command ?? item.toolName) !== undefined ? { input: serializeToolValue(item.command ?? item.toolName)! } : {}),
      ...(serializeToolValue(item.aggregatedOutput ?? item.changes) !== undefined ? { output: serializeToolValue(item.aggregatedOutput ?? item.changes)! } : {}),
      ...(error !== undefined ? { error } : {}),
    }
  }
  if (type === 'turn.completed') {
    return usageChunk(isRecord(value.usage) ? value.usage : null)
  }
  if (type === 'turn.failed') {
    const failure = isRecord(value.error) ? value.error : null
    const reason = firstToolText(failure?.message, value.error)
    return { type: 'text-snapshot', text: `MiniMax Code 回合失败${reason ? `：${reason}` : ''}` }
  }
  if (type === 'exec.completed') {
    const result = isRecord(value.result) ? value.result : null
    const status = typeof result?.status === 'string' ? result.status : 'succeeded'
    return { type: 'finish', reason: input.signal?.aborted ? 'cancel' : status === 'succeeded' ? 'stop' : 'error' }
  }
  if (type === 'exec.failed' || type === 'error') {
    return { type: 'finish', reason: 'error' }
  }
  return null
}

function approveFirstAcpOption(message: JsonRpcMessage, permission: CodingNsCliPermissionState | undefined): unknown {
  // 当前 Host 没有把 ACP 的逐次审批请求接到 DSH 审批 UI；只有 DSH 明确给出
  // 完全访问且策略为 never 时才能自动选择 Provider 的一次性授权。其余情况拒绝，
  // 避免把 read-only、workspace-write 或缺省权限偷偷升级成可执行权限。
  if (permission?.sandboxMode !== 'danger-full-access' || permission.approvalPolicy !== 'never') {
    return { outcome: { outcome: 'cancelled' } }
  }
  const params = isRecord(message.params) ? message.params : null
  const options = Array.isArray(params?.options) ? params!.options : []
  const allowOnce = options.find((option) => isRecord(option) && option.kind === 'allow_once')
  const allowAlways = options.find((option) => isRecord(option) && option.kind === 'allow_always')
  const choice = allowOnce ?? allowAlways ?? options[0]
  const optionId = isRecord(choice) && choice.id !== undefined ? choice.id : undefined
  return optionId !== undefined
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

function readAcpSessionId(created: unknown): string | undefined {
  if (!isRecord(created)) return undefined
  const id = created.sessionId
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
}

function acpText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (Array.isArray(value)) {
    const joined = value.map((item) => acpText(item) ?? '').join('')
    return joined === '' ? null : joined
  }
  if (isRecord(value)) {
    for (const key of ['text', 'delta', 'content']) {
      if (key in value) {
        const nested = acpText(value[key])
        if (nested !== null) return nested
      }
    }
  }
  return null
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch { return null }
}

/** Windows shell 拼接前的引号保护：安全字符集直接通过，其余成对引号包裹。 */
function quoteWindowsArg(value: string): string {
  if (!WINDOWS) return value
  if (/^[A-Za-z0-9_./\\:-]+$/u.test(value)) return value
  return `"${value.replace(/"/gu, '""')}"`
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
