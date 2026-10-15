export interface SessionPromptAssembly {
  readonly sections: readonly { readonly name: string; readonly text: string; readonly [key: string]: unknown }[]
  readonly tools: readonly { readonly name: string; readonly description?: string; readonly parameters?: unknown; readonly [key: string]: unknown }[]
  readonly [key: string]: unknown
}

export interface SessionPromptScope {
  readonly sessionId: string
  readonly subagent: boolean
  readonly literals: readonly string[]
  readonly signal?: AbortSignal
}

export interface SessionPromptAdapter {
  install(transform: (assembly: SessionPromptAssembly, scope: SessionPromptScope) => Promise<SessionPromptAssembly>): () => void
}

type HostContext = { on(name: string, listener: (...args: any[]) => unknown, options: { global: boolean; prepend: boolean }): unknown; get?(name: string): unknown; systemPrompt?: unknown }

export function supportsSessionPromptAssembly(value: unknown): boolean {
  const ctx = value as HostContext | undefined
  const prompt = (ctx?.get?.('systemPrompt') ?? ctx?.systemPrompt) as { assemble?: unknown } | undefined
  return typeof ctx?.on === 'function' && typeof prompt?.assemble === 'function'
}

/** Keep DSH's agent identity and scope shape inside the versioned boundary. */
export function sessionPromptScope(agent: any, signal?: AbortSignal): SessionPromptScope {
  const header = agent?.session?.header
  return {
    sessionId: typeof agent?.id === 'string' ? agent.id : typeof header?.id === 'string' ? header.id : '',
    subagent: header?.origin === 'subagent' || header?.delegationDepth > 0 || agent?.options?.subagentDepth > 0,
    literals: [header?.cwd, agent?.cwd].filter((value): value is string => typeof value === 'string' && value !== ''),
    ...(signal === undefined ? {} : { signal }),
  }
}

export function createSessionPromptAdapter(value: unknown): SessionPromptAdapter {
  const ctx = value as HostContext
  return {
    install(transform) {
      const dispose = ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<SessionPromptAssembly>) => {
        const assembly = await next()
        const scope = sessionPromptScope(context?.agent, context?.signal)
        if (scope.sessionId === '' || scope.subagent || !Array.isArray(assembly?.sections) || !Array.isArray(assembly.tools)) return assembly
        return transform(assembly, scope)
      }, { global: true, prepend: true })
      return typeof dispose === 'function' ? dispose as () => void : () => undefined
    },
  }
}
