import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { AssistantConversation, type AssistantConversationContext } from '../src/host/features/assistant-conversation.js'
import { AssistantTextChat } from '../src/host/features/assistant-text-chat.js'
import { admitAssistantAttachments, createAssistantAttachmentTool, type AssistantAttachmentStore } from '../src/dsh-capabilities/host/assistant-attachment-adapter.js'
import { readAssistantAttachmentUploads, readAssistantAttachments, type AssistantAttachment } from '../src/shared/assistant-attachments.js'

const model = { provider: 'api', model: 'test', label: '模型' }
const context: AssistantConversationContext = { ...model, index: { generation: 0, scope: { status: 'empty', reason: 'no-managed-workspaces', message: '无项目' }, entries: [], unreadableCount: 0 }, isCurrent: () => true, createSystem: () => '系统' }
const upload = { name: '记录.txt', mediaType: 'text/plain', data: Buffer.from('用户上传内容').toString('base64') }
function nativeStore() {
  let calls = 0
  const stored = new Map<string, Uint8Array>()
  const store: AssistantAttachmentStore = {
    async admitPromptContent(content: readonly any[]) {
      calls++
      return content.map((image) => ({ type: 'image', attachment: { attachmentId: `sha256:${createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex')}`,
        name: image.name, bytes: Buffer.from(image.data, 'base64').length, mediaType: image.mediaType, width: 1, height: 1 } }))
    },
    async admitEncodedFile(input) {
      calls++; const bytes = Buffer.from(input.data, 'base64'); const attachmentId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      stored.set(attachmentId, bytes); return { attachmentId, name: input.name, bytes: bytes.length }
    },
    async *readFileStream(ref) { yield stored.get(ref.attachmentId)! },
  }
  return { store, calls: () => calls }
}

test('附件先校验再进入 DSH，引用不能替代上传，非法编码、路径和超限均拒绝', async () => {
  const f = nativeStore()
  const invalid = [null, {}, Array.from({ length: 7 }, () => upload), [{ ...upload, name: '../秘密.txt' }], [{ ...upload, data: 'not-base64' }],
    [{ ...upload, mediaType: 'image/svg+xml' }], [{ type: 'file', attachment: { attachmentId: `sha256:${'a'.repeat(64)}` } }]]
  for (const value of invalid) assert.throws(() => readAssistantAttachmentUploads(value))
  assert.equal(f.calls(), 0)
  await assert.rejects(admitAssistantAttachments(undefined, [upload]), /服务不可用/)
  assert.deepEqual(await admitAssistantAttachments(undefined, []), [])
  const image = { name: '图.png', mediaType: 'image/png', data: Buffer.from('假图，仅测试接收委托').toString('base64') }
  const accepted = await admitAssistantAttachments(f.store, [upload, image])
  assert.deepEqual(accepted.map((item) => item.type), ['file', 'image'])
  assert.equal(accepted[0]!.attachment.name, '记录.txt'); assert.equal(accepted[1]!.attachment.name, '图.png')
  assert.equal(JSON.stringify(accepted).includes(upload.data), false)
  assert.throws(() => readAssistantAttachments([{ type: 'file', attachment: { attachmentId: '/tmp/file', bytes: 1 } }]), /引用无效/)
})

