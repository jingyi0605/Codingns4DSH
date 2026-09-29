import type { AggregateHostResult, PeerHostClientRecord, PeerHostDiagnosticSnapshot, PeerHostRoute, PeerHostWebSocketEndpoint } from '../shared/contracts/peer-host.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'

export interface PeerHostCreateRequest {
  readonly displayName: string
  readonly route: PeerHostRoute
}

export interface PeerHostUpdateRequest {
  readonly peerHostId: string
  readonly displayName?: string
  readonly route?: PeerHostRoute
}

export interface PeerHostLoginRequest {
  readonly peerHostId: string
  readonly username: string
  readonly password: string
}

export interface PeerHostWorkspaceOrder {
  readonly orderedWorkspaceIds: readonly string[]
  readonly persistedWorkspaceIds: readonly string[]
}

export interface PeerHostManagementApi {
  list(): Promise<readonly PeerHostClientRecord[]>
  create(input: PeerHostCreateRequest): Promise<PeerHostClientRecord>
  update(input: PeerHostUpdateRequest): Promise<PeerHostClientRecord>
  remove(peerHostId: string): Promise<void>
  check(peerHostId: string): Promise<PeerHostClientRecord>
  reconnect(peerHostId: string): Promise<PeerHostClientRecord>
  login(input: PeerHostLoginRequest): Promise<{ readonly peerHostId: string; readonly status: string; readonly expiresAt: number | null }>
  logout(peerHostId: string): Promise<{ readonly peerHostId: string; readonly status: string; readonly expiresAt: number | null }>
  webSocketEndpoint(): Promise<PeerHostWebSocketEndpoint | null>
  aggregate(): Promise<readonly AggregateHostResult[]>
  workspaceOrder(): Promise<PeerHostWorkspaceOrder>
  moveWorkspace(virtualWorkspaceId: string, beforeVirtualWorkspaceId: string | null): Promise<readonly string[]>
  diagnostics(): Promise<readonly PeerHostDiagnosticSnapshot[]>
}

/** PeerHost 管理 RPC 封装；客户端不接受目标凭据字段。 */
export function createPeerHostManagementApi(rpc: CodingNsRpcClient): PeerHostManagementApi {
  const call = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    let result
    try {
      result = await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/HTTP (?:404|405)\b/u.test(message)) throw error
      result = await rpc.call('/api', `codingns/${endpoint}`, payload)
    }
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  return {
    list: () => call('peerHost/list', {}),
    create: (input) => call('peerHost/create', input),
    update: (input) => call('peerHost/update', input),
    remove: (peerHostId) => call('peerHost/remove', { peerHostId }).then(() => undefined),
    check: (peerHostId) => call('peerHost/check', { peerHostId }),
    reconnect: (peerHostId) => call('peerHost/reconnect', { peerHostId }),
    login: (input) => call('peerHost/login', input),
    logout: (peerHostId) => call('peerHost/logout', { peerHostId }),
    webSocketEndpoint: () => call('peerHost/wsEndpoint', {}),
    aggregate: () => call('peerHost/aggregate', {}),
    workspaceOrder: () => call('peerHost/workspaceOrder', { action: 'get' }),
    moveWorkspace: (virtualWorkspaceId, beforeVirtualWorkspaceId) => call<{ orderedWorkspaceIds: readonly string[] }>('peerHost/workspaceOrder', {
      action: 'move',
      virtualWorkspaceId,
      beforeVirtualWorkspaceId,
    }).then((result) => result.orderedWorkspaceIds),
    diagnostics: () => call('peerHost/diagnostics', {}),
  }
}
