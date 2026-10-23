import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../src/host/cli-adapters/session-store.js'
import { KNOWN_CLI_ADAPTER_IDS, hasLegacySessionAdapterHint } from '../src/host/cli-adapters/legacy-session-adapter.js'
import { grokContextProjection } from '../src/host/cli-adapters/grok-performance-projection.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { fromCliProviderId, toCliProviderId } from '../src/shared/cli-provider-route.js'
import { installProviderIcons, providerIconUrl, providerVisual, PROVIDER_ICONS } from '../src/client/provider-icons.js'
import { PROVIDER_ICON_FILES } from '../src/shared/provider-icon-resources.js'

const collidingProviders = ['gemini', 'opencode', 'qoder', 'zcode', 'workbuddy']

async function fixture(version = '0.2.1-alpha.3', replace = true) {
  const nativeAdapter = { native: true }
  const routes = new Map<string, any>(collidingProviders.map(id => [id, nativeAdapter]))
  const hooks = new Map<string, (...args: any[]) => any>()
  const calls: Array<{ adapterId: string; input: any }> = []
  let settingsListener: ((next: any, previous: any) => unknown) | undefined
  let settings = { ...DEFAULT_CODINGNS_SETTINGS, agentAdapters: {} as Record<string, boolean> }
  const llm = {
    registerAdapter(providers: string[], adapter: any) {
      const owned = new Set<string>()
      const update = (next: string[]) => {
        // Match DSH's all-or-nothing route validation, including ownership.
        for (const id of next) {
          if (routes.has(id) && !owned.has(id)) throw Object.assign(new Error(`Duplicate provider: ${id}`), { code: 'DUPLICATE_ADAPTER' })
          assert.equal(adapter.providerInfo(id).id, id)
          adapter.providerRetryPolicy(id)
        }
        for (const id of owned) routes.delete(id)
        owned.clear()
        for (const id of next) { routes.set(id, adapter); owned.add(id) }
      }
      update(providers)
      const dispose = () => { for (const id of owned) routes.delete(id); owned.clear() }
      return replace ? Object.assign(dispose, { replace: update }) : dispose
    },
  }
  const store = new CodingNsCliSessionStore()
  const registry = new CodingNsCliAdapterRegistry([...KNOWN_CLI_ADAPTER_IDS].map(adapterId => ({
    descriptor: { id: adapterId, name: adapterId },
    async detect() { return { installed: true, version: 'fixture', command: `fake-${adapterId}` } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input: any) {
      calls.push({ adapterId, input })
      yield { type: 'text-delta' as const, text: `CLI ${adapterId}` }
      yield { type: 'finish' as const, reason: 'stop' as const }
    },
  })), {}, { sessionStore: store })
  const nativeSelection = { provider: 'gemini', model: 'api-model', reasoningEffort: 'high' }
  const owner = { selectionFor(_agent: { id: string }) { return { current: nativeSelection } } }
  const services = { llm, sessionController: { agents: owner } }
  const rpc = new CodingNsRpcTable()
  const features = new FeatureRegistry({
    rpc, dshVersion: version,
    settings: {
      get: () => settings,
      watch(listener: typeof settingsListener) { settingsListener = listener; return () => { settingsListener = undefined } },
    },
    events: { on(name: string, listener: (...args: any[]) => any) { hooks.set(name, listener); return () => { hooks.delete(name) } } },
    dshContext: {
      get(name: keyof typeof services) { return services[name] },
      on(name: string, listener: (...args: any[]) => any) { hooks.set(name, listener); return () => { hooks.delete(name) } },
    } as never,
  } as never)
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  return {
    routes, hooks, calls, store, registry, rpc, owner, nativeSelection, nativeAdapter,
    stop: () => features.disable('cliAdapters'),
    configure(agentAdapters: Record<string, boolean>) {
      const previous = settings
      settings = { ...settings, agentAdapters }
      settingsListener!(settings, previous)
    },
  }
}

