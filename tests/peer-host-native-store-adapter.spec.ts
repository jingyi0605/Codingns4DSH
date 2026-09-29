import assert from 'node:assert/strict'
import test from 'node:test'
import { installPeerHostNativeStoreAdapter } from '../data/build/dist/client/peer-host-native-store-adapter.js'

function store<T>(value: T) {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    publish(next: T) { value = next; for (const listener of listeners) listener() },
  }
}

test('原生列表 Store 投影本地与 PeerHost 工作区及会话，并保留远端标签', () => {
  const workspaceList = store({ items: [{ workspaceId: 'local-workspace', path: '/repo', title: '本地', sessionIds: ['local-session'] }] })
  const sessionList = store({ ids: ['local-session'], byId: { 'local-session': { id: 'local-session', displayTitle: '本地会话', running: false, retainedBy: {}, blank: false, updatedAt: 1 } }, phase: 'ready', projectionsBySession: {} })
  const workspaces = { list: workspaceList, insertBefore: async () => undefined }
  const sessions = { list: sessionList }
  const context = { get(name: string) { return name === 'workspaces' ? workspaces : name === 'sessions' ? sessions : undefined } } as never
  const adapter = installPeerHostNativeStoreAdapter({
    context,
    aggregate: [{ hostId: 'peer-a', targetHostId: 'peer-a', hostLabel: '开发机', availability: 'ready', errorCode: null, workspaces: [{ key: 'peer-a:w-1', hostId: 'peer-a', targetHostId: 'peer-a', workspaceId: 'w-1', displayName: '项目', hostLabel: '开发机', availability: 'ready', sessions: [{ scope: { hostId: 'peer-a', targetHostId: 'peer-a', workspaceId: 'w-1', sessionId: 's-1', scopeGeneration: 0 }, title: '远端会话', status: 'active', updatedAt: 2 }] }] }],
  })
  assert.equal(adapter.supported, true)
  const workspaceSnapshot = workspaces.list.getSnapshot()
  const sessionSnapshot = sessions.list.getSnapshot()
  assert.equal(workspaceSnapshot.items.length, 2)
  assert.match(String(workspaceSnapshot.items[1]?.title), /开发机/u)
  assert.equal(sessionSnapshot.ids.length, 2)
  assert.match(sessionSnapshot.byId[sessionSnapshot.ids[1]!]!.displayTitle, /开发机/u)
  adapter.dispose()
  assert.equal(workspaces.list, workspaceList)
  assert.equal(sessions.list, sessionList)
})

test('远端 Workspace 的原生拖拽排序路由到 CodingNS Host', async () => {
  const workspaceList = store({ items: [] })
  const sessionList = store({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  const calls: Array<[string, string | null]> = []
  const workspaces = { list: workspaceList, insertBefore: async () => undefined }
  const sessions = { list: sessionList }
  const context = { get(name: string) { return name === 'workspaces' ? workspaces : name === 'sessions' ? sessions : undefined } } as never
  const adapter = installPeerHostNativeStoreAdapter({
    context,
    aggregate: [{ hostId: 'peer-a', targetHostId: 'peer-a', hostLabel: '开发机', availability: 'ready', errorCode: null, workspaces: [{ key: 'peer-a:w-1', hostId: 'peer-a', targetHostId: 'peer-a', workspaceId: 'w-1', displayName: '项目', hostLabel: '开发机', availability: 'ready', sessions: [] }] }],
    moveWorkspace: async (workspaceId, beforeWorkspaceId) => { calls.push([workspaceId, beforeWorkspaceId]); return [] },
  })
  const virtualId = String(workspaces.list.getSnapshot().items[0]?.workspaceId)
  await workspaces.insertBefore?.(virtualId, undefined)
  assert.deepEqual(calls, [[virtualId, null]])
  adapter.dispose()
})
