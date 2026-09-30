import type { AggregateHostResult, PeerHostClientRecord, PeerHostDiagnosticSnapshot, PeerHostRoute, PeerHostWebSocketEndpoint } from '../shared/contracts/peer-host.js'
import type { DshHostStatus } from '../shared/contracts/host-status.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'

export interface PeerHostCreateRequest {
  readonly displayName: string
  readonly route: PeerHostRoute
  readonly color?: string | null
}

export interface PeerHostUpdateRequest {
  readonly peerHostId: string
  readonly displayName?: string
  readonly route?: PeerHostRoute
  readonly color?: string | null
  /**
   * 一次性保存的目标账号密码。
   *
   * 只在本次调用中传输；Host 用它完成握手与登录后加密保存，客户端不留副本。
   * 省略表示保持已有登录态不变。
   */
  readonly username?: string
  readonly password?: string
}

/** 远端 Host 已登记的工作区候选；供"添加工作区"选择器使用，不含会话正文。 */
export interface PeerHostRemoteWorkspaceCandidate {
  readonly workspaceId: string
  readonly displayName: string
  readonly path: string
  readonly sessionCount: number
}

export interface PeerHostCredentialStatus {
  readonly peerHostId: string
  readonly hasSavedCredential: boolean
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
  enable(peerHostId: string): Promise<PeerHostClientRecord>
  disable(peerHostId: string): Promise<PeerHostClientRecord>
  check(peerHostId: string): Promise<PeerHostClientRecord>
  reconnect(peerHostId: string): Promise<PeerHostClientRecord>
  status(peerHostId: string): Promise<DshHostStatus>
  login(input: PeerHostLoginRequest): Promise<{ readonly peerHostId: string; readonly status: string; readonly expiresAt: number | null }>
  logout(peerHostId: string): Promise<{ readonly peerHostId: string; readonly status: string; readonly expiresAt: number | null }>
  credentialStatus(peerHostId: string): Promise<PeerHostCredentialStatus>
  workspaceCandidates(peerHostId: string): Promise<readonly PeerHostRemoteWorkspaceCandidate[]>
  setWorkspaceVisibility(peerHostId: string, workspaceId: string, visible: boolean): Promise<PeerHostClientRecord>
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
    enable: (peerHostId) => call('peerHost/enable', { peerHostId }),
    disable: (peerHostId) => call('peerHost/disable', { peerHostId }),
    check: (peerHostId) => call('peerHost/check', { peerHostId }),
    reconnect: (peerHostId) => call('peerHost/reconnect', { peerHostId }),
    status: (peerHostId) => call('peerHost/status', { peerHostId }),
    login: (input) => call('peerHost/login', input),
    logout: (peerHostId) => call('peerHost/logout', { peerHostId }),
    credentialStatus: (peerHostId) => call('peerHost/credentialStatus', { peerHostId }),
    workspaceCandidates: (peerHostId) => call('peerHost/workspaceCandidates', { peerHostId }),
    setWorkspaceVisibility: (peerHostId, workspaceId, visible) => call('peerHost/setWorkspaceVisibility', { peerHostId, workspaceId, visible }),
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
