import { CODEX_PERFORMANCE_PROJECTION } from '../../shared/codex-performance.js'
import { createSessionPerformanceProjection } from './session-performance-projection.js'

export { requestPerformanceSchema as codexRequestPerformanceSchema } from './session-performance-projection.js'

export const codexPerformanceProjection = createSessionPerformanceProjection(CODEX_PERFORMANCE_PROJECTION, chunk => {
  const sample = chunk.codingnsCodexPerformance
  return sample === undefined ? undefined : { id: sample?.id, samples: [sample] }
})
