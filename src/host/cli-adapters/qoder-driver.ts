import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  CodingNsAgentEvent,
  CodingNsAgentPermissionResponse,
  CodingNsAgentQuestionResponse,
  CodingNsCliModelCatalog,
  CodingNsCliPermissionState,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { buildAcpPromptBlocks } from './attachment-utils.js'
import { acpBridgeMcpServers } from '../cli-bridge/injections.js'
import { isRecord, usageChunk } from './rpc-driver-utils.js'
import { firstToolText, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { reasoningText } from './reasoning-content.js'
import { ACP_FORM_CLIENT_CAPABILITIES, acpElicitationResponse, readAcpElicitationRequest, type AcpElicitationRequest } from './acp-elicitation.js'

/** Qoder 的两个发行身份共用协议和驱动，只在这里保存产品差异。 */
export type QoderCliVariant = 'qoder' | 'qoder-cn'

export interface QoderCliProfile {
  readonly variant: QoderCliVariant
  readonly id: 'qoder' | 'qoder-cn'
  readonly name: 'Qoder' | 'Qoder CN'
  readonly binaries: readonly string[]
  readonly tokenEnv: 'QODER_PERSONAL_ACCESS_TOKEN' | 'QODERCN_PERSONAL_ACCESS_TOKEN'
  readonly userConfigEnv: 'QODER_USER_CONFIG_DIR' | 'QODERCN_USER_CONFIG_DIR'
  readonly userConfigDirectory: '.qoder' | '.qoder-cn'
}

export const QODER_PROFILES: Readonly<Record<QoderCliVariant, QoderCliProfile>> = {
  qoder: {
    variant: 'qoder',
    id: 'qoder',
    name: 'Qoder',
    binaries: ['qoder', 'qodercli', 'qoder.cmd', 'qodercli.cmd'],
    tokenEnv: 'QODER_PERSONAL_ACCESS_TOKEN',
    userConfigEnv: 'QODER_USER_CONFIG_DIR',
    userConfigDirectory: '.qoder',
  },
  'qoder-cn': {
    variant: 'qoder-cn',
    id: 'qoder-cn',
    name: 'Qoder CN',
    binaries: ['qodercn', 'qoderclicn', 'qodercn.cmd', 'qoderclicn.cmd'],
    tokenEnv: 'QODERCN_PERSONAL_ACCESS_TOKEN',
    userConfigEnv: 'QODERCN_USER_CONFIG_DIR',
    userConfigDirectory: '.qoder-cn',
  },
} as const

export interface QoderCliDriverOptions {
  /** 默认是国际版 Qoder；Qoder CN 传入 `variant: 'qoder-cn'`。 */
  readonly variant?: QoderCliVariant
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  /** 测试或托管环境可覆盖进程环境；不会改变宿主进程的 process.env。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** 测试时覆盖 Qoder 用户目录；生产环境使用当前用户 Home。 */
  readonly homeDirectory?: string
}

interface PendingPermission {
  readonly promise: Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly allowOptionId: string
  readonly rejectOptionId: string
}

interface QoderSession {
  readonly rpc: JsonRpcProcess
  readonly cwd: string | undefined
  readonly effortId: string | undefined
  readonly permissionMode: string
  acpSessionId: string
  permission: CodingNsCliPermissionState | undefined
  pendingPermissions: Map<string, PendingPermission>
  pendingQuestions: Map<string, AcpElicitationRequest>
  eventQueue: QoderTurnEventQueue | undefined
}

/** Qoder ACP 在未返回动态模型目录时的保守目录。 */
export const QODER_CATALOG: CodingNsCliModelCatalog = {
  groups: [{
    id: 'qoder',
    name: 'Qoder',
    models: [{ id: 'provider-default', name: '跟随 Qoder 默认模型', efforts: [] }],
  }],
  currentModel: null,
  currentEffort: null,
}

/**
 * Qoder/Qoder CN 官方 ACP 客户端。
 *
 * 这里仅依赖 CLI 的 `--acp` 公共入口，不依赖 qoder-agent-sdk。ACP 会话存储
 * 位置没有公开只读索引，因此 probeSession 明确返回 unknown，避免用 resume
 * 或 prompt 之类有副作用的请求伪造“会话存在”。
 */
export class QoderCliDriver implements CodingNsCliDriver {
  readonly descriptor: {
    readonly id: 'qoder' | 'qoder-cn'
    readonly name: 'Qoder' | 'Qoder CN'
    readonly protocol: 'acp'
    readonly capabilities: readonly ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions']
  }
  private readonly profile: QoderCliProfile
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly baseEnvironment: Readonly<Record<string, string | undefined>>
  private readonly homeDirectory: string
  private cachedBinary: string | null = null
  private readonly sessions = new Map<string, QoderSession>()
  private readonly processes = new Set<JsonRpcProcess>()
  // Qoder ACP 的通知队列可以在工具完成后暂停并由 Registry 续读；它不自行伪造
  // Provider turn，因此使用通用工具分步能力，而不是 supportsSegmentedTurns。
  readonly supportsToolStepSplitting = true

  constructor(options: QoderCliDriverOptions = {}) {
    this.profile = QODER_PROFILES[options.variant ?? 'qoder']
    this.binaries = options.binaries ?? this.profile.binaries
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.baseEnvironment = qoderEnvironment(this.profile, options.environment ?? process.env)
    this.descriptor = {
      id: this.profile.id,
      name: this.profile.name,
      protocol: 'acp',
      capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions'],
    }
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    if (this.cachedBinary !== null) {
      const version = readVersion(this.runSpawnSync, this.cachedBinary, this.baseEnvironment)
      if (version !== null) return { installed: true, version, command: this.cachedBinary }
      this.cachedBinary = null
    }
    for (const binary of this.binaries) {
      const version = readVersion(this.runSpawnSync, binary, this.baseEnvironment)
      if (version === null) continue
      this.cachedBinary = binary
      return { installed: true, version, command: binary }
    }
    return { installed: false, version: null, command: null }
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detected = await this.detect()
    if (detected.command === null) return { groups: [], currentModel: null, currentEffort: null }
    // Qoder CLI 自己公开了只读 --list-models，不能再用 ACP session/new 冒充目录探测。
    // 该命令在缓存命中和联网刷新两种情况下都返回同一张用户可用目录表。
    try {
      const result = this.runSpawnSync(detected.command, ['--list-models'], {
        encoding: 'utf8', timeout: 15_000, windowsHide: true, env: this.baseEnvironment,
      } as SpawnSyncOptions & { encoding: 'utf8' })
      if (result.status === 0) {
        const catalog = parseQoderModelList(`${result.stdout ?? ''}\n${result.stderr ?? ''}`, this.profile)
        if (catalog.groups[0]?.models.length) return catalog
      }
    } catch { /* 目录刷新失败时继续使用明确的保守回退 */ }
    return { ...qoderCatalogForProfile(this.profile), fallback: true }
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    // Qoder 没有公开会话目录和只读索引接口；禁止以 ACP resume/load 代替探测。
    return {
      state: 'unknown',
      reason: 'Qoder ACP 未公开可安全读取的会话索引，无法在不改变 Provider 状态的前提下探测',
      ...(input.rawStoreRef?.trim() ? { rawStoreRef: input.rawStoreRef.trim() } : {}),
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error(`${this.profile.name} 未安装`)
    const session = await this.getSession(input, command)
    session.permission = input.permission
    if (session.acpSessionId === '') {
      const attached = input.providerSessionId === undefined
        ? await this.startSession(session, input)
        : await this.loadSession(session, input)
      session.acpSessionId = readSessionId(attached) ?? input.providerSessionId ?? input.sessionId
    }
    yield { type: 'session-binding', providerSessionId: session.acpSessionId }
    if (input.modelId?.trim() && input.modelId !== 'provider-default') {
      await session.rpc.request('session/set_model', { sessionId: session.acpSessionId, modelId: input.modelId }, { signal: input.signal, killOnAbort: false }).catch(() => undefined)
    }

    const eventQueue = createQoderTurnEventQueue()
    session.eventQueue = eventQueue
    let assistantMessageSegment = 0
    const toolNames = new Map<string, string>()
    let promptResult: unknown
    let promptError: unknown
    let rpcExited = false
    let streamedUsage: Extract<CodingNsAgentEvent, { type: 'usage' }> | null = null
    const removeExitListener = session.rpc.addExitListener(() => { rpcExited = true; eventQueue.close() })
    const promptBlocks = await buildAcpPromptBlocks(input.prompt, input.attachments ?? [])
    const sendPromise = session.rpc.request('session/prompt', {
      sessionId: session.acpSessionId,
      prompt: promptBlocks,
    }, {
      signal: input.signal,
      killOnAbort: false,
      onNotification: (message) => {
        // JsonRpcProcess 会先通知监听器，再在下一个微任务调用 server handler。
        // 先登记权限 deferred，确保 UI 消费 permission-request 后可以立即应答。
        if (message.method === 'session/request_permission' && permissionRequestId(message) !== null) this.ensurePermission(session, message)
        if (message.method === 'elicitation/create' && readAcpElicitationRequest(message) !== null) this.ensureQuestion(session, message)
        if (belongsToSession(message, session.acpSessionId)) eventQueue.push(message)
      },
    }).then((value) => { promptResult = value; return value }, (error: unknown) => { promptError = error; return undefined })
    const onAbort = (): void => {
      void session.rpc.request('session/cancel', { sessionId: session.acpSessionId }, { killOnAbort: false }).catch(() => undefined)
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
        const chunk = qoderAcpMessageToChunk(next.value, input, toolNames, assistantMessageSegment)
        if (chunk?.type === 'usage') streamedUsage = mergeQoderUsage(streamedUsage, chunk)
        else if (chunk !== null) yield chunk
        if (chunk?.type === 'tool-event' && (chunk.status === 'completed' || chunk.status === 'failed')) {
          assistantMessageSegment += 1
        }
      }
      await sendPromise.catch(() => undefined)
      if (promptError !== undefined && !input.signal?.aborted) throw promptError
      if (rpcExited && !input.signal?.aborted) throw new Error(`${this.profile.name} ACP 进程已退出`)
      // Qoder 可能在通知流、session/prompt 终态或本地 transcript 中分别
      // 报告 usage；统一合并后只投影一条，避免不完整通知覆盖真实上下文。
      const usage = mergeQoderUsage(
        mergeQoderUsage(streamedUsage, qoderUsageChunk(promptResult)),
        readQoderTranscriptUsage(this.homeDirectory, this.profile, input.cwd, session.acpSessionId),
      )
      if (usage !== null) yield usage
      yield { type: 'finish', reason: qoderPromptReason(promptResult, input.signal) }
    } catch (error) {
      if (!input.signal?.aborted) throw error
      yield { type: 'finish', reason: 'cancel' }
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      removeExitListener()
      if (session.eventQueue === eventQueue) session.eventQueue = undefined
      eventQueue.close()
    }
  }

  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const session = this.sessions.get(sessionId)
    const pending = session?.pendingPermissions.get(response.requestId)
    if (session === undefined || pending === undefined) throw new Error(`${this.profile.name} 权限请求不存在`)
    session.pendingPermissions.delete(response.requestId)
    pending.resolve({ outcome: { outcome: 'selected', optionId: response.approved ? pending.allowOptionId : pending.rejectOptionId } })
  }

  respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): void {
    const session = this.sessions.get(sessionId)
    const pending = session?.pendingQuestions.get(response.requestId)
    if (session === undefined || pending === undefined) throw new Error(`${this.profile.name} 问题请求不存在`)
    session.pendingQuestions.delete(response.requestId)
    session.rpc.respond(pending.rpcId, acpElicitationResponse(pending, response))
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.acpSessionId === '') return
    await session.rpc.request('session/cancel', { sessionId: session.acpSessionId }, { killOnAbort: false }).catch(() => undefined)
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.rpc.dispose()
    this.sessions.clear()
    for (const rpc of this.processes) rpc.dispose()
    this.processes.clear()
    this.cachedBinary = null
  }

  private async getSession(input: CodingNsCliTurnInput, command: string): Promise<QoderSession> {
    const previous = this.sessions.get(input.sessionId)
    const permissionMode = qoderPermissionMode(input.permission)
    if (previous !== undefined && previous.cwd === input.cwd && previous.effortId === normalizedEffort(input.effortId) && previous.permissionMode === permissionMode && !previous.rpc.isClosed) return previous
    previous?.rpc.dispose()
    const session: QoderSession = {
      rpc: new JsonRpcProcess({ command, args: qoderAcpArgs(input.effortId, input.permission), cwd: input.cwd, env: this.baseEnvironment, spawn: this.runSpawn }),
      cwd: input.cwd,
      effortId: normalizedEffort(input.effortId),
      permissionMode,
      acpSessionId: '',
      permission: input.permission,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      eventQueue: undefined,
    }
    this.sessions.set(input.sessionId, session)
    this.processes.add(session.rpc)
    session.rpc.addExitListener(() => {
      this.processes.delete(session.rpc)
      if (this.sessions.get(input.sessionId)?.rpc === session.rpc) this.sessions.delete(input.sessionId)
    })
    session.rpc.setServerRequestHandler((request) => {
      const elicitation = readAcpElicitationRequest(request)
      if (elicitation !== null) {
        session.pendingQuestions.set(elicitation.requestId, elicitation)
        return new Promise<never>(() => undefined)
      }
      if (request.method === 'elicitation/create') return { action: 'cancel' }
      if (request.method !== 'session/request_permission') return { outcome: { outcome: 'cancelled' } }
      const requestId = permissionRequestId(request)
      if (requestId === null) return { outcome: { outcome: 'cancelled' } }
      return this.ensurePermission(session, request)
    })
    try {
      await session.rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'codingns4dsh', version: '0.2.0' },
        // Qoder 1.1 的 ACP schema 不接受空的 fs/terminal capability 对象；
        // Qoder 自己负责工具执行，Host 只声明基础协议能力即可。
        clientCapabilities: ACP_FORM_CLIENT_CAPABILITIES,
      }, { signal: input.signal, killOnAbort: false })
      session.rpc.notify('initialized', {})
      return session
    } catch (error) {
      session.rpc.dispose()
      this.sessions.delete(input.sessionId)
      throw error
    }
  }

  private async startSession(session: QoderSession, input: CodingNsCliTurnInput): Promise<unknown> {
    return session.rpc.request('session/new', {
      cwd: input.cwd ?? process.cwd(),
      mcpServers: acpBridgeMcpServers(input.sessionId, this.profile.id),
    }, { signal: input.signal, killOnAbort: false })
  }

  private async loadSession(session: QoderSession, input: CodingNsCliTurnInput): Promise<unknown> {
    // Provider 会话不存在时必须保留失败诊断，不能退回新会话并重复发送原请求。
    return session.rpc.request('session/load', {
      sessionId: input.providerSessionId,
      cwd: input.cwd ?? process.cwd(),
      mcpServers: acpBridgeMcpServers(input.sessionId, this.profile.id),
    }, { signal: input.signal, killOnAbort: false })
  }

  private ensurePermission(session: QoderSession, request: JsonRpcMessage): Promise<unknown> {
    const requestId = permissionRequestId(request)!
    const existing = session.pendingPermissions.get(requestId)
    if (existing !== undefined) return existing.promise
    let resolve!: (value: unknown) => void
    const promise = new Promise<unknown>((value) => { resolve = value })
    const options = permissionOptions(request)
    const pending: PendingPermission = {
      promise,
      resolve,
      allowOptionId: options.allow,
      rejectOptionId: options.reject,
    }
    session.pendingPermissions.set(requestId, pending)
    return promise
  }

  private ensureQuestion(session: QoderSession, request: JsonRpcMessage): void {
    const elicitation = readAcpElicitationRequest(request)
    if (elicitation !== null) session.pendingQuestions.set(elicitation.requestId, elicitation)
  }
}

