import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import semver from 'semver'
import { Context } from '@deepseek-ai/cordis'
import { CODINGNS_VERSION } from '../src/shared/contracts/version.js'
import {
  CODINGNS_PACKAGE_NAME, compareSemver, evaluateDshCompatibility, isSemver, validatePluginUpdateChannel,
  type PluginUpdateCheckResult, type PluginUpdateStatusResult,
} from '../src/shared/contracts/plugin-update.js'
import { PluginUpdateMetadata, pluginUpdateCheckState } from '../src/host/update/metadata.js'
import { readPluginRelease, safeReleaseText } from '../src/host/update/release-notes.js'
import { readUpdateJson } from '../src/host/update/http.js'
import { PluginUpdateService } from '../src/host/update/service.js'
import { derivePluginUpdateApplication } from '../src/host/update/application-result.js'
import { createPluginUpdateManager, normalizePluginManagerOutcome } from '../src/dsh-capabilities/host/plugin-update-adapter.js'
import { pluginClientReloadStatus } from '../src/dsh-capabilities/client/plugin-reload-adapter.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createPluginUpdateFeature } from '../src/host/features/plugin-update.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createCodingNsRpcHandler, isLocalUpdateRequest } from '../src/host/rpc.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { PluginUpdateStore } from '../src/client/update-store.js'
import { PluginUpdatePanel } from '../src/client/update-panel.js'
import { CodingNsSettingsUpdate, hasNewerPluginVersion } from '../src/client/settings-update.js'
import { settingsModules } from '../src/client/features/index.js'
import { pluginUpdateFeature } from '../src/client/features/plugin-update.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import * as dictionary from '../src/client/locales/pluginUpdate.js'

const version = '0.2.2-rc.10'
const commit = 'a'.repeat(40)
const signal = () => new AbortController().signal
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { resolve, promise }
}

function createUpdatePanel(services: any) {
  const store = new PluginUpdateStore(services.rpc)
  const panel = createHookRenderer(PluginUpdatePanel, { enabled: true, services, store })
  void store.loadRuntime()
  void store.recover()
  return { render: panel.render, dispose() { panel.dispose(); store.dispose() } }
}

function registry(overrides: Record<string, unknown> = {}) {
  const manifest = { name: CODINGNS_PACKAGE_NAME, version, gitHead: commit, engines: { dsh: '>=0.2.0-rc.2 <=0.2.1-rc.2' } }
  return {
    name: CODINGNS_PACKAGE_NAME, 'dist-tags': { latest: '0.2.0-rc.3', next: version },
    versions: { [version]: manifest, '0.2.0-rc.3': { ...manifest, version: '0.2.0-rc.3' } },
    time: { [version]: '2026-10-25T00:00:00Z' }, ...overrides,
  }
}

function metadataFetch(metadata = registry()): typeof fetch {
  return async (url, init) => {
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.credentials, 'omit')
    const path = String(url)
    if (path.startsWith('https://registry.npmjs.org/')) return Response.json(metadata)
    if (path.includes('/git/ref/tags/')) {
      const tag = decodeURIComponent(path.split('/').at(-1)!)
      return Response.json({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: commit } })
    }
    if (path.includes('/releases/tags/')) {
      const tag = decodeURIComponent(path.split('/').at(-1)!)
      return Response.json({ tag_name: tag, name: tag, published_at: '2026-10-25T00:00:00Z', body: '<script>alert(1)</script>\nFix #1' })
    }
    throw new Error(`Unexpected metadata request ${path}`)
  }
}

function nativeContext(overrides: Record<string, unknown> = {}) {
  const calls: unknown[] = []
  return {
    calls, profileContext: { name: 'web' },
    pluginManager: {
      async listBundles() { return [{ name: CODINGNS_PACKAGE_NAME, version: CODINGNS_VERSION, installed: true, enabled: true, availability: 'profile' }] },
      async installBundle(...args: unknown[]) {
        calls.push(args)
        return { application: 'restart-required', changed: true, stage: 'enable', bundle: CODINGNS_PACKAGE_NAME, version }
      },
      async cancelInstall() { return { status: 'too-late' as const } },
    },
    ...overrides,
  }
}

function serviceFixture(context = nativeContext(), request = metadataFetch()) {
  let now = Date.parse('2026-10-25T12:00:00Z')
  const metadata = new PluginUpdateMetadata('0.2.1-rc.2', request)
  const service = new PluginUpdateService(metadata, () => createPluginUpdateManager(context), () => now)
  return { service, context, advance() { now += 6 * 60_000 } }
}

test('updater compares semver, channels and bounded exact targets without lexical or downgrade errors', () => {
  assert.ok(compareSemver('0.2.1-rc.10', '0.2.1-rc.9') > 0)
  assert.ok(compareSemver('0.2.1', '0.2.1-rc.10') > 0)
  assert.equal(compareSemver('0.2.1+one', '0.2.1+two'), 0)
  for (const invalid of ['-x', '0.1', '1.0.0-01', '9007199254740993.0.0', '1.0.0;echo hi']) assert.equal(isSemver(invalid), false)
  assert.throws(() => validatePluginUpdateChannel({ kind: 'exact', version: 'latest' }))
  assert.throws(() => validatePluginUpdateChannel({ kind: 'arbitrary' }))
  assert.deepEqual(validatePluginUpdateChannel({ kind: 'next', registry: 'https://bad.test' }), { kind: 'next' })
})

