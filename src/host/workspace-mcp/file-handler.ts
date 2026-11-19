import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const DEFAULT_READ_LIMIT = 1024 * 1024
const MAX_DEPTH = 5
const MAX_ENTRIES = 2_000

export class WorkspaceMcpHandlerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceMcpHandlerError'
    this.code = code
  }
}

export async function listWorkspaceFiles(rootValue: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown> {
  const root = await canonicalRoot(rootValue)
  const requested = readRelativePath(args.path, true)
  const basePath = await resolveInside(root, requested)
  let baseStat
  try { baseStat = await lstat(basePath) } catch { throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_NOT_FOUND', 'The requested directory was not found.') }
  if (!baseStat.isDirectory()) throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The requested path is not a directory.')
  const depth = args.depth === undefined ? 2 : readInteger(args.depth, 1, MAX_DEPTH, 'depth')
  const entries: Array<{ path: string; name: string; type: 'file' | 'directory'; size?: number; mtime?: string }> = []
  await walk(root, basePath, requested, 1, depth, entries, signal)
  return { entries, truncated: entries.length === MAX_ENTRIES }
}

export async function readWorkspaceFile(rootValue: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const root = await canonicalRoot(rootValue)
  const requested = readRelativePath(args.path, false)
  const path = await resolveInside(root, requested)
  const maximum = args.limitBytes === undefined ? DEFAULT_READ_LIMIT : readInteger(args.limitBytes, 1, DEFAULT_READ_LIMIT, 'limitBytes')
  const encoding = args.encoding === undefined ? 'utf8' : args.encoding
  if (encoding !== 'utf8' && encoding !== 'base64') throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_INPUT', 'encoding must be utf8 or base64.')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(fileError)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The requested path is not a regular file.')
    const currentPath = await resolveInside(root, requested)
    const current = await lstat(currentPath).catch(fileError)
    if (current.dev !== info.dev || current.ino !== info.ino) throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The file changed while opening it.')
    if (info.size > maximum) throw tooLarge()
    const buffer = Buffer.allocUnsafe(maximum + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > maximum) throw tooLarge()
    return { content: buffer.toString(encoding, 0, size), size, encoding, truncated: false }
  } finally { await handle.close() }
}

async function canonicalRoot(root: string): Promise<string> {
  try { return await realpath(root) } catch { throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_WORKSPACE_UNAVAILABLE', 'The managed workspace is unavailable.') }
}

async function resolveInside(root: string, relativePath: string): Promise<string> {
  const candidate = resolve(root, relativePath)
  if (!isWithin(root, candidate)) throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The path must stay inside the managed workspace.')
  let canonical: string
  canonical = await realpath(candidate).catch(fileError)
  if (!isWithin(root, canonical) || relative(root, canonical).split(sep).includes('.git')) {
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The path resolves outside the available workspace files.')
  }
  return canonical
}

function readRelativePath(value: unknown, allowEmpty: boolean): string {
  if (value === undefined && allowEmpty) return ''
  if (typeof value !== 'string' || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The path must be relative to the managed workspace.')
  }
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').some((part) => part === '..' || part === '.git')) {
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The path is not available inside the managed workspace.')
  }
  if (!allowEmpty && normalized.trim() === '') throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'A file path is required.')
  return normalized
}

async function walk(
  root: string,
  directory: string,
  relativeDirectory: string,
  level: number,
  maximumDepth: number,
  entries: Array<{ path: string; name: string; type: 'file' | 'directory'; size?: number; mtime?: string }>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  if (!isWithin(root, await realpath(directory).catch(fileError))) return
  const names = await readdir(directory, { withFileTypes: true }).catch(fileError)
  names.sort((left, right) => left.name.localeCompare(right.name))
  for (const item of names) {
    signal.throwIfAborted()
    if (entries.length >= MAX_ENTRIES) return
    if (item.name === '.git' || item.name === 'node_modules' || item.isSymbolicLink()) continue
    const path = relativeDirectory === '' ? item.name : `${relativeDirectory}/${item.name}`
    const absolutePath = resolve(directory, item.name)
    const info = await lstat(absolutePath)
    if (!info.isDirectory() && !info.isFile()) continue
    entries.push({ path, name: item.name, type: info.isDirectory() ? 'directory' : 'file', ...(info.isFile() ? { size: info.size } : {}), mtime: info.mtime.toISOString() })
    if (info.isDirectory() && level < maximumDepth) await walk(root, absolutePath, path, level + 1, maximumDepth, entries, signal)
  }
}

function tooLarge(): WorkspaceMcpHandlerError {
  return new WorkspaceMcpHandlerError('WORKSPACE_MCP_FILE_TOO_LARGE', 'The file exceeds the allowed size limit.')
}

function fileError(error: NodeJS.ErrnoException): never {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_NOT_FOUND', 'The requested path was not found.')
  if (error.code === 'EACCES' || error.code === 'EPERM') throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_PERMISSION_DENIED', 'The requested path could not be accessed.')
  if (error.code === 'ELOOP') throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_PATH', 'The requested path could not be resolved safely.')
  throw error
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function readInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkspaceMcpHandlerError('WORKSPACE_MCP_INVALID_INPUT', `${name} is outside its allowed range.`)
  }
  return value
}
