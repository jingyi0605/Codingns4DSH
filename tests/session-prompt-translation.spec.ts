import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createSessionPromptAdapter } from '../src/dsh-capabilities/host/session-prompt-adapter.js'
import { createSessionTranslationService } from '../src/host/features/session-translation-service.js'
import { createSessionTranslationRecovery, SessionTranslationCancelled } from '../src/host/features/session-translation-recovery.js'
import { createSessionPromptTranslation } from '../src/host/features/session-prompt-translation.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS } from '../src/shared/contracts/session-translation.js'

const scope = { sessionId: 'session', subagent: false, literals: ['/workspace/中文 目录'] }
const original = '中文描述'

function fixture() {
  const requests: any[] = []
  let failure = false
  let enabled = true
  const service = createSessionTranslationService({ llm: {
    listProviders: () => [{ id: 'test', name: 'Test' }],
    listModels: async () => [{ id: 'model', name: 'Model' }],
    stream(request: any) {
      requests.push(request)
      return (async function* () {
        const text = request.messages[0].content[0].text.split('SOURCE TEXT BEGIN\n')[1].split('\nSOURCE TEXT END')[0]
        yield { type: 'text-delta', text: text.replaceAll(original, 'Translated description') }
        yield { type: 'finish', reason: { kind: failure ? 'max-tokens' : 'stop' } }
      })()
    },
  } }, '0.2.1-alpha.3')!
  service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, nativeEnabled: true })
  service.activate()
  const recovery = createSessionTranslationRecovery(service, () => ({ adapterId: 'dsh', translationEnabled: enabled }))
  const context = createSessionPromptTranslation(service, () => enabled ? 'dsh' : undefined)
  return { service, recovery, context, requests, fail(value: boolean) { failure = value }, enable(value: boolean) { enabled = value },
    dispose() { context.dispose(); recovery.dispose(); service.dispose() } }
}

test('assembly translates descriptions without changing schemas, variables, or runtime facts', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const data = { description: '中文数据' }
  const tool = {
    name: 'agent_subagent', description: `${original} agent_subagent action=start`,
    parameters: { type: 'object', properties: {
      action: { type: 'string', description: original, enum: ['start', '中文枚举'] },
      settings: { type: 'object', description: original, default: data, examples: [data], enum: [data], const: data },
      description: { type: 'string', description: original },
    }, required: ['action'], additionalProperties: false, $defs: { nested: { description: original } },
    anyOf: [{ properties: { cwd: { description: `${original} /workspace/中文 目录` } } }] },
  }
  const assembly = { sections: [{ name: 'host', text: `${original} {{working_directory}}` }], tools: [tool],
    variables: { working_directory: '/workspace/中文 目录' }, contexts: [{ name: 'sandbox', text: '原始权限' }] }
  const snapshot = structuredClone(assembly)
  const translated = await f.context.translateAssembly(assembly, scope) as typeof assembly
  assert.equal(translated.sections[0].text, 'Translated description {{working_directory}}')
  assert.equal(translated.tools[0].description, 'Translated description agent_subagent action=start')
  assert.equal(translated.tools[0].parameters.properties.action.description, 'Translated description')
  assert.equal(translated.tools[0].parameters.properties.description.description, 'Translated description')
  assert.deepEqual(translated.tools[0].parameters.properties.settings.default, data)
  assert.deepEqual(translated.tools[0].parameters.properties.settings.enum, [data])
  assert.deepEqual(translated.tools[0].parameters.properties.action.enum, ['start', '中文枚举'])
  assert.equal(translated.tools[0].parameters.anyOf[0].properties.cwd.description, 'Translated description /workspace/中文 目录')
  assert.deepEqual(translated.variables, assembly.variables)
  assert.deepEqual(translated.contexts, assembly.contexts)
  assert.deepEqual(assembly, snapshot)
  const sent = JSON.stringify(f.requests.map(request => request.messages))
  assert.doesNotMatch(sent, /中文 目录|中文枚举|agent_subagent|working_directory/u)
})

