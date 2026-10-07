import assert from 'node:assert/strict'
import test from 'node:test'
import { SherpaVoiceRuntime, float32ToPcm16, pcm16ToFloat32 } from '../data/build/dist/host/features/sherpa-voice-runtime.js'
import type { VoiceRuntimeEvent } from '../src/shared/contracts/voice-runtime.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('0.8 秒句尾规则保留短暂停顿，允许恢复 1.2 秒，无效设置回退保守默认值', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-endpoint-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const tokens = join(directory, 'tokens.txt')
  await writeFile(tokens, '会 0\n话 1\n')
  const create = async (seconds?: string) => {
    const runtime = new SherpaVoiceRuntime({ packageName: new URL('./fixtures/sherpa-endpoint.mjs', import.meta.url).href,
      env: { CODINGNS4DSH_VOICE_ASR_ENCODER: 'encoder', CODINGNS4DSH_VOICE_ASR_DECODER: 'decoder', CODINGNS4DSH_VOICE_ASR_JOINER: 'joiner', CODINGNS4DSH_VOICE_ASR_TOKENS: tokens, CODINGNS4DSH_VOICE_ENDPOINT_SILENCE_SECONDS: seconds } })
    t.after(() => runtime.stop())
    const events: VoiceRuntimeEvent[] = []; runtime.subscribe((event) => events.push(event))
    await runtime.start()
    let sequence = 0
    const send = (duration: number, speech = false) => {
      const samples = new Float32Array(Math.round(duration * 16000)); if (speech) samples.fill(0.2)
      runtime.sendPcm({ sequence: ++sequence, bytes: float32ToPcm16(samples), sampleRate: 16000, channels: 1 }, 0)
    }
    return { send, finals: () => events.filter((event) => event.type === 'final') }
  }
  for (const seconds of [undefined, 'invalid', '0.1']) {
    const f = await create(seconds)
    f.send(0.2, true); f.send(0.65)
    assert.equal(f.finals().length, 0, '650 ms 短停顿不能提前截断')
    f.send(0.1, true); f.send(0.81)
    assert.equal(f.finals().length, 1)
  }
  const previous = await create('1.2')
  previous.send(0.2, true); previous.send(0.85)
  assert.equal(previous.finals().length, 0)
  previous.send(0.36); assert.equal(previous.finals().length, 1)
})

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
