import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantDispatcher } from '../data/build/dist/host/features/assistant-dispatch.js'
import { createAssistantScope } from '../data/build/dist/host/features/assistant-scope.js'
import type { SessionIndexEntry } from '../data/build/dist/shared/contracts/assistant.js'

const entry: SessionIndexEntry = { sessionId: 'session-a', title: '前端', workspaceId: 'workspace-a', workspaceName: '前端', hostId: 'local', running: true, completed: false, updatedAt: 1, waiting: null }
const target = { sessionId: 'session-a', workspaceId: 'workspace-a', hostId: 'local', indexGeneration: 2 }
const context = { scope: createAssistantScope(['workspace-a']), archivedSessionIds: [], indexGeneration: 2, entries: [entry] }

test('派发前再次校验范围和索引代次', async () => {
  const calls: unknown[] = []
  const dispatcher = new AssistantDispatcher((request) => { calls.push(request) })
  const ok = await dispatcher.dispatch({ requestId: 'r1', target, mode: 'steer', task: '修复按钮' }, context)
  assert.equal(ok.ok, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { requestId: 'r1', sessionId: 'session-a', mode: 'steer', content: [{ type: 'text', text: '修复按钮' }], hostId: 'local' })
  const stale = await dispatcher.dispatch({ requestId: 'r2', target: { ...target, indexGeneration: 1 }, mode: 'queue', task: '再试一次' }, context)
  assert.equal(stale.code, 'stale-target')
})

test('范围外和已归档会话被拒绝，不自动取消归档', async () => {
  const dispatcher = new AssistantDispatcher(() => { throw new Error('should not prompt') })
  const outside = await dispatcher.dispatch({ requestId: 'r1', target: { ...target, workspaceId: 'workspace-b' }, mode: 'queue', task: '任务' }, context)
  assert.equal(outside.code, 'scope-rejected')
  const archived = await dispatcher.dispatch({ requestId: 'r2', target, mode: 'queue', task: '任务' }, { ...context, archivedSessionIds: ['session-a'] })
  assert.equal(archived.code, 'scope-rejected')
  assert.equal(archived.rejection?.code, 'session-archived')
})

test('重复 requestId 不重复调用 prompt，空任务被拒绝', async () => {
  let count = 0
  const dispatcher = new AssistantDispatcher(() => { count += 1 })
  await dispatcher.dispatch({ requestId: 'same', target, mode: 'queue', task: '任务' }, context)
  await dispatcher.dispatch({ requestId: 'same', target, mode: 'queue', task: '任务' }, context)
  const empty = await dispatcher.dispatch({ requestId: 'empty', target, mode: 'queue', task: ' ' }, context)
  assert.equal(count, 1)
  assert.equal(empty.code, 'invalid-request')
})
