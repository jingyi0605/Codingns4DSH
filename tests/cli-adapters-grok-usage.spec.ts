import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { GrokBuildDriver } from '../src/host/cli-adapters/grok-driver.js'
import { GrokContextUsage, GrokPromptUsage } from '../src/host/cli-adapters/grok-usage.js'
import { grokContextProjection, grokPerformanceProjection } from '../src/host/cli-adapters/grok-performance-projection.js'
import { CodingNsDshMessageProjector } from '../src/host/cli-adapters/dsh-message-projector.js'

const models = { currentModelId: 'grok-fast', availableModels: [
  { modelId: 'grok-fast', _meta: { totalContextTokens: 256000, contextWindows: [256000, 500000] } },
  { modelId: 'grok-small', _meta: { totalContextTokens: 200000 } },
] }
const firstUsage = { input_tokens: 17726, output_tokens: 114, cache_read_input_tokens: 1152, cache_creation_input_tokens: 0 }
const secondUsage = { input_tokens: 529, output_tokens: 57, cache_read_input_tokens: 18816, cache_creation_input_tokens: 0 }
const aggregate = { inputTokens: 38223, outputTokens: 171, totalTokens: 38394, cachedReadTokens: 19968, cacheCreationTokens: 0, modelCalls: 2, apiDurationMs: 7051 }
const update = (value: Record<string, unknown>, meta?: Record<string, unknown>) => ({
  method: 'session/update', params: { sessionId: 'provider', update: value, ...(meta === undefined ? {} : { _meta: meta }) },
})
const attempt = (usage: any) => ({ type: 'assistant/attempt', time: 99999, data: { stream: [{
  type: 'chunk', chunk: { type: 'usage', usage, codingnsRequestPerformance: usage.requestPerformance,
    codingnsContextObservation: { contextModelId: usage.contextModelId, contextWindow: usage.contextWindow, contextTokens: usage.contextTokens } },
}] } })

function fixture() {
  let now = 0
  const context = new GrokContextUsage()
  context.observe({ models })
  const usage = new GrokPromptUsage('prompt', context, () => now)
  return { context, usage, observe(time: number, value: Parameters<GrokPromptUsage['observe']>[0]) { now = time; usage.observe(value) } }
}

test('Grok settles the real two-call trace once and measures the native streams including hidden reasoning', () => {
  // Numeric protocol evidence only; no prompt, output, signature, or tool content is copied.
  const f = fixture()
  f.observe(8087, update({ sessionUpdate: 'agent_message_chunk', text: 'First' }, { streamStartMs: 5858, turnStartMs: 4369, totalTokens: 1710 }))
  f.observe(8109, update({ sessionUpdate: 'response_completed', usage: firstUsage }))
  f.observe(8194, update({ sessionUpdate: 'tool_call_update', status: 'completed' }, { streamStartMs: 5858 }))
  f.observe(11629, update({ sessionUpdate: 'agent_message_chunk', text: 'Second' }, { streamStartMs: 9439, totalTokens: 19324 }))
  f.observe(11638, update({ sessionUpdate: 'response_completed', usage: secondUsage }))
  f.observe(11682, update({ sessionUpdate: 'turn_completed', usage: aggregate }))
  f.observe(11683, update({ sessionUpdate: 'turn_completed', usage: aggregate }))
  f.usage.observeResponse({ _meta: { modelId: 'grok-fast', totalTokens: 19411, outputTokens: 57, usage: aggregate } })
  const usage = f.usage.finish()!
  assert.equal(usage.inputTokens, 38223)
  assert.equal(usage.uncachedInputTokens, 18255)
  assert.equal(usage.outputTokens, 171)
  assert.equal(usage.cacheReadTokens, 19968)
  assert.equal(usage.contextTokens, 19411)
  assert.equal(usage.contextWindow, 256000, 'Do not select the largest supported optional window')
  assert.equal(usage.contextUsageRatio, 0.075824)
  assert.equal(usage.contextModelId, 'grok-fast')
  assert.deepEqual(usage.requestPerformance?.samples.map(sample => sample.outputTokens), [114, 57])
  let state = grokPerformanceProjection.apply(grokPerformanceProjection.init(), attempt(usage))
  assert.equal(state.decodeTokens, 171)
  assert.equal(state.decodeMs, 4450)
  assert.equal(state.decodeTokens / (state.decodeMs / 1000), 171 / 4.45)
  assert.deepEqual(grokPerformanceProjection.apply(state, attempt(usage)), state, 'A repeated batch cannot count either request again')
  state = grokPerformanceProjection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.equal(state.decodeMs, 4450)
  const pressure = grokContextProjection.apply(grokContextProjection.init(), attempt(usage))
  assert.deepEqual(grokContextProjection.wire.view(pressure), { contextWindow: 256000, pressureTokens: 19411 })
})

