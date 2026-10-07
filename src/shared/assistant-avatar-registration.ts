/** 所有形象适配器与渲染器共用稳定注册快照；注销只清理自己的一代。 */
export class AssistantAvatarRegistration<T extends { readonly id: string }> {
  private readonly entries = new Map<string, T>()
  private readonly reserved: Set<string>
  private readonly listeners = new Set<() => void>()
  private snapshot: readonly T[]
  constructor(builtins: readonly T[] = []) {
    for (const entry of builtins) this.entries.set(entry.id, entry)
    this.reserved = new Set(this.entries.keys())
    this.snapshot = Object.freeze([...this.entries.values()])
  }
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = (): readonly T[] => this.snapshot
  get(id: string): T | undefined { return this.entries.get(id) }
  register(entry: T): () => void {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(entry.id) || this.reserved.has(entry.id)) throw new TypeError('形象扩展 ID 无效或占用内置名称')
    if (this.entries.has(entry.id)) throw new TypeError(`形象扩展已注册: ${entry.id}`)
    this.entries.set(entry.id, entry); this.emit()
    return () => {
      if (this.entries.get(entry.id) !== entry) return
      this.entries.delete(entry.id); this.emit()
    }
  }
  private emit(): void { this.snapshot = Object.freeze([...this.entries.values()]); for (const listener of this.listeners) listener() }
}
