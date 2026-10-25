export const CODINGNS_PACKAGE_NAME = '@jingyi0605/codingns4dsh' as const
export const CODINGNS_GITHUB_REPOSITORY = 'jingyi0605/Codingns4DSH' as const
export const CODINGNS_NPM_REGISTRY = 'https://registry.npmjs.org' as const

export type PluginUpdateChannelKind = 'latest' | 'next' | 'exact'

export interface PluginUpdateChannel {
  readonly kind: PluginUpdateChannelKind
  readonly version?: string
}

export type PluginUpdateCheckState =
  | 'up-to-date'
  | 'update-available'
  | 'no-newer-version'
  | 'incompatible'
  | 'compatibility-unknown'
  | 'unavailable'
  | 'unsupported'

export type PluginCompatibilityState = 'compatible' | 'incompatible' | 'unknown'

export interface PluginCompatibility {
  readonly state: PluginCompatibilityState
  readonly dshVersion: string | null
  readonly required?: string
  readonly reason?: string
}

export type PluginReleaseState = 'available' | 'unavailable' | 'missing'

export interface PluginReleaseRecord {
  readonly state: PluginReleaseState
  readonly tag: string
  readonly title: string | null
  readonly publishedAt: string | null
  readonly commit: string | null
  readonly body: string
  readonly url: string
  readonly reason?: string
}

export interface PluginUpdateTarget {
  readonly version: string
  readonly publishedAt: string | null
  readonly distTags: readonly string[]
  readonly gitHead: string | null
  readonly compatibility: PluginCompatibility
  readonly release: PluginReleaseRecord
}

export interface PluginUpdateRuntime {
  readonly runningHostVersion: string | null
  readonly installedVersion: string | null
  readonly managerAvailable: boolean
  readonly applyBlockCode?: string
}

export interface PluginUpdateCheckResult {
  readonly packageName: typeof CODINGNS_PACKAGE_NAME
  readonly runningHostVersion: string | null
  readonly runningClientVersion: string | null
  readonly installedVersion: string | null
  readonly channel: PluginUpdateChannel
  readonly target: PluginUpdateTarget | null
  readonly state: PluginUpdateCheckState
  readonly checkedAt: string
  readonly managerAvailable: boolean
  readonly canApply: boolean
  readonly applyBlockCode?: string
  readonly reason?: string
}

export type PluginActivationStateName =
  | 'not-requested'
  | 'pending'
  | 'active'
  | 'restart-required'
  | 'unsupported'
  | 'failed'
  | 'unknown'

export interface PluginActivationState {
  readonly state: PluginActivationStateName
  readonly version: string | null
  readonly code?: string
}

export type PluginPackageState = 'unchanged' | 'installed' | 'rolled-back' | 'unknown'

export type PluginUpdateApplication =
  | 'applied-without-desktop-restart'
  | 'restart-required'
  | 'failed'
  | 'cancelled'
  | 'unsupported'
  | 'activation-unknown'

export interface PluginUpdateApplyResult {
  readonly operationId: string
  readonly targetVersion: string
  readonly packageState: PluginPackageState
  readonly hostActivation: PluginActivationState
  readonly clientReload: PluginActivationState
  readonly application: PluginUpdateApplication
  readonly nextStep: string
  readonly managerAvailable: boolean
  readonly errorCode?: string
}

export interface PluginUpdateStatusResult {
  readonly operationId: string
  readonly revision: number
  readonly targetVersion: string
  readonly state: 'applying' | 'completed'
  readonly phase: 'installing' | 'cancelling' | 'applying' | 'completed'
  readonly cancellationAvailable: boolean
  readonly result?: PluginUpdateApplyResult
}

export function validatePluginUpdateChannel(value: unknown): PluginUpdateChannel {
  if (!isRecord(value) || (value.kind !== 'latest' && value.kind !== 'next' && value.kind !== 'exact')) {
    throw updateError('UPDATE_INVALID_CHANNEL')
  }
  if (value.kind === 'exact') {
    if (typeof value.version !== 'string' || !isSemver(value.version)) throw updateError('UPDATE_INVALID_CHANNEL')
    return { kind: 'exact', version: value.version }
  }
  return { kind: value.kind }
}

