import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { QuickAppDocument } from '../../../shared/contracts/quick-apps.js'
import type { QuickAppFileApi } from './file-api.js'
import type { QuickAppLaunch, QuickAppLaunches } from './launches.js'
import { appPath, publicPath, resolveAppPath, withinScope } from './paths.js'
import { deny, QuickAppError } from './errors.js'

const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' }

/** Trusted UI document operations. HTML pages cannot use this authenticated management channel. */
export class QuickAppDocuments {
  private active = 0
  constructor(private readonly launches: QuickAppLaunches, private readonly files: QuickAppFileApi) {}

  async handle(id: string, principal: string, input: Record<string, unknown>): Promise<unknown> {
    if (this.active >= 8) throw new QuickAppError(429, 'QUICK_APP_LIMIT', 'Too many document requests.')
    this.active++
    try {
      const launch = this.launches.requireOwner(id, principal)
      if (launch.app.kind !== 'text') deny()
      await this.launches.validateWorkspace(launch)
      const path = appPath(input.path ?? launch.app.entryPath, false)
      if (!publicPath(path) || !withinScope(launch.app.documentRoot, path)) deny()
      if (input.operation === 'image') return await this.image(launch, path)
      if (input.operation === 'read') return await this.read(launch, path)
      if (input.operation === 'allow-edit') {
        await this.files.read(launch, path)
        this.launches.authorize(launch)
        // Explicit user approval grants this file only, for this launch's lifetime. No delete/create grant.
        launch.permissions = { ...launch.permissions, write: [...new Set([...launch.permissions.write, path])] }
        return { ok: true }
      }
      if (input.operation === 'save') {
        if (typeof input.content !== 'string') deny()
        if (Buffer.from(input.content, 'utf8').toString('utf8') !== input.content) deny('The document must contain valid Unicode text.')
        const result = await this.files.mutate(launch, 'PUT', path, input.content, typeof input.version === 'string' ? input.version : undefined, undefined, launch.abort.signal)
        return { path, content: input.content, version: result.version!, canWrite: true } satisfies QuickAppDocument
      }
      throw new QuickAppError(404, 'CODINGNS_RPC_NOT_FOUND', 'Unknown document operation.')
    } finally { this.active-- }
  }

  async read(launch: QuickAppLaunch, path: string): Promise<QuickAppDocument> {
    const result = await this.files.read(launch, path)
    return { ...result, path, canWrite: launch.permissions.write.some(scope => withinScope(scope, path)) }
  }

  private async image(launch: QuickAppLaunch, path: string): Promise<{ url: string }> {
    const mime = imageTypes[extname(path).toLowerCase()]
    if (!mime) deny('Only raster document images are supported.')
    const file = await open(await resolveAppPath(launch.workspaceRoot, path), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      const limit = 2 * 1024 * 1024
      if (!info.isFile() || info.size > limit) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'Document images must be at most 2 MiB.')
      const bytes = Buffer.alloc(limit + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > limit) throw new QuickAppError(413, 'QUICK_APP_TOO_LARGE', 'Document images must be at most 2 MiB.')
      await this.launches.validateWorkspace(launch)
      await resolveAppPath(launch.workspaceRoot, path)
      this.launches.authorize(launch)
      return { url: `data:${mime};base64,${bytes.subarray(0, length).toString('base64')}` }
    } finally { await file.close() }
  }
}
