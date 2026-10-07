import type { SessionIndexEntry, AssistantIndexSnapshot } from '../../shared/contracts/assistant.js'

interface SessionVersion {
  version: number
  indexed: number
  attempted: number
  seq: number
  metadata: string
  activity: 'running' | 'idle' | 'unknown'
  open: boolean
  idleSignal: boolean
}

export const assistantSessionKey = (entry: { hostId: string; sessionId: string }): string => JSON.stringify([entry.hostId, entry.sessionId])
const INDEX_UPDATE_DELAY_MS = 5_000

/** 版本只在有效材料变化时推进，流式片段和工具步骤结束都不会触发索引。 */
export class AssistantIndexUpdates {
  private readonly sessions = new Map<string, SessionVersion>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private running = false
  private again = false

  constructor(private readonly run: () => Promise<void>, private readonly liveActivity: (entry: SessionIndexEntry) => 'running' | 'idle' | 'unknown') {}

  observe(entries: readonly SessionIndexEntry[]): boolean {
    let changed = false
    const members = new Set(entries.map(assistantSessionKey))
    for (const key of this.sessions.keys()) if (!members.has(key)) { this.sessions.delete(key); changed = true }
    for (const entry of entries) {
      const key = assistantSessionKey(entry)
      const metadata = JSON.stringify([entry.title, entry.updatedAt])
      const activity = this.liveActivity(entry)
      const previous = this.sessions.get(key)
      if (previous === undefined) { this.sessions.set(key, { version: 1, indexed: 0, attempted: 0, seq: -1, metadata, activity, open: activity === 'running', idleSignal: false }); changed = true; continue }
      if (previous.metadata !== metadata) { previous.version++; previous.metadata = metadata; changed = true }
      // 实时 Agent 的状态是权威值；远端列表的 running=false 也可确认空闲。
      if (activity === 'running') { if (!previous.open) { previous.version++; changed = true }; previous.open = true; previous.idleSignal = false }
      if (activity === 'idle') previous.open = false
      const nextActivity = activity === 'unknown' && previous.idleSignal ? 'idle' : activity
      if (previous.activity !== nextActivity) changed = true
      previous.activity = nextActivity
    }
    return changed
  }

  event(key: string, event: unknown): void {
    const current = this.sessions.get(key)
    if (current === undefined || typeof event !== 'object' || event === null) return
    const value = event as { type?: string; seq?: number; data?: { source?: { kind?: string }; message?: { source?: { kind?: string } } } }
    if (!['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'session/title', 'todo/write', 'compaction/summary'].includes(value.type ?? '')) return
    const source = value.data?.message?.source ?? value.data?.source
    if (value.type === 'user/message' && source?.kind !== undefined && source.kind !== 'user') return
    if (typeof value.seq === 'number') { if (value.seq <= current.seq) return; current.seq = value.seq }
    if (value.type === 'turn/start' || value.type === 'user/message') { current.open = true; current.activity = 'running'; current.idleSignal = false }
    if (value.type === 'turn/end') { current.open = false; this.schedule(); return }
    current.version++
    if (!current.open && current.activity === 'idle') this.schedule()
  }

  changed(key: string): void {
    const current = this.sessions.get(key)
    if (current === undefined) return
    current.version++
    if (!current.open && current.activity === 'idle') this.schedule()
  }

  status(key: string, running: boolean): void {
    const current = this.sessions.get(key)
    if (current === undefined) return
    const ended = current.open || current.activity !== 'idle'
    if (running && !current.open) current.version++
    current.open = running; current.activity = running ? 'running' : 'idle'; current.idleSignal = !running
    if (!running) this.schedule(ended)
  }

  stamp<T extends SessionIndexEntry>(entry: T): T {
    const current = this.sessions.get(assistantSessionKey(entry))
    return current === undefined ? entry : { ...entry, activity: current.open ? 'running' : current.activity, sourceVersion: current.version, indexedVersion: current.indexed }
  }

  canIndex(entry: SessionIndexEntry): boolean {
    if (this.disposed) return false
    const current = this.sessions.get(assistantSessionKey(entry))
    if (current === undefined || current.open || current.version !== entry.sourceVersion || entry.waiting !== null) return false
    const live = this.liveActivity(entry)
    return live !== 'running' && (live === 'idle' || current.activity === 'idle')
  }

  complete(entry: { hostId: string; sessionId: string; sourceVersion?: number }): void {
    const current = this.sessions.get(assistantSessionKey(entry))
    if (current !== undefined && current.version === entry.sourceVersion) current.indexed = current.version
  }

  attempted(entry: SessionIndexEntry): void {
    const current = this.sessions.get(assistantSessionKey(entry))
    if (current !== undefined && entry.sourceVersion !== undefined) current.attempted = Math.max(current.attempted, entry.sourceVersion)
  }

  hasReady(entries: readonly SessionIndexEntry[]): boolean { return entries.some((entry) => { const current = this.sessions.get(assistantSessionKey(entry)); return current !== undefined && current.version > current.attempted && this.canIndex(this.stamp(entry)) }) }
  fresh(index: AssistantIndexSnapshot): boolean { return index.entries.every((entry) => { const current = this.sessions.get(assistantSessionKey(entry)); return current !== undefined && current.indexed === current.version && current.version === entry.sourceVersion && !current.open }) }
  matches(index: AssistantIndexSnapshot): boolean { return index.entries.length === this.sessions.size && index.entries.every((entry) => entry.sourceVersion === this.sessions.get(assistantSessionKey(entry))?.version) }

  reset(): void { for (const current of this.sessions.values()) { current.version++; current.attempted = 0 }; this.schedule() }
  /** 有效变化重新等待5秒；轮询、刷新和重复空闲通知只确保已有任务被安排。 */
  schedule(restart = true): void {
    if (this.disposed) return
    if (!restart && this.timer !== undefined) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.disposed) return
      if (this.running) { this.again = true; return }
      this.running = true
      void this.run().catch(() => {}).finally(() => { this.running = false; if (this.again) { this.again = false; this.schedule() } })
    }, INDEX_UPDATE_DELAY_MS)
  }
  pause(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; for (const current of this.sessions.values()) current.attempted = current.version }
  clear(): void { this.pause(); this.sessions.clear(); this.again = false }
  dispose(): void { this.disposed = true; this.pause() }
}
