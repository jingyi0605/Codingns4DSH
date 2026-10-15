import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'

type Message = Record<string, any>
type Connection = {
  args: string[]
  requests: Message[]
  killed: boolean
  promptId?: number
  emit(message: Message): void
  reply(request: Message, result: Message): void
  update(update: Message): void
}

const input = { sessionId: 'host-session', messages: [], prompt: 'Run the test', cwd: '/workspace' }
const fullAccess = { sandboxMode: 'danger-full-access', approvalPolicy: 'never' } as const
const permissionOptions = [
  { optionId: 'always-allow', kind: 'allow_always' },
  { optionId: 'allow-once', kind: 'allow_once' },
  { optionId: 'reject-once', kind: 'reject_once' },
  { optionId: 'reject-always', kind: 'reject_always' },
]

function replay(handle: (request: Message, connection: Connection) => void) {
  const connections: Connection[] = []
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.52', stderr: '' })) as never,
    spawn: ((_command: string, args: string[]) => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const connection: Connection = {
        args, requests: [], killed: false,
        emit(message) { stdout.write(`${JSON.stringify(message)}\n`) },
        reply(request, result) { this.emit({ jsonrpc: '2.0', id: request.id, result }) },
        update(update) { this.emit({ method: 'session/update', params: { sessionId: 'provider-session', update } }) },
      }
      connections.push(connection)
      return {
        stdout, stderr,
        stdin: { write(data: string) {
          const request = JSON.parse(data)
          connection.requests.push(request)
          if (request.method === 'initialize') connection.reply(request, {})
          else if (['session/new', 'session/load'].includes(request.method)) connection.reply(request, { sessionId: 'provider-session' })
          else if (['session/set_model', 'session/set_config_option'].includes(request.method)) connection.reply(request, {})
          else handle(request, connection)
        } },
        kill() { connection.killed = true; stdout.end(); stderr.end(); return true },
      }
    }) as never,
  })
  return { driver, connections }
}

function requestPermission(connection: Connection, options = permissionOptions) {
  connection.update({ sessionUpdate: 'tool_call', toolCallId: 'backup-call', title: 'run_terminal_command', status: 'pending', rawInput: { command: 'cp seed.txt backup.txt' } })
  connection.emit({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {
    sessionId: 'provider-session',
    toolCall: { toolCallId: 'backup-call', title: 'Execute backup command' },
    options,
  } })
}

test('Grok enables native automatic approval only for confirmed full-access/never', { timeout: 10_000 }, async () => {
  for (const permission of [undefined, {}, { approvalPolicy: 'never' },
    { sandboxMode: 'danger-full-access' }, { sandboxMode: 'danger-full-access', approvalPolicy: 'ask' },
    { sandboxMode: 'workspace-write', approvalPolicy: 'never' }, { sandboxMode: 'read-only', approvalPolicy: 'never' }, fullAccess]) {
    const fixture = replay((request, connection) => {
      if (request.method === 'session/prompt') connection.reply(request, { stopReason: 'end_turn' })
    })
    try {
      for await (const _event of fixture.driver.executeTurn({ ...input, permission } as never)) { /* Drain the turn. */ }
      assert.equal(fixture.connections[0].args.includes('--always-approve'), permission === fullAccess)
    } finally { fixture.driver.dispose() }
  }
})

test('Grok restarts and restores the session when effective approval privileges change', { timeout: 5_000 }, async () => {
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') connection.reply(request, { stopReason: 'end_turn' })
  })
  try {
    for (const permission of [fullAccess, fullAccess, { sandboxMode: 'workspace-write', approvalPolicy: 'ask' }, fullAccess]) {
      for await (const _event of fixture.driver.executeTurn({ ...input, permission } as never)) { /* Drain the turn. */ }
    }
    assert.equal(fixture.connections.length, 3)
    assert.deepEqual(fixture.connections.map(connection => connection.args.includes('--always-approve')), [true, false, true])
    assert.equal(fixture.connections[0].killed, true)
    assert.equal(fixture.connections[1].killed, true)
    for (const connection of fixture.connections.slice(1)) {
      assert.equal(connection.requests.find(request => request.method === 'session/load')?.params.sessionId, 'provider-session')
      assert.equal(connection.requests.some(request => request.method === 'session/new'), false)
    }
  } finally { fixture.driver.dispose() }
})

test('Grok applies model and effort selections before new, reused, and restored prompts', { timeout: 5_000 }, async () => {
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') connection.reply(request, { stopReason: 'end_turn' })
  })
  try {
    for (const [modelId, effortId, permission] of [
      ['grok-4.7-build-fast', 'low', fullAccess],
      ['grok-4.7', 'high', fullAccess],
      ['grok-4.7-build-fast', 'medium', undefined],
    ]) {
      for await (const _event of fixture.driver.executeTurn({ ...input, modelId, effortId, permission } as never)) { /* Drain the turn. */ }
    }
    const selections = fixture.connections.flatMap(connection => connection.requests.filter(request => ['session/set_model', 'session/set_config_option'].includes(request.method)))
    assert.deepEqual(selections.map(request => request.params.modelId ?? request.params.value), ['grok-4.7-build-fast', 'low', 'grok-4.7', 'high', 'grok-4.7-build-fast', 'medium'])
    for (const connection of fixture.connections) {
      for (const [index, request] of connection.requests.entries()) {
        if (request.method !== 'session/prompt') continue
        assert.equal(connection.requests[index - 2].method, 'session/set_model')
        assert.equal(connection.requests[index - 1].method, 'session/set_config_option')
      }
    }
    assert.equal(fixture.connections[1].requests.some(request => request.method === 'session/load'), true)
  } finally { fixture.driver.dispose() }
})

