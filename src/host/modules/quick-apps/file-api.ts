import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, opendir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { QuickAppLaunch, QuickAppLaunches } from './launches.js'
import { QUICK_APP_LIMITS } from '../../../shared/contracts/quick-apps.js'
import { appPath, publicPath, resolveAppPath, withinScope } from './paths.js'
import { conflict, deny, QuickAppError } from './errors.js'
import { serializeWorkspaceMutation } from '../../workspace-file-mutations.js'

export async function readVersionedText(path: string): Promise<{ content: string; version: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile()) deny('Only regular text files are supported.')
    if (info.size > QUICK_APP_LIMITS.textBytes) tooLarge()
    const bytes = Buffer.alloc(QUICK_APP_LIMITS.textBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > QUICK_APP_LIMITS.textBytes) tooLarge()
    const after = await file.stat()
    if (after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.size !== info.size) conflict()
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)) } catch { deny('The file is not UTF-8 text.') }
    const version = `"${createHash('sha256').update(bytes.subarray(0, length)).update(`${info.ino}:${info.mtimeMs}:${info.ctimeMs}`).digest('hex')}"`
    return { content, version }
  } finally { await file.close() }
}

export function tooLarge(): never { throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'The text limit is 4 MiB.') }

/** Global physical-file ordering with per-service pending work for lifecycle cleanup. */
export class QuickAppFileApi {
  private readonly mutations = new Set<Promise<unknown>>()
  constructor(private readonly launches: QuickAppLaunches) {}

  private async target(launch: QuickAppLaunch, operation: 'read' | 'write' | 'delete', path: string, missing = false): Promise<string> {
    await this.launches.validateWorkspace(launch)
    await launch.validateCode?.()
    this.launches.authorize(launch)
    const normalized = appPath(path)
    if (!publicPath(normalized) || !launch.permissions[operation].some(scope => withinScope(scope, normalized))) deny()
    return resolveAppPath(launch.workspaceRoot, normalized, missing)
  }
  async read(launch: QuickAppLaunch, path: string): Promise<{ content: string; version: string }> {
    const result = await readVersionedText(await this.target(launch, 'read', path))
    this.launches.authorize(launch)
    return result
  }
  async list(launch: QuickAppLaunch, path: string): Promise<{ items: readonly { name: string; kind: string }[] }> {
    const directory = await opendir(await this.target(launch, 'read', path))
    const items: { name: string; kind: string }[] = []
    for await (const item of directory) {
      this.launches.authorize(launch)
      if (items.length >= 1000) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'Directory listing exceeds 1000 entries.')
      if (!item.isSymbolicLink() && publicPath(item.name) && (item.isFile() || item.isDirectory())) items.push({ name: item.name, kind: item.isFile() ? 'file' : 'directory' })
    }
    return { items }
  }
  async mutate(launch: QuickAppLaunch, method: 'PUT' | 'DELETE', path: string, content: string, ifMatch?: string, ifNoneMatch?: string, signal?: AbortSignal): Promise<{ ok: true; version?: string }> {
    if (Buffer.byteLength(content) > QUICK_APP_LIMITS.textBytes) tooLarge()
    const create = method === 'PUT' && ifNoneMatch === '*'
    if ((create && ifMatch !== undefined) || (!create && (!ifMatch || ifMatch === '*' || ifNoneMatch !== undefined))) {
      throw new QuickAppError(428, 'QUICK_APP_PRECONDITION_REQUIRED', 'Use the exact If-Match version, or If-None-Match: * to create a new file.')
    }
    const operation = method === 'DELETE' ? 'delete' : 'write'
    const key = await this.target(launch, operation, path, create)
    const next = serializeWorkspaceMutation(key, async () => {
      signal?.throwIfAborted()
      const target = await this.target(launch, operation, path, create)
      if (target !== key) deny()
      if (!create && (await readVersionedText(target)).version !== ifMatch) conflict()
      if (method === 'DELETE') {
        await this.target(launch, operation, path)
        if ((await readVersionedText(target)).version !== ifMatch) conflict()
        signal?.throwIfAborted()
        this.launches.authorize(launch)
        await unlink(target)
        return { ok: true as const }
      }
      // Parent directories must already exist. Never recursively create through an unvalidated ancestor.
      const temporary = join(dirname(target), `.${basename(target)}.quickapp-${randomUUID()}`)
      const mode = create ? 0o600 : (await stat(target)).mode & 0o777
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
      try {
        await file.writeFile(content, 'utf8')
        await file.sync()
        await file.close()
        await this.target(launch, operation, path, create)
        if (!create && (await readVersionedText(target)).version !== ifMatch) conflict()
        signal?.throwIfAborted()
        this.launches.authorize(launch)
        if (create) {
          try { await link(temporary, target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict(); throw error }
          // Removing the temporary hard link changes ctime. Return the version only after that cleanup.
          await unlink(temporary)
        }
        else await rename(temporary, target)
        return { ok: true as const, version: (await readVersionedText(target)).version }
      } finally {
        await file.close().catch(() => undefined)
        await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
      }
    })
    this.mutations.add(next)
    try { return await next } finally { this.mutations.delete(next) }
  }
  async drain(): Promise<void> { await Promise.allSettled(this.mutations) }
  get pending(): number { return this.mutations.size }
}
