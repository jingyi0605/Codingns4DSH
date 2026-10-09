import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantNotificationSource } from '../src/host/features/assistant-notification-source.js'
import { AssistantPeerNotifications, assistantPeerNotificationWorkspaceIds, assistantPeerNotificationCapabilityKey, type AssistantPeerNotificationNode, type AssistantPeerNotificationUpdate } from '../src/host/features/assistant-peer-notifications.js'
import { createVirtualWorkspaceId, type PeerHostRecord } from '../src/shared/contracts/peer-host.js'
import { readAssistantNotificationFeed, type AssistantNotificationFact } from '../src/shared/assistant-notification-feed.js'
import { isPeerHostHttpRoute } from '../src/shared/peer-host-http-routes.js'

const fact = (overrides: Partial<AssistantNotificationFact> = {}): AssistantNotificationFact => ({
  kind: 'completed', workspaceId: 'workspace-a', sessionId: 'same-session', logicalId: 'turn:1',
  sessionTitle: '测试会话', workspaceLabel: '测试项目', hostLabel: '远端', ...overrides,
})
const node = (hostId = 'host-a', capabilityKey = 'version:1'): AssistantPeerNotificationNode => ({
  hostId, hostLabel: hostId, capabilityKey, workspaceIds: ['workspace-a'],
})
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待测试状态超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('来源只传租约内的新事实，首次连接不回放历史终态', () => {
  let now = 1000
  const source = new AssistantNotificationSource({ now: () => now, epoch: 'source-a' })
  source.append(fact())
  const baseline = source.read({ workspaceIds: ['workspace-a'] })
  assert.equal(baseline.baseline, true)
  assert.deepEqual(baseline.events, [])
  source.append(fact({ logicalId: 'turn:2' }))
  source.append(fact({ workspaceId: 'unmanaged', logicalId: 'turn:3' }))
  const next = source.read({ workspaceIds: ['workspace-a'], epoch: baseline.epoch, revision: baseline.revision })
  assert.equal(next.baseline, false)
  assert.deepEqual(next.events.map(value => value.logicalId), ['turn:2'])
  now += 11_000
  source.append(fact({ logicalId: 'turn:4' }))
  assert.equal(source.read({ workspaceIds: ['workspace-a'], epoch: next.epoch, revision: next.revision }).revision, next.revision)
  source.dispose()
})

test('有界来源日志发生缺口时只恢复有效待办，不把截断历史当成新完成', () => {
  const source = new AssistantNotificationSource({ epoch: 'bounded', capacity: 2 })
  source.read({ workspaceIds: ['workspace-a'] })
  source.append(fact({ logicalId: 'turn:1' }))
  source.append(fact({ kind: 'question', logicalId: 'question:q1', requestId: 'q1' }))
  source.append(fact({ logicalId: 'turn:2' }))
  const gap = source.read({ workspaceIds: ['workspace-a'], epoch: 'bounded', revision: 0 })
  assert.equal(gap.gap, true)
  assert.equal(gap.baseline, true)
  assert.deepEqual(gap.events, [])
  assert.deepEqual(gap.pending.map(value => value.requestId), ['q1'])
  source.append(fact({ kind: 'question', logicalId: 'question:q2', requestId: 'q2' }))
  source.append(fact({ kind: 'resolved', logicalId: 'question:q1', requestId: 'q1', requestKind: 'question' }))
  assert.deepEqual(source.read({ workspaceIds: ['workspace-a'] }).pending.map(value => value.requestId), ['q2'])
  source.dispose()
})

test('先有问题后连接也能恢复已观察的在途请求，租约过期不会把待办丢掉', () => {
  let now = 1000
  const source = new AssistantNotificationSource({ now: () => now })
  source.append(fact({ kind: 'question', logicalId: 'question:early', requestId: 'early' }))
  assert.deepEqual(source.read({ workspaceIds: ['workspace-a'] }).pending.map(item => item.requestId), ['early'])
  now += 11_000
  assert.deepEqual(source.read({ workspaceIds: ['workspace-a'] }).pending.map(item => item.requestId), ['early'])
  now += 11_000
  source.append(fact({ kind: 'resolved', logicalId: 'question:early', requestId: 'early', requestKind: 'question' }))
  assert.deepEqual(source.read({ workspaceIds: ['workspace-a'] }).pending, [])
  source.dispose()
})

test('恢复接口只承认当前原生请求，按工作区过滤并精确结束', () => {
  let current = [fact({ kind: 'approval', logicalId: 'approval:a1', requestId: 'a1' })]
  const source = new AssistantNotificationSource({ recover: () => current })
  assert.equal(source.read({ workspaceIds: ['workspace-a'] }).capabilities.recovery, true)
  assert.equal(source.read({ workspaceIds: ['other'] }).pending.length, 0)
  assert.equal(source.read({ workspaceIds: ['workspace-a'] }).pending.length, 1)
  current = []
  assert.equal(source.read({ workspaceIds: ['workspace-a'] }).pending.length, 0)
  source.dispose()
})

