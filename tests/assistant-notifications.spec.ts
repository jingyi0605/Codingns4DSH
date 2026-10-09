import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantNotificationCenter, type AssistantNotificationFact } from '../src/host/features/assistant-notifications.js'
import { DEFAULT_ASSISTANT_NOTIFICATION_SETTINGS, normalizeAssistantNotificationSettings } from '../src/shared/assistant-notifications.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'

const local = { hostId: 'local', workspaceId: 'workspace', sessionId: 'session' }
function fixture() {
  let now = 1000
  const center = new AssistantNotificationCenter({ now: () => now })
  center.configure(true, ['workspace'])
  const consume = (value: Omit<AssistantNotificationFact, 'generation' | 'target'> & Partial<Pick<AssistantNotificationFact, 'target'>>) => center.consume({ target: local, generation: center.generation, ...value } as AssistantNotificationFact)
  const turn = (type: 'turn-completed' | 'turn-failed', index: number, seq = index) => consume({ type, turnId: `turn:${index}`, turn: index, seq } as any)
  const request = (requestId: string, requestKind: 'question' | 'approval' = 'question', type: 'request-opened' | 'request-resolved' = 'request-opened') => consume({ type, requestId, requestKind } as any)
  return { center, consume, turn, request, time: (value: number) => { now = value } }
}

test('旧配置缺省五个开关全开，显式关闭保留，设置 schema 不丢通知字段', () => {
  assert.deepEqual(normalizeAssistantNotificationSettings(undefined), DEFAULT_ASSISTANT_NOTIFICATION_SETTINGS)
  assert.deepEqual(normalizeAssistantNotificationSettings({ completed: false, error: 'false' }), { ...DEFAULT_ASSISTANT_NOTIFICATION_SETTINGS, completed: false })
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  delete value.assistant.notifications
  assert.deepEqual(CodingNsSettingsSchema(value).assistant.notifications, DEFAULT_ASSISTANT_NOTIFICATION_SETTINGS)
  value.assistant.notifications = { ...DEFAULT_ASSISTANT_NOTIFICATION_SETTINGS, question: false }
  assert.equal(CodingNsSettingsSchema(value).assistant.notifications!.question, false)
})

test('同轮唯一终态，失败优先且可升级完成，历史淘汰不重置序列水位', () => {
  const f = fixture()
  f.turn('turn-completed', 1, 1)
  const id = f.center.read().primary!.noticeId
  f.turn('turn-failed', 1, 2); f.turn('turn-completed', 1, 3)
  assert.equal(f.center.read().items.length, 1)
  assert.equal(f.center.read().primary!.noticeId, id)
  assert.equal(f.center.read().primary!.kind, 'error')
  for (let index = 2; index <= 120; index++) { f.time(index * 1000); f.turn('turn-completed', index, index + 10) }
  assert.equal(f.center.read({ limit: 50 }).unreadCount, 100)
  f.turn('turn-completed', 1, 1)
  assert.equal(f.center.read().unreadCount, 100)
})

test('请求独立结束，已读和收起都保留待处理，待办不受100条历史容量影响', () => {
  const f = fixture()
  for (let index = 0; index < 110; index++) f.request(`question-${index}`)
  for (let index = 0; index < 120; index++) f.turn('turn-completed', index)
  assert.equal(f.center.read().pendingCount, 110)
  assert.equal(f.center.read().unreadCount, 210)
  const frame = f.center.read(), item = frame.primary!
  const input = { generation: frame.generation, noticeId: item.noticeId }
  f.center.ack({ ...input, action: 'read' }); f.center.ack({ ...input, action: 'dismiss' })
  assert.equal(f.center.read().pendingCount, 110)
  f.request('question-0', 'question', 'request-resolved')
  assert.equal(f.center.read().pendingCount, 109)
  assert.equal(f.center.read().primary!.kind, 'question')
})

