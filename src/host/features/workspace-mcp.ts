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

const API_KEY_ENV = 'CODINGNS_WORKSPACE_MCP_API_KEY'

/** Owns the public MCP status RPC and the optional authenticated loopback listener. */
export function createWorkspaceMcpHostFeature(options: {
  readonly apiKeyStore?: WorkspaceMcpApiKeyStore
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
      const apiKeyStore = options.apiKeyStore ?? new FileWorkspaceMcpApiKeyStore()
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
      context.resources.add(async () => {
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
