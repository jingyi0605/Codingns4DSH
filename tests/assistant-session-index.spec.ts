import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantSessionIndexController, buildAssistantSessionIndex, lastSessionTitle, type AssistantSessionSourceRecord } from '../data/build/dist/host/features/assistant-session-index.js'
import { createAssistantScope } from '../data/build/dist/host/features/assistant-scope.js'

const sessions: readonly AssistantSessionSourceRecord[] = [
  { sessionId: 'a', workspaceId: 'w-a', workspaceName: '项目 A', hostId: 'local', running: true, completed: false, updatedAt: 3, waiting: null, titleEvents: ['暂态 HTML', '正式标题'] },
  { sessionId: 'b', workspaceId: 'w-b', workspaceName: '项目 B', hostId: 'remote', running: false, completed: true, updatedAt: 2, waiting: null, title: '后端' },
  { sessionId: 'c', workspaceId: 'w-a', workspaceName: '项目 A', hostId: 'local', running: false, completed: false, updatedAt: 1, waiting: 'approval', title: '审批' },
]

test('标题取最后一条有效 session/title', () => {
  assert.equal(lastSessionTitle(['首条', '', null, '末条']), '末条')
  assert.equal(lastSessionTitle([undefined, '']), null)
})

test('先过滤范围和归档，再读取摘要', async () => {
  const read: string[] = []
  const result = await buildAssistantSessionIndex({
    sessions,
    scope: createAssistantScope(['w-a']),
    archivedSessionIds: ['c'],
    generation: 4,
    readSummary: (session) => { read.push(session.sessionId); return `摘要 ${session.sessionId}` },
  })
  assert.deepEqual(read, ['a'])
  assert.deepEqual(result.entries.map((entry) => entry.sessionId), ['a'])
  assert.equal(result.entries[0]?.title, '正式标题')
  assert.equal(result.generation, 4)
})

test('范围为空保留明确状态，不报告无进展', async () => {
  const result = await buildAssistantSessionIndex({ sessions, scope: createAssistantScope([]), archivedSessionIds: [] })
  assert.equal(result.scope.status, 'empty')
  assert.deepEqual(result.entries, [])
})

test('单会话读取失败只计数，不中断索引', async () => {
  const result = await buildAssistantSessionIndex({
    sessions: [sessions[0]!, sessions[1]!],
    scope: createAssistantScope(['w-a', 'w-b']),
    archivedSessionIds: [],
    readSummary: (session) => { if (session.sessionId === 'a') throw new Error('read failed'); return 'ok' },
  })
  assert.equal(result.entries.length, 2)
  assert.equal(result.unreadableCount, 1)
})

test('归档立即移出索引，取消归档后重新纳入', async () => {
  const controller = new AssistantSessionIndexController(sessions, createAssistantScope(['w-a']), [])
  assert.deepEqual((await controller.refresh()).entries.map((entry) => entry.sessionId), ['a', 'c'])
  assert.deepEqual((await controller.setArchivedSessionIds(['a'])).entries.map((entry) => entry.sessionId), ['c'])
  assert.deepEqual((await controller.setArchivedSessionIds([])).entries.map((entry) => entry.sessionId), ['a', 'c'])
})
