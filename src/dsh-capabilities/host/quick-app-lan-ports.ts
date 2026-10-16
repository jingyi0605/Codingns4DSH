import { randomBytes, X509Certificate } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { isIP } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { QUICK_APP_LIMITS, quickAppTransportErrorCode, type QuickAppRuntimeReason } from '../../shared/contracts/quick-apps.js'
import type { QuickAppLanTransport, QuickAppOriginLease, QuickAppOriginProvider } from './quick-app-origin-adapter.js'
import { endQuickAppResponse, quickAppCredentials } from './quick-app-credentials.js'

export interface QuickAppLanPortsConfig {
  readonly transport: 'lan-ports'
  readonly publicHost: string
  readonly uiOrigins: readonly string[]
  readonly ports: readonly [number, number]
  readonly stateDirectory: string
  readonly certFile: string
  readonly keyFile: string
}

export function parseQuickAppLanPortsConfig(value: unknown): QuickAppLanPortsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable('config-invalid')
  const c = value as QuickAppLanPortsConfig
  if (Object.keys(c).some(key => !['transport', 'publicHost', 'uiOrigins', 'ports', 'stateDirectory', 'certFile', 'keyFile'].includes(key))
    || c.transport !== 'lan-ports' || typeof c.publicHost !== 'string' || c.publicHost.length > 253
    || !validHost(c.publicHost) || !Array.isArray(c.ports) || c.ports.length !== 2
    || !c.ports.every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
    || c.ports[0] > c.ports[1] || c.ports[1] - c.ports[0] >= 16384
    || ![c.stateDirectory, c.certFile, c.keyFile].every(path => typeof path === 'string' && isAbsolute(path))
    || !Array.isArray(c.uiOrigins) || c.uiOrigins.length < 1 || c.uiOrigins.length > 16) throw unavailable('config-invalid')
  for (const origin of c.uiOrigins) {
    let url: URL
    try { url = new URL(origin) } catch { throw unavailable('config-invalid') }
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || !validHost(url.hostname)
      || url.hostname === c.publicHost && Number(url.port || 443) >= c.ports[0] && Number(url.port || 443) <= c.ports[1]) throw unavailable('config-invalid')
  }
  return structuredClone(c)
}

function validHost(host: string): boolean {
  try { if (new URL(`https://${host}`).hostname !== host) return false } catch { return false }
  const ip = host.replace(/^\[|\]$/gu, '')
  if (isIP(ip)) return ip !== '0.0.0.0' && ip !== '::' && ip !== '::1' && !/^127\./u.test(ip) && !ip.startsWith('::ffff:')
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(host)
    && host.split('.').every(label => label.length <= 63) && !host.endsWith('.localhost')
}

/** Browsers cannot forge these headers; they are an origin fence, never authentication. */
export function sameBrowserOrigin(headers: Record<string, string | string[] | undefined>, origin: string): boolean {
  if (headers.origin !== undefined && headers.origin !== origin) return false
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return false
  if (headers.origin === origin || site === 'same-origin') return true
  // A fallback for clients that omit Fetch Metadata. No-referrer clients fail closed.
  try { return typeof headers.referer === 'string' && new URL(headers.referer).origin === origin } catch { return false }
}

function unavailable(reason: QuickAppRuntimeReason): Error {
  return Object.assign(new Error(`Quick Apps transport unavailable: ${reason}.`), { code: quickAppTransportErrorCode(reason), reason })
}

/** Dedicated app HTTPS ports on the existing LAN bind address; no DSH forwarding. */
export class QuickAppLanPortsProvider implements QuickAppOriginProvider, QuickAppLanTransport {
  readonly isolation = 'lan-port' as const
  private listenHost: string | undefined
  private stopped = false
  private pending: Promise<void> = Promise.resolve()
  private readonly active = new Set<() => Promise<void>>()
  private readonly reserved = new Set<number>()
  private allocationFailure: QuickAppRuntimeReason | undefined
  private generation = 0
  private readonly config: QuickAppLanPortsConfig

