import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostNativeProjection, createPeerHostWorkspaceDisplayPath } from '../data/build/dist/client/peer-host-native-projection.js'
import { installPeerHostNativeStoreProjection, refreshPeerHostNativeSessions } from '../data/build/dist/client/peer-host-native-store-projection.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'

interface FakeNativeStores {
  readonly list: {
    getSnapshot: () => Record<string, unknown>
    subscribe: (listener: () => void) => () => void
    set: (next: Record<string, unknown>) => void
  }
  readonly workspaces: {
    readonly list: FakeNativeStores['list']
    insertBefore: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void>
  }
  readonly sessionList: {
    getSnapshot: () => Record<string, unknown>
    subscribe: (listener: () => void) => () => void
  }
  readonly insertCalls: readonly { readonly workspaceId: string; readonly beforeWorkspaceId?: string }[]
  readonly uiContext: { get: (name: string) => unknown }
  notifyLocal(): void
  refreshCount(): number
}

function fakeNativeStores(items: readonly Record<string, unknown>[] = [{
  workspaceId: 'local-workspace',
  path: '/repo',
  title: '本机工作区',
  sessionIds: ['local-session'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}]): FakeNativeStores {
  const listeners = new Set<() => void>()
  let value: Record<string, unknown> = {
    phase: 'ready',
    state: 'ready',
    items,
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
  const insertCalls: Array<{ readonly workspaceId: string; readonly beforeWorkspaceId?: string }> = []
  const sessionList = {
    getSnapshot: () => ({
      phase: 'ready',
      ids: ['local-session'],
      byId: {
        'local-session': { id: 'local-session', cwd: '/repo', blank: true, retainedBy: {} },
      },
    }),
    subscribe: (_listener: () => void) => () => undefined,
  }
  const workspaces = {
    list,
    insertBefore: async (workspaceId: string, beforeWorkspaceId?: string): Promise<void> => {
      if (beforeWorkspaceId === undefined) insertCalls.push({ workspaceId })
      else insertCalls.push({ workspaceId, beforeWorkspaceId })
    },
  }
  const services: Record<string, unknown> = { workspaces, sessions: { list: sessionList, refresh: async () => { refreshes += 1 } } }
  return {
    list,
    workspaces,
    sessionList,
    insertCalls,
    uiContext: { get: (name: string) => services[name] },
    notifyLocal: () => { for (const listener of [...listeners]) listener() },
    refreshCount: () => refreshes,
  }
}

function localWorkspaceAggregate(): Record<string, unknown> {
  return {
    hostId: 'host-local',
    targetHostId: null,
    hostLabel: '当前 Host',
    availability: 'ready',
    errorCode: null,
    workspaces: [{
      key: 'host-local:local-a',
      hostId: 'host-local',
      targetHostId: null,
      workspaceId: 'local-a',
      displayName: '本机 A',
      path: '/repo/a',
      hostLabel: '当前 Host',
      availability: 'ready',
      sessions: [],
    }, {
      key: 'host-local:local-c',
      hostId: 'host-local',
      targetHostId: null,
      workspaceId: 'local-c',
      displayName: '本机 C',
      path: '/repo/c',
      hostLabel: '当前 Host',
      availability: 'ready',
      sessions: [],
    }],
  }
}

function remoteWorkspace(): Record<string, unknown> {
  return {
    hostId: 'host-local',
    targetHostId: 'peer-1',
    hostLabel: '开发机',
    hostColor: '#1677ff',
    availability: 'ready',
    errorCode: null,
    workspaces: [{
      key: 'peer-1:workspace-1',
      hostId: 'host-local',
      targetHostId: 'peer-1',
      workspaceId: 'workspace-1',
      displayName: '远端工作区',
      path: '/Users/dev/project-a',
      hostLabel: '开发机',
      hostColor: '#1677ff',
      availability: 'ready',
      sessions: [{
        scope: { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 0 },
        title: '远端会话',
        status: 'idle',
        updatedAt: 10,
      }],
      archivedSessions: [{
        scope: { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-archived', scopeGeneration: 0 },
        title: '远端归档会话',
        status: 'idle',
        updatedAt: 5,
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
  // 本机快照的其余字段保持原样，虚拟归档集合追加在本机归档之后。
  const virtualArchived = createVirtualSessionId('peer-1', 'session-archived')
  assert.deepEqual(merged.archivedSessionIds, ['archived-session', virtualArchived])
  assert.deepEqual((merged.items as Array<Record<string, unknown>>)[1]?.archivedSessionIds, [virtualArchived])
  assert.equal((merged.items as Array<Record<string, unknown>>)[1]?.path, createPeerHostWorkspaceDisplayPath(createVirtualWorkspaceId('peer-1', 'workspace-1')))
  assert.equal((merged.items as Array<Record<string, unknown>>)[1]?.workspacePath, '/Users/dev/project-a')
  assert.equal((merged.items as Array<Record<string, unknown>>)[1]?.hostLabel, '开发机')
  assert.equal((merged.items as Array<Record<string, unknown>>)[1]?.hostColor, '#1677ff')
  assert.equal(merged.phase, 'ready')

  dispose()
  assert.deepEqual((listRef.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), ['local-workspace'])
})

test('断线缓存移除不被底层旧快照复活，重连恢复最新成员', () => {
  const remoteId = createVirtualWorkspaceId('peer-1', 'workspace-1')
  const archivedId = createVirtualSessionId('peer-1', 'old-archived')
  const stores = fakeNativeStores([{ workspaceId: 'local-workspace', path: '/local', sessionIds: [] },
    { workspaceId: remoteId, path: '/old', title: '旧标题', sessionIds: ['old-session'] }])
  stores.list.set({ ...stores.list.getSnapshot(), archivedSessionIds: ['local-archived', archivedId] })
  const projection = createPeerHostNativeProjection()
  const dispose = installPeerHostNativeStoreProjection({ uiContext: stores.uiContext as never, projection })
  // 首轮聚合尚未返回时保留流提前登记的条目。
  assert.equal((stores.list.getSnapshot().items as unknown[]).length, 2)
  projection.setAggregate([{ ...remoteWorkspace(), availability: 'unreachable' }] as never)
  assert.deepEqual((stores.list.getSnapshot().items as any[])[1].sessionIds, projection.workspaces()[0]?.sessionIds)
  projection.setAggregate([])
  assert.deepEqual((stores.list.getSnapshot().items as any[]).map((item) => item.workspaceId), ['local-workspace'])
  assert.deepEqual(stores.list.getSnapshot().archivedSessionIds, ['local-archived'])
  projection.setAggregate([remoteWorkspace()] as never)
  assert.equal((stores.list.getSnapshot().items as any[])[1].title, '远端工作区')
  assert.deepEqual((stores.list.getSnapshot().items as any[])[1].sessionIds, projection.workspaces()[0]?.sessionIds)
  dispose()
})

test('底层 Remote 已经写入虚拟工作区时仍使用稳定显示路径', () => {
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  const stores = fakeNativeStores([{
    workspaceId: remote,
    path: '/Users/dev/local/project',
    title: '远端工作区',
    sessionIds: [],
  }])
  const projection = createPeerHostNativeProjection()
  installPeerHostNativeStoreProjection({ uiContext: stores.uiContext as never, projection })
  projection.setAggregate([remoteWorkspace()] as never, [remote])

  const item = (stores.list.getSnapshot().items as Array<Record<string, unknown>>)[0]
  assert.equal(item?.workspaceId, remote)
  assert.equal(item?.path, createPeerHostWorkspaceDisplayPath(remote))
})

test('本地与远端工作区按 Host 全局顺序混排，远端恢复后回到墓碑位置', () => {
  const stores = fakeNativeStores([
    { workspaceId: 'local-a', title: '本机 A' },
    { workspaceId: 'local-c', title: '本机 C' },
  ])
  const projection = createPeerHostNativeProjection()
  installPeerHostNativeStoreProjection({ uiContext: stores.uiContext as never, projection })
  const localA = createVirtualWorkspaceId('host-local', 'local-a')
  const localC = createVirtualWorkspaceId('host-local', 'local-c')
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  const order = [localA, remote, localC]
  projection.setAggregate([localWorkspaceAggregate(), remoteWorkspace()] as never, order)
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), [
    'local-a',
    remote,
    'local-c',
  ])

  // 远端暂时离线时只隐藏远端条目，本地相对顺序保持；恢复后仍按持久化顺序插回中间。
  projection.setAggregate([localWorkspaceAggregate()] as never, order)
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), ['local-a', 'local-c'])
  projection.setAggregate([localWorkspaceAggregate(), remoteWorkspace()] as never, [...order])
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), ['local-a', remote, 'local-c'])
})

test('工作区排序使用稳定显示路径，空白会话仍能复用真实 cwd', () => {
  const localA = createVirtualWorkspaceId('host-local', 'local-a')
  const localC = createVirtualWorkspaceId('host-local', 'local-c')
  const stores = fakeNativeStores([
    { workspaceId: 'local-a', path: '/Users/dev/root', title: '本机 A', sessionIds: ['local-session'] },
    { workspaceId: 'local-c', path: '/Users/dev/root/child', title: '本机 C', sessionIds: [] },
  ])
  const projection = createPeerHostNativeProjection()
  installPeerHostNativeStoreProjection({ uiContext: stores.uiContext as never, projection })
  projection.setAggregate([localWorkspaceAggregate()] as never, [localA, localC])

  const items = stores.list.getSnapshot().items as Array<Record<string, unknown>>
  assert.deepEqual(items.map((item) => item.path), ['/Users/dev/root', '/Users/dev/root/child'])
  const session = (stores.sessionList.getSnapshot().byId as Record<string, Record<string, unknown>>)['local-session']
  assert.equal(session?.cwd, '/Users/dev/root')
})

test('聚合与顺序快照不完整时保留原顺序，避免未知条目跳到末尾', () => {
  const stores = fakeNativeStores([
    { workspaceId: 'local-a', title: '本机 A' },
    { workspaceId: 'local-c', title: '本机 C' },
  ])
  const projection = createPeerHostNativeProjection()
  const dispose = installPeerHostNativeStoreProjection({ uiContext: stores.uiContext as never, projection })
  const localA = createVirtualWorkspaceId('host-local', 'local-a')
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  // 顺序响应缺少当前快照中的 local-c；这时不能按 MAX_SAFE_INTEGER 将它推到末尾。
  projection.setAggregate([localWorkspaceAggregate(), remoteWorkspace()] as never, [localA, remote])
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), [
    'local-a',
    'local-c',
    remote,
  ])
  dispose()
})

