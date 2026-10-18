import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import { createSubagentBridgeRuntime, setSubagentBridge } from '../data/build/dist/host/cli-bridge/bridge-holder.js'

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

test('Grok names the actual injected bridge in the model prompt', { timeout: 3_000 }, async () => {
  setSubagentBridge(createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:1', token: 'bound' }))
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') {
      const prompt = JSON.stringify(request.params.prompt)
      assert.match(prompt, /codingns__agent_subagent/)
      assert.match(prompt, /codingns__web_search/)
      assert.match(prompt, /ordinary final output is also delivered to the parent/)
      connection.reply(request, { stopReason: 'end_turn' })
    }
  })
  try { for await (const _event of fixture.driver.executeTurn(input)) { /* Consume the real wire prompt. */ } }
  finally { fixture.driver.dispose(); setSubagentBridge(undefined) }
})

for (const scenario of [
  { label: 'a new workspace file', tool: 'write', path: 'result.json', admitted: true },
  { label: 'a formatted write display title', tool: 'write', path: 'result.json', display: true, admitted: true },
  { label: 'a formatted title with an explicit conflicting identity', tool: 'write', path: 'result.json', display: true, requestName: 'run_terminal_command', admitted: false },
  { label: 'a nested workspace file', tool: 'write', path: 'new/nested/result.json', admitted: true },
  { label: 'an existing workspace edit', tool: 'edit', path: 'existing.json', admitted: true },
  { label: 'a grok search_replace workspace edit', tool: 'search_replace', path: 'existing.json', admitted: true },
  { label: 'a path carried by the permission request', tool: 'write', path: 'result.json', requestInput: true, unobserved: true, admitted: true },
  { label: 'an uncorrelated missing input', tool: 'write', path: 'result.json', unobserved: true, admitted: false },
  { label: 'a conflicting path alias', tool: 'write', path: 'result.json', conflicting: true, admitted: false },
  { label: 'a conflicting observed tool', tool: 'write', path: 'result.json', observedTool: 'run_terminal_command', admitted: false },
  { label: 'an ordinary bound parent report', tool: 'codingns__agent_subagent', bridge: true, admitted: true },
  { label: 'an unbound parent report', tool: 'codingns__agent_subagent', admitted: false },
  { label: 'a bound parent web search', tool: 'codingns__web_search', bridge: true, admitted: true },
  { label: 'an unbound web search', tool: 'codingns__web_search', admitted: false },
  { label: 'a shell command', tool: 'run_terminal_command', path: 'result.json', admitted: false },
  { label: 'an outside file', tool: 'write', path: '../outside.json', admitted: false },
  { label: 'a symlink escape', tool: 'write', path: 'escape/result.json', admitted: false },
  { label: 'a symlink followed by dot-dot', tool: 'write', path: 'escape/../outside.json', admitted: false },
  { label: 'a dangling symlink', tool: 'write', path: 'dangling', admitted: false },
  { label: 'a misleading workspace prefix', tool: 'write', path: '../workspace-other/result.json', admitted: false },
  { label: 'a missing file path', tool: 'write', admitted: false },
  { label: 'read-only writes', tool: 'write', path: 'result.json', mode: 'read-only', admitted: false },
  { label: 'unknown scope', tool: 'write', path: 'result.json', mode: 'unknown', admitted: false },
  { label: 'plan-mode writes', tool: 'write', path: 'result.json', plan: true, admitted: false },
  { label: 'an explicit risk', tool: 'write', path: 'result.json', risk: 'elevated', admitted: false },
  { label: 'a permanent-only grant', tool: 'write', path: 'result.json', permanent: true, admitted: false },
  { label: 'a revoked report bridge', tool: 'codingns__agent_subagent', bridge: true, revoke: true, admitted: false },
]) {
  test(`Grok admits only existing authority for ${scenario.label}`, { timeout: 5_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'codingns-grok-admission-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const cwd = join(root, 'workspace')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'existing.json'), '{}')
    if (scenario.path?.startsWith('escape/') || scenario.path === 'dangling') {
      try {
        symlinkSync(root, join(cwd, 'escape'), 'dir')
        symlinkSync(join(root, 'missing.json'), join(cwd, 'dangling'))
      } catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error
        t.skip('This Windows host cannot create symlink fixtures.')
        return
      }
    }
    setSubagentBridge(scenario.bridge ? createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:1', token: 'bound' }) : undefined)
    const fixture = replay((request, connection) => {
      if (request.method === 'session/prompt') {
        connection.promptId = request.id
        if (scenario.revoke) setSubagentBridge(undefined)
        const rawInput = scenario.path ? { file_path: `${cwd}/${scenario.path}`,
          ...(scenario.conflicting ? { path: join(root, 'outside.json') } : {}) } : { action: 'send', message: '55' }
        if (!scenario.unobserved) connection.update({ sessionUpdate: 'tool_call', toolCallId: 'admitted-call', title: scenario.observedTool ?? scenario.tool, status: 'pending', rawInput })
        connection.emit({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {
          sessionId: 'provider-session', toolCall: { toolCallId: 'admitted-call', title: scenario.display ? `Write \`${cwd}/${scenario.path}\`` : scenario.tool,
            ...(scenario.requestName ? { name: scenario.requestName } : {}),
            ...(scenario.requestInput ? { rawInput } : {}) },
          ...(scenario.risk ? { _meta: { risk: scenario.risk } } : {}),
          options: scenario.permanent ? [permissionOptions[0], permissionOptions[3]] : permissionOptions,
        } })
      } else if (request.id === 77 && request.result) {
        connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'admitted-call', status: 'completed', rawOutput: 'done' })
        connection.reply({ id: connection.promptId }, { stopReason: 'end_turn' })
      }
    })
    try {
      let approvals = 0
      for await (const event of fixture.driver.executeTurn({ ...input, cwd, plan: scenario.plan,
        permission: scenario.mode === 'unknown' ? { approvalPolicy: 'never' } : { sandboxMode: scenario.mode ?? 'workspace-write', approvalPolicy: 'never' } } as never)) {
        if (event.type === 'permission-request') {
          approvals++
          fixture.driver.respondPermission(input.sessionId, { requestId: event.requestId, approved: false })
        }
      }
      assert.equal(approvals, scenario.admitted ? 0 : 1)
      const reply = fixture.connections[0].requests.find(request => request.id === 77 && request.result)
      assert.equal(reply?.result.outcome.optionId, scenario.admitted ? 'allow-once' : scenario.permanent ? undefined : 'reject-once')
      assert.equal(fixture.connections[0].args.includes('--always-approve'), false)
    } finally { fixture.driver.dispose(); setSubagentBridge(undefined) }
  })
}

