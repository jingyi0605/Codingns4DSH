import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AssistantVoiceChat, type AssistantVoiceChatContext } from '../src/host/features/assistant-voice-chat.js'
import { AssistantTextChat, createAssistantChatSystem } from '../src/host/features/assistant-text-chat.js'
import type { AssistantLlmAdapter } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import type { AssistantChatMessage, AssistantIndexSnapshot } from '../src/shared/contracts/assistant.js'
import { DEFAULT_ASSISTANT_PROMPTS } from '../src/shared/assistant-prompts.js'

const model = { provider: 'api', model: 'selected', label: '所选模型' }
const index: AssistantIndexSnapshot = { generation: 1, scope: { status: 'ready', managedWorkspaceIds: ['w1'] }, unreadableCount: 0, entries: [] }
const context = (overrides: Partial<AssistantVoiceChatContext> = {}): AssistantVoiceChatContext => ({ index, ...model, prompt: DEFAULT_ASSISTANT_PROMPTS.chat, isCurrent: () => true, createSystem: createAssistantChatSystem, ...overrides })
function fixture(t: TestContext, reply?: AssistantLlmAdapter['reply'], catalog?: AssistantLlmAdapter['catalog']) {
  const calls: { messages: readonly AssistantChatMessage[]; system: string; signal: AbortSignal; model: unknown }[] = []
  const adapter: AssistantLlmAdapter = { catalog: catalog ?? (async () => ({ models: [model, { ...model, model: 'other' }], default: model, errors: [] })), reply: async (selected, system, messages, signal, update) => {
    calls.push({ messages, system, signal, model: selected })
    return reply === undefined ? `回复${calls.length}。` : reply(selected, system, messages, signal, update)
  } }
  const engine = new AssistantTextChat(adapter)
  const chat = new AssistantVoiceChat(engine)
  t.after(() => { chat.clear(); engine.dispose() })
  return { chat, engine, calls }
}

test('语音连续追问复用文字 LLM 提示词，已完成问答对按顺序进入历史', async (t) => {
  const { chat, calls } = fixture(t)
  for (let round = 1; round <= 3; round++) {
    await chat.start('page', 1, `r${round}`, `问题${round}`, context(), round)
    assert.equal((await chat.wait('page', 1, `r${round}`)).state, 'completed')
  }
  assert.deepEqual(calls[2]!.messages, [{ role: 'user', text: '问题1' }, { role: 'assistant', text: '回复1。' }, { role: 'user', text: '问题2' }, { role: 'assistant', text: '回复2。' }, { role: 'user', text: '问题3' }])
  assert.equal(calls[0]!.system, createAssistantChatSystem(index))
  assert.match(calls[0]!.system, /一到两个短句.*100字/u)
  assert.match(calls[0]!.system, /本轮只读，不执行工具或派发任务/u)
  assert.equal((calls[0]!.model as typeof model).model, 'selected')
  await chat.start('page', 1, 'r3', '问题3', context(), 3)
  assert.equal(calls.length, 3, '重复请求不重复调用模型或追加历史')
})

test('未完成旧轮被新话语取消，忽略 Abort 的迟到结果不污染历史', async (t) => {
  let release!: (text: string) => void
  let count = 0
  const { chat, calls } = fixture(t, async () => ++count === 1 ? new Promise<string>((resolve) => { release = resolve }) : '新回复。')
  await chat.start('page', 1, 'old', '旧问题', context(), 1)
  await chat.start('page', 1, 'new', '新问题', context(), 2)
  assert.equal(calls[0]!.signal.aborted, true)
  assert.equal((await chat.wait('page', 1, 'new')).text, '新回复。')
  release('迟到回复。'); await setImmediate()
  assert.equal(chat.read('page', 1, 'old').state, 'cancelled')
  await chat.start('page', 1, 'follow', '追问', context(), 3)
  assert.deepEqual(calls[2]!.messages, [{ role: 'user', text: '新问题' }, { role: 'assistant', text: '新回复。' }, { role: 'user', text: '追问' }])
  await assert.rejects(chat.start('page', 1, 'late-old', '旧请求后到', context(), 1), /顺序已失效/u)
})

test('目录读取期间取消或清空不会在稍后启动模型，取消先到也有效', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { chat, calls } = fixture(t, undefined, async () => { await gate; return { models: [model], default: model, errors: [] } })
  const started = assert.rejects(chat.start('page', 1, 'loading', '问题', context()), /已变化/u)
  chat.clear(); release(); await started
  assert.equal(calls.length, 0)
  chat.cancel('page', 1, 'cancel-first')
  await assert.rejects(chat.start('page', 1, 'cancel-first', '迟到', context()), /已取消/u)
})

test('打断保留已完成历史；清空、新租约、模型、提示词或索引版本变化清除历史', async (t) => {
  const { chat, calls } = fixture(t)
  await chat.start('page', 1, 'r1', '问题1', context())
  await chat.wait('page', 1, 'r1')
  chat.cancelActive()
  await chat.start('page', 2, 'r2', '追问', context())
  await chat.wait('page', 2, 'r2')
  assert.equal(calls[1]!.messages.length, 3)
  chat.clear()
  const variants = [context(), context({ model: 'other' }), context({ prompt: '仅说重点。' }), context({ index: { ...index, generation: 2 } })]
  for (let i = 0; i < variants.length; i++) {
    await chat.start('page', 2, `changed-${i}`, '新问题', variants[i]!)
    await chat.wait('page', 2, `changed-${i}`)
    assert.equal(calls.at(-1)!.messages.length, 1)
  }
  await chat.start('other-page', 3, 'other-owner', '新页面', variants.at(-1)!)
  assert.equal(calls.at(-1)!.messages.length, 1)
  assert.throws(() => chat.read('page', 3, 'other-owner'), /当前租约/u)
})

test('事实失效后不返回可播报的完成状态，多轮历史保持有界', async (t) => {
  const { chat, calls } = fixture(t)
  let current = true
  const facts = context({ isCurrent: () => current })
  await chat.start('page', 1, 'invalid', '问题', facts)
  await chat.wait('page', 1, 'invalid')
  current = false
  assert.equal(chat.read('page', 1, 'invalid').state, 'cancelled')
  chat.clear()
  for (let i = 0; i < 15; i++) { await chat.start('page', 1, `bound-${i}`, '继续', context()); await chat.wait('page', 1, `bound-${i}`) }
  assert.equal(calls.at(-1)!.messages.length, 19)
})

test('生成取消和超时立即结算等待者，上游不响应取消也不会挂住语音', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { chat, engine } = fixture(t, async () => new Promise<string>(() => {}))
  await chat.start('page', 1, 'cancel', '取消问题', context())
  const cancelled = engine.wait('cancel')
  chat.cancelActive()
  assert.equal((await cancelled).state, 'cancelled')
  await chat.start('page', 1, 'timeout', '超时问题', context())
  const timeout = engine.wait('timeout')
  t.mock.timers.tick(90_000)
  assert.equal((await timeout).state, 'cancelled')
})
