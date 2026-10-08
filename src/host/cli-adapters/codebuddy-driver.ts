import { runAsyncCommand } from './process-utils.js'
import { failedDetection, probeFailure } from './binary-detection.js'
import type { CodingNsCliDetection } from '../../shared/contracts/cli-adapter.js'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { spawn, spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type {
  CodingNsAgentEvent,
  CodingNsAgentPermissionResponse,
  CodingNsAgentQuestionResponse,
  CodingNsCliCapability,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type {
  CodingNsCliDriver,
  CodingNsCliSessionProbeInput,
  CodingNsCliSessionProbeResult,
} from './driver.js'
import { JsonRpcProcess, JsonRpcRequestError, type JsonRpcMessage } from './json-rpc-process.js'
import { emptyCatalog, isRecord, streamRpcRequest, textValue, usageChunk } from './rpc-driver-utils.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { buildAcpPromptBlocks } from './attachment-utils.js'
import { acpBridgeMcpServers } from '../cli-bridge/injections.js'
import { reasoningText } from './reasoning-content.js'
import { advanceCodingNsSegment, createCodingNsSegmentState, decorateCodingNsSegmentEvent } from './stream-normalizer.js'
import { commandEnvironment, resolveCommandPath, WINDOWS } from './process-utils.js'
import { isProviderDefaultModel } from './model-catalog.js'
import { ACP_FORM_CLIENT_CAPABILITIES, acpElicitationResponse, readAcpElicitationRequest, type AcpElicitationRequest } from './acp-elicitation.js'

/** WorkBuddy 将 Auto 拆成三个模型 ID，但它们实际是 Auto 的思考档位。 */
const WORKBUDDY_AUTO_TIER_MODELS = [
  { id: 'fast-model', name: '快速' },
  { id: 'balanced-model', name: '均衡' },
  { id: 'deep-model', name: '极致' },
] as const
const WORKBUDDY_AUTO_TIER_IDS: ReadonlySet<string> = new Set(WORKBUDDY_AUTO_TIER_MODELS.map((model) => model.id))
/** `auto` 是 WorkBuddy 的默认路由占位符，不应作为独立模型渲染。 */
const WORKBUDDY_AUTO_MODEL_ID = 'auto'

/** 同源 CodeBuddy / WorkBuddy 的产品身份参数。协议驱动只实现一份。 */
export interface CodeBuddyRuntimeProfile {
  readonly adapterId: 'codebuddy' | 'workbuddy' | string
  readonly displayName: string
  readonly configRootEnvVars: readonly string[]
  /** 读取配置根时使用的变量；未提供时沿用 configRootEnvVars。 */
  readonly configRootLookupEnvVars?: readonly string[]
  readonly defaultConfigRoot: string
  readonly historyDirRule: 'lowercase-slug' | 'preserve-case' | 'none'
  readonly platforms: readonly NodeJS.Platform[]
  readonly commandEnvOverride: string
  readonly binaries: readonly string[]
  readonly bundledInApp: boolean
  /** 认证存储使用的 HOME；为空时沿用宿主 HOME。 */
  readonly isolatedHome?: string
  /** 启动 CLI 时覆盖的产品环境变量；undefined 表示清除继承值。 */
  readonly environmentOverrides?: Readonly<Record<string, string | undefined>>
  /** 模型目录的显式覆盖变量。 */
  readonly modelCatalogEnvVar?: string
}

export interface CodeBuddyDriverOptions {
  /** 覆盖 PATH 候选命令，主要用于自定义安装与测试。 */
  readonly binaries?: readonly string[]
  /** 覆盖候选命令；显式值无效时不会回退到其他候选。 */
  readonly commandPath?: string
  /** 测试与宿主注入的环境快照，不会写回 process.env。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** `env` 是 environment 的兼容别名，便于与其他驱动测试保持一致。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly configRoot?: string
  readonly sessionRoots?: readonly string[]
  readonly fallbackCatalog?: CodingNsCliModelCatalog
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  readonly platform?: NodeJS.Platform
  /** 覆盖产品模型目录文件，主要用于测试和自定义安装。 */
  readonly modelCatalogPaths?: readonly string[]
  readonly readFileSync?: typeof readFileSync
  readonly profile?: CodeBuddyRuntimeProfile
  /** WorkBuddy 是否通过桌面 sidecar 启动受控 HTTP ACP；测试可显式关闭。 */
  readonly useSidecar?: boolean
  /** 覆盖 WorkBuddy sidecar 控制 socket，便于诊断和测试。 */
  readonly sidecarSocketPath?: string
  /** 覆盖 WorkBuddy Electron 启动器路径。 */
  readonly workbuddyElectronPath?: string
}

interface CodeBuddyPermissionRequest {
  readonly rpcId: number | string
  readonly allowOptionId: string
  readonly rejectOptionId: string
  readonly client?: WorkBuddyHttpAcpClient
}

interface CodeBuddyQuestionRequest {
  readonly request: AcpElicitationRequest
  readonly client?: WorkBuddyHttpAcpClient
}

const CODEBUDDY_HOME = join(homedir(), '.codebuddy')
const CODEBUDDY_INTERNATIONAL_AUTH_HOME = join(homedir(), '.codebuddy-international-home')
// 官方 FileAuthenticationStorage 不读取 CODEBUDDY_CONFIG_DIR，而是按 HOME
// 计算 ~/Library/Application Support/CodeBuddyExtension（或平台等价目录）。
// CN 在全局认证不是 CN 账号时使用独立 HOME，避免登录时覆盖国际版的认证文件。
const CODEBUDDY_CN_AUTH_HOME = join(homedir(), '.codebuddy-cn-home')
const INTERNAL_AUTH_DOMAINS = new Set([
  'copilot.tencent.com', 'staging-copilot.tencent.com', 'www.codebuddy.cn', 'staging.codebuddy.cn',
  'www.workbuddy.cn', 'staging.workbuddy.cn',
])
const EXTERNAL_AUTH_DOMAINS = new Set(['www.codebuddy.ai', 'staging-codebuddy.tencent.com'])
// WorkBuddy 产品配置中的 dataFolderName 为 `.workbuddy`；必须复用桌面应用
// 的认证存储，不能另造 `.workbuddy-ai` 隔离目录，否则 ACP 会报 Authentication required。
const WORKBUDDY_HOME = join(homedir(), '.workbuddy')

/** CodeBuddy 独立 CLI 的产品身份。 */
export const CODEBUDDY_PROFILE: CodeBuddyRuntimeProfile = {
  adapterId: 'codebuddy',
  displayName: 'CodeBuddy',
  // CN 与国际版是同一个 CLI；兼容旧版 CN profile 的专用配置变量，统一归入
  // 当前适配器的配置根，不再注册第二个 Agent。
  configRootEnvVars: ['CODEBUDDY_CONFIG_DIR', 'CODEBUDDY_CN_CONFIG_DIR'],
  defaultConfigRoot: CODEBUDDY_HOME,
  historyDirRule: 'lowercase-slug',
  platforms: ['darwin', 'win32', 'linux'],
  commandEnvOverride: 'CODEBUDDY_CLI_PATH',
  // 官方 npm 包同时提供 codebuddy、codebuddy-code 和 cbc 三个入口。
  binaries: ['codebuddy', 'codebuddy-code', 'cbc', 'codebuddy.cmd', 'codebuddy-code.cmd', 'cbc.cmd'],
  bundledInApp: false,
  // 没有匹配的全局国际账号时，使用独立认证根，避免读到 CN 会话。
  isolatedHome: CODEBUDDY_INTERNATIONAL_AUTH_HOME,
  // 区域变量在 runtimeEnvironment 中根据认证域名动态设置。
}

/** 旧版 CN profile 的兼容导出；运行时不再把它注册为独立 Agent。 */
export const CODEBUDDY_CN_PROFILE: CodeBuddyRuntimeProfile = CODEBUDDY_PROFILE

/** WorkBuddy 桌面应用内置 CLI 的产品身份。 */
export const WORKBUDDY_PROFILE: CodeBuddyRuntimeProfile = {
  adapterId: 'workbuddy',
  displayName: 'WorkBuddy',
  configRootEnvVars: ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR'],
  defaultConfigRoot: WORKBUDDY_HOME,
  historyDirRule: 'preserve-case',
  platforms: ['darwin', 'win32'],
  commandEnvOverride: 'WORKBUDDY_CLI_PATH',
  // WorkBuddy 的入口文件仍叫 codebuddy，但只能使用桌面应用内置副本。
  binaries: ['codebuddy'],
  bundledInApp: true,
}

/**
 * ACP 驱动的已验收公共能力。
 *
 * CodeBuddy 的 ACP 上下文事件与本地 JSONL 用量补偿已经完成验收；账户套餐
 * 仍由独立订阅读取器负责，不混入 ACP 能力声明。
 */
const CONSERVATIVE_CAPABILITIES: readonly CodingNsCliCapability[] = [
  'models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions',
]

/** 无副作用模型探测的最低回退项；登记层可以传入更完整的真实目录覆盖它。 */
export const CODEBUDDY_DEFAULT_CATALOG: CodingNsCliModelCatalog = {
  groups: [{ id: 'codebuddy', name: 'CodeBuddy', models: [{ id: 'provider-default', name: '跟随 CodeBuddy 默认模型', efforts: [] }] }],
  currentModel: null,
  currentEffort: null,
  // 只有默认入口时表示产品目录尚未读取成功，Registry 必须按短周期重试。
  fallback: true,
}

export const CODEBUDDY_CN_DEFAULT_CATALOG: CodingNsCliModelCatalog = CODEBUDDY_DEFAULT_CATALOG

export const WORKBUDDY_DEFAULT_CATALOG: CodingNsCliModelCatalog = {
  groups: [{ id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'provider-default', name: '跟随 WorkBuddy 默认模型', efforts: [] }] }],
  currentModel: null,
  currentEffort: null,
  // 只有默认入口时表示产品目录尚未读取成功，Registry 必须按短周期重试。
  fallback: true,
}

/**
 * CodeBuddy 与 WorkBuddy 共用的 ACP stdio 驱动。
 *
 * 每轮启动一个短生命周期 ACP 进程，继续会话时通过 `session/load` 恢复。
 * 这样取消不会把残留取消态带到下一轮，且不需要复制厂商 SDK 或桌面应用登录态。
 */
