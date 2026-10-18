import type { CodingNsCliAdapterDescriptor } from '../../shared/contracts/cli-adapter.js'

export interface TeamAdapterSupport {
  readonly member: boolean
  readonly lead: boolean
  readonly transport?: 'mcp' | 'acp' | 'mod' | 'rpc'
  readonly reason?: string
}

export function withTeamSupport(catalog: readonly CodingNsCliAdapterDescriptor[], hostReason?: NonNullable<CodingNsCliAdapterDescriptor['team']>['reason'], supportsLead = true): CodingNsCliAdapterDescriptor[] {
  return catalog.map(adapter => {
    const support = teamAdapterSupport(adapter.id)
    const reason = hostReason ?? (!support.member ? 'adapter' : !adapter.installed ? 'installation' : !adapter.enabled ? 'disabled' : undefined)
    return { ...adapter, team: reason ? { member: false, lead: false, reason } : { member: support.member, lead: support.lead && supportsLead } }
  })
}

/** Eligibility is limited to transports that carry the session-bound Team tool. */
export function teamAdapterSupport(adapterId: string): TeamAdapterSupport {
  switch (adapterId) {
    case 'dsh': return { member: true, lead: true }
    case 'codex': case 'claude-code': case 'opencode': return { member: true, lead: true, transport: 'mcp' }
    case 'command-code': return { member: true, lead: true, transport: 'mod' }
    case 'gemini': case 'grok': case 'mcode': return { member: true, lead: true, transport: 'acp' }
    case 'pi': return { member: true, lead: true, transport: 'rpc' }
    default: return { member: false, lead: false, reason: 'TEAM_ADAPTER_UNSUPPORTED' }
  }
}