test('injected catalogs preserve provenance and originals while exposing prose inside host wrappers', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const source = { kind: 'skill-catalog', form: 'catalog', entries: [{ name: '技能名', description: original }] }
  const message = { id: 'catalog', role: 'user' as const, source,
    content: [{ type: 'text', text: `<system-reminder>\n<available_skills>\n- 技能名: ${original}\n</available_skills>\n</system-reminder>` }] }
  const user = { role: 'user' as const, source: { kind: 'user' }, content: original }
  const translated = await f.context.translateMessages([message, user], scope)
  assert.equal(translated[0].source?.kind, 'skill-catalog')
  assert.deepEqual(translated[0].source?.codingnsTranslationContext?.originalContent, message.content)
  assert.deepEqual((translated[0].source as any).entries, source.entries)
  assert.match((translated[0].content as any)[0].text, /技能名: Translated description/u)
  assert.equal(translated[1], user)
  assert.match(message.content[0].text, /中文描述/u)
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /技能名/u)
})

test('context cache follows settings and lifecycle and never rewrites excluded sessions', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const assembly = { sections: [{ name: 'host', text: original }], tools: [] }
  await f.context.translateAssembly(assembly, scope)
  await f.context.translateAssembly(assembly, scope)
  assert.equal(f.requests.length, 1)
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, inputLanguage: 'fr', nativeEnabled: true })
  await f.context.translateAssembly(assembly, scope)
  assert.equal(f.requests.length, 2)
  f.enable(false)
  assert.equal(await f.context.translateAssembly(assembly, scope), assembly)
  f.enable(true)
  assert.equal(await f.context.translateAssembly(assembly, { ...scope, subagent: true }), assembly)
  f.service.deactivate(); f.service.activate()
  await f.context.translateAssembly(assembly, scope)
  assert.equal(f.requests.length, 3)
  f.context.dispose()
  await assert.rejects(f.context.translateAssembly(assembly, scope), SessionTranslationCancelled)
})

test('failed internal translation keeps the original without a user decision and is not cached', { timeout: 1000 }, async t => {
  const f = fixture(); t.after(() => f.dispose())
  f.fail(true)
  const assembly = { sections: [{ name: 'host', text: original }], tools: [] }
  assert.deepEqual(await f.context.translateAssembly(assembly, scope), assembly)
  assert.deepEqual(f.recovery.pending({ sessionId: 'session' }), [])
  f.fail(false)
  const next = await f.context.translateAssembly(assembly, scope)
  assert.equal(next.sections[0].text, 'Translated description')
  assert.equal(f.requests.length, 2)
})

test('a failing model never exposes internal tool descriptions as pending user messages', { timeout: 1000 }, async t => {
  const f = fixture(); t.after(() => f.dispose())
  f.fail(true)
  const assembly = { sections: [], tools: Array.from({ length: 12 }, (_, index) => ({
    name: `agent_subagent_${index}`, description: `${original} agent_subagent action=start ${index}`,
    parameters: { type: 'object', properties: { action: { type: 'string', description: `${original} action ${index}` } } },
  })) }
  const snapshot = structuredClone(assembly)
  assert.deepEqual(await f.context.translateAssembly(assembly, scope), snapshot)
  assert.deepEqual(assembly, snapshot)
  assert.deepEqual(f.recovery.pending({ sessionId: 'session' }), [])
  assert.ok(f.requests.length > 0 && f.requests.length <= 4, 'queued fields stop requesting the failing model')

  const message = f.recovery.translateInput('session', 'dsh', '对话测试')
  for (let attempt = 0; attempt < 30 && f.recovery.pending({ sessionId: 'session' }).length === 0; attempt++) await new Promise(resolve => setImmediate(resolve))
  const pending = f.recovery.pending({ sessionId: 'session' })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].record.original, '对话测试')
  f.recovery.resolve({ sessionId: 'session', id: pending[0].id, choice: 'send' })
  assert.equal((await message).translated, '对话测试')
})

