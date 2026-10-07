import { ASSISTANT_AVATAR_MAX_MODELS, BUILTIN_ASSISTANT_AVATAR_SOURCES, resolveAssistantAvatarAsset } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarModel, AssistantAvatarSurface } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices } from '../features/types.js'
import type { AssistantAvatarRenderer } from './registry.js'
import { AssistantAvatarPreviewStore, assistantAvatarPreviewKey, assistantAvatarPreviewStore, validAssistantAvatarPreview } from './preview-store.js'
import type { AssistantAvatarPreview } from './preview-store.js'
import { createAssistantAvatarPortraitFromPreview } from './portrait-capture.js'

export interface AssistantAvatarPortraitSnapshot { readonly key: string; readonly url?: string }
type PortraitStore = Pick<AssistantAvatarPreviewStore, 'read' | 'write' | 'removeModel'>
interface PortraitEntry {
  readonly model: AssistantAvatarModel
  readonly asset: AssistantAvatarModel
  renderer: AssistantAvatarRenderer | undefined
  snapshot: AssistantAvatarPortraitSnapshot
  readonly listeners: Set<() => void>
  refs: number
  touched: number
  completed: boolean
  overrideChecked: boolean
  controller: AbortController | undefined
}
export const assistantAvatarPortraitStore = new AssistantAvatarPreviewStore(undefined, undefined, 'codingns-assistant-avatar-portraits')
/** 用户确认的头像属于本地配置，不按临时预览的 30 天规则失效。 */
export const assistantAvatarPortraitOverrideStore = new AssistantAvatarPreviewStore(undefined, undefined,
  'codingns-assistant-avatar-portrait-overrides', { maxAgeMs: Infinity, maxEntries: ASSISTANT_AVATAR_MAX_MODELS })

/** 头像始终采用对话形象的待机构图，语音状态、名称和显示尺寸不参与缓存键。 */
export function assistantAvatarPortraitKey(model: AssistantAvatarModel, renderer: AssistantAvatarRenderer | undefined): string {
  const asset = resolveAssistantAvatarAsset(model, 'dialog')
  return JSON.stringify(['portrait', 1, renderer?.previewVersion ?? '', assistantAvatarPreviewKey(model, 'dialog', renderer?.portraitVersion ?? ''),
    asset.renderer === 'builtin' ? BUILTIN_ASSISTANT_AVATAR_SOURCES[model.id] : ''])
}
function validPortrait(value: unknown): value is AssistantAvatarPreview {
  return validAssistantAvatarPreview(value) && value.width === value.height && value.width <= 256
}
function sameAsset(a: AssistantAvatarModel, b: AssistantAvatarModel): boolean {
  // 展示位置可以不同，但必须确实使用同一份模型与构图，不能拿桌前版替代全身版头像。
  return assistantAvatarPreviewKey(a, 'dialog', '') === assistantAvatarPreviewKey({ ...b, surfaces: {} }, 'dialog', '')
}

/** 每个 Client 共用一个任务和临时 URL；多条消息不会创建多个图片或 WebGL 实例。 */
export class AssistantAvatarPortraitService {
  private readonly entries = new Map<string, PortraitEntry>()
  private clock = 0
  constructor(private readonly store: PortraitStore = assistantAvatarPortraitStore,
    private readonly previews: Pick<AssistantAvatarPreviewStore, 'read'> = assistantAvatarPreviewStore,
    private readonly crop: typeof createAssistantAvatarPortraitFromPreview = createAssistantAvatarPortraitFromPreview,
    private readonly createUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
    private readonly revokeUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
    private readonly overrides: PortraitStore = assistantAvatarPortraitOverrideStore) {}

