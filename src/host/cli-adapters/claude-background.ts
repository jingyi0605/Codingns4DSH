import { randomUUID } from 'node:crypto'
import type { CodingNsBackgroundTurn } from './background-turn.js'
import type { CodingNsChildProcess } from './process-utils.js'

/**
 * Claude Code 的后台任务（Bash run_in_background、Monitor 等）在第一个 `result`
 * 之后仍由同一个进程持有。只要 stdin 不关，任务结束或监控到事件时，CLI 会自己开一轮
 * 新的对话（`system:init` 到 `result`，`result.origin.kind === 'task-notification'`）。
 * 这里把这些没有前台请求的回合缓存下来，再交给 DSH 唤醒会话时领取。
 */

const MAX_QUEUE_BYTES = 8 * 1024 * 1024
const MAX_PENDING_TURNS = 64
const RETIRE_GRACE_MS = 3_000
const NOTIFICATION_WAIT_MS = 10_000
const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000
const MAX_SUMMARY_LENGTH = 200

/** `task_updated.patch.status` 里表示任务已经结束的取值。 */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'cancelled', 'canceled', 'stopped', 'error'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 按 Claude 的 system 事件维护仍在运行的后台任务集合。
 * `background_tasks_changed` 带完整列表，是权威来源；其余事件只补它到达前的空窗。
 * 遇到 `task_notification` 时返回通知摘要（可能为空串），其他事件返回 undefined。
 */
export function applyClaudeTaskEvent(tasks: Set<string>, value: Record<string, unknown>): string | undefined {
  if (value.type !== 'system') return undefined
  const taskId = typeof value.task_id === 'string' ? value.task_id : undefined
  switch (value.subtype) {
    case 'background_tasks_changed':
      tasks.clear()
      if (Array.isArray(value.tasks)) {
        for (const task of value.tasks) {
          const id = isRecord(task) ? task.task_id : undefined
          if (typeof id === 'string') tasks.add(id)
        }
      }
      return undefined
    case 'task_started':
      if (taskId !== undefined && value.is_backgrounded !== false) tasks.add(taskId)
      return undefined
    case 'task_updated': {
      const status = isRecord(value.patch) ? value.patch.status : undefined
      if (taskId !== undefined && typeof status === 'string' && TERMINAL_TASK_STATUSES.has(status)) tasks.delete(taskId)
      return undefined
    }
    case 'task_notification':
      if (taskId !== undefined) tasks.delete(taskId)
      return typeof value.summary === 'string' ? value.summary.trim().slice(0, MAX_SUMMARY_LENGTH) : ''
    default:
      return undefined
  }
}

/** 空闲期间只有这些行表示 Claude 自己开始了一轮；任务记账行不算。 */
function startsTurn(value: Record<string, unknown>): boolean {
  return value.type === 'stream_event' || value.type === 'assistant' || (value.type === 'system' && value.subtype === 'init')
}

/** 后台任务触发的回合在 `result` 上带 origin；前台用户回合没有这个标记。 */
function isTaskNotificationResult(value: Record<string, unknown>): boolean {
  return value.type === 'result' && isRecord(value.origin) && value.origin.kind === 'task-notification'
}

/** 一轮的原始 stdout 行。超过上限时用一条错误 result 收尾，避免内存无限增长。 */
export class ClaudeLineQueue implements AsyncIterable<string> {
  private readonly items: string[] = []
  private wake: (() => void) | undefined
  private closed = false
  private bytes = 0

  push(line: string): void {
    if (this.closed) return
    this.bytes += line.length
    if (this.bytes > MAX_QUEUE_BYTES) {
      this.fail('Claude Code 后台回合输出过大，请从原生历史查看完整结果。')
      return
    }
    this.items.push(line)
    this.notify()
  }

  /** 用一条合成的错误 result 结束这一轮，消费方按普通失败处理。 */
  fail(message: string): void {
    if (this.closed) return
    this.items.length = 0
    this.items.push(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: message }))
    this.closed = true
    this.notify()
  }

  close(): void {
    this.closed = true
    this.notify()
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        while (true) {
          const item = this.items.shift()
          if (item !== undefined) return { done: false, value: item }
          if (this.closed) return { done: true, value: undefined }
          await new Promise<void>((resolve) => { this.wake = resolve })
        }
      },
      return: async () => {
        this.closed = true
        this.items.length = 0
        return { done: true, value: undefined }
      },
    }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

