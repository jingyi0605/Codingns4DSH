import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeVoiceStreamMessage, encodeVoiceStreamOpen, VoiceStreamDecoder } from '../data/build/dist/shared/voice-stream.js'

test('语音 PCM 流解码器能处理 JSON 行和二进制帧的任意分片', () => {
  const open = encodeVoiceStreamOpen({ ownerId: 'tab-a', clientId: 'client-a', sampleRate: 16_000, channels: 1, encoding: 'pcm16le' })
  const pcm = new Uint8Array([1, 2, 3, 4])
  const frame = encodeVoiceStreamMessage({ type: 'pcm', sequence: 7, sampleRate: 16_000, channels: 1, epoch: 3, byteLength: pcm.length })
  const decoder = new VoiceStreamDecoder()
  const combined = new Uint8Array(open.length + frame.length + pcm.length)
  combined.set(open)
  combined.set(frame, open.length)
  combined.set(pcm, open.length + frame.length)
  const result = [] as ReturnType<VoiceStreamDecoder['push']>
  for (let index = 0; index < combined.length; index += 3) result.push(...decoder.push(combined.slice(index, Math.min(index + 3, combined.length))))
  assert.equal(result.length, 2)
  assert.equal(result[0]?.message.type, 'open')
  assert.equal(result[1]?.message.type, 'pcm')
  assert.deepEqual([...result[1]?.pcm ?? []], [...pcm])
})

test('语音 PCM 流拒绝超大或不完整帧', () => {
  const decoder = new VoiceStreamDecoder()
  assert.throws(() => decoder.push(new TextEncoder().encode('{"type":"pcm","sequence":0,"sampleRate":16000,"channels":1,"epoch":0,"byteLength":1048577}\n')), /无效/u)
})