test('CLI providers coexist with API providers across supported DSH versions and release only owned routes', async t => {
  for (const version of ['0.2.0-rc.2', '0.2.1-alpha.3']) for (const replace of [true, false]) {
    await t.test(`${version}, replace=${replace}`, async () => {
      const f = await fixture(version, replace)
      try {
        const catalog = await f.rpc.resolve('cli/catalog')!.handler('catalog', {}) as Array<{ id: string }>
        assert.deepEqual(catalog.map(entry => entry.id), [...KNOWN_CLI_ADAPTER_IDS])
        for (const id of KNOWN_CLI_ADAPTER_IDS) {
          const provider = toCliProviderId(id)
          assert.equal(f.routes.get(provider).providerInfo(provider).name, `CodingNS ${id}`)
          const model = await f.routes.get(provider).resolveModel(provider, 'unchanged-model')
          assert.deepEqual(model.inputModalities, ['text', 'image'])
          assert.equal(model.provider, provider)
          assert.equal(model.id, 'unchanged-model')
        }
        f.configure({ gemini: false })
        assert.equal(f.routes.has('codingns-cli-gemini'), false)
        assert.equal(f.routes.has('codingns-cli-codex'), true)
        assert.equal(f.routes.get('gemini'), f.nativeAdapter)
        f.configure({})
        assert.equal(f.routes.has('codingns-cli-gemini'), true)
        f.registry.setSession('saved', { adapterId: 'gemini', modelId: 'cli-model' })
        assert.equal(f.store.get('saved')?.adapterId, 'gemini')
        if (version === '0.2.1-alpha.3') {
          assert.deepEqual(f.owner.selectionFor({ id: 'saved' }).current, { provider: 'codingns-cli-gemini', model: 'cli-model' })
          assert.deepEqual(f.owner.selectionFor({ id: 'native' }).current, f.nativeSelection)
        }
      } finally { await f.stop() }
      assert.deepEqual([...f.routes.keys()], collidingProviders)
    })
  }
})

test('native API brands stay native, while namespaced CLI requests preserve stable session bindings', async () => {
  const f = await fixture()
  try {
    const stream = f.hooks.get('llm/stream')!
    const request = f.hooks.get('agent/request')!
    for (const provider of collidingProviders) {
      const config = { provider, model: 'api-model', reasoningEffort: 'high' }
      assert.equal(await request({ agent: { id: `native-${provider}` } }, async () => config), config)
      const chunks = []
      for await (const chunk of stream({
        ...config, sessionId: `native-${provider}`,
        messages: [{ role: 'assistant', source: { kind: 'model', provider }, content: 'API history' }, { role: 'user', content: 'Continue' }],
      }, async function* () { yield { type: 'text-delta', text: 'Native API' } })) chunks.push(chunk)
      assert.deepEqual(chunks, [{ type: 'text-delta', text: 'Native API' }])
      assert.equal(f.registry.getSession(`native-${provider}`).adapterId, 'dsh')
    }
    assert.equal(f.calls.length, 0)
    const routed = await request({ agent: { id: 'external' } }, async () => ({ provider: 'codingns-cli-gemini', model: 'cli-model', reasoningEffort: 'high' }))
    assert.deepEqual(routed, { provider: 'codingns-cli-gemini', model: 'cli-model' })
    for (const input of [{ ...routed }, {}]) {
      for await (const _chunk of stream({ ...input, sessionId: 'external', messages: [{ role: 'user', content: 'Continue' }] }, async function* () { assert.fail('CLI routing was lost') })) {}
    }
    assert.deepEqual(f.calls.map(call => call.adapterId), ['gemini', 'gemini'])
    assert.equal(f.calls[0]?.input.modelId, 'cli-model')
    assert.equal(f.registry.getSession('external').adapterId, 'gemini')
    assert.equal(f.store.get('external')?.adapterId, 'gemini')
  } finally { await f.stop() }
})

