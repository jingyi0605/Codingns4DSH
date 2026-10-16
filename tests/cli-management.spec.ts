import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { CliManagementService } from '../src/host/cli-adapters/management.js'
import { codexStandaloneDirectory, resolveManagementInstallation } from '../src/host/cli-adapters/management-installation.js'
import { managementMethods, automaticUpdateMethod, AGENT_MANAGEMENT_DEFINITIONS } from '../src/host/cli-adapters/management-methods.js'
import { managementOutput, runManagementCommand } from '../src/host/cli-adapters/management-process.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { isPeerHostHttpRoute } from '../src/shared/peer-host-http-routes.js'
import type { CodingNsCliAdapterDescriptor, CodingNsCliDetection } from '../src/shared/contracts/cli-adapter.js'
import type { CliManagementPlan } from '../src/shared/contracts/cli-management.js'

const descriptor = (id = 'codex', installed = false): CodingNsCliAdapterDescriptor => ({ id, name: id, installed, enabled: true, command: installed ? `/tools/${id}` : null, version: installed ? '1.0.0' : null, detectionState: 'ready' })

function fixture() {
  let detection: CodingNsCliDetection = { installed: false, version: null, command: null }
  let detectionCount = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { detectionCount += 1; return detection },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish', reason: 'stop' } as const },
  }])
  return { registry, get detectionCount() { return detectionCount }, setDetection(value: CodingNsCliDetection) { detection = value }, install() { detection = { installed: true, command: '/tools/codex', version: '2.0.0' } } }
}
const request = (plan: CliManagementPlan, methodId = 'npm') => ({ adapterId: plan.adapter.id, action: plan.action, fingerprint: plan.fingerprint, methodId })
async function settled(service: CliManagementService) {
  for (let i = 0; i < 100; i++) {
    await setImmediate()
    if (service.status()?.state !== 'running') { await setImmediate(); return service.status()! }
  }
  throw new Error('Management operation did not settle')
}