test('Grok admits bound Team web_search without a second approval under workspace-write/never', { timeout: 5_000 }, async () => {
  const signal = new AbortController().signal
  const caller = {}
  setSubagentBridge(createSubagentBridgeRuntime({
    baseUrl: 'http://127.0.0.1:1', token: 'legacy',
    teamAccess: sessionId => sessionId === input.sessionId ? {
      caller, signal, identity: { sessionId, teamId: 'team', name: 'con-grok', role: 'teammate' },
    } : undefined,
  }))
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') {
      connection.promptId = request.id
      connection.update({ sessionUpdate: 'tool_call', toolCallId: 'search-call', title: 'codingns__web_search', status: 'pending', rawInput: { queries: ['公开资料'] } })
      connection.emit({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {
        sessionId: 'provider-session', toolCall: { toolCallId: 'search-call', title: 'codingns__web_search' }, options: permissionOptions,
      } })
    } else if (request.id === 77 && request.result) {
      connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'search-call', status: 'completed', rawOutput: '{"ok":true}' })
      connection.reply({ id: connection.promptId }, { stopReason: 'end_turn' })
    }
  })
  try {
    for await (const event of fixture.driver.executeTurn({ ...input, permission: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } })) {
      assert.notEqual(event.type, 'permission-request', 'The bound search tool must retain its existing Host authority')
    }
    const reply = fixture.connections[0].requests.find(request => request.id === 77 && request.result)
    assert.equal(reply?.result.outcome.optionId, 'allow-once')
  } finally { fixture.driver.dispose(); setSubagentBridge(undefined) }
})

