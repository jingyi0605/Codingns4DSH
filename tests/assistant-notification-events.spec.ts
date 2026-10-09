import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantNotificationEvents, assistantNotificationTerminal } from '../src/host/features/assistant-notification-events.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import { getAdapterRegistry, setAdapterRegistry } from '../src/host/cli-adapters/registry-holder.js'

function fixture(options: { child?: boolean; childProjection?: boolean; created?: boolean; external?: boolean } = {}) {
  let settings = { ...structuredClone(DEFAULT_CODINGNS_SETTINGS), modules: { globalVoiceAssistant: true }, assistant: { ...structuredClone(DEFAULT_CODINGNS_SETTINGS.assistant), appearance: { ...structuredClone(DEFAULT_CODINGNS_SETTINGS.assistant.appearance!), floatingEnabled: true }, profile: { name: '助理', initialized: options.created !== false, createdAt: 1 }, managedWorkspaceIds: ['w'] } }
  const sessions = new Map<string, any>(['s', 'outside', 'archived', 'codingns-assistant-self', 'child'].map(id => [id, { id, title: `标题-${id}`, header: { id, ...(id === 'child' ? { parentSession: 's' } : {}) }, events: [], snapshotEvents() { return this.events } }]))
  let members = ['s', 'archived', 'codingns-assistant-self']
  let archived = ['archived']
  const projection = new Map<string, any>()
  let projectionListener: ((session: unknown, key: string, value: unknown) => void) | undefined
  let remoteObserver: any
  const facts: any[] = []
  const services = { settings: { get: () => settings }, nativeSessions: { get: (id: string) => sessions.get(id) }, assistantGateway: {
    subscribeNotifications(_managed: readonly string[], observer: any) { remoteObserver = observer; return () => { remoteObserver = undefined } },
    list: async () => ({ sessions: [{ hostId: 'peer', sessionId: 's', workspaceId: 'peer:w', workspaceName: '远程', running: false, completed: false, title: '远程会话', updatedAt: null, waiting: null, summary: null }], archivedSessionIds: [] }),
  }, dshContext: { get(name: string) {
    if (name === 'sessions') return { get: (id: string) => sessions.get(id) }
    if (name === 'workspaceRegistry') return { archivedSessionIds: archived, list: () => [{ id: 'w', displayName: '项目', sessionIds: members, archivedSessionIds: archived }, { id: 'other', sessionIds: ['outside'] }] }
    if (name === 'sessionProjections') return { snapshot: (session: any) => ({ values: { userQuestions: projection.get(session?.id) } }), onChanged: (listener: typeof projectionListener) => { projectionListener = listener; return () => { projectionListener = undefined } } }
  } } } as unknown as CodingNsHostServices
  const events = new AssistantNotificationEvents(services, { canNavigateChildRequest: () => options.childProjection === true, onFact: (fact) => facts.push(fact) })
  const emit = (id: string, type: string, data: unknown, seq?: number) => events.sessionEvent(sessions.get(id), { type, data, ...(seq === undefined ? {} : { seq }) })
  return { events, sessions, emit, facts, settings: () => settings, configure: (patch: any) => { settings = { ...settings, assistant: { ...settings.assistant, ...patch } }; events.sync() },
    archive: (ids: string[]) => { archived = ids; events.refreshMembership() }, membership: (ids: string[]) => { members = ids; events.refreshMembership() },
    project(id: string, value: unknown) { projection.set(id, value); projectionListener?.(sessions.get(id), 'userQuestions', value) },
    remote: () => remoteObserver,
  }
}

test('真实原生completed和已确认外部stop可成功；取消、截断、工具结束、未知原因均不成功', (t) => {
  for (const kind of ['aborted', 'cancel', 'max-tokens', 'blocked', 'unknown', undefined]) assert.equal(assistantNotificationTerminal({ type: 'turn/end', data: { reason: { kind } } }), null)
  assert.equal(assistantNotificationTerminal({ type: 'turn/end', data: { reason: { kind: 'stop' } } }), null)
  assert.equal(assistantNotificationTerminal({ type: 'turn/end', data: { reason: { kind: 'stop' } } }, true), 'completed')
  assert.equal(assistantNotificationTerminal({ type: 'step/end', data: { reason: { kind: 'completed' } } }), null)
  const f = fixture(); t.after(() => f.events.dispose())
  f.emit('s', 'turn/start', { turn: 1 }, 1)
  f.emit('s', 'turn/end', { turn: 1, reason: { kind: 'aborted' } }, 2)
  assert.equal(f.events.center.read().unreadCount, 0)
  f.emit('s', 'turn/start', { turn: 2 }, 3); f.emit('s', 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 4)
  assert.equal(f.events.center.read().primary!.kind, 'completed')
  const previous = getAdapterRegistry(); setAdapterRegistry({ getSession: () => ({ adapterId: 'codex' }) } as any); t.after(() => setAdapterRegistry(previous))
  f.emit('s', 'turn/start', { turn: 3 }, 5); f.emit('s', 'turn/end', { turn: 3, reason: { kind: 'stop' } }, 6)
  assert.equal(f.events.center.read().unreadCount, 2)
})

