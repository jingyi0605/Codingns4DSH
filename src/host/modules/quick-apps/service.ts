import type { IncomingMessage, ServerResponse } from 'node:http'
import { realpath } from 'node:fs/promises'
import { QUICK_APP_ORIGIN_UNAVAILABLE, validateQuickAppOrigin, type QuickAppOriginProvider } from '../../../dsh-capabilities/host/quick-app-origin-adapter.js'
import type { QuickAppPermissions, QuickAppProxyRequest, QuickAppProxyResponse } from '../../../shared/contracts/quick-apps.js'
import { QUICK_APP_LIMITS } from '../../../shared/contracts/quick-apps.js'
import { QuickAppRegistry, parsePermissions, quickAppDefinitionKey } from './registry.js'
import { QuickAppLaunches } from './launches.js'
import { QuickAppFileApi } from './file-api.js'
import { QuickAppDocuments } from './documents.js'
import { createQuickAppHttpHandler } from './static-handler.js'
import { resolveAppPath } from './paths.js'
import { conflict, deny, QuickAppError } from './errors.js'
import { quickAppCodeRevision } from './code-revision.js'

export class QuickAppService {
  readonly launches: QuickAppLaunches
  readonly files: QuickAppFileApi
  readonly documents: QuickAppDocuments
  private readonly approvals = new Map<string, { definition: string; workspaceRoot: string; permissions: QuickAppPermissions; codeRevision: string }>()
  private readonly origins = new Set<string>()
  private readonly opening = new Set<Promise<unknown>>()
  private readonly proxyPaths = new Map<string, string>()
  private stopped = false
  constructor(readonly registry: QuickAppRegistry, private readonly originsProvider?: QuickAppOriginProvider) {
    this.launches = new QuickAppLaunches(registry)
    this.files = new QuickAppFileApi(this.launches)
    this.documents = new QuickAppDocuments(this.launches, this.files)
  }
  async list(uiOrigin?: string): Promise<unknown> {
    const available = Boolean(this.originsProvider) && (this.originsProvider?.available?.(uiOrigin) ?? true)
    return Promise.all(this.registry.list().map(async app => ({ ...app, availability: await this.registry.availability(app, available),
      ...(!available && app.kind === 'html' ? { runtimeReason: this.originsProvider?.diagnostic?.(uiOrigin) ?? 'not-configured' } : {}) })))
  }
  async grant(id: string, revision: number, permissions: unknown): Promise<void> {
    const app = this.registry.get(id)
    if (revision !== app.revision) conflict()
    if (app.fileAccess === 'workspace') deny('Revoke workspace access before assigning legacy file scopes.')
    await this.registry.validate(app)
    const parsed = parsePermissions(permissions)
    for (const scope of [...parsed.read, ...parsed.write, ...parsed.delete]) await resolveAppPath(this.registry.root(app), scope)
    await this.launches.revokeApp(id)
    const workspaceRoot = await realpath(this.registry.root(app))
    const codeRevision = await quickAppCodeRevision(workspaceRoot, app)
    if (this.stopped || quickAppDefinitionKey(this.registry.get(id)) !== quickAppDefinitionKey(app)) deny()
    this.approvals.set(id, { definition: quickAppDefinitionKey(app), workspaceRoot, permissions: parsed, codeRevision })
  }
  launch(id: string, principal: string, connectionSignal?: AbortSignal, uiOrigin?: string): Promise<unknown> {
    if (this.stopped) return Promise.reject(new QuickAppError(410, 'QUICK_APP_REVOKED', 'Quick Apps is disabled.'))
    const pruning = this.launches.prune()
    if (this.opening.size + this.launches.size >= QUICK_APP_LIMITS.launches) { void pruning.catch(() => undefined); return Promise.reject(new QuickAppError(429, 'QUICK_APP_LIMIT', 'Too many pending or active launches.')) }
    const operation = pruning.then(() => this.open(id, principal, connectionSignal, uiOrigin))
    this.opening.add(operation)
    void operation.finally(() => this.opening.delete(operation)).catch(() => undefined)
    return operation
  }
  private async open(id: string, principal: string, connectionSignal?: AbortSignal, uiOrigin?: string): Promise<unknown> {
    connectionSignal?.throwIfAborted()
    const app = this.registry.get(id)
    await this.registry.validate(app)
    if (app.kind === 'text') {
      const { launch } = await this.launches.create(app, principal, { read: [app.documentRoot], write: [], delete: [] })
      const disconnect = () => { void this.launches.revoke(launch.id).catch(() => undefined) }
      connectionSignal?.addEventListener('abort', disconnect, { once: true })
      launch.dispose = async () => { connectionSignal?.removeEventListener('abort', disconnect) }
      try {
        const result = await this.documents.read(launch, app.entryPath)
        connectionSignal?.throwIfAborted()
        this.launches.authorize(launch)
        return { kind: 'text', ...result, title: app.title, launchId: launch.id, expiresAt: launch.expiresAt }
      } catch (error) { await this.launches.revoke(launch.id); throw error }
    }
    if (!this.originsProvider) throw new QuickAppError(503, 'QUICK_APP_ORIGIN_UNAVAILABLE', QUICK_APP_ORIGIN_UNAVAILABLE)
    if (this.origins.size >= QUICK_APP_LIMITS.originHistory) throw new QuickAppError(429, 'QUICK_APP_LIMIT', 'The origin allocation limit has been reached for this module lifetime.')
    let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined
    const lease = await this.originsProvider.open((req, res) => {
      if (!handler) { res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end(); return }
      void handler(req, res)
    }, uiOrigin)
    let launchId: string | undefined
    try {
      connectionSignal?.throwIfAborted()
      if (this.stopped) deny()
      validateQuickAppOrigin(lease, this.registry.hostId, this.origins)
      if (lease.isolation !== 'sandbox-proxy') this.origins.add(lease.origin)
      const approved = this.approvals.get(id)
      const trusted = app.fileAccess !== 'workspace' && approved?.definition === quickAppDefinitionKey(app) && approved.workspaceRoot === await realpath(this.registry.root(app))
        && approved.codeRevision === await quickAppCodeRevision(this.registry.root(app), app)
      // Workspace trust follows the saved Host-owned definition, not mutable app code or request fields.
      const permissions = app.fileAccess === 'workspace' ? { read: [''], write: [''], delete: [''] }
        : trusted ? approved.permissions : { read: [], write: [], delete: [] }
      if (!trusted) this.approvals.delete(id)
      const { launch, credential } = await this.launches.create(app, principal, permissions)
      if (trusted) launch.validateCode = async () => {
        if (approved.codeRevision !== await quickAppCodeRevision(launch.workspaceRoot, app)) {
          await this.invalidate(id)
          throw new QuickAppError(410, 'QUICK_APP_CODE_CHANGED', 'Application code changed. Review and approve file permissions again.')
        }
      }
      launchId = launch.id
      const disconnect = () => { void this.launches.revoke(launch.id).catch(() => undefined) }
      connectionSignal?.addEventListener('abort', disconnect, { once: true })
      // A retired hostname cannot be reused: a previously loaded page would inherit new cookies.
      launch.dispose = async () => { this.proxyPaths.delete(launch.id); connectionSignal?.removeEventListener('abort', disconnect); await lease.dispose() }
      if (lease.isolation === 'sandbox-proxy' && lease.basePath) this.proxyPaths.set(launch.id, lease.basePath)
      handler = createQuickAppHttpHandler(this.launches, this.files, launch, lease)
      if (connectionSignal?.aborted) { await this.launches.revoke(launch.id); connectionSignal.throwIfAborted() }
      const path = app.entryPath.slice(app.documentRoot.length).replace(/^\//u, '').split('/').map(encodeURIComponent).join('/')
      const result = await lease.activate(credential, `/${path}`)
      this.launches.authorize(launch)
      if (new URL(result.url).origin !== lease.origin) deny('Invalid app launch URL.')
      return { kind: 'html', launchId: launch.id, url: result.url, origin: lease.origin, expiresAt: launch.expiresAt,
        ...(lease.basePath ? { basePath: lease.basePath } : {}),
        ...(lease.isolation ? { isolation: lease.isolation } : {}) }
    } catch (error) {
      if (launchId) await this.launches.revoke(launchId)
      else await lease.dispose()
      throw error
    }
  }
  async invalidate(id: string): Promise<void> { this.approvals.delete(id); await this.launches.revokeApp(id) }
  async resource(id: string, principal: string, input: QuickAppProxyRequest): Promise<QuickAppProxyResponse> {
    const launch = this.launches.requireOwner(id, principal)
    this.launches.authorize(launch)
    const path = this.proxyPaths.get(id)
    if (!path || !this.originsProvider?.requestResource) deny('This launch does not provide proxied resources.')
    return this.originsProvider.requestResource(path, input, AbortSignal.any([launch.abort.signal, AbortSignal.timeout(30_000)]))
  }
  async dispose(): Promise<void> {
    this.stopped = true
    this.approvals.clear()
    await this.launches.dispose()
    await Promise.allSettled(this.opening)
    await this.files.drain()
    await this.registry.dispose()
    this.origins.clear()
  }
}
