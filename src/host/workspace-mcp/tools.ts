import { randomUUID } from 'node:crypto'
import type { CodingNsHostServices } from '../features/types.js'
import type { WorkspaceMcpTool } from './transport.js'
import type { WorkspaceApprovalAdapter } from '../../dsh-capabilities/host/workspace-approval-adapter.js'
import type { WorkspacePendingQuestionsAdapter } from '../../dsh-capabilities/host/workspace-pending-questions-adapter.js'
import type { WorkspaceSessionControlAdapter } from '../../dsh-capabilities/host/workspace-session-control-adapter.js'

const MAX_PAGE_SIZE = 100
const MAX_QUESTIONS = 16
const MAX_TEXT_LENGTH = 64 * 1024
const MAX_TERMINAL_READ_BYTES = 64 * 1024
const MAX_TERMINAL_INPUT_BYTES = 16 * 1024
const MAX_PENDING_PERMISSIONS = 256
const PERMISSION_RETENTION_MS = 15 * 60 * 1000

/**
 * Fixed public contracts for local workspace/session/terminal control.
 * Authentication and local full-workspace access are enforced by the transport;
 * every resource identifier is still validated and rechecked by its handler.
 * Workspace filesystem roots are never returned in tool results.
 */
export const WORKSPACE_MCP_TOOL_DEFINITIONS = [
  defineTool('workspace_list', 'List managed workspaces without exposing filesystem roots.', {}),
  defineTool('session_list', 'List bounded session metadata in managed workspaces.', {
    workspaceId: stringField('Optional managed workspace identifier.'),
    limit: integerField(1, MAX_PAGE_SIZE, 'Maximum number of sessions to return.'),
    offset: integerField(0, Number.MAX_SAFE_INTEGER, 'Number of matching sessions to skip.'),
  }),
  defineTool('session_create', 'Create a native session in a managed workspace and optionally send an initial prompt. adapterId defaults to dsh; modelId is selected for the new session.', {
    workspaceId: stringField('Managed workspace identifier.'),
    adapterId: stringField('Optional adapter ID. Defaults to dsh.'),
    modelId: stringField('Optional model ID, validated against the matching model catalog.'),
    prompt: stringField('Initial prompt. Required when adapterId is an external adapter.'),
  }, ['workspaceId']),
  defineTool('session_continue', 'Queue a message to an exact existing session without replacing it.', {
    sessionId: stringField('Existing session identifier.'),
    message: stringField('Text to send.'),
  }, ['sessionId', 'message']),
  defineTool('session_questions', 'List unresolved native questions for an existing session.', {
    sessionId: stringField('Existing session identifier.'),
  }, ['sessionId']),
  defineTool('session_answer', 'Answer one exact open native question request using its call ID.', {
    sessionId: stringField('Existing session identifier.'),
    callId: stringField('Exact pending question call ID returned by session_questions.'),
    answer: {
      type: 'object',
      properties: {
        answers: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 128 },
              selected: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 256 } },
              custom: { type: 'string', maxLength: 4096 },
            },
            required: ['id', 'selected'],
            additionalProperties: false,
          },
        },
      },
      required: ['answers'],
      additionalProperties: false,
      description: 'Complete answers for every question in that request.',
    },
  }, ['sessionId', 'callId', 'answer']),
  defineTool('session_request_permission', 'Request a decision through native DSH approval for an existing active turn; callers cannot decide approval.', {
    sessionId: stringField('Existing session identifier.'),
    toolName: stringField('Operation requiring approval.'),
    reason: stringField('Explanation shown in the native approval UI.'),
    callId: stringField('Optional operation identifier.'),
  }, ['sessionId', 'toolName', 'reason']),
  defineTool('session_permission_status', 'Read the current outcome for an exact DSH-issued permission request ID.', {
    sessionId: stringField('Existing session identifier.'),
    requestId: stringField('DSH-issued approval request ID from the session event log.'),
  }, ['sessionId', 'requestId']),
  defineTool('terminal_list', 'List terminal metadata in a managed workspace.', {
    workspaceId: stringField('Managed workspace identifier.'),
    sessionId: stringField('Live session owning the terminal instances.'),
  }, ['workspaceId', 'sessionId']),
  defineTool('terminal_read', 'Read a bounded output snapshot from a live workspace terminal.', {
    workspaceId: stringField('Managed workspace identifier.'),
    sessionId: stringField('Live session owning the terminal instance.'),
    terminalId: stringField('Running terminal identifier from terminal_list.'),
    limitBytes: integerField(1, MAX_TERMINAL_READ_BYTES, 'Maximum UTF-8 bytes to return.'),
  }, ['workspaceId', 'sessionId', 'terminalId']),
  defineTool('terminal_write', 'Write bounded input through the existing terminal process service.', {
    workspaceId: stringField('Managed workspace identifier.'),
    sessionId: stringField('Live session owning the terminal instance.'),
    terminalId: stringField('Running terminal identifier from terminal_list.'),
    data: stringField('Input text to write.'),
  }, ['workspaceId', 'sessionId', 'terminalId', 'data']),
] as const satisfies readonly WorkspaceMcpTool[]

