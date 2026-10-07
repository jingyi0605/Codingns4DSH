import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AssistantConversation, type AssistantConversationContext } from '../src/host/features/assistant-conversation.js'
import { AssistantTextChat } from '../src/host/features/assistant-text-chat.js'
import { readAssistantProfile, validateAssistantProfile } from '../src/shared/assistant-lifecycle.js'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/contracts/config.js'
import type { AssistantLlmAdapter } from '../src/dsh-capabilities/host/assistant-llm-adapter.js'
import { createAssistantConversationStorage, assistantConversationDirectory } from '../src/host/features/assistant-conversation-storage.js'
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const model = { provider: 'api', model: 'chat', label: '模型' }
const context: AssistantConversationContext = { ...model, index: { generation: 0, scope: { status: 'empty', reason: 'no-managed-workspaces', message: '尚未选择任何工作区' }, unreadableCount: 0, entries: [] }, isCurrent: () => true, createSystem: () => '仅普通交流，未提供当前项目事实。' }

function fixture(t: TestContext, reply?: AssistantLlmAdapter['reply']) {
  const calls: { messages: unknown; system: string; signal: AbortSignal }[] = []
  let value: unknown
  const storage = { async read() { return value }, async write(next: unknown) { value = structuredClone(next) } }
  const adapter: AssistantLlmAdapter = { async catalog() { return { models: [model], default: model, errors: [] } }, async reply(selected, system, messages, signal, onText) {
    calls.push({ messages, system, signal }); return reply === undefined ? '回复' : reply(selected, system, messages, signal, onText)
  } }
  const engine = new AssistantTextChat(adapter)
  const conversation = new AssistantConversation(engine, adapter, storage)
  t.after(() => { conversation.dispose(); engine.dispose() })
  const send = async (id: string, text = '问题', source: 'text' | 'voice' = 'text', facts = context) => {
    await conversation.start(id, text, facts, source)
    await engine.wait(id); await setImmediate()
    return conversation.snapshot()
  }
  return { conversation, engine, adapter, storage, calls, send }
}

test('已有能力配置不自动创建，显式档案决定创建与重置状态', () => {
  assert.equal(readAssistantProfile(DEFAULT_ASSISTANT_SETTINGS).initialized, false)
  assert.equal(readAssistantProfile({ ...DEFAULT_ASSISTANT_SETTINGS, managedWorkspaceIds: ['w'] }).initialized, false)
  assert.equal(readAssistantProfile({ ...DEFAULT_ASSISTANT_SETTINGS, profile: { name: '已有助理', initialized: true, createdAt: 1 } }).initialized, true)
  assert.equal(readAssistantProfile({ ...DEFAULT_ASSISTANT_SETTINGS, managedWorkspaceIds: ['w'], profile: { name: '新助理', initialized: false, createdAt: null } }).initialized, false)
  assert.throws(() => validateAssistantProfile({ name: ' ', initialized: true, createdAt: null }))
})

test('文字和语音共用连续上下文，索引更新保留记录，重新实例化恢复消息', async (t) => {
  const f = fixture(t)
  await f.send('text', '先用文字')
  const state = await f.send('voice', '继续追问', 'voice', { ...context, index: { ...context.index, generation: 8 } })
  assert.equal(state.messages.length, 4)
  assert.deepEqual((f.calls[1]!.messages as any[]).map((message) => message.text), ['先用文字', '回复', '继续追问'])
  const restored = new AssistantConversation(f.engine, f.adapter, f.storage)
  t.after(() => restored.dispose())
  assert.deepEqual((await restored.snapshot()).messages, state.messages)
  assert.equal(state.messages[2]!.source, 'voice')
})

test('超过一百轮不会要求手动压缩，显示记录仍可持久恢复', async (t) => {
  const f = fixture(t)
  for (let round = 0; round < 102; round++) await f.send(`round-${round}`)
  assert.equal((await f.conversation.snapshot()).messages.length, 204)
  const restored = new AssistantConversation(f.engine, f.adapter, f.storage)
  t.after(() => restored.dispose())
  assert.equal((await restored.snapshot()).messages.length, 204)
})

test('范围变更保留可见历史，但新范围只发送新问题', async (t) => {
  const f = fixture(t)
  await f.send('old', '旧范围项目秘密')
  await f.conversation.invalidateContext()
  await f.send('new', '新范围问题')
  assert.equal((await f.conversation.snapshot()).messages.length, 4)
  assert.deepEqual(f.calls.at(-1)!.messages, [{ role: 'user', text: '新范围问题' }])
})

test('清理和取消撤销迟到结果，请求标识不能重复提交', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const f = fixture(t, async () => { await gate; return '迟到回复' })
  await f.conversation.start('late', '问题', context, 'text')
  await f.conversation.clear(); release(); await setImmediate()
  assert.equal((await f.conversation.snapshot()).messages.length, 0)
  assert.equal(f.calls[0]!.signal.aborted, true)
  await assert.rejects(f.conversation.start('late', '问题', context, 'text'), /已被使用/u)
})

