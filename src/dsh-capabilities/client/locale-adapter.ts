/** Locale 能力的内部最小接口，避免功能模块直接依赖 DSH 类型。 */
export interface CodingNsLocaleService<T = unknown> {
  bind(namespace: string): unknown
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  register(namespace: string, messages: Record<string, string>): unknown
}

export function createLocaleService<T>(runtime: CodingNsLocaleService<T>): CodingNsLocaleService<T> {
  return runtime
}
