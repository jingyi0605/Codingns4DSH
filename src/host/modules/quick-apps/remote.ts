import { createHash, randomUUID } from 'node:crypto'
import type { QuickApp, QuickAppProxyRequest, QuickAppProxyResponse } from '../../../shared/contracts/quick-apps.js'
import { readBody } from './static-handler.js'
import { QUICK_APP_LIMITS } from '../../../shared/contracts/quick-apps.js'
import { QUICK_APP_DESKTOP_ORIGIN } from '../../../shared/quick-app-proxy-path.js'
import { quickAppStorageKey } from '../../../shared/quick-app-browser-storage.js'
import { parseVirtualWorkspaceId } from '../../../shared/contracts/peer-host.js'
import { validateQuickAppOrigin, type QuickAppOriginProvider } from '../../../dsh-capabilities/host/quick-app-origin-adapter.js'
import { QuickAppRegistry, parseDefinition, quickAppDefinitionKey } from './registry.js'
import { QuickAppService } from './service.js'
import { deny, QuickAppError } from './errors.js'

/** Only the authenticated PeerHost management carrier may implement this gateway. */
export interface QuickAppPeerGateway {
  call(hostId: string, workspaceId: string, action: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

export function quickAppTargetWorkspace(app: Pick<QuickApp, 'hostId' | 'workspaceId'>): string {
  const parsed = parseVirtualWorkspaceId(app.workspaceId)
  if (!parsed || parsed.hostId !== app.hostId) deny('The shortcut does not belong to this Host.')
  return parsed.workspaceId
}

/** Remote definitions are validated and held on the file-owning Host, never trusted as grants. */
export class QuickAppRemoteOwner {
  private apps: QuickApp[] = []
  private readonly registry: QuickAppRegistry
  private readonly service: QuickAppService
  private pending: Promise<unknown> = Promise.resolve()
  private stopped = false
  constructor(workspaceRoot: (id: string) => string | null, private readonly origins?: QuickAppOriginProvider) {
    this.registry = new QuickAppRegistry({ read: () => this.apps, write: async apps => { this.apps = [...apps] } }, workspaceRoot)
    this.service = new QuickAppService(this.registry, origins)
  }
  handle(action: string, input: Record<string, unknown>, principal: string): Promise<unknown> {
    if (this.stopped) return Promise.reject(new QuickAppError(410, 'QUICK_APP_REVOKED', 'Quick Apps is disabled.'))
    // File mutations own their physical-file queue. Do not queue revocation behind a pending save.
    if (action === 'document') return this.service.documents.handle(String(input.id), principal, input)
    if (action === 'resource') return this.service.resource(String(input.id), principal, input.request as QuickAppProxyRequest)
    // Serialize definition replacement with grant/launch: a stale queued request cannot borrow a newer grant.
    const next = this.pending.catch(() => undefined).then(async () => {
      if (this.stopped) deny()
      if (action === 'close') {
        this.service.launches.requireOwner(String(input.id), principal)
        await this.service.launches.revoke(String(input.id)); return { ok: true }
      }
      if (!['validate', 'launch', 'grant', 'revoke'].includes(action)) deny()
      const definition = parseDefinition(input.app)
      if (definition.hostId !== 'local' || !definition.id) deny()
      const id = createHash('sha256').update(JSON.stringify([principal, definition.id])).digest('hex')
      let app = this.apps.find(item => item.id === id)
      const candidate = { ...definition, id, revision: app?.revision ?? 1 }
      const uiOrigin = typeof input.uiOrigin === 'string' ? input.uiOrigin : undefined
      if (action === 'validate') return { availability: await this.registry.availability(candidate, Boolean(this.origins) && (this.origins?.available?.(uiOrigin) ?? true)),
        fileAccess: candidate.fileAccess, runtimeReason: this.origins?.diagnostic?.(uiOrigin), isolation: this.origins?.isolation }
      if (action === 'revoke') { await this.service.invalidate(id); this.apps = this.apps.filter(item => item.id !== id); return { ok: true } }
      await this.registry.validate(candidate)
      if (!app || quickAppDefinitionKey(app) !== quickAppDefinitionKey(candidate)) {
        if (!app && this.apps.length >= QUICK_APP_LIMITS.shortcuts) throw new QuickAppError(429, 'QUICK_APP_LIMIT', 'Too many remote shortcuts for this module lifetime.')
        await this.service.invalidate(id)
        app = { ...candidate, revision: (app?.revision ?? 0) + 1 }
        this.apps = [...this.apps.filter(item => item.id !== id), app]
      }
      if (action === 'grant') { await this.service.grant(id, app.revision, input.permissions); return { ok: true } }
      return this.service.launch(id, principal, undefined, uiOrigin, input.browserStorage === true)
    })
    this.pending = next
    return next
  }
  async dispose(): Promise<void> { this.stopped = true; await this.pending.catch(() => undefined); await this.service.dispose(); this.apps = [] }
}

/** Controlling Host owns routing references; app payloads can never select a mutation destination. */
export class QuickAppRemoteController {
  private readonly active = new Map<string, { app: QuickApp; principal: string; targetId: string; expiresAt: number; removeAbort: () => void; disposeProxy?: () => Promise<void> }>()
  private readonly opening = new Set<Promise<unknown>>()
  private readonly origins = new Set<string>()
  private stopped = false
  constructor(private readonly gateway: () => QuickAppPeerGateway | undefined, private readonly protectedUi: (origin?: string) => boolean = () => false,
    private readonly proxy?: QuickAppOriginProvider) {}
  async call(app: QuickApp, action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    const gateway = this.gateway()
    if (!gateway || this.stopped && action !== 'close') throw new QuickAppError(503, 'QUICK_APP_HOST_UNAVAILABLE', 'The owning Host is unavailable.')
    const workspaceId = quickAppTargetWorkspace(app)
    return gateway.call(app.hostId, workspaceId, action, { ...payload, app: { ...app, hostId: 'local', workspaceId } }, signal)
  }
  launch(app: QuickApp, principal: string, uiOrigin: string | undefined, signal?: AbortSignal, browserStorage = false): Promise<unknown> {
    for (const [id, value] of this.active) if (value.expiresAt <= Date.now()) void this.close(id, value.principal).catch(() => undefined)
    if (this.stopped || this.active.size + this.opening.size >= QUICK_APP_LIMITS.launches || this.origins.size >= QUICK_APP_LIMITS.originHistory) return Promise.reject(new QuickAppError(429, 'QUICK_APP_LIMIT', 'Too many remote launches.'))
    const operation = (async () => {
      const result = await this.call(app, 'launch', { uiOrigin, browserStorage }, signal)
      if (result?.kind === 'text') {
        if (typeof result.content !== 'string' || typeof result.title !== 'string' || Buffer.byteLength(result.content) > QUICK_APP_LIMITS.textBytes) deny()
        // Older peers remain viewable, but expose no editing capability or launch to route.
        if (result.launchId === undefined) { signal?.throwIfAborted(); if (this.stopped) deny(); return result }
      } else if (result?.kind !== 'html') deny('The owning Host returned an invalid launch.')
      if (typeof result.launchId !== 'string' || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + QUICK_APP_LIMITS.lifetimeMs) deny()
      let disposeProxy: (() => Promise<void>) | undefined
      try { if (result.kind === 'html' && result.isolation === 'sandbox-proxy') {
        if (this.proxy?.isolation !== 'sandbox-proxy') throw new QuickAppError(503, 'QUICK_APP_RELAY_UNAVAILABLE', 'The controlling Host needs the workspace preview proxy.')
        const remoteBase = result.basePath
        // Desktop resources stay behind the authenticated relay; only the controlling lease reaches the browser.
        const ownerUiOrigin = uiOrigin === QUICK_APP_DESKTOP_ORIGIN ? result.origin : uiOrigin ?? ''
        validateQuickAppOrigin({ ...result, uiOrigin: ownerUiOrigin, ownerHostId: app.hostId, cookieName: 'quickapp-proxy', remote: true,
          activate: async () => ({ url: '' }), dispose: async () => undefined }, app.hostId, this.origins)
        if (!result.url.startsWith(result.origin + remoteBase)) deny('Invalid remote preview address.')
        const lease = await this.proxy.open((req, res) => {
          void (async () => {
            const headers: Record<string, string> = {}
            for (const name of ['accept', 'origin', 'content-type', 'if-match', 'if-none-match', 'sec-fetch-mode', 'sec-fetch-dest']) {
              const value = req.headers[name]; if (typeof value === 'string') headers[name] = value
            }
            const timeout = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
            const request: QuickAppProxyRequest = { method: req.method ?? 'GET', path: req.url ?? '/', headers,
              ...(req.method === 'PUT' ? { body: await readBody(req, timeout) } : {}) }
            const response = await this.call(app, 'resource', { id: result.launchId, request }, timeout) as QuickAppProxyResponse
            if (!Number.isInteger(response?.status) || response.status < 200 || response.status > 599 || typeof response.bodyBase64 !== 'string'
              || response.bodyBase64.length > Math.ceil(QUICK_APP_LIMITS.staticBytes / 3) * 4) deny('Invalid remote preview response.')
            for (const name of ['content-type', 'content-length', 'content-security-policy', 'cache-control', 'referrer-policy', 'x-content-type-options', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers']) {
              const value = response.headers[name]; if (typeof value === 'string') res.setHeader(name, value)
            }
            const location = response.headers.location
            if (location) { if (!location.startsWith(remoteBase)) deny(); res.setHeader('Location', lease.basePath! + location.slice(remoteBase.length)) }
            res.writeHead(response.status); res.end(req.method === 'HEAD' ? undefined : Buffer.from(response.bodyBase64, 'base64'))
          })().catch(() => { if (res.headersSent) res.destroy(); else res.writeHead(502, { 'Cache-Control': 'no-store' }).end() })
        }, uiOrigin)
        disposeProxy = lease.dispose
        const path = result.url.slice((result.origin + remoteBase).length)
        const activation = await lease.activate(randomUUID(), `/${path}`)
        result.url = activation.url; result.origin = lease.origin; result.basePath = lease.basePath
      } else if (result.kind === 'html') {
        if (typeof result.origin !== 'string' || typeof result.url !== 'string') deny()
        if (result.isolation === 'lan-port' && !this.protectedUi(uiOrigin)) throw new QuickAppError(503, 'QUICK_APP_RELAY_UNAVAILABLE', 'The controlling LAN proxy needs the app origin guard.')
        validateQuickAppOrigin({ origin: result.origin, uiOrigin: uiOrigin ?? '', ownerHostId: app.hostId, remote: true, cookieName: '__Host-quickapp',
          ...(result.isolation === 'lan-port' ? { isolation: 'lan-port' as const } : {}), activate: async () => ({ url: '' }), dispose: async () => undefined }, app.hostId, this.origins)
        if (new URL(result.url).origin !== result.origin) deny('The owning Host returned an invalid app address.')
        this.origins.add(result.origin)
      } } catch (error) { await disposeProxy?.(); await this.call(app, 'close', { id: result.launchId }).catch(() => undefined); throw error }
      if (this.stopped || signal?.aborted) { await disposeProxy?.(); await this.call(app, 'close', { id: result.launchId }); signal?.throwIfAborted(); deny() }
      const id = randomUUID()
      const onAbort = () => { void this.close(id, principal).catch(() => undefined) }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.active.set(id, { app, principal, targetId: result.launchId, expiresAt: result.expiresAt, removeAbort: () => signal?.removeEventListener('abort', onAbort), ...(disposeProxy ? { disposeProxy } : {}) })
      return { ...result, launchId: id, ...(result.storageToken ? { storageScope: quickAppStorageKey(app) } : {}) }
    })()
    this.opening.add(operation)
    void operation.finally(() => this.opening.delete(operation)).catch(() => undefined)
    return operation
  }
  owns(id: string): boolean { return this.active.has(id) }
  async document(id: string, principal: string, input: Record<string, unknown>, currentApp: (id: string) => QuickApp): Promise<unknown> {
    const launch = this.active.get(id)
    if (!launch || launch.principal !== principal || launch.expiresAt <= Date.now() || quickAppDefinitionKey(currentApp(launch.app.id)) !== quickAppDefinitionKey(launch.app)) deny()
    return this.call(launch.app, 'document', { operation: input.operation, path: input.path, content: input.content, version: input.version, id: launch.targetId })
  }
  async close(id: string, principal: string): Promise<void> {
    const launch = this.active.get(id)
    if (!launch || launch.principal !== principal) deny()
    this.active.delete(id); launch.removeAbort()
    await launch.disposeProxy?.()
    await this.call(launch.app, 'close', { id: launch.targetId })
  }
  async invalidate(app: QuickApp): Promise<void> {
    await Promise.all([...this.active.entries()].filter(([, value]) => value.app.id === app.id).map(([id, value]) => this.close(id, value.principal)))
    await this.call(app, 'revoke')
  }
  async dispose(): Promise<void> {
    this.stopped = true
    await Promise.allSettled(this.opening)
    await Promise.allSettled([...this.active].map(([id, value]) => this.close(id, value.principal)))
  }
}
