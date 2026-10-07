import assert from 'node:assert/strict'
import test from 'node:test'
import { MossVoiceOutput, decodeMossPcm } from '../src/client/moss-voice-output.js'

function audio(autoFinish = true) {
  let started = 0; let stopped = 0
  const rates: number[] = []; const starts: number[] = []
  const sources: { onended: (() => void) | undefined }[] = []
  const gain = { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }
  const context = { state: 'running', currentTime: 0, destination: {},
    createGain: () => gain,
    createBuffer: (_channels: number, count: number, rate: number) => ({ duration: count / rate, copyToChannel: () => {} }),
    createBufferSource: () => {
      const source = { buffer: undefined, playbackRate: { value: 1 }, connect: () => {}, disconnect: () => {}, onended: undefined as (() => void) | undefined,
        start: (time: number) => { started++; rates.push(source.playbackRate.value); starts.push(time); if (autoFinish) setImmediate(() => source.onended?.()) }, stop: () => { stopped++ } }
      sources.push(source)
      return source
    }, close: async () => {} }
  return { context: context as unknown as AudioContext, gain, rates, starts, sources, started: () => started, stopped: () => stopped }
}
const chunk = { type: 'audio', data: Buffer.from([0, 0, 255, 127, 0, 128]).toString('base64'), sampleRate: 48_000 }

test('PCM 小端转换准确，错误采样率和损坏长度被拒绝', () => {
  assert.deepEqual([...decodeMossPcm(chunk)], [0, 32767 / 32768, -1])
  assert.throws(() => decodeMossPcm({ ...chunk, sampleRate: 16000 }), /格式无效/u)
  assert.throws(() => decodeMossPcm({ ...chunk, data: Buffer.from([1]).toString('base64') }), /长度无效/u)
})

test('下一段合成在上一段播放结束前开始，连续调度且整轮播放完才结算', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const device = audio(false); const texts: string[] = []
  const output = new MossVoiceOutput({ context: () => device.context, fetch: async (_url, init) => {
    texts.push(JSON.parse(init!.body as string).text)
    return new Response([chunk, { type: 'done' }].map((event) => JSON.stringify(event) + '\n').join(''))
  } })
  try {
    assert.equal(await output.append('第一段，'), true)
    assert.equal(await output.append('第二段。'), true)
    assert.deepEqual(texts, ['第一段，', '第二段。'])
    assert.equal(device.stopped(), 0, '续段不能取消前段音频')
    assert.ok(Math.abs(device.starts[1]! - device.starts[0]! - 3 / 48000) < 1e-10)
    let settled = false
    const finished = output.finish().then((value) => { settled = true; return value })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    for (const source of device.sources) source.onended?.()
    t.mock.timers.tick(30)
    assert.equal(await finished, true)
  } finally { output.dispose() }
})

test('连续播报打断会取消整轮等待和在途请求，新轮次沿用音色并重新调度', async () => {
  const device = audio(false); const signals: AbortSignal[] = []
  const output = new MossVoiceOutput({ context: () => device.context, fetch: async (_url, init) => {
    signals.push(init!.signal as AbortSignal)
    return new Response([chunk, { type: 'done' }].map((event) => JSON.stringify(event) + '\n').join(''))
  } })
  try {
    await output.append('旧回复。')
    const old = output.finish()
    output.cancel()
    await output.append('新回复。', 'moss:Junhao')
    assert.equal(await old, false)
    assert.equal(signals[0]!.aborted, true)
    assert.equal(signals[1]!.aborted, false, '旧轮结算不能清除新轮的取消句柄')
    assert.equal(device.starts[1], device.starts[0], '取消后重新建立播放时间线')
    output.cancel()
    assert.equal(signals[1]!.aborted, true)
  } finally { output.dispose() }
})

