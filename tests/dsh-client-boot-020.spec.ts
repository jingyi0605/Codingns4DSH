import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  CODINGNS_BOOTSTRAP_DSH_VERSION,
  installPreCordisTransport,
} from '../data/build/dist/bootstrap/index.js'
import { createDsh020AggregatedTransportFixture } from './fixtures/dsh-020-aggregated-transport.mjs'

test('0.2.0-rc.1 Client boot 前可安装 Aggregated Transport 并建立公开 Connection', async () => {
  const loaded: { apply?: (ctx: Context) => void } = {}
  const previousWindow = (globalThis as typeof globalThis & { window?: unknown }).window
  ;(globalThis as typeof globalThis & { window?: unknown }).window = {
    __ModuleLoader__: {
      load({ factory }: { factory: (require: never) => { apply?: (ctx: Context) => void } }) {
        Object.assign(loaded, factory(undefined as never))
      },
    },
  }
  const applyModule = await import('@deepseek-ai/dsh-client-connection/client')
  const applyDshConnection = loaded.apply ?? (applyModule as unknown as { apply?: (ctx: Context) => void }).apply
  assert.equal(typeof applyDshConnection, 'function')
  const fixture = createDsh020AggregatedTransportFixture({
    workspaces: [{ workspaceId: 'peer-a:workspace-1', title: 'Peer A', sessionIds: ['peer-a:session-1'] }],
    sessions: [{ sessionId: 'peer-a:session-1', workspaceId: 'peer-a:workspace-1', title: '会话 A' }],
  })
  // 当前 bootstrap 类型仍保留旧版函数型 rpc；运行时公开契约是 rpc.call/open。
  const registration = installPreCordisTransport({
    dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION,
    transport: fixture.hooks as never,
  })
  const app = new Context()
  try {
    await app.plugin(applyDshConnection)
    const connection = app.get('connection') as {
      readonly rpc: { call: (channel: string, endpoint: string, payload: unknown) => Promise<{ ok: true; value: unknown }> }
      readonly generation: { getSnapshot: () => unknown }
      registerGenerationSource(source: typeof fixture.generationSource): () => void
      start(sinks: { onConnected?: (host: { home: string }) => void }): { stop(): void }
    }
    let connected = false
    const unregister = connection.registerGenerationSource(fixture.generationSource)
    const loop = connection.start({ onConnected: () => { connected = true } })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(connected, true)
    assert.deepEqual(connection.generation.getSnapshot(), { id: 1, host: { home: '/aggregated' } })

    const workspaces = await connection.rpc.call('/codingns', 'aggregate/workspace/list', {})
    const sessions = await connection.rpc.call('/codingns', 'aggregate/session/list', {})
    assert.deepEqual(workspaces.value, { items: fixture.snapshot.workspaces })
    assert.deepEqual(sessions.value, { items: fixture.snapshot.sessions })
    assert.deepEqual(fixture.calls.map(({ endpoint }) => endpoint), ['aggregate/workspace/list', 'aggregate/session/list'])

    loop.stop()
    unregister()
  } finally {
    registration.dispose()
    ;(globalThis as typeof globalThis & { window?: unknown }).window = previousWindow
  }
})
