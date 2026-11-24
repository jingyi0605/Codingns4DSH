import type { CodingNsBackgroundTurn } from './background-turn.js'
import type { CodingNsCliAdapterRegistry } from './registry.js'
import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { externalTurnSyncState, supportsBackgroundTurns } from './background-turn.js'

/** 同一条后台回合结果最多重放几次；失败结束不会记成已投递，必须自己设上限。 */
const MAX_EXTERNAL_TURN_ATTEMPTS = 3

/** Wakes native DSH turns while the driver retains sole ownership of Provider output. */
export function installBackgroundTurnDelivery(registry: CodingNsCliAdapterRegistry, native?: CodingNsNativeSessionBridge): () => void {
  const pending = new Map<string, CodingNsBackgroundTurn>()
  const queued = new Set<string>()
  const recoveredAt = new Map<string, number>()
  const recovering = new Set<string>()
  let stopped = false, running = false
  const key = (t: CodingNsBackgroundTurn) => JSON.stringify([t.sessionId, t.providerSessionId, t.turnId])
  const drain = async () => {
    if (stopped || running || !native?.enqueueExternalTurn) return
    running = true
    try {
      for (const [id, turn] of pending) {
        if (stopped) break
        const binding = registry.getSession(turn.sessionId)
        if (!supportsBackgroundTurns(binding.adapterId) || binding.providerSessionId !== turn.providerSessionId) { pending.delete(id); continue }
        try {
          if (await native.ensure(turn.sessionId) !== turn.sessionId || stopped) continue
          if (!native.enqueueExternalTurn(turn)) continue
          queued.add(id); pending.delete(id)
          if (queued.size > 4096) queued.delete(queued.values().next().value!)
        } catch { /* Keep output pending until DSH can acquire its original session. */ }
      }
    } finally { running = false }
  }
  const unsubscribe = registry.subscribeBackgroundTurns(turn => {
    const id = key(turn)
    if (queued.has(id)) return
    pending.set(id, turn)
    void drain()
  })
  const recover = async (value: unknown) => {
    const session = value as { id?: string; header?: { id?: string }; snapshotEvents?: () => readonly unknown[] }
    const id = session?.header?.id ?? session?.id
    if (!id || typeof session.snapshotEvents !== 'function' || recovering.has(id) || Date.now() - (recoveredAt.get(id) ?? 0) < 15000) return
    recovering.add(id); recoveredAt.set(id, Date.now())
    try {
      const replies = await registry.recoverBackgroundTurns(id)
      if (stopped) return
      const sync = externalTurnSyncState(session.snapshotEvents())
      for (const reply of replies) {
        const identity = JSON.stringify([reply.providerSessionId, reply.turnId])
        if (sync.delivered.has(identity) || sync.pending.has(identity) || sync.suppressed.has(identity) || sync.texts.some(t => t.includes(reply.text))) continue
        // 失败结束的投递既不算 delivered 也不算 suppressed，恢复逻辑会把同一条结果
        // 反复注入（实测同一会话连续出现两条「工作流执行结果」通知）。这里给重试设上限：
        // 清掉上限内的重试机会仍然保留，超过就停，避免每次启动都重放旧通知。
        if ((sync.attempts.get(identity) ?? 0) >= MAX_EXTERNAL_TURN_ATTEMPTS) continue
        // A failed/interrupted delivery may be retried from the native durable
        // response. Never execute the workflow or its model again.
        const k = key(reply)
        registry.stageRecoveredBackgroundTurn(reply)
        queued.delete(k); pending.set(k, reply)
      }
      await drain()
    } catch { /* Read-only recovery is retried; never fall back to a model prompt. */ }
    finally { recovering.delete(id) }
  }
  const inspect = () => { for (const session of native?.list?.() ?? []) void recover(session) }
  const unsubscribeNative = native?.subscribe?.({ onEvent: session => { void recover(session) } })
  const timer = setInterval(() => { void drain(); inspect() }, 2000)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer); unsubscribe(); unsubscribeNative?.(); pending.clear(); queued.clear(); recoveredAt.clear() }
}