test('approval/asked.data.id与approval/decided.data.id精确配对，waterfall工具ID不生成重复审批', (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  f.emit('s', 'approval/asked', { id: 'a1', toolName: 'edit' }, 1)
  f.emit('s', 'approval/asked', { id: 'a2', toolName: 'edit' }, 2)
  f.events.observeRequest('approval/request', [{ agent: { session: f.sessions.get('s') }, toolName: 'edit', callId: 'call' }])
  assert.equal(f.events.center.read().pendingCount, 2)
  f.emit('s', 'approval/decided', { id: 'a1', outcome: 'allowed-once' }, 3)
  assert.equal(f.events.center.read().pendingCount, 1)
  f.events.resolveRequest('approval/resolved', [{ sessionId: 's' }])
  assert.equal(f.events.center.read().pendingCount, 1, '无身份的结束不能清空会话')
  f.emit('s', 'approval/decided', { id: 'a2', outcome: 'cancelled' }, 4)
  assert.equal(f.events.center.read().pendingCount, 0)
})

test('阻塞式问题以当前请求对象和next生命周期观察，多请求回答/取消互不误清', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  let answer!: (value: unknown) => void
  const first = f.events.observeRequest('user-questions/request', [{ agent: { session: f.sessions.get('s') }, questions: [{ id: 'question' }] }, () => new Promise(resolve => { answer = resolve })]) as Promise<unknown>
  const controller = new AbortController()
  let answerSecond!: (value: unknown) => void
  const second = f.events.observeRequest('user-questions/request', [{ agent: { session: f.sessions.get('s') }, questions: [{ id: 'question' }], signal: controller.signal }, () => new Promise(resolve => { answerSecond = resolve })]) as Promise<unknown>
  assert.equal(f.events.center.read().pendingCount, 2)
  const response = { answers: [{ id: 'question', selected: ['是'] }] }
  answer(response); assert.equal(await first, response)
  assert.equal(f.events.center.read().pendingCount, 1)
  controller.abort(); assert.equal(f.events.center.read().pendingCount, 0)
  answerSecond(response); await second
})

test('定时问题超时后仍待处理，真实投影结算才结束；启动只恢复当前active', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  const controller = new AbortController(); let resolve!: (value: unknown) => void
  const waiting = f.events.observeRequest('user-questions/request', [{ agent: { session: f.sessions.get('s') }, questions: [{ id: 'q' }], wait: { callId: 'call', timed: true }, signal: controller.signal }, () => new Promise(r => { resolve = r })]) as Promise<unknown>
  controller.abort(Object.assign(new Error('超时'), { code: 'ASK_TIMED_OUT' })); resolve(undefined); await waiting
  assert.equal(f.events.center.read().pendingCount, 1)
  f.project('s', { active: [{ callId: 'call', state: 'continued', questions: [] }], settled: [] })
  assert.equal(f.events.center.read().pendingCount, 1)
  f.project('s', { active: [], settled: [{ callId: 'call', answers: [] }] })
  assert.equal(f.events.center.read().pendingCount, 0)
  assert.match(f.events.center.read().capabilities[0]!.reason!, /没有公共当前请求注册表/u)
})

