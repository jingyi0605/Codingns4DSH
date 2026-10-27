import type { FeatureModule } from '../../shared/contracts/feature.js'
import { debugWarn } from '../../shared/debug.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { startWorkspaceMcpTransport } from '../workspace-mcp/transport.js'
import { createWorkspaceMcpToolHandlers } from '../workspace-mcp/tools.js'
import type { WorkspaceMcpAdapterRegistry } from '../workspace-mcp/tools.js'
import { getAdapterRegistry } from '../cli-adapters/registry-holder.js'
import { createDshCapabilityRegistry } from '../../dsh-capabilities/routes.js'
import type { WorkspaceApprovalAdapter } from '../../dsh-capabilities/host/workspace-approval-adapter.js'
import type { WorkspacePendingQuestionsAdapter } from '../../dsh-capabilities/host/workspace-pending-questions-adapter.js'
import type { WorkspaceSessionControlAdapter } from '../../dsh-capabilities/host/workspace-session-control-adapter.js'
import type { CodingNsHostServices } from './types.js'

const API_KEY_ENV = 'CODINGNS_WORKSPACE_MCP_API_KEY'

/** Owns the public MCP status RPC and the optional authenticated loopback listener. */
export function createWorkspaceMcpHostFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'workspaceMcp',
      version: '0.1.0',
      enabledByDefault: false,
      dependencies: [],
      runtime: 'host',
      requires: [
        { capability: 'workspace.session-control', required: false, fallback: 'degrade' },
        { capability: 'workspace.pending-questions', required: false, fallback: 'degrade' },
        { capability: 'workspace.approval', required: false, fallback: 'degrade' },
      ],
    },
    start(context) {
      let transport: Awaited<ReturnType<typeof startWorkspaceMcpTransport>> | undefined
      let reason: string | null = null
      let listenerKey = ''
      let generation = 0
      let reconcileTail = Promise.resolve()
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
      const apiKey = (): string => process.env[API_KEY_ENV]?.trim() ?? ''
      let enabledSnapshot = enabled()

      const reconcile = (): void => {
        const currentGeneration = ++generation
        reconcileTail = reconcileTail.then(async () => {
          if (transport !== undefined) {
            const previous = transport
            transport = undefined
            listenerKey = ''
            await previous.revoke()
          }
          toolset.abortRequests()
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
            listenerKey = key
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

      context.resources.add(context.services.rpc.register('workspaceMcp', (action) => {
        if (action !== 'status') throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `Unknown Workspace MCP action: ${action}`)
        return {
          apiKeyConfigured: apiKey() !== '',
          enabled: enabled(),
          listening: transport?.active === true,
          url: transport?.active === true ? transport.url : null,
          reason: transport?.active === true ? null : reason ?? (enabled() ? 'api-key-not-configured' : 'disabled'),
          capabilities: Object.fromEntries((['workspace.session-control', 'workspace.pending-questions', 'workspace.approval'] as const).map((id) => {
            const capability = capabilityProfile?.capabilities.get(id)
            const diagnostic = capabilityProfile?.diagnostics.find((item) => item.capability === id)
            return [id, { status: capability?.status ?? 'unavailable', diagnostic: diagnostic?.message ?? null }]
          })),
        }
      }))

      const settings = context.services.settings
      if (settings !== undefined) context.resources.add(settings.watch((next) => {
        const nextEnabled = next.modules.workspaceMcp === true
        if (nextEnabled === enabledSnapshot) return
        enabledSnapshot = nextEnabled
        reconcile()
      }))
      reconcile()
      const keyMonitor = setInterval(() => {
        const currentKey = apiKey()
        if (currentKey !== listenerKey && (transport?.active === true || enabled() && currentKey !== '')) reconcile()
      }, 1000)
      keyMonitor.unref?.()
      context.resources.add(() => clearInterval(keyMonitor))
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


export function workspaceMcpConfiguredApiKey(): boolean {
  return (process.env[API_KEY_ENV]?.trim() ?? '') !== ''
}
