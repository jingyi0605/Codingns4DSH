import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorkspaceMcpHostFeature } from '../src/host/features/workspace-mcp.ts'
import { FileWorkspaceMcpWebhookStore } from '../src/host/workspace-mcp/webhook-store.ts'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

const now = Date.parse('2026-11-11T00:00:00.000Z')

test('webhook management is owner-only, returns one-time secrets, and masks URL details', async () => {
  const f = await fixture()
  try {
    for (const action of ['webhook-list', 'webhook-create', 'webhook-update', 'webhook-rotate-secret', 'webhook-delete', 'webhook-test']) {
      await assert.rejects(f.rpc(action)({}, { peer: undefined }), (error: unknown) => (error as { code?: string }).code === 'CODINGNS_RPC_FORBIDDEN')
    }
    const list = f.rpc('webhook-list')
    f.setOwner(true)
    const created = await f.rpc('webhook-create')({
      name: 'Local agent', url: 'http://127.0.0.1:8100/hook?token=hidden', workspaceIds: null,
      eventTypes: ['session.completed'],
    }) as { destination: Record<string, unknown>; secret: string }
    assert.equal(created.destination.secretConfigured, true)
    assert.equal(created.destination.url, 'http://127.0.0.1:8100/…')
    assert.equal(JSON.stringify(created.destination).includes('hidden'), false)
    assert.equal(created.secret.length, 43)
    assert.equal(f.sessionListeners.size, 1)

    const listResult = await list({}, { peer: undefined }) as { destinations: Array<Record<string, unknown>> }
    assert.equal(JSON.stringify(listResult).includes('hidden'), false)
    assert.equal(JSON.stringify(listResult).includes(created.secret), false)

    const invalidUrl = await f.rpc('webhook-create')({
      name: 'Invalid', url: 'file:///etc/passwd', workspaceIds: null, eventTypes: ['session.completed'],
    }).then(() => null, (error: unknown) => (error as { code?: string }).code)
    assert.equal(invalidUrl, 'WORKSPACE_MCP_WEBHOOK_INVALID_URL')

    const rotated = await f.rpc('webhook-rotate-secret')({ id: created.destination.id }) as { destination: Record<string, unknown>; secret: string }
    assert.notEqual(rotated.secret, created.secret)
    assert.equal(rotated.destination.secretConfigured, true)
    assert.equal(JSON.stringify(rotated.destination).includes(rotated.secret), false)
  } finally {
    await f.dispose()
  }
})

test('webhook test sends a signed test message without queueing; disabling and deleting releases work', async () => {
  const f = await fixture()
  try {
    f.setOwner(true)
    const created = await f.rpc('webhook-create')({
      name: 'Local agent', url: 'http://127.0.0.1:8100/hook', workspaceIds: null, eventTypes: ['session.completed'],
    }) as { destination: Record<string, unknown>; secret: string }
    const testResult = await f.rpc('webhook-test')({ id: created.destination.id }) as { ok: boolean; httpStatus: number }
    assert.deepEqual(testResult, { ok: true, httpStatus: 204 })
    assert.equal(f.requests.length, 1)
    assert.equal(JSON.parse(f.requests[0]!.body).type, 'webhook.test')
    assert.equal((await f.store.snapshot()).deliveries.length, 0)

    f.fetchMode = 'retry'
    f.emitCompleted()
    await f.waitFor(() => f.timers.size > 0)
    assert.equal(f.sessionListeners.size, 1)
    await f.rpc('webhook-update')({ id: created.destination.id, enabled: false })
    assert.equal(f.sessionListeners.size, 0)
    assert.equal(f.timers.size, 0)
    assert.equal((await f.store.snapshot()).deliveries[0]?.status, 'pending')

    await f.rpc('webhook-update')({ id: created.destination.id, enabled: true })
    assert.equal(f.sessionListeners.size, 1)
    const removed = await f.rpc('webhook-delete')({ id: created.destination.id })
    assert.deepEqual(removed, { removed: true })
    assert.equal(f.sessionListeners.size, 0)
    assert.deepEqual((await f.store.snapshot()).deliveries, [])
  } finally {
    await f.dispose()
  }
})

