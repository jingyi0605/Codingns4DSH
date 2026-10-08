import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import type { CodingNsCliModelCatalog } from '../data/build/dist/shared/contracts/cli-adapter.js'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const catalog = (id: string): CodingNsCliModelCatalog => ({ groups: [{ id: 'default', name: '默认', models: [{ id, name: id, efforts: [] }] }], currentModel: null, currentEffort: null })
const firstModel = (value: CodingNsCliModelCatalog) => value.groups[0]?.models[0]?.id
const finish = async function* () { yield { type: 'finish' as const, reason: 'stop' as const } }

test('启动异步检测一次，普通目录读取和驱动内部自检只读缓存', async (t) => {
  let detections = 0, models = 0
  const driver = {
    descriptor: { id: 'fake', name: 'Fake' }, warmModelCatalog: true,
    async detect() { detections++; return { installed: false, version: null, command: null } },
    async listModels() { models++; await this.detect(); return catalog('one') }, executeTurn: finish,
  }
  const registry = new CodingNsCliAdapterRegistry([driver], {}, { uninstalledCacheTtlMs: 5 })
  t.after(() => registry.dispose())
  registry.warmCatalog(); registry.warmCatalog()
  assert.equal((await registry.catalog())[0]?.detectionState, 'pending')
  assert.equal(detections, 0)
  await delay(1_100)
  assert.equal((await registry.catalog())[0]?.detectionState, 'ready')
  assert.equal(detections, 1)
  assert.equal(models, 0, '启动不能预热模型')
  await Promise.all([driver.detect(), driver.detect(), registry.catalog(), registry.catalog()])
  await delay(30)
  assert.equal(detections, 1, '未安装也不能定时重跑')
  await registry.models('fake')
  assert.equal(detections, 1, 'listModels 中的自检不能绕过缓存')
})

test('手动检测合并并发探测并刷新指定 Agent', async (t) => {
  const calls = [0, 0]
  const registry = new CodingNsCliAdapterRegistry(calls.map((_, index) => ({
    descriptor: { id: String(index), name: String(index) },
    async detect() { calls[index]++; await delay(10); return { installed: true, version: String(calls[index]), command: 'fake' } },
    async listModels() { return catalog('one') }, executeTurn: finish,
  })))
  t.after(() => registry.dispose())
  await registry.refreshCatalog()
  assert.deepEqual(calls, [1, 1])
  await Promise.all([registry.refreshCatalog('0'), registry.refreshCatalog('0')])
  assert.deepEqual(calls, [2, 1])
  assert.equal((await registry.catalog())[0]?.version, '2')
})

test('模型首次按需加载且合并并发，只有手动检测或配置变化才重读', async (t) => {
  let calls = 0, fingerprint = 'provider-a'
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1', command: 'fake' } },
    catalogFingerprint() { return fingerprint },
    async listModels() { calls++; await delay(10); return catalog(`model-${calls}`) }, executeTurn: finish,
  }], {}, { modelCacheTtlMs: 5 })
  t.after(() => registry.dispose())
  const values = await Promise.all([registry.models('fake'), registry.models('fake')])
  assert.equal(values[0], values[1]); assert.equal(calls, 1)
  await delay(30)
  assert.equal(firstModel(await registry.models('fake')), 'model-1')
  await registry.refreshCatalog('fake')
  assert.equal(calls, 1, '手动检测不应一次启动所有模型服务')
  assert.equal(firstModel(await registry.models('fake')), 'model-2')
  fingerprint = 'provider-b'
  const changed = await Promise.all([registry.models('fake'), registry.models('fake'), registry.models('fake')])
  assert.ok(changed.every((value) => firstModel(value) === 'model-3'))
  assert.equal(calls, 3, '配置变化只能触发一次共享模型查询')
})

test('失败不产生周期重试，手动检测后可以恢复', async (t) => {
  let calls = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1', command: 'fake' } },
    async listModels() { if (++calls === 1) throw new Error('offline'); return catalog('recovered') }, executeTurn: finish,
  }], {}, { modelRetryTtlMs: 5 })
  t.after(() => registry.dispose())
  await assert.rejects(registry.models('fake'), /offline/u)
  await delay(30)
  await assert.rejects(registry.models('fake'), /offline/u)
  assert.equal(calls, 1)
  await registry.refreshCatalog('fake')
  assert.equal(firstModel(await registry.models('fake')), 'recovered')
})

test('手动刷新后迟到的旧模型不能覆盖新目录', async (t) => {
  let release!: (value: CodingNsCliModelCatalog) => void
  let calls = 0
  const old = new Promise<CodingNsCliModelCatalog>((resolve) => { release = resolve })
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1', command: 'fake' } },
    async listModels() { return ++calls === 1 ? old : catalog('new') }, executeTurn: finish,
  }])
  t.after(() => registry.dispose())
  const pending = registry.models('fake')
  await registry.refreshCatalog('fake')
  assert.equal(firstModel(await registry.models('fake')), 'new')
  release(catalog('old'))
  assert.equal(firstModel(await pending), 'new')
  assert.equal(firstModel(await registry.models('fake')), 'new')
  assert.equal(calls, 2)
})

test('停用注册表后取消尚未开始的启动检测', async () => {
  let calls = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { calls++; return { installed: false, version: null, command: null } },
    async listModels() { return catalog('one') }, executeTurn: finish,
  }])
  registry.warmCatalog(); await registry.dispose()
  await delay(1_050)
  assert.equal(calls, 0)
})
