import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_ASSISTANT_TTS_PARAMETERS, MOSS_BUILTIN_VOICES, readAssistantTtsParameters, readAssistantTtsSettings, validateAssistantTtsParameters } from '../src/shared/assistant-tts.js'
import { resolveAssistantVoiceSource, sourceVoice } from '../src/host/features/assistant-voice-sources.js'

test('内置 18 个官方音色具有稳定 ID、名称、语言与性别；旧设置兼容浏览器输出', () => {
  assert.equal(MOSS_BUILTIN_VOICES.length, 18)
  assert.equal(new Set(MOSS_BUILTIN_VOICES.map((voice) => voice.id)).size, 18)
  assert.deepEqual(['zh', 'en', 'ja'].map((language) => MOSS_BUILTIN_VOICES.filter((voice) => voice.language === language).length), [6, 5, 7])
  assert.equal(MOSS_BUILTIN_VOICES.filter((voice) => voice.language === 'zh' && voice.gender === 'female').length, 3)
  assert.equal(readAssistantTtsSettings().backend, 'browser')
  assert.equal(readAssistantTtsSettings({ backend: 'moss-onnx', selectedId: 'missing', voices: [] }).selectedId, 'moss:Junhao')
})

test('Kyutai 的 ID、hf URL、网页文件链接和下载链接定位相同的参考录音', () => {
  const inputs = ['kyutai:voice-donations/0a67.wav', 'voice-donations/0a67.wav', 'hf://kyutai/tts-voices/voice-donations/0a67.wav',
    'https://huggingface.co/kyutai/tts-voices/blob/main/voice-donations/0a67.wav', 'https://huggingface.co/kyutai/tts-voices/resolve/main/voice-donations/0a67.wav?download=true']
  const references = inputs.map(resolveAssistantVoiceSource)
  assert.equal(new Set(references.map((voice) => voice.id)).size, 1)
  assert.equal(references[0]!.license, 'CC0-1.0')
  assert.equal(resolveAssistantVoiceSource('vctk/p225_023.wav').license, 'CC-BY-4.0')
  assert.equal(resolveAssistantVoiceSource('cml-tts/fr/example.wav').language, 'fr')
})

test('中文完整录音 ID 可直接导入；未知网站、网页目录、非商用目录和嵌入文件被拒绝', () => {
  const voice = resolveAssistantVoiceSource('aishell:SSB00050001')
  assert.equal(voice.url, 'https://huggingface.co/datasets/AISHELL/AISHELL-3/resolve/main/train/wav/SSB0005/SSB00050001.wav')
  assert.equal(voice.id, resolveAssistantVoiceSource(voice.url).id)
  assert.equal(voice.language, 'zh'); assert.equal(voice.license, 'Apache-2.0')
  const custom = sourceVoice(voice, { name: '清晰女声', gender: 'female' })
  assert.equal(custom.name, '清晰女声'); assert.equal(custom.gender, 'female'); assert.equal(custom.reference, voice.id)
  for (const invalid of ['https://fish.audio/m/voice', 'https://localhost/sample.wav', 'https://huggingface.co/kyutai/tts-voices',
    'https://huggingface.co/kyutai/tts-voices/tree/main/vctk', 'ears/p003.wav', 'expresso/example.wav',
    'unmute-prod-website/degaulle-2.wav', 'vctk/p225.wav.safetensors', 'vctk/../example.wav', 'aishell:SSB0005',
    'https://huggingface.co/kyutai/tts-voices/blob/main/vctk/%2e%2e%2foutside.wav']) assert.throws(() => resolveAssistantVoiceSource(invalid), undefined, invalid)
})

test('旧参数补默认值，错误写入和试听参数严格拒绝，固定零种子不被当作缺省', () => {
  assert.deepEqual(readAssistantTtsSettings().parameters, DEFAULT_ASSISTANT_TTS_PARAMETERS)
  assert.equal(validateAssistantTtsParameters({ seed: 0 }).seed, 0)
  assert.equal(validateAssistantTtsParameters({ seed: null }, { seed: 42 }).seed, null)
  assert.equal(validateAssistantTtsParameters({ volume: 0.2 }, { rate: 1.5 }).rate, 1.5)
  assert.deepEqual(readAssistantTtsParameters({ rate: NaN, volume: Infinity, chunkTokens: 29, seed: -1 }), DEFAULT_ASSISTANT_TTS_PARAMETERS)
  for (const invalid of [null, [], { rate: 0 }, { rate: 2.1 }, { volume: -1 }, { volume: 1.01 }, { chunkTokens: 45.5 }, { segmentPauseMs: 2001 }, { seed: 4294967296 }, { seed: true }, { temperature: 0.8 }]) {
    assert.throws(() => validateAssistantTtsParameters(invalid), /播报参数/u)
  }
})
