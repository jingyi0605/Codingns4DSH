import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createSessionCompactionAdapter } from '../src/dsh-capabilities/host/session-compaction-adapter.js'
import { DSH_TESTED_VERSION } from '../src/shared/contracts/version.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'

const runtime = process.env.CODINGNS_STAGE0_RUNTIME_DIR
  ?? join(homedir(), `.local/share/codingns/deepseek-harness/${DSH_TESTED_VERSION}/node_modules/@deepseek-ai`)
const commandsPackage = join(runtime, 'dsh-commands')
const available = existsSync(join(commandsPackage, 'lib/index.js'))

test('native compaction capability requires both command scoping and the agent registry', () => {
  const services = { commands: { find() {}, register() {} }, agents: { list: () => [] } }
  const context = { get: (name: keyof typeof services) => services[name], on() {} }
  for (const version of ['0.2.1-alpha.3', '0.2.1-rc.4']) {
    assert.equal(createDshCapabilityRegistry(version, 'host', context).getProfile(context).capabilities.get('session.external-compaction')?.status, 'unavailable')
  }
  for (const version of ['0.2.1-rc.5', '0.2.2-rc.1', '0.3.0']) {
    assert.equal(createDshCapabilityRegistry(version, 'host', context).getProfile(context).capabilities.get('session.external-compaction')?.status, 'ready')
  }
  assert.equal(createDshCapabilityRegistry('0.2.2-rc.1', 'host', {}).getProfile({}).capabilities.get('session.external-compaction')?.status, 'unavailable')
})

// Uses the installed Stage0 libraries in memory. Does not start a server or CLI,
// access a user profile, or mutate any persisted conversation.
test('real DSH command runtime scopes /compact, preserves lifecycle logging and restores native fallback', { skip: !available }, async () => {
  const requireRuntime = createRequire(join(commandsPackage, 'package.json'))
  const [{ Context }, { CommandRuntime }, { createScope }] = await Promise.all([
    import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(join(commandsPackage, 'lib/index.js')).href),
    import(pathToFileURL(join(runtime, 'dsh-scope/lib/index.js')).href),
  ])
  const ctx = new Context()
  const events: { type: string; data: unknown }[] = []
  const agent = {
    id: 'external-compaction-test', ctx,
    session: {
      id: 'external-compaction-test', header: { cwd: process.cwd() },
      append(type: string, data: unknown) { events.push({ type, data }); return { seq: events.length, type, data } },
    },
    async runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>) { return job(new AbortController().signal) },
  }
  ctx.provide('agents', { list: () => [agent] })
  const commands = new CommandRuntime(ctx)
  const agentScope = createScope(ctx, agent)
  agent.ctx = agentScope.ctx
  const global = ctx.inject(['commands'], scope => {
    scope.get('commands').register({ name: 'compact', description: 'Compact older conversation history', handler: () => ({ kind: 'success', text: 'DSH fallback' }) })
  })
  await new Promise(resolve => setImmediate(resolve))
  let external = true
  let calls = 0
  const dispose = createSessionCompactionAdapter(ctx).install({
    supports: () => external,
    compact: async () => { calls++; return { kind: 'success', text: 'provider compacted' } },
    error: kind => ({ kind: 'error', text: kind }),
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    const result = await commands.execute(agent, '/compact', [], new AbortController().signal)
    assert.equal(result?.result.text, 'provider compacted')
    assert.equal(calls, 1)
    assert.deepEqual(events.map(event => event.type), ['command/run', 'command/done'])
    assert.equal(commands.list(agent).filter((entry: { name: string }) => entry.name === 'compact').length, 1)
    external = false
    assert.equal((await commands.execute(agent, '/compact', [], new AbortController().signal))?.result.text, 'DSH fallback')
    external = true
    await dispose()
    assert.equal((await commands.execute(agent, '/compact', [], new AbortController().signal))?.result.text, 'DSH fallback')
    const compacted: string[] = []
    let failCompaction = false
    const registry = new CodingNsCliAdapterRegistry([{
      descriptor: { id: 'codex', name: 'Codex' },
      async detect() { return { installed: true, version: '1', command: 'codex' } },
      async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
      async *executeTurn() { throw new Error('A compact command must not start a user turn') },
      async compact(input) {
        if (failCompaction) throw new Error('Native provider failed')
        compacted.push(input.providerSessionId!)
        return { compacted: true }
      },
    }])
    registry.setSession(agent.id, { adapterId: 'codex' })
    let preference = 'en'
    const features = new FeatureRegistry({
      rpc: new CodingNsRpcTable(), dshContext: ctx, dshVersion: '0.2.1-rc.5',
      settingsProvider: { describe: () => [{ ns: 'locale', value: { preference }, revision: 0 }] },
    })
    features.register(createCliAdaptersFeature({ registry }))
    await features.start('cliAdapters')
    try {
      await new Promise(resolve => setImmediate(resolve))
      const empty = await commands.execute(agent, '/compact', [], new AbortController().signal)
      assert.match(empty?.result.text, /no provider conversation/)
      assert.deepEqual(compacted, [])
      registry.setSession(agent.id, { adapterId: 'codex', providerSessionId: 'original-codex-thread' })
      const result = await commands.execute(agent, '/compact', [], new AbortController().signal)
      assert.equal(result?.result.kind, 'success')
      assert.match(result?.result.text, /native context compacted/)
      assert.deepEqual(compacted, ['original-codex-thread'])
      preference = 'zh'
      failCompaction = true
      const failed = await commands.execute(agent, '/compact', [], new AbortController().signal)
      assert.equal(failed?.result.kind, 'error')
      assert.match(failed?.result.text, /原生上下文压缩未正常完成/)
      failCompaction = false
      assert.equal((await commands.execute(agent, '/compact', [], new AbortController().signal))?.result.kind, 'success')
    } finally { await features.disable('cliAdapters') }
    assert.equal((await commands.execute(agent, '/compact', [], new AbortController().signal))?.result.text, 'DSH fallback')
  } finally {
    await dispose()
    await global.dispose()
    await agentScope.dispose()
    await ctx.fiber.dispose()
  }
})
