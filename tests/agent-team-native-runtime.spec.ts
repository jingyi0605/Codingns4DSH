import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { DSH_TESTED_VERSION } from '../src/shared/contracts/version.js'
import { DshAgentTeamAdapter } from '../src/dsh-capabilities/host/agent-team-adapter.js'
import { CodingNsTeamDispatcher } from '../src/host/cli-bridge/team-dispatch.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { registerNativeTeamSubagentProviders } from '../src/host/cli-adapters/native-team-subagent.js'
import { setNativeSubagents } from '../src/host/cli-adapters/native-subagent-holder.js'
import { setAdapterRegistry } from '../src/host/cli-adapters/registry-holder.js'

// Read installed Stage0 libraries into memory only. No launcher, profile,
// persistent session, external CLI, build, or application server is used.
for (const version of ['0.2.1-alpha.2', '0.2.1-alpha.3', DSH_TESTED_VERSION]) {
  const packageName = version === DSH_TESTED_VERSION ? '@deepseek-ai/dsh-agent-team' : '@deepseek-ai/dsh-experimental-agent-team'
  const runtimeRoot = join(process.env.CODINGNS_TEAM_RUNTIME_ROOT ?? join(homedir(), '.local/share/codingns/deepseek-harness'), version)
  const directDirectory = join(runtimeRoot, 'node_modules', packageName)
  const pnpmDirectory = join(runtimeRoot, 'node_modules/.pnpm')
  const packageFolder = existsSync(pnpmDirectory)
    ? readdirSync(pnpmDirectory).find(name => name.startsWith(`${packageName.replace('/', '+')}@`))
    : undefined
  const packageDirectory = existsSync(directDirectory) ? directDirectory : join(
    runtimeRoot,
    'node_modules/.pnpm',
    packageFolder ?? '',
    'node_modules',
    packageName,
  )
  const directory = packageDirectory
  const available = existsSync(join(directory, 'lib/types/index.js'))
    && JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version === version
  test(`native DSH ${version} TeamService owns provisioning, task CAS, peer attribution, and interruption`, { skip: !available }, async () => {
    const { TeamService } = await import(pathToFileURL(join(directory, 'lib/types/index.js')).href)
    const ctx = new Context()
    const states = new Map<string, unknown>(); let definition: any
    const sessions = new Map<string, any>(); const agents = new Map<string, any>(); const providers = new Map<string, any>([['spawn', {}]])
    const received: any[] = []; const interruptions: unknown[] = []
    const session = (id: string, parentSession?: string) => {
      const events: any[] = []
      const value = { header: { id, ...(parentSession ? { parentSession } : {}) }, inheritedEventCount: 0,
        snapshotEvents: (from = 0) => events.slice(from),
        append(type: string, data: unknown) {
          const event = { type, data }; events.push(event)
          if (definition) states.set(id, definition.apply(states.get(id) ?? definition.init(value.header), event))
        },
      }
      sessions.set(id, value)
      return value
    }
    const root = { id: 'root', options: {}, status: 'running', session: session('root'), steer: (message: unknown) => received.push(message) }
    agents.set(root.id, root)
    const registry = new CodingNsCliAdapterRegistry([{
      descriptor: { id: 'codex', name: 'Test Codex' },
      detect: async () => ({ installed: true, version: 'test', command: 'fake' }),
    } as never])
    registry.setSession(root.id, { adapterId: 'codex' })
    const subagents = {
      getProvider: (name: string) => providers.get(name),
      registerProvider(provider: any) { providers.set(provider.name, provider); return () => providers.delete(provider.name) },
      async startActivation(spec: any) {
        const childId = spec.childId ?? 'child-1'
        await providers.get(spec.provider)?.prepareContinuable?.({ sessionId: childId, parent: root, signal: spec.signal })
        const childSession = session(childId, root.id)
        childSession.append('user/message', { id: 'initial-input', role: 'user', source: { kind: 'user' }, content: spec.request?.prompt ?? spec.prompt })
        const child = { id: childId, session: childSession, options: {}, status: 'inactive' }
        agents.set(child.id, child)
        ctx.emit('agent/created' as never, { agent: child } as never)
        return { childId: child.id, messageId: 'initial-input' }
      },
      sendMessage(sender: any, targetId: string, content: unknown) {
        if (version !== DSH_TESTED_VERSION) throw new Error('Peer attribution must come from TeamService')
        received.push({ source: { kind: 'agent-message', senderSessionId: sender.id, targetId }, content })
        return Promise.resolve('message-1')
      },
      rootOf: () => root,
      namesOf: (agent: any) => agent.id === root.id ? { self: 'lead' } : { self: 'reviewer', parent: 'lead' },
      resolveName: async (_agent: any, name: string) => name === 'lead' ? root.id : 'child-1',
      listDescendants: async () => [{ kind: 'child', id: 'child-1', activity: 'inactive', path: 'reviewer', parentId: root.id, mode: 'continuable', label: 'Review' }],
      waitForTreeWork: async () => false,
      interrupt(target: string, authority: unknown) { interruptions.push({ target, authority }) },
      async drainChildren() {},
    }
    ctx.provide('agents', { get: (id: string) => agents.get(id), list: () => [...agents.values()] })
    ctx.provide('sessions', { get: (id: string) => sessions.get(id), flush: async () => version === DSH_TESTED_VERSION ? true : undefined })
    ctx.provide('sessionPersistence', {})
    ctx.provide('sessionProjections', {
      register(value: any) {
        definition = value
        if (version === DSH_TESTED_VERSION) {
          return {
            stateOf(sessionValue: any) { return states.get(sessionValue.header.id) ?? definition.init(sessionValue.header) },
            dispose() { definition = undefined },
          }
        }
        return () => { definition = undefined }
      },
      stateOf(value: any) { return states.get(value.header.id) ?? definition.init(value.header) },
    })
    ctx.provide('subagents', subagents)
    setAdapterRegistry(registry); setNativeSubagents(subagents as never)
    const disposeProviders = registerNativeTeamSubagentProviders(subagents as never)
    const fiber = ctx.plugin(TeamService)
    let adapter: DshAgentTeamAdapter | undefined
    try {
      await fiber
      if (version === DSH_TESTED_VERSION) await (ctx.get('agentTeams') as any).setEnabled(root, true)
      adapter = new DshAgentTeamAdapter(ctx.get('agentTeams') as never, ctx.get('agents') as never, undefined, ctx.get('subagents') as never)
      const dispatcher = new CodingNsTeamDispatcher({ adapter: () => adapter, registry, enabled: () => true })
      const spawned = await dispatcher.dispatch('root', { action: 'spawn', agent: 'codex', name: 'reviewer', description: 'Review', prompt: 'Review code' })
      assert.equal(spawned.ok, true, JSON.stringify(spawned))
      const child = version === DSH_TESTED_VERSION ? (spawned.result as any).childId : (spawned.result as any).member.id
      if (version !== DSH_TESTED_VERSION) assert.equal((states.get('root') as any).members[0].phase, 'active')
      assert.equal(dispatcher.identity(child)?.role, 'teammate')
      const created = await dispatcher.dispatch(child, { action: 'task_create', subject: 'Review', description: 'Inspect the change' })
      assert.equal(created.ok, true, JSON.stringify(created))
      const task = created.result as any
      const claim = await dispatcher.dispatch(child, { action: 'task_update', taskId: task.id, expectedRevision: 1, taskAction: 'claim' })
      assert.equal((claim.result as any).status, 'in_progress')
      assert.equal((await dispatcher.dispatch(child, { action: 'task_update', taskId: task.id, expectedRevision: 1, taskAction: 'complete' })).code, 'TEAM_TASK_STALE_REVISION')
      assert.equal((await dispatcher.dispatch(child, { action: 'task_update', taskId: task.id, expectedRevision: 2, taskAction: 'complete' })).ok, true)
      assert.equal((await dispatcher.dispatch(child, { action: 'message', target: 'lead', message: 'Review complete' })).ok, true)
      assert.equal(received[0].source.senderSessionId, child)
      assert.equal(received[0].source.kind, 'agent-message')
      assert.equal((await dispatcher.dispatch(child, { action: 'interrupt', target: 'lead' })).code, 'TEAM_LEAD_REQUIRED')
      assert.equal((await dispatcher.dispatch('root', { action: 'interrupt', target: 'reviewer' })).ok, true)
      assert.deepEqual(interruptions, [{ target: child, authority: { kind: 'ancestor', agent: root } }])
      assert.equal((states.get('root') as any).tasks[0].status, 'completed')
    } finally {
      adapter?.dispose(); await fiber.dispose(); disposeProviders(); setNativeSubagents(undefined); setAdapterRegistry(undefined); await registry.dispose()
    }
  })
}