function qoderEnvironment(profile: QoderCliProfile, source: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...source }
  // 两套 CLI 不能继承对方的登录票据或用户配置根；否则 Qoder CN 可能静默复用国际版登录态。
  delete env[profile.variant === 'qoder' ? 'QODERCN_PERSONAL_ACCESS_TOKEN' : 'QODER_PERSONAL_ACCESS_TOKEN']
  delete env[profile.variant === 'qoder' ? 'QODERCN_USER_CONFIG_DIR' : 'QODER_USER_CONFIG_DIR']
  env[profile.userConfigEnv] = profile.userConfigDirectory
  return env
}

function normalizedEffort(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized === undefined || normalized === '' || normalized === 'default' ? undefined : normalized
}

function qoderAcpArgs(effortId: string | undefined, permission: CodingNsCliPermissionState | undefined): string[] {
  // Qoder 默认 ACP 模式是 `default`，即使 `ls`、`find` 这类只读操作也可能弹出
  // Provider 自己的 Bash 审批。DSH 已经负责统一审批展示，使用 Qoder 的安全
  // 分类模式让只读操作直接通过，同时仍让写入和高风险命令进入安全判定。
  const args = ['--acp', '--permission-mode', qoderPermissionMode(permission)]
  const effort = normalizedEffort(effortId)
  if (effort !== undefined && ['low', 'medium', 'high'].includes(effort)) args.push('--reasoning-effort', effort)
  return args
}

