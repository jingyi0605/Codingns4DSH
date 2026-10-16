import { z } from 'zod'
import { GROK_CONTEXT_PROJECTION, GROK_PERFORMANCE_PROJECTION } from '../../shared/request-performance.js'
import { createSessionPerformanceProjection } from './session-performance-projection.js'
import { fromCliProviderId } from '../../shared/cli-provider-route.js'

export const grokPerformanceProjection = createSessionPerformanceProjection(GROK_PERFORMANCE_PROJECTION, chunk => {
  const batch = chunk.codingnsRequestPerformance
  return Array.isArray(batch?.samples) ? batch : undefined
})

const pressureSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  pressureTokens: z.number().int().nonnegative().optional(),
}).strict()
const contextStateSchema = pressureSchema.extend({ model: z.string().optional() })
type ContextState = z.infer<typeof contextStateSchema>

/** Grok's current context is not the sum of the prompts billed during its tool loop. */
export const grokContextProjection = {
  key: GROK_CONTEXT_PROJECTION, stateVersion: 1, stateSchema: contextStateSchema,
  init: (): ContextState => ({}),
  apply(state: ContextState, event: { type: string; data: any }): ContextState {
    if (event.type === 'request/context') {
      if (event.data.provider !== 'grok' && fromCliProviderId(event.data.provider) !== 'grok') return {}
      // Step placeholders and the legacy meter's capacity anchor cannot replace
      // a live provider observation, including a resized window on the same model.
      return state
    }
    if (event.type !== 'assistant/attempt' || !Array.isArray(event.data.stream)) return state
    for (const record of event.data.stream) {
      if (record?.type !== 'chunk' || record.chunk?.type !== 'usage') continue
      const usage = record.chunk.codingnsContextObservation
      if (usage === undefined) continue
      if (typeof usage.contextModelId === 'string' && usage.contextModelId !== state.model) state = { model: usage.contextModelId }
      const parsed = pressureSchema.safeParse({ contextWindow: usage.contextWindow, pressureTokens: usage.contextTokens })
      if (parsed.success) state = {
        ...state,
        ...(parsed.data.contextWindow === undefined ? {} : { contextWindow: parsed.data.contextWindow }),
        ...(parsed.data.pressureTokens === undefined ? {} : { pressureTokens: parsed.data.pressureTokens }),
      }
    }
    return state
  },
  wire: { viewSchema: pressureSchema, view: ({ model: _model, ...pressure }: ContextState) => pressure },
}
