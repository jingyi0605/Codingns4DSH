import type { FeatureModule } from '../../shared/contracts/feature.js'
import { debugWarn } from '../../shared/debug.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { startWorkspaceMcpTransport } from '../workspace-mcp/transport.js'
import { FileWorkspaceMcpApiKeyStore, generateWorkspaceMcpApiKey } from '../workspace-mcp/api-key-store.js'
import type { WorkspaceMcpApiKeyStore } from '../workspace-mcp/api-key-store.js'
import { createWorkspaceMcpToolHandlers } from '../workspace-mcp/tools.js'
import type { WorkspaceMcpAdapterRegistry } from '../workspace-mcp/tools.js'
import { getAdapterRegistry } from '../cli-adapters/registry-holder.js'
import { createDshCapabilityRegistry } from '../../dsh-capabilities/routes.js'
import { nativeDispatchPeer, isCodingNsOwnerPeer } from '../../dsh-capabilities/host/connection-peer-adapter.js'
import type { WorkspaceApprovalAdapter } from '../../dsh-capabilities/host/workspace-approval-adapter.js'
import type { WorkspacePendingQuestionsAdapter } from '../../dsh-capabilities/host/workspace-pending-questions-adapter.js'
import type { WorkspaceSessionControlAdapter } from '../../dsh-capabilities/host/workspace-session-control-adapter.js'
import type { CodingNsHostServices } from './types.js'
import { registerWorkspaceMcpLanRoute, synthLanResponse } from '../lan-access-dsh.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { FileWorkspaceMcpWebhookStore, WorkspaceMcpWebhookStoreError } from '../workspace-mcp/webhook-store.js'
import type { WorkspaceMcpWebhookDestination, WorkspaceMcpWebhookEventType } from '../workspace-mcp/webhook-store.js'
import { WorkspaceMcpWebhookDispatcher } from '../workspace-mcp/webhook-dispatcher.js'
import type { WorkspaceMcpWebhookDispatcherOptions } from '../workspace-mcp/webhook-dispatcher.js'
import { attachWorkspaceMcpWebhookEvents } from '../workspace-mcp/webhook-events.js'

const API_KEY_ENV = 'CODINGNS_WORKSPACE_MCP_API_KEY'

