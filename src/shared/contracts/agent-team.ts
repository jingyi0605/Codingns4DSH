/** Host-owned Team identities; external tool input never supplies these values. */
export interface CodingNsTeamIdentity {
  readonly sessionId: string
  readonly teamId: string
  readonly name: string
  readonly role: 'lead' | 'teammate'
}

export const TEAM_MEMBER_ACTIONS = ['status', 'members', 'message', 'tasks', 'task', 'task_create', 'task_update', 'wait'] as const
export const TEAM_LEAD_ACTIONS = [...TEAM_MEMBER_ACTIONS, 'spawn', 'interrupt'] as const
export type CodingNsTeamAction = typeof TEAM_LEAD_ACTIONS[number]

/** The same schema is used by native tools and injected MCP transports. */
export function teamToolSchema(role: CodingNsTeamIdentity['role'] = 'lead'): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...(role === 'lead' ? TEAM_LEAD_ACTIONS : TEAM_MEMBER_ACTIONS)] },
      name: { type: 'string' },
      description: { type: 'string' },
      prompt: { type: 'string' },
      agent: { type: 'string', description: 'Installed Team-capable adapter ID, or dsh for native execution.' },
      provider: { type: 'string', description: 'Optional provider for a native DSH child; required when model IDs are ambiguous.' },
      model: { type: 'string' },
      effort: { type: 'string' },
      context: { type: 'string', enum: ['fresh'] },
      target: { type: 'string', description: 'Native Team member name, including lead.' },
      message: { type: 'string' },
      taskId: { type: 'string' },
      subject: { type: 'string' },
      blockedBy: { type: 'array', items: { type: 'string' } },
      writeScopes: { type: 'array', items: { type: 'string' } },
      expectedRevision: { type: 'integer', minimum: 1 },
      taskAction: { type: 'string', enum: ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'] },
      owner: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 10_000, maximum: 240_000 },
    },
    required: ['action'],
    additionalProperties: false,
  }
}

export function teamGuidance(toolName: string, identity: CodingNsTeamIdentity): string {
  return [
    `You are ${identity.role === 'lead' ? 'the Team Lead' : 'a teammate'} named "${identity.name}" in a native DSH Team.`,
    `Use exactly ${toolName} for Team coordination; call action=status or members to read the current membership.`,
    'Create teammates only when the user explicitly asks to use Teams or teammates.',
    'Use message with a member name (lead addresses the Lead), and tasks/task/task_create/task_update for the shared native task board.',
    'Task updates require expectedRevision and taskAction. Read, claim, perform, then complete; stale revisions require a fresh read.',
    'Message success means inbox acceptance, not recipient processing. Inactive means no turn is executing, not task completion.',
    'A ready task does not wake its owner. Message required inactive members before waiting; wait observes changes and must be followed by a re-read.',
    'Members share a checkout; coordinate disjoint writeScopes, dependencies, and final verification. Write scopes are advisory, not locks.',
    identity.role === 'lead'
      ? 'Only the Lead can spawn or interrupt teammates and reassign tasks. Use agent/model/effort for supported child-specific selection; external history is fresh. Wait for required teammates before the final answer.'
      : 'Report through message with target=lead. Do not spawn nested agents, use ordinary subagent tools, or impersonate the Lead.',
    'Do not use provider-owned agent teams or guess another CodingNS namespace. Keep task completion distinct from a turn ending.',
  ].join(' ')
}
