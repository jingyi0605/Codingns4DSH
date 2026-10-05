/**
 * 从 Provider 的混合内容中提取明确标记为思考的文本。
 *
 * Provider 的字段并不统一：有的使用 thinking/reasoning 字段，有的把
 * 内容块类型写成 thinking/reasoning。只有这些明确标记才允许进入思考通道，
 * 避免把普通 message/content 字符串误判成思考内容。
 */
export function reasoningText(value: unknown): string | null {
  return collectReasoning(value, true)
}

/** 从混合内容中提取正文，跳过 thinking/reasoning 内容块。 */
export function textContent(value: unknown): string | null {
  return collectText(value)
}

function collectReasoning(value: unknown, allowPlainText: boolean): string | null {
  if (typeof value === 'string') return allowPlainText && value !== '' ? value : null
  if (Array.isArray(value)) return joinParts(value.map((item) => collectReasoning(item, false)))
  if (!isRecord(value)) return null

  const type = typeof value.type === 'string' ? value.type.toLowerCase() : ''
  if (isReasoningType(type)) {
    return firstParts(value.thinking, value.reasoning, value.text, value.content, value.delta)
  }

  const explicit = firstParts(value.reasoning, value.thinking, value.think, value.thought, value.reasoning_content, value.thinking_content)
  if (explicit !== null) return explicit

  // 只递归对象/数组容器；普通 content/message 字符串是正文，不能被误判。
  return firstParts(
    isContainer(value.content) ? collectReasoning(value.content, false) : null,
    isContainer(value.message) ? collectReasoning(value.message, false) : null,
    isContainer(value.delta) ? collectReasoning(value.delta, false) : null,
  )
}

function collectText(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (Array.isArray(value)) return joinParts(value.map((item) => collectText(item)))
  if (!isRecord(value)) return null
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : ''
  if (isReasoningType(type)) return null
  return firstTextParts(value.text, value.delta, value.content, value.message)
}

function firstParts(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const text = typeof value === 'string'
      ? value
      : isRecord(value) && typeof value.text === 'string'
        ? value.text
        : isContainer(value)
          ? collectReasoning(value, true)
          : null
    if (text !== null && text !== '') return text
  }
  return null
}

function firstTextParts(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const text = typeof value === 'string' ? value : isContainer(value) ? collectText(value) : null
    if (text !== null && text !== '') return text
  }
  return null
}

function joinParts(values: readonly (string | null)[]): string | null {
  const text = values.filter((value): value is string => value !== null && value !== '').join('')
  return text === '' ? null : text
}

function isReasoningType(type: string): boolean {
  return type.includes('think') || type.includes('reason')
}

function isContainer(value: unknown): value is Record<string, unknown> | readonly unknown[] {
  return Array.isArray(value) || isRecord(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
