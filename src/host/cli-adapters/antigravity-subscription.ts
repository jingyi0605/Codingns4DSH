import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type {
  CliSubscriptionGroup,
  CliSubscriptionGroupWindow,
  CliSubscriptionQuotaWindowKind,
  CliSubscriptionUsage,
  CliSubscriptionWindow,
} from '../../shared/contracts/subscription.js'
import { commandEnvironment, resolveCommandPath, terminateChildProcess } from './process-utils.js'
import { antigravityCommandEnvironment, spawnAntigravity } from './antigravity-updater.js'
import { resolveAntigravityModelId } from './model-catalog.js'

const USAGE_CACHE_MS = 15 * 60_000
const FAILURE_BACKOFF_MS = 10 * 60_000
const TIMEOUT_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 6 * 60 * 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const USAGE_AGENT = 'codingns-usage'
const WINDOW_KINDS: Readonly<Record<string, CliSubscriptionQuotaWindowKind>> = {
  '5h': 'five-hour', '5hr': 'five-hour', 'five-hour': 'five-hour', weekly: 'weekly', monthly: 'monthly',
}

export interface AntigravitySubscriptionReadOptions {
  readonly modelId?: string | undefined
}

export interface AntigravitySubscriptionOptions {
  /** Only used to resolve the default model from AGY settings. */
  readonly homeDirectory?: string
  readonly readFile?: (path: string) => string
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly platform?: string
  readonly spawn?: typeof spawn
  readonly spawnSync?: typeof spawnSync
  readonly resolveCommand?: () => string | null
  readonly resolveModelId?: (modelId: string | undefined) => string | null
}

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

interface QuotaSnapshot {
  readonly groups: readonly AntigravityQuotaGroupDraft[]
  readonly capturedAt: number
}

type CommandResult = { readonly stdout: string; readonly stderr: string; readonly code: number | null; readonly timedOut: boolean }

/** Reads only agy's built-in /usage command; never opens OAuth stores or calls Google APIs. */
export class AntigravitySubscriptionService {
  private timeoutMs: number
  private readonly now: () => number
  private readonly platform: string
  private readonly runSpawn: typeof spawn
  private readonly runSpawnSync: typeof spawnSync
  private readonly resolveCommand: (() => string | null) | undefined
  private readonly resolveModelId: (modelId: string | undefined) => string | null
  private readonly lifetime = new AbortController()
  private cached: QuotaSnapshot | null = null
  private pending: Promise<QuotaSnapshot | null> | null = null
  private nextReadAt = 0
  private failures = 0

  constructor(options: AntigravitySubscriptionOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.now = options.now ?? Date.now
    this.platform = options.platform ?? process.platform
    this.runSpawn = options.spawn ?? spawn
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.resolveCommand = options.resolveCommand
    this.resolveModelId = options.resolveModelId ?? ((modelId) => resolveAntigravityModelId(modelId, options))
  }

  /** Settings updates change future deadlines without discarding cache/backoff or in-flight work. */
  setTimeoutMs(timeoutMs: number): void {
    this.timeoutMs = timeoutMs
  }

