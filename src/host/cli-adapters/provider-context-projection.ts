import { z } from 'zod'
import { ANTIGRAVITY_CONTEXT_PROJECTION, ZCODE_CONTEXT_PROJECTION } from '../../shared/request-performance.js'
import { fromCliProviderId } from '../../shared/cli-provider-route.js'

const pressureSchema = z.object({
  contextWindow: z.number().int().positive().optional(),
  pressureTokens: z.number().int().nonnegative().optional(),
}).strict()
const stateSchema = pressureSchema.extend({ model: z.string().optional() })
type State = z.infer<typeof stateSchema>

/** Replays both existing durable usage and live observations, never billing totals. */
function createProviderContextProjection(key: string, adapterId: 'antigravity' | 'zcode') {
  return {
    key, stateVersion: 1, stateSchema,
    init: (): State => ({}),
    apply(state: State, event: { type: string; data: any }): State {
      if (event.type === 'request/context') {
        if (fromCliProviderId(event.data.provider) !== adapterId) return {}
        const model = event.data.model
        if (typeof model === 'string' && model !== state.model) {
          const parsed = pressureSchema.safeParse({ contextWindow: event.data.contextWindow })
          return { model, ...(parsed.success ? parsed.data : {}) }
        }
        return state
      }
      if (event.type !== 'assistant/attempt' || !Array.isArray(event.data.stream)) return state
      if (adapterId === 'antigravity' && state.model === undefined) return state
      for (const item of event.data.stream) {
        if (item?.type !== 'chunk' || item.chunk?.type !== 'usage') continue
        const usage = item.chunk.codingnsContextObservation ?? item.chunk.usage
        if (!usage) continue
        const parsed = pressureSchema.safeParse({ contextWindow: usage.contextWindow, pressureTokens: usage.contextTokens })
        if (parsed.success) state = {
          ...state,
          ...(parsed.data.contextWindow === undefined ? {} : { contextWindow: parsed.data.contextWindow }),
          ...(parsed.data.pressureTokens === undefined ? {} : { pressureTokens: parsed.data.pressureTokens }),
        }
      }
      return state
    },
    wire: { viewSchema: pressureSchema, view: ({ model: _model, ...pressure }: State) => pressure },
  }
}

export const zcodeContextProjection = createProviderContextProjection(ZCODE_CONTEXT_PROJECTION, 'zcode')
export const antigravityContextProjection = createProviderContextProjection(ANTIGRAVITY_CONTEXT_PROJECTION, 'antigravity')