test('远端契约丢弃多余字段并拒绝未知终态和无请求身份的待办', () => {
  const source = new AssistantNotificationSource()
  const base = source.read({ workspaceIds: ['workspace-a'] })
  const value = readAssistantNotificationFeed({ ...base, events: [{ ...fact(), rawToolArguments: 'secret', errorExcerpt: 'x'.repeat(1000) }] })
  assert.equal(value.events[0]?.errorExcerpt?.length, 240)
  assert.equal('rawToolArguments' in value.events[0]!, false)
  assert.throws(() => readAssistantNotificationFeed({ ...base, events: [fact({ kind: 'idle' as never })] }))
  assert.throws(() => readAssistantNotificationFeed({ ...base, pending: [fact({ kind: 'question' })] }))
  assert.throws(() => source.read({ workspaceIds: Array.from({ length: 129 }, (_, i) => String(i)) }))
  source.dispose()
})

test('相同会话 ID 的两台 Host 不混用，来源过滤未受管工作区', async () => {
  const updates: AssistantPeerNotificationUpdate[] = []
  const sources = new Map(['host-a', 'host-b'].map(id => [id, new AssistantNotificationSource({ epoch: id })]))
  const subscription = new AssistantPeerNotifications({
    nodes: async () => [node('host-a'), node('host-b')], intervalMs: 10,
    read: async (peer, request) => {
      const source = sources.get(peer.hostId)!
      const response = source.read(request)
      source.append(fact({ kind: 'question', logicalId: 'question:same', requestId: 'same' }))
      return { ...response, events: [...response.events, fact({ workspaceId: 'outside' })] }
    },
    observer: { onUpdate: update => updates.push(update), onUnavailable: () => assert.fail('不应断线') },
  })
  subscription.start()
  try {
    await until(() => updates.some(update => update.hostId === 'host-a' && update.feed.pending.length > 0)
      && updates.some(update => update.hostId === 'host-b' && update.feed.pending.length > 0))
    assert.ok(updates.every(update => update.feed.events.every(item => item.workspaceId === 'workspace-a')))
    assert.equal(new Set(updates.map(update => update.hostId)).size, 2)
  } finally { subscription.dispose(); for (const source of sources.values()) source.dispose() }
})

test('明确不支持在同能力代次只探测一次，版本变化后才重新核对', async () => {
  let nodes = [node()]
  let reads = 0
  let unsupported = 0
  const subscription = new AssistantPeerNotifications({
    nodes: async () => nodes, intervalMs: 10,
    read: async () => { reads += 1; throw Object.assign(new Error('not supported'), { code: 'CODINGNS_RPC_NOT_FOUND' }) },
    observer: { onUpdate: () => assert.fail('不支持不能伪造事件'), onUnavailable: (_host, _generation, _reason, permanent) => { if (permanent) unsupported += 1 } },
  })
  subscription.start()
  try {
    await until(() => unsupported === 1)
    await subscription.refresh()
    await subscription.refresh()
    assert.equal(reads, 1)
    nodes = [node('host-a', 'version:2')]
    await subscription.refresh()
    await until(() => unsupported === 2)
    assert.equal(reads, 2)
  } finally { subscription.dispose() }
})

