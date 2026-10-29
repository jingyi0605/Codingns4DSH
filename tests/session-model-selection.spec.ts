import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DSH_TESTED_VERSION } from '../src/shared/contracts/version.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createSessionModelSelectionAdapter, type SessionModelSelection } from '../src/dsh-capabilities/host/session-model-selection-adapter.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'

test('external selection capability rejects unverified versions and missing native accessors', () => {
  const context = { sessionController: { agents: { selectionFor() {} } } }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.1-rc.3']) {
    const profile = createDshCapabilityRegistry(version, 'host', context).getProfile(context)
    assert.equal(profile.capabilities.get('session.external-model-selection')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some(value => value.capability === 'session.external-model-selection' && value.code === 'CAPABILITY_VERSION_UNSUPPORTED'))
  }
  for (const version of ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2']) {
    const supported = createDshCapabilityRegistry(version, 'host', context).getProfile(context)
    assert.equal(supported.capabilities.get('session.external-model-selection')?.status, 'ready')
  }
  for (const context of [{}, { sessionController: {} }, { sessionController: { agents: {} } }]) {
    const profile = createDshCapabilityRegistry('0.2.1-alpha.3', 'host', context).getProfile(context)
    assert.equal(profile.capabilities.get('session.external-model-selection')?.status, 'unavailable')
  }
})

test('external selection view preserves native choices, setters, other sessions and disposal', () => {
  const native = { provider: 'native', model: 'text-only', reasoningEffort: 'high' }
  let nativeChoice: SessionModelSelection = native
  class Owner {
    readonly ref = {
      get current() { return nativeChoice },
      set current(value: SessionModelSelection) { nativeChoice = value },
    }
    readonly other = { current: native }
    selectionFor(agent: { id: string }) { return agent.id === 'external' ? this.ref : this.other }
  }
  const owner = new Owner()
  const original = owner.selectionFor
  let route: SessionModelSelection | undefined = { provider: 'grok', model: 'grok-image-model' }
  const dispose = createSessionModelSelectionAdapter({ agents: owner }).install(id => id === 'external' ? route : undefined)
  const external = { id: 'external' }
  assert.deepEqual(owner.selectionFor(external).current, route)
  assert.equal(nativeChoice, native)
  assert.equal(owner.selectionFor({ id: 'other' }), owner.other)
  owner.selectionFor(external).current = { provider: 'native', model: 'updated' }
  assert.deepEqual(nativeChoice, { provider: 'native', model: 'updated' })
  assert.deepEqual(owner.ref.current, route)
  route = { provider: 'grok', model: 'another-model' }
  assert.deepEqual(owner.selectionFor(external).current, route)
  route = undefined
  assert.equal(owner.selectionFor(external), owner.ref)
  dispose()
  dispose()
  assert.equal(owner.selectionFor, original)
  assert.equal(Object.hasOwn(owner, 'selectionFor'), false)
  assert.deepEqual(owner.ref.current, { provider: 'native', model: 'updated' })
})

test('Cordis method proxies release active selection overrides and preserve native data-property writes', () => {
  const ctx = new Context()
  const native = { provider: 'native', model: 'default' }
  const ref = { current: native as SessionModelSelection }
  const descriptor = Object.getOwnPropertyDescriptor(ref, 'current')!
  const owner = { selectionFor(_agent: { id: string }) { return ref } }
  const original = owner.selectionFor
  ctx.provide('sessionController', { agents: owner })
  const adapter = createSessionModelSelectionAdapter(ctx.get('sessionController'))
  const route = { provider: 'codingns-cli-codex', model: 'selected-codex' }
  const dispose = adapter.install(() => route)
  const agent = { id: 'external' }
  try {
    assert.equal(owner.selectionFor(agent), ref)
    assert.deepEqual(ref.current, route)
    ref.current = { provider: 'native', model: 'updated' }
    assert.deepEqual(ref.current, route)
  } finally { dispose(); dispose() }
  assert.equal(owner.selectionFor, original)
  assert.deepEqual(ref.current, { provider: 'native', model: 'updated' })
  assert.deepEqual(Object.getOwnPropertyDescriptor(ref, 'current'), { ...descriptor, value: ref.current })
})

