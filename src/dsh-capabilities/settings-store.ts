/**
 * Codingns4DSH 内部设置存储契约。
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
  /** Host 专用业务 RPC 修改设置后，显式重读权威快照；普通 load 保持缓存语义。 */
  reload?(): Promise<void>
  dispose?(): void | Promise<void>
}

/** 将 DSH 两代写入结果统一成内部成功布尔值。 */
export function accepted(write: Promise<void | boolean>): Promise<boolean> {
  return write.then((result) => result !== false)
}

/**
 * 判断两份设置快照在内容上是否等价。
 *
 * DSH 的 ConfigForm、SettingsScope 和插件自己的 Host RPC 都会在每次读取时
 * 构造新对象。`useSyncExternalStore` 要求 `getSnapshot()` 在内容未变化时返回
 * 同一个引用，否则 React 会在每次渲染后重新比对快照并强制再次渲染，直到抛出
 * “Maximum update depth exceeded”（React #185）。所有适配器都必须先比较内容、
 * 再决定是否替换快照并唤醒订阅者。
 */
export function sameSettingsSnapshot<T>(
  left: CodingNsSettingsSnapshot<T>,
  right: CodingNsSettingsSnapshot<T>,
): boolean {
  return sameSettingsValue(left.value, right.value)
    && left.revision === right.revision
    && left.writable === right.writable
    && left.status === right.status
}

/** 设置内容的结构比较：数组按顺序、对象按键，标量按 Object.is。 */
export function sameSettingsValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameSettingsValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameSettingsValue(leftRecord[key], rightRecord[key]))
}
