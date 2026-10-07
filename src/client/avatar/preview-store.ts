import { resolveAssistantAvatarAsset } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarModel, AssistantAvatarSurface } from '../../shared/assistant-avatar.js'

/** 预览只包含透明 PNG，第三方渲染器也通过相同接口提交。 */
export interface AssistantAvatarPreview {
  readonly blob: Blob
  readonly width: number
  readonly height: number
  /** 用户头像在原始静态帧中的百分比裁剪区域；普通全身预览无需填写。 */
  readonly cropAreaPercentages?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}
interface PreviewRecord extends AssistantAvatarPreview {
  readonly key: string
  readonly modelId: string
  readonly surface: AssistantAvatarSurface
  readonly savedAt: number
}
export const AVATAR_PREVIEW_MAX_EDGE = 512
export const AVATAR_PREVIEW_MAX_BYTES = 512 * 1024
export const AVATAR_PREVIEW_MAX_ENTRIES = 8
const MAX_AGE = 30 * 24 * 60 * 60 * 1000
const DATABASE = 'codingns-assistant-avatar-previews'
const STORE = 'previews'

/** 排序映射，避免设置归一化复制对象或属性顺序变化造成无效缓存。 */
export function assistantAvatarPreviewKey(model: AssistantAvatarModel, surface: AssistantAvatarSurface, rendererVersion: string,
  baseUrl: string | undefined = typeof document === 'undefined' ? undefined : document.baseURI): string {
  const asset = resolveAssistantAvatarAsset(model, surface)
  const url = (source: string): string => { try { return new URL(source, baseUrl).href } catch { return source } }
  const entries = (map: Readonly<Record<string, string>> | undefined) => Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([1, model.id, surface, rendererVersion, asset.renderer, url(asset.source), asset.spriteVersion,
    asset.live2d?.scale ?? 1, asset.live2d?.position ?? [0, 0], entries(asset.motionGroups), entries(asset.stateSources).map(([state, source]) => [state, url(source)])])
}

export function validAssistantAvatarPreview(value: unknown): value is AssistantAvatarPreview {
  if (value === null || typeof value !== 'object') return false
  const preview = value as Partial<AssistantAvatarPreview>
  return preview.blob instanceof Blob && preview.blob.type === 'image/png' && preview.blob.size > 0 && preview.blob.size <= AVATAR_PREVIEW_MAX_BYTES
    && Number.isSafeInteger(preview.width) && Number.isSafeInteger(preview.height)
    && preview.width! > 0 && preview.height! > 0 && preview.width! <= AVATAR_PREVIEW_MAX_EDGE && preview.height! <= AVATAR_PREVIEW_MAX_EDGE
    && (preview.cropAreaPercentages === undefined || validCropArea(preview.cropAreaPercentages))
}
function validCropArea(area: NonNullable<AssistantAvatarPreview['cropAreaPercentages']>): boolean {
  return area !== null && typeof area === 'object' && [area.x, area.y, area.width, area.height].every(Number.isFinite)
    && area.x >= 0 && area.y >= 0 && area.width > 0 && area.height > 0 && area.x + area.width <= 100.001 && area.y + area.height <= 100.001
}

/** 开库和事务都有短超时；存储不可用只丢失预览，不影响模型显示。 */
export class AssistantAvatarPreviewStore {
  private database: Promise<IDBDatabase | undefined> | undefined
  constructor(private readonly factory: () => IDBFactory | undefined = () => typeof indexedDB === 'undefined' ? undefined : indexedDB,
    private readonly now: () => number = Date.now,
    private readonly databaseName = DATABASE,
    private readonly limits: { readonly maxAgeMs?: number; readonly maxEntries?: number } = {}) {}

  async read(key: string, signal?: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
    return this.transaction('readonly', (store, result) => {
      const request = store.get(key)
      request.onsuccess = () => {
        const record = request.result as PreviewRecord | undefined
        if (this.validRecord(record) && record.key === key) result({ blob: record.blob, width: record.width, height: record.height,
          ...(record.cropAreaPercentages === undefined ? {} : { cropAreaPercentages: record.cropAreaPercentages }) })
      }
    }, signal)
  }

