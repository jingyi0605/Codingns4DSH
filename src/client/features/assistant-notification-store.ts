import type { AssistantNotification, AssistantNotificationSnapshot, AssistantNotificationTarget } from '../../shared/assistant-notifications.js'
import { callCodingNsRpcResult } from '../rpc-call.js'
import type { CodingNsRpcClient } from './types.js'

export interface AssistantNotificationClientSnapshot {
  readonly frame?: AssistantNotificationSnapshot | undefined
  readonly error?: string | undefined
  readonly errorNoticeId?: string | undefined
  readonly errorGeneration?: number | undefined
  readonly loading: boolean
}

/** 一个读取循环供网页与原生桥共享；所有通知 RPC 串行，配置变化使旧结果立即失效。 */
export class AssistantNotificationStore {
  private snapshot: AssistantNotificationClientSnapshot = { loading: false }
  private readonly listeners = new Set<() => void>()
  private lifetime = new AbortController()
  private epoch = 0
  private key: string | undefined
  private enabled = false
  private disposed = false
  private cursor: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private refreshPromise: Promise<void> | undefined
  private queuedRefresh: Promise<void> | undefined
  private clockOffset = 0
  private readonly presented = new Set<string>()
  private readonly opens = new Map<string, Promise<void>>()
  private readonly knownNotices = new Map<string, AssistantNotification>()

