import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMagpieContextResponse } from '../src/host/cli-adapters/magpie-context.js'
import { MagpieContextStore } from '../src/client/magpie-context-store.js'
import { getMagpieContextStore } from '../src/client/magpie-context-store.js'
import { MagpieContextMeter } from '../src/client/magpie-context-meter.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.ts'
import { setImmediate } from 'node:timers/promises'

function response(): unknown {
  return {
    sessions: [{
      agent: 'dsh',
      key: 'session-1',
      title: 'Context fixture',
      model: 'auto/deepseek-v4.1-flash',
      requests: 8,
      compacts: 1,
      latestId: 36,
      points: [
        { id: 35, time: '2026-10-25T00:00:00.000Z', tokens: 12_000, window: 270_000, cache: 9_000 },
        { id: 36, time: '2026-10-25T00:01:00.000Z', tokens: 18_000, window: 270_000, cache: 12_000 },
      ],
      latest: {
        tokens: 30_000,
        window: 270_000,
        turns: 36,
        parts: [
          { kind: 'system', tokens: 1_900, items: [{ name: 'bash', n: 294, tokens: 1_900, text: 'must not cross' }] },
          { kind: 'tools', tokens: 8_800, items: [{ tag: 'tool', name: 'tools', tokens: 8_800 }] },
          { kind: 'memory', tokens: 336, items: [] },
          { kind: 'files', tokens: 2_800, items: [] },
          { kind: 'results', tokens: 7_740, items: [] },
          { kind: 'chat', tokens: 8_424, items: [{ name: 'earlier', n: 13, tokens: 4_000 }, { name: '36', tokens: 4_424 }] },
        ],
      },
    }],
  }
}

test('Magpie context parser exact-matches Agent and session and keeps only bounded metadata', () => {
  const parsed = parseMagpieContextResponse(response(), { agents: ['dsh'], sessionIds: ['session-1'] })
  assert.deepEqual(parsed, {
    agent: 'dsh', key: 'session-1', title: 'Context fixture', model: 'auto/deepseek-v4.1-flash',
    requests: 8, turns: 36, usedTokens: 30_000, contextWindow: 270_000,
    cacheTokens: 21_000, cacheRate: 0.7, compacts: 1, latestId: 36,
    parts: [
      { kind: 'system', tokens: 1_900, items: [{ name: 'bash', count: 294, tokens: 1_900 }] },
      { kind: 'tools', tokens: 8_800, items: [{ name: 'tools', tag: 'tool', tokens: 8_800 }] },
      { kind: 'memory', tokens: 336, items: [] },
      { kind: 'files', tokens: 2_800, items: [] },
      { kind: 'results', tokens: 7_740, items: [] },
      { kind: 'chat', tokens: 8_424, items: [{ name: 'earlier', count: 13, tokens: 4_000 }, { name: '36', tokens: 4_424 }] },
    ],
    points: [
      { id: 35, time: '2026-10-25T00:00:00.000Z', tokens: 12_000, window: 270_000, cacheTokens: 9_000 },
      { id: 36, time: '2026-10-25T00:01:00.000Z', tokens: 18_000, window: 270_000, cacheTokens: 12_000 },
    ],
  })
  assert.equal(JSON.stringify(parsed).includes('must not cross'), false)
  assert.equal(parseMagpieContextResponse(response(), { agents: ['claude'], sessionIds: ['session-1'] }), null)
  assert.equal(parseMagpieContextResponse(response(), { agents: ['dsh'], sessionIds: ['other-session'] }), null)
})

test('Magpie context parser fails closed for oversized or incomplete context responses', () => {
  const oversized = response() as { sessions: Array<{ latest: { parts: unknown[] } }> }
  oversized.sessions[0]!.latest.parts = Array.from({ length: 7 }, (_, index) => ({ kind: index === 0 ? 'system' : 'tools', tokens: 1, items: [] }))
  assert.equal(parseMagpieContextResponse(oversized, { agents: ['dsh'], sessionIds: ['session-1'] }), null)

  const missingWindow = response() as { sessions: Array<{ latest: Record<string, unknown> }> }
  delete missingWindow.sessions[0]!.latest.window
  assert.equal(parseMagpieContextResponse(missingWindow, { agents: ['dsh'], sessionIds: ['session-1'] }), null)
})