test('混合拖拽写入 Host 顺序，跨 Host 不把虚拟 ID发给原生 Controller', async () => {
  const stores = fakeNativeStores([
    { workspaceId: 'local-a', title: '本机 A' },
    { workspaceId: 'local-c', title: '本机 C' },
  ])
  const projection = createPeerHostNativeProjection()
  const localA = createVirtualWorkspaceId('host-local', 'local-a')
  const localC = createVirtualWorkspaceId('host-local', 'local-c')
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  const order = [localA, remote, localC]
  projection.setAggregate([localWorkspaceAggregate(), remoteWorkspace()] as never, order)
  const moves: Array<{ readonly source: string; readonly before: string | null }> = []
  const dispose = installPeerHostNativeStoreProjection({
    uiContext: stores.uiContext as never,
    projection,
    moveWorkspace: async (source, before) => {
      moves.push({ source, before })
      const next = order.filter((id) => id !== source)
      if (before === null) next.push(source)
      else next.splice(next.indexOf(before), 0, source)
      order.splice(0, order.length, ...next)
      return [...next]
    },
  })

  await stores.workspaces.insertBefore(remote, 'local-a')
  assert.deepEqual(moves.at(-1), { source: remote, before: localA })
  assert.deepEqual(stores.insertCalls, [])
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), [remote, 'local-a', 'local-c'])
  await stores.workspaces.insertBefore('local-a', remote)
  assert.deepEqual(moves.at(-1), { source: localA, before: remote })
  assert.deepEqual(stores.insertCalls, [])
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), ['local-a', remote, 'local-c'])
  await stores.workspaces.insertBefore('local-a', 'local-c')
  assert.deepEqual(moves.at(-1), { source: localA, before: localC })
  assert.deepEqual(stores.insertCalls, [{ workspaceId: 'local-a', beforeWorkspaceId: 'local-c' }])
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), [remote, 'local-a', 'local-c'])

  const patched = stores.workspaces.insertBefore
  dispose()
  assert.notEqual(stores.workspaces.insertBefore, patched)
  await stores.workspaces.insertBefore('local-a')
  assert.deepEqual(stores.insertCalls.at(-1), { workspaceId: 'local-a' })
})

