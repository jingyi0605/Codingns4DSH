import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { CliSubscriptionUsage, ProviderBalanceUsage } from '../../shared/contracts/subscription.js'
import { createConnection } from 'node:net'

type FetchLike = typeof fetch
type CodeBuddyRegion = 'cn' | 'international'

/** CodeBuddy 计费接口读取器选项。所有凭据只在 Host 内使用，不会进入返回值。 */
export interface CodeBuddySubscriptionOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  /** 测试或隔离运行时使用的 HOME；默认使用当前进程 HOME。 */
  readonly homeDirectory?: string
  /** 直接指定认证文件，生产环境一般不需要。 */
  readonly authFiles?: readonly string[]
  /** 覆盖计费 API origin，便于 fixture 和私有部署测试。 */
  readonly origins?: Partial<Record<CodeBuddyRegion, readonly string[]>>
}

interface CodeBuddyAuth {
  readonly accessToken: string
  readonly uid: string
  readonly domain: string
  readonly enterpriseId: string | null
}

export interface CodeBuddyResource {
  readonly packageCode: string
  readonly packageName: string
  readonly total: number | null
  readonly used: number | null
  readonly remaining: number | null
  readonly expiresAt: number | null
  readonly refreshAt: number | null
}

export interface CodeBuddySummary {
  readonly planCode: string
  readonly planName: string
  readonly isPaid: boolean | null
  readonly resources: readonly CodeBuddyResource[]
}

const INTERNAL_DOMAINS = new Set([
  'copilot.tencent.com', 'staging-copilot.tencent.com', 'www.codebuddy.cn', 'staging.codebuddy.cn',
  'www.workbuddy.cn', 'staging.workbuddy.cn',
])
const EXTERNAL_DOMAINS = new Set([
  'www.codebuddy.ai', 'codebuddy.ai', 'staging-codebuddy.tencent.com',
  'www.workbuddy.ai', 'workbuddy.ai', 'staging.workbuddy.ai',
])
const DEFAULT_ORIGINS: Record<CodeBuddyRegion, readonly string[]> = {
  cn: ['https://copilot.tencent.com', 'https://www.codebuddy.cn'],
  international: ['https://www.codebuddy.ai', 'https://staging-codebuddy.tencent.com'],
}
/** WorkBuddy 使用独立产品域名，不能回退到 CodeBuddy 计费域名。 */
const WORKBUDDY_ORIGINS: Record<CodeBuddyRegion, readonly string[]> = {
  cn: ['https://www.workbuddy.cn'],
  international: ['https://www.workbuddy.ai'],
}
const ACCOUNT_STATUS_VALID = 0
const ACCOUNT_STATUS_USED_UP = 3

/**
 * 读取 CodeBuddy/WorkBuddy 官方计费摘要。
 *
 * ACP 的 `usage_update` 只描述当前会话 token 消耗，不能代替套餐余额。
 * 这里直接调用官方只读 billing API，并且把接口不稳定视为“暂无用量”，不影响会话。
 */
export class CodeBuddySubscriptionService {
  private readonly request: FetchLike
  readonly timeoutMs: number
  private readonly homeDirectory: string
  private readonly authFiles: readonly string[] | undefined
  private readonly origins: Partial<Record<CodeBuddyRegion, readonly string[]>>

  constructor(options: CodeBuddySubscriptionOptions = {}) {
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.homeDirectory = options.homeDirectory?.trim() || process.env.HOME?.trim() || homedir()
    this.authFiles = options.authFiles
    this.origins = options.origins ?? {}
  }

  async read(adapterId: string): Promise<CliSubscriptionUsage | null> {
    if (adapterId === 'workbuddy' && this.authFiles === undefined) {
      const viaIpc = await this.readWorkBuddyViaIpc()
      if (viaIpc !== null) return viaIpc
    }
    return this.readWithRequest(adapterId, this.request)
  }

