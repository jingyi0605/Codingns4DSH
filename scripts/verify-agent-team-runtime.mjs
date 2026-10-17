import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

// Explicit, opt-in live validation. Never points a launcher at an existing profile.
const [installation, version, selection = 'all', lifecycle] = process.argv.slice(2)
const turnTimeoutMs = Number(process.env.CODINGNS_TEAM_ACCEPTANCE_TIMEOUT_MS ?? 150_000)
if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 10_000 || turnTimeoutMs > 600_000) throw new Error('Acceptance timeout must be 10–600 seconds')
if (!installation || !['0.2.1-alpha.2', '0.2.1-alpha.3'].includes(version)) throw new Error('Usage: node scripts/verify-agent-team-runtime.mjs /tmp/codingns-spec0074-runtime-*/<version> <version> [scenario]')
const runtime = realpathSync(installation)
if (!runtime.startsWith('/private/tmp/codingns-spec0074-runtime-') && !runtime.startsWith('/tmp/codingns-spec0074-runtime-')) throw new Error('A dedicated temporary acceptance installation is required')
assert.equal(JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, version)
if (lifecycle !== undefined && lifecycle !== 'lifecycle') throw new Error('The optional fourth argument must be lifecycle')
const run = await mkdtemp(join(runtime, 'acceptance-'))
await mkdir(join(run, 'workspace'), { recursive: true })
process.env.DSH_HOME = join(run, 'home')
process.env.CODINGNS4DSH_STATE_DIR = join(run, 'state')
process.env.DSH_TELEMETRY_MODE = 'OFF'
process.chdir(join(run, 'workspace'))
const load = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const built = new URL('../data/build/dist/', import.meta.url)
const plugin = name => import(new URL(name, built).href)
const [{ boot, loadOverlayPatches }, { LlmAdapter, createUserMessage }, { buildModelCatalog }] = await Promise.all([load('dsh-app-boot'), load('dsh-llm'), load('dsh-api-session-controller')])
const [{ createCliAdaptersFeature }, { CodingNsCliAdapterRegistry }, { CodexAppServerDriver }, { ClaudeCodeDriver }, { FeatureRegistry }, { CodingNsRpcTable }, { DEFAULT_CODINGNS_SETTINGS }, { createCodingNsNativeSessionBridge }, nativeProviders, nativeHolder, bridgeHolder] = await Promise.all([
  plugin('host/cli-adapters/feature.js'), plugin('host/cli-adapters/registry.js'), plugin('host/cli-adapters/codex-driver.js'), plugin('host/cli-adapters/claude-driver.js'),
  plugin('features/index.js'), plugin('host/rpc-table.js'), plugin('shared/contracts/config.js'), plugin('host/native-session-bridge.js'),
  plugin('host/cli-adapters/native-team-subagent.js'), plugin('host/cli-adapters/native-subagent-holder.js'), plugin('host/cli-bridge/bridge-holder.js'),
])
const rootConfig = join(run, 'cordis.yml')
await writeFile(rootConfig, '[]\n')
const patches = [
  ...loadOverlayPatches('spec0074', join(runtime, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml')),
  ...loadOverlayPatches('spec0074', join(runtime, 'node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml')),
  ...['hmr', 'session-title-llm', 'session-telemetry-otel', 'ui-agent-team'].map(id => ({ id, disabled: true })),
  { id: 'agent-default-model', config: { provider: 'spec-native', model: 'native' } },
]
const errors = []
const ctx = await boot('spec0074', rootConfig, patches, undefined, pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh/lib/')).href)
const report = { version, run, timeoutMs: turnTimeoutMs, mode: 'real DSH core and TeamService; live external CLIs; deterministic native LLM fixture', scenarios: [] }
report.pluginVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const nativePlans = new Map()
const workerSteps = new Map()
function* toolCall(arguments_) {
  const block = { type: 'tool-call', id: `team-${randomUUID()}`, name: 'agent_team', arguments: JSON.stringify(arguments_) }
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
class NativeFixture extends LlmAdapter {
  async listModels() { return [{ provider: 'spec-native', id: 'native', name: 'Acceptance native', inputModalities: ['text'] }] }
  async *stream(input) {
    const plan = nativePlans.get(input.sessionId)
    if (plan && !plan.started) {
      plan.started = true
      yield* toolCall(plan.spawn)
      return
    }
    const last = input.messages.filter(message => message.role === 'user').at(-1)
    const text = typeof last?.content === 'string' ? last.content : last?.content?.map(block => block.text ?? '').join(' ') ?? ''
    const markers = [...new Set(text.match(/TEAM_[A-Za-z0-9_]+(?: (?:PEER|DONE))?/gu) ?? [])]
    const response = `NATIVE_ACK ${markers.join(' ') || 'received'}`
    if (!plan) {
      let worker = workerSteps.get(input.sessionId)
      if (!worker || worker.inputId !== last?.id) { worker = { inputId: last?.id, step: 0 }; workerSteps.set(input.sessionId, worker) }
      const current = ctx.get('agents').get(input.sessionId)
      const task = ctx.get('agentTeams').listTasks(current).at(-1)
      const action = worker.step++
      if (action === 0) { yield* toolCall({ action: 'task_create', subject: text.match(/TEAM_[A-Za-z0-9_]+/)?.[0] ?? 'Native acceptance', description: 'Native worker acceptance' }); return }
      if (action === 1 || action === 2) { yield* toolCall({ action: 'task_update', taskId: task.id, expectedRevision: task.revision, taskAction: action === 1 ? 'claim' : 'complete' }); return }
      if (action === 3) { yield* toolCall({ action: 'message', target: 'lead', message: response }); return }
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const stopNative = ctx.get('llm').registerAdapter(['spec-native'], new NativeFixture())
// Use DSH's real catalog builder without mounting a browser/API surface.
const stopCatalog = ctx.provide('sessionController', { modelCatalog: () => buildModelCatalog(ctx, { provider: 'spec-native', model: 'native' }) })
ctx.on('agent/error', ({ agent, error }) => { errors.push({ sessionId: agent.id, message: String(error?.message ?? error) }); console.error(`Agent error ${agent.id}: ${error?.message ?? error}`) }, { global: true })
const nativeSessions = createCodingNsNativeSessionBridge(ctx, version)
const claudeOptions = { spawn(command, args, options) {
  // Keep unrelated user MCP servers out of this explicitly isolated test.
  const child = spawn(command, args.includes('--mcp-config') ? [...args, '--strict-mcp-config'] : args, options)
  if (process.env.CODINGNS_TEAM_TRACE_PROTOCOL !== '1') return child
  let buffer = ''
  child.stdout?.on('data', data => {
    buffer += String(data)
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      try {
        const event = JSON.parse(line)
        if (event.type) console.log('CLAUDE_PROTOCOL', JSON.stringify({ type: event.type, subtype: event.subtype, event: event.event?.type,
          status: event.status, servers: event.mcp_servers?.map(server => ({ name: server.name, status: server.status })),
        }))
      } catch { /* Trace only protocol metadata, never raw credentials or content. */ }
    }
  })
  child.once('exit', (code, signal) => console.log('CLAUDE_EXIT', code, signal))
  return child
} }
const drivers = [new CodexAppServerDriver({ computerUse: 'disabled' }), new ClaudeCodeDriver(claudeOptions)]
for (const driver of drivers) {
  const execute = driver.executeTurn.bind(driver)
  driver.executeTurn = async function* (input) {
    console.log(`CLI_START ${driver.descriptor.id} ${input.sessionId}`)
    for await (const event of execute(input)) {
      if (event.type === 'permission-request') console.log(`CLI_APPROVAL ${driver.descriptor.id} ${event.toolName}`)
      if (event.type === 'tool-event' && ['completed', 'failed'].includes(event.status)) console.log(`CLI_TOOL ${driver.descriptor.id} ${event.toolName} ${event.status}`)
      if (event.type === 'tool-event' && event.status === 'failed') console.error('TOOL_FAILURE', String(event.output ?? '').slice(0, 1500))
      yield event
    }
  }
}
const registry = new CodingNsCliAdapterRegistry(drivers, undefined, { nativeSessions })
let settings = { ...DEFAULT_CODINGNS_SETTINGS, subagentBridge: { enabled: true, maxConcurrentSubagents: 4 }, agentAdapters: { codex: true, 'claude-code': true } }
const table = new CodingNsRpcTable()
const features = new FeatureRegistry({ rpc: table, dshContext: ctx, dshVersion: version, nativeSessions,
  settings: { get: () => settings, update: async patch => { settings = { ...settings, ...patch } }, watch: () => () => {} },
  events: { on: ctx.on.bind(ctx), emit: ctx.emit.bind(ctx) },
})
features.register(createCliAdaptersFeature({ registry }))
const published = []
ctx.on('agent/created', ({ agent }) => {
  const credential = bridgeHolder.getSubagentBridge()?.teamSession(agent.id)
  published.push({ sessionId: agent.id, caller: agent, credential })
}, { global: true })
nativeHolder.setNativeSubagents(ctx.get('subagents'))
const stopProviders = nativeProviders.registerNativeTeamSubagentProviders(ctx.get('subagents'))
const timeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
const waitIdle = async agent => {
  await timeout((async () => {
    while (true) {
      await agent.whenIdle()
      const seq = agent.session.seq
      if (!await ctx.get('subagents').waitForChildren(agent) && agent.status === 'idle' && agent.session.seq === seq) return
    }
  })(), turnTimeoutMs, `Team ${agent.id} did not settle within ${turnTimeoutMs / 1000} seconds`)
}
const peerPrompt = marker => `This is an explicitly requested native DSH Team acceptance test. Use only your injected agent_team tool. Do not use shell, files, network tools, or private agents. First call action=members. Then call action=task_create with subject="${marker}", description="Acceptance task". Claim that task with task_update taskAction=claim and its expectedRevision. Complete it using taskAction=complete and the new revision. Send action=message target=lead message="${marker} DONE". Finish with exactly "${marker} DONE". If any tool fails, report its exact error and stop.`
const teamCall = async (sessionId, input) => {
  const runtime = bridgeHolder.getSubagentBridge()
  const credential = runtime.teamSession(sessionId)
  const response = await fetch(`${runtime.baseUrl}/v1/team`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) })
  const result = await response.json()
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.result
}
const scenarios = [
  ['native-codex', 'dsh', 'codex'], ['native-claude', 'dsh', 'claude-code'],
  ['codex-native', 'codex', 'dsh'], ['claude-native', 'claude-code', 'dsh'],
  ['codex-claude', 'codex', 'claude-code'], ['claude-codex', 'claude-code', 'codex'],
  ['codex-codex', 'codex', 'codex'],
].filter(([name]) => selection === 'all' || selection === name)
assert.ok(scenarios.length, 'Unknown acceptance scenario')
try {
  await features.start('cliAdapters')
  report.agents = (await registry.catalog()).map(agent => ({ id: agent.id, installed: agent.installed, version: agent.version, command: agent.command }))
  const fixtureCatalog = await ctx.get('sessionController').modelCatalog()
  assert.ok(fixtureCatalog.groups.some(group => group.id === 'spec-native' && group.models.some(model => model.id === 'native')), 'The deterministic native fixture must advertise a valid DSH catalog route')
  ctx.on('llm/stream', async function* (input, next) {
    for await (const chunk of next()) {
      if (chunk.type === 'finish' && chunk.reason?.failure) console.error('NATIVE_FAILURE', JSON.stringify(chunk.reason.failure))
      yield chunk
    }
  }, { global: true })
  for (const [name, lead, backend] of scenarios) {
    console.log(`START ${version} ${name}`)
    const marker = `TEAM_${name.replaceAll('-', '_')}_${randomUUID().slice(0, 8)}`
    const id = `spec0074-${name}-${randomUUID()}`
    registry.setSession(id, { adapterId: lead, ...(lead === 'claude-code' || lead === 'codex' ? { effortId: 'low' } : {}) })
    const { agent } = await ctx.get('agents').create({ sessionId: id, meta: { cwd: process.cwd() }, agentOptions: { provider: 'spec-native', model: 'native', maxTokens: 4096 } })
    const spawn = { action: 'spawn', agent: backend, name: 'reviewer', description: 'Acceptance reviewer', prompt: peerPrompt(marker), ...(backend === 'dsh' ? { provider: 'spec-native', model: 'native' } : backend === 'claude-code' ? { model: 'provider-default', effort: 'low' } : {}) }
    if (lead === 'dsh') nativePlans.set(id, { started: false, spawn })
    const prompt = lead === 'dsh' ? `Explicitly use a Team for acceptance ${marker}.` : `This is an explicitly requested native DSH Team acceptance test. Use only your injected agent_team tool. Do not use shell, files, network tools, or private agents. Call action=spawn exactly once with these arguments: ${JSON.stringify(spawn)}. Then read members and tasks. Wait for reviewer to finish before your final answer; use action=wait if it is still running and reread tasks after changes. Do not resend the spawn on an uncertain error. For a native DSH reviewer, send it a second peer message containing "${marker} PEER" after its first turn ends, and verify the reply contains that marker. For an external reviewer, verify its task is completed and its message contains "${marker} DONE". Finish with exactly "${marker} LEAD_DONE". If any tool fails, report the exact error and stop.`
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }))
    await waitIdle(agent)
    const members = ctx.get('agentTeams').listMembers(agent)
    const child = members.find(member => member.name === 'reviewer')
    if (!child) {
      const answers = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').flatMap(event => event.data.message?.content ?? event.data.content ?? []).filter(block => block?.type === 'text').map(block => block.text)
      console.error('LEAD_DIAGNOSTIC', JSON.stringify(answers).slice(0, 3000))
    }
    assert.ok(child, `${name}: no rostered reviewer; errors=${JSON.stringify(errors)}`)
    assert.notEqual(child.status, 'failed', JSON.stringify(child))
    assert.equal(registry.getSession(child.id).adapterId, backend)
    const tasks = ctx.get('agentTeams').listTasks(agent)
    if (backend !== 'dsh') assert.ok(tasks.some(task => task.subject === marker && task.status === 'completed'), `${name}: child task was not completed: ${JSON.stringify(tasks)}`)
    const events = agent.session.snapshotEvents()
    const peers = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'agent-message')
    assert.ok(peers.some(event => event.data.source.senderSessionId === child.id), `${name}: no attributed peer result`)
    let lifecycleResult
    let cancellationErrorStart = Infinity
    if (lifecycle === 'lifecycle') {
      const runtime = bridgeHolder.getSubagentBridge()
      const previousPublication = published.filter(item => item.sessionId === child.id).at(-1)
      const previousAgent = previousPublication.caller
      const providerSessionId = registry.getSession(child.id).providerSessionId
      const oldCredential = previousPublication.credential
      assert.ok(oldCredential, 'The live member must receive a launch credential')
      for (const phase of ['FOLLOWUP', 'COLD']) {
        if (phase === 'COLD') {
          await ctx.get('subagents').drainChildren(agent, [child.id])
          assert.equal(ctx.get('agents').get(child.id), undefined)
          assert.equal(runtime.authorizeTeam(oldCredential.token), undefined)
        }
        const followup = `${marker}_${phase}`
        await teamCall(id, { action: 'message', target: 'reviewer', message: peerPrompt(followup) })
        await waitIdle(agent)
        const updated = ctx.get('agentTeams').listTasks(agent)
        assert.ok(updated.some(task => task.subject === followup && task.status === 'completed'), `${name}: ${phase} peer input was not processed`)
        if (providerSessionId) assert.equal(registry.getSession(child.id).providerSessionId, providerSessionId, `${name}: ${phase} changed provider conversation`)
      }
      const resumedPublication = published.filter(item => item.sessionId === child.id).at(-1)
      assert.notEqual(resumedPublication.caller, previousAgent)
      assert.notEqual(resumedPublication.credential.token, oldCredential.token)
      const beforeInterrupt = ctx.get('agentTeams').listTasks(agent)
      cancellationErrorStart = errors.length
      await teamCall(id, { action: 'message', target: 'reviewer', message: 'Cancellation acceptance test. Read the current Team members, then reply CANCELLATION_READY. Do not change any task or file.' })
      await timeout((async () => { while (ctx.get('agents').get(child.id)?.status !== 'running') await new Promise(resolve => setImmediate(resolve)) })(), 5000, 'The target did not start its cancellation turn')
      const interrupted = await teamCall(id, { action: 'interrupt', target: 'reviewer' })
      assert.equal(interrupted.previousStatus, 'running')
      await waitIdle(agent)
      const afterInterrupt = ctx.get('agentTeams').listTasks(agent)
      for (const task of beforeInterrupt) assert.deepEqual(afterInterrupt.find(item => item.id === task.id), task, 'Interruption changed an existing task')
      lifecycleResult = { idleWake: true, coldResume: true, exactProviderSession: providerSessionId ?? 'native', credentialsRotated: true, interruption: interrupted.previousStatus, existingTasksPreserved: true }
    }
    await ctx.get('sessions').flush(agent.session)
    const outcome = { name, lead, backend, rootId: id, childId: child.id, childStatus: child.status, tasks: tasks.map(task => ({ id: task.id, revision: task.revision, status: task.status })), peerMessages: peers.length, ...(lifecycleResult ? { lifecycle: lifecycleResult } : {}), errors: errors.slice(0, cancellationErrorStart).filter(error => error.sessionId === id || error.sessionId === child.id) }
    assert.equal(outcome.errors.length, 0, JSON.stringify(outcome.errors))
    report.scenarios.push(outcome)
    await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`PASS ${version} ${name}`)
  }
} catch (error) {
  report.failure = { message: error.message, code: error.code }
  console.error(`FAIL ${version}: ${error.message}`)
  throw error
} finally {
  await features.disable('cliAdapters')
  stopProviders(); nativeHolder.setNativeSubagents(undefined); stopCatalog(); stopNative()
  bridgeHolder.setSubagentBridge(undefined)
  await ctx.fiber.dispose()
  await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(`REPORT ${join(run, 'report.json')}`)
