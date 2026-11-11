import { createHash, randomUUID } from 'node:crypto'
import type { WorkspacePendingQuestion, WorkspacePendingQuestionsAdapter } from '../../dsh-capabilities/host/workspace-pending-questions-adapter.js'
import { hasPendingNativeSubagents } from '../cli-adapters/native-subagent-dispatch.js'
import type { CodingNsHostServices } from '../features/types.js'
import {
  createWorkspaceMcpWebhookPayload,
  serializeWorkspaceMcpWebhookPayload,
  type WorkspaceMcpWebhookEventData,
} from './webhook-payload.js'
import {
  FileWorkspaceMcpWebhookStore,
  type WorkspaceMcpWebhookDelivery,
  type WorkspaceMcpWebhookDestination,
  type WorkspaceMcpWebhookEventType,
} from './webhook-store.js'

const TEXT_BYTES = 64 * 1024
const ERROR_BYTES = 1024
const QUESTION_RETRIES = [20, 50, 100] as const

export interface WorkspaceMcpWebhookEventDiagnostic {
  readonly code: 'question-snapshot-missing' | 'workspace-missing' | 'invalid-event' | 'store-failed'
  readonly sessionId?: string
}

export interface WorkspaceMcpWebhookEventCapabilities {
  readonly sessionEvents: boolean
  readonly permissions: boolean
  readonly questions: boolean
  readonly reasons: readonly string[]
}

export interface WorkspaceMcpWebhookEventRuntime {
  readonly services: CodingNsHostServices
  readonly store: FileWorkspaceMcpWebhookStore
  readonly pendingQuestions?: WorkspacePendingQuestionsAdapter
  readonly sessionList?: (signal: AbortSignal) => Promise<unknown>
  readonly diagnostics?: (diagnostic: WorkspaceMcpWebhookEventDiagnostic) => void
  readonly onQueued?: () => void
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  readonly now?: () => number
}

export interface WorkspaceMcpWebhookEventController {
  readonly capabilities: WorkspaceMcpWebhookEventCapabilities
  dispose(): void
}

