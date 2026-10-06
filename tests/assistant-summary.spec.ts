import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sanitizeSpeechText,
  summarizeAssistantEntries,
  summarizeAssistantSessions,
} from '../data/build/dist/host/features/assistant-summary.js'
import type { SessionIndexEntry } from '../data/build/dist/shared/contracts/assistant.js'

const scope = { status: 'ready' as const, managedWorkspaceIds: ['workspace-a'] }

function entry(overrides: Partial<SessionIndexEntry>): SessionIndexEntry {
  return {
    sessionId: overrides.sessionId ?? 'session-1',
    title: overrides.title ?? '默认会话',
    workspaceId: overrides.workspaceId ?? 'workspace-a',
    workspaceName: overrides.workspaceName ?? '项目 A',
    hostId: overrides.hostId ?? 'local',
    running: overrides.running ?? false,
    completed: overrides.completed ?? false,
    error: overrides.error,
    updatedAt: overrides.updatedAt ?? null,
    waiting: overrides.waiting ?? null,
    summary: overrides.summary,
  }
}

test('摘要按待处理、出错、运行中、已完成的优先级分组', () => {
  const summary = summarizeAssistantEntries([
    entry({ sessionId: 'done', title: '已完成', completed: true }),
    entry({ sessionId: 'run', title: '运行中', running: true }),
    entry({ sessionId: 'bad', title: '出错', error: true }),
    entry({ sessionId: 'wait', title: '审批', waiting: 'approval', running: true }),
  ], scope)

  assert.deepEqual(summary.groups.waiting.map((item) => item.sessionId), ['wait'])
  assert.deepEqual(summary.groups.error.map((item) => item.sessionId), ['bad'])
  assert.deepEqual(summary.groups.running.map((item) => item.sessionId), ['run'])
  assert.deepEqual(summary.groups.completed.map((item) => item.sessionId), ['done'])
  assert.ok(summary.speechText.indexOf('待处理') < summary.speechText.indexOf('出错'))
  assert.ok(summary.speechText.indexOf('出错') < summary.speechText.indexOf('运行中'))
  assert.ok(summary.speechText.indexOf('运行中') < summary.speechText.indexOf('已完成'))
})

test('每个空类别都有明确说明', () => {
  const speech = summarizeAssistantEntries([], scope).speechText
  assert.match(speech, /当前没有待处理项/u)
  assert.match(speech, /当前没有出错会话/u)
  assert.match(speech, /当前没有运行中的会话/u)
  assert.match(speech, /当前没有刚完成的会话/u)
})

test('空范围不会被误报成没有进展', () => {
  const summary = summarizeAssistantEntries([], {
    status: 'empty',
    reason: 'no-managed-workspaces',
    message: '尚未选择任何工作区',
  })
  assert.match(summary.speechText, /尚未选择任何工作区/u)
  assert.match(summary.speechText, /无法报告进展/u)
})

test('播报文本清理 Markdown、URL、代码和凭据形态', () => {
  const sanitized = sanitizeSpeechText('**进展** [详情](https://example.com) `npm test` ```secret``` token: abc123')
  assert.equal(sanitized, '进展 详情 已隐藏敏感字段')
})

test('等待状态优先于运行状态，且摘要不修改输入', () => {
  const input = [entry({ waiting: 'question', running: true, summary: '请确认方案' })]
  const before = structuredClone(input)
  const summary = summarizeAssistantEntries(input, scope)
  assert.equal(summary.groups.waiting.length, 1)
  assert.equal(summary.groups.running.length, 0)
  assert.deepEqual(input, before)
})

test('单会话摘要读取失败时，播报明确说明摘要可能不完整', () => {
  const summary = summarizeAssistantEntries([
    entry({ sessionId: 'run', running: true }),
  ], scope, 8, 2)

  assert.equal(summary.unreadableCount, 2)
  assert.match(summary.speechText, /有2个会话暂时无法读取/u)
  assert.match(summary.speechText, /以上摘要可能不完整/u)
})

test('播报长度受限时仍保留不可读会话提示', () => {
  const summary = summarizeAssistantSessions([
    entry({ sessionId: 'run', running: true }),
  ], { scope, maxChars: 24, unreadableCount: 1 })

  assert.equal(summary.unreadableCount, 1)
  assert.match(summary.speechText, /有1个会话暂时无法读取/u)
})

test('受限播报长度优先保留高优先级段落且不截断会话名称', () => {
  const entries = [
    entry({ title: '需要审批的长会话名称', waiting: 'approval' }),
    entry({ sessionId: 'error', title: '失败会话', error: true }),
    entry({ sessionId: 'done', title: '完成会话', completed: true }),
  ]
  const summary = summarizeAssistantEntries(entries, scope)
  const limited = summarizeAssistantSessions(entries, { scope, maxChars: 40 })
  assert.ok(summary.speechText.includes('需要审批的长会话名称'))
  assert.ok(limited.speechText.endsWith('。'))
  assert.ok(limited.speechText.startsWith('待处理：'))
})
