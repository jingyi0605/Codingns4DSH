/** 屏幕由终端模型持有；卡片只借用显示位置，不拥有屏幕的销毁权。 */
export class TerminalSurfaceCache<T extends { dispose(): void }> {
  private readonly surfaces = new WeakMap<object, T>()

  get(owner: { readonly signal: AbortSignal }, create: () => T): T {
    if (owner.signal.aborted) throw new Error('终端模型已销毁')
    const existing = this.surfaces.get(owner)
    if (existing !== undefined) return existing
    const surface = create()
    this.surfaces.set(owner, surface)
    owner.signal.addEventListener('abort', () => {
      this.surfaces.delete(owner)
      surface.dispose()
    }, { once: true })
    return surface
  }
}
