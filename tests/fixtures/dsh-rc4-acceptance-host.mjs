import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { attachWorkspaceMcpWebhookEvents } from '../../data/build/dist/host/workspace-mcp/webhook-events.js'
import { FileWorkspaceMcpWebhookStore } from '../../data/build/dist/host/workspace-mcp/webhook-store.js'
import { WorkspaceMcpWebhookDispatcher } from '../../data/build/dist/host/workspace-mcp/webhook-dispatcher.js'

export const name = 'codingns-rc4-acceptance'
export const inject = ['llm', 'sessionProjections', 'sessions']

/** Explicit Stage0-only fixture: real Messages transport and native session events. */
export async function apply(ctx) {
  const directory = resolve(process.env.CODINGNS_RC4_ACCEPTANCE_DIR ?? '')
  const runtime = process.env.CODINGNS_RC4_RUNTIME_ROOT
  assert.ok(directory.startsWith('/private/tmp/') || directory.startsWith('/tmp/'))
  assert.ok(runtime?.endsWith('/0.2.2-rc.4'))
  assert.equal(process.env.DSH_HOME, join(process.env.HOME, '.dsh-stage0-020'))
  await mkdir(directory, { recursive: true })
  const require = createRequire(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))
  const { DeepSeekAdapter, resolveAdapterOptions, catalogModelInfo } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')).href)
  const requests = []
  const receipts = []
  const sessions = new Set()
  const pending = new Set()
  const write = (file, value) => writeFile(join(directory, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  const server = createServer(async (request, response) => {
    try {
      const buffers = []
      for await (const chunk of request) buffers.push(chunk)
      const body = JSON.parse(Buffer.concat(buffers).toString())
      if (request.url === '/webhook') {
        receipts.push(body)
        await write('webhook-receipts.json', receipts)
        response.writeHead(204).end()
        return
      }
      requests.push({ model: body.model, safetyCheck: body.safety_check, toolCount: body.tools?.length ?? 0 })
      await write('provider-requests.json', requests)
      const success = body.model === 'rc4-success'
      const events = [
        { type: 'message_start', message: { id: `fixture-${requests.length}`, type: 'message', role: 'assistant', model: body.model,
          content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: success ? 'RC4_SUCCESS' : 'RC4_UNACCEPTED_DRAFT' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: success ? 'end_turn' : body.model === 'rc4-malformed' ? 'unknown_stop' : 'refusal',
          stop_details: { explanation: 'Fixture refusal mentions network timeout 429' } }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      response.end()
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const models = ['rc4-refusal', 'rc4-malformed', 'rc4-success'].map(id => ({ id, contextWindow: 1_048_576, maxTokens: 1024 }))
  ctx.llm.registerAdapter(['codingns-rc4-fixture'], new DeepSeekAdapter({
    providerName: 'CodingNS rc.4 acceptance fixture',
    discoverModels: async provider => models.map(model => catalogModelInfo(provider, model)),
    options: () => resolveAdapterOptions({
      baseURL: origin, models, maxTokens: 1024,
    }),
    resolveAuth: async () => ({ headers: { 'x-api-key': 'local-fixture' } }),
    resolveUserId: () => 'rc4-stage0-fixture',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  }))
  const store = new FileWorkspaceMcpWebhookStore(join(directory, `webhook-store-${process.pid}.json`))
  const timestamp = new Date().toISOString()
  await store.createDestination({
    id: 'stage0-fixture', name: 'Stage0 local receiver', url: `${origin}/webhook`, secret: 'local-fixture-secret',
    enabled: true, workspaceIds: null,
    eventTypes: ['session.failed', 'session.completed', 'session.permission_requested', 'session.question_asked'],
    includeLastMessage: true, createdAt: timestamp, updatedAt: timestamp,
  })
  const dispatcher = new WorkspaceMcpWebhookDispatcher(store)
  const isFixture = session => session.header.cwd?.startsWith(directory)
  const webhook = attachWorkspaceMcpWebhookEvents({
    services: {
      nativeSessions: {
        supportsEvents: true,
        subscribe(handler) {
          return ctx.on('session/event', (session, event) => {
            if (!isFixture(session)) return
            sessions.add(session.id)
            handler.onEvent(session, event)
            if (event.type === 'turn/end') handler.onEvent(session, event)
          })
        },
        get: id => ctx.sessions.get(id),
      },
      dshContext: { get: key => key === 'workspaceRegistry'
        ? { list: () => [{ id: 'fixture-workspace', title: 'Acceptance', sessionIds: [...sessions] }], archivedSessionIds: [] }
        : ctx.get(key) },
      resolveManagedWorkspaceRoot: () => directory,
    },
    store,
    onQueued: () => dispatcher.wake(),
    sessionList: async () => ({ items: [] }),
  })
  ctx.on('session/event', (session, event) => {
    if (!isFixture(session) || event.type !== 'turn/end') return
    const task = new Promise(accept => setImmediate(accept)).then(async () => {
      const events = session.snapshotEvents()
      const live = ctx.sessionProjections.snapshot(session)
      const checkpoint = JSON.parse(JSON.stringify(ctx.sessionProjections.checkpoint(session)))
      const cold = ctx.sessionProjections.restore({}, events, 0, session.header, 0).snapshot
      await write(`${session.id}.json`, {
        sessionId: session.id, terminal: event.data, events,
        messages: session.deriveMessages(),
        live: live.values, cold: cold.values,
        checkpoint: ctx.sessionProjections.viewCheckpoint(checkpoint),
      })
    }).catch(error => write(`${session.id}.error.json`, { error: String(error), stack: error.stack }))
    pending.add(task)
    void task.finally(() => pending.delete(task))
  })
  await write('fixture-ready.json', { provider: 'codingns-rc4-fixture', origin, runtime: '0.2.2-rc.4' })
  ctx.effect(() => async () => {
    webhook.dispose()
    await dispatcher.close()
    await store.close()
    await Promise.allSettled(pending)
    server.closeAllConnections()
    await new Promise(accept => server.close(accept))
  })
}
