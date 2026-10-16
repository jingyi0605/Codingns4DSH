import assert from 'node:assert/strict'
import test from 'node:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import type { spawnSync } from 'node:child_process'
import type { CodingNsCliAdapterDescriptor } from '../src/shared/contracts/cli-adapter.js'
import { CliUpdateCheckService, agentReleaseSource, isNewerAgentVersion } from '../src/host/cli-adapters/update-check.js'
import { detectBinary } from '../src/host/cli-adapters/binary-detection.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { watchAdapterCatalog } from '../src/client/adapter-catalog-watch.js'
import { AGENT_MANAGEMENT_DEFINITIONS } from '../src/host/cli-adapters/management-methods.js'

const adapter = (id = 'codex', version = '1.0.0'): CodingNsCliAdapterDescriptor => ({ id, name: id, version, command: id, installed: true, enabled: true, detectionState: 'ready' })
const json = (version: string) => Response.json({ version })

test('version ordering respects numeric components, prereleases, builds, and Cursor dates', () => {
  for (const [current, latest, expected] of [
    ['1.9.9', '1.10.0', true], ['2.0.0', '1.10.0', false], ['v1.2', '1.2.0', false],
    ['1.0.0-rc.9', '1.0.0-rc.10', true], ['1.0.0-rc.1', '1.0.0', true],
    ['1.0.0-beta', '1.0.0-beta.1', true], ['1.0.0-beta.1', '1.0.0-beta', false],
    ['1.0.0-1', '1.0.0-beta', true], ['1.0.0-beta', '1.0.0-1', false],
    ['1.0.0+abc', '1.0.0+def', false], ['1.0.0', '2.0.0-beta', undefined],
    ['unknown', '1.0.0', undefined], ['1.0.0', '<html>2.0.0</html>', undefined],
    ['1.0.0', '1.0.1-01', undefined], ['1.0.0', '999999999999999999.0.0', undefined],
  ] as const) assert.equal(isNewerAgentVersion(current, latest), expected, `${current} -> ${latest}`)
  assert.equal(isNewerAgentVersion('2026.09.30-aaa', '2026.10.01-bbb', 'cursor-cli'), true)
  assert.equal(isNewerAgentVersion('2026.10.01-aaa', '2026.10.01-bbb', 'cursor-cli'), undefined)
  assert.equal(isNewerAgentVersion('2026.10.01', '2026.10.01-bbb', 'cursor-cli'), false)
  assert.equal(isNewerAgentVersion('2026.10.02', '2026.10.01-bbb', 'cursor-cli'), false)
})

test('binary detection preserves prerelease and build identifiers for release comparisons', async () => {
  for (const version of ['1.2.3-rc.1+abc', '2026.10.14-941492e']) {
    const detected = await detectBinary({ binaries: ['fake'], spawnSync: (() => ({ status: 0, stdout: `fake ${version}`, stderr: '' })) as unknown as typeof spawnSync })
    assert.equal(detected.version, version)
  }
})

test('release sources cover supported CLIs and keep desktop/legacy distributions conservative', () => {
  for (const id of Object.keys(AGENT_MANAGEMENT_DEFINITIONS)) {
    const source = agentReleaseSource(adapter(id, '2.1.0'), 'darwin', 'arm64')
    assert.equal(!!source, !['zcode', 'workbuddy', 'doubao'].includes(id), id)
    if (source) assert.ok(source.url.startsWith('https://'))
  }
  assert.equal(agentReleaseSource(adapter('kimi', '1.9.0'), 'linux', 'x64'), undefined)
  assert.match(agentReleaseSource(adapter('opencode', '1.0.0'), 'linux', 'x64')!.url, /\/opencode-ai\/latest$/u)
  assert.match(agentReleaseSource(adapter('opencode', '2.0.0'), 'linux', 'x64')!.url, /\/@opencode\/cli\/latest$/u)
  assert.match(agentReleaseSource(adapter('antigravity'), 'win32', 'x64')!.url, /windows_amd64\.json$/u)
  assert.equal(agentReleaseSource(adapter('antigravity'), 'linux', 'arm'), undefined)
  assert.equal(agentReleaseSource(adapter('cursor-cli'), 'win32', 'x64')!.read("$downloadUrl = 'https://downloads.cursor.com/lab/2026.10.14-941492e/'"), '2026.10.14-941492e')
  assert.equal(agentReleaseSource(adapter('qoder'), 'linux', 'x64')!.read('{"latest":"1.2.0"}'), '1.2.0')
})

