import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodingNsNativeSessionBridge } from '../dist/host/native-session-bridge.js'

test('原生会话桥接优先调用 SessionController 并复用已存在会话', async () => {
  const sessions = new Map<string, object>()
  const calls: string[] = []
  const ctx = {
    get(name: string) {
      if (name === 'sessions') return {
        get(id: string) { return sessions.get(id) },
        list() { return [...sessions.values()] },
      }
      if (name === 'sessionController') return {
        async create(input: { sessionId?: string }) {
          calls.push(`controller:${input.sessionId ?? ''}`)
          const id = input.sessionId ?? 'generated'
          sessions.set(id, {})
          return { sessionId: id }
        },
        async list() { return { items: [{ sessionId: 'dsh-1' }] } },
      }
      return undefined
    },
  } as never
  const bridge = createCodingNsNativeSessionBridge(ctx)
  assert.equal(bridge.available, true)
  assert.equal(await bridge.ensure('dsh-1', '/tmp/project'), 'dsh-1')
  assert.deepEqual(calls, ['controller:dsh-1'])
  assert.equal(await bridge.ensure('dsh-1'), 'dsh-1')
  assert.deepEqual(calls, ['controller:dsh-1'])
  assert.equal(bridge.list().length, 1)
  assert.deepEqual(await bridge.listRemote(), [{ sessionId: 'dsh-1' }])
})

test('原生会话桥接通过 get 探测可选服务，不直接读取未注入属性', () => {
  const reads: string[] = []
  const ctx = new Proxy({
    get(name: string) {
      reads.push(name)
      return undefined
    },
  }, {
    get(target, property, receiver) {
      if (property === 'sessions' || property === 'sessionController') {
        throw new Error(`cannot get property ${property} without inject`)
      }
      return Reflect.get(target, property, receiver)
    },
  }) as never

  assert.doesNotThrow(() => createCodingNsNativeSessionBridge(ctx))
  assert.deepEqual(reads, ['sessions', 'sessionController'])
})

test('原生事件订阅在 Host 停用时可移除', () => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    get() { return undefined },
    on(name: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  } as never
  const bridge = createCodingNsNativeSessionBridge(ctx)
  const events: unknown[] = []
  const dispose = bridge.subscribe({ onEvent: (_session, event) => events.push(event) })
  listeners.get('session/event')?.('s', { type: 'assistant/message' })
  assert.deepEqual(events, [{ type: 'assistant/message' }])
  dispose()
  assert.equal(listeners.size, 0)
})

test('缺少原生服务时桥接安全降级，不阻断插件', async () => {
  const bridge = createCodingNsNativeSessionBridge({ get() { return undefined } } as never)
  assert.equal(bridge.available, false)
  assert.equal(await bridge.ensure('dsh-1'), null)
  assert.deepEqual(bridge.list(), [])
  await bridge.flush('dsh-1')
  assert.doesNotThrow(() => bridge.subscribe({}))
})

test('只有 SessionStore 时只复用已有会话，不创建短命会话', async () => {
  const sessions = new Map<string, object>()
  let flushed = 0
  const store = {
    get(id: string) { return sessions.get(id) },
    list() { return [...sessions.values()] },
    async flush() { flushed += 1 },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) { return name === 'sessions' ? store : undefined },
  } as never)
  assert.equal(await bridge.ensure('dsh-2'), null)
  sessions.set('dsh-2', { id: 'dsh-2' })
  assert.equal(await bridge.ensure('dsh-2'), 'dsh-2')
  await bridge.flush('dsh-2')
  assert.equal(flushed, 1)
})
