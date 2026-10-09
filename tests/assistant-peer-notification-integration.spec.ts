import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { FeatureRegistry } from '../src/features/index.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { registerCodingNsRpc } from '../src/host/rpc.js'
import { getDesktopAssistantNotifications, desktopAssistantNotificationPresentation } from '../src/host/desktop-assistant/notifications.js'
import { createGlobalVoiceRpcFeature } from '../src/host/features/global-voice-rpc.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import type { AssistantNotificationFeed } from '../src/shared/assistant-notification-feed.js'
import type { AssistantNotificationSnapshot, AssistantNotificationTarget } from '../src/shared/assistant-notifications.js'
import { memoryAssistantConversationStorage } from './assistant-fixtures.js'

/** 使用真正的 Feature/RPC 注册链，模拟运行协议而不启动任何 Host 或原生进程。 */
async function fixture(t: TestContext, localEnabled: boolean) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let settings = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  settings.modules.globalVoiceAssistant = true
  settings.assistant.profile = { name: '助理', initialized: localEnabled, createdAt: localEnabled ? 1 : null }
  settings.assistant.managedWorkspaceIds = localEnabled ? ['w'] : []
  settings.assistant.appearance = { ...normalizeAssistantAppearance(settings.assistant.appearance), floatingEnabled: localEnabled }
  const listeners = new Map<string, Set<(...args: any[]) => any>>()
  const watchers = new Set<() => void>()
  const session = { id: 's', title: '实际事件会话', header: { id: 's' }, events: [] as any[], snapshotEvents() { return this.events } }
  const rpc = new CodingNsRpcTable()
  const on = (name: string, listener: (...args: any[]) => any) => {
    const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set)
    return () => { set.delete(listener) }
  }
  const emit = (name: string, ...args: any[]) => {
    // 提问在会话事件流中的表达是问询工具的调用与结果；读取时扫描它们得到当前提问。
    if (name === 'user-questions/request') {
      const request = args[0] ?? {}
      const requestId = typeof request.requestId === 'string' && request.requestId.trim() !== '' ? request.requestId.trim() : undefined
      if (requestId !== undefined) {
        session.events.push({ type: 'tool/call', data: { callId: requestId, name: 'ask_user_question' }, seq: session.events.length + 1 })
        const next = args.at(-1)
        if (typeof next === 'function') args[args.length - 1] = (...nextArgs: any[]) => Promise.resolve(next(...nextArgs)).finally(() => { session.events.push({ type: 'tool/result', data: { callId: requestId, message: { toolCallId: requestId } }, seq: session.events.length + 1 }) })
      }
    }
    let result: any
    for (const listener of listeners.get(name) ?? []) result = listener(...args)
    return result
  }
  const services = { rpc, dshVersion: '0.2.1-alpha.1',
    settings: { get: () => settings, watch: (watcher: () => void) => { watchers.add(watcher); return () => watchers.delete(watcher) },
      update: async (patch: any) => { settings = { ...settings, ...patch }; watchers.forEach(watcher => watcher()) } },
    events: { on }, nativeSessions: { get: (id: string) => id === 's' ? session : undefined,
      subscribe: (handlers: any) => on('native-event', handlers.onEvent) },
    dshContext: { get(name: string) {
      if (name === 'sessions') return { get: (id: string) => id === 's' ? session : undefined }
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'w', sessionIds: ['s'], displayName: '项目' }] }
      if (name === 'sessionQuery') return { listSessions: () => [], readSurface: async () => assert.fail('来源不能读取会话正文') }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'api', model: 'chat' }) }
      if (name === 'llm') return { listProviders: () => [{ id: 'api', name: '测试 API' }], listModels: async () => [{ id: 'chat', name: '测试模型' }], async *stream() { throw new Error('来源不能调用模型') } }
    } },
  } as unknown as CodingNsHostServices
  const registry = new FeatureRegistry(services)
  registry.register(createGlobalVoiceRpcFeature({ conversationStorage: memoryAssistantConversationStorage() }))
  await registry.reconcile(['globalVoiceRpc'])
  t.after(() => registry.reconcile([]))
  const call = async <T>(action: string, payload: unknown = {}): Promise<T> => {
    const route = rpc.resolve(`assistant/notifications/${action}`)!
    return await route.handler(route.action, payload) as T
  }
  return { call, emit, session, rpc, services, registry, settings: () => settings,
    update: services.settings!.update.bind(services.settings),
    event: (type: string, data: any, seq: number) => { session.events.push({ type, data, seq }); return emit('native-event', session, { type, data, seq }) },
  }
}

