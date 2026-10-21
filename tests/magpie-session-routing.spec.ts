import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureRegistry } from '../src/features/registry.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { createMagpieSessionRouting } from '../src/host/cli-adapters/magpie-session-routing.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'

test('native DSH Magpie routing adds the active session to loopback v1 requests', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ readonly url: string; readonly headers: Headers }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return Response.json({ ok: true })
  }) as typeof fetch
  const routing = createMagpieSessionRouting()
  try {
    const stream = routing.wrap('native-dsh-session', (async function* () {
      await fetch('http://127.0.0.1:3425/v1/chat/completions')
      await fetch('http://127.0.0.1:3425/v2/chat/completions')
      await fetch('https://api.example.test/v1/chat/completions')
      await fetch('http://localhost/v1/chat/completions', { headers: { 'X-Magpie-Session': 'existing' } })
      yield 'done'
    })())
    for await (const value of stream) assert.equal(value, 'done')
    await fetch('http://127.0.0.1:3425/v1/chat/completions')
  } finally {
    routing.dispose()
    globalThis.fetch = originalFetch
  }

  assert.equal(calls[0]?.headers.get('x-magpie-session'), 'native-dsh-session')
  assert.equal(calls[1]?.headers.has('x-magpie-session'), false)
  assert.equal(calls[2]?.headers.has('x-magpie-session'), false)
  assert.equal(calls[3]?.headers.get('x-magpie-session'), 'existing')
  assert.equal(calls[4]?.headers.has('x-magpie-session'), false)
})

test('native DSH llm/stream scopes the session header to its provider request', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ readonly url: string; readonly headers: Headers }> = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return Response.json({ ok: true })
  }) as typeof fetch

  let llmListener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  const features = new FeatureRegistry({
    rpc: new CodingNsRpcTable(),
    events: { on(name, listener) {
      if (name === 'llm/stream') llmListener = listener as typeof llmListener
      return () => { if (name === 'llm/stream') llmListener = undefined }
    } },
  } as never)
  features.register(createCliAdaptersFeature({ registry: new CodingNsCliAdapterRegistry([]) }))

  try {
    await features.start('cliAdapters')
    assert.notEqual(llmListener, undefined)
    const chunks: unknown[] = []
    for await (const chunk of llmListener!({ sessionId: 'native-dsh-session', messages: [] }, async function* () {
      await fetch('http://127.0.0.1:3425/v1/chat/completions')
      yield { type: 'text-delta', text: 'native response' }
    })) chunks.push(chunk)
    assert.deepEqual(chunks, [{ type: 'text-delta', text: 'native response' }])
  } finally {
    await features.disable('cliAdapters')
    globalThis.fetch = originalFetch
  }

  assert.equal(calls[0]?.headers.get('x-magpie-session'), 'native-dsh-session')
})
