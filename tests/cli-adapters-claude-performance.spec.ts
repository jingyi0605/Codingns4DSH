import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { ClaudeCodeDriver } from '../src/host/cli-adapters/claude-driver.js'
import { ClaudePerformanceTracker } from '../src/host/cli-adapters/claude-performance.js'
import { claudePerformanceProjection as projection } from '../src/host/cli-adapters/claude-performance-projection.js'
import { grokPerformanceProjection } from '../src/host/cli-adapters/grok-performance-projection.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import type { CodingNsAgentEvent } from '../src/shared/contracts/cli-adapter.js'

const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', event })
const start = (id: string) => stream({ type: 'message_start', message: {
  id, model: 'kiro/claude-opus-5.5', usage: { input_tokens: 100, output_tokens: 0 },
} })
const delta = (text: string) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } })
const usage = (output: number) => stream({ type: 'message_delta', usage: { output_tokens: output } })

function fixture() {
  let now = 0
  const spawned = Promise.withResolvers<void>()
  let stdout: PassThrough
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude.exe'], sessionRoots: [], now: () => now,
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.288', stderr: '' })) as never,
    spawn: (() => {
      stdout = new PassThrough()
      const output = stdout, stderr = new PassThrough(), stdin = new PassThrough()
      spawned.resolve()
      return Object.assign(new EventEmitter(), { stdout, stderr, stdin,
        kill() { output.end(); stderr.end(); return true },
      })
    }) as never,
  })
  return { driver, spawned: spawned.promise, get stdout() { return stdout },
    time: (value: number) => { now = value },
    emit: (value: Record<string, unknown>) => { stdout.write(JSON.stringify(value) + '\n') },
  }
}

for (const splitToolSteps of [false, true]) test(`Claude source timing survives consumer suspension and translation (segmented=${splitToolSteps})`, async () => {
  const f = fixture()
  const sessionId = 'claude-performance'
  const records: any[] = [{ type: 'turn/start', time: 0, seq: 0, data: { turn: 1 } }, { type: 'step/start', time: 0, seq: 1, data: { turn: 1, step: 1 } }]
  const session = { snapshotEvents: () => [...records], append(type: string, data: unknown) {
    const event = { type, time: 60_000, seq: records.length, data }; records.push(event); return event
  } }
  const bridge = createCodingNsNativeSessionBridge({ get: (key: string) => key === 'sessions' ? { get: () => session, list: () => [session] } : undefined } as never)
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'claude-code', sessionId, nativeSessions: bridge, translationEnabled: true,
    translation: { shouldTranslate: () => true, translateOutput: async () => ({
      original: 'Original reasoning', translated: '译文', targetLanguage: 'zh', bilingual: false, durationMs: 15_000,
    }) } as never,
  })
  const iterator = f.driver.executeTurn({ sessionId, messages: [], prompt: 'Explain the fixture', splitToolSteps })[Symbol.asyncIterator]()
  try {
    const first = iterator.next()
    await f.spawned
    f.time(1000)
    f.emit(start('message-1'))
    f.emit(delta('Original reasoning'))
    let next = await first
    while (!next.done && next.value.type !== 'reasoning-delta') next = await iterator.next()
    assert.equal(next.value?.type, 'reasoning-delta')
    assert.deepEqual(await projector.push(next.value!), [])

    // The source keeps streaming while translation or a tool-step consumer is paused.
    f.time(11_000)
    f.stdout.write('not-json\n\n')
    f.emit(usage(1000))
    f.emit(stream({ type: 'message_stop' }))
    f.time(16_000)
    f.emit({ type: 'result', usage: { input_tokens: 100, output_tokens: 1000 } })
    f.time(60_000)
    const events: CodingNsAgentEvent[] = []
    const chunks: any[] = []
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
      events.push(event)
      chunks.push(...await projector.push(event))
    }
    const samples = events.flatMap(event => event.type === 'usage-observation' ? event.requestPerformance?.samples ?? [] : [])
    assert.equal(samples.length, 1)
    assert.deepEqual({ ...samples[0], id: 'request' }, {
      id: 'request', startedAt: 0, firstTokenAt: 1000, completedAt: 11_000, outputTokens: 1000,
    })
    assert.equal(events.filter(event => event.type === 'usage').at(-1)?.outputTokens, 1000)
    assert.equal(chunks.filter(chunk => chunk.type === 'usage').length, 1)
    assert.equal(chunks.find(chunk => chunk.type === 'usage')?.usage.outputTokens, 1000)
    assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.codingnsTranslation), true)
    const state = records.reduce((state, event) => projection.apply(state, event), projection.init())
    assert.equal(state.decodeTokens / (state.decodeMs / 1000), 100)
    assert.equal(state.llmMs, 11_000)
    assert.equal(state.ttftMs, 1000)
    const other = records.reduce((state, event) => grokPerformanceProjection.apply(state, event), grokPerformanceProjection.init())
    assert.equal(other.decodeTokens, 0, 'Claude samples cannot contaminate Grok statistics')
  } finally { await iterator.return?.(); f.driver.dispose() }
})