export interface WorkspaceMcpToolHandlers {
  listTools(signal: AbortSignal): readonly WorkspaceMcpTool[]
  /** Dispatch one tool returned by WORKSPACE_MCP_TOOL_DEFINITIONS. */
  callTool(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>
  /** Abort operations owned by this factory. */
  dispose(): Promise<void>
  /** Cancel approval requests issued from an active DSH turn. */
  abortRequests(): void
}

export interface WorkspaceMcpAdapterRegistry {
  catalogForUse(ids: readonly string[]): Promise<readonly { readonly id: string; readonly enabled: boolean; readonly installed: boolean }[]>
  models(adapterId: string): Promise<unknown>
  setSession(sessionId: string, config: { readonly adapterId: string; readonly modelId?: string }, options?: { readonly rememberPreference?: boolean; readonly inheritSelection?: boolean }): unknown
  getSession(sessionId: string): { readonly adapterId: string; readonly modelId?: string }
  flushSessionBindings(): Promise<void>
}

/** Create an isolated tool dispatcher over existing Host services. */
export function createWorkspaceMcpToolHandlers(services: CodingNsHostServices, adapters?: {
  readonly sessionControl?: WorkspaceSessionControlAdapter
  readonly pendingQuestions?: WorkspacePendingQuestionsAdapter
  readonly approval?: WorkspaceApprovalAdapter
  readonly getAdapterRegistry?: () => WorkspaceMcpAdapterRegistry | undefined
  readonly diagnostics?: readonly { readonly capability: string; readonly status: string; readonly message: string }[]
}): WorkspaceMcpToolHandlers {
  const permissions = new Map<string, PermissionRequest>()
  const pendingPermissionSessions = new Map<string, string>()
  let disposed = false
  let permissionLifetime = new AbortController()
  const sessionControl = adapters?.sessionControl
  const pendingQuestions = adapters?.pendingQuestions
  const approval = adapters?.approval

  return {
    listTools(signal) {
      signal.throwIfAborted()
      return WORKSPACE_MCP_TOOL_DEFINITIONS
    },
    async callTool(name, args, signal) {
      if (disposed) return toolError('WORKSPACE_MCP_STOPPED', 'Workspace MCP tools are stopped.')
      try {
        signal.throwIfAborted()
        switch (name) {
          case 'workspace_list': return toolSuccess(listWorkspaces(services))
          case 'session_list': return toolSuccess(await listSessions(services, sessionControl, args, signal))
          case 'session_create': return toolSuccess(await createSession(services, sessionControl, args, signal, adapters))
          case 'session_continue': return toolSuccess(await continueSession(services, sessionControl, args, signal))
          case 'session_questions': return toolSuccess(listPendingQuestions(services, pendingQuestions, args))
          case 'session_answer': return toolSuccess(answerPendingQuestion(services, pendingQuestions, args))
          case 'session_request_permission': return toolSuccess(await requestPermission(services, approval, permissions, pendingPermissionSessions, args, permissionLifetime))
          case 'session_permission_status': return toolSuccess(permissionStatus(services, permissions, args))
          case 'terminal_list': return toolSuccess(listTerminals(services, args))
          case 'terminal_read': return toolSuccess(await readTerminal(services, args, signal))
          case 'terminal_write': return toolSuccess(await writeTerminal(services, args, signal))
          default: return toolError('WORKSPACE_MCP_TOOL_NOT_FOUND', 'Unknown workspace MCP tool.')
        }
      } catch (error) {
        if (signal.aborted) return toolError('WORKSPACE_MCP_CANCELLED', 'The request was cancelled.')
        return toolError(error instanceof WorkspaceToolError ? error.code : 'WORKSPACE_MCP_OPERATION_FAILED',
          error instanceof WorkspaceToolError ? error.message : 'The requested operation could not be completed.')
      }
    },
    async dispose() {
      disposed = true
      this.abortRequests()
      permissions.clear()
      pendingPermissionSessions.clear()
      approval?.dispose?.()
    },
    abortRequests() {
      permissionLifetime.abort()
      permissionLifetime = new AbortController()
      for (const permission of permissions.values()) {
        if (permission.status === 'pending') permission.status = 'cancelled'
        permission.turnEndSignal.abort()
      }
      pendingPermissionSessions.clear()
    },
  }
}

interface WorkspaceRecord {
  readonly id: string
  readonly name: string
  readonly sessionIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
}

interface PermissionRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly createdAt: string
  readonly expiresAt: number
  readonly turnEndSignal: AbortController
  status: 'pending' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
}

function defineTool(name: string, description: string, properties: Record<string, unknown>, required: readonly string[] = []): WorkspaceMcpTool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required: [...required], additionalProperties: false },
  }
}

function stringField(description: string): Record<string, unknown> {
  return { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH, description }
}

function integerField(minimum: number, maximum: number, description: string): Record<string, unknown> {
  return { type: 'integer', minimum, maximum, description }
}

function listWorkspaces(services: CodingNsHostServices): { readonly workspaces: readonly { workspaceId: string; name: string; sessionCount: number }[]; readonly hasMore: boolean } {
  const rows = workspaceRows(services).map(({ id, name, sessionIds, archivedSessionIds }) => ({
    workspaceId: id,
    name: name.slice(0, 160),
    sessionCount: sessionIds.filter((sessionId) => !archivedSessionIds.includes(sessionId)).length,
  }))
  return { workspaces: rows.slice(0, MAX_PAGE_SIZE), hasMore: rows.length > MAX_PAGE_SIZE }
}

