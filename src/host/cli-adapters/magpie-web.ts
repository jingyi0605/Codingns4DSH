import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { commandEnvironment, resolveCommandPath, terminateChildProcess, WINDOWS, windowsShellInvocation } from './process-utils.js'

const WEB_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/u
/** `magpie web` announces its page on stdout at every start, an in-place update restart included. */
const WEB_LINK_PATTERN = /\bmagpie web on http:\/\/127\.0\.0\.1:(\d+)(?:\/|\s)/gu
/** Codes a loopback connection fails with when the page's listener moved or went away. */
const CONNECTION_FAILURE_CODE = /^(?:ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)$/u
/** The subset that never reached the page, so a mutation may be sent again as well. */
const CONNECT_FAILURE_CODE = /^(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)$/u
const PORT_ANNOUNCEMENT_WAITS_MS = [100, 200, 400] as const
const START_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 8_000
const AUTH_COOKIE_TTL_MS = 5 * 60_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_ASSET_BYTES = 512 * 1024
const MAGPIE_ASSET_PATH_PATTERN = /^\/(?:icons|api\/icons)\/[A-Za-z0-9._~%~-]{1,320}$/u
const MAGPIE_IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/webp', 'image/x-icon'])

export interface MagpieWebRequestOptions {
  readonly method?: 'GET' | 'POST'
  readonly body?: unknown
  readonly signal?: AbortSignal
}

export interface MagpieWebServiceOptions {
  readonly fetch?: typeof fetch
  readonly resolveCommand?: () => Promise<string | null>
  /** 安装探测已经解析出的入口；设置后优先于 PATH 查找，避免两套解析结果不一致。 */
  readonly startupCommand?: () => string | null
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
  private readonly startupCommand: (() => string | null) | null
  private readonly spawnProcess: NonNullable<MagpieWebServiceOptions['spawn']>
  private readonly environment: NodeJS.ProcessEnv
  private readonly cwd: string
  private readonly startupTimeoutMs: number
  private readonly key: string
  private child: ChildProcess | null = null
  private baseUrl: URL | null = null
  /** 子进程最近一次在 stdout 上声明的页面端口；`magpie web` 原地更新重启后会重新声明。 */
  private announcedPort: number | null = null
  private startup: Promise<void> | null = null
  private stopped = false
  private disposed = false
  private lifecycle = 0
  private authCookie: string | null = null
  private authCookieExpiresAt = 0
  private authLoad: Promise<string> | null = null

