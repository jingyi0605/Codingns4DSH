import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { CliSubscriptionProvider, CliSubscriptionUsage, CliSubscriptionWindow, DeepseekBalance, DeepseekUsage, Sub2ApiDailyUsage, Sub2ApiModelUsage, Sub2ApiUsage, Sub2ApiUsagePoint } from '../../shared/contracts/subscription.js'
import { identifyModelProvider, normalizeProviderBaseUrl, thirdPartyProvider, type ProviderDefinition } from './provider-registry.js'
import { OfficialProviderSubscriptionService, type OfficialProviderSubscriptionOptions } from './official-provider-subscription.js'
import { ZcodeSubscriptionService, type ZcodeSubscriptionOptions } from './zcode-subscription.js'
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
  readonly deepseek: DeepseekSubscriptionService
  readonly official: OfficialProviderSubscriptionService
  readonly kimi: KimiSubscriptionService
  readonly grok: GrokSubscriptionService
  readonly zcode: ZcodeSubscriptionService

  constructor(options: ProviderSubscriptionOptions = {}) {
    // 全局超时只作为缺省值；单项服务显式给出的 timeoutMs 优先。
    const shared = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
    this.commandCode = options.commandCode
    this.codex = new CodexSubscriptionService({ ...shared, ...options.codex })
    this.claudeCode = new ClaudeCodeSubscriptionService({ ...shared, ...options.claudeCode })
    this.opencode = new OpenCodeSubscriptionService(options.opencode)
    this.sub2api = new Sub2ApiUsageService({ ...shared, ...options.sub2api })
    this.deepseek = new DeepseekSubscriptionService({ ...shared, ...options.deepseek })
    this.official = new OfficialProviderSubscriptionService({ ...shared, ...options.official })
    this.kimi = new KimiSubscriptionService({ ...shared, ...options.kimi })
    this.grok = new GrokSubscriptionService({ ...shared, ...options.grok })
    this.zcode = new ZcodeSubscriptionService({ ...shared, ...options.zcode })
  }

  read(adapterId: string, providerId?: string): Promise<CliSubscriptionUsage | null> {
    if (adapterId === 'dsh') return this.readDsh(providerId)
    if (adapterId === 'codex' || adapterId === 'claude-code' || adapterId === 'grok' || adapterId === 'opencode') {
      return this.readSub2ApiFirst(adapterId)
    }
    switch (adapterId) {
      case 'command-code': return this.commandCode?.read() ?? Promise.resolve(null)
      case 'codex': return this.codex.read()
      case 'claude-code': return this.claudeCode.read()
      case 'opencode': return this.opencode.read()
      case 'kimi': return this.kimi.read().then((usage) => usage === null ? null : withProvider(usage, identifyModelProvider({ name: 'kimi-coding' }), ''))
      case 'zcode': return this.zcode.read()
      default: return Promise.resolve(null)
    }
  }

  private async readDsh(providerId?: string): Promise<CliSubscriptionUsage | null> {
    const currentProviderId = providerId ?? resolveDshDefaultProvider()
    const configuredSource = resolveDshProviderSource(currentProviderId)
    const matchedProvider = identifyModelProvider({ name: currentProviderId, baseUrl: configuredSource?.baseUrl })
    if (matchedProvider?.reader === 'openrouter-balance' || matchedProvider?.reader === 'minimax-usage' || matchedProvider?.reader === 'zai-usage' || matchedProvider?.reader === 'github-copilot-usage') {
      return this.official.read(currentProviderId, configuredSource)
    }
    if (matchedProvider?.reader === 'deepseek-balance' && isOfficialDeepseekSource(currentProviderId, configuredSource)) return this.deepseek.read(configuredSource ?? undefined)
    if (matchedProvider?.reader === 'sub2api') return this.sub2api.read('dsh', currentProviderId)
    // 已识别的官方提供商但没有可用读取器时，不尝试把官方 API 当成 Sub2API。
    if (matchedProvider !== undefined && configuredSource !== null) return null
    if (isThirdPartyDeepseekProvider(currentProviderId)) return this.sub2api.read('dsh', currentProviderId)
    // 明确配置了第三方来源时，始终沿用 sub2api 适配器，避免把失败的上游误判为官方余额。
    const hasThirdPartySource = this.sub2api.hasSource('dsh')
    if (hasThirdPartySource) return this.sub2api.read('dsh')
    const official = await this.deepseek.read()
    return official === null || matchedProvider === undefined ? official : withProvider(official, matchedProvider, configuredSource?.baseUrl)
  }

  private async readSub2ApiFirst(adapterId: string): Promise<CliSubscriptionUsage | null> {
    // 已配置第三方上游时，官方额度接口没有意义；即使 Sub2API 探测失败也必须隐藏，
    // 不能把旧的官方订阅窗口误显示成当前上游的用量。
    const hasThirdPartySource = this.sub2api.hasThirdPartySource(adapterId)
    if (hasThirdPartySource) return this.sub2api.read(adapterId)
    if (adapterId === 'codex') return this.codex.read().then((usage) => usage === null ? null : withProvider(usage, identifyModelProvider({ name: 'openai-codex' }), ''))
    if (adapterId === 'claude-code') return this.claudeCode.read().then((usage) => usage === null ? null : withProvider(usage, identifyModelProvider({ name: 'anthropic' }), ''))
    if (adapterId === 'grok') return this.grok.read().then((usage) => usage === null ? null : withProvider(usage, identifyModelProvider({ name: 'xai' }), ''))
    return null
  }
}

