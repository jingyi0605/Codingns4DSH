import { randomUUID } from 'node:crypto'
import {
  createWorkspaceMcpWebhookTestPayload,
  serializeWorkspaceMcpWebhookPayload,
  signWorkspaceMcpWebhookRequest,
  type WorkspaceMcpWebhookPayload,
} from './webhook-payload.js'
import {
  FileWorkspaceMcpWebhookStore,
  type WorkspaceMcpWebhookDelivery,
} from './webhook-store.js'

const RETRY_DELAYS_MS = [2_000, 10_000, 60_000, 5 * 60_000, 30 * 60_000] as const
const MAX_RETRIES = 5
const MAX_RETRY_AFTER_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_CONCURRENCY = 4

export interface WorkspaceMcpWebhookDispatcherOptions {
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  readonly random?: () => number
  readonly timeoutMs?: number
  readonly concurrency?: number
}

export class WorkspaceMcpWebhookDispatcher {
  private readonly store: FileWorkspaceMcpWebhookStore
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly setTimer: NonNullable<WorkspaceMcpWebhookDispatcherOptions['setTimer']>
  private readonly clearTimer: NonNullable<WorkspaceMcpWebhookDispatcherOptions['clearTimer']>
  private readonly random: () => number
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly activeControllers = new Set<AbortController>()
  private readonly activeDestinationIds = new Set<string>()
  private readonly deliveryTasks = new Set<Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private wakePending = false
  private stopped = false

