import type { IncomingMessage, ServerResponse } from 'node:http'
import type { QuickAppRuntimeReason, QuickAppProxyRequest, QuickAppProxyResponse } from '../../shared/contracts/quick-apps.js'
import { QUICK_APP_DESKTOP_ORIGIN, quickAppProxyBase } from '../../shared/quick-app-proxy-path.js'

/** Internal service supplied by a verified transport composition, never by an RPC payload. */
export interface QuickAppOriginLease {
  readonly origin: string
  readonly ownerHostId: string
  readonly uiOrigin: string
  readonly remote: boolean
  readonly cookieName: string
  /** Supplied only by the LAN adapter with an attached privileged-request guard. */
  readonly isolation?: 'lan-port' | 'sandbox-proxy'
  readonly basePath?: string
  /** Deliver only this launch's credential through the transport's verified browser channel. */
  activate(credential: string, entryPath: string): Promise<{ readonly url: string }>
  dispose(): Promise<void>
}

export interface QuickAppOriginProvider {
  readonly isolation?: 'lan-port' | 'sandbox-proxy'
  open(handler: (request: IncomingMessage, response: ServerResponse) => void, uiOrigin?: string): Promise<QuickAppOriginLease>
  available?(uiOrigin?: string): boolean
  diagnostic?(uiOrigin?: string): QuickAppRuntimeReason | undefined
  requestResource?(basePath: string, request: QuickAppProxyRequest, signal: AbortSignal): Promise<QuickAppProxyResponse>
}

/** LAN lifecycle and request admission stay at the transport boundary. */
export interface QuickAppLanTransport {
  started(listenHost: string): void
  stopping(): Promise<void>
  permits(headers: Record<string, string>, method: string, path: string): boolean
  protects(uiOrigin?: string): boolean
}

export const QUICK_APP_ORIGIN_UNAVAILABLE = 'No verified isolated app origin is available for this connection. DSH path routes and PeerHost relays cannot host executable apps safely.'

/** A prefix route is deliberately insufficient; the Host must install a dedicated provider. */
export function supportsQuickAppOrigins(provider: unknown): provider is QuickAppOriginProvider {
  return typeof provider === 'object' && provider !== null && typeof (provider as QuickAppOriginProvider).open === 'function'
}

export function validateQuickAppOrigin(lease: QuickAppOriginLease, ownerHostId: string, occupied: ReadonlySet<string>): void {
  const app = new URL(lease.origin)
  const ui = new URL(lease.uiOrigin)
  if (lease.isolation === 'sandbox-proxy') {
    const matchesUi = lease.uiOrigin === QUICK_APP_DESKTOP_ORIGIN
      ? app.protocol === 'http:' && app.hostname === '127.0.0.1' && !lease.remote
      : ['http:', 'https:'].includes(ui.protocol) && ui.origin === lease.uiOrigin && app.origin === ui.origin
    if (!matchesUi || app.origin !== lease.origin
      || lease.ownerHostId !== ownerHostId || !lease.basePath || quickAppProxyBase(lease.basePath) !== lease.basePath) throw new Error(QUICK_APP_ORIGIN_UNAVAILABLE)
    return
  }
  const loopback = (host: string) => host === 'localhost' || host.endsWith('.localhost') || /^127\./u.test(host)
    || host === '[::1]' || host === '[::]' || host === '0.0.0.0' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/iu.test(host)
  if (!['http:', 'https:'].includes(ui.protocol) || ui.origin !== lease.uiOrigin || !['http:', 'https:'].includes(app.protocol) || app.origin !== lease.origin || app.username || app.password
    || app.pathname !== '/' || app.search || app.hash || app.hostname.endsWith('.') || app.origin === ui.origin || occupied.has(app.origin)
    || lease.ownerHostId !== ownerHostId || (ui.protocol === 'https:' && app.protocol !== 'https:')
    || (lease.remote && (loopback(app.hostname) || app.protocol !== 'https:'))
    || !/^[A-Za-z0-9_-]{1,80}$/u.test(lease.cookieName)) throw new Error(QUICK_APP_ORIGIN_UNAVAILABLE)
  // Port isolation also needs cookie admission on both app and privileged LAN listeners.
  if (lease.isolation === 'lan-port') {
    if (app.protocol !== 'https:') throw new Error(QUICK_APP_ORIGIN_UNAVAILABLE)
  } else if (app.hostname === ui.hostname || [...occupied].some(origin => new URL(origin).hostname === app.hostname)) throw new Error(QUICK_APP_ORIGIN_UNAVAILABLE)
}
