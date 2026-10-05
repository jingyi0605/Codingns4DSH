import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import type {
  CliSubscriptionGroup,
  CliSubscriptionGroupWindow,
  CliSubscriptionQuotaWindowKind,
  CliSubscriptionUsage,
  CliSubscriptionWindow,
} from '../../shared/contracts/subscription.js'
import { commandEnvironment, resolveCommandPath } from './process-utils.js'

type FetchLike = typeof fetch
type SpawnLike = typeof spawn
type SpawnSyncLike = typeof spawnSync

/** Antigravity（agy）CLI 使用的 Cloud Code 后端；与 CLI 自己的请求地址一致。 */
const ANTIGRAVITY_API_BASE = 'https://daily-cloudcode-pa.googleapis.com'

/**
 * `fetchAvailableModels`、`retrieveUserQuotaSummary` 会按 User-Agent 做产品校验：
 * 本机实测缺失或非 Antigravity 的 UA 一律返回 403 PERMISSION_DENIED，带产品名的 UA
 * （含版本号与否）返回 200。这里沿用 CLI 自己的产品标识，而不是 Node 默认 UA。
 */
const ANTIGRAVITY_USER_AGENT = 'antigravity-cli'

/** 上游 `bucket.window` 取值到公共窗口类型的映射。 */
const WINDOW_KIND_BY_API_NAME: Readonly<Record<string, CliSubscriptionQuotaWindowKind>> = {
  '5h': 'five-hour',
  '5hr': 'five-hour',
  'five-hour': 'five-hour',
  weekly: 'weekly',
  monthly: 'monthly',
}

const FIVE_HOUR_WINDOW = '5h'
const WEEKLY_WINDOW = 'weekly'

/**
 * `agy` 1.2.17 起把 OAuth 凭据写进系统钥匙串（go-keyring），旧的
 * `antigravity-oauth-token` 文件会消失；这里仍保留文件候选以兼容旧版本。
 */
const ANTIGRAVITY_KEYCHAIN_SERVICE = 'gemini'
const ANTIGRAVITY_KEYCHAIN_ACCOUNT = 'antigravity'
const KEYRING_BASE64_PREFIX = 'go-keyring-base64:'
const CREDENTIAL_FILE_NAMES = ['antigravity-oauth-token', 'auth.json', 'credentials.json', 'oauth_token.json'] as const

const ANTIGRAVITY_USAGE_COMMAND_TIMEOUT_MS = 20_000

export interface AntigravitySubscriptionReadOptions {
  /** 当前会话选中的模型；用于在 Gemini 与 Claude/GPT 两个配额组之间选择主窗口。 */
  readonly modelId?: string | undefined
}

export interface AntigravitySubscriptionOptions {
  readonly homeDirectory?: string
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly readFile?: (path: string) => string
  readonly now?: () => number
  readonly platform?: string
  readonly spawn?: SpawnLike
  readonly spawnSync?: SpawnSyncLike
  /** 覆盖 `agy` 路径探测，测试可注入。 */
  readonly resolveCommand?: () => string | null
  /** 读取器自身可用的模型解析；默认读 AGY 设置文件，测试可注入。 */
  readonly resolveModelId?: (modelId: string | undefined) => string | null
}

/** API 与 `agy --print /usage` 归一化后的配额窗口。 */
interface AntigravityQuotaWindowDraft {
  readonly kind: CliSubscriptionQuotaWindowKind
  readonly label: string
  readonly remainingFraction: number
  readonly resetsAt: number | null
}

interface AntigravityQuotaGroupDraft {
  readonly displayName: string
  readonly windows: readonly AntigravityQuotaWindowDraft[]
}

interface AntigravityCredentials {
  readonly accessToken: string
  readonly accountName: string | null
}

/**
 * Antigravity 官方用量读取器。
 *
 * 两条只读来源，互为兜底：
 *
 * 1. `v1internal:retrieveUserQuotaSummary`（首选）：按配额组返回 5 小时与周两个窗口，
 *    带精确的 `remainingFraction`；`loadCodeAssist` 顺带给出套餐档位，账号名从
 *    CLI 保存的 `id_token`（JWT）读取。凭据来自系统钥匙串或旧版凭据文件，只读、不出 Host。
 * 2. `agy --print /usage`（兜底）：CLI 自己的内置命令，输出制表符分隔的
 *    “分组 / 窗口 / 百分比 / 重置时间”，不依赖本插件能读到凭据。
 *
 * 两组额度互相独立：Gemini 一组、Claude 与 GPT-OSS 一组，每组各有 5 小时与周窗口。
 * 任一来源失败时安静降级，不占用底部栏空间。
 */
