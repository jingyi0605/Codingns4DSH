import assert from 'node:assert/strict'
import test from 'node:test'
import { startWorkspaceMcpTransport } from '../src/host/workspace-mcp/transport.ts'
import type { WorkspaceMcpTool } from '../src/host/workspace-mcp/transport.ts'

const tool: WorkspaceMcpTool = {
  name: 'echo',
  description: 'Echo the provided value',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
}

function callbacks(overrides: {
  readonly listTools?: () => readonly WorkspaceMcpTool[] | Promise<readonly WorkspaceMcpTool[]>
  readonly callTool?: (name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal) => unknown | Promise<unknown>
} = {}) {
  return {
    listTools: overrides.listTools ?? (() => [tool]),
    callTool: overrides.callTool ?? ((_name: string, args: Readonly<Record<string, unknown>>) => ({ content: [{ type: 'text', text: String(args.value ?? '') }] })),
  }
}

async function rpc(url: string, apiKey: string | undefined, request: unknown, init: RequestInit = {}): Promise<Response> {
  const { headers: extraHeaders, ...options } = init
  const method = typeof request === 'object' && request !== null ? String((request as Record<string, unknown>).method ?? '') : ''
  const params = typeof request === 'object' && request !== null ? (request as { params?: Record<string, unknown> }).params : undefined
  const modern = (params?._meta as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/protocolVersion'] !== undefined
  const name = method === 'tools/call' ? params?.name : undefined
  return fetch(url, {
    method: 'POST',
    headers: {
      ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(modern ? {
        'mcp-protocol-version': String((params?._meta as Record<string, unknown>)?.['io.modelcontextprotocol/protocolVersion']),
        'mcp-method': method,
        ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
      } : {}),
      ...(extraHeaders ?? {}),
    },
    body: JSON.stringify(request),
    ...options,
  })
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('missing API key leaves transport inactive and never calls callbacks', async () => {
  let callbackCount = 0
  const transport = await startWorkspaceMcpTransport({
    ...callbacks({
      listTools: () => { callbackCount += 1; return [tool] },
      callTool: () => { callbackCount += 1; return {} },
    }),
  })
  assert.equal(transport.active, false)
  assert.equal(transport.url, null)
  await transport.close()
  await transport.revoke()
  assert.equal(callbackCount, 0)
})

test('HTTP transport binds only to loopback and requires a constant-time bearer credential', async (t) => {
  const transport = await startWorkspaceMcpTransport({ apiKey: 'private-key', ...callbacks() })
  t.after(async () => transport.close())
  assert.equal(transport.active, true)
  assert.match(transport.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)

  const missing = await rpc(transport.url!, undefined, { jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.equal(missing.status, 401)
  const wrong = await rpc(transport.url!, 'private-key-extra', { jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.equal(wrong.status, 401)
  const authorized = await rpc(transport.url!, 'private-key', { jsonrpc: '2.0', id: 3, method: 'ping' })
  assert.equal(authorized.status, 200)
  assert.deepEqual(await readJson(authorized), { jsonrpc: '2.0', id: 3, result: {} })

  const getRequest = await fetch(transport.url!, { headers: { authorization: 'Bearer private-key' } })
  assert.equal(getRequest.status, 405)
  const unauthorizedGet = await fetch(transport.url!)
  assert.equal(unauthorizedGet.status, 401)
  const invalidOrigin = await rpc(transport.url!, 'private-key', { jsonrpc: '2.0', id: 4, method: 'ping' }, {
    headers: { authorization: 'Bearer private-key', origin: 'https://attacker.example' },
  })
  assert.equal(invalidOrigin.status, 403)
})

test('JSON-RPC supports only initialize, ping, tools/list, tools/call and initialized notification', async (t) => {
  const calls: string[] = []
  const transport = await startWorkspaceMcpTransport({
    apiKey: 'method-key',
    ...callbacks({ callTool: (name, args) => { calls.push(name); return { content: [{ type: 'text', text: String(args.value) }] } } }),
  })
  t.after(async () => transport.close())

  const initialized = await rpc(transport.url!, 'method-key', {
    jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} },
  })
  assert.equal(initialized.status, 200)
  assert.deepEqual((await readJson(initialized)).result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'codingns-workspace-mcp', version: '0.1.0' },
  })

  const listed = await rpc(transport.url!, 'method-key', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual((await readJson(listed)).result, { tools: [tool] })
  const called = await rpc(transport.url!, 'method-key', {
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hello' } },
  })
  assert.deepEqual((await readJson(called)).result, { content: [{ type: 'text', text: 'hello' }] })
  assert.deepEqual(calls, ['echo'])

  const notification = await rpc(transport.url!, 'method-key', { jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notification.status, 202)
  assert.equal(await notification.text(), '')
  const unsupported = await rpc(transport.url!, 'method-key', { jsonrpc: '2.0', id: 4, method: 'resources/list' })
  const unsupportedBody = await readJson(unsupported)
  assert.equal((unsupportedBody.error as Record<string, unknown>).code, -32601)
})

test('request and response sizes are bounded', async (t) => {
  const transport = await startWorkspaceMcpTransport({
    apiKey: 'size-key',
    maxBodyBytes: 256,
    maxResponseBytes: 256,
    ...callbacks({ listTools: () => [{ ...tool, description: 'x'.repeat(500) }] }),
  })
  t.after(async () => transport.close())

  const tooLarge = await rpc(transport.url!, 'size-key', { jsonrpc: '2.0', id: 1, method: 'ping', extra: 'x'.repeat(300) })
  assert.equal(tooLarge.status, 413)
  const tooLargeResponse = await rpc(transport.url!, 'size-key', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.ok(Number(tooLargeResponse.headers.get('content-length') ?? 0) <= 256)
  const tooLargeBody = await readJson(tooLargeResponse)
  assert.equal((tooLargeBody.error as Record<string, unknown>).code, -32603)
})

test('modern protocol discovery validates version and required request metadata', async (t) => {
  const transport = await startWorkspaceMcpTransport({ apiKey: 'modern-key', ...callbacks() })
  t.after(async () => transport.close())
  const meta = modernMeta()
  const discovered = await rpc(transport.url!, 'modern-key', {
    jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta },
  })
  assert.equal(discovered.status, 200)
  const result = (await readJson(discovered)).result as Record<string, unknown>
  assert.ok((result.supportedVersions as string[]).includes('2026-07-28'))
  assert.deepEqual(result.capabilities, { tools: {}, resources: {} })
  assert.equal(result.resultType, 'complete')

  const legacyVersion = await rpc(transport.url!, 'modern-key', {
    jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
  })
  assert.equal(legacyVersion.status, 400)
  const legacyError = (await readJson(legacyVersion)).error as Record<string, any>
  assert.equal(legacyError.code, -32022)
  assert.ok(legacyError.data.supported.includes('2025-11-25'))

  const invalidOrigin = await rpc(transport.url!, 'modern-key', {
    jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: meta },
  }, { headers: { 'mcp-method': 'ping' } })
  assert.equal(invalidOrigin.status, 400)

  const listed = await rpc(transport.url!, 'modern-key', {
    jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: meta },
  })
  assert.deepEqual((await readJson(listed)).result, { resultType: 'complete', tools: [tool] })
})

test('tool calls use one catalog snapshot and reject inherited schema keys', async (t) => {
  let catalogReads = 0
  let calls = 0
  const first = { ...tool, inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }
  const second = { ...tool, inputSchema: { type: 'object', properties: { other: { type: 'string' } }, required: ['other'], additionalProperties: false } }
  const transport = await startWorkspaceMcpTransport({
    apiKey: 'catalog-key',
    listTools: () => { catalogReads += 1; return [catalogReads === 1 ? first : second] },
    callTool: () => { calls += 1; return { ok: true } },
  })
  t.after(async () => transport.close())
  const response = await rpc(transport.url!, 'catalog-key', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { value: 'ok' } },
  })
  assert.equal(response.status, 200)
  assert.equal(calls, 1)
  assert.equal(catalogReads, 1)

  const inherited = { ...tool, inputSchema: { type: 'object', properties: {}, required: ['constructor'], additionalProperties: false } }
  const inheritedTransport = await startWorkspaceMcpTransport({ apiKey: 'inherited-key', ...callbacks({ listTools: () => [inherited] }) })
  t.after(async () => inheritedTransport.close())
  const invalid = await rpc(inheritedTransport.url!, 'inherited-key', {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} },
  })
  assert.equal(((await readJson(invalid)).error as Record<string, unknown>).code, -32602)
})