for (const options of [permissionOptions, [...permissionOptions].reverse()]) {
  test(`Grok selects allow_once regardless of option order (${options[0].kind})`, { timeout: 3_000 }, async () => {
    const fixture = replay((request, connection) => {
      if (request.method === 'session/prompt') {
        connection.promptId = request.id
        requestPermission(connection, options)
      } else if (request.id === 77) connection.reply({ id: connection.promptId }, { stopReason: 'end_turn' })
    })
    try {
      for await (const event of fixture.driver.executeTurn(input)) {
        if (event.type === 'permission-request') fixture.driver.respondPermission(input.sessionId, { requestId: event.requestId, approved: true })
      }
      assert.deepEqual(fixture.connections[0].requests.find(request => request.id === 77)?.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
    } finally { fixture.driver.dispose() }
  })
}

test('Grok does not substitute a permanent grant when a one-time option is unavailable', { timeout: 3_000 }, async () => {
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') {
      connection.promptId = request.id
      requestPermission(connection, [permissionOptions[0], permissionOptions[3]])
    } else if (request.id === 77) connection.reply({ id: connection.promptId }, { stopReason: 'cancelled' })
  })
  try {
    for await (const event of fixture.driver.executeTurn(input)) {
      if (event.type === 'permission-request') fixture.driver.respondPermission(input.sessionId, { requestId: event.requestId, approved: true })
    }
    assert.deepEqual(fixture.connections[0].requests.find(request => request.id === 77)?.result, { outcome: { outcome: 'cancelled' } })
  } finally { fixture.driver.dispose() }
})

test('Grok preserves policy rejection in native tool results and the terminal error', { timeout: 4_000 }, async () => {
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') {
      connection.promptId = request.id
      requestPermission(connection)
    } else if (request.id === 77) {
      connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'backup-call', status: 'failed', content: [
        { type: 'content', content: { type: 'text', text: 'User rejected the execution for tool `run_terminal_command`' } },
      ], _meta: { toolNotRun: 'rejected' } })
      connection.reply({ id: connection.promptId }, { stopReason: 'cancelled', _meta: {
        cancellationCategory: 'PermissionRejected', cancellationContext: { tool_name: 'run_terminal_command', reason: 'User rejected the execution' },
      } })
    }
  })
  const results: Message[] = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'grok', sessionId: input.sessionId, permission: fullAccess,
    nativeSessions: {
      requestApproval: async () => 'rejected',
      appendToolCall: () => ({ sessionId: input.sessionId, turn: 1, step: 1, callId: 'backup-call', callSeq: 1 }),
      appendToolResult(_handle, result) { results.push(result); return true },
    } as never,
    respondPermission: response => fixture.driver.respondPermission(input.sessionId, response),
  })
  const chunks: Message[] = []
  try {
    for await (const event of fixture.driver.executeTurn({ ...input, permission: fullAccess })) chunks.push(...await projector.push(event))
    const message = '当前审批策略为 never，权限请求被策略自动拒绝，未弹出权限面板'
    assert.equal(results.length, 1)
    assert.equal(results[0].output, message)
    assert.equal(results[0].error, message)
    assert.equal(results[0].isError, true)
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PERMISSION_DENIED' } } })
    assert.equal(fixture.connections[0].killed, true)
  } finally { fixture.driver.dispose() }
})

test('Grok preserves ACP content-only tool output and failure details', { timeout: 3_000 }, async () => {
  const fixture = replay((request, connection) => {
    if (request.method !== 'session/prompt') return
    connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'ok-tool', title: 'read', content: [
      { type: 'content', content: { type: 'text', text: 'Still reading...' } },
    ] })
    connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'failed-tool', title: 'run_terminal_command', status: 'failed', content: [
      { type: 'content', content: { type: 'text', text: 'The process exited with code 7.' } },
    ] })
    connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'ok-tool', title: 'read', status: 'completed', content: [
      { type: 'content', content: { type: 'text', text: 'verified result' } },
    ] })
    connection.reply(request, { stopReason: 'end_turn' })
  })
  try {
    const events = []
    for await (const event of fixture.driver.executeTurn(input)) events.push(event)
    assert.deepEqual(events.filter(event => event.type === 'tool-event').map(event => [event.status, event.output, event.outputMode]), [
      ['running', 'Still reading...', 'snapshot'],
      ['failed', 'The process exited with code 7.', 'snapshot'], ['completed', 'verified result', 'snapshot'],
    ])
  } finally { fixture.driver.dispose() }
})

test('Grok does not relabel a later ordinary cancellation as a prior permission denial', { timeout: 4_000 }, async () => {
  let prompt = 0
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') {
      connection.promptId = request.id
      if (++prompt === 1) requestPermission(connection)
      else connection.reply(request, { stopReason: 'cancelled' })
    } else if (request.id === 77) connection.reply({ id: connection.promptId }, { stopReason: 'end_turn' })
  })
  try {
    for await (const event of fixture.driver.executeTurn(input)) {
      if (event.type === 'permission-request') fixture.driver.respondPermission(input.sessionId, { requestId: event.requestId, approved: false, reason: 'First turn denial' })
    }
    const events = []
    for await (const event of fixture.driver.executeTurn(input)) events.push(event)
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'cancel' })
  } finally { fixture.driver.dispose() }
})