export interface ClaudeBackgroundTurn {
  readonly id: string
  readonly queue: ClaudeLineQueue
  readonly summary: string | undefined
  /** 产生这一轮的进程；回传权限应答或中断时写它的 stdin。进程退出后写入会被忽略。 */
  readonly owner: ClaudeBackgroundSession
  claimed: boolean
}

export interface ClaudeBackgroundSessionOptions {
  readonly sessionId: string
  readonly providerSessionId: string
  readonly child: CodingNsChildProcess
  /** 进程 stdout 的行迭代器；所有权从前台回合移交给这里。 */
  readonly lines: AsyncIterator<string>
  readonly closeLines: () => void
  readonly tasks: Set<string>
  /**
   * 这个会话缓存的后台回合，由驱动持有并在进程之间共享：进程退出或被回收后，
   * 尚未被 DSH 领取的回合仍然可以领取。
   */
  readonly turns: Map<string, ClaudeBackgroundTurn>
  /** 启动参数指纹；后续回合只有在指纹一致时才能复用这个进程。 */
  readonly launchKey: string
  /** 新的后台回合已经写入队列，可以通知 DSH 唤醒会话。 */
  readonly ready: (turn: CodingNsBackgroundTurn) => void
  /** 终止并回收子进程。 */
  readonly terminate: (child: CodingNsChildProcess) => void
  /** 读取器结束（进程退出或主动回收）后通知持有者移除登记。 */
  readonly released: (session: ClaudeBackgroundSession) => void
}

/**
 * 一个仍有后台任务的 Claude 进程。唯一读取 stdout 的是 pump：
 * - 有前台回合时，行转给前台队列；
 * - 空闲时出现新一轮，缓存成后台回合并通知 DSH；
 * - 任务全部结束、没有进行中的回合且没有待到的通知时，回收进程。
 */
export class ClaudeBackgroundSession {
  readonly sessionId: string
  readonly providerSessionId: string
  readonly child: CodingNsChildProcess
  readonly launchKey: string
  readonly tasks: Set<string>
  readonly createdAt = Date.now()
  private active: ClaudeBackgroundTurn | undefined
  private foreground: ClaudeLineQueue | undefined
  private pendingSummary: string | undefined
  private notifiedAt: number | undefined
  private retireTimer: ReturnType<typeof setTimeout> | undefined
  private lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private releasedNotified = false

  constructor(private readonly options: ClaudeBackgroundSessionOptions) {
    this.sessionId = options.sessionId
    this.providerSessionId = options.providerSessionId
    this.child = options.child
    this.launchKey = options.launchKey
    this.tasks = options.tasks
  }

  get isStopped(): boolean { return this.stopped }
  /** 还有任务在跑、一轮正在进行，或刚收到通知、下一轮马上开始。 */
  get isBusy(): boolean {
    return this.tasks.size > 0 || this.active !== undefined || this.foreground !== undefined || this.notificationExpected()
  }
  start(): void {
    this.lifetimeTimer = setTimeout(() => this.retire(), MAX_LIFETIME_MS)
    this.lifetimeTimer.unref?.()
    void this.pump()
    this.scheduleRetireCheck()
  }

  /** 前台回合接管 stdout；返回的迭代器逐行给出这一回合的输出。 */
  attachForeground(): AsyncIterator<string> {
    this.foreground?.close()
    const queue = new ClaudeLineQueue()
    this.foreground = queue
    this.clearRetireTimer()
    return queue[Symbol.asyncIterator]()
  }

  endForeground(): void {
    this.foreground?.close()
    this.foreground = undefined
    this.scheduleRetireCheck()
  }

  write(data: string): void {
    try { this.child.stdin?.write(data) } catch { /* 进程已退出时由 pump 的结束路径收尾 */ }
  }

  /** 中断正在进行的后台回合；不关闭进程，其他后台任务继续。 */
  interrupt(): void {
    this.write(`${JSON.stringify({ type: 'control_request', request_id: `interrupt:${randomUUID()}`, request: { subtype: 'interrupt' } })}\n`)
  }