test('受管成员、归档、全局助理自身与子终态过滤；子请求须有可定位父子投影', async (t) => {
  const f = fixture({ childProjection: true }); t.after(() => f.events.dispose())
  for (const id of ['outside', 'archived', 'codingns-assistant-self', 'child']) f.emit(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1)
  assert.equal(f.events.center.read().unreadCount, 0)
  f.emit('child', 'approval/asked', { id: 'child-a' }, 2)
  const frame = f.events.center.read(); assert.equal(frame.pendingCount, 1); assert.equal(frame.primary!.sessionTitle, '标题-s')
  const target = await f.events.center.target({ noticeId: frame.primary!.noticeId, generation: frame.generation })
  assert.equal(target.sessionId, 's'); assert.equal(target.actualRequestTarget!.sessionId, 'child')
  f.archive(['s']); assert.equal(f.events.center.read().pendingCount, 0)
  await assert.rejects(f.events.center.target({ noticeId: frame.primary!.noticeId, generation: frame.generation }), /失效/u)
  const unsupported = fixture(); t.after(() => unsupported.events.dispose())
  unsupported.membership(['s', 'child'])
  unsupported.emit('child', 'approval/asked', { id: 'child-a' }, 2); assert.equal(unsupported.events.center.read().pendingCount, 0)
  f.archive([]); f.membership(['s', 'child']); f.emit('child', 'approval/asked', { id: 'child-b' }, 3)
  const restored = f.events.center.read()
  assert.equal(restored.primary!.sessionTitle, '标题-s')
  assert.equal((await f.events.center.target({ noticeId: restored.primary!.noticeId, generation: restored.generation })).actualRequestTarget!.sessionId, 'child')
})

test('当前来源租约可以观察新终态，首读不回放已有历史；配置撤销和迟到回调失效', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  f.sessions.get('s').events.push({ type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } })
  f.configure({ managedWorkspaceIds: [] }); f.configure({ managedWorkspaceIds: ['w'] })
  f.emit('s', 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 8)
  assert.equal(f.events.center.read().unreadCount, 0)
  const generation = f.events.center.generation
  let release!: (value: unknown) => void
  const pending = f.events.observeRequest('user-questions/request', [{ agent: { session: f.sessions.get('s') }, requestId: 'q', questions: [{ id: 'q' }] }, () => new Promise(resolve => { release = resolve })]) as Promise<unknown>
  f.configure({ managedWorkspaceIds: [] }); release(undefined); await pending
  assert.ok(f.events.center.generation > generation); assert.equal(f.events.center.read().pendingCount, 0)
  f.events.sourceScope(['w']); f.emit('s', 'turn/start', { turn: 2 }, 9); f.emit('s', 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 10)
  assert.equal(f.facts.at(-1).target.workspaceId, 'w')
  assert.equal(f.events.center.read().unreadCount, 0)
})

test('远端同ID隔离，恢复请求沿用逻辑身份，断线不报错误而旧点击被拒绝', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose()); f.configure({ managedWorkspaceIds: ['w', 'peer:w'] })
  const fact = { kind: 'question', logicalId: 'question:q', sessionId: 's', workspaceId: 'w', requestId: 'q', requestKind: 'question', sessionTitle: '远程', workspaceLabel: '远程项目', hostLabel: '远端', seq: 1 }
  const feed = { protocol: 1, epoch: 'epoch', revision: 1, baseline: true, gap: false, events: [], pending: [fact], capabilities: { completed: true, error: true, requests: true, resolve: true, recovery: true } }
  f.remote().onUpdate({ hostId: 'peer', hostLabel: '远端', connectionGeneration: 1, feed })
  f.emit('s', 'approval/asked', { id: 'a' }, 1)
  assert.equal(f.events.center.read().pendingCount, 2)
  const peer = f.events.center.read().items.find(item => item.connectionGeneration === 1)!
  f.remote().onUnavailable('peer', 1, '断线', false)
  await assert.rejects(f.events.center.target({ noticeId: peer.noticeId, generation: f.events.center.generation, connectionGeneration: 1 }), /不可达/u)
  f.remote().onUpdate({ hostId: 'peer', hostLabel: '远端', connectionGeneration: 2, feed })
  assert.equal(f.events.center.read().pendingCount, 2)
  assert.equal(f.events.center.read().items.find(item => item.connectionGeneration === 2)!.noticeId, peer.noticeId)
  await assert.rejects(f.events.center.target({ noticeId: peer.noticeId, generation: f.events.center.generation, connectionGeneration: 1 }), /连接已变化/u)
  assert.equal((await f.events.center.target({ noticeId: peer.noticeId, generation: f.events.center.generation, connectionGeneration: 2 })).hostId, 'peer')
  f.remote().onUpdate({ hostId: 'peer', hostLabel: '远端', connectionGeneration: 2, feed: { ...feed, revision: 2, pending: [] } })
  assert.equal(f.events.center.read().pendingCount, 1)
})

