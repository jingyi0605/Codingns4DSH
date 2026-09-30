import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDshNativeDispatch, readWireArgs } from '../data/build/dist/host/modules/peer-host/peer-host-native-dispatch.js'

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