/** Owns the public MCP status RPC and the optional authenticated loopback listener. */
export function createWorkspaceMcpHostFeature(options: {
  readonly apiKeyStore?: WorkspaceMcpApiKeyStore
  readonly webhookStore?: FileWorkspaceMcpWebhookStore
  readonly webhookDispatcherOptions?: WorkspaceMcpWebhookDispatcherOptions
  readonly isOwner?: (peer: unknown) => boolean
} = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'workspaceMcp',
      version: '0.1.0',
      // This control plane stays available while the separately gated listener is disabled.
      enabledByDefault: false,
      dependencies: [],
      runtime: 'host',
      ui: { label: 'Workspace MCP control', description: 'Keeps key management available while the listener is disabled.', alwaysEnabled: true },
      requires: [
        { capability: 'workspace.session-control', required: false, fallback: 'degrade' },
        { capability: 'workspace.pending-questions', required: false, fallback: 'degrade' },
        { capability: 'workspace.approval', required: false, fallback: 'degrade' },
      ],
    },
    start(context) {
      let transport: Awaited<ReturnType<typeof startWorkspaceMcpTransport>> | undefined
      let reason: string | null = null
      let storedKey = ''
      let generation = 0
      let reconcileTail = Promise.resolve()
      let webhookGeneration = 0
      let webhookTail = Promise.resolve()
      let webhookDispatcher: WorkspaceMcpWebhookDispatcher | undefined
      let webhookEvents: ReturnType<typeof attachWorkspaceMcpWebhookEvents> | undefined
      let webhooksStopped = false
      const apiKeyStore = options.apiKeyStore ?? new FileWorkspaceMcpApiKeyStore()
      const webhookStore = options.webhookStore ?? new FileWorkspaceMcpWebhookStore()
      const settings = context.services.settings
      context.resources.add(registerWorkspaceMcpLanRoute(async (request) => {
        const endpoint = transport?.active === true ? transport.url : null
        if (endpoint === null) return undefined
        if (settings?.get().modules.workspaceMcpLanAccess !== true) {
          return synthLanResponse({ status: 404, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ error: 'not found' }) })
        }
        const headers = new Headers()
        for (const name of ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name']) {
          const value = request.headers[name]
          if (value !== undefined) headers.set(name, value)
        }
        const response = await fetch(endpoint, {
          method: request.method,
          headers,
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: Buffer.from(request.body) }),
          redirect: 'error',
        })
        const responseHeaders: Record<string, string> = {}
        for (const name of ['mcp-protocol-version', 'mcp-session-id']) {
          const value = response.headers.get(name)
          if (value !== null) responseHeaders[name] = value
        }
        return synthLanResponse({
          status: response.status,
          contentType: response.headers.get('content-type') ?? 'application/json; charset=utf-8',
          body: new Uint8Array(await response.arrayBuffer()),
          headers: responseHeaders,
        })
      }))
      const capabilityProfile = context.services.dshContext === undefined || context.services.dshVersion === undefined
        ? undefined
        : createDshCapabilityRegistry(context.services.dshVersion, 'host', context.services.dshContext).getProfile(context.services.dshContext)
      const toolset = createWorkspaceMcpToolHandlers(context.services, {
        ...(capabilityProfile?.capabilities.get('workspace.session-control')?.value === undefined ? {} : {
          sessionControl: capabilityProfile.capabilities.get('workspace.session-control')!.value as WorkspaceSessionControlAdapter,
        }),
        ...(capabilityProfile?.capabilities.get('workspace.pending-questions')?.value === undefined ? {} : {
          pendingQuestions: capabilityProfile.capabilities.get('workspace.pending-questions')!.value as WorkspacePendingQuestionsAdapter,
        }),
        ...(capabilityProfile?.capabilities.get('workspace.approval')?.value === undefined ? {} : {
          approval: capabilityProfile.capabilities.get('workspace.approval')!.value as WorkspaceApprovalAdapter,
        }),
        getAdapterRegistry: () => getAdapterRegistry() as WorkspaceMcpAdapterRegistry | undefined,
        ...(capabilityProfile === undefined ? {} : { diagnostics: capabilityProfile.diagnostics.map((diagnostic) => ({
          capability: diagnostic.capability,
          status: capabilityProfile.capabilities.get(diagnostic.capability)?.status ?? 'unavailable',
          message: diagnostic.message,
        })) }),
      })
      const enabled = (): boolean => context.services.settings?.get().modules.workspaceMcp === true
      const apiKey = (): string => storedKey || process.env[API_KEY_ENV]?.trim() || ''
      let enabledSnapshot = enabled()

      const isOwner = (peer: unknown): boolean => {
        const connection = (context.services.dshContext as unknown as { readonly connection?: unknown } | undefined)?.connection
        const caller = peer as { readonly peer?: unknown } | undefined
        const resolvedPeer = connection === undefined ? caller?.peer : nativeDispatchPeer(connection, caller?.peer)
        return options.isOwner?.(caller?.peer) ?? (connection !== undefined && isCodingNsOwnerPeer(connection, resolvedPeer))
      }

      const stopWebhooks = async (): Promise<void> => {
        const currentEvents = webhookEvents
        webhookEvents = undefined
        currentEvents?.dispose()
        const currentDispatcher = webhookDispatcher
        webhookDispatcher = undefined
        await currentDispatcher?.close()
      }

      const reconcileWebhooks = (): Promise<void> => {
        const currentGeneration = ++webhookGeneration
        webhookTail = webhookTail.then(async () => {
          await stopWebhooks()
          if (currentGeneration !== webhookGeneration || webhooksStopped) return
          const snapshot = await webhookStore.snapshot()
          if (!snapshot.destinations.some((destination) => destination.enabled)) return
          const dispatcher = new WorkspaceMcpWebhookDispatcher(webhookStore, options.webhookDispatcherOptions)
          const events = attachWorkspaceMcpWebhookEvents({
            services: context.services,
            store: webhookStore,
            ...(capabilityProfile?.capabilities.get('workspace.pending-questions')?.value === undefined ? {} : {
              pendingQuestions: capabilityProfile.capabilities.get('workspace.pending-questions')!.value as WorkspacePendingQuestionsAdapter,
            }),
            onQueued: () => dispatcher.wake(),
          })
          if (currentGeneration !== webhookGeneration || webhooksStopped) {
            events.dispose()
            await dispatcher.close()
            return
          }
          webhookDispatcher = dispatcher
          webhookEvents = events
          dispatcher.wake()
        })
          .catch((error: unknown) => {
            debugWarn('codingns4dsh: Workspace MCP webhook lifecycle failed', {
              error: error instanceof Error ? error.name : 'unknown',
            })
          })
        return webhookTail
      }

      const eventAvailability = (): Record<string, { readonly available: boolean; readonly reason: string | null }> => {
        const sessionEvents = context.services.nativeSessions?.supportsEvents === true
        const questionChannel = typeof context.services.events?.on === 'function'
        const pendingQuestions = capabilityProfile?.capabilities.get('workspace.pending-questions')?.value !== undefined
        return {
          'session.completed': { available: sessionEvents, reason: sessionEvents ? null : 'Native session events are unavailable.' },
          'session.failed': { available: sessionEvents, reason: sessionEvents ? null : 'Native session events are unavailable.' },
          'session.permission_requested': { available: sessionEvents, reason: sessionEvents ? null : 'Native session events are unavailable.' },
          'session.question_asked': {
            available: questionChannel && pendingQuestions,
            reason: !questionChannel ? 'The Host question event channel is unavailable.' : pendingQuestions ? null : 'Pending question data is unavailable.',
          },
        }
      }

      const reconcile = (): void => {
        const currentGeneration = ++generation
        reconcileTail = reconcileTail.then(async () => {
          if (transport !== undefined) {
            const previous = transport
            transport = undefined
            await previous.revoke()
          }
          toolset.abortRequests()
          if (currentGeneration !== generation) return
          try {
            storedKey = await apiKeyStore.read() ?? ''
          } catch (error) {
            reason = 'key-store-failed'
            debugWarn('codingns4dsh: Workspace MCP key store could not be read', {
              error: error instanceof Error ? error.message : 'unknown error',
            })
            return
          }
          if (currentGeneration !== generation) return
          if (!enabled()) {
            reason = 'disabled'
            return
          }
          const key = apiKey()
          if (key === '') {
            reason = 'api-key-not-configured'
            return
          }
          try {
            const next = await startWorkspaceMcpTransport({
              apiKey: key,
              listTools: (signal) => toolset.listTools(signal),
              callTool: (name, args, signal) => toolset.callTool(name, args, signal),
              serverInfo: { name: 'codingns-workspace-mcp', version: '0.1.0' },
            })
            if (currentGeneration !== generation || !enabled() || apiKey() !== key) {
              await next.revoke()
              return
            }
            transport = next
            reason = next.active ? null : 'api-key-not-configured'
          } catch (error) {
            if (currentGeneration === generation) {
              reason = 'listen-failed'
              debugWarn('codingns4dsh: Workspace MCP listener failed', {
                error: error instanceof Error ? error.message : 'unknown error',
              })
            }
          }
        }).catch((error: unknown) => {
          reason = 'listen-failed'
          debugWarn('codingns4dsh: Workspace MCP lifecycle failed', {
            error: error instanceof Error ? error.message : 'unknown error',
          })
        })
      }

      context.resources.add(context.services.rpc.register('workspaceMcp', async (action, _payload, rpcContext) => {
        if (action === 'generate-key') {
          const caller = rpcContext as { readonly peer?: unknown } | undefined
          const connection = (context.services.dshContext as unknown as { readonly connection?: unknown } | undefined)?.connection
          const peer = connection === undefined ? caller?.peer : nativeDispatchPeer(connection, caller?.peer)
          const isOwner = options.isOwner?.(caller?.peer) ?? (connection !== undefined && isCodingNsOwnerPeer(connection, peer))
          if (!isOwner) {
            throw new CodingNsRpcError('CODINGNS_RPC_FORBIDDEN', 'Only the Host owner can generate or rotate the Workspace MCP API key.')
          }
          const settings = context.services.settings
          if (settings === undefined) throw new CodingNsRpcError('WORKSPACE_MCP_SETTINGS_UNAVAILABLE', 'Workspace MCP settings are unavailable.')
          const previousKey = await apiKeyStore.read()
          const nextKey = generateWorkspaceMcpApiKey()
          await apiKeyStore.write(nextKey)
          const previousEnabled = enabledSnapshot
          enabledSnapshot = true
          try {
            const current = settings.get()
            await settings.update({ modules: { ...current.modules, workspaceMcp: true } })
          } catch (error) {
            enabledSnapshot = previousEnabled
            if (previousKey === null) await apiKeyStore.clear()
            else await apiKeyStore.write(previousKey)
            throw error
          }
          storedKey = nextKey
          reconcile()
          await reconcileTail
          return { apiKey: nextKey, enabled: true, listening: transport?.active === true, url: transport?.active === true ? transport.url : null }
        }
        if (action.startsWith('webhook-')) {
          if (!isOwner(rpcContext)) {
            throw new CodingNsRpcError('CODINGNS_RPC_FORBIDDEN', 'Only the Host owner can manage Workspace MCP webhooks.')
          }
          const payload = asRecord(_payload)
          try {
            if (action === 'webhook-list') {
              const snapshot = await webhookStore.snapshot()
              return {
                destinations: snapshot.destinations.map(toWebhookDestinationView),
                deliveries: snapshot.deliveries.slice(-50).reverse().map(toWebhookDeliveryView),
                workspaces: webhookWorkspaceOptions(context.services),
                events: eventAvailability(),
                store: snapshot.store,
                diagnostics: snapshot.diagnostics,
              }
            }
            if (action === 'webhook-create') {
              const input = readWebhookDestinationInput(payload, true)
              const now = new Date().toISOString()
              const secret = randomBytes(32).toString('base64url')
              const destination: WorkspaceMcpWebhookDestination = {
                id: randomUUID(), ...input, secret, enabled: true,
                createdAt: now, updatedAt: now,
              }
              const saved = await webhookStore.createDestination(destination)
              await reconcileWebhooks()
              return { destination: toWebhookDestinationView(saved), secret }
            }
            if (action === 'webhook-update') {
              const id = requiredString(payload?.id, 'id')
              const patch = readWebhookDestinationPatch(payload)
              const saved = await webhookStore.updateDestination(id, patch)
              await reconcileWebhooks()
              return { destination: toWebhookDestinationView(saved) }
            }
            if (action === 'webhook-rotate-secret') {
              const id = requiredString(payload?.id, 'id')
              const secret = randomBytes(32).toString('base64url')
              const saved = await webhookStore.updateDestination(id, { secret })
              await reconcileWebhooks()
              return { destination: toWebhookDestinationView(saved), secret }
            }
            if (action === 'webhook-delete') {
              const id = requiredString(payload?.id, 'id')
              const removed = await webhookStore.removeDestination(id)
              if (!removed) throw new CodingNsRpcError('WORKSPACE_MCP_WEBHOOK_NOT_FOUND', 'The webhook destination was not found.')
              await reconcileWebhooks()
              return { removed: true }
            }
            if (action === 'webhook-test') {
              const id = requiredString(payload?.id, 'id')
              const destination = (await webhookStore.snapshot()).destinations.find((item) => item.id === id)
              if (destination === undefined) throw new CodingNsRpcError('WORKSPACE_MCP_WEBHOOK_NOT_FOUND', 'The webhook destination was not found.')
              const target = { destinationId: destination.id, url: destination.url, secret: destination.secret }
              if (webhookDispatcher !== undefined) return await webhookDispatcher.test(target)
              const dispatcher = new WorkspaceMcpWebhookDispatcher(webhookStore, options.webhookDispatcherOptions)
              try { return await dispatcher.test(target) } finally { await dispatcher.close() }
            }
            throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `Unknown Workspace MCP action: ${action}`)
          } catch (error) {
            if (error instanceof CodingNsRpcError) throw error
            if (error instanceof WorkspaceMcpWebhookStoreError) throw new CodingNsRpcError(error.code, error.message)
            if (error instanceof TypeError || error instanceof RangeError) {
              throw new CodingNsRpcError('WORKSPACE_MCP_WEBHOOK_INVALID_INPUT', error.message)
            }
            throw new CodingNsRpcError('WORKSPACE_MCP_WEBHOOK_STORE_UNAVAILABLE', 'Workspace MCP webhook storage is unavailable.')
          }
        }
        if (action !== 'status') throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `Unknown Workspace MCP action: ${action}`)
        try {
          await reconcileTail
          const key = await apiKeyStore.read()
          return {
            apiKeyConfigured: key !== null || (process.env[API_KEY_ENV]?.trim() ?? '') !== '',
            enabled: enabled(),
            listening: transport?.active === true,
            lanAccessEnabled: settings?.get().modules.workspaceMcpLanAccess === true,
            url: transport?.active === true ? transport.url : null,
            reason: transport?.active === true ? null : reason ?? (enabled() ? 'api-key-not-configured' : 'disabled'),
            capabilities: Object.fromEntries((['workspace.session-control', 'workspace.pending-questions', 'workspace.approval'] as const).map((id) => {
              const capability = capabilityProfile?.capabilities.get(id)
              const diagnostic = capabilityProfile?.diagnostics.find((item) => item.capability === id)
              return [id, { status: capability?.status ?? 'unavailable', diagnostic: diagnostic?.message ?? null }]
            })),
          }
        } catch {
          throw new CodingNsRpcError('WORKSPACE_MCP_KEY_STORE_UNAVAILABLE', 'Workspace MCP key storage could not be read.')
        }
      }))

      if (settings !== undefined) context.resources.add(settings.watch((next) => {
        const nextEnabled = next.modules.workspaceMcp === true
        if (nextEnabled === enabledSnapshot) return
        enabledSnapshot = nextEnabled
        reconcile()
      }))
      reconcile()
      void reconcileWebhooks()
      context.resources.add(async () => {
        webhooksStopped = true
        webhookGeneration += 1
        await webhookTail
        await stopWebhooks()
        await webhookStore.close()
        generation += 1
        toolset.abortRequests()
        await reconcileTail
        const current = transport
        transport = undefined
        if (current !== undefined) await current.revoke()
        await toolset.dispose()
      })
    },
  }
}

