import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVirtualSessionId,
  createVirtualWorkspaceId,
  parseVirtualSessionId,
  parseVirtualWorkspaceId,
} from '../data/build/dist/shared/index.js'
import { VirtualWorkspaceRegistry } from '../data/build/dist/host/modules/peer-host/peer-host-virtual-registry.js'

const result = (hostId: string, targetHostId: string | null, workspaceId: string, sessionId: string) => ({
  hostId,
  targetHostId,
  hostLabel: targetHostId === null ? '当前 Host' : hostId,
  availability: 'ready' as const,
  errorCode: null,
  workspaces: [{
    key: `${hostId}:${workspaceId}`,
    hostId,
    targetHostId,
    workspaceId,
    displayName: workspaceId,
    hostLabel: targetHostId === null ? '当前 Host' : hostId,
    availability: 'ready' as const,
    sessions: [{
      scope: { hostId, targetHostId, workspaceId, sessionId, scopeGeneration: 0 },
      title: sessionId,
      status: 'active',
      updatedAt: 1,
    }],
  }],
})

test('虚拟资源 ID 可逆，Host 和资源 ID 中含冒号时不碰撞', () => {
  const workspaceId = createVirtualWorkspaceId('peer:a', 'workspace:b')
  const sessionId = createVirtualSessionId('peer:a', 'session:b')
  assert.deepEqual(parseVirtualWorkspaceId(workspaceId), {
    virtualWorkspaceId: workspaceId,
    hostId: 'peer:a',
    targetHostId: 'peer:a',
    workspaceId: 'workspace:b',
  })
  assert.deepEqual(parseVirtualSessionId(sessionId), { hostId: 'peer:a', sessionId: 'session:b' })
  assert.equal(parseVirtualWorkspaceId('not-a-virtual-id'), null)
})

test('Registry 为不同 Host 的同名 Workspace/Session 建立独立路由', () => {
  const registry = new VirtualWorkspaceRegistry()
  registry.replace([result('local-host', null, 'w-1', 's-1'), result('peer-a', 'peer-a', 'w-1', 's-1')])
  const workspaces = registry.list()
  assert.equal(workspaces.length, 2)
  assert.notEqual(workspaces[0]!.virtualWorkspaceId, workspaces[1]!.virtualWorkspaceId)
  const remote = workspaces.find((item) => item.source === 'peer')!
  const sessions = registry.listSessions(remote.virtualWorkspaceId)
  assert.equal(sessions.length, 1)
  assert.equal(registry.resolveSession(sessions[0]!.virtualSessionId)?.targetHostId, 'peer-a')
})

test('Registry 保留混合 Workspace 顺序并持久化 move 结果', async () => {
  let saved: unknown = null
  const registry = new VirtualWorkspaceRegistry({
    orderStore: {
      load: () => ({ version: 1, orderedWorkspaceIds: [] }),
      save: (order) => { saved = order },
    },
  })
  registry.replace([result('local-host', null, 'w-local', 's-local'), result('peer-a', 'peer-a', 'w-remote', 's-remote')])
  const [local, remote] = registry.listWorkspaceIds()
  assert.ok(local && remote)
  await registry.move(remote, local)
  assert.deepEqual(registry.listWorkspaceIds(), [remote, local])
  assert.deepEqual(saved, { version: 1, orderedWorkspaceIds: [remote, local] })
})

test('Registry hydrate 过滤未知顺序项并追加新 Workspace', async () => {
  const registry = new VirtualWorkspaceRegistry({ orderStore: {
    load: () => ({ version: 1, orderedWorkspaceIds: ['missing', createVirtualWorkspaceId('peer-a', 'w-2')] }),
    save: () => undefined,
  } })
  registry.replace([result('peer-a', 'peer-a', 'w-1', 's-1'), result('peer-a', 'peer-a', 'w-2', 's-2')])
  await registry.hydrateOrder()
  assert.deepEqual(registry.listWorkspaceIds(), [createVirtualWorkspaceId('peer-a', 'w-2'), createVirtualWorkspaceId('peer-a', 'w-1')])
})

test('远端 Workspace 暂时离线后恢复到原混合顺序', () => {
  const registry = new VirtualWorkspaceRegistry()
  const local = result('local-host', null, 'w-local', 's-local')
  const remote = result('peer-a', 'peer-a', 'w-remote', 's-remote')
  registry.replace([local, remote])
  const [localId, remoteId] = registry.listWorkspaceIds()
  assert.ok(localId && remoteId)
  registry.replace([local])
  assert.deepEqual(registry.listWorkspaceIds(), [localId])
  assert.deepEqual(registry.listPersistedWorkspaceIds(), [localId, remoteId])
  registry.replace([local, remote])
  assert.deepEqual(registry.listWorkspaceIds(), [localId, remoteId])
})
