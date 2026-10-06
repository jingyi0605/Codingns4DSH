import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantWaitingState } from '../data/build/dist/host/features/assistant-waiting-state.js'

test('等待状态来自请求事件，不把 running 当成等待', () => {
  const state = new AssistantWaitingState()
  assert.equal(state.get('session-1'), null)
  state.request({ sessionId: 'session-1', kind: 'approval' })
  assert.equal(state.get('session-1'), 'approval')
  state.request({ sessionId: 'session-1', kind: 'question' })
  assert.equal(state.get('session-1'), 'question')
  state.resolve('session-1')
  assert.equal(state.get('session-1'), null)
})