test('Grok runs bound Team coordination without a second approval under workspace-write/never', { timeout: 5_000 }, async () => {
  const signal = new AbortController().signal
  const caller = {}
  const runtime = createSubagentBridgeRuntime({
    baseUrl: 'http://127.0.0.1:1', token: 'legacy',
    teamAccess: sessionId => sessionId === input.sessionId ? {
      caller, signal, identity: { sessionId, teamId: 'team', name: 'con-grok', role: 'teammate' },
    } : undefined,
  })
  setSubagentBridge(runtime)
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') {
      connection.promptId = request.id
      for (const [id, action] of [[77, 'status'], [78, 'task']] as const) {
        connection.update({ sessionUpdate: 'tool_call', toolCallId: `team-${id}`, title: 'use_tool', status: 'pending', rawInput: {
          tool_name: 'codingns__agent_team', tool_input: { action, ...(action === 'task' ? { taskId: 'task-2' } : {}) },
        } })
        connection.emit({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
          sessionId: 'provider-session', toolCall: { toolCallId: `team-${id}`, title: 'codingns__agent_team' }, options: permissionOptions,
        } })
      }
    } else if ([77, 78].includes(request.id) && request.result) {
      connection.update({ sessionUpdate: 'tool_call_update', toolCallId: `team-${request.id}`, status: 'completed', rawOutput: '{"ok":true}' })
      if (connection.requests.filter(item => [77, 78].includes(item.id) && item.result).length % 2 === 0) {
        connection.reply({ id: connection.promptId }, { stopReason: 'end_turn' })
      }
    }
  })
  try {
    for (let round = 0; round < 2; round++) {
      const events: Message[] = []
      for await (const event of fixture.driver.executeTurn({ ...input, permission: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } })) {
        assert.notEqual(event.type, 'permission-request', 'The bound Team tool must retain its existing coordination authority')
        events.push(event)
      }
      assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
    }
    assert.equal(fixture.connections.length, 1)
    assert.equal(fixture.connections[0].args.includes('--always-approve'), false)
    const replies = fixture.connections[0].requests.filter(request => [77, 78].includes(request.id) && request.result)
    assert.equal(replies.length, 4)
    assert.ok(replies.every(reply => reply.result.outcome.optionId === 'allow-once'))
  } finally { fixture.driver.dispose(); setSubagentBridge(undefined) }
})

