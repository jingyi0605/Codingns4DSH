import type { AssistantToolCall } from './contracts/assistant.js'

export type AssistantMessagePart =
  | { readonly kind: 'text'; readonly key: string; readonly text: string }
  | { readonly kind: 'tool'; readonly key: string; readonly call: AssistantToolCall }

export type AssistantMessageTimelinePart =
  | { readonly kind: 'text'; readonly key: string; readonly text: string }
  | { readonly kind: 'tool-step'; readonly key: string; readonly calls: readonly AssistantToolCall[] }

/** 按首次执行位置穿插工具，状态更新不会改变位置；不改写原始正文或播报内容。 */
export function assistantMessageTimeline(text: string, calls: readonly AssistantToolCall[] = []): readonly AssistantMessagePart[] {
  // 旧记录没有正文位置，放在所属回复前；不能从完成时间推断并伪造历史顺序。
  const position = (call: AssistantToolCall): number => Number.isSafeInteger(call.textOffset) && call.textOffset! >= 0
    ? Math.min(call.textOffset!, text.length) : 0
  const ordered = [...calls].sort((left, right) => position(left) - position(right))
  const parts: AssistantMessagePart[] = []
  let offset = 0
  let textKey = 'text-start'
  for (const call of ordered) {
    const next = position(call)
    if (next > offset) parts.push({ kind: 'text', key: textKey, text: text.slice(offset, next) })
    parts.push({ kind: 'tool', key: `tool-${call.id}`, call })
    offset = next; textKey = `text-after-${call.id}`
  }
  if (offset < text.length) parts.push({ kind: 'text', key: textKey, text: text.slice(offset) })
  return parts
}

/** 将同一正文位置连续发生的工具归入一个 DSH 风格 step；正文仍保持原有穿插位置。 */
export function assistantMessageStepTimeline(text: string, calls: readonly AssistantToolCall[] = []): readonly AssistantMessageTimelinePart[] {
  const parts = assistantMessageTimeline(text, calls)
  const grouped: AssistantMessageTimelinePart[] = []
  for (const part of parts) {
    if (part.kind === 'text') {
      grouped.push(part)
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.kind === 'tool-step') {
      grouped[grouped.length - 1] = { ...previous, calls: [...previous.calls, part.call] }
    } else {
      grouped.push({ kind: 'tool-step', key: `tool-step-${part.call.id}`, calls: [part.call] })
    }
  }
  return grouped
}