test('ZCode bundled runtimes check the official stable manifest and identify app-managed updates', async context => {
  const installed = { ...adapter('zcode', '3.14.3'), command: '/Applications/ZCode.app/Contents/resources/glm/zcode.cjs' }
  for (const [platform, arch, expected] of [['darwin', 'arm64', 'darwin-aarch64'], ['win32', 'x64', 'windows-x86_64'], ['linux', 'x64', 'linux-x86_64']] as const) {
    const source = agentReleaseSource(installed, platform, arch)!
    assert.equal(source.url, `https://zcode.z.ai/api/v1/releases/electron/manifest?platform=${expected}&channel=1`)
    assert.equal(source.read('version: 3.15.3\nfiles:\n  - url: https://example.test/package'), '3.15.3')
  }
  const service = new CliUpdateCheckService({ platform: 'darwin', arch: 'arm64', fetch: async () => new Response('version: 3.15.3\nfiles: []\n') })
  context.after(() => service.dispose())
  assert.equal(service.refresh([installed])[0]!.update!.state, 'checking')
  await setImmediate()
  const result = service.catalog([installed])[0]!.update!
  assert.equal(result.state, 'available')
  assert.equal(result.latestVersion, '3.15.3')
  assert.equal(result.manualUpdate, true)
  assert.equal(agentReleaseSource(adapter('zcode', '0.1.0'), 'darwin', 'arm64'), undefined, 'an unrelated standalone CLI is not compared to the app')
})

test('unsupported checks explain app ownership, missing versions, legacy releases and invalid metadata', async context => {
  const service = new CliUpdateCheckService({ fetch: async () => assert.fail('No verified feed should be queried') })
  context.after(() => service.dispose())
  for (const [installed, reason] of [
    [adapter('workbuddy'), 'application-managed'], [adapter('doubao'), 'application-managed'],
    [adapter('zcode'), 'no-release-source'], [{ ...adapter(), version: null }, 'unknown-version'],
    [adapter('kimi', '1.9.0'), 'legacy-distribution'],
  ] as const) {
    const result = service.refresh([installed])[0]!.update!
    assert.equal(result.state, 'unavailable')
    assert.equal(result.reason, reason)
    assert.equal(result.failure, undefined)
  }
  const malformed = new CliUpdateCheckService({ fetch: async () => new Response('files: []') })
  context.after(() => malformed.dispose())
  const installed = { ...adapter('zcode', '3.14.0'), command: '/Applications/Zcode.app/Contents/resources/glm/zcode.cjs' }
  malformed.refresh([installed]); await setImmediate()
  assert.equal(malformed.catalog([installed])[0]!.update!.state, 'error')
  assert.equal(malformed.catalog([installed])[0]!.update!.failure, 'invalid-response')
})

test('release checks resolve package and channel identity asynchronously without blocking the list', async context => {
  const ready = Promise.withResolvers<void>()
  const urls: string[] = []
  const commands: Record<string, string> = {
    pi: '/custom/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
    codebuddy: '/home/user/.codebuddy/versions/2.161.1/codebuddy',
    'claude-code': '/opt/homebrew/Caskroom/claude-code/2.1.296/claude',
  }
  const service = new CliUpdateCheckService({ resolveCommand: async command => { await ready.promise; return commands[command]! },
    fetch: async url => { urls.push(String(url)); return String(url).includes('myqcloud.com') ? new Response('2.167.0') : json('2.1.301') },
  })
  context.after(() => service.dispose())
  const catalog = Object.keys(commands).map(id => adapter(id))
  assert.ok(service.refresh(catalog).every(entry => entry.update?.state === 'checking'))
  assert.deepEqual(urls, [])
  assert.equal(service.catalog(catalog).length, 3, 'catalog reads remain available during command resolution')
  ready.resolve(); await setImmediate(); await setImmediate()
  assert.deepEqual(urls.sort(), [
    'https://registry.npmjs.org/@mariozechner/pi-coding-agent/latest',
    'https://acc-1258344699.cos.accelerate.myqcloud.com/@tencent-ai/codebuddy-code/releases/latest',
    'https://formulae.brew.sh/api/cask/claude-code.json',
  ].sort())
  assert.ok(service.catalog(catalog).every(entry => entry.update?.state === 'available'))
  assert.match(agentReleaseSource({ ...adapter('pi', '0.85.1'), command: '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js' }, 'darwin', 'arm64')!.url, /@earendil-works/u)
})

