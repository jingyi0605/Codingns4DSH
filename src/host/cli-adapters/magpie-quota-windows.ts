/**
 * Collapse raw Magpie `/api/usage/quotas` and `/api/login/usage` window lists.
 *
 * Magpie's internal Web API returns both per-model windows (carrying `family`,
 * and usually `pool`) and pool-level windows (carrying `pool` without `family`)
 * so Magpie's own web UI can toggle between grouped and per-model views.
 * CodingNS displays the summary view directly; without collapsing here, shared
 * pools like `agy-cli` render every model window alongside bare `"5 hours"` /
 * `"7 days"` pool rows.
 */

const FAMILY_ORDER: readonly string[] = ['Gemini', 'Claude']

export interface MagpieRawQuotaWindow<TWindow extends { readonly name: string; readonly resetsAt: string | null }> {
  readonly window: TWindow
  readonly pool: string | null
  readonly family: string | null
  readonly usedPercent: number | null
  readonly remainingPercent: number | null
}

interface IndexedRawWindow<TWindow extends { readonly name: string; readonly resetsAt: string | null }> {
  readonly item: MagpieRawQuotaWindow<TWindow>
  readonly index: number
}

interface CollapsedFamilyEntry<TWindow extends { readonly name: string; readonly resetsAt: string | null }> {
  readonly window: TWindow
  readonly family: string | null
  readonly index: number
}

/** Collapse pool and model-family windows into non-duplicated summary windows. */
export function collapseMagpieQuotaWindows<TWindow extends { readonly name: string; readonly resetsAt: string | null }>(
  entries: readonly MagpieRawQuotaWindow<TWindow>[],
  withName: (window: TWindow, name: string) => TWindow,
): readonly TWindow[] {
  if (entries.length === 0) return []
  const poolEntries = entries.filter(isPoolWindow)
  if (poolEntries.length === 0) {
    return collapseByFamily(entries, withName).map((entry) => entry.window)
  }

  const pools = new Map<string, IndexedRawWindow<TWindow>[]>()
  entries.forEach((item, index) => {
    if (!isPoolWindow(item)) return
    const list = pools.get(item.pool)
    if (list === undefined) pools.set(item.pool, [{ item, index }])
    else list.push({ item, index })
  })

  // Any per-model window belonging to an active pool is represented by that pool's windows.
  const unpooled = entries.filter((item) => !isPoolWindow(item) && (item.pool === null || !pools.has(item.pool)))
  let remainingFamilies = collapseByFamily(unpooled, withName)

  const orderedPoolNames = [...pools.keys()].sort((left, right) => (
    poolRank(left) - poolRank(right)
    || pools.get(left)![0]!.index - pools.get(right)![0]!.index
  ))

  const result: TWindow[] = []
  for (const pool of orderedPoolNames) {
    const own = [...pools.get(pool)!].sort((left, right) => (
      windowDurationHours(stripPoolPrefix(pool, left.item.window.name))
      - windowDurationHours(stripPoolPrefix(pool, right.item.window.name))
      || left.index - right.index
    ))
    // When a non-versioned pool omits its 5h window, keep matching unpooled 5h family windows right before it.
    if (!own.some((entry) => windowDurationHours(stripPoolPrefix(pool, entry.item.window.name)) === 5) && !hasModelVersion(pool)) {
      const poolLower = pool.toLowerCase()
      const matched: CollapsedFamilyEntry<TWindow>[] = []
      const kept: CollapsedFamilyEntry<TWindow>[] = []
      for (const entry of remainingFamilies) {
        if (entry.family !== null && poolLower.includes(entry.family.toLowerCase())) matched.push(entry)
        else kept.push(entry)
      }
      remainingFamilies = kept
      for (const entry of matched) result.push(entry.window)
    }
    for (const entry of own) {
      const formatted = formatPoolWindowName(pool, entry.item.window.name)
      result.push(formatted === entry.item.window.name ? entry.item.window : withName(entry.item.window, formatted))
    }
  }

  for (const entry of remainingFamilies) result.push(entry.window)
  return result
}

function isPoolWindow<TWindow extends { readonly name: string; readonly resetsAt: string | null }>(
  entry: MagpieRawQuotaWindow<TWindow>,
): entry is MagpieRawQuotaWindow<TWindow> & { readonly pool: string; readonly family: null } {
  return entry.pool !== null && entry.family === null
}