test('legacy initialize rejects versions the server does not implement', async (t) => {
  const transport = await startWorkspaceMcpTransport({ apiKey: 'legacy-key', ...callbacks() })
  t.after(async () => transport.close())
  const unsupported = await rpc(transport.url!, 'legacy-key', {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} },
  })
  assert.equal(unsupported.status, 400)
  const error = (await readJson(unsupported)).error as Record<string, any>
  assert.equal(error.code, -32022)
  assert.ok(error.data.supported.includes('2025-11-25'))
})

test('tool calls have bounded wait and concurrency, with cancellation on timeout', async (t) => {
  const gate = deferred<unknown>()
  const firstStarted = deferred<void>()
  let firstSignal: AbortSignal | undefined
  const transport = await startWorkspaceMcpTransport({
    apiKey: 'limit-key',
    maxConcurrentCalls: 1,
    maxWaitMs: 100,
    ...callbacks({
      callTool: (_name, _args, signal) => {
        firstSignal = signal
        firstStarted.resolve()
        return gate.promise
      },
    }),
  })
  t.after(async () => transport.close())

  const firstRequest = rpc(transport.url!, 'limit-key', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })
  await firstStarted.promise
  const second = await rpc(transport.url!, 'limit-key', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo' } })
  assert.equal(second.status, 503)
  assert.equal(((await readJson(second)).error as Record<string, unknown>).code, -32000)

  const first = await firstRequest
  assert.equal(first.status, 200)
  assert.equal(((await readJson(first)).error as Record<string, unknown>).code, -32001)
  assert.equal(firstSignal?.aborted, true)
  gate.resolve({ ok: true })
})