function qoderPermissionMode(permission: CodingNsCliPermissionState | undefined): 'auto' | 'dont_ask' | 'bypass_permissions' {
  if (permission?.approvalPolicy !== 'never') return 'auto'
  return permission.sandboxMode === 'danger-full-access' ? 'bypass_permissions' : 'dont_ask'
}

function readVersion(run: typeof spawnSync, command: string, env: Readonly<Record<string, string | undefined>>): string | null {
  try {
    const result = run(command, ['--version'], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true, env,
    } as SpawnSyncOptions & { encoding: 'utf8' })
    if (result.status !== 0) return null
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0] ?? null
  } catch {
    return null
  }
}

function qoderCatalogForProfile(profile: QoderCliProfile): CodingNsCliModelCatalog {
  return {
    ...QODER_CATALOG,
    groups: [{
      ...QODER_CATALOG.groups[0]!,
      id: profile.id,
      name: profile.name,
      models: QODER_CATALOG.groups[0]!.models.map((model) => model.id === 'provider-default'
        ? { ...model, name: `跟随 ${profile.name} 默认模型` }
        : model),
    }],
  }
}

const QODER_REASONING_EFFORTS = ['low', 'medium', 'high'] as const
/** Qoder ACP 返回的稳定 modelId；--list-models 只打印 display name。 */
const QODER_MODEL_IDS: Readonly<Record<string, string>> = {
  auto: 'auto',
  'qwen3.8-max': 'qmodel_38max',
  'qwen3.8-flash': 'qfmodel',
  'qwen3.7-max': 'qmodel_latest',
  'qwen3.7-plus': 'qmodel',
  'qwen3.7-flash': 'q37fmodel',
  'deepseek-v4-pro': 'dmodel',
  'deepseek-flash': 'dfmodel',
  'glm-5.3': 'gmodel',
  'glm-5.3-flash': 'gfmodel',
  'glm-5.2': 'gm51model',
  'kimi-k3': 'kmodel_latest',
  'kimi-k2.8-preview': 'kmodel',
  'minimax-m2.7': 'mmodel',
}
const QODER_NON_REASONING_MODELS = new Set(['deepseek-flash', 'kimi-k3', 'minimax-m2.7'])