const WEBHOOK_EVENT_TYPES = new Set<WorkspaceMcpWebhookEventType>([
  'session.completed', 'session.failed', 'session.permission_requested', 'session.question_asked',
])

function readWebhookDestinationInput(
  payload: Record<string, unknown> | null,
  creating: boolean,
): Pick<WorkspaceMcpWebhookDestination, 'name' | 'url' | 'workspaceIds' | 'eventTypes' | 'includeLastMessage'> {
  if (payload === null) throw new TypeError('A webhook destination object is required.')
  const name = requiredString(payload.name, 'name', 80)
  const url = validateWebhookUrl(payload.url)
  const workspaceIds = readWorkspaceIds(payload.workspaceIds)
  const eventTypes = readWebhookEventTypes(payload.eventTypes)
  const includeLastMessage = payload.includeLastMessage === undefined && creating
    ? true
    : payload.includeLastMessage
  if (typeof includeLastMessage !== 'boolean') throw new TypeError('includeLastMessage must be a boolean.')
  return { name, url, workspaceIds, eventTypes, includeLastMessage }
}

function readWebhookDestinationPatch(payload: Record<string, unknown> | null): Partial<Pick<
  WorkspaceMcpWebhookDestination,
  'name' | 'url' | 'enabled' | 'workspaceIds' | 'eventTypes' | 'includeLastMessage'
