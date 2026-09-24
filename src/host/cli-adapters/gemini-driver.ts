import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { CodingNsAgentEvent, CodingNsCliModelCatalog, CodingNsAgentPermissionResponse, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { JsonRpcProcess } from './json-rpc-process.js'
import { isRecord, streamRpcRequest, textValue, usageChunk } from './rpc-driver-utils.js'
import { GEMINI_CATALOG, isProviderDefaultModel, resolveGeminiEfforts } from './model-catalog.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, isToolRecord, normalizeToolStatus, serializeToolValue } from './tool-observation.js'

/** Gemini 官方 ACP 优先；不支持 ACP 的旧 CLI 自动回退 headless stream-json。 */
export class GeminiCliDriver extends StandardStreamDriver {
  private readonly sessionRoots: readonly string[]
  private readonly interactions = new Map<string, {
    readonly rpc: JsonRpcProcess
    readonly permissions: Map<string, number | string>
  }>()

  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'gemini', name: 'Gemini CLI', protocol: 'acp', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission'] }, { binaries: ['gemini'] }, options)
    this.sessionRoots = options.sessionRoots ?? [join(process.env.GEMINI_CLI_HOME ?? join(homedir(), '.gemini'), 'tmp')]
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const command = (await this.detect()).command
    if (command === null) return emptyCatalog()
    const rpc = new JsonRpcProcess({ command, args: ['--acp'], spawn: this.runSpawn })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'dsh-codingns', version: '0.1.0' },
        clientCapabilities: {},
      }, { signal: controller.signal })
      const session = await rpc.request('session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      }, { signal: controller.signal })
      const catalog = parseGeminiCatalog(session)
      return catalog.groups.length > 0 ? catalog : GEMINI_CATALOG
    } catch {
      return GEMINI_CATALOG
    } finally {
      clearTimeout(timer)
      await rpc.disposeAndWait()
    }
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path).endsWith('.jsonl') && basename(path).includes(id.split('-')[0] ?? id),
      validate: async (path, id) => (await readFirstJsonRecord(path))?.sessionId === id,
    })
  }

  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['-p', input.prompt, '--output-format', 'stream-json', '--yolo']
    if (input.providerSessionId) args.push('--resume', input.providerSessionId)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    return args
  }

  /**
   * Gemini 的旧版 stream-json 会先回放一条 role=user 的消息。
   * 这条记录只是输入回显，不能投影成 DSH 的 assistant 正文；result 还要按
   * Gemini 自己的 status 和 stats 字段生成正确的终态与用量。
   */
  protected override parseEvent(value: Record<string, unknown>, input: CodingNsCliTurnInput): readonly CodingNsAgentEvent[] {
    const type = typeof value.type === 'string' ? value.type.toLowerCase() : ''
    if (type === 'message') {
      const role = typeof value.role === 'string' ? value.role.toLowerCase() : ''
      if (role === 'user') return []
    }
    if (type === 'result') return geminiStreamResultChunks(value, input.signal?.aborted ?? false)
    return super.parseEvent(value, input)
  }

  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const state = this.interactions.get(sessionId)
    const rpcId = state?.permissions.get(response.requestId)
    if (state === undefined || rpcId === undefined) throw new Error('Gemini 权限请求不存在')
    state.permissions.delete(response.requestId)
    state.rpc.respond(rpcId, { outcome: { outcome: 'selected', optionId: response.approved ? 'allow-once' : 'reject-once' } })
  }

  override dispose(): void {
    this.interactions.clear()
    super.dispose()
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    try {
      yield* this.executeAcpTurn(input)
      return
    } catch {
      if (input.signal?.aborted) {
        yield { type: 'finish', reason: 'cancel' }
        return
      }
      for await (const chunk of super.executeTurn(input)) yield chunk
    }
  }

  private async *executeAcpTurn(input: CodingNsCliTurnInput): AsyncGenerator<CodingNsAgentEvent> {
    const detection = await this.detect()
    const command = detection.command
    if (command === null) throw new Error('Gemini CLI 未安装')
    const runtimeSettings = await createGeminiRuntimeSettings(input.modelId, input.effortId)
    const rpc = new JsonRpcProcess({
      command,
      args: ['--experimental-acp'],
      cwd: input.cwd,
      ...(runtimeSettings === null ? {} : { env: runtimeSettings.env }),
      spawn: this.runSpawn,
    })
    const interaction = {
      rpc,
      permissions: new Map<string, number | string>(),
    }
    this.interactions.set(input.sessionId, interaction)
    rpc.setServerRequestHandler((message) => {
      const requestId = interactionRequestId(message)
      if (requestId === null || message.id === undefined || message.id === null) return { outcome: { outcome: 'cancelled' } }
      interaction.permissions.set(requestId, message.id)
      return new Promise<never>(() => undefined)
    })
    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'dsh-codingns', version: '0.1.0' },
        clientCapabilities: {},
      }, { signal: input.signal })
      rpc.notify('initialized', {})
      const session = input.providerSessionId
        ? await rpc.request('session/load', { sessionId: input.providerSessionId, cwd: input.cwd ?? process.cwd(), mcpServers: [] }, { signal: input.signal })
        : await rpc.request('session/new', { cwd: input.cwd ?? process.cwd(), mcpServers: [] }, { signal: input.signal })
      const sessionId = readSessionId(session) ?? input.providerSessionId ?? input.sessionId
      yield { type: 'session-binding', providerSessionId: sessionId }
      if (input.modelId && !isProviderDefaultModel(input.modelId)) {
        await rpc.request('session/set_model', { sessionId, modelId: input.modelId }, { signal: input.signal })
      }
      let finished = false
      const stream = streamRpcRequest(rpc, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      }, input.signal)
      let promptResponse: unknown
      while (true) {
        const item = await stream.next()
        if (item.done) {
          promptResponse = item.value
          break
        }
        const chunk = geminiAcpMessageToChunk(item.value)
        if (chunk?.type === 'finish') finished = true
        if (chunk !== null) yield chunk
      }
      if (!finished) yield { type: 'finish', reason: geminiPromptReason(promptResponse, input.signal) }
    } finally {
      if (this.interactions.get(input.sessionId) === interaction) this.interactions.delete(input.sessionId)
      await rpc.disposeAndWait()
      await runtimeSettings?.dispose()
    }
  }
}

