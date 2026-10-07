import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantVoiceStreamHandler } from '../data/build/dist/host/features/assistant-voice-stream.js'
import { GlobalVoiceCoordinator } from '../data/build/dist/host/features/global-voice-coordinator.js'
import type { VoicePcmFrame, VoiceRuntimeAdapter, VoiceRuntimeEvent, VoiceRuntimeListener } from '../data/build/dist/shared/contracts/voice-runtime.js'
import { encodeVoiceStreamMessage, encodeVoiceStreamOpen } from '../data/build/dist/shared/voice-stream.js'

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