/** 解析 qodercn --list-models 的稳定表格输出。 */
export function parseQoderModelList(output: string, profile: QoderCliProfile = QODER_PROFILES['qoder-cn']): CodingNsCliModelCatalog {
  const models = output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/gu, '').trim())
    .filter((line) => line !== '' && !/^model$/iu.test(line) && !/^[-_]+$/u.test(line))
    .map((line) => line.split(/\s{2,}|\t/u)[0]?.trim() ?? line)
    .filter((name) => name !== '' && !/^(?:qoder(?:cn|cli)?|qoderclicn)\s+\d+\./iu.test(name))
    .filter((name, index, all) => all.indexOf(name) === index)
  if (models.length === 0) return qoderCatalogForProfile(profile)
  const entries = models.map((name) => {
    const isAuto = /^auto$/iu.test(name)
    const normalized = name.toLowerCase()
    const id = isAuto ? 'provider-default' : QODER_MODEL_IDS[normalized] ?? name
    const efforts = QODER_NON_REASONING_MODELS.has(normalized) ? [] : [...QODER_REASONING_EFFORTS]
    return {
      id,
      name: isAuto ? `跟随 ${profile.name} 默认模型` : name,
      efforts,
    }
  })
  return {
    groups: [{ id: profile.id, name: profile.name, models: entries }],
    // CLI 没有公开当前线程选择；把“当前”交给 Registry 的会话偏好恢复。
    currentModel: null,
    currentEffort: null,
  }
}

function readSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId === 'string' && value.sessionId.trim()) return value.sessionId.trim()
  if (isRecord(value.session) && typeof value.session.id === 'string' && value.session.id.trim()) return value.session.id.trim()
  return typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null
}

function belongsToSession(message: JsonRpcMessage, sessionId: string): boolean {
  if (!isRecord(message.params)) return true
  const params = message.params
  const candidate = typeof params.sessionId === 'string' ? params.sessionId : isRecord(params.update) && typeof params.update.sessionId === 'string' ? params.update.sessionId : undefined
  return candidate === undefined || candidate === sessionId
}

function permissionRequestId(message: JsonRpcMessage): string | null {
  if (typeof message.id === 'string' || typeof message.id === 'number') return String(message.id)
  if (!isRecord(message.params)) return null
  const id = message.params.requestId ?? message.params.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

function permissionOptions(message: JsonRpcMessage): { allow: string; reject: string } {
  const params = isRecord(message.params) ? message.params : {}
  const options = Array.isArray(params.options) ? params.options : []
  const ids = options.flatMap((option) => {
    if (!isRecord(option)) return []
    const id = typeof option.optionId === 'string' ? option.optionId : typeof option.id === 'string' ? option.id : null
    const kind = typeof option.kind === 'string' ? option.kind.toLowerCase() : ''
    return id === null ? [] : [{ id, kind }]
  })
  return {
    allow: ids.find((option) => /allow|approve|accept/u.test(option.kind))?.id ?? ids[0]?.id ?? 'allow-once',
    reject: ids.find((option) => /reject|deny|cancel/u.test(option.kind))?.id ?? 'reject-once',
  }
}

function qoderPromptReason(value: unknown, signal: AbortSignal | undefined): 'stop' | 'cancel' | 'error' {
  if (signal?.aborted) return 'cancel'
  if (!isRecord(value) || typeof value.stopReason !== 'string') return 'stop'
  const reason = value.stopReason.toLowerCase()
  if (reason.includes('cancel')) return 'cancel'
  if (reason.includes('error') || reason.includes('fail')) return 'error'
  return 'stop'
}

type QoderUsageEvent = Extract<CodingNsAgentEvent, { type: 'usage' }>

/**
 * 把 Qoder ACP 终态中的 usage 和 quota token_count 合并成公共事件。
 *
 * Qoder CN 1.1.65 的真实响应同时存在两套字段：`result.usage` 使用 camelCase，
 * `_meta.quota.token_count` 可能携带 token 计数。若前者只返回 0，不能覆盖后者
 * 的非零值，因此这里对 token 桶做“非零优先”合并，再交给公共归一化函数。
 */
export function qoderUsageChunk(value: unknown): QoderUsageEvent | null {
  if (!isRecord(value)) return null
  const usage = isRecord(value.usage) ? value.usage : value
  const meta = isRecord(value._meta) ? value._meta : undefined
  const quota = meta !== undefined && isRecord(meta.quota) ? meta.quota : undefined
  const tokenCount = quota !== undefined && isRecord(quota.token_count) ? quota.token_count : undefined
  if (tokenCount === undefined) {
    const result = usageChunk(usage)
    return result?.type === 'usage' ? result : null
  }
  const merged: Record<string, unknown> = { ...tokenCount, ...usage }
  for (const [camel, snake] of [
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['totalTokens', 'total_tokens'],
  ] as const) {
    const direct = usage[camel] ?? usage[snake]
    const fallback = tokenCount[camel] ?? tokenCount[snake]
    if ((typeof direct !== 'number' || direct === 0) && typeof fallback === 'number' && fallback > 0) merged[camel] = fallback
  }
  const result = usageChunk(merged)
  return result?.type === 'usage' ? result : null
}

/** 合并 ACP 终态和 transcript：终态优先，缺失字段从 transcript 补齐。 */
function mergeQoderUsage(primary: QoderUsageEvent | null, fallback: QoderUsageEvent | null): QoderUsageEvent | null {
  if (primary === null) return fallback
  if (fallback === null || primary.type !== 'usage' || fallback.type !== 'usage') return primary
  const merged = { ...fallback, ...primary }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const direct = primary[key] ?? 0
    const transcript = fallback[key]
    if (direct === 0 && transcript !== undefined && transcript > 0) merged[key] = transcript
  }
  return merged
}

