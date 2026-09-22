/** Host 入口是包根导出；共享契约通过显式子路径另行提供。 */
import { apply as hostApply } from './host/index.js'

/** Cordis Bundle 标准插件名称。 */
export const name = 'dsh-codingns'
/** Host Cordis 入口。 */
export const apply = hostApply
export default hostApply
export { createCodingNsRpcHandler, registerCodingNsRpc } from './host/rpc.js'
export {
  CodingNsRpcError,
  CodingNsRpcTable,
  type CodingNsRpcHandler,
  type CodingNsRpcTarget,
} from './host/rpc-table.js'
export { HOST_FEATURES, createAuthFeature, createLanAccessDshFeature } from './host/features/index.js'
export type { CodingNsHostServices } from './host/features/index.js'
export { CODINGNS_RPC_CHANNEL } from './shared/contracts/transport.js'
export {
  CODINGNS_CONTROL_BASE_URL_FIELD,
  CODINGNS_LAN_ACCESS_DSH_FIELD,
  CODINGNS_MODULES_FIELD,
  CODINGNS_SETTINGS_NAMESPACE,
  DEFAULT_CODINGNS_SETTINGS,
  enabledFeatureNames,
  isFeatureEnabled,
} from './shared/contracts/config.js'
export type * from './shared/index.js'
export {
  FeatureRegistry,
  FeatureRegistryError,
  FeatureResourceScopeImpl,
} from './features/registry.js'
export type {
  FeatureRegistryErrorCode,
  FeatureSnapshot,
} from './features/registry.js'
export { ResourceScopeManager } from './features/resource-scope/index.js'
export {
  CodingNsAuthSession,
} from './host/auth-session.js'
export {
  CODINGNS_CONTROL_API_PATHS,
  CodingNsControlApiError,
  HttpCodingNsControlApiClient,
  type CodingNsControlApiClient,
  type CodingNsControlClient,
  type HttpCodingNsControlApiClientOptions,
} from './host/control-api-client.js'
export {
  InMemoryCodingNsCredentialStore,
  type CodingNsCredentialStore,
} from './host/credential-store.js'
export type { HostCredentialRecord } from './host/credential-store.js'
export {
  LanAccessDshError,
  LanAccessDshProxy,
  createLanAccessDshRpcHandler,
  createNodeLanAccessDshRuntime,
  normalizeLanAccessDshConfig,
} from './host/lan-access-dsh.js'
export type { LanAccessDshRuntime, LanAccessDshStream } from './host/lan-access-dsh.js'
export type {
  LoginByEmailResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
} from './host/control-api-client.js'
export {
  DshCodingNsTransport,
  DshTunnelMultiplexer,
  createDataChannelCarrier,
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_PROTOCOL_VERSION,
  validateTunnelFrame,
  tunnelFrameByteLength,
  DEFAULT_MAX_TUNNEL_FRAME_BYTES,
  assertDtlsFingerprint,
  connectWebRtcClient,
  createSignalingUrl,
  extractDtlsFingerprint,
  acceptWebRtcHost,
  createHostSignalingTicketRequest,
  requestHostSignalingTicket,
} from './transport/index.js'
export {
  bindDshConnection,
  bindDshConnectionHooks,
  createDshClientTransportHooks,
  createDshGenerationSource,
  createDshGenerationSourceFromHooks,
  installDshTransport,
  SUPPORTED_DSH_CONNECTION_VERSION,
} from './bootstrap/index.js'
export type {
  DshClientTransportHooks,
  DshConnectionContext,
  DshConnectionHandle,
  DshConnectionRpcFailure,
  DshConnectionRpcResponse,
  DshConnectionRpcResult,
  DshGenerationSource,
  DshTransportLifecycle,
} from './bootstrap/index.js'
export type {
  CodingNsCarrier,
  DataChannelLike,
  DshCodingNsTransportOptions,
  TunnelChannel,
  TunnelFrame,
  TunnelFrameKind,
  PeerConnectionLike,
  SignalingSocketLike,
  WebRtcClientConnection,
  WebRtcClientConnectorOptions,
  HostPeerConnectionLike,
  HostSignalingTicketRequest,
  WebRtcHostAcceptor,
  WebRtcHostAcceptorOptions,
  WebRtcHostSession,
  DshTunnelMultiplexerOptions,
  TunnelFlowControl,
  TunnelFrameCodecOptions,
} from './transport/index.js'
