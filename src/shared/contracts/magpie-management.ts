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
  /** Exact Magpie ledger identities represented by this aggregated DSH session. */
  readonly sessionIds?: readonly string[]
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

/** A progressively rendered dashboard snapshot. The snapshot is cumulative. */
export type MagpieDashboardStreamPart = 'cache' | 'usage' | 'quotas' | 'history' | 'logos' | 'complete' | 'sessions'

export interface MagpieDashboardStreamChunk {
  readonly part: MagpieDashboardStreamPart
  readonly dashboard: MagpieUsageDashboard
  readonly stale: boolean
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

export type MagpieUpdateState =
  | 'checking'
  | 'latest'
  | 'found'
  | 'downloading'
  | 'ready'
  | 'available'
  | 'source'
  | 'error'
  | 'blocked'

export type MagpieUpdateAvailabilityIssue =
  | 'web-api-unavailable'
  | 'cli-unavailable'
  | 'cli-version-unsupported'
  | 'update-response-invalid'
  | 'host-rpc-outdated'
  | 'feature-disabled'
  | 'host-request-failed'

export interface MagpieUpdateStatus {
  readonly state: MagpieUpdateState
  readonly current: string
  readonly latest: string | null
  readonly notes: string | null
  readonly url: string | null
  readonly stuck: string | null
  readonly error: string | null
  readonly retry: boolean
  readonly done: number | null
  readonly total: number | null
  readonly size: number | null
  readonly waiting: boolean
  readonly gaveUp: boolean
}

export interface MagpieUpdateReleaseNote {
  readonly version: string
  readonly notes: string
  readonly url: string | null
}

export interface MagpieUpdateNotes {
  readonly latest: string | null
  readonly releases: readonly MagpieUpdateReleaseNote[]
  readonly error: string | null
}

export interface MagpieUpdateSnapshot {
  readonly capturedAt: string
  readonly availabilityIssue: MagpieUpdateAvailabilityIssue | null
  readonly status: MagpieUpdateStatus | null
  readonly notes: MagpieUpdateNotes | null
}

export interface MagpieUpdateActionResult {
  readonly requested: boolean
  readonly restartExpected: boolean
  readonly status: MagpieUpdateStatus | null
}

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
  /**
   * Whether this Host may write the ID, which Magpie spells in lower-case letters, digits and
   * dashes only; false when Magpie already stored an ID in another spelling, because a save
   * under such an ID is refused by its own editor.
   */
  readonly idEditable: boolean
  readonly name: string
  /** Agent identity from Magpie's nested provider.account object, not the provider ID. */
  readonly accountAgent: string | null
  /** Magpie's built-in icon name or a `file:` asset identifier. */
  readonly icon?: string
  /** Host-fetched Magpie icon, inlined so the Client never needs Magpie's cookie. */
  readonly logoDataUrl?: string
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
  /**
   * Magpie can send this member in its vendor's fast mode (OpenAI `service_tier: 'priority'`).
   * Magpie's editor offers the switch only where this is true.
   */
  readonly canFast?: boolean
}

export interface MagpieRoutingGroupManagementRecord {
  readonly id: string
  readonly name: string
  readonly routing: string | null
  readonly stays: string | null
  readonly members: readonly MagpieRoutingGroupMember[]
  readonly usedBy: readonly string[]
  readonly patterns: readonly string[]
  /**
   * The member `routing: 'manual'` sends every request to (Magpie's `pick`); null for the
   * other policies. Without it a saved manual group would reach Magpie with an empty pick.
   */
  readonly pick: string | null
  /** True when Agent model lists show the group alone, not the models it names. */
  readonly unlists: boolean | null
  /** Members sent in their vendor's fast mode (OpenAI `service_tier: 'priority'`). */
  readonly fast: readonly string[]
  /**
   * The context window Agents are told the group takes (Magpie's `Group.Context`).
   *
   * `0` is the largest member's window, `-1` the smallest one's (so Agents compact before any
   * member would turn the conversation away), and a positive number is that many tokens.
   */
  readonly context: number
  /** The reasoning levels this group offers; empty means "the levels every member shares". */
  readonly levels: readonly string[]
  /** What those shared levels are, as Magpie works them out for the current members. */
  readonly sharedLevels: readonly string[]
  /** `'auto'` lets a classifier pick the level per turn; empty leaves it to the Agent. */
  readonly effort: string
  /** The model asked to rate a turn, needed whenever `effort` is `'auto'`. */
  readonly classifier: string | null
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
  /**
   * The ID this provider keeps afterwards. Magpie saves the rest under the ID it had and then
   * moves it, taking the routing groups and Agent configs that name its models along.
   */
  readonly newId?: string
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
  /** The member a manual group sends every request to; required while `routing: 'manual'`. */
  readonly pick?: string
  /** Whether Agent model lists show the group alone. */
  readonly unlists?: boolean
  /** Members sent in their vendor's fast mode; filtered to the group's models on save. */
  readonly fast?: readonly string[]
  /** `0` for the largest member's window, `-1` for the smallest, or that many tokens. */
  readonly context?: number
  /** The levels to offer; an empty list means the levels every member shares. */
  readonly levels?: readonly string[]
  /** `'auto'` picks the level per turn, which needs `classifier`. */
  readonly effort?: string
  /** The model that rates a turn; required while `effort` is `'auto'`. */
  readonly classifier?: string
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

/**
 * 本机 Magpie 的安装探测结果。
 *
 * 探测只能发生在 Host（Node）进程：浏览器读取不到本机 PATH、Windows 注册表和安装目录。
 * 设置页先读这份结果，再决定 Magpie 管理开关能否启用；Host 写入前也会重新校验。
 */
export interface MagpieInstallDetection {
  /** 是否找到可执行的 Magpie 入口（含 Windows 的 `.cmd`/`.bat` 包装脚本）。 */
  readonly installed: boolean
  /** `process.platform` 归一化后的平台名。 */
  readonly platform: MagpieHostPlatform
  /** 入口来源；未安装时为 null。 */
  readonly source: MagpieInstallSource | null
  /** 解析到的入口绝对路径；未安装或探测失败时为 null。 */
  readonly command: string | null
  /** `magpie --version` 归一化后的版本号；未成功运行时为 null。 */
  readonly version: string | null
  /** 入口存在但无法运行、版本无法识别时的安全原因；成功或未安装时为 null。 */
  readonly reason: MagpieDetectionFailure | null
  /** 探测完成时间，供界面显示结果新鲜度。 */
  readonly checkedAt: string
}

export type MagpieHostPlatform = 'macos' | 'windows' | 'linux'
export type MagpieInstallSource = 'path' | 'custom' | 'common-location'
export type MagpieDetectionFailure = 'launch' | 'timeout' | 'version'

/**
 * 设置页“重新检测”提交的可选入口。
 *
 * 只接受绝对路径文本：不接受命令参数、shell 片段或裸命令名，避免把用户输入
 * 变成任意命令执行入口。
 */
export interface MagpieDetectionRequest {
  /** 用户手动填写的入口绝对路径；为空或缺省时只做自动探测。 */
  readonly commandPath?: string
}
