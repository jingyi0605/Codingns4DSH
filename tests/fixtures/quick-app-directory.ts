import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createWorkspaceDirectoryBrowser } from '../../src/dsh-capabilities/host/workspace-directory-adapter.js'

/** Filesystem-backed test double for the native service; no installed DSH runtime is started. */
export function fixtureWorkspaceDirectoryBrowser() {
  return createWorkspaceDirectoryBrowser({ workspaceFiles: {
    async list(scope: { workspaceRoot: string }, path: string, signal: AbortSignal) {
      signal.throwIfAborted()
      return { entries: (await readdir(join(scope.workspaceRoot, path), { withFileTypes: true })).map(entry => ({ name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), truncated: false }
    },
  } })
}
