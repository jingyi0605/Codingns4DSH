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
