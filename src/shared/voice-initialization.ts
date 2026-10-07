import type { AssistantTtsSnapshot } from './assistant-tts.js'

export { DEFAULT_VOICE_MODEL_ID } from './voice-models.js'
/** 保留旧导出名，避免破坏已有调用；默认策略已经改为中英双语。 */
export { DEFAULT_VOICE_MODEL_ID as DEFAULT_LIGHT_VOICE_MODEL_ID } from './voice-models.js'
export type VoiceInitializationPhase = 'idle' | 'recognition' | 'speech' | 'completed' | 'failed'
/** 向导就绪由识别验证与播报就绪共同决定，不能只看文件存在或一个 initialized 标志。 */
export interface AssistantVoiceInitializationSnapshot {
  readonly ready: boolean
  readonly busy: boolean
  readonly phase: VoiceInitializationPhase
  readonly recognitionReady: boolean
  readonly modelId: string
  readonly modelLabel: string
  readonly tts: AssistantTtsSnapshot
  readonly progress: { readonly label: string; readonly downloadedBytes: number; readonly totalBytes: number | null } | null
  readonly error: string | null
}
