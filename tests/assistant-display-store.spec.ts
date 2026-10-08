import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AssistantDisplayResource, AssistantDisplayStore, assistantDisplayScope, getAssistantDisplayStore } from '../src/client/features/assistant-display-store.js'
import type { CodingNsRpcClient } from '../src/client/features/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
function documentFixture() {
  const events = new EventTarget()
  const dom = Object.assign(events, { visibilityState: 'visible' })
  return { dom: dom as unknown as Document, hide() { dom.visibilityState = 'hidden'; events.dispatchEvent(new Event('visibilitychange')) }, show() { dom.visibilityState = 'visible'; events.dispatchEvent(new Event('visibilitychange')) } }
}

test('同 RPC 与范围复用快照和在途请求，不同范围及 RPC 完全隔离', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = deferred<any>(); let calls = 0
  const rpc: CodingNsRpcClient = { call: async () => { calls++; return pending.promise } }
  const first = getAssistantDisplayStore(rpc, assistantDisplayScope(['b', 'a', 'a']))
  const second = getAssistantDisplayStore(rpc, assistantDisplayScope(['a', 'b']))
  assert.equal(first, second)
  assert.notEqual(first, getAssistantDisplayStore(rpc, assistantDisplayScope(['a'])))
  assert.notEqual(first, getAssistantDisplayStore({ ...rpc }, assistantDisplayScope(['a', 'b'])))
  const release = first.status.subscribe(() => {}); const release2 = second.status.subscribe(() => {})
  context.after(() => { release(); release2() })
  const same = first.status.refresh(); assert.equal(same, second.status.refresh())
  await setImmediate(); context.mock.timers.tick(50_000); await setImmediate(); assert.equal(calls, 1)
  pending.resolve({ ok: true, value: { revision: 1, indexState: 'ready', workspaces: [] } }); await same
  assert.equal(first.status.getSnapshot(), second.status.getSnapshot())
  release(); context.mock.timers.tick(3000); await setImmediate(); assert.equal(calls, 2, '还有订阅者时继续轮询')
})

test('隐藏暂停展示请求并丢弃迟到结果，可见恢复一次，最后解绑取消等待与排队刷新', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const visibility = documentFixture(); let pending = deferred<number>(); let calls = 0; let notifications = 0
  const resource = new AssistantDisplayResource(async () => { calls++; return pending.promise }, () => 1000, visibility.dom)
  let release = resource.subscribe(() => { notifications++ }); await setImmediate()
  visibility.hide(); await setImmediate(); pending.resolve(1); await setImmediate()
  assert.equal(notifications, 0); assert.equal(resource.getSnapshot().value, undefined)
  context.mock.timers.tick(60_000); await resource.refresh(); assert.equal(calls, 1)
  pending = deferred<number>(); visibility.show(); await setImmediate(); assert.equal(calls, 2)
  pending.resolve(2); await setImmediate(); assert.equal(resource.getSnapshot().value, 2)
  const old = resource.getSnapshot(); pending = deferred<number>(); context.mock.timers.tick(1000); await setImmediate()
  const queued = resource.refresh({ force: true }); release(); await queued
  pending.resolve(3); await setImmediate(); assert.equal(resource.getSnapshot(), old); assert.equal(calls, 3)
  pending = deferred<number>(); release = resource.subscribe(() => {}); await setImmediate()
  assert.equal(calls, 4); pending.resolve(4); await setImmediate(); release()
})

test('失败指数退避，成功后恢复正常间隔；后台慢请求不堆叠', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const resource = new AssistantDisplayResource(async () => { if (++calls < 3) throw new Error('断线'); return calls }, () => 1000)
  const release = resource.subscribe(() => {}); context.after(release)
  await setImmediate(); assert.ok(resource.getSnapshot().error)
  context.mock.timers.tick(1999); await setImmediate(); assert.equal(calls, 1)
  context.mock.timers.tick(1); await setImmediate(); assert.equal(calls, 2)
  context.mock.timers.tick(3999); await setImmediate(); assert.equal(calls, 2)
  context.mock.timers.tick(1); await setImmediate(); assert.equal(calls, 3); assert.equal(resource.getSnapshot().error, undefined)
  context.mock.timers.tick(1000); await setImmediate(); assert.equal(calls, 4)
})

