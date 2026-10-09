import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDshNativeDispatch, readWireArgs } from '../data/build/dist/host/modules/peer-host/peer-host-native-dispatch.js'

test('交互事件走 Gateway wireStream，回答走 Connection 原生拦截器', async () => {
  const calls: unknown[][] = []
  const gateway = {
    invoke: async () => { throw new Error('不能把 Gateway 自有事件当成业务 Remote') },
    stream: async () => { throw new Error('不能把 Gateway 自有事件当成业务 Remote') },
    wireStream: { open: async (...args: unknown[]) => {
      calls.push(args)
      return (async function* () {
        yield { type: 'ready', clientId: 'peer-client' }
        yield { type: 'emit', event: 'settings/document-updated', args: [{ privateSetting: true }] }
      })()
    } },
  }
  const connection = {
    createSharedFetchHandler(channel: string) {
      assert.equal(channel, '/api')
      return { async fetch(request: Request) {
        assert.equal(new URL(request.url).pathname, '/api/$events/result')
        const envelope = await request.json() as any
        assert.equal(envelope.type, 'client-request')
        assert.equal(envelope.method, '$events/result')
        assert.deepEqual(envelope.payload, { args: { clientId: 'peer-client', eventId: 'e', outcome: { kind: 'result', value: 'rejected' } } })
        return Response.json({ result: { ok: true } })
      } }
    },
  }
  const ctx = { get: (name: string) => name === 'typertGateway' ? gateway : connection }
  const dispatch = resolveDshNativeDispatch(ctx as never)!
  const controller = new AbortController()
  const stream = await dispatch.stream('$events', { args: {} }, controller.signal)
  assert.deepEqual(await Array.fromAsync(stream), [{ type: 'ready', clientId: 'peer-client' }])
  assert.equal(calls[0]?.[0], '$events')
  assert.equal(calls[0]?.[4], controller.signal)
  await dispatch.rpc('$events/result', { args: { clientId: 'peer-client', eventId: 'e', outcome: { kind: 'result', value: 'rejected' } } })
})

test('旧 Gateway 明确报告不支持事件协议，事件回答保留原生失败原因', async () => {
  const gateway = { invoke: async () => undefined, stream: async () => (async function* () {})() }
  const connection = { createSharedFetchHandler: () => ({ fetch: async () => Response.json({ result: { ok: false, error: { code: 'gateway/expired', message: '审批已过期' } } }) }) }
  const dispatch = resolveDshNativeDispatch({ get: (name: string) => name === 'typertGateway' ? gateway : connection } as never)!
  await assert.rejects(dispatch.stream('$events', { args: {} }), { code: 'CODINGNS_RPC_UNSUPPORTED' })
  await assert.rejects(dispatch.rpc('$events/result', { args: {} }), { code: 'gateway/expired', message: '审批已过期' })
})

interface Recorded {
  readonly namespace: string
  readonly method: string
  readonly args: unknown
  readonly signal?: AbortSignal
}

function fakeContext(input: {
  readonly calls: Recorded[]
  readonly streamValue?: readonly unknown[]
}): { get: (name: string) => unknown } {
  const gateway = {
    async invoke(request: Recorded) {
      input.calls.push(request)
      return { items: [] }
    },
    async stream(request: Recorded) {
      input.calls.push(request)
      return (async function* () {
        for (const value of input.streamValue ?? []) yield value
      })()
    },
  }
  return { get: (name) => (name === 'typertGateway' ? gateway : undefined) }
}

test('原生派发把线上载荷解成名字参数后交给 DSH Gateway', async () => {
  const calls: Recorded[] = []
  const dispatch = resolveDshNativeDispatch(fakeContext({ calls }) as never)
  assert.ok(dispatch)
  assert.deepEqual(await dispatch.rpc('session/list', { args: { _request: { cursor: 3 } } }), { items: [] })
  assert.deepEqual(calls[0], { namespace: 'session', method: 'list', args: { _request: { cursor: 3 } } })

  const controller = new AbortController()
  await dispatch.rpc('session/list', undefined, controller.signal)
  assert.equal(calls[1]?.signal, controller.signal)
  assert.deepEqual(calls[1]?.args, {})
})

