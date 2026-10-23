export type MagpieDashboardPeriod = 'today' | 'week' | 'month' | 'all'

export type MagpieDashboardAvailabilityIssue =
  | 'web-api-unavailable'
  | 'cli-unavailable'
  | 'cli-version-unsupported'
  | 'model-catalog-unavailable'
  | 'host-rpc-outdated'
  | 'feature-disabled'
  | 'host-request-failed'

/** Nullable because Magpie omits metrics it cannot price or measure. */
export interface MagpieUsageMetrics {
  readonly calls: number | null
  readonly errors: number | null
  readonly retried: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly reasoningTokens: number | null
  readonly cost: number | null
  readonly unpriced: number | null
  readonly credits: number | null
  readonly credited: number | null
  readonly timed: number | null
  readonly ttftMs: number | null
  readonly decodeMs: number | null
  readonly decodeTokens: number | null
  readonly decodeCount: number | null
}

export interface MagpieUsageGroup extends MagpieUsageMetrics {
  readonly id: string
  readonly name: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly account: string | null
  readonly agent: string | null
}

export interface MagpieUsageSeriesPoint extends MagpieUsageMetrics {
  readonly time: string | null
  readonly label: string | null
}

export interface MagpieUsageSession extends MagpieUsageMetrics {
  readonly id: string
  readonly agent: string
  /** DSH's human-readable title when this Magpie session was matched exactly. */
  readonly dshSessionName?: string
}

export interface MagpieDashboardQuotaWindow {
  readonly name: string
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
  readonly resetsAt: string | null
  readonly display: string | null
  readonly amount: number | null
  readonly limit: number | null
  readonly unit: string | null
  readonly holdsWhy: string | null
  readonly runsOutAt: string | null
  readonly runsOut: number | null
}

export interface MagpieDashboardQuota {
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
  readonly windows: readonly MagpieDashboardQuotaWindow[]
  /** 按日消耗；`since` 是统计起点，上游不提供时为 null。 */
  readonly daily: {
    readonly since: string | null
    readonly days: readonly { readonly day: string; readonly used: number | null }[]
  }
  /** 上游读取失败的安全原因摘要（如 `Unauthorized`）；成功时为 null。 */
  readonly error?: string | null
  /** 签到信息与每日消耗；仅部分厂商提供。 */
  readonly checkins?: boolean
  readonly checkin?: {
    readonly day: string | null
    readonly at: string | null
    readonly outcome: string | null
    readonly credit: number | null
    readonly streak: number | null
  } | null
  /** 套餐到期时间与自动续费状态。 */
  readonly until?: string | null
  readonly renew?: string | null
}

export interface MagpieQuotaHistoryLine {
  readonly name: string
  readonly points: readonly {
    readonly at: string
    readonly left: number | null
    readonly start: string | null
    readonly resetsAt: string | null
  }[]
}

export interface MagpieQuotaHistory {
  readonly provider: string
  readonly user: string | null
  readonly lines: readonly MagpieQuotaHistoryLine[]
}

export interface MagpieUsageDashboard {
  readonly period: MagpieDashboardPeriod
  readonly capturedAt: string
  readonly availabilityIssue: MagpieDashboardAvailabilityIssue | null
  readonly usageStatus: 'available' | 'unavailable'
  readonly aggregate: MagpieUsageMetrics | null
  readonly series: readonly MagpieUsageSeriesPoint[]
  readonly agents: readonly MagpieUsageGroup[]
  readonly providers: readonly MagpieUsageGroup[]
  readonly models: readonly MagpieUsageGroup[]
  readonly accounts: readonly MagpieUsageGroup[]
  readonly sessions: readonly MagpieUsageSession[]
  readonly sessionCount: number | null
  readonly quotaStatus: 'available' | 'unavailable'
  readonly quotas: readonly MagpieDashboardQuota[]
  readonly quotaHistoryStatus: 'available' | 'unavailable'
  readonly quotaHistory: readonly MagpieQuotaHistory[]
}

export interface MagpieUsageRequest {
  readonly routeId: number | null
  readonly time: string | null
  readonly agent: string | null
  readonly provider: string | null
  readonly account: string | null
  readonly requestedModel: string | null
  readonly servedModel: string | null
  readonly group: string | null
  readonly effort: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly reasoningTokens: number | null
  readonly cost: number | null
  readonly priced: boolean | null
  readonly status: string | null
  readonly durationMs: number | null
  readonly ttftMs: number | null
  readonly firstTextMs: number | null
  readonly firstReasoningMs: number | null
  readonly flowMs: number | null
  readonly sessionId: string | null
}

