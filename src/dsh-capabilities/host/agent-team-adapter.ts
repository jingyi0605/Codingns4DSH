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
  membership?(agent: unknown): unknown
  listMembers?(agent: unknown): unknown
  isEnabled?(agent: unknown): boolean
  sendMessage?(agent: unknown, request: Record<string, unknown>): unknown
  listTasks?(agent: unknown): unknown
  getTask?(agent: unknown, id: string): unknown
  createTask?(agent: unknown, request: Record<string, unknown>, signal?: AbortSignal): unknown
  updateTask?(agent: unknown, request: Record<string, unknown>, signal?: AbortSignal): unknown
  waitForChange?(agent: unknown, timeoutMs: number, signal: AbortSignal): unknown
  spawnTeammate?(agent: unknown, request: Record<string, unknown>): unknown
  interrupt?(agent: unknown, target: string): unknown
}

export interface NativeSubagentTeamService {
  namesOf?(agent: unknown): { readonly self: string; readonly parent?: string }
  rootOf?(agent: unknown): unknown
  resolveName?(agent: unknown, name: string, signal: AbortSignal): Promise<string>
  sendMessage?(agent: unknown, targetId: string, content: readonly { readonly type: 'text'; readonly text: string }[], options: { readonly signal: AbortSignal }): Promise<string>
  startActivation?(spec: Record<string, unknown>): Promise<Record<string, unknown>>
  interrupt?(targetId: string, authority: Record<string, unknown>): void
  listDescendants?(rootSessionId: string, signal?: AbortSignal): Promise<readonly unknown[]>
  waitForTreeWork?(root: unknown): Promise<boolean>
}

const LEGACY_MEMBER_METHODS = ['membership', 'listMembers', 'sendMessage', 'listTasks', 'getTask', 'createTask', 'updateTask', 'waitForChange']
const RC2_TASK_METHODS = ['isEnabled', 'listTasks', 'getTask', 'createTask', 'updateTask']

export function supportsNativeAgentTeam(context: unknown): boolean {
  const service = read(context, 'agentTeams')
  const subagents = read(context, 'subagents')
  const legacy = hasMethods(service, ['listMembers', 'spawnTeammate'])
  const modern = hasMethods(service, RC2_TASK_METHODS) && hasMethods(subagents, ['namesOf', 'rootOf', 'listDescendants', 'startActivation'])
  return (legacy || modern) && hasMethods(read(context, 'agents'), ['get', 'list'])
}

export function supportsExternalAgentTeam(context: unknown, lead = false): boolean {
  const service = read(context, 'agentTeams') as NativeAgentTeamService | undefined
  const subagents = read(context, 'subagents') as NativeSubagentTeamService | undefined
  const legacy = hasMethods(service, LEGACY_MEMBER_METHODS)
  const tasks = legacy || hasMethods(service, RC2_TASK_METHODS)
  const identities = hasMethods(subagents, ['namesOf', 'rootOf', 'resolveName', 'sendMessage', 'listDescendants'])
  const spawning = hasMethods(service, ['spawnTeammate']) || hasMethods(subagents, ['startActivation'])
  const legacyReady = legacy && hasMethods(subagents, ['registerProvider', 'startActivation', 'sendMessage'])
  const modernReady = tasks && identities && hasMethods(subagents, ['registerProvider', 'startActivation', 'sendMessage'])
  const leadReady = legacy ? hasMethods(service, ['spawnTeammate', 'interrupt']) : spawning
  return (legacyReady || modernReady) && (!lead || leadReady)
    && hasMethods(read(context, 'agents'), ['get', 'list'])
}

export function createAgentTeamAdapter(context: unknown): DshAgentTeamAdapter {
  return new DshAgentTeamAdapter(
    read(context, 'agentTeams') as NativeAgentTeamService,
    read(context, 'agents') as TeamAgentRegistry,
    () => read(context, 'sessionController'),
    read(context, 'subagents') as NativeSubagentTeamService,
  )
}

/** Exact Agent identity and all DSH-specific calls stay at this boundary. */
export class DshAgentTeamAdapter {
  private readonly lifetime = new AbortController()
  readonly supportsLead: boolean
  readonly supportsInterrupt: boolean

