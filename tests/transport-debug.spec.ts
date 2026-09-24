import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshTransportDebugLogger } from '../data/build/dist/transport/debug.js'

test('Tunnel 调试日志默认关闭时不调用 sink', () => {
  const records: unknown[] = []
  const logger = createDshTransportDebugLogger({ enabled: false, sink: (record) => records.push(record) })
  logger.log('envelope.send', { streamId: 's1', bodyBytes: 128 })
  assert.equal(logger.enabled, false)
  assert.deepEqual(records, [])
})

test('Tunnel 调试日志只记录调用方提供的元数据', () => {
  const records: Readonly<Record<string, unknown>>[] = []
  const logger = createDshTransportDebugLogger({ enabled: true, side: 'host', component: 'test', sink: (record) => records.push(record) })
  logger.log('envelope.receive', { streamId: 's1', operation: 'web.boot.get', bodyBytes: 64 })
  assert.equal(records.length, 1)
  assert.equal(records[0]?.side, 'host')
  assert.equal(records[0]?.component, 'test')
  assert.equal(records[0]?.event, 'envelope.receive')
  assert.equal(records[0]?.operation, 'web.boot.get')
  assert.equal(records[0]?.bodyBytes, 64)
})
