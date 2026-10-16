import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CodexPerformanceTracker } from '../src/host/cli-adapters/codex-performance.js'
import { codexPerformanceProjection as projection } from '../src/host/cli-adapters/codex-performance-projection.js'
import { CodexAppServerDriver } from '../src/host/cli-adapters/codex-driver.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'
import type { CodexRequestPerformance } from '../src/shared/codex-performance.js'

const message = (method: string, params: Record<string, unknown> = {}) => ({ method, params })
const usage = (output: number, total?: number) => message('thread/tokenUsage/updated', {
  tokenUsage: { last: { inputTokens: 100, outputTokens: output }, ...(total === undefined ? {} : { total: { outputTokens: total } }) },
})
const attempt = (sample: CodexRequestPerformance, step = 1) => ({
  type: 'assistant/attempt', time: sample.completedAt + 15_000,
  data: { turn: 1, step, stream: [{ type: 'chunk', time: sample.completedAt + 15_000,
    chunk: { type: 'usage', usage: { outputTokens: sample.outputTokens }, codingnsCodexPerformance: sample } }] },
})

test('Codex measures hidden reasoning at its start and excludes tools and translated delivery', () => {
  let now = 100
  const tracker = new CodexPerformanceTracker(() => now)
  tracker.beginTurn()
  now = 1100
  tracker.observe(message('item/started', { item: { type: 'reasoning', id: 'reasoning' } }))
  now = 10_100
  tracker.observe(message('item/reasoning/summaryTextDelta', { delta: 'Summary after hidden reasoning' }))
  now = 11_100
  const first = tracker.observe(usage(1000, 1000))!
  assert.equal(first.startedAt, 100)
  assert.equal(first.firstTokenAt, 1100)
  assert.equal(first.completedAt, 11_100)

  tracker.observe(message('item/started', { item: { type: 'commandExecution', id: 'tool' } }))
  now = 21_100
  tracker.observe(message('item/completed', { item: { type: 'commandExecution', id: 'tool' } }))
  now = 22_100
  tracker.observe(message('item/agentMessage/delta', { delta: 'Next response' }))
  now = 23_100
  const second = tracker.observe(usage(300, 1300))!
  assert.equal(second.startedAt, 21_100)

  let state = projection.init()
  for (const sample of [first, second]) state = projection.apply(state, attempt(sample))
  assert.equal(state.decodeTokens, 1300)
  assert.equal(state.decodeMs, 11_000)
  assert.equal(state.llmMs, 13_000)
  assert.equal(state.decodeTokens / (state.decodeMs / 1000), 1300 / 11)
})

test('Codex rejects usage without a generation span, duplicate totals, and zero-duration bursts', () => {
  let now = 0
  const tracker = new CodexPerformanceTracker(() => now)
  tracker.beginTurn()
  assert.equal(tracker.observe(usage(1000, 1000)), undefined)
  now = 100
  tracker.observe(message('item/agentMessage/delta', { delta: 'Burst' }))
  assert.equal(tracker.observe(usage(1000, 2000)), undefined)
  now = 200
  tracker.observe(message('item/agentMessage/delta', { delta: 'Duplicate usage notification' }))
  now = 300
  assert.equal(tracker.observe(usage(1000, 2000)), undefined)
  tracker.beginTurn()
  now = 400
  assert.equal(tracker.observe(usage(1000, 3000)), undefined)
})

test('total-only Codex telemetry uses a baseline delta and never measures historical cumulative output', () => {
  let now = 0
  const tracker = new CodexPerformanceTracker(() => now)
  const total = (outputTokens: number) => message('thread/tokenUsage/updated', { tokenUsage: { total: { outputTokens } } })
  tracker.beginTurn()
  tracker.observe(message('item/agentMessage/delta', { delta: 'First' }))
  now = 1000
  assert.equal(tracker.observe(total(20_000)), undefined)
  now = 2000
  tracker.observe(message('item/agentMessage/delta', { delta: 'Second' }))
  now = 3000
  assert.equal(tracker.observe(total(20_100))?.outputTokens, 100)
})

test('interrupted and steered turns cannot reuse an unfinished generation interval', () => {
  let now = 0
  const tracker = new CodexPerformanceTracker(() => now)
  tracker.beginTurn()
  tracker.observe(message('item/started', { item: { type: 'reasoning', id: 'old' } }))
  now = 5000
  tracker.observe(message('turn/completed', { turn: { status: 'interrupted' } }))
  now = 10_000
  tracker.observe(message('turn/started'))
  assert.equal(tracker.observe(usage(500)), undefined)
  now = 11_000
  tracker.observe(message('item/agentMessage/delta', { delta: 'New turn' }))
  now = 12_000
  const sample = tracker.observe(usage(100))!
  assert.equal(sample.firstTokenAt, 11_000)
  assert.equal(sample.completedAt, 12_000)
})

