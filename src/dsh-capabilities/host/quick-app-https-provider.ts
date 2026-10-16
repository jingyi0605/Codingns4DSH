import { randomBytes, X509Certificate } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { QuickAppOriginLease, QuickAppOriginProvider } from './quick-app-origin-adapter.js'
import { QUICK_APP_LIMITS } from '../../shared/contracts/quick-apps.js'
import { endQuickAppResponse as end, quickAppCredentials } from './quick-app-credentials.js'

/** Operator-owned configuration, never settings mirrored to browsers or an RPC argument. */
export interface QuickAppHttpsConfig {
  readonly appDomain: string
  readonly uiOrigins: readonly string[]
  readonly listenHost: string
  readonly listenPort: number
  readonly publicPort: number
  readonly certFile: string
  readonly keyFile: string
}

const cookieName = '__Host-quickapp'
const unavailable = () => Object.assign(new Error('Quick Apps HTTPS configuration is unavailable or invalid.'), { code: 'QUICK_APP_ORIGIN_UNAVAILABLE' })

export function parseQuickAppHttpsConfig(value: unknown): QuickAppHttpsConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  const config = value as QuickAppHttpsConfig
  const keys = ['appDomain', 'uiOrigins', 'listenHost', 'listenPort', 'publicPort', 'certFile', 'keyFile']
  if (Object.keys(config).some(key => !keys.includes(key)) || typeof config.appDomain !== 'string'
    || config.appDomain.length > 190 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(config.appDomain)
    || config.appDomain.split('.').some(label => label.length > 63)
    || config.appDomain === 'localhost' || config.appDomain.endsWith('.localhost') || isIP(config.appDomain)
    || !isIP(config.listenHost) || ![config.listenPort, config.publicPort].every(port => Number.isInteger(port) && port > 0 && port < 65536)
    || ![config.certFile, config.keyFile].every(path => typeof path === 'string' && isAbsolute(path))
    || !Array.isArray(config.uiOrigins) || config.uiOrigins.length < 1 || config.uiOrigins.length > 16) throw unavailable()
  for (const origin of config.uiOrigins) {
    let ui: URL
    try { ui = new URL(origin) } catch { throw unavailable() }
    if (ui.origin !== origin || !['http:', 'https:'].includes(ui.protocol) || ui.username || ui.password
      || ui.hostname === config.appDomain || ui.hostname.endsWith(`.${config.appDomain}`)
      // Conservatively reject even sibling sites under a multi-label public suffix.
      // Different final two DNS labels ensure UI Domain cookies cannot reach app pages.
      || ui.hostname.split('.').slice(-2).join('.') === config.appDomain.split('.').slice(-2).join('.')) throw unavailable()
  }
  return structuredClone(config)
}

/** No listener is started until an authenticated user opens an HTML app. */
export async function configuredQuickAppHttpsProvider(configPath = process.env.CODINGNS_QUICK_APPS_HTTPS_CONFIG): Promise<QuickAppHttpsProvider | undefined> {
  if (!configPath) return undefined
  try {
    if (!isAbsolute(configPath)) throw unavailable()
    const config = parseQuickAppHttpsConfig(JSON.parse(await boundedFile(configPath, 32 * 1024)))
    const [cert, key] = await Promise.all([boundedFile(config.certFile, 128 * 1024), boundedFile(config.keyFile, 64 * 1024)])
    return new QuickAppHttpsProvider(config, { cert, key })
  } catch { throw unavailable() }
}

export async function boundedFile(path: string, limit: number): Promise<string> {
  const { open } = await import('node:fs/promises')
  const file = await open(path, 'r')
  try {
    if (!(await file.stat()).isFile()) throw unavailable()
    const bytes = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > limit) throw unavailable()
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally { await file.close() }
}

interface Route { readonly host: string; handle(request: IncomingMessage, response: ServerResponse): Promise<void> }

/** Dedicated TLS virtual-host listener. It never serves or proxies privileged DSH routes. */
export class QuickAppHttpsProvider implements QuickAppOriginProvider {
  private readonly routes = new Map<string, Route>()
  private server: Server | undefined
  private pending: Promise<void> = Promise.resolve()
  private stopped = false
  constructor(private readonly config: QuickAppHttpsConfig, private readonly tls: { cert: string; key: string }) {
    parseQuickAppHttpsConfig(config)
    const certificate = new X509Certificate(tls.cert)
    if (!certificate.checkHost(`probe.${config.appDomain}`) || Date.parse(certificate.validTo) <= Date.now()
      || Date.parse(certificate.validFrom) > Date.now()) throw unavailable()
    // Validate the key pair before reporting the configured transport as available.
    const probe = createServer({ ...tls, minVersion: 'TLSv1.2' })
    probe.close()
  }
  available(uiOrigin?: string): boolean { return !this.stopped && typeof uiOrigin === 'string' && this.config.uiOrigins.includes(uiOrigin) }
  open(handler: (request: IncomingMessage, response: ServerResponse) => void, uiOrigin?: string): Promise<QuickAppOriginLease> {
    return this.serialize(async () => {
      if (!this.available(uiOrigin) || this.routes.size >= QUICK_APP_LIMITS.launches) throw unavailable()
      await this.listen()
      // Random names are never reused, including across Host/module restarts.
      const hostname = `${randomBytes(24).toString('hex')}.${this.config.appDomain}`
      const origin = `https://${hostname}${this.config.publicPort === 443 ? '' : `:${this.config.publicPort}`}`
      const host = new URL(origin).host
      const credentials = quickAppCredentials(origin, uiOrigin!, cookieName)
      const route: Route = { host, handle: async (request, response) => {
        if (!await credentials.handle(request, response)) handler(request, response)
      } }
      this.routes.set(hostname, route)
      return {
        origin, uiOrigin: uiOrigin!, ownerHostId: 'local', remote: true, cookieName,
        activate: credentials.activate,
        dispose: () => this.serialize(async () => {
          credentials.dispose()
          this.routes.delete(hostname)
          if (this.routes.size === 0) await this.closeListener()
        }),
      }
    })
  }
  dispose(): Promise<void> {
    this.stopped = true
    return this.serialize(async () => { this.routes.clear(); await this.closeListener() })
  }
  private async listen(): Promise<void> {
    if (this.server) return
    const server = createServer({ ...this.tls, minVersion: 'TLSv1.2', handshakeTimeout: 10_000, maxHeaderSize: 16 * 1024 }, (request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      const sni = (request.socket as TLSSocket).servername
      const route = typeof sni === 'string' ? this.routes.get(sni) : undefined
      // Never trust forwarded Host/Origin headers; TLS terminates at this listener.
      if (!route || request.headers.host !== route.host || request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === 'host').length !== 1) return end(response, 421)
      void route.handle(request, response).catch(() => end(response, 400))
    })
    server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.timeout = 30_000
    server.keepAliveTimeout = 5_000; server.maxRequestsPerSocket = 100; server.maxConnections = 256
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.listenPort, this.config.listenHost, () => { server.removeListener('error', reject); resolve() })
    }).catch(() => { server.close(); throw unavailable() })
    // Listener failures must not take down unrelated Host modules.
    server.on('error', () => { void this.dispose() })
    this.server = server
  }
  private async closeListener(): Promise<void> {
    const server = this.server; this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }
}
