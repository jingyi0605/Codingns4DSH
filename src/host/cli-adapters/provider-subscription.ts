import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { CliSubscriptionUsage, CliSubscriptionWindow, Sub2ApiDailyUsage, Sub2ApiModelUsage, Sub2ApiUsage, Sub2ApiUsagePoint } from '../../shared/contracts/subscription.js'
import { JsonRpcProcess } from './json-rpc-process.js'
import { detectBinary } from './rpc-driver-utils.js'

type FetchLike = typeof fetch

/** 统一读取 Codex、Claude Code、OpenCode 订阅摘要。所有原始凭据都留在 Host。 */
export class ProviderSubscriptionService {
  readonly commandCode: SubscriptionReader | undefined
  readonly codex: CodexSubscriptionService
  readonly claudeCode: ClaudeCodeSubscriptionService
  readonly opencode: OpenCodeSubscriptionService
  readonly sub2api: Sub2ApiUsageService

  constructor(options: ProviderSubscriptionOptions = {}) {
    this.commandCode = options.commandCode
    this.codex = new CodexSubscriptionService(options.codex)
    this.claudeCode = new ClaudeCodeSubscriptionService(options.claudeCode)
    this.opencode = new OpenCodeSubscriptionService(options.opencode)
    this.sub2api = new Sub2ApiUsageService(options.sub2api)
  }

  read(adapterId: string): Promise<CliSubscriptionUsage | null> {
    if (adapterId === 'codex' || adapterId === 'claude-code' || adapterId === 'dsh' || adapterId === 'grok' || adapterId === 'opencode') {
      return this.readSub2ApiFirst(adapterId)
    }
    switch (adapterId) {
      case 'command-code': return this.commandCode?.read() ?? Promise.resolve(null)
      case 'codex': return this.codex.read()
      case 'claude-code': return this.claudeCode.read()
      case 'opencode': return this.opencode.read()
      default: return Promise.resolve(null)
    }
  }

  private async readSub2ApiFirst(adapterId: string): Promise<CliSubscriptionUsage | null> {
    // 已配置第三方上游时，官方额度接口没有意义；即使 Sub2API 探测失败也必须隐藏，
    // 不能把旧的官方订阅窗口误显示成当前上游的用量。
    const hasThirdPartySource = this.sub2api.hasSource(adapterId)
    const upstream = await this.sub2api.read(adapterId)
    if (upstream !== null) return upstream
    if (hasThirdPartySource) return null
    if (adapterId === 'codex') return this.codex.read()
    if (adapterId === 'claude-code') return this.claudeCode.read()
    return null
  }
}

export interface ProviderSubscriptionOptions {
  readonly commandCode?: SubscriptionReader
  readonly codex?: CodexSubscriptionOptions
  readonly claudeCode?: ClaudeCodeSubscriptionOptions
  readonly opencode?: OpenCodeSubscriptionOptions
  readonly sub2api?: Sub2ApiUsageOptions
}

export interface SubscriptionReader { read(): Promise<CliSubscriptionUsage | null> }

export interface Sub2ApiSource { readonly baseUrl: string; readonly apiKey: string }
export interface Sub2ApiUsageOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly sources?: Partial<Record<'codex' | 'claude-code' | 'dsh' | 'grok' | 'opencode', Sub2ApiSource | readonly Sub2ApiSource[]>>
}

/** 通过 Provider 的上游 base URL 检测 Sub2API；只返回脱敏后的统计摘要。 */
export class Sub2ApiUsageService {
  private readonly request: FetchLike
  private readonly timeoutMs: number
  private readonly configuredSources: Sub2ApiUsageOptions['sources']

  constructor(options: Sub2ApiUsageOptions = {}) {
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.configuredSources = options.sources
  }

  hasSource(adapterId: string): boolean {
    const configured = this.configuredSources?.[adapterId as keyof NonNullable<Sub2ApiUsageOptions['sources']>]
    if (configured !== undefined) return Array.isArray(configured) ? configured.length > 0 : true
    return resolveSub2ApiSources(adapterId).length > 0
  }

  async read(adapterId: string): Promise<CliSubscriptionUsage | null> {
    const configured = this.configuredSources?.[adapterId as keyof NonNullable<Sub2ApiUsageOptions['sources']>]
    const sources = configured === undefined ? resolveSub2ApiSources(adapterId) : Array.isArray(configured) ? configured : [configured]
    for (const source of sources) {
      const result = await this.readSource(source)
      if (result !== null) return result
    }
    return null
  }

