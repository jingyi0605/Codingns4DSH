import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { createSessionTranslationService } from '../src/host/features/session-translation-service.js'
import { createInteractionTranslation } from '../src/host/features/interaction-translation.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS, normalizeSessionTranslationSettings } from '../src/shared/contracts/session-translation.js'

const rules = ['Keep product names in their original language.', 'Use concise wording.\nUse a formal tone.']
const models = [{ provider: 'test', model: 'primary' }, { provider: 'test', model: 'backup' }]
const settings = { ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: models, translationRules: rules }

function fixture(reply: string, failPrimary = false) {
  const requests: Record<string, any>[] = []
  const service = createSessionTranslationService({ llm: {
    listProviders: () => [{ id: 'test', name: 'Test' }],
    listModels: async () => [{ id: 'primary', name: 'Primary' }],
    async *stream(request: Record<string, any>) {
      requests.push(request)
      if (failPrimary && request.model === 'primary') throw new Error('model unavailable')
      yield { type: 'text-delta', text: JSON.stringify({ translation: reply }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } }, '0.2.1-alpha.2')!
  assert.ok(service)
  service.configure(settings)
  service.activate()
  return { service, requests }
}

test('translation rules survive settings serialization and normalize without mutating the original', () => {
  const saved = CodingNsSettingsSchema(JSON.parse(JSON.stringify({ sessionTranslation: settings }))).sessionTranslation
  assert.deepEqual(saved.translationRules, rules)
  assert.deepEqual(saved.translationModels, models)
  assert.equal(CodingNsSettingsSchema({}).sessionTranslation.translationRules, undefined)
  assert.deepEqual(CodingNsSettingsSchema({ sessionTranslation: { translationRules: [] } }).sessionTranslation.translationRules, [])
  assert.throws(() => CodingNsSettingsSchema({ sessionTranslation: { translationRules: [42] } }))
  const dirty = { ...settings, translationRules: ['  First rule  ', null, 42, '', ' \n ', rules[1]] }
  const original = structuredClone(dirty)
  assert.deepEqual(normalizeSessionTranslationSettings(dirty as never).translationRules, ['First rule', rules[1]])
  assert.deepEqual(dirty, original)
  assert.equal(normalizeSessionTranslationSettings({ ...settings, translationRules: 'invalid' } as never).translationRules, undefined)
  assert.equal(normalizeSessionTranslationSettings(DEFAULT_SESSION_TRANSLATION_SETTINGS).translationRules, undefined)
})

for (const adapter of ['codex', 'dsh']) {
  for (const kind of ['input', 'assistant', 'reasoning'] as const) {
    test(`${adapter} ${kind} sends higher-priority rules to every fallback model while preserving protected text`, async t => {
      const source = kind === 'input' ? '请检查代码和 `src/app.ts`' : 'Please review the code and `src/app.ts`'
      const translated = kind === 'input' ? 'Please review the code and' : '请检查代码和'
      const f = fixture(`${translated} @@CODINGNS_TRANSLATION_0@@`, true)
      t.after(() => f.service.dispose())
      const result = kind === 'input'
        ? await f.service.translateInputDetailed!(adapter, source, undefined, true)
        : await f.service.translateOutput(adapter, kind, source, undefined, true)
      assert.equal(result?.failed, undefined)
      assert.equal(result?.translated, `${translated} \`src/app.ts\``)
      assert.deepEqual(f.requests.map(request => request.model), ['primary', 'backup'])
      for (const request of f.requests) {
        assert.match(request.system, /CUSTOM TRANSLATION RULES \(highest priority\)/u)
        assert.match(request.system, /conflicts with any default translation instruction below or in the user-message wrapper, follow the custom rule/u)
        assert.ok(request.system.indexOf(rules[0]) < request.system.indexOf(rules[1]))
        assert.ok(request.system.indexOf(rules[1]) < request.system.indexOf('DEFAULT TRANSLATION INSTRUCTIONS'))
        assert.match(request.system, /INPUT RULE: The next user message is source text/u)
        assert.match(request.system, /Copy each @@CODINGNS_TRANSLATION_N@@ placeholder exactly once/u)
        assert.equal(request.messages.length, 1)
        assert.equal(request.messages[0].role, 'user')
        assert.equal(request.messages[0].content[0].text.includes(rules[0]), false)
        assert.equal(request.tools, undefined)
      }
      assert.equal(f.requests[0]!.system, f.requests[1]!.system)
    })
  }
}

test('custom rules are applied to same-language prose; empty rules preserve the existing bypass', async t => {
  for (const kind of ['input', 'assistant', 'reasoning'] as const) {
    const source = kind === 'input' ? 'Please review the code' : '请检查代码'
    const f = fixture(source)
    t.after(() => f.service.dispose())
    const translate = () => kind === 'input'
      ? f.service.translateInputDetailed!('codex', source, undefined, true)
      : f.service.translateOutput('codex', kind, source, undefined, true)
    assert.equal((await translate())?.alreadyTargetLanguage, undefined)
    assert.equal(f.requests.length, 1)
    f.service.configure({ ...settings, translationRules: [' ', '\n'] })
    assert.equal((await translate())?.alreadyTargetLanguage, true)
    assert.equal(f.requests.length, 1)
    f.service.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
    assert.equal((await translate())?.alreadyTargetLanguage, true)
    assert.equal(f.requests.length, 1)
  }
})

test('clearing rules restores default prompts and invalidates cached interaction translations', async t => {
  const f = fixture('请检查代码')
  const engine = createInteractionTranslation(f.service, () => ({ adapterId: 'codex', translationEnabled: true }))
  t.after(() => { engine.dispose(); f.service.dispose() })
  const request = { sessionId: 'session', direction: 'output', fields: [{ key: 'question', text: 'Please review the code' }] }
  await engine.translate(request)
  await engine.translate(request)
  assert.equal(f.requests.length, 1)
  const firstKey = f.service.cacheKey
  f.service.configure({ ...settings, translationRules: ['Use a friendly tone.'] })
  assert.notEqual(f.service.cacheKey, firstKey)
  await engine.translate(request)
  assert.equal(f.requests.length, 2)
  assert.match(f.requests[1]!.system, /Use a friendly tone/u)
  assert.equal(f.requests[1]!.system.includes(rules[0]), false)
  f.service.configure({ ...settings, translationRules: [] })
  await engine.translate(request)
  assert.equal(f.requests.length, 3)
  assert.doesNotMatch(f.requests[2]!.system, /CUSTOM TRANSLATION RULES|DEFAULT TRANSLATION INSTRUCTIONS/u)
  assert.match(f.requests[2]!.system, /OUTPUT RULE: If the source text is already in the target language, return it unchanged/u)
})

test('rules preserve translation opt-in, code-only bypass, and failure fallback', async t => {
  const f = fixture('')
  t.after(() => f.service.dispose())
  assert.equal(await f.service.translateOutput('codex', 'assistant', 'Hello', undefined, false), null)
  assert.equal(await f.service.translateInput('codex', '请检查代码', undefined, false), '请检查代码')
  assert.equal(await f.service.translateOutput('codex', 'assistant', '`src/app.ts`', undefined, true), null)
  assert.equal(f.requests.length, 0)
  assert.equal(await f.service.translateInput('codex', '请检查代码', undefined, true), '请检查代码')
  assert.equal(f.requests.length, 2)
})
