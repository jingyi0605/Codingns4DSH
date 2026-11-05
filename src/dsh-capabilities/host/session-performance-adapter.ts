export interface SessionPerformanceAdapter {
  install(definition: unknown): Promise<() => Promise<void>>
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
  return {
    async install(definition) {
      const registered = service.register(definition)
      if (typeof registered === 'function') {
        return async () => { registered() }
      }
      const handle = await registered as { dispose?: () => void | Promise<void> }
      return async () => { await handle.dispose?.() }
    },
  }
}