test('compatibility never borrows the running plugin range for a target with no declaration', () => {
  assert.equal(evaluateDshCompatibility(undefined, '0.2.1-rc.2').state, 'unknown')
  assert.equal(evaluateDshCompatibility('^0.2.0', '0.3.0').state, 'incompatible')
  assert.equal(evaluateDshCompatibility('^0.0.3', '0.0.4').state, 'incompatible')
  assert.equal(evaluateDshCompatibility('>=0.2.0-rc.2 <=0.2.1-rc.2', '0.2.1-rc.2').state, 'compatible')
  assert.equal(evaluateDshCompatibility('1.x', '0.2.1-rc.2').state, 'unknown')
  assert.equal(evaluateDshCompatibility('>=0.2.0-rc.2', 'bad').state, 'unknown')
  for (const range of ['^0.0.3', '^0.2.0', '^1.2.3', '~0.2.1-rc.1', '>=0.2.0-rc.2 <=0.2.1-rc.2', '<0.2.1', '=0.2.1', '^0.2.0 || >=1.2.3']) {
    for (const dsh of ['0.0.3', '0.0.4-alpha.1', '0.2.0', '0.2.1-rc.2', '0.2.1', '0.3.0-alpha.1', '1.2.3', '2.0.0-alpha.1']) {
      assert.equal(evaluateDshCompatibility(range, dsh).state === 'compatible', semver.satisfies(dsh, range, { includePrerelease: true }), `${range}: ${dsh}`)
    }
  }
})

test('metadata coalesces concurrent reads and keeps latest, next and exact targets separate', async () => {
  let calls = 0
  const request = metadataFetch()
  const metadata = new PluginUpdateMetadata('0.2.1-rc.2', async (...args) => { calls++; return request(...args) })
  try {
    const first = metadata.read({ kind: 'next' })
    assert.equal(metadata.read({ kind: 'next' }), first)
    const target = await first
    assert.equal(calls, 3)
    assert.equal(target.version, version)
    assert.equal(target.release.commit, commit)
    assert.deepEqual(target.distTags, ['next'])
    assert.equal(target.publishedAt, '2026-10-25T00:00:00.000Z')
    assert.equal(pluginUpdateCheckState(target, [CODINGNS_VERSION]), 'update-available')
    const latest = await metadata.read({ kind: 'latest' })
    assert.equal(pluginUpdateCheckState(latest, [CODINGNS_VERSION]), 'no-newer-version')
    assert.equal((await metadata.read({ kind: 'exact', version })).version, version)
  } finally { metadata.dispose() }
})

test('metadata validates package identity, dist-tags, all DSH peer constraints and missing requirements', async () => {
  for (const manifest of [
    { name: CODINGNS_PACKAGE_NAME, version, engines: { dsh: '>=0.2.0-rc.2' }, peerDependencies: { '@deepseek-ai/dsh-client-connection': '<0.2.1-rc.1' } },
    { name: CODINGNS_PACKAGE_NAME, version },
    { name: CODINGNS_PACKAGE_NAME, version, engines: { dsh: '>=0.2.0-rc.2' }, peerDependencies: { '@deepseek-ai/dsh': '1.x' } },
  ]) {
    const metadata = new PluginUpdateMetadata('0.2.1-rc.2', metadataFetch(registry({ versions: { [version]: manifest } })))
    const target = await metadata.read({ kind: 'next' })
    assert.equal(target.compatibility.state, 'peerDependencies' in manifest && manifest.peerDependencies?.['@deepseek-ai/dsh-client-connection'] ? 'incompatible' : 'unknown')
    metadata.dispose()
  }
  for (const overrides of [{ name: 'wrong' }, { 'dist-tags': {} }, { versions: { [version]: { name: 'wrong', version } } }]) {
    const metadata = new PluginUpdateMetadata('0.2.1-rc.2', metadataFetch(registry(overrides)))
    await assert.rejects(metadata.read({ kind: 'next' }))
    metadata.dispose()
  }
})

test('exact GitHub lookup refuses mismatches, reports missing tags and does not substitute a branch', async () => {
  const paths: string[] = []
  const request: typeof fetch = async url => {
    paths.push(String(url))
    return Response.json({ ref: `refs/tags/v${version}`, object: { type: 'commit', sha: 'b'.repeat(40) } })
  }
  const mismatch = await readPluginRelease(version, commit, request, signal())
  assert.equal(mismatch.reason, 'UPDATE_COMMIT_MISMATCH')
  assert.equal(mismatch.body, '')
  assert.equal(paths.length, 1)
  const missing = await readPluginRelease(version, null, async () => new Response('', { status: 404 }), signal())
  assert.equal(missing.state, 'missing')
  assert.equal(missing.tag, `v${version}`)
  const notesMissing = await readPluginRelease(version, null, async url => String(url).includes('/releases/')
    ? new Response('', { status: 404 }) : request(url), signal())
  assert.equal(notesMissing.commit, 'b'.repeat(40))
  assert.equal(notesMissing.state, 'missing')
})

