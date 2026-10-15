import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { admitCodingNsPeer, isCodingNsOwnerPeer } from '../src/dsh-capabilities/host/connection-peer-adapter.js'
import { createSessionActivator } from '../src/dsh-capabilities/host/session-activation-adapter.js'
import { createFactoryMessagePresentation, createLegacyMessagePresentation } from '../src/dsh-capabilities/client/message-presentation-adapter.js'
import { resolveDshNativeDispatch } from '../src/host/modules/peer-host/peer-host-native-dispatch.js'
import { PeerHostNativeStreams } from '../src/host/modules/peer-host/peer-host-native-streams.js'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'

function peer(kind = 'owner') {
  const lifetime = new AbortController()
  return { id: 'peer', principal: { kind }, signal: lifetime.signal, dispose: () => lifetime.abort() }
}

for (const version of ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3']) {
  test(`${version}: peer and message routes match the actual ABI`, () => {
    const modern = version === '0.2.1-alpha.3'
    const owner = peer()
    const connection = { admit: () => ({ peer: owner }), requestRejection: () => undefined, rpc: { handle() {} },
      ...(modern ? { browserPeer: owner, createPeer: peer } : { operator: owner }) }
    const host = { connection, sessionController: { create() {}, resolveAgent() {} } }
    const hostProfile = createDshCapabilityRegistry(version, 'host', host).getProfile(host)
    assert.equal(hostProfile.capabilities.get('connection.peer')?.routeId, modern ? 'connection.peer-021' : 'connection-peer-admission-020')
    assert.equal(hostProfile.capabilities.get('connection.uplink')?.status, 'ready')
    assert.equal(hostProfile.capabilities.get('session.activation')?.status, 'ready')
    const client = { slots: { inject() {}, register() {}, registerFactory() {} } }
    const facts = { primitives: modern ? {} : { projectUserText: (text: string) => text } }
    const resolution = createDshCapabilityRegistry(version, 'client', client, facts).getProfile(client).capabilities.get('conversation.message-presentation')
    assert.equal(resolution?.status, 'ready')
    assert.equal(resolution?.routeId, modern ? 'message-presentation-021' : 'message-presentation-020')
    assert.equal(admitCodingNsPeer(connection, {}).peer, owner)
  })
}

for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2']) {
  test(`${version}: new capabilities fail with an explainable diagnostic`, () => {
    for (const [runtime, capability] of [['host', 'session.activation'], ['client', 'conversation.message-presentation']] as const) {
      const profile = createDshCapabilityRegistry(version, runtime, {}).getProfile({})
      assert.equal(profile.capabilities.get(capability)?.status, 'unavailable')
      assert.ok(profile.diagnostics.some(item => item.capability === capability && item.code === 'CAPABILITY_VERSION_UNSUPPORTED'))
    }
  })
}

test('alpha.3 refuses a registry without factory support and does not select the removed legacy export', () => {
  const client = { slots: { inject() {}, register() {} } }
  const result = createDshCapabilityRegistry('0.2.1-alpha.3', 'client', client, { primitives: { projectUserText() {} } }).getProfile(client)
  assert.equal(result.capabilities.get('conversation.message-presentation')?.status, 'unavailable')
})

test('admission preserves the trusted peer and rejects restricted, expired and unauthenticated callers', () => {
  const owner = peer()
  const restricted = peer('remote')
  const connection = { browserPeer: owner, admit: () => ({ peer: restricted }) }
  assert.deepEqual(admitCodingNsPeer(connection, { peer: owner }), { rejection: 403 })
  assert.equal(isCodingNsOwnerPeer(connection, undefined), false)
  owner.dispose()
  assert.equal(isCodingNsOwnerPeer(connection, owner), false)
  assert.deepEqual(admitCodingNsPeer({ admit: () => ({ rejection: 401 }) }, {}), { rejection: 401 })
})

test('alpha.3 gateway reuses the exact caller for RPC, streams and event answers without disposing borrowed peers', async () => {
  const owner = peer()
  const caller = peer()
  const calls: unknown[] = []
  const gateway = {
    invoke: async (request: { peer: unknown }) => { calls.push(request.peer); return {} },
    stream: (request: { peer: unknown }) => { calls.push(request.peer); return (async function* () {})() },
    wireStream: { open: async (_name: string, _payload: unknown, _uplink: unknown, scope: unknown) => {
      calls.push(scope); return (async function* () { yield { type: 'ready' } })()
    } },
  }
  const connection = { browserPeer: owner, createSharedFetchHandler: () => ({ fetch: async (_request: Request, scope: unknown) => {
    calls.push(scope); return Response.json({ result: { ok: true } })
  } }) }
  const dispatch = resolveDshNativeDispatch({ get: (name: string) => name === 'typertGateway' ? gateway : connection } as never)!
  await dispatch.rpc('session/list', {}, undefined, caller)
  await dispatch.stream('session/follow', {}, undefined, caller)
  await dispatch.stream('$events', {}, undefined, caller)
  await dispatch.rpc('$events/result', {}, undefined, caller)
  assert.deepEqual(calls, [caller, caller, caller, caller])
  assert.equal(caller.signal.aborted, false)
  caller.dispose()
  await assert.rejects(dispatch.rpc('session/list', {}, undefined, caller), { name: 'AbortError' })
  assert.equal(owner.signal.aborted, false)
})