  constructor(
    private readonly service: NativeAgentTeamService,
    private readonly agents: TeamAgentRegistry,
    private readonly controller?: unknown,
    private readonly subagents?: NativeSubagentTeamService,
  ) {
    this.supportsLead = hasMethods(service, ['spawnTeammate']) || hasMethods(subagents, ['startActivation'])
    // rc.2 keeps the SubAgent interrupt method available for trusted hosts but
    // disables the public Team interruption tool by default. Legacy TeamService
    // instances advertise interruption only when their own method is present.
    this.supportsInterrupt = hasMethods(service, ['interrupt'])
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
    if (typeof this.service.isEnabled === 'function' && typeof this.service.membership !== 'function' && !this.service.isEnabled(agent)) {
      throw teamError('TEAM_BRIDGE_DISABLED', 'Team collaboration is disabled for this session.')
    }
    if (typeof this.service.membership === 'function') {
      const member = this.service.membership(agent) as { id?: unknown; role?: unknown; name?: unknown }
      if ((member?.role !== 'lead' && member?.role !== 'teammate') || typeof member.id !== 'string' || typeof member.name !== 'string') {
        throw teamError('TEAM_NOT_MEMBER', 'The calling Agent is not a native Team member.')
      }
      return { sessionId: sessionIdOf(agent), teamId: member.id, role: member.role, name: member.name }
    }
    const names = this.subagents?.namesOf?.(agent)
    const root = this.subagents?.rootOf?.(agent)
    if (!names || root === undefined) throw teamError('TEAM_NOT_MEMBER', 'The calling Agent is not a native Team member.')
    return {
      sessionId: sessionIdOf(agent),
      teamId: sessionIdOf(root as TeamAgent),
      role: names.parent === undefined ? 'lead' : 'teammate',
      name: names.self,
    }
  }

  async invoke(agent: TeamAgent, action: CodingNsTeamAction, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const identity = this.identity(agent)
    if ((action === 'spawn' || action === 'interrupt' || action === 'task_update' && input.action === 'reassign') && identity.role !== 'lead') {
      throw teamError('TEAM_LEAD_REQUIRED', 'Only the Team Lead may perform this operation.')
    }
    const combined = signal ? AbortSignal.any([signal, this.signal]) : this.signal
    combined.throwIfAborted()
    switch (action) {
      case 'status': return { identity, supportsLead: this.supportsLead, supportsInterrupt: this.supportsInterrupt }
      case 'members': return this.members(agent, combined)
      case 'message': return this.message(agent, input, combined)
      case 'tasks': return this.requiredServiceCall('listTasks', agent)
      case 'task': return this.requiredServiceCall('getTask', agent, String(input.taskId))
      case 'task_create': return this.createTask(agent, input, combined)
      case 'task_update': return this.updateTask(agent, input, combined)
      case 'wait': return this.wait(agent, Number(input.timeoutMs), combined)
      case 'spawn':
        if (typeof this.service.spawnTeammate === 'function') return this.service.spawnTeammate(agent, { ...input, signal: combined })
        if (typeof this.subagents?.startActivation !== 'function') throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Teammate creation is unavailable.')
        return this.subagents.startActivation({ ...input, parent: agent, label: String(input.description ?? ''), signal: combined, delivery: 'parent' })
      case 'interrupt':
        if (typeof this.service.interrupt === 'function') return this.service.interrupt(agent, String(input.target))
        if (typeof this.subagents?.interrupt !== 'function' || typeof this.subagents.resolveName !== 'function') {
          throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Team interruption is unavailable.')
        }
        return this.subagents.interrupt(
          await this.subagents.resolveName(agent, String(input.target), combined),
          { kind: 'ancestor', agent },
        )
    }
  }

