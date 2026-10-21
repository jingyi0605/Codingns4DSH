import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { subscribeAdapterCatalogChanged } from '../data/build/dist/client/adapter-catalog-watch.js'
import { getModelCatalogCache, invalidateModelCatalogCache, loadModelCatalog, shouldRevalidateModelCatalog } from '../data/build/dist/client/model-catalog-cache.js'
import { createVirtualSessionId, parseVirtualSessionId } from '../data/build/dist/shared/index.js'

const session = (host: string, id = 'session') => createVirtualSessionId(host, id)
const hostFor = (payload: unknown) => parseVirtualSessionId((payload as { sessionId: string }).sessionId)?.hostId ?? 'local'
const catalog = (host: string, fallback = false) => ({
  groups: [{ id: host, name: host, models: [{ id: `${host}-model`, name: host, efforts: ['high'], effortLabels: { high: `${host}-深入` } }] }],
  currentModel: `${host}-model`, currentEffort: 'high', officialSubscription: host === 'mac', fallback,
})

test('外部模型缓存按 RPC、Host 和适配器隔离，同 Host 的会话保留复用', async () => {
  const calls: string[] = []
  const rpc = { call: async (_channel: string, _method: string, payload: unknown) => {
    const host = hostFor(payload)
    calls.push(host)
    return { ok: true as const, value: catalog(host) }
  } }
  const local = await loadModelCatalog(rpc, 'codex', 'local-session')
  const remote = await loadModelCatalog(rpc, 'codex', session('stage0'))
  const mac = await loadModelCatalog(rpc, 'codex', session('mac'))
  assert.deepEqual(calls, ['local', 'stage0', 'mac'])
  assert.deepEqual([local, remote, mac].map(value => value.groups[0]?.id), ['local', 'stage0', 'mac'])
  assert.equal(await loadModelCatalog(rpc, 'codex', session('stage0', 'other-session')), remote)
  assert.equal(await loadModelCatalog(rpc, 'codex', 'other-local-session'), local)
  assert.equal(getModelCatalogCache(rpc).get('codex'), local, '本机旧调用保持兼容')
  assert.equal(getModelCatalogCache(rpc, session('mac')).get('codex'), mac)
  assert.deepEqual(mac.groups[0]?.models[0]?.effortLabels, { high: 'mac-深入' })
  assert.equal(mac.officialSubscription, true)
  const otherRpc = { ...rpc }
  await loadModelCatalog(otherRpc, 'codex', session('mac'))
  await loadModelCatalog(rpc, 'claude-code', session('mac'))
  assert.deepEqual(calls, ['local', 'stage0', 'mac', 'mac', 'mac'])
})

test('不同 Host 的并发加载不合并，较晚响应不能覆盖其他 Host 的目录', async () => {
  const releases = new Map<string, (value: { ok: true; value: ReturnType<typeof catalog> }) => void>()
  const rpc = { call: (_channel: string, _method: string, payload: unknown) => new Promise<{ ok: true; value: ReturnType<typeof catalog> }>(resolve => {
    releases.set(hostFor(payload), resolve)
  }) }
  const stage0 = loadModelCatalog(rpc, 'codex', session('stage0'))
  const stage0Again = loadModelCatalog(rpc, 'codex', session('stage0', 'other-session'))
  const mac = loadModelCatalog(rpc, 'codex', session('mac'))
  assert.equal(stage0Again, stage0)
  assert.deepEqual([...releases.keys()], ['stage0', 'mac'])
  releases.get('mac')!({ ok: true, value: catalog('mac') })
  const macValue = await mac
  releases.get('stage0')!({ ok: true, value: catalog('stage0') })
  assert.equal((await stage0).groups[0]?.id, 'stage0')
  assert.equal(await loadModelCatalog(rpc, 'codex', session('mac')), macValue)
  assert.equal(getModelCatalogCache(rpc, session('stage0')).get('codex')?.groups[0]?.id, 'stage0')
})

test('按会话作废只影响对应 Host，旧的全局作废调用仍覆盖所有 Host', async () => {
  const calls: string[] = []
  const rpc = { call: async (_channel: string, _method: string, payload: unknown) => {
    const host = hostFor(payload)
    calls.push(host)
    return { ok: true as const, value: catalog(host) }
  } }
  for (const id of ['local-session', session('stage0'), session('mac')]) await loadModelCatalog(rpc, 'codex', id)
  invalidateModelCatalogCache(rpc, 'codex', session('stage0'))
  assert.equal(getModelCatalogCache(rpc, session('stage0')).size, 0)
  assert.equal(getModelCatalogCache(rpc).size, 1)
  assert.equal(getModelCatalogCache(rpc, session('mac')).size, 1)
  await loadModelCatalog(rpc, 'codex', session('stage0'))
  await loadModelCatalog(rpc, 'codex', session('mac'))
  assert.deepEqual(calls, ['local', 'stage0', 'mac', 'stage0'])
  invalidateModelCatalogCache(rpc, 'codex')
  for (const id of ['local-session', session('stage0'), session('mac')]) assert.equal(getModelCatalogCache(rpc, id).size, 0)
})

test('供应商与服务档位复检节流按 Host 隔离，不被其他 Host 的复检压制', () => {
  const rpc = { call: async () => ({ ok: true as const, value: catalog('unused') }) }
  for (const id of ['local-session', session('stage0'), session('mac')]) {
    assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', true, id), true)
    assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', true, id), false)
  }
  assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', false, session('another')), false)
  assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', true, session('another')), true)
})

