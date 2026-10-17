import { TEAM_LEAD_ACTIONS, type CodingNsTeamAction, type CodingNsTeamIdentity } from '../../shared/contracts/agent-team.js'
import type { CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'
import { type DshAgentTeamAdapter, type TeamAgent, sessionIdOf, teamError } from '../../dsh-capabilities/host/agent-team-adapter.js'
import type { CodingNsCliAdapterRegistry } from '../cli-adapters/registry.js'
import { getNativeSubagents } from '../cli-adapters/native-subagent-holder.js'
import { enqueueTeamSubagentSelection, externalTeamProvider } from '../cli-adapters/native-team-subagent.js'
import { teamAdapterSupport } from './team-adapters.js'
import type { TeamSessionAccess } from './bridge-holder.js'

export interface TeamBridgeResult {
  readonly ok: boolean
  readonly action?: CodingNsTeamAction
  readonly result?: unknown
  readonly code?: string
  readonly error?: string
}

export class CodingNsTeamDispatcher {
  private readonly nativeCreations = new Map<string, { name: string; route: { provider: string; model: string; reasoningEffort?: string } }>()

  constructor(private readonly options: {
    readonly adapter: () => DshAgentTeamAdapter | undefined
    readonly registry: CodingNsCliAdapterRegistry
    readonly enabled: () => boolean
  }) {}

  identity(sessionId: string): CodingNsTeamIdentity | undefined {
    if (!this.options.enabled()) return undefined
    const adapter = this.options.adapter()
    const agent = adapter?.resolveAgent(sessionId)
    if (!adapter || !agent) return undefined
    try {
      const identity = adapter.identity(agent)
      const config = this.options.registry.getSession(sessionId)
      if (config.adapterId === 'mcode' && config.effortId && config.effortId !== 'default') return undefined
      const support = teamAdapterSupport(config.adapterId)
      return (identity.role === 'lead' ? support.lead && adapter.supportsLead : support.member) ? identity : undefined
    } catch { return undefined }
  }

  access(sessionId: string): TeamSessionAccess | undefined {
    const identity = this.identity(sessionId)
    const adapter = this.options.adapter()
    const caller = adapter?.resolveAgent(sessionId)
    return identity && adapter && caller ? { identity, caller, signal: adapter.signal } : undefined
  }

  /** Runs during Agent publication, before a native child can inherit an external route. */
  initializeNativeChild(agent: TeamAgent): void {
    const adapter = this.options.adapter()
    if (!adapter) return
    let identity: CodingNsTeamIdentity
    try { identity = adapter.identity(agent) } catch { return }
    const pending = this.nativeCreations.get(identity.teamId)
    if (!pending || identity.role !== 'teammate' || pending.name !== identity.name) return
    this.options.registry.setSession(sessionIdOf(agent), {
      adapterId: 'dsh', providerId: pending.route.provider, modelId: pending.route.model,
      ...(pending.route.reasoningEffort ? { effortId: pending.route.reasoningEffort } : {}),
      origin: 'subagent', parentSessionId: identity.teamId, teamId: identity.teamId, teamMemberId: agent.id,
    }, { rememberPreference: false, inheritSelection: false })
  }

  async dispatch(sessionId: string, raw: unknown, signal?: AbortSignal, nativeCaller?: TeamAgent): Promise<TeamBridgeResult> {
    try {
      if (!this.options.enabled()) throw teamError('TEAM_BRIDGE_DISABLED', 'The CodingNS bridge is disabled.')
      const adapter = this.options.adapter()
      if (!adapter) throw teamError('TEAM_SERVICE_UNAVAILABLE', 'External Teams require DSH alpha.2/alpha.3 and the native Team profile.')
      const agent = adapter.resolveAgent(sessionId)
      if (!agent || nativeCaller !== undefined && nativeCaller !== agent) throw teamError('TEAM_CALLER_UNAVAILABLE', 'The exact calling Agent is unavailable.')
      const identity = adapter.identity(agent)
      const config = this.options.registry.getSession(sessionId)
      const boundAdapter = config.adapterId
      if (boundAdapter === 'mcode' && config.effortId && config.effortId !== 'default') throw teamError('TEAM_EFFORT_UNSUPPORTED', 'MiniMax Team sessions require the default ACP effort.')
      const support = teamAdapterSupport(boundAdapter)
      if (!(identity.role === 'lead' ? support.lead && adapter.supportsLead : support.member)) {
        throw teamError('TEAM_ADAPTER_UNSUPPORTED', 'This adapter does not provide the required Team role transport.')
      }
      const input = validateTeamInput(raw)
      const action = input.action as CodingNsTeamAction
      if ((action === 'spawn' || action === 'interrupt') && identity.role !== 'lead') throw teamError('TEAM_LEAD_REQUIRED', 'Only the Team Lead may perform this operation.')
      const combined = signal ? AbortSignal.any([signal, adapter.signal]) : adapter.signal
      combined.throwIfAborted()
      if (action === 'spawn') return { ok: true, action, result: await this.spawn(adapter, agent, identity, input, combined) }
      if (action === 'status') {
        const adapters = (await this.options.registry.catalog()).map(item => ({ id: item.id, installed: item.installed, enabled: item.enabled, ...teamAdapterSupport(item.id) }))
        return { ok: true, action, result: { identity, adapters } }
      }
      const payload: Record<string, unknown> = {}
      if (action === 'message') Object.assign(payload, { target: requiredText(input, 'target', 64), content: [{ type: 'text', text: requiredText(input, 'message', 60_000) }] })
      if (action === 'interrupt') payload.target = requiredText(input, 'target', 64)
      if (action === 'task' || action === 'task_update') payload.taskId = requiredText(input, 'taskId', 128)
      if (action === 'task_create') Object.assign(payload, { subject: requiredText(input, 'subject', 500), description: requiredText(input, 'description', 20_000) })
      for (const key of ['subject', 'description', 'owner', 'blockedBy', 'writeScopes']) if (input[key] !== undefined) payload[key] = input[key]
      if (action === 'task_update') {
        if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) throw teamError('TEAM_INVALID_INPUT', 'expectedRevision must be a positive integer.')
        const taskAction = requiredText(input, 'taskAction', 32)
        if (!['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'].includes(taskAction)) throw teamError('TEAM_INVALID_INPUT', 'Unknown task action.')
        Object.assign(payload, { expectedRevision: input.expectedRevision, action: taskAction })
      }
      if (action === 'wait') {
        const timeout = input.timeout_ms ?? 30_000
        if (!Number.isSafeInteger(timeout) || Number(timeout) < 10_000 || Number(timeout) > 240_000) throw teamError('TEAM_INVALID_INPUT', 'Wait must be between 10 and 240 seconds.')
        const members = adapter.invoke(agent, 'members', {}, combined)
        if (Array.isArray(members) && !members.some(member => member?.id !== agent.id && ['running', 'provisioning'].includes(member?.status))) {
          return { ok: true, action, result: { timedOut: false, noProgress: true } }
        }
        payload.timeoutMs = timeout
      }
      const result = await adapter.invoke(agent, action, payload, combined)
      return { ok: true, action, result }
    } catch (error) {
      return { ok: false, code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'TEAM_OPERATION_FAILED', error: error instanceof Error ? error.message : 'Team operation failed.' }
    }
  }

  private async spawn(adapter: DshAgentTeamAdapter, agent: TeamAgent, identity: CodingNsTeamIdentity, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const adapterId = requiredText(input, 'agent', 64)
    const name = requiredText(input, 'name', 64)
    const prompt = requiredText(input, 'prompt', 60_000)
    const description = requiredText(input, 'description', 200)
    if (input.context !== undefined && input.context !== 'fresh') throw teamError('TEAM_FORK_UNSUPPORTED', 'External Team children require fresh history.')
    if (!teamAdapterSupport(adapterId).member) throw teamError('TEAM_ADAPTER_UNSUPPORTED', 'This adapter has no verified Team tool transport.')
    const modelId = optionalText(input, 'model')
    const effortId = optionalText(input, 'effort')
    if (adapterId === 'mcode' && effortId && effortId !== 'default') throw teamError('TEAM_EFFORT_UNSUPPORTED', 'MiniMax Team sessions require the default ACP effort.')
    const provider = externalTeamProvider(adapterId)
    const native = getNativeSubagents()
    if (!native || native.getProvider?.(provider) === undefined && native.getProvider !== undefined) throw teamError('TEAM_PROVIDER_UNAVAILABLE', 'The requested continuable provider is not registered.')
    let nativeRoute: { provider: string; model: string; reasoningEffort?: string } | undefined
    if (adapterId === 'dsh') {
      nativeRoute = await adapter.nativeRoute(modelId, effortId, optionalText(input, 'provider'))
    } else {
      const descriptor = (await this.options.registry.catalogForUse([adapterId])).find(item => item.id === adapterId)
      if (!descriptor?.installed || !descriptor.enabled) throw teamError('TEAM_ADAPTER_UNAVAILABLE', 'The requested adapter is not installed and enabled.')
      if (input.provider !== undefined) throw teamError('TEAM_INVALID_INPUT', 'provider is only supported for native DSH children.')
      if (modelId || effortId && effortId !== 'default') validateSelection(await this.options.registry.models(adapterId), modelId, effortId === 'default' ? undefined : effortId)
    }
    signal.throwIfAborted()
    return enqueueTeamSubagentSelection(identity.sessionId, adapterId, modelId, async () => {
      if (nativeRoute) this.nativeCreations.set(identity.teamId, { name, route: nativeRoute })
      try {
        const result = await adapter.invoke(agent, 'spawn', { name, description, prompt: [{ type: 'text', text: prompt }], context: 'fresh', provider }, signal)
        this.options.registry.setSession(identity.sessionId, {
          ...this.options.registry.getSession(identity.sessionId), teamId: identity.teamId, teamMemberId: agent.id,
        }, { rememberPreference: false })
        await this.options.registry.flushSessionBindings()
        return result
      } finally { if (nativeRoute) this.nativeCreations.delete(identity.teamId) }
    }, { ...(effortId ? { effortId } : {}), teamId: identity.teamId })
  }
}

