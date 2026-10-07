import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientVoiceCapture } from '../src/client/voice-capture.js'
import type { VoicePcmFrame } from '../src/shared/contracts/voice-runtime.js'
import type { BrowserVoiceDeviceManager } from '../src/client/voice-device-manager.js'

test('麦克风静音关闭轨道并持续发送零 PCM，取消静音恢复音频且保持序号', async (t) => {
  const saved = new Map(['navigator', 'AudioContext'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  const track = { enabled: true, addEventListener() {}, removeEventListener() {}, stop() {} }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  const processor = { connect() {}, disconnect() {}, onaudioprocess: undefined as ((event: any) => void) | undefined }
  class Audio {
    state = 'running'; sampleRate = 16000; destination = {}
    async resume() {} async close() { this.state = 'closed' }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createScriptProcessor() { return processor }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Audio })
  const frames: VoicePcmFrame[] = []
  const capture = new ClientVoiceCapture({ devices: { requestInputPermission: async () => ({ selectedInputId: null }) } as unknown as BrowserVoiceDeviceManager,
    onFrame: (frame) => { frames.push(frame) } })
  t.after(() => capture.stop())
  await capture.start()
  const sample = () => processor.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5]) } })
  sample(); capture.setMuted(true); assert.equal(track.enabled, false)
  sample(); capture.setMuted(false); assert.equal(track.enabled, true); sample()
  assert.deepEqual(frames.map((frame) => frame.sequence), [1, 2, 3])
  assert.deepEqual([...frames[1]!.bytes], [0, 0, 0, 0])
  assert.deepEqual(frames[0]!.bytes, frames[2]!.bytes)
  assert.notDeepEqual(frames[0]!.bytes, frames[1]!.bytes)
})
