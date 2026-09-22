import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingNsCliAdapterRegistry } from '../dist/host/cli-adapters/registry.js'
import type { CodingNsCliModelCatalog } from '../dist/shared/contracts/cli-adapter.js'

test('Agent 安装状态在 Host 启动后预热并按未安装短周期自动刷新', async () => {
  let detections = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() {
      detections += 1
      return detections === 1
        ? { installed: false, version: null, command: null }
        : { installed: true, version: '2.0.0', command: 'fake' }
    },
    async listModels() { return catalog('model-1') },
    async *executeTurn() { yield { type: 'finish' as const, reason: 'stop' as const } },
  }], {}, {
    installedCacheTtlMs: 1_000,
    uninstalledCacheTtlMs: 20,
  })

  try {
    registry.warmCatalog()
    await waitFor(async () => (await registry.catalog())[0]?.installed === false)
    assert.equal(detections, 1)
    await waitFor(async () => (await registry.catalog())[0]?.installed === true)
    assert.equal((await registry.catalog())[0]?.version, '2.0.0')
  } finally {
    await registry.dispose()
  }
})

test('模型目录合并并发请求并在后台刷新失败时保留最后成功结果', async () => {
  let modelRequests = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'fake', name: 'Fake' },
    async detect() { return { installed: true, version: '1.0.0', command: 'fake' } },
    async listModels() {
      modelRequests += 1
      if (modelRequests === 1) {
        await delay(10)
        return catalog('model-1')
      }
      if (modelRequests === 2) throw new Error('临时目录故障')
      return catalog('model-2')
    },
    async *executeTurn() { yield { type: 'finish' as const, reason: 'stop' as const } },
  }], {}, {
    modelCacheTtlMs: 20,
    modelRetryTtlMs: 100,
  })

  try {
    const [first, second] = await Promise.all([registry.models('fake'), registry.models('fake')])
    assert.equal(firstModelId(first), 'model-1')
    assert.equal(firstModelId(second), 'model-1')
    assert.equal(modelRequests, 1)

    await waitFor(() => modelRequests >= 2)
    assert.equal(firstModelId(await registry.models('fake')), 'model-1')
    await waitFor(async () => firstModelId(await registry.models('fake')) === 'model-2')
  } finally {
    await registry.dispose()
  }
})

test('空模型目录和首次失败都按短周期在后台重试', async () => {
  let emptyRequests = 0
  const emptyRegistry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'empty', name: 'Empty' },
    async detect() { return { installed: true, version: '1.0.0', command: 'empty' } },
    async listModels() {
      emptyRequests += 1
      return emptyRequests === 1 ? emptyCatalog() : catalog('available-model')
    },
    async *executeTurn() { yield { type: 'finish' as const, reason: 'stop' as const } },
  }], {}, { modelRetryTtlMs: 20 })

  let failedRequests = 0
  const failedRegistry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'failed', name: 'Failed' },
    async detect() { return { installed: true, version: '1.0.0', command: 'failed' } },
    async listModels() {
      failedRequests += 1
      if (failedRequests === 1) throw new Error('首次读取失败')
      return catalog('recovered-model')
    },
    async *executeTurn() { yield { type: 'finish' as const, reason: 'stop' as const } },
  }], {}, { modelRetryTtlMs: 20 })

  try {
    assert.deepEqual(await emptyRegistry.models('empty'), emptyCatalog())
    await waitFor(async () => firstModelId(await emptyRegistry.models('empty')) === 'available-model')

    await assert.rejects(failedRegistry.models('failed'), /首次读取失败/u)
    await waitFor(async () => {
      try { return firstModelId(await failedRegistry.models('failed')) === 'recovered-model' }
      catch { return false }
    })
  } finally {
    await Promise.all([emptyRegistry.dispose(), failedRegistry.dispose()])
  }
})

test('CLI 路径或版本变化会废弃旧模型索引并自动重建', async () => {
  let detections = 0
  let modelRequests = 0
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'versioned', name: 'Versioned' },
    async detect() {
      detections += 1
      return {
        installed: true,
        version: detections === 1 ? '1.0.0' : '2.0.0',
        command: detections === 1 ? 'versioned-v1' : 'versioned-v2',
      }
    },
    async listModels() {
      modelRequests += 1
      return catalog(modelRequests === 1 ? 'old-model' : 'new-model')
    },
    async *executeTurn() { yield { type: 'finish' as const, reason: 'stop' as const } },
  }], {}, {
    installedCacheTtlMs: 20,
    modelCacheTtlMs: 1_000,
  })

  try {
    assert.equal((await registry.catalog())[0]?.version, '1.0.0')
    assert.equal(firstModelId(await registry.models('versioned')), 'old-model')
    await waitFor(async () => firstModelId(await registry.models('versioned')) === 'new-model')
    assert.ok(detections >= 2)
    assert.ok(modelRequests >= 2)
  } finally {
    await registry.dispose()
  }
})

test('CLI 版本变化后旧 generation 的迟到模型结果不能覆盖新索引', async () => {
  let detections = 0
  let modelRequests = 0
  let resolveOld: ((value: CodingNsCliModelCatalog) => void) | undefined
  const oldCatalog = new Promise<CodingNsCliModelCatalog>((resolve) => { resolveOld = resolve })
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'racing', name: 'Racing' },
    async detect() {
      detections += 1
      return { installed: true, version: detections === 1 ? '1.0.0' : '2.0.0', command: 'racing' }
    },
    async listModels() {
      modelRequests += 1
      return modelRequests === 1 ? oldCatalog : catalog('new-model')
    },
    async *executeTurn() { yield { type: 'finish' as const, reason: 'stop' as const } },
  }], {}, {
    installedCacheTtlMs: 20,
    modelCacheTtlMs: 1_000,
  })

  try {
    await registry.catalog()
    const pending = registry.models('racing')
    await waitFor(() => detections >= 2 && modelRequests >= 2)
    resolveOld?.(catalog('old-model'))
    assert.equal(firstModelId(await pending), 'new-model')
    assert.equal(firstModelId(await registry.models('racing')), 'new-model')
  } finally {
    resolveOld?.(catalog('old-model'))
    await registry.dispose()
  }
})

function catalog(modelId: string): CodingNsCliModelCatalog {
  return {
    groups: [{ id: 'default', name: '默认', models: [{ id: modelId, name: modelId, efforts: [] }] }],
    currentModel: null,
    currentEffort: null,
  }
}

function emptyCatalog(): CodingNsCliModelCatalog {
  return { groups: [], currentModel: null, currentEffort: null }
}

function firstModelId(value: CodingNsCliModelCatalog): string | undefined {
  return value.groups[0]?.models[0]?.id
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(5)
  }
  assert.fail(`等待后台刷新超过 ${timeoutMs}ms`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
