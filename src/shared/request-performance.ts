/** A completed provider request, measured before translation and stream delivery. */
export interface RequestPerformance {
  readonly id: string
  readonly startedAt: number
  readonly firstTokenAt: number
  readonly completedAt: number
  readonly outputTokens: number
}

export interface RequestPerformanceBatch {
  readonly id: string
  readonly samples: readonly RequestPerformance[]
}

export const GROK_PERFORMANCE_PROJECTION = 'codingnsGrokStats'
export const GROK_CONTEXT_PROJECTION = 'codingnsGrokContext'
