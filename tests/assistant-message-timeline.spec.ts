import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantMessageTimeline } from '../src/shared/assistant-message-timeline.js'
import type { AssistantToolCall } from '../src/shared/contracts/assistant.js'

const search: AssistantToolCall = { id: 'search', name: 'web_search', kind: 'web-search', state: 'running', startedAt: 1, finishedAt: null, arguments: '{}', result: '' }

test('正文和工具按开始位置穿插，并行工具结束顺序不会移动时间线', () => {
  const first = '先查询天气。\n'
  const second = '🌤 再核对来源。\n'
  const text = first + second + '最终回答。'
  const calls = [
    { ...search, textOffset: first.length, state: 'completed' as const, finishedAt: 5 },
    { ...search, id: 'parallel', textOffset: first.length, state: 'failed' as const, finishedAt: 3 },
    { ...search, id: 'next', textOffset: (first + second).length },
  ]
  const original = structuredClone(calls)
  const timeline = assistantMessageTimeline(text, calls)
  assert.deepEqual(timeline.map((part) => part.kind === 'text' ? part.text : part.call.id), [first, 'search', 'parallel', second, 'next', '最终回答。'])
  assert.equal(timeline.filter((part) => part.kind === 'text').map((part) => part.text).join(''), text, '展示拆分不增删正文或破坏中英文与表情')
  const updated = assistantMessageTimeline(text + '继续说明。', calls.map((call) => ({ ...call, state: 'completed' as const })))
  assert.deepEqual(updated.map((part) => part.key), timeline.map((part) => part.key), '状态更新和正文追加保留节点身份')
  assert.deepEqual(calls, original, '展示层不能修改共享快照')
})

test('旧记录工具放在所属回复前，空正文和残句截断仍保留工具且不丢字', () => {
  assert.deepEqual(assistantMessageTimeline('旧回答', [search]).map((part) => part.kind), ['tool', 'text'])
  assert.deepEqual(assistantMessageTimeline('', [search]).map((part) => part.kind), ['tool'])
  assert.deepEqual(assistantMessageTimeline('', []), [])
  assert.deepEqual(assistantMessageTimeline('普通回答').map((part) => part.kind), ['text'])
  const truncated = assistantMessageTimeline('残句', [{ ...search, textOffset: 16001 }])
  assert.deepEqual(truncated.map((part) => part.kind), ['text', 'tool'])
  for (const textOffset of [-1, 1.5, Number.NaN]) {
    assert.deepEqual(assistantMessageTimeline('回答', [{ ...search, textOffset }]).map((part) => part.kind), ['tool', 'text'])
  }
})
