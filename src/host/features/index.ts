import type { FeatureModule } from '../../shared/contracts/feature.js'
import { createAuthFeature } from './auth.js'
import { createLanAccessDshFeature } from './lan-access-dsh.js'
import { createTerminalStatusFeature } from './terminal-status.js'
import { createCliAdaptersFeature } from '../cli-adapters/feature.js'
import { createTerminalProcessFeature } from './terminal-process.js'
import { createDebugFeature } from './debug.js'
import { createHostStatusFeature } from './host-status.js'
import { createGitManagementFeature } from './git-management.js'
import { createFileManagementFeature } from './file-management.js'
import { createPeerHostFeature } from './peer-host.js'
import { createGlobalVoiceRpcFeature } from './global-voice-rpc.js'
import type { CodingNsHostServices } from './types.js'

export interface HostFeatureOptions {
  readonly terminalStatus?: Parameters<typeof createTerminalStatusFeature>[0]
}

/** 生产启动可把实际 controller 模式注入状态模块，避免向设置页报告默认占位值。 */
export function createHostFeatures(options: HostFeatureOptions = {}): readonly FeatureModule<CodingNsHostServices>[] {
  return [
    createAuthFeature(),
    createLanAccessDshFeature(),
    createTerminalStatusFeature(options.terminalStatus),
    createCliAdaptersFeature(),
    createTerminalProcessFeature(),
    createDebugFeature(),
    createHostStatusFeature(),
    createGitManagementFeature(),
    createFileManagementFeature(),
    createPeerHostFeature(),
    createGlobalVoiceRpcFeature(),
  ]
}

/** Host 侧功能模块清单：新增模块在这里登记一行，不需要改动入口或 RPC 分发。 */
export const HOST_FEATURES: readonly FeatureModule<CodingNsHostServices>[] = createHostFeatures()

export { createAuthFeature } from './auth.js'
export { createLanAccessDshFeature } from './lan-access-dsh.js'
export { createTerminalStatusFeature } from './terminal-status.js'
export { createCliAdaptersFeature } from '../cli-adapters/feature.js'
export { createTerminalProcessFeature } from './terminal-process.js'
export { createDebugFeature } from './debug.js'
export { createHostStatusFeature } from './host-status.js'
export { createGitManagementFeature } from './git-management.js'
export { createFileManagementFeature } from './file-management.js'
export { createPeerHostFeature, toPeerHostClientRecord } from './peer-host.js'
export {
  buildAssistantSummary,
  normalizeSpeechText,
  redactSensitiveValues,
  sanitizeSpeechText,
  summarizeAssistantSessions,
} from './assistant-summary.js'
export { VoiceAgentService } from './voice-agent-service.js'
export { GlobalVoiceCoordinator } from './global-voice-coordinator.js'
export { createGlobalVoiceRpcFeature } from './global-voice-rpc.js'
export { SherpaVoiceRuntime, float32ToPcm16, pcm16ToFloat32 } from './sherpa-voice-runtime.js'
export { createAssistantVoiceStreamHandler } from './assistant-voice-stream.js'
export { AssistantVoiceTurnRouter } from './assistant-voice-turn.js'
export { createAssistantVoiceActionBridge } from './voice-agent-actions.js'
export type { AssistantVoiceActionBridge, AssistantVoiceActionBridgeOptions } from './voice-agent-actions.js'
export type {
  StartConversationOptions,
  VoiceAction,
  VoiceActionControl,
  VoiceActionRegistration,
  VoiceAgentCapabilities,
  VoiceConversation,
  VoiceEvent,
} from './voice-agent-service.js'
export type { CodingNsHostServices } from './types.js'