async function listSessions(services: CodingNsHostServices, capability: WorkspaceSessionControlAdapter | undefined, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  const workspaceId = args.workspaceId === undefined ? undefined : requireId(args.workspaceId, 'workspaceId')
  const limit = args.limit === undefined ? 50 : requireInteger(args.limit, 1, MAX_PAGE_SIZE, 'limit')
  const offset = args.offset === undefined ? 0 : requireInteger(args.offset, 0, Number.MAX_SAFE_INTEGER, 'offset')
  const workspaces = workspaceId === undefined ? workspaceRows(services) : [requireWorkspace(services, workspaceId)]
  if (capability === undefined) return unavailable('WORKSPACE_MCP_SESSION_LIST_UNAVAILABLE', 'The versioned DSH workspace session-list capability is unavailable.')
  let listResult: unknown
  try { listResult = await capability.list(signal) } catch {
    return unavailable('WORKSPACE_MCP_SESSION_LIST_UNAVAILABLE', 'DSH could not read the session list.')
  }
  const remote = asRecord(listResult)
  if (!Array.isArray(remote?.items)) return unavailable('WORKSPACE_MCP_SESSION_LIST_UNAVAILABLE', 'DSH did not return a session list.')
  const listed: readonly unknown[] = remote.items
  const workspaceSessions = new Map(workspaces.map((workspace) => [workspace.id, new Set(workspace.sessionIds.filter((id) => !workspace.archivedSessionIds.includes(id)))]))
  const metadata = new Map<string, Record<string, unknown>>()
  for (const raw of listed) {
    const sessionId = sessionIdOf(raw)
    if (sessionId === null) continue
    const workspace = workspaces.find((entry) => workspaceSessions.get(entry.id)?.has(sessionId) === true)
    const origin = readText(asRecord(raw), ['origin'])
    const record = asRecord(raw)
    const parentSessionId = readText(record, ['parentSessionId'])
    const parentWorkspace = parentSessionId === null ? undefined : workspaces.find((entry) => workspaceSessions.get(entry.id)?.has(parentSessionId) === true)
    const effectiveWorkspace = workspace ?? (origin === 'subagent' ? parentWorkspace : undefined)
    if (effectiveWorkspace === undefined) continue
    metadata.set(sessionId, { ...sessionMetadata(raw, sessionId), workspaceId: effectiveWorkspace.id })
  }
  const ordered = [...metadata.values()]
    .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
  const page = ordered.slice(offset, offset + limit)
  return {
    sessions: page,
    offset,
    limit,
    hasMore: offset + Math.min(limit, Math.max(0, ordered.length - offset)) < ordered.length,
  }
}

async function createSession(services: CodingNsHostServices, capability: WorkspaceSessionControlAdapter | undefined, args: Readonly<Record<string, unknown>>, signal: AbortSignal, adapters?: { readonly getAdapterRegistry?: () => WorkspaceMcpAdapterRegistry | undefined }): Promise<unknown> {
  const workspaceId = requireId(args.workspaceId, 'workspaceId')
  requireWorkspace(services, workspaceId)
  const root = services.resolveManagedWorkspaceRoot?.(workspaceId)
  if (typeof root !== 'string' || root.trim() === '') return unavailable('WORKSPACE_MCP_WORKSPACE_UNAVAILABLE', 'The managed workspace is unavailable.')
  const adapterId = args.adapterId === undefined ? 'dsh' : requireAdapterId(args.adapterId)
  const modelId = args.modelId === undefined ? undefined : requireModelId(args.modelId)
  const prompt = args.prompt === undefined ? undefined : requireText(args.prompt, 'prompt', MAX_TEXT_LENGTH)
  if (adapterId !== 'dsh' && prompt === undefined) return invalid('WORKSPACE_MCP_INITIAL_PROMPT_REQUIRED', 'External adapter sessions require an initial prompt.')

  if (capability === undefined) return unavailable('WORKSPACE_MCP_SESSION_CREATE_UNAVAILABLE', 'The versioned DSH workspace session-control capability is unavailable.')

  let dshRoute: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
  const adapterRegistry = adapterId === 'dsh' ? undefined : adapters?.getAdapterRegistry?.()
  if (adapterId === 'dsh' && modelId !== undefined) {
    if (capability.selectModel === undefined) return unavailable('WORKSPACE_MCP_MODEL_SELECTION_UNAVAILABLE', 'Session-local model selection is unavailable on this DSH Host.')
    dshRoute = findDshModel(await capability.modelCatalog(), modelId)
    if (dshRoute === undefined) return invalid('WORKSPACE_MCP_MODEL_INVALID', 'The requested model is not uniquely available in the DSH model catalog.')
  } else if (adapterId !== 'dsh') {
    if (!EXTERNAL_ADAPTER_ID.test(adapterId)) return invalid('WORKSPACE_MCP_ADAPTER_INVALID', 'adapterId is invalid.')
    if (adapterRegistry === undefined) return unavailable('WORKSPACE_MCP_ADAPTER_UNAVAILABLE', 'The external adapter registry is unavailable.')
    const catalog = await adapterRegistry.catalogForUse([adapterId])
    const descriptor = catalog.find((entry) => entry.id === adapterId)
    if (descriptor === undefined || !descriptor.enabled || !descriptor.installed) return unavailable('WORKSPACE_MCP_ADAPTER_UNAVAILABLE', 'The requested adapter is not installed and enabled.')
    if (modelId !== undefined && !catalogHasModel(await adapterRegistry.models(adapterId), modelId)) {
      return invalid('WORKSPACE_MCP_MODEL_INVALID', 'The requested model is not in the adapter model catalog.')
    }
  }

  signal.throwIfAborted()
  // DSH's supported create contract accepts workspaceId. Do not send cwd or
  // synthetic session IDs: DSH allocates the canonical identity itself.
  const created = await capability.create({ workspaceId }, signal)
  const sessionId = sessionIdOf(created)
  if (sessionId === null) return unavailable('WORKSPACE_MCP_SESSION_CREATE_UNAVAILABLE', 'DSH did not return a valid session identity.')

  if (adapterId !== 'dsh') {
    try {
      adapterRegistry!.setSession(sessionId, { adapterId, ...(modelId === undefined ? {} : { modelId }) }, { rememberPreference: false, inheritSelection: false })
      await adapterRegistry!.flushSessionBindings()
    } catch {
      return { ok: false, sessionId, workspaceId, adapterId, ...(modelId === undefined ? {} : { modelId }), status: 'uncertain', error: { code: 'WORKSPACE_MCP_ADAPTER_BINDING_FAILED', message: 'The session was created but its adapter could not be bound.' } }
    }
  }

  // Resolving the newly-created Session eagerly makes its Agent identity and
  // initial model route stable before any optional prompt is admitted.
  if (adapterId === 'dsh') {
    try {
      await capability.prepareSession?.(sessionId, signal)
      if (modelId !== undefined && dshRoute !== undefined) await capability.selectModel!(sessionId, dshRoute, signal)
    } catch {
      return { ok: false, sessionId, workspaceId, adapterId, ...(modelId === undefined ? {} : { modelId }), status: 'uncertain', error: { code: 'WORKSPACE_MCP_SESSION_SETUP_FAILED', message: 'The session was created but DSH could not prepare the requested Agent and model.' } }
    }
  }

  if (adapterId !== 'dsh') {
      const sessionBinding = adapterRegistry!.getSession(sessionId)
    if (sessionBinding.adapterId !== adapterId || (modelId !== undefined && sessionBinding.modelId !== modelId)) {
      return { ok: false, sessionId, workspaceId, adapterId, ...(modelId === undefined ? {} : { modelId }), status: 'uncertain', error: { code: 'WORKSPACE_MCP_ADAPTER_BINDING_FAILED', message: 'The new session did not retain its requested adapter/model binding.' } }
    }
  }

  if (prompt !== undefined) {
    let accepted: unknown
    try {
      accepted = await capability.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      }, signal)
    } catch {
      return { ok: false, sessionId, workspaceId, adapterId, ...(modelId === undefined ? {} : { modelId }), status: 'uncertain', error: { code: 'WORKSPACE_MCP_PROMPT_UNCERTAIN', message: 'The session was created but initial prompt admission could not be confirmed. Inspect the session before retrying.' } }
    }
    if (asRecord(accepted)?.accepted !== true) {
      return { ok: false, sessionId, workspaceId, adapterId, ...(modelId === undefined ? {} : { modelId }), status: 'uncertain', error: { code: 'WORKSPACE_MCP_PROMPT_REJECTED', message: 'The session was created but the initial prompt was not accepted.' } }
    }
  }
  return { sessionId, workspaceId, adapterId, ...(modelId === undefined ? {} : { modelId }), status: prompt === undefined ? 'created' : 'accepted' }
}

