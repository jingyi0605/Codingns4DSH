import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { FeatureRegistry } from '../src/features/index.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createGlobalVoiceRpcFeature } from '../src/host/features/global-voice-rpc.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import type { AssistantNotificationSnapshot, AssistantNotificationTarget } from '../src/shared/assistant-notifications.js'
import { HostRouter } from '../src/features/host-router.js'
import { createVirtualWorkspaceId } from '../src/shared/contracts/peer-host.js'
import { openAssistantNotificationSession } from '../src/dsh-capabilities/client/assistant-session-navigation-adapter.js'
import { memoryAssistantConversationStorage } from './assistant-fixtures.js'

async function fixture(t: TestContext, native = true, created = true, operator?: object) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let settings = { ...structuredClone(DEFAULT_CODINGNS_SETTINGS), modules: { globalVoiceAssistant: true }, assistant: { ...structuredClone(DEFAULT_CODINGNS_SETTINGS.assistant), appearance: { ...structuredClone(DEFAULT_CODINGNS_SETTINGS.assistant.appearance!), floatingEnabled: true }, profile: { name: '小鱼', initialized: created, createdAt: 1 }, managedWorkspaceIds: ['w'] } }
  const watchers = new Set<() => void>(), events = new Map<string, Set<(...args: any[]) => any>>()
  let nativeSubscriptions = 0, readSurface = 0
  const session = { id: 's', title: '受管会话', header: { id: 's' }, snapshotEvents: () => [] }
  const archived: string[] = []
  const rpc = new CodingNsRpcTable()
  const on = (name: string, listener: (...args: any[]) => any) => { const listeners = events.get(name) ?? new Set(); listeners.add(listener); events.set(name, listeners); return () => { listeners.delete(listener) } }
  const emit = (name: string, ...args: any[]) => { let result: any; for (const listener of events.get(name) ?? []) result = listener(...args); return result }
  const services = { rpc, dshVersion: '0.2.1-alpha.1', settings: {
    get: () => settings, watch: (watcher: () => void) => { watchers.add(watcher); return () => watchers.delete(watcher) },
    update: async (patch: any) => { settings = { ...settings, ...patch }; watchers.forEach(watcher => watcher()) },
  }, events: { on }, ...(native ? { nativeSessions: { get: (id: string) => id === 's' ? session : undefined, subscribe(handlers: any) { nativeSubscriptions++; const stop = on('native', handlers.onEvent); return () => { stop(); nativeSubscriptions-- } } } } : {}),
    dshContext: { get(name: string) {
      if (name === 'connection' && operator !== undefined) return { operator }
      if (name === 'sessions') return { get: (id: string) => id === 's' ? session : undefined }
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived, list: () => [{ id: 'w', displayName: '项目', sessionIds: ['s'], archivedSessionIds: archived }] }
      if (name === 'sessionQuery') return { listSessions: () => [], readSurface: async () => { readSurface++; return '' } }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'api', model: 'chat' }) }
      if (name === 'llm') return { listProviders: () => [{ id: 'api', name: 'API' }], listModels: async () => [{ id: 'chat', name: '默认模型' }], async *stream() { throw new Error('通知不得调用模型') } }
    } },
  } as unknown as CodingNsHostServices
  const registry = new FeatureRegistry(services)
  registry.register(createGlobalVoiceRpcFeature({ conversationStorage: memoryAssistantConversationStorage() }))
  await registry.reconcile(['globalVoiceRpc'])
  t.after(() => registry.reconcile([]))
  const call = async <T = any>(action: string, payload: unknown = {}, context?: unknown): Promise<T> => { const target = rpc.resolve(`assistant/${action}`)!; return await target.handler(target.action, payload, context) as T }
  const sessionEvent = (type: string, data: any, seq: number) => emit(native ? 'native' : 'session/event', session, { type, data, seq })
  return { call, rpc, emit, session, sessionEvent, settings: () => settings,
    update: services.settings!.update.bind(services.settings), archived, registry, nativeSubscriptions: () => nativeSubscriptions, reads: () => readSurface,
    listenerCount: (name: string) => events.get(name)?.size ?? 0 }
}

test('真实Host单namespace注册read/ack/target，原生订阅与回退互斥，通知读取不索引正文', async (t) => {
  for (const native of [true, false]) {
    await t.test(native ? '原生桥' : '事件回退', async (child) => {
    const f = await fixture(child, native)
    assert.equal(f.nativeSubscriptions(), native ? 1 : 0)
    assert.equal(f.listenerCount('session/event'), native ? 0 : 1)
    f.sessionEvent('turn/start', { turn: 1 }, 1); f.sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2)
    const snapshot = await f.call<AssistantNotificationSnapshot>('notifications/read')
    assert.equal(snapshot.primary!.kind, 'completed'); assert.equal(snapshot.unreadCount, 1)
    assert.equal(f.reads(), 0)
    const target = await f.call('notifications/target', { noticeId: snapshot.primary!.noticeId, generation: snapshot.generation })
    assert.deepEqual(target, { hostId: 'local-host', workspaceId: 'w', sessionId: 's', localHostId: 'local-host' })
    const acknowledged = await f.call('notifications/ack', { noticeId: snapshot.primary!.noticeId, generation: snapshot.generation, action: 'presented' })
    assert.equal(acknowledged.notification.deadline - acknowledged.notification.presentedAt, 5000)
    assert.ok(!('target' in snapshot.primary!)); assert.equal(f.reads(), 0)
    await f.registry.reconcile([]); assert.equal(f.nativeSubscriptions(), 0)
    })
  }
})

