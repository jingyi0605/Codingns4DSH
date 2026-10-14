import assert from 'node:assert/strict'
import test from 'node:test'
import { createInteractionTranslation } from '../src/host/features/interaction-translation.js'
import { createSessionTranslationService } from '../src/host/features/session-translation-service.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS } from '../src/shared/contracts/session-translation.js'
import { questionTranslationFields } from '../src/shared/contracts/interaction-translation.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const response = (text: string) => (async function* () { yield { type: 'text-delta', text }; yield { type: 'finish', reason: { kind: 'stop' } } })()
const record = (original: string) => ({ original, translated: '中文翻译', targetLanguage: 'zh' as const, bilingual: false })
const request = (texts: string[], sessionId = 's1') => ({ sessionId, direction: 'output', fields: texts.map((text, index) => ({ key: `f.${index}`, text })) })

function modelFixture(stream: (request: any, source: string) => AsyncIterable<any>, pool = ['primary']) {
  const calls: { model: string; source: string; signal: AbortSignal }[] = []
  const service = createSessionTranslationService({
    llm: {
      listProviders: () => [{ id: 'test', name: 'Test' }],
      listModels: async () => [{ id: 'primary', name: 'Primary' }],
      stream(options: any) {
        const source = options.messages[0].content[0].text.split('SOURCE TEXT BEGIN\n')[1].split('\nSOURCE TEXT END')[0]
        calls.push({ model: options.model, source, signal: options.signal })
        return stream(options, source)
      },
    },
  }, '0.2.1-alpha.2')!
  assert.ok(service)
  service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: pool.map(model => ({ provider: 'test', model })) })
  service.activate()
  const engine = createInteractionTranslation(service, () => ({ adapterId: 'opencode', translationEnabled: true }))
  return { service, engine, calls, dispose() { engine.dispose(); service.dispose() } }
}

// The fields from the reported Westphalia question, in their native reading order.
const quiz = {
  id: 'history', header: 'History quiz',
  question: "In which year did the Treaty of Westphalia, which is widely considered to have ended the Thirty Years' War, get signed?",
  options: [
    { label: '1605', description: "Around the start of the Thirty Years' War era" },
    { label: '1648', description: "The year widely cited as the end of the Thirty Years' War" },
    { label: '1689', description: 'The year of the Glorious Revolution in England' },
    { label: '1748', description: 'The year the Treaty of Aix-la-Chapelle ended the War of Austrian Succession' },
  ],
}

test('the reported quiz keeps numeric labels locally and translates every description beyond 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = modelFixture((_options, source) => (async function* () {
    assert.ok(!/^\d+$/.test(source), 'numeric labels must never consume a model request')
    await new Promise(resolve => setTimeout(resolve, 20_000))
    yield { type: 'text-delta', text: '中文翻译' }
  })())
  t.after(() => f.dispose())
  const fields = questionTranslationFields([quiz])
  const pending = f.engine.translate({ sessionId: 's1', direction: 'output', fields })
  await tick()
  t.mock.timers.tick(20_000)
  await tick()
  t.mock.timers.tick(20_000)
  const result = await pending
  assert.equal(f.calls.length, 6)
  assert.equal(Object.keys(result.records).length, 10)
  assert.ok(Object.values(result.records).every(record => !record.failed))
  for (let index = 0; index < 4; index++) {
    assert.equal(result.records[`q.0.o.${index}.label`]?.translated, quiz.options[index]!.label)
    assert.equal(result.diagnostics?.[`q.0.o.${index}.label`]?.attempts, 0)
    assert.equal(result.records[`q.0.o.${index}.description`]?.translated, '中文翻译')
  }
  const cached = await f.engine.translate({ sessionId: 's1', direction: 'output', fields })
  assert.equal(f.calls.length, 6)
  assert.ok(Object.values(cached.diagnostics!).every(item => item.cacheHit))
})

