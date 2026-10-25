import assert from 'node:assert/strict'
import test from 'node:test'
import { installSessionHandleEviction, type SessionHandleEvictionController } from '../data/build/dist/host/session-handle-eviction.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'

interface FakeHandle {
  readonly id: string
  readonly access: 'read' | 'write'
  buffered: unknown[]
  closed: boolean
  closing?: Promise<void>
  subscribers?: Set<string>
  close(): Promise<void>
  read?(): Promise<void>
  append?(): Promise<void>
  subscribe?(): () => void
}

interface FakePersistence {
  open(id: string, access: 'read' | 'write'): Promise<FakeHandle>
  flushAll(): Promise<void>
}

interface FakeFixture {
  persistence: FakePersistence
  handles: Map<string, FakeHandle>
  closeOrder: string[]
  lockOwners: Set<string>
}

function fixture(options: { readonly pendingRead?: Promise<void> } = {}): FakeFixture {
  const handles = new Map<string, FakeHandle>()
  const closeOrder: string[] = []
  const lockOwners = new Set<string>()
  const persistence: FakePersistence = {
    async open(id, access) {
      if (access === 'write' && lockOwners.has(id)) throw new Error(`write lock held: ${id}`)
      if (access === 'write') lockOwners.add(id)
      const handle: FakeHandle = {
        id,
        access,
        buffered: [],
        closed: false,
        async close() {
          if (handle.closed) return
          handle.closed = true
          lockOwners.delete(id)
          closeOrder.push(id)
        },
        async read() {
          await options.pendingRead
        },
        async append() {},
        subscribe() { return () => {} },
      }
      handles.set(`${id}:${access}:${handles.size}`, handle)
      return handle
    },
    async flushAll() {},
  }
  return { persistence, handles, closeOrder, lockOwners }
}

function controller(
  persistence: FakePersistence,
  now: () => number,
  settings: Partial<{ enabled: boolean; idleTtlMs: number; maxOpenHandles: number }> = {},
  logs: Array<{ message: string; fields: Record<string, unknown> }> = [],
): SessionHandleEvictionController {
  const result = installSessionHandleEviction(persistence, {
    settings: {
      enabled: settings.enabled ?? true,
      idleTtlMs: settings.idleTtlMs ?? 600_000,
      maxOpenHandles: settings.maxOpenHandles ?? 32,
    },
    now,
    logger: { debug: (message, fields) => logs.push({ message, fields }) },
  })
  assert.ok(result)
  return result
}

test('session handle defaults are enabled with a ten-minute TTL and a 32-handle cap', () => {
  assert.deepEqual(DEFAULT_CODINGNS_SETTINGS.sessionHandleEviction, { enabled: true, idleTtlMs: 600_000, maxOpenHandles: 32 })
  assert.deepEqual(CodingNsSettingsSchema({}).sessionHandleEviction, DEFAULT_CODINGNS_SETTINGS.sessionHandleEviction)
})

test('TTL eviction closes an idle read handle and emits diagnostics', async () => {
  let clock = 0
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = []
  const fake = fixture()
  const tracker = controller(fake.persistence, () => clock, { idleTtlMs: 100, maxOpenHandles: 32 }, logs)
  await fake.persistence.open('idle', 'read')
  clock = 100
  await tracker.sweep()

  assert.deepEqual(fake.closeOrder, ['idle'])
  assert.deepEqual(tracker.getDiagnostics(), { openHandles: 0, maxOpenHandles: 32, evictedTotal: 1 })
  assert.deepEqual(logs.find((entry) => entry.message === 'session handle evicted')?.fields, { id: 'idle', reason: 'ttl', idleMs: 100, openCount: 1 })
  await tracker.dispose()
})

test('cap eviction uses LRU order without waiting for the TTL', async () => {
  let clock = 0
  const fake = fixture()
  const tracker = controller(fake.persistence, () => clock, { idleTtlMs: 10_000, maxOpenHandles: 2 })
  await fake.persistence.open('oldest', 'read')
  clock = 1
  const recent = await fake.persistence.open('recent', 'read')
  await recent.read?.()
  clock = 2
  await fake.persistence.open('newest', 'read')
  await tracker.sweep()

  assert.deepEqual(fake.closeOrder, ['oldest'])
  assert.equal(tracker.getDiagnostics().openHandles, 2)
  await tracker.dispose()
})