test('annotated tags are dereferenced by SHA and rate limits never discard npm target metadata', async () => {
  let count = 0
  const annotated: typeof fetch = async url => {
    count++
    if (String(url).includes('/git/ref/')) return Response.json({ ref: `refs/tags/v${version}`, object: { type: 'tag', sha: 'b'.repeat(40), url: 'https://bad.test' } })
    if (String(url).includes('/git/tags/')) return Response.json({ object: { type: 'commit', sha: commit } })
    return Response.json({ tag_name: `v${version}`, body: 'x'.repeat(100_000), name: 'release' })
  }
  const release = await readPluginRelease(version, commit, annotated, signal())
  assert.equal(count, 3)
  assert.equal(release.body.length, 32_768)
  assert.equal(safeReleaseText('\u0000<script>x</script>', 100), '<script>x</script>')
  const request = metadataFetch()
  const metadata = new PluginUpdateMetadata('0.2.1-rc.2', (url, init) => String(url).includes('api.github.com')
    ? Promise.resolve(new Response('', { status: 429 })) : request(url, init))
  assert.equal((await metadata.read({ kind: 'next' })).release.state, 'unavailable')
  metadata.dispose()
})

test('HTTP metadata rejects redirects, unapproved origins, oversized bodies and malformed JSON', async () => {
  let calls = 0
  const request: typeof fetch = async () => { calls++; return new Response('garbage') }
  await assert.rejects(readUpdateJson('https://private.test/', request, signal()))
  assert.equal(calls, 0)
  await assert.rejects(readUpdateJson('https://api.github.com/repos/x', request, signal()))
  await assert.rejects(readUpdateJson('https://api.github.com/repos/x', async () => new Response('12345'), signal(), 4))
  await assert.rejects(readUpdateJson('https://api.github.com/repos/x', async () => new Response('', { status: 302 }), signal()))
})

test('manager routes explain unavailable old and missing contexts and preserve the exact supported signature', async () => {
  const context = nativeContext()
  for (const dsh of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2', '0.2.0-rc.2']) {
    const profile = createDshCapabilityRegistry(dsh, 'host', context).getProfile(context)
    assert.equal(profile.capabilities.get('plugin.update.apply')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some(item => item.capability === 'plugin.update.apply'))
  }
  assert.equal(createDshCapabilityRegistry('0.2.1-rc.2', 'host', {}).getProfile({}).capabilities.get('plugin.update.apply')?.status, 'unavailable')
  const adapter = createDshCapabilityRegistry('0.2.1-rc.2', 'host', context).getProfile(context).capabilities.get('plugin.update.apply')
  assert.equal(adapter?.status, 'ready')
  const manager = createPluginUpdateManager(context)
  const result = await manager.install(version, 'operation-id')
  assert.equal(result.packageAccepted, true)
  assert.deepEqual(context.calls, [[`${CODINGNS_PACKAGE_NAME}@${version}`, {
    enabled: true, saveExact: true, registry: 'https://registry.npmjs.org', requestId: 'operation-id',
  }]])
  const client = createDshCapabilityRegistry('0.2.1-rc.2', 'client', { modules: { version: 'client' } }).getProfile({})
  assert.equal(client.capabilities.get('plugin.client.reload-status')?.status, 'unavailable')
  assert.equal(pluginClientReloadStatus().state, 'unsupported')
})

test('Cordis service probes work without injecting pluginManager into the main Host assembly', async () => {
  const app = new Context()
  const fixture = nativeContext()
  const fiber = await app.plugin(ctx => { ctx.provide('pluginManager', fixture.pluginManager); ctx.provide('profileContext', fixture.profileContext) })
  try {
    const capability = createDshCapabilityRegistry('0.2.1-rc.2', 'host', app).getProfile(app).capabilities.get('plugin.update.apply')
    assert.equal(capability?.status, 'ready')
    assert.equal((await createPluginUpdateManager(app).installed()).version, CODINGNS_VERSION)
  } finally { await fiber.dispose() }
})

test('manager refuses Desktop, packaged shells, absent profiles and HMR self-replacement without invoking installation', async () => {
  for (const overrides of [
    { profileContext: { name: 'desktop' } }, { profileContext: { name: 'custom', packageManager: {} } },
    { profileContext: undefined }, { hmr: {} },
  ]) {
    const context = nativeContext(overrides)
    const manager = createPluginUpdateManager(context)
    assert.ok((await manager.installed()).blockCode)
    await assert.rejects(manager.install(version, 'id'))
    assert.equal(context.calls.length, 0)
  }
  const failure = normalizePluginManagerOutcome({
    application: 'failed', changed: false, stage: 'install', error: { code: 'incompatible-version', diagnostic: '/secret/path token' },
    packageResult: { output: 'secret', logPath: '/secret/log' },
  }, version)
  assert.equal(failure.restored, true)
  assert.equal(JSON.stringify(failure).includes('secret'), false)
  assert.equal(normalizePluginManagerOutcome({ application: 'failed', stage: 'install', changed: false, packageResult: {}, error: { code: 'operation-error' } }, version).restored, false)
  assert.equal(normalizePluginManagerOutcome({ application: 'applied', version: 'wrong', bundle: CODINGNS_PACKAGE_NAME }, version).packageAccepted, false)
  const unknownVersion = nativeContext()
  unknownVersion.pluginManager.listBundles = async () => [{ name: CODINGNS_PACKAGE_NAME, version: 'unreadable', installed: true, enabled: true, availability: 'profile' }]
  await assert.rejects(createPluginUpdateManager(unknownVersion).install(version, 'id'), /UPDATE_INSTALLED_VERSION_UNKNOWN/)
  assert.equal(unknownVersion.calls.length, 0)
})