test('numbers, dates, percentages and numeric expressions bypass the shared service in both directions', async t => {
  const f = modelFixture(() => { throw new Error('A numeric literal must not reach the model') })
  t.after(() => f.dispose())
  for (const original of ['1605', '1648', '1689', '1748', '17 × 24 = 408', '-12.5%', '2026-10-15', '１２３', '$1,234.50', '`count` = 408']) {
    assert.equal(await f.service.translateOutput('opencode', 'assistant', original, undefined, true), null, original)
    assert.deepEqual(await f.service.translateInputDetailed!('opencode', original, undefined, true), { translated: original })
  }
  assert.equal(f.calls.length, 0)
})

test('numbers embedded in prose are still translated and wrong-language output is still rejected', async t => {
  const f = modelFixture((_options, source) => response(source))
  t.after(() => f.dispose())
  const result = await f.engine.translate(request(['The year 1648', '1605 years']))
  assert.equal(f.calls.length, 2)
  for (const item of Object.values(result.records)) {
    assert.equal(item.failed, true)
    assert.deepEqual(item.failure, { code: 'invalid-response', retryable: false })
  }
})

test('queue waiting does not use a field execution budget and diagnostics distinguish both durations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const engine = createInteractionTranslation({ enabled: true, cacheKey: 'fixed',
    translateOutput: async (_adapter: string, _kind: string, text: string) => {
      await new Promise(resolve => setTimeout(resolve, 45_000))
      return record(text)
    },
  } as any, () => ({ adapterId: 'opencode', translationEnabled: true }))
  t.after(() => engine.dispose())
  const first = engine.translate(request(['First', 'Second', 'Third', 'Fourth']))
  await tick()
  const queued = engine.translate(request(['Queued description'], 's2'))
  await tick()
  t.mock.timers.tick(45_000)
  await tick()
  t.mock.timers.tick(45_000)
  await first
  const result = await queued
  assert.equal(result.records['f.0']?.failed, undefined)
  assert.equal(result.diagnostics?.['f.0']?.queueMs, 45_000)
  assert.equal(result.diagnostics?.['f.0']?.executionMs, 45_000)
})

test('a stalled primary model can time out and fall back within the field budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = modelFixture(options => options.model === 'primary'
    ? (async function* () { await new Promise(() => {}); yield {} })()
    : response('选项说明'), ['primary', 'backup'])
  t.after(() => f.dispose())
  const pending = f.engine.translate(request(['Option description']))
  await tick()
  t.mock.timers.tick(30_000)
  const result = await pending
  assert.equal(result.records['f.0']?.translated, '选项说明')
  assert.equal(result.diagnostics?.['f.0']?.attempts, 1)
  assert.deepEqual(f.calls.map(call => call.model), ['primary', 'backup'])
})

test('a transient provider failure retries once and records the successful attempt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  let attempts = 0
  const f = modelFixture(() => {
    if (++attempts === 1) throw Object.assign(new Error('Rate limit'), { status: 429 })
    return response('选项说明')
  })
  t.after(() => f.dispose())
  const pending = f.engine.translate(request(['Option description']))
  await tick()
  assert.equal(attempts, 1)
  t.mock.timers.tick(500)
  const result = await pending
  assert.equal(attempts, 2)
  assert.equal(result.records['f.0']?.failed, undefined)
  assert.equal(result.diagnostics?.['f.0']?.attempts, 2)
})

test('permanent provider errors are not retried and expose a structured reason', async t => {
  const f = modelFixture(() => { throw Object.assign(new Error('Unauthorized'), { status: 401 }) })
  t.after(() => f.dispose())
  const result = await f.engine.translate(request(['Option description']))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(result.records['f.0']?.failure, { code: 'configuration', retryable: false })
  assert.equal(result.diagnostics?.['f.0']?.attempts, 1)
  assert.equal(result.diagnostics?.['f.0']?.phase, 'translation')
})

