import type { QuickApp } from './contracts/quick-apps.js'

export const QUICK_APP_STORAGE_PROTOCOL = 'codingns.quick-app-storage.v1'
export const QUICK_APP_STORAGE_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, keys: 1024, pending: 64, timeoutMs: 10_000 })
export type QuickAppStorageArea = 'local' | 'session'
export type QuickAppStorageEntries = [string, string][]
export interface QuickAppStorageAreaApi {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  clear(): Promise<void>
  keys(): Promise<string[]>
  flush(): Promise<void>
}
export interface QuickAppStorageApi extends QuickAppStorageAreaApi {
  readonly session: QuickAppStorageAreaApi
}
export interface QuickAppStorageRequest {
  id: number
  area: QuickAppStorageArea
  operation: 'getItem' | 'setItem' | 'removeItem' | 'clear' | 'keys' | 'flush'
  key?: string
  value?: string
}

/** Metadata changes preserve storage; reassignment to another source does not. */
export function quickAppStorageKey(app: Pick<QuickApp, 'id' | 'hostId' | 'workspaceId' | 'documentRoot' | 'entryPath'>): string {
  return `codingns.quickApps.storage.v1:${JSON.stringify([app.hostId, app.workspaceId, app.id, app.documentRoot, app.entryPath])}`
}

export function validateQuickAppStorageEntries(value: unknown): asserts value is QuickAppStorageEntries {
  if (!Array.isArray(value)) throw new DOMException('Invalid application storage data.', 'DataError')
  if (value.length > QUICK_APP_STORAGE_LIMITS.keys) throw new DOMException('Application storage quota exceeded.', 'QuotaExceededError')
  if (Array.from(value).some(entry => !Array.isArray(entry) || entry.length !== 2 || Array.from(entry).some(part => typeof part !== 'string'))
    || new Set(value.map(entry => entry[0])).size !== value.length) throw new DOMException('Invalid application storage data.', 'DataError')
  if (JSON.stringify(value).length * 2 > QUICK_APP_STORAGE_LIMITS.bytes) throw new DOMException('Application storage quota exceeded.', 'QuotaExceededError')
}

export function isQuickAppStorageRequest(value: unknown): value is QuickAppStorageRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  if (Object.keys(request).some(key => !['id', 'area', 'operation', 'key', 'value'].includes(key))
    || !Number.isSafeInteger(request.id) || Number(request.id) < 1 || (request.area !== 'local' && request.area !== 'session') || typeof request.operation !== 'string') return false
  if (request.operation === 'setItem') return typeof request.key === 'string' && typeof request.value === 'string'
    && (request.key.length + request.value.length) * 2 <= QUICK_APP_STORAGE_LIMITS.bytes
  if (request.operation === 'getItem' || request.operation === 'removeItem') return typeof request.key === 'string'
    && request.key.length * 2 <= QUICK_APP_STORAGE_LIMITS.bytes && request.value === undefined
  return ['clear', 'keys', 'flush'].includes(request.operation) && request.key === undefined && request.value === undefined
}