/**
 * Qoder 不保证 ACP 终态携带完整 usage。CLI 会把 assistant message 的原始 usage
 * 写入 ~/.qoder(-cn)/projects/<cwd>/<session>.jsonl，作为同一回合的只读后备来源。
 */
function readQoderTranscriptUsage(
  homeDirectory: string,
  profile: QoderCliProfile,
  cwd: string | undefined,
  sessionId: string,
): QoderUsageEvent | null {
  if (!/^[A-Za-z0-9._-]+$/u.test(sessionId)) return null
  const projectKey = resolve(cwd ?? process.cwd()).replace(/[\\/]/gu, '-')
  const path = join(homeDirectory, profile.userConfigDirectory, 'projects', projectKey, `${sessionId}.jsonl`)
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '')
  } catch {
    return null
  }
  // Qoder 的 runtime-config 优先；当前 CLI 版本常把容量只写进 qodercli.log 的
  // auto-compact 记录，因此没有 runtime-config 时再按同一 Provider 会话回读日志。
  let contextWindow: number | undefined
  for (const line of lines) {
    try {
      const entry: unknown = JSON.parse(line)
      if (!isRecord(entry) || entry.type !== 'runtime-config') continue
      const value = entry.contextWindow
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) contextWindow = value
    } catch {
      // 下面的 usage 扫描会再次跳过同一条损坏记录。
    }
  }
  contextWindow ??= readQoderLogContextWindow(homeDirectory, profile, sessionId)
  for (const line of lines.reverse()) {
    try {
      const entry: unknown = JSON.parse(line)
      if (!isRecord(entry)) continue
      const message = isRecord(entry.message) ? entry.message : entry
      if (!isRecord(message.usage)) continue
      const usage = qoderUsageChunk(message.usage)
      if (usage !== null && usage.type === 'usage' && contextWindow !== undefined && usage.contextWindow === undefined) {
        const contextTokens = usage.contextTokens
          ?? (usage.contextUsageRatio === undefined ? undefined : Math.round(usage.contextUsageRatio * contextWindow))
        return {
          ...usage,
          contextWindow,
          ...(contextTokens === undefined ? {} : { contextTokens }),
        }
      }
      if (usage !== null) return usage
    } catch {
      // transcript 允许尾部存在未完成 JSON；跳过损坏行继续查找最近完整消息。
    }
  }
  return null
}

