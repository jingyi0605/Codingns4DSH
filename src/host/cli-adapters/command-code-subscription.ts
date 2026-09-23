import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CommandCodeSubscriptionUsage, CommandCodeSubscriptionWindow } from '../../shared/contracts/command-code.js'

/**
 * 读取 Command Code 官方订阅余量。
 *
 * API key 只在 Host 进程中读取和使用，返回值不包含 key，也不把响应原文透传给浏览器。
 */
export class CommandCodeSubscriptionService {
  private readonly homeDirectory: string
  private readonly request: typeof fetch
  private readonly timeoutMs: number

  constructor(options: { readonly homeDirectory?: string; readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {}) {
    this.homeDirectory = options.homeDirectory ?? join(homedir(), '.commandcode')
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
  }

  async read(): Promise<CommandCodeSubscriptionUsage | null> {
    const apiKey = readCommandCodeApiKey(this.homeDirectory)
    if (!apiKey) return null
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
      const [creditsResponse, subscriptionResponse] = await Promise.all([
        this.request('https://api.commandcode.ai/alpha/billing/credits', { headers, signal: controller.signal }),
        this.request('https://api.commandcode.ai/alpha/billing/subscriptions', { headers, signal: controller.signal }),
      ])
      if (!creditsResponse.ok) return null
      const credits = await jsonRecord(creditsResponse)
      const subscription = subscriptionResponse.ok ? await jsonRecord(subscriptionResponse) : null
      const windows = recordValue(credits?.windowLimits)
      const subscriptionData = recordValue(subscription?.data)
      const planType = textValue(subscriptionData?.planId)
      const monthlyRemaining = numberValue(recordValue(credits?.credits)?.monthlyCredits)
      const monthlyTotal = resolveMonthlyCreditLimit(planType)
      return {
        authenticated: true,
        planType,
        primary: normalizeWindow(windows?.fiveHour),
        secondary: normalizeWindow(windows?.weekly),
        monthly: monthlyRemaining === null
          ? null
          : normalizeMonthlyWindow(monthlyRemaining, monthlyTotal, timestampValue(subscriptionData?.currentPeriodEnd)),
        rateLimitReachedType: textValue(windows?.exceeded),
        resetCredits: null,
        capturedAt: new Date().toISOString(),
      }
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function readCommandCodeApiKey(homeDirectory: string): string | null {
  const path = join(homeDirectory, 'auth.json')
  if (!existsSync(path)) return null
  try {
    const auth = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return textValue(recordValue(auth)?.apiKey) || textValue(process.env.COMMANDCODE_API_KEY)
  } catch {
    return textValue(process.env.COMMANDCODE_API_KEY)
  }
}

function normalizeWindow(value: unknown): CommandCodeSubscriptionWindow | null {
  const source = recordValue(value)
  if (source === null) return null
  const used = numberValue(source.used)
  const cap = numberValue(source.cap)
  if (used === null || cap === null || cap <= 0) return null
  const usedPercent = clampPercent(used / cap * 100)
  return { usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: null, resetsAt: normalizeResetTimestamp(numberValue(source.resetAt)) }
}

function normalizeMonthlyWindow(remainingCredits: number, totalCredits: number | null, resetAt: number | null): CommandCodeSubscriptionWindow {
  const remainingPercent = totalCredits !== null && totalCredits > 0 ? clampPercent(remainingCredits / totalCredits * 100) : 0
  return {
    usedPercent: totalCredits !== null && totalCredits > 0 ? 100 - remainingPercent : 0,
    remainingPercent,
    windowDurationMins: null,
    resetsAt: normalizeResetTimestamp(resetAt),
    remainingCredits,
    ...(totalCredits === null ? {} : { totalCredits }),
  }
}

function resolveMonthlyCreditLimit(planId: string | null): number | null {
  const normalized = planId?.trim().toLowerCase() ?? ''
  if (normalized.endsWith('-go') || normalized === 'go') return 10
  if (normalized.endsWith('-goat') || normalized === 'goat') return 70
  if (normalized.endsWith('-max') || normalized === 'max') return 150
  return null
}

function normalizeResetTimestamp(value: number | null): number | null {
  if (value === null) return null
  return value > 10_000_000_000 ? Math.round(value / 1000) : Math.round(value)
}

function clampPercent(value: number): number { return Math.max(0, Math.min(100, value)) }
function recordValue(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null }
function textValue(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function numberValue(value: unknown): number | null { const parsed = typeof value === 'number' ? value : Number(value); return Number.isFinite(parsed) ? parsed : null }
function timestampValue(value: unknown): number | null {
  const numeric = numberValue(value)
  if (numeric !== null) return numeric
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
async function jsonRecord(response: Response): Promise<Record<string, unknown> | null> {
  const value: unknown = await response.json()
  return recordValue(value)
}
