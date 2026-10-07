import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantVoiceStreamHandler } from '../data/build/dist/host/features/assistant-voice-stream.js'
import { GlobalVoiceCoordinator } from '../data/build/dist/host/features/global-voice-coordinator.js'
import type { VoicePcmFrame, VoiceRuntimeAdapter, VoiceRuntimeEvent, VoiceRuntimeListener } from '../data/build/dist/shared/contracts/voice-runtime.js'
import { encodeVoiceStreamMessage, encodeVoiceStreamOpen } from '../data/build/dist/shared/voice-stream.js'
import { AssistantTextChat } from '../src/host/features/assistant-text-chat.js'
import { AssistantVoiceChat } from '../src/host/features/assistant-voice-chat.js'
import type { AssistantIndexSnapshot } from '../src/shared/contracts/assistant.js'

class FakeRuntime implements VoiceRuntimeAdapter {
  readonly capabilities = { realtime: true, streamingInput: true, streamingOutput: false, wakeWord: false, bargeIn: true, speechToText: true, textToSpeech: false }
  readonly frames: VoicePcmFrame[] = []
  private listeners = new Set<VoiceRuntimeListener>()
  startCount = 0
  start(): void { this.startCount += 1 }
  stop(): void {}
  interrupt(): void {}
  subscribe(listener: VoiceRuntimeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  sendPcm(frame: VoicePcmFrame, epoch: number): void { this.frames.push(frame); this.emit({ type: 'partial', text: `实时文字${frame.sequence}`, epoch }) }
  emit(event: VoiceRuntimeEvent): void { for (const listener of this.listeners) listener(event) }
}

function batch(ownerId: string, epoch: number, sequence: number): Uint8Array {
  const parts = [
    encodeVoiceStreamOpen({ ownerId, clientId: 'client-a', sampleRate: 16_000, channels: 1, encoding: 'pcm16le' }),
    encodeVoiceStreamMessage({ type: 'pcm', sequence, sampleRate: 16_000, channels: 1, epoch, byteLength: 4 }),
    new Uint8Array([0, 1, 2, 3]),
  ]
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return bytes
}

test('现有下行连接立即推送累计模型文字和结算，过滤非本页对话并释放订阅', async (t) => {
  const model = { provider: 'fixture', model: 'fixture', label: '测试' }
  const index: AssistantIndexSnapshot = { generation: 1, scope: { status: 'ready', managedWorkspaceIds: ['w'] }, unreadableCount: 0, entries: [] }
  const updates = new Map<string, (text: string) => void>()
  let finish!: (text: string) => void
  const engine = new AssistantTextChat({ catalog: async () => ({ models: [model], default: model, errors: [] }),
    reply: async (_model, _system, messages, _signal, update) => {
      updates.set(messages.at(-1)!.text, update)
      return new Promise<string>((resolve) => { finish = resolve })
    } })
  const chat = new AssistantVoiceChat(engine)
  const coordinator = new GlobalVoiceCoordinator({ adapter: new FakeRuntime() })
  t.after(() => { chat.clear(); engine.dispose(); coordinator.dispose() })
  let subscriptions = 0
  const subscribe = chat.subscribe.bind(chat)
  t.mock.method(chat, 'subscribe', (ownerId, listener) => { subscriptions++; const dispose = subscribe(ownerId, listener); return () => { subscriptions--; dispose() } })
  const lease = await coordinator.start('page')
  const handler = createAssistantVoiceStreamHandler({ coordinator, chat })
  assert.equal((await handler(new Request('https://voice.test/events?ownerId=other'))).status, 403)
  assert.equal(subscriptions, 0)
  const response = await handler(new Request('https://voice.test/events?ownerId=page'))
  assert.equal(response.headers.get('x-codingns-voice-chat-stream'), '1')
  const reader = response.body!.getReader()
  const read = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value))
  assert.equal((await read()).type, 'state')
  await engine.start({ requestId: 'private', ...model, generation: 1, messages: [{ role: 'user', text: '其他窗口' }] }, index)
  updates.get('其他窗口')!('不属于语音页面的内容')
  await chat.start('page', lease.epoch, 'voice', '本页问题', { index, ...model, prompt: '', isCurrent: () => true, createSystem: () => '' })
  updates.get('本页问题')!('第一句。')
  assert.deepEqual((await read()).run.text, '第一句。')
  updates.get('本页问题')!('第一句。第二句。')
  assert.equal((await read()).run.text, '第一句。第二句。')
  finish('第一句。第二句。完整结尾。')
  await chat.wait('page', lease.epoch, 'voice')
  const completed = await read()
  assert.equal(completed.run.state, 'completed'); assert.equal(completed.run.text, '第一句。第二句。完整结尾。')
  await reader.cancel()
  assert.equal(subscriptions, 0)
})

