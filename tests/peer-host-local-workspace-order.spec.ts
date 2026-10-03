import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureLocalWorkspaceSummaries } from '../data/build/dist/host/features/peer-host.js'
import { createVirtualWorkspaceId } from '../data/build/dist/shared/index.js'

test('本地摘要暂时为空时仍把 Registry 工作区纳入混合顺序', () => {
  const results = ensureLocalWorkspaceSummaries([
    {
      hostId: 'host-local',
      targetHostId: null,
      hostLabel: '当前 Host',
      availability: 'ready',
      errorCode: null,
      workspaces: [],
    },
    {
      hostId: 'host-local',
      targetHostId: 'peer-1',
      hostLabel: '远端 Host',
      availability: 'ready',
      errorCode: null,
      workspaces: [{
        key: 'peer-1:remote-a',
        hostId: 'host-local',
        targetHostId: 'peer-1',
        workspaceId: 'remote-a',
        displayName: '远端 A',
        path: '/remote/a',
        hostLabel: '远端 Host',
        availability: 'ready',
        sessions: [],
      }],
    },
  ], {
    get(name: string) {
      if (name !== 'workspaceRegistry') return undefined
      return {
        list: () => [{ id: 'local-a', title: '本地 A', path: '/local/a' }, { id: 'local-b', title: '本地 B', path: '/local/b' }],
      }
    },
  } as never)

  assert.deepEqual(results[0]?.workspaces.map((workspace) => workspace.workspaceId), ['local-a', 'local-b'])
  assert.equal(results[0]?.workspaces[0]?.displayName, '本地 A')
  assert.equal(results[1]?.workspaces[0]?.workspaceId, 'remote-a')
  assert.deepEqual([
    createVirtualWorkspaceId('host-local', 'local-a'),
    createVirtualWorkspaceId('host-local', 'local-b'),
  ], [
    createVirtualWorkspaceId(results[0]!.hostId, results[0]!.workspaces[0]!.workspaceId),
    createVirtualWorkspaceId(results[0]!.hostId, results[0]!.workspaces[1]!.workspaceId),
  ])
})
