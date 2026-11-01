import type { CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'

const DEFAULT_CACHE_TTL_MS = 1_000

export interface DshModelCatalogReaderOptions {
  readonly now?: () => number
  readonly ttlMs?: number
}

/**
 * Bound native DSH model-list traffic to one in-flight request and one recent
 * snapshot. Model selection changes become visible after the short TTL.
 */
export function createDshModelCatalogReader(
  read: () => Promise<CodingNsCliModelCatalog>,
  options: DshModelCatalogReaderOptions = {},
): () => Promise<CodingNsCliModelCatalog> {
  const now = options.now ?? Date.now
  const ttlMs = normalizeTtl(options.ttlMs)
  let cached: { readonly value: CodingNsCliModelCatalog; readonly cachedAt: number } | undefined
  let pending: Promise<CodingNsCliModelCatalog> | undefined

  return async (): Promise<CodingNsCliModelCatalog> => {
    const current = now()
    if (cached !== undefined && current - cached.cachedAt < ttlMs) return cached.value
    if (pending !== undefined) return pending
    const request = Promise.resolve()
      .then(read)
      .then((value) => {
        cached = { value, cachedAt: now() }
        return value
      })
      .finally(() => {
        if (pending === request) pending = undefined
      })
    pending = request
    return request
  }
}

function normalizeTtl(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? DEFAULT_CACHE_TTL_MS : Math.max(1, Math.floor(value))
}
