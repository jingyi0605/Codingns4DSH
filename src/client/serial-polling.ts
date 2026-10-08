/**
 * 完成后再计时，失败逐步退避；隐藏页面暂停，销毁时取消在途请求。
 * 手动刷新复用在途 Promise，避免慢 Host 上请求越积越多。
 */
export function startSerialPolling(
  task: (signal: AbortSignal) => Promise<boolean | void>,
  intervalMs: number,
  options: { readonly document?: Document; readonly timeoutMs?: number; readonly maxDelayMs?: number } = {},
): { refresh(): Promise<void>; dispose(): void } {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const lifetime = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  let failures = 0
  const refresh = (): Promise<void> => {
    if (lifetime.signal.aborted) return Promise.resolve()
    if (pending !== undefined) return pending
    clearTimeout(timer)
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)])
    pending = Promise.resolve().then(() => task(signal))
      .then((success) => { failures = success === false ? failures + 1 : 0 }, () => { failures += 1 })
      .finally(() => {
        pending = undefined
        if (lifetime.signal.aborted || intervalMs <= 0 || dom?.visibilityState === 'hidden') return
        const delay = Math.min(intervalMs * 2 ** Math.min(failures, 4), options.maxDelayMs ?? Math.max(intervalMs, 60_000))
        timer = setTimeout(() => { void refresh() }, delay)
      })
    return pending
  }
  const visible = (): void => {
    clearTimeout(timer)
    if (dom?.visibilityState !== 'hidden') void refresh()
  }
  dom?.addEventListener('visibilitychange', visible)
  visible()
  return {
    refresh,
    dispose() { lifetime.abort(); clearTimeout(timer); dom?.removeEventListener('visibilitychange', visible) },
  }
}
