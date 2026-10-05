import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodingNsCliModel, CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'
import { CLAUDE_CATALOG, CLAUDE_EFFORT_LEVELS, enrichEfforts, fillProviderEfforts } from './model-catalog.js'
import { terminateChildProcess } from './process-utils.js'

const DEFAULT_TIMEOUT_MS = 8_000
const INITIALIZE_REQUEST_ID = 'codingns-model-discovery'
const DEFAULT_MODEL_ID = 'provider-default'
const ALIAS_ENV_KEYS = ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'] as const

export interface ClaudeModelDiscoveryOptions {
  readonly command: string
  readonly spawn?: typeof spawn
  readonly fetch?: typeof fetch
  readonly configDir?: string
  readonly workspaceDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
}

interface ClaudeSettings { readonly env?: Record<string, unknown> }
/** initialize 探测结果：模型清单，以及 CLI 明确回报不支持思考档位的模型 ID。 */
interface ClaudeInitializeDiscovery {
  readonly models: readonly CodingNsCliModel[]
  readonly noEffortIds: readonly string[]
}
interface ClaudeDiscoveryChild {
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): void }
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): void }
  readonly stdin: { end(data: string): void }
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
  kill(signal?: number | NodeJS.Signals): boolean
}

/** 从 Claude CLI、兼容网关和本地配置合并真实模型目录。凭据只用于请求。 */
export async function discoverClaudeModelCatalog(options: ClaudeModelDiscoveryOptions): Promise<CodingNsCliModelCatalog> {
  const configDir = options.configDir ?? options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const runtimeEnv = { ...process.env, ...(options.env ?? {}), ...readClaudeEnv(configDir, options.workspaceDir ?? process.cwd()) }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const gatewayUrl = resolveModelsUrl(runtimeEnv.ANTHROPIC_BASE_URL)
  const settled = await Promise.allSettled([
    readInitializeModels(options.command, runtimeEnv, options.spawn ?? spawn, timeoutMs),
    ...(gatewayUrl ? [readGatewayModels(gatewayUrl, runtimeEnv, options.fetch ?? fetch, timeoutMs)] : []),
  ])
  const initialize = settled[0].status === 'fulfilled' ? settled[0].value : undefined
  const gateway = gatewayUrl && settled[1]?.status === 'fulfilled' ? settled[1].value : undefined
  const discovered = [...(initialize?.models ?? []), ...(gateway ?? [])]
  const configured = configuredModels(runtimeEnv)
  const merged = mergeModels([...CLAUDE_CATALOG.groups[0]!.models, ...discovered, ...configured])
  const enriched = enrichEfforts({ groups: [{ id: 'claude', name: 'Claude', models: merged }], currentModel: null, currentEffort: null }, CLAUDE_CATALOG)
  // 中转站自定义命名的模型在官方目录里匹配不到 ID，但 `--effort` 是 CLI 的
  // 会话级参数，档位不随模型变化。优先复用 CLI initialize 明确回报过的档位，
  // 没有回报时才退回该 CLI 已验证的静态档位表，避免这些模型的强度切换在 UI
  // 上静默消失。CLI 明确回报不支持档位的模型必须排除在外。
  const confirmed = [...new Set((initialize?.models ?? []).flatMap((model) => model.efforts))]
  return fillProviderEfforts(enriched, confirmed.length > 0 ? confirmed : CLAUDE_EFFORT_LEVELS, new Set(initialize?.noEffortIds ?? []))
}

function readClaudeEnv(configDir: string, workspaceDir: string): Record<string, string> {
  const files = [join(configDir, 'settings.json'), join(configDir, 'settings.local.json'), join(workspaceDir, '.claude', 'settings.json'), join(workspaceDir, '.claude', 'settings.local.json')]
  return files.reduce<Record<string, string>>((result, file) => {
    if (!existsSync(file)) return result
    try {
      const env = (JSON.parse(readFileSync(file, 'utf8')) as ClaudeSettings).env
      if (!env || typeof env !== 'object') return result
      for (const [key, value] of Object.entries(env)) if (typeof value === 'string' && value.trim()) result[key] = value.trim()
    } catch { /* 损坏的配置不应阻塞模型发现。 */ }
    return result
  }, {})
}

function configuredModels(env: Record<string, string | undefined>): CodingNsCliModel[] {
  const ids = [env.ANTHROPIC_MODEL, ...ALIAS_ENV_KEYS.map((key) => env[key])].filter((id): id is string => Boolean(id?.trim())).map((id) => id.trim())
  return ids.map((id) => ({ id, name: id, efforts: [] }))
}

