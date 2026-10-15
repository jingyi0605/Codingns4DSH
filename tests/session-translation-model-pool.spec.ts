import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createSessionTranslationService } from '../data/build/dist/host/features/session-translation-service.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'
import {
  DEFAULT_SESSION_TRANSLATION_SETTINGS,
  normalizeSessionTranslationSettings,
} from '../data/build/dist/shared/contracts/session-translation.js'
import type { SessionTranslationModel } from '../src/shared/contracts/session-translation.js'

const primary = { provider: 'primary-provider', model: 'primary' }
const secondary = { provider: 'backup-provider', model: 'secondary' }
const tertiary = { provider: 'backup-provider', model: 'tertiary' }
type Request = Record<string, any>

function fixture(stream: (request: Request) => AsyncIterable<Request>, pool: readonly SessionTranslationModel[] = [primary, secondary, tertiary]) {
  const requests: Request[] = []
  const runtime = {
    listProviders: () => [{ id: 'default-provider', name: 'Default' }],
    listModels: async () => [{ id: 'default-model', name: 'Default Model' }],
    resolveModelInfo: async (_provider: string, model: string) => ({ reasoning: { efforts: [{ id: model === primary.model ? 'off' : 'none' }] } }),
    stream(request: Request) { requests.push(request); return stream(request) },
  }
  const service = createSessionTranslationService({
    llm: runtime,
    get: (name: string) => name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
      : undefined,
  }, '0.2.1-alpha.2')!
  assert.ok(service)
  service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: pool })
  service.activate()
  return { service, runtime, requests }
}