  private async readWithRequest(adapterId: string, request: FetchLike, overrideAuth?: CodeBuddyAuth): Promise<CliSubscriptionUsage | null> {
    const authFiles = this.authFiles ?? defaultAuthFiles(this.homeDirectory, adapterId)
    const regions = overrideAuth === undefined
      ? orderRegions(regionsForAdapter(adapterId), authFiles)
      : regionsForAdapter(adapterId).filter((region) => matchesRegion(overrideAuth.domain, region))
    if (regions.length === 0) return null
    for (const region of regions) {
      const auth = overrideAuth ?? readCodeBuddyAuth(authFiles, region)
      if (auth === null) continue
      const defaultOrigins = adapterId === 'workbuddy' ? WORKBUDDY_ORIGINS : DEFAULT_ORIGINS
      const origins = uniqueOrigins(this.origins[region] ?? defaultOrigins[region])
      for (const origin of origins) {
        if (auth.enterpriseId !== null) {
          const enterprise = normalizeEnterpriseUsage(await this.post(origin, '/billing/meter/get-enterprise-user-usage', auth, region, {}, adapterId, request))
          if (enterprise !== null) return buildUsage(origin, enterprise.summary, enterprise.resources, adapterId)
        }
        const summaryResponse = await this.post(origin, '/billing/meter/get-user-resource-summary', auth, region, {}, adapterId, request)
        const summary = normalizeSummary(summaryResponse)
        if (summary === null) continue
        const packageCodes = summary.resources.map((resource) => resource.packageCode).filter(Boolean)
        const [paid, free] = await Promise.all([
          this.post(origin, '/billing/meter/get-user-resource-paid-packages', auth, region, {
            PageNumber: 1,
            PageSize: 200,
            PackageCodes: packageCodes,
            Status: [ACCOUNT_STATUS_VALID, ACCOUNT_STATUS_USED_UP],
            NeedRenewInfo: true,
          }, adapterId, request),
          this.post(origin, '/billing/meter/get-user-resource-free-packages', auth, region, {
            PageNumber: 1,
            PageSize: 200,
            PackageCodes: packageCodes,
            Status: [ACCOUNT_STATUS_VALID, ACCOUNT_STATUS_USED_UP],
            ...slicePeriodRange(),
          }, adapterId, request),
        ])
        const resources = mergeResources(summary.resources, normalizePackageAccounts(paid), normalizePackageAccounts(free))
        return buildUsage(origin, summary, resources, adapterId)
      }
    }
    return null
  }

  /** WorkBuddy 的认证文件是字段加密格式，必须让 daemon 通过 WBIPC 注入认证头。 */
  private async readWorkBuddyViaIpc(): Promise<CliSubscriptionUsage | null> {
    const authFiles = defaultAuthFiles(this.homeDirectory, 'workbuddy')
    const auth = readWorkBuddyAuthMetadata(authFiles)
    if (auth === null) return null
    const ipc = await connectWorkBuddyRequestPipe(this.homeDirectory)
    if (ipc === null) return null
    try {
      return await this.readWithRequest('workbuddy', ipc.fetch, auth)
    } finally {
      ipc.close()
    }
  }

