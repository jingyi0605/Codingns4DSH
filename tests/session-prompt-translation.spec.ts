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
import { createAgentSubagentTool } from '../src/host/cli-adapters/subagent-tool.js'
import { AGENT_SUBAGENT_DESCRIPTIONS } from '../src/host/cli-adapters/subagent-tool-descriptions.js'

const scope = { sessionId: 'session', subagent: false, literals: ['/workspace/中文 目录'] }
const original = '中文描述'

function fixture(translateText = (text: string) => text.replaceAll(original, 'Translated description')) {
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
        yield { type: 'text-delta', text: JSON.stringify({ translation: translateText(text) }) }
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

test('prompt translation uses the current agent input option instead of the legacy shared value', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const external = createSessionPromptTranslation(f.service, () => 'codex')
  t.after(() => external.dispose())
  const assembly = { sections: [{ name: 'host', text: original }], tools: [] }
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, inputEnabled: false,
    adapterOptions: { dsh: { inputEnabled: true }, codex: { inputEnabled: false } },
  })
  assert.equal((await f.context.translateAssembly(assembly, scope)).sections[0]!.text, 'Translated description')
  assert.equal(await external.translateAssembly(assembly, scope), assembly)
  assert.equal(f.requests.length, 1)
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, inputEnabled: true,
    adapterOptions: { dsh: { inputEnabled: false }, codex: { inputEnabled: true } },
  })
  assert.equal(await f.context.translateAssembly(assembly, scope), assembly)
  assert.equal((await external.translateAssembly(assembly, scope)).sections[0]!.text, 'Translated description')
  assert.equal(f.requests.length, 2)
})

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

test('independent sections, tool descriptions and parameter descriptions start together', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const started: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const translate = f.service.translateInputDetailed!.bind(f.service)
  f.service.translateInputDetailed = async (...args) => {
    started.push(args[1])
    await gate
    return translate(...args)
  }
  const result = f.context.translateAssembly({
    sections: [{ name: 'host', text: `${original} 系统` }],
    tools: [{ name: 'tool', description: `${original} 工具`, parameters: {
      type: 'object', properties: { value: { type: 'string', description: `${original} 参数` } },
    } }],
  }, scope)
  await new Promise(resolve => setImmediate(resolve))
  const firstWave = [...started]
  release()
  const translated = await result
  assert.deepEqual(firstWave.sort(), [`${original} 系统`, `${original} 工具`, `${original} 参数`].sort())
  assert.equal(translated.sections[0]!.text, 'Translated description 系统')
  assert.equal(translated.tools[0]!.description, 'Translated description 工具')
  assert.deepEqual(translated.tools[0]!.parameters, {
    type: 'object', properties: { value: { type: 'string', description: 'Translated description 参数' } },
  })
})

test('identical descriptions reuse translations across tools and workspaces with unrelated literals', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const assembly = { sections: [], tools: ['first_tool', 'second_tool'].map(name => ({
    name, description: original, parameters: {
      type: 'object', properties: { [`${name}_value`]: { type: 'string', description: original } },
    },
  })) }
  await f.context.translateAssembly(assembly, scope)
  await f.context.translateAssembly(assembly, { ...scope, sessionId: 'other-session', literals: ['/other/workspace'] })
  assert.equal(f.requests.length, 1)
})

function subagentAssembly() {
  const tool = createAgentSubagentTool()
  return { sections: [], tools: [{ name: 'agent_subagent', description: tool.description as string, parameters: tool.parameters }] }
}

test('built-in subagent prose uses local English with a cold cache and preserves the schema', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const assembly = subagentAssembly()
  const snapshot = structuredClone(assembly)
  const translated = await f.context.translateAssembly(assembly, scope)
  let expected = JSON.stringify(assembly)
  for (const description of Object.values(AGENT_SUBAGENT_DESCRIPTIONS)) {
    expected = expected.replace(description.zh, description.en)
  }
  assert.deepEqual(translated, JSON.parse(expected))
  assert.deepEqual(assembly, snapshot)
  assert.equal(f.requests.length, 0, 'none of the five built-in fields require a provider request')
  await f.recovery.translateInput('session', 'dsh', original)
  assert.equal(f.requests.length, 1, 'actual user input still follows normal translation')
})

