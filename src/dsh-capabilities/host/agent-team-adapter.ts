import type { CodingNsTeamAction, CodingNsTeamIdentity } from '../../shared/contracts/agent-team.js'

export interface TeamAgent {
  readonly id: string
  readonly session?: { readonly header?: { readonly id?: string } }
}

export interface TeamAgentRegistry {
  get(id: string): unknown
  list(): readonly unknown[]
}

export interface NativeAgentTeamService {
  membership(agent: unknown): unknown
  listMembers(agent: unknown): unknown
  sendMessage(agent: unknown, request: Record<string, unknown>): unknown
  listTasks(agent: unknown): unknown
  getTask(agent: unknown, id: string): unknown
  createTask(agent: unknown, request: Record<string, unknown>): unknown
  updateTask(agent: unknown, request: Record<string, unknown>): unknown
  waitForChange(agent: unknown, timeoutMs: number, signal: AbortSignal): unknown
  spawnTeammate?(agent: unknown, request: Record<string, unknown>): unknown
  interrupt?(agent: unknown, target: string): unknown
}

const MEMBER_METHODS = ['membership', 'listMembers', 'sendMessage', 'listTasks', 'getTask', 'createTask', 'updateTask', 'waitForChange']

export function supportsExternalAgentTeam(context: unknown, lead = false): boolean {
  const service = read(context, 'agentTeams')
  return hasMethods(service, [...MEMBER_METHODS, ...(lead ? ['spawnTeammate', 'interrupt'] : [])])
    && hasMethods(read(context, 'agents'), ['get', 'list'])
    && hasMethods(read(context, 'subagents'), ['registerProvider', 'startActivation', 'sendMessage'])
}

export function createAgentTeamAdapter(context: unknown): DshAgentTeamAdapter {
  return new DshAgentTeamAdapter(read(context, 'agentTeams') as NativeAgentTeamService, read(context, 'agents') as TeamAgentRegistry, () => read(context, 'sessionController'))
}

/** Exact Agent identity and all DSH-specific calls stay at this boundary. */
export class DshAgentTeamAdapter {
  private readonly lifetime = new AbortController()
  readonly supportsLead: boolean

  constructor(private readonly service: NativeAgentTeamService, private readonly agents: TeamAgentRegistry, private readonly controller?: unknown) {
    this.supportsLead = hasMethods(service, ['spawnTeammate', 'interrupt'])
  }

  get signal(): AbortSignal { return this.lifetime.signal }

