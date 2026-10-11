import type { AssistantSessionMessage } from './contracts/assistant.js'

const MAX_MESSAGES = 24
const MAX_TEXT = 6_000
const MAX_TOTAL_TEXT = 24_000

export interface AssistantSessionMessageReadOptions {
  readonly toolCallId?: string
}

/**
 * 把 DSH surface/session-follow 返回的有界语义记录转换成助理可读消息。
 * 这里只接受用户、助理和工具记录，不把 reasoning 或运行时上下文当正文。
 */
export function readAssistantSessionMessages(records: readonly unknown[], options: AssistantSessionMessageReadOptions = {}): readonly AssistantSessionMessage[] {
  const messages: AssistantSessionMessage[] = []
  for (const raw of records.slice(-256)) {
    const wrapper = asRecord(raw)
    const event = asRecord(wrapper?.event) ?? wrapper
    if (event === null) continue
    const data = asRecord(event.data)
    const nested = asRecord(data?.message) ?? asRecord(event.message)
    const value = nested ?? data ?? event
    const type = text(event.type) ?? text(event.kind) ?? text(event.event) ?? ''
    const role = text(event.role) ?? text(data?.role) ?? text(nested?.role)
    const source = asRecord(value.source) ?? asRecord(data?.source)
    const seq = integer(event.seq)
    const turn = integer(data?.turn) ?? integer(event.turn)
    const step = integer(data?.step) ?? integer(event.step)
    const position = { ...(seq === undefined ? {} : { seq }), ...(turn === undefined ? {} : { turn }), ...(step === undefined ? {} : { step }) }

    if (isUser(type, role)) {
      // v4 会把时间、压缩提示和插件上下文也写成 user/message。
      if (source !== null && source.kind !== undefined && source.kind !== 'user') continue
      const content = readText(value)
      // 用户消息只用于定位当前回合，默认不提供给全局助理。
      continue
    }
    if (isAssistant(type, role) || isAssistantChunk(type) || type === 'assistant/attempt') {
      const content = type === 'assistant/attempt' ? readAssistantAttemptText(data) : readText(value)
      if (content === null) continue
      const previous = messages.at(-1)
      if (isAssistantChunk(type) && previous?.role === 'assistant' && samePosition(previous, position)) {
        messages[messages.length - 1] = { ...previous, text: `${previous.text}${content}`.slice(-MAX_TEXT) }
      } else {
        messages.push({ role: 'assistant', text: content, ...position })
      }
      continue
    }
    if (isTool(type, role)) {
      const toolName = text(event.name) ?? text(event.tool) ?? text(event.toolName) ?? text(data?.name) ?? text(data?.tool) ?? text(data?.toolName) ?? null
      const callId = text(data?.callId) ?? text(data?.toolCallId) ?? text(event.callId) ?? null
      if (toolName === null && callId === null) continue
      const result = readText(value)
      const failed = event.isError === true || data?.isError === true || type.includes('result') && (event.error !== undefined || data?.error !== undefined)
      const state = type.includes('result') || type.includes('complete') || type.includes('end') ? failed ? 'failed' : 'completed' : 'running'
      const previous = callId === null ? undefined : [...messages].reverse().find((item) => item.role === 'tool' && item.callId === callId)
      if (previous !== undefined && callId !== null) {
        const index = messages.lastIndexOf(previous)
        messages[index] = { ...previous, ...(toolName === null ? {} : { toolName }), state, ...position, ...(result !== null && options.toolCallId === callId ? { result: result.slice(0, MAX_TEXT) } : {}) }
      } else {
        messages.push({ role: 'tool', text: '', ...(toolName === null ? {} : { toolName }), ...(callId === null ? {} : { callId }), state, ...position, ...(result !== null && callId !== null && options.toolCallId === callId ? { result: result.slice(0, MAX_TEXT) } : {}) })
      }
    }
  }
  let total = 0
  return messages.slice(-MAX_MESSAGES).flatMap((message) => {
    const textValue = message.text.slice(0, MAX_TEXT)
    if (textValue === '' && message.role !== 'tool') return []
    const available = Math.max(0, MAX_TOTAL_TEXT - total)
    if (available === 0) return []
    const bounded = textValue.slice(0, available)
    total += bounded.length
    return [{ ...message, text: bounded }]
  })
}

