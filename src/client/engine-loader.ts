/** 合并并发加载；失败后清除 Promise，让用户下次操作能重新下载分块。 */
export function createEngineLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => pending ??= Promise.resolve().then(load).catch((error: unknown) => {
    pending = undefined
    throw error
  })
}

/** 加载与视图寿命分离：卸载、隐藏或模型销毁后，迟到模块不能再挂载。 */
export function attachLoadedEngine<T>(
  load: () => Promise<T>,
  signal: AbortSignal,
  attach: (engine: T) => () => void,
  failed: (error: unknown) => void,
): () => void {
  let cancelled = false
  let detach: (() => void) | undefined
  const dispose = (): void => {
    cancelled = true
    signal.removeEventListener('abort', dispose)
    detach?.()
    detach = undefined
  }
  if (signal.aborted) return dispose
  signal.addEventListener('abort', dispose, { once: true })
  void load().then((engine) => {
    if (cancelled || signal.aborted) return
    const release = attach(engine)
    // attach 内部也可能同步触发模型销毁，仍要成对执行刚得到的清理函数。
    if (cancelled) release()
    else detach = release
  }).catch((error: unknown) => { if (!cancelled) failed(error) })
  return dispose
}
