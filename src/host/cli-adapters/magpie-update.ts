import type {
  MagpieUpdateActionResult,
  MagpieUpdateNotes,
  MagpieUpdateReleaseNote,
  MagpieUpdateState,
  MagpieUpdateStatus,
} from '../../shared/contracts/magpie-management.js'
import { isVersionAtLeast } from '../../shared/contracts/version.js'
import type { MagpieWebService, MagpieWebRequestOptions } from './magpie-web.js'

export const MAGPIE_UPDATE_MINIMUM_VERSION = '0.1.1322' as const
const BACKGROUND_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const UPDATE_POLL_INTERVAL_MS = 250
const UPDATE_POLL_TIMEOUT_MS = 30_000
const MAX_RELEASES = 100
const MAX_TEXT_LENGTH = 256_000
const UPDATE_STATES = new Set<MagpieUpdateState>([
  'checking', 'latest', 'found', 'downloading', 'ready', 'available', 'source', 'error', 'blocked',
])

export interface MagpieUpdateServiceOptions {
  readonly webApi?: Pick<MagpieWebService, 'requestJson'> & Partial<Pick<MagpieWebService, 'requestJsonOrNoContent'>>
  /** The version is supplied by the Host's existing Magpie installation detection. */
  readonly version?: () => string | null
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly pollIntervalMs?: number
  readonly pollTimeoutMs?: number
}

export class MagpieUpdateError extends Error {
  constructor(readonly code: 'CODINGNS_MAGPIE_UPDATE_UNSUPPORTED' | 'CODINGNS_MAGPIE_UPDATE_INVALID' | 'CODINGNS_MAGPIE_UPDATE_CONFIRMATION_REQUIRED', message: string) {
    super(message)
    this.name = code
  }
}

/**
 * Owns the fixed Magpie update surface. No caller supplies an arbitrary Web API path.
 *
 * Background work only observes `/api/update`; Magpie remains responsible for its own feed
 * schedule. Download/install/restart is reachable only through `installUpdate({ confirmed: true })`.
 */
export class MagpieUpdateService {
  private readonly webApi: MagpieUpdateServiceOptions['webApi']
  private readonly version: () => string | null
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number
  private backgroundTimer: ReturnType<typeof setInterval> | null = null
  private backgroundRead: Promise<void> | null = null

  constructor(options: MagpieUpdateServiceOptions = {}) {
    this.webApi = options.webApi
    this.version = options.version ?? (() => null)
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? delay
    this.pollIntervalMs = options.pollIntervalMs ?? UPDATE_POLL_INTERVAL_MS
    this.pollTimeoutMs = options.pollTimeoutMs ?? UPDATE_POLL_TIMEOUT_MS
  }

  async readStatus(signal?: AbortSignal): Promise<MagpieUpdateStatus> {
    this.assertSupported()
    const value = await this.requestJson('/api/update', signal)
    return parseMagpieUpdateStatus(value)
  }

  async readNotes(signal?: AbortSignal): Promise<MagpieUpdateNotes> {
    this.assertSupported()
    const value = await this.requestJson('/api/update/notes', signal)
    return parseMagpieUpdateNotes(value)
  }

  /** Start a feed check, then poll until the check leaves the `checking` state. */
  async checkForUpdate(signal?: AbortSignal): Promise<MagpieUpdateStatus> {
    this.assertSupported()
    const value = await this.requestJson('/api/update/check', signal, { method: 'POST' })
    let status = parseMagpieUpdateStatus(value)
    if (status.state !== 'checking') return status
    const deadline = this.now() + this.pollTimeoutMs
    while (status.state === 'checking' && this.now() < deadline) {
      await this.sleepWithSignal(this.pollIntervalMs, signal)
      status = await this.readStatus(signal)
    }
    if (status.state === 'checking') throw new Error('Magpie update status polling timed out')
    return status
  }

  /**
   * Request Magpie's immediate install/download/restart path.
   *
   * The explicit confirmation is checked in the Host as well as in the page. This prevents an
   * old Client from accidentally turning a read-only update panel into an install action.
   */
  async installUpdate(input: unknown, signal?: AbortSignal): Promise<MagpieUpdateActionResult> {
    this.assertSupported()
    if (!isConfirmedInstall(input)) throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_CONFIRMATION_REQUIRED', 'Magpie update requires explicit confirmation')
    const before = await this.readStatus(signal)
    if (!['found', 'ready', 'available', 'error'].includes(before.state)) {
      throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', `Magpie cannot install from update state ${before.state}`)
    }
    const response = await this.requestJsonOrNoContent('/api/update/install', signal, {
      method: 'POST',
      body: { view: 'codingns-magpie-management', when: 'now' },
    })
    // A successful install may return an acknowledgement before Magpie hands the Web
    // process over to the new binary. Only status reads/checks require a full status shape.
    const status = response === null ? null : parseInstallResponse(response)
    const restartExpected = before.state === 'ready' || status === null
    return { requested: true, restartExpected, status }
  }

  /**
   * Observe Magpie's own update state in the background without asking it to download or install.
   * The timer is deliberately stopped with the Host feature.
   */
  startBackgroundChecks(): void {
    if (this.backgroundTimer !== null) return
    void this.observeInBackground()
    this.backgroundTimer = setInterval(() => { void this.observeInBackground() }, BACKGROUND_CHECK_INTERVAL_MS)
    const timer = this.backgroundTimer as unknown as { unref?: () => void }
    timer.unref?.()
  }