function collapseByFamily<TWindow extends { readonly name: string; readonly resetsAt: string | null }>(
  entries: readonly MagpieRawQuotaWindow<TWindow>[],
  withName: (window: TWindow, name: string) => TWindow,
): readonly CollapsedFamilyEntry<TWindow>[] {
  if (!entries.some((entry) => entry.family !== null)) {
    return entries.map((entry, index) => ({ window: entry.window, family: null, index }))
  }

  const groups = new Map<string, IndexedRawWindow<TWindow>[]>()
  entries.forEach((item, index) => {
    const key = item.family === null ? `u:${groups.size}` : `f:${item.family}`
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [{ item, index }])
    else list.push({ item, index })
  })

  if (groups.size === entries.length) {
    return entries.map((entry, index) => ({ window: entry.window, family: entry.family, index }))
  }

  const collapsed: CollapsedFamilyEntry<TWindow>[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    if (first.item.family === null) {
      collapsed.push({ window: first.item.window, family: null, index: first.index })
      continue
    }
    const tightest = group.reduce((best, candidate) => (
      isTighterWindow(candidate.item, best.item) ? candidate : best
    ))
    collapsed.push({
      window: tightest.item.window.name === first.item.family
        ? tightest.item.window
        : withName(tightest.item.window, first.item.family),
      family: first.item.family,
      index: first.index,
    })
  }

  return collapsed.sort((left, right) => (
    familyRank(left.family) - familyRank(right.family)
    || left.index - right.index
  ))
}

function isTighterWindow<TWindow extends { readonly name: string; readonly resetsAt: string | null }>(
  candidate: MagpieRawQuotaWindow<TWindow>,
  current: MagpieRawQuotaWindow<TWindow>,
): boolean {
  const candidateUsed = effectiveUsedPercent(candidate)
  const currentUsed = effectiveUsedPercent(current)
  if (candidateUsed !== currentUsed) return candidateUsed > currentUsed
  return resetTimestampMs(candidate.window.resetsAt) < resetTimestampMs(current.window.resetsAt)
}

function effectiveUsedPercent<TWindow extends { readonly name: string; readonly resetsAt: string | null }>(
  entry: MagpieRawQuotaWindow<TWindow>,
): number {
  if (entry.usedPercent !== null) return entry.usedPercent
  if (entry.remainingPercent !== null) return 100 - entry.remainingPercent
  return Number.NEGATIVE_INFINITY
}

function resetTimestampMs(value: string | null): number {
  if (value === null) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function familyRank(family: string | null): number {
  if (family === null) return FAMILY_ORDER.length
  const index = FAMILY_ORDER.indexOf(family)
  return index < 0 ? FAMILY_ORDER.length : index
}

function hasModelVersion(pool: string): boolean {
  return /\d/u.test(pool)
}

function poolRank(pool: string): number {
  if (hasModelVersion(pool)) return FAMILY_ORDER.length + 1
  const firstWord = pool.split(/[ &]/u)[0] ?? ''
  const index = FAMILY_ORDER.indexOf(firstWord)
  return index < 0 ? FAMILY_ORDER.length : index
}

function stripPoolPrefix(pool: string, name: string): string {
  if (name.startsWith(`${pool} · `)) return name.slice(pool.length + 3)
  if (name.startsWith(`${pool}·`)) return name.slice(pool.length + 1).trimStart()
  return name
}

function formatPoolWindowName(pool: string, name: string): string {
  if (name === pool || name.startsWith(`${pool} · `) || name.startsWith(`${pool}·`)) return name
  return `${pool} · ${name}`
}

function windowDurationHours(name: string): number {
  const match = /^(\d+)\s*(minute|hour|day|week|month)s?$/iu.exec(name.trim())
  if (match === null) return Number.POSITIVE_INFINITY
  const count = Number(match[1])
  switch (match[2]!.toLowerCase()) {
    case 'minute': return count / 60
    case 'hour': return count
    case 'day': return count * 24
    case 'week': return count * 168
    case 'month': return count * 720
    default: return Number.POSITIVE_INFINITY
  }
}
