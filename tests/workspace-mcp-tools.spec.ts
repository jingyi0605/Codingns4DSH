import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCodingNsSettingsRpcHandler } from '../src/host/rpc.ts'
import {
  WORKSPACE_MCP_TOOL_DEFINITIONS,
  createWorkspaceMcpToolHandlers,
} from '../src/host/workspace-mcp/tools.ts'
import { createWorkspaceMcpHostFeature } from '../src/host/features/workspace-mcp.ts'
import { FileWorkspaceMcpApiKeyStore, generateWorkspaceMcpApiKey, isWorkspaceMcpApiKey } from '../data/build/dist/host/workspace-mcp/api-key-store.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

type ContextFixture = {
  get(name: string): unknown
}

function response(result: unknown): Record<string, any> {
  return result as Record<string, any>
}

function harness(options: {
  readonly workspaces?: readonly Record<string, unknown>[]
  readonly sessions?: readonly Record<string, unknown>[]
  readonly context?: Record<string, unknown>
  readonly nativeSessions?: Record<string, unknown>
  readonly root?: string | null
  readonly terminalProcesses?: Record<string, unknown>
  readonly adapters?: Record<string, unknown>
  readonly getAdapterRegistry?: () => Record<string, unknown> | undefined
} = {}) {
  const servicesByName: Record<string, unknown> = {
      workspaceRegistry: { list: () => options.workspaces ?? [], archivedSessionIds: [] },
    ...options.context,
  }
  const services = {
    dshContext: { get: (name: string) => servicesByName[name] } as ContextFixture as never,
    dshVersion: '0.2.1-alpha.3',
    nativeSessions: options.nativeSessions as never,
    terminalProcesses: options.terminalProcesses as never,
    resolveManagedWorkspaceRoot: (_id: string) => options.root === undefined ? '/verified/project' : options.root,
  }
  return createWorkspaceMcpToolHandlers(services as never, {
    ...(options.adapters as object ?? {}),
    ...(options.getAdapterRegistry === undefined ? {} : { getAdapterRegistry: options.getAdapterRegistry }),
  } as never)
}

function signal(): AbortSignal { return new AbortController().signal }

test('exports a fixed documented catalog with expected tool names and closed schemas', () => {
  assert.deepEqual(WORKSPACE_MCP_TOOL_DEFINITIONS.map((tool) => tool.name), [
    'workspace_list', 'session_list', 'session_create', 'session_continue', 'session_questions',
    'session_answer', 'session_request_permission', 'session_permission_status', 'terminal_list', 'terminal_read', 'terminal_write',
  ])
  for (const tool of WORKSPACE_MCP_TOOL_DEFINITIONS) {
    assert.equal(typeof tool.description, 'string')
    assert.equal((tool.inputSchema as Record<string, unknown>).additionalProperties, false)
  }
})

test('Workspace MCP Host feature follows the setting key and is opt-in by default', () => {
  const feature = createWorkspaceMcpHostFeature()
  assert.equal(feature.descriptor.name, 'workspaceMcp')
  assert.equal(feature.descriptor.enabledByDefault, false)
  assert.equal(feature.descriptor.runtime, 'host')
  assert.equal(feature.descriptor.ui?.alwaysEnabled, true)
})

test('workspace list exposes metadata only and session list limits results to registered sessionIds', async () => {
  const handlers = harness({
    workspaces: [
      { id: 'workspace-a', displayName: 'Project A', path: '/private/secret/root', sessionIds: ['session-a'] },
      { id: 'workspace-b', displayName: 'Project B', path: '/private/secret/other', sessionIds: ['session-b'] },
    ],
    sessions: [],
    context: {
      sessionController: { async create() {}, async list() { return { items: [] } }, async prompt() { return { accepted: true } }, modelCatalog() { return { groups: [] } } },
      sessionProjections: { stateOf: () => ({ questions: { active: [], settled: [] } }) },
      agents: { get: () => undefined },
      userQuestions: { answer: () => false },
      approval: { request: async () => 'unavailable' },
    },
    dshVersion: '0.2.1-alpha.3',
    nativeSessions: {
      async listRemote() { return [
        { id: 'session-a', title: 'Session A', running: true, updatedAt: 10 },
        { id: 'session-b', title: 'Session B', running: false },
        { id: 'not-authorized', title: 'Hidden' },
      ] },
      list() { return [] },
    },
    adapters: { sessionControl: {
      async list() { return { items: [
        { sessionId: 'session-a', title: 'Session A', running: true, updatedAt: 10 },
        { sessionId: 'session-b', title: 'Session B', running: false },
        { sessionId: 'not-authorized', title: 'Hidden' },
      ] } },
    } },
  })
  const workspaces = response(await handlers.callTool('workspace_list', {}, signal())).structuredContent
  assert.deepEqual(workspaces.workspaces, [
    { workspaceId: 'workspace-a', name: 'Project A', sessionCount: 1 },
    { workspaceId: 'workspace-b', name: 'Project B', sessionCount: 1 },
  ])
  assert.equal(workspaces.hasMore, false)
  assert.equal(JSON.stringify(workspaces).includes('/private/secret'), false)

  const listed = response(await handlers.callTool('session_list', { workspaceId: 'workspace-a' }, signal())).structuredContent
  assert.deepEqual(listed.sessions, [{ sessionId: 'session-a', workspaceId: 'workspace-a', status: 'running', updatedAt: 10, blank: false, agentAvailable: false }])
  await handlers.dispose()
})