function mergeModels(models: readonly CodingNsCliModel[]): CodingNsCliModel[] {
  const result: CodingNsCliModel[] = []
  const seen = new Set<string>()
  for (const model of models) {
    if (!model.id || seen.has(model.id)) continue
    seen.add(model.id)
    result.push(model)
  }
  return result
}

async function readInitializeModels(command: string, env: Record<string, string | undefined>, runSpawn: typeof spawn, timeoutMs: number): Promise<ClaudeInitializeDiscovery> {
  const child = runSpawn(command, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' }) as unknown as ClaudeDiscoveryChild
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); callback() }
    const timer = setTimeout(() => { terminateChildProcess(child); finish(() => reject(new Error('CLAUDE_MODEL_DISCOVERY_TIMEOUT'))) }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk).slice(0, 1024 * 1024 - stdout.length) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 16_384 - stderr.length) })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => {
      if (code !== 0) return reject(new Error(stderr.trim() || `CLAUDE_MODEL_DISCOVERY_FAILED:${code ?? 'unknown'}`))
      try { resolve(parseInitialize(stdout)) } catch (error) { reject(error) }
    }))
    child.stdin.end(`${JSON.stringify({ type: 'control_request', request_id: INITIALIZE_REQUEST_ID, request: { subtype: 'initialize' } })}\n`)
  })
}

function parseInitialize(output: string): ClaudeInitializeDiscovery {
  const models: CodingNsCliModel[] = []
  const noEffortIds: string[] = []
  for (const line of output.split(/\r?\n/u)) {
    try {
      const message = JSON.parse(line) as { type?: unknown; response?: { subtype?: unknown; request_id?: unknown; response?: { models?: unknown } } }
      const raw = message.response?.response?.models
      if (message.type !== 'control_response' || message.response?.subtype !== 'success' || message.response.request_id !== INITIALIZE_REQUEST_ID || !Array.isArray(raw)) continue
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const value = (item as { value?: unknown }).value
        if (typeof value !== 'string' || !value.trim()) continue
        const id = value.trim() === 'default' ? DEFAULT_MODEL_ID : value.trim()
        const displayName = (item as { displayName?: unknown }).displayName
        const efforts = (item as { supportedEffortLevels?: unknown }).supportedEffortLevels
        const levels = Array.isArray(efforts) ? efforts.filter((level): level is string => typeof level === 'string') : []
        // CLI 明确回报不支持思考档位时，该模型必须保持空档位，不能被 Provider 级兜底覆盖。
        if (levels.length === 0 && (item as { supportsEffort?: unknown }).supportsEffort === false) noEffortIds.push(id)
        models.push({ id, name: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : value.trim(), efforts: levels })
      }
    } catch { /* 忽略 CLI 输出中的非 JSON 行。 */ }
  }
  if (models.length === 0) throw new Error('CLAUDE_MODELS_RESPONSE_EMPTY')
  return { models: mergeModels(models), noEffortIds }
}

async function readGatewayModels(url: string, env: Record<string, string | undefined>, request: typeof fetch, timeoutMs: number): Promise<readonly CodingNsCliModel[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const authToken = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY
    const headers: Record<string, string> = { accept: 'application/json', 'anthropic-version': '2023-06-01' }
    if (env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`
    if (authToken) headers['x-api-key'] = authToken
    const response = await request(url, { headers, signal: controller.signal })
    if (!response.ok) throw new Error(`CLAUDE_MODEL_CATALOG_HTTP_${response.status}`)
    const body = await response.json() as { data?: unknown; models?: unknown }
    const raw = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
    const models = raw.flatMap((item): CodingNsCliModel[] => {
      if (!item || typeof item !== 'object') return []
      const object = item as { id?: unknown; value?: unknown; name?: unknown; display_name?: unknown }
      const value = object.id ?? object.value
      if (typeof value !== 'string' || !value.trim()) return []
      const name = object.display_name ?? object.name
      return [{ id: value.trim(), name: typeof name === 'string' && name.trim() ? name.trim() : value.trim(), efforts: [] }]
    })
    if (models.length === 0) throw new Error('CLAUDE_MODEL_CATALOG_RESPONSE_EMPTY')
    return mergeModels(models)
  } finally { clearTimeout(timer) }
}

function resolveModelsUrl(baseUrl: string | undefined): string | null {
  if (!baseUrl?.trim()) return null
  try {
    const url = new URL(baseUrl.trim())
    const pathname = url.pathname.replace(/\/+$/u, '')
    if (/\/v1\/models$/iu.test(pathname)) return url.toString()
    url.pathname = /\/v1$/iu.test(pathname) ? `${pathname}/models` : `${pathname}/v1/models`
    return url.toString()
  } catch { return null }
}