test('压缩保留近期三轮，摘要进入后续上下文，失败保留原记录', async (t) => {
  let fail = false
  const f = fixture(t, async (_model, system) => {
    if (system.includes('压缩历史交流')) { if (fail) throw new Error('压缩失败'); return '用户偏好简短回答' }
    return '回复'
  })
  for (let i = 0; i < 5; i++) await f.send(`m${i}`)
  const original = await f.conversation.snapshot()
  fail = true
  await assert.rejects(f.conversation.compress(model), /压缩失败/u)
  assert.deepEqual((await f.conversation.snapshot()).messages, original.messages)
  fail = false; await f.conversation.compress(model)
  const compressed = await f.conversation.snapshot()
  assert.equal(compressed.messages.length, 6)
  assert.equal(compressed.summary, '用户偏好简短回答')
  await f.send('follow')
  assert.ok(f.calls.at(-1)!.system.includes('用户偏好简短回答'))
})

test('压缩期间清理，旧摘要不能覆盖空记录', async (t) => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const f = fixture(t, async (_model, system) => { if (system.includes('压缩历史交流')) { await gate; return '过期摘要' }; return '回复' })
  for (let i = 0; i < 4; i++) await f.send(`m${i}`)
  const pending = f.conversation.compress(model)
  await setImmediate(); await f.conversation.clear(); release()
  await assert.rejects(pending, /取消/u)
  const state = await f.conversation.snapshot()
  assert.equal(state.summary, ''); assert.equal(state.messages.length, 0)
})

test('保存错误被明确返回，损坏记录不会被静默覆盖', async (t) => {
  const f = fixture(t)
  f.storage.write = async () => { throw new Error('磁盘只读') }
  await f.send('write')
  assert.match((await f.conversation.snapshot()).error!, /保存失败/u)
  const damaged = new AssistantConversation(f.engine, f.adapter, { async read() { return { schemaVersion: 9 } }, async write() { assert.fail('不得覆盖原文件') } })
  t.after(() => damaged.dispose())
  await assert.rejects(damaged.snapshot(), /格式无效/u)
})

test('对话文件原子替换并可重读，Host 状态目录按 DSH_HOME 隔离', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-conversation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const storage = createAssistantConversationStorage(directory)
  assert.equal(await storage.read(), undefined)
  await storage.write({ schemaVersion: 1, messages: ['中文记录'] })
  assert.deepEqual(await createAssistantConversationStorage(directory).read(), { schemaVersion: 1, messages: ['中文记录'] })
  await storage.write({ schemaVersion: 1, messages: [] })
  assert.deepEqual(await readdir(directory), ['assistant-conversation.json'])
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'assistant-conversation.json'))).mode & 0o777, 0o600)
  const previous = process.env.DSH_HOME; const override = process.env.CODINGNS4DSH_STATE_DIR
  try {
    delete process.env.CODINGNS4DSH_STATE_DIR; process.env.DSH_HOME = directory
    assert.equal(assistantConversationDirectory(), join(directory, 'codingns4dsh'))
    process.env.CODINGNS4DSH_STATE_DIR = join(directory, 'override')
    assert.equal(assistantConversationDirectory(), join(directory, 'override'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    if (override === undefined) delete process.env.CODINGNS4DSH_STATE_DIR; else process.env.CODINGNS4DSH_STATE_DIR = override
  }
})

test('完整重置可以显式清空损坏记录，普通读取和清理仍拒绝覆盖', async (t) => {
  const f = fixture(t); let stored: any = { schemaVersion: 9 }
  const damaged = new AssistantConversation(f.engine, f.adapter, { async read() { return stored }, async write(value) { stored = value } })
  t.after(() => damaged.dispose())
  await assert.rejects(damaged.clear(), /格式无效/u)
  await damaged.clear(true)
  assert.equal(stored.schemaVersion, 1)
  assert.deepEqual((await damaged.snapshot()).messages, [])
})

test('长历史按问答分批压缩，后续批次失败不应用半成品摘要', async (t) => {
  let batches = 0; let fail = true
  const f = fixture(t, async (_model, system) => {
    if (!system.includes('压缩历史交流')) return '回复'
    batches++; if (fail && batches === 2) throw new Error('后续批次失败')
    return '完整摘要'
  })
  for (let i = 0; i < 10; i++) await f.send(`long-${i}`, '文'.repeat(7000))
  const original = await f.conversation.snapshot()
  await assert.rejects(f.conversation.compress(model), /后续批次失败/u)
  assert.deepEqual((await f.conversation.snapshot()).messages, original.messages)
  assert.equal((await f.conversation.snapshot()).summary, '')
  batches = 0; fail = false; await f.conversation.compress(model)
  assert.ok(batches > 1)
  assert.equal((await f.conversation.snapshot()).messages.length, 6)
})

test('上游不响应撤销时，清理也能立即结算压缩请求并保留空记录', async (t) => {
  const f = fixture(t, async (_model, system) => system.includes('压缩历史交流') ? new Promise<string>(() => {}) : '回复')
  for (let i = 0; i < 4; i++) await f.send(`m${i}`)
  const pending = f.conversation.compress(model)
  const rejected = assert.rejects(pending, /取消/u)
  await setImmediate(); await f.conversation.clear(); await rejected
  assert.deepEqual((await f.conversation.snapshot()).messages, [])
})