/**
 * 读取 Qoder CLI 为同一 Provider 会话记录的真实上下文窗口。
 *
 * Qoder CN 1.1.65 的 JSONL assistant usage 只带 context_usage_ratio，
 * 上下文窗口会记录在 qodercli.log 的 auto-compact 行中，例如
 * `[auto-compact][session:<id>] ... window=200000`。该值是 Provider 的
 * 实际运行窗口，不能用插件自己的默认值替代。
 */
function readQoderLogContextWindow(homeDirectory: string, profile: QoderCliProfile, sessionId: string): number | undefined {
  const logsDirectory = join(homeDirectory, profile.userConfigDirectory, 'logs', 'runs')
  let directories: string[]
  try {
    directories = readdirSync(logsDirectory)
      .map((name) => join(logsDirectory, name))
      .filter((path) => {
        try { return statSync(path).isDirectory() } catch { return false }
      })
      .sort()
      .reverse()
  } catch {
    return undefined
  }
  const escapedSessionId = sessionId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const autoCompact = new RegExp(`\\[auto-compact\\]\\[session:${escapedSessionId}\\][^\\n]*?\\bwindow=(\\d+)`, 'gu')
  const runtimeConfig = new RegExp(`session.runtime_config[^\\n]*?session=${escapedSessionId}[^\\n]*?context_window=(\\d+)`, 'gu')
  for (const directory of directories) {
    let log: string
    try { log = readFileSync(join(directory, 'qodercli.log'), 'utf8') } catch { continue }
    const values = [...log.matchAll(autoCompact), ...log.matchAll(runtimeConfig)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
    if (values.length > 0) return values.at(-1)
  }
  return undefined
}

function qoderAcpMessageToChunk(
  message: JsonRpcMessage,
  input: CodingNsCliTurnInput,
  toolNames?: Map<string, string>,
  assistantMessageSegment = 0,
): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const rawType = firstToolText(update.sessionUpdate, update.type, message.method) ?? ''
  const type = rawType.toLowerCase()
  const elicitation = readAcpElicitationRequest(message)
  if (elicitation !== null) return { type: 'question-request', requestId: elicitation.requestId, questions: elicitation.questions }
  const reasoning = reasoningText(update)
  if (reasoning !== null) return { type: 'reasoning-delta', text: reasoning, messageId: qoderMessageId(update) ?? `qoder-assistant-${input.sessionId}-${assistantMessageSegment}` }
  const text = acpText(update.delta ?? update.text ?? update.content ?? update.message ?? update.detail)
  if (type.includes('request_permission') || type.includes('permission')) {
    const requestId = permissionRequestId(message)
    if (requestId !== null) {
      const tool = isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : update
      const meta = isRecord(update._meta) && isRecord(update._meta.qoder) ? update._meta.qoder : {}
      const callId = firstToolText(tool.callId, tool.call_id, tool.toolCallId, tool.tool_call_id, tool.id, update.toolCallId, update.tool_call_id, update.id)
      const explicitToolName = firstToolText(meta.toolName, tool.name, tool.toolName, tool.tool_name, update.name, update.toolName, update.tool_name)
      const toolName = explicitToolName
        ?? (callId === undefined ? undefined : toolNames?.get(callId))
        ?? firstToolText(tool.title, update.title)
      if (callId !== undefined && toolName !== undefined && toolName !== 'tool') toolNames?.set(callId, toolName)
      const kind = firstToolText(update.kind, update.permissionKind, tool.kind) ?? toolName ?? 'unknown'
      return { type: 'permission-request', requestId, kind, ...(toolName ? { toolName } : {}), ...(callId ? { callId } : {}), ...(text ? { detail: text } : {}) }
    }
  }
  const providerMessageId = qoderMessageId(update)
  const messageId = providerMessageId ?? `qoder-assistant-${input.sessionId}-${assistantMessageSegment}`
  if (type.includes('agent_message') || type.includes('text')) return text === null ? null : { type: 'text-delta', text, messageId }
  if (type.includes('agent_thought') || type.includes('thought') || type.includes('reason')) return text === null ? null : { type: 'reasoning-delta', text, messageId }
  if (type.includes('tool') || type.includes('command')) {
    const tool = isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : update
    const meta = isRecord(update._meta) && isRecord(update._meta.qoder) ? update._meta.qoder : {}
    const callId = firstToolText(tool.callId, tool.call_id, tool.toolCallId, tool.tool_call_id, tool.id, update.toolCallId, update.tool_call_id, update.id)
    const explicitToolName = firstToolText(meta.toolName, tool.name, tool.toolName, tool.tool_name, update.name, update.toolName, update.tool_name)
    const toolName = explicitToolName
      ?? (callId === undefined ? undefined : toolNames?.get(callId))
      ?? firstToolText(tool.title, update.title)
    if (toolName === undefined && callId === undefined) return null
    if (callId !== undefined && toolName !== undefined && toolName !== 'tool') toolNames?.set(callId, toolName)
    const inputValue = serializeToolValue(tool.rawInput ?? tool.input ?? tool.arguments ?? tool.args ?? update.rawInput)
    const output = serializeToolValue(tool.rawOutput ?? tool.output ?? tool.result ?? update.rawOutput)
    const error = serializeToolValue(tool.error ?? update.error)
    const fallback = error !== undefined || type.includes('error') || type.includes('fail') ? 'failed' : output !== undefined || type.includes('complete') || type.includes('result') ? 'completed' : 'running'
    return { type: 'tool-event', toolName: toolName ?? 'tool', status: normalizeToolStatus(tool.status ?? tool.state ?? update.status, fallback), ...(callId ? { callId } : {}), ...(inputValue !== undefined ? { input: inputValue } : {}), ...(output !== undefined ? { output, outputMode: type.includes('delta') ? 'delta' as const : 'snapshot' as const } : {}), ...(error !== undefined ? { error } : {}) }
  }
  return usageChunk(update)
}