test('慢下行只保留最新累计回复，结算与前文不丢失，工具明细不重复传输', async (t) => {
  const coordinator = new GlobalVoiceCoordinator({ adapter: new FakeRuntime() })
  t.after(() => coordinator.dispose())
  const lease = await coordinator.start('page')
  let publish!: (run: any, epoch: number) => void
  const chat = { subscribe: (_owner: string, listener: typeof publish) => { publish = listener; return () => {} } } as unknown as AssistantVoiceChat
  const response = await createAssistantVoiceStreamHandler({ coordinator, chat })(new Request('https://voice.test/events?ownerId=page'))
  for (let count = 1; count <= 50; count++) publish({ requestId: 'voice', state: 'running', text: '完整前文。'.repeat(count), toolCalls: [{ result: '不应重复传输' }] }, lease.epoch)
  publish({ requestId: 'voice', state: 'completed', text: '完整前文。'.repeat(50) + '最后一句。' }, lease.epoch)
  const reader = response.body!.getReader()
  t.after(() => reader.cancel())
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'state')
  const value = JSON.parse(new TextDecoder().decode((await reader.read()).value))
  assert.equal(value.run.state, 'completed')
  assert.equal(value.run.text, '完整前文。'.repeat(50) + '最后一句。')
  assert.equal(value.run.toolCalls, undefined)
})

test('有限 PCM 上传保持同一个识别器，GET 在停止录音前收到 partial/final', async (t) => {
  const runtime = new FakeRuntime()
  const coordinator = new GlobalVoiceCoordinator({ adapter: runtime })
  t.after(() => coordinator.dispose())
  const lease = await coordinator.start('tab-a')
  const handler = createAssistantVoiceStreamHandler({ coordinator })
  const events = await handler(new Request('https://voice.test/api/codingns/assistant/voice/stream?ownerId=tab-a'))
  assert.equal(events.headers.get('x-accel-buffering'), 'no')
  const reader = events.body!.getReader()
  t.after(() => reader.cancel())
  const readEvent = async (): Promise<VoiceRuntimeEvent> => JSON.parse(new TextDecoder().decode((await reader.read()).value))
  assert.equal((await readEvent()).type, 'state')
  for (const sequence of [1, 2]) {
    const response = await handler(new Request('https://voice.test/api/codingns/assistant/voice/stream?mode=frames', { method: 'POST', body: batch('tab-a', lease.epoch, sequence) }))
    assert.equal(response.status, 204)
    assert.deepEqual(await readEvent(), { type: 'partial', text: `实时文字${sequence}`, epoch: lease.epoch })
  }
  runtime.emit({ type: 'final', text: '测试实时对话', epoch: lease.epoch })
  assert.equal((await readEvent()).type, 'final')
  assert.equal(runtime.startCount, 1)
  assert.equal(runtime.frames.length, 2)
  await coordinator.stop('tab-a')
  assert.deepEqual(await readEvent(), { type: 'state', state: 'disabled', epoch: lease.epoch + 1 })
  assert.equal((await reader.read()).done, true)
})