test('原生流派发保持方法拆分与帧透传', async () => {
  const calls: Recorded[] = []
  const dispatch = resolveDshNativeDispatch(fakeContext({ calls, streamValue: [{ type: 'baseline' }] }) as never)
  assert.ok(dispatch)
  const frames: unknown[] = []
  for await (const frame of await dispatch.stream('session/follow', { args: { request: { address: { kind: 'session' } } } })) frames.push(frame)
  assert.deepEqual(frames, [{ type: 'baseline' }])
  assert.deepEqual(calls[0], { namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session' } } } })
})

test('DSH Service 启动稍晚时，原生 unary 调用有限等待后成功', async () => {
  let attempts = 0
  const calls: Recorded[] = []
  const gateway = {
    async invoke(request: Recorded) {
      calls.push(request)
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('active Service "sessionController" is unavailable'), { code: 'gateway/service-unavailable' })
      return { items: [] }
    },
    async stream() { return (async function* () {})() },
  }
  const dispatch = resolveDshNativeDispatch({ get: (name) => name === 'typertGateway' ? gateway : undefined } as never)
  assert.ok(dispatch)
  assert.deepEqual(await dispatch.rpc('session/list', { args: { _request: {} } }), { items: [] })
  assert.equal(attempts, 3)
  assert.equal(calls.length, 3)
})

test('DSH Service 启动稍晚时，原生流式调用有限等待后成功', async () => {
  let attempts = 0
  const gateway = {
    async invoke() { return { items: [] } },
    async stream(request: Recorded) {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('active Service "workspaceController" is unavailable'), { code: 'gateway/service-unavailable' })
      return (async function* () { yield request })()
    },
  }
  const dispatch = resolveDshNativeDispatch({ get: (name) => name === 'typertGateway' ? gateway : undefined } as never)
  assert.ok(dispatch)
  const frames: unknown[] = []
  for await (const frame of await dispatch.stream('workspace/follow', { args: { request: { address: { kind: 'workspace' } } } })) frames.push(frame)
  assert.equal(attempts, 3)
  assert.deepEqual(frames, [{ namespace: 'workspace', method: 'follow', args: { request: { address: { kind: 'workspace' } } } }])
})

test('DSH Gateway 业务错误不触发原生调用重试', async () => {
  let attempts = 0
  const gateway = {
    async invoke() {
      attempts += 1
      throw Object.assign(new Error('session not found'), { code: 'session/not-found' })
    },
    async stream() { return (async function* () {})() },
  }
  const dispatch = resolveDshNativeDispatch({ get: (name) => name === 'typertGateway' ? gateway : undefined } as never)
  assert.ok(dispatch)
  await assert.rejects(() => dispatch.rpc('session/list', { args: {} }), (error: unknown) => (error as { code?: string }).code === 'session/not-found')
  assert.equal(attempts, 1)
})

test('缺少 Typert Gateway 或方法名非法时给出稳定诊断', async () => {
  assert.equal(resolveDshNativeDispatch(undefined), undefined)
  assert.equal(resolveDshNativeDispatch({ get: () => undefined } as never), undefined)
  assert.equal(resolveDshNativeDispatch({ get: () => ({ invoke: 1, stream: 2 }) } as never), undefined)

  const dispatch = resolveDshNativeDispatch(fakeContext({ calls: [] }) as never)
  assert.ok(dispatch)
  await assert.rejects(async () => { await dispatch.rpc('follow', {}) }, (error: unknown) => (error as { code?: string }).code === 'CODINGNS_RPC_NOT_FOUND')
})

test('线上载荷只接受 args 信封或名字参数对象', () => {
  assert.deepEqual(readWireArgs(undefined), {})
  assert.deepEqual(readWireArgs({ args: { _request: {} } }), { _request: {} })
  assert.deepEqual(readWireArgs({ _request: {} }), { _request: {} })
  assert.throws(() => readWireArgs({ args: [] }), (error: unknown) => (error as { code?: string }).code === 'CODINGNS_RPC_INVALID')
  assert.throws(() => readWireArgs([1, 2]), (error: unknown) => (error as { code?: string }).code === 'CODINGNS_RPC_INVALID')
})
