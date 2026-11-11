import { createHmac } from 'node:crypto'
import { WORKSPACE_MCP_TOOL_DEFINITIONS } from './tools.js'
import type { WorkspaceMcpWebhookEventType } from './webhook-store.js'

export const WORKSPACE_MCP_WEBHOOK_MAX_BODY_BYTES = 16 * 1024

interface WorkspaceMcpWebhookPayloadBase {
  readonly eventId: string
  readonly occurredAt: string
  readonly destinationId: string
  readonly workspace: { readonly id: string; readonly name: string }
  readonly session: { readonly id: string; readonly title?: string }
  readonly includeLastMessage?: boolean
}

export type WorkspaceMcpWebhookEventData =
  | { readonly lastMessage?: string }
  | { readonly errorCode: string; readonly errorMessage: string }
  | { readonly requestId: string; readonly toolName: string; readonly reason?: string; readonly callId?: string; readonly decidableByExternalAgent: false }
  | { readonly callId: string; readonly questions: readonly { readonly id: string; readonly text: string; readonly detail?: string; readonly header?: string; readonly multiSelect?: boolean; readonly options?: readonly { readonly label: string; readonly description?: string }[] }[] }

export type WorkspaceMcpWebhookPayloadInput = WorkspaceMcpWebhookPayloadBase & (
  | { readonly type: 'session.completed'; readonly data: { readonly lastMessage?: string } }
  | { readonly type: 'session.failed'; readonly data: { readonly errorCode: string; readonly errorMessage: string } }
  | { readonly type: 'session.permission_requested'; readonly data: { readonly requestId: string; readonly toolName: string; readonly reason?: string; readonly callId?: string; readonly decidableByExternalAgent: false } }
  | { readonly type: 'session.question_asked'; readonly data: { readonly callId: string; readonly questions: readonly { readonly id: string; readonly text: string; readonly detail?: string; readonly header?: string; readonly multiSelect?: boolean; readonly options?: readonly { readonly label: string; readonly description?: string }[] }[] } }
)

export interface WorkspaceMcpWebhookNextAction {
  readonly tool: string
  readonly description: string
  readonly arguments: Readonly<Record<string, string>>
  readonly note?: string
}

export interface WorkspaceMcpWebhookPayload {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly type: WorkspaceMcpWebhookPayloadInput['type'] | 'webhook.test'
  readonly occurredAt: string
  readonly destinationId: string
  readonly workspace: { readonly id: string; readonly name: string }
  readonly session?: { readonly id: string; readonly title?: string }
  readonly data: Record<string, unknown>
  readonly nextActions: readonly WorkspaceMcpWebhookNextAction[]
  readonly truncated: boolean
}

export interface WorkspaceMcpWebhookSignature {
  readonly timestamp: string
  readonly signature: string
  readonly headers: Readonly<Record<string, string>>
}

const MAX_LAST_MESSAGE_BYTES = 4 * 1024
const MAX_ERROR_TEXT_BYTES = 1024
const TOOL_NAMES = new Set(WORKSPACE_MCP_TOOL_DEFINITIONS.map((tool) => tool.name))

export function createWorkspaceMcpWebhookPayload(input: WorkspaceMcpWebhookPayloadInput): WorkspaceMcpWebhookPayload {
  const data: Record<string, unknown> = {}
  let truncated = false
  if (input.type === 'session.completed') {
    const lastMessage = input.data.lastMessage
    if (input.includeLastMessage !== false && typeof lastMessage === 'string') {
      const bounded = truncateUtf8(lastMessage, MAX_LAST_MESSAGE_BYTES)
      truncated ||= bounded !== lastMessage
      data.lastMessage = bounded
    }
  } else if (input.type === 'session.failed') {
    data.errorCode = input.data.errorCode
    data.errorMessage = input.data.errorMessage
  } else if (input.type === 'session.permission_requested') {
    data.requestId = input.data.requestId
    data.toolName = input.data.toolName
    data.decidableByExternalAgent = false
    if (input.data.reason !== undefined) data.reason = truncateUtf8(input.data.reason, MAX_ERROR_TEXT_BYTES)
    if (input.data.callId !== undefined) data.callId = input.data.callId
  } else {
    data.callId = input.data.callId
    data.questions = input.data.questions.map((question) => ({
      id: question.id,
      text: truncateUtf8(question.text, 2048),
      ...(question.detail === undefined ? {} : { detail: truncateUtf8(question.detail, 1024) }),
      ...(question.header === undefined ? {} : { header: truncateUtf8(question.header, 128) }),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
      ...(question.options === undefined ? {} : { options: question.options.map((option) => ({
        label: truncateUtf8(option.label, 256),
        ...(option.description === undefined ? {} : { description: truncateUtf8(option.description, 512) }),
      })) }),
    }))
  }
  if (input.type === 'session.failed' && data.errorMessage !== undefined) {
    truncated ||= data.errorMessage !== input.data.errorMessage
  }
  if (input.type === 'session.permission_requested' && data.reason !== undefined) {
    truncated ||= data.reason !== input.data.reason
  }

  const payload: WorkspaceMcpWebhookPayload = {
    schemaVersion: 1,
    eventId: input.eventId,
    type: input.type,
    occurredAt: input.occurredAt,
    destinationId: input.destinationId,
    workspace: { id: input.workspace.id, name: truncateUtf8(input.workspace.name, 160) },
    session: {
      id: input.session.id,
      ...(input.session.title === undefined ? {} : { title: truncateUtf8(input.session.title, 256) }),
    },
    data,
    nextActions: nextActions(input.type, input.session.id, input.workspace.id, data),
    truncated,
  }
  return fitPayload(payload)
}

