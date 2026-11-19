import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkspaceMcpToolHandlers } from '../src/host/workspace-mcp/tools.ts'
import type { WorkspaceSessionControlAdapter } from '../src/dsh-capabilities/host/workspace-session-control-adapter.ts'

type Calls = { history: Array<Record<string, unknown>>; search: string[] }

function event(seq: number, type: string, data: unknown) {
  return { type: 'event', event: { type, seq, time: 1_700_000_000_000 + seq, data } }
}
const user = (seq: number, text: string, source?: unknown) => event(seq, 'user/message', { id: `u${String(seq)}`, role: 'user', content: [{ type: 'text', text }], ...(source === undefined ? {} : { source }) })
const assistant = (seq: number, text: string) => event(seq, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })

function fixture(options: {
  readonly records?: readonly unknown[]
  readonly hasMore?: boolean
  readonly searchItems?: readonly unknown[]
  readonly searchHasMore?: boolean
  readonly withHistory?: boolean
  readonly withSearch?: boolean
  readonly agentOf?: (messageId: string) => Promise<string | undefined>
  readonly failRead?: boolean
  readonly searchError?: unknown
} = {}) {
  const calls: Calls = { history: [], search: [] }
  const control: WorkspaceSessionControlAdapter = {
    async create() { return {} },
    async list() { return { items: [] } },
    async prompt() { return { accepted: true } },
    async modelCatalog() { return { groups: [] } },
    ...(options.withHistory === false ? {} : {
      async history(request: Record<string, unknown>) {
        calls.history.push(request)
        if (options.failRead === true) throw new Error('disk path /secret/location failed')
        return { records: options.records ?? [], hasMore: options.hasMore === true, cursor: 99 }
      },
    }),
    ...(options.withSearch === false ? {} : {
      async search(query: string) {
        calls.search.push(query)
        if (options.searchError !== undefined) throw options.searchError
        return { items: options.searchItems ?? [], hasMore: options.searchHasMore === true }
      },
    }),
  }
  const workspaces = [
    { id: 'ws-a', sessionIds: ['sess-a', 'sess-a2'] },
    { id: 'ws-b', sessionIds: ['sess-b'] },
  ]
  const services = {
    dshContext: { get: (name: string) => name === 'workspaceRegistry' ? { list: () => workspaces, archivedSessionIds: ['sess-archived'] } : undefined },
    resolveManagedWorkspaceRoot: () => '/verified/project',
  }
  const queue = options.agentOf === undefined ? undefined : { messageAgent: (_s: string, _w: string, id: string) => options.agentOf!(id) }
  const tools = createWorkspaceMcpToolHandlers(services as never, { sessionControl: control, ...(queue === undefined ? {} : { queue: queue as never }) })
  return {
    calls,
    async call(name: string, args: Record<string, unknown>) {
      const result = await tools.callTool(name, args, new AbortController().signal) as { isError?: boolean; structuredContent: Record<string, any> }
      return { isError: result.isError === true, value: result.structuredContent }
    },
  }
}

test('session_history returns chronological user and assistant text and skips other events', async () => {
  const { call, calls } = fixture({ records: [
    assistant(5, 'answer'),
    event(4, 'tool/call', { name: 'bash' }),
    user(3, 'question'),
    event(2, 'turn/start', {}),
  ] })
  const { isError, value } = await call('session_history', { sessionId: 'sess-a' })
  assert.equal(isError, false)
  assert.deepEqual(value.messages.map((m: any) => [m.seq, m.role, m.text]), [[3, 'user', 'question'], [5, 'assistant', 'answer']])
  assert.equal(value.workspaceId, 'ws-a')
  assert.equal(value.hasMore, false)
  assert.equal(value.nextCursor, undefined)
  assert.deepEqual(calls.history[0], { sessionId: 'sess-a', maxMessages: 20 })
  assert.equal(JSON.stringify(value).includes('/verified/project'), false)
})