test('附件提交到模型并持久保存引用，刷新和语音追问保留历史；清理后模型不再收到旧附件', async (t) => {
  const f = nativeStore(); let persisted: any; const received: any[] = []
  const adapter = { async catalog() { return { models: [model], default: model, errors: [] } }, async reply(_model: unknown, _system: string, messages: any) { received.push(messages); return '已读取' } }
  const chat = new AssistantTextChat(adapter)
  const storage = { async read() { return persisted }, async write(value: unknown) { persisted = structuredClone(value) } }
  const conversation = new AssistantConversation(chat, adapter, storage, f.store)
  let restored: AssistantConversation | undefined
  t.after(() => { restored?.dispose(); conversation.dispose(); chat.dispose() })
  await conversation.start('file', '查看附件', context, 'text', [upload]); await chat.wait('file'); await setImmediate()
  const snapshot = await conversation.snapshot()
  assert.equal(snapshot.messages[0]!.attachments?.[0]!.attachment.name, '记录.txt')
  assert.deepEqual(received[0][0].attachments, snapshot.messages[0]!.attachments)
  assert.equal(JSON.stringify(persisted).includes(upload.data), false)
  restored = new AssistantConversation(chat, adapter, storage, f.store)
  assert.deepEqual((await restored.snapshot()).messages, snapshot.messages)
  await restored.start('voice', '继续追问', context, 'voice'); await chat.wait('voice'); await setImmediate()
  assert.equal(received.at(-1)[0].attachments[0].attachment.name, '记录.txt')
  await restored.clear()
  await restored.start('fresh', '新问题', context, 'text'); await chat.wait('fresh'); await setImmediate()
  assert.deepEqual(received.at(-1), [{ role: 'user', text: '新问题' }])
})

test('上传失败或取消不能开始模型或写入消息，重复标识不能换附件', async (t) => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve })
  const f = nativeStore(); const original = f.store.admitEncodedFile.bind(f.store)
  f.store.admitEncodedFile = async (input) => { await gate; return await original(input) }
  let replies = 0
  const adapter = { async catalog() { return { models: [model], default: model, errors: [] } }, async reply() { replies++; return '回复' } }
  const chat = new AssistantTextChat(adapter)
  const conversation = new AssistantConversation(chat, adapter, { async read() {}, async write() {} }, f.store)
  t.after(() => { conversation.dispose(); chat.dispose() })
  const pending = conversation.start('pending', '文件', context, 'text', [upload])
  await setImmediate()
  await assert.rejects(conversation.start('pending', '文件', context, 'text', [{ ...upload, data: Buffer.from('其他内容').toString('base64') }]), /已被使用/)
  await conversation.clear(); release(); await assert.rejects(pending, /取消/)
  assert.equal(replies, 0); assert.deepEqual((await conversation.snapshot()).messages, [])
  const before = f.calls()
  conversation.cancel('cancel-before')
  await assert.rejects(conversation.start('cancel-before', '文件', context, 'text', [upload]), /取消/)
  assert.equal(f.calls(), before)
  f.store.admitEncodedFile = async () => { throw new Error('上传失败') }
  await assert.rejects(conversation.start('failed', '文件', context, 'text', [upload]), /上传失败/)
  assert.equal(replies, 0)
  assert.deepEqual((await conversation.snapshot()).messages, [])
})

test('调试 RPC 不能引用已有附件，文件阅读限定已收到的引用并拒绝二进制内容', async () => {
  const f = nativeStore(); const attached = await admitAssistantAttachments(f.store, [upload])
  const chat = new AssistantTextChat({ async catalog() { return { models: [model], default: model, errors: [] } }, async reply() { assert.fail('不应调用模型') } })
  await assert.rejects(chat.start({ requestId: 'debug', provider: model.provider, model: model.model, generation: 0,
    messages: [{ role: 'user', text: '越权引用', attachments: attached }] }, context.index, () => true, () => '', true), /不接受附件引用/)
  chat.dispose()
  const allowed = new Map<string, AssistantAttachment>(attached.map((item) => [item.attachment.attachmentId, item]))
  const tool = createAssistantAttachmentTool(f.store, allowed)
  const execution = { callId: 'read', signal: new AbortController().signal }
  await assert.rejects(tool.execute({ attachmentId: '其他会话附件' }, execution), /可读范围/)
  const value = await tool.execute({ attachmentId: attached[0]!.attachment.attachmentId }, execution) as any
  assert.equal(value.text, '用户上传内容')
  f.store.readFileStream = async function* () { yield new Uint8Array([0xff, 0xfe, 0x00]) }
  await assert.rejects(tool.execute({ attachmentId: attached[0]!.attachment.attachmentId }, execution), /不是 UTF-8/)
})
