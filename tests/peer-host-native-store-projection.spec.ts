import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostNativeProjection } from '../data/build/dist/client/peer-host-native-projection.js'
import { installPeerHostNativeStoreProjection, refreshPeerHostNativeSessions } from '../data/build/dist/client/peer-host-native-store-projection.js'
import { createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'

interface FakeNativeStores {
  readonly list: {
    getSnapshot: () => Record<string, unknown>
    subscribe: (listener: () => void) => () => void
    set: (next: Record<string, unknown>) => void
  }
  readonly uiContext: { get: (name: string) => unknown }
  notifyLocal(): void
  refreshCount(): number
}

function fakeNativeStores(): FakeNativeStores {
  const listeners = new Set<() => void>()
  let value: Record<string, unknown> = {
    phase: 'ready',
    state: 'ready',
    items: [{
      workspaceId: 'local-workspace',
      path: '/repo',
      title: '本机工作区',
      sessionIds: ['local-session'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    archivedSessionIds: ['archived-session'],
    pinnedSessionIds: [],
  }
  let refreshes = 0
  const list = {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next: Record<string, unknown>) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
  const services: Record<string, unknown> = { workspaces: { list }, sessions: { refresh: async () => { refreshes += 1 } } }
  return {
    list,
    uiContext: { get: (name: string) => services[name] },
    notifyLocal: () => { for (const listener of [...listeners]) listener() },
    refreshCount: () => refreshes,
  }
}

function remoteWorkspace(): Record<string, unknown> {
  return {
    hostId: 'host-local',
    targetHostId: 'peer-1',
    hostLabel: '开发机',
    availability: 'ready',
    errorCode: null,
    workspaces: [{
      key: 'peer-1:workspace-1',
      hostId: 'host-local',
      targetHostId: 'peer-1',
      workspaceId: 'workspace-1',
      displayName: '远端工作区',
      hostLabel: '开发机',
      availability: 'ready',
      sessions: [{
        scope: { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
        title: '远端会话',
        status: 'idle',
        updatedAt: 10,
      }],
    }],
  }
}

test('虚拟工作区就地并入原生 Workspace Store，卸载后还原', () => {
  const stores = fakeNativeStores()
  const projection = createPeerHostNativeProjection()
  // 原生侧栏持有的是这个对象本身：投影必须改写它，而不是替换服务属性。
  const listRef = stores.list
  const dispose = installPeerHostNativeStoreProjection({ uiContext: stores.uiContext as never, projection })

  projection.setAggregate([remoteWorkspace()] as never)
  const merged = listRef.getSnapshot()
  assert.deepEqual((merged.items as Array<Record<string, unknown>>).map((item) => item.workspaceId), [
    'local-workspace',
    createVirtualWorkspaceId('peer-1', 'workspace-1'),
  ])
  // 本机快照的其余字段保持原样。
  assert.deepEqual(merged.archivedSessionIds, ['archived-session'])
  assert.equal(merged.phase, 'ready')

  dispose()
  assert.deepEqual((listRef.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), ['local-workspace'])
})

test('合并后的快照引用稳定：聚合未变时不产生新对象', () => {
  const stores = fakeNativeStores()
  const projection = createPeerHostNativeProjection()
  installPeerHostNativeStoreProjection({ uiContext: stores.uiContext as never, projection })
  projection.setAggregate([remoteWorkspace()] as never)

  const first = stores.list.getSnapshot()
  assert.equal(stores.list.getSnapshot(), first)
  // 内容相同的重复聚合不改变引用，useSyncExternalStore 不会误判为更新。
  projection.setAggregate([remoteWorkspace()] as never)
  assert.equal(stores.list.getSnapshot(), first)
  projection.setAggregate([] as never)
  assert.notEqual(stores.list.getSnapshot(), first)
})

test('Store 订阅同时转发原生与聚合变化，聚合无变化时不重复注入', () => {
  const stores = fakeNativeStores()
  const projection = createPeerHostNativeProjection()
  installPeerHostNativeStoreProjection({ uiContext: stores.uiContext as never, projection })

  let notified = 0
  stores.list.subscribe(() => { notified += 1 })
  stores.notifyLocal()
  assert.equal(notified, 1)
  projection.setAggregate([remoteWorkspace()] as never)
  assert.equal(notified, 2)
  assert.equal(projection.setAggregate([remoteWorkspace()] as never), false)
  assert.equal(notified, 2)
})

test('聚合变化触发一次原生会话列表刷新', async () => {
  const stores = fakeNativeStores()
  await refreshPeerHostNativeSessions(stores.uiContext as never)
  assert.equal(stores.refreshCount(), 1)
  await refreshPeerHostNativeSessions(undefined)
  assert.equal(stores.refreshCount(), 1)
})

test('原生服务不可用时投影与刷新保持空操作', async () => {
  const dispose = installPeerHostNativeStoreProjection({
    uiContext: { get: () => undefined } as never,
    projection: createPeerHostNativeProjection(),
  })
  assert.equal(typeof dispose, 'function')
  dispose()
  await refreshPeerHostNativeSessions({ get: () => undefined } as never)
})
