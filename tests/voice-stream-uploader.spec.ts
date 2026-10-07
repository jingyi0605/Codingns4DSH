import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceHttpError, VoiceStreamUploader } from '../data/build/dist/client/voice-stream-uploader.js'
import { VoiceStreamDecoder } from '../data/build/dist/shared/voice-stream.js'

test('不支持 ReadableStream 上传的浏览器仍能按顺序上传小批次 PCM', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const uploads: Uint8Array[] = []
  const releases: Array<() => void> = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init?.body instanceof ReadableStream) throw new Error('ReadableStream uploading is not supported')
    assert.equal('duplex' in init, false)
    uploads.push(init.body as Uint8Array)
    await new Promise<void>((resolve) => releases.push(resolve))
    return new Response(null, { status: 204 })
  })
  const errors: Error[] = []
  const uploader = new VoiceStreamUploader({ url: 'https://voice.test/stream?mode=frames', ownerId: 'tab-a', clientId: 'client-a', onError: (error) => errors.push(error) })
  t.after(() => uploader.close())
  const frame = (sequence: number) => ({ sequence, bytes: new Uint8Array([1, 2]), sampleRate: 16_000, channels: 1 as const })
  uploader.enqueue(frame(1), 9)
  t.mock.timers.tick(60)
  assert.equal(uploads.length, 1)
  uploader.enqueue(frame(2), 9)
  t.mock.timers.tick(60)
  assert.equal(uploads.length, 1, '前一个请求完成前不并发发送后续帧')
  releases.shift()!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(60)
  assert.equal(uploads.length, 2)
  for (let index = 0; index < uploads.length; index += 1) {
    const decoder = new VoiceStreamDecoder()
    const messages = decoder.push(uploads[index]!)
    decoder.finish()
    assert.equal(messages[0]?.message.type, 'open')
    const pcm = messages[1]!.message
    assert.equal(pcm.type, 'pcm')
    if (pcm.type === 'pcm') { assert.equal(pcm.sequence, index + 1); assert.equal(pcm.epoch, 9) }
  }
  releases.shift()!()
  assert.deepEqual(errors, [])
})

test('停止会取消在途上传、清理待发送音频，积压不会无限增长', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests += 1
    signal = init.signal
    await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('取消')), { once: true }))
    return new Response(null, { status: 204 })
  })
  const errors: Error[] = []
  const uploader = new VoiceStreamUploader({ url: 'https://voice.test/stream?mode=frames', ownerId: 'tab-a', clientId: 'client-a', onError: (error) => errors.push(error) })
  uploader.enqueue({ sequence: 1, bytes: new Uint8Array([1, 2]), sampleRate: 16_000, channels: 1 }, 4)
  t.mock.timers.tick(60)
  uploader.enqueue({ sequence: 2, bytes: new Uint8Array(161_000), sampleRate: 16_000, channels: 1 }, 4)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /积压/u)
  assert.equal(signal!.aborted, true)
  t.mock.timers.tick(10_000)
  assert.equal(requests, 1)
  uploader.close()
})

test('上传失败只报告一次并停止发送，不悄悄回退到其他转写服务', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests += 1; return new Response(null, { status: 403 }) })
  const errors: Error[] = []
  const uploader = new VoiceStreamUploader({ url: 'https://voice.test/stream?mode=frames', ownerId: 'tab-a', clientId: 'client-a', onError: (error) => errors.push(error) })
  const frame = { sequence: 1, bytes: new Uint8Array([1, 2]), sampleRate: 16_000, channels: 1 as const }
  uploader.enqueue(frame, 4)
  t.mock.timers.tick(60)
  await new Promise<void>((resolve) => setImmediate(resolve))
  uploader.enqueue(frame, 4)
  t.mock.timers.tick(60)
  assert.equal(requests, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /403/u)
})

test('HTTP 错误保留 Host 的具体原因，空正文和非 JSON 正文仍显示状态码', async () => {
  const denied = await createVoiceHttpError(Response.json({ error: '当前页面没有全局语音租约' }, { status: 403 }), '语音流连接失败')
  assert.equal(denied.message, '语音流连接失败（HTTP 403）：当前页面没有全局语音租约')
  for (const body of [null, '<html>Bad Request</html>']) {
    const failed = await createVoiceHttpError(new Response(body, { status: 400 }), '语音流连接失败')
    assert.equal(failed.message, '语音流连接失败（HTTP 400）')
  }
})