test('native session create validates workspace, model catalog and applies prompt through controller', async () => {
  const calls: unknown[] = []
  const handlers = harness({
    workspaces: [{ id: 'workspace-a', sessionIds: [] }],
    adapters: { sessionControl: {
      async create(request: unknown) { calls.push(['create', request]); return { sessionId: 'session-new' } },
      async prepareSession() { calls.push(['prepareSession']) },
      modelCatalog() { return { groups: [{ id: 'provider-a', models: [{ id: 'model-a' }] }] } },
      async selectModel(sessionId: string, selection: unknown) { calls.push(['selectModel', { sessionId, ...selection as object }]); return { selected: selection } },
      async prompt(request: unknown) { calls.push(['prompt', request]); return { accepted: true } },
    } },
  })

  const created = response(await handlers.callTool('session_create', {
    workspaceId: 'workspace-a', modelId: 'model-a', prompt: 'Initial request',
  }, signal())).structuredContent
  assert.deepEqual(created, {
    sessionId: 'session-new', workspaceId: 'workspace-a', adapterId: 'dsh', modelId: 'model-a', status: 'accepted',
  })
  assert.deepEqual(calls[0], ['create', { workspaceId: 'workspace-a' }])
  assert.deepEqual(calls[1], ['prepareSession'])
  assert.deepEqual(calls[2], ['selectModel', { sessionId: 'session-new', provider: 'provider-a', model: 'model-a' }])
  const prompt = (calls[3] as [string, Record<string, any>])[1]
  assert.deepEqual({ ...prompt, requestId: '<generated>' }, {
    requestId: '<generated>', sessionId: 'session-new', mode: 'queue', content: [{ type: 'text', text: 'Initial request' }],
  })
  await handlers.dispose()
})

test('external adapter session creation binds supported registry config before initial prompt', async () => {
  const calls: unknown[] = []
  const bindings = new Map<string, { adapterId: string; modelId?: string }>()
  const prior = {
    async catalogForUse(ids: readonly string[]) { return [{ id: ids[0], name: 'Codex', installed: true, enabled: true }] },
    async models() { return { groups: [{ id: 'codex', models: [{ id: 'model-x' }] }] } },
    setSession(sessionId: string, config: { adapterId: string; modelId?: string }) { calls.push(['bind', sessionId, config]); bindings.set(sessionId, config) },
    getSession(sessionId: string) { return bindings.get(sessionId) },
    async flushSessionBindings() {},
  }
  const handlers = harness({
      workspaces: [{ id: 'workspace-a', sessionIds: [] }],
      context: {
        sessionController: {
          async create(request: unknown) { calls.push(['create', request]); return { sessionId: 'session-external' } },
          async prompt(request: unknown) { calls.push(['prompt', request]); return { accepted: true } },
        },
      },
      adapters: { sessionControl: {
        async create(request: unknown) { calls.push(['create', request]); return { sessionId: 'session-external' } },
        async prepareSession() {},
        async prompt(request: unknown) { calls.push(['prompt', request]); return { accepted: true } },
      } },
      getAdapterRegistry: () => prior,
    })
  const result = response(await handlers.callTool('session_create', {
      workspaceId: 'workspace-a', adapterId: 'codex', modelId: 'model-x', prompt: 'Use external route',
  }, signal())).structuredContent
  assert.deepEqual(result, { sessionId: 'session-external', workspaceId: 'workspace-a', adapterId: 'codex', modelId: 'model-x', status: 'accepted' })
  assert.deepEqual(calls[0], ['create', { workspaceId: 'workspace-a' }])
  assert.deepEqual(calls[1], ['bind', 'session-external', { adapterId: 'codex', modelId: 'model-x' }])
  assert.equal((calls[2] as [string, Record<string, any>])[1].content[0].text, 'Use external route')
  await handlers.dispose()
})