test('session_history paginates with the lowest sequence number as the next cursor', async () => {
  const { call, calls } = fixture({ records: [assistant(11, 'b'), event(10, 'tool/call', {}), user(9, 'a')], hasMore: true })
  const { value } = await call('session_history', { sessionId: 'sess-a', limit: 2, cursor: 12 })
  assert.deepEqual(calls.history[0], { sessionId: 'sess-a', beforeSeq: 12, maxMessages: 2 })
  assert.equal(value.hasMore, true)
  assert.equal(value.nextCursor, 9)
  assert.equal(value.limit, 2)
})

test('session_history shortens a long message and keeps the newest messages inside the response budget', async () => {
  const long = 'é'.repeat(10_000)
  const { call } = fixture({ records: [assistant(3, long), assistant(2, 'x'.repeat(8 * 1024)), user(1, long)] })
  const { value } = await call('session_history', { sessionId: 'sess-a' })
  assert.deepEqual(value.messages.map((m: any) => m.truncated), [true, undefined, true])
  const newest = value.messages.at(-1)
  assert.equal(newest.truncated, true)
  assert.ok(Buffer.byteLength(newest.text) <= 8 * 1024)
  assert.ok(!newest.text.includes('�'))

  const many = Array.from({ length: 60 }, (_, index) => assistant(index + 1, 'y'.repeat(8 * 1024))).reverse()
  const budget = fixture({ records: many })
  const page = (await budget.call('session_history', { sessionId: 'sess-a', limit: 60 })).value
  assert.ok(page.messages.length < 60)
  assert.equal(page.messages.at(-1).seq, 60)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor, page.messages[0].seq)
})

test('session_history marks messages sent by an MCP Agent and ignores lookup failures', async () => {
  const { call } = fixture({
    records: [user(2, 'from bot', { kind: 'plugin', rpcId: 'mcp-msg-1' }), user(1, 'by hand', { rpcId: 'mcp-msg-missing' })],
    agentOf: async (id) => { if (id === 'mcp-msg-missing') throw new Error('gone'); return 'bot-7' },
  })
  const { value } = await call('session_history', { sessionId: 'sess-a' })
  assert.equal(value.messages[0].agentId, undefined)
  assert.equal(value.messages[1].agentId, 'bot-7')
  assert.equal(value.messages[1].sourceKind, 'plugin')
})

test('session_history counts messages without text and rejects sessions outside managed workspaces', async () => {
  const { call, calls } = fixture({ records: [event(2, 'user/message', { role: 'user', content: [{ type: 'image' }] }), user(1, 'hi')] })
  const ok = (await call('session_history', { sessionId: 'sess-a' })).value
  assert.equal(ok.omittedWithoutText, 1)
  for (const sessionId of ['unmanaged', 'sess-archived']) {
    const denied = await call('session_history', { sessionId })
    assert.equal(denied.isError, true)
    assert.equal(denied.value.error.code, 'WORKSPACE_MCP_SESSION_UNAVAILABLE')
  }
  assert.equal(calls.history.length, 1)
})

test('session_history validates input and hides DSH failure details', async () => {
  const bad = fixture()
  for (const args of [{ sessionId: '../x' }, { sessionId: 'sess-a', limit: 0 }, { sessionId: 'sess-a', limit: 101 }, { sessionId: 'sess-a', cursor: -1 }, { sessionId: 'sess-a', cursor: 1.5 }]) {
    const result = await bad.call('session_history', args)
    assert.equal(result.isError, true, JSON.stringify(args))
  }
  assert.equal(bad.calls.history.length, 0)

  const failed = await fixture({ failRead: true }).call('session_history', { sessionId: 'sess-a' })
  assert.equal(failed.value.error.code, 'WORKSPACE_MCP_SESSION_HISTORY_UNAVAILABLE')
  assert.equal(JSON.stringify(failed.value).includes('/secret/location'), false)

  const missing = await fixture({ withHistory: false }).call('session_history', { sessionId: 'sess-a' })
  assert.equal(missing.value.error.code, 'WORKSPACE_MCP_SESSION_HISTORY_UNAVAILABLE')
})