test('来源 epoch 变化提升路由代次，旧读取和已移除 Host 的迟到结果不能生效', async () => {
  let source = new AssistantNotificationSource({ epoch: 'first' })
  let nodes = [node()]
  const updates: AssistantPeerNotificationUpdate[] = []
  let hold = false
  let release: ((value: unknown) => void) | undefined
  const subscription = new AssistantPeerNotifications({
    nodes: async () => nodes, intervalMs: 10,
    read: async (_node, request) => hold ? new Promise(resolve => { release = resolve }) : source.read(request),
    observer: { onUpdate: update => updates.push(update), onUnavailable: () => undefined },
  })
  subscription.start()
  try {
    await until(() => updates.length > 0)
    const firstGeneration = updates[0]!.connectionGeneration
    source = new AssistantNotificationSource({ epoch: 'second' })
    await until(() => updates.some(update => update.feed.epoch === 'second'))
    assert.ok(updates.at(-1)!.connectionGeneration > firstGeneration)
    hold = true
    await until(() => release !== undefined)
    nodes = []
    await subscription.refresh()
    const count = updates.length
    release!(source.read({ workspaceIds: ['workspace-a'] }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(updates.length, count)
  } finally { subscription.dispose(); source.dispose() }
})

test('PeerHost 白名单只允许通知只读来源，不借此开放配置和派发', () => {
  assert.equal(isPeerHostHttpRoute('POST', '/api/codingns/assistant/notifications/source'), true)
  assert.equal(isPeerHostHttpRoute('POST', '/api/codingns/assistant/lifecycle/configure'), false)
  assert.equal(isPeerHostHttpRoute('POST', '/api/codingns/assistant/notifications/target'), false)
  assert.equal(isPeerHostHttpRoute('POST', '/api/codingns/assistant/notifications/source-admin'), false)
  assert.equal(isPeerHostHttpRoute('GET', '/api/codingns/assistant/notifications/source'), false)
})

test('远端基线不回放夹带终态，独立能力关闭时不采信对应事实', async () => {
  const updates: AssistantPeerNotificationUpdate[] = []
  let reads = 0
  const source = new AssistantNotificationSource({ epoch: 'partial' })
  const base = source.read({ workspaceIds: ['workspace-a'] })
  const subscription = new AssistantPeerNotifications({
    nodes: async () => [node()], intervalMs: 10,
    read: async () => ({ ...base, baseline: reads++ === 0, revision: reads,
      capabilities: { completed: false, error: true, requests: false, resolve: true, recovery: false },
      events: [fact(), fact({ kind: 'error', logicalId: 'failure' }), fact({ kind: 'question', requestId: 'q' })],
      pending: [fact({ kind: 'approval', requestId: 'a' })],
    }),
    observer: { onUpdate: update => updates.push(update), onUnavailable: () => assert.fail('部分能力是有效响应') },
  })
  subscription.start()
  try {
    await until(() => updates.length >= 2)
    assert.deepEqual(updates[0]!.feed.events, [])
    assert.deepEqual(updates[1]!.feed.events.map(item => item.kind), ['error'])
    assert.deepEqual(updates[1]!.feed.pending, [])
  } finally { subscription.dispose(); source.dispose() }
})

test('相同父会话下子请求的真实归属参与独立去重与精确结束', () => {
  const source = new AssistantNotificationSource()
  for (const actualRequestSessionId of ['child-a', 'child-b']) source.append(fact({
    kind: 'question', requestId: 'same', logicalId: 'question:same', actualRequestSessionId,
  }))
  assert.equal(source.read({ workspaceIds: ['workspace-a'] }).pending.length, 2)
  source.append(fact({ kind: 'resolved', requestId: 'same', requestKind: 'question', logicalId: 'question:same', actualRequestSessionId: 'child-a' }))
  assert.deepEqual(source.read({ workspaceIds: ['workspace-a'] }).pending.map(item => item.actualRequestSessionId), ['child-b'])
  source.dispose()
})

test('本机原始范围不扩大到同名远端，虚拟与旧Host前缀范围均精确匹配', () => {
  const visible = ['workspace-a', 'workspace-b']
  assert.deepEqual(assistantPeerNotificationWorkspaceIds('host-a', visible, ['workspace-a']), [])
  assert.deepEqual(assistantPeerNotificationWorkspaceIds('host-a', visible, [createVirtualWorkspaceId('host-b', 'workspace-a')]), [])
  assert.deepEqual(assistantPeerNotificationWorkspaceIds('host-a', visible, [createVirtualWorkspaceId('local', 'workspace-a')]), [])
  assert.deepEqual(assistantPeerNotificationWorkspaceIds('host-a', visible, [createVirtualWorkspaceId('host-a', 'workspace-b')]), ['workspace-b'])
  assert.deepEqual(assistantPeerNotificationWorkspaceIds('host-a', visible, ['host-a:workspace-a']), ['workspace-a'])
})

test('普通连接状态变化保留增量基线与来源身份，真实版本变更才重建订阅', async () => {
  const source = new AssistantNotificationSource({ epoch: 'stable-source' })
  let record = { route: { kind: 'lan', baseUrl: 'http://peer.test', normalizedOrigin: 'http://peer.test' }, fingerprint: 'device-a', pluginVersion: '1', status: 'ready' } as PeerHostRecord
  const updates: AssistantPeerNotificationUpdate[] = []
  const requests: Array<{ epoch?: string }> = []
  let removals = 0
  const subscription = new AssistantPeerNotifications({
    intervalMs: 10,
    nodes: async () => [node('host-a', assistantPeerNotificationCapabilityKey(record))],
    read: async (_peer, request) => { requests.push(request); return source.read(request) },
    observer: { onUpdate: update => updates.push(update), onUnavailable: () => assert.fail('状态刷新不制造网络失败'), onRemove: () => { removals++ } },
  })
  subscription.start()
  try {
    await until(() => updates.length > 0)
    const initialGeneration = updates[0]!.connectionGeneration
    for (const status of ['checking', 'unreachable', 'reconnecting', 'ready'] as const) {
      record = { ...record, status }
      await subscription.refresh()
    }
    source.append(fact({ kind: 'approval', logicalId: 'approval:current', requestId: 'current' }))
    await until(() => updates.at(-1)!.feed.pending.length === 1)
    assert.equal(removals, 0)
    assert.equal(updates.at(-1)!.connectionGeneration, initialGeneration)
    assert.ok(requests.slice(1).every(request => request.epoch === 'stable-source'), '状态变化不能重新做历史基线')
    record = { ...record, pluginVersion: '2' }
    await subscription.refresh()
    await until(() => updates.at(-1)!.connectionGeneration > initialGeneration)
    assert.equal(removals, 1)
  } finally { subscription.dispose(); source.dispose() }
})