  private members(agent: TeamAgent, signal: AbortSignal): unknown {
    if (typeof this.service.listMembers === 'function') return this.service.listMembers(agent)
    const subagents = this.subagents
    const root = subagents?.rootOf?.(agent)
    const list = subagents?.listDescendants
    if (root === undefined || typeof list !== 'function') throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Team membership is unavailable.')
    return list(sessionIdOf(root as TeamAgent), signal).then(entries => [
      { id: sessionIdOf(root as TeamAgent), name: 'lead', role: 'lead', status: 'inactive' },
      ...entries.filter(isChildEntry).map(entry => ({
        id: entry.id,
        name: entry.path ?? entry.name ?? entry.id,
        role: 'teammate',
        status: entry.activity,
        parentId: entry.parentId,
      })),
    ])
  }

  private message(agent: TeamAgent, input: Record<string, unknown>, signal: AbortSignal): unknown {
    if (typeof this.service.sendMessage === 'function') return this.service.sendMessage(agent, { ...input, signal })
    if (typeof this.subagents?.resolveName !== 'function' || typeof this.subagents.sendMessage !== 'function') {
      throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Team messaging is unavailable.')
    }
    const content = Array.isArray(input.content) ? input.content : [{ type: 'text', text: String(input.message ?? '') }]
    return this.subagents.resolveName(agent, String(input.target), signal).then(targetId =>
      this.subagents!.sendMessage!(agent, targetId, content as readonly { readonly type: 'text'; readonly text: string }[], { signal }))
  }

  private requiredServiceCall(method: keyof NativeAgentTeamService, agent: TeamAgent, ...args: unknown[]): unknown {
    const fn = this.service[method] as ((...args: unknown[]) => unknown) | undefined
    if (typeof fn !== 'function') throw teamError('TEAM_OPERATION_UNAVAILABLE', `Team ${String(method)} is unavailable.`)
    return fn.apply(this.service, [agent, ...args])
  }

  private updateTask(agent: TeamAgent, input: Record<string, unknown>, signal: AbortSignal): unknown {
    if (typeof this.service.updateTask !== 'function') throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Team task updates are unavailable.')
    if (typeof this.service.membership === 'function' || input.owner === undefined || typeof this.subagents?.resolveName !== 'function') {
      return this.service.updateTask(agent, input, signal)
    }
    return this.subagents.resolveName(agent, String(input.owner), signal).then(owner =>
      this.service.updateTask!(agent, { ...input, owner }, signal))
  }

  private createTask(agent: TeamAgent, input: Record<string, unknown>, signal: AbortSignal): unknown {
    if (typeof this.service.createTask !== 'function') throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Team task creation is unavailable.')
    return this.service.createTask(agent, input, signal)
  }

  private async wait(agent: TeamAgent, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    if (typeof this.service.waitForChange === 'function') return this.service.waitForChange(agent, timeoutMs, signal)
    const subagents = this.subagents
    const root = subagents?.rootOf?.(agent)
    const list = subagents?.listDescendants
    if (root === undefined || typeof list !== 'function') throw teamError('TEAM_OPERATION_UNAVAILABLE', 'Team waiting is unavailable.')
    const deadline = Date.now() + timeoutMs
    const initial = JSON.stringify(await this.snapshot(agent, signal))
    while (Date.now() < deadline) {
      await delay(Math.min(250, Math.max(1, deadline - Date.now())), signal)
      const current = JSON.stringify(await this.snapshot(agent, signal))
      if (current !== initial) return { timedOut: false, changed: true }
    }
    return { timedOut: true, changed: false }
  }

  private async snapshot(agent: TeamAgent, signal: AbortSignal): Promise<unknown> {
    const tasks = typeof this.service.listTasks === 'function' ? this.service.listTasks(agent) : undefined
    const members = await this.members(agent, signal)
    return { tasks, members }
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
function isChildEntry(value: unknown): value is { readonly id: string; readonly activity: string; readonly path?: string; readonly name?: string; readonly parentId: string } {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'kind') === 'child'
    && typeof Reflect.get(value, 'id') === 'string'
    && typeof Reflect.get(value, 'activity') === 'string'
}
function delay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(resolve, timeoutMs)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
function read(context: unknown, name: string): unknown {
  if (typeof context !== 'object' || context === null) return undefined
  try {
    const get = Reflect.get(context, 'get')
    return typeof get === 'function' ? get.call(context, name) : Reflect.get(context, name)
  } catch { return undefined }
}
