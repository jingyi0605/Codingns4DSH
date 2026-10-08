/** 后台元数据只有一个所有者；轮询和多个界面共享同一份已完成快照。 */
export interface AssistantMetadataSnapshot<T> {
  readonly revision: number
  readonly capturedAt: number
  readonly value: T
}

export interface AssistantRefreshCadence {
  readonly remote: boolean
  readonly active: boolean
  readonly failed?: boolean
}

/** 纯调度层不持有档案或对话；停用只撤销在途读取和后续定时任务。 */
export class AssistantBackground<T> {
  private epoch = 0
  private revision = 0
  private enabled = false
  private disposed = false
  private failures = 0
  private followUpDelay: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDue = Infinity
  private controller = new AbortController()
  private pending: { epoch: number; promise: Promise<AssistantMetadataSnapshot<T>> } | undefined
  private current: AssistantMetadataSnapshot<T> | undefined

  constructor(private readonly options: {
    read: (signal: AbortSignal) => Promise<T>
    publish: (value: T) => void
    cadence: (value: T) => AssistantRefreshCadence
  }) {}

  snapshot(): AssistantMetadataSnapshot<T> | undefined { return this.current }
  version(): number { return this.revision }

  /** 范围变化立即作废旧快照；不支持中断的旧服务结束前也不会并行启动新扫描。 */
  invalidate(): void {
    this.epoch++
    this.controller.abort(new Error('助理元数据范围已变化'))
    this.controller = new AbortController()
    this.current = undefined
    this.failures = 0
    this.followUpDelay = undefined
    this.clearTimer()
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.epoch++
      this.controller.abort(new Error('助理后台刷新已停止'))
      this.controller = new AbortController()
      this.clearTimer()
      this.followUpDelay = undefined
      return
    }
    this.schedule(0)
  }

  /** 本地事件合并刷新；索引自身仍保留完成后五秒的防抖。 */
  request(delay = 0): void {
    if (!this.enabled) return
    if (this.pending?.epoch === this.epoch) { this.followUpDelay = Math.min(this.followUpDelay ?? delay, delay); return }
    // 元数据事件只能提前刷新，不能让连续事件无限推迟已有兜底任务。
    // 真正的“完成后五秒”索引防抖由 AssistantIndexUpdates 单独负责。
    if (this.timer !== undefined && this.timerDue <= Date.now() + delay) return
    this.schedule(delay)
  }

  read(refresh = false): Promise<AssistantMetadataSnapshot<T>> {
    if (this.disposed) return Promise.reject(new Error('助理后台已销毁'))
    if (!refresh && this.current !== undefined) return Promise.resolve(this.current)
    if (this.pending !== undefined) {
      if (this.pending.epoch === this.epoch) return this.pending.promise
      return this.pending.promise.catch(() => undefined).then(() => this.read(refresh))
    }
    const epoch = this.epoch
    const signal = this.controller.signal
    const promise = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return this.options.read(signal)
    }).then((value) => {
      signal.throwIfAborted()
      if (epoch !== this.epoch || this.disposed) throw new Error('助理元数据已过期')
      this.current = { revision: ++this.revision, capturedAt: Date.now(), value }
      this.options.publish(value)
      this.scheduleNext(this.options.cadence(value))
      return this.current
    }).catch((error) => {
      if (epoch === this.epoch && !signal.aborted) this.scheduleNext({ remote: true, active: false, failed: true })
      throw error
    }).finally(() => { if (this.pending?.promise === promise) this.pending = undefined })
    this.pending = { epoch, promise }
    return promise
  }

  dispose(): void {
    this.disposed = true
    this.enabled = false
    this.invalidate()
    this.controller.abort(new Error('助理后台已销毁'))
  }

  private scheduleNext(cadence: AssistantRefreshCadence): void {
    this.failures = cadence.failed ? this.failures + 1 : 0
    const delay = this.failures > 0 ? Math.min(120_000, 5_000 * 2 ** Math.min(this.failures, 5))
      : cadence.remote ? cadence.active ? 5_000 : 30_000 : 60_000
    const nextDelay = Math.min(this.followUpDelay ?? delay, delay)
    this.followUpDelay = undefined
    if (this.enabled) this.schedule(nextDelay)
  }

  private schedule(delay: number): void {
    this.clearTimer()
    if (!this.enabled || this.disposed) return
    this.timerDue = Date.now() + delay
    this.timer = setTimeout(() => { this.timer = undefined; this.timerDue = Infinity; void this.read(true).catch(() => undefined) }, delay)
    this.timer.unref?.()
  }

  private clearTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; this.timerDue = Infinity }
}