  private async post(
    origin: string,
    path: string,
    auth: CodeBuddyAuth,
    region: CodeBuddyRegion,
    body: Record<string, unknown>,
    adapterId: string,
    request: FetchLike,
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const normalizedOrigin = normalizeOrigin(origin)
    if (normalizedOrigin === '') {
      clearTimeout(timer)
      return null
    }
    try {
      const response = await request(`${normalizedOrigin}${path}`, {
        method: 'POST',
        headers: requestHeaders(normalizedOrigin, auth, region, adapterId),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) return null
      return recordValue(await response.json())
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function regionsForAdapter(adapterId: string): readonly CodeBuddyRegion[] {
  // 兼容旧版持久化调用；统一适配器只向外暴露 codebuddy。
  if (adapterId === 'codebuddy-cn') adapterId = 'codebuddy'
  // WorkBuddy 的国内版和国际版共用一个适配器，按认证文件 domain 选择计费区域。
  if (adapterId === 'codebuddy' || adapterId === 'workbuddy') return ['cn', 'international']
  return []
}

function defaultAuthFiles(home: string, adapterId: string): readonly string[] {
  if (adapterId === 'workbuddy') return [workBuddyAuthFileForHome(home)]
  return [
    authFileForHome(home),
    authFileForHome(join(home, '.codebuddy-cn-home')),
    authFileForHome(join(home, '.codebuddy-international-home')),
    authFileForHome(join(home, '.workbuddy')),
  ]
}

function workBuddyAuthFileForHome(home: string): string {
  if (process.platform === 'win32') return join(home, 'AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info')
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info')
  return join(home, '.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info')
}

function readWorkBuddyAuthMetadata(files: readonly string[]): CodeBuddyAuth | null {
  for (const path of files) {
    try {
      const value = recordValue(JSON.parse(readFileSync(path, 'utf8')))
      if (value === null) continue
      const auth = recordValue(value.auth)
      const account = recordValue(value.account)
      const uid = textValue(account?.uid ?? value.uid)
      const domain = (textValue(auth?.domain ?? account?.domain) ?? '').toLowerCase()
      const encryptedToken = recordValue(auth?.accessToken ?? auth?.access_token)
      if (uid === null || domain === '' || encryptedToken === null) continue
      const enterpriseId = textValue(account?.enterpriseId ?? account?.enterprise_id ?? value.enterpriseId ?? value.enterprise_id)
      // 令牌只作为类型占位；实际请求由 WorkBuddy daemon 通过 WBIPC 注入。
      return { accessToken: '', uid, domain, enterpriseId }
    } catch {
      // 认证文件缺失或损坏时继续检查其他候选文件。
    }
  }
  return null
}

function authFileForHome(home: string): string {
  if (process.platform === 'win32') return join(home, 'AppData/Local/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')
  return join(home, '.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info')
}

function orderRegions(regions: readonly CodeBuddyRegion[], authFiles: readonly string[]): readonly CodeBuddyRegion[] {
  if (regions.length < 2) return regions
  const configured = `${process.env.CODEBUDDY_INTERNET_ENVIRONMENT ?? process.env.CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT ?? ''}`.trim().toLowerCase()
  const preferred = configured === 'internal' || configured === 'cn' || configured === 'china' || configured === 'ioa'
    ? 'cn'
    : configured === 'external' || configured === 'international' || configured === 'overseas'
      ? 'international'
      : regionFromAuthFile(authFiles[0])
  if (preferred === undefined || !regions.includes(preferred)) return regions
  return [preferred, ...regions.filter((region) => region !== preferred)]
}

function regionFromAuthFile(path: string | undefined): CodeBuddyRegion | undefined {
  if (path === undefined) return undefined
  try {
    const value = recordValue(JSON.parse(readFileSync(path, 'utf8')))
    const auth = recordValue(value?.auth)
    const domain = (textValue(auth?.domain) ?? '').toLowerCase()
    if (INTERNAL_DOMAINS.has(domain)) return 'cn'
    if (EXTERNAL_DOMAINS.has(domain)) return 'international'
  } catch {
    // 缺少或损坏的主认证文件时，继续按候选文件逐区查询。
  }
  return undefined
}

function readCodeBuddyAuth(files: readonly string[], region: CodeBuddyRegion): CodeBuddyAuth | null {
  for (const path of files) {
    try {
      const value = recordValue(JSON.parse(readFileSync(path, 'utf8')))
      if (value === null) continue
      const auth = recordValue(value.auth)
      const account = recordValue(value.account)
      const accessToken = textValue(auth?.accessToken ?? auth?.access_token)
      const uid = textValue(account?.uid ?? value.uid)
      if (accessToken === null || uid === null) continue
      const domain = (textValue(auth?.domain ?? account?.domain) ?? '').toLowerCase()
      if (!matchesRegion(domain, region)) continue
      const enterpriseId = textValue(account?.enterpriseId ?? account?.enterprise_id ?? value.enterpriseId ?? value.enterprise_id)
      return { accessToken, uid, domain, enterpriseId }
    } catch {
      // 认证文件缺失或损坏时继续检查其他隔离根。
    }
  }
  return null
}

function matchesRegion(domain: string, region: CodeBuddyRegion): boolean {
  if (domain === '') return false
  const hostname = domain.replace(/^https?:\/\//u, '').split('/')[0]?.toLowerCase() ?? ''
  return (region === 'cn' ? INTERNAL_DOMAINS : EXTERNAL_DOMAINS).has(hostname)
}

function requestHeaders(origin: string, auth: CodeBuddyAuth, region: CodeBuddyRegion, adapterId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    'X-User-Id': auth.uid,
    'X-Trace-ID': randomUUID(),
    'X-Request-ID': randomUUID(),
    'Accept-Language': region === 'cn' ? 'zh' : 'en',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': `CodingNS4DSH ${adapterId === 'workbuddy' ? 'WorkBuddy' : 'CodeBuddy'} subscription reader`,
    ...(adapterId === 'workbuddy' ? {
      'X-Domain': auth.domain,
      'X-Product': 'WorkBuddy',
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
    } : {}),
    ...(auth.enterpriseId === null ? {} : { 'X-Enterprise-Id': auth.enterpriseId }),
  }
}

function normalizeSummary(value: Record<string, unknown> | null): CodeBuddySummary | null {
  const data = unwrapData(value)
  if (data === null) return null
  const resources = arrayValue(data.Packages ?? data.packages).map(normalizeSummaryResource).filter((item): item is CodeBuddyResource => item !== null)
  const planCode = textValue(data.SubscriptionPackageCode ?? data.subscriptionPackageCode) ?? ''
  const planName = textValue(data.SubscriptionPackageName ?? data.subscriptionPackageName ?? data.PackageName ?? data.packageName) ?? ''
  const isPaid = booleanValue(data.IsPaidUser ?? data.isPaidUser)
  if (resources.length === 0 && planCode === '' && planName === '') return null
  return { planCode, planName, isPaid, resources }
}

/** 导出给 fixture/诊断使用的容错 summary 解析器，不暴露任何认证字段。 */
export function normalizeCodeBuddySummary(value: unknown): CodeBuddySummary | null {
  return normalizeSummary(recordValue(value))
}

function normalizeSummaryResource(value: unknown): CodeBuddyResource | null {
  const record = recordValue(value)
  if (record === null) return null
  const packageCode = textValue(record.PackageCode ?? record.packageCode ?? record.Code ?? record.code)
  if (packageCode === null) return null
  const total = numberValue(record.CycleTotalCapacity ?? record.cycleTotalCapacity ?? record.TotalCapacity ?? record.totalCapacity)
  const remaining = numberValue(record.CycleRemainCapacity ?? record.cycleRemainCapacity ?? record.RemainCapacity ?? record.remainCapacity)
  const used = numberValue(record.CycleUsedCapacity ?? record.cycleUsedCapacity ?? record.UsedCapacity ?? record.usedCapacity)
    ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null)
  return {
    packageCode,
    packageName: textValue(record.PackageName ?? record.packageName) ?? packageCode,
    total,
    used,
    remaining,
    expiresAt: timestampValue(record.DeductionEndTime ?? record.ExpiredTime ?? record.CycleEndTime ?? record.expireAt),
    refreshAt: timestampValue(record.CycleEndTime ?? record.refreshAt),
  }
}

function normalizePackageAccounts(value: Record<string, unknown> | null): readonly CodeBuddyResource[] {
  const data = unwrapData(value)
  if (data === null) return []
  const entries = arrayValue(data.Accounts ?? data.accounts ?? data.Resources ?? data.resources)
  return entries.flatMap((entry) => {
    const record = recordValue(entry)
    if (record === null) return []
    const resource = normalizeSummaryResource(record)
    if (resource === null) return []
    const capacityType = numberValue(record.CapacityType ?? record.capacityType)
    const slices = arrayValue(record.SlicePeriodUsageDetails ?? record.slicePeriodUsageDetails)
    if (capacityType !== 4 || slices.length === 0) return [resource]
    const slice = recordValue(slices[0])
    if (slice === null) return [resource]
    const total = numberValue(slice.CycleCapacitySizePrecise ?? slice.cycleCapacitySizePrecise) ?? resource.total
    const remaining = numberValue(slice.CycleCapacityRemainPrecise ?? slice.cycleCapacityRemainPrecise) ?? resource.remaining
    const used = numberValue(slice.CycleCapacityUsedPrecise ?? slice.cycleCapacityUsedPrecise) ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : resource.used)
    return [{ ...resource, total, remaining, used, expiresAt: timestampValue(slice.CycleEndTime ?? slice.endTime) ?? resource.expiresAt, refreshAt: timestampValue(slice.CycleEndTime ?? slice.endTime) ?? resource.refreshAt }]
  })
}

function mergeResources(...lists: readonly (readonly CodeBuddyResource[])[]): readonly CodeBuddyResource[] {
  const merged = new Map<string, CodeBuddyResource>()
  for (const list of lists) {
    for (const resource of list) {
      const current = merged.get(resource.packageCode)
      merged.set(resource.packageCode, current === undefined ? resource : {
        packageCode: resource.packageCode,
        packageName: resource.packageName && resource.packageName !== resource.packageCode ? resource.packageName : current.packageName,
        total: resource.total ?? current.total,
        used: resource.used ?? current.used,
        remaining: resource.remaining ?? current.remaining,
        expiresAt: resource.expiresAt ?? current.expiresAt,
        refreshAt: resource.refreshAt ?? current.refreshAt,
      })
    }
  }
  return [...merged.values()]
}

function buildUsage(origin: string, summary: CodeBuddySummary, resources: readonly CodeBuddyResource[], adapterId: string): CliSubscriptionUsage {
  const total = sumNumbers(resources.map((resource) => resource.total))
  const remaining = sumNumbers(resources.map((resource) => resource.remaining))
  const used = sumNumbers(resources.map((resource) => resource.used)) ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null)
  const details: { label: string; value: string | number }[] = [
    ...(summary.isPaid === null ? [] : [{ label: '付费用户', value: summary.isPaid ? '是' : '否' }]),
  ]
  for (const resource of resources) {
    const label = resource.packageName || resource.packageCode
    if (resource.total !== null) details.push({ label: `${label} 总量`, value: resource.total })
    if (resource.used !== null) details.push({ label: `${label} 已用`, value: resource.used })
    if (resource.remaining !== null) details.push({ label: `${label} 剩余`, value: resource.remaining })
    if (resource.expiresAt !== null) details.push({ label: `${label} 周期结束`, value: new Date(resource.expiresAt).toISOString() })
  }
  const providerBalance: ProviderBalanceUsage = {
    upstreamUrl: normalizeOrigin(origin),
    currency: null,
    unit: 'credits',
    balance: remaining,
    remaining,
    used,
    total,
    requests: null,
    inputTokens: null,
    outputTokens: null,
    planName: summary.planName || null,
    details,
  }
  return {
    authenticated: true,
    planType: summary.planName || null,
    primary: null,
    secondary: null,
    monthly: null,
    rateLimitReachedType: null,
    resetCredits: null,
    capturedAt: new Date().toISOString(),
    provider: {
      id: adapterId,
      displayName: adapterId === 'workbuddy' ? 'WorkBuddy' : 'CodeBuddy',
      baseUrl: normalizeOrigin(origin),
      capability: 'official-balance',
      logoUrl: '',
    },
    providerBalance,
  }
}

function normalizeEnterpriseUsage(value: Record<string, unknown> | null): { readonly summary: CodeBuddySummary; readonly resources: readonly CodeBuddyResource[] } | null {
  const data = unwrapData(value)
  if (data === null) return null
  const total = numberValue(data.limitNum ?? data.limit_num ?? data.total)
  const used = numberValue(data.credit ?? data.used ?? data.usedNum)
  if (total === null && used === null) return null
  const remaining = total !== null && used !== null ? Math.max(0, total - used) : null
  const resource: CodeBuddyResource = {
    packageCode: 'enterprise',
    packageName: '企业额度',
    total,
    used,
    remaining,
    expiresAt: timestampValue(data.cycleResetTime ?? data.cycle_reset_time),
    refreshAt: timestampValue(data.cycleResetTime ?? data.cycle_reset_time),
  }
  return {
    summary: { planCode: 'enterprise', planName: '企业版', isPaid: true, resources: [resource] },
    resources: [resource],
  }
}

function slicePeriodRange(): Record<string, string> {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return {
    SlicePeriodStartTime: `${year}-${month}-${day} 00:00:00`,
    SlicePeriodEndTime: `${year}-${month}-${day} 23:59:59`,
  }
}

function unwrapData(value: Record<string, unknown> | null): Record<string, unknown> | null {
  let current = value
  for (let i = 0; i < 3 && current !== null; i += 1) {
    const nested = recordValue(current.data ?? current.Data)
    if (nested === null) break
    current = nested
  }
  return current
}

function arrayValue(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : [] }
function uniqueOrigins(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(normalizeOrigin).filter((value) => value !== ''))]
}
function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return ''
  }
}
function recordValue(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null }
function textValue(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value.trim() : null }
function numberValue(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}
function booleanValue(value: unknown): boolean | null { return typeof value === 'boolean' ? value : value === 1 || value === '1' ? true : value === 0 || value === '0' ? false : null }
function timestampValue(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())) {
    const number = numberValue(value)
    if (number === null || number <= 0) return null
    return number < 100_000_000_000 ? Math.round(number * 1_000) : Math.round(number)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}
