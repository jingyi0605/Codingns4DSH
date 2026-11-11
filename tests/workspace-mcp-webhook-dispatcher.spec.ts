import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileWorkspaceMcpWebhookStore, type WorkspaceMcpWebhookDelivery, type WorkspaceMcpWebhookDestination } from '../src/host/workspace-mcp/webhook-store.ts'
import { WorkspaceMcpWebhookDispatcher } from '../src/host/workspace-mcp/webhook-dispatcher.ts'
import { createWorkspaceMcpWebhookPayload, serializeWorkspaceMcpWebhookPayload } from '../src/host/workspace-mcp/webhook-payload.ts'

const startTime = Date.parse('2026-11-10T08:00:00.000Z')

function destination(id: string): WorkspaceMcpWebhookDestination {
  const createdAt = new Date(startTime).toISOString()
  return {
    id, name: id, url: `http://127.0.0.1/${id}`, secret: `secret-${id}`, enabled: true,
    workspaceIds: null, eventTypes: ['session.completed'], includeLastMessage: true, createdAt, updatedAt: createdAt,
  }
}

function delivery(id: string, destinationId: string, createdAt = new Date(startTime).toISOString()): WorkspaceMcpWebhookDelivery {
  const target = destination(destinationId)
  return {
    deliveryId: id, eventId: `event-${id}`, dedupeKey: `dedupe-${id}`, eventType: 'session.completed', destinationId, destinationName: target.name,
    destinationSnapshot: { url: target.url, secret: target.secret, includeLastMessage: target.includeLastMessage },
    status: 'pending', attempts: 0, nextAttemptAt: startTime, lastError: null, body: `{"event":"${id}"}`,
    createdAt, finishedAt: null,
  }
}

async function fixture(options: {
  readonly fetch: typeof fetch
  readonly concurrency?: number
  readonly random?: () => number
}): Promise<{
  readonly root: string
  readonly store: FileWorkspaceMcpWebhookStore
  readonly dispatcher: WorkspaceMcpWebhookDispatcher
  now(): number
  advance(ms: number): void
  runTimer(index?: number): void
  timerDelays(): number[]
  timerCount(): number
  clear(): void
}> {
  const root = await mkdtemp(join(tmpdir(), 'codingns-webhook-dispatcher-'))
  let now = startTime
  let timerId = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const timer = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    timerId += 1
    timers.set(timerId, { callback, delay })
    return timerId as unknown as ReturnType<typeof setTimeout>
  }
  const clearTimer = (value: ReturnType<typeof setTimeout>): void => { timers.delete(value as unknown as number) }
  const store = new FileWorkspaceMcpWebhookStore(join(root, 'workspace-mcp-webhooks.json'), () => now)
  const dispatcher = new WorkspaceMcpWebhookDispatcher(store, {
    fetch: options.fetch,
    now: () => now,
    setTimer: timer,
    clearTimer,
    random: options.random ?? (() => 0),
    timeoutMs: 100,
    concurrency: options.concurrency ?? 4,
  })
  return {
    root, store, dispatcher,
    now: () => now,
    advance(ms) { now += ms },
    runTimer(index = 0) {
      const entry = [...timers.entries()][index]
      if (entry === undefined) throw new Error('No scheduled timer at the requested index.')
      timers.delete(entry[0])
      entry[1].callback()
    },
    timerDelays: () => [...timers.values()].map((value) => value.delay),
    timerCount: () => timers.size,
    clear() { timers.clear() },
  }
}

