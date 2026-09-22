import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodingNsCliModelCatalog, CodingNsCliStreamChunk, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import { StandardStreamDriver, emptyCatalog, type StandardStreamDriverOptions } from './standard-stream-driver.js'
import { JsonRpcProcess } from './json-rpc-process.js'
import { isRecord, streamRpcRequest, textValue, usageChunk } from './rpc-driver-utils.js'
import { GEMINI_CATALOG, isProviderDefaultModel, resolveGeminiEfforts } from './model-catalog.js'

/** Gemini 官方 ACP 优先；不支持 ACP 的旧 CLI 自动回退 headless stream-json。 */
export class GeminiCliDriver extends StandardStreamDriver {
  constructor(options: StandardStreamDriverOptions = {}) {
    super({ id: 'gemini', name: 'Gemini CLI', protocol: 'acp', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission'] }, { binaries: ['gemini'] }, options)
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
      rpc.dispose()
    }
  }

  protected buildArgs(input: CodingNsCliTurnInput): readonly string[] {
    const args = ['-p', input.prompt, '--output-format', 'stream-json', '--yolo']
    if (input.providerSessionId) args.push('--resume', input.providerSessionId)
    if (input.modelId && !isProviderDefaultModel(input.modelId)) args.push('--model', input.modelId)
    return args
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk> {
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

  private async *executeAcpTurn(input: CodingNsCliTurnInput): AsyncGenerator<CodingNsCliStreamChunk> {
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
      for await (const message of streamRpcRequest(rpc, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      }, input.signal)) {
        const chunk = geminiAcpMessageToChunk(message)
        if (chunk?.type === 'finish') finished = true
        if (chunk !== null) yield chunk
      }
      if (input.signal?.aborted) {
        if (!finished) yield { type: 'finish', reason: 'cancel' }
      } else if (!finished) yield { type: 'finish', reason: 'stop' }
    } finally {
      rpc.dispose()
      await runtimeSettings?.dispose()
    }
  }
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

function geminiAcpMessageToChunk(message: Record<string, any>): CodingNsCliStreamChunk | null {
  const params = isRecord(message.params) ? message.params : message
  const update = isRecord(params.update) ? params.update : params
  const method = typeof message.method === 'string' ? message.method.toLowerCase() : ''
  const type = typeof update.sessionUpdate === 'string' ? update.sessionUpdate.toLowerCase() : typeof update.type === 'string' ? update.type.toLowerCase() : ''
  const text = acpText(update.delta ?? update.text ?? update.content ?? update.message)
  if (method.includes('permission') || type.includes('permission')) {
    const requestId = firstString(update, ['requestId', 'request_id', 'id'])
    if (requestId) return { type: 'permission-request', requestId, kind: firstString(update, ['kind', 'permission']) ?? 'unknown', ...(text ? { detail: text } : {}) }
  }
  if (type.includes('thought') || type.includes('reason') || method.includes('reason')) return text ? { type: 'reasoning-delta', text } : null
  if (type.includes('agent_message') || type.includes('message') || type.includes('text') || method.includes('message')) return text ? { type: 'text-delta', text } : null
  if (type.includes('tool') || type.includes('command')) {
    const name = firstString(update, ['name', 'toolName', 'tool_name'])
    if (name) return { type: 'tool-running', toolName: name }
  }
  const usage = usageChunk(update)
  if (usage) return usage
  if (type.includes('turn_completed') || type.includes('turn_complete') || type.includes('completed') || type.includes('prompt_end') || type === 'done' || type === 'result') return { type: 'finish', reason: 'stop' }
  if (type.includes('error') || type.includes('failed')) return { type: 'finish', reason: 'error' }
  return null
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

export { GeminiCliDriver as GeminiDriver }