test('custom rules and other target languages retain model translation for built-in prose', async t => {
  const f = fixture(text => text.replace(/[\p{Script=Han}]+/gu, 'Translated'))
  t.after(() => f.dispose())
  const assembly = subagentAssembly()
  await f.context.translateAssembly(assembly, scope)
  assert.equal(f.requests.length, 0)
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationRules: ['Use formal language.'] })
  await f.context.translateAssembly(assembly, scope)
  assert.equal(f.requests.length, 5)
  assert.ok(f.requests.every(request => request.system.includes('Use formal language.')))
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, inputLanguage: 'fr' })
  await f.context.translateAssembly(assembly, scope)
  assert.equal(f.requests.length, 10)
  assert.ok(f.requests.slice(5).every(request => request.system.includes('French')))
  f.service.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  await f.context.translateAssembly(assembly, scope)
  assert.equal(f.requests.length, 10, 'removing custom rules restores the local path')
})

test('local tool prose does not replace modified descriptions, other tools, or human messages', async t => {
  const f = fixture(text => text.replace(/[\p{Script=Han}]+/gu, 'Translated'))
  t.after(() => f.dispose())
  const assembly = subagentAssembly()
  assembly.tools[0]!.description += ' 新增说明'
  const translated = await f.context.translateAssembly(assembly, scope)
  assert.equal(f.requests.length, 1)
  assert.notEqual(translated.tools[0]!.description, AGENT_SUBAGENT_DESCRIPTIONS.tool.en)
  await f.context.translateAssembly({ sections: [], tools: [{ name: 'another_tool', description: AGENT_SUBAGENT_DESCRIPTIONS.prompt.zh }] }, scope)
  assert.equal(f.requests.length, 2)
  await f.recovery.translateInput('session', 'dsh', AGENT_SUBAGENT_DESCRIPTIONS.prompt.zh)
  assert.equal(f.requests.length, 3)
})

test('disabled, excluded, and cancelled sessions cannot take the local tool translation path', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const assembly = subagentAssembly()
  assert.equal(await f.context.translateAssembly(assembly, { ...scope, subagent: true }), assembly)
  f.enable(false)
  assert.equal(await f.context.translateAssembly(assembly, scope), assembly)
  f.enable(true)
  f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, inputEnabled: false })
  assert.equal(await f.context.translateAssembly(assembly, scope), assembly)
  f.service.configure(DEFAULT_SESSION_TRANSLATION_SETTINGS)
  const controller = new AbortController()
  const reason = new Error('Agent cancelled')
  controller.abort(reason)
  await assert.rejects(f.context.translateAssembly(assembly, { ...scope, signal: controller.signal }), reason)
  f.service.deactivate()
  assert.equal(await f.context.translateAssembly(assembly, scope), assembly)
  assert.equal(f.requests.length, 0)
})

test('additional protected schema values retain placeholder protection instead of local wording', async t => {
  const f = fixture(text => text.replace(/[\p{Script=Han}]+/gu, 'Translated'))
  t.after(() => f.dispose())
  const translated = await f.context.translateAssembly({ sections: [], tools: [{
    name: 'agent_subagent', description: AGENT_SUBAGENT_DESCRIPTIONS.prompt.zh,
    parameters: { type: 'object', properties: { 子任务: { type: 'string' } } },
  }] }, scope)
  assert.equal(f.requests.length, 1)
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /子任务/u)
  assert.match(translated.tools[0]!.description!, /子任务/u)
})

test('literals present in a description still separate cache entries and remain protected', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const description = `${original} 工作项`
  const translated = await f.context.translateAssembly({ sections: [], tools: [
    { name: 'first_tool', description, parameters: { type: 'object', properties: { 工作项: { type: 'string' } } } },
    { name: 'second_tool', description, parameters: { type: 'object', properties: { value: { type: 'string' } } } },
  ] }, scope)
  assert.equal(f.requests.length, 2)
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /工作项/u)
  assert.match(JSON.stringify(f.requests[1].messages), /工作项/u)
  assert.ok(translated.tools.every(tool => tool.description === 'Translated description 工作项'))
})