  async read(options: AntigravitySubscriptionReadOptions = {}): Promise<CliSubscriptionUsage | null> {
    if (this.lifetime.signal.aborted) return null
    if (this.pending !== null) {
      const snapshot = await this.pending
      return snapshot === null || this.lifetime.signal.aborted ? null : this.buildUsage(snapshot, options.modelId)
    }
    if (this.now() < this.nextReadAt) {
      return this.cached === null ? null : this.buildUsage(this.cached, options.modelId)
    }
    this.pending = this.readQuotaFromCli()
    try {
      const snapshot = await this.pending
      return snapshot === null || this.lifetime.signal.aborted ? null : this.buildUsage(snapshot, options.modelId)
    } finally {
      this.pending = null
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.cached = null
    await this.pending
  }

  private async readQuotaFromCli(): Promise<QuotaSnapshot | null> {
    let directory: string | undefined
    try {
      const command = this.resolveCommand === undefined
        ? await resolveCommandPath('agy', this.runSpawnSync)
        : this.resolveCommand()
      if (this.lifetime.signal.aborted) return null
      if (command === null) return this.fail()
      directory = await mkdtemp(join(tmpdir(), 'codingns-agy-usage-'))
      const agentDirectory = join(directory, '.agents', 'agents', USAGE_AGENT)
      await mkdir(agentDirectory, { recursive: true })
      await writeFile(join(agentDirectory, 'agent.md'), [
        '---', `name: ${USAGE_AGENT}`, 'description: Read CLI usage only',
        'mainAgent: true', 'subagent: false', 'tools: []', 'mcpServers: []',
        '---', 'Do not run model prompts or tools.', '',
      ].join('\n'), { mode: 0o600 })
      const browser = join(directory, this.platform === 'win32' ? 'open.cmd' : 'open')
      if (this.platform === 'win32') {
        await writeFile(browser, '@exit /b 1\r\n')
      } else {
        for (const name of ['open', 'xdg-open']) {
          await writeFile(join(directory, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
        }
      }
      if (this.lifetime.signal.aborted) return null
      const env = antigravityCommandEnvironment(commandEnvironment(command), this.platform)
      const inheritedPath = env.PATH ?? env.Path ?? ''
      for (const key of Object.keys(env)) {
        if (/^path$/iu.test(key)) delete env[key]
      }
      env.PATH = directory + delimiter + inheritedPath
      env.BROWSER = browser
      const result = await this.runUsageCommand(command, directory, env)
      if (this.lifetime.signal.aborted) return null
      // Refusals win even if a partial quota table was printed before the error.
      if (isAntigravityUsageRefusal(result.stdout, result.stderr)) return this.fail(MAX_BACKOFF_MS)
      if (result.timedOut) return this.fail(TIMEOUT_BACKOFF_MS)
      if (result.code !== 0) return this.fail()
      const groups = parseAntigravityUsageOutput(result.stdout)
      if (groups.length === 0) return this.fail()
      const capturedAt = this.now()
      this.failures = 0
      this.nextReadAt = capturedAt + USAGE_CACHE_MS
      this.cached = { groups, capturedAt }
      return this.cached
    } catch {
      return this.lifetime.signal.aborted ? null : this.fail()
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }

  private fail(firstDelay = FAILURE_BACKOFF_MS): null {
    this.cached = null
    this.failures += 1
    this.nextReadAt = this.now() + Math.min(firstDelay * 2 ** Math.min(this.failures - 1, 20), MAX_BACKOFF_MS)
    return null
  }

  private runUsageCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawnAntigravity(this.runSpawn, command, [
        '-p', '/usage', '--output-format', 'json', '--agent', USAGE_AGENT,
        '--print-timeout', `${Math.max(1, Math.ceil(this.timeoutMs / 1000))}s`,
      ], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let settled = false
      const finish = (code: number | null, timedOut = false, terminate = false): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.lifetime.signal.removeEventListener('abort', abort)
        if (terminate) terminateChildProcess(child)
        child.stdout?.destroy()
        child.stderr?.destroy()
        resolve({ stdout, stderr, code, timedOut })
      }
      const abort = (): void => finish(null, false, true)
      const timer = setTimeout(() => finish(null, true, true), this.timeoutMs)
      this.lifetime.signal.addEventListener('abort', abort, { once: true })
      const collect = (stream: 'stdout' | 'stderr') => (chunk: string): void => {
        if (settled) return
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_OUTPUT_BYTES) { finish(null, false, true); return }
        if (stream === 'stdout') stdout += chunk
        else stderr += chunk
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', collect('stdout'))
      child.stderr?.on('data', collect('stderr'))
      child.stdout?.on('error', abort)
      child.stderr?.on('error', abort)
      child.once('error', abort)
      child.once('close', (code) => finish(code))
      if (this.lifetime.signal.aborted) abort()
    })
  }

  private buildUsage(snapshot: QuotaSnapshot, modelId: string | undefined): CliSubscriptionUsage | null {
    const groups = toContractGroups(snapshot.groups)
    const selected = selectAntigravityQuotaGroupIn(groups, this.effectiveModelId(modelId)) ?? groups[0]!
    const primary = findGroupWindow(selected, 'five-hour')
    const secondary = findGroupWindow(selected, 'weekly')
    if (primary === null && secondary === null) return null
    const rateLimited = groups.some((group) => group.windows.some((entry) => entry.window.remainingPercent <= 0))
    return {
      authenticated: true,
      planType: null,
      primary,
      secondary,
      monthly: null,
      groups,
      activeGroupId: selected.id,
      rateLimitReachedType: rateLimited ? 'quota' : null,
      resetCredits: null,
      capturedAt: new Date(snapshot.capturedAt).toISOString(),
      provider: {
        id: 'antigravity',
        displayName: 'Antigravity',
        baseUrl: '',
        capability: 'subscription-window',
        logoUrl: 'https://cdn.simpleicons.org/google',
      },
    }
  }

  private effectiveModelId(modelId: string | undefined): string | null {
    const explicit = modelId?.trim()
    if (explicit !== undefined && explicit !== '' && explicit !== 'provider-default') return explicit.toLowerCase()
    return this.resolveModelId(modelId)
  }
}

function isAntigravityUsageRefusal(stdout: string, stderr: string): boolean {
  let diagnostic = stdout
  try {
    const report = recordValue(JSON.parse(stdout))
    diagnostic = JSON.stringify([report?.error, report?.response])
  } catch { /* Legacy text includes CLI diagnostics alongside the quota table. */ }
  const output = `${diagnostic}\n${stderr}`
  return /\b403\b|terms of service|TOS[_ -]VIOLATION|verification required|verify your account|not (?:logged|signed) in|unauthenticated|authentication required|login required|please (?:log|sign) in|sign in again|invalid_grant|未登录|需要验证/iu.test(output)
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
  let report: unknown
  try { report = JSON.parse(output) } catch { /* Older agy versions print a TSV table. */ }
  if (report !== undefined) {
    const root = recordValue(report)
    const command = recordValue(root?.command)
    return root?.status === 'SUCCESS' && command?.name === 'usage'
      ? readAntigravityQuotaGroups(command.data) : []
  }
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

/** Parse the CLI's JSON command report, including protobuf-style remaining values. */
export function readAntigravityQuotaGroups(value: unknown): readonly AntigravityQuotaGroupDraft[] {
  const groups = recordValue(value)?.groups
  if (!Array.isArray(groups)) return []
  const parsed: AntigravityQuotaGroupDraft[] = []
  for (const entry of groups) {
    const group = recordValue(entry)
    if (group === null) continue
    const windows: AntigravityQuotaWindowDraft[] = []
    for (const raw of Array.isArray(group.buckets) ? group.buckets : []) {
      const bucket = recordValue(raw)
      if (bucket === null || bucket.disabled === true) continue
      const remaining = recordValue(bucket.remaining)
      const fraction = numberValue(bucket.remainingFraction ?? bucket.remaining_fraction
        ?? remaining?.remainingFraction ?? remaining?.remaining_fraction
        ?? (remaining?.case === 'remainingFraction' ? remaining.value : undefined))
      if (fraction === null || fraction < 0 || fraction > 1) continue
      const label = textValue(bucket.displayName ?? bucket.display_name) ?? textValue(bucket.name)
        ?? textValue(bucket.bucketId ?? bucket.bucket_id ?? bucket.id) ?? ''
      const window = textValue(bucket.window)?.toLowerCase()
      windows.push({
        kind: window === undefined || window === null ? windowKindFromLabel(label) : WINDOW_KINDS[window] ?? 'other',
        label,
        remainingFraction: fraction,
        resetsAt: timestampSeconds(bucket.resetTime ?? bucket.reset_time),
      })
    }
    if (windows.length > 0) parsed.push({ displayName: textValue(group.displayName ?? group.display_name) ?? textValue(group.name) ?? '', windows })
  }
  return parsed
}

/**
 * Select the quota group belonging to the active model.
 *
 * Antigravity currently reports separate groups for “Gemini Models”, “Claude and GPT
 * models”, and “Gemini 4 Argon”. Unknown models use the first returned group.
 */
export function selectAntigravityQuotaGroup(
  groups: readonly AntigravityQuotaGroupDraft[],
  modelId: string | null,
): AntigravityQuotaGroupDraft | null {
  return selectQuotaGroup(groups, modelId)
}

function selectAntigravityQuotaGroupIn(
  groups: readonly CliSubscriptionGroup[],
  modelId: string | null,
): CliSubscriptionGroup | null {
  return selectQuotaGroup(groups, modelId)
}

function selectQuotaGroup<T extends { readonly id?: string; readonly displayName: string }>(
  groups: readonly T[],
  modelId: string | null,
): T | null {
  const bareModelId = bareAntigravityModelId(modelId)
  const modelKey = slugifyQuotaName(bareModelId)
  if (modelKey !== '') {
    // Match model-specific pools (such as "Gemini 4 Argon") only for models
    // belonging to that pool, so sibling models like Gemini 4 Hydrogen do not
    // get routed into Argon's quota bucket.
    const specific = groups.find((group) => isSpecificGroupMatch(group.displayName, modelKey))
    if (specific !== undefined) return specific
  }
  const prefix = antigravityQuotaGroupPrefix(bareModelId)
  if (prefix === '3p-') {
    return groups.find((group) => (group.id ?? quotaGroupId(group.displayName)) === 'third-party')
      ?? groups.find((group) => antigravityQuotaGroupPrefixForDisplayName(group.displayName) === '3p-')
      ?? groups[0]
      ?? null
  }
  if (prefix === 'gemini-4-') {
    const genericGemini4 = groups.find((group) => isGenericGemini4Group(group.displayName))
    if (genericGemini4 !== undefined) return genericGemini4
  }
  return groups.find((group) => (group.id ?? quotaGroupId(group.displayName)) === 'gemini')
    ?? groups.find((group) => antigravityQuotaGroupPrefixForDisplayName(group.displayName) === 'gemini-')
    ?? groups[0]
    ?? null
}

function isSpecificGroupMatch(displayName: string, modelKey: string): boolean {
  const slug = slugifyQuotaName(displayName)
  if (slug === '' || isThirdPartyGroupName(displayName) || slug === 'gemini' || slug === 'gemini-models' || isGenericGemini4Group(displayName)) {
    return false
  }
  return modelKey === slug || modelKey.startsWith(`${slug}-`)
}

function isGenericGemini4Group(displayName: string): boolean {
  const slug = slugifyQuotaName(displayName)
  return slug === 'gemini-4' || slug === 'gemini-4-models'
}

export function antigravityQuotaGroupPrefix(modelId: string | null): string {
  const normalized = bareAntigravityModelId(modelId).toLowerCase()
  if (/^(?:claude|gpt(?:-|$))/u.test(normalized)) return '3p-'
  if (/^gemini-4(?:-|$)/u.test(normalized)) return 'gemini-4-'
  return 'gemini-'
}

function bareAntigravityModelId(modelId: string | null): string {
  const trimmed = modelId?.trim() ?? ''
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

function toContractGroups(drafts: readonly AntigravityQuotaGroupDraft[]): readonly CliSubscriptionGroup[] {
  const usedIds = new Set<string>()
  return drafts.map((draft) => {
    const candidate = quotaGroupId(draft.displayName)
    const slug = slugifyQuotaName(draft.displayName) || 'other'
    const id = !usedIds.has(candidate) ? candidate : !usedIds.has(slug) ? slug : `${slug}-${usedIds.size}`
    usedIds.add(id)
    return {
      id,
      displayName: draft.displayName,
      windows: draft.windows.map((window): CliSubscriptionGroupWindow => ({
        kind: window.kind,
        label: window.label,
        window: toWindow(window.remainingFraction, window.resetsAt),
      })),
    }
  })
}

/** 分组 id 供客户端本地化；未知分组回退到上游展示名。 */
function quotaGroupId(displayName: string): string {
  if (isThirdPartyGroupName(displayName)) return 'third-party'
  const normalized = displayName.trim().toLowerCase()
  if (/\bgemini[\s-]*4\b/u.test(normalized)) return 'gemini-4'
  if (normalized === 'gemini' || normalized === 'gemini models') return 'gemini'
  return slugifyQuotaName(normalized) || 'other'
}

function slugifyQuotaName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
}

function antigravityQuotaGroupPrefixForDisplayName(displayName: string): string {
  const normalized = displayName.trim().toLowerCase()
  if (isThirdPartyGroupName(displayName)) return '3p-'
  if (/\bgemini[\s-]*4\b/u.test(normalized)) return 'gemini-4-'
  if (normalized.includes('gemini')) return 'gemini-'
  return normalized.replace(/[^a-z0-9]+/gu, '-') || 'other-'
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
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
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed / 1000) : null
  }
  const numeric = numberValue(value)
  if (numeric === null || numeric <= 0) return null
  return Math.round(numeric > 10_000_000_000 ? numeric / 1000 : numeric)
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(4))))
}
