import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
  CodingNsAgentEvent,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, JsonRpcRequestError, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, usageChunk } from './rpc-driver-utils.js'
import { ZCODE_CATALOG } from './model-catalog.js'
import { desktopCliRuntimeCommand, resolveZCodeDesktopRuntime, type CodingNsDesktopAppRuntime } from './desktop-app-runtime.js'
import { promptWithAttachmentPaths } from './attachment-utils.js'

export interface ZcodeCliDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

interface ZcodeSession {
  readonly rpc: JsonRpcProcess
  readonly cwd: string | undefined
  /** '' 表示尚未创建 ZCode 会话；创建后为 CLI 原生 sess_* 标识。 */
  acpSessionId: string
  providerSessionId: string
  /** turn.terminal 事件里的真实失败码与信息，随错误透传给用户。 */
  failureCode: string | undefined
  failureMessage: string | undefined
  /** 回合是否已经进入 running；idle 终态只有在 running 后才算成功收尾。 */
  sawRunning: boolean
}

interface ZcodeTurnEventQueue {
  next(): Promise<IteratorResult<JsonRpcMessage>>
  push(message: JsonRpcMessage): void
  close(): void
}

/**
 * ZCode 驱动：通过 `zcode app-server` 的 ZCode Protocol（{id, method, params}
 * 裸信封）驱动桌面端自带的 zcode.cjs 或 PATH 上的独立 CLI，结构与 Codex 驱动
 * 一致——按 DSH 会话维护持久 app 进程，跨回合复用。
 *
 * 会话流程：session/create|resume → session/send。服务端会在创建期间反向请求
 * session/requestRuntimePreferences，这里用固定默认值应答；模型跟随 CLI 自己
 * 的选择（独立 CLI 的提供商注册表需先在终端 `zcode login` 后才可用）。回合
 * 终态以 state.updated（status=idle / prompt_failed）、computer-use
 * turn-failed 与 v4/telemetry turn.terminal（携带真实 errorCode/errorMessage）
 * 为准。
 */