export class CodeBuddyCliDriver implements CodingNsCliDriver {
  readonly descriptor: Omit<import('../../shared/contracts/cli-adapter.js').CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>
  /** CodeBuddy/WorkBuddy 的 ACP 流可由 Registry 在工具完成后暂停并续读。 */
  readonly supportsToolStepSplitting = true
  protected readonly profile: CodeBuddyRuntimeProfile
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly environment: Readonly<Record<string, string | undefined>>
  private readonly configRoot: string
  private readonly sessionRoots: readonly string[]
  private readonly fallbackCatalog: CodingNsCliModelCatalog
  private readonly platform: NodeJS.Platform
  private readonly binaries: readonly string[]
  private readonly binariesOverride: boolean
  private readonly modelCatalogPaths: readonly string[] | undefined
  private readonly readModelCatalogFile: typeof readFileSync
  private readonly commandPath: string | undefined
  private readonly useSidecar: boolean
  private readonly sidecarSocketPath: string | undefined
  private readonly workbuddyElectronPath: string | undefined
  private cachedCommand: string | null = null
  private lastVersion: string | null = null
  private detectionDiagnostic: string | undefined
  private detectionFailure: CodingNsCliDetection['detectionFailure']
  private readonly processes = new Map<string, { readonly rpc: JsonRpcProcess; providerSessionId: string }>()
  private readonly sidecarProcesses = new Map<string, { readonly client: WorkBuddyHttpAcpClient; readonly sidecar: WorkBuddySidecarClient; readonly sidecarSessionId: string; readonly providerSessionId: string; readonly dispose: () => Promise<void> }>()
  private readonly permissions = new Map<string, Map<string, CodeBuddyPermissionRequest>>()
  private readonly questions = new Map<string, Map<string, CodeBuddyQuestionRequest>>()

  constructor(options: CodeBuddyDriverOptions = {}) {
    this.profile = options.profile ?? CODEBUDDY_PROFILE
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    this.platform = options.platform ?? process.platform
    this.binariesOverride = options.binaries !== undefined
    this.binaries = options.binaries ?? this.profile.binaries
    this.commandPath = options.commandPath?.trim() || undefined
    this.environment = { ...process.env, ...(options.environment ?? options.env ?? {}) }
    this.configRoot = resolveConfigRoot(this.profile, options.configRoot, this.environment)
    this.modelCatalogPaths = options.modelCatalogPaths
    this.readModelCatalogFile = options.readFileSync ?? readFileSync
    this.sessionRoots = options.sessionRoots ?? [join(this.configRoot, 'projects'), join(this.configRoot, 'sessions')]
    this.fallbackCatalog = options.fallbackCatalog ?? defaultCatalogForProfile(this.profile)
    this.useSidecar = options.useSidecar ?? (this.profile.adapterId === WORKBUDDY_PROFILE.adapterId && options.spawn === undefined)
    this.sidecarSocketPath = options.sidecarSocketPath?.trim() || undefined
    this.workbuddyElectronPath = options.workbuddyElectronPath?.trim() || undefined
    this.descriptor = {
      id: this.profile.adapterId,
      name: this.profile.displayName,
      protocol: 'acp',
      capabilities: CONSERVATIVE_CAPABILITIES,
    }
  }

  /** 当前使用的产品身份配置根，供测试和诊断使用；不包含凭据。 */
  get configDirectory(): string { return this.configRoot }

  /** 最近一次探测失败的脱敏诊断。 */
  get discoveryError(): string | undefined { return this.detectionDiagnostic }

  getDiscoveryDiagnostic(): string | undefined { return this.detectionDiagnostic }
  getDiscoveryFailure(): CodingNsCliDetection['detectionFailure'] { return this.detectionFailure }