test('顺序快照尚未包含远端项时仍提交虚拟顺序，不透传给原生 Controller', async () => {
  const stores = fakeNativeStores()
  const projection = createPeerHostNativeProjection()
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  const committed: Array<{ readonly source: string; readonly before: string | null }> = []
  const dispose = installPeerHostNativeStoreProjection({
    uiContext: stores.uiContext as never,
    projection,
    moveWorkspace: async (source, before) => {
      committed.push({ source, before })
      return [source]
    },
  })
  await stores.workspaces.insertBefore(remote)
  assert.deepEqual(committed, [{ source: remote, before: null }])
  assert.deepEqual(stores.insertCalls, [])
  dispose()
})

test('Host 顺序 RPC 未返回时先刷新本地布局，失败后回滚', async () => {
  const stores = fakeNativeStores([
    { workspaceId: 'local-a', title: '本机 A' },
    { workspaceId: 'local-c', title: '本机 C' },
  ])
  const projection = createPeerHostNativeProjection()
  const localA = createVirtualWorkspaceId('host-local', 'local-a')
  const localC = createVirtualWorkspaceId('host-local', 'local-c')
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  projection.setAggregate([localWorkspaceAggregate(), remoteWorkspace()] as never, [localA, localC, remote])
  let release!: (error?: Error) => void
  const pending = new Promise<readonly string[]>((resolve, reject) => {
    release = (error) => error === undefined ? resolve([remote, localA, localC]) : reject(error)
  })
  const dispose = installPeerHostNativeStoreProjection({
    uiContext: stores.uiContext as never,
    projection,
    moveWorkspace: async () => pending,
  })

  const moving = stores.workspaces.insertBefore(remote, 'local-a')
  await Promise.resolve()
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), [remote, 'local-a', 'local-c'])
  release(new Error('network failed'))
  await assert.rejects(moving, /network failed/u)
  assert.deepEqual((stores.list.getSnapshot().items as Array<Record<string, unknown>>).map((item) => item.workspaceId), ['local-a', 'local-c', remote])
  dispose()
})

