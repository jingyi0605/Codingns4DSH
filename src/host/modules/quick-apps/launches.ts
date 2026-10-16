import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { QuickApp, QuickAppPermissions } from '../../../shared/contracts/quick-apps.js'
import { QUICK_APP_LIMITS } from '../../../shared/contracts/quick-apps.js'
import type { QuickAppRegistry } from './registry.js'
import { deny, QuickAppError } from './errors.js'

export interface QuickAppLaunch {
  readonly id: string
  readonly app: QuickApp
  readonly principal: string
  readonly workspaceRoot: string
  readonly workspaceReference: string
  permissions: QuickAppPermissions
  readonly expiresAt: number
  readonly credentialDigest: Buffer
  readonly abort: AbortController
  dispose: () => Promise<void>
  validateCode?: () => Promise<void>
}

export class QuickAppLaunches {
  private readonly launches = new Map<string, QuickAppLaunch>()
  private stopped = false
  constructor(private readonly registry: QuickAppRegistry, private readonly now = Date.now) {}

  async create(app: QuickApp, principal: string, permissions: QuickAppPermissions): Promise<{ launch: QuickAppLaunch; credential: string }> {
    const workspaceReference = this.registry.root(app)
    const workspaceRoot = await realpath(workspaceReference)
    await this.prune()
    if (this.stopped) throw new QuickAppError(410, 'QUICK_APP_REVOKED', 'Quick Apps is disabled.')
    if (this.launches.size >= QUICK_APP_LIMITS.launches) throw new QuickAppError(429, 'QUICK_APP_LIMIT', 'Too many active launches.')
    const credential = randomBytes(32).toString('base64url')
    const launch: QuickAppLaunch = { id: randomUUID(), app: structuredClone(app), principal, workspaceRoot, workspaceReference,
      permissions: structuredClone(permissions), expiresAt: this.now() + QUICK_APP_LIMITS.lifetimeMs,
      credentialDigest: digest(credential), abort: new AbortController(), dispose: async () => undefined }
    this.launches.set(launch.id, launch)
    return { launch, credential }
  }
  authorize(launch: QuickAppLaunch, credential?: string): void {
    if (credential !== undefined && !timingSafeEqual(launch.credentialDigest, digest(credential))) throw new QuickAppError(401, 'QUICK_APP_UNAUTHENTICATED', 'App authentication required.')
    if (this.stopped || this.launches.get(launch.id) !== launch || launch.abort.signal.aborted) throw new QuickAppError(410, 'QUICK_APP_REVOKED', 'This launch has been revoked.')
    if (launch.expiresAt <= this.now()) { void this.revoke(launch.id).catch(() => undefined); throw new QuickAppError(410, 'QUICK_APP_LAUNCH_EXPIRED', 'This launch has expired.') }
    let current: QuickApp
    try { current = this.registry.get(launch.app.id); this.registry.root(current) } catch {
      void this.revoke(launch.id).catch(() => undefined)
      throw new QuickAppError(410, 'QUICK_APP_REVOKED', 'The shortcut was removed.')
    }
    if (JSON.stringify(current) !== JSON.stringify(launch.app) || this.registry.root(current) !== launch.workspaceReference) {
      void this.revoke(launch.id).catch(() => undefined)
      throw new QuickAppError(410, 'QUICK_APP_REVOKED', 'The shortcut or workspace changed.')
    }
  }
  async validateWorkspace(launch: QuickAppLaunch): Promise<void> {
    this.authorize(launch)
    if (await realpath(launch.workspaceReference) !== launch.workspaceRoot) {
      void this.revoke(launch.id).catch(() => undefined)
      throw new QuickAppError(410, 'QUICK_APP_REVOKED', 'The workspace location changed.')
    }
  }
  requireOwner(id: string, principal: string): QuickAppLaunch {
    const launch = this.launches.get(id)
    if (!launch || launch.principal !== principal) deny()
    return launch
  }
  async revoke(id: string): Promise<void> {
    const launch = this.launches.get(id)
    if (!launch) return
    this.launches.delete(id)
    launch.abort.abort()
    await launch.dispose()
  }
  async revokeApp(id: string): Promise<void> { await Promise.all([...this.launches.values()].filter(launch => launch.app.id === id).map(launch => this.revoke(launch.id))) }
  async prune(): Promise<void> { await Promise.all([...this.launches.values()].filter(launch => launch.expiresAt <= this.now()).map(launch => this.revoke(launch.id))) }
  async dispose(): Promise<void> { this.stopped = true; await Promise.all([...this.launches.keys()].map(id => this.revoke(id))) }
  get size(): number { return this.launches.size }
}

function digest(value: string): Buffer { return createHash('sha256').update(value).digest() }
