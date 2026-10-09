import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { PeerHostRemoteEvents } from '../data/build/dist/client/peer-host-remote-events.js'
import { createVirtualSessionId } from '../data/build/dist/shared/index.js'

/** 可取消的内存事件源，测试不会连接真实 Host。 */
class Source {
  values: unknown[] = []
  wake?: () => void
  closed = false
  error?: Error
  push(value: unknown) { this.values.push(value); this.wake?.() }
  fail() { this.error = new Error('模拟远端断线'); this.wake?.() }
  async *open(signal: AbortSignal) {
    const abort = () => this.wake?.()
    signal.addEventListener('abort', abort)
    try {
      while (!signal.aborted) {
        if (this.error) throw this.error
        if (this.values.length) yield this.values.shift()
        else await new Promise<void>(resolve => { this.wake = resolve })
      }
    } finally { this.closed = true; signal.removeEventListener('abort', abort) }
  }
}

const scope = (hostId: string) => ({ hostId: 'local', targetHostId: hostId, workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 })
const interaction = (host: string, event = 'approval/request', eventId = 'same-id') => ({
  type: 'waterfall', event, eventId, agentId: createVirtualSessionId(host, 'session'), request: { toolName: 'exec', reason: '模拟审批' },
})

test('单 Host 断线只取消该 Host 的待答事件，重连后的同名事件取得新身份', { timeout: 3000 }, async () => {
  const f = fixture()
  try {
    f.events.setPeers([scope('a'), scope('b')])
    await f.iterator.next()
    await setImmediate()
    f.peers.get('a')!.push(interaction('a'))
    const first = (await f.iterator.next()).value as any
    const old = f.peers.get('a')!
    old.fail()
    assert.deepEqual((await f.iterator.next()).value, { type: 'cancel', eventId: first.eventId })
    await assert.rejects(f.events.reply({ args: { clientId: 'local-client', eventId: first.eventId } }), /交互已结束/)
    f.peers.get('b')!.push(interaction('b'))
    assert.equal((await f.iterator.next()).value.agentId, createVirtualSessionId('b', 'session'))
    for (let attempt = 0; f.peers.get('a') === old && attempt < 100; attempt++) await delay(1)
    assert.notEqual(f.peers.get('a'), old)
    f.peers.get('a')!.push(interaction('a'))
    const replayed = (await f.iterator.next()).value as any
    assert.notEqual(replayed.eventId, first.eventId)
    await f.events.reply({ args: { clientId: 'local-client', eventId: replayed.eventId, outcome: { kind: 'result', value: 'rejected' } } })
    assert.equal(f.replies.at(-1)!.payload.args.outcome.value, 'rejected')
    f.local.push({ type: 'emit', event: 'local/alive', args: [] })
    assert.equal((await f.iterator.next()).value.event, 'local/alive')
  } finally { await f.close() }
})

function fixture() {
  const local = new Source()
  const peers = new Map<string, Source>()
  const replies: Array<{ scope: unknown; payload: any }> = []
  const opens: string[] = []
  const events = new PeerHostRemoteEvents({
    open: (target, signal) => {
      const source = new Source()
      peers.set(target.targetHostId!, source)
      opens.push(target.targetHostId!)
      source.push({ type: 'ready', clientId: `client-${target.targetHostId}`, host: { home: '/remote' } })
      return source.open(signal)
    },
    reply: async (target, payload) => { replies.push({ scope: target, payload }); return true },
    accepts: (agentId, target) => agentId === createVirtualSessionId(target.targetHostId!, 'session'),
    retryMs: 1,
  })
  const controller = new AbortController()
  const iterator = events.open(signal => local.open(signal), controller.signal)[Symbol.asyncIterator]()
  local.push({ type: 'ready', clientId: 'local-client', host: { home: '/local' } })
  return { local, peers, replies, opens, events, iterator, controller, async close() { controller.abort(); await iterator.return?.(); events.dispose() } }
}

