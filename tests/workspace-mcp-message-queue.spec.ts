import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { WorkspaceMcpMessageQueue, type QueueNotice } from '../src/host/workspace-mcp/message-queue-handler.ts'
import { createWorkspaceMcpToolHandlers } from '../src/host/workspace-mcp/tools.ts'
import { attachWorkspaceMcpWebhookEvents } from '../src/host/workspace-mcp/webhook-events.ts'
import { FileWorkspaceMcpWebhookStore } from '../src/host/workspace-mcp/webhook-store.ts'
import type { WorkspaceSessionControlAdapter } from '../src/dsh-capabilities/host/workspace-session-control-adapter.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codingns-message-queue-'))
  const filePath = join(root, 'queue.json')
  const listeners = new Set<(session: unknown, event: unknown) => void>()
  const requests: Parameters<WorkspaceSessionControlAdapter['prompt']>[0][] = []
  const notices: QueueNotice[] = []
  const sessions = ['sess', 'other']
  const busy = new Set<string>()
  let idle: ((value: unknown) => void) | undefined
  const nativePending = new Set<string>()
  const control: WorkspaceSessionControlAdapter = {
    async create() { sessions.push('new'); return { id: 'new' } },
    async list() { return { items: sessions.map((id) => ({ id })) } },
    isBusy: (id) => busy.has(id),
    isPromptPending: (_id, requestId) => nativePending.has(requestId),
    async modelCatalog() { return { groups: [] } },
    async prompt(request) { requests.push(request); return { accepted: true } },
  }
  const services = {
    resolveManagedWorkspaceRoot: () => root,
    dshContext: { get: (name: string) => name === 'workspaceRegistry' ? { list: () => [{ id: 'ws', sessionIds: sessions }], archivedSessionIds: [] } : undefined },
    events: { on(_name: string, listener: (value: unknown) => void) { idle = listener; return () => { idle = undefined } } },
    nativeSessions: { supportsEvents: true, subscribe({ onEvent }: { onEvent: (session: unknown, event: unknown) => void }) {
      listeners.add(onEvent)
      return () => listeners.delete(onEvent)
    } },
  } as never
  let eventId = 0
  const emit = (id: string, type: string, data: unknown) => {
    const event = { type, seq: ++eventId, data }
    for (const listener of listeners) listener({ header: { id } }, event)
  }
  let webhook: ReturnType<typeof attachWorkspaceMcpWebhookEvents> | undefined
  const store = new FileWorkspaceMcpWebhookStore(join(root, 'webhooks.json'))
  const open = () => {
    const queue = new WorkspaceMcpMessageQueue({ services, control, workspaceOf: (id) => sessions.includes(id) ? 'ws' : undefined,
      filePath, notice(event) { notices.push(event); webhook?.publishQueueEvent(event) } })
    queue.setEnabled(true)
    const tools = createWorkspaceMcpToolHandlers(services, { sessionControl: control, queue })
    return { queue, async call(tool: string, args: Record<string, unknown>) {
      const result = await tools.callTool(tool, args, new AbortController().signal)
      return (result as { structuredContent: Record<string, any> }).structuredContent
    } }
  }
  let api = open()
  return { requests, notices, busy, emit, control, listeners, store, idle: (sessionId: string) => idle?.({ agent: { sessionId }, status: 'idle' }), get api() { return api }, async restart() {
    await api.queue.close()
    api = open()
  }, async attachWebhook() {
    const now = new Date().toISOString()
    await store.createDestination({ id: 'dst', name: 'Test', url: 'http://127.0.0.1/hook', secret: 'fixture', enabled: true, workspaceIds: ['ws'],
      includeLastMessage: true, eventTypes: ['session.completed', 'session.failed', 'session.message_queued', 'session.message_dequeued', 'session.agent_message_sent', 'session.queue_changed'], createdAt: now, updatedAt: now })
    webhook = attachWorkspaceMcpWebhookEvents({ services, store, agentContext: (id, workspaceId, turn) => api.queue.agentContext(id, workspaceId, turn) })
  }, async close() {
    webhook?.dispose()
    await api.queue.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  } }
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const limit = Date.now() + 2_000
  while (!await check()) {
    assert.ok(Date.now() < limit, 'timed out')
    await setTimeout(5)
  }
}