test('Grok sums per-call usage only when the provider omits its turn aggregate', () => {
  const f = fixture()
  f.observe(1000, update({ sessionUpdate: 'response_completed', usage: firstUsage, signature: 'request-one' }))
  f.observe(1001, update({ sessionUpdate: 'response_completed', usage: firstUsage, signature: 'request-one' }))
  f.observe(2000, update({ sessionUpdate: 'response_completed', usage: secondUsage, signature: 'request-two' }))
  const usage = f.usage.finish()!
  assert.equal(usage.inputTokens, 38223)
  assert.equal(usage.outputTokens, 171)
  assert.equal(usage.cacheReadTokens, 19968)
  assert.equal(usage.uncachedInputTokens, 18255)
  assert.equal(usage.totalTokens, 38394)
  assert.equal(usage.requestPerformance, undefined, 'Unknown source spans must not produce a speed')
})

test('Grok never divides a multi-call aggregate by the final stream interval', () => {
  const f = fixture()
  f.observe(2000, update({ sessionUpdate: 'agent_message_chunk', text: 'Final' }, { streamStartMs: 1000, totalTokens: 20000 }))
  f.observe(3000, update({ sessionUpdate: 'turn_completed', usage: { inputTokens: 1249970, outputTokens: 10226, modelCalls: 16 } }))
  const usage = f.usage.finish()!
  assert.equal(usage.outputTokens, 10226)
  assert.equal(usage.contextTokens, 20000)
  assert.equal(usage.requestPerformance, undefined)
})

test('Grok accepts ACP used/size context updates, including zero, without treating size as usage', () => {
  const f = fixture()
  f.observe(1000, update({ sessionUpdate: 'usage_update', used: 12000, size: 500000 }))
  assert.equal(f.usage.finish()?.contextWindow, 500000)
  f.observe(2000, update({ sessionUpdate: 'usage_update', used: 0, size: 500000 }))
  assert.equal(f.usage.finish()?.contextTokens, 0)
  assert.equal(f.usage.finish()?.inputTokens, 0)
  f.context.observe({ models: { ...models, currentModelId: 'grok-small' } })
  assert.equal(f.context.contextWindow, 200000)
  f.context.modelId = 'unknown-model'
  assert.equal(f.context.contextWindow, undefined, 'An unknown model cannot inherit another model\'s capacity')
})

test('Grok response-only telemetry retains current context and prefers complete turn accounting', () => {
  const f = fixture()
  f.observe(1000, update({ sessionUpdate: 'turn_completed', usage: firstUsage }))
  f.usage.observeResponse({ _meta: { totalTokens: 19411, modelId: 'grok-fast', usage: aggregate } })
  const usage = f.usage.finish()!
  assert.equal(usage.outputTokens, 171)
  assert.equal(usage.contextTokens, 19411)
  assert.equal(usage.totalTokens, 38394)
  assert.equal(usage.requestPerformance, undefined)
})