test('Claude pairs streamed usage once per request and excludes tools, child agents, snapshots, and turn totals', () => {
  const tracker = new ClaudePerformanceTracker(0)
  tracker.observe(start('first'), 500)
  tracker.observe(delta('Reasoning'), 1000)
  const snapshot = { type: 'assistant', message: { id: 'first', usage: { output_tokens: 600 }, content: [] } }
  assert.equal(tracker.observe(snapshot, 6000), undefined)
  tracker.observe(usage(1000), 11_000)
  const first = tracker.observe(stream({ type: 'message_stop' }), 11_000)!
  assert.equal(first.outputTokens, 1000)
  assert.equal(tracker.observe(snapshot, 12_000), undefined)
  assert.equal(tracker.observe(stream({ type: 'message_stop' }), 12_000), undefined)
  tracker.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Fixture' }] } }, 21_000)
  tracker.observe(start('second'), 21_500)
  tracker.observe({ ...delta('Child'), parent_tool_use_id: 'agent-tool' }, 21_600)
  tracker.observe({ ...usage(9000), parent_tool_use_id: 'agent-tool' }, 21_700)
  tracker.observe(stream({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'read-2', name: 'Read', input: {} } }), 22_000)
  tracker.observe(usage(300), 23_000)
  const second = tracker.observe(stream({ type: 'message_stop' }), 23_000)!
  assert.deepEqual({ ...second, id: 'request' }, { id: 'request', startedAt: 21_000, firstTokenAt: 22_000, completedAt: 23_000, outputTokens: 300 })
  assert.notEqual(first.id, second.id)
  assert.equal(tracker.observe({ type: 'result', usage: { output_tokens: 1300 } }, 25_000), undefined)
  assert.equal(tracker.observe(start('first'), 26_000), undefined)
  assert.equal(tracker.observe(stream({ type: 'message_stop' }), 27_000), undefined)
})

test('Claude source samples and billing stay on their own requests across real Registry tool-step continuation', async () => {
  const f = fixture(), registry = new CodingNsCliAdapterRegistry([f.driver])
  const input = { adapterId: 'claude-code' as const, sessionId: 'split-performance', messages: [], prompt: 'Read the fixture', splitToolSteps: true }
  try {
    const first = registry.execute(input)[Symbol.asyncIterator]()
    const pending = first.next()
    await f.spawned
    f.time(1000); f.emit(start('first')); f.emit(delta('First reasoning'))
    f.time(11_000); f.emit(usage(1000)); f.emit(stream({ type: 'message_stop' }))
    f.emit({ type: 'assistant', message: { id: 'first', usage: { input_tokens: 100, output_tokens: 1000 },
      content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'fixture.txt' } }],
    } })
    f.time(21_000); f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Fixture' }] } })
    f.time(22_000); f.emit(start('second')); f.emit(delta('Second reasoning'))
    f.time(23_000); f.emit(usage(300)); f.emit(stream({ type: 'message_stop' }))
    f.emit({ type: 'assistant', message: { id: 'second', usage: { input_tokens: 100, output_tokens: 300 }, content: [] } })
    f.emit({ type: 'result', usage: { input_tokens: 200, output_tokens: 1300 } })
    f.time(60_000)
    const steps: CodingNsAgentEvent[][] = [[]]
    let next = await pending
    while (!next.done) { steps[0]!.push(next.value); next = await first.next() }
    assert.equal(steps[0]!.some(event => event.type === 'step-boundary'), true)
    steps.push([])
    for await (const event of registry.execute(input)) steps[1]!.push(event)
    const samples = steps.map(events => events.flatMap(event => event.type === 'usage-observation' ? event.requestPerformance?.samples ?? [] : []))
    assert.deepEqual(samples.map(samples => samples.map(sample => sample.outputTokens)), [[1000], [300]])
    assert.equal(samples[1]![0]!.startedAt, 21_000)
    assert.equal(samples[1]![0]!.completedAt, 23_000)
    assert.deepEqual(steps.map(events => events.filter(event => event.type === 'usage').at(-1)?.outputTokens), [1000, 300])
  } finally { await registry.dispose() }
})

