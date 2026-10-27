export interface WorkspaceSessionControlAdapter {
  create(request: { readonly workspaceId: string }, signal: AbortSignal): Promise<unknown>
  prepareSession?(sessionId: string, signal: AbortSignal): Promise<void>
  list(signal: AbortSignal): Promise<unknown>
  prompt(request: {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue'
    readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  }, signal: AbortSignal): Promise<unknown>
  modelCatalog(): Promise<unknown>
  selectModel?(sessionId: string, selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }, signal: AbortSignal): Promise<unknown>
}

interface SessionControllerLike {
  create?: (request: { readonly workspaceId: string }) => Promise<unknown>
  list?: (request: Record<string, never>, signal: AbortSignal) => Promise<unknown>
  prompt?: (request: WorkspaceSessionControlAdapter extends infer _ ? {
    readonly requestId: string
    readonly sessionId: string
    readonly mode: 'queue'
    readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  } : never, signal: AbortSignal) => Promise<unknown>
  modelCatalog?: () => Promise<unknown>
  resolveAgent?: (sessionId: string) => Promise<unknown>
  agents?: {
    resolveAgent?: (sessionId: string) => Promise<unknown>
    selectForNextRequest?: (agent: unknown, selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }) => void
  }
}

interface ContextLike {
  get(name: string): unknown
}

/** Narrow typed adapter over DSH's public SessionController surface. */
export function supportsWorkspaceSessionControl(context: unknown): boolean {
  const controller = asController(readContext(context, 'sessionController'))
  const agents = asRecord(readContext(context, 'agents'))
  return controller !== undefined
    && typeof controller.create === 'function'
    && typeof controller.list === 'function'
    && typeof controller.prompt === 'function'
    && typeof controller.modelCatalog === 'function'
    && typeof agents?.get === 'function'
}

export function createWorkspaceSessionControlAdapter(context: unknown): WorkspaceSessionControlAdapter {
  const controller = asController(readContext(context, 'sessionController'))
  if (!supportsWorkspaceSessionControl(context) || controller === undefined) throw new TypeError('DSH SessionController workspace control is unavailable')
  const agents = controller.agents
  const agentRegistry = asRecord(readContext(context, 'agents'))
  const llm = asRecord(readContext(context, 'llm'))
  const selectModel = async (sessionId: string, selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted()
    if (agents?.selectForNextRequest === undefined || llm === undefined || typeof llm.resolveCallConfig !== 'function') {
      throw new Error('Session-local DSH model selection is unavailable')
    }
    if (controller.resolveAgent === undefined) throw new Error('DSH Session Agent resolution is unavailable')
    const found = asRecord(await controller.resolveAgent.call(controller, sessionId))
    if (found === undefined || 'error' in found || found.agent === undefined) throw new Error('DSH session Agent is unavailable for model selection')
    const resolved = asRecord(await (llm.resolveCallConfig as (value: unknown) => Promise<unknown>).call(llm, selection))
    if (typeof resolved?.provider !== 'string' || typeof resolved.model !== 'string') throw new Error('The requested DSH model route is unavailable')
    const liveAgent = (agentRegistry?.get as ((id: string) => unknown) | undefined)?.call(agentRegistry, sessionId)
    if (liveAgent === undefined || liveAgent !== found.agent) throw new Error('DSH did not retain the selected Session Agent')
    agents.selectForNextRequest.call(agents, found.agent, {
      provider: resolved.provider,
      model: resolved.model,
      ...(typeof resolved.reasoningEffort === 'string' ? { reasoningEffort: resolved.reasoningEffort } : {}),
    })
    return { selected: { provider: resolved.provider, model: resolved.model, ...(typeof resolved.reasoningEffort === 'string' ? { reasoningEffort: resolved.reasoningEffort } : {}) } }
  }
  const adapter: WorkspaceSessionControlAdapter = {
    create: (request, signal) => {
      signal.throwIfAborted()
      return controller.create!.call(controller, request)
    },
    list: (signal) => {
      signal.throwIfAborted()
      return controller.list!.call(controller, {}, signal)
    },
    prompt: (request, signal) => controller.prompt!.call(controller, request, signal),
    modelCatalog: () => controller.modelCatalog!.call(controller),
    ...(typeof controller.resolveAgent === 'function'
      ? { prepareSession: async (sessionId: string, signal: AbortSignal) => {
        signal.throwIfAborted()
        const result = asRecord(await controller.resolveAgent!.call(controller, sessionId))
        if (result === undefined || 'error' in result || result.agent === undefined) throw new Error('DSH Session Agent could not be prepared')
        const liveAgent = (agentRegistry?.get as ((id: string) => unknown) | undefined)?.call(agentRegistry, sessionId)
        if (liveAgent === undefined || liveAgent !== result.agent) throw new Error('DSH did not retain the prepared Session Agent')
      } }
      : {}),
    ...(typeof controller.agents?.selectForNextRequest === 'function' && typeof llm?.resolveCallConfig === 'function'
      ? { selectModel: async (sessionId, selection, signal) => await selectModel(sessionId, selection, signal) }
      : {}),
  }
  return adapter
}

function asController(value: unknown): SessionControllerLike | undefined {
  return asRecord(value) as SessionControllerLike | undefined
}

function readContext(context: unknown, name: string): unknown {
  if (typeof context !== 'object' || context === null || typeof (context as { get?: unknown }).get !== 'function') return undefined
  try { return (context as ContextLike).get(name) } catch { return undefined }
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}