function geminiPromptReason(value: unknown, signal: AbortSignal | undefined): 'stop' | 'cancel' | 'error' {
  if (signal?.aborted) return 'cancel'
  if (!isRecord(value) || typeof value.stopReason !== 'string') return 'stop'
  const reason = value.stopReason.toLowerCase()
  if (reason === 'cancelled') return 'cancel'
  if (reason === 'error' || reason === 'failed') return 'error'
  return 'stop'
}

function parseGeminiCatalog(value: unknown): CodingNsCliModelCatalog {
  if (!isRecord(value) || !isRecord(value.models) || !Array.isArray(value.models.availableModels)) return emptyCatalog()
  const models = value.models.availableModels.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.modelId !== 'string' || entry.modelId.trim() === '') return []
    const id = entry.modelId.trim()
    return [{
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
      ...(typeof entry.description === 'string' && entry.description.trim() ? { description: entry.description.trim() } : {}),
      efforts: resolveGeminiEfforts(id),
    }]
  })
  if (models.length === 0) return emptyCatalog()
  const currentModel = typeof value.models.currentModelId === 'string' && value.models.currentModelId.trim()
    ? value.models.currentModelId.trim()
    : null
  return { groups: [{ id: 'gemini', name: 'Gemini', models }], currentModel, currentEffort: null }
}

interface GeminiRuntimeSettings {
  readonly env: Readonly<Record<string, string>>
  readonly dispose: () => Promise<void>
}

type SettingsFile =
  | { readonly kind: 'missing'; readonly value: Record<string, unknown> }
  | { readonly kind: 'valid'; readonly value: Record<string, unknown> }
  | { readonly kind: 'invalid' }

/**
 * Gemini ACP 尚未实现 session/set_config_option。这里为单次 CLI 进程生成临时配置，
 * 既不改写用户设置，也确保界面选择的思考档位真正进入 generateContent 配置。
 */
