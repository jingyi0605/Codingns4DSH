import { link, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodingNsRpcError } from './rpc-table.js'

const MAX_BYTES = 4 * 1024 * 1024
const mutations = new Map<string, Promise<unknown>>()

async function serializeMutation(path: string, operation: () => Promise<unknown>): Promise<unknown> {
  const previous = mutations.get(path) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  mutations.set(path, next)
  try { return await next } finally { if (mutations.get(path) === next) mutations.delete(path) }
}

function fail(message: string): never {
  throw new CodingNsRpcError('HTML_FILES_ACCESS_DENIED', message)
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix))
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) fail(`Invalid ${name}`)
  return value
}

/** Resolve existing ancestors too, so an absent leaf cannot bypass symlink boundaries. */
async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await physicalPath(parent), path.slice(parent.length).replace(/^[/\\]+/u, ''))
  }
}

/** All paths are relative to the HTML file; the authenticated parent supplies the session and grants. */
export async function runHtmlWorkspaceFileOperation(sessionRoot: string, input: Record<string, unknown>): Promise<unknown> {
  const root = await realpath(sessionRoot)
  const rawDocument = text(input.documentPath, 'documentPath')
  const documentPath = resolve(root, rawDocument)
  if (!inside(root, documentPath) || !inside(root, await realpath(documentPath))) fail('HTML document is outside this session workspace')
  if (!['.html', '.htm'].includes(extname(documentPath).toLowerCase()) || !(await stat(documentPath)).isFile()) fail('Not an HTML document')
  const directory = dirname(documentPath)
  if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.length > 8) fail('Invalid file access scopes')
  const scopes = await Promise.all(input.scopes.map(async (value) => {
    const scope = text(value, 'scope')
    if (isAbsolute(scope) || /^[a-z][a-z\d+.-]*:/iu.test(scope)) fail('Scopes must be relative to the HTML document')
    const path = resolve(directory, scope)
    if (!inside(root, path) || !inside(root, await physicalPath(path))) fail('File scope is outside this session workspace')
    return path
  }))
  if (input.operation === 'connect') {
    return { scopes: scopes.map(path => relative(root, path).replaceAll('\\', '/') || '.') }
  }

  const rawPath = text(input.path, 'path')
  if (isAbsolute(rawPath) || /^[a-z][a-z\d+.-]*:/iu.test(rawPath)) fail('File paths must be relative to the HTML document')
  const path = resolve(directory, rawPath)
  const scope = scopes.find(candidate => inside(candidate, path))
  if (scope === undefined || !inside(root, path)) fail('Path is outside the approved file scopes')
  const physical = await physicalPath(path)
  if (!inside(root, physical) || !inside(await physicalPath(scope), physical)) fail('Symlink escapes the approved file scope')

  const perform = async (): Promise<unknown> => { switch (input.operation) {
    case 'list': {
      const entries = await readdir(path, { withFileTypes: true })
      // Symlinks are excluded; reads separately enforce their physical path.
      return { items: entries.filter(entry => entry.isFile()).map(entry => ({ name: entry.name, kind: 'file' })) }
    }
    case 'read': {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_BYTES) fail('Not a text file within the size limit')
      return { content: await readFile(path, 'utf8'), mtime: info.mtimeMs }
    }
    case 'write': {
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_BYTES) fail('Invalid text content or file too large')
      let current
      try { current = await stat(path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (current && !current.isFile()) fail('Writes may only target regular files')
      if (typeof input.ifMtime === 'number' && current?.mtimeMs !== input.ifMtime) {
        throw new CodingNsRpcError('HTML_FILES_CONFLICT', 'The file changed outside this page. Reload it before saving.')
      }
      if (current && input.createOnly === true) {
        throw new CodingNsRpcError('HTML_FILES_CONFLICT', 'A file with this name already exists.')
      }
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.html-files-${randomUUID()}`
      try {
        await writeFile(temporary, input.content, { encoding: 'utf8', flag: 'wx', mode: current ? current.mode & 0o777 : 0o600 })
        if (typeof input.ifMtime === 'number' && (await stat(path)).mtimeMs !== input.ifMtime) {
          throw new CodingNsRpcError('HTML_FILES_CONFLICT', 'The file changed while saving. Reload it before saving.')
        }
        if (input.createOnly === true) await link(temporary, path)
        else await rename(temporary, path)
      } finally { await rm(temporary, { force: true }) }
      return { ok: true, mtime: (await stat(path)).mtimeMs }
    }
    case 'delete': {
      if (!(await stat(path)).isFile()) fail('Only regular files can be deleted')
      await unlink(path)
      return { ok: true }
    }
    default: fail('Unsupported HTML file operation')
  } }
  return input.operation === 'write' || input.operation === 'delete'
    ? serializeMutation(physical, perform)
    : perform()
}