test('未创建助理的来源租约到期清理范围和投影，迟到事实不会继续输出', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture({ created: false }); t.after(() => f.events.dispose())
  f.events.sourceScope(['w']); f.emit('s', 'approval/asked', { id: 'a' }, 1)
  assert.equal(f.events.recoverSource(['w']).length, 1)
  t.mock.timers.tick(10_001)
  assert.equal(f.events.recoverSource(['w']).length, 0)
  const count = f.facts.length
  f.emit('s', 'approval/asked', { id: 'late' }, 2)
  f.project('s', { active: [{ callId: 'late-question' }], settled: [] })
  assert.equal(f.facts.length, count)
})

test('远端已经证明的父子请求保留实际子身份，同父同请求ID不会误合并或误清', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose()); f.configure({ managedWorkspaceIds: ['peer:w'] })
  const fact = { kind: 'question', logicalId: 'question:q', sessionId: 's', workspaceId: 'w', requestId: 'q', requestKind: 'question', sessionTitle: '父会话', workspaceLabel: '远程项目', hostLabel: '远端' }
  const pending = ['child-1', 'child-2'].map(actualRequestSessionId => ({ ...fact, actualRequestSessionId }))
  const feed = { protocol: 1, epoch: 'epoch', revision: 1, baseline: true, gap: false, events: [], pending, capabilities: { completed: true, error: true, requests: true, resolve: true, recovery: true } }
  f.remote().onUpdate({ hostId: 'peer', hostLabel: '远端', connectionGeneration: 1, feed })
  const frame = f.events.center.read(); assert.equal(frame.pendingCount, 2)
  const targets = await Promise.all(frame.items.map(item => f.events.center.target({ noticeId: item.noticeId, generation: frame.generation, connectionGeneration: 1 })))
  assert.deepEqual(new Set(targets.map(item => item.actualRequestTarget!.sessionId)), new Set(['child-1', 'child-2']))
  assert.ok(targets.every(item => item.sessionId === 's'))
  f.remote().onUpdate({ hostId: 'peer', hostLabel: '远端', connectionGeneration: 1, feed: { ...feed, revision: 2, pending: [pending[1]] } })
  assert.equal(f.events.center.read().pendingCount, 1)
})

test('类型开关保留已重连的远端订阅和待办收起状态，新请求与精确结算继续生效', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose()); f.configure({ managedWorkspaceIds: ['w', 'peer:w'] })
  const observer = f.remote()
  const approval = { kind: 'approval', logicalId: 'approval:a', requestId: 'a', sessionId: 's', workspaceId: 'w', sessionTitle: '远程会话', workspaceLabel: '远程项目', hostLabel: '远端', seq: 2 }
  const feed = { protocol: 1, epoch: 'remote', revision: 1, baseline: true, gap: false, events: [], pending: [approval], capabilities: { completed: true, error: true, requests: true, resolve: true, recovery: true } }
  observer.onUpdate({ hostId: 'peer', hostLabel: '远端', connectionGeneration: 3, feed })
  const before = f.events.center.read()
  f.events.center.ack({ noticeId: before.primary!.noticeId, generation: before.generation, action: 'dismiss' })
  f.configure({ notifications: { ...f.settings().assistant.notifications, completed: false } })
  assert.equal(f.remote(), observer, '单类型开关不能重建连接并把代次从3重置到1')
  assert.equal(f.events.center.read().primary, null)
  assert.equal(f.events.center.read().items[0]!.noticeId, before.primary!.noticeId)
  observer.onUpdate({ hostId: 'peer', hostLabel: '远端', connectionGeneration: 3, feed: { ...feed, revision: 2, pending: [approval, { ...approval, requestId: 'b', logicalId: 'approval:b', seq: 3 }] } })
  assert.equal(f.events.center.read().pendingCount, 2)
  observer.onUpdate({ hostId: 'peer', hostLabel: '远端', connectionGeneration: 3, feed: { ...feed, revision: 3, pending: [] } })
  assert.equal(f.events.center.read().pendingCount, 0)
  f.emit('s', 'approval/asked', { id: 'local' }, 1)
  f.configure({ notifications: { ...f.settings().assistant.notifications, approval: false } })
  const facts = f.facts.length
  assert.equal(f.events.center.read().pendingCount, 0)
  f.configure({ notifications: { ...f.settings().assistant.notifications, approval: true } })
  assert.equal(f.events.center.read().pendingCount, 1)
  assert.equal(f.facts.length, facts, '配置恢复当前待办不能写入重复来源事件')
})