async function continueSession(services: CodingNsHostServices, capability: WorkspaceSessionControlAdapter | undefined, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  const sessionId = requireId(args.sessionId, 'sessionId')
  const message = requireText(args.message, 'message', MAX_TEXT_LENGTH)
  const workspace = findSessionWorkspace(services, sessionId)
  if (workspace === undefined) return unavailable('WORKSPACE_MCP_SESSION_UNAVAILABLE', 'The session is not available in a managed workspace.')
  if (capability === undefined) return unavailable('WORKSPACE_MCP_SESSION_CONTINUE_UNAVAILABLE', 'The versioned DSH workspace session-control capability is unavailable.')
  signal.throwIfAborted()
  let response: unknown
  try {
    response = await capability.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: message }],
    }, signal)
  } catch {
    return { accepted: false, sessionId, workspaceId: workspace.id, status: 'uncertain', error: { code: 'WORKSPACE_MCP_SESSION_CONTINUE_UNCERTAIN', message: 'Prompt admission could not be confirmed. Inspect the session before retrying.' } }
  }
  if (asRecord(response)?.accepted !== true) return unavailable('WORKSPACE_MCP_SESSION_CONTINUE_UNAVAILABLE', 'DSH did not accept the message.')
  return { accepted: true, sessionId, workspaceId: workspace.id }
}

function listPendingQuestions(services: CodingNsHostServices, capability: WorkspacePendingQuestionsAdapter | undefined, args: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireId(args.sessionId, 'sessionId')
  const workspace = findSessionWorkspace(services, sessionId)
  if (workspace === undefined || workspace.archivedSessionIds.includes(sessionId)) return unavailable('WORKSPACE_MCP_SESSION_UNAVAILABLE', 'The session is not available in a managed workspace.')
  if (capability === undefined) return unavailable('WORKSPACE_MCP_QUESTIONS_UNAVAILABLE', 'The versioned DSH pending-question capability is unavailable.')
  const questions = capability.list(sessionId)
  if (questions === null) return unavailable('WORKSPACE_MCP_QUESTIONS_UNAVAILABLE', 'Pending question state could not be read.')
  const bounded = questions.slice(0, MAX_PAGE_SIZE).map((pending) => ({
    callId: pending.callId.slice(0, 128),
    state: pending.state,
    questions: pending.questions.slice(0, MAX_QUESTIONS).map((question) => ({
      id: question.id.slice(0, 128),
      question: question.question.slice(0, 2048),
      ...(question.detail === undefined ? {} : { detail: question.detail.slice(0, 4096) }),
      ...(question.header === undefined ? {} : { header: question.header.slice(0, 128) }),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
      ...(question.options === undefined ? {} : { options: question.options.slice(0, 32).map((option) => ({
        label: option.label.slice(0, 256),
        ...(option.description === undefined ? {} : { description: option.description.slice(0, 1024) }),
      })) }),
    })),
  }))
  const truncated = questions.length > bounded.length || questions.some((pending) => pending.questions.length > MAX_QUESTIONS
    || pending.questions.some((question) => (question.options?.length ?? 0) > 32))
  return { sessionId, workspaceId: workspace.id, questions: bounded, truncated }
}

