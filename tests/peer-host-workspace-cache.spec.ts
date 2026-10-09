import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PeerHostWorkspaceCache } from '../src/host/modules/peer-host/peer-host-workspace-cache.js'
import { createPeerHostNativeProjection } from '../src/client/peer-host-native-projection.js'
import { VirtualWorkspaceRegistry } from '../src/host/modules/peer-host/peer-host-virtual-registry.js'
import type { AggregateHostResult, PeerHostRecord } from '../src/shared/contracts/peer-host.js'
import { createVirtualSessionId, createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'

const record: PeerHostRecord = {
  id: 'peer-1', ownerUserId: 'owner', displayName: 'Mac', color: '#52c41a',
  route: { kind: 'lan', baseUrl: 'http://192.168.1.5:13080', normalizedOrigin: 'http://192.168.1.5:13080' },
  status: 'ready', pluginId: 'plugin', pluginVersion: '1', dshVersion: '1', apiCompatibility: 'peer-host-v1',
  fingerprint: 'target-1', lastCheckedAt: 1, lastErrorCode: null, createdAt: 1, updatedAt: 1, visibleWorkspaceIds: ['w-1'],
}
function aggregate(availability: AggregateHostResult['availability'] = 'ready', title = '修复网络'): AggregateHostResult[] {
  const session = (id: string) => ({ scope: { hostId: 'owner', targetHostId: 'peer-1', workspaceId: 'w-1', sessionId: id, scopeGeneration: 0 },
    title, status: 'running', activity: 'running' as const, updatedAt: 2, blank: false, adapterId: 'codex' })
  return [{ hostId: 'owner', targetHostId: 'peer-1', hostLabel: 'Mac', availability, errorCode: availability === 'ready' ? null : 'PEER_HOST_UNREACHABLE',
    workspaces: availability === 'ready' ? [{ key: 'owner:w-1', hostId: 'owner', targetHostId: 'peer-1', workspaceId: 'w-1', displayName: '项目', path: '/repo', hostLabel: 'Mac', availability,
      sessions: [session('s-1')], archivedSessions: [session('archived')], subagentSessions: [{ ...session('child'), origin: 'subagent', parentSessionId: 's-1' }] }] : [] }]
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-workspace-cache-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'cache.json')
  return { path, cache: new PeerHostWorkspaceCache(path, 'owner') }
}

test('重启后断线工作区、普通和归档会话仍进入原生列表与作用域目录', async (t) => {
  const { cache, path } = await fixture(t)
  await cache.apply(aggregate(), [record])
  const restarted = new PeerHostWorkspaceCache(path, 'owner')
  const results = await restarted.apply(aggregate('unreachable'), [{ ...record, status: 'unreachable' }])
  assert.equal(results[0]?.workspaces[0]?.availability, 'unreachable')
  assert.equal(results[0]?.workspaces[0]?.sessions[0]?.title, '修复网络')
  const projection = createPeerHostNativeProjection()
  projection.setAggregate(results)
  assert.deepEqual(projection.workspaces()[0]?.sessionIds, [createVirtualSessionId('peer-1', 's-1'), createVirtualSessionId('peer-1', 'archived')])
  assert.deepEqual(projection.workspaces()[0]?.archivedSessionIds, [createVirtualSessionId('peer-1', 'archived')])
  assert.equal(projection.sessions()[0]?.agentAvailable, false)
  assert.equal(projection.sessions()[0]?.running, false)
  const registry = new VirtualWorkspaceRegistry()
  registry.replace(results)
  assert.equal(registry.resolveWorkspace(createVirtualWorkspaceId('peer-1', 'w-1'))?.workspaceId, 'w-1')
  assert.equal(registry.resolveSession(createVirtualSessionId('peer-1', 'child'))?.workspaceId, 'w-1')
})

test('断线移除持久隐藏缓存，重连按添加配置恢复并使用最新会话标题', async (t) => {
  const { cache, path } = await fixture(t)
  await cache.apply(aggregate(), [record])
  await assert.rejects(cache.dismiss('peer-1', 'w-1'), /恢复连接/u)
  await cache.apply(aggregate('unreachable'), [record])
  await cache.dismiss('peer-1', 'w-1')
  assert.deepEqual(record.visibleWorkspaceIds, ['w-1'])
  const restarted = new PeerHostWorkspaceCache(path, 'owner')
  assert.deepEqual((await restarted.apply(aggregate('unreachable'), [record]))[0]?.workspaces, [])
  const online = await restarted.apply(aggregate('ready', '恢复后最新标题'), [record])
  assert.equal(online[0]?.workspaces[0]?.sessions[0]?.title, '恢复后最新标题')
  assert.equal((await restarted.apply(aggregate('unreachable'), [record]))[0]?.workspaces.length, 1)
})

test('取消添加、删除、禁用或更换目标身份均不能复活旧缓存', async (t) => {
  const { path } = await fixture(t)
  for (const records of [[], [{ ...record, status: 'disabled' }], [{ ...record, status: 'identity_changed' }],
    [{ ...record, visibleWorkspaceIds: [] }], [{ ...record, fingerprint: 'other' }], [{ ...record, route: { ...record.route, baseUrl: 'http://other' } }]]) {
    const cache = new PeerHostWorkspaceCache(path, 'owner')
    await cache.apply(aggregate(), [record])
    const offline = await cache.apply(aggregate('unreachable'), records as PeerHostRecord[])
    assert.equal(offline.flatMap((host) => host.workspaces).length, 0)
  }
})

test('远端成功返回空工作区会清空缓存，本地工作区不会缓存', async (t) => {
  const { cache, path } = await fixture(t)
  await cache.apply(aggregate(), [record])
  const local = { ...aggregate()[0]!, targetHostId: null }
  assert.deepEqual(await cache.apply([local, { ...aggregate()[0]!, workspaces: [] }], [record]), [local, { ...aggregate()[0]!, hostColor: '#52c41a', workspaces: [] }])
  assert.deepEqual((await cache.apply(aggregate('unreachable'), [record]))[0]?.workspaces, [])
  assert.equal(JSON.parse(await readFile(path, 'utf8')).entries.length, 1)
})

test('缓存损坏或所属用户不同只影响离线展示，不阻断在线重建', async (t) => {
  const { path } = await fixture(t)
  await writeFile(path, 'broken')
  const cache = new PeerHostWorkspaceCache(path, 'owner')
  assert.deepEqual((await cache.apply(aggregate('unreachable'), [record]))[0]?.workspaces, [])
  await cache.apply(aggregate(), [record])
  const otherOwner = new PeerHostWorkspaceCache(path, 'other')
  assert.deepEqual((await otherOwner.apply(aggregate('unreachable'), [{ ...record, ownerUserId: 'other' }]))[0]?.workspaces, [])
})

test('断线只影响目标 Host，重连会通知原生投影且恢复执行状态', async (t) => {
  const { cache } = await fixture(t)
  const projection = createPeerHostNativeProjection()
  projection.setAggregate(await cache.apply(aggregate(), [record]))
  let notifications = 0
  projection.subscribe(() => { notifications += 1 })
  assert.equal(projection.setAggregate(await cache.apply(aggregate('unreachable'), [record])), true)
  assert.equal(projection.setAggregate(await cache.apply(aggregate('unreachable'), [record])), false)
  assert.equal(projection.setAggregate(await cache.apply(aggregate(), [record])), true)
  assert.equal(notifications, 2)
  assert.equal(projection.sessions()[0]?.agentAvailable, true)
  assert.equal(projection.sessions()[0]?.running, true)
})
