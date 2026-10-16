import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { QuickApp, QuickAppAvailability, QuickAppPermissions } from '../../../shared/contracts/quick-apps.js'
import { QUICK_APP_LIMITS } from '../../../shared/contracts/quick-apps.js'
import { appPath, publicPath, resolveAppPath, withinScope } from './paths.js'
import { conflict, deny, QuickAppError } from './errors.js'

export interface QuickAppStorage {
  read(): readonly QuickApp[]
  write(apps: readonly QuickApp[]): Promise<void>
}

export class QuickAppRegistry {
  private pending: Promise<unknown> = Promise.resolve()
  private stopped = false
  constructor(readonly storage: QuickAppStorage, readonly workspaceRoot: (id: string) => string | null, readonly hostId = 'local',
    private readonly remoteValidate?: (app: QuickApp) => Promise<void>) {}

  list(): readonly QuickApp[] { return [...structuredClone(this.storage.read())].sort((a, b) => a.order - b.order) }
  get(id: string): QuickApp {
    const app = this.list().find(item => item.id === id)
    if (!app) throw new QuickAppError(404, 'QUICK_APP_UNAVAILABLE', 'The shortcut no longer exists.')
    return app
  }
  root(app: QuickApp): string {
    if (app.hostId !== this.hostId) throw new QuickAppError(503, 'QUICK_APP_HOST_UNAVAILABLE', 'The owning Host is not connected through a verified Quick Apps route.')
    const root = this.workspaceRoot(app.workspaceId)
    if (!root) throw new QuickAppError(404, 'QUICK_APP_WORKSPACE_UNAVAILABLE', 'The exact workspace is unavailable.')
    return root
  }
  async validate(app: QuickApp): Promise<void> {
    if (app.hostId !== this.hostId && this.remoteValidate) { await this.remoteValidate(app); return }
    const root = this.root(app)
    if (!withinScope(app.documentRoot, app.entryPath) || !publicPath(app.entryPath)) deny()
    if (!(await stat(await resolveAppPath(root, app.documentRoot))).isDirectory()) deny()
    if (!(await stat(await resolveAppPath(root, app.entryPath))).isFile()) deny()
    for (const mount of app.mounts) if (!(await stat(await resolveAppPath(root, mount.workspacePath))).isDirectory()) deny()
  }
  async availability(app: QuickApp, htmlAvailable: boolean): Promise<QuickAppAvailability> {
    if (app.hostId !== this.hostId) return 'disconnected-host'
    if (!this.workspaceRoot(app.workspaceId)) return 'missing-workspace'
    try { await this.validate(app) } catch { return 'missing-file' }
    return app.kind === 'html' && !htmlAvailable ? 'unsupported-runtime' : 'available'
  }
  upsert(input: unknown, expectedRevision: number): Promise<QuickApp> {
    return this.serialize(async () => {
      const data = parseDefinition(input)
      const apps = this.list()
      const existing = data.id ? apps.find(app => app.id === data.id) : undefined
      if (existing ? expectedRevision !== existing.revision : expectedRevision !== 0 || Boolean(data.id)) conflict()
      if (!existing && apps.length >= QUICK_APP_LIMITS.shortcuts) throw new QuickAppError(429, 'QUICK_APP_LIMIT', 'Too many shortcuts.')
      const app: QuickApp = { ...data, id: existing?.id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1 }
      await this.validate(app)
      await this.storage.write([...apps.filter(item => item.id !== app.id), app])
      return app
    })
  }
  remove(id: string, expectedRevision: number): Promise<void> {
    return this.serialize(async () => {
      if (this.get(id).revision !== expectedRevision) conflict()
      await this.storage.write(this.list().filter(app => app.id !== id))
    })
  }
  reorder(input: unknown): Promise<readonly QuickApp[]> {
    return this.serialize(async () => {
      if (!Array.isArray(input) || input.length > QUICK_APP_LIMITS.shortcuts) deny('Invalid shortcut order.')
      const expected = new Map<string, number>()
      for (const item of input) {
        if (!item || typeof item.id !== 'string' || !Number.isSafeInteger(item.expectedRevision) || expected.has(item.id)) deny('Invalid shortcut order.')
        expected.set(item.id, item.expectedRevision)
      }
      const apps = this.list()
      if (apps.length !== expected.size || apps.some(app => expected.get(app.id) !== app.revision)) conflict()
      const byId = new Map(apps.map(app => [app.id, app]))
      const ordered = [...expected.keys()].map((id, order) => {
        const app = byId.get(id)!
        return app.order === order ? app : { ...app, order, revision: app.revision + 1 }
      })
      // Ordering only changes metadata, including shortcuts whose Host or source is unavailable.
      if (ordered.some(app => app !== byId.get(app.id))) await this.storage.write(ordered)
      return ordered
    })
  }
  revokeWorkspaceAccess(id: string, expectedRevision: number): Promise<QuickApp> {
    return this.serialize(async () => {
      const app = this.get(id)
      if (app.revision !== expectedRevision) conflict()
      if (app.fileAccess !== 'workspace') return app
      const { fileAccess: _access, ...definition } = app
      const updated = { ...definition, revision: app.revision + 1 }
      // Revocation must work even when the entry or workspace is no longer accessible.
      await this.storage.write(this.list().map(item => item.id === id ? updated : item))
      return updated
    })
  }
  async dispose(): Promise<void> { this.stopped = true; await this.pending.catch(() => undefined) }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(() => {
      if (this.stopped) throw new QuickAppError(410, 'QUICK_APP_REVOKED', 'Quick Apps is disabled.')
      return operation()
    })
    this.pending = next
    return next
  }
}