test('external session creation requires an initial prompt and invalid model selection is rejected', async () => {
  const handlers = harness({
    workspaces: [{ id: 'workspace-a', sessionIds: [] }],
    adapters: { sessionControl: { async create() { return { sessionId: 'new' } }, async prepareSession() {}, modelCatalog() { return { groups: [] } }, async prompt() { return { accepted: true } } } },
  })
  assert.equal(response(await handlers.callTool('session_create', { workspaceId: 'workspace-a', adapterId: 'codex' }, signal())).structuredContent.error.code,
    'WORKSPACE_MCP_INITIAL_PROMPT_REQUIRED')
  assert.equal(response(await handlers.callTool('session_create', { workspaceId: 'workspace-a', modelId: 'missing' }, signal())).structuredContent.error.code,
    'WORKSPACE_MCP_MODEL_SELECTION_UNAVAILABLE')
  await handlers.dispose()
})

test('session continue and pending question reads/answers revalidate workspace membership', async () => {
  const calls: unknown[] = []
  let active = [{ callId: 'call-1', state: 'open', questions: [
    { id: 'language', question: 'Preferred language?', options: [{ label: 'TypeScript' }, { label: 'Rust' }] },
  ] }]
  const handlers = harness({
    workspaces: [{ id: 'workspace-a', sessionIds: ['session-a'] }, { id: 'workspace-b', sessionIds: ['session-b'] }],
    nativeSessions: {
      get(id: string) { return id === 'session-a' ? { id } : undefined },
    },
    adapters: {
      sessionControl: { async prompt(request: unknown) { calls.push(['continue', request]); return { accepted: true } } },
      pendingQuestions: {
        list() { return active },
        answer(_sessionId: string, callId: string, answer: unknown) { calls.push(['answer', callId, answer]); active = []; return true },
      },
    },
  })

  const continued = response(await handlers.callTool('session_continue', { sessionId: 'session-a', message: 'Continue' }, signal())).structuredContent
  assert.deepEqual(continued, { accepted: true, sessionId: 'session-a', workspaceId: 'workspace-a' })
  const questions = response(await handlers.callTool('session_questions', { sessionId: 'session-a' }, signal())).structuredContent
  assert.equal(questions.questions[0].callId, 'call-1')
  const answered = response(await handlers.callTool('session_answer', {
    sessionId: 'session-a', callId: 'call-1', answer: { answers: [{ id: 'language', selected: ['TypeScript'] }] },
  }, signal())).structuredContent
  assert.deepEqual(answered, { accepted: true, sessionId: 'session-a', workspaceId: 'workspace-a', callId: 'call-1' })
  const invalidAnswer = response(await handlers.callTool('session_answer', {
    sessionId: 'session-a', callId: 'call-1', answer: { answers: [{ id: 'language', selected: ['C++'] }] },
  }, signal())).structuredContent
  assert.equal(invalidAnswer.error.code, 'WORKSPACE_MCP_QUESTION_NOT_PENDING')
  const otherWorkspace = response(await handlers.callTool('session_continue', { sessionId: 'session-b', message: 'Local full access' }, signal())).structuredContent
  assert.deepEqual(otherWorkspace, { accepted: true, sessionId: 'session-b', workspaceId: 'workspace-b' })
  const missingSession = response(await handlers.callTool('session_continue', { sessionId: 'unknown-session', message: 'Reject unknown' }, signal())).structuredContent
  assert.equal(missingSession.error.code, 'WORKSPACE_MCP_SESSION_UNAVAILABLE')
  assert.equal(calls.length, 3)
  await handlers.dispose()
})

test('permission requests outside an open DSH turn fail rather than fabricating pending status', async () => {
  const handlers = harness({
    workspaces: [{ id: 'workspace-a', sessionIds: ['session-a'] }],
    adapters: { approval: { startRequest() { return null } } },
  })
  const requested = response(await handlers.callTool('session_request_permission', {
    sessionId: 'session-a', toolName: 'write_file', reason: 'Change project source',
  }, signal())).structuredContent
  assert.equal(requested.error.code, 'WORKSPACE_MCP_APPROVAL_REQUIRES_ACTIVE_TURN')
  assert.equal(response(await handlers.callTool('session_permission_status', { sessionId: 'session-a', requestId: 'forged-request' }, signal())).structuredContent.error.code,
    'WORKSPACE_MCP_PERMISSION_REQUEST_UNKNOWN')
  await handlers.dispose()
})