test('问题next原样委托、取消不批准审批、真实audit仅结束精确请求', async (t) => {
  const f = await fixture(t)
  f.sessionEvent('approval/asked', { id: 'a1' }, 1); f.sessionEvent('approval/asked', { id: 'a2' }, 2)
  let finish!: (value: unknown) => void
  const response = { answers: [{ id: 'q', selected: ['同意'] }] }
  const pending = f.emit('user-questions/request', { agent: { session: f.session }, questions: [{ id: 'q' }] }, () => new Promise(resolve => { finish = resolve }))
  const snapshot = await f.call<AssistantNotificationSnapshot>('notifications/read')
  assert.equal(snapshot.pendingCount, 3)
  await f.call('notifications/ack', { noticeId: snapshot.primary!.noticeId, generation: snapshot.generation, action: 'dismiss' })
  assert.equal((await f.call<AssistantNotificationSnapshot>('notifications/read')).pendingCount, 3)
  finish(response); assert.equal(await pending, response)
  f.sessionEvent('approval/decided', { id: 'a1', outcome: 'rejected' }, 3)
  assert.equal((await f.call<AssistantNotificationSnapshot>('notifications/read')).pendingCount, 1)
})

test('访客/会话受限RPC拒绝，非法参数与旧代次失败，归档或停用清理目标', async (t) => {
  const f = await fixture(t)
  for (const peer of [{ authenticated: false }, { authorized: false }, { kind: 'session' }, { scope: { kind: 'session' } }]) await assert.rejects(f.call('notifications/read', {}, { peer }), /无权/u)
  await assert.rejects(f.call('notifications/read', []), /参数/u)
  await assert.rejects(f.call('notifications/read', { limit: 51 }), /1 到 50/u)
  f.sessionEvent('approval/asked', { id: 'a' }, 1)
  const frame = await f.call<AssistantNotificationSnapshot>('notifications/read')
  f.archived.push('s'); f.emit('workspace/archive')
  await assert.rejects(f.call('notifications/target', { noticeId: frame.primary!.noticeId, generation: frame.generation }), /失效/u)
  await f.update({ assistant: { ...f.settings().assistant, notifications: { enabled: false, completed: true, error: true, question: true, approval: true } } })
  assert.equal((await f.call<AssistantNotificationSnapshot>('notifications/read')).unreadCount, 0)
  await assert.rejects(f.call('notifications/ack', { noticeId: frame.primary!.noticeId, generation: frame.generation, action: 'read' }), /代次/u)
})

test('助理未创建时本机快照为空，来源租约不初始化助理且只输出新终态', async (t) => {
  const f = await fixture(t, true, false)
  f.sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1)
  assert.equal((await f.call<AssistantNotificationSnapshot>('notifications/read')).unreadCount, 0)
  const baseline = await f.call('notifications/source', { workspaceIds: ['w'] })
  assert.equal(baseline.baseline, true); assert.equal(baseline.events.length, 0)
  f.sessionEvent('turn/start', { turn: 2 }, 2); f.sessionEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3)
  const feed = await f.call('notifications/source', { workspaceIds: ['w'], epoch: baseline.epoch, revision: baseline.revision })
  assert.equal(feed.events.length, 1); assert.equal(feed.events[0].kind, 'completed'); assert.equal(feed.events[0].sessionId, 's')
  assert.equal(f.settings().assistant.profile.initialized, false)
  await assert.rejects(f.call('notifications/source', { workspaceIds: ['outside'] }), /不可访问/u)
})

test('未创建或关闭本机通知不丢真实在途请求，来源恢复只包含当前请求并且不重复入日志', async (t) => {
  const f = await fixture(t, true, false)
  let finish!: (value: unknown) => void
  const pending = f.emit('user-questions/request', { agent: { session: f.session }, questions: [{ id: 'q' }], requestId: 'q' }, () => new Promise(resolve => { finish = resolve }))
  f.sessionEvent('approval/asked', { id: 'a' }, 1)
  const baseline = await f.call('notifications/source', { workspaceIds: ['w'] })
  assert.deepEqual(new Set(baseline.pending.map((item: any) => item.kind)), new Set(['question', 'approval']))
  const unchanged = await f.call('notifications/source', { workspaceIds: ['w'], epoch: baseline.epoch, revision: baseline.revision })
  assert.deepEqual(unchanged.events, [])
  await f.update({ assistant: { ...f.settings().assistant, managedWorkspaceIds: [], notifications: { enabled: false, completed: true, error: true, question: true, approval: true } } })
  assert.equal((await f.call('notifications/source', { workspaceIds: ['w'] })).pending.length, 2)
  finish(undefined); await pending
  assert.deepEqual((await f.call('notifications/source', { workspaceIds: ['w'] })).pending.map((item: any) => item.requestId), ['a'])
  f.sessionEvent('approval/decided', { id: 'a' }, 2)
  assert.deepEqual((await f.call('notifications/source', { workspaceIds: ['w'] })).pending, [])
})

