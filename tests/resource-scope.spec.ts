import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ResourceScopeManager,
  ResourceScopeStaleError,
} from '../data/build/dist/features/resource-scope/index.js'

const scope = {
  hostId: 'host-a',
  workspaceId: 'workspace-a',
  targetHostId: null,
}

test('首次切换分配 generation，作用域字段保持原样', async () => {
  const manager = new ResourceScopeManager()
  const current = await manager.switchTo(scope)

  assert.deepEqual(current, { ...scope, scopeGeneration: 1 })
  assert.deepEqual(manager.getCurrent(), current)
})

test('跨 Host 或工作区切换会递增 generation 并先清理旧 disposer', async () => {
  const manager = new ResourceScopeManager(scope)
  const events: string[] = []
  const old = manager.getCurrent()!
  manager.addDisposer(() => {
    events.push('disposed')
  })

  const next = await manager.switchTo({
    hostId: 'peer-host',
    workspaceId: 'workspace-b',
    targetHostId: 'peer-host',
  })

  assert.equal(next.scopeGeneration, old.scopeGeneration + 1)
  assert.deepEqual(events, ['disposed'])
  assert.equal(manager.isCurrent(old), false)
  assert.equal(manager.isCurrent(next), true)
})

test('旧 disposer 执行期间当前作用域为空，旧快照始终被拒绝', async () => {
  const manager = new ResourceScopeManager(scope)
  const old = manager.getCurrent()!
  let invalidatedBeforeDispose = false
  manager.addDisposer(() => {
    invalidatedBeforeDispose = manager.getCurrent() === null && !manager.isCurrent(old)
  })

  await manager.switchTo({ ...scope, workspaceId: 'workspace-b' })

  assert.equal(invalidatedBeforeDispose, true)
})

test('旧作用域不能回写新作用域，当前作用域可以提交', async () => {
  const manager = new ResourceScopeManager(scope)
  const old = manager.getCurrent()!
  await manager.switchTo({ ...scope, workspaceId: 'workspace-b' })

  assert.throws(
    () => manager.commitIfCurrent(old, () => 'stale'),
    (error) => error instanceof ResourceScopeStaleError && error.code === 'RESOURCE_SCOPE_STALE',
  )

  const current = manager.getCurrent()!
  assert.equal(manager.commitIfCurrent(current, () => 'accepted'), 'accepted')
  assert.throws(
    () => manager.registerDisposer(old, () => undefined),
    ResourceScopeStaleError,
  )
})

test('并发切换按调用顺序串行执行，旧 disposer 只执行一次', async () => {
  const manager = new ResourceScopeManager(scope)
  const events: string[] = []
  manager.addDisposer(async () => {
    await Promise.resolve()
    events.push('old-disposed')
  })

  const first = manager.switchTo({ ...scope, workspaceId: 'workspace-b' })
  const second = manager.switchTo({ ...scope, workspaceId: 'workspace-c' })
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second])

  assert.equal(firstSnapshot.workspaceId, 'workspace-b')
  assert.equal(secondSnapshot.workspaceId, 'workspace-c')
  assert.equal(secondSnapshot.scopeGeneration, firstSnapshot.scopeGeneration + 1)
  assert.deepEqual(events, ['old-disposed'])
})

test('clear 会使当前作用域失效并关闭 disposer', async () => {
  const manager = new ResourceScopeManager(scope)
  const current = manager.getCurrent()!
  let disposed = 0
  manager.addDisposer(() => {
    disposed += 1
  })

  await manager.clear()

  assert.equal(disposed, 1)
  assert.equal(manager.getCurrent(), null)
  assert.equal(manager.isCurrent(current), false)
  await manager.clear()
})

test('非法作用域输入被拒绝', () => {
  const manager = new ResourceScopeManager()
  assert.throws(() => manager.switchTo({ ...scope, hostId: ' ' }), TypeError)
  assert.throws(() => manager.switchTo({ ...scope, targetHostId: '' }), TypeError)
})
