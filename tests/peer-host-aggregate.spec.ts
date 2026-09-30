import assert from 'node:assert/strict'
import test from 'node:test'
import { createAggregateHostSource, PeerHostAggregateService } from '../data/build/dist/host/modules/peer-host/peer-host-aggregate-service.js'

const workspace = (workspaceId: string, sessionId: string) => ({ workspaceId, displayName: '同名项目', sessions: [{ sessionId, title: '同名会话', status: 'active', updatedAt: 1 }] })

test('聚合并发加载当前 Host 和 PeerHost，同名资源使用 Host 作用域 key', async () => {
  const service = new PeerHostAggregateService(100)
  const results = await service.load([
    { hostId: 'host-local', targetHostId: null, hostLabel: '当前 Host', load: async () => [workspace('w-1', 's-1')] },
    { hostId: 'peer-1', targetHostId: 'peer-1', hostLabel: '开发机', load: async () => [workspace('w-1', 's-1')] },
  ])
  assert.equal(results.length, 2)
  assert.notEqual(results[0]!.workspaces[0]!.key, results[1]!.workspaces[0]!.key)
  assert.deepEqual(results[1]!.workspaces[0]!.sessions[0]!.scope, { hostId: 'peer-1', targetHostId: 'peer-1', workspaceId: 'w-1', sessionId: 's-1', scopeGeneration: 0 })
})

test('单个 PeerHost 失败保留错误节点，不阻塞其他 Host', async () => {
  const service = new PeerHostAggregateService(100)
  const results = await service.load([
    { hostId: 'host-local', targetHostId: null, hostLabel: '当前 Host', load: async () => [workspace('w-1', 's-1')] },
    { hostId: 'peer-down', targetHostId: 'peer-down', hostLabel: '离线机', load: async () => { throw new Error('down') } },
  ])
  assert.equal(results[0]!.availability, 'ready')
  assert.equal(results[1]!.availability, 'unreachable')
  assert.equal(results[1]!.errorCode, 'PEER_HOST_UNREACHABLE')
  assert.deepEqual(results[1]!.workspaces, [])
})

test('慢 Host 超时只标记自身不可达', async () => {
  const service = new PeerHostAggregateService(5)
  const results = await service.load([{ hostId: 'peer-slow', targetHostId: 'peer-slow', hostLabel: '慢机', load: async () => new Promise(() => undefined) }])
  assert.equal(results[0]!.availability, 'unreachable')
})

test('Host 没有稳定 workspace/session source 时保留 unsupported 诊断', async () => {
  const service = new PeerHostAggregateService(100)
  const source = createAggregateHostSource({
    hostId: 'host-local',
    targetHostId: null,
    hostLabel: '当前 Host',
    source: {
      capabilityId: 'peer-host.native-workspace-session-summary',
      available: false,
      reason: 'DSH 未暴露稳定 workspace/session 摘要接口',
      async load() { throw new Error('不可调用') },
    },
  })
  const [result] = await service.load([source])
  assert.equal(result?.availability, 'unsupported')
  assert.equal(result?.errorCode, null)
  assert.equal(result?.diagnostic, 'DSH 未暴露稳定 workspace/session 摘要接口')
  assert.deepEqual(result?.workspaces, [])
})

test('显式摘要 source 可转为 HostScope 聚合节点', async () => {
  const service = new PeerHostAggregateService(100)
  const source = createAggregateHostSource({
    hostId: 'host-local',
    targetHostId: null,
    hostLabel: '当前 Host',
    source: {
      capabilityId: 'peer-host.native-workspace-session-summary',
      available: true,
      async load() { return [workspace('w-1', 's-1')] },
    },
  })
  const [result] = await service.load([source])
  assert.equal(result?.availability, 'ready')
  assert.equal(result?.diagnostic, undefined)
  assert.equal(result?.workspaces[0]?.sessions[0]?.scope.hostId, 'host-local')
})

test('归档会话带独立作用域，不混入可见会话列表', async () => {
  const service = new PeerHostAggregateService(100)
  const source = createAggregateHostSource({
    hostId: 'peer-1',
    targetHostId: 'peer-1',
    hostLabel: '开发机',
    source: {
      capabilityId: 'peer-host.native-workspace-session-summary',
      available: true,
      async load() {
        return [{
          workspaceId: 'w-1',
          displayName: '项目',
          path: '/repo',
          sessions: [{ sessionId: 's-visible', title: '可见', status: 'idle', updatedAt: 1 }],
          archivedSessions: [{ sessionId: 's-archived', title: '归档', status: 'idle', updatedAt: 2 }],
        }]
      },
    },
  })
  const [result] = await service.load([source])
  const summary = result?.workspaces[0]
  assert.deepEqual(summary?.sessions.map((session) => session.scope.sessionId), ['s-visible'])
  assert.deepEqual(summary?.archivedSessions?.map((session) => session.scope.sessionId), ['s-archived'])
  assert.deepEqual(summary?.archivedSessions?.[0]?.scope, {
    hostId: 'peer-1',
    targetHostId: 'peer-1',
    workspaceId: 'w-1',
    sessionId: 's-archived',
    scopeGeneration: 0,
  })
  assert.equal(summary?.archivedSessions?.[0]?.title, '归档')
})