function answerPendingQuestion(services: CodingNsHostServices, capability: WorkspacePendingQuestionsAdapter | undefined, args: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireId(args.sessionId, 'sessionId')
  const callId = requireQuestionId(args.callId, 'callId')
  const workspace = findSessionWorkspace(services, sessionId)
  if (workspace === undefined || workspace.archivedSessionIds.includes(sessionId)) return unavailable('WORKSPACE_MCP_SESSION_UNAVAILABLE', 'The session is not available in a managed workspace.')
  if (capability === undefined) return unavailable('WORKSPACE_MCP_QUESTIONS_UNAVAILABLE', 'The versioned DSH pending-question capability is unavailable.')
  const pending = capability.list(sessionId)?.find((question) => question.callId === callId
    && (question.state === 'continued' || question.state === 'open'))
  if (pending === undefined) {
    return unavailable('WORKSPACE_MCP_QUESTION_NOT_PENDING', 'The pending question is no longer answerable.')
  }
  const answer = validateAnswer(args.answer, pending.questions)
  const accepted = capability.answer(sessionId, callId, answer)
  return accepted
    ? { accepted: true, sessionId, workspaceId: workspace.id, callId }
    : unavailable('WORKSPACE_MCP_QUESTION_NOT_PENDING', 'The pending question is no longer answerable.')
}

function requestPermission(
  services: CodingNsHostServices,
  capability: WorkspaceApprovalAdapter | undefined,
  requests: Map<string, PermissionRequest>,
  pendingSessions: Map<string, string>,
  args: Readonly<Record<string, unknown>>,
  featureLifetime: AbortController,
): unknown {
  const sessionId = requireId(args.sessionId, 'sessionId')
  const workspace = findSessionWorkspace(services, sessionId)
  if (workspace === undefined) return unavailable('WORKSPACE_MCP_SESSION_UNAVAILABLE', 'The session is not available in a managed workspace.')
  const toolName = requireText(args.toolName, 'toolName', 256)
  const reason = requireText(args.reason, 'reason', 2048)
  const callId = args.callId === undefined ? undefined : requireId(args.callId, 'callId')
  if (featureLifetime.signal.aborted) return unavailable('WORKSPACE_MCP_STOPPED', 'Workspace MCP tools are stopped.')
  if (capability === undefined) return Promise.resolve(unavailable('WORKSPACE_MCP_APPROVAL_UNAVAILABLE', 'The versioned DSH approval capability is unavailable.'))
  prunePermissions(requests)
  if (requests.size >= MAX_PENDING_PERMISSIONS) return unavailable('WORKSPACE_MCP_REQUEST_LIMIT', 'Too many permission requests are being tracked.')
  if (pendingSessions.has(sessionId)) return unavailable('WORKSPACE_MCP_APPROVAL_REQUEST_PENDING', 'This session already has an unresolved MCP permission request.')
  const turnEndSignal = new AbortController()
  const onFeatureAbort = (): void => turnEndSignal.abort()
  if (featureLifetime.signal.aborted) onFeatureAbort()
  else featureLifetime.signal.addEventListener('abort', onFeatureAbort, { once: true })
  const started = capability.startRequest({
    sessionId,
    toolName,
    ...(callId === undefined ? {} : { callId }),
    reason,
    signal: turnEndSignal.signal,
  })
  if (started === null) {
    featureLifetime.signal.removeEventListener('abort', onFeatureAbort)
    return unavailable('WORKSPACE_MCP_APPROVAL_REQUIRES_ACTIVE_TURN', 'DSH approval requires a live Agent inside an active turn and no other pending permission request.')
  }
  const requestId = started.requestId
  const request: PermissionRequest = {
    requestId,
    sessionId,
    workspaceId: workspace.id,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + PERMISSION_RETENTION_MS,
    turnEndSignal,
    status: 'pending',
  }
  requests.set(requestId, request)
  pendingSessions.set(sessionId, requestId)
  void started.outcome.then((outcome) => {
    const wasPending = request.status === 'pending'
    if (wasPending) request.status = outcome
    if (pendingSessions.get(sessionId) === requestId) pendingSessions.delete(sessionId)
    request.turnEndSignal.abort()
    featureLifetime.signal.removeEventListener('abort', onFeatureAbort)
  }, () => {
    const wasPending = request.status === 'pending'
    if (wasPending) request.status = featureLifetime.signal.aborted ? 'cancelled' : 'unavailable'
    if (pendingSessions.get(sessionId) === requestId) pendingSessions.delete(sessionId)
    request.turnEndSignal.abort()
    featureLifetime.signal.removeEventListener('abort', onFeatureAbort)
  })
  return { accepted: true, sessionId, workspaceId: workspace.id, requestId, status: 'pending', createdAt: request.createdAt }
}

