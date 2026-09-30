import assert from 'node:assert/strict'
import test from 'node:test'
import { createPwaSessionNotification } from '../data/build/dist/host/modules/pwa/index.js'

test('会话轮次结束事件生成带会话地址的推送', () => {
  assert.deepEqual(
    createPwaSessionNotification({ session: { id: 'session/1' }, event: { type: 'turn/end' } }),
    {
      title: 'DSH 会话已完成',
      body: '会话 session/1 已完成当前轮次。',
      tag: 'codingns4dsh-turn-session/1',
      url: '/?sessionId=session%2F1',
    },
  )
})

test('等待输入和无关事件分别投影与忽略', () => {
  const waiting = createPwaSessionNotification({
    session: { sessionId: 'abc' },
    event: { type: 'session/event', data: { method: 'item/permissions/requestApproval' } },
  })
  assert.equal(waiting?.title, 'DSH 等待你的输入')
  assert.equal(waiting?.url, '/?sessionId=abc')
  assert.equal(createPwaSessionNotification({ session: { id: 'abc' }, event: { type: 'turn/start' } }), null)
})