export function createWorkspaceMcpWebhookTestPayload(input: {
  readonly eventId: string
  readonly destinationId: string
  readonly occurredAt: string
}): WorkspaceMcpWebhookPayload {
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    type: 'webhook.test',
    occurredAt: input.occurredAt,
    destinationId: input.destinationId,
    workspace: { id: '', name: '' },
    data: { message: 'Webhook test delivery.' },
    nextActions: [],
    truncated: false,
  }
}

export function serializeWorkspaceMcpWebhookPayload(payload: WorkspaceMcpWebhookPayload): string {
  return JSON.stringify(fitPayload(payload))
}

export function signWorkspaceMcpWebhookRequest(input: {
  readonly secret: string
  readonly timestamp: number | string
  readonly body: string
  readonly eventId: string
  readonly deliveryId: string
  readonly eventType: WorkspaceMcpWebhookPayload['type']
}): WorkspaceMcpWebhookSignature {
  const timestamp = String(input.timestamp)
  const digest = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`, 'utf8').digest('hex')
  const signature = `sha256=${digest}`
  return {
    timestamp,
    signature,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-CodingNS-Event-Id': input.eventId,
      'X-CodingNS-Delivery-Id': input.deliveryId,
      'X-CodingNS-Event-Type': input.eventType,
      'X-CodingNS-Timestamp': timestamp,
      'X-CodingNS-Signature': signature,
      'User-Agent': 'codingns-workspace-webhook/1',
    },
  }
}

function nextActions(
  type: WorkspaceMcpWebhookPayloadInput['type'],
  sessionId: string,
  workspaceId: string,
  data: Record<string, unknown>,
): WorkspaceMcpWebhookNextAction[] {
  switch (type) {
    case 'session.completed':
      return [
        action('session_continue', 'Continue this session.', { sessionId }),
        action('session_list', 'Check the session status.', {}),
      ]
    case 'session.failed':
      return [
        action('session_continue', 'Retry by continuing this session.', { sessionId }),
        action('session_create', 'Start a new session in the workspace.', { workspaceId }),
      ]
    case 'session.permission_requested':
      return []
    case 'session.question_asked': {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      return [
        action('session_answer', 'Answer the open questions.', { sessionId, callId }, 'Provide answer.answers using the question IDs in data.questions.'),
        action('session_questions', 'Read the open questions.', { sessionId }),
      ]
    }
  }
}

function action(
  tool: string,
  description: string,
  args: Readonly<Record<string, string>>,
  note?: string,
): WorkspaceMcpWebhookNextAction {
  if (!TOOL_NAMES.has(tool)) throw new Error(`Unknown Workspace MCP action: ${tool}`)
  return { tool, description, arguments: args, ...(note === undefined ? {} : { note }) }
}

function fitPayload(payload: WorkspaceMcpWebhookPayload): WorkspaceMcpWebhookPayload {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= WORKSPACE_MCP_WEBHOOK_MAX_BODY_BYTES) return payload
  let result: WorkspaceMcpWebhookPayload = { ...payload, truncated: true }
  const data = { ...result.data }
  for (const key of ['lastMessage', 'errorMessage', 'reason'] as const) {
    const original = data[key]
    if (typeof original !== 'string') continue
    let maximum = Buffer.byteLength(original, 'utf8')
    while (maximum > 0) {
      maximum = Math.floor(maximum / 2)
      data[key] = truncateUtf8(original, maximum)
      result = { ...result, data: { ...data } }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= WORKSPACE_MCP_WEBHOOK_MAX_BODY_BYTES) return result
    }
    data[key] = ''
  }
  if (Array.isArray(data.questions)) {
    data.questions = data.questions.map((value) => {
      const question = asRecord(value)
      if (question === null) return value
      const bounded = { ...question }
      for (const key of ['text', 'detail', 'header'] as const) {
        if (typeof bounded[key] === 'string') bounded[key] = truncateUtf8(bounded[key] as string, 128)
      }
      if (Array.isArray(bounded.options)) bounded.options = bounded.options.map((option) => {
        const row = asRecord(option)
        if (row === null) return option
        const safe = { ...row }
        for (const key of ['label', 'description'] as const) if (typeof safe[key] === 'string') safe[key] = truncateUtf8(safe[key] as string, 96)
        return safe
      })
      return bounded
    })
    result = { ...result, data: { ...data } }
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > WORKSPACE_MCP_WEBHOOK_MAX_BODY_BYTES) {
    throw new RangeError('Webhook payload identifiers exceed the maximum body size.')
  }
  return result
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let output = ''
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > Math.max(0, maxBytes - 3)) break
    output += character
  }
  return `${output}...`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
