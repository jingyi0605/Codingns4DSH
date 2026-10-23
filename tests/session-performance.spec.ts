import assert from 'node:assert/strict'
import test from 'node:test'
import { DSH_TESTED_VERSION } from '../src/shared/contracts/version.js'
import { createElement, useMemo, useSyncExternalStore } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createSessionPerformanceAdapter } from '../src/dsh-capabilities/host/session-performance-adapter.js'
import { createSessionPerformancePresentation } from '../src/dsh-capabilities/client/session-performance-adapter.js'
import { CODEX_PERFORMANCE_PROJECTION } from '../src/shared/codex-performance.js'
import { GROK_CONTEXT_PROJECTION, GROK_PERFORMANCE_PROJECTION } from '../src/shared/request-performance.js'
import { createPresentationSlots } from './fixtures/presentation-slots.ts'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { codexPerformanceProjection } from '../src/host/cli-adapters/codex-performance-projection.js'
import { grokContextProjection, grokPerformanceProjection } from '../src/host/cli-adapters/grok-performance-projection.js'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'

test('performance capabilities reject legacy and unverified versions with explainable diagnostics', () => {
  const slots = createPresentationSlots()
  const context = { slots, sessionProjections: { register() {} } }
  for (const runtime of ['host', 'client'] as const) {
    for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.1-alpha.2', '0.2.1']) {
      const profile = createDshCapabilityRegistry(version, runtime, context).getProfile(context)
      assert.equal(profile.capabilities.get('session.external-performance')?.status, 'unavailable')
      assert.ok(profile.diagnostics.some(item => item.capability === 'session.external-performance' && item.code === 'CAPABILITY_VERSION_UNSUPPORTED'))
    }
    for (const version of ['0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.3']) {
      assert.equal(createDshCapabilityRegistry(version, runtime, context).getProfile(context).capabilities.get('session.external-performance')?.status, 'ready')
    }
    assert.equal(createDshCapabilityRegistry('0.2.1-alpha.3', runtime, {}).getProfile({}).capabilities.get('session.external-performance')?.status, 'unavailable')
  }
})

test('Host projection registration reads optional services through get and disposes registration', () => {
  let registered: unknown, removed = 0
  const service = { register(value: unknown) { registered = value; return () => { removed++ } } }
  const context = { get: (key: string) => key === 'sessionProjections' ? service : undefined }
  const definition = { key: 'test' }
  const dispose = createSessionPerformanceAdapter(context).install(definition)
  assert.equal(registered, definition)
  dispose()
  assert.equal(removed, 1)
})

test('native activity UI uses corrected Codex statistics and preserves native sessions, inject, locale, settings, and disposal', async () => {
  const slots = createPresentationSlots()
  const root = slots.register({ name: 'root', children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } } }, (() => null) as never)
  let adapter = 'codex'
  const Native = (props: any) => createElement('span', undefined, JSON.stringify(props.useProjection('sessionStats')))
  const inject = () => ({ usePerformanceUsage: () => 'compact' })
  const native = slots.register({ name: 'conversation.composer.dock', id: 'activity', priority: 100, locale: 'codingns', inject }, Native as never)
  const dispose = createSessionPerformancePresentation({ slots }).install(() => adapter, createElement, { useMemo, useSyncExternalStore })
  const entries = slots.core.entriesOfSlot('conversation.composer.dock')
  assert.equal(entries.length, 1)
  assert.notEqual(entries[0]!.component, Native)
  assert.equal(entries[0]!.inject, inject)
  assert.equal(entries[0]!.locale, 'codingns')
  const Wrapper = entries[0]!.component as any
  const original = { turns: 1, steps: 5, toolMs: 20, decodeTokens: 1000, decodeMs: 59, llmMs: 59, ttftMs: 0, ttftSteps: 1 }
  let corrected: unknown = { ...original, decodeMs: 10_000 }
  const calls: string[] = []
  const render = () => renderToStaticMarkup(createElement(Wrapper, { sessionId: 'test', useProjection: (key: string) => {
    calls.push(key); return key === CODEX_PERFORMANCE_PROJECTION || key === GROK_PERFORMANCE_PROJECTION ? corrected : original
  } }))
  assert.match(render(), /10000/)
  assert.deepEqual(calls, ['sessionStats', CODEX_PERFORMANCE_PROJECTION])
  adapter = 'grok'
  assert.match(render(), /10000/)
  assert.deepEqual(calls.slice(-2), ['sessionStats', GROK_PERFORMANCE_PROJECTION])
  corrected = undefined
  assert.match(render(), /decodeMs&quot;:0/)
  adapter = 'dsh'
  assert.match(render(), /decodeMs&quot;:59/)
  dispose()
  assert.equal(slots.core.entriesOfSlot('conversation.composer.dock')[0]!.component, Native)
  native(); root()
  await Promise.resolve()
})

