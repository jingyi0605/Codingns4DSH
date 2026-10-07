/** 两个阶段独立保存提示词；缺省或清空时使用面向语音的默认值。 */
export interface AssistantPromptSettings {
  readonly index: string
  readonly chat: string
}

export const ASSISTANT_PROMPT_MAX_CHARS = 8000

// 旧默认值会随设置持久化；只升级完整匹配的默认文本，保留用户自行编辑的提示词。
const LEGACY_DEFAULT_CHAT_PROMPTS = new Set([
  '请用简洁的中文口语回答，适合直接朗读。先直接回应用户的问题，通常用一到四个短句；用户明确要求细节时再适当展开。不要使用标题、编号、列表、表格、Markdown、排比或套话，不要机械复述整份索引。提到项目时使用容易理解的名称，优先说明当前进展、实际阻碍和需要用户处理的下一步。',
  '请用简短的中文口语回答，适合直接朗读。默认只说一到两个短句，总长度控制在100字以内，每句只表达一个重点。先给结论，再说最重要的处理动作；用户明确要求全部事项或细节时才展开。只回答当前问题，不复述背景、完整日志或附加建议。不要使用标题、编号、列表、表格、Markdown、排比或套话。项目多时优先说明最紧急的事项，用简短名称定位。',
])

export const DEFAULT_ASSISTANT_PROMPTS: AssistantPromptSettings = {
  index: '请按固定结构提取每个会话的目标、进展、阻碍、待办、下一步和信息缺口，供全局助理后续问答使用。每个字段用具体、简短的中文口语，不要排比、套话或复述整段日志。严格区分已有任务与新建议，所有事实和行动附来源证据；不确定时保留信息缺口，不虚构完成结果、负责人或截止时间。',
  chat: '请用自然、简短的中文口语交流，适合直接朗读。默认一到两个短句，总长度控制在100字以内，每句只表达一个重点；用户明确要求细节时再展开。陪伴聊天时温柔倾听、顺着话题回应，不急着给建议或处理动作；工作问题先给结论，再说最重要的下一步。不要复述背景、完整日志或附加建议，不用标题、编号、列表、表格、Markdown、排比或套话。项目多时先说最紧急的事项，用简短名称定位。',
}

export function readAssistantPrompts(value: Partial<AssistantPromptSettings> | undefined): AssistantPromptSettings {
  const chat = value?.chat?.trim()
  return {
    index: value?.index?.trim() || DEFAULT_ASSISTANT_PROMPTS.index,
    chat: !chat || LEGACY_DEFAULT_CHAT_PROMPTS.has(chat) ? DEFAULT_ASSISTANT_PROMPTS.chat : chat,
  }
}

/** 写入时验证类型与长度，避免通过旧设置提供器绕过原生 schema。 */
export function validateAssistantPrompt(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > ASSISTANT_PROMPT_MAX_CHARS) throw new Error('助理前置提示词必须是最多 8000 字符的文字')
}

export function validateAssistantPrompts(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('助理前置提示词设置无效')
  for (const [key, text] of Object.entries(value)) {
    if (key !== 'index' && key !== 'chat') throw new Error('未知的助理前置提示词字段')
    validateAssistantPrompt(text)
  }
}
