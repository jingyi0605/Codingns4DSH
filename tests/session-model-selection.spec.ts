import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { DSH_TESTED_VERSION } from '../src/shared/contracts/version.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createSessionModelSelectionAdapter, type SessionModelSelection } from '../src/dsh-capabilities/host/session-model-selection-adapter.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'
import { Context, getTraceable, symbols } from '@deepseek-ai/cordis'

test('external selection capability rejects unverified versions and missing native accessors', () => {
  const context = { sessionController: { agents: { selectionFor() {} } } }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.1']) {
    const profile = createDshCapabilityRegistry(version, 'host', context).getProfile(context)
    assert.equal(profile.capabilities.get('session.external-model-selection')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some(value => value.capability === 'session.external-model-selection' && value.code === 'CAPABILITY_VERSION_UNSUPPORTED'))
  }
  for (const version of ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3']) {
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
  class Owner {
    readonly ref = { current: native as SessionModelSelection }
    selectionFor(_agent: { id: string }) { return this.ref }
  }
  const owner = new Owner()
  const original = owner.selectionFor
  let route: SessionModelSelection | undefined = { provider: 'grok', model: 'grok-image-model' }
  const dispose = createSessionModelSelectionAdapter({ agents: owner }).install(id => id === 'external' ? route : undefined)
  const external = { id: 'external' }
  assert.deepEqual(owner.selectionFor(external).current, route)
  assert.equal(owner.ref.current, native)
  assert.equal(owner.selectionFor({ id: 'other' }), owner.ref)
  owner.selectionFor(external).current = { provider: 'native', model: 'updated' }
  assert.deepEqual(owner.ref.current, { provider: 'native', model: 'updated' })
  route = { provider: 'grok', model: 'another-model' }
  assert.deepEqual(owner.selectionFor(external).current, route)
  route = undefined
  assert.equal(owner.selectionFor(external), owner.ref)
  dispose()
  dispose()
  assert.equal(owner.selectionFor, original)
  assert.equal(Object.hasOwn(owner, 'selectionFor'), false)
})

for (const traceable of [false, true]) test(`native route reads avoid resolver recursion with ${traceable ? 'Cordis proxies' : 'plain services'}`, () => {
  const session = { header: { id: 'native-magpie' }, requestHeader: () => undefined }
  const agent = { id: session.header.id, session }
  const native = { provider: 'magpie', model: 'auto/deepseek-v4.1-flash', reasoningEffort: 'high' }
  let reads = 0
  const controller = {
    create: async () => ({ sessionId: agent.id }),
    agents: { selectionFor(_agent: { readonly id: string }) {
      assert.ok(++reads < 10, 'native selection resolution must not recurse')
      return { current: native }
    } },
  }
  if (traceable) {
    Object.defineProperty(controller.agents, symbols.tracker, { value: { property: 'ctx' } })
    controller.agents = getTraceable(new Context(), controller.agents)
    assert.notEqual(controller.agents.selectionFor, controller.agents.selectionFor)
  }
  const descriptor = Object.getOwnPropertyDescriptor(controller.agents, 'selectionFor')
  const services: Record<string, unknown> = {
    sessions: { get: () => session, list: () => [session] },
    agents: { get: () => agent },
    sessionController: controller,
  }
  const bridge = createCodingNsNativeSessionBridge({ get: (key: string) => services[key] } as never)
  const registry = new CodingNsCliAdapterRegistry([], {}, { nativeSessions: bridge })
  let resolutions = 0
  const dispose = createSessionModelSelectionAdapter(controller).install(id => {
    resolutions += 1
    const config = registry.getSession(id)
    return config.adapterId === 'dsh' ? undefined : { provider: config.adapterId, model: config.modelId! }
  })
  try {
    assert.equal(registry.getSession(agent.id).providerId, native.provider)
    assert.equal(reads, 1)
    assert.equal(resolutions, 0, 'a raw native route read must not invoke our external overlay')
    assert.deepEqual(controller.agents.selectionFor(agent).current, native)
    assert.equal(resolutions, 1)
    assert.equal(reads, 3)
  } finally {
    dispose()
    assert.deepEqual(Object.getOwnPropertyDescriptor(controller.agents, 'selectionFor'), descriptor)
  }
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
    assert.equal(nativeRef.current, defaultSelection)
    assert.equal(delivered.length, 2)
    registry.setEnabled('grok', false)
    await assert.rejects(send(), /does not support image input/u)
    registry.setEnabled('grok', true)
    await set('dsh')
    await assert.rejects(send(), /does not support image input/u)
    assert.equal(native.selectionFor(agent), nativeRef)
    await set('grok')
  } finally {
    await features.disable('cliAdapters')
  }
  assert.equal(native.selectionFor(agent), nativeRef)
  await assert.rejects(send(), /does not support image input/u)
})