test('all 18 adapters have platform-aware official plans; application runtimes stay manual', () => {
  assert.equal(Object.keys(AGENT_MANAGEMENT_DEFINITIONS).length, 18)
  for (const id of Object.keys(AGENT_MANAGEMENT_DEFINITIONS)) {
    for (const platform of ['darwin', 'linux', 'win32', 'freebsd'] as const) {
      for (const action of ['install', 'update'] as const) {
        const plan = managementMethods(descriptor(id, action === 'update'), action, platform, 'x64')
        assert.match(plan.sourceUrl, /^https:\/\//u)
        assert.ok(plan.methods.length > 0)
        assert.equal(new Set(plan.methods.map(m => m.id)).size, plan.methods.length)
        if (['zcode', 'workbuddy', 'doubao'].includes(id) || platform === 'freebsd') assert.ok(plan.methods.every(m => !m.executable))
        for (const method of plan.methods) assert.equal(method.executable, method.invocation !== undefined)
      }
    }
  }
  assert.ok(managementMethods(descriptor('qoder'), 'install', 'win32', 'arm64').methods.every(m => !m.executable))
  const cn = managementMethods(descriptor('qoder-cn'), 'install', 'linux', 'x64').methods[0]!
  assert.match(cn.command!, /static\.qoder\.com\.cn/u)
  const windows = managementMethods(descriptor('claude-code'), 'install', 'win32', 'x64').methods[0]!
  assert.equal(windows.invocation?.file, 'powershell.exe')
  assert.match(windows.command!, /install\.ps1/u)
  const bundled = managementMethods({ ...descriptor('codex', true), command: '/Applications/Codex.app/Contents/Resources/codex' }, 'update', 'darwin', 'arm64')
  assert.ok(bundled.methods.every(m => !m.executable))
  const bash = managementMethods(descriptor('claude-code'), 'install', 'linux', 'x64').methods[0]!
  assert.deepEqual(bash.invocation?.args.slice(0, 3), ['-o', 'pipefail', '-c'])
  assert.ok(!managementMethods(descriptor('codex'), 'install', 'linux', 'x64').methods.some(m => m.id === 'brew'))
})

test('preview is read-only; execution uses only the reviewed method and re-detects', async t => {
  const f = fixture()
  const commands: unknown[] = []
  const service = new CliManagementService(f.registry, { run: async (command, _signal, output) => { commands.push(command); output('Installed\n'); f.install(); return 0 } })
  t.after(async () => { await service.dispose(); await f.registry.dispose() })
  const plan = await service.plan('codex', 'install')
  assert.deepEqual(commands, [])
  assert.ok(plan.methods.every(m => !('invocation' in m)))
  const before = f.detectionCount
  assert.equal(service.start({ ...request(plan), command: 'rm -rf /', args: ['malicious'] }).state, 'running')
  const result = await settled(service)
  assert.equal(result.state, 'succeeded')
  assert.equal(result.adapter?.version, '2.0.0')
  assert.equal(result.adapter?.enabled, true)
  assert.equal(f.detectionCount, before + 2)
  assert.deepEqual(commands, [{ file: 'npm', args: ['install', '-g', '@openai/codex@latest'] }])
  assert.equal(result.output, 'Installed\n')
})

test('automatic updates preserve package ownership and never guess migrations or unknown methods', () => {
  for (const [id, command, version, expected] of [
    ['command-code', '/usr/local/lib/node_modules/command-code/cli.js', '1.82.3', 'native'],
    ['codex', '/custom/node/lib/node_modules/@openai/codex/bin/codex.js', '0.162.1', 'npm'],
    ['gemini', '/opt/homebrew/Cellar/gemini-cli/0.43.0/libexec/bin/gemini', '0.43.0', 'brew'],
    ['claude-code', '/opt/homebrew/Caskroom/claude-code/2.1.0/claude', '2.1.0', 'brew'],
    ['claude-code', '/opt/homebrew/Caskroom/claude-code@latest/2.1.0/claude', '2.1.0', 'brew'],
    ['claude-code', '/custom/node/lib/node_modules/@anthropic-ai/claude-code/cli.js', '2.1.0', 'native'],
    ['claude-code', 'claude', '2.1.296', 'native'],
    ['claude-code', '/home/user/.pnpm/global/node_modules/@anthropic-ai/claude-code/cli.js', '2.1.296', 'native'],
    ['claude-code', '/home/user/.local/share/claude/versions/2.1.0', '2.1.0', 'native'],
    ['pi', '/custom/node/lib/node_modules/@mariozechner/pi-coding-agent/bin/pi', '0.72.0', 'npm'],
    ['pi', '/custom/node/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', '0.85.1', 'npm'],
    ['kimi', '/home/user/.local/bin/kimi', '1.9.0', undefined],
    ['codex', '/Applications/Codex.app/Contents/Resources/codex', '0.162.1', undefined],
    ['codex', '/custom/codex', '0.162.1', undefined],
  ] as const) {
    const adapter = { ...descriptor(id, true), command, version }
    const { methods } = managementMethods(adapter, 'update', 'darwin', 'arm64')
    assert.equal(automaticUpdateMethod(adapter, methods, 'darwin'), expected, command)
    if (expected === 'npm') assert.deepEqual(methods.find(method => method.id === 'npm')!.invocation?.args.slice(-2), ['--prefix', '/custom/node'])
    if (id === 'pi' && expected === 'npm') assert.match(methods.find(method => method.id === 'npm')!.invocation!.args[2]!, command.includes('@mariozechner') ? /^@mariozechner\//u : /^@earendil-works\//u)
    if (expected === 'brew') assert.equal(methods.find(method => method.id === 'brew')!.invocation?.file, '/opt/homebrew/bin/brew')
    if (command.includes('claude-code@latest')) assert.deepEqual(methods.find(method => method.id === 'brew')!.invocation?.args, ['upgrade', '--cask', 'claude-code@latest'])
  }
})

test('standalone Codex updates use the official unattended installer in the detected directory', { skip: process.platform === 'win32' }, async context => {
  const directory = process.env.CODEX_INSTALL_DIR || join(homedir(), '.local', 'bin')
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  let installed = { ...descriptor('codex', true), command: join(directory, 'codex'), version: '0.162.1' }
  const { methods } = managementMethods(installed, 'update', 'darwin', 'arm64')
  assert.equal(automaticUpdateMethod(installed, methods, 'darwin'), 'installer')
  const invocation = methods.find(method => method.id === 'installer')!.invocation!
  assert.equal(invocation.file, 'bash')
  assert.deepEqual(invocation.args.slice(-2), ['codingns-codex-update', directory])
  assert.match(invocation.args[3]!, /CODEX_NON_INTERACTIVE=1/u)
  assert.match(invocation.args[3]!, /CODEX_INSTALL_DIR="\$1" sh -s -- --release latest$/u)
  const custom = '/tools/space and $(untrusted)/bin'
  assert.equal(codexStandaloneDirectory(`${custom}/codex`, 'linux', { CODEX_INSTALL_DIR: custom }), custom)
  assert.equal(codexStandaloneDirectory(join(home, 'packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex'), 'darwin'), directory)
  assert.equal(codexStandaloneDirectory('/unknown/codex', 'linux', {}), undefined)
  assert.equal(codexStandaloneDirectory(join(directory, 'codex'), 'win32'), undefined)
  assert.equal(codexStandaloneDirectory(join(home, 'packages/standalone/releases/../elsewhere/codex'), 'darwin'), undefined)
  const commands: unknown[] = []
  const service = new CliManagementService({ refreshCatalog: async () => [installed], beginMaintenance: () => () => {} }, {
    platform: 'darwin', resolveCommand: async command => command,
    run: async command => { commands.push(command); installed = { ...installed, version: '0.163.0' }; return 0 },
  })
  context.after(() => service.dispose())
  const plan = await service.plan('codex', 'update')
  assert.equal(plan.automaticMethodId, 'installer')
  assert.deepEqual(commands, [], 'planning must not execute an installer')
  service.start(request(plan, 'installer'))
  assert.equal((await settled(service)).state, 'succeeded')
  assert.equal(service.status()?.adapter?.version, '0.163.0')
  assert.equal(commands.length, 1)
})

test('Codex versioned packages retain the active standalone launcher after resolving symlinks', { skip: process.platform === 'win32' }, async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codingns-standalone-')))
  context.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'bin'), home = join(root, 'data')
  const binary = join(home, 'packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex')
  const launcher = join(directory, 'codex')
  await mkdir(join(binary, '..'), { recursive: true }); await mkdir(directory)
  await writeFile(binary, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  await symlink(binary, launcher)
  const environment = { CODEX_INSTALL_DIR: directory, CODEX_HOME: home }
  assert.equal(await resolveManagementInstallation(launcher, '@openai/codex', environment), launcher)
  assert.equal(await resolveManagementInstallation(binary, '@openai/codex', environment), launcher)
  assert.equal(await resolveManagementInstallation(binary, '@openai/codex', { ...environment, CODEX_INSTALL_DIR: join(root, 'other') }), binary,
    'an unrelated install directory must not replace the active launcher')
  const installed = { ...descriptor('codex', true), command: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex') }
  const { methods } = managementMethods(installed, 'update', 'darwin', 'arm64')
  assert.equal(automaticUpdateMethod(installed, methods, 'darwin'), undefined, 'updating requires the matching launcher, not an inactive release binary')
})

test('npm ownership includes Homebrew Node prefixes and Windows global paths, but excludes other managers', () => {
  for (const [command, platform, prefix] of [
    ['/opt/homebrew/Cellar/node/24.0.0/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'darwin', '/opt/homebrew/Cellar/node/24.0.0'],
    ['C:\\Users\\User\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', 'win32', 'C:/Users/User/AppData/Roaming/npm'],
    ['/home/user/.pnpm/global/5/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'linux', undefined],
    ['/home/user/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js', 'linux', undefined],
    ['/home/user/project/node_modules/@anthropic-ai/claude-code/cli.js', 'linux', undefined],
    ['/opt/homebrew/Cellar/unknown/1/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'darwin', undefined],
  ] as const) {
    const adapter = { ...descriptor('codex', true), command: command.replaceAll('@anthropic-ai/claude-code', '@openai/codex').replaceAll('@anthropic-ai\\claude-code', '@openai\\codex') }
    const { methods } = managementMethods(adapter, 'update', platform, 'x64')
    assert.equal(automaticUpdateMethod(adapter, methods, platform), prefix === undefined ? undefined : 'npm', command)
    if (prefix) assert.deepEqual(methods.find(method => method.id === 'npm')!.invocation?.args.slice(-2), ['--prefix', prefix])
  }
})

test('package metadata retains the npm owner across native-binary symlinks and rejects unrelated metadata', { skip: process.platform === 'win32' }, async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codingns-management-')))
  context.after(() => rm(root, { recursive: true, force: true }))
  const packageName = '@anthropic-ai/claude-code'
  const packageRoot = join(root, 'lib/node_modules', packageName)
  const binary = join(root, 'lib/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude')
  const entry = join(packageRoot, 'cli.js')
  const launcher = join(root, 'bin/claude')
  await mkdir(packageRoot, { recursive: true })
  await mkdir(join(binary, '..'), { recursive: true })
  await mkdir(join(root, 'bin'))
  await writeFile(binary, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  await chmod(binary, 0o755)
  await symlink(binary, entry)
  await symlink(entry, launcher)
  const metadata = { name: packageName, bin: { claude: './cli.js' } }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(metadata))
  assert.equal(await resolveManagementInstallation(launcher, packageName), entry)
  assert.equal(await resolveManagementInstallation(binary, packageName), entry)
  let detected = { ...descriptor('claude-code', true), command: launcher }
  const commands: unknown[] = []
  const service = new CliManagementService({ refreshCatalog: async () => [detected], beginMaintenance: () => () => {} }, {
    run: async command => { commands.push(command); detected = { ...detected, version: '2.0.0' }; return 0 },
  })
  context.after(() => service.dispose())
  const plan = await service.plan('claude-code', 'update')
  assert.equal(plan.automaticMethodId, 'native')
  service.start(request(plan, 'native'))
  assert.equal((await settled(service)).state, 'succeeded')
  assert.deepEqual(commands, [{ file: entry, args: ['update'] }])
  for (const invalid of [{ ...metadata, name: 'unrelated' }, { ...metadata, bin: { claude: '../../@anthropic-ai/claude-code-darwin-arm64/claude' } }, { ...metadata, bin: { claude: 'missing.js' } }]) {
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(invalid))
    assert.equal(await resolveManagementInstallation(launcher, packageName), binary)
  }
})

test('updates reject client-selected methods that do not match the detected owner', async context => {
  const f = fixture(); f.install()
  let path = '/custom/lib/node_modules/@openai/codex/bin/codex.js'
  const service = new CliManagementService(f.registry, { resolveCommand: async () => path, run: async () => assert.fail('Must not launch a different updater') })
  context.after(async () => { await service.dispose(); await f.registry.dispose() })
  service.start(request(await service.plan('codex', 'update'), 'installer'))
  assert.match((await settled(service)).error!, /automatic updater/u)
  path = '/unknown/codex'
  service.start(request(await service.plan('codex', 'update'), 'npm'))
  assert.match((await settled(service)).error!, /automatic updater/u)
})

test('Host resolves the installed command and revalidates ownership before an automatic update', async context => {
  const f = fixture(); f.install()
  let path = '/one/lib/node_modules/@openai/codex/bin/codex.js'
  const commands: unknown[] = []
  const service = new CliManagementService(f.registry, { platform: 'linux', resolveCommand: async () => path,
    run: async command => { commands.push(command); f.setDetection({ installed: true, command: '/tools/codex', version: '3.0.0' }); return 0 },
  })
  context.after(async () => { await service.dispose(); await f.registry.dispose() })
  const plan = await service.plan('codex', 'update')
  assert.equal(plan.automaticMethodId, 'npm')
  assert.deepEqual(commands, [], 'planning never executes the updater')
  path = '/two/lib/node_modules/@openai/codex/bin/codex.js'
  service.start(request(plan))
  assert.equal((await settled(service)).state, 'failed')
  assert.deepEqual(commands, [])
  service.start(request(await service.plan('codex', 'update')))
  assert.equal((await settled(service)).state, 'succeeded')
  assert.deepEqual(commands, [{ file: 'npm', args: ['install', '-g', '@openai/codex@latest', '--prefix', '/two'] }])
})

test('CodeBuddy npm upgrades use the checked registry and unchanged versions cannot report success', async context => {
  let detected = { ...descriptor('codebuddy', true), command: '/custom/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy', version: '2.161.1' }
  let upgrade = false
  const commands: unknown[] = []
  const service = new CliManagementService({ refreshCatalog: async () => [detected], beginMaintenance: () => () => {} }, {
    resolveCommand: async command => command,
    run: async (command, _signal, output) => {
      commands.push(command)
      output(upgrade ? 'Updated' : 'CodeBuddy Code is up to date (2.161.1)')
      if (upgrade) detected = { ...detected, version: '2.168.0' }
      return 0
    },
  })
  context.after(() => service.dispose())
  const plan = await service.plan('codebuddy', 'update')
  assert.equal(plan.automaticMethodId, 'npm')
  service.start(request(plan))
  const unchanged = await settled(service)
  assert.equal(unchanged.state, 'failed')
  assert.match(unchanged.error!, /did not advance.*2\.161\.1/u)
  assert.equal(unchanged.adapter?.version, '2.161.1')
  assert.deepEqual(commands, [{ file: 'npm', args: ['install', '-g', '@tencent-ai/codebuddy-code@latest', '--registry=https://registry.npmjs.org/', '--prefix', '/custom'] }])
  upgrade = true
  service.start(request(await service.plan('codebuddy', 'update')))
  assert.equal((await settled(service)).state, 'succeeded')
  assert.equal(service.status()?.adapter?.version, '2.168.0')
})

test('stale plans, invalid actions and manual methods never launch a process', async t => {
  const f = fixture()
  const service = new CliManagementService(f.registry, { run: async () => { assert.fail('Must not launch') } })
  t.after(async () => { await service.dispose(); await f.registry.dispose() })
  assert.throws(() => service.start({ action: 'delete', adapterId: 'codex' }), /install or update/u)
  await assert.rejects(service.plan('unknown', 'install'))
  const plan = await service.plan('codex', 'install')
  for (const input of [{ ...request(plan), fingerprint: 'stale' }, request(plan, 'manual'), request(plan, 'npm; echo injected')]) {
    service.start(input)
    assert.equal((await settled(service)).state, 'failed')
  }
  f.install()
  service.start(request(plan))
  assert.match((await settled(service)).error!, /state changed/u)
})

test('detection failures do not become missing installations, and launch errors release the lock', async t => {
  const f = fixture()
  const service = new CliManagementService(f.registry, { run: async () => { throw new Error('npm is unavailable') } })
  t.after(async () => { await service.dispose(); await f.registry.dispose() })
  f.setDetection({ installed: false, command: null, version: null, detectionFailure: 'launch' })
  await assert.rejects(service.plan('codex', 'install'), /Re-detect/u)
  f.setDetection({ installed: false, command: null, version: null })
  service.start(request(await service.plan('codex', 'install')))
  assert.match((await settled(service)).error!, /npm is unavailable/u)
  f.registry.beginMaintenance('codex')()
})

test('an operation stays running until post-command detection finishes', async () => {
  let count = 0
  let verify!: () => void
  let held = false
  const registry = {
    async refreshCatalog() {
      if (++count === 3) await new Promise<void>(resolve => { verify = resolve })
      return [descriptor('codex', count >= 3)]
    },
    beginMaintenance() { held = true; return () => { held = false } },
  }
  const service = new CliManagementService(registry, { run: async () => 42 })
  try {
    const plan = await service.plan('codex', 'install')
    service.start(request(plan))
    await setImmediate()
    assert.equal(service.status()?.state, 'running')
    assert.equal(held, true)
    assert.throws(() => service.start(request(plan)), /already running/u)
    verify()
    const result = await settled(service)
    assert.equal(result.state, 'failed')
    assert.equal(result.adapter?.installed, true)
    assert.equal(held, false)
  } finally { verify?.(); await service.dispose() }
})

test('duplicate starts, active turns and native subagents cannot race an update', { timeout: 5_000 }, async t => {
  const f = fixture(); f.install()
  let complete!: () => void
  const started = Promise.withResolvers<void>()
  const service = new CliManagementService(f.registry, { resolveCommand: async () => '/custom/lib/node_modules/@openai/codex/bin/codex.js', run: async () => { await new Promise<void>(resolve => { complete = resolve; started.resolve() }); f.setDetection({ installed: true, command: '/tools/codex', version: '3.0.0' }); return 0 } })
  t.after(async () => { complete?.(); await service.dispose(); await f.registry.dispose() })
  const plan = await service.plan('codex', 'update')
  service.start(request(plan))
  assert.throws(() => service.start(request(plan)), /already running/u)
  await assert.rejects(f.registry.execute({ adapterId: 'codex', sessionId: 'ordinary', prompt: '', messages: [] }).next(), /being installed or updated/u)
  await assert.rejects(f.registry.runSubagentTurn({ adapterId: 'codex', sessionId: 'native', prompt: '', messages: [] }).next(), /already busy/u)
  await started.promise; complete()
  assert.equal((await settled(service)).state, 'succeeded')
  const turn = f.registry.runSubagentTurn({ adapterId: 'codex', sessionId: 'native', prompt: '', messages: [] })
  await turn.next()
  assert.throws(() => service.start(request(plan)), /active tasks/u)
  await turn.return(undefined)
  const regular = f.registry.execute({ adapterId: 'codex', sessionId: 'ordinary', prompt: '', messages: [] })
  await regular.next()
  assert.throws(() => f.registry.beginMaintenance('codex'), /active tasks/u)
  await regular.return(undefined)
})

test('failed commands and unverified zero exits remain failures, with bounded redacted output', async t => {
  for (const code of [0, 23, null]) {
    const f = fixture()
    const service = new CliManagementService(f.registry, { run: async (_command, _signal, output) => {
      output('x'.repeat(40_000)); output('\u001b[31m token='); output('private-value\n'); return code
    } })
    t.after(async () => { await service.dispose(); await f.registry.dispose() })
    service.start(request(await service.plan('codex', 'install')))
    const result = await settled(service)
    assert.equal(result.state, 'failed')
    assert.match(result.error!, code === 0 ? /could not be verified/u : /exited/u)
    assert.ok(result.output.length <= 32_768)
    assert.ok(!result.output.includes('private-value'))
    assert.ok(!result.output.includes('\u001b'))
  }
  assert.equal(managementOutput('https://user:password@example.test token=secret'), 'https://[redacted]@example.test token=[redacted]')
})

test('cancellation, timeout and disposal terminate the runner and release the lock', async t => {
  for (const mode of ['cancel', 'timeout', 'dispose'] as const) {
    const f = fixture()
    let aborted = false
    const service = new CliManagementService(f.registry, { timeoutMs: mode === 'timeout' ? 20 : 10_000, run: async (_command, signal) => {
      await new Promise<void>(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }) })
      return null
    } })
    t.after(async () => { await service.dispose(); await f.registry.dispose() })
    const operation = service.start(request(await service.plan('codex', 'install')))
    await setImmediate()
    assert.throws(() => service.cancel('wrong-id'), /no longer current/u)
    if (mode === 'cancel') service.cancel(operation.id)
    else if (mode === 'dispose') await service.dispose()
    else await delay(35)
    const result = await settled(service)
    assert.equal(aborted, true)
    assert.equal(result.state, mode === 'timeout' ? 'failed' : 'cancelled')
    f.registry.beginMaintenance('codex')()
  }
})

