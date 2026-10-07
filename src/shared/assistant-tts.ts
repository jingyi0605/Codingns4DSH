/** 官方 ONNX 清单版本固定，展示元数据与推理 ID 共用同一份目录。 */
export type AssistantVoiceGender = 'male' | 'female' | 'unknown'
export interface AssistantTtsVoice {
  readonly id: string
  readonly name: string
  readonly language: string
  readonly gender: AssistantVoiceGender
  readonly kind: 'builtin' | 'reference'
  /** 内置为官方 voice ID；导入为 Host 生成的缓存键，绝不接受本地路径。 */
  readonly reference: string
  readonly source: string
  readonly license: string
}
export interface AssistantTtsSettings {
  readonly backend: 'browser' | 'moss-onnx'
  readonly selectedId: string
  readonly voices: readonly AssistantTtsVoice[]
  /** 老配置可以缺省，读取时统一补齐，音色切换不改变播报参数。 */
  readonly parameters?: AssistantTtsParameters
}
export interface AssistantTtsParameters {
  readonly rate: number
  readonly volume: number
  readonly segmentPauseMs: number
  readonly chunkTokens: number
  /** null 为自动随机；固定种子用于比较同一段文本的生成效果。 */
  readonly seed: number | null
}
export const DEFAULT_ASSISTANT_TTS_PARAMETERS: AssistantTtsParameters = Object.freeze({ rate: 1, volume: 1, segmentPauseMs: 0, chunkTokens: 75, seed: null })
export const ASSISTANT_TTS_PARAMETER_LIMITS = {
  rate: { min: 0.5, max: 2, step: 0.05 },
  volume: { min: 0, max: 1, step: 0.01 },
  segmentPauseMs: { min: 0, max: 2000, step: 50 },
  chunkTokens: { min: 30, max: 120, step: 1 },
  seed: { min: 0, max: 4294967295, step: 1 },
} as const

/** 已保存的旧值或损坏值用默认值恢复；写入及试听请求使用严格校验。 */
export function readAssistantTtsParameters(value?: Partial<AssistantTtsParameters>): AssistantTtsParameters {
  const result = { ...DEFAULT_ASSISTANT_TTS_PARAMETERS }
  for (const key of ['rate', 'volume', 'segmentPauseMs', 'chunkTokens', 'seed'] as const) {
    const item = value?.[key]
    if (validParameter(key, item)) Object.assign(result, { [key]: item })
  }
  return result
}

export function validateAssistantTtsParameters(value: unknown, base?: Partial<AssistantTtsParameters>): AssistantTtsParameters {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('播报参数必须为对象')
  const result = readAssistantTtsParameters(base)
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(ASSISTANT_TTS_PARAMETER_LIMITS, key)) throw new Error(`不支持的播报参数：${key}`)
    const name = key as keyof AssistantTtsParameters
    if (!validParameter(name, item)) {
      const limit = ASSISTANT_TTS_PARAMETER_LIMITS[name]
      throw new Error(`播报参数 ${key} 需要 ${limit.min}～${limit.max}${name === 'seed' ? ' 的整数或 null' : name === 'chunkTokens' || name === 'segmentPauseMs' ? ' 的整数' : ''}`)
    }
    Object.assign(result, { [key]: item })
  }
  return result
}

