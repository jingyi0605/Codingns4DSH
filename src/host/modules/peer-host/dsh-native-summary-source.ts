import type { Context } from '@deepseek-ai/cordis'
import type { AggregateWorkspaceSource, PeerHostWorkspaceSessionSummarySource } from './peer-host-aggregate-service.js'

/** 从 DSH 原生服务结构探测 workspace/session 摘要；不依赖 DSH 私有 TypeScript 类型。 */
export function createDshNativeSummarySource(ctx: Context | undefined, sessions: { listRemote(signal?: AbortSignal): Promise<readonly unknown[]>; list(): readonly unknown[] } | undefined): PeerHostWorkspaceSessionSummarySource {
  const workspaceRegistry = readService(ctx, 'workspaceRegistry')
  const sessionList = sessions?.listRemote !== undefined ? sessions.listRemote.bind(sessions) : undefined
  const available = workspaceRegistry !== undefined || sessionList !== undefined
  if (!available) {
    return {
      capabilityId: 'peer-host.native-workspace-session-summary',
      available: false,
      reason: 'DSH 未提供 workspaceRegistry 或 sessionController/listRemote',
      async load() { return [] },
    }
  }
  return {
    capabilityId: 'peer-host.native-workspace-session-summary',
    available: true,
    async load(signal) {
      const sessionsValue = sessionList === undefined ? sessions?.list() ?? [] : await sessionList(signal)
      return buildSummary(readList(workspaceRegistry), sessionsValue)
    },
  }
}

function buildSummary(workspaces: readonly unknown[], sessions: readonly unknown[]): readonly AggregateWorkspaceSource[] {
  const entries = new Map<string, { name: string; sessions: unknown[] }>()
  for (const raw of workspaces) {
    const value = asRecord(raw)
    const id = readText(value, ['id', 'workspaceId', 'key'])
    if (id === null) continue
    entries.set(id, { name: readText(value, ['displayName', 'name', 'title']) ?? id, sessions: [] })
  }
  for (const raw of sessions) {
    const value = asRecord(raw)
    const id = readText(value, ['id', 'sessionId', 'key'])
    if (id === null) continue
    const workspaceId = readText(value, ['workspaceId']) ?? readNestedText(value, ['workspace', 'id']) ?? 'default'
    const entry = entries.get(workspaceId) ?? { name: workspaceId === 'default' ? '默认工作区' : workspaceId, sessions: [] }
    entry.sessions.push(value)
    entries.set(workspaceId, entry)
  }
  return [...entries.entries()].map(([workspaceId, entry]) => ({
    workspaceId,
    displayName: entry.name,
    sessions: entry.sessions.flatMap((raw) => {
      const value = asRecord(raw)
      const sessionId = readText(value, ['id', 'sessionId', 'key'])
      if (sessionId === null) return []
      return [{
        sessionId,
        title: readText(value, ['title', 'name', 'displayName']) ?? sessionId,
        status: readText(value, ['status', 'state']) ?? 'unknown',
        updatedAt: readTimestamp(value, ['updatedAt', 'updated', 'lastUpdatedAt', 'createdAt']),
      }]
    }),
  }))
}

function readService(ctx: Context | undefined, name: string): Record<string, unknown> | undefined {
  if (ctx === undefined) return undefined
  try {
    return asRecord(ctx.get(name)) ?? undefined
  } catch {
    return undefined
  }
}

function readList(value: Record<string, unknown> | undefined): readonly unknown[] {
  if (value === undefined || typeof value.list !== 'function') return []
  try {
    const result = value.list()
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readText(value: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (value === null) return null
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

function readNestedText(value: Record<string, unknown> | null, path: readonly string[]): string | null {
  let current: unknown = value
  for (const key of path) {
    const record = asRecord(current)
    if (record === null) return null
    current = record[key]
  }
  return typeof current === 'string' && current.trim() !== '' ? current.trim() : null
}

function readTimestamp(value: Record<string, unknown> | null, keys: readonly string[]): number {
  if (value !== null) {
    for (const key of keys) {
      const candidate = value[key]
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
      if (typeof candidate === 'string') {
        const parsed = Date.parse(candidate)
        if (Number.isFinite(parsed)) return parsed
      }
    }
  }
  return 0
}
