import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { CommandCodeDriver } from '../data/build/dist/host/cli-adapters/command-code-driver.js'
import { GeminiCliDriver } from '../data/build/dist/host/cli-adapters/gemini-driver.js'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'
import { MiniMaxCodeDriver } from '../data/build/dist/host/cli-adapters/mcode-driver.js'
import { createSubagentBridgeRuntime, setSubagentBridge } from '../data/build/dist/host/cli-bridge/bridge-holder.js'
import { startSubagentBridgeServer } from '../data/build/dist/host/cli-bridge/bridge-server.js'
import { commandCodeNativeAgentEnvironment } from '../data/build/dist/host/cli-bridge/injections.js'
import commandCodeMod from '../data/build/dist/host/cli-bridge/command-code-mod.js'

/** Exercise actual driver protocols with memory streams, without running a CLI or model. */
function protocol() {
  const calls: { process: number; method: string; params: any }[] = []
  const launches: { args: string[]; env: any }[] = []
  let failLoad = false
  let failModel = false
  let requestPermission = false
  const replies: any[] = []
  let promptId: unknown
  const spawn = (_command: string, args: string[], options: any) => {
    const process = launches.length
    launches.push({ args, env: options?.env })
    const stdout = new PassThrough(); const stderr = new PassThrough()
    const send = (value: unknown) => stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value as object }) + '\n')
    return {
      stdout, stderr,
      stdin: { write(data: string) {
        const request = JSON.parse(data)
        if (!request.method) {
          replies.push(request)
          if (request.id === 77) send({ id: promptId, result: { stopReason: 'end_turn' } })
          return true
        }
        calls.push({ process, method: request.method, params: request.params })
        if (request.id === undefined) return true
        if (failLoad && ['session/load', 'thread/resume'].includes(request.method)
          || failModel && request.method === 'session/set_model') {
          send({ id: request.id, error: { code: -32001, message: 'Provider refused the exact request' } }); return true
        }
        if (request.method === 'session/prompt' && requestPermission) {
          promptId = request.id
          send({ id: 77, method: 'session/request_permission', params: {
            toolCall: { title: 'agent_team', toolCallId: 'team-call', rawInput: { action: 'members' } },
            options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }],
          } }); return true
        }
        const result = request.method === 'thread/start' || request.method === 'thread/resume' ? { thread: { id: 'provider-session' } }
          : request.method === 'turn/start' ? { turn: { id: 'turn', status: 'inProgress' } }
          : request.method === 'session/new' || request.method === 'session/load' ? { sessionId: 'provider-session' }
          : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        send({ id: request.id, result })
        if (request.method === 'turn/start') send({ method: 'turn/completed', params: { threadId: 'provider-session', turn: { id: 'turn', status: 'completed' } } })
        return true
      } },
      kill() { stdout.end(); stderr.end(); return true },
    }
  }
  return { calls, launches, replies, options: { binaries: ['fake-cli'], spawn: spawn as never, spawnSync: (() => ({ status: 0, stdout: 'fake 1.2.3', stderr: '' })) as never },
    failLoad() { failLoad = true }, failModel() { failModel = true }, requestPermission() { requestPermission = true } }
}

function bridge() {
  let caller = {}
  const signal = new AbortController().signal
  const runtime = createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:1', token: 'legacy', teamAccess: sessionId => ({
    caller, signal, identity: { sessionId, teamId: 'team', name: 'lead', role: 'lead' },
  }) })
  setSubagentBridge(runtime)
  return { runtime, replace() { caller = {} } }
}