async function* response(text: string): AsyncIterable<Request> {
  yield { type: 'text-delta', text: JSON.stringify({ translation: text }) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

for (const kind of ['input', 'assistant', 'reasoning'] as const) {
  test(`${kind} metrics include fallback time and usage without double-counting snapshots`, async (t) => {
    let now = 100
    t.mock.method(performance, 'now', () => now)
    const f = fixture((request) => (async function* () {
      now += 600
      if (request.model === primary.model) {
        yield { type: 'usage', usage: { totalTokens: 20, inputTokens: 10, outputTokens: 10 } }
        throw new Error('connection lost')
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 5 } }
      yield { type: 'text-delta', text: JSON.stringify({ translation: kind === 'input' ? 'Please review the code' : '请检查代码' }) }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    t.after(() => f.service.dispose())
    const result = kind === 'input'
      ? await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
      : await f.service.translateOutput('codex', kind, 'Please review the code', undefined, true)
    assert.equal(result?.durationMs, 1200)
    assert.equal(result?.totalTokens, 70)
    assert.deepEqual(result?.model, secondary)
  })
}

test('translation metrics leave unreported usage absent and retain reported usage on failure', async (t) => {
  const f = fixture(() => response('Please review the code'))
  t.after(() => f.service.dispose())
  const result = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
  assert.ok(result.durationMs! >= 0)
  assert.equal(result.totalTokens, undefined)
  f.runtime.stream = () => (async function* () {
    yield { type: 'usage', usage: { totalTokens: 12 } }
    throw new Error('connection lost')
  })()
  const failed = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
  assert.equal(failed.failed, true)
  assert.equal(failed.totalTokens, 36)
  assert.ok(failed.durationMs! >= 0)
})

test('model pool normalization preserves priority, trims identifiers, and removes duplicate or invalid entries', () => {
  const settings = {
    ...DEFAULT_SESSION_TRANSLATION_SETTINGS,
    translationModels: [
      { provider: ' primary-provider ', model: ' primary ' }, secondary, primary,
      { provider: '', model: 'invalid' }, null, 'invalid', { provider: 'provider', model: 42 }, tertiary,
    ],
  }
  const original = structuredClone(settings)
  const normalized = normalizeSessionTranslationSettings(settings as never)
  assert.deepEqual(normalized.translationModels, [primary, secondary, tertiary])
  assert.deepEqual(settings, original)
  assert.equal(normalizeSessionTranslationSettings({ ...settings, translationModels: {} } as never).translationModels, undefined)
})

test('settings schema round-trips an ordered pool and keeps legacy and empty settings valid', () => {
  const saved = CodingNsSettingsSchema({ sessionTranslation: { translationModels: [secondary, primary] } }).sessionTranslation
  assert.deepEqual(saved.translationModels, [secondary, primary])
  assert.deepEqual(CodingNsSettingsSchema({ sessionTranslation: { translationModels: [] } }).sessionTranslation.translationModels, [])
  assert.deepEqual(CodingNsSettingsSchema({ sessionTranslation: { translationModel: primary } }).sessionTranslation.translationModel, primary)
  assert.equal(CodingNsSettingsSchema({}).sessionTranslation.translationModels, undefined)
})

for (const kind of ['input', 'assistant', 'reasoning'] as const) {
  test(`${kind} translation falls back in priority order and records the successful model`, async () => {
    const text = kind === 'input' ? '请检查代码和 `src/app.ts`' : 'Please review the code and `src/app.ts`'
    const expected = kind === 'input' ? 'Please review the code and `src/app.ts`' : '请检查代码和 `src/app.ts`'
    const f = fixture((request) => {
      if (request.model === primary.model) throw new Error('model unavailable')
      return response(kind === 'input' ? 'Please review the code and @@CODINGNS_TRANSLATION_0@@' : '请检查代码和 @@CODINGNS_TRANSLATION_0@@')
    })
    const result = kind === 'input'
      ? await f.service.translateInputDetailed!('codex', text, undefined, true)
      : await f.service.translateOutput('dsh', kind, text, undefined, true)
    assert.equal(result?.translated, expected)
    assert.deepEqual(result?.model, secondary)
    assert.equal(result?.failed, undefined)
    assert.deepEqual(f.requests.map((request) => request.model), [primary.model, secondary.model])
    assert.deepEqual(f.requests.map((request) => request.reasoningEffort), ['off', 'none'])
    for (const request of f.requests) {
      assert.equal(request.codingnsTranslation, true)
      assert.equal(request.temperature, 0)
      assert.match(request.messages[0].content[0].text, /@@CODINGNS_TRANSLATION_0@@/u)
    }
    f.service.dispose()
  })
}

test('empty, invalid, and partial failed responses are discarded before trying the next model', async () => {
  for (const failure of ['empty', 'wrong-language', 'stream-error', 'finish-error', 'max-tokens', 'missing-finish']) {
    const f = fixture((request) => request.model !== primary.model ? response('Please review the code') : (async function* () {
      if (failure === 'wrong-language') yield { type: 'text-delta', text: JSON.stringify({ translation: '好的，我会检查代码' }) }
      if (['stream-error', 'finish-error', 'max-tokens', 'missing-finish'].includes(failure)) yield { type: 'text-delta', text: 'partial text that must be discarded' }
      if (failure === 'missing-finish') return
      if (failure === 'stream-error') throw new Error('connection lost')
      yield { type: 'finish', reason: { kind: failure === 'finish-error' ? 'error' : failure === 'max-tokens' ? 'max-tokens' : 'stop' } }
    })())
    const result = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
    assert.equal(result.translated, 'Please review the code', failure)
    assert.deepEqual(result.model, secondary, failure)
    assert.deepEqual(f.requests.map((request) => request.model), [primary.model, secondary.model])
    f.service.dispose()
  }
})

test('failure while resolving model metadata advances to the next model', async () => {
  const f = fixture(() => response('Please review the code'))
  const resolve = f.runtime.resolveModelInfo
  f.runtime.resolveModelInfo = async (provider, model) => {
    if (model === primary.model) throw new Error('model not found')
    return resolve(provider, model)
  }
  const result = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
  assert.deepEqual(result.model, secondary)
  assert.deepEqual(f.requests.map((request) => request.model), [secondary.model])
  f.service.dispose()
})

test('each request starts at the highest priority and success stops further attempts', async () => {
  const f = fixture(() => response('Please review the code'))
  for (let index = 0; index < 2; index++) await f.service.translateInput('codex', '请检查代码', undefined, true)
  assert.deepEqual(f.requests.map((request) => request.model), [primary.model, primary.model])
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [tertiary, secondary, primary] })
  const result = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
  assert.deepEqual(result.model, tertiary)
  f.service.dispose()
})

test('all pool failures keep original input and output without using unselected defaults', async () => {
  const f = fixture(() => { throw new Error('unavailable') })
  const input = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
  assert.equal(input.translated, '请检查代码')
  assert.equal(input.failed, true)
  assert.deepEqual(input.model, tertiary)
  const output = await f.service.translateOutput('dsh', 'assistant', 'Please review the code', undefined, true)
  assert.equal(output?.translated, 'Please review the code')
  assert.equal(output?.original, 'Please review the code')
  assert.equal(output?.failed, true)
  assert.deepEqual(output?.model, tertiary)
  assert.deepEqual(f.requests.map((request) => request.model), [primary.model, secondary.model, tertiary.model, primary.model, secondary.model, tertiary.model])
  f.service.dispose()
})

test('an absent pool honors the legacy selection and an empty pool overrides it with the default', async () => {
  const f = fixture(() => response('Please review the code'))
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModel: primary })
  const legacy = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
  assert.deepEqual(legacy.model, primary)
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModel: primary, translationModels: [] })
  const cleared = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
  assert.deepEqual(cleared.model, { provider: 'default-provider', model: 'default-model' })
  f.service.dispose()
})

