import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { commandEnvironment, resolveCommandPath, terminateChildProcess, WINDOWS, windowsShellInvocation } from './process-utils.js'

const WEB_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/u
const START_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface MagpieWebRequestOptions {
  readonly method?: 'GET' | 'POST'
  readonly body?: unknown
  readonly signal?: AbortSignal
}

export interface MagpieWebServiceOptions {
  readonly fetch?: typeof fetch
  readonly resolveCommand?: () => Promise<string | null>
  readonly spawn?: typeof spawn
  readonly webKey?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly startupTimeoutMs?: number
}

/** Owns only the `magpie web` child started by this Host and its authenticated API session. */
export class MagpieWebService {
  private readonly requestFetch: typeof fetch
  private readonly resolveCommand: NonNullable<MagpieWebServiceOptions['resolveCommand']>
  private readonly spawnProcess: NonNullable<MagpieWebServiceOptions['spawn']>
  private readonly environment: NodeJS.ProcessEnv
  private readonly cwd: string
  private readonly startupTimeoutMs: number
  private readonly key: string
  private child: ChildProcess | null = null
  private baseUrl: URL | null = null
  private startup: Promise<void> | null = null
  private stopped = false
  private disposed = false
  private lifecycle = 0

  constructor(options: MagpieWebServiceOptions = {}) {
    this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.resolveCommand = options.resolveCommand ?? (() => resolveCommandPath('magpie'))
    this.spawnProcess = options.spawn ?? spawn
    this.environment = options.environment ?? process.env
    this.cwd = options.cwd ?? process.cwd()
    this.startupTimeoutMs = options.startupTimeoutMs ?? START_TIMEOUT_MS
    const configuredKey = options.webKey ?? this.environment.MAGPIE_WEB_KEY ?? ''
    this.key = WEB_KEY_PATTERN.test(configuredKey) ? configuredKey : randomBytes(32).toString('base64url')
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('Magpie Web service has been disposed')
    this.stopped = false
    if (this.child !== null && this.baseUrl !== null) return
    if (this.startup !== null) return this.startup
    const lifecycle = this.lifecycle
    const starting = this.startMagpieWeb(lifecycle)
    this.startup = starting
    try {
      await starting
    } finally {
      if (this.startup === starting) this.startup = null
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.lifecycle += 1
    const child = this.child
    this.child = null
    this.baseUrl = null
    if (child !== null) await this.stopChild(child)
    await this.startup?.catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  async requestJson(path: string, options: MagpieWebRequestOptions = {}): Promise<unknown> {
    if (!/^\/api\/[A-Za-z0-9_./?=&%-]{1,600}$/u.test(path) || path.includes('..')) {
      throw new TypeError('Invalid Magpie Web API route')
    }
    await this.start()
    if (this.baseUrl === null || this.child === null) throw new Error('Magpie Web is not running')
    return this.fetchJson(this.baseUrl, this.key, path, options)
  }

  private async startMagpieWeb(lifecycle: number): Promise<void> {
    const command = await this.resolveCommand()
    if (command === null) throw new Error('Magpie CLI is unavailable')
    if (this.stopped || lifecycle !== this.lifecycle) throw new Error('Magpie Web startup was cancelled')
    const invocation = WINDOWS && /\.(?:cmd|bat)$/iu.test(command)
      ? windowsShellInvocation(command, ['web', '--addr', '127.0.0.1:0', '--no-open'])
      : { command, args: ['web', '--addr', '127.0.0.1:0', '--no-open'] }
    const child = this.spawnProcess(invocation.command, [...invocation.args], {
      cwd: this.cwd,
      env: {
        ...commandEnvironment(command, this.environment),
        MAGPIE_WEB_KEY: this.key,
        MAGPIE_WEB_URL: '',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      detached: !WINDOWS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      ...(WINDOWS && /\.(?:cmd|bat)$/iu.test(command) ? { windowsVerbatimArguments: true } : {}),
    })
    this.child = child
    child.once('error', () => {
      if (this.child === child) { this.child = null; this.baseUrl = null }
    })
    child.once('exit', () => {
      if (this.child === child) { this.child = null; this.baseUrl = null }
    })

    const deadline = Date.now() + this.startupTimeoutMs
    let startupOutput = ''
    let webPort: number | null = null
    const readStartupOutput = (chunk: Buffer | string): void => {
      startupOutput = `${startupOutput}${chunk.toString()}`.slice(-8_192)
      const match = startupOutput.match(/\bmagpie web on http:\/\/127\.0\.0\.1:(\d+)(?:\/|\s)/u)
      if (match !== null) {
        const port = Number(match[1])
        if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) webPort = port
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', readStartupOutput)
    while (Date.now() < deadline) {
      if (this.stopped || lifecycle !== this.lifecycle || this.child !== child || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Magpie Web stopped before it became ready')
      }
      if (webPort === null) {
        await delay(50)
        continue
      }
      const baseUrl = new URL(`http://127.0.0.1:${webPort}`)
      this.baseUrl = baseUrl
      try {
        const value = await this.fetchJson(baseUrl, this.key, '/api/providers', {})
        if (isRecord(value) && Array.isArray(value.providers)) return
      } catch {
        if (this.stopped || lifecycle !== this.lifecycle || this.child !== child) {
          throw new Error('Magpie Web stopped before it became ready')
        }
      }
      await delay(200)
    }
    child.stdout?.off('data', readStartupOutput)
    await this.stopChild(child)
    throw new Error('Magpie Web did not become ready before the startup timeout')
  }

  private async fetchJson(baseUrl: URL, key: string, path: string, options: MagpieWebRequestOptions): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const loginUrl = new URL('/', baseUrl)
    loginUrl.searchParams.set('k', key)
    const login = await this.requestFetch(loginUrl, {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal,
      headers: { accept: 'text/html' },
    })
    const location = login.headers.get('location')
    const cookie = readPortCookie(login.headers, baseUrl, key)
    await discard(login)
    if (login.status !== 303 || location === null || cookie === null) throw new Error('Magpie Web authentication failed')
    const redirected = new URL(location, baseUrl)
    if (redirected.origin !== baseUrl.origin || redirected.pathname !== '/' || redirected.search !== '' || redirected.hash !== '') {
      throw new Error('Magpie Web returned an unexpected authentication redirect')
    }
    const response = await this.requestFetch(new URL(path, baseUrl), {
      method: options.method ?? 'GET', redirect: 'error', cache: 'no-store', signal,
      headers: {
        accept: 'application/json',
        cookie,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    if (!response.ok) {
      await discard(response)
      throw new Error(`Magpie Web API returned HTTP ${response.status}`)
    }
    const value = await readBoundedJson(response)
    if (value === null) throw new Error('Magpie Web API returned an invalid or oversized response')
    return value
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (this.child === child) {
      this.child = null
      this.baseUrl = null
    }
    if (child.exitCode !== null || child.signalCode !== null) return
    if (!WINDOWS && typeof child.pid === 'number') {
      try { process.kill(-child.pid, 'SIGTERM') } catch { terminateChildProcess(child) }
    } else terminateChildProcess(child)
    await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), delay(2_000)])
    if (child.exitCode === null && child.signalCode === null) {
      if (!WINDOWS && typeof child.pid === 'number') {
        try { process.kill(-child.pid, 'SIGKILL') } catch { terminateChildProcess(child, 'SIGKILL') }
      } else terminateChildProcess(child, 'SIGKILL')
    }
  }
}

function readPortCookie(headers: Headers, baseUrl: URL, key: string): string | null {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() ?? [headers.get('set-cookie') ?? '']
  const expected = `magpie_web_${baseUrl.port || (baseUrl.protocol === 'https:' ? '443' : '80')}`
  for (const value of values) {
    const pair = value.split(';', 1)[0] ?? ''
    const separator = pair.indexOf('=')
    if (separator > 0 && pair.slice(0, separator) === expected && pair.slice(separator + 1) === key) return pair
  }
  return null
}

async function readBoundedJson(response: Response): Promise<unknown | null> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) { await discard(response); return null }
  const reader = response.body?.getReader()
  if (reader === undefined) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return null }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch { return null }
}

async function discard(response: Response): Promise<void> { await response.body?.cancel().catch(() => undefined) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
