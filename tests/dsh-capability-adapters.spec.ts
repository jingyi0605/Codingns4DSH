import assert from 'node:assert/strict'
import test from 'node:test'
import { createConfigSettingsStore } from '../data/build/dist/dsh-capabilities/host/config-forms-adapter.js'
import { createConfigFormSettingsStore } from '../data/build/dist/dsh-capabilities/client/config-forms-adapter.js'
import { dispatchCodingNsRpc } from '../data/build/dist/dsh-capabilities/host/connection-rpc-adapter.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

test('0.1.7 Host Config 适配器保留 revision 并路由 mutation', async () => {
  const calls: unknown[] = []
  const store = createConfigSettingsStore({
    describe: () => [{ ns: 'codingns', value: { modules: {} }, revision: 7 }],
    mutate: async (_namespace, operations, revision) => { calls.push([operations, revision]) },
  }, 'codingns')
  assert.equal(store.getSnapshot().revision, 7)
  assert.equal(await store.set('controlBaseUrl', 'https://example.test'), true)
  assert.deepEqual(calls[0], [[{ op: 'set', path: ['controlBaseUrl'], value: 'https://example.test' }], undefined])
})

test('0.1.7 Client ConfigForm 缺失时只禁用设置能力', async () => {
  const store = createConfigFormSettingsStore({ get: () => undefined }, 'codingns')
  assert.equal(store.getSnapshot().status, 'unavailable')
  assert.equal(await store.set('controlBaseUrl', 'https://example.test'), false)
})

test('统一 RPC dispatch 只使用宿主传入的 peer context', async () => {
  const table = new CodingNsRpcTable()
  let received: unknown
  table.register('test', async (_action, payload, context) => { received = { payload, context }; return 'ok' })
  const result = await dispatchCodingNsRpc(table, 'test/ping', { value: 1 }, { peer: { id: 'host-authority' } })
  assert.deepEqual(result, { ok: true, value: 'ok' })
  assert.deepEqual(received, { payload: { value: 1 }, context: { peer: { id: 'host-authority' } } })
})