for (const scenario of [
  { label: 'an unrelated CodingNS tool', tool: 'codingns__bash' },
  { label: 'another MCP server', tool: 'other__agent_team' },
  { label: 'an unqualified tool', tool: 'agent_team' },
  { label: 'a dynamic tool wrapper', tool: 'use_tool' },
  { label: 'an ordinary session', bound: false },
  { label: 'another host session', sessionId: 'other-session' },
  { label: 'a revoked Team identity', revoke: true },
  { label: 'read-only scope', permission: { sandboxMode: 'read-only', approvalPolicy: 'never' } },
  { label: 'unknown write scope', permission: { approvalPolicy: 'never' } },
  { label: 'plan mode', plan: true },
  { label: 'an explicit risk request', risk: 'elevated' },
  { label: 'only permanent approval options', options: [permissionOptions[0], permissionOptions[3]] },
  { label: 'missing approval options', options: [] },
]) {
  test(`Grok retains native permission handling for ${scenario.label}`, { timeout: 3_000 }, async () => {
    let bound = scenario.bound !== false
    const signal = new AbortController().signal
    const caller = {}
    setSubagentBridge(createSubagentBridgeRuntime({
      baseUrl: 'http://127.0.0.1:1', token: 'legacy',
      teamAccess: sessionId => bound && sessionId === input.sessionId ? {
        caller, signal, identity: { sessionId, teamId: 'team', name: 'con-grok', role: 'teammate' },
      } : undefined,
    }))
    const fixture = replay((request, connection) => {
      if (request.method === 'session/prompt') {
        connection.promptId = request.id
        if (scenario.revoke) bound = false
        connection.emit({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {
          sessionId: 'provider-session',
          toolCall: { toolCallId: 'team-call', title: scenario.tool ?? 'codingns__agent_team', rawInput: { tool_name: 'codingns__agent_team' } },
          options: scenario.options ?? permissionOptions,
          ...(scenario.risk ? { _meta: { risk: scenario.risk } } : {}),
        } })
      } else if (request.id === 77 && request.result) connection.reply({ id: connection.promptId }, { stopReason: 'end_turn' })
    })
    try {
      let approvals = 0
      for await (const event of fixture.driver.executeTurn({
        ...input, sessionId: scenario.sessionId ?? input.sessionId,
        permission: scenario.permission ?? { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
        ...(scenario.plan ? { plan: true } : {}),
      } as never)) {
        if (event.type === 'permission-request') {
          approvals++
          fixture.driver.respondPermission(scenario.sessionId ?? input.sessionId, { requestId: event.requestId, approved: false, reason: 'Native policy rejection' })
        }
      }
      assert.equal(approvals, 1)
      const outcome = fixture.connections[0].requests.find(request => request.id === 77 && request.result)?.result.outcome
      assert.ok(outcome.outcome === 'cancelled' || outcome.optionId.startsWith('reject'))
      assert.equal(fixture.connections[0].args.includes('--always-approve'), false)
    } finally { fixture.driver.dispose(); setSubagentBridge(undefined) }
  })
}

test('Grok rechecks Team write authority on each reused turn', { timeout: 4_000 }, async () => {
  const signal = new AbortController().signal
  const caller = {}
  setSubagentBridge(createSubagentBridgeRuntime({
    baseUrl: 'http://127.0.0.1:1', token: 'legacy',
    teamAccess: sessionId => ({ caller, signal, identity: { sessionId, teamId: 'team', name: 'con-grok', role: 'teammate' } }),
  }))
  const fixture = replay((request, connection) => {
    if (request.method === 'session/prompt') {
      connection.promptId = request.id
      connection.emit({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: {
        sessionId: 'provider-session', toolCall: { toolCallId: 'team-call', title: 'codingns__agent_team' }, options: permissionOptions,
      } })
    } else if (request.id === 77 && request.result) connection.reply({ id: connection.promptId }, { stopReason: 'end_turn' })
  })
  try {
    const approvals: string[] = []
    for (const sandboxMode of ['workspace-write', 'read-only', 'workspace-write']) {
      for await (const event of fixture.driver.executeTurn({ ...input, permission: { sandboxMode, approvalPolicy: 'never' } } as never)) {
        if (event.type === 'permission-request') {
          approvals.push(sandboxMode)
          fixture.driver.respondPermission(input.sessionId, { requestId: event.requestId, approved: false })
        }
      }
    }
    assert.equal(fixture.connections.length, 1)
    assert.deepEqual(approvals, ['read-only'])
    assert.deepEqual(fixture.connections[0].requests.filter(request => request.id === 77 && request.result)
      .map(request => request.result.outcome.optionId), ['allow-once', 'reject-once', 'allow-once'])
  } finally { fixture.driver.dispose(); setSubagentBridge(undefined) }
})

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

for (const envelope of [true, false]) {
  test(`Grok reads permission cancellation metadata from the ${envelope ? 'notification envelope' : 'update'}`, { timeout: 3_000 }, async () => {
    const fixture = replay((request, connection) => {
      if (request.method !== 'session/prompt') return
      const metadata = { cancellationCategory: 'PermissionRejected', cancellationContext: { tool_name: 'write', reason: 'Write rejected by policy' } }
      const update = { sessionUpdate: 'turn_completed', stop_reason: 'cancelled', ...(!envelope ? { _meta: metadata } : {}) }
      connection.emit({ method: '_x.ai/session/update', params: { sessionId: 'provider-session', update, ...(envelope ? { _meta: metadata } : {}) } })
      // The terminal notification is authoritative even without matching response metadata.
      connection.reply(request, { stopReason: 'end_turn' })
    })
    try {
      const events = []
      for await (const event of fixture.driver.executeTurn(input)) events.push(event)
      assert.deepEqual(events.at(-1), { type: 'finish', reason: 'error', failure: { message: 'Write rejected by policy', code: 'PERMISSION_DENIED' } })
    } finally { fixture.driver.dispose() }
  })
}

test('Grok reconstructs streamed arguments for calls cancelled before execution', { timeout: 3_000 }, async () => {
  const fixture = replay((request, connection) => {
    if (request.method !== 'session/prompt') return
    const delta = (update: Message) => connection.emit({ method: '_x.ai/session_notification', params: {
      sessionId: 'provider-session', update: { sessionUpdate: 'tool_call_delta_chunk', ...update },
    } })
    delta({ tool_call_id: 'first', tool_index: 0, name: 'read' })
    delta({ tool_index: 0, arguments_delta: '{"path":"original.txt"}' })
    connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'first', status: 'completed', rawOutput: 'Original content' })
    // A new model call reuses index zero. Its fragments belong to the new id.
    delta({ tool_call_id: 'next', tool_index: 0, name: 'write', arguments_delta: '{"file_path":' })
    delta({ tool_index: 0, arguments_delta: '"next.txt","content":"Hello\\nworld"}' })
    delta({ tool_call_id: 'sibling', tool_index: 1, name: 'write' })
    delta({ tool_index: 1, arguments_delta: '{"file_path":"sibling.txt","content":"Sibling"}' })
    connection.reply(request, { stopReason: 'cancelled', _meta: {
      cancellationCategory: 'PermissionRejected', cancellationContext: { reason: 'Write rejected by policy' },
    } })
  })
  const calls: Message[] = []
  const projector = new CodingNsDshMessageProjector({
    adapterId: 'grok', sessionId: input.sessionId,
    nativeSessions: {
      appendToolCall(sessionId, call) { calls.push(call); return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: calls.length } },
      appendToolResult() { return true },
    } as never,
  })
  try {
    for await (const event of fixture.driver.executeTurn(input)) await projector.push(event)
    assert.deepEqual(calls.map(call => [call.callId, JSON.parse(call.arguments)]), [
      ['first', { file_path: 'original.txt' }],
      ['next', { file_path: 'next.txt', content: 'Hello\nworld' }],
      ['sibling', { file_path: 'sibling.txt', content: 'Sibling' }],
    ])
  } finally { fixture.driver.dispose() }
})

