import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createSessionTranslationService } from '../src/host/features/session-translation-service.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS, SESSION_TRANSLATION_ADAPTER_IDS } from '../src/shared/contracts/session-translation.js'

// Exact input and returned text from session-002f7258, event 9; no session metadata.
const reported = JSON.parse(readFileSync(new URL('./fixtures/session-translation-commentary.json', import.meta.url), 'utf8')) as { original: string; response: string }
const translated = 'Please add a settings icon beside the conversation translation toggle. Open settings for translating user messages, AI reasoning, and AI final replies. Enable all three toggles by default.'
type Request = Record<string, any>

async function* response(text: string): AsyncIterable<Request> {
  yield { type: 'text-delta', text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function fixture(stream: (request: Request) => AsyncIterable<Request>) {
  const requests: Request[] = []
  const service = createSessionTranslationService({ llm: {
    listProviders: () => [{ id: 'test', name: 'Test' }],
    listModels: async () => [{ id: 'primary', name: 'Primary' }],
    stream(request: Request) { requests.push(request); return stream(request) },
  } }, '0.2.1-alpha.3')!
  assert.ok(service)
  service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [
    { provider: 'test', model: 'primary' }, { provider: 'test', model: 'backup' },
  ] })
  service.activate()
  return { service, requests }
}