test('显式调试刷新传 refresh:true，与被动在途请求串行并合并重复点击', async () => {
  let pending = deferred<any>(); const payloads: unknown[] = []
  const store = new AssistantDisplayStore({ call: async (_channel, endpoint, payload) => { assert.equal(endpoint, 'assistant/debug'); payloads.push(payload); return pending.promise } })
  const passive = store.debug.refresh(); await setImmediate()
  const refresh = store.debug.refresh({ force: true }); assert.equal(refresh, store.debug.refresh({ force: true }))
  assert.deepEqual(payloads, [{}])
  const old = pending; pending = deferred<any>(); old.resolve({ ok: true, value: { capturedAt: 1 } }); await passive; await setImmediate()
  assert.deepEqual(payloads, [{}, { refresh: true }])
  pending.resolve({ ok: true, value: { capturedAt: 2 } }); await refresh
  assert.equal(store.debug.getSnapshot().value?.capturedAt, 2)
})

test('旧 Host 仅探测一次未知 status，降级与调试面板共用缓存，显式刷新仍立即读取', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const calls: string[] = []; const payloads: unknown[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload) => {
    calls.push(endpoint); payloads.push(payload)
    return endpoint === 'assistant/status' ? { ok: false, error: { code: 'ERROR', message: '未知全局语音 RPC: assistant/status' } }
      : { ok: true, value: { capturedAt: Date.now(), indexState: 'ready', index: { generation: 1 }, workspaces: [] } }
  } }
  const store = new AssistantDisplayStore(rpc)
  const release = store.status.subscribe(() => {}); const releaseDebug = store.debug.subscribe(() => {})
  context.after(() => { release(); releaseDebug() })
  await setImmediate(); assert.equal(calls.filter((action) => action === 'assistant/status').length, 1)
  assert.equal(calls.filter((action) => action === 'assistant/debug').length, 1)
  context.mock.timers.tick(29_999); await setImmediate(); assert.equal(calls.length, 2)
  context.mock.timers.tick(1); await setImmediate(); assert.equal(calls.length, 3)
  assert.equal(store.status.getSnapshot().value?.indexState, 'ready')
  await store.debug.refresh({ force: true }); assert.deepEqual(payloads.at(-1), { refresh: true })
  const otherScope = new AssistantDisplayStore(rpc); await otherScope.status.refresh()
  assert.equal(calls.filter((action) => action === 'assistant/status').length, 1, '能力探测结果在相同 RPC 的范围之间共享')
})

test('普通网络故障不能被当作不支持 status，下一次恢复仍走轻量接口', async () => {
  let calls = 0; const endpoints: string[] = []
  const store = new AssistantDisplayStore({ call: async (_channel, endpoint) => {
    endpoints.push(endpoint); if (++calls === 1) throw new Error('Network disconnected')
    return { ok: true, value: { revision: 2, indexState: 'ready', workspaces: [] } }
  } })
  await store.status.refresh(); assert.ok(store.status.getSnapshot().error)
  await store.status.refresh(); assert.equal(store.status.getSnapshot().error, undefined)
  assert.deepEqual(endpoints, ['assistant/status', 'assistant/status'])
})

test('范围缓存有界，持续订阅的范围仍保留唯一请求所有者', async () => {
  const rpc: CodingNsRpcClient = { call: async () => ({ ok: true, value: { revision: 1, indexState: 'ready', workspaces: [] } }) }
  const idle = getAssistantDisplayStore(rpc, 'idle')
  const active = getAssistantDisplayStore(rpc, 'active')
  const release = active.status.subscribe(() => {})
  try {
    await setImmediate()
    for (let index = 0; index < 30; index++) getAssistantDisplayStore(rpc, String(index))
    assert.equal(getAssistantDisplayStore(rpc, 'active'), active)
    assert.notEqual(getAssistantDisplayStore(rpc, 'idle'), idle)
  } finally { release() }
})

test('活动聊天快照独立于索引元数据，失败退避，隐藏恢复不取消后台生成', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const visibility = documentFixture(); const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: visibility.dom })
  const calls: string[] = []
  const store = new AssistantDisplayStore({ call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: true, value: { requestId: 'a', state: 'running', text: '' } } } })
  const chat = store.chat('a'); assert.equal(chat, store.chat('a'))
  const release = chat.subscribe(() => {}); context.after(() => { release(); if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
  await setImmediate(); context.mock.timers.tick(600); await setImmediate(); assert.equal(calls.length, 2)
  visibility.hide(); context.mock.timers.tick(60_000); await setImmediate(); assert.equal(calls.length, 2)
  visibility.show(); await setImmediate(); assert.equal(calls.length, 3)
  assert.ok(calls.every((endpoint) => endpoint === 'assistant/chat/read'))
})