function permissionStatus(services: CodingNsHostServices, requests: Map<string, PermissionRequest>, args: Readonly<Record<string, unknown>>): unknown {
  const sessionId = requireId(args.sessionId, 'sessionId')
  const requestId = requireId(args.requestId, 'requestId')
  const workspace = findSessionWorkspace(services, sessionId)
  if (workspace === undefined) return unavailable('WORKSPACE_MCP_SESSION_UNAVAILABLE', 'The session is not available in a managed workspace.')
  const request = requests.get(requestId)
  if (request !== undefined && (request.sessionId !== sessionId || request.workspaceId !== workspace.id)) {
    return unavailable('WORKSPACE_MCP_PERMISSION_REQUEST_UNKNOWN', 'The permission request is unknown or expired.')
  }
  if (request !== undefined) {
    if (request.expiresAt <= Date.now()) {
      request.turnEndSignal.abort()
      requests.delete(requestId)
      return unavailable('WORKSPACE_MCP_PERMISSION_REQUEST_UNKNOWN', 'The permission request is unknown or expired.')
    }
    return { requestId, sessionId, workspaceId: workspace.id, status: request.status, createdAt: request.createdAt }
  }
  return unavailable('WORKSPACE_MCP_PERMISSION_REQUEST_UNKNOWN', 'The permission request is unknown or expired.')
}

function listTerminals(services: CodingNsHostServices, args: Readonly<Record<string, unknown>>): unknown {
  const workspaceId = requireId(args.workspaceId, 'workspaceId')
  const sessionId = requireId(args.sessionId, 'sessionId')
  const workspace = requireWorkspace(services, workspaceId)
  if (!workspace.sessionIds.includes(sessionId) || workspace.archivedSessionIds.includes(sessionId)) return unavailable('WORKSPACE_MCP_SESSION_UNAVAILABLE', 'The session is not available in this workspace.')
  if (services.terminalProcesses === undefined) return unavailable('WORKSPACE_MCP_TERMINAL_LIST_UNAVAILABLE', 'The terminal process service is unavailable.')
  const instances = services.terminalProcesses.listWorkspaceTerminalsForSession(workspaceId, sessionId)
  return {
    terminals: instances.slice(0, MAX_PAGE_SIZE).map((terminal) => ({ terminalId: terminal.id, dshSessionId: sessionId, state: terminal.state, title: terminal.title.slice(0, 120) })),
    hasMore: instances.length > MAX_PAGE_SIZE,
  }
}

async function readTerminal(services: CodingNsHostServices, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  const workspaceId = requireId(args.workspaceId, 'workspaceId')
  const sessionId = requireId(args.sessionId, 'sessionId')
  const terminalId = requireTerminalId(args.terminalId)
  const workspace = requireWorkspace(services, workspaceId)
  if (!workspace.sessionIds.includes(sessionId) || workspace.archivedSessionIds.includes(sessionId)) return unavailable('WORKSPACE_MCP_SESSION_UNAVAILABLE', 'The session is not available in this workspace.')
  const limitBytes = args.limitBytes === undefined ? 16 * 1024 : requireInteger(args.limitBytes, 1, MAX_TERMINAL_READ_BYTES, 'limitBytes')
  const terminalProcesses = services.terminalProcesses
  if (terminalProcesses === undefined) {
    return unavailable('WORKSPACE_MCP_TERMINAL_READ_UNAVAILABLE', 'The scoped terminal output service is unavailable.')
  }
  if (!terminalProcesses.listWorkspaceTerminalsForSession(workspaceId, sessionId).some((terminal) => terminal.id === terminalId)) {
    return unavailable('WORKSPACE_MCP_TERMINAL_UNAVAILABLE', 'The terminal instance is unavailable in this workspace.')
  }
  signal.throwIfAborted()
  const output = await terminalProcesses.readSessionTerminalOutput(workspaceId, sessionId, terminalId, limitBytes)
  if (typeof output !== 'object' || output === null || typeof output.text !== 'string' || typeof output.truncated !== 'boolean') {
    return unavailable('WORKSPACE_MCP_TERMINAL_READ_UNAVAILABLE', 'The terminal service returned no bounded output snapshot.')
  }
  return { workspaceId, terminalId, data: output.text, truncated: output.truncated }
}

async function writeTerminal(services: CodingNsHostServices, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  const workspaceId = requireId(args.workspaceId, 'workspaceId')
  const sessionId = requireId(args.sessionId, 'sessionId')
  const terminalId = requireTerminalId(args.terminalId)
  if (typeof args.data !== 'string' || args.data.length === 0 || args.data.includes('\u0000')) {
    return invalid('WORKSPACE_MCP_INVALID_INPUT', 'data must contain non-empty text without NUL characters.')
  }
  const data = args.data
  const workspace = requireWorkspace(services, workspaceId)
  if (!workspace.sessionIds.includes(sessionId) || workspace.archivedSessionIds.includes(sessionId)) return unavailable('WORKSPACE_MCP_SESSION_UNAVAILABLE', 'The session is not available in this workspace.')
  if (new TextEncoder().encode(data).byteLength > MAX_TERMINAL_INPUT_BYTES) return invalid('WORKSPACE_MCP_TERMINAL_INPUT_TOO_LARGE', 'Terminal input exceeds the allowed byte limit.')
  const terminalProcesses = services.terminalProcesses
  if (terminalProcesses === undefined) {
    return unavailable('WORKSPACE_MCP_TERMINAL_WRITE_UNAVAILABLE', 'The scoped terminal input service is unavailable.')
  }
  if (!terminalProcesses.listWorkspaceTerminalsForSession(workspaceId, sessionId).some((terminal) => terminal.id === terminalId)) {
    return unavailable('WORKSPACE_MCP_TERMINAL_UNAVAILABLE', 'The terminal instance is unavailable in this workspace.')
  }
  signal.throwIfAborted()
  await terminalProcesses.writeSessionTerminalInput(workspaceId, sessionId, terminalId, data)
  return { accepted: true, workspaceId, terminalId }
}