test('悬浮开关关闭期间忽略终态，开启后只恢复仍有效审批', async (t) => {
  const f = await fixture(t)
  await f.update({ assistant: { ...f.settings().assistant, appearance: { ...f.settings().assistant.appearance, floatingEnabled: false } } })
  f.sessionEvent('turn/start', { turn: 1 }, 1); f.sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2)
  f.sessionEvent('approval/asked', { id: 'a' }, 3)
  await f.update({ assistant: { ...f.settings().assistant, appearance: { ...f.settings().assistant.appearance, floatingEnabled: true } } })
  const frame = await f.call<AssistantNotificationSnapshot>('notifications/read')
  assert.equal(frame.items.some(item => item.kind === 'completed'), false)
  assert.equal(frame.pendingCount, 1)
})

test('认证target提供入口Host，从当前远端路由打开本机及local虚拟工作区不发生错跳', async (t) => {
  const f = await fixture(t)
  const hostRouter = new HostRouter(), opened: string[] = []
  const services = { hostRouter, uiContext: { get(name: string) {
    if (name === 'uiWorkspace') return { openSession(id: string) { opened.push(id) } }
  } } }
  await hostRouter.switchTo({ hostId: 'other-entry', targetHostId: 'other-peer', workspaceId: 'other', sessionId: 's' })
  for (const workspaceId of ['w', createVirtualWorkspaceId('local', 'w')]) {
    await f.update({ assistant: { ...f.settings().assistant, managedWorkspaceIds: [workspaceId] } })
    f.sessionEvent('turn/start', { turn: 1 }, 1); f.sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2)
    const frame = await f.call<AssistantNotificationSnapshot>('notifications/read')
    const target = await f.call<AssistantNotificationTarget>('notifications/target', { noticeId: frame.primary!.noticeId, generation: frame.generation })
    assert.equal(target.localHostId, 'local-host')
    assert.equal(target.hostId, target.localHostId)
    assert.ok(!JSON.stringify(frame).includes('localHostId'))
    await openAssistantNotificationSession(services, target)
    assert.deepEqual(hostRouter.getCurrent(), { hostId: 'local-host', targetHostId: null, workspaceId: 'w', sessionId: 's', scopeGeneration: hostRouter.getCurrent()!.scopeGeneration })
  }
  assert.deepEqual(opened, ['s', 's'])
  assert.equal(f.reads(), 0)
})

test('原生operator存在时只接受同一认证主体，伪造标记与缺少上下文均不能读取', async (t) => {
  const operator = { authenticated: true }
  const f = await fixture(t, true, true, operator)
  const authenticated = { peer: operator }
  const frame = await f.call<AssistantNotificationSnapshot>('notifications/read', {}, authenticated)
  assert.equal(frame.unreadCount, 0)
  for (const context of [undefined, { peer: { authenticated: true } }, { peer: { authorized: true } }]) {
    await assert.rejects(f.call('notifications/read', {}, context), /无权/u)
    await assert.rejects(f.call('notifications/source', { workspaceIds: ['w'] }, context), /无权/u)
  }
  assert.equal((await f.call('notifications/source', { workspaceIds: ['w'] }, authenticated)).baseline, true)
})

test('生命周期真实保存通知草稿，非法布尔值不写入且无关类型保留已收起审批', async (t) => {
  const f = await fixture(t)
  f.sessionEvent('approval/asked', { id: 'a' }, 1)
  const before = await f.call<AssistantNotificationSnapshot>('notifications/read')
  await f.call('notifications/ack', { noticeId: before.primary!.noticeId, generation: before.generation, action: 'dismiss' })
  const payload = { name: '小鱼', avatarId: 'codingns-default', configurationPatch: [{ op: 'set', path: ['notifications', 'completed'], value: false }] }
  await f.call('lifecycle/configure', payload)
  assert.equal(f.settings().assistant.notifications!.completed, false)
  assert.equal(f.settings().assistant.notifications!.approval, true)
  const frame = await f.call<AssistantNotificationSnapshot>('notifications/read')
  assert.equal(frame.pendingCount, 1)
  assert.equal(frame.primary, null)
  assert.equal(frame.items[0]!.noticeId, before.primary!.noticeId)
  const saved = structuredClone(f.settings().assistant)
  await assert.rejects(f.call('lifecycle/configure', { ...payload, configurationPatch: [{ op: 'set', path: ['notifications', 'error'], value: 'false' }] }))
  assert.deepEqual(f.settings().assistant, saved)
})