test('计时从首次真实展示开始，刷新确认幂等；抢占不重启终态截止时间', () => {
  const f = fixture(); f.turn('turn-completed', 1)
  const frame = f.center.read(), id = frame.primary!.noticeId
  f.time(10_000)
  assert.equal(f.center.read().primary!.deadline, undefined)
  const input = { generation: frame.generation, noticeId: id }
  const first = f.center.ack({ ...input, action: 'presented' })
  assert.equal(first.notification.deadline, 15_000)
  f.time(11_000); f.center.ack({ ...input, action: 'presented' })
  assert.equal(f.center.read().primary!.deadline, 15_000)
  f.request('q'); assert.equal(f.center.read().primary!.kind, 'question')
  f.time(15_000); f.request('q', 'question', 'request-resolved')
  assert.equal(f.center.read().primary, null)
  assert.equal(f.center.read().items.find(item => item.noticeId === id)!.read, false)
  f.turn('turn-failed', 2)
  const error = f.center.read().primary!
  assert.equal(f.center.ack({ noticeId: error.noticeId, generation: f.center.generation, action: 'presented' }).notification.deadline, 23_000)
})

test('未显示终态继续排队，关闭待办不阻止新待办，优先级按有效待办/错误/完成', () => {
  const f = fixture(); f.turn('turn-completed', 1); f.request('q')
  const question = f.center.read().primary!
  f.center.ack({ noticeId: question.noticeId, generation: f.center.generation, action: 'dismiss' })
  assert.equal(f.center.read().primary!.kind, 'completed')
  f.time(1001); f.request('a', 'approval')
  assert.equal(f.center.read().primary!.kind, 'approval')
})

test('跨Host同ID独立，连接代次变更拒绝旧点击且重连不会重复入队', async () => {
  const f = fixture(); f.request('q')
  const target = { ...local, hostId: 'peer', connectionGeneration: 1 }
  f.center.connection('peer', 1, true)
  f.consume({ type: 'request-opened', requestId: 'q', requestKind: 'question', target } as any)
  assert.equal(f.center.read().pendingCount, 2)
  const peer = f.center.read().items.find(item => item.connectionGeneration === 1)!
  f.center.connection('peer', 1, false)
  await assert.rejects(f.center.target({ noticeId: peer.noticeId, generation: f.center.generation, connectionGeneration: 1 }), /不可达/u)
  f.center.connection('peer', 2, true)
  f.consume({ type: 'request-opened', requestId: 'q', requestKind: 'question', target: { ...target, connectionGeneration: 2 } } as any)
  assert.equal(f.center.read().pendingCount, 2)
  await assert.rejects(f.center.target({ noticeId: peer.noticeId, generation: f.center.generation, connectionGeneration: 1 }), /连接已变化/u)
  assert.equal((await f.center.target({ noticeId: peer.noticeId, generation: f.center.generation, connectionGeneration: 2 })).hostId, 'peer')
  f.center.removeHost('peer'); assert.equal(f.center.read().pendingCount, 1)
})

test('游标绑定代次修订，分页上限50，范围撤销、停用和迟到输入不能恢复旧通知', async () => {
  const f = fixture()
  for (let index = 0; index < 31; index++) f.turn('turn-completed', index)
  const page = f.center.read(); assert.equal(page.items.length, 20); assert.ok(page.cursor)
  const second = f.center.read({ cursor: page.cursor! }); assert.equal(second.items.length, 11)
  assert.throws(() => f.center.read({ limit: 51 }), /1 到 50/u)
  assert.throws(() => f.center.read({ revision: -1 }), /修订号/u)
  f.request('q'); assert.equal(f.center.read({ cursor: page.cursor! }).reset, true)
  const old = f.center.read(), oldGeneration = old.generation
  assert.ok(f.center.read({ revision: old.revision }).unchanged)
  assert.ok(!JSON.stringify(old).includes('sessionId'))
  f.center.configure(false, ['workspace'])
  f.center.consume({ type: 'request-opened', target: local, generation: oldGeneration, requestId: 'late', requestKind: 'question' })
  assert.equal(f.center.read().unreadCount, 0)
  await assert.rejects(f.center.target({ noticeId: old.primary!.noticeId, generation: oldGeneration }), /代次/u)
})