test('dispatcher delivers 2xx with signature over the exact request body and no idle timer', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const f = await fixture({ fetch: (async (url, init) => {
    requests.push({ url: String(url), init: init! })
    return new Response(null, { status: 204 })
  }) as typeof fetch })
  try {
    await f.store.createDestination(destination('dst'))
    await f.store.enqueue(delivery('delivery-1', 'dst'))
    f.dispatcher.wake()
    await f.dispatcher.settleReady()
    const request = requests[0]!
    const body = String(request.init.body)
    const headers = new Headers(request.init.headers)
    const expected = createHmac('sha256', 'secret-dst').update(`${headers.get('X-CodingNS-Timestamp')}.${body}`).digest('hex')
    assert.equal(request.url, 'http://127.0.0.1/dst')
    assert.equal(headers.get('X-CodingNS-Delivery-Id'), 'delivery-1')
    assert.equal(headers.get('X-CodingNS-Signature'), `sha256=${expected}`)
    assert.equal(request.init.redirect, 'manual')
    assert.equal((await f.store.snapshot()).deliveries[0]?.status, 'delivered')
    assert.equal(f.timerCount(), 0)
  } finally {
    await f.dispatcher.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('dispatcher retries 5xx with the same body and Delivery-Id', async () => {
  const requests: Array<{ body: string; deliveryId: string }> = []
  let count = 0
  const f = await fixture({ fetch: (async (_url, init) => {
    const headers = new Headers(init?.headers)
    requests.push({ body: String(init?.body), deliveryId: headers.get('X-CodingNS-Delivery-Id') ?? '' })
    count += 1
    return new Response(null, { status: count === 1 ? 503 : 200 })
  }) as typeof fetch })
  try {
    await f.store.createDestination(destination('dst'))
    await f.store.enqueue(delivery('stable-id', 'dst'))
    f.dispatcher.wake()
    await f.dispatcher.settleReady()
    assert.deepEqual(f.timerDelays(), [2_000])
    f.advance(2_000)
    f.runTimer()
    await f.dispatcher.settleReady()
    assert.equal(requests.length, 2)
    assert.equal(requests[1]?.deliveryId, requests[0]?.deliveryId)
    assert.equal(requests[1]?.body, requests[0]?.body)
    assert.equal((await f.store.snapshot()).deliveries[0]?.status, 'delivered')
  } finally {
    await f.dispatcher.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('dispatcher honors bounded Retry-After for 429 and does not retry other 4xx', async () => {
  let count = 0
  const f = await fixture({ fetch: (async () => {
    count += 1
    return count === 1
      ? new Response(null, { status: 429, headers: { 'Retry-After': '120' } })
      : new Response(null, { status: 400 })
  }) as typeof fetch })
  try {
    await f.store.createDestination(destination('dst'))
    await f.store.enqueue(delivery('retry-after', 'dst'))
    f.dispatcher.wake()
    await f.dispatcher.settleReady()
    assert.deepEqual(f.timerDelays(), [120_000])
    f.advance(120_000)
    f.runTimer()
    await f.dispatcher.settleReady()
    assert.equal((await f.store.snapshot()).deliveries[0]?.status, 'failed')
    assert.equal(count, 2)

    const bounded = await f.dispatcher.test({ destinationId: 'dst', url: 'http://127.0.0.1/test', secret: 'secret' })
    assert.deepEqual(bounded, { ok: false, httpStatus: 400, errorKind: 'http_400' })
  } finally {
    await f.dispatcher.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('dispatcher rejects redirects and treats network failures as retryable', async () => {
  let networkFailure = false
  const f = await fixture({ fetch: (async () => {
    if (networkFailure) throw new TypeError('offline')
    return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/elsewhere' } })
  }) as typeof fetch })
  try {
    await f.store.createDestination(destination('dst'))
    await f.store.enqueue(delivery('redirect', 'dst'))
    f.dispatcher.wake()
    await f.dispatcher.settleReady()
    assert.equal((await f.store.snapshot()).deliveries[0]?.status, 'failed')
    assert.equal(f.timerCount(), 0)

    networkFailure = true
    const network = await f.dispatcher.test({ destinationId: 'dst', url: 'http://127.0.0.1/test', secret: 'secret' })
    assert.equal(network.errorKind, 'network_error')
  } finally {
    await f.dispatcher.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('dispatcher aborts timed out requests and classifies them for retry', async () => {
  const f = await fixture({ fetch: (async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal as AbortSignal
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })) as typeof fetch })
  try {
    const request = f.dispatcher.test({ destinationId: 'dst', url: 'http://127.0.0.1/slow', secret: 'secret' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(f.timerDelays(), [100])
    f.runTimer()
    assert.deepEqual(await request, { ok: false, errorKind: 'timeout' })
  } finally {
    await f.dispatcher.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('same destination stays serial and different destinations respect the concurrency limit', async () => {
  const destinations = [destination('a'), destination('b')]
  const deliveries = [delivery('a1', 'a'), delivery('a2', 'a', new Date(startTime + 1).toISOString()), delivery('b1', 'b', new Date(startTime + 2).toISOString())]
  const store = {
    async snapshot() { return { version: 1 as const, destinations, deliveries, diagnostics: { droppedFinishedDeliveries: 0, droppedPendingDeliveries: 0 }, store: 'ok' as const } },
    async updateDelivery(id: string, patch: Partial<WorkspaceMcpWebhookDelivery>) {
      const index = deliveries.findIndex((row) => row.deliveryId === id)
      deliveries[index] = { ...deliveries[index]!, ...patch }
      return deliveries[index]!
    },
  }
  const activeUrls = new Set<string>()
  const simultaneous: number[] = []
  const pending: Array<{ url: string; resolve(): void }> = []
  const dispatcher = new WorkspaceMcpWebhookDispatcher(store as unknown as FileWorkspaceMcpWebhookStore, { concurrency: 2, fetch: (async (url) => {
    const target = String(url)
    assert.equal(activeUrls.has(target), false)
    activeUrls.add(target)
    simultaneous.push(activeUrls.size)
    await new Promise<void>((resolve) => pending.push({ url: target, resolve }))
    activeUrls.delete(target)
    return new Response(null, { status: 200 })
  }) as typeof fetch })
  try {
    dispatcher.wake()
    for (let index = 0; index < 20 && pending.length < 2; index += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(pending.length, 2)
    assert.deepEqual(new Set(pending.map((item) => item.url)), new Set(['http://127.0.0.1/a', 'http://127.0.0.1/b']))
    const first = pending.splice(0)
    first.forEach((item) => item.resolve())
    for (let index = 0; index < 20 && pending.length < 1; index += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.url, 'http://127.0.0.1/a')
    pending.splice(0).forEach((item) => item.resolve())
    for (let index = 0; index < 50 && deliveries.some((row) => row.status !== 'delivered'); index += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.ok(Math.max(...simultaneous) <= 2)
    assert.deepEqual(deliveries.map((item) => item.status), ['delivered', 'delivered', 'delivered'])
  } finally {
    pending.splice(0).forEach((item) => item.resolve())
    await dispatcher.close()
  }
})

test('dispatcher close aborts in-flight requests and clears the retry timer', async () => {
  let observedSignal: AbortSignal | undefined
  const f = await fixture({ fetch: (async (_url, init) => {
    observedSignal = init?.signal as AbortSignal
    await new Promise<void>((resolve) => observedSignal!.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('aborted')
  }) as typeof fetch })
  try {
    await f.store.createDestination(destination('dst'))
    await f.store.enqueue(delivery('close-me', 'dst'))
    f.dispatcher.wake()
    for (let index = 0; index < 20 && observedSignal === undefined; index += 1) await new Promise((resolve) => setImmediate(resolve))
    assert.ok(observedSignal)
    await f.dispatcher.close()
    assert.equal(observedSignal?.aborted, true)
    assert.equal(f.timerCount(), 0)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('restart recovers a durable delivery, preserves its signed body, and deduplicates the event', async () => {
  const requests: Array<{ body: string; headers: Headers }> = []
  const f = await fixture({ fetch: (async (_url, init) => {
    requests.push({ body: String(init?.body), headers: new Headers(init?.headers) })
    return new Response(null, { status: 200 })
  }) as typeof fetch })
  const target = destination('dst')
  const payload = createWorkspaceMcpWebhookPayload({
    eventId: 'stable-event', type: 'session.completed', occurredAt: new Date(startTime).toISOString(),
    destinationId: target.id, workspace: { id: 'workspace-1', name: 'Project' },
    session: { id: 'session-1', title: 'Session' }, data: { lastMessage: 'Completed.' },
  })
  const body = serializeWorkspaceMcpWebhookPayload(payload)
  const dedupeKey = createHash('sha256').update('dst\0session-1\0session.completed\0turn:4').digest('hex')
  const queued = {
    ...delivery('stable-delivery', target.id), eventId: payload.eventId, dedupeKey,
    eventType: 'session.completed' as const,
    destinationSnapshot: { url: target.url, secret: target.secret, includeLastMessage: true },
    status: 'sending' as const, attempts: 1, body,
  }
  try {
    await f.store.createDestination(target)
    await f.store.enqueue(queued)
    await f.store.close()

    const restored = new FileWorkspaceMcpWebhookStore(join(f.root, 'workspace-mcp-webhooks.json'), () => startTime)
    const snapshot = await restored.snapshot()
    assert.equal(snapshot.deliveries[0]?.status, 'pending')
    assert.equal(snapshot.deliveries[0]?.body, body)
    assert.deepEqual(await restored.enqueueOnce({ ...queued, status: 'pending' }), { queued: false, droppedPending: 0 })

    const dispatcher = new WorkspaceMcpWebhookDispatcher(restored, {
      fetch: (async (_url, init) => {
        requests.push({ body: String(init?.body), headers: new Headers(init?.headers) })
        return new Response(null, { status: 204 })
      }) as typeof fetch,
      now: () => startTime,
    })
    try {
      dispatcher.wake()
      await dispatcher.settleReady()
      const request = requests[0]!
      const timestamp = request.headers.get('X-CodingNS-Timestamp')!
      const signature = createHmac('sha256', target.secret).update(`${timestamp}.${body}`).digest('hex')
      assert.equal(request.body, body)
      assert.equal(request.headers.get('X-CodingNS-Delivery-Id'), 'stable-delivery')
      assert.equal(request.headers.get('X-CodingNS-Signature'), `sha256=${signature}`)
      assert.equal((await restored.snapshot()).deliveries[0]?.status, 'delivered')
    } finally {
      await dispatcher.close()
    }
  } finally {
    await f.dispatcher.close()
    await rm(f.root, { recursive: true, force: true })
  }
})