test('四秒瞬时积压不被 JSON 首部提前判死，恢复后保留全部音频并立即续传', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const uploads: Uint8Array[] = []
  const releases: Array<() => void> = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    uploads.push(init.body as Uint8Array)
    await new Promise<void>((resolve) => releases.push(resolve))
    return new Response(null, { status: 204 })
  })
  const errors: Error[] = []
  const traces: Array<{ event: string; fields: any }> = []
  const uploader = new VoiceStreamUploader({ url: 'https://voice.test/stream?mode=frames', ownerId: 'tab-a', clientId: 'client-a', onError: (error) => errors.push(error), trace: (event, fields) => traces.push({ event, fields }) })
  t.after(() => { uploader.close(); for (const release of releases) release() })
  uploader.enqueue({ sequence: 1, bytes: new Uint8Array(256), sampleRate: 16_000, channels: 1 }, 4)
  now = 60; t.mock.timers.tick(60)
  const expected = new Uint8Array(500 * 256)
  for (let index = 0; index < 500; index++) {
    const bytes = new Uint8Array(256).fill(index % 256)
    expected.set(bytes, index * 256)
    uploader.enqueue({ sequence: index + 2, bytes, sampleRate: 16_000, channels: 1 }, 4)
    now += 8; t.mock.timers.tick(8)
  }
  assert.equal(uploads.length, 1); assert.deepEqual(errors, [])
  releases.shift()!(); await new Promise<void>((resolve) => setImmediate(resolve))
  t.mock.timers.tick(0)
  assert.equal(uploads.length, 2, '已经积压的音频不用额外再等 60 ms')
  const decoder = new VoiceStreamDecoder()
  const frames = decoder.push(uploads[1]!).filter((item) => item.message.type === 'pcm')
  decoder.finish()
  assert.equal(frames.length, 100, '五个 8 ms 小帧共用一个首部')
  const pcm = new Uint8Array(expected.length)
  let offset = 0
  for (const item of frames) { pcm.set(item.pcm!, offset); offset += item.pcm!.length }
  assert.deepEqual(pcm, expected)
  assert.ok(uploads[1]!.length < 145_000)
  assert.ok(traces.some((item) => item.event === 'client.upload.pressure'))
  const start = traces.filter((item) => item.event === 'client.upload.start').at(-1)!
  assert.equal(start.fields.audioMs, 4000); assert.equal(start.fields.count, 500)
  releases.shift()!(); await new Promise<void>((resolve) => setImmediate(resolve))
})

test('合并不会跨越代次、采样率和不连续序号', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let body: Uint8Array | undefined
  t.mock.method(globalThis, 'fetch', async (_url, init) => { body = init.body as Uint8Array; return new Response(null, { status: 204 }) })
  const uploader = new VoiceStreamUploader({ url: 'https://voice.test/stream?mode=frames', ownerId: 'tab-a', clientId: 'client-a', onError: assert.fail })
  t.after(() => uploader.close())
  for (const [sequence, epoch, sampleRate] of [[1, 1, 16000], [2, 1, 16000], [3, 2, 16000], [4, 2, 8000], [6, 2, 8000]]) uploader.enqueue({ sequence: sequence!, bytes: new Uint8Array([sequence!, 0]), sampleRate: sampleRate!, channels: 1 }, epoch!)
  t.mock.timers.tick(60)
  const decoder = new VoiceStreamDecoder()
  const frames = decoder.push(body!).filter((item) => item.message.type === 'pcm')
  decoder.finish()
  assert.deepEqual(frames.map((item) => item.message.type === 'pcm' ? [item.message.sequence, item.message.epoch, item.message.sampleRate, [...item.pcm!]] : []), [[2, 1, 16000, [1, 0, 2, 0]], [3, 2, 16000, [3, 0]], [4, 2, 8000, [4, 0]], [6, 2, 8000, [6, 0]]])
})

test('真实超时仍有界停止，日志保留原因码、在途 ID 与等待时长', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal
    return await new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('取消')), { once: true }))
  })
  const errors: Error[] = []
  const traces: Array<{ event: string; fields: any }> = []
  const uploader = new VoiceStreamUploader({ url: 'https://voice.test/stream?mode=frames', ownerId: 'tab-a', clientId: 'client-a', onError: (error) => errors.push(error), trace: (event, fields) => traces.push({ event, fields }) })
  t.after(() => uploader.close())
  uploader.enqueue({ sequence: 1, bytes: new Uint8Array(256), sampleRate: 16_000, channels: 1 }, 4)
  now = 60; t.mock.timers.tick(60)
  now = 5060; t.mock.timers.tick(5000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(errors.length, 1); assert.equal(signal!.aborted, true)
  const error = traces.find((item) => item.event === 'client.upload.error')!
  assert.equal(error.fields.code, 'upload_timeout'); assert.equal(error.fields.inFlightMs, 5000)
  assert.equal(error.fields.diagnosticId, traces.find((item) => item.event === 'client.upload.start')!.fields.diagnosticId)
})