export class ZcodeAppServerDriver implements CodingNsCliDriver {
  readonly descriptor = {
    id: 'zcode',
    name: 'ZCode',
    protocol: 'json-rpc',
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'reasoning', 'usage'],
  } as const
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private cachedRuntime: CodingNsDesktopAppRuntime | null | undefined
  private cachedBinary: string | null = null
  private readonly sessions = new Map<string, ZcodeSession>()
  private readonly processes = new Set<JsonRpcProcess>()
  private cachedCatalog: CodingNsCliModelCatalog | null = null

  constructor(options: ZcodeCliDriverOptions = {}) {
    this.binaries = options.binaries ?? ['zcode', 'zcode.cmd']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const binary = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (binary.installed) {
      this.cachedBinary = binary.command
      return binary
    }
    const runtime = this.resolveRuntime()
    if (runtime !== null) return { installed: true, version: runtime.appVersion, command: runtime.entry }
    return binary
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    if (!(await this.detect()).installed) return emptyCatalog()
    if (this.cachedCatalog !== null) return this.cachedCatalog
    let rpc: JsonRpcProcess | null = null
    try {
      rpc = this.startAppServer()
      this.installServerRequestHandler(rpc)
      await this.syncAccountProviderConfig(rpc)
      const created = await rpc.request('session/create', {
        workspace: zcodeWorkspace(process.cwd()),
        persistence: 'deferred',
      })
      const catalog = catalogFromZcodeSnapshot(created)
      if (catalog.groups.length > 0) this.cachedCatalog = catalog
      return catalog.groups.length > 0 ? catalog : ZCODE_CATALOG
    } catch {
      return this.cachedCatalog ?? ZCODE_CATALOG
    } finally {
      rpc?.dispose()
    }
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    const providerSessionId = input.providerSessionId?.trim()
    if (providerSessionId === undefined || providerSessionId === '') {
      return { state: 'unknown', reason: '缺少 Provider 会话标识' }
    }
    let rpc: JsonRpcProcess | null = null
    try {
      rpc = this.startAppServer()
      const timer = setTimeout(() => rpc?.dispose(), 12_000)
      timer.unref?.()
      const result = await rpc.request('session/list', {}) as { sessions?: ReadonlyArray<{ sessionId?: unknown }> } | undefined
      clearTimeout(timer)
      const sessions = result?.sessions ?? []
      const found = sessions.some((session) => session.sessionId === providerSessionId)
      return found
        ? { state: 'available', reason: 'Provider 会话仍存在' }
        : { state: 'missing', reason: 'Provider 会话已被删除' }
    } catch (error) {
      return { state: 'unknown', reason: `会话探测失败: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      rpc?.dispose()
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    if (!(await this.detect()).installed) throw new Error('ZCode 未安装')
    const session = await this.getSession(input)
    // 每轮都清掉上一轮的终态痕迹；常驻 session 可能连续发送多轮。
    session.sawRunning = false
    session.failureCode = undefined
    session.failureMessage = undefined
    if (session.acpSessionId === '') {
      let created: unknown
      await this.syncAccountProviderConfig(session.rpc, input.signal)
      if (input.providerSessionId !== undefined) {
        try {
          created = await session.rpc.request('session/resume', { sessionId: input.providerSessionId, workspace: zcodeWorkspace(input.cwd) }, { signal: input.signal, killOnAbort: false })
        } catch {
          // Provider 会话被清理后，新建 DSH 会话仍应可继续工作；绑定会在
          // create 响应中更新，不能把旧 ID 当成当前会话。
          created = undefined
        }
      }
      if (created === undefined) {
        created = await session.rpc.request('session/create', {
          workspace: zcodeWorkspace(input.cwd),
          persistence: 'deferred',
        }, { signal: input.signal, killOnAbort: false })
      }
      session.acpSessionId = readSessionId(created) ?? input.sessionId
      const catalog = catalogFromZcodeSnapshot(created)
      if (catalog.groups.length > 0) this.cachedCatalog = catalog
    }
    yield { type: 'session-binding', providerSessionId: session.acpSessionId }

    await this.applyModelSelection(session, input)

    const eventQueue = createZcodeTurnEventQueue()
    let rpcExited = false
    const removeExitListener = session.rpc.addExitListener(() => {
      rpcExited = true
      eventQueue.close()
    })
    let sendResolved = false
    let sendError: unknown = null
    // session/resume 的重放通知不能进入当前回合；监听器先于 send 注册并缓存
    // 响应前的通知，send 响应返回后再统一消费。监听器必须挂会话级（请求级的
    // 会在 send 响应返回即被移除，回合终态事件就再也进不来）。
    const notificationsBeforeSend: JsonRpcMessage[] = []
    const onNotification = (message: JsonRpcMessage): void => {
      // turn.terminal 详情略晚于 turn-failed 事件到达，宽限期结束前必须已经
      // 记下真实 errorCode/errorMessage。
      captureZcodeFailureDetail(message, session)
      if (!sendResolved) {
        notificationsBeforeSend.push(message)
        return
      }
      eventQueue.push(message)
    }
    const removeNotificationListener = session.rpc.addNotificationListener(onNotification)
    const sendPromise = session.rpc.request('session/send', {
      sessionId: session.acpSessionId,
      content: promptWithAttachmentPaths(input.prompt, input.attachments ?? []),
    }, { signal: input.signal, killOnAbort: false })
      .then(() => undefined, (error: unknown) => { sendError = error })
    const onAbort = (): void => {
      void session.rpc.request('session/stop', { sessionId: session.acpSessionId }).catch(() => undefined)
    }
    if (input.signal?.aborted) onAbort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      await sendPromise
      if (sendError !== null && !input.signal?.aborted) throw new Error('ZCode 消息发送失败')
      sendResolved = true
      for (const message of notificationsBeforeSend.splice(0)) eventQueue.push(message)

      let terminalReason: 'stop' | 'cancel' | 'error' | null = null
      while (true) {
        const next = await eventQueue.next()
        if (next.done) break
        const chunk = zcodeMessageToChunk(next.value, session, input)
        if (chunk !== null) yield chunk
        terminalReason = readZcodeTerminalReason(next.value, session, input) ?? terminalReason
        if (terminalReason !== null) {
          if (terminalReason === 'error') {
            // turn.terminal 详情（errorCode/errorMessage）略晚于 turn-failed
            // 到达，稍等再透出真实原因。
            await new Promise((resolve) => setTimeout(resolve, 1_500))
            yield failureChunk(session)
          }
          eventQueue.close()
          break
        }
      }
      if (rpcExited && !input.signal?.aborted) throw new Error('Agent 进程已退出')
      if (terminalReason === 'stop' || terminalReason === null) {
        if (input.signal?.aborted) {
          terminalReason = 'cancel'
        } else {
          // usage 查询属于正常终态的一部分，不能因为 idle 事件先到就跳过。
          const usage = await readSessionUsage(session.rpc, session.acpSessionId)
          if (usage !== null) yield usage
          const appUsage = await readApplicationUsage(session.rpc)
          if (appUsage !== null) yield appUsage
          terminalReason = 'stop'
        }
      }
      if (terminalReason === 'error') {
        // 失败详情已经在通知监听器中捕获；这里统一发唯一终态。
        yield { type: 'finish', reason: 'error' }
      } else if (terminalReason !== null) {
        yield { type: 'finish', reason: input.signal?.aborted ? 'cancel' : terminalReason }
      } else {
        // 理论上只剩取消信号，但保留稳定终态，避免上层收到无 finish 的流。
        yield { type: 'finish', reason: 'cancel' }
      }
    } catch (error) {
      if (!input.signal?.aborted) throw error
      yield { type: 'finish', reason: 'cancel' }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      removeNotificationListener()
      removeExitListener()
      eventQueue.close()
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    await session.rpc.request('session/stop', { sessionId: session.acpSessionId }).catch(() => undefined)
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.rpc.dispose()
    this.sessions.clear()
    for (const rpc of this.processes) rpc.dispose()
    this.processes.clear()
    this.cachedRuntime = undefined
    this.cachedBinary = null
    this.cachedCatalog = null
  }

  private resolveRuntime(): CodingNsDesktopAppRuntime | null {
    if (this.cachedRuntime === undefined) this.cachedRuntime = resolveZCodeDesktopRuntime()
    return this.cachedRuntime
  }

  private startAppServer(): JsonRpcProcess {
    if (this.cachedBinary !== null) {
      return new JsonRpcProcess({ command: this.cachedBinary, args: ['app-server'], wireFormat: 'zcode', spawn: this.runSpawn })
    }
    const runtime = this.resolveRuntime()
    if (runtime !== null) {
      const node = desktopCliRuntimeCommand()
      return new JsonRpcProcess({
        command: quoteWindowsArg(node.command),
        // JsonRpcProcess 在 Windows 上经 shell 启动；node 与入口安装路径（如
        // D:\Program Files\…）都可能含空格，command 和入口参数都必须先加引号。
        args: [quoteWindowsArg(runtime.entry), 'app-server'],
        env: { ...node.env, ...runtime.env },
        wireFormat: 'zcode',
        spawn: this.runSpawn,
      })
    }
    const binary = this.cachedBinary ?? 'zcode'
    return new JsonRpcProcess({ command: binary, args: ['app-server'], wireFormat: 'zcode', spawn: this.runSpawn })
  }

  /** 复用同 cwd 的常驻 app 进程；cwd 变化或进程死亡时重建并重新挂载会话。 */
  private async getSession(input: CodingNsCliTurnInput): Promise<ZcodeSession> {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd && !previous.rpc.isClosed) return previous
    previous?.rpc.dispose()
    const rpc = this.startAppServer()
    const session: ZcodeSession = {
      rpc,
      cwd: input.cwd,
      acpSessionId: '',
      providerSessionId: input.providerSessionId ?? input.sessionId,
      sawRunning: false,
      failureCode: undefined,
      failureMessage: undefined,
    }
    this.processes.add(rpc)
    this.sessions.set(input.sessionId, session)
    rpc.addExitListener(() => {
      this.processes.delete(rpc)
      if (this.sessions.get(input.sessionId)?.rpc === rpc) this.sessions.delete(input.sessionId)
    })
    // ZCode Protocol 没有 initialize 握手（服务端会回 Method not found），
    // 服务端反向请求（运行时偏好 / 插件 MCP 认证头）必须在首个请求前就绪。
    rpc.setServerRequestHandler((request) => {
      // 创建期间的运行时偏好与插件 MCP 认证头都按固定默认值应答；模型跟随
      // CLI 自己的选择。
      if (request.method === 'session/requestRuntimePreferences') {
        return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true }
      }
      return {}
    })
    return session
  }

  private installServerRequestHandler(rpc: JsonRpcProcess): void {
    rpc.setServerRequestHandler((request) => {
      if (request.method === 'session/requestRuntimePreferences') {
        return { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true }
      }
      return {}
    })
  }

  private async syncAccountProviderConfig(rpc: JsonRpcProcess, signal?: AbortSignal): Promise<void> {
    if (this.cachedBinary !== null) return
    const runtime = this.resolveRuntime()
    if (runtime === null) return
    const snapshot = readZcodeAccountProviderSnapshot(runtime)
    if (snapshot === null) return
    try {
      await rpc.request('provider/updateAccountConfig', snapshot, { signal, killOnAbort: false })
    } catch (error) {
      // 旧版 app-server 没有该方法时仍允许使用默认模型；新版本的真实
      // Provider 目录则必须在 create 前完成同步，失败直接交给 create 处理。
      if (!isMethodUnavailable(error)) throw error
    }
  }

  private async applyModelSelection(session: ZcodeSession, input: CodingNsCliTurnInput): Promise<void> {
    if ((input.modelId === undefined || input.modelId.trim() === '' || input.modelId === 'provider-default') &&
      (input.effortId === undefined || input.effortId.trim() === '')) return
    const selection = resolveZcodeModelSelection(input.modelId, input.effortId, this.cachedCatalog)
    if (selection === null) throw new Error(`ZCode 模型选择无效: ${input.modelId ?? 'provider-default'}`)
    await session.rpc.request('session/setModel', {
      sessionId: session.acpSessionId,
      model: selection,
      persistAsWorkspaceLastUsed: false,
    }, { signal: input.signal, killOnAbort: false })
  }
}

/** turn.terminal 失败详情（errorCode/errorMessage）在通知到达时即捕获。 */
function captureZcodeFailureDetail(message: JsonRpcMessage, session: ZcodeSession): void {
  if (message.method !== 'v4/telemetry/event') return
  const params = isRecord(message.params) ? message.params : {}
  if (params.kind !== 'turn.terminal' || params.status !== 'failed') return
  if (typeof params.errorCode === 'string' && params.errorCode.trim() !== '') session.failureCode = params.errorCode
  if (typeof params.errorMessage === 'string' && params.errorMessage.trim() !== '') session.failureMessage = params.errorMessage
}

/** ZCode 回合通知 → 单个统一事件；终态由 readZcodeTerminalReason 单独表达。 */
function zcodeMessageToChunk(message: JsonRpcMessage, session: ZcodeSession, input: CodingNsCliTurnInput): CodingNsAgentEvent | null {
  const method = typeof message.method === 'string' ? message.method : ''
  if (method === '' || method.startsWith('startup/') || method.startsWith('process/')) return null
  const params = isRecord(message.params) ? message.params : {}

  if (method === 'v4/telemetry/event') {
    if (params.kind === 'turn.terminal' && params.status === 'failed') {
      session.failureCode = typeof params.errorCode === 'string' ? params.errorCode : undefined
      session.failureMessage = typeof params.errorMessage === 'string' ? params.errorMessage : undefined
    }
    return null
  }
  if (method === 'computer-use/operation-event') {
    const kind = typeof params.kind === 'string' ? params.kind : ''
    if (kind === 'turn-failed' || kind.includes('fail')) {
      session.failureCode = session.failureCode ?? 'turn_failed'
    }
    return null
  }
  if (method === 'state.updated') {
    const reason = typeof params.reason === 'string' ? params.reason : ''
    const patch = isRecord(params.patch) ? params.patch : {}
    if (reason === 'prompt_started' || patch.status === 'running') session.sawRunning = true
    if (reason.includes('failed')) {
      session.failureCode = session.failureCode ?? 'prompt_failed'
    }
    return null
  }

  // 其余消息类通知做保守的正文提取：params 里的 delta/text/content 字符串。
  const text = firstText(params.delta, params.text, params.content)
  if (text !== null) return { type: 'text-delta', text }
  return null
}

/** 从通知流推定回合是否已终态；返回 null 表示回合仍在进行。 */
function readZcodeTerminalReason(
  message: JsonRpcMessage,
  session: ZcodeSession,
  input: CodingNsCliTurnInput,
): 'stop' | 'cancel' | 'error' | null {
  if (input.signal?.aborted) return 'cancel'
  const method = typeof message.method === 'string' ? message.method : ''
  const params = isRecord(message.params) ? message.params : {}
  if (method === 'state.updated') {
    const reason = typeof params.reason === 'string' ? params.reason : ''
    const patch = isRecord(params.patch) ? params.patch : {}
    if (reason.includes('failed')) return 'error'
    // 成功终态：回合进入过 running 后回到 idle。
    if (session.sawRunning && patch.status === 'idle') return 'stop'
  }
  if (method === 'computer-use/operation-event') {
    const kind = typeof params.kind === 'string' ? params.kind : ''
    if (kind === 'turn-failed' || kind.includes('fail')) return 'error'
    if (kind.includes('complete')) return 'stop'
  }
  if (method === 'v4/telemetry/event') {
    if (params.kind === 'turn.terminal') return params.status === 'failed' ? 'error' : 'stop'
  }
  return null
}

function failureChunk(session: ZcodeSession): CodingNsAgentEvent {
  const code = session.failureCode
  const detail = session.failureMessage
  const hint = code === 'provider_not_found'
    ? '（ZCode 独立运行时还没有可用的模型提供商：请在终端执行一次 zcode login 完成登录后重试）'
    : ''
  return {
    type: 'text-snapshot',
    text: `ZCode 回合失败${code ? ` [${code}]` : ''}${detail ? `：${detail}` : ''}${hint}`,
  }
}

async function readSessionUsage(rpc: JsonRpcProcess, sessionId: string): Promise<CodingNsAgentEvent | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3_000)
    timer.unref?.()
    const usage = await rpc.request('session/usage', { sessionId }, { signal: controller.signal })
    clearTimeout(timer)
    return usageChunk(usage)
  } catch {
    return null
  }
}

function zcodeWorkspace(cwd: string | undefined): { workspacePath: string; workspaceKey: string } {
  const workspacePath = cwd?.trim() !== '' && cwd !== undefined ? cwd : process.cwd()
  return { workspacePath, workspaceKey: workspacePath }
}

function readSessionId(created: unknown): string | undefined {
  if (typeof created !== 'object' || created === null) return undefined
  const session = (created as Record<string, any>).session
  if (typeof session === 'object' && session !== null) {
    const id = (session as Record<string, any>).sessionId
    if (typeof id === 'string' && id !== '') return id
  }
  const direct = (created as Record<string, any>).sessionId
  return typeof direct === 'string' && direct !== '' ? direct : undefined
}

function firstText(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** Windows shell 拼接前的引号保护：安全字符集直接通过，其余成对引号包裹。 */
function quoteWindowsArg(value: string): string {
  if (process.platform !== 'win32') return value
  if (/^[A-Za-z0-9_./\\:-]+$/u.test(value)) return value
  return `"${value.replace(/"/gu, '""')}"`
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function catalogFromZcodeSnapshot(value: unknown): CodingNsCliModelCatalog {
  const root = isRecord(value) && isRecord(value.snapshot) ? value.snapshot : value
  const settings = isRecord(root) && isRecord(root.settings) ? root.settings : undefined
  const modelSettings = settings !== undefined && isRecord(settings.model) ? settings.model : undefined
  const available = modelSettings !== undefined && Array.isArray(modelSettings.available) ? modelSettings.available : []
  const groups = new Map<string, { name: string; models: CodingNsCliModelCatalog['groups'][number]['models'][number][] }>()
  for (const item of available) {
    if (!isRecord(item) || !isRecord(item.ref)) continue
    const providerId = typeof item.ref.providerId === 'string' ? item.ref.providerId.trim() : ''
    const modelId = typeof item.ref.modelId === 'string' ? item.ref.modelId.trim() : ''
    if (!providerId || !modelId) continue
    const efforts = isRecord(item.reasoning) && Array.isArray(item.reasoning.levels)
      ? item.reasoning.levels.flatMap((level) => isRecord(level) && typeof level.value === 'string' ? [level.value] : [])
      : []
    const group = groups.get(providerId) ?? { name: typeof item.providerLabel === 'string' ? item.providerLabel : providerId, models: [] }
    group.models.push({
      id: `${providerId}/${modelId}`,
      name: typeof item.label === 'string' && item.label.trim() !== '' ? item.label : modelId,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      efforts: [...new Set(efforts)],
    })
    groups.set(providerId, group)
  }
  const current = modelSettings !== undefined && isRecord(modelSettings.current) ? modelSettings.current : undefined
  const currentModel = current !== undefined && typeof current.providerId === 'string' && typeof current.modelId === 'string'
    ? `${current.providerId}/${current.modelId}` : null
  const currentEffort = current !== undefined && isRecord(current.options) && typeof current.options.reasoningLevel === 'string'
    ? current.options.reasoningLevel : null
  return {
    groups: [...groups.entries()].map(([id, group]) => ({ id, name: group.name, models: group.models })),
    currentModel,
    currentEffort,
  }
}

function resolveZcodeModelSelection(
  modelId: string | undefined,
  effortId: string | undefined,
  catalog: CodingNsCliModelCatalog | null,
): Record<string, unknown> | null {
  const requested = modelId?.trim() ?? ''
  const effectiveRequested = !requested || requested === 'provider-default' ? catalog?.currentModel ?? '' : requested
  if (!effectiveRequested) return null
  const entries = (catalog?.groups ?? []).flatMap((group) => group.models.map((model) => ({ group, model })))
  const found = entries.find(({ model }) => model.id === effectiveRequested)
    ?? (entries.length > 0 && !effectiveRequested.includes('/') ? entries.find(({ model }) => model.id.endsWith(`/${effectiveRequested}`)) : undefined)
  if (found === undefined) return null
  const effort = effortId?.trim()
  if (effort !== undefined && effort !== '' && !found.model.efforts.includes(effort)) {
    throw new Error(`ZCode 思维强度不可用: ${effort}`)
  }
  return {
    providerId: found.group.id,
    modelId: found.model.id.slice(found.group.id.length + 1),
    ...(effort ? { options: { reasoningLevel: effort } } : {}),
  }
}

function readZcodeAccountProviderSnapshot(runtime: CodingNsDesktopAppRuntime): Record<string, unknown> | null {
  const file = runtime.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  if (typeof file !== 'string' || file.trim() === '') return null
  try {
    const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
    const rules = document.config?.providerConfigRules?.providerRules
    if (!Array.isArray(rules)) return null
    const settings = readJsonFile(join(homedir(), '.zcode', 'v2', 'setting.json'))
    const preferred = resolvePreferredAccountProvider(rules, settings)
    const providers: Record<string, unknown> = {}
    const states: Record<string, unknown> = {}
    for (const rule of rules) {
      if (!isRecord(rule) || typeof rule.providerId !== 'string' || !rule.providerId.startsWith('account:')) continue
      const config = isRecord(rule.config) ? rule.config : {}
      const active = rule.providerId === preferred
      providers[rule.providerId] = {
        access: { type: 'zhipu-account', entitled: active },
        ...(active && Array.isArray(config.builtinModelIds) ? { builtinModelIds: config.builtinModelIds } : {}),
      }
      states[rule.providerId] = {
        availability: active ? 'available' : 'unavailable',
        entitled: active,
        current: active,
        ...(active ? {} : { unavailableReason: 'not-entitled' }),
      }
    }
    if (preferred === null) return null
    const basedOn = `zcode-builtin:${String(document.revision ?? 0)}:${createHash('sha256').update(file).digest('hex')}`
    return {
      revision: `account:${JSON.stringify([basedOn, providers, states])}`,
      basedOnZCodeBuiltinRevision: basedOn,
      providers,
      states,
    }
  } catch {
    return null
  }
}

function resolvePreferredAccountProvider(
  rules: readonly unknown[],
  settings: Record<string, any> | null,
): string | null {
  const ids = new Set(rules.flatMap((rule) => isRecord(rule) && typeof rule.providerId === 'string' && rule.providerId.startsWith('account:') ? [rule.providerId] : []))
  const selections = settings?.providerFamilyConnectionSelections
  if (isRecord(selections)) {
    for (const [family, selection] of Object.entries(selections)) {
      const kind = isRecord(selection) && typeof selection.kind === 'string' ? selection.kind : ''
      const candidate = `account:${family}-${kind}`
      if (ids.has(candidate)) return candidate
    }
  }
  return null
}

function readJsonFile(path: string): Record<string, any> | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function isMethodUnavailable(error: unknown): boolean {
  return error instanceof JsonRpcRequestError && (error.code === -32601 || error.code === -32001)
}

async function readApplicationUsage(rpc: JsonRpcProcess): Promise<CodingNsAgentEvent | null> {
  for (const method of ['v4/usage/stats', 'usage/stats']) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 500)
    try {
      const value = await rpc.request(method, { range: 'all' }, { signal: controller.signal, killOnAbort: false })
      const summary = isRecord(value) && isRecord(value.summary) ? value.summary : value
      return usageChunk(summary)
    } catch {
      // 旧版只提供 session/usage；继续尝试兼容方法。
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

function createZcodeTurnEventQueue(): ZcodeTurnEventQueue {
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
  }
}