test('Claude does not fabricate performance from incomplete streams, retries, missing usage, or zero-duration delivery', () => {
  const tracker = new ClaudePerformanceTracker(0)
  tracker.observe(start('failed'), 100)
  tracker.observe(delta('Partial'), 200)
  tracker.observe(usage(1000), 300)
  tracker.observe({ type: 'system', subtype: 'api_retry' }, 400)
  assert.equal(tracker.observe(stream({ type: 'message_stop' }), 500), undefined)
  tracker.observe(start('retry'), 600)
  tracker.observe(delta('New'), 700)
  tracker.observe(usage(30), 1700)
  const sample = tracker.observe(stream({ type: 'message_stop' }), 1700)!
  assert.equal(sample.startedAt, 400)
  assert.equal(sample.outputTokens, 30)
  for (const [id, withText, withUsage, completedAt] of [
    ['no-text', false, true, 2000], ['no-usage', true, false, 2000], ['burst', true, true, 1800],
  ] as const) {
    tracker.observe(start(id), 1800)
    if (withText) tracker.observe(delta('Text'), 1800)
    if (withUsage) tracker.observe(usage(30), 1800)
    assert.equal(tracker.observe(stream({ type: 'message_stop' }), completedAt), undefined)
  }
  assert.equal(tracker.observe({ type: 'assistant', message: { id: 'snapshot-only', usage: { output_tokens: 1000 } } }, 3000), undefined)
  tracker.observe(start('cancelled'), 3100)
  tracker.observe(delta('Partial'), 3200)
  assert.equal(tracker.observe({ type: 'result', is_error: true, usage: { output_tokens: 9000 } }, 4000), undefined)
  assert.equal(tracker.observe(stream({ type: 'message_stop' }), 4100), undefined)
})

test('closing a Claude turn releases the arrival listener and cannot leak its first token into a resumed turn', async () => {
  const f = fixture()
  const input = { sessionId: 'reused-session', messages: [], prompt: 'Explain the fixture' }
  const iterator = f.driver.executeTurn(input)[Symbol.asyncIterator]()
  try {
    const pending = iterator.next()
    await f.spawned
    f.time(1000); f.emit(start('same-message')); f.emit(delta('Interrupted'))
    let event = await pending
    while (!event.done && event.value.type !== 'reasoning-delta') event = await iterator.next()
    const oldOutput = f.stdout
    await iterator.return?.()
    assert.equal(oldOutput.listenerCount('data'), 0)
    const resumed = f.driver.executeTurn(input)[Symbol.asyncIterator]()
    const first = resumed.next()
    await new Promise(resolve => setImmediate(resolve))
    f.time(10_000); f.emit(start('same-message'))
    f.time(11_000); f.emit(usage(1000)); f.emit(stream({ type: 'message_stop' }))
    f.emit({ type: 'result', usage: { input_tokens: 100, output_tokens: 1000 } })
    const events: CodingNsAgentEvent[] = []
    let next = await first
    while (!next.done) { events.push(next.value); next = await resumed.next() }
    assert.equal(events.some(event => event.type === 'usage-observation'), false)
    assert.equal(f.stdout.listenerCount('data'), 0)
  } finally { await iterator.return?.(); f.driver.dispose() }
})
