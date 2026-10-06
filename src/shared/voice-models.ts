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

const STREAMING_FILES: readonly AssistantVoiceModelFile[] = [
  { setting: 'asrEncoder', name: 'encoder-epoch-99-avg-1.int8.onnx' },
  { setting: 'asrDecoder', name: 'decoder-epoch-99-avg-1.int8.onnx' },
  { setting: 'asrJoiner', name: 'joiner-epoch-99-avg-1.int8.onnx' },
  { setting: 'asrTokens', name: 'tokens.txt' },
]

/** 只暴露支持实时输入的推荐模型；模型地址由 Host 根据此白名单解析。 */
export const ASSISTANT_VOICE_MODEL_CATALOG: readonly AssistantVoiceModel[] = [
  {
    id: 'sherpa-onnx-streaming-zh-14m',
    label: '中文实时模型（推荐）',
    description: '本地运行，约 27 MB，适合中文语音对话。',
    repository: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    files: STREAMING_FILES,
  },
  {
    id: 'sherpa-onnx-streaming-zh-en',
    label: '中英双语实时模型',
    description: '本地运行，约 200 MB，同时识别中文和英文。',
    repository: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    files: STREAMING_FILES,
  },
]

export function findAssistantVoiceModel(modelId: string): AssistantVoiceModel | undefined {
  return ASSISTANT_VOICE_MODEL_CATALOG.find((model) => model.id === modelId)
}
