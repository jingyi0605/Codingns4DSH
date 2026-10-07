import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeAssistantVoiceModel } from '../data/build/dist/host/features/voice-model-probe.js'

const paths = { asrEncoder: '/fixture/encoder.onnx', asrDecoder: '/fixture/decoder.onnx', asrJoiner: '/fixture/joiner.onnx', asrTokens: '/fixture/tokens.txt' }
async function fakeModule(t: TestContext, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-model-probe-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const modulePath = join(directory, 'sherpa.mjs')
  await writeFile(modulePath, source)
  return modulePath
}

test('独立进程使用正式识别配置，加载、接受音频、解码并检查返回值', async (t) => {
  const modulePath = await fakeModule(t, `
import assert from 'node:assert/strict';
export class OnlineRecognizer {
  constructor(config) { assert.equal(config.modelConfig.transducer.encoder, '/fixture/encoder.onnx'); assert.equal(config.modelConfig.tokens, '/fixture/tokens.txt'); this.decoded = 0; }
  createStream() { return { acceptWaveform: (frame) => { assert.equal(frame.sampleRate, 16000); assert.equal(frame.samples.length, 32000); }, inputFinished() {} }; }
  isReady() { return this.decoded < 2; }
  decode() { this.decoded += 1; }
  getResult() { assert.equal(this.decoded, 2); return { text: '' }; }
}`)
  await probeAssistantVoiceModel(paths, { modulePath })
})

test('原生进程崩溃或模型加载异常不会终止 Host，并返回真实失败原因', async (t) => {
  const crashed = await fakeModule(t, 'process.exit(19)')
  await assert.rejects(() => probeAssistantVoiceModel(paths, { modulePath: crashed }), /退出（19）/u)
  const failed = await fakeModule(t, "export class OnlineRecognizer { constructor() { throw new Error('无法加载 encoder'); } }")
  await assert.rejects(() => probeAssistantVoiceModel(paths, { modulePath: failed }), /无法加载 encoder/u)
  const invalid = await fakeModule(t, 'export class OnlineRecognizer { constructor(){this.decoded=false} createStream() { return {acceptWaveform(){}, inputFinished(){}} } isReady(){return !this.decoded} decode(){this.decoded=true} getResult(){return {}} }')
  await assert.rejects(() => probeAssistantVoiceModel(paths, { modulePath: invalid }), /有效的识别结果/u)
})

test('验证超时或取消会结束验证进程并释放等待', async (t) => {
  const modulePath = await fakeModule(t, 'await new Promise(() => { setInterval(() => {}, 1000) })')
  await assert.rejects(() => probeAssistantVoiceModel(paths, { modulePath, timeoutMs: 100 }), /超时/u)
  const controller = new AbortController()
  const running = probeAssistantVoiceModel(paths, { modulePath, signal: controller.signal })
  controller.abort()
  await assert.rejects(() => running, /取消/u)
})
