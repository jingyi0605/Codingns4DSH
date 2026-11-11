import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { WORKSPACE_MCP_TOOL_DEFINITIONS } from '../src/host/workspace-mcp/tools.ts'
import {
  createWorkspaceMcpWebhookPayload,
  createWorkspaceMcpWebhookTestPayload,
  serializeWorkspaceMcpWebhookPayload,
  signWorkspaceMcpWebhookRequest,
  WORKSPACE_MCP_WEBHOOK_MAX_BODY_BYTES,
  type WorkspaceMcpWebhookPayloadInput,
} from '../src/host/workspace-mcp/webhook-payload.ts'

function input(overrides: Partial<WorkspaceMcpWebhookPayloadInput> = {}): WorkspaceMcpWebhookPayloadInput {
  return {
    eventId: 'event-1',
    type: 'session.completed',
    occurredAt: '2026-11-10T08:00:00.000Z',
    destinationId: 'destination-1',
    workspace: { id: 'workspace-1', name: 'Project' },
    session: { id: 'session-1', title: 'Session' },
    data: { lastMessage: 'All done.' },
    ...overrides,
  }
}

test('webhook payload next action tools all exist in the Workspace MCP tool catalog', () => {
  const names = new Set(WORKSPACE_MCP_TOOL_DEFINITIONS.map((tool) => tool.name))
  for (const type of ['session.completed', 'session.failed', 'session.permission_requested', 'session.question_asked'] as const) {
    const payload = createWorkspaceMcpWebhookPayload(input({
      type,
      data: type === 'session.question_asked'
        ? { callId: 'call-1', questions: [{ id: 'q1', text: 'Continue?' }] }
        : type === 'session.failed'
          ? { errorCode: 'PROVIDER_ERROR', errorMessage: 'Failed.' }
          : type === 'session.permission_requested'
            ? { requestId: 'request-1', toolName: 'exec', reason: 'Needs access.' }
            : type === 'session.completed'
              ? { lastMessage: 'Done.' }
              : { requestId: 'request-1', toolName: 'exec', decidableByExternalAgent: false },
    }))
    for (const action of payload.nextActions) assert.equal(names.has(action.tool), true, action.tool)
  }
})

test('completed payload supports per-destination omission of the last reply', () => {
  const withText = createWorkspaceMcpWebhookPayload(input())
  const withoutText = createWorkspaceMcpWebhookPayload(input({ includeLastMessage: false }))
  assert.equal(withText.data.lastMessage, 'All done.')
  assert.equal(Object.hasOwn(withoutText.data, 'lastMessage'), false)
})

test('question payload exposes the exact call ID and compatible question shape', () => {
  const payload = createWorkspaceMcpWebhookPayload(input({
    type: 'session.question_asked',
    data: {
      callId: 'call-7',
      questions: [{ id: 'language', text: 'Choose a language', options: [{ label: 'TypeScript', description: 'Typed JavaScript' }], multiSelect: false }],
    },
  }))
  assert.deepEqual(payload.data.questions, [{ id: 'language', text: 'Choose a language', multiSelect: false, options: [{ label: 'TypeScript', description: 'Typed JavaScript' }] }])
  assert.deepEqual(payload.nextActions[0]?.arguments, { sessionId: 'session-1', callId: 'call-7' })
})

test('payload truncates selected正文 by byte length and stays under the size bound', () => {
  const longText = '非常长的回复'.repeat(3000)
  const payload = createWorkspaceMcpWebhookPayload(input({ data: { lastMessage: longText } }))
  const serialized = serializeWorkspaceMcpWebhookPayload(payload)
  assert.equal(payload.truncated, true)
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= WORKSPACE_MCP_WEBHOOK_MAX_BODY_BYTES)
  assert.equal(serialized.includes('非常长的回复'), true)
})

test('failed event includes bounded error details and a valid retry action', () => {
  const payload = createWorkspaceMcpWebhookPayload(input({
    type: 'session.failed',
    data: { errorCode: 'RATE_LIMIT', errorMessage: 'x'.repeat(800) },
  }))
  assert.equal(payload.data.errorCode, 'RATE_LIMIT')
  assert.equal(Buffer.byteLength(String(payload.data.errorMessage), 'utf8'), 800)
  assert.equal(payload.nextActions[0]?.tool, 'session_continue')
})

test('test event has no session action and signature headers sign the exact body', () => {
  const payload = createWorkspaceMcpWebhookTestPayload({
    eventId: 'test-event', destinationId: 'destination-1', occurredAt: '2026-11-10T08:00:00.000Z',
  })
  const body = serializeWorkspaceMcpWebhookPayload(payload)
  const signature = signWorkspaceMcpWebhookRequest({
    secret: 'fixed-secret', timestamp: 1_800_000_000, body,
    eventId: payload.eventId, deliveryId: 'delivery-1', eventType: payload.type,
  })
  const expected = createHmac('sha256', 'fixed-secret').update(`1800000000.${body}`).digest('hex')
  assert.deepEqual(payload.nextActions, [])
  assert.equal(signature.signature, `sha256=${expected}`)
  assert.equal(signature.headers['X-CodingNS-Signature'], signature.signature)
  assert.equal(signature.headers['X-CodingNS-Event-Id'], 'test-event')
  assert.equal(signature.headers['X-CodingNS-Delivery-Id'], 'delivery-1')
  assert.equal(signature.headers['X-CodingNS-Event-Type'], 'webhook.test')
})