export interface MagpieUsageRequestPage {
  readonly period: MagpieDashboardPeriod
  readonly offset: number
  readonly limit: number
  readonly total: number | null
  readonly hasMore: boolean
  readonly sessionId: string | null
  readonly sessionAgent: string | null
  readonly items: readonly MagpieUsageRequest[]
}

export type MagpieManagementAvailabilityIssue =
  | 'web-api-unavailable'
  | 'cli-unavailable'
  | 'cli-version-unsupported'
  | 'providers-unavailable'
  | 'groups-unavailable'
  | 'accounts-unavailable'
  | 'host-rpc-outdated'
  | 'feature-disabled'
  | 'host-request-failed'

export type MagpieProviderState = 'on' | 'off' | 'unknown'

export interface MagpieProviderModel {
  readonly id: string
  readonly name: string | null
  readonly exposed: boolean
}

export type MagpieProviderEndpointField = 'chat' | 'responses' | 'anthropic' | 'gemini'

export interface MagpieProviderEndpoint {
  readonly field: MagpieProviderEndpointField
  readonly url: string
  readonly editable: boolean
}

export interface MagpieProviderManagementRecord {
  readonly id: string
  readonly name: string
  /** Agent identity from Magpie's nested provider.account object, not the provider ID. */
  readonly accountAgent: string | null
  readonly preset: string | null
  readonly protocol: string | null
  readonly host: string | null
  readonly website: string | null
  readonly state: MagpieProviderState
  readonly account: string | null
  readonly keyMasked: string | null
  readonly endpoints: readonly MagpieProviderEndpoint[]
  readonly models: readonly MagpieProviderModel[]
  /** False when Magpie returned model rows this Host cannot safely round-trip. */
  readonly modelsEditable: boolean
  readonly modelCount: number | null
  readonly exposedModelCount: number | null
  readonly fallback: readonly string[]
  readonly routing: string | null
  readonly affinity: string | null
  readonly maxConcurrency: number | null
}

export interface MagpieAccountWindow {
  readonly name: string
  readonly used: number | null
  readonly remaining: number | null
  readonly resetsAt: string | null
  readonly display: string | null
}

export interface MagpieAccountManagementRecord {
  readonly agent: string
  readonly user: string
  readonly alias: string | null
  readonly plan: string | null
  readonly active: boolean | null
  /** Whether the account is currently eligible for routing or failover. */
  readonly on: boolean | null
  readonly balance: string | null
  readonly windows: readonly MagpieAccountWindow[]
  readonly asOf: string | null
  readonly readAt: string | null
}

export interface MagpieRoutingGroupMember {
  readonly id: string
  readonly provider: string | null
  readonly name: string | null
  readonly model: string | null
  readonly on: boolean | null
  readonly ready: boolean | null
  readonly byPattern: boolean
}

export interface MagpieRoutingGroupManagementRecord {
  readonly id: string
  readonly name: string
  readonly routing: string | null
  readonly stays: string | null
  readonly members: readonly MagpieRoutingGroupMember[]
  readonly usedBy: readonly string[]
  readonly patterns: readonly string[]
}

export interface MagpieManagementSnapshot {
  readonly capturedAt: string
  readonly availabilityIssue: MagpieManagementAvailabilityIssue | null
  readonly providerStatus: 'available' | 'partial' | 'unavailable'
  readonly providers: readonly MagpieProviderManagementRecord[]
  readonly accountStatus: 'available' | 'unavailable'
  readonly accounts: readonly MagpieAccountManagementRecord[]
  readonly accountApiStatus: 'available' | 'unavailable'
  readonly groupStatus: 'available' | 'unavailable'
  readonly groups: readonly MagpieRoutingGroupManagementRecord[]
}

export interface MagpieProviderManagementUpdate {
  readonly id: string
  readonly name?: string
  readonly endpointField?: MagpieProviderEndpointField
  readonly endpointUrl?: string
  readonly models?: readonly string[]
  readonly on?: boolean
}

export interface MagpieRoutingGroupManagementUpdate {
  readonly id: string
  readonly name?: string
  readonly models?: readonly string[]
  readonly routing?: string
  readonly stays?: string
}

export interface MagpieAccountManagementUpdate {
  readonly agent: string
  readonly user: string
  readonly on: boolean
}

export interface MagpieManagementMutationResult {
  readonly changed: 'provider' | 'group' | 'account'
  readonly id: string
  readonly snapshot: MagpieManagementSnapshot
}