  async nativeRoute(model?: string, effort?: string, provider?: string): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
    // The catalog service may be published after the Team service or replaced
    // during reload. Resolve it at the operation boundary, not at activation.
    const controller = (typeof this.controller === 'function' ? this.controller() : this.controller) as { modelCatalog?(): Promise<unknown> } | undefined
    if (!controller?.modelCatalog) throw teamError('TEAM_NATIVE_ROUTE_UNAVAILABLE', 'A native DSH model catalog is required for mixed Teams.')
    const catalog = await controller.modelCatalog() as { groups?: { id: string; models?: { id: string; reasoning?: { efforts?: { id: string }[] } }[] }[]; default?: { provider: string; model: string; reasoningEffort?: string } }
    const selectedModel = model ?? catalog.default?.model
    const selectedProvider = provider ?? (model === undefined ? catalog.default?.provider : undefined)
    const matches = (catalog.groups ?? []).flatMap(group => group.id.startsWith('codingns-cli-') || selectedProvider && group.id !== selectedProvider ? []
      : (group.models ?? []).filter(item => item.id === selectedModel).map(item => ({ provider: group.id, item })))
    if (matches.length !== 1) throw teamError('TEAM_NATIVE_ROUTE_UNAVAILABLE', 'Select an unambiguous native DSH provider and model.')
    const match = matches[0]!
    const reasoningEffort = effort ?? (model === undefined && match.provider === catalog.default?.provider ? catalog.default?.reasoningEffort : undefined)
    if (reasoningEffort && !match.item.reasoning?.efforts?.some(item => item.id === reasoningEffort)) throw teamError('TEAM_MODEL_UNSUPPORTED', 'The requested native effort is unavailable.')
    return { provider: match.provider, model: match.item.id, ...(reasoningEffort ? { reasoningEffort } : {}) }
  }

  resolveAgent(sessionId: string): TeamAgent | undefined {
    if (this.signal.aborted || sessionId.trim() === '') return undefined
    const direct = this.agents.get(sessionId)
    if (isAgent(direct) && this.isCurrent(direct) && sessionIdOf(direct) === sessionId) return direct
    return this.agents.list().find((candidate): candidate is TeamAgent => isAgent(candidate)
      && this.isCurrent(candidate) && sessionIdOf(candidate) === sessionId)
  }

  identity(agent: TeamAgent): CodingNsTeamIdentity {
    this.signal.throwIfAborted()
    if (!this.isCurrent(agent)) throw teamError('TEAM_CALLER_UNAVAILABLE', 'The calling Agent is no longer live.')
    const member = this.service.membership(agent) as { id?: unknown; role?: unknown; name?: unknown }
    if ((member?.role !== 'lead' && member?.role !== 'teammate') || typeof member.id !== 'string' || typeof member.name !== 'string') {
      throw teamError('TEAM_NOT_MEMBER', 'The calling Agent is not a native Team member.')
    }
    return { sessionId: sessionIdOf(agent), teamId: member.id, role: member.role, name: member.name }
  }

  invoke(agent: TeamAgent, action: CodingNsTeamAction, input: Record<string, unknown>, signal?: AbortSignal): unknown {
    const identity = this.identity(agent)
    if ((action === 'spawn' || action === 'interrupt' || action === 'task_update' && input.action === 'reassign') && identity.role !== 'lead') {
      throw teamError('TEAM_LEAD_REQUIRED', 'Only the Team Lead may perform this operation.')
    }
    const combined = signal ? AbortSignal.any([signal, this.signal]) : this.signal
    combined.throwIfAborted()
    switch (action) {
      case 'status': return { identity, supportsLead: this.supportsLead }
      case 'members': return this.service.listMembers(agent)
      case 'message': return this.service.sendMessage(agent, { ...input, signal: combined })
      case 'tasks': return this.service.listTasks(agent)
      case 'task': return this.service.getTask(agent, String(input.taskId))
      case 'task_create': return this.service.createTask(agent, input)
      case 'task_update': return this.service.updateTask(agent, input)
      case 'wait': return this.service.waitForChange(agent, Number(input.timeoutMs), combined)
      case 'spawn':
        if (!this.service.spawnTeammate) throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Teammate creation is unavailable.')
        return this.service.spawnTeammate(agent, { ...input, signal: combined })
      case 'interrupt':
        if (!this.service.interrupt) throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Team interruption is unavailable.')
        return this.service.interrupt(agent, String(input.target))
    }
  }

  dispose(): void { this.lifetime.abort(teamError('TEAM_SERVICE_UNAVAILABLE', 'The native Team service was removed.')) }

  private isCurrent(agent: TeamAgent): boolean { return this.agents.get(agent.id) === agent }
}

export function sessionIdOf(agent: TeamAgent): string { return agent.session?.header?.id?.trim() || agent.id }

export function teamError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }) }

function isAgent(value: unknown): value is TeamAgent { return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'id') === 'string' }
function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && methods.every(method => typeof Reflect.get(value, method) === 'function')
}
function read(context: unknown, name: string): unknown {
  if (typeof context !== 'object' || context === null) return undefined
  try {
    const get = Reflect.get(context, 'get')
    return typeof get === 'function' ? get.call(context, name) : Reflect.get(context, name)
  } catch { return undefined }
}
