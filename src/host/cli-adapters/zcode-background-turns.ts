import { randomUUID } from 'node:crypto'
import type { JsonRpcMessage } from './json-rpc-process.js'
import { isRecord } from './rpc-driver-utils.js'

export interface ZcodeBackgroundTurn {
  readonly id: string
  readonly nativeTurnId: string | undefined
  readonly queue: AsyncIterable<JsonRpcMessage>
  claimed: boolean
  cancelled: boolean
}

function queue() {
  const pending: JsonRpcMessage[] = []
  let wake: (() => void) | undefined, closed = false, bytes = 0
  return {
    push(m: JsonRpcMessage) {
      if (closed) return
      bytes += JSON.stringify(m).length
      if (bytes > 8 * 1024 * 1024) {
        pending.push({ method: 'codingns/background-error', params: { message: 'ZCode 后台回复缓存已满，请从原生历史恢复结果。' } })
        closed = true
      } else pending.push(m)
      wake?.(); wake = undefined
    },
    close() { closed = true; wake?.(); wake = undefined },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length) { const m = pending.shift()!; bytes -= JSON.stringify(m).length; yield m; continue }
        if (closed) return
        await new Promise<void>(resolve => { wake = resolve })
      }
    },
  }
}

/** One dispatcher per native session. Foreground and unsolicited turns never share a queue. */
export class ZcodeBackgroundTurns {
  private foreground = false
  private foregroundId: string | undefined
  private active: (ZcodeBackgroundTurn & { queue: ReturnType<typeof queue> }) | undefined
  private readonly turns = new Map<string, ZcodeBackgroundTurn & { queue: ReturnType<typeof queue> }>()
  private readonly seen = new Set<string>()
  private readonly ended = new Set<string>()
  constructor(private readonly ready: (id: string) => void) {}
  beginForeground(): void { this.foreground = true; this.foregroundId = undefined }
  endForeground(): void { this.foreground = false }
  get hasActive(): boolean { return this.active !== undefined }
  get pendingIds(): string[] { return [...this.turns.values()].filter(t => !t.claimed).map(t => t.id) }
  claim(id: string): ZcodeBackgroundTurn | undefined {
    const t = this.turns.get(id)
    if (!t || t.claimed) return undefined
    t.claimed = true
    return t
  }
  release(id: string): void { this.turns.delete(id) }
  cancel(): void {
    for (const t of this.turns.values()) {
      t.cancelled = true; t.queue.close()
      if (t.nativeTurnId) this.rememberEnd(t.nativeTurnId)
    }
    this.turns.clear()
    this.active = undefined; this.foreground = false
  }
  /** Returns true when the foreground listener must not consume this notification. */
  observe(m: JsonRpcMessage, sessionId: string): boolean {
    const p = isRecord(m.params) ? m.params : {}
    if (typeof p.sessionId === 'string' && p.sessionId !== sessionId) return true
    const event = m.method === 'session/event', state = m.method === 'state.updated'
    const patch = isRecord(p.patch) ? p.patch : {}
    const id = typeof p.turnId === 'string' ? p.turnId : undefined
    const key = event && (typeof p.eventId === 'string' ? p.eventId : typeof p.seq === 'number' ? `seq:${p.seq}` : undefined)
    if (key) {
      if (this.seen.has(key)) return true
      this.seen.add(key)
      if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!)
    }
    const start = event && p.type === 'turn.started' || state && (p.reason === 'prompt_started' || patch.status === 'running')
    const terminal = event && (p.type === 'turn.completed' || p.type === 'turn.failed') || state && patch.status === 'idle'
    if (id && this.ended.has(id)) return true
    if (start) {
      if (this.foreground && !this.active) { this.foregroundId ??= id; return false }
      if (!this.active) {
        if (this.turns.size >= 64) throw new Error('Too many pending ZCode background turns')
        const t = { id: id ?? `zcode-bg-${randomUUID()}`, nativeTurnId: id, queue: queue(), claimed: false, cancelled: false }
        this.active = t; this.turns.set(t.id, t)
        // The first frame is durable in the queue before waking DSH.
        t.queue.push(m); this.ready(t.id)
        return true
      }
    }
    if (this.active) {
      if (id && this.active.nativeTurnId && id !== this.active.nativeTurnId) return true
      this.active.queue.push(m)
      if (terminal) { if (id) this.rememberEnd(id); this.active.queue.close(); this.active = undefined }
      return true
    }
    if (terminal && this.foreground) {
      if (id && this.foregroundId && id !== this.foregroundId) return true
      this.foreground = false
      if (id) this.rememberEnd(id)
    }
    return false
  }
  private rememberEnd(id: string): void {
    this.ended.add(id)
    if (this.ended.size > 512) this.ended.delete(this.ended.values().next().value!)
  }
}
