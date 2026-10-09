import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantNotificationEvents, assistantNotificationTerminal } from '../src/host/features/assistant-notification-events.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import type { CodingNsHostServices } from '../src/host/features/types.js'
import { getAdapterRegistry, setAdapterRegistry } from '../src/host/cli-adapters/registry-holder.js'

function fixture(options: { created?: boolean } = {}) {
  let settings = { ...structuredClone(DEFAULT_CODINGNS_SETTINGS), modules: { globalVoiceAssistant: true }, assistant: { ...structuredClone(DEFAULT_CODINGNS_SETTINGS.assistant), appearance: { ...structuredClone(DEFAULT_CODINGNS_SETTINGS.assistant.appearance!), floatingEnabled: true }, profile: { name: '助理', initialized: options.created !== false, createdAt: 1 }, managedWorkspaceIds: ['w'] } }
  const sessions = new Map<string, any>(['s', 'outside', 'archived', 'codingns-assistant-self', 'child'].map(id => [id, { id, title: `标题-${id}`, header: { id, ...(id === 'child' ? { parentSession: 's' } : {}) }, events: [], snapshotEvents() { return this.events } }]))
  let members = ['s', 'archived', 'codingns-assistant-self']
  let archived = ['archived']
  const projection = new Map<string, any>()
  const liveAgents = new Set(['s', 'outside', 'archived', 'codingns-assistant-self', 'child'])
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
    if (name === 'agents') return { get: (id: string) => liveAgents.has(id) ? { id } : undefined }
  } } } as unknown as CodingNsHostServices
  const events = new AssistantNotificationEvents(services, { onFact: (fact) => facts.push(fact) })
  const append = (id: string, event: any) => { sessions.get(id).events.push(event); return events.sessionEvent(sessions.get(id), event) }
  const emit = (id: string, type: string, data: unknown, seq?: number) => append(id, { type, data, ...(seq === undefined ? {} : { seq }) })
  return { events, services, sessions, emit, append, facts, settings: () => settings, configure: (patch: any) => { settings = { ...settings, assistant: { ...settings.assistant, ...patch } }; events.sync() },
    setLiveAgents: (ids: string[]) => { liveAgents.clear(); for (const id of ids) liveAgents.add(id) },
    hiddenWorkspaces: (ids: string[]) => { settings = { ...settings, workspaceSessionEnhancement: { ...settings.workspaceSessionEnhancement, hiddenWorkspaceIds: ids } }; events.refreshMembership() },
    archive: (ids: string[]) => { archived = ids; events.refreshMembership() }, membership: (ids: string[]) => { members = ids; events.refreshMembership() },
    project(id: string, value: unknown) { projection.set(id, value); projectionListener?.(sessions.get(id), 'userQuestions', value) },
    remote: () => remoteObserver,
  }
}

test('读取时实时扫描会话事件流，识别订阅之前就已存在的等待审批并随终态校正', (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  // 事件在通知服务观察之前就已写入会话日志：不经过 sessionEvent，只在读取时扫描。
  f.sessions.get('s').events.push({ type: 'turn/start', data: { turn: 1 }, seq: 1 })
  f.sessions.get('s').events.push({ type: 'approval/asked', data: { id: 'a-early' }, seq: 2 })
  f.events.readCurrent()
  const frame = f.events.center.read()
  assert.equal(frame.pendingCount, 1)
  assert.equal(frame.primary!.kind, 'approval')
  f.sessions.get('s').events.push({ type: 'approval/decided', data: { id: 'a-early', outcome: 'allowed-once' }, seq: 3 })
  f.events.readCurrent()
  assert.equal(f.events.center.read().pendingCount, 0)
})

test('没有活跃 Agent 的未闭合回合不产生提醒，Agent 恢复后同一读取路径可见', (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  f.setLiveAgents([])
  f.sessions.get('s').events.push({ type: 'turn/start', data: { turn: 1 }, seq: 1 })
  f.sessions.get('s').events.push({ type: 'approval/asked', data: { id: 'stale' }, seq: 2 })
  f.events.readCurrent()
  assert.equal(f.events.center.read().pendingCount, 0)
  f.setLiveAgents(['s'])
  f.events.readCurrent()
  assert.equal(f.events.center.read().pendingCount, 1)
})

