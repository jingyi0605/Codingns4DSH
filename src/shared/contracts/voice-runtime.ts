export type VoiceRuntimeState = 'disabled' | 'loading' | 'standby' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error'

export interface VoiceRuntimeCapabilities {
  readonly realtime: boolean
  readonly wakeWord: boolean
  readonly streamingInput: boolean
  readonly streamingOutput: boolean
  readonly bargeIn: boolean
  readonly speechToText: boolean
  readonly textToSpeech: boolean
}

export type VoiceRuntimeEvent =
  | { readonly type: 'state'; readonly state: VoiceRuntimeState; readonly epoch: number }
  | { readonly type: 'wake'; readonly epoch: number }
  | { readonly type: 'partial'; readonly text: string; readonly epoch: number }
  | { readonly type: 'final'; readonly text: string; readonly epoch: number; readonly requestId?: string }
  | { readonly type: 'reply'; readonly text: string; readonly epoch: number; readonly requestId: string; readonly final: boolean }
  | { readonly type: 'audio'; readonly bytes: Uint8Array; readonly sampleRate?: number; readonly channels?: 1; readonly epoch: number }
  | { readonly type: 'barge-in'; readonly epoch: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly recoverable: boolean; readonly epoch: number }

export type VoiceRuntimeListener = (event: VoiceRuntimeEvent) => void

export interface VoiceConversationMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface VoicePcmFrame {
  readonly sequence: number
  readonly bytes: Uint8Array
  readonly sampleRate: number
  readonly channels: 1
}

export interface VoiceClientDevice {
  readonly deviceId: string
  readonly label: string
  readonly groupId: string
  readonly kind: 'audioinput' | 'audiooutput'
}

export interface VoiceClientDeviceSnapshot {
  readonly secureContext: boolean
  readonly permission: 'unknown' | 'prompt' | 'granted' | 'denied'
  readonly inputs: readonly VoiceClientDevice[]
  readonly outputs: readonly VoiceClientDevice[]
  readonly selectedInputId: string | null
  readonly selectedOutputId: string | null
}

export interface VoiceClientDeviceManager {
  snapshot(): VoiceClientDeviceSnapshot
  refresh(): Promise<VoiceClientDeviceSnapshot>
  selectInput(deviceId: string): Promise<VoiceClientDeviceSnapshot>
  selectOutput(deviceId: string): Promise<VoiceClientDeviceSnapshot>
  requestInputPermission(): Promise<VoiceClientDeviceSnapshot>
  subscribe(listener: (snapshot: VoiceClientDeviceSnapshot) => void): () => void
  dispose(): void
}

export interface VoiceRuntimeAdapter {
  readonly capabilities: VoiceRuntimeCapabilities | (() => VoiceRuntimeCapabilities)
  start(ownerId?: string): Promise<void> | void
  /** 协调器在租约 epoch 变更时同步运行时事件的来源代次。 */
  setEpoch?(epoch: number): void
  stop(): Promise<void> | void
  interrupt(): Promise<void> | void
  sendPcm?(frame: VoicePcmFrame, epoch: number): Promise<void> | void
  speak?(text: string, epoch: number): Promise<void> | void
  /** 清空展示时同步清除 Host 多轮历史和当前生成。 */
  clearConversation?(): Promise<void> | void
  subscribe(listener: VoiceRuntimeListener): () => void
}

export class UnavailableVoiceRuntimeAdapter implements VoiceRuntimeAdapter {
  readonly capabilities: VoiceRuntimeCapabilities = {
    realtime: false,
    wakeWord: false,
    streamingInput: false,
    streamingOutput: false,
    bargeIn: false,
    speechToText: false,
    textToSpeech: false,
  }

  start(): void { throw new Error('全局语音运行时不可用') }
  stop(): void {}
  interrupt(): void {}
  subscribe(): () => void { return () => undefined }
}