function sumNumbers(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value))
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0)
}

interface WorkBuddyIpcClient {
  readonly fetch: FetchLike
  close(): void
}

interface WorkBuddyIpcDiscovery {
  readonly endpoint: string
  readonly ticket: string
}

interface WorkBuddyIpcCallResult {
  readonly status?: unknown
  readonly headers?: unknown
  readonly body_b64?: unknown
}

interface WorkBuddyIpcPending {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason?: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const WORKBUDDY_IPC_PROTOCOL = 1
const WORKBUDDY_IPC_MAX_FRAME_BYTES = 1024 * 1024
const WORKBUDDY_IPC_HANDSHAKE_TIMEOUT_MS = 5_000
const WORKBUDDY_IPC_CALL_TIMEOUT_MS = 12_000

/**
 * 连接 WorkBuddy daemon 的官方 WBIPC 请求通道。
 *
 * WorkBuddy 的认证文件只保存了桌面端可解密的字段，DSH 不能自行解密；
 * 通过 wb.request/http.fetch 请求时由 daemon 注入当前登录态，避免串用 CodeBuddy token。
 */
async function connectWorkBuddyRequestPipe(home: string): Promise<WorkBuddyIpcClient | null> {
  const discovery = readWorkBuddyIpcDiscovery(home)
  if (discovery === null) return null
  const socket = await connectWorkBuddyIpcSocket(discovery)
  if (socket === null) return null
  try {
    const rpc = await handshakeWorkBuddyIpc(socket, discovery)
    const pipe = await rpc.call('broker/GetPipe', { pipe: 'wb.request' })
    const pipeRecord = recordValue(pipe)
    const channel = textValue(pipeRecord?.channel)
    if (channel === null) throw new Error('WorkBuddy wb.request pipe unavailable')
    return {
      fetch: createWorkBuddyIpcFetch(rpc, channel),
      close: rpc.close,
    }
  } catch {
    socket.destroy()
    return null
  }
}

function readWorkBuddyIpcDiscovery(home: string): WorkBuddyIpcDiscovery | null {
  const configured = process.env.WORKBUDDY_CONFIG_DIR?.trim()
  const configDirectory = configured || join(home, '.workbuddy')
  try {
    const value = recordValue(JSON.parse(readFileSync(join(configDirectory, 'wbipc/endpoint.json'), 'utf8')))
    const endpoint = textValue(value?.endpoint)
    const ticket = textValue(value?.ticket)
    return endpoint === null || ticket === null ? null : { endpoint, ticket }
  } catch {
    return null
  }
}

function connectWorkBuddyIpcSocket(discovery: WorkBuddyIpcDiscovery): Promise<import('node:net').Socket | null> {
  return new Promise((resolve) => {
    const endpoint = discovery.endpoint.startsWith('unix:') ? discovery.endpoint.slice('unix:'.length) : discovery.endpoint
    const socket = createConnection({ path: endpoint })
    let settled = false
    const timer = setTimeout(() => finish(null), WORKBUDDY_IPC_HANDSHAKE_TIMEOUT_MS)
    const finish = (result: import('node:net').Socket | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result === null) socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish(socket))
    socket.once('error', () => finish(null))
  })
}