// Import installed Stage0 libraries into memory only: no launcher, profile,
// persistence, network, server or external CLI is used by this regression.
const runtime = process.env.CODINGNS_STAGE0_RUNTIME_DIR
  ?? join(homedir(), `.local/share/codingns/deepseek-harness/${DSH_TESTED_VERSION}/node_modules/@deepseek-ai`)
const controllerPackage = join(runtime, 'dsh-api-session-controller')
const available = existsSync(join(controllerPackage, 'lib/types/commands.js'))
const version = available ? JSON.parse(readFileSync(join(controllerPackage, 'package.json'), 'utf8')).version : ''

test('fresh Grok image prompt passes real DSH admission without changing the native default', { skip: !available || version !== DSH_TESTED_VERSION }, async () => {
  const [{ ApiSessionAgentController }, { SessionCommandController }] = await Promise.all([
    import(pathToFileURL(join(controllerPackage, 'lib/types/agent.js')).href),
    import(pathToFileURL(join(controllerPackage, 'lib/types/commands.js')).href),
  ])
  const defaultSelection = { provider: 'native', model: 'text-only', reasoningEffort: 'high' }
  const delivered: unknown[] = []
  const checked: Array<{ provider: string; model: string }> = []
  let virtual: { resolveModel(provider: string, model: string): Promise<unknown> } | undefined
  const agent = {
    id: 'fresh-session', ctx: { on: () => () => {} },
    session: { requestHeader: () => undefined, snapshotEvents: () => [] },
    inbox: { nextTurn: [], nextStep: [] },
    followup: (message: unknown) => delivered.push(message),
  }
  const llm = {
    registerAdapter(_providers: string[], adapter: typeof virtual) { virtual = adapter; return () => { virtual = undefined } },
    async resolveModelInfo(provider: string, model: string) {
      checked.push({ provider, model })
      return provider === 'codingns-cli-grok' ? virtual!.resolveModel(provider, model) : { inputModalities: ['text'] }
    },
  }
  const context = {
    typert: { lookups: { configure() {} }, contexts: { configureHost() {} } },
    sessionProjections: { stateOf: () => ({ pending: null }) },
    agentDefaultModel: { currentSelection: () => defaultSelection, saveSelection: () => assert.fail('Must not change the global default') },
    agents: { get: () => agent }, llm,
    attachments: { admitPromptContent: async (content: unknown) => content },
    fileUploads: { bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) },
  }
  const native = new ApiSessionAgentController(context)
  native.resolveAgent = async () => ({ agent })
  const nativeRef = native.selectionFor(agent)
  const commands = new SessionCommandController(context, native, '/unused')
  const request = { sessionId: agent.id, requestId: 'image-request', mode: 'followup', content: [{ type: 'image', attachment: { attachmentId: 'image-test', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] }
  const send = () => commands.prompt(request, { kind: 'user', rpcId: 'image-request' })
  await assert.rejects(send(), /does not support image input/u)
  assert.equal(delivered.length, 0)

  const table = new CodingNsRpcTable()
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'grok', name: 'Grok Build' },
    async detect() { return { installed: true, version: 'fake', command: 'fake' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { assert.fail('Admission must not execute Grok') },
  }])
  const services = { llm, sessionController: { agents: native } }
  const features = new FeatureRegistry({ rpc: table, dshVersion: version, dshContext: { get: (name: keyof typeof services) => services[name] } as never })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  try {
    const set = (adapterId: string, modelId?: string) => table.resolve('cli/session/set')!.handler('session/set', { sessionId: agent.id, adapterId, ...(modelId ? { modelId } : {}) })
    await set('grok')
    assert.deepEqual(await send(), { accepted: true })
    assert.deepEqual(checked.at(-1), { provider: 'codingns-cli-grok', model: 'provider-default' })
    await set('grok', 'selected-grok-model')
    assert.deepEqual(await send(), { accepted: true })
    assert.deepEqual(checked.at(-1), { provider: 'codingns-cli-grok', model: 'selected-grok-model' })
    assert.deepEqual(nativeRef.current, { provider: 'codingns-cli-grok', model: 'selected-grok-model' })
    assert.equal(context.agentDefaultModel.currentSelection(), defaultSelection)
    assert.equal(delivered.length, 2)
    registry.setEnabled('grok', false)
    await assert.rejects(send(), /does not support image input/u)
    registry.setEnabled('grok', true)
    await set('dsh')
    await assert.rejects(send(), /does not support image input/u)
    assert.equal(native.selectionFor(agent), nativeRef)
    assert.equal(nativeRef.current, defaultSelection)
    await set('grok')
  } finally {
    await features.disable('cliAdapters')
  }
  assert.equal(native.selectionFor(agent), nativeRef)
  assert.equal(nativeRef.current, defaultSelection)
  await assert.rejects(send(), /does not support image input/u)
})