  private async readSource(source: Sub2ApiSource): Promise<CliSubscriptionUsage | null> {
    const baseUrl = source.baseUrl.trim().replace(/\/+$/u, '')
    const usagePath = /\/v1$/u.test(baseUrl) ? '/usage' : '/v1/usage'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request(`${baseUrl}${usagePath}`, {
        headers: { Authorization: source.apiKey.trim().startsWith('Bearer ') ? source.apiKey.trim() : `Bearer ${source.apiKey.trim()}`, Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) return null
      const usage = normalizeSub2ApiUsage(await response.json(), baseUrl)
      if (usage === null) return null
      return { authenticated: true, planType: usage.planName, primary: null, secondary: null, monthly: null, rateLimitReachedType: null, resetCredits: null, capturedAt: new Date().toISOString(), sub2api: { ...usage, logoUrl: buildLogoUrl(baseUrl) } }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface CodexSubscriptionOptions {
  readonly homeDirectory?: string
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
  readonly timeoutMs?: number
}

export class CodexSubscriptionService implements SubscriptionReader {
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly timeoutMs: number
  private readonly homeDirectory: string
  private command: string | null = null

  constructor(options: CodexSubscriptionOptions = {}) {
    this.binaries = options.binaries ?? ['codex']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.homeDirectory = options.homeDirectory ?? (process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  }

  async read(): Promise<CliSubscriptionUsage | null> {
    if (hasThirdPartyCodexConfig(this.homeDirectory)) return null
    try {
      this.command ??= (await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })).command
      if (this.command === null) return null
      const rpc = new JsonRpcProcess({ command: this.command, args: ['app-server'], spawn: this.runSpawn })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        await rpc.request('initialize', { clientInfo: { name: 'dsh-codingns', version: '0.1.0' }, capabilities: {} }, { signal: controller.signal })
        rpc.notify('initialized', {})
        const result = await rpc.request('account/rateLimits/read', {}, { signal: controller.signal })
        return normalizeCodexSnapshot(result)
      } finally {
        clearTimeout(timer)
        rpc.dispose()
      }
    } catch {
      return null
    }
  }
}

export interface ClaudeCodeSubscriptionOptions {
  readonly homeDirectory?: string
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
}

export class ClaudeCodeSubscriptionService implements SubscriptionReader {
  private readonly homeDirectory: string
  private readonly request: FetchLike
  private readonly timeoutMs: number

  constructor(options: ClaudeCodeSubscriptionOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? join(homedir(), '.claude')
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
  }

  async read(): Promise<CliSubscriptionUsage | null> {
    const auth = readJson(join(this.homeDirectory, '.credentials.json'))
    const oauth = recordValue(auth)?.claudeAiOauth
    const token = textValue(recordValue(oauth)?.accessToken)
    if (token === null) return null
    if (hasThirdPartyClaudeConfig(this.homeDirectory)) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: controller.signal,
      })
      if (!response.ok) return null
      const snapshot = normalizeClaudeSnapshot(await response.json(), textValue(recordValue(oauth)?.subscriptionType))
      return hasSubscriptionWindow(snapshot) ? snapshot : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface OpenCodeSubscriptionOptions { readonly homeDirectory?: string }

export class OpenCodeSubscriptionService implements SubscriptionReader {
  private readonly homeDirectory: string
  constructor(options: OpenCodeSubscriptionOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? defaultOpenCodeDataDirectory()
  }

  async read(): Promise<CliSubscriptionUsage | null> {
    const candidates = [
      join(this.homeDirectory, 'auth.json'),
      join(homedir(), '.config', 'opencode', 'auth.json'),
      join(homedir(), 'Library', 'Application Support', 'opencode', 'auth.json'),
      ...(process.platform === 'win32' && process.env.APPDATA
        ? [join(process.env.APPDATA, 'opencode', 'auth.json')]
        : []),
    ]
    const auth = candidates.map(readJson).find((value) => value !== null)
    if (auth === null || auth === undefined || Object.keys(auth).length === 0) return null
    // OpenCode 支持多个第三方 Provider，目前没有稳定的统一额度协议；只报告认证状态。
    const snapshot = normalizeOpenCodeSnapshot(auth)
    if (snapshot !== null) return snapshot
    const provider = Object.keys(auth).find((key) => key.trim() !== '') ?? null
    return null
  }
}

function normalizeCodexSnapshot(value: unknown): CliSubscriptionUsage | null {
  const root = recordValue(value)
  const source = recordValue(root?.rateLimits ?? root?.rate_limits) ?? root
  if (source === null) return null
  const primary = normalizeRateWindow(source.primary)
  const secondary = normalizeRateWindow(source.secondary)
  if (primary === null && secondary === null) return null
  return {
    authenticated: true,
    planType: textValue(source.planType ?? source.plan_type),
    primary,
    secondary,
    monthly: null,
    rateLimitReachedType: textValue(source.rateLimitReachedType ?? source.rate_limit_reached_type),
    resetCredits: null,
    capturedAt: new Date().toISOString(),
  }
}

function normalizeClaudeSnapshot(value: unknown, planType: string | null): CliSubscriptionUsage {
  const root = recordValue(value) ?? {}
  const source = recordValue(root.data) ?? root
  return {
    authenticated: true,
    planType,
    primary: normalizeUsageWindow(source.five_hour ?? source.fiveHour),
    secondary: normalizeUsageWindow(source.seven_day ?? source.sevenDay),
    monthly: normalizeUsageWindow(source.seven_day_opus ?? source.sevenDayOpus),
    rateLimitReachedType: null,
    resetCredits: null,
    capturedAt: new Date().toISOString(),
  }
}

function normalizeRateWindow(value: unknown): CliSubscriptionWindow | null {
  const source = recordValue(value)
  if (source === null) return null
  const usedPercent = numberValue(source.usedPercent ?? source.used_percent)
  if (usedPercent === null) return null
  return {
    usedPercent: clamp(usedPercent),
    remainingPercent: 100 - clamp(usedPercent),
    windowDurationMins: integerValue(source.windowDurationMins ?? source.window_duration_mins),
    resetsAt: timestampValue(source.resetsAt ?? source.resets_at),
  }
}

function normalizeUsageWindow(value: unknown): CliSubscriptionWindow | null {
  const source = recordValue(value)
  if (source === null) return null
  const utilization = numberValue(source.utilization ?? source.usedPercent ?? source.used_percent)
  if (utilization === null) return null
  const usedPercent = clamp(utilization)
  return { usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: null, resetsAt: timestampValue(source.resets_at ?? source.resetsAt) }
}

function normalizeOpenCodeSnapshot(value: Record<string, unknown>): CliSubscriptionUsage | null {
  const source = recordValue(value.rateLimits ?? value.rate_limits ?? value.usage ?? value.subscription)
  if (source === null) return null
  const primary = normalizeUsageWindow(source.five_hour ?? source.fiveHour ?? source.primary)
  const secondary = normalizeUsageWindow(source.seven_day ?? source.sevenDay ?? source.secondary)
  const monthly = normalizeUsageWindow(source.monthly)
  if (primary === null && secondary === null && monthly === null) return null
  return { authenticated: true, planType: textValue(source.planType ?? source.plan), primary, secondary, monthly, rateLimitReachedType: null, resetCredits: null, capturedAt: new Date().toISOString() }
}

function hasSubscriptionWindow(value: CliSubscriptionUsage | null): value is CliSubscriptionUsage {
  return value !== null && (value.primary !== null || value.secondary !== null || value.monthly !== null)
}

function hasThirdPartyCodexConfig(homeDirectory: string): boolean {
  if (textValue(process.env.OPENAI_API_KEY) !== null) return true
  const config = readText(join(homeDirectory, 'config.toml'))
  if (config === null) return false
  const baseUrls = [...config.matchAll(/^\s*base_url\s*=\s*["']([^"']+)["']/gmu)].map((match) => match[1] ?? '')
  return baseUrls.some((value) => !isOfficialOpenAiUrl(value))
}

function hasThirdPartyClaudeConfig(homeDirectory: string): boolean {
  const baseUrl = textValue(process.env.ANTHROPIC_BASE_URL)
  if (baseUrl !== null && !isOfficialAnthropicUrl(baseUrl)) return true
  if (textValue(process.env.ANTHROPIC_API_KEY) !== null || textValue(process.env.ANTHROPIC_AUTH_TOKEN) !== null) return true
  const settings = readJson(join(homeDirectory, 'settings.json'))
  const env = recordValue(settings)?.env
  const configuredBaseUrl = textValue(recordValue(env)?.ANTHROPIC_BASE_URL)
  if (configuredBaseUrl !== null && !isOfficialAnthropicUrl(configuredBaseUrl)) return true
  return textValue(recordValue(env)?.ANTHROPIC_API_KEY) !== null || textValue(recordValue(env)?.ANTHROPIC_AUTH_TOKEN) !== null
}

function isOfficialOpenAiUrl(value: string): boolean {
  try { return new URL(value).hostname === 'api.openai.com' }
  catch { return false }
}
function isOfficialAnthropicUrl(value: string): boolean {
  try { return new URL(value).hostname === 'api.anthropic.com' }
  catch { return false }
}
function readText(path: string): string | null {
  if (!existsSync(path)) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try { return recordValue(JSON.parse(readFileSync(path, 'utf8'))) } catch { return null }
}
function recordValue(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function textValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function numberValue(value: unknown): number | null { const result = typeof value === 'number' ? value : Number(value); return Number.isFinite(result) ? result : null }
function integerValue(value: unknown): number | null { const result = numberValue(value); return result === null ? null : Math.round(result) }
function timestampValue(value: unknown): number | null {
  const numeric = numberValue(value)
  if (numeric !== null) return numeric > 10_000_000_000 ? Math.round(numeric / 1000) : Math.round(numeric)
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null }
  return null
}
function clamp(value: number): number { return Math.max(0, Math.min(100, value)) }

function resolveSub2ApiSources(adapterId: string): Sub2ApiSource[] {
  const sources: Sub2ApiSource[] = []
  const add = (source: Sub2ApiSource | null): void => {
    if (source === null || source.baseUrl.trim() === '' || source.apiKey.trim() === '') return
    if (!sources.some((item) => item.baseUrl === source.baseUrl && item.apiKey === source.apiKey)) sources.push(source)
  }
  if (adapterId === 'codex') {
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
    const config = readText(join(home, 'config.toml')) ?? ''
    const baseUrl = config.match(/^\s*base_url\s*=\s*["']([^"']+)["']/mu)?.[1]
    const key = textValue(readJsonValue(join(home, 'auth.json'), 'OPENAI_API_KEY'))
    add(baseUrl === undefined || key === null ? null : { baseUrl, apiKey: key })
  }
  if (adapterId === 'claude-code') {
    const home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    const settings = readJson(join(home, 'settings.json'))
    const env = recordValue(settings)?.env
    add({
      baseUrl: textValue(process.env.ANTHROPIC_BASE_URL) ?? textValue(recordValue(env)?.ANTHROPIC_BASE_URL) ?? '',
      apiKey: textValue(process.env.ANTHROPIC_AUTH_TOKEN) ?? textValue(process.env.ANTHROPIC_API_KEY) ?? textValue(recordValue(env)?.ANTHROPIC_AUTH_TOKEN) ?? textValue(recordValue(env)?.ANTHROPIC_API_KEY) ?? '',
    })
  }
  if (adapterId === 'opencode') {
    const configCandidates = [
      join(homedir(), '.config', 'opencode', 'opencode.json'),
      ...(process.platform === 'win32' && process.env.APPDATA
        ? [join(process.env.APPDATA, 'opencode', 'opencode.json')]
        : []),
    ]
    const config = configCandidates.map(readJson).find((value) => value !== null) ?? null
    add(findConfigSource(config))
  }
  if (adapterId === 'dsh') {
    add(envSource('DSH_BASE_URL', 'DSH_API_KEY'))
    add(envSource('DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY'))
    add(envSource('OPENAI_BASE_URL', 'OPENAI_API_KEY'))
    add(findConfigSource(readJson(join(homedir(), '.dsh', 'config.json'))))
  }
  if (adapterId === 'grok') {
    add(envSource('GROK_BASE_URL', 'GROK_API_KEY'))
    add(envSource('XAI_BASE_URL', 'XAI_API_KEY'))
    add(envSource('XAI_API_BASE_URL', 'XAI_API_KEY'))
    add(findConfigSource(readJson(join(homedir(), '.grok', 'config.json'))))
  }
  return sources
}

function defaultOpenCodeDataDirectory(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'opencode')
  return join(homedir(), '.local', 'share', 'opencode')
}

function envSource(baseName: string, keyName: string): Sub2ApiSource | null {
  const baseUrl = textValue(process.env[baseName])
  const apiKey = textValue(process.env[keyName])
  return baseUrl === null || apiKey === null ? null : { baseUrl, apiKey }
}

function findConfigSource(value: unknown, depth = 0): Sub2ApiSource | null {
  if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const baseUrl = textValue(record.baseURL ?? record.baseUrl ?? record.base_url)
  const apiKey = textValue(record.apiKey ?? record.api_key ?? record.key)
  if (baseUrl !== null && apiKey !== null) return { baseUrl, apiKey }
  for (const child of Object.values(record)) {
    const source = findConfigSource(child, depth + 1)
    if (source !== null) return source
  }
  return null
}

function normalizeSub2ApiUsage(value: unknown, baseUrl: string): Sub2ApiUsage | null {
  const root = recordValue(value)
  if (root === null) return null
  const usage = recordValue(root.usage) ?? {}
  const daily = Array.isArray(root.daily_usage) ? root.daily_usage.flatMap((item) => normalizeDailyPoint(item)) : []
  const latestDaily = daily.at(-1)
  const today = normalizePoint(usage.today) ?? latestDaily
  const total = normalizePoint(usage.total)
  const balance = numberValue(root.balance) ?? numberValue(root.remaining)
  if (balance === null || today === undefined || today === null || total === undefined || total === null) return null
  const models = Array.isArray(root.model_stats) ? root.model_stats.flatMap((item) => normalizeModelPoint(item)) : []
  return {
    upstreamType: detectUpstreamType(root, baseUrl),
    upstreamUrl: sanitizeUpstreamUrl(baseUrl),
    logoUrl: '',
    balance,
    remaining: numberValue(root.remaining) ?? balance,
    unit: textValue(root.unit) ?? 'USD',
    planName: textValue(root.planName ?? root.plan_name),
    mode: textValue(root.mode),
    today,
    total,
    daily,
    models,
    rpm: numberValue(usage.rpm),
    tpm: numberValue(usage.tpm),
    averageDurationMs: numberValue(usage.average_duration_ms),
  }
}

function detectUpstreamType(root: Record<string, any>, baseUrl: string): 'Sub2API' | 'OneAPI' | '其他' {
  const provider = `${textValue(root.provider) ?? ''} ${textValue(root.source) ?? ''} ${textValue(root.platform) ?? ''}`.toLowerCase()
  if (provider.includes('one-api') || provider.includes('oneapi')) return 'OneAPI'
  if (provider.includes('sub2api') || Array.isArray(root.daily_usage) || Array.isArray(root.model_stats)) return 'Sub2API'
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (hostname.includes('oneapi')) return 'OneAPI'
    if (hostname.includes('sub2api')) return 'Sub2API'
  } catch {
    // 非标准地址仍然可以展示统计，只标记为其他上游。
  }
  return '其他'
}

function sanitizeUpstreamUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return ''
  }
}

function buildLogoUrl(baseUrl: string): string {
  try { return new URL('/logo.svg', baseUrl).toString() } catch { return '' }
}

function normalizePoint(value: unknown): Sub2ApiUsagePoint | null {
  const source = recordValue(value)
  if (source === null) return null
  const inputTokens = nonNegative(source.input_tokens)
  const outputTokens = nonNegative(source.output_tokens)
  const cacheCreationTokens = nonNegative(source.cache_creation_tokens ?? source.cache_write_tokens)
  const cacheReadTokens = nonNegative(source.cache_read_tokens)
  const totalTokens = nonNegative(source.total_tokens) || inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
  const requests = nonNegative(source.requests)
  const cost = numberValue(source.cost) ?? numberValue(source.actual_cost) ?? 0
  const actualCost = numberValue(source.actual_cost) ?? cost
  return { requests, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, cost, actualCost, cacheHitRate: calculateCacheHitRate(inputTokens, cacheReadTokens) }
}

function normalizeDailyPoint(value: unknown): Sub2ApiDailyUsage[] {
  const source = recordValue(value)
  const point = normalizePoint(source)
  const date = textValue(source?.date)
  return point === null || date === null ? [] : [{ date, ...point }]
}

function normalizeModelPoint(value: unknown): Sub2ApiModelUsage[] {
  const source = recordValue(value)
  const point = normalizePoint(source)
  const model = textValue(source?.model)
  return point === null || model === null ? [] : [{ model, accountCost: numberValue(source?.account_cost) ?? point.actualCost, ...point }]
}

function calculateCacheHitRate(inputTokens: number, cacheReadTokens: number): number {
  const denominator = inputTokens + cacheReadTokens
  return denominator === 0 ? 0 : Number((cacheReadTokens / denominator * 100).toFixed(4))
}

function nonNegative(value: unknown): number {
  const result = numberValue(value)
  return result === null ? 0 : Math.max(0, result)
}

function readJsonValue(path: string, key: string): unknown {
  return readJson(path)?.[key]
}
