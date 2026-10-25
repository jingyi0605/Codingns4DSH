/** 单个 Provider 订阅窗口的脱敏用量。百分比均为 0 到 100。 */
export interface CliSubscriptionWindow {
  readonly usedPercent: number
  readonly remainingPercent: number
  readonly windowDurationMins: number | null
  readonly resetsAt: number | null
  readonly remainingCredits?: number
  readonly totalCredits?: number
}

/** Codex 账户消费点数（credits）；与重置次数相互独立，余额由上游以十进制字符串返回。 */
export interface CliSubscriptionCredits {
  readonly hasCredits: boolean
  readonly unlimited: boolean
  readonly balance: string | null
}

/** 配额窗口类型；客户端据此取本地化文案，不依赖上游英文标签。 */
export type CliSubscriptionQuotaWindowKind = 'five-hour' | 'weekly' | 'monthly' | 'other'

/** 一个配额分组里的窗口。 */
export interface CliSubscriptionGroupWindow {
  readonly kind: CliSubscriptionQuotaWindowKind
  /** 上游展示名；`kind` 为 `other` 时客户端回退到它。 */
  readonly label: string | null
  readonly window: CliSubscriptionWindow
}

/**
 * 一组共享额度的模型。
 *
 * Antigravity 把 Gemini 与 Claude/GPT 分成两组互相独立的额度，每组各有 5 小时与周窗口；
 * `primary`/`secondary` 只表达“当前会话模型所属组”，完整分组走这里。
 */
export interface CliSubscriptionGroup {
  /** 稳定分组 id（`gemini` / `third-party` / 上游名 slug），供客户端本地化。 */
  readonly id: string
  readonly displayName: string
  readonly windows: readonly CliSubscriptionGroupWindow[]
}

/** 消耗一次订阅重置后的稳定结果，与 Codex app-server 的 outcome 对齐。 */
export type CliSubscriptionResetOutcome = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit'

/** Host 执行订阅重置后返回给 Client 的安全摘要。 */
export interface CliSubscriptionResetResult {
  readonly outcome: CliSubscriptionResetOutcome
}

/** Host 读取 Provider 订阅后返回给 Client 的安全摘要。 */
export interface CliSubscriptionUsage {
  readonly authenticated: boolean
  readonly planType: string | null
  /**
   * 账号实际持有的付费档位（如 Antigravity 的 `paidTier = Google AI Pro`）。
   * 与 `planType`（后端生效档位）不同时说明订阅权益没有映射到该 Agent 的额度上。
   */
  readonly paidPlanType?: string | null
  /** 上游可确认的账号标识（如 Antigravity 的登录邮箱）；读取器拿不到时为 undefined。 */
  readonly accountName?: string | null
  readonly primary: CliSubscriptionWindow | null
  readonly secondary: CliSubscriptionWindow | null
  readonly monthly: CliSubscriptionWindow | null
  /** 按模型分组的多窗口额度；读取器只能给出单窗口时保持 undefined。 */
  readonly groups?: readonly CliSubscriptionGroup[]
  readonly rateLimitReachedType: string | null
  /** 官方 Codex 的可囤积重置券；明细行的 expiresAt 为 Unix 秒。读取器不支持时为 null。 */
  readonly resetCredits: null | {
    readonly availableCount: number
    readonly credits: readonly {
      readonly id: string | null
      readonly expiresAt: number | null
      readonly title: string | null
      readonly description: string | null
    }[]
  }
  /** 官方 Codex 账户点数（credits）余额；与重置次数相互独立。 */
  readonly credits?: CliSubscriptionCredits | null
  readonly capturedAt: string
  /** 统一模型提供商摘要；同一提供商可被多个 Agent 复用。 */
  readonly provider?: CliSubscriptionProvider
  /** 第三方上游的账户余额和用量摘要；原始 API key 永不进入此结构。 */
  readonly sub2api?: Sub2ApiUsage
  /** 官方 DeepSeek API 的账户余额摘要；原始 API key 永不进入此结构。 */
  readonly deepseek?: DeepseekUsage
  /** 其他官方模型提供商的账户余额/用量摘要；原始 API key 永不进入此结构。 */
  readonly providerBalance?: ProviderBalanceUsage
}

/** Magpie 汇总用量窗口中的请求总数与 Token/费用统计。 */
export interface MagpieUsageTotals {
  readonly calls: number | null
  readonly errors: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly costUsd: number | null
}

/** Magpie 里与当前 Agent 会话完全匹配的用量摘要。 */
export interface MagpieSessionUsage extends MagpieUsageTotals {
  readonly id: string
  readonly agent: string
}

export interface MagpieRouteAttempt {
  readonly model: string | null
  readonly failed: boolean
}

/** 从 Magpie 路由响应中筛出的安全字段，不包含请求正文或原始错误。 */
export interface MagpieRouteUsage {
  readonly asked: string | null
  readonly group: string | null
  readonly rule: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly tries: readonly MagpieRouteAttempt[]
  readonly done: boolean | null
  readonly status: string | null
  readonly served: string | null
  /** Magpie's trace ID and timestamp; request-ledger fallbacks also provide these. */
  readonly routeId?: number | null
  readonly time?: string | null
  /** Account label recorded for the provider that served this request. */
  readonly providerAccount?: string | null
}