for (const splitToolSteps of [false, true]) test(`Grok measures queued RPC events and settles one usage through the projector (segmented=${splitToolSteps})`, async () => {
  let now = 0
  let sendRest: () => Promise<void> = async () => assert.fail('Prompt not started')
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'], sessionRoots: [], now: () => now,
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.52', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      const emit = (message: unknown) => stdout.write(JSON.stringify(message) + '\n')
      return { stdout, stderr, stdin: { write(line: string) {
        const request = JSON.parse(line)
        const reply = (result: unknown) => emit({ id: request.id, result })
        if (request.method === 'initialize') return reply({ _meta: { modelState: models } })
        if (request.method === 'session/new') return reply({ sessionId: 'provider', models })
        if (request.method !== 'session/prompt') return
        const meta = { promptId: request.params._meta.promptId, turnStartMs: 0, streamStartMs: 1000, totalTokens: 1710 }
        setImmediate(() => { now = 1000; emit(update({ sessionUpdate: 'agent_message_chunk', text: 'First' }, meta)) })
        sendRest = async () => {
          now = 11000
          emit(update({ sessionUpdate: 'response_completed', usage: firstUsage }))
          emit(update({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'read_file', status: 'pending' }, meta))
          await new Promise(resolve => setImmediate(resolve))
          now = 16000
          emit(update({ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed', rawOutput: 'fixture' }, meta))
          await new Promise(resolve => setImmediate(resolve))
          now = 17000
          emit(update({ sessionUpdate: 'agent_message_chunk', text: 'Second' }, { ...meta, streamStartMs: 17000, totalTokens: 19324 }))
          // Replayed historical usage and unrelated prompts must not enter this turn.
          emit(update({ sessionUpdate: 'response_completed', usage: { outputTokens: 99999 } }, { isReplay: true }))
          emit(update({ sessionUpdate: 'agent_message_chunk', text: 'Historical' }, { isReplay: true, modelId: 'grok-small' }))
          emit({ method: 'session/update', params: { sessionId: 'foreign-session', _meta: { modelId: 'grok-small' }, update: { sessionUpdate: 'agent_message_chunk', text: 'Foreign' } } })
          emit(update({ sessionUpdate: 'response_completed', usage: { outputTokens: 99999 } }, { promptId: 'old-prompt' }))
          await new Promise(resolve => setImmediate(resolve))
          now = 18000
          emit(update({ sessionUpdate: 'response_completed', usage: secondUsage }))
          emit(update({ sessionUpdate: 'turn_completed', prompt_id: meta.promptId, stop_reason: 'end_turn', usage: aggregate }))
          reply({ stopReason: 'end_turn', _meta: { totalTokens: 19411, modelId: 'grok-fast', outputTokens: 57, usage: aggregate } })
        }
      } }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    const input = { sessionId: 'host', messages: [], prompt: 'Fixture', splitToolSteps }
    const iterator = driver.executeTurn(input)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.type, 'session-binding')
    const observed = (await iterator.next()).value
    assert.equal(observed.type, 'usage-observation')
    assert.equal(observed.contextTokens, 1710, 'Context is available before the turn finishes')
    const first = (await iterator.next()).value
    assert.equal(first.type, 'text-delta')
    await sendRest()
    await new Promise(resolve => setImmediate(resolve))
    now = 33000 // A delayed/translated consumer cannot alter the RPC measurements.
    const events = [observed, first]
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event)
    const usages = events.filter(event => event.type === 'usage')
    assert.equal(usages.length, 1)
    assert.equal(usages[0].outputTokens, 171)
    const measurements = events.filter(event => event.type === 'usage-observation').flatMap(event => event.requestPerformance?.samples ?? [])
    assert.ok(events.filter(event => event.type === 'usage-observation').every(event => event.contextModelId === 'grok-fast'))
    assert.deepEqual(measurements.map(sample => sample.completedAt - sample.firstTokenAt), [10000, 1000])
    assert.equal(usages[0].requestPerformance, undefined, 'Final accounting cannot repeat measurements already observed')
    const contexts: any[] = [], samples: any[] = [], chunks: any[] = []
    const createProjector = () => new CodingNsDshMessageProjector({
      adapterId: 'grok', sessionId: 'host', nativeSessions: {
        appendRequestContext(_id: string, value: unknown) { contexts.push(value); return true },
        appendUsageSample(_id: string, value: unknown) { samples.push(value); return true },
      } as never,
    })
    let projector = createProjector()
    for (const event of events) {
      chunks.push(...await projector.push(event))
      if (event.type === 'step-boundary') projector = createProjector()
    }
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'usage').map(chunk => chunk.usage.outputTokens), [171])
    assert.equal(contexts.at(-1).model, 'grok-fast')
    assert.equal(contexts.at(-1).contextWindow, 256000)
    assert.equal(samples.at(-1).contextTokens, 19411)
    assert.equal(samples.flatMap(sample => sample.requestPerformance?.samples ?? []).length, 2)
  } finally { driver.dispose() }
})