  /** 回复 ACP 标准权限请求。 */
  async respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): Promise<void> {
    const pending = this.permissions.get(sessionId)?.get(response.requestId)
    if (pending === undefined) throw new Error(`${this.profile.displayName} 权限请求不存在`)
    this.permissions.get(sessionId)!.delete(response.requestId)
    const result = { outcome: { outcome: 'selected', optionId: response.approved ? pending.allowOptionId : pending.rejectOptionId } }
    if (pending.client !== undefined) {
      await pending.client.respond(pending.rpcId, result)
      return
    }
    const process = this.processes.get(sessionId)?.rpc
    if (process === undefined) throw new Error(`${this.profile.displayName} ACP 进程已结束`)
    process.respond(pending.rpcId, result)
  }

  /** 回复 ACP 标准 form elicitation。 */
  async respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): Promise<void> {
    const pending = this.questions.get(sessionId)?.get(response.requestId)
    if (pending === undefined) throw new Error(`${this.profile.displayName} 问题请求不存在`)
    this.questions.get(sessionId)!.delete(response.requestId)
    const result = acpElicitationResponse(pending.request, response)
    if (pending.client !== undefined) {
      await pending.client.respond(pending.request.rpcId, result)
      return
    }
    const process = this.processes.get(sessionId)?.rpc
    if (process === undefined) throw new Error(`${this.profile.displayName} ACP 进程已结束`)
    process.respond(pending.request.rpcId, result)
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    this.detectionDiagnostic = undefined
    this.detectionFailure = undefined
    if (!this.profile.platforms.includes(this.platform)) {
      this.detectionDiagnostic = `${this.profile.displayName} 官方未提供 ${this.platform} 平台版本`
      return { installed: false, version: null, command: null }
    }

    const explicit = this.explicitCommand()
    if (explicit !== undefined) {
      const result = await this.detectCommand(explicit)
      if (result !== null) return result
      if (this.detectionDiagnostic === undefined) this.detectionDiagnostic = this.detectionFailure === undefined
        ? `${this.profile.displayName} 显式指定的 CLI 路径无效` : failedDetection(this.detectionFailure).diagnostic
      return { installed: false, version: null, command: null }
    }

    let firstDiagnostic: string | undefined
    let firstFailure: CodingNsCliDetection['detectionFailure']
    for (const command of this.candidateCommands()) {
      const result = await this.detectCommand(command)
      if (result !== null) return result
      if (firstDiagnostic === undefined && this.detectionDiagnostic !== undefined) firstDiagnostic = this.detectionDiagnostic
      firstFailure ??= this.detectionFailure
    }
    this.detectionDiagnostic = firstDiagnostic ?? (firstFailure === undefined ? `${this.profile.displayName} CLI 未安装` : failedDetection(firstFailure).diagnostic)
    this.detectionFailure = firstFailure
    return { installed: false, version: null, command: null }
  }

  /** 从产品快照读取模型目录；ACP 没有标准只读目录接口，不能创建会话探测模型。 */
  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detection = await this.detect()
    if (!detection.installed) return emptyCatalog()
    // PATH 中的 npm shim 可能只是相对命令名；模型目录位于真实 CLI 包根目录，
    // 因此这里补一次只读路径解析，避免把工作目录误当成产品目录。
    const command = detection.command !== null && !isAbsolute(detection.command)
      ? (await resolveCommandPath(detection.command, this.runSpawnSync)) ?? detection.command
      : detection.command
    const modelCatalogPaths = this.modelCatalogPaths ?? defaultModelCatalogPaths(this.profile, this.configRoot, this.environment)
    return readProductCatalog(modelCatalogPaths, this.readModelCatalogFile, command, this.profile, detectCodeBuddyRegion(this.environment)) ?? this.fallbackCatalog
  }

  /** 只读扫描产品自己的历史根；不会调用 ACP load/prompt。 */
  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && (path.endsWith(`${id}.jsonl`) || basename(path).includes(id)),
      validate: async (path, id) => {
        const record = await readFirstJsonRecord(path)
        const value = record?.sessionId ?? record?.session_id ?? record?.id
        return value === id
      },
    })
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedCommand ?? (await this.detect()).command
    if (command === null) throw new Error(`${this.profile.displayName} CLI 未安装`)

    if (this.useSidecar && this.profile.adapterId === WORKBUDDY_PROFILE.adapterId) {
      yield* this.executeWorkBuddySidecarTurn(input, command)
      return
    }

    const rpc = new JsonRpcProcess({
      command,
      args: ['--acp'],
      cwd: input.cwd,
      env: this.runtimeEnvironment(command),
      spawn: this.runSpawn,
    })
    const processState = { rpc, providerSessionId: '' }
    this.processes.set(input.sessionId, processState)
    const permissions = new Map<string, CodeBuddyPermissionRequest>()
    this.permissions.set(input.sessionId, permissions)
    const questions = new Map<string, CodeBuddyQuestionRequest>()
    this.questions.set(input.sessionId, questions)
    // ACP 标准权限和 form elicitation 交给 DSH 原生组件；未知扩展请求快速取消。
    rpc.setServerRequestHandler((message) => {
      const elicitation = readAcpElicitationRequest(message)
      if (elicitation !== null) {
        questions.set(elicitation.requestId, { request: elicitation })
        return new Promise<never>(() => undefined)
      }
      if (message.method === 'elicitation/create') return { action: 'cancel' }
      const permission = codeBuddyPermissionRequest(message)
      if (permission === null || message.id === undefined || message.id === null) return { outcome: { outcome: 'cancelled' } }
      permissions.set(permission.requestId, { rpcId: message.id, allowOptionId: permission.allowOptionId, rejectOptionId: permission.rejectOptionId })
      return new Promise<never>(() => undefined)
    })
    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
        clientCapabilities: ACP_FORM_CLIENT_CAPABILITIES,
      }, sidecarSignalOptions(input.signal))
      rpc.notify('initialized', {})

      const session = input.providerSessionId
        ? await rpc.request('session/load', {
          sessionId: input.providerSessionId,
          cwd: input.cwd ?? process.cwd(),
          mcpServers: acpBridgeMcpServers(input.sessionId, this.profile.adapterId),
        }, sidecarSignalOptions(input.signal))
        : await rpc.request('session/new', {
          cwd: input.cwd ?? process.cwd(),
          mcpServers: acpBridgeMcpServers(input.sessionId, this.profile.adapterId),
        }, sidecarSignalOptions(input.signal))
      const providerSessionId = readSessionId(session) ?? input.providerSessionId ?? input.sessionId
      processState.providerSessionId = providerSessionId
      yield { type: 'session-binding', providerSessionId }

      // ACP 版本间的模型设置方法并不完全一致；失败时沿用 Provider 默认模型，不能阻断本轮。
      const modelId = resolveCodeBuddyModelId(this.profile, input.modelId, input.effortId)
      if (!isProviderDefaultModel(modelId)) {
        await rpc.request('session/set_model', { sessionId: providerSessionId, modelId }, { signal: input.signal, killOnAbort: false }).catch(() => undefined)
      }

      const stream = streamRpcRequest(rpc, 'session/prompt', {
        sessionId: providerSessionId,
        prompt: await buildAcpPromptBlocks(input.prompt, input.attachments ?? []),
      }, input.signal, { dispose: false, killOnAbort: false })
      let meaningful = false
      let richUsageSeen = false
      let reportedContextWindow: number | undefined
      let terminal: Extract<CodingNsAgentEvent, { type: 'finish' }> | undefined
      const segmentState = createCodingNsSegmentState()
      let promptResponse: unknown
      while (true) {
        const item = await stream.next()
        if (item.done) {
          promptResponse = item.value
          break
        }
        const rawChunk = codeBuddyMessageToChunk(item.value)
        const chunk = rawChunk === null ? null : decorateCodingNsSegmentEvent(rawChunk, input, segmentState, this.descriptor.id)
        if (chunk?.type === 'finish') {
          // ACP 可能先发一个 session/update 终态，再在 prompt 响应里携带真正的
          // stopReason。先暂存终态，等正文和 prompt 响应都到齐后再决定成功或失败。
          terminal = chunk
          continue
        }
        if (chunk !== null) {
          meaningful = true
          if (chunk.type === 'usage') {
            if (chunk.contextWindow !== undefined) reportedContextWindow = chunk.contextWindow
            if (hasTokenUsage(chunk)) richUsageSeen = true
          }
          yield chunk
          advanceCodingNsSegment(chunk, segmentState)
        }
      }
      // CodeBuddy ACP 当前只发送正文与 stopReason；完整 Token/缓存数据会在
      // prompt 完成后写入本地 JSONL。只在 ACP 没有提供完整 usage 时补读，避免
      // 同一轮产生两套互相冲突的 token 口径。
      if (!richUsageSeen) {
        const historyUsage = await this.readHistoryUsage(input, providerSessionId)
        if (historyUsage !== null) yield enrichCodeBuddyUsageContext(historyUsage, reportedContextWindow)
      }
      const responseHasStopReason = isRecord(promptResponse) && typeof promptResponse.stopReason === 'string'
      if (responseHasStopReason) {
        // prompt 响应是 ACP 对本轮的最终判定，必须覆盖通知中可能提前发送的
        // `finish(stop)`；否则 refusal 会被投影成正常结束，留下空 assistant。
        yield promptFinish(promptResponse, input.signal)
      } else if (terminal !== undefined) {
        if (meaningful) {
          yield terminal
        } else {
          yield emptyResponseFinish(terminal.failure ?? promptFailure(promptResponse))
        }
      } else {
        yield emptyResponseFinish(promptFailure(promptResponse))
      }
    } finally {
      if (this.processes.get(input.sessionId) === processState) this.processes.delete(input.sessionId)
      this.permissions.delete(input.sessionId)
      this.questions.delete(input.sessionId)
      await rpc.disposeAndWait()
    }
  }

  /** WorkBuddy 桌面版必须由 sidecar 启动，普通 Node ACP 不会收到字段加密密钥。 */
  private async *executeWorkBuddySidecarTurn(input: CodingNsCliTurnInput, command: string): AsyncIterable<CodingNsAgentEvent> {
    const socketPath = this.sidecarSocketPath ?? discoverWorkBuddySidecarSocket(this.configRoot, this.platform, this.environment)
    if (socketPath === null) {
      throw new Error('WorkBuddy Hosted CLI sidecar 不可用（未找到 sidecar.pid 或 sidecar-<uuid>.sock）。当前版本按需创建 Hosted CLI runtime，普通应用启动或登录不会生成该通道；DSH 无法代替桌面 daemon 注入认证凭据。请先在 WorkBuddy 中启动一次 Hosted CLI 会话，或设置 WORKBUDDY_SIDECAR_SOCKET')
    }

    const sidecar = new WorkBuddySidecarClient(socketPath)
    let sidecarSessionId = ''
    let ownsSidecarSession = false
    const launch = workBuddyLaunchSpec(command, this.workbuddyElectronPath, this.platform, this.environment)
    let client: WorkBuddyHttpAcpClient | undefined
    let providerSessionId = ''
    let disposed = false
    const cleanup = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      this.sidecarProcesses.delete(input.sessionId)
      await client?.dispose().catch(() => undefined)
      if (ownsSidecarSession && sidecarSessionId !== '') {
        await sidecar.request('session.kill', { sessionId: sidecarSessionId }, { timeoutMs: 5_000 }).catch(() => undefined)
      }
      sidecar.dispose()
    }

    try {
      const endpoint = await resolveWorkBuddyAcpEndpoint(
        sidecar,
        input,
        launch,
        this.configRoot,
        this.runtimeEnvironment(command),
        this.platform,
        this.environment,
        (value: string) => {
          sidecarSessionId = value
          ownsSidecarSession = true
        },
      )
      if (endpoint === '') throw new Error('WorkBuddy sidecar 未返回 ACP 地址')
      client = new WorkBuddyHttpAcpClient(endpoint)
      await client.connect(input.signal)
      const acpClient = client
      const permissions = new Map<string, CodeBuddyPermissionRequest>()
      this.permissions.set(input.sessionId, permissions)
      const questions = new Map<string, CodeBuddyQuestionRequest>()
      this.questions.set(input.sessionId, questions)
      acpClient.setServerRequestHandler((message) => {
        const elicitation = readAcpElicitationRequest(message)
        if (elicitation !== null) {
          questions.set(elicitation.requestId, { request: elicitation, client: acpClient })
          return true
        }
        if (message.method === 'elicitation/create') return false
        const permission = codeBuddyPermissionRequest(message)
        if (permission === null || message.id === undefined || message.id === null) return false
        permissions.set(permission.requestId, {
          rpcId: message.id,
          allowOptionId: permission.allowOptionId,
          rejectOptionId: permission.rejectOptionId,
          client: acpClient,
        })
        return true
      })
      const state = {
        client,
        sidecar,
        sidecarSessionId,
        get providerSessionId() { return providerSessionId },
        dispose: cleanup,
      }
      this.sidecarProcesses.set(input.sessionId, state)

      await client.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
        clientCapabilities: ACP_FORM_CLIENT_CAPABILITIES,
      }, sidecarSignalOptions(input.signal))
      await client.notify('initialized', {}, input.signal)

      const session = input.providerSessionId
        ? await client.request('session/load', {
          sessionId: input.providerSessionId,
          cwd: input.cwd ?? process.cwd(),
          mcpServers: acpBridgeMcpServers(input.sessionId, this.profile.adapterId),
        }, sidecarSignalOptions(input.signal))
        : await client.request('session/new', {
          cwd: input.cwd ?? process.cwd(),
          mcpServers: acpBridgeMcpServers(input.sessionId, this.profile.adapterId),
        }, sidecarSignalOptions(input.signal))
      providerSessionId = readSessionId(session) ?? input.providerSessionId ?? input.sessionId
      yield { type: 'session-binding', providerSessionId }

      const modelId = resolveCodeBuddyModelId(this.profile, input.modelId, input.effortId)
      if (!isProviderDefaultModel(modelId)) {
        await client.request('session/set_model', { sessionId: providerSessionId, modelId }, sidecarSignalOptions(input.signal, false)).catch(() => undefined)
      }

      const stream = client.streamRequest('session/prompt', {
        sessionId: providerSessionId,
        prompt: await buildAcpPromptBlocks(input.prompt, input.attachments ?? []),
      }, input.signal)
      let meaningful = false
      let richUsageSeen = false
      let reportedContextWindow: number | undefined
      let terminal: Extract<CodingNsAgentEvent, { type: 'finish' }> | undefined
      const segmentState = createCodingNsSegmentState()
      let promptResponse: unknown
      while (true) {
        const item = await stream.next()
        if (item.done) {
          promptResponse = item.value
          break
        }
        const rawChunk = codeBuddyMessageToChunk(item.value)
        const chunk = rawChunk === null ? null : decorateCodingNsSegmentEvent(rawChunk, input, segmentState, this.descriptor.id)
        if (chunk?.type === 'finish') {
          terminal = chunk
          continue
        }
        if (chunk !== null) {
          meaningful = true
          if (chunk.type === 'usage') {
            if (chunk.contextWindow !== undefined) reportedContextWindow = chunk.contextWindow
            if (hasTokenUsage(chunk)) richUsageSeen = true
          }
          yield chunk
          advanceCodingNsSegment(chunk, segmentState)
        }
      }
      if (!richUsageSeen) {
        const historyUsage = await this.readHistoryUsage(input, providerSessionId)
        if (historyUsage !== null) yield enrichCodeBuddyUsageContext(historyUsage, reportedContextWindow)
      }
      const responseHasStopReason = isRecord(promptResponse) && typeof promptResponse.stopReason === 'string'
      if (responseHasStopReason) {
        yield promptFinish(promptResponse, input.signal)
      } else if (terminal !== undefined) {
        if (meaningful) yield terminal
        else yield emptyResponseFinish(terminal.failure ?? promptFailure(promptResponse))
      } else {
        yield emptyResponseFinish(promptFailure(promptResponse))
      }
    } finally {
      this.permissions.delete(input.sessionId)
      this.questions.delete(input.sessionId)
      await cleanup()
    }
  }

  /** ACP 未提供 usage 时，从 CodeBuddy 已落盘的最新 assistant 记录补齐用量。 */
  private async readHistoryUsage(input: CodingNsCliTurnInput, providerSessionId: string): Promise<CodingNsAgentEvent | null> {
    let rawStoreRef = input.rawStoreRef?.trim() || undefined
    // CLI 写 JSONL 与结束响应存在极短竞态，最多等待 100ms；失败时保持原有
    // ACP 行为，不把“读不到历史”误报成 Provider 错误。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (rawStoreRef === undefined) {
        const probe = await this.probeSession({
          providerSessionId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }).catch(() => undefined)
        rawStoreRef = probe?.rawStoreRef
      }
      if (rawStoreRef !== undefined) {
        const usage = readCodeBuddyHistoryUsage(rawStoreRef)
        if (usage !== null) {
          const modelId = readCodeBuddyHistoryModel(rawStoreRef)
          const configuredWindow = modelId === null
            ? undefined
            : readCodeBuddyModelContextWindow(modelId, this.configRoot, this.environment, this.readModelCatalogFile)
          return enrichCodeBuddyUsageContext(usage, configuredWindow)
        }
      }
      if (attempt < 2) await delay(50)
    }
    return null
  }

  /** 中断当前 ACP 进程；服务端取消失败时仍关闭本轮进程。 */
  async interrupt(sessionId: string): Promise<void> {
    const sidecarState = this.sidecarProcesses.get(sessionId)
    if (sidecarState !== undefined) {
      await sidecarState.client.request('session/cancel', { sessionId: sidecarState.providerSessionId || sessionId }, { killOnAbort: false }).catch(() => undefined)
      await sidecarState.dispose().catch(() => undefined)
      return
    }
    const state = this.processes.get(sessionId)
    if (state === undefined) return
    try {
      await state.rpc.request('session/cancel', { sessionId: state.providerSessionId || sessionId }, { killOnAbort: false })
    } catch { /* 进程关闭兜底 */ }
    state.rpc.dispose()
  }

  dispose(): void {
    for (const state of this.processes.values()) state.rpc.dispose()
    this.processes.clear()
    for (const state of this.sidecarProcesses.values()) void state.dispose().catch(() => undefined)
    this.sidecarProcesses.clear()
    this.cachedCommand = null
    this.lastVersion = null
  }

  private explicitCommand(): string | undefined {
    if (this.commandPath !== undefined) return this.commandPath
    const value = this.profile.commandEnvOverride === ''
      ? undefined
      : this.environment[this.profile.commandEnvOverride]
        ?? (this.profile.adapterId === CODEBUDDY_PROFILE.adapterId ? this.environment.CODEBUDDY_CN_CLI_PATH : undefined)
    return value?.trim() || undefined
  }

  private candidateCommands(): readonly string[] {
    if (this.profile.bundledInApp && !this.binariesOverride) return bundledWorkBuddyCommands(this.platform, this.environment)
    return this.binaries
  }

  private async detectCommand(command: string): Promise<{ installed: true; version: string; command: string } | null> {
    try {
      const options: SpawnSyncOptions = {
        encoding: 'utf8', timeout: 5_000, windowsHide: true, shell: WINDOWS,
        env: this.runtimeEnvironment(command),
      }
      const result = await runAsyncCommand(this.runSpawnSync, command, ['--version'], options) as SpawnSyncReturns<string>
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      const version = output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/u)?.[0]
      if (result.status === 0 && version !== undefined) {
        const help = await runAsyncCommand(this.runSpawnSync, command, ['--help'], options) as SpawnSyncReturns<string>
        const helpOutput = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
        if (!/--acp(?:[\s=]|$)/u.test(helpOutput)) {
          this.detectionFailure = help.status === 0 ? 'protocol' : probeFailure(help, true) ?? 'launch'
          this.detectionDiagnostic = help.status === 0
            ? `${this.profile.displayName} CLI 不支持 ACP 协议`
            : summarizeCliFailure(this.profile.displayName, helpOutput)
          return null
        }
        this.cachedCommand = command
        this.lastVersion = version
        this.detectionDiagnostic = undefined
        this.detectionFailure = undefined
        return { installed: true, version, command }
      }
      const failure = summarizeCliFailure(this.profile.displayName, output)
      if (failure !== undefined) this.detectionDiagnostic = failure
      this.detectionFailure = probeFailure(result, isAbsolute(command))
      // CodeBuddy 的 PATH shim 可能在 GUI 环境中不在当前 PATH，失败后只对非内置产品做一次登录 Shell 查找。
      if (!this.profile.bundledInApp && !isAbsolute(command)) {
        const resolved = await resolveCommandPath(command, this.runSpawnSync)
        if (resolved !== null && resolved !== command) return this.detectCommand(resolved)
      }
    } catch (error) {
      // 继续尝试下一个官方候选；错误只保留脱敏诊断。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.detectionFailure = 'launch'
    }
    return null
  }

  private runtimeEnvironment(command: string): Readonly<Record<string, string | undefined>> {
    const env = { ...commandEnvironment(command), ...this.environment, ...(this.profile.environmentOverrides ?? {}) }
    if (this.profile.adapterId === CODEBUDDY_PROFILE.adapterId) {
      const region = detectCodeBuddyRegion(env)
      if (region === 'cn') {
        env.CODEBUDDY_INTERNET_ENVIRONMENT = 'internal'
        env.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT = 'internal'
      } else {
        delete env.CODEBUDDY_INTERNET_ENVIRONMENT
        delete env.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT
      }
    }
    const authenticationHome = resolveAuthenticationHome(this.profile, this.platform, env)
    if (authenticationHome !== undefined) {
      env.HOME = authenticationHome
      if (this.platform === 'win32') env.USERPROFILE = authenticationHome
    }
    for (const variable of this.profile.configRootEnvVars) env[variable] = this.configRoot
    return WINDOWS ? commandEnvironment(command, env) : env
  }
}

