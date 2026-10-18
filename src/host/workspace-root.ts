/**
 * Resolve a workspace directory from DSH `workspaceRegistry`.
 *
 * PeerHost Git runs on the target Host without a terminal session, so it cannot
 * use the terminal-filled `workspaceRoots` cache. Lookup must work from the live
 * registry: DSH entities expose `id` + `path` getter; follow views use
 * `workspaceId` / `key` and `cwd`.
 */

const WORKSPACE_ID_KEYS = ['id', 'workspaceId', 'key'] as const
const WORKSPACE_PATH_KEYS = ['path', 'rootPath', 'cwd', 'directory', 'root'] as const

export interface WorkspaceRootContext {
  get(name: string): unknown
}

interface WorkspaceRegistryLike {
  readonly get?: (id: string) => unknown
  readonly list?: () => unknown
}

export function resolveWorkspaceRoot(ctx: WorkspaceRootContext, workspaceId: string): string | null {
  const id = workspaceId.trim()
  if (id === '') return null
  const registry = readWorkspaceRegistry(ctx)
  if (registry === undefined) return null
  const fromGet = readPath(callRegistryGet(registry, id))
  if (fromGet !== null) return fromGet
  return readPath(findListedWorkspace(registry, id))
}

export function listWorkspaceRoots(ctx: WorkspaceRootContext): readonly string[] {
  const registry = readWorkspaceRegistry(ctx)
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    const listed = registry.list()
    if (!Array.isArray(listed)) return []
    const roots: string[] = []
    for (const entry of listed) {
      const path = readPath(entry)
      if (path !== null) roots.push(path)
    }
    return roots
  } catch {
    return []
  }
}

function readWorkspaceRegistry(ctx: WorkspaceRootContext): WorkspaceRegistryLike | undefined {
  try {
    const value = ctx.get('workspaceRegistry')
    if (value === null || typeof value !== 'object') return undefined
    return value as WorkspaceRegistryLike
  } catch {
    return undefined
  }
}

function callRegistryGet(registry: WorkspaceRegistryLike, workspaceId: string): unknown {
  if (typeof registry.get !== 'function') return undefined
  try {
    return registry.get(workspaceId)
  } catch {
    return undefined
  }
}

function findListedWorkspace(registry: WorkspaceRegistryLike, workspaceId: string): unknown {
  if (typeof registry.list !== 'function') return undefined
  try {
    const listed = registry.list()
    if (!Array.isArray(listed)) return undefined
    return listed.find((candidate) => workspaceEntryId(candidate) === workspaceId)
  } catch {
    return undefined
  }
}

function workspaceEntryId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of WORKSPACE_ID_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

function readPath(value: unknown): string | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of WORKSPACE_PATH_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}