test('permission request returns a DSH-issued ID and status is scoped to requests owned by the live MCP feature', async () => {
  let outcomeResolve!: (value: string) => void
  const handlers = harness({
    workspaces: [{ id: 'workspace-a', sessionIds: ['session-a'] }],
    adapters: { approval: { startRequest: () => ({ requestId: 'dsh-approval-1', outcome: new Promise<string>((resolve) => { outcomeResolve = resolve }) }) } },
  })
  const request = response(await handlers.callTool('session_request_permission', {
    sessionId: 'session-a', toolName: 'write_file', reason: 'Modify project file', callId: 'tool-call-1',
  }, signal())).structuredContent
  assert.equal(request.requestId, 'dsh-approval-1')
  assert.equal(request.status, 'pending')
  assert.equal(response(await handlers.callTool('session_permission_status', {
    sessionId: 'session-a', requestId: 'dsh-approval-1',
  }, signal())).structuredContent.status, 'pending')
  assert.equal(response(await handlers.callTool('session_permission_status', {
    sessionId: 'session-a', requestId: 'forged-id',
  }, signal())).structuredContent.error.code, 'WORKSPACE_MCP_PERMISSION_REQUEST_UNKNOWN')
  outcomeResolve('rejected')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(response(await handlers.callTool('session_permission_status', {
    sessionId: 'session-a', requestId: 'dsh-approval-1',
  }, signal())).structuredContent.status, 'rejected')
  await handlers.dispose()
})

test('feature stop reports cancellation for every pending permission without waiting on native prompts', async () => {
  const outcomes: Array<(value: string) => void> = []
  const controllers: AbortSignal[] = []
  const handlers = harness({
    workspaces: [{ id: 'workspace-a', sessionIds: ['session-a', 'session-b'] }],
    adapters: { approval: { startRequest: ({ signal }: { signal: AbortSignal }) => {
      controllers.push(signal)
      return { requestId: `approval-${controllers.length}`, outcome: new Promise<string>((resolve) => outcomes.push(resolve)) }
    } } },
  })
  for (const sessionId of ['session-a', 'session-b']) {
    const request = response(await handlers.callTool('session_request_permission', {
      sessionId, toolName: 'write_file', reason: 'Change project source',
    }, signal())).structuredContent
    assert.equal(request.status, 'pending')
  }

  handlers.abortRequests()
  assert.equal(controllers.every((controller) => controller.aborted), true)
  for (const [index, sessionId] of ['session-a', 'session-b'].entries()) {
    const status = response(await handlers.callTool('session_permission_status', {
      sessionId, requestId: `approval-${index + 1}`,
    }, signal())).structuredContent
    assert.equal(status.status, 'cancelled')
  }
  outcomes.forEach((resolve) => resolve('cancelled'))
  await handlers.dispose()
})

test('a late outcome from a revoked approval cannot clear the next request guard', async () => {
  const outcomes: Array<(value: string) => void> = []
  const handlers = harness({
    workspaces: [{ id: 'workspace-a', sessionIds: ['session-a'] }],
    adapters: { approval: { startRequest: () => ({
      requestId: `approval-${outcomes.length + 1}`,
      outcome: new Promise<string>((resolve) => outcomes.push(resolve)),
    }) } },
  })
  const invoke = () => handlers.callTool('session_request_permission', {
    sessionId: 'session-a', toolName: 'write_file', reason: 'Change project source',
  }, signal())

  const first = response(await invoke()).structuredContent
  handlers.abortRequests()
  const second = response(await invoke()).structuredContent
  assert.equal(second.status, 'pending')
  outcomes[0]!('cancelled')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(response(await handlers.callTool('session_request_permission', {
    sessionId: 'session-a', toolName: 'write_file', reason: 'Duplicate while second waits',
  }, signal())).structuredContent.error.code, 'WORKSPACE_MCP_APPROVAL_REQUEST_PENDING')
  assert.equal(response(await handlers.callTool('session_permission_status', {
    sessionId: 'session-a', requestId: first.requestId,
  }, signal())).structuredContent.status, 'cancelled')
  outcomes[1]!('rejected')
  await new Promise((resolve) => setImmediate(resolve))
  await handlers.dispose()
})

