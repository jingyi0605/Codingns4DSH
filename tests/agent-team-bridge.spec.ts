import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { createDshCapabilityRegistry } from '../data/build/dist/dsh-capabilities/routes.js'
import { createAgentTeamAdapter, DshAgentTeamAdapter, type TeamAgent } from '../data/build/dist/dsh-capabilities/host/agent-team-adapter.js'
import { CodingNsTeamDispatcher } from '../data/build/dist/host/cli-bridge/team-dispatch.js'
import { createSubagentBridgeRuntime, setSubagentBridge } from '../data/build/dist/host/cli-bridge/bridge-holder.js'
import { startSubagentBridgeServer } from '../data/build/dist/host/cli-bridge/bridge-server.js'
import { claudeBridgeArgs, codexBridgeArgs, codexBridgeDeveloperInstructions, acpBridgeMcpServers, openCodeBridgeMcpConfig, commandCodeNativeAgentEnvironment } from '../data/build/dist/host/cli-bridge/injections.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'
import { registerNativeTeamSubagentProviders } from '../data/build/dist/host/cli-adapters/native-team-subagent.js'
import { setNativeSubagents } from '../data/build/dist/host/cli-adapters/native-subagent-holder.js'
import { setAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry-holder.js'
import { teamToolSchema } from '../data/build/dist/shared/contracts/agent-team.js'
import { createAgentTeamTool } from '../data/build/dist/host/cli-bridge/team-tool.js'
import { teamAdapterSupport, withTeamSupport } from '../data/build/dist/host/cli-bridge/team-adapters.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'

function harness(rootAdapter = 'dsh') {
  const store = new CodingNsCliSessionStore()
  const drivers = ['codex', 'claude-code', 'opencode', 'command-code', 'gemini', 'mcode', 'grok', 'zcode', 'kimi', 'pi'].map(id => ({
    descriptor: { id, name: id, capabilities: ['models', 'stream', 'resume', 'interrupt'] },
    detect: async () => ({ installed: true, version: 'test', command: `/fake/${id}` }),
    listModels: async () => ({ groups: [{ id, name: id, models: [{ id: 'model-a', name: 'A', efforts: ['low', 'high'] }, { id: 'model-b', name: 'B', efforts: ['high'] }] }], currentModel: 'model-a', currentEffort: 'low' }),
    executeTurn: async function* () { yield { type: 'finish', reason: 'stop' } },
  }))
  const registry = new CodingNsCliAdapterRegistry(drivers as never, undefined, { sessionStore: store })
  const root = { id: 'root', session: { header: { id: 'root' } } }
  const agents = new Map<string, TeamAgent>([['root', root]])
  const names = new Map<string, string>([['root', 'lead']])
  const providers = new Map<string, any>([['spawn', {}]])
  const messages: Array<{ sender: unknown; request: any }> = []
  let enabled = true
  let adapter: DshAgentTeamAdapter | undefined
  let dispatcher: CodingNsTeamDispatcher
  let nextId = 0
  const service = {
    membership(agent: TeamAgent) {
      const name = names.get(agent.id)
      if (!name) throw Object.assign(new Error('Not a Team member'), { code: 'TEAM_NOT_MEMBER' })
      return { id: 'root', role: name === 'lead' ? 'lead' : 'teammate', name }
    },
    listMembers() { return [...names].map(([id, name]) => ({ id, name, role: name === 'lead' ? 'lead' : 'teammate', status: 'inactive' })) },
    sendMessage(sender: unknown, request: any) { messages.push({ sender, request }); return { messageId: `message-${messages.length}` } },
    listTasks() { return [] },
    getTask(_agent: unknown, id: string) { return { id, revision: 2, status: 'pending' } },
    createTask(_agent: unknown, request: any) { return { ...request, id: 'task-1', revision: 1 } },
    updateTask(_agent: unknown, request: any) {
      if (request.expectedRevision !== 2) throw Object.assign(new Error('Read the current task revision'), { code: 'TEAM_TASK_STALE_REVISION' })
      return { ...request, revision: 3 }
    },
    waitForChange(_agent: unknown, _timeout: number, signal: AbortSignal) {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
    interrupt(_agent: unknown, target: string) { return { target, previousStatus: 'running' } },
    async spawnTeammate(parent: TeamAgent, request: any) {
      const child = { id: `child-${++nextId}`, session: { header: { id: `child-${nextId}`, parentSession: parent.id } } }
      names.set(child.id, request.name)
      agents.set(child.id, child)
      dispatcher.initializeNativeChild(child)
      await providers.get(request.provider)?.prepareContinuable?.({ sessionId: child.id, parent, signal: request.signal })
      return { member: { id: child.id, name: request.name, phase: 'active' } }
    },
  }
  const native = {
    registerProvider(provider: any) { providers.set(provider.name, provider); return () => providers.delete(provider.name) },
    getProvider(name: string) { return providers.get(name) },
    async startActivation() { throw new Error('Team creation must use TeamService') },
    sendMessage() { throw new Error('Team peer messages must use TeamService') },
  }
  const context = {
    agentTeams: service,
    agents: { get: (id: string) => agents.get(id), list: () => [...agents.values()] },
    subagents: native,
    sessionController: { async modelCatalog() { return { default: { provider: 'native', model: 'native-a' }, groups: [{ id: 'native', models: [{ id: 'native-a', reasoning: { efforts: [{ id: 'low' }] } }] }] } } },
  }
  adapter = new DshAgentTeamAdapter(service, context.agents, context.sessionController)
  dispatcher = new CodingNsTeamDispatcher({ adapter: () => adapter, registry, enabled: () => enabled })
  registry.setSession('root', { adapterId: rootAdapter, ...(rootAdapter === 'dsh' ? {} : { modelId: 'model-a' }) })
  setAdapterRegistry(registry)
  setNativeSubagents(native as never)
  const disposeProviders = registerNativeTeamSubagentProviders(native as never)
  return {
    registry, store, root, agents, names, providers, messages, service, native, context, dispatcher,
    adapter: adapter!,
    setEnabled(value: boolean) { enabled = value },
    removeAdapter() { adapter?.dispose(); adapter = undefined },
    async dispose() { adapter?.dispose(); disposeProviders(); setNativeSubagents(undefined); setAdapterRegistry(undefined); setSubagentBridge(undefined); await registry.dispose() },
  }
}

test('Team routes retain alpha.2 support through rc.2 and reject old and future fixtures', async () => {
  const h = harness()
  try {
    for (const version of ['0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2']) {
      const profile = createDshCapabilityRegistry(version, 'host', h.context).getProfile(h.context)
      for (const role of ['member', 'lead'] as const) assert.equal(profile.capabilities.get(`agent-team.external-${role}`)?.status, 'ready')
    }
    for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-rc.3']) {
      const profile = createDshCapabilityRegistry(version, 'host', h.context).getProfile(h.context)
      assert.equal(profile.capabilities.get('agent-team.external-member')?.status, 'unavailable')
      assert.ok(profile.diagnostics.some(item => item.capability === 'agent-team.external-member' && item.code === 'CAPABILITY_VERSION_UNSUPPORTED'))
    }
    const missing = { ...h.context, agentTeams: { ...h.service, updateTask: undefined } }
    assert.equal(createDshCapabilityRegistry('0.2.1-alpha.3', 'host', missing).getProfile(missing).capabilities.get('agent-team.external-member')?.status, 'unavailable')
    const memberOnly = { ...h.context, agentTeams: { ...h.service, interrupt: undefined } }
    const profile = createDshCapabilityRegistry('0.2.1-alpha.3', 'host', memberOnly).getProfile(memberOnly)
    assert.equal(profile.capabilities.get('agent-team.external-member')?.status, 'ready')
    assert.equal(profile.capabilities.get('agent-team.external-lead')?.status, 'unavailable')
  } finally { await h.dispose() }
})

test('native and external Leads create real roster children with isolated model/effort selection', async () => {
  for (const rootAdapter of ['dsh', 'codex', 'claude-code']) {
    const h = harness(rootAdapter)
    try {
      const requests = ['model-a', 'model-b'].map((model, index) => h.dispatcher.dispatch('root', {
        action: 'spawn', agent: index === 0 ? 'codex' : 'claude-code', name: `worker-${index}`, description: 'Review', prompt: 'Review the code', model, effort: 'high',
      }))
      const results = await Promise.all(requests)
      assert.ok(results.every(result => result.ok), JSON.stringify(results))
      assert.equal(h.names.size, 3)
      assert.equal(h.registry.getSession('child-1').modelId, 'model-a')
      assert.equal(h.registry.getSession('child-2').modelId, 'model-b')
      assert.equal(h.registry.getSession('child-2').effortId, 'high')
      assert.equal(h.registry.getSession('child-2').teamId, 'root')
      assert.notEqual(h.registry.getSession('unrelated').modelId, 'model-b')
      const native = await h.dispatcher.dispatch('root', { action: 'spawn', agent: 'dsh', name: 'native-worker', description: 'Native review', prompt: 'Review natively' })
      assert.equal(native.ok, true, JSON.stringify(native))
      assert.deepEqual(h.registry.getSession('child-3').adapterId, 'dsh')
      assert.equal(h.registry.getSession('child-3').providerId, 'native')
      assert.equal(h.registry.getSession('child-3').modelId, 'native-a')
      assert.equal((await h.dispatcher.dispatch('child-1', { action: 'spawn', agent: 'codex', name: 'nested', description: 'No', prompt: 'No' })).code, 'TEAM_LEAD_REQUIRED')
    } finally { await h.dispose() }
  }
})

test('mixed Teams resolve the current native model catalog after late service publication', async () => {
  const h = harness('codex')
  let controller: unknown
  const adapter = createAgentTeamAdapter({ get(name: string) {
    return name === 'sessionController' ? controller : Reflect.get(h.context, name)
  } })
  try {
    await assert.rejects(adapter.nativeRoute(), { code: 'TEAM_NATIVE_ROUTE_UNAVAILABLE' })
    controller = h.context.sessionController
    assert.deepEqual(await adapter.nativeRoute(), { provider: 'native', model: 'native-a' })
    controller = { async modelCatalog() { return { default: { provider: 'replacement', model: 'other' }, groups: [{ id: 'replacement', models: [{ id: 'other' }] }] } } }
    assert.deepEqual(await adapter.nativeRoute(), { provider: 'replacement', model: 'other' })
    controller = undefined
    await assert.rejects(adapter.nativeRoute(), { code: 'TEAM_NATIVE_ROUTE_UNAVAILABLE' })
  } finally { adapter.dispose(); await h.dispose() }
})

test('same-adapter concurrent creation does not leak models or mutate adapter defaults', async () => {
  const h = harness('codex')
  try {
    const result = await Promise.all(['model-a', 'model-b'].map((model, index) => h.dispatcher.dispatch('root', {
      action: 'spawn', agent: 'codex', model, name: `same-${index}`, description: 'Review', prompt: 'Review',
    })))
    assert.ok(result.every(item => item.ok))
    assert.equal(h.registry.getSession('child-1').modelId, 'model-a')
    assert.equal(h.registry.getSession('child-2').modelId, 'model-b')
    assert.equal(h.registry.setSession('unrelated', { adapterId: 'codex' }).modelId, 'model-a')
  } finally { await h.dispose() }
})

test('native Team children do not inherit remembered effort from another native model', async () => {
  const h = harness('codex')
  try {
    h.registry.syncPreferences({ dsh: { modelId: 'old-reasoning-model', effortId: 'high', serviceTierId: 'fast', translationEnabled: true } })
    const result = await h.dispatcher.dispatch('root', {
      action: 'spawn', agent: 'dsh', name: 'native-worker', description: 'Native smoke test', prompt: 'Report readiness',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const child = h.registry.getSession('child-1')
    assert.equal(child.providerId, 'native')
    assert.equal(child.modelId, 'native-a')
    assert.equal(child.effortId, undefined, 'Omitted effort belongs to the selected native model default')
    assert.equal(child.serviceTierId, undefined)
    assert.equal(child.translationEnabled, true, 'Display preferences are independent of model selection')
    const synchronized = h.registry.setSession('child-1', { adapterId: 'dsh', providerId: 'native', modelId: 'native-a' })
    assert.equal(synchronized.effortId, undefined, 'Later native tool steps must not restore an unrelated remembered effort')
    assert.equal(synchronized.serviceTierId, undefined)
    assert.equal(h.store.get('child-1')?.effortId, undefined, 'Cold recovery must retain the exact route after synchronization')
    assert.equal(h.registry.getSession('unrelated').effortId, 'high', 'Ordinary native preferences remain intact')
  } finally { await h.dispose() }
})

test('cold Team bindings retain exact provider selection without becoming adapter defaults', async () => {
  const store = new CodingNsCliSessionStore()
  store.upsert('child', { adapterId: 'codex', modelId: 'team-model', effortId: 'high', providerSessionId: 'exact-provider-session', teamId: 'root', teamMemberId: 'child' })
  store.upsert('native-child', { adapterId: 'dsh', providerId: 'native', modelId: 'native-model', teamId: 'root', teamMemberId: 'native-child' })
  const registry = new CodingNsCliAdapterRegistry([{ descriptor: { id: 'codex', name: 'Test' } } as never], undefined, { sessionStore: store })
  try {
    assert.equal(registry.setSession('unrelated', { adapterId: 'codex' }).modelId, undefined)
    const restored = registry.setSession('child', { adapterId: 'codex' })
    assert.equal(restored.providerSessionId, 'exact-provider-session')
    assert.equal(restored.modelId, 'team-model')
    assert.equal(restored.teamId, 'root')
    assert.equal(registry.getSession('native-child').providerId, 'native')
  } finally { await registry.dispose() }
})

test('catalog readiness separates host, adapter installation, enablement, and role support', () => {
  const catalog = [
    { id: 'codex', name: 'Codex', installed: true, enabled: true },
    { id: 'claude-code', name: 'Claude', installed: false, enabled: true },
    { id: 'gemini', name: 'Gemini', installed: true, enabled: false },
    { id: 'kimi', name: 'Kimi', installed: true, enabled: true },
  ] as never
  assert.deepEqual(withTeamSupport(catalog).map(item => item.team), [
    { member: true, lead: true }, { member: false, lead: false, reason: 'installation' },
    { member: false, lead: false, reason: 'disabled' }, { member: false, lead: false, reason: 'adapter' },
  ])
  assert.deepEqual(withTeamSupport(catalog, undefined, false)[0]!.team, { member: true, lead: false })
  for (const reason of ['version', 'profile', 'disabled'] as const) assert.equal(withTeamSupport(catalog, reason).every(item => item.team?.reason === reason), true)
})

test('MiniMax exec-only effort retains ordinary routing and does not receive Team credentials', async () => {
  const h = harness('mcode')
  try {
    h.registry.setSession('root', { adapterId: 'mcode', effortId: 'high' })
    assert.equal(h.dispatcher.identity('root'), undefined)
    assert.equal(h.dispatcher.access('root'), undefined)
    assert.equal(h.registry.getSession('root').adapterId, 'mcode')
    assert.equal((await h.dispatcher.dispatch('root', { action: 'members' })).code, 'TEAM_EFFORT_UNSUPPORTED')
    h.registry.setSession('root', { adapterId: 'mcode', effortId: 'default' })
    assert.equal(h.dispatcher.identity('root')?.role, 'lead')
  } finally { await h.dispose() }
})

test('cancelled and rejected provisioning retain native errors and release the selection guard', async () => {
  const h = harness()
  const input = { action: 'spawn', agent: 'codex', name: 'reviewer', description: 'Review', prompt: 'Review' }
  try {
    const controller = new AbortController()
    controller.abort(Object.assign(new Error('Cancelled by caller'), { code: 'TEAM_CANCELLED' }))
    assert.equal((await h.dispatcher.dispatch('root', input, controller.signal)).code, 'TEAM_CANCELLED')
    assert.equal(h.names.size, 1)
    const spawn = h.service.spawnTeammate
    h.service.spawnTeammate = async () => { throw Object.assign(new Error('Native provisioning failed'), { code: 'TEAM_NATIVE_FAILURE' }) }
    assert.equal((await h.dispatcher.dispatch('root', input)).code, 'TEAM_NATIVE_FAILURE')
    assert.equal(h.store.list().some(item => item.teamMemberId?.startsWith('child')), false)
    h.service.spawnTeammate = spawn
    assert.equal((await h.dispatcher.dispatch('root', input)).ok, true)
  } finally { await h.dispose() }
})

test('peer messages retain the actual caller and task errors remain native', async () => {
  const h = harness('codex')
  try {
    await h.dispatcher.dispatch('root', { action: 'spawn', agent: 'claude-code', name: 'reviewer', description: 'Review', prompt: 'Review' })
    const sent = await h.dispatcher.dispatch('child-1', { action: 'message', target: 'lead', message: 'Found a race' })
    assert.deepEqual(sent.result, { messageId: 'message-1' })
    assert.equal(h.messages[0]?.sender, h.agents.get('child-1'))
    assert.deepEqual(h.messages[0]?.request.content, [{ type: 'text', text: 'Found a race' }])
    assert.equal((await h.dispatcher.dispatch('root', { action: 'task_update', taskId: 'task-1', expectedRevision: 1, taskAction: 'claim' })).code, 'TEAM_TASK_STALE_REVISION')
    assert.equal((await h.dispatcher.dispatch('child-1', { action: 'task_update', taskId: 'task-1', expectedRevision: 2, taskAction: 'reassign', owner: 'lead' })).code, 'TEAM_LEAD_REQUIRED')
    assert.equal((await h.dispatcher.dispatch('root', { action: 'task_update', taskId: 'task-1', expectedRevision: 2, taskAction: 'claim' })).ok, true)
    assert.equal((await h.dispatcher.dispatch('root', { action: 'members', sessionId: 'victim' })).code, 'TEAM_INVALID_INPUT')
    assert.equal((await h.dispatcher.dispatch('root', { action: 'members' }, undefined, { ...h.root })).code, 'TEAM_CALLER_UNAVAILABLE')
    assert.equal((await h.dispatcher.dispatch('root', { action: 'spawn', agent: 'kimi', name: 'unsupported', description: 'No', prompt: 'No' })).code, 'TEAM_ADAPTER_UNSUPPORTED')
    assert.equal((await h.dispatcher.dispatch('root', { action: 'spawn', agent: 'codex', name: 'bad-model', description: 'No', prompt: 'No', model: 'guessed' })).code, 'TEAM_MODEL_UNSUPPORTED')
  } finally { await h.dispose() }
})

test('session credentials cannot impersonate another caller or survive replacement and disposal', async () => {
  const h = harness('codex')
  try {
    const runtime = createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:1', token: 'legacy', teamAccess: id => h.dispatcher.access(id) })
    const first = runtime.teamSession!('root')!
    assert.notEqual(first.token, runtime.token)
    assert.equal(runtime.authorizeTeam!(runtime.token), undefined)
    assert.equal(runtime.authorizeTeam!(first.token), 'root')
    h.agents.set('root', { id: 'root', session: { header: { id: 'root' } } })
    assert.equal(runtime.authorizeTeam!(first.token), undefined)
    const replacement = runtime.teamSession!('root')!
    assert.notEqual(replacement.token, first.token)
    h.setEnabled(false)
    assert.equal(runtime.authorizeTeam!(replacement.token), undefined)
    assert.equal((await h.dispatcher.dispatch('root', { action: 'members' })).code, 'TEAM_BRIDGE_DISABLED')
    h.setEnabled(true)
    const current = runtime.teamSession!('root')!
    h.removeAdapter()
    assert.equal(runtime.authorizeTeam!(current.token), undefined)
  } finally { await h.dispose() }
})

test('Agent replacement during HTTP body delivery revokes the pending request', { timeout: 5_000 }, async () => {
  const h = harness('codex')
  let reads = 0; let dispatched = false
  const server = await startSubagentBridgeServer({
    dispatch: async () => { throw new Error('Unexpected ordinary dispatch') },
    teamAccess: id => { reads++; return h.dispatcher.access(id) },
    teamDispatch: async () => { dispatched = true; return { ok: true } },
  })
  let request: ReturnType<typeof httpRequest> | undefined
  try {
    const credential = server.runtime.teamSession!('root')!
    reads = 0
    const status = new Promise<number | undefined>((resolve, reject) => {
      request = httpRequest(`${server.runtime.baseUrl}/v1/team`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode) })
      request.on('error', reject)
      request.write('{"action":')
    })
    while (!reads) await new Promise(resolve => setImmediate(resolve))
    h.agents.set('root', { ...h.root })
    request!.end('"members"}')
    assert.equal(await status, 401)
    assert.equal(dispatched, false)
  } finally { request?.destroy(); await server.close(); await h.dispose() }
})

test('disposed Team credentials are reclaimed before the launch capacity is exhausted', () => {
  const actors = new Map<string, object>()
  const signal = new AbortController().signal
  const runtime = createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:1', token: 'legacy', teamAccess: sessionId => {
    const caller = actors.get(sessionId)
    return caller ? { caller, signal, identity: { sessionId, teamId: sessionId, name: 'lead', role: 'lead' } } : undefined
  } })
  for (let i = 0; i < 2048; i++) {
    const id = `session-${i}`
    actors.set(id, {})
    assert.ok(runtime.teamSession!(id))
    actors.delete(id)
  }
  actors.set('new', {})
  const credential = runtime.teamSession!('new')!
  assert.ok(credential)
  runtime.revokeTeamSession!('new')
  assert.equal(runtime.authorizeTeam!(credential.token), undefined)
})

