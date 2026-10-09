/** 与当前 DSH 默认接纳上限一致，避免模型生成后再次被宿主按字节切断。 */
export const SESSION_TITLE_MAX_BYTES = 80
export const SESSION_TITLE_MAX_CJK_CHARACTERS = 24
const encoder = new TextEncoder()
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** 长度是上限而不是凑字数要求；完整动作、对象和关键版本优先。 */
export const SESSION_TITLE_SYSTEM_PROMPT = [
  '根据提供的用户消息，为编程助理会话概括一个完整、简短、自然的主题标题。',
  '使用用户消息的语言，只返回一行纯文本标题，不返回解释、引号、Markdown 或代码。',
  '保留核心动作、对象和必要的技术名称、版本号；不要添加消息里没有的事实。',
  '去掉“请帮我”“目前”“为什么”等开场语，不复制原文开头，不在半句话或术语中间截断。',
  '中文通常为 12～24 字，简单主题可以更短；英文通常为 5～10 个词，最多 64 个字符。',
  '标题的 UTF-8 编码最多 80 字节，中英混排也遵守此上限；较长时重新概括，不用省略号代替概括。',
].join('\n')

/** 仅清理模型输出的外层包装；多行解释留给校验拒绝，不拼接成标题。 */
export function normalizeGeneratedSessionTitle(value: string): string {
  return value.trim().replace(/^(?:标题|Title)\s*[:：]\s*/iu, '')
    .replace(/^(?:"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|`([^`\n]+)`)$/u, '$1$2$3$4').trim()
}

/** 同时检查可读长度与宿主字节预算，防止版本号、中文和 emoji 被硬切。 */
export function isCompleteSessionTitle(value: string): boolean {
  if (!value || /[\r\n\u0000-\u001f\u007f-\u009f]/u.test(value) || /(?:[，,:：;；、]|…|\.{3})$/u.test(value)) return false
  const characters = [...value]
  const cjk = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0
  return characters.length <= 64 && cjk <= SESSION_TITLE_MAX_CJK_CHARACTERS
    && (cjk > 0 || value.split(/\s+/u).length <= 10) && encoder.encode(value).length <= SESSION_TITLE_MAX_BYTES
}

/** 失败时优先保留完整的首句/短语；无断句边界时明确标注省略，而不是伪装成完整标题。 */
export function fallbackOptimizedSessionTitle(input: string): string {
  const text = input.replace(/(?:\u001b\]|\u009d)(?:(?!\u0007|\u001b\\)[\s\S])*(?:\u0007|\u001b\\|$)/gu, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu, '')
    .replace(/\s+/gu, ' ').trim()
  if (!text) return ''
  if (isCompleteSessionTitle(text)) return text
  const clauses = text.match(/[^。！？!?，,；;：:]+[。！？!?，,；;：:]?/gu) ?? []
  let complete = ''
  let prefix = ''
  for (const clause of clauses) {
    prefix += clause
    const candidate = prefix.replace(/[。！？!?，,；;：:]$/u, '').trim()
    if (!isCompleteSessionTitle(candidate)) break
    // 最后一个片段没有标点时不是可信的断句边界。
    if (/[。！？!?，,；;：:]$/u.test(prefix)) complete = candidate
  }
  if (complete) return complete
  let bounded = ''
  for (const { segment: character } of graphemes.segment(text)) {
    if (!isCompleteSessionTitle(`${bounded}${character}x`) || encoder.encode(`${bounded}${character}…`).length > SESSION_TITLE_MAX_BYTES) break
    bounded += character
  }
  // 英文或技术名称优先退回词边界；中文没有可靠分词时保留尽可能多的信息并显示省略。
  const wordBoundary = bounded.lastIndexOf(' ')
  if (wordBoundary > bounded.length / 2) bounded = bounded.slice(0, wordBoundary)
  return `${bounded.replace(/[\s，,；;：:、]+$/u, '')}…`
}
