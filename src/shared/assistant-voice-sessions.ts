import type { AssistantConversationSnapshot, AssistantConversationMessage, AssistantVoiceSession } from './contracts/assistant.js'

export function voiceSessionDuration(session: Pick<AssistantVoiceSession, 'startedAt' | 'endedAt'>, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(((session.endedAt ?? now) - session.startedAt) / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

/** 条数按有效发言计数，工具结果及空回复不计入语句。 */
export function voiceSessionMessageCount(session: AssistantVoiceSession): number { return session.messages.filter((message) => message.text.trim() !== '').length }

/** 对话上下文保持原样，展示时用一张卡片替代已归档通话的消息气泡。 */
export function assistantConversationTimeline(conversation: AssistantConversationSnapshot): readonly ({ kind: 'message'; message: AssistantConversationMessage } | { kind: 'voice'; session: AssistantVoiceSession })[] {
  const calls = (conversation.voiceSessions ?? []).filter((session) => session.endedAt !== null)
  const grouped = new Set(calls.map((session) => session.id))
  const messages = [...conversation.messages, ...(conversation.pendingMessage === null ? [] : [conversation.pendingMessage])]
    .filter((message) => message.voiceSessionId === undefined || !grouped.has(message.voiceSessionId))
  return [...messages.map((message) => ({ kind: 'message' as const, message })), ...calls.map((session) => ({ kind: 'voice' as const, session }))]
    .sort((a, b) => (a.kind === 'message' ? a.message.createdAt : a.session.startedAt) - (b.kind === 'message' ? b.message.createdAt : b.session.startedAt))
}