/** A quota window returned by Magpie's public gateway quota endpoint. */
export interface MagpieQuotaWindow {
  readonly name: string
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
  readonly resetsAt: string | null
  readonly display: string | null
  readonly amount: number | null
  readonly limit: number | null
  readonly unit: string | null
  readonly holdsWhy: string | null
  /** 窗口开始时间（`startsAt`）；`runsOut` 推算需要日进度时作为基线。 */
  readonly startsAt: string | null
  /** 上游报告的单位数余量；`unit` 说明单位（credits、tokens 等）。 */
  readonly runsOut: number | null
  /** 上游给出的"按当前速度耗尽"时间点；只做展示，不参与结算。 */
  readonly runsOutAt: string | null
}

/**
 * Magpie 每日签到结果（WorkBuddy、Trae、MiniMax 等厂商）。
 *
 * `outcome` 保留上游枚举原文，客户端只对已知值给出本地化文案；
 * 未知值一律按"未签到"处理，避免把失败说成成功。
 */
export interface MagpieQuotaCheckin {
  readonly day: string | null
  readonly at: string | null
  /** `claimed`/`done` 表示今日已领取，其余为厂商私有状态。 */
  readonly outcome: string | null
  readonly credit: number | null
  /** 连续签到天数；上游未提供时为 null。 */
  readonly streak: number | null
}

/** 一个账号的额度快照；同 `provider` 的多条记录代表该厂商的多个账号。 */
export interface MagpieQuota {
  readonly provider: string
  readonly name: string
  /** Magpie's built-in icon name or a `file:` asset identifier. */
  readonly icon?: string
  /** Host-fetched Magpie icon, inlined so the Client never needs Magpie's cookie. */
  readonly logoDataUrl?: string
  readonly kind: string | null
  readonly user: string | null
  readonly plan: string | null
  readonly alias: string | null
  readonly balance: string | null
  readonly readAt: string | null
  readonly windows: readonly MagpieQuotaWindow[]
  /** 账号在 Magpie 侧的当前账号；多个账号时用于标识"正在使用"。 */
  readonly active?: boolean
  /** 上游读取失败的安全原因摘要（如 `Unauthorized`）；成功时为 null。 */
  readonly error?: string | null
  /** 该厂商支持每日签到；为 true 时 `checkin` 才有意义。 */
  readonly checkins?: boolean
  readonly checkin?: MagpieQuotaCheckin | null
  /** 按日统计的额度消耗（`used` 为当日已用单位数），用于画每日用量。 */
  readonly daily?: {
    readonly since: string | null
    readonly days: readonly { readonly day: string; readonly used: number | null }[]
  }
  /** 套餐到期时间（`until`），以及是否为自动续费（`renew`）。 */
  readonly until?: string | null
  readonly renew?: string | null
  /**
   * 可用的重置卡次数。
   *
   * `byWindow` 为真时厂商按窗口分别计数（GLM Coding 团队/个人套餐），此时用
   * `fiveHour` / `weekly` 而不是 `count`；`each` 给出每张卡各自的到期时间，
   * `until` 是最早到期的那张。`count` 缺失不等于 0：上游省略该对象时无法确认数量。
   */
  readonly resets?: MagpieQuotaReset | null
  /** 账号点数余额（Codex 的 credits）；与窗口额度相互独立。 */
  readonly credits?: string | null
}

/** 一个账号可用的重置卡。 */
export interface MagpieQuotaReset {
  readonly count: number | null
  readonly until: string | null
  readonly each: readonly { readonly window: string | null; readonly until: string | null }[]
  readonly byWindow: boolean
  readonly fiveHour: number | null
  readonly weekly: number | null
}

export type MagpieQuotaStatus = 'available' | 'unavailable' | 'provider-unavailable'

export type MagpieUsageRouteStatus = 'available' | 'no-route' | 'not-requested' | 'unavailable' | 'session-unavailable'

/** Magpie 只读快照。汇总和单个会话分开，不能把网关总量说成会话用量。 */
export interface MagpieUsageSnapshot {
  /** Exact Magpie Agent ID returned by its verified model catalog. */
  readonly agent: string
  readonly modelId: string
  readonly capturedAt: string
  readonly usageStatus: 'available' | 'unavailable'
  /** Gateway-wide usage for today. */
  readonly aggregate: MagpieUsageTotals | null
  readonly sessionId: string | null
  /** Identity used by the request ledger; may differ from the displayed/provider session ID. */
  readonly requestSessionId?: string
  /** DSH's human-readable title when the matched session is known. */
  readonly sessionName?: string
  /** Matched session usage; all dates unless sessionPeriod explicitly says today. */
  readonly session: MagpieSessionUsage | null
  readonly sessionPeriod?: 'today'
  readonly routeStatus: MagpieUsageRouteStatus
  readonly route: MagpieRouteUsage | null
  /** Provider identified from the exact route, or from a direct provider/model selection. */
  readonly upstreamProvider: string | null
  /** Every upstream provider observed in this session's request records. */
  readonly upstreamProviders?: readonly string[]
  readonly quotaStatus: MagpieQuotaStatus
  /** Only quotas belonging to the identified upstream provider are exposed. */
  readonly quotas: readonly MagpieQuota[]
  /**
   * 与本会话同一上游厂商、但本会话没用过的其它账号。
   *
   * 单独下发而不是并进 `quotas`：它们只用于按厂商分组展示，不能参与本会话余量判断，
   * 也不能被当成"这个会话正在使用的账号"。
   */
  readonly providerAccounts?: readonly MagpieQuota[]
}

