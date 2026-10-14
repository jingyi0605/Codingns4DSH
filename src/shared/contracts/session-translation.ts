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
  /** 用户输入送入 Agent 的目的语言。 */
  readonly inputLanguage: SessionTranslationLanguage
  /** 输出翻译语言；默认中文。 */
  readonly outputLanguage: SessionTranslationLanguage
  /** 是否在 UI 和历史回看中同时保留原文与译文。 */
  readonly bilingual: boolean
  /** 翻译模型；缺省时跟随 DSH 当前默认模型。 */
  readonly translationModel?: SessionTranslationModel
  /**
   * DSH 原生会话是否参与翻译；缺省关闭。
   *
   * 原生会话的回复由 DSH 自己写入 `assistant/message`，开启输出翻译后正文会变成
   * 译文、原文只留在块元数据里，因此不能默认改变既有行为。
   */
  readonly nativeEnabled?: boolean
}

export const SESSION_TRANSLATION_ADAPTER_IDS = [
  'command-code', 'claude-code', 'kimi', 'gemini', 'pi', 'codex', 'opencode', 'grok',
  'mcode', 'zcode', 'codebuddy', 'workbuddy', 'cursor-cli', 'kiro-cli', 'qoder', 'qoder-cn',
  'antigravity', 'doubao',
] as const

/** DSH 内置 Agent 的适配器标识；它没有外部驱动，但同样支持会话翻译。 */
export const DSH_NATIVE_SESSION_ADAPTER_ID = 'dsh' as const

export const SESSION_TRANSLATION_LANGUAGES = ['en', 'fr', 'de', 'ja', 'zh'] as const

export const DEFAULT_SESSION_TRANSLATION_SETTINGS: SessionTranslationSettings = {
  inputLanguage: 'en',
  outputLanguage: 'zh',
  bilingual: false,
  nativeEnabled: false,
}

/**
 * 外部 Agent 适配器判定。
 *
 * 只表示「会话由插件的外部 CLI 驱动接管」，因此 DSH 原生 Agent 不在其中：该判定
 * 还被用来把外部 Agent 的虚拟 Provider 排除在翻译模型目录之外，混入 `dsh` 会污染
 * 这一语义。会话是否可翻译统一使用 {@link supportsSessionTranslation}。
 */
export function isSessionTranslationAdapter(adapterId: string): boolean {
  return (SESSION_TRANSLATION_ADAPTER_IDS as readonly string[]).includes(adapterId)
}

/** 外部 Agent 与 DSH 原生 Agent 都支持会话翻译。 */
export function supportsSessionTranslation(adapterId: string): boolean {
  return adapterId === DSH_NATIVE_SESSION_ADAPTER_ID || isSessionTranslationAdapter(adapterId)
}

/** 判断任意字符串是否为受支持的翻译语言。 */
export function isSessionTranslationLanguage(value: unknown): value is SessionTranslationLanguage {
  return typeof value === 'string' && (SESSION_TRANSLATION_LANGUAGES as readonly string[]).includes(value)
}

/**
 * 归一化翻译设置：旧设置快照可能缺少 `nativeEnabled`，非法语言回落到默认值。
 *
 * 与 `session-translation-service.ts` 的内部归一化保持同一语义，供客户端设置页在
 * 写入前补齐字段，避免旧快照把新字段写丢。
 */
export function normalizeSessionTranslationSettings(value: SessionTranslationSettings | undefined): SessionTranslationSettings {
  const fallback = DEFAULT_SESSION_TRANSLATION_SETTINGS
  if (value === undefined) return fallback
  const translationModel = normalizeTranslationModel(value.translationModel)
  return {
    inputLanguage: isSessionTranslationLanguage(value.inputLanguage) ? value.inputLanguage : fallback.inputLanguage,
    outputLanguage: isSessionTranslationLanguage(value.outputLanguage) ? value.outputLanguage : fallback.outputLanguage,
    bilingual: value.bilingual === true,
    nativeEnabled: value.nativeEnabled === true,
    ...(translationModel === undefined ? {} : { translationModel }),
  }
}

function normalizeTranslationModel(value: SessionTranslationModel | undefined): SessionTranslationModel | undefined {
  if (value === undefined || value === null || typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
  const provider = value.provider.trim()
  const model = value.model.trim()
  return provider === '' || model === '' ? undefined : { provider, model }
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
  readonly targetLanguage: SessionTranslationLanguage
  /** 源语言与目标语言一致，因此未调用翻译模型。 */
  readonly alreadyTargetLanguage?: boolean
  /** 实际执行本次翻译的 DSH 原生模型；旧历史可能没有该字段。 */
  readonly model?: SessionTranslationModel
  /** 翻译失败并回退原文；前端显示警告状态。 */
  readonly failed?: boolean
}

/**
 * 从 DSH 原生用户消息的 source 元数据读取输入翻译记录。
 *
 * 该字段由 `agent/pre-step` 写入并随 `user/message` 持久化；未知或不完整的历史
 * 结构一律返回 undefined，调用方按「没有翻译」处理。
 */
export function readNativeTranslationRecord(source: unknown): SessionTranslationInputRecord | undefined {
  const record = asRecord(source)
  const candidate = asRecord(record?.codingnsTranslationInput)
  if (candidate === null) return undefined
  if (typeof candidate.original !== 'string' || typeof candidate.translated !== 'string') return undefined
  if (candidate.original.trim() === '' || candidate.translated.trim() === '') return undefined
  const targetLanguage = isSessionTranslationLanguage(candidate.targetLanguage) ? candidate.targetLanguage : undefined
  if (targetLanguage === undefined) return undefined
  const model = normalizeTranslationModel(asRecord(candidate.model) as SessionTranslationModel | undefined)
  const sourceLanguage = isSessionTranslationLanguage(candidate.sourceLanguage) ? candidate.sourceLanguage : undefined
  return {
    original: candidate.original,
    translated: candidate.translated,
    targetLanguage,
    ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
    ...(candidate.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
    ...(candidate.failed === true ? { failed: true } : {}),
    ...(model === undefined ? {} : { model }),
  }
}

/** 输入记录转换为详情弹层使用的通用记录；`outputKind` 缺省表示输入方向。 */
export function toSessionTranslationRecord(
  record: SessionTranslationInputRecord,
  options: { readonly outputKind?: SessionTranslationOutputKind; readonly bilingual?: boolean } = {},
): SessionTranslationRecord {
  return {
    original: record.original,
    translated: record.translated,
    targetLanguage: record.targetLanguage,
    bilingual: options.bilingual === true,
    ...(options.outputKind === undefined ? {} : { outputKind: options.outputKind }),
    ...(record.sourceLanguage === undefined ? {} : { sourceLanguage: record.sourceLanguage }),
    ...(record.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
    ...(record.failed === true ? { failed: true } : {}),
    ...(record.model === undefined ? {} : { model: record.model }),
  }
}

function asRecord(value: unknown): Record<string, any> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null
}

/** 外部 Agent 的历史上下文使用实际发送的译文；DSH 用户消息正文保留用户原文。 */
export function formatSessionTranslationInput(record: SessionTranslationInputRecord): string {
  return record.translated
}

/** DSH 的回复正文只保留译文；详情入口从元数据读取原文和模型。 */
export function formatSessionTranslationOutput(record: SessionTranslationRecord): string {
  return record.translated
}