test('retained native selection drives real DSH assembly without repeated model-switch notices', { skip: !available || version !== DSH_TESTED_VERSION }, async () => {
  const { ApiSessionAgentController } = await import(pathToFileURL(join(controllerPackage, 'lib/types/agent.js')).href)
  const nativeChoice = { provider: 'native', model: 'text-only', reasoningEffort: 'high' }
  const hooks = new Map<string, (...args: any[]) => Promise<any>>()
  const context = {
    typert: { lookups: { configure() {} }, contexts: { configureHost() {} } },
    sessionProjections: { stateOf: () => ({ pending: nativeChoice }) },
    agentDefaultModel: { currentSelection: () => nativeChoice },
  }
  let route: SessionModelSelection | undefined = { provider: 'codingns-cli-codex', model: 'selected-codex' }
  let previous = route
  const agent = {
    id: 'external-session',
    ctx: {
      on(name: string, listener: (...args: any[]) => Promise<any>) {
        hooks.set(name, listener)
        return () => hooks.delete(name)
      },
    },
    session: { requestHeader: () => ({ config: previous }) },
  }
  const owner = new ApiSessionAgentController(context)
  // DSH's installed listeners retain this reference, not the accessor's return value.
  const retained = owner.selectionFor(agent)
  const descriptor = Object.getOwnPropertyDescriptor(retained, 'current')
  const dispose = createSessionModelSelectionAdapter({ agents: owner }).install(() => route)
  try {
    owner.selectionFor(agent)
    for (let turn = 0; turn < 2; turn += 1) {
      const assembly = await hooks.get('system-prompt/assemble')!({}, {}, async () => ({ variables: {} }))
      assert.deepEqual(assembly.variables, { provider: route.provider, model: route.model })
      const input = [{ role: 'user', source: { kind: 'user' }, content: `Split D:\\video-${turn}.mp4 at 05:00` }]
      const decision = await hooks.get('agent/pre-step')!({ agent, messages: input, signal: new AbortController().signal, step: 1 }, async () => ({ kind: 'enter', messages: input }))
      assert.deepEqual(decision.messages, input)
    }
    assert.equal(owner.selectionFor(agent), retained)
    route = { provider: 'codingns-cli-codex', model: 'another-codex' }
    await hooks.get('system-prompt/assemble')!({}, {}, async () => ({ variables: {} }))
    assert.deepEqual(retained.assembled, route)
    const input = [{ role: 'user', source: { kind: 'user' }, content: 'Continue with the new model' }]
    const payload = { agent, messages: input, signal: new AbortController().signal, step: 1 }
    const decision = await hooks.get('agent/pre-step')!(payload, async () => ({ kind: 'enter', messages: input }))
    assert.equal(decision.messages.length, 2)
    assert.equal(decision.messages[1].source.kind, 'model-selection')
    assert.match(decision.messages[1].content[0].text, /selected-codex.*another-codex/u)
    previous = route
    const next = await hooks.get('agent/pre-step')!(payload, async () => ({ kind: 'enter', messages: input }))
    assert.deepEqual(next.messages, input)
    retained.current = { provider: 'native', model: 'updated-native' }
    assert.deepEqual(retained.current, route)
    route = undefined
    assert.deepEqual(retained.current, { provider: 'native', model: 'updated-native' })
    previous = retained.current
    await hooks.get('system-prompt/assemble')!({}, {}, async () => ({ variables: {} }))
    assert.deepEqual(retained.assembled, previous)
    assert.equal(context.agentDefaultModel.currentSelection(), nativeChoice)
  } finally { dispose() }
  assert.deepEqual(Object.getOwnPropertyDescriptor(retained, 'current'), descriptor)
})