test('enabled destinations from the private store are restored when the feature starts', async () => {
  const f = await fixture({ preconfigured: true })
  try {
    await f.waitFor(() => f.sessionListeners.size === 1)
    assert.equal(f.sessionListeners.size, 1)
    f.setOwner(true)
    const listed = await f.rpc('webhook-list')({}, { peer: undefined }) as { destinations: Array<Record<string, unknown>> }
    assert.equal(listed.destinations.length, 1)
  } finally {
    await f.dispose()
  }
})

async function fixture(options: { readonly preconfigured?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codingns-webhook-feature-'))
  const store = new FileWorkspaceMcpWebhookStore(join(root, 'workspace-mcp-webhooks.json'), () => now)
  if (options.preconfigured === true) await store.createDestination({
    id: 'restored', name: 'Restored', url: 'http://127.0.0.1:8100/hook', secret: 'restored-secret', enabled: true,
    workspaceIds: null, eventTypes: ['session.completed'], includeLastMessage: true,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  })
  const table = new CodingNsRpcTable()
  const resources: Array<() => void | Promise<void>> = []
  const sessionListeners = new Set<(session: unknown, event: unknown) => void>()
  const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const requests: Array<{ body: string; headers: Headers }> = []
  let timerId = 0
  let owner = false
  let fetchMode: 'success' | 'retry' = 'success'
  const config = { modules: { workspaceMcp: false, workspaceMcpLanAccess: false } }
  const feature = createWorkspaceMcpHostFeature({
    webhookStore: store,
    isOwner: () => owner,
    webhookDispatcherOptions: {
      now: () => now,
      timeoutMs: 100,
      setTimer: (callback, delay) => { timerId += 1; timers.set(timerId, { callback, delay }); return timerId as unknown as ReturnType<typeof setTimeout> },
      clearTimer: (timer) => timers.delete(timer as unknown as number),
      fetch: (async (_url, init) => {
        const body = String(init?.body)
        requests.push({ body, headers: new Headers(init?.headers) })
        return new Response(null, { status: body.includes('webhook.test') || fetchMode === 'success' ? 204 : 503 })
      }) as typeof fetch,
    },
  })
  const services = {
    rpc: table,
    settings: {
      get: () => config,
      watch: () => () => undefined,
      async update() {},
    },
    nativeSessions: {
      supportsEvents: true,
      subscribe({ onEvent }: { onEvent(session: unknown, event: unknown): void }) {
        sessionListeners.add(onEvent)
        return () => sessionListeners.delete(onEvent)
      },
      get: (id: string) => id === 'session-1' ? { id, header: { id } } : undefined,
      list: () => [{ id: 'session-1', header: { id: 'session-1' } }],
    },
    events: {
      on(name: string, listener: (...args: unknown[]) => void) {
        const listeners = eventListeners.get(name) ?? new Set()
        listeners.add(listener)
        eventListeners.set(name, listeners)
        return () => listeners.delete(listener)
      },
    },
    resolveManagedWorkspaceRoot: () => '/private/workspace',
    dshContext: { get: (name: string) => name === 'workspaceRegistry'
      ? { list: () => [{ id: 'workspace-1', title: 'Project', sessionIds: ['session-1'] }], archivedSessionIds: [] }
      : undefined },
  }
  await feature.start({ services: services as never, resources: { add: (dispose: () => void | Promise<void>) => resources.push(dispose) } } as never)
  await new Promise((resolve) => setImmediate(resolve))

  return {
    store,
    requests,
    timers,
    sessionListeners,
    rpc(action: string) { const target = table.resolve(`workspaceMcp/${action}`); assert.ok(target); return target.handler.bind(null, target.action) as (...args: any[]) => Promise<unknown> },
    setOwner(value: boolean) { owner = value },
    set fetchMode(value: 'success' | 'retry') { fetchMode = value },
    emitCompleted() {
      for (const listener of sessionListeners) {
        listener({ id: 'session-1', header: { id: 'session-1' } }, { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
      }
    },
    async waitFor(predicate: () => boolean) {
      for (let index = 0; index < 100 && !predicate(); index += 1) await new Promise((resolve) => setImmediate(resolve))
      assert.equal(predicate(), true)
    },
    async dispose() {
      for (const dispose of resources.reverse()) await dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