test('buffered writes, active reads, and active iterators are never evicted', async () => {
  let clock = 0
  let releaseRead: (() => void) | undefined
  const pendingRead = new Promise<void>((resolve) => { releaseRead = resolve })
  const fake = fixture({ pendingRead })
  const tracker = controller(fake.persistence, () => clock, { idleTtlMs: 100, maxOpenHandles: 1 })
  const write = await fake.persistence.open('buffered', 'write')
  write.buffered.push('event')
  const active = await fake.persistence.open('active-read', 'read')
  const read = active.read?.()
  clock = 100
  await tracker.sweep()
  assert.deepEqual(fake.closeOrder, [])

  write.buffered.length = 0
  releaseRead?.()
  await read
  await tracker.sweep()
  assert.deepEqual(fake.closeOrder.slice().sort(), ['active-read', 'buffered'])

  const iteratorHandle = await fake.persistence.open('iterator', 'read')
  let releaseNext: ((value: IteratorResult<unknown>) => void) | undefined
  const pendingNext = new Promise<IteratorResult<unknown>>((resolve) => { releaseNext = resolve })
  Object.defineProperty(iteratorHandle, Symbol.asyncIterator, {
    configurable: true,
    value: () => ({
      next: () => pendingNext,
      return: async () => ({ done: true, value: undefined }),
      [Symbol.asyncIterator]() { return this },
    }),
  })
  const iterator = (iteratorHandle as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]()
  const next = iterator.next()
  await tracker.sweep()
  assert.equal(iteratorHandle.closed, false)
  releaseNext?.({ done: false, value: 'live' })
  await next
  await iterator.return?.()
  clock = 200
  await tracker.sweep()
  assert.equal(iteratorHandle.closed, true)

  const subscribed = await fake.persistence.open('subscriber', 'read')
  const unsubscribe = subscribed.subscribe!()
  clock = 300
  await tracker.sweep()
  assert.equal(subscribed.closed, false)
  unsubscribe()
  clock = 400
  await tracker.sweep()
  assert.equal(subscribed.closed, true)
  await tracker.dispose()
})

test('flushAll is a barrier against concurrent eviction', async () => {
  let clock = 0
  let releaseFlush: (() => void) | undefined
  const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
  const fake = fixture()
  const originalFlushAll = fake.persistence.flushAll
  fake.persistence.flushAll = async () => { await flushGate; await originalFlushAll() }
  const tracker = controller(fake.persistence, () => clock, { idleTtlMs: 100, maxOpenHandles: 1 })
  await fake.persistence.open('barrier', 'write')
  clock = 100
  const flushing = fake.persistence.flushAll()
  await Promise.resolve()
  await tracker.sweep()
  assert.deepEqual(fake.closeOrder, [])
  releaseFlush?.()
  await flushing
  await tracker.sweep()
  assert.deepEqual(fake.closeOrder, ['barrier'])
  await tracker.dispose()
})

test('eviction closes the existing handle and releases its write lock', async () => {
  let clock = 0
  const fake = fixture()
  const tracker = controller(fake.persistence, () => clock, { idleTtlMs: 10_000, maxOpenHandles: 1 })
  await fake.persistence.open('locked', 'write')
  await fake.persistence.open('other', 'read')
  await tracker.sweep()

  assert.equal(fake.lockOwners.has('locked'), false)
  await assert.doesNotReject(() => fake.persistence.open('locked', 'write'))
  await tracker.dispose()
})

test('disabled eviction leaves the persistence service untouched', async () => {
  const fake = fixture()
  const originalOpen = fake.persistence.open
  assert.equal(installSessionHandleEviction(fake.persistence, {
    settings: { enabled: false, idleTtlMs: 100, maxOpenHandles: 1 },
  }), undefined)
  assert.equal(fake.persistence.open, originalOpen)
})
