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
  /** Older batches without a source belong to Grok. */
  readonly adapterId?: 'claude-code' | 'grok'
  readonly samples: readonly RequestPerformance[]
}

export const CLAUDE_PERFORMANCE_PROJECTION = 'codingnsClaudeStats'
export const GROK_PERFORMANCE_PROJECTION = 'codingnsGrokStats'
export const GROK_CONTEXT_PROJECTION = 'codingnsGrokContext'
