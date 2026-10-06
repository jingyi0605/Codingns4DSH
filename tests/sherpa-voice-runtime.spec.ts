import assert from 'node:assert/strict'
import test from 'node:test'
import { SherpaVoiceRuntime, float32ToPcm16, pcm16ToFloat32 } from '../data/build/dist/host/features/sherpa-voice-runtime.js'

test('Sherpa PCM 转换保持单声道 PCM16 的边界', () => {
  const bytes = float32ToPcm16(new Float32Array([-1, -0.5, 0, 0.5, 1]))
  const samples = pcm16ToFloat32(bytes)
  assert.equal(samples.length, 5)
  assert.ok((samples[0] ?? 0) <= -0.99)
  assert.ok(Math.abs(samples[2] ?? 1) < 0.001)
  assert.ok((samples[4] ?? 0) >= 0.99)
})

test('Sherpa 未加载模型前不伪造实时能力', () => {
  const runtime = new SherpaVoiceRuntime({ env: {}, packageName: 'missing-sherpa-package-for-test' })
  assert.equal(runtime.capabilities.realtime, false)
  assert.equal(runtime.capabilities.speechToText, false)
  assert.equal(runtime.capabilities.streamingOutput, false)
})
