import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, rm, writeFile, readFile, readdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantVoiceModelManager } from '../data/build/dist/host/features/voice-model-management.js'
import { installAssistantVoiceModel, voiceModelRoot } from '../data/build/dist/host/features/voice-model-setup.js'
import { DEFAULT_ASSISTANT_VOICE_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { ASSISTANT_VOICE_MODEL_CATALOG } from '../data/build/dist/shared/voice-models.js'

async function isolate(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-model-management-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }) })
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])))
  return directory
}
const runtime = { running: false, ready: false, operation: null }

test('状态读取不下载：缺失、残留临时文件、下载完成和当前配置分开展示', async (t) => {
  await isolate(t)
  let probes = 0
  const manager = new AssistantVoiceModelManager(async () => { probes += 1 })
  let snapshot = await manager.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)
  assert.ok(snapshot.models.every((model) => model.state === 'missing' && !model.current && model.validation.state === 'unchecked'))
  assert.equal(snapshot.currentModelId, null)
  const installed = await installAssistantVoiceModel(ASSISTANT_VOICE_MODEL_CATALOG[0]!.id)
  await unlink(installed.paths.asrEncoder)
  await writeFile(`${installed.paths.asrEncoder}.part`, 'unfinished')
  snapshot = await manager.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)
  assert.equal(snapshot.models[0]?.state, 'partial')
  assert.equal(snapshot.models[0]?.files.filter((file) => file.present).length, 3)
  assert.equal(snapshot.models[0]?.files[0]?.partialBytes, 10)
  await installAssistantVoiceModel(installed.model.id)
  snapshot = await manager.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)
  assert.equal(snapshot.models[0]?.state, 'downloaded')
  assert.equal(snapshot.models[0]?.totalBytes, 12)
  assert.equal(snapshot.models[0]?.validation.state, 'unchecked')
  assert.equal(probes, 0)
  const configured = { ...DEFAULT_ASSISTANT_VOICE_SETTINGS, provider: 'sherpa-onnx' as const, initialized: true, modelId: installed.model.id, ...installed.paths }
  snapshot = await manager.snapshot(configured, runtime)
  assert.equal(snapshot.models[0]?.current, true)
  assert.equal(snapshot.models[0]?.validation.state, 'unchecked', '设置保存不能冒充原生验证')
})

test('验证记录跨实例保留，文件修改或缺失后旧验证结果立即失效', async (t) => {
  await isolate(t)
  const manager = new AssistantVoiceModelManager(async () => {})
  const installed = await installAssistantVoiceModel(ASSISTANT_VOICE_MODEL_CATALOG[0]!.id)
  await manager.verify(installed.model.id, DEFAULT_ASSISTANT_VOICE_SETTINGS, new AbortController().signal)
  const reopened = new AssistantVoiceModelManager(async () => {})
  assert.equal((await reopened.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)).models[0]?.validation.state, 'passed')
  await writeFile(installed.paths.asrEncoder, new Uint8Array([4, 5, 6]))
  assert.equal((await reopened.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)).models[0]?.validation.state, 'unchecked')
  await reopened.verify(installed.model.id, DEFAULT_ASSISTANT_VOICE_SETTINGS, new AbortController().signal)
  await unlink(installed.paths.asrTokens)
  const missing = (await reopened.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)).models[0]!
  assert.equal(missing.state, 'partial')
  assert.equal(missing.validation.state, 'unchecked')
  await assert.rejects(() => reopened.verify(installed.model.id, DEFAULT_ASSISTANT_VOICE_SETTINGS, new AbortController().signal), /尚未下载完整/u)
})

test('验证失败保存真实原因，修复失败保留旧缓存，修复成功替换整组文件', async (t) => {
  await isolate(t)
  const installed = await installAssistantVoiceModel(ASSISTANT_VOICE_MODEL_CATALOG[0]!.id)
  let failing = true
  const manager = new AssistantVoiceModelManager(async () => { if (failing) throw new Error('ONNX 模型不兼容') })
  await assert.rejects(() => manager.verify(installed.model.id, DEFAULT_ASSISTANT_VOICE_SETTINGS, new AbortController().signal), /ONNX 模型不兼容/u)
  let status = (await manager.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)).models[0]!
  assert.equal(status.validation.state, 'failed')
  assert.match(status.validation.error!, /ONNX 模型不兼容/u)
  failing = false
  await manager.verify(installed.model.id, DEFAULT_ASSISTANT_VOICE_SETTINGS, new AbortController().signal)
  failing = true
  await assert.rejects(() => manager.prepare(installed.model.id, DEFAULT_ASSISTANT_VOICE_SETTINGS, () => {}, new AbortController().signal, true), /ONNX 模型不兼容/u)
  for (const path of Object.values(installed.paths)) assert.deepEqual(await readFile(path), Buffer.from([1, 2, 3]))
  assert.equal((await manager.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)).models[0]?.validation.state, 'passed')
  assert.ok((await readdir(voiceModelRoot())).every((name) => !name.endsWith('.download')))
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([7, 8, 9, 10])))
  failing = false
  const repaired = await manager.prepare(installed.model.id, DEFAULT_ASSISTANT_VOICE_SETTINGS, () => {}, new AbortController().signal, true)
  for (const path of Object.values(repaired.paths)) assert.deepEqual(await readFile(path), Buffer.from([7, 8, 9, 10]))
  status = (await manager.snapshot(DEFAULT_ASSISTANT_VOICE_SETTINGS, runtime)).models[0]!
  assert.equal(status.validation.state, 'passed')
  assert.equal(status.totalBytes, 16)
  assert.deepEqual(await readdir(voiceModelRoot()), [installed.model.id])
})

test('已有自定义文件路径按实际配置检查和复用，不擅自下载或迁移', async (t) => {
  const directory = await isolate(t)
  const installed = await installAssistantVoiceModel(ASSISTANT_VOICE_MODEL_CATALOG[0]!.id)
  const customPaths = { ...installed.paths, asrEncoder: join(directory, 'custom-encoder.onnx') }
  await writeFile(customPaths.asrEncoder, 'custom')
  const configured = { ...DEFAULT_ASSISTANT_VOICE_SETTINGS, provider: 'sherpa-onnx' as const, initialized: true, modelId: installed.model.id, ...customPaths }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('缓存存在时不能下载') })
  const manager = new AssistantVoiceModelManager(async (paths) => { assert.equal(paths.asrEncoder, customPaths.asrEncoder) })
  const prepared = await manager.prepare(installed.model.id, configured, () => {}, new AbortController().signal)
  assert.equal(prepared.downloaded, false)
  assert.equal(prepared.paths.asrEncoder, customPaths.asrEncoder)
  const status = (await manager.snapshot(configured, runtime)).models[0]!
  assert.equal(status.files[0]?.path, customPaths.asrEncoder)
  assert.equal(status.validation.state, 'passed')
})