test('routes real turns by request identity and applies queue priority, cancellation and webhook context', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  await f.attachWebhook()
  const { call, queue } = f.api
  const first = await call('session_continue', { sessionId: 'sess', message: 'first', agentId: 'bot-a' })
  assert.equal(first.status, 'processing')
  assert.equal(f.requests[0]?.requestId, first.messageId)
  f.emit('sess', 'turn/start', { turn: 1 })
  f.emit('sess', 'user/message', { source: { kind: 'user', rpcId: first.messageId } })
  const second = await call('session_continue', { sessionId: 'sess', message: 'second', agentId: 'bot-b' })
  const third = await call('session_continue', { sessionId: 'sess', message: 'third', agentId: 'bot-c' })
  const fourth = await call('session_continue', { sessionId: 'sess', message: 'fourth', agentId: 'bot-d' })
  assert.equal(third.queuePosition, 2)
  assert.ok(third.estimatedWaitMs > 0)
  assert.equal((await call('message_status', { sessionId: 'other', messageId: third.messageId })).error.code, 'NOT_FOUND')
  assert.equal((await call('message_cancel', { sessionId: 'sess', messageId: first.messageId })).error.code, 'CANNOT_CANCEL')
  assert.equal((await call('message_prioritize', { sessionId: 'sess', messageId: third.messageId, priority: 100 })).newPosition, 1)
  assert.equal((await call('message_cancel', { sessionId: 'sess', messageId: fourth.messageId })).success, true)
  const snapshot = await call('session_queue_peek', { sessionId: 'sess', includeProcessing: true, limit: 1 })
  assert.equal(snapshot.current.messageId, first.messageId)
  assert.deepEqual(snapshot.queue.map((row: { messageId: string }) => row.messageId), [third.messageId])
  assert.equal(snapshot.hasMore, true)
  assert.equal(f.requests.length, 1)
  assert.equal(await queue.messageAgent('sess', 'ws', first.messageId), 'bot-a')

  f.emit('sess', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => f.requests.length === 2)
  assert.equal(f.requests[1]?.requestId, third.messageId)
  f.emit('sess', 'turn/start', { turn: 2 })
  f.emit('sess', 'user/message', { source: { kind: 'user', rpcId: third.messageId } })
  f.emit('sess', 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'ERR', message: 'failed' } } })
  await waitFor(() => f.requests.length === 3)
  assert.equal(f.requests[2]?.requestId, second.messageId)
  assert.equal((await call('message_status', { sessionId: 'sess', messageId: first.messageId })).status, 'completed')
  assert.equal((await call('message_status', { sessionId: 'sess', messageId: third.messageId })).status, 'failed')
  await waitFor(async () => (await f.store.snapshot()).deliveries.some((row) => row.eventType === 'session.failed'))
  const bodies = (await f.store.snapshot()).deliveries.map((row) => JSON.parse(row.body))
  assert.equal(bodies.find((row) => row.type === 'session.completed')?.agentId, 'bot-a')
  assert.equal(bodies.find((row) => row.type === 'session.failed')?.messageId, third.messageId)
  assert.equal(bodies.find((row) => row.type === 'session.failed')?.agentId, 'bot-c')
  assert.ok(bodies.some((row) => row.type === 'session.message_dequeued' && row.data.messageId === fourth.messageId && row.data.reason === 'cancelled'))
  assert.ok(f.notices.some((notice) => notice.type === 'session.agent_message_sent' && notice.messageId === first.messageId))
})

test('a dropped native inbox item fails explicitly and releases the next waiting message', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  const active = await f.api.call('session_continue', { sessionId: 'sess', message: 'first' })
  const waiting = await f.api.call('session_continue', { sessionId: 'sess', message: 'second' })
  f.idle('sess')
  await waitFor(() => f.requests.length === 2)
  assert.equal(f.requests[1]?.requestId, waiting.messageId)
  const status = await f.api.call('message_status', { sessionId: 'sess', messageId: active.messageId })
  assert.equal(status.status, 'failed')
  assert.equal(status.errorCode, 'WORKSPACE_MCP_PROMPT_DROPPED')
})

test('persists session association and queued work, never automatically resends ambiguous admissions', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  const created = await f.api.call('session_create', { workspaceId: 'ws', agentId: 'owner-bot' })
  assert.equal(created.agentId, 'owner-bot')
  assert.equal(created.status, 'created')
  const active = await f.api.call('session_continue', { sessionId: 'new', message: 'check previous admission' })
  const queued = await f.api.call('session_continue', { sessionId: 'new', message: 'send after restart' })
  assert.equal(active.agentId, 'owner-bot')
  assert.equal(queued.status, 'queued')
  assert.equal(f.requests.length, 1)
  await f.restart()
  await waitFor(() => f.requests.length === 2)
  assert.deepEqual(f.requests.map((request) => request.requestId), [active.messageId, queued.messageId])
  assert.equal((await f.api.call('message_status', { sessionId: 'new', messageId: active.messageId })).status, 'uncertain')
  assert.equal((await f.api.call('session_list', { workspaceId: 'ws' })).sessions.find((row: { sessionId: string }) => row.sessionId === 'new')?.agentId, 'owner-bot')
  assert.equal((await f.api.call('session_continue', { sessionId: 'new', agentId: 'bad value', message: 'test' })).error.code, 'INVALID_AGENT_ID')
  assert.equal((await f.api.call('message_prioritize', { sessionId: 'new', messageId: queued.messageId, priority: 101 })).error.code, 'INVALID_PRIORITY')
  assert.equal(f.listeners.size, 1)
})