test('legacy and namespaced histories recover CLI ownership without claiming native providers', () => {
  const store = new CodingNsCliSessionStore()
  const sources = [
    { kind: 'model', provider: 'gemini' },
    { kind: 'model', plugin: 'codingns4dsh', provider: 'gemini' },
    { kind: 'model', provider: 'codingns-cli-gemini' },
  ]
  const sessions = sources.map((source, index) => ({ id: `history-${index}`, events: [{ type: 'assistant/message', data: { message: { source } } }] }))
  const context = { id: 'context', events: [
    { type: 'request/context', data: { provider: 'opencode', model: 'api-model' } },
    { type: 'request/context', data: { provider: 'codingns-cli-gemini', model: 'cli-model' } },
  ] }
  const legacy = { id: 'legacy-context', events: [
    { type: 'request/context', data: { provider: 'gemini', model: 'cli-model' } },
    { type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'codingns-external' } } } },
  ] }
  const future = { id: 'future-context', events: [
    { type: 'request/context', data: { provider: 'opencode', model: 'api-model' } },
    { type: 'request/context', data: { provider: 'codingns-cli-future-agent', model: 'cli-model' } },
  ] }
  store.migrateLegacySessions([...sessions, context, legacy, future])
  assert.equal(store.get('history-0'), undefined)
  assert.equal(store.get('future-context'), undefined)
  for (const id of ['history-1', 'history-2', 'context', 'legacy-context']) assert.equal(store.get(id)?.adapterId, 'gemini')
  assert.equal(hasLegacySessionAdapterHint(sessions[0]!.events[0]), false)
  assert.equal(hasLegacySessionAdapterHint(sessions[2]!.events[0]), true)
  assert.equal(hasLegacySessionAdapterHint(context.events[1]), true)
})

test('namespaced provider metadata retains visuals and Grok context observations', () => {
  installProviderIcons({ gemini: 'asset:gemini', codebuddy: 'asset:codebuddy' })
  try {
    assert.deepEqual(providerVisual('codingns-cli-gemini'), providerVisual('gemini'))
    assert.equal(providerIconUrl('codingns-cli-gemini'), 'asset:gemini')
    assert.deepEqual(providerVisual('codingns-cli-codebuddy-cn'), providerVisual('codebuddy'))
    assert.equal(providerIconUrl('codingns-cli-unknown'), undefined)
    for (const value of ['gemini', '', 'codingns-cli-', undefined, null, 42]) assert.equal(fromCliProviderId(value), undefined)
    const state = { contextWindow: 200_000, pressureTokens: 15_000 }
    for (const provider of ['grok', 'codingns-cli-grok']) assert.equal(grokContextProjection.apply(state, { type: 'request/context', data: { provider } }), state)
    assert.deepEqual(grokContextProjection.apply(state, { type: 'request/context', data: { provider: 'gemini' } }), {})
  } finally { installProviderIcons({}) }
})

test('Magpie provider identities resolve to cached plugin logos', () => {
  const previousIcons = { ...PROVIDER_ICONS }
  installProviderIcons(Object.fromEntries(Object.entries(PROVIDER_ICON_FILES).map(([provider, filename]) => [provider, `asset:${filename}`])))
  try {
    const identities = [
      'dsh', 'claude', 'codex', 'commandcode', 'kimi', 'gemini', 'pi', 'opencode', 'grok',
      'minimax-code', 'zcode', 'codebuddy', 'workbuddy', 'cursor', 'qoder', 'qoder-cn', 'agy',
      'WorkBuddy AI', 'Grok (SuperGrok)',
    ]
    const missing = identities.filter(identity => providerIconUrl(identity) === undefined)
    assert.deepEqual(missing, [], 'every supported Magpie agent and current branded alias has a cached logo')
    assert.equal(providerIconUrl('workbuddy-ai'), 'asset:workbuddy.svg')
    assert.equal(providerIconUrl('codingns-cli-claude-code'), 'asset:claude-code.png')
    assert.equal(providerIconUrl('codingns-cli-cursor-cli'), 'asset:cursor-cli.svg')
    for (const filename of Object.values(PROVIDER_ICON_FILES)) {
      assert.equal(existsSync(new URL(`../assets/provider-icons/${filename}`, import.meta.url)), true, `${filename} exists`)
    }
  } finally {
    installProviderIcons(previousIcons)
  }
})
