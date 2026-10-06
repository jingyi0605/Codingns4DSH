import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantDispatcher } from '../data/build/dist/host/features/assistant-dispatch.js'
import { AssistantVoiceTurnRouter } from '../data/build/dist/host/features/assistant-voice-turn.js'
import { createAssistantVoiceActionBridge } from '../data/build/dist/host/features/voice-agent-actions.js'
import { VoiceAgentService } from '../data/build/dist/host/features/voice-agent-service.js'
import { createAssistantScope } from '../data/build/dist/host/features/assistant-scope.js'
import type { AssistantSessionIndexSnapshot } from '../data/build/dist/host/features/assistant-session-index.js'

const entry = {
  sessionId: 's1', title: '前端', workspaceId: 'w1', workspaceName: '项目', hostId: 'local',
  running: true, completed: false, updatedAt: 1, waiting: null,
}
const snapshot: AssistantSessionIndexSnapshot = {
  generation: 3,
  entries: [entry],
  scope: { status: 'ready', managedWorkspaceIds: ['w1'] },
  unreadableCount: 0,
}

test('最终文本通过注册动作生成摘要并派发到范围复核后的目标', async () => {
  const calls: unknown[] = []
  const router = new AssistantVoiceTurnRouter(new AssistantDispatcher((request) => { calls.push(request) }))
  const service = new VoiceAgentService()
  const bridge = createAssistantVoiceActionBridge({
    voiceAgent: service,
    ownerPrefix: 'voice-runtime',
    buildIndex: async () => snapshot,
    createDispatchContext: (value) => ({
      scope: createAssistantScope(value.scope.status === 'ready' ? value.scope.managedWorkspaceIds : []),
      archivedSessionIds: [],
      indexGeneration: value.generation,
      entries: value.entries,
    }),
    router,
  })
  bridge.register()

  const summary = await bridge.handleFinalText('现在进展怎么样', 'voice-summary')
  assert.equal(summary.kind, 'summary')
  assert.match(summary.speechText, /运行中/u)

  const dispatch = await bridge.handleFinalText('让前端立即修复按钮', 'voice-dispatch')
  assert.equal(dispatch.kind, 'dispatch')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    requestId: 'voice-dispatch', sessionId: 's1', mode: 'steer',
    content: [{ type: 'text', text: '按钮' }],
    hostId: 'local',
  })
  await bridge.dispose()
})

test('动作桥重复注册和释放幂等，释放后不再调用动作', async () => {
  const router = new AssistantVoiceTurnRouter(new AssistantDispatcher(() => undefined))
  const service = new VoiceAgentService()
  const bridge = createAssistantVoiceActionBridge({
    voiceAgent: service,
    ownerPrefix: 'voice-runtime',
    buildIndex: async () => ({ ...snapshot, entries: [] }),
    createDispatchContext: (value) => ({ scope: createAssistantScope([]), archivedSessionIds: [], indexGeneration: value.generation, entries: value.entries }),
    router,
  })
  const first = bridge.register()
  const second = bridge.register()
  assert.equal(first, second)
  await bridge.dispose()
  await bridge.dispose()
})