interface WorkBuddyIpcRpc {
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  close(): void
}

async function handshakeWorkBuddyIpc(socket: import('node:net').Socket, discovery: WorkBuddyIpcDiscovery): Promise<WorkBuddyIpcRpc> {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let frameHandler: ((frame: Record<string, unknown>) => void) | null = null
  const queuedFrames: Record<string, unknown>[] = []
  let failed: ((error: Error) => void) | null = null
  const readFrame = (): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const queued = queuedFrames.shift()
    if (queued !== undefined) {
      resolve(queued)
      return
    }
    frameHandler = (frame) => {
      frameHandler = null
      resolve(frame)
    }
    failed = reject
  })
  const handleData = (chunk: Buffer): void => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    for (;;) {
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) {
        if (buffer.length > WORKBUDDY_IPC_MAX_FRAME_BYTES) {
          failed?.(new Error('WorkBuddy WBIPC frame exceeds limit'))
          failed = null
        }
        return
      }
      if (newline > WORKBUDDY_IPC_MAX_FRAME_BYTES) {
        failed?.(new Error('WorkBuddy WBIPC frame exceeds limit'))
        failed = null
        return
      }
      const line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      if (line.length === 0) continue
      try {
        const frame = recordValue(JSON.parse(line.toString('utf8')))
        if (frame === null) throw new Error('invalid WorkBuddy WBIPC frame')
        if (frameHandler === null) queuedFrames.push(frame)
        else frameHandler(frame)
      } catch (error) {
        failed?.(error instanceof Error ? error : new Error(String(error)))
        failed = null
        return
      }
    }
  }
  socket.on('data', handleData)
  const write = (frame: Record<string, unknown>): void => {
    const payload = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(payload) > WORKBUDDY_IPC_MAX_FRAME_BYTES) throw new Error('WorkBuddy WBIPC request exceeds limit')
    socket.write(payload)
  }
  const rejectSocket = (error: Error): void => {
    failed?.(error)
    failed = null
  }
  socket.once('error', () => rejectSocket(new Error('WorkBuddy WBIPC socket error')))
  socket.once('close', () => rejectSocket(new Error('WorkBuddy WBIPC socket closed')))
  const withTimeout = async <T>(promise: Promise<T>, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), WORKBUDDY_IPC_HANDSHAKE_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const clientNonce = randomBytes(16).toString('base64url')
  const ticketId = createHash('sha256').update(discovery.ticket, 'utf8').digest('hex').slice(0, 16)
  write({
    type: 'session_hello',
    protocol_min: WORKBUDDY_IPC_PROTOCOL,
    protocol_max: WORKBUDDY_IPC_PROTOCOL,
    client_nonce: clientNonce,
    ticket_id: ticketId,
    client: { kind: 'plugin', id: 'codingns-subscription' },
  })
  const challenge = await withTimeout(readFrame(), 'WorkBuddy WBIPC handshake timeout')
  if (challenge.type === 'session_hello_error') throw new Error(`WorkBuddy WBIPC handshake rejected: ${String(challenge.code ?? '?')}`)
  if (challenge.type !== 'session_challenge') throw new Error('unexpected WorkBuddy WBIPC handshake frame')
  const serverNonce = textValue(challenge.server_nonce)
  if (serverNonce === null) throw new Error('WorkBuddy WBIPC server nonce missing')
  const transcript = { protocol: WORKBUDDY_IPC_PROTOCOL, endpoint: discovery.endpoint, clientNonce, serverNonce }
  const proof = (role: 'server' | 'client'): string => createHmac('sha256', Buffer.from(discovery.ticket, 'utf8'))
    .update(encodeWorkBuddyTranscript(role, transcript)).digest('base64url')
  const serverProof = textValue(challenge.server_proof)
  if (serverProof === null || !safeWorkBuddyEqual(proof('server'), serverProof)) throw new Error('WorkBuddy WBIPC endpoint proof failed')
  write({ type: 'session_prove', client_proof: proof('client') })
  const ack = await withTimeout(readFrame(), 'WorkBuddy WBIPC handshake acknowledgement timeout')
  if (ack.type !== 'session_hello_ack') throw new Error(`WorkBuddy WBIPC handshake rejected: ${String(ack.code ?? '?')}`)
  const pending = new Map<number, WorkBuddyIpcPending>()
  let nextId = 1
  const onRpcFrame = (frame: Record<string, unknown>): void => {
    const id = numberValue(frame.id)
    if (id === null) return
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    clearTimeout(entry.timer)
    const error = recordValue(frame.error)
    if (error !== null) {
      entry.reject(new Error(String(error.message ?? 'WorkBuddy WBIPC request failed')))
      return
    }
    entry.resolve(frame.result)
  }
  frameHandler = onRpcFrame
  while (queuedFrames.length > 0) {
    const frame = queuedFrames.shift()
    if (frame !== undefined) onRpcFrame(frame)
  }
  const close = (): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('WorkBuddy WBIPC connection closed'))
    }
    pending.clear()
    socket.destroy()
  }
  return {
    call(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return
          reject(new Error(`WorkBuddy WBIPC call timeout: ${method}`))
        }, WORKBUDDY_IPC_CALL_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        try {
          write({ jsonrpc: '2.0', id, method, params, mode: 'call' })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
    close,
  }
}