async function createGeminiRuntimeSettings(modelId: string | undefined, effortId: string | undefined): Promise<GeminiRuntimeSettings | null> {
  if (!modelId || !effortId || isProviderDefaultModel(modelId)) return null
  const efforts = resolveGeminiEfforts(modelId)
  if (!efforts.includes(effortId)) return null
  const thinkingConfig = geminiThinkingConfig(modelId, effortId)
  if (thinkingConfig === null) return null

  const candidates = geminiSettingsCandidates()
  let selected: { readonly envName: string; readonly value: Record<string, unknown> } | null = null
  for (const candidate of candidates) {
    const settings = await readSettingsFile(candidate.path)
    if (settings.kind === 'invalid') continue
    // 已存在的管理员级 System Settings 必须保留最终决定权，此时降级写入低优先级 defaults。
    if (candidate.envName === 'GEMINI_CLI_SYSTEM_SETTINGS_PATH' && settings.kind === 'valid') continue
    selected = { envName: candidate.envName, value: settings.value }
    break
  }
  if (selected === null) return null

  const modelConfigs = isRecord(selected.value.modelConfigs) ? selected.value.modelConfigs : {}
  const customOverrides = Array.isArray(modelConfigs.customOverrides) ? modelConfigs.customOverrides : []
  const settings = {
    ...selected.value,
    modelConfigs: {
      ...modelConfigs,
      customOverrides: [
        ...customOverrides,
        ...geminiOverrideModels(modelId).map((model) => ({
          match: { model },
          modelConfig: { generateContentConfig: { thinkingConfig } },
        })),
      ],
    },
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-codingns-gemini-'))
  const settingsPath = join(directory, 'settings.json')
  try {
    await writeFile(settingsPath, `${JSON.stringify(settings)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    env: { [selected.envName]: settingsPath },
    dispose: async () => { await rm(directory, { recursive: true, force: true }) },
  }
}

function geminiThinkingConfig(modelId: string, effortId: string): Record<string, string | number> | null {
  if (modelId.toLowerCase().includes('2.5')) {
    const highBudget = modelId.toLowerCase().includes('pro') ? 32_768 : 24_576
    const budgets: Readonly<Record<string, number>> = { low: 1_024, medium: 8_192, high: highBudget }
    const thinkingBudget = budgets[effortId]
    return thinkingBudget === undefined ? null : { thinkingBudget }
  }
  return { thinkingLevel: effortId.toUpperCase() }
}

function geminiOverrideModels(modelId: string): readonly string[] {
  switch (modelId.toLowerCase()) {
    case 'auto':
    case 'auto-gemini-3':
      return ['gemini-3.1-pro-preview-customtools', 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3-flash-preview']
    case 'auto-gemini-2.5':
      return ['gemini-2.5-pro', 'gemini-2.5-flash']
    default:
      return [modelId]
  }
}

function geminiSettingsCandidates(): readonly { readonly envName: string; readonly path: string }[] {
  const systemDirectory = process.platform === 'darwin'
    ? '/Library/Application Support/GeminiCli'
    : process.platform === 'win32'
      ? join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'gemini-cli')
      : '/etc/gemini-cli'
  return [
    {
      envName: 'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
      path: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? join(systemDirectory, 'settings.json'),
    },
    {
      envName: 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
      path: process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ?? join(systemDirectory, 'system-defaults.json'),
    },
  ]
}

async function readSettingsFile(path: string): Promise<SettingsFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? { kind: 'valid', value: parsed } : { kind: 'invalid' }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { kind: 'missing', value: {} }
    return { kind: 'invalid' }
  }
}

function geminiAcpMessageToChunk(message: Record<string, any>): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const method = typeof message.method === 'string' ? message.method.toLowerCase() : ''
  const type = typeof update.sessionUpdate === 'string' ? update.sessionUpdate.toLowerCase() : typeof update.type === 'string' ? update.type.toLowerCase() : ''
  const text = acpText(update.delta ?? update.text ?? update.content ?? update.message)
  if (method.includes('permission') || type.includes('permission')) {
    const requestId = interactionRequestId(message)
    if (requestId) return { type: 'permission-request', requestId, kind: firstString(update, ['kind', 'permission']) ?? 'unknown', ...(text ? { detail: text } : {}) }
  }
  if (type.includes('thought') || type.includes('reason') || method.includes('reason')) return text ? { type: 'reasoning-delta', text } : null
  // ACP 可能回放用户消息；它不是模型正文。
  if (type.includes('user') && type.includes('message')) return null
  if (type.includes('agent_message') || type.includes('message') || type.includes('text') || method.includes('message')) return text ? { type: 'text-delta', text } : null
  if (type.includes('tool') || type.includes('command')) {
    const tool = isToolRecord(update.toolCall) ? update.toolCall : isToolRecord(update.tool_call) ? update.tool_call : update
    const name = firstToolText(tool.name, tool.toolName, tool.tool_name, tool.title, update.name, update.toolName, update.tool_name, update.title)
    const callId = firstToolText(tool.callId, tool.call_id, tool.toolCallId, tool.tool_call_id, tool.toolUseId, tool.tool_use_id, tool.id, update.toolCallId, update.tool_call_id, update.toolUseId, update.tool_use_id, update.id)
    if (name || callId) {
      const input = serializeToolValue(tool.rawInput ?? tool.input ?? tool.arguments ?? tool.args ?? tool.parameters ?? update.rawInput)
      const output = serializeToolValue(tool.rawOutput ?? tool.output ?? tool.result ?? update.rawOutput)
      const error = serializeToolValue(tool.error ?? update.error)
      const agentId = firstToolText(tool.agentId, tool.agent_id, update.agentId, update.agent_id)
      const detail = serializeToolValue(tool.detail ?? update.detail ?? update.content)
      const fallback = error !== undefined || type.includes('error') || type.includes('fail')
        ? 'failed'
        : output !== undefined || type.includes('result') || type.includes('complete')
          ? 'completed'
          : 'running'
      return {
        type: 'tool-event',
        toolName: name ?? 'tool',
        status: normalizeToolStatus(tool.status ?? tool.state ?? update.status, fallback),
        ...(callId ? { callId } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(output !== undefined ? { outputMode: type.includes('delta') ? 'delta' as const : 'snapshot' as const } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(agentId ? { agentId } : {}),
        ...(detail !== undefined ? { detail } : {}),
      }
    }
  }
  const usage = usageChunk(update)
  if (usage) return usage
  if (type.includes('turn_completed') || type.includes('turn_complete') || type.includes('completed') || type.includes('prompt_end') || type === 'done' || type === 'result') return { type: 'finish', reason: 'stop' }
  if (type.includes('error') || type.includes('failed')) return { type: 'finish', reason: 'error' }
  return null
}

function interactionRequestId(message: Record<string, any>): string | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const method = typeof message.method === 'string' ? message.method.toLowerCase() : ''
  const type = typeof update.sessionUpdate === 'string'
    ? update.sessionUpdate.toLowerCase()
    : typeof update.type === 'string'
      ? update.type.toLowerCase()
      : ''
  if (!method.includes('permission') && !type.includes('permission')) return null
  const value = update.requestId ?? update.request_id ?? update.id ?? message.id
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

function readSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.sessionId === 'string') return value.sessionId
  if (typeof value.session_id === 'string') return value.session_id
  if (isRecord(value.session) && typeof value.session.id === 'string') return value.session.id
  return typeof value.id === 'string' ? value.id : null
}
function firstString(value: Record<string, any>, keys: readonly string[]): string | null {
  for (const key of keys) if (typeof value[key] === 'string' && value[key].trim()) return value[key]
  return null
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

function geminiStreamResultChunks(value: Record<string, unknown>, cancelled: boolean): readonly CodingNsAgentEvent[] {
  const chunks: CodingNsAgentEvent[] = []
  const stats = isRecord(value.stats) ? value.stats : null
  if (stats !== null) {
    const usage = usageChunk(stats)
    if (usage) chunks.push(usage)
  }
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : ''
  const reason = cancelled ? 'cancel' : status === 'error' || status === 'failed' ? 'error' : 'stop'
  chunks.push({ type: 'finish', reason })
  return chunks
}

export { GeminiCliDriver as GeminiDriver }