export function attachWorkspaceMcpWebhookEvents(runtime: WorkspaceMcpWebhookEventRuntime): WorkspaceMcpWebhookEventController {
  const now = runtime.now ?? Date.now
  const setTimer = runtime.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = runtime.clearTimer ?? clearTimeout
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  const disposers: Array<() => void> = []
  let disposed = false
  const titles = new Map<string, string>()
  const lastAssistantText = new Map<string, string>()
  const sessionEvents = runtime.services.nativeSessions?.supportsEvents === true
  const questionsAvailable = runtime.pendingQuestions !== undefined
    && typeof runtime.services.events?.on === 'function'

  if (sessionEvents) {
    const dispose = runtime.services.nativeSessions!.subscribe({
      onEvent: (session, event) => handleNativeEvent(session, event),
    })
    disposers.push(dispose)
  }
  if (questionsAvailable) {
    const listener = (...args: unknown[]): void => handleQuestionSignal(args)
    for (const name of ['user-questions/request', 'user_questions/request', 'user-question/request'] as const) {
      const dispose = runtime.services.events!.on(name, listener)
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
  }

  void refreshSessionTitles()

  return {
    capabilities: {
      sessionEvents,
      permissions: sessionEvents,
      questions: questionsAvailable,
      reasons: [
        ...(!sessionEvents ? ['Native session event subscription is unavailable.'] : []),
        ...(runtime.pendingQuestions === undefined ? ['Pending question projection is unavailable.'] : []),
        ...(typeof runtime.services.events?.on !== 'function' ? ['Host question event channel is unavailable.'] : []),
      ],
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const timer of pendingTimers) clearTimer(timer)
      pendingTimers.clear()
      for (const dispose of disposers) dispose()
      titles.clear()
      lastAssistantText.clear()
    },
  }

  async function refreshSessionTitles(): Promise<void> {
    let list = runtime.sessionList
    if (list === undefined) {
      const controller = readService(runtime.services, 'sessionController')
      if (typeof controller?.list !== 'function') return
      list = (signal) => (controller.list as (request: Record<string, never>, signal: AbortSignal) => Promise<unknown>)({}, signal)
    }
    try {
      const result = asRecord(await list(new AbortController().signal))
      if (!Array.isArray(result?.items)) return
      const workspaces = workspaceRows(runtime.services)
      const visible = new Set(workspaces.flatMap((workspace) => workspace.sessionIds.filter((id) => !workspace.archivedSessionIds.includes(id))))
      const next = new Map<string, string>()
      for (const raw of result.items) {
        const session = asRecord(raw)
        const id = readSessionId(session)
        const projections = asRecord(session?.projections)
        const values = asRecord(projections?.values)
        const title = values?.title
        if (id !== null && visible.has(id) && typeof title === 'string' && title.trim() !== '') next.set(id, title.slice(0, 160))
      }
      if (!disposed) {
        titles.clear()
        for (const [id, title] of next) titles.set(id, title)
      }
    } catch {
      // Missing titles are omitted; title lookup cannot block session event intake.
    }
  }

  function handleNativeEvent(sessionValue: unknown, eventValue: unknown): void {
    const session = asRecord(sessionValue)
    const event = asRecord(eventValue)
    const data = asRecord(event?.data)
    const sessionId = readSessionId(session)
    const type = event?.type
    if (sessionId === null || event === null || data === null || typeof type !== 'string' || !Number.isSafeInteger(event.seq)) {
      runtime.diagnostics?.({ code: 'invalid-event', ...(sessionId === null ? {} : { sessionId }) })
      return
    }
    if (type === 'turn/start') {
      lastAssistantText.delete(sessionId)
      return
    }
    if (type === 'assistant/message') {
      const text = readAssistantMessageText(data)
      if (text !== undefined) lastAssistantText.set(sessionId, truncateUtf8(text, TEXT_BYTES))
      return
    }
    if (type === 'approval/asked') {
      const approval = approvalData(data)
      if (approval === null) return
      void enqueue(sessionId, event, 'session.permission_requested', `approval:${approval.requestId}`, approval)
      return
    }
    if (type !== 'turn/end') return
    const reason = asRecord(data.reason)
    if (reason?.kind === 'completed') {
      if (isParentTurnBlocked(sessionId)) return
      const lastMessage = lastAssistantText.get(sessionId)
      void enqueue(sessionId, event, 'session.completed', `turn:${String(event.seq)}`, lastMessage === undefined ? {} : { lastMessage })
    } else if (reason?.kind === 'error') {
      const error = asRecord(reason.error)
      if (typeof error?.code !== 'string' || typeof error.message !== 'string') return
      void enqueue(sessionId, event, 'session.failed', `turn:${String(event.seq)}`, {
        errorCode: error.code.slice(0, 128), errorMessage: truncateUtf8(error.message, ERROR_BYTES),
      })
    }
  }

  function handleQuestionSignal(args: readonly unknown[]): void {
    const sessionId = readSessionIdFromEventArgs(args)
    if (sessionId === null) return
    void captureQuestionSnapshot(sessionId)
  }

  async function captureQuestionSnapshot(sessionId: string): Promise<void> {
    for (const delay of [0, ...QUESTION_RETRIES]) {
      if (disposed) return
      if (delay > 0) await new Promise<void>((resolve) => {
        const timer = setTimer(() => {
          pendingTimers.delete(timer)
          resolve()
        }, delay)
        pendingTimers.add(timer)
      })
      if (disposed) return
      let pending: readonly WorkspacePendingQuestion[] | null = null
      try { pending = runtime.pendingQuestions?.list(sessionId) ?? null } catch { pending = null }
      const open = pending?.filter((question) => question.state === 'open' && validId(question.callId)) ?? []
      if (open.length === 0) continue
      for (const question of open) {
        const event: ClassifiedEvent = {
          eventId: stableEventId(sessionId, 'session.question_asked', question.callId),
          eventType: 'session.question_asked',
          occurredAt: new Date(now()).toISOString(),
          occurrenceId: `question:${question.callId}`,
          data: questionData(question),
        }
        await enqueueClassified(sessionId, event)
      }
      return
    }
    runtime.diagnostics?.({ code: 'question-snapshot-missing', sessionId })
  }

  async function enqueue(
    sessionId: string,
    rawEvent: Record<string, unknown>,
    type: Exclude<WorkspaceMcpWebhookEventType, 'webhook.test'>,
    occurrenceId: string,
    data: WorkspaceMcpWebhookEventData,
  ): Promise<void> {
    await enqueueClassified(sessionId, {
      eventId: stableEventId(sessionId, type, occurrenceId),
      eventType: type,
      occurredAt: new Date(now()).toISOString(),
      occurrenceId,
      data,
    })
  }

  async function enqueueClassified(sessionId: string, event: ClassifiedEvent): Promise<void> {
    const workspace = findWorkspace(runtime.services, sessionId)
    if (workspace === undefined) {
      runtime.diagnostics?.({ code: 'workspace-missing', sessionId })
      return
    }
    let snapshot: Awaited<ReturnType<FileWorkspaceMcpWebhookStore['snapshot']>>
    try { snapshot = await runtime.store.snapshot() } catch {
      runtime.diagnostics?.({ code: 'store-failed', sessionId })
      return
    }
    const destinations = snapshot.destinations.filter((destination) => destination.enabled
      && destination.eventTypes.includes(event.eventType)
      && (destination.workspaceIds === null || destination.workspaceIds.includes(workspace.id)))
    for (const destination of destinations) {
      const payloadInput = {
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        destinationId: destination.id,
        workspace: { id: workspace.id, name: workspace.name },
        session: { id: sessionId, ...(titles.get(sessionId) === undefined ? {} : { title: titles.get(sessionId)! }) },
        includeLastMessage: destination.includeLastMessage,
      }
      const payload = createPayloadForEvent(payloadInput, event)
      const body = serializeWorkspaceMcpWebhookPayload(payload)
      const dedupeKey = createHash('sha256')
        .update(`${destination.id}\0${sessionId}\0${event.eventType}\0${event.occurrenceId}`)
        .digest('hex')
      const delivery: WorkspaceMcpWebhookDelivery = {
        deliveryId: randomUUID(),
        eventId: event.eventId,
        dedupeKey,
        eventType: event.eventType,
        destinationId: destination.id,
        destinationName: destination.name,
        destinationSnapshot: {
          url: destination.url,
          secret: destination.secret,
          includeLastMessage: destination.includeLastMessage,
        },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now(),
        lastError: null,
        body,
        createdAt: new Date(now()).toISOString(),
        finishedAt: null,
      }
      try {
        const result = await runtime.store.enqueueOnce(delivery)
        if (result.queued) runtime.onQueued?.()
      } catch {
        runtime.diagnostics?.({ code: 'store-failed', sessionId })
      }
    }
  }

  function isParentTurnBlocked(parentSessionId: string): boolean {
    return hasPendingNativeSubagents(parentSessionId)
  }
}

