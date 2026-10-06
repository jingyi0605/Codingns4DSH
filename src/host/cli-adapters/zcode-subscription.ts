import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'
import type { CliSubscriptionUsage, ProviderBalanceUsage } from '../../shared/contracts/subscription.js'
import { resolveZCodeDesktopRuntime } from './desktop-app-runtime.js'
import type { ZcodeProviderConfigOptions } from './zcode-provider-config.js'

type FetchLike = typeof fetch

const ZCODE_JWT_TOKEN_KEY = 'zcodejwttoken'
const ZCODE_BALANCE_ORIGIN = 'https://zcode.z.ai'

/** ZCode Start Plan 的 billing/balance 读取器；凭据与设备标识始终只在 Host 内处理。 */
export interface ZcodeSubscriptionOptions extends ZcodeProviderConfigOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly telemetryPath?: string
  readonly appVersion?: string
}

interface ZcodeBalancePlan {
  readonly user_plan_id?: unknown
  readonly plan_id?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly starts_at?: unknown
  readonly ends_at?: unknown
  readonly entitlements?: readonly { entitlement_id?: unknown; show_name?: unknown; period?: unknown }[]
}

interface ZcodeBalanceBucket {
  readonly bucket_id?: unknown
  readonly user_plan_id?: unknown
  readonly plan_id?: unknown
  readonly entitlement_id?: unknown
  readonly show_name?: unknown
  readonly unit_type?: unknown
  readonly total_units?: unknown
  readonly used_units?: unknown
  readonly remaining_units?: unknown
  readonly available_units?: unknown
  readonly period_start?: unknown
  readonly period_end?: unknown
  readonly expires_at?: unknown
}

interface ZcodeBalanceEnvelope {
  readonly code?: unknown
  readonly msg?: unknown
  readonly data?: {
    readonly server_time?: unknown
    readonly plans?: readonly ZcodeBalancePlan[]
    readonly balances?: readonly ZcodeBalanceBucket[]
  }
}

/** 读取 ZCode 套餐余额、已用额度和剩余额度。 */
export class ZcodeSubscriptionService {
  private readonly request: FetchLike
  readonly timeoutMs: number
  private readonly homeDirectory: string
  private readonly options: ZcodeSubscriptionOptions

  constructor(options: ZcodeSubscriptionOptions = {}) {
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.options = options
  }