for (const reason of ['end_turn', 'cancelled', 'failed']) {
  test(`Grok marks unfinished tools as unconfirmed when the provider ends with ${reason}`, { timeout: 3_000 }, async () => {
    const fixture = replay((request, connection) => {
      if (request.method !== 'session/prompt') return
      connection.update({ sessionUpdate: 'tool_call', toolCallId: 'done', title: 'read', status: 'pending', rawInput: { path: 'original.txt' } })
      connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'done', status: 'completed', rawOutput: 'Original content' })
      connection.update({ sessionUpdate: 'tool_call', toolCallId: 'incomplete', title: 'write', status: 'pending', rawInput: {} })
      connection.update({ sessionUpdate: 'tool_call', toolCallId: 'progress', title: 'read', status: 'in_progress', rawInput: { path: 'large.txt' } })
      connection.update({ sessionUpdate: 'tool_call_update', toolCallId: 'progress', status: 'in_progress', rawOutput: 'Still reading...' })
      connection.reply(request, { stopReason: reason })
    })
    const calls: Message[] = []
    const results: Message[] = []
    const projector = new CodingNsDshMessageProjector({
      adapterId: 'grok', sessionId: input.sessionId,
      nativeSessions: {
        appendToolCall(sessionId, call) { calls.push(call); return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: calls.length } },
        appendToolResult(handle, result) { results.push({ callId: handle.callId, ...result }); return true },
      } as never,
    })
    try {
      const chunks: Message[] = []
      for await (const event of fixture.driver.executeTurn({ ...input, splitToolSteps: true })) chunks.push(...await projector.push(event))
      assert.equal(results.length, 3)
      assert.equal(results.find(result => result.callId === 'done')?.isError, false)
      const incomplete = results.find(result => result.callId === 'incomplete')
      assert.equal(incomplete?.isError, true)
      assert.match(incomplete?.output, /without reporting a final result/)
      const progress = results.find(result => result.callId === 'progress')
      assert.equal(progress?.isError, true)
      assert.match(progress?.output, /without reporting a final result/)
      assert.equal(calls.find(call => call.callId === 'incomplete')?.arguments, '{}', 'Do not invent missing tool arguments')
      assert.equal(chunks.at(-1)?.reason.kind, reason === 'cancelled' ? 'aborted' : 'error')
      if (reason === 'end_turn') assert.equal(chunks.at(-1)?.reason.failure.code, 'INCOMPLETE_TOOL_RESULT')
    } finally { fixture.driver.dispose() }
  })
}

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