  constructor(config: QuickAppLanPortsConfig, private readonly tls: { cert: string; key: string }) {
    this.config = parseQuickAppLanPortsConfig(config)
    const cert = new X509Certificate(tls.cert)
    const ip = config.publicHost.replace(/^\[|\]$/gu, '')
    if (!(isIP(ip) ? cert.checkIP(ip) : cert.checkHost(config.publicHost))
      || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw unavailable('config-invalid')
    const probe = createServer({ ...tls, minVersion: 'TLSv1.2' }); probe.close()
  }

  /** Read persistent reservations before availability is advertised. Never delete this history. */
  async initialize(): Promise<void> {
    await mkdir(this.config.stateDirectory, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(this.config.stateDirectory)) {
      if (/^\d+\.json$/u.test(entry)) this.reserved.add(Number(entry.slice(0, -5)))
    }
  }

  started(listenHost: string): void { this.listenHost = listenHost; this.generation++; this.allocationFailure = undefined }
  async stopping(): Promise<void> {
    this.listenHost = undefined; this.generation++
    await this.pending.catch(() => undefined)
    await Promise.all([...this.active].map(dispose => dispose()))
  }
  async dispose(): Promise<void> { this.stopped = true; await this.stopping() }
  available(uiOrigin?: string): boolean { return this.diagnostic(uiOrigin) === undefined }
  protects(uiOrigin?: string): boolean { return !this.stopped && Boolean(this.listenHost) && Boolean(uiOrigin && this.config.uiOrigins.includes(uiOrigin)) }
  diagnostic(uiOrigin?: string): QuickAppRuntimeReason | undefined {
    if (this.stopped || !this.listenHost) return 'lan-stopped'
    if (!uiOrigin || !this.config.uiOrigins.includes(uiOrigin)) return 'ui-not-allowed'
    if (this.allocationFailure) return this.allocationFailure
    for (let port = this.config.ports[0]; port <= this.config.ports[1]; port++) if (!this.reserved.has(port)) return undefined
    return 'ports-exhausted'
  }

  permits(headers: Record<string, string>, method: string, path: string): boolean {
    if ((method === 'GET' || method === 'HEAD') && path === '/' && !headers.upgrade
      && headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document') return true
    // App configuration must not become an allowlist for ordinary DSH addresses.
    // Block only origins owned by this app transport, including retired ports.
    for (const value of [headers.origin, headers.referer]) {
      if (value === undefined) continue
      try {
        const url = new URL(value)
        if (url.hostname === this.config.publicHost && this.reserved.has(Number(url.port || 443))) return false
      } catch { if (value === 'null') return false }
    }
    return true
  }

  open(handler: (request: IncomingMessage, response: ServerResponse) => void, uiOrigin?: string): Promise<QuickAppOriginLease> {
    const operation = this.pending.catch(() => undefined).then(() => this.allocate(handler, uiOrigin))
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async allocate(handler: (request: IncomingMessage, response: ServerResponse) => void, uiOrigin?: string): Promise<QuickAppOriginLease> {
    const reason = this.diagnostic(uiOrigin)
    if (reason) throw unavailable(reason)
    if (this.active.size >= QUICK_APP_LIMITS.launches) throw unavailable('ports-busy')
    const generation = this.generation
    let busy = false
    for (let port = this.config.ports[0]; port <= this.config.ports[1]; port++) {
      if (this.reserved.has(port)) continue
      const origin = `https://${this.config.publicHost}:${port}`
      const cookieName = `__Host-quickapp-${randomBytes(16).toString('hex')}`
      const credentials = quickAppCredentials(origin, uiOrigin!, cookieName)
      let alive = true
      const server = createServer({ ...this.tls, minVersion: 'TLSv1.2', maxHeaderSize: 16 * 1024, handshakeTimeout: 10_000 }, (req, res) => {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Content-Type-Options', 'nosniff')
        const sni = (req.socket as TLSSocket).servername
        if (!alive || generation !== this.generation) return endQuickAppResponse(res, 410)
        if (req.headers.host !== new URL(origin).host || sni && sni !== this.config.publicHost
          || req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'host').length !== 1) return endQuickAppResponse(res, 421)
        // Only the one-use landing page accepts cross-origin navigation from the DSH viewer.
        if (req.url !== '/__quickapp/bootstrap' && !sameBrowserOrigin(req.headers, origin)) return endQuickAppResponse(res, 403)
        // Browser cookies have no port scope. Strip every cookie except this launch's before
        // passing the request to the application service; never forward general credentials.
        const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`))
        req.headers.cookie = cookies.join('; ')
        delete req.headers.authorization
        req.rawHeaders = req.rawHeaders.flatMap((value, i, headers) => i % 2 || ['cookie', 'authorization'].includes(value.toLowerCase()) ? [] : [value, headers[i + 1]!])
        if (cookies.length) req.rawHeaders.push('Cookie', cookies.join('; '))
        void credentials.handle(req, res).then(handled => { if (!handled && alive) handler(req, res) }).catch(() => endQuickAppResponse(res, 400))
      })
      server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.timeout = 30_000
      server.keepAliveTimeout = 5_000; server.maxConnections = 128; server.maxRequestsPerSocket = 100
      const dispose = async () => {
        if (!alive) return
        alive = false; credentials.dispose(); this.active.delete(dispose)
        await close(server)
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, this.listenHost, () => { server.removeListener('error', reject); resolve() })
        })
        server.on('error', () => { void dispose() })
        // Atomic create makes independent Host instances sharing this history race safely.
        await writeFile(join(this.config.stateDirectory, `${port}.json`), JSON.stringify({ origin, allocatedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
        this.reserved.add(port)
        if (this.stopped || generation !== this.generation) { await dispose(); throw unavailable('lan-stopped') }
        this.active.add(dispose)
        return { origin, uiOrigin: uiOrigin!, ownerHostId: 'local', remote: true, cookieName, isolation: 'lan-port', activate: credentials.activate, dispose }
      } catch (error) {
        await dispose()
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') { this.reserved.add(port); continue }
        if (code === 'EADDRINUSE') { busy = true; continue }
        throw error
      }
    }
    if (!busy) this.allocationFailure = 'ports-exhausted'
    throw unavailable(busy ? 'ports-busy' : 'ports-exhausted')
  }
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
}