  constructor(private readonly rpc: CodingNsRpcClient,
    private readonly navigate: (target: AssistantNotificationTarget, signal: AbortSignal) => Promise<void>,
    private readonly intervalMs = 750,
    private readonly now: () => number = Date.now) {
    // 页面重新可见时立即校正：完成提示在前台静默，不等待下一次轮询。
    try { if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', this.onVisibilityChange) } catch { /* 非浏览器环境不注册 */ }
  }

  /** 前台可见性只用于完成提示的静默消化，不参与配置 key 或读取循环。 */
  private readonly onVisibilityChange = (): void => { if (!this.disposed && this.enabled && this.pageVisible()) void this.refresh(true) }

  getSnapshot = (): AssistantNotificationClientSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  /** key 包含已创建状态、范围和类型配置；不依赖语音、前台选择或可见性。 */
  configure(enabled: boolean, key: string): void {
    if (this.disposed || (this.enabled === enabled && this.key === key)) return
    this.enabled = enabled; this.key = key; this.epoch++
    this.lifetime.abort(); this.lifetime = new AbortController()
    clearTimeout(this.timer); clearTimeout(this.deadlineTimer)
    this.cursor = undefined; this.presented.clear(); this.opens.clear(); this.knownNotices.clear()
    this.publish({ loading: enabled })
    if (enabled) void this.refresh(true)
  }

  /** 翻页与轮询共用读取链，游标失效时回到首页，禁止拼接不同修订的列表。 */
  async page(cursor?: string): Promise<void> {
    this.cursor = cursor
    await this.refresh(true)
  }

  refresh(force = false): Promise<void> {
    if (!this.enabled || this.disposed) return Promise.resolve()
    if (this.refreshPromise !== undefined) {
      if (!force) return this.refreshPromise
      // 多个保存/翻页操作只排一条后续读取；任务开始时使用最新游标与配置。
      this.queuedRefresh ??= this.refreshPromise.then(() => { this.queuedRefresh = undefined; return this.refresh(true) })
      return this.queuedRefresh
    }
    clearTimeout(this.timer)
    const epoch = this.epoch
    const operation = this.enqueue(async (signal) => {
      const previous = this.snapshot.frame
      let result = await this.call<AssistantNotificationSnapshot>('read', {
        ...(force || this.cursor !== undefined || previous === undefined ? {} : { revision: previous.revision }),
        ...(this.cursor === undefined ? {} : { cursor: this.cursor }), limit: 20,
      }, signal)
      this.assertCurrent(epoch, signal)
      // Host 重建可以复用修订号，但不能复用上一代的通知身份和分页内容。
      if (result.unchanged && previous?.generation !== result.generation) {
        result = await this.call<AssistantNotificationSnapshot>('read', { limit: 20 }, signal)
        this.assertCurrent(epoch, signal); this.cursor = undefined
      }
      this.clockOffset = result.serverNow - this.now()
      if (result.unchanged) {
        if (previous !== undefined) this.publishFrame(this.silenceVisibleCompletion({ ...result, items: previous.items }))
        this.scheduleDeadline()
        return
      }
      if (result.reset) this.cursor = undefined
      this.publishFrame(this.silenceVisibleCompletion(result))
      this.scheduleDeadline()
    }, epoch).catch((error: unknown) => {
      if (epoch === this.epoch && !this.disposed && this.enabled) this.publish({ ...this.snapshot, loading: false, error: message(error) })
    }).finally(() => {
      if (this.refreshPromise === operation) this.refreshPromise = undefined
      if (epoch === this.epoch && this.enabled && !this.disposed) this.timer = setTimeout(() => { void this.refresh() }, this.intervalMs)
    })
    this.refreshPromise = operation
    return operation
  }

  async acknowledge(noticeId: string, generation: number, action: 'presented' | 'dismiss', expectedKind?: AssistantNotification['kind'], expectedConnectionGeneration?: number): Promise<void> {
    const epoch = this.epoch
    this.requireFrame(generation)
    const notice = this.knownNotices.get(noticeId)
    // 同轮完成升级成错误时重新首展；旧原生帧的确认不能替新错误启动计时。
    if (action === 'presented' && expectedKind !== undefined && notice?.kind !== expectedKind) return
    const key = JSON.stringify([generation, noticeId, notice?.kind, notice?.createdAt])
    if (action === 'presented' && this.presented.has(key)) return
    await this.enqueue(async (signal) => {
      if (action === 'presented' && expectedKind !== undefined && this.knownNotices.get(noticeId)?.kind !== expectedKind) return
      if (action === 'presented' && this.presented.has(key)) return
      await this.call('ack', { noticeId, generation, action,
        ...((expectedConnectionGeneration ?? notice?.connectionGeneration) === undefined ? {} : { connectionGeneration: expectedConnectionGeneration ?? notice?.connectionGeneration }),
        ...(action === 'presented' && (expectedKind ?? notice?.kind) !== undefined ? { kind: expectedKind ?? notice?.kind } : {}) }, signal)
      this.assertCurrent(epoch, signal)
      if (action === 'presented') {
        this.presented.add(key)
        // 旧确认重试由 Host 首展记录保证幂等，客户端不需要无限保存历史 ID。
        while (this.presented.size > 256) this.presented.delete(this.presented.values().next().value!)
      }
      if (action === 'dismiss' && this.snapshot.errorNoticeId === noticeId) this.publish({ ...this.snapshot, error: undefined, errorNoticeId: undefined, errorGeneration: undefined })
    }, epoch).catch((error: unknown) => {
      if (epoch === this.epoch && this.enabled && !this.disposed) this.publish({ ...this.snapshot, error: message(error), errorNoticeId: noticeId, errorGeneration: generation })
      throw error
    })
    // 不复用写入前的在途快照。收起只修改提醒展示，从不提交原生问题或审批。
    await this.refresh(true)
  }

  /** 查看由 Host 返回可信目标，公开导航成功后才标记已读。 */
  open(noticeId: string, generation: number, expectedConnectionGeneration?: number): Promise<void> {
    try { this.requireFrame(generation) } catch (error) { return Promise.reject(error) }
    const notice = this.knownNotices.get(noticeId)
    // 原生独立分页可能展示网页尚未缓存的 ID；目标存在与权限由认证接口复核。
    const connectionGeneration = expectedConnectionGeneration ?? notice?.connectionGeneration
    const key = JSON.stringify([generation, noticeId, connectionGeneration])
    const previous = this.opens.get(key)
    if (previous !== undefined) return previous
    const epoch = this.epoch
    const operation = this.enqueue(async (signal) => {
      const target = await this.call<AssistantNotificationTarget>('target', { noticeId, generation,
        ...(connectionGeneration === undefined ? {} : { connectionGeneration }) }, signal)
      this.assertCurrent(epoch, signal)
      await this.navigate(target, signal)
      this.assertCurrent(epoch, signal)
      await this.call('ack', { noticeId, generation, action: 'read',
        ...(target.connectionGeneration === undefined ? {} : { connectionGeneration: target.connectionGeneration }) }, signal)
      if (this.snapshot.errorNoticeId === noticeId) this.publish({ ...this.snapshot, error: undefined, errorNoticeId: undefined, errorGeneration: undefined })
    }, epoch).then(() => this.refresh(true)).catch((error: unknown) => {
      if (epoch === this.epoch && this.enabled && !this.disposed) this.publish({ ...this.snapshot, error: message(error), errorNoticeId: noticeId, errorGeneration: generation })
      throw error
    }).finally(() => { if (this.opens.get(key) === operation) this.opens.delete(key) })
    this.opens.set(key, operation)
    return operation
  }

  dispose(): void {
    this.disposed = true; this.enabled = false; this.epoch++
    this.lifetime.abort(); clearTimeout(this.timer); clearTimeout(this.deadlineTimer)
    try { if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', this.onVisibilityChange) } catch { /* 非浏览器环境未注册 */ }
    this.presented.clear(); this.opens.clear(); this.knownNotices.clear(); this.listeners.clear(); this.snapshot = { loading: false }
  }

  /** 页面在前台时完成提示静默记为已读：不弹气泡，也不保留未读；失败、审批与提问照常呈现。 */
  private silenceVisibleCompletion(frame: AssistantNotificationSnapshot): AssistantNotificationSnapshot {
    const primary = frame.primary
    if (primary === null || primary.kind !== 'completed' || !this.pageVisible()) return frame
    if (!primary.read) void this.ackRead(primary.noticeId, frame.generation).catch(() => undefined)
    return { ...frame, primary: null }
  }
  private pageVisible(): boolean { try { return typeof document !== 'undefined' && document.visibilityState === 'visible' } catch { return false } }
  private ackRead(noticeId: string, generation: number): Promise<void> {
    const epoch = this.epoch
    return this.enqueue(async (signal) => {
      await this.call('ack', { noticeId, generation, action: 'read' }, signal)
      this.assertCurrent(epoch, signal)
    }, epoch)
  }

  private requireFrame(generation: number): void {
    if (!this.enabled || this.disposed || this.snapshot.frame?.generation !== generation) throw new Error('提醒已失效，请刷新后重试')
  }
  private assertCurrent(epoch: number, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (epoch !== this.epoch || !this.enabled || this.disposed) throw new Error('提醒配置已变化')
  }
  private enqueue<T>(task: (signal: AbortSignal) => Promise<T>, epoch: number): Promise<T> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(8_000)])
    const operation = this.chain.then(() => { this.assertCurrent(epoch, signal); return task(signal) })
    this.chain = operation.catch(() => undefined)
    return operation
  }
  private async call<T>(action: 'read' | 'ack' | 'target', payload: unknown, signal: AbortSignal): Promise<T> {
    const result = await callCodingNsRpcResult(this.rpc, `assistant/notifications/${action}`, payload, signal)
    signal.throwIfAborted()
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  private scheduleDeadline(): void {
    clearTimeout(this.deadlineTimer)
    const frame = this.snapshot.frame
    const primary = frame?.primary
    if (frame === undefined || primary === null || primary?.deadline === undefined) return
    const remaining = primary.deadline - (this.now() + this.clockOffset)
    if (remaining <= 0) { this.publish({ ...this.snapshot, frame: { ...frame, primary: null } }); return }
    // 截止时间只使用 Host 的首展确认；刷新、重连和快照重复都不创建新时长。
    this.deadlineTimer = setTimeout(() => {
      if (this.snapshot.frame?.generation !== frame.generation || this.snapshot.frame.primary?.noticeId !== primary.noticeId) return
      this.publish({ ...this.snapshot, frame: { ...this.snapshot.frame, primary: null } })
      void this.refresh(true)
    }, remaining)
  }
  private publishFrame(frame: AssistantNotificationSnapshot): void {
    if (this.snapshot.frame?.generation !== frame.generation) this.knownNotices.clear()
    // 在分页/抢占前已显示的原生点击仍可定位；只缓存安全通知，目标始终再次向 Host 查询。
    for (const notice of [...frame.items, ...(frame.primary === null ? [] : [frame.primary])]) {
      this.knownNotices.delete(notice.noticeId); this.knownNotices.set(notice.noticeId, notice)
    }
    while (this.knownNotices.size > 64) this.knownNotices.delete(this.knownNotices.keys().next().value!)
    const id = this.snapshot.errorNoticeId
    const keepError = id !== undefined && this.snapshot.errorGeneration === frame.generation
      && (frame.primary?.noticeId === id || frame.items.some((notice) => notice.noticeId === id))
    this.publish({ frame, loading: false, ...(keepError ? { error: this.snapshot.error, errorNoticeId: id, errorGeneration: frame.generation } : {}) })
  }
  private publish(value: AssistantNotificationClientSnapshot): void { this.snapshot = value; for (const listener of this.listeners) listener() }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