/** WorkBuddy 只允许应用内置 codebuddy，不会误启动 PATH 上的 CodeBuddy。 */
export class WorkBuddyCliDriver extends CodeBuddyCliDriver {
  constructor(options: Omit<CodeBuddyDriverOptions, 'profile'> = {}) {
    super({ ...options, profile: WORKBUDDY_PROFILE })
  }
}

/** 旧版 CN 类名兼容导出；CN/国际版现在统一使用 codebuddy 适配器。 */
export class CodeBuddyCnCliDriver extends CodeBuddyCliDriver {
  constructor(options: Omit<CodeBuddyDriverOptions, 'profile'> = {}) {
    super(options)
  }
}

export { CodeBuddyCliDriver as CodeBuddyDriver, CodeBuddyCnCliDriver as CodeBuddyCnDriver }

interface SidecarRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

function sidecarSignalOptions(signal: AbortSignal | undefined, killOnAbort?: boolean): { readonly signal?: AbortSignal; readonly killOnAbort?: boolean } {
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(killOnAbort === undefined ? {} : { killOnAbort }),
  }
}

/** WorkBuddy sidecar 的逐行 JSON-RPC 控制客户端；socket 本身已由桌面应用设为 0700。 */
class WorkBuddySidecarClient {
  private closed = false
  private nextId = 1

  constructor(private readonly socketPath: string) {}

  async request(method: string, params: unknown = {}, options: SidecarRequestOptions = {}): Promise<unknown> {
    if (this.closed) throw new Error('WorkBuddy sidecar 已关闭')
    const id = this.nextId++
    return await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      let buffer = ''
      let settled = false
      const timeout = setTimeout(() => finish(new Error(`WorkBuddy sidecar 请求超时：${method}`)), options.timeoutMs ?? 30_000)
      timeout.unref?.()
      const abort = (): void => finish(new Error('WorkBuddy sidecar 请求已取消'))
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', abort)
        socket.destroy()
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const onLine = (line: string): void => {
        if (line.trim() === '') return
        let message: JsonRpcMessage
        try { message = JSON.parse(line) as JsonRpcMessage } catch { return }
        if (message.id !== id) return
        if (message.error !== undefined) {
          finish(new JsonRpcRequestError(message.error.code, message.error.data, message.error.message ?? 'WorkBuddy sidecar 请求失败'))
          return
        }
        finish(undefined, message.result)
      }
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
      socket.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString()
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          onLine(line)
          index = buffer.indexOf('\n')
        }
      })
      socket.once('error', (error: Error) => finish(new Error(`WorkBuddy sidecar 连接失败：${error.message}`)))
      socket.once('close', () => finish(new Error('WorkBuddy sidecar 连接已关闭')))
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
    })
  }

  dispose(): void {
    this.closed = true
  }
}

/** WorkBuddy ACP 的 streamable HTTP 客户端。每个 POST 响应都是一段 SSE 消息流。 */
class WorkBuddyHttpAcpClient {
  private connectionId = ''
  private sessionToken = ''
  private nextId = 1
  private closed = false
  private readonly activeControllers = new Set<AbortController>()
  private readonly responseReleases = new WeakMap<Response, () => void>()
  private serverRequestHandler: ((message: JsonRpcMessage) => boolean) | undefined

  constructor(private readonly endpoint: string) {}