test('stream handles cannot be polled or closed by another peer and are released with their owner', async () => {
  const streams = new PeerHostNativeStreams()
  const owner = peer()
  const other = peer()
  const scope = { hostId: 'local', targetHostId: null, workspaceId: 'w', sessionId: null, scopeGeneration: 0 }
  let closed = false
  let signal: AbortSignal | undefined
  const id = await streams.open(scope, value => {
    signal = value
    return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: 1 }), return: async () => { closed = true; return { done: true, value: undefined } } }) }
  }, owner)
  await assert.rejects(streams.next(id, scope, undefined, other), { code: 'CODINGNS_RPC_SCOPE_MISMATCH' })
  await assert.rejects(streams.close(id, scope, undefined, other), { code: 'CODINGNS_RPC_SCOPE_MISMATCH' })
  assert.deepEqual(await streams.next(id, scope, undefined, owner), { done: false, value: 1 })
  owner.dispose()
  assert.equal(signal?.aborted, true)
  assert.equal(closed, true)
  await assert.rejects(streams.next(id, scope, undefined, owner), { code: 'CODINGNS_RPC_NOT_FOUND' })
  streams.dispose()
})

test('cold session activation resumes and coalesces concurrent requests without calling create', async () => {
  let resumes = 0
  const ensure = createSessionActivator({ get: () => undefined }, {
    resolveAgent: async () => { resumes++; return { agent: {} } },
    create: async () => { throw new Error('must not create an existing session') },
  })
  assert.deepEqual(await Promise.all([ensure('old'), ensure('old')]), ['old', 'old'])
  assert.equal(resumes, 1)
})

test('session creation requires definite absence, preserves identity and propagates real restore failures', async () => {
  const missing = { code: 'session/not-found' }
  let created = 0
  const create = async () => { created++; return { sessionId: 'replacement' } }
  await assert.rejects(createSessionActivator(undefined, { create, resolveAgent: async () => ({ error: { code: 'session/corrupt' } }) })('old'), { code: 'session/corrupt' })
  assert.equal(created, 0)
  await assert.rejects(createSessionActivator(undefined, { create, resolveAgent: async () => ({ error: missing }) })('old'), { code: 'CODINGNS_SESSION_ID_MISMATCH' })
  assert.equal(created, 1)
  assert.equal(await createSessionActivator(undefined, { create: async ({ sessionId }) => ({ sessionId: sessionId! }) })('new'), 'new')
})

test('alpha.3 without session recovery degrades without calling create', async () => {
  const controller = { create: async () => { throw new Error('must not create without recovery') } }
  const ctx = { get: (name: string) => name === 'sessionController' ? controller : undefined }
  const bridge = createCodingNsNativeSessionBridge(ctx as never, '0.2.1-alpha.3')
  assert.equal(await bridge.ensure('existing'), null)
})

test('external execution continues without projecting or flushing a failed or mismatched native activation', async () => {
  for (const outcome of [null, 'replacement', new Error('restore failed')]) {
    let writes = 0
    const registry = new CodingNsCliAdapterRegistry([{
      descriptor: { id: 'codex', name: 'Codex' },
      async detect() { return { installed: true, version: 'fixture', command: 'fixture' } },
      async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
      async *executeTurn() { yield { type: 'finish', reason: 'stop' } as const },
    }], {}, { nativeSessions: {
      available: true, get() {}, list: () => [],
      ensure: async () => { if (outcome instanceof Error) throw outcome; return outcome },
      appendRequestContext: () => { writes++; return true },
      flush: async () => { writes++ },
    } as never })
    try {
      const events = await Array.fromAsync(registry.execute({ adapterId: 'codex', sessionId: 'original', prompt: 'hello', messages: [] }))
      assert.equal(events.at(-1)?.type, 'finish')
      assert.equal(writes, 0)
    } finally { await registry.dispose() }
  }
})

test('native message factories receive unmodified text facts, attachment order and authorized image loading', () => {
  const calls: unknown[] = []
  const owner = { loadImage() {}, renderFactorySlot: (...args: unknown[]) => { calls.push(args); return null } }
  const content = { text: 'sensitive source', attachments: [{ type: 'image', image: { attachment: {} } }, { type: 'file', file: {} }], extraBlocks: [] }
  const facts = { sessionLabels: ['existing session'], skillNames: ['skill'] }
  const presentation = createFactoryMessagePresentation({ slots: {} })
  presentation.userContent(owner, content, facts)
  presentation.images(owner, { images: ['image'], align: 'start' })
  assert.deepEqual(calls, [
    ['conversation.chat.user.content', { content, facts, loadImage: owner.loadImage, interactive: true }],
    ['conversation.images.content', { images: ['image'], align: 'start', loadImage: owner.loadImage }],
  ])
  const legacyCalls: unknown[][] = []
  const legacy = createLegacyMessagePresentation({ projectUserText: (...args: unknown[]) => { legacyCalls.push(args); return 'legacy' } })
  assert.equal(legacy.projectText('text', ['label'], ['skill'], 'skill'), 'legacy')
  assert.deepEqual(legacyCalls[0], ['text', ['label'], ['skill'], 'skill'])
})