export interface ProviderSubscriptionOptions {
  readonly commandCode?: SubscriptionReader
  readonly codex?: CodexSubscriptionOptions
  readonly claudeCode?: ClaudeCodeSubscriptionOptions
  readonly opencode?: OpenCodeSubscriptionOptions
  readonly sub2api?: Sub2ApiUsageOptions
  readonly deepseek?: DeepseekSubscriptionOptions
  readonly official?: OfficialProviderSubscriptionOptions
  readonly kimi?: KimiSubscriptionOptions
  readonly grok?: GrokSubscriptionOptions
  readonly zcode?: ZcodeSubscriptionOptions
  /** 所有读取器共用的网络超时（毫秒）；单项服务显式给出时优先。 */
  readonly timeoutMs?: number
}

export interface SubscriptionReader { read(): Promise<CliSubscriptionUsage | null> }

export interface Sub2ApiSource { readonly baseUrl: string; readonly apiKey: string }

export interface DeepseekSubscriptionOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly sources?: readonly Sub2ApiSource[]
}

/** 读取官方 DeepSeek API 的余额；凭据只在 Host 内使用。 */
export class DeepseekSubscriptionService {
  private readonly request: FetchLike
  private readonly timeoutMs: number
  private readonly configuredSources: readonly Sub2ApiSource[] | undefined

  constructor(options: DeepseekSubscriptionOptions = {}) {
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.configuredSources = options.sources
  }

  async read(source?: Sub2ApiSource): Promise<CliSubscriptionUsage | null> {
    const sources = source === undefined ? (this.configuredSources ?? resolveDeepseekSources()) : [source]
    for (const candidate of sources) {
      if (!isOfficialDeepseekUrl(candidate.baseUrl)) continue
      const result = await this.readSource(candidate)
      if (result !== null) return result
    }
    return null
  }