test('owner and local network provenance are independent, with no payload override', async () => {
  const owner = { principal: { kind: 'owner' } }
  const connection = { browserPeer: owner }
  const rpc = new CodingNsRpcTable()
  const resources: Array<() => unknown> = []
  createPluginUpdateFeature().start({
    services: { rpc, dshContext: { connection }, dshVersion: '0.2.1-rc.2' },
    resources: { add: (dispose: () => unknown) => resources.push(dispose) },
  } as never)
  const handler = createCodingNsRpcHandler(rpc, { connection })
  try {
    for (const peer of [undefined, { principal: { kind: 'session' } }, { principal: { kind: 'owner' }, authorized: false }]) {
      const result = await handler('update/apply', { localRequest: true, confirmation: true }, signal(), peer, true)
      assert.equal(result.ok, false)
      assert.equal(!result.ok && result.error.code, 'UPDATE_FORBIDDEN')
    }
    const remote = await handler('update/apply', { localRequest: true, confirmation: true }, signal(), owner)
    assert.equal(!remote.ok && remote.error.code, 'UPDATE_LOCAL_OWNER_REQUIRED')
    const local = await handler('update/apply', {}, signal(), owner, true)
    assert.equal(!local.ok && local.error.code, 'UPDATE_CONFIRMATION_REQUIRED')
    const request = (address: string, origin: string | undefined, headers = {}) => ({
      socket: { remoteAddress: address }, headers: { host: 'localhost:3080', origin, ...headers },
    }) as never
    assert.equal(isLocalUpdateRequest(request('127.0.0.1', 'http://localhost:3080')), true)
    assert.equal(isLocalUpdateRequest(request('192.168.1.2', 'http://localhost:3080')), false)
    assert.equal(isLocalUpdateRequest(request('127.0.0.1', 'https://remote.test')), false)
    assert.equal(isLocalUpdateRequest(request('127.0.0.1', undefined)), false)
    assert.equal(isLocalUpdateRequest(request('127.0.0.1', 'http://localhost:3080', { 'sec-fetch-site': 'cross-site' })), false)
  } finally { for (const dispose of resources.reverse()) await dispose() }
})

test('service checks compatibility and recent confirmation before mutation and never claims Client activation', async () => {
  const f = serviceFixture()
  try {
    const check = await f.service.check({ channel: { kind: 'next' }, clientVersion: CODINGNS_VERSION }, true)
    assert.equal(check.canApply, true)
    await assert.rejects(f.service.apply({ version, confirmation: false }))
    await assert.rejects(f.service.apply({ version, confirmation: true, checkedAt: 'stale' }))
    const operation = await f.service.apply({ version, confirmation: true, checkedAt: check.checkedAt })
    assert.equal(operation.state, 'applying')
    await tick()
    const status = f.service.status({ operationId: operation.operationId })!
    assert.equal(status.result?.packageState, 'installed')
    assert.equal(status.result?.application, 'restart-required')
    assert.equal(status.result?.hostActivation.version, CODINGNS_VERSION)
    assert.equal(status.result?.clientReload.state, 'unsupported')
    await assert.rejects(f.service.apply({ version, confirmation: true, checkedAt: check.checkedAt }))
  } finally { f.service.dispose() }
  const stale = serviceFixture()
  const check = await stale.service.check({ channel: { kind: 'next' } }, true)
  stale.advance()
  await assert.rejects(stale.service.apply({ version, confirmation: true, checkedAt: check.checkedAt }))
  stale.service.dispose()
})

test('incompatible and remote checks never authorize a package write', async () => {
  const f = serviceFixture()
  const check = await f.service.check({ channel: { kind: 'next' } }, false)
  assert.equal(check.canApply, false)
  await assert.rejects(f.service.apply({ version, confirmation: true, checkedAt: check.checkedAt }))
  assert.equal(f.context.calls.length, 0)
  f.service.dispose()
  const bad = serviceFixture(nativeContext(), metadataFetch(registry({ versions: {
    [version]: { name: CODINGNS_PACKAGE_NAME, version, engines: { dsh: '<0.2.0-rc.2' } },
  } })))
  assert.equal((await bad.service.check({ channel: { kind: 'next' } }, true)).canApply, false)
  assert.equal(bad.context.calls.length, 0)
  bad.service.dispose()
})

test('apply revalidates the manifest and preserves native compatibility refusal without exposing diagnostics', async () => {
  const payload = registry()
  const f = serviceFixture(nativeContext(), metadataFetch(payload))
  try {
    const check = await f.service.check({ channel: { kind: 'next' } }, true)
    payload.versions[version].engines.dsh = '<0.2.0-rc.2'
    await assert.rejects(f.service.apply({ version, confirmation: true, checkedAt: check.checkedAt }), /UPDATE_INCOMPATIBLE_DSH/)
    assert.equal(f.context.calls.length, 0)
  } finally { f.service.dispose() }
  const native = nativeContext()
  native.pluginManager.installBundle = async () => ({
    application: 'failed', changed: false, stage: 'install', packageResult: { exitCode: 1, output: 'secret-token', logPath: '/secret/path' },
    error: { code: 'incompatible-version', diagnostic: 'secret-token' },
  }) as never
  const refused = serviceFixture(native)
  try {
    const check = await refused.service.check({ channel: { kind: 'next' } }, true)
    await refused.service.apply({ version, confirmation: true, checkedAt: check.checkedAt })
    await tick()
    const result = refused.service.status({})!.result!
    assert.equal(result.application, 'failed')
    assert.equal(result.errorCode, 'UPDATE_MANAGER_INCOMPATIBLE_VERSION')
    assert.equal(JSON.stringify(result).includes('secret'), false)
  } finally { refused.service.dispose() }
})