  async connect(signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.endpoint}/connect`, {
      method: 'POST',
      headers: { accept: 'application/json', 'x-codebuddy-request': '1' },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`WorkBuddy ACP 连接失败（HTTP ${response.status}）`)
    const value = await response.json() as Record<string, unknown>
    const connectionId = typeof value.connectionId === 'string' ? value.connectionId : ''
    if (connectionId === '') throw new Error('WorkBuddy ACP 未返回连接标识')
    this.connectionId = connectionId
    this.sessionToken = typeof value.sessionToken === 'string' ? value.sessionToken : ''
  }

  async request(method: string, params: unknown = {}, options: { readonly signal?: AbortSignal; readonly killOnAbort?: boolean } = {}): Promise<unknown> {
    const stream = this.streamRequest(method, params, options.signal, options.killOnAbort)
    let item = await stream.next()
    while (!item.done) item = await stream.next()
    return item.value
  }

  async notify(method: string, params: unknown = {}, signal?: AbortSignal): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method, params }, signal)
    try {
      // JSON-RPC 通知仍可能返回 `:ok` 或一段 SSE；必须消费响应体，
      // 否则 undici 会保留连接，下一轮结束时留下悬挂 socket。
      for await (const _message of readAcpSseMessages(response)) { /* 只排空通知响应。 */ }
    } finally {
      this.releaseResponse(response)
    }
  }

  setServerRequestHandler(handler: ((message: JsonRpcMessage) => boolean) | undefined): void {
    this.serverRequestHandler = handler
  }

  async *streamRequest(method: string, params: unknown = {}, signal?: AbortSignal, _killOnAbort = true): AsyncGenerator<JsonRpcMessage, unknown, void> {
    const id = this.nextId++
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal)
    try {
      let final: JsonRpcMessage | undefined
      for await (const message of readAcpSseMessages(response)) {
        if (message.id === id) {
          final = message
          continue
        }
        if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
          const handled = this.serverRequestHandler?.(message) === true
          if (!handled) {
            const result = message.method === 'elicitation/create'
              ? { action: 'cancel' }
              : { outcome: { outcome: 'cancelled' } }
            void this.respond(message.id, result, signal)
          }
          if (handled) yield message
          continue
        }
        yield message
      }
      if (final === undefined) throw new Error(`WorkBuddy ACP 未返回 ${method} 的响应`)
      if (final.error !== undefined) {
        throw new JsonRpcRequestError(final.error.code, final.error.data, final.error.message ?? 'WorkBuddy ACP 请求失败')
      }
      return final.result
    } finally {
      this.releaseResponse(response)
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
    if (this.connectionId === '') return
    try {
      await fetch(this.endpoint, {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(2_000),
      })
    } catch {
      // sidecar.session.kill 负责最终清理；HTTP DELETE 失败不应掩盖本轮结果。
    }
  }

  async respond(id: number | string, result: unknown, signal?: AbortSignal): Promise<void> {
    try {
      const response = await this.post({ jsonrpc: '2.0', id, result }, signal)
      try {
        for await (const _message of readAcpSseMessages(response)) { /* 排空响应后再释放请求控制器。 */ }
      } finally {
        this.releaseResponse(response)
      }
    } catch { /* 取消态无需再上抛 */ }
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (this.closed) throw new Error('WorkBuddy ACP 已关闭')
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { ...this.headers(), accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'x-codebuddy-request': '1' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        this.activeControllers.delete(controller)
        throw new Error(`WorkBuddy ACP 请求失败（HTTP ${response.status}）`)
      }
      this.responseReleases.set(response, () => {
        signal?.removeEventListener('abort', onAbort)
        this.activeControllers.delete(controller)
      })
      return response
    } catch (error) {
      signal?.removeEventListener('abort', onAbort)
      this.activeControllers.delete(controller)
      throw error
    }
  }

  private releaseResponse(response: Response): void {
    this.responseReleases.get(response)?.()
    this.responseReleases.delete(response)
  }

  private headers(): Record<string, string> {
    return {
      'acp-connection-id': this.connectionId,
      ...(this.sessionToken === '' ? {} : { 'acp-session-token': this.sessionToken }),
    }
  }
}

async function* readAcpSseMessages(response: Response): AsyncGenerator<JsonRpcMessage, void, void> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/event-stream')) {
    const text = await response.text()
    if (text.trim() !== '') {
      try {
        const value = JSON.parse(text) as JsonRpcMessage
        yield value
      } catch { /* 非 JSON 的 :ok 响应没有协议消息。 */ }
    }
    return
  }
  const body = response.body
  if (body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  const emit = async function* (): AsyncGenerator<JsonRpcMessage, void, void> {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    if (data.trim() === '') return
    try {
      const value = JSON.parse(data) as JsonRpcMessage
      yield value
    } catch { /* 忽略 SSE 心跳或厂商非 JSON 扩展。 */ }
  }
  while (true) {
    const chunk = await reader.read()
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        for await (const message of emit()) yield message
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
      newline = buffer.indexOf('\n')
    }
    if (chunk.done) break
  }
  if (dataLines.length > 0) for await (const message of emit()) yield message
}

function discoverWorkBuddySidecarSocket(
  configRoot: string,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = environment.WORKBUDDY_SIDECAR_SOCKET?.trim()
  if (explicit) return explicit
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'unknown'
  const runtimeRoot = platform === 'win32'
    ? join(tmpdir(), 'wb', sha1Token(configRoot, 12))
    : join(environment.TMPDIR?.trim() || tmpdir(), `wb-${sha1Token(uid, 6)}`, sha1Token(configRoot, 12))
  const pidPath = join(runtimeRoot, 'sidecar.pid')
  try {
    const record = JSON.parse(readFileSync(pidPath, 'utf8')) as { controlPipeUuid?: unknown }
    if (typeof record.controlPipeUuid !== 'string' || !/^[a-f0-9]+$/u.test(record.controlPipeUuid)) throw new Error('invalid sidecar pid record')
    if (platform === 'win32') return `\\\\.\\pipe\\workbuddy-${sha1Token(configRoot, 12)}-sidecar-${record.controlPipeUuid}`
    const socket = join(runtimeRoot, `sidecar-${record.controlPipeUuid}.sock`)
    try { statSync(socket); return socket } catch { throw new Error('sidecar socket missing') }
  } catch {
    // 5.7.3 的 sidecar 先监听带随机 UUID 的 socket，再写 sidecar.pid。
    // PID 文件可能因异常退出或文件清理丢失，但存活 sidecar 仍可被复用；
    // 只扫描严格匹配的 control socket，避免把会话 data socket 当成控制端点。
    if (platform === 'win32') return null
    try {
      const candidates = readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSocket()) && /^sidecar-[a-f0-9]+\.sock$/u.test(entry.name))
      .flatMap((entry) => {
        const socket = join(runtimeRoot, entry.name)
        try { return [{ socket, modifiedAt: statSync(socket).mtimeMs }] }
        catch { return [] }
      })
        .sort((left, right) => right.modifiedAt - left.modifiedAt)
      return candidates[0]?.socket ?? null
    } catch {
      return null
    }
  }
}

async function resolveWorkBuddyAcpEndpoint(
  sidecar: WorkBuddySidecarClient,
  input: CodingNsCliTurnInput,
  launch: { readonly command: string; readonly args: readonly string[] },
  configRoot: string,
  baseEnvironment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
  onCreated: (sessionId: string) => void,
): Promise<string> {
  const sessions = await sidecar.request('session.list', {}, { timeoutMs: 5_000 }).catch(() => [])
  if (Array.isArray(sessions)) {
    const candidates = sessions.filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.acpEndpoint === 'string')
    const host = candidates.find((entry) => typeof entry.sessionId === 'string' && entry.sessionId.includes('__workbuddy_cli_host__'))
    const endpoint = host?.acpEndpoint ?? candidates[0]?.acpEndpoint
    if (typeof endpoint === 'string' && endpoint.trim() !== '') return endpoint
  }

  const sessionId = `codingns-${input.sessionId}-${randomUUID()}`
  const created = await sidecar.request('session.create', {
    sessionId,
    command: launch.command,
    args: launch.args,
    cwd: input.cwd ?? process.cwd(),
    port: 0,
    env: workBuddySidecarEnvironment(baseEnvironment, configRoot, launch.command, platform, environment),
  }, { timeoutMs: 195_000 })
  const endpoint = isRecord(created) && typeof created.acpEndpoint === 'string' ? created.acpEndpoint.trim() : ''
  if (endpoint === '') throw new Error('WorkBuddy sidecar 未返回 ACP 地址')
  onCreated(sessionId)
  return endpoint
}

function sha1Token(value: string, length: number): string {
  return createHash('sha1').update(value).digest('hex').slice(0, length)
}

function workBuddyLaunchSpec(
  cliCommand: string,
  electronOverride: string | undefined,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): { readonly command: string; readonly args: readonly string[] } {
  const cliPath = cliCommand
  if (platform === 'darwin') {
    const appRoot = cliPath.match(/^(.*\.app)\/Contents\/Resources\//u)?.[1]
    const electron = electronOverride
      || (appRoot === undefined ? undefined : join(appRoot, 'Contents/MacOS/Electron'))
      || '/Applications/WorkBuddy.app/Contents/MacOS/Electron'
    return {
      command: electron,
      args: [cliPath, '--serve', '--no-session-persistence', '--setting-sources', 'user', '--strict-mcp-config'],
    }
  }
  const electron = electronOverride || environment.WORKBUDDY_ELECTRON_PATH || cliPath
  return {
    command: electron,
    args: [cliPath, '--serve', '--no-session-persistence', '--setting-sources', 'user', '--strict-mcp-config'],
  }
}

function workBuddySidecarEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  configRoot: string,
  launchCommand: string,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const appRoot = platform === 'darwin'
    ? launchCommand.match(/^(.*\.app)\/Contents\/MacOS\/Electron$/u)?.[1]
    : undefined
  const appPath = base.WORKBUDDY_APP_PATH || (appRoot === undefined ? '/Applications/WorkBuddy.app/Contents/Resources/app.asar' : join(appRoot, 'Contents/Resources/app.asar'))
  const resourcesPath = base.WORKBUDDY_RESOURCES_PATH || dirname(appPath)
  const env = {
    ...base,
    ELECTRON_RUN_AS_NODE: '1',
    WORKBUDDY_IS_PACKAGED: '1',
    WORKBUDDY_APP_PATH: base.WORKBUDDY_APP_PATH || appPath,
    WORKBUDDY_CONFIG_DIR: configRoot,
    CODEBUDDY_CONFIG_DIR: configRoot,
    WORKBUDDY_DATA_FOLDER_NAME: '.workbuddy',
    WORKBUDDY_APP_NAME: 'WorkBuddy',
    WORKBUDDY_APPLICATION_NAME: 'WorkBuddy',
    WORKBUDDY_PRODUCT_NAME: 'WorkBuddy',
    WORKBUDDY_RESOURCES_PATH: resourcesPath,
    WORKBUDDY_USER_DATA_DIR: base.WORKBUDDY_USER_DATA_DIR || join(configRoot, 'app'),
    WORKBUDDY_NODE_ENV: 'production',
    ACC_PRODUCT_CONFIG_PATH: base.ACC_PRODUCT_CONFIG_PATH || join(configRoot, 'cache/acc-product-config-v3.json'),
    CODEBUDDY_DISABLE_IDE: '1',
    CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
    CODEBUDDY_GATEWAY_AUTH: base.CODEBUDDY_GATEWAY_AUTH || 'password',
    CODEBUDDY_GATEWAY_PASSWORD: base.CODEBUDDY_GATEWAY_PASSWORD || randomUUID(),
    CODEBUDDY_HOST: base.CODEBUDDY_HOST || 'workbuddy-desktop',
    CODEBUDDY_INTERNET_ENVIRONMENT: base.CODEBUDDY_INTERNET_ENVIRONMENT || 'internal',
    CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT: base.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT || 'internal',
    SERVER__PORT: '0',
    SERVER__HOST: '127.0.0.1',
    ...(environment.WORKBUDDY_EXTRA_PATHS === undefined ? {} : { WORKBUDDY_EXTRA_PATHS: environment.WORKBUDDY_EXTRA_PATHS }),
  }
  return env
}

function resolveConfigRoot(
  profile: CodeBuddyRuntimeProfile,
  explicit: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const lookupEnvVars = profile.configRootLookupEnvVars ?? profile.configRootEnvVars
  const candidate = explicit?.trim()
    || lookupEnvVars.map((name) => environment[name]?.trim()).find((value): value is string => Boolean(value))
    || profile.defaultConfigRoot
  return candidate
}

function bundledWorkBuddyCommands(platform: NodeJS.Platform, environment: Readonly<Record<string, string | undefined>>): readonly string[] {
  if (platform === 'darwin') {
    const roots = [
      '/Applications/WorkBuddy AI.app',
      '/Applications/WorkBuddy.app',
      join(homedir(), 'Applications/WorkBuddy AI.app'),
      join(homedir(), 'Applications/WorkBuddy.app'),
    ]
    return roots.map((root) => join(root, 'Contents/Resources/app.asar.unpacked/cli/bin/codebuddy'))
  }
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA ?? join(homedir(), 'AppData/Local')
    const programFiles = environment.PROGRAMFILES ?? 'C:\\Program Files'
    const roots = [
      join(local, 'Programs/WorkBuddy AI'),
      join(local, 'Programs/WorkBuddy'),
      join(programFiles, 'WorkBuddy AI'),
      join(programFiles, 'WorkBuddy'),
    ]
    return roots.flatMap((root) => [
      join(root, 'resources/app.asar.unpacked/cli/bin/codebuddy.exe'),
      join(root, 'resources/app.asar.unpacked/cli/bin/codebuddy.cmd'),
      join(root, 'resources/app.asar.unpacked/cli/bin/codebuddy'),
    ])
  }
  return []
}

function uniqueCommands(commands: readonly string[]): readonly string[] {
  return [...new Set(commands.filter((command) => command.trim().length > 0))]
}

/**
 * 官方认证文件不按 CODEBUDDY_CONFIG_DIR 分片，而是按 HOME 下的
 * CodeBuddyExtension/Data/Public 分片。若全局文件正好属于当前区域，复用它
 * 保持现有登录态；若属于另一区域或不存在，切换到适配器专用 HOME。
 */
function resolveAuthenticationHome(
  profile: CodeBuddyRuntimeProfile,
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (profile.isolatedHome === undefined) return undefined
  const adapterRegion = profile.adapterId === CODEBUDDY_PROFILE.adapterId ? detectCodeBuddyRegion(environment) : undefined
  if (adapterRegion === undefined) return profile.isolatedHome
  const baseHome = platform === 'win32'
    ? environment.USERPROFILE?.trim() || environment.HOME?.trim() || homedir()
    : environment.HOME?.trim() || homedir()
  const authPath = platform === 'darwin'
    ? join(baseHome, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')
    : platform === 'win32'
      ? join(baseHome, 'AppData/Local/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')
      : join(baseHome, '.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')
  let domain: string | undefined
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8')) as { auth?: { domain?: unknown } }
    if (typeof parsed.auth?.domain === 'string') domain = parsed.auth.domain.trim().toLowerCase()
  } catch {
    // 没有全局认证文件或文件损坏时，直接使用适配器隔离目录。
  }
  const matches = adapterRegion === 'cn' ? INTERNAL_AUTH_DOMAINS.has(domain ?? '') : EXTERNAL_AUTH_DOMAINS.has(domain ?? '')
  if (matches) return undefined
  return adapterRegion === 'cn' ? CODEBUDDY_CN_AUTH_HOME : CODEBUDDY_INTERNATIONAL_AUTH_HOME
}

type CodeBuddyRegion = 'cn' | 'international'

/**
 * 从显式环境、认证域名和产品快照推断 CodeBuddy 区域。
 * 官方 CLI 只有一个二进制，区域必须在启动前确定，否则模型和请求端点会串线。
 */
function detectCodeBuddyRegion(environment: Readonly<Record<string, string | undefined>>): CodeBuddyRegion {
  const configured = `${environment.CODEBUDDY_INTERNET_ENVIRONMENT ?? environment.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT ?? ''}`.trim().toLowerCase()
  if (configured === 'internal' || configured === 'cn' || configured === 'china' || configured === 'ioa') return 'cn'
  if (configured === 'external' || configured === 'international' || configured === 'overseas') return 'international'

  const homes = uniquePaths([
    environment.HOME?.trim() || homedir(),
    CODEBUDDY_CN_AUTH_HOME,
    CODEBUDDY_INTERNATIONAL_AUTH_HOME,
  ])
  for (const home of homes) {
    const domain = readCodeBuddyAuthDomain(home, environment)
    if (domain === undefined) continue
    if (INTERNAL_AUTH_DOMAINS.has(domain)) return 'cn'
    if (EXTERNAL_AUTH_DOMAINS.has(domain)) return 'international'
  }

  const productConfig = environment.ACC_PRODUCT_CONFIG_PATH?.trim()
  if (productConfig !== undefined && productConfig !== '') {
    try {
      const value = JSON.parse(readFileSync(productConfig, 'utf8')) as { endpoint?: unknown }
      const endpoint = typeof value.endpoint === 'string' ? value.endpoint.toLowerCase() : ''
      if (endpoint.includes('codebuddy.ai')) return 'international'
      if (endpoint.includes('copilot.tencent.com') || endpoint.includes('codebuddy.cn')) return 'cn'
    } catch {
      // 产品快照损坏时回退到官方默认国际环境。
    }
  }
  return 'international'
}

function readCodeBuddyAuthDomain(home: string, environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const authPath = environment.CODEBUDDY_AUTH_FILE?.trim()
    || (process.platform === 'darwin'
      ? join(home, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')
      : process.platform === 'win32'
        ? join(home, 'AppData/Local/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')
        : join(home, '.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info'))
  try {
    const value = JSON.parse(readFileSync(authPath, 'utf8')) as { auth?: { domain?: unknown } }
    return typeof value.auth?.domain === 'string' ? value.auth.domain.trim().toLowerCase() : undefined
  } catch {
    return undefined
  }
}

function summarizeCliFailure(displayName: string, output: string): string | undefined {
  if (/Cannot find module ['"]esbuild['"]/u.test(output)) {
    return `${displayName} CLI 启动失败：缺少依赖 esbuild，请重新安装 CLI`
  }
  if (/Cannot find module/u.test(output)) {
    return `${displayName} CLI 启动失败：缺少 Node.js 依赖，请重新安装 CLI`
  }
  if (output.trim().length === 0) return undefined
  return `${displayName} CLI 启动失败，请检查命令输出`
}

function defaultModelCatalogPaths(
  profile: CodeBuddyRuntimeProfile,
  configRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const region = profile.adapterId === CODEBUDDY_PROFILE.adapterId ? detectCodeBuddyRegion(environment) : undefined
  const configuredNames = profile.adapterId === CODEBUDDY_PROFILE.adapterId
    ? region === 'cn' ? ['CODEBUDDY_CN_MODEL_CATALOG', 'CODEBUDDY_MODEL_CATALOG'] : ['CODEBUDDY_MODEL_CATALOG', 'CODEBUDDY_CN_MODEL_CATALOG']
    : [profile.modelCatalogEnvVar ?? `${profile.adapterId.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_MODEL_CATALOG`]
  const configured = configuredNames.flatMap((name) => {
    const value = environment[name]?.trim()
    return value === undefined || value === '' ? [] : [value]
  })
  const paths: string[] = [...configured]
  if (profile.adapterId === WORKBUDDY_PROFILE.adapterId) {
    const userDataRoot = join(homedir(), '.workbuddy')
    const configSiblingRoot = join(dirname(configRoot), '.workbuddy')
    // WorkBuddy 桌面端把最新云端产品快照写在 local_storage envelope 中；
    // cache/acc-product-config-v3.json 可能仍是旧端点的目录，必须优先读取前者。
    const localStorageRoots = uniquePaths([
      join(userDataRoot, 'local_storage'),
      join(configSiblingRoot, 'local_storage'),
    ])
    for (const root of localStorageRoots) paths.push(...workBuddyLocalStorageCatalogPaths(root))
    paths.push(join(userDataRoot, 'cache/acc-product-config-v3.json'))
    if (configSiblingRoot !== userDataRoot) paths.push(join(configSiblingRoot, 'cache/acc-product-config-v3.json'))
  }
  if (profile.adapterId === CODEBUDDY_PROFILE.adapterId) {
    if (region === 'cn') paths.push(join(configRoot, 'product.internal.json'))
    paths.push(join(configRoot, 'product.json'))
    if (region !== 'cn') paths.push(join(configRoot, 'product.internal.json'))
  }
  return [
    ...paths,
  ]
}

function defaultCatalogForProfile(profile: CodeBuddyRuntimeProfile): CodingNsCliModelCatalog {
  if (profile.adapterId === WORKBUDDY_PROFILE.adapterId) return WORKBUDDY_DEFAULT_CATALOG
  return CODEBUDDY_DEFAULT_CATALOG
}

/** 从 CodeBuddy/WorkBuddy 产品快照投影主 Agent 真正可选的模型。 */
function readProductCatalog(
  paths: readonly string[],
  readFile: typeof readFileSync,
  command: string | null,
  profile: CodeBuddyRuntimeProfile,
  region: CodeBuddyRegion = detectCodeBuddyRegion(process.env),
): CodingNsCliModelCatalog | null {
  const commandRoots = command === null ? [] : commandProductRoots(command)
  const commandCatalogs = commandRoots.flatMap((commandRoot) => [
    ...(profile.adapterId === WORKBUDDY_PROFILE.adapterId
      ? [join(commandRoot, 'product.internal.json')]
      : []),
    ...(profile.adapterId === CODEBUDDY_PROFILE.adapterId && region === 'cn'
      ? [join(commandRoot, 'product.internal.json'), join(commandRoot, 'product-ide-cn.json')]
      : []),
    join(commandRoot, 'product.json'),
    join(commandRoot, 'product-ide.json'),
    join(commandRoot, 'product.cloudhosted.json'),
  ])
  const candidates = [
    ...paths,
    ...commandCatalogs,
  ]
  const seen = new Set<string>()
  for (const path of candidates) {
    if (seen.has(path)) continue
    seen.add(path)
    let parsed: unknown
    try {
      parsed = JSON.parse(String(readFile(path, 'utf8')))
    } catch {
      continue
    }
    const catalog = parseProductCatalog(parsed, profile)
    if (catalog !== null) return catalog
  }
  return null
}

/** 返回 WorkBuddy 桌面端按更新时间排列的产品配置 envelope 文件。 */
function workBuddyLocalStorageCatalogPaths(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(?:wb_)?entry_[0-9a-f]+\.info$/u.test(entry.name))
      .map((entry) => {
        const path = join(root, entry.name)
        try { return { path, modifiedAt: statSync(path).mtimeMs } }
        catch { return { path, modifiedAt: 0 } }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .map((entry) => entry.path)
  } catch {
    return []
  }
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)]
}

/** 从 CLI 入口推导官方产品包根目录，兼容 npm shim 和直接入口。 */
function commandProductRoots(command: string): readonly string[] {
  const roots = new Set<string>()
  const add = (path: string): void => {
    const root = dirname(dirname(path))
    if (root !== '.') roots.add(root)
  }
  add(command)
  try { add(realpathSync(command)) } catch { /* 命令可能只是 PATH 中的名称 */ }
  return [...roots]
}

function parseProductCatalog(value: unknown, profile: CodeBuddyRuntimeProfile): CodingNsCliModelCatalog | null {
  const records: Record<string, unknown>[] = []
  if (isRecord(value)) records.push(value)
  else if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) continue
      records.push(isRecord(entry.data) ? entry.data : entry)
    }
  }
  for (const record of records) {
    const catalog = parseProductCatalogRecord(record, profile)
    if (catalog !== null) return catalog
  }
  return null
}

function parseProductCatalogRecord(value: Record<string, unknown>, profile: CodeBuddyRuntimeProfile): CodingNsCliModelCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.models)) return null
  const metadata = new Map<string, Record<string, unknown>>()
  for (const entry of value.models) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id !== '') metadata.set(id, entry)
  }
  if (metadata.size === 0) return null

  const primaryAgentNames = profile.adapterId === WORKBUDDY_PROFILE.adapterId ? ['cli'] : ['craft', 'cli', 'agent', 'chat']
  const configuredIds = Array.isArray(value.agents)
    ? value.agents
      .filter((entry) => isRecord(entry) && typeof entry.name === 'string' && primaryAgentNames.includes(entry.name))
      .flatMap((entry) => isRecord(entry) && Array.isArray(entry.models) ? entry.models : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim())
    : [...metadata.keys()]
  const configuredModelIds = [...new Set(configuredIds)].filter((id) => metadata.has(id))
  // WorkBuddy 的最新快照已不再把 Auto 三档写入 `agents[].models`，但全局
  // `models` 仍然保留它们。目录投影必须以两处数据的并集为准，否则三档会
  // 消失，且 `auto.reasoning.effort` 会被错误地当成普通模型思考强度。
  const autoTierIds: string[] = profile.adapterId === WORKBUDDY_PROFILE.adapterId
    ? WORKBUDDY_AUTO_TIER_MODELS.filter((model) => metadata.has(model.id)).map((model) => model.id)
    : []
  const modelIds = [...new Set([...configuredModelIds, ...autoTierIds])]
  if (modelIds.length === 0) return null

  // 产品配置把 Auto 三档展开进 agent.models；在 CodingNS 的目录契约中，
  // 它们属于默认模型的思考强度，不能继续作为三个普通模型渲染。
  const regularModelIds = modelIds.filter((id) => !autoTierIds.includes(id)
    && !(profile.adapterId === WORKBUDDY_PROFILE.adapterId && id === WORKBUDDY_AUTO_MODEL_ID))

  const models = regularModelIds.map((id) => {
    const entry = metadata.get(id)!
    const reasoning = isRecord(entry.reasoning) ? entry.reasoning : undefined
    const supportedEfforts = reasoning !== undefined && Array.isArray(reasoning.supportedEfforts)
      ? reasoning.supportedEfforts.filter((effort): effort is string => typeof effort === 'string' && effort.trim() !== '')
      : reasoning !== undefined && typeof reasoning.effort === 'string' && reasoning.effort.trim() !== ''
        ? [reasoning.effort.trim()]
        : []
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
    const description = typeof entry.descriptionZh === 'string' && entry.descriptionZh.trim() !== ''
      ? entry.descriptionZh.trim()
      : typeof entry.descriptionEn === 'string' && entry.descriptionEn.trim() !== ''
        ? entry.descriptionEn.trim()
        : undefined
    return {
      id,
      name,
      ...(description === undefined ? {} : { description }),
      efforts: [...new Set(supportedEfforts)],
    }
  })
  const autoTierLabels = Object.fromEntries(
    autoTierIds.map((id) => {
      const configuredName = metadata.get(id)?.name
      const fallbackName = WORKBUDDY_AUTO_TIER_MODELS.find((model) => model.id === id)?.name ?? id
      return [id, typeof configuredName === 'string' && configuredName.trim() !== '' ? configuredName.trim() : fallbackName]
    }),
  )
  const providerDefault = {
    id: 'provider-default',
    name: `跟随 ${profile.displayName} 默认模型`,
    efforts: autoTierIds,
    ...(autoTierIds.length === 0 ? {} : { effortLabels: autoTierLabels }),
  }
  return {
    groups: [{ id: profile.adapterId, name: profile.displayName, models: [providerDefault, ...models] }],
    currentModel: null,
    currentEffort: null,
  }
}

function resolveCodeBuddyModelId(profile: CodeBuddyRuntimeProfile, modelId: string | undefined, effortId: string | undefined): string | undefined {
  if (profile.adapterId === WORKBUDDY_PROFILE.adapterId && isProviderDefaultModel(modelId) && effortId !== undefined && WORKBUDDY_AUTO_TIER_IDS.has(effortId)) {
    return effortId
  }
  return modelId
}

function codeBuddyMessageToChunk(message: JsonRpcMessage): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const method = typeof message.method === 'string' ? message.method.toLowerCase() : ''
  const rawType = update.sessionUpdate ?? update.type ?? method
  const type = typeof rawType === 'string' ? rawType.toLowerCase() : ''
  const reasoning = reasoningText(update)
  if (reasoning !== null) return { type: 'reasoning-delta', text: reasoning }
  const text = acpText(update.delta ?? update.text ?? update.content ?? update.message)
  const content = isRecord(update.content) ? update.content : undefined
  const messageId = firstToolText(update.messageId, update.message_id, update.itemId, update.item_id, content?.messageId, content?.message_id, content?.id)
  const withMessageId = messageId === undefined ? {} : { messageId }

  const permission = codeBuddyPermissionRequest(message)
  if (permission !== null) {
    return {
      type: 'permission-request',
      requestId: permission.requestId,
      kind: permission.kind,
      ...(permission.toolName === undefined ? {} : { toolName: permission.toolName }),
      ...(permission.callId === undefined ? {} : { callId: permission.callId }),
      ...(permission.detail === undefined ? {} : { detail: permission.detail }),
    }
  }
  const elicitation = readAcpElicitationRequest(message)
  if (elicitation !== null) return { type: 'question-request', requestId: elicitation.requestId, questions: elicitation.questions }
  if (type.includes('permission') || type.includes('interruption')) return null
  if (type.includes('thought') || type.includes('reason')) return text ? { type: 'reasoning-delta', text, ...withMessageId } : null
  if (type.includes('user') && type.includes('message')) return null
  if (type.includes('agent_message') || type.includes('text') || type === 'message') return text ? { type: 'text-delta', text, ...withMessageId } : null

  if (type.includes('tool') || type.includes('command')) {
    const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
    const toolName = firstToolText(tool.name, tool.toolName, tool.tool_name, tool.title, update.name, update.toolName, update.tool_name, update.title)
    const callId = firstToolText(tool.callId, tool.call_id, tool.toolCallId, tool.tool_call_id, tool.toolUseId, tool.tool_use_id, tool.id, update.toolCallId, update.tool_call_id, update.id)
    if (toolName === undefined && callId === undefined) return null
    const input = serializeToolValue(tool.rawInput ?? tool.input ?? tool.arguments ?? tool.args ?? tool.parameters ?? update.rawInput)
    const output = serializeToolValue(tool.rawOutput ?? tool.output ?? tool.result ?? update.rawOutput)
    const error = serializeToolValue(tool.error ?? update.error)
    const fallback = error !== undefined || type.includes('error') || type.includes('fail')
      ? 'failed'
      : output !== undefined || type.includes('result') || type.includes('complete')
        ? 'completed'
        : 'running'
    return {
      type: 'tool-event',
      toolName: toolName ?? 'tool',
      status: normalizeToolStatus(tool.status ?? tool.state ?? update.status, fallback),
      ...(callId === undefined ? {} : { callId }),
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output, outputMode: type.includes('delta') ? 'delta' as const : 'snapshot' as const }),
      ...(error === undefined ? {} : { error }),
      ...(firstToolText(tool.agentId, tool.agent_id, update.agentId, update.agent_id) ? { agentId: firstToolText(tool.agentId, tool.agent_id, update.agentId, update.agent_id)! } : {}),
      ...(serializeToolValue(tool.detail ?? update.detail) === undefined ? {} : { detail: serializeToolValue(tool.detail ?? update.detail)! }),
    }
  }

  // CodeBuddy ACP 的 usage_update 使用 used/size 表示当前上下文占用和窗口，
  // 这不是账户套餐余量；先按会话上下文事件解析，避免把 used 误当成输入 token。
  if (type.includes('usage_update')) {
    const usage = codeBuddyUsageChunk(update)
    if (usage !== null) return usage
  }
  const usage = usageChunk(update)
  if (usage !== null) return usage
  if (type.includes('turn_completed') || type.includes('turn_complete') || type.includes('prompt_end') || type === 'done' || type === 'result' || type === 'completed') return { type: 'finish', reason: 'stop' }
  if (type.includes('error') || type.includes('failed')) {
    const failure = readFailure(update)
    return { type: 'finish', reason: 'error', ...(failure === undefined ? {} : { failure }) }
  }
  return null
}

/** 读取 CodeBuddy/WorkBuddy 使用的 ACP 标准权限请求。 */
function codeBuddyPermissionRequest(message: JsonRpcMessage): {
  readonly requestId: string
  readonly kind: string
  readonly toolName?: string
  readonly callId?: string
  readonly detail?: string
  readonly allowOptionId: string
  readonly rejectOptionId: string
} | null {
  const method = typeof message.method === 'string' ? message.method.toLowerCase() : ''
  const params = isRecord(message.params) ? message.params : {}
  // 只有标准 server request 有明确的 response id；notification 扩展没有可验证
  // 的回传方法，不能把它伪装成可审批的 DSH 权限事件。
  if (method !== 'session/request_permission') return null
  const requestId = message.id ?? params.requestId ?? params.request_id ?? params.id
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return null
  const tool = isRecord(params.toolCall) ? params.toolCall : isRecord(params.tool_call) ? params.tool_call : {}
  const toolName = firstToolText(tool.title, tool.name, tool.toolName, tool.tool_name, params.toolName, params.tool_name)
  const callId = firstToolText(tool.toolCallId, tool.tool_call_id, tool.callId, tool.call_id, params.callId, params.call_id)
  const detail = firstToolText(params.detail, params.reason, params.message, tool.detail)
  const options = Array.isArray(params.options) ? params.options : []
  const ids = options.flatMap((option) => {
    if (!isRecord(option)) return []
    const id = firstToolText(option.optionId, option.option_id, option.id)
    if (id === undefined) return []
    return [{ id, kind: firstToolText(option.kind, option.type)?.toLowerCase() ?? '' }]
  })
  return {
    requestId: String(requestId), kind: firstToolText(params.kind, params.permissionKind, tool.kind) ?? toolName ?? 'unknown',
    ...(toolName === undefined ? {} : { toolName }), ...(callId === undefined ? {} : { callId }), ...(detail === undefined ? {} : { detail }),
    allowOptionId: ids.find((option) => /allow|approve|accept/u.test(option.kind))?.id ?? ids[0]?.id ?? 'allow-once',
    rejectOptionId: ids.find((option) => /reject|deny|decline|cancel/u.test(option.kind))?.id ?? ids[1]?.id ?? 'reject-once',
  }
}

/** 解析 CodeBuddy ACP usage_update；仅投影会话上下文，不推断账户套餐额度。 */
export function codeBuddyUsageChunk(value: unknown): CodingNsAgentEvent | null {
  if (!isRecord(value)) return null
  const used = finiteNonNegativeNumber(value.used)
  const size = finiteNonNegativeNumber(value.size)
  if (used === undefined && size === undefined) return null
  const contextTokens = used ?? 0
  const contextWindow = size !== undefined && size > 0 ? size : undefined
  return {
    type: 'usage',
    inputTokens: 0,
    outputTokens: 0,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    contextTokens,
    ...(contextWindow === undefined ? {} : { contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)) }),
  }
}

/** 判断 ACP usage 是否已经包含可用于 token-meter 的真实数值。 */
function hasTokenUsage(event: Extract<CodingNsAgentEvent, { type: 'usage' }>): boolean {
  return event.inputTokens > 0 || event.outputTokens > 0
    || (event.cacheReadTokens ?? 0) > 0 || (event.cacheWriteTokens ?? 0) > 0
}

/** 把 ACP 已确认的窗口补到 JSONL token 采样，保证最后一个 usage 也含上下文比例。 */
function enrichCodeBuddyUsageContext(event: CodingNsAgentEvent, contextWindow: number | undefined): CodingNsAgentEvent {
  if (event.type !== 'usage' || event.contextWindow !== undefined || contextWindow === undefined || contextWindow <= 0) return event
  const contextTokens = event.contextTokens ?? event.inputTokens
  return {
    ...event,
    contextWindow,
    contextTokens,
    contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)),
  }
}

interface CodeBuddyHistoryUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly totalTokens?: number
  readonly contextWindow?: number
}

/**
 * 读取 CodeBuddy JSONL 中最新 assistant 记录的 provider 用量。
 *
 * CodeBuddy 的 ACP 通道不会把这组字段放进 `session/prompt`，但同一轮完成后
 * 会把 `rawUsage` 和 `message.usage` 原样写入会话文件。这里按完整输入、缓存读、
 * 缓存写三桶折算，避免把 `prompt_tokens` 和缓存桶重复计入 DSH。
 */
export function readCodeBuddyHistoryUsage(path: string): CodingNsAgentEvent | null {
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch { return null }
  const lines = text.split(/\r?\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    try {
      const record = JSON.parse(line) as unknown
      const usage = parseCodeBuddyHistoryUsage(record)
      if (usage !== null) return historyUsageEvent(usage)
    } catch {
      // JSONL 可能正被 CLI 追加，跳过损坏的尾行并继续寻找上一条完整记录。
    }
  }
  return null
}

/** 从最新 assistant 记录取得实际路由模型，用于查找动态产品快照的窗口。 */
function readCodeBuddyHistoryModel(path: string): string | null {
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch { return null }
  const lines = text.split(/\r?\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    try {
      const value = JSON.parse(line) as unknown
      if (!isRecord(value)) continue
      const providerData = isRecord(value.providerData) ? value.providerData : undefined
      const model = firstText(providerData?.model, providerData?.requestModelId, value.model)
      if (model !== undefined) return model
    } catch {
      // 跳过尚未写完整的尾行。
    }
  }
  return null
}

/** 读取 CodeBuddy 动态产品快照中的模型上下文窗口。 */
function readCodeBuddyModelContextWindow(
  modelId: string,
  configRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
  readFile: typeof readFileSync,
): number | undefined {
  const home = environment.HOME?.trim() || homedir()
  const files: string[] = [
    join(configRoot, 'product.internal.json'),
    join(configRoot, 'product.json'),
  ]
  const storageRoots = uniquePaths([
    join(configRoot, 'local_storage'),
    join(home, '.codebuddy/local_storage'),
  ])
  for (const root of storageRoots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.info')) files.push(join(root, entry.name))
      }
    } catch {
      // 当前安装可能没有 local_storage，继续检查产品文件。
    }
  }
  for (const path of files) {
    let parsed: unknown
    try { parsed = JSON.parse(String(readFile(path, 'utf8'))) }
    catch { continue }
    const records = Array.isArray(parsed) ? parsed : [parsed]
    for (const record of records) {
      const data = isRecord(record) && isRecord(record.data) ? record.data : record
      if (!isRecord(data) || !Array.isArray(data.models)) continue
      const model = data.models.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === modelId)
      if (model === undefined) continue
      const maxInputTokens = finiteNonNegativeNumber(model.maxInputTokens)
      if (maxInputTokens !== undefined && maxInputTokens > 0) return maxInputTokens
      const contextWindow = isRecord(model.contextWindow) ? model.contextWindow : undefined
      const defaultLength = finiteNonNegativeNumber(contextWindow?.defaultLength)
      if (defaultLength !== undefined && defaultLength > 0) return defaultLength
    }
  }
  return undefined
}

function firstText(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim()
}

function parseCodeBuddyHistoryUsage(value: unknown): CodeBuddyHistoryUsage | null {
  if (!isRecord(value)) return null
  const providerData = isRecord(value.providerData) ? value.providerData : undefined
  const raw = providerData !== undefined && isRecord(providerData.rawUsage) ? providerData.rawUsage : undefined
  const message = isRecord(value.message) ? value.message : undefined
  const messageUsage = message !== undefined && isRecord(message.usage) ? message.usage : undefined
  const providerUsage = providerData !== undefined && isRecord(providerData.usage) ? providerData.usage : undefined
  if (raw === undefined && messageUsage === undefined && providerUsage === undefined) return null

  const inputTokens = firstNumber(
    raw?.prompt_tokens,
    messageUsage?.input_tokens,
    providerUsage?.inputTokens,
    value.input_tokens,
  )
  const outputTokens = firstNumber(
    raw?.completion_tokens,
    messageUsage?.output_tokens,
    providerUsage?.outputTokens,
    value.output_tokens,
  )
  if (inputTokens === undefined && outputTokens === undefined) return null

  const cacheReadTokens = largestNumber(
    raw?.prompt_cache_hit_tokens,
    raw?.cache_read_input_tokens,
    messageUsage?.cache_read_input_tokens,
    cachedTokenDetail(providerUsage),
  )
  const cacheWriteTokens = largestNumber(
    raw?.cache_creation_input_tokens,
    raw?.prompt_cache_miss_tokens,
    raw?.prompt_cache_write_tokens,
    messageUsage?.cache_creation_input_tokens,
  )
  const fullInput = inputTokens ?? Math.max(0, (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0))
  const output = outputTokens ?? 0
  const totalTokens = firstNumber(raw?.total_tokens, messageUsage?.total_tokens, providerUsage?.totalTokens)
    ?? fullInput + output
  const modelUsage = isRecord(value.modelUsage)
    ? value.modelUsage
    : providerData !== undefined && isRecord(providerData.modelUsage) ? providerData.modelUsage : undefined
  const modelContextWindows = modelUsage === undefined
    ? []
    : Object.values(modelUsage).map((entry) => isRecord(entry) ? entry.contextWindow ?? entry.context_window : undefined)
  const contextWindow = largestNumber(
    value.contextWindow,
    value.context_window,
    ...modelContextWindows,
  )
  return {
    inputTokens: fullInput,
    outputTokens: output,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    totalTokens,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

function historyUsageEvent(usage: CodeBuddyHistoryUsage): Extract<CodingNsAgentEvent, { type: 'usage' }> {
  const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cached)
  return {
    type: 'usage',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    uncachedInputTokens,
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined || usage.inputTokens <= 0
      ? {}
      : { cacheHitRate: Number((usage.cacheReadTokens / usage.inputTokens * 100).toFixed(4)) }),
    contextTokens: usage.inputTokens,
    ...(usage.contextWindow === undefined ? {} : {
      contextWindow: usage.contextWindow,
      contextUsageRatio: Number(Math.min(1, usage.inputTokens / usage.contextWindow).toFixed(6)),
    }),
  }
}

function cachedTokenDetail(value: Record<string, unknown> | undefined): number | undefined {
  if (value === undefined || !Array.isArray(value.inputTokensDetails)) return undefined
  return largestNumber(...value.inputTokensDetails.map((entry) => isRecord(entry) ? entry.cached_tokens : undefined))
}

function firstNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNonNegativeNumber(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function largestNumber(...values: readonly unknown[]): number | undefined {
  const numbers = values.map(finiteNonNegativeNumber).filter((value): value is number => value !== undefined)
  return numbers.length === 0 ? undefined : Math.max(...numbers)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined
  }
  return undefined
}

function readSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId === 'string' && value.sessionId.trim()) return value.sessionId.trim()
  if (typeof value.session_id === 'string' && value.session_id.trim()) return value.session_id.trim()
  if (isRecord(value.session) && typeof value.session.id === 'string' && value.session.id.trim()) return value.session.id.trim()
  return typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null
}

function promptFinish(value: unknown, signal: AbortSignal | undefined): Extract<CodingNsAgentEvent, { type: 'finish' }> {
  if (signal?.aborted) return { type: 'finish', reason: 'cancel' }
  if (!isRecord(value) || typeof value.stopReason !== 'string') return emptyResponseFinish()
  const reason = value.stopReason.toLowerCase()
  if (reason === 'cancelled' || reason === 'canceled') return { type: 'finish', reason: 'cancel' }
  if (reason === 'error' || reason === 'failed' || reason === 'refusal') {
    return {
      type: 'finish',
      reason: 'error',
      failure: promptFailure(value) ?? { message: 'WorkBuddy ACP 拒绝或结束了请求，但未返回具体错误信息。', code: 'PROVIDER_ERROR' },
    }
  }
  if (reason === 'end_turn' || reason === 'endturn' || reason === 'max_tokens' || reason === 'max_turn_requests' || reason === 'stop') {
    return { type: 'finish', reason: 'stop' }
  }
  return emptyResponseFinish()
}

function emptyResponseFinish(failure: { readonly message: string; readonly code?: string } = { message: 'CODINGNS_PROVIDER_EMPTY_RESPONSE: WorkBuddy ACP 未返回任何有效响应。', code: 'PROVIDER_ERROR' }): Extract<CodingNsAgentEvent, { type: 'finish' }> {
  return { type: 'finish', reason: 'error', failure }
}

function promptFailure(value: unknown): { message: string; code?: string } | undefined {
  const failure = isRecord(value) ? readPromptFailure(value) : undefined
  return failure
}

function readPromptFailure(value: Record<string, unknown>): { message: string; code?: string } | undefined {
  const direct = readFailure(value)
  if (direct !== undefined) return direct
  const metadata = isRecord(value._meta) ? value._meta : undefined
  const encoded = metadata === undefined ? undefined : firstToolText(
    metadata['codebuddy.ai/errorMessage'],
    metadata.errorMessage,
    metadata.error_message,
  )
  if (encoded === undefined) return undefined
  try {
    const parsed = JSON.parse(encoded) as unknown
    if (isRecord(parsed)) return readPromptFailure(parsed) ?? { message: encoded }
  } catch {
    // WorkBuddy 某些版本直接写入纯文本错误，保留该文本。
  }
  return { message: encoded }
}

function acpText(value: unknown): string | null {
  const direct = textValue(value)
  if (direct) return direct
  if (Array.isArray(value)) {
    const joined = value.map((item) => acpText(item) ?? '').join('')
    return joined.trim() ? joined : null
  }
  if (isRecord(value)) {
    for (const key of ['text', 'delta', 'content', 'message']) {
      const nested = acpText(value[key])
      if (nested) return nested
    }
  }
  return null
}

function readFailure(value: Record<string, unknown>): { message: string; code?: string } | undefined {
  const error = isRecord(value.error) ? value.error : value
  const message = firstToolText(error.message, error.errorMessage, error.error_message, error.detail, error.reason)
  if (message === undefined) return undefined
  const data = isRecord(value.data) ? value.data : undefined
  const code = firstToolText(error.code, error.errorCode, error.error_code, data?.category)
  return code === undefined ? { message } : { message, code }
}
