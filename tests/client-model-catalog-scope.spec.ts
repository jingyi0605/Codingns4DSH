import assert from 'node:assert/strict'
import test from 'node:test'
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