test('service serializes duplicates, accepts only matching progress and waits for official cancellation', async () => {
  const completion = deferred<unknown>()
  const context = nativeContext()
  context.pluginManager.installBundle = async () => completion.promise as never
  context.pluginManager.cancelInstall = async () => {
    completion.resolve({ application: 'cancelled', stage: 'install', changed: false, packageResult: { exitCode: 1 } })
    return { status: 'cancelled' as never }
  }
  const f = serviceFixture(context)
  try {
    const check = await f.service.check({ channel: { kind: 'next' } }, true)
    const input = { version, confirmation: true, checkedAt: check.checkedAt }
    const starting = f.service.apply(input)
    await assert.rejects(f.service.apply(input), /UPDATE_CONFLICT/)
    const operation = await starting
    assert.doesNotThrow(() => f.service.progress(null))
    f.service.progress({ requestId: 'stale', phase: 'applying' })
    assert.equal(f.service.status({})?.phase, 'installing')
    f.service.progress({ requestId: operation.operationId, phase: 'installing' })
    assert.ok(f.service.status({})!.revision > operation.revision)
    await f.service.cancel({ operationId: operation.operationId })
    await tick()
    const result = f.service.status({})!.result!
    assert.equal(result.application, 'cancelled')
    assert.equal(result.packageState, 'rolled-back')
  } finally { completion.resolve(null); f.service.dispose() }
})

test('manager progress revisions increase and late installation events cannot reopen cancellation', async () => {
  const completion = deferred<unknown>()
  const context = nativeContext()
  context.pluginManager.installBundle = async () => completion.promise as never
  const f = serviceFixture(context)
  try {
    const check = await f.service.check({ channel: { kind: 'next' } }, true)
    const operation = await f.service.apply({ version, confirmation: true, checkedAt: check.checkedAt })
    f.service.progress({ requestId: operation.operationId, phase: 'applying' })
    const applying = f.service.status({})!
    assert.ok(applying.revision > operation.revision)
    assert.equal(applying.cancellationAvailable, false)
    f.service.progress({ requestId: operation.operationId, phase: 'installing' })
    assert.equal(f.service.status({}), applying)
    await assert.rejects(f.service.cancel({ operationId: operation.operationId }), /UPDATE_CANCELLATION_UNSUPPORTED/)
    completion.resolve({ application: 'restart-required', bundle: CODINGNS_PACKAGE_NAME, version })
    await tick()
    assert.ok(f.service.status({})!.revision > applying.revision)
  } finally { completion.resolve(null); f.service.dispose() }
})

test('a failed cancellation cannot undo newer manager activation progress', async () => {
  const completion = deferred<unknown>()
  const cancelReply = deferred<void>()
  const context = nativeContext()
  context.pluginManager.installBundle = async () => completion.promise as never
  context.pluginManager.cancelInstall = async () => { await cancelReply.promise; throw new Error('Fixture cancellation failure') }
  const f = serviceFixture(context)
  try {
    const check = await f.service.check({ channel: { kind: 'next' } }, true)
    const operation = await f.service.apply({ version, confirmation: true, checkedAt: check.checkedAt })
    const cancellation = f.service.cancel({ operationId: operation.operationId })
    f.service.progress({ requestId: operation.operationId, phase: 'applying' })
    const applying = f.service.status({})!
    cancelReply.resolve()
    await assert.rejects(cancellation, /UPDATE_CANCEL_FAILED/)
    assert.equal(f.service.status({}), applying)
    assert.equal(applying.phase, 'applying')
    assert.equal(applying.cancellationAvailable, false)
  } finally { cancelReply.resolve(); completion.resolve(null); f.service.dispose() }
})

test('activation truth table requires both independent active target versions', () => {
  const states = ['not-requested', 'pending', 'active', 'restart-required', 'unsupported', 'failed', 'unknown'] as const
  for (const pkg of ['unchanged', 'installed', 'rolled-back', 'unknown'] as const) {
    for (const host of states) for (const client of states) {
      const result = derivePluginUpdateApplication(version, pkg, { state: host, version }, { state: client, version })
      assert.equal(result === 'applied-without-desktop-restart', pkg === 'installed' && host === 'active' && client === 'active')
    }
  }
  assert.notEqual(derivePluginUpdateApplication(version, 'installed', { state: 'active', version: CODINGNS_VERSION }, { state: 'active', version }), 'applied-without-desktop-restart')
})