function encodeWorkBuddyTranscript(role: 'server' | 'client', transcript: { protocol: number; endpoint: string; clientNonce: string; serverNonce: string }): Buffer {
  const parts = [role === 'server' ? 'wbipc-s' : 'wbipc-c', String(transcript.protocol), transcript.endpoint, transcript.clientNonce, transcript.serverNonce]
  return Buffer.concat(parts.map((part) => {
    const value = Buffer.from(part, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(value.length, 0)
    return Buffer.concat([length, value])
  }))
}

function safeWorkBuddyEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b)
}

function createWorkBuddyIpcFetch(rpc: WorkBuddyIpcRpc, channel: string): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(String(input)) : new URL(input.url)
    const sourceHeaders = new Headers(init?.headers)
    // WorkBuddy daemon 只允许这两个业务头，其余身份、Origin、追踪头由宿主裁决。
    const headers = new Headers()
    for (const name of ['accept', 'content-type']) {
      const value = sourceHeaders.get(name)
      if (value !== null) headers.set(name, value)
    }
    const body = init?.body === undefined || init.body === null
      ? undefined
      : Buffer.from(await new Response(init.body).arrayBuffer()).toString('base64')
    const result = recordValue(await rpc.call(`${channel}/http.fetch`, {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      ...(body === undefined ? {} : { body_b64: body }),
    })) as WorkBuddyIpcCallResult | null
    const status = numberValue(result?.status)
    const responseHeaders = recordValue(result?.headers)
    const normalizedHeaders: Record<string, string> = {}
    if (responseHeaders !== null) {
      for (const [key, value] of Object.entries(responseHeaders)) {
        const text = textValue(value)
        if (text !== null) normalizedHeaders[key] = text
      }
    }
    const bodyValue = typeof result?.body_b64 === 'string' ? Buffer.from(result.body_b64, 'base64') : Buffer.alloc(0)
    return new Response(bodyValue, {
      status: status !== null && status >= 200 && status <= 599 ? status : 500,
      headers: normalizedHeaders,
    })
  }
}

export { DEFAULT_ORIGINS as CODEBUDDY_BILLING_ORIGINS }