  /** 编辑器仅在用户打开时读取完整静态帧，普通头像订阅不增加素材加载。 */
  async getSource(model: AssistantAvatarModel, renderer: AssistantAvatarRenderer | undefined, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
    const asset = resolveAssistantAvatarAsset(model, 'dialog')
    const manual = await this.overrides.read(assistantAvatarPortraitKey(model, renderer), signal).catch(() => undefined)
    const withArea = (frame: AssistantAvatarPreview): AssistantAvatarPreview => ({ ...frame,
      ...(manual?.cropAreaPercentages === undefined ? {} : { cropAreaPercentages: manual.cropAreaPercentages }) })
    if (renderer?.previewVersion !== undefined) {
      for (const surface of ['dialog', 'floating'] as const) {
        if (!sameAsset(asset, resolveAssistantAvatarAsset(model, surface))) continue
        const frame = await this.previews.read(assistantAvatarPreviewKey(model, surface, renderer.previewVersion), signal).catch(() => undefined)
        if (signal.aborted) return undefined
        if (validAssistantAvatarPreview(frame)) return withArea(frame)
      }
    }
    if (signal.aborted) return undefined
    const frame = await renderer?.createPortraitSource?.(asset, signal)
    if (signal.aborted) return undefined
    if (validAssistantAvatarPreview(frame)) return withArea(frame)
    // 旧扩展只提供头像时仍能微调，不能因此禁用原来的形象。
    const fallback = manual ?? await this.store.read(assistantAvatarPortraitKey(model, renderer), signal)
    // 已裁好的旧扩展头像没有原始坐标空间，不能再次套用原图百分比。
    return fallback === undefined ? undefined : { blob: fallback.blob, width: fallback.width, height: fallback.height }
  }

