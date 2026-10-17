import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsHostServices } from './types.js'
import { QuickAppRegistry, quickAppDefinitionKey } from '../modules/quick-apps/registry.js'
import { QuickAppService } from '../modules/quick-apps/service.js'
import { QuickAppError } from '../modules/quick-apps/errors.js'
import { QuickAppRemoteController, QuickAppRemoteOwner, quickAppTargetWorkspace } from '../modules/quick-apps/remote.js'
import { browseQuickAppDirectory } from '../modules/quick-apps/browse.js'
import { conflict } from '../modules/quick-apps/errors.js'
import type { QuickApp, QuickAppRuntimeReason } from '../../shared/contracts/quick-apps.js'

export function createQuickAppsFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: { name: 'quickApps', version: '0.1.0', enabledByDefault: false, dependencies: [], runtime: 'both',
      requires: [{ capability: 'settings.store', required: true, fallback: 'disable' }, { capability: 'quick-app.proxy', required: false, fallback: 'degrade' }, { capability: 'quick-app.origin', required: false, fallback: 'degrade' }, { capability: 'workspace.directory-list', required: false, fallback: 'degrade' }] },
    start(context) {
      const { settings, resolveManagedWorkspaceRoot, quickAppOrigins } = context.services
      if (!settings || !resolveManagedWorkspaceRoot) throw new QuickAppError(503, 'QUICK_APP_UNAVAILABLE', 'Workspace settings are unavailable.')
      const remote = new QuickAppRemoteController(() => context.services.quickAppPeerGateway, origin => context.services.quickAppLanTransport?.protects(origin) === true, quickAppOrigins)
      const owner = new QuickAppRemoteOwner(resolveManagedWorkspaceRoot, quickAppOrigins)
      const registry = new QuickAppRegistry({ read: () => settings.get().quickApps ?? [], write: apps => settings.update({ quickApps: [...apps] }) }, resolveManagedWorkspaceRoot, 'local', async app => {
        const result = await remote.call(app, 'validate')
        if (result?.availability === 'missing-workspace') throw new QuickAppError(404, 'QUICK_APP_WORKSPACE_UNAVAILABLE', 'The exact workspace is unavailable.')
        if (!['available', 'unsupported-runtime'].includes(result?.availability)) throw new QuickAppError(404, 'QUICK_APP_NOT_FOUND', 'The remote entry file or application folder is unavailable.')
        if (app.fileAccess === 'workspace' && result.fileAccess !== 'workspace') throw new QuickAppError(503, 'QUICK_APP_WORKSPACE_ACCESS_UNAVAILABLE', 'The owning Host must be updated to support workspace access.')
      })
      const service = new QuickAppService(registry, quickAppOrigins)
      const lifetime = new AbortController()
      context.resources.add(() => lifetime.abort())
      context.resources.add(() => service.dispose())
      context.resources.add(() => owner.dispose())
      context.resources.add(() => remote.dispose())
      context.resources.add(context.services.rpc.register('quickApps', async (action, payload, rpcContext) => {
        const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
        const peer = (rpcContext as { peer?: { id?: string; signal?: AbortSignal } } | undefined)?.peer
        // Connection authenticates management calls; the payload cannot nominate a principal.
        const principal = peer?.id
        const uiOrigin = typeof input.uiOrigin === 'string' ? input.uiOrigin : undefined
        if (!principal) throw new QuickAppError(503, 'QUICK_APP_PRINCIPAL_UNAVAILABLE', 'This connection does not provide an authenticated launch owner.')
        if (action === 'browse' || action === 'remote' && input.action === 'browse') {
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000), ...(peer?.signal ? [peer.signal] : [])])
          if (action === 'remote' || input.hostId === 'local') return browseQuickAppDirectory(resolveManagedWorkspaceRoot, context.services.workspaceDirectoryBrowser, input.workspaceId, input.path, signal)
          if (typeof input.hostId !== 'string' || typeof input.workspaceId !== 'string' || !context.services.quickAppPeerGateway) throw new QuickAppError(503, 'QUICK_APP_HOST_UNAVAILABLE', 'The owning Host is unavailable.')
          const workspaceId = quickAppTargetWorkspace({ hostId: input.hostId, workspaceId: input.workspaceId })
          return context.services.quickAppPeerGateway.call(input.hostId, workspaceId, 'browse', { workspaceId, path: input.path }, signal)
        }
        if (action === 'remote') return owner.handle(String(input.action), input, principal)
        if (action === 'list') {
          const local = await service.list(uiOrigin) as (QuickApp & { availability: string; runtimeReason?: QuickAppRuntimeReason })[]
          const signal = peer?.signal ? AbortSignal.any([peer.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
          // A small batch bounds outbound work when many shortcuts belong to disconnected Hosts.
          for (let offset = 0; offset < local.length; offset += 4) await Promise.all(local.slice(offset, offset + 4).map(async app => {
            if (app.hostId === registry.hostId) return
            try {
              signal.throwIfAborted()
              const status = await remote.call(app, 'validate', { uiOrigin }, signal)
              delete app.runtimeReason
              app.availability = ['available', 'unsupported-runtime', 'missing-file', 'missing-workspace'].includes(status?.availability) ? status.availability : 'disconnected-host'
              if (status?.runtimeReason) app.runtimeReason = status.runtimeReason
              if (status?.isolation === 'lan-port' && app.availability === 'available' && !context.services.quickAppLanTransport?.protects(uiOrigin)) app.availability = 'unsupported-connection'
              if (status?.isolation === 'sandbox-proxy' && app.availability === 'available' && quickAppOrigins?.isolation !== 'sandbox-proxy') app.availability = 'unsupported-connection'
            }
            catch (error) { app.availability = (error as { code?: string }).code === 'QUICK_APP_RELAY_UNAVAILABLE' ? 'unsupported-connection' : 'disconnected-host' }
          }))
          return local
        }
        if (action === 'reorder') return registry.reorder(input.apps)
        if (action === 'upsert') {
          const previousId = (input.app as { id?: string } | undefined)?.id
          const previous = previousId ? registry.get(previousId) : undefined
          if (previous && input.expectedRevision !== previous.revision) conflict()
          if (previous?.hostId !== undefined && previous.hostId !== registry.hostId) await remote.invalidate(previous)
          const app = await registry.upsert(input.app, input.expectedRevision as number); await service.invalidate(app.id); return app
        }
        const id = typeof input.id === 'string' ? input.id : ''
        if (action === 'document') return remote.owns(id)
          ? remote.document(id, principal, input, id => registry.get(id))
          : service.documents.handle(id, principal, input)
        if (action === 'close') {
          if (remote.owns(id)) await remote.close(id, principal)
          else { service.launches.requireOwner(id, principal); await service.launches.revoke(id) }
          return { ok: true }
        }
        if (!['remove', 'grant', 'revoke', 'launch'].includes(action)) throw new QuickAppError(404, 'CODINGNS_RPC_NOT_FOUND', 'Unknown Quick Apps operation.')
        const app = registry.get(id)
        const isRemote = app.hostId !== registry.hostId
        if (action === 'remove' || action === 'grant') { if (input.expectedRevision !== app.revision) conflict() }
        if (action === 'remove') {
          if (isRemote) await remote.invalidate(app)
          await registry.remove(id, input.expectedRevision as number); await service.invalidate(id); return { ok: true }
        }
        if (action === 'grant') {
          if (isRemote) await remote.call(app, 'grant', { permissions: input.permissions })
          else await service.grant(id, input.expectedRevision as number, input.permissions)
          return { ok: true }
        }
        if (action === 'revoke') {
          if (isRemote) await remote.invalidate(app); else await service.invalidate(id)
          // Revocation also removes persisted workspace trust, so reopening cannot silently restore it.
          if (app.fileAccess === 'workspace') {
            return { ok: true, app: await registry.revokeWorkspaceAccess(id, app.revision) }
          }
          return { ok: true, app }
        }
        if (action === 'launch') {
          if (!isRemote) return service.launch(id, principal, peer?.signal, uiOrigin, input.browserStorage === true)
          const result = await remote.launch(app, principal, uiOrigin, peer?.signal, input.browserStorage === true) as { kind: string; launchId?: string }
          let current: QuickApp | undefined
          try { current = registry.get(id) } catch { /* Removal while launch was in flight. */ }
          if (!current || quickAppDefinitionKey(current) !== quickAppDefinitionKey(app)) {
            if (result.launchId) await remote.close(result.launchId, principal)
            conflict()
          }
          return result
        }
        throw new QuickAppError(404, 'CODINGNS_RPC_NOT_FOUND', 'Unknown Quick Apps operation.')
      }))
    },
  }
}
