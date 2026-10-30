import type { CredentialBroker } from './broker.js'

export function createCredentialBrokerTool(broker: CredentialBroker): Record<string, unknown> {
  return {
    name: 'codingns_credential',
    description: 'CodingNS session-scoped credential tool. When the user message contains @[Label](codingns-credential:<request-code>), extract the exact value inside codingns-credential: and pass that value as code; do not use the display label, the full carrier text, or any secret placeholder. Call describe with a request code to inspect bindings and receive a reusable handle. Call exec with that request code or handle and a command argv array to run the command with the bound values in its environment. For native DSH use action="exec", code="<request-code>", and command=[...]. SSH secret bindings automatically configure a temporary SSH_ASKPASS helper; use -o IdentityAgent=none -o IdentitiesOnly=yes -o PubkeyAuthentication=no to avoid unrelated SSH-agent identities. Never put secrets in command arguments or print credential values.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['describe', 'exec'] },
        code: { type: 'string' },
        handle: { type: 'string' },
        command: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, result: unknown) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: { readonly agent?: unknown }) {
      const sessionId = readSessionId(exec.agent)
      if (sessionId === '') throw new Error('Native credential tool is missing the session identity')
      const action = args.action === 'exec' ? 'exec' : 'describe'
      if (action === 'describe') {
        if (typeof args.code === 'string' && args.code.trim() !== '') return broker.describeRequest(sessionId, args.code)
        if (typeof args.handle === 'string' && args.handle.trim() !== '') return broker.describeHandle(sessionId, args.handle)
        throw new Error('Credential describe requires a request code or handle')
      }
      const command = Array.isArray(args.command)
        ? args.command.filter((item): item is string => typeof item === 'string')
        : []
      return broker.executeRequest({
        sessionId,
        ...(typeof args.code === 'string' && args.code.trim() !== '' ? { requestCode: args.code } : {}),
        ...(typeof args.handle === 'string' && args.handle.trim() !== '' ? { handle: args.handle } : {}),
        argv: command,
        ...(typeof args.cwd === 'string' && args.cwd.trim() !== '' ? { cwd: args.cwd } : {}),
      })
    },
  }
}

function readSessionId(agent: unknown): string {
  if (typeof agent !== 'object' || agent === null) return ''
  const value = agent as { readonly id?: unknown; readonly session?: { readonly header?: { readonly id?: unknown } } }
  const headerId = value.session?.header?.id
  return typeof headerId === 'string' ? headerId.trim() : typeof value.id === 'string' ? value.id.trim() : ''
}