test('Magpie context polling keeps the last good snapshot and deduplicates unchanged content', async () => {
  const value = parseMagpieContextResponse(response(), { agents: ['dsh'], sessionIds: ['session-1'] })!
  let calls = 0
  let release: ((result: unknown) => void) | undefined
  const rpc = {
    call: async () => {
      calls += 1
      if (calls === 2) return await new Promise<unknown>(resolve => { release = resolve })
      return { ok: calls === 3 ? false : true, value }
    },
  }
  const store = new MagpieContextStore(rpc as never, 'session-1')
  let updates = 0
  const unsubscribe = store.subscribe(() => { updates += 1 })
  const internal = store as unknown as { load(force: boolean): Promise<void> }
  await internal.load(false)
  assert.equal(store.getSnapshot().status, 'ready')
  const firstUpdates = updates

  const refresh = internal.load(true)
  assert.deepEqual(store.getSnapshot(), { status: 'ready', value })
  assert.equal(updates, firstUpdates, 'a refresh must not publish a loading state')
  release!({ ok: true, value: { ...value, parts: value.parts.map(part => ({ ...part, items: [...part.items] })) } })
  await refresh
  assert.equal(updates, firstUpdates, 'identical snapshots must not notify React')

  await internal.load(true)
  assert.deepEqual(store.getSnapshot(), { status: 'ready', value }, 'a failed refresh must retain the last good snapshot')
  assert.equal(updates, firstUpdates)
  unsubscribe()
})

test('an empty fresh-session context is re-read after remount instead of cached permanently', async () => {
  const value = parseMagpieContextResponse(response(), { agents: ['dsh'], sessionIds: ['session-1'] })!
  let calls = 0
  const store = new MagpieContextStore({
    call: async () => ({ ok: true, value: ++calls === 1 ? null : value }),
  } as never, 'session-1')
  const internal = store as unknown as { load(force: boolean): Promise<void> }
  const unsubscribe = store.subscribe(() => undefined)
  await internal.load(false)
  assert.notEqual(store.getSnapshot().status, 'ready')
  unsubscribe()

  const remove = store.subscribe(() => undefined)
  try {
    await internal.load(false)
    assert.deepEqual(store.getSnapshot(), { status: 'ready', value })
    assert.equal(calls, 2)
  } finally {
    remove()
  }
})

test('a mounted context meter discovers first-turn data and clears it after a model change', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const value = parseMagpieContextResponse(response(), { agents: ['dsh'], sessionIds: ['session-1'] })!
  let context: unknown = null
  let calls = 0
  let session = { running: false, modelSelection: 'magpie' }
  const rpc = { call: async () => { calls += 1; return { ok: true, value: context } } }
  const store = getMagpieContextStore(rpc as never, 'session-1')
  const view = createHookRenderer(MagpieContextMeter, {
    rpc: rpc as never,
    sessionId: 'session-1',
    useSession: (select: (value: typeof session) => unknown) => select(session),
  } as never, { checkHookOrder: true })
  try {
    view.render()
    await setImmediate()
    view.render()
    const initialReads = calls
    t.mock.timers.tick(3_000)
    await setImmediate()
    assert.equal(calls, initialReads, 'idle non-Magpie sessions must not poll')

    session = { ...session, running: true }
    view.render()
    await setImmediate()
    view.render()
    context = value
    t.mock.timers.tick(3_000)
    await setImmediate()
    view.render()
    assert.deepEqual(store.getSnapshot(), { status: 'ready', value })

    context = null
    session = { running: false, modelSelection: 'official' }
    view.render()
    await setImmediate()
    view.render()
    assert.notEqual(store.getSnapshot().status, 'ready', 'changing routes must clear the old Magpie context')
  } finally {
    view.dispose()
  }
})