test('Grok context uses provider occupancy while preserving the native composer and its child slots', async () => {
  const slots = createPresentationSlots()
  const root = slots.register({ name: 'root', children: { 'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' } } }, (() => null) as never)
  const Native = (props: any) => {
    props.renderSlot('conversation.input.left')
    return createElement('span', undefined, JSON.stringify({ pressure: props.useProjection('contextPressure'), breakdown: props.useProjection('contextBreakdown') }))
  }
  const inject = () => ({}), store = {}, select = () => ({})
  const native = slots.register({ name: 'conversation.composer.bar', inject, store, select, locale: 'native', children: {
    'conversation.composer.dock': { kind: 'list', scope: 'session' }, 'conversation.input.left': { kind: 'list', scope: 'session' },
  } }, Native as never)
  const action = slots.register({ name: 'conversation.input.left', id: 'test' }, (() => null) as never)
  let adapter = 'grok'
  const dispose = createSessionPerformancePresentation({ slots }).install(() => adapter, createElement, { useMemo, useSyncExternalStore })
  const entry = slots.core.entriesOfSlot('conversation.composer.bar')[0]!
  assert.notEqual(entry.component, Native)
  assert.equal(entry.inject, inject)
  assert.equal(entry.store, store)
  assert.equal(entry.select, select)
  assert.equal(entry.locale, 'native')
  assert.equal(slots.core.entriesOfSlot('codingns.grok-context.conversation.input.left').length, 1)
  const calls: string[] = []
  let pressure: unknown = { contextWindow: 256000, pressureTokens: 19411 }
  const original = { contextWindow: 256000, pressureTokens: 38223 }
  const render = () => renderToStaticMarkup(createElement(entry.component as any, { sessionId: 'test', renderSlot: (name: string) => calls.push(name),
    useProjection: (key: string) => key === GROK_CONTEXT_PROJECTION ? pressure : key === 'contextPressure' ? original : { systemTokens: 100 },
  }))
  const html = render()
  assert.match(html, /19411/)
  assert.doesNotMatch(html, /38223|systemTokens/)
  assert.equal(calls[0], 'codingns.grok-context.conversation.input.left')
  adapter = 'dsh'
  assert.match(render(), /38223/)
  assert.match(render(), /systemTokens/)
  adapter = 'grok'; pressure = undefined
  assert.doesNotMatch(render(), /38223/)
  dispose()
  assert.equal(slots.core.entriesOfSlot('conversation.composer.bar')[0]!.component, Native)
  assert.equal(slots.entries('codingns.grok-context.conversation.input.left').length, 0)
  action(); native(); root()
  await Promise.resolve()
})

test('performance UI follows late native registration and replacement', async () => {
  const slots = createPresentationSlots()
  const root = slots.register({ name: 'root', children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } } }, (() => null) as never)
  const dispose = createSessionPerformancePresentation({ slots }).install(() => 'codex', createElement, { useMemo, useSyncExternalStore })
  const first = slots.register({ name: 'conversation.composer.dock', id: 'activity' }, (() => null) as never)
  await Promise.resolve()
  assert.equal(slots.entries('conversation.composer.dock').length, 2)
  first()
  await Promise.resolve()
  assert.equal(slots.entries('conversation.composer.dock').length, 0)
  const second = slots.register({ name: 'conversation.composer.dock', id: 'activity' }, (() => null) as never)
  await Promise.resolve()
  assert.equal(slots.entries('conversation.composer.dock').length, 2)
  dispose(); second(); root()
})

// Read verified Stage0 libraries into memory only; no profile, server, persistence, or CLI is started.
const runtime = process.env.CODINGNS_STAGE0_RUNTIME_DIR
  ?? join(homedir(), `.local/share/codingns/deepseek-harness/${DSH_TESTED_VERSION}/node_modules/@deepseek-ai`)
const registryPath = join(runtime, 'dsh-session-projection/lib/index.js')
test('real DSH admits performance metadata and restores the same whole-session average from its checkpoint', { skip: !existsSync(registryPath) }, async () => {
  const [{ Context }, { SessionProjectionRegistry }, { Session }] = await Promise.all([
    import(pathToFileURL(join(runtime, 'cordis/lib/index.js')).href),
    import(pathToFileURL(registryPath).href),
    import(pathToFileURL(join(runtime, 'dsh-session/lib/index.js')).href),
  ])
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx)
  const remove = createSessionPerformanceAdapter(ctx).install(codexPerformanceProjection)
  try {
    const session = new Session('performance-fixture')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const bridge = createCodingNsNativeSessionBridge({ get: (key: string) => key === 'sessions' ? { get: () => session, list: () => [session] } : undefined } as never)
    assert.equal(bridge.appendUsageSample?.('performance-fixture', {
      inputTokens: 100, outputTokens: 1000,
      codexPerformance: { id: 'real-request', startedAt: 0, firstTokenAt: 1000, completedAt: 11_000, outputTokens: 1000 },
    }), true)
    session.append('step/end', { turn: 1, step: 1 })
    const snapshot = registry.snapshot(session)
    const view = snapshot.values[CODEX_PERFORMANCE_PROJECTION]
    assert.equal(view.decodeTokens / (view.decodeMs / 1000), 100)
    assert.equal(view.steps, 1)
    const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
    assert.deepEqual(registry.viewCheckpoint(checkpoint)[CODEX_PERFORMANCE_PROJECTION], view)
    const events = session.snapshotEvents()
    const restored = registry.restore({}, events, 0, session.header, 0)
    assert.deepEqual(restored.snapshot.values[CODEX_PERFORMANCE_PROJECTION], view)
  } finally { remove() }
})