  constructor(options: MagpieWebServiceOptions = {}) {
    this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.resolveCommand = options.resolveCommand ?? (() => resolveCommandPath('magpie'))
    this.startupCommand = options.startupCommand ?? null
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
    if (this.child !== null && this.baseUrl !== null) {
      // 更新后的 `magpie web` 会以同一 PID 重启到新的临时端口，这里先跟随最新声明。
      this.adoptAnnouncedPort()
      return
    }
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
    this.announcedPort = null
    this.clearAuthCookie()
    if (child !== null) await this.stopChild(child)
    await this.startup?.catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  async requestJson(path: string, options: MagpieWebRequestOptions = {}): Promise<unknown> {
    assertApiPath(path)
    return this.withStalePageRecovery(() => this.performJson(path, options, false), options.method === 'POST')
  }

  /** Fixed wrappers may accept Magpie's 204 response when an operation hands over to a restart. */
  async requestJsonOrNoContent(path: string, options: MagpieWebRequestOptions = {}): Promise<unknown | null> {
    assertApiPath(path)
    return this.withStalePageRecovery(() => this.performJson(path, options, true), options.method === 'POST')
  }

  /** Fetch a Magpie-owned image through the authenticated Web session. */
  async requestAssetDataUrl(path: string, options: Pick<MagpieWebRequestOptions, 'signal'> = {}): Promise<string | null> {
    let decodedPath: string
    try { decodedPath = decodeURIComponent(path) } catch { throw new TypeError('Invalid Magpie Web asset route') }
    if (!MAGPIE_ASSET_PATH_PATTERN.test(path) || path.includes('..') || decodedPath.includes('..') || decodedPath.includes('\\')) {
      throw new TypeError('Invalid Magpie Web asset route')
    }
    return this.withStalePageRecovery(async () => {
      const baseUrl = await this.ensureRunning()
      return this.fetchAssetDataUrl(baseUrl, this.key, path, options)
    })
  }

  private async performJson(path: string, options: MagpieWebRequestOptions, allowNoContent: boolean): Promise<unknown | null> {
    const baseUrl = await this.ensureRunning()
    return this.fetchJson(baseUrl, this.key, path, options, allowNoContent)
  }

  private async ensureRunning(): Promise<URL> {
    await this.start()
    if (this.baseUrl === null || this.child === null) throw new Error('Magpie Web is not running')
    return this.baseUrl
  }

  /**
   * Magpie applies an update by restarting its own `web` process in place: the PID stays,
   * the ephemeral port changes, and the previous listener stops answering. A connection
   * that never reached the page is retried once against the port it announced again;
   * anything else (an HTTP status, a malformed body, an abort) is reported as it is.
   */
  private async withStalePageRecovery<T>(request: () => Promise<T>, mutation = false): Promise<T> {
    try {
      return await request()
    } catch (error) {
      if (!isConnectionFailure(error, mutation) || !await this.adoptRestartedPort()) throw error
      return request()
    }
  }

  /** Wait briefly for the restarted child to announce its new link, then follow it. */
  private async adoptRestartedPort(): Promise<boolean> {
    if (this.adoptAnnouncedPort()) return true
    for (const wait of PORT_ANNOUNCEMENT_WAITS_MS) {
      await delay(wait)
      if (this.adoptAnnouncedPort()) return true
    }
    return false
  }

  /** Follow the page port the child announced last; the auth cookie is named after the port. */
  private adoptAnnouncedPort(): boolean {
    const announced = this.announcedPort
    if (announced === null || this.child === null || this.baseUrl === null) return false
    if (this.baseUrl.port === String(announced)) return false
    this.baseUrl = new URL(`http://127.0.0.1:${announced}`)
    this.clearAuthCookie()
    return true
  }

  private async startMagpieWeb(lifecycle: number): Promise<void> {
    // 探测结果可能来自用户手动指定的入口，或 Windows 上只有 `.cmd` 的 npm 全局安装。
    const command = this.startupCommand?.() ?? await this.resolveCommand()
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
    this.announcedPort = null
    child.once('error', () => {
      if (this.child === child) { this.child = null; this.baseUrl = null; this.announcedPort = null; this.clearAuthCookie() }
    })
    child.once('exit', () => {
      if (this.child === child) { this.child = null; this.baseUrl = null; this.announcedPort = null; this.clearAuthCookie() }
    })

    const deadline = Date.now() + this.startupTimeoutMs
    let startupOutput = ''
    let webPort: number | null = null
    const readStartupOutput = (chunk: Buffer | string): void => {
      startupOutput = `${startupOutput}${chunk.toString()}`.slice(-8_192)
      // 更新后原地重启的同一个子进程会再打印一次链接：取最后一条声明，启动等待仍用第一条。
      const matches = [...startupOutput.matchAll(WEB_LINK_PATTERN)]
      const last = matches.at(-1)
      if (last === undefined) return
      const port = Number(last[1])
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return
      if (this.child === child) this.announcedPort = port
      if (webPort === null) webPort = port
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
        const value = await this.fetchJson(baseUrl, this.key, '/api/providers', {}, false)
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

  private async fetchJson(baseUrl: URL, key: string, path: string, options: MagpieWebRequestOptions, allowNoContent: boolean): Promise<unknown | null> {
    const response = await this.fetchAuthenticated(baseUrl, key, path, 'application/json', options)
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.clearAuthCookie()
      await discard(response)
      throw new Error(`Magpie Web API returned HTTP ${response.status}`)
    }
    if (allowNoContent && response.status === 204) {
      await discard(response)
      return null
    }
    const value = await readBoundedJson(response)
    if (value === null) throw new Error('Magpie Web API returned an invalid or oversized response')
    return value
  }

  private async fetchAssetDataUrl(baseUrl: URL, key: string, path: string, options: Pick<MagpieWebRequestOptions, 'signal'>): Promise<string | null> {
    const response = await this.fetchAuthenticated(baseUrl, key, path, 'image/*', options)
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.clearAuthCookie()
      await discard(response)
      return null
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLocaleLowerCase() ?? ''
    if (!MAGPIE_IMAGE_TYPES.has(contentType)) {
      await discard(response)
      return null
    }
    const bytes = await readBoundedBytes(response, MAX_ASSET_BYTES)
    return bytes === null ? null : `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
  }

  private async fetchAuthenticated(baseUrl: URL, key: string, path: string, accept: string, options: MagpieWebRequestOptions): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const cookie = await this.getAuthCookie(baseUrl, key, signal)
    return this.requestFetch(new URL(path, baseUrl), {
      method: options.method ?? 'GET', redirect: 'error', cache: 'no-store', signal,
      headers: {
        accept,
        cookie,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }

  private async getAuthCookie(baseUrl: URL, key: string, signal: AbortSignal): Promise<string> {
    if (this.authCookie !== null && Date.now() < this.authCookieExpiresAt) return this.authCookie
    if (this.authLoad !== null) return awaitWithSignal(this.authLoad, signal)
    const load = (async (): Promise<string> => {
      const loginUrl = new URL('/', baseUrl)
      loginUrl.searchParams.set('k', key)
      const login = await this.requestFetch(loginUrl, {
        method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      this.authCookie = cookie
      this.authCookieExpiresAt = Date.now() + AUTH_COOKIE_TTL_MS
      return cookie
    })()
    this.authLoad = load
    try { return await load } finally { if (this.authLoad === load) this.authLoad = null }
  }

  private clearAuthCookie(): void {
    this.authCookie = null
    this.authCookieExpiresAt = 0
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

async function readBoundedBytes(response: Response, maximum: number): Promise<Uint8Array | null> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maximum) { await discard(response); return null }
  const reader = response.body?.getReader()
  if (reader === undefined) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) { await reader.cancel(); return null }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

async function discard(response: Response): Promise<void> { await response.body?.cancel().catch(() => undefined) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function assertApiPath(path: string): void {
  if (!/^\/api\/[A-Za-z0-9_./?=&%-]{1,600}$/u.test(path) || path.includes('..')) {
    throw new TypeError('Invalid Magpie Web API route')
  }
}

/**
 * A loopback connection that never reached the page: the listener moved or went away.
 * A mutation is only retried when the connection was refused, since a reset or a timeout
 * may have happened after Magpie applied it.
 */
function isConnectionFailure(error: unknown, mutation: boolean): boolean {
  if (!(error instanceof TypeError)) return false
  const code = (error as { cause?: { code?: unknown } }).cause?.code
  if (typeof code === 'string') return (mutation ? CONNECT_FAILURE_CODE : CONNECTION_FAILURE_CODE).test(code)
  return !mutation && /\bfetch failed\b/u.test(error.message)
}

function awaitWithSignal<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('请求已取消'))
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('请求已取消'))
    signal.addEventListener('abort', abort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