/** ACP 版本间字段名不稳定；优先使用 Provider 的真实 assistant item 标识。 */
function qoderMessageId(update: Record<string, unknown>): string | undefined {
  const content = isRecord(update.content) ? update.content : undefined
  const meta = isRecord(update._meta) && isRecord(update._meta.qoder) ? update._meta.qoder : undefined
  return firstToolText(update.messageId, update.message_id, content?.messageId, content?.message_id, meta?.messageId, meta?.message_id)
}

function acpText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value.map((item) => acpText(item) ?? '').join('')
    return text === '' ? null : text
  }
  if (!isRecord(value)) return null
  if (typeof value.text === 'string') return value.text
  if (typeof value.delta === 'string') return value.delta
  if (typeof value.content === 'string') return value.content
  if (isRecord(value.content)) return acpText(value.content)
  return null
}

interface QoderTurnEventQueue {
  readonly terminated: boolean
  next(): Promise<IteratorResult<JsonRpcMessage>>
  push(message: JsonRpcMessage): void
  close(): void
}

function createQoderTurnEventQueue(): QoderTurnEventQueue {
  const pending: JsonRpcMessage[] = []
  let wake: (() => void) | undefined
  let closed = false
  return {
    get terminated() { return closed },
    async next() {
      if (pending.length > 0) return { value: pending.shift()!, done: false }
      if (closed) return { value: undefined, done: true }
      await new Promise<void>((resolve) => { wake = resolve })
      if (pending.length > 0) return { value: pending.shift()!, done: false }
      return { value: undefined, done: true }
    },
    push(message) { pending.push(message); wake?.(); wake = undefined },
    close() { closed = true; wake?.(); wake = undefined },
  }
}
