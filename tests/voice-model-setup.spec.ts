import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSISTANT_VOICE_MODEL_CATALOG, DEFAULT_VOICE_MODEL_ID, findAssistantVoiceModel, type AssistantVoiceModelProgress } from '../data/build/dist/shared/voice-models.js'
import { installAssistantVoiceModel } from '../data/build/dist/host/features/voice-model-setup.js'

test('中文 Zipformer Large 是默认模型，中英双语和轻量模型仍可显式选择', () => {
  assert.equal(DEFAULT_VOICE_MODEL_ID, 'sherpa-onnx-streaming-zh-large-2025-06-30')
  assert.equal(ASSISTANT_VOICE_MODEL_CATALOG[0]!.id, DEFAULT_VOICE_MODEL_ID)
  assert.ok(findAssistantVoiceModel('sherpa-onnx-streaming-zh-14m'))
  assert.ok(findAssistantVoiceModel('sherpa-onnx-streaming-zh-large-2025-06-30'))
})

test('Large 下载保留正确的混合精度文件名，重复初始化复用缓存', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-model-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }) })
  const urls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => { urls.push(url); return new Response(new Uint8Array([1, 2, 3])) })
  const model = findAssistantVoiceModel('sherpa-onnx-streaming-zh-large-2025-06-30')!
  assert.equal(model.id, 'sherpa-onnx-streaming-zh-large-2025-06-30')
  const installed = await installAssistantVoiceModel(model.id)
  assert.equal(installed.downloaded, true)
  assert.deepEqual(urls.map((url) => new URL(url).pathname.split('/').at(-1)), ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt'])
  for (const path of Object.values(installed.paths)) assert.deepEqual(await readFile(path), Buffer.from([1, 2, 3]))
  assert.equal((await installAssistantVoiceModel(model.id)).downloaded, false)
  assert.equal(urls.length, 4)
  assert.ok(findAssistantVoiceModel('sherpa-onnx-streaming-zh-14m'), '旧模型 ID 继续兼容')
  await assert.rejects(() => installAssistantVoiceModel('../../arbitrary-model'), /不支持/u)
})

test('复用缓存只检查文件，不显示虚假的下载进度', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-cached-progress-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }) })
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])))
  const modelId = ASSISTANT_VOICE_MODEL_CATALOG[0]!.id
  await installAssistantVoiceModel(modelId)
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('缓存存在时不应下载') })
  const updates: AssistantVoiceModelProgress[] = []
  assert.equal((await installAssistantVoiceModel(modelId, (progress) => updates.push(progress))).downloaded, false)
  assert.ok(updates.every((progress) => progress.phase !== 'downloading'))
  assert.equal(updates[0]?.phase, 'checking')
  assert.equal(updates.at(-1)?.phase, 'initializing')
})

test('进度按实际写入字节更新，文件切换重置下载量，安装完成进入初始化阶段', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-progress-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }) })
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2]))
    controller.enqueue(new Uint8Array([3, 4, 5, 6]))
    controller.close()
  } }), { headers: { 'content-length': '6' } }))
  const updates: AssistantVoiceModelProgress[] = []
  const installed = await installAssistantVoiceModel(ASSISTANT_VOICE_MODEL_CATALOG[0]!.id, (progress) => updates.push(progress))
  for (const [index, file] of installed.model.files.entries()) {
    const downloaded = updates.filter((progress) => progress.phase === 'downloading' && progress.fileName === file.name)
    assert.deepEqual(downloaded.map((progress) => progress.downloadedBytes), [0, 2, 6, 6])
    assert.ok(downloaded.every((progress) => progress.totalBytes === 6 && progress.fileIndex === index + 1 && progress.fileCount === 4))
    assert.deepEqual(await readFile(installed.paths[file.setting]), Buffer.from([1, 2, 3, 4, 5, 6]))
  }
  assert.equal(updates[0]?.phase, 'checking')
  assert.equal(updates.at(-1)?.phase, 'initializing')
})

test('缺少或压缩的文件大小保持未知，文件写完后才确认最终大小', async (t) => {
  for (const headers of [{}, { 'content-length': '99', 'content-encoding': 'gzip' }]) {
    await t.test(JSON.stringify(headers), async (subtest) => {
      const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-unknown-size-'))
      const previous = process.env.DSH_HOME
      process.env.DSH_HOME = directory
      subtest.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }) })
      subtest.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3]), { headers }))
      const updates: AssistantVoiceModelProgress[] = []
      await installAssistantVoiceModel(ASSISTANT_VOICE_MODEL_CATALOG[0]!.id, (progress) => updates.push(progress))
      const firstFile = updates.filter((progress) => progress.phase === 'downloading' && progress.fileIndex === 1)
      assert.deepEqual(firstFile.map((progress) => [progress.downloadedBytes, progress.totalBytes]), [[0, null], [3, null], [3, 3]])
    })
  }
})

test('下载中断不进入初始化阶段，清理临时文件后可以重试', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-download-failed-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }) })
  let failed = true
  t.mock.method(globalThis, 'fetch', async () => failed ? new Response(new ReadableStream({ pull(controller) {
    controller.error(new Error('连接中断'))
  } })) : new Response(new Uint8Array([1, 2, 3])))
  const model = ASSISTANT_VOICE_MODEL_CATALOG[0]!
  const updates: AssistantVoiceModelProgress[] = []
  await assert.rejects(() => installAssistantVoiceModel(model.id, (progress) => updates.push(progress)), /连接中断/u)
  assert.ok(updates.every((progress) => progress.phase !== 'initializing'))
  const target = join(directory, 'codingns4dsh', 'voice-models', model.id, model.files[0]!.name)
  await assert.rejects(() => stat(target), { code: 'ENOENT' })
  await assert.rejects(() => stat(`${target}.part`), { code: 'ENOENT' })
  failed = false
  assert.equal((await installAssistantVoiceModel(model.id)).downloaded, true)
})

test('空正文或响应大小不匹配不能成为可复用的完整缓存', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-voice-invalid-download-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }) })
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '9' } }))
  const model = ASSISTANT_VOICE_MODEL_CATALOG[0]!
  await assert.rejects(() => installAssistantVoiceModel(model.id), /下载不完整/u)
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array()))
  await assert.rejects(() => installAssistantVoiceModel(model.id), /下载不完整/u)
  const target = join(directory, 'codingns4dsh', 'voice-models', model.id, model.files[0]!.name)
  await assert.rejects(() => stat(target), { code: 'ENOENT' })
  await assert.rejects(() => stat(`${target}.part`), { code: 'ENOENT' })
})