test('a timed-out callback keeps its concurrency slot until the operation actually settles', async (t) => {
  const gate = deferred<unknown>()
  let calls = 0
  const transport = await startWorkspaceMcpTransport({
    apiKey: 'timeout-slot-key',
    maxConcurrentCalls: 1,
    maxWaitMs: 120,
    ...callbacks({ callTool: () => { calls += 1; return gate.promise } }),
  })
  t.after(async () => transport.close())
  const first = await rpc(transport.url!, 'timeout-slot-key', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })
  assert.equal(((await readJson(first)).error as Record<string, unknown>).code, -32001)
  const second = await rpc(transport.url!, 'timeout-slot-key', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo' } })
  assert.equal(second.status, 503)
  assert.equal(((await readJson(second)).error as Record<string, unknown>).code, -32000)
  assert.equal(calls, 1)
  gate.resolve({ done: true })
  await new Promise((resolve) => setImmediate(resolve))
  const third = await rpc(transport.url!, 'timeout-slot-key', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo' } })
  assert.equal(third.status, 200)
  assert.deepEqual((await readJson(third)).result, { done: true })
  assert.equal(calls, 2)
})

test('revoke invalidates credentials immediately and aborts active tool work', async () => {
  const started = deferred<void>()
  const gate = deferred<unknown>()
  let signal: AbortSignal | undefined
  const transport = await startWorkspaceMcpTransport({
    apiKey: 'revoke-key',
    ...callbacks({
      callTool: (_name, _args, callSignal) => {
        signal = callSignal
        started.resolve()
        return gate.promise
      },
    }),
  })
  const pending = rpc(transport.url!, 'revoke-key', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })
  await started.promise
  await transport.revoke()
  assert.equal(transport.active, false)
  assert.equal(signal?.aborted, true)
  const result = await pending
  assert.equal(result.status, 503)
  gate.resolve({ ignored: true })
  await assert.rejects(fetch(transport.url!, { method: 'POST', headers: { authorization: 'Bearer revoke-key' } }))
})