test('failed injected translations preserve provenance and never request a sending decision', { timeout: 1000 }, async t => {
  const f = fixture(); t.after(() => f.dispose())
  f.fail(true)
  const messages = ['skill-catalog', 'agent-instructions'].map(kind => ({ role: 'user' as const,
    source: { kind }, content: `<system-reminder>${original} ${kind}</system-reminder>` }))
  const snapshot = structuredClone(messages)
  const translated = await f.context.translateMessages(messages, scope)
  assert.deepEqual(messages, snapshot)
  translated.forEach((message, index) => {
    assert.equal(message.content, messages[index].content)
    assert.equal(message.source?.kind, messages[index].source.kind)
    assert.equal(message.source?.codingnsTranslationContext?.records[0].failed, true)
  })
  assert.deepEqual(f.recovery.pending({ sessionId: 'session' }), [])
})

test('deactivation cancels internal translation even when the provider ignores abort', { timeout: 1000 }, async t => {
  const f = fixture(); t.after(() => f.dispose())
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  f.service.translateInputDetailed = () => { started(); return new Promise(() => {}) }
  const result = f.context.translateAssembly({ sections: [{ name: 'host', text: original }], tools: [] }, scope)
  const rejected = assert.rejects(result, SessionTranslationCancelled)
  await entered
  f.service.deactivate()
  await rejected
  assert.deepEqual(f.recovery.pending({ sessionId: 'session' }), [])
})

test('prompt capability rejects unverified versions and absent assembly services', () => {
  const ctx = { on() {}, systemPrompt: { assemble() {} } }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.1-alpha.4']) {
    const profile = createDshCapabilityRegistry(version, 'host', ctx).getProfile(ctx)
    assert.equal(profile.capabilities.get('session.prompt-assembly')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some(item => item.capability === 'session.prompt-assembly' && item.code === 'CAPABILITY_VERSION_UNSUPPORTED'))
  }
  assert.equal(createDshCapabilityRegistry('0.2.1-alpha.3', 'host', ctx).getProfile(ctx).capabilities.get('session.prompt-assembly')?.status, 'ready')
  assert.equal(createDshCapabilityRegistry('0.2.1-alpha.3', 'host', {}).getProfile({}).capabilities.get('session.prompt-assembly')?.status, 'unavailable')
})

test('real DSH assembly accepts translated copies, enforces complete sections, and releases the hook', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const ctx = new Context()
  const prompts = new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: true })
  prompts.section({ name: 'test', order: 0, text: original })
  const schema = { name: 'test', description: original, parameters: { type: 'object' } }
  prompts.tools(() => ({ schemas: [schema] }))
  // Existing DSH contributors run before the plugin registers its wrapper.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, sections: [...assembled.sections, { name: 'late', text: original }] }
  })
  const dispose = createSessionPromptAdapter(ctx).install((assembly, context) => f.context.translateAssembly(assembly, context))
  t.after(dispose)
  const agent = { id: 'session' }
  const result = await prompts.assemble({ agent, scope: agent } as never)
  assert.equal(result.sections.find(section => section.name === 'test')?.text, 'Translated description')
  assert.equal(result.tools[0].description, 'Translated description')
  assert.equal(result.sections.find(section => section.name === 'late')?.text, 'Translated description')
  assert.equal(schema.description, original)
  const removeComplete = prompts.section({ name: 'complete', order: 1, complete: true, text: original })
  const complete = await prompts.assemble({ agent, scope: agent } as never)
  assert.equal(complete.sections.length, 1)
  assert.equal(complete.sections[0].text, original)
  removeComplete(); dispose()
  const unchanged = await prompts.assemble({ agent, scope: agent } as never)
  assert.equal(unchanged.tools[0].description, original)
})