test('真实RPC来源在本机助理未创建且尚无远端读者时观察待办，结束只撤销对应请求', async (t) => {
  const f = await fixture(t, false)
  let finish!: (value: unknown) => void
  const pending = f.emit('user-questions/request', { agent: { session: f.session }, requestId: 'q', questions: [{ id: 'answer', question: '是否继续？' }] }, () => new Promise(resolve => { finish = resolve }))
  f.event('approval/asked', { id: 'a' }, 1)
  const baseline = await f.call<AssistantNotificationFeed>('source', { workspaceIds: ['w'] })
  assert.deepEqual(new Set(baseline.pending.map(item => item.kind)), new Set(['question', 'approval']))
  assert.equal((await f.call<AssistantNotificationSnapshot>('read')).pendingCount, 0)
  assert.equal(f.settings().assistant.profile!.initialized, false)
  finish(undefined); await pending
  assert.deepEqual((await f.call<AssistantNotificationFeed>('source', { workspaceIds: ['w'] })).pending.map(item => item.requestId), ['a'])
  f.event('approval/decided', { id: 'a', outcome: 'rejected' }, 2)
  assert.deepEqual((await f.call<AssistantNotificationFeed>('source', { workspaceIds: ['w'] })).pending, [])
})

test('本机关闭通知或移除范围不破坏另一台Host读取的当前请求生命周期', async (t) => {
  const f = await fixture(t, true)
  let finish!: (value: unknown) => void
  const pending = f.emit('user-questions/request', { agent: { session: f.session }, requestId: 'q', questions: [{ id: 'answer', question: '是否继续？' }] }, () => new Promise(resolve => { finish = resolve }))
  f.event('approval/asked', { id: 'a' }, 1)
  await f.call('source', { workspaceIds: ['w'] })
  await f.update({ assistant: { ...f.settings().assistant, managedWorkspaceIds: [], notifications: { ...f.settings().assistant.notifications, enabled: false } } })
  assert.equal((await f.call<AssistantNotificationFeed>('source', { workspaceIds: ['w'] })).pending.length, 2)
  finish(undefined); await pending
  assert.deepEqual((await f.call<AssistantNotificationFeed>('source', { workspaceIds: ['w'] })).pending.map(item => item.requestId), ['a'])
  f.event('approval/decided', { id: 'a', outcome: 'cancelled' }, 2)
  assert.deepEqual((await f.call<AssistantNotificationFeed>('source', { workspaceIds: ['w'] })).pending, [])
})

test('关闭悬浮期间的终态不会在重新开启后补弹，仍有效的请求可以恢复', async (t) => {
  const f = await fixture(t, true)
  await f.update({ assistant: { ...f.settings().assistant, appearance: { ...f.settings().assistant.appearance, floatingEnabled: false } } })
  f.event('turn/start', { turn: 1 }, 1)
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2)
  f.event('approval/asked', { id: 'a' }, 3)
  await f.update({ assistant: { ...f.settings().assistant, appearance: { ...f.settings().assistant.appearance, floatingEnabled: true } } })
  const frame = await f.call<AssistantNotificationSnapshot>('read')
  assert.equal(frame.items.some(item => item.kind === 'completed'), false)
  assert.equal(frame.pendingCount, 1)
})

test('切换无关通知类型保留原有效待办身份和用户收起状态', async (t) => {
  const f = await fixture(t, true)
  f.event('approval/asked', { id: 'a' }, 1)
  const before = await f.call<AssistantNotificationSnapshot>('read')
  await f.call('ack', { noticeId: before.primary!.noticeId, generation: before.generation, action: 'dismiss' })
  await f.update({ assistant: { ...f.settings().assistant, notifications: { ...f.settings().assistant.notifications, completed: false } } })
  const after = await f.call<AssistantNotificationSnapshot>('read')
  assert.equal(after.pendingCount, 1)
  assert.equal(after.primary, null)
  assert.equal(after.items[0]!.noticeId, before.primary!.noticeId)
})

