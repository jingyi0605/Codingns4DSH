export {
  CODINGNS_CONTROL_BASE_URL_FIELD,
  CODINGNS_CONTROL_BASE_URLS_FIELD,
  CODINGNS_LAN_ACCESS_DSH_FIELD,
  CODINGNS_MODULES_FIELD,
  CODINGNS_SETTINGS_NAMESPACE,
  DEFAULT_CODINGNS_CONTROL_BASE_URL,
  DEFAULT_CODINGNS_CONTROL_BASE_URLS,
  DEFAULT_CODINGNS_SETTINGS,
  enabledFeatureNames,
  isFeatureEnabled,
  type CodingNsSettings,
  type LanAccessDshSettings,
} from './contracts/config.js'
export type {
  FeatureContext,
  FeatureDescriptor,
  FeatureDisposer,
  FeatureModule,
  FeatureResourceScope,
  FeatureRuntime,
  FeatureState,
  FeatureUiDescriptor,
} from './contracts/feature.js'
export {
  CODINGNS_DSH_ERROR_CODES,
  CodingNsDshError,
  SUPPORTED_DSH_VERSION,
  assertSupportedDshVersion,
  type CodingNsDshErrorCode,
} from './contracts/errors.js'
export type {
  CodingNsRpcRequest,
  CodingNsStreamRequest,
  CodingNsTransport,
  CodingNsTransportErrorShape,
  CodingNsTransportGeneration,
  CodingNsTransportHooks,
} from './contracts/transport.js'
export { CODINGNS_RPC_CHANNEL } from './contracts/transport.js'
export type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliAdapterId,
  CodingNsCliMessage,
  CodingNsCliModel,
  CodingNsCliModelCatalog,
  CodingNsCliModelGroup,
  CodingNsCliSessionConfig,
  CodingNsCliStreamChunk,
  CodingNsCliTurnInput,
} from './contracts/cli-adapter.js'
export type {
  PeerHostRecord,
  PeerHostStatus,
  ResourceScopeDisposer,
  ResourceScopeInput,
  ResourceScopeRef,
  ResourceScopeSnapshot,
} from './contracts/peer-host.js'
export { ResourceScopeStaleError } from './contracts/peer-host.js'
export type {
  LanAccessDshConfig,
  LanAccessDshSnapshot,
  LanAccessDshState,
} from './contracts/lan-access-dsh.js'
export type {
  AccountProfile,
  AuthClientType,
  AuthDeviceManagementSnapshotDto,
  AuthDeviceViewDto,
  CodingNsAuthLoginResult,
  CodingNsAuthSessionSnapshot,
  CodingNsAuthStatus,
  HostBindRequest,
  HostBindResponse,
  HostBindingsResponse,
  HostLabelAvailabilityResponse,
  HostUnbindResponse,
  LoginByEmailRequest,
  TunnelBindingSummary,
} from './contracts/auth.js'
export type {
  RelayIceServer,
  RelaySignalingTicketRequest,
  RelaySignalingClientMessage,
  RelaySignalingServerMessage,
  RelaySignalingTicketResponse,
} from './contracts/signaling.js'
