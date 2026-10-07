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
  uploader.enqueue({ sequence: 2, bytes: new Uint8Array(129 * 1024), sampleRate: 16_000, channels: 1 }, 4)
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
