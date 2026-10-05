import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import type { CliSubscriptionUsage } from '../../shared/contracts/subscription.js'

type SpawnSyncLike = typeof spawnSync

export interface QoderSubscriptionOptions {
  readonly variant?: 'qoder' | 'qoder-cn'
  readonly binaries?: readonly string[]
  readonly spawnSync?: SpawnSyncLike
  readonly homeDirectory?: string
  readonly logsDirectory?: string
}

type QoderVariant = 'qoder' | 'qoder-cn'

/**
 * Qoder 官方订阅余量读取器。
 *
 * Qoder CLI 没有公开 quota 子命令，但它在执行只读模型目录刷新时会调用
 * `/api/v2/quota/usage`，并将脱敏响应写入本地运行日志。读取器只解析这份
 * 本地日志，不接触 Qoder 的登录凭据，也不向外部网络自行发请求。
 */
export class QoderSubscriptionService {
  private readonly variant: 'qoder' | 'qoder-cn'
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: SpawnSyncLike
  private readonly homeDirectory: string
  private readonly logsDirectory: string
  private command: string | null = null

  constructor(options: QoderSubscriptionOptions = {}) {
    this.variant = options.variant ?? 'qoder-cn'
    this.binaries = options.binaries ?? (this.variant === 'qoder-cn' ? ['qodercn', 'qoderclicn'] : ['qoder', 'qodercli'])
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.homeDirectory = options.homeDirectory ?? homedir()
    this.logsDirectory = options.logsDirectory ?? join(this.homeDirectory, this.variant === 'qoder-cn' ? '.qoder-cn' : '.qoder', 'logs', 'runs')
  }

  async read(): Promise<CliSubscriptionUsage | null> {
    // 先读已经存在的最新快照，避免每次打开订阅浮层都拉起 CLI。
    const cached = readLatestQoderQuota(this.logsDirectory, this.variant)
    if (cached !== null) return cached
    // 首次安装或日志轮换后用 CLI 的只读目录命令触发一次官方刷新。
    this.command ??= detectQoderCommand(this.runSpawnSync, this.binaries, this.variant, this.homeDirectory)
    if (this.command === null) return null
    try {
      this.runSpawnSync(this.command, ['--list-models'], {
        encoding: 'utf8', timeout: 20_000, windowsHide: true,
        env: qoderEnvironment(this.variant, process.env),
      } as SpawnSyncOptions & { encoding: 'utf8' })
    } catch { return null }
    return readLatestQoderQuota(this.logsDirectory, this.variant)
  }
}

export function readLatestQoderQuota(logsDirectory: string, variant: QoderVariant = 'qoder-cn'): CliSubscriptionUsage | null {
  let candidates: string[]
  try {
    candidates = readdirSync(logsDirectory)
      .map((name) => join(logsDirectory, name))
      .filter((path) => {
        try { return statSync(path).isDirectory() } catch { return false }
      })
      .sort()
      .reverse()
  } catch { return null }
  // CLI 每次探测都会创建一个 run 目录，模型目录命中缓存时当前目录不再
  // 记录 quota；因此必须向前查找全部近期日志，而不能只看最后一次运行。
  for (const directory of candidates) {
    let files: string[]
    try { files = readdirSync(directory).filter((name) => name === 'qodercli.log') } catch { continue }
    for (const name of files) {
      let text: string
      try { text = readFileSync(join(directory, name), 'utf8') } catch { continue }
      const matches = [...text.matchAll(/\[qoderApi\]\s+GET\s+[^\n]*\/api\/v2\/quota\/usage\s+response:\s+(\{.*\})\s*$/gmu)]
      for (const match of matches.reverse()) {
        try {
          const value: unknown = JSON.parse(match[1]!)
          const usage = normalizeQoderQuota(value, variant)
          if (usage !== null) return usage
        } catch { /* 单行日志损坏不影响继续查找旧快照 */ }
      }
    }
  }
  return null
}

function normalizeQoderQuota(value: unknown, variant: QoderVariant): CliSubscriptionUsage | null {
  if (!isRecord(value)) return null
  const quota = isRecord(value.userQuota) ? value.userQuota : value
  const total = numberValue(quota.total)
  const used = numberValue(quota.used)
  const remaining = numberValue(quota.remaining)
  if (total === null && used === null && remaining === null) return null
  const totalCredits = total ?? Math.max(0, (used ?? 0) + (remaining ?? 0))
  const usedCredits = used ?? Math.max(0, totalCredits - (remaining ?? 0))
  const usedPercent = clamp(numberValue(value.totalUsagePercentage) ?? (totalCredits > 0 ? usedCredits / totalCredits * 100 : 0))
  const expiresAt = timestamp(value.expiresAt)
  const provider = variant === 'qoder-cn'
    ? { id: 'qoder-cn', displayName: 'Qoder CN', baseUrl: 'https://openapi.qoder.com.cn', logoUrl: 'https://cdn.simpleicons.org/qoder' }
    : { id: 'qoder', displayName: 'Qoder', baseUrl: 'https://openapi.qoder.com', logoUrl: 'https://cdn.simpleicons.org/qoder' }
  return {
    authenticated: true,
    planType: text(value.userType),
    primary: {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowDurationMins: null,
      resetsAt: expiresAt,
      ...(remaining === null ? {} : { remainingCredits: remaining }),
      ...(total === null ? {} : { totalCredits: total }),
    },
    secondary: null,
    monthly: null,
    rateLimitReachedType: value.isQuotaExceeded === true ? 'quota' : null,
    resetCredits: null,
    credits: {
      hasCredits: true,
      unlimited: false,
      balance: remaining === null ? null : String(remaining),
    },
    capturedAt: new Date().toISOString(),
    provider: { ...provider, capability: 'subscription-window' },
  }
}

function detectQoderCommand(run: SpawnSyncLike, binaries: readonly string[], variant: 'qoder' | 'qoder-cn', homeDirectory: string): string | null {
  for (const command of binaries) {
    try {
      const result = run(command, ['--version'], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true,
        env: qoderEnvironment(variant, process.env, homeDirectory),
      } as SpawnSyncOptions & { encoding: 'utf8' })
      if (result.status === 0 && /\b\d+\.\d+(?:\.\d+)?\b/u.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) return command
    } catch { /* 继续探测下一个候选 */ }
  }
  return null
}

function qoderEnvironment(variant: 'qoder' | 'qoder-cn', source: NodeJS.ProcessEnv, _homeDirectory?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source }
  if (variant === 'qoder-cn') {
    delete env.QODER_PERSONAL_ACCESS_TOKEN
    delete env.QODER_USER_CONFIG_DIR
    env.QODERCN_USER_CONFIG_DIR = '.qoder-cn'
  } else {
    delete env.QODERCN_PERSONAL_ACCESS_TOKEN
    delete env.QODERCN_USER_CONFIG_DIR
    env.QODER_USER_CONFIG_DIR = '.qoder'
  }
  return env
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value.trim() : null }
function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null
}
function timestamp(value: unknown): number | null {
  const n = numberValue(value)
  if (n === null) return null
  // DSH 的 resetsAt 契约使用 Unix 秒；Qoder quota 接口的 expiresAt 使用 Unix 毫秒。
  // 统一转换为秒，避免把毫秒直接交给倒计时造成数百万天的显示结果。
  return n > 10_000_000_000 ? Math.trunc(n / 1_000) : Math.trunc(n)
}
function clamp(value: number): number { return Math.max(0, Math.min(100, value)) }
