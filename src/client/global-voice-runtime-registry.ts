import type { CodingNsClientServices } from './features/types.js'
import type { VoiceRuntimeAdapter } from '../shared/contracts/voice-runtime.js'

export interface GlobalVoiceAdapter extends VoiceRuntimeAdapter {
  readonly capabilities: import('../shared/contracts/voice-runtime.js').VoiceRuntimeCapabilities
  readonly configuredOwnerId: string
  readonly ownerId: string | undefined
  readonly inputDeviceId: string | undefined
  readonly outputDeviceId: string | undefined
  readonly outputDeviceSupported: boolean
  readonly isMicrophoneMuted?: boolean
  readonly isSpeakerMuted?: boolean
  setMicrophoneMuted?(muted: boolean): void
  setSpeakerMuted?(muted: boolean): void
  start(ownerId?: string): Promise<void>
  stop(): Promise<void>
  interrupt(): Promise<void>
  enumerateInputDevices(): Promise<readonly { readonly deviceId: string; readonly label: string }[]>
  enumerateOutputDevices(): Promise<readonly { readonly deviceId: string; readonly label: string }[]>
  selectInputDevice(deviceId: string): Promise<void>
  selectOutputDevice(deviceId: string): Promise<void>
  dispose?(): void
}

const adapters = new WeakMap<CodingNsClientServices, GlobalVoiceAdapter>()

export function registerGlobalVoiceAdapter(services: CodingNsClientServices, adapter: GlobalVoiceAdapter): () => void {
  adapters.set(services, adapter)
  return () => {
    if (adapters.get(services) === adapter) adapters.delete(services)
  }
}

export function getGlobalVoiceAdapter(services: CodingNsClientServices): GlobalVoiceAdapter | undefined {
  return adapters.get(services)
}
