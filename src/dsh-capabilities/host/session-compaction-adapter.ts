/** DSH 0.2 command scoping and the Agent maintenance lock live at this boundary. */
interface CommandResult {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

interface CommandAgent {
  readonly id: string
  readonly ctx: CommandContext
  readonly session: { readonly header: { readonly cwd?: string } }
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>
}

interface CommandInvocation {
  readonly agent: CommandAgent
  readonly rawInput: string
  readonly signal: AbortSignal
}

interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

interface CommandService {
  find(agent: CommandAgent, name: string): CommandDefinition | undefined
  register(definition: CommandDefinition): () => void
}

interface CommandContext {
  get(name: string): unknown
  on(name: string, listener: (payload: { agent: CommandAgent }) => void, options: { global: true }): () => void
  inject(names: string[], apply: (scope: CommandContext) => void): { dispose(): unknown }
}

interface AgentRegistry { list(): readonly CommandAgent[] }

export interface SessionCompactionAdapter {
  install(options: {
    supports(sessionId: string): boolean
    compact(sessionId: string, cwd: string | undefined, signal: AbortSignal): Promise<CommandResult>
    error(kind: 'usage' | 'busy' | 'cancelled' | 'failed'): CommandResult
  }): () => Promise<void>
}

export function supportsSessionCompaction(context: unknown): boolean {
  const ctx = context as Partial<CommandContext> | undefined
  if (typeof ctx?.get !== 'function' || typeof ctx.on !== 'function') return false
  try {
    const commands = ctx.get('commands') as Partial<CommandService> | undefined
    const agents = ctx.get('agents') as Partial<AgentRegistry> | undefined
    return typeof commands?.find === 'function' && typeof commands.register === 'function' && typeof agents?.list === 'function'
  } catch { return false }
}

export function createSessionCompactionAdapter(context: unknown): SessionCompactionAdapter {
  const ctx = context as CommandContext
  const commands = ctx.get('commands') as CommandService
  const agents = ctx.get('agents') as AgentRegistry
  return {
    install(options) {
      const lifetime = new AbortController()
      const scopes = new Map<CommandAgent, { dispose(): unknown }>()
      const attaching = new Set<CommandAgent>()
      const active = new Set<Promise<CommandResult>>()
      const attach = (agent: CommandAgent): void => {
        if (lifetime.signal.aborted || scopes.has(agent) || attaching.has(agent)) return
        const native = commands.find(agent, 'compact')
        if (!native || typeof agent.ctx?.inject !== 'function' || typeof agent.runMaintenance !== 'function') return
        attaching.add(agent)
        try {
          const scope = agent.ctx.inject(['commands'], scope => {
            const scopedCommands = scope.get('commands') as CommandService
            scopedCommands.register({
              ...native,
              handler(invocation) {
                if (!options.supports(invocation.agent.id)) return native.handler(invocation)
                if (invocation.rawInput.trim() !== '') return options.error('usage')
                if (invocation.signal.aborted || lifetime.signal.aborted) return options.error('cancelled')
                let operation: Promise<CommandResult>
                try {
                  operation = invocation.agent.runMaintenance(async maintenanceSignal => {
                    const signal = AbortSignal.any([invocation.signal, maintenanceSignal, lifetime.signal])
                    try {
                      signal.throwIfAborted()
                      return await options.compact(invocation.agent.id, invocation.agent.session.header.cwd, signal)
                    } catch {
                      return options.error(signal.aborted ? 'cancelled' : 'failed')
                    }
                  })
                } catch {
                  return options.error('busy')
                }
                active.add(operation)
                void operation.then(() => active.delete(operation), () => active.delete(operation))
                return operation
              },
            })
          })
          scopes.set(agent, scope)
        } finally { attaching.delete(agent) }
      }
      const refresh = (): void => { for (const agent of agents.list()) attach(agent) }
      const removeCreated = ctx.on('agent/created', ({ agent }) => attach(agent), { global: true })
      const removeDisposed = ctx.on('agent/disposed', ({ agent }) => {
        void scopes.get(agent)?.dispose()
        scopes.delete(agent)
      }, { global: true })
      // The global command plugin can be mounted after this feature.
      const removeChanged = ctx.on('commands/change', refresh, { global: true })
      refresh()
      return async () => {
        lifetime.abort()
        removeCreated()
        removeDisposed()
        removeChanged()
        await Promise.allSettled(active)
        for (const scope of scopes.values()) await scope.dispose()
        scopes.clear()
      }
    },
  }
}
