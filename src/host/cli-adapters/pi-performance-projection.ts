import { PI_PERFORMANCE_PROJECTION } from '../../shared/request-performance.js'
import { createSessionPerformanceProjection } from './session-performance-projection.js'

export const piPerformanceProjection = createSessionPerformanceProjection(PI_PERFORMANCE_PROJECTION, chunk => {
  const batch = chunk.codingnsRequestPerformance
  return batch?.adapterId === 'pi' && Array.isArray(batch.samples) ? batch : undefined
})
