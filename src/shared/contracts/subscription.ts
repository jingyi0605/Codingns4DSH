/** 单个 Provider 订阅窗口的脱敏用量。百分比均为 0 到 100。 */
export interface CliSubscriptionWindow {
  readonly usedPercent: number
  readonly remainingPercent: number
  readonly windowDurationMins: number | null
  readonly resetsAt: number | null
  readonly remainingCredits?: number
  readonly totalCredits?: number
}

/** Host 读取 Provider 订阅后返回给 Client 的安全摘要。 */
export interface CliSubscriptionUsage {
  readonly authenticated: boolean
  readonly planType: string | null
  readonly primary: CliSubscriptionWindow | null
  readonly secondary: CliSubscriptionWindow | null
  readonly monthly: CliSubscriptionWindow | null
  readonly rateLimitReachedType: string | null
  readonly resetCredits: null | {
    readonly availableCount: number
    readonly credits: readonly {
      readonly id: string | null
      readonly expiresAt: number | null
      readonly title: string | null
      readonly description: string | null
    }[]
  }
  readonly capturedAt: string
  /** 第三方上游的账户余额和用量摘要；原始 API key 永不进入此结构。 */
  readonly sub2api?: Sub2ApiUsage
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
