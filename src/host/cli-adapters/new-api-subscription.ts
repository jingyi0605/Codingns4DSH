import type {
  CliSubscriptionProvider,
  CliSubscriptionUsage,
  CliSubscriptionWindow,
  ProviderBalanceUsage,
} from '../../shared/contracts/subscription.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readDshProviderSource } from './dsh-config.js'
import { readZcodeProviderConfigs } from './zcode-provider-config.js'

type FetchLike = typeof fetch

/** New-API/One-API 兼容上游的凭据。原始 API key 只在 Host 内使用。 */
export interface NewApiSource {
  readonly baseUrl: string
  readonly apiKey: string
}

/** New-API 读取器选项。一个 Agent 可以配置一个或多个候选来源。 */
export interface NewApiSubscriptionOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly sources?: Partial<Record<string, NewApiSource | readonly NewApiSource[]>>
}

type NewApiSources = NewApiSubscriptionOptions['sources']

/**
 * 从显式配置中解析某个 Agent 的 New-API 来源。
 *
 * providerId 优先用于兼容按提供商名称保存的旧配置；未找到时再读取
 * adapterId。未传配置时返回空数组，来源发现由上层适配器负责。
 */
export function resolveNewApiSources(
  adapterId: string,
  providerId?: string,
  configuredSources?: NewApiSources,
): NewApiSource[] {
  if (configuredSources !== undefined) {
    const configured = providerId !== undefined && configuredSources[providerId] !== undefined
      ? configuredSources[providerId]
      : configuredSources[adapterId]
    const sources = configured === undefined ? [] : Array.isArray(configured) ? [...configured] : [configured as NewApiSource]
    return sources.filter((source) => !isOfficialAgentBaseUrl(adapterId, source.baseUrl))
  }
  return discoverNewApiSources(adapterId, providerId).filter((source) => !isOfficialAgentBaseUrl(adapterId, source.baseUrl))
}

export function isOfficialAgentBaseUrl(_adapterId: string, value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    // 官方地址不属于 New-API；这一规则对所有能声明自定义 Provider 的适配器生效。
    // 参数保留在签名中，兼容旧配置解析调用，也避免把同一地址误判为第三方。
    return host === 'api.openai.com'
      || host === 'api.anthropic.com'
      || host === 'api.x.ai'
      || host === 'api.xai.com'
      || host === 'www.codebuddy.ai'
      || host === 'copilot.tencent.com'
      || host === 'www.codebuddy.cn'
      || host === 'www.workbuddy.cn'
      || host === 'staging-codebuddy.tencent.com'
      || host === 'staging.copilot.tencent.com'
      || host === 'staging.codebuddy.cn'
  } catch {
    return false
  }
}

/** 从 Agent 自己的配置读取所有明确声明的自定义上游；不会改变 Sub2API 的来源解析。 */
function discoverNewApiSources(adapterId: string, providerId?: string): NewApiSource[] {
  const result: NewApiSource[] = []
  const add = (source: NewApiSource | null): void => {
    if (source === null || source.baseUrl.trim() === '' || source.apiKey.trim() === '') return
    if (!result.some((item) => item.baseUrl === source.baseUrl && item.apiKey === source.apiKey)) result.push(source)
  }
  const home = homedir()
  if (adapterId === 'codex') add(readCodexSource())
  if (adapterId === 'claude-code') add(readClaudeSource())
  if (adapterId === 'opencode') {
    const paths = [
      join(home, '.config', 'opencode', 'opencode.json'),
      join(home, 'Library', 'Application Support', 'opencode', 'opencode.json'),
      ...(process.env.APPDATA === undefined ? [] : [join(process.env.APPDATA, 'opencode', 'opencode.json')]),
    ]
    paths.flatMap((path) => readConfigSources(readJson(path), providerId)).forEach(add)
  }
  if (adapterId === 'grok') {
    add(envSource('GROK_BASE_URL', 'GROK_API_KEY'))
    add(envSource('XAI_BASE_URL', 'XAI_API_KEY'))
    add(envSource('XAI_API_BASE_URL', 'XAI_API_KEY'))
    readConfigSources(readJson(join(process.env.GROK_HOME ?? join(home, '.grok'), 'config.json')), providerId).forEach(add)
  }
  if (adapterId === 'command-code') readCommandCodeSources(providerId).forEach(add)
  if (adapterId === 'zcode') readZcodeSources(providerId).forEach(add)
  if (adapterId === 'codebuddy' || adapterId === 'workbuddy') readCodeBuddySources(adapterId, providerId).forEach(add)
  if (adapterId === 'dsh') {
    if (providerId !== undefined && providerId.trim() !== '') add(readNamedDshSource(providerId))
    else {
      add(envSource('DSH_BASE_URL', 'DSH_API_KEY'))
      add(envSource('OPENAI_BASE_URL', 'OPENAI_API_KEY'))
    }
  }
  return result
}

function readCodexSource(): NewApiSource | null {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const config = readText(join(home, 'config.toml')) ?? ''
  const provider = tomlScalar(config, 'model_provider')
  const section = provider === null ? '' : tomlSection(config, `model_providers.${provider}`)
  const baseUrl = tomlScalar(section, 'base_url') ?? textValue(process.env.OPENAI_BASE_URL)
  const envName = tomlScalar(section, 'api_key_env')
  const apiKey = tomlScalar(section, 'experimental_bearer_token') ?? tomlScalar(section, 'api_key') ?? (envName === null ? null : textValue(process.env[envName])) ?? textValue(process.env.OPENAI_API_KEY)
  return baseUrl === null || apiKey === null ? null : { baseUrl, apiKey }
}