  /** 先确保持久化成功才发布，存储失败和取消都保留当前头像。 */
  async setPortrait(model: AssistantAvatarModel, renderer: AssistantAvatarRenderer | undefined,
    preview: AssistantAvatarPreview, signal: AbortSignal): Promise<void> {
    if (!validPortrait(preview)) throw new TypeError('avatar_portrait_invalid')
    signal.throwIfAborted()
    const entry = this.entry(model, renderer), controller = new AbortController()
    entry.controller?.abort(); entry.controller = controller
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const saved = await this.overrides.write(entry.snapshot.key, model.id, 'dialog', preview, controller.signal)
      signal.throwIfAborted()
      if (!saved || entry.controller !== controller || controller.signal.aborted) throw new Error('avatar_portrait_write_failed')
      this.publish(entry, preview); entry.completed = true
    } finally {
      signal.removeEventListener('abort', abort)
      if (entry.controller === controller) entry.controller = undefined
    }
  }

  getSnapshot(model: AssistantAvatarModel, renderer: AssistantAvatarRenderer | undefined): AssistantAvatarPortraitSnapshot {
    return this.entry(model, renderer).snapshot
  }
  subscribe(model: AssistantAvatarModel, renderer: AssistantAvatarRenderer | undefined, listener: () => void): () => void {
    const entry = this.entry(model, renderer)
    entry.listeners.add(listener)
    return () => { entry.listeners.delete(listener); this.trim() }
  }
  retain(model: AssistantAvatarModel, renderer: AssistantAvatarRenderer | undefined): () => void {
    const entry = this.entry(model, renderer)
    entry.refs++; entry.touched = ++this.clock
    if (!entry.completed && entry.controller === undefined) this.start(entry)
    return () => {
      entry.refs = Math.max(0, entry.refs - 1)
      if (entry.refs === 0) { entry.controller?.abort(); entry.controller = undefined }
      this.trim()
    }
  }

  /** 插槽已绘制的帧优先于临时渲染任务；取消旧任务并隔离迟到结果。 */
  offerPreview(model: AssistantAvatarModel, surface: AssistantAvatarSurface, renderer: AssistantAvatarRenderer, preview: AssistantAvatarPreview): void {
    if (!validAssistantAvatarPreview(preview)) return
    const asset = resolveAssistantAvatarAsset(model, surface)
    for (const entry of this.entries.values()) {
      if (entry.refs === 0 || !entry.overrideChecked || entry.snapshot.url !== undefined || entry.renderer !== renderer || !sameAsset(entry.asset, asset)) continue
      entry.controller?.abort()
      const controller = new AbortController()
      entry.controller = controller; entry.completed = false
      void this.crop(preview, controller.signal).then((portrait) => this.commit(entry, controller, portrait)).catch(() => undefined)
        .finally(() => this.finish(entry, controller))
    }
  }
  removeModel(id: string): void {
    for (const entry of this.entries.values()) {
      if (entry.model.id !== id) continue
      entry.controller?.abort(); entry.controller = undefined; entry.completed = false
      if (entry.snapshot.url !== undefined) this.revokeUrl(entry.snapshot.url)
      entry.snapshot = { key: entry.snapshot.key }
      for (const listener of entry.listeners) listener()
      if (entry.refs === 0 && entry.listeners.size === 0) this.entries.delete(entry.snapshot.key)
    }
    void this.store.removeModel(id).catch(() => undefined)
    void this.overrides.removeModel(id).catch(() => undefined)
  }

  /** 配置窗口销毁时回收仅供本地预览使用的资源地址。 */
  dispose(): void { for (const entry of this.entries.values()) { entry.controller?.abort(); if (entry.snapshot.url !== undefined) this.revokeUrl(entry.snapshot.url) }; this.entries.clear() }

  private entry(model: AssistantAvatarModel, renderer: AssistantAvatarRenderer | undefined): PortraitEntry {
    const key = assistantAvatarPortraitKey(model, renderer)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = { model, asset: resolveAssistantAvatarAsset(model, 'dialog'), renderer, snapshot: { key }, listeners: new Set(),
        refs: 0, touched: ++this.clock, completed: false, overrideChecked: false, controller: undefined }
      this.entries.set(key, entry)
    } else if (entry.renderer !== renderer) {
      entry.controller?.abort(); entry.controller = undefined; entry.renderer = renderer
      entry.completed = entry.snapshot.url !== undefined
    }
    return entry
  }
  private start(entry: PortraitEntry): void {
    const controller = new AbortController()
    entry.controller = controller
    void this.load(entry, controller.signal).then((preview) => this.commit(entry, controller, preview)).catch(() => undefined)
      .finally(() => this.finish(entry, controller))
  }
  private async load(entry: PortraitEntry, signal: AbortSignal): Promise<AssistantAvatarPreview | undefined> {
    const manual = await this.overrides.read(entry.snapshot.key, signal).catch(() => undefined)
    if (signal.aborted || validPortrait(manual)) return signal.aborted ? undefined : manual
    entry.overrideChecked = true
    const cached = await this.store.read(entry.snapshot.key, signal).catch(() => undefined)
    if (signal.aborted || validPortrait(cached)) return signal.aborted ? undefined : cached
    const version = entry.renderer?.previewVersion
    if (version !== undefined) {
      for (const surface of ['dialog', 'floating'] as const) {
        if (!sameAsset(entry.asset, resolveAssistantAvatarAsset(entry.model, surface))) continue
        const frame = await this.previews.read(assistantAvatarPreviewKey(entry.model, surface, version), signal).catch(() => undefined)
        if (signal.aborted) return undefined
        if (frame === undefined) continue
        const portrait = await this.crop(frame, signal)
        if (portrait !== undefined || signal.aborted) return portrait
      }
    }
    return signal.aborted ? undefined : entry.renderer?.createPortrait?.(entry.asset, signal)
  }
  private commit(entry: PortraitEntry, controller: AbortController, preview: AssistantAvatarPreview | undefined): void {
    if (entry.controller !== controller || controller.signal.aborted || !validPortrait(preview)) return
    this.publish(entry, preview)
    void this.store.write(entry.snapshot.key, entry.model.id, 'dialog', preview, controller.signal).catch(() => undefined)
  }
  private publish(entry: PortraitEntry, preview: AssistantAvatarPreview): void {
    const previous = entry.snapshot.url, url = this.createUrl(preview.blob)
    entry.snapshot = { key: entry.snapshot.key, url }; entry.touched = ++this.clock
    for (const listener of entry.listeners) listener()
    if (previous !== undefined) this.revokeUrl(previous)
  }
  private finish(entry: PortraitEntry, controller: AbortController): void {
    if (entry.controller !== controller) return
    entry.controller = undefined; entry.completed = !controller.signal.aborted
    this.trim()
  }
  private trim(): void {
    // 已使用头像可复用八个；只回收没有订阅者的 URL，避免正在显示的图片失效。
    const idle = [...this.entries.values()].filter((entry) => entry.refs === 0 && entry.listeners.size === 0).sort((a, b) => b.touched - a.touched)
    for (const entry of idle.slice(8)) {
      entry.controller?.abort()
      if (entry.snapshot.url !== undefined) this.revokeUrl(entry.snapshot.url)
      this.entries.delete(entry.snapshot.key)
    }
  }
}
const services = new WeakMap<CodingNsClientServices, AssistantAvatarPortraitService>()
export function bindAssistantAvatarPortraitService(client: CodingNsClientServices, service: AssistantAvatarPortraitService): void { services.set(client, service) }
export function getAssistantAvatarPortraitService(client: CodingNsClientServices): AssistantAvatarPortraitService {
  let service = services.get(client)
  if (service === undefined) { service = new AssistantAvatarPortraitService(); services.set(client, service) }
  return service
}