test('RPC wiring and peer transport keep installation management local', async t => {
  const f = fixture()
  const table = new CodingNsRpcTable()
  const features = new FeatureRegistry({ rpc: table })
  features.register(createCliAdaptersFeature({ registry: f.registry }))
  await features.start('cliAdapters')
  t.after(() => features.disable('cliAdapters'))
  const rpc = table.resolve('cli/management/plan')!
  await assert.rejects(Promise.resolve(rpc.handler(rpc.action, { adapterId: 'codex', action: 'install' })), /local Host/u)
  const plan = await rpc.handler(rpc.action, { catalogHostId: 'local', adapterId: 'codex', action: 'install' }) as CliManagementPlan
  assert.equal(plan.adapter.id, 'codex')
  for (const action of ['plan', 'start', 'status', 'cancel']) assert.equal(isPeerHostHttpRoute('POST', `/api/codingns/cli/management/${action}`), false)
  assert.equal(isPeerHostHttpRoute('POST', '/api/codingns/cli/catalog/refresh'), true)
})

test('process runner supports output and cancellation without running an Agent or installer', async () => {
  const output: string[] = []
  const status = await runManagementCommand({ file: process.execPath, args: ['-e', 'process.stdout.write("controlled fixture"); process.exitCode = 7'] }, new AbortController().signal, text => output.push(text))
  assert.equal(status, 7)
  assert.equal(output.join(''), 'controlled fixture')
  const controller = new AbortController()
  const pending = runManagementCommand({ file: process.execPath, args: ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'] }, controller.signal, () => controller.abort())
  assert.equal(await pending, null)
})