function readClaudeSource(): NewApiSource | null {
  const home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const env = recordValue(readJson(join(home, 'settings.json'))?.env)
  const baseUrl = textValue(process.env.ANTHROPIC_BASE_URL) ?? textValue(env?.ANTHROPIC_BASE_URL)
  const apiKey = textValue(process.env.ANTHROPIC_AUTH_TOKEN) ?? textValue(process.env.ANTHROPIC_API_KEY) ?? textValue(env?.ANTHROPIC_AUTH_TOKEN) ?? textValue(env?.ANTHROPIC_API_KEY)
  return baseUrl === null || apiKey === null ? null : { baseUrl, apiKey }
}

function readNamedDshSource(providerId: string): NewApiSource | null {
  const prefix = providerId.replace(/[^a-z0-9]+/giu, '_').toUpperCase()
  const env = envSource(`${prefix}_BASE_URL`, `${prefix}_API_KEY`)
  if (env !== null) return env
  return readDshProviderSource(providerId)
}

function readZcodeSources(providerId?: string): NewApiSource[] {
  const paths = [process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, join(homedir(), '.zcode', 'v2', 'provider_config.json')].filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  const result = paths.flatMap((path) => {
    const value = readJson(path)
    const rules = recordValue(recordValue(value?.config)?.providerConfigRules)?.providerRules
    // 旧导出格式可能直接把地址和密钥放在规则上；兼容时仍只读当前 Provider。
    if (Array.isArray(rules)) return rules.filter((rule) => providerId === undefined || recordValue(rule)?.providerId === providerId)
      .flatMap((rule) => readConfigSources(rule))
    return readConfigSources(value, providerId)
  })
  return [...readZcodeProviderConfigs(providerId).flatMap((provider) => provider.source === null ? [] : [provider.source]), ...result]
}

function readCommandCodeSources(providerId?: string): NewApiSource[] {
  const home = process.env.COMMANDCODE_HOME ?? join(homedir(), '.commandcode')
  const providers = readJson(join(home, 'providers.json'))
  const auth = readJson(join(home, 'auth.json'))
  const providerMap = recordValue(providers?.provider) ?? recordValue(providers?.providers)
  const selected = providerId === undefined || providerMap === null ? providerMap : recordValue(providerMap[providerId])
  const direct = readConfigSources(selected ?? providers, providerId)
  const authSources = readConfigSources(auth, providerId)
  return [...direct, ...authSources]
}

function readCodeBuddySources(adapterId: string, providerId?: string): NewApiSource[] {
  if (adapterId === 'codebuddy-cn') adapterId = 'codebuddy'
  // WorkBuddy 桌面应用的配置与认证根是 `.workbuddy`；旧的 `.workbuddy-ai`
  // 目录不会包含桌面登录态，也不能作为 New-API 来源发现的默认目录。
  const home = adapterId === 'workbuddy' ? join(homedir(), '.workbuddy') : join(homedir(), '.codebuddy')
  const roots = adapterId === 'workbuddy'
    ? [process.env.WORKBUDDY_CONFIG_DIR ?? home]
    : [process.env.CODEBUDDY_CONFIG_DIR, process.env.CODEBUDDY_CN_CONFIG_DIR, home, join(homedir(), '.codebuddy-cn')]
  return [...new Set(roots.filter((root): root is string => typeof root === 'string' && root.trim() !== ''))]
    .flatMap((root) => ['config.json', 'settings.json', 'providers.json', 'auth.json']
      .flatMap((name) => readConfigSources(readJson(join(root, name)), providerId)))
}

function readConfigSources(value: unknown, providerId?: string): NewApiSource[] {
  const result: NewApiSource[] = []
  const root = providerId !== undefined && recordValue(value) !== null
    ? selectProviderNode(recordValue(value)!, providerId)
    : value
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    const record = node as Record<string, unknown>
    const baseUrl = textValue(record.baseURL ?? record.baseUrl ?? record.base_url ?? record.apiBaseUrl ?? record.api_base_url ?? record.endpoint)
    const key = textValue(record.apiKey ?? record.api_key ?? record.key) ?? (() => {
      const envName = textValue(record.apiKeyEnv ?? record.api_key_env)
      return envName === null ? null : textValue(process.env[envName])
    })()
    if (baseUrl !== null && key !== null) result.push({ baseUrl, apiKey: key })
    for (const child of Object.values(record)) walk(child, depth + 1)
  }
  walk(root, 0)
  return result
}

function selectProviderNode(value: Record<string, unknown>, providerId: string): unknown {
  const direct = value[providerId]
  if (direct !== undefined) return direct
  for (const key of ['provider', 'providers', 'providerConfigRules', 'providerRules']) {
    const raw = value[key]
    const nested = recordValue(raw)
    if (nested?.[providerId] !== undefined) return nested[providerId]
    if (Array.isArray(raw)) {
      const match = raw.find((item) => {
        const record = recordValue(item)
        return textValue(record?.providerId ?? record?.id) === providerId
      })
      if (match !== undefined) return match
    }
  }
  return value
}

