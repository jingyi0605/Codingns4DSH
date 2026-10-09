import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostRemoteSummarySource } from '../data/build/dist/host/modules/peer-host/peer-host-remote-summary-source.js'
import { createAggregateHostSource, PeerHostAggregateService } from '../data/build/dist/host/modules/peer-host/peer-host-aggregate-service.js'
import { VirtualWorkspaceRegistry } from '../data/build/dist/host/modules/peer-host/peer-host-virtual-registry.js'
import { createScopedNativeIdResolver } from '../data/build/dist/host/features/peer-host.js'
import { rewriteNativeRequestIds } from '../data/build/dist/host/modules/peer-host/peer-host-native-protocol.js'
import { createPeerHostNativeProjection } from '../data/build/dist/client/peer-host-native-projection.js'
import { createPeerHostPageTransport } from '../data/build/dist/client/features/peer-host.js'
import { sessionAdapterId } from '../data/build/dist/client/session-adapter-cache.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'

/** 从真实摘要协议开始回放，覆盖子会话不属于工作区侧栏成员的情况。 */
async function aggregate() {
  const sources = ['peer-a', 'peer-b'].map(targetHostId => createAggregateHostSource({
    hostId: 'local', targetHostId, hostLabel: targetHostId,
    source: createPeerHostRemoteSummarySource({
      scope: { hostId: 'local', targetHostId, workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 },
      visibleWorkspaceIds: ['workspace'],
      transport: {
        async rpc() {
          return { items: [
            { sessionId: 'parent', running: true, blank: false },
            { sessionId: 'child', parentSessionId: 'parent', origin: 'subagent', running: targetHostId === 'peer-a', blank: false, projections: { kind: 'sequenced', asOfSeq: 3, values: { title: '子任务', inbox: ['不进入摘要'] } } },
            { sessionId: 'grandchild', parentSessionId: 'child', origin: 'subagent', running: true, blank: false },
            { sessionId: 'hidden-parent', running: true, blank: false },
            { sessionId: 'hidden-child', parentSessionId: 'hidden-parent', origin: 'subagent', running: true, blank: false },
            { sessionId: 'cycle-a', parentSessionId: 'cycle-b', origin: 'subagent', running: true, blank: false },
            { sessionId: 'cycle-b', parentSessionId: 'cycle-a', origin: 'subagent', running: true, blank: false },
          ] }
        },
        async cli() { return [{ sessionId: 'child', adapterId: targetHostId === 'peer-a' ? 'codex' : 'claude' }] },
        async *stream() {
          yield { type: 'baseline', value: { items: [
            { workspaceId: 'workspace', path: 'C:\\Code\\project', sessionIds: ['parent'] },
            { workspaceId: 'hidden', path: '/private', sessionIds: ['hidden-parent'] },
          ] } }
        },
      },
    }),
  }))
  return new PeerHostAggregateService(1000).load(sources)
}