>> {
  if (payload === null) throw new TypeError('A webhook destination object is required.')
  const patch: Partial<Pick<WorkspaceMcpWebhookDestination, 'name' | 'url' | 'enabled' | 'workspaceIds' | 'eventTypes' | 'includeLastMessage'>> = {}
  if (payload.name !== undefined) Object.assign(patch, { name: requiredString(payload.name, 'name', 80) })
  if (payload.url !== undefined) Object.assign(patch, { url: validateWebhookUrl(payload.url) })
  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== 'boolean') throw new TypeError('enabled must be a boolean.')
    Object.assign(patch, { enabled: payload.enabled })
  }
  if (payload.workspaceIds !== undefined) Object.assign(patch, { workspaceIds: readWorkspaceIds(payload.workspaceIds) })
  if (payload.eventTypes !== undefined) Object.assign(patch, { eventTypes: readWebhookEventTypes(payload.eventTypes) })
  if (payload.includeLastMessage !== undefined) {
    if (typeof payload.includeLastMessage !== 'boolean') throw new TypeError('includeLastMessage must be a boolean.')
    Object.assign(patch, { includeLastMessage: payload.includeLastMessage })
  }
  if (Object.keys(patch).length === 0) throw new TypeError('At least one webhook setting must be updated.')
  return patch
}

function validateWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 2048) {
    throw new CodingNsRpcError('WORKSPACE_MCP_WEBHOOK_INVALID_URL', 'Enter a valid HTTP or HTTPS address up to 2048 characters.')
  }
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') throw new TypeError()
    return url.toString()
  } catch {
    throw new CodingNsRpcError('WORKSPACE_MCP_WEBHOOK_INVALID_URL', 'Enter a valid HTTP or HTTPS address without a username or password.')
  }
}

function readWorkspaceIds(value: unknown): readonly string[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length > 100 || !value.every((id) => typeof id === 'string' && id.trim() !== '')) {
    throw new TypeError('workspaceIds must be null or an array of up to 100 workspace IDs.')
  }
  return [...new Set(value.map((id: string) => id.trim()))]
}

function readWebhookEventTypes(value: unknown): readonly Exclude<WorkspaceMcpWebhookEventType, 'webhook.test'>[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((type) => typeof type === 'string' && WEBHOOK_EVENT_TYPES.has(type as WorkspaceMcpWebhookEventType))) {
    throw new TypeError('Select at least one supported webhook event.')
  }
  return [...new Set(value)] as Exclude<WorkspaceMcpWebhookEventType, 'webhook.test'>[]
}

function requiredString(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > maximum) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maximum} characters.`)
  }
  return value.trim()
}

function toWebhookDestinationView(destination: WorkspaceMcpWebhookDestination): Record<string, unknown> {
  const url = new URL(destination.url)
  return {
    id: destination.id,
    name: destination.name,
    url: `${url.origin}/…`,
    secretConfigured: true,
    enabled: destination.enabled,
    workspaceIds: destination.workspaceIds,
    eventTypes: destination.eventTypes,
    includeLastMessage: destination.includeLastMessage,
    createdAt: destination.createdAt,
    updatedAt: destination.updatedAt,
  }
}

function toWebhookDeliveryView(delivery: import('../workspace-mcp/webhook-store.js').WorkspaceMcpWebhookDelivery): Record<string, unknown> {
  return {
    deliveryId: delivery.deliveryId,
    eventId: delivery.eventId,
    destinationId: delivery.destinationId,
    destinationName: delivery.destinationName,
    eventType: delivery.eventType,
    status: delivery.status,
    attempts: delivery.attempts,
    ...(delivery.httpStatus === undefined ? {} : { httpStatus: delivery.httpStatus }),
    lastError: delivery.lastError,
    createdAt: delivery.createdAt,
    finishedAt: delivery.finishedAt,
  }
}

function webhookWorkspaceOptions(services: CodingNsHostServices): Array<{ readonly id: string; readonly name: string }> {
  const registry = asRecord(services.dshContext?.get('workspaceRegistry'))
  if (typeof registry?.list !== 'function') return []
  try {
    const rows = (registry.list as () => unknown).call(registry)
    if (!Array.isArray(rows)) return []
    return rows.flatMap((value) => {
      const row = asRecord(value)
      const id = row?.id ?? row?.workspaceId ?? row?.key
      const root = typeof id === 'string' ? services.resolveManagedWorkspaceRoot?.(id) : null
      const name = row?.title ?? row?.displayName ?? row?.name
      return typeof id === 'string' && typeof root === 'string' && root.trim() !== ''
        ? [{ id, name: typeof name === 'string' && name.trim() !== '' ? name.trim() : id }]
        : []
    })
  } catch { return [] }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