test('wait is bounded, avoids inactive peers, and aborts when the Team service disappears', async () => {
  const h = harness()
  try {
    assert.deepEqual((await h.dispatcher.dispatch('root', { action: 'wait' })).result, { timedOut: false, noProgress: true })
    assert.equal((await h.dispatcher.dispatch('root', { action: 'wait', timeout_ms: 1 })).code, 'TEAM_INVALID_INPUT')
    h.service.listMembers = () => [{ id: 'peer', name: 'peer', role: 'teammate', status: 'running' }]
    const waiting = h.dispatcher.dispatch('root', { action: 'wait' })
    h.removeAdapter()
    assert.equal((await waiting).ok, false)
  } finally { await h.dispose() }
})

test('Team discovery uses one role-specific tool and injected transports carry session credentials', async () => {
  const h = harness('codex')
  try {
    await h.dispatcher.dispatch('root', { action: 'spawn', agent: 'claude-code', name: 'reviewer', description: 'Review', prompt: 'Review' })
    const runtime = createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:1', token: 'legacy', teamAccess: id => h.dispatcher.access(id) })
    setSubagentBridge(runtime)
    const args = claudeBridgeArgs('child-1', 'claude-code')
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]!)
    assert.equal(config.mcpServers.codingns.env.CODINGNS_TEAM_ROLE, 'teammate')
    assert.equal(config.mcpServers.codingns.env.CODINGNS_BRIDGE_TOKEN, runtime.teamSession!('child-1')!.token)
    assert.match(args[args.indexOf('--append-system-prompt') + 1]!, /mcp__codingns__agent_team/)
    assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__codingns__agent_team')
    assert.match(codexBridgeDeveloperInstructions('root')!, /codingns.agent_team/)
    assert.ok(codexBridgeArgs('root', 'codex').some(arg => arg.includes('CODINGNS_TEAM_TOKEN')))
    assert.equal(openCodeBridgeMcpConfig('root', 'opencode')?.toolName.endsWith('_agent_team'), true)
    assert.ok(acpBridgeMcpServers('root', 'gemini').length)
    assert.equal(acpBridgeMcpServers('root', 'command-code').length, 0)
    assert.equal(commandCodeNativeAgentEnvironment('root', 'command-code').CODINGNS_TEAM_ROLE, 'lead')
    assert.equal((teamToolSchema('teammate').properties as any).action.enum.includes('spawn'), false)
    const nativeTool = createAgentTeamTool(h.dispatcher) as any
    assert.equal((await nativeTool.execute({ action: 'members' }, { agent: { ...h.root } })).ok, false)
    assert.equal((await nativeTool.execute({ action: 'members' }, { agent: h.root })).ok, true)
    for (const id of ['codex', 'claude-code', 'command-code', 'gemini', 'mcode', 'grok', 'opencode']) assert.equal(teamAdapterSupport(id).member, true)
    for (const id of ['kimi', 'pi', 'zcode', 'doubao', 'unknown']) assert.equal(teamAdapterSupport(id).member, false)
  } finally { await h.dispose() }
})