test('queued context translations reuse a result completed by another session', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const calls: string[] = []
  const releases: (() => void)[] = []
  f.service.translateInputDetailed = async (_adapter, text) => {
    calls.push(text)
    if (text.startsWith('blocked')) await new Promise<void>(resolve => { releases.push(resolve) })
    return { translated: 'Translated description' }
  }
  const busy = f.context.translateAssembly({ tools: [], sections: Array.from({ length: 4 }, (_, index) => ({ name: `blocked${index}`, text: `blocked${index}` })) }, scope)
  const assembly = { tools: [], sections: [{ name: 'shared', text: original }] }
  const first = f.context.translateAssembly(assembly, { ...scope, sessionId: 'first' })
  const second = f.context.translateAssembly(assembly, { ...scope, sessionId: 'second' })
  assert.equal(releases.length, 4)
  releases[0]!()
  try {
    const results = await Promise.all([first, second])
    assert.ok(results.every(result => result.sections[0]!.text === 'Translated description'))
    assert.equal(calls.filter(text => text === original).length, 1)
  } finally { releases.forEach(release => release()); await busy }
})

test('cancelling a parallel assembly removes queued fields and releases all four slots', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const calls: string[] = []
  f.service.translateInputDetailed = async (_adapter, text) => {
    calls.push(text)
    if (text !== 'next') return new Promise(() => {})
    return { translated: 'Translated description' }
  }
  const controller = new AbortController()
  const reason = new Error('Agent interrupted')
  const assembly = { sections: [{ name: 'host', text: original }], tools: Array.from({ length: 5 }, (_, index) => ({
    name: `tool_${index}`, description: `${original} ${index}`, parameters: {
      type: 'object', properties: { value: { description: `${original} 参数 ${index}` } },
    },
  })) }
  const pending = f.context.translateAssembly(assembly, { ...scope, signal: controller.signal })
  assert.equal(calls.length, 4)
  controller.abort(reason)
  await assert.rejects(pending, reason)
  const next = await f.context.translateAssembly({ sections: [{ name: 'next', text: 'next' }], tools: [] }, scope)
  assert.equal(next.sections[0]!.text, 'Translated description')
  assert.equal(calls.length, 5, 'cancelled queued fields never reach the provider')
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

test('deactivation cancels internal translation without cancelling the Agent turn', { timeout: 1000 }, async t => {
  const f = fixture(); t.after(() => f.dispose())
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  f.service.translateInputDetailed = () => { started(); return new Promise(() => {}) }
  const assembly = { sections: [{ name: 'host', text: original }], tools: [] }
  const result = f.context.translateAssembly(assembly, scope)
  await entered
  f.service.deactivate()
  assert.equal(await result, assembly)
  assert.deepEqual(f.recovery.pending({ sessionId: 'session' }), [])
})

test('translation settings changing during prompt assembly retain the original prompt', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const translate = f.service.translateInputDetailed!.bind(f.service)
  let changed = false
  f.service.translateInputDetailed = async (...args) => {
    const result = await translate(...args)
    if (!changed) {
      changed = true
      f.service.configure({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, nativeEnabled: true, inputLanguage: 'fr' })
    }
    return result
  }
  const assembly = { sections: [{ name: 'host', text: original }], tools: [] }
  assert.equal(await f.context.translateAssembly(assembly, scope), assembly)
  assert.deepEqual(f.recovery.pending({ sessionId: 'session' }), [])
  assert.notEqual(await f.context.translateAssembly(assembly, scope), assembly, 'The next request uses the new translation settings')
})

test('invalidating internal translation never masks an explicit Agent cancellation', async t => {
  const f = fixture(); t.after(() => f.dispose())
  const controller = new AbortController()
  const reason = new Error('Agent interrupted')
  f.service.translateInputDetailed = async () => {
    controller.abort(reason)
    f.service.deactivate()
    return { translated: 'Translated description' }
  }
  await assert.rejects(f.context.translateAssembly({ sections: [{ name: 'host', text: original }], tools: [] }, { ...scope, signal: controller.signal }), reason)
})

test('prompt capability probes newer hosts and still requires assembly services', () => {
  const ctx = { on() {}, systemPrompt: { assemble() {} } }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2']) {
    const profile = createDshCapabilityRegistry(version, 'host', ctx).getProfile(ctx)
    assert.equal(profile.capabilities.get('session.prompt-assembly')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some(item => item.capability === 'session.prompt-assembly' && item.code === 'CAPABILITY_VERSION_UNSUPPORTED'))
  }
  for (const version of ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.3.0-alpha.1', '1.0.0']) {
    assert.equal(createDshCapabilityRegistry(version, 'host', ctx).getProfile(ctx).capabilities.get('session.prompt-assembly')?.status, 'ready')
    assert.equal(createDshCapabilityRegistry(version, 'host', {}).getProfile({}).capabilities.get('session.prompt-assembly')?.status, 'unavailable')
  }
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