test('unresponsive fields exhaust two attempts and the overall deadline ends the remaining batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const engine = createInteractionTranslation({ enabled: true, cacheKey: 'fixed', translateOutput: () => new Promise(() => {}) } as any,
    () => ({ adapterId: 'opencode', translationEnabled: true }))
  t.after(() => engine.dispose())
  const pending = engine.translate(request(Array.from({ length: 10 }, (_, i) => `Option ${i}`)))
  await tick()
  for (const ms of [65_000, 500, 65_000, 49_500]) { t.mock.timers.tick(ms); await tick() }
  const result = await pending
  assert.equal(Object.keys(result.records).length, 10)
  assert.ok(Object.values(result.records).every(item => item.failed && item.failure?.code === 'timeout'))
  assert.ok(Object.values(result.diagnostics!).every(item => item.attempts <= 2))
  assert.equal(result.diagnostics?.['f.0']?.attempts, 2)
  assert.equal(result.diagnostics?.['f.0']?.executionMs, 130_000)
  assert.equal(result.diagnostics?.['f.9']?.attempts, 0)
})

test('cancelling a queued request removes it before execution and active cancellation releases the queue', async t => {
  const sources: string[] = []
  const engine = createInteractionTranslation({ enabled: true, cacheKey: 'fixed', translateOutput: async (_a: string, _k: string, text: string) => {
    sources.push(text)
    if (text.startsWith('Blocked')) await new Promise(() => {})
    return record(text)
  } } as any, () => ({ adapterId: 'opencode', translationEnabled: true }))
  t.after(() => engine.dispose())
  const active = new AbortController(), queued = new AbortController()
  const first = engine.translate(request(['Blocked A', 'Blocked B', 'Blocked C', 'Blocked D']), active.signal)
  await tick()
  const second = engine.translate(request(['Cancelled description']), queued.signal)
  queued.abort()
  assert.deepEqual(await second, { enabled: false, records: {} })
  active.abort()
  assert.deepEqual(await first, { enabled: false, records: {} })
  const third = await engine.translate(request(['New description']))
  assert.equal(third.records['f.0']?.failed, undefined)
  assert.equal(sources.includes('Cancelled description'), false)
})

test('cancellation during retry backoff stops the retry', async t => {
  const f = modelFixture(() => { throw new Error('ECONNRESET') })
  t.after(() => f.dispose())
  const controller = new AbortController()
  const pending = f.engine.translate(request(['Option description']), controller.signal)
  await tick()
  controller.abort()
  assert.deepEqual(await pending, { enabled: false, records: {} })
  assert.equal(f.calls.length, 1)
})

test('a slow field does not block new work when other queue slots are idle', async t => {
  const sources: string[] = []
  let release!: () => void
  const engine = createInteractionTranslation({ enabled: true, cacheKey: 'fixed', translateOutput: async (_a: string, _k: string, text: string) => {
    sources.push(text)
    if (text === 'Slow') await new Promise<void>(resolve => { release = resolve })
    return record(text)
  } } as any, () => ({ adapterId: 'opencode', translationEnabled: true }))
  t.after(() => engine.dispose())
  const texts = ['Slow', 'Fast A', 'Fast B', 'Fast C', 'Fast D', 'Fast E']
  const pending = engine.translate(request(texts))
  await tick()
  assert.deepEqual(sources, texts)
  release()
  await pending
})

test('the CLI field translation RPC forwards client cancellation to the active model', async t => {
  const f = modelFixture(() => (async function* () { await new Promise(() => {}); yield {} })())
  t.after(() => f.dispose())
  const table = new CodingNsRpcTable()
  const registry = new CodingNsCliAdapterRegistry([])
  const features = new FeatureRegistry({ rpc: table, sessionTranslation: f.service })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  t.after(() => features.disable('cliAdapters'))
  registry.setSession('s1', { adapterId: 'dsh', translationEnabled: true })
  const controller = new AbortController()
  const handler = table.resolve('cli/translation/fields')!.handler
  const pending = handler('translation/fields', request(['Option description']), { signal: controller.signal })
  await tick()
  assert.equal(f.calls.length, 1)
  controller.abort()
  assert.deepEqual(await pending, { enabled: false, records: {} })
  assert.equal(f.calls[0]!.signal.aborted, true)
})
