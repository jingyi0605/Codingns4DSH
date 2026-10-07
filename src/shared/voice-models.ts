/**
 * 面向普通用户展示的实时语音模型目录。
 *
 * 目录只包含流式 ASR 所需的文件。VAD、TTS 以及离线识别模型不属于当前
 * 全局实时对话初始化流程，因此不能出现在用户的模型选择器中。
 */
export interface AssistantVoiceModelFile {
  readonly setting: 'asrEncoder' | 'asrDecoder' | 'asrJoiner' | 'asrTokens'
  readonly name: string
}

export interface AssistantVoiceModel {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly repository: string
  readonly files: readonly AssistantVoiceModelFile[]
}

export type AssistantVoiceModelPaths = Readonly<Record<AssistantVoiceModelFile['setting'], string>>

/** 文件存在、通过模型验证、被选为当前模型是三个独立事实。 */
export interface AssistantVoiceModelStatus {
  readonly modelId: string
  readonly state: 'missing' | 'partial' | 'downloaded'
  readonly current: boolean
  readonly totalBytes: number
  readonly files: readonly {
    readonly name: string
    readonly path: string
    readonly bytes: number
    readonly partialBytes: number
    readonly present: boolean
  }[]
  readonly validation: {
    readonly state: 'unchecked' | 'passed' | 'failed'
    readonly checkedAt: number | null
    readonly error: string | null
  }
}

export interface AssistantVoiceModelsSnapshot {
  readonly models: readonly AssistantVoiceModelStatus[]
  readonly currentModelId: string | null
  readonly runtimeRunning: boolean
  readonly runtimeReady: boolean
  readonly operation: { readonly modelId: string; readonly kind: 'setup' | 'verify' | 'repair' } | null
}

/** 下载量只属于当前文件；总大小未知时不能用文件数量伪造字节百分比。 */
export interface AssistantVoiceModelProgress {
  readonly modelId: string
  readonly phase: 'checking' | 'downloading' | 'verifying' | 'initializing' | 'completed'
  readonly fileName: string | null
  /** 当前文件的序号从 1 开始；尚未检查文件时为 0。 */
  readonly fileIndex: number
  readonly fileCount: number
  readonly downloadedBytes: number
  readonly totalBytes: number | null
}

const STREAMING_FILES: readonly AssistantVoiceModelFile[] = [
  { setting: 'asrEncoder', name: 'encoder-epoch-99-avg-1.int8.onnx' },
  { setting: 'asrDecoder', name: 'decoder-epoch-99-avg-1.int8.onnx' },
  { setting: 'asrJoiner', name: 'joiner-epoch-99-avg-1.int8.onnx' },
  { setting: 'asrTokens', name: 'tokens.txt' },
]

/** 编程交流默认识别中英混合语句；显式保存的模型选择继续保留。 */
export const DEFAULT_VOICE_MODEL_ID = 'sherpa-onnx-streaming-zh-en'

/** 只暴露支持实时输入的推荐模型；模型地址由 Host 根据此白名单解析。 */
export const ASSISTANT_VOICE_MODEL_CATALOG: readonly AssistantVoiceModel[] = [
  {
    id: DEFAULT_VOICE_MODEL_ID,
    label: '中英双语实时模型（默认）',
    description: '本地运行，约 200 MB，同时识别中文和英文，适合编程交流。',
    repository: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    files: STREAMING_FILES,
  },
  {
    id: 'sherpa-onnx-streaming-zh-large-2025-06-30',
    label: '中文 Zipformer Large（2025-06-30）',
    description: '本地中文实时识别，模型文件约 168 MB。',
    repository: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
    files: [
      { setting: 'asrEncoder', name: 'encoder.int8.onnx' },
      // Large 发布包的 decoder 是浮点模型，不能套用旧模型的 int8 文件名。
      { setting: 'asrDecoder', name: 'decoder.onnx' },
      { setting: 'asrJoiner', name: 'joiner.int8.onnx' },
      { setting: 'asrTokens', name: 'tokens.txt' },
    ],
  },
  {
    id: 'sherpa-onnx-streaming-zh-14m',
    label: '中文轻量实时模型（14M）',
    description: '本地运行，约 27 MB，适合中文语音对话。',
    repository: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    files: STREAMING_FILES,
  },
]

export function findAssistantVoiceModel(modelId: string): AssistantVoiceModel | undefined {
  return ASSISTANT_VOICE_MODEL_CATALOG.find((model) => model.id === modelId)
}