export function isSemver(value: string): boolean {
  return value.length <= 128 && parseSemver(value) !== null
}

export function updateError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

/** Compare two semver values without treating prerelease strings lexically. */
export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (a === null || b === null) throw new Error('Invalid semver')
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/u.test(leftPart)
    const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (leftNumeric && leftPart.length !== rightPart.length) return leftPart.length - rightPart.length
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/** Evaluate the simple npm DSH ranges used by the supported package manifests. */
export function evaluateDshCompatibility(range: string | undefined, dshVersion: string | null): PluginCompatibility {
  if (dshVersion === null || !isSemver(dshVersion)) return { state: 'unknown', dshVersion, ...(range === undefined ? {} : { required: range }), reason: 'Running DSH version is unavailable' }
  if (range === undefined || range.trim() === '') {
    return { state: 'unknown', dshVersion, reason: 'The target does not declare a DSH range' }
  }
  if (range.length > 512) return { state: 'unknown', dshVersion, reason: 'DSH range exceeds the size limit' }
  const alternatives = range.split('||').map((part) => part.trim()).filter(Boolean)
  const supported = alternatives.some((candidate) => isSupportedSimpleRange(candidate) && evaluateSimpleRange(candidate, dshVersion))
  if (supported) return { state: 'compatible', dshVersion, required: range }
  if (alternatives.length > 0 && alternatives.every((candidate) => isSupportedSimpleRange(candidate))) {
    return { state: 'incompatible', dshVersion, required: range, reason: `DSH ${dshVersion} does not satisfy ${range}` }
  }
  return { state: 'unknown', dshVersion, required: range, reason: `Unsupported DSH range syntax: ${range}` }
}

function evaluateSimpleRange(range: string, version: string): boolean {
  const tokens = range.split(/\s+/u).filter(Boolean)
  if (tokens.length === 1 && isSemver(tokens[0]!)) return compareSemver(version, tokens[0]!) === 0
  if (tokens.length === 1 && (tokens[0]!.startsWith('^') || tokens[0]!.startsWith('~'))) return evaluateCaretOrTilde(tokens[0]!, version)
  return tokens.every((token) => evaluateComparator(token, version))
}

function evaluateCaretOrTilde(token: string, version: string): boolean {
  const operator = token[0]
  const base = token.slice(1)
  if (!isSemver(base)) return false
  const upper = parseSemver(base)
  if (upper === null) return false
  const upperVersion = operator === '^'
    ? upper.major > 0 ? `${upper.major + 1}.0.0` : upper.minor > 0 ? `0.${upper.minor + 1}.0` : `0.0.${upper.patch + 1}`
    : `${upper.major}.${upper.minor + 1}.0`
  return compareSemver(version, base) >= 0 && compareSemver(version, `${upperVersion}-0`) < 0
}

function evaluateComparator(token: string, version: string): boolean {
  const match = /^(>=|<=|>|<|=)?(.*)$/u.exec(token)
  const operator = match?.[1] ?? '='
  const target = match?.[2] ?? ''
  if (!isSemver(target)) return false
  const comparison = compareSemver(version, target)
  switch (operator) {
    case '>=': return comparison >= 0
    case '<=': return comparison <= 0
    case '>': return comparison > 0
    case '<': return comparison < 0
    default: return comparison === 0
  }
}

function isSupportedSimpleRange(range: string): boolean {
  const tokens = range.split(/\s+/u).filter(Boolean)
  return tokens.length > 0 && tokens.every((token) => {
    if (token.startsWith('^') || token.startsWith('~')) return tokens.length === 1 && isSemver(token.slice(1))
    const match = /^(>=|<=|>|<|=)?(.*)$/u.exec(token)
    return match !== null && isSemver(match[2]!)
  })
}

interface ParsedSemver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

function parseSemver(value: string): ParsedSemver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value)
  if (match === null || match[4]?.split('.').some((part) => /^0\d+$/u.test(part))) return null
  if (!match.slice(1, 4).map(Number).every(Number.isSafeInteger)) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4]?.split('.') ?? [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