test('external Agent providers are skipped without changing the remaining priorities', async () => {
  const f = fixture(() => response('Please review the code'), [{ provider: 'codex', model: 'external' }, secondary])
  const result = await f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
  assert.deepEqual(result.model, secondary)
  assert.deepEqual(f.requests.map((request) => request.model), [secondary.model])
  f.service.dispose()
})

test('text already in the target language skips the entire model pool', async () => {
  const f = fixture(() => { throw new Error('unexpected request') })
  const input = await f.service.translateInputDetailed!('codex', 'Please review the code', undefined, true)
  assert.equal(input.alreadyTargetLanguage, true)
  assert.equal(input.durationMs, 0)
  assert.equal(input.totalTokens, 0)
  const output = await f.service.translateOutput('codex', 'assistant', '请检查代码', undefined, true)
  assert.equal(output?.alreadyTargetLanguage, true)
  assert.equal(output?.durationMs, 0)
  assert.equal(output?.totalTokens, 0)
  assert.equal(f.requests.length, 0)
  f.service.dispose()
})

for (const phase of ['metadata', 'stream'] as const) {
  test(`a ${phase} timeout advances to the next model even if the provider ignores cancellation`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture((request) => request.model === primary.model
      ? (async function* () { await new Promise(() => {}); yield {} })()
      : response('Please review the code'))
    t.after(() => f.service.dispose())
    if (phase === 'metadata') {
      const resolve = f.runtime.resolveModelInfo
      f.runtime.resolveModelInfo = async (provider, model) => model === primary.model ? new Promise(() => {}) : resolve(provider, model)
    }
    const pending = f.service.translateInputDetailed!('codex', '请检查代码', undefined, true)
    await setImmediate()
    t.mock.timers.tick(30_000)
    const result = await pending
    assert.equal(result.translated, 'Please review the code')
    assert.deepEqual(result.model, secondary)
    if (phase === 'stream') assert.equal(f.requests[0].signal.aborted, true)
  })
}

test('caller cancellation ends a pending attempt without calling subsequent models', async () => {
  const f = fixture(() => (async function* () { await new Promise(() => {}); yield {} })())
  const controller = new AbortController()
  const pending = f.service.translateInputDetailed!('codex', '请检查代码', controller.signal, true)
  await setImmediate()
  controller.abort(new Error('user cancelled'))
  const result = await pending
  assert.equal(result.translated, '请检查代码')
  assert.equal(result.failed, true)
  assert.equal(f.requests.length, 1)
  const cancelled = await f.service.translateInputDetailed!('codex', '请检查代码', controller.signal, true)
  assert.equal(cancelled.failed, true)
  assert.equal(f.requests.length, 1)
  f.service.dispose()
})