export class AntigravitySubscriptionService {
  private readonly homeDirectory: string
  private readonly request: FetchLike
  private readonly timeoutMs: number
  private readonly readFile: (path: string) => string
  private readonly now: () => number
  private readonly platform: string
  private readonly runSpawn: SpawnLike
  private readonly runSpawnSync: SpawnSyncLike
  private readonly resolveCommand: (() => string | null) | undefined
  private readonly resolveModelId: ((modelId: string | undefined) => string | null) | undefined
  private cachedCommand: string | null | undefined = undefined

  constructor(options: AntigravitySubscriptionOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
    this.now = options.now ?? (() => Date.now())
    this.platform = options.platform ?? process.platform
    this.runSpawn = options.spawn ?? spawn
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.resolveCommand = options.resolveCommand
    this.resolveModelId = options.resolveModelId
  }

  async read(options: AntigravitySubscriptionReadOptions = {}): Promise<CliSubscriptionUsage | null> {
    const credentials = this.readCredentials()
    if (credentials !== null) {
      const [tier, summary] = await Promise.all([
        this.call('loadCodeAssist', credentials.accessToken),
        this.call('retrieveUserQuotaSummary', credentials.accessToken),
      ])
      const groups = readAntigravityQuotaGroups(summary)
      if (groups.length > 0) {
        return this.buildUsage(groups, tier, credentials.accountName, options.modelId)
      }
    }
    // 凭据不可用（钥匙串未授权、旧文件被清理、未登录）时改问 CLI 自己。
    const groups = await this.readQuotaFromCli()
    if (groups === null || groups.length === 0) return null
    return this.buildUsage(groups, null, null, options.modelId)
  }

  /** 运行 CLI 内置的 `/usage`，它的输出就是 TUI 里那份分组额度。 */
  private async readQuotaFromCli(): Promise<readonly AntigravityQuotaGroupDraft[] | null> {
    const command = this.resolveAgyCommand()
    if (command === null) return null
    const stdout = await this.runUsageCommand(command)
    if (stdout === null) return null
    const groups = parseAntigravityUsageOutput(stdout)
    return groups.length === 0 ? null : groups
  }

  private resolveAgyCommand(): string | null {
    if (this.cachedCommand !== undefined) return this.cachedCommand
    if (this.resolveCommand !== undefined) {
      this.cachedCommand = this.resolveCommand()
      return this.cachedCommand
    }
    for (const candidate of ['agy']) {
      const resolved = resolveCommandPath(candidate, this.runSpawnSync)
      if (resolved !== null) {
        this.cachedCommand = resolved
        return resolved
      }
    }
    this.cachedCommand = null
    return null
  }

