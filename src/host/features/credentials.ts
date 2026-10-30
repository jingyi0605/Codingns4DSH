import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CredentialMutation } from '../../shared/contracts/credentials.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { isCodingNsOwnerPeer } from '../../dsh-capabilities/host/connection-peer-adapter.js'
import type { CodingNsHostServices } from './types.js'

export function createCredentialsFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'credentials',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    async start(context) {
      const service = context.services.credentials
      const broker = context.services.credentialBroker
      if (service === undefined) throw new CodingNsRpcError('CREDENTIAL_STORE_UNAVAILABLE', 'Credential service is unavailable')
      service.activate()
      if (broker === undefined) throw new CodingNsRpcError('CREDENTIAL_BROKER_UNAVAILABLE', 'Credential broker is unavailable')
      await broker.activate()
      const connection = (context.services.dshContext as { readonly connection?: unknown } | undefined)?.connection
      const requireOwner = (rpcContext: unknown): void => {
        const peer = isRecord(rpcContext) ? rpcContext.peer : undefined
        if (connection !== undefined && !isCodingNsOwnerPeer(connection, peer)) {
          throw new CodingNsRpcError('CODINGNS_RPC_FORBIDDEN', 'Credential changes require the Host owner')
        }
      }
      context.resources.add(context.services.rpc.register('credentials', async (action, payload, rpcContext) => {
        if (action === 'list') {
          const options = isRecord(payload) ? payload : {}
          if (options.query !== undefined || options.cursor !== undefined || options.limit !== undefined) {
            return service.listPage({
              ...(typeof options.query === 'string' ? { query: options.query } : {}),
              ...(typeof options.cursor === 'string' ? { cursor: options.cursor } : {}),
              ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
            })
          }
          return service.list()
        }
        if (action === 'master-password/status') return service.masterPasswordStatus()
        if (action === 'issue') {
          requireOwner(rpcContext)
          const value = isRecord(payload) ? payload : {}
          const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
          const credentialId = typeof value.credentialId === 'string' ? value.credentialId : ''
          const bindings = Array.isArray(value.bindings)
            ? value.bindings.filter((item): item is { readonly field: string; readonly env: string } => isRecord(item) && typeof item.field === 'string' && typeof item.env === 'string')
            : undefined
          if (bindings === undefined) return broker.issueDefault(sessionId, credentialId)
          return broker.issue({ sessionId, credentialId, bindings })
        }
        if (action === 'capability') {
          return {
            command: 'codingns-credential',
            available: broker.nativeToolAvailable(),
            ttlMs: broker.validityMs,
          }
        }
        requireOwner(rpcContext)
        if (action === 'save') return { credential: await service.save(payload as CredentialMutation) }
        if (action === 'delete') {
          const id = isRecord(payload) && typeof payload.id === 'string' ? payload.id : ''
          await service.delete(id)
          broker.revokeCredential(id)
          return { deleted: true }
        }
        if (action === 'master-password/set') {
          const value = isRecord(payload) ? payload : {}
          await service.setMasterPassword({
            ...(typeof value.currentPassword === 'string' ? { currentPassword: value.currentPassword } : {}),
            password: typeof value.password === 'string' ? value.password : '',
          })
          return await service.masterPasswordStatus()
        }
        throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `Unknown credentials action: ${action}`)
      }))
      context.resources.add(async () => {
        await broker.deactivate()
        service.deactivate()
      })
    },
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