test('提前生成按五秒待播阈值限流，容量随播放放行，显式段间停顿保留', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const device = audio(false); let requested = 0
  const longChunk = { ...chunk, data: Buffer.alloc(6 * 48000 * 2).toString('base64') }
  const output = new MossVoiceOutput({ context: () => device.context, fetch: async () => {
    requested++
    return new Response([requested === 1 ? longChunk : chunk, { type: 'done' }].map((event) => JSON.stringify(event) + '\n').join(''))
  } })
  try {
    await output.append('第一段。')
    const next = output.append('下一段。', undefined, undefined, { segmentPauseMs: 200 })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requested, 1, '待播超过五秒时不提前发起下一次生成')
    Object.assign(device.context, { currentTime: 2 })
    t.mock.timers.tick(30)
    assert.equal(await next, true)
    assert.ok(Math.abs(device.starts[1]! - device.starts[0]! - 6.2) < 1e-10)
  } finally { output.dispose() }
})

test('分块事件按顺序播放，传递音色 ID，完成后才结束播报', async () => {
  const device = audio(); let requested: any
  const output = new MossVoiceOutput({ context: () => device.context, fetch: async (_url, init) => {
    requested = JSON.parse(init!.body as string)
    const body = `${JSON.stringify(chunk)}\n${JSON.stringify(chunk)}\n${JSON.stringify({ type: 'done' })}\n`
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body.slice(0, 8))); controller.enqueue(new TextEncoder().encode(body.slice(8))); controller.close() } }))
  } })
  try {
    assert.equal(await output.speak('你好', 'moss:Junhao'), true)
    assert.equal(requested.voiceId, 'moss:Junhao'); assert.equal(device.started(), 2)
  } finally { output.dispose() }
})

test('停止取消网络和已经安排的音频；不完整或错误流不会返回成功', async () => {
  const device = audio(); let requestSignal: AbortSignal | undefined; let reader: ReadableStreamDefaultController<Uint8Array> | undefined
  const output = new MossVoiceOutput({ context: () => device.context, fetch: async (_url, init) => {
    requestSignal = init!.signal as AbortSignal
    return new Response(new ReadableStream({ start(controller) { reader = controller; controller.enqueue(new TextEncoder().encode(JSON.stringify(chunk) + '\n')) }, cancel() {} }))
  } })
  const pending = output.speak('测试')
  await new Promise((resolve) => setImmediate(resolve))
  output.cancel(); reader!.close()
  assert.equal(await pending, false); assert.equal(requestSignal!.aborted, true)
  output.dispose()
  for (const body of [JSON.stringify(chunk) + '\n', JSON.stringify({ type: 'error', message: '模型失败' }) + '\n']) {
    const bad = new MossVoiceOutput({ context: () => audio().context, fetch: async () => new Response(body) })
    await assert.rejects(bad.speak('测试'), /未完整结束|模型失败/u); bad.dispose()
  }
})

test('加速与减速按实际音频时长衔接，音量与生成参数传入同一次试听', async () => {
  for (const rate of [0.5, 2]) {
    const device = audio(); let requested: any
    const output = new MossVoiceOutput({ context: () => device.context, fetch: async (_url, init) => {
      requested = JSON.parse(init!.body as string)
      return new Response([chunk, chunk, { type: 'done' }].map((event) => JSON.stringify(event) + '\n').join(''))
    } })
    try {
      assert.equal(await output.speak('精确参数', 'moss:Junhao', undefined, { rate, volume: 0.25, segmentPauseMs: 200, chunkTokens: 40, seed: 42 }), true)
      assert.deepEqual(device.rates, [rate, rate]); assert.equal(device.gain.gain.value, 0.25)
      assert.ok(Math.abs(device.starts[1]! - device.starts[0]! - 3 / 48000 / rate) < 1e-10, '下一块必须接在变速后的结尾')
      assert.deepEqual(requested.parameters, { rate, volume: 0.25, segmentPauseMs: 200, chunkTokens: 40, seed: 42 })
    } finally { output.dispose() }
  }
})
