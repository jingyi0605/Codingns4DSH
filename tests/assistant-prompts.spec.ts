import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodingNsSettingsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { DEFAULT_ASSISTANT_PROMPTS, readAssistantPrompts } from '../data/build/dist/shared/assistant-prompts.js'
import type { CodingNsSettingsOperation } from '../data/build/dist/dsh-capabilities/settings-store.js'
import { createAssistantChatSystem, createAssistantIndexSystem } from '../src/host/features/assistant-prompts.js'

test('旧助理设置回填两套口语提示词，空白值使用默认，已有范围和语音配置保持兼容', () => {
  const input = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  delete input.assistant.prompts
  input.assistant.managedWorkspaceIds = ['test-workspace']
  input.assistant.voice.modelId = 'zipformer-large'
  const parsed = CodingNsSettingsSchema(input)
  assert.deepEqual(parsed.assistant.prompts, DEFAULT_ASSISTANT_PROMPTS)
  assert.deepEqual(parsed.assistant.managedWorkspaceIds, ['test-workspace'])
  assert.equal(parsed.assistant.voice.modelId, 'zipformer-large')
  assert.deepEqual(readAssistantPrompts({ index: '  ', chat: '自定义口语要求' }), { index: DEFAULT_ASSISTANT_PROMPTS.index, chat: '自定义口语要求' })
  assert.throws(() => CodingNsSettingsSchema({ ...input, assistant: { ...input.assistant, prompts: { index: 'a'.repeat(8001), chat: '' } } }))
})

test('已保存的旧默认对话提示词升级，真正自定义的对话及索引提示词保持不变', () => {
  const oldDefault = '请用简洁的中文口语回答，适合直接朗读。先直接回应用户的问题，通常用一到四个短句；用户明确要求细节时再适当展开。不要使用标题、编号、列表、表格、Markdown、排比或套话，不要机械复述整份索引。提到项目时使用容易理解的名称，优先说明当前进展、实际阻碍和需要用户处理的下一步。'
  const saved = { index: '按项目阶段整理证据。', chat: oldDefault }
  assert.deepEqual(readAssistantPrompts(saved), { index: saved.index, chat: DEFAULT_ASSISTANT_PROMPTS.chat })
  assert.equal(saved.chat, oldDefault, '读取旧配置不写入原对象')
  assert.deepEqual(readAssistantPrompts({ index: saved.index, chat: '  只说一句话。  ' }), { index: saved.index, chat: '只说一句话。' })
  const previous = '请用简短的中文口语回答，适合直接朗读。默认只说一到两个短句，总长度控制在100字以内，每句只表达一个重点。先给结论，再说最重要的处理动作；用户明确要求全部事项或细节时才展开。只回答当前问题，不复述背景、完整日志或附加建议。不要使用标题、编号、列表、表格、Markdown、排比或套话。项目多时优先说明最紧急的事项，用简短名称定位。'
  assert.equal(readAssistantPrompts({ chat: previous }).chat, DEFAULT_ASSISTANT_PROMPTS.chat)
})

test('正式助理按上下文兼顾陪伴和工作；联网只用于公开实时问题，预览和索引不获得工具权限', () => {
  const index = { generation: 0, scope: { status: 'empty' as const, reason: 'no-managed-workspaces' as const, message: '未选工作区' }, entries: [], unreadableCount: 0 }
  const chat = createAssistantChatSystem(index, '用户原有自定义提示词。', true)
  for (const expected of ['用户原有自定义提示词', '100字', '先接住情绪', '不强行给结论', '不要求用户手动切换', '进入工作状态', '不把陪伴聊天误当成发送跟进的授权',
    '原生 web_search', '不能从项目路径猜测用户位置', '私有会话正文', '实际提供', '不能伪造实时信息', '不擅自修改提供商', '不编造真人身份', '不得创建子 Agent']) assert.ok(chat.includes(expected), expected)
  assert.ok(!chat.includes('本轮只读，不执行工具'))
  for (const prompt of [createAssistantChatSystem(index), createAssistantIndexSystem(index)]) {
    assert.ok(prompt.includes('本轮只读，不执行工具或派发任务'))
    assert.ok(!prompt.includes('原生 web_search'))
  }
  assert.ok(!createAssistantIndexSystem(index).includes('先接住情绪'), '陪伴规则不污染索引总结格式')
})

test('提示词 RPC 支持单字段持久化，保留其他助理配置，校验非法内容、版本与只读边界', async () => {
  const current = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  current.assistant.managedWorkspaceIds = ['test-workspace']
  const voice = current.assistant.voice
  let writable = true
  let writes = 0
  const provider = {
    get writable() { return writable },
    describe: () => [{ ns: 'codingns', revision: 7, value: current }],
    get: () => current,
    mutate: async (_namespace: string, operations: readonly CodingNsSettingsOperation[], revision?: number) => {
      assert.equal(revision, 7)
      writes += 1
      const operation = operations[0]!
      const key = operation.path[2] as 'index' | 'chat'
      current.assistant.prompts = { ...current.assistant.prompts!, [key]: operation.value as string }
    },
  }
  const handler = createCodingNsSettingsRpcHandler(provider)
  await handler('set', { expectedRevision: 7, ops: [{ op: 'set', path: ['assistant', 'prompts', 'chat'], value: '只说一句话。' }] })
  assert.equal(current.assistant.prompts?.chat, '只说一句话。')
  assert.equal(current.assistant.prompts?.index, DEFAULT_ASSISTANT_PROMPTS.index)
  assert.equal(current.assistant.voice, voice)
  assert.deepEqual(current.assistant.managedWorkspaceIds, ['test-workspace'])
  for (const [path, value] of [
    [['assistant', 'prompts', 'index'], 123],
    [['assistant', 'prompts', 'chat'], 'a'.repeat(8001)],
    [['assistant', 'prompts', 'unknown'], '错误字段'],
    [['assistant', 'prompts'], { index: '有效', extra: '错误字段' }],
    [['assistant'], { ...current.assistant, prompts: { index: false } }],
  ]) await assert.rejects(handler('set', { expectedRevision: 7, ops: [{ op: 'set', path, value }] }))
  assert.equal(writes, 1)
  writable = false
  await assert.rejects(handler('set', { expectedRevision: 7, ops: [{ op: 'set', path: ['assistant', 'prompts', 'index'], value: '只说两句话。' }] }), /只读/u)
  assert.equal(writes, 1)
})
