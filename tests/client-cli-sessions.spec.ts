import assert from 'node:assert/strict'
import test from 'node:test'
import { adapterCatalogWithDsh, archiveCliSession, listCliSessions, restoreCliSession } from '../data/build/dist/client/cli-catalog.js'
import { getModelCatalogCache, loadModelCatalog } from '../data/build/dist/client/model-catalog-cache.js'
import type { CodingNsCliAdapterDescriptor, CodingNsCliSessionRecord } from '../data/build/dist/shared/contracts/cli-adapter.js'

const record: CodingNsCliSessionRecord = {
  dshSessionId: 'dsh-session-1',
  adapterId: 'codex',
  providerSessionId: 'thread-1',
  modelId: 'gpt-5-codex',
  effortId: 'high',
  title: '修复登录问题',
  status: 'idle',
  createdAt: '2026-09-22T08:00:00.000Z',
  updatedAt: '2026-09-22T08:01:00.000Z',
}

test('对话框适配器目录只保留已安装且已启用的适配器', () => {
  const catalog: CodingNsCliAdapterDescriptor[] = [
    { id: 'installed-enabled', name: '可用', installed: true, enabled: true, version: '1.0.0', command: 'available' },
    { id: 'not-installed', name: '未安装', installed: false, enabled: true, version: null, command: null },
    { id: 'disabled', name: '已停用', installed: true, enabled: false, version: '1.0.0', command: 'disabled' },
  ]

  assert.deepEqual(adapterCatalogWithDsh(catalog).map((adapter) => adapter.id), ['dsh', 'installed-enabled'])
})

test('委派目录显示当前 DSH 版本并覆盖目录中的旧 dsh 版本', () => {
  const catalog: CodingNsCliAdapterDescriptor[] = [
    { id: 'dsh', name: 'DeepSeek Harness', installed: true, enabled: true, version: null, command: null },
    { id: 'opencode', name: 'OpenCode', installed: true, enabled: true, version: '1.0.0', command: 'opencode' },
  ]

  assert.equal(adapterCatalogWithDsh(catalog, '0.2.0-rc.2').find((adapter) => adapter.id === 'dsh')?.version, '0.2.0-rc.2')
  assert.equal(adapterCatalogWithDsh(catalog.filter((adapter) => adapter.id !== 'dsh'), '0.2.0-rc.2')[0]?.version, '0.2.0-rc.2')
})

test('Client 会话列表兼容 Host 的 items 包装并过滤不完整记录', async () => {
  const rpc = {
    call: async (_channel: string, endpoint: string) => {
      assert.equal(endpoint, 'cli/session/list')
      return { ok: true as const, value: { items: [{ ...record, rawStoreRef: '/host/private/session.jsonl' }, { dshSessionId: 'missing' }] } }
    },
  }
  assert.deepEqual(await listCliSessions(rpc), [record])
})

test('委派模型目录复用对话框缓存并保留思考强度标签', async () => {
  let calls = 0
  const rpc = {
    call: async (_channel: string, endpoint: string) => {
      assert.equal(endpoint, 'cli/models')
      calls += 1
      return {
        ok: true as const,
        value: {
          groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'gpt', name: 'GPT', efforts: ['low', 'high'], effortLabels: { low: '快速', high: '深入' } }] }],
          currentModel: 'gpt',
          currentEffort: 'high',
        },
      }
    },
  }
  const first = await loadModelCatalog(rpc, 'codex', 'session-1')
  const second = await loadModelCatalog(rpc, 'codex', 'session-1')
  assert.equal(calls, 1)
  assert.equal(getModelCatalogCache(rpc).get('codex'), second)
  assert.deepEqual(second.groups[0]?.models[0]?.effortLabels, { low: '快速', high: '深入' })
  assert.equal(first, second)
})

test('Client 不缓存模型目录回退值，产品目录恢复后可重新读取', async () => {
  let calls = 0
  const rpc = {
    call: async (_channel: string, endpoint: string) => {
      assert.equal(endpoint, 'cli/models')
      calls += 1
      return {
        ok: true as const,
        value: calls === 1
          ? {
              groups: [{ id: 'codebuddy', name: 'CodeBuddy', models: [{ id: 'provider-default', name: '跟随默认模型', efforts: [] }] }],
              currentModel: null,
              currentEffort: null,
              fallback: true,
            }
          : {
              groups: [{ id: 'codebuddy', name: 'CodeBuddy', models: [{ id: 'hy3', name: 'Hy3', efforts: [] }] }],
              currentModel: 'hy3',
              currentEffort: null,
            },
      }
    },
  }

  const fallback = await loadModelCatalog(rpc, 'codebuddy')
  const recovered = await loadModelCatalog(rpc, 'codebuddy')
  assert.equal(fallback.fallback, true)
  assert.equal(recovered.groups[0]?.models[0]?.id, 'hy3')
  assert.equal(calls, 2)
  assert.equal(getModelCatalogCache(rpc).get('codebuddy'), recovered)
})

