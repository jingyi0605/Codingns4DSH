import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { deny } from './errors.js'

/** Paths have one representation on every platform; no URL decoding in filesystem code. */
export function appPath(value: unknown, allowRoot = true): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\x00-\x1f\x7f:%?#]/u.test(value)) deny('Invalid relative path.')
  if (value === '.' || value === '') { if (allowRoot) return ''; deny() }
  if (value.startsWith('/') || value.endsWith('/') || value.split('/').some(part => part === '' || part === '.' || part === '..' || /[. ]$/u.test(part))) deny('Invalid relative path.')
  return value
}

export function insidePath(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

export function withinScope(scope: string, path: string): boolean {
  return scope === '' || path === scope || path.startsWith(`${scope}/`)
}

export function publicPath(path: string): boolean {
  return !path.split('/').some(part => part.startsWith('.') || /^(?:node_modules|id_rsa|id_ed25519)$/iu.test(part)
    || /(?:\.(?:pem|key|p12|pfx)|(?:^|[-_.])(?:credentials|secrets?)(?:\.|$))/iu.test(part))
}

/** Reject all symlinks, including in-root aliases; this also keeps mutation queue keys unique. */
export async function resolveAppPath(workspace: string, path: string, allowMissingLeaf = false): Promise<string> {
  const root = await realpath(workspace)
  const normalized = appPath(path)
  let current = root
  const parts = normalized === '' ? [] : normalized.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) deny('Symbolic links are not served by Quick Apps.')
      if (index < parts.length - 1 && !info.isDirectory()) deny()
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  if (!insidePath(root, resolve(current))) deny()
  return current
}

/** Inspect the raw request target before WHATWG URL can erase traversal segments. */
export function decodeResourceTarget(target: string): { path: string; query: string; trailingSlash: boolean } {
  if (!target.startsWith('/') || target.startsWith('//') || /[\\#\x00-\x20\x7f]/u.test(target)) deny('Invalid HTTP request target.')
  const split = target.indexOf('?')
  const raw = split < 0 ? target : target.slice(0, split)
  const query = split < 0 ? '' : target.slice(split)
  if (/%(?:2f|5c|25)/iu.test(raw)) deny('Ambiguous URL encoding.')
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { deny('Malformed URL encoding.') }
  const trailingSlash = decoded.endsWith('/')
  return { path: appPath(decoded.slice(1, trailingSlash ? -1 : undefined)), query, trailingSlash }
}
