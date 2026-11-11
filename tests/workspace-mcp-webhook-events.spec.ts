import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { attachWorkspaceMcpWebhookEvents } from '../src/host/workspace-mcp/webhook-events.ts'
import { FileWorkspaceMcpWebhookStore, type WorkspaceMcpWebhookDestination } from '../src/host/workspace-mcp/webhook-store.ts'

const timestamp = '2026-11-10T08:00:00.000Z'

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function destination(id: string, eventTypes: WorkspaceMcpWebhookDestination['eventTypes'] = ['session.completed', 'session.failed', 'session.permission_requested', 'session.question_asked']): WorkspaceMcpWebhookDestination {
  return { id, name: id, url: `http://127.0.0.1/${id}`, secret: `secret-${id}`, enabled: true,
    workspaceIds: null, eventTypes, includeLastMessage: true, createdAt: timestamp, updatedAt: timestamp }
}

async function fixture(options: {
  readonly pendingQuestions?: { list(sessionId: string): readonly unknown[] | null }
  readonly archived?: boolean
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codingns-webhook-events-'))
  const store = new FileWorkspaceMcpWebhookStore(join(root, 'workspace-mcp-webhooks.json'), () => Date.parse(timestamp))
  await store.createDestination(destination('all'))
  await store.createDestination({ ...destination('completed-only'), eventTypes: ['session.completed'] })
  const session = { id: 'session-1', header: { id: 'session-1' } }
  const sessionListeners = new Set<(session: unknown, event: unknown) => void>()
  const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const nativeSessions = {
    supportsEvents: true,
    subscribe(handler: { onEvent(session: unknown, event: unknown): void }) {
      const listener = handler.onEvent
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    },
    get(id: string) { return id === session.id ? session : undefined },
    list() { return [session] },
  }
  const services = {
    nativeSessions,
    events: {
      on(name: string, listener: (...args: unknown[]) => void) {
        const listeners = eventListeners.get(name) ?? new Set()
        listeners.add(listener)
        eventListeners.set(name, listeners)
        return () => listeners.delete(listener)
      },
    },
    resolveManagedWorkspaceRoot: () => '/private/project',
    dshContext: { get: (name: string) => name === 'workspaceRegistry'
      ? { list: () => [{ id: 'workspace-1', title: 'Project', sessionIds: options.archived ? [] : ['session-1'] }], archivedSessionIds: options.archived ? ['session-1'] : [] }
      : undefined },
  }
  const diagnostics: unknown[] = []
  let queuedCount = 0
  const controller = attachWorkspaceMcpWebhookEvents({
    services: services as never,
    store,
    pendingQuestions: options.pendingQuestions as never,
    sessionList: async () => ({ items: [{ sessionId: 'session-1', projections: { values: { title: 'Safe title' } } }] }),
    diagnostics: (diagnostic) => diagnostics.push(diagnostic),
    onQueued: () => { queuedCount += 1 },
    now: () => Date.parse(timestamp),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
  })
  const emit = (event: Record<string, unknown>): void => sessionListeners.forEach((listener) => listener(session, event))
  const emitQuestion = (request: unknown = { session: { id: 'session-1' } }): void => {
    for (const listener of eventListeners.get('user-questions/request') ?? []) listener(request)
  }
  return { root, store, controller, emit, emitQuestion, diagnostics, sessionListeners, eventListeners, queuedCount: () => queuedCount }
}

test('session completed queues one signed-body candidate per matching destination and persists event identity', async () => {
  const f = await fixture()
  try {
    f.emit({ type: 'assistant/message', seq: 2, time: Date.parse(timestamp), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] } } })
    f.emit({ type: 'turn/end', seq: 3, time: Date.parse(timestamp), data: { turn: 1, reason: { kind: 'completed' } } })
    await waitFor(() => f.queuedCount() >= 2)
    const snapshot = await f.store.snapshot()
    assert.equal(snapshot.deliveries.length, 2)
    const all = snapshot.deliveries.find((item) => item.destinationId === 'all')!
    assert.equal(JSON.parse(all.body).data.lastMessage, 'Final answer')
    assert.equal(JSON.parse(all.body).session.title, 'Safe title')
    assert.equal(all.dedupeKey, createHash('sha256').update(`all\0session-1\0session.completed\0turn:3`).digest('hex'))
    f.emit({ type: 'turn/end', seq: 3, time: Date.parse(timestamp), data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await f.store.snapshot()).deliveries.length, 2)
  } finally {
    f.controller.dispose()
    await f.store.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('user abort does not emit failure and approval event carries its native request ID', async () => {
  const f = await fixture()
  try {
    f.emit({ type: 'turn/end', seq: 3, time: Date.parse(timestamp), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    f.emit({ type: 'approval/asked', seq: 4, time: Date.parse(timestamp), data: { id: 'approval-4', toolName: 'exec', reason: 'Run command', callId: 'call-1' } })
    f.emit({ type: 'turn/end', seq: 5, time: Date.parse(timestamp), data: { turn: 2, reason: { kind: 'error', error: { code: 'PROVIDER_ERROR', message: 'Request failed.' } } } })
    for (let i = 0; i < 100 && f.queuedCount() < 2; i += 1) await new Promise((resolve) => setImmediate(resolve))
    const rows = (await f.store.snapshot()).deliveries
    assert.equal(rows.length, 2)
    const approval = rows.find((row) => row.eventType === 'session.permission_requested')!
    const failure = rows.find((row) => row.eventType === 'session.failed')!
    assert.equal(JSON.parse(approval.body).data.requestId, 'approval-4')
    assert.equal(JSON.parse(approval.body).data.decidableByExternalAgent, false)
    assert.deepEqual(JSON.parse(failure.body).data, { errorCode: 'PROVIDER_ERROR', errorMessage: 'Request failed.' })
  } finally {
    f.controller.dispose()
    await f.store.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('question signals retry the activity snapshot and route its exact call ID', async () => {
  let reads = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let timerId = 0
  const f = await fixture({
    pendingQuestions: { list: () => {
      reads += 1
      return reads < 2 ? [] : [{ callId: 'call-q', state: 'open', questions: [{ id: 'q1', question: 'Which option?', options: [{ label: 'A' }] }] }]
    } },
    setTimer: (callback, delay) => { timerId += 1; timers.set(timerId, { callback, delay }); return timerId as unknown as ReturnType<typeof setTimeout> },
    clearTimer: (timer) => timers.delete(timer as unknown as number),
  })
  try {
    f.emitQuestion()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(reads, 1)
    assert.deepEqual([...timers.values()].map((timer) => timer.delay), [20])
    const timer = timers.entries().next().value as [number, { callback: () => void; delay: number }]
    timers.delete(timer[0])
    timer[1].callback()
    for (let i = 0; i < 100 && f.queuedCount() < 1; i += 1) await new Promise((resolve) => setImmediate(resolve))
    const row = (await f.store.snapshot()).deliveries[0]!
    assert.equal(row.eventType, 'session.question_asked')
    assert.equal(JSON.parse(row.body).data.callId, 'call-q')
    assert.equal(JSON.parse(row.body).data.questions[0].text, 'Which option?')
  } finally {
    f.controller.dispose()
    await f.store.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('unmanaged and archived sessions are ignored and disposal releases subscriptions', async () => {
  const f = await fixture({ archived: true })
  try {
    f.emit({ type: 'turn/end', seq: 3, time: Date.parse(timestamp), data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await f.store.snapshot()).deliveries.length, 0)
    f.controller.dispose()
    assert.equal(f.sessionListeners.size, 0)
    assert.ok([...f.eventListeners.values()].every((listeners) => listeners.size === 0))
  } finally {
    f.controller.dispose()
    await f.store.close()
    await rm(f.root, { recursive: true, force: true })
  }
})