function routing(service: ReturnType<typeof fixture>['service'], adapterId: string) {
  let preStep: (payload: any, next: () => Promise<any>) => Promise<any>
  let stream: (options: any, next: () => AsyncIterable<any>) => AsyncIterable<any>
  const executions: any[] = []
  const table = new CodingNsRpcTable()
  const registry = new CodingNsCliAdapterRegistry(adapterId === 'dsh' ? [] : [{
    descriptor: { id: adapterId, name: adapterId },
    async detect() { return { installed: true, version: 'test', command: 'fake-agent' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) { executions.push(input); yield { type: 'finish' as const, reason: 'stop' as const } },
  }])
  const features = new FeatureRegistry({
    rpc: table,
    sessionTranslation: service,
    events: { on(name, listener) { if (name === 'llm/stream') stream = listener as typeof stream; return () => {} } },
    dshContext: { get() {}, on(name: string, listener: typeof preStep) { if (name === 'agent/pre-step') preStep = listener; return () => {} } } as never,
    nativeSessions: {
      available: true,
      get() { return { header: { cwd: '/workspace' } } },
      list() { return [] },
      subscribe() { return () => {} },
    } as never,
  })
  features.register(createCliAdaptersFeature({ registry }))
  return {
    features, executions,
    async start() { await features.start('cliAdapters'); registry.setSession('translation-result', { adapterId, translationEnabled: true }) },
    preStep(next: () => Promise<any>) {
      const message = { id: 'reported-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: reported.original }] }
      return preStep({ agent: { id: 'translation-result' }, messages: [message] }, async () => { await next(); return { kind: 'enter', messages: [message] } })
    },
    async dispatch(messages: any[]) {
      for await (const _ of stream({ sessionId: 'translation-result', messages }, async function* () { executions.push({ messages }) })) {}
    },
    async rpc(action: string, payload: Record<string, unknown> = {}) {
      const target = table.resolve(`cli/translation/${action}`)!
      return await target.handler(target.action, { sessionId: 'translation-result', ...payload }) as any
    },
  }
}

for (const adapter of ['dsh', ...SESSION_TRANSLATION_ADAPTER_IDS]) {
  test(`${adapter} receives only the final translation after rejecting the reported commentary`, async t => {
    const f = fixture(request => response(request.model === 'primary' ? reported.response : JSON.stringify({ translation: translated })))
    const host = routing(f.service, adapter)
    t.after(async () => { await host.features.disable('cliAdapters'); f.service.dispose() })
    await host.start()
    const decision = await host.preStep(async () => {})
    assert.equal(decision.messages[0].source.codingnsTranslationInput.translated, translated)
    await host.dispatch(decision.messages)
    assert.equal(host.executions.length, 1)
    const received = host.executions[0]
    if (adapter !== 'dsh') assert.equal(received.prompt, translated)
    assert.equal(received.messages[0].content[0].text, translated)
    assert.deepEqual(f.requests.map(request => request.model), ['primary', 'backup'])
  })
}

test('commentary and malformed result envelopes fail without extracting a plausible substring', async t => {
  const good = JSON.stringify({ translation: translated })
  for (const invalid of [
    reported.response, `${reported.response}\n${good}`, `${good}\nTranslation complete.`,
    `<think>We must output only the translation.</think>\n${good}`, `\`\`\`json\n${good}\n\`\`\``,
    JSON.stringify({ reasoning: 'We need to translate this.', translation: translated }),
    JSON.stringify({ translation: null }), JSON.stringify({ translation: [translated] }),
    JSON.stringify({ translated }), JSON.stringify([translated]), JSON.stringify(translated),
    '{"translation":"incomplete', '{"translation":""}',
  ]) {
    const f = fixture(() => response(invalid))
    t.after(() => f.service.dispose())
    const result = await f.service.translateInputDetailed!('codex', reported.original, undefined, true)
    assert.equal(result.failed, true, invalid)
    assert.equal(result.failure?.code, 'invalid-response', invalid)
    assert.equal(result.translated, reported.original, invalid)
  }
})

for (const adapter of ['dsh', 'codex']) {
  test(`${adapter} holds a rejected result until the user chooses the original message`, async t => {
    const f = fixture(() => response(reported.response))
    const host = routing(f.service, adapter)
    t.after(async () => { await host.features.disable('cliAdapters'); f.service.dispose() })
    await host.start()
    let entered = false
    const pending = host.preStep(async () => { entered = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(entered, false)
    assert.equal(host.executions.length, 0)
    const [request] = await host.rpc('pending')
    assert.equal(request.record.failure.code, 'invalid-response')
    assert.equal(request.record.translated, reported.original)
    await host.rpc('resolve', { id: request.id, choice: 'send' })
    const decision = await pending
    await host.dispatch(decision.messages)
    assert.equal(host.executions[0].messages[0].content[0].text, reported.original)
    if (adapter !== 'dsh') assert.equal(host.executions[0].prompt, reported.original)
  })
}

test('streamed JSON preserves final text and protected code while reasoning stays separate', async t => {
  const expected = 'Please use "translation" as the label.\nThen run `pnpm test`.'
  const f = fixture(() => (async function* () {
    yield { type: 'reasoning-delta', text: reported.response }
    const encoded = JSON.stringify({ translation: 'Please use "translation" as the label.\nThen run @@CODINGNS_TRANSLATION_0@@.' })
    for (const text of encoded) yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  t.after(() => f.service.dispose())
  const result = await f.service.translateInputDetailed!('codex', '请使用翻译作为标签。\n然后运行 `pnpm test`。', undefined, true)
  assert.equal(result.translated, expected)
  assert.equal(result.failed, undefined)
})

test('legitimate translation requests are retained without keyword filtering', async t => {
  const expected = 'We need to translate the source text into English. Output only the translation.'
  const f = fixture(() => response(JSON.stringify({ translation: expected })))
  t.after(() => f.service.dispose())
  const result = await f.service.translateInputDetailed!('dsh', '我们需要将原文翻译成英文。只输出译文。', undefined, true)
  assert.equal(result.translated, expected)
  assert.equal(result.failed, undefined)
})

for (const kind of ['assistant', 'reasoning'] as const) {
  test(`${kind} output rejects commentary with the same response contract`, async t => {
    const f = fixture(request => response(request.model === 'primary' ? reported.response : JSON.stringify({ translation: '代码已更新。' })))
    t.after(() => f.service.dispose())
    const result = await f.service.translateOutput('dsh', kind, 'The code has been updated.', undefined, true)
    assert.equal(result?.translated, '代码已更新。')
    assert.deepEqual(f.requests.map(request => request.model), ['primary', 'backup'])
  })
}