test('子会话与后代进入状态基线和适配器路由，但不进入侧栏、归档或其他工作区', async () => {
  const results = await aggregate()
  const workspace = results[0]!.workspaces[0]!
  assert.deepEqual(workspace.sessions.map(row => row.scope.sessionId), ['parent'])
  assert.deepEqual(workspace.subagentSessions?.map(row => row.scope.sessionId), ['child', 'grandchild'])
  assert.equal(workspace.archivedSessions, undefined)
  assert.deepEqual(workspace.subagentSessions?.[0]?.titleProjection, { kind: 'sequenced', asOfSeq: 3, values: { title: '子任务' } })
  const projection = createPeerHostNativeProjection()
  projection.setAggregate(results)
  const a = createVirtualSessionId('peer-a', 'child')
  const b = createVirtualSessionId('peer-b', 'child')
  assert.deepEqual(projection.workspaces()[0]?.sessionIds, [createVirtualSessionId('peer-a', 'parent')])
  const child = projection.sessions().find(row => row.sessionId === a)!
  assert.equal(child.running, true)
  assert.equal(child.origin, 'subagent')
  assert.equal(child.parentSessionId, createVirtualSessionId('peer-a', 'parent'))
  assert.equal(projection.sessions().find(row => row.sessionId === b)?.running, false)
  assert.equal(sessionAdapterId(a), 'codex')
  assert.equal(sessionAdapterId(b), 'claude')
  assert.equal(projection.setAggregate(results), false, '相同快照必须保留引用')
  const stopped = structuredClone(results)
  stopped[0]!.workspaces[0]!.subagentSessions![0] = { ...workspace.subagentSessions![0]!, status: 'idle' }
  assert.equal(projection.setAggregate(stopped), true)
  assert.equal(projection.sessions().find(row => row.sessionId === a)?.running, false)

  const registry = new VirtualWorkspaceRegistry()
  registry.replace(results)
  const scope = registry.resolveSession(a)!
  assert.equal(scope.targetHostId, 'peer-a')
  assert.deepEqual(registry.listSessions(createVirtualWorkspaceId('peer-a', 'workspace')).map(row => row.scope.sessionId), ['parent'])
  assert.equal(registry.resolveSession(createVirtualSessionId('peer-a', 'hidden-child')), null)
  const payload = { args: { childSessionId: a, parentSessionId: createVirtualSessionId('peer-a', 'parent'), mode: 'continuable' } }
  assert.deepEqual(rewriteNativeRequestIds('subagents/interruptByParent', payload, createScopedNativeIdResolver(registry, scope)), {
    args: { childSessionId: 'child', parentSessionId: 'parent', mode: 'continuable' },
  })

  const previousFetch = globalThis.fetch
  const calls: any[] = []
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/api/session/list')) return response({ items: [{ sessionId: 'local-session', running: false }] })
    const request = JSON.parse(String(init?.body))
    calls.push(request)
    const target = request.payload.scope.targetHostId
    const cli = JSON.parse(request.payload.body)
    assert.equal(cli.payload.sessionId, 'child')
    return response({ status: 200, body: JSON.stringify({ result: { ok: true, value: { adapterId: target === 'peer-a' ? 'codex' : 'claude', modelId: 'remote-model' } } }) })
  }) as typeof fetch
  const transport = createPeerHostPageTransport()
  try {
    transport.setAggregate(results)
    const baseline = await transport.hooks.rpc!<{ ok: true; value: { items: typeof child[] } }>({
      method: 'session/list', payload: { channel: '/api', payload: { args: { _request: {} } } },
    })
    assert.equal(baseline.value.items[0]?.sessionId, 'local-session')
    assert.equal(baseline.value.items.find(row => row.sessionId === a)?.running, true)
    assert.equal(baseline.value.items.find(row => row.sessionId === a)?.origin, 'subagent')
    assert.equal(baseline.value.items.find(row => row.sessionId === b)?.running, false)
    for (const [id, adapterId] of [[a, 'codex'], [b, 'claude']]) {
      assert.equal(transport.matchesScope({ sessionId: id }, 'cli/session/get'), true)
      assert.deepEqual(await transport.hooks.rpc!({ method: 'cli/session/get', payload: { channel: '/codingns', payload: { sessionId: id } } }), {
        ok: true, value: { adapterId, modelId: 'remote-model' },
      })
    }
    assert.deepEqual(calls.map(call => call.payload.scope.targetHostId), ['peer-a', 'peer-b'])
    transport.setAggregate([])
    assert.equal(transport.matchesScope({ sessionId: a }, 'cli/session/get'), false)
  } finally { transport.dispose(); globalThis.fetch = previousFetch }
})

function response(value: unknown) {
  return new Response(JSON.stringify({ result: { ok: true, value } }), { headers: { 'content-type': 'application/json' } })
}

test('父会话公布目录后立即可读取子会话配置，聚合尚未登记时也不回落本机', async () => {
  const results = await aggregate()
  const previousFetch = globalThis.fetch
  const childId = createVirtualSessionId('peer-a', 'new-child')
  let reads = 0
  globalThis.fetch = (async (url, init) => {
    const request = JSON.parse(String(init?.body))
    if (String(url).endsWith('/nativeStream')) return response({ streamId: 'catalog-stream' })
    if (String(url).endsWith('/nativeStreamNext')) return response(reads++ === 0
      ? { done: false, value: { type: 'snapshot', projections: { values: { subagentCatalog: [{ id: childId, mode: 'continuable' }] } } } }
      : { done: true })
    if (String(url).endsWith('/nativeStreamClose')) return response({ closed: true })
    assert.equal(request.payload.scope.targetHostId, 'peer-a')
    assert.equal(JSON.parse(request.payload.body).payload.sessionId, 'new-child')
    return response({ status: 200, body: JSON.stringify({ result: { ok: true, value: { adapterId: 'codex' } } }) })
  }) as typeof fetch
  const transport = createPeerHostPageTransport()
  try {
    transport.setAggregate(results)
    for await (const _chunk of transport.hooks.openStream!({ method: 'session/follow', payload: { channel: '/api', payload: { args: { request: { address: { kind: 'session', sessionId: createVirtualSessionId('peer-a', 'parent') } } } } } })) {
      assert.equal(transport.matchesScope({ sessionId: childId }, 'cli/session/get'), true)
      assert.deepEqual(await transport.hooks.rpc!({ method: 'cli/session/get', payload: { channel: '/codingns', payload: { sessionId: childId } } }), { ok: true, value: { adapterId: 'codex' } })
    }
    assert.equal(transport.matchesScope({ workspaceId: createVirtualWorkspaceId('peer-a', 'workspace') }), true)
  } finally { transport.dispose(); globalThis.fetch = previousFetch }
})
