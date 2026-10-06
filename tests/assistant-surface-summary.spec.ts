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
