/**
 * 新会话 Agent 绑定的补读器。
 *
 * 外部 Agent 会话是先在 DSH 里建出来，Host 才随后写入「会话 → Agent」绑定
 * （工作区 MCP、`/委派`、团队子会话都是这个顺序）。会话列表在会话出现的那一刻读一次
 * 绑定表，往往还读不到，于是这一行会按默认值显示 DSH 图标，直到下一次切换会话、
 * 窗口重新获得焦点才被纠正。
 *
 * 这里对「还没被 Host 确认过」的会话做有限次、间隔递增的补读：
 * Host 一旦返回了该会话的绑定就停止；超过次数仍没有绑定的，说明它就是原生 DSH 会话，不再打扰。
 */

export const SESSION_ADAPTER_RECHECK_DELAYS_MS: readonly number[] = [500, 1_500, 4_000, 10_000, 30_000]

/** 已经补读过的会话 ID 上限；超过后整体清空，避免长时间运行时无限增长。 */
const MAX_REMEMBERED_SESSIONS = 2_000

export interface SessionAdapterRecheckOptions {
  /** 读取并应用一次 Host 绑定表，返回 Host 已经确认过的会话 ID；失败时返回 undefined。 */
  readonly refresh: () => Promise<ReadonlySet<string> | undefined>
  readonly delaysMs?: readonly number[]
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export interface SessionAdapterRecheck {
  /** 登记一个当前显示为默认 DSH、尚未被 Host 确认的会话。重复登记会被忽略。 */
  note(sessionId: string): void
  dispose(): void
}

export function createSessionAdapterRecheck(options: SessionAdapterRecheckOptions): SessionAdapterRecheck {
  const delays = options.delaysMs ?? SESSION_ADAPTER_RECHECK_DELAYS_MS
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  /** 仍在补读的会话 → 已补读次数。 */
  const pending = new Map<string, number>()
  const remembered = new Set<string>()
  let timer: unknown
  let running = false
  let disposed = false

  const schedule = (): void => {
    if (disposed || running || timer !== undefined || pending.size === 0) return
    const attempts = Math.min(...pending.values())
    const delay = delays[Math.min(attempts, delays.length - 1)] ?? 0
    timer = setTimer(() => {
      timer = undefined
      void run()
    }, delay)
  }

  const run = async (): Promise<void> => {
    if (disposed || pending.size === 0) return
    running = true
    let confirmed: ReadonlySet<string> | undefined
    try { confirmed = await options.refresh() } catch { confirmed = undefined }
    running = false
    if (disposed) return
    for (const [sessionId, attempts] of [...pending]) {
      if (confirmed?.has(sessionId) === true || attempts + 1 >= delays.length) pending.delete(sessionId)
      else pending.set(sessionId, attempts + 1)
    }
    schedule()
  }

  return {
    note(sessionId) {
      if (disposed || sessionId === '' || remembered.has(sessionId)) return
      if (remembered.size >= MAX_REMEMBERED_SESSIONS) remembered.clear()
      remembered.add(sessionId)
      pending.set(sessionId, 0)
      schedule()
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
      pending.clear()
      remembered.clear()
    },
  }
}
