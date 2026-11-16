import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, useMemo, useSyncExternalStore } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSessionPerformancePresentation } from '../src/dsh-capabilities/client/session-performance-adapter.js'
import { createPresentationSlots } from './fixtures/presentation-slots.ts'
import { zcodeContextProjection } from '../src/host/cli-adapters/zcode-context-projection.js'
import { ZcodeTurnTelemetry } from '../src/host/cli-adapters/zcode-telemetry.js'

test('ZCode composer uses the current provider context rather than all prompts billed in the tool loop', () => {
  const slots = createPresentationSlots()
  slots.register({ name: 'root', children: { 'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' } } }, (() => null) as never)
  const Native = (props: any) => createElement('span', undefined, JSON.stringify(props.useProjection('contextPressure')))
  slots.register({ name: 'conversation.composer.bar', children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } } }, Native as never)
  // Sanitized values from the actual ZCode/DSH parent session: the durable
  // usage sample has contextTokens=125171, separate from input+cache=248995.
  const nativePressure = { pressureTokens: 248995, contextWindow: 1_000_000 }
  const providerPressure = { pressureTokens: 125171, contextWindow: 1_000_000 }
  const dispose = createSessionPerformancePresentation({ slots }).install(() => 'zcode', createElement, { useMemo, useSyncExternalStore })
  try {
    const Composer = slots.core.entriesOfSlot('conversation.composer.bar')[0]!.component as any
    const html = renderToStaticMarkup(createElement(Composer, { sessionId: 'zcode', useProjection: (key: string) => key === 'contextPressure' ? nativePressure : providerPressure }))
    assert.match(html, /125171/)
    assert.doesNotMatch(html, /248995/)
  } finally { dispose() }
})

test('ZCode context replays durable history and live observations, allows compaction, and resets on route changes', () => {
  const sample = (usage: object, observation = false) => ({ type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: {
    type: 'usage', [observation ? 'codingnsContextObservation' : 'usage']: usage,
  } }] } })
  let state = zcodeContextProjection.apply(zcodeContextProjection.init(), { type: 'request/context', data: {
    provider: 'codingns-cli-zcode', model: 'glm', contextWindow: 1_000_000,
  } })
  state = zcodeContextProjection.apply(state, sample({ inputTokens: 124963, cacheReadTokens: 124032, outputTokens: 939,
    contextTokens: 125171, contextWindow: 1_000_000 }))
  assert.deepEqual(zcodeContextProjection.wire.view(state), { pressureTokens: 125171, contextWindow: 1_000_000 })
  state = zcodeContextProjection.apply(state, sample({ contextTokens: 20000 }, true))
  assert.equal(state.pressureTokens, 20000, 'native compaction can reduce occupancy')
  state = zcodeContextProjection.apply(state, sample({ inputTokens: 999999, outputTokens: 5 }))
  assert.equal(state.pressureTokens, 20000, 'billable request totals never overwrite occupancy')
  state = zcodeContextProjection.apply(state, { type: 'request/context', data: { provider: 'codingns-cli-zcode', model: 'glm-small', contextWindow: 128000 } })
  assert.deepEqual(zcodeContextProjection.wire.view(state), { contextWindow: 128000 })
  assert.deepEqual(zcodeContextProjection.apply(state, { type: 'request/context', data: { provider: 'codingns-cli-codex', model: 'other' } }), {})
})

test('ZCode emits a context observation per main request before the tool loop finishes, without double billing', () => {
  const telemetry = new ZcodeTurnTelemetry('s')
  const complete = (eventId: string, source: string, tokens: number) => ({ method: 'session/event', params: {
    sessionId: 's', eventId, type: 'session.updated', payload: { querySource: source, stopReason: 'tool_use', contextWindow: 1_000_000,
      usage: { inputTokens: tokens, outputTokens: 10, totalTokens: tokens + 10 } },
  } })
  const main = complete('main', 'main_turn', 120000)
  telemetry.observe(main)
  assert.deepEqual(telemetry.takeContextObservation(), { type: 'usage-observation', contextTokens: 120010, contextWindow: 1_000_000 })
  telemetry.observe(main)
  assert.equal(telemetry.takeContextObservation(), null, 'notification replay is ignored')
  telemetry.observe(complete('child', 'subagent', 2000))
  assert.equal(telemetry.takeContextObservation(), null, 'child requests cannot replace the parent context')
  telemetry.observe(complete('main2', 'main_turn', 125000))
  assert.equal(telemetry.takeContextObservation()?.contextTokens, 125010)
  const billing = telemetry.finish(null, null)
  assert.equal(billing?.type === 'usage' && billing.inputTokens, 247000)
  assert.equal(billing?.type === 'usage' && billing.outputTokens, 30)
})
