export interface WorkspacePendingQuestion {
  readonly callId: string
  readonly state: 'open' | 'continued'
  readonly questions: readonly {
    readonly id: string
    readonly question: string
    readonly detail?: string
    readonly header?: string
    readonly options?: readonly { readonly label: string; readonly description?: string }[]
    readonly multiSelect?: boolean
  }[]
}

export interface WorkspacePendingQuestionsAdapter {
  list(sessionId: string): readonly WorkspacePendingQuestion[] | null
  answer(sessionId: string, callId: string, answer: {
    readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
  }): boolean
}

interface SessionStoreLike { get(id: string): unknown }
interface AgentRegistryLike { get(id: string): unknown; roots?(): readonly unknown[] }
interface ProjectionRegistryLike { stateOf(session: unknown, key: 'userQuestions'): unknown }
interface UserQuestionsLike { answer(agent: unknown, callId: string, answer: unknown): boolean }

export function supportsWorkspacePendingQuestions(context: unknown): boolean {
  const get = contextGet(context)
  return hasMethod(get?.('sessions'), 'get')
    && hasMethod(get?.('agents'), 'get')
    && hasMethod(get?.('agents'), 'roots')
    && hasMethod(get?.('sessionProjections'), 'stateOf')
    && hasMethod(get?.('userQuestions'), 'answer')
}

export function createWorkspacePendingQuestionsAdapter(context: unknown): WorkspacePendingQuestionsAdapter {
  const get = contextGet(context)
  const sessions = get?.('sessions') as SessionStoreLike | undefined
  const agents = get?.('agents') as AgentRegistryLike | undefined
  const projections = get?.('sessionProjections') as ProjectionRegistryLike | undefined
  const questions = get?.('userQuestions') as UserQuestionsLike | undefined
  if (!supportsWorkspacePendingQuestions(context) || !sessions || !agents || !projections || !questions) {
    throw new TypeError('DSH pending questions capability is unavailable')
  }
  return {
    list(sessionId) {
      let session: unknown
      try { session = sessions.get(sessionId) } catch { return null }
      if (session === undefined) return null
      let agent: unknown
      try { agent = agents.get(sessionId) } catch { return null }
      if (agent === undefined || record(agent)?.session !== session || !(agents.roots?.() ?? []).includes(agent)) return null
      try {
        const state = record(projections.stateOf(session, 'userQuestions'))
        const userQuestions = record(state?.questions)
        let active: unknown
        try { active = userQuestions?.active } catch { return null }
        if (!Array.isArray(active)) return null
        return active.flatMap((raw) => {
          const pending = record(raw)
          if (typeof pending?.callId !== 'string' || (pending.state !== 'open' && pending.state !== 'continued') || !Array.isArray(pending.questions)) return []
          return [{ callId: pending.callId, state: pending.state, questions: pending.questions.filter(isQuestion) }]
        })
      } catch { return null }
    },
    answer(sessionId, callId, answer) {
      let agent: unknown
      try { agent = agents.get(sessionId) } catch { return false }
      let session: unknown
      try { session = sessions.get(sessionId) } catch { return false }
      if (agent === undefined || session === undefined || record(agent)?.session !== session
        || !(agents.roots?.() ?? []).includes(agent)) return false
      try { return questions.answer(agent, callId, answer) === true } catch { return false }
    },
  }
}

function contextGet(context: unknown): ((name: string) => unknown) | undefined {
  if (typeof context !== 'object' || context === null || typeof (context as { get?: unknown }).get !== 'function') return undefined
  return (context as { get(name: string): unknown }).get.bind(context)
}

function hasMethod(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[name] === 'function'
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isQuestion(value: unknown): value is WorkspacePendingQuestion['questions'][number] {
  const item = record(value)
  return typeof item?.id === 'string' && typeof item.question === 'string'
}