test('首次拖拽不等待聚合刷新，Host 端解析本地裸 ID', async () => {
  const stores = fakeNativeStores([
    { workspaceId: 'local-a', title: '本机 A' },
    { workspaceId: 'local-c', title: '本机 C' },
  ])
  const projection = createPeerHostNativeProjection()
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  const localA = createVirtualWorkspaceId('host-local', 'local-a')
  const localC = createVirtualWorkspaceId('host-local', 'local-c')
  // 远端条目先由底层 Store 显示，但聚合投影还没有本地 Host ID 和顺序。
  projection.setAggregate([remoteWorkspace()] as never)
  const order = [localA, remote, localC]
  let refreshes = 0
  const moves: Array<{ readonly source: string; readonly before: string | null }> = []
  const dispose = installPeerHostNativeStoreProjection({
    uiContext: stores.uiContext as never,
    projection,
    refreshWorkspaceOrder: async () => {
      refreshes += 1
      projection.setAggregate([localWorkspaceAggregate(), remoteWorkspace()] as never, order)
      return order
    },
    moveWorkspace: async (source, before) => {
      moves.push({ source, before })
      const next = order.filter((id) => id !== source)
      if (before === null) next.push(source)
      else next.splice(next.indexOf(before), 0, source)
      order.splice(0, order.length, ...next)
      return [...next]
    },
  })

  await stores.workspaces.insertBefore(remote, 'local-a')
  assert.equal(refreshes, 0)
  assert.deepEqual(moves, [{ source: remote, before: 'local-a' }])
  dispose()
})

test('本地 Host ID 尚未到达时，本地裸 ID 仍可拖到远端', async () => {
  const stores = fakeNativeStores([{ workspaceId: 'local-a', title: '本机 A' }])
  const projection = createPeerHostNativeProjection()
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  const calls: Array<{ readonly source: string; readonly before: string | null }> = []
  const dispose = installPeerHostNativeStoreProjection({
    uiContext: stores.uiContext as never,
    projection,
    moveWorkspace: async (source, before) => {
      calls.push({ source, before })
      return [source, before].flatMap((id): string[] => id === null ? [] : [id])
    },
  })

  await stores.workspaces.insertBefore('local-a', remote)
  assert.deepEqual(calls, [{ source: 'local-a', before: remote }])
  assert.deepEqual(stores.insertCalls, [])
  dispose()
})

test('连续拖拽按请求顺序串行提交', async () => {
  const stores = fakeNativeStores([
    { workspaceId: 'local-a', title: '本机 A' },
    { workspaceId: 'local-c', title: '本机 C' },
  ])
  const projection = createPeerHostNativeProjection()
  const localA = createVirtualWorkspaceId('host-local', 'local-a')
  const localC = createVirtualWorkspaceId('host-local', 'local-c')
  const remote = createVirtualWorkspaceId('peer-1', 'workspace-1')
  const order = [localA, remote, localC]
  projection.setAggregate([localWorkspaceAggregate(), remoteWorkspace()] as never, order)
  let releaseFirst!: () => void
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve })
  const calls: string[] = []
  const dispose = installPeerHostNativeStoreProjection({
    uiContext: stores.uiContext as never,
    projection,
    moveWorkspace: async (source) => {
      calls.push(source)
      if (calls.length === 1) await firstDone
      return projection.workspaceOrder()
    },
  })
  const first = stores.workspaces.insertBefore(remote)
  const second = stores.workspaces.insertBefore('local-a', remote)
  await Promise.resolve()
  assert.deepEqual(calls, [remote])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(calls, [remote, localA])
  dispose()
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
  // 同一 uiContext 的短时间重复触发不能再次发出完整 session/list。
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
