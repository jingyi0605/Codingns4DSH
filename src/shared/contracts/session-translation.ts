/** 会话翻译中间件支持的语言。 */
export type SessionTranslationLanguage = 'en' | 'fr' | 'de' | 'ja' | 'zh'

/** 输出内容类别；工具调用、命令和路径不属于可翻译内容。 */
export type SessionTranslationOutputKind = 'reasoning' | 'assistant'

/** 翻译请求使用的 DSH 原生模型；不保存密钥，只保存 provider/model 标识。 */
export interface SessionTranslationModel {
  readonly provider: string
  readonly model: string
}

/** 会话翻译中间件的持久化设置。 */
export interface SessionTranslationSettings {
  /** 用户输入送入外部 Agent 的目的语言。 */
  readonly inputLanguage: Exclude<SessionTranslationLanguage, 'zh'>
  /** 输出翻译语言；默认中文。 */
  readonly outputLanguage: SessionTranslationLanguage
  /** 是否在 UI 和历史回看中同时保留原文与译文。 */
  readonly bilingual: boolean
  /** 翻译模型；缺省时跟随 DSH 当前默认模型。 */
  readonly translationModel?: SessionTranslationModel
}

export const SESSION_TRANSLATION_ADAPTER_IDS = [
  'claude-code', 'codex', 'pi', 'opencode', 'antigravity', 'grok', 'cursor-cli', 'kiro-cli',
] as const

export const DEFAULT_SESSION_TRANSLATION_SETTINGS: SessionTranslationSettings = {
  inputLanguage: 'en',
  outputLanguage: 'zh',
  bilingual: false,
}

/** 当前支持在会话模型选择器中开启翻译的外部 Agent。 */
export function isSessionTranslationAdapter(adapterId: string): boolean {
  return (SESSION_TRANSLATION_ADAPTER_IDS as readonly string[]).includes(adapterId)
}

export interface SessionTranslationRecord {
  readonly original: string
  readonly translated: string
  readonly sourceLanguage?: SessionTranslationLanguage
  readonly targetLanguage: SessionTranslationLanguage
  /** 回复文本所在的 DSH 内容块类型，供界面将原文入口放回对应内容块。 */
  readonly outputKind?: SessionTranslationOutputKind
  readonly bilingual: boolean
  /** 源语言与目标语言一致，因此未调用翻译模型。 */
  readonly alreadyTargetLanguage?: boolean
  /** 实际执行本次翻译的 DSH 原生模型；旧历史可能没有该字段。 */
  readonly model?: SessionTranslationModel
  /** 本次尝试失败并回退原文；前端显示警告状态。 */
  readonly failed?: boolean
}

/** 用户输入的原文、实际送出的译文和翻译模型，作为 DSH 历史元数据保存。 */
export interface SessionTranslationInputRecord {
  readonly original: string
  /** 包含附件提示等不翻译内容的最终 Provider prompt。 */
  readonly translated: string
  readonly sourceLanguage?: SessionTranslationLanguage
  readonly targetLanguage: Exclude<SessionTranslationLanguage, 'zh'>
  /** 源语言与目标语言一致，因此未调用翻译模型。 */
  readonly alreadyTargetLanguage?: boolean
  /** 实际执行本次翻译的 DSH 原生模型；旧历史可能没有该字段。 */
  readonly model?: SessionTranslationModel
  /** 翻译失败并回退原文；前端显示警告状态。 */
  readonly failed?: boolean
}

/** 外部 Agent 的历史上下文使用实际发送的译文；DSH 用户消息正文保留用户原文。 */
export function formatSessionTranslationInput(record: SessionTranslationInputRecord): string {
  return record.translated
}

/** DSH 的回复正文只保留译文；详情入口从元数据读取原文和模型。 */
export function formatSessionTranslationOutput(record: SessionTranslationRecord): string {
  return record.translated
}
