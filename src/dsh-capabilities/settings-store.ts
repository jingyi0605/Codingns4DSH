/**
 * CodingNS 内部设置存储契约。
 *
 * 业务模块只依赖这个最小接口，不直接依赖 DSH 的 SettingsScope 或未来的
 * ConfigForm。不同 DSH 版本的读写、revision 和订阅语义都在边界适配器中收敛。
 */
export interface CodingNsSettingsSnapshot<T> {
  readonly value: T | undefined
  readonly revision: number | undefined
  readonly writable: boolean
  readonly status: 'loading' | 'ready' | 'unavailable'
}

export interface CodingNsSettingsOperation {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

export interface CodingNsSettingsStore<T> {
  getSnapshot(): CodingNsSettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(operations: readonly CodingNsSettingsOperation[], expectedRevision?: number): Promise<boolean>
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
  load?(): Promise<void>
  dispose?(): void | Promise<void>
}

/** 将任意 Promise<void> 写入适配成内部统一的成功布尔值。 */
export function accepted(write: Promise<void>): Promise<boolean> {
  return write.then(() => true)
}
