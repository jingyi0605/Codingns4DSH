import assert from 'node:assert/strict'
import test from 'node:test'
import { GlobalVoiceCoordinator } from '../data/build/dist/host/features/global-voice-coordinator.js'
import type { VoicePcmFrame, VoiceRuntimeAdapter, VoiceRuntimeCapabilities, VoiceRuntimeEvent, VoiceRuntimeListener } from '../data/build/dist/shared/contracts/voice-runtime.js'

const capabilities: VoiceRuntimeCapabilities = { realtime: true, wakeWord: true, streamingInput: true, streamingOutput: true, bargeIn: true, speechToText: true, textToSpeech: true }

class FakeRuntime implements VoiceRuntimeAdapter {
  readonly capabilities = capabilities
  readonly frames: Array<{ frame: VoicePcmFrame; epoch: number }> = []
  private readonly listeners = new Set<VoiceRuntimeListener>()
  startCount = 0
  stopCount = 0
  interruptCount = 0
  start(): void { this.startCount += 1 }
  stop(): void { this.stopCount += 1 }
  interrupt(): void { this.interruptCount += 1 }
  sendPcm(frame: VoicePcmFrame, epoch: number): void { this.frames.push({ frame, epoch }) }
  subscribe(listener: VoiceRuntimeListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(event: VoiceRuntimeEvent): void { for (const listener of this.listeners) listener(event) }
}

test('单 Profile 麦克风租约、常开流式帧和唤醒状态', async () => {
  const runtime = new FakeRuntime()
  const finals: string[] = []
  const coordinator = new GlobalVoiceCoordinator({ adapter: runtime, onFinalText: (text) => finals.push(text) })
  await coordinator.start('tab-a')
  assert.equal(coordinator.snapshot().state, 'standby')
  await assert.rejects(() => coordinator.start('tab-b'), /另一个页面/u)
  assert.throws(() => coordinator.assertOwner('tab-b'), /没有全局语音租约/u)
  coordinator.assertOwner('tab-a')
  runtime.emit({ type: 'wake', epoch: coordinator.snapshot().epoch })
  assert.equal(coordinator.snapshot().state, 'listening')
  await coordinator.sendPcm('tab-a', { sequence: 1, bytes: new Uint8Array([1, 2]), sampleRate: 16000, channels: 1 })
  assert.equal(runtime.frames[0]?.epoch, coordinator.snapshot().epoch)
  runtime.emit({ type: 'final', text: '现在进展怎么样', epoch: coordinator.snapshot().epoch })
  assert.deepEqual(finals, ['现在进展怎么样'])
})

test('barge-in 递增 epoch，迟到事件被丢弃并释放租约', async () => {
  const runtime = new FakeRuntime()
  const finals: string[] = []
  const coordinator = new GlobalVoiceCoordinator({ adapter: runtime, onFinalText: (text) => finals.push(text) })
  await coordinator.start('tab-a')
  const oldEpoch = coordinator.snapshot().epoch
  runtime.emit({ type: 'barge-in', epoch: oldEpoch })
  assert.equal(coordinator.snapshot().state, 'interrupted')
  runtime.emit({ type: 'final', text: '旧文本', epoch: oldEpoch })
  assert.deepEqual(finals, [])
  await coordinator.stop('tab-a')
  assert.equal(coordinator.snapshot().state, 'disabled')
  assert.equal(runtime.interruptCount, 0)
  assert.equal(runtime.stopCount, 1)
})

test('运行时停止失败仍释放租约，销毁过程吸收异步停止异常', async () => {
  const runtime = new FakeRuntime()
  runtime.stop = () => Promise.reject(new Error('worker exited'))
  const coordinator = new GlobalVoiceCoordinator({ adapter: runtime })
  await coordinator.start('tab-a')
  await assert.rejects(coordinator.stop('tab-a'), /worker exited/u)
  assert.equal(coordinator.snapshot().state, 'disabled')
  await coordinator.start('tab-b')
  coordinator.dispose()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(coordinator.snapshot().state, 'disabled')
})
