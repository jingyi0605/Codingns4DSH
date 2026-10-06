import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAssistantIntent, resolveAssistantTarget } from '../data/build/dist/host/features/assistant-intent.js'
import type { SessionIndexEntry } from '../data/build/dist/shared/contracts/assistant.js'
import { createAssistantScope } from '../data/build/dist/host/features/assistant-scope.js'

const entries: readonly SessionIndexEntry[] = [
  { sessionId: 's-a', title: '前端页面', workspaceId: 'w-a', workspaceName: '前端', hostId: 'local', running: true, completed: false, updatedAt: 30, waiting: null },
  { sessionId: 's-b', title: '后端接口', workspaceId: 'w-b', workspaceName: '后端', hostId: 'remote', running: false, completed: true, updatedAt: 20, waiting: null },
  { sessionId: 's-c', title: '测试修复', workspaceId: 'w-a', workspaceName: '前端', hostId: 'local', running: false, completed: false, updatedAt: 40, waiting: 'question' },
]

test('识别汇总和闲聊意图', () => {
  assert.equal(parseAssistantIntent('现在进展怎么样', entries).kind, 'summary')
  assert.equal(parseAssistantIntent('你好', entries).kind, 'chat')
})

test('精确标题匹配并携带完整目标引用', () => {
  const intent = parseAssistantIntent('让后端接口去运行测试', entries, { indexGeneration: 7 })
  assert.equal(intent.kind, 'dispatch')
  assert.equal(intent.mode, 'queue')
  assert.deepEqual(intent.target, { sessionId: 's-b', workspaceId: 'w-b', hostId: 'remote', indexGeneration: 7 })
  assert.equal(intent.task, '测试')
})

test('明确立即改变方向时使用 steer', () => {
  const intent = parseAssistantIntent('让前端页面立即去修复按钮', entries)
  assert.equal(intent.kind, 'dispatch')
  assert.equal(intent.mode, 'steer')
})

test('多个包含候选必须澄清而不是猜测', () => {
  const duplicated = [entries[0], { ...entries[0], sessionId: 's-a2', title: '前端页面副本' }]
  const result = resolveAssistantTarget('前端', duplicated)
  assert.equal(result.status, 'clarify')
})

test('工作区加序数可以定位目标', () => {
  const result = resolveAssistantTarget('前端第1个会话', entries, { indexGeneration: 3 })
  assert.equal(result.status, 'matched')
  if (result.status === 'matched') assert.equal(result.target.sessionId, 's-a')
})

test('范围外和已归档目标返回结构化拒绝', () => {
  const scope = createAssistantScope(['w-a'])
  const outside = parseAssistantIntent('让后端接口去运行测试', entries, { scope, archivedSessionIds: [] })
  assert.equal(outside.kind, 'clarify')
  assert.equal(outside.rejection?.code, 'workspace-outside-scope')

  const archived = parseAssistantIntent('让前端页面去运行测试', entries, { scope, archivedSessionIds: ['s-a'] })
  assert.equal(archived.kind, 'clarify')
  assert.equal(archived.rejection?.code, 'session-archived')
})

test('索引排除的范围外或归档目标仍能给出明确拒绝原因', () => {
  const excluded = [
    { sessionId: 's-x', title: '隐藏会话', workspaceId: 'w-x', workspaceName: '未管理工作区', hostId: 'remote', archived: false },
    { sessionId: 's-y', title: '归档会话', workspaceId: 'w-a', workspaceName: '前端', hostId: 'local', archived: true },
  ]
  const outside = parseAssistantIntent('让隐藏会话去运行测试', entries, { excludedTargets: excluded })
  assert.equal(outside.rejection?.code, 'workspace-outside-scope')
  const archived = parseAssistantIntent('让归档会话去运行测试', entries, { excludedTargets: excluded })
  assert.equal(archived.rejection?.code, 'session-archived')
})