function workspaceRows(services: CodingNsHostServices): readonly WorkspaceRecord[] {
  const registry = readService(services, 'workspaceRegistry')
  if (typeof registry?.list !== 'function') return []
  let values: unknown
  try { values = (registry.list as () => unknown).call(registry) } catch { return [] }
  if (!Array.isArray(values)) return []
  return values.flatMap((raw) => {
    const value = asRecord(raw)
    const id = readText(value, ['id', 'workspaceId', 'key'])
    if (id === null || !isValidId(id)) return []
    const root = services.resolveManagedWorkspaceRoot?.(id)
    if (typeof root !== 'string' || root.trim() === '') return []
    const workspaceRegistry = readService(services, 'workspaceRegistry')
    if (workspaceRegistry === undefined || !Array.isArray(workspaceRegistry.archivedSessionIds)) return []
    const archivedSessionIds = readStringArray(workspaceRegistry.archivedSessionIds).filter(isValidId)
    return [{
      id,
      name: readText(value, ['title', 'displayName', 'name']) ?? id,
      sessionIds: readStringArray(value?.sessionIds).filter(isValidId),
      archivedSessionIds,
    }]
  })
}

function requireWorkspace(services: CodingNsHostServices, workspaceId: string): WorkspaceRecord {
  const workspace = workspaceRows(services).find((entry) => entry.id === workspaceId)
  if (workspace === undefined) throw new WorkspaceToolError('WORKSPACE_MCP_WORKSPACE_UNAVAILABLE', 'The workspace is unavailable.')
  const root = services.resolveManagedWorkspaceRoot?.(workspaceId)
  if (typeof root !== 'string' || root.trim() === '') {
    throw new WorkspaceToolError('WORKSPACE_MCP_WORKSPACE_UNAVAILABLE', 'The managed workspace is unavailable.')
  }
  return workspace
}

function findSessionWorkspace(services: CodingNsHostServices, sessionId: string): WorkspaceRecord | undefined {
  const workspace = workspaceRows(services).find((entry) => entry.sessionIds.includes(sessionId) && !entry.archivedSessionIds.includes(sessionId))
  const root = workspace === undefined ? null : services.resolveManagedWorkspaceRoot?.(workspace.id)
  if (workspace !== undefined && typeof root === 'string' && root.trim() !== '') return workspace
  // DSH native subagent headers may carry an exact parent session ID; inherit only
  // that parent's live workspace membership, never a caller-provided workspace.
  let current = sessionId
  const visited = new Set([current])
  for (let depth = 0; depth < 8; depth += 1) {
    const header = asRecord(asRecord(services.nativeSessions?.get(current))?.header)
    const parent = readText(header, ['parentSession', 'parentSessionId'])
    if (parent === null || visited.has(parent)) return undefined
    const parentWorkspace = workspaceRows(services).find((entry) => entry.sessionIds.includes(parent) && !entry.archivedSessionIds.includes(parent))
    const parentRoot = parentWorkspace === undefined ? null : services.resolveManagedWorkspaceRoot?.(parentWorkspace.id)
    if (parentWorkspace !== undefined && typeof parentRoot === 'string' && parentRoot.trim() !== '') return parentWorkspace
    visited.add(parent)
    current = parent
  }
  return undefined
}

function validateAnswer(value: unknown, questions: readonly { readonly id: string; readonly options?: readonly { readonly label: string }[]; readonly multiSelect?: boolean }[]): { readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] } {
  const record = asRecord(value)
  if (!Array.isArray(record?.answers) || record.answers.length < 1 || record.answers.length > MAX_QUESTIONS) {
    throw new WorkspaceToolError('WORKSPACE_MCP_QUESTIONS_INVALID', `answer.answers must contain 1 to ${String(MAX_QUESTIONS)} items.`)
  }
  const answers = record.answers.map((raw, index) => {
    const answer = asRecord(raw)
    if (answer === undefined) throw new WorkspaceToolError('WORKSPACE_MCP_QUESTIONS_INVALID', `answer.answers[${String(index)}] must be an object.`)
    const id = requireQuestionId(answer.id, `answer.answers[${String(index)}].id`)
    if (!Array.isArray(answer.selected) || answer.selected.length > 32 || answer.selected.some((entry) => typeof entry !== 'string' || entry.length > 256)) {
      throw new WorkspaceToolError('WORKSPACE_MCP_QUESTIONS_INVALID', 'Each answer must provide a bounded selected string array.')
    }
    if (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 4096)) {
      throw new WorkspaceToolError('WORKSPACE_MCP_QUESTIONS_INVALID', 'Answer custom text exceeds the allowed size.')
    }
    return {
      id,
      selected: answer.selected as string[],
      ...(answer.custom === undefined ? {} : { custom: answer.custom as string }),
    }
  })
  if (!validAnswers(questions, answers)) throw new WorkspaceToolError('WORKSPACE_MCP_QUESTIONS_INVALID', 'Answers must match every pending question and its allowed choices exactly once.')
  return { answers }
}

function validAnswers(questions: readonly { readonly id: string; readonly options?: readonly { readonly label: string }[]; readonly multiSelect?: boolean }[], answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]): boolean {
  const questionById = new Map(questions.map((question) => [question.id, question]))
  if (answers.length !== questions.length) return false
  const seen = new Set<string>()
  for (const answer of answers) {
    const question = questionById.get(answer.id)
    if (question === undefined || seen.has(answer.id) || !Array.isArray(answer.selected)) return false
    seen.add(answer.id)
    if (question.multiSelect !== true && answer.selected.length > 1) return false
    if (question.options !== undefined && answer.selected.some((selection) => !question.options!.some((option) => option.label === selection))) return false
    if (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 4096)) return false
  }
  return seen.size === questions.length
}

