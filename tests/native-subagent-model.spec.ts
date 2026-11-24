import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveNativeSubagentModel } from '../src/host/cli-adapters/native-subagent-model.js'

const catalog = {
  default: { provider: 'cloud-plan', model: 'owner/model', reasoningEffort: 'high' },
  groups: [
    { id: 'cloud-api', models: [{ id: 'shared' }, { id: 'unique' }] },
    { id: 'cloud-plan', models: [{ id: 'shared' }, { id: 'owner/model' }] },
    { id: 'codingns-cli-codex', models: [{ id: 'gpt' }] },
  ],
}
const sessions = { controller: { modelCatalog: async () => catalog } } as never

test('DSH 同名模型必须保留供应商选择，模型自身的斜线原样保留', async () => {
  assert.deepEqual(await resolveNativeSubagentModel(sessions, 'cloud-plan/shared'), { provider: 'cloud-plan', model: 'shared' })
  assert.deepEqual(await resolveNativeSubagentModel(sessions, 'cloud-api/shared'), { provider: 'cloud-api', model: 'shared' })
  assert.deepEqual(await resolveNativeSubagentModel(sessions, 'cloud-plan/owner/model'), { provider: 'cloud-plan', model: 'owner/model' })
})

test('默认 DSH 委派使用原生默认供应商，不借用外部父 Agent 的路由', async () => {
  for (const id of [undefined, 'provider-default', '']) {
    assert.deepEqual(await resolveNativeSubagentModel(sessions, id), { provider: 'cloud-plan', model: 'owner/model', reasoningEffort: 'high' })
  }
})

test('旧的唯一模型 ID 可继续用，跨供应商同名 ID 必须显式消歧', async () => {
  assert.deepEqual(await resolveNativeSubagentModel(sessions, 'unique'), { provider: 'cloud-api', model: 'unique' })
  await assert.rejects(resolveNativeSubagentModel(sessions, 'shared'), /DELEGATE_DSH_MODEL_AMBIGUOUS/u)
})

test('未知模型、虚拟 CLI Provider 和目录不可用都在创建前拒绝', async () => {
  await assert.rejects(resolveNativeSubagentModel(sessions, 'missing/model'), /DELEGATE_DSH_MODEL_NOT_FOUND/u)
  await assert.rejects(resolveNativeSubagentModel(sessions, 'codingns-cli-codex/gpt'), /DELEGATE_DSH_MODEL_NOT_FOUND/u)
  await assert.rejects(resolveNativeSubagentModel({} as never, 'cloud-api/unique'), /DELEGATE_DSH_ROUTE_UNAVAILABLE/u)
  await assert.rejects(resolveNativeSubagentModel({ controller: { modelCatalog: async () => ({ ...catalog, default: { provider: 'missing', model: 'shared' } }) } } as never), /DELEGATE_DSH_ROUTE_UNAVAILABLE/u)
})