  constructor(store: FileWorkspaceMcpWebhookStore, options: WorkspaceMcpWebhookDispatcherOptions = {}) {
    this.store = store
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.random = options.random ?? Math.random
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY))
  }

  wake(): void {
    if (this.stopped) return
    if (this.running) {
      this.wakePending = true
      return
    }
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    void this.pump()
  }

  async test(input: {
    readonly destinationId: string
    readonly url: string
    readonly secret: string
  }): Promise<{ readonly ok: boolean; readonly httpStatus?: number; readonly errorKind?: string }> {
    const eventId = randomUUID()
    const deliveryId = randomUUID()
    const timestamp = String(Math.floor(this.now() / 1000))
    const body = serializeWorkspaceMcpWebhookPayload(createWorkspaceMcpWebhookTestPayload({
      eventId, destinationId: input.destinationId, occurredAt: new Date(this.now()).toISOString(),
    }))
    return this.request({
      url: input.url,
      secret: input.secret,
      eventId,
      deliveryId,
      eventType: 'webhook.test',
      body,
    })
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
    for (const controller of this.activeControllers) controller.abort()
    await Promise.allSettled([...this.deliveryTasks])
  }

  async settleReady(): Promise<void> {
    await this.pump()
    while (this.running || this.deliveryTasks.size > 0) {
      await Promise.allSettled([...this.deliveryTasks])
      if (this.running) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      const snapshot = await this.store.snapshot()
      const now = this.now()
      const destinations = new Map(snapshot.destinations.map((destination) => [destination.id, destination]))
      const queue = [...snapshot.deliveries].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      let activeCount = this.activeDestinationIds.size
      const visitedDestinations = new Set(this.activeDestinationIds)
      for (const delivery of queue) {
        if (delivery.status === 'delivered' || delivery.status === 'failed') continue
        if (visitedDestinations.has(delivery.destinationId)) continue
        visitedDestinations.add(delivery.destinationId)
        if (this.stopped || activeCount >= this.concurrency || delivery.nextAttemptAt > now) continue
        const destination = destinations.get(delivery.destinationId)
        if (destination === undefined) continue
        this.activeDestinationIds.add(delivery.destinationId)
        activeCount += 1
        const task = this.deliver(delivery)
        this.deliveryTasks.add(task)
        void task.finally(() => this.deliveryTasks.delete(task))
      }
      this.scheduleNext(queue, now)
    } finally {
      this.running = false
      if (this.wakePending && !this.stopped) {
        this.wakePending = false
        queueMicrotask(() => this.wake())
      }
    }
  }

  private async deliver(delivery: WorkspaceMcpWebhookDelivery): Promise<void> {
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const attempts = delivery.attempts + 1
    try {
      await this.store.updateDelivery(delivery.deliveryId, { status: 'sending', attempts, lastError: null })
      const result = await this.request({
        url: delivery.destinationSnapshot.url,
        secret: delivery.destinationSnapshot.secret,
        eventId: delivery.eventId,
        deliveryId: delivery.deliveryId,
        eventType: delivery.eventType,
        body: delivery.body,
        signal: controller.signal,
      })
      if (this.stopped) return
      if (result.ok) {
        await this.store.updateDelivery(delivery.deliveryId, {
          status: 'delivered', ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
          lastError: null, finishedAt: new Date(this.now()).toISOString(),
        })
      } else if (result.errorKind !== undefined && shouldRetry(result.errorKind) && attempts <= MAX_RETRIES) {
        const delay = result.retryAfterMs ?? retryDelay(attempts, this.random)
        await this.store.updateDelivery(delivery.deliveryId, {
          status: 'pending', ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }), lastError: result.errorKind,
          nextAttemptAt: this.now() + delay,
        })
      } else {
        await this.store.updateDelivery(delivery.deliveryId, {
          status: 'failed', ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }), lastError: result.errorKind ?? 'unknown',
          finishedAt: new Date(this.now()).toISOString(),
        })
      }
    } catch (error) {
      if (!this.stopped) {
        const errorKind = controller.signal.aborted ? 'aborted' : 'store_error'
        const terminal = errorKind === 'aborted' || attempts > MAX_RETRIES
        await this.store.updateDelivery(delivery.deliveryId, terminal
          ? { status: 'failed', attempts, lastError: errorKind, finishedAt: new Date(this.now()).toISOString() }
          : { status: 'pending', attempts, lastError: errorKind, nextAttemptAt: this.now() + retryDelay(attempts, this.random) })
          .catch(() => undefined)
      }
      void error
    } finally {
      this.activeControllers.delete(controller)
      this.activeDestinationIds.delete(delivery.destinationId)
      if (!this.stopped) this.wake()
    }
  }

  private async request(input: {
    readonly url: string
    readonly secret: string
    readonly eventId: string
    readonly deliveryId: string
    readonly eventType: WorkspaceMcpWebhookPayload['type']
    readonly body: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly ok: boolean; readonly httpStatus?: number; readonly errorKind?: string; readonly retryAfterMs?: number }> {
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (input.signal?.aborted) forwardAbort()
    const timeout = this.setTimer(() => controller.abort(new Error('timeout')), this.timeoutMs)
    const timestamp = String(Math.floor(this.now() / 1000))
    const signed = signWorkspaceMcpWebhookRequest({ ...input, timestamp })
    try {
      const response = await this.fetcher(input.url, {
        method: 'POST',
        headers: signed.headers,
        body: input.body,
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.status >= 200 && response.status < 300) return { ok: true, httpStatus: response.status }
      if (response.status >= 300 && response.status < 400) return { ok: false, httpStatus: response.status, errorKind: 'redirect' }
      const errorKind = `http_${response.status}`
      const retryAfterMs = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after'), this.now()) : undefined
      return {
        ok: false,
        httpStatus: response.status,
        errorKind,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }
    } catch {
      return { ok: false, errorKind: controller.signal.aborted ? 'timeout' : 'network_error' }
    } finally {
      this.clearTimer(timeout)
      input.signal?.removeEventListener('abort', forwardAbort)
    }
  }

  private scheduleNext(queue: readonly WorkspaceMcpWebhookDelivery[], now: number): void {
    if (this.stopped || this.timer !== undefined) return
    if (this.activeDestinationIds.size >= this.concurrency) return
    const visitedDestinations = new Set(this.activeDestinationIds)
    const nextTimes: number[] = []
    for (const delivery of queue) {
      if (delivery.status === 'delivered' || delivery.status === 'failed') continue
      if (visitedDestinations.has(delivery.destinationId)) continue
      visitedDestinations.add(delivery.destinationId)
      if (delivery.status === 'pending') nextTimes.push(delivery.nextAttemptAt)
    }
    if (nextTimes.length === 0) return
    const delay = Math.max(0, Math.min(...nextTimes) - now)
    this.timer = this.setTimer(() => {
      this.timer = undefined
      this.wake()
    }, delay)
  }
}

function shouldRetry(errorKind: string): boolean {
  if (errorKind === 'network_error' || errorKind === 'timeout') return true
  const status = /^http_(\d{3})$/u.exec(errorKind)?.[1]
  if (status === undefined) return false
  const code = Number(status)
  return code >= 500 || code === 408 || code === 429
}

function retryDelay(attempt: number, random: () => number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!
  return Math.round(base * (1 + Math.max(0, Math.min(1, random())) * 0.2))
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : Date.parse(value) - now
  if (!Number.isFinite(delay) || delay < 0) return undefined
  return Math.min(delay, MAX_RETRY_AFTER_MS)
}