  stopBackgroundChecks(): void {
    if (this.backgroundTimer === null) return
    clearInterval(this.backgroundTimer)
    this.backgroundTimer = null
  }

  dispose(): void {
    this.stopBackgroundChecks()
  }

  private async observeInBackground(): Promise<void> {
    if (this.backgroundRead !== null) return this.backgroundRead
    const read = this.readStatus().then(() => undefined, () => undefined)
    this.backgroundRead = read
    try { await read } finally {
      if (this.backgroundRead === read) this.backgroundRead = null
    }
  }

  private assertSupported(): void {
    const version = this.version()
    if (version === null || !isVersionAtLeast(version, MAGPIE_UPDATE_MINIMUM_VERSION)) {
      throw new MagpieUpdateError(
        'CODINGNS_MAGPIE_UPDATE_UNSUPPORTED',
        `Magpie update Web API requires Magpie ${MAGPIE_UPDATE_MINIMUM_VERSION} or later`,
      )
    }
  }

  private async requestJson(path: '/api/update' | '/api/update/notes' | '/api/update/check', signal?: AbortSignal, options: MagpieWebRequestOptions = {}): Promise<unknown> {
    if (this.webApi === undefined) throw new Error('Magpie Web API is unavailable')
    return this.webApi.requestJson(path, { ...options, ...(signal === undefined ? {} : { signal }) })
  }

  private async requestJsonOrNoContent(path: '/api/update/install', signal?: AbortSignal, options: MagpieWebRequestOptions = {}): Promise<unknown | null> {
    if (this.webApi === undefined) throw new Error('Magpie Web API is unavailable')
    if (this.webApi.requestJsonOrNoContent !== undefined) {
      return this.webApi.requestJsonOrNoContent(path, { ...options, ...(signal === undefined ? {} : { signal }) })
    }
    return this.webApi.requestJson(path, { ...options, ...(signal === undefined ? {} : { signal }) })
  }

  private async sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) return this.sleep(milliseconds)
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Request cancelled')
    await Promise.race([
      this.sleep(milliseconds),
      new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled')), { once: true })),
    ])
  }
}

export function parseMagpieUpdateStatus(value: unknown): MagpieUpdateStatus {
  const record = asRecord(value)
  if (record === null || typeof record.state !== 'string' || !UPDATE_STATES.has(record.state as MagpieUpdateState)
    || typeof record.current !== 'string' || record.current.length > 128) {
    throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', 'Magpie returned an unsupported update status')
  }
  return {
    state: record.state as MagpieUpdateState,
    current: record.current,
    latest: optionalText(record.latest, 128, 'latest'),
    notes: optionalText(record.notes, MAX_TEXT_LENGTH, 'notes'),
    url: optionalUrl(record.url),
    stuck: optionalText(record.stuck, 128, 'stuck'),
    error: optionalText(record.error, MAX_TEXT_LENGTH, 'error'),
    retry: optionalBoolean(record.retry, 'retry'),
    done: optionalNonNegativeInteger(record.done),
    total: optionalNonNegativeInteger(record.total),
    size: optionalNonNegativeInteger(record.size),
    waiting: optionalBoolean(record.waiting, 'waiting'),
    gaveUp: optionalBoolean(record.gaveUp, 'gaveUp'),
  }
}

function parseInstallResponse(value: unknown): MagpieUpdateStatus | null {
  try {
    return parseMagpieUpdateStatus(value)
  } catch (error) {
    if (error instanceof MagpieUpdateError && error.code === 'CODINGNS_MAGPIE_UPDATE_INVALID') return null
    throw error
  }
}

export function parseMagpieUpdateNotes(value: unknown): MagpieUpdateNotes {
  const record = asRecord(value)
  if (record === null || !Array.isArray(record.releases) || record.releases.length > MAX_RELEASES) {
    throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', 'Magpie returned unsupported update notes')
  }
  const releases: MagpieUpdateReleaseNote[] = []
  for (const item of record.releases) {
    const release = asRecord(item)
    if (release === null || typeof release.version !== 'string' || release.version.length > 128
      || typeof release.notes !== 'string' || release.notes.length > MAX_TEXT_LENGTH) {
      throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', 'Magpie returned an invalid update release note')
    }
    releases.push({ version: release.version, notes: release.notes, url: optionalUrl(release.url) })
  }
  return {
    latest: optionalText(record.latest, 128, 'latest'),
    releases,
    error: optionalText(record.error, MAX_TEXT_LENGTH, 'error'),
  }
}

function isConfirmedInstall(value: unknown): boolean {
  const record = asRecord(value)
  return record?.confirmed === true
}

function optionalText(value: unknown, maximum: number, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > maximum) {
    throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', `Magpie update field ${field} is invalid`)
  }
  return value
}

function optionalUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', 'Magpie update URL is invalid')
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
    return url.toString()
  } catch {
    throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', 'Magpie update URL is invalid')
  }
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', 'Magpie update progress is invalid')
  }
  return value as number
}

function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') {
    throw new MagpieUpdateError('CODINGNS_MAGPIE_UPDATE_INVALID', `Magpie update field ${field} is invalid`)
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
