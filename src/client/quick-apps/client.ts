import type { CodingNsRpcClient } from '../features/types.js'
import type { QuickApp, QuickAppDocument } from '../../shared/contracts/quick-apps.js'
import { QUICK_APP_DESKTOP_ORIGIN } from '../../shared/quick-app-proxy-path.js'
import { callCodingNsRpcResult } from '../rpc-call.js'

/** The controlling Host keeps metadata; no active conversation or browser storage is consulted. */
export class QuickAppsClient {
  private generation = 0
  private launchId: string | undefined
  constructor(private readonly rpc: CodingNsRpcClient) {}
  async call<T>(action: string, payload: unknown = {}): Promise<T> {
    // Embedding choice is checked against operator configuration; it never grants file access.
    const uiOrigin = typeof location !== 'object' ? undefined
      : location.protocol === 'dsh-app:' && location.host === 'app' ? QUICK_APP_DESKTOP_ORIGIN : location.origin
    const input = (action === 'list' || action === 'launch') && uiOrigin ? { ...(payload as object), uiOrigin } : payload
    const result = await callCodingNsRpcResult(this.rpc, `quickApps/${action}`, input)
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
    return result.value as T
  }
  async reorder(apps: readonly QuickApp[], current: () => boolean): Promise<readonly QuickApp[]> {
    try {
      return await this.call<QuickApp[]>('reorder', { apps: apps.map(app => ({ id: app.id, expectedRevision: app.revision })) })
    } catch (error) {
      if ((error as { code?: string }).code !== 'CODINGNS_RPC_NOT_FOUND') throw error
    }
    // Older Hosts already support order through upsert. Preserve their validation and access policy.
    const saved: QuickApp[] = []
    for (const [order, app] of apps.entries()) {
      if (!current()) return saved
      if (app.order === order) { saved.push(app); continue }
      const { id, title, hostId, workspaceId, entryPath, documentRoot, kind, fileAccess, spaFallback, networkAllow, mounts } = app
      saved.push(await this.call<QuickApp>('upsert', { expectedRevision: app.revision,
        app: { id, title, hostId, workspaceId, entryPath, documentRoot, kind, ...(fileAccess ? { fileAccess } : {}), spaFallback, ...(networkAllow?.length ? { networkAllow } : {}), mounts, order } }))
    }
    return saved
  }
  async open(id: string, browserStorage = true): Promise<QuickAppView | undefined> {
    const closing = this.close()
    const generation = this.generation
    await closing
    if (generation !== this.generation) return undefined
    const result = await this.call<QuickAppView>('launch', { id, ...(browserStorage ? { browserStorage: true } : {}) })
    if (generation !== this.generation) {
      if (result.launchId) await this.call('close', { id: result.launchId })
      return undefined
    }
    if (result.launchId) this.launchId = result.launchId
    return result
  }
  async close(): Promise<void> {
    this.generation++
    const id = this.launchId
    this.launchId = undefined
    if (id) await this.call('close', { id })
  }
}

// Optional document fields keep old read-only Hosts viewable during an incremental upgrade.
export type QuickAppView = ({ kind: 'text'; title: string; content: string; launchId?: string; expiresAt?: number } & Partial<Omit<QuickAppDocument, 'content'>>)
  | { kind: 'html'; url: string; origin: string; launchId: string; expiresAt: number; isolation?: 'lan-port' | 'sandbox-proxy'; basePath?: string; storageToken?: string; storageScope?: string }