const factories = {
  codex: (options: any) => new CodexAppServerDriver({ ...options, computerUse: 'disabled' }),
  'command-code': (options: any) => new CommandCodeDriver({ ...options, enableAcp: true }),
  gemini: (options: any) => new GeminiCliDriver(options),
  grok: (options: any) => new GrokBuildDriver(options),
  mcode: (options: any) => new MiniMaxCodeDriver(options),
}
for (const [id, factory] of Object.entries(factories)) {
  test(`${id} refreshes Team credentials and resumes the exact provider session`, { timeout: 5_000 }, async () => {
    const p = protocol(); const b = bridge(); const driver = factory(p.options)
    const input = { sessionId: 'dsh-session', messages: [], prompt: 'Work', effortId: 'default' }
    try {
      const events = []
      for await (const event of driver.executeTurn(input)) events.push(event)
      assert.equal(events.find(event => event.type === 'session-binding')?.providerSessionId, 'provider-session')
      const oldToken = b.runtime.teamSession!('dsh-session')!.token
      b.replace()
      for await (const _event of driver.executeTurn({ ...input, providerSessionId: 'provider-session', prompt: 'Continue' })) { /* consume */ }
      assert.equal(p.launches.length, 2)
      assert.notEqual(b.runtime.teamSession!('dsh-session')!.token, oldToken)
      assert.equal(b.runtime.authorizeTeam!(oldToken), undefined)
      const resumed = p.calls.find(call => call.process === 1 && ['thread/resume', 'session/load'].includes(call.method))
      assert.equal(resumed?.params.threadId ?? resumed?.params.sessionId, 'provider-session')
      assert.equal(p.calls.filter(call => ['thread/start', 'session/new'].includes(call.method)).length, 1)
      if (id === 'command-code') assert.equal(p.launches[1]?.env.CODINGNS_TEAM_TOKEN, b.runtime.teamSession!('dsh-session')!.token)
      else if (id !== 'codex') assert.equal(resumed?.params.mcpServers[0].env.find((item: any) => item.name === 'CODINGNS_TEAM_TOKEN').value, b.runtime.teamSession!('dsh-session')!.token)
    } finally { driver.dispose(); setSubagentBridge(undefined) }
  })

  test(`${id} refuses a missing Team provider session without creating a replacement`, { timeout: 5_000 }, async () => {
    const p = protocol(); bridge(); p.failLoad(); const driver = factory(p.options)
    try {
      await assert.rejects(async () => {
        for await (const _event of driver.executeTurn({ sessionId: 'dsh-session', providerSessionId: 'missing', prompt: 'Continue', messages: [], effortId: 'default' })) { /* consume */ }
      }, /Provider refused/)
      assert.equal(p.calls.some(call => ['thread/start', 'session/new', 'session/prompt', 'turn/start'].includes(call.method)), false)
      assert.equal(p.launches.length, 1, 'A Team failure must not enter a legacy CLI fallback')
    } finally { driver.dispose(); setSubagentBridge(undefined) }
  })
}

test('Team model rejection is visible and never executes a prompt on another model', async () => {
  for (const factory of [factories['command-code'], factories.mcode]) {
    const p = protocol(); bridge(); p.failModel(); const driver = factory(p.options)
    try {
      await assert.rejects(async () => {
        for await (const _event of driver.executeTurn({ sessionId: 'dsh-session', prompt: 'Work', messages: [], modelId: 'requested-model', effortId: 'default' })) { /* consume */ }
      }, /Provider refused/)
      assert.equal(p.calls.some(call => call.method === 'session/prompt'), false)
    } finally { driver.dispose(); setSubagentBridge(undefined) }
  }
})

test('Command Code approves only its bound Team coordination tool under existing write authority', async () => {
  const p = protocol(); bridge(); p.requestPermission(); const driver = factories['command-code'](p.options)
  try {
    for await (const event of driver.executeTurn({ sessionId: 'dsh-session', prompt: 'Read roster', messages: [], permission: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } })) {
      assert.notEqual(event.type, 'permission-request')
    }
    assert.equal(p.replies.find(reply => reply.id === 77)?.result.outcome.optionId, 'allow')
  } finally { driver.dispose(); setSubagentBridge(undefined) }
})

test('Command Code Mod exposes a teammate schema, blocks private agents, and calls the bound Team endpoint', async () => {
  const signal = new AbortController().signal
  const received: unknown[] = []
  const server = await startSubagentBridgeServer({
    dispatch: async () => { throw new Error('Unexpected ordinary dispatch') },
    teamAccess: sessionId => ({ caller: signal, signal, identity: { sessionId, teamId: 'root', name: 'reviewer', role: 'teammate' } }),
    teamDispatch: async (id, input) => { received.push({ id, input }); return { ok: true, result: [] } },
  })
  const previous = { ...process.env }
  try {
    setSubagentBridge(server.runtime)
    Object.assign(process.env, commandCodeNativeAgentEnvironment('child', 'command-code'))
    const tools: any[] = []; let hooks: any; let active = ['agent', 'agent_output', 'agent_subagent', 'agent_team', 'bash']
    commandCodeMod({ addTool: tool => tools.push(tool), hooks: value => { hooks = value }, getActiveTools: () => active, setActiveTools: names => { active = [...names] } })
    assert.equal(tools.length, 1)
    assert.equal(tools[0].schema.name, 'agent_team')
    assert.equal(tools[0].schema.input_schema.properties.action.enum.includes('spawn'), false)
    hooks.onSessionStart()
    assert.deepEqual(active, ['agent_team', 'bash'])
    assert.equal(hooks.beforeToolCall({ toolName: 'agent' }).block, true)
    assert.equal((await tools[0].run({ input: { action: 'members' } })).ok, true)
    assert.deepEqual(received, [{ id: 'child', input: { action: 'members' } }])
  } finally { process.env = previous; setSubagentBridge(undefined); await server.close() }
})
