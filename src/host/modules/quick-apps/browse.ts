import { realpath } from 'node:fs/promises'
import type { WorkspaceDirectoryBrowser } from '../../../dsh-capabilities/host/workspace-directory-adapter.js'
import type { QuickAppDirectory } from '../../../shared/contracts/quick-apps.js'
import { appPath, publicPath, resolveAppPath } from './paths.js'
import { deny, QuickAppError } from './errors.js'

/** Management-only browsing: the Host resolves identity before handing a root to its native browser. */
export async function browseQuickAppDirectory(
  workspaceRoot: (id: string) => string | null, browser: WorkspaceDirectoryBrowser | undefined,
  workspaceId: unknown, requestedPath: unknown, signal: AbortSignal,
): Promise<QuickAppDirectory> {
  signal.throwIfAborted()
  if (typeof workspaceId !== 'string' || !workspaceId) deny()
  const root = workspaceRoot(workspaceId)
  if (!root) throw new QuickAppError(404, 'QUICK_APP_WORKSPACE_UNAVAILABLE', 'The exact workspace is unavailable.')
  const path = appPath(requestedPath ?? '')
  if (!publicPath(path)) deny()
  const canonical = await realpath(root)
  const directory = await resolveAppPath(root, path)
  if (!browser) throw new QuickAppError(503, 'QUICK_APP_BROWSE_UNAVAILABLE', 'The native Host file browser is unavailable.')
  const listing = await browser.list(canonical, path, signal)
  signal.throwIfAborted()
  // A removed/retargeted workspace or replaced directory must not publish an old listing.
  if (workspaceRoot(workspaceId) !== root || await realpath(root) !== canonical || await resolveAppPath(root, path) !== directory) deny()
  const entries = listing.entries.slice(0, 1000).flatMap(entry => {
    if (!['file', 'directory'].includes(entry.type) || entry.name.includes('/') || !publicPath(entry.name)) return []
    try { appPath(entry.name, false) } catch { return [] }
    return [{ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name, kind: entry.type as 'file' | 'directory' }]
  })
  return { path, entries, truncated: listing.truncated || listing.entries.length > 1000 }
}
