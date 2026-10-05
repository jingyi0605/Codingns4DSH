import assert from 'node:assert/strict'
import test from 'node:test'
import { genericEventChunks } from '../data/build/dist/host/cli-adapters/standard-stream-driver.js'
import { reasoningText, textContent } from '../data/build/dist/host/cli-adapters/reasoning-content.js'

test('思考内容识别器只提取明确标记的 thinking/reasoning', () => {
  const content = [
    { type: 'thinking', thinking: '先分析请求。' },
    { type: 'text', text: '这是最终回答。' },
  ]
  assert.equal(reasoningText({ type: 'assistant', message: { content } }), '先分析请求。')
  assert.equal(textContent(content), '这是最终回答。')
  assert.equal(reasoningText({ type: 'assistant', content: '普通正文' }), null)
  assert.equal(reasoningText({ type: 'assistant', text: '普通正文' }), null)
  assert.equal(reasoningText({ type: 'contentpart', think: 'Kimi 思考' }), 'Kimi 思考')
})

test('通用流事件把嵌套思考块和正文分别投影', () => {
  assert.deepEqual(
    genericEventChunks({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '先检查上下文。' },
          { type: 'text', text: '检查完成。' },
        ],
      },
    }, false).filter((chunk) => chunk.type === 'reasoning-delta' || chunk.type === 'text-delta'),
    [
      { type: 'reasoning-delta', text: '先检查上下文。' },
      { type: 'text-delta', text: '检查完成。' },
    ],
  )
})

test('通用流事件优先识别 generic assistant 事件中的显式 reasoning 字段', () => {
  assert.deepEqual(
    genericEventChunks({ type: 'assistant', delta: { reasoning: '内部推理', text: '最终答案' } }, false)
      .filter((chunk) => chunk.type === 'reasoning-delta' || chunk.type === 'text-delta'),
    [
      { type: 'reasoning-delta', text: '内部推理' },
      { type: 'text-delta', text: '最终答案' },
    ],
  )
})
