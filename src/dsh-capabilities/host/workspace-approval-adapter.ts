export type WorkspaceApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface WorkspaceApprovalRequest {
  readonly requestId: string
  readonly outcome: Promise<WorkspaceApprovalOutcome>
}

export interface WorkspaceApprovalAdapter {
  dispose?(): void
  startRequest(input: {
    readonly sessionId: string
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
    readonly signal: AbortSignal
  }): WorkspaceApprovalRequest | null
}

interface AgentLike {
  readonly id?: string
  readonly status?: 'idle' | 'running'
  readonly session?: { readonly seq?: number }
}

interface AgentRegistryLike { get(id: string): unknown }
interface ApprovalServiceLike { request(input: Record<string, unknown>): Promise<unknown> }
interface ContextLike {
  get(name: string): unknown
  on?(name: string, listener: (session: unknown, event: unknown) => void, options?: { readonly global?: boolean }): unknown
}

export function supportsWorkspaceApproval(context: unknown): boolean {
  const nativeContext = asContext(context)
  const get = nativeContext?.get.bind(nativeContext)
  return nativeContext?.on !== undefined
    && hasMethod(safeGet(get, 'agents'), 'get')
    && hasMethod(safeGet(get, 'approval'), 'request')
}

export function createWorkspaceApprovalAdapter(context: unknown): WorkspaceApprovalAdapter {
  const nativeContext = asContext(context)
  const get = nativeContext?.get.bind(nativeContext)
  if (!supportsWorkspaceApproval(context)) throw new TypeError('DSH approval capability is unavailable')
  const activeRequests = new Set<() => void>()
  let disposed = false
  return {
    dispose() {
      disposed = true
      for (const cancel of activeRequests) cancel()
      activeRequests.clear()
    },
    startRequest(input) {
      if (disposed || input.signal.aborted) return null
      const agents = safeGet(get, 'agents') as AgentRegistryLike | undefined
      const approval = safeGet(get, 'approval') as ApprovalServiceLike | undefined
      if (agents === undefined || approval === undefined) return null
      let agent: AgentLike | undefined
      try { agent = asAgent(agents.get(input.sessionId)) } catch { return null }
      if (agent?.status !== 'running' || agent.session === undefined || typeof agent.session.seq !== 'number' || nativeContext?.on === undefined) return null
      const startingSeq = agent.session.seq
      const requestLifetime = new AbortController()
      let requestDisposed = false
      let disposeTurnListener: unknown
      let disposeApprovalListener: unknown
      let approvalEvent: { readonly sessionId: string; readonly seq: number; readonly id: string; readonly toolName: string; readonly callId?: string; readonly reason?: string } | undefined
      const abortRequest = (): void => requestLifetime.abort(input.signal.reason)
      const cleanup = (): void => {
        if (requestDisposed) return
        requestDisposed = true
        input.signal.removeEventListener('abort', abortRequest)
        requestLifetime.signal.removeEventListener('abort', cleanup)
        if (typeof disposeTurnListener === 'function') disposeTurnListener()
        if (typeof disposeApprovalListener === 'function') disposeApprovalListener()
        activeRequests.delete(abortRequest)
      }
      requestLifetime.signal.addEventListener('abort', cleanup, { once: true })
      if (input.signal.aborted) abortRequest()
      else input.signal.addEventListener('abort', abortRequest, { once: true })
      try {
        disposeTurnListener = nativeContext.on('session/event', (sessionValue, eventValue) => {
          const session = asRecord(sessionValue)
          const event = asRecord(eventValue)
          const sessionId = typeof session?.id === 'string' ? session.id : asRecord(session?.header)?.id
          if (sessionId === input.sessionId && event?.type === 'turn/end') requestLifetime.abort()
        }, { global: true })
      } catch {
        cleanup()
        return null
      }
      if (typeof disposeTurnListener !== 'function') {
        cleanup()
        return null
      }
      activeRequests.add(abortRequest)
      try {
        disposeApprovalListener = nativeContext.on('session/event', (sessionValue, eventValue) => {
          const session = asRecord(sessionValue)
          const event = asRecord(eventValue)
          const data = asRecord(event?.data)
          const sessionId = typeof session?.id === 'string' ? session.id : asRecord(session?.header)?.id
          if (sessionId !== input.sessionId || event?.type !== 'approval/asked' || event.seq !== startingSeq
            || typeof data?.id !== 'string' || data.toolName !== input.toolName
            || data.callId !== input.callId || data.reason !== input.reason) return
          approvalEvent = { sessionId, seq: startingSeq, id: data.id, toolName: data.toolName,
            ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
            ...(typeof data.reason === 'string' ? { reason: data.reason } : {}) }
        }, { global: true })
      } catch {
        cleanup()
        return null
      }
      if (typeof disposeApprovalListener !== 'function') {
        cleanup()
        return null
      }
      let outcome: Promise<unknown>
      try {
        outcome = Promise.resolve(approval.request({
          agent,
          toolName: input.toolName,
          ...(input.callId === undefined ? {} : { callId: input.callId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          signal: requestLifetime.signal,
        }))
      } catch {
        cleanup()
        return null
      }
      disposeApprovalListener()
      disposeApprovalListener = undefined
      const event = approvalEvent
      if (event === undefined || event.seq !== startingSeq || event.sessionId !== input.sessionId
        || event.toolName !== input.toolName || event.callId !== input.callId || event.reason !== input.reason) {
        cleanup()
        void outcome.catch(() => undefined)
        return null
      }
      let onCancellation: (() => void) | undefined
      const cancelled = requestLifetime.signal.aborted
        ? Promise.resolve<WorkspaceApprovalOutcome>('cancelled')
        : new Promise<WorkspaceApprovalOutcome>((resolve) => {
          onCancellation = () => resolve('cancelled')
          requestLifetime.signal.addEventListener('abort', onCancellation, { once: true })
        })
      return {
        requestId: event.id,
        outcome: Promise.race([
          outcome.then((result) => isOutcome(result) ? result : 'unavailable', () => requestLifetime.signal.aborted ? 'cancelled' : 'unavailable'),
          cancelled,
        ]).finally(() => {
          if (onCancellation !== undefined) requestLifetime.signal.removeEventListener('abort', onCancellation)
          cleanup()
        }),
      }
    },
  }
}

function safeGet(get: ((name: string) => unknown) | undefined, name: string): unknown {
  try { return get?.(name) } catch { return undefined }
}

function asContext(context: unknown): ContextLike | undefined {
  if (typeof context !== 'object' || context === null || typeof (context as { get?: unknown }).get !== 'function') return undefined
  return context as ContextLike
}

function hasMethod(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[name] === 'function'
}

function asAgent(value: unknown): AgentLike | undefined {
  return typeof value === 'object' && value !== null ? value as AgentLike : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isOutcome(value: unknown): value is WorkspaceApprovalOutcome {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}