test('恢复外部会话先保存选择和 provider 绑定', async () => {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      return { ok: true as const, value: {} }
    },
  }
  await restoreCliSession(rpc, record)
  assert.deepEqual(calls, [{
    endpoint: 'cli/session/set',
    payload: {
      sessionId: 'dsh-session-1',
      adapterId: 'codex',
      modelId: 'gpt-5-codex',
      effortId: 'high',
      providerSessionId: 'thread-1',
    },
  }])
})

test('移除外部会话调用 Host 的原生归档链路', async () => {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc = {
    call: async (_channel: string, endpoint: string, payload: unknown) => {
      calls.push({ endpoint, payload })
      return { ok: true as const, value: {} }
    },
  }

  await archiveCliSession(rpc, record.dshSessionId)

  assert.deepEqual(calls, [{
    endpoint: 'cli/session/archive',
    payload: { sessionId: 'dsh-session-1' },
  }])
})

test('Client 目录缓存超过 TTL 后重新读取，供应商切换不再被永久缓存', async () => {
  const {
    MODEL_CATALOG_CACHE_TTL_MS,
    invalidateModelCatalogCache,
    shouldRevalidateModelCatalog,
  } = await import('../data/build/dist/client/model-catalog-cache.js')
  let calls = 0
  const rpc = {
    call: async (_channel: string, endpoint: string) => {
      assert.equal(endpoint, 'cli/models')
      calls += 1
      return {
        ok: true as const,
        value: {
          groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'gpt-6.1-sol', name: 'GPT', efforts: ['high'], serviceTiers: [{ id: 'priority', name: 'Fast' }] }] }],
          currentModel: null,
          currentEffort: null,
          // 第一次是第三方配置，第二次已切回官方订阅。
          officialSubscription: calls > 1,
          defaultServiceTier: 'default',
        },
      }
    },
  }

  const before = await loadModelCatalog(rpc, 'codex', 'session-tier')
  assert.equal(before.officialSubscription, false)
  assert.equal(calls, 1)

  // TTL 内命中缓存：不重复请求。
  const cachedAgain = await loadModelCatalog(rpc, 'codex', 'session-tier')
  assert.equal(cachedAgain, before)
  assert.equal(calls, 1)

  // 显式失效（选择器在“判定可能过期”时会调用它）后必须重新请求。
  invalidateModelCatalogCache(rpc, 'codex')
  const after = await loadModelCatalog(rpc, 'codex', 'session-tier')
  assert.equal(calls, 2)
  assert.equal(after.officialSubscription, true)
  assert.equal(canSelectServiceTierForTest(after), true)

  // 复检节流：同一适配器首次允许复检，间隔内再次请求必须被挡下，
  // 避免真实第三方接入在每次挂载时反复探测。
  assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', true), true)
  assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', true), false)
  // 不需要复检时一律返回 false，且不占用节流窗口。
  assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', false), false)
  // 节流按适配器隔离：另一个适配器不受影响。
  assert.equal(shouldRevalidateModelCatalog(rpc, 'claude-code', true), true)
  assert.equal(MODEL_CATALOG_CACHE_TTL_MS, 60_000)
})

function canSelectServiceTierForTest(catalog: { officialSubscription?: boolean, groups: readonly { models: readonly { serviceTiers?: readonly unknown[] }[] }[] }): boolean {
  return catalog.officialSubscription === true
    && catalog.groups.some((group) => group.models.some((model) => (model.serviceTiers?.length ?? 0) > 0))
}

test('复检节流不会吞掉主流程的失效判定（轮询与主流程共用同一窗口）', async () => {
  const {
    invalidateModelCatalogCache,
    shouldRevalidateModelCatalog,
  } = await import('../data/build/dist/client/model-catalog-cache.js')
  const { needsServiceTierRevalidation } = await import('../data/build/dist/client/service-tier.js')
  let calls = 0
  const rpc = {
    call: async () => {
      calls += 1
      return {
        ok: true as const,
        value: {
          groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'm', name: 'M', efforts: [], serviceTiers: [{ id: 'priority', name: 'Fast' }] }] }],
          currentModel: null,
          currentEffort: null,
          // 第一次第三方、第二次官方订阅。
          officialSubscription: calls > 1,
          defaultServiceTier: 'default',
        },
      }
    },
  }

  const first = await loadModelCatalog(rpc, 'codex', 'session-poll')
  assert.equal(first.officialSubscription, false)
  assert.equal(needsServiceTierRevalidation(first), true)

  // 主流程（选择器 effect）必须能拿到这一轮复检许可，否则轮询触发重跑后
  // 仍会复用旧缓存，用户切回官方订阅后开关永远不出现。
  assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', needsServiceTierRevalidation(first)), true)
  invalidateModelCatalogCache(rpc, 'codex')
  const healed = await loadModelCatalog(rpc, 'codex', 'session-poll')
  assert.equal(healed.officialSubscription, true)

  // 恢复后不再需要复检，也不应继续占用窗口。
  assert.equal(needsServiceTierRevalidation(healed), false)
  assert.equal(shouldRevalidateModelCatalog(rpc, 'codex', needsServiceTierRevalidation(healed)), false)
})
