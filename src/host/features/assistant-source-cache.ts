/** 同一 Host 的并发元数据读取共享任务；完成后释放，不缓存活动状态。 */
export class AssistantSourceCache {
  private readonly loads = new Map<string, Promise<unknown>>()
  private readonly titles = new Map<string, { signature: string; expiresAt: number; value: Promise<string | null> }>()
  private titleReads = 0
  private readonly titleQueue: Array<() => void> = []

  share<T>(key: string, read: () => Promise<T>): Promise<T> {
    const pending = this.loads.get(key)
    if (pending !== undefined) return pending as Promise<T>
    const operation = Promise.resolve().then(read).finally(() => { if (this.loads.get(key) === operation) this.loads.delete(key) })
    this.loads.set(key, operation)
    return operation
  }

  invalidateTitle(sessionId: string): void { this.titles.delete(sessionId) }

  title(sessionId: string, signature: string, versioned: boolean, read: () => Promise<string | null>): Promise<string | null> {
    const previous = this.titles.get(sessionId)
    if (previous?.signature === signature && previous.expiresAt > Date.now()) return previous.value
    // 标题可能来自磁盘；只允许四个并发读取，避免大量历史会话同时排满 IO 队列。
    const value = (async () => {
      await new Promise<void>((resolve) => {
        const enter = (): void => { this.titleReads += 1; resolve() }
        if (this.titleReads < 4) enter(); else this.titleQueue.push(enter)
      })
      try { return await read() }
      finally { this.titleReads -= 1; this.titleQueue.shift()?.() }
    })()
    this.titles.set(sessionId, { signature, expiresAt: versioned ? Infinity : Date.now() + 60_000, value })
    // 已被删除或不再管理的会话不能无限占用缓存。
    if (this.titles.size > 2_000) this.titles.delete(this.titles.keys().next().value!)
    void value.catch(() => { if (this.titles.get(sessionId)?.value === value) this.titles.delete(sessionId) })
    return value
  }
}

const caches = new WeakMap<object, AssistantSourceCache>()
export function assistantSourceCache(host: object): AssistantSourceCache {
  let cache = caches.get(host)
  if (cache === undefined) { cache = new AssistantSourceCache(); caches.set(host, cache) }
  return cache
}
