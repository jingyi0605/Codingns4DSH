import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { QuickApp } from '../../../shared/contracts/quick-apps.js'
import { publicPath, resolveAppPath } from './paths.js'
import { QuickAppError } from './errors.js'

const codeExtensions = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.svg', '.wasm'])

/** Bounded, request-time trust check. No watcher or background workspace scan is installed. */
export async function quickAppCodeRevision(workspace: string, app: QuickApp): Promise<string> {
  const root = await realpath(workspace)
  const entries: string[] = []
  const visited = new Set<string>()
  let count = 0
  const visit = async (path: string, depth: number): Promise<void> => {
    if (visited.has(path)) return
    visited.add(path)
    if (++count > 4096 || depth > 32) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'File permissions require an application folder with at most 4096 entries and 32 directory levels.')
    const physical = join(root, path)
    const info = await lstat(physical)
    if (info.isSymbolicLink()) return // Such paths cannot be served by the HTTP handler.
    if (info.isDirectory()) {
      const directory = await opendir(physical)
      for await (const entry of directory) if (publicPath(entry.name)) await visit([path, entry.name].filter(Boolean).join('/'), depth + 1)
    } else if (info.isFile() && codeExtensions.has(extname(path).toLowerCase())) {
      entries.push(JSON.stringify([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]))
    }
  }
  for (const path of [app.documentRoot, ...app.mounts.map(mount => mount.workspacePath)]) {
    await resolveAppPath(root, path)
    await visit(path, 0)
  }
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex')
}