function findDshModel(value: unknown, modelId: string): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined {
  const catalog = asRecord(value)
  if (!Array.isArray(catalog?.groups)) return undefined
  const matches: Array<{ provider: string; model: string; reasoningEffort?: string }> = []
  for (const rawGroup of catalog.groups) {
    const group = asRecord(rawGroup)
    if (typeof group?.id !== 'string' || !Array.isArray(group.models)) continue
    for (const rawModel of group.models) {
      const model = asRecord(rawModel)
      if (model?.id !== modelId) continue
      const reasoning = asRecord(model.reasoning)
      matches.push({ provider: group.id, model: modelId, ...(typeof reasoning?.defaultEffort === 'string' ? { reasoningEffort: reasoning.defaultEffort } : {}) })
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

function catalogHasModel(value: unknown, modelId: string): boolean {
  const catalog = asRecord(value)
  return Array.isArray(catalog?.groups) && catalog.groups.some((rawGroup) => {
    const group = asRecord(rawGroup)
    return Array.isArray(group?.models) && group.models.some((rawModel) => asRecord(rawModel)?.id === modelId)
  })
}

function sessionIdOf(value: unknown): string | null {
  const record = asRecord(value)
  const header = asRecord(record?.header)
  const id = readText(record, ['sessionId', 'id', 'key']) ?? readText(header, ['id'])
  return id !== null && isValidId(id) ? id : null
}

function sessionMetadata(raw: unknown, sessionId: string): Record<string, unknown> {
  const value = asRecord(raw)
  const projectionHints = asRecord(value?.projections)
  const projectionValues = asRecord(projectionHints?.values)
  const listMetadata = asRecord(projectionValues?.sessionListMetadata)
  const title = projectionValues?.title
  const updatedAt = readTimestamp(value, ['updatedAt', 'lastUpdatedAt', 'createdAt'])
  const parentSessionId = readText(value, ['parentSessionId'])
  return {
    sessionId,
    status: value?.running === true ? 'running' : value?.running === false ? 'idle' : 'unknown',
    updatedAt: updatedAt ?? 0,
    blank: listMetadata?.blank === true || value?.blank === true,
    agentAvailable: value?.agentAvailable === true,
    ...(typeof title === 'string' && title.trim() !== '' ? { title: title.slice(0, 160) } : {}),
    ...(parentSessionId === null ? {} : { parentSessionId }),
    ...(typeof value?.origin === 'string' ? { origin: value.origin } : {}),
  }
}

function readService(services: CodingNsHostServices, name: string): Record<string, unknown> | undefined {
  try { return asRecord(services.dshContext?.get(name)) } catch { return undefined }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readText(value: Record<string, unknown> | undefined, keys: readonly string[]): string | null {
  if (value === undefined) return null
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

function readTimestamp(value: Record<string, unknown> | undefined, keys: readonly string[]): number | string | undefined {
  if (value === undefined) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (typeof candidate === 'string' && Number.isFinite(Date.parse(candidate))) return candidate
  }
  return undefined
}

const EXTERNAL_ADAPTER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u

function requireAdapterId(value: unknown): string {
  if (typeof value !== 'string' || !EXTERNAL_ADAPTER_ID.test(value.trim())) throw new WorkspaceToolError('WORKSPACE_MCP_INVALID_INPUT', 'adapterId is invalid.')
  return value.trim()
}

function requireModelId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256 || /[\u0000-\u001f]/u.test(value)) throw new WorkspaceToolError('WORKSPACE_MCP_INVALID_INPUT', 'modelId is invalid.')
  return value.trim()
}

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isValidId(value.trim())) throw new WorkspaceToolError('WORKSPACE_MCP_INVALID_ID', `${name} is invalid.`)
  return value.trim()
}

function requireQuestionId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.trim())) throw new WorkspaceToolError('WORKSPACE_MCP_QUESTIONS_INVALID', `${name} is invalid.`)
  return value.trim()
}

function requireTerminalId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,128}$/u.test(value.trim())) throw new WorkspaceToolError('WORKSPACE_MCP_INVALID_ID', 'terminalId is invalid.')
  return value.trim()
}

function requireText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || value.includes('\u0000')) throw new WorkspaceToolError('WORKSPACE_MCP_INVALID_INPUT', `${name} must contain 1 to ${String(maximum)} characters.`)
  return value
}

function requireInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new WorkspaceToolError('WORKSPACE_MCP_INVALID_INPUT', `${name} is outside its allowed range.`)
  return value
}

function isValidId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
}

function prunePermissions(requests: Map<string, PermissionRequest>): void {
  const now = Date.now()
  for (const [id, value] of requests) {
    if (value.expiresAt <= now && value.status !== 'pending') requests.delete(id)
  }
  while (requests.size >= MAX_PENDING_PERMISSIONS) {
    const oldest = requests.keys().next().value as string | undefined
    if (oldest === undefined) return
    const request = requests.get(oldest)
    if (request?.status === 'pending' && request.expiresAt > now) return
    requests.delete(oldest)
  }
}

function toolSuccess(value: unknown): unknown {
  const result = asRecord(value)
  const isError = result?.ok === false || result?.error !== undefined
  return {
    resultType: 'complete',
    isError,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

function toolError(code: string, message: string): unknown {
  const value = { ok: false, error: { code, message } }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

function unavailable(code: string, message: string): { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  return { ok: false, error: { code, message } }
}

function invalid(code: string, message: string): { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  return { ok: false, error: { code, message } }
}

class WorkspaceToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'WorkspaceToolError'
  }
}