test('异步目标校验期间连接或范围变化，结果被拒绝；请求已结束不能导航', async () => {
  let release!: (value: boolean) => void
  const center = new AssistantNotificationCenter({ validateTarget: () => new Promise(resolve => { release = resolve }) })
  center.configure(true, ['workspace']); center.connection('peer', 1, true)
  center.consume({ generation: center.generation, target: { ...local, hostId: 'peer', connectionGeneration: 1 }, type: 'turn-completed', turnId: 't' })
  const id = center.read().primary!.noticeId
  const result = center.target({ noticeId: id, generation: center.generation, connectionGeneration: 1 })
  center.connection('peer', 2, true); release(true)
  await assert.rejects(result, /失效/u)
  const f = fixture(); f.request('q'); const question = f.center.read().primary!
  f.request('q', 'question', 'request-resolved')
  await assert.rejects(f.center.target({ noticeId: question.noticeId, generation: f.center.generation }), /处理或失效/u)
})

test('同毫秒待办保持FIFO，重复事实不推进修订，精确结算后的重投不重新入队', async () => {
  const f = fixture(); f.request('q1'); f.request('q2', 'approval')
  const frame = f.center.read()
  assert.equal((await f.center.target({ noticeId: frame.primary!.noticeId, generation: frame.generation })).requestId, 'q1')
  f.request('q1'); assert.equal(f.center.revision, frame.revision)
  f.request('q1', 'question', 'request-resolved'); const after = f.center.read()
  f.request('q1'); assert.equal(f.center.read().pendingCount, 1); assert.equal(f.center.revision, after.revision)
  assert.throws(() => f.center.read({ cursor: `${'9'.repeat(170)}:0:0` }), /游标/u)
})

test('错误升级后迟到的完成展示确认不能启动计时，当前类型确认才启动8秒', () => {
  const f = fixture(); f.turn('turn-completed', 1, 1)
  const frame = f.center.read(), noticeId = frame.primary!.noticeId
  f.turn('turn-failed', 1, 2); const revision = f.center.revision
  const input = { generation: frame.generation, noticeId, action: 'presented' as const }
  f.time(2000)
  const stale = f.center.ack({ ...input, kind: 'completed' })
  assert.equal(stale.revision, revision)
  assert.equal(stale.notification.deadline, undefined)
  assert.equal(stale.notification.presentation, 'queued')
  f.time(3000)
  assert.equal(f.center.ack({ ...input, kind: 'error' }).notification.deadline, 11_000)
  assert.throws(() => f.center.ack({ ...input, kind: 'invalid' as any }), /确认类型/u)
})

test('错误通知关闭仍保留失败水位，不能留下或重新产生同轮成功提示', () => {
  const f = fixture()
  f.center.configure(true, ['workspace'], { error: false })
  f.turn('turn-completed', 1, 1); assert.equal(f.center.read().unreadCount, 1)
  f.turn('turn-failed', 1, 2); assert.equal(f.center.read().unreadCount, 0)
  f.turn('turn-completed', 1, 3); assert.equal(f.center.read().unreadCount, 0)
  f.turn('turn-completed', 2, 4); assert.equal(f.center.read().unreadCount, 1)
})

test('类型开关只移除对应通知，无关待办保持身份和收起状态，重新基线不撤销失败证明', () => {
  const f = fixture(); f.request('a', 'approval'); f.turn('turn-failed', 1, 1)
  const before = f.center.read(), approval = before.primary!
  f.center.ack({ noticeId: approval.noticeId, generation: before.generation, action: 'dismiss' })
  f.center.configure(true, ['workspace'], { completed: false })
  const after = f.center.read()
  assert.equal(after.generation, before.generation)
  assert.equal(after.items.find(item => item.kind === 'approval')!.noticeId, approval.noticeId)
  assert.equal(after.items.find(item => item.kind === 'approval')!.presentation, 'collapsed')
  f.center.configure(true, ['workspace'], { error: false })
  assert.equal(f.center.read().unreadCount, 1)
  f.center.baseline(local, 2); f.turn('turn-completed', 1, 3)
  assert.equal(f.center.read().unreadCount, 1)
})