function envSource(baseName: string, keyName: string): NewApiSource | null {
  const baseUrl = textValue(process.env[baseName])
  const apiKey = textValue(process.env[keyName])
  return baseUrl === null || apiKey === null ? null : { baseUrl, apiKey }
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function readJson(path: string): Record<string, unknown> | null {
  const text = readText(path)
  if (text === null) return null
  try { return recordValue(JSON.parse(text)) } catch { return null }
}

function tomlSection(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const start = source.search(new RegExp(`^\\[${escaped}\\]\\s*$`, 'mu'))
  if (start < 0) return ''
  const rest = source.slice(start)
  const next = /^\[[^\n]+\]\s*$/mu.exec(rest.slice(1))
  return next === null ? rest : rest.slice(0, next.index + 1)
}

function tomlScalar(source: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\s]+))`, 'mu').exec(source)
  return textValue(match?.[1] ?? match?.[2] ?? match?.[3])
}

/** 读取 New-API 令牌余额、到期时间与累计用量。 */
export interface NewApiReadResult {
  readonly usage: CliSubscriptionUsage
  readonly kind: 'new-api' | 'new-api-billing-compatible'
}

/** `/api/log/token` 在普通 API Key 下可返回的局部统计。官方接口最多返回最近 1000 条。 */
export interface NewApiLogSummary {
  readonly count: number
  readonly totalTokens: number
  readonly todayTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
  readonly cacheHitRate: number | null
  /** New-API 内部 quota，不带币种，不能当作费用。 */
  readonly totalQuota: number | null
  readonly todayQuota: number | null
  readonly models: readonly { readonly name: string; readonly requests: number; readonly tokens: number; readonly quota: number | null }[]
  readonly daily: readonly { readonly date: string; readonly requests: number; readonly tokens: number; readonly quota: number | null }[]
  readonly groups: readonly string[]
}

export class NewApiSubscriptionService {
  readonly timeoutMs: number
  private readonly request: FetchLike
  private readonly configuredSources: NewApiSources

  constructor(options: NewApiSubscriptionOptions = {}) {
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.configuredSources = options.sources
  }

  hasSource(adapterId: string, providerId?: string): boolean {
    return resolveNewApiSources(adapterId, providerId, this.configuredSources).length > 0
  }

  /** 判断当前来源是否由调用方显式注入；用于避免把本机其它 Agent 配置混入分类探测。 */
  hasConfiguredSource(adapterId: string, providerId?: string): boolean {
    if (this.configuredSources === undefined) return false
    return (providerId !== undefined && this.configuredSources[providerId] !== undefined)
      || this.configuredSources[adapterId] !== undefined
  }

  resolveSources(adapterId: string, providerId?: string): NewApiSource[] {
    return resolveNewApiSources(adapterId, providerId, this.configuredSources)
  }

  async read(adapterId = 'dsh', providerId?: string, source?: NewApiSource): Promise<CliSubscriptionUsage | null> {
    const result = await this.readWithKind(adapterId, providerId, source)
    return result?.usage ?? null
  }

  async readWithKind(adapterId = 'dsh', providerId?: string, source?: NewApiSource): Promise<NewApiReadResult | null> {
    const sources = source === undefined
      ? resolveNewApiSources(adapterId, providerId, this.configuredSources)
      : [source]
    for (const candidate of sources) {
      const result = await this.readSourceWithKind(candidate)
      if (result !== null) return result
    }
    return null
  }

  private async readSourceWithKind(source: NewApiSource): Promise<NewApiReadResult | null> {
    const baseUrl = sanitizeUpstreamUrl(source.baseUrl)
    const apiKey = source.apiKey.trim()
    if (baseUrl === '' || apiKey === '') return null

    const headers = {
      Authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
      Accept: 'application/json',
    }
    const apiRoot = stripVersionSuffix(baseUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      // New-API 官方路由通常注册为带斜杠的路径。先按统一协议请求无斜杠地址；
      // 某些反向代理会把它返回 404/405，而不是自动重定向，此时再补一次斜杠。
      // 认证失败不能重试成另一种结果，避免把失效 Key 误判为可用来源。
      const tokenResponse = await this.requestJsonWithTrailingSlashFallback(`${apiRoot}/api/usage/token`, headers, controller.signal)
      // 401/403 是凭据无效；不能把 billing 的错误响应误当成有效余额。
      if (tokenResponse?.status === 401 || tokenResponse?.status === 403) return null
      const tokenUsage = tokenResponse?.value ?? null

      // billing 是补充接口，即使 Token 主接口成功也要读取，用来补齐累计用量和到期时间。
      // 两个补充请求共享同一超时并行执行，避免一个慢接口阻塞另一个可用结果。
      const billingRoot = `${apiRoot}/v1`
      const [subscriptionResponse, usageResponse, logResponse, accountResponse, tokenListResponse, statusResponse] = await Promise.all([
        this.requestJson(`${billingRoot}/dashboard/billing/subscription`, headers, controller.signal),
        this.requestJson(`${billingRoot}/dashboard/billing/usage`, headers, controller.signal),
        this.requestJson(`${apiRoot}/api/log/token`, headers, controller.signal),
        // One-API 兼容部署可能不把余额放进 /api/usage/token，而是放在
        // 用户摘要或令牌列表的 quota/used_quota/remain_quota 字段中。
        this.requestJson(`${apiRoot}/api/user/self`, headers, controller.signal),
        this.requestJsonWithTrailingSlashFallback(`${apiRoot}/api/token`, headers, controller.signal),
        this.requestJson(`${apiRoot}/api/status`, headers, controller.signal),
      ])
      const tokenResult = tokenUsage === null ? null : normalizeNewApiUsage(tokenUsage, baseUrl)
      const quotaInfo = readNewApiQuotaInfo(statusResponse?.value)
      const accountResult = normalizeNewApiAccount(
        accountResponse?.value,
        baseUrl,
        tokenResult?.providerBalance?.unit ?? quotaInfo.unit,
        quotaInfo.quotaPerUnit,
      ) ?? normalizeNewApiAccount(
        tokenListResponse?.value,
        baseUrl,
        tokenResult?.providerBalance?.unit ?? quotaInfo.unit,
        quotaInfo.quotaPerUnit,
      )
      const billingResult = normalizeNewApiBilling(
        subscriptionResponse?.value ?? null,
        usageResponse?.value ?? null,
        baseUrl,
        Date.now(),
        tokenResult?.providerBalance?.used ?? null,
        tokenResult?.providerBalance?.unit ?? null,
      )
      const logSummary = summarizeNewApiLogs(logResponse?.value)
      if (tokenResult !== null) {
        const merged = mergeNewApiAccount(mergeNewApiUsage(tokenResult, billingResult), accountResult)
        return { usage: enrichNewApiLogs(merged, logSummary), kind: 'new-api' }
      }
      if (accountResult !== null) {
        const merged = mergeNewApiAccount(billingResult ?? accountResult, accountResult)
        return { usage: enrichNewApiLogs(merged, logSummary), kind: 'new-api' }
      }
      if (billingResult !== null) return { usage: enrichNewApiLogs(billingResult, logSummary), kind: 'new-api-billing-compatible' }
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async requestJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ readonly status: number; readonly value: unknown } | null> {
    try {
      const response = await this.request(url, { headers, signal })
      if (!response.ok) return { status: response.status, value: null }
      return { status: response.status, value: await response.json() as unknown }
    } catch {
      return null
    }
  }

  private async requestJsonWithTrailingSlashFallback(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ readonly status: number; readonly value: unknown } | null> {
    const first = await this.requestJson(url, headers, signal)
    if (first === null || (first.status !== 404 && first.status !== 405)) return first
    return this.requestJson(`${url}/`, headers, signal)
  }
}

/** 规范化 /api/usage/token/ 的响应。可独立用于 fixture 测试。 */
export function normalizeNewApiUsage(value: unknown, baseUrl: string, nowMs = Date.now()): CliSubscriptionUsage | null {
  const root = recordValue(value)
  const data = recordValue(root?.data) ?? root
  if (data === null) return null
  const object = textValue(data.object)
  const tokenSignatureKeys = ['unlimited_quota', 'total_available', 'total_granted', 'total_used', 'model_limits', 'balance_source', 'is_active']
  const tokenSignatureCount = tokenSignatureKeys.filter((key) => data[key] !== undefined).length
  const hasTokenSignature = object === 'token_usage' || tokenSignatureCount >= 2
  // 读取器先做协议识别，再做字段归一化；不能因为普通 JSON 恰好带 remaining 就抢走 Sub2API。
  if (object !== null && object !== 'token_usage') return null
  if (!hasTokenSignature) return null

  const unlimited = data.unlimited_quota === true
  const granted = numberValue(data.total_granted)
  const used = numberValue(data.total_used)
  // New-API 的无限额度常用 100000000 作为展示哨兵值，不能当作真实余额。
  const rawRemaining = numberValue(data.remaining)
  const rawAvailable = numberValue(data.total_available)
  const isUnlimitedSentinel = (value: number | null): boolean => value === 100000000
  // 无限额度时 total_available 通常是内部账务差值，可能为负数；只有
  // 上游明确给出的非负 remaining 才能作为用户可见余额。
  const remainingFromUpstream = unlimited
    ? rawRemaining !== null && rawRemaining >= 0 && !isUnlimitedSentinel(rawRemaining)
      ? rawRemaining
      : null
    : isUnlimitedSentinel(rawRemaining)
      ? null
      : rawRemaining ?? (isUnlimitedSentinel(rawAvailable) ? null : rawAvailable)
  const rawExpiresAt = numberValue(data.expires_at)
  const permanent = rawExpiresAt !== null && rawExpiresAt <= 0
  const expiresAt = permanent ? null : unixSeconds(data.expires_at)
  const active = typeof data.is_active === 'boolean' ? data.is_active : null
  const keyExpired = active !== null ? !active : permanent ? false : expiresAt === null ? null : expiresAt * 1_000 <= nowMs
  const total = unlimited ? null : granted ?? (used !== null && remainingFromUpstream !== null ? used + remainingFromUpstream : null)
  const remaining = remainingFromUpstream ?? (total !== null && used !== null ? Math.max(0, total - used) : null)
  if (!unlimited && used === null && remaining === null && total === null && expiresAt === null) return null
  const unit = textValue(data.unit ?? data.quota_unit ?? data.quotaUnit)
  const planName = textValue(data.plan_name ?? data.planName ?? data.name)
  const providerBalance: ProviderBalanceUsage = {
    upstreamUrl: sanitizeUpstreamUrl(baseUrl),
    currency: null,
    unit,
    balance: remaining,
    remaining,
    used,
    total,
    requests: null,
    inputTokens: null,
    outputTokens: null,
    planName,
    expiresAt,
    keyExpired,
    details: [
      { label: '余额/剩余额度', value: remaining ?? '上游未提供' },
      { label: /token/i.test(unit ?? '') ? '累计 Token' : unit === null ? '上游原始额度' : '累计用量', value: used ?? '上游未提供' },
      { label: '今日 Token', value: '上游未提供' },
      { label: '今日费用', value: '上游未提供' },
      { label: '累计费用', value: '上游未提供' },
      { label: '按模型统计', value: '上游未提供' },
      { label: '模型限制', value: formatNewApiModelLimits(data.model_limits, data.model_limits_enabled) },
      { label: '按日统计', value: '上游未提供' },
      { label: '日订阅窗口', value: '上游未提供' },
      { label: '周订阅窗口', value: '上游未提供' },
      { label: '月订阅窗口', value: '上游未提供' },
      { label: '重置时间', value: '上游未提供' },
      { label: 'API Key 到期时间', value: permanent ? '永久有效' : expiresAt === null ? '上游未提供' : new Date(expiresAt * 1000).toISOString() },
      { label: 'API Key 是否过期', value: keyExpired === null ? '上游未提供' : keyExpired ? '已过期' : '有效' },
      { label: '无限额度', value: unlimited ? '是' : '否' },
    ],
  }
  return buildUsage(baseUrl, null, providerBalance, keyExpired === true ? 'expired' : null)
}

/** 规范化旧版 OpenAI billing subscription/usage 响应。 */
export function normalizeNewApiBilling(
  subscriptionValue: unknown,
  usageValue: unknown,
  baseUrl: string,
  nowMs = Date.now(),
  tokenRawUsed: number | null = null,
  tokenUnit: string | null = null,
): CliSubscriptionUsage | null {
  const subscriptionRoot = recordValue(subscriptionValue)
  const subscription = recordValue(subscriptionRoot?.data) ?? subscriptionRoot
  if (subscription === null || textValue(subscription.object) !== 'billing_subscription') return null
  const usageRoot = recordValue(usageValue)
  const usage = recordValue(usageRoot?.data) ?? usageRoot
  const rawLimit = numberValue(subscription.hard_limit_usd ?? subscription.soft_limit_usd)
  // New-API 无限额度会在 billing 中复用 100000000 展示哨兵值。
  const limit = rawLimit === 100000000 ? null : rawLimit
  const rawUsed = usage === null ? null : numberValue(usage.total_usage)
  // 真实 New-API 响应经常省略 unit/currency，字段名本身不能证明站点展示口径。
  const hasUsdLimit = subscription.hard_limit_usd !== undefined || subscription.soft_limit_usd !== undefined
  const explicitUnit = textValue(subscription.unit ?? subscription.currency ?? usage?.unit ?? usage?.currency)
  // 独立调用时没有 Token 原始配额可供交叉验证，保留兼容 OpenAI billing
  // 的 USD 解释；读取器联动调用时若无法判定则保持单位未知。
  const fallbackUnit = hasUsdLimit && (tokenRawUsed === null || tokenUnit !== null) ? 'USD' : null
  const unit = explicitUnit ?? inferNewApiBillingUnit(rawUsed, tokenRawUsed) ?? fallbackUnit
  const used = unit === null || rawUsed === null ? null : rawUsed / 100
  const remaining = unit !== null && limit !== null && used !== null ? Math.max(0, limit - used) : null
  const rawExpiresAt = numberValue(subscription.access_until)
  const permanent = rawExpiresAt !== null && rawExpiresAt <= 0
  const expiresAt = permanent ? null : unixSeconds(subscription.access_until)
  const keyExpired = permanent ? false : expiresAt === null ? null : expiresAt * 1_000 <= nowMs
  if (limit === null && used === null && expiresAt === null) return null
  const providerBalance: ProviderBalanceUsage = {
    upstreamUrl: sanitizeUpstreamUrl(baseUrl),
    currency: unit,
    unit,
    balance: remaining,
    remaining,
    used,
    total: unit === null ? null : limit,
    requests: null,
    inputTokens: null,
    outputTokens: null,
    planName: null,
    expiresAt,
    keyExpired,
    details: [
      { label: '余额/剩余额度', value: remaining ?? '上游未提供' },
      { label: '余额上限', value: limit ?? '上游未提供' },
      { label: unit === null ? '上游原始用量' : /token/i.test(unit) ? '累计 Token' : '累计费用', value: used ?? rawUsed ?? '上游未提供' },
      { label: '上游单位', value: unit ?? '上游单位未明确' },
      { label: '今日 Token', value: '上游未提供' },
      { label: '累计 Token', value: '上游未提供' },
      { label: '按模型统计', value: '上游未提供' },
      { label: '按日统计', value: '上游未提供' },
      { label: '日订阅窗口', value: '上游未提供' },
      { label: '周订阅窗口', value: '上游未提供' },
      { label: '月订阅窗口', value: '上游未提供' },
      { label: '重置时间', value: '上游未提供' },
      { label: 'API Key 到期时间', value: permanent ? '永久有效' : expiresAt === null ? '上游未提供' : new Date(expiresAt * 1000).toISOString() },
      { label: 'API Key 是否过期', value: keyExpired === null ? '上游未提供' : keyExpired ? '已过期' : '有效' },
      { label: '无限额度', value: rawLimit === 100000000 ? '是' : '否' },
    ],
  }
  return buildUsage(baseUrl, null, providerBalance, keyExpired === true ? 'expired' : null)
}

/** 读取 One-API 兼容账户摘要中的 quota/used_quota/remain_quota。 */
function normalizeNewApiAccount(value: unknown, baseUrl: string, unit: string | null, quotaPerUnit: number | null): CliSubscriptionUsage | null {
  const root = recordValue(value)
  const rawData = root?.data ?? value
  const candidate = Array.isArray(rawData) ? recordValue(rawData[0]) : recordValue(rawData)
  if (candidate === null) return null
  // One-API 的 `quota` 表示账户剩余额度，`used_quota` 表示累计已用额度；
  // 只有显式的 `total_quota` 才是总额度，不能把 quota 当成总额再减一次。
  const rawRemaining = numberValue(candidate.remain_quota ?? candidate.remaining ?? candidate.remainQuota ?? candidate.quota)
  const rawUsed = numberValue(candidate.used_quota ?? candidate.usedQuota)
  const rawTotal = numberValue(candidate.total_quota ?? candidate.totalQuota)
  if (rawRemaining === null && rawUsed === null && rawTotal === null) return null
  const convert = (value: number | null): number | null => {
    if (value === null) return null
    if (unit?.trim().toUpperCase() === 'USD' && quotaPerUnit !== null && quotaPerUnit > 1) return value / quotaPerUnit
    return value
  }
  const remaining = convert(rawRemaining ?? (rawTotal !== null && rawUsed !== null ? Math.max(0, rawTotal - rawUsed) : null))
  const used = convert(rawUsed)
  const total = convert(rawTotal ?? (rawUsed !== null && rawRemaining !== null ? rawUsed + rawRemaining : null))
  const providerBalance: ProviderBalanceUsage = {
    upstreamUrl: sanitizeUpstreamUrl(baseUrl),
    currency: unit,
    unit,
    balance: remaining,
    remaining,
    used,
    total,
    requests: numberValue(candidate.request_count ?? candidate.requestCount),
    inputTokens: null,
    outputTokens: null,
    planName: textValue(candidate.group ?? candidate.group_name ?? candidate.groupName),
    expiresAt: unixSeconds(candidate.expires_at ?? candidate.expire_time ?? candidate.expireTime),
    keyExpired: typeof candidate.status === 'string' ? /expired|disabled|inactive/iu.test(candidate.status) : null,
    details: [
      { label: '余额/剩余额度', value: remaining ?? '上游未提供' },
      { label: unit === null ? '上游原始额度' : '累计用量', value: used ?? '上游未提供' },
      { label: '余额来源', value: 'One-API quota' },
    ],
  }
  return buildUsage(baseUrl, null, providerBalance, providerBalance.keyExpired === true ? 'expired' : null)
}

function readNewApiQuotaInfo(value: unknown): { readonly unit: string | null; readonly quotaPerUnit: number | null } {
  const root = recordValue(value)
  const data = recordValue(root?.data) ?? root
  if (data === null) return { unit: null, quotaPerUnit: null }
  const type = textValue(data.quota_display_type ?? data.quotaDisplayType ?? data.display_type ?? data.displayType)
  const perUnit = numberValue(data.quota_per_unit ?? data.quotaPerUnit)
  return { unit: type === null ? null : type.toUpperCase(), quotaPerUnit: perUnit }
}

function mergeNewApiAccount(usage: CliSubscriptionUsage, account: CliSubscriptionUsage | null): CliSubscriptionUsage {
  if (account?.providerBalance === undefined) return usage
  const current = usage.providerBalance
  if (current === undefined) return account
  const source = account.providerBalance
  const hasValue = (value: number | null): value is number => value !== null && Number.isFinite(value)
  const details = mergeProviderDetails(current.details, source.details)
  return {
    ...usage,
    providerBalance: {
      ...current,
      currency: current.currency ?? source.currency,
      unit: current.unit ?? source.unit,
      balance: hasValue(current.remaining) ? current.balance : source.balance,
      remaining: hasValue(current.remaining) ? current.remaining : source.remaining,
      used: hasValue(current.used) ? current.used : source.used,
      total: hasValue(current.total) ? current.total : source.total,
      requests: current.requests ?? source.requests,
      planName: current.planName ?? source.planName,
      expiresAt: current.expiresAt ?? source.expiresAt ?? null,
      keyExpired: current.keyExpired ?? source.keyExpired ?? null,
      details,
    },
  }
}

/**
 * New-API billing 没有返回 QuotaDisplayType。已同时拿到 Token 原始配额时，
 * 用站点固定的 QuotaPerUnit=500000 交叉验证 USD/TOKENS；CNY 或未知口径
 * 不强行猜测，交给界面显示“上游单位未明确”。
 */
function inferNewApiBillingUnit(rawUsed: number | null, tokenRawUsed: number | null): string | null {
  if (rawUsed === null || tokenRawUsed === null) return null
  const displayUsed = rawUsed / 100
  const close = (left: number, right: number): boolean => {
    const tolerance = Math.max(1e-6, Math.abs(right) * 1e-9)
    return Math.abs(left - right) <= tolerance
  }
  if (close(displayUsed, tokenRawUsed)) return 'TOKENS'
  if (close(displayUsed, tokenRawUsed / 500000)) return 'USD'
  return null
}

function mergeNewApiUsage(token: CliSubscriptionUsage, billing: CliSubscriptionUsage | null): CliSubscriptionUsage {
  const current = token.providerBalance
  if (billing?.providerBalance === undefined) {
    if (current === undefined || current.unit !== null) return token
    // billing 因 Key 过期/耗尽不可读时，Token 接口仍可能返回内部配额整数。
    // 该整数没有单位，保留在明细中追溯，不能放到顶部余额或已用金额。
    return {
      ...token,
      providerBalance: {
        ...current,
        balance: null,
        remaining: null,
        used: null,
        total: null,
      },
    }
  }
  if (current === undefined) return billing
  const tokenBalance = current
  const billingBalance = billing.providerBalance
  const { expiresAt: _tokenExpiresAt, keyExpired: _tokenKeyExpired, ...tokenBalanceBase } = tokenBalance
  // token 接口的 total_used/total_available 是 New-API 内部配额单位；只要 Token
  // 没有声明单位，就不能把它混入顶部金额，统一以 billing 的可确认字段为准。
  const preferBillingFinancials = tokenBalance.unit === null
  const merged: ProviderBalanceUsage = {
    ...tokenBalanceBase,
    balance: preferBillingFinancials
      ? billingBalance.remaining ?? tokenBalance.remaining
      : tokenBalance.remaining ?? billingBalance.remaining,
    remaining: preferBillingFinancials
      ? billingBalance.remaining ?? tokenBalance.remaining
      : tokenBalance.remaining ?? billingBalance.remaining,
    used: preferBillingFinancials
      ? billingBalance.used ?? tokenBalance.used
      : tokenBalance.used ?? billingBalance.used,
    total: preferBillingFinancials
      ? billingBalance.total ?? tokenBalance.total
      : tokenBalance.total ?? billingBalance.total,
    currency: tokenBalance.currency ?? billingBalance.currency,
    unit: tokenBalance.unit ?? billingBalance.unit,
    expiresAt: tokenBalance.expiresAt ?? billingBalance.expiresAt ?? null,
    keyExpired: tokenBalance.keyExpired ?? billingBalance.keyExpired ?? null,
    details: mergeProviderDetails(tokenBalance.details, billingBalance.details),
  }
  return { ...token, planType: token.planType ?? billing.planType, providerBalance: merged }
}

function mergeProviderDetails(
  primary: readonly ProviderBalanceUsage['details'][number][],
  supplement: readonly ProviderBalanceUsage['details'][number][],
): ProviderBalanceUsage['details'] {
  const merged = new Map(primary.map((item) => [item.label, item]))
  for (const item of supplement) {
    const previous = merged.get(item.label)
    if (
      previous === undefined
      || previous.value === '上游未提供'
      || previous.value === '上游单位未明确'
    ) {
      merged.set(item.label, item)
    }
  }
  return [...merged.values()]
}

/** 解析 `/api/log/token`，只统计消费日志；空日志不解释为零用量。 */
export function summarizeNewApiLogs(value: unknown, nowMs = Date.now()): NewApiLogSummary | null {
  const root = recordValue(value)
  if (root?.success === false) return null
  const logs = Array.isArray(value)
    ? value
    : root !== null && Array.isArray(root.data) ? root.data : null
  if (logs === null) return null

  // “今日”按 Host 所在时区计算，避免用户在 UTC+8 的站点看到 UTC 日期偏移。
  const today = calendarDate(nowMs)
  let count = 0
  let totalTokens = 0
  let todayTokens = 0
  let promptTokensTotal = 0
  let cacheCreationTokens = 0
  let cacheReadTokens = 0
  let totalQuota = 0
  let todayQuota = 0
  let hasQuota = false
  let hasTodayQuota = false
  const models = new Map<string, { requests: number; tokens: number; quota: number; hasQuota: boolean }>()
  const daily = new Map<string, { requests: number; tokens: number; quota: number; hasQuota: boolean }>()
  const groups = new Set<string>()

  for (const item of logs) {
    const log = recordValue(item)
    if (log === null) continue
    const type = numberValue(log.type)
    // 官方 LogTypeConsume=2。兼容站点有时省略 type，此时仍按消费日志解析。
    if (type !== null && type !== 2) continue
    const createdAt = unixSeconds(log.created_at ?? log.createdAt)
    if (createdAt === null) continue
    const model = textValue(log.model_name ?? log.modelName) ?? '未标注模型'
    const group = textValue(log.group)
    if (group !== null) groups.add(group)
    const promptTokens = nonNegativeLogNumber(log.prompt_tokens ?? log.promptTokens)
    const completionTokens = nonNegativeLogNumber(log.completion_tokens ?? log.completionTokens)
    const other = parseLogOther(log.other)
    const creation = nonNegativeLogNumber(other?.cache_creation_tokens ?? other?.cache_creation_input_tokens ?? other?.cacheCreationTokens)
    const read = nonNegativeLogNumber(other?.cache_read_tokens ?? other?.cache_read ?? other?.cache_tokens ?? other?.cacheReadTokens)
    const tokens = promptTokens + completionTokens + creation + read
    const quota = numberValue(log.quota)
    const date = calendarDate(createdAt * 1000)
    count += 1
    totalTokens += tokens
    promptTokensTotal += promptTokens
    cacheCreationTokens += creation
    cacheReadTokens += read
    if (quota !== null) {
      totalQuota += quota
      hasQuota = true
    }
    const modelStat = models.get(model) ?? { requests: 0, tokens: 0, quota: 0, hasQuota: false }
    modelStat.requests += 1
    modelStat.tokens += tokens
    if (quota !== null) { modelStat.quota += quota; modelStat.hasQuota = true }
    models.set(model, modelStat)
    const dayStat = daily.get(date) ?? { requests: 0, tokens: 0, quota: 0, hasQuota: false }
    dayStat.requests += 1
    dayStat.tokens += tokens
    if (quota !== null) { dayStat.quota += quota; dayStat.hasQuota = true }
    daily.set(date, dayStat)
    if (date === today) {
      todayTokens += tokens
      if (quota !== null) { todayQuota += quota; hasTodayQuota = true }
    }
  }
  if (count === 0) return null
  const cacheDenominator = promptTokensTotal + cacheReadTokens
  const cacheHitRate = cacheDenominator === 0 ? null : Number((cacheReadTokens / cacheDenominator * 100).toFixed(4))
  return {
    count,
    totalTokens,
    todayTokens,
    cacheCreationTokens,
    cacheReadTokens,
    cacheHitRate,
    totalQuota: hasQuota ? totalQuota : null,
    todayQuota: hasTodayQuota ? todayQuota : null,
    models: [...models.entries()]
      .sort((left, right) => right[1].tokens - left[1].tokens)
      .map(([name, stat]) => ({ name, requests: stat.requests, tokens: stat.tokens, quota: stat.hasQuota ? stat.quota : null })),
    daily: [...daily.entries()]
      .sort((left, right) => right[0].localeCompare(left[0]))
      .map(([date, stat]) => ({ date, requests: stat.requests, tokens: stat.tokens, quota: stat.hasQuota ? stat.quota : null })),
    groups: [...groups].sort(),
  }
}

/** 将最近日志统计附加到统一 ProviderBalanceUsage，保留 billing 的完整累计金额。 */
function enrichNewApiLogs(usage: CliSubscriptionUsage, summary: NewApiLogSummary | null): CliSubscriptionUsage {
  if (summary === null || usage.providerBalance === undefined) return usage
  const details = new Map(usage.providerBalance.details.map((item) => [item.label, item]))
  const add = (label: string, value: string | number): void => { details.set(label, { label, value }) }
  add('最近日志统计范围', `最近 ${summary.count} 条消费日志（最多 1000 条）`)
  add('今日 Token（最近日志）', summary.todayTokens)
  add('累计 Token（最近日志）', summary.totalTokens)
  add('今日费用', details.get('今日费用')?.value ?? '上游未提供')
  add('累计费用', details.get('累计费用')?.value ?? '上游未提供')
  add('今日内部额度（最近日志）', summary.todayQuota ?? '上游未提供')
  add('累计内部额度（最近日志）', summary.totalQuota ?? '上游未提供')
  add('缓存创建 Token（最近日志）', summary.cacheCreationTokens)
  add('缓存读取 Token（最近日志）', summary.cacheReadTokens)
  add('缓存命中率（最近日志）', summary.cacheHitRate === null ? '上游未提供' : `${summary.cacheHitRate}%`)
  add('分组（最近日志）', summary.groups.length === 0 ? '上游未提供' : summary.groups.join('、'))
  add('按模型统计（最近日志）', formatNewApiLogModels(summary.models))
  add('按日统计（最近日志）', formatNewApiLogDaily(summary.daily))
  return { ...usage, providerBalance: { ...usage.providerBalance, details: [...details.values()] } }
}

function formatNewApiLogModels(models: NewApiLogSummary['models']): string {
  return models.length === 0 ? '上游未提供' : models.map((item) => `${item.name}: ${item.tokens} Token / ${item.requests} 次`).join('；')
}

function formatNewApiModelLimits(value: unknown, enabled: unknown): string {
  const limits = recordValue(value)
  if (limits === null || Object.keys(limits).length === 0) return '上游未提供'
  const prefix = enabled === true ? '已启用：' : '未启用：'
  return prefix + Object.entries(limits).map(([model, allowed]) => `${model}: ${allowed === true ? '允许' : '限制'}`).join('、')
}

function formatNewApiLogDaily(daily: NewApiLogSummary['daily']): string {
  return daily.length === 0 ? '上游未提供' : daily.map((item) => `${item.date}: ${item.tokens} Token / ${item.requests} 次`).join('；')
}

function parseLogOther(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return recordValue(JSON.parse(value)) } catch { return null }
  }
  return recordValue(value)
}

function nonNegativeLogNumber(value: unknown): number {
  const parsed = numberValue(value)
  return parsed === null ? 0 : Math.max(0, parsed)
}

function calendarDate(timestampMs: number): string {
  const date = new Date(timestampMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function buildUsage(
  baseUrl: string,
  primary: CliSubscriptionWindow | null,
  providerBalance: ProviderBalanceUsage,
  rateLimitReachedType: string | null,
): CliSubscriptionUsage {
  const sanitizedBaseUrl = sanitizeUpstreamUrl(baseUrl)
  const provider: CliSubscriptionProvider = {
    id: 'new-api',
    displayName: 'New-API',
    baseUrl: sanitizedBaseUrl,
    capability: 'new-api',
    // New-API 没有统一的第三方品牌 CDN；站点自身会在根路径提供 logo.png。
    // 这里保留清洗后的上游地址，避免把 query、fragment 或凭据拼进图片地址。
    logoUrl: buildNewApiLogoUrl(sanitizedBaseUrl),
  }
  return {
    authenticated: true,
    planType: null,
    primary,
    secondary: null,
    monthly: null,
    rateLimitReachedType,
    resetCredits: null,
    capturedAt: new Date().toISOString(),
    provider,
    providerBalance,
  }
}

/** New-API 站点 Logo 的固定约定：上游根地址下的 /logo.png。 */
function buildNewApiLogoUrl(baseUrl: string): string {
  if (baseUrl === '') return ''
  try { return new URL('/logo.png', baseUrl).toString() } catch { return '' }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function unixSeconds(value: unknown): number | null {
  const parsed = numberValue(value)
  return parsed === null || parsed <= 0 ? null : Math.floor(parsed)
}

function stripVersionSuffix(value: string): string {
  return value.replace(/\/v1$/u, '')
}

function sanitizeUpstreamUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return ''
  }
}
