import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAssistantStructuredIndex, speakAssistantStructuredIndex } from '../data/build/dist/host/features/assistant-structured-index.js'
import { createAssistantChatSystem, createAssistantIndexSystem } from '../data/build/dist/host/features/assistant-prompts.js'
import type { AssistantIndexSnapshot } from '../data/build/dist/shared/contracts/assistant.js'

const index: AssistantIndexSnapshot = {
  generation: 9, scope: { status: 'ready', managedWorkspaceIds: ['test'] }, unreadableCount: 0,
  entries: [
    { hostId: 'host', sessionId: 'permission', workspaceId: 'test', workspaceName: 'TEST', title: '提问测试', status: 'unknown', running: false, completed: false, updatedAt: 100, waiting: null, summary: '用户：测试提问并判分；助理：两次调用都返回权限错误；用户：请检查权限配置。token: secret-value' },
    { hostId: 'peer', sessionId: 'permission', workspaceId: 'test', workspaceName: 'TEST', title: '日志验证', status: 'waiting', running: false, completed: false, updatedAt: 200, waiting: 'question', summary: '助理：只看到目录列表，缺少权限触发记录。' },
  ],
}
const fact = (text: string, quote: string) => ({ text, evidence: [{ source: 'summary', quote }] })
const response = () => ({ schemaVersion: 1, sessions: [
  {
    hostId: 'host', sessionId: 'permission', objective: fact('测试提问并验证回答', '测试提问并判分'),
    progress: [fact('会话助理报告两次调用均返回权限错误', '两次调用都返回权限错误')],
    blockers: [fact('提问调用遇到权限错误', '权限错误')], pendingTasks: [],
    nextActions: [{ action: '检查提问组件的权限配置', kind: 'recorded', priority: 'high', reason: '先排除调用失败原因再测试判分', evidence: [{ source: 'summary', quote: '请检查权限配置' }] }],
    openQuestions: ['权限配置修改后，提问和判分是否通过？'],
  },
  {
    hostId: 'peer', sessionId: 'permission', objective: null, progress: [fact('会话助理仅看到了目录列表', '只看到目录列表')],
    blockers: [], pendingTasks: [], nextActions: [{ action: '补充权限触发与透传结果的记录', kind: 'suggested', priority: 'normal', reason: '当前缺少验证材料', evidence: [{ source: 'summary', quote: '缺少权限触发记录' }] }],
    openQuestions: ['这次验证要覆盖哪些权限行为？'],
  },
] })

test('按 Host 真实会话建立逐项有证据的索引，同 ID 不同 Host 不串会话，未知运行状态仍可记录历史进展', () => {
  const raw = response()
  raw.sessions.reverse()
  const result = parseAssistantStructuredIndex(JSON.stringify(raw), index)
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.generation, 9)
  assert.equal(result.sessions[0]?.sourceStatus, 'unknown')
  assert.equal(result.sessions[0]?.updatedAt, 100)
  assert.equal(result.sessions[0]?.workspaceName, 'TEST')
  assert.equal(result.sessions[0]?.progress[0]?.text, '会话助理报告两次调用均返回权限错误')
  assert.equal(result.sessions[1]?.sourceStatus, 'waiting')
  assert.equal(result.sessions[1]?.nextActions[0]?.kind, 'suggested')
  const speech = speakAssistantStructuredIndex(result)
  assert.ok(speech.includes('建议补充权限触发'))
  assert.ok(!speech.includes('schemaVersion'))
  const analysis = { requestId: 'r', provider: 'api', model: 'm', generation: 9, state: 'completed' as const, text: '过时的普通段落', error: null, startedAt: 1, finishedAt: 2, result }
  const system = createAssistantChatSystem({ ...index, analysis })
  assert.ok(system.includes('"nextActions"'))
  assert.ok(system.includes('hostId/sessionId'))
  assert.ok(!system.includes(analysis.text))
  assert.ok(!system.includes('secret-value'))
})

test('拒绝普通播报、半截 JSON、围栏、漏会话、重复、越界、额外字段与改写的证据，不把无效结果当作索引', () => {
  for (const text of ['目前有两个会话，建议检查权限配置。', '{"schemaVersion":1', '```json\n{}\n```']) assert.throws(() => parseAssistantStructuredIndex(text, index), /格式校验失败/u)
  const invalid: { name: string; edit: (raw: any) => void }[] = [
    { name: '遗漏', edit: (raw) => { raw.sessions.pop() } },
    { name: '重复', edit: (raw) => { raw.sessions[1] = raw.sessions[0] } },
    { name: '越界', edit: (raw) => { raw.sessions[0].sessionId = 'archived' } },
    { name: '状态覆盖', edit: (raw) => { raw.sessions[0].sourceStatus = 'completed' } },
    { name: '引用串会话', edit: (raw) => { raw.sessions[0].progress[0].evidence[0].quote = '只看到目录列表' } },
    { name: '引用改写', edit: (raw) => { raw.sessions[0].progress[0].evidence[0].quote = '已修复权限错误' } },
    { name: '空证据', edit: (raw) => { raw.sessions[0].blockers[0].evidence = [] } },
    { name: '用标题证明阻碍', edit: (raw) => { raw.sessions[0].blockers[0].evidence = [{ source: 'title', quote: '提问测试' }] } },
    { name: '信息缺口', edit: (raw) => { raw.sessions[1].openQuestions = [] } },
    { name: '无效行动类型', edit: (raw) => { raw.sessions[1].nextActions[0].kind = 'executed' } },
    { name: '超长字段', edit: (raw) => { raw.sessions[0].progress[0].text = '字'.repeat(301) } },
    { name: '额外字段', edit: (raw) => { raw.sessions[0].nextActions[0].owner = '张三' } },
  ]
  for (const item of invalid) {
    const raw = response(); item.edit(raw)
    assert.throws(() => parseAssistantStructuredIndex(JSON.stringify(raw), index), /格式校验失败/u, item.name)
  }
})

test('没有正文时保留信息缺口，标题只允许支持目标；旧播报提示词不能覆盖固定格式', () => {
  const empty = { ...index, unreadableCount: 1, entries: [{ ...index.entries[0]!, summary: null }] }
  const raw = { schemaVersion: 1, sessions: [{ hostId: 'host', sessionId: 'permission', objective: { text: '测试提问', evidence: [{ source: 'title', quote: '提问测试' }] }, progress: [], blockers: [], pendingTasks: [], nextActions: [], openQuestions: ['会话正文何时能读取？'] }] }
  const result = parseAssistantStructuredIndex(JSON.stringify(raw), empty)
  assert.equal(result.sessions[0]?.material, 'unavailable')
  raw.sessions[0]!.openQuestions = []
  assert.throws(() => parseAssistantStructuredIndex(JSON.stringify(raw), empty), /正文缺失/u)
  const prompt = createAssistantIndexSystem(index, '不要列表，只输出三句播报。')
  assert.ok(prompt.includes('固定格式优先于前置提示词'))
  assert.ok(prompt.includes('"schemaVersion":1'))
  assert.ok(prompt.includes('只输出一个合法 JSON 对象'))
})
