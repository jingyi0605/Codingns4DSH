import assert from 'node:assert/strict'
import test from 'node:test'
import { appendAssistantSessionStream, readAssistantSessionMessages } from '../src/shared/assistant-session-messages.js'

test('读取进行中会话的消息、半截助理文本和工具状态', () => {
  const messages = readAssistantSessionMessages([
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请检查登录' }] } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'dsh-time' }, content: [{ type: 'text', text: '内部时间' }] } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我正在检查' }] } } },
    { type: 'tool/call', seq: 4, data: { callId: 'tool-1', name: 'read_file' } },
    { type: 'tool/result', seq: 5, data: { callId: 'tool-1', name: 'read_file', content: '文件内容', isError: false } },
  ])
  assert.deepEqual(messages.map((message) => message.role), ['assistant', 'tool'])
  assert.equal(messages[0]?.text, '我正在检查')
  assert.equal(messages[1]?.state, 'completed')
  assert.equal(messages[1]?.toolName, 'read_file')
  assert.equal(messages[1]?.result, undefined)
  assert.equal(readAssistantSessionMessages([
    { type: 'tool/call', data: { callId: 'tool-1', name: 'read_file' } },
    { type: 'tool/result', data: { callId: 'tool-1', name: 'read_file', content: '文件内容' } },
  ], { toolCallId: 'tool-1' })[0]?.result, '文件内容')
})

test('消息读取有界，不返回内部思考和超长历史', () => {
  const messages = readAssistantSessionMessages([
    ...Array.from({ length: 40 }, (_, index) => ({ type: 'user/message', seq: index, data: { source: { kind: 'user' }, text: `问题-${index}` } })),
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '内部思考不应展示' }, { type: 'text', text: '当前进展' }] } } },
  ])
  assert.ok(messages.length <= 24)
  assert.ok(messages.every((message) => message.text.length <= 6_000))
  assert.ok(messages.every((message) => !message.text.includes('内部思考')))
})

test('读取 DSH follow 的事件包装和当前尚未落盘的 assistant stream', () => {
  const messages = appendAssistantSessionStream(readAssistantSessionMessages([
    { type: 'event', event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续处理' }] } } },
  ]), {
    revision: 2,
    activeAttempt: { turn: 2, step: 1, stream: [{ type: 'text-delta', text: '正在实时' }, { type: 'text-delta', text: '输出' }] },
  })
  assert.deepEqual(messages.map((message) => message.text), ['正在实时输出'])
})