/** Ordering revisions protect metadata writes without changing launch files or permissions. */
export function quickAppDefinitionKey(app: QuickApp): string {
  const { order: _order, revision: _revision, ...definition } = app
  return JSON.stringify(definition)
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512 || /[\x00-\x1f]/u.test(value)) deny('Invalid shortcut metadata.')
  return value.trim()
}

export function parseDefinition(input: unknown): Omit<QuickApp, 'revision'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) deny()
  const value = input as Record<string, unknown>
  if (value.kind !== 'html' && value.kind !== 'text') deny()
  if (value.fileAccess !== undefined && value.fileAccess !== 'workspace') deny('Invalid workspace access policy.')
  if (!Array.isArray(value.mounts) || value.mounts.length > 8 || typeof value.spaFallback !== 'boolean' || !Number.isSafeInteger(value.order)) deny()
  const prefixes: string[] = []
  const mounts = value.mounts.map(item => {
    if (!item || typeof item !== 'object' || item.read !== true || typeof item.urlPrefix !== 'string' || !item.urlPrefix.startsWith('/')) deny()
    const prefix = appPath(item.urlPrefix.slice(1), false)
    if (prefix === '__quickapp' || prefix.startsWith('__quickapp/') || prefixes.some(previous => withinScope(previous, prefix) || withinScope(prefix, previous))) deny('Overlapping or reserved mount.')
    prefixes.push(prefix)
    const workspacePath = appPath(item.workspacePath)
    if (!publicPath(workspacePath)) deny()
    return { urlPrefix: `/${prefix}`, workspacePath, read: true as const }
  })
  const entryPath = appPath(value.entryPath, false)
  if (value.kind === 'html' && !/\.html?$/iu.test(entryPath)) deny('Choose an HTML entry file.')
  return { id: value.id ? text(value.id) : '', title: text(value.title), hostId: text(value.hostId), workspaceId: text(value.workspaceId),
    ...(value.kind === 'html' && value.fileAccess === 'workspace' ? { fileAccess: 'workspace' as const } : {}),
    entryPath, documentRoot: appPath(value.documentRoot), kind: value.kind, spaFallback: value.spaFallback, mounts, order: value.order as number }
}

export function parsePermissions(value: unknown): QuickAppPermissions {
  if (!value || typeof value !== 'object') deny()
  const input = value as Record<string, unknown>
  const paths = (key: string): string[] => {
    if (!Array.isArray(input[key]) || input[key].length > 8) deny('Invalid file permissions.')
    return input[key].map((path: unknown) => { const normalized = appPath(path); if (!publicPath(normalized)) deny(); return normalized })
  }
  return { read: paths('read'), write: paths('write'), delete: paths('delete') }
}
