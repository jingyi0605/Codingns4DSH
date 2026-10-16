import { randomUUID } from 'node:crypto'
import { CodingNsRpcError } from '../../rpc-table.js'
import type { QuickAppPeerGateway } from '../quick-apps/remote.js'
import type { PeerHostStore } from './peer-host-store.js'
import type { PeerHostHttpProxyService } from './host-api-proxy-service.js'
import { readNativeRpcEnvelope } from './peer-host-native-transport.js'

export function createQuickAppPeerGateway(store: PeerHostStore, httpProxy: PeerHostHttpProxyService, localHostId: string): QuickAppPeerGateway {
  return {
    async call(hostId, workspaceId, action, payload, signal) {
      const record = await store.get(hostId)
      if (!record || record.status === 'disabled' || record.status === 'identity_changed'
        || !(record.visibleWorkspaceIds ?? []).includes(workspaceId)
        || !['validate', 'launch', 'grant', 'revoke', 'close', 'browse', 'document', 'resource'].includes(action)) {
        throw new CodingNsRpcError('QUICK_APP_HOST_UNAVAILABLE', 'The owning Host or managed workspace is unavailable.')
      }
      if (record.route.kind === 'relay') throw new CodingNsRpcError('QUICK_APP_RELAY_UNAVAILABLE', 'This PeerHost relay cannot deliver Quick Apps. Use a supported direct connection to the owning Host.')
      const response = await httpProxy.request(hostId, {
        scope: { hostId: localHostId, targetHostId: hostId, workspaceId, sessionId: null, scopeGeneration: 0 },
        path: '/api/codingns/quickApps/remote', method: 'POST',
        body: JSON.stringify({ rpcId: `quick-app-${randomUUID()}`, method: 'quickApps/remote', payload: { ...payload, ...(action === 'browse' ? { workspaceId } : {}), action } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      })
      if (response.status !== 200) throw new CodingNsRpcError('QUICK_APP_HOST_UNAVAILABLE', 'The owning Host does not provide a supported Quick Apps route.')
      return readNativeRpcEnvelope(response.body)
    },
  }
}
