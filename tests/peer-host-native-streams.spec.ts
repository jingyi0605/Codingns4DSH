import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { PeerHostNativeStreams } from '../data/build/dist/host/modules/peer-host/peer-host-native-streams.js'

const scope = { hostId: 'local', targetHostId: 'a', workspaceId: 'w', sessionId: null, scopeGeneration: 0 }

test('流关闭先取消挂起读取，不允许另一 Host 读取或关闭同一事件句柄', { timeout: 3000 }, async () => {
  const registry = new PeerHostNativeStreams()
  let cleaned = false
  let signal: AbortSignal
  const id = await registry.open(scope, async function* (value) {
    signal = value
    try {
      yield { type: 'ready' }
      await new Promise<void>(resolve => value.addEventListener('abort', () => resolve(), { once: true }))
    } finally { cleaned = true }
  })
  try {
    assert.deepEqual((await registry.next(id, scope)).value, { type: 'ready' })
    const other = { ...scope, targetHostId: 'b' }
    await assert.rejects(registry.next(id, other), { code: 'CODINGNS_RPC_SCOPE_MISMATCH' })
    await assert.rejects(registry.close(id, other), { code: 'CODINGNS_RPC_SCOPE_MISMATCH' })
    assert.equal(signal!.aborted, false)
    const pending = registry.next(id, scope)
    await assert.rejects(registry.next(id, scope), /已有挂起的读取/)
    await registry.close(id, scope)
    assert.equal((await pending).done, true)
    assert.equal(signal!.aborted, true)
    assert.equal(cleaned, true)
    await assert.rejects(registry.next(id, scope), { code: 'CODINGNS_RPC_NOT_FOUND' })
    await registry.close(id, scope)
  } finally { registry.dispose() }
})

test('无人轮询的流过期，健康长轮询只在请求取消或模块释放时结束', { timeout: 3000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = new PeerHostNativeStreams(100)
  const signals: AbortSignal[] = []
  const source = async function* (signal: AbortSignal) {
    signals.push(signal)
    yield 'ready'
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  const id = await registry.open(scope, source)
  await registry.next(id, scope)
  t.mock.timers.tick(101)
  assert.equal(signals[0]!.aborted, true)
  const second = await registry.open(scope, source)
  await registry.next(second, scope)
  const request = new AbortController()
  const waiting = registry.next(second, scope, request.signal)
  t.mock.timers.tick(200)
  assert.equal(signals[1]!.aborted, false)
  request.abort()
  await waiting
  assert.equal(signals[1]!.aborted, true)
  const third = await registry.open(scope, source)
  const responseLifetime = new AbortController()
  await registry.next(third, scope, responseLifetime.signal)
  responseLifetime.abort()
  assert.equal(signals[2]!.aborted, false, '响应完成不能取消后续读取')
  const next = registry.next(third, scope)
  registry.dispose()
  await next
  assert.equal(signals[2]!.aborted, true)
  await assert.rejects(registry.open(scope, source), /已关闭/)
  await setImmediate()
})