  private async runUsageCommand(command: string): Promise<string | null> {
    return await new Promise((resolve) => {
      let child: ReturnType<SpawnLike>
      try {
        child = this.runSpawn(command, ['--print', '/usage'], {
          env: commandEnvironment(command),
          windowsHide: true,
          shell: this.platform === 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch {
        resolve(null)
        return
      }
      let stdout = ''
      let settled = false
      const finish = (value: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.kill() } catch { /* 进程可能已退出 */ }
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), ANTIGRAVITY_USAGE_COMMAND_TIMEOUT_MS)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', () => { /* 诊断信息不进入会话 */ })
      child.once('error', () => finish(null))
      child.once('close', () => finish(stdout))
    })
  }

  private buildUsage(
    drafts: readonly AntigravityQuotaGroupDraft[],
    tier: unknown,
    accountName: string | null,
    modelId: string | undefined,
  ): CliSubscriptionUsage | null {
    const groups = toContractGroups(drafts)
    if (groups.length === 0) return null
    const selected = selectAntigravityQuotaGroupIn(groups, this.effectiveModelId(modelId)) ?? groups[0]!
    const primary = findGroupWindow(selected, 'five-hour')
    const secondary = findGroupWindow(selected, 'weekly')
    if (primary === null && secondary === null) return null
    const rateLimited = groups.some((group) => group.windows.some((entry) => entry.window.remainingPercent <= 0))
    const paidPlanType = readAntigravityPaidPlanType(tier)
    return {
      authenticated: true,
      planType: readAntigravityPlanType(tier),
      ...(paidPlanType === null ? {} : { paidPlanType }),
      primary,
      secondary,
      monthly: null,
      groups,
      rateLimitReachedType: rateLimited ? 'quota' : null,
      resetCredits: null,
      capturedAt: new Date(this.now()).toISOString(),
      ...(accountName === null ? {} : { accountName }),
      provider: {
        id: 'antigravity',
        displayName: 'Antigravity',
        baseUrl: ANTIGRAVITY_API_BASE,
        capability: 'subscription-window',
        logoUrl: 'https://cdn.simpleicons.org/google',
      },
    }
  }

  /** `provider-default` 时按 AGY 自己选中的模型判断配额组。 */
  private effectiveModelId(modelId: string | undefined): string | null {
    const explicit = modelId?.trim()
    if (explicit !== undefined && explicit !== '' && explicit !== 'provider-default') return explicit.toLowerCase()
    return this.resolveModelId?.(modelId) ?? null
  }

  /**
   * 读取 CLI 的 OAuth 凭据。
   *
   * `agy` 1.2.17 起写系统钥匙串（值前缀 `go-keyring-base64:`），旧版本写
   * `~/.gemini/antigravity-cli/antigravity-oauth-token`。两者结构一致，都带
   * `token.access_token` 与 `id_token`。
   */
  private readCredentials(): AntigravityCredentials | null {
    const keychain = this.readKeychainCredentials()
    if (keychain !== null) return keychain
    for (const name of CREDENTIAL_FILE_NAMES) {
      const parsed = this.readCredentialFile(join(this.homeDirectory, '.gemini', 'antigravity-cli', name))
      if (parsed !== null) return parsed
    }
    return null
  }

  private readCredentialFile(path: string): AntigravityCredentials | null {
    let raw: string
    try {
      raw = this.readFile(path)
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    return toCredentials(parsed, this.now())
  }

  private readKeychainCredentials(): AntigravityCredentials | null {
    if (this.platform !== 'darwin') return null
    try {
      // 钥匙串读取是本地毫秒级操作；未授权或条目不存在时直接放弃，改走 CLI 兜底。
      const result: SpawnSyncReturns<string> = this.runSpawnSync('security', [
        'find-generic-password',
        '-s', ANTIGRAVITY_KEYCHAIN_SERVICE,
        '-a', ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        '-w',
      ], { encoding: 'utf8', timeout: 3_000, windowsHide: true })
      if (result.status !== 0 || typeof result.stdout !== 'string') return null
      return toCredentials(decodeKeyringSecret(result.stdout.trim()), this.now())
    } catch {
      return null
    }
  }

  private async call(method: string, token: string): Promise<unknown | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request(`${ANTIGRAVITY_API_BASE}/v1internal:${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': ANTIGRAVITY_USER_AGENT,
        },
        body: '{}',
        signal: controller.signal,
      })
      if (!response.ok) return null
      return await response.json()
    } catch {
      // 未登录、令牌过期或网络不可用时安静降级，订阅栏不占用底部空间。
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function toCredentials(value: unknown, now: number): AntigravityCredentials | null {
  const root = recordValue(value)
  const token = recordValue(root?.token)
  const accessToken = textValue(token?.access_token)
  if (accessToken === null) return null
  const expiry = textValue(token?.expiry)
  if (expiry !== null) {
    const expiresAt = Date.parse(expiry)
    // 过期令牌不做刷新（刷新需要 OAuth 客户端），交给 CLI 下次运行处理。
    if (Number.isFinite(expiresAt) && expiresAt <= now) return null
  }
  return { accessToken, accountName: readAccountName(textValue(root?.id_token)) }
}

/** 解开 go-keyring 的 base64 包装；普通 JSON 原样返回。 */
export function decodeKeyringSecret(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed.startsWith(KEYRING_BASE64_PREFIX)) {
    try { return JSON.parse(trimmed) } catch { return null }
  }
  try {
    return JSON.parse(Buffer.from(trimmed.slice(KEYRING_BASE64_PREFIX.length), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * 解析 `agy --print /usage` 的输出。
 *
 * 实测格式（制表符分隔，一行一个窗口）：
 * ```
 * Gemini Models	Weekly Limit Remaining	99%	2026-10-07T05:47:33Z
 * Gemini Models	Five Hour Limit Remaining	98%	2026-10-05T19:09:53Z
 * Claude and GPT models	Weekly Limit Remaining	96%	2026-10-12T14:56:40Z
 * Claude and GPT models	Five Hour Limit Remaining	92%	2026-10-05T19:56:40Z
 * ```
 */
export function parseAntigravityUsageOutput(output: string): readonly AntigravityQuotaGroupDraft[] {
  const groups = new Map<string, AntigravityQuotaWindowDraft[]>()
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^([^\t]+)\t([^\t]+)\t(\d{1,3})%\t(\S+)\s*$/u)
    if (match === null) continue
    const groupName = match[1]!.trim()
    const label = match[2]!.trim()
    const percent = Number(match[3])
    if (groupName === '' || label === '' || !Number.isFinite(percent)) continue
    const windows = groups.get(groupName) ?? []
    windows.push({
      kind: windowKindFromLabel(label),
      label,
      remainingFraction: Math.max(0, Math.min(1, percent / 100)),
      resetsAt: timestampSeconds(match[4]),
    })
    groups.set(groupName, windows)
  }
  return [...groups.entries()].map(([displayName, windows]) => ({ displayName, windows }))
}

/** 从 `retrieveUserQuotaSummary` 的响应里提取配额组。 */
export function readAntigravityQuotaGroups(value: unknown): readonly AntigravityQuotaGroupDraft[] {
  const groups = recordValue(value)?.groups
  if (!Array.isArray(groups)) return []
  const parsed: AntigravityQuotaGroupDraft[] = []
  for (const entry of groups) {
    const record = recordValue(entry)
    if (record === null) continue
    const windows: AntigravityQuotaWindowDraft[] = []
    for (const rawBucket of Array.isArray(record.buckets) ? record.buckets : []) {
      const bucket = recordValue(rawBucket)
      if (bucket === null) continue
      const window = textValue(bucket.window)
      const remaining = numberValue(bucket.remainingFraction)
      if (window === null || remaining === null) continue
      windows.push({
        kind: WINDOW_KIND_BY_API_NAME[window.toLowerCase()] ?? 'other',
        label: textValue(bucket.displayName) ?? window,
        remainingFraction: clampFraction(remaining),
        resetsAt: timestampSeconds(bucket.resetTime),
      })
    }
    if (windows.length === 0) continue
    parsed.push({ displayName: textValue(record.displayName) ?? '', windows })
  }
  return parsed
}

/**
 * 按会话模型选择配额组。
 *
 * Antigravity 把 Gemini 与 Claude/GPT 分成两组独立额度，上游分组名分别是
 * “Gemini Models” 与 “Claude and GPT models”。模型未知时退回第一组
 * （AGY 默认 Agent 模型是 Gemini）。
 */
export function selectAntigravityQuotaGroup(
  groups: readonly AntigravityQuotaGroupDraft[],
  modelId: string | null,
): AntigravityQuotaGroupDraft | null {
  const thirdParty = antigravityQuotaGroupPrefix(modelId) === '3p-'
  const matched = groups.find((group) => isThirdPartyGroupName(group.displayName) === thirdParty)
  return matched ?? groups[0] ?? null
}

function selectAntigravityQuotaGroupIn(
  groups: readonly CliSubscriptionGroup[],
  modelId: string | null,
): CliSubscriptionGroup | null {
  const thirdParty = antigravityQuotaGroupPrefix(modelId) === '3p-'
  const matched = groups.find((group) => group.id === (thirdParty ? 'third-party' : 'gemini'))
    ?? groups.find((group) => isThirdPartyGroupName(group.displayName) === thirdParty)
  return matched ?? groups[0] ?? null
}

export function antigravityQuotaGroupPrefix(modelId: string | null): string {
  return modelId !== null && /^(?:claude|gpt-oss)/u.test(modelId.trim().toLowerCase()) ? '3p-' : 'gemini-'
}

function toContractGroups(drafts: readonly AntigravityQuotaGroupDraft[]): readonly CliSubscriptionGroup[] {
  return drafts.map((draft) => ({
    id: quotaGroupId(draft.displayName),
    displayName: draft.displayName,
    windows: draft.windows.map((window): CliSubscriptionGroupWindow => ({
      kind: window.kind,
      label: window.label,
      window: toWindow(window.remainingFraction, window.resetsAt),
    })),
  }))
}

/** 分组 id 供客户端本地化；未知分组回退到上游展示名。 */
function quotaGroupId(displayName: string): string {
  if (isThirdPartyGroupName(displayName)) return 'third-party'
  const normalized = displayName.trim().toLowerCase()
  if (normalized.includes('gemini')) return 'gemini'
  return normalized.replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'other'
}

function isThirdPartyGroupName(displayName: string): boolean {
  const normalized = displayName.trim().toLowerCase()
  return normalized.includes('claude') || normalized.includes('gpt')
}

function findGroupWindow(group: CliSubscriptionGroup, kind: CliSubscriptionQuotaWindowKind): CliSubscriptionWindow | null {
  return group.windows.find((entry) => entry.kind === kind)?.window ?? null
}

function windowKindFromLabel(label: string): CliSubscriptionQuotaWindowKind {
  const normalized = label.trim().toLowerCase()
  if (normalized.includes('five hour') || normalized.includes('5 hour') || normalized.includes('5h')) return 'five-hour'
  if (normalized.includes('week')) return 'weekly'
  if (normalized.includes('month')) return 'monthly'
  return 'other'
}

function toWindow(remainingFraction: number, resetsAt: number | null): CliSubscriptionWindow {
  const remainingPercent = clampPercent(remainingFraction * 100)
  return {
    usedPercent: clampPercent((1 - remainingFraction) * 100),
    remainingPercent,
    // 窗口文案由客户端按 kind 给出，不按分钟数推导标签。
    windowDurationMins: null,
    resetsAt,
  }
}

/** 套餐档位优先用稳定的 tier id（`free-tier` → “Free Tier”），避免与 Provider 名重复。 */
export function readAntigravityPlanType(value: unknown): string | null {
  const tier = recordValue(recordValue(value)?.currentTier)
  if (tier === null) return null
  return textValue(tier.id) ?? textValue(tier.name)
}

/**
 * 账号实际持有的付费档位。
 *
 * `loadCodeAssist` 会同时返回生效档位 `currentTier` 与权益档位 `paidTier`：本机实测
 * 账号持有 Google AI Pro（`g1-pro-tier`）时 `currentTier` 仍是 `free-tier`，即订阅
 * 权益没有映射到 Antigravity 的 Agent 额度上。两个档位都要展示，否则界面会把
 * “生效档位”说成“账号没有订阅”。
 */
export function readAntigravityPaidPlanType(value: unknown): string | null {
  const tier = recordValue(recordValue(value)?.paidTier)
  if (tier === null) return null
  return textValue(tier.name) ?? textValue(tier.id)
}

/** 账号名从 CLI 自己保存的 id_token（JWT）负载里读取，不发额外请求。 */
export function readAccountName(idToken: string | null): string | null {
  if (idToken === null) return null
  const segment = idToken.split('.')[1]
  if (segment === undefined || segment === '') return null
  try {
    const payload = Buffer.from(segment.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8')
    const claims = recordValue(JSON.parse(payload))
    return textValue(claims?.email) ?? textValue(claims?.name)
  } catch {
    return null
  }
}

function recordValue(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 上游时间统一使用 Unix 秒；字符串走 RFC3339，数字按毫秒/秒自动判定。 */
function timestampSeconds(value: unknown): number | null {
  const text = textValue(value)
  if (text !== null) {
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null
  }
  const numeric = numberValue(value)
  if (numeric === null) return null
  return Math.round(numeric > 10_000_000_000 ? numeric / 1000 : numeric)
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(4))))
}
