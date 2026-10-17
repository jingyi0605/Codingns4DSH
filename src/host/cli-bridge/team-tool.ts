import { teamToolSchema } from '../../shared/contracts/agent-team.js'
import type { TeamAgent } from '../../dsh-capabilities/host/agent-team-adapter.js'
import { sessionIdOf } from '../../dsh-capabilities/host/agent-team-adapter.js'
import type { CodingNsTeamDispatcher } from './team-dispatch.js'

export function createAgentTeamTool(dispatcher: CodingNsTeamDispatcher): Record<string, unknown> {
  return {
    name: 'agent_team',
    description: 'Coordinate native DSH Teams with external teammates. Create teammates only when explicitly requested by the user. Only the native Lead can spawn, interrupt, or reassign. Message success is inbox acceptance; tasks require revision checks.',
    parameters: teamToolSchema(),
    output: { schema: { type: 'object' }, render: (_args: unknown, result: unknown) => [{ type: 'text', text: JSON.stringify(result) }] },
    timeoutMs: 260_000,
    isConcurrencySafe: () => true,
    async execute(input: unknown, exec: { readonly agent?: TeamAgent; readonly signal?: AbortSignal }) {
      if (!exec.agent) return { ok: false, code: 'TEAM_CALLER_UNAVAILABLE', error: 'A live native Agent is required.' }
      return dispatcher.dispatch(sessionIdOf(exec.agent), input, exec.signal, exec.agent)
    },
  }
}