test('workspace root becoming blank invalidates current MCP access', async () => {
  let root: string | null = '/verified/project'
  const handlers = createWorkspaceMcpToolHandlers({
    dshContext: { get: () => ({ list: () => [{ id: 'workspace-a', sessionIds: [] }], archivedSessionIds: [] }) } as never,
    resolveManagedWorkspaceRoot: () => root,
  } as never)
  assert.equal(response(await handlers.callTool('workspace_list', {}, signal())).structuredContent.workspaces.length, 1)
  root = '   '
  assert.deepEqual(response(await handlers.callTool('workspace_list', {}, signal())).structuredContent.workspaces, [])
  await handlers.dispose()
})

test('settings mutation blocks enabling Workspace MCP without a generated Host key', async () => {
  const provider = {
    writable: true,
    describe: () => [{ ns: 'codingns', revision: 1, value: {} }],
    get: () => ({}),
    mutate: async () => assert.fail('missing-key setting mutation must be rejected before persistence'),
  }
  const handler = createCodingNsSettingsRpcHandler(provider as never, { workspaceMcpApiKeyConfigured: async () => false })
  await assert.rejects(handler('set', {
    ops: [{ op: 'set', path: ['modules', 'workspaceMcp'], value: true }],
  }), (error: unknown) => (error as { code?: string }).code === 'WORKSPACE_MCP_API_KEY_REQUIRED')
})

test('Workspace MCP keys have 256 bits of entropy and a fixed credential-safe encoding', () => {
  const first = generateWorkspaceMcpApiKey()
  const second = generateWorkspaceMcpApiKey()
  assert.match(first, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(isWorkspaceMcpApiKey(first), true)
  assert.notEqual(first, second)
  assert.equal(isWorkspaceMcpApiKey('short'), false)
})

test('Workspace MCP key file uses owner-only permissions and contains no settings data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-workspace-mcp-key-'))
  const path = join(directory, 'private', 'api-key')
  const store = new FileWorkspaceMcpApiKeyStore(path)
  const key = generateWorkspaceMcpApiKey()
  try {
    await store.write(key)
    assert.equal(await store.read(), key)
    assert.equal((await readFile(path, 'utf8')).trim(), key)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700)
    await store.clear()
    assert.equal(await store.read(), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Workspace MCP control RPC persists a key, enables the listener and returns the key only on generation', async () => {
  let key: string | null = null
  let config = { modules: {} as Record<string, boolean> }
  let revision = 1
  const keyStore = {
    async read() { return key },
    async write(next: string) { key = next },
    async clear() { key = null },
  }
  const settings = {
    get: () => config as never,
    watch: () => () => undefined,
    async update(patch: { modules: Record<string, boolean> }) { config = patch; revision += 1 },
  }
  const table = new CodingNsRpcTable()
  const resources: Array<() => void | Promise<void>> = []
  let owner = false
  const feature = createWorkspaceMcpHostFeature({ apiKeyStore: keyStore, isOwner: () => owner })
  await feature.start({
    services: {
      rpc: table,
      settings,
      settingsProvider: {
        writable: true,
        describe: () => [{ ns: 'codingns', revision, value: config }],
        get: () => config,
        mutate: async (_namespace: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
          for (const operation of ops) if (operation.op === 'set') {
            if (operation.path.length === 2 && operation.path[0] === 'modules') config.modules[operation.path[1]!] = operation.value === true
          }
          revision += 1
        },
      } as never,
    } as never,
    resources: { add: (dispose: () => void | Promise<void>) => { resources.push(dispose) } },
  } as never)
  await new Promise((resolve) => setImmediate(resolve))
  const target = table.resolve('workspaceMcp/generate-key')
  assert.ok(target)
  await assert.rejects(target.handler(target.action, {}, { peer: undefined }), (error: unknown) => (error as { code?: string }).code === 'CODINGNS_RPC_FORBIDDEN')
  assert.equal(key, null)
  owner = true
  const generated = await target.handler(target.action, {}, { peer: undefined }) as { apiKey: string; enabled: boolean; listening: boolean; url: string | null }
  assert.equal(isWorkspaceMcpApiKey(generated.apiKey), true)
  assert.equal(key, generated.apiKey)
  assert.equal(config.modules.workspaceMcp, true)
  assert.equal(generated.enabled, true)
  assert.equal(generated.listening, true)
  assert.match(generated.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)
  const statusTarget = table.resolve('workspaceMcp/status')!
  const status = await statusTarget.handler(statusTarget.action, {}) as Record<string, unknown>
  assert.equal(status.apiKeyConfigured, true)
  assert.equal('apiKey' in status, false)
  assert.equal(JSON.stringify(await createCodingNsSettingsRpcHandler({
    writable: true, describe: () => [{ ns: 'codingns', revision, value: config }], get: () => config,
  } as never)('get', {})).includes(generated.apiKey), false)
  const rotated = await target.handler(target.action, {}, { peer: undefined }) as { apiKey: string; enabled: boolean; listening: boolean }
  assert.notEqual(rotated.apiKey, generated.apiKey)
  assert.equal(key, rotated.apiKey)
  assert.equal(rotated.enabled, true)
  assert.equal(rotated.listening, true)
  for (const dispose of resources.reverse()) await dispose()
})

