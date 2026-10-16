export interface SessionPerformanceAdapter {
  install(definition: unknown): () => void
}

export function supportsSessionPerformance(context: unknown): boolean {
  return typeof projections(context)?.register === 'function'
}

function projections(context: unknown): { register(definition: unknown): () => void } | undefined {
  try {
    const owner = context as { get?: (name: string) => any; sessionProjections?: any }
    return typeof owner?.get === 'function' ? owner.get('sessionProjections') : owner?.sessionProjections
  } catch { return undefined }
}

/** Registration owns schema admission, cold replay, checkpoints, and live projection delivery. */
export function createSessionPerformanceAdapter(context: unknown): SessionPerformanceAdapter {
  const service = projections(context)!
  return { install: definition => service.register(definition) }
}
