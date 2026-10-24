import { z } from 'zod'

export const requestPerformanceSchema = z.object({
  id: z.string().min(1),
  startedAt: z.number().finite().nonnegative(),
  firstTokenAt: z.number().finite().nonnegative(),
  completedAt: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
}).refine(sample => sample.startedAt <= sample.firstTokenAt && sample.firstTokenAt < sample.completedAt)

const totalsSchema = z.object({
  turns: z.number().int().nonnegative(), steps: z.number().int().nonnegative(),
  llmMs: z.number().nonnegative(), toolMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(), ttftSteps: z.number().int().nonnegative(),
  decodeMs: z.number().nonnegative(), decodeTokens: z.number().nonnegative(),
}).strict()

const stateSchema = totalsSchema.extend({
  lastTurn: z.number().nullable(), lastRequestId: z.string().nullable(),
  pendingCalls: z.record(z.string(), z.number()),
})

type State = z.infer<typeof stateSchema>
export interface RequestPerformanceEvent { readonly type: string; readonly time: number; readonly data: any }

export interface SessionTurnStepCounts {
  readonly turns: number
  readonly steps: number
}

/** Count completed steps and the turns represented by their turn values. */
export function countSessionTurnSteps(events: readonly unknown[]): SessionTurnStepCounts {
  let turns = 0
  let steps = 0
  let hasTurn = false
  let lastTurn: unknown
  for (const candidate of events) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue
    const event = candidate as { readonly type?: unknown; readonly data?: unknown }
    if (event.type !== 'step/end') continue
    steps += 1
    const data = typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)
      ? event.data as Record<string, unknown>
      : undefined
    const turn = data?.turn
    if (!hasTurn || lastTurn !== turn) {
      turns += 1
      lastTurn = turn
      hasTurn = true
    }
  }
  return { turns, steps }
}

/** Fold source request measurements, independently of translated messages and synthetic tool declarations. */
export function createSessionPerformanceProjection(key: string, read: (chunk: any) => { id: unknown; samples: readonly unknown[] } | undefined) {
  return {
    key,
    stateVersion: 1,
    stateSchema,
    init: (): State => ({
      turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0,
      decodeMs: 0, decodeTokens: 0, lastTurn: null, lastRequestId: null, pendingCalls: {},
    }),
    apply(state: State, event: RequestPerformanceEvent): State {
      const data = event.data
      if (event.type === 'assistant/attempt' && Array.isArray(data.stream)) {
        for (const record of data.stream) {
          if (record?.type !== 'chunk' || record.chunk?.type !== 'usage') continue
          const batch = read(record.chunk)
          if (typeof batch?.id !== 'string' || batch.id === '' || batch.id === state.lastRequestId) continue
          for (const value of batch.samples) {
            const parsed = requestPerformanceSchema.safeParse(value)
            if (!parsed.success) continue
            const sample = parsed.data
            state = {
              ...state, lastRequestId: batch.id,
              llmMs: state.llmMs + sample.completedAt - sample.startedAt,
              ttftMs: state.ttftMs + sample.firstTokenAt - sample.startedAt,
              ttftSteps: state.ttftSteps + 1,
              decodeMs: state.decodeMs + sample.completedAt - sample.firstTokenAt,
              decodeTokens: state.decodeTokens + sample.outputTokens,
            }
          }
        }
        return state
      }
      if (event.type === 'step/end') return {
        ...state, steps: state.steps + 1,
        turns: state.turns + (state.lastTurn === data.turn ? 0 : 1), lastTurn: data.turn,
      }
      if (event.type === 'tool/call') return { ...state, pendingCalls: { ...state.pendingCalls, [data.callId]: event.time } }
      if (event.type === 'tool/result') {
        const id = data.message?.source?.callId
        if (typeof id !== 'string' || !Object.hasOwn(state.pendingCalls, id)) return state
        const startedAt = state.pendingCalls[id]
        if (startedAt === undefined) return state
        const pendingCalls = { ...state.pendingCalls }
        delete pendingCalls[id]
        return { ...state, pendingCalls, toolMs: state.toolMs + Math.max(0, event.time - startedAt) }
      }
      if (event.type === 'turn/end') return { ...state, pendingCalls: {} }
      return state
    },
    wire: {
      viewSchema: totalsSchema,
      view: ({ lastTurn: _turn, lastRequestId: _request, pendingCalls: _calls, ...totals }: State) => totals,
    },
  }
}