  async read(): Promise<CliSubscriptionUsage | null> {
    const runtime = this.options.runtime === undefined ? resolveZCodeDesktopRuntime() : this.options.runtime
    const appVersion = this.options.appVersion?.trim() || runtime?.appVersion?.trim() || process.env.ZCODE_APP_VERSION?.trim() || ''
    if (appVersion === '') return null

    const token = readZcodeJwtToken(this.credentialsPath(), this.options.credentialSecret)
    const deviceMid = readDeviceMid(this.telemetryPath())
    if (token === null || deviceMid === null) return null

    const url = new URL('/api/v1/zcode-plan/billing/balance', ZCODE_BALANCE_ORIGIN)
    url.searchParams.set('app_version', appVersion)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request(url.toString(), {
        headers: {
          Authorization: /^Bearer\s/iu.test(token) ? token : `Bearer ${token}`,
          'X-Device-Mid': deviceMid,
          Accept: 'application/json',
        },
        signal: controller.signal,
      })
      if (!response.ok) return null
      const payload = await response.json() as ZcodeBalanceEnvelope
      const balance = normalizeBalance(payload, url.toString())
      if (balance === null) return null
      return {
        authenticated: true,
        planType: balance.planName,
        primary: null,
        secondary: null,
        monthly: null,
        rateLimitReachedType: null,
        resetCredits: null,
        capturedAt: new Date().toISOString(),
        provider: {
          id: 'zcode',
          displayName: 'ZCode',
          baseUrl: ZCODE_BALANCE_ORIGIN,
          capability: 'official-balance',
          logoUrl: '',
        },
        providerBalance: balance,
      }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private credentialsPath(): string {
    return this.options.credentialsPath ?? join(this.homeDirectory, '.zcode', 'v2', 'credentials.json')
  }

  private telemetryPath(): string {
    return this.options.telemetryPath ?? join(this.homeDirectory, '.zcode', 'v2', 'telemetry-state.json')
  }
}

function normalizeBalance(payload: ZcodeBalanceEnvelope, upstreamUrl: string): ProviderBalanceUsage | null {
  if (numberValue(payload.code) !== 0) return null
  const data = payload.data
  if (data === undefined) return null
  const serverTime = numberValue(data.server_time)
  const activePlans = (data.plans ?? []).filter((plan) => {
    if (textValue(plan.status)?.toLowerCase() !== 'active') return false
    const end = unixSeconds(plan.ends_at)
    return end === null || serverTime === null || end > serverTime
  })
  if (activePlans.length === 0) return null
  const activePlanIds = new Set(activePlans.flatMap((plan) => [textValue(plan.plan_id), textValue(plan.user_plan_id)].filter((value): value is string => value !== null)))
  const activeEntitlementIds = new Set(activePlans.flatMap((plan) => (plan.entitlements ?? []).map((entry) => textValue(entry.entitlement_id)).filter((value): value is string => value !== null)))
  const buckets = (data.balances ?? []).filter((bucket) => {
    const expiresAt = unixSeconds(bucket.expires_at)
    if (expiresAt !== null && serverTime !== null && expiresAt <= serverTime) return false
    const ownerIds = [textValue(bucket.plan_id), textValue(bucket.user_plan_id)].filter((value): value is string => value !== null)
    if (ownerIds.length > 0) return ownerIds.some((id) => activePlanIds.has(id))
    const entitlementId = textValue(bucket.entitlement_id)
    return entitlementId === null || activeEntitlementIds.size === 0 || activeEntitlementIds.has(entitlementId)
  })
  const values = buckets.map((bucket) => ({
    name: textValue(bucket.show_name) ?? '模型额度',
    total: numberValue(bucket.total_units),
    used: numberValue(bucket.used_units),
    remaining: numberValue(bucket.remaining_units),
    periodEnd: unixSeconds(bucket.period_end) ?? unixSeconds(bucket.expires_at),
  })).filter((bucket) => bucket.total !== null || bucket.used !== null || bucket.remaining !== null)
  if (values.length === 0) return null
  const total = sum(values.map((value) => value.total))
  const used = sum(values.map((value) => value.used))
  const remaining = sum(values.map((value) => value.remaining))
  const planName = textValue(activePlans[0]?.name) ?? 'ZCode Start Plan'
  const details: { label: string; value: string | number }[] = []
  for (const value of values) {
    details.push({ label: `${value.name} 剩余`, value: value.remaining ?? '--' })
    details.push({ label: `${value.name} 已用`, value: value.used ?? '--' })
    details.push({ label: `${value.name} 总量`, value: value.total ?? '--' })
    if (value.periodEnd !== null) details.push({ label: `${value.name} 周期结束`, value: new Date(value.periodEnd * 1000).toISOString() })
  }
  return {
    upstreamUrl,
    currency: null,
    unit: 'tokens',
    balance: remaining,
    remaining,
    used,
    total,
    requests: null,
    inputTokens: null,
    outputTokens: null,
    planName,
    details,
  }
}

function readZcodeJwtToken(path: string, secret: string | undefined): string | null {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const raw = value[ZCODE_JWT_TOKEN_KEY]
    if (typeof raw !== 'string' || raw.trim() === '') return null
    const decrypted = decryptCredential(raw, secret)
    return decrypted.trim() === '' ? null : decrypted.trim()
  } catch {
    return null
  }
}

function readDeviceMid(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const deviceMid = value.deviceMid
    return typeof deviceMid === 'string' && deviceMid.trim() !== '' ? deviceMid.trim() : null
  } catch {
    return null
  }
}

function decryptCredential(value: string, configuredSecret: string | undefined): string {
  if (!value.startsWith('enc:v1:')) return value
  const [ivRaw, authTagRaw, cipherRaw] = value.slice('enc:v1:'.length).split('.')
  if (!ivRaw || !authTagRaw || !cipherRaw) throw new Error('ZCode 凭据密文格式无效')
  const iv = Buffer.from(ivRaw, 'base64url')
  const authTag = Buffer.from(authTagRaw, 'base64url')
  const cipherText = Buffer.from(cipherRaw, 'base64url')
  if (iv.length !== 12 || authTag.length !== 16) throw new Error('ZCode 凭据密文长度无效')
  const secret = configuredSecret?.trim() || process.env.ZCODE_CREDENTIAL_SECRET?.trim() || fallbackCredentialSecret()
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8')
}

function fallbackCredentialSecret(): string {
  let username = 'unknown'
  try { username = userInfo().username } catch { /* 沙箱环境可能无法读取用户名。 */ }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(result) ? result : null
}

function unixSeconds(value: unknown): number | null {
  const result = numberValue(value)
  if (result === null || result <= 0) return null
  return Math.round(result > 100_000_000_000 ? result / 1000 : result)
}

function sum(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0)
}