test('session_search only returns sessions in managed workspaces', async () => {
  const { call, calls } = fixture({ searchItems: [
    { sessionId: 'unmanaged', snippet: 'outside' },
    { sessionId: 'sess-a', snippet: 'first' },
    { sessionId: 'sess-archived', snippet: 'archived' },
    { sessionId: 'sess-b', snippet: 'second' },
    { sessionId: 'sess-a', snippet: 'duplicate' },
    { sessionId: '../bad', snippet: 'bad id' },
  ] })
  const { isError, value } = await call('session_search', { query: ' deploy ' })
  assert.equal(isError, false)
  assert.deepEqual(calls.search, ['deploy'])
  assert.deepEqual(value.results, [
    { sessionId: 'sess-a', workspaceId: 'ws-a', snippet: 'first' },
    { sessionId: 'sess-b', workspaceId: 'ws-b', snippet: 'second' },
  ])
  assert.equal(value.hasMore, false)
})

test('session_search narrows to one workspace, applies the limit and reports more results', async () => {
  const items = [{ sessionId: 'sess-a', snippet: '1' }, { sessionId: 'sess-a2', snippet: '2' }, { sessionId: 'sess-b', snippet: '3' }]
  const scoped = await fixture({ searchItems: items }).call('session_search', { query: 'x', workspaceId: 'ws-a' })
  assert.deepEqual(scoped.value.results.map((row: any) => row.sessionId), ['sess-a', 'sess-a2'])

  const limited = await fixture({ searchItems: items }).call('session_search', { query: 'x', limit: 1 })
  assert.equal(limited.value.results.length, 1)
  assert.equal(limited.value.hasMore, true)

  const upstream = await fixture({ searchItems: [], searchHasMore: true }).call('session_search', { query: 'x' })
  assert.deepEqual(upstream.value.results, [])
  assert.equal(upstream.value.hasMore, true)
})

test('session_search validates input and workspace scope', async () => {
  const subject = fixture({ searchItems: [{ sessionId: 'sess-a', snippet: 's' }] })
  for (const args of [{}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(257) }, { query: 'x', limit: 0 }, { query: 'x', limit: 21 }, { query: 'x', workspaceId: 'ws-missing' }, { query: 'x', workspaceId: '../ws' }]) {
    const result = await subject.call('session_search', args)
    assert.equal(result.isError, true, JSON.stringify(args))
  }
  assert.equal(subject.calls.search.length, 0)
  const missing = await fixture({ withSearch: false }).call('session_search', { query: 'x' })
  assert.equal(missing.value.error.code, 'WORKSPACE_MCP_SESSION_SEARCH_UNAVAILABLE')
})

test('session_search reports a deployment with search turned off instead of a generic failure', async () => {
  const wrapped = new Error('session search failed: SessionQueryError: session search is disabled: this deployment configures the session-query index with openAt "never"')
  const notMounted = new Error('session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query')
  const typed = Object.assign(new Error('anything'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
  for (const searchError of [wrapped, notMounted, typed]) {
    const result = await fixture({ searchError }).call('session_search', { query: 'deploy' })
    assert.equal(result.isError, true)
    assert.equal(result.value.error.code, 'WORKSPACE_MCP_SESSION_SEARCH_DISABLED')
    assert.match(result.value.error.message, /not enabled/u)
    assert.match(result.value.error.message, /openAt/u)
  }
})

test('session_search keeps other DSH failures generic and does not forward their text', async () => {
  const failure = new Error('session search failed: Error: ENOENT /secret/index/location.sqlite')
  const result = await fixture({ searchError: failure }).call('session_search', { query: 'deploy' })
  assert.equal(result.isError, true)
  assert.equal(result.value.error.code, 'WORKSPACE_MCP_SESSION_SEARCH_UNAVAILABLE')
  assert.equal(JSON.stringify(result.value).includes('/secret/index'), false)
})