test('Client store discards stale responses, preserves the previous result after failure and aborts on disposal', async () => {
  const old = deferred<any>()
  const current = deferred<any>()
  const signals: AbortSignal[] = []
  let count = 0
  const store = new PluginUpdateStore({ async call(_channel, _method, _input, callSignal) {
    count++; signals.push(callSignal!)
    return count === 1 ? old.promise : count === 2 ? current.promise : { ok: false, error: { code: 'UPDATE_METADATA_UNAVAILABLE', message: 'raw output' } }
  } })
  const first = store.check({ kind: 'latest' })
  assert.equal(store.check({ kind: 'latest' }), first)
  const second = store.check({ kind: 'next' })
  const result = { target: { version }, canApply: true } as PluginUpdateCheckResult
  current.resolve({ ok: true, value: result })
  await second
  old.resolve({ ok: true, value: { target: { version: '0.0.1' } } })
  await first
  assert.equal(store.getSnapshot().check, result)
  await store.check({ kind: 'next' })
  assert.equal(store.getSnapshot().check, result)
  assert.equal(store.getSnapshot().current, false)
  assert.equal(store.getSnapshot().error, 'UPDATE_METADATA_UNAVAILABLE')
  const stable = store.getSnapshot()
  assert.equal(store.getSnapshot(), stable)
  store.dispose()
  assert.ok(signals.every(item => item.aborted))
})

test('lost apply response recovers by Host operation id without a mutation retry', async () => {
  const calls: string[] = []
  const check = { canApply: true, target: { version }, checkedAt: 'now' } as PluginUpdateCheckResult
  const operation: PluginUpdateStatusResult = { operationId: 'one', revision: 1, targetVersion: version, state: 'applying', phase: 'installing', cancellationAvailable: false }
  const store = new PluginUpdateStore({ async call(_channel, endpoint) {
    calls.push(endpoint)
    if (endpoint === 'update/check') return { ok: true, value: check }
    if (endpoint === 'update/apply') throw new Error('Connection lost')
    return { ok: true, value: operation }
  } })
  try {
    await store.check({ kind: 'next' })
    await store.apply(check)
    assert.deepEqual(calls, ['update/check', 'update/apply', 'update/status'])
    assert.equal(store.getSnapshot().operation?.operationId, 'one')
    store.setVisible(false)
  } finally { store.dispose() }
})

test('late runtime and recovery reads cannot overwrite a newer check or apply operation', async () => {
  const oldRuntime = deferred<any>()
  const oldStatus = deferred<any>()
  const check = { canApply: true, target: { version }, installedVersion: CODINGNS_VERSION, checkedAt: 'now' } as PluginUpdateCheckResult
  const operation: PluginUpdateStatusResult = { operationId: 'new', revision: 1, targetVersion: version, state: 'applying', phase: 'installing', cancellationAvailable: false }
  const store = new PluginUpdateStore({ async call(_channel, endpoint) {
    if (endpoint === 'update/runtime') return oldRuntime.promise
    if (endpoint === 'update/status') return oldStatus.promise
    return { ok: true, value: endpoint === 'update/check' ? check : operation }
  } })
  try {
    const runtime = store.loadRuntime()
    const recovery = store.recover()
    await store.check({ kind: 'next' })
    await store.apply(check)
    oldRuntime.resolve({ ok: true, value: { installedVersion: '0.0.1' } })
    oldStatus.resolve({ ok: true, value: { ...operation, operationId: 'old' } })
    await Promise.all([runtime, recovery])
    assert.equal(store.getSnapshot().runtime?.installedVersion, CODINGNS_VERSION)
    assert.equal(store.getSnapshot().operation?.operationId, 'new')
  } finally { store.dispose() }
})

test('panel runtime inspection and unsupported diagnostics remain available when npm is offline', async () => {
  let calls = 0
  const f = serviceFixture(nativeContext({ profileContext: { name: 'desktop' } }), async () => { calls++; throw new Error('offline') })
  try {
    const runtime = await f.service.runtime(true)
    assert.equal(runtime.installedVersion, CODINGNS_VERSION)
    assert.equal(calls, 0)
    await assert.rejects(f.service.check({ channel: { kind: 'next' } }, true))
    assert.equal((await f.service.runtime(true)).runningHostVersion, CODINGNS_VERSION)
    const panel = createUpdatePanel({
      locale: { subscribe: () => () => undefined, getSnapshot: () => ({ revision: 0 }), bind: () => (key: string) => dictionary.en[key] ?? key },
      rpc: { async call(_channel: string, endpoint: string) {
        return endpoint === 'update/check' ? { ok: false, error: { code: 'UPDATE_METADATA_UNAVAILABLE' } }
          : { ok: true, value: endpoint === 'update/runtime' ? runtime : null }
      } },
    })
    try {
      panel.render()
      await tick()
      const diagnostic = () => JSON.stringify(panel.render()).includes('UPDATE_DESKTOP_UNSUPPORTED')
      assert.equal(diagnostic(), true)
      elements(panel.render()).find(item => item.type === 'button' && item.props.children === 'Check for updates').props.onClick()
      await tick()
      assert.equal(diagnostic(), true)
      assert.ok(elements(panel.render()).some(item => item.props.role === 'alert'))
    } finally { panel.dispose() }
  } finally { f.service.dispose() }
})