test('MCP Team tool reaches the bound Host endpoint and rejects the shared legacy token', async () => {
  const h = harness('claude-code')
  const server = await startSubagentBridgeServer({ dispatch: async () => { throw new Error('No ordinary subagent dispatch') }, teamAccess: id => h.dispatcher.access(id), teamDispatch: (id, input, signal) => h.dispatcher.dispatch(id, input, signal) })
  let child: ReturnType<typeof spawn> | undefined
  try {
    setSubagentBridge(server.runtime)
    const args = claudeBridgeArgs('root', 'claude-code')
    const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers.codingns
    child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./register-source-loader.mjs', import.meta.url)), mcp.args[0]], { env: { ...process.env, ...mcp.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = new Map<number, (value: any) => void>()
    let buffer = ''
    child.stdout!.on('data', chunk => {
      buffer += chunk.toString()
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        const result = JSON.parse(line); pending.get(result.id)?.(result.result)
      }
    })
    let sequence = 0
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const id = ++sequence
      const timeout = setTimeout(() => reject(new Error('MCP response timeout')), 5000)
      pending.set(id, value => { clearTimeout(timeout); pending.delete(id); resolve(value) })
      child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    const tools = await rpc('tools/list', {})
    assert.equal(tools.tools.length, 1)
    assert.equal(tools.tools[0].name, 'agent_team')
    const status = await rpc('tools/call', { name: 'agent_team', arguments: { action: 'status' } })
    assert.equal(JSON.parse(status.content[0].text).result.identity.role, 'lead')
    const rejected = await fetch(`${server.runtime.baseUrl}/v1/team`, { method: 'POST', headers: { authorization: `Bearer ${server.runtime.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'members' }) })
    assert.equal(rejected.status, 401)
    const spoof = await rpc('tools/call', { name: 'agent_team', arguments: { action: 'members', sessionId: 'victim' } })
    assert.equal(JSON.parse(spoof.content[0].text).code, 'TEAM_INVALID_INPUT')
  } finally { child?.kill(); await server.close(); await h.dispose() }
})

test('late native Team service installation and removal update feature tools without restarting ordinary adapters', async () => {
  const h = harness('codex')
  const ctx = new Context()
  const registered = new Map<string, any>()
  ctx.provide('agents', h.context.agents)
  ctx.provide('subagents', h.native)
  ctx.provide('sessionController', h.context.sessionController)
  ctx.provide('tools', { register(tool: any) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } })
  const table = new CodingNsRpcTable()
  const features = new FeatureRegistry({ rpc: table, dshVersion: '0.2.1-alpha.3', dshContext: ctx,
    settings: { get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, subagentBridge: { enabled: true, maxConcurrentSubagents: 8 } }), watch: () => () => {}, update: async () => {} } as never,
  })
  features.register(createCliAdaptersFeature({ registry: h.registry }))
  const settle = () => new Promise(resolve => setImmediate(resolve))
  let remove: (() => unknown) | undefined
  try {
    await features.start('cliAdapters')
    assert.equal(registered.has('agent_team'), false)
    remove = ctx.provide('agentTeams', h.service)
    await settle()
    assert.equal(registered.has('agent_team'), true)
    const result = await registered.get('agent_team').execute({ action: 'members' }, { agent: h.root })
    assert.equal(result.ok, true, JSON.stringify(result))
    h.service.spawnTeammate = async (_parent, request) => {
      const child = { id: 'native-child', session: { header: { id: 'native-child' } } }
      h.agents.set(child.id, child); h.names.set(child.id, request.name)
      ctx.emit('agent/created' as never, { agent: child } as never)
      assert.equal(h.registry.getSession(child.id).adapterId, 'dsh')
      assert.equal(h.registry.getSession(child.id).providerId, 'native')
      return { member: { id: child.id, name: request.name, phase: 'active' } }
    }
    const nativeChild = await registered.get('agent_team').execute({ action: 'spawn', agent: 'dsh', name: 'native-worker', description: 'Native work', prompt: 'Work' }, { agent: h.root })
    assert.equal(nativeChild.ok, true, JSON.stringify(nativeChild))
    await remove(); remove = undefined
    await settle()
    assert.equal(registered.has('agent_team'), false)
    assert.equal(h.registry.getSession('root').adapterId, 'codex')
    remove = ctx.provide('agentTeams', h.service)
    await settle()
    assert.equal(registered.has('agent_team'), true)
    await features.disable('cliAdapters')
    assert.equal(registered.has('agent_team'), false)
  } finally { await features.disable('cliAdapters'); await remove?.(); await h.dispose() }
})
