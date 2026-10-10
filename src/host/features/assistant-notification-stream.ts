import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AssistantNotificationStreamFrame } from '../../shared/assistant-notifications.js'
import { readAssistantNotificationFeedRequest, type AssistantNotificationFeed, type AssistantNotificationFeedRequest } from '../../shared/assistant-notification-feed.js'
import { AssistantNotificationCenter } from './assistant-notifications.js'
import { AssistantNotificationSource } from './assistant-notification-source.js'

/**
 * 全局助理通知的 Host 长连接。
 *
 * 首帧是完整快照，之后每次 revision 变化只推送一帧最新快照。客户端不再按
 * 固定间隔读取；连接断开时由客户端执行一次 read 校准，然后等待下一代流。
 */
export class AssistantNotificationController extends TypertRemoteService {
  static inject = ['typert']

  constructor(ctx: Context, private readonly center: AssistantNotificationCenter, private readonly options: {
    readonly source?: AssistantNotificationSource
    readonly authorizeSource?: (workspaceIds: readonly string[]) => void
    readonly sourceScope?: (workspaceIds: readonly string[]) => void
  } = {}) {
    super(ctx, 'assistantNotificationController', { namespace: 'codingnsAssistantNotifications' })
  }

  @Remote({ mode: 'stream' })
  stream(signal: AbortSignal): AsyncIterable<AssistantNotificationStreamFrame> {
    const queue = new NotificationStreamQueue<AssistantNotificationStreamFrame>()
    const initial = this.center.read({ limit: 50 })
    queue.push({ type: 'snapshot', snapshot: initial })
    let lastRevision = initial.revision
    const unsubscribe = this.center.subscribeRevision((revision) => {
      if (revision === lastRevision) return
      lastRevision = revision
      queue.push({ type: 'delta', snapshot: this.center.read({ limit: 50 }) })
    })
    return (async function* () {
      try {
        yield* queue.iterate(signal)
      } finally {
        unsubscribe()
        queue.end()
      }
    })()
  }

  @Remote({ mode: 'stream' })
  sourceStream(value: unknown, signal: AbortSignal): AsyncIterable<AssistantNotificationFeed> {
    const source = this.options.source
    if (source === undefined) throw new Error('当前 Host 未提供通知来源流')
    const request: AssistantNotificationFeedRequest = readAssistantNotificationFeedRequest(value)
    this.options.authorizeSource?.(request.workspaceIds)
    this.options.sourceScope?.(request.workspaceIds)
    const queue = new NotificationStreamQueue<AssistantNotificationFeed>()
    // 每个连接从完整来源快照开始；这就是断线重连后的单次校准。
    const initial = source.read({ workspaceIds: request.workspaceIds })
    queue.push(initial)
    let epoch = initial.epoch
    let revision = initial.revision
    const unsubscribe = source.subscribeRevision(() => {
      try {
        const next = source.read({ workspaceIds: request.workspaceIds, epoch, revision })
        if (next.revision === revision) return
        epoch = next.epoch
        revision = next.revision
        queue.push(next)
      } catch {
        // 恢复源暂时不可读时主动结束连接，让客户端执行一次完整校准。
        queue.end()
      }
    })
    // 来源租约只有 10 秒；长连接没有网络读取，必须在 Host 内续租，否则空闲一段时间后
    // 新事实不会再进入事件日志，客户端只能等到下一次重连才看到它。
    const leaseTimer = setInterval(() => {
      try {
        this.options.sourceScope?.(request.workspaceIds)
        source.renew(request.workspaceIds)
      } catch {
        queue.end()
      }
    }, 5_000)
    leaseTimer.unref?.()
    return (async function* () {
      try {
        yield* queue.iterate(signal)
      } finally {
        clearInterval(leaseTimer)
        unsubscribe()
        queue.end()
      }
    })()
  }
}

/** 一个连接一个队列，避免某个慢 Client 阻塞通知中心或其他连接。 */
class NotificationStreamQueue<T> {
  private readonly values: T[] = []
  private waiter: (() => void) | undefined
  private ended = false

  push(value: T): void {
    if (this.ended) return
    this.values.push(value)
    this.waiter?.()
    this.waiter = undefined
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.waiter?.()
    this.waiter = undefined
  }

  async *iterate(signal: AbortSignal): AsyncIterable<T> {
    const abort = (): void => this.end()
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.ended || this.values.length > 0) {
        signal.throwIfAborted()
        while (this.values.length > 0) yield this.values.shift() as T
        if (this.ended) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.end()
    }
  }
}