test('terminal listing, snapshot read and write are scoped to managed workspace instances', async () => {
  const calls: unknown[] = []
  const handlers = harness({
    workspaces: [{ id: 'workspace-a', sessionIds: ['session-a'] }, { id: 'workspace-b', sessionIds: ['session-b'] }],
    context: { sessions: { get: (id: string) => ({ id }) } },
    terminalProcesses: {
      listWorkspaceTerminalsForSession: (workspaceId: string, sessionId: string) => workspaceId === 'workspace-a' && sessionId === 'session-a' ? [{ id: 'term-1', dshSessionId: 'session-a', title: 'Shell', state: 'running' }] : [],
      async readSessionTerminalOutput(workspaceId: string, sessionId: string, terminalId: string, limit: number) { calls.push(['read', workspaceId, sessionId, terminalId, limit]); return { text: 'x'.repeat(limit - 1), truncated: true } },
      async writeSessionTerminalInput(workspaceId: string, sessionId: string, terminalId: string, data: string) { calls.push(['write', workspaceId, sessionId, terminalId, data]) },
    },
  })
  const listed = response(await handlers.callTool('terminal_list', { workspaceId: 'workspace-a', sessionId: 'session-a' }, signal())).structuredContent
  assert.deepEqual(listed.terminals, [{ terminalId: 'term-1', dshSessionId: 'session-a', state: 'running', title: 'Shell' }], JSON.stringify(listed))
  const read = response(await handlers.callTool('terminal_read', { workspaceId: 'workspace-a', sessionId: 'session-a', terminalId: 'term-1', limitBytes: 20 }, signal())).structuredContent
  assert.deepEqual(read, { workspaceId: 'workspace-a', terminalId: 'term-1', data: 'x'.repeat(19), truncated: true })
  const written = response(await handlers.callTool('terminal_write', { workspaceId: 'workspace-a', sessionId: 'session-a', terminalId: 'term-1', data: 'echo test' }, signal())).structuredContent
  assert.deepEqual(written, { accepted: true, workspaceId: 'workspace-a', terminalId: 'term-1' })
  const tooLarge = response(await handlers.callTool('terminal_write', {
    workspaceId: 'workspace-a', sessionId: 'session-a', terminalId: 'term-1', data: 'x'.repeat(16 * 1024 + 1),
  }, signal())).structuredContent
  assert.equal(tooLarge.error.code, 'WORKSPACE_MCP_TERMINAL_INPUT_TOO_LARGE')
  assert.equal(calls.length, 2)
  const outside = response(await handlers.callTool('terminal_write', { workspaceId: 'workspace-a', sessionId: 'session-b', terminalId: 'term-1', data: 'bad' }, signal())).structuredContent
  assert.equal(outside.error.code, 'WORKSPACE_MCP_SESSION_UNAVAILABLE')
  await handlers.dispose()
})

test('invalid IDs and unknown workspaces fail with structured errors', async () => {
  const handlers = harness({ workspaces: [{ id: 'workspace-a', sessionIds: [] }] })
  assert.equal(response(await handlers.callTool('session_list', { workspaceId: '../etc' }, signal())).structuredContent.error.code,
    'WORKSPACE_MCP_INVALID_ID')
  assert.equal(response(await handlers.callTool('terminal_list', { workspaceId: 'not-managed', sessionId: 'session-a' }, signal())).structuredContent.error.code,
    'WORKSPACE_MCP_WORKSPACE_UNAVAILABLE')
  await handlers.dispose()
})