test('recovery during apply cannot start an old status read', async () => {
  const pendingApply = deferred<any>()
  const check = { canApply: true, target: { version }, checkedAt: 'now' } as PluginUpdateCheckResult
  const operation: PluginUpdateStatusResult = { operationId: 'new', revision: 1, targetVersion: version, state: 'applying', phase: 'installing', cancellationAvailable: false }
  let reads = 0
  const store = new PluginUpdateStore({ async call(_channel, endpoint) {
    if (endpoint === 'update/check') return { ok: true, value: check }
    if (endpoint === 'update/apply') return pendingApply.promise
    reads++
    return { ok: true, value: null }
  } })
  try {
    await store.check({ kind: 'next' })
    const apply = store.apply(check)
    await store.recover()
    assert.equal(reads, 0)
    pendingApply.resolve({ ok: true, value: operation })
    await apply
    assert.equal(store.getSnapshot().operation?.operationId, 'new')
  } finally { store.dispose() }
})

test('late cancellation results and errors cannot replace another recovered operation', async () => {
  for (const failed of [false, true]) {
    const cancellation = deferred<any>()
    let operation: PluginUpdateStatusResult = { operationId: 'old', revision: 1, targetVersion: version, state: 'applying', phase: 'installing', cancellationAvailable: true }
    const store = new PluginUpdateStore({ async call(_channel, endpoint) {
      return endpoint === 'update/cancel' ? cancellation.promise : { ok: true, value: operation }
    } })
    try {
      await store.recover()
      const cancel = store.cancel()
      operation = { ...operation, operationId: 'new' }
      await store.recover()
      cancellation.resolve(failed ? { ok: false, error: { code: 'UPDATE_CANCEL_FAILED' } }
        : { ok: true, value: { ...operation, operationId: 'old', revision: 5 } })
      await cancel
      assert.equal(store.getSnapshot().operation?.operationId, 'new')
      assert.equal(store.getSnapshot().error, null)
    } finally { store.dispose() }
  }
})

test('old polling revisions cannot regress confirmed cancellation progress', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const pendingStatus = deferred<any>()
  const operation: PluginUpdateStatusResult = { operationId: 'one', revision: 1, targetVersion: version, state: 'applying', phase: 'installing', cancellationAvailable: true }
  let reads = 0
  const store = new PluginUpdateStore({ async call(_channel, endpoint) {
    if (endpoint === 'update/cancel') return { ok: true, value: { ...operation, revision: 2, phase: 'cancelling', cancellationAvailable: false } }
    return ++reads === 1 ? { ok: true, value: operation } : pendingStatus.promise
  } })
  try {
    await store.recover()
    context.mock.timers.tick(1000)
    await tick()
    await store.cancel()
    pendingStatus.resolve({ ok: true, value: operation })
    await tick()
    assert.equal(store.getSnapshot().operation?.phase, 'cancelling')
    assert.equal(store.getSnapshot().operation?.cancellationAvailable, false)
    assert.equal(store.getSnapshot().operation?.revision, 2)
  } finally { store.dispose(); context.mock.timers.reset() }
})

test('successful recovery of an unchanged revision clears transient polling errors', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const operation: PluginUpdateStatusResult = { operationId: 'one', revision: 1, targetVersion: version, state: 'applying', phase: 'installing', cancellationAvailable: true }
  let reads = 0
  const store = new PluginUpdateStore({ async call() {
    if (++reads === 2) throw new Error('Fixture disconnect')
    return { ok: true, value: operation }
  } })
  try {
    await store.recover()
    context.mock.timers.tick(1000)
    await tick()
    assert.equal(store.getSnapshot().error, 'UPDATE_REQUEST_FAILED')
    await store.recover()
    assert.equal(store.getSnapshot().error, null)
    context.mock.timers.tick(1000)
    await tick()
    assert.equal(reads, 4)
  } finally { store.dispose(); context.mock.timers.reset() }
})

test('status polling is serial, pauses when hidden, and a late cancellation cannot undo completion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const pendingStatus = deferred<any>()
  const cancellation = deferred<any>()
  const operation: PluginUpdateStatusResult = { operationId: 'one', revision: 1, targetVersion: version, state: 'applying', phase: 'installing', cancellationAvailable: true }
  let calls = 0
  let requestSignal: AbortSignal | undefined
  const store = new PluginUpdateStore({ async call(_channel, endpoint, _input, currentSignal) {
    if (endpoint === 'update/cancel') return cancellation.promise
    calls++
    if (calls === 1) return { ok: true, value: operation }
    requestSignal = currentSignal
    return pendingStatus.promise
  } })
  try {
    await store.recover()
    store.setVisible(false)
    context.mock.timers.tick(5_000)
    assert.equal(calls, 1)
    store.setVisible(true)
    context.mock.timers.tick(1000)
    await tick()
    assert.equal(calls, 2)
    context.mock.timers.tick(5000)
    assert.equal(calls, 2)
    const cancel = store.cancel()
    pendingStatus.resolve({ ok: true, value: { ...operation, revision: 3, state: 'completed', phase: 'completed', cancellationAvailable: false } })
    await tick()
    cancellation.resolve({ ok: true, value: { ...operation, revision: 2, phase: 'cancelling' } })
    await cancel
    assert.equal(store.getSnapshot().operation?.state, 'completed')
  } finally {
    store.dispose()
    assert.equal(requestSignal?.aborted, true)
    context.mock.timers.reset()
  }
})

function elements(tree: any): any[] {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.props?.children)]
}