  private async readSource(source: Sub2ApiSource): Promise<CliSubscriptionUsage | null> {
    const baseUrl = deepseekApiRoot(source.baseUrl)
    if (baseUrl === '' || source.apiKey.trim() === '') return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request(`${baseUrl}/user/balance`, {
        headers: {
          Authorization: source.apiKey.trim().startsWith('Bearer ') ? source.apiKey.trim() : `Bearer ${source.apiKey.trim()}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      })
      if (!response.ok) return null
      const usage = normalizeDeepseekUsage(await response.json(), baseUrl)
      if (usage === null) return null
      return {
        authenticated: true,
        planType: null,
        primary: null,
        secondary: null,
        monthly: null,
        rateLimitReachedType: null,
        resetCredits: null,
        capturedAt: new Date().toISOString(),
        provider: providerSummary(identifyModelProvider({ name: 'deepseek', baseUrl }), baseUrl, await readLogoDataUrl(identifyModelProvider({ name: 'deepseek', baseUrl })?.logoUrl ?? '', this.request, this.timeoutMs)),
        deepseek: usage,
      }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

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

  hasSource(adapterId: string, providerId?: string): boolean {
    const configured = this.configuredSources?.[adapterId as keyof NonNullable<Sub2ApiUsageOptions['sources']>]
    if (configured !== undefined) return Array.isArray(configured) ? configured.length > 0 : true
    return resolveSub2ApiSources(adapterId, providerId).length > 0
  }

  /** 只判断是否存在第三方上游；官方 Codex/Claude 源必须允许回退原生订阅读取器。 */
  hasThirdPartySource(adapterId: string, providerId?: string): boolean {
    const configured = this.configuredSources?.[adapterId as keyof NonNullable<Sub2ApiUsageOptions['sources']>]
    const sources = configured === undefined
      ? resolveSub2ApiSources(adapterId, providerId)
      : Array.isArray(configured) ? configured : [configured]
    return sources.some((source) => !isOfficialAgentSource(adapterId, source))
  }

  async read(adapterId: string, providerId?: string): Promise<CliSubscriptionUsage | null> {
    const configured = this.configuredSources?.[adapterId as keyof NonNullable<Sub2ApiUsageOptions['sources']>]
    const sources = configured === undefined ? resolveSub2ApiSources(adapterId, providerId) : Array.isArray(configured) ? configured : [configured]
    for (const source of sources) {
      const result = await this.readSource(source, providerId)
      if (result !== null) return result
    }
    return null
  }

  private async readSource(source: Sub2ApiSource, providerId?: string): Promise<CliSubscriptionUsage | null> {
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
      const logoUrl = buildLogoUrl(baseUrl)
      const logoDataUrl = logoUrl === '' ? '' : await readLogoDataUrl(logoUrl, this.request, this.timeoutMs)
      const providerDefinition = identifyModelProvider({ name: providerId, baseUrl }) ?? thirdPartyProvider({ name: providerId, baseUrl })
      const providerLogoDataUrl = logoDataUrl || await readLogoDataUrl(providerDefinition.logoUrl, this.request, this.timeoutMs)
      return { authenticated: true, planType: usage.planName, primary: null, secondary: null, monthly: null, rateLimitReachedType: null, resetCredits: null, capturedAt: new Date().toISOString(), provider: providerSummary(providerDefinition, baseUrl, providerLogoDataUrl, 'sub2api'), sub2api: { ...usage, logoUrl, logoDataUrl } }
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
        await rpc.request('initialize', { clientInfo: { name: 'codingns4dsh', version: '0.1.1' }, capabilities: {} }, { signal: controller.signal })
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

export interface KimiSubscriptionOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly credentials?: readonly string[]
}

/** 读取 Kimi Code 官方套餐额度；本地 OAuth 凭据只在 Host 内使用，不做刷新只读访问令牌。 */
export class KimiSubscriptionService implements SubscriptionReader {
  private readonly request: FetchLike
  private readonly timeoutMs: number
  private readonly credentialPaths: readonly string[]

  constructor(options: KimiSubscriptionOptions = {}) {
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.credentialPaths = options.credentials ?? defaultKimiCredentialPaths()
  }

  async read(): Promise<CliSubscriptionUsage | null> {
    const token = this.readAccessToken()
    if (token === null) return null
    for (const baseUrl of kimiCodeBaseUrls(token.region)) {
      const usage = await this.readUsage(baseUrl, token.value)
      if (usage !== null) return usage
    }
    return null
  }

  private readAccessToken(): { readonly value: string; readonly region: string | null } | null {
    for (const path of this.credentialPaths) {
      const credentials = readJson(path)
      const token = textValue(credentials?.access_token)
      if (token === null) continue
      const expiresAt = numberValue(credentials?.expires_at)
      // 访问令牌有效期很短；已过期或临期的令牌直接跳过，由 CLI 自己负责刷新。
      if (expiresAt !== null && expiresAt * 1000 <= Date.now() + 30_000) continue
      return { value: token, region: kimiTokenRegion(token) }
    }
    return null
  }

  private async readUsage(baseUrl: string, token: string): Promise<CliSubscriptionUsage | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request(`${baseUrl}/usages`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) return null
      return normalizeKimiUsage(await response.json())
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface GrokSubscriptionOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly credentials?: readonly string[]
}

const GROK_BILLING_ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'
const GROK_OIDC_SCOPE_PREFIX = 'https://auth.x.ai::'
const GROK_LEGACY_SESSION_SCOPE = 'https://accounts.x.ai/sign-in'

/** 读取 Grok（xAI）官方 SuperGrok 订阅额度；只读 Grok CLI 的 OAuth 凭据（~/.grok/auth.json），不做刷新，过期令牌也照常尝试以容忍时钟偏差。 */
export class GrokSubscriptionService implements SubscriptionReader {
  private readonly request: FetchLike
  private readonly timeoutMs: number
  private readonly credentialPaths: readonly string[]

  constructor(options: GrokSubscriptionOptions = {}) {
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.credentialPaths = options.credentials ?? defaultGrokCredentialPaths()
  }

  async read(): Promise<CliSubscriptionUsage | null> {
    const token = this.readAccessToken()
    if (token === null) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      // 空 gRPC-web 帧（1 字节 flags + 4 字节大端长度 0）即可取回账单快照。
      const response = await this.request(GROK_BILLING_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'https://grok.com',
          Referer: 'https://grok.com/?_s=usage',
          Accept: '*/*',
          'Content-Type': 'application/grpc-web+proto',
          'x-grpc-web': '1',
          'x-user-agent': 'connect-es/2.1.1',
        },
        body: new Uint8Array(5),
        signal: controller.signal,
      })
      // 鉴权失败与其他 HTTP 错误都不展示陈旧数据；令牌过期时由 Grok CLI 重新登录后恢复。
      if (!response.ok) return null
      const headerStatus = numberValue(response.headers.get('grpc-status') ?? undefined)
      if (headerStatus !== null && headerStatus !== 0) return null
      const raw = new Uint8Array(await response.arrayBuffer())
      const trailerStatus = numberValue(grpcWebTrailerFields(raw)['grpc-status'])
      if (trailerStatus !== null && trailerStatus !== 0) return null
      const nowSecs = Math.floor(Date.now() / 1000)
      const snapshot = parseGrokBillingPayload(raw, nowSecs)
      if (snapshot === null) return null
      const usedPercent = clamp(snapshot.usedPercent)
      return {
        authenticated: true,
        planType: null,
        primary: { usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: grokWindowDurationMins(snapshot.resetsAt, nowSecs), resetsAt: snapshot.resetsAt },
        secondary: null,
        monthly: null,
        rateLimitReachedType: null,
        resetCredits: null,
        capturedAt: new Date().toISOString(),
      }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private readAccessToken(): string | null {
    for (const path of this.credentialPaths) {
      const auth = readJson(path)
      if (auth === null) continue
      const token = selectGrokAuthToken(auth)
      if (token !== null) return token
    }
    return null
  }
}

function defaultGrokCredentialPaths(): string[] {
  return [join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'auth.json')]
}

/** auth.json 以 OIDC scope URL 为键；优先 SuperGrok 的 auth.x.ai 条目，回退 legacy 登录条目，残缺条目不遮蔽健康条目。 */
function selectGrokAuthToken(auth: Record<string, unknown>): string | null {
  let oidc: string | null = null
  let legacy: string | null = null
  for (const [scope, value] of Object.entries(auth)) {
    const key = textValue(recordValue(value)?.key)
    if (key === null) continue
    if (scope.startsWith(GROK_OIDC_SCOPE_PREFIX)) oidc = key
    else if (scope === GROK_LEGACY_SESSION_SCOPE || scope.includes('/sign-in')) legacy = key
  }
  return oidc ?? legacy
}

/** 按重置时间距今的天数推断窗口长度（4–12 天按周窗口、20–45 天按月窗口），无法推断时留空由客户端使用兜底标签。 */
function grokWindowDurationMins(resetsAt: number | null, nowSecs: number): number | null {
  if (resetsAt === null) return null
  const days = Math.round((resetsAt - nowSecs) / 86_400)
  if (days >= 4 && days <= 12) return 7 * 24 * 60
  if (days >= 20 && days <= 45) return 30 * 24 * 60
  return null
}

interface GrokBillingSnapshot { readonly usedPercent: number; readonly resetsAt: number | null }

interface GrokProtobufScan {
  readonly fixed32: { readonly path: readonly number[]; readonly value: number; readonly order: number }[]
  readonly varint: { readonly path: readonly number[]; readonly value: number }[]
}

/**
 * 账单端点没有公开 .proto，按字段路径启发式提取（移植自 cc-switch / CodexBar）：
 * 百分比取路径末段为 1、值域 [0,100] 的最浅 fixed32 字段；重置时间取落在合理 Unix 秒区间且
 * 晚于当前时刻的 varint（优先路径 [1,5,1]）；proto3 会省略 0 值字段，存在重置时间与周期标记时按 0% 处理。
 */
function parseGrokBillingPayload(data: Uint8Array, nowSecs: number): GrokBillingSnapshot | null {
  let payloads = grpcWebDataFrames(data)
  if (payloads.length === 0 && looksLikeProtobufPayload(data)) payloads = [data]
  if (payloads.length === 0) return null
  const scan: GrokProtobufScan = { fixed32: [], varint: [] }
  for (const payload of payloads) scanGrokProtobuf(payload, 0, [], 0, scan)
  const percent = scan.fixed32
    .filter((field) => field.path.at(-1) === 1 && Number.isFinite(field.value) && field.value >= 0 && field.value <= 100)
    .sort((left, right) => (left.path.length - right.path.length) || (left.order - right.order))[0]?.value
  const resetCandidates = scan.varint.filter((field) => field.value >= 1_700_000_000 && field.value <= 2_100_000_000 && field.value > nowSecs)
  const preferred = resetCandidates.filter((field) => field.path.length === 3 && field.path[0] === 1 && field.path[1] === 5 && field.path[2] === 1)
  const resetPool = preferred.length > 0 ? preferred : resetCandidates
  const reset = resetPool.length > 0 ? Math.min(...resetPool.map((field) => field.value)) : null
  const hasUsagePeriod = scan.varint.some((field) =>
    (field.path.length >= 2 && field.path[0] === 1 && field.path[1] === 6)
    || (field.path.length === 3 && field.path[0] === 1 && field.path[1] === 8 && field.path[2] === 1 && (field.value === 1 || field.value === 2)))
  const usedPercent = percent ?? (scan.fixed32.length === 0 && reset !== null && hasUsagePeriod ? 0 : undefined)
  if (usedPercent === undefined) return null
  return { usedPercent, resetsAt: reset }
}

/** 拆出 gRPC-web data 帧（flags 高位 0x80 的 trailer 帧跳过）；任一帧长度非法时返回空，调用方再按裸 protobuf 兜底。 */
function grpcWebDataFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = []
  let index = 0
  while (index < data.length) {
    if (index + 5 > data.length) return []
    const flags = data[index]!
    const length = data[index + 1]! * 16_777_216 + data[index + 2]! * 65_536 + data[index + 3]! * 256 + data[index + 4]!
    const start = index + 5
    const end = start + length
    if (end > data.length) return []
    if ((flags & 0x80) === 0) frames.push(data.subarray(start, end))
    index = end
  }
  return frames
}

/** 响应体没有帧头时，看首字节是否像合法 protobuf tag（某些成功请求直接返回裸 protobuf）。 */
function looksLikeProtobufPayload(data: Uint8Array): boolean {
  const first = data[0]
  if (first === undefined) return false
  const wireType = first & 0x07
  return first >> 3 > 0 && (wireType === 0 || wireType === 1 || wireType === 2 || wireType === 5)
}

/** 从 trailer 帧（flags & 0x80）解析 grpc-status / grpc-message 等字段。 */
function grpcWebTrailerFields(data: Uint8Array): Record<string, string> {
  const fields: Record<string, string> = {}
  let index = 0
  while (index + 5 <= data.length) {
    const flags = data[index]!
    const length = data[index + 1]! * 16_777_216 + data[index + 2]! * 65_536 + data[index + 3]! * 256 + data[index + 4]!
    const start = index + 5
    const end = start + length
    if (end > data.length) break
    if ((flags & 0x80) !== 0) {
      for (const line of new TextDecoder().decode(data.subarray(start, end)).split(/\r?\n/u)) {
        const separator = line.indexOf(':')
        if (separator <= 0) continue
        fields[line.slice(0, separator).trim().toLowerCase()] = grokPercentDecode(line.slice(separator + 1).trim())
      }
    }
    index = end
  }
  return fields
}

/** gRPC message 使用 percent-encoding；解码失败的序列原样保留。 */
function grokPercentDecode(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const out: number[] = []
  let index = 0
  while (index < bytes.length) {
    if (bytes[index] === 0x25 && index + 2 < bytes.length) {
      const hex = String.fromCharCode(bytes[index + 1]!, bytes[index + 2]!)
      if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
        out.push(parseInt(hex, 16))
        index += 3
        continue
      }
    }
    out.push(bytes[index]!)
    index += 1
  }
  return new TextDecoder().decode(new Uint8Array(out))
}

function readGrokVarint(bytes: Uint8Array, state: { index: number }): number | null {
  let value = 0
  let shift = 0
  while (state.index < bytes.length && shift < 64) {
    const byte = bytes[state.index]!
    state.index += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return value
    shift += 7
  }
  return null
}

/** 递归扫描 protobuf 消息，收集 varint 与 fixed32 字段；length-delimited 一律按嵌套消息试扫（深度 ≤4），无法解析时从字段起点 +1 重新同步。 */
function scanGrokProtobuf(bytes: Uint8Array, depth: number, path: readonly number[], order: number, scan: GrokProtobufScan): number {
  let index = 0
  let nextOrder = order
  while (index < bytes.length) {
    const fieldStart = index
    const keyState = { index }
    const key = readGrokVarint(bytes, keyState)
    index = keyState.index
    if (key === null || key === 0) {
      index = fieldStart + 1
      continue
    }
    const fieldPath = [...path, Math.floor(key / 8)]
    const wireType = key & 0x07
    if (wireType === 0) {
      const valueState = { index }
      const value = readGrokVarint(bytes, valueState)
      if (value === null) {
        index = fieldStart + 1
        continue
      }
      index = valueState.index
      scan.varint.push({ path: fieldPath, value })
      continue
    }
    if (wireType === 1) {
      if (index + 8 > bytes.length) return nextOrder
      index += 8
      continue
    }
    if (wireType === 2) {
      const lengthState = { index }
      const length = readGrokVarint(bytes, lengthState)
      index = lengthState.index
      if (length === null || length > bytes.length - index) {
        index = fieldStart + 1
        continue
      }
      const end = index + length
      if (depth < 4) nextOrder = scanGrokProtobuf(bytes.subarray(index, end), depth + 1, fieldPath, nextOrder, scan)
      index = end
      continue
    }
    if (wireType === 5) {
      if (index + 4 > bytes.length) return nextOrder
      scan.fixed32.push({ path: fieldPath, value: new DataView(bytes.buffer, bytes.byteOffset + index, 4).getFloat32(0, true), order: nextOrder })
      nextOrder += 1
      index += 4
      continue
    }
    index = fieldStart + 1
  }
  return nextOrder
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

function defaultKimiCredentialPaths(): string[] {
  return [
    join(process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'), 'credentials', 'kimi-code.json'),
    join(process.env.KIMI_HOME ?? join(homedir(), '.kimi'), 'credentials', 'kimi-code.json'),
  ]
}

/** 只解析 JWT payload 中的 region 字段用于选择就近接入点；签名校验由服务端负责。 */
function kimiTokenRegion(token: string): string | null {
  const parts = token.split('.')
  const payloadPart = parts[1]
  if (payloadPart === undefined) return null
  try {
    const payload = recordValue(JSON.parse(Buffer.from(payloadPart.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8')))
    return textValue(payload?.region)
  } catch {
    return null
  }
}

function kimiCodeBaseUrls(region: string | null): string[] {
  const override = textValue(process.env.KIMI_CODE_BASE_URL)
  if (override !== null) return [override.replace(/\/+$/u, '')]
  const mainland = 'https://api.kimi.com/coding/v1'
  const global = 'https://api.kimi.ai/coding/v1'
  return region === 'cn' ? [mainland, global] : [global, mainland]
}

function normalizeKimiUsage(value: unknown): CliSubscriptionUsage | null {
  const usages = recordValue(recordValue(value)?.usages)
  if (usages === null) return null
  const primary = normalizeKimiQuotaWindow(usages.limit_5h ?? usages.limit5h, 5 * 60)
  const secondary = normalizeKimiQuotaWindow(usages.limit_7d ?? usages.limit7d, 7 * 24 * 60)
  const monthly = normalizeKimiQuotaWindow(usages.limit_month_code ?? usages.limitMonthCode, null)
    ?? normalizeKimiQuotaWindow(usages.limit_month_total ?? usages.limitMonthTotal, null)
  if (primary === null && secondary === null && monthly === null) return null
  return {
    authenticated: true,
    planType: null,
    primary,
    secondary,
    monthly,
    rateLimitReachedType: null,
    resetCredits: null,
    capturedAt: new Date().toISOString(),
  }
}

function normalizeKimiQuotaWindow(value: unknown, windowDurationMins: number | null): CliSubscriptionWindow | null {
  const source = recordValue(value)
  if (source === null) return null
  const usedRatio = numberValue(source.used_ratio ?? source.usedRatio)
  if (usedRatio === null) return null
  const usedPercent = clamp(usedRatio * 100)
  return { usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins, resetsAt: timestampValue(source.reset_time ?? source.resetAt) }
}

function hasThirdPartyCodexConfig(homeDirectory: string): boolean {
  const config = readText(join(homeDirectory, 'config.toml'))
  const configuredBaseUrl = config === null ? null : readCodexBaseUrl(config)
  const environmentBaseUrl = textValue(process.env.OPENAI_BASE_URL)
  return [configuredBaseUrl, environmentBaseUrl].some((value) => value !== null && !isOfficialOpenAiUrl(value))
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

/** 只读取 DSH 凭据文档中的指定引用，不把凭据内容写入任何返回结构。 */
function readDshCredential(name: string): string | null {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const paths = [join(dshHome, '.credentials.yaml'), join(dshHome, '.env'), join(process.cwd(), '.env')]
  const pattern = new RegExp(`^\\s*${name}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^#\\s]+))`, 'mu')
  const envPattern = new RegExp(`^\\s*${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\s]+))`, 'mu')
  for (const path of paths) {
    const source = readText(path)
    if (source === null) continue
    const match = path.endsWith('.env') ? envPattern.exec(source) : pattern.exec(source)
    const value = match?.[1] ?? match?.[2] ?? match?.[3]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
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

function normalizeDeepseekUsage(value: unknown, baseUrl: string): DeepseekUsage | null {
  const root = recordValue(value)
  if (root === null) return null
  const rawBalances = root.balance_infos ?? root.balanceInfos ?? root.balances
  if (!Array.isArray(rawBalances)) return null
  const balances = rawBalances.flatMap((value): DeepseekBalance[] => {
    const source = recordValue(value)
    const currency = textValue(source?.currency)
    const totalBalance = numberValue(source?.total_balance ?? source?.totalBalance)
    if (currency === null || totalBalance === null) return []
    return [{
      currency,
      totalBalance,
      grantedBalance: numberValue(source?.granted_balance ?? source?.grantedBalance) ?? 0,
      toppedUpBalance: numberValue(source?.topped_up_balance ?? source?.toppedUpBalance) ?? 0,
    }]
  })
  if (balances.length === 0) return null
  return {
    upstreamUrl: sanitizeUpstreamUrl(baseUrl),
    isAvailable: typeof root.is_available === 'boolean' ? root.is_available : typeof root.isAvailable === 'boolean' ? root.isAvailable : null,
    balances,
  }
}

function resolveDeepseekSources(): Sub2ApiSource[] {
  const sources: Sub2ApiSource[] = []
  const add = (source: Sub2ApiSource | null): void => {
    if (source === null || source.baseUrl.trim() === '' || source.apiKey.trim() === '') return
    if (!sources.some((item) => item.baseUrl === source.baseUrl && item.apiKey === source.apiKey)) sources.push(source)
  }
  const dshBaseUrl = textValue(process.env.DSH_BASE_URL)
  const dshApiKey = textValue(process.env.DSH_API_KEY)
  add(dshBaseUrl !== null && dshApiKey !== null ? { baseUrl: dshBaseUrl, apiKey: dshApiKey } : null)
  const deepseekBaseUrl = textValue(process.env.DEEPSEEK_BASE_URL)
  const deepseekApiKey = textValue(process.env.DEEPSEEK_API_KEY) ?? readDshCredential('DEEPSEEK_API_KEY')
  add(deepseekApiKey === null ? null : { baseUrl: deepseekBaseUrl ?? 'https://api.deepseek.com', apiKey: deepseekApiKey })
  add(envSource('DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY'))
  add(findConfigSource(readJson(join(homedir(), '.dsh', 'config.json'))))
  return sources
}

function resolveDshProviderSource(providerId: string | undefined): Sub2ApiSource | null {
  const normalized = providerId?.trim()
  if (normalized === undefined || normalized === '') return null
  const envPrefix = normalized.replace(/[^a-z0-9]+/giu, '_').toUpperCase()
  const envBaseUrl = textValue(process.env[`${envPrefix}_BASE_URL`])
  const envApiKey = textValue(process.env[`${envPrefix}_API_KEY`])
  if (envBaseUrl !== null && envApiKey !== null) return { baseUrl: envBaseUrl, apiKey: envApiKey }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const path of [join(dshHome, 'settings.yaml'), join(dshHome, 'settings.yaml.imported')]) {
    const source = readDshProviderYaml(path, normalized)
    if (source !== null) return source
  }
  return null
}

function resolveDshDefaultProvider(): string | undefined {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const path of [join(dshHome, 'settings.yaml'), join(dshHome, 'settings.yaml.imported')]) {
    const text = readText(path)
    if (text === null) continue
    const start = text.search(/^agent-default-model:\s*$/mu)
    if (start < 0) continue
    const rest = text.slice(start)
    const endMatch = /^\S[^\n]*$/mu.exec(rest.slice(1))
    const block = endMatch === null ? rest : rest.slice(0, endMatch.index + 1)
    const provider = yamlScalar(block.match(/^\s+provider:\s*(.+)$/mu)?.[1])
    if (provider !== null) return provider
  }
  return undefined
}

function readDshProviderYaml(path: string, providerId: string): Sub2ApiSource | null {
  const text = readText(path)
  if (text === null) return null
  const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const start = text.search(new RegExp(`^ {4}${escaped}:\\s*$`, 'mu'))
  if (start < 0) return null
  const rest = text.slice(start)
  const endMatch = /^ {4}\S[^\n]*$/mu.exec(rest.slice(1))
  const block = endMatch === null ? rest : rest.slice(0, endMatch.index + 1)
  const baseUrl = yamlScalar(block.match(/^\s+baseURL:\s*(.+)$/mu)?.[1])
  const keyRef = yamlScalar(block.match(/^\s+apiKeyEnv:\s*(.+)$/mu)?.[1])
  const apiKey = keyRef === null ? null : textValue(process.env[keyRef]) ?? readDshCredential(keyRef)
  return baseUrl === null || apiKey === null ? null : { baseUrl, apiKey }
}

function yamlScalar(value: string | undefined): string | null {
  if (value === undefined) return null
  const normalized = value.trim().replace(/^(['"])(.*)\1$/u, '$2')
  return normalized === '' ? null : normalized
}

function isOfficialDeepseekProvider(providerId: string | undefined): boolean {
  if (providerId === undefined) return false
  return /^(?:deepseek(?:-official)?|official-deepseek)$/iu.test(providerId.trim())
}

/** 官方接口必须同时满足提供商名称和官方 baseURL，避免第三方代理冒充官方。 */
function isOfficialDeepseekSource(providerId: string | undefined, source: Sub2ApiSource | null): boolean {
  if (source === null || !isOfficialDeepseekUrl(source.baseUrl)) return false
  return providerId === undefined || isOfficialDeepseekProvider(providerId)
}

function isThirdPartyDeepseekProvider(providerId: string | undefined): boolean {
  return providerId !== undefined && providerId.trim() !== '' && !isOfficialDeepseekProvider(providerId)
}

function providerSummary(definition: ProviderDefinition | undefined, baseUrl: string, logoDataUrl: string, capability?: CliSubscriptionProvider['capability']): CliSubscriptionProvider {
  const resolved = definition ?? thirdPartyProvider({ baseUrl })
  return {
    id: resolved.id,
    displayName: resolved.displayName,
    baseUrl: sanitizeUpstreamUrl(baseUrl),
    capability: capability ?? resolved.capability,
    logoUrl: resolved.logoUrl,
    ...(logoDataUrl === '' ? {} : { logoDataUrl }),
  }
}

function withProvider(usage: CliSubscriptionUsage, definition: ProviderDefinition | undefined, baseUrl = ''): CliSubscriptionUsage {
  return { ...usage, provider: providerSummary(definition, baseUrl, '') }
}

function resolveSub2ApiSources(adapterId: string, providerId?: string): Sub2ApiSource[] {
  const sources: Sub2ApiSource[] = []
  const add = (source: Sub2ApiSource | null): void => {
    if (source === null || source.baseUrl.trim() === '' || source.apiKey.trim() === '') return
    if (!sources.some((item) => item.baseUrl === source.baseUrl && item.apiKey === source.apiKey)) sources.push(source)
  }
  if (adapterId === 'codex') {
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
    const config = readText(join(home, 'config.toml')) ?? ''
    add(readCodexSource(home, config))
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
    const providerSource = resolveDshProviderSource(providerId)
    add(providerSource)
    // 已明确拿到当前提供商时只查询它的上游，不能把另一个配置项的余额冒充过来。
    if (providerId !== undefined && !isOfficialDeepseekProvider(providerId)) return sources
    for (const source of resolveDeepseekSources()) {
      if (!isOfficialDeepseekUrl(source.baseUrl)) add(source)
    }
    add(envSource('OPENAI_BASE_URL', 'OPENAI_API_KEY'))
  }
  if (adapterId === 'grok') {
    add(envSource('GROK_BASE_URL', 'GROK_API_KEY'))
    add(envSource('XAI_BASE_URL', 'XAI_API_KEY'))
    add(envSource('XAI_API_BASE_URL', 'XAI_API_KEY'))
    add(findConfigSource(readJson(join(homedir(), '.grok', 'config.json'))))
  }
  return sources
}

function readCodexSource(homeDirectory: string, config: string): Sub2ApiSource | null {
  const baseUrl = readCodexBaseUrl(config) ?? textValue(process.env.OPENAI_BASE_URL)
  if (baseUrl === null) return null
  const provider = tomlScalar(config, 'model_provider')
  const section = provider === null ? '' : tomlSection(config, `model_providers.${provider}`)
  const token = tomlScalar(section, 'experimental_bearer_token')
    ?? tomlScalar(section, 'api_key')
    ?? (() => {
      const environmentName = tomlScalar(section, 'api_key_env')
      return environmentName === null ? null : textValue(process.env[environmentName])
    })()
    ?? textValue(readJsonValue(join(homeDirectory, 'auth.json'), 'OPENAI_API_KEY'))
    ?? textValue(process.env.OPENAI_API_KEY)
  return token === null ? null : { baseUrl, apiKey: token }
}

function readCodexBaseUrl(config: string): string | null {
  const provider = tomlScalar(config, 'model_provider')
  const section = provider === null ? '' : tomlSection(config, `model_providers.${provider}`)
  return tomlScalar(section, 'base_url') ?? tomlScalar(config, 'base_url')
}

function tomlSection(source: string, name: string): string {
  if (source === '') return ''
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const start = source.search(new RegExp(`^\\[${escaped}\\]\\s*$`, 'mu'))
  if (start < 0) return ''
  const rest = source.slice(start)
  const next = /^\[[^\n]+\]\s*$/mu.exec(rest.slice(1))
  return next === null ? rest : rest.slice(0, next.index + 1)
}

function tomlScalar(source: string, key: string): string | null {
  if (source === '') return null
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\s]+))`, 'mu').exec(source)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return textValue(value)
}

function isOfficialAgentSource(adapterId: string, source: Sub2ApiSource): boolean {
  if (adapterId === 'codex') return isOfficialOpenAiUrl(source.baseUrl)
  if (adapterId === 'claude-code') return isOfficialAnthropicUrl(source.baseUrl)
  return false
}

function isOfficialDeepseekUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'api.deepseek.com' || hostname === 'api.deepseek.com.cn'
  } catch {
    return false
  }
}

function deepseekApiRoot(value: string): string {
  try {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/\/v1\/?$/u, '').replace(/\/+$/u, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return ''
  }
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
    logoDataUrl: '',
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

/** 获取小型公开图标并转为 CSP 允许的 data URL；图标失败不影响订阅数据。 */
async function readLogoDataUrl(url: string, request: FetchLike, timeoutMs: number): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  } catch {
    return ''
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 3_000))
  try {
    const response = await request(parsed.toString(), { headers: { Accept: 'image/*' }, signal: controller.signal })
    if (!response.ok) return ''
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (!isSupportedLogoContentType(contentType)) return ''
    if (response.url !== '' && new URL(response.url).origin !== parsed.origin) return ''
    const bytes = await readResponseBytes(response, 64 * 1024)
    if (bytes === null || (contentType === 'image/svg+xml' && !isSafeSvg(bytes))) return ''
    return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

function isSupportedLogoContentType(value: string): boolean {
  return value === 'image/svg+xml' || value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp' || value === 'image/avif' || value === 'image/x-icon' || value === 'image/vnd.microsoft.icon'
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > maxBytes ? null : bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function isSafeSvg(bytes: Uint8Array): boolean {
  const source = new TextDecoder().decode(bytes).toLowerCase()
  return !/<\/?script\b|<\/?foreignobject\b|\bon[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']https?:|url\(\s*https?:/u.test(source)
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