test('Codex standalone and Homebrew checks use the distribution that performs the update', { skip: process.platform === 'win32' }, async context => {
  const command = join(process.env.CODEX_INSTALL_DIR || join(homedir(), '.local/bin'), 'codex')
  const ready = Promise.withResolvers<void>()
  const paths: Record<string, string> = { codex: command, gemini: '/opt/homebrew/Cellar/gemini-cli/0.43.0/libexec/bin/gemini' }
  const urls: string[] = []
  const service = new CliUpdateCheckService({ platform: 'darwin', resolveCommand: async name => { await ready.promise; return paths[name]! },
    fetch: async url => {
      urls.push(String(url))
      return String(url).includes('openai.com') ? Response.json({ tag_name: 'rust-v0.163.0' }) : Response.json({ versions: { stable: '0.64.0' } })
    },
  })
  context.after(() => service.dispose())
  const catalog = [adapter('codex', '0.162.1'), adapter('gemini', '0.43.0')]
  assert.ok(service.refresh(catalog).every(entry => entry.update?.state === 'checking'))
  assert.deepEqual(urls, [], 'installation resolution must not hold the catalog response')
  ready.resolve(); await setImmediate()
  assert.deepEqual(urls.sort(), ['https://releases.openai.com/codex/channels/latest', 'https://formulae.brew.sh/api/formula/gemini-cli.json'].sort())
  assert.deepEqual(service.catalog(catalog).map(entry => entry.update?.latestVersion), ['0.163.0', '0.64.0'])
  assert.ok(service.catalog(catalog).every(entry => entry.update?.state === 'available'))
  const cask = agentReleaseSource({ ...adapter('codex'), command: '/opt/homebrew/Caskroom/codex/0.162.1/codex' }, 'darwin', 'arm64')!
  assert.equal(cask.url, 'https://formulae.brew.sh/api/cask/codex.json')
  assert.equal(cask.read('{"version":"0.163.0"}'), '0.163.0')
  const standalone = agentReleaseSource({ ...adapter('codex'), command }, 'darwin', 'arm64')!
  for (const value of [{ version: '0.163.0' }, { tag_name: 'unrelated-v0.163.0' }, { tag_name: 163 }]) {
    assert.equal(standalone.read(JSON.stringify(value)), undefined, 'only official release tags are comparable')
  }
})

test('refresh returns immediately, limits concurrency, deduplicates work, and catalog reads never fetch', async context => {
  const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = []
  const service = new CliUpdateCheckService({ resolveCommand: async command => command, fetch: async (_url, init) => new Promise(resolve => pending.push({ resolve, signal: init!.signal! })) })
  context.after(() => service.dispose())
  const catalog = ['codex', 'gemini', 'mcode', 'command-code', 'opencode'].map(id => adapter(id))
  assert.equal(service.catalog(catalog)[0]?.update?.state, 'unchecked')
  assert.equal(pending.length, 0)
  const initial = service.refresh(catalog)
  assert.ok(initial.every(entry => entry.update?.state === 'checking'))
  await setImmediate()
  assert.equal(pending.length, 3)
  service.refresh(catalog); service.catalog(catalog)
  assert.equal(pending.length, 3)
  pending.slice(0, 3).forEach(request => request.resolve(json('1.1.0')))
  await setImmediate()
  assert.equal(pending.length, 5)
  pending.slice(3).forEach(request => request.resolve(json('1.1.0')))
  await setImmediate()
  assert.ok(service.catalog(catalog).every(entry => entry.update?.state === 'available' && entry.update.checkedAt))
  assert.ok(initial.every(entry => entry.update?.state === 'checking'), 'returned snapshots must not mutate')
  assert.equal(service.catalog([adapter('codex', '1.1.0')])[0]?.update?.state, 'unchecked', 'installation changes invalidate the result')
  service.refresh(catalog, 'codex')
  await setImmediate()
  assert.equal(pending.length, 6, 'manual refresh retries only the selected Agent')
  pending[5]!.resolve(json('1.0.0')); await setImmediate()
  assert.equal(service.catalog(catalog)[0]?.update?.state, 'current')
})

test('missing, failed and unknown installations never start release work; stale results are ignored', async context => {
  const releases: ((response: Response) => void)[] = []
  const service = new CliUpdateCheckService({ resolveCommand: async command => command, fetch: async () => new Promise(resolve => releases.push(resolve)) })
  context.after(() => service.dispose())
  const absent = { ...adapter(), installed: false, command: null, version: null }
  const failed = { ...adapter(), detectionFailure: 'launch' as const }
  service.refresh([absent, failed, { ...adapter(), detectionState: 'running' }])
  assert.equal(releases.length, 0)
  const unknown = { ...adapter(), version: null }
  assert.equal(service.refresh([unknown])[0]?.update?.state, 'unavailable')
  assert.equal(releases.length, 0)
  service.refresh([adapter()])
  service.refresh([adapter('codex', '2.0.0')])
  await setImmediate()
  releases[1]!(json('2.0.0')); await setImmediate()
  releases[0]!(json('99.0.0')); await setImmediate()
  assert.equal(service.catalog([adapter('codex', '2.0.0')])[0]?.update?.state, 'current')
  service.refresh([absent])
  assert.equal(service.catalog([absent])[0]?.update, undefined)
})