test('settings confirmation pins the reviewed version and renders release HTML as text', async () => {
  const f = serviceFixture()
  const check = await f.service.check({ channel: { kind: 'next' }, clientVersion: CODINGNS_VERSION }, true)
  f.service.dispose()
  const calls: string[] = []
  const panel = createUpdatePanel({
    locale: { subscribe: () => () => undefined, getSnapshot: () => ({ revision: 0 }), bind: () => (key: string) => dictionary.en[key] ?? key },
    rpc: { async call(_channel: string, endpoint: string) {
      calls.push(endpoint)
      return { ok: true, value: endpoint === 'update/check' ? check : null }
    } },
  })
  try {
    panel.render()
    await tick()
    const click = (label: string) => {
      const element = elements(panel.render()).find(item => item.type === 'button' && item.props.children === label)
      assert.ok(element)
      assert.equal(Boolean(element.props.disabled), false)
      element.props.onClick()
    }
    click('Check for updates')
    await tick()
    const tree = elements(panel.render())
    const notes = tree.find(element => element.type === 'pre')
    assert.equal(notes.props.children, '<script>alert(1)</script>\nFix #1')
    assert.ok(tree.every(element => element.props?.dangerouslySetInnerHTML === undefined))
    click('Review update')
    assert.equal(calls.filter(call => call === 'update/apply').length, 0)
    assert.ok(elements(panel.render()).some(item => item.type === 'button' && item.props.children === 'Confirm and update'))
    const select = elements(panel.render()).find(item => item.type === 'select')
    select.props.onChange({ currentTarget: { value: 'exact' } })
    assert.ok(!elements(panel.render()).some(item => item.type === 'button' && item.props.children === 'Confirm and update'))
  } finally { panel.dispose() }
})

test('feature lifecycle releases RPC and metadata resources independently of other modules', async () => {
  const table = new CodingNsRpcTable()
  const profile = createDshCapabilityRegistry('0.1.7-rc.2', 'host', {}).getProfile({})
  const registry = new FeatureRegistry({ rpc: table } as never, profile)
  registry.register(createPluginUpdateFeature())
  await registry.start('pluginUpdate')
  assert.ok(table.resolve('update/check'))
  await registry.reconcile([])
  assert.equal(table.resolve('update/check'), null)
  assert.equal(pluginUpdateFeature.descriptor.ui, undefined)
  assert.deepEqual(settingsModules({ modules: () => [pluginUpdateFeature] } as never), [])
})

test('header checks once while collapsed and shares the same operation store across expansion', async () => {
  const calls: string[] = []
  const signals: AbortSignal[] = []
  const check = { target: { version }, state: 'update-available' } as PluginUpdateCheckResult
  const header = createHookRenderer(CodingNsSettingsUpdate, {
    services: {
      locale: { subscribe: () => () => undefined, getSnapshot: () => ({ revision: 0 }), bind: () => (key: string) => dictionary.en[key] ?? key },
      rpc: { async call(_channel: string, endpoint: string, _payload: unknown, signal: AbortSignal) {
        calls.push(endpoint); signals.push(signal)
        return { ok: true, value: endpoint === 'update/check' ? check : null }
      } },
    },
  } as never)
  try {
    header.render()
    await tick()
    const tree = header.render()
    const versionButton = (value: any) => elements(value.props.versionControl).find(item => item.type === 'button')
    assert.equal(versionButton(tree).props['aria-expanded'], false)
    assert.equal(tree.props.children.props.hidden, true)
    assert.equal(tree.props.children.props.children, null)
    assert.ok(elements(tree.props.versionControl).some(item => item.props.role === 'status'))
    versionButton(tree).props.onClick()
    const expanded = header.render()
    const store = expanded.props.children.props.children.props.store
    assert.equal(expanded.props.children.props.hidden, false)
    versionButton(expanded).props.onClick()
    const collapsed = header.render()
    assert.equal(collapsed.props.children.props.hidden, true)
    assert.equal(collapsed.props.children.props.children.props.store, store)
    assert.equal(store.getSnapshot().check, check)
    assert.deepEqual(calls, ['update/runtime', 'update/status', 'update/check'])
  } finally { header.dispose() }
  assert.ok(signals.every(signal => signal.aborted))
})

test('new-version badge compares against installed and loaded versions even for incompatible targets', () => {
  const snapshot = (targetVersion: string, installedVersion = CODINGNS_VERSION) => ({
    check: { target: { version: targetVersion }, state: 'incompatible' },
    runtime: { installedVersion, runningHostVersion: CODINGNS_VERSION },
  }) as any
  assert.equal(hasNewerPluginVersion(snapshot(version)), true)
  assert.equal(hasNewerPluginVersion(snapshot(CODINGNS_VERSION)), false)
  assert.equal(hasNewerPluginVersion(snapshot('0.2.0-rc.3')), false)
  assert.equal(hasNewerPluginVersion(snapshot(version, version)), false)
  assert.equal(hasNewerPluginVersion({ check: null } as any), false)
})

test('updater source has no direct package/process/filesystem writes or private reload tricks', async () => {
  for (const path of [
    'src/host/update/service.ts', 'src/host/update/metadata.ts', 'src/host/update/release-notes.ts',
    'src/dsh-capabilities/host/plugin-update-adapter.ts', 'src/client/update-panel.ts', 'src/client/update-store.ts',
  ]) {
    const text = await readFile(new URL(`../${path}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /node:(?:child_process|fs)|location\.reload|loadCache|removeBundle\(|execFile\(|spawn\(/u)
  }
})
