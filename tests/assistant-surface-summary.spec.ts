import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeSurfaceEvents } from '../data/build/dist/host/features/global-voice-rpc.js'

test('readSurface 语义事件只提取用户、助理和工具摘要', () => {
  const summary = summarizeSurfaceEvents([
    { type: 'assistant/chunk', text: '不应把流式 chunk 当正文' },
    { type: 'user/message', data: { text: '检查测试状态' } },
    { type: 'tool/call', name: 'shell' },
    { type: 'assistant/message', content: [{ type: 'text', text: '测试正在运行' }] },
  ])
  assert.equal(summary, '用户：检查测试状态；助理：测试正在运行；工具：shell')
})

test('没有语义正文时返回空值，不制造会话摘要', () => {
  assert.equal(summarizeSurfaceEvents([{ type: 'reasoning-chunks', text: '内部流' }]), null)
})

test('v4 读取助理嵌套 message，跳过时间上下文和内部思考块', () => {
  assert.equal(summarizeSurfaceEvents([
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '检查项目' }] } },
    { type: 'user/message', data: { source: { kind: 'dsh-time' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] } },
    { type: 'assistant/message', data: { message: { source: { kind: 'model' }, content: [{ type: 'reasoning', text: '内部思考不进入摘要' }, { type: 'text', text: '测试已经通过' }] } } },
  ]), '用户：检查项目；助理：测试已经通过')
})