test('real DSH preserves Grok billing, provider context, and source timing through cold replay', { skip: !existsSync(registryPath) }, async () => {
  const [{ Context }, { SessionProjectionRegistry }, { Session }, { TokenMeter }] = await Promise.all([
    import(pathToFileURL(join(runtime, 'cordis/lib/index.js')).href), import(pathToFileURL(registryPath).href),
    import(pathToFileURL(join(runtime, 'dsh-session/lib/index.js')).href),
    import(pathToFileURL(join(runtime, 'dsh-token-meter/lib/index.js')).href),
  ])
  const ctx = new Context(), registry = new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const remove = [grokPerformanceProjection, grokContextProjection].map(projection => createSessionPerformanceAdapter(ctx).install(projection))
  try {
    const session = new Session('grok-performance-fixture')
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    const bridge = createCodingNsNativeSessionBridge({ get: (key: string) => key === 'sessions' ? { get: () => session, list: () => [session] } : undefined } as never)
    assert.equal(bridge.appendRequestContext?.(session.id, { provider: 'grok', model: 'grok-fast', contextWindow: 256000, confirmed: true }), true)
    assert.equal(bridge.appendUsageSample?.(session.id, {
      inputTokens: 0, outputTokens: 0,
      contextObservation: { contextModelId: 'grok-fast', contextWindow: 256000, contextTokens: 1710 },
      requestPerformance: { id: 'call-1', samples: [
        { id: 'call-1', startedAt: 0, firstTokenAt: 1000, completedAt: 11000, outputTokens: 114 },
      ] },
    }), true)
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    assert.equal(bridge.appendUsageSample?.(session.id, {
      inputTokens: 0, outputTokens: 0,
      contextObservation: { contextModelId: 'grok-fast', contextWindow: 256000, contextTokens: 19411 },
      requestPerformance: { id: 'call-2', samples: [
        { id: 'call-2', startedAt: 16000, firstTokenAt: 17000, completedAt: 18000, outputTokens: 57 },
      ] },
    }), true)
    const billing = { inputTokens: 18255, cacheReadTokens: 19968, outputTokens: 171, totalTokens: 38394 }
    assert.equal(bridge.appendUsageSample?.(session.id, billing), true)
    session.append('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [] }, stream: [], usage: billing }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 2 })
    const view = registry.snapshot(session).values
    assert.equal(view[GROK_PERFORMANCE_PROJECTION].decodeTokens / (view[GROK_PERFORMANCE_PROJECTION].decodeMs / 1000), 171 / 11)
    assert.deepEqual(view[GROK_CONTEXT_PROJECTION], { pressureTokens: 19411, contextWindow: 256000 })
    assert.equal(view.tokenUsage.outputTokens, 171)
    assert.equal(view.tokenUsage.uncachedInputTokens, 18255)
    assert.equal(view.tokenUsage.cacheReadTokens, 19968)
    assert.equal(view.contextPressure.pressureTokens, 38223, 'The native accounting numerator remains independent')
    const checkpoint = JSON.parse(JSON.stringify(registry.checkpoint(session)))
    assert.deepEqual(registry.viewCheckpoint(checkpoint), view)
    assert.deepEqual(registry.restore({}, session.snapshotEvents(), 0, session.header, 0).snapshot.values, view)
    const switched = grokContextProjection.apply({ model: 'grok-fast', pressureTokens: 19411, contextWindow: 256000 }, {
      type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'usage', codingnsContextObservation: { contextModelId: 'grok-small', contextWindow: 200000 } } }] },
    })
    assert.deepEqual(grokContextProjection.wire.view(switched), { contextWindow: 200000 })
    session.append('turn/start', { turn: 2 }); session.append('step/start', { turn: 2, step: 1 })
    assert.equal(bridge.appendUsageSample?.(session.id, {
      inputTokens: 0, outputTokens: 0, contextWindow: 500000,
      contextObservation: { contextModelId: 'grok-fast', contextWindow: 500000, contextTokens: 20000 },
    }), true)
    assert.deepEqual(registry.snapshot(session).values[GROK_CONTEXT_PROJECTION], { contextWindow: 500000, pressureTokens: 20000 }, 'A live capacity change is not rewritten by the legacy first-window anchor')
  } finally { for (const dispose of remove) dispose() }
})