/** 新版 Host 的用量响应；Client 仍兼容旧版直接返回订阅对象的 Host。 */
export interface CliSubscriptionSnapshot {
  readonly providerUsage: CliSubscriptionUsage | null
  readonly magpie: MagpieUsageSnapshot | null
}

/** 订阅归属的模型提供商，不包含任何凭据。 */
export interface CliSubscriptionProvider {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string
  readonly capability: 'official-balance' | 'official-usage' | 'subscription-window' | 'sub2api' | 'new-api' | 'unsupported'
  readonly logoUrl: string
  readonly logoDataUrl?: string
}

/** 官方 DeepSeek API 返回的单个币种余额。金额单位由 currency 指定。 */
export interface DeepseekBalance {
  readonly currency: string
  readonly totalBalance: number
  readonly grantedBalance: number
  readonly toppedUpBalance: number
}

/** 官方 DeepSeek API 的安全余额摘要。 */
export interface DeepseekUsage {
  readonly upstreamUrl: string
  readonly isAvailable: boolean | null
  readonly balances: readonly DeepseekBalance[]
}

/** 官方提供商账户余额或 Coding Plan 余量的统一安全摘要。 */
export interface ProviderBalanceUsage {
  readonly r4?: R4Usage
  readonly upstreamUrl: string
  readonly currency: string | null
  readonly unit: string | null
  readonly balance: number | null
  readonly remaining: number | null
  readonly used: number | null
  readonly total: number | null
  readonly requests: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly planName: string | null
  /** API Key 或令牌的到期时间；普通 API Key 未提供时保持 null。 */
  readonly expiresAt?: number | null
  /** 上游明确返回的 Key 状态；无法确认时保持 null。 */
  readonly keyExpired?: boolean | null
  readonly details: readonly {
    readonly label: string
    readonly value: string | number
  }[]
}

/** R4 账户账本与 Key 终身计数器分开保存；null 表示未提供。 */
export interface R4UsagePoint {
  readonly requests: number | null
  readonly cost: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheCreationTokens: number | null
}

export interface R4Usage {
  readonly packageBalance: number | null
  readonly walletBalance: number | null
  readonly packageExpiresAt: string | null
  readonly key: null | {
    readonly unlimited: boolean
    readonly limit: number | null
    readonly spent: number | null
    readonly held: number | null
    readonly remaining: number | null
  }
  readonly today: R4UsagePoint | null
  readonly daily: readonly (R4UsagePoint & { readonly date: string })[]
  readonly models: readonly { readonly name: string; readonly requests: number | null; readonly cost: number | null }[]
}

export interface Sub2ApiUsagePoint {
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
  readonly totalTokens: number
  readonly cost: number
  readonly actualCost: number
  readonly cacheHitRate: number
}

export interface Sub2ApiDailyUsage extends Sub2ApiUsagePoint {
  readonly date: string
}

export interface Sub2ApiModelUsage extends Sub2ApiUsagePoint {
  readonly model: string
  readonly accountCost: number
}

export interface Sub2ApiUsage {
  readonly upstreamType: 'Sub2API' | 'OneAPI' | '其他'
  /** 已移除 query、fragment、userinfo 的可公开上游地址。 */
  readonly upstreamUrl: string
  /** Host 侧按需获取并内联的图标；失败时为空字符串。 */
  readonly logoDataUrl?: string
  readonly logoUrl: string
  readonly balance: number
  readonly remaining: number
  readonly unit: string
  readonly planName: string | null
  readonly mode: string | null
  readonly today: Sub2ApiUsagePoint
  readonly total: Sub2ApiUsagePoint
  readonly daily: readonly Sub2ApiDailyUsage[]
  readonly models: readonly Sub2ApiModelUsage[]
  readonly rpm: number | null
  readonly tpm: number | null
  readonly averageDurationMs: number | null
}

/**
 * 判断上一次用量查询结果是否仍在可复用窗口内。
 *
 * 间隔 ≤ 0 表示不自动查询：此时不复用旧结果，每次挂载都重新查询一次。
 * 该判定由 Client 侧底部用量入口使用，避免每次进入会话都请求上游。
 */
export function isSubscriptionUsageFresh(capturedAtMs: number, nowMs: number, refreshIntervalMins: number): boolean {
  if (!Number.isFinite(refreshIntervalMins) || refreshIntervalMins <= 0) return false
  if (!Number.isFinite(capturedAtMs) || !Number.isFinite(nowMs)) return false
  const age = nowMs - capturedAtMs
  return age >= 0 && age < refreshIntervalMins * 60_000
}