test('错误 owner、过期 epoch、截断 PCM 和超大批次不能进入识别器', async (t) => {
  const runtime = new FakeRuntime()
  const coordinator = new GlobalVoiceCoordinator({ adapter: runtime })
  t.after(() => coordinator.dispose())
  const lease = await coordinator.start('tab-a')
  const handler = createAssistantVoiceStreamHandler({ coordinator })
  const post = (body: Uint8Array) => handler(new Request('https://voice.test/stream?mode=frames', { method: 'POST', body }))
  assert.equal((await handler(new Request('https://voice.test/stream?ownerId=tab-b'))).status, 403)
  assert.equal((await post(batch('tab-b', lease.epoch, 1))).status, 403)
  assert.equal((await post(batch('tab-a', lease.epoch - 1, 2))).status, 204)
  assert.equal((await post(batch('tab-a', lease.epoch, 3).slice(0, -1))).status, 400)
  assert.equal((await post(new Uint8Array(256 * 1024 + 1))).status, 413)
  assert.equal(runtime.frames.length, 0)
})

test('事件连接取消后释放订阅，重复状态不产生下行回声', async (t) => {
  const coordinator = new GlobalVoiceCoordinator({ adapter: new FakeRuntime() })
  t.after(() => coordinator.dispose())
  const lease = await coordinator.start('tab-a')
  let subscriptions = 0
  const originalSubscribe = coordinator.subscribe.bind(coordinator)
  const originalEvents = coordinator.subscribeRuntimeEvent.bind(coordinator)
  t.mock.method(coordinator, 'subscribe', (listener) => { subscriptions += 1; const dispose = originalSubscribe(listener); return () => { subscriptions -= 1; dispose() } })
  t.mock.method(coordinator, 'subscribeRuntimeEvent', (listener) => { subscriptions += 1; const dispose = originalEvents(listener); return () => { subscriptions -= 1; dispose() } })
  const handler = createAssistantVoiceStreamHandler({ coordinator })
  const events = await handler(new Request('https://voice.test/stream?ownerId=tab-a'))
  const reader = events.body!.getReader()
  await reader.read()
  assert.equal(subscriptions, 2)
  coordinator.acceptClientEvent('tab-a', { type: 'state', state: 'standby', epoch: lease.epoch })
  await coordinator.interrupt('tab-a')
  const state = JSON.parse(new TextDecoder().decode((await reader.read()).value))
  assert.equal(state.state, 'interrupted')
  await reader.cancel()
  assert.equal(subscriptions, 0)
})

test('识别积压批次在帧间让出事件循环，不让同步解码连续饿死其他请求', async (t) => {
  const runtime = new FakeRuntime()
  const coordinator = new GlobalVoiceCoordinator({ adapter: runtime })
  t.after(() => coordinator.dispose())
  const lease = await coordinator.start('tab-a')
  let clock = 0
  t.mock.method(performance, 'now', () => { clock += 11; return clock })
  const first = batch('tab-a', lease.epoch, 1)
  const second = batch('tab-a', lease.epoch, 2)
  // 后一份去掉 open 首部，组成同一个合法上传批次。
  const boundary = second.indexOf(10) + 1
  const body = new Uint8Array(first.length + second.length - boundary)
  body.set(first); body.set(second.subarray(boundary), first.length)
  let processedWhenOtherTaskRan = -1
  const otherTask = new Promise<void>((resolve) => setImmediate(() => { processedWhenOtherTaskRan = runtime.frames.length; resolve() }))
  const handler = createAssistantVoiceStreamHandler({ coordinator })
  const response = await handler(new Request('https://voice.test/stream?mode=frames', { method: 'POST', body }))
  await otherTask
  assert.equal(response.status, 204)
  assert.equal(runtime.frames.length, 2)
  assert.equal(processedWhenOtherTaskRan, 1, '识别完第一帧后允许其他事件循环任务执行')
})