test('本机 ready 和事件保持原样，两台 Host 的同名审批分别回传原始 clientId/eventId', { timeout: 3000 }, async () => {
  const f = fixture()
  try {
    assert.deepEqual((await f.iterator.next()).value, { type: 'ready', clientId: 'local-client', host: { home: '/local' } })
    f.events.setPeers([scope('a'), scope('b')])
    await setImmediate()
    const local = { type: 'waterfall', event: 'approval/request', eventId: 'same-id', agentId: 'local-session', request: {} }
    f.local.push(local)
    assert.deepEqual((await f.iterator.next()).value, local)
    f.peers.get('a')!.push(interaction('a'))
    f.peers.get('b')!.push(interaction('b', 'user-questions/request'))
    const first = (await f.iterator.next()).value as any
    const second = (await f.iterator.next()).value as any
    assert.notEqual(first.eventId, second.eventId)
    assert.notEqual(first.eventId, 'same-id')
    assert.equal(first.agentId, createVirtualSessionId('a', 'session'))
    assert.equal(second.event, 'user-questions/request')
    assert.equal(f.events.ownsResult({ args: { eventId: 'same-id' } }), false)
    await assert.rejects(f.events.reply({ args: { clientId: 'wrong', eventId: first.eventId, outcome: { kind: 'result', value: 'approved' } } }), /连接已变更/)
    await f.events.reply({ args: { clientId: 'local-client', eventId: first.eventId, outcome: { kind: 'result', value: 'approved' } } })
    await f.events.reply({ args: { clientId: 'local-client', eventId: second.eventId, outcome: { kind: 'result', value: { answers: [{ id: 'q', selected: ['选项一'] }] } } } })
    assert.deepEqual(f.replies.map(row => row.scope), [scope('a'), scope('b')])
    assert.deepEqual(f.replies.map(row => [row.payload.args.clientId, row.payload.args.eventId]), [['client-a', 'same-id'], ['client-b', 'same-id']])
    assert.equal(f.replies[0]!.payload.args.outcome.value, 'approved')
    await assert.rejects(f.events.reply({ args: { clientId: 'local-client', eventId: first.eventId } }), /交互已结束/)
  } finally { await f.close() }
})

test('取消和移除 Host 立即撤销弹窗，迟到审批不能回落本机或发往其他 Host', { timeout: 3000 }, async () => {
  const f = fixture()
  try {
    f.events.setPeers([scope('a')])
    await f.iterator.next()
    await setImmediate()
    f.peers.get('a')!.push(interaction('a'))
    const first = (await f.iterator.next()).value as any
    f.peers.get('a')!.push({ type: 'cancel', eventId: 'same-id' })
    assert.deepEqual((await f.iterator.next()).value, { type: 'cancel', eventId: first.eventId })
    await assert.rejects(f.events.reply({ args: { clientId: 'local-client', eventId: first.eventId } }), /交互已结束/)
    f.peers.get('a')!.push(interaction('a', 'approval/request', 'next-id'))
    const second = (await f.iterator.next()).value as any
    f.events.setPeers([])
    assert.deepEqual((await f.iterator.next()).value, { type: 'cancel', eventId: second.eventId })
    await assert.rejects(f.events.reply({ args: { clientId: 'local-client', eventId: second.eventId } }), /交互已结束/)
    assert.deepEqual(f.replies, [])
    await setImmediate()
    assert.equal(f.peers.get('a')!.closed, true)
  } finally { await f.close() }
})

test('隐藏会话与未知交互交回目标原生链，全局设置通知不污染本机', { timeout: 3000 }, async () => {
  const f = fixture()
  try {
    f.events.setPeers([scope('a')])
    await f.iterator.next()
    await setImmediate()
    const source = f.peers.get('a')!
    source.push({ ...interaction('a'), agentId: createVirtualSessionId('a', 'hidden') })
    source.push(interaction('a', 'other/request', 'other-id'))
    source.push({ type: 'emit', event: 'settings/document-updated', args: [{ secret: true }] })
    source.push({ ...interaction('a', 'user-questions/request', 'plan-id'), request: { questions: [{ id: 'plan', intent: { kind: 'plan-review', approve: 'yes' } }] } })
    const frame = (await f.iterator.next()).value as any
    assert.equal(frame.request.questions[0].intent.kind, 'plan-review')
    assert.deepEqual(f.replies.map(row => row.payload.args.outcome), [{ kind: 'next' }, { kind: 'next' }])
    assert.deepEqual(f.replies.map(row => row.payload.args.eventId), ['same-id', 'other-id'])
  } finally { await f.close() }
})

test('本机代次结束时清理全部远端，下一代同名事件不能使用旧身份回答', { timeout: 3000 }, async () => {
  const f = fixture()
  try {
    f.events.setPeers([scope('a')])
    await f.iterator.next()
    await setImmediate()
    f.peers.get('a')!.push(interaction('a'))
    const first = (await f.iterator.next()).value as any
    await f.close()
    assert.equal(f.local.closed, true)
    await setImmediate()
    assert.equal(f.peers.get('a')!.closed, true)
    await assert.rejects(f.events.reply({ args: { clientId: 'local-client', eventId: first.eventId } }), /交互已结束/)
  } finally { f.events.dispose() }
})