test('the durable fold ignores translated bursts, synthetic declarations, invalid spans, and duplicate samples', () => {
  const sample = { id: 'request-1', startedAt: 1000, firstTokenAt: 2000, completedAt: 12_000, outputTokens: 1000 }
  let state = projection.init()
  for (const event of [
    { type: 'step/start', time: 1000, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: 1500, data: { turn: 1, step: 1, stream: [] } },
    attempt(sample), attempt(sample),
    attempt({ ...sample, id: 'zero', firstTokenAt: 12_000 }),
    attempt({ ...sample, id: 'negative', outputTokens: -1 }),
    { type: 'assistant/message', time: 28_059, data: { usage: { outputTokens: 1000 }, stream: [{ type: 'text-chunks', time0: 28_000, texts: ['Translated batch'], dt: [] }] } },
    { type: 'step/end', time: 28_059, data: { turn: 1, step: 1 } },
  ]) state = projection.apply(state, event)
  assert.deepEqual(projection.wire.view(state), {
    turns: 1, steps: 1, llmMs: 11_000, toolMs: 0, ttftMs: 1000, ttftSteps: 1, decodeMs: 10_000, decodeTokens: 1000,
  })
  const restored = projection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(projection.wire.view(restored), projection.wire.view(state))
  assert.deepEqual(projection.apply(restored, attempt(sample)), restored)
})

test('legacy translated histories retain counts and tool time without an invented decode speed', () => {
  let state = projection.init()
  for (const event of [
    { type: 'tool/call', time: 10, data: { callId: 'tool' } },
    { type: 'tool/result', time: 110, data: { message: { source: { callId: 'tool' } } } },
    ...[1, 2, 3, 4, 5].flatMap(step => [
      { type: 'assistant/message', time: step * 1000, data: { usage: { outputTokens: 1000 }, stream: [{ type: 'text-chunks', time0: step * 1000 - 59, texts: ['Batch'], dt: [] }] } },
      { type: 'step/end', time: step * 1000, data: { turn: 1, step } },
    ]),
  ]) state = projection.apply(state, event)
  assert.equal(state.steps, 5)
  assert.equal(state.turns, 1)
  assert.equal(state.toolMs, 100)
  assert.equal(state.decodeTokens, 0)
  assert.equal(state.decodeMs, 0)
})

test('source measurements survive projector translation and native usage persistence', async () => {
  const events: any[] = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }]
  const session = { snapshotEvents: () => [...events], append(type: string, data: unknown) {
    const event = { type, time: Date.now(), seq: events.length, data }; events.push(event); return event
  } }
  const bridge = createCodingNsNativeSessionBridge({ get: (key: string) => key === 'sessions' ? { get: () => session, list: () => [session] } : undefined } as never)
  const sample = { id: 'translation-request', startedAt: 0, firstTokenAt: 1000, completedAt: 11_000, outputTokens: 1000 }
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'codex', sessionId: 'test', nativeSessions: bridge, translationEnabled: true,
    translation: { shouldTranslate: () => true, translateOutput: async () => ({ original: 'Original', translated: 'Translation', targetLanguage: 'zh', bilingual: false, durationMs: 15_000 }) } as never,
  })
  assert.deepEqual(await projector.push({ type: 'text-delta', text: 'Original' }), [])
  await projector.push({ type: 'usage', inputTokens: 100, outputTokens: 1000, codexPerformance: sample })
  await projector.complete()
  assert.deepEqual(events.at(-1).data.stream[0].chunk.codingnsCodexPerformance, sample)
  const state = events.reduce((state, event) => projection.apply(state, event), projection.init())
  assert.equal(state.decodeTokens / (state.decodeMs / 1000), 100)
})

for (const splitToolSteps of [false, true]) test(`Codex driver captures RPC timestamps while a consumer is suspended (segmented=${splitToolSteps})`, async () => {
  let now = 0
  let emit: (method: string, params: Record<string, unknown>) => void = () => assert.fail('RPC not started')
  const driver = new CodexAppServerDriver({
    binaries: ['fake-codex'], now: () => now, sessionRoots: [], codexHome: process.cwd(),
    spawnSync: (() => ({ status: 0, stdout: 'codex 1.0.0', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      emit = (method, params) => stdout.write(JSON.stringify({ method, params: { threadId: 'thread', turnId: 'turn', ...params } }) + '\n')
      return { stdout, stderr, stdin: { write(line: string) {
        const request = JSON.parse(line)
        const result = request.method === 'thread/start' ? { thread: { id: 'thread' } }
          : request.method === 'turn/start' ? { turn: { id: 'turn', status: 'inProgress' } } : {}
        stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
        if (request.method === 'turn/start') setImmediate(() => {
          now = 1000
          emit('item/agentMessage/delta', { delta: 'Original', itemId: 'assistant' })
        })
      } }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    const iterator = driver.executeTurn({ sessionId: 'test', messages: [], prompt: 'Fixture', splitToolSteps })[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.type, 'session-binding')
    assert.equal((await iterator.next()).value.type, 'text-delta')
    now = 11_000
    emit('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, outputTokens: 1000 } } })
    await new Promise(resolve => setImmediate(resolve))
    now = 26_000
    const event = (await iterator.next()).value
    assert.equal(event.type, 'usage')
    assert.equal(event.codexPerformance.firstTokenAt, 1000)
    assert.equal(event.codexPerformance.completedAt, 11_000)
    emit('turn/completed', { turn: { id: 'turn', status: 'completed' } })
    for await (const _event of { [Symbol.asyncIterator]: () => iterator }) { /* drain the fake turn */ }
  } finally { driver.dispose() }
})