test('处理完成后待办记录自动清理，不需要手动收起（Agent 已释放同样生效）', (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  f.emit('s', 'approval/asked', { id: 'a1' }, 1)
  assert.equal(f.events.center.read().pendingCount, 1)
  // 用户在会话里处理完成，Agent 随后释放；下一次读取必须自动撤掉这条提醒。
  f.setLiveAgents([])
  f.append('s', { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' }, seq: 2 })
  f.events.readCurrent()
  assert.equal(f.events.center.read().pendingCount, 0)
})

test('通知服务重建后从会话事件流与提问投影恢复当前待办，投影结算立即清理', (t) => {
  const first = fixture(); t.after(() => first.events.dispose())
  first.emit('s', 'approval/asked', { id: 'a1' }, 1)
  first.project('s', { active: [{ callId: 'call-1', state: 'continued', questions: [] }], settled: [] })
  assert.equal(first.events.center.read().pendingCount, 2)
  const second = new AssistantNotificationEvents(first.services, { onFact: () => undefined })
  t.after(() => second.dispose())
  // 同一进程内重建只重扫当前事件流与投影，恢复两条待办。
  assert.equal(second.center.read().pendingCount, 2)
  first.project('s', { active: [], settled: [{ callId: 'call-1', answers: [] }] })
  second.readCurrent()
  assert.equal(second.center.read().pendingCount, 1)
})

test('在途观察与提问投影都只接受非隐藏工作区的非归档会话', (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  f.emit('s', 'approval/asked', { id: 'a1' }, 1)
  f.project('s', { active: [{ callId: 'call-1', state: 'continued', questions: [] }], settled: [] })
  assert.equal(f.events.center.read().pendingCount, 2)
  f.hiddenWorkspaces(['w'])
  assert.equal(f.events.center.read().pendingCount, 0)
  f.hiddenWorkspaces([])
  assert.equal(f.events.center.read().pendingCount, 2)
  f.archive(['s'])
  assert.equal(f.events.center.read().pendingCount, 0)
})

test('关闭范围的终态被结算，重开后不补弹；仍在途的请求可以恢复', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  let answer!: (value: unknown) => void
  f.append('s', { type: 'tool/call', seq: 1, data: { callId: 'q', name: 'ask_user_question' } })
  const pending = f.events.observeRequest('user-questions/request', [{ agent: { session: f.sessions.get('s') }, requestId: 'q', questions: [{ id: 'q' }] }, () => new Promise(resolve => { answer = resolve })]) as Promise<unknown>
  f.emit('s', 'approval/asked', { id: 'a' }, 2)
  assert.equal(f.events.center.read().pendingCount, 2)
  f.configure({ notifications: { ...f.settings().assistant.notifications, enabled: false } })
  // 关闭期间工具结束并写入结果；终态必须被结算，否则重开后会出现幽灵提醒。
  f.append('s', { type: 'tool/result', seq: 3, data: { callId: 'q', message: { toolCallId: 'q' } } })
  f.configure({ notifications: { ...f.settings().assistant.notifications, enabled: true } })
  const frame = f.events.center.read()
  assert.equal(frame.pendingCount, 1)
  assert.equal(frame.primary!.kind, 'approval')
  answer({ answers: [{ id: 'q', selected: ['是'] }] }); await pending
})

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

test('阻塞式问题以工具调用等待回答，多请求结算互不误清', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  let answer!: (value: unknown) => void
  f.append('s', { type: 'tool/call', seq: 1, data: { callId: 'call-1', name: 'ask_user_question' } })
  const first = f.events.observeRequest('user-questions/request', [{ agent: { session: f.sessions.get('s') }, questions: [{ id: 'question' }] }, () => new Promise(resolve => { answer = resolve })]) as Promise<unknown>
  f.append('s', { type: 'tool/call', seq: 2, data: { callId: 'call-2', name: 'ask_user_question' } })
  const controller = new AbortController()
  let answerSecond!: (value: unknown) => void
  const second = f.events.observeRequest('user-questions/request', [{ agent: { session: f.sessions.get('s') }, questions: [{ id: 'question' }], signal: controller.signal }, () => new Promise(resolve => { answerSecond = resolve })]) as Promise<unknown>
  assert.equal(f.events.center.read().pendingCount, 2)
  const response = { answers: [{ id: 'question', selected: ['是'] }] }
  answer(response); assert.equal(await first, response)
  f.append('s', { type: 'tool/result', seq: 3, data: { callId: 'call-1', message: { toolCallId: 'call-1' } } })
  assert.equal(f.events.center.read().pendingCount, 1)
  controller.abort()
  f.append('s', { type: 'tool/result', seq: 4, data: { callId: 'call-2', message: { toolCallId: 'call-2' } } })
  assert.equal(f.events.center.read().pendingCount, 0)
  answerSecond(response); await second
})

test('定时问题超时后由提问投影继续待处理，投影结算才结束', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  const controller = new AbortController(); let resolve!: (value: unknown) => void
  f.append('s', { type: 'tool/call', seq: 1, data: { callId: 'call', name: 'ask_user_question' } })
  const waiting = f.events.observeRequest('user-questions/request', [{ agent: { session: f.sessions.get('s') }, questions: [{ id: 'q' }], wait: { callId: 'call', timed: true }, signal: controller.signal }, () => new Promise(r => { resolve = r })]) as Promise<unknown>
  controller.abort(Object.assign(new Error('超时'), { code: 'ASK_TIMED_OUT' })); resolve(undefined); await waiting
  // 前台等待超时后工具返回 pending 结果；等待状态改由 DSH 提问投影续接。
  f.append('s', { type: 'tool/result', seq: 2, data: { callId: 'call', message: { toolCallId: 'call' } } })
  f.project('s', { active: [{ callId: 'call', state: 'continued', questions: [] }], settled: [] })
  assert.equal(f.events.center.read().pendingCount, 1)
  f.project('s', { active: [], settled: [{ callId: 'call', answers: [] }] })
  assert.equal(f.events.center.read().pendingCount, 0)
  assert.equal(f.events.center.read().capabilities[0]!.recovery, true)
})

test('受管成员、归档、全局助理自身与子会话过滤；范围外会话不产生提醒', async (t) => {
  const f = fixture(); t.after(() => f.events.dispose())
  for (const id of ['outside', 'archived', 'codingns-assistant-self', 'child']) f.emit(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 1)
  assert.equal(f.events.center.read().unreadCount, 0)
  // 子会话不在工作区成员关系内：不单独产生提醒。
  f.emit('child', 'approval/asked', { id: 'child-a' }, 2)
  assert.equal(f.events.center.read().pendingCount, 0)
  // 显式纳入工作区后按当前范围提醒，归档后立即失效并清理目标。
  f.membership(['s', 'child'])
  const frame = f.events.center.read(); assert.equal(frame.pendingCount, 1); assert.equal(frame.primary!.sessionTitle, '标题-child')
  assert.equal((await f.events.center.target({ noticeId: frame.primary!.noticeId, generation: frame.generation })).sessionId, 'child')
  f.archive(['child'])
  assert.equal(f.events.center.read().pendingCount, 0)
  await assert.rejects(f.events.center.target({ noticeId: frame.primary!.noticeId, generation: frame.generation }), /失效/u)
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
