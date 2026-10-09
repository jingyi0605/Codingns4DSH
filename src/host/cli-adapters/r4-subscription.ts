import type { CliSubscriptionUsage, R4Usage, R4UsagePoint } from '../../shared/contracts/subscription.js'
import type { Sub2ApiSource } from './provider-subscription.js'

export interface R4SubscriptionOptions {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export function isR4Source(source: Sub2ApiSource): boolean {
  try { return new URL(source.baseUrl).origin === 'https://api.r4.codes' } catch { return false }
}

export class R4SubscriptionService {
  constructor(private readonly options: R4SubscriptionOptions = {}) {}

  async read(source: Sub2ApiSource): Promise<CliSubscriptionUsage | null> {
    const apiKey = source.apiKey.trim().replace(/^Bearer\s+/iu, '')
    if (!isR4Source(source) || apiKey === '') return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8_000)
    const get = async (path: string): Promise<Record<string, unknown> | null> => {
      try {
        const response = await (this.options.fetch ?? fetch)(`https://api.r4.codes/v1/cli/${path}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error',
        })
        return response.ok ? record(await response.json()) : null
      } catch { return null }
    }
    try {
      const [meta, key, usage] = await Promise.all([get('meta'), get('key'), get('usage')])
      return normalizeR4Usage(meta, key, usage)
    } finally { clearTimeout(timer) }
  }
}

function normalizeR4Usage(meta: Record<string, unknown> | null, key: Record<string, unknown> | null, usage: Record<string, unknown> | null): CliSubscriptionUsage | null {
  const plan = record(meta?.plan)
  const wallet = record(meta?.wallet)
  const packageBalance = amount(plan?.remaining_usd)
  const walletBalance = amount(wallet?.balance_usd)
  // 显式 null 表示没有有效套餐/钱包；缺失或非法字段不是零。
  const packageKnown = meta?.plan === null || packageBalance !== null
  const walletKnown = meta?.wallet === null || walletBalance !== null
  const balance = packageKnown && walletKnown ? (packageBalance ?? 0) + (walletBalance ?? 0) : null
  const keySummary = key === null ? null : {
    unlimited: key.limit_usd === null,
    limit: amount(key.limit_usd),
    spent: amount(key.spent_usd),
    held: amount(key.held_usd),
    remaining: key.limit_usd === null ? null : amount(key.remaining_usd),
  }
  const validKey = keySummary !== null && (keySummary.unlimited || [keySummary.limit, keySummary.spent, keySummary.held, keySummary.remaining].some((v) => v !== null))
  const today = point(usage?.today)
  const daily = records(usage?.series).flatMap((row) => {
    const value = point(row)
    return value === null || typeof row.bucket !== 'string' ? [] : [{ ...value, date: row.bucket }]
  })
  const models = records(usage?.models).flatMap((model) => {
    const name = text(model.model_display_name) ?? text(model.model_slug)
    const points = records(model.points)
    if (name === null || points.length === 0) return []
    return [{ name, requests: sum(points.map((p) => amount(p.request_count))), cost: sum(points.map((p) => amount(p.charged_usd_total))) }]
  })
  if (balance === null && packageBalance === null && walletBalance === null && !validKey && today === null && daily.length === 0 && models.length === 0) return null
  const expiresAt = text(plan?.expires_at)
  const r4: R4Usage = {
    packageBalance, walletBalance,
    packageExpiresAt: expiresAt !== null && Number.isFinite(Date.parse(expiresAt)) ? expiresAt : null,
    key: validKey ? keySummary : null, today, daily, models,
  }
  return {
    authenticated: true, planType: text(plan?.package_name), primary: null, secondary: null, monthly: null,
    rateLimitReachedType: null, resetCredits: null, capturedAt: new Date().toISOString(),
    provider: { id: 'r4', displayName: 'R4 Coder', baseUrl: 'https://api.r4.codes', capability: 'official-usage', logoUrl: '' },
    providerBalance: {
      upstreamUrl: 'https://api.r4.codes', currency: 'USD', unit: 'USD', balance, remaining: balance,
      used: null, total: null, requests: null, inputTokens: null, outputTokens: null,
      planName: text(plan?.package_name), details: [], r4,
    },
  }
}

function record(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record).filter((v): v is Record<string, unknown> => v !== null) : [] }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value.trim() : null }
function amount(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(value))) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}
function sum(values: readonly (number | null)[]): number | null { return values.length === 0 || values.some((v) => v === null) ? null : values.reduce<number>((total, value) => total + value!, 0) }
function point(value: unknown): R4UsagePoint | null {
  const row = record(value)
  if (row === null) return null
  const result = {
    requests: amount(row.request_count), cost: amount(row.charged_usd_total),
    inputTokens: amount(row.prompt_tokens_total), outputTokens: amount(row.completion_tokens_total),
    cacheReadTokens: amount(row.cache_read_tokens_total), cacheCreationTokens: amount(row.cache_creation_tokens_total),
  }
  return Object.values(result).some((v) => v !== null) ? result : null
}