const FIELDS = new Set(['action', 'name', 'description', 'prompt', 'agent', 'provider', 'model', 'effort', 'context', 'target', 'message', 'taskId', 'subject', 'blockedBy', 'writeScopes', 'expectedRevision', 'taskAction', 'owner', 'timeout_ms'])
export function validateTeamInput(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw teamError('TEAM_INVALID_INPUT', 'Team input must be an object.')
  const input = raw as Record<string, unknown>
  if (Object.keys(input).some(key => !FIELDS.has(key))) throw teamError('TEAM_INVALID_INPUT', 'Unknown Team input field; caller identity cannot be supplied.')
  if (!TEAM_LEAD_ACTIONS.includes(input.action as CodingNsTeamAction)) throw teamError('TEAM_INVALID_INPUT', 'Unknown Team action.')
  for (const [key, value] of Object.entries(input)) {
    if (key === 'expectedRevision' || key === 'timeout_ms') continue
    if (key === 'blockedBy' || key === 'writeScopes') {
      if (!Array.isArray(value) || value.length > 256 || value.some(item => typeof item !== 'string' || item.length > 4096)) throw teamError('TEAM_INVALID_INPUT', `Invalid ${key}.`)
    } else if (typeof value !== 'string' || value.length > 60_000) throw teamError('TEAM_INVALID_INPUT', `Invalid ${key}.`)
  }
  return input
}

function requiredText(input: Record<string, unknown>, key: string, max: number): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw teamError('TEAM_INVALID_INPUT', `${key} must be nonempty and at most ${max} characters.`)
  return value.trim()
}
function optionalText(input: Record<string, unknown>, key: string): string | undefined { return input[key] === undefined ? undefined : requiredText(input, key, 500) }
function validateSelection(catalog: CodingNsCliModelCatalog, modelId?: string, effortId?: string): void {
  const model = catalog.groups.flatMap(group => group.models).find(item => item.id === (modelId ?? catalog.currentModel))
  if (!model || effortId !== undefined && !model.efforts.includes(effortId)) throw teamError('TEAM_MODEL_UNSUPPORTED', 'The requested child model or effort is unavailable.')
}