test('HTTP, invalid metadata, oversized responses and timeouts never imply an update', async context => {
  for (const [response, state, failure] of [
    [new Response('offline', { status: 503 }), 'error', 'http'],
    [new Response('not json'), 'error', 'invalid-response'],
    [Response.json(null), 'error', 'invalid-response'],
    [Response.json({ version: 'unknown' }), 'error', 'invalid-response'],
    [Response.json({}), 'error', 'invalid-response'],
    [json('0.9.0'), 'current', undefined],
    [new Response('x'.repeat(512 * 1024 + 1)), 'error', 'invalid-response'],
  ] as const) {
    const service = new CliUpdateCheckService({ resolveCommand: async command => command, fetch: async () => response })
    context.after(() => service.dispose())
    service.refresh([adapter()]); await setImmediate()
    assert.equal(service.catalog([adapter()])[0]?.update?.state, state)
    assert.equal(service.catalog([adapter()])[0]?.update?.failure, failure)
    if (failure === 'http') assert.equal(service.catalog([adapter()])[0]?.update?.httpStatus, 503)
  }
  let signal: AbortSignal | undefined
  const service = new CliUpdateCheckService({ resolveCommand: async command => command, timeoutMs: 10, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    signal = init!.signal!
    signal.addEventListener('abort', () => reject(signal!.reason), { once: true })
  }) })
  context.after(() => service.dispose())
  service.refresh([adapter()]); await delay(30)
  assert.equal(signal?.aborted, true)
  assert.equal(service.catalog([adapter()])[0]?.update?.state, 'error')
  assert.equal(service.catalog([adapter()])[0]?.update?.failure, 'timeout')
})

test('disposal aborts active requests and discards queued checks', async () => {
  const signals: AbortSignal[] = []
  const service = new CliUpdateCheckService({ resolveCommand: async command => command, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!
    signals.push(signal)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  const catalog = ['codex', 'gemini', 'mcode', 'codebuddy'].map(id => adapter(id))
  service.refresh(catalog)
  await setImmediate(); service.dispose(); await setImmediate()
  assert.equal(signals.length, 3)
  assert.ok(signals.every(signal => signal.aborted))
  service.refresh(catalog)
  assert.equal(signals.length, 3)
  assert.equal(service.catalog(catalog)[0]?.update?.state, 'unchecked')
})

test('feature refresh starts background checks without delaying RPC or Agent use', async context => {
  let release!: (value: Response) => void, requests = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn() { yield { type: 'finish' as const, reason: 'stop' as const } },
  }])
  const rpc = new CodingNsRpcTable()
  const features = new FeatureRegistry({ rpc })
  features.register(createCliAdaptersFeature({ registry, updateCheck: { resolveCommand: async command => command, fetch: async () => { requests++; return new Promise(resolve => { release = resolve }) } } }))
  await features.start('cliAdapters')
  context.after(() => features.disable('cliAdapters'))
  const call = async (endpoint: string, input = {}): Promise<readonly CodingNsCliAdapterDescriptor[]> => {
    const target = rpc.resolve(`cli/${endpoint}`)!
    return await target.handler(target.action, input) as readonly CodingNsCliAdapterDescriptor[]
  }
  await call('catalog'); await call('catalog/refresh')
  assert.equal(requests, 0, 'passive and legacy callers do not start network requests')
  const refreshed = await call('catalog/refresh', { adapterId: 'codex', checkUpdates: true })
  assert.equal(refreshed[0]?.update?.state, 'checking')
  assert.equal(requests, 1)
  assert.equal((await registry.models('codex')).groups.length, 0, 'release checks do not take the maintenance lock')
  assert.equal((await call('catalog'))[0]?.update?.state, 'checking')
  release(json('1.1.0')); await setImmediate()
  assert.equal((await call('catalog'))[0]?.update?.state, 'available')
})

test('catalog watcher follows a pending release check, stops when settled, and cleans up', async () => {
  let requests = 0
  const values: string[] = []
  const stop = watchAdapterCatalog({ call: async () => ({ ok: true, value: [{ ...adapter(), update: { state: ++requests === 1 ? 'checking' : 'current' } }] }) }, undefined,
    catalog => values.push(catalog[0]!.update!.state))
  try {
    await delay(1_100)
    assert.deepEqual(values, ['checking', 'current'])
    await delay(1_050)
    assert.equal(requests, 2)
  } finally { stop() }
})
