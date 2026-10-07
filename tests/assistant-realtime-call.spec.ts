import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantRealtimeCallView, AssistantVoiceSessionCard, AssistantVoiceSessionDetailsView } from '../src/client/features/assistant-realtime-call.js'
import { AssistantConversationView } from '../src/client/features/assistant-workbench.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { assistantConversationTimeline, voiceSessionDuration, voiceSessionMessageCount } from '../src/shared/assistant-voice-sessions.js'
import { BUILTIN_ASSISTANT_AVATAR, normalizeAssistantAppearance, selectedAssistantAvatar } from '../src/shared/assistant-avatar.js'
import type { AssistantConversationSnapshot, AssistantVoiceSession } from '../src/shared/contracts/assistant.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'

const t = resolveCodingNsTranslator()
const session: AssistantVoiceSession = { id: 'call', startedAt: 1000, endedAt: 126000, messages: [
  { id: 'user', role: 'user', source: 'voice', createdAt: 2000, voiceSessionId: 'call', text: '请检查项目并搜索资料' },
  { id: 'assistant', role: 'assistant', source: 'voice', createdAt: 2000, voiceSessionId: 'call', text: '工作区已检查，搜索未完成。', interrupted: true, toolCalls: [
    { id: 'project', name: 'assistant_list_workspaces', kind: 'workspace', state: 'completed', startedAt: 2000, finishedAt: 3000, arguments: '{}', result: '项目一' },
    { id: 'search', name: 'web_search', kind: 'web-search', state: 'failed', startedAt: 3000, finishedAt: 4000, arguments: '{"query":"公开资料"}', result: '<script>搜索服务不可用</script>' },
  ] },
] }
const conversation: AssistantConversationSnapshot = { revision: 1, summary: '', messages: [...session.messages,
  { id: 'text', role: 'user', source: 'text', createdAt: 127000, text: '文字继续' }], pendingMessage: null, active: null, compressing: false, error: null, voiceSessions: [session] }
const callProps = { t, name: '哆哆', pending: false, state: 'speaking', duration: '02:05', microphoneMuted: false, speakerMuted: false,
  userText: '检查 TypeScript 编译状态', assistantText: '正在检查当前工作区。', avatar: createElement('img', { src: '/avatar.png', alt: '当前助理形象' }), onMicrophone() {}, onSpeaker() {}, onHangup() {} }

test('长回复的全部句子留在字幕中，统一区域可滚动，不再裁成末尾两行', () => {
  const sentences = Array.from({ length: 12 }, (_, index) => `第${index + 1}句完整字幕。`)
  const markup = renderToStaticMarkup(createElement(AssistantRealtimeCallView, { ...callProps, assistantText: sentences.join('\n') }))
  for (const sentence of sentences) assert.ok(markup.includes(sentence))
  assert.ok(markup.includes('overflow-y:auto')); assert.ok(markup.includes('tabindex="0"'))
  assert.ok(!markup.includes('max-height:3.3em')); assert.ok(!markup.includes('scrollbar-width:none'))
})

test('通话界面显示形象、实时字幕和三项独立控制，静音状态与连接状态明确', () => {
  const markup = renderToStaticMarkup(createElement(AssistantRealtimeCallView, callProps))
  for (const text of ['data-codingns-realtime-call', '/avatar.png', '检查 TypeScript', '正在检查当前工作区', '02:05', 'aria-label="挂断"', 'aria-label="静音麦克风"', 'aria-expanded="false"']) assert.ok(markup.includes(text), text)
  assert.equal((markup.match(/<button/g) ?? []).length, 3)
  const muted = renderToStaticMarkup(createElement(AssistantRealtimeCallView, { ...callProps, microphoneMuted: true, speakerMuted: true }))
  assert.ok(muted.includes('aria-label="开启麦克风"')); assert.ok(!muted.includes('检查 TypeScript'))
  assert.equal((muted.match(/aria-pressed="true"/g) ?? []).length, 2)
  const pending = renderToStaticMarkup(createElement(AssistantRealtimeCallView, { ...callProps, pending: true }))
  assert.ok(pending.includes('正在连接')); assert.ok(pending.includes('disabled=""'))
})

test('聚合卡片替代已结束通话气泡，旧语音消息和后续文字仍显示', () => {
  const timeline = assistantConversationTimeline(conversation)
  assert.deepEqual(timeline.map((item) => item.kind), ['voice', 'message'])
  const services = {} as CodingNsClientServices
  const view = AssistantConversationView({ conversation, name: '哆哆', t, model: BUILTIN_ASSISTANT_AVATAR, services })
  const cardElement = (view.props as any).children.flat().find((child: any) => child?.type === AssistantVoiceSessionCard)
  assert.equal(cardElement.props.services, services); assert.equal(cardElement.props.model, BUILTIN_ASSISTANT_AVATAR)
  const markup = renderToStaticMarkup(createElement(AssistantConversationView, { conversation, name: '哆哆', t, model: BUILTIN_ASSISTANT_AVATAR, services: {} as CodingNsClientServices }))
  assert.equal((markup.match(/data-codingns-voice-session-card/g) ?? []).length, 1)
  assert.ok(!markup.includes('请检查项目并搜索资料')); assert.ok(markup.includes('文字继续'))
  assert.equal(assistantConversationTimeline({ ...conversation, voiceSessions: undefined }).length, 3)
  assert.equal(assistantConversationTimeline({ ...conversation, messages: [], voiceSessions: [{ ...session, endedAt: null }] }).length, 0)
})

test('卡片统计有效发言和真实时长，详情显示完整沟通、工具成功与失败且转义结果', () => {
  assert.equal(voiceSessionMessageCount(session), 2); assert.equal(voiceSessionDuration(session), '02:05')
  assert.equal(voiceSessionDuration({ startedAt: 1000, endedAt: null }, 500), '00:00')
  assert.equal(voiceSessionMessageCount({ ...session, messages: [...session.messages, { ...session.messages[1]!, id: 'tool-only', text: '' }] }), 2)
  const card = renderToStaticMarkup(createElement(AssistantVoiceSessionCard, { session, t, name: '哆哆' }))
  assert.ok(card.includes('2 条')); assert.ok(card.includes('02:05')); assert.ok(card.includes('aria-haspopup="dialog"'))
  const model = selectedAssistantAvatar(normalizeAssistantAppearance({ selectedId: 'codingns-basic-male' }))
  const details = renderToStaticMarkup(createElement(AssistantVoiceSessionDetailsView, { session, t, name: '哆哆', model, services: {} as CodingNsClientServices }))
  for (const text of ['请检查项目并搜索资料', '工作区能力', '联网搜索', 'assistant_list_workspaces', 'web_search', '失败', '已完成', '已打断', '公开资料', '&lt;script&gt;']) assert.ok(details.includes(text), text)
  assert.ok(!details.includes('<script>'))
  assert.ok(details.includes('data-codingns-assistant-message="user" data-codingns-message-side="right"'))
  assert.ok(details.includes('data-codingns-assistant-message="assistant" data-codingns-message-side="left"'))
  assert.equal((details.match(/data-codingns-avatar-portrait/g) ?? []).length, 1)
  assert.ok(details.includes('data-codingns-avatar-portrait="codingns-basic-male"'))
})
