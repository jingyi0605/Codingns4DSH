import type {
  MagpieContextItem,
  MagpieContextPart,
  MagpieContextPartKind,
  MagpieContextPoint,
  MagpieContextSession,
} from '../../shared/contracts/magpie-management.js'

const PART_KINDS: readonly MagpieContextPartKind[] = ['system', 'tools', 'memory', 'files', 'results', 'chat']
const MAX_PARTS = 6
const MAX_ITEMS = 24
const MAX_POINTS = 160
const MAX_TEXT = 240
const MAX_IDENTITY = 512

interface ParseOptions {
  readonly agents: readonly string[]
  readonly sessionIds: readonly string[]
}

/** Reduce Magpie's internal context response to the metadata needed by the UI. */
export function parseMagpieContextResponse(value: unknown, options: ParseOptions): MagpieContextSession | null {
  const root = asRecord(value)
  const sessions = root?.sessions
  if (!Array.isArray(sessions) || sessions.length > 80) return null
  const agents = new Set(options.agents.map(cleanIdentity).filter((item): item is string => item !== null))
  const sessionIds = new Set(options.sessionIds.map(cleanIdentity).filter((item): item is string => item !== null))
  if (agents.size === 0 || sessionIds.size === 0) return null
  const selected = sessions
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null)
    .filter((record) => agents.has(cleanIdentity(record.agent) ?? '') && sessionIds.has(cleanIdentity(record.key) ?? ''))
    .sort((left, right) => safeInt(right.latestId) - safeInt(left.latestId))[0]
  if (selected === undefined) return null

  const latest = asRecord(selected.latest)
  const usedTokens = safeInt(latest?.tokens)
  if (latest === null || usedTokens <= 0) return null
  const parts = parseParts(latest.parts)
  if (parts.length === 0) return null
  const points = parsePoints(selected.points)
  const contextWindow = positiveInt(latest.window) ?? positiveInt(selected.window)
  if (contextWindow === null) return null
  const countedTokens = points.reduce((sum, point) => sum + point.tokens, 0)
  const cacheTokens = points.reduce((sum, point) => sum + point.cacheTokens, 0)
  const cacheRate = countedTokens > 0 ? Math.min(1, cacheTokens / countedTokens) : 0
  const agent = cleanIdentity(selected.agent)
  const key = cleanIdentity(selected.key)
  const model = cleanText(selected.model)
  if (agent === null || key === null || model === null) return null
  return {
    agent,
    key,
    title: cleanText(selected.title),
    model,
    requests: safeInt(selected.requests),
    turns: safeInt(latest.turns),
    usedTokens,
    contextWindow,
    cacheTokens,
    cacheRate,
    compacts: safeInt(selected.compacts),
    latestId: positiveInt(selected.latestId),
    parts,
    points,
  }
}

function parseParts(value: unknown): readonly MagpieContextPart[] {
  if (!Array.isArray(value) || value.length > MAX_PARTS) return []
  return value.flatMap((item): MagpieContextPart[] => {
    const record = asRecord(item)
    const kind = readPartKind(record?.kind)
    if (record === null || kind === null) return []
    return [{ kind, tokens: safeInt(record.tokens), items: parseItems(record.items) }]
  })
}

function parseItems(value: unknown): readonly MagpieContextItem[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return []
  return value.flatMap((item): MagpieContextItem[] => {
    const record = asRecord(item)
    const name = cleanText(record?.name)
    if (record === null || name === null) return []
    const tag = cleanText(record.tag)
    const count = positiveInt(record.n)
    return [{ name, ...(tag === null ? {} : { tag }), ...(count === null ? {} : { count }), tokens: safeInt(record.tokens) }]
  })
}

function parsePoints(value: unknown): readonly MagpieContextPoint[] {
  if (!Array.isArray(value) || value.length > MAX_POINTS) return []
  return value.flatMap((item): MagpieContextPoint[] => {
    const record = asRecord(item)
    const id = positiveInt(record?.id)
    if (record === null || id === null) return []
    return [{
      id,
      time: cleanTime(record.time),
      tokens: safeInt(record.tokens),
      window: positiveInt(record.window),
      cacheTokens: safeInt(record.cache),
    }]
  })
}

function readPartKind(value: unknown): MagpieContextPartKind | null {
  const kind = cleanText(value)
  return kind !== null && (PART_KINDS as readonly string[]).includes(kind) ? kind as MagpieContextPartKind : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function cleanIdentity(value: unknown): string | null {
  const text = cleanText(value)
  return text !== null && text.length <= MAX_IDENTITY ? text : null
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, MAX_TEXT)
  return text === '' ? null : text
}

function cleanTime(value: unknown): string | null {
  const text = cleanText(value)
  return text === null || Number.isNaN(Date.parse(text)) ? null : text
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function safeInt(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
