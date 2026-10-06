import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantDispatcher } from '../data/build/dist/host/features/assistant-dispatch.js'
import { AssistantVoiceTurnRouter } from '../data/build/dist/host/features/assistant-voice-turn.js'
import { createAssistantScope } from '../data/build/dist/host/features/assistant-scope.js'
import type { AssistantIndexSnapshot, SessionIndexEntry } from '../data/build/dist/shared/contracts/assistant.js'

const entry: SessionIndexEntry = { sessionId: 's1', title: '前端', workspaceId: 'w1', workspaceName: '项目', hostId: 'local', running: true, completed: false, updatedAt: 1, waiting: null }
const snapshot: AssistantIndexSnapshot = { generation: 3, entries: [entry], unreadableCount: 0, scope: { status: 'ready', managedWorkspaceIds: ['w1'] } }
const context = { scope: createAssistantScope(['w1']), archivedSessionIds: [], indexGeneration: 3, entries: [entry] }

test('汇总文本直接生成可播报结果', async () => {
  const router = new AssistantVoiceTurnRouter(new AssistantDispatcher(() => undefined))
  const result = await router.handleText('现在进展怎么样', snapshot, { dispatchContext: context })
  assert.equal(result.kind, 'summary')
  assert.match(result.speechText, /待处理/u)
})

test('派发闭环调用注入 prompt 并返回模式', async () => {
  const calls: unknown[] = []
  const router = new AssistantVoiceTurnRouter(new AssistantDispatcher((request) => { calls.push(request) }))
  const result = await router.handleText('让前端页面立即修复按钮', snapshot, { requestId: 'voice-1', dispatchContext: context })
  assert.equal(result.kind, 'dispatch')
  assert.equal(result.mode, 'steer')
  assert.equal(calls.length, 1)
})
