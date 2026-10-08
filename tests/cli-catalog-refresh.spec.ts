import assert from 'node:assert/strict'
import test from 'node:test'
import { callCliRpc, catalogRefreshErrorMessage } from '../data/build/dist/client/cli-catalog.js'
import { resolveCodingNsTranslator } from '../data/build/dist/client/locale.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createCodingNsRpcHandler, registerCodingNsRpc } from '../data/build/dist/host/rpc.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { CODINGNS_RPC_CHANNEL } from '../data/build/dist/shared/contracts/transport.js'
import type { CodingNsCliAdapterDescriptor } from '../data/build/dist/shared/contracts/cli-adapter.js'

test('Agent 单个与全部重新检测贯通客户端、RPC 分发和真实注册表', async (t) => {
  for (const fallback of [false, true]) await t.test(fallback ? '旧 Fetch 回退通道' : '原生逻辑通道', async (t) => {
    const detections = [0, 0]
    // 仅模拟外部 CLI；必须由真实分发器解析 catalog/refresh，避免手工调用动作掩盖漏路由。
    const registry = new CodingNsCliAdapterRegistry(['codex', 'claude-code'].map((id, index) => ({
      descriptor: { id, name: id },
      async detect() {
        detections[index] += 1
        return { installed: true, version: String(detections[index]), command: `fake-${id}` }
      },
      async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
      async *executeTurn() { assert.fail('重新检测不能执行模型任务') },
    })))
    const table = new CodingNsRpcTable()
    const features = new FeatureRegistry({ rpc: table })
    features.register(createCliAdaptersFeature({ registry }))
    t.after(() => features.disable('cliAdapters'))
    await features.start('cliAdapters')
    const handler = createCodingNsRpcHandler(table)
    const rpc = {
      async call(channel: string, endpoint: string, payload: unknown, signal = new AbortController().signal) {
        if (fallback && channel === CODINGNS_RPC_CHANNEL) throw new Error('HTTP 405')
        assert.equal(channel, fallback ? '/api' : CODINGNS_RPC_CHANNEL)
        return handler(fallback ? endpoint.replace(/^codingns\//u, '') : endpoint, payload, signal)
      },
    }

    await callCliRpc(rpc, 'catalog', {})
    assert.deepEqual(detections, [0, 0], '普通列表读取不能触发探测')
    const single = await callCliRpc<CodingNsCliAdapterDescriptor[]>(rpc, 'catalog/refresh', { adapterId: 'codex' })
    assert.deepEqual(detections, [1, 0], '单个刷新只能探测所选 Agent')
    assert.equal(single.find((entry) => entry.id === 'codex')?.detectionState, 'ready')
    const all = await callCliRpc<CodingNsCliAdapterDescriptor[]>(rpc, 'catalog/refresh', {})
    assert.deepEqual(detections, [2, 1])
    assert.ok(all.every((entry) => entry.installed && entry.detectionState === 'ready'))
    assert.equal(all.find((entry) => entry.id === 'codex')?.version, '2')
  })
})

test('Agent 重新检测在旧 Fetch 入口也注册精确路由', () => {
  const routes: string[] = []
  let dispose: (() => void) | undefined
  registerCodingNsRpc({
    effect(callback: () => () => void) { dispose = callback() },
    webServer: { register() { return () => {} } },
    connection: { fetch: { register(route: { path: string }) { routes.push(route.path); return () => {} } } },
  } as never, new CodingNsRpcTable())
  try {
    assert.ok(routes.includes('/api/codingns/cli/catalog/refresh'))
  } finally { dispose?.() }
})

test('旧 Host 缺少重新检测时提示同步版本，不能退回只读列表伪装成功', async () => {
  const calls: string[] = []
  const rpc = { async call(_channel: string, endpoint: string) {
    calls.push(endpoint)
    return { ok: false as const, error: { code: 'Error', message: `未知 CLI RPC: ${endpoint}` } }
  } }
  const t = resolveCodingNsTranslator()
  await assert.rejects(callCliRpc(rpc, 'catalog/refresh', {}), (error: unknown) => {
    assert.equal(catalogRefreshErrorMessage(error, t), t('cli.redetectHostUnsupported'))
    assert.match(catalogRefreshErrorMessage(error, t), /重启 Host/u)
    return true
  })
  assert.deepEqual(calls, ['cli/catalog/refresh'])
  for (const message of ['HTTP 500', 'timeout', '未知 CLI RPC: cli/models', 'CLI 检测失败']) {
    assert.equal(catalogRefreshErrorMessage(new Error(message), t), message)
  }
})
