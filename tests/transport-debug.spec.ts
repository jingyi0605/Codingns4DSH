import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshTransportDebugLogger } from '../data/build/dist/transport/debug.js'
import { CODINGNS4DSH_DEBUG_LEVEL_ENV } from '../data/build/dist/shared/debug.js'

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

test('调试日志保留 DSH 请求路由元数据但剥掉查询串与正文', () => {
  const records: Readonly<Record<string, unknown>>[] = []
  const logger = createDshTransportDebugLogger({ enabled: true, side: 'host', component: 'web-provider', sink: (record) => records.push(record) })
  logger.log('web.provider.request.response', {
    sessionId: 'web_1',
    path: '/api/settings/describe?token=secret-token',
    method: 'POST',
    status: 200,
    errorCode: 'WEB_REQUEST_FAILED',
    // 以下字段必须继续被丢弃
    url: 'http://127.0.0.1:13080/api',
    filePath: '/workspace/private.txt',
    cookie: 'session-cookie-secret',
    body: '响应正文',
    error: '错误详情',
  })
  assert.deepEqual(records[0], {
    at: (records[0] as { at?: unknown }).at,
    side: 'host',
    component: 'web-provider',
    event: 'web.provider.request.response',
    sessionId: 'web_1',
    path: '/api/settings/describe',
    method: 'POST',
    status: 200,
    errorCode: 'WEB_REQUEST_FAILED',
  })
})

test('warn 调试级别过滤 Transport 普通追踪，只保留异常事件', () => {
  const previous = process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV]
  process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV] = 'warn'
  try {
    const records: Readonly<Record<string, unknown>>[] = []
    const logger = createDshTransportDebugLogger({ sink: (record) => records.push(record) })
    logger.log('session.receive', { bytes: 10 })
    logger.log('gateway.stream.error', { code: 'FAILED' })
    logger.log('web.client.debug', { event: 'client.request.failed', fields: { status: 502 } })
    assert.equal(logger.level, 'warn')
    assert.deepEqual(records.map((record) => record.event), ['gateway.stream.error', 'web.client.debug'])
  } finally {
    if (previous === undefined) delete process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV]
    else process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV] = previous
  }
})
