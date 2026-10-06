import assert from 'node:assert/strict'
import test from 'node:test'
import { acpElicitationResponse, readAcpElicitationRequest } from '../data/build/dist/host/cli-adapters/acp-elicitation.js'

test('ACP form elicitation 转成 DSH 问题并按 schema 回传类型', () => {
  const request = readAcpElicitationRequest({
    jsonrpc: '2.0',
    id: 'elicitation-7',
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: '请选择运行方式',
      requestedSchema: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            title: '策略',
            oneOf: [
              { const: 'safe', title: '安全', description: '只读优先' },
              { const: 'fast', title: '快速' },
            ],
          },
          port: { type: 'integer', title: '端口' },
          enabled: { type: 'boolean', title: '启用' },
        },
      },
    },
  })
  assert.ok(request)
  assert.deepEqual(request.questions, [
    { id: 'strategy', question: '请选择运行方式', header: '策略', options: [{ label: '安全', description: '只读优先' }, { label: '快速' }] },
    { id: 'port', question: '请选择运行方式', header: '端口' },
    { id: 'enabled', question: '请选择运行方式', header: '启用' },
  ])
  assert.deepEqual(acpElicitationResponse(request, {
    requestId: 'elicitation-7',
    answers: [
      { id: 'strategy', selected: ['安全'] },
      { id: 'port', selected: ['4321'] },
      { id: 'enabled', selected: ['true'] },
    ],
  }), { action: 'accept', content: { strategy: 'safe', port: 4321, enabled: true } })
})

test('ACP URL 或未知表单结构不冒充 DSH question-request', () => {
  assert.equal(readAcpElicitationRequest({ id: 1, method: 'elicitation/create', params: { mode: 'url', url: 'https://example.com' } }), null)
  assert.equal(readAcpElicitationRequest({ id: 2, method: 'elicitation/create', params: { mode: 'form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } } }), null)
})