interface ClassifiedEvent {
  readonly eventId: string
  readonly eventType: Exclude<WorkspaceMcpWebhookEventType, 'webhook.test'>
  readonly occurredAt: string
  readonly occurrenceId: string
  readonly data: WorkspaceMcpWebhookEventData
}

function createPayloadForEvent(
  base: {
    readonly eventId: string
    readonly occurredAt: string
    readonly destinationId: string
    readonly workspace: { readonly id: string; readonly name: string }
    readonly session: { readonly id: string; readonly title?: string }
    readonly includeLastMessage: boolean
  },
  event: ClassifiedEvent,
) {
  switch (event.eventType) {
    case 'session.completed':
      return createWorkspaceMcpWebhookPayload({ ...base, type: event.eventType, data: event.data as Extract<WorkspaceMcpWebhookEventData, { lastMessage?: string }> })
    case 'session.failed':
      return createWorkspaceMcpWebhookPayload({ ...base, type: event.eventType, data: event.data as Extract<WorkspaceMcpWebhookEventData, { errorCode: string }> })
    case 'session.permission_requested':
      return createWorkspaceMcpWebhookPayload({ ...base, type: event.eventType, data: event.data as Extract<WorkspaceMcpWebhookEventData, { requestId: string }> })
    case 'session.question_asked':
      return createWorkspaceMcpWebhookPayload({ ...base, type: event.eventType, data: event.data as Extract<WorkspaceMcpWebhookEventData, { callId: string }> })
  }
}

interface SafeWorkspace {
  readonly id: string
  readonly name: string
  readonly sessionIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
}

function workspaceRows(services: CodingNsHostServices): SafeWorkspace[] {
  const registry = readService(services, 'workspaceRegistry')
  if (typeof registry?.list !== 'function' || !Array.isArray(registry.archivedSessionIds)) return []
  let values: unknown
  try { values = (registry.list as () => unknown).call(registry) } catch { return [] }
  if (!Array.isArray(values)) return []
  return values.flatMap((raw) => {
    const row = asRecord(raw)
    const id = readSafeId(row?.id ?? row?.workspaceId ?? row?.key)
    const root = id === null ? null : services.resolveManagedWorkspaceRoot?.(id)
    if (id === null || typeof root !== 'string' || root.trim() === '') return []
    return [{
      id,
      name: readSafeText(row?.title ?? row?.displayName ?? row?.name, 160) ?? id,
      sessionIds: readSafeIds(row?.sessionIds),
      archivedSessionIds: readSafeIds(registry.archivedSessionIds),
    }]
  })
}

