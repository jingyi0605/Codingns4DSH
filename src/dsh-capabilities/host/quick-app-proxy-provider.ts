import { randomBytes } from 'node:crypto'
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { QuickAppOriginLease, QuickAppOriginProvider } from './quick-app-origin-adapter.js'
import { QUICK_APP_DESKTOP_ORIGIN, QUICK_APP_PROXY_PREFIX } from '../../shared/quick-app-proxy-path.js'
import { QUICK_APP_LIMITS, type QuickAppProxyRequest, type QuickAppProxyResponse } from '../../shared/contracts/quick-apps.js'
import { quickAppProxyBase } from '../../shared/quick-app-proxy-path.js'
import type { QuickAppProxyServer } from './quick-app-proxy-adapter.js'

/** Use the existing Host listener. Each viewer gets an opaque sandbox and a scoped route. */
export class QuickAppProxyProvider implements QuickAppOriginProvider {
  readonly isolation = 'sandbox-proxy' as const
  private stopped = false
  private readonly releases = new Set<() => Promise<void>>()
  private readonly handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  private releaseRoute: (() => void | Promise<void>) | undefined
  constructor(private readonly server: QuickAppProxyServer) {}
  private previewOrigin(uiOrigin?: string): string | undefined {
    try {
      const desktop = uiOrigin === QUICK_APP_DESKTOP_ORIGIN
      const origin = desktop ? this.server.getOrigin() : uiOrigin!
      const url = new URL(origin)
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return undefined
      if (desktop && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')) return undefined
      return origin
    } catch { return undefined }
  }
  available(uiOrigin?: string): boolean {
    return !this.stopped && this.previewOrigin(uiOrigin) !== undefined
  }
  async open(handler: (req: IncomingMessage, res: ServerResponse) => void, uiOrigin?: string): Promise<QuickAppOriginLease> {
    const origin = this.previewOrigin(uiOrigin)
    if (this.stopped || !origin) throw Object.assign(new Error('The Host preview route is unavailable on this connection.'), { code: 'QUICK_APP_ORIGIN_UNAVAILABLE' })
    const basePath = `${QUICK_APP_PROXY_PREFIX}${randomBytes(32).toString('base64url')}/`
    const cookieName = 'quickapp-proxy'
    let credential: string | undefined
    let active = true
    if (!this.releaseRoute) this.releaseRoute = this.server.register({ kind: 'prefix', path: QUICK_APP_PROXY_PREFIX.slice(0, -1), handler: async (req, res) => {
      const base = quickAppProxyBase(req.url ?? '')
      const serve = base && this.handlers.get(base)
      if (serve) await serve(req, res)
      else res.writeHead(404, { 'Cache-Control': 'no-store' }).end()
    } })
    this.handlers.set(basePath, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      if (!active || !credential || !req.url?.startsWith(basePath)) { res.writeHead(404).end(); return }
      if (![new URL(origin).host, new URL(this.server.getOrigin()).host].includes(req.headers.host ?? '')) {
        res.writeHead(421).end(); return
      }
      // The authenticated management connection created this route. The random route
      // binds the request to that launch; browser headers never select a workspace.
      req.url = `/${req.url.slice(basePath.length)}`
      req.headers.cookie = `${cookieName}=${credential}`
      delete req.headers.authorization
      req.headers.host = new URL(origin).host
      req.rawHeaders = req.rawHeaders.flatMap((name, index, headers) => index % 2 || ['cookie', 'authorization', 'host'].includes(name.toLowerCase()) ? [] : [name, headers[index + 1]!])
      req.rawHeaders.push('Host', req.headers.host, 'Cookie', req.headers.cookie)
      handler(req, res)
    })
    const dispose = async () => { if (!active) return; active = false; credential = undefined; this.handlers.delete(basePath); this.releases.delete(dispose) }
    this.releases.add(dispose)
    return { origin, uiOrigin: uiOrigin!, ownerHostId: 'local', remote: false, isolation: 'sandbox-proxy', basePath, cookieName,
      activate: async (value, path) => {
        if (!active) throw new Error('Preview closed.')
        credential = value
        return { url: `${origin}${basePath}${path.replace(/^\//u, '')}` }
      }, dispose }
  }
  async dispose(): Promise<void> {
    this.stopped = true; await Promise.all([...this.releases].map(release => release()))
    await this.releaseRoute?.(); this.releaseRoute = undefined
  }

  /** Existing local Host listener only; callers cannot supply an upstream address. */
  async requestResource(basePath: string, input: QuickAppProxyRequest, signal: AbortSignal): Promise<QuickAppProxyResponse> {
    if (this.stopped || quickAppProxyBase(basePath) !== basePath || !input || !['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(input.method)
      || typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.startsWith('//') || input.path.length > 8192
      || /[\r\n#]/u.test(input.path) || typeof input.headers !== 'object' || !input.headers
      || input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > QUICK_APP_LIMITS.textBytes)) throw new Error('Invalid preview resource request.')
    const headers: Record<string, string> = {}
    for (const name of ['accept', 'origin', 'content-type', 'if-match', 'if-none-match', 'sec-fetch-mode', 'sec-fetch-dest']) {
      const value = input.headers[name]
      if (typeof value === 'string' && value.length < 8192) headers[name] = value
    }
    const endpoint = new URL(this.server.getOrigin())
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('The Host listener is unavailable.')
    return new Promise((resolve, reject) => {
      const req = (endpoint.protocol === 'https:' ? httpsRequest : request)({ hostname: endpoint.hostname.replace(/^\[|\]$/gu, ''), port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80), path: basePath + input.path.slice(1), method: input.method, headers,
        signal, agent: false, timeout: 30_000 }, res => {
        const chunks: Buffer[] = []; let size = 0
        res.on('data', chunk => { size += chunk.length; if (size > QUICK_APP_LIMITS.staticBytes) res.destroy(new Error('Preview response is too large.')); else chunks.push(chunk) })
        res.on('error', reject)
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {}
          for (const name of ['content-type', 'content-length', 'content-security-policy', 'cache-control', 'referrer-policy', 'x-content-type-options', 'location', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers']) {
            const value = res.headers[name]; if (typeof value === 'string') responseHeaders[name] = value
          }
          resolve({ status: res.statusCode!, headers: responseHeaders, bodyBase64: Buffer.concat(chunks).toString('base64') })
        })
      })
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Preview resource request timed out.'))); req.end(input.body)
    })
  }
}