test('真实Feature登记原生安全来源，独立分页保留全部待办，认证目标带本机入口身份', async (t) => {
  const f = await fixture(t, true)
  for (let i = 0; i < 55; i++) f.event('approval/asked', { id: `approval-${i}` }, i + 1)
  const source = getDesktopAssistantNotifications(f.services)
  assert.ok(source, '全局助理必须向原生模块登记同一个中心')
  const first = source.read({ limit: 20 })
  assert.equal(first.items.length, 20)
  assert.equal(first.pendingCount, 55)
  const second = source.read({ limit: 20, cursor: first.cursor! })
  assert.equal(second.items.length, 20)
  assert.equal(second.pendingCount, 55)
  assert.ok(second.items.every(item => !first.items.some(previous => previous.noticeId === item.noticeId)))
  const safe = desktopAssistantNotificationPresentation(f.services, { visible: true, state: 'idle', label: '助理', caption: '' }, { limit: 20, cursor: first.cursor! })
  assert.deepEqual(safe.notificationSnapshot!.items.map(item => item.noticeId), second.items.map(item => item.noticeId))
  assert.ok(safe.notificationSnapshot!.items.every(item => !('target' in item) && !('requestId' in item)))
  const target = await f.call<AssistantNotificationTarget>('target', { noticeId: first.primary!.noticeId, generation: first.generation })
  assert.equal(target.hostId, process.env.CODINGNS4DSH_HOST_ID?.trim() || 'local-host')
  assert.equal(target.localHostId, target.hostId, '入口本机身份不能由当前选中远端推断')
  source.presented({ noticeId: first.primary!.noticeId, generation: first.generation, action: 'presented', kind: 'approval' })
  assert.equal((await f.call<AssistantNotificationSnapshot>('read')).primary!.presentation, 'shown')
  await f.registry.reconcile([])
  assert.equal(getDesktopAssistantNotifications(f.services), undefined)
})

test('真实生命周期保存接受通知草稿和自动关闭时长，非法值原子拒绝，不修改悬浮和语音开关', async (t) => {
  const f = await fixture(t, true)
  const route = f.rpc.resolve('assistant/lifecycle/configure')!
  const save = (configurationPatch: unknown) => route.handler(route.action, { name: '助理', avatarId: 'codingns-default', configurationPatch })
  const before = structuredClone(f.settings().assistant)
  await save([...['enabled', 'completed', 'error', 'question', 'approval', 'autoClose'].map(key => ({ op: 'set' as const, path: ['notifications', key], value: false })), { op: 'set' as const, path: ['notifications', 'autoCloseSeconds'], value: 45 }])
  assert.deepEqual(f.settings().assistant.notifications, { enabled: false, completed: false, error: false, question: false, approval: false, autoClose: false, autoCloseSeconds: 45 })
  assert.equal(f.settings().assistant.appearance!.floatingEnabled, before.appearance!.floatingEnabled)
  assert.equal(f.settings().assistant.voice.initialized, before.voice.initialized)
  const saved = structuredClone(f.settings().assistant)
  await assert.rejects(save([{ op: 'set', path: ['notifications', 'enabled'], value: 'false' }]))
  assert.deepEqual(f.settings().assistant, saved)
  await assert.rejects(save([{ op: 'set', path: ['model'], value: {} }]), /字段无效/u)
  assert.deepEqual(f.settings().assistant, saved)
})

test('真实注册的Fetch通知来源可消费增量事实，PeerHost固定API路径不会落到404', async (t) => {
  const f = await fixture(t, false)
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
  let cleanup: (() => unknown) | undefined
  registerCodingNsRpc({
    effect(factory: () => (() => unknown)) { cleanup = factory() },
    webServer: { register: () => () => undefined },
    connection: { operator: {}, fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) {
      routes.set(route.path, route); return () => { routes.delete(route.path) }
    } } },
  } as unknown as Parameters<typeof registerCodingNsRpc>[0], f.rpc)
  t.after(async () => { await cleanup?.() })
  const source = routes.get('/api/codingns/assistant/notifications/source')
  assert.ok(source, 'PeerHost使用的精确来源路由必须真正登记')
  for (const action of ['read', 'ack', 'target']) assert.ok(routes.has(`/api/codingns/assistant/notifications/${action}`))
  const read = async (payload: unknown): Promise<AssistantNotificationFeed> => {
    const response = await source.fetch(new Request('http://source.test/api/codingns/assistant/notifications/source', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: 'source-test', method: 'assistant/notifications/source', payload }),
    }))
    assert.equal(response.status, 200)
    const envelope = await response.json() as any
    assert.equal(envelope.result.ok, true)
    return envelope.result.value
  }
  const baseline = await read({ workspaceIds: ['w'] })
  f.event('turn/start', { turn: 1 }, 1)
  f.event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2)
  const increment = await read({ workspaceIds: ['w'], epoch: baseline.epoch, revision: baseline.revision })
  assert.deepEqual(increment.events.map(item => item.kind), ['completed'])
  assert.deepEqual(increment.events.map(item => item.workspaceId), ['w'])
})
