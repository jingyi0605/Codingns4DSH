import type { AssistantTtsSnapshot } from '../../shared/assistant-tts.js'
import { DEFAULT_VOICE_MODEL_ID, type AssistantVoiceInitializationSnapshot, type VoiceInitializationPhase } from '../../shared/voice-initialization.js'
import { findAssistantVoiceModel, type AssistantVoiceModelProgress, type AssistantVoiceModelsSnapshot } from '../../shared/voice-models.js'

interface VoiceInitializationServices {
  readonly readModels: () => Promise<AssistantVoiceModelsSnapshot>
  readonly readTts: () => Promise<AssistantTtsSnapshot>
  readonly prepareModel: (modelId: string) => Promise<unknown>
  readonly prepareTts: () => Promise<unknown>
  readonly selectTts: (id: string) => Promise<unknown>
  readonly modelProgress: () => AssistantVoiceModelProgress | null
  readonly active: () => boolean
}

/** 首次配置只负责资源准备；已有识别选择、音色、参数和导入资料均由原服务保管。 */
export class AssistantVoiceInitialization {
  private pending = false
  private phase: VoiceInitializationPhase = 'idle'
  private error: string | null = null
  constructor(private readonly services: VoiceInitializationServices) {}
  get busy(): boolean { return this.pending }
  reset(): void { this.phase = 'idle'; this.error = null }

  async snapshot(): Promise<AssistantVoiceInitializationSnapshot> {
    const [models, tts] = await Promise.all([this.services.readModels(), this.services.readTts()])
    const selected = models.models.find((model) => model.current)
    const modelId = models.currentModelId ?? DEFAULT_VOICE_MODEL_ID
    const recognitionReady = selected?.state === 'downloaded' && selected.validation.state === 'passed'
    const progress = this.services.modelProgress()
    const downloadingSpeech = this.phase === 'speech' || tts.status.busy
    return { ready: recognitionReady && tts.status.ready && tts.settings.backend === 'moss-onnx',
      busy: this.pending || models.operation !== null || tts.status.busy, phase: this.phase,
      recognitionReady, modelId, modelLabel: findAssistantVoiceModel(modelId)?.label ?? modelId, tts,
      progress: downloadingSpeech ? { label: tts.status.phase, downloadedBytes: tts.status.downloadedBytes, totalBytes: tts.status.totalBytes }
        : this.pending && progress !== null ? { label: progress.phase, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes } : null,
      error: this.error ?? tts.status.error }
  }

  async initialize(signal: AbortSignal): Promise<AssistantVoiceInitializationSnapshot> {
    if (this.pending) throw new Error('语音初始化正在进行，请等待完成')
    if (this.services.active()) throw new Error('请先停止实时语音，再进行初次配置')
    this.pending = true; this.error = null
    try {
      signal.throwIfAborted()
      this.phase = 'recognition'
      const current = await this.snapshot()
      // 自定义目录 ID 不应被中英双语默认值静默覆盖，保留高级模型管理的处理边界。
      if (!current.recognitionReady) {
        if (findAssistantVoiceModel(current.modelId) === undefined) throw new Error('当前为自定义识别模型，请在高级模型管理中验证配置')
        await this.services.prepareModel(current.modelId)
      }
      signal.throwIfAborted()
      this.phase = 'speech'
      const tts = await this.services.readTts()
      if (!tts.status.ready) await this.services.prepareTts()
      signal.throwIfAborted()
      const prepared = await this.services.readTts()
      if (prepared.settings.backend !== 'moss-onnx') await this.services.selectTts(prepared.settings.selectedId)
      signal.throwIfAborted()
      this.phase = 'completed'
    } catch (error) {
      this.phase = 'failed'; this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally { this.pending = false }
    return this.snapshot()
  }
}
