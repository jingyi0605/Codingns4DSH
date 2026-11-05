import { CLAUDE_PERFORMANCE_PROJECTION } from '../../shared/request-performance.js'
import { createSessionPerformanceProjection } from './session-performance-projection.js'

export const claudePerformanceProjection = createSessionPerformanceProjection(CLAUDE_PERFORMANCE_PROJECTION, chunk => {
  const batch = chunk.codingnsRequestPerformance
  return batch?.adapterId === 'claude-code' && Array.isArray(batch.samples) ? batch : undefined
})