  retire(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearRetireTimer()
    if (this.lifetimeTimer !== undefined) clearTimeout(this.lifetimeTimer)
    this.foreground?.close()
    this.foreground = undefined
    this.options.closeLines()
    this.options.terminate(this.child)
    this.notifyReleased()
  }

  private async pump(): Promise<void> {
    try {
      while (!this.stopped) {
        const step = await this.options.lines.next()
        if (step.done) break
        this.handle(step.value)
      }
    } catch { /* 读取失败等同进程退出 */ }
    this.finishExit()
  }

  private handle(raw: string): void {
    if (raw.trim() === '') return
    let value: unknown
    try { value = JSON.parse(raw) } catch { return }
    if (!isRecord(value)) return
    const summary = applyClaudeTaskEvent(this.tasks, value)
    if (summary !== undefined) {
      this.pendingSummary = summary
      this.notifiedAt = Date.now()
    }
    // 任务集合或通知变化后重新判断是否还需要保留进程；通知之后的新一轮会取消回收。
    if (value.type === 'system' && (value.subtype === 'background_tasks_changed' || (typeof value.subtype === 'string' && value.subtype.startsWith('task_')))) {
      this.scheduleRetireCheck()
    }
    if (this.active !== undefined) {
      this.active.queue.push(raw)
      if (value.type === 'result') this.endActive()
      return
    }
    if (this.foreground !== undefined) {
      this.foreground.push(raw)
      // 前台回合等待期间若夹着一轮通知回合，它的 result 不是用户这一轮的终点。
      if (value.type === 'result' && !isTaskNotificationResult(value)) { this.foreground.close(); this.foreground = undefined; this.scheduleRetireCheck() }
      return
    }
    if (startsTurn(value) && this.options.turns.size < MAX_PENDING_TURNS) this.startBackgroundTurn(raw)
  }

  private startBackgroundTurn(firstLine: string): void {
    const turn: ClaudeBackgroundTurn = {
      id: `claude-bg-${randomUUID()}`, queue: new ClaudeLineQueue(), summary: this.pendingSummary, owner: this, claimed: false,
    }
    this.pendingSummary = undefined
    this.notifiedAt = undefined
    this.active = turn
    this.options.turns.set(turn.id, turn)
    // 第一行先写入队列，再唤醒 DSH，保证领取时不会漏掉开头。
    turn.queue.push(firstLine)
    const label = turn.summary === undefined || turn.summary === '' ? '后台任务通知' : `后台任务通知：${turn.summary}`
    try {
      this.options.ready({ sessionId: this.sessionId, providerSessionId: this.providerSessionId, turnId: turn.id, summary: label })
    } catch { /* 没有消费者时输出仍留在队列里 */ }
  }

  private endActive(): void {
    this.active?.queue.close()
    this.active = undefined
    this.scheduleRetireCheck()
  }

  private finishExit(): void {
    this.stopped = true
    this.clearRetireTimer()
    if (this.lifetimeTimer !== undefined) clearTimeout(this.lifetimeTimer)
    this.active?.queue.fail('Claude Code 进程已退出，后台回合没有完整结束。')
    this.active = undefined
    this.foreground?.close()
    this.foreground = undefined
    this.notifyReleased()
  }

  private notifyReleased(): void {
    if (this.releasedNotified) return
    this.releasedNotified = true
    this.options.released(this)
  }

  private notificationExpected(): boolean {
    return this.notifiedAt !== undefined && Date.now() - this.notifiedAt < NOTIFICATION_WAIT_MS
  }

  private scheduleRetireCheck(): void {
    if (this.stopped || this.retireTimer !== undefined) return
    this.retireTimer = setTimeout(() => {
      this.retireTimer = undefined
      if (this.stopped) return
      if (this.isBusy) { if (this.tasks.size === 0 && this.active === undefined && this.foreground === undefined) this.scheduleRetireCheck(); return }
      this.retire()
    }, RETIRE_GRACE_MS)
    this.retireTimer.unref?.()
  }

  private clearRetireTimer(): void {
    if (this.retireTimer !== undefined) clearTimeout(this.retireTimer)
    this.retireTimer = undefined
  }
}