test('手动刷新后的新目录不会被之前的迟到请求覆盖', async () => {
  const releases: Array<(value: { ok: true; value: ReturnType<typeof catalog> }) => void> = []
  const rpc = { call: () => new Promise<{ ok: true; value: ReturnType<typeof catalog> }>((resolve) => { releases.push(resolve) }) }
  const oldRequest = loadModelCatalog(rpc, 'codex')
  invalidateModelCatalogCache(rpc, 'codex')
  const freshRequest = loadModelCatalog(rpc, 'codex')
  releases[1]!({ ok: true, value: catalog('new') })
  await freshRequest
  releases[0]!({ ok: true, value: catalog('old') })
  assert.equal((await oldRequest).currentModel, 'new-model')
  assert.equal(getModelCatalogCache(rpc).get('codex')?.currentModel, 'new-model')
})

test('先返回原生目录，Magpie 完成后后台替换缓存并通知订阅者', async () => {
  let finishEnrichment: ((value: { groups: ReturnType<typeof catalog>['groups']; currentModel: string; currentEffort: string; magpiePending?: boolean }) => void) | undefined
  const calls: string[] = []
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      assert.equal(endpoint, 'cli/models')
      const stage = (payload as { stage?: string }).stage ?? 'legacy'
      calls.push(stage)
      if (stage === 'enriched') return new Promise<{ ok: true; value: ReturnType<typeof catalog> }>(resolve => {
        finishEnrichment = value => resolve({ ok: true, value })
      })
      return { ok: true as const, value: { ...catalog('local'), magpiePending: true } }
    },
  }
  let changes = 0
  const unsubscribe = subscribeAdapterCatalogChanged(rpc, () => { changes += 1 })
  try {
    const base = await loadModelCatalog(rpc, 'codex')
    assert.equal(base.magpiePending, true)
    assert.equal(getModelCatalogCache(rpc).get('codex'), base)
    await setImmediate()
    assert.deepEqual(calls, ['base', 'enriched'])

    const enriched = { ...catalog('local'), currentModel: 'local-model', magpiePending: undefined }
    finishEnrichment?.(enriched)
    await setImmediate()
    await setImmediate()

    assert.equal(getModelCatalogCache(rpc).get('codex')?.magpiePending, undefined)
    assert.equal(getModelCatalogCache(rpc).get('codex')?.currentModel, 'local-model')
    assert.equal(changes, 1)
    assert.equal(await loadModelCatalog(rpc, 'codex'), getModelCatalogCache(rpc).get('codex'))
    assert.deepEqual(calls, ['base', 'enriched'], 'the enriched snapshot is reused instead of blocking on another RPC')
  } finally {
    unsubscribe()
  }
})

test('过期目录先回显，基础目录刷新与 Magpie 补全分两次通知', async () => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  let releaseBase: ((value: ReturnType<typeof catalog>) => void) | undefined
  let releaseEnrichment: ((value: ReturnType<typeof catalog>) => void) | undefined
  const stages: string[] = []
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      assert.equal(endpoint, 'cli/models')
      const stage = (payload as { stage?: string }).stage ?? 'legacy'
      stages.push(stage)
      if (stages.length === 1) return { ok: true as const, value: catalog('old') }
      if (stage === 'base') return new Promise<{ ok: true; value: ReturnType<typeof catalog> }>(resolve => {
        releaseBase = value => resolve({ ok: true, value: { ...value, magpiePending: true } })
      })
      return new Promise<{ ok: true; value: ReturnType<typeof catalog> }>(resolve => {
        releaseEnrichment = value => resolve({ ok: true, value })
      })
    },
  }
  let changes = 0
  const unsubscribe = subscribeAdapterCatalogChanged(rpc, () => { changes += 1 })
  try {
    const old = await loadModelCatalog(rpc, 'codex')
    await setImmediate()
    now += 60_001

    const immediate = await loadModelCatalog(rpc, 'codex')
    assert.equal(immediate, old, 'expired successful data stays visible while refresh is pending')
    assert.deepEqual(stages, ['base', 'base'])
    assert.equal(changes, 0)

    releaseBase?.(catalog('fresh'))
    await setImmediate()
    assert.equal(getModelCatalogCache(rpc).get('codex')?.groups[0]?.id, 'fresh')
    assert.equal(changes, 1, 'the fresh base catalog is published before Magpie enrichment finishes')
    assert.deepEqual(stages, ['base', 'base', 'enriched'])

    releaseEnrichment?.(catalog('enriched'))
    await setImmediate()
    await setImmediate()
    assert.equal(getModelCatalogCache(rpc).get('codex')?.groups[0]?.id, 'enriched')
    assert.equal(changes, 2)
  } finally {
    unsubscribe()
    Date.now = originalNow
  }
})

test('远端回退目录与失败不移除或替代其他 Host 的成功缓存', async () => {
  let remoteCalls = 0
  const rpc = { call: async (_channel: string, _method: string, payload: unknown) => {
    const host = hostFor(payload)
    if (host === 'broken') throw new Error('remote unavailable')
    if (host === 'stage0') remoteCalls += 1
    return { ok: true as const, value: catalog(host, host === 'stage0' && remoteCalls === 1) }
  } }
  const mac = await loadModelCatalog(rpc, 'codex', session('mac'))
  const fallback = await loadModelCatalog(rpc, 'codex', session('stage0'))
  assert.equal(fallback.fallback, true)
  assert.equal(getModelCatalogCache(rpc, session('stage0')).size, 0)
  assert.equal(await loadModelCatalog(rpc, 'codex', session('mac')), mac)
  const recovered = await loadModelCatalog(rpc, 'codex', session('stage0'))
  assert.equal(recovered.fallback, false)
  await assert.rejects(loadModelCatalog(rpc, 'codex', session('broken')), /remote unavailable/u)
  assert.equal(await loadModelCatalog(rpc, 'codex', session('mac')), mac)
  assert.equal(getModelCatalogCache(rpc, session('broken')).size, 0)
})
