import type { AssistantAvatarCatalogEntry, AssistantAvatarTemporaryPreview } from '../../shared/assistant-avatar-catalog.js'
import type { AssistantAvatarManager } from './manager.js'

type PreviewManager = Pick<AssistantAvatarManager, 'previewCatalog' | 'releasePreview' | 'keepPreview'>

/** 挂载即启动预览；离开后隔离所有回调，避免旧下载覆盖新形象或关闭后的界面。 */
export function startAssistantAvatarTemporaryPreview(manager: PreviewManager, entry: Pick<AssistantAvatarCatalogEntry, 'id' | 'revision'>, observer: {
  readonly onLoaded: (preview: AssistantAvatarTemporaryPreview) => void
  readonly onError: (error: unknown) => void
  readonly onSettled: () => void
}): { dispose(): Promise<void> } {
  let active = true
  const session = new AssistantAvatarTemporaryPreviewSession(manager, (error) => { if (active) observer.onError(error) })
  void session.load(entry).then((preview) => { if (active) observer.onLoaded(preview) })
    .catch((error) => { if (active) observer.onError(error) })
    .finally(() => { if (active) observer.onSettled() })
  return { dispose: async () => { active = false; await session.dispose() } }
}

/** 客户端拥有一个临时预览租约，取消先释放，迟到答复再次释放，绝不登记到设置。 */
export class AssistantAvatarTemporaryPreviewSession {
  readonly lease: string
  private readonly controller = new AbortController()
  private disposed = false
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(private readonly manager: PreviewManager,
    private readonly onExpired: (error: unknown) => void = () => {}, lease = crypto.randomUUID()) { this.lease = lease }

  async load(entry: Pick<AssistantAvatarCatalogEntry, 'id' | 'revision'>): Promise<AssistantAvatarTemporaryPreview> {
    this.controller.signal.throwIfAborted()
    try {
      // 下载期间也保持租约，避免慢网络下尚未加载完成就被超时清理。
      this.timer = setInterval(() => {
        void this.manager.keepPreview(this.lease).catch((error) => {
          if (this.disposed) return
          this.onExpired(error); void this.dispose().catch(() => undefined)
        })
      }, 60_000)
      const preview = await this.manager.previewCatalog(entry.id, entry.revision, this.lease, this.controller.signal)
      if (this.disposed) { await this.manager.releasePreview(this.lease); this.controller.signal.throwIfAborted() }
      return preview
    } catch (error) { await this.dispose().catch(() => undefined); throw error }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.controller.abort()
    if (this.timer !== undefined) clearInterval(this.timer)
    await this.manager.releasePreview(this.lease)
  }
}
