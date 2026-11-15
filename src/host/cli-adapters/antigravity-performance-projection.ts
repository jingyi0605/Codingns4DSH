import { ANTIGRAVITY_PERFORMANCE_PROJECTION } from '../../shared/request-performance.js'
import { createSessionPerformanceProjection } from './session-performance-projection.js'

export const antigravityPerformanceProjection = createSessionPerformanceProjection(ANTIGRAVITY_PERFORMANCE_PROJECTION, chunk => {
  const batch = chunk.codingnsRequestPerformance
  return batch?.adapterId === 'antigravity' && Array.isArray(batch.samples) ? batch : undefined
})