  async write(key: string, modelId: string, surface: AssistantAvatarSurface, preview: AssistantAvatarPreview, signal?: AbortSignal): Promise<boolean> {
    if (!validAssistantAvatarPreview(preview)) return false
    return await this.transaction<boolean>('readwrite', (store, result) => {
      const request = store.getAll()
      request.onsuccess = () => {
        const records: PreviewRecord[] = []
        for (const entry of request.result as PreviewRecord[]) {
          // 同一形象/展示位置只留最新版本；默认预览最多 8 项，用户头像可配置独立上限。
          if (!this.validRecord(entry) || (entry.modelId === modelId && entry.surface === surface)) store.delete(entry.key)
          else records.push(entry)
        }
        records.sort((a, b) => b.savedAt - a.savedAt)
        for (const entry of records.slice((this.limits.maxEntries ?? AVATAR_PREVIEW_MAX_ENTRIES) - 1)) store.delete(entry.key)
        store.put({ key, modelId, surface, ...preview, savedAt: this.now() } satisfies PreviewRecord)
        result(true)
      }
    }, signal) ?? false
  }

  async remove(key: string): Promise<void> { await this.transaction('readwrite', (store) => { store.delete(key) }) }
  async removeModel(modelId: string): Promise<void> {
    await this.transaction('readwrite', (store) => {
      const request = store.getAll()
      request.onsuccess = () => { for (const entry of request.result as PreviewRecord[]) if (entry.modelId === modelId) store.delete(entry.key) }
    })
  }

  private validRecord(value: unknown): value is PreviewRecord {
    if (!validAssistantAvatarPreview(value)) return false
    const entry = value as PreviewRecord
    return typeof entry.key === 'string' && typeof entry.modelId === 'string' && (entry.surface === 'floating' || entry.surface === 'dialog')
      && Number.isFinite(entry.savedAt) && entry.savedAt <= this.now() && this.now() - entry.savedAt < (this.limits.maxAgeMs ?? MAX_AGE)
  }

  private open(): Promise<IDBDatabase | undefined> {
    if (this.database !== undefined) return this.database
    const task = new Promise<IDBDatabase | undefined>((resolve) => {
      let request: IDBOpenDBRequest
      try {
        const factory = this.factory()
        if (factory === undefined) { resolve(undefined); return }
        request = factory.open(this.databaseName, 1)
      } catch { resolve(undefined); return }
      let settled = false
      const finish = (database?: IDBDatabase): void => { if (settled) { database?.close(); return }; settled = true; clearTimeout(timer); resolve(database) }
      const timer = setTimeout(() => finish(), 1000)
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' }) }
      request.onerror = () => finish()
      request.onblocked = () => finish()
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.database = undefined }
        finish(request.result)
      }
    })
    this.database = task
    void task.then((database) => { if (database === undefined && this.database === task) this.database = undefined })
    return task
  }

  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void) => void,
    signal?: AbortSignal): Promise<T | undefined> {
    if (signal?.aborted) return undefined
    const database = await this.open()
    if (database === undefined || signal?.aborted) return undefined
    return new Promise((resolve) => {
      let transaction: IDBTransaction
      try { transaction = database.transaction(STORE, mode) } catch { this.database = undefined; resolve(undefined); return }
      let value: T | undefined
      const abort = (): void => { try { transaction.abort() } catch { /* 事务已结束，无需再次处理。 */ } }
      const timer = setTimeout(abort, 1000)
      const finish = (success: boolean): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(success ? value : undefined) }
      transaction.oncomplete = () => finish(true)
      transaction.onabort = () => finish(false)
      transaction.onerror = () => finish(false)
      signal?.addEventListener('abort', abort, { once: true })
      try { action(transaction.objectStore(STORE), (next) => { value = next }) } catch { abort(); finish(false) }
    })
  }
}

export const assistantAvatarPreviewStore = new AssistantAvatarPreviewStore()