export function assistantSessionMessagesSummary(messages: readonly AssistantSessionMessage[]): string | null {
  const parts = messages.flatMap((message) => {
    if (message.role === 'tool') return message.toolName === undefined ? [] : [`工具：${message.toolName}`]
    return [`助理：${message.text}`]
  })
  return parts.length === 0 ? null : parts.slice(-3).join('；').slice(0, 2_000)
}

/** 将 follow opening 中尚未落盘的当前助理输出追加到消息尾部。 */
export function appendAssistantSessionStream(messages: readonly AssistantSessionMessage[], value: unknown): readonly AssistantSessionMessage[] {
  const attempt = asRecord(asRecord(value)?.activeAttempt)
  if (attempt === null || !Array.isArray(attempt.stream)) return messages
  const textValue = attempt.stream.flatMap((raw: unknown) => {
    const record = asRecord(raw)
    const chunk = asRecord(record?.chunk) ?? record
    if (chunk === null) return []
    const type = text(chunk.type)
    if (type !== 'text-delta' && type !== 'text' && type !== 'block-end') return []
    const block = asRecord(chunk.block)
    const content = text(chunk.text) ?? text(block?.text)
    return content === undefined ? [] : [content]
  }).join('')
  const used = messages.reduce((total, message) => total + message.text.length, 0)
  const bounded = textValue.slice(0, Math.min(MAX_TEXT, Math.max(0, MAX_TOTAL_TEXT - used)))
  if (bounded === '') return messages
  const turn = integer(attempt.turn)
  const step = integer(attempt.step)
  return [...messages, {
    role: 'assistant', text: bounded,
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
  }]
}

function isUser(type: string, role: string | undefined): boolean { return type === 'user/message' || type === 'user.message' || type === 'message/user' || role === 'user' }
function isAssistant(type: string, role: string | undefined): boolean { return type === 'assistant/message' || type === 'assistant.message' || type === 'message/assistant' || role === 'assistant' }
function isAssistantChunk(type: string): boolean { return type === 'assistant/chunk' || type === 'assistant/live-chunk' || type === 'assistant.message.delta' || type === 'message/assistant/delta' }
function isTool(type: string, role: string | undefined): boolean { return type === 'tool/call' || type === 'tool.call' || type === 'tool-call' || type === 'tool/result' || type === 'tool.result' || type === 'tool-result' || role === 'tool' }
function samePosition(left: AssistantSessionMessage, right: Partial<Pick<AssistantSessionMessage, 'turn' | 'step'>>): boolean {
  return left.turn !== undefined && right.turn !== undefined && left.turn === right.turn && left.step !== undefined && right.step !== undefined && left.step === right.step
}
function readText(value: Record<string, unknown>): string | null {
  for (const key of ['text', 'message', 'content', 'summary', 'transcript']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (Array.isArray(candidate)) {
      const textValue = candidate.map((item) => {
        if (typeof item === 'string') return item
        const part = asRecord(item)
        return part === null || part.type !== undefined && part.type !== 'text' ? '' : text(part.text) ?? text(part.content) ?? text(part.value) ?? ''
      }).join(' ').trim()
      if (textValue !== '') return textValue
    }
  }
  return null
}
function readAssistantAttemptText(value: Record<string, unknown> | null): string | null {
  if (value === null || !Array.isArray(value.stream)) return null
  const chunks = value.stream.flatMap((item: unknown) => {
    const record = asRecord(item)
    const chunk = asRecord(record?.chunk) ?? record
    if (chunk === null || chunk.type !== 'text-delta' && chunk.type !== 'text' && chunk.type !== 'block-end') return []
    const textValue = text(chunk.text) ?? text(asRecord(chunk.block)?.text)
    return textValue === undefined ? [] : [textValue]
  })
  return chunks.length === 0 ? null : chunks.join('')
}
function asRecord(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined }
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }
