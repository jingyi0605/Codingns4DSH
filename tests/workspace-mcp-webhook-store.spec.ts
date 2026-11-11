import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FileWorkspaceMcpWebhookStore,
  WorkspaceMcpWebhookStoreError,
  type WorkspaceMcpWebhookDelivery,
  type WorkspaceMcpWebhookDestination,
} from '../src/host/workspace-mcp/webhook-store.ts'

function destination(id = 'destination-1'): WorkspaceMcpWebhookDestination {
  const timestamp = '2026-11-10T00:00:00.000Z'
  return {
    id,
    name: id,
    url: 'http://127.0.0.1/hook?token=private',
    secret: 'private-secret',
    enabled: true,
    workspaceIds: null,
    eventTypes: ['session.completed'],
    includeLastMessage: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function delivery(id: string, createdAt = '2026-11-10T00:00:00.000Z', status: WorkspaceMcpWebhookDelivery['status'] = 'pending'): WorkspaceMcpWebhookDelivery {
  return {
    deliveryId: id,
    eventId: `event-${id}`,
    dedupeKey: `dedupe-${id}`,
    eventType: 'session.completed',
    destinationId: 'destination-1',
    destinationName: 'destination-1',
    destinationSnapshot: { url: 'http://127.0.0.1/hook?token=snapshot', secret: 'snapshot-secret', includeLastMessage: true },
    status,
    attempts: status === 'sending' ? 1 : 0,
    nextAttemptAt: 0,
    lastError: null,
    body: '{"event":"fixed"}',
    createdAt,
    finishedAt: status === 'delivered' ? createdAt : null,
  }
}

test('webhook store uses owner-only permissions and restores in-flight deliveries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-webhook-store-'))
  const file = join(root, 'private', 'workspace-mcp-webhooks.json')
  const store = new FileWorkspaceMcpWebhookStore(file)
  try {
    await store.createDestination(destination())
    await store.enqueue(delivery('sending-1', undefined, 'sending'))
    const saved = JSON.parse(await readFile(file, 'utf8')) as { destinations: unknown[]; deliveries: Array<{ status: string }> }
    assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal(saved.destinations.length, 1)
    assert.equal(saved.deliveries[0]?.status, 'sending')

    const restored = new FileWorkspaceMcpWebhookStore(file)
    const snapshot = await restored.snapshot()
    assert.equal(snapshot.deliveries[0]?.status, 'pending')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).deliveries[0]?.status, 'pending')
    await restored.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('webhook store backs up corrupt data and starts with an empty recovered store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-webhook-corrupt-'))
  const file = join(root, 'workspace-mcp-webhooks.json')
  await writeFile(file, '{broken', 'utf8')
  const store = new FileWorkspaceMcpWebhookStore(file, () => 1_800_000_000_000)
  try {
    const snapshot = await store.snapshot()
    assert.equal(snapshot.store, 'recovered')
    assert.deepEqual(snapshot.destinations, [])
    assert.deepEqual(snapshot.deliveries, [])
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('workspace-mcp-webhooks.json.corrupt-')).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('destination removal drops pending deliveries but preserves finished records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-webhook-delete-'))
  const file = join(root, 'workspace-mcp-webhooks.json')
  const store = new FileWorkspaceMcpWebhookStore(file)
  try {
    await store.createDestination(destination())
    await store.enqueue(delivery('pending-1'))
    await store.enqueue(delivery('delivered-1', '2026-11-10T00:00:00.000Z', 'delivered'))
    assert.equal(await store.removeDestination('destination-1'), true)
    const snapshot = await store.snapshot()
    assert.deepEqual(snapshot.destinations, [])
    assert.deepEqual(snapshot.deliveries.map((item) => item.deliveryId), ['delivered-1'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('webhook store enforces destination and delivery limits and records dropped pending work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-webhook-limits-'))
  const file = join(root, 'workspace-mcp-webhooks.json')
  const store = new FileWorkspaceMcpWebhookStore(file, () => Date.parse('2026-11-10T00:00:00.000Z'))
  try {
    for (let index = 0; index < 20; index += 1) await store.createDestination(destination(`destination-${index}`))
    await assert.rejects(store.createDestination(destination('overflow')), (error: unknown) =>
      error instanceof WorkspaceMcpWebhookStoreError && error.code === 'WORKSPACE_MCP_WEBHOOK_LIMIT')

    const seeded = {
      version: 1,
      destinations: Array.from({ length: 20 }, (_, index) => destination(`destination-${index}`)),
      deliveries: Array.from({ length: 1000 }, (_, index) => delivery(`old-${index}`, new Date(index).toISOString())),
      diagnostics: { droppedFinishedDeliveries: 0, droppedPendingDeliveries: 0 },
    }
    await writeFile(file, JSON.stringify(seeded), 'utf8')
    const loaded = new FileWorkspaceMcpWebhookStore(file, () => Date.parse('2026-11-10T00:00:00.000Z'))
    await loaded.enqueue(delivery('newest', '2026-11-10T00:00:00.000Z'))
    const snapshot = await loaded.snapshot()
    assert.equal(snapshot.deliveries.length, 1000)
    assert.equal(snapshot.deliveries[0]?.deliveryId, 'old-1')
    assert.equal(snapshot.deliveries.at(-1)?.deliveryId, 'newest')
    assert.equal(snapshot.diagnostics.droppedFinishedDeliveries, 0)
    assert.equal(snapshot.diagnostics.droppedPendingDeliveries, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('webhook store removes finished records older than the retention period', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-webhook-retention-'))
  const file = join(root, 'workspace-mcp-webhooks.json')
  const now = Date.parse('2026-11-10T00:00:00.000Z')
  const store = new FileWorkspaceMcpWebhookStore(file, () => now)
  try {
    await store.createDestination(destination())
    await store.enqueue(delivery('expired', '2026-11-01T00:00:00.000Z', 'delivered'))
    await store.enqueue(delivery('recent', '2026-11-09T00:00:00.000Z', 'delivered'))
    await store.enqueue(delivery('pending', '2026-11-01T00:00:00.000Z', 'pending'))
    const snapshot = await store.snapshot()
    assert.deepEqual(snapshot.deliveries.map((item) => item.deliveryId), ['recent', 'pending'])
    assert.equal(snapshot.diagnostics.droppedFinishedDeliveries, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