function findWorkspace(services: CodingNsHostServices, sessionId: string): SafeWorkspace | undefined {
  const workspaces = workspaceRows(services)
  const direct = workspaces.find((workspace) => workspace.sessionIds.includes(sessionId) && !workspace.archivedSessionIds.includes(sessionId))
  if (direct !== undefined) return direct
  let current = sessionId
  const visited = new Set([current])
  for (let depth = 0; depth < 8; depth += 1) {
    let session: unknown
    try { session = services.nativeSessions?.get(current) } catch { session = undefined }
    const header = asRecord(asRecord(session)?.header)
    const parent = readSafeId(header?.parentSession ?? header?.parentSessionId)
    if (parent === null || visited.has(parent)) return undefined
    const workspace = workspaces.find((row) => row.sessionIds.includes(parent) && !row.archivedSessionIds.includes(parent))
    if (workspace !== undefined) return workspace
    visited.add(parent)
    current = parent
  }
  return undefined
}

function readAssistantMessageText(data: Record<string, unknown>): string | undefined {
  const message = asRecord(data.message)
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return undefined
  const texts = message.content.flatMap((block) => {
    const row = asRecord(block)
    return row?.type === 'text' && typeof row.text === 'string' ? [row.text] : []
  })
  const text = texts.join('')
  return text === '' ? undefined : text
}

function questionData(question: WorkspacePendingQuestion): Extract<WorkspaceMcpWebhookEventData, { callId: string }> {
  return {
    callId: question.callId,
    questions: question.questions.map((item) => ({
      id: item.id,
      text: item.question,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(item.header === undefined ? {} : { header: item.header }),
      ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }),
      ...(item.options === undefined ? {} : { options: item.options.map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })) }),
    })),
  }
}

function approvalData(value: Record<string, unknown>): Extract<WorkspaceMcpWebhookEventData, { requestId: string }> | null {
  if (typeof value.id !== 'string' || !validId(value.id) || typeof value.toolName !== 'string' || !validText(value.toolName)) return null
  return {
    requestId: value.id,
    toolName: value.toolName,
    decidableByExternalAgent: false,
    ...(typeof value.reason === 'string' && validText(value.reason) ? { reason: value.reason } : {}),
    ...(typeof value.callId === 'string' && validId(value.callId) ? { callId: value.callId } : {}),
  }
}

function readSessionId(value: Record<string, unknown> | null): string | null {
  const header = asRecord(value?.header)
  return readSafeId(value?.id ?? value?.sessionId ?? value?.session_id ?? header?.id)
}

function readSessionIdFromEventArgs(args: readonly unknown[]): string | null {
  const queue = [...args]
  const visited = new Set<object>()
  while (queue.length > 0) {
    const value = queue.shift()
    const row = asRecord(value)
    if (row === null || visited.has(row)) continue
    visited.add(row)
    const id = readSessionId(asRecord(row.session) ?? asRecord(asRecord(row.agent)?.session) ?? row)
    if (id !== null) return id
    for (const key of ['data', 'request', 'payload', 'interaction', 'session', 'agent']) if (row[key] !== undefined) queue.push(row[key])
  }
  return null
}

function readService(services: CodingNsHostServices, name: string): Record<string, unknown> | null {
  try { return asRecord((services.dshContext as unknown as { get(name: string): unknown } | undefined)?.get(name)) } catch { return null }
}

function readSafeId(value: unknown): string | null {
  return typeof value === 'string' && validId(value.trim()) ? value.trim() : null
}

function readSafeIds(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const id = readSafeId(item)
    return id === null ? [] : [id]
  }) : []
}

function readSafeText(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && validText(value) ? value.slice(0, maxLength) : null
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validText(value: string): boolean {
  return value.trim() !== '' && !value.includes('\u0000')
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let output = ''
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > maxBytes - 3) break
    output += character
  }
  return `${output}...`
}

function stableEventId(sessionId: string, type: WorkspaceMcpWebhookEventType, occurrenceId: string): string {
  return `evt_${createHash('sha256').update(`${sessionId}\0${type}\0${occurrenceId}`).digest('hex').slice(0, 32)}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