function validParameter(key: keyof AssistantTtsParameters, value: unknown): boolean {
  if (key === 'seed' && value === null) return true
  const limit = ASSISTANT_TTS_PARAMETER_LIMITS[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= limit.min && value <= limit.max
    && (key === 'rate' || key === 'volume' || Number.isInteger(value))
}

export const DEFAULT_ASSISTANT_TTS_SETTINGS: AssistantTtsSettings = { backend: 'browser', selectedId: 'moss:Junhao', voices: [], parameters: DEFAULT_ASSISTANT_TTS_PARAMETERS }
export const MOSS_TTS_REVISION = 'f52645cb467506d8e18e746ddd59482685b74e58'
export const MOSS_CODEC_REVISION = 'ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae'
export const MOSS_SOURCE_REVISION = '8b7bcc9341b3b4ef3a3a58ba1338a7d85ff133eb'
export const MOSS_BUILTIN_VOICES: readonly AssistantTtsVoice[] = [
  { id: 'moss:Junhao', name: 'Junhao · 欢迎关注模思智能', language: 'zh', gender: 'male', kind: 'builtin', reference: 'Junhao', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Zhiming', name: 'Zhiming · 京味胡同闲聊', language: 'zh', gender: 'male', kind: 'builtin', reference: 'Zhiming', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Weiguo', name: 'Weiguo · 说书', language: 'zh', gender: 'male', kind: 'builtin', reference: 'Weiguo', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Xiaoyu', name: 'Xiaoyu · 明星', language: 'zh', gender: 'female', kind: 'builtin', reference: 'Xiaoyu', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Yuewen', name: 'Yuewen · 机车', language: 'zh', gender: 'female', kind: 'builtin', reference: 'Yuewen', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Lingyu', name: 'Lingyu · 深夜电台', language: 'zh', gender: 'female', kind: 'builtin', reference: 'Lingyu', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Trump', name: 'Trump · Trump', language: 'en', gender: 'male', kind: 'builtin', reference: 'Trump', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Ava', name: 'Ava · The Bitter Lesson', language: 'en', gender: 'female', kind: 'builtin', reference: 'Ava', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Bella', name: 'Bella · A Gentle Reminder', language: 'en', gender: 'female', kind: 'builtin', reference: 'Bella', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Adam', name: 'Adam · English News', language: 'en', gender: 'male', kind: 'builtin', reference: 'Adam', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Nathan', name: 'Nathan · The Quiet Motion of the World', language: 'en', gender: 'male', kind: 'builtin', reference: 'Nathan', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Soyo', name: 'Soyo · Soyo', language: 'ja', gender: 'female', kind: 'builtin', reference: 'Soyo', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Saki', name: 'Saki · Saki', language: 'ja', gender: 'female', kind: 'builtin', reference: 'Saki', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Mortis', name: 'Mortis · Mortis', language: 'ja', gender: 'female', kind: 'builtin', reference: 'Mortis', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Umiri', name: 'Umiri · Umiri', language: 'ja', gender: 'female', kind: 'builtin', reference: 'Umiri', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Mei', name: 'Mei · Togawa', language: 'ja', gender: 'female', kind: 'builtin', reference: 'Mei', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Anon', name: 'Anon · Anon', language: 'ja', gender: 'female', kind: 'builtin', reference: 'Anon', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
  { id: 'moss:Arisa', name: 'Arisa · Arisa', language: 'ja', gender: 'female', kind: 'builtin', reference: 'Arisa', source: 'https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX/blob/f52645cb467506d8e18e746ddd59482685b74e58/browser_poc_manifest.json', license: 'Apache-2.0（项目许可；参考声音授权另行确认）' },
]
export const ASSISTANT_TTS_PATH = '/api/codingns/assistant/voice/tts'
export const ASSISTANT_VOICE_SAMPLE_PATH = '/api/codingns/assistant/voice/sample'
export const ASSISTANT_VOICE_SITES = [
  { id: 'kyutai', name: 'Kyutai 开放音色', url: 'https://kyutai.org/tts/', help: '试听后填写 kyutai:voice-donations/0a67.wav 等录音 ID，或 Hugging Face 音频文件网址。' },
  { id: 'aishell', name: 'AISHELL-3 中文录音', url: 'https://huggingface.co/datasets/AISHELL/AISHELL-3', help: '填写 aishell:完整录音ID，或 Hugging Face 中单个音频文件的网址。' },
] as const
export interface AssistantTtsStatus {
  readonly ready: boolean
  readonly busy: boolean
  readonly phase: string
  readonly downloadedBytes: number
  readonly totalBytes: number | null
  readonly error: string | null
}
export interface AssistantTtsSnapshot {
  readonly settings: AssistantTtsSettings
  readonly voices: readonly AssistantTtsVoice[]
  readonly status: AssistantTtsStatus
}
/** 旧设置只补默认值，内置音色始终由目录提供，不能被自定义记录覆盖。 */
export function readAssistantTtsSettings(value?: AssistantTtsSettings): AssistantTtsSettings {
  const voices = (value?.voices ?? []).filter((voice) => voice.kind === 'reference' && /^ref-[a-f0-9]{64}$/u.test(voice.id) && voice.reference === voice.id)
  const selectedId = value?.selectedId ?? DEFAULT_ASSISTANT_TTS_SETTINGS.selectedId
  return { backend: value?.backend === 'moss-onnx' ? 'moss-onnx' : 'browser',
    selectedId: [...MOSS_BUILTIN_VOICES, ...voices].some((voice) => voice.id === selectedId) ? selectedId : DEFAULT_ASSISTANT_TTS_SETTINGS.selectedId, voices,
    parameters: readAssistantTtsParameters(value?.parameters) }
}
